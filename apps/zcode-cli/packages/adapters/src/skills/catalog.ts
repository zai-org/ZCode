// ============================================================
// Skill 实时目录：进程级共享条目、会话 view 与读快照的 SkillPort。
// 规则见根目录 docs/skills-live-catalog.md。
// ============================================================

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  Logger,
  PluginDiagnostic,
  SkillContent,
  SkillLoadOutcome,
  SkillMetadata,
  SkillPort,
  SkillRoot,
} from "@zcode/contracts";
import { DefaultRuntimeConfig, SkillNotFoundError } from "@zcode/contracts";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";
import { PLUGIN_SKILL_ROOT_PRIORITY, resolvePluginSkillRoots } from "../plugins/index.js";
import {
  createLiveFileReader,
  readEnabledPlugins,
  readLiveConfig,
  type LivePluginCandidate,
} from "../plugins/live-inventory.js";
import {
  createRefcountedRegistry,
  createWatchedEntry,
  type WatchedEntry,
  type WatchedLoad,
} from "../watch/watched-source.js";
import {
  isNotFoundError,
  matchesSkillRequest,
  NodeSkillAdapter,
  readSkillContent,
  scanSkillRoot,
  throwIfAborted,
} from "./index.js";
import { findWorktreeRoot, resolveDefaultSkillRoots } from "./roots.js";

const ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface SkillCatalogSourceOptions {
  /** 不传时取当前用户目录。 */
  homeDirectory?: string;
  workingDirectory: string;
  additionalDirectories?: readonly string[];
  /** 项目配置路径（缺失的也登记）与用户配置路径，与 MCP 配置源同一份。 */
  configPaths: string[];
  userConfigPath?: string;
  pluginStorageRoot: string;
  /** 启动时发现的插件；只使用官方插件根目录。 */
  pluginRoots: LivePluginCandidate[];
  defaultEnabledPlugins?: ReadonlySet<string>;
  /** 随 CLI 内置的 skill 根；不监听。 */
  bundledRoots: readonly SkillRoot[];
  /** 会话期间固定的禁用路径（动态工作流关闭时的内置 skill）。 */
  fixedDisabledPaths?: readonly string[];
  /** 不提供的插件（终端会话没有内联视图宿主时的 visualize）。 */
  excludedPluginIds?: readonly string[];
  logger?: Logger;
}

/** 会话持有的 view：快照只读，多个会话共用同一对象。 */
export interface SkillCatalogSource {
  getSnapshot(): SkillLoadOutcome;
  /** 跳过去抖立即全量重读，等到结果被采纳。 */
  flush(): Promise<void>;
  /** 幂等释放；最后一个 view 释放时关闭 watcher。 */
  close(): void;
}

export interface SkillCatalogSourceRegistry {
  acquire(options: SkillCatalogSourceOptions): Promise<SkillCatalogSource>;
  close(): void;
}

/** 读实时目录的端口：discover 与 currentCatalog 只读内存，loadSkill 只读命中项的正文。 */
export interface CatalogSkillPort extends SkillPort {
  currentCatalog(): SkillLoadOutcome;
  close(): void;
}

interface LoadedSkillCatalog extends WatchedLoad {
  outcome: SkillLoadOutcome;
}

type SharedSkillCatalogEntry = WatchedEntry<LoadedSkillCatalog>;

export function createSkillCatalogSourceRegistry(
  registryOptions: { logger?: Logger } = {},
): SkillCatalogSourceRegistry {
  return createRefcountedRegistry<
    SkillCatalogSourceOptions,
    SharedSkillCatalogEntry,
    SkillCatalogSource
  >({
    label: "Skill catalog source",
    key: catalogKey,
    create: (options) =>
      createSharedSkillCatalogEntry({
        ...options,
        logger: registryOptions.logger ?? options.logger,
      }),
    view: (entry, _options, release) => createCatalogView(entry, release),
  });
}

/** 单个调用方（TUI、headless、测试）的私有目录：view 释放即关闭全部资源。 */
export async function createSkillCatalogSource(
  options: SkillCatalogSourceOptions,
): Promise<SkillCatalogSource> {
  return createSkillCatalogSourceRegistry().acquire(options);
}

export function createCatalogSkillPort(source: SkillCatalogSource): CatalogSkillPort {
  const find = (name: string) =>
    source.getSnapshot().skills.find((skill) => matchesSkillRequest(skill, name));
  return {
    async discoverSkills() {
      return source.getSnapshot();
    },
    currentCatalog: () => source.getSnapshot(),
    async loadSkill(request, options) {
      throwIfAborted(options);
      const listed = find(request.name);
      const content = listed && (await readListedSkill(listed, request.maxBytes));
      if (content) return content;
      // 模型刚写入的 skill 可能还在去抖窗口内：未命中时立即全量重读一次再判定，结果确定，不靠等待。
      await source.flush();
      // 修复原因：重读是全量读盘，曾不看取消信号，用户停止后仍要等它结束。
      throwIfAborted(options);
      const metadata = find(request.name);
      const reloaded = metadata && (await readListedSkill(metadata, request.maxBytes));
      if (!reloaded) throw new SkillNotFoundError(request.name);
      return reloaded;
    },
    close: () => source.close(),
  };
}

/** 读快照命中项的正文；文件已删除或插件 skill 未通过扫描规则时返回 undefined，按未命中处理。 */
async function readListedSkill(
  skill: SkillMetadata,
  maxBytes: number | undefined,
): Promise<SkillContent | undefined> {
  // 修复原因：插件目录不在监听范围，快照建立后插件的 SKILL.md、skill 目录或根目录被换成
  // 指向插件外的链接时不会重读。曾按快照路径直接读取，插件外文件的内容作为正文交给模型。
  // 改动前每次调用都全量扫描，由插件扫描规则拒绝链接；这里读正文前对该插件根重跑同一条规则。
  // 扫描失败（如无读权限）同样按未命中处理，重读时记录诊断。
  if (skill.source === "plugin") {
    const files = await scanSkillRoot({ path: skill.rootPath, source: skill.source }).catch(
      (): string[] => [],
    );
    if (!files.includes(skill.path)) return undefined;
  }
  // 修复原因：命中项的文件可能已删除（去抖窗口内删除目录，或只删了 SKILL.md），
  // 曾直接返回原始的 ENOENT。现在与未命中一样先全量重读一次再判定。
  return readSkillContent(skill, maxBytes).catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
}

/** key 与加载器输入取自同一份 options；Set 和无序列表先排序。 */
function catalogKey(options: SkillCatalogSourceOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        resolve(options.homeDirectory ?? homedir()),
        resolve(options.workingDirectory),
        [...(options.additionalDirectories ?? [])].map((path) => resolve(path)).toSorted(),
        options.configPaths,
        options.userConfigPath ?? null,
        options.pluginStorageRoot,
        // 修复原因：已信任的项目目录插件也是加载器输入。键里只有官方根目录时，信任前后创建的
        // 会话共用同一个源，信任后的新会话仍拿不到插件的 MCP 与技能（WPL-014 运行时日志确认）。
        options.pluginRoots
          .filter((root) => root.source === "official" || root.workspaceTrust?.state === "trusted")
          .map((root) => [
            root.rootPath,
            root.marketplace,
            root.workspaceTrust?.state === "trusted" ? root.workspaceTrust.declarationDigest : null,
          ]),
        [...(options.defaultEnabledPlugins ?? [])].toSorted(),
        options.bundledRoots.map((root) => [root.path, root.priority, root.scope, root.source]),
        [...(options.fixedDisabledPaths ?? [])].toSorted(),
        [...(options.excludedPluginIds ?? [])].toSorted(),
      ]),
    )
    .digest("hex");
}

function createCatalogView(
  entry: SharedSkillCatalogEntry,
  release: () => void,
): SkillCatalogSource {
  let closed = false;
  return {
    getSnapshot: () => entry.current().outcome,
    flush: () => (closed ? Promise.resolve() : entry.flush()),
    close() {
      // 一次 app 关闭会多次走 beginShutdown；只释放一次引用。
      if (closed) return;
      closed = true;
      release();
    },
  };
}

async function createSharedSkillCatalogEntry(
  options: SkillCatalogSourceOptions,
): Promise<SharedSkillCatalogEntry> {
  const home = resolve(options.homeDirectory ?? homedir());
  const workingDirectory = resolve(options.workingDirectory);
  const projectBound = (await findWorktreeRoot(workingDirectory)) ?? workingDirectory;
  const loader = createSkillCatalogLoader({ ...options, homeDirectory: home, workingDirectory });
  return createWatchedEntry({
    load: () => loader.load(),
    // 缺失目录只在这些边界之内向上找锚点：不监听用户目录这类大目录。
    bounds: [
      join(home, ZCODE_DIR),
      join(home, AGENTS_DIR),
      projectBound,
      ...(options.additionalDirectories ?? []),
      options.pluginStorageRoot,
      ...(options.userConfigPath ? [dirname(options.userConfigPath)] : []),
    ],
    childName: shouldWalkSkillDirectoryEntry,
    label: "Skill catalog",
    logger: options.logger,
  });
}

/**
 * 每次全量读取配置、已启用插件与 skill 根。监听集合：配置文件与插件提交点（与 MCP 同一路径），
 * 非插件、非内置的 skill 根目录（目录条目）与根目录下的 SKILL.md。
 * 已有 skill 的 SKILL.md、没有 SKILL.md 的子目录、插件目录、内置目录都不监听，数量与 skill 数、插件数无关。
 */
export function createSkillCatalogLoader(
  options: SkillCatalogSourceOptions & { homeDirectory: string },
) {
  const reader = createLiveFileReader({
    label: "Skill catalog",
    logger: options.logger,
  });
  // 只跨越原子安装的未提交窗口保留插件上次稳定的 skill 根；禁用、卸载不回退。
  let stableRoots = new Map<string, { id: string; roots: SkillRoot[] }>();
  // 每次重读都新建 adapter；插件名缓存跨重读共用，不重复向上查找 plugin.json。
  const pluginNameCache = new Map<string, Promise<string | undefined>>();

  async function load(): Promise<LoadedSkillCatalog> {
    const pass = reader.begin();
    // 与启动配置同一 scope：项目配置不能加 skills.roots，只能写绝对路径的开关。
    const { merged } = await readLiveConfig(pass, options);
    const plugins = { ...DefaultRuntimeConfig.plugins, ...merged.plugins };

    const diagnostics: PluginDiagnostic[] = [];
    const pluginRoots: SkillRoot[] = [];
    const nextStableRoots = new Map<string, { id: string; roots: SkillRoot[] }>();
    let priority = PLUGIN_SKILL_ROOT_PRIORITY.first;
    for (const { candidate, loaded, stable } of await readEnabledPlugins(pass, {
      plugins,
      pluginStorageRoot: options.pluginStorageRoot,
      pluginRoots: options.pluginRoots,
      defaultEnabledPlugins: options.defaultEnabledPlugins,
    })) {
      const current = priority;
      priority += PLUGIN_SKILL_ROOT_PRIORITY.step;
      if (options.excludedPluginIds?.includes(loaded.id)) continue;
      if (!stable) {
        const previous = stableRoots.get(candidate.rootPath);
        if (previous?.id === loaded.id) {
          nextStableRoots.set(candidate.rootPath, previous);
          pluginRoots.push(...previous.roots);
        }
        continue;
      }
      try {
        const roots = await resolvePluginSkillRoots({ diagnostics, loaded }, current);
        nextStableRoots.set(candidate.rootPath, { id: loaded.id, roots });
        pluginRoots.push(...roots);
      } catch (error) {
        // 单个插件的错误只移除它的 skill，不阻断其他来源的增删。
        pass.warnings.push([
          "Plugin skill preparation failed",
          { pluginId: loaded.id, error: String(error) },
        ]);
      }
    }
    for (const diagnostic of diagnostics)
      pass.warnings.push(["Plugin skill configuration diagnostic", { ...diagnostic }]);

    const adapterOptions = {
      homeDirectory: options.homeDirectory,
      additionalDirectories: options.additionalDirectories,
      extraRoots: merged.skills?.roots ?? [],
      extraResolvedRoots: [...pluginRoots, ...options.bundledRoots],
      disabledPaths: [
        ...Object.entries(merged.skillOverrides ?? {})
          .filter(([, override]) => override.enable === false)
          .map(([path]) => path),
        ...(options.fixedDisabledPaths ?? []),
      ],
      pluginNameCache,
    };
    const roots = await resolveDefaultSkillRoots(options.workingDirectory, adapterOptions);
    const outcome = await new NodeSkillAdapter(adapterOptions).discoverSkills({
      workingDirectory: options.workingDirectory,
      roots,
    });
    const directories = new Set(
      roots
        .filter((root) => root.source !== "plugin" && root.source !== "bundled")
        .map((root) => resolve(root.path)),
    );
    for (const directory of directories) pass.files.add(join(directory, SKILL_FILE_NAME));
    return {
      outcome,
      files: pass.files,
      directories,
      commit() {
        pass.commit();
        stableRoots = nextStableRoots;
      },
    };
  }

  return { load };
}

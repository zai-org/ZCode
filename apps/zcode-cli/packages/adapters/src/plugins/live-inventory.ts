import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Logger, PluginMetadata, RuntimeConfigPatch } from "@zcode/contracts";
import {
  ConfigScope,
  DefaultRuntimeConfig,
  ZCODE_INLINE_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} from "@zcode/contracts";
import { createPrioritizedConfig, mergeConfigs } from "../config/config-merger.js";
import {
  getProjectConfigBaseDir,
  normalizeProjectConfig,
} from "../config/project-config.adapter.js";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../config/schema.js";
import {
  bundledOfficialMarketplacePath,
  parseBundledOfficialPluginRoots,
} from "./official-marketplace.js";
import { parsePluginManifest } from "./discovery/index.js";
import { isRecord } from "./helpers.js";
import type { LoadedPlugin } from "./types.js";
import {
  computeWorkspacePluginDeclarationDigest,
  readTextIfExists,
} from "./workspace-plugin-declaration/index.js";
import { readAtomicTarget } from "./atomic-directory.js";
import { installedPluginPath, normalizeInstalledPluginsState } from "./marketplace.js";

// ============================================================
// 打开的会话里重读配置与已启用插件的共享规则。
// MCP 配置源与 Skill 实时目录各有自己的加载器，但读文件、配置解析与合并、插件候选、
// 启用判定与监听收窄只有这一份，避免两个领域对同一个文件或插件得出不同结论。
// ============================================================

/** 插件 manifest 的固定查找顺序，与启动时的插件发现一致。 */
const PLUGIN_MANIFEST_DIRECTORIES = [".zcode-plugin", ".claude-plugin", ".codex-plugin"];
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

type LiveWarning = [message: string, context: Record<string, unknown>];

type LivePluginsConfig = Pick<
  (typeof DefaultRuntimeConfig)["plugins"],
  "enabled" | "dirs" | "enabledPlugins" | "suppressedBuiltins"
>;

/** 一次全量读取；只有调用方采纳本次结果时才 commit。 */
export interface LiveReadPass {
  /** 本次读到或依赖的文件，即监听集合；缺失的文件也登记。 */
  files: Set<string>;
  warnings: LiveWarning[];
  json(
    path: string,
    validate?: (value: Record<string, unknown>) => void,
    watched?: Set<string>,
  ): Promise<Record<string, unknown> | undefined>;
  manifest(
    root: string,
    watched: Set<string>,
  ): Promise<{ manifestPath: string; manifest: LoadedPlugin["manifest"] } | undefined>;
  /** 读文本并登记监听；不存在返回 undefined。项目插件重算声明摘要用。 */
  text(path: string, watched: Set<string>): Promise<string | undefined>;
  /** 提交回退基础，并只记录上次采纳的结果里没有的 warn。 */
  commit(): void;
}

export type LivePluginCandidate = Pick<PluginMetadata, "rootPath" | "marketplace" | "source"> &
  Partial<Pick<PluginMetadata, "workspaceTrust">>;

export interface LiveConfigFile {
  /** 缺失的项目配置不提供私有 workspace 选项的层锚点，与启动发现一致。 */
  loaded: boolean;
  path: string;
  /** 用户配置；其余路径都按项目配置处理。 */
  user: boolean;
  /** 项目文件里相对路径的基准目录。 */
  base: string;
  patch: RuntimeConfigPatch;
}

export interface LiveEnabledPlugin {
  candidate: LivePluginCandidate;
  loaded: LoadedPlugin;
  /** 安装事务未完成时为 false：调用方沿用该插件上次稳定的结果。 */
  stable: boolean;
  /** 读取该插件声明文件时登记的集合；只有 inline 插件进入监听。 */
  watched: Set<string>;
}

/** label 区分读取方（"MCP configuration"、"Skill catalog"），写进读失败文案与每条 warn 的 context。 */
export function createLiveFileReader(options: { label: string; logger?: Logger }) {
  // 回退基础只在加载结果被采纳时提交。修复前每次读取都直接改写，drain 中途被新事件取代、
  // 从未发布的读取也会成为下一次解析失败时的回退值。
  let lastValid = new Map<string, Record<string, unknown>>();
  // 修复原因：加载 warn（配置读取失败、manifest 无效、插件诊断等）曾在每次重读时全部再记一遍，
  // 频繁保存配置时同一条 warn 持续刷日志。现在只记录上次采纳的结果里没有的条目。
  let loggedWarnings = new Set<string>();

  return {
    begin(): LiveReadPass {
      const files = new Set<string>();
      const nextValid = new Map(lastValid);
      const warnings: LiveWarning[] = [];
      async function json(
        path: string,
        validate?: (value: Record<string, unknown>) => void,
        watched: Set<string> = files,
      ): Promise<Record<string, unknown> | undefined> {
        watched.add(path);
        try {
          const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
          if (!isRecord(parsed)) throw new Error("Configuration must be an object");
          validate?.(parsed);
          nextValid.set(path, parsed);
          return parsed;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            nextValid.delete(path);
            return undefined;
          }
          warnings.push([`${options.label} read failed`, { path, error: String(error) }]);
          return nextValid.get(path);
        }
      }
      /** 第一个存在的 manifest 生效；它无效时跳过插件，不回退到下一个目录。 */
      async function manifest(root: string, watched: Set<string>) {
        for (const directory of PLUGIN_MANIFEST_DIRECTORIES) {
          const manifestPath = join(root, directory, "plugin.json");
          watched.add(manifestPath);
          let text: string;
          try {
            text = await readFile(manifestPath, "utf8");
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") continue;
            warnings.push([
              "Plugin manifest read failed",
              { path: manifestPath, error: String(error) },
            ]);
            return undefined;
          }
          try {
            return { manifestPath, manifest: parsePluginManifest(JSON.parse(text)) };
          } catch (error) {
            warnings.push([
              "Plugin manifest invalid",
              { path: manifestPath, error: String(error) },
            ]);
            return undefined;
          }
        }
        return undefined;
      }
      async function text(path: string, watched: Set<string>) {
        watched.add(path);
        return readTextIfExists(path);
      }
      return {
        files,
        warnings,
        json,
        manifest,
        text,
        commit() {
          lastValid = nextValid;
          const keys = new Set<string>();
          for (const [message, context] of warnings) {
            const key = JSON.stringify([message, context]);
            keys.add(key);
            // MCP 与 Skill 各读一遍同一批插件，manifest 坏掉时两边记同样的文案；context 标出读取方。
            if (!loggedWarnings.has(key))
              options.logger?.warn(message, { ...context, reader: options.label });
          }
          loggedWarnings = keys;
        },
      };
    },
  };
}

/**
 * 按启动配置的规则读取并合并配置文件：项目文件用项目白名单解析
 * （根目录 docs/security/deep-link-project-trust-boundary.md），再去掉 Hook 声明与 plugins.dirs；
 * 每个文件整份按 scope 优先级合并，与 createConfig 一致。
 */
export async function readLiveConfig(
  pass: LiveReadPass,
  input: { configPaths: readonly string[]; userConfigPath?: string },
): Promise<{ files: LiveConfigFile[]; merged: RuntimeConfigPatch }> {
  const files: LiveConfigFile[] = [];
  for (const path of input.configPaths) {
    const user = path === input.userConfigPath;
    // 修复原因：MCP 加载器曾用用户 schema 解析项目文件，项目里的 features、插件全局开关
    // 能在打开的会话里关掉 MCP，运行参数的非法值还会让同一文件的 MCP 声明整体失效。
    const parse = (value: Record<string, unknown>) =>
      parseConfigFileToRuntimePatchWithDiagnostics(value, user ? "user" : "project");
    const value = await pass.json(path, (candidate) => {
      const result = parse(candidate);
      // 单个 server 的 warning 已由解析器跳过，不能因此丢弃有效项和显式禁用配置。
      if (result.diagnostics.some((item) => item.severity === "error"))
        throw new Error(result.diagnostics.map((item) => item.message).join("; "));
    });
    const base = getProjectConfigBaseDir(path);
    const parsed = parse(value ?? {}).config;
    files.push({
      loaded: value !== undefined,
      path,
      user,
      base,
      patch: user ? parsed : normalizeProjectConfig(parsed, base),
    });
  }
  // 修复原因：MCP 加载器曾只挑 plugins、features 组成每一层，没声明的字段是显式 undefined；
  // 合并器先整体 Object.assign，项目层会冲掉用户层的 features.mcp=false。整份推入与启动配置一致。
  const merged = mergeConfigs(
    createPrioritizedConfig(
      { plugins: DefaultRuntimeConfig.plugins, features: DefaultRuntimeConfig.features },
      ConfigScope.System,
    ),
    ...files.map(({ user, patch }) =>
      createPrioritizedConfig(patch, user ? ConfigScope.User : ConfigScope.Project),
    ),
  );
  return { files, merged };
}

/**
 * 按启动时的候选顺序（inline、官方、bundled、缓存）返回当前启用的插件。
 * 安装记录与 bundled 分片总是进入监听集合；插件被禁用时也要读，之后启用才能被发现。
 */
export async function readEnabledPlugins(
  pass: LiveReadPass,
  input: {
    plugins: LivePluginsConfig;
    pluginStorageRoot: string;
    pluginRoots: LivePluginCandidate[];
    defaultEnabledPlugins?: ReadonlySet<string>;
  },
): Promise<LiveEnabledPlugin[]> {
  // 安装清单与插件目录共用原子事务判定：Windows 替换窗口内正式文件暂不存在，读 backup。
  // 修复前直接读正式文件，窗口内清单为空，已安装插件被短暂撤下再重新加载。
  const inventory = await readAtomicTarget(join(input.pluginStorageRoot, INSTALLED_PLUGINS_FILE));
  for (const file of inventory.files) pass.files.add(file);
  const installed = await pass.json(inventory.path, (value) => {
    if (!Array.isArray(value.plugins) && !isRecord(value.plugins))
      throw new Error("Invalid plugin installation inventory");
  });
  const bundled = parseBundledOfficialPluginRoots(
    await pass.json(bundledOfficialMarketplacePath(input.pluginStorageRoot)),
    input.pluginStorageRoot,
  );
  const candidates = input.pluginRoots.filter(
    (root) =>
      root.source === "official" &&
      (bundled === undefined ||
        !relative(join(input.pluginStorageRoot, "cache"), root.rootPath).startsWith(
          `${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}${sep}`,
        )),
  );
  for (const rootPath of bundled ?? [])
    candidates.push({
      rootPath,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      source: "official",
    });
  for (const item of normalizeInstalledPluginsState(installed).plugins)
    candidates.push({
      // 修复原因：记录没有 installPath 时曾直接用空串，被解析成进程 cwd；与启动一样按缓存目录推出。
      rootPath: installedPluginPath(input.pluginStorageRoot, item),
      marketplace: item.marketplace,
      source: "cache",
    });
  candidates.unshift(
    ...input.plugins.dirs.map((rootPath) => ({
      rootPath: resolve(rootPath),
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      source: "inline" as const,
    })),
    // 项目目录插件只沿用会话启动时已准入的那批（新信任不热加载）；摘要在下面每次重验。
    ...input.pluginRoots.filter((root) => root.workspaceTrust?.state === "trusted"),
  );
  const enabled: LiveEnabledPlugin[] = [];
  const seen = new Set<string>();
  if (!input.plugins.enabled) return enabled;
  for (const candidate of candidates) {
    const readView = await readAtomicTarget(candidate.rootPath);
    // 只监听提交点：缓存与官方插件目录只由安装流程写入，流程以写 installed_plugins.json 或
    // bundled 分片结束，二者已在监听集合里。修复前每个插件约占 3 个目录 watcher，
    // 26 个插件约 84 个，新会话获取配置源时要串行等它们就绪。inline 插件没有提交点，仍监听。
    const watched = candidate.source === "inline" ? pass.files : new Set<string>();
    for (const file of readView.files) watched.add(file);
    // 安装记录是提交点；不枚举尚未安装完成的临时 cache 目录。
    const found = await pass.manifest(readView.path, watched);
    const loaded: LoadedPlugin | undefined = found && {
      ...candidate,
      ...found,
      id: `${found.manifest.name}@${candidate.marketplace}`,
    };
    if (!loaded || seen.has(loaded.id)) continue;
    const trust = candidate.workspaceTrust;
    // 会话中途声明变了（例如 git pull），新声明没有被信任过：撤下该插件的 MCP 与技能，
    // 不能让启动时的信任覆盖变化后的内容。
    if (
      trust &&
      (await computeWorkspacePluginDeclarationDigest({
        pluginRoot: trust.pluginRoot,
        rootPath: loaded.rootPath,
        manifestPath: loaded.manifestPath,
        manifest: loaded.manifest,
        readText: (path) => pass.text(path, watched),
      })) !== trust.declarationDigest
    )
      continue;
    seen.add(loaded.id);
    if (loaded.source === "official" && input.plugins.suppressedBuiltins.includes(loaded.id))
      continue;
    if (
      !(
        input.plugins.enabledPlugins[loaded.id] ??
        (loaded.source === "inline" || input.defaultEnabledPlugins?.has(loaded.id))
      )
    )
      continue;
    enabled.push({ candidate, loaded, stable: readView.stable, watched });
  }
  return enabled;
}

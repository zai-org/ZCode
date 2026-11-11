import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { zcodePluginUserConfigOptionSchema } from "@zcode/shared";
import type {
  CustomCommandRoot,
  HookConfig,
  HookEventName,
  HookMatcherConfig,
  HookPluginContext,
  PluginConfig,
  PluginDiagnostic,
  PluginDiscoverRequest,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginManifest,
  PluginUiSurfaceDefinition,
  PluginMetadata,
  PluginPort,
  SkillRoot,
} from "@zcode/contracts";
import {
  HookEventName as HookEventNameValue,
  HookMatcherConfigSchema,
  ZCODE_INLINE_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} from "@zcode/contracts";
import {
  directoryExistsAsync,
  isNotFoundError,
  isRecord,
  parsePathList,
  resolveInside,
  sanitizePluginId,
  throwIfAborted,
  PluginMaterialCache,
  type PluginMaterialReader,
  pluginSourcesChanged,
  isPluginMaterialChange,
  rethrowPluginMaterialInterrupt,
  waitForPluginQuery,
} from "./helpers.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import { parsePluginUiSurfaces } from "./ui-surfaces.js";
import { createHookPluginContext, listPluginHookSources } from "./hook-sources.js";
import {
  countSkillFiles,
  materializeCommandMetadataRoot,
  warnEmptyDeclaredSkillRoots,
  enumeratePluginComponents,
} from "./plugin-components.js";
import {
  listInstalledPluginRecordsAsync,
  normalizeAuthorValue,
  resolveInstalledPluginRootAsync,
} from "./marketplace.js";
import { loadBundledOfficialPluginRoots } from "./official-marketplace.js";
import type {
  LoadedPlugin,
  PluginAbortOptions,
  PluginCandidate,
  PluginComponents,
} from "./types.js";

export {
  addMarketplace,
  applyClaudePluginIcons,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryExtensionSummary,
  parseEntryStoreListing,
  parsePluginIconSources,
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateMarketplacePlugin,
  validateLocalPluginPath,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginComponentGroup,
  type PluginComponentItem,
  type PluginComponentKind,
  type PluginExtensionSummary,
  type PluginManifestDisplayMetadata,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
} from "./marketplace.js";

export {
  writeBundledOfficialMarketplacePartition,
  writeCdnOfficialMarketplacePartition,
} from "./official-marketplace.js";

export { getPluginSourceDiagnosticCode } from "./source-errors.js";

export {
  comparePluginUpdate,
  comparePluginVersions,
  type PluginUpdateStatus,
} from "./version-compare.js";

const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
// 外部清单的扩展字段不能穿透到 strict 协议；复用已知字段校验，尤其不能丢掉 sensitive。
const pluginUserConfigSchema = z.record(z.string(), zcodePluginUserConfigOptionSchema.strip());
const FIRST_PLUGIN_PRIORITY = 1_000;
const PRIORITY_STEP = 10;
const PLUGIN_DISCOVERY_REBUILD_LIMIT = 3;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UNSUPPORTED_COMPONENT_KEYS = ["channels", "lspServers", "outputStyles", "settings"] as const;
const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

interface PluginHookInspection {
  details: PluginHookDetail[];
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
}

export interface NodePluginAdapterOptions {
  storageRoot: string;
}

export class NodePluginAdapter implements PluginPort {
  private readonly materials = new PluginMaterialCache();
  invalidate(): void {
    this.materials.invalidate();
  }
  dispose(): void {
    this.materials.dispose();
  }

  async discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginAbortOptions,
  ): Promise<PluginLoadOutcome> {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.materials.signal])
      : this.materials.signal;
    return waitForPluginQuery(this.discoverCurrent(request, options), signal);
  }

  private async discoverCurrent(
    request: PluginDiscoverRequest,
    options?: PluginAbortOptions,
  ): Promise<PluginLoadOutcome> {
    for (let attempt = 0; attempt < PLUGIN_DISCOVERY_REBUILD_LIMIT; attempt += 1) {
      this.materials.signal.throwIfAborted();
      throwIfAborted(options);
      const scope = JSON.stringify([
        resolve(request.workingDirectory),
        request.workspaceIdentity?.trim() || resolve(request.workingDirectory),
        request.remoteSessionId?.trim() ?? "",
        resolve(request.storageRoot || this.options.storageRoot),
      ]);
      const materials = this.materials.reader(scope);
      try {
        const outcome = await this.loadDiscovery(request, options, materials);
        throwIfAborted(options);
        if (await materials.validate()) return outcome;
      } catch (error) {
        if (!isPluginMaterialChange(error)) throw error;
      }
    }
    throw pluginSourcesChanged();
  }

  constructor(private readonly options: NodePluginAdapterOptions) {}

  private async loadDiscovery(
    request: PluginDiscoverRequest,
    options: PluginAbortOptions | undefined,
    materials: PluginMaterialReader,
  ): Promise<PluginLoadOutcome> {
    if (!request.config.enabled) return emptyOutcome();

    const diagnostics: PluginDiagnostic[] = [];
    const dataRoot = join(request.storageRoot || this.options.storageRoot, "data");
    const candidates = await this.resolveCandidates(request, diagnostics, materials, options);
    const commandRoots: CustomCommandRoot[] = [];
    const hooks: PluginLoadOutcome["hooks"] = {};
    const mcpServers: PluginLoadOutcome["mcpServers"] = {};
    const plugins: PluginMetadata[] = [];
    const seen = new Set<string>();
    const skillRoots: SkillRoot[] = [];
    let priority = FIRST_PLUGIN_PRIORITY;

    for (const candidate of candidates) {
      throwIfAborted(options);
      const loaded = await loadPlugin(candidate, diagnostics, materials);
      if (!loaded) continue;
      // 内置（官方）插件被「卸载」后只在 user config 写 suppressedBuiltins 标记。这里在发现层
      // 用插件的权威 id（manifest 名 @ marketplace）过滤，不依赖缓存文件是否已被物理删除——
      // 这样即便 app 升级遗留了旧版本缓存目录、或会话内 facade 持有过时配置，被卸载的内置插件
      // 也不会被重新发现。仅作用于 official 源，inline/cache（市场安装）不受影响。
      if (loaded.source === "official" && request.config.suppressedBuiltins.includes(loaded.id)) {
        continue;
      }
      if (seen.has(loaded.id)) {
        diagnostics.push({
          code: "plugin_duplicate_id",
          message: `Duplicate plugin ignored: ${loaded.id}`,
          path: loaded.rootPath,
          pluginId: loaded.id,
          severity: "warning",
        });
        continue;
      }
      seen.add(loaded.id);
      warnUnsupportedComponents(loaded, diagnostics);

      // candidate.defaultEnabled 在 candidate 构造时无法访问 plugin id,
      // 这里再叠加 bootstrap 提供的 "默认开" 名单 (按 `<name>@<marketplace>` 匹配)。
      const candidateDefaultEnabled =
        candidate.defaultEnabled ||
        (request.officialPluginsEnabledByDefault?.has(loaded.id) ?? false);
      const enabled = resolveEnabled(request.config, loaded.id, candidateDefaultEnabled);
      const dataPath = join(dataRoot, sanitizePluginId(loaded.id));
      // 只从启用后解析出的 component.mcpServers 生成 mcpServerNames，
      // 未启用插件的内置 MCP 就会在管理页完全不可见。这里先读取声明名给 UI 只读展示，
      // 实际 runtime 注入仍只使用 enabled 分支解析出的 component.mcpServers。
      const mcpServerDefinitions = await loadPluginMcpServerDefinitions({ diagnostics, loaded });
      const hooksRunnable = canRunPluginHooks(loaded);
      const hookInspection = await inspectPluginHooks({
        dataPath,
        diagnostics,
        loaded,
        runnable: hooksRunnable,
      });
      const component = enabled
        ? await resolveEnabledComponents({
            dataPath,
            diagnostics,
            env: request.env ?? {},
            hookEvents: hooksRunnable ? hookInspection.events : {},
            hookDetails: hookInspection.details,
            loaded,
            mcpServerDefinitions,
            options: request.config.options[loaded.id] ?? {},
            priority,
            workingDirectory: request.workingDirectory,
          })
        : emptyComponents(hookInspection.details);
      priority += PRIORITY_STEP;

      Object.assign(mcpServers, component.mcpServers);
      mergeHookEvents(hooks, component.hooks);
      skillRoots.push(...component.skillRoots);
      commandRoots.push(...component.commandRoots);
      const declaredMcpServerNames = Object.keys(mcpServerDefinitions);
      plugins.push(
        await createPluginMetadata(
          loaded,
          component,
          dataPath,
          enabled,
          declaredMcpServerNames,
          request.config.options[loaded.id] ?? {},
          // 插件 UI 面板入口（A5）：与启用态无关地解析，禁用插件的入口由 listUiSurfaces 过滤。
          parsePluginUiSurfaces({ loaded, declaredMcpServerNames, diagnostics }),
        ),
      );
    }

    return {
      commandRoots,
      diagnostics,
      hooks,
      mcpServers,
      plugins,
      skillRoots,
    };
  }

  private async resolveCandidates(
    request: Pick<PluginDiscoverRequest, "config" | "officialPluginRoots" | "storageRoot">,
    diagnostics: PluginDiagnostic[],
    materials: PluginMaterialReader,
    options?: PluginAbortOptions,
  ): Promise<PluginCandidate[]> {
    const candidates: PluginCandidate[] = [];
    for (const rootPath of request.config.dirs) {
      candidates.push({
        defaultEnabled: true,
        marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "inline",
      });
    }
    for (const rootPath of request.officialPluginRoots ?? []) {
      candidates.push({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "official",
      });
    }
    candidates.push(
      ...(await scanOfficialCache(request.storageRoot, diagnostics, materials, options)).map(
        (rootPath) => ({
          defaultEnabled: false,
          marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
          rootPath,
          source: "official" as const,
        }),
      ),
    );
    for (const name of [
      "installed_plugins.json",
      ".installed_plugins.json.backup",
      ".installed_plugins.json.transaction.json",
    ]) {
      try {
        await materials.observe(join(request.storageRoot, name));
      } catch (error) {
        rethrowPluginMaterialInterrupt(error);
      }
    }
    for (const installed of await listInstalledPluginRecordsAsync(request.storageRoot)) {
      candidates.push({
        defaultEnabled: false,
        marketplace: installed.marketplace,
        rootPath: await resolveInstalledPluginRootAsync(request.storageRoot, installed),
        source: "cache",
      });
    }
    return candidates;
  }
}

export function createNodePluginAdapter(options: NodePluginAdapterOptions): NodePluginAdapter {
  return new NodePluginAdapter(options);
}

export async function discoverNodePlugins(
  request: PluginDiscoverRequest,
  options?: PluginAbortOptions,
): Promise<PluginLoadOutcome> {
  const adapter = createNodePluginAdapter({ storageRoot: request.storageRoot });
  try {
    return await adapter.discoverPlugins(request, options);
  } finally {
    adapter.dispose();
  }
}

async function createPluginMetadata(
  loaded: LoadedPlugin,
  component: PluginComponents,
  dataPath: string,
  enabled: boolean,
  declaredMcpServerNames: string[],
  configuredOptions: Record<string, string | number | boolean>,
  uiSurfaces: PluginUiSurfaceDefinition[],
): Promise<PluginMetadata> {
  // manifest 的 author/homepage 作为详情页信息区的回退来源（商店 listing 优先）。
  const author = normalizeAuthorValue(loaded.manifest.author);
  const homepage =
    typeof loaded.manifest.homepage === "string" && loaded.manifest.homepage.trim().length > 0
      ? loaded.manifest.homepage
      : undefined;
  return {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    commandRootCount: component.commandRoots.length,
    // 详情 UI 过去靠 plugin.skillCount（权威计数）+ 一条 UI 侧 join（按 pluginName 过滤
    // skillsService 结果）拿名称，二者数据源分离。停用插件走 emptyComponents() 使 skillCount=0、
    // 且 UI join 对停用插件不产出名称（skillsService 里 `if (!enabled) continue`），导致：停用时
    // 整个技能分组消失、启用时只有数量没有名称。这里改为对插件根目录做权威枚举（与启用态无关），
    // 直接把名称+描述随 list 下发，UI 不再需要脆弱的 join。
    components: await enumeratePluginComponents(loaded.rootPath, loaded.manifest, { loaded }),
    configuredOptions: { ...configuredOptions },
    dataPath,
    declaredMcpServerNames,
    description: loaded.manifest.description,
    enabled,
    id: loaded.id,
    manifestPath: loaded.manifestPath,
    marketplace: loaded.marketplace,
    mcpServerNames: Object.keys(component.mcpServers),
    name: loaded.manifest.name,
    hookDetails: component.hookDetails,
    rootPath: loaded.rootPath,
    skillCount: component.skillCount,
    skillRootCount: component.skillRoots.length,
    source: loaded.source,
    ...(uiSurfaces.length > 0 ? { uiSurfaces } : {}),
    userConfig: loaded.manifest.userConfig,
    version: loaded.manifest.version,
  };
}

async function resolveEnabledComponents(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  hookDetails: PluginHookDetail[];
  hookEvents: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  loaded: LoadedPlugin;
  mcpServerDefinitions: Record<string, unknown>;
  options: Record<string, string | number | boolean>;
  priority: number;
  workingDirectory: string;
}): Promise<PluginComponents> {
  await mkdir(input.dataPath, { recursive: true });

  const skillRoots = await resolveSkillRoots(input, input.priority);
  return {
    commandRoots: await resolveCommandRoots(input, input.priority + 1),
    hooks: input.hookEvents,
    hookDetails: input.hookDetails,
    mcpServers: resolvePluginMcpServers({
      ...input,
      definitions: input.mcpServerDefinitions,
    }),
    // 插件页要展示真实技能数量。之前只统计 skills root 数，
    // document-skills 这种一个 root 下有多个 SKILL.md 的插件会被显示成 1。
    skillCount: await countSkillFiles(skillRoots, input.loaded.materials),
    skillRoots,
  };
}

function canRunPluginHooks(_loaded: LoadedPlugin): boolean {
  // 三方 marketplace 插件 hook 默认放行（与内置/官方一致）。
  // 上限：放弃了「仅官方可执行 hook」的信任边界，三方插件 hook 会直接执行；
  // 升级路径：需要逐插件 trust（如 user config 白名单）时，把判断收回这里。
  return true;
}

function warnUnsupportedComponents(loaded: LoadedPlugin, diagnostics: PluginDiagnostic[]): void {
  for (const key of UNSUPPORTED_COMPONENT_KEYS) {
    if (key in loaded.manifest) {
      diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
}

async function resolveSkillRoots(
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): Promise<SkillRoot[]> {
  await warnEmptyDeclaredSkillRoots(input);
  return await resolveComponentRoots("skills", input, priority);
}

async function resolveCommandRoots(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): Promise<CustomCommandRoot[]> {
  const roots = await resolveComponentRoots<CustomCommandRoot>(
    "commands",
    input,
    priority,
    createHookPluginContext(input.loaded, input.dataPath),
  );
  const generatedRoot = await materializeCommandMetadataRoot(input, priority + 1);
  if (generatedRoot) roots.push(generatedRoot);
  return roots;
}

async function inspectPluginHooks(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  runnable: boolean;
}): Promise<PluginHookInspection> {
  const inspection = emptyHookInspection();
  for (const source of await listPluginHookSources({
    diagnostics: input.diagnostics,
    loaded: input.loaded,
  })) {
    const loaded = parsePluginHookEvents({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      pluginDataPath: input.dataPath,
      rawHooks: source.rawHooks,
      runnable: input.runnable,
      sourcePath: source.sourcePath,
      wrapper: source.wrapper,
    });
    mergeHookInspection(inspection, loaded);
  }

  return inspection;
}

function parsePluginHookEvents(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  pluginDataPath: string;
  rawHooks: unknown;
  runnable: boolean;
  sourcePath: string;
  wrapper: boolean;
}): PluginHookInspection {
  const hooksRoot = input.wrapper
    ? isRecord(input.rawHooks)
      ? input.rawHooks.hooks
      : undefined
    : input.rawHooks;
  const inspection = emptyHookInspection();
  if (!isRecord(hooksRoot)) {
    input.diagnostics.push({
      code: "plugin_hook_invalid",
      message: input.wrapper
        ? "Plugin hooks file must contain a hooks object"
        : "Plugin manifest hooks entry must be an object, a path, or an array",
      path: input.sourcePath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return inspection;
  }

  const plugin = createHookPluginContext(input.loaded, input.pluginDataPath, input.sourcePath);
  for (const [eventName, matcherConfigs] of Object.entries(hooksRoot)) {
    if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
      input.diagnostics.push({
        code: "plugin_hook_unsupported_event",
        message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    if (!Array.isArray(matcherConfigs)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: `Plugin hook event must be an array: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const event = eventName as HookEventName;
    for (const matcherConfig of matcherConfigs) {
      const validation = HookMatcherConfigSchema.safeParse(matcherConfig);
      if (!validation.success) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Invalid plugin hook matcher for ${eventName}: ${validation.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          path: input.sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      const withPlugin: HookMatcherConfig = {
        ...validation.data,
        hooks: validation.data.hooks.map((hook) => attachPluginToHook(hook, plugin)),
      };
      (inspection.events[event] ??= []).push(withPlugin);
      for (const hook of validation.data.hooks) {
        inspection.details.push(
          toPluginHookDetail({
            event,
            hook,
            ...(validation.data.matcher !== undefined ? { matcher: validation.data.matcher } : {}),
            runnable: input.runnable,
            sourcePath: input.sourcePath,
          }),
        );
      }
    }
  }

  return inspection;
}

function toPluginHookDetail(input: {
  event: HookEventName;
  hook: HookConfig;
  matcher?: string;
  runnable: boolean;
  sourcePath: string;
}): PluginHookDetail {
  const detail: PluginHookDetail = {
    command: input.hook.command,
    event: input.event,
    runnable: input.runnable,
    sourcePath: input.sourcePath,
    type: input.hook.type,
  };
  if (input.matcher !== undefined) detail.matcher = input.matcher;
  if (input.hook.statusMessage !== undefined) detail.statusMessage = input.hook.statusMessage;
  if (input.hook.timeoutMs !== undefined) detail.timeoutMs = input.hook.timeoutMs;
  if (input.hook.type === "process") {
    if (input.hook.args !== undefined) detail.args = input.hook.args;
    return detail;
  }
  if (input.hook.async !== undefined) detail.async = input.hook.async;
  if (input.hook.shell !== undefined) detail.shell = input.hook.shell;
  if (input.hook.timeout !== undefined) detail.timeout = input.hook.timeout;
  return detail;
}

function attachPluginToHook(hook: HookConfig, plugin: HookPluginContext): HookConfig {
  return {
    ...hook,
    plugin,
  };
}

function mergeHookEvents(
  target: Partial<Record<HookEventName, HookMatcherConfig[]>>,
  source: Partial<Record<HookEventName, HookMatcherConfig[]>>,
): void {
  for (const [eventName, matchers] of Object.entries(source) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length > 0) {
      (target[eventName] ??= []).push(...matchers);
    }
  }
}

function mergeHookInspection(target: PluginHookInspection, source: PluginHookInspection): void {
  mergeHookEvents(target.events, source.events);
  target.details.push(...source.details);
}

function emptyHookInspection(): PluginHookInspection {
  return {
    details: [],
    events: {},
  };
}

async function resolveComponentRoots<T extends CustomCommandRoot | SkillRoot>(
  key: "commands" | "skills",
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
  plugin?: HookPluginContext,
): Promise<T[]> {
  const paths = parsePathList(input.loaded.manifest[key]);
  const defaultPath = join(input.loaded.rootPath, key);
  // skills 的显式声明是完整入口清单，不能再补扫未声明的默认目录。
  if (
    (key !== "skills" || input.loaded.manifest.skills === undefined) &&
    (await (input.loaded.materials?.directoryExists(defaultPath) ??
      directoryExistsAsync(defaultPath)))
  ) {
    paths.unshift(key);
  }
  const roots: T[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of paths) {
    const path = resolveInside(input.loaded.rootPath, rawPath);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin ${key} path escapes plugin root: ${rawPath}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    roots.push({
      path,
      ...(plugin ? { plugin } : {}),
      ...(key === "skills" ? { pluginId: input.loaded.id } : {}),
      priority,
      scope: input.loaded.source === "official" ? "system" : "user",
      source: "plugin",
    } as T);
  }
  return roots;
}

async function scanOfficialCache(
  storageRoot: string,
  diagnostics: PluginDiagnostic[],
  materials: PluginMaterialReader,
  options?: PluginAbortOptions,
): Promise<string[]> {
  // 官方插件升级会保留旧版本缓存目录；若遍历全部目录再按插件 id
  // “先到先得”，旧版本会抢在 bundled marketplace 指向的当前版本前被加载。
  // bundled 分片是当前随应用发布资产的权威清单；存在时只加载其 cachePath。
  // 不能简单选择最高 semver，否则官方回滚版本时仍会错误加载旧缓存。
  try {
    await materials.observe(
      join(
        storageRoot,
        "marketplaces",
        ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        "bundled-marketplace.json",
      ),
    );
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
  }
  const bundledRoots = await loadBundledOfficialPluginRoots(storageRoot);
  if (bundledRoots !== undefined) {
    throwIfAborted(options);
    return bundledRoots;
  }

  const cacheRoot = join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  try {
    const roots: string[] = [];
    for (const pluginEntry of await materials.directory(cacheRoot)) {
      throwIfAborted(options);
      if (!pluginEntry.isDirectory()) continue;
      const pluginDir = join(cacheRoot, pluginEntry.name);
      for (const versionEntry of await materials.directory(pluginDir)) {
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
    }
    return roots;
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
    if (isNotFoundError(error)) return [];
    diagnostics.push({
      code: "plugin_root_not_found",
      message: error instanceof Error ? error.message : `Failed to scan ${cacheRoot}`,
      path: cacheRoot,
      severity: "warning",
    });
    return [];
  }
}

async function loadPlugin(
  candidate: PluginCandidate,
  diagnostics: PluginDiagnostic[],
  materials: PluginMaterialReader,
): Promise<LoadedPlugin | null> {
  if (!(await materials.directoryExists(candidate.rootPath))) {
    diagnostics.push({
      code: "plugin_root_not_found",
      message: `Plugin root does not exist: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "warning",
    });
    return null;
  }

  try {
    await materials.directory(candidate.rootPath);
  } catch (error) {
    // 列目录只是减少缺失入口探测；无枚举权限时仍允许按已知路径读取 manifest。
    rethrowPluginMaterialInterrupt(error);
  }
  const manifestPath = await findManifest(candidate.rootPath, materials);
  if (!manifestPath) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "error",
    });
    return null;
  }

  const manifest = await readManifest(manifestPath, diagnostics, materials, candidate.marketplace);
  if (!manifest) return null;
  return {
    id: `${manifest.name}@${candidate.marketplace}`,
    manifest,
    manifestPath,
    materials,
    marketplace: candidate.marketplace,
    rootPath: candidate.rootPath,
    source: candidate.source,
  };
}

async function findManifest(
  rootPath: string,
  materials: PluginMaterialReader,
): Promise<string | null> {
  const zcodePath = join(rootPath, ZCODE_MANIFEST_PATH);
  if (await materials.fileExists(zcodePath)) {
    return zcodePath;
  }

  // 兼容不同 manifest 目录约定，发现阶段按稳定优先级回退。
  const claudePath = join(rootPath, CLAUDE_MANIFEST_PATH);
  if (await materials.fileExists(claudePath)) {
    return claudePath;
  }
  const codexPath = join(rootPath, CODEX_MANIFEST_PATH);
  return (await materials.fileExists(codexPath)) ? codexPath : null;
}

async function readManifest(
  path: string,
  diagnostics: PluginDiagnostic[],
  materials: PluginMaterialReader,
  marketplace: string,
): Promise<PluginManifest | null> {
  let pluginId: string | undefined;
  try {
    const parsed = await materials.json(path);
    if (!isRecord(parsed)) throw new Error("Manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    pluginId = `${name}@${marketplace}`;
    return {
      ...parsed,
      name,
      version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
      ...(parsed.userConfig !== undefined
        ? { userConfig: pluginUserConfigSchema.parse(parsed.userConfig) }
        : {}),
    } as PluginManifest;
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
    diagnostics.push({
      code: "plugin_manifest_invalid",
      ...(pluginId ? { pluginId } : {}),
      message: error instanceof Error ? error.message : `Invalid plugin manifest: ${path}`,
      path,
      severity: "error",
    });
    return null;
  }
}

function emptyOutcome(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

function emptyComponents(hookDetails: PluginHookDetail[] = []): PluginComponents {
  return {
    commandRoots: [],
    hooks: {},
    hookDetails,
    mcpServers: {},
    skillCount: 0,
    skillRoots: [],
  };
}

function resolveEnabled(config: PluginConfig, id: string, defaultEnabled: boolean): boolean {
  return config.enabledPlugins[id] ?? defaultEnabled;
}

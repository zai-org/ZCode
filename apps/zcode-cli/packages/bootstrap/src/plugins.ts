import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  addSuppressedBuiltinInFileConfig,
  createConfig,
  createConfigWithPluginMigrations,
  resolvePath,
  enablePluginsByDefaultInFileConfig,
  normalizePluginConfigPathForComparison,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  type ConfigResult,
} from "@zcode/adapters/config";
import {
  addMarketplace,
  comparePluginUpdate,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  discoverNodePlugins,
  ensureMarketplaceManifestAvailable,
  getPluginSourceDiagnosticCode,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  parseMarketplaceSourceInput,
  parseEntryExtensionSummary,
  parseEntryStoreListing,
  readPluginSourceIdentityPin,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateLocalPluginPath,
  validateMarketplacePlugin,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginExtensionSummary,
  type PluginMarketplaceEntry,
} from "@zcode/adapters/plugins";
import type {
  Logger,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginMetadata,
  PluginStoreListing,
  PluginPort,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, isOfficialMarketplaceId } from "@zcode/contracts";
import {
  DEFAULT_PLUGIN_MARKETPLACES,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  isZCodeCuaInternalFeatureEnabled,
} from "@zcode/shared";
import {
  resolveOfficialPluginRoots,
  type OfficialPluginPreparation,
} from "./app/bundled-plugins.js";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "./app/official-plugin-definitions.js";
import { getCliStorageRoot, getPluginStorageRoot } from "./app/paths.js";
import { type PluginStorageLock, withPluginStorageLock } from "./lib/plugin-storage-lock.js";
import {
  removeStoredPluginSecrets,
  resolvePluginSecretsPath,
  savePluginOptions,
  withPluginSecrets,
} from "./plugin-secrets.js";

export interface ResolveZCodePluginsOptions {
  pluginStorageLock?: PluginStorageLock;
  abortSignal?: AbortSignal;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  pluginPreparation?: OfficialPluginPreparation;
  pluginDiscovery?: PluginPort;
  configResult?: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
}

/** 所有写入入口（包括独立 CLI）共用此边界。组合操作显式传递当次锁，避免递归等待。 */
function pluginMutation<O extends ResolveZCodePluginsOptions, T>(
  operation: (options: O) => Promise<T>,
): (options: O) => Promise<T> {
  return async (options) => {
    const root =
      options.pluginStorageRoot ?? (await resolvePluginContext(options)).pluginStorageRoot;
    return withPluginStorageLock(
      root,
      (lock) =>
        operation({
          ...options,
          pluginStorageRoot: lock.root,
          pluginStorageLock: lock,
        }),
      options.pluginStorageLock,
      options.abortSignal ?? options.pluginPreparation?.signal,
    );
  };
}

export interface ListZCodePluginsOptions extends ResolveZCodePluginsOptions {}

export interface SetZCodePluginEnabledOptions extends ResolveZCodePluginsOptions {
  enabled: boolean;
  plugin: string;
  scope?: "user" | "workspace";
}

export interface SetZCodePluginEnabledResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodeMarketplaceSummaryData {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial: boolean;
  refreshFailure?: {
    code: string;
    failedAt: string;
    message: string;
  };
  // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区），随 manifest 下发。
  featured?: string[];
}

export interface ZCodeAvailablePluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  // 商店信息（显示名/icon/分类/作者/链接/hero/示例提示词），来自目录条目。
  listing?: PluginStoreListing;
  // 目录条目的扩展摘要（plugin-publishing.md §4.2）。协议层按请求参数决定是否放进 listing（§4.3）。
  extensionSummary?: PluginExtensionSummary;
}

export interface ZCodeInstalledPluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "user" | "workspace";
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  // 已安装插件的商店信息由目录条目按 id join 得到（市场被移除时缺失，UI 走降级）。
  listing?: PluginStoreListing;
  // 目录里最新版条目的扩展摘要（不是已装版本的）；App 据此判断最新版能不能装。
  extensionSummary?: PluginExtensionSummary;
}

export interface ZCodePluginsOverviewData {
  marketplaces: ZCodeMarketplaceSummaryData[];
  availablePlugins: ZCodeAvailablePluginData[];
  installedPlugins: ZCodeInstalledPluginData[];
  restorableBuiltins: ZCodeAvailablePluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

export interface ZCodeMarketplaceUpdateData {
  diagnostics: PluginLoadOutcome["diagnostics"];
  marketplaces: ZCodeMarketplaceSummaryData[];
}

export interface AddZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  dryRun?: boolean;
  source: string;
  /** `marketplace add --sparse`：仅 git/github 源支持 sparse checkout 子目录。 */
  sparsePaths?: string[];
}

export interface RemoveZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
}

export interface UpdateZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  marketplace?: string;
}

export interface InstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  dryRun?: boolean;
  marketplace: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface UninstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  pluginId?: string;
  pluginName?: string;
  marketplace?: string;
  removeCache?: boolean;
  /** 保留 data/<plugin-id> 用户数据目录（`zcode plugins uninstall --keep-data`）。 */
  keepData?: boolean;
}

export interface UpdateZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
}

export interface ValidateZCodePluginPathOptions extends ResolveZCodePluginsOptions {
  path: string;
}

export interface ZCodePluginUpdateData extends ZCodePluginInstallData {
  previousVersion: string;
}

export interface RestoreBuiltinPluginOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
}

export interface ConfigureZCodePluginOptions extends ResolveZCodePluginsOptions {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ResetZCodePluginConfigOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ValidateZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface DescribeZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
  pluginName: string;
}

export interface ZCodePluginInstallData {
  dependencyClosure: string[];
  installedPlugins: ZCodeInstalledPluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

/**
 * 市场插件计数只数用户可见条目。
 *
 * node-repl-host 是 Browser Use 与 Computer Use 共用的运行时宿主：它必须留在官方 manifest 里
 * （否则不会被发现、安装、启用），但没有 skill、没有 listing，也不该出现在设置页。计进去会让
 * 显示的插件数比它能列出的条目多一个。
 *
 * 判据故意是「官方市场里的这个具名条目」，而不是「没有 listing 的条目」—— 后者会误伤第三方
 * 市场：自定义 manifest 里的条目本来就可以不带 listing，它们是真实可见的插件。
 */
function countVisibleMarketplacePlugins(
  marketplaceId: string,
  plugins: readonly { name: string }[] | undefined,
): number | undefined {
  if (!plugins) return undefined;
  if (marketplaceId !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return plugins.length;
  return plugins.filter((entry) => entry.name !== OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME).length;
}

export async function resolveZCodePlugins(
  options: ResolveZCodePluginsOptions = {},
): Promise<PluginLoadOutcome> {
  const resolve = async (): Promise<PluginLoadOutcome> => {
    options.pluginPreparation?.signal.throwIfAborted();
    const context = await resolvePluginContext(options);
    const { pluginStorageRoot, workingDirectory } = context;
    // 敏感选项在私有文件里；按层叠加后再交给发现，运行时展开与投影读到的是同一份有效值。
    const secrets = await withPluginSecrets(
      context.configResult,
      context.pluginSecretsPath,
      options.logger,
    );
    const configResult = secrets.configResult;

    const outcome = await (
      options.pluginDiscovery
        ? options.pluginDiscovery.discoverPlugins.bind(options.pluginDiscovery)
        : discoverNodePlugins
    )(
      {
        workspaceIdentity: options.workspaceIdentity,
        remoteSessionId: options.remoteSessionId,
        config: configResult.config.plugins,
        env: options.env ?? process.env,
        officialPluginRoots: await resolveOfficialPluginRoots({
          preparation: options.pluginPreparation,
          extraRoots: options.officialPluginRoots,
          // cache 锁冲突已从 fatal 改为 degraded，普通插件入口也必须保留诊断日志。
          logger: options.logger,
          storageRoot: pluginStorageRoot,
          suppressedBuiltins: new Set(configResult.config.plugins.suppressedBuiltins),
        }),
        officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
        storageRoot: pluginStorageRoot,
        workingDirectory,
      },
      { signal: options.pluginPreparation?.signal },
    );
    return secrets.diagnostics.length > 0
      ? { ...outcome, diagnostics: [...outcome.diagnostics, ...secrets.diagnostics] }
      : outcome;
  };
  return options.pluginPreparation
    ? await options.pluginPreparation.resolvePlugins(resolve)
    : await resolve();
}

/**
 * 叠加敏感选项私有文件后的配置视图，给协议投影读 `optionSources` 用。
 * resolveZCodePlugins 内部会对同一视图再叠加一次；叠加只读原始配置层，结果不变。
 */
export async function resolveZCodePluginConfigWithSecrets(
  options: ResolveZCodePluginsOptions,
): Promise<ConfigResult> {
  const { configResult, pluginSecretsPath } = await resolvePluginContext(options);
  return (await withPluginSecrets(configResult, pluginSecretsPath)).configResult;
}

export async function getZCodePluginsOverview(
  options: ResolveZCodePluginsOptions = {},
): Promise<ZCodePluginsOverviewData> {
  const { configResult, pluginStorageRoot, workingDirectory } = await resolvePluginContext(options);
  const knownIds = new Set(loadKnownMarketplacesSync(pluginStorageRoot).map(({ id }) => id));
  if (DEFAULT_PLUGIN_MARKETPLACES.some(({ id }) => !knownIds.has(id))) {
    // 只有首次登记缺失的默认市场才写入，锁内重读；已有目录的普通浏览无需等下载。
    await withPluginStorageLock(
      pluginStorageRoot,
      async () => ensureDefaultPluginMarketplaces(pluginStorageRoot),
      options.pluginStorageLock,
      options.abortSignal ?? options.pluginPreparation?.signal,
    );
  }
  const outcome = await resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const effectiveMarketplaces = resolveEffectiveMarketplaceRecords({
    configResult,
    known,
    workingDirectory,
  });
  const marketplaceDeclarationDiagnostics = resolveMarketplaceDeclarationDiagnostics({
    configResult,
    known,
    workingDirectory,
  });
  const installed = listInstalledPluginRecords(pluginStorageRoot);
  const installedIds = new Set(installed.map((record) => record.id));

  // 每个市场的 manifest 只读一次：同时取 entries（目录条目）与 featured（策展名单）。
  // zcode-plugins-official 的内置与 CDN 分片已在 adapter 层合并为唯一 canonical manifest。
  const catalogs: Array<{
    summary: ZCodeMarketplaceSummaryData;
    entries: PluginMarketplaceEntry[];
  }> = [];
  for (const { record, useCachedManifest } of effectiveMarketplaces) {
    // Marketplace source 只来自 User/Host 配置。只有目标 Host 已经通过显式 refresh/install
    // 物化了同一 source 时，才读取 Host cache；同 id 不同 source 必须 fail closed，避免
    // 不同 Host 或旧配置误用错误的全局 marketplace 快照。
    const manifest = useCachedManifest
      ? loadMarketplaceManifestSync(pluginStorageRoot, record.id)
      : null;
    catalogs.push({
      summary: toMarketplaceSummaryData(
        record,
        manifest?.featured,
        countVisibleMarketplacePlugins(record.id, manifest?.plugins),
      ),
      entries: manifest?.plugins ?? [],
    });
  }

  // 边遍历 marketplace catalog 边记录每个插件 id 的最新「版本 pin」用于更新检测。

  // 条目可能只有 version、只有 sha 或两者兼有，因此同时收集 version 与 sha
  // 两个轴，由 comparePluginUpdate 决定用哪条轴比对 installed 记录。
  const latestPinByPluginId = new Map<string, { version?: string; sha?: string }>();
  // 同时按 id 收集目录条目的商店信息，供已安装插件 join（详情/图标条/管理视图共用）。
  const listingByPluginId = new Map<string, PluginStoreListing>();
  const extensionSummaryByPluginId = new Map<string, PluginExtensionSummary>();
  const availablePlugins = catalogs.flatMap((catalog) =>
    catalog.entries.map((entry) => {
      const data = toAvailablePluginData(entry, catalog.summary.id, installedIds);
      latestPinByPluginId.set(data.id, {
        ...(entry.version ? { version: entry.version } : {}),
        ...(readPluginSourceIdentityPin(entry.source)
          ? { sha: readPluginSourceIdentityPin(entry.source) }
          : {}),
      });
      if (entry.listing) listingByPluginId.set(data.id, entry.listing);
      if (data.extensionSummary) extensionSummaryByPluginId.set(data.id, data.extensionSummary);
      return data;
    }),
  );
  const loadedById = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));

  // 被抑制（uninstall）的内置（官方）插件可一键恢复：从 OFFICIAL_PLUGIN_DEFINITIONS
  // 里挑出 id 落在 suppressedBuiltins 集合内的，映射成 available 形态供 UI 的「恢复」入口使用。
  // 完整 Catalog/cache 仍然保留，restorable 只是 Runtime 抑制态的投影，商店信息直接取定义里的 listing seed。
  const suppressed = new Set(configResult.config.plugins.suppressedBuiltins);
  const restorableBuiltins: ZCodeAvailablePluginData[] = OFFICIAL_PLUGIN_DEFINITIONS.filter(
    (def) =>
      suppressed.has(`${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`) &&
      // computer-use 的恢复入口需要 internal 特性开启（与 restoreBuiltinPluginCore 同口径）。
      (def.name !== "computer-use" || isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)),
  ).map((def) => {
    const listing = def.listing
      ? parseEntryStoreListing({ name: def.name, ...def.listing })
      : undefined;
    return {
      id: `${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      name: def.name,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      version: def.version,
      installed: false,
      // Bugfix：可恢复条目只带 listing 时丢了 "ui"，卸载后的文档插件从「UI 插件」掉进分类分组。
      ...(def.componentTypes ? { componentTypes: [...def.componentTypes] } : {}),
      ...(listing ? { listing } : {}),
    };
  });

  return {
    marketplaces: catalogs.map((catalog) => catalog.summary),
    availablePlugins,
    installedPlugins: installed.map((record) => {
      const enabled = configResult.config.plugins.enabledPlugins[record.id] ?? false;
      const data = toInstalledPluginData(record, enabled, loadedById.get(record.id));
      const pin = latestPinByPluginId.get(record.id);
      const installedSha = readPluginSourceIdentityPin(record.source);
      const updateStatus = comparePluginUpdate({
        installedVersion: data.version,
        installedSha,
        latestVersion: pin?.version,
        latestSha: pin?.sha,
      });
      // latestVersion 展示：优先用 manifest 的 version；否则用最新 sha（短 7 位）让 UI 有可读提示。
      const latestLabel = pin?.version ?? (pin?.sha ? pin.sha.slice(0, 7) : undefined);
      const listing = listingByPluginId.get(record.id);
      const extensionSummary = extensionSummaryByPluginId.get(record.id);
      return {
        ...data,
        updateStatus,
        ...(latestLabel ? { latestVersion: latestLabel } : {}),
        ...(listing ? { listing } : {}),
        ...(extensionSummary ? { extensionSummary } : {}),
      };
    }),
    restorableBuiltins,
    diagnostics: [
      ...outcome.diagnostics,
      ...marketplaceDeclarationDiagnostics,
      ...known.flatMap((record): PluginLoadOutcome["diagnostics"] =>
        record.lastRefreshFailure
          ? [
              {
                code: record.lastRefreshFailure.code,
                message: record.lastRefreshFailure.message,
                pluginId: record.id,
                severity: "error",
              },
            ]
          : [],
      ),
    ],
  };
}

export function enrichCachedClaudeMarketplaceIconsForOverview(
  options: ResolveZCodePluginsOptions = {},
): void {
  const configResult = options.configResult ?? createConfig(options);
  const pluginStorageRoot =
    options.pluginStorageRoot ??
    getPluginStorageRoot(getCliStorageRoot(resolvePath(configResult.config.storage.dir)));
  // 图标是可选展示增强：overview 不等待网络；仅写回阶段进入 storage lock。
  void enrichCachedClaudeMarketplaceIcons(pluginStorageRoot, (write) =>
    withPluginStorageLock(pluginStorageRoot, write),
  );
}

export async function listZCodePlugins(
  options: ListZCodePluginsOptions = {},
): Promise<PluginLoadOutcome> {
  const outcome = await resolveZCodePlugins(options);
  const { pluginStorageRoot } = await resolvePluginContext(options);
  return {
    ...outcome,
    // 用户可见名称必须从 marketplace listing 解析；这里按完整 id 传递给 CLI，
    // 不把展示元数据混入 adapter 的运行时 PluginMetadata，也不按裸 name 猜测。
    pluginListingsById: loadPluginListingsById(pluginStorageRoot),
  };
}

function loadPluginListingsById(storageRoot: string): Record<string, PluginStoreListing> {
  const listings = new Map<string, PluginStoreListing>();

  // 没有 marketplace 快照时，bundled official definition 仍是内置插件 listing 的安全回退。
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (!definition.listing) continue;
    const listing = parseEntryStoreListing({ name: definition.name, ...definition.listing });
    if (listing) {
      listings.set(`${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`, listing);
    }
  }

  // 目录条目按完整 `${name}@${marketplace}` 关联；同名插件不会互相覆盖。
  for (const marketplace of loadKnownMarketplacesSync(storageRoot)) {
    const manifest = loadMarketplaceManifestSync(storageRoot, marketplace.id);
    for (const entry of manifest?.plugins ?? []) {
      if (entry.listing) listings.set(`${entry.name}@${marketplace.id}`, entry.listing);
    }
  }

  return Object.fromEntries(listings);
}

export const setZCodePluginEnabled = pluginMutation(setZCodePluginEnabledLocked);
async function setZCodePluginEnabledLocked(
  options: SetZCodePluginEnabledOptions,
): Promise<SetZCodePluginEnabledResult> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    (await createConfigWithPluginMigrations({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    }));
  const outcome = await resolveZCodePlugins({
    ...options,
    configResult,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.plugin, outcome.plugins);
  const patch = await updatePluginEnabledInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    options.enabled,
  );

  return {
    enabled: patch.enabled,
    path: patch.path,
    plugin: {
      ...plugin,
      enabled: patch.enabled,
    },
  };
}

export const addZCodePluginMarketplace = pluginMutation(addZCodePluginMarketplaceLocked);
async function addZCodePluginMarketplaceLocked(
  options: AddZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceSummaryData> {
  const { pluginStorageRoot } = await resolvePluginContext(options);
  const source = applySparsePaths(
    await parseMarketplaceSourceInput(options.source),
    options.sparsePaths,
  );
  if (options.dryRun === true) {
    return {
      id: "dry-run",
      name: "dry-run",
      source: source as unknown as Record<string, unknown>,
      pluginCount: 0,
      isOfficial: false,
    };
  }
  const record = await addMarketplace({
    signal: options.abortSignal,
    source,
    storageRoot: pluginStorageRoot,
  });
  return toMarketplaceSummaryData(record);
}

export const removeZCodePluginMarketplace = pluginMutation(removeZCodePluginMarketplaceLocked);
async function removeZCodePluginMarketplaceLocked(
  options: RemoveZCodeMarketplaceOptions,
): Promise<void> {
  const { pluginStorageRoot } = await resolvePluginContext(options);
  await removeMarketplace({
    marketplace: options.marketplace,
    storageRoot: pluginStorageRoot,
  });
}

const updateMarketplaceWithLock = pluginMutation(updateZCodePluginMarketplaceLocked);
export async function updateZCodePluginMarketplace(
  options: UpdateZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceUpdateData> {
  try {
    return await updateMarketplaceWithLock(options);
  } catch (error) {
    // 刷新接口以 diagnostics 返回取消；锁的准入检查可能先于市场初始化，不能因此改成抛错或写入默认目录。
    if (!options.abortSignal?.aborted || options.abortSignal.reason !== error) throw error;
    return {
      marketplaces: [],
      diagnostics: [toMarketplaceRefreshDiagnostic(error, options.marketplace)],
    };
  }
}
async function updateZCodePluginMarketplaceLocked(
  options: UpdateZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceUpdateData> {
  const { configResult, pluginStorageRoot, workingDirectory } = await resolvePluginContext(options);
  await ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const declared = resolveDeclaredMarketplaceSources({
    configResult,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const knownById = new Map(known.map((record) => [record.id, record]));
  const targetIds = resolveMarketplaceRefreshTargetIds({
    declaredIds: declared.keys(),
    knownIds: knownById.keys(),
    marketplace: options.marketplace,
  });
  if (
    options.marketplace &&
    !knownById.has(options.marketplace) &&
    !declared.has(options.marketplace)
  ) {
    throw new Error(`Marketplace not found: ${options.marketplace}`);
  }

  const updated: KnownMarketplaceRecord[] = [];
  const declarationDiagnostics: PluginLoadOutcome["diagnostics"] = [];
  for (const marketplaceId of targetIds) {
    const declarationSource = declared.get(marketplaceId);
    const knownRecord = knownById.get(marketplaceId);
    if (
      options.marketplace &&
      declarationSource &&
      knownRecord &&
      !isDeepStrictEqual(knownRecord.source, declarationSource)
    ) {
      declarationDiagnostics.push(createMarketplaceSourceRepointDiagnostic(marketplaceId));
      continue;
    }
    if (declarationSource && !knownRecord) {
      try {
        updated.push(
          await addMarketplace({
            expectedId: marketplaceId,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          }),
        );
      } catch (error) {
        declarationDiagnostics.push(toMarketplaceRefreshDiagnostic(error, marketplaceId));
      }
      continue;
    }
    updated.push(
      ...(await updateMarketplace({
        marketplace: marketplaceId,
        signal: options.abortSignal,
        storageRoot: pluginStorageRoot,
      })),
    );
  }

  // map 回调只吃第一个参数：toMarketplaceSummaryData 的第二参是 featured，不能接 map 的 index。
  const records = loadKnownMarketplacesSync(pluginStorageRoot);
  const selectedFailures = records.flatMap((record): PluginLoadOutcome["diagnostics"] => {
    if (options.marketplace && record.id !== options.marketplace) return [];
    if (!record.lastRefreshFailure) return [];
    return [
      {
        code: record.lastRefreshFailure.code,
        message: record.lastRefreshFailure.message,
        pluginId: record.id,
        severity: "error",
      },
    ];
  });
  return {
    marketplaces: updated.map((record) => toMarketplaceSummaryData(record)),
    diagnostics: [...declarationDiagnostics, ...selectedFailures],
  };
}

export const installZCodeMarketplacePlugin = pluginMutation(installZCodeMarketplacePluginLocked);
async function installZCodeMarketplacePluginLocked(
  options: InstallZCodeMarketplacePluginOptions,
): Promise<ZCodePluginInstallData> {
  const { configResult, pluginStorageRoot, workingDirectory } = await resolvePluginContext(options);
  await ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.dryRun === true) {
    const declarationSource = resolveDeclaredMarketplaceSources({
      configResult,
    }).get(options.marketplace);
    const known = loadKnownMarketplacesSync(pluginStorageRoot).find(
      (record) => record.id === options.marketplace,
    );
    if (declarationSource && known && !isDeepStrictEqual(known.source, declarationSource)) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [createMarketplaceSourceRepointDiagnostic(options.marketplace)],
      };
    }
    if (
      declarationSource &&
      (!known || !loadMarketplaceManifestSync(pluginStorageRoot, options.marketplace))
    ) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: (
          await validateMarketplaceSource({
            expectedId: options.marketplace,
            pluginName: options.pluginName,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          })
        ).map(toPluginDiagnostic),
      };
    }
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: (
        await validateMarketplacePlugin({
          marketplace: options.marketplace,
          name: options.pluginName,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic),
    };
  }
  const pluginId = `${options.pluginName}@${options.marketplace}`;
  const bundledEntry = loadMarketplaceManifestSync(
    pluginStorageRoot,
    options.marketplace,
  )?.plugins.find((entry) => entry.name === options.pluginName);
  const isSuppressedBundledOfficial =
    options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
    configResult.config.plugins.suppressedBuiltins.includes(pluginId) &&
    (bundledEntry?.source === "filesystem" || bundledEntry?.source === "sea");
  if (isSuppressedBundledOfficial) {
    // 内置插件的 filesystem/SEA entry 只是 Catalog 指针，不是普通 Marketplace source。
    // 直接安装必须复用 restore，避免把同一份官方 cache 写进 installed_plugins.json，
    // 否则卸载/更新会把内置资产误判成用户安装并破坏恢复语义。
    // 安装与恢复属于同一次持锁操作；复用核心，不重复获取文件锁。
    await restoreBuiltinPluginCore({ ...options, configResult, pluginId });
    const fresh = await resolvePluginContext({ ...options, configResult: undefined });
    const outcome = await resolveZCodePlugins({
      ...options,
      configResult: fresh.configResult,
      pluginStorageRoot: fresh.pluginStorageRoot,
    });
    const restored = outcome.plugins.find((plugin) => plugin.id === pluginId);
    if (!restored) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [
          toPluginDiagnostic({
            code: "plugin_not_found",
            message: `Bundled plugin could not be restored: ${pluginId}`,
            pluginId,
            severity: "error",
          }),
        ],
      };
    }
    const now = new Date().toISOString();
    return {
      dependencyClosure: [pluginId],
      installedPlugins: [
        toInstalledPluginData(
          {
            id: restored.id,
            name: restored.name,
            marketplace: restored.marketplace,
            version: restored.version ?? "",
            installPath: restored.rootPath,
            installedAt: now,
            updatedAt: now,
            scope: "user",
          },
          restored.enabled,
          restored,
        ),
      ],
      diagnostics: [],
    };
  }
  let installed: Awaited<ReturnType<typeof installMarketplacePlugin>>;
  try {
    await materializeDeclaredMarketplaceForExplicitAction({
      configResult,
      marketplaceId: options.marketplace,
      pluginStorageRoot,
      abortSignal: options.abortSignal,
      workingDirectory,
    });
    installed = await installMarketplacePlugin({
      signal: options.abortSignal,
      marketplace: options.marketplace,
      name: options.pluginName,
      // package/cache/installed record 是目标 Host 的 User inventory；
      // 旧协议的 Workspace scope 仅为兼容保留，不能改变 Marketplace 默认启用写入 User config
      // 的语义。installed record 没有 workspace identity，不能让它参与 Workspace 配置归属。
      scope: "user",
      storageRoot: pluginStorageRoot,
    });
  } catch (error) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: [
        toMarketplaceInstallDiagnostic(error, `${options.pluginName}@${options.marketplace}`),
      ],
    };
  }
  if (options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    // 官方 marketplace 复用内置插件的 id 空间。若同名 CDN 插件重新安装，
    // 清掉历史内置 suppression，否则 Runtime 仍会把已拥有的安装误判为 suppressed。
    for (const record of installed.installed) {
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, record.id);
    }
  }
  // Marketplace 只管理 Host User inventory；即使旧协议调用方传入 workspace scope，
  // 安装即默认启用也必须写入 User config，不能把 Marketplace 动作变成 Workspace override。
  // 仅作用于用户配置里尚未显式声明的 id（停用后重装等显式选择不被覆盖）。
  const { enabledIds } = await enablePluginsByDefaultInFileConfig(
    configResult.sources.user.path,
    installed.installed.map((record) => record.id),
  );
  const enabledIdSet = new Set(enabledIds);
  // 已有显式配置的，沿用其当前启用态；本次新置默认启用的标记为 true。
  const enabledById = (id: string): boolean =>
    enabledIdSet.has(id) || (configResult.config.plugins.enabledPlugins[id] ?? false);
  return {
    dependencyClosure: installed.closure,
    installedPlugins: installed.installed.map((record) =>
      toInstalledPluginData(record, enabledById(record.id)),
    ),
    diagnostics: [],
  };
}

export const uninstallZCodeMarketplacePlugin = pluginMutation(
  async (
    options: UninstallZCodeMarketplacePluginOptions,
  ): Promise<ZCodeInstalledPluginData | null> => {
    const { configResult, pluginSecretsPath, pluginStorageRoot, workingDirectory } =
      await resolvePluginContext(options);
    const pluginId = resolvePluginIdForMutation(options);

    // 官方 CDN marketplace 与内置插件共享 zcode-plugins-official id 空间，且其缓存
    // 也位于 official cache 下。若先看 runtime source="official"，会把已有
    // installed_plugins.json 记录的 CDN 插件误判成内置插件，只写 suppression 却不删安装记录，
    // 导致 UI 永远保持 installed、无法重装。持久化安装记录是 marketplace 所有权的权威证据，
    // 必须优先于运行时来源分类；同时清掉可能遗留的错误 suppression，让状态自愈。
    const installedRecord = listInstalledPluginRecords(pluginStorageRoot).find(
      (record) => record.id === pluginId,
    );
    if (installedRecord) {
      const removed = await uninstallMarketplacePlugin({
        pluginId,
        // 卸载语义即彻底清除：除非调用方显式传 removeCache=false，否则连缓存与 data 目录一起删。
        removeCache: options.removeCache ?? true,
        keepData: options.keepData,
        storageRoot: pluginStorageRoot,
      });
      if (!removed) return null;
      await removePluginFromFileConfig(configResult.sources.user.path, removed.id);
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, removed.id);
      // 卸载是彻底清理：私有文件里 user 与全部 workspaces 的条目一起删。
      await removeStoredPluginSecrets(pluginSecretsPath, removed.id, "all");
      return toInstalledPluginData(removed, false);
    }

    // 内置（官方）插件不在 installed_plugins.json 里，无法走 marketplace 卸载路径。
    // 卸载只改变 Runtime 抑制态并清理用户数据/config；Catalog 与不可变 cache 必须保留，
    // 这样详情页仍能离线读取组件，且恢复动作不依赖重新下载或重新构造目录。
    const outcome = await resolveZCodePlugins({
      ...options,
      configResult,
      pluginStorageRoot,
      workingDirectory,
    });
    const builtin = outcome.plugins.find(
      (plugin) => plugin.id === pluginId && plugin.source === "official",
    );
    if (builtin) {
      await addSuppressedBuiltinInFileConfig(configResult.sources.user.path, pluginId);
      // 先清掉 user config 里的 enabledPlugins[id] 与 options[id]，再删目录：抑制标记已是
      // 唯一真相源（写入用原子 temp+rename），即使后续删除抛错，下次 resolve 也会跳过并补删
      // 缓存；把 config 清理放在删除之前可保证「恢复时从干净状态开始」即便删除中途失败。
      await removePluginFromFileConfig(configResult.sources.user.path, pluginId);
      await removeStoredPluginSecrets(pluginSecretsPath, pluginId, "all");
      // 不删除官方 cache：它与 Marketplace Catalog 同属详情/恢复所需的只读资产。
      if (options.keepData !== true) {
        await rm(getPluginDataDir(pluginStorageRoot, pluginId), { force: true, recursive: true });
      }
      const now = new Date().toISOString();
      return toInstalledPluginData(
        {
          id: builtin.id,
          name: builtin.name,
          marketplace: builtin.marketplace,
          version: builtin.version ?? "",
          installPath: builtin.rootPath,
          installedAt: now,
          updatedAt: now,
          scope: "user",
        },
        false,
      );
    }

    return null;
  },
);

/**
 * `zcode plugins update <plugin>`：先刷新所属 marketplace 目录，再按同一条目重装。
 * cacheMarketplacePlugin 对已存在的安装记录做原地覆盖并保留 installedAt；启用态只会给
 * 用户配置里尚未显式声明的 id 补默认值，因此更新不会改变用户已经做过的开关选择。
 */
export const updateZCodeMarketplacePlugin = pluginMutation(updateZCodeMarketplacePluginLocked);
async function updateZCodeMarketplacePluginLocked(
  options: UpdateZCodeMarketplacePluginOptions,
): Promise<ZCodePluginUpdateData> {
  const { pluginStorageRoot } = await resolvePluginContext(options);
  const record = listInstalledPluginRecords(pluginStorageRoot).find(
    (installed) => installed.id === options.pluginId,
  );
  if (!record) throw new Error(`Plugin not installed: ${options.pluginId}`);
  const refreshed = await updateZCodePluginMarketplace({
    ...options,
    marketplace: record.marketplace,
  });
  const refreshErrors = refreshed.diagnostics.filter((item) => item.severity === "error");
  if (refreshErrors.length > 0) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: refreshErrors,
      previousVersion: record.version,
    };
  }
  const installed = await installZCodeMarketplacePlugin({
    ...options,
    marketplace: record.marketplace,
    pluginName: record.name,
    scope: record.scope,
  });
  return { ...installed, previousVersion: record.version };
}

/** `zcode plugins validate <path>`：只读校验本地插件目录或 marketplace 目录。 */
export async function validateZCodePluginPath(
  options: ValidateZCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = await resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}

function applySparsePaths(
  source: MarketplaceSource,
  sparsePaths: string[] | undefined,
): MarketplaceSource {
  const paths = (sparsePaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) return source;
  if (source.source !== "git" && source.source !== "github") {
    throw new Error("--sparse only applies to git or GitHub marketplace sources");
  }
  return { ...source, sparsePaths: paths };
}

/**
 * 恢复一个被抑制（uninstall）的内置（官方）插件的无锁核心。
 *
 * 调用方可能已经持有同一 storageRoot 的 storage lock（例如协议 install handler），
 * 因此核心不能再次获取 promise-chain lock；公开入口再负责提供锁保护。
 */
async function restoreBuiltinPluginCore(options: RestoreBuiltinPluginOptions): Promise<void> {
  const zcodeCuaPluginId = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  if (
    options.pluginId === zcodeCuaPluginId &&
    !isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)
  ) {
    // overview 虽然隐藏了恢复入口，但协议调用仍可绕过 UI 写用户配置。
    // 功能开关关闭时在写盘前失败，确保用户配置与插件缓存都保持零痕迹。
    throw new Error("computer-use built-in plugin requires ZCODE_CUA_PRODUCT_HELPER to be enabled");
  }
  const { configResult, pluginStorageRoot } = await resolvePluginContext(options);
  // 准备取消或失败时不能先改变配置；seed 不按抑制态过滤，成功后再提交恢复。
  options.pluginPreparation?.signal.throwIfAborted();
  options.pluginPreparation?.invalidate();
  await resolveOfficialPluginRoots({
    preparation: options.pluginPreparation,
    storageRoot: pluginStorageRoot,
  });
  options.pluginPreparation?.signal.throwIfAborted();
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
}

export const restoreBuiltinPlugin = pluginMutation(restoreBuiltinPluginCore);

export const configureZCodePlugin = pluginMutation(configureZCodePluginLocked);
async function configureZCodePluginLocked(options: ConfigureZCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginSecretsPath, pluginStorageRoot, workingDirectory } =
    await resolvePluginContext(options);
  const outcome = await resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await savePluginOptions({
    clearOptionKeys,
    configPath: resolvePluginConfigPath(options, configResult, workingDirectory),
    options: normalizedOptions,
    plugin,
    // workspace 配置固定写 <workingDirectory>/.zcode/config.json，它的 baseDir 就是 workingDirectory。
    scope:
      options.scope === "workspace"
        ? { kind: "workspace", root: workingDirectory }
        : { kind: "user" },
    secretsPath: pluginSecretsPath,
  });
}

/** 删除指定 scope 的 Plugin 配置键，使 Workspace scope 回退到 User。 */
export const resetZCodePluginConfig = pluginMutation(resetZCodePluginConfigLocked);
async function resetZCodePluginConfigLocked(
  options: ResetZCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, pluginSecretsPath, workingDirectory } = await resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // “恢复继承”只删除 Workspace 的 enable override。options 是独立配置维度，
    // 不能因为用户恢复开关继承而把 Workspace options/secret 一并抹掉（私有文件同语义，保留）。
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
    await removeStoredPluginSecrets(pluginSecretsPath, options.pluginId, { kind: "user" });
  }
  return { path, pluginId: options.pluginId };
}

export const validateZCodePlugin = pluginMutation(validateZCodePluginLocked);
async function validateZCodePluginLocked(
  options: ValidateZCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = await resolvePluginContext(options);
  await ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

export async function describeZCodePlugin(
  options: DescribeZCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = await resolvePluginContext(options);
  // 默认市场登记由 ensureMarketplaceManifestAvailable 在写锁内完成；这里不再无锁写 known 列表。
  return await describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
    withWriteLock: (write) =>
      withPluginStorageLock(
        pluginStorageRoot,
        write,
        options.pluginStorageLock,
        options.abortSignal,
      ),
  });
}

async function resolvePluginContext(options: ResolveZCodePluginsOptions): Promise<{
  configResult: ConfigResult;
  pluginSecretsPath: string;
  pluginStorageRoot: string;
  workingDirectory: string;
}> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    (await createConfigWithPluginMigrations({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    }));
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const pluginStorageRoot =
    options.pluginStorageRoot ?? getPluginStorageRoot(getCliStorageRoot(storageRoot));
  return {
    configResult,
    pluginSecretsPath: resolvePluginSecretsPath(pluginStorageRoot),
    pluginStorageRoot,
    workingDirectory,
  };
}

function resolveDeclaredMarketplaceSources(input: {
  configResult: ConfigResult;
}): Map<string, MarketplaceSource> {
  return new Map(
    Object.entries(input.configResult.config.plugins.extraKnownMarketplaces ?? {}).map(
      ([marketplaceId, declaration]) => {
        const baseDirectory = dirname(input.configResult.sources.plugins.paths.user);
        return [marketplaceId, resolveDeclaredMarketplaceSource(declaration.source, baseDirectory)];
      },
    ),
  );
}

function resolveDeclaredMarketplaceSource(
  source: ConfigResult["config"]["plugins"]["extraKnownMarketplaces"][string]["source"],
  baseDirectory: string,
): MarketplaceSource {
  // User Marketplace 的相对路径按 User config 所在目录解析；配置读取不触碰 source，
  // 只有显式 refresh/install 才会真正读取、复制或联网。
  if (source.source === "file" || source.source === "directory") {
    return {
      ...source,
      path: isAbsolute(source.path) ? resolve(source.path) : resolve(baseDirectory, source.path),
    };
  }
  return source;
}

function resolveEffectiveMarketplaceRecords(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): Array<{ record: KnownMarketplaceRecord; useCachedManifest: boolean }> {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownIds = new Set(input.known.map((record) => record.id));
  const records = input.known.map((record) => {
    const declarationSource = declared.get(record.id);
    if (!declarationSource) return { record, useCachedManifest: true };
    if (isDeepStrictEqual(record.source, declarationSource)) {
      return { record, useCachedManifest: true };
    }
    // 官方 marketplace id 是 Host 保留身份。Workspace 声明同 id 异 source
    // 只能产生诊断，不能把官方缓存投影替换成 pluginCount=0 的空目录。
    if (isOfficialMarketplaceId(record.id)) {
      return { record, useCachedManifest: true };
    }
    return {
      record: createDeclaredMarketplaceRecord(record.id, declarationSource),
      useCachedManifest: false,
    };
  });
  for (const [marketplaceId, source] of declared) {
    if (knownIds.has(marketplaceId)) continue;
    if (isOfficialMarketplaceId(marketplaceId)) continue;
    records.push({
      record: createDeclaredMarketplaceRecord(marketplaceId, source),
      useCachedManifest: false,
    });
  }
  return records;
}

function resolveMarketplaceDeclarationDiagnostics(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): PluginLoadOutcome["diagnostics"] {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownById = new Map(input.known.map((record) => [record.id, record]));
  return [...declared.entries()].flatMap(([marketplaceId, source]) => {
    if (!isOfficialMarketplaceId(marketplaceId)) return [];
    const known = knownById.get(marketplaceId);
    if (known && isDeepStrictEqual(known.source, source)) return [];
    return [createReservedMarketplaceDeclarationDiagnostic(marketplaceId)];
  });
}

function createDeclaredMarketplaceRecord(
  marketplaceId: string,
  source: MarketplaceSource,
): KnownMarketplaceRecord {
  return {
    id: marketplaceId,
    source,
    name: marketplaceId,
    addedAt: "",
    pluginCount: 0,
  };
}

async function materializeDeclaredMarketplaceForExplicitAction(input: {
  abortSignal?: AbortSignal;
  configResult: ConfigResult;
  marketplaceId: string;
  pluginStorageRoot: string;
  workingDirectory: string;
}): Promise<void> {
  const source = resolveDeclaredMarketplaceSources(input).get(input.marketplaceId);
  if (!source) return;
  const known = loadKnownMarketplacesSync(input.pluginStorageRoot).find(
    (record) => record.id === input.marketplaceId,
  );
  if (known && !isDeepStrictEqual(known.source, source)) {
    throw new MarketplaceSourceRepointError(
      createMarketplaceSourceRepointDiagnostic(input.marketplaceId).message,
    );
  }
  if (known && loadMarketplaceManifestSync(input.pluginStorageRoot, input.marketplaceId)) {
    return;
  }
  await addMarketplace({
    expectedId: input.marketplaceId,
    signal: input.abortSignal,
    source,
    storageRoot: input.pluginStorageRoot,
  });
}

function resolvePluginSelector(selector: string, plugins: PluginMetadata[]): PluginMetadata {
  const normalized = selector.trim();
  const exact = plugins.find((plugin) => plugin.id === normalized);
  if (exact) return exact;

  const nameMatches = plugins.filter((plugin) => plugin.name === normalized);
  if (nameMatches.length === 1 && nameMatches[0]) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new Error(`Plugin name is ambiguous, use full plugin id: ${normalized}`);
  }
  throw new Error(`Plugin not found: ${normalized}`);
}

function toMarketplaceSummaryData(
  record: KnownMarketplaceRecord,
  featured?: string[],
  pluginCount?: number,
): ZCodeMarketplaceSummaryData {
  return {
    id: record.id,
    name: record.name,
    source: record.source as unknown as Record<string, unknown>,
    ...(record.description ? { description: record.description } : {}),
    ...(record.lastUpdated ? { lastUpdated: record.lastUpdated } : {}),
    pluginCount: pluginCount ?? record.pluginCount,
    isOfficial: isOfficialMarketplaceId(record.id),
    ...(record.lastRefreshFailure
      ? {
          refreshFailure: {
            code: record.lastRefreshFailure.code,
            failedAt: record.lastRefreshFailure.failedAt,
            message: record.lastRefreshFailure.message,
          },
        }
      : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
  };
}

function toAvailablePluginData(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  installedIds: ReadonlySet<string>,
): ZCodeAvailablePluginData {
  const id = `${entry.name}@${marketplace}`;
  // 从原始条目读：旧版本缓存的目录不用迁移，下次 overview 就能读到。
  const extensionSummary = parseEntryExtensionSummary(entry.raw);
  return {
    id,
    name: entry.name,
    marketplace,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    installed: installedIds.has(id),
    componentTypes: inferComponentTypes(entry.raw),
    ...(entry.listing ? { listing: entry.listing } : {}),
    ...(extensionSummary ? { extensionSummary } : {}),
  };
}

function toInstalledPluginData(
  record: InstalledPluginRecord,
  enabled: boolean,
  loaded?: PluginMetadata,
): ZCodeInstalledPluginData {
  return {
    id: record.id,
    name: record.name,
    marketplace: record.marketplace,
    ...((loaded?.description ?? undefined) ? { description: loaded?.description } : {}),
    version: loaded?.version ?? record.version,
    enabled,
    scope: record.scope,
    installPath: record.installPath,
    installedAt: record.installedAt,
    componentTypes: loaded ? inferComponentTypesFromMetadata(loaded) : undefined,
    ...(loaded ? { hookDetails: loaded.hookDetails } : {}),
  };
}

/** 只能由目录条目自报的组件类型（docs/plugins/plugin-publishing.md §4.2）。 */
const CATALOG_CLAIMED_COMPONENT_TYPES = ["ui", "extension"] as const;

function inferComponentTypes(raw: Record<string, unknown>): string[] {
  const types: string[] = [];
  if ("agents" in raw) types.push("agent");
  if ("commands" in raw) types.push("command");
  if ("skills" in raw) types.push("skill");
  if ("hooks" in raw) types.push("hook");
  if ("mcpServers" in raw) types.push("mcp");
  if ("lspServers" in raw) types.push("lsp");
  // 目录自报的 ui / extension 只是安装前的宣传，装上后以实际清单为准；CLI 只透传、不判断兼容。
  for (const claimed of CATALOG_CLAIMED_COMPONENT_TYPES) {
    if (Array.isArray(raw.componentTypes) && raw.componentTypes.includes(claimed)) {
      types.push(claimed);
    }
  }
  return types;
}

function inferComponentTypesFromMetadata(plugin: PluginMetadata): string[] {
  const types: string[] = [];
  // agent 由约定目录枚举，不一定出现在 manifest；只看 manifest 会让已安装列表漏报子代理能力。
  if (plugin.components.some((group) => group.kind === "agent" && group.items.length > 0)) {
    types.push("agent");
  }
  if (plugin.commandRootCount > 0) types.push("command");
  if (plugin.skillRootCount > 0 || plugin.skillCount > 0) types.push("skill");
  if (plugin.declaredMcpServerNames.length > 0 || plugin.mcpServerNames.length > 0) {
    types.push("mcp");
  }
  if (plugin.hookDetails.length > 0) types.push("hook");
  if (plugin.uiSurfaces?.length) types.push("ui");
  return types;
}

function resolvePluginIdForMutation(options: UninstallZCodeMarketplacePluginOptions): string {
  if (options.pluginId) return options.pluginId;
  if (options.pluginName && options.marketplace) {
    return `${options.pluginName}@${options.marketplace}`;
  }
  throw new Error("pluginId or pluginName + marketplace is required");
}

function normalizePluginOptions(
  options: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function normalizePluginOptionKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0))];
}

function resolvePluginConfigPath(
  options: ResolveZCodePluginsOptions & { scope?: "user" | "workspace" },
  configResult: ConfigResult,
  workingDirectory: string,
): string {
  if (options.scope !== "workspace") {
    return configResult.sources.user.path;
  }

  // Workspace Plugin 配置固定落在当前 `<workspace>/.zcode/config.json`。嵌套 workspace
  // 可能同时发现仓库根与自身的配置，读取端 innermost 优先；写入端也必须锁定当前
  // workspace，不能用 project discovery 的第一个 outermost 文件。
  const workspaceConfigPath = join(workingDirectory, ".zcode", "config.json");
  const projectConfigPaths = [
    ...(options.projectConfigPath ? [options.projectConfigPath] : []),
    ...configResult.sources.project.paths,
  ];
  const existingWorkspaceConfig = projectConfigPaths.find(
    (path) =>
      normalizePluginConfigPathForComparison(path) ===
      normalizePluginConfigPathForComparison(workspaceConfigPath),
  );
  if (existingWorkspaceConfig) return existingWorkspaceConfig;
  return workspaceConfigPath;
}

export function isWorkspacePluginConfigPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return (
      win32.basename(path).toLowerCase() === "config.json" &&
      win32.basename(win32.dirname(path)).toLowerCase() === ".zcode"
    );
  }
  return basename(path) === "config.json" && basename(dirname(path)) === ".zcode";
}

export function resolveMarketplaceRefreshTargetIds(input: {
  declaredIds: Iterable<string>;
  knownIds: Iterable<string>;
  marketplace?: string;
}): string[] {
  if (input.marketplace) return [input.marketplace];
  // refresh-all 只刷新已经物化的 Host known records；项目声明必须逐个显式物化，
  // 避免一次全量刷新把任意 Workspace 声明写进全局 marketplace 状态。
  return [...new Set(input.knownIds)];
}

function createMarketplaceSourceRepointDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_invalid",
    message:
      `Workspace marketplace declaration "${marketplaceId}" conflicts with an existing Host source. ` +
      "Remove the existing marketplace or use a different marketplace id before materializing it.",
    pluginId: marketplaceId,
    severity: "error",
  };
}

function createReservedMarketplaceDeclarationDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_declaration_reserved",
    message:
      `Workspace marketplace declaration "${marketplaceId}" uses a reserved official id and was ignored. ` +
      "Use a different marketplace id for project declarations.",
    pluginId: marketplaceId,
    severity: "warning",
  };
}

class MarketplaceSourceRepointError extends Error {}

function toPluginDiagnostic(diagnostic: {
  code: string;
  message: string;
  pluginId?: string;
  severity: "warning" | "error";
}): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: diagnostic.code as PluginLoadOutcome["diagnostics"][number]["code"],
    message: diagnostic.message,
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
    severity: diagnostic.severity,
  };
}

function toMarketplaceInstallDiagnostic(
  error: unknown,
  pluginId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof MarketplaceSourceRepointError) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_invalid",
      message,
      pluginId,
      severity: "error",
    });
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return toPluginDiagnostic({
      code: sourceCode,
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.startsWith("Plugin not found:")) {
    return toPluginDiagnostic({
      code: "plugin_not_found",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("Cross-marketplace dependency")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cross_marketplace",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("dependency cycle")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cycle",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return toPluginDiagnostic({
      code: "plugin_dependency_missing",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("source is recognized but not supported")) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_source_unsupported",
      message,
      pluginId,
      severity: "error",
    });
  }
  return toPluginDiagnostic({
    code: "plugin_marketplace_invalid",
    message,
    pluginId,
    severity: "error",
  });
}

function toMarketplaceRefreshDiagnostic(
  error: unknown,
  marketplaceId?: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  return toPluginDiagnostic({
    code: getPluginSourceDiagnosticCode(error) ?? "plugin_marketplace_invalid",
    message,
    pluginId: marketplaceId,
    severity: "error",
  });
}

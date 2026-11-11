import {
  zcodePluginsConfigureParamsSchema,
  zcodePluginsResetConfigParamsSchema,
  zcodePluginsInstallParamsSchema,
  zcodePluginsMarketplaceAddParamsSchema,
  zcodePluginsMarketplaceRemoveParamsSchema,
  zcodePluginsMarketplaceUpdateParamsSchema,
  zcodePluginsOverviewParamsSchema,
  zcodePluginsListParamsSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsUninstallParamsSchema,
  zcodePluginsUpdateParamsSchema,
  zcodePluginsValidateParamsSchema,
  zcodePluginsDescribeParamsSchema,
  zcodePluginsRestoreBuiltinParamsSchema,
  type ZCodeAvailablePluginSummary,
  type ZCodeInstalledPluginSummary,
  type ZCodePluginComponentGroup,
  type ZCodePluginDiagnostic,
  type ZCodePluginInfo,
  type ZCodePluginExtensionSummary,
  type ZCodePluginMarketplaceSummary,
  type ZCodePluginStoreListing,
  type ZCodePluginsConfigureResult,
  type ZCodePluginsDescribeResult,
  type ZCodePluginsInstallResult,
  type ZCodePluginsListResult,
  type ZCodePluginsMarketplaceMutationResult,
  type ZCodePluginsOverviewResult,
  type ZCodePluginsRestoreBuiltinResult,
  type ZCodePluginsSetEnabledResult,
  type ZCodePluginsUninstallResult,
  type ZCodePluginsValidateResult,
  isUserFacingPlugin,
} from "@zcode/shared";
import type { PluginDiagnostic, PluginMetadata } from "@zcode/contracts";
import {
  addZCodePluginMarketplace,
  configureZCodePlugin,
  describeZCodePlugin,
  enrichCachedClaudeMarketplaceIconsForOverview,
  getZCodePluginsOverview,
  installZCodeMarketplacePlugin,
  removeZCodePluginMarketplace,
  resolveZCodePluginConfigWithSecrets,
  resolveZCodePlugins,
  resetZCodePluginConfig,
  restoreBuiltinPlugin as restoreBuiltinPluginCore,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
  updateZCodePluginMarketplace,
  validateZCodePlugin,
} from "../plugins.js";
import { listInstalledPluginRecords } from "@zcode/adapters/plugins";
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import {
  createConfig,
  createConfigWithPluginMigrations,
  resolvePath,
  type ConfigResult,
} from "@zcode/adapters/config";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

// 把 CLI 的 PluginMetadata 投影成协议可序列化的 ZCodePluginInfo (只保留 UI 需要的字段)。
function toPluginInfo(plugin: PluginMetadata, configResult?: ConfigResult): ZCodePluginInfo {
  const configuredOptions = Object.fromEntries(
    Object.entries(plugin.configuredOptions ?? {}).filter(
      ([key]) => plugin.userConfig?.[key]?.sensitive !== true,
    ),
  );
  const enabledSource = configResult?.sources.plugins.enabled[plugin.id];
  const optionSources = configResult?.sources.plugins.options[plugin.id];
  const rootSource =
    plugin.source === "inline" && configResult
      ? resolveInlinePluginRootSource(plugin.rootPath, configResult)
      : undefined;
  return {
    id: plugin.id,
    name: plugin.name,
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    enabled: plugin.enabled,
    source: plugin.source,
    marketplace: plugin.marketplace,
    // manifest 的作者/主页回退字段（商店 listing 优先）。
    ...(plugin.author !== undefined ? { author: plugin.author } : {}),
    ...(plugin.authorUrl !== undefined ? { authorUrl: plugin.authorUrl } : {}),
    ...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
    skillCount: plugin.skillCount,
    skillRootCount: plugin.skillRootCount,
    commandRootCount: plugin.commandRootCount,
    // 权威组件清单随 list 下发，名称+描述由 loader 枚举（与启用态无关），供详情 UI 直接展示。
    components: plugin.components.map((group) => ({
      kind: group.kind,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    })),
    declaredMcpServerNames: plugin.declaredMcpServerNames,
    ...(plugin.uiSurfaces?.length
      ? {
          uiSurfaces: plugin.uiSurfaces.map((surface) => ({
            pluginId: plugin.id,
            pluginName: plugin.name,
            id: surface.id,
            title: surface.title,
            ...(surface.icon ? { icon: surface.icon } : {}),
            server: surface.server,
            resourceUri: surface.resourceUri,
            availability: surface.availability,
          })),
        }
      : {}),
    mcpServerNames: plugin.mcpServerNames,
    hookDetails: plugin.hookDetails,
    rootPath: plugin.rootPath,
    // 插件的持久数据目录：App 交给扩展作 ctx.extension.dataPath（plugin-compat.md「Storage Layout」）。
    dataPath: plugin.dataPath,
    ...(plugin.userConfig ? { userConfig: plugin.userConfig } : {}),
    ...(Object.keys(configuredOptions).length > 0 ? { configuredOptions } : {}),
    ...(rootSource ? { rootSource } : {}),
    ...(enabledSource ? { enabledSource } : {}),
    ...(optionSources && Object.keys(optionSources).length > 0 ? { optionSources } : {}),
  };
}

function resolveInlinePluginRootSource(
  pluginRootPath: string,
  configResult: ConfigResult,
): "user" | "workspace" | undefined {
  const resolvedPluginRoot = normalizePluginRootForComparison(pluginRootPath);
  // Workspace 优先：同一路径同时出现在两层配置时，项目声明是更高优先级的归属证据。
  if (
    configResult.sources.plugins.dirs.workspace.some(
      (rootPath) => normalizePluginRootForComparison(rootPath) === resolvedPluginRoot,
    )
  ) {
    return "workspace";
  }
  if (
    configResult.sources.plugins.dirs.user.some(
      (rootPath) => normalizePluginRootForComparison(rootPath) === resolvedPluginRoot,
    )
  ) {
    return "user";
  }
  return undefined;
}

async function createPluginConfigView(
  context: ZCodeProtocolAgentServerContext,
  workspacePath: string,
  configScope: "user" | "workspace" | undefined,
): Promise<ConfigResult> {
  // Settings 的 User 与 Workspace 现在是同一批 Host Plugin 的两个配置视图。
  // User 视图若继续加载 project config，会把 Workspace override 投影成 User 当前值；
  // 不传 workingDirectory 可保留 User/default 层，同时仍由调用方的 workspacePath 决定
  // package storage 和相对执行上下文。
  return createConfigWithPluginMigrations({
    env: context.deps?.env,
    ...(configScope === "user" ? {} : { workingDirectory: workspacePath }),
  });
}

function createMissingConfiguredPluginInfos(
  configResult: ConfigResult,
  discoveredPluginIds: ReadonlySet<string>,
): ZCodePluginInfo[] {
  const configuredPluginIds = new Set([
    ...Object.keys(configResult.config.plugins.enabledPlugins),
    ...Object.keys(configResult.config.plugins.options),
  ]);
  return [...configuredPluginIds].flatMap((pluginId) => {
    if (discoveredPluginIds.has(pluginId)) return [];
    const separatorIndex = pluginId.lastIndexOf("@");
    if (separatorIndex <= 0 || separatorIndex === pluginId.length - 1) {
      return [];
    }
    const enabledSource = configResult.sources.plugins.enabled[pluginId];
    const optionSources = configResult.sources.plugins.options[pluginId];
    return [
      {
        id: pluginId,
        name: pluginId.slice(0, separatorIndex),
        enabled: configResult.config.plugins.enabledPlugins[pluginId] ?? false,
        source: "missing",
        marketplace: pluginId.slice(separatorIndex + 1),
        skillCount: 0,
        skillRootCount: 0,
        commandRootCount: 0,
        components: [],
        declaredMcpServerNames: [],
        mcpServerNames: [],
        rootPath: "",
        packageStatus: "missing",
        ...(enabledSource ? { enabledSource } : {}),
        ...(optionSources && Object.keys(optionSources).length > 0 ? { optionSources } : {}),
      },
    ];
  });
}

export function normalizePluginRootForComparison(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolvedRoot = resolvePath(rootPath);
  // Windows 路径不区分大小写，且配置与 loader 可能分别返回正斜杠和反斜杠。
  // 若直接做字符串比较，会把同一个 Workspace plugins.dirs 根误判为无归属。
  return platform === "win32" ? resolvedRoot.replaceAll("\\", "/").toLowerCase() : resolvedRoot;
}

function toPluginDiagnostic(diagnostic: PluginDiagnostic): ZCodePluginDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.pluginId !== undefined ? { pluginId: diagnostic.pluginId } : {}),
  };
}

export async function listPlugins(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsListResult> {
  const params = parseParams(zcodePluginsListParamsSchema, rawParams);
  context.deps?.pluginPreparation?.signal.throwIfAborted();
  // optionSources 要包含已迁进私有文件的敏感键（值仍过滤），否则设置页的 scope 标记与
  // 「清除」按钮会在迁移后消失；所以投影用叠加私有文件后的配置视图。
  const configResult = await resolveZCodePluginConfigWithSecrets({
    configResult: await createPluginConfigView(
      context,
      params.workspace.workspacePath,
      params.configScope,
    ),
    workingDirectory: params.workspace.workspacePath,
  });
  const outcome = await resolveZCodePlugins({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    configResult,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  // 启动 fallback 只表示能力暂不可用；管理查询不能把它投影成磁盘缺包。
  context.deps?.pluginPreparation?.signal.throwIfAborted();
  const plugins = outcome.plugins.map((plugin) => toPluginInfo(plugin, configResult));
  return {
    plugins: [
      ...plugins,
      ...createMissingConfiguredPluginInfos(
        configResult,
        new Set(plugins.map((plugin) => plugin.id)),
      ),
    ].filter((plugin) => isUserFacingPlugin(plugin.id)),
    diagnostics: outcome.diagnostics.map(toPluginDiagnostic),
  };
}

export async function setPluginEnabled(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsSetEnabledResult> {
  const params = parseParams(zcodePluginsSetEnabledParamsSchema, rawParams);
  abortSignal?.throwIfAborted();
  const result = await setZCodePluginEnabled({
    abortSignal,
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    enabled: params.enabled,
    logger: context.logger,
    plugin: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  // 启用配置写入当前不可回滚；若取消在 IO 期间到达，只阻断后续响应和 UI 写入。
  abortSignal?.throwIfAborted();
  return {
    plugin: {
      ...toPluginInfo(result.plugin),
      enabledSource: params.scope ?? "user",
    },
    enabled: result.enabled,
  };
}

export async function getPluginsOverview(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsOverviewResult> {
  const params = parseParams(zcodePluginsOverviewParamsSchema, rawParams);
  context.deps?.pluginPreparation?.signal.throwIfAborted();
  enrichCachedClaudeMarketplaceIconsForOverview({
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  const overview = await getZCodePluginsOverview({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    configResult: await createPluginConfigView(
      context,
      params.workspace.workspacePath,
      params.configScope,
    ),
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  // 查询途中预算到期也走既有失败通道，避免用空发现结果覆盖已安装状态。
  context.deps?.pluginPreparation?.signal.throwIfAborted();
  // 扩展摘要只在被要求时放进 listing：listing 与结果都是 strict，比 CLI 旧的 services 解析到新键会让
  // 整个商店打不开（docs/plugins/plugin-publishing.md §4.3）。能这样要的 services 已先读过能力位。
  const withSummary = params.includeExtensionSummary === true;
  return {
    marketplaces: overview.marketplaces.map(toMarketplaceSummary),
    availablePlugins: overview.availablePlugins
      .filter((plugin) => isUserFacingPlugin(plugin.id))
      .map((plugin) => toAvailablePluginSummary(withExtensionSummary(plugin, withSummary))),
    installedPlugins: overview.installedPlugins
      .filter((plugin) => isUserFacingPlugin(plugin.id))
      .map((plugin) => toInstalledPluginSummary(withExtensionSummary(plugin, withSummary))),
    restorableBuiltins: overview.restorableBuiltins
      .filter((plugin) => isUserFacingPlugin(plugin.id))
      .map(toAvailablePluginSummary),
    diagnostics: overview.diagnostics.map(toPluginDiagnostic),
    capability: { supported: true },
  };
}

export async function addPluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceAddParamsSchema, rawParams);
  const marketplace = await addZCodePluginMarketplace({
    abortSignal,
    dryRun: params.dryRun,
    logger: context.logger,
    source: params.source,
    workingDirectory: params.workspace.workspacePath,
  });
  return { marketplace: toMarketplaceSummary(marketplace), diagnostics: [] };
}

export async function removePluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceRemoveParamsSchema, rawParams);
  await removeZCodePluginMarketplace({
    logger: context.logger,
    marketplace: params.marketplace,
    workingDirectory: params.workspace.workspacePath,
  });
  return { diagnostics: [] };
}

export async function updatePluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceUpdateParamsSchema, rawParams);
  const result = await updateZCodePluginMarketplace({
    abortSignal,
    logger: context.logger,
    marketplace: params.marketplace,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    marketplaces: result.marketplaces.map(toMarketplaceSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function installPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsInstallResult> {
  const params = parseParams(zcodePluginsInstallParamsSchema, rawParams);
  const result = await installZCodeMarketplacePlugin({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    abortSignal,
    dryRun: params.dryRun,
    logger: context.logger,
    marketplace: params.marketplace,
    pluginName: params.pluginName,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    dependencyClosure: result.dependencyClosure,
    installedPlugins: result.installedPlugins.map(toInstalledPluginSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function uninstallPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsUninstallResult> {
  const params = parseParams(zcodePluginsUninstallParamsSchema, rawParams);
  const removed = await uninstallZCodeMarketplacePlugin({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    logger: context.logger,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    removeCache: params.removeCache,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    ...(removed ? { removedPlugin: toInstalledPluginSummary(removed) } : {}),
    diagnostics: [],
  };
}

export async function updatePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsInstallResult> {
  const params = parseParams(zcodePluginsUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  // 在同一把写锁内选择待更新记录，避免把等锁期间卸载的插件重新装回去。
  return withPluginStorageLock(pluginStorageRoot, async (lock) => {
    const installed = listInstalledPluginRecords(pluginStorageRoot).filter((record) => {
      if (params.pluginId) return record.id === params.pluginId;
      if (params.marketplace) return record.marketplace === params.marketplace;
      return true;
    });
    const installedPlugins: ZCodeInstalledPluginSummary[] = [];
    const dependencyClosure: string[] = [];
    // 聚合每条记录重装产生的诊断：installZCodeMarketplacePlugin 失败时不抛错，而是返回
    // CLI 形态的 PluginDiagnostic（见其错误分支的 toMarketplaceInstallDiagnostic），
    // 这里逐条经协议侧 toPluginDiagnostic 投影成 ZCodePluginDiagnostic 回传，
    // 让失败的重装显式暴露，而不是静默"成功"。
    const diagnostics: ZCodePluginDiagnostic[] = [];
    for (const record of installed) {
      const result = await installZCodeMarketplacePlugin({
        pluginStorageRoot: lock.root,
        pluginStorageLock: lock,
        pluginPreparation: context.deps?.pluginPreparation,
        pluginDiscovery: context.deps?.pluginDiscovery,
        workspaceIdentity: params.workspace.workspaceIdentity,
        remoteSessionId: params.workspace.remoteSessionId,
        logger: context.logger,
        marketplace: record.marketplace,
        pluginName: record.name,
        scope: record.scope,
        workingDirectory: params.workspace.workspacePath,
      });
      installedPlugins.push(...result.installedPlugins.map(toInstalledPluginSummary));
      dependencyClosure.push(...result.dependencyClosure);
      diagnostics.push(...result.diagnostics.map(toPluginDiagnostic));
    }
    return { dependencyClosure, installedPlugins, diagnostics };
  });
}

// 恢复一个被抑制（"卸载"）的内置插件：清除 suppressedBuiltins 标记并立即重新 seed。
// bootstrap 侧的同名函数被别名为 restoreBuiltinPluginCore，避免与本协议处理器重名。
export async function restoreBuiltinPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsRestoreBuiltinResult> {
  const params = parseParams(zcodePluginsRestoreBuiltinParamsSchema, rawParams);
  await restoreBuiltinPluginCore({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    logger: context.logger,
    pluginId: params.pluginId,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function configurePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsConfigureResult> {
  const params = parseParams(zcodePluginsConfigureParamsSchema, rawParams);
  await configureZCodePlugin({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    clearOptionKeys: params.clearOptionKeys,
    dryRun: params.dryRun,
    logger: context.logger,
    options: params.options,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function resetPluginConfig(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsConfigureResult> {
  const params = parseParams(zcodePluginsResetConfigParamsSchema, rawParams);
  await resetZCodePluginConfig({
    logger: context.logger,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function validatePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsValidateResult> {
  const params = parseParams(zcodePluginsValidateParamsSchema, rawParams);
  const diagnostics = await validateZCodePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginName: params.pluginName,
    source: params.source,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics: diagnostics.map(toPluginDiagnostic),
    compatibility: {
      runnable: ["skills", "commands", "hooks", "mcpServers", "userConfig"],
      diagnosticOnly: ["agents", "lspServers", "outputStyles", "channels", "settings"],
      unsupported: ["mcpb", "dxt", "npm", "hostPattern", "pathPattern"],
    },
  };
}

export async function describePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsDescribeResult> {
  const params = parseParams(zcodePluginsDescribeParamsSchema, rawParams);
  // 已安装目录、已缓存 manifest 与临时 source 解析都不持锁；只有懒加载 manifest 写入进锁。
  const result = await describeZCodePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginName: params.pluginName,
    workingDirectory: params.workspace.workspacePath,
  });
  const components: ZCodePluginComponentGroup[] = result.components.map((group) => ({
    kind: group.kind,
    items: group.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    })),
  }));
  const diagnostics = result.diagnostics.map(toPluginDiagnostic);
  return {
    components,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function toMarketplaceSummary(input: {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial?: boolean;
  featured?: string[];
  refreshFailure?: ZCodePluginMarketplaceSummary["refreshFailure"];
}): ZCodePluginMarketplaceSummary {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    ...(input.description ? { description: input.description } : {}),
    ...(input.lastUpdated ? { lastUpdated: input.lastUpdated } : {}),
    pluginCount: input.pluginCount,
    ...(input.isOfficial !== undefined ? { isOfficial: input.isOfficial } : {}),
    ...(input.featured ? { featured: input.featured } : {}),
    ...(input.refreshFailure ? { refreshFailure: input.refreshFailure } : {}),
  };
}

/** 按请求把 CLI 内部的扩展摘要并进 listing；不要求时原样返回（摘要不进线）。 */
function withExtensionSummary<
  T extends { listing?: ZCodePluginStoreListing; extensionSummary?: ZCodePluginExtensionSummary },
>(plugin: T, include: boolean): T {
  if (!include || !plugin.extensionSummary) return plugin;
  return { ...plugin, listing: { ...plugin.listing, extensionSummary: plugin.extensionSummary } };
}

function toAvailablePluginSummary(input: {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  listing?: ZCodeAvailablePluginSummary["listing"];
}): ZCodeAvailablePluginSummary {
  return {
    id: input.id,
    name: input.name,
    marketplace: input.marketplace,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    installed: input.installed,
    ...(input.componentTypes ? { componentTypes: input.componentTypes } : {}),
    ...(input.listing ? { listing: input.listing } : {}),
  };
}

function toInstalledPluginSummary(input: {
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
  hookDetails?: ZCodeInstalledPluginSummary["hookDetails"];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  listing?: ZCodeInstalledPluginSummary["listing"];
}): ZCodeInstalledPluginSummary {
  return {
    id: input.id,
    name: input.name,
    marketplace: input.marketplace,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    enabled: input.enabled,
    scope: input.scope,
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(input.installedAt ? { installedAt: input.installedAt } : {}),
    ...(input.componentTypes ? { componentTypes: input.componentTypes } : {}),
    ...(input.hookDetails ? { hookDetails: input.hookDetails } : {}),
    ...(input.updateStatus ? { updateStatus: input.updateStatus } : {}),
    ...(input.latestVersion ? { latestVersion: input.latestVersion } : {}),
    ...(input.listing ? { listing: input.listing } : {}),
  };
}

function resolvePluginStorageRoot(workingDirectory: string): string {
  const config = createConfig({ workingDirectory });
  const storageRoot = resolvePath(config.config.storage.dir);
  return getPluginStorageRoot(getCliStorageRoot(storageRoot));
}

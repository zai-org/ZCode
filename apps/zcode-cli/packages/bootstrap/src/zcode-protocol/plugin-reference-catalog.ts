// Plugin 对话引用 catalog 的协议 handler。
// 与 plugins.ts（安装/市场/启停等管理面）分文件：本查询是会话/草稿 Picker 的只读投影，
// 且 plugins.ts 已接近 max-lines 门禁。
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  zcodeProtocolNotifications,
  zcodePluginsReferenceCatalogParamsSchema,
  zcodePluginsResolveSuggestedReferenceParamsSchema,
  type ZCodePluginReferenceCatalogEntry,
  type ZCodePluginDiagnostic as SharedPluginDiagnostic,
  type ZCodePluginsReferenceCatalogResult,
  type ZCodePluginsResolveSuggestedReferenceResult,
} from "@zcode/shared";
import type { PluginReferenceCatalogEntry } from "@zcode/contracts";
import { buildPluginReferenceCatalog } from "@zcode/core";
import {
  enrichCachedClaudeMarketplaceIconsForOverview,
  getZCodePluginsOverview,
  resolveZCodePlugins,
  type ResolveZCodePluginsOptions,
  updateZCodePluginMarketplace,
} from "../plugins.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// Picker 权威：带 sessionId → 该 Session 创建时冻结的 identity catalog（session-owned）；
// 不带 → workspace 当前 catalog（新建草稿）。session 不存在时按协议错误 fail closed，
// 禁止静默回退 workspace authority——否则草稿/会话两种权威会被混淆。
export async function getPluginReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  includeCategory = false,
): Promise<ZCodePluginsReferenceCatalogResult> {
  const params = parseParams(zcodePluginsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const displayByPluginId = await resolveReferenceListingDisplayByPluginId({
      ...params.workspace,
      workingDirectory: params.workspace.workspacePath,
      pluginPreparation: context.deps?.pluginPreparation,
      pluginDiscovery: context.deps?.pluginDiscovery,
    });
    return {
      authority: "session",
      plugins: record.app
        .getPluginReferenceCatalog()
        .plugins.map((entry) => toReferenceCatalogEntry(entry, displayByPluginId, includeCategory)),
    };
  }
  const outcome = await resolveZCodePlugins({
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
    workingDirectory: params.workspace.workspacePath,
  });
  const displayByPluginId = await resolveReferenceListingDisplayByPluginId({
    ...params.workspace,
    workingDirectory: params.workspace.workspacePath,
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
  });
  return {
    authority: "workspace",
    plugins: buildPluginReferenceCatalog(outcome.plugins).plugins.map((entry) =>
      toReferenceCatalogEntry(entry, displayByPluginId, includeCategory),
    ),
  };
}

const SUGGESTED_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID;
const SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS = 10_000;

/** 推荐 Prompt 的安装前可信解析；missing 必须先刷新官方目录，失败时禁止旧快照安装。 */
export async function resolveSuggestedPluginReference(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodePluginsResolveSuggestedReferenceResult> {
  const params = parseParams(zcodePluginsResolveSuggestedReferenceParamsSchema, rawParams);
  const stableId = params.stableId.trim();
  const at = stableId.lastIndexOf("@");
  const pluginName = at > 0 ? stableId.slice(0, at) : "";
  const marketplace = at > 0 ? stableId.slice(at + 1) : "";
  const diagnostic = (code: string, message: string): SharedPluginDiagnostic => ({
    code,
    message,
    severity: "error",
    pluginId: stableId,
  });
  const unavailable = (code: string, message: string) => ({
    stableId,
    status: "unavailable" as const,
    diagnostics: [diagnostic(code, message)],
  });

  if (
    !pluginName ||
    marketplace !== SUGGESTED_PLUGIN_MARKETPLACE ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stableId)
  ) {
    return unavailable(
      "plugin_suggested_reference_untrusted_source",
      "推荐插件不是受信任的官方 zcode-plugins-official 来源",
    );
  }

  const workingDirectory = params.workspace.workspacePath;
  const readState = async () => {
    const outcome = await resolveZCodePlugins({
      logger: context.logger,
      workingDirectory,
      pluginPreparation: context.deps?.pluginPreparation,
      pluginDiscovery: context.deps?.pluginDiscovery,
      workspaceIdentity: params.workspace.workspaceIdentity,
      remoteSessionId: params.workspace.remoteSessionId,
    });
    const entry = buildPluginReferenceCatalog(outcome.plugins).plugins.find(
      (candidate) => candidate.pluginId === stableId,
    );
    return { outcome, entry };
  };
  let displayByPluginId: Map<string, PluginReferenceListingDisplay> | undefined;
  const resolveIcon = async () => {
    // 图标只来自目标 Host 已缓存的官方 listing，并随可信解析一次返回；UI 不再为它读取
    // workspace referenceCatalog。overview 不等待网络，缺失时按无图标降级。
    displayByPluginId ??= await resolveReferenceListingDisplayByPluginId({
      ...params.workspace,
      workingDirectory,
      pluginPreparation: context.deps?.pluginPreparation,
      pluginDiscovery: context.deps?.pluginDiscovery,
    });
    return displayByPluginId.get(stableId)?.icon;
  };
  const toResult = async (entry: PluginReferenceCatalogEntry) => {
    const icon = await resolveIcon();
    return {
      stableId,
      status: (entry.conflictingPluginIds.length > 0
        ? "conflict"
        : entry.enabled
          ? "ready"
          : "disabled") as "conflict" | "ready" | "disabled",
      marketplace,
      pluginName,
      sourceTrust: "official" as const,
      ...(icon ? { icon } : {}),
      diagnostics:
        entry.conflictingPluginIds.length > 0
          ? [
              diagnostic(
                "plugin_suggested_reference_conflict",
                "推荐插件存在同名冲突，不能自动安装或引用",
              ),
            ]
          : [],
    };
  };

  const initial = await readState();
  if (initial.entry) return toResult(initial.entry);

  // 旧流程只有官方 Marketplace 刷新完成后才把 missing 结果返回 UI，网络等待期间
  // 没有任何反馈，用户会误以为点击未生效。首次本地检查缺失后先通知同一 operation 进入 loading。
  context.notify({
    method: zcodeProtocolNotifications.pluginOperationProgress,
    params: { operationId: params.operationId, state: "refreshing" },
  });

  const refreshController = new AbortController();
  const abortRefresh = () => refreshController.abort(signal?.reason);
  if (signal?.aborted) abortRefresh();
  else signal?.addEventListener("abort", abortRefresh, { once: true });
  let refreshTimedOut = false;
  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const refreshRequest = updateZCodePluginMarketplace({
      abortSignal: refreshController.signal,
      logger: context.logger,
      marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
      workingDirectory,
    });
    const refreshTimeoutRequest = new Promise<never>((_, reject) => {
      // 刷新超时必须中止底层网络/进程；仅结束协议等待会让旧 operation 继续改写目录快照。
      refreshTimeout = setTimeout(() => {
        refreshTimedOut = true;
        const timeoutError = new Error("刷新 zcode-plugins-official 超时（10000 ms）");
        timeoutError.name = "TimeoutError";
        refreshController.abort(timeoutError);
        reject(timeoutError);
      }, SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS);
    });
    const refreshed = await Promise.race([refreshRequest, refreshTimeoutRequest]);
    if (signal?.aborted) return unavailable("plugin_operation_cancelled", "插件操作已取消");
    const failure = refreshed.diagnostics.find(
      (item) => item.pluginId === SUGGESTED_PLUGIN_MARKETPLACE,
    );
    if (failure) return unavailable("marketplace_refresh_failed", failure.message);
  } catch (error) {
    if (refreshTimedOut) {
      return unavailable(
        "marketplace_refresh_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal?.aborted) {
      return unavailable("plugin_operation_cancelled", "插件操作已取消");
    }
    return unavailable(
      "marketplace_refresh_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (refreshTimeout !== undefined) clearTimeout(refreshTimeout);
    signal?.removeEventListener("abort", abortRefresh);
  }

  const afterRefresh = await readState();
  if (afterRefresh.entry) return toResult(afterRefresh.entry);
  const overview = await getZCodePluginsOverview({
    logger: context.logger,
    workingDirectory,
    pluginPreparation: context.deps?.pluginPreparation,
    pluginDiscovery: context.deps?.pluginDiscovery,
    workspaceIdentity: params.workspace.workspaceIdentity,
    remoteSessionId: params.workspace.remoteSessionId,
  });
  const candidate = overview.availablePlugins.find((item) => item.id === stableId);
  if (
    !candidate ||
    candidate.name !== pluginName ||
    candidate.marketplace !== SUGGESTED_PLUGIN_MARKETPLACE
  ) {
    return unavailable("plugin_suggested_reference_not_listed", "刷新后的官方目录中未找到该插件");
  }
  const icon = candidate.listing?.icon?.trim();
  return {
    stableId,
    status: "missing",
    marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
    pluginName: candidate.name,
    sourceTrust: "official",
    ...(icon ? { icon } : {}),
    ...(candidate.listing ? { listing: candidate.listing } : {}),
    diagnostics: [],
  };
}

/**
 * icon/displayName(I18n) 是目标 Host Marketplace listing 的可变展示投影，不属于冻结
 * Session 身份。根因：商店 listing 才是原始图标/本地化显示名的事实源，plugin
 * manifest/runtime metadata 不携带它们。workingDirectory 只用于沿既有 Host/config
 * 边界定位数据；这里按 stable ID join，只用于 Picker/chip 展示与搜索，
 * reminder 仍只消费 core identity catalog。
 */
interface PluginReferenceListingDisplay {
  category?: string;
  icon?: string;
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
}

async function resolveReferenceListingDisplayByPluginId(
  options: ResolveZCodePluginsOptions,
): Promise<Map<string, PluginReferenceListingDisplay>> {
  enrichCachedClaudeMarketplaceIconsForOverview(options);
  const overview = await getZCodePluginsOverview(options);
  const displayByPluginId = new Map<string, PluginReferenceListingDisplay>();
  for (const plugin of [
    ...overview.availablePlugins,
    ...overview.installedPlugins,
    ...overview.restorableBuiltins,
  ]) {
    const category = plugin.listing?.category?.trim();
    const icon = plugin.listing?.icon?.trim();
    const displayName = plugin.listing?.displayName?.trim();
    const displayNameI18n = plugin.listing?.displayNameI18n;
    const description = plugin.description?.trim();
    const descriptionI18n = plugin.listing?.descriptionI18n;
    if (!category && !icon && !displayName && !displayNameI18n && !description && !descriptionI18n)
      continue;
    displayByPluginId.set(plugin.id, {
      ...displayByPluginId.get(plugin.id),
      ...(category ? { category } : {}),
      ...(icon ? { icon } : {}),
      ...(displayName ? { displayName } : {}),
      ...(displayNameI18n ? { displayNameI18n } : {}),
      ...(description ? { description } : {}),
      ...(descriptionI18n ? { descriptionI18n } : {}),
    });
  }
  return displayByPluginId;
}

// 身份/能力投影显式丢弃 rootPath（仅 runtime 内部 provenance 用，路径不出协议）；
// icon/displayName(I18n)/description(I18n) 仅供展示，不改变 identifiers-only reminder 契约。
function toReferenceCatalogEntry(
  entry: PluginReferenceCatalogEntry,
  displayByPluginId: ReadonlyMap<string, PluginReferenceListingDisplay>,
  includeCategory = false,
): ZCodePluginReferenceCatalogEntry {
  const display = displayByPluginId.get(entry.pluginId);
  return {
    ...(includeCategory ? { category: display?.category ?? "other" } : {}),
    pluginId: entry.pluginId,
    name: entry.name,
    marketplace: entry.marketplace,
    ...(display?.icon ? { icon: display.icon } : {}),
    ...(display?.displayName ? { displayName: display.displayName } : {}),
    ...(display?.displayNameI18n ? { displayNameI18n: display.displayNameI18n } : {}),
    ...(display?.description ? { description: display.description } : {}),
    ...(display?.descriptionI18n ? { descriptionI18n: display.descriptionI18n } : {}),
    enabled: entry.enabled,
    conflictingPluginIds: entry.conflictingPluginIds,
    skillQualifiedNames: entry.skillQualifiedNames,
    mcpServerNames: entry.mcpServerNames,
    subagentNames: entry.subagentNames ?? [],
  };
}

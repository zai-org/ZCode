import {
  collectTelemetryRendererContext,
  resolveWorkspaceTelemetryDetail,
  type RendererTelemetryEventPayload,
} from "@zcode/shared";
// 设置页插件管理薄服务实现——plugins/* 旧协议词的唯一 host 侧消费点。
// 插件安装/市场/启停的事实源在 zcode-cli 进程（读写 ~/.zcode 插件目录并热更新
// 运行态），host 无副本，故实现保持 agent 协议往返；收敛价值在 UI 层不再直触
// IZCodeAgentService，词表消费面从 UI 散点收拢到本文件一处。
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";

/** 插件管理变更成功的信号（Window Host 侧）。action 与遥测的动作名相同。 */
export interface PluginMutationSucceededEvent {
  /** install、uninstall、update、restore、configure、reset_config、enable、disable、source_* 等。 */
  action: string;
  pluginId?: string;
  scope?: "user" | "workspace";
}

export interface PluginManagementServiceDependencies {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  /**
   * 插件清单「变了」的 Window Host 侧信号：安装、卸载、启停、配置等变更成功返回后调用。
   * 扩展进程据此重读插件清单（docs/plugins/extension-host.md §3.4、§13）；配置与重置还通知该插件的
   * settings.onDidChange（§16.7）。dryRun 不触发。
   */
  onMutationSucceeded?: (event: PluginMutationSucceededEvent) => void;
  now?: () => number;
  zcodeAgentService: Pick<
    IZCodeAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
  >;
}

export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.zcodeAgentService;
  const now = dependencies.now ?? Date.now;
  type Params =
    import("../zcode-agent/zcodeAgentPluginParams.js").ZCodeAgentPluginMutationTarget & {
      pluginId?: string;
      pluginName?: string;
      marketplace?: string;
      scope?: "user" | "workspace";
      dryRun?: boolean;
      removeCache?: boolean;
    };
  type Result = {
    diagnostics?: Array<{ severity?: string; code?: string }>;
    installedPlugins?: Array<{
      id: string;
      marketplace: string;
      version?: string;
      scope: string;
      listing?: { publisherType?: string };
    }>;
    removedPlugin?: { id: string; marketplace: string; version?: string };
    pluginId?: string;
    marketplaces?: unknown[];
    marketplace?: { id: string };
    plugin?: { id: string; marketplace: string; source: string; version?: string };
  };
  const report = (
    action: string,
    params: Params,
    startedAt: number,
    result?: Result,
    error?: unknown,
  ) => {
    if (params.dryRun || !dependencies.reportTelemetryEvent) return;
    const diagnostics = result?.diagnostics ?? [];
    const hasError = diagnostics.some((item) => item.severity === "error");
    // JSON-RPC 保留原始异常类型在 data.name；不能用取消请求的 ACK 或错误文案推断。
    const errorData =
      error instanceof Error && "data" in error && error.data && typeof error.data === "object"
        ? (error.data as { name?: unknown; code?: unknown })
        : undefined;
    const cancelled =
      errorData?.name === "AbortError" ||
      errorData?.code === "plugin_operation_cancelled" ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          ("code" in error && error.code === "plugin_operation_cancelled"))) ||
      diagnostics.some((item) => item.code === "plugin_operation_cancelled");
    const pluginId =
      params.pluginId ??
      (params.pluginName && params.marketplace
        ? `${params.pluginName}@${params.marketplace}`
        : result?.pluginId);
    const installed = result?.installedPlugins?.find((item) => item.id === pluginId);
    const status = cancelled
      ? "cancelled"
      : error
        ? "failure"
        : hasError
          ? action === "update" && !params.pluginId && result?.installedPlugins?.length
            ? "partial"
            : "failure"
          : action === "uninstall" && !result?.removedPlugin
            ? "noop"
            : action === "install" && !installed
              ? "failure"
              : action === "update" && !result?.installedPlugins?.length
                ? "noop"
                : "success";
    const detail: Record<string, string> = {
      schema_version: "1",
      action,
      result: status,
      duration_ms: String(Math.max(0, now() - startedAt)),
      entry: params.telemetry?.entry ?? "unknown",
      trigger: params.telemetry?.trigger ?? "user",
      client_kind: params.telemetry?.client_kind ?? "unknown",
      scope: params.scope ?? installed?.scope ?? "unknown",
      ...resolveWorkspaceTelemetryDetail(params),
      ...(pluginId || result?.removedPlugin
        ? { plugin_id: pluginId ?? result!.removedPlugin!.id }
        : {}),
      ...(params.marketplace || installed || result?.removedPlugin || result?.marketplace
        ? {
            marketplace:
              params.marketplace ??
              installed?.marketplace ??
              result?.removedPlugin?.marketplace ??
              result!.marketplace!.id,
          }
        : {}),
      ...(installed?.version ? { version_after: installed.version } : {}),
      ...(result?.removedPlugin?.version ? { version_before: result.removedPlugin.version } : {}),
      ...(installed?.listing?.publisherType
        ? { publisher_type: installed.listing.publisherType }
        : {}),
      ...(action === "uninstall" ? { remove_cache: String(params.removeCache ?? true) } : {}),
      ...(status === "failure" || status === "partial" || status === "cancelled"
        ? { error_category: cancelled ? "cancelled" : hasError ? "diagnostic" : "transport" }
        : {}),
    };
    // 上报只观察最终结果，不等待网络，失败不得改变原业务返回或触发业务重试。
    try {
      void Promise.resolve(
        dependencies.reportTelemetryEvent({
          elementName: "plugin_lifecycle",
          eventRegion: "app",
          eventType: "result",
          context: collectTelemetryRendererContext(),
          eventExtraDetail: detail,
        }),
      ).catch(() => {});
    } catch {
      /* 观测端故障与业务隔离。 */
    }
  };
  const observe = async <T extends Result>(
    action: string,
    params: Params,
    invoke: (clean: Params) => Promise<T>,
  ): Promise<T> => {
    const startedAt = now();
    const { telemetry: _telemetry, ...clean } = params;
    try {
      const result = await invoke(clean);
      report(action, params, startedAt, result);
      if (!params.dryRun) {
        // 通知方故障不能改变已成功的业务返回。
        try {
          dependencies.onMutationSucceeded?.({
            action,
            ...(params.pluginId ? { pluginId: params.pluginId } : {}),
            ...(params.scope ? { scope: params.scope } : {}),
          });
        } catch {
          /* 观察者自行记录错误。 */
        }
      }
      return result;
    } catch (error) {
      report(action, params, startedAt, undefined, error);
      throw error;
    }
  };
  return {
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    addPluginMarketplace: (params) =>
      observe("source_add", params, (clean) => agent.addPluginMarketplace(clean as typeof params)),
    removePluginMarketplace: (params) =>
      observe("source_remove", params, (clean) =>
        agent.removePluginMarketplace(clean as typeof params),
      ),
    updatePluginMarketplace: (params) =>
      observe("source_refresh", params, (clean) =>
        agent.updatePluginMarketplace(clean as typeof params),
      ),
    installPlugin: (params) =>
      observe("install", params, (clean) => agent.installPlugin(clean as typeof params)),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) =>
      observe("uninstall", params, (clean) => agent.uninstallPlugin(clean as typeof params)),
    updatePlugin: (params) =>
      observe("update", params, (clean) => agent.updatePlugin(clean as typeof params)),
    restoreBuiltinPlugin: (params) =>
      observe("restore", params, (clean) => agent.restoreBuiltinPlugin(clean as typeof params)),
    configurePlugin: (params) =>
      observe("configure", params, (clean) => agent.configurePlugin(clean as typeof params)),
    resetPluginConfig: (params) =>
      observe("reset_config", params, (clean) => agent.resetPluginConfig(clean as typeof params)),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: (params) =>
      observe(params.enabled ? "enable" : "disable", params, (clean) =>
        agent.setPluginEnabled(clean as typeof params),
      ),
  };
}

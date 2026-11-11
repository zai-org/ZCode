import { createHash, randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import {
  ExtensionError,
  extensionGlobalId,
  extensionViewResourceUri,
  findStaticView,
  openViewResultSchema,
  type ExtensionStaticTable,
  type IExtensionHostChannel,
  type ResolvedScope,
  type ScopeInput,
} from "@zcode/shared/extension-host";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { zcodeMcpReadResourceResultSchema } from "@zcode/shared";
import { pickHtmlResource } from "#src/plugin-ui-bridge/index.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { WorkbenchState } from "#src/extensions/workbenchState.js";
import type {
  ExtensionViewNotification,
  ExtensionViewOpenAck,
  ExtensionViewOpenRequest,
  ExtensionViewRequestInput,
  PrepareExtensionViewInput,
  PreparedExtensionView,
} from "#src/extensions/views/contract.js";

// 扩展视图在 Window Host 的一段（docs/plugins/extension-host.md §8）：
// - 准备：生成实例 id → 扩展进程 openView → 挑 HTML 与资源 meta → 登记沙箱（contentKind "extension"）。
// - 页面请求与通知按实例 id 转发；实例属于某一代扩展进程，换代后全部作废。
// - views.open：经 IExtensionViewsService 的事件请 Renderer 打开标签页并等回执（③ 请 Renderer）。

interface ViewRecord {
  gen: number;
  pluginId: string;
  viewId: string;
}

export interface ExtensionViewRelay {
  prepareView(input: PrepareExtensionViewInput): Promise<PreparedExtensionView>;
  viewRequest(input: ExtensionViewRequestInput): Promise<unknown>;
  closeView(instanceId: string): Promise<void>;
  onViewNotifications(instanceId: string): Event<ExtensionViewNotification>;
  /** 新代际连上：订阅该代所有实例的通知。 */
  attach(gen: number, host: IExtensionHostChannel): void;
  /** 扩展进程换代或断开：旧实例全部作废。 */
  detach(): void;
  readonly onOpenRequests: Event<ExtensionViewOpenRequest>;
  requestOpen(pluginId: string, input: { viewId: string; scope?: ScopeInput }): Promise<undefined>;
  ackOpen(ack: ExtensionViewOpenAck): void;
  dispose(): void;
}

/** 沙箱 origin 与存储分区按 appIdentity 派生：同一插件的视图共享存储，不同插件隔离。 */
function extensionAppIdentity(pluginId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["extension-view", pluginId]))
    .digest("hex");
}

export function createExtensionViewRelay(deps: {
  connection(): { gen: number; host: IExtensionHostChannel } | null;
  /** 视图声明是静态的（§16.1），从 Window Host 自己的静态表查。 */
  staticTable(): ExtensionStaticTable | null;
  workbench: WorkbenchState;
  registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  logger: Pick<ServiceLogger, "debug" | "info" | "warn">;
}): ExtensionViewRelay {
  const records = new Map<string, ViewRecord>();
  const notifications = new Map<string, Emitter<ExtensionViewNotification>>();
  let notificationSubscription: { dispose(): void } | null = null;
  const pendingOpens = new Map<
    string,
    { resolve(): void; reject(error: Error): void; viewId: string }
  >();
  const openRequests = new Emitter<ExtensionViewOpenRequest>({
    // Renderer 断开（窗口关闭或重载）：没有人能执行打开，在途请求直接失败，不靠超时。
    onDidRemoveLastListener: () => {
      for (const pending of pendingOpens.values()) {
        pending.reject(new ExtensionError("host-unavailable", "no window is listening"));
      }
      pendingOpens.clear();
    },
  });
  let openListeners = 0;
  const countedOpenRequests: Event<ExtensionViewOpenRequest> = (listener) => {
    openListeners += 1;
    const subscription = openRequests.event(listener);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        openListeners -= 1;
        subscription.dispose();
      },
    };
  };

  const requireRecord = (instanceId: string) => {
    const record = records.get(instanceId);
    const connection = deps.connection();
    if (!record || !connection || connection.gen !== record.gen) {
      throw new ExtensionError("host-unavailable", `view instance is not open: ${instanceId}`);
    }
    return { record, connection };
  };

  const notificationEmitter = (instanceId: string) => {
    let emitter = notifications.get(instanceId);
    if (!emitter) {
      emitter = new Emitter<ExtensionViewNotification>();
      notifications.set(instanceId, emitter);
    }
    return emitter;
  };

  const forget = (instanceId: string) => {
    records.delete(instanceId);
    notifications.get(instanceId)?.dispose();
    notifications.delete(instanceId);
  };

  /** 作用域由 Window Host 补全（§7.1）：会话不在屏幕上时按 App 作用域交给 Renderer，在焦点窗格打开。 */
  const resolveScope = (scope: ScopeInput | undefined): ResolvedScope => {
    if (scope === undefined || scope === "app") return { kind: "app" };
    if ("workspace" in scope) return { kind: "workspace", workspace: scope.workspace };
    const session = deps.workbench.find(scope.sessionId);
    return session
      ? { kind: "session", workspace: session.workspace, sessionId: scope.sessionId }
      : { kind: "app" };
  };

  return {
    async prepareView(input) {
      const connection = deps.connection();
      if (!connection)
        throw new ExtensionError("host-unavailable", "extension host is not running");
      if (!deps.registerSandbox) {
        throw new ExtensionError("internal", "extension view sandbox is unavailable");
      }
      const view = findStaticView(deps.staticTable(), input.viewId);
      if (!view) throw new ExtensionError("not-declared", `view is not declared: ${input.viewId}`);
      // App 作用域的视图（§18.1 H5）：作用域只看静态表，不看 Renderer 传来的侧栏目标。
      const scope: ResolvedScope = view.scope === "app" ? { kind: "app" } : input.scope;
      const instanceId = randomUUID();
      const startedAt = Date.now();
      records.set(instanceId, { gen: connection.gen, pluginId: view.pluginId, viewId: view.id });
      try {
        const opened = openViewResultSchema.parse(
          await connection.host.openView({
            instanceId,
            viewId: view.id,
            scope,
            ...(input.input ? { input: input.input } : {}),
          }),
        );
        if (deps.connection()?.gen !== connection.gen) {
          throw new ExtensionError("host-unavailable", "extension host restarted while opening");
        }
        const localViewId = view.id.slice(view.pluginId.length + 1);
        const pageUri = extensionViewResourceUri(view.pluginId, localViewId);
        // 与 MCP App 同一套 HTML 挑选与限额：只认 HTML 文本项，资源级 _meta 读 CSP 与呈现提示。
        const { html, meta } = pickHtmlResource(
          zcodeMcpReadResourceResultSchema.parse({
            contents: opened.contents.map((content) => ({
              uri: String(content.uri ?? ""),
              ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
              ...(typeof content.text === "string" ? { text: content.text } : {}),
              ...(typeof content.blob === "string" ? { blob: content.blob } : {}),
              ...(content._meta && typeof content._meta === "object"
                ? { _meta: content._meta as Record<string, unknown> }
                : {}),
            })),
          }),
          pageUri,
        );
        const workspace = scope.kind === "app" ? null : scope.workspace;
        const sandbox = await deps.registerSandbox({
          contentKind: "extension",
          // Window Host 签发的凭证：appIdentity 按插件派生，token 就是实例 id，代际是扩展进程 gen。
          instance: {
            runtimeId: `extension-host:${connection.gen}`,
            generation: connection.gen,
            appIdentity: extensionAppIdentity(view.pluginId),
            token: instanceId,
          },
          ...(workspace ? { workspacePath: workspace.workspacePath } : {}),
          ...(workspace?.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
          ownerWebContentsId: input.ownerWebContentsId,
          pluginId: view.pluginId,
          scopeId: `extension-view:${instanceId}`,
          html,
          ...(meta?.csp ? { csp: meta.csp } : {}),
          ...(meta?.cspRelaxations ? { cspRelaxations: meta.cspRelaxations } : {}),
          ...(meta?.prefersBorder !== undefined ? { prefersBorder: meta.prefersBorder } : {}),
        });
        if (deps.connection()?.gen !== connection.gen) {
          throw new ExtensionError("host-unavailable", "extension host restarted while opening");
        }
        deps.logger.info(
          undefined,
          `view prepared ${view.id} instance=${instanceId} gen=${connection.gen} scope=${scope.kind}${input.input ? ` input=${input.input.kind}` : ""} sandbox=${sandbox.sandboxId} durationMs=${Date.now() - startedAt}`,
        );
        return { instanceId, gen: connection.gen, sandbox };
      } catch (error) {
        forget(instanceId);
        void connection.host.closeView({ instanceId }).catch(() => undefined);
        deps.logger.warn(undefined, `prepare view ${view.id} failed`, {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async viewRequest(input) {
      const { connection } = requireRecord(input.instanceId);
      return connection.host.viewRequest({
        instanceId: input.instanceId,
        method: input.method,
        ...(input.params ? { params: input.params } : {}),
      });
    },
    async closeView(instanceId) {
      const record = records.get(instanceId);
      forget(instanceId);
      const connection = deps.connection();
      if (!record || !connection || connection.gen !== record.gen) return;
      await connection.host.closeView({ instanceId });
      deps.logger.info(undefined, `view closed ${record.viewId} instance=${instanceId}`);
    },
    onViewNotifications(instanceId) {
      return notificationEmitter(instanceId).event;
    },
    attach(gen, host) {
      notificationSubscription?.dispose();
      notificationSubscription = host.onDynamicViewNotifications(undefined)((notification) => {
        const record = records.get(notification.instanceId);
        if (!record || record.gen !== gen) return;
        notifications.get(notification.instanceId)?.fire({
          method: notification.method,
          ...(notification.params ? { params: notification.params } : {}),
        });
      });
    },
    detach() {
      notificationSubscription?.dispose();
      notificationSubscription = null;
      for (const instanceId of records.keys()) forget(instanceId);
    },
    onOpenRequests: countedOpenRequests,
    requestOpen(pluginId, input) {
      const viewId = extensionGlobalId(pluginId, input.viewId);
      if (openListeners === 0) {
        return Promise.reject(new ExtensionError("host-unavailable", "no window is listening"));
      }
      const scope: ResolvedScope =
        findStaticView(deps.staticTable(), viewId)?.scope === "app"
          ? { kind: "app" }
          : resolveScope(input.scope);
      const requestId = randomUUID();
      deps.logger.info(undefined, `views.open requested ${viewId} scope=${scope.kind}`);
      return new Promise<undefined>((resolve, reject) => {
        pendingOpens.set(requestId, { resolve: () => resolve(undefined), reject, viewId });
        openRequests.fire({ requestId, viewId, scope });
      });
    },
    ackOpen(ack) {
      const pending = pendingOpens.get(ack.requestId);
      if (!pending) return;
      pendingOpens.delete(ack.requestId);
      deps.logger.info(undefined, `views.open acked ${pending.viewId} ok=${ack.ok}`);
      if (ack.ok) pending.resolve();
      else
        pending.reject(
          new ExtensionError("internal", ack.error ?? "the window could not open the view"),
        );
    },
    dispose() {
      notificationSubscription?.dispose();
      for (const instanceId of records.keys()) forget(instanceId);
      openRequests.dispose();
    },
  };
}

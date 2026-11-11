import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  ExtensionError,
  extensionViewResourceUri,
  type CapabilityDisposable,
  type ExtensionViewInput,
  type OpenViewResult,
  type ResolvedScope,
  type ViewDefinition,
  type ViewInstance,
  type ViewNotification,
  type ViewRequestInput,
  type ViewServerFactory,
  type McpServerLike,
} from "@zcode/shared/extension-host";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { hostLog, runAsPlugin } from "#src/extension-host/runtime.js";
import { createHelperViewServer } from "#src/extension-host/viewServer.js";

// 扩展视图实例（docs/plugins/extension-host.md §8）：两种写法都经进程内 transport 连一个 MCP Client，
// 之后走同一条路径。实例只活在本进程内存里；扩展进程换代后旧实例随进程消失。

const CLIENT_INFO = { name: "zcode-extension-host", version: "1" } as const;
/** 页面的读与列表每次都要拿最新值：关掉 SDK 的客户端缓存。 */
const NO_CACHE = { cacheMode: "bypass" } as const;
/** 只有这几类 server 通知转给页面。 */
const FORWARDED_NOTIFICATIONS = new Set([
  "notifications/resources/updated",
  "notifications/resources/list_changed",
  "notifications/tools/list_changed",
]);

interface InstanceRecord {
  instanceId: string;
  pluginId: string;
  viewId: string;
  client: Client;
  server: McpServerLike;
  /** 页面经 resources/subscribe 订阅的 uri；view.notify 只发给这些。 */
  subscriptions: Set<string>;
  closeListeners: Set<() => void>;
  closed: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uriOf(params: Record<string, unknown> | undefined): string {
  const uri = params?.uri;
  if (typeof uri !== "string" || !uri) throw new ExtensionError("invalid-input", "uri is required");
  return uri;
}

export class ViewHost {
  private readonly instances = new Map<string, InstanceRecord>();
  private readonly listeners = new Set<(notification: ViewNotification) => void>();

  onNotification(listener: (notification: ViewNotification) => void): CapabilityDisposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async open(params: {
    instanceId: string;
    pluginId: string;
    viewId: string;
    rootPath: string;
    scope: ResolvedScope;
    /** file.viewer 打开文件时的打开对象（§16.5）；其余打开方式没有。 */
    input?: ExtensionViewInput;
    view: ViewDefinition | ViewServerFactory;
  }): Promise<OpenViewResult> {
    const { instanceId, pluginId, viewId } = params;
    if (this.instances.has(instanceId)) {
      throw new ExtensionError("invalid-input", `view instance already open: ${instanceId}`);
    }
    const pageUri = extensionViewResourceUri(pluginId, viewId);
    const closeListeners = new Set<() => void>();
    let record: InstanceRecord | null = null;
    const instance: ViewInstance = Object.freeze({
      id: instanceId,
      viewId,
      scope: params.scope,
      ...(params.scope.kind === "session" ? { sessionId: params.scope.sessionId } : {}),
      ...(params.input ? { input: Object.freeze({ ...params.input }) } : {}),
      notify: (uri: string) => {
        if (record) this.notifySubscribed(record, uri);
      },
      onDidClose: (listener: () => void): CapabilityDisposable => {
        closeListeners.add(listener);
        return { dispose: () => closeListeners.delete(listener) };
      },
    });
    const server =
      typeof params.view === "function"
        ? await runAsPlugin(pluginId, () => (params.view as ViewServerFactory)(instance))
        : createHelperViewServer({
            pluginId,
            rootPath: params.rootPath,
            pageUri,
            definition: params.view,
            call: { view: instance },
          });
    if (!server || typeof server.connect !== "function") {
      throw new ExtensionError("internal", `view factory did not return an MCP server: ${viewId}`);
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(CLIENT_INFO, { capabilities: buildMcpAppsClientCapabilities() });
    record = {
      instanceId,
      pluginId,
      viewId,
      client,
      server,
      subscriptions: new Set(),
      closeListeners,
      closed: false,
    };
    const current = record;
    client.fallbackNotificationHandler = async (notification) => {
      if (FORWARDED_NOTIFICATIONS.has(notification.method)) {
        this.emit(current, notification.method, notification.params as Record<string, unknown>);
      }
    };
    this.instances.set(instanceId, record);
    try {
      // 写法一的打开回调（§16.11）：插件在这里登记按实例的状态；抛错时本次打开失败并走关闭回收。
      const definition = typeof params.view === "function" ? null : params.view;
      if (definition?.onDidOpen) {
        await runAsPlugin(pluginId, () => definition.onDidOpen!(instance));
      }
      await runAsPlugin(pluginId, () => server.connect(serverTransport));
      await client.connect(clientTransport);
      const page = await client.readResource({ uri: pageUri }, NO_CACHE);
      hostLog(
        "info",
        `view opened ${viewId} instance=${instanceId}${params.input ? ` input=${params.input.kind}` : ""}`,
        pluginId,
      );
      return { contents: page.contents as OpenViewResult["contents"] };
    } catch (error) {
      await this.close(instanceId);
      hostLog("error", `open view ${viewId} failed: ${describe(error)}`, pluginId);
      throw new ExtensionError("internal", `open view failed: ${describe(error)}`);
    }
  }

  async request(input: ViewRequestInput): Promise<unknown> {
    const record = this.instances.get(input.instanceId);
    if (!record || record.closed) {
      throw new ExtensionError("invalid-input", `view instance is not open: ${input.instanceId}`);
    }
    const { client } = record;
    const params = input.params;
    switch (input.method) {
      case "tools/list":
        return client.listTools(params, NO_CACHE);
      case "tools/call":
        return client.callTool(params as Parameters<Client["callTool"]>[0]);
      case "resources/list":
        return client.listResources(params, NO_CACHE);
      case "resources/templates/list":
        return client.listResourceTemplates(params, NO_CACHE);
      case "resources/read":
        return client.readResource({ ...params, uri: uriOf(params) }, NO_CACHE);
      case "resources/subscribe": {
        const uri = uriOf(params);
        await client.subscribeResource({ uri });
        record.subscriptions.add(uri);
        return {};
      }
      case "resources/unsubscribe": {
        const uri = uriOf(params);
        record.subscriptions.delete(uri);
        await client.unsubscribeResource({ uri });
        return {};
      }
    }
  }

  /** 关闭实例：关 Client（transport 随之关闭）与 server，触发 onDidClose。重复调用无副作用。 */
  async close(instanceId: string): Promise<void> {
    const record = this.instances.get(instanceId);
    if (!record || record.closed) return;
    record.closed = true;
    this.instances.delete(instanceId);
    await record.client.close().catch(() => undefined);
    await Promise.resolve(record.server.close?.()).catch(() => undefined);
    for (const listener of record.closeListeners) {
      try {
        runAsPlugin(record.pluginId, listener);
      } catch (error) {
        hostLog("error", `view onDidClose listener threw: ${describe(error)}`, record.pluginId);
      }
    }
    record.closeListeners.clear();
    hostLog("info", `view closed ${record.viewId} instance=${instanceId}`, record.pluginId);
  }

  /** 扩展停用：关掉它的全部实例。 */
  async closePlugin(pluginId: string): Promise<void> {
    const ids = [...this.instances.values()]
      .filter((record) => record.pluginId === pluginId)
      .map((record) => record.instanceId);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  /** Window Host 断开：实例是替它的页面开的，全部关闭。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((id) => this.close(id)));
  }

  private notifySubscribed(record: InstanceRecord, uri: string): void {
    if (record.closed || !record.subscriptions.has(uri)) return;
    this.emit(record, "notifications/resources/updated", { uri });
  }

  private emit(record: InstanceRecord, method: string, params?: Record<string, unknown>): void {
    if (record.closed) return;
    const notification: ViewNotification = {
      instanceId: record.instanceId,
      method,
      ...(params ? { params } : {}),
    };
    for (const listener of this.listeners) listener(notification);
  }
}

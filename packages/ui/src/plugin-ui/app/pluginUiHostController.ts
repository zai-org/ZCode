import { createPluginUiSampling } from "./pluginUiSampling.js";
import type { CallToolResult, Transport } from "@modelcontextprotocol/client";
import type {
  McpUiAppCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { constrainPluginUiDisplayModes } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle, PluginSandboxTransportPort } from "@zcode/shared/mcp-apps";
import {
  MCP_APPS_HANDSHAKE_TIMEOUT_MS,
  MCP_APPS_HOST_NAME,
  MCP_APPS_WIDGET_STATE_CONTEXT_KEY,
  buildPluginSandboxScopeId,
} from "@zcode/shared/mcp-apps";
import { createPluginUiAppTools } from "./pluginUiAppTools.js";
import {
  installPluginUiHostAppHandlers,
  installPluginUiHostNotificationHandlers,
} from "./pluginUiHostAppHandlers.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiToolFeed,
} from "./pluginUiHostControllerContract.js";
import { runPluginUiHostTeardown } from "./pluginUiHostTeardown.js";
import { wirePluginUiInteractions } from "./pluginUiInteractionPorts.js";
import { createPluginUiResourceSubscriptions } from "./pluginUiResourceSubscriptions.js";

export type {
  PluginUiHostController,
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "./pluginUiHostControllerContract.js";
export function createPluginUiHostController(
  deps: PluginUiHostControllerDeps,
): PluginUiHostController {
  let phase: PluginUiHostPhase = "idle";
  let handle: PluginSandboxHandle | null = null;
  let bridge: PluginUiHostBridge | null = null;
  let boundScope:
    | (ReturnType<typeof baseScope> & { instance: PluginSandboxHandle["instance"] })
    | null = null;
  let transport: Transport | null = null;
  let unsubscribePorts: (() => void) | null = null;
  let hostContext: McpUiHostContext = deps.initialHostContext;
  let appCapabilities: McpUiAppCapabilities | undefined;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  let preparation: Promise<void> | null = null;
  let recycling = false;
  let closedDuringRecycle = false;
  // initialized 已到：可以直接 send*；之前的 notify* 不排队——initialized 时按 getToolFeed 读最新值。
  let attached = false;
  let cancelHandshakeTimer: (() => void) | null = null;
  // 进行中的页面工具调用 id，dispose 时逐个取消到 agent。
  const activeCalls = new Set<string>();
  let unregisterNotifications: (() => void) | null = null;
  const createCallId = deps.createCallId ?? (() => crypto.randomUUID());
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const createAppBridge =
    deps.createAppBridge ??
    ((hostInfo, hostCapabilities, initialContext) =>
      new AppBridge(null, hostInfo, hostCapabilities, {
        hostContext: initialContext,
      }) as unknown as PluginUiHostBridge);

  const setPhase = (
    next: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ) => {
    phase = next;
    deps.onPhase(next, detail);
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.("[plugin-ui] host failed", { message });
    setPhase("error", { error: message });
  };

  /** 经桥的请求共用的归属范围：workspace + session + 本插件 server。 */
  const baseScope = () => ({
    workspacePath: deps.scope.workspacePath,
    ...(deps.scope.workspaceIdentity ? { workspaceIdentity: deps.scope.workspaceIdentity } : {}),
    sessionId: deps.scope.sessionId,
    pluginId: deps.presentation.pluginId,
    serverName: deps.presentation.serverName,
  });

  const pluginScope = () => {
    if (!boundScope) throw new Error("MCP App is not prepared");
    return boundScope;
  };

  const sampling = deps.sampling
    ? createPluginUiSampling({
        bridge: deps.sampling,
        scope: pluginScope,
        canSample: () => Boolean(deps.getHostCapabilities().sampling),
        createCallId,
        activeCalls,
        onBusyChange: () => {
          deps.onActivity?.();
          deps.onBusyChange?.();
        },
      })
    : undefined;

  const resources = createPluginUiResourceSubscriptions({
    bridge: deps.bridge,
    pluginScope,
    scopeId: buildPluginSandboxScopeId(deps.scope.scope),
    currentGeneration: () => handle?.instance.generation,
    isDisposed: () => disposed,
  });

  // App-Provided Tools：握手后发现页面工具并登记；信箱投递到达时认领并让页面执行。没有通道时整段跳过。
  const appTools = deps.appTools
    ? createPluginUiAppTools({
        bridge: deps.appTools,
        pluginScope,
        scopeId: buildPluginSandboxScopeId(deps.scope.scope),
        currentGeneration: () => handle?.instance.generation,
        onBusyChange: () => {
          deps.onActivity?.();
          deps.onBusyChange?.();
        },
        setTimer,
        log: deps.log,
      })
    : null;

  const sendFeed = (active: PluginUiHostBridge, feed: PluginUiToolFeed) => {
    if (feed.toolInput) void active.sendToolInput(feed.toolInput).catch(() => undefined);
    if (feed.toolCancelled) {
      void active.sendToolCancelled({}).catch(() => undefined);
    } else if (feed.toolResult) {
      void active.sendToolResult(feed.toolResult as CallToolResult).catch(() => undefined);
    }
  };

  const attachPort = (port: PluginSandboxTransportPort) => {
    sampling?.reset();
    void transport?.close().catch(() => undefined);
    attached = false;
    appCapabilities = undefined;
    deps.onAppCapabilities?.(undefined);
    cancelHandshakeTimer?.();
    // 新端口 = 页面重载或重挂载：旧代际的订阅退掉、旧实例的工具登记注销；通知入口按新代际重新登记。
    resources.unsubscribeAll();
    appTools?.resetForAttach();
    const widgetState = deps.getWidgetState();
    // widgetState 初值随握手经 hostContext 的扩展键下发（hostContext 允许附加键）；之后不再从宿主推送。
    const contextAtCreate: McpUiHostContext =
      widgetState === undefined
        ? hostContext
        : { ...hostContext, [MCP_APPS_WIDGET_STATE_CONTEXT_KEY]: widgetState };
    const active = createAppBridge(
      { name: MCP_APPS_HOST_NAME, version: deps.hostVersion },
      deps.getHostCapabilities(),
      contextAtCreate,
    );
    bridge = active;
    // 同一页面里两个 App（页面自建 + 别名）会各发一次 initialize / initialized：只按第一次进入 running 并投喂。
    let initializedOnce = false;
    active.oninitialized = () => {
      if (disposed || bridge !== active || initializedOnce) return;
      initializedOnce = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      attached = true;
      appCapabilities = active.getAppCapabilities() ?? {};
      hostContext = constrainPluginUiDisplayModes(
        hostContext,
        appCapabilities,
        deps.getPreferredDisplayMode
          ? deps.getPreferredDisplayMode()
          : deps.presentation.preferredDisplayMode,
      );
      active.setHostContext(hostContext);
      deps.onAppCapabilities?.(appCapabilities);
      setPhase("running", { handle: handle ?? undefined });
      appTools?.onInitialized(
        active,
        active.getAppCapabilities(),
        () => !disposed && bridge === active,
      );
      sendFeed(active, deps.getToolFeed());
    };
    installPluginUiHostAppHandlers(active, {
      currentContext: () => hostContext,
      applyDisplayMode: (mode) => {
        hostContext = { ...hostContext, displayMode: mode };
        if (attached && bridge === active) active.setHostContext(hostContext);
      },
      onDisplayModeRequest: deps.onDisplayModeRequest,
      pluginScope: () => {
        if (disposed) throw new Error("MCP App instance was closed");
        return pluginScope();
      },
      bridge: deps.bridge,
      createCallId,
      activeCalls,
      onBusyChange: deps.onBusyChange,
      onActivity: deps.onActivity,
      onOpenExternal: deps.onOpenExternal,
    });
    sampling?.install(active, () => !disposed && bridge === active);
    resources.install(active);
    wirePluginUiInteractions(active, deps, deps.platform, () => handle);
    installPluginUiHostNotificationHandlers(active, {
      pluginId: deps.presentation.pluginId,
      onHeight: deps.onHeight,
      log: deps.log,
    });
    const activeTransport = deps.createTransport(port);
    transport = activeTransport;
    cancelHandshakeTimer = setTimer(() => {
      if (disposed || bridge !== active || attached) return;
      fail(new Error("plugin-ui: ui/initialize handshake timed out"));
    }, deps.handshakeTimeoutMs ?? MCP_APPS_HANDSHAKE_TIMEOUT_MS);
    active.connect(activeTransport).catch((error) => {
      if (bridge === active) fail(error);
    });
  };

  return {
    get phase() {
      return phase;
    },
    isBusy: () => activeCalls.size > 0 || (appTools?.isBusy() ?? false),
    async tryRecycle() {
      if (!handle || activeCalls.size || appTools?.isBusy()) return false;
      recycling = true;
      let closed = false;
      try {
        closed = await deps.bridge.recycleInstance(pluginScope());
        return closed;
      } finally {
        recycling = false;
        // 回收 RPC 失败也不能吞掉等待期间已经收到的来源撤销通知。
        if (!closed && closedDuringRecycle && !disposed) deps.onInstanceClosed?.();
        closedDuringRecycle = false;
      }
    },
    start() {
      if (phase !== "idle") return;
      setPhase("preparing");
      preparation = (async () => {
        try {
          const ownerWebContentsId = await deps.platform.getOwnerWebContentsId();
          if (disposed) return;
          const prepared = await deps.bridge.prepareSandbox({
            ...baseScope(),
            scopeId: buildPluginSandboxScopeId(deps.scope.scope),
            resourceUri: deps.presentation.resourceUri,
            ownerWebContentsId,
            ...(deps.presentation.csp ? { csp: deps.presentation.csp } : {}),
            ...(deps.presentation.prefersBorder !== undefined
              ? { prefersBorder: deps.presentation.prefersBorder }
              : {}),
          });
          // prepare 已在 Host/Main 完成登记时，卸载不能只忽略回包，否则沙箱无人释放。
          if (disposed) {
            await deps.bridge.closeInstance({ ...baseScope(), instance: prepared.instance });
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          try {
            await deps.bridge.validateInstance({ ...baseScope(), instance: prepared.instance });
          } catch (error) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            throw error;
          }
          if (disposed) {
            await deps.bridge
              .closeInstance({ ...baseScope(), instance: prepared.instance })
              .catch(() => undefined);
            await deps.platform.disposeSandbox(prepared.sandboxId, prepared.initId);
            return;
          }
          handle = prepared;
          boundScope = { ...baseScope(), instance: prepared.instance };
          // 先订阅端口再挂 webview：main 在 guest dom-ready 后投递端口，挂载后订阅可能错过。
          unsubscribePorts?.();
          unsubscribePorts = deps.platform.onPorts((event) => {
            if (disposed || !handle || event.sandboxId !== handle.sandboxId) return;
            // 旧 initId 的端口一律丢弃（guest reload / 重复挂载防串线）。
            if (event.initId < handle.initId) return;
            handle = { ...handle, initId: event.initId };
            attachPort(event.port);
          });
          unregisterNotifications?.();
          unregisterNotifications =
            deps.resourceNotifications?.register(
              prepared.instance.generation,
              {
                notifyInstanceClosed: () => {
                  if (recycling) closedDuringRecycle = true;
                  else if (!disposed) deps.onInstanceClosed?.();
                },
                notifyResourceUpdated: (uri) => {
                  if (!bridge || !attached || !resources.has(uri)) return;
                  void bridge
                    .notification({ method: "notifications/resources/updated", params: { uri } })
                    .catch(() => undefined);
                },
                notifyResourceListChanged: () => {
                  if (!bridge || !attached) return;
                  void bridge
                    .notification({ method: "notifications/resources/list_changed", params: {} })
                    .catch(() => undefined);
                },
                notifyAppToolCall: (call) => {
                  if (!bridge || !attached) return;
                  appTools?.execute(bridge, call);
                },
              },
              prepared.instance,
            ) ?? null;
          setPhase("mounted", { handle: prepared });
        } catch (error) {
          fail(error);
        }
      })();
    },
    updateHostContext(patch) {
      hostContext = constrainPluginUiDisplayModes(
        { ...hostContext, ...patch },
        appCapabilities,
        deps.getPreferredDisplayMode
          ? deps.getPreferredDisplayMode()
          : deps.presentation.preferredDisplayMode,
      );
      if (bridge && attached) bridge.setHostContext(hostContext);
    },
    notifyToolInput(input) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolInput(input).catch(() => undefined);
    },
    notifyToolResult(result) {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolResult(result as CallToolResult).catch(() => undefined);
    },
    notifyToolCancelled() {
      if (disposed || !bridge || !attached) return;
      void bridge.sendToolCancelled({}).catch(() => undefined);
    },
    async callPanelTool(toolName: string, args?: Record<string, unknown>) {
      if (disposed) throw new Error("MCP App instance was closed");
      // pluginScope 未 prepared 时抛错，与页面 AppBridge 的调用同一语义。
      const scope = pluginScope();
      const callId = createCallId();
      activeCalls.add(callId);
      deps.onBusyChange?.();
      try {
        return await deps.bridge.callTool({
          ...scope,
          toolName,
          ...(args ? { arguments: args } : {}),
          callId,
        });
      } finally {
        activeCalls.delete(callId);
        deps.onBusyChange?.();
      }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      cancelHandshakeTimer?.();
      cancelHandshakeTimer = null;
      unsubscribePorts?.();
      unsubscribePorts = null;
      const current = handle;
      const scope = current ? { ...baseScope(), instance: current.instance } : null;
      unregisterNotifications?.();
      unregisterNotifications = null;
      const active = bridge,
        activeTransport = transport,
        wasAttached = attached;
      // 注销请求捕获原凭证，不能在 await 后从新句柄读取代际。
      bridge = null;
      transport = null;
      attached = false;
      handle = null;
      setPhase("disposed");
      disposal = (async () => {
        if (scope) await deps.bridge.closeInstance(scope).catch(() => undefined);
        sampling?.reset();
        await preparation;
        resources.unsubscribeAll();
        appTools?.dispose();
        activeCalls.clear();
        await runPluginUiHostTeardown({
          bridge: active,
          transport: activeTransport,
          wasAttached,
          handle: current,
          platform: deps.platform,
          setTimer,
          ...(deps.teardownTimeoutMs !== undefined
            ? { teardownTimeoutMs: deps.teardownTimeoutMs }
            : {}),
        });
      })();
      return disposal;
    },
  };
}

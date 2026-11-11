import { AppBridge, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ReadResourceResult,
} from "@modelcontextprotocol/client";
import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/client";
import type { IExtensionViewsService } from "@zcode/services";
import type {
  ExtensionViewInput,
  ExtensionViewRequestMethod,
  ResolvedScope,
} from "@zcode/shared/extension-host";
import {
  MCP_APPS_HANDSHAKE_TIMEOUT_MS,
  MCP_APPS_HOST_NAME,
  MCP_APPS_HOST_VERSION,
  type PluginSandboxHandle,
  type PluginSandboxPlatformPort,
} from "@zcode/shared/mcp-apps";
import {
  buildPluginUiHostCapabilities,
  buildPluginUiHostContext,
  createPluginUiMessagePortTransport,
  createPluginUiPagePlane,
  readPluginUiStyleVariables,
  runPluginUiHostTeardown,
} from "@/plugin-ui/hostPrimitives.js";
import { PLUGIN_UI_SIDE_PANE_TITLE_BAR } from "@/plugin-ui/contract.js";
import { logger } from "@/logger.js";

// 扩展视图页面（docs/plugins/extension-host.md §8）：复用 MCP App 的页面层（沙箱 webview、端口 transport、
// 官方 AppBridge、hostContext 与卸载顺序），后端换成 IExtensionViewsService 的视图通道。
// 页面经 window.zcode（沙箱注入的兼容层）发出的 tools/*、resources/* 都转给扩展进程里的视图 MCP server。
// 实例在标签页挂载时创建、卸载时关闭；所属扩展进程换代后由组件按新代际重建。

export type ExtensionViewPhase = "preparing" | "mounted" | "running" | "error";

export interface ExtensionViewPageSnapshot {
  phase: ExtensionViewPhase;
  error: string | null;
  instanceId: string | null;
  gen: number | null;
  /** 沙箱 id：诊断与 E2E 定位页面用。 */
  sandboxId: string | null;
}

export interface ExtensionViewPage {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ExtensionViewPageSnapshot;
  /** 侧栏标签页的锚点：页面撑满该节点。 */
  bind(node: HTMLElement): () => void;
  /** 界面语言变化：推 host-context-changed。主题由页面自己观察根元素。 */
  setLocale(locale: string): void;
  dispose(): Promise<void>;
}

const OPEN_LINK_PROTOCOLS = new Set(["http:", "https:"]);

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createExtensionViewPage(input: {
  service: IExtensionViewsService;
  platform: PluginSandboxPlatformPort;
  viewId: string;
  scope: ResolvedScope;
  /** file.viewer 打开文件时的打开对象（§16.5）。 */
  input?: ExtensionViewInput;
  locale: string;
  openExternal(url: string): void;
}): ExtensionViewPage {
  const { service, platform } = input;
  const listeners = new Set<() => void>();
  let snapshot: ExtensionViewPageSnapshot = {
    phase: "preparing",
    error: null,
    instanceId: null,
    gen: null,
    sandboxId: null,
  };
  let disposed = false;
  let handle: PluginSandboxHandle | null = null;
  let instanceId: string | null = null;
  let bridge: AppBridge | null = null;
  let attached = false;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let stopNotifications: { dispose(): void } | null = null;
  /** 页面经 resources/subscribe 订阅的 uri：resources/updated 只投给这些。 */
  const subscribed = new Set<string>();
  let locale = input.locale;

  const update = (next: Partial<ExtensionViewPageSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) => {
    logger.lifecycle.warn("[extension-view] page failed", {
      viewId: input.viewId,
      instanceId,
      message: describe(error),
    });
    update({ phase: "error", error: describe(error) });
  };
  const plane = createPluginUiPagePlane({
    onVisibility: () => undefined,
    onCrash: () => fail(new Error("Extension view page stopped")),
  });
  const buildContext = (): McpUiHostContext =>
    buildPluginUiHostContext({
      theme: currentTheme(),
      locale,
      displayMode: "fullscreen",
      availableDisplayModes: ["fullscreen"],
      width: 0,
      titleBar: PLUGIN_UI_SIDE_PANE_TITLE_BAR,
      styleVariables: readPluginUiStyleVariables(),
    });
  const pushContext = () => {
    if (attached) bridge?.setHostContext(buildContext());
  };
  // 主题切换改根元素的类与样式变量：观察 DOM 而不是 React 状态，读到的 token 才是切换后的值。
  const themes = new MutationObserver(pushContext);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });

  const request = async (method: ExtensionViewRequestMethod, params?: object) => {
    if (disposed || !instanceId) throw new Error("Extension view was closed");
    return service.viewRequest({
      instanceId,
      method,
      ...(params ? { params: params as Record<string, unknown> } : {}),
    });
  };

  const attach = (active: AppBridge) => {
    active.onerror = fail;
    active.oninitialized = () => {
      clearTimeout(handshake);
      attached = true;
      logger.lifecycle.info("[extension-view] page initialized", {
        viewId: input.viewId,
        instanceId,
      });
      update({ phase: "running" });
      pushContext();
    };
    active.oncalltool = async (params) => (await request("tools/call", params)) as CallToolResult;
    active.onreadresource = async (params) =>
      (await request("resources/read", params)) as ReadResourceResult;
    active.onlistresources = async (params) =>
      (await request("resources/list", params ?? {})) as ListResourcesResult;
    active.onlistresourcetemplates = async (params) =>
      (await request("resources/templates/list", params ?? {})) as ListResourceTemplatesResult;
    active.setRequestHandler("resources/subscribe", async (message) => {
      await request("resources/subscribe", { uri: message.params.uri });
      subscribed.add(message.params.uri);
      return {};
    });
    active.setRequestHandler("resources/unsubscribe", async (message) => {
      subscribed.delete(message.params.uri);
      await request("resources/unsubscribe", { uri: message.params.uri });
      return {};
    });
    // 标签页只有一种呈现：请求别的模式如实回 fullscreen。
    active.onrequestdisplaymode = async () => ({ mode: "fullscreen" });
    active.onopenlink = async (params) => {
      let url: URL;
      try {
        url = new URL(params.url);
      } catch {
        throw new ProtocolError(INVALID_PARAMS, `invalid link ${params.url}`);
      }
      // 只放行 http(s)：file: / 自定义 scheme 交给系统会打开本地程序。
      if (!OPEN_LINK_PROTOCOLS.has(url.protocol)) {
        throw new ProtocolError(
          INVALID_PARAMS,
          `only http(s) links can be opened (${url.protocol})`,
        );
      }
      input.openExternal(url.toString());
      return {};
    };
    active.onloggingmessage = (params) => {
      logger.lifecycle.info("[extension-view] page log", {
        viewId: input.viewId,
        level: params.level,
        data: params.data,
      });
    };
  };

  const offPorts = platform.onPorts((event) => {
    if (disposed || event.sandboxId !== handle?.sandboxId || event.initId !== handle.initId) return;
    void bridge?.close();
    attached = false;
    logger.lifecycle.info("[extension-view] port attached", {
      viewId: input.viewId,
      instanceId,
      sandboxId: event.sandboxId,
    });
    // SDK 持有上一份上下文用于差异比较，不能共享同一对象。
    const active = new AppBridge(
      null,
      { name: MCP_APPS_HOST_NAME, version: MCP_APPS_HOST_VERSION },
      buildPluginUiHostCapabilities({
        canSendFollowUpMessage: false,
        canUpdateModelContext: false,
        canSetWidgetState: false,
        canSubscribeResources: true,
        canDownloadFile: false,
      }),
      { hostContext: buildContext() },
    );
    bridge = active;
    attach(active);
    clearTimeout(handshake);
    // 超时只报告握手失败，不参与状态同步。
    handshake = setTimeout(
      () => fail(new Error("Extension view handshake timed out")),
      MCP_APPS_HANDSHAKE_TIMEOUT_MS,
    );
    void active.connect(createPluginUiMessagePortTransport(event.port)).catch(fail);
  });

  const preparation = (async () => {
    const prepared = await service.prepareView({
      viewId: input.viewId,
      scope: input.scope,
      ownerWebContentsId: await platform.getOwnerWebContentsId(),
      ...(input.input ? { input: input.input } : {}),
    });
    instanceId = prepared.instanceId;
    // 先记下句柄：准备期间标签页已卸载时，dispose 仍要释放这份沙箱登记。
    handle = prepared.sandbox;
    if (disposed) return;
    stopNotifications = service.onDynamicViewNotifications({ instanceId: prepared.instanceId })(
      (notification) => {
        if (!attached || !bridge) return;
        const uri = notification.params?.uri;
        // 资源变更只投给订阅了该 uri 的页面。
        if (
          notification.method === "notifications/resources/updated" &&
          (typeof uri !== "string" || !subscribed.has(uri))
        )
          return;
        void bridge.notification(notification).catch(() => undefined);
      },
    );
    logger.lifecycle.info("[extension-view] prepared", {
      viewId: input.viewId,
      instanceId: prepared.instanceId,
      gen: prepared.gen,
      scope: input.scope.kind,
      input: input.input?.kind ?? null,
    });
    update({
      phase: "mounted",
      instanceId: prepared.instanceId,
      gen: prepared.gen,
      sandboxId: prepared.sandbox.sandboxId,
    });
    plane.mount(prepared.sandbox);
  })().catch(fail);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    bind: (node) => plane.bind({ node, kind: "sidebar" }),
    setLocale(next) {
      if (next === locale) return;
      locale = next;
      pushContext();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(handshake);
      offPorts();
      themes.disconnect();
      stopNotifications?.dispose();
      plane.prepareUnmount();
      await preparation;
      // 页面先拿到 ui/resource-teardown 的清理窗口，再关桥、释放沙箱登记；实例随后在扩展进程关闭。
      await runPluginUiHostTeardown({
        bridge: bridge as unknown as Parameters<typeof runPluginUiHostTeardown>[0]["bridge"],
        transport: null,
        wasAttached: attached,
        handle,
        platform,
        setTimer: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      });
      plane.dispose();
      listeners.clear();
      if (instanceId) {
        const closing = instanceId;
        void service.closeView({ instanceId: closing }).catch(() => undefined);
        logger.lifecycle.info("[extension-view] closed", {
          viewId: input.viewId,
          instanceId: closing,
        });
      }
    },
  };
}

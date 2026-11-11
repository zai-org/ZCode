import type { Transport } from "@modelcontextprotocol/client";
import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  IPluginUiAppToolsService,
  IPluginUiBridgeService,
  IPluginUiSamplingService,
} from "@zcode/services";
import type {
  McpAppsToolInputPayload,
  McpAppsToolResultPayload,
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
  PluginSandboxTransportPort,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation, PluginUiResourceNotificationTarget } from "../contract.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import { type PluginUiInteractionCallbacks } from "./pluginUiInteractionPorts.js";

/**
 * 宿主侧编排：prepareSandbox → 拿句柄挂 webview → 等 initId 匹配的端口 → `AppBridge(null)` 接 Transport →
 * `initialized` 后投喂 tool-input / tool-result → 响应页面的 tools/call / resources/* / open-link / size-changed。
 * 所有 IO 经 deps 注入；页面管理器拥有 controller，hook 只登记展示锚点。
 */
export type PluginUiHostPhase = "idle" | "preparing" | "mounted" | "running" | "error" | "disposed";

export interface PluginUiHostScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  /** 工具卡片 `{ kind: "toolCall" }` 或面板 `{ kind: "surface" }`；映射为沙箱 scopeId 参与幂等键。 */
  scope: PluginUiScopeRef;
}

/** 页面侧投喂内容；`initialized` 时读一次最新值，之后的变化经 notify*。 */
export interface PluginUiToolFeed {
  toolInput?: McpAppsToolInputPayload;
  toolResult?: McpAppsToolResultPayload;
  toolCancelled?: boolean;
}

export interface PluginUiHostControllerDeps extends PluginUiInteractionCallbacks {
  onBusyChange?(): void;
  /** 模型发起的页面工具和 sampling；不包括页面自主轮询。 */
  onActivity?(): void;
  onInstanceClosed?(): void;
  createTransport(port: PluginSandboxTransportPort): Transport;
  bridge: Pick<
    IPluginUiBridgeService,
    | "closeInstance"
    | "recycleInstance"
    | "validateInstance"
    | "prepareSandbox"
    | "callTool"
    | "cancelToolCall"
    | "readResource"
    | "listResources"
    | "listResourceTemplates"
    | "subscribeResource"
    | "unsubscribeResource"
  >;
  /** App-Provided Tools 通道；缺省（web / 远程）时不发现、不登记页面工具。 */
  sampling?: IPluginUiSamplingService;
  appTools?: IPluginUiAppToolsService;
  platform: PluginSandboxPlatformPort;
  /**
   * 按 Agent 实例代际登记资源通知入口；宿主把投影里的 server 通知路由到这里。
   * 缺省不登记（页面仍可 subscribe，但收不到通知）。
   */
  resourceNotifications?: {
    register(
      generation: number,
      target: PluginUiResourceNotificationTarget,
      instance: PluginSandboxHandle["instance"],
    ): () => void;
  };
  /** UI 发起调用的 id 生成；缺省 crypto.randomUUID。 */
  createCallId?: () => string;
  /** 握手超时 / teardown 等待的计时器；缺省 setTimeout。返回取消函数。 */
  setTimer?: (callback: () => void, ms: number) => () => void;
  scope: PluginUiHostScope;
  presentation: PluginUiPresentation;
  /** `initialized` 时读一次，保证拿到最新工具输入 / 结果。 */
  getToolFeed(): PluginUiToolFeed;
  /** widgetState 初值（宿主内存 store，唯一 owner）；端口到达时读一次，undefined = 没有。 */
  getWidgetState(): unknown;
  /** 端口到达创建 AppBridge 时读取，按当时真实可用的交互生成能力声明。 */
  getHostCapabilities(): McpUiHostCapabilities;
  initialHostContext: McpUiHostContext;
  /** 读取当前呈现选择；侧栏和工具行共享页面，不因展示位置变化重建 controller。 */
  getPreferredDisplayMode?: () => PluginUiPresentation["preferredDisplayMode"];
  hostVersion: string;
  onPhase(
    phase: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ): void;
  onHeight(height: number): void;
  /** `ui/request-display-mode`：宿主裁决后返回实际模式（内联实例打开侧栏、侧栏实例关闭 tab 都在这里发生）。 */
  onDisplayModeRequest(mode: McpUiDisplayMode): McpUiDisplayMode;
  onOpenExternal(url: string): void;
  /** `initialized` 后一次：页面声明的 appCapabilities（可能 undefined）。 */
  onAppCapabilities?: (capabilities: McpUiAppCapabilities | undefined) => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** 缺省 `new AppBridge(null, …)`；测试注入假桥。 */
  createAppBridge?: (
    hostInfo: { name: string; version: string },
    hostCapabilities: McpUiHostCapabilities,
    hostContext: McpUiHostContext,
  ) => PluginUiHostBridge;
  handshakeTimeoutMs?: number;
  teardownTimeoutMs?: number;
}

export interface PluginUiHostController {
  isBusy(): boolean;
  tryRecycle(): Promise<boolean>;
  start(): void;
  updateHostContext(patch: Partial<McpUiHostContext>): void;
  /** 面板换到新一次调用时推送 ui/notifications/tool-input。 */
  notifyToolInput(input: McpAppsToolInputPayload): void;
  notifyToolResult(result: McpAppsToolResultPayload): void;
  /** 宿主工具被停止 → ui/notifications/tool-cancelled。 */
  notifyToolCancelled(): void;
  /**
   * 宿主代表面板调用其 server 的工具一次（以面板实例的归属，经 mcp/uiCallTool）。
   * 结果只返回给调用方，不自动投给页面；需要展示时由调用方转 notifyToolResult。
   * 面板尚未 prepared / attached 前调用会抛错或结果不可达，调用方自行排序。
   */
  callPanelTool(
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<import("@zcode/services").PluginUiCallToolResult>;
  dispose(): Promise<void>;
  readonly phase: PluginUiHostPhase;
}

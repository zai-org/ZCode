import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpAppsDisplayMode,
  McpAppsHostTitleBar,
  McpAppsToolResultPayload,
  PluginSandboxHandle,
} from "@zcode/shared/mcp-apps";
import type {
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "../app/pluginUiHostController.js";
import type { PluginUiPresentation } from "../contract.js";
export interface UsePluginUiHostInput {
  presentation: PluginUiPresentation;
  scope: PluginUiHostScope;
  theme: "light" | "dark";
  locale: string;
  displayMode: McpAppsDisplayMode;
  toolInput: Record<string, unknown> | undefined;
  toolResult: McpAppsToolResultPayload | undefined;
  /** 投喂的是哪次调用；变化（面板换到新一次调用）时把 toolInput 作为 tool-input 通知推给页面。 */
  toolCallId?: string;
  /** 宿主工具被停止；变为 true 时向页面发一次 tool-cancelled。 */
  toolCancelled?: boolean;
  hostVersion: string;
  /** 本实例真实可切换到的模式；缺省两种都可。变化时经 host-context-changed 通知页面。 */
  availableDisplayModes?: readonly McpAppsDisplayMode[];
  onDisplayModeRequest?: (mode: McpAppsDisplayMode) => McpAppsDisplayMode;
  onOpenExternal?: (url: string) => void;
  /** 容器宽度，用于 hostContext.containerDimensions；未知时 0。 */
  width: number;
  /** fullscreen 容器的头部；inline 不传。 */
  titleBar?: McpAppsHostTitleBar;
  /** false 时不创建沙箱（如侧栏已接管同一作用域）；默认 true。 */
  enabled?: boolean;
  /** 会话交互回调：缺省时对应请求回 -32601，能力声明也不带该项。 */
  interactions?: Pick<PluginUiHostControllerDeps, "onSendFollowUpMessage" | "onUpdateModelContext">;
}

export interface UsePluginUiHostResult {
  /** 平台或服务不支持插件 UI 时为 false，调用方回退到普通 MCP 卡片。 */
  pageKey: string;
  supported: boolean;
  phase: PluginUiHostPhase;
  handle: PluginSandboxHandle | null;
  height: number;
  error: string | null;
  /** 页面 `ui/initialize` 声明的能力；握手前 undefined，握手后至少为 {}。展示位置与模式请求均受此约束。 */
  appCapabilities: McpUiAppCapabilities | undefined;
  /** 销毁当前实例并重新 prepare（Agent 运行凭证换代）；guest 崩溃 / 加载失败后由错误态按钮触发。 */
  reload(): void;
}

export interface Page {
  readonly kind: "mcp";
  key: string;
  task: string;
  visible: boolean;
  snapshot(): UsePluginUiHostResult;
  subscribe(listener: () => void): () => void;
  start(): void;
  update(input: UsePluginUiHostInput): void;
  updateToolFeed(
    input: Pick<UsePluginUiHostInput, "toolCallId" | "toolInput" | "toolResult" | "toolCancelled">,
  ): void;
  bind(node: HTMLElement, sidebar: boolean): () => void;
  busy(): boolean;
  running(): boolean;
  /** 宿主代表面板调用其 server 的工具；面板未运行时拒绝。 */
  callPanelTool(
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<import("@zcode/services").PluginUiCallToolResult>;
  /** 把工具结果经面板通知通道回投页面；未 attached 时由 controller 丢弃。 */
  notifyPanelToolResult(result: import("@zcode/shared/mcp-apps").McpAppsToolResultPayload): void;
  suspend(force?: boolean): Promise<boolean>;
  destroy(): void;
}

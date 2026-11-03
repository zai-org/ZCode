import type {
  McpAppsAppToolCallRequest,
  McpAppsDisplayMode,
  McpToolUiCsp,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zcode/shared/mcp-apps";
import type { AttachmentRef, ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";
import type { ReactNode } from "react";
import type { PluginUiImageBlock } from "./domain/pluginUiImageBlocks.js";

/**
 * 从 ToolCallRow.display.ui 读出的插件 UI 呈现信息；与 agent 侧 `display.ui` schema 同构，
 * 由 `readPluginUiPresentation` 解析，解析失败返回 null 并回退到普通 McpToolCallBlock。
 */
export interface PluginUiPresentation {
  /** display.serverName：UI 回调工具时的 namespaced server，归属由 agent 侧校验。 */
  serverName: string;
  pluginId: string;
  resourceUri: string;
  preferredDisplayMode?: McpAppsDisplayMode;
  prefersBorder?: boolean;
  csp?: McpToolUiCsp;
  structuredContent?: string;
  widgetMeta?: string;
  /** 原始 content 数组的 JSON 文本；缺省时 tool-result 退回工具输出纯文本。 */
  content?: string;
  truncated?: boolean;
  truncatedBytes?: number;
  /** MCP 结果 isError（v4 行仍是 success）；tool-result 带 isError，面板不用它覆盖成功快照。 */
  isError?: true;
  /** 工具级强制常驻（display.ui.showInline）。 */
  showInline?: true;
  /** 工具结果归属的面板 id；命中同会话已打开的面板 tab 时结果路由进面板。 */
  surface?: string;
}

/**
 * 打开侧栏 plugin-ui tab 的请求；工具卡片给 toolCallId，面板入口（launcher / surface 路由）给 surfaceId + serverName。
 * 两者恰有其一。
 */
export type PluginUiOpenTarget =
  | { toolCallId: string; surfaceId?: never; serverName?: string }
  | { surfaceId: string; serverName: string; toolCallId?: never };

export type OpenPluginUiSideTabRequest = PluginUiOpenTarget & {
  /** 手动新建的文档窗口身份；恢复标签页时保持不变。 */
  instanceId?: string;
  parentSessionId: string;
  pluginId: string;
  resourceUri: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
};

/** 主导航先选定 surface，根草稿就绪后补入真实 session。 */
export type DraftPluginUiOpenRequest = Omit<
  OpenPluginUiSideTabRequest,
  "parentSessionId" | "toolCallId" | "surfaceId" | "serverName"
> & {
  surfaceId: string;
  serverName: string;
};

/**
 * 侧栏 tab；工具卡片 id 为 `plugin-ui:<ws>:<session>:<pluginId>:<toolCallId>`，面板为 `plugin-ui:<ws>:<session>:<pluginId>:surface:<surfaceId>`；
 * 按 parentSessionId 作用域可见。
 */
export interface PluginUiSidePaneTab {
  instanceId?: string;
  id: string;
  type: "plugin-ui";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  parentSessionId: string;
  toolCallId?: string;
  surfaceId?: string;
  serverName?: string;
  pluginId: string;
  resourceUri: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
}

export const PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX = 240;
/** DOM 位置属于视图，页面实例属于窗口 owner；跨容器移动只能走保活承载层。 */
export interface SandboxPagePlacement {
  node: HTMLElement;
  kind: "flow" | "inline" | "sidebar";
  container?: HTMLElement;
  layer?: number;
}
export const PLUGIN_UI_CARD_MIN_HEIGHT_PX = 80;
export const PLUGIN_UI_CARD_MAX_HEIGHT_PX = 1200;
/**
 * 侧栏面板头部（AnimatedSidePanePanel 的 TabsList，`!h-12` = 48px）。fullscreen 时经 hostContext.titleBar
 * 告诉插件页面视口上方被宿主占用的高度；页面视口本身不与它重叠，所以 inset 都是 0。
 */
export const PLUGIN_UI_SIDE_PANE_TITLE_BAR = {
  height: 48,
  leftInset: 0,
  viewportLeftInset: 0,
} as const;

/** 请求 / tab 的作用域：surfaceId 优先，否则 toolCallId；两者都缺视为非法请求。 */
export function readPluginUiScopeRef(
  input: Pick<OpenPluginUiSideTabRequest, "toolCallId" | "surfaceId" | "instanceId">,
): PluginUiScopeRef | null {
  if (input.surfaceId)
    return {
      kind: "surface",
      surfaceId: input.instanceId
        ? `${input.surfaceId}:instance:${input.instanceId}`
        : input.surfaceId,
    };
  if (input.toolCallId) return { kind: "toolCall", toolCallId: input.toolCallId };
  return null;
}

/** 全部宿主绑定使用同一工作区身份；路径只用于执行和显示。 */
export interface PluginUiSessionScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string;
}

/**
 * SessionPane 登记给插件 UI 的会话动作。4a-0 起只剩发送后续消息：widgetState 是宿主内存
 * （`app/pluginUiWidgetStateStore`），不再经会话命令持久化。
 */
export interface PluginUiSessionActions {
  /** images 先经会话的附件上传入口变成 AttachmentRef，再随 sendText 发送。 */
  sendFollowUp(input: {
    prompt: string;
    source: ConversationInputSource;
    images?: readonly PluginUiImageBlock[];
  }): Promise<void>;
}

/** 适配既有 SessionPane 发送入口，不重新实现 admission / owner / ACK。 */
export interface PluginUiSessionCommandPort {
  sendText(
    prompt: string,
    options: { source: ConversationInputSource; attachments?: AttachmentRef[] },
  ): Promise<"sent" | "blocked" | "confirmationRequired" | undefined>;
  /** 内联图片 → 会话附件引用（走 v4 attachmentPut，与 composer 粘贴截图同一条链路）。 */
  uploadAttachment(input: {
    fileName: string;
    mime: string;
    dataBase64: string;
  }): Promise<AttachmentRef>;
}

export type PluginUiOpenSurfaceRequest = PluginUiOpenTarget & {
  pluginId: string;
  resourceUri: string;
  title: string;
};

export interface PluginUiToolBinding {
  scope: PluginUiSessionScope & { toolCallId: string };
  onOpenSidePane?: (request: PluginUiOpenSurfaceRequest) => void;
}

export function buildPluginUiSessionKey(target: PluginUiSessionScope): string {
  return JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath,
    target.sessionId,
  ]);
}

export function buildPluginUiSurfaceKey(
  target: PluginUiSessionScope & { pluginId: string; serverName?: string; resourceUri?: string },
  scope: PluginUiScopeRef,
): string {
  // 修复：surfaceId 由插件自行命名，必须同时隔离工作区、会话和插件。
  return JSON.stringify([
    buildPluginUiSessionKey(target),
    target.pluginId,
    target.serverName ?? "",
    target.resourceUri ?? "",
    buildPluginSandboxScopeId(scope),
  ]);
}

export function buildPluginUiSidePaneTabId(request: OpenPluginUiSideTabRequest): string {
  const scope = readPluginUiScopeRef(request);
  if (!scope) throw new Error("plugin-ui side tab needs toolCallId or surfaceId");
  return [
    "plugin-ui",
    request.workspaceIdentity?.trim() || request.workspacePath,
    request.parentSessionId,
    request.pluginId,
    request.serverName ?? "",
    request.resourceUri,
    ...(scope.kind === "toolCall" ? [scope.toolCallId] : ["surface", scope.surfaceId]),
  ]
    .map(encodeURIComponent)
    .join(":");
}

export interface PluginUiSidePaneViewProps {
  /** 由宿主页面、侧栏展开状态与当前标签派生，不以保活 DOM 的几何相交替代。 */
  visible: boolean;
  scopeRef: PluginUiScopeRef;
  host: {
    pageKey: string;
    handle: PluginSandboxHandle | null;
    phase: "idle" | "preparing" | "mounted" | "running" | "error" | "disposed";
    height: number;
    error: string | null;
    /** 错误态"重新加载"。 */
    reload(): void;
  };
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  onWidthChange(width: number): void;
}

export interface PluginUiToolCallViewProps {
  supported: boolean;
  fallback: ReactNode;
  surface?: string;
  preferredDisplayMode: McpAppsDisplayMode;
  sidePaneActive: boolean;
  inlineAllowed: boolean;
  pluginId: string;
  pluginName: string;
  pluginIcon?: string;
  host: PluginUiSidePaneViewProps["host"];
  prefersBorder: boolean;
  /** 被同一逻辑 UI 的较新成功结果替代；只留普通工具结果，不建沙箱或自动开侧栏。 */
  superseded: boolean;
  /** 手动固定 / 收起（undefined 按默认规则）；缺省无入口时不显示按钮。 */
  pinned?: boolean;
  pinLabel: string;
  unpinLabel: string;
  onTogglePin?: () => void;
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  openedLabel: string;
  openLabel: string;
  openButtonLabel: string;
  onWidthChange(width: number): void;
  onOpenSidePane?: () => void;
}

/**
 * 一个沙箱实例接收 server 资源通知的入口。宿主按 (会话, 插件, scopeId, generation=initId)
 * 登记，投影里的 `pluginUi.resourceUpdated / resourceListChanged` 增量按 subscribers 路由到对应实例。
 */
export interface PluginUiResourceNotificationTarget {
  notifyInstanceClosed?(): void;
  notifyResourceUpdated(uri: string): void;
  notifyResourceListChanged(): void;
  /** App-Provided Tools 的实例信箱：模型发起的页面工具调用到达本实例。 */
  notifyAppToolCall(call: McpAppsAppToolCallRequest): void;
}

/** 文档查看器手动入口创建独立窗口；工具调用继续使用原有的显式 surface 路由。 */
export function documentViewerInstance(resourceUri: string): { instanceId?: string } {
  return /^ui:\/\/(documents|pdf|presentations|spreadsheets)\/panel\.html$/.test(resourceUri)
    ? { instanceId: crypto.randomUUID() }
    : {};
}

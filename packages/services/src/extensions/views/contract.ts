import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  ExtensionViewInput,
  ExtensionViewRequestMethod,
  ResolvedScope,
  WorkspaceRef,
  NotificationsShowResult,
} from "@zcode/shared/extension-host";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "#src/descriptors.js";

// 扩展视图门面（docs/plugins/extension-host.md §8）：从 IExtensionsService 拆出的视图通道。
// 拆分原因：IExtensionsService 已到架构门禁的公开方法上限（12），P2 的入口、设置与日志还要加方法；
// 视图实例的准备、请求、通知、关闭与 views.open 是一组独立的意图，单独一个频道。
// P4 的 workbench.startDraft（§18.1 H2）与 views.open 同属「请 Renderer 执行并等回执」，也放这里。
// 与 IExtensionsService 同一个 owner（Window Host 的 extensions-service），同样只在桌面本机 Host 注册。

/** 准备扩展视图实例（§8）：Renderer 的标签页挂载时调用。 */
export interface PrepareExtensionViewInput {
  /** 视图全局 id：`<pluginId>/<viewId>`。 */
  viewId: string;
  /** 实例作用域：侧栏当前目标的会话（草稿为预热会话），没有会话时为工作区。 */
  scope: ResolvedScope;
  /** 宿主窗口 webContents id；Main 登记沙箱时校验。 */
  ownerWebContentsId: number;
  /** 打开对象：file.viewer 打开文件时带（§16.5），扩展收到 view.input。 */
  input?: ExtensionViewInput;
}

export interface PreparedExtensionView {
  /** 实例 id，每次准备唯一；之后的请求、通知、关闭都按它路由。 */
  instanceId: string;
  /** 实例所属的扩展进程代际；换代后实例作废，标签页按新代际重建。 */
  gen: number;
  sandbox: PluginSandboxHandle;
}

export interface ExtensionViewRequestInput {
  instanceId: string;
  method: ExtensionViewRequestMethod;
  params?: Record<string, unknown>;
}

/** 视图 MCP server 发给页面的通知（resources/updated 等）。 */
export interface ExtensionViewNotification {
  method: string;
  params?: Record<string, unknown>;
}

/** views.open：Window Host 请 Renderer 打开视图标签页。Renderer 打开后用 ackViewOpen 回执。 */
export interface ExtensionViewOpenRequest {
  requestId: string;
  viewId: string;
  /** 已补全的作用域；会话不在屏幕上时为 app（在焦点窗格打开）。 */
  scope: ResolvedScope;
}

export interface ExtensionViewOpenAck {
  requestId: string;
  ok: boolean;
  error?: string;
}

/**
 * workbench.startDraft（docs/plugins/extension-host.md §18.1 H2）：Window Host 请 Renderer 开一个预填文字的
 * 新草稿（与插件市场「试用」同一条新建任务路径），不自动发送。Renderer 接手后用 ackDraftRequest 回执。
 */
export interface ExtensionDraftRequest {
  requestId: string;
  /** 发起的插件（日志归因）。 */
  pluginId: string;
  /** 预填文字：去掉首尾空白后不为空，最长 4000 字符。 */
  text: string;
  /** 省略时用当前工作区。 */
  workspace?: WorkspaceRef;
}

export interface ExtensionDraftAck {
  requestId: string;
  /** 窗口已接手请求（不等草稿准备完）；只读工作区等不能新建草稿时为 false。 */
  ok: boolean;
  error?: string;
}

/**
 * notifications.show（docs/plugins/extension-host.md §18.1 H8）：Window Host 已查过详情页开关与限额，
 * 请 Renderer 查设置页的系统通知开关并经 preload 交给 Main 弹出。Renderer 用 ackNotificationRequest 回执结果。
 */
export interface ExtensionNotificationRequest {
  requestId: string;
  pluginId: string;
  /** 插件显示名：Renderer 用它给标题加前缀。 */
  pluginName: string;
  title: string;
  body: string;
  /** 点击后打开的视图全局 id（已确认属于本插件）。 */
  viewId?: string;
}

export interface ExtensionNotificationAck {
  requestId: string;
  result: NotificationsShowResult;
}

/**
 * Window Host 的扩展视图门面，也承载请 Renderer 执行的请求（views.open、workbench.startDraft、
 * notifications.show）。
 * 只在桌面本机 Host 注册：不进入远程 workspace RPC 合同、source-settings 与手机白名单。
 */
export interface IExtensionViewsService {
  prepareView(input: PrepareExtensionViewInput): Promise<PreparedExtensionView>;
  /** 页面的 MCP 请求（tools/*、resources/*），转给该实例的视图 MCP server。 */
  viewRequest(input: ExtensionViewRequestInput): Promise<unknown>;
  /** 关闭实例：标签页卸载时调用。实例在途的请求随之失败。 */
  closeView(input: { instanceId: string }): Promise<void>;
  onDynamicViewNotifications(input: { instanceId: string }): Event<ExtensionViewNotification>;
  /** views.open 的打开请求；没有订阅者时 views.open 直接返回 host-unavailable。 */
  onDynamicViewOpenRequests(input?: undefined): Event<ExtensionViewOpenRequest>;
  ackViewOpen(ack: ExtensionViewOpenAck): Promise<void>;
  /** workbench.startDraft 的请求；没有订阅者时直接返回 host-unavailable，最后一个订阅者退订时在途请求失败。 */
  onDynamicDraftRequests(input?: undefined): Event<ExtensionDraftRequest>;
  ackDraftRequest(ack: ExtensionDraftAck): Promise<void>;
  /** notifications.show 的请求（§18.1 H8）；没有订阅者时直接返回 host-unavailable。 */
  onDynamicNotificationRequests(input?: undefined): Event<ExtensionNotificationRequest>;
  ackNotificationRequest(ack: ExtensionNotificationAck): Promise<void>;
}

export const IExtensionViewsService = createServiceDescriptor<IExtensionViewsService>(
  ServiceChannels.ExtensionViews,
);

import { z } from "zod";
import type {
  CapabilityCallInput,
  CapabilitySubscribeInput,
  CapabilitySubscriptionMessage,
  CapabilityDisposable,
} from "#src/extension-host/capabilities.js";
import type { ContributionMessage } from "#src/extension-host/contributions.js";
import type { ExtensionDeclarations } from "#src/extension-host/staticTable.js";
import { resolvedScopeSchema } from "#src/extension-host/slots.js";
import type {
  CloseViewInput,
  OpenViewInput,
  OpenViewResult,
  ViewNotification,
  ViewRequestInput,
} from "#src/extension-host/views.js";

// L1 业务面（docs/plugins/extension-host.md §3.2）：Window Host 与扩展进程经 Main 牵线的
// MessageChannelMain 直连，端口上跑双向 @zcode/rpc。两端都用 ProxyChannel 暴露/代理这两个接口。

export const EXTENSION_HOST_CHANNEL = "extension-host";
export const EXTENSION_WINDOW_CHANNEL = "extension-window";

/** 与 @zcode/rpc 的 Event 结构兼容；shared 不依赖 rpc，这里只声明调用形状。 */
export type ExtensionEvent<T> = (listener: (event: T) => void) => CapabilityDisposable;

export const executeCommandInputSchema = z.strictObject({
  /** 命令全局 id：`<pluginId>/<commandId>`。 */
  commandId: z.string().min(1),
  scope: resolvedScopeSchema,
});
export type ExecuteCommandInput = z.infer<typeof executeCommandInputSchema>;

/**
 * Window Host 交给扩展进程的命令调用：在 Renderer 的入参上多一个 args（插槽给命令的参数，
 * 如 composer.mention 的 `{ query }`，§16.6）。Renderer 的 executeCommand 不带参数。
 */
export const commandInvocationSchema = executeCommandInputSchema.extend({
  args: z.record(z.string(), z.unknown()).optional(),
});
export type CommandInvocation = z.infer<typeof commandInvocationSchema>;

/** `extension-host` 频道：Window Host 调扩展进程（扩展声明、命令、视图、贡献表订阅）。 */
export interface IExtensionHostChannel {
  /**
   * 整份扩展声明（§16.1）：Window Host 读清单校验后，只给合法、兼容的 extension。
   * 扩展进程对比后激活新出现的扩展、停用消失的扩展；已激活扩展的声明变了就请求计划重启。
   */
  setDeclarations(declarations: ExtensionDeclarations): Promise<void>;
  /**
   * 执行扩展命令，返回命令的返回值（§16.3）。返回值按 JSON 带回；不能序列化时为 undefined。
   * 要不要用、按什么 schema 校验由 Window Host 按插槽决定（EXTENSION_SLOTS 的 commandResult）。
   */
  executeCommand(input: CommandInvocation): Promise<unknown>;
  /** 订阅贡献表：先收一份完整快照，再收增量与后续快照。 */
  onDynamicContributions(input?: undefined): ExtensionEvent<ContributionMessage>;
  /**
   * 打开视图实例（§8）：必要时按 onView 激活扩展，建 MCP server 与进程内 Client，读页面资源返回。
   * 实例 id 由 Window Host 生成。
   */
  openView(input: OpenViewInput): Promise<OpenViewResult>;
  /** 页面的 MCP 请求，经该实例的 Client 发给视图 MCP server。 */
  viewRequest(input: ViewRequestInput): Promise<unknown>;
  /**
   * 关闭实例：关 Client 与 server，触发 onDidClose。实例在途的请求随之失败，
   * 所以不再为单个请求设计取消方法。
   */
  closeView(input: CloseViewInput): Promise<void>;
  /** 所有实例的 server 通知，带实例 id；Window Host 按实例转给 Renderer。 */
  onDynamicViewNotifications(input?: undefined): ExtensionEvent<ViewNotification>;
}

/**
 * `extension-window` 频道：扩展进程调 Window Host。只有能力表的两个通用入口，
 * 不为单个能力加方法。subscribe 在 ProxyChannel 上的名字是 onDynamicSubscribe。
 */
export interface IExtensionWindowChannel {
  call(input: CapabilityCallInput): Promise<unknown>;
  /** 事件是信封（§17.3「订阅的错误」）：error 结束这次订阅。 */
  onDynamicSubscribe(
    input: CapabilitySubscribeInput,
  ): ExtensionEvent<CapabilitySubscriptionMessage>;
}

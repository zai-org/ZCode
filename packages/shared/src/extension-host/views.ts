import { z } from "zod";
import type { CapabilityDisposable } from "#src/extension-host/capabilities.js";
import {
  resolvedScopeSchema,
  workspaceRefSchema,
  type ResolvedScope,
} from "#src/extension-host/slots.js";

// 扩展视图（docs/plugins/extension-host.md §8）：页面是 MCP App 页面，后端是扩展进程里的 MCP server。
// 两种写法（宿主帮手 / 插件自己的 McpServer）都经进程内 transport 连一个 MCP Client，之后走同一条路径。

/** 页面资源 URI 固定为 `ui://<pluginId>/<viewId>`，清单不写。 */
export function extensionViewResourceUri(pluginId: string, viewId: string): string {
  return `ui://${pluginId}/${viewId}`;
}

/**
 * 页面经 MCP App 页面层（window.zcode）发起、宿主转给视图 MCP server 的请求方法。
 * 表外的方法一律拒绝：页面不能借视图通道调别的 MCP 方法。
 */
export const EXTENSION_VIEW_REQUEST_METHODS = [
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
] as const;
export type ExtensionViewRequestMethod = (typeof EXTENSION_VIEW_REQUEST_METHODS)[number];

/** 实例 id 由 Window Host 生成，每次打开唯一；扩展进程换代后旧实例全部失效。 */
const instanceIdSchema = z.string().min(1).max(128);
const paramsSchema = z.record(z.string(), z.unknown());

/**
 * 视图实例的打开对象（§16.5）。file.viewer 打开文件时带 `{ kind: "file" }`：path 是工作区相对的
 * posix 路径，绝对路径是 workspace.workspacePath 加上它。从启动页、导航或 views.open 打开时没有。
 */
export const extensionViewInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    path: z.string().min(1).max(4096),
    workspace: workspaceRefSchema,
  }),
]);
export type ExtensionViewInput = z.infer<typeof extensionViewInputSchema>;

// —— extension-host 频道的视图方法（Window Host → 扩展进程）——

export const openViewInputSchema = z.strictObject({
  instanceId: instanceIdSchema,
  /** 视图全局 id：`<pluginId>/<viewId>`。 */
  viewId: z.string().min(1),
  scope: resolvedScopeSchema,
  input: extensionViewInputSchema.optional(),
});
export type OpenViewInput = z.infer<typeof openViewInputSchema>;

/** 页面资源 resources/read 的原始 contents；挑 HTML、限大小、读资源 meta 在 Window Host 做。 */
export const openViewResultSchema = z.strictObject({
  contents: z.array(paramsSchema),
});
export type OpenViewResult = z.infer<typeof openViewResultSchema>;

export const viewRequestInputSchema = z.strictObject({
  instanceId: instanceIdSchema,
  method: z.enum(EXTENSION_VIEW_REQUEST_METHODS),
  params: paramsSchema.optional(),
});
export type ViewRequestInput = z.infer<typeof viewRequestInputSchema>;

export const closeViewInputSchema = z.strictObject({ instanceId: instanceIdSchema });
export type CloseViewInput = z.infer<typeof closeViewInputSchema>;

/** 视图 MCP server 发给页面的通知（resources/updated、list_changed 等），按实例路由。 */
export const viewNotificationSchema = z.strictObject({
  instanceId: instanceIdSchema,
  method: z.string().min(1),
  params: paramsSchema.optional(),
});
export type ViewNotification = z.infer<typeof viewNotificationSchema>;

// —— ctx.views 的形状 ——

/** 普通 JSON Schema 对象。写法一由宿主原样放进 tools/list，不替插件校验入参。 */
export type JsonSchemaObject = { type: "object" } & Record<string, unknown>;

export interface ViewInstance {
  /** 实例 id：每次打开唯一，可用作插件侧的按实例状态键。 */
  readonly id: string;
  /** 视图 id（清单里声明的本地 id）。 */
  readonly viewId: string;
  readonly scope: ResolvedScope;
  /** scope 是会话时的简写。 */
  readonly sessionId?: string;
  /** 打开对象：file.viewer 打开文件时是 `{ kind: "file", path, workspace }`（§16.5），其余为空。 */
  readonly input?: ExtensionViewInput;
  /** 资源变了：只发给订阅了该 uri 的页面。 */
  notify(uri: string): void;
  onDidClose(listener: () => void): CapabilityDisposable;
}

export interface ViewCall {
  view: ViewInstance;
}

export interface ViewTool {
  description?: string;
  inputSchema?: JsonSchemaObject;
  /** 返回值：带 content 数组的对象原样作为 CallToolResult；其他值序列化为文本，对象另放进 structuredContent。 */
  run(input: unknown, call: ViewCall): unknown;
}

export interface ViewResource {
  mimeType?: string;
  read(call: ViewCall): string | Promise<string>;
}

export interface ViewDefinition {
  /** 相对插件根目录，不能跳出根目录；每次打开视图时读取。 */
  entry: string;
  /**
   * 实例打开时调用（§16.11）：插件在这里登记按实例的状态，并用 view.onDidClose 回收。
   * 抛错或 Promise 失败时这次打开失败。写法二的工厂本身就是打开回调。
   */
  onDidOpen?(view: ViewInstance): void | Promise<void>;
  tools?: Record<string, ViewTool>;
  resources?: Record<string, ViewResource>;
}

/** 写法二返回的对象：实现了 connect(transport) 的 MCP server（如 SDK 的 McpServer），只按结构判断。 */
export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close?(): Promise<void>;
}

export type ViewServerFactory = (view: ViewInstance) => McpServerLike | Promise<McpServerLike>;

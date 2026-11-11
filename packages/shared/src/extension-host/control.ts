import { z } from "zod";
import {
  extensionLogEntrySchema,
  extensionLogsSnapshotSchema,
  getExtensionLogsInputSchema,
} from "#src/extension-host/logs.js";

// L0 控制面（docs/plugins/extension-host.md §3.2、§12.1）：Main ⇄ 扩展进程、Main ⇄ Window Host
// 走 parentPort 普通消息，只管生命周期。业务数据走 L1（channels.ts），不经 Main。

const genSchema = z.number().int().positive();

/** 扩展进程状态的唯一 owner 是 Main 的监管器。 */
export const EXTENSION_HOST_STATES = ["starting", "running", "restarting", "stopped"] as const;
export const extensionHostStatusSchema = z.strictObject({
  state: z.enum(EXTENSION_HOST_STATES),
  /** 当前（或即将启动的）代际。 */
  gen: z.number().int().nonnegative(),
  /** stopped / restarting 的原因（崩溃、卡死等），只用于展示与日志。 */
  reason: z.string().optional(),
});
export type ExtensionHostStatus = z.infer<typeof extensionHostStatusSchema>;

// —— Main → 扩展进程 ——
export const mainToExtensionHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("extension-host/init"), gen: genSchema }),
  // 带一个 MessagePortMain：与 Window Host 直连的 L1 端口。
  z.strictObject({ type: z.literal("extension-host/attach-window"), gen: genSchema }),
  z.strictObject({ type: z.literal("extension-host/probe"), seq: z.number().int() }),
  z.strictObject({ type: z.literal("extension-host/dispose") }),
]);
export type MainToExtensionHostMessage = z.infer<typeof mainToExtensionHostMessageSchema>;

// —— 扩展进程 → Main ——
export const extensionHostToMainMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("extension-host/ready"), gen: genSchema }),
  z.strictObject({ type: z.literal("extension-host/probe-ack"), seq: z.number().int() }),
  z.strictObject({
    type: z.literal("extension-host/log"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    pluginId: z.string().optional(),
  }),
  // 计划重启：已激活扩展的清单变了，Node 无法卸载已加载模块。不计入崩溃预算。
  z.strictObject({ type: z.literal("extension-host/request-restart"), reason: z.string() }),
]);
export type ExtensionHostToMainMessage = z.infer<typeof extensionHostToMainMessageSchema>;

// —— Main → Window Host ——
export const mainToExtensionWindowMessageSchema = z.discriminatedUnion("type", [
  // 带一个 MessagePortMain：与扩展进程直连的 L1 端口。
  z.strictObject({ type: z.literal("extension-host/pair"), gen: genSchema }),
  z.strictObject({ type: z.literal("extension-host/status"), status: extensionHostStatusSchema }),
  // 日志控制台（§16.8）：同一轮事件循环追加的条目一批；getLogs 的回包按 requestId 配对。
  z.strictObject({
    type: z.literal("extension-host/logs"),
    entries: z.array(extensionLogEntrySchema).min(1),
  }),
  z.strictObject({
    type: z.literal("extension-host/logs-snapshot"),
    requestId: z.string().min(1),
    ...extensionLogsSnapshotSchema.shape,
  }),
]);
export type MainToExtensionWindowMessage = z.infer<typeof mainToExtensionWindowMessageSchema>;

// —— Window Host → Main ——
export const extensionWindowToMainMessageSchema = z.discriminatedUnion("type", [
  // Window Host 的服务已就绪，可以牵线。
  z.strictObject({ type: z.literal("extension-host/window-ready") }),
  // 重新加载：Main 清零崩溃预算并重启。不经过扩展进程，卡死或已停止时也能用。
  z.strictObject({ type: z.literal("extension-host/reload") }),
  // 日志快照请求（§16.8）：Main 收到即回 logs-snapshot，Window Host 不留副本。
  z.strictObject({
    type: z.literal("extension-host/logs-request"),
    requestId: z.string().min(1),
    ...getExtensionLogsInputSchema.shape,
  }),
]);
export type ExtensionWindowToMainMessage = z.infer<typeof extensionWindowToMainMessageSchema>;

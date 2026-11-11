import { z } from "zod";

// 扩展日志控制台（docs/plugins/extension-host.md §16.8）。缓冲的唯一 owner 是 Main 的监管器：
// Main 把追加的条目按事件循环成批推给 Window Host，Window Host 只转发给 Renderer；
// 快照由 Window Host 向 Main 请求（控制消息见 control.ts）。

/** Main 缓冲与 Renderer 视图最多留的条数。 */
export const EXTENSION_LOG_BUFFER_LIMIT = 2000;
/** 每条 message 的上限（UTF-8 字节，含截断标记）。日志文件照写完整内容。 */
export const EXTENSION_LOG_MESSAGE_MAX_BYTES = 4096;
export const EXTENSION_LOG_TRUNCATED_MARKER = "…[truncated]";

export const EXTENSION_LOG_LEVELS = ["info", "warn", "error"] as const;
export type ExtensionLogLevel = (typeof EXTENSION_LOG_LEVELS)[number];

export const extensionLogEntrySchema = z.strictObject({
  /** Main 生命周期内从 1 开始递增。 */
  seq: z.number().int().positive(),
  /** Main 收到的时间（毫秒）。 */
  ts: z.number().int().nonnegative(),
  level: z.enum(EXTENSION_LOG_LEVELS),
  /** 该行所属的扩展进程代际；监管器的行取它描述的代际。 */
  gen: z.number().int().nonnegative(),
  /** 只有扩展的 ctx.log 与归因到插件的未捕获错误带插件 id；扩展进程与监管器的行没有。 */
  pluginId: z.string().min(1).optional(),
  /** 不含日志文件里的 `[extension-host] gen=N [pluginId]` 前缀。 */
  message: z.string(),
});
export type ExtensionLogEntry = z.infer<typeof extensionLogEntrySchema>;

export const getExtensionLogsInputSchema = z.strictObject({
  /** 只要这个 seq 之后的条目；缺省时要整个缓冲。 */
  sinceSeq: z.number().int().nonnegative().optional(),
});
export type GetExtensionLogsInput = z.infer<typeof getExtensionLogsInputSchema>;

export const extensionLogsSnapshotSchema = z.strictObject({
  entries: z.array(extensionLogEntrySchema),
  /** Main 当前最后的 seq（缓冲为空时为 0）。接收方以它为准，被挤出缓冲的条目不再补。 */
  lastSeq: z.number().int().nonnegative(),
});
export type ExtensionLogsSnapshot = z.infer<typeof extensionLogsSnapshotSchema>;

function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  // 孤立代理项按 U+FFFD（3 字节）计。
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** 截断标记本身的 UTF-8 字节数（「…」占 3 字节）。 */
const TRUNCATED_MARKER_BYTES = 3 + "[truncated]".length;

/**
 * 超过上限时按 UTF-8 字节截断（不拆开字符），末尾加截断标记；结果不超过 maxBytes。
 * 纯函数，Renderer 可达：不用 Node 的 Buffer。
 */
export function truncateExtensionLogMessage(
  message: string,
  maxBytes: number = EXTENSION_LOG_MESSAGE_MAX_BYTES,
): string {
  // 每个 UTF-16 码元最多 3 字节：短消息不用逐字计算。
  if (message.length * 3 <= maxBytes) return message;
  const budget = maxBytes - TRUNCATED_MARKER_BYTES;
  let bytes = 0;
  let cut = -1;
  for (let index = 0; index < message.length; ) {
    const codePoint = message.codePointAt(index) ?? 0;
    bytes += utf8Bytes(codePoint);
    // 记下放得下标记的最后位置；整条确实超过上限时才在这里截断。
    if (cut < 0 && bytes > budget) cut = index;
    if (bytes > maxBytes) return `${message.slice(0, cut)}${EXTENSION_LOG_TRUNCATED_MARKER}`;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return message;
}

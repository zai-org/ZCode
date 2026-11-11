import type { ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";
import { textFromZCodeMessageParts } from "./zcode-protocol-legacy-types.js";
import type { ZCodeStreamEvent } from "./zcode-task-types-core.js";
import { subagentResultMetaSchema } from "./zcode-protocol-v4/workflow-row-meta.js";

export interface ZCodeBackgroundTaskNotificationInfo {
  error?: string;
  outputFile?: string;
  result?: string;
  status?: string;
  summary?: string;
  taskId?: string;
}

const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_CLOSE = "</task-notification>";

export interface ZCodeParsedBackgroundTaskNotification {
  notification: ZCodeBackgroundTaskNotificationInfo;
  toolUseId: string;
}

/**
 * 一条消息可能是多条通知合并而成；按 `<task-notification>` 块逐条解析，每块只读块内的标签。
 * 修复原因：在整段文本里取第一个匹配会跨块读取——失败任务没有 `<result>` 时读到下一条通知的
 * `<result>`，被当成失败原因；后面的任务也得不到终态。
 * `originMeta` 是通知所在轮的 originMeta（未校验）。后台 Agent 的终态与失败原文以其中的
 * `subagentResult` 为准，通知正文不带 <error>；它只描述单条通知，所以只在只有一个块时使用。
 * 旧会话和合并轮没有它，读块内的 <status> / <error>。不解析 summary 文本：产品数据不依赖模型可见文案。
 */
export function parseZCodeBackgroundTaskNotifications(
  text: string | undefined,
  originMeta?: unknown,
): ZCodeParsedBackgroundTaskNotification[] {
  const trimmed = text?.trim();
  if (!trimmed?.startsWith(TASK_NOTIFICATION_OPEN)) {
    return [];
  }
  const blocks = trimmed
    .split(TASK_NOTIFICATION_OPEN)
    .slice(1)
    .map((block) => block.split(TASK_NOTIFICATION_CLOSE)[0]!);
  const subagentResult =
    blocks.length === 1
      ? subagentResultMetaSchema.safeParse(asPlainRecord(originMeta).subagentResult).data
      : undefined;
  return blocks.flatMap((block) => {
    const toolUseId = readTaskNotificationTag(block, "tool-use-id");
    if (!toolUseId) {
      return [];
    }
    const status = subagentResult?.status ?? readTaskNotificationTag(block, "status");
    return [
      {
        toolUseId,
        notification: {
          error: subagentResult ? subagentResult.error : readTaskNotificationTag(block, "error"),
          outputFile: readTaskNotificationTag(block, "output-file"),
          result: isModelOnlyPartialResult(block, status)
            ? undefined
            : readTaskNotificationTag(block, "result"),
          status,
          summary: readTaskNotificationTag(block, "summary"),
          taskId: readTaskNotificationTag(block, "task-id"),
        },
      },
    ];
  });
}

/**
 * 修复原因（2026-11-09）：后台 Agent 失败时，通知的 `<result>` 是子代理没写完的部分报告，只给模型续接用。
 * 合并轮没有结构化 error，失败原因会依次退到 result，卡片 output 和失败 hover 显示的是半截正文，
 * 而不是 summary 里的失败原因。只有 local agent 通知带 `<note>`；workflow 失败通知不带，它的
 * `<result>` 是 run 的结果，照常读取。
 */
function isModelOnlyPartialResult(block: string, status: string | undefined): boolean {
  return status === "failed" && readTaskNotificationTag(block, "note") !== undefined;
}

export function collectZCodeBackgroundTaskNotificationsByToolUseId(
  messages: readonly ZCodeMessageWithParts[],
): Map<string, ZCodeBackgroundTaskNotificationInfo> {
  const notifications = new Map<string, ZCodeBackgroundTaskNotificationInfo>();
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }
    for (const parsed of parseZCodeBackgroundTaskNotifications(
      textFromZCodeMessageParts(message.parts),
      message.info.metadata?.originMeta,
    )) {
      notifications.set(parsed.toolUseId, parsed.notification);
    }
  }
  return notifications;
}

/**
 * 失败通知在 App 上展示的原因：优先用结构化结果或 <error> 原文；合并轮两者都没有时，
 * 用这条通知自己的 result / summary 整句（与 V4 投影相同），不从 summary 里截取原因。
 */
export function zcodeBackgroundTaskNotificationFailureText(
  notification: ZCodeBackgroundTaskNotificationInfo,
): string | undefined {
  return notification.error ?? notification.result ?? notification.summary;
}

export function zcodeBackgroundTaskNotificationToolUpdateStatus(
  status: string | undefined,
): Extract<
  Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  "completed" | "failed" | "stopped"
> {
  if (status === "failed" || status === "lost") {
    return "failed";
  }
  // task-notification 的 killed/stopped 都表示被停止，不能折成 completed。
  if (status === "stopped" || status === "killed") {
    return "stopped";
  }
  return "completed";
}

export function attachZCodeBackgroundTaskNotificationToRaw(
  raw: unknown,
  notification: ZCodeBackgroundTaskNotificationInfo | undefined,
): unknown {
  if (!notification) {
    return raw;
  }
  const record = asPlainRecord(raw);
  const meta = asPlainRecord(record._meta);
  const zcode = asPlainRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcode,
        taskNotification: notification,
      },
    },
  };
}

function readTaskNotificationTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u"));
  const value = match?.[1]?.trim();
  return value ? decodeTaskNotificationXmlText(value) : undefined;
}

function decodeTaskNotificationXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  modelMessageContentToText,
  traceContextToLogContext,
  type MessageId,
  type MessageProjectionAnchor,
  type MessageWithParts,
  type Model,
  type TraceContext,
} from "@zcode/contracts";
import {
  INTERRUPT_MARKER_SOURCE,
  OUTPUT_TOKEN_CONTINUATION_SOURCE,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 普通 user 文本的隐藏记录：正文是消息原文，不是 system-reminder 附件。 */
const PLAIN_TEXT_REMINDER_SOURCES: ReadonlySet<string> = new Set([
  INTERRUPT_MARKER_SOURCE,
  OUTPUT_TOKEN_CONTINUATION_SOURCE,
]);

/**
 * 普通收集和 compact 共用隐藏提醒落盘，正文与 runtime metadata 写入同一 text part。
 * 返回带时间的条目：行的 time.created 与条目时间相同，调用方提交这一份，冷恢复读回的条目与 live 相同。
 */
export async function persistRuntimeReminderMessage<T extends RuntimeMessageEntry>(
  this: AgentRuntimeInternal,
  entry: T,
  traceContext: TraceContext,
  options: RuntimeReminderMessageOptions = {},
): Promise<T> {
  const timed: T =
    entry.time === undefined ? { ...entry, time: options.created ?? this.now().getTime() } : entry;
  if (!this.sessionStore) return timed;
  const record = buildRuntimeReminderMessage(this, timed, options);
  if (!record) return timed;
  try {
    await this.persistMessage(record.info, traceContext);
    for (const part of record.parts) await this.persistPart(part, traceContext);
    return timed;
  } catch (error) {
    await removeRuntimePersistenceMessagesBestEffort.call(this, [record.info.id], traceContext);
    throw error;
  }
}

interface RuntimeReminderMessageOptions {
  created?: number;
  model?: Model;
  anchor?: MessageProjectionAnchor;
}

/** 只构建隐藏提醒记录，不写入；compact 用它把整组记录交给同一事务。 */
export function buildRuntimeReminderMessage(
  runtime: AgentRuntimeInternal,
  entry: RuntimeMessageEntry,
  options: RuntimeReminderMessageOptions = {},
): MessageWithParts | undefined {
  if (!entry.metadata) return;
  // 中断标记与 Continue 是普通 user 文本，不是 system-reminder 附件，正文取消息文本。
  const content = isRuntimeAttachmentEntry(entry)
    ? entry.content
    : entry.metadata.toolSearchAnnouncement ||
        PLAIN_TEXT_REMINDER_SOURCES.has(entry.metadata.source)
      ? modelMessageContentToText(entry.message.content)
      : undefined;
  if (content === undefined) return;

  // 条目已带时间时行用同一个时间，冷恢复读回的条目时间与 live 相同。
  const created = options.created ?? entry.time ?? Date.now();
  const messageID = createMessageId();
  return {
    info: {
      id: messageID,
      sessionID: runtime.sessionId,
      role: "user",
      time: { created },
      agent: runtime.config.agentName ?? "zcode-agent",
      metadata: reminderPartMetadata(entry.metadata),
      modelSelection: resolvePersistedReminderModel(runtime, options.model),
      ...(options.anchor ? { anchor: options.anchor } : {}),
      semantics: {
        origin: "agent_runtime",
        kind: "system_reminder",
        source: entry.metadata.source,
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      synthetic: true,
      // 工具名单与 system prompt 只写在用户输入记录上：隐藏提醒条数多，每条都存一份会让数据库重复膨胀。
      visibility: "model-only",
    },
    parts: [
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: { start: created, end: created },
        metadata: reminderPartMetadata(entry.metadata),
      },
    ],
  };
}

export function resolvePersistedReminderModel(runtime: AgentRuntimeInternal, model?: Model) {
  if (model) return { providerId: model.providerId, modelId: model.modelId };
  const selection = runtime.getSessionModelSelection();
  return selection
    ? {
        providerId: createModelProviderId(selection.providerId),
        modelId: createModelId(selection.modelId),
      }
    : undefined;
}

export async function removeRuntimePersistenceMessagesBestEffort(
  this: AgentRuntimeInternal,
  messageIds: readonly MessageId[],
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;
  for (const rollbackMessageId of new Set(messageIds)) {
    try {
      await this.sessionStore.removeMessage({
        sessionID: this.sessionId,
        messageID: rollbackMessageId,
      });
    } catch (cleanupError) {
      this.logger?.warn("Runtime message persistence cleanup failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        event: "runtime.persistence.cleanup_failed",
        messageId: rollbackMessageId,
        module: "core.runtime",
      });
    }
  }
}

function reminderPartMetadata(runtimeMessage: RuntimeMessageMetadata): Record<string, unknown> {
  return { runtimeMessage, source: runtimeMessage.source, visibility: "model-only" };
}

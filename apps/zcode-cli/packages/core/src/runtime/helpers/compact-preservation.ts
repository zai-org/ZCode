import type {
  CompactPreservedSegment,
  MessageId,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import { isCompactPreservableSessionMessage } from "../../agent/compact-session.js";
import { activeSessionMessages } from "../../agent/session-history-hydrator.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { SYSTEM_REMINDER_PERSISTED_SOURCES } from "../../system-reminder/source.js";

export async function selectPersistedCompactTail(input: {
  sessionStore: SessionStorePort;
  sessionId: SessionId;
  summaryMessageId: MessageId;
  groupsPreserved: number;
}): Promise<{ preservedSegment?: CompactPreservedSegment; keptMessageCount: number }> {
  if (input.groupsPreserved <= 0) return { keptMessageCount: 0 };
  const [messages, session] = await Promise.all([
    input.sessionStore.messages({ sessionID: input.sessionId }),
    input.sessionStore.getSession(input.sessionId),
  ]);
  const revert = session?.revert;
  const active = activeSessionMessages(messages, {
    branchCutAfterMessageId: revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: revert?.createdMessageID,
    rewindKeptMessageIds: revert?.keptMessageIDs,
    rewindTargetMessageId: revert?.targetMessageID,
  }).filter(isCompactPreservableSessionMessage);
  // 原因：runtime 与数据库的 user/attachment 数量不是一一对应，尤其 synthetic
  // 来源改变后会错位。复用 compact 的 assistant 分组，数量只统计选定结果。
  const kept = groupByAssistantStartedRounds(active, (message) => message.info.role)
    .slice(-input.groupsPreserved)
    .flat();
  if (kept.length === 0) return { keptMessageCount: 0 };
  return {
    keptMessageCount: kept.length,
    preservedSegment: {
      anchorMessageId: input.summaryMessageId,
      headMessageId: kept[0]!.info.id,
      tailMessageId: kept.at(-1)!.info.id,
    },
  };
}

/** 无 SessionStore 时仅用于统计，不能用此数量选择持久化区间。 */
export function countCompactPreservedRuntimeMessages(
  entries: readonly RuntimeMessageEntry[],
): number {
  return entries.filter((entry) => {
    if (isRuntimeAttachmentEntry(entry)) {
      return SYSTEM_REMINDER_PERSISTED_SOURCES.some((source) => source === entry.metadata.source);
    }
    return entry.message.role === "assistant" || entry.message.role === "user";
  }).length;
}

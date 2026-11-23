/**
 * 编辑重发 / 会话回退 / 只撤销文件的业务埋点（docs/monitoring/conversation-telemetry-v4.md
 * 「编辑重发与回退」）。只输出低基数枚举、计数和命令 ID，不带正文、路径或错误原文。
 */

export const CONVERSATION_REWIND_EVENT = "conversation_rewind";

export type ConversationRewindAction = "edit_resend" | "file_only";

/** 只读取埋点需要的行字段；结构化类型避免依赖完整 V4 row union。 */
export interface ConversationRewindRowLike {
  kind: string;
  rowId: number;
  turnId: string;
  sourceCommandId?: string;
  state?: string;
  fileChanges?: { files: number };
}

/** 被回退的那一轮在命令发出前的状态；必须在 dispatch 前取，ACK 后行已被截断。 */
export interface ConversationRewindTarget {
  targetMessageId: string;
  targetTurnState: string;
  targetTurnFiles: string;
  discardedTurns: number;
}

const TURN_STATES = new Set(["running", "completedSuccess", "completedInterrupted", "failed"]);

const EDIT_BLOCKED_REASONS: Readonly<Record<string, string>> = {
  "guard.workspaceRewindUnsafeFiles": "unsafe_files",
  "guard.workspaceRewindIgnoredFiles": "ignored_files",
  "guard.workspaceRewindUnavailable": "unavailable",
  "guard.workspaceRewindApplyConflict": "apply_conflict",
};

const ACK_STATUSES = new Set(["accepted", "duplicate", "rejected", "stale", "failed", "noop"]);

export function resolveConversationRewindTarget(
  rows: readonly ConversationRewindRowLike[],
  targetRowId: number,
): ConversationRewindTarget {
  const turnId = rows.find((row) => row.rowId === targetRowId)?.turnId;
  const header =
    turnId === undefined
      ? undefined
      : rows.find((row) => row.kind === "turnHeader" && row.turnId === turnId);
  if (!header) {
    return {
      targetMessageId: "",
      targetTurnState: "unknown",
      targetTurnFiles: "",
      discardedTurns: 0,
    };
  }
  const files = header.fileChanges?.files;
  return {
    targetMessageId: header.sourceCommandId ?? "",
    targetTurnState: header.state && TURN_STATES.has(header.state) ? header.state : "unknown",
    targetTurnFiles:
      typeof files === "number" && Number.isInteger(files) && files >= 0 ? String(files) : "",
    // 编辑会截掉目标轮及其后的全部轮次（后台结果、goal 续跑轮）。
    discardedTurns: rows.filter((row) => row.kind === "turnHeader" && row.rowId >= header.rowId)
      .length,
  };
}

export interface ConversationRewindAckLike {
  status: string;
  result?: {
    type: string;
    disposition?: string;
    reasonCode?: string;
    applied?: boolean;
    preview?: { safeFiles: readonly unknown[] };
  };
}

function rewindOutcome(
  action: ConversationRewindAction,
  ack: ConversationRewindAckLike,
): { result: "accepted" | "blocked" | "rejected"; blockedReason: string; restoredFiles: string } {
  if (ack.status !== "accepted" && ack.status !== "duplicate") {
    return { result: "rejected", blockedReason: "", restoredFiles: "" };
  }
  const result = ack.result;
  if (action === "edit_resend") {
    if (result?.type === "editUserQuery" && result.disposition === "blocked") {
      return {
        result: "blocked",
        blockedReason: EDIT_BLOCKED_REASONS[result.reasonCode ?? ""] ?? "other",
        restoredFiles: "",
      };
    }
    return { result: "accepted", blockedReason: "", restoredFiles: "" };
  }
  // ACK accepted 只代表命令被收下；applied=false 是文件状态已变、未真正撤销。
  if (result?.type === "applyFileRewind" && result.applied === true) {
    return {
      result: "accepted",
      blockedReason: "",
      restoredFiles: String(result.preview?.safeFiles.length ?? 0),
    };
  }
  return { result: "blocked", blockedReason: "not_applied", restoredFiles: "" };
}

export function buildConversationRewindTelemetryEvent(input: {
  action: ConversationRewindAction;
  sessionId: string;
  /** 本次 editUserQuery / applyFileRewind 命令 ID；编辑重发时即新一轮的 message_id。 */
  commandId: string;
  target: ConversationRewindTarget;
  workspaceMode?: "preserve" | "rewind";
  ack: ConversationRewindAckLike;
}): {
  elementName: typeof CONVERSATION_REWIND_EVENT;
  eventRegion: "chat";
  eventType: "result";
  eventExtraDetail: Record<string, string>;
  talkId: string;
  messageId: string;
} {
  const outcome = rewindOutcome(input.action, input.ack);
  const isEdit = input.action === "edit_resend";
  return {
    elementName: CONVERSATION_REWIND_EVENT,
    eventRegion: "chat",
    eventType: "result",
    talkId: input.sessionId,
    messageId: input.commandId,
    eventExtraDetail: {
      action: input.action,
      workspace_mode: isEdit ? (input.workspaceMode ?? "preserve") : "",
      result: outcome.result,
      ack_status: ACK_STATUSES.has(input.ack.status) ? input.ack.status : "other",
      blocked_reason: outcome.blockedReason,
      target_message_id: input.target.targetMessageId,
      target_turn_state: input.target.targetTurnState,
      target_turn_files: input.target.targetTurnFiles,
      discarded_turns: isEdit ? String(input.target.discardedTurns) : "",
      restored_files: outcome.restoredFiles,
    },
  };
}

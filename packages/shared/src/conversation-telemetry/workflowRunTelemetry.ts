/**
 * Workflow run 的结算结果（docs/monitoring/business-monitoring.md「Workflow run 结果」）。
 * 由 `workflow.lifecycle(run-settled)` fact 派生，每次结算都报：ResumeWorkflowRun / 侧板恢复沿用同一个
 * runId，恢复后的那一世会再结算一次；数据侧按 runId 取最后一次作为最终结果。
 * 只输出枚举、计数和 ID，不带 errorMessage 原文。
 */
import { redactTelemetryText } from "../telemetryRedaction.js";

export const WORKFLOW_RUN_RESULT_EVENT = "workflow_run_result";

/** run 终态，与 `workflowLifecycleFactSchema.status`、dwf 引擎 RunStatus 的三个终态同集。 */
export const WORKFLOW_RUN_RESULT_STATUSES = ["completed", "stopped", "errored"] as const;
/** 停止原因，与 `workflowLifecycleFactSchema.stopReason`、dwf 引擎 RunStopReason 同集（单测按源码校验）。 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

const STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_RUN_RESULT_STATUSES);
const STOP_REASON_SET: ReadonlySet<string> = new Set(WORKFLOW_RUN_STOP_REASONS);
const MAX_RUN_ID_LENGTH = 128;
const RUN_ID_PATTERN = /^[A-Za-z0-9_.:@-]+$/u;

function safeRunId(value: string): string {
  return value.length <= MAX_RUN_ID_LENGTH &&
    RUN_ID_PATTERN.test(value) &&
    redactTelemetryText(value) === value
    ? value
    : "";
}

export function buildWorkflowRunResultTelemetryEvent(input: {
  /** 发起 run 的父会话。 */
  sessionId: string;
  /** fact 的 sourceCommandId，即发起 run 那一轮的 inputId（与该轮 send_btn / agent_step 的 message_id 相同）。 */
  sourceCommandId?: string;
  runId: string;
  status?: string;
  stopReason?: string;
  /** 本窗口为这个 run 看到的去重子 agent 数。 */
  actorCount: number;
}): {
  elementName: typeof WORKFLOW_RUN_RESULT_EVENT;
  eventRegion: "app";
  eventType: "result";
  eventExtraDetail: Record<string, string>;
  talkId: string;
  messageId?: string;
} {
  const status = STATUS_SET.has(input.status ?? "") ? input.status! : "other";
  // 只在 stopped 时有原因；stopped 却缺原因（CLI 遇到不认识的引擎原因会丢掉）或不在白名单时记 other。
  const stopReason =
    status === "stopped"
      ? STOP_REASON_SET.has(input.stopReason ?? "")
        ? input.stopReason!
        : "other"
      : "";
  const actorCount =
    Number.isFinite(input.actorCount) && input.actorCount > 0 ? Math.floor(input.actorCount) : 0;
  return {
    elementName: WORKFLOW_RUN_RESULT_EVENT,
    eventRegion: "app",
    eventType: "result",
    talkId: input.sessionId,
    ...(input.sourceCommandId ? { messageId: input.sourceCommandId } : {}),
    eventExtraDetail: {
      workflow_run_id: safeRunId(input.runId),
      status,
      stop_reason: stopReason,
      actor_count: String(actorCount),
    },
  };
}

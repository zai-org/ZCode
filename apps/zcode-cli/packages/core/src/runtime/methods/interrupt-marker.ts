import { CoreErrorType, type TraceContext } from "@zcode/contracts";
import { traceContextToLogContext, type ToolExecutionResult } from "../deps.js";
import { INTERRUPT_MARKER_SOURCE, type RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

/** 用户停止本轮后，下一次请求里模型看到的标记：模型请求阶段与工具执行阶段文字不同。 */
const INTERRUPT_MARKER = "[Request interrupted by user]";
const TOOL_USE_INTERRUPT_MARKER = "[Request interrupted by user for tool use]";

/** 用户停止时，被取消的工具（未开始、执行中、等待权限）统一给模型这段文字。 */
export const USER_STOPPED_TOOL_RESULT_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/**
 * 用户停止的工具批次：被取消的工具结果改用上面的固定文字。
 * 只换给模型的 modelContent（冷恢复从 part metadata 重放同一文字）；error.message 不变，
 * 工具卡片仍显示各工具自己的取消原因。停止前已完成的结果保持原样。
 * send-now 抢占不换：它是为了交付下一条输入，保持各工具自己的取消文字。
 */
export function withUserStoppedToolResultContent(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  results: ToolExecutionResult[],
): ToolExecutionResult[] {
  if (!state.turnAbortSignal.aborted) return results;
  if (runtime.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true) return results;
  return results.map((result) =>
    result.error?.type === CoreErrorType.ToolCancelled
      ? { ...result, modelContent: USER_STOPPED_TOOL_RESULT_CONTENT }
      : result,
  );
}

/**
 * 停止的轮次在已提交的 assistant / tool result 之后追加一条普通 user 文本标记。
 * 持久化成功才写入历史；冷恢复按 runtimeMessage.source 还原同一条 entry。
 * 与动态公告同一种隐藏提醒记录，不写顶层 source：旧版本 App 按封闭列表校验该字段。
 */
export async function appendInterruptMarker(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  traceContext: TraceContext,
): Promise<void> {
  const text = state.interruptedDuringToolBatch ? TOOL_USE_INTERRUPT_MARKER : INTERRUPT_MARKER;
  let entry: RuntimeMessageEntry = {
    message: { role: "user", content: text },
    metadata: { source: INTERRUPT_MARKER_SOURCE },
  };
  try {
    // 与其他隐藏提醒一样不移动对话指针。
    entry = await persistRuntimeReminderMessage.call(runtime, entry, traceContext, {
      anchor: buildProjectionAnchor(traceContext, "synthetic"),
    });
  } catch (error) {
    // 取消错误仍要继续上抛；标记写入失败只缺这一条上下文，不能替换取消结果。
    runtime.logger?.warn("Failed to persist interrupt marker", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "turn.interrupt_marker.persist_failed",
      module: "core.runtime",
    });
    return;
  }
  commitTurnRequestEntries(runtime, state.turnRequestState, [entry]);
}

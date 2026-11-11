import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { applySubmissionExecutionState, sameModelSelection } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";

/**
 * 在合法的 model-step 边界按 FIFO 一次消费全部已等待的 guide，并准备下一次 provider request。
 * SendMessage 可能在 child 的 model request 进行中到达；若该 step 正常
 * text-only 收口，等待未来 tool batch 会把 coordinator input 永久留在无人唤醒的 queue。
 */
export async function drainInlineGuideForNextRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  // 已停止的轮次不再消费挂起输入，直接结束；guide 由取消路径退回队列。
  throwIfTurnAborted(state.turnAbortSignal);
  const activeTurn = state.activeTurn;
  if (!activeTurn || !runtime.hasInlineGuidePendingInput(activeTurn)) return false;

  const drained = await runtime.drainPendingInput({
    activeTurn,
    events: state.events,
    traceContext: state.turnTraceContext,
  });
  if (!drained || drained.pendingInputIds.length === 0) return false;

  state.drainedSteerForNextRequest = drained;
  appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries ?? []);
  // 固定执行模型只禁止切模，不应连带丢弃 Guide 的权限／Plan 意图。
  if (state.modelSelectionScope === "execution" && drained.intent) {
    await applyRuntimeExecutionState(runtime, drained.intent, {
      source: "command",
      traceContext: state.turnTraceContext,
    });
  }
  const guideModel =
    state.modelSelectionScope === "execution"
      ? undefined
      : await applySubmissionExecutionState(runtime, drained?.intent, state.turnTraceContext);
  if (guideModel) {
    // 配置重新解析不等于切模；比较 Loop 的执行选择，而不是可能已被外部更新的 Session。
    const selectionChanged = !sameModelSelection(state.model, guideModel);
    state.model = guideModel;
    if (selectionChanged) {
      state.turnRequestState.entries = rebuildContextPrefix(runtime, {
        model: guideModel,
        turnRequestEntries: state.turnRequestState.entries,
      });
    }
  }
  state.currentUserMessageId = drained?.latestMessageId ?? state.currentUserMessageId;
  const nextQueryId = drained?.queryIds?.at(-1);
  if (nextQueryId) {
    // guide 以 user role 续上当前 active turn；后续请求归因到最后一条输入的 query。
    state.turnTraceContext = { ...state.turnTraceContext, queryId: nextQueryId };
  }
  // 旧端的 guide 合入同一轮不能借用原附件能力；一批多个输入取交集。
  state.pluginDiscoveryUi = state.pluginDiscoveryUi && drained.pluginDiscoveryUi === true;
  if ((drained.toolDisallowlist?.length ?? 0) > 0) {
    // automation guide 不会重新 start turn，必须把限制合并到当前 loop state。
    state.toolDisallowlist = [
      ...new Set([...(state.toolDisallowlist ?? []), ...(drained.toolDisallowlist ?? [])]),
    ];
  }
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
  return true;
}

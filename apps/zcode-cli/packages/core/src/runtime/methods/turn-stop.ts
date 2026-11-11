import { HookEventName, TurnMachineImpl, createMessageId, createPartId } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { persistAnnouncements } from "./context-refresh.js";
import { buildLifecycleHookContextEntry } from "./hooks.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import {
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
  markRepairedStep,
} from "./turn-output-token-continuation.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";

export interface AssistantPersistenceAnchor {
  latestAssistantMessageId: AgentRuntimeInternal["latestAssistantMessageId"];
  latestAssistantTurnId: AgentRuntimeInternal["latestAssistantTurnId"];
  latestConversationMessageId: AgentRuntimeInternal["latestConversationMessageId"];
}

export function captureAssistantPersistenceAnchor(
  runtime: AgentRuntimeInternal,
): AssistantPersistenceAnchor {
  return {
    latestAssistantMessageId: runtime.latestAssistantMessageId,
    latestAssistantTurnId: runtime.latestAssistantTurnId,
    latestConversationMessageId: runtime.latestConversationMessageId,
  };
}

export async function persistCompletedAssistantStep(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    includeEmptyAssistant: boolean;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<boolean> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed assistant persistence requires the loop Model");
  }
  let committed = commitAssistantToTurnRequest(runtime, state, options.result, undefined);
  if (!committed && options.includeEmptyAssistant) {
    commitTurnRequestEntries(
      runtime,
      state.turnRequestState,
      markRepairedStep(
        [
          createRuntimeAssistantEntry(
            "",
            undefined,
            undefined,
            model,
            toTokenUsageInfo(options.result.usage),
          ),
        ],
        options.result,
      ),
    );
    committed = true;
  }
  if (!committed) {
    if (runtime.sessionStore) {
      await runtime.sessionStore.removeMessage({
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
      });
    }
    if (runtime.latestConversationMessageId === options.assistantMessageId) {
      runtime.latestConversationMessageId =
        options.assistantPersistenceAnchor.latestConversationMessageId;
    }
    if (runtime.latestAssistantMessageId === options.assistantMessageId) {
      runtime.latestAssistantMessageId =
        options.assistantPersistenceAnchor.latestAssistantMessageId;
      runtime.latestAssistantTurnId = options.assistantPersistenceAnchor.latestAssistantTurnId;
    }
    return false;
  }
  const persistedTokens = toTokenUsageInfo(options.result.usage);
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      cost: 0,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      tokens: persistedTokens,
      signedReasoningReset: options.result.signedReasoningReset,
    },
    options.modelTraceContext,
    model,
  );
  return committed;
}

export async function persistOutputTokenLimitErrorCarrier(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    error: { data: Record<string, unknown>; name: string };
    finishReason: string;
    model: Model;
    modelTraceContext: TraceContext;
  },
): Promise<void> {
  const messageId = createMessageId();
  const createdAt = Date.now();
  const tokens = emptyTokenUsageInfo();

  // partial 与终态 error 共用 durable assistant 时，Compact 无法同时重放
  // provider partial 并排除 transcript-only error。两者拆成独立消息后沿用既有过滤边界即可。
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    undefined,
    options.modelTraceContext,
    options.model,
  );
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: messageId,
      type: "step-finish",
      reason: options.finishReason,
      cost: 0,
      tokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    {
      completed: Date.now(),
      error: options.error,
      finish: options.finishReason,
      tokens,
    },
    options.modelTraceContext,
    options.model,
  );
}

export async function finishModelStepWithoutToolCalls(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<"continue" | "break"> {
  if (!state.model) {
    throw new Error("Model-backed turn stop requires the loop Model");
  }
  const assistantCommitted = await persistCompletedAssistantStep(this, state, {
    ...options,
    includeEmptyAssistant: true,
  });
  if (assistantCommitted) recordModelHistoryRound(state);
  if (state.automationCreateLimitReached) {
    // 上限命中后只允许这一轮纯文本说明。跳过 guide 和 Stop hook，避免它们再次
    // 触发模型请求，把已经关闭工具的 turn 延长成新的恢复循环。
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
      state.activeTurn.steerable = false;
    }
    state.stableProductStartMessageId = state.currentUserMessageId;
    state.stableBoundaryAssistantMessageId = options.assistantMessageId;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }
  if (await drainInlineGuideForNextRequest(this, state)) {
    // 正常 text-only 是可续跑边界：assistant 已持久化，guide 以 user role 进入历史，
    // 保持同一 active turn 继续下一次 provider request，不改投 future queue。
    state.inputAttachmentCollectionPending = "text_guide";
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  const stopHookResult = await this.runStopHooks(
    state.modelResponse,
    state.toolCallCount,
    state.turnTraceContext,
    state.turnAbortSignal,
    state.stopHookContinuationCount > 0,
  );
  if (this.shouldContinueAfterStopHooks(stopHookResult, state.stopHookContinuationCount)) {
    state.stopHookContinuationCount += 1;
    // Stop 的上下文写在这次 assistant 之后；先写库再进历史和当前请求，冷恢复原样回放。
    const hookEntry = buildLifecycleHookContextEntry(
      HookEventName.Stop,
      stopHookResult.additionalContexts,
    );
    await persistAnnouncements(
      this,
      state.turnRequestState,
      hookEntry ? [hookEntry] : [],
      state.turnTraceContext,
    );
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  if (state.activeTurn) {
    // FIFO barrier / reservation 阻止本轮安全 inline 时，仍保留既有权威 queue 兜底；
    // 正常可消费的 text-only guide 已在上方作为 user-role continuation drain。
    await this.fallbackPendingGuidesToQueue({
      activeTurn: state.activeTurn,
      events: state.events,
      reasonCode: "guide.noToolBoundary",
      traceContext: state.turnTraceContext,
    });
  }
  if (state.activeTurn) state.activeTurn.steerable = false;
  // assistant completed 只代表 model step 收口；Stop hook 仍可能继续同一 product turn。
  // 只有最终 break 才把它交给 turn.ts 在 goal accounting 后持久化最终 boundary。
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = options.assistantMessageId;
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "success"),
  );
  return "break";
}

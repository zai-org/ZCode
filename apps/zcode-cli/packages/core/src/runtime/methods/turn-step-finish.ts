import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export async function persistToolModelStepFinish(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<void> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed turn step finish requires the loop Model");
  }
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      cost: 0,
      tokens: toTokenUsageInfo(options.result.usage),
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
      tokens: toTokenUsageInfo(options.result.usage),
      signedReasoningReset: options.result.signedReasoningReset,
    },
    options.modelTraceContext,
    model,
  );
}

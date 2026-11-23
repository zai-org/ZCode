import {
  CompactPhase,
  SessionEventType,
  buildDefaultMicrocompactThreshold,
  getAutoCompactThreshold,
  traceContextToLogContext,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  LocalMicrocompactPolicyConfig,
  Model,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import { maybeLocalMicrocompactRuntimeEntries, throwIfTurnAborted } from "../helpers/index.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveAutoCompactPolicyConfig } from "./model-token-limits.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { preserveCanonicalContextPrefix } from "./turn-output-token-continuation.js";

export async function microcompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: {
    model: Model;
    modelStepIndex: number;
    phase: CompactPhase;
    turnRequestState: TurnRequestState;
  },
): Promise<void> {
  if (this.config.compact?.enabled === false) return;
  throwIfTurnAborted(abortSignal);

  const autoConfig = resolveAutoCompactPolicyConfig(this, context.model);
  const microcompactConfig = resolveLocalMicrocompactConfig(autoConfig);
  const useMidConversationSystem = shouldUseMidConversationSystem(this.config, context.model);
  const result = maybeLocalMicrocompactRuntimeEntries({
    config: microcompactConfig,
    entries: context.turnRequestState.entries,
    lastAssistantCompletedAtMs: this.lastAssistantCompletedAtMs,
    useMidConversationSystem,
  });

  if (!result.payload) {
    this.logger?.debug("Microcompact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.micro.skipped",
      estimatedTokenCount: result.decision.estimatedTokenCount,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      reason: result.decision.reason,
      thresholdTokens: result.decision.thresholdTokens,
      trigger: result.decision.trigger,
    });
    return;
  }

  this.messageHistory.replaceMessages(
    preserveCanonicalContextPrefix(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
      result.entries,
    ),
  );
  context.turnRequestState.entries = result.entries;

  const payload = {
    ...result.payload,
    traceId: turnTraceContext.traceId,
    turnId: turnTraceContext.turnId,
  };
  const event = this.createEvent(SessionEventType.MicrocompactBoundary, payload, turnTraceContext);
  await this.appendEvent(event, turnTraceContext);
  events.push(event);

  this.logger?.info("Microcompact applied", {
    ...traceContextToLogContext(turnTraceContext),
    clearedMessageCount: payload.clearedMessageCount,
    event: "compact.micro.applied",
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    postMicrocompactTokenCount: payload.postMicrocompactTokenCount,
    preMicrocompactTokenCount: payload.preMicrocompactTokenCount,
    tokensSaved: payload.tokensSaved,
    trigger: payload.trigger,
  });
}

function resolveLocalMicrocompactConfig(
  config: AutoCompactPolicyConfig,
): LocalMicrocompactPolicyConfig {
  const fullCompactThreshold = getAutoCompactThreshold(config);
  return {
    ...config.microcompact,
    enabled: config.microcompact?.enabled === true,
    thresholdTokens:
      config.microcompact?.thresholdTokens ??
      buildDefaultMicrocompactThreshold(fullCompactThreshold),
  };
}

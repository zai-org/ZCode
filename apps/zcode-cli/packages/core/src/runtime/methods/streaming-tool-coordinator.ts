import { resolveDeferredToolCall } from "../../tool/deferred-call.js";
import type { ToolSearchExecutionContext } from "@zcode/contracts";
import { TurnMachineImpl, createPartId } from "../deps.js";
import type {
  MessageId,
  Model,
  ModelToolCall,
  ToolCall,
  ToolCallId,
  TraceContext,
} from "../deps.js";
import {
  emitStreamingToolLedgerUpdate,
  requireRuntimeToolCallName,
  toRecordInput,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { createSyntheticStreamedToolResult } from "./streaming-tool-synthetic-result.js";
import {
  beginStreamRecoveryAttempt,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  hasStreamRecoveryBudget,
  recoverPartialAssistantOutputFailure,
} from "./streaming-recovery.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { persistPendingToolPart } from "./tool-part-persistence.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordModelHistoryRound,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";
import {
  buildAssistantEntries,
  createRuntimeAssistantEntry,
  hasOrderedAssistantHistoryBlocks,
  type AssistantHistoryBlock,
} from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

const STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS = 250;
const STREAMING_TOOL_EXECUTION_MODE = "readOnly";

export function createStreamingToolCoordinator(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    model: Model;
    toolSearch?: ToolSearchExecutionContext;
    traceContext: TraceContext;
  },
) {
  const abortController = new AbortController();
  const handles = new Map<string, Promise<StreamedToolExecutionResult | undefined>>();
  const acceptedToolCalls = new Map<string, { call: ToolCall; error?: Error }>();
  let discardedReasoningBytes = 0;
  let discardedTextBytes = 0;

  const abortOnTurnCancel = () => abortController.abort();
  state.turnAbortSignal.addEventListener("abort", abortOnTurnCancel, { once: true });

  const admit = (toolCall: ModelToolCall) => {
    const accepted = acceptedToolCalls.get(toolCall.id);
    if (accepted) return accepted;
    const admission = resolveDeferredToolCall(toolCall, options.toolSearch, runtime.registry);
    acceptedToolCalls.set(toolCall.id, admission);
    return admission;
  };

  const prepareAcceptedToolSettlement = async () => {
    abortController.abort();
    const toolCalls = Array.from(acceptedToolCalls.values(), ({ call }) => call);
    const settledResults = await collectCompletedResults(handles, toolCalls);
    const settledResultById = new Map(settledResults.map((result) => [result.toolCallId, result]));
    return {
      toolCalls,
      streamedToolResults: toolCalls.map(
        (toolCall) =>
          settledResultById.get(toolCall.id as ToolCallId) ??
          createSyntheticStreamedToolResult(
            toolCall,
            handles.has(toolCall.id) ? "unknown_execution_state" : "not_executed",
          ),
      ),
    };
  };

  const commitAcceptedToolSettlement = async (
    assistantCreatedAt: number,
    providerMetadata: Record<string, unknown>,
    settlement: Awaited<ReturnType<typeof prepareAcceptedToolSettlement>>,
  ) => {
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.toolCallCount += settlement.streamedToolResults.length;
    // 完整 tool_call 已建立配对义务；切换模型前必须让 live、durable ToolPart 与冷恢复看到同一组 call/result。
    const toolBlocks = settlement.toolCalls.map(
      (call): AssistantHistoryBlock => ({ kind: "tool", call }),
    );
    commitTurnRequestEntries(
      runtime,
      state.turnRequestState,
      hasOrderedAssistantHistoryBlocks(toolBlocks)
        ? buildAssistantEntries({ blocks: toolBlocks, model: options.model })
        : [createRuntimeAssistantEntry("", settlement.toolCalls, undefined, options.model)],
    );
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    await executeToolCallsForModelStep.call(runtime, state, {
      toolSearch: options.toolSearch,
      assistantCreatedAt,
      assistantMessageId: options.assistantMessageId,
      modelTraceContext: options.traceContext,
      result: {
        finishReason: "tool-calls",
        providerMetadata,
        text: "",
        toolCalls: settlement.toolCalls,
        usage: {},
      },
      streamedToolResults: settlement.streamedToolResults,
      toolCalls: settlement.toolCalls,
    });
    state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
  };

  return {
    admit: (toolCall: ModelToolCall) => admit(toolCall).call,
    accept(toolCall: ModelToolCall) {
      // 保留 runtime admission 后的空名，使正常 finish 走 registry miss，断流则保留 synthetic interrupted error。
      const normalizedToolCall = { ...toolCall };
      if (normalizedToolCall.providerExecuted) return;
      const admission = admit(normalizedToolCall);
      const acceptedCall = admission.call;
      if (admission.error || !shouldExecuteToolDuringStream(runtime, acceptedCall)) return;
      if (handles.has(normalizedToolCall.id)) return;
      const promise = executeDuringStream(runtime, state, {
        abortSignal: abortController.signal,
        assistantMessageId: options.assistantMessageId,
        model: options.model,
        toolSearch: options.toolSearch,
        toolCall: acceptedCall,
        traceContext: options.traceContext,
      }).catch(async (error) => {
        runtime.logger?.warn("Streaming tool execution fell back to end-of-stream execution", {
          error: error instanceof Error ? error.message : String(error),
          event: "tool.streaming.execution_failed",
          module: "core.runtime",
          status: "failed",
          toolCallId: normalizedToolCall.id,
          toolName: normalizedToolCall.name,
        });
        return undefined;
      });
      // abandon 有界返回仍可能留下工具 part 写入；session 关闭必须等真实执行落地。
      void runtime.trackResidencyBlockingWork(promise).catch(() => undefined);
      handles.set(normalizedToolCall.id, promise);
    },

    async abandon(reason: "cancelled" | "model_failed") {
      abortController.abort();
      const status = reason === "cancelled" ? "tool_cancelled" : "tool_abandoned";
      await Promise.all(
        Array.from(acceptedToolCalls.values()).map(({ call: toolCall }) =>
          emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall,
            status,
            executionTiming: "during_stream",
            blockedReason: reason,
          }),
        ),
      );
      await raceWithTimeout(
        Promise.allSettled(handles.values()),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
    },

    async drain(toolCalls: readonly ModelToolCall[]) {
      const results: StreamedToolExecutionResult[] = [];
      for (const toolCall of toolCalls) {
        const handle = handles.get(toolCall.id);
        if (!handle) continue;
        const result = await handle;
        if (result) results.push(result);
      }
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
      return results;
    },

    recordReasoningDelta(text: string) {
      discardedReasoningBytes += new TextEncoder().encode(text).byteLength;
    },

    recordTextDelta(text: string) {
      discardedTextBytes += new TextEncoder().encode(text).byteLength;
    },

    async recoverFromModelFailure(
      error: unknown,
      assistantCreatedAt: number,
      recoveryOptions: { failedRequestId?: string } = {},
    ) {
      if (state.turnAbortSignal.aborted || !hasStreamRecoveryBudget(state)) return false;
      const recoveryEventOptions = {
        ...options,
        ...(recoveryOptions.failedRequestId
          ? { failedRequestId: recoveryOptions.failedRequestId }
          : {}),
      };
      if (acceptedToolCalls.size === 0) {
        return recoverPartialAssistantOutputFailure({
          abortController,
          assistantCreatedAt,
          discardedReasoningBytes,
          discardedTextBytes,
          error,
          options: recoveryEventOptions,
          runtime,
          state,
          turnAbortListener: abortOnTurnCancel,
        });
      }
      const recoveryAttempt = beginStreamRecoveryAttempt(state);
      const settlement = await prepareAcceptedToolSettlement();
      await emitStreamRecoveryStarted(runtime, state, recoveryEventOptions, error, recoveryAttempt);
      await commitAcceptedToolSettlement(
        assistantCreatedAt,
        { recoveredFromStreamFailure: true },
        settlement,
      );
      await emitStreamRecoveryRetryEvents(runtime, state, recoveryEventOptions, {
        ...recoveryAttempt,
        discardedReasoningBytes,
        discardedTextBytes,
        reason: "latest_committed_tool_result",
        toolCallIds: settlement.streamedToolResults.map((result) => result.toolCallId),
      });
      return true;
    },

    async settleForModelFallback(assistantCreatedAt: number) {
      if (acceptedToolCalls.size === 0) {
        abortController.abort();
        state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
        return false;
      }
      const settlement = await prepareAcceptedToolSettlement();
      await commitAcceptedToolSettlement(
        assistantCreatedAt,
        { recoveredFromExecutionModelFallback: true },
        settlement,
      );
      return true;
    },
  };
}

async function executeDuringStream(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    abortSignal: AbortSignal;
    assistantMessageId: MessageId;
    model: Model;
    toolSearch?: ToolSearchExecutionContext;
    toolCall: ToolCall;
    traceContext: TraceContext;
  },
): Promise<StreamedToolExecutionResult | undefined> {
  throwIfTurnAborted(state.turnAbortSignal);
  const toolCall = options.toolCall;
  requireRuntimeToolCallName(toolCall, {
    logger: runtime.logger,
    model: options.model,
    source: "streamingToolCoordinator.executeDuringStream",
    traceContext: options.traceContext,
  });
  const partID = createPartId();
  const input = toRecordInput(toolCall.input);
  const metadata = mcpToolPartMetadata(
    runtime.registry.getMetadata(toolCall.name)?.mcpPresentation,
  );
  // during_stream 是 pending/running part 的首个 durable writer；若绕过
  // turn-tools 的 metadata 写入，Stop 发生在 drain 前时冷恢复只能退化成通用工具卡。
  await persistPendingToolPart(runtime, {
    assistantMessageId: options.assistantMessageId,
    input,
    metadata,
    model: options.model,
    partID,
    toolCall,
    traceContext: options.traceContext,
  });
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_call_closed",
    executionTiming: "during_stream",
    input,
  });

  const schedule = await runtime.scheduleTools([toolCall]);
  const scheduledEvents = await runtime.emitToolScheduledEvents(
    [toolCall],
    schedule,
    options.assistantMessageId,
    options.traceContext,
  );
  state.events.push(...scheduledEvents);
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_queued",
    executionTiming: "during_stream",
    input,
  });

  const execution = await runtime.executeTools([toolCall], schedule, {
    subagentModelOverride: state.subagentModelOverride,
    model: state.model,
    toolSearch: options.toolSearch,
    pluginDiscoveryUi: state.pluginDiscoveryUi,
    automationTurn: isAutomationMutationRestrictedTurn(state),
    automationId: state.automationId,
    offPeakTurn: isOffPeakCreateRestrictedTurn(state),
    signal: options.abortSignal,
    traceContext: options.traceContext,
    onBatchStart: async () => {
      const startedAt = Date.now();
      await runtime.persistPart(
        {
          id: partID,
          sessionID: runtime.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: toolCall.id,
          ...(toolCall.blockIndex !== undefined ? { blockIndex: toolCall.blockIndex } : {}),
          tool: toolCall.name,
          metadata: toolCall.modelCallWrapper
            ? { modelCallWrapper: toolCall.modelCallWrapper }
            : undefined,
          state: {
            status: "running",
            input,
            title: toolCall.name,
            metadata: metadata ?? {},
            time: {
              start: startedAt,
            },
          },
        },
        options.traceContext,
      );
      await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_started",
        executionTiming: "during_stream",
        input,
        startedAt: new Date(startedAt),
      });
    },
  });
  state.events.push(...execution.events);
  const result = execution.results[0];
  if (!result) return undefined;
  return {
    input,
    ledgerRecorded: true,
    partID,
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

function shouldExecuteToolDuringStream(
  runtime: AgentRuntimeInternal,
  toolCall: ModelToolCall,
): boolean {
  if (toolCall.providerExecuted) return false;
  if (toolCall.name.trim().length === 0) return false;
  if (runtime.config.modelStreaming !== "on") return false;
  if ((runtime.config.streamingToolExecution ?? STREAMING_TOOL_EXECUTION_MODE) === "off") {
    return false;
  }
  const entry = runtime.registry.get(toolCall.name);
  if (!entry) return false;
  const metadata = entry.metadata;
  const sideEffectScope = entry.permission?.sideEffectScope ?? metadata.sideEffectScope;
  const requiresUserInteraction = entry.requiresUserInteraction ?? metadata.requiresUserInteraction;
  return (
    metadata.readOnly &&
    metadata.concurrentSafe &&
    !metadata.destructive &&
    !metadata.needsApproval &&
    !requiresUserInteraction &&
    sideEffectScope === "none"
  );
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function collectCompletedResults(
  handles: Map<string, Promise<StreamedToolExecutionResult | undefined>>,
  toolCalls: readonly ModelToolCall[],
): Promise<StreamedToolExecutionResult[]> {
  const settled = await Promise.all(
    toolCalls.map((toolCall) => {
      const handle = handles.get(toolCall.id);
      if (!handle) return undefined;
      return raceWithTimeout(
        handle.catch(() => undefined),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
    }),
  );
  return settled.filter((result): result is StreamedToolExecutionResult => result !== undefined);
}

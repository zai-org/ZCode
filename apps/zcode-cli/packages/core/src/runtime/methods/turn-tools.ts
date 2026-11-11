import { sortByCompleteIndex, type ToolSearchExecutionContext } from "@zcode/contracts";
import { createPartId, TurnMachineImpl } from "../deps.js";
import type {
  MessageId,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolExecutionResult,
} from "../deps.js";
import {
  emitStreamingToolLedgerUpdate,
  throwIfTurnAborted,
  toRecordInput,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, StreamedToolExecutionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitSyntheticStreamedToolError } from "./streaming-tool-synthetic-result.js";
import {
  persistPendingToolPart,
  projectToolNameForNonEmptyBoundary,
} from "./tool-part-persistence.js";
import { persistToolModelStepFinish } from "./turn-step-finish.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { handleToolCallAnomalyWarnings } from "./turn-tool-warnings.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordCompletedToolBatch,
} from "./turn-loop-state.js";
import type { ToolCallInput } from "../../agent/message-history.js";
import { settleToolResults, type ToolResultPart } from "./tool-result-settlement.js";
import { withUserStoppedToolResultContent } from "./interrupt-marker.js";

export async function executeToolCallsForModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    toolSearch?: ToolSearchExecutionContext;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
    streamedToolResults?: StreamedToolExecutionResult[];
    toolCalls: ToolCallInput[];
  },
): Promise<"continue" | "break"> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed tool execution requires the loop Model");
  }
  // 本地工具按 blockIndex 稳定排序后再调度、执行和提交结果（docs/design/v2/model/assistant-block-order.md
  // 「工具执行与结果顺序」）。正常结束、断流恢复、执行模型回退都经过这里，只在这一处排序。
  // 修复原因：blockIndex 在 tool_input_start 分配，toolCalls 却按 tool_call 到达排列；openai-compatible
  // 下两者可能不同，live 结果按到达顺序、冷恢复按 blockIndex，请求字节不同。
  // 有调用缺少合法 blockIndex（旧数据、未编号的非流式结果）时保持原顺序。
  const orderedToolCalls =
    sortByCompleteIndex(options.toolCalls, (toolCall) => toolCall.blockIndex) ?? options.toolCalls;
  const coreToolCalls: ToolCall[] = orderedToolCalls.map((tc) => ({
    id: tc.id as ToolCallId,
    // Model step admission 已完成类型/ID 校验；这里保留可恢复的原始空白名称，
    // 让 executor 强制走 registry miss，而不是把 storage 占位值当成真实工具。
    name: tc.name,
    input: tc.input,
    ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
    ...(tc.blockIndex !== undefined ? { blockIndex: tc.blockIndex } : {}),
  }));
  const streamedResultsById = new Map(
    (options.streamedToolResults ?? []).map((entry) => [entry.toolCallId, entry]),
  );
  const toolCallById = new Map(coreToolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const toolParts = new Map<string, ToolResultPart>();
  for (const toolCall of coreToolCalls) {
    const streamed = streamedResultsById.get(toolCall.id as ToolCallId);
    if (streamed) {
      toolParts.set(toolCall.id, {
        partID: streamed.partID,
        input: streamed.input,
        startedAt: streamed.result.startedAt.getTime(),
      });
      if (streamed.ledgerRecorded === false) {
        await persistPendingToolPart(this, {
          assistantMessageId: options.assistantMessageId,
          input: streamed.input,
          partID: streamed.partID,
          toolCall,
          traceContext: options.modelTraceContext,
          model,
          metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        });
        await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
          assistantMessageId: options.assistantMessageId,
          toolCall,
          status: "tool_call_closed",
          executionTiming: "during_stream",
          input: streamed.input,
        });
        await emitSyntheticStreamedToolError(
          this,
          state.events,
          options.modelTraceContext,
          streamed.result,
        );
      }
      continue;
    }
    const partID = createPartId();
    const normalizedInput = toRecordInput(toolCall.input);
    toolParts.set(toolCall.id, {
      partID,
      input: normalizedInput,
      startedAt: Date.now(),
    });
    await persistPendingToolPart(this, {
      assistantMessageId: options.assistantMessageId,
      input: normalizedInput,
      partID,
      toolCall,
      traceContext: options.modelTraceContext,
      model,
      metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
    });
    await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
      assistantMessageId: options.assistantMessageId,
      toolCall,
      status: "tool_call_closed",
      input: normalizedInput,
    });
  }

  // assistant tool_use 已经进入 history 后，Stop 不能在 tool result
  // 创建前直接抛出。继续把 aborted signal 交给 executor，由现有取消路径为
  // 每个 tool call 生成 ToolCancelled result，再由 turn loop 感知 abort。
  const schedule = await this.scheduleTools(coreToolCalls);
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.scheduleTools(coreToolCalls, this.toScheduleState(schedule)),
  );
  const pendingToolCalls = coreToolCalls.filter(
    (toolCall) => !streamedResultsById.has(toolCall.id as ToolCallId),
  );
  let pendingExecutionResults: ToolExecutionResult[] = [];
  state.turnMachine = new TurnMachineImpl(state.turnMachine.startToolExecution());
  if (pendingToolCalls.length > 0) {
    const pendingSchedule =
      pendingToolCalls.length === coreToolCalls.length
        ? schedule
        : await this.scheduleTools(pendingToolCalls);
    const scheduledEvents = await this.emitToolScheduledEvents(
      pendingToolCalls,
      pendingSchedule,
      options.assistantMessageId,
      options.modelTraceContext,
    );
    state.events.push(...scheduledEvents);
    for (const toolCall of pendingToolCalls) {
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_queued",
        input: toolParts.get(toolCall.id)?.input,
      });
    }

    this.logger?.debug("Executing tools", {
      streamedToolCallCount: streamedResultsById.size,
      toolCallCount: pendingToolCalls.length,
      tools: pendingToolCalls.map((tc) => tc.name),
    });
    const execution = await this.executeTools(pendingToolCalls, pendingSchedule, {
      pluginDiscoveryUi: state.pluginDiscoveryUi,
      automationTurn: isAutomationMutationRestrictedTurn(state),
      automationId: state.automationId,
      offPeakTurn: isOffPeakCreateRestrictedTurn(state),
      signal: state.turnAbortSignal,
      traceContext: options.modelTraceContext,
      subagentModelOverride: state.subagentModelOverride,
      model: state.model,
      toolSearch: options.toolSearch,
      onBatchStart: async (toolCallIds) => {
        // 已取消的 batch 仍由 executor 返回 cancelled results，但不能把从未进入
        // handler 的 tool parts 误标记为 running。
        if (state.turnAbortSignal?.aborted) return;
        for (const toolCallId of toolCallIds) {
          const toolCall = toolCallById.get(toolCallId as ToolCallId);
          if (!toolCall) continue;
          const persisted = toolParts.get(toolCall.id);
          if (!persisted) continue;
          persisted.startedAt = Date.now();
          const projectedToolName = projectToolNameForNonEmptyBoundary(toolCall.name);
          await this.persistPart(
            {
              id: persisted.partID,
              sessionID: this.sessionId,
              messageID: options.assistantMessageId,
              type: "tool",
              callID: toolCall.id,
              ...(toolCall.blockIndex !== undefined ? { blockIndex: toolCall.blockIndex } : {}),
              tool: projectedToolName.toolName,
              metadata: {
                ...projectedToolName.metadata,
                ...(toolCall.modelCallWrapper
                  ? { modelCallWrapper: toolCall.modelCallWrapper }
                  : {}),
              },
              state: {
                status: "running",
                input: persisted.input,
                title: projectedToolName.toolName,
                metadata:
                  mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation) ??
                  {},
                time: {
                  start: persisted.startedAt,
                },
              },
            },
            options.modelTraceContext,
          );
          await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall,
            status: "tool_started",
            input: persisted.input,
            startedAt: new Date(persisted.startedAt),
          });
        }
      },
    });
    pendingExecutionResults = execution.results;
    state.events.push(...execution.events);
  }
  const resultById = new Map<string, ToolExecutionResult>();
  for (const streamed of streamedResultsById.values()) {
    resultById.set(streamed.result.toolCallId, streamed.result);
  }
  for (const pending of pendingExecutionResults) {
    resultById.set(pending.toolCallId, pending);
  }
  const results = withUserStoppedToolResultContent(
    this,
    state,
    coreToolCalls
      .map((toolCall) => resultById.get(toolCall.id))
      .filter((result): result is ToolExecutionResult => result !== undefined),
  );
  try {
    await settleToolResults.call(this, state, {
      assistantMessageId: options.assistantMessageId,
      modelTraceContext: options.modelTraceContext,
      results,
      toolParts,
      toolCallById,
      streamedResultsById,
    });
  } finally {
    // 工具执行中停止：中断标记用工具阶段的文字。
    // 修复原因：checkpoint 被取消时，结算写完结果后自己抛出取消，走不到下面的分支，
    // 标记会用成模型请求阶段的文字。
    if (state.turnAbortSignal.aborted) state.interruptedDuringToolBatch = true;
  }
  // 工具执行中停止：结算后直接结束本轮。
  // 修复原因：继续往下会把挂起的 guide drain 进已停止的轮次；结束后 guide 由取消路径退回队列。
  if (state.turnAbortSignal.aborted) {
    await persistToolModelStepFinish(this, state, options);
    throwIfTurnAborted(state.turnAbortSignal);
  }

  const stopTurnResult = results.find((result) => result.turnControl?.stopTurnAfterResult === true);
  if (stopTurnResult) {
    await persistToolModelStepFinish(this, state, options);
    if (stopTurnResult.turnControl?.reason === "automation_create_limit") {
      // 上限错误只能由用户手动释放名额。把普通 error 继续交给模型，
      // 导致模型循环 List/Delete/Create，甚至尝试 Bash 绕过。当前 turn 只保留一次文本收口。
      state.automationCreateLimitReached = true;
      recordCompletedToolBatch(state);
      this.logger?.info("Automation create limit switched turn to text-only response", {
        event: "automation.create_limit.text_only_continuation",
        module: "core.runtime",
        reason: stopTurnResult.turnControl.reason,
        status: "completed",
        toolCallId: stopTurnResult.toolCallId,
        toolName: stopTurnResult.toolName,
      });
      return "continue";
    }
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
    }
    this.logger?.info("Tool result requested turn stop", {
      event: "tool.turn_control.stop",
      module: "core.runtime",
      reason: stopTurnResult.turnControl?.reason,
      status: "completed",
      toolCallId: stopTurnResult.toolCallId,
      toolName: stopTurnResult.toolName,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }

  await handleToolCallAnomalyWarnings(this, state, {
    modelTraceContext: options.modelTraceContext,
    toolCalls: options.toolCalls,
  });
  await persistToolModelStepFinish(this, state, options);
  if (coreToolCalls.length > 0 && results.length === coreToolCalls.length) {
    state.completedRealToolResultBatch = true;
  }
  await drainInlineGuideForNextRequest(this, state);
  recordCompletedToolBatch(state);
  this.logger?.debug("After inject, message count", {
    compactToolTurnsSinceLastCompact: state.compactTracking?.toolTurnsSinceCompact,
    count: this.messageHistory.getMessageCount(),
    reactiveCompactAttemptedInCurrentModelStep: state.reactiveCompactAttemptedInCurrentModelStep,
  });
  return "continue";
}

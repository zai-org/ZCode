import { beginLocalTurnPreparation } from "@zcode/contracts";
import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type {
  ModelReasoningContentBlock,
  ModelTextContentBlock,
  ModelToolCall,
  ModelUsage,
  ToolCallId,
} from "../deps.js";
import {
  buildSuspiciousEmptyDiagnostics,
  createContentFilteredModelResultError,
  finalizeSuspiciousEmptyModelResult,
  isContentFilteredEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  logModelRequestMediaSummary,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  normalizeStreamError,
  normalizeModelToolCallsForRuntime,
  projectMessagesWithMediaAttachmentPaths,
  projectMessagesForInputFormat,
  projectMessagesForMediaBudget,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { modelRequestTokenLimitLogContext } from "./model-token-limits.js";
import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";
import {
  createTextBlock,
  getOrCreateReasoningBlock,
  getOrCreateTextBlock,
} from "./reasoning-stream.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { isOutputTokenLimitFinishReason } from "./turn-output-token-continuation.js";
import {
  recordRequestContextComposition,
  recordRequestContextCompositionUsage,
} from "../context-composition/state.js";
import {
  finishProviderToolCard,
  persistProviderToolRoundContent,
  providerToolOutputText,
  settleUnfinishedProviderToolCards,
  startProviderToolCard,
  type ProviderToolRound,
} from "../provider-tool-rounds/contract.js";

const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;

function hasToolInputLineBreak(value: string): boolean {
  return (
    value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r")
  );
}

export async function runModelTextRequest(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<RuntimeModelTextResult> {
  const finishAssembly = beginLocalTurnPreparation(options.traceContext, "request_assembly");
  const model = options.model;
  const executionModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
  };
  // 闲时 turn 只覆盖了父 runtime 的默认模型，foreground child 重新建
  // request 时仍读取 session 配置，导致 provider options/capability 与本轮模型分叉。
  // turn 快照存在时必须整体采用快照，不能用 `??` 回退到用户模型的字段。
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    this.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(this.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(this.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  // 正常请求传递模型级 effective 预算，Compact 传递 min(effective, 20K) 的 summary
  // 任务预算；adapter 只做 provider 兼容映射，不再施加独立 global cap。
  using statusSink = this.createModelStatusSink(
    projectedOptions.traceContext,
    projectedOptions.events,
    {
      ...(projectedOptions.onModelNetworkStatus
        ? { onStatus: projectedOptions.onModelNetworkStatus }
        : {}),
      ...(projectedOptions.streamRecovery
        ? { streamRecovery: projectedOptions.streamRecovery }
        : {}),
    },
  );
  const modelInvocationContext = {
    metadata: traceContextToLogContext(projectedOptions.traceContext),
    // 会话类型、重试预算与准入端口由 createRuntimeModel 绑在句柄上
    // turn step 与工具内部的模型调用同一来源。
    modelCall: {
      // 普通 Agent Step 以前只靠 metadata.querySource 在 Adapter 中反推
      // operation/actor；元数据一旦改名或缺失，就会误记为 tool_internal_model_call。
      // Runtime 已经拥有原始执行语义，应在请求边界直接声明，旧映射只作兼容兜底。
      actorKind: this.agentTelemetry.actorKind,
      operation: "agent_step" as const,
      operationId: projectedOptions.traceContext.spanId,
      ...(projectedOptions.streamRecovery
        ? {
            callCause: "recovery" as const,
            attributes: {
              streamRecoveryNumber: projectedOptions.streamRecovery.retryNumber,
            },
          }
        : {}),
    },
    statusSink,
    traceContext: projectedOptions.traceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: projectedOptions.abortSignal,
      model,
      traceContext: projectedOptions.traceContext,
    }),
    // SSE 已经输出后由 core recovery 重发新请求；这些请求在 adapter 看起来都是 attempt=1，
    // 必须把 recovery 次数带过去，才能把 idle timeout 从首请求窗口逐次递增。
    streamIdleTimeoutRetryNumber: projectedOptions.streamRecovery?.retryNumber,
    streamRecovery: projectedOptions.streamRecovery,
  };
  const modelRequest = {
    messages: projectedOptions.messages,
    tools: projectedOptions.tools,
    toolSearchEnabled: projectedOptions.toolSearchEnabled,
    abortSignal: projectedOptions.abortSignal,
    ...(projectedOptions.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: projectedOptions.maxOutputTokens } }
      : {}),
  };

  this.logger?.debug(
    "Model request token limits",
    modelRequestTokenLimitLogContext({
      contextWindow: model.properties.contextWindow,
      maxOutputTokens: projectedOptions.maxOutputTokens,
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      traceContext: projectedOptions.traceContext,
    }),
  );
  const contextUsageSnapshot = this.buildContextUsageSnapshot(projectedOptions);
  const contextUsageBreakdown = this.buildContextUsageBreakdownFromSnapshot(contextUsageSnapshot);
  this.logContextUsageSnapshot(projectedOptions, contextUsageSnapshot);
  // context 组成的「请求」相位与圆环来自同一次分解（spec §3.4）。
  recordRequestContextComposition(this, {
    model,
    breakdown: contextUsageSnapshot.composition,
  });

  if (!this.shouldStreamModelText()) {
    const result = await runWithModelInvocationContext(modelInvocationContext, () =>
      model.generateText(modelRequest),
    );
    const normalizedToolCalls = normalizeModelToolCallsForRuntime(result.toolCalls, {
      logger: this.logger,
      model: executionModelSelection,
      source: "generateText",
      traceContext: projectedOptions.traceContext,
    });
    recordRequestContextCompositionUsage(this, contextUsageSnapshot.composition, result.usage);
    return {
      ...result,
      ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
      toolCalls: normalizedToolCalls,
    };
  }

  // blockIndex 是一次响应里所有块（reasoning、text、tool）共用的到达序号，服务端工具分轮时不重置。
  // 不用 provider 事件里的 id：tool_use 事件的 id 是调用 id，不是块位置。
  let nextBlockIndex = 0;
  const allocateBlockIndex = () => nextBlockIndex++;
  const lastAllocatedBlockIndex = () => (nextBlockIndex > 0 ? nextBlockIndex - 1 : undefined);
  const toolBlockIndexById = new Map<string, number>();
  // text/reasoning 只属于当前轮；每遇到服务端内置工具就收进 providerToolRounds 并重新开始。
  let text = "";
  let textBlocks: ModelTextContentBlock[] = [];
  const textById = new Map<string, ModelTextContentBlock>();
  // 本次响应里已有文字块时，新块才可能被 live 界面接到上一行；只有这时才补发 text_start。
  let hasTextBlockInResponse = false;
  let finishReason = "unknown";
  let usage: ModelUsage = {};
  let providerMetadata: Record<string, unknown> | undefined;
  let signedReasoningReset = false;
  let reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  const toolCalls: ModelToolCall[] = [];
  const toolCallIds = new Set<string>();
  const toolInputDeltaBuffers = new Map<ToolCallId, string>();
  const providerToolRounds: ProviderToolRound[] = [];
  const providerToolStartedAt = new Map<string, number>();
  let roundStartedAt = Date.now();
  const providerToolCardContext = {
    assistantMessageId: options.assistantMessageId,
    events: options.events,
    traceContext: options.traceContext,
  };
  const publishStreamSnapshot = () =>
    options.onStreamSnapshot?.({
      reasoning,
      text,
      textBlocks,
      ...(providerToolRounds.length > 0 ? { providerToolRounds } : {}),
    });
  const streamingEventQueue = createModelStreamingEventQueue({
    events: options.events,
    runtime: this,
    traceContext: options.traceContext,
  });
  const enqueueStreamingEvent = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.maybeApplyBackpressure();
  };
  const enqueueStreamingEventAndDrain = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.drain();
  };
  const flushToolInputDelta = async (toolCallId: ToolCallId) => {
    const delta = toolInputDeltaBuffers.get(toolCallId);
    if (!delta) {
      return;
    }
    toolInputDeltaBuffers.delete(toolCallId);
    this.logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(options.traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await enqueueStreamingEvent({
      assistantMessageId: options.assistantMessageId,
      delta,
      done: false,
      kind: "tool_input_delta",
      toolCallId,
    });
  };
  const flushAllToolInputDeltas = async () => {
    for (const toolCallId of Array.from(toolInputDeltaBuffers.keys())) {
      await flushToolInputDelta(toolCallId);
    }
  };
  const appendToolInputDelta = async (toolCallId: ToolCallId, delta: string) => {
    if (!delta) {
      return;
    }
    const next = `${toolInputDeltaBuffers.get(toolCallId) ?? ""}${delta}`;
    toolInputDeltaBuffers.set(toolCallId, next);
    if (
      hasToolInputLineBreak(next) ||
      next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
    ) {
      // 实验原因：Write/Edit 的行数体验依赖 content 换行尽快到 UI。
      // 这里遇到真实/JSON 转义换行就 flush，同时保留超长单行兜底，
      // 避免没有换行的参数一直缓冲到 tool_input_end。
      await flushToolInputDelta(toolCallId);
    }
  };

  const modelStream = runWithModelInvocationContext(modelInvocationContext, () =>
    model.streamText(modelRequest),
  );
  finishAssembly();
  try {
    for await (const event of modelStream) {
      switch (event.type) {
        case "start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "start",
          });
          break;
        }

        case "text_start": {
          createTextBlock({ id: event.id, textBlocks, textById, allocateBlockIndex });
          hasTextBlockInResponse = true;
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_start",
          });
          break;
        }

        case "text_delta": {
          const { block, created } = getOrCreateTextBlock({
            id: event.id,
            textBlocks,
            textById,
            allocateBlockIndex,
            lastAllocatedBlockIndex,
          });
          block.text += event.text;
          if (created && hasTextBlockInResponse) {
            // 这个块没有 text_start（例如工具之后复用了旧 id），上一段文字的行可能还开着。
            // 补发一次，live 才会和冷恢复一样每个文字块一行。
            await enqueueStreamingEvent({
              assistantMessageId: options.assistantMessageId,
              delta: "",
              done: false,
              kind: "text_start",
            });
          }
          hasTextBlockInResponse = true;
          text += event.text;
          options.onStreamTextDelta?.(event.text);
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "text_delta",
          });
          break;
        }

        case "text_end": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_end",
          });
          break;
        }

        case "reasoning_start": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
            allocateBlockIndex,
          });
          if (event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_start",
          });
          break;
        }

        case "reasoning_delta": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
            allocateBlockIndex,
          });
          block.text += event.text;
          options.onStreamReasoningDelta?.(event.text);
          if (event.providerMetadata) block.providerOptions = event.providerMetadata;
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "reasoning_delta",
          });
          break;
        }

        case "reasoning_end": {
          const block = reasoningById.get(event.id);
          if (block && event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          reasoningById.delete(event.id);
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_end",
          });
          break;
        }

        // 原始参数流保留包装结构；目标身份由公共准入产生，再通过工具事件交给展示投影。
        // 不从参数 delta 推测执行目标，也不为展示身份调整模型流或工具调度时序。
        case "tool_input_start": {
          const toolCallId = event.id as ToolCallId;
          toolInputDeltaBuffers.delete(toolCallId);
          if (!toolBlockIndexById.has(event.id)) {
            toolBlockIndexById.set(event.id, allocateBlockIndex());
          }
          this.logger?.debug("Model streaming tool input started", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_start",
            module: "core.runtime",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_start",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          break;
        }

        case "tool_input_delta": {
          await appendToolInputDelta(event.id as ToolCallId, event.delta);
          break;
        }

        case "tool_input_end": {
          await flushToolInputDelta(event.id as ToolCallId);
          this.logger?.debug("Model streaming tool input ended", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_end",
            module: "core.runtime",
            toolCallId: event.id,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_end",
            toolCallId: event.id as ToolCallId,
          });
          break;
        }

        case "tool_call": {
          const [toolCall] =
            normalizeModelToolCallsForRuntime([event.toolCall], {
              logger: this.logger,
              model: executionModelSelection,
              source: "streamText",
              traceContext: options.traceContext,
            }) ?? [];
          if (!toolCall) {
            break;
          }
          await flushToolInputDelta(toolCall.id as ToolCallId);
          if (toolCallIds.has(toolCall.id)) {
            // 防御原因：协议兼容或自定义 adapter 路径可能重复投递同 id 的 final tool_call；
            // runtime 按 id 去重，避免同一次响应内重复执行。
            break;
          }
          toolCallIds.add(toolCall.id);
          // 没有 tool_input_start 的调用（例如 mcp_tool_use）在这里分配。
          // 必须早于 push、onStreamToolCall 和分轮：它们都会把这个对象继续往下传。
          toolCall.blockIndex = toolBlockIndexById.get(toolCall.id) ?? allocateBlockIndex();
          toolCalls.push(toolCall);
          this.logger?.debug("Model streaming tool call completed", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_call",
            inputKeys:
              typeof toolCall.input === "object" &&
              toolCall.input !== null &&
              !Array.isArray(toolCall.input)
                ? Object.keys(toolCall.input as Record<string, unknown>)
                : [],
            module: "core.runtime",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            input: toolCall.input,
            kind: "tool_call",
            toolCallId: toolCall.id as ToolCallId,
            toolName: toolCall.name,
          });
          options.onStreamToolCall?.(toolCall);
          if (toolCall.providerExecuted) {
            // 服务端已执行：收起当前轮并按流顺序落盘，卡片先显示为运行中，等结果事件补齐。
            // messageId 是这一轮 part 落盘的消息，也是 compact 分组键（与冷恢复的 message.info.id 相同）。
            const round: ProviderToolRound = {
              messageId: options.assistantMessageId,
              reasoning,
              text,
              textBlocks,
              toolCall,
            };
            providerToolRounds.push(round);
            await persistProviderToolRoundContent(
              this,
              providerToolCardContext,
              round,
              roundStartedAt,
            );
            text = "";
            textBlocks = [];
            textById.clear();
            reasoning = [];
            reasoningById.clear();
            roundStartedAt = Date.now();
            providerToolStartedAt.set(toolCall.id, roundStartedAt);
            await startProviderToolCard(this, providerToolCardContext, toolCall, roundStartedAt);
            publishStreamSnapshot();
          }
          break;
        }

        case "provider_tool_result": {
          const round = providerToolRounds.find(
            (candidate) => candidate.toolCall.id === event.toolCallId && !candidate.result,
          );
          if (!round) break;
          const result = { output: providerToolOutputText(event.output), isError: event.isError };
          round.result = result;
          await streamingEventQueue.drain();
          await finishProviderToolCard(
            this,
            providerToolCardContext,
            { ...round, result },
            providerToolStartedAt.get(round.toolCall.id) ?? roundStartedAt,
          );
          publishStreamSnapshot();
          break;
        }

        case "finish": {
          finishReason = event.finishReason;
          usage = event.usage;
          providerMetadata = event.providerMetadata;
          signedReasoningReset = event.signedReasoningReset === true;
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "finish",
          });
          break;
        }

        case "error": {
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "error",
          });
          // AI SDK 的 error chunk 常是 ProviderBusinessError 的 plain object（如 3007），
          // 若只做 JSON.stringify 会丢失 providerCode，UI 只能看到泛化的 stream 失败文案。
          throw normalizeStreamError(event.error);
        }
      }
    }
  } catch (error) {
    await streamingEventQueue.drain();
    // 失败或取消发生在服务端调用与结果之间时，卡片也要有终态；收口失败不能盖住原始错误。
    await settleUnfinishedProviderToolCards(
      this,
      providerToolCardContext,
      providerToolRounds,
      providerToolStartedAt,
    ).then(
      (settled) => settled && publishStreamSnapshot(),
      (settleError) =>
        this.logger?.warn("Failed to settle provider tool cards after stream failure", {
          ...traceContextToLogContext(options.traceContext),
          event: "model.runtime.stream.provider_tool_settle_failed",
          module: "core.runtime",
          error: settleError instanceof Error ? settleError.message : String(settleError),
        }),
    );
    throw error;
  }
  await streamingEventQueue.drain();
  if (
    await settleUnfinishedProviderToolCards(
      this,
      providerToolCardContext,
      providerToolRounds,
      providerToolStartedAt,
    )
  ) {
    publishStreamSnapshot();
  }

  const rawFinishReason = readRawFinishReason(providerMetadata);
  const outputTokenLimit = isOutputTokenLimitFinishReason(finishReason, rawFinishReason);
  // 与 turn 层同一口径：已切成前序轮次的服务端内置工具不算本 step 的调用，超窗仍要交给 Reactive Compact。
  const contextExceeded =
    toolCalls.every((toolCall) =>
      providerToolRounds.some((round) => round.toolCall.id === toolCall.id),
    ) &&
    !outputTokenLimit &&
    isContextExceededFinishReason(finishReason, rawFinishReason);
  if (contextExceeded) {
    // 这里若把 HTTP 200 + finish metadata 提前抛成流异常，会先被通用断流恢复接管，
    // 从而绕过 turn 层的 Reactive Compact。保留原始结果，由 turn 层统一处理超窗语义。
    this.logger?.warn("Model stream ended with provider context overflow", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.context_exceeded",
      finishReason,
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      rawFinishReason,
      textLength: text.length,
      toolCallCount: toolCalls.length,
    });
  }

  if (
    isContentFilteredEmptyModelResult(finishReason, rawFinishReason, text.length, toolCalls.length)
  ) {
    this.logger?.warn("Model stream was blocked by provider content filter", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.content_filtered",
      finishReason,
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      rawFinishReason,
    });
    throw createContentFilteredModelResultError({
      finishReason,
      model: executionModelSelection,
      rawFinishReason,
    });
  }

  // 流在只发出 start/prelude 后以 finishReason=unknown 结束时，会被记到 turn-model-step
  // 的 suspicious empty。这里在返回 result 前再扫一遍 providerMetadata/空 completion。
  if (
    !contextExceeded &&
    !outputTokenLimit &&
    isSuspiciousEmptyModelResult(finishReason, text.length, toolCalls.length, usage)
  ) {
    // zcode-plan 常返回 HTTP 200 空 SSE，需在抛错前打出 finish/providerMetadata 摘要，避免只能看到 UI 泛化文案。
    this.logger?.warn("Model stream ended with suspicious empty completion", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.suspicious_empty",
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      textLength: text.length,
      toolCallCount: toolCalls.length,
      ...buildSuspiciousEmptyDiagnostics({
        finishReason,
        providerMetadata,
        rawFinishReason,
      }),
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason,
      model: executionModelSelection,
      providerMetadata,
      rawFinishReason,
    });
  }

  recordRequestContextCompositionUsage(this, contextUsageSnapshot.composition, usage);
  return {
    ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
    finishReason,
    providerMetadata,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    text,
    textBlocks,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    ...(providerToolRounds.length > 0 ? { providerToolRounds } : {}),
    usage,
    ...(signedReasoningReset ? { signedReasoningReset } : {}),
  };
}

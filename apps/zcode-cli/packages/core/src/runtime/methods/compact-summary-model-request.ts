import {
  ModelErrorCode,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  Model,
  ModelInvocationContext,
  ModelStreamEvent,
  ModelTextContentBlock,
  ModelToolCall,
  ModelUsage,
  TraceContext,
} from "../deps.js";
import {
  isModelContextExceededError,
  isModelMediaTooLargeError,
  isTurnCancellationError,
  normalizeModelToolCallsForRuntime,
  normalizeStreamError,
} from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";

type CompactSummaryModelRequest = {
  toolSearchEnabled?: boolean;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  messages: Parameters<Model["generateText"]>[0]["messages"];
  modelCall?: ModelInvocationContext["modelCall"];
  metadata?: ModelInvocationContext["metadata"];
  preserveProviderStreamBoundaries?: boolean;
  statusSink?: ModelInvocationContext["statusSink"];
  tools?: Parameters<Model["generateText"]>[0]["tools"];
  traceContext: TraceContext;
  refreshRuntimeHeadersBeforeAttempt?: ModelInvocationContext["refreshRuntimeHeadersBeforeAttempt"];
};

interface CompactSummaryFinish {
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  usage: ModelUsage;
}

interface CompactSummaryStreamState {
  committedText: string;
  /** 每个到达 text_end 的文本块，供摘要选块；committedText 是它们的直接拼接。 */
  committedTextBlocks: ModelTextContentBlock[];
  committedContentBlock: boolean;
  currentTextBlockId?: string;
  finish?: CompactSummaryFinish;
  pendingTextById: Map<string | undefined, string>;
  providerContentBlockTypes: Map<number, string>;
  providerMessageProtocolObserved: boolean;
  providerResponseStarted: boolean;
  providerStopReasonPresent: boolean;
  sawDelta: boolean;
  toolCallIds: Set<string>;
  toolCalls: ModelToolCall[];
}

interface RunCompactSummaryModelRequestInput {
  logger?: Logger;
  model: Model;
  request: CompactSummaryModelRequest;
}

const COMPACT_SUMMARY_SETUP_ERROR_CODES = new Set<string>([
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelNotFound,
  ModelErrorCode.InvalidModelRequest,
]);

export async function runCompactSummaryModelRequest(
  input: RunCompactSummaryModelRequestInput,
): Promise<RuntimeModelTextResult> {
  const state = createCompactSummaryStreamState();
  const streamingLogicalCallId = crypto.randomUUID();
  const streamingRequest: CompactSummaryModelRequest = {
    ...input.request,
    modelCall: {
      ...input.request.modelCall,
      callCause: input.request.modelCall?.callCause ?? "initial",
      logicalCallId: streamingLogicalCallId,
    },
  };

  try {
    for await (const event of compactModelStream(input, streamingRequest)) {
      applyCompactSummaryStreamEvent(state, event, input);
    }

    if (!state.finish) {
      throw new Error("Compact summary stream ended before finish");
    }
    if (
      (state.providerMessageProtocolObserved && !state.providerResponseStarted) ||
      (!state.committedContentBlock && !hasCompactSummaryStopReason(state))
    ) {
      // AI SDK 会为空 SSE 合成 finish(other)，也会吞掉 message_delta 的真实 stop reason；
      // 只有观察到 response start，且 block stop / truthy stop reason 至少一个成立时才接受该流。
      throw new Error("Compact summary stream ended without a complete provider response");
    }
  } catch (error) {
    return handleCompactSummaryStreamFailure({ ...input, request: streamingRequest }, state, error);
  }

  return compactSummaryStreamResult(state, state.finish);
}

function applyCompactSummaryStreamEvent(
  state: CompactSummaryStreamState,
  event: ModelStreamEvent,
  input: RunCompactSummaryModelRequestInput,
): void {
  switch (event.type) {
    case "start":
    case "reasoning_start":
    case "tool_input_start":
      return;

    case "compact_stream_boundary":
      applyCompactProviderBoundary(state, event);
      return;

    case "text_start":
      state.currentTextBlockId = event.id;
      state.pendingTextById.set(event.id, "");
      return;

    case "tool_input_end":
      commitNormalizedContentBlock(state);
      return;

    case "text_delta": {
      state.sawDelta = true;
      const textBlockId = event.id ?? state.currentTextBlockId;
      state.pendingTextById.set(
        textBlockId,
        (state.pendingTextById.get(textBlockId) ?? "") + event.text,
      );
      return;
    }

    case "text_end": {
      const text =
        state.pendingTextById.get(event.id) ?? state.pendingTextById.get(undefined) ?? "";
      state.committedText += text;
      state.committedTextBlocks.push({ type: "text", text });
      state.pendingTextById.delete(event.id);
      state.pendingTextById.delete(undefined);
      if (state.currentTextBlockId === event.id) {
        state.currentTextBlockId = undefined;
      }
      commitNormalizedContentBlock(state);
      return;
    }

    case "reasoning_delta":
      state.sawDelta = true;
      return;

    case "reasoning_end":
      commitNormalizedContentBlock(state);
      return;

    case "tool_input_delta":
      state.sawDelta = true;
      return;

    case "tool_call": {
      // tool call 只负责 deny 所需的 payload 聚合；raw message-block provider
      // 是否已提交由 compact_stream_boundary 决定，不能把 SDK 合成的 tool call 当成 commit。
      commitNormalizedContentBlock(state);
      const [toolCall] =
        normalizeModelToolCallsForRuntime([event.toolCall], {
          logger: input.logger,
          model: modelSelection(input.model),
          source: "compactStreamText",
          traceContext: input.request.traceContext,
        }) ?? [];
      if (!toolCall || state.toolCallIds.has(toolCall.id)) return;
      state.toolCallIds.add(toolCall.id);
      state.toolCalls.push(toolCall);
      return;
    }

    case "finish":
      // finish 只描述请求结果，不等价于 content_block_stop；clean EOF
      // 会正常返回，但 finish 后若 iterator tail error 且没有 block end，仍允许 HTTP fallback。
      state.finish = {
        finishReason: event.finishReason,
        providerMetadata: event.providerMetadata,
        usage: event.usage,
      };
      return;

    case "error":
      throw event.error;
  }
}

function applyCompactProviderBoundary(
  state: CompactSummaryStreamState,
  event: Extract<ModelStreamEvent, { type: "compact_stream_boundary" }>,
): void {
  if (event.boundary === "inferred_content_block_stop") {
    commitNormalizedContentBlock(state);
    return;
  }

  if (!state.providerMessageProtocolObserved) {
    // raw provenance 一旦出现便接管 commit 判定；normalized end 不能继续充当提交证明。
    state.committedContentBlock = false;
  }
  state.providerMessageProtocolObserved = true;

  switch (event.boundary) {
    case "provider_stop_reason":
      state.providerStopReasonPresent = event.present;
      return;

    case "provider_response_start":
      state.providerResponseStarted = true;
      return;

    case "provider_content_block_start":
      if (event.index === null || event.blockType === null) {
        throw new Error("Invalid compact provider content block start");
      }
      state.providerContentBlockTypes.set(event.index, event.blockType);
      return;

    case "provider_content_block_delta": {
      const blockType =
        event.index === null ? undefined : state.providerContentBlockTypes.get(event.index);
      if (
        blockType === undefined ||
        !isProviderContentBlockDeltaCompatible(blockType, event.deltaType)
      ) {
        throw new Error("Invalid compact provider content block delta");
      }
      return;
    }

    case "provider_content_block_stop":
      if (
        !state.providerResponseStarted ||
        event.index === null ||
        !state.providerContentBlockTypes.has(event.index)
      ) {
        // content_block_stop 必须先有 message_start 和同 index block start；orphan stop
        // 立即失败；统一 IteratorClose 会释放 provider reader，fallback gate 再按既有 commit 决定能否重放。
        throw new Error("Invalid compact provider content block stop");
      }
      state.committedContentBlock = true;
      return;
  }
}

async function handleCompactSummaryStreamFailure(
  input: RunCompactSummaryModelRequestInput,
  state: CompactSummaryStreamState,
  error: unknown,
): Promise<RuntimeModelTextResult> {
  if (
    isTurnCancellationError(error, input.request.abortSignal) ||
    isModelContextExceededError(error) ||
    isModelMediaTooLargeError(error) ||
    isCompactSummarySetupFailure(error) ||
    state.committedContentBlock
  ) {
    throw error;
  }
  const normalizedError = error instanceof Error ? error : normalizeStreamError(error);

  // compact summary 的 stream delta 从未进入 session/UI，在 content block
  // 提交前可以安全丢弃并改走 non-stream；这与普通主请求的可见 streaming 恢复边界不同。
  input.logger?.warn("Compact summary stream failed; falling back to non-streaming", {
    ...traceContextToLogContext(input.request.traceContext),
    errorMessage: normalizedError.message,
    event: "compact.summary.stream_to_non_stream_fallback",
    model: `${input.model.providerId}/${input.model.modelId}`,
    module: "core.runtime",
    observedPartialOutput: state.sawDelta,
  });

  const fallbackRequest = {
    ...input.request,
    modelCall: {
      ...input.request.modelCall,
      attributes: {
        ...input.request.modelCall?.attributes,
      },
      callCause: "fallback_replacement" as const,
      logicalCallId: crypto.randomUUID(),
      previousLogicalCallId: input.request.modelCall?.logicalCallId,
    },
  };
  return runWithModelInvocationContext(invocationContext(fallbackRequest), () =>
    input.model.generateText(cleanRequest(fallbackRequest)),
  );
}

function compactModelStream(
  input: RunCompactSummaryModelRequestInput,
  request: CompactSummaryModelRequest,
): AsyncIterable<ModelStreamEvent> {
  return runWithModelInvocationContext(invocationContext(request), () =>
    input.model.streamText(cleanRequest(request)),
  );
}

function cleanRequest(request: CompactSummaryModelRequest) {
  return {
    messages: request.messages,
    tools: request.tools,
    toolSearchEnabled: request.toolSearchEnabled,
    abortSignal: request.abortSignal,
    ...(request.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: request.maxOutputTokens } }
      : {}),
  };
}

function invocationContext(request: CompactSummaryModelRequest) {
  return {
    metadata: request.metadata,
    modelCall: request.modelCall,
    statusSink: request.statusSink,
    traceContext: request.traceContext,
    preserveProviderStreamBoundaries: request.preserveProviderStreamBoundaries,
    refreshRuntimeHeadersBeforeAttempt: request.refreshRuntimeHeadersBeforeAttempt,
  };
}

function isCompactSummarySetupFailure(error: unknown): boolean {
  const errorRecord = asRecord(error);
  const context = asRecord(errorRecord?.context);
  const streamFailurePhase = context?.streamFailurePhase;
  if (streamFailurePhase === "response_body") {
    return false;
  }

  if (streamFailurePhase === "request_setup") {

    // 其他同步 setup 或明确 HTTP 拒绝属于原请求错误，不能用第二种 transport 掩盖。
    return context?.httpResponseStatus !== 404;
  }

  return (
    typeof errorRecord?.code === "string" && COMPACT_SUMMARY_SETUP_ERROR_CODES.has(errorRecord.code)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactSummaryStreamResult(
  state: CompactSummaryStreamState,
  finish: CompactSummaryFinish,
): RuntimeModelTextResult {
  return {
    finishReason: finish.finishReason,
    providerMetadata: finish.providerMetadata,
    text: state.committedText,
    textBlocks: state.committedTextBlocks,
    toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    usage: finish.usage,
  };
}

function modelSelection(model: Model) {
  return { providerId: model.providerId, modelId: model.modelId };
}

function commitNormalizedContentBlock(state: CompactSummaryStreamState): void {
  // 无 raw message-block provenance 的 provider 继续使用 AI SDK normalized end 推断；
  // 一旦观察到该 provenance，只有 provider content_block_stop 可以固化 commit。
  if (!state.providerMessageProtocolObserved) {
    state.committedContentBlock = true;
  }
}

function hasCompactSummaryStopReason(state: CompactSummaryStreamState): boolean {
  if (state.providerMessageProtocolObserved) {
    return state.providerStopReasonPresent;
  }
  const rawFinishReason = state.finish?.providerMetadata?.rawFinishReason;
  if (typeof rawFinishReason === "string" && rawFinishReason.trim().length > 0) {
    return true;
  }
  const finishReason = state.finish?.finishReason.trim().toLowerCase();
  return finishReason !== undefined && finishReason.length > 0 && finishReason !== "other";
}

function isProviderContentBlockDeltaCompatible(
  blockType: string,
  deltaType: string | null,
): boolean {
  switch (deltaType) {
    case "text_delta":
      return blockType === "text";
    case "input_json_delta":
      return blockType === "tool_use" || blockType === "server_tool_use";
    case "signature_delta":
      return blockType === "thinking";
    case "thinking_delta":
      return blockType === "thinking" || blockType === "redacted_thinking";
    case "citations_delta":
    default:
      // citations 及未知/未来 delta 只要求 block 已存在，不参与正文聚合。
      return true;
  }
}

function createCompactSummaryStreamState(): CompactSummaryStreamState {
  return {
    committedText: "",
    committedTextBlocks: [],
    committedContentBlock: false,
    pendingTextById: new Map(),
    providerContentBlockTypes: new Map(),
    providerMessageProtocolObserved: false,
    providerResponseStarted: false,
    providerStopReasonPresent: false,
    sawDelta: false,
    toolCallIds: new Set(),
    toolCalls: [],
  };
}

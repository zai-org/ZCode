import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  ModelErrorCode,
  createCoreError,
  createRootTraceContext,
  createSessionId,
  getCurrentModelInvocationContext,
  type Logger,
  type Model,
  type ModelInvocationContext,
  type ModelOptions,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTextResult,
} from "@zcode/contracts";
import { runCompactSummaryModelRequest as runCompactSummaryModelRequestWithModel } from "../src/runtime/methods/compact-summary-model-request.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";

const MODEL = createTestModelSelection("test/compact-stream-model");
const DEFAULT_RESULT: ModelTextResult = {
  finishReason: "stop",
  model: MODEL,
  text: "fallback summary",
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
};

type CompactSummaryTestRequest = ModelRequest &
  ModelInvocationContext & {
    maxOutputTokens?: number;
    traceContext: ReturnType<typeof createRootTraceContext>;
  };

describe("runCompactSummaryModelRequest", () => {
  it("aggregates a successful hidden stream without calling non-stream generation", async () => {
    const { logger, warn } = createCapturingLogger();
    const { modelExecutor, generateText, streamText } = createScriptedModelExecutor({
      streamEvents: [
        { type: "start" },
        {
          type: "reasoning_start",
          id: "reasoning-1",
          providerMetadata: { anthropic: { signature: "start-signature" } },
        },
        {
          type: "reasoning_delta",
          id: "reasoning-1",
          text: "hidden reasoning",
        },
        {
          type: "reasoning_end",
          id: "reasoning-1",
          providerMetadata: { anthropic: { signature: "final-signature" } },
        },
        { type: "text_start", id: "text-1" },
        { type: "text_delta", id: "text-1", text: "stream " },
        { type: "text_delta", id: "text-1", text: "summary" },
        { type: "text_end", id: "text-1" },
        {
          type: "tool_call",
          toolCall: { id: "tool-1", input: { path: "/tmp/a" }, name: "Read" },
        },
        {
          type: "tool_call",
          toolCall: { id: "tool-1", input: { path: "/tmp/a" }, name: "Read" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          providerMetadata: { provider: { requestId: "request-1" } },
          usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({
      logger,
      modelExecutor,
      request,
    });

    expect(streamText).toHaveBeenCalledTimes(1);
    expect(streamText).toHaveBeenCalledWith(expectedModelRequest(request));
    expect(generateText).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(result).toEqual({
      finishReason: "tool-calls",
      providerMetadata: { provider: { requestId: "request-1" } },
      text: "stream summary",
      textBlocks: [{ type: "text", text: "stream summary" }],
      toolCalls: [{ id: "tool-1", input: { path: "/tmp/a" }, name: "Read" }],
      usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
    });
  });

  it("returns each committed text block separately for summary block selection", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor } = createScriptedModelExecutor({
      streamEvents: [
        { type: "text_start", id: "summary-block" },
        { type: "text_delta", id: "summary-block", text: "<summary>A</summary>" },
        { type: "text_end", id: "summary-block" },
        { type: "text_start", id: "trailing-block" },
        { type: "text_delta", id: "trailing-block", text: "B" },
        { type: "text_end", id: "trailing-block" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result.text).toBe("<summary>A</summary>B");
    expect(result.textBlocks).toEqual([
      { type: "text", text: "<summary>A</summary>" },
      { type: "text", text: "B" },
    ]);
  });

  it("keeps only text blocks that reached text_end on clean finish", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { type: "text_start", id: "committed" },
        { type: "text_delta", text: "committed summary" },
        { type: "text_end", id: "committed" },
        { type: "text_start", id: "unfinished" },
        { type: "text_delta", id: "unfinished", text: " must be discarded" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result.text).toBe("committed summary");
    expect(result.textBlocks).toEqual([{ type: "text", text: "committed summary" }]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("falls back to non-stream generation after a terminal pre-event stream failure", async () => {
    const streamError = new Error("stream transport unavailable");
    const { logger, warn } = createCapturingLogger();
    const { generateContexts, modelExecutor, generateText, streamContexts, streamText } =
      createScriptedModelExecutor({ streamError });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({
      logger,
      modelExecutor,
      request,
    });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(streamText).toHaveBeenCalledWith(expectedModelRequest(request));
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(expectedModelRequest(request));
    expect(streamContexts[0]?.modelCall?.logicalCallId).toBeTruthy();
    expect(generateContexts[0]?.modelCall).toMatchObject({
      callCause: "fallback_replacement",
      previousLogicalCallId: streamContexts[0]?.modelCall?.logicalCallId,
    });
    expect(warn).toHaveBeenCalledWith(
      "Compact summary stream failed; falling back to non-streaming",
      expect.objectContaining({
        event: "compact.summary.stream_to_non_stream_fallback",
        observedPartialOutput: false,
      }),
    );
  });

  it.each([
    ModelErrorCode.InvalidModelSelection,
    ModelErrorCode.ModelConfigMissing,
    ModelErrorCode.ProviderNotFound,
    ModelErrorCode.ProviderNotConfigured,
    ModelErrorCode.ModelNotFound,
    ModelErrorCode.InvalidModelRequest,
  ])("does not hide deterministic setup error %s behind non-stream fallback", async (code) => {
    const streamError = Object.assign(new Error(`setup failed: ${code}`), { code });
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({ streamError });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      streamError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("keeps the HTTP 404 stream request setup fallback", async () => {
    const streamError = Object.assign(new Error("HTTP 404"), {
      code: ModelErrorCode.ModelNotFound,
      context: {
        httpResponseStatus: 404,
        statusCode: 500,
        streamFailurePhase: "request_setup",
      },
    });
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({ streamError });
    const { request } = createRequest();

    await expect(
      runCompactSummaryModelRequest({ logger, modelExecutor, request }),
    ).resolves.toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not treat a logical setup status 404 as a real HTTP 404", async () => {
    const streamError = Object.assign(new Error("logical 404"), {
      code: ModelErrorCode.ModelRequestFailed,
      context: { statusCode: 404, streamFailurePhase: "request_setup" },
    });
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({ streamError });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      streamError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("falls back for a pre-commit SSE body error even when its logical status is 500", async () => {
    const streamError = Object.assign(new Error("SSE api_error"), {
      code: ModelErrorCode.ModelRequestFailed,
      context: { statusCode: 500, streamFailurePhase: "response_body" },
    });
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({ streamError });
    const { request } = createRequest();

    await expect(
      runCompactSummaryModelRequest({ logger, modelExecutor, request }),
    ).resolves.toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("discards in-flight deltas and falls back before a content block ends", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamError: new Error("stream reset after delta"),
      streamEvents: [
        { type: "text_start", id: "text-1" },
        { type: "text_delta", id: "text-1", text: "discard me" },
        { type: "reasoning_delta", id: "reasoning-1", text: "discard reasoning" },
        { type: "tool_input_start", id: "tool-1", toolName: "Read" },
        { type: "tool_input_delta", id: "tool-1", delta: '{"file_path":"README.md"}' },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({
      logger,
      modelExecutor,
      request,
    });

    expect(result.text).toBe("fallback summary");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back when a stream ends without a finish event and without a committed block", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [{ type: "start" }],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({
      logger,
      modelExecutor,
      request,
    });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back after finish when the iterator tail fails without a committed block", async () => {
    const tailError = Object.assign(new Error("stream reset after finish"), {
      code: "ECONNRESET",
    });
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamError: tailError,
      streamEvents: [
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(expectedModelRequest(request));
  });

  it("falls back after finish-tail failure when tool input never ended", async () => {
    const tailError = Object.assign(new Error("stream reset after unfinished tool input"), {
      code: "ECONNRESET",
    });
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamError: tailError,
      streamEvents: [
        { type: "tool_input_start", id: "tool-1", toolName: "Read" },
        { type: "tool_input_delta", id: "tool-1", delta: '{"file_path":"README.md"}' },
        {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(expectedModelRequest(request));
  });

  it.each([
    {
      name: "empty text block",
      streamEvents: [
        { type: "text_start", id: "text-1" },
        { type: "text_end", id: "text-1" },
      ] satisfies ModelStreamEvent[],
    },
    {
      name: "empty reasoning block",
      streamEvents: [
        { type: "reasoning_start", id: "reasoning-1" },
        { type: "reasoning_end", id: "reasoning-1" },
      ] satisfies ModelStreamEvent[],
    },
    {
      name: "tool input end",
      streamEvents: [
        { type: "tool_input_start", id: "tool-1", toolName: "Read" },
        { type: "tool_input_end", id: "tool-1" },
      ] satisfies ModelStreamEvent[],
    },
    {
      name: "tool call",
      streamEvents: [
        {
          type: "tool_call",
          toolCall: { id: "tool-1", input: {}, name: "Read" },
        },
      ] satisfies ModelStreamEvent[],
    },
  ])("does not replay a committed $name through non-stream fallback", async ({ streamEvents }) => {
    const streamError = new Error("stream failed after commit");
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamError,
      streamEvents,
    });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      streamError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("does not fall back after user cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const streamError = new Error("aborted");
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({ streamError });
    const { request } = createRequest({ abortSignal: controller.signal });

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      streamError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: createCoreError(CoreErrorType.ModelContextExceeded, "context exceeded", {
        recoverable: true,
      }),
      name: "context exceeded",
    },
    {
      error: Object.assign(new Error("media too large"), { reason: "media_too_large" }),
      name: "media too large",
    },
  ])("keeps existing compact recovery ownership for $name", async ({ error }) => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({ streamError: error });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      error,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("preserves a context error event for existing compact recovery", async () => {
    const contextError = { message: "prompt too long", reason: "context_exceeded" };
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [{ error: contextError, type: "error" }],
    });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      contextError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns a normally finished empty stream to existing compact validation", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({
      logger,
      modelExecutor,
      request,
    });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("stop");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("falls back when a provider response ends without a block or stop reason", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { type: "start" },
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("accepts a provider stop reason without a committed block", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("other");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("falls back when a later provider delta clears the stop reason", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
        { boundary: "provider_stop_reason", present: false, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back for a provider content block that precedes response start", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        {
          blockType: "text",
          boundary: "provider_content_block_start",
          index: 0,
          type: "compact_stream_boundary",
        },
        { type: "text_start", id: "orphan-text" },
        { type: "text_delta", id: "orphan-text", text: "orphan summary" },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        { type: "text_end", id: "orphan-text" },
        { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back when a provider block stop has no matching block start", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("keeps started block indexes across repeated and multiple provider stops", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          blockType: "text",
          boundary: "provider_content_block_start",
          index: 0,
          type: "compact_stream_boundary",
        },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        {
          blockType: "text",
          boundary: "provider_content_block_start",
          index: 1,
          type: "compact_stream_boundary",
        },
        { boundary: "provider_content_block_stop", index: 1, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result.text).toBe("");
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([
    ["text", "text_delta"],
    ["tool_use", "input_json_delta"],
    ["server_tool_use", "input_json_delta"],
    ["thinking", "signature_delta"],
    ["thinking", "thinking_delta"],
    ["redacted_thinking", "thinking_delta"],
    ["text", "citations_delta"],
    ["future_block", "future_delta"],
  ])("accepts provider %s blocks with %s", async (blockType, deltaType) => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          blockType,
          boundary: "provider_content_block_start",
          index: 0,
          type: "compact_stream_boundary",
        },
        {
          boundary: "provider_content_block_delta",
          deltaType,
          index: 0,
          type: "compact_stream_boundary",
        },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result.text).toBe("");
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([
    ["text", "input_json_delta"],
    ["tool_use", "text_delta"],
    ["text", "signature_delta"],
    ["text", "thinking_delta"],
  ])("falls back for provider %s blocks with mismatched %s", async (blockType, deltaType) => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          blockType,
          boundary: "provider_content_block_start",
          index: 0,
          type: "compact_stream_boundary",
        },
        { type: "text_start", id: "usable-text" },
        { type: "text_delta", id: "usable-text", text: "usable summary" },
        {
          boundary: "provider_content_block_delta",
          deltaType,
          index: 0,
          type: "compact_stream_boundary",
        },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        { type: "text_end", id: "usable-text" },
        { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back when a provider delta has no matching block start", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          boundary: "provider_content_block_delta",
          deltaType: "text_delta",
          index: 0,
          type: "compact_stream_boundary",
        },
        { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not replay when an orphan stop follows an earlier committed provider block", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          blockType: "text",
          boundary: "provider_content_block_start",
          index: 0,
          type: "compact_stream_boundary",
        },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        { boundary: "provider_content_block_stop", index: 1, type: "compact_stream_boundary" },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toThrow(
      "Invalid compact provider content block stop",
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("does not treat SDK-synthesized tool end as a provider block commit", async () => {
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        { type: "tool_input_start", id: "prefilled-tool", toolName: "Read" },
        {
          type: "tool_input_delta",
          id: "prefilled-tool",
          delta: '{"file_path":"README.md"}',
        },
        { type: "tool_input_end", id: "prefilled-tool" },
        {
          type: "tool_call",
          toolCall: {
            id: "prefilled-tool",
            input: { file_path: "README.md" },
            name: "Read",
          },
        },
        {
          type: "finish",
          finishReason: "other",
          usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
        },
      ],
    });
    const { request } = createRequest();

    const result = await runCompactSummaryModelRequest({ logger, modelExecutor, request });

    expect(result).toEqual(DEFAULT_RESULT);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not replay after a provider content block stop", async () => {
    const streamError = new Error("stream failed after provider block stop");
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      streamError,
      streamEvents: [
        { boundary: "provider_response_start", type: "compact_stream_boundary" },
        {
          blockType: "text",
          boundary: "provider_content_block_start",
          index: 0,
          type: "compact_stream_boundary",
        },
        { type: "text_start", id: "committed-text" },
        { type: "text_delta", id: "committed-text", text: "committed summary" },
        { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
        { type: "text_end", id: "committed-text" },
      ],
    });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      streamError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("surfaces the non-stream error when fallback also fails", async () => {
    const fallbackError = new Error("fallback failed");
    const { logger } = createCapturingLogger();
    const { modelExecutor, generateText } = createScriptedModelExecutor({
      generateError: fallbackError,
      streamError: new Error("stream failed"),
    });
    const { request } = createRequest();

    await expect(runCompactSummaryModelRequest({ logger, modelExecutor, request })).rejects.toBe(
      fallbackError,
    );
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

function runCompactSummaryModelRequest(input: {
  logger?: Logger;
  modelExecutor: TestModelExecutor;
  request: CompactSummaryTestRequest;
}) {
  return runCompactSummaryModelRequestWithModel({
    logger: input.logger,
    model: createTestModel(input.modelExecutor, input.request),
    request: input.request,
  });
}

function createTestModel(
  modelExecutor: TestModelExecutor,
  request: CompactSummaryTestRequest,
  options: ModelOptions = {},
): Model {
  const maxOutputTokens = request.maxOutputTokens ?? 32_000;
  const model: Model = {
    providerId: MODEL.providerId,
    modelId: MODEL.modelId,
    properties: {
      contextWindow: 200_000,
      ...createTestModelFormatProperties(),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      maxOutputTokens: { max: 200_000 },
    },
    options: { maxOutputTokens, ...options },
    bind(nextOptions) {
      return createTestModel(modelExecutor, request, { ...this.options, ...nextOptions });
    },
    generateText(request) {
      return modelExecutor.generateText(request);
    },
    streamText(request) {
      return modelExecutor.streamText(request);
    },
  };
  return model;
}

function createRequest(overrides: Partial<CompactSummaryTestRequest> = {}): {
  request: CompactSummaryTestRequest;
} {
  const traceContext = createRootTraceContext({
    sessionId: createSessionId("compact-summary-model-request"),
  });
  return {
    request: {
      messages: [{ content: "Summarize this conversation", role: "user" }],
      tools: [],
      ...overrides,
      traceContext,
    },
  };
}

function expectedModelRequest(request: ModelRequest) {
  return expect.objectContaining({
    messages: request.messages,
    tools: request.tools,
  });
}

function createScriptedModelExecutor(input: {
  generateError?: unknown;
  generateResult?: ModelTextResult;
  streamError?: unknown;
  streamEvents?: ModelStreamEvent[];
}): {
  generateText: ReturnType<typeof vi.fn>;
  generateContexts: ModelInvocationContext[];
  modelExecutor: TestModelExecutor;
  streamContexts: ModelInvocationContext[];
  streamText: ReturnType<typeof vi.fn>;
} {
  const generateContexts: ModelInvocationContext[] = [];
  const streamContexts: ModelInvocationContext[] = [];
  const generateText = vi.fn(async (_request: ModelRequest) => {
    generateContexts.push(getCurrentModelInvocationContext() ?? {});
    if (input.generateError !== undefined) throw input.generateError;
    return input.generateResult ?? DEFAULT_RESULT;
  });
  const streamText = vi.fn((_request: ModelRequest) => {
    streamContexts.push(getCurrentModelInvocationContext() ?? {});
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      for (const event of input.streamEvents ?? []) {
        yield event;
      }
      if (input.streamError !== undefined) throw input.streamError;
    })();
  });

  return {
    generateContexts,
    generateText,
    modelExecutor: { generateText, streamText } as TestModelExecutor,
    streamContexts,
    streamText,
  };
}

type TestModelExecutor = Pick<Model, "generateText" | "streamText">;

function createCapturingLogger(): {
  logger: Logger;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  return {
    logger: { warn } as unknown as Logger,
    warn,
  };
}

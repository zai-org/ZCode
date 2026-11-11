import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, RetryError } from "ai";
import { describe, expect, it, vi } from "vitest";
import type {
  AiSdkGenerateTextOptions,
  AiSdkModelRuntime,
  AiSdkStreamTextOptions,
} from "../src/model/runner.js";
import { normalizeUsage, toModelStreamEvent } from "../src/model/runner.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { createTestModelProperties } from "./test-model-format.js";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import { resolveModelStreamIdleTimeoutMs } from "../src/model/stream-idle-timeout.js";
import {
  ModelErrorCode,
  ModelFailureReason,
  WEBSEARCH_PROVIDER_NATIVE_SPEC,
  WEBSEARCH_TOOL_CONTRACT,
  type LogContext,
  type Logger,
  type ModelInputMessage,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
  type ModelToolContract,
} from "@zcode/contracts";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

describe("AiSdkModelAdapter", () => {
  it("本地首有效内容日志排除空 start，正文增量只记录一次", async () => {
    const logs: CapturedLog[] = [];
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", text: "", delta: "" },
        { type: "text-delta", id: "text", text: "private", delta: "private" },
        { type: "text-delta", id: "text", text: " reply", delta: " reply" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: "stop", totalUsage: usage(2, 2) },
      ]),
    );
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: registry(),
      runtime,
    });
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "private prompt" }],
      metadata: { querySource: "main_turn", queryId: "command" },
    })) {
      if (event.type === "text_start")
        expect(
          logs.filter((log) => log.context?.event === "ttft.model.first_content"),
        ).toHaveLength(0);
    }
    const milestones = logs.filter((log) => log.context?.event === "ttft.model.first_content");
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toMatchObject({
      level: "info",
      context: { queryId: "command", outputKind: "text" },
    });
    expect(JSON.stringify(milestones)).not.toContain("private");
  });
  it("extends SSE idle timeout by 30 seconds for each retry", () => {
    expect(resolveModelStreamIdleTimeoutMs({})).toBe(600_000);
    expect(resolveModelStreamIdleTimeoutMs({ retryNumber: 1 })).toBe(630_000);
    expect(resolveModelStreamIdleTimeoutMs({ retryNumber: 2 })).toBe(660_000);
    expect(resolveModelStreamIdleTimeoutMs({ baseTimeoutMs: 0, retryNumber: 2 })).toBe(0);
  });

  it("normalizes provider server tool usage", () => {
    expect(
      normalizeUsage({
        inputTokens: 5,
        outputTokens: 3,
        raw: {
          server_tool_use: {
            web_fetch_requests: 1,
            web_search_requests: 2,
          },
        },
        totalTokens: 8,
      } as never),
    ).toEqual({
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: undefined,
      serverToolUse: {
        webFetchRequests: 1,
        webSearchRequests: 2,
      },
      totalTokens: 8,
    });
  });

  it("normalizes streamed reasoning deltas and provider metadata", () => {
    expect(
      toModelStreamEvent({
        type: "reasoning-delta",
        id: "reasoning-1",
        delta: "thinking",
        providerMetadata: { anthropic: { signature: "sig_1" } },
      } as any),
    ).toEqual({
      type: "reasoning_delta",
      id: "reasoning-1",
      text: "thinking",
      providerMetadata: { anthropic: { signature: "sig_1" } },
    });
  });

  it("refreshes runtime headers before each streamed retry attempt with native WebSearch", async () => {
    const calls: Array<{ runtimeHeader: string | undefined; hasNativeWebSearch: boolean }> = [];
    const refreshes: number[] = [];
    let adapter: AiSdkModelAdapter;
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        calls.push({
          runtimeHeader: readHeader(options.headers, "X-Runtime-Token"),
          hasNativeWebSearch: JSON.stringify(options.tools).includes(
            "anthropic.web_search_20260209",
          ),
        });
        if (calls.length === 1) {
          return {
            fullStream: failingStream(
              apiError("retry me", {
                isRetryable: true,
                statusCode: 503,
              }),
            ),
          } as never;
        }
        return {
          fullStream: stream([
            {
              type: "text-delta",
              id: "text-1",
              text: "done",
            },
            {
              type: "finish",
              finishReason: "stop",
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture(startPlanRegistryConfig("initial-token")),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2 },
      runtime,
    });

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "account:zai-start-plan" as never,
      modelId: "glm-5.1" as never,
      properties: createTestModelProperties({}, { supportsNativeWebSearch: true }),
      messages: [{ role: "user", content: "Search current docs" }],
      tools: [createInternalProviderNativeWebSearchContract()],
      async refreshRuntimeHeadersBeforeAttempt({ attempt }) {
        refreshes.push(attempt);
        return {
          headersApplied: true,
          requestAuth: {
            headers: {
              "X-Runtime-Token": `token-${attempt}`,
              "X-Runtime-Region": "cn",
            },
          },
        };
      },
    })) {
      streamed.push(event);
    }

    expect(refreshes).toEqual([1, 2]);
    expect(calls).toEqual([
      { runtimeHeader: "token-1", hasNativeWebSearch: true },
      { runtimeHeader: "token-2", hasNativeWebSearch: true },
    ]);
    expect(streamed.some((event) => event.type === "text_delta")).toBe(true);
  });

  it("refreshes runtime headers before each generate retry attempt", async () => {
    const runtimeHeaders: Array<string | undefined> = [];
    const refreshes: number[] = [];
    let adapter: AiSdkModelAdapter;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        runtimeHeaders.push(readHeader(options.headers, "X-Runtime-Token"));
        if (runtimeHeaders.length === 1) {
          throw apiError("retry me", { isRetryable: true, statusCode: 503 });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture(startPlanRegistryConfig("initial-token")),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2 },
      runtime,
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "account:bigmodel-start-plan" as never,
      modelId: "glm-5.1" as never,
      messages: [{ role: "user", content: "Ping" }],
      async refreshRuntimeHeadersBeforeAttempt({ attempt }) {
        refreshes.push(attempt);
        return {
          headersApplied: true,
          requestAuth: {
            headers: {
              "X-Runtime-Token": `token-${attempt}`,
              "X-Runtime-Region": "cn",
            },
          },
        };
      },
    });

    expect(refreshes).toEqual([1, 2]);
    expect(runtimeHeaders).toEqual(["token-1", "token-2"]);
  });

  it("retries a generic empty generateText completion once", async () => {
    let attempts = 0;
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        return {
          finishReason: "other",
          text: "",
          usage: usage(0, 0),
          ...(attempts === 1
            ? {}
            : {
                text: "recovered",
                finishReason: "stop",
                usage: usage(1, 1),
              }),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    });

    expect(attempts).toBe(2);
    expect(result.text).toBe("recovered");
    expect(statusEvents.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(1);
  });

  it("does not retry a generic empty generateText completion more than once", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        return {
          finishReason: "other",
          text: "",
          usage: usage(0, 0),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Ping" }],
    });

    expect(attempts).toBe(2);
    expect(result.text).toBe("");
  });

  it("retries a generic empty stream completion once without leaking its events", async () => {
    let attempts = 0;
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: stream([
              { type: "start" },
              { type: "finish", finishReason: "other", totalUsage: usage(0, 0) },
            ]),
          } as never;
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-start", id: "recovered-text" },
            { type: "text-delta", id: "recovered-text", text: "recovered" },
            { type: "text-end", id: "recovered-text" },
            { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      events.push(event);
    }

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "finish",
    ]);
    expect(statusEvents.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(1);
  });

  it("does not retry a generic empty stream completion more than once", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: stream([
            { type: "start" },
            { type: "finish", finishReason: "other", totalUsage: usage(0, 0) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Ping" }],
    })) {
      events.push(event);
    }

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["start", "finish"]);
  });

  it("does not add generic empty completion retry to compact streams", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: stream([
            { type: "start" },
            { type: "finish", finishReason: "other", totalUsage: usage(0, 0) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Ping" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["start", "finish"]);
  });

  it("calls the AI SDK runtime with normalized protocol messages", async () => {
    let captured: AiSdkGenerateTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured = options;
        return {
          text: "done",
          finishReason: "stop",
          reasoning: [
            {
              type: "reasoning",
              text: "internal reasoning",
              providerMetadata: { anthropic: { signature: "sig_1" } },
            },
          ],
          usage: usage(1, 2),
          totalUsage: usage(3, 4),
          providerMetadata: { provider: { requestId: "req_1" } },
          toolResults: [
            {
              toolCallId: "toolu_1",
              toolName: "web_search",
              input: { query: "zcode" },
              output: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
              providerExecuted: true,
              providerMetadata: { provider: { id: "result_1" } },
            },
          ],
          sources: [
            {
              type: "source",
              sourceType: "url",
              id: "src_1",
              url: "https://example.com",
              title: "Example",
            },
          ],
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Ping" },
      ],
      maxOutputTokens: 64,
      providerOptions: { test: { flag: true } },
    });

    expect(result.text).toBe("done");
    expect(result.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
    expect(result.reasoning).toEqual([
      {
        type: "reasoning",
        text: "internal reasoning",
        providerOptions: { anthropic: { signature: "sig_1" } },
      },
    ]);
    expect(result.toolResults).toEqual([
      {
        id: "toolu_1",
        name: "web_search",
        input: { query: "zcode" },
        output: [{ type: "web_search_result", url: "https://example.com", title: "Example" }],
        providerExecuted: true,
        providerMetadata: { provider: { id: "result_1" } },
      },
    ]);
    expect(result.sources).toEqual([
      {
        type: "source",
        sourceType: "url",
        id: "src_1",
        url: "https://example.com",
        title: "Example",
        filename: undefined,
        mediaType: undefined,
        providerMetadata: undefined,
      },
    ]);
    expect((captured?.model as { modelId?: string }).modelId).toBe("model-a");
    expect(captured?.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "Ping" },
    ]);
    expect(captured?.allowSystemInMessages).toBe(true);
    expect(captured?.providerOptions).toEqual({
      apiFormat: "openai-chat-completions",
    });
  });

  it("publishes model status events with provider endpoint context", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: new TestProviderConfigFixture({
        providers: {
          deepseek: {
            kind: "openai-compatible",
            apiKey: "test-key",
            baseURL: "https://api.deepseek.com",
          },
        },
      }),
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "deepseek-chat" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    expect(events[0]).toMatchObject({
      baseURL: "https://api.deepseek.com",
      providerKind: "openai-compatible",
      type: "model_request_started",
    });
    expect(events.at(-1)).toMatchObject({
      baseURL: "https://api.deepseek.com",
      providerKind: "openai-compatible",
      type: "model_request_completed",
    });
  });

  it("keeps a local generate runtime failure attributed to runtime", async () => {
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("local adapter setup failed");
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("openai-compatible"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    const error = await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "deepseek-chat" as never,
      messages: [{ role: "user", content: "Ping" }],
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      context: {
        errorPhase: "prepare",
        exceptionKind: "generic",
        reason: ModelFailureReason.Unknown,
        source: "runtime",
      },
    });
  });

  it("uses Effective Model Config instead of a provider allowlist for native web_search", async () => {
    let captured: AiSdkGenerateTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured = options;
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: new TestProviderConfigFixture({
        providers: {
          minimax: {
            kind: "anthropic",
            apiKey: "test-key",
            baseURL: "https://api.minimaxi.com/anthropic",
          },
        },
      }),
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "minimax" as never,
      modelId: "MiniMax-M2.7" as never,
      properties: createTestModelProperties({}, { supportsNativeWebSearch: true }),
      messages: [{ role: "user", content: "Ping" }],
      tools: [createInternalProviderNativeWebSearchContract()],
    });

    expect(Object.keys(captured?.tools ?? {})).toEqual(["web_search"]);
  });

  it("keeps internal web_search for allowlisted Anthropic-compatible side requests", async () => {
    let captured: AiSdkGenerateTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured = options;
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: new TestProviderConfigFixture({
        providers: {
          deepseek: {
            kind: "anthropic",
            apiKey: "test-key",
            baseURL: "https://api.deepseek.com/anthropic",
          },
        },
      }),
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "deepseek-chat" as never,
      properties: createTestModelProperties({}, { supportsNativeWebSearch: true }),
      messages: [{ role: "user", content: "Ping" }],
      tools: [createInternalProviderNativeWebSearchContract()],
    });

    expect(Object.keys(captured?.tools ?? {})).toEqual(["web_search"]);
    expect(captured?.tools?.web_search).toMatchObject({
      id: "anthropic.web_search_20260209",
      type: "provider",
    });
  });

  it("does not apply DeepSeek OpenAI compatibility on Anthropic transport", async () => {
    let captured: AiSdkGenerateTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured = options;
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: providerRegistry("anthropic"),
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "deepseek-v4-pro" as never,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "anthropic thinking",
              providerOptions: { anthropic: { signature: "sig_1" } },
            },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });

    expect((captured?.messages?.[0] as any).providerOptions).toBeUndefined();
    expect((captured?.messages?.[0] as any).content).toEqual([
      {
        type: "reasoning",
        text: "anthropic thinking",
        providerOptions: { anthropic: { signature: "sig_1" } },
      },
      { type: "text", text: "answer" },
    ]);
  });

  it("normalizes generateText structured object output into the existing text result", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          output: {
            selected_memories: ["database-test-policy.md"],
          },
          text: "provider raw text",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Select relevant memories" }],
      responseJsonSchema: {
        additionalProperties: false,
        properties: {
          selected_memories: {
            items: { type: "string" },
            type: "array",
          },
        },
        required: ["selected_memories"],
        type: "object",
      },
    });

    expect(result.text).toBe('{"selected_memories":["database-test-policy.md"]}');
  });

  it.each(["missing", "throwing"] as const)(
    "publishes only failed when structured output is %s",
    async (outputState) => {
      const statusEvents: ModelNetworkStatusEvent[] = [];
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          const result = {
            text: "provider raw text",
            finishReason: "stop",
            usage: usage(1, 2),
            totalUsage: usage(1, 2),
          } as Record<string, unknown>;
          if (outputState === "throwing") {
            Object.defineProperty(result, "output", {
              get() {
                throw new Error("structured output unavailable");
              },
            });
          }
          return result as never;
        },
        streamText() {
          throw new Error("not used");
        },
      };
      const adapter = new AiSdkModelAdapter({
        retry: { maxAttempts: 1 },
        runtime,
        registry: registry(),
      });

      await expect(
        executeAdapterGenerateText(adapter, {
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Select relevant memories" }],
          responseJsonSchema: {
            additionalProperties: false,
            properties: {
              selected_memories: { items: { type: "string" }, type: "array" },
            },
            required: ["selected_memories"],
            type: "object",
          },
          statusSink: {
            publish(event) {
              statusEvents.push(event);
            },
          },
        }),
      ).rejects.toBeInstanceOf(AiSdkModelAdapterError);

      expect(statusEvents.map((event) => event.type)).toEqual([
        "model_request_started",
        "model_request_failed",
      ]);
    },
  );

  it("adds request attribution headers to generateText requests", async () => {
    let captured: AiSdkGenerateTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured = options;
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    await executeAdapterGenerateText(adapter, {
      modelRequestSessionType: "main",
      metadata: {
        parentSpanId: "parent_span_generate",
        queryId: "query_generate",
        requestId: "model_req_generate",
        sessionId: "sess_generate",
        spanId: "span_generate",
        traceId: "trace_generate",
        turnId: "turn_generate",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
    });

    expect(captured?.headers).toEqual({
      "x-query-id": "generate",
      "x-request-id": "model_req_generate",
      "x-session-id": "generate",
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": "trace_generate",
    });
  });

  it("writes raw AI SDK request and response bodies in development mode", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-"));
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        return {
          text: "debug response",
          finishReason: "stop",
          reasoning: [
            { type: "reasoning", text: "inspect request\nthen answer" },
            { type: "reasoning", text: "verify result" },
          ],
          request: {
            body: {
              messages: options.messages,
              model: "model-a",
            },
          },
          response: {
            body: {
              id: "provider-response",
              output: [{ content: "debug response" }],
            },
            headers: {
              authorization: "Bearer secret",
              "x-request-id": "req_1",
            },
            id: "provider-response",
            messages: [],
            modelId: "model-a",
            timestamp: new Date("2026-05-04T00:00:00.000Z"),
          },
          totalUsage: usage(5, 6),
          usage: usage(5, 6),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: modelIODebugRegistry(),
      runtime,
    });

    try {
      await executeAdapterGenerateText(adapter, {
        metadata: {
          querySource: "session_title",
          sessionId: "sess_debug",
          traceId: "trace_debug",
          turnId: "turn_debug",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
      });

      const files = await readdir(debugDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe("model-io-sess_debug.jsonl");

      const content = await readFile(join(debugDir, files[0]!), "utf8");
      const record = JSON.parse(content.trim()) as {
        querySource?: string;
        request: { body: unknown; headers: Record<string, string> };
        response: { body: unknown; headers: Record<string, string>; reasoningText?: string };
        sessionId: string;
        traceId: string;
        turnId: string;
      };

      expect(record.traceId).toBe("trace_debug");
      expect(record.sessionId).toBe("sess_debug");
      expect(record.turnId).toBe("turn_debug");
      expect(record.querySource).toBe("session_title");
      expect(record.request.body).toMatchObject({
        messages: [{ role: "user", content: "Ping" }],
        model: "model-a",
      });
      expect((record.request as any).bodyMessagesKind).toBe("full");
      expect((record.request as any).bodyMessageOffset).toBe(0);
      expect((record.request as any).bodyMessageCount).toBe(1);
      expect(record.request.headers).toMatchObject({
        authorization: "[redacted]",
        "x-coding-plan-api-key": "[redacted]",
        "x-diagnostic-request": "visible",
        "x-off-peak-ticket-id": "[redacted]",
      });
      expect(record.response.body).toEqual({
        id: "provider-response",
        output: [{ content: "debug response" }],
      });
      expect(record.response.headers.authorization).toBe("[redacted]");
      expect(record.response.headers["x-request-id"]).toBe("req_1");
      expect(record.response.reasoningText).toBe("inspect request\nthen answer\n\nverify result");
      expect(content).not.toContain("offpeak-jwt-secret");
      expect(content).not.toContain("coding-plan-secret");
      expect(content).not.toContain("ticket-secret");
      expect(content).not.toContain("Bearer secret");
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("does not write model-io for a generate request marked to skip transcripts", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-skip-transcript-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "stop",
          text: "background memory complete",
          totalUsage: usage(1, 1),
          usage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: registry(),
      runtime,
    });

    try {
      await executeAdapterGenerateText(adapter, {
        metadata: {
          sessionId: "sess_background_memory",
          skipTranscript: true,
          traceId: "trace_background_memory",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "consolidate memory" }],
      });

      expect(await readdir(debugDir)).toEqual([]);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("reuses normalized native-null tool input in generateText model-io", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-generate-null-tool-"));
    const logs: CapturedLog[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          text: "",
          finishReason: "tool-calls",
          toolCalls: [
            {
              args: { file_path: "wrong.md" },
              input: null,
              toolCallId: "call_generate_null",
              toolName: "Read",
            },
          ],
          toolResults: [
            {
              dynamic: true,
              error: "Invalid tool input",
              input: null,
              toolCallId: "call_generate_null",
              toolName: "Read",
              type: "tool-error",
            },
          ],
          totalUsage: usage(5, 6),
          usage: usage(5, 6),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      logger: capturingLogger(logs),
      registry: registry(),
      runtime,
    });

    try {
      const result = await executeAdapterGenerateText(adapter, {
        metadata: { sessionId: "sess_generate_null_tool" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Read a file" }],
      });
      const [file] = await readdir(debugDir);
      const record = JSON.parse(await readFile(join(debugDir, file!), "utf8")) as {
        response: { toolCalls: unknown; toolResults: unknown };
      };

      expect(result.toolCalls).toEqual([{ id: "call_generate_null", input: {}, name: "Read" }]);
      expect(result.toolResults).toEqual([
        expect.objectContaining({ id: "call_generate_null", input: {}, name: "Read" }),
      ]);
      expect(record.response.toolCalls).toEqual(result.toolCalls);
      expect(record.response.toolResults).toEqual(result.toolResults);
      expect(
        logs.filter((entry) => entry.message === "Model tool input JSON normalization failed"),
      ).toHaveLength(1);
      expect(JSON.stringify(record.response.toolCalls)).not.toContain("wrong.md");
      expect(JSON.stringify(record.response.toolResults)).not.toMatch(/"input"\s*:\s*null/);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("writes raw AI SDK request and response bodies for streamText in development mode", async () => {
    // 回归用例:桌面/协议端默认走流式,旧实现不写 model-io,这里确保流式也落盘。
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-stream-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "debug response" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(5, 6),
            },
          ]),
          // 流式聚合字段是 promise,流读完后才 resolve。
          text: Promise.resolve("debug response"),
          reasoning: Promise.resolve([
            { type: "reasoning", text: "inspect stream" },
            { type: "reasoning", text: "verify stream" },
          ]),
          finishReason: Promise.resolve("stop"),
          totalUsage: Promise.resolve(usage(5, 6)),
          usage: Promise.resolve(usage(5, 6)),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
          sources: Promise.resolve([]),
          providerMetadata: Promise.resolve(undefined),
          request: Promise.resolve({
            body: {
              messages: options.messages,
              model: "model-a",
            },
          }),
          response: Promise.resolve({
            body: {
              id: "provider-response",
              output: [{ content: "debug response" }],
            },
            headers: {
              authorization: "Bearer secret",
              "x-request-id": "req_1",
            },
            id: "provider-response",
            messages: [],
            modelId: "model-a",
            timestamp: new Date("2026-05-04T00:00:00.000Z"),
          }),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: modelIODebugRegistry(),
      runtime,
    });

    try {
      for await (const _event of executeAdapterStreamText(adapter, {
        metadata: {
          sessionId: "sess_stream_debug",
          traceId: "trace_stream_debug",
          turnId: "turn_stream_debug",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
      })) {
        // drain stream so aggregate promises resolve
      }

      const files = await readdir(debugDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe("model-io-sess_stream_debug.jsonl");

      const content = await readFile(join(debugDir, files[0]!), "utf8");
      const record = JSON.parse(content.trim()) as {
        request: { body: unknown; headers: Record<string, string> };
        response: {
          body: unknown;
          headers: Record<string, string>;
          reasoningText?: string;
          text: string;
        };
        sessionId: string;
        traceId: string;
        turnId: string;
      };

      expect(record.traceId).toBe("trace_stream_debug");
      expect(record.sessionId).toBe("sess_stream_debug");
      expect(record.turnId).toBe("turn_stream_debug");
      expect(record.request.body).toMatchObject({
        messages: [{ role: "user", content: "Ping" }],
        model: "model-a",
      });
      expect((record.request as any).bodyMessagesKind).toBe("full");
      expect((record.request as any).bodyMessageOffset).toBe(0);
      expect((record.request as any).bodyMessageCount).toBe(1);
      expect(record.request.headers).toMatchObject({
        authorization: "[redacted]",
        "x-coding-plan-api-key": "[redacted]",
        "x-diagnostic-request": "visible",
        "x-off-peak-ticket-id": "[redacted]",
      });
      expect(record.response.body).toEqual({
        id: "provider-response",
        output: [{ content: "debug response" }],
      });
      expect(record.response.text).toBe("debug response");
      expect(record.response.reasoningText).toBe("inspect stream\n\nverify stream");
      expect(record.response.headers.authorization).toBe("[redacted]");
      expect(record.response.headers["x-request-id"]).toBe("req_1");
      expect(content).not.toContain("offpeak-jwt-secret");
      expect(content).not.toContain("coding-plan-secret");
      expect(content).not.toContain("ticket-secret");
      expect(content).not.toContain("Bearer secret");
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("writes request payload into model-io when streamText fails before response metadata", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-stream-fail-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        throw apiError("Param Incorrect", {
          isRetryable: false,
          responseBody: {
            code: 400,
            message: "Param Incorrect",
            param: "messages.12.content",
            type: "invalid_request",
          },
          statusCode: 400,
        });
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: registry(),
      runtime,
    });

    try {
      await expect(async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            querySource: "main_turn",
            sessionId: "sess_stream_failure_debug",
            traceId: "trace_stream_failure_debug",
            turnId: "turn_stream_failure_debug",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
        })) {
          // drain stream
        }
      }).rejects.toThrow(AiSdkModelAdapterError);

      const files = await readdir(debugDir);
      expect(files).toEqual(["model-io-sess_stream_failure_debug.jsonl"]);

      const content = await readFile(join(debugDir, files[0]!), "utf8");
      const record = JSON.parse(content.trim()) as {
        error: { message: string };
        request: {
          body?: {
            bodySource?: string;
            messages?: unknown;
            model?: string;
            stream?: boolean;
          };
        };
      };

      expect(record.error.message).toBe("Param Incorrect");
      expect(record.request.body).toMatchObject({
        bodySource: "ai_sdk_options",
        messages: [{ role: "user", content: "Ping" }],
        model: "model-a",
        stream: true,
      });
      expect((record.request as any).bodyMessagesKind).toBe("full");
      expect((record.request as any).bodyMessageOffset).toBe(0);
      expect((record.request as any).bodyMessageCount).toBe(1);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("prefers stream result request body when fullStream fails during consumption", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-stream-consume-fail-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        return {
          fullStream: failingStream(
            apiError("Param Incorrect", {
              isRetryable: false,
              statusCode: 400,
            }),
          ),
          request: Promise.resolve({
            body: {
              messages: options.messages,
              model: "model-a",
              rawMarker: "from-ai-sdk-request",
            },
          }),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: registry(),
      runtime,
    });

    try {
      await expect(async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            querySource: "main_turn",
            sessionId: "sess_stream_consume_failure_debug",
            traceId: "trace_stream_consume_failure_debug",
            turnId: "turn_stream_consume_failure_debug",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
        })) {
          // drain stream
        }
      }).rejects.toThrow(AiSdkModelAdapterError);

      const files = await readdir(debugDir);
      expect(files).toEqual(["model-io-sess_stream_consume_failure_debug.jsonl"]);

      const content = await readFile(join(debugDir, files[0]!), "utf8");
      const record = JSON.parse(content.trim()) as {
        request: {
          body?: {
            bodySource?: string;
            rawMarker?: string;
          };
        };
      };

      expect(record.request.body).toMatchObject({
        rawMarker: "from-ai-sdk-request",
      });
      expect(record.request.body?.bodySource).toBeUndefined();
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("does not wait for pending stream response metadata after mid-stream abort", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-stream-abort-pending-"));
    const abortController = new AbortController();
    const pendingResponse = new Promise<never>(() => undefined);
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        return {
          fullStream: streamThatStallsUntilAbort(options.abortSignal),
          request: Promise.resolve({
            body: {
              messages: options.messages,
              model: "model-a",
              rawMarker: "request-settled-before-abort",
            },
          }),
          response: pendingResponse,
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: registry(),
      runtime,
    });

    try {
      const drainStream = (async () => {
        try {
          for await (const _event of executeAdapterStreamText(adapter, {
            abortSignal: abortController.signal,
            metadata: {
              querySource: "main_turn",
              sessionId: "sess_stream_abort_pending_debug",
              traceId: "trace_stream_abort_pending_debug",
              turnId: "turn_stream_abort_pending_debug",
            },
            providerId: "test" as never,
            modelId: "model-a" as never,
            messages: [{ role: "user", content: "Ping" }],
          })) {
            // drain stream
          }
          return "resolved";
        } catch (error) {
          expect(error).toBeInstanceOf(AiSdkModelAdapterError);
          return "rejected";
        }
      })();

      await waitForTest(20);
      abortController.abort(new Error("ZCode Protocol session stopped"));

      await expect(
        Promise.race([drainStream, waitForTest(500).then(() => "timeout")]),
      ).resolves.toBe("rejected");
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("keeps failed stream request body messages full across repeated model-io records", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-stream-fail-full-"));
    let callCount = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        callCount += 1;
        throw apiError(`Param Incorrect ${callCount}`, {
          isRetryable: false,
          statusCode: 400,
        });
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      registry: registry(),
      runtime,
    });
    const runFailedRequest = async (messages: Array<{ role: string; content: string }>) => {
      await expect(async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            sessionId: "sess_stream_failure_full",
            traceId: "trace_stream_failure_full",
            turnId: "turn_stream_failure_full",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: messages as never,
        })) {
          // drain stream
        }
      }).rejects.toThrow(AiSdkModelAdapterError);
    };

    try {
      await runFailedRequest([{ role: "user", content: "first" }]);
      await runFailedRequest([
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]);

      const files = await readdir(debugDir);
      expect(files).toEqual(["model-io-sess_stream_failure_full.jsonl"]);
      const lines = (await readFile(join(debugDir, files[0]!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);

      expect(lines).toHaveLength(2);
      expect(lines[1].request.body.messages).toEqual([
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ]);
      expect(lines[1].request.bodyMessagesKind).toBe("full");
      expect(lines[1].request.bodyMessageOffset).toBe(0);
      expect(lines[1].request.bodyMessageCount).toBe(2);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("appends model-io records into one session file and stores repeated messages as deltas", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-session-"));
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        return {
          text: "ok",
          finishReason: "stop",
          request: {
            body: {
              messages: options.messages,
              model: "model-a",
            },
          },
          response: {
            body: {},
            headers: {},
            id: "provider-response",
            messages: [],
            modelId: "model-a",
            timestamp: new Date("2026-05-04T00:00:00.000Z"),
          },
          totalUsage: usage(1, 1),
          usage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: registry(),
      runtime,
    });

    try {
      await executeAdapterGenerateText(adapter, {
        metadata: { sessionId: "sess_delta", traceId: "trace_delta", turnId: "turn_delta" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "first" }],
      });
      await executeAdapterGenerateText(adapter, {
        metadata: { sessionId: "sess_delta", traceId: "trace_delta", turnId: "turn_delta" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      });

      const files = await readdir(debugDir);
      expect(files).toEqual(["model-io-sess_delta.jsonl"]);

      const lines = (await readFile(join(debugDir, files[0]!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      expect(lines).toHaveLength(2);
      expect(lines[0].request.messagesKind).toBe("full");
      expect(lines[0].request.messages).toHaveLength(1);
      expect(lines[1].request.messagesKind).toBe("delta");
      expect(lines[1].request.messageOffset).toBe(1);
      expect(lines[1].request.messageCount).toBe(3);
      expect(lines[1].request.messages).toEqual([
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ]);
      expect(lines[1].request.bodyMessagesKind).toBe("delta");
      expect(lines[1].request.bodyMessageOffset).toBe(1);
      expect(lines[1].request.bodyMessageCount).toBe(3);
      expect(lines[1].request.body.messages).toEqual([
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ]);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("writes a bounded tail baseline when production model-io cache is missing", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-tail-"));
    const filePath = join(debugDir, "model-io-sess_tail.jsonl");
    const longMessages = Array.from({ length: 70 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
          text: Promise.resolve("ok"),
          finishReason: Promise.resolve("stop"),
          totalUsage: Promise.resolve(usage(1, 1)),
          usage: Promise.resolve(usage(1, 1)),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
          sources: Promise.resolve([]),
          providerMetadata: Promise.resolve(undefined),
          request: Promise.resolve({ body: { messages: options.messages, model: "model-a" } }),
          response: Promise.resolve({
            body: { raw: "large body" },
            headers: {},
            id: "r",
            modelId: "m",
          }),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      registry: registry(),
      runtime,
    });

    try {
      await writeFile(filePath, '{"type":"model_io","sessionId":"sess_tail"}\n', "utf8");

      for await (const _event of executeAdapterStreamText(adapter, {
        metadata: { sessionId: "sess_tail" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: longMessages as never,
      })) {
        // drain
      }

      const lines = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      expect(lines).toHaveLength(2);
      const record = lines[1];
      expect(record.request.messagesKind).toBe("tail");
      expect(record.request.messageOffset).toBe(6);
      expect(record.request.messageCount).toBe(70);
      expect(record.request.messages).toHaveLength(64);
      expect(record.request.sdkMessages).toBeUndefined();
      expect(record.request.body.messages).toBeUndefined();
      expect(record.response.body).toBeUndefined();
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("resets an oversized production model-io session file before writing", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-reset-"));
    const filePath = join(debugDir, "model-io-sess_reset.jsonl");
    const longMessages = Array.from({ length: 70 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
          text: Promise.resolve("ok"),
          finishReason: Promise.resolve("stop"),
          totalUsage: Promise.resolve(usage(1, 1)),
          usage: Promise.resolve(usage(1, 1)),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
          sources: Promise.resolve([]),
          providerMetadata: Promise.resolve(undefined),
          request: Promise.resolve({ body: { messages: options.messages, model: "model-a" } }),
          response: Promise.resolve({
            body: { raw: "large body" },
            headers: {},
            id: "r",
            modelId: "m",
          }),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      registry: registry(),
      runtime,
    });

    try {
      await writeFile(filePath, "stale", "utf8");
      await truncate(filePath, 65 * 1024 * 1024);

      for await (const _event of executeAdapterStreamText(adapter, {
        metadata: { sessionId: "sess_reset" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: longMessages as never,
      })) {
        // drain
      }

      const afterStat = await stat(filePath);
      expect(afterStat.size).toBeLessThan(1024 * 1024);
      const lines = (await readFile(filePath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as any;
      expect(record.modelIOReset.reason).toBe("session_file_size_limit");
      expect(record.modelIOReset.previousFileBytes).toBe(65 * 1024 * 1024);
      expect(record.request.messagesKind).toBe("tail");
      expect(record.request.messages).toHaveLength(64);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("caps production model-io session files at 3 and evicts the oldest", async () => {
    // 生产态(ZCODE_RUNTIME_ENV=production)写 rollout,需限量;这里用显式 debugDir 验证淘汰逻辑。
    // 每个 session 一个文件,顺序写 5 个 session 后应只剩最新的 3 个。
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-rollout-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
          text: Promise.resolve("ok"),
          finishReason: Promise.resolve("stop"),
          totalUsage: Promise.resolve(usage(1, 1)),
          usage: Promise.resolve(usage(1, 1)),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
          sources: Promise.resolve([]),
          providerMetadata: Promise.resolve(undefined),
          request: Promise.resolve({ body: {} }),
          response: Promise.resolve({ body: {}, headers: {}, id: "r", modelId: "m" }),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      registry: registry(),
      runtime,
    });

    try {
      // 顺序写 5 个 session 文件,淘汰按文件 mtime 保留最近的 session。
      for (let i = 0; i < 5; i += 1) {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: { sessionId: `sess_${String(i).padStart(2, "0")}` },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
        })) {
          // drain
        }
      }

      const files = (await readdir(debugDir)).sort();
      expect(files).toHaveLength(3);
      // 最旧的 sess_00 / sess_01 应被淘汰,保留 sess_02..sess_04。
      expect(files.some((f) => f.includes("sess_00"))).toBe(false);
      expect(files.some((f) => f.includes("sess_01"))).toBe(false);
      expect(files.some((f) => f.includes("sess_04"))).toBe(true);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("keeps complete production ModelIO records and all session files when full retention is enabled", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-full-retention-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
          text: Promise.resolve("ok"),
          finishReason: Promise.resolve("stop"),
          totalUsage: Promise.resolve(usage(1, 1)),
          usage: Promise.resolve(usage(1, 1)),
          toolCalls: Promise.resolve([]),
          toolResults: Promise.resolve([]),
          sources: Promise.resolve([]),
          providerMetadata: Promise.resolve(undefined),
          request: Promise.resolve({
            body: { messages: options.messages, model: "model-a" },
          }),
          response: Promise.resolve({
            body: { raw: "provider-response" },
            headers: { authorization: "Bearer secret" },
            id: "r",
            modelId: "m",
          }),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      modelIoFullRetentionEnabled: true,
      registry: registry(),
      runtime,
    });

    try {
      const writeSession = async (sessionId: string, messages: unknown[]) => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: { sessionId },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: messages as never,
        })) {
          // drain
        }
      };

      await writeSession("sess_full", [{ role: "user", content: "first" }]);
      await writeSession("sess_full", [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ]);
      for (let index = 0; index < 4; index += 1) {
        await writeSession(`sess_extra_${index}`, [{ role: "user", content: "ping" }]);
      }

      expect(await readdir(debugDir)).toHaveLength(5);
      const records = (await readFile(join(debugDir, "model-io-sess_full.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      expect(records).toHaveLength(2);
      expect(records[1].request.messages).toHaveLength(3);
      expect(records[1].request.messagesKind).toBeUndefined();
      expect(records[1].request.sdkMessages).toHaveLength(3);
      expect(records[1].request.body.messages).toHaveLength(3);
      expect(records[1].response.body).toEqual({ raw: "provider-response" });
      expect(records[1].response.headers.authorization).toBe("[redacted]");

      const fullSessionPath = join(debugDir, "model-io-sess_full.jsonl");
      await truncate(fullSessionPath, 65 * 1024 * 1024);
      await writeSession("sess_full", [{ role: "user", content: "after-limit" }]);
      expect((await stat(fullSessionPath)).size).toBeGreaterThan(65 * 1024 * 1024);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("does not record model-io in test env (ZCODE_RUNTIME_ENV=test)", async () => {
    // 安全网:测试态不应产生磁盘副作用。
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-testenv-"));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "test" },
      registry: registry(),
      runtime,
    });

    try {
      for await (const _event of executeAdapterStreamText(adapter, {
        metadata: { sessionId: "sess_test" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
      })) {
        // drain
      }
      const files = await readdir(debugDir);
      expect(files).toHaveLength(0);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("publishes retry reasons and retries retryable generateText failures", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkGenerateTextOptions[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        attempts += 1;
        captured.push(options);
        if (attempts === 1) {
          throw apiError("rate limited", {
            isRetryable: true,
            responseHeaders: { "retry-after": "0" },
            statusCode: 429,
          });
        }

        return {
          text: "after retry",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      modelRequestSessionType: "main",
      metadata: {
        requestId: "model_req_1",
        sessionId: "sess_retry",
        traceId: "trace_retry",
        turnId: "turn_retry",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    expect(result.text).toBe("after retry");
    expect(attempts).toBe(2);
    expect(captured.every((options) => options.maxRetries === 0)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      requestId: "model_req_1",
      sessionId: "sess_retry",
      traceId: "trace_retry",
      turnId: "turn_retry",
    });
    expect(events[1].requestId).toBe("model_req_1");
    expect(events[2].requestId).toBe("model_req_1");
    expect(events[1]).toMatchObject({
      reason: "rate_limited",
      retryable: true,
      statusCode: 429,
    });
    expect(events[2]).toMatchObject({
      delayMs: 0,
      nextAttempt: 2,
      reason: "rate_limited",
      statusCode: 429,
    });
    expect(events[3]).toMatchObject({
      attempt: 2,
      requestId: expect.any(String),
      sessionId: "sess_retry",
      traceId: "trace_retry",
      turnId: "turn_retry",
    });
    expect(events[3].requestId).not.toBe("model_req_1");
    expect(events[4]).toMatchObject({
      attempt: 2,
      finishReason: "stop",
      requestId: events[3].requestId,
      type: "model_request_completed",
    });
    expect(captured[0]?.headers).toMatchObject({
      "x-request-id": "model_req_1",
      "x-zcode-session-type": "main",
    });
    expect(captured[1]?.headers).toMatchObject({
      "x-request-id": events[3].requestId,
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": "trace_retry",
    });
  });

  it("keeps OpenCode Go session header stable across generate retries", async () => {
    const captured: AiSdkGenerateTextOptions[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured.push(options);
        attempts += 1;
        if (attempts === 1) {
          throw apiError("rate limited", {
            isRetryable: true,
            responseHeaders: { "retry-after": "0" },
            statusCode: 429,
          });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          "custom-provider": {
            kind: "openai-compatible",
            baseURL: "https://opencode.ai/zen/go/v1",
          },
        },
      }),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "custom-provider" as never,
      modelId: "kimi-k2.5" as never,
      metadata: { sessionId: "sess_conversation_stable", traceId: "trace_opencode_retry" },
      messages: [{ role: "user", content: "Ping" }],
    });

    expect(captured).toHaveLength(2);
    expect(
      captured.map((options) => (options.headers as Record<string, string>)["x-opencode-session"]),
    ).toEqual(["conversation_stable", "conversation_stable"]);
  });

  it("retries one rejected Anthropic thinking signature and records each request-local attempt", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-signature-repair-generate-"));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkGenerateTextOptions[] = [];
    const messages = signatureReplayMessages();
    const snapshot = structuredClone(messages);
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured.push(options);
        if (captured.length === 1) {
          throw apiError("signature in thinking block is invalid", {
            isRetryable: false,
            statusCode: 400,
          });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    try {
      const result = await executeAdapterGenerateText(adapter, {
        metadata: {
          sessionId: "sess_signature_repair_generate",
          traceId: "trace_signature_repair_generate",
          turnId: "turn_signature_repair_generate",
        },
        providerId: "deepseek" as never,
        modelId: "model-a" as never,
        messages,
        statusSink: { publish: (event) => statusEvents.push(event) },
      });

      expect(result.text).toBe("done");
      expect(result.signedReasoningReset).toBe(true);
      expect(captured).toHaveLength(2);
      expectSignatureReplayRequest(captured[0]!.messages, true);
      expectSignatureReplayRequest(captured[1]!.messages, false);
      expect(statusEvents.map((event) => event.type)).toEqual([
        "model_request_started",
        "model_request_failed",
        "model_retry_scheduled",
        "model_request_started",
        "model_request_completed",
      ]);
      expect(statusEvents.map((event) => event.attempt)).toEqual([1, 1, 1, 2, 2]);
      expect(statusEvents[1]).toMatchObject({
        maxAttempts: 2,
        retryable: true,
        statusCode: 400,
      });
      expect(statusEvents[2]).toMatchObject({
        delayMs: 0,
        maxAttempts: 2,
        nextAttempt: 2,
        reason: "reasoning_signature_repair",
        statusCode: 400,
      });
      expect(statusEvents[3]).toMatchObject({ attempt: 2, maxAttempts: 2 });
      expect(statusEvents[3]!.requestId).not.toBe(statusEvents[0]!.requestId);

      const [fileName] = await readdir(debugDir);
      const records = (await readFile(join(debugDir, fileName!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      expect(records).toHaveLength(2);
      expect(records[0].request.messages.map((message: any) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(records[0].request.messages[1].content).toEqual([
        { type: "text", text: "(no content)" },
      ]);
      expect(records[1].request.messages.map((message: any) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(records[1].request.messages[1].content).toEqual([
        { type: "text", text: "(no content)" },
      ]);
      expect(records[1].request.messages[3].content).toEqual([
        { type: "reasoning", text: "unsigned" },
        { type: "text", text: "answer" },
      ]);
      expect(messages).toEqual(snapshot);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      failures: ["signature", "ordinary"] as const,
      name: "signature repair before an ordinary retry",
      retryReasons: ["reasoning_signature_repair", "server_error"],
      signedAttempts: [true, false, false],
    },
    {
      failures: ["ordinary", "signature"] as const,
      name: "an ordinary retry before signature repair",
      retryReasons: ["server_error", "reasoning_signature_repair"],
      signedAttempts: [true, true, false],
    },
  ])("keeps generate retry budgets independent for $name", async (testCase) => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkGenerateTextOptions[] = [];
    const messages = signatureReplayMessages();
    const snapshot = structuredClone(messages);
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured.push(options);
        const failure = testCase.failures[captured.length - 1];
        if (failure === "signature") {
          throw apiError("signature in thinking block is invalid", {
            isRetryable: false,
            statusCode: 400,
          });
        }
        if (failure === "ordinary") {
          throw apiError("provider temporarily unavailable", {
            isRetryable: true,
            responseHeaders: { "retry-after": "0" },
            statusCode: 500,
          });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      messages,
      statusSink: { publish: (event) => statusEvents.push(event) },
    });

    expect(result.text).toBe("done");
    expect(result.signedReasoningReset).toBe(true);
    expect(captured).toHaveLength(3);
    testCase.signedAttempts.forEach((includeSigned, index) =>
      expectSignatureReplayRequest(captured[index]!.messages, includeSigned),
    );
    const retryEvents = statusEvents.filter((event) => event.type === "model_retry_scheduled");
    expect(retryEvents.map((event) => event.reason)).toEqual(testCase.retryReasons);
    expect(retryEvents.map((event) => event.nextAttempt)).toEqual([2, 3]);
    const startedEvents = statusEvents.filter((event) => event.type === "model_request_started");
    expect(startedEvents.map((event) => event.attempt)).toEqual([1, 2, 3]);
    expect(new Set(startedEvents.map((event) => event.requestId)).size).toBe(3);
    expect(messages).toEqual(snapshot);
  });

  it("does not report a repair marker when no signature repair ran", async () => {
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        if (calls === 1) {
          throw apiError("provider temporarily unavailable", {
            isRetryable: true,
            responseHeaders: { "retry-after": "0" },
            statusCode: 500,
          });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      messages: signatureReplayMessages(),
    });

    expect(result.text).toBe("done");
    expect(calls).toBe(2);
    expect(result).not.toHaveProperty("signedReasoningReset");
  });

  it("stops generate signature repair after one rejected repaired attempt", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkGenerateTextOptions[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured.push(options);
        throw apiError("signature in thinking block is invalid", {
          isRetryable: false,
          statusCode: 400,
        });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "deepseek" as never,
        modelId: "model-a" as never,
        messages: signatureReplayMessages(),
        statusSink: { publish: (event) => statusEvents.push(event) },
      }),
    ).rejects.toMatchObject({ code: ModelErrorCode.InvalidModelRequest });

    expect(captured).toHaveLength(2);
    expectSignatureReplayRequest(captured[0]!.messages, true);
    expectSignatureReplayRequest(captured[1]!.messages, false);
    expect(
      statusEvents
        .filter((event) => event.type === "model_retry_scheduled")
        .map((event) => event.reason),
    ).toEqual(["reasoning_signature_repair"]);
  });

  it("does not retry a thinking signature rejection when removing rejected blocks changes nothing", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        throw apiError("signature in thinking block is invalid", {
          isRetryable: false,
          statusCode: 400,
        });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "deepseek" as never,
        modelId: "model-a" as never,
        messages: signatureReplayMessages(false),
      }),
    ).rejects.toMatchObject({ code: ModelErrorCode.InvalidModelRequest });
    expect(attempts).toBe(1);
  });

  it("uses ten retries by default and logs retry budget", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const logs: CapturedLog[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts <= 10) {
          throw apiError("server busy", {
            isRetryable: true,
            responseHeaders: { "retry-after": "0" },
            statusCode: 500,
          });
        }

        return {
          text: "eventually ok",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      metadata: { requestId: "model_req_default_retry", traceId: "trace_default_retry" },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    const retryEvents = events.filter((event) => event.type === "model_retry_scheduled");
    expect(result.text).toBe("eventually ok");
    expect(attempts).toBe(11);
    expect(retryEvents).toHaveLength(10);
    expect(events[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 11,
    });
    expect(retryEvents[retryEvents.length - 1]).toMatchObject({
      attempt: 10,
      delayMs: 0,
      maxAttempts: 11,
      nextAttempt: 11,
    });
    expect(events[events.length - 1]).toMatchObject({
      attempt: 11,
      maxAttempts: 11,
      type: "model_request_completed",
    });
    const retryLog = logs.find((entry) => entry.context?.event === "model.retry.scheduled");
    expect(retryLog).toMatchObject({
      level: "warn",
      message: "Model request retry scheduled",
      context: {
        maxAttempts: 11,
        maxRetries: 10,
        status: "waiting",
      },
    });
    const retryDelayLog = logs.find(
      (entry) => entry.context?.event === "model.retry.delay.resolved",
    );
    expect(retryDelayLog).toMatchObject({
      level: "warn",
      message: "Model retry delay decision inspected",
      context: {
        canRetry: true,
        delayMs: 0,
        retryAfterHeader: "0",
        retryAfterMs: 0,
        retryAfterSource: "provider_header",
        retryReason: "server_error",
        status: "waiting",
      },
    });
  });

  it("uses ten retries by default for HTTP 200 provider 1302 rate limits", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts <= 10) {
          throw new ProviderBusinessError({
            providerCode: "1302",
            providerId: "account:bigmodel-individual-coding-plan",
            providerKind: "anthropic",
            providerMessage:
              "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
            providerRequestId: "20260605191846d4c0880887ed4c8d",
            responseBodySummary: {
              error: {
                code: "1302",
                message:
                  "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
                type: "rate_limit_error",
              },
              request_id: "20260605191846d4c0880887ed4c8d",
              type: "error",
            },
            responseStatus: 200,
          });
        }

        return {
          text: "ok after rate limit retry",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      metadata: { requestId: "model_req_1302_retry", traceId: "trace_1302_retry" },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    const retryEvents = events.filter((event) => event.type === "model_retry_scheduled");
    expect(result.text).toBe("ok after rate limit retry");
    expect(attempts).toBe(11);
    expect(retryEvents).toHaveLength(10);
    expect(events[1]).toMatchObject({
      reason: "rate_limited",
      retryable: true,
      statusCode: undefined,
    });
    expect(retryEvents[0]).toMatchObject({
      attempt: 1,
      delayMs: 0,
      maxAttempts: 11,
      nextAttempt: 2,
      reason: "rate_limited",
    });
    expect(retryEvents[retryEvents.length - 1]).toMatchObject({
      attempt: 10,
      delayMs: 0,
      maxAttempts: 11,
      nextAttempt: 11,
      reason: "rate_limited",
    });
  });

  it("uses ten retries by default for HTTP 200 provider internal network failures", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts <= 10) {
          throw new ProviderBusinessError({
            providerId: "account:bigmodel-individual-coding-plan",
            providerKind: "anthropic",
            providerMessage: "Internal Network Failure",
            providerRequestId: "20260605180401a5d2482ebda148a5",
            responseBodySummary: {
              error: {
                message: "Internal Network Failure",
                type: "api_error",
              },
              request_id: "20260605180401a5d2482ebda148a5",
              type: "error",
            },
            responseStatus: 200,
          });
        }

        return {
          text: "ok after internal network retry",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      metadata: {
        requestId: "model_req_internal_network_retry",
        traceId: "trace_internal_network_retry",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    const retryEvents = events.filter((event) => event.type === "model_retry_scheduled");
    expect(result.text).toBe("ok after internal network retry");
    expect(attempts).toBe(11);
    expect(retryEvents).toHaveLength(10);
    expect(events[1]).toMatchObject({
      message: "Internal Network Failure",
      reason: "network_error",
      retryable: true,
      statusCode: undefined,
    });
    expect(retryEvents[retryEvents.length - 1]).toMatchObject({
      attempt: 10,
      delayMs: 0,
      maxAttempts: 11,
      nextAttempt: 11,
      reason: "network_error",
    });
  });

  it("uses ZCODE_MODEL_RETRY env defaults for retry budget and delay", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts <= 2) {
          throw apiError("server busy", {
            isRetryable: true,
            statusCode: 500,
          });
        }

        return {
          text: "after env retry",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      env: {
        ZCODE_MODEL_RETRY_BACKOFF_FACTOR: "3",
        ZCODE_MODEL_RETRY_BASE_DELAY_MS: "7",
        ZCODE_MODEL_RETRY_MAX_DELAY_MS: "20",
        ZCODE_MODEL_RETRY_MAX_RETRIES: "2",
      },
      registry: registry(),
      retry: { jitter: false },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    const retryEvents = events.filter((event) => event.type === "model_retry_scheduled");
    expect(result.text).toBe("after env retry");
    expect(attempts).toBe(3);
    expect(events[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
    });
    expect(retryEvents.map((event) => event.delayMs)).toEqual([7, 20]);
    expect(retryEvents[1]).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      nextAttempt: 3,
    });
  });

  it("lets explicit retry options override ZCODE_MODEL_RETRY env defaults", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts === 1) {
          throw apiError("server busy", {
            isRetryable: true,
            statusCode: 500,
          });
        }

        return {
          text: "after explicit retry",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      env: {
        ZCODE_MODEL_RETRY_BASE_DELAY_MS: "100",
        ZCODE_MODEL_RETRY_MAX_RETRIES: "9",
      },
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    expect(attempts).toBe(2);
    expect(events[0]).toMatchObject({ maxAttempts: 2 });
    expect(events[2]).toMatchObject({ delayMs: 0, maxAttempts: 2 });
  });

  it("ignores invalid ZCODE_MODEL_RETRY env values", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts <= 10) {
          throw apiError("server busy", {
            isRetryable: true,
            responseHeaders: { "retry-after": "0" },
            statusCode: 500,
          });
        }

        return {
          text: "after default retry",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      env: {
        ZCODE_MODEL_RETRY_BACKOFF_FACTOR: "0",
        ZCODE_MODEL_RETRY_BASE_DELAY_MS: "-1",
        ZCODE_MODEL_RETRY_MAX_DELAY_MS: "nope",
        ZCODE_MODEL_RETRY_MAX_RETRIES: "-5",
      },
      registry: registry(),
      retry: { jitter: false },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    expect(result.text).toBe("after default retry");
    expect(attempts).toBe(11);
    expect(events[0]).toMatchObject({ maxAttempts: 11 });
  });

  it("uses default exponential retry delays up to the one-minute cap", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const events: ModelNetworkStatusEvent[] = [];
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          attempts += 1;
          if (attempts <= 8) {
            throw apiError("server busy", {
              isRetryable: true,
              statusCode: 500,
            });
          }

          return {
            text: "after capped delay",
            finishReason: "stop",
            usage: usage(2, 3),
            totalUsage: usage(2, 3),
          } as never;
        },
        streamText() {
          throw new Error("not used");
        },
      };
      const adapter = new AiSdkModelAdapter({
        registry: registry(),
        runtime,
      });

      const resultPromise = executeAdapterGenerateText(adapter, {
        metadata: { requestId: "model_req_default_delay", traceId: "trace_default_delay" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            events.push(event);
          },
        },
      });
      const retryEvents = () => events.filter((event) => event.type === "model_retry_scheduled");
      const waitForRetryEvents = async (count: number) => {
        for (let turn = 0; turn < 20 && retryEvents().length < count; turn += 1) {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(retryEvents()).toHaveLength(count);
      };

      const expectedDelayMs = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000];

      for (const [index, delayMs] of expectedDelayMs.entries()) {
        await waitForRetryEvents(index + 1);
        expect(retryEvents()[index]).toMatchObject({ delayMs });
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      await expect(resultPromise).resolves.toMatchObject({
        text: "after capped delay",
      });
      expect(attempts).toBe(9);
      expect(retryEvents().map((event) => event.delayMs)).toEqual(expectedDelayMs);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("prefers retry-after-ms over retry-after without applying the normal maxDelay cap", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts === 1) {
          throw apiError("rate limited", {
            isRetryable: true,
            responseHeaders: { "Retry-After-Ms": "13", "retry-after": "0" },
            statusCode: 429,
          });
        }

        return {
          text: "after provider delay",
          finishReason: "stop",
          usage: usage(2, 3),
          totalUsage: usage(2, 3),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    expect(events[2]).toMatchObject({
      delayMs: 13,
      nextAttempt: 2,
      reason: "rate_limited",
      statusCode: 429,
      type: "model_retry_scheduled",
    });
  });

  it("publishes non-retryable failure reasons and wraps provider errors", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        throw apiError("bad key", {
          isRetryable: false,
          responseHeaders: { "retry-after": "120" },
          statusCode: 401,
        });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    await expect(
      executeAdapterGenerateText(adapter, {
        metadata: { requestId: "model_req_auth", traceId: "trace_auth" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            events.push(event);
          },
        },
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.ProviderNotConfigured,
      context: {
        errorPhase: "response",
        exceptionKind: "generic",
      },
      message: "Provider authentication failed.",
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);

    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(events[1]).toMatchObject({
      message: "Provider authentication failed.",
      reason: "auth_failed",
      retryable: false,
      statusCode: 401,
    });
    expect(attempts).toBe(1);
  });

  it("does not automatically retry Start Plan concurrency failures", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        throw new ProviderBusinessError({
          providerCode: "3010",
          providerId: "account:zai-start-plan",
          providerKind: "openai-compatible",
          providerMessage: "当前系统繁忙，请稍后再试或升级账户。",
          responseBodySummary: {
            code: 3010,
            msg: "当前系统繁忙，请稍后再试或升级账户。",
          },
          responseStatus: 429,
          statusCode: 429,
        });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    await expect(
      executeAdapterGenerateText(adapter, {
        metadata: { requestId: "model_req_start_plan_busy", traceId: "trace_start_plan_busy" },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            events.push(event);
          },
        },
      }),
    ).rejects.toMatchObject({
      code: ModelErrorCode.ModelRateLimited,
      message: "当前系统繁忙，请稍后再试或升级账户。",
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(events[1]).toMatchObject({
      message: "当前系统繁忙，请稍后再试或升级账户。",
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it("does not automatically retry streamed OpenAI-compatible exhausted quotas", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const message = "Your token-plan 5-hour quota has been exhausted. The quota will reset later.";
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: failingStream(
            new APICallError({
              data: {
                error: {
                  code: "insufficient_quota",
                  message,
                  type: "insufficient_quota",
                },
                request_id: "provider_req_insufficient_quota",
              },
              message,
              requestBodyValues: {},
              responseHeaders: { "retry-after": "16097" },
              statusCode: 429,
              url: "https://api.example.com/v1/chat/completions",
            }),
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 11, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        metadata: {
          requestId: "model_req_insufficient_quota",
          traceId: "trace_insufficient_quota",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            events.push(event);
          },
        },
      })) {
        // consume
      }
      return undefined;
    })().then(
      (result) => result,
      (caught: unknown) => caught,
    );

    expect(terminalError).toMatchObject({
      code: ModelErrorCode.ModelRateLimited,
      context: {
        providerCode: "insufficient_quota",
        providerRequestId: "provider_req_insufficient_quota",
        responseStatus: 429,
      },
      message,
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);
    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(events[1]).toMatchObject({
      message,
      providerErrorCode: "insufficient_quota",
      providerErrorMessage: message,
      providerRequestId: "provider_req_insufficient_quota",
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it("retries HTTP 200 provider business server errors before succeeding", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts < 3) {
          throw new ProviderBusinessError({
            providerCode: 500,
            providerId: "zai",
            providerKind: "openai-compatible",
            providerMessage: "操作失败",
            responseBodySummary: {
              code: 500,
              msg: "操作失败",
              success: false,
            },
            responseStatus: 200,
            statusCode: 500,
          });
        }

        return {
          text: "ok after business retry",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      metadata: { requestId: "model_req_business", traceId: "trace_business" },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    });

    expect(result.text).toBe("ok after business retry");
    expect(attempts).toBe(3);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      message: "操作失败",
      reason: "server_error",
      retryable: true,
      statusCode: 500,
    });
    expect(events[2]).toMatchObject({
      nextAttempt: 2,
      reason: "server_error",
      statusCode: 500,
      type: "model_retry_scheduled",
    });
    expect(events[4]).toMatchObject({
      message: "操作失败",
      reason: "server_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("retries SSE provider business server errors before succeeding", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts < 3) {
          return {
            fullStream: failingStream(
              new ProviderBusinessError({
                providerCode: "500",
                providerId: "zai",
                providerKind: "openai-compatible",
                providerMessage: "操作失败",
                providerRequestId: "202605071534036305f9b2224c4c1f",
                responseBodySummary: {
                  error: {
                    code: "500",
                    message: "操作失败",
                  },
                  request_id: "202605071534036305f9b2224c4c1f",
                },
                responseStatus: 200,
                statusCode: 500,
              }),
            ),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_sse_business_500",
        traceId: "trace_sse_business_500",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          events.push(event);
        },
      },
    })) {
      streamed.push(event);
    }

    expect(streamed).toHaveLength(2);
    expect(streamed[0]).toEqual({ id: "1", text: "ok", type: "text_delta" });
    expect(streamed[1]).toMatchObject({
      finishReason: "stop",
      type: "finish",
      usage: {
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: undefined,
        totalTokens: 2,
      },
    });
    expect(attempts).toBe(3);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      message: "操作失败",
      reason: "server_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("publishes SSE provider business failures as user-visible stream errors", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: failingStream(
            new ProviderBusinessError({
              providerCode: "1311",
              providerId: "zai",
              providerKind: "openai-compatible",
              providerMessage: "当前订阅套餐暂未开放GLM-5V-Turbo权限",
              providerRequestId: "20260505201906b147bc4aa7cd4e58",
              responseBodySummary: {
                error: {
                  code: "1311",
                  message: "当前订阅套餐暂未开放GLM-5V-Turbo权限",
                },
                request_id: "20260505201906b147bc4aa7cd4e58",
              },
              responseStatus: 200,
            }),
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    await expect(
      (async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            requestId: "model_req_sse_business",
            traceId: "trace_sse_business",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
          statusSink: {
            publish(event) {
              events.push(event);
            },
          },
        })) {
          // Provider business failures should throw before yielding a protocol error event.
        }
      })(),
    ).rejects.toMatchObject({
      code: ModelErrorCode.ModelRequestFailed,
      context: {
        errorPhase: "stream",
        exceptionKind: "provider_business",
        providerCode: "1311",
        providerRequestId: "20260505201906b147bc4aa7cd4e58",
        responseStatus: 200,
      },
      message: "当前订阅套餐暂未开放GLM-5V-Turbo权限",
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);

    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(events[1]).toMatchObject({
      message: "当前订阅套餐暂未开放GLM-5V-Turbo权限",
      reason: "unknown",
      retryable: false,
    });
  });

  it("maps text stream chunks into protocol stream events", async () => {
    let captured: AiSdkStreamTextOptions | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options: AiSdkStreamTextOptions) {
        captured = options;
        expect(options.messages).toEqual([{ role: "user", content: "Ping" }]);
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "he" },
            { type: "text-delta", id: "1", text: "llo" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const events = [];
    for await (const event of executeAdapterStreamText(adapter, {
      modelRequestSessionType: "subagent",
      metadata: {
        requestId: "model_req_stream",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      traceContext: {
        parentSpanId: "parent_span_stream",
        sessionId: "sess_stream" as never,
        spanId: "span_stream",
        traceId: "trace_stream" as never,
        turnId: "turn_stream" as never,
        queryId: "query_stream" as never,
      },
    })) {
      events.push(event);
    }

    expect(captured?.headers).toEqual({
      "x-query-id": "stream",
      "x-request-id": "model_req_stream",
      "x-session-id": "stream",
      "x-zcode-session-type": "subagent",
      "x-zcode-trace-id": "trace_stream",
    });
    expect(captured?.allowSystemInMessages).toBe(true);
    expect(events).toEqual([
      { type: "text_delta", id: "1", text: "he" },
      { type: "text_delta", id: "1", text: "llo" },
      {
        type: "finish",
        finishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    ]);
  });

  it("preserves raw provider finish reasons on stream finish events", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "text-delta", id: "partial", text: "partial answer" },
            {
              type: "finish",
              finishReason: "other",
              rawFinishReason: "model_context_window_exceeded",
              totalUsage: usage(180, 0),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const events = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", id: "partial", text: "partial answer" },
      {
        type: "finish",
        finishReason: "other",
        providerMetadata: { rawFinishReason: "model_context_window_exceeded" },
        usage: expect.objectContaining({ inputTokens: 180, outputTokens: 0, totalTokens: 180 }),
      },
    ]);
  });

  it("retries retryable stream error chunks before visible output", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkStreamTextOptions[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        captured.push(options);
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: stream([
              { type: "start" },
              {
                type: "error",
                error: apiError("rate limited", {
                  isRetryable: true,
                  responseHeaders: { "retry-after": "0" },
                  statusCode: 429,
                }),
              },
            ]),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-delta", id: "retry-text", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streamEvents = [];
    for await (const event of executeAdapterStreamText(adapter, {
      modelRequestSessionType: "subagent",
      metadata: {
        requestId: "model_req_stream_retry",
        traceId: "trace_stream_retry",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      streamEvents.push(event);
    }

    expect(attempts).toBe(2);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(statusEvents[0]).toMatchObject({
      attempt: 1,
      requestId: "model_req_stream_retry",
      traceId: "trace_stream_retry",
    });
    expect(statusEvents[1]).toMatchObject({
      attempt: 1,
      message: "Provider rate limited the model request.",
      reason: "rate_limited",
      retryable: true,
      requestId: "model_req_stream_retry",
      statusCode: 429,
    });
    expect(statusEvents[2]).toMatchObject({
      attempt: 1,
      delayMs: 0,
      nextAttempt: 2,
      reason: "rate_limited",
      requestId: "model_req_stream_retry",
      statusCode: 429,
      type: "model_retry_scheduled",
    });
    expect(statusEvents[3]).toMatchObject({
      attempt: 2,
      requestId: expect.any(String),
      traceId: "trace_stream_retry",
    });
    expect(statusEvents[3].requestId).not.toBe("model_req_stream_retry");
    expect(statusEvents[4]).toMatchObject({
      attempt: 2,
      requestId: statusEvents[3].requestId,
      type: "model_request_completed",
    });
    expect(captured[0]?.headers).toMatchObject({
      "x-request-id": "model_req_stream_retry",
      "x-zcode-session-type": "subagent",
    });
    expect(captured[1]?.headers).toMatchObject({
      "x-request-id": statusEvents[3].requestId,
      "x-zcode-session-type": "subagent",
      "x-zcode-trace-id": "trace_stream_retry",
    });
    expect(streamEvents).toEqual([
      { type: "start" },
      { type: "text_delta", id: "retry-text", text: "ok" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    ]);
  });

  it("retries one rejected Anthropic thinking signature from a pre-output stream error", async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-signature-repair-stream-"));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkStreamTextOptions[] = [];
    const messages = signatureReplayMessages();
    const snapshot = structuredClone(messages);
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        captured.push(options);
        if (captured.length === 1) {
          return {
            fullStream: stream([
              { type: "start" },
              {
                type: "error",
                error: apiError("thinking block cannot be modified", {
                  isRetryable: false,
                  statusCode: 400,
                }),
              },
            ]),
          } as never;
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-delta", id: "text-1", text: "done" },
            { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "production" },
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    try {
      const streamEvents: ModelStreamEvent[] = [];
      for await (const event of executeAdapterStreamText(adapter, {
        metadata: {
          sessionId: "sess_signature_repair_stream",
          traceId: "trace_signature_repair_stream",
          turnId: "turn_signature_repair_stream",
        },
        providerId: "deepseek" as never,
        modelId: "model-a" as never,
        messages,
        statusSink: { publish: (status) => statusEvents.push(status) },
      })) {
        streamEvents.push(event);
      }

      expect(captured).toHaveLength(2);
      expectSignatureReplayRequest(captured[0]!.messages, true);
      expectSignatureReplayRequest(captured[1]!.messages, false);
      expect(statusEvents.map((event) => event.type)).toEqual([
        "model_request_started",
        "model_request_failed",
        "model_retry_scheduled",
        "model_request_started",
        "model_request_completed",
      ]);
      expect(statusEvents.map((event) => event.attempt)).toEqual([1, 1, 1, 2, 2]);
      expect(statusEvents[1]).toMatchObject({
        maxAttempts: 2,
        retryable: true,
        statusCode: 400,
      });
      expect(statusEvents[2]).toMatchObject({
        delayMs: 0,
        maxAttempts: 2,
        nextAttempt: 2,
        reason: "reasoning_signature_repair",
        statusCode: 400,
      });
      expect(statusEvents[3]).toMatchObject({ attempt: 2, maxAttempts: 2 });
      expect(statusEvents[3]!.requestId).not.toBe(statusEvents[0]!.requestId);
      expect(streamEvents.some((event) => event.type === "text_delta")).toBe(true);
      expect(streamEvents.filter((event) => event.type === "finish")).toEqual([
        expect.objectContaining({ signedReasoningReset: true }),
      ]);

      const [fileName] = await readdir(debugDir);
      const records = (await readFile(join(debugDir, fileName!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as any);
      expect(records).toHaveLength(1);
      expect(records[0].request.messages.map((message: any) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(records[0].request.messages[1].content).toEqual([
        { type: "text", text: "(no content)" },
      ]);
      expect(records[0].request.messages[3].content).toEqual([
        { type: "reasoning", text: "unsigned" },
        { type: "text", text: "answer" },
      ]);
      expect(messages).toEqual(snapshot);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      failures: ["signature", "ordinary"] as const,
      name: "signature repair before an ordinary retry",
      retryReasons: ["reasoning_signature_repair", "server_error"],
      signedAttempts: [true, false, false],
    },
    {
      failures: ["ordinary", "signature"] as const,
      name: "an ordinary retry before signature repair",
      retryReasons: ["server_error", "reasoning_signature_repair"],
      signedAttempts: [true, true, false],
    },
  ])("keeps stream retry budgets independent for $name", async (testCase) => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const captured: AiSdkStreamTextOptions[] = [];
    const messages = signatureReplayMessages();
    const snapshot = structuredClone(messages);
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        captured.push(options);
        const failure = testCase.failures[captured.length - 1];
        if (failure) {
          const error =
            failure === "signature"
              ? apiError("thinking block cannot be modified", {
                  isRetryable: false,
                  statusCode: 400,
                })
              : apiError("provider temporarily unavailable", {
                  isRetryable: true,
                  responseHeaders: { "retry-after": "0" },
                  statusCode: 500,
                });
          return {
            fullStream: stream([{ type: "start" }, { type: "error", error }]),
          } as never;
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-delta", id: "text-1", text: "done" },
            { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streamEvents: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      messages,
      statusSink: { publish: (status) => statusEvents.push(status) },
    })) {
      streamEvents.push(event);
    }

    expect(streamEvents.some((event) => event.type === "text_delta")).toBe(true);
    expect(streamEvents.find((event) => event.type === "finish")).toMatchObject({
      signedReasoningReset: true,
    });
    expect(captured).toHaveLength(3);
    testCase.signedAttempts.forEach((includeSigned, index) =>
      expectSignatureReplayRequest(captured[index]!.messages, includeSigned),
    );
    const retryEvents = statusEvents.filter((event) => event.type === "model_retry_scheduled");
    expect(retryEvents.map((event) => event.reason)).toEqual(testCase.retryReasons);
    expect(retryEvents.map((event) => event.nextAttempt)).toEqual([2, 3]);
    const startedEvents = statusEvents.filter((event) => event.type === "model_request_started");
    expect(startedEvents.map((event) => event.attempt)).toEqual([1, 2, 3]);
    expect(new Set(startedEvents.map((event) => event.requestId)).size).toBe(3);
    expect(messages).toEqual(snapshot);
  });

  it("repairs the gateway form of a bound thinking signature and logs the provider evidence", async () => {
    const logs: CapturedLog[] = [];
    const captured: AiSdkGenerateTextOptions["messages"][] = [];
    const providerMessage =
      "ValidationException: messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        captured.push(structuredClone(options.messages) as never);
        if (captured.length === 1) {
          throw apiError(providerMessage, {
            isRetryable: false,
            responseHeaders: {
              "anthropic-thinking-prefix-mismatch": "block=messages.1.content.0;kind=prefix",
            },
            statusCode: 400,
          });
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-delta", id: "text-1", text: "done" },
            { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    for await (const _event of executeAdapterStreamText(adapter, {
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      messages: signatureReplayMessages(),
    })) {
      // drain stream
    }

    // 修复原因：网关原文里 `signature` 带反引号，原来的匹配认不出，剥离重试没有触发。
    expect(captured).toHaveLength(2);
    expectSignatureReplayRequest(captured[0]!, true);
    expectSignatureReplayRequest(captured[1]!, false);
    const repairLog = logs.find(
      (entry) => entry.context.event === "model.reasoning_signature_repair.retry",
    );
    expect(repairLog).toMatchObject({
      level: "warn",
      context: {
        providerMessage,
        thinkingPrefixMismatch: "block=messages.1.content.0;kind=prefix",
      },
    });
  });

  it("logs the provider evidence when a non-streaming request repairs a bound thinking signature", async () => {
    const logs: CapturedLog[] = [];
    const captured: AiSdkGenerateTextOptions["messages"][] = [];
    const providerMessage =
      "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        captured.push(structuredClone(options.messages) as never);
        if (captured.length === 1) {
          throw apiError(providerMessage, {
            isRetryable: false,
            responseHeaders: {
              "anthropic-thinking-prefix-mismatch": "block=messages.1.content.0;kind=prefix",
            },
            statusCode: 400,
          });
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      messages: signatureReplayMessages(),
    });

    expect(result.text).toBe("done");
    expect(captured).toHaveLength(2);
    expectSignatureReplayRequest(captured[1]!, false);
    expect(
      logs.find((entry) => entry.context.event === "model.reasoning_signature_repair.retry"),
    ).toMatchObject({
      level: "warn",
      context: {
        providerMessage,
        thinkingPrefixMismatch: "block=messages.1.content.0;kind=prefix",
      },
    });
  });

  it("publishes retry status when Anthropic rejects a thinking signature during stream setup", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          throw apiError("signature in thinking block is invalid", {
            isRetryable: false,
            statusCode: 400,
          });
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-delta", id: "text-1", text: "done" },
            { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    for await (const _event of executeAdapterStreamText(adapter, {
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      messages: signatureReplayMessages(),
      statusSink: { publish: (status) => statusEvents.push(status) },
    })) {
      // drain stream
    }

    expect(attempts).toBe(2);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(statusEvents[2]).toMatchObject({
      attempt: 1,
      delayMs: 0,
      maxAttempts: 2,
      nextAttempt: 2,
      reason: "reasoning_signature_repair",
      statusCode: 400,
    });
  });

  it("does not retry a thinking signature rejection after visible stream output", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-delta", id: "text-1", text: "partial" },
            {
              type: "error",
              error: apiError("thinking block cannot be modified", {
                isRetryable: false,
                statusCode: 400,
              }),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: providerRegistry("anthropic"),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const streamEvents: ModelStreamEvent[] = [];

    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "deepseek" as never,
        modelId: "model-a" as never,
        messages: signatureReplayMessages(),
      })) {
        streamEvents.push(event);
      }
    }).rejects.toMatchObject({ code: ModelErrorCode.InvalidModelRequest });

    expect(attempts).toBe(1);
    expect(streamEvents).toContainEqual({ type: "text_delta", id: "text-1", text: "partial" });
  });

  it("retries AI SDK parsed Anthropic overload stream errors", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const message = "Overloaded";
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: stream([
              {
                type: "error",
                error: { message, type: "overloaded_error" },
              },
            ]),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "overload-retry", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streamEvents: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_anthropic_overload",
        traceId: "trace_anthropic_overload",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      streamEvents.push(event);
    }

    expect(attempts).toBe(2);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      message,
      providerErrorCode: "overloaded_error",
      providerErrorMessage: message,
      reason: "provider_overloaded",
      retryable: true,
    });
    expect(streamEvents).toEqual([
      { type: "text_delta", id: "overload-retry", text: "ok" },
      expect.objectContaining({ finishReason: "stop", type: "finish" }),
    ]);
  });

  it("does not retry thrown stream network failures after visible reasoning deltas", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: streamThenFail(
            [
              { type: "start" },
              { type: "reasoning-start", id: "reasoning_failed" },
              { type: "reasoning-delta", id: "reasoning_failed", delta: "show me" },
            ],
            resetError,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streamEvents: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        metadata: {
          requestId: "model_req_stream_reasoning_no_retry",
          traceId: "trace_stream_reasoning_no_retry",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            statusEvents.push(event);
          },
        },
      })) {
        streamEvents.push(event);
      }
    }).rejects.toMatchObject({
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);

    expect(attempts).toBe(1);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      attempt: 1,
      reason: "network_error",
      retryable: false,
    });
    expect(streamEvents).toEqual([
      { type: "start" },
      { type: "reasoning_start", id: "reasoning_failed", providerMetadata: undefined },
      {
        type: "reasoning_delta",
        id: "reasoning_failed",
        text: "show me",
        providerMetadata: undefined,
      },
    ]);
  });

  it("retries stream failures after parseable tool input without input end", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: streamThenFail(
              [
                { type: "start" },
                { type: "tool-input-start", id: "call_failed", toolName: "Read" },
                {
                  type: "tool-input-delta",
                  id: "call_failed",
                  delta: '{"file_path":"package.json"}',
                },
              ],
              resetError,
            ),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "start" },
            { type: "tool-input-start", id: "call_1", toolName: "Read" },
            { type: "tool-input-delta", id: "call_1", delta: '{"file_path":"package.json"}' },
            { type: "tool-input-end", id: "call_1" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "Read",
              input: { file_path: "package.json" },
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streamEvents: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_stream_tool_input_retry",
        traceId: "trace_stream_tool_input_retry",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read package metadata" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      streamEvents.push(event);
    }

    expect(attempts).toBe(2);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      attempt: 1,
      reason: "network_error",
      retryable: true,
    });
    expect(streamEvents).toEqual([
      { type: "start" },
      { type: "tool_input_start", id: "call_1", providerExecuted: undefined, toolName: "Read" },
      { type: "tool_input_delta", id: "call_1", delta: '{"file_path":"package.json"}' },
      { type: "tool_input_end", id: "call_1" },
      {
        type: "tool_call",
        toolCall: {
          id: "call_1",
          input: { file_path: "package.json" },
          name: "Read",
        },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    ]);
  });

  it("attributes a caller abort during stream retry delay to the connect phase", async () => {
    const abortController = new AbortController();
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const resetError = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return { fullStream: failingStream(resetError) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 60_000, jitter: false, maxAttempts: 2, maxDelayMs: 60_000 },
      runtime,
    });

    const result = (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        abortSignal: abortController.signal,
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            statusEvents.push(event);
          },
        },
      })) {
        // no-op
      }
    })();

    await vi.waitFor(() => {
      expect(statusEvents.some((event) => event.type === "model_retry_scheduled")).toBe(true);
    });
    abortController.abort(new Error("user stopped during retry delay"));

    await expect(result).rejects.toMatchObject({
      context: {
        errorPhase: "connect",
        exceptionKind: "generic",
        reason: ModelFailureReason.Cancelled,
      },
    });
  });

  it("attributes a caller abort during SSE error-chunk retry delay to the connect phase", async () => {
    const abortController = new AbortController();
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            {
              type: "error",
              error: apiError("rate limited", {
                isRetryable: true,
                statusCode: 429,
              }),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 60_000, jitter: false, maxAttempts: 2, maxDelayMs: 60_000 },
      runtime,
    });

    const result = (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        abortSignal: abortController.signal,
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            statusEvents.push(event);
          },
        },
      })) {
        // no-op
      }
    })();

    await vi.waitFor(() => {
      expect(statusEvents.some((event) => event.type === "model_retry_scheduled")).toBe(true);
    });
    abortController.abort(new Error("user stopped during error-chunk retry delay"));

    await expect(result).rejects.toMatchObject({
      context: {
        errorPhase: "connect",
        exceptionKind: "generic",
        reason: ModelFailureReason.Cancelled,
      },
    });
  });

  it("does not retry thrown stream network failures after text deltas", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: streamThenFail(
            [{ type: "start" }, { type: "text-delta", id: "visible-text", text: "partial" }],
            resetError,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streamEvents: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        metadata: {
          requestId: "model_req_stream_text_no_retry",
          traceId: "trace_stream_text_no_retry",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: {
          publish(event) {
            statusEvents.push(event);
          },
        },
      })) {
        streamEvents.push(event);
      }
    }).rejects.toMatchObject({
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);

    expect(attempts).toBe(1);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      attempt: 1,
      reason: "network_error",
      retryable: false,
    });
    expect(streamEvents).toEqual([
      { type: "start" },
      { type: "text_delta", id: "visible-text", text: "partial" },
    ]);
  });

  it("wraps terminal stream error chunks after retry budget is exhausted", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            {
              type: "error",
              error: apiError("rate limited", {
                isRetryable: true,
                statusCode: 429,
              }),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    await expect(
      (async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            requestId: "model_req_stream_terminal",
            traceId: "trace_stream_terminal",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
          statusSink: {
            publish(event) {
              statusEvents.push(event);
            },
          },
        })) {
          // Terminal stream chunks should throw before yielding a user-visible error event.
        }
      })(),
    ).rejects.toMatchObject({
      code: ModelErrorCode.ModelRateLimited,
      context: {
        errorPhase: "stream",
        exceptionKind: "generic",
      },
      message: "Provider rate limited the model request.",
      name: "AiSdkModelAdapterError",
    } satisfies Partial<AiSdkModelAdapterError>);

    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it("treats provider_success_false finish chunks as provider business failures", async () => {
    const logs: CapturedLog[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            {
              type: "finish",
              finishReason: "other",
              rawFinishReason: "provider_success_false",
              totalUsage: usage(0, 0),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: registry(),
      runtime,
    });

    await expect(
      (async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            requestId: "model_req_empty",
            traceId: "trace_empty",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
        })) {
          // consume
        }
      })(),
    ).rejects.toMatchObject({
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider returned a business error.",
      name: "AiSdkModelAdapterError",
    });

    const suspicious = logs.find(
      (entry) => entry.context?.event === "model.sdk.stream.suspicious_empty",
    );
    expect(suspicious).toBeUndefined();
  });

  it("maps tool input stream chunks into protocol stream events", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "start" },
            { type: "tool-input-start", id: "call_1", toolName: "Read" },
            { type: "tool-input-delta", id: "call_1", delta: '{"file_path":' },
            { type: "tool-input-delta", id: "call_1", delta: '"README.md"}' },
            { type: "tool-input-end", id: "call_1" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "Read",
              input: { file_path: "README.md" },
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const events = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "start" },
      { type: "tool_input_start", id: "call_1", providerExecuted: undefined, toolName: "Read" },
      { type: "tool_input_delta", id: "call_1", delta: '{"file_path":' },
      { type: "tool_input_delta", id: "call_1", delta: '"README.md"}' },
      { type: "tool_input_end", id: "call_1" },
      {
        type: "tool_call",
        toolCall: {
          id: "call_1",
          input: { file_path: "README.md" },
          name: "Read",
        },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    ]);
  });

  it("waits for tool input end after streamed input becomes parseable", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "start" },
            { type: "tool-input-start", id: "call_early", toolName: "Read" },
            {
              type: "tool-input-delta",
              id: "call_early",
              delta: '{"file_path":"README.md"}',
            },
            { type: "text-delta", id: "after-tool", text: "after" },
            { type: "tool-input-end", id: "call_early" },
            {
              type: "tool-call",
              toolCallId: "call_early",
              toolName: "Read",
              input: { file_path: "README.md" },
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
      "text_delta",
      "tool_input_end",
      "tool_call",
      "finish",
    ]);
    expect(events.findIndex((event) => event.type === "tool_call")).toBeGreaterThan(
      events.findIndex((event) => event.type === "tool_input_end"),
    );
    expect(events).toContainEqual({ type: "text_delta", id: "after-tool", text: "after" });
  });

  it("waits for provider tool input end before emitting a compact tool call", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_compact", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_compact",
          delta: '{"file_path":"README.md"}',
        },
        { type: "text-delta", id: "before-input-end", text: "after-json" },
        { type: "tool-input-end", id: "call_compact" },
        {
          type: "tool-call",
          toolCallId: "call_compact",
          toolName: "Read",
          input: { file_path: "README.md" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: undefined,
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
      "text_delta",
      "tool_input_end",
      "tool_call",
      "finish",
    ]);
    expect(events.findIndex((event) => event.type === "tool_call")).toBeGreaterThan(
      events.findIndex((event) => event.type === "tool_input_end"),
    );
  });

  it.each([
    {
      expectedProviderExecuted: true,
      finalProviderExecuted: undefined,
      name: "falls back to provider execution metadata from input start",
    },
    {
      expectedProviderExecuted: false,
      finalProviderExecuted: false,
      name: "keeps an explicit final provider execution value",
    },
  ])("$name", async ({ expectedProviderExecuted, finalProviderExecuted }) => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        {
          type: "tool-input-start",
          id: "call_provider_executed",
          toolName: "Read",
          providerExecuted: true,
        },
        { type: "tool-input-end", id: "call_provider_executed" },
        {
          type: "tool-call",
          toolCallId: "call_provider_executed",
          toolName: "Read",
          input: { file_path: "README.md" },
          providerExecuted: finalProviderExecuted,
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "tool_call")).toEqual({
      type: "tool_call",
      toolCall: {
        id: "call_provider_executed",
        input: { file_path: "README.md" },
        name: "Read",
        providerExecuted: expectedProviderExecuted,
      },
    });
  });

  it("preserves an empty tool name from streaming input start through final tool call", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        {
          type: "tool-input-start",
          id: "call_stream_empty_name",
          toolName: "",
        },
        { type: "tool-input-end", id: "call_stream_empty_name" },
        {
          type: "tool-call",
          toolCallId: "call_stream_empty_name",
          toolName: "",
          input: {},
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Use a tool" }],
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "tool_input_start")).toEqual({
      type: "tool_input_start",
      id: "call_stream_empty_name",
      providerExecuted: undefined,
      toolName: "",
    });
    expect(events.find((event) => event.type === "tool_call")).toEqual({
      type: "tool_call",
      toolCall: {
        id: "call_stream_empty_name",
        input: {},
        name: "",
        providerExecuted: undefined,
      },
    });
  });

  it("rejects an empty final name when provider execution is only marked at input start", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        {
          type: "tool-input-start",
          id: "call_provider_empty_final",
          toolName: "Read",
          providerExecuted: true,
        },
        { type: "tool-input-end", id: "call_provider_empty_final" },
        {
          type: "tool-call",
          toolCallId: "call_provider_empty_final",
          toolName: "",
          input: {},
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    await expect(async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Read README" }],
      })) {
        // drain
      }
    }).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelResponse,
      message: "Model returned an invalid tool call: tool name is empty.",
    });
  });

  it("uses the complete final tool-call input instead of a parseable streamed prefix", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_initial_input", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_initial_input",
          delta: '{"offset":1}',
        },
        { type: "tool-input-end", id: "call_initial_input" },
        {
          type: "tool-call",
          toolCallId: "call_initial_input",
          toolName: "Read",
          input: { file_path: "README.md", offset: 1 },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        toolCall: {
          id: "call_initial_input",
          input: { file_path: "README.md", offset: 1 },
          name: "Read",
          providerExecuted: undefined,
        },
      },
    ]);
  });

  it("recovers malformed streamed input from tool-call after tool input end", async () => {
    const malformedInput = '{"questions":[{"question":"bad "quote"'.padEnd(884, "x");
    const logs: CapturedLog[] = [];
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        {
          type: "tool-input-start",
          id: "call_malformed_ask",
          toolName: "AskUserQuestion",
        },
        {
          type: "tool-input-delta",
          id: "call_malformed_ask",
          delta: malformedInput,
        },
        { type: "tool-input-end", id: "call_malformed_ask" },
        {
          type: "tool-call",
          toolCallId: "call_malformed_ask",
          toolName: "AskUserQuestion",
          input: malformedInput,
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: registry(),
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ask a question" }],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
      "tool_input_end",
      "tool_call",
      "finish",
    ]);
    const committedCall = events.find((event) => event.type === "tool_call");
    expect(committedCall).toEqual({
      type: "tool_call",
      toolCall: {
        id: "call_malformed_ask",
        input: {},
        name: "AskUserQuestion",
      },
    });
    expect(JSON.stringify(committedCall)).not.toContain(malformedInput);
    expect(
      logs.filter((entry) => entry.message === "Model tool input JSON normalization failed"),
    ).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          inputLength: 884,
          parseErrorType: "SyntaxError",
          recovery: "empty_object",
          source: "streamText",
          status: "failed",
          toolName: "AskUserQuestion",
        }),
        level: "warn",
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(malformedInput);
  });

  it("degrades upstream-normalized null without a fake input length", async () => {
    const logs: CapturedLog[] = [];
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_native_null", toolName: "Read" },
        { type: "tool-input-end", id: "call_native_null" },
        {
          type: "tool-call",
          toolCallId: "call_native_null",
          toolName: "Read",
          input: null,
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      registry: registry(),
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === "tool_call")).toEqual({
      type: "tool_call",
      toolCall: {
        id: "call_native_null",
        input: {},
        name: "Read",
        providerExecuted: undefined,
      },
    });
    const normalizationLog = logs.find(
      (entry) => entry.message === "Model tool input JSON normalization failed",
    );
    expect(normalizationLog?.context).toEqual(
      expect.objectContaining({
        inputType: "null",
        parseErrorType: "TypeError",
        recovery: "empty_object",
        toolName: "Read",
      }),
    );
    expect(normalizationLog?.context).not.toHaveProperty("inputLength");
  });

  it.each([
    {
      aggregateInput: '{"questions":[{"question":"bad "quote"}]}',
      delta: '{"questions":[{"question":"bad "quote"}]}',
      expectedLog: { inputLength: 41 },
      name: "malformed string",
      rawInput: '{"questions":[{"question":"bad "quote"}]}',
      slug: "malformed",
    },
    {
      aggregateInput: null,
      delta: "null",
      expectedLog: { inputType: "null" },
      name: "upstream-normalized null",
      rawInput: null,
      slug: "null",
    },
  ])(
    "reuses normalized final $name in stream model-io without warning twice",
    async ({ aggregateInput, delta, expectedLog, rawInput, slug }) => {
      const debugDir = await mkdtemp(join(tmpdir(), `zcode-model-io-${slug}-tool-`));
      const logs: CapturedLog[] = [];
      const toolCallId = `call_model_io_${slug}`;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText(options) {
          return {
            fullStream: stream([
              {
                type: "tool-input-start",
                id: toolCallId,
                toolName: "AnyTool",
              },
              {
                type: "tool-input-delta",
                id: toolCallId,
                delta,
              },
              { type: "tool-input-end", id: toolCallId },
              {
                type: "tool-call",
                toolCallId,
                toolName: "AnyTool",
                input: rawInput,
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                totalUsage: usage(2, 1),
              },
            ]),
            text: Promise.resolve(""),
            finishReason: Promise.resolve("tool-calls"),
            totalUsage: Promise.resolve(usage(2, 1)),
            usage: Promise.resolve(usage(2, 1)),
            // 上游 aggregate 保留无效的原始 input；model-io 必须复用 final call 的归一化结果。
            toolCalls: Promise.resolve([
              {
                type: "tool-call",
                toolCallId,
                toolName: "AnyTool",
                input: aggregateInput,
                dynamic: true,
                invalid: true,
              },
            ]),
            toolResults: Promise.resolve([
              {
                dynamic: true,
                error: "Invalid tool input",
                input: rawInput,
                toolCallId,
                toolName: "AnyTool",
                type: "tool-error",
              },
            ]),
            sources: Promise.resolve([]),
            providerMetadata: Promise.resolve(undefined),
            request: Promise.resolve({ body: { messages: options.messages } }),
            response: Promise.resolve({
              id: `response_model_io_${slug}`,
              headers: {},
              modelId: "model-a",
            }),
          } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        debugDir,
        env: { ZCODE_RUNTIME_ENV: "development" },
        logger: capturingLogger(logs),
        registry: registry(),
        runtime,
      });

      try {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: { sessionId: `sess_model_io_${slug}` },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Call any tool" }],
        })) {
          // drain stream so model-io aggregate settles
        }

        const normalizationLogs = logs.filter(
          (entry) => entry.message === "Model tool input JSON normalization failed",
        );
        expect(normalizationLogs).toHaveLength(1);
        expect(normalizationLogs[0]?.context).toEqual(expect.objectContaining(expectedLog));
        const [fileName] = await readdir(debugDir);
        const content = await readFile(join(debugDir, fileName!), "utf8");
        const record = JSON.parse(content.trim()) as {
          response?: { toolCalls?: unknown[]; toolResults?: unknown[] };
        };
        expect(record.response?.toolCalls).toEqual([
          {
            id: toolCallId,
            input: {},
            name: "AnyTool",
          },
        ]);
        expect(record.response?.toolResults).toEqual([
          expect.objectContaining({ id: toolCallId, input: {}, name: "AnyTool" }),
        ]);
        if (typeof rawInput === "string") {
          expect(content).not.toContain(rawInput);
        } else {
          expect(content).not.toMatch(/"input"\s*:\s*null/);
        }
      } finally {
        await rm(debugDir, { recursive: true, force: true });
      }
    },
  );

  it("materializes parallel tool calls independently as each final call arrives", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_a", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_a",
          delta: '{"file_path":"a.md"}',
        },
        { type: "tool-input-start", id: "call_b", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_b",
          delta: '{"file_path":"b.md"}',
        },
        { type: "tool-input-end", id: "call_a" },
        {
          type: "tool-call",
          toolCallId: "call_a",
          toolName: "Read",
          input: { file_path: "a.md" },
        },
        { type: "tool-input-end", id: "call_b" },
        {
          type: "tool-call",
          toolCallId: "call_b",
          toolName: "Read",
          input: { file_path: "b.md" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: undefined,
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read both files" }],
    })) {
      events.push(event);
    }

    const committedIds = events.flatMap((event) =>
      event.type === "tool_call" ? [event.toolCall.id] : [],
    );
    expect(committedIds).toEqual(["call_a", "call_b"]);
    expect(events.findIndex((event) => event.type === "tool_call")).toBeLessThan(
      events.findIndex((event) => event.type === "tool_input_end" && event.id === "call_b"),
    );
  });

  it.each([
    {
      chunks: [{ type: "start" }, { type: "text-start", id: "in-flight-text" }],
      expectedEventTypes: ["start", "text_start"],
      name: "text start",
    },
    {
      chunks: [{ type: "start" }, { type: "reasoning-start", id: "in-flight-reasoning" }],
      expectedEventTypes: ["start", "reasoning_start"],
      name: "reasoning start",
    },
    {
      chunks: [
        { type: "start" },
        { type: "tool-input-start", id: "in-flight-tool", toolName: "Read" },
        { type: "tool-input-delta", id: "in-flight-tool", delta: "{" },
      ],
      expectedEventTypes: ["start", "tool_input_start", "tool_input_delta"],
      name: "tool input delta",
    },
  ])(
    "stops compact SSE retry after the first provider $name event",
    async ({ chunks, expectedEventTypes }) => {
      const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          return { fullStream: streamThenFail(chunks, resetError) } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        registry: registry(),
        retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        runtime,
      });

      const events: ModelStreamEvent[] = [];
      await expect(async () => {
        for await (const event of executeAdapterStreamText(adapter, {
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Summarize without tools" }],
          preserveProviderStreamBoundaries: true,
        })) {
          events.push(event);
        }
      }).rejects.toThrow(AiSdkModelAdapterError);

      expect(attempts).toBe(1);
      expect(events.map((event) => event.type)).toEqual(expectedEventTypes);
    },
  );

  it.each(["ECONNRESET", "EPIPE", "ConnectionClosed"])(
    "keeps compact SSE retry for stale %s before the first provider event",
    async (code) => {
      const resetError = Object.assign(new Error("aborted"), { code });
      const attemptSignals: Array<AbortSignal | undefined> = [];
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText(options) {
          attempts += 1;
          attemptSignals.push(options.abortSignal);
          if (attempts === 1) {
            return { fullStream: streamThenFail([{ type: "start" }], resetError) } as never;
          }
          return {
            fullStream: stream([
              { type: "start" },
              { type: "text-start", id: "retry-text" },
              { type: "text-delta", id: "retry-text", text: "ok" },
              { type: "text-end", id: "retry-text" },
              {
                type: "finish",
                finishReason: "stop",
                rawFinishReason: undefined,
                totalUsage: usage(2, 1),
              },
            ]),
          } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        registry: registry(),
        retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        runtime,
      });

      const events: ModelStreamEvent[] = [];
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        events.push(event);
      }

      expect(attempts).toBe(2);
      expect(attemptSignals[0]?.aborted).toBe(true);
      expect(attemptSignals[1]?.aborted).toBe(false);
      expect(events.map((event) => event.type)).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "finish",
      ]);
    },
  );

  it("does not retry a stale compact error after caller cancellation", async () => {
    const abortController = new AbortController();
    const statusEvents: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        abortController.abort(new Error("stop compact"));
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    await expect(async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        abortSignal: abortController.signal,
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
        statusSink: {
          publish(event) {
            statusEvents.push(event);
          },
        },
      })) {
        // no-op
      }
    }).rejects.toThrow();

    expect(attempts).toBe(1);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents.at(-1)).toMatchObject({ reason: "cancelled", retryable: false });
  });

  it("marks synchronous compact stream creation errors as request setup failures", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        throw new AiSdkModelAdapterError(
          ModelErrorCode.ModelRequestFailed,
          "stream runtime setup failed",
        );
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(attempts).toBe(1);
    expect(terminalError).toBeInstanceOf(AiSdkModelAdapterError);
    expect(terminalError).toMatchObject({
      context: { streamFailurePhase: "request_setup" },
    });
  });

  it("keeps ordinary main-stream adapter error identity unchanged", async () => {
    const setupError = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRequestFailed,
      "main stream runtime setup failed",
    );
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        throw setupError;
      },
    };
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Keep main streaming unchanged" }],
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(terminalError).toBe(setupError);
    expect(setupError.context).toMatchObject({
      errorPhase: "prepare",
      exceptionKind: "protocol",
      providerKind: "openai-compatible",
      reason: ModelFailureReason.Unknown,
      source: "runtime",
      transport: "sse",
    });
  });

  it("preserves stream phase and a low-cardinality exception kind after iterator creation", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: streamThenFail([], new Error("opaque provider stream failure")),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Trigger opaque stream failure" }],
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(terminalError).toMatchObject({
      context: {
        errorPhase: "stream",
        exceptionKind: "generic",
        reason: ModelFailureReason.Unknown,
        source: "provider",
      },
    });
  });

  it("marks a compact non-2xx stream response as a request setup failure", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: failingStream(
            new APICallError({
              message: "HTTP 500",
              responseHeaders: { "content-type": "text/event-stream" },
              statusCode: 500,
            }),
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(attempts).toBe(2);
    expect(terminalError).toMatchObject({
      context: { statusCode: 500, streamFailurePhase: "request_setup" },
    });
  });

  it("keeps the real compact HTTP response status separate from a logical status", async () => {
    const runtime = createStreamRuntime(
      stream([
        {
          type: "error",
          error: new ProviderBusinessError({
            providerCode: "server_error",
            providerId: "test",
            providerKind: "custom",
            responseStatus: 404,
            statusCode: 500,
          }),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(terminalError).toMatchObject({
      context: {
        httpResponseStatus: 404,
        responseStatus: 404,
        statusCode: 500,
        streamFailurePhase: "request_setup",
      },
    });
  });

  it("unwraps a retry error before resolving the compact HTTP response status", async () => {
    const providerError = new ProviderBusinessError({
      providerCode: "server_error",
      providerId: "test",
      providerKind: "custom",
      responseStatus: 200,
      statusCode: 500,
    });
    const apiCallError = new APICallError({
      cause: providerError,
      message: "SSE business error",
      requestBodyValues: {},
      statusCode: 500,
      url: "https://example.invalid/v1/messages",
    });
    const retryError = new RetryError({
      errors: [apiCallError],
      message: "retry exhausted",
      reason: "maxRetriesExceeded",
    });
    const runtime = createStreamRuntime(failingStream(retryError));
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(terminalError).toMatchObject({
      context: {
        httpResponseStatus: 200,
        statusCode: 500,
        streamFailurePhase: "response_body",
      },
    });
  });

  it("reads compact HTTP status from finish response metadata", async () => {
    const runtime = createStreamRuntime(
      stream([
        {
          type: "finish",
          finishReason: "error",
          response: {
            body: { code: "server_error", message: "boom" },
            status: 500,
          },
          totalUsage: usage(0, 0),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(terminalError).toMatchObject({
      context: {
        httpResponseStatus: 500,
        statusCode: 500,
        streamFailurePhase: "request_setup",
      },
    });
  });

  it.each([500, 1234])(
    "hands compact SSE body business error %s to Core without SSE retry",
    async (providerCode) => {
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          return {
            fullStream: stream([
              {
                type: "error",
                error: new ProviderBusinessError({
                  providerCode,
                  providerId: "test",
                  providerKind: "custom",
                  responseHeaders: { "content-type": "text/event-stream" },
                  responseStatus: 200,
                  statusCode: providerCode === 500 ? 500 : undefined,
                }),
              },
            ]),
          } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        registry: registry(),
        retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        runtime,
      });

      const terminalError = await (async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Summarize without tools" }],
          preserveProviderStreamBoundaries: true,
        })) {
          // no-op
        }
      })().catch((error: unknown) => error);

      expect(attempts).toBe(1);
      expect(terminalError).toBeInstanceOf(AiSdkModelAdapterError);
      expect(terminalError).toMatchObject({
        context: { responseStatus: 200, streamFailurePhase: "response_body" },
      });
    },
  );

  it("does not treat a compact SSE body logical EPIPE as stale transport", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: stream([
            {
              type: "error",
              error: new ProviderBusinessError({
                providerCode: "EPIPE",
                providerId: "test",
                providerKind: "custom",
                responseStatus: 200,
                statusCode: 500,
              }),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const terminalError = await (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(attempts).toBe(1);
    expect(terminalError).toMatchObject({
      context: { httpResponseStatus: 200, streamFailurePhase: "response_body" },
    });
  });

  it("retries a provider-wrapped EPIPE without an HTTP response status", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: stream([
              {
                type: "error",
                error: new ProviderBusinessError({
                  providerCode: "EPIPE",
                  providerId: "test",
                  providerKind: "custom",
                }),
              },
            ]),
          } as never;
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-start", id: "retry-text" },
            { type: "text-delta", id: "retry-text", text: "ok" },
            { type: "text-end", id: "retry-text" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "finish",
    ]);
  });

  it("stops compact SSE retry after a raw provider message_start", async () => {
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const includeRawChunks: Array<boolean | undefined> = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attempts += 1;
        includeRawChunks.push(options.includeRawChunks);
        return {
          fullStream: streamThenFail(
            [
              { type: "start" },
              { type: "start-step" },
              { type: "raw", rawValue: { type: "message_start" } },
            ],
            resetError,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        events.push(event);
      }
    }).rejects.toThrow(AiSdkModelAdapterError);

    expect(attempts).toBe(1);
    expect(includeRawChunks).toEqual([true]);
    expect(events).toEqual([
      { type: "start" },
      { boundary: "provider_response_start", type: "compact_stream_boundary" },
    ]);
  });

  it("aborts the compact physical stream when its consumer closes early", async () => {
    const attemptSignals: Array<AbortSignal | undefined> = [];
    const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attemptSignals.push(options.abortSignal);
        return {
          fullStream: streamWithReturn(
            [{ type: "start" }, { type: "raw", rawValue: { type: "message_start" } }],
            returnIterator,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
      statusSink: {
        publish(statusEvent) {
          statusEvents.push(statusEvent);
        },
      },
    })) {
      if (
        event.type === "compact_stream_boundary" &&
        event.boundary === "provider_response_start"
      ) {
        break;
      }
    }

    expect(attemptSignals).toHaveLength(1);
    expect(attemptSignals[0]?.aborted).toBe(true);
    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents.at(-1)).toMatchObject({
      reason: "cancelled",
      retryable: false,
      type: "model_request_failed",
    });
  });

  it("keeps ordinary main consumer close lifecycle unchanged", async () => {
    const attemptSignals: Array<AbortSignal | undefined> = [];
    const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attemptSignals.push(options.abortSignal);
        return {
          fullStream: streamWithReturn(
            [
              { type: "start" },
              { type: "text-start", id: "main-text" },
              { type: "text-delta", id: "main-text", text: "partial" },
            ],
            returnIterator,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    for await (const _event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Keep main lifecycle unchanged" }],
      statusSink: {
        publish(statusEvent) {
          statusEvents.push(statusEvent);
        },
      },
    })) {
      break;
    }

    expect(attemptSignals).toHaveLength(1);
    expect(attemptSignals[0]?.aborted).toBe(false);
    expect(returnIterator).not.toHaveBeenCalled();
    expect(statusEvents.map((event) => event.type)).toEqual(["model_request_started"]);
  });

  it("projects compact provider response, block-stop, and stop-reason provenance", async () => {
    const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
    const runtime = createStreamRuntime(
      streamWithReturn(
        [
          { type: "start" },
          { type: "raw", rawValue: { type: "message_start" } },
          {
            type: "raw",
            rawValue: { content_block: { type: "text" }, index: 0, type: "content_block_start" },
          },
          {
            type: "raw",
            rawValue: {
              delta: { text: "summary", type: "text_delta" },
              index: 0,
              type: "content_block_delta",
            },
          },
          { type: "raw", rawValue: { index: 0, type: "content_block_stop" } },
          {
            type: "raw",
            rawValue: { delta: { stop_reason: "end_turn" }, type: "message_delta" },
          },
          {
            type: "raw",
            rawValue: { delta: { stop_reason: null }, type: "message_delta" },
          },
          {
            type: "finish",
            finishReason: "other",
            rawFinishReason: undefined,
            totalUsage: usage(2, 0),
          },
        ],
        returnIterator,
      ),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "start" },
      { boundary: "provider_response_start", type: "compact_stream_boundary" },
      {
        blockType: "text",
        boundary: "provider_content_block_start",
        index: 0,
        type: "compact_stream_boundary",
      },
      {
        boundary: "provider_content_block_delta",
        deltaType: "text_delta",
        index: 0,
        type: "compact_stream_boundary",
      },
      { boundary: "provider_content_block_stop", index: 0, type: "compact_stream_boundary" },
      { boundary: "provider_stop_reason", present: true, type: "compact_stream_boundary" },
      { boundary: "provider_stop_reason", present: false, type: "compact_stream_boundary" },
      {
        type: "finish",
        finishReason: "other",
        usage: {
          inputTokens: 2,
          outputTokens: 0,
          totalTokens: 2,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    ]);
    expect(returnIterator).not.toHaveBeenCalled();
  });

  it("keeps compact SSE retry when the raw provider event is only ping", async () => {
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const includeRawChunks: Array<boolean | undefined> = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attempts += 1;
        includeRawChunks.push(options.includeRawChunks);
        if (attempts === 1) {
          return {
            fullStream: streamThenFail(
              [
                { type: "start" },
                { type: "start-step" },
                { type: "raw", rawValue: { type: "ping" } },
              ],
              resetError,
            ),
          } as never;
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-start", id: "retry-text" },
            { type: "text-delta", id: "retry-text", text: "ok" },
            { type: "text-end", id: "retry-text" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(attempts).toBe(2);
    expect(includeRawChunks).toEqual([true, true]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "finish",
    ]);
  });

  it.each([
    {
      chunks: [
        { type: "start" },
        { type: "text-start", id: "empty-text" },
        { type: "text-end", id: "empty-text" },
      ],
      expectedEventTypes: ["start", "text_start", "text_end"],
      name: "text",
    },
    {
      chunks: [
        { type: "start" },
        { type: "reasoning-start", id: "empty-reasoning" },
        { type: "reasoning-end", id: "empty-reasoning" },
      ],
      expectedEventTypes: ["start", "reasoning_start", "reasoning_end"],
      name: "reasoning",
    },
  ])(
    "ends compact SSE retry after a completed empty $name block",
    async ({ chunks, expectedEventTypes }) => {
      const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          return { fullStream: streamThenFail(chunks, resetError) } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        registry: registry(),
        retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        runtime,
      });

      const events: ModelStreamEvent[] = [];
      await expect(async () => {
        for await (const event of executeAdapterStreamText(adapter, {
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Summarize without tools" }],
          preserveProviderStreamBoundaries: true,
        })) {
          events.push(event);
        }
      }).rejects.toThrow(AiSdkModelAdapterError);

      expect(attempts).toBe(1);
      expect(events.map((event) => event.type)).toEqual(expectedEventTypes);
    },
  );

  it("keeps the existing main-stream retry behavior for an empty text block", async () => {
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const includeRawChunks: Array<boolean | undefined> = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attempts += 1;
        includeRawChunks.push(options.includeRawChunks);
        if (attempts === 1) {
          return {
            fullStream: streamThenFail(
              [
                { type: "start" },
                { type: "text-start", id: "discarded-empty-text" },
                { type: "text-end", id: "discarded-empty-text" },
              ],
              resetError,
            ),
          } as never;
        }
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-start", id: "retry-text" },
            { type: "text-delta", id: "retry-text", text: "ok" },
            { type: "text-end", id: "retry-text" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Keep the main request unchanged" }],
    })) {
      events.push(event);
    }

    expect(attempts).toBe(2);
    expect(includeRawChunks).toEqual([undefined, undefined]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "finish",
    ]);
  });

  it("does not emit a compact tool call when the stream fails after complete JSON but before input end", async () => {
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const runtime = createStreamRuntime(
      streamThenFail(
        [
          { type: "start" },
          { type: "tool-input-start", id: "call_interrupted", toolName: "Read" },
          {
            type: "tool-input-delta",
            id: "call_interrupted",
            delta: '{"file_path":"README.md"}',
          },
        ],
        resetError,
      ),
    );
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        events.push(event);
      }
    }).rejects.toThrow(AiSdkModelAdapterError);

    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("does not synthesize a compact tool call when the stream reaches EOF before input end", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_eof", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_eof",
          delta: '{"file_path":"README.md"}',
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
    ]);
  });

  it("does not synthesize a compact tool call when finish arrives before input end", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_finish", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_finish",
          delta: '{"file_path":"README.md"}',
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
      "finish",
    ]);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("commits malformed compact tool input from tool-call after the real input end", async () => {
    const resetError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const runtime = createStreamRuntime(
      streamThenFail(
        [
          { type: "start" },
          { type: "tool-input-start", id: "call_malformed_compact", toolName: "Read" },
          {
            type: "tool-input-delta",
            id: "call_malformed_compact",
            delta: "not-json",
          },
          { type: "tool-input-end", id: "call_malformed_compact" },
          {
            type: "tool-call",
            toolCallId: "call_malformed_compact",
            toolName: "Read",
            input: "not-json",
          },
        ],
        resetError,
      ),
    );
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        events.push(event);
      }
    }).rejects.toThrow(AiSdkModelAdapterError);

    expect(events).toContainEqual({
      type: "tool_call",
      toolCall: {
        id: "call_malformed_compact",
        input: {},
        name: "Read",
      },
    });
  });

  it("preserves a compact direct empty tool name with a closable id", async () => {
    let attempts = 0;
    const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: streamWithReturn(
            [
              { type: "start" },
              {
                type: "tool-call",
                toolCallId: "call_direct_empty_name",
                toolName: "",
                input: {},
              },
            ],
            returnIterator,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(attempts).toBe(1);
    expect(returnIterator).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "start" },
      {
        type: "tool_call",
        toolCall: {
          id: "call_direct_empty_name",
          input: {},
          name: "",
          providerExecuted: undefined,
        },
      },
    ]);
  });

  it("keeps rejecting a compact empty tool name without a closable id", async () => {
    let attempts = 0;
    const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: streamWithReturn(
            [
              { type: "start" },
              {
                type: "tool-call",
                toolCallId: "",
                toolName: "",
                input: {},
              },
            ],
            returnIterator,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Summarize without tools" }],
        preserveProviderStreamBoundaries: true,
      })) {
        events.push(event);
      }
    }).rejects.toThrow(AiSdkModelAdapterError);

    expect(attempts).toBe(1);
    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "start" },
      { boundary: "inferred_content_block_stop", type: "compact_stream_boundary" },
    ]);
  });

  it("recovers malformed compact direct tool input as an empty object", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        {
          type: "tool-call",
          toolCallId: "call_direct_bad_input",
          toolName: "Read",
          input: "not-json",
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Summarize without tools" }],
      preserveProviderStreamBoundaries: true,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "start" },
      {
        type: "tool_call",
        toolCall: {
          id: "call_direct_bad_input",
          input: {},
          name: "Read",
          providerExecuted: undefined,
        },
      },
    ]);
  });

  it("does not commit parseable streamed tool input when finish arrives before input end", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "start" },
            { type: "tool-input-start", id: "call_uncommitted", toolName: "Read" },
            {
              type: "tool-input-delta",
              id: "call_uncommitted",
              delta: '{"file_path":"README.md"}',
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              rawFinishReason: undefined,
              totalUsage: usage(2, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      runtime,
      registry: registry(),
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
      "finish",
    ]);
    expect(events.some((event) => event.type === "tool_input_end")).toBe(false);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("does not commit parseable streamed tool input when the stream ends before input end", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_eof_uncommitted", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_eof_uncommitted",
          delta: '{"file_path":"README.md"}',
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
    ]);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("does not let a tool call replace a missing input end for streamed input", async () => {
    const runtime = createStreamRuntime(
      stream([
        { type: "start" },
        { type: "tool-input-start", id: "call_without_end", toolName: "Read" },
        {
          type: "tool-input-delta",
          id: "call_without_end",
          delta: '{"file_path":"README.md"}',
        },
        {
          type: "tool-call",
          toolCallId: "call_without_end",
          toolName: "Read",
          input: { file_path: "README.md" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: undefined,
          totalUsage: usage(2, 1),
        },
      ]),
    );
    const adapter = new AiSdkModelAdapter({ runtime, registry: registry() });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read README" }],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_input_start",
      "tool_input_delta",
      "finish",
    ]);
    expect(events.some((event) => event.type === "tool_input_end")).toBe(false);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("aborts and retries SSE streams that exceed the event idle timeout", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const abortSignals: AbortSignal[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attempts += 1;
        if (options.abortSignal) {
          abortSignals.push(options.abortSignal);
        }
        if (attempts === 1) {
          return {
            fullStream: streamThatStallsUntilAbort(options.abortSignal),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
      streamIdleTimeoutMs: 5,
    });

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_sse_idle",
        traceId: "trace_sse_idle",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      streamed.push(event);
    }

    expect(attempts).toBe(2);
    expect(abortSignals[0]?.aborted).toBe(true);
    expect(streamed).toEqual([
      { id: "1", text: "ok", type: "text_delta" },
      expect.objectContaining({ finishReason: "stop", type: "finish" }),
    ]);
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_stream_stalled",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      message: "Model stream stalled: no event received for 5ms.",
      timeoutMs: 5,
      type: "model_stream_stalled",
    });
    expect(statusEvents[2]).toMatchObject({
      reason: "stream_idle_timeout",
      retryable: true,
      type: "model_request_failed",
    });
    expect(statusEvents[3]).toMatchObject({
      reason: "stream_idle_timeout",
      type: "model_retry_scheduled",
    });
  });

  it("uses request retry number when calculating SSE idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const statusEvents: ModelNetworkStatusEvent[] = [];
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText(options) {
          return {
            fullStream: streamThatStallsUntilAbort(options.abortSignal),
          } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        registry: registry(),
        retry: { baseDelayMs: 0, jitter: false, maxAttempts: 1, maxDelayMs: 0 },
        runtime,
        streamIdleTimeoutMs: 5,
      });

      const resultPromise = (async () => {
        for await (const _event of executeAdapterStreamText(adapter, {
          metadata: {
            requestId: "model_req_recovery_timeout",
            traceId: "trace_recovery_timeout",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
          statusSink: {
            publish(event) {
              statusEvents.push(event);
            },
          },
          streamIdleTimeoutRetryNumber: 2,
        })) {
          // drain stream
        }
      })().then(
        () => undefined,
        (error: unknown) => error,
      );

      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(60_005);

      expect(await resultPromise).toBeInstanceOf(AiSdkModelAdapterError);
      expect(statusEvents.find((event) => event.type === "model_stream_stalled")).toMatchObject({
        message: "Model stream stalled: no event received for 60005ms.",
        timeoutMs: 60_005,
        type: "model_stream_stalled",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops generateText immediately when the caller aborts even if the provider promise stalls", async () => {
    const abortController = new AbortController();
    const statusEvents: ModelNetworkStatusEvent[] = [];
    let providerAbortSignal: AbortSignal | undefined;
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        providerAbortSignal = options.abortSignal;
        return await new Promise<never>(() => undefined);
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      runtime,
    });

    const result = executeAdapterGenerateText(adapter, {
      abortSignal: abortController.signal,
      metadata: {
        querySource: "target_completion_verification",
        requestId: "model_req_verifier_stop",
        traceId: "trace_verifier_stop",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Verify goal completion" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    });
    await vi.waitFor(() => expect(providerAbortSignal).toBe(abortController.signal));

    abortController.abort(new Error("user stopped goal verifier"));

    await expect(Promise.race([result, rejectAfterTestTimeout(50)])).rejects.toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
    });
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      reason: "cancelled",
      retryable: false,
      type: "model_request_failed",
    });
  });

  it("stops SSE reads immediately when the caller aborts even if the provider stream stalls", async () => {
    const abortController = new AbortController();
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: streamThatIgnoresAbort(),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      runtime,
      streamIdleTimeoutMs: 60_000,
    });
    const iterator = executeAdapterStreamText(adapter, {
      abortSignal: abortController.signal,
      metadata: {
        requestId: "model_req_user_stop",
        traceId: "trace_user_stop",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { id: "1", text: "partial", type: "text_delta" },
    });

    const next = iterator.next();
    abortController.abort(new Error("user stop"));

    await expect(Promise.race([next, rejectAfterTestTimeout(50)])).rejects.toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
    });
    expect(statusEvents.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(statusEvents[1]).toMatchObject({
      reason: "cancelled",
      type: "model_request_failed",
    });
  });

  it("keeps user stop responsive when model-io aggregate promises never settle after mid-stream abort", async () => {
    // 回归（v3.2.6/v3.3.0）：流出过 chunk 后 abort，AI SDK 的 request/response 聚合
    // promise 永不 settle；失败路径的 model-io 记录若无限 await 会把 catch 挂死，
    // turn 永不结束，session 后续 send 全部报 "A prompt is already running for this session"。
    const debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-abort-hang-"));
    const abortController = new AbortController();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: streamThatIgnoresAbort(),
          request: new Promise(() => undefined),
          response: new Promise(() => undefined),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      debugDir,
      env: { ZCODE_RUNTIME_ENV: "development" },
      registry: registry(),
      runtime,
      streamIdleTimeoutMs: 60_000,
    });

    try {
      const iterator = executeAdapterStreamText(adapter, {
        abortSignal: abortController.signal,
        metadata: {
          querySource: "main_turn",
          sessionId: "sess_abort_hang_debug",
          traceId: "trace_abort_hang_debug",
          turnId: "turn_abort_hang_debug",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { id: "1", text: "partial", type: "text_delta" },
      });

      const next = iterator.next();
      abortController.abort(new Error("user stop"));

      await expect(Promise.race([next, rejectAfterTestTimeout(500)])).rejects.toMatchObject({
        code: ModelErrorCode.ModelRequestCancelled,
      });

      // 失败记录仍需落盘（request body 走 fallback 快照），只是不允许拖住失败路径。
      const files = await readdir(debugDir);
      expect(files).toEqual(["model-io-sess_abort_hang_debug.jsonl"]);
      const content = await readFile(join(debugDir, files[0]!), "utf8");
      const record = JSON.parse(content.trim()) as {
        error: { message: string };
        request: { body?: { bodySource?: string } };
      };
      expect(record.error.message).toBe("user stop");
      expect(record.request.body).toMatchObject({ bodySource: "ai_sdk_options" });
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it("keeps SSE streams alive when each event arrives before the idle timeout", async () => {
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: delayedStream(
            [
              { type: "text-delta", id: "1", text: "o" },
              { type: "text-delta", id: "1", text: "k" },
              {
                type: "finish",
                finishReason: "stop",
                rawFinishReason: undefined,
                totalUsage: usage(1, 1),
              },
            ],
            75,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      runtime,
      streamIdleTimeoutMs: 200,
    });

    const startedAt = Date.now();
    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      streamed.push(event);
    }

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(statusEvents.some((event) => event.type === "model_stream_stalled")).toBe(false);
    expect(statusEvents.at(-1)).toMatchObject({ type: "model_request_completed" });
    expect(streamed).toEqual([
      { id: "1", text: "o", type: "text_delta" },
      { id: "1", text: "k", type: "text_delta" },
      expect.objectContaining({ finishReason: "stop", type: "finish" }),
    ]);
  });

  it("logs stream diagnostics when a network reset happens after finish", async () => {
    const logs: CapturedLog[] = [];
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const tailError = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: streamThenFail(
            [
              { type: "text-delta", id: "1", text: "ok" },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "Read",
                input: { file_path: "README.md" },
              },
              {
                type: "finish",
                finishReason: "tool-calls",
                rawFinishReason: "tool_use",
                totalUsage: usage(2, 1),
              },
            ],
            tailError,
          ),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      logger: capturingLogger(logs),
      runtime,
      registry: registry(),
    });

    const streamed: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Read README" }],
        statusSink: {
          publish(event) {
            statusEvents.push(event);
          },
        },
      })) {
        streamed.push(event);
      }
    }).rejects.toThrow(AiSdkModelAdapterError);

    expect(streamed.at(-1)).toMatchObject({
      finishReason: "tool-calls",
      type: "finish",
    });
    expect(statusEvents.at(-1)).toMatchObject({
      reason: "network_error",
      retryable: false,
      type: "model_request_failed",
    });

    const failureLog = logs.find((entry) => entry.context?.event === "model.sdk.stream.failed");
    expect(failureLog).toMatchObject({
      level: "error",
      context: {
        chunkCounts: {
          finish: 1,
          "text-delta": 1,
          "tool-call": 1,
        },
        emittedError: false,
        emittedEvent: true,
        emittedRetryBoundaryEvent: true,
        errorAfterFinish: true,
        finishReason: "tool-calls",
        lastChunkType: "finish",
        rawFinishReason: "tool_use",
        reason: "network_error",
        retryable: false,
        status: "failed",
        statusMessage: "Network connection failed for the provider request.",
        textDeltaChars: 2,
        toolCallCount: 1,
      },
    });
  });
});

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: LogContext;
}

function capturingLogger(entries: CapturedLog[], defaultContext: LogContext = {}): Logger {
  const push = (level: CapturedLog["level"], message: string, context?: LogContext) => {
    entries.push({
      context: context ? { ...defaultContext, ...context } : defaultContext,
      level,
      message,
    });
  };

  return {
    child(context) {
      return capturingLogger(entries, { ...defaultContext, ...context });
    },
    debug(message, context) {
      push("debug", message, context);
    },
    error(message, _error, context) {
      push("error", message, context);
    },
    info(message, context) {
      push("info", message, context);
    },
    warn(message, context) {
      push("warn", message, context);
    },
  };
}

function registry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        kind: "custom",
        createLanguageModel: (modelId) => ({ modelId }) as never,
      },
    },
  });
}

function modelIODebugRegistry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        kind: "custom",
        createLanguageModel: (modelId) => ({ modelId }) as never,
        headers: {
          Authorization: "Bearer offpeak-jwt-secret",
          "X-Coding-Plan-Api-Key": "coding-plan-secret",
          "X-Diagnostic-Request": "visible",
          "X-Off-Peak-Ticket-ID": "ticket-secret",
        },
      },
    },
  });
}

function providerRegistry(kind: "anthropic" | "openai-compatible"): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      deepseek:
        kind === "anthropic"
          ? {
              kind,
              apiKey: "test-key",
              baseURL: "https://deepseek.example/anthropic",
            }
          : {
              kind,
              apiKey: "test-key",
              baseURL: "https://deepseek.example/openai",
            },
    },
  });
}

function signatureReplayMessages(includeSigned = true): ModelInputMessage[] {
  return [
    { role: "user", content: "first" },
    {
      role: "assistant",
      providerId: "legacy" as never,
      modelId: "model-old" as never,
      content: [
        {
          type: "reasoning",
          text: "old signed",
          providerOptions: { anthropic: { signature: "old_sig" } },
        },
      ],
    },
    { role: "user", content: "second" },
    {
      role: "assistant",
      providerId: "deepseek" as never,
      modelId: "model-a" as never,
      content: [
        ...(includeSigned
          ? [
              {
                type: "reasoning" as const,
                text: "signed",
                providerOptions: { anthropic: { signature: "sig_1" } },
              },
            ]
          : []),
        { type: "reasoning", text: "unsigned" },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user", content: "continue" },
  ];
}

function expectSignatureReplayRequest(
  messages: AiSdkGenerateTextOptions["messages"],
  includeSigned: boolean,
): void {
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  expect(messages[0]!.content).toBe("first");
  expect(messages[1]!.content).toEqual([{ type: "text", text: "(no content)" }]);
  expect(messages[2]!.content).toBe("second");
  expect(messages[3]!.content).toEqual([
    ...(includeSigned
      ? [
          {
            type: "reasoning",
            text: "signed",
            providerOptions: { anthropic: { signature: "sig_1" } },
          },
        ]
      : []),
    {
      type: "reasoning",
      text: "unsigned",
      providerOptions: { anthropic: { signature: "" } },
    },
    { type: "text", text: "answer" },
  ]);
  expect(messages[4]!.content).toBe("continue");
}

function createInternalProviderNativeWebSearchContract(): ModelToolContract {
  return {
    name: "web_search",
    capability: "web_search",
    description: "Provider-native web search used internally by WebSearch",
    executionMode: "providerNative",
    inputSchema: WEBSEARCH_TOOL_CONTRACT.inputSchema,
    outputSchema: WEBSEARCH_TOOL_CONTRACT.outputSchema,
    providerNative: WEBSEARCH_PROVIDER_NATIVE_SPEC,
  };
}

function startPlanRegistryConfig(runtimeHeader: string) {
  return {
    providers: {
      "account:bigmodel-start-plan": {
        kind: "anthropic" as const,
        apiKey: "client-id.client-secret",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
        headers: {
          "X-Runtime-Token": runtimeHeader,
        },
      },
      "account:zai-start-plan": {
        kind: "anthropic" as const,
        apiKey: "client-id.client-secret",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
        headers: {
          "X-Runtime-Token": runtimeHeader,
        },
      },
    },
  };
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const normalizedName = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const entry = headers.find(
      ([key]) => typeof key === "string" && key.toLowerCase() === normalizedName,
    );
    return typeof entry?.[1] === "string" ? entry[1] : undefined;
  }
  if (typeof headers === "object") {
    const entry = Object.entries(headers as Record<string, unknown>).find(
      ([key]) => key.toLowerCase() === normalizedName,
    );
    return typeof entry?.[1] === "string" ? entry[1] : undefined;
  }
  return undefined;
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
  };
}

function apiError(
  message: string,
  options: {
    isRetryable: boolean;
    responseHeaders?: Record<string, string>;
    statusCode: number;
  },
): Error {
  return Object.assign(new Error(message), {
    isRetryable: options.isRetryable,
    responseHeaders: options.responseHeaders,
    statusCode: options.statusCode,
  });
}

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function* failingStream(error: unknown) {
  throw error;
}

async function* streamThenFail(chunks: unknown[], error: unknown) {
  for (const chunk of chunks) {
    yield chunk;
  }
  throw error;
}

function streamWithReturn(
  chunks: unknown[],
  returnIterator: () => Promise<IteratorResult<unknown>>,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: chunks[index++] };
        },
        return: returnIterator,
      };
    },
  };
}

function createStreamRuntime(fullStream: AsyncIterable<unknown>): AiSdkModelRuntime {
  return {
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      return { fullStream } as never;
    },
  };
}

async function* streamThatStallsUntilAbort(signal?: AbortSignal) {
  yield { type: "start" };
  await new Promise<never>((_resolve, reject) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function* streamThatIgnoresAbort() {
  yield { type: "text-delta", id: "1", text: "partial" };
  await new Promise<never>(() => undefined);
}

async function* delayedStream(chunks: unknown[], delayMs: number) {
  for (const chunk of chunks) {
    await waitForTest(delayMs);
    yield chunk;
  }
}

function waitForTest(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
function rejectAfterTestTimeout(delayMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for stream abort.")), delayMs);
  });
}

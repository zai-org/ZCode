import { describe, expect, it, vi } from "vitest";
import { markUnparsedToolInput, ModelErrorCode, readUnparsedToolInput } from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { normalizeModelToolInput } from "../src/model/tool-input-normalization.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

describe("model tool input normalization", () => {
  const feedbackMalformedCases = [
    {
      input:
        '{"file_path":"F:\\\\clash-verge-fix.bat","content":"@echo off\\nsetlocal EnableExtensions',
      ticket: "ZCT-2072501999367512064",
      toolName: "Write",
    },
    {
      input: '{"content":"# PenglaiAgent v0.3.5 深度审计报告\\n**High**: H1',
      ticket: "ZCT-2072869553480470528",
      toolName: "Write",
    },
    {
      input: '{"content":"# 第二章、第三章 投标文件组织提纲\\n| 4 | 桥梁数量 |',
      ticket: "ZCT-2072928903530250240",
      toolName: "Write",
    },
    {
      input: '{"content":"<!DOCTYPE html>\\n<html lang=\\"zh-CN\\">\\n<th',
      ticket: "ZCT-2072970699099508736",
      toolName: "Write",
    },
    {
      input:
        '{"questions":[{"options":[{"description":"相当于把 2.5D 当作"3D 视角"的初始预设。"}]}]}',
      ticket: "ZCT-2072321679810314240",
      toolName: "AskUserQuestion",
    },
    {
      input: '{"questions":[{"description":"bad\\u"}]}',
      ticket: "ZCT-2072582003671117824",
      toolName: "AskUserQuestion",
    },
  ];

  it("safe-parses stringified tool inputs returned from generateText", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [
            {
              toolCallId: "call_bash",
              toolName: "Bash",
              input: '{"command":"python3 -c \\"print(1)\\""}',
            },
          ],
          totalUsage: usage(2, 1),
          usage: usage(2, 1),
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

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Run a command" }],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_bash",
        name: "Bash",
        input: {
          command: 'python3 -c "print(1)"',
        },
      },
    ]);
  });

  it("accepts a byte-order mark before otherwise valid tool input JSON", async () => {
    const result = await generateTextWithToolInput({
      input: '\uFEFF{"command":"pwd"}',
      toolCallId: "call_bom",
      toolName: "Bash",
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_bom",
        input: { command: "pwd" },
        name: "Bash",
      },
    ]);
  });

  it("degrades JSON null to an empty object through the malformed input path", () => {
    const warn = vi.fn();

    expect(
      normalizeModelToolInput("null", {
        logger: testLogger(warn),
        source: "streamText",
        toolName: "Read",
      }),
    ).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Model tool input JSON normalization failed",
      expect.objectContaining({
        inputLength: 4,
        parseErrorType: "TypeError",
        recovery: "empty_object",
        source: "streamText",
        status: "failed",
        toolName: "Read",
      }),
    );
  });

  it("degrades upstream-normalized null without inventing a raw input length", () => {
    const warn = vi.fn();

    expect(
      normalizeModelToolInput(null, {
        logger: testLogger(warn),
        source: "streamText",
        toolName: "Read",
      }),
    ).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    const [, context] = warn.mock.calls[0] ?? [];
    expect(context).toEqual(
      expect.objectContaining({
        inputType: "null",
        parseErrorType: "TypeError",
        recovery: "empty_object",
        source: "streamText",
        status: "failed",
        toolName: "Read",
      }),
    );
    expect(context).not.toHaveProperty("inputLength");
  });

  it("marks unparseable JSON on an empty object that serializes as {}", () => {
    // 缺少结尾的 `}`，JSON.parse 失败；第 200 个码元（下标 199）是高位代理。
    const raw = `{"content":"${"x".repeat(187)}\u{1F600}"`;
    const input = normalizeModelToolInput(raw, { source: "streamText", toolName: "Write" });

    // 只有 symbol 键：provider 历史、持久化与 model-io 序列化后仍是 {}。
    expect(JSON.stringify(input)).toBe("{}");
    expect(Object.keys(input as object)).toEqual([]);
    // 前 200 个码元的末尾是高位代理时去掉它；长度是完整原串的 UTF-16 长度。
    expect(readUnparsedToolInput(input)).toEqual({
      preview: raw.slice(0, 199),
      length: raw.length,
    });
    expect(readUnparsedToolInput({})).toBeUndefined();
    expect(readUnparsedToolInput(normalizeModelToolInput("null", { source: "streamText" }))).toBe(
      undefined,
    );
  });

  it.each([
    { input: undefined, name: "missing input" },
    { input: "", name: "empty string" },
    // 只含空白与空串同样是“没给参数”，不打解析失败标记（toEqual 会比较 symbol 键）。
    { input: " \n\t", name: "whitespace-only string" },
  ])("degrades $name to an empty object without a parse warning", ({ input }) => {
    const warn = vi.fn();

    expect(
      normalizeModelToolInput(input, {
        logger: testLogger(warn),
        source: "streamText",
        toolName: "Read",
      }),
    ).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps legacy generateText args fallback when input is missing", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [
            {
              args: { file_path: "README.md" },
              toolCallId: "call_legacy_args",
              toolName: "Read",
            },
          ],
          totalUsage: usage(2, 1),
          usage: usage(2, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read a file" }],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_legacy_args",
        input: { file_path: "README.md" },
        name: "Read",
      },
    ]);
  });

  it("degrades partial generateText JSON to an empty object without repairing it", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [
            {
              toolCallId: "call_bad",
              toolName: "Bash",
              input: '{"command":',
            },
          ],
          totalUsage: usage(2, 1),
          usage: usage(2, 1),
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

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Run a command" }],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_bad",
        name: "Bash",
        input: markUnparsedToolInput('{"command":'),
      },
    ]);
  });

  it("recovers an unparseable generateText tool call without retaining the raw input", async () => {
    const malformedInput = '{"command":"bad\\u"}';
    const warn = vi.fn();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [
            {
              toolCallId: "call_bad_escape",
              toolName: "Bash",
              input: malformedInput,
            },
          ],
          totalUsage: usage(2, 1),
          usage: usage(2, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      logger: testLogger(warn),
      registry: registry(),
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Run a command" }],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_bad_escape",
        input: markUnparsedToolInput(malformedInput),
        name: "Bash",
      },
    ]);
    const normalizationWarnings = warn.mock.calls.filter(
      ([message]) => message === "Model tool input JSON normalization failed",
    );
    expect(normalizationWarnings).toHaveLength(1);
    expect(normalizationWarnings[0]).toEqual([
      "Model tool input JSON normalization failed",
      expect.objectContaining({
        inputLength: malformedInput.length,
        parseErrorType: "SyntaxError",
        recovery: "unparsed_marker",
        source: "generateText",
        status: "failed",
        toolName: "Bash",
      }),
    ]);
    expect(JSON.stringify(result.toolCalls)).not.toContain(malformedInput);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(malformedInput);
  });

  it.each(feedbackMalformedCases)(
    "strictly degrades malformed tool input observed in feedback $ticket",
    async ({ input, ticket, toolName }) => {
      const result = await generateTextWithToolInput({
        input,
        toolName,
        toolCallId: `call_${ticket}`,
      });

      expect(result.toolCalls).toEqual([
        {
          id: `call_${ticket}`,
          name: toolName,
          input: markUnparsedToolInput(input),
        },
      ]);
      expect(JSON.stringify(result.toolCalls)).not.toContain(input);
    },
  );

  it("safe-parses stringified tool inputs in streamed tool_call events", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "start" },
            {
              type: "tool-call",
              toolCallId: "call_read",
              toolName: "Read",
              input: '{"file_path":"README.md"}',
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
      runtime,
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
      {
        type: "tool_call",
        toolCall: {
          id: "call_read",
          name: "Read",
          input: { file_path: "README.md" },
        },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
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
  it("recovers a malformed atomic streamed tool_call as an empty object", async () => {
    const malformedInput =
      '{"questions":[{"options":[{"description":"相当于把 2.5D 当作"3D 视角"的初始预设。"}]}]}';
    const warn = vi.fn();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "start" },
            {
              type: "tool-call",
              toolCallId: "call_ask_malformed",
              toolName: "AskUserQuestion",
              input: malformedInput,
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
      logger: testLogger(warn),
      registry: registry(),
      runtime,
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
      {
        type: "tool_call",
        toolCall: {
          id: "call_ask_malformed",
          name: "AskUserQuestion",
          input: markUnparsedToolInput(malformedInput),
        },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
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
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Model tool input JSON normalization failed",
      expect.objectContaining({
        inputLength: malformedInput.length,
        source: "streamText",
        toolName: "AskUserQuestion",
      }),
    );
    expect(JSON.stringify(events)).not.toContain(malformedInput);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(malformedInput);
  });

  it.each(["", "   "])("preserves recoverable generateText tool name %j", async (toolName) => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [
            {
              toolCallId: "call_empty",
              toolName,
              input: { offset: 48 },
            },
          ],
          totalUsage: usage(2, 1),
          usage: usage(2, 1),
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

    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Read more" }],
      }),
    ).resolves.toMatchObject({
      toolCalls: [
        {
          id: "call_empty",
          input: { offset: 48 },
          name: toolName,
        },
      ],
    });
  });

  it.each([undefined, null, 42, { invalid: true }])(
    "rejects generateText tool name %j",
    async (toolName) => {
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          return {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [
              {
                toolCallId: "call_invalid_name",
                toolName,
                input: {},
              },
            ],
            totalUsage: usage(2, 1),
            usage: usage(2, 1),
          } as never;
        },
        streamText() {
          throw new Error("not used");
        },
      };
      const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });

      await expect(
        executeAdapterGenerateText(adapter, {
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Read more" }],
        }),
      ).rejects.toMatchObject({
        code: ModelErrorCode.InvalidModelResponse,
        message: "Model returned an invalid tool call: tool name is empty.",
      });
    },
  );

  it("keeps the existing generated tool-call id fallback", async () => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return {
          finishReason: "tool-calls",
          text: "",
          toolCalls: [
            {
              toolName: "Read",
              input: {},
            },
          ],
          totalUsage: usage(2, 1),
          usage: usage(2, 1),
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

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read more" }],
    });
    expect(result.toolCalls?.[0]).toMatchObject({ input: {}, name: "Read" });
    expect(result.toolCalls?.[0]?.id).toEqual(expect.any(String));
    expect(result.toolCalls?.[0]?.id.length).toBeGreaterThan(0);
  });

  it.each(["", "   "])("preserves streamed tool name %j", async (toolName) => {
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([
            { type: "start" },
            {
              type: "tool-call",
              toolCallId: "call_empty",
              toolName,
              input: { offset: 48 },
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      runtime,
    });

    const events = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Read more" }],
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "tool_call",
      toolCall: {
        id: "call_empty",
        input: { offset: 48 },
        name: toolName,
        providerExecuted: undefined,
      },
    });
  });

  it.each(["generateText", "streamText"])(
    "rejects provider-executed empty names from %s",
    async (source) => {
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          return {
            finishReason: "tool-calls",
            text: "",
            toolCalls: [
              {
                providerExecuted: true,
                toolCallId: "call_provider_empty",
                toolName: "",
                input: {},
              },
            ],
            totalUsage: usage(2, 1),
            usage: usage(2, 1),
          } as never;
        },
        streamText() {
          return {
            fullStream: stream([
              { type: "start" },
              {
                type: "tool-call",
                providerExecuted: true,
                toolCallId: "call_provider_empty",
                toolName: "",
                input: {},
              },
            ]),
          } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({ registry: registry(), runtime });
      const request = {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user" as const, content: "Search" }],
      };
      const call =
        source === "generateText"
          ? executeAdapterGenerateText(adapter, request)
          : (async () => {
              for await (const _event of executeAdapterStreamText(adapter, request)) {
                // drain
              }
            })();

      await expect(call).rejects.toMatchObject({
        code: ModelErrorCode.InvalidModelResponse,
        message: "Model returned an invalid tool call: tool name is empty.",
      });
    },
  );
});

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

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function generateTextWithToolInput(options: {
  input: unknown;
  toolCallId: string;
  toolName: string;
}) {
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      return {
        finishReason: "tool-calls",
        text: "",
        toolCalls: [
          {
            input: options.input,
            toolCallId: options.toolCallId,
            toolName: options.toolName,
          },
        ],
        totalUsage: usage(2, 1),
        usage: usage(2, 1),
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

  return executeAdapterGenerateText(adapter, {
    providerId: "test" as never,
    modelId: "model-a" as never,
    messages: [{ role: "user", content: "Run a command" }],
  });
}

function testLogger(warn: ReturnType<typeof vi.fn>) {
  return {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn,
  } as never;
}

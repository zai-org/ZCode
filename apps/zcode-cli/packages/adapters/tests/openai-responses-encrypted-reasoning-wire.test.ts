import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  type ModelEvent,
  type ModelInputMessage,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";

// gpt-6.1-terra 不在 AI SDK 的推理模型名单里，SDK 不会自动补 include；用它证明 include 由 zcode 显式发送。
const MODEL_ID = "gpt-6.1-terra";
const PROVIDER_ID = "fixture";
const BASE_URL = "https://gateway.example.com/v1";
const ENCRYPTED = "opaque-encrypted-reasoning";
const ENCRYPTED_INCLUDE = "reasoning.encrypted_content";
const READ_TOOL = {
  name: "Read",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;
// 上游标准错误包含结构化错误码；部分兼容网关仅返回密文过期文案。
const INVALID_ENCRYPTED_CONTENT_BODY = {
  error: {
    message: "The encrypted content for item rs_1 could not be verified.",
    type: "invalid_request_error",
    param: null,
    code: "invalid_encrypted_content",
  },
};
const EXPIRED_ENCRYPTED_CONTENT_BODY = {
  error: {
    message: "reasoning `encrypted_content` has expired",
    type: "invalid_request_error",
    param: null,
    code: null,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI Responses 加密推理回传", () => {
  it("请求带 store:false 和 include，流式 reasoning 保留密文", async () => {
    const bodies = stubFetch(() => sseResponse(reasoningAndToolCallFrames()));
    const model = await createModel();

    const events: ModelEvent[] = [];
    for await (const event of model.streamText({
      messages: [{ role: "user", content: "hi" }],
      tools: [READ_TOOL],
    })) {
      events.push(event);
    }

    expect(bodies[0]).toMatchObject({ store: false, include: [ENCRYPTED_INCLUDE] });
    const ends = events.filter((event) => event.type === "reasoning_end");
    // 第一段摘要在第二段开始时结束，不带密文；密文只出现在 output_item.done 结束的最后一段。
    expect(ends.map((event) => event.providerMetadata)).toEqual([
      { openai: { itemId: "rs_1" } },
      { openai: { itemId: "rs_1", reasoningEncryptedContent: ENCRYPTED } },
    ]);
  });

  it("没有摘要的 reasoning 也保留密文，下一轮原样带回", async () => {
    // zcode 不请求 reasoning.summary，真实流里常见的就是这种形态：没有摘要正文，只有密文。
    const bodies = stubFetchSequence([
      () => sseResponse(reasoningAndToolCallFrames([])),
      () => jsonResponse(),
    ]);
    const model = await createModel();

    const events: ModelEvent[] = [];
    for await (const event of model.streamText({
      messages: [{ role: "user", content: "hi" }],
      tools: [READ_TOOL],
    })) {
      events.push(event);
    }
    const ends = events.filter((event) => event.type === "reasoning_end");
    expect(ends.map((event) => event.providerMetadata)).toEqual([
      { openai: { itemId: "rs_1", reasoningEncryptedContent: ENCRYPTED } },
    ]);

    // core 用 reasoning_end 的元数据写块：正文为空，元数据带密文。
    await model.generateText({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          providerId: createModelProviderId(PROVIDER_ID),
          modelId: createModelId(MODEL_ID),
          content: [{ type: "reasoning", text: "", providerOptions: ends[0]?.providerMetadata }],
          toolCalls: [{ id: "call_1", name: "Read", input: { path: "README.md" } }],
        },
        { role: "tool", toolCallId: "call_1", toolName: "Read", content: "ok" },
      ],
    });

    expect(reasoningItems(bodies[1])).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: ENCRYPTED, summary: [] },
    ]);
  });

  it("下一轮按 itemId 带回密文，丢弃没有密文的旧 reasoning", async () => {
    const bodies = stubFetch(() => jsonResponse());
    const model = await createModel();

    await model.generateText({ messages: history(PROVIDER_ID, MODEL_ID) });

    const input = bodies[0]?.input as Array<Record<string, unknown>>;
    expect(input.filter((item) => item.type === "item_reference")).toEqual([]);
    expect(input.filter((item) => item.type === "reasoning")).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: ENCRYPTED,
        summary: [
          { type: "summary_text", text: "first summary" },
          { type: "summary_text", text: "second summary" },
        ],
      },
    ]);
  });

  it.each([
    ["模型", PROVIDER_ID, "gpt-5.4"],
    ["Provider", "other-provider", MODEL_ID],
  ])("切换%s后不带回其他来源的密文", async (_name, providerId, modelId) => {
    const bodies = stubFetch(() => jsonResponse());
    const model = await createModel();

    await model.generateText({ messages: history(providerId, modelId) });

    const input = bodies[0]?.input as Array<Record<string, unknown>>;
    expect(input.filter((item) => item.type === "reasoning")).toEqual([]);
    expect(input.some((item) => item.type === "function_call")).toBe(true);
  });

  it("后面没有输出项的 reasoning 不带回", async () => {
    const bodies = stubFetch(() => jsonResponse());
    const model = await createModel();
    const identity = {
      providerId: createModelProviderId(PROVIDER_ID),
      modelId: createModelId(MODEL_ID),
    };
    const encrypted = (itemId: string, text: string) => ({
      type: "reasoning" as const,
      text,
      providerOptions: { openai: { itemId, reasoningEncryptedContent: `enc_${itemId}` } },
    });

    await model.generateText({
      messages: [
        { role: "user", content: "first" },
        // 输出 token 在推理阶段用完：续写保留的 partial 只有 reasoning。
        { role: "assistant", ...identity, content: [encrypted("rs_only", "cut off")] },
        { role: "user", content: "Continue" },
        // 推理完成后停止：末尾的 reasoning 后面没有输出项，前面的保留。
        {
          role: "assistant",
          ...identity,
          content: [
            encrypted("rs_kept", "kept"),
            { type: "text", text: "partial answer" },
            encrypted("rs_tail", "stopped"),
          ],
        },
        { role: "user", content: "next" },
      ],
    });

    expect(reasoningItems(bodies[0]).map((item) => item.id)).toEqual(["rs_kept"]);
  });

  it("Option Map 不写 reasoning 的模型只发 store:false，不发 include", async () => {
    const bodies = stubFetch(() => jsonResponse());
    // 非推理模型只有在映射不写 reasoning 时才能工作；这时带 include 会被上游 400。
    const model = await createModel({ reasoningMap: "{}" });

    await model.generateText({ messages: [{ role: "user", content: "hi" }] });

    expect(bodies[0]).toMatchObject({ store: false });
    expect(bodies[0]).not.toHaveProperty("include");
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });

  it.each([
    ["结构化错误码", INVALID_ENCRYPTED_CONTENT_BODY],
    ["没有错误码的过期文案", EXPIRED_ENCRYPTED_CONTENT_BODY],
  ])("generate 遇到密文被拒（%s）时去掉密文重试一次并报告重置", async (_name, errorBody) => {
    const bodies = stubFetchSequence([
      () => Response.json(errorBody, { status: 400 }),
      () => jsonResponse(),
    ]);
    const model = await createModel();

    const result = await model.generateText({ messages: history(PROVIDER_ID, MODEL_ID) });

    expect(bodies).toHaveLength(2);
    expect(reasoningItems(bodies[0])).toHaveLength(1);
    expect(reasoningItems(bodies[1])).toEqual([]);
    expect(inputItems(bodies[1]).some((item) => item.type === "function_call")).toBe(true);
    expect(result.signedReasoningReset).toBe(true);
  });

  it.each([
    ["结构化错误码", INVALID_ENCRYPTED_CONTENT_BODY],
    ["没有错误码的过期文案", EXPIRED_ENCRYPTED_CONTENT_BODY],
  ])("stream 遇到密文被拒（%s）时去掉密文重试一次，finish 报告重置", async (_name, errorBody) => {
    const bodies = stubFetchSequence([
      () => Response.json(errorBody, { status: 400 }),
      () => sseResponse(textFrames()),
    ]);
    const model = await createModel();

    const events: ModelEvent[] = [];
    for await (const event of model.streamText({ messages: history(PROVIDER_ID, MODEL_ID) })) {
      events.push(event);
    }

    expect(bodies).toHaveLength(2);
    expect(reasoningItems(bodies[0])).toHaveLength(1);
    expect(reasoningItems(bodies[1])).toEqual([]);
    expect(events.find((event) => event.type === "finish")).toMatchObject({
      signedReasoningReset: true,
    });
  });

  it("其他 400 不触发密文修复重试", async () => {
    const bodies = stubFetchSequence([
      () =>
        Response.json(
          {
            error: {
              message: "Invalid value for 'input'.",
              type: "invalid_request_error",
              param: "input",
              code: "invalid_value",
            },
          },
          { status: 400 },
        ),
      () => jsonResponse(),
    ]);
    const model = await createModel();

    await expect(
      model.generateText({ messages: history(PROVIDER_ID, MODEL_ID) }),
    ).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });

  it("修复标记之前的密文不再发送，标记及之后的保留", async () => {
    const bodies = stubFetch(() => jsonResponse());
    const model = await createModel();
    const earlier = history(PROVIDER_ID, MODEL_ID);
    const marked: ModelInputMessage = {
      role: "assistant",
      providerId: createModelProviderId(PROVIDER_ID),
      modelId: createModelId(MODEL_ID),
      signedReasoningReset: true,
      content: [
        {
          type: "reasoning",
          text: "after repair",
          providerOptions: { openai: { itemId: "rs_2", reasoningEncryptedContent: "fresh" } },
        },
      ],
      toolCalls: [{ id: "call_2", name: "Read", input: { path: "b.md" } }],
    };

    await model.generateText({
      messages: [
        ...earlier,
        marked,
        { role: "tool", toolCallId: "call_2", toolName: "Read", content: "ok" },
      ],
    });

    expect(reasoningItems(bodies[0])).toEqual([
      {
        type: "reasoning",
        id: "rs_2",
        encrypted_content: "fresh",
        summary: [{ type: "summary_text", text: "after repair" }],
      },
    ]);
  });
});

async function createModel(options: { reasoningMap?: string } = {}) {
  const release = JSON.parse(
    await readFile(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
      "utf8",
    ),
  );
  const resolved = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules).resolve({
    providerId: PROVIDER_ID,
    templateId: "openai",
    modelId: MODEL_ID,
    apiType: "openai-responses",
    baseUrl: BASE_URL,
  });
  // 用个人覆盖的方式改映射，和用户给非推理模型改配置的路径一致。
  const config =
    options.reasoningMap === undefined
      ? resolved
      : resolved.overlay(
          parseModelConfig({ optionSpecs: { reasoningLevel: { map: options.reasoningMap } } }),
        );
  const modelConfig = createRegistryModelConfig(config);
  const providerConfig = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture" },
      api: { type: "openai-responses", baseUrl: BASE_URL },
    }),
  );
  if (!modelConfig.ok || !providerConfig.ok) throw new Error("incomplete fixture");
  return new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }).createModel({
    providerId: createModelProviderId(PROVIDER_ID),
    modelId: createModelId(MODEL_ID),
    providerConfig: providerConfig.config,
    modelConfig: modelConfig.config,
    options: { maxOutputTokens: 4000, reasoningLevel: "high" },
  });
}

function history(providerId: string, modelId: string): ModelInputMessage[] {
  return [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      providerId: createModelProviderId(providerId),
      modelId: createModelId(modelId),
      content: [
        // 本改动之前写入的历史：有 itemId，没有密文。
        {
          type: "reasoning",
          text: "legacy summary",
          providerOptions: { openai: { itemId: "rs_0", reasoningEncryptedContent: null } },
        },
        {
          type: "reasoning",
          text: "first summary",
          providerOptions: { openai: { itemId: "rs_1" } },
        },
        {
          type: "reasoning",
          text: "second summary",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: ENCRYPTED } },
        },
      ],
      toolCalls: [{ id: "call_1", name: "Read", input: { path: "README.md" } }],
    },
    { role: "tool", toolCallId: "call_1", toolName: "Read", content: "ok" },
  ];
}

function stubFetch(create: () => Response): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(await new Request(url, init).json());
    return create();
  });
  return bodies;
}

function stubFetchSequence(responses: Array<() => Response>): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(await new Request(url, init).json());
    const create = responses[bodies.length - 1];
    if (!create) throw new Error(`unexpected request #${bodies.length}`);
    return create();
  });
  return bodies;
}

function inputItems(body: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return (body?.input ?? []) as Array<Record<string, unknown>>;
}

function reasoningItems(body: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return inputItems(body).filter((item) => item.type === "reasoning");
}

function jsonResponse(): Response {
  return Response.json({
    id: "resp_2",
    object: "response",
    created_at: 1,
    status: "completed",
    model: MODEL_ID,
    output: [
      {
        id: "msg_2",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

function reasoningAndToolCallFrames(
  summaries = ["first summary", "second summary"],
): Array<Record<string, unknown>> {
  return [
    { type: "response.created", response: { id: "resp_1", created_at: 1, model: MODEL_ID } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", encrypted_content: null },
    },
    ...summaries.flatMap((delta, summary_index) => [
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index, delta },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index },
    ]),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", encrypted_content: ENCRYPTED },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: '{"path":"README.md"}',
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "Read",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
}

function textFrames(): Array<Record<string, unknown>> {
  return [
    { type: "response.created", response: { id: "resp_3", created_at: 1, model: MODEL_ID } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_3" } },
    { type: "response.output_text.delta", item_id: "msg_3", delta: "done" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_3" } },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
}

function sseResponse(frames: Array<Record<string, unknown>>): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

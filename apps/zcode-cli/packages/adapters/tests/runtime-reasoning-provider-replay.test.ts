import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  InMemorySessionEventStore,
  SESSION_ENTRY_MODEL_SELECTION,
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createProjectId,
  createSessionId,
  parseModelSelectionValue,
  type Model,
  type ModelRequest,
  type SessionId,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import { orderGeneratedContent } from "../src/model/runner-normalization.js";
import { createTestModelProperties } from "./test-model-format.js";
import { AgentRuntime } from "../../core/src/runtime.js";

const MODEL_ID = createModelId("GLM-5.3");
const USER_ID = createMessageId("old-user");
const ASSISTANT_ID = createMessageId("old-assistant");
const SIGNATURE = "fixture-signature\nopaque ";
const REDACTED_DATA = "fixture-redacted-opaque";
const HISTORICAL_CONTENT = [
  { type: "thinking", thinking: "Historical thinking", signature: SIGNATURE },
  { type: "redacted_thinking", data: REDACTED_DATA },
  { type: "text", text: "Inspecting report" },
  { type: "tool_use", id: "old-read", name: "Read", input: { file_path: "report.txt" } },
];
const cases = ["zai", "bigmodel"].flatMap((family) => {
  const legacy = `builtin:${family}-coding-plan`;
  const individual = `account:${family}-individual-coding-plan`;
  const team = `account:${family}-team-coding-plan`;
  return [
    [legacy, individual],
    [legacy, team],
    [individual, team],
    [team, individual],
  ] as const;
});

describe.each(["off", "on"] as const)(
  "Runtime reasoning replay (streaming=%s)",
  (modelStreaming) => {
    it.each(cases)(
      "restores %s and replays into %s without changing old bytes",
      async (source, target) => {
        const root = await mkdtemp(join(tmpdir(), "zcode-reasoning-replay-"));
        const sessionID = createSessionId("reasoning-replay");
        let store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
        const db = new DatabaseSync(join(root, "session.sqlite"));
        let runtime: AgentRuntime | undefined;
        try {
          // 合并修复：空库建表后移除尚未播种的迁移记录，模拟升级前数据；只操作临时夹具。
          db.prepare("DELETE FROM schema_migration WHERE id = ?").run(
            "0020_provider_model_selection",
          );
          await seedHistory({ db, store, root, sessionID, providerId: source });
          const snapshot = () => ({
            messages: db
              .prepare("select data from message where id in (?, ?) order by id")
              .all(USER_ID, ASSISTANT_ID),
            parts: db
              .prepare("select data from part where message_id in (?, ?) order by id")
              .all(USER_ID, ASSISTANT_ID),
          });
          const before = snapshot();
          // Todo109 已将迁移收进数据库启动；不能恢复已删除的逐 Session 迁移接口。
          store.close();
          store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
          const migrated = snapshot();
          expect(migrated.messages).toHaveLength(before.messages.length);
          for (const [index, row] of before.messages.entries()) {
            expect(JSON.parse(String(migrated.messages[index]!.data))).toMatchObject(
              JSON.parse(String(row.data)),
            );
          }
          expect(migrated.parts).toEqual(before.parts);
          const entries = await store.sessionEntries({
            sessionID,
            type: SESSION_ENTRY_MODEL_SELECTION,
          });
          const selection = parseModelSelectionValue(entries.at(-1)?.data);
          if (!selection) throw new Error("Missing restored model selection");
          expect(selection.providerId).toBe(
            source.startsWith("builtin:")
              ? source
                  .replace("builtin:", "account:")
                  .replace("-coding-plan", "-individual-coding-plan")
              : source,
          );
          const decoded = (await store.messages({ sessionID })).find(
            (message) => message.info.id === ASSISTANT_ID,
          );
          expect(decoded?.info).toMatchObject({ providerId: source, modelId: MODEL_ID });

          const bodies: Array<{ messages: Array<{ role: string; content: unknown[] }> }> = [];
          vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            expect(request.url).toBe("https://reasoning.invalid/v1/messages");
            bodies.push(await request.json());
            return modelResponse(modelStreaming === "on");
          });
          const provider = createRegistryProviderConfig(
            parseProviderConfig({
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-key" },
              api: { type: "anthropic-messages", baseUrl: "https://reasoning.invalid/v1" },
            }),
          );
          const model = createRegistryModelConfig(
            parseModelConfig({
              enabled: true,
              properties: createTestModelProperties(),
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: { max: 32_000, map: '{"max_tokens": maxOutputTokens}' },
              },
            }),
          );
          if (!provider.ok || !model.ok) throw new Error("Invalid model fixture config");
          const adapter = new AiSdkModelAdapter({
            env: {},
            retry: { maxAttempts: 1 },
          });
          const requests: ModelRequest[] = [];
          runtime = new AgentRuntime(
            sessionID,
            {
              mode: "build",
              modelStreaming,
              workingDirectory: root,
              modelSelection: selection,
              memory: { enabled: false },
              compact: { enabled: false },
            },
            {
              sessionStore: store,
              eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
              modelFactory: ({ selection }) =>
                observeModel(
                  adapter.createModel({
                    providerId: selection.providerId,
                    modelId: selection.modelId,
                    providerConfig: provider.config,
                    modelConfig: model.config,
                    options: { maxOutputTokens: 32_000, ...selection.options },
                  }),
                  requests,
                ),
            },
          );
          await runtime.resumeFromStore();
          runtime.setSessionModelSelection({
            ...selection,
            providerId: createModelProviderId(target),
          });
          await runtime.executeTurn("Continue after restart");

          expect(bodies).toHaveLength(1);
          const assistant = bodies[0]!.messages.find((message) => message.role === "assistant");
          expect(assistant?.content).toEqual(HISTORICAL_CONTENT);
          expect(bodies[0]!.messages).toContainEqual(
            expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "tool_result",
                  tool_use_id: "old-read",
                  content: "Report content",
                }),
              ]),
            }),
          );
          await runtime.executeTurn("Continue the same task again");
          expect(bodies).toHaveLength(2);
          expect(
            bodies[1]!.messages.find((message) => message.role === "assistant")?.content,
          ).toEqual(assistant?.content);
          const canonical = requests[0]!.messages.find((message) => message.role === "assistant");
          expect(canonical).toMatchObject({ providerId: source, modelId: MODEL_ID });
          expect(canonical?.content).toEqual(
            expect.arrayContaining([
              {
                type: "reasoning",
                text: "Historical thinking",
                providerOptions: { anthropic: { signature: SIGNATURE } },
              },
              {
                type: "reasoning",
                text: "",
                providerOptions: { anthropic: { redactedData: REDACTED_DATA } },
              },
            ]),
          );
          expect(snapshot()).toEqual(migrated);
        } finally {
          runtime?.beginShutdown();
          vi.unstubAllGlobals();
          db.close();
          store.close();
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);

describe.each(["off", "on"] as const)(
  "Runtime signature repair marker (streaming=%s)",
  (modelStreaming) => {
    it("keeps reasoning removed by a repair out of later requests and after cold resume", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-reasoning-repair-"));
      const sessionID = createSessionId("reasoning-repair");
      const providerId = "account:zai-individual-coding-plan";
      const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
      const db = new DatabaseSync(join(root, "session.sqlite"));
      const runtimes: AgentRuntime[] = [];
      try {
        await seedHistory({ db, store, root, sessionID, providerId });
        const seededRows = () => ({
          messages: db
            .prepare("select data from message where id in (?, ?) order by id")
            .all(USER_ID, ASSISTANT_ID),
          parts: db
            .prepare("select data from part where message_id in (?, ?) order by id")
            .all(USER_ID, ASSISTANT_ID),
        });
        const seeded = seededRows();
        const bodies: string[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const body = await new Request(input, init).text();
          bodies.push(body);
          // 模拟服务端的前缀校验：恢复后的历史签名块一律被拒，去掉之后才放行。
          return body.includes("fixture-signature") || body.includes(REDACTED_DATA)
            ? signatureRejection()
            : modelResponse(modelStreaming === "on");
        });
        const selection = parseModelSelectionValue(
          (await store.sessionEntries({ sessionID, type: SESSION_ENTRY_MODEL_SELECTION })).at(-1)
            ?.data,
        );
        if (!selection) throw new Error("Missing seeded model selection");
        const startRuntime = async () => {
          const runtime = createReplayRuntime({
            root,
            sessionID,
            store,
            modelStreaming,
            selection,
          });
          runtimes.push(runtime);
          await runtime.resumeFromStore();
          return runtime;
        };
        const hasSignedReasoning = (body: string) =>
          body.includes("fixture-signature") || body.includes(REDACTED_DATA);
        const firstAssistantContent = (body: string) =>
          (
            JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }
          ).messages.find((message) => message.role === "assistant")?.content;

        const live = await startRuntime();
        await live.executeTurn("Continue after restart");
        expect(bodies.map(hasSignedReasoning)).toEqual([true, false]);

        await live.executeTurn("Continue the same task again");
        expect(bodies).toHaveLength(3);
        expect(hasSignedReasoning(bodies[2]!)).toBe(false);
        expect(firstAssistantContent(bodies[2]!)).toEqual(firstAssistantContent(bodies[1]!));

        const assistants = (await store.messages({ sessionID })).filter(
          (message) => message.info.role === "assistant" && message.info.id !== ASSISTANT_ID,
        );
        expect(assistants.map((message) => message.info.metadata?.signedReasoningReset)).toEqual([
          true,
          undefined,
        ]);
        expect(seededRows()).toEqual(seeded);
        live.beginShutdown();

        const resumed = await startRuntime();
        await resumed.executeTurn("Continue after another restart");
        expect(bodies).toHaveLength(4);
        expect(hasSignedReasoning(bodies[3]!)).toBe(false);
        expect(firstAssistantContent(bodies[3]!)).toEqual(firstAssistantContent(bodies[1]!));
      } finally {
        for (const runtime of runtimes) runtime.beginShutdown();
        vi.unstubAllGlobals();
        db.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

function createReplayRuntime(input: {
  root: string;
  sessionID: SessionId;
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  modelStreaming: "off" | "on";
  selection: NonNullable<ReturnType<typeof parseModelSelectionValue>>;
}): AgentRuntime {
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "anthropic-messages", baseUrl: "https://reasoning.invalid/v1" },
    }),
  );
  const model = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: createTestModelProperties(),
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: 32_000, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  if (!provider.ok || !model.ok) throw new Error("Invalid model fixture config");
  const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } });
  return new AgentRuntime(
    input.sessionID,
    {
      mode: "build",
      modelStreaming: input.modelStreaming,
      workingDirectory: input.root,
      modelSelection: input.selection,
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      sessionStore: input.store,
      eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
      modelFactory: ({ selection }) =>
        adapter.createModel({
          providerId: selection.providerId,
          modelId: selection.modelId,
          providerConfig: provider.config,
          modelConfig: model.config,
          options: { maxOutputTokens: 32_000, ...selection.options },
        }),
    },
  );
}

function signatureRejection(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function observeModel(model: Model, requests: ModelRequest[]): Model {
  return {
    ...model,
    bind: (options) => observeModel(model.bind(options), requests),
    generateText(request) {
      requests.push(request);
      return model.generateText(request);
    },
    streamText(request) {
      requests.push(request);
      return model.streamText(request);
    },
  };
}

async function seedHistory(input: {
  db: DatabaseSync;
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  root: string;
  sessionID: SessionId;
  providerId: string;
}) {
  const { db, store, root, sessionID, providerId } = input;
  const legacy = providerId.startsWith("builtin:");
  await store.createSession({
    id: sessionID,
    projectID: createProjectId("reasoning-replay"),
    directory: root,
    slug: "replay",
    title: "Replay",
    version: "old",
  });
  const modelSelection = { providerId, modelId: MODEL_ID, options: { reasoningLevel: "disabled" } };
  // 已发布旧格式直接写入 SQLite，避免用新版 writer 生成伪旧数据。
  const insert = db.prepare(
    "insert into message(id,session_id,sequence,time_created,time_updated,data) values(?,?,?,?,?,?)",
  );
  insert.run(
    USER_ID,
    sessionID,
    1,
    1,
    1,
    JSON.stringify({
      role: "user",
      agent: "zcode-agent",
      time: { created: 1 },
      ...(legacy
        ? { model: { providerID: providerId, modelID: MODEL_ID, variant: "disabled" } }
        : { modelSelection }),
    }),
  );
  insert.run(
    ASSISTANT_ID,
    sessionID,
    2,
    2,
    3,
    JSON.stringify({
      role: "assistant",
      time: { created: 2, completed: 3 },
      parentID: USER_ID,
      ...(legacy
        ? { providerID: providerId, modelID: MODEL_ID, variant: "disabled" }
        : { providerId, modelId: MODEL_ID, reasoningLevel: "disabled" }),
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: root, root },
      cost: 0,
      tokens: { input: 20, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    }),
  );
  db.prepare(
    "insert into session_entry(id,session_id,type,time_created,time_updated,data) values(?,?,?,?,?,?)",
  ).run(
    `${sessionID}:runtime-model-selection`,
    sessionID,
    SESSION_ENTRY_MODEL_SELECTION,
    1,
    1,
    JSON.stringify(
      legacy ? { providerId, modelId: MODEL_ID, thoughtLevel: "disabled" } : { modelSelection },
    ),
  );
  for (const [id, text, metadata] of [
    ["signed", "Historical thinking", { anthropic: { signature: SIGNATURE } }],
    ["redacted", "", { anthropic: { redactedData: REDACTED_DATA } }],
  ] as const) {
    await store.savePart({
      id: createPartId(id),
      sessionID,
      messageID: ASSISTANT_ID,
      type: "reasoning",
      text,
      metadata,
      time: { start: 2, end: 3 },
    });
  }
  for (const [messageID, text] of [
    [USER_ID, "Inspect report"],
    [ASSISTANT_ID, "Inspecting report"],
  ] as const) {
    await store.savePart({
      id: createPartId(`${messageID}-text`),
      sessionID,
      messageID,
      type: "text",
      text,
      time: { start: 1, end: 3 },
    });
  }
  await store.savePart({
    id: createPartId("read"),
    sessionID,
    messageID: ASSISTANT_ID,
    type: "tool",
    tool: "Read",
    callID: "old-read",
    state: {
      status: "completed",
      input: { file_path: "report.txt" },
      output: "Report content",
      title: "Report",
      metadata: {},
      time: { start: 2, end: 3 },
    },
  });
}

function modelResponse(streaming: boolean): Response {
  const message = {
    id: "msg_replay",
    model: MODEL_ID,
    role: "assistant",
    type: "message",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 1 },
    content: [{ type: "text", text: "done" }],
  };
  if (!streaming)
    return new Response(JSON.stringify(message), {
      headers: { "content-type": "application/json" },
    });
  const events = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

// docs/design/v2/model/assistant-block-order.md：交错响应按流顺序保存，live 与冷恢复发出相同字节。
const INTERLEAVED_CONTENT = [
  { type: "thinking", thinking: "First thought", signature: "sig-first" },
  { type: "text", text: "Let me check." },
  { type: "thinking", thinking: "Second thought", signature: "sig-second" },
  { type: "text", text: "Reading now." },
  { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "report.txt" } },
];

describe.each(["off", "on"] as const)(
  "Runtime assistant block order replay (streaming=%s)",
  (modelStreaming) => {
    it("sends the same interleaved assistant bytes live and after cold resume", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-block-order-"));
      const dbPath = join(root, "session.sqlite");
      const sessionID = createSessionId("block-order");
      let store = await createSqliteSessionStore({ dbPath });
      const runtimes: AgentRuntime[] = [];
      const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
      try {
        await store.createSession({
          id: sessionID,
          projectID: createProjectId("block-order"),
          directory: root,
          slug: "block-order",
          title: "Block order",
          version: "test",
        });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          bodies.push(await request.json());
          const streaming = modelStreaming === "on";
          return bodies.length === 1
            ? anthropicResponse(INTERLEAVED_CONTENT, "tool_use", streaming)
            : anthropicResponse([{ type: "text", text: "done" }], "end_turn", streaming);
        });
        const createRuntime = () => {
          const runtime = createAnthropicRuntime({ root, sessionID, store, modelStreaming });
          runtimes.push(runtime);
          return runtime;
        };

        const live = createRuntime();
        await live.executeTurn("Inspect report");
        await live.executeTurn("Follow up");
        expect(bodies).toHaveLength(3);
        const firstAssistant = (body: (typeof bodies)[number]) =>
          body.messages.find((message) => message.role === "assistant")?.content;
        // 两段文字不合并；tool_use 后面没有其他块，保持原顺序。
        expect(stripCacheControl(firstAssistant(bodies[1]!))).toEqual(INTERLEAVED_CONTENT);
        expect(stripCacheControl(firstAssistant(bodies[2]!))).toEqual(INTERLEAVED_CONTENT);

        live.beginShutdown();
        store.close();
        store = await createSqliteSessionStore({ dbPath });
        const cold = createRuntime();
        await cold.resumeFromStore();
        await cold.executeTurn("Follow up");
        expect(bodies).toHaveLength(4);
        // 冷恢复后的请求以 live 最后一次请求为前缀：同一条交错消息发出相同字节，缓存前缀不变。
        const liveMessages = bodies[2]!.messages;
        expect(stripCacheControl(bodies[3]!.messages.slice(0, liveMessages.length))).toEqual(
          stripCacheControl(liveMessages),
        );
      } finally {
        for (const runtime of runtimes) runtime.beginShutdown();
        vi.unstubAllGlobals();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

// 回复只有思考块（send now / 停止在思考中打断、思考后流失败，历史形态相同）时，下一次请求不能把
// MCS system 放在这条回复前面再删掉它：请求会变成 system 直接接 user，provider 返回 400。
describe.each(["off", "on"] as const)(
  "Runtime reasoning-only reply with mid-conversation system (streaming=%s)",
  (modelStreaming) => {
    it("never sends a system message directly before a user message, live and after cold resume", async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-reasoning-only-mcs-"));
      const dbPath = join(root, "session.sqlite");
      const sessionID = createSessionId("reasoning-only-mcs");
      let store = await createSqliteSessionStore({ dbPath });
      const runtimes: AgentRuntime[] = [];
      const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
      try {
        await store.createSession({
          id: sessionID,
          projectID: createProjectId("reasoning-only-mcs"),
          directory: root,
          slug: "reasoning-only-mcs",
          title: "Reasoning-only reply",
          version: "test",
        });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          bodies.push(await request.json());
          const streaming = modelStreaming === "on";
          return bodies.length === 1
            ? anthropicResponse(
                [{ type: "thinking", thinking: "Still thinking", signature: "sig-only" }],
                "end_turn",
                streaming,
              )
            : anthropicResponse([{ type: "text", text: "done" }], "end_turn", streaming);
        });
        const createRuntime = () => {
          const runtime = createAnthropicRuntime({ root, sessionID, store, modelStreaming });
          runtimes.push(runtime);
          return runtime;
        };
        const roles = (index: number) => bodies[index]!.messages.map((message) => message.role);
        const expectValidFollowUp = (index: number) => {
          expect(roles(index)).toContain("system");
          expect(
            roles(index).some((role, at, all) => role === "system" && all[at + 1] === "user"),
          ).toBe(false);
          expect(JSON.stringify(bodies[index]!.messages)).not.toContain("Still thinking");
        };

        const live = createRuntime();
        await live.executeTurn("Inspect report");
        // 前提：第一轮的公告按 MCS 投影成 system。
        expect(roles(0)).toContain("system");
        await live.executeTurn("Follow up");
        expect(bodies).toHaveLength(2);
        expectValidFollowUp(1);

        live.beginShutdown();
        store.close();
        store = await createSqliteSessionStore({ dbPath });
        const cold = createRuntime();
        await cold.resumeFromStore();
        await cold.executeTurn("Follow up again");
        expect(bodies).toHaveLength(3);
        expectValidFollowUp(2);
      } finally {
        for (const runtime of runtimes) runtime.beginShutdown();
        vi.unstubAllGlobals();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

// 非流式结果和规范化后的 text / reasoning / toolCalls 对不上时整条不编号，按旧消息处理；
// 只给一部分块编号会让 live 与冷恢复的文字拼法不同（docs/design/v2/model/assistant-block-order.md「写入」）。
describe("non-stream block numbering fallback", () => {
  const call = (id: string) => ({ id, name: "Read", input: { file_path: "a.txt" } });

  it("numbers no block when the result has no content list", () => {
    const reasoning = [{ type: "reasoning" as const, text: "think" }];
    const toolCalls = [call("call-1")];
    expect(orderGeneratedContent({} as never, { text: "P", reasoning, toolCalls })).toBeUndefined();
    expect(reasoning[0]).not.toHaveProperty("blockIndex");
    expect(toolCalls[0]).not.toHaveProperty("blockIndex");
  });

  // provider 没给 id 时规范化补随机 id，content 里的 tool-call 没有对应 id。
  it.each([
    ["missing", {}],
    ["empty", { toolCallId: "" }],
  ])("numbers no block when a tool call id is %s in content", (_label, idField) => {
    const reasoning = [{ type: "reasoning" as const, text: "think" }];
    const toolCalls = [call("generated-id")];
    const content = [
      { type: "reasoning", text: "think" },
      { type: "text", text: "P" },
      { type: "tool-call", toolName: "Read", input: { file_path: "a.txt" }, ...idField },
    ];
    expect(
      orderGeneratedContent({ content } as never, { text: "P", reasoning, toolCalls }),
    ).toBeUndefined();
    expect(reasoning[0]).not.toHaveProperty("blockIndex");
    expect(toolCalls[0]).not.toHaveProperty("blockIndex");
  });
});

function createAnthropicRuntime(input: {
  root: string;
  sessionID: SessionId;
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  modelStreaming: "on" | "off";
}): AgentRuntime {
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "anthropic-messages", baseUrl: "https://reasoning.invalid/v1" },
    }),
  );
  const model = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: createTestModelProperties(),
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: 32_000, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  if (!provider.ok || !model.ok) throw new Error("Invalid model fixture config");
  const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } });
  return new AgentRuntime(
    input.sessionID,
    {
      mode: "build",
      modelStreaming: input.modelStreaming,
      workingDirectory: input.root,
      modelSelection: {
        providerId: createModelProviderId("custom:block-order"),
        modelId: MODEL_ID,
        options: { reasoningLevel: "disabled" },
      },
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      sessionStore: input.store,
      eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
      modelFactory: ({ selection }) =>
        adapter.createModel({
          providerId: selection.providerId,
          modelId: selection.modelId,
          providerConfig: provider.config,
          modelConfig: model.config,
          options: { maxOutputTokens: 32_000, ...selection.options },
        }),
    },
  );
}

function stripCacheControl(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, nested) =>
    key === "cache_control" ? undefined : nested,
  );
}

function anthropicResponse(
  content: Array<Record<string, unknown>>,
  stopReason: string,
  streaming: boolean,
): Response {
  const message = {
    id: "msg_block_order",
    model: MODEL_ID,
    role: "assistant",
    type: "message",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 5 },
    content,
  };
  if (!streaming) {
    return new Response(JSON.stringify(message), {
      headers: { "content-type": "application/json" },
    });
  }
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
  ];
  content.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        },
      );
    } else if (block.type === "text") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      );
    } else {
      events.push(
        { type: "content_block_start", index, content_block: { ...block, input: {} } },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  );
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

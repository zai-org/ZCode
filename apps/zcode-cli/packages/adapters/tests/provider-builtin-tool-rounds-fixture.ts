// 服务端内置工具（analyze_image）多轮回放：真实 GLM 流（脱敏 fixture）经 compat → AI SDK → Runtime，
// 验证下一次请求、持久化顺序和冷恢复回放。背景见 docs/design/v2/model/anthropic-stream-compat.md。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  InMemorySessionEventStore,
  createModelId,
  createModelProviderId,
  createSessionId,
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
import { createTestModelProperties } from "./test-model-format.js";
import { AgentRuntime } from "../../core/src/runtime.js";
const MODEL_ID = createModelId("GLM-5.3");

export const FIXTURE = join(import.meta.dirname, "fixtures", "provider-builtin-analyze-image.sse");

export type WireMessage = { role: string; content: unknown };

export type WireBody = { messages: WireMessage[] };

export function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function plainReply(text: string): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_reply",
        type: "message",
        role: "assistant",
        model: "glm-5.3",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

export function createRuntime(
  root: string,
  sessionID: SessionId,
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>,
  events: InMemorySessionEventStore,
) {
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "anthropic-messages", baseUrl: "https://builtin.invalid/v1" },
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
    sessionID,
    {
      mode: "build",
      modelStreaming: "on",
      workingDirectory: root,
      modelSelection: {
        providerId: createModelProviderId("account:zai-individual-coding-plan"),
        modelId: MODEL_ID,
        options: { reasoningLevel: "disabled" },
      },
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      sessionStore: store,
      eventStore: events,
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

export function eventStream(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export async function openScenario(
  respond: (index: number, fixture: string, body: WireBody) => Response,
  fixturePath = FIXTURE,
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-provider-builtin-"));
  const sessionID = createSessionId("provider-builtin-regression");
  const fixture = await readFile(fixturePath, "utf8");
  const bodies: WireBody[] = [];
  const dbPath = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath });
  const events = new InMemorySessionEventStore({ retention: "unbounded" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = (await new Request(input, init).json()) as WireBody;
    bodies.push(body);
    return respond(bodies.length - 1, fixture, body);
  });
  let runtime = createRuntime(root, sessionID, store, events);
  return {
    bodies,
    events,
    sessionID,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    async coldResume() {
      runtime.beginShutdown();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      runtime = createRuntime(
        root,
        sessionID,
        store,
        new InMemorySessionEventStore({ retention: "unbounded" }),
      );
      await runtime.resumeFromStore();
    },
    async close() {
      runtime.beginShutdown();
      vi.unstubAllGlobals();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

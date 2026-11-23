import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionId,
  createRootTraceContext,
  CompactTrigger,
  ModelErrorCode,
  SessionEventType,
  type Model,
  type ModelRequest,
  type ModelRequestPayload,
  type ModelResult,
} from "@zcode/contracts";
import { TurnMachineImpl } from "../src/agent/turn-machine.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  countContinuePrompts,
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  registerReadOnlyTool,
  requestText,
} from "./runtime-output-token-continuation-test-helpers.js";

const TARGET = "mcp__test__lookup";
const SUCCESS_MESSAGE = "Tool loaded.";
const cases = (["native", "local"] as const).flatMap((mode) =>
  (["off", "on"] as const).map((modelStreaming) => ({ mode, modelStreaming })),
);
const done = (): ModelResult => ({ text: "done", finishReason: "stop", usage: {} });
const search = (): ModelResult => ({
  text: "",
  finishReason: "tool-calls",
  usage: {},
  toolCalls: [{ id: "search", name: "ToolSearch", input: { query: `select:${TARGET}` } }],
});
const isCompact = (request: ModelRequest) =>
  requestText(request.messages).includes("create a detailed summary");
const successCount = (messages: ModelRequest["messages"]) =>
  messages.filter((message) => message.content === SUCCESS_MESSAGE).length;
const withoutCacheControl = (messages: ModelRequest["messages"]) =>
  messages.map(({ cacheControl: _cacheControl, ...message }) => message);

afterEach(() => vi.restoreAllMocks());

function fixture(
  config: Partial<AgentRuntimeConfig>,
  respond: (request: ModelRequest, index: number) => ModelResult,
) {
  const sessionId = createSessionId("toolsearch-request-recording");
  const eventStore = createTestSessionEventStore();
  const requests: ModelRequest[] = [];
  const generateText = async (request: ModelRequest) => {
    requests.push(structuredClone(request));
    return respond(request, requests.length);
  };
  const baseFactory = createTestModelFactory({
    generateText,
    async *streamText(request) {
      const result = await generateText(request);
      for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
      if (result.text) {
        yield { type: "text_start", id: "text" };
        yield { type: "text_delta", id: "text", text: result.text };
        yield { type: "text_end", id: "text" };
      }
      yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
    },
  });
  const wrap = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => wrap(model.bind(options)),
  });
  const registry = createToolRegistry();
  registerReadOnlyTool(registry, TARGET, "unused");
  const entry = registry.get(TARGET)!;
  registry.register(
    {
      ...entry,
      metadata: {
        ...entry.metadata,
        shouldDefer: true,
        mcpPresentation: { serverName: "test", toolName: "lookup" },
      },
    },
    { silentDuplicateWarning: true },
  );
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      titleGeneration: { enabled: false },
      systemPrompt: "Test request recording.",
      toolAllowlist: ["ToolSearch", "DeferredToolCall", TARGET],
      ...config,
    },
    { eventStore, toolRegistry: registry, modelFactory: (input) => wrap(baseFactory(input)) },
  );
  const recordedRequests = async () =>
    (await eventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.ModelRequest)
      .map((event) => event.payload as ModelRequestPayload);
  return { runtime, requests, recordedRequests };
}

it.each(cases)(
  "retains success hints in continuation records and turn snapshots ($mode, streaming=$modelStreaming)",
  async ({ mode, modelStreaming }) => {
    const snapshots = vi.spyOn(TurnMachineImpl.prototype, "startModelRequest");
    const { runtime, requests, recordedRequests } = fixture(
      { toolSearch: { mode }, modelStreaming },
      (_request, index) =>
        index === 1
          ? search()
          : index <= 4
            ? { text: `partial ${index}`, finishReason: "length", usage: {} }
            : done(),
    );
    try {
      await runtime.executeTurn("Search for the lookup tool.");
      await runtime.executeTurn("Continue the task.");
      expect(requests.map((request) => successCount(request.messages))).toEqual(
        mode === "native" ? [0, 1, 1, 1, 1, 1] : [0, 0, 0, 0, 0, 0],
      );
      // Continue 写入历史：下一轮第一个请求仍带着本轮的三条。
      expect(requests.map((request) => countContinuePrompts(request.messages))).toEqual([
        0, 0, 1, 2, 3, 3,
      ]);
      const records = await recordedRequests();
      expect(records).toHaveLength(requests.length);
      for (const [index, request] of requests.entries()) {
        // 记录与实际请求是同一份消息。
        const expected = withoutCacheControl(request.messages);
        expect(withoutCacheControl(records[index]!.messages)).toEqual(expected);
        expect(
          withoutCacheControl(snapshots.mock.results[index]!.value.modelRequest.messages),
        ).toEqual(expected);
      }
      const internal = runtime as unknown as AgentRuntimeInternal;
      expect(JSON.stringify(internal.messageHistory.toRuntimeEntries())).not.toContain(
        SUCCESS_MESSAGE,
      );
      expect(JSON.stringify(records)).not.toContain("loadedToolCallIds");
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);

it.each(
  cases.flatMap((testCase) =>
    (["auto", "reactive"] as const).map((trigger) => ({ ...testCase, trigger })),
  ),
)(
  "retains success hints in $trigger compact records during continuation ($mode, streaming=$modelStreaming)",
  async ({ mode, modelStreaming, trigger }) => {
    let mainCalls = 0;
    const { runtime, requests, recordedRequests } = fixture(
      {
        toolSearch: { mode },
        modelStreaming,
        ...(trigger === "auto"
          ? { compact: { contextWindow: 40000, bufferTokens: 10, summaryReserveTokens: 0 } }
          : {}),
      },
      (request) => {
        if (isCompact(request)) return { ...done(), text: "<summary>Continue the task.</summary>" };
        mainCalls++;
        if (mainCalls === 1) return search();
        if (mainCalls === 4 || mainCalls === 5)
          return {
            text: `partial ${mainCalls}`,
            finishReason: "length",
            usage: {
              inputTokens: trigger === "auto" && mainCalls === 5 ? 39995 : 1,
              outputTokens: 1,
            },
          };
        if (mainCalls === 6 && trigger === "reactive")
          throw Object.assign(new Error("provider context window exceeded"), {
            code: ModelErrorCode.ModelContextExceeded,
          });
        return done();
      },
    );
    try {
      await runtime.executeTurn("Search for the lookup tool.");
      await runtime.executeTurn("Prepare the next step.");
      const result = await runtime.executeTurn("Continue the task.");
      expect(result.response).toBe("done");
      const compactRequests = requests.filter(isCompact);
      expect(compactRequests).toHaveLength(1);
      const actual = compactRequests[0]!;
      // 两次续写让 Continue 进入待总结历史；压缩记录与实际压缩请求是同一份消息。
      expect(countContinuePrompts(actual.messages)).toBeGreaterThan(0);
      expect(successCount(actual.messages)).toBe(mode === "native" ? 1 : 0);
      const records = await recordedRequests();
      expect(records.map((record) => countContinuePrompts(record.messages))).toEqual(
        requests.map((request) => countContinuePrompts(request.messages)),
      );
      const compactRecords = records.filter((record) => record.querySource === "compact");
      expect(compactRecords).toHaveLength(1);
      expect(withoutCacheControl(compactRecords[0]!.messages)).toEqual(
        withoutCacheControl(actual.messages),
      );
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);

it.each(cases)(
  "keeps repeated-search feedback stable in Continue, records and snapshots ($mode/$modelStreaming)",
  async ({ mode, modelStreaming }) => {
    const snapshots = vi.spyOn(TurnMachineImpl.prototype, "startModelRequest");
    const { runtime, requests, recordedRequests } = fixture(
      { toolSearch: { mode }, modelStreaming },
      (_request, index) => {
        if (index === 1) return search();
        if (index === 3)
          return {
            ...search(),
            toolCalls: [{ id: "repeat", name: "ToolSearch", input: { query: "select:lookup" } }],
          };
        if (index === 4) return { text: "partial", finishReason: "length", usage: {} };
        return done();
      },
    );
    try {
      await runtime.executeTurn("Load the lookup tool.");
      await runtime.executeTurn("Find lookup again using its short name.");
      expect(requests.map((r) => successCount(r.messages))).toEqual(
        mode === "local" ? [0, 0, 0, 0, 0] : [0, 1, 1, 2, 2],
      );
      const latest = requests.at(-1)!;
      const repeat = latest.messages.find((m) => m.role === "tool" && m.toolCallId === "repeat");
      expect(JSON.stringify(repeat)).toContain(
        mode === "local" ? "already available" : "tool_reference",
      );
      if (mode === "local") expect(JSON.stringify(repeat)).not.toContain("<functions>");
      const records = await recordedRequests();
      for (const [index, request] of requests.entries()) {
        const expected = withoutCacheControl(request.messages);
        expect(withoutCacheControl(records[index]!.messages)).toEqual(expected);
        expect(
          withoutCacheControl(snapshots.mock.results[index]!.value.modelRequest.messages),
        ).toEqual(expected);
      }
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);

it.each([CompactTrigger.Manual, CompactTrigger.Reactive])(
  "promotes discovery at successful %s compact and keeps it across the next compact",
  async (trigger) => {
    const { runtime, requests } = fixture({ toolSearch: { mode: "local" } }, (request, index) =>
      isCompact(request)
        ? { ...done(), text: "<summary>Continue.</summary>" }
        : index === 1
          ? search()
          : done(),
    );
    try {
      await runtime.executeTurn("Load lookup.");
      await runtime.executeTurn("Keep working.");
      const internal = runtime as unknown as AgentRuntimeInternal;
      for (let pass = 0; pass < 2; pass++) {
        const result = await internal.compactActiveConversation(
          undefined,
          createRootTraceContext(),
          [],
          { trigger },
        );
        expect(result.outcome).toBe("compacted");
        // 返回时公告就应使用提升后的分类，而不是等待下一次正常收集纠正。
        expect(
          result.entries
            .filter((e) => e.metadata?.toolSearchAnnouncement)
            .flatMap((e) => e.metadata!.toolSearchAnnouncement!.addedNames),
        ).not.toContain(TARGET);
        await runtime.executeTurn("Continue after compact.");
        const request = requests.at(-1)!;
        expect(request.tools?.find((t) => t.name === TARGET)).toMatchObject({ name: TARGET });
        expect(request.tools?.find((t) => t.name === TARGET)?.deferLoading).toBeUndefined();
        expect(request.tools?.map((t) => t.name)).toContain("DeferredToolCall");
      }
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);

it.each(["cancel", "persist failure"])(
  "does not promote Local tools on compact %s",
  async (failure) => {
    const controller = new AbortController();
    const { runtime, requests } = fixture({ toolSearch: { mode: "local" } }, (request, index) => {
      if (isCompact(request)) {
        if (failure === "cancel") controller.abort();
        return { ...done(), text: "<summary>Candidate.</summary>" };
      }
      return index === 1 ? search() : done();
    });
    try {
      await runtime.executeTurn("Load lookup.");
      await runtime.executeTurn("Keep working.");
      const internal = runtime as unknown as AgentRuntimeInternal;
      const before = internal.messageHistory.toRuntimeEntries();
      if (failure === "persist failure")
        vi.spyOn(internal, "persistCompactSummary").mockRejectedValue(new Error("persist failed"));
      await expect(
        internal.compactActiveConversation(undefined, createRootTraceContext(), [], {
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(internal.messageHistory.toRuntimeEntries()).toEqual(before);
      await runtime.executeTurn("Still use the search result.");
      expect(requests.at(-1)!.tools?.some((t) => t.name === TARGET)).toBe(false);
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);

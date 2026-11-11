import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  createRootTraceContext,
  type MessagePart,
  type ModelRequest,
  type ModelResult,
  type ToolSearchMode,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { forkStableConversationAtMessage } from "../src/runtime/methods/session-fork.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

it.each(["off", "on"] as const)(
  "persists one target lifecycle and restores wrapper history through fork, modes and compact (stream=%s)",
  async (modelStreaming) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-search-"));
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("local-search-cold");
    let store = await createSqliteSessionStore({ dbPath });
    const savedParts: MessagePart[] = [];
    const savePart = store.savePart.bind(store);
    vi.spyOn(store, "savePart").mockImplementation(async (part, copyFrom) => {
      savedParts.push(structuredClone(part));
      await savePart(part, copyFrom);
    });
    const requests: ModelRequest[] = [];
    const handler = vi.fn(async (input: unknown) => {
      (input as { value: number }).value = 9;
      return input;
    });
    const hook = vi.fn(async () => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, updatedInput: { value: 8 } },
    }));
    let step = 0;
    const respond = async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(structuredClone(request));
      if (JSON.stringify(request.messages).includes("create a detailed summary"))
        return { text: "<summary>Continue the task.</summary>", finishReason: "stop", usage: {} };
      step++;
      const call =
        step === 1
          ? { id: "search", name: "LocalToolSearch", input: { query: "select:Lookup" } }
          : step === 2
            ? {
                id: "invoke",
                name: "DeferredToolCall",
                input: { name: "Lookup", input: { value: 7 } },
              }
            : undefined;
      return {
        text: call ? "" : "done",
        finishReason: call ? "tool-calls" : "stop",
        usage: {},
        ...(call ? { toolCalls: [call] } : {}),
      };
    };
    const baseFactory = createTestModelFactory({
      generateText: respond,
      async *streamText(request) {
        const result = await respond(request);
        for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
        if (result.text) {
          yield { type: "text_start", id: "text" };
          yield { type: "text_delta", id: "text", text: result.text };
          yield { type: "text_end", id: "text" };
        }
        yield { type: "finish", finishReason: result.finishReason, usage: {} };
      },
    });
    const makeRuntime = (mode: ToolSearchMode, id = sessionId) => {
      const registry = createToolRegistry();
      registry.register({
        ...toolSearchToolEntry,
        aliases: undefined,
        metadata: {
          ...toolSearchToolEntry.metadata,
          name: "Lookup",
          shouldDefer: true,
          description: "Lookup value",
        },
        permission: undefined,
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        runtimeInputSchema: undefined,
        outputSchema: {},
        runtimeOutputSchema: undefined,
        formatModelContent: undefined,
        handler,
      });
      return createTestAgentRuntime(
        id,
        {
          toolSearch: { mode },
          modelStreaming,
          mode: "yolo",
          titleGeneration: { enabled: false },
          workspacePath: root,
          toolAllowlist: ["ToolSearch", "DeferredToolCall", "Lookup"],
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          toolRegistry: registry,
          hookRunner: createInMemoryHookRunner({
            hooks: [{ event: "PreToolUse", matcher: "Lookup", callback: hook }],
          }),
          modelFactory: (input) => {
            const model = baseFactory(input);
            return {
              ...model,
              requestCapabilities: {
                toolSearch: { protocolSupported: true, defaultEnabled: true },
              },
            };
          },
        },
      );
    };
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("local-search"),
        slug: "local-search",
        title: "Local search",
        directory: root,
        version: "test",
        time: { created: 1, updated: 1 },
      });
      const runtime = makeRuntime("local");
      await runtime.executeTurn("Find Lookup and call it.");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(3);
      expect(requests[1]!.tools).toEqual(requests[0]!.tools);
      expect(requests[2]!.tools).toEqual(requests[0]!.tools);
      expect(requests[1]!.toolSearchEnabled).toBe(false);
      expect(requests[0]!.tools?.map((tool) => tool.name)).toContain("LocalToolSearch");
      expect(requests[0]!.tools?.map((tool) => tool.name)).not.toContain("ToolSearch");
      expect(requests[1]!.messages.flatMap((message) => message.toolCalls ?? [])).toContainEqual({
        id: "search",
        name: "LocalToolSearch",
        input: { query: "select:Lookup" },
        ...(modelStreaming === "on" ? { blockIndex: 0 } : {}),
      });
      const searchResult = requests[1]!.messages.find((m) => m.toolCallId === "search");
      expect(JSON.stringify(searchResult)).toContain("<functions>");
      expect(requests[2]!.messages.find((m) => m.toolCallId === "search")?.content).toEqual(
        searchResult?.content,
      );
      expect(requests[2]!.messages.find((m) => m.toolCallId === "invoke")?.toolName).toBe(
        "DeferredToolCall",
      );
      expect(
        requests[2]!.messages
          .flatMap((message) => message.toolCalls ?? [])
          .find((call) => call.id === "invoke"),
      ).toEqual({
        id: "invoke",
        name: "DeferredToolCall",
        input: { name: "Lookup", input: { value: 7 } },
        ...(modelStreaming === "on" ? { blockIndex: 0 } : {}),
      });
      expect(
        JSON.stringify(requests[2]!.messages.find((m) => m.toolCallId === "invoke")?.content),
      ).toContain("9");
      expect(JSON.stringify(requests)).not.toContain("modelCallWrapper");
      const rows = await store.messages({ sessionID: sessionId });
      const parts = rows.flatMap((row) => row.parts).filter((part) => part.type === "tool");
      expect(parts).toHaveLength(2);
      expect(parts.find((part) => part.callID === "invoke")).toMatchObject({
        tool: "Lookup",
        metadata: {
          modelCallWrapper: "DeferredToolCall",
        },
        state: { status: "completed", input: { value: 7 } },
      });
      expect(JSON.stringify(parts)).not.toContain("<functions>");
      expect(JSON.stringify(parts)).not.toContain('"modelToolCall"');
      const invocationMessage = rows.find((row) =>
        row.parts.some((part) => part.type === "tool" && part.callID === "invoke"),
      )!;
      for (const [boundary, retained] of [
        [invocationMessage.info.id, false],
        [rows.at(-1)!.info.id, true],
      ] as const) {
        const rewound = new MessageHistoryImpl();
        await hydrateMessageHistoryFromSession({
          history: rewound,
          messages: rows,
          rewindTargetMessageId: boundary,
          branchCutAfterMessageId: rows.at(-1)!.info.id,
        });
        const calls = buildProviderRequestMessages({
          entries: rewound.toRuntimeEntries(),
        }).messages.flatMap((message) => message.toolCalls ?? []);
        expect(calls.some((call) => call.id === "invoke")).toBe(retained);
        if (retained)
          expect(calls.find((call) => call.id === "invoke")).toMatchObject({
            name: "DeferredToolCall",
            input: { name: "Lookup", input: { value: 7 } },
          });
      }
      const liveHistory = (
        runtime as unknown as AgentRuntimeInternal
      ).messageHistory.toRuntimeEntries();
      expect(
        liveHistory
          .flatMap((entry) => (entry.kind === "attachment" ? [] : (entry.message.toolCalls ?? [])))
          .find((call) => call.id === "invoke"),
      ).toMatchObject({
        name: "Lookup",
        input: { value: 7 },
        modelCallWrapper: "DeferredToolCall",
      });
      const invocationParts = savedParts.filter(
        (part) => part.type === "tool" && part.callID === "invoke",
      );
      expect(invocationParts.map((part) => part.type === "tool" && part.state.status)).toEqual([
        "pending",
        "running",
        "completed",
      ]);
      for (const part of invocationParts)
        expect(part).toMatchObject({
          tool: "Lookup",
          metadata: {
            modelCallWrapper: "DeferredToolCall",
          },
        });
      const forkedId = createSessionId("local-search-fork");
      await forkStableConversationAtMessage.call(runtime as unknown as AgentRuntimeInternal, {
        forkedSessionId: forkedId,
        sourceCommandId: "fork-local",
        goalBoundary: { kind: "none" },
        target: {
          productTurnId: "local-turn",
          transcriptTurnId: "local-transcript",
          orderedMessageIds: rows.map((row) => String(row.info.id)),
          boundaryMessageId: String(rows.at(-1)!.info.id),
        },
      });
      await runtime.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      for (const mode of ["native", "off", "local", "off", "native", "local"] as const) {
        const cold = makeRuntime(mode, forkedId);
        await cold.resumeFromStore();
        await cold.executeTurn("Continue without calling tools.");
        const request = requests.at(-1)!;
        const invocation = request.messages
          .flatMap((m) => m.toolCalls ?? [])
          .find((c) => c.name === "DeferredToolCall");
        expect(invocation).toMatchObject({
          name: "DeferredToolCall",
          input: { name: "Lookup", input: { value: 7 } },
        });
        const result = request.messages.find(
          (m) =>
            m.role === "tool" && (m.toolName === "ToolSearch" || m.toolName === "LocalToolSearch"),
        );
        if (mode !== "off")
          expect(result?.toolName).toBe(mode === "local" ? "LocalToolSearch" : "ToolSearch");
        expect(JSON.stringify(result)).toContain(
          mode === "local"
            ? "<functions>"
            : mode === "native"
              ? "tool_reference"
              : "Tool references removed",
        );
        expect(request.tools?.find((t) => t.name === "Lookup")?.deferLoading).toBe(
          mode === "native" ? true : undefined,
        );
        expect(request.tools?.some((t) => t.name === "DeferredToolCall")).toBe(mode === "local");
        expect(handler).toHaveBeenCalledTimes(1);
        if (mode === "local") {
          const internal = cold as unknown as AgentRuntimeInternal;
          expect(
            internal.messageHistory
              .toRuntimeEntries()
              .some(
                (e) =>
                  e.kind !== "attachment" &&
                  JSON.stringify(e.message.content).includes("tool_reference"),
              ),
          ).toBe(true);
        }
        await cold.closeBrowserSession();
      }
      const compacted = makeRuntime("local", forkedId);
      await compacted.resumeFromStore();
      await (compacted as unknown as AgentRuntimeInternal).compactActiveConversation(
        undefined,
        createRootTraceContext({ sessionId: forkedId }),
        [],
        {},
      );
      await compacted.executeTurn("Continue after compact.");
      expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("<functions>");
      expect(requests.at(-1)!.tools?.some((t) => t.name === "Lookup")).toBe(true);
      expect(
        requests.at(-1)!.tools?.find((t) => t.name === "Lookup")?.deferLoading,
      ).toBeUndefined();
      await compacted.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const coldCompacted = makeRuntime("local", forkedId);
      await coldCompacted.resumeFromStore();
      await coldCompacted.executeTurn("Resume the compacted branch.");
      expect(requests.at(-1)!.tools?.find((t) => t.name === "Lookup")).toBeDefined();
      expect(
        requests.at(-1)!.tools?.find((t) => t.name === "Lookup")?.deferLoading,
      ).toBeUndefined();
      const compactedRows = await store.messages({ sessionID: forkedId });
      const promotedForkId = createSessionId("local-promoted-fork");
      await forkStableConversationAtMessage.call(coldCompacted as unknown as AgentRuntimeInternal, {
        forkedSessionId: promotedForkId,
        sourceCommandId: "fork-promoted",
        goalBoundary: { kind: "none" },
        target: {
          productTurnId: "promoted-turn",
          transcriptTurnId: "promoted-transcript",
          orderedMessageIds: compactedRows.map((row) => String(row.info.id)),
          boundaryMessageId: String(compactedRows.at(-1)!.info.id),
        },
      });
      const rewoundBeforeCompact = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({
        history: rewoundBeforeCompact,
        messages: compactedRows,
        rewindTargetMessageId: compactedRows[0]!.info.id,
        branchCutAfterMessageId: compactedRows.at(-1)!.info.id,
      });
      expect(
        rewoundBeforeCompact.toRuntimeEntries().some((entry) => entry.metadata?.compactBoundary),
      ).toBe(false);
      await coldCompacted.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const promotedFork = makeRuntime("local", promotedForkId);
      await promotedFork.resumeFromStore();
      await promotedFork.executeTurn("Continue from the promoted fork.");
      expect(requests.at(-1)!.tools?.find((t) => t.name === "Lookup")).toBeDefined();
      expect(
        requests.at(-1)!.tools?.find((t) => t.name === "Lookup")?.deferLoading,
      ).toBeUndefined();
      await promotedFork.closeBrowserSession();
      // 同一真实 part 重存中间/失败状态，重开 SQLite 后仍恢复原始模型包装调用。
      const completedPart = parts.find((part) => part.callID === "invoke")!;
      for (const status of ["pending", "running", "error"] as const) {
        const state =
          status === "pending"
            ? { status, input: { value: 7 }, raw: "" }
            : status === "running"
              ? { status, input: { value: 7 }, time: { start: 1 } }
              : { status, input: { value: 7 }, error: "target failed", time: { start: 1, end: 2 } };
        await store.savePart({ ...completedPart, state });
        store.close();
        store = await createSqliteSessionStore({ dbPath });
        const restored = makeRuntime("local");
        await restored.resumeFromStore();
        const history = (
          restored as unknown as AgentRuntimeInternal
        ).messageHistory.toRuntimeEntries();
        expect(
          history
            .flatMap((entry) =>
              entry.kind === "attachment" ? [] : (entry.message.toolCalls ?? []),
            )
            .find((call) => call.id === "invoke"),
        ).toMatchObject({
          name: "Lookup",
          input: { value: 7 },
          modelCallWrapper: "DeferredToolCall",
        });
        const result = history.find(
          (entry) => entry.kind !== "attachment" && entry.message.toolCallId === "invoke",
        )?.message;
        expect(result?.toolName).toBe("Lookup");
        expect(result?.modelCallWrapper).toBe("DeferredToolCall");
        expect(JSON.stringify(result?.content)).toContain(
          status === "error" ? "target failed" : "interrupted",
        );
        await restored.closeBrowserSession();
      }
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

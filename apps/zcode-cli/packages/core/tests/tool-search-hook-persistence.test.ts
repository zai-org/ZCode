import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  type MessagePart,
  type Model,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import type { HookCallback } from "../src/hooks/types.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createToolRegistry } from "../src/tool/registry.js";

it.each([
  { streaming: "off" as const, large: false },
  { streaming: "on" as const, large: false },
  { streaming: "off" as const, large: true },
  { streaming: "on" as const, large: true },
])(
  "saves final ToolSearch blocks atomically with the Hook context as a batch attachment and cold resumes (streaming=$streaming, large=$large)",
  async ({ streaming, large }) => {
    const names = large
      ? Array.from({ length: 2_000 }, (_, i) =>
          `mcp__demo__lookup_${String(i).padStart(4, "0")}_`.padEnd(64, "x"),
        )
      : ["TaskOutput", "TodoRead"];
    const discoveredNames = large ? names.slice(0, -1) : names;
    const searchInput = large
      ? { query: "lookup", max_results: -1 }
      : { query: "select:TaskOutput,TodoRead", max_results: 5 };
    const root = await mkdtemp(join(tmpdir(), "zcode-toolsearch-hook-"));
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("toolsearch-hook-cold");
    let store = await createSqliteSessionStore({ dbPath });
    const requests: ModelRequest[] = [];
    const savedParts: MessagePart[] = [];
    const savePart = store.savePart.bind(store);
    // 在既有存储边界观察每次写入，SQLite 写入本身仍由真实 adapter 完成。
    const saveSpy = vi.spyOn(store, "savePart").mockImplementation(async (part, copyFrom) => {
      savedParts.push(structuredClone(part));
      await savePart(part, copyFrom);
    });
    const callback = vi.fn<HookCallback>(async (input) => ({
      hookSpecificOutput: {
        hookEventName: input.hookEventName,
        additionalContext: "ToolSearch hook context",
      },
    }));
    const hookRunner = createInMemoryHookRunner({
      hooks: [{ event: "PostToolUse", matcher: "ToolSearch", callback }],
    });
    const respond = async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              {
                id: "search-hook-real",
                name: "ToolSearch",
                input: searchInput,
              },
            ],
          }
        : { text: "done", finishReason: "stop", usage: {} };
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
        yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
      },
    });
    const wrap = (model: Model): Model => ({
      ...model,
      properties: { ...model.properties, contextWindow: 1_000_000 },
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
      bind: (options) => wrap(model.bind(options)),
    });
    const makeRuntime = () => {
      const registry = createToolRegistry();
      if (large)
        for (const name of names)
          registry.register({
            metadata: {
              name,
              description: "lookup information",
              shouldDefer: true,
              readOnly: true,
              destructive: false,
              concurrentSafe: true,
              sideEffectScope: "none",
            },
            inputSchema: { type: "object", properties: {} },
            outputSchema: { type: "string" },
            handler: async () => "unused",
          });
      return createTestAgentRuntime(
        sessionId,
        {
          toolSearch: { mode: "native" },
          modelStreaming: streaming,
          workingDirectory: root,
          workspacePath: root,
          titleGeneration: { enabled: false },
          toolAllowlist: ["ToolSearch", ...names],
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          hookRunner,
          toolRegistry: registry,
          modelFactory: (input) => wrap(baseFactory(input)),
        },
      );
    };
    // Hook 文本不进 tool result：引用块就是最终内容，Hook 上下文是这批结果之后的附件。
    const finalContent = discoveredNames.map((toolName) => ({ type: "tool_reference", toolName }));
    const hookText = "PostToolUse:ToolSearch hook additional context: ToolSearch hook context";
    let runtime: ReturnType<typeof makeRuntime> | undefined;
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("toolsearch-hook"),
        slug: "toolsearch-hook",
        title: "ToolSearch Hook",
        directory: root,
        version: "test",
        time: { created: 1, updated: 1 },
      });
      runtime = makeRuntime();
      await runtime.executeTurn("Load TaskOutput and TodoRead definitions.");
      expect(requests).toHaveLength(2);
      expect(callback).toHaveBeenCalledOnce();
      expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["ToolSearch"]);
      const assertModelResult = (request: ModelRequest) => {
        expect(request.toolSearchEnabled).toBe(true);
        expect(request.messages.filter((message) => message.role === "tool")).toEqual([
          expect.objectContaining({
            toolCallId: "search-hook-real",
            toolName: "ToolSearch",
            content: finalContent,
          }),
        ]);
        const toolIndex = request.messages.findIndex((message) => message.role === "tool");
        const hookIndexes = request.messages.flatMap((message, index) =>
          JSON.stringify(message.content).includes(hookText) ? [index] : [],
        );
        expect(hookIndexes).toHaveLength(1);
        expect(hookIndexes[0]).toBeGreaterThan(toolIndex);
        expect(request.messages.flatMap((message) => message.toolCalls ?? [])).toContainEqual({
          id: "search-hook-real",
          name: "ToolSearch",
          input: searchInput,
          ...(streaming === "on" ? { blockIndex: 0 } : {}),
        });
        expect(
          request.tools
            ?.filter((tool) => tool.deferLoading)
            .map((tool) => tool.name)
            .sort(),
        ).toEqual([...discoveredNames].sort());
        for (const name of discoveredNames)
          expect(request.tools?.find((tool) => tool.name === name)).toMatchObject({
            deferLoading: true,
            inputSchema: expect.any(Object),
          });
      };
      assertModelResult(requests[1]!);
      const completed = savedParts.filter(
        (part) =>
          part.type === "tool" &&
          part.callID === "search-hook-real" &&
          part.state.status === "completed",
      );
      expect(completed.length).toBeGreaterThan(0);
      // 每一次 completed 写入都必须已包含最终内容，不能先完成后再补引用或 Hook 文本。
      for (const part of completed)
        expect(part).toMatchObject({
          state: { metadata: { schemaVersion: 1, modelContent: finalContent } },
        });
      const assertStoredResult = async () => {
        const rows = await store.messages({ sessionID: sessionId });
        const part = rows
          .flatMap((row) => row.parts)
          .find((part) => part.type === "tool" && part.callID === "search-hook-real");
        expect(part).toMatchObject({
          type: "tool",
          tool: "ToolSearch",
          callID: "search-hook-real",
          state: {
            status: "completed",
            input: searchInput,
            metadata: { schemaVersion: 1, modelContent: finalContent },
          },
        });
      };
      await assertStoredResult();
      await runtime.closeBrowserSession();
      runtime = undefined;
      saveSpy.mockRestore();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      await assertStoredResult();
      runtime = makeRuntime();
      await runtime.resumeFromStore();
      await runtime.executeTurn("Continue after cold startup.");
      expect(requests).toHaveLength(3);
      assertModelResult(requests[2]!);
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      await runtime?.closeBrowserSession();
      saveSpy.mockRestore();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

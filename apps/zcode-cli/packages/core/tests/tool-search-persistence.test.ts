import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  createRootTraceContext,
  type Model,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { forkStableConversationAtMessage } from "../src/runtime/methods/session-fork.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";

it.each([
  { streaming: "off" as const, force: false },
  { streaming: "on" as const, force: false },
  { streaming: "on" as const, force: true },
])(
  "persists real ToolSearch completion and cold resumes ($streaming, force=$force)",
  async ({ streaming, force }) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-toolsearch-"));
    const dbPath = join(root, "session.sqlite");
    let store = await createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("toolsearch-cold");
    const requests: ModelRequest[] = [];
    let requestCount = 0;
    let continuations = 0;
    let codingPlan = !force;
    const respond = async (request: ModelRequest): Promise<ModelResult> => {
      requests.push(request);
      if (JSON.stringify(request.messages).includes("create a detailed summary"))
        return { text: "<summary>Continue the task.</summary>", finishReason: "stop", usage: {} };
      requestCount++;
      if (continuations > 0) {
        continuations--;
        return { text: "partial after cold resume", finishReason: "length", usage: {} };
      }
      return requestCount === 1
        ? {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              {
                id: "search-real",
                name: "ToolSearch",
                input: { query: "select:TaskOutput,TodoRead" },
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
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: codingPlan } },
      bind: (options) => wrap(model.bind(options)),
    });
    const makeRuntime = (forceStartup = false, runtimeSessionId = sessionId) =>
      createTestAgentRuntime(
        runtimeSessionId,
        {
          modelStreaming: streaming,
          toolSearch: { mode: forceStartup ? "native" : codingPlan ? "auto" : "off" },
          titleGeneration: { enabled: false },
          workspacePath: root,
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          modelFactory: (input) => wrap(baseFactory(input)),
        },
      );
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("toolsearch"),
        slug: "toolsearch",
        title: "ToolSearch",
        directory: root,
        version: "test",
        time: { created: 1, updated: 1 },
      });
      const runtime = makeRuntime(force);
      await runtime.executeTurn("Load TaskOutput and TodoRead definitions.");
      expect(requests[0]?.tools?.some((tool) => tool.name === "TaskOutput")).toBe(false);
      expect(requests[1]?.messages.filter((message) => message.role === "tool")).toMatchObject([
        {
          content: [
            { type: "tool_reference", toolName: "TaskOutput" },
            { type: "tool_reference", toolName: "TodoRead" },
          ],
        },
      ]);
      expect(requests[1]?.tools?.find((tool) => tool.name === "TaskOutput")?.deferLoading).toBe(
        true,
      );
      const originalAnnouncements = (runtime as unknown as AgentRuntimeInternal).messageHistory
        .toRuntimeEntries()
        .filter((entry) => entry.metadata?.toolSearchAnnouncement);
      expect(originalAnnouncements).toHaveLength(1);
      expect(originalAnnouncements[0]).toMatchObject({
        kind: "attachment",
        metadata: { source: "tool_search_announcement" },
      });
      expect(
        requests[1]?.messages.filter((message) => message.content === "Tool loaded."),
      ).toHaveLength(1);
      expect(
        JSON.stringify(
          (runtime as unknown as AgentRuntimeInternal).messageHistory.toRuntimeEntries(),
        ),
      ).not.toContain("Tool loaded.");
      const rows = await store.messages({ sessionID: sessionId });
      expect(JSON.stringify(rows)).not.toContain("Tool loaded.");
      const part = rows
        .flatMap((row) => row.parts)
        .find((part) => part.type === "tool" && part.callID === "search-real");
      expect(part).toMatchObject({
        state: {
          status: "completed",
          metadata: {
            schemaVersion: 1,
            modelContent: [
              { type: "tool_reference", toolName: "TaskOutput" },
              { type: "tool_reference", toolName: "TodoRead" },
            ],
          },
        },
      });
      const forkedSessionId = createSessionId("toolsearch-fork");
      await forkStableConversationAtMessage.call(runtime as unknown as AgentRuntimeInternal, {
        forkedSessionId,
        sourceCommandId: "fork-toolsearch",
        goalBoundary: { kind: "none" },
        target: {
          productTurnId: "toolsearch-turn",
          transcriptTurnId: "toolsearch-transcript",
          orderedMessageIds: rows.map((row) => String(row.info.id)),
          boundaryMessageId: String(rows.at(-1)!.info.id),
        },
      });
      await runtime.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const forked = makeRuntime(force, forkedSessionId);
      await forked.resumeFromStore();
      // fork 必须恢复公告本身，而不能只恢复搜索结果后再把已发现工具公告为未加载。
      const forkEntries = (
        forked as unknown as AgentRuntimeInternal
      ).messageHistory.toRuntimeEntries();
      expect(forkEntries.filter((entry) => entry.metadata?.toolSearchAnnouncement)).toEqual(
        originalAnnouncements,
      );
      expect(forkEntries.findIndex((entry) => entry.metadata?.toolSearchAnnouncement)).toBeLessThan(
        forkEntries.findIndex(
          (entry) => entry.kind !== "attachment" && entry.message.role === "tool",
        ),
      );
      expect([
        ...collectDiscoveredTools(
          (forked as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
        ),
      ]).toEqual(["TaskOutput", "TodoRead"]);
      const forkRows = await store.messages({ sessionID: forkedSessionId });
      const forkPart = forkRows
        .flatMap((row) => row.parts)
        .find((part) => part.type === "tool" && part.tool === "ToolSearch");
      expect(forkPart).toMatchObject({
        state: {
          status: "completed",
          metadata: {
            modelContent: [
              { type: "tool_reference", toolName: "TaskOutput" },
              { type: "tool_reference", toolName: "TodoRead" },
            ],
          },
        },
      });
      await forked.executeTurn("Continue from the fork without searching again.");
      expect(requests.at(-1)?.tools?.find((tool) => tool.name === "TaskOutput")?.deferLoading).toBe(
        true,
      );
      expect(
        JSON.stringify(requests.at(-1)?.messages).split(
          "The following deferred tools are now available via ToolSearch.",
        ).length - 1,
      ).toBe(1);
      await forked.closeBrowserSession();
      codingPlan = false;
      const cold = makeRuntime();
      await cold.resumeFromStore();
      expect(
        (cold as unknown as AgentRuntimeInternal).messageHistory
          .toRuntimeEntries()
          .filter((entry) => entry.metadata?.toolSearchAnnouncement),
      ).toEqual(originalAnnouncements);
      expect([
        ...collectDiscoveredTools(
          (cold as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
        ),
      ]).toEqual(["TaskOutput", "TodoRead"]);
      await cold.executeTurn("Continue with the other provider.");
      expect(requests.at(-1)?.toolSearchEnabled).toBe(false);
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
        "The following deferred tools are now available via ToolSearch.",
      );
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('"tool_reference"');
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
        "Tool references removed - tool search not enabled",
      );
      expect([
        ...collectDiscoveredTools(
          (cold as unknown as AgentRuntimeInternal).messageHistory.borrowReadOnlyRuntimeEntries(),
        ),
      ]).toEqual(["TaskOutput", "TodoRead"]);
      const internals = cold as unknown as AgentRuntimeInternal;
      const compact = await internals.compactActiveConversation(
        undefined,
        createRootTraceContext({ sessionId }),
        [],
        {},
      );
      expect(compact.outcome).toBe("compacted");
      const compactRows = await store.messages({ sessionID: sessionId });
      expect(
        compactRows
          .flatMap((row) => row.parts)
          .find((part) => part.type === "compaction" && part.compactBoundary),
      ).toMatchObject({
        compactBoundary: { preCompactDiscoveredTools: ["TaskOutput", "TodoRead"] },
      });
      expect([
        ...collectDiscoveredTools(internals.messageHistory.borrowReadOnlyRuntimeEntries()),
      ]).toEqual(["TaskOutput", "TodoRead"]);
      await cold.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      codingPlan = true;
      const afterCompact = makeRuntime();
      await afterCompact.resumeFromStore();
      const entries = (
        afterCompact as unknown as AgentRuntimeInternal
      ).messageHistory.borrowReadOnlyRuntimeEntries();
      expect([...collectDiscoveredTools(entries)]).toEqual(["TaskOutput", "TodoRead"]);
      expect(
        entries.some((entry) =>
          entry.metadata?.compactBoundary?.preCompactDiscoveredTools?.includes("TaskOutput"),
        ),
      ).toBe(true);
      const coldRequestStart = requests.length;
      continuations = 3;
      await afterCompact.executeTurn("Continue after compact and provider upgrade.");
      expect(requests.at(-1)?.tools?.find((tool) => tool.name === "TaskOutput")?.deferLoading).toBe(
        true,
      );
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("preCompactDiscoveredTools");
      await afterCompact.executeTurn("Next turn after resumed continuation.");
      expect(
        requests
          .slice(coldRequestStart)
          .map(
            (request) =>
              JSON.stringify(request.messages).split(
                "The following deferred tools are now available via ToolSearch.",
              ).length - 1,
          ),
      ).toEqual([1, 1, 1, 1, 1]);
      expect(
        (afterCompact as unknown as AgentRuntimeInternal).messageHistory
          .toRuntimeEntries()
          .filter((entry) => entry.metadata?.toolSearchAnnouncement),
      ).toHaveLength(1);
      // 全库只保留 compact 前后的两条真实公告，三次 Continue 和下一轮输入都不能额外落盘。
      expect(
        (await store.messages({ sessionID: sessionId }))
          .flatMap((row) => row.parts)
          .filter(
            (part) =>
              part.type === "text" &&
              part.text.includes("The following deferred tools are now available via ToolSearch."),
          ),
      ).toHaveLength(2);
      await afterCompact.closeBrowserSession();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

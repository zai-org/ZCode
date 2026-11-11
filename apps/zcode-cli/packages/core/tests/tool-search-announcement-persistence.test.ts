import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createProjectId,
  createRootTraceContext,
  createSessionId,
  ModelErrorCode,
  type Model,
  type ModelRequest,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { forkStableConversationAtMessage } from "../src/runtime/methods/session-fork.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const ANNOUNCEMENT = "The following deferred tools are now available via ToolSearch.";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "toolsearch-announcements-"));
  const dbPath = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId("announcement-persistence");
  const requests: ModelRequest[] = [];
  let exceedNextRequest = false;
  const runtimes: ReturnType<typeof createTestAgentRuntime>[] = [];
  onTestFinished(async () => {
    for (const runtime of runtimes) await runtime.closeBrowserSession();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.createSession({
    id: sessionId,
    projectID: createProjectId("test"),
    slug: "test",
    title: "test",
    directory: root,
    version: "test",
  });
  const base = createTestModelFactory({
    async generateText(request) {
      requests.push(request);
      if (exceedNextRequest) {
        exceedNextRequest = false;
        throw Object.assign(new Error("provider context window exceeded"), {
          code: ModelErrorCode.ModelContextExceeded,
        });
      }
      return {
        text: JSON.stringify(request.messages).includes("create a detailed summary")
          ? "<summary>Continue the task.</summary>"
          : "done",
        finishReason: "stop",
        usage: {},
      };
    },
  });
  const wrap = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => wrap(model.bind(options)),
  });
  const makeRuntime = (id = sessionId) => {
    const runtime = createTestAgentRuntime(
      id,
      {
        toolSearch: { mode: "native" },
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        workspacePath: root,
        toolAllowlist: ["ToolSearch", "Read", "TaskOutput", "TodoRead"],
      },
      {
        sessionStore: store,
        eventStore: createTestSessionEventStore(),
        modelFactory: (input) => wrap(base(input)),
      },
    );
    runtimes.push(runtime);
    return { runtime, internal: runtime as unknown as AgentRuntimeInternal };
  };
  return {
    ...makeRuntime(),
    requests,
    sessionId,
    exceedNextRequest() {
      exceedNextRequest = true;
    },
    get store() {
      return store;
    },
    async reopen(id = sessionId) {
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const next = makeRuntime(id);
      await next.runtime.resumeFromStore();
      return next;
    },
  };
}

function announcements(internal: AgentRuntimeInternal) {
  return internal.messageHistory
    .toRuntimeEntries()
    .filter((e) => e.metadata?.toolSearchAnnouncement);
}

it("restores ordered add/remove/readd facts and forks only the selected prefix", async () => {
  const f = await fixture();
  await f.runtime.executeTurn("first turn");
  const initial = announcements(f.internal);
  const prefix = await f.store.messages({ sessionID: f.sessionId });
  const announcementRow = prefix.find((row) =>
    row.parts.some(
      (part) =>
        part.type === "text" &&
        part.metadata?.runtimeMessage &&
        (part.metadata.runtimeMessage as { toolSearchAnnouncement?: unknown })
          .toolSearchAnnouncement,
    ),
  );
  expect(announcementRow?.info).toMatchObject({
    synthetic: true,
    visibility: "model-only",
    semantics: {
      uiVisibility: "hidden",
      transcriptVisibility: "hidden",
      providerVisibility: "visible",
    },
  });
  const registry = f.internal.getToolRegistry();
  const taskOutput = registry.get("TaskOutput")!;
  registry.unregister("TaskOutput");
  f.internal.invalidateToolCache();
  await f.runtime.executeTurn("tool removed");
  registry.register(taskOutput);
  f.internal.invalidateToolCache();
  await f.runtime.executeTurn("tool restored");
  const original = announcements(f.internal);
  expect(original.map((entry) => entry.metadata?.toolSearchAnnouncement)).toEqual([
    { addedNames: ["TaskOutput", "TodoRead"], removedNames: [], readdedNames: [] },
    { addedNames: [], removedNames: ["TaskOutput"], readdedNames: [] },
    { addedNames: ["TaskOutput"], removedNames: [], readdedNames: ["TaskOutput"] },
  ]);

  const childId = createSessionId("announcement-fork");
  await forkStableConversationAtMessage.call(f.internal, {
    forkedSessionId: childId,
    sourceCommandId: "fork-before-removal",
    goalBoundary: { kind: "none" },
    target: {
      productTurnId: "first-turn",
      transcriptTurnId: "first-transcript",
      orderedMessageIds: prefix.map((row) => String(row.info.id)),
      boundaryMessageId: String(prefix.at(-1)!.info.id),
    },
  });
  const cold = await f.reopen();
  expect(announcements(cold.internal)).toEqual(original);
  await cold.runtime.executeTurn("stable directory after resume");
  expect(announcements(cold.internal)).toEqual(original);
  const wire = JSON.stringify(f.requests.at(-1)?.messages);
  expect(wire.split(ANNOUNCEMENT)).toHaveLength(2);
  expect(wire).not.toContain("addedNames");

  const rewound = new MessageHistoryImpl();
  const allMessages = await f.store.messages({ sessionID: f.sessionId });
  await hydrateMessageHistoryFromSession({
    history: rewound,
    messages: allMessages,
    rewindTargetMessageId: allMessages[prefix.length]!.info.id,
    branchCutAfterMessageId: allMessages.at(-1)!.info.id,
  });
  expect(rewound.toRuntimeEntries().filter((e) => e.metadata?.toolSearchAnnouncement)).toEqual(
    initial,
  );
  const child = await f.reopen(childId);
  expect(announcements(child.internal)).toEqual(initial);
  await child.runtime.executeTurn("continue fork");
  expect(announcements(child.internal)).toEqual(initial);
});

it("restores retained incremental announcements and rebuilt names in their original order", async () => {
  const f = await fixture();
  const registry = f.internal.getToolRegistry();
  const todo = registry.get("TodoRead")!;
  registry.unregister("TodoRead");
  f.internal.invalidateToolCache();
  await f.runtime.executeTurn("first turn");
  await f.runtime.executeTurn("second turn");
  registry.register(todo);
  f.internal.invalidateToolCache();
  f.exceedNextRequest();
  await f.runtime.executeTurn("expanded catalog then reactive compact");
  const original = announcements(f.internal);
  expect(original.map((entry) => entry.metadata?.toolSearchAnnouncement)).toEqual([
    { addedNames: ["TodoRead"], removedNames: [], readdedNames: [] },
    { addedNames: ["TaskOutput"], removedNames: [], readdedNames: [] },
  ]);
  const cold = await f.reopen();
  expect(announcements(cold.internal)).toEqual(original);
  await cold.runtime.executeTurn("continue without redundant announcements");
  expect(announcements(cold.internal)).toEqual(original);
});

it("persists rebuilt compact announcements before the next request and restores them once", async () => {
  const f = await fixture();
  await f.runtime.executeTurn("before compact");
  await f.runtime.executeTurn("more context");
  const result = await f.internal.compactActiveConversation(
    undefined,
    createRootTraceContext(),
    [],
    {},
  );
  expect(result.outcome).toBe("compacted");
  const compactAnnouncements = announcements(f.internal);
  expect(compactAnnouncements).toHaveLength(1);
  const cold = await f.reopen();
  expect(announcements(cold.internal)).toEqual(compactAnnouncements);
  await cold.runtime.executeTurn("continue compacted history");
  expect(announcements(cold.internal)).toEqual(compactAnnouncements);
  expect(JSON.stringify(f.requests.at(-1)?.messages).split(ANNOUNCEMENT)).toHaveLength(2);
  const again = await cold.internal.compactActiveConversation(
    undefined,
    createRootTraceContext(),
    [],
    {},
  );
  expect(again.outcome).toBe("compacted");
  const next = await f.reopen();
  expect(announcements(next.internal)).toEqual(announcements(cold.internal));
});

it("rolls back compact summary when its rebuilt announcement cannot be saved", async () => {
  const f = await fixture();
  await f.runtime.executeTurn("before compact");
  await f.runtime.executeTurn("more context");
  const before = f.internal.messageHistory.toRuntimeEntries();
  const rowsBefore = await f.store.messages({ sessionID: f.sessionId });
  const commit = f.store.commitMessageBundle!.bind(f.store);
  const spy = vi.spyOn(f.store, "commitMessageBundle").mockImplementation(async (bundle) =>
    // 在真实事务内让公告记录写入失败（BigInt 无法序列化），summary 已写入后整组回滚。
    commit({
      ...bundle,
      messages: bundle.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === "text" && part.text.includes(ANNOUNCEMENT)
            ? { ...part, metadata: { ...part.metadata, unserializable: 1n } }
            : part,
        ),
      })),
    }),
  );
  await expect(
    f.internal.compactActiveConversation(undefined, createRootTraceContext(), [], {}),
  ).rejects.toThrow(/BigInt/);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  expect(f.internal.messageHistory.toRuntimeEntries()).toEqual(before);
  const rows = await f.store.messages({ sessionID: f.sessionId });
  expect(
    rows.some((row) =>
      row.parts.some((part) => part.type === "compaction" && part.compactBoundary),
    ),
  ).toBe(false);
  expect(
    rows.filter((row) =>
      row.parts.some((part) => part.type === "text" && part.text.includes(ANNOUNCEMENT)),
    ),
  ).toHaveLength(1);
  expect(rows.map((row) => row.info.id)).toEqual(
    expect.arrayContaining(rowsBefore.map((row) => row.info.id)),
  );
  const cold = await f.reopen();
  expect(announcements(cold.internal)).toEqual(announcements(f.internal));
});

it("does not commit an announcement or send a request when normal reminder persistence fails", async () => {
  const f = await fixture();
  const savePart = f.store.savePart.bind(f.store);
  const spy = vi.spyOn(f.store, "savePart").mockImplementation(async (part) => {
    if (part.type === "text" && part.text.includes(ANNOUNCEMENT)) {
      throw new Error("announcement write failed");
    }
    return savePart(part);
  });
  await expect(f.runtime.executeTurn("start")).rejects.toMatchObject({
    message: "Turn execution failed",
    cause: expect.objectContaining({ message: "announcement write failed" }),
  });
  spy.mockRestore();
  expect(f.requests).toHaveLength(0);
  expect(announcements(f.internal)).toHaveLength(0);
  const rows = await f.store.messages({ sessionID: f.sessionId });
  // 环境、模型等输入附件排在 ToolSearch 公告之前并已落盘；这里只断言公告本身没有提交。
  expect(
    rows.some((row) =>
      row.parts.some((part) => part.type === "text" && part.text.includes(ANNOUNCEMENT)),
    ),
  ).toBe(false);
  const cold = await f.reopen();
  expect(announcements(cold.internal)).toHaveLength(0);
  await cold.runtime.executeTurn("retry");
  expect(announcements(cold.internal)).toHaveLength(1);
});

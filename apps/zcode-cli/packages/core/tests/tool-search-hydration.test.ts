import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  createMessageId,
  createPartId,
  type MessageWithParts,
  type ToolState,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";

it("reopens ordered content, falls back for damaged/old fields, and excludes abandoned branch results", async () => {
  const root = await mkdtemp(join(tmpdir(), "toolsearch-hydration-"));
  const path = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath: path });
  const sessionID = createSessionId("hydrate");
  const blocks = [
    { type: "text", text: "before" },
    { type: "tool_reference", toolName: "WebFetch" },
    { type: "text", text: "after" },
  ];
  const complete = (modelContent?: unknown): ToolState => ({
    status: "completed",
    input: { query: "select:WebFetch" },
    output: "legacy",
    title: "ToolSearch",
    metadata: { schemaVersion: 1, ...(modelContent !== undefined ? { modelContent } : {}) },
    time: { start: 1, end: 2 },
  });
  const message = (id: string, time: number, state: ToolState): MessageWithParts => ({
    info: {
      id: createMessageId(id),
      sessionID,
      role: "assistant",
      parentID: createMessageId("root"),
      time: { created: time },
      mode: "build",
      agent: "test",
      path: { cwd: root, root },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: createPartId(id),
        messageID: createMessageId(id),
        sessionID,
        type: "tool",
        tool: "ToolSearch",
        callID: id,
        state,
      },
    ],
  });
  try {
    await store.createSession({
      id: sessionID,
      projectID: createProjectId("test"),
      slug: "test",
      title: "test",
      directory: root,
      version: "test",
    });
    const records = [
      message("valid", 1, complete(blocks)),
      message("old", 2, complete()),
      message(
        "damaged",
        3,
        complete([{ type: "tool_reference", toolName: "Future", extra: true }]),
      ),
      message("running", 4, {
        status: "running",
        input: { query: "select:Future" },
        time: { start: 4 },
        metadata: { modelContent: [{ type: "tool_reference", toolName: "Future" }] },
      }),
      message("future", 5, complete([{ type: "tool_reference", toolName: "Future" }])),
    ];
    for (const row of records) {
      await store.saveMessage(row.info);
      for (const part of row.parts) await store.savePart(part);
    }
    // 同一 part 再保存仍必须保留有序块。
    await store.savePart(records[0]!.parts[0]!);
    store.close();
    store = await createSqliteSessionStore({ dbPath: path });
    const messages = await store.messages({ sessionID });
    const history = new MessageHistoryImpl();
    const warn = vi.fn();
    await hydrateMessageHistoryFromSession({
      history,
      messages,
      rewindTargetMessageId: createMessageId("future"),
      branchCutAfterMessageId: createMessageId("future"),
      logger: { warn } as never,
    });
    const results = history
      .toRuntimeEntries()
      .filter((entry) => entry.kind !== "attachment" && entry.message.role === "tool");
    expect(results[0]?.message.content).toEqual(blocks);
    expect(results[1]?.message.content).toBe("legacy");
    expect(results[2]?.message.content).toBe("legacy");
    expect(results[3]?.message.isError).toBe(true);
    expect([...collectDiscoveredTools(history.toRuntimeEntries())]).toEqual(["WebFetch"]);
    expect(warn).toHaveBeenCalledOnce();
    const forkHistory = new MessageHistoryImpl();
    await hydrateMessageHistoryFromSession({
      history: forkHistory,
      messages: structuredClone(messages.slice(0, 2)),
    });
    expect([...collectDiscoveredTools(forkHistory.toRuntimeEntries())]).toEqual(["WebFetch"]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { valid: true, delta: { addedNames: ["WebFetch"], removedNames: [], readdedNames: [] } },
  { valid: true, delta: { addedNames: [], removedNames: ["WebFetch"], readdedNames: [] } },
  {
    valid: true,
    delta: { addedNames: ["WebFetch"], removedNames: [], readdedNames: ["WebFetch"] },
  },
  { valid: false, delta: undefined },
  { valid: false, delta: ["WebFetch"] },
  { valid: false, delta: { addedNames: ["WebFetch"], removedNames: [] } },
  {
    valid: false,
    delta: { addedNames: ["WebFetch"], removedNames: [], readdedNames: ["Unannounced"] },
  },
  { valid: false, delta: { addedNames: [12], removedNames: [], readdedNames: [] } },
  { valid: false, delta: { addedNames: [""], removedNames: [], readdedNames: [] } },
  {
    valid: false,
    delta: { addedNames: ["WebFetch"], removedNames: [], readdedNames: [], extra: true },
  },
])("restores only valid persisted announcement metadata: $delta", async ({ delta, valid }) => {
  const history = new MessageHistoryImpl();
  const sessionID = createSessionId("announcement-hydration");
  const messageID = createMessageId("announcement");
  const text = "<system-reminder>original announcement body</system-reminder>";
  await hydrateMessageHistoryFromSession({
    history,
    messages: [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "test",
          tools: {},
        },
        parts: [
          {
            id: createPartId("announcement"),
            messageID,
            sessionID,
            type: "text",
            synthetic: true,
            text,
            metadata: {
              source: "legacy_synthetic",
              runtimeMessage: { source: "legacy_synthetic", toolSearchAnnouncement: delta },
            },
          },
        ],
      },
    ],
  });
  expect(history.toRuntimeEntries()).toEqual([
    valid
      ? {
          kind: "attachment",
          content: "original announcement body",
          metadata: { source: "tool_search_announcement", toolSearchAnnouncement: delta },
          time: 1,
        }
      : {
          message: { role: "user", content: text },
          metadata: { source: "legacy_synthetic" },
          time: 1,
        },
  ]);
  expect([...collectDiscoveredTools(history.toRuntimeEntries())]).toEqual([]);
});

it.each([false, true])(
  "validates MCP metadata independently of the old names delta (damaged: %s)",
  async (damaged) => {
    const history = new MessageHistoryImpl();
    const sessionID = createSessionId("mcp-delta");
    const messageID = createMessageId("names");
    const delta = { addedNames: ["mcp__demo__ping"], removedNames: [], readdedNames: [] };
    const mcpDelta = { mcp: { pending: ["demo"], failed: [] } };
    const messages: MessageWithParts[] = [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "test",
          tools: {},
        },
        parts: [
          {
            id: createPartId("names"),
            messageID,
            sessionID,
            type: "text",
            synthetic: true,
            text: "new tools",
            metadata: {
              runtimeMessage: {
                source: "tool_search_announcement",
                toolSearchAnnouncement: delta,
                toolSearchMcpDelta: damaged ? { mcp: "invalid" } : mcpDelta,
              },
            },
          },
          {
            id: createPartId("retired"),
            messageID,
            sessionID,
            type: "text",
            synthetic: true,
            text: "Call WaitForMcpServers now",
            metadata: { runtimeMessage: { source: "mcp_server_status" } },
          },
        ],
      },
    ];
    const original = structuredClone(messages);
    await hydrateMessageHistoryFromSession({ history, messages });
    const entries = history.toRuntimeEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata?.toolSearchAnnouncement).toEqual(delta);
    expect(entries[0]?.metadata?.toolSearchMcpDelta).toEqual(damaged ? undefined : mcpDelta);
    expect(JSON.stringify(entries)).not.toContain("WaitForMcpServers");
    expect(messages).toEqual(original);
  },
);

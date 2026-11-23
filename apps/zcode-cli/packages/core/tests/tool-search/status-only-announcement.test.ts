import { expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
} from "@zcode/contracts";
import type {
  RuntimeAttachmentEntry,
  RuntimeMessageEntry,
} from "../../src/agent/message-history.js";
import { MessageHistoryImpl } from "../../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../../src/runtime/helpers/provider-request-messages.js";
import { createToolRegistry } from "../../src/tool/registry.js";
import { toolSearchToolEntry } from "../../src/tool/handlers/tool-search.js";
import { todoReadToolEntry } from "../../src/tool/handlers/todo.js";
import { buildToolSearchAnnouncement } from "../../src/tool/search/exposure.js";
import { projectToolReferences } from "../../src/tool/search/history.js";
import { createTestRuntimeModel } from "../test-runtime-model.js";

// 回归：只有状态变化的公告过去也写严格的名称增量（三个空数组）。旧版本按名称数组重新渲染正文，
// 得到空字符串后抛出 "System reminder body cannot be empty"，降级后会话无法继续。
// 现在这类公告只写宽松的 toolSearchMcpDelta；所有读取方按"两个键有其一"识别公告。

function fixture() {
  const registry = createToolRegistry();
  registry.register(toolSearchToolEntry);
  registry.register(todoReadToolEntry);
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  const input = {
    model,
    mode: "native" as const,
    registry,
    tools: registry.toContracts(),
    entries: [] as RuntimeMessageEntry[],
  };
  const names = buildToolSearchAnnouncement(input)!;
  const status = buildToolSearchAnnouncement({
    ...input,
    entries: [names],
    mcp: { pending: ["slow"], failed: [] },
  })!;
  return { input, names, status };
}

/** 修复后的写入形状：没有严格的名称增量，只有 MCP 状态。 */
function statusOnly(entry: RuntimeAttachmentEntry): RuntimeAttachmentEntry {
  const { toolSearchAnnouncement: _names, ...metadata } = entry.metadata;
  return { ...entry, metadata };
}

it("writes status-only announcements without the strict name delta", () => {
  const { names, status } = fixture();
  expect(names.metadata.toolSearchAnnouncement?.addedNames).toEqual(["TodoRead"]);
  expect(status.metadata.source).toBe("tool_search_announcement");
  expect(status.metadata).not.toHaveProperty("toolSearchAnnouncement");
  expect(status.metadata.toolSearchMcpDelta?.mcp).toEqual({ pending: ["slow"], failed: [] });
  expect(status.content).toContain("still connecting");
});

it("keeps status deduplication and later changes after a status-only announcement", () => {
  const { input, names, status } = fixture();
  const entries = [names, statusOnly(status)];
  // 同一状态不重复公告：累积必须读到没有名称增量的这条状态。
  expect(
    buildToolSearchAnnouncement({ ...input, entries, mcp: { pending: ["slow"], failed: [] } }),
  ).toBeUndefined();
  const settled = buildToolSearchAnnouncement({
    ...input,
    entries,
    mcp: { pending: [], failed: [] },
  });
  expect(settled?.metadata.toolSearchMcpDelta?.mcp).toEqual({ pending: [], failed: [] });
});

it("hides status-only announcements in off mode and re-renders them per mode", () => {
  const { names, status: written } = fixture();
  const status = statusOnly(written);
  const entries = [names, status];
  expect(projectToolReferences(entries, "off", []).entries).toEqual([]);
  expect(projectToolReferences(entries, "native", []).entries).toEqual(entries);
  const local = projectToolReferences(entries, "local", []).entries as RuntimeAttachmentEntry[];
  expect(local).toHaveLength(2);
  // 状态段写当前模式的搜索入口名；local 与 native 的入口名不同。
  expect(local[1]!.content).not.toBe(status.content);
  expect(local[1]!.metadata).toEqual(status.metadata);
});

it.each([true, false])(
  "drops an empty status-only attachment from provider messages (MCS: %s)",
  (mcs) => {
    const entry: RuntimeAttachmentEntry = {
      kind: "attachment",
      content: "",
      metadata: {
        source: "tool_search_announcement",
        toolSearchMcpDelta: { mcp: { pending: [], failed: [] } },
      },
    };
    const result = buildProviderRequestMessages({
      entries: [{ message: { role: "user", content: "hi" } }, entry],
      useMidConversationSystem: mcs,
      foldRemindersIntoToolResults: true,
    });
    expect(JSON.stringify(result.messages)).not.toContain("system-reminder");
  },
);

it.each(["status text", ""])(
  "restores a persisted status-only announcement (text: %j)",
  async (text) => {
    const history = new MessageHistoryImpl();
    const sessionID = createSessionId("status-only");
    const messageID = createMessageId("status-only");
    const mcpDelta = { mcp: { pending: [], failed: [{ name: "slow", error: "refused" }] } };
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
            id: createPartId("status-only"),
            messageID,
            sessionID,
            type: "text",
            synthetic: true,
            text,
            metadata: {
              runtimeMessage: { source: "tool_search_announcement", toolSearchMcpDelta: mcpDelta },
            },
          },
        ],
      },
    ];
    await hydrateMessageHistoryFromSession({ history, messages });
    const entries = history.toRuntimeEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "attachment",
      content: text,
      metadata: { source: "tool_search_announcement", toolSearchMcpDelta: mcpDelta },
    });
    expect(entries[0]!.metadata).not.toHaveProperty("toolSearchAnnouncement");
  },
);

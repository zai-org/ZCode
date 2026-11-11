import { describe, expect, it } from "vitest";
import type {
  MessageId,
  MessageWithParts,
  SessionId,
  SessionRevert,
  SessionStorePort,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createSelectionSideConversation } from "../../core/src/runtime/methods/session-fork.js";

const parentId = "fork-sql-parent" as SessionId;
const ids = ["user-first", "assistant-first", "user-next", "assistant-active"] as MessageId[];

function history(): MessageWithParts[] {
  return ids.map((id, index) => {
    const user = index % 2 === 0;
    const time = { created: index + 1, completed: index + 2 };
    return {
      info: {
        id,
        sessionID: parentId,
        role: user ? "user" : "assistant",
        time,
        agent: "build",
        tools: {},
        ...(user
          ? { modelSelection: { providerId: "glm", modelId: "glm-4-air" } }
          : {
              parentID: ids[index - 1],
              providerId: "glm",
              modelId: "glm-4-air",
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
        anchor: {
          origin: user ? "realUser" : "assistant",
          turnId: `turn-${Math.floor(index / 2)}`,
          productTurnId: `product-${Math.floor(index / 2)}`,
        },
      },
      parts: [
        {
          id: `text-${index}`,
          messageID: id,
          sessionID: parentId,
          type: "text",
          text: `body ${id}: ${"large output ".repeat(500)}`,
        },
      ],
    } as MessageWithParts;
  });
}

describe("selection side chat SQLite fork integration", () => {
  it.each(["idle", "active", "rewound"] as const)(
    "copies the correct %s branch with child-local references and complete payloads",
    async (state) => {
      const store = await createSqliteSessionStore({ dbPath: ":memory:" });
      try {
        await store.createSession({
          id: parentId,
          projectID: "project" as never,
          slug: "parent",
          directory: "/workspace",
          title: "parent",
          version: "test",
        });
        const messages = history();
        const assistant = messages[1]!;
        assistant.parts.push({
          id: "tool-first",
          sessionID: parentId,
          messageID: assistant.info.id,
          type: "tool",
          tool: "Read",
          callID: "source-call",
          state: {
            status: "completed",
            input: { source: "user-first" },
            output: "assistant-first body",
            title: "Read",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments: [
              {
                id: "nested-file",
                sessionID: parentId,
                messageID: assistant.info.id,
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,source-call",
              },
            ],
          },
        } as never);
        assistant.parts.push({
          id: "compact-first",
          sessionID: parentId,
          messageID: assistant.info.id,
          type: "compaction",
          auto: false,
          summaryMessageId: assistant.info.id,
          tail_start_id: ids[0],
          metadata: { compactLeadingMessageIds: [ids[0], "outside-old-branch"] },
          compactBoundary: {
            summaryMessageIds: [assistant.info.id],
            lastSummarizedMessageId: ids[0],
            attachmentMessageIds: [ids[0]],
            hookResultMessageIds: [ids[0]],
            preservedSegment: {
              headMessageId: ids[0],
              anchorMessageId: ids[0],
              tailMessageId: assistant.info.id,
            },
            turnId: "turn-0",
          },
        } as never);
        assistant.parts.push({
          id: "timeline-first",
          sessionID: parentId,
          messageID: assistant.info.id,
          type: "timeline",
          timelineType: "context_compaction",
          anchorMessageId: ids[0],
          anchorTurnId: "turn-0",
          summaryMessageId: assistant.info.id,
        } as never);
        for (const message of messages) {
          await store.saveMessage(message.info);
          for (const part of message.parts) await store.savePart(part);
        }
        if (state === "rewound")
          await store.updateSession({
            id: parentId,
            revert: {
              targetMessageID: ids[2],
              keptMessageIDs: ids.slice(0, 2),
              branchCutAfterMessageID: ids[3],
            } as SessionRevert,
          });
        const parentBefore = await store.messages({ sessionID: parentId });
        const measured: SessionStorePort = new Proxy(store, {
          get(target, property) {
            if (property === "messages")
              return () => {
                throw new Error("fork must not read full bodies into JS");
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const runtime = {
          sessionId: parentId,
          sessionStore: measured,
          activeTurn: state === "active" ? { turnId: "turn-1" } : null,
          rootTraceContext: { traceId: "trace-fork-sql" },
          config: { agentName: "build", mode: "build" },
          getSessionModelSelection: () => ({ providerId: "glm", modelId: "glm-4-air" }),
          workingDirectory: "/workspace",
          workspaceRoot: "/workspace",
        };
        const result = await createSelectionSideConversation.call(runtime as never, {
          sourceCommandId: "create-child",
        });
        const child = await store.messages({ sessionID: result.forkedSessionId });
        const count = state === "idle" ? 4 : state === "active" ? 3 : 2;
        expect(result.copiedMessageCount).toBe(count);
        expect(child).toHaveLength(count + 1);
        expect(child.slice(0, count).map((message) => message.info.visibility)).toEqual(
          Array(count).fill("model-only"),
        );
        expect(child.slice(0, count).map((message) => message.parts[0])).toEqual(
          parentBefore.slice(0, count).map((message, index) => ({
            ...message.parts[0],
            id: child[index]!.parts[0]!.id,
            sessionID: result.forkedSessionId,
            messageID: child[index]!.info.id,
          })),
        );
        expect(child[1]!.info).toMatchObject({ parentID: child[0]!.info.id });
        expect(child[0]!.info.anchor?.turnId).not.toBe("turn-0");
        expect(child[1]!.parts[1]).toMatchObject({
          state: {
            input: { source: "user-first" },
            output: "assistant-first body",
            attachments: [
              {
                sessionID: result.forkedSessionId,
                messageID: child[1]!.info.id,
                url: "data:image/png;base64,source-call",
              },
            ],
          },
        });
        expect(child[1]!.parts[1]).not.toMatchObject({ callID: "source-call" });
        expect(child[1]!.parts[2]).toMatchObject({
          summaryMessageId: child[1]!.info.id,
          tail_start_id: child[0]!.info.id,
          metadata: { compactLeadingMessageIds: [child[0]!.info.id] },
          compactBoundary: {
            summaryMessageIds: [child[1]!.info.id],
            preservedSegment: {
              headMessageId: child[0]!.info.id,
              anchorMessageId: child[0]!.info.id,
              tailMessageId: child[1]!.info.id,
            },
          },
        });
        expect(child[1]!.parts[3]).toMatchObject({
          anchorMessageId: child[0]!.info.id,
          anchorTurnId: child[0]!.info.anchor!.turnId,
          summaryMessageId: child[1]!.info.id,
        });
        expect(child.at(-1)!.info).toMatchObject({ source: "selection_side_chat" });
        expect(await store.messages({ sessionID: parentId })).toEqual(parentBefore);
        const duplicate = await createSelectionSideConversation.call(runtime as never, {
          sourceCommandId: "create-child",
        });
        expect(duplicate.forkedSessionId).toBe(result.forkedSessionId);
        expect(await store.messages({ sessionID: result.forkedSessionId })).toEqual(child);
      } finally {
        store.close();
      }
    },
  );
});

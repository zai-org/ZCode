import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createSessionId,
  DEFERRED_TOOL_CALL_NAME,
  SessionEventType,
  type ModelRequest,
  type SessionEvent,
} from "@zcode/contracts";
import { applyConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";
import { createToolRegistry } from "../../core/src/tool/registry.js";
import { toolSearchToolEntry } from "../../core/src/tool/handlers/tool-search.js";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";
import { ConversationTopicPublisher, ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

const TARGET = "DeferredMutation";
const CALL_ID = "interrupted-call";
const INPUT = { value: 7 };

it.each([
  { wrapped: true, inputDeltas: true },
  { wrapped: true, inputDeltas: false },
  { wrapped: false, inputDeltas: true },
])(
  "completed call interrupted before scheduling keeps live and cold identity ($wrapped/$inputDeltas)",
  async ({ wrapped, inputDeltas }) => {
    const root = await mkdtemp(join(tmpdir(), "deferred-display-"));
    const dbPath = join(root, "session.sqlite");
    const sessionId = createSessionId("deferred-display");
    let store = await createSqliteSessionStore({ dbPath });
    const handler = vi.fn(async () => "executed");
    const registry = createToolRegistry();
    registry.register({
      ...toolSearchToolEntry,
      aliases: undefined,
      metadata: {
        ...toolSearchToolEntry.metadata,
        name: TARGET,
        shouldDefer: true,
        readOnly: false,
        concurrentSafe: false,
      },
      inputSchema: { type: "object" },
      runtimeInputSchema: undefined,
      runtimeOutputSchema: undefined,
      outputSchema: {},
      permission: undefined,
      formatModelContent: undefined,
      handler,
    });
    const modelCall = {
      id: CALL_ID,
      name: wrapped ? DEFERRED_TOOL_CALL_NAME : TARGET,
      input: wrapped ? { name: TARGET, input: INPUT } : INPUT,
    };
    const requests: ModelRequest[] = [];
    const makeRuntime = () =>
      createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          toolSearch: { mode: wrapped ? "local" : "off" },
          modelStreaming: "on",
          titleGeneration: { enabled: false },
          workspacePath: root,
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          toolRegistry: registry,
          modelFactory: createTestModelFactory({
            async *streamText(request) {
              requests.push(request);
              if (requests.length === 1) {
                if (inputDeltas) {
                  const json = JSON.stringify(modelCall.input);
                  const half = Math.ceil(json.length / 2);
                  yield { type: "tool_input_start", id: CALL_ID, toolName: modelCall.name };
                  yield { type: "tool_input_delta", id: CALL_ID, delta: json.slice(0, half) };
                  yield { type: "tool_input_delta", id: CALL_ID, delta: json.slice(half) };
                  yield { type: "tool_input_end", id: CALL_ID };
                }
                // 每次产出副本：core 在收到的调用对象上写 blockIndex，不能写回 modelCall。
                yield { type: "tool_call", toolCall: { ...modelCall } };
                throw new Error("Model request timed out.");
              }
              yield { type: "text_delta", text: "done" };
              yield { type: "finish", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
    let runtime = makeRuntime();
    const events: SessionEvent[] = [];
    const publisher = new ConversationTopicPublisher(sessionId, "live");
    const clients = (["continuous", "replayable"] as const).map((deliveryProfile) => {
      const subscription = publisher.subscribe({ connectionId: deliveryProfile, deliveryProfile });
      if (subscription.frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      return {
        subscriptionId: subscription.ack.subscriptionId,
        snapshot: subscription.frame.payload.snapshot,
      };
    });
    runtime.subscribeEvents({
      onSessionEvent: async (event) => {
        events.push(event);
        publisher.ingest(event);
      },
    });
    try {
      await runtime.executeTurn("invoke the deferred tool");
      expect(handler).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === SessionEventType.ToolCallScheduled)).toEqual(
        [],
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.StreamingToolLedgerUpdated,
          payload: expect.objectContaining({
            toolCallId: CALL_ID,
            status: "tool_call_closed",
            toolName: TARGET,
            input: INPUT,
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.ModelStreaming,
          payload: expect.objectContaining({
            kind: "tool_call",
            toolName: modelCall.name,
            input: modelCall.input,
          }),
        }),
      );
      expect(
        requests.at(-1)?.messages.flatMap((message) => message.toolCalls ?? []),
      ).toContainEqual({
        ...modelCall,
        // 流式路径由 core 按到达顺序分配序号，provider 不提供（docs/design/v2/model/assistant-block-order.md）。
        blockIndex: 0,
      });
      const expected = {
        toolCallId: CALL_ID,
        toolName: TARGET,
        input: INPUT,
        inputText: JSON.stringify(INPUT),
        status: "error",
      };
      for (const client of clients) {
        const frame = publisher.flush(client.subscriptionId);
        if (frame?.payload.kind !== "deltas") throw new Error("expected live deltas");
        const snapshot = applyConversationDeltas(client.snapshot, frame.payload.deltas);
        expect(snapshot.rows.window.filter((row) => row.kind === "toolCall")).toEqual([
          expect.objectContaining(expected),
        ]);
      }
      await runtime.closeBrowserSession();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      runtime = makeRuntime();
      await runtime.resumeFromStore();
      const history = (
        runtime as unknown as AgentRuntimeInternal
      ).messageHistory.toRuntimeEntries();
      expect(
        history.flatMap((entry) =>
          entry.kind === "attachment" ? [] : (entry.message.toolCalls ?? []),
        ),
      ).toContainEqual(
        expect.objectContaining({
          id: CALL_ID,
          name: TARGET,
          input: INPUT,
          ...(wrapped ? { modelCallWrapper: DEFERRED_TOOL_CALL_NAME } : {}),
        }),
      );
      const messages = await store.messages({ sessionID: sessionId });
      const cold = new ProductProjection(sessionId, "cold");
      for (const event of synthesizeEventsFromMessages(messages, { sessionId }))
        cold.applyEvent(event);
      expect(cold.getSnapshot().rows.window.filter((row) => row.kind === "toolCall")).toEqual([
        expect.objectContaining(expected),
      ]);
    } finally {
      await runtime.closeBrowserSession();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

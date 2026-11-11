import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createRootTraceContext,
  createSessionId,
  SessionEventType,
  type ModelInputMessage,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory, createTestRuntimeModel } from "./test-runtime-model.js";

const contextBody = "project instructions already counted by sections";
const notificationBody =
  "<task-notification>result one</task-notification>\n\n<task-notification>result two</task-notification>";

describe("new-turn task notification context usage", () => {
  it.each([true, false])(
    "counts the full notification once without recounting sections, MCS=%s",
    (mcs) => {
      const sessionId = createSessionId("notification-usage-sections");
      const runtime = createTestAgentRuntime(
        sessionId,
        {},
        {
          eventStore: createTestSessionEventStore(),
        },
      ) as unknown as AgentRuntimeInternal;
      runtime.latestContextBuildResult = {
        sections: [
          {
            name: "Project instructions",
            source: "request_user_context",
            injectionTarget: "meta_user",
            cacheHint: "stable",
            chars: contextBody.length,
            tokens: 12,
            content: contextBody,
            preview: contextBody,
          },
        ],
        totalChars: contextBody.length,
        totalTokens: 12,
        systemMessages: [],
        metaUserAttachments: [],
      };
      const entries: RuntimeMessageEntry[] = [
        { kind: "attachment", content: contextBody, metadata: { source: "context_prefix" } },
        {
          message: { role: "user", content: "inspect results" },
          metadata: { source: "real_user" },
        },
        { message: { role: "assistant", content: "background launched" } },
        {
          message: { role: "user", content: notificationBody },
          metadata: { source: "legacy_synthetic", inputPresentation: "task_notification" },
        },
      ];
      const projection = buildProviderRequestMessages({ entries, useMidConversationSystem: mcs });
      const before = structuredClone(entries);
      const options = {
        ...projection,
        model: createTestRuntimeModel({
          generateText: async () => ({ text: "done", finishReason: "stop", usage: {} }),
        }),
        tools: [],
        events: [],
        assistantMessageId: createMessageId(),
        traceContext: createRootTraceContext({ sessionId }),
      };
      const snapshot = runtime.buildContextUsageSnapshot(options);
      const notification = projection.messages.at(-1)!;
      expect(notification.content).toContain(
        "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]",
      );
      const expectedMessagesChars = [
        { role: "user", content: "inspect results" },
        { role: "assistant", content: "background launched" },
        { role: "user", content: notification.content },
      ].reduce((sum, message) => sum + JSON.stringify(message).length, 0);
      // 指令按请求里 context_prefix 公告的真实文本计（context-composition.md §3.1），不再按 section 估算。
      const instructionMessage = projection.messages[0]!;
      const expectedInstructionChars = JSON.stringify({
        role: instructionMessage.role,
        content: instructionMessage.content,
      }).length;
      expect(runtime.buildContextUsageBreakdownFromSnapshot(snapshot)).toEqual([
        { source: "meta_user_context", chars: expectedInstructionChars },
        { source: "messages", chars: expectedMessagesChars },
      ]);
      expect(snapshot.totalChars).toBe(expectedInstructionChars + expectedMessagesChars);
      expect(runtime.buildContextUsageSnapshot(options)).toEqual(snapshot);
      expect(entries).toEqual(before);
      expect(projection.diagnostics.latestRealUserMessageIndex).toBe(1);
    },
  );

  it.each([true, false])(
    "publishes notification usage through the real turn loop, MCS=%s",
    async (mcs) => {
      const sessionId = createSessionId(`notification-usage-loop-${mcs}`);
      const eventStore = createTestSessionEventStore();
      const requests: ModelInputMessage[][] = [];
      const runtime = createTestAgentRuntime(
        sessionId,
        {},
        {
          eventStore,
          modelFactory: createTestModelFactory({
            properties: { supportsMidConversationSystem: mcs },
            async generateText(request) {
              requests.push(request.messages);
              return {
                text: "done",
                finishReason: "stop",
                usage: { inputTokens: 100, outputTokens: 1 },
              };
            },
          }),
        },
      );
      await runtime.executeTurn("launch background work");
      (runtime as unknown as AgentRuntimeInternal).enqueueBackgroundTaskNotification({
        text: notificationBody,
        traceContext: createRootTraceContext({ sessionId }),
      });
      await vi.waitFor(async () => {
        const events = await eventStore.getEvents(sessionId);
        expect(
          events.filter((event) => event.type === SessionEventType.ModelComplete),
        ).toHaveLength(2);
      });
      expect(requests).toHaveLength(2);
      const notification = requests[1]!.at(-1)!;
      expect(notification.role).toBe("user");
      // 每条通知各自包装，正文逐条出现在请求里。
      for (const part of notificationBody.split("\n\n")) {
        expect(notification.content).toContain(part);
      }
      expect(JSON.stringify(requests)).not.toContain("sourceEntries");
      const completions = (await eventStore.getEvents(sessionId)).filter(
        (event) => event.type === SessionEventType.ModelComplete,
      );
      const chars = (index: number) =>
        (
          completions[index]!.payload as {
            contextUsageBreakdown: Array<{ source: string; chars: number }>;
          }
        ).contextUsageBreakdown.find((item) => item.source === "messages")!.chars;
      const expectedIncrease =
        JSON.stringify({ role: "assistant", content: "done" }).length +
        JSON.stringify({ role: "user", content: notification.content }).length;
      expect(chars(1) - chars(0)).toBe(expectedIncrease);
      expect(completions[1]!.payload).toMatchObject({
        usage: { inputTokens: 100, outputTokens: 1 },
      });
    },
  );
});

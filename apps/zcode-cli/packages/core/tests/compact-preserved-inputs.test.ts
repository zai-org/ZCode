import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CompactTrigger,
  createMessageId,
  createPartId,
  createRootTraceContext,
  createSessionId,
  createTraceId,
  type MessageWithParts,
  type ModelRequest,
} from "@zcode/contracts";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "../src/agent/session-history-hydrator.js";
import { compactActiveConversation } from "../src/runtime/methods/compact-active.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { selectPersistedCompactTail } from "../src/runtime/helpers/compact-preservation.js";
import {
  createRecordingMessageStore,
  requestText,
  stopResult,
} from "./runtime-output-token-continuation-test-helpers.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const golden = JSON.parse(
  await readFile(new URL("./fixtures/runtime-input-presentation.json", import.meta.url), "utf8"),
);
const inputs = [
  { text: "coordinator payload", inputPresentation: "coordinator_steer" },
  {
    text: '<subagent-message agent-id="child">peer result</subagent-message>',
    inputPresentation: "subagent_reply_steer",
    source: "subagent_message",
  },
  {
    text: "<task-notification>task result</task-notification>",
    inputPresentation: "task_notification_steer",
    source: "background_task",
  },
  { text: "persisted attachment payload", source: "goal_state_change" },
  { text: "legacy synthetic payload", source: "background_task" },
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("compact retained input persistence", () => {
  it("selects rounds from the active branch instead of the newest abandoned assistant", async () => {
    const store = createRecordingMessageStore();
    const sessionId = createSessionId("compact-retained-branch");
    const assistantId = createMessageId("kept-assistant");
    const inputId = createMessageId("kept-synthetic");
    const abandonedId = createMessageId("abandoned-assistant");
    await store.createSession({
      id: sessionId,
      revert: {
        targetMessageID: inputId,
        keptMessageIDs: [assistantId, inputId],
        branchCutAfterMessageID: abandonedId,
      },
    });
    for (const [id, role] of [
      [assistantId, "assistant"],
      [inputId, "user"],
      [abandonedId, "assistant"],
    ]) {
      await store.saveMessage({ id, sessionID: sessionId, role, time: { created: 1 } });
      await store.savePart({
        id: createPartId(),
        messageID: id,
        sessionID: sessionId,
        type: "text",
        text: id,
      });
    }
    const summaryMessageId = createMessageId("next-summary");
    expect(
      await selectPersistedCompactTail({
        sessionStore: store as never,
        sessionId,
        summaryMessageId,
        groupsPreserved: 1,
      }),
    ).toEqual({
      keptMessageCount: 2,
      preservedSegment: {
        headMessageId: assistantId,
        tailMessageId: inputId,
        anchorMessageId: summaryMessageId,
      },
    });
  });

  it.each([true, false])("restores the complete selected tool round with MCS=%s", async (mcs) => {
    const sessionId = createSessionId(`compact-retained-inputs-${mcs}`);
    const store = createRecordingMessageStore();
    const requests: ModelRequest[] = [];
    const config = {
      systemPrompt: "Compact parity test",
      modelStreaming: "off" as const,
      titleGeneration: { enabled: false as const },
    };
    const modelFactory = createTestModelFactory({
      properties: { supportsMidConversationSystem: mcs },
      generateText: async (request) => {
        requests.push(request);
        return stopResult(
          requestText(request.messages).includes("create a detailed summary")
            ? "<summary>older work summary</summary>"
            : "finished",
          10,
        );
      },
    });
    const createRuntime = (sessionStore = store) =>
      createTestAgentRuntime(sessionId, config, {
        sessionStore: sessionStore as never,
        modelFactory,
        eventStore: createTestSessionEventStore(),
      });
    const runtime = createRuntime();
    await runtime.executeTurn("old setup one");
    await runtime.executeTurn("old setup two");
    const assistantId = createMessageId("preserved-tools");
    const assistant = store.savedMessages.findLast((message) => message.role === "assistant");
    await store.saveMessage({ ...assistant, id: assistantId });
    for (const [index, output] of ["read result one", "read result two"].entries()) {
      await store.savePart({
        id: createPartId(),
        messageID: assistantId,
        sessionID: sessionId,
        type: "tool",
        callID: `read-${index}`,
        tool: "Read",
        state: {
          status: "completed",
          input: { file_path: `/read-${index}` },
          output,
          title: "Read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      });
    }
    for (const input of inputs) {
      const id = createMessageId();
      const metadata = { source: input.source, inputPresentation: input.inputPresentation };
      await store.saveMessage({
        id,
        sessionID: sessionId,
        role: "user",
        agent: "test",
        time: { created: Date.now() },
        metadata,
        ...(input.source
          ? { source: input.source, synthetic: true, visibility: "model-only" }
          : {}),
      });
      await store.savePart({
        id: createPartId(),
        messageID: id,
        sessionID: sessionId,
        type: "text",
        text: input.text,
        ...(input.source ? { synthetic: true } : {}),
        metadata,
      });
    }
    // Timeline 的 assistant 只是 UI 控制记录，不能被当成最新模型轮的起点。
    const timelineId = createMessageId("timeline-only");
    await store.saveMessage({
      ...assistant,
      id: timelineId,
      tokens: { input: 0, output: 0, total: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      semantics: {
        origin: "system",
        kind: "timeline_event",
        uiVisibility: "visible",
        providerVisibility: "hidden",
        transcriptVisibility: "visible",
      },
    });
    await store.savePart({
      id: createPartId(),
      messageID: timelineId,
      sessionID: sessionId,
      type: "timeline",
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
    });
    // 从真实持久化形态启动，随后调用实际 compact 写 boundary；不是只复制 entries。
    await runtime.resumeFromStore();
    await compactActiveConversation.call(
      runtime as never,
      undefined,
      createRootTraceContext({ sessionId }),
      [],
      { trigger: CompactTrigger.Auto },
    );
    const persisted = await store.messages();
    const boundary = persisted
      .flatMap((message) => message.parts)
      .find((part) => part.type === "compaction" && part.compactBoundary)?.compactBoundary;
    expect(boundary.preservedSegment.headMessageId).toBe(assistantId);
    expect(boundary.keptMessageCount).toBe(1 + inputs.length);

    const live = (
      runtime as unknown as { messageHistory: MessageHistoryImpl }
    ).messageHistory.toRuntimeEntries();
    const restored = new MessageHistoryImpl();
    restored.init(config.systemPrompt);
    await hydrateMessageHistoryFromSession({ history: restored, messages: persisted });
    const project = (entries: ReturnType<MessageHistoryImpl["toRuntimeEntries"]>) =>
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: mcs,
        applyCacheControl: false,
      }).messages;
    const relevant = (messages: ReturnType<typeof project>) =>
      messages.filter(
        (message) =>
          message.toolCalls?.length ||
          message.role === "tool" ||
          inputs.some((input) => requestText([message]).includes(input.text)),
      );
    expect(relevant(project(restored.toRuntimeEntries()))).toEqual(relevant(project(live)));
    const coldStore = createRecordingMessageStore();
    await coldStore.createSession(structuredClone(await store.getSession(sessionId)));
    coldStore.savedMessages.push(...structuredClone(store.savedMessages));
    coldStore.savedParts.push(...structuredClone(store.savedParts));
    await runtime.executeTurn("compare after compact");
    const liveRequest = requests.at(-1)!;
    const coldRuntime = createRuntime(coldStore);
    await coldRuntime.resumeFromStore();
    await coldRuntime.executeTurn("compare after compact");
    const coldRequest = requests.at(-1)!;
    expect(relevant(coldRequest.messages)).toEqual(relevant(liveRequest.messages));
    for (const request of [liveRequest, coldRequest]) {
      for (const input of inputs) {
        const matches = request.messages.filter((message) =>
          requestText([message]).includes(input.text),
        );
        expect(matches).toHaveLength(1);
        if (input.inputPresentation) {
          const expected = golden.expected[input.inputPresentation].replace("{body}", input.text);
          expect(requestText(matches)).toContain(expected);
          const grouped = inputs
            .filter((item) => item.inputPresentation)
            .map((item) => golden.expected[item.inputPresentation!].replace("{body}", item.text))
            .join("\n\n");
          if (mcs) {
            // 同一段 user run 的 MCS 文本合成一条 system，
            // 放在 run 末尾，越过 legacy user 和本轮输入；中途消息之间保持原顺序。
            expect(matches[0]!.role).toBe("system");
            // 完整组成，块之间一个空行：中途消息在前，之后是本轮请求前公告（agent 列表、环境、
            // 模型身份），最后是保留段里的 goal 状态变更（它不冒泡，后生成的公告越过它）。
            // 只放宽 agent 描述和环境正文。
            expect(requestText(matches)).toMatch(
              new RegExp(
                `^${escapeRegExp(grouped)}\\n\\nAvailable agent types for the Agent tool:\\n[\\s\\S]*\\n\\n# Environment\\n[\\s\\S]*\\n\\nYou are powered by the model named test/default-runtime-model\\.\\n\\npersisted attachment payload$`,
              ),
            );
            expect(request.messages.at(-1)).toBe(matches[0]);
          } else {
            expect(matches[0]!.role).toBe("user");
            expect(requestText(matches)).toBe(`<system-reminder>\n${expected}\n</system-reminder>`);
          }
        }
      }
      expect(request.messages.filter((message) => message.role === "tool")).toHaveLength(2);
      expect(requestText(request.messages)).not.toContain("old setup one");
    }
  });
});

describe("compact leading announcements on cold restore", () => {
  const sessionId = createSessionId("compact-leading");
  const traceId = createTraceId();
  const message = (id: string, role: "user" | "assistant", parts: unknown[] = []) =>
    ({
      info: { id: createMessageId(id), sessionID: sessionId, role, time: { created: 1 } },
      parts,
    }) as unknown as MessageWithParts;
  const summary = (
    id: string,
    preserved: { head: string; tail: string } | undefined,
    metadata?: Record<string, unknown>,
  ) =>
    message(id, "user", [
      {
        id: createPartId(),
        sessionID: sessionId,
        messageID: createMessageId(id),
        type: "compaction",
        auto: true,
        compactBoundary: {
          boundaryId: `boundary-${id}`,
          trigger: CompactTrigger.Auto,
          preCompactTokenCount: 0,
          summarizedMessageCount: 0,
          summaryMessageIds: [createMessageId(id)],
          traceId,
          ...(preserved
            ? {
                preservedSegment: {
                  headMessageId: createMessageId(preserved.head),
                  anchorMessageId: createMessageId(id),
                  tailMessageId: createMessageId(preserved.tail),
                },
              }
            : {}),
        },
        ...(metadata ? { metadata } : {}),
      },
    ]);
  const id = (name: string) => String(createMessageId(name));
  const ids = (messages: MessageWithParts[]) => messages.map((item) => String(item.info.id));

  it("places declared announcements before the summary and leaves older history out", () => {
    const messages = [
      message("old-assistant", "assistant"),
      message("old-result", "user"),
      message("kept-assistant", "assistant"),
      message("kept-result", "user"),
      message("leading-1", "user"),
      summary(
        "summary-1",
        { head: "kept-assistant", tail: "kept-result" },
        { compactLeadingMessageIds: [id("leading-1")] },
      ),
      message("attachment-1", "user"),
    ];
    // 存储顺序与 live 一致：公告在 summary 之前，由 summary 的 compaction part 声明。
    expect(ids(activeSessionMessages(messages))).toEqual(
      ["leading-1", "summary-1", "kept-assistant", "kept-result", "attachment-1"].map(id),
    );
  });

  it("skips earlier announcements when the preserved range crosses an earlier summary", () => {
    // 第一次 compact 保留两轮；第二次只保留最后一轮及第一次的附件，区间在存储中跨过第一次的公告和 summary。
    const messages = [
      message("round-1-assistant", "assistant"),
      message("round-1-result", "user"),
      message("round-3-assistant", "assistant"),
      message("round-3-result", "user"),
      message("round-4-assistant", "assistant"),
      message("round-4-result", "user"),
      message("leading-1", "user"),
      summary(
        "summary-1",
        { head: "round-3-assistant", tail: "round-4-result" },
        { compactLeadingMessageIds: [id("leading-1")] },
      ),
      message("attachment-1", "user"),
      message("leading-2", "user"),
      summary(
        "summary-2",
        { head: "round-4-assistant", tail: "attachment-1" },
        { compactLeadingMessageIds: [id("leading-2")] },
      ),
      message("attachment-2", "user"),
    ];
    expect(ids(activeSessionMessages(messages))).toEqual(
      [
        "leading-2",
        "summary-2",
        "round-4-assistant",
        "round-4-result",
        "attachment-1",
        "attachment-2",
      ].map(id),
    );
  });

  it.each([
    { compactLeadingMessageIds: [id("missing-message"), 7] },
    { compactLeadingMessageIds: id("leading-1") },
    { unrelated: true },
  ])("ignores a malformed or dangling declaration %j", (metadata) => {
    const messages = [
      message("leading-1", "user"),
      summary("summary-1", undefined, metadata),
      message("attachment-1", "user"),
    ];
    expect(ids(activeSessionMessages(messages))).toEqual(["summary-1", "attachment-1"].map(id));
  });
});

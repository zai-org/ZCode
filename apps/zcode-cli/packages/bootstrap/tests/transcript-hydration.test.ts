// M4 transcript→event 合成 golden（13 §9 reduce(transcript) ≡ reduce(events) 的子集）。
import { describe, expect, it } from "vitest";
import {
  CompactTimelineStatus,
  CompactTrigger,
  ModelErrorCode,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  type MessagePart,
  type MessageWithParts,
  type SessionEvent,
} from "@zcode/contracts";
import {
  toolCallGetWorkflowRunDisplaySchema,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { inputIntentMetadata } from "../src/zcode-protocol-v4/commands/input-intent.js";
import {
  eventsCoverTranscript,
  synthesizeEventsFromMessages,
} from "../src/zcode-protocol-v4/transcript-hydration.js";

function userMessage(id: string, text: string, created: number): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "user",
      time: { created },
      agent: "default",
      modelSelection: { providerId: "p" as never, modelId: "m" as never },
    },
    parts: [
      {
        id: `${id}-t` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
      },
    ],
  };
}

function syntheticUserMessage(
  id: string,
  text: string,
  created: number,
  options: {
    metadata?: Record<string, unknown>;
    semantics?: MessageWithParts["info"]["semantics"];
    source?: string;
    visibility?: string;
  } = {},
): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "user",
      time: { created },
      agent: "default",
      modelSelection: { providerId: "p" as never, modelId: "m" as never },
      metadata: options.metadata,
      semantics: options.semantics,
      source: options.source as never,
      synthetic: true,
      visibility: options.visibility as never,
    },
    parts: [
      {
        id: `${id}-t` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
        metadata: options.metadata,
        synthetic: true,
      },
    ],
  };
}

function assistantMessage(
  id: string,
  parentId: string,
  text: string,
  created: number,
  completed = created + 1,
): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "assistant",
      time: { created, completed },
      parentID: parentId as never,
      modelId: "m" as never,
      providerId: "p" as never,
      mode: "default",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `${id}-t` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
      },
    ],
  };
}

function assistantMessageWithParts(
  id: string,
  parentId: string,
  parts: MessagePart[],
  created: number,
): MessageWithParts {
  return {
    ...assistantMessage(id, parentId, "", created),
    parts,
  };
}

function reduce(messages: MessageWithParts[]) {
  const events = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
  const projection = new ProductProjection("s1", "epoch");
  for (const event of events) projection.applyEvent(event);
  return { events, projection };
}

describe("transcript→event 合成", () => {
  it.each([
    { output: "任务完成", expectedType: "frontend-demo" },
    { output: JSON.stringify({ agentType: "Explore" }), expectedType: "Explore" },
  ])(
    "冷恢复从 subagent_type 保留名称且输出显式名称优先: $expectedType",
    ({ output, expectedType }) => {
      const { projection } = reduce([
        userMessage("u-agent-name", "执行任务", 1000),
        assistantMessageWithParts(
          "a-agent-name",
          "u-agent-name",
          [
            {
              id: "part-agent-name" as never,
              sessionID: "s1" as never,
              messageID: "a-agent-name" as never,
              type: "tool",
              callID: "call-agent-name",
              tool: "Agent",
              metadata: {},
              state: {
                status: "completed",
                input: { subagent_type: "frontend-demo", description: "创建示例项目" },
                output,
                title: "创建示例项目",
                metadata: {},
                time: { start: 1001, end: 1002 },
              },
            },
          ],
          1001,
        ),
      ]);
      expect(
        projection.getSnapshot().rows.window.find((row) => row.kind === "subagent"),
      ).toMatchObject({
        parentToolCallId: "call-agent-name",
        subagentType: expectedType,
        status: "success",
      });
    },
  );

  it("冷恢复把缺少完成时间的 orphan assistant 收口为 completedInterrupted", () => {
    const user = userMessage("u-orphan", "执行任务", 1000);
    const orphan = assistantMessage("a-orphan", "u-orphan", "未完成的部分结果", 1001);
    delete orphan.info.time.completed;

    const { events, projection } = reduce([user, orphan]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnComplete,
        payload: expect.objectContaining({ resultType: "cancelled" }),
      }),
    );
    expect(projection.getSnapshot().control.phase).toBe("completedInterrupted");
    expect(projection.getSnapshot().rows.window).toContainEqual(
      expect.objectContaining({ kind: "turnHeader", state: "completedInterrupted" }),
    );
  });

  it("冷恢复从最终 assistant anchor 恢复 query 历史轮次数", () => {
    const user = userMessage("u-round", "问题", 1000);
    user.info.anchor = { sourceCommandId: "query-round" };
    const assistant = assistantMessage("a-round", "u-round", "回答", 1001);
    assistant.info.anchor = { historyRoundCount: 3 };

    const { projection } = reduce([user, assistant]);
    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");

    expect(header).toMatchObject({
      kind: "turnHeader",
      sourceCommandId: "query-round",
      historyRoundCount: 3,
      state: "completedSuccess",
    });
  });

  it("OTC08 cold：持久化 finish=length 的连续正文恢复为一条 assistantText", () => {
    const user = userMessage("u-output-continue", "写一段长回复", 1000);
    const first = assistantMessage("a-output-p1", user.info.id, "即使底层已经", 1001);
    first.info.finish = "length";
    const second = assistantMessage("a-output-p2", user.info.id, "发起新的请求并停在", 1002);
    second.info.finish = "length";
    const final = assistantMessage("a-output-p3", user.info.id, "一个尚未完成的位置。", 1003);
    final.info.finish = "end_turn";

    const { projection } = reduce([user, first, second, final]);
    const snapshot = projection.getSnapshot();
    const assistantRows = snapshot.rows.window.filter((row) => row.kind === "assistantText");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      text: "即使底层已经发起新的请求并停在一个尚未完成的位置。",
      assistantResponseId: "a-output-p3",
      entityId: "a-output-p3",
      state: "complete",
    });
    expect(projection.getMessageIdForRow(assistantRows[0]!.rowId)).toBe("a-output-p3");
    const header = snapshot.rows.window.find((row) => row.kind === "turnHeader");
    expect(projection.getMessageIdsForTurnRow(header!.rowId)).toEqual(
      expect.arrayContaining(["u-output-continue", "a-output-p1", "a-output-p2", "a-output-p3"]),
    );
  });

  it("冷恢复使用调用方注入的当前模型上下文窗口", () => {
    const events = synthesizeEventsFromMessages(
      [
        userMessage("u-context-window", "问题", 1000),
        assistantMessage("a-context-window", "u-context-window", "回答", 1001),
      ],
      { sessionId: "s1", contextWindow: 1_000_000 },
    );

    expect(events.find((event) => event.type === SessionEventType.SessionCreated)?.payload).toEqual(
      {
        mode: "default",
        contextWindow: 1_000_000,
      },
    );
    expect(
      events.find((event) => event.type === SessionEventType.ModelComplete)?.payload,
    ).toMatchObject({ contextWindow: 1_000_000 });
  });

  it("assistant feedback 从 transcript metadata 恢复为权威 row 字段", () => {
    const assistant = assistantMessage("a-feedback", "u-feedback", "回复", 1001);
    assistant.info.metadata = { assistantFeedback: "like" };
    const { events, projection } = reduce([userMessage("u-feedback", "问题", 1000), assistant]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.AssistantFeedbackUpdated,
        payload: { entityId: "a-feedback", feedback: "like" },
      }),
    );
    expect(
      projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "assistantText" && row.entityId === "a-feedback"),
    ).toMatchObject({ feedback: "like" });
    projection.applyEvent({
      id: "feedback-clear" as never,
      sessionId: "s1" as never,
      turnId: events.find((event) => event.type === SessionEventType.TurnStarted)?.turnId,
      type: SessionEventType.AssistantFeedbackUpdated,
      timestamp: new Date(2000),
      traceId: "trace-feedback" as never,
      sequenceNumber: (events.at(-1)?.sequenceNumber ?? 0) + 1,
      payload: { entityId: "a-feedback", feedback: null },
    });
    expect(
      projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "assistantText" && row.entityId === "a-feedback"),
    ).not.toHaveProperty("feedback");
  });

  it("多个文字 part 冷恢复成多行，反馈落在最后一个文字行", () => {
    const assistant = assistantMessage("a-blocks", "u-blocks", "第一段", 1001);
    const firstPart = assistant.parts.find((part) => part.type === "text")!;
    assistant.parts = [
      ...assistant.parts,
      { ...firstPart, id: "a-blocks-second" as never, text: "第二段" },
    ];
    assistant.info.metadata = { assistantFeedback: "like" };
    const { projection } = reduce([userMessage("u-blocks", "问题", 1000), assistant]);

    const rows = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText" && row.entityId === "a-blocks");
    expect(rows.map((row) => (row as { text: string }).text)).toEqual(["第一段", "第二段"]);
    expect(rows[0]).not.toHaveProperty("feedback");
    expect(rows[1]).toMatchObject({ feedback: "like" });
  });

  it("首订阅晚于完成时仍从真实持久化语义恢复 assistant 正文", () => {
    const persistedAssistant = assistantMessage("a1", "u1", "快速首轮回复", 1001);
    const messages = [
      userMessage("u1", "开始", 1000),
      {
        ...persistedAssistant,
        info: {
          ...persistedAssistant.info,
          semantics: {
            origin: "agent_runtime",
            kind: "assistant_response",
            uiVisibility: "visible",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
        } as MessageWithParts["info"],
      },
    ];

    const { events, projection } = reduce(messages);
    const visibleTexts = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "userInput" || row.kind === "assistantText")
      .map((row) => row.text);

    expect(visibleTexts).toEqual(["开始", "快速首轮回复"]);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
  });

  it("user+assistant 文本轮 → userInput + assistantText rows", () => {
    const messages = [
      userMessage("u1", "问题一", 1000),
      assistantMessage("a1", "u1", "回答一", 1001),
      userMessage("u2", "问题二", 2000),
      assistantMessage("a2", "u2", "回答二", 2001),
    ];
    const { events, projection } = reduce(messages);
    const rows = projection.getSnapshot().rows.window;
    const texts = rows
      .filter((r) => r.kind === "userInput" || r.kind === "assistantText")
      .map((r) => (r.kind === "userInput" || r.kind === "assistantText" ? r.text : ""));
    expect(texts).toEqual(["问题一", "回答一", "问题二", "回答二"]);
    // 两轮都 completedSuccess。
    const turnHeaders = rows.filter((r) => r.kind === "turnHeader");
    expect(turnHeaders).toHaveLength(2);
    expect(
      turnHeaders.every((r) => r.kind === "turnHeader" && r.state === "completedSuccess"),
    ).toBe(true);
    const starts = events.filter((event) => event.type === SessionEventType.TurnStarted);
    expect(starts.map((event) => (event.payload as { messageId?: string }).messageId)).toEqual([
      "u1",
      "u2",
    ]);
    const userRows = rows.filter((row) => row.kind === "userInput");
    const assistantRows = rows.filter((row) => row.kind === "assistantText");
    // Bugfix 回归：cold 合成必须保留各 assistant message 的真实创建时间，不能全部
    // 退化成首条 transcript 时间附近的合成序号。
    expect(assistantRows.map((row) => row.createdAt)).toEqual([1001, 2001]);
    expect(userRows[0]?.actions?.canEdit).not.toBe(true);
    expect(userRows[1]?.actions?.canEdit).toBe(true);
    expect(projection.getMessageIdForRow(userRows[1]!.rowId)).toBe("u2");
    expect(projection.getTurnRewindAnchor(userRows[1]!.rowId)).toBe("u2");
  });

  it("canonical assistant 与 interrupted ExitPlanMode 冷恢复后仍保留可见行", () => {
    const assistant = assistantMessageWithParts(
      "a-plan",
      "u-plan",
      [
        {
          id: "a-plan-text" as never,
          sessionID: "s1" as never,
          messageID: "a-plan" as never,
          type: "text",
          text: "计划如下",
        },
        {
          id: "a-plan-tool" as never,
          sessionID: "s1" as never,
          messageID: "a-plan" as never,
          type: "tool",
          callID: "call-plan",
          tool: "ExitPlanMode",
          state: {
            status: "running",
            input: { plan: "# 实施计划\n\n第一步\n第二步" },
            title: "ExitPlanMode",
            time: { start: 1001 },
          },
        },
      ],
      1001,
    );
    assistant.info.semantics = {
      kind: "assistant_response",
      origin: "agent_runtime",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
      uiVisibility: "visible",
    };

    const { projection } = reduce([userMessage("u-plan", "写计划", 1000), assistant]);
    const rows = projection.getSnapshot().rows.window;

    expect(rows.find((row) => row.kind === "assistantText")).toMatchObject({
      text: "计划如下",
      state: "complete",
    });
    expect(rows.find((row) => row.kind === "toolCall")).toMatchObject({
      input: { plan: "# 实施计划\n\n第一步\n第二步" },
      status: "cancelled",
      toolCallId: "call-plan",
      toolName: "ExitPlanMode",
    });
  });

  it("冷恢复为同一 assistant response 的 reasoning、text 与 CUA tool 投影关联 ID", () => {
    const assistant = assistantMessageWithParts(
      "a-cua",
      "u-cua",
      [
        {
          id: "a-cua-reasoning" as never,
          sessionID: "s1" as never,
          messageID: "a-cua" as never,
          type: "reasoning",
          text: "先确认电脑操作权限。",
          time: { start: 1001, end: 1002 },
        },
        {
          id: "a-cua-text" as never,
          sessionID: "s1" as never,
          messageID: "a-cua" as never,
          type: "text",
          text: "我先检查电脑操作权限与应用列表。",
        },
        {
          id: "a-cua-tool" as never,
          sessionID: "s1" as never,
          messageID: "a-cua" as never,
          type: "tool",
          callID: "call-cua",
          tool: "mcp__computer-use__request_access",
          state: {
            status: "running",
            input: {},
            title: "request_access",
            time: { start: 1001 },
          },
        },
      ],
      1001,
    );
    const rows = reduce([
      userMessage("u-cua", "检查权限", 1000),
      assistant,
    ]).projection.getSnapshot().rows.window;

    expect(rows.find((row) => row.kind === "reasoning")?.assistantResponseId).toBe("a-cua");
    expect(rows.find((row) => row.kind === "assistantText")?.assistantResponseId).toBe("a-cua");
    expect(rows.find((row) => row.kind === "toolCall")?.assistantResponseId).toBe("a-cua");
  });

  it("legacy /compact 缺 visibility 时由 CLI hydration 归一化，不下发 visible user row", () => {
    const compactHost = assistantMessageWithParts(
      "a-compact-legacy",
      "u-compact-legacy",
      [
        {
          id: "a-compact-legacy-part" as never,
          sessionID: "s1" as never,
          messageID: "a-compact-legacy" as never,
          type: "timeline",
          timelineType: "context_compaction",
          display: "separator",
          status: CompactTimelineStatus.Completed,
          operationId: "cmp-legacy",
          trigger: CompactTrigger.Manual,
        },
      ],
      1001,
    );
    const { projection } = reduce([
      userMessage("u-compact-legacy", "/compact keep recent files", 1000),
      compactHost,
    ]);
    const rows = projection.getSnapshot().rows.window;

    expect(rows.some((row) => row.kind === "userInput")).toBe(false);
    expect(rows.some((row) => row.kind === "timelineMarker" && row.marker.type === "compact")).toBe(
      true,
    );
  });

  it.each([
    {
      name: "tool-only",
      assistant: assistantMessageWithParts(
        "a-tool",
        "u-latest",
        [
          {
            id: "a-tool-part" as never,
            sessionID: "s1" as never,
            messageID: "a-tool" as never,
            type: "tool" as const,
            callID: "call-read",
            tool: "Read",
            state: {
              status: "completed" as const,
              input: { file_path: "README.md" },
              output: "ok",
              title: "Read README.md",
              metadata: {},
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    },
    {
      name: "empty assistant",
      assistant: assistantMessage("a-empty", "u-latest", "", 1001),
    },
    {
      name: "failed before first token",
      assistant: {
        ...assistantMessage("a-failed", "u-latest", "", 1001),
        info: {
          ...assistantMessage("a-failed", "u-latest", "", 1001).info,
          error: { name: "ProviderError" },
        },
      } satisfies MessageWithParts,
    },
  ])("cold $name：latest real user 保持可编辑且 target 可解析", ({ assistant }) => {
    const { projection } = reduce([userMessage("u-latest", "继续", 1000), assistant]);
    const rows = projection.getSnapshot().rows.window;
    const userRow = rows.find((row) => row.kind === "userInput");
    expect(userRow?.actions?.canEdit).toBe(true);
    expect(projection.isLatestEditableUserRow(userRow!.rowId)).toBe(true);
    expect(projection.getMessageIdForRow(userRow!.rowId)).toBe("u-latest");
    expect(projection.getTurnRewindAnchor(userRow!.rowId)).toBe("u-latest");
    expect(rows.some((row) => row.actions?.canRetry === true)).toBe(false);
  });

  it.each([true, false])(
    "cold first-token failure restores retryable=%s from the structured runtime error",
    (retryable) => {
      const failed = assistantMessage("a-failed-structured", "u-failed", "", 1001);
      const { projection } = reduce([
        userMessage("u-failed", "trigger failure", 1000),
        {
          ...failed,
          info: {
            ...failed.info,
            error: {
              name: "ProviderError",
              data: { message: "rate limited before first token", retryable },
            },
          },
        } satisfies MessageWithParts,
      ]);

      expect(projection.getSnapshot().control.lastError).toMatchObject({
        code: "ProviderError",
        message: "rate limited before first token",
        recoverable: retryable,
        source: "runtime",
      });
    },
  );

  it("cold first-token failure restores the same structured attribution as live TurnError", () => {
    const failed = assistantMessage("a-failed-attribution", "u-failed-attribution", "", 1001);
    const { events, projection } = reduce([
      userMessage("u-failed-attribution", "trigger network failure", 1000),
      {
        ...failed,
        info: {
          ...failed.info,
          error: {
            name: "AiSdkModelAdapterError",
            data: {
              message: "Provider stream failed",
              attribution: {
                source: "network",
                reason: "network_error",
                errorPhase: "stream",
                exceptionKind: "transport",
                providerId: "default-deepseek",
                modelId: "deepseek-v4-flash",
                providerKind: "anthropic",
                transport: "sse",
                statusCode: 503,
                retryable: true,
              },
            },
          },
        },
      } satisfies MessageWithParts,
    ]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnError,
        payload: expect.objectContaining({
          error: expect.objectContaining({
            attribution: expect.objectContaining({
              source: "network",
              reason: "network_error",
              errorPhase: "stream",
              exceptionKind: "transport",
              transport: "sse",
            }),
          }),
        }),
      }),
    );
    expect(projection.getSnapshot().control.lastError).toMatchObject({
      source: "network",
      attribution: {
        source: "network",
        reason: "network_error",
        errorPhase: "stream",
        exceptionKind: "transport",
        providerId: "default-deepseek",
        modelId: "deepseek-v4-flash",
        providerKind: "anthropic",
        transport: "sse",
        statusCode: 503,
        retryable: true,
      },
    });
  });

  it("cold empty output-limit exhaustion restores only its error state", () => {
    const failed = assistantMessage("a-output-limit", "u-output-limit", "", 1001);
    const { events, projection } = reduce([
      userMessage("u-output-limit", "exhaust output continuation", 1000),
      {
        ...failed,
        info: {
          ...failed.info,
          error: {
            name: "model_output_limit_exceeded",
            data: {
              code: "model_output_limit_exceeded",
              message: "The model's response exceeded the output token maximum.",
              retryable: true,
              attribution: {
                source: "provider",
                reason: "model_output_limit_exceeded",
                providerErrorCode: "model_output_limit_exceeded",
              },
            },
          },
        },
      } satisfies MessageWithParts,
    ]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnError,
        payload: expect.objectContaining({
          error: expect.objectContaining({
            type: "model_output_limit_exceeded",
            message: "The model's response exceeded the output token maximum.",
            retryable: true,
            attribution: expect.objectContaining({ source: "provider" }),
          }),
        }),
      }),
    );
    const snapshot = projection.getSnapshot();
    expect(snapshot.rows.window.some((row) => row.kind === "assistantText")).toBe(false);
    expect(snapshot.control.lastError).toMatchObject({
      code: "model_output_limit_exceeded",
      message: "The model's response exceeded the output token maximum.",
      recoverable: true,
      source: "provider",
    });
  });

  it.each([
    {
      name: "typed cancellation",
      error: {
        name: "AiSdkModelAdapterError",
        data: {
          code: ModelErrorCode.ModelRequestCancelled,
          message: "Model request was cancelled.",
          turnResult: "cancelled",
        },
      },
    },
    {
      name: "legacy canonical cancellation",
      error: {
        name: "AiSdkModelAdapterError",
        data: { message: "Model request was cancelled." },
      },
    },
    {
      name: "legacy protocol session stop",
      error: {
        name: "Error",
        data: { message: "ZCode Protocol session stopped" },
      },
    },
  ])("cold $name restores interrupted completion instead of TurnError", ({ error }) => {
    const cancelled = assistantMessage("a-cancelled", "u-cancelled", "partial", 1001);
    const { events, projection } = reduce([
      userMessage("u-cancelled", "stop this turn", 1000),
      {
        ...cancelled,
        info: { ...cancelled.info, error },
      } satisfies MessageWithParts,
    ]);

    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnComplete,
        payload: expect.objectContaining({ resultType: "cancelled", historyRoundCount: 1 }),
      }),
    );
    expect(projection.getSnapshot().control).toMatchObject({
      phase: "completedInterrupted",
      lastError: null,
    });
    expect(projection.getSnapshot().rows.window).toContainEqual(
      expect.objectContaining({ kind: "turnHeader", state: "completedInterrupted" }),
    );
  });

  it("cold restores a stop after the final text as cancelled when the interrupt marker follows", () => {
    // 最终文本已完整输出后再停止：assistant 是 finish=stop、没有 error，只有中断标记记录停止事实。
    const answer = assistantMessage("a-final", "u-final", "complete final answer", 1001);
    const runtimeMessage = { source: "interrupt_marker" };
    const { events, projection } = reduce([
      userMessage("u-final", "question", 1000),
      { ...answer, info: { ...answer.info, finish: "stop" } } satisfies MessageWithParts,
      syntheticUserMessage("m-interrupt", "[Request interrupted by user]", 1003, {
        metadata: { runtimeMessage, source: "interrupt_marker", visibility: "model-only" },
        semantics: {
          origin: "agent_runtime",
          kind: "system_reminder",
          source: "interrupt_marker",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        visibility: "model-only",
      }),
    ]);

    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnComplete,
        payload: expect.objectContaining({ resultType: "cancelled" }),
      }),
    );
    expect(projection.getSnapshot().control.phase).toBe("completedInterrupted");
  });

  function streamRecoveryDiscardedMessage(id: string, parentId: string, created: number) {
    const discarded = assistantMessage(id, parentId, "partial output", created);
    return {
      ...discarded,
      info: {
        ...discarded.info,
        finish: STREAM_RECOVERY_DISCARDED_FINISH,
        error: {
          name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
          data: {
            message: "Partial assistant output was discarded before a streaming retry.",
            retryNumber: 1,
          },
        },
      },
    } satisfies MessageWithParts;
  }

  it("cold stream recovery discard followed by a recovered answer restores success, not TurnError", () => {
    const { events, projection } = reduce([
      userMessage("u-recover", "keep going", 1000),
      streamRecoveryDiscardedMessage("a-discarded", "u-recover", 1001),
      assistantMessage("a-recovered", "u-recover", "final answer", 1003),
    ]);

    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnComplete,
        payload: expect.objectContaining({ resultType: "success", historyRoundCount: 2 }),
      }),
    );
    const control = projection.getSnapshot().control;
    expect(control.lastError).toBeNull();
    expect(control.phase).not.toBe("error");
    expect(projection.getSnapshot().rows.window).toContainEqual(
      expect.objectContaining({ kind: "assistantText", text: "final answer" }),
    );
  });

  it("cold stream recovery discard without a recovered answer restores interrupted completion", () => {
    const { events, projection } = reduce([
      userMessage("u-recover-lost", "keep going", 1000),
      streamRecoveryDiscardedMessage("a-discarded-last", "u-recover-lost", 1001),
    ]);

    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.TurnComplete,
        payload: expect.objectContaining({ resultType: "cancelled" }),
      }),
    );
    expect(projection.getSnapshot().control).toMatchObject({
      phase: "completedInterrupted",
      lastError: null,
    });
  });

  it("does not suppress a typed provider failure that reuses the cancellation message", () => {
    const failed = assistantMessage("a-failed-cancel-text", "u-failed-cancel-text", "", 1001);
    const { events, projection } = reduce([
      userMessage("u-failed-cancel-text", "trigger provider failure", 1000),
      {
        ...failed,
        info: {
          ...failed.info,
          error: {
            name: "AiSdkModelAdapterError",
            data: {
              code: ModelErrorCode.ModelRequestFailed,
              message: "Model request was cancelled.",
            },
          },
        },
      } satisfies MessageWithParts,
    ]);

    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(true);
    expect(projection.getSnapshot().control).toMatchObject({
      phase: "error",
      lastError: {
        code: "AiSdkModelAdapterError",
        message: "Model request was cancelled.",
      },
    });
  });

  it("live/cold goal use persisted canonical intent text instead of visible command text", () => {
    const goalInput = userMessage("u-goal", "/GoAl replace X", 1000);
    goalInput.info.anchor = { sourceCommandId: "command-goal" };
    goalInput.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "command-goal",
        queueItemId: "queue_command-goal",
        clientId: "desktop-goal",
        kind: "sendGoalCommand",
        text: "X",
        attachments: [],
        delivery: { requested: "startNow", admitted: "startNow" },
        order: { admissionSeq: 3 },
        steer: { state: "notRequested" },
        dispatch: { state: "drained" },
        admittedAt: 999,
      },
    };
    const { projection: cold } = reduce([
      goalInput,
      assistantMessage("a-goal", "u-goal", "working on it", 1001),
    ]);
    const row = cold.getSnapshot().rows.window.find((candidate) => candidate.kind === "userInput");
    const envelope = {
      type: "sendGoalCommand",
      payload: { text: "X", displayText: "/GoAl replace X" },
      sessionId: "s1",
      commandId: "command-goal",
      clientId: "desktop-goal",
      baseRevision: 0,
      __v4Admission: {
        admissionSeq: 3,
        admittedAt: 999,
        queueItemId: "queue_command-goal",
      },
    } as unknown as CommandEnvelope;
    const liveIntent = inputIntentMetadata(envelope, {
      requestedDelivery: "startNow",
      text: "X",
    });
    const live = new ProductProjection("s1", "epoch-live");
    live.applyEvent({
      id: "live-goal" as never,
      sessionId: "s1" as never,
      turnId: "runtime-goal" as never,
      type: SessionEventType.TurnStarted,
      timestamp: new Date(1000),
      traceId: "live-goal-trace" as never,
      sequenceNumber: 1,
      payload: {
        turnNumber: 1,
        input: "/GoAl replace X",
        messageId: "u-goal",
        inputId: "command-goal",
        intent: liveIntent,
      },
    });

    expect(row).toMatchObject({
      entityId: "u-goal",
      productTurnId: "u-goal",
      sourceCommandId: "command-goal",
      actions: { canEdit: true },
    });
    const coldTarget = cold.resolveEditTargetByEntityId("u-goal");
    const liveTarget = live.resolveEditTargetByEntityId("u-goal");
    expect(liveTarget).toEqual(coldTarget);
    expect(liveTarget).toMatchObject({
      coveredByStableCompact: false,
      entityId: "u-goal",
      productTurnId: "u-goal",
      transcriptMessageId: "u-goal",
      intent: {
        clientId: "desktop-goal",
        kind: "sendGoalCommand",
        sourceCommandId: "command-goal",
        text: "X",
      },
    });
  });

  it("cold hydration preserves the canonical sending session source without parsing message text", () => {
    const input = userMessage("u-session-source", "普通正文，不含来源提示", 1000);
    const source = { kind: "session", sessionId: "source-session", title: "来源会话" } as const;
    input.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "command-session-source",
        queueItemId: "queue-session-source",
        clientId: "host-caller",
        kind: "sendText",
        text: input.parts[0]!.type === "text" ? input.parts[0]!.text : "",
        attachments: [],
        delivery: { requested: "queue", admitted: "startNow" },
        order: { admissionSeq: 1 },
        steer: { state: "notRequested" },
        dispatch: { state: "drained" },
        admittedAt: 999,
        source,
      },
    };
    const { projection } = reduce([
      input,
      assistantMessage("a-session-source", "u-session-source", "收到", 1001),
    ]);
    expect(projection.getSnapshot().rows.window).toContainEqual(
      expect.objectContaining({ kind: "userInput", text: "普通正文，不含来源提示", source }),
    );
  });

  it("cold hydration projects persisted highspeed metadata onto the user input row", () => {
    const input = userMessage("u-highspeed", "accelerated prompt", 1000);
    input.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "command-highspeed",
        queueItemId: "queue-highspeed",
        clientId: "desktop-highspeed",
        kind: "sendText",
        text: "accelerated prompt",
        attachments: [],
        delivery: { requested: "startNow", admitted: "startNow" },
        order: { admissionSeq: 5 },
        steer: { state: "notRequested" },
        dispatch: { state: "drained" },
        admittedAt: 1000,
        highspeed: {
          schemaVersion: 1,
          ownerKey: `v1:${"a".repeat(64)}`,
          cardId: "hsc-persisted",
          taskId: "s1",
          provider: "zai",
          model: "glm-5",
          issuedAt: 900,
          expiresAt: 1900,
          regularTps: 73,
          outputTokens: 120_000,
          durationMs: 881_000,
          savedDurationMs: 762_836,
          // CR-02：fallbackAt 是权威 metadata 字段，cold hydration 必须原样恢复。
          fallbackAt: 1500,
        },
      },
    };

    const { projection } = reduce([
      input,
      assistantMessage("a-highspeed", "u-highspeed", "accelerated answer", 1001),
    ]);

    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "userInput"),
    ).toMatchObject({
      sourceCommandId: "command-highspeed",
      highspeed: {
        schemaVersion: 1,
        ownerKey: `v1:${"a".repeat(64)}`,
        cardId: "hsc-persisted",
        taskId: "s1",
        provider: "zai",
        model: "glm-5",
        issuedAt: 900,
        expiresAt: 1900,
        regularTps: 73,
        outputTokens: 120_000,
        durationMs: 881_000,
        savedDurationMs: 762_836,
        fallbackAt: 1500,
      },
    });

    const turnId = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader")?.turnId;
    projection.applyEvent({
      id: "highspeed-metrics-update" as never,
      sessionId: "s1" as never,
      turnId,
      type: SessionEventType.HighspeedMetricsUpdated,
      timestamp: new Date(2000),
      traceId: "trace-highspeed" as never,
      sequenceNumber: 99,
      payload: {
        entityId: "u-highspeed",
        highspeed: {
          schemaVersion: 1,
          cardId: "hsc-persisted",
          taskId: "s1",
          provider: "zai",
          model: "glm-5",
          issuedAt: 900,
          expiresAt: 1900,
          regularTps: 73,
          outputTokens: 130_000,
          durationMs: 900_000,
          savedDurationMs: 880_822,
        },
      },
    });
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "userInput"),
    ).toMatchObject({
      // CR-02：终态指标更新是字段级合并，不含 fallbackAt 的 payload 不得清掉已持久化的 fallbackAt。
      highspeed: { outputTokens: 130_000, savedDurationMs: 880_822, fallbackAt: 1500 },
    });
  });

  it("cold retry intent preserves original cause provenance", () => {
    const retried = userMessage("u-retry", "original text", 1000);
    retried.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "command-retry",
        queueItemId: "queue-retry",
        clientId: "desktop-new",
        kind: "sendText",
        text: "original text",
        attachments: [],
        delivery: { requested: "guide", admitted: "queue" },
        order: { admissionSeq: 4 },
        steer: {
          state: "fellBack",
          reasonCode: "guide.attachmentsUnsupported",
        },
        dispatch: { state: "drained" },
        admittedAt: 1000,
        provenance: {
          sourceCommandId: "command-original",
          queueItemId: "queue-original",
          clientId: "desktop-original",
        },
      },
    };
    const { projection } = reduce([
      retried,
      assistantMessage("a-retry", "u-retry", "answer", 1001),
    ]);

    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "userInput"),
    ).toMatchObject({
      sourceCommandId: "command-retry",
      rootSourceCommandId: "command-original",
    });
    expect(projection.resolveEditTargetByEntityId("u-retry")).toMatchObject({
      intent: {
        sourceCommandId: "command-retry",
        provenance: {
          sourceCommandId: "command-original",
          queueItemId: "queue-original",
          clientId: "desktop-original",
        },
      },
    });
  });

  it("cold compact boundary marks only its stable message coverage in the edit target", () => {
    const compactHost = assistantMessageWithParts(
      "a-compact",
      "u-compact",
      [
        {
          id: "compact-boundary-part" as never,
          sessionID: "s1" as never,
          messageID: "a-compact" as never,
          type: "compaction",
          auto: false,
          operationId: "compact-operation",
          timelineStatus: CompactTimelineStatus.Completed,
          tail_start_id: "u-compact" as never,
        },
      ],
      1001,
    );
    const { projection } = reduce([userMessage("u-compact", "covered input", 1000), compactHost]);
    const row = projection
      .getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "userInput");

    expect(projection.resolveEditTarget(row!.rowId)).toMatchObject({
      transcriptMessageId: "u-compact",
      coveredByStableCompact: true,
    });
  });

  it("cold compact prefers the durable coverage boundary over an earlier timeline part", () => {
    const compactHost = assistantMessageWithParts(
      "a-compact-durable",
      "u-compact-durable",
      [
        {
          id: "compact-timeline-first" as never,
          sessionID: "s1" as never,
          messageID: "a-compact-durable" as never,
          type: "timeline",
          timelineType: "context_compaction",
          display: "separator",
          status: CompactTimelineStatus.Completed,
          operationId: "compact-operation-durable",
          trigger: CompactTrigger.Manual,
        },
        {
          id: "compact-durable-second" as never,
          sessionID: "s1" as never,
          messageID: "a-compact-durable" as never,
          type: "compaction",
          auto: false,
          operationId: "compact-operation-durable",
          tail_start_id: "u-compact-durable" as never,
        },
      ],
      1001,
    );

    const { events } = reduce([
      userMessage("u-compact-durable", "covered input", 1000),
      compactHost,
    ]);
    const completed = events.find((event) => event.type === SessionEventType.CompactCompleted);

    expect(completed?.payload).toMatchObject({
      operationId: "compact-operation-durable",
      tailStartMessageId: "u-compact-durable",
    });
  });

  it("live/cold 的 edit/retry action 与 command target 逐行等价", () => {
    const messages = [
      userMessage("u-live-cold", "问题", 1000),
      assistantMessage("a-live-cold", "u-live-cold", "回答", 1001),
    ];
    const cold = reduce(messages).projection;
    const live = new ProductProjection("s1", "epoch");
    const liveEvents = [
      {
        type: SessionEventType.SessionCreated,
        payload: { mode: "default", contextWindow: 200_000 },
      },
      {
        type: SessionEventType.TurnStarted,
        payload: { turnNumber: 1, input: "问题", messageId: "u-live-cold" },
        turnId: "hydrate-turn-1",
      },
      {
        type: SessionEventType.ModelStreaming,
        payload: {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "a-live-cold",
        },
        turnId: "hydrate-turn-1",
      },
      {
        type: SessionEventType.ModelStreaming,
        payload: { kind: "text_delta", delta: "回答", done: false },
        turnId: "hydrate-turn-1",
      },
      {
        type: SessionEventType.ModelStreaming,
        payload: { kind: "text_end", delta: "", done: false },
        turnId: "hydrate-turn-1",
      },
      {
        type: SessionEventType.TurnComplete,
        payload: {
          response: "回答",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        turnId: "hydrate-turn-1",
      },
    ].map(
      (event, index) =>
        ({
          id: `live-${index + 1}`,
          sessionId: "s1",
          timestamp: new Date(1000 + index),
          traceId: "live-trace",
          sequenceNumber: index + 1,
          ...event,
        }) as unknown as SessionEvent,
    );
    for (const event of liveEvents) live.applyEvent(event);

    const coldEntityResolver = cold.resolveEditTargetByEntityId;
    const liveEntityResolver = live.resolveEditTargetByEntityId;

    const commandFacts = (
      projection: ProductProjection,
      resolveByEntityId: (entityId: string) => unknown,
    ) =>
      projection
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "userInput" || row.kind === "assistantText")
        .map((row) => {
          const entityId = projection.getEntityIdForRow(row.rowId);
          return {
            actions: row.actions,
            entityId,
            kind: row.kind,
            messageId: projection.getMessageIdForRow(row.rowId),
            rewindAnchor: projection.getTurnRewindAnchor(row.rowId),
            target: entityId ? resolveByEntityId.call(projection, entityId) : null,
            text: row.text,
          };
        });

    expect(commandFacts(cold, coldEntityResolver)).toEqual(commandFacts(live, liveEntityResolver));
    expect(commandFacts(cold, coldEntityResolver)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "u-live-cold",
          target: {
            coveredByStableCompact: false,
            entityId: "u-live-cold",
            intent: { kind: "sendText", text: "问题" },
            productTurnId: "u-live-cold",
            transcriptMessageId: "u-live-cold",
          },
        }),
      ]),
    );
    for (const row of cold.getSnapshot().rows.window) {
      if (row.actions?.canEdit) {
        expect(cold.getMessageIdForRow(row.rowId)).not.toBeNull();
        expect(cold.getTurnRewindAnchor(row.rowId)).not.toBeNull();
      }
      if (row.actions?.canRetry) expect(cold.getMessageIdForRow(row.rowId)).not.toBeNull();
    }
  });

  it("冷恢复用同一轮历史消息跨度合成 turnHeader activeMs", () => {
    const messages = [
      userMessage("u1", "排查一个慢任务", 1000),
      assistantMessage("a1", "u1", "先读文件", 1200, 3400),
      assistantMessage("a2", "u1", "再跑命令", 5000, 61_000),
    ];
    const { events, projection } = reduce(messages);

    const turnComplete = events.find((event) => event.type === SessionEventType.TurnComplete);
    expect(turnComplete?.payload).toMatchObject({ duration: 60_000 });
    const turnHeader = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader");
    expect(turnHeader).toMatchObject({
      activeMs: 60_000,
      state: "completedSuccess",
    });
  });

  it("assistant 行携带 assistantMessageId → fork-of-fork 可解析", () => {
    const messages = [userMessage("u1", "hi", 1000), assistantMessage("a1", "u1", "yo", 1001)];
    const { projection } = reduce(messages);
    const assistantRow = projection
      .getSnapshot()
      .rows.window.find((r) => r.kind === "assistantText");
    // messageId 侧表用合成时的 assistant message id。
    expect(projection.getMessageIdForRow(assistantRow!.rowId)).toBe("a1");
  });

  it("eventsCoverTranscript：事件日志缺 user 轮 → false（应改走合成）", () => {
    const messages = [userMessage("u1", "a", 1000), assistantMessage("a1", "u1", "b", 1001)];
    // 空事件日志 vs 有 1 个 user 消息 → 不覆盖。
    expect(eventsCoverTranscript([], messages)).toBe(false);
    // 合成出的事件 → 覆盖。
    const { events } = reduce(messages);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
  });

  it("model-only 唤醒（goal continuation）开独立 model-only 轮，无可见气泡（S11/BG-wake-cold）", () => {
    // 16-plan P2 语义变更（2026-07-08）：wake/continuation 触发的 synthetic user
    // 与 live 一致开 model-only 轮（旧冷路径把其后 assistant 并进上一轮——前审 F2 分叉）。
    const messages = [
      userMessage("u1", "a", 1000),
      assistantMessage("a1", "u1", "b", 1002),
      syntheticUserMessage("u_goal", "continue goal", 2000, {
        metadata: { source: "goal-continuation", visibility: "model-only" },
        source: "goal-continuation",
        visibility: "model-only",
      }),
      assistantMessage("a2", "u_goal", "续跑产出", 2001),
    ];
    const { events, projection } = reduce(messages);

    const turnStarts = events.filter((event) => event.type === SessionEventType.TurnStarted);
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1]?.payload).toMatchObject({
      inputVisibility: "model-only",
      inputSource: "goal-continuation",
      messageId: "u_goal",
    });
    expect(eventsCoverTranscript(events, messages)).toBe(true);
    const rows = projection.getSnapshot().rows.window;
    // 唤醒轮无可见 user 气泡；两轮 assistant 内容都在、各归自己的轮。
    const userRows = rows.filter((row) => row.kind === "userInput");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.kind === "userInput" ? userRows[0].text : "").toBe("a");
    const assistantRows = rows.filter((row) => row.kind === "assistantText");
    expect(assistantRows.map((row) => row.turnId)).toEqual(["u1", "u_goal"]);
    expect(rows.filter((row) => row.kind === "turnHeader")).toHaveLength(2);
  });

  it("H17 cold：切模型后的 controlOnly goal query 与 continuation 保持独立执行语义", () => {
    const previousUser = userMessageWithModel("u-before-goal", "上一轮", 1000, {
      providerId: "p1",
      modelId: "m1",
    });
    const previousAssistant = assistantMessage("a-before-goal", "u-before-goal", "完成", 1001);
    previousAssistant.info.providerId = "p1" as never;
    previousAssistant.info.modelId = "m1" as never;

    const goalInput = userMessageWithModel("u-goal", "/Goal 开发招投标系统", 2000, {
      providerId: "p2",
      modelId: "m2",
    });
    goalInput.info.metadata = { executionKind: "controlOnly" };
    const continuation = syntheticUserMessage("u-goal-continuation", "继续目标", 2001, {
      metadata: { source: "goal-continuation", visibility: "model-only" },
      source: "goal-continuation",
      visibility: "model-only",
    });
    continuation.info.modelSelection = { providerId: "p2" as never, modelId: "m2" as never };
    const continuationAssistant = assistantMessage(
      "a-goal-continuation",
      "u-goal-continuation",
      "执行中",
      2002,
    );
    continuationAssistant.info.providerId = "p2" as never;
    continuationAssistant.info.modelId = "m2" as never;

    const messages = [
      previousUser,
      previousAssistant,
      goalInput,
      continuation,
      continuationAssistant,
    ];
    const events = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    const goalStart = events.find(
      (event) =>
        event.type === SessionEventType.TurnStarted &&
        (event.payload as { messageId?: string }).messageId === "u-goal",
    );
    expect(goalStart?.payload).toMatchObject({ executionKind: "controlOnly" });

    const projection = new ProductProjection("s1", "epoch");
    let activeMessageId: string | undefined;
    for (const event of events) {
      if (event.type === SessionEventType.TurnStarted) {
        activeMessageId = (event.payload as { messageId?: string }).messageId;
      }
      projection.applyEvent(event);
      if (event.type === SessionEventType.TurnComplete && activeMessageId === "u-goal") {
        expect(projection.getSnapshot().control).toMatchObject({
          phase: "completedSuccess",
          activeWorks: [],
        });
      }
    }

    const rows = projection.getSnapshot().rows.window;
    const headers = rows.filter((row) => row.kind === "turnHeader");
    expect(headers.find((row) => row.turnId === "u-goal")).toMatchObject({
      executionKind: "controlOnly",
      state: "completedSuccess",
    });
    expect(headers.find((row) => row.turnId === "u-goal")).not.toHaveProperty("activeMs");
    expect(headers.find((row) => row.turnId === "u-goal-continuation")).toMatchObject({
      executionKind: "agent",
      state: "completedSuccess",
    });
    expect(
      rows.filter((row) => row.kind === "timelineMarker" && row.marker.type === "modelChange"),
    ).toHaveLength(1);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
  });

  it("cold hydration strips the withdrawn refined names from a persisted CreateWorkflow display", () => {
    // docs/dynamic-workflow/presentation.md：旧 part 的 display 里还带着
    // `refinedName` / `refinedLabel`，而渲染端按严格 schema 校验每一帧。三个携带 display 的
    // 事件都必须拿到剥离后的同一份，否则旧会话在订阅时整帧被拒。
    const plainGraph = {
      steps: [{ id: "ask#1", kind: "ask", label: "planner", lane: "actor#1", phase: "phase#1" }],
      lanes: [{ id: "actor#1", name: "planner" }],
      participants: [
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
      ],
      handoffs: [],
      phases: [{ id: "phase#1", name: "plan" }],
    };
    const refinedGraph = {
      ...plainGraph,
      steps: [{ ...plainGraph.steps[0], refinedLabel: "拟定计划" }],
      lanes: [{ ...plainGraph.lanes[0], refinedName: "规划者" }],
      phases: [{ ...plainGraph.phases[0], refinedName: "规划" }],
    };
    const displayOf = (causalityGraph: unknown) => ({
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
    });
    const messages = [
      userMessage("u1", "run the workflow", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool-create-workflow" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-create-workflow",
            tool: "CreateWorkflow",
            state: {
              status: "completed",
              input: { script: "phase('plan'); return await agent('planner').ask('plan');" },
              output: "started",
              title: "CreateWorkflow",
              metadata: { schemaVersion: 1, display: displayOf(refinedGraph) },
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    ];

    const { events } = reduce(messages);
    const displays = events
      .filter(
        (event) =>
          event.type === SessionEventType.ToolCallScheduled ||
          event.type === SessionEventType.ToolCallStarted ||
          event.type === SessionEventType.ToolCallResult,
      )
      .map((event) => {
        const payload = event.payload as { display?: unknown; result?: { display?: unknown } };
        return payload.display ?? payload.result?.display;
      });
    expect(displays).toHaveLength(3);
    for (const display of displays) expect(display).toEqual(displayOf(plainGraph));
  });

  it("cold hydration strips providerStop from a persisted GetWorkflowRun display", () => {
    // docs/dynamic-workflow/launch.md「Their cards」：旧 part 的 display 里还带着工具输出
    // 那份 `error.providerStop`，而渲染端按镜像 schema 校验每一帧。三个携带 display
    // 的事件都必须拿到剥离后的同一份，否则这个会话一订阅就整帧被拒。
    const plainDisplay = {
      kind: "get_workflow_run",
      runId: "dwfrun_stopped",
      label: "nightly-sync",
      status: "stopped",
      stopReason: "provider",
      usage: {
        spentTokens: 12_345,
        nodesObserved: 7,
        nodesRunning: 0,
        nodesCompleted: 4,
        nodesFailed: 1,
      },
      actors: [{ siteId: "agent#1", ordinal: 1, name: "scout" }],
      logTail: [{ sequence: 1, message: "started" }],
      error: { code: "ProviderStop", message: "The provider stopped the run: rate limited." },
    };
    const persistedDisplay = {
      ...plainDisplay,
      error: {
        ...plainDisplay.error,
        providerStop: { kind: "quota", reason: "rate_limited", providerCode: "1308" },
      },
    };
    const messages = [
      userMessage("u1", "how is the run doing", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool-get-workflow-run" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-get-workflow-run",
            tool: "GetWorkflowRun",
            state: {
              status: "completed",
              input: { run_id: "dwfrun_stopped" },
              output: "stopped",
              title: "GetWorkflowRun",
              metadata: { schemaVersion: 1, display: persistedDisplay },
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    ];

    const { events } = reduce(messages);
    const displays = events
      .filter(
        (event) =>
          event.type === SessionEventType.ToolCallScheduled ||
          event.type === SessionEventType.ToolCallStarted ||
          event.type === SessionEventType.ToolCallResult,
      )
      .map((event) => {
        const payload = event.payload as { display?: unknown; result?: { display?: unknown } };
        return payload.display ?? payload.result?.display;
      });
    expect(displays).toHaveLength(3);
    for (const display of displays) {
      expect(display).toEqual(plainDisplay);
      // 水合出来的每一帧都要过渲染端那把尺。
      const mirrored = toolCallGetWorkflowRunDisplaySchema.strict().safeParse(display);
      expect(mirrored.success ? [] : mirrored.error.issues).toEqual([]);
    }
  });

  it("BG26：cold hydration 保留 background notification 原文并恢复 Agent 失败终态", () => {
    const toolCallId = "call-agent-rate-limit";
    const error = "Requests are too frequent. Request id: bg26-cold";
    const result = `Agent general-purpose task \"分析世界杯\" failed. ${error}`;
    const launchOutput = [
      "Async agent launched successfully.",
      "agentId: agent-bg26 (internal ID - do not mention to user.)",
      "The agent is working in the background.",
    ].join("\n");
    const messages = [
      userMessage("u1", "launch agent", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool-agent-bg26" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: toolCallId,
            tool: "Agent",
            state: {
              status: "completed",
              input: {
                description: "分析世界杯",
                run_in_background: true,
                subagent_type: "general-purpose",
              },
              output: launchOutput,
              title: "Agent 分析世界杯",
              metadata: {},
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
      syntheticUserMessage(
        "u-agent-notification",
        [
          "<task-notification>",
          `<tool-use-id>${toolCallId}</tool-use-id>`,
          "<status>failed</status>",
          `<result>${result}</result>`,
          `<error>${error}</error>`,
          "</task-notification>",
        ].join("\n"),
        2000,
        {
          metadata: { source: "background_task", visibility: "model-only" },
          source: "background_task",
          visibility: "model-only",
        },
      ),
      assistantMessage("a2", "u-agent-notification", "父会话已处理失败", 2001),
    ];

    const { events, projection } = reduce(messages);
    const notificationStart = events
      .filter((event) => event.type === SessionEventType.TurnStarted)
      .find(
        (event) => (event.payload as { messageId?: string }).messageId === "u-agent-notification",
      );
    expect(notificationStart?.payload).toMatchObject({
      inputVisibility: "model-only",
      inputSource: "background_task",
      input: expect.stringContaining(`<tool-use-id>${toolCallId}</tool-use-id>`),
    });
    expect(
      projection.getSnapshot().rows.window.filter((row) => row.kind === "userInput"),
    ).toHaveLength(1);
    expect(
      projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      error: {
        code: "fault.runtime.backgroundTaskFailed",
        message: error,
      },
      output: { text: result },
      status: "error",
    });
    expect(
      projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "subagent" && row.parentToolCallId === toolCallId),
    ).toMatchObject({
      childSessionId: "sess_subagent_agent-bg26",
    });
  });

  it("BG26：cold hydration 从通知消息 metadata 的 originMeta 恢复结构化失败原因", () => {
    const toolCallId = "call-agent-rate-limit";
    const error = "Requests are too frequent. Request id: bg26-cold";
    const summary = `Agent "分析世界杯" failed: ${error}`;
    const messages = [
      userMessage("u1", "launch agent", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool-agent-bg26" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: toolCallId,
            tool: "Agent",
            state: {
              status: "completed",
              input: { description: "分析世界杯", run_in_background: true },
              output: "Async agent launched successfully.",
              title: "Agent 分析世界杯",
              metadata: {},
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
      syntheticUserMessage(
        "u-agent-notification",
        [
          "<task-notification>",
          "<task-id>agent-bg26</task-id>",
          `<tool-use-id>${toolCallId}</tool-use-id>`,
          "<status>failed</status>",
          `<summary>${summary}</summary>`,
          "</task-notification>",
        ].join("\n"),
        2000,
        {
          metadata: {
            source: "background_task",
            visibility: "model-only",
            originMeta: {
              backgroundSource: "subagent",
              workId: "agent-bg26",
              title: "分析世界杯",
              subagentResult: { status: "failed", error },
            },
          },
          source: "background_task",
          visibility: "model-only",
        },
      ),
      assistantMessage("a2", "u-agent-notification", "父会话已处理失败", 2001),
    ];

    const { projection } = reduce(messages);
    expect(
      projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId),
    ).toMatchObject({
      error: { code: "fault.runtime.backgroundTaskFailed", message: error },
      output: { text: summary },
      status: "error",
    });
  });

  it("BG26：cold hydration 按块恢复合并通知，失败任务不读下一条通知的结果", () => {
    const failedSummary = 'Agent "A" failed: Permission denied';
    const agentTool = (callID: string) => ({
      id: `a1-${callID}` as never,
      sessionID: "s1" as never,
      messageID: "a1" as never,
      type: "tool" as const,
      callID,
      tool: "Agent",
      state: {
        status: "completed" as const,
        input: { description: callID, run_in_background: true },
        output: "Async agent launched successfully.",
        title: `Agent ${callID}`,
        metadata: {},
        time: { start: 1001, end: 1002 },
      },
    });
    const messages = [
      userMessage("u1", "launch agents", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [agentTool("call-agent-a"), agentTool("call-agent-b")],
        1001,
      ),
      syntheticUserMessage(
        "u-merged-notification",
        [
          [
            "<task-notification>",
            "<tool-use-id>call-agent-a</tool-use-id>",
            "<status>failed</status>",
            `<summary>${failedSummary}</summary>`,
            "</task-notification>",
          ].join("\n"),
          [
            "<task-notification>",
            "<tool-use-id>call-agent-b</tool-use-id>",
            "<status>completed</status>",
            '<summary>Agent "B" finished</summary>',
            "<result>Tests passed</result>",
            "</task-notification>",
          ].join("\n"),
        ].join("\n\n"),
        2000,
        {
          metadata: {
            source: "background_task",
            visibility: "model-only",
            originMeta: { backgroundSource: "subagent", workId: "agent-a", title: "A · B" },
          },
          source: "background_task",
          visibility: "model-only",
        },
      ),
      assistantMessage("a2", "u-merged-notification", "父会话已处理", 2001),
    ];

    const rows = reduce(messages).projection.getSnapshot().rows.window;
    const toolRow = (toolCallId: string) =>
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    expect(toolRow("call-agent-a")).toMatchObject({
      error: { code: "fault.runtime.backgroundTaskFailed", message: failedSummary },
      output: { text: failedSummary },
      status: "error",
    });
    expect(toolRow("call-agent-b")).toMatchObject({
      output: { text: "Tests passed" },
      status: "success",
    });
  });

  it("selection side chat 的继承历史只进 provider context，冷恢复时间线从新问题开始", () => {
    const inheritedUser = userMessage("u_selection_parent", "父任务问题", 1000);
    const inheritedAssistant = assistantMessage(
      "a_selection_parent",
      inheritedUser.info.id,
      "父任务回答",
      1001,
    );
    const hideInheritedMessage = (message: MessageWithParts): MessageWithParts => ({
      ...message,
      info: {
        ...message.info,
        visibility: "model-only",
        semantics: {
          kind: "system_reminder",
          origin: "migration",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
          uiVisibility: "hidden",
        },
      },
    });
    const boundary = syntheticUserMessage("u_selection_boundary", "side chat boundary", 1002, {
      source: "selection_side_chat",
      visibility: "model-only",
      semantics: {
        kind: "system_reminder",
        origin: "system",
        providerVisibility: "visible",
        source: "selection_side_chat",
        transcriptVisibility: "hidden",
        uiVisibility: "hidden",
      },
    });
    const sideUser = userMessage("u_selection_visible", "解释这个片段", 2000);
    const sideAssistant = assistantMessage(
      "a_selection_visible",
      sideUser.info.id,
      "这是副屏回答",
      2001,
    );
    const messages = [
      hideInheritedMessage(inheritedUser),
      hideInheritedMessage(inheritedAssistant),
      boundary,
      sideUser,
      sideAssistant,
    ];

    const { events, projection } = reduce(messages);
    const snapshot = projection.getSnapshot();
    const visibleTexts = snapshot.rows.window
      .filter((row) => row.kind === "userInput" || row.kind === "assistantText")
      .map((row) => row.text);

    expect(eventsCoverTranscript(events, messages)).toBe(true);
    expect(visibleTexts).toEqual(["解释这个片段", "这是副屏回答"]);
    expect(JSON.stringify(snapshot.rows.window)).not.toContain("父任务");
    expect(snapshot.rows.totalCount).toBe(snapshot.rows.window.length);
  });

  it("subagent_message idle carrier 的 live/cold identity 与 fork target 完全一致", () => {
    const carrierId = "u-subagent-message-idle";
    const assistantId = "a-subagent-message-idle";
    const carrier = syntheticUserMessage(carrierId, "internal coordinator response", 1000, {
      metadata: { source: "subagent_message", visibility: "model-only" },
      source: "subagent_message",
      visibility: "model-only",
    });
    const cold = reduce([
      carrier,
      assistantMessage(assistantId, carrierId, "subagent follow-up", 1001),
    ]).projection;
    const live = new ProductProjection("s1", "epoch-live-subagent-message");
    const liveEvents = [
      {
        type: SessionEventType.SessionCreated,
        payload: { mode: "default", contextWindow: 200_000 },
      },
      {
        type: SessionEventType.TurnStarted,
        payload: {
          turnNumber: 1,
          input: "",
          inputVisibility: "model-only",
          inputSource: "subagent_message",
          messageId: carrierId,
        },
        turnId: "runtime-subagent-message-turn",
      },
      {
        type: SessionEventType.ModelStreaming,
        payload: {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: assistantId,
        },
        turnId: "runtime-subagent-message-turn",
      },
      {
        type: SessionEventType.ModelStreaming,
        payload: { kind: "text_delta", delta: "subagent follow-up", done: false },
        turnId: "runtime-subagent-message-turn",
      },
      {
        type: SessionEventType.ModelStreaming,
        payload: { kind: "text_end", delta: "", done: false },
        turnId: "runtime-subagent-message-turn",
      },
      {
        type: SessionEventType.TurnComplete,
        payload: {
          response: "subagent follow-up",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        turnId: "runtime-subagent-message-turn",
      },
    ].map(
      (event, index) =>
        ({
          id: `live-subagent-message-${index + 1}`,
          sessionId: "s1",
          timestamp: new Date(1000 + index),
          traceId: "live-subagent-message-trace",
          sequenceNumber: index + 1,
          ...event,
        }) as unknown as SessionEvent,
    );
    for (const event of liveEvents) live.applyEvent(event);

    const identity = (projection: ProductProjection) => {
      const row = projection
        .getSnapshot()
        .rows.window.find((candidate) => candidate.kind === "assistantText");
      expect(row).toBeDefined();
      if (!row) return null;
      const entityId = projection.getEntityIdForRow(row.rowId);
      expect(entityId).toBeTruthy();
      const target = projection.resolveRowActionTarget(
        { rowId: row.rowId, entityId: entityId! },
        "forkAssistant",
      );
      return {
        actionTarget:
          target.ok && target.action === "forkAssistant"
            ? {
                entityId: target.row.entityId,
                messageId: target.messageId,
                productTurnId: target.row.productTurnId,
              }
            : target,
        actions: row.actions,
        entityId,
        messageId: projection.getMessageIdForRow(row.rowId),
        productTurnId: row.productTurnId,
        turnId: row.turnId,
      };
    };

    expect(identity(cold)).toEqual(identity(live));
    expect(identity(cold)).toMatchObject({
      actionTarget: {
        entityId: assistantId,
        messageId: assistantId,
        productTurnId: carrierId,
      },
      entityId: assistantId,
      messageId: assistantId,
      productTurnId: carrierId,
      turnId: carrierId,
    });
  });

  // 新版本每条通知存为一个文本 part；旧版本存为一个 "\n\n" 连接的 part。两种冷恢复的轮输入都与 live 相同。
  it.each([
    ["one part per notification", true],
    ["one joined part", false],
  ])("BG36：multi-notification batch 冷恢复只生成一个 background result turn（%s）", (_, split) => {
    const originMeta = {
      backgroundSource: "subagent" as const,
      title: "Inspect renderer state · Inspect service state",
      workId: "batch-agent-1",
    };
    const notifications = [
      "<task-notification><task-id>batch-agent-1</task-id><status>completed</status></task-notification>",
      "<task-notification><task-id>batch-agent-2</task-id><status>completed</status></task-notification>",
    ];
    const batchText = notifications.join("\n\n");
    const batch = syntheticUserMessage("wake-batch", split ? notifications[0]! : batchText, 2000, {
      metadata: { originMeta, source: "background_task", visibility: "model-only" },
      source: "background_task",
      visibility: "model-only",
    });
    if (split) {
      batch.parts.push({
        ...batch.parts[0]!,
        id: "wake-batch-t2" as never,
        text: notifications[1]!,
      });
    }
    const { events, projection } = reduce([
      batch,
      assistantMessage("a-wake-batch", "wake-batch", "processed batch", 2001),
    ]);
    const turnStarts = events.filter((event) => event.type === SessionEventType.TurnStarted);
    const rows = projection.getSnapshot().rows.window;

    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]?.payload).toMatchObject({
      input: batchText,
      inputSource: "background_task",
      inputVisibility: "model-only",
      messageId: "wake-batch",
      originMeta,
    });
    expect(rows.filter((row) => row.kind === "userInput")).toHaveLength(0);
    const turnHeaders = rows.filter((row) => row.kind === "turnHeader");
    expect(turnHeaders).toHaveLength(1);
    expect(turnHeaders[0]).toMatchObject({
      origin: "backgroundResult",
      originMeta,
    });
    const assistantRows = rows.filter((row) => row.kind === "assistantText");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      productTurnId: "wake-batch",
      turnId: "wake-batch",
    });
  });

  it("multiple background wakes each keep an independent stable productTurnId", () => {
    const background = (id: string, created: number) =>
      syntheticUserMessage(id, "background result", created, {
        metadata: { source: "background_task", visibility: "model-only" },
        source: "background_task",
        visibility: "model-only",
      });
    const { projection } = reduce([
      userMessage("u1", "start", 1000),
      assistantMessage("a1", "u1", "initial", 1001),
      background("wake-1", 2000),
      assistantMessage("a-wake-1", "wake-1", "wake answer 1", 2001),
      background("wake-2", 3000),
      assistantMessage("a-wake-2", "wake-2", "wake answer 2", 3001),
    ]);
    const rows = projection.getSnapshot().rows.window;
    const answers = rows.filter((row) => row.kind === "assistantText");

    expect(answers.map((row) => row.turnId)).toEqual(["u1", "wake-1", "wake-2"]);
    expect(new Set(answers.map((row) => row.productTurnId)).size).toBe(3);
    expect(rows.filter((row) => row.kind === "userInput")).toHaveLength(1);
    expect(answers.map((row) => row.actions?.canRetry === true)).toEqual([false, false, false]);
    expect(answers[2]!.actions?.canFork).toBe(true);

    const withNextRealUserTurn = reduce([
      userMessage("u1", "start", 1000),
      assistantMessage("a1", "u1", "initial", 1001),
      background("wake-1", 2000),
      assistantMessage("a-wake-1", "wake-1", "wake answer 1", 2001),
      background("wake-2", 3000),
      assistantMessage("a-wake-2", "wake-2", "wake answer 2", 3001),
      userMessage("u2", "continue", 4000),
      assistantMessage("a2", "u2", "latest real-user answer", 4001),
    ]).projection;
    const hydratedAnswers = withNextRealUserTurn
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "assistantText");
    expect(hydratedAnswers.map((row) => row.actions?.canRetry === true)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("BG27/BG28：cold hydration 只从结构化 metadata 恢复后台结果标题", () => {
    const background = syntheticUserMessage("wake-title", "background result", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "bash",
          title: "pnpm typecheck",
          workId: "bash-typecheck",
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-title", "wake-title", "typecheck complete", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "bash",
        title: "pnpm typecheck",
        workId: "bash-typecheck",
      },
    });
  });

  // dwf run 的完成通知走同一条后台管线，backgroundSource 是第三个取值 "workflow"。
  // 冷恢复的 originMeta 过滤器此前只放行 bash|subagent，漏掉它会让 workflow 的后台结果轮
  // 静默退化成一条无标题的 model-only 消息（工具卡→详情页的关联键 workId 一起丢掉）。
  it("cold hydration 恢复 workflow 后台结果的 originMeta", () => {
    const background = syntheticUserMessage("wake-workflow", "workflow result", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "review the diff",
          workId: "dwfrun-abc",
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-workflow", "wake-workflow", "workflow done", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "workflow",
        title: "review the diff",
        workId: "dwfrun-abc",
      },
    });
  });

  // manifest 载荷（workflowNotification）也要过冷恢复：读取器此前只回读三基字段，
  // 载荷会在冷恢复后静默丢失，manifest 条目退回裸标题行（本特性最隐蔽的坑）。
  it("cold hydration 恢复 workflow originMeta 的 manifest 载荷（terminal）", () => {
    const workflowNotification = {
      kind: "terminal",
      status: "completed",
      summary: "review the diff",
      result: "final artifact",
      resultForm: "prose",
      reports: { count: 3, shown: 1, preview: ["第一步"] },
      durationMs: 4200,
    };
    const background = syntheticUserMessage("wake-workflow-meta", "workflow result", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "review the diff",
          workId: "dwfrun-meta",
          workflowNotification,
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-meta", "wake-workflow-meta", "workflow done", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "backgroundResult",
      originMeta: { backgroundSource: "workflow", workId: "dwfrun-meta", workflowNotification },
    });
  });

  // 「主代理闲着、run 还欠着决定」的提醒走同一条读取器，载荷在它自己的键 `workflowBlocked` 上
  // （docs/dynamic-workflow/transcript-and-notifications.md「The payload」）：冷恢复后仍是那一行，
  // 而不是退回裸标题行。
  it("cold hydration 恢复 workflow originMeta 的提醒载荷（workflowBlocked）", () => {
    const workflowBlocked = { questions: 2, holes: 1, sinceMs: 1_020_000 };
    const background = syntheticUserMessage("wake-workflow-blocked", "workflow reminder", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "review the diff",
          workId: "dwfrun-blocked",
          workflowBlocked,
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-blocked", "wake-workflow-blocked", "answered", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "backgroundResult",
      originMeta: { backgroundSource: "workflow", workId: "dwfrun-blocked", workflowBlocked },
    });
    expect(header).not.toHaveProperty("originMeta.workflowNotification");
  });

  // 提醒曾短暂地作为 `workflowNotification` 的一个 kind 落过盘（闭集多一个成员会让老客户端拒掉整帧）。
  // 那样的行冷恢复时只丢载荷：绝不把闭集之外的 kind 再发上线。
  it("cold hydration 不把闭集之外的 workflowNotification kind 发上线", () => {
    const background = syntheticUserMessage("wake-workflow-legacy", "workflow reminder", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "review the diff",
          workId: "dwfrun-legacy",
          workflowNotification: { kind: "blocked", questions: 2, holes: 1, sinceMs: 1_020_000 },
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-legacy", "wake-workflow-legacy", "answered", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "backgroundResult",
      originMeta: { backgroundSource: "workflow", workId: "dwfrun-legacy" },
    });
    expect(header).not.toHaveProperty("originMeta.workflowNotification");
    expect(header).not.toHaveProperty("originMeta.workflowBlocked");
  });

  // 防御性读取：畸形载荷（status 不在枚举内）只丢载荷、保三基字段，绝不打挂整条冷恢复。
  it("cold hydration 丢弃畸形 manifest 载荷但保留三基字段", () => {
    const background = syntheticUserMessage("wake-workflow-bad", "workflow result", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "review the diff",
          workId: "dwfrun-bad",
          // status 非法（不在 completed/failed/cancelled 内）→ zod 拒收 → 只丢载荷。
          workflowNotification: { kind: "terminal", status: "running", summary: "x" },
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-bad", "wake-workflow-bad", "workflow done", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      origin: "backgroundResult",
      originMeta: { backgroundSource: "workflow", title: "review the diff", workId: "dwfrun-bad" },
    });
    // 载荷被丢弃，不带进投影。
    expect(
      (header as { originMeta?: { workflowNotification?: unknown } }).originMeta
        ?.workflowNotification,
    ).toBeUndefined();
  });

  // 用户面产物的 chips 载荷（docs/dynamic-workflow/authoring.md「How the user sees them」）走同一条读取器。
  // 读取器本身是 `workflowNotificationMetaSchema.safeParse` 的直传，而那份 zod **剥离**未声明
  // 的键——所以「schema 里没加 artifacts」的症状不是报错，是 chips 在冷恢复后无声消失。
  // 这条正向断言就是那个坑的钉子。
  it("cold hydration 恢复 manifest 载荷里的 artifacts 与 artifactsTruncated", () => {
    const workflowNotification = {
      kind: "terminal",
      status: "completed",
      summary: "nightly audit",
      artifacts: [
        {
          id: "audit",
          kind: "file",
          title: "审计报告",
          version: 2,
          contentType: "application/pdf",
        },
        { id: "perf", kind: "chart", version: 1 },
      ],
      artifactsTruncated: true,
    };
    const background = syntheticUserMessage("wake-workflow-art", "workflow result", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "nightly audit",
          workId: "dwfrun-art",
          workflowNotification,
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-art", "wake-workflow-art", "workflow done", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    const restored = (header as { originMeta?: { workflowNotification?: Record<string, unknown> } })
      .originMeta?.workflowNotification;
    expect(restored?.artifacts).toEqual(workflowNotification.artifacts);
    expect(restored?.artifactsTruncated).toBe(true);
  });

  // 畸形产物条目（未知 kind）让整份载荷被 zod 拒掉 → 只丢载荷、保三基字段。发射侧因此必须
  // 在构造前过滤未知 kind，而不是指望读取端救场。
  it("cold hydration 丢弃带未知 artifact kind 的载荷但保留三基字段", () => {
    const background = syntheticUserMessage("wake-workflow-art-bad", "workflow result", 2000, {
      metadata: {
        originMeta: {
          backgroundSource: "workflow",
          title: "nightly audit",
          workId: "dwfrun-art-bad",
          workflowNotification: {
            kind: "terminal",
            status: "completed",
            summary: "nightly audit",
            artifacts: [{ id: "future", kind: "hologram", version: 1 }],
          },
        },
        source: "background_task",
        visibility: "model-only",
      },
      source: "background_task",
      visibility: "model-only",
    });
    const { projection } = reduce([
      background,
      assistantMessage("a-wake-art-bad", "wake-workflow-art-bad", "workflow done", 2001),
    ]);

    const header = projection.getSnapshot().rows.window.find((row) => row.kind === "turnHeader");
    expect(header).toMatchObject({
      originMeta: {
        backgroundSource: "workflow",
        title: "nightly audit",
        workId: "dwfrun-art-bad",
      },
    });
    expect(
      (header as { originMeta?: { workflowNotification?: unknown } }).originMeta
        ?.workflowNotification,
    ).toBeUndefined();
  });

  it("legacy fork synthetic user 合成为 fork timeline，不合成为 userInput", () => {
    const forkMetadata = {
      forkContext: {
        kind: "session_fork",
        parentSessionId: "sess_parent",
        restoredFileCount: 0,
        targetMessageId: "msg_parent_assistant",
      },
      source: "fork",
      visibility: "user-visible",
    };
    const messages = [
      syntheticUserMessage(
        "u_fork",
        "This session was forked from a previous session message.",
        1000,
        {
          metadata: forkMetadata,
          source: "fork",
          visibility: "user-visible",
        },
      ),
    ];
    const { events, projection } = reduce(messages);

    expect(events.some((event) => event.type === SessionEventType.TurnStarted)).toBe(false);
    expect(events.some((event) => event.type === SessionEventType.SessionForked)).toBe(true);
    expect(eventsCoverTranscript([], messages)).toBe(false);
    const rows = projection.getSnapshot().rows.window;
    expect(rows.some((row) => row.kind === "userInput")).toBe(false);
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "timelineMarker",
        marker: expect.objectContaining({
          parentSessionId: "sess_parent",
          type: "forkNotice",
        }),
      }),
    );
  });

  it("model-only fork raw notice 不重复合成 fork timeline", () => {
    const forkMetadata = {
      forkContext: {
        kind: "session_fork",
        parentSessionId: "sess_parent",
        restoredFileCount: 0,
        targetMessageId: "msg_parent_assistant",
      },
      source: "fork",
      visibility: "model-only",
    };
    const messages = [
      assistantMessageWithParts(
        "a_fork_timeline",
        "u1",
        [
          {
            id: "a_fork_timeline_part" as never,
            sessionID: "s1" as never,
            messageID: "a_fork_timeline" as never,
            type: "timeline",
            timelineType: "session_fork",
            display: "separator",
            status: "completed",
            parentSessionId: "sess_parent" as never,
            targetMessageId: "msg_parent_assistant" as never,
            restoredFileCount: 0,
          },
        ],
        1000,
      ),
      syntheticUserMessage(
        "u_fork_raw",
        "This session was forked from a previous session message.",
        1001,
        {
          metadata: forkMetadata,
          semantics: {
            kind: "fork_notice",
            origin: "agent_runtime",
            providerVisibility: "visible",
            source: "fork",
            transcriptVisibility: "hidden",
            uiVisibility: "hidden",
          },
          source: "fork",
          visibility: "model-only",
        },
      ),
    ];
    const { events, projection } = reduce(messages);

    expect(events.filter((event) => event.type === SessionEventType.TurnStarted)).toHaveLength(0);
    expect(events.filter((event) => event.type === SessionEventType.SessionForked)).toHaveLength(1);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
    expect(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) =>
            row.kind === "timelineMarker" &&
            (row.marker.type === "forkNotice" || row.marker.type === "forkCreated"),
        ),
    ).toHaveLength(1);
  });

  it("assistant reasoning/tool/compact/Agent part → 对应 v4 rows，Agent tool 同时保留 subagent row", () => {
    const agentOutput = JSON.stringify({
      agentId: "agent-1",
      agentType: "Explore",
      childSessionId: "sess_child_1",
      description: "探索项目",
      content: [{ type: "text", text: "子代理总结" }],
      status: "completed",
    });
    const messages = [
      userMessage("u1", "分析一下", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-r" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "reasoning",
            text: "先想一想",
            time: { start: 1001, end: 1002 },
          },
          {
            id: "a1-tool-read" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-read",
            tool: "Read",
            state: {
              status: "completed",
              input: { file_path: "README.md" },
              output: "README 内容",
              title: "Read README.md",
              metadata: {},
              time: { start: 1002, end: 1003 },
            },
          },
          {
            id: "a1-compact" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "timeline",
            timelineType: "context_compaction",
            display: "separator",
            status: CompactTimelineStatus.Completed,
            operationId: "cmp-1",
            trigger: CompactTrigger.Manual,
            sourceCommandId: "command-compact-cold",
            preCompactTokenCount: 900,
            postCompactTokenCount: 300,
          },
          {
            id: "a1-browser-shot" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-browser-shot",
            tool: "mcp__node_repl__js",
            state: {
              status: "completed",
              input: { source: "browser_turn_end" },
              output: "",
              title: "mcp__node_repl__js",
              metadata: {
                schemaVersion: 1,
                display: {
                  kind: "node_repl_images",
                  source: "browser_turn_end",
                  images: [{ base64: "AAAA", mimeType: "image/png" }],
                },
              },
              time: { start: 1003, end: 1003 },
            },
          },
          {
            id: "a1-mcp-tool" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-mcp-tool",
            tool: "custom-provider-visible-name",
            state: {
              status: "completed",
              input: { query: "is:open" },
              output: "12 issues",
              title: "custom-provider-visible-name",
              metadata: {
                schemaVersion: 1,
                display: {
                  kind: "mcp_tool",
                  serverName: "s".repeat(256),
                  toolName: "t".repeat(256),
                  description: "d".repeat(4 * 1024),
                },
              },
              time: { start: 1003, end: 1004 },
            },
          },
          {
            id: "a1-tool-agent" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-agent",
            tool: "Agent",
            state: {
              status: "completed",
              input: { description: "探索项目", prompt: "请探索项目" },
              output: agentOutput,
              title: "Agent 探索项目",
              metadata: {},
              time: { start: 1004, end: 1010 },
            },
          },
          {
            id: "a1-cua-shot" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-cua-shot",
            tool: "mcp__computer-use__computer-use",
            state: {
              status: "completed",
              input: { action: "screenshot" },
              output: "[Attached image/jpeg: MCP image]",
              title: "computer-use screenshot",
              metadata: {
                schemaVersion: 1,
                display: {
                  kind: "cua",
                  schemaVersion: 1,
                  toolName: "computer-use",
                  status: "success",
                  input: '{"action":"screenshot"}',
                  media: [{ mimeType: "image/jpeg", data: "AAAA" }],
                },
              },
              time: { start: 1003, end: 1004 },
            },
          },
          {
            id: "a1-t" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "text",
            text: "完成",
          },
        ],
        1001,
      ),
    ];
    const { events, projection } = reduce(messages);
    const rows = projection.getSnapshot().rows.window;

    expect(eventsCoverTranscript([], messages)).toBe(false);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
    expect(rows.find((row) => row.kind === "reasoning")).toMatchObject({
      text: "先想一想",
      state: "complete",
    });
    expect(
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === "call-read"),
    ).toMatchObject({
      status: "success",
      output: { text: "README 内容" },
    });
    expect(
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === "call-agent"),
    ).toMatchObject({
      status: "success",
    });
    expect(
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === "call-browser-shot"),
    ).toMatchObject({
      status: "success",
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    });
    expect(
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === "call-mcp-tool"),
    ).toMatchObject({
      status: "success",
      display: {
        kind: "mcp_tool",
        serverName: "s".repeat(256),
        toolName: "t".repeat(256),
        description: "d".repeat(4 * 1024),
      },
    });
    expect(
      rows.find((row) => row.kind === "toolCall" && row.toolCallId === "call-cua-shot"),
    ).toMatchObject({
      status: "success",
      output: {
        text: "[Attached image/jpeg: MCP image]",
        display: {
          kind: "cua",
          media: [{ mimeType: "image/jpeg", data: "AAAA" }],
        },
      },
    });
    expect(rows.find((row) => row.kind === "subagent")).toMatchObject({
      childSessionId: "sess_child_1",
      parentToolCallId: "call-agent",
      status: "success",
      subagentType: "Explore",
      summaryText: "子代理总结",
    });
    expect(rows.find((row) => row.kind === "timelineMarker")).toMatchObject({
      lane: "assistantWork",
      sourceCommandId: "command-compact-cold",
      marker: {
        status: "success",
        tokensAfter: 300,
        tokensBefore: 900,
        type: "compact",
      },
    });
  });

  it("失败 MCP 工具的字符串 modelContent 不丢失冷恢复展示信息", () => {
    const display = {
      kind: "mcp_tool",
      serverName: "Document Service",
      toolName: "get_page",
      description: "Fetch page contents",
    } as const;
    const messages = [
      userMessage("u1", "读取页面", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-mcp",
            tool: "mcp__Document_Service__get_page",
            state: {
              status: "error",
              input: {},
              error: "Permission denied",
              metadata: {
                schemaVersion: 1,
                modelContent: "MCP request failed: permission denied",
                display,
              },
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    ];
    const { projection } = reduce(messages);

    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({
      status: "error",
      display,
    });
  });

  it("历史 pending/running tool 不复活 active work，冷恢复收口为 cancelled", () => {
    const messages = [
      userMessage("u1", "跑个长任务", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-bash",
            tool: "Bash",
            state: {
              status: "running",
              input: { command: "sleep 100" },
              title: "sleep 100",
              metadata: {
                schemaVersion: 1,
                display: {
                  kind: "mcp_tool",
                  serverName: "firebase",
                  toolName: "read_resources",
                },
              },
              time: { start: 1001 },
            },
          },
        ],
        1001,
      ),
    ];
    const { projection } = reduce(messages);
    const snapshot = projection.getSnapshot();

    expect(snapshot.control.phase).toBe("completedInterrupted");
    expect(snapshot.control.activeWorks).toEqual([]);
    expect(snapshot.control.canStop).toBe(false);
    expect(snapshot.rows.window.find((row) => row.kind === "toolCall")).toMatchObject({
      status: "cancelled",
      display: { kind: "mcp_tool", serverName: "firebase", toolName: "read_resources" },
    });
  });

  it("eventsCoverTranscript：事件有 turn 但缺 tool footprint → false", () => {
    const messages = [
      userMessage("u1", "读文件", 1000),
      assistantMessageWithParts(
        "a1",
        "u1",
        [
          {
            id: "a1-tool" as never,
            sessionID: "s1" as never,
            messageID: "a1" as never,
            type: "tool",
            callID: "call-read",
            tool: "Read",
            state: {
              status: "completed",
              input: { file_path: "README.md" },
              output: "README",
              title: "Read README.md",
              metadata: {},
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    ];
    const textOnlyEvents = synthesizeEventsFromMessages(
      [userMessage("u1", "读文件", 1000), assistantMessage("a1", "u1", "", 1001)],
      { sessionId: "s1" },
    );

    expect(eventsCoverTranscript(textOnlyEvents, messages)).toBe(false);
  });

  it.each(["", " \t "])(
    "空名恢复 tool part（%j）不生成冷恢复工具行，也不进入可见 footprint",
    (toolName) => {
      const messages = [
        userMessage("u-empty-tool", "继续", 1000),
        assistantMessageWithParts(
          "a-empty-tool",
          "u-empty-tool",
          [
            {
              id: "a-empty-tool-part" as never,
              sessionID: "s1" as never,
              messageID: "a-empty-tool" as never,
              type: "tool",
              callID: "call-empty-tool",
              tool: toolName,
              state: {
                status: "error",
                input: {},
                error: "Model returned an invalid tool call: tool name is empty.",
                time: { start: 1001, end: 1002 },
              },
            },
          ],
          1001,
        ),
      ];

      const { events, projection } = reduce(messages);
      expect(projection.getSnapshot().rows.window.filter((row) => row.kind === "toolCall")).toEqual(
        [],
      );
      expect(eventsCoverTranscript(events, messages)).toBe(true);
    },
  );

  it("带原始空名 metadata 的存储占位不生成冷恢复工具行", () => {
    const messages = [
      userMessage("u-empty-tool", "继续", 1000),
      assistantMessageWithParts(
        "a-empty-tool",
        "u-empty-tool",
        [
          {
            id: "a-empty-tool-part" as never,
            sessionID: "s1" as never,
            messageID: "a-empty-tool" as never,
            type: "tool",
            callID: "call-empty-tool",
            tool: "empty_tool_name",
            metadata: { providerToolName: "" },
            state: {
              status: "error",
              input: {},
              error: "Model returned an invalid tool call: tool name is empty.",
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    ];

    const { events, projection } = reduce(messages);
    expect(projection.getSnapshot().rows.window.filter((row) => row.kind === "toolCall")).toEqual(
      [],
    );
    expect(eventsCoverTranscript(events, messages)).toBe(true);
  });

  it("裸 empty_tool_name 按合法工具生成冷恢复工具行和可见 footprint", () => {
    const messages = [
      userMessage("u-legitimate-tool", "运行工具", 1000),
      assistantMessageWithParts(
        "a-legitimate-tool",
        "u-legitimate-tool",
        [
          {
            id: "a-legitimate-tool-part" as never,
            sessionID: "s1" as never,
            messageID: "a-legitimate-tool" as never,
            type: "tool",
            callID: "call-legitimate-tool",
            tool: "empty_tool_name",
            state: {
              status: "completed",
              input: { value: 1 },
              output: "ok",
              title: "empty_tool_name",
              metadata: {},
              time: { start: 1001, end: 1002 },
            },
          },
        ],
        1001,
      ),
    ];

    const { events, projection } = reduce(messages);
    expect(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
    ).toMatchObject({
      status: "success",
      toolCallId: "call-legitimate-tool",
      toolName: "empty_tool_name",
    });
    expect(eventsCoverTranscript(events, messages)).toBe(true);
  });

  it("无 user 消息的 transcript → 视为已覆盖（不触发合成）", () => {
    expect(eventsCoverTranscript([], [])).toBe(true);
  });

  it("确定性：同一 transcript 合成两次逐字节相等", () => {
    const messages = [userMessage("u1", "x", 1000), assistantMessage("a1", "u1", "y", 1001)];
    const a = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    const b = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── M5④ 附件渲染：FilePart → 合成 TurnStarted.attachments → row.attachments ──
describe("transcript 附件合成（M5④）", () => {
  function userMessageWithFile(id: string, text: string, created: number): MessageWithParts {
    const base = userMessage(id, text, created);
    return {
      ...base,
      info: {
        ...base.info,
        anchor: { sourceCommandId: "command-cold" },
        metadata: {
          conversationInputIntent: {
            sourceCommandId: "command-cold",
            queueItemId: "queue_command-cold",
            clientId: "mobile-cold",
            kind: "sendText",
            text,
            attachments: [],
            delivery: { requested: "startNow", admitted: "startNow" },
            order: { admissionSeq: 8 },
            steer: { state: "notRequested" },
            dispatch: { state: "drained" },
            admittedAt: 999,
          },
        },
      },
      parts: [
        ...base.parts,
        {
          id: `${id}-f1` as never,
          sessionID: "s1" as never,
          messageID: id as never,
          type: "file",
          mime: "image/png",
          filename: "diagram.png",
          url: "/workspace/diagram.png",
          metadata: { sizeBytes: 2048 },
        },
        // data URL：无稳定引用 → ref 缺省；filename 缺省 → 序号占位。
        {
          id: `${id}-f2` as never,
          sessionID: "s1" as never,
          messageID: id as never,
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGk=",
        },
      ],
    };
  }

  it("file parts 进入 userInput row.attachments（冷路径与 live 同一投影入口）", () => {
    const { projection } = reduce([
      userMessageWithFile("u1", "看图", 1000),
      assistantMessage("a1", "u1", "好的", 2000),
    ]);
    const userInput = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    const attachments = userInput?.kind === "userInput" ? userInput.attachments : undefined;
    expect(userInput).toMatchObject({
      sourceCommandId: "command-cold",
      clientId: "mobile-cold",
    });
    expect(attachments).toHaveLength(2);
    expect(attachments?.[0]).toEqual({
      ref: "/workspace/diagram.png",
      fileName: "diagram.png",
      mime: "image/png",
      bytes: 2048,
    });
    expect(attachments?.[1]).toMatchObject({
      fileName: "attachment-2",
      mime: "text/plain",
      bytes: 0,
    });
  });

  it("无 file part 的消息不带 attachments（合成保持最小序列）", () => {
    const { projection } = reduce([
      userMessage("u1", "纯文本", 1000),
      assistantMessage("a1", "u1", "好的", 2000),
    ]);
    const userInput = projection.getSnapshot().rows.window.find((row) => row.kind === "userInput");
    expect(userInput?.kind === "userInput" ? "attachments" in userInput : null).toBe(false);
  });

  // ── 16-timeline-authority-plan P1 golden ──

  it("GV-cold：goal_verification timeline part 冷恢复后 marker 仍在（含身份/结论/无 goal 状态不丢）", () => {
    const messages = [
      userMessage("u1", "修 lint", 1000),
      assistantMessage("a1", "u1", "修好了", 1001),
      goalVerificationHostMessage("gv1", "a1", 2000, {
        status: "completed",
        goalIteration: 1,
        verification: { passed: true, reason: "全部通过" },
      }),
    ];
    // 空事件日志对含 goal verify 的 transcript 不再被误判为已覆盖（守恒判据曾对此全盲）。
    const turnOnlyEvents = synthesizeEventsFromMessages(
      [userMessage("u1", "修 lint", 1000), assistantMessage("a1", "u1", "修好了", 1001)],
      { sessionId: "s1" },
    );
    expect(eventsCoverTranscript(turnOnlyEvents, messages)).toBe(false);

    const { events, projection } = reduce(messages);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
    const marker = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify");
    expect(marker?.kind === "timelineMarker" ? marker.marker : null).toMatchObject({
      type: "goalVerify",
      iteration: 1,
      outcome: "pass",
    });
    // 合成事件流没有 TargetChanged → goal 状态保持 null，但 boundary 不再被整条丢弃。
    expect(projection.getSnapshot().goal).toBeNull();
  });

  it("GV-cold：started 态残留的 verifier 冷恢复收口为 failed(cancelled)，不复活 running", () => {
    const { projection } = reduce([
      userMessage("u1", "修 lint", 1000),
      assistantMessage("a1", "u1", "修好了", 1001),
      goalVerificationHostMessage("gv1", "a1", 2000, { status: "started", goalIteration: 2 }),
    ]);
    const marker = projection
      .getSnapshot()
      .rows.window.find((row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify");
    expect(marker?.kind === "timelineMarker" ? marker.marker : null).toMatchObject({
      iteration: 2,
      outcome: "failed",
      detail: "cancelled",
    });
    // 冷恢复不得复活 active work / stop 入口。
    expect(projection.getSnapshot().control.activeWorks).toEqual([]);
  });

  it("MC-cold：相邻轮持久化选型不同 → modelChange marker 重建；首轮不产 marker", () => {
    const messages = [
      userMessageWithModel("u1", "先用 A", 1000, { providerId: "p1", modelId: "m1" }),
      assistantMessage("a1", "u1", "好的", 1001),
      userMessageWithModel("u2", "换 B 再来", 2000, { providerId: "p2", modelId: "m2" }),
      assistantMessage("a2", "u2", "已切换", 2001),
    ];
    const { events, projection } = reduce(messages);
    expect(eventsCoverTranscript(events, messages)).toBe(true);
    const markers = projection
      .getSnapshot()
      .rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.kind === "timelineMarker" ? markers[0].marker : null).toMatchObject({
      type: "modelChange",
      fromProvider: "p1",
      fromModel: "m1",
      toProvider: "p2",
      toModel: "m2",
    });
    // marker 位于第二轮 turnHeader 之前（同 turnId、先 append）。
    const rows = projection.getSnapshot().rows.window;
    const markerIndex = rows.findIndex(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    );
    const secondHeaderIndex = rows.findIndex(
      (row, index) =>
        row.kind === "turnHeader" && index > 0 && rows[index]!.turnId === rows[markerIndex]!.turnId,
    );
    expect(markerIndex).toBeGreaterThan(-1);
    expect(secondHeaderIndex).toBe(markerIndex + 1);
  });

  it("MC-cold：Highspeed 单轮执行模型不参与普通模型切换基线", () => {
    const messages = [
      userMessageWithModel("u1", "普通模型执行", 1000, { providerId: "p1", modelId: "m1" }),
      assistantMessage("a1", "u1", "完成", 1001),
      // 加速轮持久化的 Selection 指向隐藏的加速卡内建 Provider，冷恢复必须按 Family 谓词
      // 识别并跳过，不能参与 modelChange 基线。
      userMessageWithModel("u2", "加速执行", 2000, {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      }),
      assistantMessage("a2", "u2", "加速完成", 2001),
      userMessageWithModel("u3", "继续使用普通模型", 3000, {
        providerId: "p1",
        modelId: "m1",
      }),
      assistantMessage("a3", "u3", "完成", 3001),
    ];
    const { events, projection } = reduce(messages);

    expect(eventsCoverTranscript(events, messages)).toBe(true);
    expect(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
        ),
    ).toHaveLength(0);
  });

  it("MC-cold：Highspeed 后真实切换普通模型仍重建原普通模型到新模型的 marker", () => {
    const messages = [
      userMessageWithModel("u1", "普通模型 A", 1000, { providerId: "p1", modelId: "m1" }),
      assistantMessage("a1", "u1", "完成", 1001),
      userMessageWithModel("u2", "加速执行", 2000, {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      }),
      assistantMessage("a2", "u2", "加速完成", 2001),
      userMessageWithModel("u3", "切换普通模型 B", 3000, {
        providerId: "p2",
        modelId: "m2",
      }),
      assistantMessage("a3", "u3", "完成", 3001),
    ];
    const { events, projection } = reduce(messages);
    const markers = projection
      .getSnapshot()
      .rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      );

    expect(eventsCoverTranscript(events, messages)).toBe(true);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      marker: {
        type: "modelChange",
        fromProvider: "p1",
        fromModel: "m1",
        toProvider: "p2",
        toModel: "m2",
      },
    });
  });

  it("MC-cold：source-less model_change 恢复 Subagent 初始模型 marker 且只出现一次", () => {
    const messages = [
      initialModelHostMessage("mc-initial", 900),
      userMessageWithModel("u1", "child prompt", 1000, {
        providerId: "child-provider",
        modelId: "child-model",
      }),
      assistantMessage("a1", "u1", "done", 1001),
    ];
    const { events, projection } = reduce(messages);
    const markers = projection
      .getSnapshot()
      .rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      );

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      marker: {
        type: "modelChange",
        toProvider: "child-provider",
        toModel: "child-model",
      },
    });
    expect(markers[0]?.kind === "timelineMarker" ? markers[0].marker : {}).not.toHaveProperty(
      "fromModel",
    );
    expect(events.filter((event) => event.type === SessionEventType.ModelSelected)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ previousModelSelection: null }),
      }),
    ]);
  });

  it("assistant-head-skip：首条真实用户消息之前的 assistant 回复不再整段消失", () => {
    // 会话头部是 compact summary（providerContextOnly，非真实用户）→ 其后的 assistant
    // 回复旧实现整段跳过：刷新后「上一轮回复没了」的冷路径向量。
    const messages = [
      syntheticUserMessage("u_sum", "compact 摘要", 900, {
        semantics: { kind: "compact_summary" } as never,
      }),
      assistantMessage("a0", "u_sum", "基于摘要继续的回复", 901),
      userMessage("u1", "下一个问题", 2000),
      assistantMessage("a1", "u1", "答", 2001),
    ];
    const { projection } = reduce(messages);
    const rows = projection.getSnapshot().rows.window;
    const assistantTexts = rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => (row.kind === "assistantText" ? row.text : ""));
    expect(assistantTexts).toEqual(["基于摘要继续的回复", "答"]);
    // preface 轮是 model-only：不产可见 user 气泡，可见 user 轮数不受影响。
    const userRows = rows.filter((row) => row.kind === "userInput");
    expect(userRows).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "turnHeader")).toHaveLength(2);
  });

  it("GV-cold-session_entry：goal verify 只存在 legacy session_entry 时冷恢复可重建（含生命周期合并/锚定落位）", () => {
    const messages = [
      userMessage("u1", "修 lint", 1000),
      assistantMessage("a1", "u1", "修好了", 1001),
      userMessage("u2", "再看看测试", 2000),
      assistantMessage("a2", "u2", "测试也过了", 2001),
    ];
    // legacy 形态：同一 verification 的 started/terminal 各一条 entry，无 timeline part。
    const goalVerificationEntries = [
      {
        payload: {
          targetId: "target-1",
          status: "started",
          verificationId: "v1",
          goalIteration: 1,
          anchorAssistantMessageId: "a1",
        },
        sequenceNumber: 5,
        timeCreated: 1500,
      },
      {
        payload: {
          targetId: "target-1",
          status: "completed",
          verificationId: "v1",
          goalIteration: 1,
          anchorAssistantMessageId: "a1",
          verification: { passed: true, reason: "ok" },
        },
        sequenceNumber: 9,
        timeCreated: 1600,
      },
    ];
    // 覆盖判据必须看见 entry 源：空事件日志不再被误判为已覆盖。
    const turnOnlyEvents = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    expect(eventsCoverTranscript(turnOnlyEvents, messages, { goalVerificationEntries })).toBe(
      false,
    );

    const events = synthesizeEventsFromMessages(messages, {
      sessionId: "s1",
      goalVerificationEntries,
    });
    expect(eventsCoverTranscript(events, messages, { goalVerificationEntries })).toBe(true);
    const projection = new ProductProjection("s1", "epoch");
    for (const event of events) projection.applyEvent(event);
    const rows = projection.getSnapshot().rows.window;
    const markers = rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    );
    // 生命周期两条 entry 合并为单一 marker，终态覆盖 started。
    expect(markers).toHaveLength(1);
    expect(markers[0]?.kind === "timelineMarker" ? markers[0].marker : null).toMatchObject({
      iteration: 1,
      outcome: "pass",
    });
    // 锚定落位：marker 归属 a1 所在的第一轮（turn tail），不漂到第二轮之后。
    const markerIndex = rows.findIndex(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    );
    const secondTurnFirstIndex = rows.findIndex(
      (row) => row.kind === "userInput" && row.text === "再看看测试",
    );
    expect(markerIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeLessThan(secondTurnFirstIndex);
  });

  it("GV 跨源去重：timeline part 与 session_entry 表达同一事实 → 单一 marker；无 anchor 的 entry 落尾不丢", () => {
    const messages = [
      userMessage("u1", "修 lint", 1000),
      assistantMessage("a1", "u1", "修好了", 1001),
      goalVerificationHostMessage("gv1", "a1", 1500, {
        status: "completed",
        goalIteration: 1,
        verification: { passed: true, reason: "ok" },
      }),
    ];
    const goalVerificationEntries = [
      // 与 part 同 key（target-1_1）：去重，不产生第二个 marker。
      {
        payload: {
          targetId: "target-1",
          status: "completed",
          verificationId: "verify-gv1",
          goalIteration: 1,
          anchorAssistantMessageId: "a1",
          verification: { passed: true, reason: "ok" },
        },
        timeCreated: 1500,
      },
      // 无 anchor 的孤儿 entry（iteration 2）：落到已知时间线末尾，不静默丢。
      {
        payload: {
          targetId: "target-1",
          status: "completed",
          verificationId: "v-orphan",
          goalIteration: 2,
          verification: { passed: false, reason: "还差一点" },
        },
        timeCreated: 1700,
      },
    ];
    const events = synthesizeEventsFromMessages(messages, {
      sessionId: "s1",
      goalVerificationEntries,
    });
    const projection = new ProductProjection("s1", "epoch");
    for (const event of events) projection.applyEvent(event);
    const markers = projection
      .getSnapshot()
      .rows.window.filter(
        (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
      );
    expect(markers.map((row) => (row.kind === "timelineMarker" ? row.marker : null))).toEqual([
      expect.objectContaining({ iteration: 1, outcome: "pass" }),
      expect.objectContaining({ iteration: 2, outcome: "notSatisfied" }),
    ]);
  });

  it("S1 cold：guide steer 持久标记内联当前轮；queue 标记独立轮（与 live 切分一致）", () => {
    const withDelivery = (
      message: MessageWithParts,
      delivery: "guide" | "queue",
    ): MessageWithParts => ({
      ...message,
      info: {
        ...message.info,
        metadata: { turnSteerDelivery: delivery },
      } as MessageWithParts["info"],
    });
    const messages = [
      userMessage("u1", "问题一", 1000),
      assistantMessage("a1", "u1", "回答一", 1001),
      withDelivery(userMessage("u_steer", "补充说明", 1500), "guide"),
      assistantMessage("a2", "u1", "回答二", 1600),
      withDelivery(userMessage("u_q2", "排队问题", 2000), "queue"),
      assistantMessage("a3", "u_q2", "排队回答", 2001),
    ];
    const { projection } = reduce(messages);
    const rows = projection.getSnapshot().rows.window;
    // guide steer 内联：u_steer 与 a1/a2 同轮；queue 项独立轮。
    const visible = rows
      .filter((row) => row.kind === "userInput" || row.kind === "assistantText")
      .map((row) => [
        row.turnId,
        row.kind === "userInput" || row.kind === "assistantText" ? row.text : "",
      ]);
    expect(visible).toEqual([
      ["u1", "问题一"],
      ["u1", "回答一"],
      ["u1", "补充说明"],
      ["u1", "回答二"],
      ["u_q2", "排队问题"],
      ["u_q2", "排队回答"],
    ]);
    expect(rows.filter((row) => row.kind === "turnHeader")).toHaveLength(2);
    // 内联 steer 行登记了持久 messageId（entityId 派生）。
    const steerRow = rows.find((row) => row.kind === "userInput" && row.text === "补充说明");
    expect(projection.getMessageIdForRow(steerRow!.rowId)).toBe("u_steer");
    const guideHeader = rows.find((row) => row.kind === "turnHeader" && row.turnId === "u1");
    expect(guideHeader).toMatchObject({
      workSegments: [
        { segmentId: "u1:initial", startedAt: 1000, endedAt: 1500, activeMs: 500 },
        {
          segmentId: "u_steer",
          triggerEntityId: "u_steer",
          startedAt: 1500,
          endedAt: 1601,
          activeMs: 101,
        },
      ],
    });
  });

  it.each([
    ["中间没有 assistant：同一次取出，共用一段", false, ["u1:initial", "u_g1"]],
    [
      "中间有一条没有可见内容的 assistant：两次取出，各开一段",
      true,
      ["u1:initial", "u_g1", "u_g2"],
    ],
  ])("M06f cold：相邻两条 guide，%s", (_label, hiddenStepBetween, segmentIds) => {
    const guide = (id: string, text: string, created: number): MessageWithParts => {
      const message = userMessage(id, text, created);
      return {
        ...message,
        info: {
          ...message.info,
          metadata: { turnSteerDelivery: "guide" },
        } as MessageWithParts["info"],
      };
    };
    const messages = [
      userMessage("u1", "问题一", 1000),
      assistantMessage("a1", "u1", "回答一", 1001),
      guide("u_g1", "引导一", 1500),
      ...(hiddenStepBetween ? [assistantMessage("a_hidden", "u1", "", 1550)] : []),
      guide("u_g2", "引导二", 1600),
      assistantMessage("a2", "u1", "回答二", 1700),
    ];
    const rows = reduce(messages).projection.getSnapshot().rows.window;
    const header = rows.find((row) => row.kind === "turnHeader");
    expect(
      header?.kind === "turnHeader"
        ? header.workSegments?.map((segment) => segment.segmentId)
        : undefined,
    ).toEqual(segmentIds);
  });

  it("S1 cold：guide steer 从持久 metadata 恢复完整 intent，row 与 live 字段保真", () => {
    const guide = userMessage("u_guide", "带附件补充", 1500);
    const attachment = {
      ref: "attachment://guide-1",
      fileName: "guide.png",
      mime: "image/png",
      bytes: 2048,
      previewRef: "preview://guide-1",
    };
    const messages: MessageWithParts[] = [
      userMessage("u1", "问题一", 1000),
      assistantMessage("a1", "u1", "回答一", 1001),
      {
        ...guide,
        info: {
          ...guide.info,
          anchor: { sourceCommandId: "command-guide-1" },
          metadata: {
            turnSteerDelivery: "guide",
            conversationInputIntent: {
              sourceCommandId: "command-guide-1",
              queueItemId: "queue_command-guide-1",
              clientId: "mobile-guide",
              kind: "sendGoalCommand",
              text: "带附件补充",
              attachments: [attachment],
              delivery: {
                requested: "guide",
                admitted: "guide",
                fallbackReasonCode: "guide_fallback_test",
              },
              order: { admissionSeq: 19, queuePosition: 2 },
              steer: { state: "guided" },
              dispatch: { state: "drained" },
              admittedAt: 1499,
            },
          },
        } as MessageWithParts["info"],
      },
      assistantMessage("a2", "u1", "回答二", 1600),
    ];

    const events = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    const drained = events.find((event) => event.type === SessionEventType.TurnSteerDrained);
    expect(drained?.payload).toMatchObject({
      pendingInputIds: ["queue_command-guide-1"],
      drainedInputs: [
        {
          pendingInputId: "queue_command-guide-1",
          messageId: "u_guide",
          text: "带附件补充",
          delivery: "guide",
          intent: {
            sourceCommandId: "command-guide-1",
            queueItemId: "queue_command-guide-1",
            clientId: "mobile-guide",
            kind: "sendGoalCommand",
            admissionSeq: 19,
            queuePosition: 2,
            admittedAt: 1499,
            requestedDelivery: "guide",
            admittedDelivery: "guide",
            fallbackReasonCode: "guide_fallback_test",
            attachmentRefs: [attachment],
          },
        },
      ],
    });

    const projection = new ProductProjection("s1", "epoch");
    for (const event of events) projection.applyEvent(event);
    const row = projection
      .getSnapshot()
      .rows.window.find((candidate) => candidate.kind === "userInput" && candidate.guided);
    expect(row).toMatchObject({
      turnId: "u1",
      text: "带附件补充",
      guided: true,
      sourceCommandId: "command-guide-1",
      clientId: "mobile-guide",
      attachments: [attachment],
    });
  });

  it("timeline 宿主消息（model_change）不开 preface 空轮", () => {
    const messages = [
      userMessageWithModel("u1", "先用 A", 1000, { providerId: "p1", modelId: "m1" }),
      assistantMessage("a1", "u1", "好的", 1001),
      modelChangeHostMessage("mc1", "a1", 1500),
      userMessageWithModel("u2", "换 B", 2000, { providerId: "p2", modelId: "m2" }),
      assistantMessage("a2", "u2", "已切换", 2001),
    ];
    const { projection } = reduce(messages);
    const rows = projection.getSnapshot().rows.window;
    // 宿主消息本身无可渲染内容：不产生第三个 turnHeader，也不产生空「已工作」壳。
    expect(rows.filter((row) => row.kind === "turnHeader")).toHaveLength(2);
    // marker 仍由选型事实重建（宿主的 defaultModelSelection 占位不参与选型来源）。
    expect(
      rows.filter((row) => row.kind === "timelineMarker" && row.marker.type === "modelChange"),
    ).toHaveLength(1);
  });

  it("MC-cold：model_change timeline part 在后续 user model 快照滞后时仍是边界权威", () => {
    const messages = [
      userMessageWithModel("u1", "先用 A", 1000, { providerId: "p1", modelId: "m1" }),
      assistantMessage("a1", "u1", "好的", 1001),
      modelChangeHostMessage("mc1", "a1", 1500),
      syntheticUserMessage("legacy-context", "internal context", 1600, {
        source: "rewind",
        visibility: "model-only",
      }),
      // 模拟旧数据：user message 仍带上一轮快照，但 timeline part 已持久 p2/m2。
      userMessageWithModel("u2", "换 B", 2000, { providerId: "p1", modelId: "m1" }),
      assistantMessage("a2", "u2", "已切换", 2001),
    ];
    const { events, projection } = reduce(messages);
    const marker = projection
      .getSnapshot()
      .rows.window.find(
        (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
      );

    expect(marker).toEqual(
      expect.objectContaining({
        marker: expect.objectContaining({
          fromProvider: "p1",
          fromModel: "m1",
          toProvider: "p2",
          toModel: "m2",
        }),
      }),
    );
    expect(
      eventsCoverTranscript(
        events.filter((event) => event.type !== SessionEventType.ModelSelected),
        messages,
      ),
    ).toBe(false);
  });
});

function userMessageWithModel(
  id: string,
  text: string,
  created: number,
  model: { providerId: string; modelId: string; reasoningLevel?: string },
): MessageWithParts {
  const base = userMessage(id, text, created);
  return {
    ...base,
    info: {
      ...base.info,
      modelSelection: {
        providerId: model.providerId as never,
        modelId: model.modelId as never,
        ...(model.reasoningLevel ? { options: { reasoningLevel: model.reasoningLevel } } : {}),
      },
    } as MessageWithParts["info"],
  };
}

const TIMELINE_HOST_SEMANTICS = {
  origin: "system",
  kind: "timeline_event",
  uiVisibility: "visible",
  providerVisibility: "hidden",
  transcriptVisibility: "visible",
} as never;

function goalVerificationHostMessage(
  id: string,
  parentId: string,
  created: number,
  overrides: {
    status: string;
    goalIteration?: number;
    verification?: { passed: boolean; reason: string };
  },
): MessageWithParts {
  const base = assistantMessage(id, parentId, "", created);
  return {
    ...base,
    info: { ...base.info, semantics: TIMELINE_HOST_SEMANTICS } as MessageWithParts["info"],
    parts: [
      {
        id: `${id}-timeline` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "timeline",
        timelineType: "goal_verification",
        display: "separator",
        status: overrides.status,
        targetId: "target-1",
        verificationId: `verify-${id}`,
        ...(overrides.goalIteration !== undefined
          ? { goalIteration: overrides.goalIteration }
          : {}),
        anchorMessageId: parentId as never,
        ...(overrides.verification ? { verification: overrides.verification } : {}),
      } as MessagePart,
    ],
  };
}

function modelChangeHostMessage(id: string, parentId: string, created: number): MessageWithParts {
  const base = assistantMessage(id, parentId, "", created);
  return {
    ...base,
    info: { ...base.info, semantics: TIMELINE_HOST_SEMANTICS } as MessageWithParts["info"],
    parts: [
      {
        id: `${id}-timeline` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        status: "completed",
        anchorMessageId: parentId as never,
        fromModel: { providerId: "p1" as never, modelId: "m1" as never, label: "A" },
        toModel: { providerId: "p2" as never, modelId: "m2" as never, label: "B" },
      } as MessagePart,
    ],
  };
}

function initialModelHostMessage(id: string, created: number): MessageWithParts {
  // 首条 timeline 事实没有上一条 conversation message，运行时会把 parentID
  // 固定为自身。测试必须保持这一真实持久化形态，防止冷恢复只在理想夹具下通过。
  const base = assistantMessage(id, id, "", created);
  return {
    ...base,
    info: { ...base.info, semantics: TIMELINE_HOST_SEMANTICS } as MessageWithParts["info"],
    parts: [
      {
        id: `${id}-timeline` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        status: "completed",
        toModel: {
          providerId: "child-provider" as never,
          modelId: "child-model" as never,
          label: "Child Model",
        },
      } as MessagePart,
    ],
  };
}

// 中枢直接启动已保存工作流的启动轮（docs/dynamic-workflow/launch.md）：冷恢复由 source
// "workflow_launch" + metadata.workflowLaunch 重建可见 controlOnly 启动轮。这条消息是 synthetic
// 却语义上属用户真实动作，共享 policy 会把它归成 hiddenSynthetic；若无专用分支就会被跳过。
// 断言：冷路径产出的 turnHeader/userInput 行在相关字段上与活投影逐字相等（origin/executionKind/
// text/workflowLaunch），且无助手行。
describe("workflow-direct-launch 启动轮冷恢复", () => {
  const workflowLaunch = {
    runId: "dwfrun-9",
    toolCallId: "launch-abc",
    name: "deep-research",
    scope: "global" as const,
    path: "/home/u/.zcode/workflows/deep-research.ts",
    args: { topic: "adaptive concurrency" },
    description: "Deep-dive a topic",
  };
  const launchText = 'Started the saved workflow "deep-research" (global) as run dwfrun-9.';
  // GUI「配置」的设置轮（docs/dynamic-workflow/launch.md「The settings turn」）：同一条冷路径，元数据
  // 没有 scope / path，多一块 amend。
  const settingsLaunch = {
    runId: "dwfrun-10",
    toolCallId: "settings-abc",
    name: "deep-research",
    amend: {
      predecessorRunId: "dwfrun-9",
      maxConcurrency: { from: 13, to: 4 },
      ceiling: 13,
    },
  };

  function launchMessage(meta: object = workflowLaunch): MessageWithParts {
    return syntheticUserMessage("message-launch-1", launchText, 1_700_000_000_000, {
      source: "workflow_launch",
      visibility: "user-visible",
      metadata: { workflowLaunch: meta },
      semantics: {
        origin: "real_user",
        kind: "user_prompt",
        source: "workflow_launch",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      } as MessageWithParts["info"]["semantics"],
    });
  }

  // 相关字段投影：跨 live/cold 稳定（不含 rowId / turnId / createdAt 这些身份差异字段）。
  function relevantRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: row.kind,
      origin: row.origin,
      ...(row.executionKind !== undefined ? { executionKind: row.executionKind } : {}),
      ...(row.state !== undefined ? { state: row.state } : {}),
      ...(row.text !== undefined ? { text: row.text } : {}),
      ...(row.workflowLaunch !== undefined ? { workflowLaunch: row.workflowLaunch } : {}),
    };
  }

  function liveRows(meta: object = workflowLaunch): Record<string, unknown>[] {
    const projection = new ProductProjection("s1", "epoch");
    const base = (seq: number) => ({
      id: `event-${seq}` as never,
      sessionId: "s1" as never,
      traceId: "trace-live" as never,
      sequenceNumber: seq,
      timestamp: new Date(1_700_000_000_000 + seq),
    });
    const events: SessionEvent[] = [
      {
        ...base(1),
        type: SessionEventType.SessionCreated,
        payload: { mode: "default", contextWindow: 200_000 },
      } as unknown as SessionEvent,
      {
        ...base(2),
        turnId: "turn-launch" as never,
        type: SessionEventType.TurnStarted,
        payload: {
          turnNumber: 1,
          input: launchText,
          messageId: "message-launch-1",
          executionKind: "controlOnly",
          inputSource: "workflow_launch",
          workflowLaunch: meta,
        },
      } as unknown as SessionEvent,
      {
        ...base(3),
        turnId: "turn-launch" as never,
        type: SessionEventType.TurnComplete,
        payload: {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 0,
          resultType: "success",
        },
      } as unknown as SessionEvent,
    ];
    for (const event of events) projection.applyEvent(event);
    return projection
      .getSnapshot()
      .rows.window.map((row) => relevantRow(row as Record<string, unknown>));
  }

  it("冷恢复重建双行（origin=workflowLaunch + 元数据），且与活投影相关字段逐字相等，无助手行", () => {
    const { projection } = reduce([launchMessage()]);
    const coldRows = projection
      .getSnapshot()
      .rows.window.map((row) => relevantRow(row as Record<string, unknown>));

    expect(coldRows).toEqual([
      {
        kind: "turnHeader",
        origin: "workflowLaunch",
        executionKind: "controlOnly",
        state: "completedSuccess",
        workflowLaunch,
      },
      {
        kind: "userInput",
        origin: "workflowLaunch",
        text: launchText,
        workflowLaunch,
      },
    ]);
    // 冷热同形：相关字段逐字相等（rowId/turnId 等身份字段除外）。
    expect(coldRows).toEqual(liveRows());
  });

  it("设置轮（无 scope / path、带 amend 块）走同一条冷路径，冷热同形", () => {
    const { projection } = reduce([launchMessage(settingsLaunch)]);
    const coldRows = projection
      .getSnapshot()
      .rows.window.map((row) => relevantRow(row as Record<string, unknown>));

    expect(coldRows).toEqual([
      {
        kind: "turnHeader",
        origin: "workflowLaunch",
        executionKind: "controlOnly",
        state: "completedSuccess",
        workflowLaunch: settingsLaunch,
      },
      {
        kind: "userInput",
        origin: "workflowLaunch",
        text: launchText,
        workflowLaunch: settingsLaunch,
      },
    ]);
    expect(coldRows).toEqual(liveRows(settingsLaunch));
  });
});

// docs/dynamic-workflow/transcript-and-notifications.md：冷路径从用户消息 metadata 读回边界，
// 与热路径落在同一个 TurnStarted 字段上；非非负整数按缺席处理。
describe("epilogueStart 冷恢复", () => {
  function turnStartedOf(events: SessionEvent[], messageId: string) {
    return events.find(
      (event) =>
        event.type === SessionEventType.TurnStarted &&
        (event.payload as { messageId?: string }).messageId === messageId,
    );
  }

  it("metadata.epilogueStart → TurnStarted.epilogueStart → userInput 行", () => {
    const ask = userMessage("u-ask", "Summarize\n\n---\nStandard", 1000);
    ask.info.metadata = { epilogueStart: 9 };
    const nudge = userMessage("u-nudge", "You ended your turn without submitting a result.", 2000);
    nudge.info.metadata = { epilogueStart: 0 };
    const plain = userMessage("u-plain", "plain", 3000);
    const bogus = userMessage("u-bogus", "bogus", 4000);
    bogus.info.metadata = { epilogueStart: -3 };
    const events = synthesizeEventsFromMessages([ask, nudge, plain, bogus], { sessionId: "s1" });
    expect(turnStartedOf(events, "u-ask")?.payload).toMatchObject({ epilogueStart: 9 });
    expect(turnStartedOf(events, "u-nudge")?.payload).toMatchObject({ epilogueStart: 0 });
    expect(turnStartedOf(events, "u-plain")?.payload).not.toHaveProperty("epilogueStart");
    expect(turnStartedOf(events, "u-bogus")?.payload).not.toHaveProperty("epilogueStart");

    const projection = new ProductProjection("s1", "epoch");
    for (const event of events) projection.applyEvent(event);
    const rows = projection.getSnapshot().rows.window.filter((row) => row.kind === "userInput");
    expect(rows.map((row) => (row.kind === "userInput" ? row.epilogueStart : null))).toEqual([
      9,
      0,
      undefined,
      undefined,
    ]);
  });
});

it("cold canonical input retains Gen UI context for edit/retry while rows expose only text", () => {
  const message = userMessage("gen-ui-input", "Question", 1000);
  const genUiContext = [{ path: "/project/page.html", state: "FROZEN_CONTEXT" }];
  message.info.metadata = {
    conversationInputIntent: {
      sourceCommandId: "gen-ui-command",
      queueItemId: "gen-ui-queue",
      clientId: "desktop",
      kind: "sendText",
      text: "Question",
      genUiContext,
      attachments: [],
      delivery: { requested: "startNow", admitted: "startNow" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "drained" },
      admittedAt: 999,
    },
  };
  const { projection } = reduce([
    message,
    assistantMessage("gen-ui-reply", "gen-ui-input", "Done", 1001),
  ]);
  expect(projection.resolveEditTargetByEntityId("gen-ui-input")?.intent).toMatchObject({
    text: "Question",
    genUiContext,
  });
  expect(JSON.stringify(projection.getSnapshot().rows)).not.toContain("FROZEN_CONTEXT");
});

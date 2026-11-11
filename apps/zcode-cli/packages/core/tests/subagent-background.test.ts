import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createTurnId,
  modelMessageContentToText,
  type BackgroundResultOriginMeta,
  type CreateSessionInput,
  type ModelMessageContent,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PermissionRuleset,
  type SessionEvent,
  type SessionGoal,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type TodoItem,
} from "@zcode/contracts";
import { formatTaskNotification } from "../src/runtime-task/notification.js";
import {
  formatLocalAgentTaskNotification,
  localAgentSubagentResult,
} from "../src/subagent/completion-notification.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createRuntimeCommandId } from "../src/runtime/command-queue.js";
import type { PromptRuntimeCommand } from "../src/runtime/command-queue.js";
import { createTurnFailureError } from "../src/runtime/helpers/turn-errors.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import {
  waitForCondition,
  createSubagentRunRequest,
  createDeferred,
} from "./subagent-background-fixture.js";

// 后台 agent 通知的固定 <note>；测试里写死，锁定字节。
const LOCAL_AGENT_NOTE =
  "A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.";

describe("subagent background notifications", () => {
  it("formats local_agent task notification as user-role XML", () => {
    const notification = formatTaskNotification({
      outputFile: "/tmp/zcode-agents/sess/agent/output.txt",
      result: "child result",
      status: "completed",
      summary: 'Agent "Audit tests" completed',
      taskId: "agent_123",
      taskType: "local_agent",
      toolUseId: "toolu_123",
      usage: {
        durationMs: 42,
        toolUseCount: 2,
        totalTokens: 9,
      },
    });

    expect(notification).toBe(
      [
        "<task-notification>",
        "<task-id>agent_123</task-id>",
        "<tool-use-id>toolu_123</tool-use-id>",
        "<output-file>/tmp/zcode-agents/sess/agent/output.txt</output-file>",
        "<status>completed</status>",
        '<summary>Agent "Audit tests" completed</summary>',
        `<note>${LOCAL_AGENT_NOTE}</note>`,
        "<result>child result</result>",
        "<usage><subagent_tokens>9</subagent_tokens><tool_uses>2</tool_uses><duration_ms>42</duration_ms></usage>",
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("omits unavailable local_agent usage fields", () => {
    const notification = formatTaskNotification({
      outputFile: "/tmp/output.txt",
      status: "completed",
      summary: "Agent completed",
      taskId: "agent_456",
      taskType: "local_agent",
      usage: {
        durationMs: 25,
      },
    });

    expect(notification).toContain("<usage><duration_ms>25</duration_ms></usage>");
    expect(notification).not.toContain("subagent_tokens");
    expect(notification).not.toContain("tool_uses");
  });

  // summary 措辞、每条都带 <note>、只转义 & < >、不输出 <error>；
  // failed / killed 不带 usage，killed 按停止者措辞。
  it("formats completed, failed, and killed local-agent notifications with the terminal notification shape", () => {
    const base = {
      agentId: "agent_helper",
      description: 'Review "auth" changes',
      outputFile: "/tmp/agent_helper/output.txt",
      parentToolCallId: "toolu_helper",
      totalDurationMs: 12,
    };
    const header = [
      "<task-notification>",
      "<task-id>agent_helper</task-id>",
      "<tool-use-id>toolu_helper</tool-use-id>",
      "<output-file>/tmp/agent_helper/output.txt</output-file>",
    ];
    const note = `<note>${LOCAL_AGENT_NOTE}</note>`;

    const completed = formatLocalAgentTaskNotification({
      ...base,
      result: 'It\'s done <ok> & "clean".',
      status: "completed",
      totalTokens: 7,
      totalToolUseCount: 1,
    });
    const failed = formatLocalAgentTaskNotification({
      ...base,
      error: "child failed",
      status: "failed",
    });
    const failedWithoutReason = formatLocalAgentTaskNotification({
      ...base,
      error: "",
      status: "failed",
    });
    const stoppedByModel = formatLocalAgentTaskNotification({
      ...base,
      status: "killed",
      stoppedBy: "model",
    });
    const stoppedByUser = formatLocalAgentTaskNotification({
      ...base,
      status: "killed",
      stoppedBy: "user",
    });
    const stoppedBySystem = formatLocalAgentTaskNotification({
      ...base,
      status: "killed",
    });

    expect(completed).toBe(
      [
        ...header,
        "<status>completed</status>",
        '<summary>Agent "Review "auth" changes" finished</summary>',
        note,
        '<result>It\'s done &lt;ok&gt; &amp; "clean".</result>',
        "<usage><subagent_tokens>7</subagent_tokens><tool_uses>1</tool_uses><duration_ms>12</duration_ms></usage>",
        "</task-notification>",
      ].join("\n"),
    );
    expect(failed).toBe(
      [
        ...header,
        "<status>failed</status>",
        '<summary>Agent "Review "auth" changes" failed: child failed</summary>',
        note,
        "</task-notification>",
      ].join("\n"),
    );
    expect(failedWithoutReason).toContain(
      '<summary>Agent "Review "auth" changes" failed: Unknown error</summary>',
    );
    // 只有空白的失败原因与空串相同：summary 和结构化 error 都用 Unknown error。
    const blankError = { error: " \n\t", status: "failed" as const };
    expect(formatLocalAgentTaskNotification({ ...base, ...blankError })).toContain(
      '<summary>Agent "Review "auth" changes" failed: Unknown error</summary>',
    );
    expect(localAgentSubagentResult(blankError)).toEqual({
      status: "failed",
      error: "Unknown error",
    });
    // 结构化 error 进入每一帧快照，需要上限；截断点落在代理对中间时丢掉半个字符。
    const longError = `${"x".repeat(1998)}😀${"y".repeat(600)}`;
    const longResult = localAgentSubagentResult({ error: longError, status: "failed" });
    expect(longResult.error).toBe(`${"x".repeat(1998)}…`);
    expect(
      formatLocalAgentTaskNotification({ ...base, error: longError, status: "failed" }),
    ).toContain(longError);
    expect(stoppedByModel).toBe(
      [
        ...header,
        "<status>killed</status>",
        '<summary>Agent "Review "auth" changes" was stopped by ZCode</summary>',
        note,
        "</task-notification>",
      ].join("\n"),
    );
    expect(stoppedByUser).toContain(
      '<summary>Agent "Review "auth" changes" was stopped by user</summary>',
    );
    expect(stoppedBySystem).toContain(
      '<summary>Agent "Review "auth" changes" was stopped</summary>',
    );
  });

  it("drains pending background notifications as strict snapshot batches", async () => {
    const sessionId = createSessionId("background-notification-idle-wake");
    const sessionStore = new RecordingSessionStore();
    const eventStore = createTestSessionEventStore();
    const hookEvents: string[] = [];
    const requestMessages: Array<readonly { content: ModelMessageContent; role?: string }[]> = [];
    const firstRequestMayFinish = createDeferred<void>();
    const secondRequestMayFinish = createDeferred<void>();
    let requestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-idle-wake",
      },
      {
        eventStore,
        hookRunner: createInMemoryHookRunner({
          hooks: [
            {
              event: HookEventName.UserPromptSubmit,
              callback: async (input) => {
                hookEvents.push(input.prompt);
                return {
                  hookSpecificOutput: {
                    hookEventName: HookEventName.UserPromptSubmit,
                  },
                };
              },
            },
          ],
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: {
            messages: readonly { content: ModelMessageContent; role?: string }[];
          }) {
            requestCount += 1;
            requestMessages.push(request.messages);
            if (requestCount === 1) await firstRequestMayFinish.promise;
            if (requestCount === 2) await secondRequestMayFinish.promise;
            return modelTextResult(`processed background notification ${requestCount}`);
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as {
      enqueueBackgroundTaskNotification(notification: {
        originMeta: {
          backgroundSource: "bash" | "subagent";
          title: string;
          workId: string;
        };
        taskId?: string;
        text: string;
        traceContext: {
          traceId: string;
          spanId: string;
          sessionId: SessionId;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_idle_wake",
      spanId: "span_background_idle_wake",
      sessionId,
    };

    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: "Inspect renderer state",
        workId: "agent_idle_1",
      },
      taskId: "agent_idle_1",
      text: "<task-notification>\n<task-id>agent_idle_1</task-id>\n</task-notification>",
      traceContext,
    });
    await waitForCondition(() => requestMessages.length === 1);

    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "bash",
        title: "pnpm test",
        workId: "agent_idle_2",
      },
      taskId: "agent_idle_2",
      text: "<task-notification>\n<task-id>agent_idle_2</task-id>\n</task-notification>",
      traceContext,
    });
    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: "Inspect service state",
        workId: "agent_idle_3",
      },
      taskId: "agent_idle_3",
      text: "<task-notification>\n<task-id>agent_idle_3</task-id>\n</task-notification>",
      traceContext,
    });

    firstRequestMayFinish.resolve(undefined);
    await waitForCondition(() => requestMessages.length === 2);

    runtime.enqueueBackgroundTaskNotification({
      originMeta: {
        backgroundSource: "bash",
        title: "pnpm lint",
        workId: "agent_idle_4",
      },
      taskId: "agent_idle_4",
      text: "<task-notification>\n<task-id>agent_idle_4</task-id>\n</task-notification>",
      traceContext,
    });

    secondRequestMayFinish.resolve(undefined);
    await waitForCondition(() => requestMessages.length === 3);

    const notificationInputs = requestMessages.map((messages) =>
      [...messages]
        .reverse()
        .find((message) =>
          modelMessageContentToText(message.content).includes("<task-notification>"),
        ),
    );
    const notificationTexts = notificationInputs.map((message) =>
      modelMessageContentToText(message?.content),
    );
    expect(notificationTexts[0]).toContain("<task-id>agent_idle_1</task-id>");
    expect(notificationTexts[0]).not.toContain("<task-id>agent_idle_2</task-id>");
    expect(notificationTexts[1]).toContain("<task-id>agent_idle_2</task-id>");
    expect(notificationTexts[1]).toContain("<task-id>agent_idle_3</task-id>");
    expect(notificationTexts[1]).not.toContain("<task-id>agent_idle_4</task-id>");
    expect(notificationTexts[2]).toContain("<task-id>agent_idle_4</task-id>");
    expect(notificationTexts[2]).not.toContain("<task-id>agent_idle_3</task-id>");
    const firstNotificationMessage = notificationInputs[0];
    expect(firstNotificationMessage?.role).toBe("user");
    expect(modelMessageContentToText(firstNotificationMessage?.content)).toContain(
      "<system-reminder>",
    );
    expect(hookEvents).toEqual([]);
    expect(requestCount).toBe(3);
    const backgroundMessages = sessionStore.savedMessages.filter(
      (message) => message.source === "background_task",
    );
    // 每批一条消息；第二批的两条通知是同一条消息的两个文本 part（存储没有事务入口时逐条写入）。
    const notification = (id: number) =>
      `<task-notification>\n<task-id>agent_idle_${id}</task-id>\n</task-notification>`;
    expect(
      sessionStore.savedParts
        .filter(
          (part) =>
            part.type === "text" &&
            part.metadata?.source === "background_task" &&
            part.metadata?.visibility === "model-only",
        )
        .map((part) => [part.messageID, part.type === "text" ? part.text : ""]),
    ).toEqual([
      [backgroundMessages[0]!.id, notification(1)],
      [backgroundMessages[1]!.id, notification(2)],
      [backgroundMessages[1]!.id, notification(3)],
      [backgroundMessages[2]!.id, notification(4)],
    ]);
    expect(backgroundMessages.map((message) => message.metadata?.originMeta)).toEqual([
      {
        backgroundSource: "subagent",
        title: "Inspect renderer state",
        workId: "agent_idle_1",
      },
      {
        backgroundSource: "bash",
        title: "pnpm test · Inspect service state",
        workId: "agent_idle_2",
      },
      {
        backgroundSource: "bash",
        title: "pnpm lint",
        workId: "agent_idle_4",
      },
    ]);
    const liveBackgroundOriginMetas = (await eventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.TurnStarted)
      .map(
        (event) =>
          event.payload as {
            inputSource?: string;
            originMeta?: {
              backgroundSource: "bash" | "subagent";
              title: string;
              workId: string;
            };
          },
      )
      .filter((payload) => payload.inputSource === "background_task")
      .map((payload) => payload.originMeta);
    expect(liveBackgroundOriginMetas).toEqual(
      backgroundMessages.map((message) => message.metadata?.originMeta),
    );
    const wakeTurns = (await eventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.TurnStarted)
      .map(
        (event) => event.payload as { inputSource?: string; inputId?: string; messageId?: string },
      )
      .filter((payload) => payload.inputSource === "background_task");
    expect(wakeTurns).toHaveLength(3);
    // 这一轮的输入文本仍以 "\n\n" 相连，App 据此逐条解析任务卡片。
    expect(wakeTurns.map((turn) => (turn as { input?: string }).input)).toEqual([
      notification(1),
      `${notification(2)}\n\n${notification(3)}`,
      notification(4),
    ]);
    expect(new Set(wakeTurns.map((turn) => turn.inputId)).size).toBe(3);
    for (const turn of wakeTurns) {
      expect(turn.inputId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(turn.inputId).not.toBe(turn.messageId);
      expect(backgroundMessages.some((message) => message.id === turn.messageId)).toBe(true);
    }
    expect(sessionStore.savedSessionInputs).toHaveLength(4);
    expect(sessionStore.promotedSessionInputs).toHaveLength(4);
    expect(sessionStore.promotedSessionInputs.map((input) => input.id)).toEqual(
      sessionStore.savedSessionInputs.map((input) => input.id),
    );
    expect(sessionStore.promotedSessionInputs[1]?.promotedMessageID).toBe(
      sessionStore.promotedSessionInputs[2]?.promotedMessageID,
    );
    expect(sessionStore.promotedSessionInputs[0]?.promotedMessageID).not.toBe(
      sessionStore.promotedSessionInputs[1]?.promotedMessageID,
    );
    expect(sessionStore.promotedSessionInputs[2]?.promotedMessageID).not.toBe(
      sessionStore.promotedSessionInputs[3]?.promotedMessageID,
    );
  });

  it("reuses ordinary origin metadata for a composed title without guessing missing members", async () => {
    const scenarios: Array<{
      expectedBackgroundSource?: "bash" | "subagent" | "workflow";
      expectedOriginMeta?: BackgroundResultOriginMeta;
      expectedBackgroundSubagentResultConsumed?: boolean;
      /** 批里有 dynamic-workflow run 的通知（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）。 */
      expectedWorkflowResultConsumed?: boolean;
      id: string;
      originMetas: Array<BackgroundResultOriginMeta | undefined>;
    }> = [
      {
        // 整批都是 dynamic-workflow run 的通知：backgroundSource 冻结为 workflow，只置 wf 维度。
        expectedBackgroundSource: "workflow",
        expectedOriginMeta: {
          backgroundSource: "workflow",
          title: "Nightly report · Weekly digest",
          workId: "dwfrun-title-1",
        },
        expectedWorkflowResultConsumed: true,
        id: "all-workflow",
        originMetas: [
          { backgroundSource: "workflow", title: "Nightly report", workId: "dwfrun-title-1" },
          { backgroundSource: "workflow", title: "Weekly digest", workId: "dwfrun-title-2" },
        ],
      },
      {
        // 混批：来源不一致时 backgroundSource 不冻结（既有规则），但两个维度各自按成员置位。
        expectedOriginMeta: {
          backgroundSource: "workflow",
          title: "Nightly report · Inspect service",
          workId: "dwfrun-title-3",
        },
        expectedBackgroundSubagentResultConsumed: true,
        expectedWorkflowResultConsumed: true,
        id: "workflow-and-subagent",
        originMetas: [
          { backgroundSource: "workflow", title: "Nightly report", workId: "dwfrun-title-3" },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-9",
          },
        ],
      },
      {
        expectedOriginMeta: {
          backgroundSource: "subagent",
          title: "Inspect renderer · Run tests · Inspect service · +1",
          workId: "agent-title-1",
        },
        expectedBackgroundSubagentResultConsumed: true,
        id: "complete-metadata",
        originMetas: [
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-1",
          },
          { backgroundSource: "bash", title: "Run tests", workId: "bash-title-2" },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-3",
          },
          { backgroundSource: "bash", title: "Run lint", workId: "bash-title-4" },
        ],
      },
      {
        expectedOriginMeta: {
          backgroundSource: "bash",
          title: "Run tests · Inspect renderer · Run lint · +1",
          workId: "bash-title-1",
        },
        expectedBackgroundSubagentResultConsumed: true,
        id: "complete-metadata-reversed",
        originMetas: [
          { backgroundSource: "bash", title: "Run tests", workId: "bash-title-1" },
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-2",
          },
          { backgroundSource: "bash", title: "Run lint", workId: "bash-title-3" },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-4",
          },
        ],
      },
      {
        expectedBackgroundSource: "subagent",
        expectedOriginMeta: {
          backgroundSource: "subagent",
          title: "Inspect renderer · Inspect service",
          workId: "agent-title-5",
        },
        expectedBackgroundSubagentResultConsumed: true,
        id: "all-subagent",
        originMetas: [
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-5",
          },
          {
            backgroundSource: "subagent",
            title: "Inspect service",
            workId: "agent-title-6",
          },
        ],
      },
      {
        expectedBackgroundSource: "bash",
        expectedOriginMeta: {
          backgroundSource: "bash",
          title: "Run tests · Run lint",
          workId: "bash-title-7",
        },
        id: "all-bash",
        originMetas: [
          { backgroundSource: "bash", title: "Run tests", workId: "bash-title-7" },
          { backgroundSource: "bash", title: "Run lint", workId: "bash-title-8" },
        ],
      },
      {
        expectedBackgroundSubagentResultConsumed: true,
        id: "missing-metadata",
        originMetas: [
          {
            backgroundSource: "subagent",
            title: "Inspect renderer",
            workId: "agent-title-legacy-1",
          },
          undefined,
        ],
      },
    ];

    for (const scenario of scenarios) {
      const sessionId = createSessionId(`background-title-${scenario.id}`);
      const sessionStore = new RecordingSessionStore();
      const eventStore = createTestSessionEventStore();
      let requestCount = 0;
      const runtime = createTestAgentRuntime(
        sessionId,
        { workingDirectory: `/tmp/zcode-background-title-${scenario.id}` },
        {
          eventStore,
          modelFactory: createTestModelFactory({
            async generateText() {
              requestCount += 1;
              return modelTextResult("processed notification metadata batch");
            },
          } as never),
          sessionStore: sessionStore as unknown as SessionStorePort,
        },
      ) as unknown as AgentRuntime & {
        drainRuntimeCommandQueue(): Promise<void>;
        enqueueBackgroundTaskNotification(notification: {
          originMeta?: BackgroundResultOriginMeta;
          taskId: string;
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
        runtimeCommandDrainActive: boolean;
      };
      const traceContext = {
        sessionId,
        spanId: `span_${scenario.id}`,
        traceId: `trace_${scenario.id}`,
      };

      runtime.runtimeCommandDrainActive = true;
      scenario.originMetas.forEach((originMeta, index) => {
        const taskId = `${scenario.id}-${index + 1}`;
        runtime.enqueueBackgroundTaskNotification({
          ...(originMeta ? { originMeta } : {}),
          taskId,
          text: `<task-notification><task-id>${taskId}</task-id></task-notification>`,
          traceContext,
        });
      });
      runtime.runtimeCommandDrainActive = false;

      await runtime.drainRuntimeCommandQueue();

      expect(requestCount).toBe(1);
      const backgroundMessages = sessionStore.savedMessages.filter(
        (message) => message.source === "background_task",
      );
      expect(backgroundMessages).toHaveLength(1);
      expect(backgroundMessages[0]?.metadata?.originMeta).toEqual(scenario.expectedOriginMeta);
      const turnStarts = (await eventStore.getEvents(sessionId))
        .filter((event) => event.type === SessionEventType.TurnStarted)
        .map(
          (event) =>
            event.payload as {
              backgroundSource?: "bash" | "subagent" | "workflow";
              inputSource?: string;
              originMeta?: BackgroundResultOriginMeta;
            },
        )
        .filter((payload) => payload.inputSource === "background_task");
      expect(turnStarts).toHaveLength(1);
      expect(turnStarts[0]?.originMeta).toEqual(scenario.expectedOriginMeta);
      expect(turnStarts[0]?.backgroundSource).toBe(scenario.expectedBackgroundSource);
      const turnCompletes = (await eventStore.getEvents(sessionId))
        .filter((event) => event.type === SessionEventType.TurnComplete)
        .map(
          (event) =>
            event.payload as {
              backgroundSubagentResultConsumed?: boolean;
              workflowResultConsumed?: boolean;
            },
        );
      expect(turnCompletes).toHaveLength(1);
      expect(turnCompletes[0]?.backgroundSubagentResultConsumed).toBe(
        scenario.expectedBackgroundSubagentResultConsumed,
      );
      expect(turnCompletes[0]?.workflowResultConsumed).toBe(
        scenario.expectedWorkflowResultConsumed,
      );
    }
  });

  it.each(["provider failure", "stop"] as const)(
    "keeps a claimed notification batch durable without command requeue after %s",
    async (terminalOutcome) => {
      const sessionId = createSessionId(`background-notification-${terminalOutcome}`);
      const sessionStore = new RecordingSessionStore();
      const firstRequestMayFinish = createDeferred<void>();
      const secondRequestStarted = createDeferred<AbortSignal | undefined>();
      const requestMessages: Array<readonly { content: ModelMessageContent }[]> = [];
      let requestCount = 0;
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          workingDirectory: `/tmp/zcode-background-notification-${terminalOutcome}`,
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(request: {
              abortSignal?: AbortSignal;
              messages: readonly { content: ModelMessageContent }[];
            }) {
              requestCount += 1;
              requestMessages.push(request.messages);
              if (requestCount === 1) {
                await firstRequestMayFinish.promise;
                return modelTextResult("processed first background notification");
              }
              if (requestCount === 2) {
                secondRequestStarted.resolve(request.abortSignal);
                if (terminalOutcome === "stop") {
                  await waitForAbort(request.abortSignal);
                  throw request.abortSignal?.reason ?? new Error("notification batch stopped");
                }
                throw new Error("notification batch provider failure");
              }
              return modelTextResult("continued after terminal notification batch");
            },
          } as never),
          sessionStore: sessionStore as unknown as SessionStorePort,
        },
      ) as AgentRuntime & {
        enqueueBackgroundTaskNotification(notification: {
          taskId?: string;
          text: string;
          traceContext: {
            traceId: string;
            spanId: string;
            sessionId: SessionId;
          };
        }): void;
      };
      const traceContext = {
        traceId: `trace_background_notification_${terminalOutcome}`,
        spanId: `span_background_notification_${terminalOutcome}`,
        sessionId,
      };

      runtime.enqueueBackgroundTaskNotification({
        taskId: "agent_terminal_1",
        text: "<task-notification><task-id>agent_terminal_1</task-id></task-notification>",
        traceContext,
      });
      await waitForCondition(() => requestCount === 1);
      runtime.enqueueBackgroundTaskNotification({
        taskId: "agent_terminal_2",
        text: "<task-notification><task-id>agent_terminal_2</task-id></task-notification>",
        traceContext,
      });
      runtime.enqueueBackgroundTaskNotification({
        taskId: "agent_terminal_3",
        text: "<task-notification><task-id>agent_terminal_3</task-id></task-notification>",
        traceContext,
      });

      firstRequestMayFinish.resolve(undefined);
      await secondRequestStarted.promise;
      if (terminalOutcome === "stop") {
        expect(
          runtime.stopActiveForegroundExecution({ reason: "stop notification batch test" }),
        ).toMatchObject({ kind: "stopped" });
      }

      const continuation = await runtime.executeTurn("continue after terminal notification batch");
      expect(continuation.response).toBe("continued after terminal notification batch");
      expect(requestCount).toBe(3);
      const secondRequestText = providerMessagesToText(requestMessages[1]!);
      expect(secondRequestText).toContain("<task-id>agent_terminal_2</task-id>");
      expect(secondRequestText).toContain("<task-id>agent_terminal_3</task-id>");
      const continuationText = providerMessagesToText(requestMessages[2]!);
      expect(continuationText.match(/<task-id>agent_terminal_2<\/task-id>/g) ?? []).toHaveLength(1);
      expect(continuationText.match(/<task-id>agent_terminal_3<\/task-id>/g) ?? []).toHaveLength(1);
      expect(
        sessionStore.savedMessages.filter((message) => message.source === "background_task"),
      ).toHaveLength(2);
      expect(sessionStore.promotedSessionInputs).toHaveLength(3);
      expect(sessionStore.promotedSessionInputs[1]?.promotedMessageID).toBe(
        sessionStore.promotedSessionInputs[2]?.promotedMessageID,
      );
    },
  );

  it("wakes idle background notifications without scheduling a timeout", async () => {
    const sessionId = createSessionId("background-notification-idle-wake-ref");
    const sessionStore = new RecordingSessionStore();
    const firstRequest = createDeferred<readonly { content: ModelMessageContent }[]>();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-idle-wake-ref",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: readonly { content: ModelMessageContent }[] }) {
            firstRequest.resolve(request.messages);
            return modelTextResult("processed referenced background notification");
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as {
      enqueueBackgroundTaskNotification(notification: {
        text: string;
        traceContext: {
          traceId: string;
          spanId: string;
          sessionId: SessionId;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_idle_wake_ref",
      spanId: "span_background_idle_wake_ref",
      sessionId,
    };
    const timeoutRecorder = recordSetTimeoutCalls();

    runtime.enqueueBackgroundTaskNotification({
      text: "<task-notification>\n<task-id>agent_idle_ref</task-id>\n</task-notification>",
      traceContext,
    });
    timeoutRecorder.restore();

    const requestMessages = await firstRequest.promise;
    expect(providerMessagesToText(requestMessages)).toContain("<task-id>agent_idle_ref</task-id>");
    expect(timeoutRecorder.calls).toEqual([]);
  });

  it("保留 loopState 初始化前取消的 background subagent composition 标记", async () => {
    const sessionId = createSessionId("background-notification-pre-loop-cancel");
    const eventStore = createTestSessionEventStore();
    const setupStarted = createDeferred<void>();
    const setupMayFinish = createDeferred<void>();
    const abortController = new AbortController();
    const runtime = createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/tmp/zcode-background-notification-pre-loop-cancel" },
      {
        eventStore,
        modelAdapter: {
          async generateText() {
            throw new Error("provider request must not start");
          },
        } as never,
      },
    );
    (runtime as any).runUserPromptSubmitHooks = async (...args: any[]) => {
      setupStarted.resolve();
      await setupMayFinish.promise;
      throw args[3]?.reason ?? new Error("cancelled before loop state");
    };

    const turn = (runtime as any).executeTurnCommand("consume background result", undefined, {
      abortSignal: abortController.signal,
      backgroundSubagentResultConsumed: true,
      inputSource: "background_task",
      inputVisibility: "model-only",
      recordedInputMessageId: "background-result-message",
      skipInputRecord: true,
      traceContext: {
        sessionId,
        spanId: "span_background_notification_pre_loop_cancel",
        traceId: "trace_background_notification_pre_loop_cancel",
      },
    });
    await setupStarted.promise;
    abortController.abort(new Error("user stopped before model loop"));
    setupMayFinish.resolve();

    await expect(turn).rejects.toBeDefined();
    const cancelled = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.TurnComplete,
    );
    expect(cancelled?.payload).toMatchObject({
      backgroundSubagentResultConsumed: true,
      resultType: "cancelled",
    });
  });

  it("drains active-loop background notifications into model-only history without starting a turn", async () => {
    const sessionId = createSessionId("background-active-loop-drain");
    const sessionStore = new RecordingSessionStore();
    const generateText = vi.fn();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-active-loop-drain",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      messageHistory: {
        toRuntimeEntries(): readonly { message: { content: ModelMessageContent } }[];
      };
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
    };
    const traceContext = {
      traceId: "trace_background_active_loop_drain",
      spanId: "span_background_active_loop_drain",
      sessionId,
    };

    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>active-drain-1</task-id></task-notification>",
      traceContext,
    });
    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>active-drain-2</task-id></task-notification>",
      traceContext,
    });

    const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(result.drained).toBe(2);
    expect(result.messageIds).toHaveLength(2);
    expect(result.consumedCommandIds).toHaveLength(2);
    expect(generateText).not.toHaveBeenCalled();
    const persisted = sessionStore.savedMessages.filter(
      (message) => message.source === "background_task",
    );
    expect(persisted).toHaveLength(2);
    expect(persisted.every((message) => message.visibility === "model-only")).toBe(true);
    const runtimeText = runtime.messageHistory
      .toRuntimeEntries()
      .map((entry) => modelMessageContentToText(entry.message.content))
      .join("\n");
    expect(runtimeText).toContain("<task-id>active-drain-1</task-id>");
    expect(runtimeText).toContain("<task-id>active-drain-2</task-id>");
  });

  it("drops active-loop notifications queued by an older rewind branch generation", async () => {
    const sessionId = createSessionId("background-active-loop-stale-branch");
    const sessionStore = new RecordingSessionStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/tmp/zcode-background-active-loop-stale-branch" },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText: vi.fn() } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      branchGeneration: number;
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
    };
    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>stale-task</task-id></task-notification>",
      traceContext: {
        traceId: "trace_background_active_loop_stale",
        spanId: "span_background_active_loop_stale",
        sessionId,
      },
    });
    runtime.branchGeneration = 1;

    const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(result).toMatchObject({ drained: 0, consumedCommandIds: [], messageIds: [] });
    expect(sessionStore.savedMessages).toEqual([]);
  });

  it("leaves commands arriving after the active-loop snapshot for the next drain", async () => {
    const sessionId = createSessionId("background-active-loop-continuous-drain");
    const firstSaveStarted = createDeferred<void>();
    const firstSaveMayFinish = createDeferred<void>();
    const sessionStore = new RecordingSessionStore();
    const saveMessage = sessionStore.saveMessage.bind(sessionStore);
    let saveMessageCallCount = 0;
    sessionStore.saveMessage = async (input) => {
      saveMessageCallCount++;
      if (saveMessageCallCount === 1) {
        firstSaveStarted.resolve(undefined);
        await firstSaveMayFinish.promise;
      }
      await saveMessage(input);
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-active-loop-continuous-drain",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText: vi.fn() } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
    };
    const traceContext = {
      traceId: "trace_background_active_loop_continuous_drain",
      spanId: "span_background_active_loop_continuous_drain",
      sessionId,
    };
    const enqueueNotification = (taskId: string) => {
      runtime.runtimeCommandQueue.enqueue({
        branchGeneration: 0,
        createdAt: new Date(),
        id: createRuntimeCommandId(),
        mode: "task-notification",
        priority: "next",
        source: "background_task",
        text: `<task-notification><task-id>${taskId}</task-id></task-notification>`,
        traceContext,
      });
    };

    enqueueNotification("continuous-drain-1");
    const drain = runtime.drainPendingRuntimeCommandsForActiveLoop();
    await firstSaveStarted.promise;
    enqueueNotification("continuous-drain-2");
    firstSaveMayFinish.resolve(undefined);

    const result = await drain;

    expect(result.drained).toBe(1);
    expect(result.messageIds).toHaveLength(1);
    expect(result.consumedCommandIds).toHaveLength(1);
    expect(sessionStore.savedMessages).toHaveLength(1);

    const nextResult = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(nextResult.drained).toBe(1);
    expect(sessionStore.savedMessages).toHaveLength(2);
  });

  it("leaves prompt commands queued when draining active-loop runtime commands", async () => {
    const sessionId = createSessionId("background-active-loop-prompt-drain");
    const sessionStore = new RecordingSessionStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-active-loop-prompt-drain",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText: vi.fn() } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      drainPendingRuntimeCommandsForActiveLoop(): Promise<{
        consumedCommandIds: readonly string[];
        drained: number;
        messageIds: readonly string[];
      }>;
      messageHistory: {
        toRuntimeEntries(): readonly { message: { content: ModelMessageContent } }[];
      };
      runtimeCommandQueue: {
        enqueue(command: PromptRuntimeCommand): void;
        size(): number;
      };
    };
    const traceContext = {
      traceId: "trace_background_active_loop_prompt",
      spanId: "span_background_active_loop_prompt",
      sessionId,
    };
    const command: PromptRuntimeCommand = {
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input: "queued prompt stays in outer queue",
      mode: "prompt",
      priority: "next",
      reject: vi.fn(),
      resolve: vi.fn(),
      traceContext,
    };

    runtime.runtimeCommandQueue.enqueue(command);
    const result = await runtime.drainPendingRuntimeCommandsForActiveLoop();

    expect(result.drained).toBe(0);
    expect(result.consumedCommandIds).toEqual([]);
    expect(result.messageIds).toEqual([]);
    expect(runtime.runtimeCommandQueue.size()).toBe(1);
    expect(command.resolve).not.toHaveBeenCalled();
    expect(command.reject).not.toHaveBeenCalled();
    const runtimeText = runtime.messageHistory
      .toRuntimeEntries()
      .map((entry) => modelMessageContentToText(entry.message.content))
      .join("\n");
    expect(runtimeText).not.toContain("queued prompt stays in outer queue");
  });

  it("drops queued child Bash task notifications after the subagent runtime is sealed", async () => {
    const sessionId = createSessionId("background-sealed-child-queued-bash");
    const sessionStore = new RecordingSessionStore();
    const generateText = vi.fn();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        taskType: "subagent_child",
        workingDirectory: "/tmp/zcode-background-sealed-child-queued-bash",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({ generateText } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      backgroundTaskNotificationsSealed: boolean;
      drainRuntimeCommandQueue(): Promise<void>;
      enqueueBackgroundTaskNotification(notification: {
        taskId?: string;
        text: string;
        toolName?: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
      runtimeCommandDrainActive: boolean;
      runtimeCommandQueue: {
        size(): number;
      };
      sealBackgroundTaskNotifications(input: {
        reason: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_sealed_child_queued_bash",
      spanId: "span_background_sealed_child_queued_bash",
      sessionId,
    };

    runtime.runtimeCommandDrainActive = true;
    runtime.enqueueBackgroundTaskNotification({
      taskId: "child_bash_queued_before_seal",
      text:
        "<task-notification>\n" +
        "<task-id>child_bash_queued_before_seal</task-id>\n" +
        "<status>completed</status>\n" +
        "</task-notification>",
      toolName: "Bash",
      traceContext,
    });
    expect(runtime.runtimeCommandQueue.size()).toBe(1);

    runtime.sealBackgroundTaskNotifications({
      reason: "subagent_terminal",
      traceContext,
    });
    runtime.runtimeCommandDrainActive = false;
    await runtime.drainRuntimeCommandQueue();

    expect(runtime.runtimeCommandQueue.size()).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
    expect(JSON.stringify(sessionStore.savedMessages)).not.toContain(
      "child_bash_queued_before_seal",
    );
  });

  it("filters stale and suppressed members without dropping a valid notification batch member", async () => {
    const sessionId = createSessionId("background-filtered-batch-members");
    const sessionStore = new RecordingSessionStore();
    const requestMessages: Array<readonly { content: ModelMessageContent }[]> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        taskType: "subagent_child",
        workingDirectory: "/tmp/zcode-background-filtered-batch-members",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: readonly { content: ModelMessageContent }[] }) {
            requestMessages.push(request.messages);
            return modelTextResult("processed valid notification");
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      branchGeneration: number;
      drainRuntimeCommandQueue(): Promise<void>;
      enqueueBackgroundTaskNotification(notification: {
        taskId?: string;
        text: string;
        toolName?: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
      runtimeCommandDrainActive: boolean;
      runtimeCommandQueue: {
        enqueue(command: {
          branchGeneration: number;
          createdAt: Date;
          id: string;
          mode: "task-notification";
          priority: "next";
          source: "background_task";
          text: string;
          traceContext: {
            sessionId: SessionId;
            spanId: string;
            traceId: string;
          };
        }): void;
      };
      sealBackgroundTaskNotifications(input: {
        reason: string;
        traceContext: {
          sessionId: SessionId;
          spanId: string;
          traceId: string;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_filtered_batch_members",
      spanId: "span_background_filtered_batch_members",
      sessionId,
    };

    runtime.branchGeneration = 1;
    runtime.runtimeCommandDrainActive = true;
    runtime.enqueueBackgroundTaskNotification({
      taskId: "suppressed-bash",
      text: "<task-notification><task-id>suppressed-bash</task-id></task-notification>",
      toolName: "Bash",
      traceContext,
    });
    runtime.enqueueBackgroundTaskNotification({
      taskId: "valid-agent",
      text: "<task-notification><task-id>valid-agent</task-id></task-notification>",
      toolName: "Agent",
      traceContext,
    });
    runtime.runtimeCommandQueue.enqueue({
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      text: "<task-notification><task-id>stale-agent</task-id></task-notification>",
      traceContext,
    });
    runtime.sealBackgroundTaskNotifications({
      reason: "subagent_terminal",
      traceContext,
    });
    runtime.runtimeCommandDrainActive = false;

    await runtime.drainRuntimeCommandQueue();

    expect(requestMessages).toHaveLength(1);
    const requestText = providerMessagesToText(requestMessages[0]!);
    expect(requestText).toContain("<task-id>valid-agent</task-id>");
    expect(requestText).not.toContain("<task-id>suppressed-bash</task-id>");
    expect(requestText).not.toContain("<task-id>stale-agent</task-id>");
    expect(
      sessionStore.savedMessages.filter((message) => message.source === "background_task"),
    ).toHaveLength(1);
  });

  it("queues task-notification commands behind an active prompt command", async () => {
    const sessionId = createSessionId("background-notification-waits-for-prompt");
    const sessionStore = new RecordingSessionStore();
    const firstPromptRequest = createDeferred<readonly { content: ModelMessageContent }[]>();
    const firstPromptCanFinish = createDeferred<void>();
    const notificationRequest = createDeferred<readonly { content: ModelMessageContent }[]>();
    let requestCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/tmp/zcode-background-notification-waits-for-prompt",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: { messages: readonly { content: ModelMessageContent }[] }) {
            requestCount += 1;
            if (requestCount === 1) {
              firstPromptRequest.resolve(request.messages);
              await firstPromptCanFinish.promise;
              return modelTextResult("prompt done");
            }
            notificationRequest.resolve(request.messages);
            return modelTextResult("notification done");
          },
        } as never),
        sessionStore: sessionStore as unknown as SessionStorePort,
      },
    ) as unknown as AgentRuntime & {
      enqueueBackgroundTaskNotification(notification: {
        text: string;
        traceContext: {
          traceId: string;
          spanId: string;
          sessionId: SessionId;
        };
      }): void;
    };
    const traceContext = {
      traceId: "trace_background_waits_for_prompt",
      spanId: "span_background_waits_for_prompt",
      sessionId,
    };

    const promptTurn = runtime.executeTurn("user prompt");
    await firstPromptRequest.promise;
    runtime.enqueueBackgroundTaskNotification({
      text: "<task-notification>\n<task-id>agent_waits_for_prompt</task-id>\n</task-notification>",
      traceContext,
    });
    await waitForMacrotask();
    expect(requestCount).toBe(1);

    firstPromptCanFinish.resolve();
    await expect(promptTurn).resolves.toMatchObject({ response: "prompt done" });
    const requestMessages = await notificationRequest.promise;
    expect(providerMessagesToText(requestMessages)).toContain(
      "<task-id>agent_waits_for_prompt</task-id>",
    );
    expect(requestCount).toBe(2);
  });

  it("moves a foreground local agent to background after the configured timeout", async () => {
    const sessionId = createSessionId("subagent-auto-background");
    const turnId = createTurnId("subagent-auto-background-turn");
    const childGate = createDeferred<void>();
    const notifications: Array<Record<string, unknown>> = [];
    const port = createExploreSubagentPort({
      autoBackgroundMs: 1,
      createAgentId: () => "agent_auto_background",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "auto background child finished",
          traceId: "trace_subagent_auto_background",
        };
      },
    });

    const output = await port.run(createSubagentRunRequest({ sessionId, turnId }));

    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_auto_background",
      backgroundTaskId: "agent_auto_background",
    });
    childGate.resolve();
    await waitForCondition(() => notifications.length === 1);
    expect(notifications[0]).toMatchObject({
      originMeta: {
        backgroundSource: "subagent",
        title: "Auto background test",
        workId: "agent_auto_background",
        subagentResult: { status: "completed" },
      },
      taskId: "agent_auto_background",
    });
    expect(notifications[0]?.text).toContain("<task-id>agent_auto_background</task-id>");
    expect(notifications[0]?.text).toContain("<status>completed</status>");
    // 框架只用于同步返回的工具结果；后台完成通知里的报告原样放进 <result>。
    expect(notifications[0]?.text).toContain("<result>auto background child finished</result>");
    expect(notifications[0]?.text).not.toContain("[Subagent hand-back]");
  });

  it("preserves the provider cause across failed background local-agent surfaces", async () => {
    const providerMessage = [
      "Requests are too frequent.",
      `  Provider spacing and full payload must remain unchanged: ${"x".repeat(520)}`,
      "Request id: unit-background-subagent-rate-limit",
    ].join("\n");
    const sessionId = createSessionId("subagent-background-rate-limit");
    const turnId = createTurnId("subagent-background-rate-limit-turn");
    const notifications: string[] = [];
    const notificationOriginMetas: unknown[] = [];
    const emittedEvents: SessionEvent[] = [];
    const providerError = Object.assign(new Error(providerMessage), {
      code: "model_rate_limited",
      context: {
        providerCode: "AccountRateLimitExceeded",
        statusCode: 429,
      },
      name: "AiSdkModelAdapterError",
    });
    const turnError = createTurnFailureError(providerError, undefined, "Turn execution failed");
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_background_rate_limit",
      emitParentEvent: async (event) => {
        emittedEvents.push(event);
      },
      enqueueParentTaskNotification: ({ originMeta, text }) => {
        notifications.push(text);
        notificationOriginMetas.push(originMeta);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        throw turnError;
      },
    });

    await port.start?.(createSubagentRunRequest({ sessionId, turnId }));
    await waitForCondition(() => notifications.length === 1);
    await waitForCondition(() =>
      emittedEvents.some((event) => event.type === SessionEventType.SubagentStopped),
    );

    const notification = notifications[0]!;
    expect(notification).toContain(
      `<summary>Agent "Auto background test" failed: ${providerMessage}</summary>`,
    );
    expect(notification).not.toContain("<error>");
    expect(notification).not.toContain("Turn execution failed");
    // child 没写过正文，失败通知不带部分报告。
    expect(notification).not.toContain("<result>");
    // 失败原文结构化下发，App 不从 summary 文本解析。
    expect(notificationOriginMetas).toEqual([
      expect.objectContaining({
        backgroundSource: "subagent",
        subagentResult: { status: "failed", error: providerMessage },
      }),
    ]);
    expect(await port.getTask?.("agent_background_rate_limit")).toMatchObject({
      status: "failed",
      error: providerMessage,
    });
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: SessionEventType.SubagentStopped,
        payload: expect.objectContaining({
          status: "failed",
          error: providerMessage,
        }),
      }),
    );
  });

  it("adds the partial report to failed background notifications", async () => {
    // 回归：后台失败通知原来不带 <result>。现在取本次运行最近一段非空 step 正文，
    // 原样放进 <result>（不套框架）；sink 转发的其他 session 事件不算。
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_background_partial",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        request.onEvent?.(subagentModelStep(request.sessionId, "Interim findings: module A."));
        request.onEvent?.(subagentModelStep(request.sessionId, ""));
        request.onEvent?.(
          subagentModelStep(createSessionId("subagent-background-other"), "Foreign findings."),
        );
        throw new Error("Requests are too frequent.");
      },
    });

    await port.start?.(
      createSubagentRunRequest({
        sessionId: createSessionId("subagent-background-partial"),
        turnId: createTurnId("subagent-background-partial-turn"),
      }),
    );
    await waitForCondition(() => notifications.length === 1);

    expect(notifications[0]).toContain("<status>failed</status>");
    expect(notifications[0]).toContain("<result>Interim findings: module A.</result>");
    expect(notifications[0]).not.toContain("Foreign findings.");
    expect(notifications[0]).not.toContain("[Subagent hand-back]");
  });

  it("adds the partial report when an auto-backgrounded local agent fails", async () => {
    // 转后台前写的正文也属于本次运行，转后台后失败时同样带上。
    const childGate = createDeferred<void>();
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      autoBackgroundMs: 1,
      createAgentId: () => "agent_auto_background_partial",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        request.onEvent?.(subagentModelStep(request.sessionId, "Findings before backgrounding."));
        await childGate.promise;
        throw new Error("Requests are too frequent.");
      },
    });

    const output = await port.run(
      createSubagentRunRequest({
        sessionId: createSessionId("subagent-auto-background-partial"),
        turnId: createTurnId("subagent-auto-background-partial-turn"),
      }),
    );
    expect(output).toMatchObject({ status: "async_launched" });
    childGate.resolve();
    await waitForCondition(() => notifications.length === 1);

    expect(notifications[0]).toContain("<status>failed</status>");
    expect(notifications[0]).toContain("<result>Findings before backgrounding.</result>");
  });

  it("queues parent notification before emitting background completion", async () => {
    const sessionId = createSessionId("subagent-notification-before-completion-event");
    const turnId = createTurnId("subagent-notification-before-completion-event-turn");
    const childGate = createDeferred<void>();
    const completionEventStarted = createDeferred<void>();
    const completionEventMayFinish = createDeferred<void>();
    const observed: string[] = [];
    let childRuntimeBackground: boolean | undefined;
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_notification_before_completion_event",
      emitParentEvent: async (event) => {
        observed.push(`event:${event.type}`);
        if (event.type === SessionEventType.BackgroundTaskCompleted) {
          completionEventStarted.resolve();
          await completionEventMayFinish.promise;
        }
      },
      enqueueParentTaskNotification: () => {
        observed.push("notification");
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        childRuntimeBackground = request.background;
        await childGate.promise;
        return {
          events: [],
          response: "child finished before completion event",
          traceId: "trace_subagent_notification_before_completion_event",
        };
      },
    });

    const output = await port.start?.(createSubagentRunRequest({ sessionId, turnId }));
    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_notification_before_completion_event",
    });
    await waitForCondition(() => childRuntimeBackground === true);
    expect(childRuntimeBackground).toBe(true);

    childGate.resolve();
    await completionEventStarted.promise;

    const completedIndex = observed.indexOf(`event:${SessionEventType.BackgroundTaskCompleted}`);
    const notificationIndex = observed.indexOf("notification");
    expect(notificationIndex).toBeGreaterThan(-1);
    expect(notificationIndex).toBeLessThan(completedIndex);
    completionEventMayFinish.resolve();
    await waitForCondition(() => observed.includes(`event:${SessionEventType.SubagentStopped}`));
    const stoppedIndex = observed.indexOf(`event:${SessionEventType.SubagentStopped}`);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(stoppedIndex).toBeGreaterThan(completedIndex);
  });

  it("auto-backgrounds with a referenced timeout and publishes the child result", async () => {
    const sessionId = createSessionId("subagent-auto-background-timeout-ref");
    const turnId = createTurnId("subagent-auto-background-timeout-ref-turn");
    const childGate = createDeferred<void>();
    const notifications: Array<Record<string, unknown>> = [];
    const port = createExploreSubagentPort({
      autoBackgroundMs: 1,
      createAgentId: () => "agent_auto_background_timeout_ref",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "auto background timeout ref child finished",
          traceId: "trace_subagent_auto_background_timeout_ref",
        };
      },
    });
    const unrefRecorder = recordSetTimeoutUnrefCalls();

    const outputPromise = port.run(createSubagentRunRequest({ sessionId, turnId }));
    let output: Awaited<typeof outputPromise>;
    try {
      output = await outputPromise;
    } finally {
      unrefRecorder.restore();
    }

    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_auto_background_timeout_ref",
      backgroundTaskId: "agent_auto_background_timeout_ref",
    });
    expect(unrefRecorder.calls).toEqual([]);
    childGate.resolve();
    await waitForCondition(() => notifications.length === 1);
    expect(notifications[0]).toMatchObject({
      originMeta: {
        backgroundSource: "subagent",
        title: "Auto background test",
        workId: "agent_auto_background_timeout_ref",
      },
      taskId: "agent_auto_background_timeout_ref",
    });
    expect(notifications[0]?.text).toContain(
      "<task-id>agent_auto_background_timeout_ref</task-id>",
    );
    expect(notifications[0]?.text).toContain("<status>completed</status>");
    expect(notifications[0]?.text).toContain("auto background timeout ref child finished");
  });

  it("does not mark background local agents notified without a parent notification queue", async () => {
    const sessionId = createSessionId("subagent-notification-queue-missing");
    const turnId = createTurnId("subagent-notification-queue-missing-turn");
    const childGate = createDeferred<void>();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_notification_queue_missing",
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "child finished without parent queue",
          traceId: "trace_subagent_notification_queue_missing",
        };
      },
    });

    const output = await port.start?.(createSubagentRunRequest({ sessionId, turnId }));
    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_notification_queue_missing",
    });

    childGate.resolve();
    await waitForCondition(async () => {
      const task = await port.getTask?.("agent_notification_queue_missing");
      return task?.status === "completed";
    });

    const task = await port.getTask?.("agent_notification_queue_missing");
    expect(task).toMatchObject({
      status: "completed",
      agentId: "agent_notification_queue_missing",
    });
    expect(task?.notified).not.toBe(true);
  });

  it("does not fake-notify background local agents when parent notification enqueue fails", async () => {
    const sessionId = createSessionId("subagent-notification-enqueue-fails");
    const turnId = createTurnId("subagent-notification-enqueue-fails-turn");
    const childGate = createDeferred<void>();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_notification_enqueue_fails",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: () => {
        throw new Error("parent queue unavailable");
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        await childGate.promise;
        return {
          events: [],
          response: "child finished but parent queue failed",
          traceId: "trace_subagent_notification_enqueue_fails",
        };
      },
    });

    const output = await port.start?.(createSubagentRunRequest({ sessionId, turnId }));
    expect(output).toMatchObject({
      status: "async_launched",
      agentId: "agent_notification_enqueue_fails",
    });

    childGate.resolve();
    await waitForCondition(async () => {
      const task = await port.getTask?.("agent_notification_enqueue_fails");
      return task?.status === "completed" || task?.status === "failed";
    });

    const task = await port.getTask?.("agent_notification_enqueue_fails");
    expect(task).toMatchObject({
      status: "completed",
      agentId: "agent_notification_enqueue_fails",
    });
    expect(task?.notified).not.toBe(true);
  });

  it("keeps foreground local agents inline when auto-background timeout is not configured", async () => {
    const sessionId = createSessionId("subagent-no-auto-background");
    const turnId = createTurnId("subagent-no-auto-background-turn");
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_no_auto_background",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return {
          events: [],
          response: "foreground child finished",
          traceId: "trace_subagent_no_auto_background",
        };
      },
    });

    const output = await port.run(createSubagentRunRequest({ sessionId, turnId }));

    expect(output).toMatchObject({
      status: "completed",
      agentId: "agent_no_auto_background",
    });
    expect(notifications).toEqual([]);
  });

  it.each(["explicit", "profile", "timeout"])(
    "supports off-peak background model overrides: %s",
    async (kind) => {
      const gate = createDeferred<void>();
      const calls: unknown[] = [];
      const port = createExploreSubagentPort({
        createAgentId: () => "idle-background",
        ...(kind === "timeout" ? { autoBackgroundMs: 1 } : {}),
        emitParentEvent: async () => {},
        profiles: [
          {
            name: "Idle Reviewer",
            description: "Review",
            source: "user",
            systemPrompt: "Review",
            tools: ["Read"],
            background: kind === "profile",
          },
        ],
        runExploreAgent: async (request, options) => {
          calls.push(options);
          await request.onSessionReady?.();
          await gate.promise;
          return { events: [], response: "done", traceId: "idle-background-trace" };
        },
      });
      const modelOverride = {
        selection: { providerId: "idle", modelId: "model" },
        background: "allow" as const,
      };
      try {
        const output = await port.launch(
          {
            ...createSubagentRunRequest({
              sessionId: createSessionId("idle-parent"),
              turnId: createTurnId("idle-turn"),
            }),
            agentType: "Idle Reviewer",
            runInBackground: kind === "explicit",
          },
          { modelOverride },
        );
        expect(output.status).toBe("async_launched");
        expect(calls).toEqual([expect.objectContaining({ modelOverride })]);
      } finally {
        gate.resolve();
      }
    },
  );

  it("rejects background launch when an execution model override is present", async () => {
    const sessionId = createSessionId("subagent-background-turn-execution-model");
    const turnId = createTurnId("subagent-background-turn-execution-model-turn");
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_background_turn_execution_model",
      emitParentEvent: async () => {},
      runExploreAgent: async () => {
        throw new Error("background child must not start");
      },
    });

    await expect(
      port.launch(
        {
          ...createSubagentRunRequest({ sessionId, turnId }),
          runInBackground: true,
        },
        {
          signal: new AbortController().signal,
          modelOverride: {
            selection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
            background: "deny",
          },
        },
      ),
    ).rejects.toThrow("Idle-time tasks do not support background agents");
    expect(await port.getTask?.("agent_background_turn_execution_model")).toBeUndefined();
  });

  it("rejects a profile-configured background agent when an execution model override is present", async () => {
    const sessionId = createSessionId("subagent-profile-background-turn-execution-model");
    const turnId = createTurnId("subagent-profile-background-turn-execution-model-turn");
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_profile_background_turn_execution_model",
      emitParentEvent: async () => {},
      profiles: [
        {
          background: true,
          description: "Background reviewer",
          name: "Background Reviewer",
          source: "user",
          systemPrompt: "Review in background.",
          tools: ["Read"],
        },
      ],
      runExploreAgent: async () => {
        throw new Error("profile background child must not start");
      },
    });

    await expect(
      port.launch(
        {
          ...createSubagentRunRequest({ sessionId, turnId }),
          agentType: "Background Reviewer",
        },
        {
          modelOverride: {
            selection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
            background: "deny",
          },
        },
      ),
    ).rejects.toThrow("Idle-time tasks do not support background agents");
    expect(await port.getTask?.("agent_profile_background_turn_execution_model")).toBeUndefined();
  });
});

function modelTextResult(text: string) {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

function providerMessagesToText(messages: readonly { content: ModelMessageContent }[]): string {
  return messages.map((message) => modelMessageContentToText(message.content)).join("\n");
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function recordSetTimeoutUnrefCalls(): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: any[]
  ) => {
    const timer = originalSetTimeout(handler, timeout, ...args);
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      const originalUnref = timer.unref.bind(timer);
      timer.unref = () => {
        calls.push(typeof timeout === "number" ? timeout : Number(timeout ?? 0));
        return originalUnref();
      };
    }
    return timer;
  }) as typeof setTimeout);
  return {
    calls,
    restore: () => {
      setTimeoutSpy.mockRestore();
    },
  };
}

function recordSetTimeoutCalls(): {
  calls: number[];
  restore: () => void;
} {
  const calls: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ...args: any[]
  ) => {
    calls.push(typeof timeout === "number" ? timeout : Number(timeout ?? 0));
    const timer = originalSetTimeout(handler, timeout, ...args);
    return timer;
  }) as typeof setTimeout);
  return {
    calls,
    restore: () => {
      setTimeoutSpy.mockRestore();
    },
  };
}

// 子代理自己主循环的一个模型 step（querySource: "subagent"），runner 从这类事件取部分报告。
function subagentModelStep(sessionId: SessionId, text: string) {
  return createSessionEvent(SessionEventType.ModelComplete, sessionId, {
    content: text,
    querySource: "subagent",
    toolCallCount: 1,
  });
}

class RecordingSessionStore {
  readonly createdSessions: CreateSessionInput[] = [];
  readonly projectPermissions = new Map<string, PermissionRuleset>();
  readonly savedMessages: MessageInfo[] = [];
  readonly savedParts: MessagePart[] = [];
  readonly savedSessionInputs: Array<
    Parameters<NonNullable<SessionStorePort["saveSessionInput"]>>[0]
  > = [];
  readonly promotedSessionInputs: Array<
    Parameters<NonNullable<SessionStorePort["markSessionInputPromoted"]>>[0]
  > = [];
  readonly sessions = new Map<string, SessionInfo>();
  readonly targets = new Map<string, SessionGoal>();
  readonly todos = new Map<string, TodoItem[]>();

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.createdSessions.push(input);
    const now = Date.now();
    const session: SessionInfo = {
      ...input,
      taskType: input.taskType ?? "interactive",
      time: {
        created: input.time?.created ?? now,
        updated: input.time?.updated ?? now,
      },
    };
    this.sessions.set(input.id, session);
    return session;
  }

  async updateSession(
    input: Parameters<SessionStorePort["updateSession"]>[0],
  ): Promise<SessionInfo> {
    const session = this.sessions.get(input.id);
    if (!session) throw new Error(`missing session: ${input.id}`);
    const next: SessionInfo = {
      ...session,
      title: input.title ?? session.title,
      shareURL: input.shareURL === null ? undefined : (input.shareURL ?? session.shareURL),
      summaryAdditions:
        input.summary === null ? undefined : (input.summary?.additions ?? session.summaryAdditions),
      summaryDeletions:
        input.summary === null ? undefined : (input.summary?.deletions ?? session.summaryDeletions),
      summaryFiles:
        input.summary === null ? undefined : (input.summary?.files ?? session.summaryFiles),
      summaryDiffs:
        input.summary === null ? undefined : (input.summary?.diffs ?? session.summaryDiffs),
      permission: input.permission === null ? undefined : (input.permission ?? session.permission),
      time: {
        ...session.time,
        updated: Date.now(),
        compacting:
          input.timeCompacting === null
            ? undefined
            : (input.timeCompacting ?? session.time.compacting),
      },
    };
    this.sessions.set(input.id, next);
    return next;
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return this.sessions.get(sessionID) ?? null;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values());
  }

  async saveMessage(input: MessageInfo): Promise<void> {
    this.savedMessages.push(input);
  }

  async removeMessage(input: {
    messageID: MessageInfo["id"];
    sessionID: SessionId;
  }): Promise<void> {
    removeWhere(
      this.savedMessages,
      (message) => message.sessionID === input.sessionID && message.id === input.messageID,
    );
  }

  async savePart(input: MessagePart): Promise<void> {
    this.savedParts.push(input);
  }

  async saveSessionInput(
    input: Parameters<NonNullable<SessionStorePort["saveSessionInput"]>>[0],
  ): Promise<void> {
    this.savedSessionInputs.push(input);
  }

  async markSessionInputPromoted(
    input: Parameters<NonNullable<SessionStorePort["markSessionInputPromoted"]>>[0],
  ): Promise<void> {
    this.promotedSessionInputs.push(input);
  }

  async removePart(input: {
    messageID: MessageInfo["id"];
    partID: MessagePart["id"];
    sessionID: SessionId;
  }): Promise<void> {
    removeWhere(
      this.savedParts,
      (part) =>
        part.sessionID === input.sessionID &&
        part.messageID === input.messageID &&
        part.id === input.partID,
    );
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return this.savedMessages
      .filter((message) => message.sessionID === input.sessionID)
      .map((info) => ({
        info,
        parts: this.savedParts.filter(
          (part) => part.sessionID === input.sessionID && part.messageID === info.id,
        ),
      }));
  }

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return [...(this.todos.get(input.sessionID) ?? [])];
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.todos.set(input.sessionID, [...input.todos]);
  }

  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return this.targets.get(input.sessionID) ?? null;
  }

  async updateTarget(input: { sessionID: SessionId; target: SessionGoal | null }): Promise<void> {
    if (input.target === null) {
      this.targets.delete(input.sessionID);
      return;
    }
    this.targets.set(input.sessionID, input.target);
  }

  async readProjectPermissions(input: { projectID: string }): Promise<PermissionRuleset | null> {
    return this.projectPermissions.get(input.projectID) ?? null;
  }

  async updateProjectPermissions(input: {
    projectID: string;
    permission: PermissionRuleset | null;
  }): Promise<void> {
    if (input.permission === null) {
      this.projectPermissions.delete(input.projectID);
      return;
    }
    this.projectPermissions.set(input.projectID, input.permission);
  }
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) items.splice(index, 1);
  }
}

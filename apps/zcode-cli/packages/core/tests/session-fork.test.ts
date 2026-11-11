import { describe, expect, it } from "vitest";
import type {
  SessionGoal,
  MessageId,
  MessagePart,
  MessageWithParts,
  ModelSelection,
  SessionEntryInfo,
  SessionInfo,
  SessionId,
  SessionStorePort,
  TraceContext,
} from "@zcode/contracts";
import { SESSION_ENTRY_MODEL_SELECTION, SESSION_ENTRY_PROMPT_SNAPSHOT } from "@zcode/contracts";
import { HIGHSPEED_PROVIDER_IDS } from "@zcode/shared";
import {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "../src/agent/session-history-hydrator.js";
import { MessageHistoryImpl, systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import { resolveGenUiOutputDirectory } from "../src/runtime/helpers/gen-ui-output.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { cloneMessageForFork, clonePartForFork } from "../src/runtime/helpers/steering.js";
import { buildRuntimeReminderMessage } from "../src/runtime/methods/runtime-reminder-persistence.js";
import {
  activeForkTranscriptMessages,
  buildForkHistoryMessages,
  createForkedSession,
  copyGoalStateForFork,
  conversationHistoryBeforeInput,
  createForkIdentityMap,
  deriveForkedGoalStatusFromCopiedVerifications,
  buildAtomicForkNotice,
  createSelectionSideConversation,
  forkConversationBeforeMessage,
  forkStableConversationAtMessage,
  selectionSideChatHistoryMessages,
  stableForkHistoryMessages,
} from "../src/runtime/methods/session-fork.js";
import type {
  StableConversationForkChildMetadata,
  StableConversationForkTarget,
} from "../src/runtime/types.js";

const SESSION_ID = "sess_parent" as SessionId;

function partId(id: string) {
  return `part_${id}` as MessagePart["id"];
}

function userMessage(id: MessageId, text: string, created: number): MessageWithParts {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created },
      agent: "zcode-agent",
      modelSelection: {
        modelId: "glm-4-air" as never,
        providerId: "glm" as never,
      },
      tools: {},
    },
    parts: [
      {
        id: partId(id),
        sessionID: SESSION_ID,
        messageID: id,
        type: "text",
        text,
      },
    ],
  };
}

function compactSummaryMessage(id: MessageId, created: number): MessageWithParts {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created },
      agent: "zcode-agent",
      modelSelection: {
        modelId: "glm-4-air" as never,
        providerId: "glm" as never,
      },
      summary: {
        body: "历史摘要",
        diffs: [],
        title: "Compact summary",
      },
      tools: {},
    },
    parts: [
      {
        id: partId(`${id}_text`),
        sessionID: SESSION_ID,
        messageID: id,
        type: "text",
        text: "compact summary context",
        synthetic: true,
      },
      {
        id: partId(`${id}_compaction`),
        sessionID: SESSION_ID,
        messageID: id,
        type: "compaction",
        auto: false,
        compactReason: "user_requested",
        operationId: "cmp_test",
        phase: "standalone_turn",
        trigger: "manual",
      } as MessagePart,
    ],
  };
}

function assistantMessage(
  id: MessageId,
  parentId: MessageId,
  text: string,
  created: number,
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created, completed: created + 1 },
      parentID: parentId,
      agent: "zcode-agent",
      cost: 0,
      mode: "build",
      modelId: "glm-4-air" as never,
      path: { cwd: "/tmp", root: "/tmp" },
      providerId: "glm" as never,
      tokens: {
        cache: { read: 0, write: 0 },
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
      },
    },
    parts: [
      {
        id: partId(id),
        sessionID: SESSION_ID,
        messageID: id,
        type: "text",
        text,
      },
    ],
  };
}

function goalVerificationEntry(
  id: string,
  anchorAssistantMessageId: string,
  goalIteration: number,
  passed: boolean,
): SessionEntryInfo {
  return {
    id,
    sessionID: SESSION_ID,
    time: { created: goalIteration * 10, updated: goalIteration * 10 + 1 },
    type: "target_completion_verification",
    data: {
      eventId: `event_${id}`,
      payload: {
        anchorAssistantMessageId,
        goalIteration,
        status: "completed",
        targetId: "target_goal_1",
        verification: {
          nextAction: passed ? null : "继续",
          passed,
          reason: passed ? "done" : "not yet",
        },
        verificationId: `verify_${goalIteration}`,
      },
      sequenceNumber: goalIteration,
      traceId: `trace_${id}`,
    },
  };
}

describe("session fork history", () => {
  it("selection side chat 在生成中只复制稳定 user input 边界", () => {
    const stableUser = userMessage("msg_side_stable_user" as MessageId, "稳定问题", 1);
    const stableAssistant = assistantMessage(
      "msg_side_stable_assistant" as MessageId,
      stableUser.info.id,
      "稳定回答",
      2,
    );
    const activeUser = userMessage("msg_side_active_user" as MessageId, "本轮问题", 3);
    activeUser.info.anchor = {
      turnId: "turn_side_active" as never,
      productTurnId: "product_side_active",
      orderedMessageIds: [activeUser.info.id],
      boundaryMessageId: activeUser.info.id,
      origin: "realUser",
    };
    const streamingAssistant = assistantMessage(
      "msg_side_streaming_assistant" as MessageId,
      activeUser.info.id,
      "流式片段",
      4,
    );
    streamingAssistant.info.anchor = {
      ...activeUser.info.anchor,
      orderedMessageIds: [activeUser.info.id, streamingAssistant.info.id],
      boundaryMessageId: streamingAssistant.info.id,
    };

    expect(
      selectionSideChatHistoryMessages(
        [stableUser, stableAssistant, activeUser, streamingAssistant],
        "turn_side_active" as never,
      ).map((message) => message.info.id),
    ).toEqual([stableUser.info.id, stableAssistant.info.id, activeUser.info.id]);
  });

  it("selection side chat 原子创建隐藏 child，不复制 goal 或 fork notice", async () => {
    const user = userMessage("msg_side_user" as MessageId, "解释这里", 1);
    const assistant = assistantMessage(
      "msg_side_assistant" as MessageId,
      user.info.id,
      "父任务回答",
      2,
    );
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
      projectID: "project-selection-side-chat",
      slug: "parent-selection-side-chat",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
      null;
    const parentEvents: unknown[] = [];
    const runtime = {
      activeTurn: null,
      appendEvent: async (event: unknown) => parentEvents.push(event),
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: (_type: unknown, payload: Record<string, unknown>) => ({ payload }),
      getSessionModelSelection: () => ({
        modelId: "glm-4-air",
        providerId: "glm",
        options: { reasoningLevel: "high" },
      }),
      rootTraceContext: { traceId: "trace_selection_side_chat" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkFromSource(input) {
          const bundle = input.build({ session: parentSession, messages: [user, assistant] });
          committedBundle = bundle;
          return bundle.child as SessionInfo;
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [user, assistant];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    const result = await createSelectionSideConversation.call(runtime as never, {
      sourceCommandId: "cmd-selection-side-chat",
    });

    expect(result.parentSessionId).toBe(SESSION_ID);
    expect(parentEvents).toEqual([]);
    expect(committedBundle!.child).toMatchObject({
      parentID: SESSION_ID,
      permission: parentSession.permission,
      taskType: "selection_side_chat",
      title: "Selection side chat",
    });
    expect(committedBundle!.goal).toBeUndefined();
    expect(committedBundle!.entries).toEqual([
      expect.objectContaining({
        sessionID: result.forkedSessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
        touchSession: false,
        data: {
          modelId: "glm-4-air",
          providerId: "glm",
          options: { reasoningLevel: "high" },
        },
      }),
      expect.objectContaining({
        type: "runtime/execution_state",
        data: { mode: "build", planEnabled: false },
      }),
    ]);
    expect(committedBundle!.commandFact.ack.result).toEqual({
      type: "createSelectionSideSession",
      sessionId: result.forkedSessionId,
    });
    expect(committedBundle!.messages).toHaveLength(3);
    expect(
      committedBundle!.messages.every(
        (message) =>
          message.info.visibility === "model-only" &&
          message.info.semantics?.uiVisibility === "hidden" &&
          message.info.semantics.providerVisibility === "visible",
      ),
    ).toBe(true);
    expect(committedBundle!.messages.at(-1)?.info.source).toBe("selection_side_chat");
    expect(JSON.stringify(committedBundle!.messages)).not.toContain("session_fork");

    // 直接恢复 producer 的原子 bundle，避免手写 metadata fixture 掩盖 fork 漏写字段。
    const persisted = JSON.parse(JSON.stringify(committedBundle!.messages)) as MessageWithParts[];
    const boundary = persisted.at(-1)!;
    expect(boundary.parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      metadata: {
        source: "selection_side_chat",
        runtimeMessage: { source: "selection_side_chat" },
      },
    });
    const boundaryText = boundary.parts[0]!.type === "text" ? boundary.parts[0]!.text : "";
    expect(boundaryText).toContain("Do not continue the parent's active work automatically");
    expect(boundaryText).not.toContain("<system-reminder>");
    const history = new MessageHistoryImpl();
    await hydrateMessageHistoryFromSession({ history, messages: persisted });
    expect(history.toRuntimeEntries().at(-1)).toEqual({
      kind: "attachment",
      content: boundaryText,
      metadata: { source: "selection_side_chat" },
    });
    history.addUser("child question", { source: "real_user" });
    for (const useMidConversationSystem of [true, false]) {
      const request = buildProviderRequestMessages({
        entries: history.toRuntimeEntries(),
        useMidConversationSystem,
      });
      expect(request.messages.slice(-2)).toEqual([
        { role: "user", content: `<system-reminder>\n${boundaryText}\n</system-reminder>` },
        { role: "user", content: "child question" },
      ]);
      expect(JSON.stringify(request.messages).split(boundaryText)).toHaveLength(2);
    }
  });

  const selectionSideChatGoalCases: ReadonlyArray<{
    label: string;
    passed?: boolean;
    status: SessionGoal["status"];
  }> = [
    { label: "active 无 verifier", status: "active" },
    { label: "failed verifier 后 paused", passed: false, status: "paused" },
    { label: "passed verifier 后 complete", passed: true, status: "complete" },
  ];

  it.each(selectionSideChatGoalCases)(
    "selection side chat 从 $label Goal 父任务创建时不继承 Goal 运行态",
    async ({ label, passed, status }) => {
      const user = userMessage(`msg_side_goal_user_${status}` as MessageId, "解释这里", 1);
      const assistant = assistantMessage(
        `msg_side_goal_assistant_${status}` as MessageId,
        user.info.id,
        "父任务回答",
        2,
      );
      const targetId = `target_side_goal_${status}`;
      const verificationEntryId = `entry_side_goal_${status}`;
      const verificationId = `verify_side_goal_${status}`;
      const goal: SessionGoal = {
        activeInputId: status === "active" ? "input-side-goal" : null,
        activeRunLastSeenAtMs: status === "active" ? 2 : null,
        activeRunStartedAtMs: status === "active" ? 1 : null,
        objective: `Goal ${label}`,
        sessionID: SESSION_ID,
        status,
        summaryTitle: null,
        targetID: targetId,
        time: { created: 1, updated: 2 },
        timeUsedSeconds: 1,
        tokenBudget: null,
        tokensUsed: 1,
      };
      const anchor = {
        boundaryMessageId: assistant.info.id,
        goalBoundary: {
          kind: "snapshot" as const,
          target: goal,
          verificationEntryIds: passed === undefined ? [] : [verificationEntryId],
        },
        orderedMessageIds: [user.info.id, assistant.info.id],
        productTurnId: `product_side_goal_${status}`,
        turnId: `turn_side_goal_${status}` as never,
      };
      user.info.anchor = anchor;
      assistant.info.anchor = anchor;
      if (passed !== undefined) {
        assistant.parts.push({
          anchorMessageId: assistant.info.id,
          anchorTurnId: anchor.turnId,
          display: "separator",
          id: partId(`side_goal_timeline_${status}`),
          messageID: assistant.info.id,
          sessionID: SESSION_ID,
          status: "completed",
          targetId,
          timelineType: "goal_verification",
          type: "timeline",
          verificationId,
        } as MessagePart);
      }
      const parentSession = {
        directory: "/workspace",
        id: SESSION_ID,
        path: "/workspace",
        projectID: "project-selection-side-chat-goal",
        slug: `parent-selection-side-chat-${status}`,
        taskType: "interactive",
        time: { created: 1, updated: 2 },
        title: "parent goal",
        version: "test",
      } as SessionInfo;
      let sessionEntriesReadCount = 0;
      let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
        null;
      const runtime = {
        activeTurn: null,
        appendEvent: async () => undefined,
        config: { agentName: "zcode-agent", mode: "build" },
        createEvent: () => ({ type: "session.forked" }),
        getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
        rootTraceContext: { traceId: `trace_selection_side_chat_${status}` },
        sessionId: SESSION_ID,
        sessionStore: {
          async commitForkFromSource(input) {
            const bundle = input.build({ session: parentSession, messages: [user, assistant] });
            committedBundle = bundle;
            return bundle.child as SessionInfo;
          },
          async getSession() {
            return parentSession;
          },
          async messages() {
            return [user, assistant];
          },
          async sessionEntries() {
            sessionEntriesReadCount += 1;
            return [];
          },
        } satisfies Partial<SessionStorePort>,
        workingDirectory: "/workspace",
        workspaceRoot: "/workspace",
      };

      await expect(
        createSelectionSideConversation.call(runtime as never, {
          sourceCommandId: `cmd-selection-side-chat-${status}`,
        }),
      ).resolves.toMatchObject({ parentSessionId: SESSION_ID });

      expect(sessionEntriesReadCount).toBe(0);
      expect(committedBundle!.goal).toBeUndefined();
      expect(committedBundle!.entries).toEqual([
        expect.objectContaining({
          sessionID: committedBundle!.child.id,
          type: SESSION_ENTRY_MODEL_SELECTION,
          touchSession: false,
          data: { modelId: "glm-4-air", providerId: "glm" },
        }),
        expect.objectContaining({
          type: "runtime/execution_state",
          data: { mode: "build", planEnabled: false },
        }),
      ]);
      const copiedParentMessages = committedBundle!.messages.slice(0, -1);
      expect(copiedParentMessages).toHaveLength(2);
      expect(
        copiedParentMessages.every((message) => message.info.anchor?.goalBoundary === undefined),
      ).toBe(true);
      expect(copiedParentMessages[0]?.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "解释这里", type: "text" })]),
      );
      expect(JSON.stringify(copiedParentMessages)).not.toContain(targetId);
      expect(JSON.stringify(copiedParentMessages)).not.toContain(verificationEntryId);
      expect(user.info.anchor?.goalBoundary).toBe(anchor.goalBoundary);
    },
  );

  it("ForkIdentityMap 预分配 fork notice 全部 identity，builder 只能消费 plan", () => {
    const user = userMessage("msg_notice_parent_user" as MessageId, "notice", 1);
    const assistant = assistantMessage(
      "msg_notice_parent_assistant" as MessageId,
      user.info.id,
      "answer",
      2,
    );
    const childSessionId = "sess_notice_plan_child" as SessionId;
    const identities = createForkIdentityMap({
      childSessionId,
      entries: [],
      goalSnapshots: [],
      messages: [user, assistant],
      parentSessionId: SESSION_ID,
    });
    const runtime = {
      config: { agentName: "zcode-agent", mode: "build" },
      getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
      sessionId: SESSION_ID,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };
    const notices = buildAtomicForkNotice(runtime as never, {
      identities,
      sourceCommandId: "cmd-notice-plan",
      targetMessageId: assistant.info.id,
    });
    const hidden = notices[0]!;
    const notice = notices[1]!;
    const timeline = notice.parts[0];

    expect(identities.notice).toEqual({
      hiddenMessageId: expect.any(String),
      hiddenPartId: expect.any(String),
      messageId: expect.any(String),
      partId: expect.any(String),
      turnId: expect.any(String),
      productTurnId: expect.any(String),
    });
    expect(hidden.info.id).toBe(identities.notice.hiddenMessageId);
    expect(hidden.parts[0]?.id).toBe(identities.notice.hiddenPartId);
    expect(notice.info.id).toBe(identities.notice.messageId);
    expect(notice.parts[0]?.id).toBe(identities.notice.partId);
    expect(hidden.info.anchor).toMatchObject({
      turnId: identities.notice.turnId,
      productTurnId: identities.notice.productTurnId,
      orderedMessageIds: [identities.notice.hiddenMessageId, identities.notice.messageId],
      boundaryMessageId: identities.notice.messageId,
    });
    expect(notice.info.anchor).toEqual(hidden.info.anchor);
    expect(notice.info.role).toBe("assistant");
    if (notice.info.role !== "assistant" || timeline?.type !== "timeline") return;
    expect(notice.info.parentID).toBe(identities.notice.hiddenMessageId);
    expect(timeline.anchorMessageId).toBe(identities.messageIds.get(assistant.info.id));
    expect(timeline.anchorTurnId).toBe(identities.notice.turnId);
    // parent target 只允许保留在 forkOrigin/session_fork 的来源事实；所有 child-local 引用必须闭合。
    const childLocalRefs = {
      hiddenId: hidden.info.id,
      hiddenPartId: hidden.parts[0]?.id,
      hiddenPartMessageId: hidden.parts[0]?.messageID,
      noticeId: notice.info.id,
      noticePartId: notice.parts[0]?.id,
      noticePartMessageId: notice.parts[0]?.messageID,
      noticeParentId: notice.info.parentID,
      hiddenAnchor: hidden.info.anchor,
      noticeAnchor: notice.info.anchor,
      timelineAnchorMessageId: timeline.anchorMessageId,
      timelineAnchorTurnId: timeline.anchorTurnId,
    };
    expect(JSON.stringify(childLocalRefs)).not.toContain("msg_notice_parent_user");
    expect(JSON.stringify(childLocalRefs)).not.toContain("msg_notice_parent_assistant");

    const grandchildSessionId = "sess_notice_plan_grandchild" as SessionId;
    const forkAgainIdentities = createForkIdentityMap({
      childSessionId: grandchildSessionId,
      entries: [],
      goalSnapshots: [],
      messages: notices,
      parentSessionId: childSessionId,
    });
    const forkAgainNotices = buildAtomicForkNotice(
      { ...runtime, sessionId: childSessionId } as never,
      {
        identities: forkAgainIdentities,
        sourceCommandId: "cmd-notice-plan-again",
        targetMessageId: notice.info.id,
      },
    );
    const forkAgainHidden = forkAgainNotices[0]!;
    const forkAgainNotice = forkAgainNotices[1]!;
    const forkAgainTimeline = forkAgainNotice.parts[0];
    expect(forkAgainNotice.info.role).toBe("assistant");
    if (forkAgainNotice.info.role !== "assistant" || forkAgainTimeline?.type !== "timeline") return;
    const forkAgainLocalRefs = {
      hiddenId: forkAgainHidden.info.id,
      hiddenPartId: forkAgainHidden.parts[0]?.id,
      hiddenPartMessageId: forkAgainHidden.parts[0]?.messageID,
      hiddenPartSessionId: forkAgainHidden.parts[0]?.sessionID,
      noticeId: forkAgainNotice.info.id,
      noticePartId: forkAgainTimeline.id,
      noticePartMessageId: forkAgainTimeline.messageID,
      noticeParentId: forkAgainNotice.info.parentID,
      hiddenAnchor: forkAgainHidden.info.anchor,
      noticeAnchor: forkAgainNotice.info.anchor,
      timelineAnchorMessageId: forkAgainTimeline.anchorMessageId,
      timelineAnchorTurnId: forkAgainTimeline.anchorTurnId,
    };
    for (const parentLocalId of [
      identities.notice.hiddenMessageId,
      identities.notice.hiddenPartId,
      identities.notice.messageId,
      identities.notice.partId,
      identities.notice.turnId,
    ]) {
      expect(JSON.stringify(forkAgainLocalRefs)).not.toContain(parentLocalId);
    }
  });

  it.each([
    {
      command: "ui-fork",
      mode: "yolo",
      permission: {
        mode: "yolo",
        scope: "session",
        allow: [{ toolName: "Bash", ruleContent: "*" }],
      },
      rejected: false,
    },
    {
      command: "app-control-granted",
      mode: "build",
      permission: {
        mode: "build",
        scope: "session",
        allow: [{ toolName: "Bash", ruleContent: "*" }],
      },
      rejected: true,
    },
    { command: "app-control-yolo", mode: "yolo", permission: { mode: "build" }, rejected: true },
    {
      command: "app-control-parent-yolo",
      mode: "build",
      permission: { mode: "yolo" },
      rejected: true,
    },
    { command: "app-control-safe", mode: "build", permission: { mode: "build" }, rejected: false },
  ])(
    "stable fork owner checks the exact permission bundle for $command",
    async ({ command, mode, permission, rejected }) => {
      const user = userMessage("msg_permission_user" as MessageId, "fork", 1);
      const assistant = assistantMessage(
        "msg_permission_assistant" as MessageId,
        user.info.id,
        "done",
        2,
      );
      if (assistant.info.role !== "assistant") throw new Error("Expected assistant");
      assistant.info.mode = mode;
      const parent = {
        id: SESSION_ID,
        directory: "/workspace",
        path: "/workspace",
        projectID: "project",
        slug: "parent",
        title: "parent",
        taskType: "interactive",
        version: "test",
        time: { created: 1, updated: 1 },
        permission,
      } as SessionInfo;
      let committed: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | undefined;
      const runtime = {
        appendEvent: async () => undefined,
        createEvent: (_type: unknown, payload: unknown) => ({ payload }),
        config: { agentName: "zcode-agent", mode: "build" },
        getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
        sessionId: SESSION_ID,
        rootTraceContext: { traceId: "trace-fork-guard" },
        workingDirectory: "/workspace",
        workspaceRoot: "/workspace",
        sessionStore: {
          getSession: async () => parent,
          messages: async () => [user, assistant],
          commitForkBundle: async (bundle) => {
            committed = bundle;
            return bundle.child as SessionInfo;
          },
        } satisfies Partial<SessionStorePort>,
      };
      const fork = forkStableConversationAtMessage.call(runtime as never, {
        forkedSessionId: "sess_safe_fork" as SessionId,
        goalBoundary: { kind: "none" },
        sourceCommandId: command,
        target: {
          productTurnId: "product",
          transcriptTurnId: "turn",
          orderedMessageIds: [String(user.info.id), String(assistant.info.id)],
          boundaryMessageId: String(assistant.info.id),
        },
      });
      if (rejected) {
        await expect(fork).rejects.toMatchObject({
          message: "guard.appControlForkPermissionUnsafe",
          reasonCode: "guard.appControlForkPermissionUnsafe",
        });
        expect(committed).toBeUndefined();
      } else {
        await fork;
        expect(committed!.child.permission).toEqual(permission);
        expect(committed!.entries).toContainEqual(
          expect.objectContaining({
            type: "runtime/execution_state",
            data: { mode, planEnabled: false },
          }),
        );
      }
      expect(parent.permission).toEqual(permission);
    },
  );
  it("fork-before-input 的选型回退跳过停止后的中断标记", async () => {
    const user = userMessage("msg_marker_user" as MessageId, "first", 1);
    const assistant = assistantMessage(
      "msg_marker_assistant" as MessageId,
      user.info.id,
      "stopped answer",
      2,
    );
    if (assistant.info.role !== "assistant") return;
    assistant.info.reasoningLevel = "max";
    const target = userMessage("msg_marker_target" as MessageId, "edit me", 4);
    const runtimeSelection = {
      modelId: "glm-4-air",
      providerId: "glm",
      options: { reasoningLevel: "high" },
    };
    // 停止后写的中断标记：只记 provider/model，不带 options。
    const marker = buildRuntimeReminderMessage(
      {
        config: { agentName: "zcode-agent" },
        getSessionModelSelection: () => runtimeSelection,
        sessionId: SESSION_ID,
      } as never,
      {
        message: { role: "user", content: "[Request interrupted by user]" },
        metadata: { source: "interrupt_marker" },
      },
      { created: 3 },
    )!;
    let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
      null;
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project-marker-fork",
      slug: "parent-marker-fork",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    const runtime = {
      appendEvent: async () => undefined,
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: (_type: unknown, payload: Record<string, unknown>) => ({ payload }),
      getSessionModelSelection: () => runtimeSelection,
      rootTraceContext: { traceId: "trace_marker_fork" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle(bundle) {
          committedBundle = bundle;
          return bundle.child as SessionInfo;
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [user, assistant, marker, target];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    await forkConversationBeforeMessage.call(runtime as never, {
      commandFact: {
        parentSessionId: SESSION_ID,
        sourceCommandId: "cmd-marker-fork",
        ack: {
          commandId: "cmd-marker-fork",
          status: "accepted",
          revisionAtDecision: 1,
          result: { type: "editUserQuery", disposition: "fork", sessionId: "sess_marker_child" },
        },
        metadata: {},
      },
      forkedSessionId: "sess_marker_child" as SessionId,
      goalBoundary: { kind: "none" },
      initialInput: {
        id: "queue_cmd-marker-fork",
        sessionID: "sess_marker_child" as SessionId,
        kind: "sendText",
        delivery: "startNow",
        payload: { text: "edited" },
      },
      sourceCommandId: "cmd-marker-fork",
      targetMessageId: target.info.id,
      targetProductTurnId: "turn-product",
      targetTranscriptTurnId: "turn-runtime",
    });

    // 取 fork 点之前最后一条对话消息（assistant）的选型，而不是中断标记或 runtime 当前值。
    expect(
      committedBundle!.entries.find((entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION)?.data,
    ).toEqual({ modelId: "glm-4-air", providerId: "glm", options: { reasoningLevel: "max" } });
  });

  it("V4 stable fork 只通过 commitForkBundle 一次发布完整 child", async () => {
    const user = userMessage("msg_atomic_user" as MessageId, "fork me", 1);
    const assistant = assistantMessage(
      "msg_atomic_assistant" as MessageId,
      user.info.id,
      "stable answer",
      2,
    );
    if (assistant.info.role !== "assistant") return;
    assistant.info.reasoningLevel = "max";
    assistant.info.mode = "edit";
    assistant.info.planEnabled = true;
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project-atomic-stable",
      slug: "parent-atomic-stable",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
      null;
    let legacyCreateCount = 0;
    const promptSnapshot = {
      model: { providerId: "glm", modelId: "glm-4-air" },
      system: [{ role: "system" as const, content: "parent system" }],
    };
    const runtime = {
      appendEvent: async () => undefined,
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: (_type: unknown, payload: Record<string, unknown>) => ({ payload }),
      getSessionModelSelection: () => ({
        modelId: "glm-4-air",
        providerId: "glm",
        options: { reasoningLevel: "high" },
      }),
      promptSnapshot,
      rootTraceContext: { traceId: "trace_atomic_stable" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle(bundle) {
          committedBundle = bundle;
          return bundle.child as SessionInfo;
        },
        async createForkedSessionWithMetadata() {
          legacyCreateCount += 1;
          throw new Error("V4 stable fork touched legacy create path");
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [user, assistant];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    const result = await forkStableConversationAtMessage.call(runtime as never, {
      forkedSessionId: "sess_atomic_stable_child" as SessionId,
      goalBoundary: { kind: "none" },
      sourceCommandId: "cmd-atomic-stable",
      target: {
        productTurnId: "product-atomic",
        transcriptTurnId: "turn-atomic",
        orderedMessageIds: [String(user.info.id), String(assistant.info.id)],
        boundaryMessageId: String(assistant.info.id),
      },
    });

    expect(result.forkedSessionId).toBe("sess_atomic_stable_child");
    expect(committedBundle!.entries).toContainEqual(
      expect.objectContaining({
        type: "runtime/execution_state",
        data: { mode: "edit", planEnabled: true },
      }),
    );
    expect(legacyCreateCount).toBe(0);
    // child 沿用父会话的 prompt 快照，与其余 entry 在同一个 bundle 里提交。
    expect(committedBundle!.entries).toContainEqual(
      expect.objectContaining({
        id: "sess_atomic_stable_child:runtime-prompt-snapshot",
        sessionID: "sess_atomic_stable_child",
        type: SESSION_ENTRY_PROMPT_SNAPSHOT,
        touchSession: false,
        data: promptSnapshot,
      }),
    );
    expect(committedBundle!.messages).toHaveLength(4);
    expect(committedBundle!.messages.at(-1)!.info).toMatchObject({
      mode: "edit",
      planEnabled: true,
    });
    const modelSelectionEntry = committedBundle!.entries.find(
      (entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION,
    );
    expect(modelSelectionEntry).toMatchObject({
      id: "sess_atomic_stable_child:runtime-model-selection",
      sessionID: "sess_atomic_stable_child",
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      data: {
        modelId: "glm-4-air",
        providerId: "glm",
        options: { reasoningLevel: "max" },
      },
    });
    const forkNoticeAssistant = committedBundle!.messages.at(-1)?.info;
    expect(forkNoticeAssistant).toMatchObject({
      role: "assistant",
      modelId: "glm-4-air",
      providerId: "glm",
      reasoningLevel: "max",
    });
    expect(committedBundle!.commandFact.ack.result).toEqual({
      type: "forkAssistant",
      sessionId: "sess_atomic_stable_child",
    });

    // 从真实 producer bundle 恢复，防止 notice 缺少 part metadata 后退化为普通 user 文本。
    const persisted = JSON.parse(JSON.stringify(committedBundle!.messages)) as MessageWithParts[];
    const boundary = persisted.at(-2)!;
    expect(boundary.info.semantics).toMatchObject({
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "hidden",
    });
    expect(boundary.parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      metadata: { source: "fork", runtimeMessage: { source: "conversation_fork" } },
    });
    const boundaryText = boundary.parts[0]!.type === "text" ? boundary.parts[0]!.text : "";
    expect(boundaryText).toContain("This session was forked from a previous session message.");
    expect(boundaryText).not.toContain("<system-reminder>");
    const history = new MessageHistoryImpl();
    await hydrateMessageHistoryFromSession({ history, messages: persisted });
    expect(history.toRuntimeEntries().at(-1)).toEqual({
      kind: "attachment",
      content: boundaryText,
      metadata: { source: "conversation_fork" },
    });
    history.addUser("child question", { source: "real_user" });
    for (const useMidConversationSystem of [true, false]) {
      const request = buildProviderRequestMessages({
        entries: history.toRuntimeEntries(),
        useMidConversationSystem,
      });
      expect(request.messages.slice(-2)).toEqual([
        { role: "user", content: `<system-reminder>\n${boundaryText}\n</system-reminder>` },
        { role: "user", content: "child question" },
      ]);
      expect(
        request.messages.filter(
          (message) =>
            typeof message.content === "string" && message.content.includes(boundaryText),
        ),
      ).toHaveLength(1);
    }
  });

  // 父会话历史：用户消息、环境完整块（带父会话 Gen UI 目录）、可选的压缩摘要、助手回答。
  // genUi: false 时 Desktop 没有 Gen UI，公告不带目录；targetCwd 时 fork 到另一个 cwd（受管 worktree）。
  async function forkWithEnvironmentHistory(
    options: { compactedAfterEnvironment?: boolean; genUi?: boolean; targetCwd?: string } = {},
  ) {
    const user = userMessage("msg_env_user" as MessageId, "fork me", 1);
    const summary = compactSummaryMessage("msg_env_summary" as MessageId, 3);
    const assistant = assistantMessage("msg_env_assistant" as MessageId, user.info.id, "answer", 4);
    const config = {
      agentName: "zcode-agent",
      mode: "build",
      presentationSurface: "zcode_desktop",
      ...(options.genUi === false ? {} : { genUiOutputRoot: "/gen-ui" }),
      workspacePath: "/workspace",
    };
    const childSessionId = "sess_env_child" as SessionId;
    // 会话 runtime 自己算目录的方式：worktree 子会话的 workspace 路径就是它的 cwd。
    // genUi: false 时没有输出根目录，返回 undefined。
    const directoryOf = (sessionId: SessionId, workspacePath = "/workspace"): string | undefined =>
      resolveGenUiOutputDirectory({
        config: { ...config, workspacePath },
        sessionId,
        workspaceRoot: workspacePath,
      } as never);
    const parentDirectory = directoryOf(SESSION_ID);
    const environment = buildRuntimeReminderMessage(
      { config, getSessionModelSelection: () => undefined, sessionId: SESSION_ID } as never,
      {
        ...systemReminderAttachmentEntry("environment", "# Environment"),
        metadata: {
          source: "environment",
          environment: {
            full: true,
            snapshot: {
              cwd: "/workspace",
              platform: "darwin",
              shell: "zsh",
              osVersion: "Darwin 24.3.0",
              isGitRepository: true,
              additionalWorkingDirectories: [],
              ...(parentDirectory ? { visualizationDirectory: parentDirectory } : {}),
              // 带目录的公告一定来自 Desktop 运行面（withDesktopContext 同时写这两项）。
              desktopContext: true,
            },
          },
        },
      },
      { created: 2 },
    )!;
    const history = options.compactedAfterEnvironment
      ? [user, environment, summary, assistant]
      : [user, environment, assistant];
    let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
      null;
    const runtime = {
      appendEvent: async () => undefined,
      config,
      createEvent: (_type: unknown, payload: Record<string, unknown>) => ({ payload }),
      getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
      // 是否在 Desktop 由 context builder 有没有 Desktop 段决定，与普通环境公告相同。
      latestContextBuildResult: { sections: [{ source: "desktop_context" }] },
      rootTraceContext: { traceId: "trace_env_fork" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle(bundle) {
          committedBundle = bundle;
          return bundle.child as SessionInfo;
        },
        async getSession() {
          return {
            directory: "/workspace",
            id: SESSION_ID,
            path: "/workspace",
            projectID: "project-env",
            slug: "parent-env",
            taskType: "interactive",
            time: { created: 1, updated: 1 },
            title: "parent",
            version: "test",
          } as SessionInfo;
        },
        async messages() {
          return history;
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    await forkStableConversationAtMessage.call(runtime as never, {
      forkedSessionId: childSessionId,
      goalBoundary: { kind: "none" },
      sourceCommandId: "cmd-env-fork",
      target: {
        productTurnId: "product-env",
        transcriptTurnId: "turn-env",
        orderedMessageIds: history.map((message) => String(message.info.id)),
        boundaryMessageId: String(assistant.info.id),
      },
      ...(options.targetCwd
        ? {
            targetCwd: {
              directory: options.targetCwd,
              projectID: "project-env" as never,
              worktreeCreation: {
                path: options.targetCwd,
                sha: "9e6d2f72d4",
                ref: null,
                output: "",
              },
            },
          }
        : {}),
    });
    const messages = committedBundle!.messages;
    const environmentMessages = messages.filter((message) =>
      message.parts.some((part) => part.metadata?.runtimeMessage?.source === "environment"),
    );
    return {
      childDirectory: directoryOf(childSessionId),
      childSessionId,
      copiedCount: history.length,
      directoryOf,
      environmentMessages,
      messages,
      parentDirectory,
    };
  }

  it("fork 在子会话里补一条环境更新，宣告子会话自己的 Gen UI 目录", async () => {
    const {
      childDirectory,
      childSessionId,
      copiedCount,
      environmentMessages,
      messages,
      parentDirectory,
    } = await forkWithEnvironmentHistory();

    // 修复原因：子会话第一个请求若是新轮通知，输入附件不收集，模型只能看到父会话的目录。
    // fork 时直接写入更新，子会话的任何第一个请求都带着它。
    // 复制的历史里一条完整块，fork 补一条更新。
    expect(environmentMessages).toHaveLength(2);
    const update = environmentMessages[1]!;
    expect(update.info.sessionID).toBe(childSessionId);
    expect(update.parts.every((part) => part.sessionID === childSessionId)).toBe(true);
    expect(update.parts[0]).toMatchObject({
      text: `# Environment update\n - Visualization directory for this session: ${childDirectory} (was ${parentDirectory})`,
      metadata: {
        runtimeMessage: {
          source: "environment",
          environment: { full: false, snapshot: { visualizationDirectory: childDirectory } },
        },
      },
    });
    // 排在复制的历史之后、fork 提示之前。
    const updateIndex = messages.indexOf(update);
    expect(updateIndex).toBe(copiedCount);
    expect(
      messages
        .slice(updateIndex + 1)
        .some((message) => message.info.semantics?.kind === "fork_notice"),
    ).toBe(true);
  });

  it("环境公告只在压缩之前时，fork 不补更新，由子会话下一次公告发完整块", async () => {
    // 子会话的模型视图从压缩摘要开始，看不到父会话目录；补一条更新反而没有完整块可依。
    const { environmentMessages } = await forkWithEnvironmentHistory({
      compactedAfterEnvironment: true,
    });
    expect(environmentMessages).toHaveLength(1);
  });

  it("fork 到另一个 cwd 时，更新写出新工作目录，目录与子会话自己算出的相同", async () => {
    // 修复原因：fork 到受管 worktree 时子会话换了 cwd。原来 cwd 沿用父会话、目录按父会话的 workspace
    // 路径计算，子会话第一个请求若是新轮通知，模型看到的是父会话的工作目录，生成的文件也写进按父会话
    // 路径算出的目录，不是子会话自己的目录。
    const worktree = "/workspace/worktrees/3f2a/workspace";
    const { childSessionId, directoryOf, environmentMessages, parentDirectory } =
      await forkWithEnvironmentHistory({ targetCwd: worktree });
    const childDirectory = directoryOf(childSessionId, worktree);
    // 目录由 workspace 路径与 session id 决定，worktree 子会话的目录与按父会话路径算出的不同。
    expect(childDirectory).not.toBe(directoryOf(childSessionId));
    expect(environmentMessages).toHaveLength(2);
    expect(environmentMessages[1]!.parts[0]).toMatchObject({
      text: `# Environment update\n - Primary working directory: ${worktree} (was /workspace)\n - Visualization directory for this session: ${childDirectory} (was ${parentDirectory})`,
      metadata: {
        runtimeMessage: {
          source: "environment",
          environment: {
            full: false,
            snapshot: { cwd: worktree, visualizationDirectory: childDirectory },
          },
        },
      },
    });
  });

  it("父会话公告没有目录时，只有 cwd 变化才写更新", async () => {
    // Desktop 没有 Gen UI：目录不随 fork 变化；fork 到另一个 cwd 时仍要宣告新的工作目录。
    const worktree = "/workspace/worktrees/3f2a/workspace";
    const sameCwd = await forkWithEnvironmentHistory({ genUi: false });
    expect(sameCwd.environmentMessages).toHaveLength(1);
    const { environmentMessages } = await forkWithEnvironmentHistory({
      genUi: false,
      targetCwd: worktree,
    });
    expect(environmentMessages).toHaveLength(2);
    expect(environmentMessages[1]!.parts[0]).toMatchObject({
      text: `# Environment update\n - Primary working directory: ${worktree} (was /workspace)`,
    });
  });

  it("加速轮分叉不继承加速卡 Selection，child 回落父会话常驻模型", async () => {
    const user = userMessage("msg_highspeed_user" as MessageId, "加速中提问", 1);
    const assistant = assistantMessage(
      "msg_highspeed_assistant" as MessageId,
      user.info.id,
      "加速回答",
      2,
    );
    if (user.info.role !== "user" || assistant.info.role !== "assistant") return;
    // 加速轮的 user/assistant 按 highspeed-card-spec §5 记录本轮真实执行模型（单轮执行事实）。
    user.info.modelSelection = {
      modelId: "glm-4.6" as never,
      providerId: HIGHSPEED_PROVIDER_IDS.zai as never,
    };
    assistant.info.providerId = HIGHSPEED_PROVIDER_IDS.zai as never;
    assistant.info.modelId = "glm-4.6" as never;
    assistant.info.reasoningLevel = "max";
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project-highspeed-fork",
      slug: "parent-highspeed-fork",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
      null;
    const runtime = {
      appendEvent: async () => undefined,
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: (_type: unknown, payload: Record<string, unknown>) => ({ payload }),
      // 加速是 `selectionScope=execution`，从不改写常驻 Selection：它就是用户的原模型。
      getSessionModelSelection: () => ({
        modelId: "glm-4-air",
        providerId: "glm",
        options: { reasoningLevel: "high" },
      }),
      rootTraceContext: { traceId: "trace_highspeed_fork" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle(bundle) {
          committedBundle = bundle;
          return bundle.child as SessionInfo;
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [user, assistant];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    // 不带显式选型（回落历史/常驻）与调用方显式传入加速选型，child 结果必须一致。
    const explicitCases: (ModelSelection | undefined)[] = [
      undefined,
      { modelId: "glm-4.6" as never, providerId: HIGHSPEED_PROVIDER_IDS.zai as never },
    ];
    for (const [index, explicit] of explicitCases.entries()) {
      committedBundle = null;
      await forkStableConversationAtMessage.call(runtime as never, {
        forkedSessionId: `sess_highspeed_child_${index}` as SessionId,
        goalBoundary: { kind: "none" },
        sourceCommandId: `cmd-highspeed-fork-${index}`,
        ...(explicit ? { modelSelection: explicit } : {}),
        target: {
          productTurnId: "product-highspeed",
          transcriptTurnId: "turn-highspeed",
          orderedMessageIds: [String(user.info.id), String(assistant.info.id)],
          boundaryMessageId: String(assistant.info.id),
        },
      });

      // child 常驻在加速 Provider 上会让用户看到「原模型没带过来」，首轮还会 ModelRequestAuthMissing。
      expect(
        committedBundle!.entries.find((entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION),
      ).toMatchObject({
        sessionID: `sess_highspeed_child_${index}`,
        data: { modelId: "glm-4-air", providerId: "glm", options: { reasoningLevel: "high" } },
      });
      expect(committedBundle!.messages.at(-1)!.info).toMatchObject({
        role: "assistant",
        modelId: "glm-4-air",
        providerId: "glm",
      });
      expect(JSON.stringify(committedBundle!.entries)).not.toContain(HIGHSPEED_PROVIDER_IDS.zai);
    }
  });

  it("fork-of-fork 只从 child-local anchor 构造 canonical target，不泄漏 parent id", () => {
    const user = userMessage("msg_parent_user" as MessageId, "fork twice", 1);
    const assistant = assistantMessage(
      "msg_parent_assistant" as MessageId,
      user.info.id,
      "stable answer",
      2,
    );
    const parentOrderedIds = [user.info.id, assistant.info.id];
    user.info.anchor = {
      turnId: "turn_parent" as never,
      productTurnId: "product_parent",
      orderedMessageIds: parentOrderedIds,
      boundaryMessageId: assistant.info.id,
    };
    assistant.info.anchor = { ...user.info.anchor };
    const firstChildId = "sess_first_child" as SessionId;
    const messageIdMap = new Map<MessageId, MessageId>([
      [user.info.id, "msg_child_user" as MessageId],
      [assistant.info.id, "msg_child_assistant" as MessageId],
    ]);
    const turnIdMap = new Map([["turn_parent", "turn_child"]]);
    const productTurnIdMap = new Map([["product_parent", "product_child"]]);
    const cloned = [user, assistant].map((message) => ({
      info: cloneMessageForFork(message.info, {
        forkedSessionId: firstChildId,
        messageIdMap,
        nextMessageId: messageIdMap.get(message.info.id)!,
        turnIdMap,
        productTurnIdMap,
        strictLocalReferences: true,
      } as never),
      parts: [],
    }));
    const childAnchor = cloned[1]!.info.anchor!;

    expect(childAnchor.orderedMessageIds).toEqual(["msg_child_user", "msg_child_assistant"]);
    expect(childAnchor.boundaryMessageId).toBe("msg_child_assistant");
    expect(childAnchor.turnId).not.toBe("turn_parent");
    expect(childAnchor.productTurnId).not.toBe("product_parent");
    expect(() =>
      stableForkHistoryMessages(cloned, {
        productTurnId: childAnchor.productTurnId!,
        transcriptTurnId: String(childAnchor.turnId),
        orderedMessageIds: childAnchor.orderedMessageIds!.map(String),
        boundaryMessageId: String(childAnchor.boundaryMessageId),
      }),
    ).not.toThrow();
  });

  it("keeps the signature repair marker when an assistant is copied into a fork", () => {
    const user = userMessage("msg_parent_user" as MessageId, "repair", 1);
    const assistant = assistantMessage(
      "msg_parent_assistant" as MessageId,
      user.info.id,
      "after repair",
      2,
    );
    assistant.info.metadata = { signedReasoningReset: true };

    const cloned = cloneMessageForFork(assistant.info, {
      forkedSessionId: "sess_repair_child" as SessionId,
      messageIdMap: new Map<MessageId, MessageId>([
        [user.info.id, "msg_child_user" as MessageId],
        [assistant.info.id, "msg_child_assistant" as MessageId],
      ]),
      nextMessageId: "msg_child_assistant" as MessageId,
    });

    // child 的投影要和父会话一样去掉修复前的签名 thinking，否则 fork 后第一个请求又会被拒。
    expect(cloned.metadata).toMatchObject({ signedReasoningReset: true });
  });

  it("remaps compact leading announcement ids and drops ids outside the child transcript", () => {
    const summaryId = "msg_leading_summary" as MessageId;
    const leadingId = "msg_leading_announcement" as MessageId;
    const cloned = clonePartForFork(
      {
        id: partId("leading_compaction"),
        sessionID: SESSION_ID,
        messageID: summaryId,
        type: "compaction",
        auto: false,
        metadata: {
          compactLeadingMessageIds: [leadingId, "msg_parent_only" as MessageId],
        },
      } as MessagePart,
      {
        forkedSessionId: "ses_leading_child" as never,
        nextMessageId: "msg_child_summary" as MessageId,
        messageIdMap: new Map<MessageId, MessageId>([
          [summaryId, "msg_child_summary" as MessageId],
          [leadingId, "msg_child_announcement" as MessageId],
        ]),
        strictLocalReferences: true,
      },
    );
    // 旧版本 fork 原样复制 metadata；映射不到的声明只影响公告位置，不能阻断 fork。
    expect(cloned).toMatchObject({
      metadata: { compactLeadingMessageIds: ["msg_child_announcement"] },
    });
  });

  it("stable fork golden remap 覆盖 message/part/turn/compact/goal/verifier 全部 child-local identity", async () => {
    const user = userMessage("msg_golden_user" as MessageId, "golden", 1);
    const assistant = assistantMessage(
      "msg_golden_assistant" as MessageId,
      user.info.id,
      "golden answer",
      2,
    );
    const goal: SessionGoal = {
      sessionID: SESSION_ID,
      targetID: "target_golden_parent",
      objective: "golden goal",
      summaryTitle: null,
      status: "active",
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 1,
      activeInputId: "parent-active-input",
      activeRunStartedAtMs: 10,
      activeRunLastSeenAtMs: 11,
      time: { created: 1, updated: 2 },
    };
    const anchor = {
      turnId: "turn_golden_parent" as never,
      productTurnId: "product_golden_parent",
      orderedMessageIds: [user.info.id, assistant.info.id],
      boundaryMessageId: assistant.info.id,
      goalBoundary: {
        kind: "snapshot" as const,
        target: goal,
        verificationEntryIds: ["entry_golden_parent"],
      },
    };
    user.info.anchor = anchor;
    assistant.info.anchor = anchor;
    assistant.parts.push(
      {
        id: partId("golden_compaction"),
        sessionID: SESSION_ID,
        messageID: assistant.info.id,
        type: "compaction",
        auto: false,
        tail_start_id: user.info.id,
        summaryMessageId: assistant.info.id,
        compactBoundary: {
          boundaryId: "compact-golden",
          trigger: "manual",
          preCompactTokenCount: 10,
          summarizedMessageCount: 2,
          lastSummarizedMessageId: assistant.info.id,
          preservedSegment: {
            headMessageId: user.info.id,
            anchorMessageId: assistant.info.id,
            tailMessageId: assistant.info.id,
          },
          summaryMessageIds: [assistant.info.id],
          traceId: "trace-golden" as never,
          turnId: "turn_golden_parent" as never,
        },
      } as MessagePart,
      {
        id: partId("golden_compact_timeline"),
        sessionID: SESSION_ID,
        messageID: assistant.info.id,
        type: "timeline",
        timelineType: "context_compaction",
        display: "separator",
        status: "completed",
        operationId: "compact-golden",
        trigger: "manual",
        anchorMessageId: assistant.info.id,
        anchorTurnId: "turn_golden_parent" as never,
        summaryMessageId: assistant.info.id,
      } as MessagePart,
      {
        id: partId("golden_goal_timeline"),
        sessionID: SESSION_ID,
        messageID: assistant.info.id,
        type: "timeline",
        timelineType: "goal_verification",
        display: "separator",
        status: "completed",
        targetId: goal.targetID,
        verificationId: "verification_golden_parent",
        anchorMessageId: assistant.info.id,
        anchorTurnId: "turn_golden_parent" as never,
      } as MessagePart,
      {
        id: partId("golden_tool"),
        sessionID: SESSION_ID,
        messageID: assistant.info.id,
        type: "tool",
        callID: "tool_call_golden_parent",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
          attachments: [
            {
              id: partId("golden_tool_attachment"),
              sessionID: SESSION_ID,
              messageID: assistant.info.id,
              type: "file",
              mime: "text/plain",
              url: "data:text/plain,ok",
            },
          ],
        },
      } as MessagePart,
    );
    const verificationEntry = goalVerificationEntry(
      "entry_golden_parent",
      String(assistant.info.id),
      1,
      false,
    );
    const verificationData = verificationEntry.data as {
      payload: Record<string, unknown>;
    };
    verificationData.payload.targetId = goal.targetID;
    verificationData.payload.verificationId = "verification_golden_parent";
    verificationData.payload.anchorTurnId = "turn_golden_parent";
    const childSessionId = "sess_golden_child" as SessionId;
    let bundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null = null;
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      projectID: "project-golden",
      slug: "parent-golden",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    const runtime = {
      appendEvent: async () => undefined,
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: () => ({ type: "session.forked" }),
      getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
      rootTraceContext: { traceId: "trace-golden" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle(value) {
          bundle = value;
          return value.child as SessionInfo;
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [user, assistant];
        },
        async sessionEntries() {
          return [verificationEntry];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    await forkStableConversationAtMessage.call(runtime as never, {
      forkedSessionId: childSessionId,
      goalBoundary: anchor.goalBoundary,
      sourceCommandId: "cmd-golden",
      target: {
        productTurnId: anchor.productTurnId,
        transcriptTurnId: String(anchor.turnId),
        orderedMessageIds: anchor.orderedMessageIds.map(String),
        boundaryMessageId: String(anchor.boundaryMessageId),
      },
    });

    const copiedUser = bundle!.messages[0]!;
    const copiedAssistant = bundle!.messages[1]!;
    const copiedAnchor = copiedAssistant.info.anchor!;
    const copiedCompaction = copiedAssistant.parts.find((part) => part.type === "compaction");
    const copiedCompactTimeline = copiedAssistant.parts.find(
      (part) => part.type === "timeline" && part.timelineType === "context_compaction",
    );
    const copiedGoalTimeline = copiedAssistant.parts.find(
      (part) => part.type === "timeline" && part.timelineType === "goal_verification",
    );
    const copiedTool = copiedAssistant.parts.find((part) => part.type === "tool");
    const copiedEntry = bundle!.entries[0]!;
    const copiedEntryPayload = (copiedEntry.data as { payload: Record<string, unknown> }).payload;

    expect(copiedUser.info.sessionID).toBe(childSessionId);
    expect(copiedAssistant.info.sessionID).toBe(childSessionId);
    expect(copiedAssistant.info.role).toBe("assistant");
    if (copiedAssistant.info.role !== "assistant") return;
    expect(copiedAssistant.info.parentID).toBe(copiedUser.info.id);
    expect(copiedAnchor.orderedMessageIds).toEqual([copiedUser.info.id, copiedAssistant.info.id]);
    expect(copiedAnchor.boundaryMessageId).toBe(copiedAssistant.info.id);
    expect(copiedAnchor.turnId).not.toBe(anchor.turnId);
    expect(copiedAnchor.productTurnId).not.toBe(anchor.productTurnId);
    expect(copiedCompaction).toMatchObject({
      sessionID: childSessionId,
      messageID: copiedAssistant.info.id,
      tail_start_id: copiedUser.info.id,
      summaryMessageId: copiedAssistant.info.id,
      compactBoundary: {
        lastSummarizedMessageId: copiedAssistant.info.id,
        preservedSegment: {
          headMessageId: copiedUser.info.id,
          anchorMessageId: copiedAssistant.info.id,
          tailMessageId: copiedAssistant.info.id,
        },
        summaryMessageIds: [copiedAssistant.info.id],
        turnId: copiedAnchor.turnId,
      },
    });
    expect(copiedCompactTimeline).toMatchObject({
      anchorMessageId: copiedAssistant.info.id,
      anchorTurnId: copiedAnchor.turnId,
      summaryMessageId: copiedAssistant.info.id,
    });
    expect(bundle!.goal?.source).toMatchObject({
      sessionID: childSessionId,
      activeInputId: null,
      activeRunStartedAtMs: null,
      activeRunLastSeenAtMs: null,
    });
    expect(bundle!.goal?.source.targetID).not.toBe(goal.targetID);
    expect(copiedEntry.id).not.toBe(verificationEntry.id);
    expect(copiedEntry.sessionID).toBe(childSessionId);
    expect(copiedEntryPayload).toMatchObject({
      targetId: bundle!.goal?.source.targetID,
      anchorAssistantMessageId: copiedAssistant.info.id,
      anchorTurnId: copiedAnchor.turnId,
    });
    expect(copiedEntryPayload.verificationId).not.toBe("verification_golden_parent");
    expect(copiedGoalTimeline).toMatchObject({
      targetId: bundle!.goal?.source.targetID,
      verificationId: copiedEntryPayload.verificationId,
      anchorMessageId: copiedAssistant.info.id,
      anchorTurnId: copiedAnchor.turnId,
    });
    expect(copiedTool).toMatchObject({
      sessionID: childSessionId,
      messageID: copiedAssistant.info.id,
      state: {
        attachments: [
          {
            sessionID: childSessionId,
            messageID: copiedAssistant.info.id,
          },
        ],
      },
    });
    if (copiedTool?.type === "tool") {
      expect(copiedTool.callID).not.toBe("tool_call_golden_parent");
      if (copiedTool.state.status === "completed") {
        expect(copiedTool.state.attachments?.[0]?.id).not.toBe(partId("golden_tool_attachment"));
      }
    }
    expect(copiedAnchor.goalBoundary).toMatchObject({
      kind: "snapshot",
      target: {
        sessionID: childSessionId,
        targetID: bundle!.goal?.source.targetID,
      },
      verificationEntryIds: [copiedEntry.id],
    });
  });

  it("fork child title uses generated source", async () => {
    const createdSessions: unknown[] = [];
    const runtime = {
      rootTraceContext: { traceId: "trace_fork_title" },
      sessionId: SESSION_ID,
      sessionStore: {
        createSession: async (input: unknown) => {
          createdSessions.push(input);
        },
      },
    };
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project_fork_title",
      slug: "parent-title",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "执行下 pwd",
      version: "test",
    } as SessionInfo;

    await createForkedSession(runtime as never, {
      forkedSessionId: "sess_child_title" as SessionId,
      parentSession,
    });

    expect(createdSessions[0]).toMatchObject({
      id: "sess_child_title",
      title: "Fork of 执行下 pwd",
      titleSource: "generated",
    });
  });

  it("stable fork child 与 sourceCommandId/target metadata 通过原子 store 能力一起创建", async () => {
    const atomicCreates: Array<{
      input: { id: SessionId };
      metadata: StableConversationForkChildMetadata;
    }> = [];
    let legacyCreateCount = 0;
    const target: StableConversationForkTarget = {
      productTurnId: "product-1",
      transcriptTurnId: "runtime-1",
      orderedMessageIds: ["msg-user", "msg-final"],
      boundaryMessageId: "msg-final",
    };
    const runtime = {
      rootTraceContext: { traceId: "trace_atomic_fork" },
      sessionId: SESSION_ID,
      sessionStore: {
        async createSession() {
          legacyCreateCount += 1;
        },
        async createForkedSessionWithMetadata(
          input: { id: SessionId },
          metadata: StableConversationForkChildMetadata,
        ) {
          atomicCreates.push({ input, metadata });
          // 原子 store 发现同 command fact 时会返回第一次创建的 child。
          return { id: "sess_existing_child" as SessionId };
        },
      },
    };
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project_atomic_fork",
      slug: "parent",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "Parent",
      version: "test",
    } as SessionInfo;

    const forkedSessionId = await createForkedSession(runtime as never, {
      forkedSessionId: "sess_requested_child" as SessionId,
      parentSession,
      stableForkMetadata: {
        forkTarget: target,
        parentSessionId: SESSION_ID,
        sourceCommandId: "command-fork-1",
      },
    });

    expect(forkedSessionId).toBe("sess_existing_child");
    expect(legacyCreateCount).toBe(0);
    expect(atomicCreates).toEqual([
      {
        input: expect.objectContaining({
          id: "sess_requested_child",
          parentID: SESSION_ID,
        }),
        metadata: {
          forkTarget: target,
          parentSessionId: SESSION_ID,
          sourceCommandId: "command-fork-1",
        },
      },
    ]);
  });

  it("stable fork store 缺少原子 metadata 能力时在 child 创建前失败", async () => {
    let legacyCreateCount = 0;
    const runtime = {
      rootTraceContext: { traceId: "trace_atomic_required" },
      sessionId: SESSION_ID,
      sessionStore: {
        async createSession() {
          legacyCreateCount += 1;
        },
      },
    };
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      projectID: "project_atomic_required",
      slug: "parent",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "Parent",
      version: "test",
    } as SessionInfo;

    await expect(
      createForkedSession(runtime as never, {
        parentSession,
        stableForkMetadata: {
          forkTarget: {
            productTurnId: "product-1",
            transcriptTurnId: "runtime-1",
            orderedMessageIds: ["msg-final"],
            boundaryMessageId: "msg-final",
          },
          parentSessionId: SESSION_ID,
          sourceCommandId: "command-fork-1",
        },
      }),
    ).rejects.toThrow(/atomic child metadata persistence/);
    expect(legacyCreateCount).toBe(0);
  });

  it("stable fork 保留历史前缀并严格复制 resolver target segment，不向 boundary 后扩张", () => {
    const firstUser = userMessage("msg_user_1" as MessageId, "第一轮", 1);
    const firstAssistant = assistantMessage(
      "msg_assistant_1" as MessageId,
      firstUser.info.id,
      "第一轮回复",
      2,
    );
    const targetUser = userMessage("msg_user_2" as MessageId, "目标轮", 3);
    const earlyAssistant = assistantMessage(
      "msg_assistant_2a" as MessageId,
      targetUser.info.id,
      "工具前",
      4,
    );
    const finalAssistant = assistantMessage(
      "msg_assistant_2b" as MessageId,
      targetUser.info.id,
      "最终回复",
      5,
    );
    const sameParentButNotResolved = assistantMessage(
      "msg_assistant_unresolved" as MessageId,
      targetUser.info.id,
      "不得自动扩张",
      6,
    );
    const activeMessages = [
      firstUser,
      firstAssistant,
      targetUser,
      earlyAssistant,
      finalAssistant,
      sameParentButNotResolved,
    ];

    const selected = stableForkHistoryMessages(activeMessages, {
      productTurnId: "product-2",
      transcriptTurnId: "runtime-2",
      orderedMessageIds: ["msg_user_2", "msg_assistant_2a", "msg_assistant_2b"],
      boundaryMessageId: "msg_assistant_2b",
    });

    expect(selected.map((message) => message.info.id)).toEqual([
      "msg_user_1",
      "msg_assistant_1",
      "msg_user_2",
      "msg_assistant_2a",
      "msg_assistant_2b",
    ]);
  });

  it("stable fork 对缺失、乱序、重复或非 assistant boundary 明确拒绝", () => {
    const user = userMessage("msg_user" as MessageId, "目标轮", 1);
    const assistant = assistantMessage("msg_assistant" as MessageId, user.info.id, "回复", 2);
    const base = {
      productTurnId: "product-1",
      transcriptTurnId: "runtime-1",
    };

    expect(() =>
      stableForkHistoryMessages([user, assistant], {
        ...base,
        orderedMessageIds: ["msg_missing"],
        boundaryMessageId: "msg_missing",
      }),
    ).toThrow(/active transcript segment/);
    expect(() =>
      stableForkHistoryMessages([user, assistant], {
        ...base,
        orderedMessageIds: ["msg_assistant", "msg_user"],
        boundaryMessageId: "msg_user",
      }),
    ).toThrow(/contiguous active transcript segment/);
    expect(() =>
      stableForkHistoryMessages([user, assistant], {
        ...base,
        orderedMessageIds: ["msg_assistant", "msg_assistant"],
        boundaryMessageId: "msg_assistant",
      }),
    ).toThrow(/duplicate message ids/);
    expect(() =>
      stableForkHistoryMessages([user], {
        ...base,
        orderedMessageIds: ["msg_user"],
        boundaryMessageId: "msg_user",
      }),
    ).toThrow(/completed assistant message/);
  });

  it("compact-covered edit fork selects only the active prefix before target input, including root", () => {
    const firstUser = userMessage("msg_user_1" as MessageId, "first", 1);
    const firstAssistant = assistantMessage(
      "msg_assistant_1" as MessageId,
      firstUser.info.id,
      "answer",
      2,
    );
    const editedInput = userMessage("msg_user_2" as MessageId, "edit me", 3);
    const oldAnswer = assistantMessage(
      "msg_assistant_2" as MessageId,
      editedInput.info.id,
      "old answer",
      4,
    );

    expect(
      conversationHistoryBeforeInput(
        [firstUser, firstAssistant, editedInput, oldAnswer],
        editedInput.info.id,
      ).map((message) => message.info.id),
    ).toEqual([firstUser.info.id, firstAssistant.info.id]);
    expect(conversationHistoryBeforeInput([firstUser, firstAssistant], firstUser.info.id)).toEqual(
      [],
    );
    expect(() =>
      conversationHistoryBeforeInput([firstUser, firstAssistant], "missing" as MessageId),
    ).toThrow(/not found/);
  });

  it("bundle commit 是 point-of-no-return：parent fork event 失败不反转 accepted child", async () => {
    const target = userMessage("msg_first_user" as MessageId, "edit me", 1);
    const childSessionId = "sess_committed_child" as SessionId;
    let committedBundle: Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0] | null =
      null;
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project-committed-child",
      slug: "parent-committed-child",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    const runtime = {
      appendEvent: async () => {
        throw new Error("parent event store unavailable");
      },
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: () => ({ type: "session.forked" }),
      getSessionModelSelection: () => ({
        modelId: "glm-4-air",
        providerId: "glm",
      }),
      logger: { warn: () => undefined },
      rootTraceContext: { traceId: "trace_committed_child" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle(bundle) {
          committedBundle = bundle;
          return bundle.child as SessionInfo;
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [target];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    await expect(
      forkConversationBeforeMessage.call(runtime as never, {
        commandFact: {
          parentSessionId: SESSION_ID,
          sourceCommandId: "cmd-committed-child",
          ack: {
            commandId: "cmd-committed-child",
            status: "accepted",
            revisionAtDecision: 1,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: childSessionId,
            },
          },
          metadata: {},
        },
        forkedSessionId: childSessionId,
        goalBoundary: { kind: "none" },
        initialInput: {
          id: "queue_cmd-committed-child",
          sessionID: childSessionId,
          kind: "sendText",
          delivery: "startNow",
          payload: { text: "edited" },
        },
        sourceCommandId: "cmd-committed-child",
        targetMessageId: target.info.id,
        targetProductTurnId: "turn-product",
        targetTranscriptTurnId: "turn-runtime",
      }),
    ).resolves.toMatchObject({ forkedSessionId: childSessionId });

    const notice = committedBundle!.messages.find((message) => message.info.role === "assistant");
    expect(notice?.info.role).toBe("assistant");
    if (notice?.info.role !== "assistant") return;
    expect(notice.info.parentID).not.toBe(notice.info.id);
    expect(
      committedBundle!.messages.some((message) => message.info.id === notice.info.parentID),
    ).toBe(true);
  });

  it("duplicate bundle 后 core 全程使用 store 返回的 existing child id", async () => {
    const target = userMessage("msg_duplicate_user" as MessageId, "edit me", 1);
    const requestedChildId = "sess_requested_duplicate" as SessionId;
    const existingChildId = "sess_existing_duplicate" as SessionId;
    const eventPayloads: Array<Record<string, unknown>> = [];
    const parentSession = {
      directory: "/workspace",
      id: SESSION_ID,
      path: "/workspace",
      projectID: "project-duplicate-child",
      slug: "parent-duplicate-child",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
      title: "parent",
      version: "test",
    } as SessionInfo;
    const runtime = {
      appendEvent: async () => undefined,
      config: { agentName: "zcode-agent", mode: "build" },
      createEvent: (_type: unknown, payload: Record<string, unknown>) => {
        eventPayloads.push(payload);
        return { payload };
      },
      getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
      rootTraceContext: { traceId: "trace_duplicate_child" },
      sessionId: SESSION_ID,
      sessionStore: {
        async commitForkBundle() {
          return { ...parentSession, id: existingChildId, parentID: SESSION_ID };
        },
        async getSession() {
          return parentSession;
        },
        async messages() {
          return [target];
        },
      } satisfies Partial<SessionStorePort>,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    };

    const result = await forkConversationBeforeMessage.call(runtime as never, {
      commandFact: {
        parentSessionId: SESSION_ID,
        sourceCommandId: "cmd-duplicate-child",
        ack: {
          commandId: "cmd-duplicate-child",
          status: "accepted",
          revisionAtDecision: 1,
          result: {
            type: "editUserQuery",
            disposition: "fork",
            sessionId: requestedChildId,
          },
        },
        metadata: {},
      },
      forkedSessionId: requestedChildId,
      goalBoundary: { kind: "none" },
      initialInput: {
        id: "queue_cmd-duplicate-child",
        sessionID: requestedChildId,
        kind: "sendText",
        delivery: "startNow",
        payload: { text: "edited" },
      },
      sourceCommandId: "cmd-duplicate-child",
      targetMessageId: target.info.id,
      targetProductTurnId: "turn-product",
      targetTranscriptTurnId: "turn-runtime",
    });

    expect(result.forkedSessionId).toBe(existingChildId);
    expect(eventPayloads).toContainEqual(
      expect.objectContaining({ forkedSessionId: existingChildId }),
    );
  });

  it("fork transcript 不按 compact boundary 截掉可见 tool/worklog 历史", () => {
    const user = userMessage("msg_user" as MessageId, "真实用户输入", 1);
    const toolAssistant = assistantMessage(
      "msg_tool_assistant" as MessageId,
      user.info.id,
      "我先读取文件。",
      2,
    );
    toolAssistant.parts.push({
      id: partId("tool_read"),
      sessionID: SESSION_ID,
      messageID: toolAssistant.info.id,
      type: "tool",
      callID: "toolu_read",
      tool: "Read",
      state: {
        status: "completed",
        input: { file_path: "/tmp/demo.txt" },
        output: "demo",
        title: "Read",
      },
    } as MessagePart);
    const compact = compactSummaryMessage("msg_compact" as MessageId, 3);
    const finalAssistant = assistantMessage("msg_final" as MessageId, user.info.id, "最终回复", 4);
    const parentMessages = [user, toolAssistant, compact, finalAssistant];

    expect(activeSessionMessages(parentMessages).map((message) => message.info.id)).toEqual([
      compact.info.id,
      finalAssistant.info.id,
    ]);

    const forkSourceMessages = activeForkTranscriptMessages(parentMessages);
    const targetIndex = forkSourceMessages.findIndex(
      (message) => message.info.id === finalAssistant.info.id,
    );
    const forkHistoryMessages = buildForkHistoryMessages(
      parentMessages,
      forkSourceMessages,
      targetIndex,
      targetIndex + 1,
    );

    expect(forkHistoryMessages.map((message) => message.info.id)).toEqual([
      user.info.id,
      toolAssistant.info.id,
      compact.info.id,
      finalAssistant.info.id,
    ]);
    expect(
      forkHistoryMessages
        .flatMap((message) => message.parts)
        .some((part) => part.type === "tool" && part.tool === "Read"),
    ).toBe(true);
  });

  it("fork transcript 保留 rewind active branch 但不按 compact 截断", () => {
    const firstUser = userMessage("msg_first_user" as MessageId, "第一轮", 1);
    const rewoundUser = userMessage("msg_rewound_user" as MessageId, "被编辑的旧轮次", 2);
    const rewoundAssistant = assistantMessage(
      "msg_rewound_assistant" as MessageId,
      rewoundUser.info.id,
      "旧回复",
      3,
    );
    const editedUser = userMessage("msg_edited_user" as MessageId, "编辑后的新轮次", 4);
    const editedCompact = compactSummaryMessage("msg_edited_compact" as MessageId, 5);
    const editedAssistant = assistantMessage(
      "msg_edited_assistant" as MessageId,
      editedUser.info.id,
      "新回复",
      6,
    );

    const forkSourceMessages = activeForkTranscriptMessages(
      [firstUser, rewoundUser, rewoundAssistant, editedUser, editedCompact, editedAssistant],
      {
        rewindCreatedMessageId: editedUser.info.id,
        rewindKeptMessageIds: [firstUser.info.id],
        rewindTargetMessageId: rewoundUser.info.id,
      },
    );

    expect(forkSourceMessages.map((message) => message.info.id)).toEqual([
      firstUser.info.id,
      editedUser.info.id,
      editedCompact.info.id,
      editedAssistant.info.id,
    ]);
  });

  it("fork goal state 只复制 child 历史里的 verifier 并 remap anchor", async () => {
    const forkedSessionId = "sess_child" as SessionId;
    const parentTarget: SessionGoal = {
      activeInputId: "input_parent",
      activeRunLastSeenAtMs: 950,
      activeRunStartedAtMs: 900,
      objective: "完成四个 checkpoint",
      sessionID: SESSION_ID,
      status: "complete",
      summaryTitle: "checkpoint goal",
      targetID: "target_goal_1",
      time: { created: 1, updated: 100 },
      timeUsedSeconds: 12,
      tokenBudget: 1000,
      tokensUsed: 120,
    };
    const parentEntries = [
      goalVerificationEntry("entry_1", "msg_checkpoint_1", 1, false),
      goalVerificationEntry("entry_2", "msg_checkpoint_2", 2, false),
      goalVerificationEntry("entry_3", "msg_checkpoint_3", 3, false),
    ];
    const savedEntries: SessionEntryInfo[] = [];
    let clonedTarget: SessionGoal | null = null;
    const store = {
      async readTarget(input: { sessionID: SessionId }) {
        return input.sessionID === SESSION_ID ? parentTarget : clonedTarget;
      },
      async sessionEntries() {
        return parentEntries;
      },
      async saveSessionEntry(input: SessionEntryInfo) {
        savedEntries.push(input);
      },
      async cloneTargetForFork(input: {
        sessionID: SessionId;
        source: SessionGoal;
        status?: SessionGoal["status"];
      }) {
        clonedTarget = {
          ...input.source,
          activeInputId: null,
          activeRunLastSeenAtMs: null,
          activeRunStartedAtMs: null,
          sessionID: input.sessionID,
          status: input.status ?? input.source.status,
        };
        return clonedTarget;
      },
    } as unknown as SessionStorePort;

    await copyGoalStateForFork.call(
      {
        logger: undefined,
        sessionId: SESSION_ID,
        sessionStore: store,
      } as never,
      {
        forkedSessionId,
        messageIdMap: new Map<MessageId, MessageId>([
          ["msg_checkpoint_1" as MessageId, "msg_child_checkpoint_1" as MessageId],
          ["msg_checkpoint_2" as MessageId, "msg_child_checkpoint_2" as MessageId],
        ]),
        traceContext: {} as TraceContext,
      },
    );

    expect(clonedTarget).toMatchObject({
      activeInputId: null,
      activeRunLastSeenAtMs: null,
      activeRunStartedAtMs: null,
      sessionID: forkedSessionId,
      status: "active",
      targetID: parentTarget.targetID,
    });
    expect(savedEntries.map((entry) => entry.sessionID)).toEqual([
      forkedSessionId,
      forkedSessionId,
    ]);
    expect(
      savedEntries.map(
        (entry) =>
          (entry.data as { payload: { anchorAssistantMessageId: string } }).payload
            .anchorAssistantMessageId,
      ),
    ).toEqual(["msg_child_checkpoint_1", "msg_child_checkpoint_2"]);
  });

  it("stable fork 只使用 resolver 给出的 goal 快照与 verifier entry 边界", async () => {
    const forkedSessionId = "sess_stable_goal_child" as SessionId;
    const currentParentTarget: SessionGoal = {
      activeInputId: "input_new",
      activeRunLastSeenAtMs: 200,
      activeRunStartedAtMs: 190,
      objective: "fork 点之后的新目标",
      sessionID: SESSION_ID,
      status: "active",
      targetID: "target_new",
      time: { created: 180, updated: 200 },
      timeUsedSeconds: 1,
      tokensUsed: 1,
    };
    const forkPointTarget: SessionGoal = {
      activeInputId: null,
      activeRunLastSeenAtMs: null,
      activeRunStartedAtMs: null,
      objective: "fork 点目标快照",
      sessionID: SESSION_ID,
      status: "complete",
      targetID: "target_at_fork",
      time: { created: 1, updated: 80 },
      timeUsedSeconds: 8,
      tokensUsed: 80,
    };
    const entries = [
      goalVerificationEntry("entry_before", "msg_checkpoint_1", 1, true),
      goalVerificationEntry("entry_after", "msg_checkpoint_2", 2, false),
    ];
    // helper 默认 target_goal_1；fork 点快照测试需要两个 entry 都属于显式 target。
    for (const entry of entries) {
      const data = entry.data as { payload: Record<string, unknown> };
      data.payload.targetId = "target_at_fork";
    }
    const savedEntries: SessionEntryInfo[] = [];
    let clonedTarget: SessionGoal | null = null;
    const store = {
      async readTarget() {
        return currentParentTarget;
      },
      async sessionEntries() {
        return entries;
      },
      async saveSessionEntry(input: SessionEntryInfo) {
        savedEntries.push(input);
      },
      async cloneTargetForFork(input: {
        sessionID: SessionId;
        source: SessionGoal;
        status?: SessionGoal["status"];
      }) {
        clonedTarget = {
          ...input.source,
          sessionID: input.sessionID,
          status: input.status ?? input.source.status,
        };
        return clonedTarget;
      },
    } as unknown as SessionStorePort;

    await copyGoalStateForFork.call(
      {
        logger: undefined,
        sessionId: SESSION_ID,
        sessionStore: store,
      } as never,
      {
        forkedSessionId,
        goalBoundary: {
          kind: "snapshot",
          target: forkPointTarget,
          verificationEntryIds: ["entry_before"],
        },
        messageIdMap: new Map<MessageId, MessageId>([
          ["msg_checkpoint_1" as MessageId, "msg_child_checkpoint_1" as MessageId],
        ]),
        traceContext: {} as TraceContext,
      },
    );

    expect(clonedTarget).toMatchObject({
      objective: "fork 点目标快照",
      sessionID: forkedSessionId,
      status: "complete",
      targetID: "target_at_fork",
    });
    expect(savedEntries).toHaveLength(1);
    expect(savedEntries[0]?.id).not.toBe("entry_after");
  });

  it("stable fork goal boundary=none 时不复制 parent 当前 target", async () => {
    let readTargetCount = 0;
    let cloneTargetCount = 0;
    const store = {
      async readTarget() {
        readTargetCount += 1;
        return {};
      },
      async cloneTargetForFork() {
        cloneTargetCount += 1;
      },
    } as unknown as SessionStorePort;

    await copyGoalStateForFork.call(
      {
        logger: undefined,
        sessionId: SESSION_ID,
        sessionStore: store,
      } as never,
      {
        forkedSessionId: "sess_no_goal_child" as SessionId,
        goalBoundary: { kind: "none" },
        messageIdMap: new Map(),
        traceContext: {} as TraceContext,
      },
    );

    expect(readTargetCount).toBe(0);
    expect(cloneTargetCount).toBe(0);
  });

  it("stable fork verifier boundary 引用缺失 entry 时明确失败", async () => {
    const target: SessionGoal = {
      activeInputId: null,
      activeRunLastSeenAtMs: null,
      activeRunStartedAtMs: null,
      objective: "目标",
      sessionID: SESSION_ID,
      status: "active",
      targetID: "target_at_fork",
      time: { created: 1, updated: 1 },
      timeUsedSeconds: 0,
      tokensUsed: 0,
    };
    const store = {
      async sessionEntries() {
        return [];
      },
      async saveSessionEntry() {},
      async cloneTargetForFork() {},
    } as unknown as SessionStorePort;

    await expect(
      copyGoalStateForFork.call(
        {
          logger: undefined,
          sessionId: SESSION_ID,
          sessionStore: store,
        } as never,
        {
          forkedSessionId: "sess_missing_goal_entry" as SessionId,
          goalBoundary: {
            kind: "snapshot",
            target,
            verificationEntryIds: ["missing-entry"],
          },
          messageIdMap: new Map(),
          traceContext: {} as TraceContext,
        },
      ),
    ).rejects.toThrow(/references missing entries/);
  });

  it("fork goal status 只在 copied verifier passed 后保持 complete", () => {
    expect(
      deriveForkedGoalStatusFromCopiedVerifications("complete", [
        {
          goalIteration: 4,
          status: "completed",
          targetId: "target_goal_1",
          verification: { nextAction: null, passed: true, reason: "done" },
          verificationId: "verify_4",
        },
      ]),
    ).toBe("complete");
    expect(
      deriveForkedGoalStatusFromCopiedVerifications("complete", [
        {
          goalIteration: 2,
          status: "completed",
          targetId: "target_goal_1",
          verification: { nextAction: "继续", passed: false, reason: "not yet" },
          verificationId: "verify_2",
        },
      ]),
    ).toBe("active");
  });

  it("补回 compact active branch 中被隐藏的 assistant parent user", () => {
    const user = userMessage("msg_user" as MessageId, "真实用户输入", 1);
    const compact = compactSummaryMessage("msg_compact" as MessageId, 2);
    const assistant = assistantMessage("msg_assistant" as MessageId, user.info.id, "最终回复", 3);
    const parentMessages = [user, compact, assistant];
    const forkSourceMessages = activeSessionMessages(parentMessages);

    expect(forkSourceMessages.map((message) => message.info.id)).toEqual([
      compact.info.id,
      assistant.info.id,
    ]);

    const forkHistoryMessages = buildForkHistoryMessages(parentMessages, forkSourceMessages, 1, 2);

    expect(forkHistoryMessages.map((message) => message.info.id)).toEqual([
      user.info.id,
      compact.info.id,
      assistant.info.id,
    ]);
    expect(activeSessionMessages(forkHistoryMessages).map((message) => message.info.id)).toEqual([
      compact.info.id,
      assistant.info.id,
    ]);
  });
});

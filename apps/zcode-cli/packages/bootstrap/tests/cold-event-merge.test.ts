import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type EventId,
  type MessageWithParts,
  type SessionEvent,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { buildColdFileChangeSummaries } from "../src/zcode-protocol-v4/cold-file-change-summaries.js";
import * as coldEventMerge from "../src/zcode-protocol-v4/cold-event-merge.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

const { loadPersistedConversationMaterialization, mergeColdConversationEvents } = coldEventMerge;

function userMessage(id: string, text: string, created: number, turnId: string): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "user",
      time: { created },
      agent: "default",
      model: { providerID: "p" as never, modelID: "m" as never },
      anchor: { turnId: turnId as never, origin: "realUser" },
    },
    parts: [
      {
        id: `${id}-text` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
      },
    ],
  };
}

function assistantMessage(
  id: string,
  parentId: string,
  text: string,
  created: number,
  turnId: string,
): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: "s1" as never,
      role: "assistant",
      time: { created, completed: created + 1 },
      parentID: parentId as never,
      modelID: "m" as never,
      providerID: "p" as never,
      mode: "default",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      anchor: { turnId: turnId as never },
    },
    parts: [
      {
        id: `${id}-text` as never,
        sessionID: "s1" as never,
        messageID: id as never,
        type: "text",
        text,
      },
    ],
  };
}

function event(
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
  turnId?: string,
): SessionEvent {
  return {
    id: `live-${sequenceNumber}` as EventId,
    sessionId: "s1" as SessionId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type,
    timestamp: new Date(10_000 + sequenceNumber),
    traceId: "trace-live" as TraceId,
    sequenceNumber,
    payload,
  };
}

function reduce(events: readonly SessionEvent[]): ProductProjection {
  const projection = new ProductProjection("s1", "cold-merge");
  for (const item of events) projection.applyEvent(item);
  return projection;
}

const HOOK_LIFECYCLE_EVENT_TYPES_FOR_TEST = new Set<SessionEvent["type"]>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

describe("cold conversation three-source merge", () => {
  it("preserves a Highspeed fallback marker across cold transcript recovery", () => {
    const turnId = "runtime-turn-highspeed-fallback";
    const user = userMessage("u-highspeed-fallback", "accelerated prompt", 1_000, turnId);
    user.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "command-highspeed-fallback",
        queueItemId: "queue-highspeed-fallback",
        clientId: "desktop",
        kind: "sendText",
        text: "accelerated prompt",
        attachments: [],
        delivery: { requested: "startNow", admitted: "startNow" },
        order: { admissionSeq: 1 },
        steer: { state: "notRequested" },
        dispatch: { state: "drained" },
        admittedAt: 1_000,
        highspeed: {
          schemaVersion: 1,
          cardId: "hsc-cold-fallback",
          taskId: "s1",
          provider: "builtin:bigmodel-coding-plan",
          model: "GLM-5.3",
          issuedAt: 900,
          expiresAt: 1_100,
          regularTps: 80,
        },
      },
    };
    const fallback = event(
      1,
      SessionEventType.TurnExecutionModelFallback,
      {
        inputId: "command-highspeed-fallback",
        reason: "highspeed_card_expired",
        fromModelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
        toModelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" },
      },
      turnId,
    );

    const merged = mergeColdConversationEvents({
      memoryEvents: [fallback],
      messages: [
        user,
        assistantMessage("a-highspeed-fallback", user.info.id, "continued", 1_200, turnId),
      ],
      sessionId: "s1",
    });

    expect(merged.events).toContainEqual(
      expect.objectContaining({
        id: fallback.id,
        payload: fallback.payload,
        type: SessionEventType.TurnExecutionModelFallback,
      }),
    );
    const row = reduce(merged.events)
      .getSnapshot()
      .rows.window.find((row) => row.kind === "userInput");
    expect(row).toMatchObject({
      sourceCommandId: "command-highspeed-fallback",
      highspeed: { fallbackAt: fallback.timestamp.getTime() },
    });
    expect(row?.highspeed).not.toHaveProperty("shareExcludedReason");
  });

  it("preserves SendMessage resumed subagent lifecycle that the transcript cannot synthesize", () => {
    const foregroundTurnId = "runtime-turn-foreground-agent";
    const turnId = "runtime-turn-send-message-resume";
    const foreground = assistantMessage(
      "a-foreground",
      "u-foreground",
      "",
      1_100,
      foregroundTurnId,
    );
    foreground.parts = [
      {
        id: "a-foreground-tool" as never,
        sessionID: "s1" as never,
        messageID: "a-foreground" as never,
        type: "tool",
        callID: "call-agent",
        tool: "Agent",
        state: {
          status: "completed",
          input: {
            description: "前台任务",
            prompt: "完成前台任务",
            subagent_type: "general-purpose",
          },
          output: JSON.stringify({
            status: "completed",
            agentId: "agent-resume",
            agentType: "general-purpose",
            childSessionId: "sess-child-resume",
            description: "前台任务",
            content: [{ type: "text", text: "前台完成" }],
          }),
          title: "Agent 前台任务",
          metadata: {},
          time: { start: 1_001, end: 1_100 },
        },
      },
    ];
    const messages = [
      userMessage("u-foreground", "run the foreground agent", 1_000, foregroundTurnId),
      foreground,
      userMessage("u-resume", "resume the stopped agent", 2_000, turnId),
      assistantMessage("a-resume", "u-resume", "resumed", 2_100, turnId),
    ];
    const baseEvents = [
      event(1, SessionEventType.TurnStarted, { messageId: "u-resume" }, turnId),
      event(
        2,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-resume",
          agentType: "general-purpose",
          background: true,
          childSessionId: "sess-child-resume",
          description: "恢复到后台",
          parentToolCallId: "call-send-message",
          resumed: true,
          status: "running",
        },
        turnId,
      ),
      event(3, SessionEventType.TurnComplete, { status: "success" }, turnId),
    ];

    const running = mergeColdConversationEvents({
      memoryEvents: baseEvents,
      messages,
      sessionId: "s1",
    });
    expect(running.events.some((item) => item.type === SessionEventType.SubagentSpawned)).toBe(
      true,
    );
    const runningSnapshot = reduce(running.events).getSnapshot();
    expect(
      runningSnapshot.rows.window.filter(
        (row) => row.kind === "subagent" && row.entityId === "agent-resume",
      ),
    ).toHaveLength(1);
    expect(runningSnapshot.rows.window.find((row) => row.kind === "subagent")).toMatchObject({
      childSessionId: "sess-child-resume",
      parentToolCallId: "call-agent",
      status: "running",
    });
    expect(runningSnapshot).toMatchObject({
      backgroundWorks: [
        expect.objectContaining({
          workId: "agent-resume",
          childSessionId: "sess-child-resume",
          status: "running",
        }),
      ],
      subagents: {
        running: [expect.objectContaining({ childSessionId: "sess-child-resume" })],
      },
    });

    const terminal = mergeColdConversationEvents({
      memoryEvents: [
        ...baseEvents,
        event(4, SessionEventType.BackgroundTaskCompleted, {
          taskId: "agent-resume",
          toolName: "Agent",
          taskKind: "subagent",
          childSessionId: "sess-child-resume",
          status: "cancelled",
          cancellable: false,
        }),
        event(5, SessionEventType.SubagentStopped, {
          agentId: "agent-resume",
          agentType: "general-purpose",
          background: true,
          childSessionId: "sess-child-resume",
          parentToolCallId: "call-send-message",
          status: "cancelled",
        }),
      ],
      messages,
      sessionId: "s1",
    });
    const terminalSnapshot = reduce(terminal.events).getSnapshot();
    expect(terminalSnapshot.backgroundWorks[0]).toMatchObject({
      workId: "agent-resume",
      status: "cancelled",
    });
    expect(terminalSnapshot.subagents).toMatchObject({ running: [], endedTotal: 1 });
  });

  it("rebuilds every ModelComplete file change from durable workspace checkpoint artifacts", async () => {
    const messages = [
      userMessage("u-file", "write the fixture", 1_000, "runtime-turn-file"),
      assistantMessage("a-file", "u-file", "done", 1_100, "runtime-turn-file"),
    ];
    const checkpoints = [
      event(
        1,
        SessionEventType.CheckpointCreated,
        {
          checkpointId: "checkpoint-new-file",
          messageId: "u-file",
          targetMessageId: "u-file",
          scope: "workspace",
          snapshotRef: "artifact://checkpoint-new-file",
        },
        "runtime-turn-file",
      ),
      event(
        2,
        SessionEventType.CheckpointCreated,
        {
          checkpointId: "checkpoint-edited-file",
          messageId: "u-file",
          targetMessageId: "u-file",
          scope: "workspace",
          snapshotRef: "artifact://checkpoint-edited-file",
        },
        "runtime-turn-file",
      ),
    ];
    const artifactsByRef = new Map([
      [
        "artifact://checkpoint-new-file",
        {
          version: 1,
          kind: "workspace_file_before_change",
          createdAt: "2026-07-16T00:00:00.000Z",
          toolCallId: "tool-write-new-file",
          toolName: "Write",
          files: [
            {
              path: "/work/summary.txt",
              existedBefore: false,
              beforeContent: null,
              afterContent: "line-1\nline-2\n",
              afterContentLength: 14,
              structuredPatch: [],
            },
          ],
        },
      ],
      [
        "artifact://checkpoint-edited-file",
        {
          version: 1,
          kind: "workspace_file_before_change",
          createdAt: "2026-07-16T00:00:01.000Z",
          toolCallId: "tool-edit-existing-file",
          toolName: "Edit",
          files: [
            {
              path: "/work/existing.txt",
              existedBefore: true,
              beforeContent: "old line\n",
              afterContent: "new line\n",
              afterContentLength: 9,
              structuredPatch: [],
            },
          ],
        },
      ],
    ]);
    const readArtifact = vi.fn(async (snapshotRef: string) => {
      const artifact = artifactsByRef.get(snapshotRef);
      if (!artifact) throw new Error(`missing fixture: ${snapshotRef}`);
      return JSON.stringify(artifact);
    });

    const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
      events: checkpoints,
      messageIds: messages.map((message) => String(message.info.id)),
      readArtifact,
    });
    const merged = mergeColdConversationEvents({
      fileChangeSummariesByMessageId,
      memoryEvents: checkpoints,
      messages,
      sessionId: "s1",
    });
    const modelComplete = merged.events.find(
      (item) => item.type === SessionEventType.ModelComplete,
    );
    const header = reduce(merged.events)
      .getSnapshot()
      .rows.window.find((row) => row.kind === "turnHeader");

    expect(readArtifact.mock.calls.map(([snapshotRef]) => snapshotRef)).toEqual([
      "artifact://checkpoint-new-file",
      "artifact://checkpoint-edited-file",
    ]);
    expect((modelComplete?.payload as { fileChanges?: unknown }).fileChanges).toEqual({
      additions: 3,
      deletions: 1,
      files: 2,
      items: [
        {
          path: "/work/existing.txt",
          additions: 1,
          deletions: 1,
          writeCount: 1,
          toolNames: ["Edit"],
        },
        {
          path: "/work/summary.txt",
          additions: 2,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
        },
      ],
    });
    expect(header).toMatchObject({
      fileChanges: { additions: 3, deletions: 1, files: 2, state: "active" },
    });
  });

  it("omits target authority when no persisted store read was performed", async () => {
    const memoryGoal = {
      sessionID: "s1",
      targetID: "target-memory",
      objective: "keep memory authority",
      summaryTitle: null,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      time: { created: 1, updated: 2 },
    };
    const memoryEvents = [
      event(1, SessionEventType.TargetChanged, {
        action: "set",
        source: "runtime",
        target: memoryGoal,
      }),
    ];
    const source = await loadPersistedConversationMaterialization({
      memoryEvents,
      sessionId: "s1",
    });

    expect(Object.prototype.hasOwnProperty.call(source, "target")).toBe(false);
    const merged = mergeColdConversationEvents({
      goalVerificationEntries: source.goalVerificationEntries,
      memoryEvents: source.memoryEvents,
      messages: source.messages,
      sessionId: "s1",
      ...(Object.prototype.hasOwnProperty.call(source, "target") ? { target: source.target } : {}),
    });
    expect(reduce(merged.events).getSnapshot().goal).toMatchObject({
      objective: "keep memory authority",
    });
    expect(merged.usedDurableTranscript).toBe(false);
  });

  it("persisted source filters the reverted branch and reads the cold goal", async () => {
    const oldUser = userMessage("u-old", "old question", 1_000, "turn-old");
    const oldAssistant = assistantMessage("a-old", "u-old", "old answer", 1_100, "turn-old");
    const rewindNotice = userMessage("u-rewind", "new question", 2_000, "turn-new");
    const newAssistant = assistantMessage("a-new", "u-rewind", "new answer", 2_100, "turn-new");
    const target = {
      sessionID: "s1",
      targetID: "target-1",
      objective: "ship the fix",
      summaryTitle: null,
      status: "paused",
      tokenBudget: null,
      tokensUsed: 7,
      timeUsedSeconds: 3,
      time: { created: 1, updated: 2 },
    };
    const getSession = vi.fn(async () => ({
      id: "s1",
      revert: {
        kind: "conversation_rewind",
        targetMessageID: "u-old",
        createdMessageID: "u-rewind",
        keptMessageIDs: [],
      },
    }));
    const messages = vi.fn(async () => [oldUser, oldAssistant, rewindNotice, newAssistant]);
    const readTarget = vi.fn(async () => target);
    const sessionEntries = vi.fn(async () => []);
    const loaded = await loadPersistedConversationMaterialization({
      memoryEvents: [],
      sessionId: "s1",
      store: { getSession, messages, readTarget, sessionEntries },
    });

    expect(loaded.messages.map((message: MessageWithParts) => String(message.info.id))).toEqual([
      "u-rewind",
      "a-new",
    ]);
    expect(loaded.target).toEqual(target);
    expect(getSession).toHaveBeenCalledWith("s1");
    expect(readTarget).toHaveBeenCalledWith({ sessionID: "s1" });
  });

  it("识别 shared_context transcript 并带出导入会话标题", async () => {
    const context = userMessage("shared-context", "# imported", 1_000, "shared-context-turn");
    context.info.synthetic = true;
    context.info.source = "shared_context";
    context.info.visibility = "model-only";
    context.info.semantics = {
      origin: "import",
      kind: "shared_context",
      source: "conversation_share",
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    };

    const loaded = await loadPersistedConversationMaterialization({
      memoryEvents: [],
      sessionId: "s1",
      store: {
        getSession: async () => ({ title: "导入的分享标题" }),
        messages: async () => [context],
        readTarget: async () => null,
      },
    });

    // 分享导入已使用统一 metadata；冷恢复仍须保留标题，不能要求废弃的平铺字段。
    expect(loaded.sharedContextImport).toEqual({ title: "导入的分享标题" });
  });

  it("keeps an explicitly persisted null target as durable authority", async () => {
    const loaded = await loadPersistedConversationMaterialization({
      memoryEvents: [],
      sessionId: "s1",
      store: {
        getSession: async () => null,
        messages: async () => [],
        readTarget: async () => null,
      },
    });

    expect(Object.prototype.hasOwnProperty.call(loaded, "target")).toBe(true);
    expect(loaded.target).toBeNull();
    const merged = mergeColdConversationEvents({
      memoryEvents: [
        event(1, SessionEventType.TargetChanged, {
          action: "set",
          source: "runtime",
          target: {
            sessionID: "s1",
            targetID: "stale",
            objective: "stale memory target",
            summaryTitle: null,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            time: { created: 1, updated: 2 },
          },
        }),
      ],
      messages: [],
      sessionId: "s1",
      target: loaded.target,
    });
    expect(reduce(merged.events).getSnapshot().goal).toBeNull();
    expect(merged.usedDurableTranscript).toBe(true);
  });

  it("materializes the persisted cold goal before verifier lifecycle", () => {
    const target = {
      sessionID: "s1",
      targetID: "target-1",
      objective: "ship the fix",
      summaryTitle: null,
      status: "paused",
      tokenBudget: null,
      tokensUsed: 7,
      timeUsedSeconds: 3,
      time: { created: 1, updated: 2 },
    };
    const merged = mergeColdConversationEvents({
      memoryEvents: [
        event(1, SessionEventType.TargetChanged, {
          action: "set",
          source: "runtime",
          target: { ...target, objective: "stale memory goal", status: "active" },
        }),
      ],
      messages: [],
      sessionId: "s1",
      target,
    } as Parameters<typeof mergeColdConversationEvents>[0]);

    expect(reduce(merged.events).getSnapshot().goal).toMatchObject({
      objective: "ship the fix",
      status: "paused",
    });
    expect(merged.usedDurableTranscript).toBe(true);
  });

  it("uses transcript as completed正文 authority while retaining queue-only memory state", () => {
    const messages = [
      userMessage("u1", "question", 1_000, "turn-1"),
      assistantMessage("a1", "u1", "durable answer", 1_100, "turn-1"),
    ];
    const memoryEvents = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    memoryEvents.push(
      event(
        memoryEvents.length + 1,
        SessionEventType.TurnSteerQueued,
        {
          pendingInputId: "queue-1",
          input: "follow up",
          inputPreview: "follow up",
          inputSize: 9,
          targetTurnId: "turn-live",
          queueLength: 1,
          delivery: "queue",
        },
        "turn-live",
      ),
    );

    const merged = mergeColdConversationEvents({
      memoryEvents,
      messages,
      sessionId: "s1",
    });
    const snapshot = reduce(merged.events).getSnapshot();

    expect(
      snapshot.rows.window
        .filter((row) => row.kind === "assistantText")
        .map((row) => (row.kind === "assistantText" ? row.text : "")),
    ).toEqual(["durable answer"]);
    expect(snapshot.queue.items.map((item) => item.queueItemId)).toEqual(["queue-1"]);
    expect(merged.events.map((item) => item.sequenceNumber)).toEqual(
      merged.events.map((_, index) => index + 1),
    );
    expect(merged.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cold_merge.durable_event_suppressed" }),
      ]),
    );
  });

  it("keeps the whole unfinished memory turn after durable completed history", () => {
    const messages = [
      userMessage("u1", "question", 1_000, "turn-1"),
      assistantMessage("a1", "u1", "answer", 1_100, "turn-1"),
    ];
    const completedMemory = synthesizeEventsFromMessages(messages, { sessionId: "s1" });
    const next = completedMemory.length + 1;
    const memoryEvents = [
      ...completedMemory,
      event(
        next,
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "live question", messageId: "u2-live" },
        "turn-2",
      ),
      event(
        next + 1,
        SessionEventType.ModelStreaming,
        {
          assistantMessageId: "a2-live",
          delta: "",
          done: false,
          kind: "text_start",
        },
        "turn-2",
      ),
      event(
        next + 2,
        SessionEventType.ModelStreaming,
        {
          assistantMessageId: "a2-live",
          delta: "partial",
          done: false,
          kind: "text_delta",
        },
        "turn-2",
      ),
    ];

    const merged = mergeColdConversationEvents({
      memoryEvents,
      messages,
      sessionId: "s1",
    });
    const snapshot = reduce(merged.events).getSnapshot();
    const assistantRows = snapshot.rows.window.filter((row) => row.kind === "assistantText");

    expect(assistantRows.map((row) => (row.kind === "assistantText" ? row.text : ""))).toEqual([
      "answer",
      "partial",
    ]);
    expect(assistantRows.at(-1)).toEqual(expect.objectContaining({ state: "streaming" }));
    expect(snapshot.control.phase).toBe("running");
  });

  it("never deduplicates an unanchored legacy turn by equal input text", () => {
    const messages = [
      userMessage("u1", "same question", 1_000, "turn-1"),
      assistantMessage("a1", "u1", "first answer", 1_100, "turn-1"),
    ];
    const memoryEvents = [
      event(1, SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }),
      // legacy TurnStarted: 文本与 durable u1 相同，但无 messageId/turn anchor，
      // 它可能是另一次真实提交，不得按文本查重。
      event(2, SessionEventType.TurnStarted, { turnNumber: 2, input: "same question" }, "legacy-2"),
      event(
        3,
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        "legacy-2",
      ),
    ];

    const merged = mergeColdConversationEvents({ memoryEvents, messages, sessionId: "s1" });
    const userRows = reduce(merged.events)
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "userInput");

    expect(userRows.map((row) => (row.kind === "userInput" ? row.text : ""))).toEqual([
      "same question",
      "same question",
    ]);
    expect(merged.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cold_merge.ambiguous_legacy_turn_preserved", count: 1 }),
      ]),
    );
  });

  it("deduplicates a goal boundary only when session_entry or timeline part really exists", () => {
    const messages = [
      userMessage("u1", "question", 1_000, "turn-1"),
      assistantMessage("a1", "u1", "answer", 1_100, "turn-1"),
    ];
    const memoryGoal = event(
      1,
      SessionEventType.TargetCompletionVerification,
      {
        targetId: "target-1",
        goalIteration: 1,
        verificationId: "verify-1",
        status: "completed",
      },
      "turn-1",
    );
    const goalVerificationEntries = [
      {
        payload: {
          targetId: "target-1",
          goalIteration: 1,
          verificationId: "verify-1",
          status: "completed",
          anchorAssistantMessageId: "a1",
        },
        sequenceNumber: 1,
        timeCreated: 1_200,
      },
    ];

    const withDurableBoundary = mergeColdConversationEvents({
      memoryEvents: [memoryGoal],
      messages,
      sessionId: "s1",
      goalVerificationEntries,
    });
    const withoutDurableBoundary = mergeColdConversationEvents({
      memoryEvents: [memoryGoal],
      messages,
      sessionId: "s1",
    });

    const markerCount = (events: readonly SessionEvent[]) =>
      reduce(events)
        .getSnapshot()
        .rows.window.filter(
          (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
        ).length;
    expect(markerCount(withDurableBoundary.events)).toBe(1);
    expect(markerCount(withoutDurableBoundary.events)).toBe(1);
    expect(withoutDurableBoundary.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cold_merge.memory_boundary_preserved", count: 1 }),
      ]),
    );
  });

  it("replays the full lifecycle of a still-pending edited queue item", () => {
    const initial = event(
      1,
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-edit",
        input: "original",
        inputPreview: "original",
        inputSize: 8,
        targetTurnId: "turn-live",
        queueLength: 1,
        delivery: "guide",
        intent: {
          sourceCommandId: "cmd-mobile-1",
          queueItemId: "queue-edit",
          clientId: "mobile-client",
          kind: "sendText",
          admissionSeq: 7,
          admittedAt: 12_345,
          requestedDelivery: "guide",
          admittedDelivery: "guide",
          queuePosition: 0,
          attachmentRefs: [
            {
              ref: "artifact://attachment-1",
              fileName: "note.txt",
              mime: "text/plain",
              bytes: 12,
            },
          ],
        },
      },
      "turn-live",
    );
    const legacyEdit = event(
      2,
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-edit",
        input: "edited",
        inputPreview: "edited",
        inputSize: 6,
        targetTurnId: "turn-live",
        queueLength: 1,
      },
      "turn-live",
    );
    const deliveryChanged = event(
      3,
      SessionEventType.TurnSteerDeliveryChanged,
      {
        pendingInputId: "queue-edit",
        targetTurnId: "turn-live",
        requestedDelivery: "guide",
        admittedDelivery: "queue",
        fallbackReasonCode: "guide.noToolBoundary",
      },
      "turn-live",
    );

    const merged = mergeColdConversationEvents({
      memoryEvents: [initial, legacyEdit, deliveryChanged],
      messages: [],
      sessionId: "s1",
    });
    const item = reduce(merged.events).getSnapshot().queue.items[0];

    expect(item).toEqual(
      expect.objectContaining({
        queueItemId: "queue-edit",
        text: "edited",
        sourceCommandId: "cmd-mobile-1",
        clientId: "mobile-client",
        attachments: [
          expect.objectContaining({ ref: "artifact://attachment-1", fileName: "note.txt" }),
        ],
        delivery: {
          requested: "guide",
          admitted: "queue",
          fallbackReasonCode: "guide.noToolBoundary",
        },
        order: { admissionSeq: 7, queuePosition: 0 },
        admittedAt: 12_345,
      }),
    );
  });

  it("inserts an anchored memory boundary at its durable product-turn tail", () => {
    const messages = [
      userMessage("u1", "first question", 1_000, "runtime-turn-1"),
      assistantMessage("a1", "u1", "first answer", 1_100, "runtime-turn-1"),
      userMessage("u2", "second question", 2_000, "runtime-turn-2"),
      assistantMessage("a2", "u2", "second answer", 2_100, "runtime-turn-2"),
    ];
    const unfinishedStart = event(
      1,
      SessionEventType.TurnStarted,
      { turnNumber: 3, input: "live third question", messageId: "u3-live" },
      "runtime-turn-3",
    );
    const anchoredBoundary = event(
      2,
      SessionEventType.TargetCompletionVerification,
      {
        targetId: "target-1",
        goalIteration: 1,
        verificationId: "verify-1",
        status: "completed",
        verification: { passed: true, reason: "done" },
        anchorAssistantMessageId: "a1",
      },
      "runtime-turn-3",
    );
    const unfinishedStream = event(
      3,
      SessionEventType.ModelStreaming,
      {
        assistantMessageId: "a3-live",
        delta: "partial third answer",
        done: false,
        kind: "text_delta",
      },
      "runtime-turn-3",
    );

    const merged = mergeColdConversationEvents({
      memoryEvents: [unfinishedStart, anchoredBoundary, unfinishedStream],
      messages,
      sessionId: "s1",
    });
    const rows = reduce(merged.events).getSnapshot().rows.window;
    const firstAnswerIndex = rows.findIndex(
      (row) => row.kind === "assistantText" && row.text === "first answer",
    );
    const markerIndex = rows.findIndex(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    );
    const secondQuestionIndex = rows.findIndex(
      (row) => row.kind === "userInput" && row.text === "second question",
    );

    expect(firstAnswerIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeGreaterThan(firstAnswerIndex);
    expect(markerIndex).toBeLessThan(secondQuestionIndex);
    expect(rows[markerIndex]?.turnId).toBe(rows[firstAnswerIndex]?.turnId);
    expect(rows[markerIndex]?.turnId).not.toBe(rows[secondQuestionIndex]?.turnId);
    const unfinishedStartIndex = merged.events.findIndex(
      (item) => item.type === SessionEventType.TurnStarted && item.turnId === "runtime-turn-3",
    );
    const secondDurableStartIndex = merged.events.findIndex(
      (item) =>
        item.type === SessionEventType.TurnStarted &&
        (item.payload as { messageId?: string }).messageId === "u2",
    );
    const unfinishedStreamIndex = merged.events.findIndex(
      (item) => item.type === SessionEventType.ModelStreaming && item.turnId === "runtime-turn-3",
    );
    expect(unfinishedStartIndex).toBeGreaterThan(secondDurableStartIndex);
    expect(unfinishedStreamIndex).toBeGreaterThan(unfinishedStartIndex);
  });

  it("HK10 preserves Hook lifecycle and anchors resume SessionStart to the next durable turn", () => {
    const descriptor = {
      clientVisible: true,
      sourceKind: "user",
      sourcePath: "/Users/example/.zcode/cli/config.json",
      executionType: "process",
      executionMode: "foreground",
      commandDisplay: 'echo ""',
      timeoutMs: 5_000,
    };
    const hookEvents = [
      event(
        1,
        SessionEventType.HookRunStarted,
        {
          descriptor,
          hookEventName: "SessionStart",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "startup-hook",
          hookRunId: "startup-run",
          startedAt: 10_001,
        },
        "runtime-turn-before-product-mapping",
      ),
      event(
        2,
        SessionEventType.HookRunCompleted,
        {
          descriptor,
          durationMs: 1,
          hookEventName: "SessionStart",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "startup-hook",
          hookRunId: "startup-run",
          outcome: "success",
          startedAt: 10_001,
        },
        "runtime-turn-before-product-mapping",
      ),
      event(3, SessionEventType.TurnStarted, { turnNumber: 2, input: "next" }, "runtime-turn-2"),
      event(
        4,
        SessionEventType.HookRunStarted,
        {
          descriptor,
          hookEventName: "PreToolUse",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "tool-hook",
          hookRunId: "tool-run",
          startedAt: 10_004,
          toolCallId: "tool-1",
          toolName: "Write",
        },
        "runtime-turn-2",
      ),
      event(
        5,
        SessionEventType.HookRunCompleted,
        {
          descriptor,
          durationMs: 1,
          hookEventName: "PreToolUse",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "tool-hook",
          hookRunId: "tool-run",
          outcome: "success",
          startedAt: 10_004,
          toolCallId: "tool-1",
          toolName: "Write",
        },
        "runtime-turn-2",
      ),
      event(6, SessionEventType.HookRunProgress, { hookRunId: "progress-run" }),
      event(7, SessionEventType.HookRunFailed, { hookRunId: "failed-run" }),
      event(8, SessionEventType.HookRunBlocked, { hookRunId: "blocked-run" }),
    ];

    const merged = mergeColdConversationEvents({
      memoryEvents: hookEvents,
      messages: [
        userMessage("u1", "run", 1_000, "runtime-turn-1"),
        assistantMessage("a1", "u1", "done", 1_100, "runtime-turn-1"),
        userMessage("u2", "next", 11_000, "runtime-turn-2"),
        assistantMessage("a2", "u2", "next done", 11_100, "runtime-turn-2"),
      ],
      sessionId: "s1",
    });
    const snapshot = reduce(merged.events).getSnapshot();

    const hookEventTypes = new Set([
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunProgress,
      SessionEventType.HookRunCompleted,
      SessionEventType.HookRunFailed,
      SessionEventType.HookRunBlocked,
    ]);
    expect(merged.events.filter((item) => hookEventTypes.has(item.type))).toHaveLength(7);
    expect(
      merged.diagnostics.find(
        (diagnostic) => String(diagnostic.code) === "cold_merge.non_product_event_suppressed",
      ),
    ).toBeUndefined();
    expect(
      merged.diagnostics.some(
        (diagnostic) => diagnostic.code === "cold_merge.unclassified_event_preserved",
      ),
    ).toBe(false);
    const hookRows = snapshot.rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows).toHaveLength(2);
    expect(hookRows.map((row) => row.turnId)).toEqual(["runtime-turn-2", "runtime-turn-2"]);
    expect(snapshot.rows.window.map((row) => row.turnId)).not.toContain("session-hooks:s1");
  });

  it("HK10 maps completed Hook runtime turns through durable anchors during cold recovery", () => {
    const descriptor = {
      clientVisible: true,
      sourceKind: "user",
      sourcePath: "/Users/example/.zcode/cli/config.json",
      executionType: "process",
      executionMode: "foreground",
      commandDisplay: 'echo ""',
      timeoutMs: 5_000,
    };
    const lifecycle = (
      sequenceNumber: number,
      hookEventName: "SessionStart" | "UserPromptSubmit" | "PreToolUse",
      hookInvocationId: string,
      runtimeTurnId: string,
    ) => [
      event(
        sequenceNumber,
        SessionEventType.HookRunStarted,
        {
          descriptor,
          hookEventName,
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId,
          hookRunId: `${hookInvocationId}-run`,
          startedAt: 10_000 + sequenceNumber,
        },
        runtimeTurnId,
      ),
      event(
        sequenceNumber + 1,
        SessionEventType.HookRunCompleted,
        {
          descriptor,
          durationMs: 1,
          hookEventName,
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId,
          hookRunId: `${hookInvocationId}-run`,
          outcome: "success",
          startedAt: 10_000 + sequenceNumber,
        },
        runtimeTurnId,
      ),
    ];
    const memoryEvents = [
      ...lifecycle(1, "SessionStart", "startup-hook", "runtime-before-first-turn"),
      event(
        3,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "first", messageId: "u1" },
        "runtime-turn-1",
      ),
      ...lifecycle(4, "UserPromptSubmit", "prompt-hook", "runtime-turn-1"),
      event(6, SessionEventType.TurnComplete, { resultType: "success" }, "runtime-turn-1"),
      event(
        7,
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "second", messageId: "u2" },
        "runtime-turn-2",
      ),
      ...lifecycle(8, "PreToolUse", "tool-hook", "runtime-turn-2"),
      event(10, SessionEventType.TurnComplete, { resultType: "success" }, "runtime-turn-2"),
    ];

    const merged = mergeColdConversationEvents({
      memoryEvents,
      messages: [
        userMessage("u1", "first", 1_000, "runtime-turn-1"),
        assistantMessage("a1", "u1", "first done", 1_100, "runtime-turn-1"),
        userMessage("u2", "second", 2_000, "runtime-turn-2"),
        assistantMessage("a2", "u2", "second done", 2_100, "runtime-turn-2"),
      ],
      sessionId: "s1",
    });
    const hookEvents = merged.events.filter((item) =>
      HOOK_LIFECYCLE_EVENT_TYPES_FOR_TEST.has(item.type),
    );
    expect(
      hookEvents
        .filter((item) => item.type === SessionEventType.HookRunStarted)
        .map((item) => item.turnId),
    ).toEqual(["hydrate-turn-1", "hydrate-turn-1", "hydrate-turn-2"]);

    const hookRows = reduce(merged.events)
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows.map((row) => [row.hookEventName, row.turnId])).toEqual([
      ["SessionStart", "u1"],
      ["UserPromptSubmit", "u1"],
      ["PreToolUse", "u2"],
    ]);
    expect(hookRows.map((row) => row.turnId)).not.toContain("runtime-turn-1");
    expect(hookRows.map((row) => row.turnId)).not.toContain("runtime-turn-2");
  });

  it("HK10 keeps Hook invocations on queue-drained product turns sharing one runtime anchor", () => {
    const descriptor = {
      clientVisible: true,
      sourceKind: "user",
      sourcePath: "/Users/example/.zcode/cli/config.json",
      executionType: "process",
      executionMode: "foreground",
      commandDisplay: 'echo ""',
      timeoutMs: 5_000,
    };
    const lifecycle = (sequenceNumber: number, hookInvocationId: string, runtimeTurnId: string) => [
      event(
        sequenceNumber,
        SessionEventType.HookRunStarted,
        {
          descriptor,
          hookEventName: "UserPromptSubmit",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId,
          hookRunId: `${hookInvocationId}-run`,
          startedAt: 10_000 + sequenceNumber,
        },
        runtimeTurnId,
      ),
      event(
        sequenceNumber + 1,
        SessionEventType.HookRunCompleted,
        {
          descriptor,
          durationMs: 1,
          hookEventName: "UserPromptSubmit",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId,
          hookRunId: `${hookInvocationId}-run`,
          outcome: "success",
          startedAt: 10_000 + sequenceNumber,
        },
        runtimeTurnId,
      ),
    ];
    const runtimeTurnId = "runtime-turn-shared";
    const [firstStarted, firstCompleted] = lifecycle(2, "first-prompt-hook", runtimeTurnId);
    const memoryEvents = [
      event(
        1,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "first", messageId: "u1" },
        runtimeTurnId,
      ),
      firstStarted!,
      event(
        3,
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: ["queue-2"],
          injectedMessageIds: ["u2"],
          drainedInputs: [
            {
              delivery: "queue",
              messageId: "u2",
              pendingInputId: "queue-2",
              text: "second",
            },
          ],
          targetTurnId: runtimeTurnId,
        },
        runtimeTurnId,
      ),
      event(
        4,
        SessionEventType.SessionInputPromoted,
        {
          pendingInputId: "queue-2",
          sourceCommandId: "command-2",
          messageId: "u2",
        },
        runtimeTurnId,
      ),
      { ...firstCompleted!, sequenceNumber: 5 },
      ...lifecycle(6, "second-prompt-hook", runtimeTurnId),
      event(
        8,
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 10,
          resultType: "success",
        },
        runtimeTurnId,
      ),
    ];

    const merged = mergeColdConversationEvents({
      memoryEvents,
      messages: [
        userMessage("u1", "first", 1_000, runtimeTurnId),
        assistantMessage("a1", "u1", "first done", 1_100, runtimeTurnId),
        userMessage("u2", "second", 2_000, runtimeTurnId),
        assistantMessage("a2", "u2", "second done", 2_100, runtimeTurnId),
      ],
      sessionId: "s1",
    });

    expect(
      merged.events
        .filter((item) => item.type === SessionEventType.HookRunStarted)
        .map((item) => item.turnId),
    ).toEqual(["hydrate-turn-1", "hydrate-turn-2"]);
    const hookRows = reduce(merged.events)
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows.map((row) => [row.hookInvocationId, row.turnId])).toEqual([
      ["first-prompt-hook", "u1"],
      ["second-prompt-hook", "u2"],
    ]);
    expect(hookRows.map((row) => row.turnId)).not.toContain(runtimeTurnId);
  });

  it("HK17 does not anchor a SessionStart summary onto a model-only compact turn during cold merge", () => {
    // Bug 根因：首条输入即 /compact 时，SessionStart Hook 真实执行且事件携带 compact 的
    // runtime turnId。cold 归属把 pending SessionStart 绑到「下一个 TurnStarted」；compact
    // 维护 turn 也是 TurnStarted（inputVisibility=model-only），旧逻辑会把摘要错误归位到
    // compact marker 轮。维护 turn 没有资格承载摘要，必须跳过等下一条真实 turn。
    const descriptor = {
      clientVisible: true,
      sourceKind: "user",
      sourcePath: "/Users/example/.zcode/cli/config.json",
      executionType: "process",
      executionMode: "foreground",
      commandDisplay: 'echo ""',
      timeoutMs: 5_000,
    };
    const memoryEvents = [
      event(
        1,
        SessionEventType.HookRunStarted,
        {
          descriptor,
          hookEventName: "SessionStart",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "startup-hook",
          hookRunId: "startup-run",
          startedAt: 10_001,
        },
        "runtime-turn-compact",
      ),
      event(
        2,
        SessionEventType.HookRunCompleted,
        {
          descriptor,
          durationMs: 1,
          hookEventName: "SessionStart",
          hookIndex: 0,
          hookCount: 1,
          hookInvocationId: "startup-hook",
          hookRunId: "startup-run",
          outcome: "success",
          startedAt: 10_001,
        },
        "runtime-turn-compact",
      ),
      // compact 维护 turn：inputVisibility=model-only；durable transcript 里没有对应 user message。
      event(
        3,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "/compact", inputVisibility: "model-only" },
        "runtime-turn-compact",
      ),
      event(
        4,
        SessionEventType.CompactCompleted,
        {
          operationId: "op-1",
          messageId: "msg-compact",
          status: "completed",
          trigger: "manual",
          display: "separator",
        },
        "runtime-turn-compact",
      ),
      event(
        5,
        SessionEventType.TurnComplete,
        {
          response: "compacted",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 100,
          resultType: "success",
        },
        "runtime-turn-compact",
      ),
      event(6, SessionEventType.TurnStarted, { turnNumber: 2, input: "next" }, "runtime-turn-2"),
    ];

    const merged = mergeColdConversationEvents({
      memoryEvents,
      messages: [userMessage("u2", "next", 11_000, "runtime-turn-2")],
      sessionId: "s1",
    });
    // turn-2 尚未完成：memory 事件是权威，Hook lifecycle 以 supplement 顺序进入
    // ProductProjection；compact 维护 turn 期间不得收口，最终归属由投影裁决。
    const hookRows = reduce(merged.events)
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "hookInvocation");
    expect(hookRows).toHaveLength(1);
    expect(hookRows[0]).toMatchObject({
      hookEventName: "SessionStart",
      turnId: "runtime-turn-2",
      executions: [expect.objectContaining({ didExecute: true })],
    });
    // compact 维护 turn 上没有任何 Hook row。
    expect(hookRows.map((row) => row.turnId)).not.toContain("runtime-turn-compact");
  });

  it("keeps the edit lock of a pending queue item and drops it once the item is discarded", () => {
    // 冷合并只读当前进程的内存事件，与 runtime 锁表同源；项出队后锁事件随之丢弃，
    // 不能让已结算项的旧锁回到投影（docs/ui/composer-edit-mode.md）。
    const queued = event(
      1,
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-locked",
        input: "edit me",
        inputPreview: "edit me",
        inputSize: 7,
        targetTurnId: "turn-live",
        queueLength: 1,
        delivery: "queue",
      },
      "turn-live",
    );
    const locked = event(2, SessionEventType.TurnSteerEditLockChanged, {
      pendingInputId: "queue-locked",
      targetTurnId: "turn-live",
      editLock: { editorId: "editor-a", clientId: "desktop" },
    });
    const discarded = event(3, SessionEventType.TurnSteerDiscarded, {
      pendingInputIds: ["queue-locked"],
      reason: "session_resumed",
      targetTurnId: "turn-live",
    });

    const pending = mergeColdConversationEvents({
      memoryEvents: [queued, locked],
      messages: [],
      sessionId: "s1",
    });
    expect(reduce(pending.events).getSnapshot().queue.items).toMatchObject([
      { queueItemId: "queue-locked", editLock: { editorId: "editor-a", clientId: "desktop" } },
    ]);

    const settled = mergeColdConversationEvents({
      memoryEvents: [queued, locked, discarded],
      messages: [],
      sessionId: "s1",
    });
    expect(reduce(settled.events).getSnapshot().queue.items).toEqual([]);
    expect(
      settled.events.some((item) => item.type === SessionEventType.TurnSteerEditLockChanged),
    ).toBe(false);
  });

  it("treats SessionInputPromoted as a known queue terminal during cold merge", () => {
    const queued = event(
      1,
      SessionEventType.TurnSteerQueued,
      {
        pendingInputId: "queue-promoted",
        input: "send now",
        inputPreview: "send now",
        inputSize: 8,
        targetTurnId: "turn-live",
        queueLength: 1,
        delivery: "queue",
      },
      "turn-live",
    );
    const promoted = event(2, SessionEventType.SessionInputPromoted, {
      pendingInputId: "queue-promoted",
      sourceCommandId: "command-promoted",
      messageId: "message-promoted",
    });

    const merged = mergeColdConversationEvents({
      memoryEvents: [queued, promoted],
      messages: [],
      sessionId: "s1",
    });
    const snapshot = reduce(merged.events).getSnapshot();

    expect(snapshot.queue.items).toEqual([]);
    expect(
      merged.diagnostics.some(
        (diagnostic) => diagnostic.code === "cold_merge.unclassified_event_preserved",
      ),
    ).toBe(false);
    expect(
      merged.events.some(
        (item) =>
          item.type === SessionEventType.TurnSteerQueued ||
          item.type === SessionEventType.SessionInputPromoted,
      ),
    ).toBe(false);
  });
});

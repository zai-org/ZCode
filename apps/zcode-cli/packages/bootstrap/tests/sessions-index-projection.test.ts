// SessionsIndexProjection / SessionsIndexPublisher 黄金测试（M5 ①，14-sessions-index）：
// 多会话 ConversationSnapshot → SessionSummary 派生 + upsert/remove delta + conflation + 帧记账。
import { describe, expect, it } from "vitest";
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  sessionsIndexSnapshotSchema,
  sessionsIndexTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import {
  SessionsIndexProjection,
  deriveSessionSummary,
} from "../src/zcode-protocol-v4/sessions-index-projection.js";
import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";

function buildEvents(
  sessionId: string,
  build: (push: (type: SessionEventTypeUnion, payload: unknown, turnId?: string) => void) => void,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  let seq = 0;
  build((type, payload, turnId) => {
    seq += 1;
    events.push({
      id: `event-${sessionId}-${seq}` as EventId,
      sessionId: sessionId as SessionId,
      turnId: turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: seq,
      payload,
    });
  });
  return events;
}

function projectionFor(sessionId: string, events: SessionEvent[]): ProductProjection {
  const projection = new ProductProjection(sessionId, "epoch-1");
  for (const event of events) projection.applyEvent(event);
  return projection;
}

describe("SessionsIndexProjection 黄金测试（L1）", () => {
  it("裁剪正文不改变持久化 lastOutcome，实时 phase 也不推导历史结果", () => {
    const snapshot = projectionFor("s1", []).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "/repo",
      createdAt: 1,
      lastActivityAt: 2,
      lastOutcome: "error",
    });
    expect(summary.lastOutcome).toBe("error");
    expect(summary.phase).toBe("draft");
  });

  it("派生：title/phase/goal/hasBackgroundWork/preview 从会话快照取值", () => {
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.SessionTitleUpdated, {
        previousTitle: "",
        source: "custom",
        title: "我的会话",
      });
      push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi", inputId: "query-1" }, "t1");
      push(
        SessionEventType.ModelStreaming,
        { kind: "text_start", delta: "", done: false, assistantMessageId: "m1" },
        "t1",
      );
      push(
        SessionEventType.ModelStreaming,
        {
          kind: "text_delta",
          delta: "你好世界",
          done: false,
          assistantMessageId: "m1",
        },
        "t1",
      );
      push(SessionEventType.ModelStreaming, { kind: "text_end", delta: "", done: false }, "t1");
      push(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 0,
          resultType: "success",
          historyRoundCount: 2,
        },
        "t1",
      );
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1000,
      lastActivityAt: 2000,
      lastOutcome: "completed",
    });
    expect(summary.sessionId).toBe("s1");
    expect(summary.workspaceId).toBe("ws-1");
    expect(summary.title).toBe("我的会话");
    expect(summary.titleSource).toBe("custom");
    expect(summary.phase).toBe("completedSuccess");
    expect(summary.lastOutcome).toBe("completed");
    // control.sessionEnded 由 onTurnComplete 置为 phase!=="error"（M2 既有语义，summary 忠实透传）。
    expect(summary.sessionEnded).toBe(true);
    expect(summary.hasBackgroundWork).toBe(false);
    expect(summary.lastAssistantPreview).toContain("你好世界");
    expect(summary.createdAt).toBe(1000);
    expect(summary.lastActivityAt).toBe(2000);
  });

  it("hasCompactWork：只跟踪 compact 活跃态，并在开始与结束时产出 upsert", () => {
    const events = buildEvents("s-compact", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.TurnStarted, { turnNumber: 1, input: "hi", inputId: "query-1" }, "t1");
      push(
        SessionEventType.TurnComplete,
        {
          response: "done",
          tokenCount: 0,
          toolCallCount: 0,
          duration: 0,
          resultType: "success",
          historyRoundCount: 1,
        },
        "t1",
      );
    });
    const projection = projectionFor("s-compact", events);
    const index = new SessionsIndexProjection("ws-1", "epoch-1");
    const extra = { createdAt: 1, lastActivityAt: 2 };
    expect(index.upsertFromConversation(projection.getSnapshot(), extra)[0]).toMatchObject({
      op: "session.upserted",
      session: { hasCompactWork: false },
    });

    const [started] = buildEvents("s-compact", (push) =>
      push(SessionEventType.CompactStarted, {
        operationId: "op-1",
        messageId: "msg-1",
        status: "started",
        trigger: "manual",
        display: "separator",
      }),
    );
    projection.applyEvent(started!);
    expect(index.upsertFromConversation(projection.getSnapshot(), extra)[0]).toMatchObject({
      op: "session.upserted",
      session: { hasCompactWork: true },
    });

    const [completed] = buildEvents("s-compact", (push) =>
      push(SessionEventType.CompactCompleted, {
        operationId: "op-1",
        messageId: "msg-1",
        status: "completed",
        trigger: "manual",
        display: "separator",
        preCompactTokenCount: 800,
        postCompactTokenCount: 300,
      }),
    );
    projection.applyEvent(completed!);
    expect(index.upsertFromConversation(projection.getSnapshot(), extra)[0]).toMatchObject({
      op: "session.upserted",
      session: { hasCompactWork: false },
    });

    const base = projection.getSnapshot();
    const otherActiveWork = {
      ...base,
      control: {
        ...base.control,
        activeWorks: [{ kind: "goalVerifier" as const, startedAt: 1 }],
      },
    };
    expect(deriveSessionSummary(otherActiveWork, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    })).toMatchObject({ hasCompactWork: false });
  });

  it("old sessions-index summary without hasCompactWork remains valid and means false", () => {
    const summary = deriveSessionSummary(projectionFor("s-old", []).getSnapshot(), {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });
    const { hasCompactWork: _ignored, ...oldSummary } = {
      ...summary,
      hasCompactWork: false,
    };
    const parsed = sessionsIndexSnapshotSchema.parse({
      protocolVersion: 1,
      workspaceId: "ws-1",
      logEpoch: "epoch-1",
      sessions: [oldSummary],
    });
    expect(parsed.sessions[0]).not.toHaveProperty("hasCompactWork");
    const index = new SessionsIndexProjection("ws-1", "epoch-1");
    index.seed(parsed.sessions[0]!);
    expect(index.upsertFromConversation(projectionFor("s-old", []).getSnapshot(), {
      createdAt: 1,
      lastActivityAt: 2,
    })).toEqual([]);
    expect(sessionsIndexSnapshotSchema.parse({
      ...parsed,
      sessions: [{ ...oldSummary, hasCompactWork: true }],
    }).sessions[0]).toMatchObject({ hasCompactWork: true });
    expect(sessionsIndexSnapshotSchema.safeParse({
      ...parsed,
      sessions: [{ ...oldSummary, hasCompactWork: "true" }],
    }).success).toBe(false);
  });

  it("hasBackgroundWork：有 running 后台任务时为 true", () => {
    const events = buildEvents("s2", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.BackgroundTaskStarted, {
        taskId: "bg-1",
        toolName: "Bash",
        command: "sleep 100",
        status: "running",
      });
    });
    const snapshot = projectionFor("s2", events).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });
    expect(summary.hasBackgroundWork).toBe(true);
  });

  it("workflowActivity：从 workflowRuns + workflow 后台工作派生；活动时间不变时只改 node 的事件判等，phase 翻转必产帧", () => {
    const runProgress = (
      push: (type: SessionEventTypeUnion, payload: unknown) => void,
      sequence: number,
      eventType: string,
      payload: Record<string, unknown>,
    ) =>
      push(SessionEventType.DynamicWorkflowRunProgress, {
        runId: "run-1",
        toolCallId: "tool-1",
        sequence,
        eventType,
        payload,
      });
    const events = buildEvents("s-wf", (push) => {
      push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
      push(SessionEventType.BackgroundTaskStarted, {
        taskId: "run-1",
        toolName: "CreateWorkflow",
        taskKind: "workflow",
        description: "Deep research",
        status: "running",
      });
      runProgress(push, 0, "run-started", { runId: "run-1", caps: { maxConcurrency: 4 } });
      runProgress(push, 1, "run-launched", {
        inputId: "in-1",
        phaseNames: ["Research", "Write"],
        // 进入 Write 时 Research 的 strand 还在跑：侧栏据此把两站之间画成双线段。
        phaseAlongside: [[], [0]],
      });
      runProgress(push, 2, "phase-entered", { name: "Research", ordinal: 1 });
      runProgress(push, 3, "actor-created", {
        actor: { siteId: "actor#1", ordinal: 1 },
        name: "Scout",
      });
      runProgress(push, 4, "node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      });
      runProgress(push, 5, "node-executing", { instance: { siteId: "ask#1", ordinal: 1 } });
    });
    const projection = projectionFor("s-wf", events);
    const summary = deriveSessionSummary(projection.getSnapshot(), {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });
    expect(summary.hasBackgroundWork).toBe(true);
    expect(summary.workflowActivity).toEqual({
      runs: [
        {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "Deep research",
          status: "running",
          startedAt: expect.any(Number),
          phases: [
            { name: "Research", status: "running" },
            { name: "Write", status: "pending", alongside: [0] },
          ],
          currentPhase: "Research",
          agentsWorking: 1,
        },
      ],
    });

    // 同一 run 再来只改 node / 用量、不改 phase / status / 子代理数的事件：摘要判等，不产侧栏帧。
    const index = new SessionsIndexProjection("ws-1", "epoch-1");
    expect(
      index.upsertFromConversation(projection.getSnapshot(), { createdAt: 1, lastActivityAt: 2 }),
    ).toHaveLength(1);
    const nodeOnly = buildEvents("s-wf", (push) => {
      runProgress(push, 6, "node-queued", {
        instance: { siteId: "ask#2", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      });
      runProgress(push, 7, "usage-updated", { spentTokens: 120 });
    });
    for (const event of nodeOnly) projection.applyEvent(event);
    expect(
      index.upsertFromConversation(projection.getSnapshot(), { createdAt: 1, lastActivityAt: 2 }),
    ).toEqual([]);
    // 进入下一个 phase 则产 delta，且站点灯随之翻转。
    const [phase] = buildEvents("s-wf", (push) =>
      runProgress(push, 8, "phase-entered", { name: "Write", ordinal: 1 }),
    );
    projection.applyEvent(phase!);
    const deltas = index.upsertFromConversation(projection.getSnapshot(), {
      createdAt: 1,
      lastActivityAt: 2,
    });
    expect(deltas).toHaveLength(1);
    const delta = deltas[0]!;
    if (delta.op !== "session.upserted") throw new Error("expected upsert");
    expect(delta.session.workflowActivity?.runs[0]?.phases.map((p) => p.status)).toEqual([
      "done",
      "running",
    ]);
  });

  it("projects the head interaction auto-resolution state into the lightweight summary", () => {
    const events = buildEvents("s-ask", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
      push(SessionEventType.PermissionRequested, {
        requestId: "ask-1",
        toolCallId: "tool-1",
        toolName: "AskUserQuestion",
        riskLevel: "low",
        reason: "Need input",
        input: {
          questions: [
            {
              header: "Choice",
              question: "Choose?",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
            },
          ],
        },
      });
      push(SessionEventType.UserInputAutoResolutionUpdated, {
        interactionId: "ask-1",
        toolCallId: "tool-1",
        autoResolution: {
          state: "visibleCountdown",
          startedAt: 1_000,
          visibleAt: 61_000,
          deadlineAt: 301_000,
        },
      });
    });
    const summary = deriveSessionSummary(projectionFor("s-ask", events).getSnapshot(), {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
    });

    expect(summary.pendingInteraction).toEqual({
      interactionId: "ask-1",
      kind: "userInput",
      toolName: "AskUserQuestion",
      autoResolution: {
        state: "visibleCountdown",
        startedAt: 1_000,
        visibleAt: 61_000,
        deadlineAt: 301_000,
      },
    });
  });

  it("只投影 pending interaction 的 kind/count，不下发 payload", () => {
    const events = buildEvents("s-interactions", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const baseSnapshot = projectionFor("s-interactions", events).getSnapshot();
    const summary = deriveSessionSummary(
      {
        ...baseSnapshot,
        pendingInteractions: [
          { kind: "permission" } as never,
          { kind: "permission" } as never,
          { kind: "userInput" } as never,
        ],
      },
      {
        workspaceId: "ws-1",
        createdAt: 1,
        lastActivityAt: 2,
      },
    );

    expect(summary.pendingInteractionSummary).toEqual({
      permissionCount: 2,
      userInputCount: 1,
    });
    expect(summary).not.toHaveProperty("pendingInteractions");
  });

  it("不把 workspace Hook review 降级成 permission/userInput 侧栏状态", () => {
    const events = buildEvents("s-workspace-review", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const baseSnapshot = projectionFor("s-workspace-review", events).getSnapshot();
    const summary = deriveSessionSummary(
      {
        ...baseSnapshot,
        pendingInteractions: [
          {
            interactionId: "workspace-review-1",
            kind: "workspaceHookReview",
            payload: { kind: "workspaceHookReview" },
          } as never,
        ],
      },
      {
        workspaceId: "ws-1",
        createdAt: 1,
        lastActivityAt: 2,
      },
    );

    expect(summary).not.toHaveProperty("pendingInteraction");
    expect(summary).not.toHaveProperty("pendingInteractionSummary");
  });

  it("index：upsert 变化才产 delta（conflation），remove 命中产 delta", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    const extra = { createdAt: 1, lastActivityAt: 2 };

    // 首次 upsert 产 delta
    const d1 = index.upsertFromConversation(snapshot, extra);
    expect(d1).toHaveLength(1);
    expect(d1[0]).toMatchObject({ op: "session.upserted" });

    // 相同 snapshot + extra → 幂等无 delta
    const d2 = index.upsertFromConversation(snapshot, extra);
    expect(d2).toHaveLength(0);

    // lastActivityAt 变化 → 再产 upsert
    const d3 = index.upsertFromConversation(snapshot, {
      createdAt: 1,
      lastActivityAt: 3,
    });
    expect(d3).toHaveLength(1);

    // 快照含该会话
    expect(index.getSnapshot().sessions.map((s) => s.sessionId)).toEqual(["s1"]);

    // remove 命中产 delta，再 remove 幂等
    expect(index.remove("s1")).toHaveLength(1);
    expect(index.remove("s1")).toHaveLength(0);
    expect(index.getSnapshot().sessions).toHaveLength(0);
  });

  it("index：stored→live 降级防御——live 空标题/新时间不得覆盖 store 种子", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    // store 种子：带标题与原始时间（模拟侧栏冷启动）。
    index.seed({
      sessionId: "s1",
      workspaceId: "ws-1",
      title: "项目分析与优化",
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 100,
      lastAssistantPreview: "旧预览",
      createdAt: 10,
    });
    // 冷恢复的 live 投影：hydration 前 meta.title 为空、record 时间被 resume 重置为"现在"。
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    index.upsertFromConversation(snapshot, {
      createdAt: 9_999,
      lastActivityAt: 9_999,
    });
    const merged = index.getSnapshot().sessions.find((s) => s.sessionId === "s1");
    expect(merged?.title).toBe("项目分析与优化");
    expect(merged?.createdAt).toBe(10);
    expect(merged?.lastAssistantPreview).toBe("旧预览");
    // Bugfix 断言：hydration 前的 live 投影 phase 是初始 draft，不得把终态基线降级。
    expect(merged?.phase).toBe("completedSuccess");
    expect(merged?.sessionEnded).toBe(true);
  });

  it("index：冷恢复 draft 窗口快照与基线等价时不产 delta（打开历史任务不刷列表）", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    index.seed({
      sessionId: "s1",
      workspaceId: "ws-1",
      title: "项目分析与优化",
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 100,
      lastAssistantPreview: "旧预览",
      createdAt: 10,
    });
    // 冷恢复 live 投影（hydration 未完成）：phase=draft、无标题/预览；
    // record 时间已由 resume 路径回填 store 真实时间（lastActivityAt 一致）。
    const events = buildEvents("s1", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("s1", events).getSnapshot();
    const deltas = index.upsertFromConversation(snapshot, {
      createdAt: 10,
      lastActivityAt: 100,
    });
    // 所有字段被降级防御保住 → summariesEqual → 零 delta，UI 列表不动。
    expect(deltas).toHaveLength(0);
  });

  it("index：多会话快照 schema 合法 + 无序聚合", () => {
    const index = new SessionsIndexProjection("ws-1", "list-epoch-1");
    for (const sid of ["a", "b", "c"]) {
      const events = buildEvents(sid, (push) => {
        push(SessionEventType.SessionCreated, {
          mode: "default",
          contextWindow: 200_000,
        });
      });
      index.upsertFromConversation(projectionFor(sid, events).getSnapshot(), {
        createdAt: 1,
        lastActivityAt: 2,
      });
    }
    const snap = index.getSnapshot();
    expect(snap.sessions).toHaveLength(3);
    expect(new Set(snap.sessions.map((s) => s.sessionId))).toEqual(new Set(["a", "b", "c"]));
    // 帧 schema 合法性
    expect(() => sessionsIndexSnapshotSchema.parse(snap)).not.toThrow();
  });

  it("fork：parentSessionId 透传", () => {
    const events = buildEvents("child", (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    const snapshot = projectionFor("child", events).getSnapshot();
    const summary = deriveSessionSummary(snapshot, {
      workspaceId: "ws-1",
      createdAt: 1,
      lastActivityAt: 2,
      parentSessionId: "parent",
    });
    expect(summary.parentSessionId).toBe("parent");
  });
});

describe("SessionsIndexPublisher 单测（帧记账）", () => {
  let clock = 1000;
  const now = () => (clock += 1);

  function snap(sessionId: string): ReturnType<ProductProjection["getSnapshot"]> {
    const events = buildEvents(sessionId, (push) => {
      push(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      });
    });
    return projectionFor(sessionId, events).getSnapshot();
  }

  it("subscribe → snapshot 帧（fromSeq=0），帧 schema 合法", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    const res = pub.subscribe("conn-1");
    expect(res.mode).toBe("snapshot");
    expect(res.frame?.payload.kind).toBe("snapshot");
    expect(res.frame?.fromSeq).toBe(0);
    expect(() => sessionsIndexTopicFrameSchema.parse(res.frame)).not.toThrow();
  });

  it("订阅后 ingest → flush 出增量帧（(fromSeq, toSeq]）", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    const res = pub.subscribe("conn-1");
    const baseSeq = res.frame?.toSeq ?? 0;
    // 新会话进入 → 有变化
    expect(pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 })).toBe(true);
    const frame = pub.flush(res.subscriptionId);
    expect(frame?.payload.kind).toBe("deltas");
    expect(frame?.fromSeq).toBe(baseSeq);
    expect(frame?.toSeq).toBe(pub.seq);
    if (frame?.payload.kind === "deltas") {
      expect(frame.payload.deltas[0]).toMatchObject({ op: "session.upserted" });
    }
    // 已排空 → 再 flush 为 null
    expect(pub.flush(res.subscriptionId)).toBeNull();
  });

  it("幂等 ingest 不产帧；resume base=当前 seq → frame null", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    // 同快照再进 → 无变化
    expect(pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 })).toBe(false);
    const res = pub.subscribe("conn-1", { logEpoch: "epoch-1", seq: pub.seq });
    expect(res.mode).toBe("resume");
    expect(res.frame).toBeNull();
  });

  it("removeSession → remove delta 帧", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    const res = pub.subscribe("conn-1");
    expect(pub.removeSession("a")).toBe(true);
    const frame = pub.flush(res.subscriptionId);
    if (frame?.payload.kind === "deltas") {
      expect(frame.payload.deltas[0]).toMatchObject({
        op: "session.removed",
        sessionId: "a",
      });
    } else {
      throw new Error("expected deltas frame");
    }
  });

  it("异代际 base → 退化 snapshot；重订阅替换旧代际（同 connection 新 subscriptionId）", () => {
    const pub = new SessionsIndexPublisher("ws-1", "epoch-1", now);
    pub.ingestConversation(snap("a"), { createdAt: 1, lastActivityAt: 2 });
    const stale = pub.subscribe("conn-1", { logEpoch: "other-epoch", seq: 1 });
    expect(stale.mode).toBe("snapshot");
    expect(stale.frame?.payload.kind).toBe("snapshot");
    const replaced = pub.subscribe("conn-1");
    expect(replaced.subscriptionId).not.toBe(stale.subscriptionId);
    expect(pub.subscriptionIds()).toEqual([replaced.subscriptionId]);
  });
});

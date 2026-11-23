import { expect, it } from "vitest";
import { DEFERRED_TOOL_CALL_NAME, SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationTopicPublisher, ProductProjection } from "../src/zcode-protocol-v4/index.js";
import {
  subagentProjectionStateSchema,
  applyConversationDeltas,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

it.each([false, true])(
  "scheduled identity owns tool rows and plan/CUA consumers (wrapped=%s)",
  (wrapped) => {
    const projection = new ProductProjection("session", "epoch");
    const publisher = new ConversationTopicPublisher("session", "epoch");
    let sequence = 0;
    const apply = (type: SessionEvent["type"], payload: unknown) => {
      const event = {
        id: `event-${++sequence}`,
        sessionId: "session",
        turnId: "turn",
        traceId: "trace",
        timestamp: new Date(1700000000000 + sequence),
        sequenceNumber: sequence,
        type,
        payload,
      } as SessionEvent;
      projection.applyEvent(event);
      publisher.ingest(event);
    };
    apply(SessionEventType.SessionCreated, { mode: "plan", contextWindow: 200000 });
    apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "plan", messageId: "user" });
    const clients = (["continuous", "replayable"] as const).map((deliveryProfile) => {
      const subscription = publisher.subscribe({ connectionId: deliveryProfile, deliveryProfile });
      if (subscription.frame?.payload.kind !== "snapshot")
        throw new Error("expected initial snapshot");
      return {
        deliveryProfile,
        subscriptionId: subscription.ack.subscriptionId,
        snapshot: subscription.frame.payload.snapshot,
      };
    });
    const run = (name: string, input: Record<string, unknown>, content: string) => {
      const id = `call-${sequence}`;
      const raw = {
        kind: "tool_call",
        toolCallId: id,
        toolName: wrapped ? "DeferredToolCall" : name,
        input: wrapped ? { name, input } : input,
        done: false,
        delta: "",
      };
      apply(SessionEventType.ModelStreaming, { ...raw, kind: "tool_input_start" });
      apply(SessionEventType.ModelStreaming, raw);
      apply(SessionEventType.ToolCallScheduled, {
        toolCallId: id,
        toolName: name,
        input,
        schedule: { parallelGroups: [[id]], executionOrder: [id] },
      });
      // 重放/流式终稿不能把已准入的目标输入重新覆盖成包装参数。
      apply(SessionEventType.ModelStreaming, raw);
      apply(SessionEventType.ToolCallStarted, { toolCallId: id, toolName: name });
      apply(SessionEventType.ToolCallResult, {
        toolCallId: id,
        toolName: name,
        result: { success: true, content },
        duration: 1,
      });
      const row = projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === id);
      expect(row).toMatchObject({ toolName: name, input, status: "success" });
      for (const client of clients) {
        const frame = publisher.flush(client.subscriptionId);
        if (frame?.payload.kind !== "deltas") throw new Error("expected live tool deltas");
        client.snapshot = {
          ...applyConversationDeltas(client.snapshot, frame.payload.deltas),
          seq: frame.toSeq,
        } as ConversationSnapshot;
        expect(
          client.snapshot.rows.window.find(
            (row) => row.kind === "toolCall" && row.toolCallId === id,
          ),
        ).toMatchObject({ toolName: name, input, status: "success" });
      }
      return row;
    };
    run("ExitPlanMode", { plan: "# Plan\nImplement it" }, "Approved");
    expect(publisher.getPlans().plans).toHaveLength(1);
    run(
      "mcp__computer-use__list_apps",
      {},
      JSON.stringify({ apps: [{ pid: 123, name: "Browser", bundle_id: "demo.browser" }] }),
    );
    const click = run("mcp__computer-use__click", { app_ref: { pid: 123 }, x: 1, y: 2 }, "Clicked");
    expect(click).toMatchObject({
      cuaApp: { pid: 123, name: "Browser", bundleId: "demo.browser" },
    });
    for (const client of clients) {
      const frame = publisher.subscribe({
        connectionId: `${client.deliveryProfile}-cold`,
        deliveryProfile: client.deliveryProfile,
      }).frame;
      if (frame?.payload.kind !== "snapshot") throw new Error("expected recovery snapshot");
      expect(frame.payload.snapshot.rows.window).toEqual(client.snapshot.rows.window);
    }
  },
);

function createIdentityFixture(toolName = DEFERRED_TOOL_CALL_NAME) {
  const projection = new ProductProjection("session", "epoch");
  const publisher = new ConversationTopicPublisher("session", "epoch");
  let sequence = 0;
  const emit = (type: SessionEvent["type"], payload: unknown, turnId = "turn") => {
    const event = {
      id: `identity-${++sequence}`,
      sessionId: "session",
      turnId,
      traceId: "trace",
      timestamp: new Date(1700000000000 + sequence),
      sequenceNumber: sequence,
      type,
      payload,
    } as SessionEvent;
    const deltas = projection.applyEvent(event);
    publisher.ingest(event);
    return deltas;
  };
  emit(SessionEventType.SessionCreated, { mode: "plan", contextWindow: 200000 });
  emit(SessionEventType.TurnStarted, { turnNumber: 1, input: "plan", messageId: "user" });
  const raw = {
    assistantMessageId: "assistant",
    kind: "tool_call",
    toolCallId: "wrapped",
    toolName,
    input: { name: "TodoWrite", input: { todos: [] } },
    done: false,
    delta: "",
  };
  emit(SessionEventType.ModelStreaming, { ...raw, input: undefined, kind: "tool_input_start" });
  emit(SessionEventType.ModelStreaming, raw);
  const closed = {
    assistantMessageId: "assistant",
    attemptId: "attempt",
    toolCallId: "wrapped",
    toolName: "TodoWrite",
    input: { todos: [{ content: "next", status: "pending", priority: "medium" }] },
    status: "tool_call_closed",
    executionTiming: "during_stream",
  };
  const row = () => projection.getSnapshot().rows.window.find((item) => item.kind === "toolCall");
  return { projection, publisher, emit, raw, closed, row };
}

it("closed target identity updates only the wrapper row and reaches both delivery profiles", () => {
  const { projection, publisher, emit, raw, closed, row } = createIdentityFixture();
  const clients = (["continuous", "replayable"] as const).map((deliveryProfile) => {
    const subscription = publisher.subscribe({ connectionId: deliveryProfile, deliveryProfile });
    if (subscription.frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
    return {
      subscriptionId: subscription.ack.subscriptionId,
      snapshot: subscription.frame.payload.snapshot,
    };
  });
  const before = projection.getSnapshot();
  const previousRow = row();
  const expected = {
    ...previousRow,
    toolName: closed.toolName,
    input: closed.input,
    inputText: JSON.stringify(closed.input),
  };
  expect(emit(SessionEventType.StreamingToolLedgerUpdated, closed)).toEqual([
    { op: "row.upserted", row: expected },
    { op: "state.updated", patch: { revision: before.revision + 1 } },
  ]);
  expect(row()).toEqual(expected);
  expect(projection.getSnapshot().plan).toEqual(before.plan);
  expect(projection.getSnapshot().goal).toEqual(before.goal);
  expect(projection.getSnapshot().control).toEqual(before.control);
  expect(emit(SessionEventType.StreamingToolLedgerUpdated, closed)).toEqual([]);
  emit(SessionEventType.ModelStreaming, { ...raw, kind: "tool_input_delta", delta: "late" });
  emit(SessionEventType.ModelStreaming, raw);
  expect(row()).toEqual(expected);
  expect(raw.toolName).toBe(DEFERRED_TOOL_CALL_NAME);
  for (const client of clients) {
    const frame = publisher.flush(client.subscriptionId);
    if (frame?.payload.kind !== "deltas") throw new Error("expected identity deltas");
    const snapshot = applyConversationDeltas(client.snapshot, frame.payload.deltas);
    expect(snapshot.rows.window.find((item) => item.kind === "toolCall")).toEqual(expected);
  }
});

it.each([
  "ordinary",
  "missing-row",
  "rejected",
  "missing-input",
  "wrong-status",
  "old-turn",
  "mirrored",
  "settled-turn",
  "scheduled",
])("closed identity leaves %s events unchanged", (scenario) => {
  const { emit, closed, row } = createIdentityFixture(scenario === "ordinary" ? "Read" : undefined);
  if (scenario === "settled-turn") emit(SessionEventType.TurnComplete, { result: "success" });
  if (scenario === "scheduled") {
    emit(SessionEventType.ToolCallScheduled, {
      ...closed,
      schedule: { parallelGroups: [[closed.toolCallId]], executionOrder: [closed.toolCallId] },
    });
  }
  const before = row();
  expect(
    emit(
      SessionEventType.StreamingToolLedgerUpdated,
      {
        ...closed,
        ...(scenario === "missing-row" ? { toolCallId: "missing" } : {}),
        ...(scenario === "rejected" ? { toolName: DEFERRED_TOOL_CALL_NAME } : {}),
        ...(scenario === "missing-input" ? { input: undefined } : {}),
        ...(scenario === "wrong-status" ? { status: "tool_started" } : {}),
        ...(scenario === "mirrored" ? { source: "subagent" } : {}),
        ...(scenario === "scheduled" ? { toolName: "different" } : {}),
      },
      scenario === "old-turn" ? "previous-turn" : "turn",
    ),
  ).toEqual([]);
  expect(row()).toEqual(before);
});

it("identity completion preserves an existing tool error", () => {
  const { emit, closed, row } = createIdentityFixture();
  emit(SessionEventType.ToolCallError, {
    toolCallId: closed.toolCallId,
    error: { type: "interrupted", message: "interrupted" },
  });
  const before = row();
  emit(SessionEventType.StreamingToolLedgerUpdated, closed);
  expect(row()).toEqual({
    ...before,
    toolName: closed.toolName,
    input: closed.input,
    inputText: JSON.stringify(closed.input),
  });
  expect(row()).toMatchObject({ status: "error", error: { message: "interrupted" } });
});

it.each(["completed", "in_progress"])("next real input retains session Todo (%s)", (status) => {
  const projection = new ProductProjection("session", "epoch");
  const events: SessionEvent[] = [];
  const apply = (type: SessionEvent["type"], payload: unknown, turnId = "turn") => {
    const sequence = events.length + 1;
    const event = {
      id: `todo-${sequence}`,
      sessionId: "session",
      turnId,
      traceId: "trace",
      timestamp: new Date(1700000000000 + sequence),
      sequenceNumber: sequence,
      type,
      payload,
    } as SessionEvent;
    events.push(event);
    projection.applyEvent(event);
  };
  apply(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "first", messageId: "u1" });
  const write = (id: string, content = "step") =>
    apply(SessionEventType.ToolCallScheduled, {
      toolCallId: id,
      toolName: "TodoWrite",
      input: { todos: [{ content, status, activeForm: "working" }] },
      schedule: { parallelGroups: [[id]], executionOrder: [id] },
    });
  write("todo1");
  expect(projection.getSnapshot().plan?.items).toHaveLength(1);
  write("replacement", "new task before next message");
  expect(projection.getSnapshot().plan?.items.map((item) => item.content)).toEqual([
    "new task before next message",
  ]);
  apply(SessionEventType.TurnComplete, { turnNumber: 1 });
  expect(projection.getSnapshot().plan?.items).toHaveLength(1);
  apply(SessionEventType.TurnStarted, { turnNumber: 2, input: "next", messageId: "u2" }, "turn2");
  expect(projection.getSnapshot().plan?.items).toHaveLength(1);
  const cold = new ProductProjection("session", "epoch");
  cold.beginHydrationReplay();
  for (const event of events) cold.applyHydrationEvent(event);
  cold.completeHydrationReplay();
  expect(cold.getSnapshot().plan).toEqual(projection.getSnapshot().plan);
  write("todo2");
  expect(projection.getSnapshot().plan?.items).toHaveLength(1);
});

it.each(["complete", "active", "paused"])("next input retains session Goal (%s)", (status) => {
  const p = new ProductProjection("session", "epoch");
  const events: SessionEvent[] = [];
  const send = (type: SessionEvent["type"], payload: unknown) => {
    const n = events.length + 1;
    const event = {
      id: `g${n}`,
      sessionId: "session",
      turnId: "turn",
      traceId: "trace",
      timestamp: new Date(1700000000000 + n),
      sequenceNumber: n,
      type,
      payload,
    } as SessionEvent;
    events.push(event);
    p.applyEvent(event);
  };
  const target = {
    sessionID: "session",
    targetID: "goal",
    objective: "Goal history",
    summaryTitle: null,
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 44,
    time: { created: 0, updated: 0 },
  };
  send(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200000 });
  send(SessionEventType.TargetChanged, {
    action: "set",
    source: "command",
    target,
    previousTarget: null,
  });
  expect(p.getSnapshot().goal?.summaryHidden).not.toBe(true);
  send(SessionEventType.TurnStarted, { turnNumber: 1, input: "next", messageId: "u1" });
  expect(p.getSnapshot().goal?.summaryHidden).not.toBe(true);
  expect(p.getSnapshot().goal?.objective).toBe("Goal history");
  const cold = new ProductProjection("session", "epoch");
  cold.beginHydrationReplay();
  events.forEach((e) => cold.applyHydrationEvent(e));
  cold.completeHydrationReplay();
  expect(cold.getSnapshot().goal).toEqual(p.getSnapshot().goal);
  send(SessionEventType.TargetChanged, {
    action: "set",
    source: "command",
    target: { ...target, targetID: "new", status: "active" },
    previousTarget: target,
  });
  expect(p.getSnapshot().goal?.summaryHidden).not.toBe(true);
});

it("activity archives ended details on accepted input and replays the boundary", () => {
  const p = new ProductProjection("session", "epoch");
  const events: SessionEvent[] = [];
  const send = (type: SessionEventType, payload: unknown) => {
    const n = events.length + 1;
    const event = {
      eventId: `activity-${n}`,
      sessionId: "session",
      turnId: "turn",
      traceId: "trace",
      timestamp: new Date(1700000000000 + n),
      sequenceNumber: n,
      type,
      payload,
    } as SessionEvent;
    events.push(event);
    p.applyEvent(event);
  };
  send(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200000 });
  send(SessionEventType.BackgroundTaskStarted, {
    taskId: "bash",
    taskKind: "bash",
    command: "echo test",
    status: "running",
  });
  send(SessionEventType.TurnStarted, { turnNumber: 1, input: "while running", messageId: "u1" });
  expect(p.getSnapshot().activitySummaryDismissed?.workIds).toEqual([]);
  send(SessionEventType.BackgroundTaskCompleted, {
    taskId: "bash",
    taskKind: "bash",
    status: "completed",
  });
  expect(p.getSnapshot().backgroundWorks[0]?.status).toBe("resultPending");
  expect(p.getSnapshot().activitySummaryDismissed?.workIds).toEqual([]);
  const beforeFailure = p.getSnapshot().activitySummaryDismissed;
  send(SessionEventType.TurnError, { error: { message: "send failed" } });
  expect(p.getSnapshot().activitySummaryDismissed).toEqual(beforeFailure);
  send(SessionEventType.BackgroundTaskStarted, {
    taskId: "still-running",
    taskKind: "bash",
    command: "wait",
    status: "running",
  });
  send(SessionEventType.TurnStarted, { turnNumber: 2, input: "next", messageId: "u2" });
  expect(p.getSnapshot().activitySummaryDismissed?.workIds).toEqual(["bash"]);
  const cold = new ProductProjection("session", "epoch");
  cold.beginHydrationReplay();
  events.forEach((e) => cold.applyHydrationEvent(e));
  cold.completeHydrationReplay();
  expect(cold.getSnapshot().activitySummaryDismissed).toEqual(
    p.getSnapshot().activitySummaryDismissed,
  );
});

it.each(["success", "failed", "cancelled"])(
  "ended subagent %s retains result across accepted input, including resume",
  (status) => {
    const p = new ProductProjection("session", "epoch");
    const events: SessionEvent[] = [];
    const send = (type: SessionEventType, payload: unknown) => {
      const n = events.length + 1;
      const event = {
        eventId: `ended-agent-${n}`,
        sessionId: "session",
        turnId: `turn-${n}`,
        traceId: "trace",
        timestamp: new Date(1700000000000),
        sequenceNumber: n,
        type,
        payload,
      } as SessionEvent;
      events.push(event);
      p.applyEvent(event);
    };
    send(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200000 });
    send(SessionEventType.SubagentSpawned, {
      agentId: "agent",
      childSessionId: "child",
      agentType: "Explore",
      description: "Inspect project",
    });
    send(SessionEventType.SubagentStopped, {
      agentId: "agent",
      childSessionId: "child",
      status,
      summaryText: "Actual result",
    });
    expect(p.getSnapshot().subagents?.ended?.[0]).toMatchObject({
      title: "Inspect project",
      summary: "Actual result",
      status,
    });
    send(SessionEventType.TurnStarted, { turnNumber: 1, input: "next", messageId: "u1" });
    expect(p.getSnapshot().subagents?.ended).toHaveLength(1);
    expect(p.getSnapshot().activitySummaryDismissed?.subagentIds).toContain("child");
    // 连续普通输入不得清除会话内的结束结果。
    send(SessionEventType.TurnStarted, { turnNumber: 2, input: "again", messageId: "u2" });
    send(SessionEventType.TurnComplete, { status: "success" });
    expect(p.getSnapshot().subagents?.ended).toHaveLength(1);
    const cleared = new ProductProjection("session", "epoch");
    cleared.beginHydrationReplay();
    events.forEach((event) => cleared.applyHydrationEvent(event));
    cleared.completeHydrationReplay();
    cleared.seedSubagents({ revision: 1, childSessionIds: ["child"], running: [] });
    expect(cleared.getSnapshot().subagents?.ended).toHaveLength(1);
    send(SessionEventType.SubagentSpawned, {
      agentId: "agent",
      childSessionId: "child",
      agentType: "Explore",
      description: "Resume project",
      resumed: true,
    });
    send(SessionEventType.SubagentStopped, {
      agentId: "agent",
      childSessionId: "child",
      status: "success",
      summaryText: "New result",
    });
    expect(p.getSnapshot().subagents?.ended?.[0]?.summary).toBe("New result");
    expect(p.getSnapshot().activitySummaryDismissed?.subagentIds).not.toContain("child");
    const cold = new ProductProjection("session", "epoch");
    cold.beginHydrationReplay();
    events.forEach((event) => cold.applyHydrationEvent(event));
    cold.completeHydrationReplay();
    // 桌面重启先回放事件，再用持久化 child 目录校验；不能在第二步丢掉结束摘要。
    cold.seedSubagents({ revision: 1, childSessionIds: ["child"], running: [] });
    expect(cold.getSnapshot().subagents?.ended).toEqual(p.getSnapshot().subagents?.ended);
    cold.seedSubagents({ revision: 2, childSessionIds: [], running: [] });
    expect(cold.getSnapshot().subagents?.ended).toEqual([]);
  },
);

it.each(["success", "failed", "cancelled"] as const)(
  "cold seed archives older %s results and retains new results",
  (status) => {
    const projection = new ProductProjection("session", "epoch");
    const events: SessionEvent[] = [];
    const apply = (event: SessionEvent) => {
      events.push(event);
      projection.applyEvent(event);
    };
    for (const [type, payload] of [
      [
        SessionEventType.SubagentSpawned,
        { agentId: "agent", childSessionId: "resumed", agentType: "Explore" },
      ],
      [
        SessionEventType.SubagentStopped,
        { agentId: "agent", childSessionId: "resumed", status: "success", summaryText: "Old" },
      ],
    ] as const)
      apply({
        eventId: type,
        sessionId: "session",
        turnId: "old",
        traceId: "trace",
        timestamp: new Date(1000),
        sequenceNumber: 0,
        type,
        payload,
      } as SessionEvent);
    apply({
      eventId: "accepted",
      sessionId: "session",
      turnId: "turn",
      traceId: "trace",
      timestamp: new Date(2000),
      sequenceNumber: 1,
      type: SessionEventType.TurnStarted,
      payload: { turnNumber: 1, input: "next", messageId: "next" },
    } as SessionEvent);
    const ended = subagentProjectionStateSchema.shape.ended.unwrap().parse([
      {
        childSessionId: "resumed",
        subagentType: "Explore",
        title: "Resumed",
        status,
        endedAt: 3000,
      },
      {
        childSessionId: "old",
        subagentType: "Explore",
        title: "Old",
        status,
        endedAt: 1000,
      },
    ]);
    projection.seedSubagents({
      revision: 1,
      childSessionIds: ["resumed", "old"],
      running: [],
      ended,
    });
    expect(projection.getSnapshot().subagents?.ended?.map((item) => item.childSessionId)).toEqual([
      "resumed",
      "old",
    ]);
    expect(projection.getSnapshot().subagents?.ended?.map((item) => item.status)).toEqual([
      status,
      status,
    ]);
    expect(projection.getSnapshot().activitySummaryDismissed?.subagentIds).toContain("old");
    expect(projection.getSnapshot().activitySummaryDismissed?.at).toBe(2000);
    apply({
      eventId: "complete",
      sessionId: "session",
      turnId: "turn",
      traceId: "trace",
      timestamp: new Date(3500),
      sequenceNumber: 2,
      type: SessionEventType.TurnComplete,
      payload: { status: "success" },
    } as SessionEvent);
    expect(projection.getSnapshot().subagents?.ended?.[0]?.endedAt).toBe(3000);
    apply({
      eventId: "clear-again",
      sessionId: "session",
      turnId: "turn2",
      traceId: "trace",
      timestamp: new Date(4000),
      sequenceNumber: 2,
      type: SessionEventType.TurnStarted,
      payload: { turnNumber: 2, input: "clear", messageId: "clear" },
    } as SessionEvent);
    expect(projection.getSnapshot().subagents?.ended).toHaveLength(2);
    projection.seedSubagents({
      revision: 2,
      childSessionIds: ["resumed", "old"],
      running: [],
      ended,
    });
    expect(projection.getSnapshot().subagents?.ended).toHaveLength(2);
    expect(projection.getSnapshot().activitySummaryDismissed?.subagentIds).toEqual(
      expect.arrayContaining(["resumed", "old"]),
    );
    expect(projection.getSnapshot().activitySummaryDismissed?.at).toBe(4000);
    const cold = new ProductProjection("session", "epoch");
    cold.beginHydrationReplay();
    events.forEach((event) => cold.applyHydrationEvent(event));
    cold.completeHydrationReplay();
    cold.seedSubagents({ revision: 2, childSessionIds: ["resumed", "old"], running: [], ended });
    expect(cold.getSnapshot().subagents?.ended).toEqual(projection.getSnapshot().subagents?.ended);
    expect(cold.getSnapshot().activitySummaryDismissed).toEqual(
      projection.getSnapshot().activitySummaryDismissed,
    );
  },
);

it.each(["completed", "stopped", "errored"])(
  "resumed workflow retains its new %s result alongside session siblings",
  (status) => {
    const projection = new ProductProjection("session", "epoch");
    const events: SessionEvent[] = [];
    const send = (type: SessionEventType, payload: unknown) => {
      const n = events.length + 1;
      const event = {
        eventId: `workflow-${n}`,
        sessionId: "session",
        turnId: "turn",
        traceId: "trace",
        timestamp: new Date(1700000000000 + n),
        sequenceNumber: n,
        type,
        payload,
      } as SessionEvent;
      events.push(event);
      projection.applyEvent(event);
    };
    const progress = (runId: string, sequence: number, eventType: string, payload: unknown) =>
      send(SessionEventType.DynamicWorkflowRunProgress, {
        runId,
        toolCallId: runId,
        sequence,
        eventType,
        payload,
      });
    send(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200000 });
    for (const runId of ["resumed", "sibling"]) {
      progress(runId, 0, "run-started", { runId, caps: { maxConcurrency: 1 } });
      progress(runId, 1, "run-settled", { status: "stopped", stopReason: "interrupted" });
    }
    send(SessionEventType.TurnStarted, { turnNumber: 1, input: "resume", messageId: "u1" });
    expect(projection.getSnapshot().activitySummaryDismissed?.workflowRunIds).toEqual([
      "resumed",
      "sibling",
    ]);
    progress("resumed", 1, "run-settled", { status: "stopped", stopReason: "interrupted" });
    progress("resumed", 2, "run-started", { runId: "resumed", caps: { maxConcurrency: 1 } });
    progress("resumed", 3, "run-settled", { status });
    expect(
      projection.getSnapshot().workflowRuns?.runs.find((run) => run.runId === "resumed")?.status,
    ).toBe(status);
    expect(projection.getSnapshot().activitySummaryDismissed?.workflowRunIds).toEqual(["sibling"]);
    const cold = new ProductProjection("session", "epoch");
    cold.beginHydrationReplay();
    events.forEach((event) => cold.applyHydrationEvent(event));
    cold.completeHydrationReplay();
    expect(cold.getSnapshot().activitySummaryDismissed).toEqual(
      projection.getSnapshot().activitySummaryDismissed,
    );
    expect(cold.getSnapshot().workflowRuns).toEqual(projection.getSnapshot().workflowRuns);
    send(SessionEventType.TurnStarted, { turnNumber: 2, input: "clear", messageId: "u2" });
    expect(projection.getSnapshot().workflowRuns?.runs).toHaveLength(2);
  },
);

// 旧会话没有清除时间时，全部长结果曾进入快照并触发 16 MiB 逻辑帧拒绝。
it.each(["continuous", "replayable"] as const)(
  "bounds cold subagent outcomes for %s subscription and reconnect",
  (deliveryProfile) => {
    const publisher = new ConversationTopicPublisher("session", "epoch");
    const ended = Array.from({ length: 180 }, (_, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "Explore",
      title: "标题".repeat(500),
      summary: "结果".repeat(40000),
      status: "success" as const,
      endedAt: index + 1,
    }));
    expect(Buffer.byteLength(JSON.stringify(ended))).toBeGreaterThan(16 * 1024 * 1024);
    publisher.seedSubagents({
      revision: 1,
      childSessionIds: ended.map((item) => item.childSessionId),
      running: [],
      ended,
    });
    for (const connectionId of ["initial", "reconnected"]) {
      const { frame } = publisher.subscribe({ connectionId, deliveryProfile });
      if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      const state = frame.payload.snapshot.subagents!;
      expect(() =>
        encodeTopicWireFrames(frame, {
          deliveryKind: connectionId === "initial" ? "initial" : "recovery",
          topic: "conversation/session",
          subscriptionId: connectionId,
          logicalFrameId: connectionId,
          logicalFrameOrdinal: 1,
          measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
        }),
      ).not.toThrow();
      expect(state.endedTotal).toBe(180);
      expect(frame.payload.snapshot.completedActivityCount).toBe(180);
      expect(state.childSessionIds).toHaveLength(180);
      expect(state.ended).toHaveLength(100);
      expect(state.ended?.[0]?.childSessionId).toBe("child-179");
      expect(
        state.ended?.every((item) => item.summary!.length <= 4096 && item.title.length <= 256),
      ).toBe(true);
    }
    // 容量裁剪不可修改供历史目录使用的原始结果。
    expect(ended[0]!.summary).toHaveLength(80000);
  },
);

it("retains a bounded session preview across messages and resumed children", () => {
  const projection = new ProductProjection("session", "epoch");
  const events: SessionEvent[] = [];
  const send = (type: SessionEventType, payload: unknown) => {
    const n = events.length + 1;
    const event = {
      eventId: `bounded-${n}`,
      sessionId: "session",
      turnId: "turn",
      traceId: "trace",
      timestamp: new Date(n * 1000),
      sequenceNumber: n,
      type,
      payload,
    } as SessionEvent;
    events.push(event);
    projection.applyEvent(event);
  };
  for (let index = 0; index < 105; index += 1) {
    send(SessionEventType.SubagentSpawned, {
      agentId: `agent-${index}`,
      childSessionId: `child-${index}`,
      agentType: "Explore",
      description: "Inspect",
    });
    send(SessionEventType.SubagentStopped, {
      agentId: `agent-${index}`,
      childSessionId: `child-${index}`,
      status: "success",
      summaryText: "Result".repeat(1000),
    });
  }
  expect(projection.getSnapshot().subagents?.ended).toHaveLength(100);
  expect(projection.getSnapshot().subagents?.endedTotal).toBe(105);
  expect(projection.getSnapshot().completedActivityCount).toBe(105);
  expect(projection.getSnapshot().subagents?.ended?.[0]?.childSessionId).toBe("child-104");
  send(SessionEventType.TurnStarted, { turnNumber: 1, input: "next", messageId: "next" });
  expect(projection.getSnapshot().subagents?.ended).toHaveLength(100);
  expect(projection.getSnapshot().activitySummaryDismissed?.subagentIds).toHaveLength(105);
  // 新执行更新同一 child，结束预览仍受容量上限约束。
  send(SessionEventType.SubagentSpawned, {
    agentId: "agent-0",
    childSessionId: "child-0",
    agentType: "Explore",
    description: "Resume",
  });
  expect(projection.getSnapshot().subagents?.ended).toHaveLength(100);
  send(SessionEventType.SubagentStopped, {
    agentId: "agent-0",
    childSessionId: "child-0",
    status: "success",
    summaryText: "Resumed result",
  });
  expect(projection.getSnapshot().subagents?.ended).toHaveLength(100);
  expect(projection.getSnapshot().subagents?.ended?.[0]?.childSessionId).toBe("child-0");
  const cold = new ProductProjection("session", "epoch");
  for (const event of events) cold.applyEvent(event);
  expect(cold.getSnapshot().subagents).toEqual(projection.getSnapshot().subagents);
  expect(cold.getSnapshot().completedActivityCount).toBe(
    projection.getSnapshot().completedActivityCount,
  );
});

// 成功总数不能取自只保留最近 8 条的 run 预览；索引属于原子投影事务。
it("counts workflow history beyond previews without duplicate or rejected updates", () => {
  const projection = new ProductProjection("session", "epoch");
  const events: SessionEvent[] = [];
  const event = (runId: string, sequence: number, eventType: string) =>
    ({
      id: `event-${events.length + 1}`,
      sessionId: "session",
      traceId: "trace",
      timestamp: new Date(),
      sequenceNumber: events.length + 1,
      type: SessionEventType.DynamicWorkflowRunProgress,
      payload: {
        runId,
        sequence,
        eventType: eventType === "run-started" ? eventType : "run-settled",
        payload: eventType === "run-started" ? {} : { status: eventType.slice(4) },
      },
    }) as SessionEvent;
  const send = (runId: string, sequence: number, eventType: string) => {
    const next = event(runId, sequence, eventType);
    events.push(next);
    projection.applyEventAtomically(next, () => true);
  };
  for (let i = 0; i < 9; i++) {
    send(`run-${i}`, 1, "run-started");
    send(`run-${i}`, 2, "run-completed");
  }
  expect(projection.getSnapshot().workflowRuns?.runs).toHaveLength(8);
  expect(projection.getSnapshot().completedActivityCount).toBe(9);
  send("failed", 1, "run-started");
  send("failed", 2, "run-failed");
  send("stopped", 1, "run-started");
  send("stopped", 2, "run-stopped");
  send("run-0", 2, "run-completed");
  send("run-0", 1, "run-started");
  expect(projection.getSnapshot().completedActivityCount).toBe(9);
  expect(projection.applyEventAtomically(event("run-0", 3, "run-started"), () => false)).toBeNull();
  expect(projection.getSnapshot().completedActivityCount).toBe(9);
  send("run-0", 3, "run-started");
  expect(projection.getSnapshot().completedActivityCount).toBe(8);
  send("run-0", 4, "run-completed");
  expect(projection.getSnapshot().completedActivityCount).toBe(9);
  const cold = new ProductProjection("session", "epoch");
  for (const next of events) cold.applyEvent(next);
  expect(cold.getSnapshot().completedActivityCount).toBe(9);
  expect(new ProductProjection("other", "epoch").getSnapshot().completedActivityCount).toBe(0);
});

it.each(["continuous", "replayable"] as const)(
  "cold complete history survives %s snapshots and reconnect",
  (deliveryProfile) => {
    const publisher = new ConversationTopicPublisher("session", "epoch");
    publisher.seedSubagents(undefined, {
      runs: Array.from({ length: 11 }, (_, i) => ({
        runId: `run-${i}`,
        status: i < 9 ? "completed" : "stopped",
        sequence: 4,
      })),
      childSessionIds: ["actor"],
    });
    const ended = Array.from({ length: 106 }, (_, i) => ({
      childSessionId: i === 105 ? "actor" : `child-${i}`,
      subagentType: "Explore",
      title: "done",
      status: "success" as const,
      endedAt: 1,
    }));
    publisher.seedSubagents({
      revision: 1,
      childSessionIds: ended.map((x) => x.childSessionId),
      running: [],
      ended,
    });
    for (const connectionId of ["initial", "reconnected"]) {
      const { frame } = publisher.subscribe({ connectionId, deliveryProfile });
      if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(frame.payload.snapshot.completedActivityCount).toBe(114);
      expect(frame.payload.snapshot.subagents?.ended).toHaveLength(100);
    }
  },
);

it.each([false, true])(
  "newer cold history count does not swallow buffered preview completion (existing=%s)",
  (existing) => {
    const projection = new ProductProjection("session", "epoch");
    const progress = (sequence: number, eventType: string, payload: unknown) =>
      ({
        id: `buffer-${sequence}`,
        sessionId: "session",
        traceId: "trace",
        timestamp: new Date(),
        sequenceNumber: sequence + 1,
        type: SessionEventType.DynamicWorkflowRunProgress,
        payload: { runId: "run", sequence, eventType, payload },
      }) as SessionEvent;
    if (existing) projection.applyEvent(progress(0, "run-started", {}));
    projection.seedWorkflowActivityHistory({
      runs: [{ runId: "run", status: "completed", sequence: 2 }],
      childSessionIds: [],
    });
    projection.applyEvent(
      progress(1, "node-queued", { instance: { siteId: "ask", ordinal: 1 }, kind: "ask" }),
    );
    expect(projection.getSnapshot().completedActivityCount).toBe(1);
    projection.applyEvent(progress(2, "run-settled", { status: "completed" }));
    expect(projection.getSnapshot().workflowRuns?.runs[0]?.status).toBe("completed");
    expect(projection.getSnapshot().completedActivityCount).toBe(1);
    projection.seedWorkflowActivityHistory({
      runs: [{ runId: "run", status: "running", sequence: 1 }],
      childSessionIds: [],
    });
    expect(projection.getSnapshot().completedActivityCount).toBe(1);
  },
);

it.each(["continuous", "replayable"] as const)(
  "unknown total survives live events and reconnect until a complete seed (%s)",
  (deliveryProfile) => {
    const publisher = new ConversationTopicPublisher("session", "epoch");
    publisher.seedSubagents(undefined, null);
    publisher.ingest({
      id: "done",
      sessionId: "session",
      traceId: "trace",
      timestamp: new Date(),
      sequenceNumber: 1,
      type: SessionEventType.DynamicWorkflowRunProgress,
      payload: {
        runId: "run",
        sequence: 1,
        eventType: "run-settled",
        payload: { status: "completed" },
      },
    } as SessionEvent);
    for (const connectionId of ["first", "reconnect"]) {
      const { frame } = publisher.subscribe({ connectionId, deliveryProfile });
      if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(frame.payload.snapshot.completedActivityCount).toBeNull();
      expect(frame.payload.snapshot.workflowRuns?.runs[0]?.status).toBe("completed");
    }
    publisher.seedSubagents(undefined, {
      runs: [{ runId: "run", sequence: 1, status: "completed" }],
      childSessionIds: [],
    });
    const { frame } = publisher.subscribe({ connectionId: "recovered", deliveryProfile });
    if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
    expect(frame.payload.snapshot.completedActivityCount).toBe(1);
  },
);

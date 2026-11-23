// 原子事件事务的回归契约（docs/v4-refactor/02-projection.md「原子事件事务」）。
//
// 钉住四件事，前两条对投影的全部字段通用（新增字段自动纳入比较）：
// 1. 拒绝、accept 抛错、归约中途抛错、某张共享表回滚抛错时，投影的每个字段（含 Map / Set 的迭代顺序）
//    与调用前完全相同。rowIdForMessageId 等按插入顺序取第一个匹配，顺序变化也是行为变化。
// 2. 接受时，状态与 delta 和直接 applyEvent 完全相同。
// 3. 每一步之后，十一张共享大侧表都仍是 TransactionalMap，且没有残留的事务（JSON 比较看不出这两点：
//    表悄悄退回整份复制只是变慢，残留事务会让之后每个事件都失败）。
// 4. 冷恢复（批量 hydration）之后的第一个原子事件同样满足以上三条。
// 事件序列覆盖大侧表的新增、改写已有键（compact 覆盖边界）与删除（rewind）：开轮、文本/推理/工具流、
// 权限、文件改动、compact、rewind。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { ConversationTopicPublisher, ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { TransactionalMap } from "../src/zcode-protocol-v4/product-projection.js";

const BASE_TIMESTAMP_MS = 1_700_000_000_000;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const INJECTED_FAILURE = "injected reducer failure";
const INJECTED_ROLLBACK_FAILURE = "injected rollback failure";
// 与 cloneProjection 里共享的字段一一对应（docs/v4-refactor/02-projection.md「原子事件事务」）。
const SHARED_SIDE_TABLES = [
  "rowIndexById",
  "toolRowIdByCallId",
  "messageIdByRowId",
  "entityIdByRowId",
  "editTargetByEntityId",
  "turnHeaderRowIdByTurnId",
  "productTurnIdByRuntimeTurnId",
  "runtimeTurnIdByProductTurnId",
  "subagentOutcomeByChildId",
  "workflowOutcomeByRunId",
  "workflowChildSessionIds",
] as const;

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(type: SessionEventTypeUnion, payload: unknown, turnId?: string): void {
    this.seq += 1;
    this.events.push({
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: turnId as TurnId | undefined,
      type,
      timestamp: new Date(BASE_TIMESTAMP_MS + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    });
  }
}

function stream(log: EventLog, turnId: string, payload: Record<string, unknown>): void {
  log.push(SessionEventType.ModelStreaming, { delta: "", done: false, ...payload }, turnId);
}

function pushTextTurn(log: EventLog, turn: number, withFiles: boolean): void {
  const turnId = `turn-${turn}`;
  log.push(
    SessionEventType.TurnStarted,
    { turnNumber: turn, input: `问题 ${turn}`, messageId: `message-user-${turn}` },
    turnId,
  );
  stream(log, turnId, { kind: "reasoning_start", assistantMessageId: `message-assistant-${turn}` });
  stream(log, turnId, { kind: "reasoning_delta", delta: `思考 ${turn}` });
  stream(log, turnId, { kind: "text_start", assistantMessageId: `message-assistant-${turn}` });
  stream(log, turnId, { kind: "text_delta", delta: `回答 ${turn}` });
  stream(log, turnId, { kind: "text_end" });
  log.push(
    SessionEventType.ModelComplete,
    {
      content: `回答 ${turn}`,
      stopReason: "end_turn",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: USAGE,
      ...(withFiles
        ? {
            fileChanges: {
              files: 1,
              additions: 2,
              deletions: 1,
              items: [{ path: `/work/${turn}.ts`, additions: 2, deletions: 1, writeCount: 1 }],
            },
          }
        : {}),
    },
    turnId,
  );
  log.push(
    SessionEventType.TurnComplete,
    {
      response: `回答 ${turn}`,
      tokenCount: 1,
      toolCallCount: 0,
      duration: 1,
      resultType: "success",
    },
    turnId,
  );
}

function pushToolTurn(log: EventLog, turn: number): void {
  const turnId = `turn-${turn}`;
  const toolCallId = `tool-write-${turn}`;
  log.push(
    SessionEventType.TurnStarted,
    { turnNumber: turn, input: `改文件 ${turn}`, messageId: `message-user-${turn}` },
    turnId,
  );
  stream(log, turnId, { kind: "text_start", assistantMessageId: `message-assistant-${turn}` });
  stream(log, turnId, { kind: "text_delta", delta: "先改文件。" });
  stream(log, turnId, { kind: "tool_input_start", toolCallId, toolName: "Write" });
  stream(log, turnId, {
    kind: "tool_input_delta",
    toolCallId,
    delta: '{"file_path":"/work/a.ts",',
  });
  stream(log, turnId, { kind: "tool_input_delta", toolCallId, delta: '"content":"a"}' });
  log.push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId,
      toolName: "Write",
      input: { file_path: "/work/a.ts", content: "a" },
      schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
    },
    turnId,
  );
  log.push(
    SessionEventType.PermissionRequested,
    {
      requestId: `request-${turn}`,
      toolCallId,
      toolName: "Write",
      riskLevel: "medium",
      reason: "Write file",
      input: { file_path: "/work/a.ts", content: "a" },
    },
    turnId,
  );
  log.push(
    SessionEventType.PermissionResolved,
    { requestId: `request-${turn}`, toolCallId, decision: "allow" },
    turnId,
  );
  log.push(
    SessionEventType.ToolCallStarted,
    { toolCallId, toolName: "Write", startedAt: new Date(BASE_TIMESTAMP_MS) },
    turnId,
  );
  log.push(
    SessionEventType.ToolCallResult,
    { toolCallId, result: { success: true, content: "ok" }, duration: 5 },
    turnId,
  );
  stream(log, turnId, { kind: "text_start", assistantMessageId: `message-assistant-${turn}-b` });
  stream(log, turnId, { kind: "text_delta", delta: "改好了。" });
  stream(log, turnId, { kind: "text_end" });
  log.push(
    SessionEventType.ModelComplete,
    {
      content: "改好了。",
      stopReason: "end_turn",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: USAGE,
      fileChanges: {
        files: 1,
        additions: 1,
        deletions: 0,
        items: [{ path: "/work/a.ts", additions: 1, deletions: 0, writeCount: 1 }],
      },
    },
    turnId,
  );
  log.push(
    SessionEventType.TurnComplete,
    { response: "改好了。", tokenCount: 1, toolCallCount: 1, duration: 1, resultType: "success" },
    turnId,
  );
}

function sessionEvents(): SessionEvent[] {
  const log = new EventLog();
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  pushTextTurn(log, 1, true);
  pushToolTurn(log, 2);
  pushTextTurn(log, 3, false);
  log.push(SessionEventType.CompactStarted, {
    operationId: "compact-1",
    messageId: "message-compact-1",
    status: "started",
    trigger: "manual",
    display: "separator",
  });
  log.push(SessionEventType.CompactCompleted, {
    operationId: "compact-1",
    messageId: "message-compact-1",
    status: "completed",
    trigger: "manual",
    display: "separator",
    preCompactTokenCount: 150,
    postCompactTokenCount: 50,
    // 覆盖边界落在第 3 轮：已登记的 edit target 被整体替换为 coveredByStableCompact（改写已有键）。
    tailStartMessageId: "message-user-3",
  });
  pushTextTurn(log, 4, true);
  // rewind 删除第 2 轮起的行，以及大侧表里这些行已有的键（含工具索引）。
  log.push(SessionEventType.RewindTriggered, {
    targetMessageId: "message-assistant-2",
    scope: "conversation",
    createdMessageId: "message-rewind-notice",
  });
  pushTextTurn(log, 5, false);
  return log.events;
}

/** 投影全部字段的结构化快照：Map / Set 按迭代顺序展开，对象保留键序。 */
function stateOf(projection: ProductProjection): string {
  return JSON.stringify(projection, (_key, value: unknown) => {
    if (value instanceof Map) return { map: [...value.entries()] };
    if (value instanceof Set) return { set: [...value.values()] };
    return value;
  });
}

function injectReducerFailureOnce(): void {
  // 归约已写完大侧表之后才抛错，用来证明中途失败也会整体回滚。
  vi.spyOn(
    ProductProjection.prototype as unknown as { updateToolIndexesAfterDeltas: () => void },
    "updateToolIndexesAfterDeltas",
  ).mockImplementationOnce(() => {
    throw new Error(INJECTED_FAILURE);
  });
}

const originalRollback = TransactionalMap.prototype.rollbackTransaction;

function injectRollbackFailureOnce(): void {
  // 第一张共享表（rowIndexById）照常回滚后再抛错：其余表必须仍被回滚、事务全部关闭。
  vi.spyOn(TransactionalMap.prototype, "rollbackTransaction").mockImplementationOnce(
    function (this: TransactionalMap<unknown, unknown>) {
      originalRollback.call(this);
      throw new Error(INJECTED_ROLLBACK_FAILURE);
    },
  );
}

/** 错误本身及 AggregateError 里各子错误的 message。 */
function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((inner: unknown) => errorMessages(inner))];
  }
  return error instanceof Error ? [error.message] : [String(error)];
}

/** 十一张共享大侧表都是 TransactionalMap，且没有残留事务（还开着时 beginTransaction 会抛错）。 */
function expectSharedSideTablesReady(projection: ProductProjection, label: string): void {
  const fields = projection as unknown as Record<string, unknown>;
  for (const name of SHARED_SIDE_TABLES) {
    const table = fields[name];
    expect(table, `${label}：${name}`).toBeInstanceOf(TransactionalMap);
    const map = table as TransactionalMap<unknown, unknown>;
    expect(() => map.beginTransaction(), `${label}：${name} 有残留事务`).not.toThrow();
    map.rollbackTransaction();
  }
}

/** 对一个事件依次拒绝、accept 抛错、归约抛错、回滚抛错，最后接受，并与直接 applyEvent 的参考投影比较。 */
function assertAtomicEvent(
  projection: ProductProjection,
  reference: ProductProjection,
  event: SessionEvent,
): void {
  const label = `${event.sequenceNumber} ${event.type}`;
  const before = stateOf(projection);

  expect(
    projection.applyEventAtomically(event, () => false),
    label,
  ).toBeNull();
  expect(stateOf(projection), `${label} 拒绝后`).toBe(before);
  expectSharedSideTablesReady(projection, `${label} 拒绝后`);

  expect(
    () =>
      projection.applyEventAtomically(event, () => {
        throw new Error("accept failure");
      }),
    label,
  ).toThrow("accept failure");
  expect(stateOf(projection), `${label} accept 抛错后`).toBe(before);
  expectSharedSideTablesReady(projection, `${label} accept 抛错后`);

  injectReducerFailureOnce();
  expect(() => projection.applyEventAtomically(event, () => true), label).toThrow(INJECTED_FAILURE);
  expect(stateOf(projection), `${label} 归约抛错后`).toBe(before);
  expectSharedSideTablesReady(projection, `${label} 归约抛错后`);

  injectRollbackFailureOnce();
  let rollbackFailure: unknown;
  try {
    projection.applyEventAtomically(event, () => false);
  } catch (error) {
    rollbackFailure = error;
  }
  expect(errorMessages(rollbackFailure), `${label} 回滚抛错`).toContain(INJECTED_ROLLBACK_FAILURE);
  expect(stateOf(projection), `${label} 回滚抛错后`).toBe(before);
  expectSharedSideTablesReady(projection, `${label} 回滚抛错后`);

  const accepted = projection.applyEventAtomically(event, () => true);
  const direct = reference.applyEvent(event);
  expect(accepted, label).toEqual(direct);
  expect(stateOf(projection), `${label} 接受后`).toBe(stateOf(reference));
  expectSharedSideTablesReady(projection, `${label} 接受后`);
}

function hydrate(projection: ProductProjection, events: readonly SessionEvent[]): void {
  projection.beginHydrationReplay();
  for (const event of events) projection.applyHydrationEvent(event);
  projection.completeHydrationReplay();
}

describe("ProductProjection 原子事件事务", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("拒绝、accept 抛错、归约抛错、回滚抛错都不留下任何痕迹；接受时与直接 applyEvent 相同", () => {
    const events = sessionEvents();
    const projection = new ProductProjection("session-1", "epoch-1");
    const reference = new ProductProjection("session-1", "epoch-1");
    expectSharedSideTablesReady(projection, "初始");

    for (const event of events) assertAtomicEvent(projection, reference, event);

    // 序列确实走到了 compact 覆盖与 rewind：有 edit target 被改写为已覆盖，第 2、3、4 轮的行已被移除。
    const editTargets = (
      projection as unknown as {
        editTargetByEntityId: Map<string, { coveredByStableCompact?: boolean }>;
      }
    ).editTargetByEntityId;
    expect([...editTargets.values()].some((target) => target.coveredByStableCompact)).toBe(true);
    const turnIds = new Set(projection.getSnapshot().rows.window.map((row) => row.turnId));
    expect(turnIds.has("message-user-1")).toBe(true);
    expect(turnIds.has("message-user-2")).toBe(false);
    expect(turnIds.has("message-user-3")).toBe(false);
    expect(turnIds.has("message-user-4")).toBe(false);
    expect(turnIds.has("message-user-5")).toBe(true);
  });

  it("冷恢复之后的原子事件同样满足事务契约", () => {
    const events = sessionEvents();
    // 冷恢复前两轮，其余（第 3 轮起，含 compact、rewind）走 live 原子路径。
    const split = events.findIndex(
      (event) =>
        event.type === SessionEventType.TurnStarted &&
        (event.payload as { turnNumber?: number }).turnNumber === 3,
    );
    expect(split).toBeGreaterThan(0);
    const projection = new ProductProjection("session-1", "epoch-1");
    const reference = new ProductProjection("session-1", "epoch-1");
    hydrate(projection, events.slice(0, split));
    hydrate(reference, events.slice(0, split));
    expect(stateOf(projection)).toBe(stateOf(reference));
    expectSharedSideTablesReady(projection, "冷恢复完成后");

    for (const event of events.slice(split)) assertAtomicEvent(projection, reference, event);
  });
});

// 万级历史只作为计数种子，不制造万行 UI；锁定真实原子路径的索引访问成本。
describe("Activity 完整历史事务", () => {
  afterEach(() => vi.restoreAllMocks());

  function seed(projection: ProductProjection, size: number) {
    projection.seedSubagents({
      revision: 1,
      childSessionIds: Array.from({ length: size }, (_, i) => `child-${i}`),
      running: [],
      ended: Array.from({ length: size }, (_, i) => ({
        childSessionId: `child-${i}`,
        subagentType: "Explore",
        title: "done",
        status: "success" as const,
        endedAt: 1,
      })),
    });
    projection.seedWorkflowActivityHistory({
      runs: Array.from({ length: size }, (_, i) => ({
        runId: `run-${i}`,
        status: "completed" as const,
        sequence: 2,
      })),
      childSessionIds: Array.from({ length: size / 2 }, (_, i) => `child-${i}`),
    });
  }

  function progress(
    sequence: number,
    eventType: string,
    payload: unknown = {},
    actorSessionId?: string,
  ): SessionEvent {
    return {
      id: `progress-${sequence}`,
      sessionId: "session-1",
      traceId: "trace-1",
      timestamp: new Date(BASE_TIMESTAMP_MS + sequence),
      sequenceNumber: sequence,
      type: SessionEventType.DynamicWorkflowRunProgress,
      payload: {
        runId: "run-0",
        sequence,
        eventType,
        payload,
        ...(actorSessionId ? { actorSessionId } : {}),
      },
    } as SessionEvent;
  }

  it.each(["continuous", "replayable"] as const)(
    "%s publisher 的文本和工具流不扫描或重写完整历史",
    (deliveryProfile) => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const projection = (publisher as unknown as { projection: ProductProjection }).projection;
      seed(projection, 10_000);
      publisher.seedSubagents();
      publisher.subscribe({ connectionId: "live", deliveryProfile });
      const table = (projection as unknown as { subagentOutcomeByChildId: Map<string, unknown> })
        .subagentOutcomeByChildId;
      for (const method of [
        Symbol.iterator,
        "entries",
        "values",
        "keys",
        "forEach",
        "set",
      ] as const) {
        vi.spyOn(table, method).mockImplementation(() => {
          throw new Error(`无关流访问历史: ${String(method)}`);
        });
      }
      const log = new EventLog();
      pushTextTurn(log, 1, false);
      pushToolTurn(log, 2);
      for (const event of log.events.filter(
        (event) =>
          event.type !== SessionEventType.PermissionRequested &&
          event.type !== SessionEventType.PermissionResolved,
      ))
        publisher.ingest(event);
      const { frame } = publisher.subscribe({ connectionId: "reconnect", deliveryProfile });
      if (frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(frame.payload.snapshot.completedActivityCount).toBe(15_000);
      expect(frame.payload.snapshot.rows.window.some((row) => row.kind === "assistantText")).toBe(
        true,
      );
    },
  );

  it.each(["continuous", "replayable"] as const)(
    "%s 预览外结果变化发布完整数量，拒绝候选不污染重连",
    (deliveryProfile) => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const projection = (publisher as unknown as { projection: ProductProjection }).projection;
      const log = new EventLog();
      for (let i = 0; i < 101; i++) {
        log.push(SessionEventType.SubagentSpawned, {
          agentId: `agent-${i}`,
          childSessionId: `child-${i}`,
          agentType: "Explore",
          description: "inspect",
        });
        log.push(SessionEventType.SubagentStopped, {
          agentId: `agent-${i}`,
          childSessionId: `child-${i}`,
          status: i === 0 ? "failed" : "success",
          summaryText: "done",
        });
      }
      for (const event of log.events) publisher.ingest(event);
      const subscription = publisher.subscribe({ connectionId: "live", deliveryProfile });
      expect(subscription.frame?.payload.kind).toBe("snapshot");
      const before = projection.getSnapshot();
      expect(before.completedActivityCount).toBe(100);
      log.push(SessionEventType.SubagentStopped, {
        agentId: "agent-0",
        childSessionId: "child-0",
        status: "success",
        summaryText: "done",
      });
      // 合法更正仍早于第二项，保证更新对象留在最近 100 条之外。
      const event = { ...log.events.at(-1)!, timestamp: new Date(BASE_TIMESTAMP_MS + 2500) };
      expect(projection.applyEventAtomically(event, () => false)).toBeNull();
      expect(projection.getSnapshot()).toEqual(before);
      expect(() =>
        projection.applyEventAtomically(event, () => {
          throw new Error("reject");
        }),
      ).toThrow("reject");
      expect(projection.getSnapshot()).toEqual(before);
      publisher.ingest(event);
      expect(projection.getSnapshot().subagents).toEqual(before.subagents);
      const frame = publisher.flush(subscription.ack.subscriptionId);
      if (frame?.payload.kind !== "deltas") throw new Error("expected deltas");
      expect(frame.payload.deltas).toContainEqual(
        expect.objectContaining({
          op: "state.updated",
          patch: expect.objectContaining({ completedActivityCount: 101 }),
        }),
      );
      const reconnect = publisher.subscribe({ connectionId: "reconnect", deliveryProfile }).frame;
      if (reconnect?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(reconnect.payload.snapshot.completedActivityCount).toBe(101);
    },
  );

  it.each(["continuous", "replayable"] as const)(
    "%s 普通 Bash 生命周期不读取完整 child 历史",
    (deliveryProfile) => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const projection = (publisher as unknown as { projection: ProductProjection }).projection;
      seed(projection, 10_000);
      publisher.seedSubagents();
      const subscription = publisher.subscribe({ connectionId: "live", deliveryProfile });
      expect(subscription.frame?.payload.kind).toBe("snapshot");
      const table = (projection as unknown as { subagentOutcomeByChildId: Map<string, unknown> })
        .subagentOutcomeByChildId;
      for (const method of [
        Symbol.iterator,
        "entries",
        "keys",
        "values",
        "forEach",
        "set",
      ] as const)
        vi.spyOn(table, method).mockImplementation(() => {
          throw new Error("Bash 扫描 child 历史");
        });
      const log = new EventLog();
      log.push(SessionEventType.BackgroundTaskStarted, {
        taskId: "bash",
        toolName: "Bash",
        status: "running",
      });
      log.push(SessionEventType.BackgroundTaskCompleted, {
        taskId: "bash",
        toolName: "Bash",
        status: "completed",
      });
      for (const event of log.events) publisher.ingest(event);
      const reconnect = publisher.subscribe({ connectionId: "reconnect", deliveryProfile }).frame;
      if (reconnect?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(reconnect.payload.snapshot.backgroundWorks[0]?.status).toBe("resultPending");
      expect(reconnect.payload.snapshot.completedActivityCount).toBe(15_000);
    },
  );

  it("真实 child 阻塞与解除仍更新摘要，同身份其他后台任务不误解除", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    const send = (type: SessionEventTypeUnion, payload: unknown) => {
      log.push(type, payload);
      projection.applyEventAtomically(log.events.at(-1)!, () => true);
    };
    send(SessionEventType.SubagentSpawned, {
      agentId: "agent",
      childSessionId: "child",
      agentType: "Explore",
      description: "inspect",
    });
    for (const taskId of ["a", "b"])
      send(SessionEventType.BackgroundTaskStarted, {
        taskId,
        toolName: "Agent",
        taskKind: "subagent",
        childSessionId: "child",
        status: "running",
        blocked: true,
      });
    expect(projection.getSnapshot().subagents?.running[0]?.status).toBe("blocked");
    send(SessionEventType.BackgroundTaskCompleted, {
      taskId: "a",
      toolName: "Agent",
      status: "completed",
    });
    expect(projection.getSnapshot().subagents?.running[0]?.status).toBe("blocked");
    send(SessionEventType.BackgroundTaskUpdated, {
      taskId: "b",
      toolName: "Agent",
      status: "running",
      blocked: false,
    });
    expect(projection.getSnapshot().subagents?.running[0]?.status).toBe("running");
  });

  it("一万项历史下普通节点、结算与 actor 归属变化不遍历完整索引", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    seed(projection, 10_000);
    expect(projection.getSnapshot().completedActivityCount).toBe(15_000);
    const tables = projection as unknown as Record<string, Map<unknown, unknown>>;
    for (const name of SHARED_SIDE_TABLES.slice(-3)) {
      const table = tables[name]!;
      for (const method of [Symbol.iterator, "entries", "values", "keys", "forEach"] as const) {
        vi.spyOn(table, method).mockImplementation(() => {
          throw new Error(`完整索引被遍历: ${name}`);
        });
      }
    }
    for (let seq = 3; seq < 1003; seq++) {
      projection.applyEventAtomically(
        progress(seq, "node-queued", { instance: { siteId: "ask", ordinal: 1 }, kind: "ask" }),
        () => true,
      );
    }
    expect(projection.getSnapshot().completedActivityCount).toBe(15_000);
    projection.applyEventAtomically(progress(1003, "run-started"), () => true);
    expect(projection.getSnapshot().completedActivityCount).toBe(14_999);
    projection.applyEventAtomically(
      progress(
        1004,
        "node-queued",
        { instance: { siteId: "ask", ordinal: 1 }, kind: "ask" },
        "child-9999",
      ),
      () => true,
    );
    expect(projection.getSnapshot().completedActivityCount).toBe(14_998);
    projection.applyEventAtomically(
      progress(1005, "run-settled", { status: "completed" }),
      () => true,
    );
    expect(projection.getSnapshot().completedActivityCount).toBe(14_999);
  });

  it.each(["continuous", "replayable"] as const)(
    "%s 主代理审批不扫描历史，child 多审批仅按等待身份变化物化",
    (deliveryProfile) => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const projection = (publisher as unknown as { projection: ProductProjection }).projection;
      seed(projection, 10_000);
      publisher.seedSubagents();
      const log = new EventLog();
      log.push(SessionEventType.SubagentSpawned, {
        agentId: "active",
        childSessionId: "active",
        agentType: "Explore",
        description: "Active",
      });
      publisher.ingest(log.events.at(-1)!);
      const subscriber = publisher.subscribe({ connectionId: "live", deliveryProfile });
      const table = (projection as unknown as { subagentOutcomeByChildId: Map<string, unknown> })
        .subagentOutcomeByChildId;
      const keys = vi.spyOn(table, "keys");
      const entries = vi.spyOn(table, Symbol.iterator);
      const request = (requestId: string, child = false) => {
        log.push(SessionEventType.PermissionRequested, {
          requestId,
          toolCallId: requestId,
          toolName: "Write",
          riskLevel: "medium",
          reason: "Write",
          input: {},
          ...(child ? { origin: { kind: "subagent", childSessionId: "active" } } : {}),
        });
        publisher.ingest(log.events.at(-1)!);
      };
      const resolve = (requestId: string) => {
        log.push(SessionEventType.PermissionResolved, {
          requestId,
          toolCallId: requestId,
          decision: "allow",
        });
        publisher.ingest(log.events.at(-1)!);
      };
      request("main");
      resolve("main");
      expect(keys).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      request("child-1", true);
      expect(projection.getSnapshot().subagents?.running[0]?.status).toBe("waiting");
      keys.mockClear();
      entries.mockClear();
      request("child-2", true);
      resolve("child-1");
      expect(keys).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      expect(projection.getSnapshot().subagents?.running[0]?.status).toBe("waiting");
      resolve("child-2");
      expect(projection.getSnapshot().subagents?.running[0]?.status).toBe("running");
      expect(publisher.flush(subscriber.ack.subscriptionId)?.payload.kind).toBe("deltas");
      const reconnect = publisher.subscribe({ connectionId: "reconnect", deliveryProfile }).frame;
      if (reconnect?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(reconnect.payload.snapshot.completedActivityCount).toBe(15_000);
      expect(reconnect.payload.snapshot.subagents?.running[0]?.status).toBe("running");
    },
  );

  it("相关权限状态要求重建摘要时不重写未变化的 child outcome", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const log = new EventLog();
    for (let i = 0; i < 4; i++) {
      log.push(SessionEventType.SubagentSpawned, {
        agentId: `agent-${i}`,
        childSessionId: `child-${i}`,
        agentType: "Explore",
        description: "Inspect",
      });
      log.push(SessionEventType.SubagentStopped, {
        agentId: `agent-${i}`,
        childSessionId: `child-${i}`,
        status: "success",
        summaryText: "done",
      });
    }
    for (const event of log.events) projection.applyEvent(event);
    expect(projection.getSnapshot().completedActivityCount).toBe(4);
    const table = (projection as unknown as { subagentOutcomeByChildId: Map<string, unknown> })
      .subagentOutcomeByChildId;
    const write = vi.spyOn(table, "set");
    log.push(SessionEventType.PermissionRequested, {
      requestId: "request",
      toolCallId: "write",
      toolName: "Write",
      riskLevel: "medium",
      reason: "Write file",
      input: {},
    });
    projection.applyEventAtomically(log.events.at(-1)!, () => true);
    expect(write).not.toHaveBeenCalled();
    expect(projection.getSnapshot().completedActivityCount).toBe(4);
  });

  it.each(["continuous", "replayable"] as const)(
    "%s 万级 child 成功→恢复→结算只点更新，拒绝和异常不污染状态",
    (deliveryProfile) => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const projection = (publisher as unknown as { projection: ProductProjection }).projection;
      seed(projection, 10_000);
      publisher.seedSubagents();
      const subscriber = publisher.subscribe({ connectionId: "live", deliveryProfile });
      expect(subscriber.frame?.payload.kind).toBe("snapshot");
      const table = (projection as unknown as { subagentOutcomeByChildId: Map<string, unknown> })
        .subagentOutcomeByChildId;
      const iterate = table[Symbol.iterator];
      let copiedEntries = 0;
      vi.spyOn(table, Symbol.iterator).mockImplementation(function* () {
        for (const entry of iterate.call(table)) {
          copiedEntries++;
          yield entry;
        }
      });
      const log = new EventLog();
      log.push(SessionEventType.SubagentSpawned, {
        agentId: "agent-9999",
        childSessionId: "child-9999",
        agentType: "Explore",
        description: "Resume",
      });
      log.push(SessionEventType.SubagentStopped, {
        agentId: "agent-9999",
        childSessionId: "child-9999",
        status: "success",
        summaryText: "done",
      });
      for (const [index, event] of log.events.entries()) {
        const before = stateOf(projection);
        copiedEntries = 0;
        expect(projection.applyEventAtomically(event, () => false)).toBeNull();
        expect(copiedEntries).toBe(0);
        expect(stateOf(projection)).toBe(before);
        copiedEntries = 0;
        expect(() =>
          projection.applyEventAtomically(event, () => {
            throw new Error(INJECTED_FAILURE);
          }),
        ).toThrow(INJECTED_FAILURE);
        expect(copiedEntries).toBe(0);
        expect(stateOf(projection)).toBe(before);
        copiedEntries = 0;
        publisher.ingest(event);
        expect(copiedEntries).toBe(0);
        const expectedCount = index === 0 ? 14_999 : 15_000;
        const frame = publisher.flush(subscriber.ack.subscriptionId);
        if (frame?.payload.kind !== "deltas") throw new Error("expected deltas");
        expect(frame.payload.deltas).toContainEqual(
          expect.objectContaining({
            op: "state.updated",
            patch: expect.objectContaining({ completedActivityCount: expectedCount }),
          }),
        );
        const reconnect = publisher.subscribe({
          connectionId: `reconnect-${index}`,
          deliveryProfile,
        }).frame;
        if (reconnect?.payload.kind !== "snapshot") throw new Error("expected snapshot");
        expect(reconnect.payload.snapshot.completedActivityCount).toBe(expectedCount);
        expect(table.get("child-9999")).toMatchObject({
          status: index === 0 ? "running" : "success",
        });
      }
    },
  );

  it.each(["continuous", "replayable"] as const)(
    "%s 回退只撤销当前分支后缀，保留无行旧 child 与多来源身份",
    (deliveryProfile) => {
      const publisher = new ConversationTopicPublisher("session-1", "epoch-1");
      const projection = (publisher as unknown as { projection: ProductProjection }).projection;
      const log = new EventLog();
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "old", messageId: "old-user" },
        "old-turn",
      );
      publisher.ingest(log.events.at(-1)!);
      const childSessionIds = ["old-seed", "new-seed", "shared-seed"];
      publisher.seedSubagents({
        revision: 1,
        childSessionIds,
        running: [],
        ended: childSessionIds.map((childSessionId) => ({
          childSessionId,
          status: "success",
          title: childSessionId,
          subagentType: "Explore",
          endedAt: 1,
        })),
        parentMessageIdsByChildId: {
          "old-seed": ["old-message"],
          "new-seed": ["new-message"],
          "shared-seed": ["old-message", "new-message"],
        },
      });
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "new", messageId: "new-user" },
        "new-turn",
      );
      log.push(
        SessionEventType.SubagentSpawned,
        {
          agentId: "new-live",
          childSessionId: "new-live",
          agentType: "Explore",
          description: "New",
        },
        "new-turn",
      );
      log.push(
        SessionEventType.SubagentStopped,
        { agentId: "new-live", childSessionId: "new-live", status: "success", summaryText: "done" },
        "new-turn",
      );
      for (const event of log.events.slice(1)) publisher.ingest(event);
      const subscriber = publisher.subscribe({ connectionId: "live", deliveryProfile });
      expect(projection.getSnapshot().completedActivityCount).toBe(4);
      log.push(SessionEventType.RewindTriggered, {
        targetMessageId: "new-user",
        scope: "conversation",
        branchGeneration: 1,
        branchCutAfterMessageId: "new-message",
        removedMessageIds: ["new-user", "new-message"],
      });
      const rewind = log.events.at(-1)!;
      const before = stateOf(projection);
      expect(projection.applyEventAtomically(rewind, () => false)).toBeNull();
      expect(stateOf(projection)).toBe(before);
      expect(() =>
        projection.applyEventAtomically(rewind, () => {
          throw new Error(INJECTED_FAILURE);
        }),
      ).toThrow(INJECTED_FAILURE);
      expect(stateOf(projection)).toBe(before);
      publisher.ingest(rewind);
      expect([...(projection.getSnapshot().subagents?.childSessionIds ?? [])].sort()).toEqual([
        "old-seed",
        "shared-seed",
      ]);
      const frame = publisher.flush(subscriber.ack.subscriptionId);
      if (frame?.payload.kind !== "deltas") throw new Error("expected deltas");
      expect(frame.payload.deltas).toContainEqual(
        expect.objectContaining({
          op: "state.updated",
          patch: expect.objectContaining({ completedActivityCount: 2 }),
        }),
      );
      const reconnect = publisher.subscribe({ connectionId: "reconnect", deliveryProfile }).frame;
      if (reconnect?.payload.kind !== "snapshot") throw new Error("expected snapshot");
      expect(reconnect.payload.snapshot.completedActivityCount).toBe(2);
      const cold = new ProductProjection("session-1", "cold");
      cold.seedSubagents({
        revision: 1,
        childSessionIds: ["old-seed", "shared-seed"],
        running: [],
        ended: ["old-seed", "shared-seed"].map((childSessionId) => ({
          childSessionId,
          status: "success",
          title: childSessionId,
          subagentType: "Explore",
          endedAt: 1,
        })),
        parentMessageIdsByChildId: { "old-seed": ["old-message"], "shared-seed": ["old-message"] },
      });
      expect(projection.getSnapshot().completedActivityCount).toBe(
        cold.getSnapshot().completedActivityCount,
      );
      log.push(SessionEventType.RewindTriggered, {
        targetMessageId: "old-user",
        scope: "conversation",
        branchGeneration: 2,
        branchCutAfterMessageId: "new-message",
        removedMessageIds: ["old-user", "old-message"],
      });
      publisher.ingest(log.events.at(-1)!);
      expect(projection.getSnapshot().completedActivityCount).toBe(0);
      expect(projection.getSnapshot().subagents?.childSessionIds).toEqual([]);
    },
  );

  it.each(["running", "success"] as const)(
    "真实回退仍清除 %s child 身份，拒绝回退保留索引",
    (status) => {
      const projection = new ProductProjection("session-1", "epoch-1");
      const log = new EventLog();
      log.push(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "inspect", messageId: "user" },
        "turn",
      );
      const spawn = {
        agentId: "agent",
        childSessionId: "child",
        agentType: "Explore",
        description: "Inspect",
      };
      const stop = {
        agentId: "agent",
        childSessionId: "child",
        status: "success",
        summaryText: "done",
      };
      log.push(SessionEventType.SubagentSpawned, spawn, "turn");
      log.push(SessionEventType.SubagentStopped, stop, "turn");
      log.push(SessionEventType.SubagentSpawned, spawn, "turn");
      if (status === "success") log.push(SessionEventType.SubagentStopped, stop, "turn");
      for (const event of log.events) projection.applyEventAtomically(event, () => true);
      const table = (projection as unknown as { subagentOutcomeByChildId: Map<string, unknown> })
        .subagentOutcomeByChildId;
      expect(table.get("child")).toMatchObject({ status });
      const before = stateOf(projection);
      log.push(SessionEventType.RewindTriggered, {
        targetMessageId: "user",
        scope: "conversation",
        branchGeneration: 1,
        branchCutAfterMessageId: "user",
      });
      expect(projection.applyEventAtomically(log.events.at(-1)!, () => false)).toBeNull();
      expect(stateOf(projection)).toBe(before);
      projection.applyEventAtomically(log.events.at(-1)!, () => true);
      expect(table.size).toBe(0);
      expect(projection.getSnapshot().subagents?.childSessionIds).toEqual([]);
      expect(projection.getSnapshot().completedActivityCount).toBe(0);
    },
  );

  it("恢复、actor 去重、重复和旧事件的拒绝与异常不污染索引、水位和计数", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    const reference = new ProductProjection("session-1", "epoch-1");
    seed(projection, 4);
    seed(reference, 4);
    for (const event of [
      progress(3, "run-started"),
      progress(
        4,
        "node-queued",
        { instance: { siteId: "ask", ordinal: 1 }, kind: "ask" },
        "child-3",
      ),
      progress(5, "run-settled", { status: "completed" }),
      progress(5, "run-settled", { status: "completed" }),
      progress(2, "run-started"),
    ])
      assertAtomicEvent(projection, reference, event);
    const childLog = new EventLog();
    childLog.push(SessionEventType.SubagentSpawned, {
      agentId: "agent-2",
      childSessionId: "child-2",
      agentType: "Explore",
      description: "Resume",
    });
    childLog.push(SessionEventType.SubagentStopped, {
      agentId: "agent-2",
      childSessionId: "child-2",
      status: "success",
      summaryText: "done",
    });
    for (const event of childLog.events) assertAtomicEvent(projection, reference, event);
    expect(projection.getSnapshot().completedActivityCount).toBe(5);
  });
});

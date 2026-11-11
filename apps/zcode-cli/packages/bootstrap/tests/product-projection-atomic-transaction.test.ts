// 原子事件事务的回归契约（docs/v4-refactor/02-projection.md「原子事件事务」）。
//
// 钉住四件事，前两条对投影的全部字段通用（新增字段自动纳入比较）：
// 1. 拒绝、accept 抛错、归约中途抛错、某张共享表回滚抛错时，投影的每个字段（含 Map / Set 的迭代顺序）
//    与调用前完全相同。rowIdForMessageId 等按插入顺序取第一个匹配，顺序变化也是行为变化。
// 2. 接受时，状态与 delta 和直接 applyEvent 完全相同。
// 3. 每一步之后，八张共享大侧表都仍是 TransactionalMap，且没有残留的事务（JSON 比较看不出这两点：
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
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
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

/** 八张共享大侧表都是 TransactionalMap，且没有残留事务（还开着时 beginTransaction 会抛错）。 */
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

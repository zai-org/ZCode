// fork / 文件撤销的 session 锁走 availability，不写进行级 actions
// （docs/v4-refactor/02-projection.md「会话锁与行级资格」）。
//
// 钉住五件事：
// 1. 轮开始/结束、compact 开始/结束只翻转 availability，历史行不 upsert（长会话不再 fan-out）；
//    命令校验仍按“行级资格 && session 锁”拒绝。
// 2. 空闲时的 pending interaction（workspaceHookReview）同样锁文件撤销。
// 3. availability 从归约后的完整状态派生：同一事件里 pendingInteractions 与 control 由不同 patch
//    改写（带待处理权限请求时取消），结果不能读到另一半的旧值。
// 4. cold batch hydration 结束时 availability 收敛到最终状态。
// 5. availability 按值比较：值不变的事件不发 availability patch，即使它改了 availability 的输入
//    （运行中出现权限请求）。否则每个事件多发一条 state.updated 并递增 revision。
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import type {
  ActionAvailability,
  ConversationDelta,
  ConversationRow,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const BASE_TIMESTAMP_MS = 1_700_000_000_000;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const LIVE_TURN_ID = "turn-live";
const ALLOWED: ActionAvailability = { allowed: true };
const COMPACT_LOCK: ActionAvailability = { allowed: false, reasonCode: "compactOperationLock" };
const REWIND_LOCK: ActionAvailability = { allowed: false, reasonCode: "fileRewindUnavailable" };
const ACTION_UNAVAILABLE = {
  ok: false,
  status: "rejected",
  reasonCode: "guard.actionUnavailable",
} as const;

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(type: SessionEventTypeUnion, payload: unknown, turnId?: string): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: turnId as TurnId | undefined,
      type,
      timestamp: new Date(BASE_TIMESTAMP_MS + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

function pushStartedTurn(log: EventLog, turnId: string, turn: number): void {
  log.push(
    SessionEventType.TurnStarted,
    { turnNumber: turn, input: `问题 ${turn}`, messageId: `message-user-${turn}` },
    turnId,
  );
  log.push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId: `message-assistant-${turn}`,
    },
    turnId,
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: `回答 ${turn}`, done: false },
    turnId,
  );
}

function pushTurnEnd(log: EventLog, turnId: string, turn: number): void {
  log.push(
    SessionEventType.ModelComplete,
    {
      content: `回答 ${turn}`,
      stopReason: "end_turn",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: USAGE,
      fileChanges: {
        files: 1,
        additions: 2,
        deletions: 1,
        items: [{ path: `/work/${turn}.ts`, additions: 2, deletions: 1, writeCount: 1 }],
      },
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

/** 每轮都改过文件、都成功结束：历史 assistant 带 canFork，历史 turnHeader 带 canRewindFiles。 */
function historyLog(turns: number): EventLog {
  const log = new EventLog();
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  for (let turn = 1; turn <= turns; turn += 1) {
    pushStartedTurn(log, `turn-${turn}`, turn);
    pushTurnEnd(log, `turn-${turn}`, turn);
  }
  return log;
}

function replay(events: readonly SessionEvent[]): ProductProjection {
  const projection = new ProductProjection("session-1", "epoch-1");
  for (const event of events) projection.applyEvent(event);
  return projection;
}

function compactEvent(log: EventLog, type: "started" | "completed"): SessionEvent {
  const base = {
    operationId: "compact-1",
    messageId: "message-compact",
    trigger: "manual",
    display: "separator",
  };
  return type === "started"
    ? log.push(SessionEventType.CompactStarted, { ...base, status: "started" })
    : log.push(SessionEventType.CompactCompleted, {
        ...base,
        status: "completed",
        preCompactTokenCount: 150,
        postCompactTokenCount: 50,
      });
}

function targetOf(row: ConversationRow): ConversationRowTarget {
  return { rowId: row.rowId, entityId: row.entityId! };
}

/** 历史行 = live 轮开始前已存在的行（行的 turnId 是产品轮 id，不是 runtime turnId）。 */
function rowIdsOf(projection: ProductProjection): ReadonlySet<number> {
  return new Set(projection.getSnapshot().rows.window.map((row) => row.rowId));
}

function historyRows(
  projection: ProductProjection,
  historyRowIds: ReadonlySet<number>,
  kind: "turnHeader" | "assistantText",
): ConversationRow[] {
  return projection
    .getSnapshot()
    .rows.window.filter((row) => row.kind === kind && historyRowIds.has(row.rowId));
}

/** 本事件里被 upsert 的历史行。 */
function upsertedHistoryRowIds(
  deltas: readonly ConversationDelta[],
  historyRowIds: ReadonlySet<number>,
): number[] {
  return deltas.flatMap((delta) =>
    delta.op === "row.upserted" && historyRowIds.has(delta.row.rowId) ? [delta.row.rowId] : [],
  );
}

function availabilityPatches(deltas: readonly ConversationDelta[]): ConversationDelta[] {
  return deltas.filter(
    (delta) => delta.op === "state.updated" && delta.patch.availability !== undefined,
  );
}

function expectLocks(
  projection: ProductProjection,
  fork: ActionAvailability,
  rewindFiles: ActionAvailability,
): void {
  const { availability } = projection.getSnapshot();
  expect(availability.fork).toEqual(fork);
  expect(availability.rewindFiles).toEqual(rewindFiles);
}

/** 行级资格不随 session 锁翻转：每个历史轮的 assistant 仍 canFork、turnHeader 仍 canRewindFiles。 */
function expectHistoryRowEligibility(
  projection: ProductProjection,
  historyRowIds: ReadonlySet<number>,
  turns: number,
): void {
  const assistants = historyRows(projection, historyRowIds, "assistantText");
  const headers = historyRows(projection, historyRowIds, "turnHeader");
  expect(assistants).toHaveLength(turns);
  expect(headers).toHaveLength(turns);
  expect(assistants.every((row) => row.actions?.canFork === true)).toBe(true);
  expect(headers.every((row) => row.actions?.canRewindFiles === true)).toBe(true);
}

describe("fork / 文件撤销的 session 锁走 availability", () => {
  it("轮开始/结束、compact 开始/结束只翻转 availability，历史行不 upsert", () => {
    const turns = 30;
    const log = historyLog(turns);
    const projection = replay(log.events);
    const history = rowIdsOf(projection);
    expectHistoryRowEligibility(projection, history, turns);
    expectLocks(projection, ALLOWED, ALLOWED);
    const header = historyRows(projection, history, "turnHeader")[0]!;
    const assistant = historyRows(projection, history, "assistantText")[0]!;
    const latestAssistant = historyRows(projection, history, "assistantText").at(-1)!;
    const latestHistoryRowIds = new Set(
      projection
        .getSnapshot()
        .rows.window.filter(
          (row) =>
            row.turnId === latestAssistant.turnId &&
            (row.kind === "userInput" || row.kind === "assistantText"),
        )
        .map((row) => row.rowId),
    );

    // 新轮开始：只有 canEdit / canRetry 从上一轮交给新轮（各一行），其余历史行不动。
    pushStartedTurn(log, LIVE_TURN_ID, turns + 1);
    const startEvents = log.events.slice(-3);
    const startUpserts = startEvents.flatMap((event) =>
      upsertedHistoryRowIds(projection.applyEvent(event), history),
    );
    expect(startUpserts.every((rowId) => latestHistoryRowIds.has(rowId))).toBe(true);
    expectHistoryRowEligibility(projection, history, turns);
    expectLocks(projection, ALLOWED, REWIND_LOCK);
    expect(projection.resolveRowActionTarget(targetOf(header), "applyFileRewind")).toEqual(
      ACTION_UNAVAILABLE,
    );
    expect(projection.resolveRowActionTarget(targetOf(assistant), "forkAssistant")).toMatchObject({
      ok: true,
    });

    pushTurnEnd(log, LIVE_TURN_ID, turns + 1);
    for (const event of log.events.slice(-2)) {
      expect(upsertedHistoryRowIds(projection.applyEvent(event), history)).toEqual([]);
    }
    expectLocks(projection, ALLOWED, ALLOWED);
    expect(projection.resolveRowActionTarget(targetOf(header), "applyFileRewind")).toMatchObject({
      ok: true,
    });

    const compactStartDeltas = projection.applyEvent(compactEvent(log, "started"));
    expect(upsertedHistoryRowIds(compactStartDeltas, history)).toEqual([]);
    expect(compactStartDeltas).toContainEqual({
      op: "state.updated",
      patch: expect.objectContaining({
        availability: expect.objectContaining({ fork: COMPACT_LOCK, rewindFiles: COMPACT_LOCK }),
      }),
    });
    expectHistoryRowEligibility(projection, history, turns);
    expectLocks(projection, COMPACT_LOCK, COMPACT_LOCK);
    expect(projection.resolveRowActionTarget(targetOf(header), "applyFileRewind")).toEqual(
      ACTION_UNAVAILABLE,
    );
    expect(projection.resolveRowActionTarget(targetOf(assistant), "forkAssistant")).toEqual(
      ACTION_UNAVAILABLE,
    );

    expect(
      upsertedHistoryRowIds(projection.applyEvent(compactEvent(log, "completed")), history),
    ).toEqual([]);
    expectHistoryRowEligibility(projection, history, turns);
    expectLocks(projection, ALLOWED, ALLOWED);
    expect(projection.resolveRowActionTarget(targetOf(assistant), "forkAssistant")).toMatchObject({
      ok: true,
    });
  });

  it("空闲时待审核的 workspace Hook 锁文件撤销，审核结束后解锁", () => {
    const log = historyLog(2);
    const projection = replay(log.events);
    const history = rowIdsOf(projection);
    const header = historyRows(projection, history, "turnHeader")[0]!;
    const request = {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      generation: 1,
      interactionId: "interaction-hook",
      sessionId: "session-1",
      taskId: "session-1",
      runId: "run-1",
      workspaceIdentity: "local:/workspace",
      workspaceLabel: "workspace",
      bundleDigest: "a".repeat(64),
      createdAt: BASE_TIMESTAMP_MS + 1_000,
      deadlineAt: BASE_TIMESTAMP_MS + 601_000,
      sourceFiles: [],
      summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
      items: [
        {
          reviewItemId: "item-0",
          event: "SessionStart",
          matcher: "startup",
          type: "command",
          displayName: "SessionStart · startup",
          displayCommand: "echo project",
          sourcePath: ".zcode/config.json",
          resolvedTimeoutMs: 60_000,
          resolvedMaxOutputBytes: 32_768,
          executionMode: "foreground",
          configuredEnabled: true,
          editable: true,
          trustState: "pending_trust",
        },
      ],
      warningCode: "workspace_hooks_execute_code",
    } as const;

    const requested = projection.applyEvent(
      log.push(SessionEventType.WorkspaceHookReviewRequested, { request }),
    );
    expect(projection.getSnapshot().pendingInteractions).toHaveLength(1);
    expect(upsertedHistoryRowIds(requested, history)).toEqual([]);
    expect(projection.getSnapshot().control.activeWorks).toEqual([]);
    expectLocks(projection, ALLOWED, REWIND_LOCK);
    expect(projection.resolveRowActionTarget(targetOf(header), "applyFileRewind")).toEqual(
      ACTION_UNAVAILABLE,
    );

    projection.applyEvent(
      log.push(SessionEventType.WorkspaceHookReviewSettled, {
        interactionId: "interaction-hook",
        state: "resolved",
      }),
    );
    expect(projection.getSnapshot().pendingInteractions).toEqual([]);
    expectLocks(projection, ALLOWED, ALLOWED);
  });

  it("带待处理权限请求时取消本轮：同一事件清空 pendingInteractions 与 activeWorks 后解锁", () => {
    const log = historyLog(1);
    pushStartedTurn(log, LIVE_TURN_ID, 2);
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-live",
        toolName: "bash",
        input: { command: "ls" },
        schedule: { parallelGroups: [["tc-live"]], executionOrder: ["tc-live"] },
      },
      LIVE_TURN_ID,
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-live",
        toolCallId: "tc-live",
        toolName: "bash",
        riskLevel: "medium",
        reason: "Run shell command",
        input: { command: "ls" },
      },
      LIVE_TURN_ID,
    );
    const projection = replay(log.events);
    expect(projection.getSnapshot().pendingInteractions).toHaveLength(1);
    expectLocks(projection, ALLOWED, REWIND_LOCK);

    projection.applyEvent(
      log.push(
        SessionEventType.TurnComplete,
        { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "cancelled" },
        LIVE_TURN_ID,
      ),
    );
    const snapshot = projection.getSnapshot();
    expect(snapshot.pendingInteractions).toEqual([]);
    expect(snapshot.control.activeWorks).toEqual([]);
    expectLocks(projection, ALLOWED, ALLOWED);
  });

  it("availability 值不变的事件不发 availability patch，即使改了它的输入", () => {
    const log = historyLog(1);
    const projection = replay(log.events);

    // 新轮开始：文件撤销被锁，availability 变化，恰好发一次。
    pushStartedTurn(log, LIVE_TURN_ID, 2);
    const startDeltas = log.events.slice(-3).flatMap((event) => projection.applyEvent(event));
    expect(availabilityPatches(startDeltas)).toHaveLength(1);
    expectLocks(projection, ALLOWED, REWIND_LOCK);

    // 运行中的工具生命周期与权限请求：后者改写 pendingInteractions，但 rewindFiles 已因
    // active work 锁定（同一 reasonCode），availability 值不变。
    const unchangedFrom = log.events.length;
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-read",
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        schedule: { parallelGroups: [["tc-read"]], executionOrder: ["tc-read"] },
      },
      LIVE_TURN_ID,
    );
    log.push(
      SessionEventType.ToolCallStarted,
      { toolCallId: "tc-read", toolName: "Read", startedAt: new Date(BASE_TIMESTAMP_MS) },
      LIVE_TURN_ID,
    );
    log.push(
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-read", result: { success: true, content: "ok" }, duration: 10 },
      LIVE_TURN_ID,
    );
    log.push(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tc-bash",
        toolName: "bash",
        input: { command: "ls" },
        schedule: { parallelGroups: [["tc-bash"]], executionOrder: ["tc-bash"] },
      },
      LIVE_TURN_ID,
    );
    log.push(
      SessionEventType.PermissionRequested,
      {
        requestId: "req-bash",
        toolCallId: "tc-bash",
        toolName: "bash",
        riskLevel: "medium",
        reason: "Run shell command",
        input: { command: "ls" },
      },
      LIVE_TURN_ID,
    );
    const unchangedDeltas = log.events
      .slice(unchangedFrom)
      .flatMap((event) => projection.applyEvent(event));
    expect(projection.getSnapshot().pendingInteractions).toHaveLength(1);
    expect(unchangedDeltas.some((delta) => delta.op === "row.upserted")).toBe(true);
    expect(availabilityPatches(unchangedDeltas)).toEqual([]);
    expectLocks(projection, ALLOWED, REWIND_LOCK);
  });

  it("cold batch hydration 结束时 availability 收敛到最终状态，行级资格不受锁影响", () => {
    const turns = 3;
    const log = historyLog(turns);
    compactEvent(log, "started");
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.beginHydrationReplay();
    for (const event of log.events) projection.applyHydrationEvent(event);
    projection.completeHydrationReplay();

    expect(projection.getSnapshot().control.activeWorks).toEqual([
      expect.objectContaining({ kind: "compact" }),
    ]);
    expectLocks(projection, COMPACT_LOCK, COMPACT_LOCK);
    expectHistoryRowEligibility(projection, rowIdsOf(projection), turns);
  });
});

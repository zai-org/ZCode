import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

const DAY = 24 * 60 * 60 * 1000;

describe("queryAppUsage", () => {
  it("aggregates tokens, tools, and per-day buckets within range", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-usage-query-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("uq");
    const turnID = createTurnId("uq-turn");
    const now = 1_900_000_000_000; // 固定基准，避免依赖 Date.now()
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("uq"),
        slug: "uq",
        directory: tempRoot,
        title: "uq",
        version: "0.1.0",
      });
      await store.recordModelUsage({
        id: "m1",
        logicalRequestId: "r1",
        sessionID,
        turnID,
        traceID: createTraceId(),
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now - 1 * DAY,
        timeToFirstTokenMs: 100,
        inputTokens: 95,
        outputTokens: 5,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 5,
        computedTotalTokens: 100,
      });
      await store.recordModelUsage({
        id: "m2",
        logicalRequestId: "r2",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "error",
        startedAt: now - 2 * DAY,
        inputTokens: 4,
        outputTokens: 0,
        computedTotalTokens: 4,
      });
      await store.upsertTurnUsage({
        sessionID,
        turnID,
        status: "completed",
        startedAt: now - 1 * DAY,
        durationMs: 2000,
        computedTotalTokens: 100,
      });
      await store.upsertToolUsage({
        id: "t1",
        sessionID,
        turnID,
        toolCallID: createToolCallId("c1"),
        toolName: "Read",
        status: "completed",
        startedAt: now - 1 * DAY,
        durationMs: 50,
      });
      await store.upsertToolUsage({
        id: "t2",
        sessionID,
        turnID,
        toolCallID: createToolCallId("c2"),
        toolName: "Read",
        status: "error",
        startedAt: now - 1 * DAY,
        durationMs: 150,
      });

      const result = await store.queryAppUsage({
        since: now - 30 * DAY,
        until: now,
        tzOffsetMs: 0,
      });

      expect(result.totals.totalTokens).toBe(104);
      expect(result.totals.inputTokens).toBe(99);
      expect(result.totals.cacheReadTokens).toBe(80);
      expect(result.totals.modelRequestCount).toBe(2);
      expect(result.totals.modelErrorCount).toBe(1);
      expect(result.turnTotals.totalSessions).toBe(1);
      expect(result.turnTotals.totalTurns).toBe(1);
      expect(result.turnTotals.longestSessionMs).toBe(2000);
      expect(result.toolTotals.toolCallCount).toBe(2);
      expect(result.toolTotals.toolErrorCount).toBe(1);

      const readTool = result.tools.find((t) => t.toolName === "Read");
      expect(readTool).toMatchObject({ toolName: "Read", callCount: 2, errorCount: 1 });
      expect(readTool?.avgDurationMs).toBe(100);

      const modelA = result.models.find((m) => m.modelId === "model-a");
      expect(modelA).toMatchObject({ modelId: "model-a", totalTokens: 104, requestCount: 2 });

      // 两条 model_usage 落在两个不同的本地日
      expect(result.days.length).toBe(2);
      const dayWithTurn = result.days.find((d) => d.turnCount === 1);
      expect(dayWithTurn?.totalTokens).toBe(100);
      expect(dayWithTurn?.toolCallCount).toBe(2);

      expect(result.dayModels.some((d) => d.modelId === "model-a" && d.totalTokens === 100)).toBe(
        true,
      );
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("retains usage older than a year across updates and reopening with query-only time filters", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-usage-all-query-"));
    const dbPath = join(tempRoot, "session.sqlite");
    let store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("uq-all");
    const oldTurnID = createTurnId("uq-all-old");
    const newTurnID = createTurnId("uq-all-new");
    const now = Date.now();
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("uq-all"),
        slug: "uq-all",
        directory: tempRoot,
        title: "uq-all",
        version: "0.1.0",
      });
      await store.recordModelUsage({
        id: "all-old-model",
        logicalRequestId: "all-old-request",
        sessionID,
        turnID: oldTurnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-old",
        status: "completed",
        startedAt: now - 400 * DAY,
        inputTokens: 100,
        outputTokens: 20,
        computedTotalTokens: 120,
      });
      await store.recordModelUsage({
        id: "all-new-model",
        logicalRequestId: "all-new-request",
        sessionID,
        turnID: newTurnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-new",
        status: "completed",
        startedAt: now - 1 * DAY,
        inputTokens: 30,
        outputTokens: 10,
        computedTotalTokens: 40,
      });
      await store.upsertTurnUsage({
        sessionID,
        turnID: oldTurnID,
        status: "completed",
        startedAt: now - 400 * DAY,
        durationMs: 3000,
        computedTotalTokens: 120,
      });
      await store.upsertTurnUsage({
        sessionID,
        turnID: newTurnID,
        status: "completed",
        startedAt: now - 1 * DAY,
        durationMs: 4000,
        computedTotalTokens: 40,
      });

      for (const [id, turnID, startedAt] of [
        ["all-old-tool", oldTurnID, now - 400 * DAY],
        ["all-new-tool", newTurnID, now - DAY],
      ] as const) {
        await store.upsertToolUsage({
          id,
          sessionID,
          turnID,
          toolCallID: createToolCallId(id),
          toolName: "Read",
          status: "completed",
          startedAt,
        });
      }
      // 旧实现会在用量写入时删除历史；真实关闭再打开也必须保留三类事实。
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      expect(store.debugCounts(sessionID)).toMatchObject({
        modelUsage: 2,
        turnUsage: 2,
        toolUsage: 2,
      });
      await store.recordModelUsage({
        id: "all-old-model",
        logicalRequestId: "all-old-request",
        sessionID,
        turnID: oldTurnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-old",
        status: "completed",
        startedAt: now - 400 * DAY,
        inputTokens: 110,
        outputTokens: 20,
      });
      await store.upsertTurnUsage({
        sessionID,
        turnID: oldTurnID,
        status: "completed",
        startedAt: now - 400 * DAY,
        durationMs: 3000,
        computedTotalTokens: 130,
      });
      await store.upsertToolUsage({
        id: "all-old-tool",
        sessionID,
        turnID: oldTurnID,
        toolCallID: createToolCallId("all-old-tool"),
        toolName: "Read",
        status: "completed",
        startedAt: now - 400 * DAY,
        outputBytes: 12,
      });

      const result = await store.queryAppUsage({
        since: 0,
        until: now,
        tzOffsetMs: 0,
      });

      expect(result.totals.totalTokens).toBe(170);
      expect(result.turnTotals.totalTurns).toBe(2);
      expect(result.turnTotals.longestSessionMs).toBe(7000);
      expect(result.toolTotals.toolCallCount).toBe(2);
      expect(store.debugCounts(sessionID)).toMatchObject({
        modelUsage: 2,
        turnUsage: 2,
        toolUsage: 2,
      });
      const recent = await store.queryAppUsage({
        since: now - 30 * DAY,
        until: now,
        tzOffsetMs: 0,
      });
      expect(recent.totals.totalTokens).toBe(40);
      expect(recent.turnTotals.totalTurns).toBe(1);
      expect(recent.toolTotals.toolCallCount).toBe(1);
      expect((await store.queryTaskUsage({ sessionID })).modelRequestCount).toBe(2);
      expect(result.models.map((model) => model.modelId)).toEqual(["model-old", "model-new"]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("queryTaskUsage", () => {
  it("aggregates model usage by session id", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-task-usage-query-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("task-usage");
    const otherSessionID = createSessionId("task-usage-other");
    const turnID = createTurnId("task-usage-turn");
    const now = Date.now();
    try {
      for (const id of [sessionID, otherSessionID]) {
        await store.createSession({
          id,
          projectID: createProjectId(`project-${id}`),
          slug: String(id),
          directory: tempRoot,
          title: String(id),
          version: "0.1.0",
        });
      }
      await store.recordModelUsage({
        id: "task-model-1",
        logicalRequestId: "task-request-1",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now,
        inputTokens: 35,
        outputTokens: 10,
        reasoningTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        computedTotalTokens: 45,
      });
      await store.recordModelUsage({
        id: "task-model-2",
        logicalRequestId: "task-request-2",
        sessionID,
        turnID,
        querySource: "subagent",
        providerId: "p",
        modelId: "model-b",
        status: "error",
        startedAt: now + 1,
        inputTokens: 8,
        outputTokens: 0,
        computedTotalTokens: 8,
      });
      await store.recordModelUsage({
        id: "other-task-model",
        logicalRequestId: "other-task-request",
        sessionID: otherSessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now + 2,
        inputTokens: 100,
        outputTokens: 100,
        computedTotalTokens: 200,
      });

      const result = await store.queryTaskUsage({ sessionID });

      expect(result).toMatchObject({
        sessionID,
        totalTokens: 53,
        inputTokens: 43,
        outputTokens: 10,
        reasoningTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelRequestCount: 2,
        modelErrorCount: 1,
        inputBaselineBySource: {
          main_turn: 35,
          subagent: 8,
        },
      });
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("counts repeated context sources by incremental input and survives compaction resets", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-task-usage-incremental-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("task-usage-incremental");
    const turnID = createTurnId("task-usage-incremental-turn");
    const now = Date.now();
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("project-incremental"),
        slug: String(sessionID),
        directory: tempRoot,
        title: String(sessionID),
        version: "0.1.0",
      });

      await store.recordModelUsage({
        id: "main-1",
        logicalRequestId: "main-1",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now,
        inputTokens: 100,
        outputTokens: 10,
        computedTotalTokens: 110,
      });
      await store.recordModelUsage({
        id: "main-2",
        logicalRequestId: "main-2",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now + 1,
        inputTokens: 130,
        outputTokens: 20,
        computedTotalTokens: 150,
      });
      await store.recordModelUsage({
        id: "compact-1",
        logicalRequestId: "compact-1",
        sessionID,
        turnID,
        querySource: "compact",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now + 2,
        inputTokens: 200,
        outputTokens: 30,
        computedTotalTokens: 230,
      });
      await store.recordModelUsage({
        id: "main-after-compact",
        logicalRequestId: "main-after-compact",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now + 3,
        inputTokens: 80,
        outputTokens: 5,
        computedTotalTokens: 85,
      });
      await store.recordModelUsage({
        id: "main-after-compact-2",
        logicalRequestId: "main-after-compact-2",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerId: "p",
        modelId: "model-a",
        status: "completed",
        startedAt: now + 4,
        inputTokens: 95,
        outputTokens: 7,
        computedTotalTokens: 102,
      });

      const result = await store.queryTaskUsage({ sessionID });

      expect(result).toMatchObject({
        sessionID,
        // main: 100+10, then (130-100)+20; compact counts full 200+30;
        // after compaction input drops to 80 so only output 5 counts, then (95-80)+7.
        totalTokens: 417,
        inputTokens: 345,
        outputTokens: 72,
        modelRequestCount: 5,
        inputBaselineBySource: {
          main_turn: 95,
        },
      });
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

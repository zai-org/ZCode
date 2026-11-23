// dwf run 的冷回放接缝（docs/dynamic-workflow/presentation.md）：
// 父会话冷物化时，`app.replayDynamicWorkflowRuns` 交出的进度载荷被铸成 DynamicWorkflowRunProgress
// 会话事件、前置到内存事件之前，经既有 cold merge（memory-only 权威）与同一个 reducer 落进
// `workflowRuns`——重启后订阅拿到的快照里 run 与重启前一致。
//
// 覆盖面：
//   1. 父会话直接命中 record：回放载荷进投影，内存里已有的 runId 被交给 CLI 排除；
//   2. 子会话经 parentID 回落到父 record：**不**补种（journal 按父会话建键）；
//   3. 回放抛错：只记日志，冷开照常完成。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { conversationTopic, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type {
  DynamicWorkflowRunProgressPayload,
  EventId,
  MessageId,
  ModelId,
  ModelProviderId,
  MessagePart,
  ProjectId,
  SessionEvent,
  SessionEventStorePort,
  SessionId,
  TraceId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

type TestSessionStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

const WORKSPACE_PATH = "/tmp/zcode-workflow-cold-replay";
const PARENT_SESSION_ID = "sess_parent_replay" as SessionId;
const CHILD_SESSION_ID = "sess_actor_replay" as SessionId;

function progress(
  runId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown> = {},
): DynamicWorkflowRunProgressPayload {
  return { runId, toolCallId: `call-${runId}`, sequence, eventType, payload };
}

/** 一条 run 从 journal 回放出来的载荷：started → 一个 ask 结算 → 用量 → settle。 */
function replayedRun(
  runId: string,
  status: "completed" | "stopped",
): DynamicWorkflowRunProgressPayload[] {
  return [
    progress(runId, 0, "run-started", { caps: { maxConcurrency: 4 } }),
    progress(runId, 1, "actor-created", {
      actor: { siteId: "actor#1", ordinal: 1 },
      name: "worker",
    }),
    progress(runId, 2, "node-queued", {
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
    }),
    progress(runId, 3, "node-settled", {
      instance: { siteId: "ask#1", ordinal: 1 },
      outcome: "ok",
    }),
    progress(runId, 4, "usage-updated", { spentTokens: 4200 }),
    progress(runId, 5, "run-settled", {
      status,
      ...(status === "stopped" ? { stopReason: "user", resumable: true } : {}),
    }),
  ];
}

function memoryProgressEvent(
  sessionId: SessionId,
  seq: number,
  payload: DynamicWorkflowRunProgressPayload,
): SessionEvent {
  return {
    id: `${sessionId}-event-${seq}` as EventId,
    sessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(1_700_000_000_000 + seq * 1000),
    traceId: "trace-replay" as TraceId,
    sequenceNumber: seq,
    payload,
  } as SessionEvent;
}

function makeRecord(
  eventStore: SessionEventStorePort,
  replay?: (input: {
    excludeRunIds: ReadonlySet<string>;
  }) => Promise<DynamicWorkflowRunProgressPayload[]>,
): ZCodeProtocolSessionRecord {
  return {
    app: {
      readToolResultArtifact: async () => ({ content: "" }),
      ...(replay === undefined ? {} : { replayDynamicWorkflowRuns: replay }),
      runtime: {
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "glm-4-air" }),
        // readSessionContextUsage（staging 6d4c3cc571 起在 loadPersistedEvents 里同步读容量种子）要读
        // projection.contextWindow / contextUsed；给一份最小投影即可，子代理投影本就为空。
        getProjection: async () => ({ contextUsed: 0, contextWindow: 200_000 }) as never,
      },
      sessionId: PARENT_SESSION_ID,
    },
    createdAt: 0,
    eventStore,
    persistence: "immediate",
    stateRevision: 1,
    updatedAt: 0,
    workspace: { workspaceKey: `local:${WORKSPACE_PATH}`, workspacePath: WORKSPACE_PATH },
  } as unknown as ZCodeProtocolSessionRecord;
}

function makeContext(input: {
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  store: TestSessionStore;
  warnings: string[];
}): ZCodeProtocolAgentServerContext {
  return {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    },
    deps: { sessionStore: input.store },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) => {
        input.warnings.push(`${message} ${JSON.stringify(context ?? {})}`);
      },
    },
    notify: () => {},
    requestClient: async () => {
      throw new Error("cold replay test does not issue reverse requests");
    },
    sessions: input.sessions,
    v4Interactions: { resolve: () => false },
    workspaceModelCatalogs: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
}

async function subscribeWorkflowRuns(
  gateway: ReturnType<typeof createConversationV4Gateway>,
  sessionId: string,
): Promise<WorkflowRunsState | undefined> {
  const result = await gateway.subscribe({
    topic: conversationTopic(sessionId),
    connectionId: `conn-${sessionId}`,
    clientMode: "desktop-continuous",
  });
  const payload = result.initialFrame?.payload;
  if (payload?.kind !== "snapshot") throw new Error("Expected snapshot initial frame");
  return payload.snapshot.workflowRuns;
}

describe("v4 冷物化 · dwf run 的冷回放", () => {
  let tempRoot: string;
  let store: TestSessionStore;
  let warnings: string[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-cold-replay-"));
    store = await createSqliteSessionStore({ dbPath: join(tempRoot, "sessions.db") });
    warnings = [];
  });

  afterEach(async () => {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  });

  async function createSessionRow(sessionId: SessionId, parentId?: SessionId): Promise<void> {
    await store.createSession({
      id: sessionId,
      ...(parentId ? { parentID: parentId } : {}),
      projectID: "project_cold_replay" as ProjectId,
      slug: `slug-${sessionId}`,
      directory: WORKSPACE_PATH,
      path: WORKSPACE_PATH,
      title: `session ${sessionId}`,
      version: "test-version",
      time: { created: 1, updated: 4 },
    });
  }

  it("父会话：回放载荷经同一个 reducer 落进 workflowRuns；内存里已有的 runId 交给 CLI 排除", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    const eventStore = createInMemorySessionEventStore();
    // 本进程已收到过 dwfrun-live 的事件（暖物化）：它必须出现在排除集里、且不被回放覆盖。
    const liveEvents = replayedRun("dwfrun-live", "completed").slice(0, 2);
    let seq = 0;
    for (const payload of liveEvents) {
      seq += 1;
      await eventStore.append(memoryProgressEvent(PARENT_SESSION_ID, seq, payload));
    }
    const excludeSeen: string[][] = [];
    const record = makeRecord(eventStore, async ({ excludeRunIds }) => {
      excludeSeen.push([...excludeRunIds]);
      return [...replayedRun("dwfrun-old", "stopped"), ...replayedRun("dwfrun-done", "completed")];
    });
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([[PARENT_SESSION_ID, record]]);
    const context = makeContext({ sessions, store, warnings });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    const workflowRuns = await subscribeWorkflowRuns(gateway, PARENT_SESSION_ID);

    expect(excludeSeen).toEqual([["dwfrun-live"]]);
    const byId = new Map(workflowRuns?.runs.map((run) => [run.runId, run]));
    // 回放出来的 run 与 live 归约同形：状态、步数、用量、resumable 位一个不少。
    expect(byId.get("dwfrun-old")).toMatchObject({
      status: "stopped",
      stopReason: "user",
      resumable: true,
      toolCallId: "call-dwfrun-old",
      usage: { spentTokens: 4200, nodesUsed: 0 },
    });
    expect(byId.get("dwfrun-old")?.nodes).toHaveLength(1);
    expect(byId.get("dwfrun-old")?.actors).toHaveLength(1);
    expect(byId.get("dwfrun-done")).toMatchObject({ status: "completed" });
    expect(byId.get("dwfrun-done")?.resumable).toBeUndefined();
    // 回放在前、内存事件在后：live run 仍是内存事件归约出的形态（running，只有 actor）。
    expect(byId.get("dwfrun-live")).toMatchObject({ status: "running" });
    expect([...byId.keys()]).toEqual(["dwfrun-old", "dwfrun-done", "dwfrun-live"]);
    expect(warnings.some((line) => line.includes("dynamic workflow replay failed"))).toBe(false);
  });

  it("完整历史种子不受八条预览限制，保留更新的 live run 状态", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    const eventStore = createInMemorySessionEventStore();
    const record = makeRecord(eventStore, async () => replayedRun("recent", "completed"));
    record.app.getWorkflowActivityHistory = async () => ({
      runs: Array.from({ length: 10 }, (_, i) => ({
        runId: `old-${i}`,
        status: "completed",
        sequence: 20,
      })),
      childSessionIds: [],
    });
    const context = makeContext({
      sessions: new Map([[PARENT_SESSION_ID, record]]),
      store,
      warnings,
    });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;
    const result = await gateway.subscribe({
      topic: conversationTopic(PARENT_SESSION_ID),
      connectionId: "complete-history",
      clientMode: "desktop-continuous",
    });
    const payload = result.initialFrame?.payload;
    if (payload?.kind !== "snapshot") throw new Error("Expected snapshot");
    expect(payload.snapshot.workflowRuns?.runs).toHaveLength(1);
    expect(payload.snapshot.completedActivityCount).toBe(11);
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "完整计数读取失败保留可用历史、实时事件及未知计数，并记录告警 (%s)",
    async (clientMode) => {
      await createSessionRow(PARENT_SESSION_ID);
      const eventStore = createInMemorySessionEventStore();
      const messageId = "persisted-user" as MessageId;
      await store.saveMessage({
        id: messageId,
        sessionID: PARENT_SESSION_ID,
        role: "user",
        time: { created: 1 },
        agent: "zcode-agent",
        tools: {},
        model: { providerID: "glm" as ModelProviderId, modelID: "glm-4-air" as ModelId },
      });
      await store.savePart({
        id: "persisted-text" as MessagePart["id"],
        sessionID: PARENT_SESSION_ID,
        messageID: messageId,
        type: "text",
        text: "retained history message",
        time: { start: 1, end: 1 },
      });
      const record = makeRecord(eventStore, async () => replayedRun("history", "completed"));
      record.app.getWorkflowActivityHistory = async () => {
        for (const [index, payload] of replayedRun("live-tail", "completed").entries()) {
          const event = memoryProgressEvent(PARENT_SESSION_ID, index + 1, payload);
          await eventStore.append(event);
          gateway.ingest(PARENT_SESSION_ID, event);
        }
        throw new Error("injected activity summary failure");
      };
      const context = makeContext({
        sessions: new Map([[PARENT_SESSION_ID, record]]),
        store,
        warnings,
      });
      const gateway = createConversationV4Gateway(context);
      context.v4Gateway = gateway;
      const result = await gateway.subscribe({
        topic: conversationTopic(PARENT_SESSION_ID),
        connectionId: "summary-failure",
        clientMode,
        historyFirst: true,
      });
      const payload = result.initialFrame?.payload;
      if (payload?.kind !== "snapshot") throw new Error("Expected snapshot");
      expect(payload.snapshot.workflowRuns?.runs.map((run) => run.runId)).toEqual([
        "history",
        "live-tail",
      ]);
      expect(payload.snapshot.completedActivityCount).toBeNull();
      expect(JSON.stringify(payload.snapshot.rows)).toContain("retained history message");
      expect(
        warnings.some(
          (line) =>
            line.includes("activity history read failed") && line.includes(PARENT_SESSION_ID),
        ),
      ).toBe(true);
    },
  );

  it("子会话经 parentID 回落到父 record：不补种", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    await createSessionRow(CHILD_SESSION_ID, PARENT_SESSION_ID);
    const eventStore = createInMemorySessionEventStore();
    let replayCalls = 0;
    const record = makeRecord(eventStore, async () => {
      replayCalls += 1;
      return replayedRun("dwfrun-old", "completed");
    });
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([[PARENT_SESSION_ID, record]]);
    const context = makeContext({ sessions, store, warnings });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    // 生产形态（与 v4-detached-child-hydration 同）：子会话没有自己的 record，事件按子 sessionId
    // 归档进父的 event store，另经父 record 的 sink 路由到 gateway 的 detached live 通道。
    let seq = 0;
    for (const [type, payload, turnId] of [
      [SessionEventType.SessionCreated, { mode: "build", contextWindow: 200_000 }, undefined],
      [SessionEventType.TurnStarted, { turnNumber: 1, input: "actor 提问" }, "actor-turn-live"],
    ] as const) {
      seq += 1;
      const event = {
        id: `${CHILD_SESSION_ID}-event-${seq}` as EventId,
        sessionId: CHILD_SESSION_ID,
        ...(turnId === undefined ? {} : { turnId }),
        type,
        timestamp: new Date(1_700_000_000_000 + seq * 1000),
        traceId: "trace-replay" as TraceId,
        sequenceNumber: seq,
        payload,
      } as SessionEvent;
      await eventStore.append(event);
      gateway.ingestDetachedLiveSession(CHILD_SESSION_ID, event);
    }

    const workflowRuns = await subscribeWorkflowRuns(gateway, CHILD_SESSION_ID);

    expect(replayCalls).toBe(0);
    expect(workflowRuns?.runs ?? []).toEqual([]);
  });

  it("回放抛错：记 warn、冷开照常完成、投影为空而不是失败", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    const eventStore = createInMemorySessionEventStore();
    const record = makeRecord(eventStore, async () => {
      throw new Error("journal exploded");
    });
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([[PARENT_SESSION_ID, record]]);
    const context = makeContext({ sessions, store, warnings });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    const workflowRuns = await subscribeWorkflowRuns(gateway, PARENT_SESSION_ID);

    expect(workflowRuns?.runs ?? []).toEqual([]);
    expect(
      warnings.some((line) => line.includes("v4 hydrate dynamic workflow replay failed")),
    ).toBe(true);
  });
});

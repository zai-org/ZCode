import { describe, expect, it, vi } from "vitest";
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
  ConversationDelta,
  ConversationRow,
  SubagentRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

interface ProductProjectionInternals {
  subagentRowIdByAgentId: Map<string, number>;
  materializeSubagentProjection(reduced: readonly ConversationDelta[]): ConversationDelta[];
  pruneRemovedSubagentIndexes(): void;
  prospectiveSubagentRow(
    row: ConversationRow,
    reduced: readonly ConversationDelta[],
    startIndex: number,
  ): SubagentRow | null;
}

function sessionEvent(
  sequenceNumber: number,
  type: SessionEventTypeUnion,
  payload: unknown,
  turnId?: string,
): SessionEvent {
  return {
    id: `cold-hydration-event-${sequenceNumber}` as EventId,
    sessionId: "cold-hydration-session" as SessionId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type,
    timestamp: new Date(1_700_000_000_000 + sequenceNumber),
    traceId: "cold-hydration-trace" as TraceId,
    sequenceNumber,
    payload,
  };
}

function spyOnSubagentMaterialization(projection: ProductProjection) {
  return vi.spyOn(
    projection as unknown as ProductProjectionInternals,
    "materializeSubagentProjection",
  );
}

describe("ProductProjection cold hydration subagent materialization", () => {
  it("exposes live stopControl only for runtime-owned spawn, then strips it on cold replay", () => {
    const spawn = sessionEvent(1, SessionEventType.SubagentSpawned, {
      agentId: "agent-live-stop",
      agentType: "Explore",
      childSessionId: "child-live-stop",
      description: "Inspect stop",
      status: "running",
      taskId: "agent-live-stop",
      executionId: "execution-live-stop",
    });
    const live = new ProductProjection("cold-hydration-session", "epoch-live");
    live.applyEvent(spawn);
    expect(live.getSnapshot().subagents?.running[0]).toMatchObject({
      stopControl: { taskId: "agent-live-stop", executionId: "execution-live-stop" },
    });

    const cold = new ProductProjection("cold-hydration-session", "epoch-cold");
    cold.beginHydrationReplay();
    cold.applyHydrationEvent(spawn);
    cold.completeHydrationReplay();
    expect(cold.getSnapshot().subagents?.running[0]).not.toHaveProperty("stopControl");
  });

  it("ignores a late terminal event from an execution replaced by resume", () => {
    const projection = new ProductProjection("cold-hydration-session", "epoch-live");
    const identity = {
      agentId: "agent-resumed",
      agentType: "Explore",
      childSessionId: "child-resumed",
      taskId: "agent-resumed",
      description: "Resume child",
    };
    projection.applyEvent(
      sessionEvent(1, SessionEventType.SubagentSpawned, {
        ...identity,
        executionId: "execution-old",
      }),
    );
    projection.applyEvent(
      sessionEvent(2, SessionEventType.SubagentSpawned, {
        ...identity,
        executionId: "execution-new",
        resumed: true,
        background: true,
      }),
    );
    projection.applyEvent(
      sessionEvent(3, SessionEventType.SubagentStopped, {
        ...identity,
        executionId: "execution-old",
        status: "stopped",
      }),
    );
    expect(projection.getSnapshot().subagents?.running).toEqual([
      expect.objectContaining({
        childSessionId: identity.childSessionId,
        stopControl: { taskId: identity.taskId, executionId: "execution-new" },
      }),
    ]);
    projection.applyEvent(
      sessionEvent(4, SessionEventType.SubagentStopped, {
        ...identity,
        executionId: "execution-new",
        status: "stopped",
      }),
    );
    expect(projection.getSnapshot().subagents?.running).toEqual([]);
  });

  it("cold batch 对 checkpoint 只推进 seq，live 路径仍保持原有 materialization", () => {
    const checkpoint = sessionEvent(1, SessionEventType.CheckpointCreated, {
      checkpointId: "checkpoint-1",
      messageId: "message-1",
      scope: "workspace",
      snapshotRef: "artifact://checkpoint-1",
    });
    const coldProjection = new ProductProjection("cold-hydration-session", "epoch-cold");
    const coldMaterialize = spyOnSubagentMaterialization(coldProjection);

    coldProjection.beginHydrationReplay();
    expect(coldProjection.applyHydrationEvent(checkpoint)).toEqual([]);
    expect(coldMaterialize).not.toHaveBeenCalled();
    expect(coldProjection.getSnapshot().seq).toBe(1);
    coldProjection.completeHydrationReplay();

    const liveProjection = new ProductProjection("cold-hydration-session", "epoch-live");
    const liveMaterialize = spyOnSubagentMaterialization(liveProjection);
    expect(liveProjection.applyEvent(checkpoint)).toEqual([]);
    expect(liveMaterialize).toHaveBeenCalledOnce();
    expect(liveProjection.getSnapshot().seq).toBe(1);
  });

  it("cold batch 只在 subagent 派生输入变化时重新 materialize", () => {
    const turnId = "turn-subagent";
    const projection = new ProductProjection("cold-hydration-session", "epoch-cold");
    const materialize = spyOnSubagentMaterialization(projection);
    projection.beginHydrationReplay();

    projection.applyHydrationEvent(
      sessionEvent(
        1,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-1",
          agentType: "Explore",
          childSessionId: "child-session-1",
          description: "检查代码",
          status: "running",
        },
        turnId,
      ),
    );
    expect(materialize).toHaveBeenCalledOnce();
    expect(projection.getSnapshot().subagents).toMatchObject({
      childSessionIds: ["child-session-1"],
      running: [{ childSessionId: "child-session-1", status: "running" }],
    });

    materialize.mockClear();
    projection.applyHydrationEvent(
      sessionEvent(
        2,
        SessionEventType.BackgroundTaskStarted,
        {
          taskId: "agent-1",
          taskKind: "subagent",
          childSessionId: "child-session-1",
          description: "检查代码",
          status: "running",
          blocked: true,
        },
        turnId,
      ),
    );
    expect(materialize).toHaveBeenCalledOnce();
    expect(projection.getSnapshot().subagents?.running).toEqual([
      expect.objectContaining({ childSessionId: "child-session-1", status: "blocked" }),
    ]);

    materialize.mockClear();
    projection.applyHydrationEvent(
      sessionEvent(3, SessionEventType.CheckpointCreated, {
        checkpointId: "checkpoint-2",
        messageId: "message-1",
        scope: "workspace",
        snapshotRef: "artifact://checkpoint-2",
      }),
    );
    expect(materialize).not.toHaveBeenCalled();
    expect(projection.getSnapshot().subagents?.running).toEqual([
      expect.objectContaining({ childSessionId: "child-session-1", status: "blocked" }),
    ]);
    expect(projection.getSnapshot().seq).toBe(3);
    projection.completeHydrationReplay();
  });

  it("cold batch 与 strict replay 在 subagent 更新、等待和 rewind 后得到相同快照", () => {
    const firstTurnId = "turn-subagent-first";
    const secondTurnId = "turn-subagent-rewind";
    const thirdTurnId = "turn-subagent-rewind-again";
    const events = [
      sessionEvent(1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      sessionEvent(
        2,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "检查两个子代理", messageId: "user-first" },
        firstTurnId,
      ),
      sessionEvent(
        3,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-ended",
          agentType: "Explore",
          childSessionId: "child-ended",
          description: "先检查历史",
          status: "running",
        },
        firstTurnId,
      ),
      sessionEvent(
        4,
        SessionEventType.SubagentMessage,
        {
          agentId: "agent-ended",
          childSessionId: "child-ended",
          summaryText: "已完成扫描",
        },
        firstTurnId,
      ),
      sessionEvent(
        5,
        SessionEventType.SubagentStopped,
        {
          agentId: "agent-ended",
          agentType: "Explore",
          childSessionId: "child-ended",
          status: "completed",
          summaryText: "历史检查完成",
        },
        firstTurnId,
      ),
      sessionEvent(
        6,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-waiting",
          agentType: "general-purpose",
          childSessionId: "child-waiting",
          description: "等待用户授权",
          status: "running",
        },
        firstTurnId,
      ),
      sessionEvent(
        7,
        SessionEventType.PermissionRequested,
        {
          requestId: "permission-waiting",
          toolCallId: "tool-waiting",
          toolName: "Bash",
          riskLevel: "medium",
          reason: "需要运行命令",
          input: { command: "pwd" },
          origin: {
            kind: "subagent",
            agentId: "agent-waiting",
            agentType: "general-purpose",
            childSessionId: "child-waiting",
            description: "等待用户授权",
            parentSessionId: "cold-hydration-session",
            parentTurnId: firstTurnId,
          },
        },
        firstTurnId,
      ),
      sessionEvent(
        8,
        SessionEventType.TurnComplete,
        {
          response: "done",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 1,
          resultType: "success",
        },
        firstTurnId,
      ),
      sessionEvent(
        9,
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "这一轮会被 rewind", messageId: "user-rewind" },
        secondTurnId,
      ),
      sessionEvent(
        10,
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "assistant-rewind",
        },
        secondTurnId,
      ),
      sessionEvent(
        11,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-rewind",
          agentType: "Explore",
          childSessionId: "child-rewind",
          description: "将被回滚",
          status: "running",
        },
        secondTurnId,
      ),
      sessionEvent(12, SessionEventType.RewindTriggered, {
        targetMessageId: "assistant-rewind",
        scope: "conversation",
        createdMessageId: "rewind-notice",
      }),
      sessionEvent(
        13,
        SessionEventType.TurnStarted,
        { turnNumber: 3, input: "再次 rewind", messageId: "user-rewind-again" },
        thirdTurnId,
      ),
      sessionEvent(
        14,
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "assistant-rewind-again",
        },
        thirdTurnId,
      ),
      sessionEvent(
        15,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-rewind-again",
          agentType: "Explore",
          childSessionId: "child-rewind-again",
          description: "也会被回滚",
          status: "running",
        },
        thirdTurnId,
      ),
      sessionEvent(16, SessionEventType.RewindTriggered, {
        targetMessageId: "assistant-rewind-again",
        scope: "conversation",
        createdMessageId: "rewind-notice-again",
      }),
    ];
    const strictProjection = new ProductProjection("cold-hydration-session", "epoch-equivalent");
    const coldProjection = new ProductProjection("cold-hydration-session", "epoch-equivalent");
    const coldMaterialize = spyOnSubagentMaterialization(coldProjection);
    const strictPrune = vi.spyOn(
      strictProjection as unknown as ProductProjectionInternals,
      "pruneRemovedSubagentIndexes",
    );
    const coldPrune = vi.spyOn(
      coldProjection as unknown as ProductProjectionInternals,
      "pruneRemovedSubagentIndexes",
    );
    const materializingEventTypes = new Set<SessionEventTypeUnion>([
      SessionEventType.SubagentSpawned,
      SessionEventType.SubagentMessage,
      SessionEventType.SubagentStopped,
      SessionEventType.PermissionRequested,
      SessionEventType.RewindTriggered,
    ]);

    coldProjection.beginHydrationReplay();
    for (const event of events) {
      coldMaterialize.mockClear();
      strictProjection.applyEvent(event);
      coldProjection.applyHydrationEvent(event);
      if (materializingEventTypes.has(event.type)) {
        expect(coldMaterialize, event.type).toHaveBeenCalledOnce();
      }
      expect(coldProjection.getSnapshot().subagents, event.type).toEqual(
        strictProjection.getSnapshot().subagents,
      );
    }
    coldProjection.completeHydrationReplay();

    expect(coldProjection.getSnapshot()).toEqual(strictProjection.getSnapshot());
    expect(strictPrune).toHaveBeenCalledTimes(2);
    expect(coldPrune).toHaveBeenCalledTimes(2);
    expect(
      [
        ...(coldProjection as unknown as ProductProjectionInternals).subagentRowIdByAgentId.keys(),
      ].sort(),
    ).toEqual(["agent-ended", "agent-waiting"]);
    expect(coldProjection.getSnapshot().subagents).toMatchObject({
      childSessionIds: ["child-ended", "child-waiting"],
      running: [{ childSessionId: "child-waiting", status: "waiting" }],
      endedTotal: 1,
    });
    expect(
      coldProjection
        .getSnapshot()
        .rows.window.some(
          (row) => row.kind === "subagent" && row.childSessionId === "child-rewind",
        ),
    ).toBe(false);
  });

  it("重复 child 的最新行与 blocked 状态在 cold batch 和 strict replay 中保持等价", () => {
    const turnId = "turn-subagent-duplicates";
    const events = [
      sessionEvent(
        1,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-old",
          agentType: "Explore",
          childSessionId: "child-shared",
          description: "旧行",
          status: "running",
        },
        turnId,
      ),
      sessionEvent(
        2,
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-new",
          agentType: "Explore",
          childSessionId: "child-shared",
          description: "新行",
          status: "running",
        },
        turnId,
      ),
      sessionEvent(
        3,
        SessionEventType.BackgroundTaskStarted,
        {
          taskId: "agent-new",
          taskKind: "subagent",
          childSessionId: "child-shared",
          description: "新行",
          status: "running",
          blocked: true,
        },
        turnId,
      ),
    ];
    const strictProjection = new ProductProjection("cold-hydration-session", "epoch-duplicate");
    const coldProjection = new ProductProjection("cold-hydration-session", "epoch-duplicate");

    coldProjection.beginHydrationReplay();
    for (const event of events) {
      strictProjection.applyEvent(event);
      coldProjection.applyHydrationEvent(event);
      expect(coldProjection.getSnapshot().subagents, event.type).toEqual(
        strictProjection.getSnapshot().subagents,
      );
    }
    coldProjection.completeHydrationReplay();

    expect(coldProjection.getSnapshot().subagents).toMatchObject({
      childSessionIds: ["child-shared"],
      running: [
        expect.objectContaining({
          childSessionId: "child-shared",
          agentId: "agent-new",
          status: "blocked",
        }),
      ],
      endedTotal: 0,
    });
    expect(coldProjection.getSnapshot()).toEqual(strictProjection.getSnapshot());
  });

  it("subagent materialization 不遍历普通 conversation rows", () => {
    const projection = new ProductProjection("cold-hydration-session", "epoch-indexed");
    const prospectiveRow = vi.spyOn(
      projection as unknown as ProductProjectionInternals,
      "prospectiveSubagentRow",
    );
    let sequenceNumber = 0;
    projection.beginHydrationReplay();
    for (let turn = 1; turn <= 20; turn += 1) {
      projection.applyHydrationEvent(
        sessionEvent(
          (sequenceNumber += 1),
          SessionEventType.TurnStarted,
          { turnNumber: turn, input: `问题 ${turn}`, messageId: `user-indexed-${turn}` },
          `turn-indexed-${turn}`,
        ),
      );
    }
    expect(projection.getSnapshot().rows.window).toHaveLength(40);

    prospectiveRow.mockClear();
    projection.applyHydrationEvent(
      sessionEvent(
        (sequenceNumber += 1),
        SessionEventType.SubagentSpawned,
        {
          agentId: "agent-indexed",
          agentType: "Explore",
          childSessionId: "child-indexed",
          description: "只检查 subagent 行",
          status: "running",
        },
        "turn-indexed-20",
      ),
    );

    expect(prospectiveRow).toHaveBeenCalledOnce();
    projection.completeHydrationReplay();
  });
});

describe("ProductProjection cold hydration ask preview", () => {
  // 冷恢复的弹窗必须仍然带图：display 要经 applyHydrationEvent 存活，且与 live 路径一致。
  const display = {
    kind: "create_workflow",
    ok: true,
    errorCount: 0,
    diagnostics: [],
    causalityGraph: {
      steps: [
        {
          id: "ask#1",
          kind: "ask",
          label: "a",
          line: 2,
          column: 11,
          lane: "actor#1",
        },
      ],
      lanes: [{ id: "actor#1", name: "a" }],
      // 第二层是子代理导向：每阶段一张参与者卡 + 交接边（docs/dynamic-workflow/presentation.md）。
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
      ],
      handoffs: [],
      sink: ["ask#1"],
    },
  };

  function permissionEvents(): SessionEvent[] {
    const turnId = "turn-workflow";
    return [
      sessionEvent(1, SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 }),
      sessionEvent(2, SessionEventType.TurnStarted, { turnNumber: 1, input: "run it" }, turnId),
      sessionEvent(
        3,
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tc-1",
          toolName: "CreateWorkflow",
          input: { script: "return 1;" },
          schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
        },
        turnId,
      ),
      sessionEvent(
        4,
        SessionEventType.PermissionRequested,
        {
          requestId: "req-1",
          toolCallId: "tc-1",
          toolName: "CreateWorkflow",
          riskLevel: "low",
          reason: "createWorkflow.runConfirmation",
          input: { script: "return 1;" },
          display,
          optionsPolicy: "session-always-allow",
        },
        turnId,
      ),
    ];
  }

  it("display 与选项列表经冷恢复存活，且与 live 投影一致", () => {
    const events = permissionEvents();
    const live = new ProductProjection("cold-hydration-session", "epoch-equivalent");
    const cold = new ProductProjection("cold-hydration-session", "epoch-equivalent");

    for (const event of events) live.applyEvent(event);
    cold.beginHydrationReplay();
    for (const event of events) cold.applyHydrationEvent(event);
    cold.completeHydrationReplay();

    const payload = cold.getSnapshot().pendingInteractions[0]?.payload;
    expect(payload).toMatchObject({ kind: "permission", display });
    // 第 4 轮：CreateWorkflow 的 v4 选项含 Refine；第 7 轮含会话免确认；冷恢复走同一
    // 合成函数，天然一致。
    expect(
      payload?.kind === "permission" && payload.options.map((option) => option.optionId),
    ).toEqual(["allowOnce", "allowSession", "deny", "workflowRefine"]);
    expect(cold.getSnapshot().pendingInteractions).toEqual(live.getSnapshot().pendingInteractions);
  });
});

// ── 可复用工作流的两道窗在冷恢复上的等价（docs/dynamic-workflow/launch.md）──
// 刷新一次页面就把 saved run 的脚本弄丢，等于让用户在一个空窗上批准一次执行；
// 冷恢复与 live 走同一个合成函数，所以这里钉的是"没人给冷路径开第二条分支"。
describe("ProductProjection cold hydration 可复用工作流的确认窗", () => {
  const script = 'const r = agent("检查员");\nreturn await r.ask<string>("检查一遍");';

  /** executor 的 resolveInput 产出的归一化入参：脚本已解析，来龙去脉在 saved 上。 */
  const savedRunInput = {
    name: "release-check",
    script,
    saved: {
      name: "release-check",
      args: { target: "packages/core", depth: 3, skipTests: false },
      path: "/repo/.zcode/workflows/release-check.dwf.ts",
      scope: "project",
    },
  };

  const saveInput = {
    name: "release-check",
    description: "对本仓库做一次发布前检查",
    script,
    path: "/repo/.zcode/workflows/release-check.dwf.ts",
    overwrite: true,
    scope: "project",
  };

  function gateEvents(toolName: string, input: unknown, reason: string): SessionEvent[] {
    const turnId = "turn-reusable-workflow";
    return [
      sessionEvent(1, SessionEventType.SessionCreated, { mode: "default", contextWindow: 1000 }),
      sessionEvent(2, SessionEventType.TurnStarted, { turnNumber: 1, input: "run it" }, turnId),
      sessionEvent(
        3,
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tc-1",
          toolName,
          input,
          schedule: { parallelGroups: [["tc-1"]], executionOrder: ["tc-1"] },
        },
        turnId,
      ),
      sessionEvent(
        4,
        SessionEventType.PermissionRequested,
        {
          requestId: "req-1",
          toolCallId: "tc-1",
          toolName,
          riskLevel: "low",
          reason,
          input,
          optionsPolicy: "no-always-allow",
        },
        turnId,
      ),
    ];
  }

  function hydrate(events: readonly SessionEvent[]): {
    cold: ProductProjection;
    live: ProductProjection;
  } {
    const cold = new ProductProjection("cold-hydration-session", "epoch-equivalent");
    const live = new ProductProjection("cold-hydration-session", "epoch-equivalent");
    cold.beginHydrationReplay();
    for (const event of events) cold.applyHydrationEvent(event);
    cold.completeHydrationReplay();
    for (const event of events) live.applyEvent(event);
    return { cold, live };
  }

  it("saved run 的归一化入参经冷恢复存活，Refine 仍在，且与 live 一致", () => {
    const { cold, live } = hydrate(
      gateEvents("CreateWorkflow", savedRunInput, "createWorkflow.runConfirmation"),
    );

    const payload = cold.getSnapshot().pendingInteractions[0]?.payload;
    expect(payload?.kind).toBe("permission");
    // 脚本与实参袋都还在：冷恢复后的窗与热态是同一个窗。
    expect(payload?.kind === "permission" && payload.detail).toEqual(savedRunInput);
    expect(
      payload?.kind === "permission" && payload.options.map((option) => option.optionId),
    ).toEqual(["allowOnce", "deny", "workflowRefine"]);
    expect(cold.getSnapshot().pendingInteractions).toEqual(live.getSnapshot().pendingInteractions);
  });

  it("SaveWorkflow 的落点与覆盖判定经冷恢复存活，且照旧不带 display", () => {
    const { cold, live } = hydrate(
      gateEvents("SaveWorkflow", saveInput, "saveWorkflow.confirmation"),
    );

    const payload = cold.getSnapshot().pendingInteractions[0]?.payload;
    expect(payload?.kind === "permission" && payload.detail).toEqual(saveInput);
    expect(payload && "display" in payload).toBe(false);
    expect(
      payload?.kind === "permission" && payload.options.map((option) => option.optionId),
    ).toEqual(["allowOnce", "deny"]);
    expect(cold.getSnapshot().pendingInteractions).toEqual(live.getSnapshot().pendingInteractions);
  });
});

// ── dwf 运行态的冷恢复（docs/dynamic-workflow/presentation.md 的 Tests：漏一处即静默丢运行态）──
// 两个必须同时成立的条件，缺任一 run 就会在刷新/重连后消失，而 run 本身仍在飞：
//   1. cold 批量路径与 live 路径经**同一个** reducer（applyEventInternal），产出同一份状态；
//   2. cold merge 把这类事件识别为 memory-only 权威（它不在 durable transcript 里）。
describe("ProductProjection cold hydration workflowRuns", () => {
  function runProgress(sequenceNumber: number, eventType: string, payload: unknown): SessionEvent {
    return sessionEvent(sequenceNumber, SessionEventType.DynamicWorkflowRunProgress, {
      runId: "dwfrun-cold",
      toolCallId: "tc-cold",
      sequence: sequenceNumber - 1,
      eventType,
      payload,
    });
  }

  const events = [
    runProgress(1, "run-started", {
      runId: "dwfrun-cold",
      caps: { maxConcurrency: 2 },
    }),
    runProgress(2, "actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
    runProgress(3, "node-queued", {
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
    }),
    runProgress(4, "node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
  ];

  it("cold 批量与 live 逐条产出同一份 workflowRuns（同一个 reducer 路径）", () => {
    const cold = new ProductProjection("cold-hydration-session", "epoch-cold");
    cold.beginHydrationReplay();
    for (const event of events) cold.applyHydrationEvent(event);
    cold.completeHydrationReplay();

    const live = new ProductProjection("cold-hydration-session", "epoch-live");
    for (const event of events) live.applyEvent(event);

    expect(cold.getSnapshot().workflowRuns).toEqual(live.getSnapshot().workflowRuns);
    expect(cold.getSnapshot().workflowRuns).toMatchObject({
      runs: [
        {
          runId: "dwfrun-cold",
          status: "running",
          // dispatched = 会话就绪、请求尚未准入 → actor 仍是 waiting（决策 39）。
          actors: [{ siteId: "actor#1", ordinal: 1, name: "planner", status: "waiting" }],
          nodes: [{ siteId: "ask#1", ordinal: 1, kind: "ask", phase: "dispatched" }],
          lastEventSequence: 3,
        },
      ],
    });
  });

  it("在飞 run 的运行态在冷恢复后存活（cold merge 视其为 memory-only 权威）", async () => {
    const merge = await import("../src/zcode-protocol-v4/cold-event-merge.js");
    const merged = merge.mergeColdConversationEvents({
      memoryEvents: events,
      messages: [],
      sessionId: "cold-hydration-session",
    });

    // 事件被保留，且**不进 unclassified 诊断**——落到那个分支意味着分类表漏了它，
    // 虽然事件仍被保留，但每次冷恢复都会刷一条"未知老事实"诊断。
    expect(
      merged.events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(events.length);
    expect(
      merged.diagnostics.find(
        (diagnostic) => diagnostic.code === "cold_merge.unclassified_event_preserved",
      ),
    ).toBeUndefined();

    const rebuilt = new ProductProjection("cold-hydration-session", "epoch-rebuilt");
    for (const event of merged.events) rebuilt.applyEvent(event);
    expect(rebuilt.getSnapshot().workflowRuns?.runs[0]).toMatchObject({
      runId: "dwfrun-cold",
      status: "running",
      nodes: [{ siteId: "ask#1", ordinal: 1, phase: "dispatched" }],
    });
  });
});

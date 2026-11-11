// L2：v4 原生 goal/compact 命令组（compact / sendGoalCommand / pauseGoal / resumeGoal）——
// 验证自旧 server-operations compactSession/goalSession 搬运的状态机 barrier 在原生层保真：
// compact 去重幂等、active /goal 入队、重复 set 收敛 replace、goal 续跑的锁生命周期。
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    runtime: {
      getActiveTurnInfo: vi.fn().mockReturnValue(undefined),
      setExecutionState: vi.fn().mockResolvedValue(undefined),
    },
    getModel: vi.fn().mockReturnValue("primary-provider/default-model"),
    getThoughtLevel: vi.fn().mockReturnValue("high"),
    getMode: vi.fn().mockReturnValue("auto"),
    submitPrompt: vi.fn().mockResolvedValue({}),
    steerTurn: vi.fn().mockResolvedValue({ kind: "queued" }),
    setQueueAutoDrain: vi.fn().mockResolvedValue(undefined),
    readTarget: vi.fn().mockResolvedValue(null),
    setTarget: vi.fn().mockImplementation(async (input: { objective: string }) => ({
      targetID: "g1",
      objective: input.objective,
      status: "active",
    })),
    updateTargetStatus: vi
      .fn()
      .mockResolvedValue({ targetID: "g1", objective: "旧目标", status: "active" }),
    continueActiveTarget: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<V4SessionRecordView> & { app?: ReturnType<typeof makeApp> } = {},
): V4SessionRecordView {
  return {
    app: (overrides.app ?? makeApp()) as unknown as V4SessionRecordView["app"],
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    ...overrides,
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  overrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost & {
  legacyMutations: string[];
} {
  const legacyMutations: string[] = [];
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
    afterLegacyStateMutation: async (_r, reason) => {
      legacyMutations.push(reason);
    },
    ...overrides,
    legacyMutations,
  };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

async function settle() {
  // 后台 turn 是 void 起跑的微任务链，flush 两轮保证 finally 执行完。
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("v4 原生 compact", () => {
  it.each([false, true])("compact 固定提交的 B：busy=%s", async (busy) => {
    const modelSelection = { providerId: "provider-b", modelId: "model-b" };
    const app = makeApp();
    const record = makeRecord({
      app,
      ...(busy ? { activeAbortController: new AbortController() } : {}),
    });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("compact", { modelSelection }));
    const call = (busy ? app.steerTurn : app.submitPrompt).mock.calls[0];
    expect(call?.[0]).toBe("/compact");
    expect(call?.[1]).toMatchObject({
      intent: { kind: "compact", sourceCommandId: "cmd-1", modelSelection },
    });
    expect(call?.[1]?.intent).not.toHaveProperty("mode");
    expect(call?.[1]?.intent).not.toHaveProperty("planEnabled");
    await settle();
  });

  it("旧 compact 在接收时固定 A，后台起跑前切到 C 不改写请求", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const executing = new V4CommandExecutor(makeHost(record)).execute(envelope("compact", {}));
    // Selection 在接收时 structuredClone 固定；后台 submitPrompt 之前改模型不能回写进请求。
    app.getModel.mockReturnValue("provider-c/model-c");
    await executing;
    await settle();
    expect(app.submitPrompt).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({
        intent: expect.objectContaining({
          modelSelection: {
            providerId: "primary-provider",
            modelId: "default-model",
          },
        }),
      }),
    );
    await settle();
  });

  it("compact 的 Selection 不在 Worker Registry 时在接纳前拒绝，不进入 Core 建模", async () => {
    // Bug 根因：体验套餐到期后 Provider 下架，排队/直接的 /compact 仍按会话常驻选择进入 Core，
    // 以 "Provider Registry 中不存在 Provider" 的 TurnError 结束。现在与 sendText 共用同一份准入。
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("compact", {
          modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.submitPrompt).not.toHaveBeenCalled();
    expect(app.steerTurn).not.toHaveBeenCalled();
    expect(record.activeAbortController).toBeUndefined();
  });

  it("compact 的 Selection 在 Worker Registry 时放行", async () => {
    const app = makeApp({
      listModels: () => [{ ref: { providerId: "primary-provider", modelId: "default-model" } }],
    });
    const record = makeRecord({ app });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("compact", {}));
    await settle();
    expect(app.submitPrompt).toHaveBeenCalledWith("/compact", expect.anything());
  });

  it("正路径：后台 submitPrompt('/compact') + 上锁 + ready 边界释放", async () => {
    let finishCompact!: () => void;
    const compactGate = new Promise<Record<string, never>>((resolve) => {
      finishCompact = () => resolve({});
    });
    const app = makeApp({ submitPrompt: vi.fn().mockReturnValue(compactGate) });
    const record = makeRecord({ app });
    const host = makeHost(record);
    host.recordPersistentCommandFact = vi.fn().mockResolvedValue(undefined);
    await new V4CommandExecutor(host).execute(envelope("compact", {}));
    // 提交即返：execute 已回，compact 仍挂起 → Stop 可用的锁必须在。
    expect(record.activeAbortController).toBeDefined();
    expect(app.submitPrompt).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({ inputId: "cmd-1" }),
    );
    finishCompact();
    await settle();
    // ready 边界：compact 结束先释放锁再 legacy 广播。
    expect(record.activeAbortController).toBeUndefined();
    expect(host.recordPersistentCommandFact).toHaveBeenCalledWith(
      "s1",
      "timeline",
      expect.objectContaining({ commandId: "cmd-1", status: "accepted" }),
      { lifecycleStatus: "success" },
    );
    expect(host.legacyMutations).toEqual(["session_compacted"]);
  });

  it("释放 active lock 后，state mutation 收尾完成前仍持有 residency lease", async () => {
    let finishCompact!: () => void;
    let finishMutation!: () => void;
    let mutationStarted!: () => void;
    const compactGate = new Promise<Record<string, never>>((resolve) => {
      finishCompact = () => resolve({});
    });
    const mutationGate = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    const mutationStartedGate = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const record = makeRecord({
      app: makeApp({ submitPrompt: vi.fn().mockReturnValue(compactGate) }),
    });
    const host = makeHost(record, {
      afterLegacyStateMutation: async () => {
        mutationStarted();
        await mutationGate;
      },
    });

    await new V4CommandExecutor(host).execute(envelope("compact", {}));
    expect(record.residencyFinalizationCount).toBe(1);
    finishCompact();
    await mutationStartedGate;

    expect(record.activeAbortController).toBeUndefined();
    expect(record.residencyFinalizationCount).toBe(1);
    finishMutation();
    await settle();
    expect(record.residencyFinalizationCount).toBe(0);
  });

  it("compact 进行中：显式拒绝（不再次提交）", async () => {
    const app = makeApp({
      runtime: {
        getActiveTurnInfo: vi
          .fn()
          .mockReturnValue({ kind: "compact", queueLength: 0, steerable: false }),
      },
    });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record);
    await expect(
      new V4CommandExecutor(host).execute(envelope("compact", {})),
    ).rejects.toMatchObject({ reasonCode: "compactOperationLock" });
    expect(app.submitPrompt).not.toHaveBeenCalled();
    // 显式拒绝不得触碰进行中 compact 的锁。
    expect(record.activeAbortController).toBe(controller);
  });

  it("其他 active turn：/compact 以 typed maintenance intent 入队，不立即提交", async () => {
    const app = makeApp({
      runtime: {
        getActiveTurnInfo: vi
          .fn()
          .mockReturnValue({ kind: "primaryTurn", queueLength: 0, steerable: true }),
      },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("compact", {}));
    expect(app.steerTurn).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({
        commandKind: "compact",
        delivery: "queue",
        inputId: "cmd-1",
        intent: expect.objectContaining({
          kind: "compact",
          text: "/compact",
          requestedDelivery: "queue",
        }),
      }),
    );
    expect(app.submitPrompt).not.toHaveBeenCalled();
  });

  it("goal verifier busy routing：即使没有 steerable active turn，也进入 deferred FIFO", async () => {
    const modelSelection = { providerId: "provider-b", modelId: "model-b" };
    const enqueueDeferredInput = vi.fn().mockResolvedValue({ kind: "queued" });
    const app = makeApp({ enqueueDeferredInput });
    const record = makeRecord({ app });
    await new V4CommandExecutor(
      makeHost(record, { getInputRoutingMode: vi.fn().mockReturnValue("enqueue") }),
    ).execute(envelope("compact", { modelSelection }));
    expect(enqueueDeferredInput).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({
        commandKind: "compact",
        delivery: "queue",
        intent: expect.objectContaining({ modelSelection }),
      }),
    );
    expect(app.submitPrompt).not.toHaveBeenCalled();
  });

  it("已有 queued compact：compactOperationLock 拒绝，避免 FIFO 内重复维护意图", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(
        makeHost(record, { hasQueueItemKind: vi.fn().mockReturnValue(true) }),
      ).execute(envelope("compact", {})),
    ).rejects.toMatchObject({ reasonCode: "compactOperationLock" });
    expect(app.steerTurn).not.toHaveBeenCalled();
    expect(app.submitPrompt).not.toHaveBeenCalled();
  });

  it("后台 compact 登记 runtime active turn 前重复提交：同步 operation lock 仍拒绝", async () => {
    let finishCompact!: () => void;
    const compactGate = new Promise<Record<string, never>>((resolve) => {
      finishCompact = () => resolve({});
    });
    const app = makeApp({ submitPrompt: vi.fn().mockReturnValue(compactGate) });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("compact", {}));
    await expect(
      new V4CommandExecutor(host).execute({
        ...envelope("compact", {}),
        commandId: "cmd-2",
      }),
    ).rejects.toMatchObject({ reasonCode: "compactOperationLock" });
    finishCompact();
    await settle();
  });

  it("compact 失败：finally 仍释放锁，reason=session_compact_failed", async () => {
    const app = makeApp({
      submitPrompt: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("compact", {}));
    await settle();
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual(["session_compact_failed"]);
  });

  it("queued compact 失败且后方仍有输入：关闭 autoDrain，保持 FIFO failure barrier", async () => {
    const app = makeApp({
      submitPrompt: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getQueueLength: vi.fn().mockReturnValue(1) });
    await new V4CommandExecutor(host).execute(envelope("compact", {}));
    await settle();
    expect(app.setQueueAutoDrain).toHaveBeenCalledWith(false);
    expect(host.legacyMutations).toEqual(["session_compact_failed"]);
  });
});

describe("v4 原生 sendGoalCommand", () => {
  it("set 正路径：setTarget(active) + 后台续跑 + 锁生命周期", async () => {
    let finishContinuation!: () => void;
    const continuationGate = new Promise<null>((resolve) => {
      finishContinuation = () => resolve(null);
    });
    const app = makeApp({
      continueActiveTarget: vi.fn().mockReturnValue(continuationGate),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(
      envelope("sendGoalCommand", {
        text: "  完成登录页  ",
        displayText: "/TaRgEt replace 完成登录页",
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "goal-model",
          options: { reasoningLevel: "max" },
        },
        mode: "yolo",
      }),
    );
    // objective 落库为 trim 后文本，状态直接 active。
    expect(app.setTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        displayText: "/TaRgEt replace 完成登录页",
        objective: "完成登录页",
        status: "active",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          modelSelection: {
            providerId: "alternate-provider",
            modelId: "goal-model",
            options: { reasoningLevel: "max" },
          },
          mode: "yolo",
        }),
      }),
    );
    // 续跑期间持锁（连续 /goal 会被 active turn barrier 拒绝）。
    expect(record.activeAbortController).toBeDefined();
    expect(host.legacyMutations).toEqual(["goal_set"]);
    finishContinuation();
    await settle();
    expect(app.continueActiveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        inputId: "cmd-1",
        intent: expect.objectContaining({
          modelSelection: {
            providerId: "alternate-provider",
            modelId: "goal-model",
            options: { reasoningLevel: "max" },
          },
          mode: "yolo",
        }),
      }),
    );
    // 续跑结束释放锁（旧实现修过的 bug：占锁会让连续 /goal 误判活跃 turn）。
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual(["goal_set", "goal_continuation_completed"]);
  });

  it("set 的 Selection 不在 Worker Registry 时在写目标前拒绝，不改 target、不续跑", async () => {
    // Bug 根因：目标续跑没有模型准入，Provider 下架后 /goal 先写入目标再在 Core 建模失败。
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendGoalCommand", {
          text: "新目标",
          modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.setTarget).not.toHaveBeenCalled();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
    expect(record.activeAbortController).toBeUndefined();
  });

  it("重复 set：已有 target 收敛 replace 语义（reason=goal_replaced）", async () => {
    const app = makeApp({
      readTarget: vi
        .fn()
        .mockResolvedValue({ targetID: "g0", objective: "旧目标", status: "active" }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("sendGoalCommand", { text: "新目标" }));
    await settle();
    // 不要求用户先 clear/replace：直接覆盖写入新目标。
    expect(app.setTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        displayText: "/goal 新目标",
        objective: "新目标",
        status: "active",
        intent: expect.objectContaining({ sourceCommandId: "cmd-1" }),
      }),
    );
    expect(host.legacyMutations[0]).toBe("goal_replaced");
  });

  it("active turn 存在：入队为 goal command，不立即写 target", async () => {
    const app = makeApp();
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("sendGoalCommand", {
        text: "x",
        displayText: "/target x",
        modelSelection: { providerId: "queued-provider", modelId: "queued-model" },
        mode: "edit",
      }),
    );
    expect(app.steerTurn).toHaveBeenCalledWith(
      "/target x",
      expect.objectContaining({
        commandKind: "sendGoalCommand",
        inputId: "cmd-1",
        queryId: "cmd-1",
        intent: expect.objectContaining({
          kind: "sendGoalCommand",
          text: "x",
          modelSelection: { providerId: "queued-provider", modelId: "queued-model" },
          mode: "edit",
        }),
      }),
    );
    expect(app.setTarget).not.toHaveBeenCalled();
  });

  it("goal verifier routing 早于 controller：/goal 仍进入 deferred FIFO", async () => {
    const enqueueDeferredInput = vi.fn().mockResolvedValue({ kind: "queued" });
    const app = makeApp({
      enqueueDeferredInput,
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue(undefined) },
    });
    const record = makeRecord({ app });
    await new V4CommandExecutor(
      makeHost(record, { getInputRoutingMode: vi.fn().mockReturnValue("enqueue") }),
    ).execute(envelope("sendGoalCommand", { text: "验证后继续目标" }));
    expect(enqueueDeferredInput).toHaveBeenCalledWith(
      "/goal 验证后继续目标",
      expect.objectContaining({ commandKind: "sendGoalCommand", delivery: "queue" }),
    );
    expect(app.setTarget).not.toHaveBeenCalled();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
  });

  it("active turn queue 拒绝：显式失败，不伪装成已受理", async () => {
    const app = makeApp({
      steerTurn: vi.fn().mockResolvedValue({ kind: "rejected", reason: "input_too_large" }),
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendGoalCommand", { text: "过大的目标" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "proto.payloadTooLarge" });
    expect(app.setTarget).not.toHaveBeenCalled();
  });

  it("Plan 与 Goal 互斥：拒绝同时开启，不先落库目标", async () => {
    const app = makeApp({ getMode: vi.fn().mockReturnValue("plan") });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await expect(
      new V4CommandExecutor(host).execute(envelope("sendGoalCommand", { text: "目标" })),
    ).rejects.toMatchObject({ reasonCode: "guard.planGoalMutuallyExclusive" });
    await settle();
    expect(app.setTarget).not.toHaveBeenCalled();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual([]);
  });
});

describe("v4 原生 resumeGoal", () => {
  it("Plan 中不能把暂停目标恢复为 active", async () => {
    const app = makeApp({
      runtime: { getPlanEnabled: () => true },
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "paused" }),
    });
    await expect(
      new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(envelope("resumeGoal", {})),
    ).rejects.toMatchObject({ reasonCode: "guard.planGoalMutuallyExclusive" });
    expect(app.updateTargetStatus).not.toHaveBeenCalled();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
  });
  it("会话常驻模型不在 Worker Registry 时拒绝恢复，不改 target 状态", async () => {
    const app = makeApp({
      listModels: () => [],
      runtime: {
        getActiveTurnInfo: vi.fn().mockReturnValue(undefined),
        getSessionModelSelection: () => ({
          providerId: "account:bigmodel-start-plan",
          modelId: "glm-5",
        }),
      },
    });
    await expect(
      new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(envelope("resumeGoal", {})),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.updateTargetStatus).not.toHaveBeenCalled();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
  });

  it("正路径：updateTargetStatus(active) + 后台续跑", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("resumeGoal", {}));
    await settle();
    expect(app.updateTargetStatus).toHaveBeenCalledWith("active");
    expect(app.continueActiveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ inputId: "cmd-1" }),
    );
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toContain("goal_resumed");
    expect(host.legacyMutations).toContain("goal_continuation_completed");
  });

  it("无 target：幂等成功（不抛错、不续跑、不广播）", async () => {
    const app = makeApp({ updateTargetStatus: vi.fn().mockResolvedValue(null) });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await expect(
      new V4CommandExecutor(host).execute(envelope("resumeGoal", {})),
    ).resolves.toBeUndefined();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
    expect(host.legacyMutations).toEqual([]);
  });
});

describe("v4 原生 pauseGoal", () => {
  it("没有 active work 也会独立暂停 target，不触发 stop queue 语义", async () => {
    const app = makeApp({
      readTarget: vi
        .fn()
        .mockResolvedValue({ targetID: "g1", objective: "旧目标", status: "active" }),
      updateTargetStatus: vi
        .fn()
        .mockResolvedValue({ targetID: "g1", objective: "旧目标", status: "paused" }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(envelope("pauseGoal", {}));

    expect(app.updateTargetStatus).toHaveBeenCalledWith("paused");
    expect(app.setQueueAutoDrain).not.toHaveBeenCalled();
    expect(app.continueActiveTarget).not.toHaveBeenCalled();
    expect(host.legacyMutations).toEqual(["goal_paused"]);
  });

  it("先结算 paused target，再终止当前 goal work", async () => {
    const controller = new AbortController();
    const app = makeApp({
      readTarget: vi
        .fn()
        .mockResolvedValue({ targetID: "g1", objective: "旧目标", status: "active" }),
      updateTargetStatus: vi.fn().mockImplementation(async () => {
        expect(controller.signal.aborted).toBe(false);
        return { targetID: "g1", objective: "旧目标", status: "paused" };
      }),
    });
    const record = makeRecord({ app, activeAbortController: controller });

    await new V4CommandExecutor(makeHost(record)).execute(envelope("pauseGoal", {}));

    expect(controller.signal.aborted).toBe(true);
  });

  it("没有 active target 时幂等 noop", async () => {
    const app = makeApp();
    const host = makeHost(makeRecord({ app }));

    await expect(
      new V4CommandExecutor(host).execute(envelope("pauseGoal", {})),
    ).resolves.toBeUndefined();
    expect(app.updateTargetStatus).not.toHaveBeenCalled();
    expect(host.legacyMutations).toEqual([]);
  });
});

describe("supports 分流（goal/compact 组）", () => {
  it("pauseGoal 已原生", () => {
    const executor = new V4CommandExecutor(makeHost(makeRecord()));
    expect(executor.supports("pauseGoal")).toBe(true);
  });
});

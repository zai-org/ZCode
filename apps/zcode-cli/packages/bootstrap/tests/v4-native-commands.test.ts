// L2：v4 原生命令执行器（sendText / stop）——验证自旧 server-operations 搬运的
// 决策语义在原生层保真：steer 分流、draft 提升、ready 边界、goal-pause barrier。
// 08-phasing M4 完成定义的 L2 层（命令 → core 调用 → 状态推进，不经旧协议代码）。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import {
  PERMISSION_FULL_ACCESS_OPTION_ID,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { createInputFacade } from "../src/app/input-facade.js";
import type { SendInputOptions } from "../src/app/types.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { V4PromptRejectedError } from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import { V4InputAdmissionRejectedError } from "../src/zcode-protocol-v4/commands/input-admission.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

const ORDINARY_MODEL_SELECTION = {
  providerId: "builtin:bigmodel-coding-plan",
  modelId: "GLM-5.3",
};

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    sendInput: vi.fn().mockImplementation(async (_input, options) => {
      if (options?.requireQueue) {
        return {
          kind: "queued",
          pendingInputId: "queue_cmd-1",
          queueLength: 1,
          turnId: "turn-1",
        };
      }
      options?.onTurnStartedObserved?.({
        id: "event-started",
        type: SessionEventType.TurnStarted,
        payload: { messageId: "msg-event-started" },
      });
      return {
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-1",
      };
    }),
    steerTurn: vi.fn().mockResolvedValue({
      kind: "queued",
      pendingInputId: "queue_cmd-1",
      queueLength: 1,
      turnId: "turn-1",
    }),
    getModel: vi.fn().mockReturnValue("account:bigmodel-start-plan/glm-5"),
    readTarget: vi.fn().mockResolvedValue(null),
    updateTargetStatus: vi.fn().mockResolvedValue(null),
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
    waitForProjectionEventCommit: async () => {},
    legacyMutations,
    ...overrides,
  };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    clientId: "client-test",
    issuedAt: 1,
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

it("完全访问仅在实际授权后向发起端返回可保存的权限凭据", async () => {
  const interactions = new V4InteractionRegistry();
  interactions.register("permission", vi.fn(), {
    sessionId: "s1",
    kind: "other",
    fullAccess: async () => {},
  });
  const executor = new V4CommandExecutor(makeHost(makeRecord(), { interactions }));
  const command = envelope("resolveInteraction", {
    interactionId: "permission",
    answer: { optionId: PERMISSION_FULL_ACCESS_OPTION_ID },
  });
  expect(await executor.execute(command)).toMatchObject({
    type: "resolveInteraction",
    resolvedBy: { clientId: command.clientId, optionId: PERMISSION_FULL_ACCESS_OPTION_ID },
  });
  expect(await executor.execute({ ...command, commandId: "late" })).toBeUndefined();
});

async function settle() {
  // 后台 turn 是 void 起跑的微任务链，flush 两轮保证 finally 执行完。
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type PromptSendInputOptions = {
  abortSignal: AbortSignal;
  onEvent?: (event: SessionEvent) => void;
  onTurnStartedObserved?: (event: SessionEvent) => void;
};

function workspaceHookReviewRequest(input: {
  interactionId: string;
  deadlineAt: number;
  createdAt?: number;
  generation?: number;
  reviewFlowId?: string;
}) {
  return {
    kind: "workspaceHookReview",
    reviewFlowId: input.reviewFlowId ?? "review-flow-1",
    generation: input.generation ?? 1,
    interactionId: input.interactionId,
    sessionId: "s1",
    taskId: "task-1",
    runId: "run-1",
    workspaceIdentity: "/w",
    workspaceLabel: "w",
    bundleDigest: "a".repeat(64),
    createdAt: input.createdAt ?? Date.now(),
    deadlineAt: input.deadlineAt,
    sourceFiles: [
      {
        path: "/w/.zcode/config.json",
        displayPath: ".zcode/config.json",
        editable: true,
      },
    ],
    summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
    items: [
      {
        reviewItemId: "review-item-1",
        event: "PreToolUse",
        matcher: "*",
        type: "process",
        displayName: "echo hello",
        displayCommand: "echo hello",
        sourcePath: "/w/.zcode/config.json",
        resolvedTimeoutMs: 1_000,
        resolvedMaxOutputBytes: 1_024,
        executionMode: "foreground",
        configuredEnabled: true,
        editable: true,
        trustState: "pending_trust",
      },
    ],
    warningCode: "workspace_hooks_execute_code",
  };
}

function workspaceHookReviewRequestedEvent(input: {
  id: string;
  interactionId: string;
  deadlineAt: number;
  createdAt?: number;
  generation?: number;
  reviewFlowId?: string;
  sequenceNumber?: number;
}): SessionEvent {
  return {
    id: input.id,
    sequenceNumber: input.sequenceNumber ?? 1,
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    type: SessionEventType.WorkspaceHookReviewRequested,
    payload: {
      request: workspaceHookReviewRequest(input),
    },
  } as unknown as SessionEvent;
}

function workspaceHookReviewSettledEvent(input: {
  id: string;
  interactionId: string;
  sequenceNumber?: number;
}): SessionEvent {
  return {
    id: input.id,
    sequenceNumber: input.sequenceNumber ?? 2,
    timestamp: new Date("2026-08-07T00:00:01.000Z"),
    type: SessionEventType.WorkspaceHookReviewSettled,
    payload: {
      interactionId: input.interactionId,
      state: "resolved",
    },
  } as unknown as SessionEvent;
}

function turnStartedEvent(id = "event-turn-started"): SessionEvent {
  return {
    id,
    type: SessionEventType.TurnStarted,
    payload: { inputId: "cmd-1", messageId: `msg-${id}` },
  } as unknown as SessionEvent;
}

function makeAbortablePendingPromptApp() {
  let options: PromptSendInputOptions | undefined;
  const app = makeApp({
    sendInput: vi.fn().mockImplementation(
      (_input: unknown, nextOptions: PromptSendInputOptions) =>
        new Promise<Record<string, never>>((_resolve, reject) => {
          options = nextOptions;
          const rejectOnAbort = () => reject(nextOptions.abortSignal.reason);
          if (nextOptions.abortSignal.aborted) rejectOnAbort();
          else nextOptions.abortSignal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    ),
  });
  return {
    app,
    getOptions: () => {
      if (!options) throw new Error("sendInput options have not been captured");
      return options;
    },
  };
}

describe("v4 原生 sendText", () => {
  it("旧发送端 admission 保留 runtime 的稀疏 Session Selection，不回填 effective thought", async () => {
    let capturedOptions: SendInputOptions | undefined;
    const app = makeApp({
      getThoughtLevel: vi.fn(() => "high"),
      runtime: {
        getSessionModelSelection: vi.fn(() => ({ providerId: "provider-a", modelId: "model-a" })),
      },
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        capturedOptions = options;
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-sparse-selection",
        };
      }),
    });

    await new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(
      envelope("sendText", { text: "keep sparse selection" }),
    );

    expect(capturedOptions?.intent?.modelSelection).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("app input facade 把 start/queue 决策交给 Core admission，不查询 activeTurn", async () => {
    const runtime = {
      getActiveTurnInfo: vi.fn().mockReturnValue(undefined),
      admitPrompt: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started",
        turnId: "turn-1",
      }),
    };
    const facade = createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary: async () => {},
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });
    const modelExecution = {
      selectionScope: "execution",
      requestDependencies: {
        requestAuth: { source: { resolve: vi.fn().mockResolvedValue({ apiKey: "request-key" }) } },
      },
    } as const;

    await facade.sendInput("hi", {
      inputId: "cmd-1",
      offPeakTaskId: "off-peak-task-1",
      offPeakRunType: "init",
      modelExecution,
    });

    expect(runtime.getActiveTurnInfo).not.toHaveBeenCalled();
    expect(runtime.admitPrompt).toHaveBeenCalledWith(
      "hi",
      undefined,
      expect.objectContaining({
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "init",
        modelExecution,
      }),
    );
  });

  it("cold resume boundary 的 Hook review 被 prompt observer 捕获，且 AbortSignal 贯穿 admission", async () => {
    let temporarySink: { onSessionEvent(event: SessionEvent): Promise<void> | void } | undefined;
    const onEvent = vi.fn();
    const abortController = new AbortController();
    const reviewEvent = workspaceHookReviewRequestedEvent({
      id: "review-during-resume",
      interactionId: "interaction-resume",
      deadlineAt: Date.now() + 60_000,
    });
    const runtime = {
      getActiveTurnInfo: vi.fn().mockReturnValue(undefined),
      subscribeEvents: vi.fn().mockImplementation((sink) => {
        temporarySink = sink;
        return () => {};
      }),
      admitPrompt: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started",
        turnId: "turn-resume",
      }),
    };
    const prepareUserExecutionBoundary = vi.fn(async (options?: { abortSignal?: AbortSignal }) => {
      expect(options?.abortSignal).toBe(abortController.signal);
      expect(temporarySink).toBeDefined();
      await temporarySink?.onSessionEvent(reviewEvent);
    });
    const facade = createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary,
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });

    await facade.sendInput("resume me", {
      abortSignal: abortController.signal,
      inputId: "cmd-resume",
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledWith(reviewEvent);
    expect(runtime.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it("空闲会话：Core admission receipt 立即返回，完成后执行 ready 清理", async () => {
    let finishTurn!: () => void;
    const turnGate = new Promise<Record<string, never>>((resolve) => {
      finishTurn = () => resolve({});
    });
    const app = makeApp({
      sendInput: vi.fn().mockReturnValue({
        completion: turnGate,
        kind: "started_turn",
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    const executing = new V4CommandExecutor(host)
      .execute(
        envelope("sendText", {
          text: "hi",
          browserAmbientContext: {
            tabCount: 1,
            currentUrl: "https://example.com/current",
          },
        }),
      )
      .then((result) => {
        expect(result).toEqual({
          type: "inputAccepted",
          delivery: "startNow",
          inputId: "cmd-1",
        });
      });
    await vi.waitFor(() => expect(app.sendInput).toHaveBeenCalledTimes(1));
    await executing;
    expect(record.activeAbortController).toBeUndefined();
    finishTurn();
    await settle();
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "hi" },
      expect.objectContaining({
        inputId: "cmd-1",
        queryId: "cmd-1",
        browserAmbientContext: {
          tabCount: 1,
          currentUrl: "https://example.com/current",
        },
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          queueItemId: "queue_cmd-1",
          clientId: "client-test",
          requestedDelivery: "startNow",
        }),
      }),
    );
    // Core completion 后再执行 legacy cleanup；Bootstrap controller 从不参与 busy 判定。
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual(["prompt_completed"]);
  });

  it("TurnStarted 缺 messageId 时仍提交 Chat authority，仅省略 repo 归因结果", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-without-message-id",
      }),
    });

    await expect(
      new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(
        envelope("sendText", { text: "chat 必须继续" }),
      ),
    ).resolves.toEqual({
      type: "inputAccepted",
      delivery: "startNow",
      inputId: "cmd-1",
    });
  });

  it("Highspeed turn 运行中再次发送仍进入 queue，加速执行材料只暂存在 CLI 内存", async () => {
    const app = makeApp();
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const retainQueuedTurnExecution = vi.fn();
    const host = makeHost(record, {
      getInputRoutingMode: () => "enqueue",
      retainQueuedTurnExecution,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "排队继续问",
          highspeedMeta: {
            schemaVersion: 1,
            cardId: "card-1",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "GLM-5.3",
          },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: "card-jwt", headers: { "X-Highspeed-Card-ID": "card-1" } },
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              target: ORDINARY_MODEL_SELECTION,
              rules: [
                { reason: "highspeed_card_expired", providerErrorCode: "3402" },
                { reason: "highspeed_request_failed" },
              ],
            },
          },
        }),
      ),
    ).resolves.toEqual({
      type: "inputAccepted",
      delivery: "queue",
      inputId: "cmd-1",
    });

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "排队继续问" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          highspeed: expect.objectContaining({ cardId: "card-1" }),
          // 队列只持久化普通模型；临时 Selection 与凭据必须成包驻留内存。
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    // 凭据不进队列事件，只按 (sessionId, sourceCommandId) 暂存在 CLI 进程内。
    expect(retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      },
      modelExecution: expect.objectContaining({
        selectionScope: "execution",
        requestAuth: expect.objectContaining({ apiKey: "card-jwt" }),
      }),
    });
  });

  it("Highspeed 入队忽略被污染为加速 Provider 的退回目标", async () => {
    const app = makeApp({ getModel: () => "builtin:bigmodel-coding-plan/GLM-5.3" });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, {
      getInputRoutingMode: () => "enqueue",
      retainQueuedTurnExecution: vi.fn(),
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "退回目标被污染时仍保存普通模型",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-polluted-fallback",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt" },
          selectionFallback: {
            providerId: "account:bigmodel-highspeed-card",
            target: {
              providerId: "account:bigmodel-highspeed-card",
              modelId: "GLM-5.3",
            },
            rules: [{ reason: "highspeed_request_failed" }],
          },
        },
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "退回目标被污染时仍保存普通模型" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({ modelSelection: ORDINARY_MODEL_SELECTION }),
      }),
    );
  });

  it("Highspeed 运行中输入在 guide 模式下仍进入 queue", async () => {
    const app = makeApp({
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue({ steerable: true }) },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const retainQueuedTurnExecution = vi.fn();
    const host = makeHost(record, {
      getInputRoutingMode: () => "guide",
      hasQueuedDelivery: () => false,
      retainQueuedTurnExecution,
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "加速输入不应内联当前轮",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-guide",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt", headers: { "X-Highspeed-Card-ID": "card-guide" } },
          selectionFallback: {
            providerId: "account:bigmodel-highspeed-card",
            target: ORDINARY_MODEL_SELECTION,
            rules: [
              { reason: "highspeed_card_expired", providerErrorCode: "3402" },
              { reason: "highspeed_request_failed" },
            ],
          },
        },
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "加速输入不应内联当前轮" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "highspeed.requiresQueue",
          highspeed: expect.objectContaining({ cardId: "card-guide" }),
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    expect(retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      },
      modelExecution: expect.objectContaining({ selectionScope: "execution" }),
    });
  });

  it("Core active turn 已存在但 controller 与投影尚未同步时，Highspeed 输入仍进入 queue", async () => {
    const app = makeApp({
      runtime: {
        getActiveTurnInfo: vi.fn().mockReturnValue({
          kind: "regular",
          steerable: true,
          turnId: "turn-highspeed",
        }),
      },
    });
    const listModels = vi.fn(() => [{ ref: ORDINARY_MODEL_SELECTION }]);
    app.listModels = listModels;
    const record = makeRecord({ app });
    const retainQueuedTurnExecution = vi.fn();
    const host = makeHost(record, {
      getInputRoutingMode: () => "startNow",
      retainQueuedTurnExecution,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "controller 同步前也要排队",
          highspeedMeta: {
            schemaVersion: 1,
            cardId: "card-1",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "GLM-5.3",
          },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: "card-jwt", headers: { "X-Highspeed-Card-ID": "card-1" } },
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              target: ORDINARY_MODEL_SELECTION,
              rules: [
                { reason: "highspeed_card_expired", providerErrorCode: "3402" },
                { reason: "highspeed_request_failed" },
              ],
            },
          },
        }),
      ),
    ).resolves.toEqual({
      type: "inputAccepted",
      delivery: "queue",
      inputId: "cmd-1",
    });

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "controller 同步前也要排队" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          highspeed: expect.objectContaining({ cardId: "card-1" }),
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    // 入队只下发普通 Selection 与卡元数据，不下发 execution 与凭据，仍按普通轮做 Session 模型
    // preflight：卡失效后提升使用 QueueItem 的普通 Selection，模型不可用必须在 admission 就暴露。
    expect(listModels).toHaveBeenCalled();
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("modelExecution");
    expect(retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      },
      modelExecution: expect.objectContaining({ selectionScope: "execution" }),
    });
  });

  it("execution-scoped Selection 直接进入 Core，Session 模型从不临时切换", async () => {
    const order: string[] = [];
    const currentModel = "user-provider/user-model";
    let capturedOptions: SendInputOptions | undefined;
    let finishTurn!: () => void;
    const turnGate = new Promise<Record<string, never>>((resolve) => {
      finishTurn = () => resolve({});
    });
    const app = makeApp({
      getModel: vi.fn(() => currentModel),
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        capturedOptions = options;
        order.push(`send:${currentModel}`);
        return {
          completion: turnGate,
          kind: "started_turn",
          turnId: "turn-offpeak",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      afterLegacyStateMutation: vi.fn().mockImplementation(async () => {
        order.push(`ready:${currentModel}`);
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "run in idle pool",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
        modelExecution: {
          memoryExtraction: "skip",
          selectionScope: "execution",
          requestAuth: {
            apiKey: "request-key",
            headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
          },
          subagents: {
            foregroundModel: "submission",
            background: "deny",
          },
        },
      }),
    );
    expect(record.activeAbortController).toBeUndefined();

    finishTurn();
    await settle();

    expect(order).toEqual(["send:user-provider/user-model", "ready:user-provider/user-model"]);
    expect(capturedOptions?.intent?.modelSelection).toEqual({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
    });
    expect(capturedOptions?.modelExecution).toMatchObject({
      memoryExtraction: "skip",
      selectionScope: "execution",
      subagents: { foregroundModel: "submission", background: "deny" },
    });
    await expect(
      capturedOptions?.modelExecution?.requestDependencies?.requestAuth?.source?.resolve({}),
    ).resolves.toEqual({
      apiKey: "request-key",
      headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
    });
    expect(record.activeAbortController).toBeUndefined();
  });

  it("execution-scoped Selection 不受 Session 模型恢复告警阻断", async () => {
    const app = makeApp();
    const record = makeRecord({
      app,
      restoreWarning: { message: "session model unavailable", type: "model_unavailable" },
    });
    const host = makeHost(record, {
      hasUsableRuntimeModelTarget: vi.fn().mockReturnValue(false),
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "run in idle pool",
          modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: "request-key" },
          },
        }),
      ),
    ).resolves.toBeDefined();
    await settle();

    expect(record.restoreWarning).toEqual({
      message: "session model unavailable",
      type: "model_unavailable",
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "execution-scoped turn %s 后不污染下一条普通 prompt",
    async (outcome) => {
      const observedExecutionContexts: unknown[] = [];
      let sendCount = 0;
      const app = makeApp({
        sendInput: vi.fn().mockImplementation(async (_input, options) => {
          sendCount += 1;
          observedExecutionContexts.push(options?.modelExecution);
          if (sendCount === 1) {
            return {
              completion: Promise.reject(
                new DOMException(
                  outcome === "cancelled" ? "idle turn cancelled" : "idle turn failed",
                  outcome === "cancelled" ? "AbortError" : "Error",
                ),
              ),
              kind: "started_turn",
              turnId: `turn-${outcome}`,
            };
          }
          return {
            completion: Promise.resolve({}),
            kind: "started_turn",
            turnId: "turn-ordinary",
          };
        }),
      });
      const record = makeRecord({ app });
      const host = makeHost(record);

      await new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "idle prompt",
          modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: `ticket-${outcome}` },
          },
        }),
      );
      await settle();

      expect(record.activeAbortController).toBeUndefined();

      await new V4CommandExecutor(host).execute(envelope("sendText", { text: "ordinary prompt" }));
      await settle();

      expect(observedExecutionContexts[0]).toBeDefined();
      expect(observedExecutionContexts[1]).toBeUndefined();
    },
  );

  it("automation sendText 仅在当前 turn 隐藏全部 automation 写工具", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "automation prompt",
        automationId: "automation-1",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-1",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt" },
        },
      }),
    );
    await settle();
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "normal prompt" }));
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
      }),
    );
    expect(app.sendInput.mock.calls[0]?.[1]?.intent).not.toHaveProperty("highspeed");
    // 定时执行身份优先：加速 Selection 与执行材料必须在 admission 前被整体丢弃。intent 仍会
    // 固化本会话常驻 Selection（普通轮的通用行为），但绝不能是加速卡 Provider，否则本轮会
    // 拿加速卡凭据发请求，或把普通输出持久化成 Highspeed 消息。
    expect(app.sendInput.mock.calls[0]?.[1]?.intent?.modelSelection).toEqual({
      providerId: "account:bigmodel-start-plan",
      modelId: "glm-5",
    });
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("modelExecution");
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("toolDisallowlist");
    expect(record.activeAutomationId).toBeUndefined();
  });

  it("Highspeed 用户 turn 保留 CronCreate 工具可见性", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "加速期间创建一个定时任务",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-1",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt" },
        },
      }),
    );
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "加速期间创建一个定时任务" },
      expect.not.objectContaining({ toolDisallowlist: expect.anything() }),
    );
  });

  it("Bot delivery target 仅在当前 turn 可见，并在 turn 结束后恢复", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        completion: turnGate,
        kind: "started_turn",
        turnId: "turn-bot",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    const botDeliveryTarget = {
      provider: "weixin" as const,
      botId: "bot-weixin",
      providerUserId: "chat-1",
      chatType: "private" as const,
    };

    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "创建提醒", botDeliveryTarget }),
    );
    expect(record.activeBotDeliveryTarget).toEqual(botDeliveryTarget);
    releaseTurn();
    await settle();
    expect(record.activeBotDeliveryTarget).toBeUndefined();
  });

  it("off-peak sendText 保留本轮归因与独立创建限制，普通后续轮不继承", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "off-peak prompt",
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "resume",
      }),
    );
    await settle();
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "manual follow-up" }));
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "resume",
      }),
    );
    // 闲时支持 SendMessage；独立工作流无法继承票据，执行与修改入口继续限制。
    // Host 的额外 denylist 另行合并。
    expect(app.sendInput.mock.calls[0]?.[1].toolDisallowlist).toEqual([
      "OffPeakCreate",
      "Workflow",
      "CreateWorkflow",
      "AmendWorkflow",
      "ResumeWorkflowRun",
      "EvalWorkflowSnippet",
    ]);
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("offPeakTaskId");
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("offPeakRunType");
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("toolDisallowlist");
  });

  it("调用方伪造 automation inputId 时不恢复任务身份", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute({
      ...envelope("sendText", { text: "ordinary prompt" }),
      commandId: "automation-other-task:manual:forged-run",
    });
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("automationId");
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("toolDisallowlist");
    expect(record.activeAutomationId).toBeUndefined();
  });

  it("cron task 普通 sendText 隐藏 CronCreate 但不进入 automation 派发态", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "拒绝删除旧任务后继续设置新提醒",
        toolDisallowlist: ["CronCreate"],
      }),
    );
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ toolDisallowlist: ["CronCreate"] }),
    );
    expect(record.activeAutomationId).toBeUndefined();
  });

  it("运行中会话：Bootstrap 仍走 Core admission，由 Core 返回 queue receipt", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-followup",
        queueLength: 1,
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "追加",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        mode: "plan",
      }),
    );
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "追加" },
      expect.objectContaining({
        delivery: "start_turn",
        inputId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          queueItemId: "queue_cmd-1",
          clientId: "client-test",
          modelSelection: {
            providerId: "provider-b",
            modelId: "model-b",
            options: { reasoningLevel: "high" },
          },
          mode: "build",
          planEnabled: true,
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  // 立即发送是用户的新指令：实际抢占旧执行后，输入仍是普通用户消息，与空闲时发送相同。
  it.each([
    { stopKind: "stopped", attachmentMime: undefined },
    { stopKind: "idle", attachmentMime: undefined },
    { stopKind: "stopped", attachmentMime: "text/plain" },
  ])(
    "startNow 抢占后仍是普通用户输入：$stopKind / $attachmentMime",
    async ({ stopKind, attachmentMime }) => {
      const app = makeApp({
        runtime: {
          acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
          getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
          releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
          stopActiveForegroundExecution: vi
            .fn()
            .mockReturnValue(
              stopKind === "stopped"
                ? { kind: "stopped", foregroundExecutionId: "foreground-1" }
                : { kind: "idle" },
            ),
        },
      });
      // UI 即使仍显示 busy，Core 的 idle 回执也不能被猜成一次抢占。
      const host = makeHost(makeRecord({ app }), { getInputRoutingMode: () => "enqueue" });
      await new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "先处理这个短任务",
          requestedDelivery: "startNow",
          ...(attachmentMime
            ? {
                attachments: [
                  { ref: "/tmp/note", fileName: "note", mime: attachmentMime, bytes: 9 },
                ],
              }
            : {}),
        }),
      );
      expect(app.sendInput).toHaveBeenCalledTimes(1);
      const [input, options] = app.sendInput.mock.calls[0]!;
      expect(input.text).toBe("先处理这个短任务");
      expect(options).not.toHaveProperty("inputPresentation");
      expect(options).toMatchObject({
        inputId: "cmd-1",
        requireIdle: true,
        intent: { requestedDelivery: "startNow" },
      });
    },
  );

  it("抢占后的 startNow 经真实 input facade 以普通用户输入进入新轮 Core admission", async () => {
    const runtime = {
      acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
      getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
      releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
      stopActiveForegroundExecution: vi
        .fn()
        .mockReturnValue({ kind: "stopped", foregroundExecutionId: "foreground-1" }),
      admitPrompt: vi
        .fn()
        .mockResolvedValue({ kind: "started", turnId: "turn-2", completion: Promise.resolve({}) }),
    };
    const facade = createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary: async () => {},
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });
    const app = makeApp({ runtime, sendInput: facade.sendInput });
    await new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(
      envelope("sendText", { text: "短任务", requestedDelivery: "startNow" }),
    );
    expect(runtime.admitPrompt).toHaveBeenCalledWith(
      "短任务",
      undefined,
      expect.objectContaining({
        inputId: "cmd-1",
        requireIdle: true,
        delivery: "start_turn",
      }),
    );
    expect(runtime.admitPrompt.mock.calls[0]![2]).not.toHaveProperty("inputPresentation");
  });

  it("运行中 startNow：原子抢占后直接启动新 turn，不创建 queue item", async () => {
    const controller = new AbortController();
    const acquireForegroundPromotionLease = vi.fn().mockReturnValue({ kind: "acquired" });
    const releaseForegroundPromotionLease = vi.fn().mockReturnValue(true);
    const app = makeApp({
      runtime: {
        acquireForegroundPromotionLease,
        getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
        releaseForegroundPromotionLease,
        stopActiveForegroundExecution: vi.fn().mockReturnValue({ kind: "idle" }),
      },
    });
    const record = makeRecord({ app, activeAbortController: controller });
    controller.signal.addEventListener("abort", () => {
      record.activeAbortController = undefined;
    });

    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("sendText", { text: "现在执行", requestedDelivery: "startNow" }),
    );

    expect(acquireForegroundPromotionLease).toHaveBeenCalledWith({
      leaseId: "send-now:cmd-1",
      mode: "after-current",
      promotedInputId: "cmd-1",
    });
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "现在执行" },
      expect.objectContaining({
        requireIdle: true,
        intent: expect.objectContaining({
          admittedDelivery: "startNow",
          requestedDelivery: "startNow",
          sourceCommandId: "cmd-1",
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
    expect(releaseForegroundPromotionLease).toHaveBeenCalledWith("send-now:cmd-1");
  });

  it("伪造 automation inputId 排队时仍保持普通用户轮", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-ordinary-followup",
        queueLength: 1,
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute({
      ...envelope("sendText", { text: "ordinary followup" }),
      commandId: "automation-other-task:manual:forged-run",
    });

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "ordinary followup" },
      expect.objectContaining({
        delivery: "start_turn",
        inputId: "automation-other-task:manual:forged-run",
      }),
    );
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("automationId");
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("toolDisallowlist");
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it.each([
    "account:bigmodel-start-plan/glm-5",
    "custom-openai/gpt-5",
    "anthropic/claude-sonnet-4-5",
  ])("guide eligible：running + 无普通 queue 时模型 %s 按 guide 投递", async (model) => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-guide",
        queueLength: 1,
        turnId: "turn-1",
      }),
      getModel: vi.fn().mockReturnValue(model),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue({ steerable: true }) },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, {
      getInputRoutingMode: () => "guide",
      hasQueuedDelivery: () => false,
    });

    const [providerId, ...modelSegments] = model.split("/");
    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "引导当前工作",
        modelSelection: { providerId, modelId: modelSegments.join("/") },
        mode: "build",
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "引导当前工作" },
      expect.objectContaining({
        delivery: "start_turn",
        queueDelivery: "guide",
        intent: expect.objectContaining({
          requestedDelivery: "guide",
          admittedDelivery: "guide",
          modelSelection: { providerId, modelId: modelSegments.join("/") },
          mode: "build",
        }),
      }),
    );
    expect(app.getModel).not.toHaveBeenCalled();
  });

  it.each([
    {
      routingMode: "enqueue" as const,
      requestedDelivery: "guide" as const,
      expectedQueueDelivery: "guide" as const,
    },
    {
      routingMode: "guide" as const,
      requestedDelivery: "queue" as const,
      expectedQueueDelivery: undefined,
    },
  ])(
    "one-message $requestedDelivery overrides session routing $routingMode",
    async ({ routingMode, requestedDelivery, expectedQueueDelivery }) => {
      const app = makeApp({
        sendInput: vi.fn().mockResolvedValue({
          kind: "queued",
          pendingInputId: "pending-delivery-override",
          queueLength: 1,
          turnId: "turn-1",
        }),
      });
      const record = makeRecord({ app, activeAbortController: new AbortController() });
      const host = makeHost(record, { getInputRoutingMode: () => routingMode });

      await new V4CommandExecutor(host).execute(
        envelope("sendText", { text: "只反转这一条", requestedDelivery }),
      );

      expect(app.sendInput).toHaveBeenCalledWith(
        { text: "只反转这一条" },
        expect.objectContaining({
          delivery: "start_turn",
          ...(expectedQueueDelivery ? { queueDelivery: expectedQueueDelivery } : {}),
          intent: expect.objectContaining({
            requestedDelivery,
            admittedDelivery: requestedDelivery,
          }),
        }),
      );
      if (!expectedQueueDelivery) {
        expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("queueDelivery");
      }
    },
  );

  it("guide intent 交给 Core，由 Core 决定 guide 或 queue", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-guide-fallback",
        queueLength: 2,
        turnId: "turn-1",
      }),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue({ steerable: true }) },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, {
      getInputRoutingMode: () => "guide",
      hasQueuedDelivery: (_sessionId, delivery) => delivery === "queue",
    });

    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "回退内容" }));

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "回退内容" },
      expect.objectContaining({
        delivery: "start_turn",
        queueDelivery: "guide",
        intent: expect.objectContaining({
          requestedDelivery: "guide",
          admittedDelivery: "guide",
        }),
      }),
    );
  });

  it("goal verifier busy routing 早于 controller：进入 deferred queue，不误起第二条 turn", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-deferred-1",
        queueLength: 1,
        turnId: "turn-1",
      }),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue(undefined) },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "enqueue" });
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "验证期间追加" }));
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "验证期间追加" },
      expect.objectContaining({
        delivery: "start_turn",
        inputId: "cmd-1",
        queryId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          queueItemId: "queue_cmd-1",
          requestedDelivery: "queue",
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it("automation 在 busy routing 入队时保留全部写工具 denylist", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-automation-1",
        queueLength: 1,
        turnId: "turn-1",
      }),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue(undefined) },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "enqueue" });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "automation busy prompt",
        automationId: "automation-1",
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "automation busy prompt" },
      expect.objectContaining({
        automationId: "automation-1",
        delivery: "start_turn",
        inputId: "cmd-1",
        queryId: "cmd-1",
        toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it("empty/oversize admission 显式失败，不返回 accepted 后静默丢输入", async () => {
    const idle = makeRecord({ app: makeApp() });
    await expect(
      new V4CommandExecutor(makeHost(idle)).execute(envelope("sendText", { text: "   " })),
    ).rejects.toMatchObject({ reasonCode: "proto.invalidPayload" });

    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "rejected",
        reason: "input_too_large",
      }),
    });
    const busy = makeRecord({ app, activeAbortController: new AbortController() });
    await expect(
      new V4CommandExecutor(makeHost(busy)).execute(envelope("sendText", { text: "oversized" })),
    ).rejects.toBeInstanceOf(V4PromptRejectedError);
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it("draft 会话：首条发送把 persistence 提升为 immediate", async () => {
    const record = makeRecord({ persistence: "deferred" });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("sendText", { text: "首条" }));
    expect(record.persistence).toBe("immediate");
  });

  it("restoreWarning 会话：拒绝新 turn（历史损坏不静默续写）", async () => {
    const record = makeRecord({
      restoreWarning: { message: "restore failed", type: "corrupt" },
    });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(envelope("sendText", { text: "x" })),
    ).rejects.toThrow(V4PromptRejectedError);
  });

  it("restoreWarning 时序自愈：进程 Registry 已有可用模型 → 清告警放行", async () => {
    // 场景：app 重启后冷恢复跑在 provider registry 推送之前，record 挂上「模型
    // 不可解析」告警；registry 随后到达（宿主探针判可用），发送不得再被这个
    // 过期的一次性标志永久拒绝。
    const app = makeApp();
    const record = makeRecord({
      app,
      restoreWarning: {
        message: "runtime model unavailable",
        type: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
      },
    });
    await new V4CommandExecutor(
      makeHost(record, { hasUsableRuntimeModelTarget: () => true }),
    ).execute(envelope("sendText", { text: "重启后第一条" }));
    await settle();
    expect(record.restoreWarning).toBeUndefined();
    expect(app.sendInput).toHaveBeenCalled();
  });

  it("restoreWarning 保真：catalog 仍无可用模型 → 继续拒绝（不误放行）", async () => {
    const record = makeRecord({
      restoreWarning: {
        message: "runtime model unavailable",
        type: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
      },
    });
    await expect(
      new V4CommandExecutor(makeHost(record, { hasUsableRuntimeModelTarget: () => false })).execute(
        envelope("sendText", { text: "x" }),
      ),
    ).rejects.toThrow(V4PromptRejectedError);
    expect(record.restoreWarning).toBeDefined();
  });

  it("普通 Selection 不在 Worker Registry 时在 ACK 前拒绝并保留输入", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用新 Provider",
          modelSelection: { providerId: "new-provider", modelId: "new-model" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("无退回声明的 execution Selection 不在 Registry 时仍在 ACK 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用不可退回的执行模型",
          modelSelection: { providerId: "new-provider", modelId: "new-model" },
          modelExecution: { selectionScope: "execution" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("带同 Provider 退回声明且退回目标可用时，execution Selection 延迟到 Core 解析", async () => {
    const app = makeApp({
      listModels: () => [
        {
          ref: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
        },
      ],
    });
    const record = makeRecord({ app });
    const selectionFallback = {
      providerId: "account:bigmodel-highspeed-card",
      rules: [{ reason: "highspeed_selection_unavailable" as const }],
      target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
    };

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用可退回的执行模型",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: { selectionScope: "execution", selectionFallback },
        }),
      ),
    ).resolves.toBeDefined();
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "使用可退回的执行模型" },
      expect.objectContaining({
        intent: expect.objectContaining({
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
        }),
        modelExecution: expect.objectContaining({
          selectionScope: "execution",
          selectionFallback,
        }),
      }),
    );
  });

  it("Highspeed execution Selection 可用时不因退回目标缺失而拒绝", async () => {
    const highspeedSelection = {
      providerId: "account:bigmodel-highspeed-card",
      modelId: "GLM-5.3",
    };
    const app = makeApp({
      listModels: () => [{ ref: highspeedSelection }],
    });
    const record = makeRecord({ app });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "执行模型可用时继续发送",
          modelSelection: highspeedSelection,
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: highspeedSelection.providerId,
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "missing-fallback", modelId: "missing-model" },
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("Highspeed execution Selection 与退回目标都不在 Registry 时在 ACK 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "双模型都不可用时保留输入",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("退回声明与 execution Provider 不一致时仍在 ACK 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用声明不一致的执行模型",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: "other-provider",
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("排队 execution Selection 仍按原模型目录做 admission 预检", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    await expect(
      new V4CommandExecutor(makeHost(record, { getInputRoutingMode: () => "enqueue" })).execute(
        envelope("sendText", {
          text: "排队执行模型",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("turn 失败：finally 仍释放锁，legacy 广播 reason=prompt_failed", async () => {
    const app = makeApp({ sendInput: vi.fn().mockRejectedValue(new Error("boom")) });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await expect(
      new V4CommandExecutor(host).execute(envelope("sendText", { text: "x" })),
    ).rejects.toThrow("boom");
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual(["prompt_failed"]);
  });
});

describe("v4 原生 sendText：软门禁（soft gate）", () => {
  it("startPromptTurn 不再把 authority observer 传给 Core admission", async () => {
    let capturedOptions: PromptSendInputOptions | undefined;
    const app = makeApp({
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        capturedOptions = options as PromptSendInputOptions;
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-1",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "test" }));
    await settle();

    // projection observer 已移除，Core admission ACK 不等待 TurnStarted。
    expect(capturedOptions!.onEvent).toBeUndefined();
    expect(capturedOptions!.onTurnStartedObserved).toBeUndefined();
  });

  it("projection commit 永不完成时，input ACK 仍立即返回", async () => {
    const turnGate = deferred<void>();
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        completion: turnGate.promise,
        kind: "started_turn",
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      waitForProjectionEventCommit: async () => {
        await new Promise<void>(() => {});
      },
    });

    const executing = new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "等待 projection commit" }),
    );

    await vi.waitFor(() => expect(app.sendInput).toHaveBeenCalled());
    await flushMicrotasks();
    // projection commit 完全不参与 admission；故意不 resolve 它。
    await executing;
    turnGate.resolve(undefined);
    await settle();
  });

  it("回归：TurnStarted 后 projection 延迟时，第二条只产生一个 Core queue item", async () => {
    const admissions: Array<"started" | "queued"> = [];
    const runtime = {
      // Bootstrap 不再查询 activeTurn；Core admission 自己持有 starting/active 状态。
      getActiveTurnInfo: vi.fn(),
    };
    const sendInput = vi.fn().mockImplementation(async () => {
      const admission = admissions.length === 0 ? "started" : "queued";
      admissions.push(admission);
      return admission === "started"
        ? { kind: "accepted", delivery: "startNow", inputId: `cmd-${admissions.length}` }
        : {
            kind: "queued",
            pendingInputId: "pending-stalled-followup",
            queueLength: 1,
            turnId: "turn-stalled-before-model",
          };
    });
    const app = makeApp({ sendInput, runtime });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "startNow",
      waitForProjectionEventCommit: vi.fn(() => new Promise<void>(() => {})),
    });
    const executor = new V4CommandExecutor(host);

    const first = executor.execute(envelope("sendText", { text: "触发卡住的首条" }));
    await flushMicrotasks();
    const second = executor.execute(envelope("sendText", { text: "卡住期间的下一条" }));
    await Promise.all([first, second]);

    expect(admissions).toEqual(["started", "queued"]);
    expect(runtime.getActiveTurnInfo).not.toHaveBeenCalled();
  });
});

describe("v4 原生 sendText：held choice 裁决（catalog B06/B07）", () => {
  it("held（routing=choice）缺 disposition → 拒绝 heldQueueDispositionRequired", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "choice" });
    await expect(
      new V4CommandExecutor(host).execute(envelope("sendText", { text: "x" })),
    ).rejects.toMatchObject({ reasonCode: "heldQueueDispositionRequired" });
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(app.clearQueueItems).not.toHaveBeenCalled();
  });

  it("held + clearQueueAndSend → 先清空 queue 再起 turn", async () => {
    const calls: string[] = [];
    const app = makeApp({
      clearQueueItems: vi.fn().mockImplementation(async () => {
        calls.push("clear");
        return 2;
      }),
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        calls.push("send");
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-held-clear",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "choice" });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "新问题", heldQueueDisposition: "clearQueueAndSend" }),
    );
    await settle();
    expect(calls).toEqual(["clear", "send"]);
  });

  it("held + startNow + clearQueueAndSend → 仍先清空 queue 再起 turn", async () => {
    const calls: string[] = [];
    const app = makeApp({
      clearQueueItems: vi.fn().mockImplementation(async () => {
        calls.push("clear");
        return 2;
      }),
      runtime: {
        acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
        getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
        releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
        stopActiveForegroundExecution: vi.fn().mockReturnValue({ kind: "idle" }),
      },
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        calls.push("send");
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-held-start-now",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem: (_sessionId, queueItemId) => ({ queueItemId }) as never,
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "新问题",
        requestedDelivery: "startNow",
        heldQueueDisposition: "clearQueueAndSend",
        expectedHeldQueueItemIds: ["q-1", "q-2"],
      }),
    );
    await settle();

    expect(calls).toEqual(["clear", "send"]);
  });

  it("held + startNow 的 queue ids 过期时拒绝清空和启动 turn", async () => {
    const app = makeApp({
      clearQueueItems: vi.fn().mockResolvedValue(0),
      runtime: {
        acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
        releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
      },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem: (_sessionId, queueItemId) =>
        queueItemId === "q-1" ? ({ queueItemId } as never) : null,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "新问题",
          requestedDelivery: "startNow",
          heldQueueDisposition: "clearQueueAndSend",
          expectedHeldQueueItemIds: ["q-1"],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.heldQueueConfirmationStale" });
    expect(app.clearQueueItems).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("held + keepQueueAndSend → 不清 queue 直接起 turn", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "choice" });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "新问题", heldQueueDisposition: "keepQueueAndSend" }),
    );
    await settle();
    expect(app.clearQueueItems).not.toHaveBeenCalled();
    expect(app.sendInput).toHaveBeenCalled();
  });

  it("held 确认绑定 queueItemId 集合：跨端增删后拒绝旧确认且不清空/发送", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const getQueueItem = vi.fn((_sessionId: string, queueItemId: string) =>
      queueItemId === "q-1" ? ({ queueItemId } as never) : null,
    );
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem,
    });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "新问题",
          heldQueueDisposition: "clearQueueAndSend",
          expectedHeldQueueItemIds: ["q-1"],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.heldQueueConfirmationStale" });
    expect(app.clearQueueItems).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("held 确认的 ID 集合未变化时允许执行；重排不使确认失效", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(2) });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem: (_sessionId, queueItemId) => ({ queueItemId }) as never,
    });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "新问题",
        heldQueueDisposition: "clearQueueAndSend",
        expectedHeldQueueItemIds: ["q-2", "q-1"],
      }),
    );
    await settle();
    expect(app.clearQueueItems).toHaveBeenCalledTimes(1);
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("非 held（routing=startNow）缺 disposition → 正常起 turn（不误拒）", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "startNow" });
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "x" }));
    await settle();
    expect(app.sendInput).toHaveBeenCalled();
    expect(app.clearQueueItems).not.toHaveBeenCalled();
  });
});

describe("v4 原生 stop", () => {
  it("active turn + active goal：先 pause goal 再 abort（barrier 顺序）", async () => {
    const calls: string[] = [];
    const app = makeApp({
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
      updateTargetStatus: vi.fn().mockImplementation(async () => {
        calls.push("pause");
        return { targetID: "g1", status: "paused" };
      }),
    });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => calls.push("abort"));
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("stop", {}));
    expect(calls).toEqual(["pause", "abort"]);
    expect(host.legacyMutations).toEqual(["session_stop_goal_paused"]);
  });

  it("无 active turn：不触碰 goal，abort 为 noop", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("stop", {}));
    expect(app.readTarget).not.toHaveBeenCalled();
    expect(host.legacyMutations).toEqual([]);
  });

  it("pause goal 抛错：不阻断 abort（stop 必须成功）", async () => {
    const app = makeApp({
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
      updateTargetStatus: vi.fn().mockRejectedValue(new Error("verifier busy")),
    });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("stop", {}));
    expect(controller.signal.aborted).toBe(true);
  });

  it("goal verifier：先取消 runtime 前台执行，再暂停 goal 并关闭外层窗口", async () => {
    const calls: string[] = [];
    const setQueueAutoDrain = vi.fn().mockImplementation(async () => {
      calls.push("hold-queue");
    });
    const stopActiveForegroundExecution = vi.fn().mockImplementation(() => {
      calls.push("runtime-abort");
      return { kind: "stopped", foregroundExecutionId: "foreground-1" };
    });
    const app = makeApp({
      runtime: { stopActiveForegroundExecution },
      setQueueAutoDrain,
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
      updateTargetStatus: vi.fn().mockImplementation(async () => {
        calls.push("pause");
        return { targetID: "g1", status: "paused" };
      }),
    });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => calls.push("outer-abort"));
    const record = makeRecord({ app, activeAbortController: controller });
    const info = vi.fn();

    await new V4CommandExecutor(
      makeHost(record, {
        getQueueLength: () => 1,
        logger: { info } as never,
      }),
    ).execute(envelope("stop", { expectedForegroundExecutionId: "foreground-1" }));

    expect(stopActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: "foreground-1",
      reason: "v4 session stopped",
    });
    expect(setQueueAutoDrain).toHaveBeenCalledWith(false);
    expect(calls).toEqual(["runtime-abort", "outer-abort", "hold-queue", "pause"]);
    expect(info).toHaveBeenCalledWith("v4 stop foreground execution inspected", {
      activeForegroundExecutionId: "foreground-1",
      event: "v4.stop.foreground_execution_inspected",
      expectedForegroundExecutionId: "foreground-1",
      module: "bootstrap.zcode_protocol_v4.commands",
      runtimeStopKind: "stopped",
      sessionId: "s1",
    });
  });

  it("迟到 Stop 的 execution id 已变化：返回 noop，且不误杀新执行", async () => {
    const stopActiveForegroundExecution = vi.fn().mockReturnValue({
      kind: "mismatch",
      activeForegroundExecutionId: "foreground-2",
    });
    const app = makeApp({ runtime: { stopActiveForegroundExecution } });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.stopTargetChanged" });
    expect(controller.signal.aborted).toBe(false);
    expect(app.readTarget).not.toHaveBeenCalled();
  });
});

describe("supports 分流", () => {
  it("协议命令全部原生（回落面清零）；未知命令不 supports", () => {
    const executor = new V4CommandExecutor(makeHost(makeRecord()));
    // 与 packages/shared/src/zcode-protocol-v4/command.ts 的 payload map 同步维护。
    const allCommands = [
      "createSession",
      "sendText",
      "sendGoalCommand",
      "stop",
      "compact",
      "forkAssistant",
      "applyFileRewind",
      "editUserQuery",
      "retryTurn",
      "setAssistantFeedback",
      "setHighspeedMetrics",
      "sendQueuedNow",
      "editQueueItem",
      "applyQueueItemsConfig",
      "lockQueueItemEdit",
      "releaseQueueItemEdit",
      "reorderQueueItem",
      "deleteQueueItem",
      "setAutoDrain",
      "resolveInteraction",
      "snoozeInteractionAutoResolution",
      "switchModelConfig",
      "setFollowupMode",
      "resumeGoal",
      "cancelBackgroundWork",
      "renameSession",
      "deleteSession",
    ] as const;
    for (const command of allCommands) {
      expect(executor.supports(command), command).toBe(true);
    }
    expect(executor.supports("unknownCommand" as never)).toBe(false);
  });
});

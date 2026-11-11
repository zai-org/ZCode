import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createWorkspaceHookBundleSnapshot,
  type WorkspaceHookBundleSnapshot,
  type Logger,
} from "@zcode/contracts";
import {
  InMemoryWorkspaceHookPolicyProvider,
  WorkspaceHookTrustCoordinator,
  createWorkspaceHookRuntimeAdmission,
} from "@zcode/core";
import {
  WorkspaceHookReviewController,
  type WorkspaceHookReviewLifecycleEvent,
} from "../src/app/workspace-hook-review-controller.js";
import { toWorkspaceHookReviewTarget } from "../src/app/workspace-hook-review-request.js";

const WORKSPACE = "local:/workspace";
const DIGEST = "a".repeat(64);

function snapshot(
  input: {
    bundle?: string;
    enabled?: boolean;
    includeDisabledSecond?: boolean;
  } = {},
): WorkspaceHookBundleSnapshot {
  const enabled = input.enabled ?? true;
  return createWorkspaceHookBundleSnapshot({
    schemaVersion: 1,
    workspaceIdentity: WORKSPACE,
    discoveredAt: "2026-08-06T00:00:00.000Z",
    sourceFiles: [
      {
        canonicalPath: "/workspace/.zcode/config.json",
        baseDir: "/workspace",
        discoveryOrder: 0,
        configFileKind: ".zcode/config.json",
        explicitProjectConfig: false,
        editable: true,
        hooksRoot: { enabled: true },
      },
    ],
    hooks: [
      {
        reviewItemId: "item-0",
        event: "SessionStart",
        matcherIndex: 0,
        hookIndex: 0,
        sourceFileIndex: 0,
        sourceRelativePath: ".zcode/config.json",
        matcher: "startup",
        type: "command",
        command: "echo project",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        sourceRootEnabled: enabled,
        declarationEnabled: enabled,
        runtimeHooksEnabled: true,
        configuredEnabled: enabled,
        editable: true,
        declarationDigestAlgorithm: "sha256",
        hookDeclarationDigest: DIGEST,
      },
      ...(input.includeDisabledSecond
        ? [
            {
              reviewItemId: "item-1",
              event: "UserPromptSubmit" as const,
              matcherIndex: 0,
              hookIndex: 1,
              sourceFileIndex: 0,
              sourceRelativePath: ".zcode/config.json",
              matcher: null,
              type: "command" as const,
              command: "echo disabled-project",
              resolvedTimeoutMs: 60_000,
              resolvedMaxOutputBytes: 32_768,
              sourceRootEnabled: true,
              declarationEnabled: false,
              runtimeHooksEnabled: true,
              configuredEnabled: false,
              editable: true,
              declarationDigestAlgorithm: "sha256" as const,
              hookDeclarationDigest: "d".repeat(64),
            },
          ]
        : []),
    ],
    digestAlgorithm: "sha256",
    bundleDigest: input.bundle ?? "b".repeat(64),
  });
}

function fixture(
  input: {
    nextSnapshot?: WorkspaceHookBundleSnapshot;
    initialSnapshot?: WorkspaceHookBundleSnapshot;
    rebuildError?: Error;
    policyProvider?: InMemoryWorkspaceHookPolicyProvider;
    resolveTargetTrustIdentity?: (workspaceIdentity: string) => Promise<string>;
    workspaceKey?: string;
  } = {},
) {
  const coordinator = new WorkspaceHookTrustCoordinator({
    coordinatorEpoch: "epoch-1",
    ...(input.policyProvider ? { policyProvider: input.policyProvider } : {}),
  });
  coordinator.replacePersistentTrustRecords([], { status: "missing" });
  const initial = input.initialSnapshot ?? snapshot();
  let controller!: WorkspaceHookReviewController;
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    enabled: true,
    ready: Promise.resolve(),
    snapshot: initial,
  });
  const events: WorkspaceHookReviewLifecycleEvent[] = [];
  const telemetry: Array<{
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (message, context) => telemetry.push({ message, context }),
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  let records: any[] = [];
  const store = {
    grant: vi.fn(async (next: any[]) => {
      records = [
        ...records.filter((record) => record.workspaceIdentity !== WORKSPACE),
        ...next,
      ];
      return { schemaVersion: 1 as const, records };
    }),
    revoke: vi.fn(async () => {
      records = [];
      return { schemaVersion: 1 as const, records };
    }),
  };
  const mutation = {
    toggle: vi.fn(async (_input, onWriteCommitted) => {
      await onWriteCommitted();
      if (input.rebuildError) throw input.rebuildError;
      return (
        input.nextSnapshot ??
        snapshot({ bundle: "c".repeat(64), enabled: false })
      );
    }),
  };
  controller = new WorkspaceHookReviewController({
    admission,
    appVersion: "1.0.0",
    coordinator,
    logger,
    host: {
      taskId: "session-1",
      runId: "run-1",
      workspaceLabel: "workspace",
      emit: async (event) => events.push(event),
    },
    mutation,
    sessionId: "session-1",
    store: Promise.resolve(store),
    ...(input.resolveTargetTrustIdentity
      ? { resolveTargetTrustIdentity: input.resolveTargetTrustIdentity }
      : {}),
    ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
  });
  return {
    admission,
    controller,
    coordinator,
    events,
    mutation,
    store,
    telemetry,
  };
}

async function pendingRequest(value: ReturnType<typeof fixture>) {
  // 软门禁的真实生产入口是用户点击 Banner 后调用 requestReview；测试不得再经
  // 已移除接线的 review() 旁路构造 flow，否则 request 幂等与 supervisor 单例会失去覆盖。
  const activation = value.admission.activate("startup");
  const current = value.admission.getCurrentSnapshot();
  await value.controller.requestReview({
    workspaceIdentity: current.workspaceIdentity,
    bundleDigest: current.bundleDigest,
  });
  await vi.waitFor(() => {
    expect(
      value.events.some(
        (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
      ),
    ).toBe(true);
  });
  const event = value.events.find(
    (candidate) =>
      candidate.type === SessionEventType.WorkspaceHookReviewRequested,
  );
  if (!event || !("request" in event.payload))
    throw new Error("expected review request");
  return { activation, request: event.payload.request };
}

describe("WorkspaceHookReviewController", () => {
  it("Settings 可为仅 configured-disabled 的未信任 Hook 按需创建审核 flow", async () => {
    const value = fixture({ initialSnapshot: snapshot({ enabled: false }) });
    const current = value.admission.getCurrentSnapshot();

    await expect(
      value.controller.requestReview({
        workspaceIdentity: current.workspaceIdentity,
        bundleDigest: current.bundleDigest,
      }),
    ).resolves.toMatchObject({ accepted: true });

    const requested = value.events.filter(
      (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toEqual(
      expect.objectContaining({
        payload: {
          request: expect.objectContaining({
            items: [
              expect.objectContaining({
                configuredEnabled: false,
                reviewItemId: "item-0",
                trustState: "pending_trust",
              }),
            ],
            summary: expect.objectContaining({ pendingCount: 1 }),
          }),
        },
      }),
    );
  });

  it("按需请求遇到禁止持久信任的 policy 时立即返回精确拒绝，不等待不存在的 flow", async () => {
    const policyProvider = new InMemoryWorkspaceHookPolicyProvider();
    policyProvider.setWorkspacePolicy(WORKSPACE, {
      mode: "deny",
      reason: "managed",
      policyRevision: "rev-1",
    });
    const value = fixture({ policyProvider });
    const current = value.admission.getCurrentSnapshot();

    await expect(
      value.controller.requestReview({
        workspaceIdentity: current.workspaceIdentity,
        bundleDigest: current.bundleDigest,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_blocked_by_policy",
    });
    expect(
      value.events.filter(
        (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
      ),
    ).toHaveLength(0);
  });

  it("requestReview 连调两次复用同一 flow，不重复 emit Requested", async () => {
    const value = fixture();
    const current = value.admission.getCurrentSnapshot();
    const target = {
      workspaceIdentity: current.workspaceIdentity,
      bundleDigest: current.bundleDigest,
    };

    await expect(value.controller.requestReview(target)).resolves.toMatchObject({ accepted: true });
    await expect(value.controller.requestReview(target)).resolves.toMatchObject({ accepted: true });

    expect(
      value.events.filter((event) => event.type === SessionEventType.WorkspaceHookReviewRequested),
    ).toHaveLength(1);
  });

  it("同一 flow 的重复监管只发一次 ReviewSettled", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      const current = value.admission.getCurrentSnapshot();
      const target = {
        workspaceIdentity: current.workspaceIdentity,
        bundleDigest: current.bundleDigest,
      };

      await value.controller.requestReview(target);
      await value.controller.requestReview(target);
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      expect(
        value.events.filter(
          (event) =>
            event.type === SessionEventType.WorkspaceHookReviewSettled &&
            event.payload.state === "timed_out",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Trust 落盘后即使 deadline 抢先 resolve 也按 accepted 且只发一次 resolved Settled", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture();
      const { request } = await pendingRequest(value);
      let releaseGrant!: () => void;
      const grantGate = new Promise<void>((resolve) => {
        releaseGrant = resolve;
      });
      let markGrantStarted!: () => void;
      const grantStarted = new Promise<void>((resolve) => {
        markGrantStarted = resolve;
      });
      value.store.grant.mockImplementationOnce(async (records) => {
        markGrantStarted();
        await grantGate;
        return { schemaVersion: 1 as const, records };
      });
      const target = {
        sessionId: request.sessionId,
        taskId: request.taskId,
        runId: request.runId,
        workspaceIdentity: request.workspaceIdentity,
        bundleDigest: request.bundleDigest,
        reviewFlowId: request.reviewFlowId,
        generation: request.generation,
        interactionId: request.interactionId,
      };

      const response = value.controller.respond(target, {
        action: "trust_selected",
        reviewItemIds: ["item-0"],
      });
      await grantStarted;
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      releaseGrant();

      await expect(response).resolves.toEqual({ accepted: true, reviewItemIds: ["item-0"] });
      expect(
        value.events.filter(
          (event) =>
            event.type === SessionEventType.WorkspaceHookReviewSettled &&
            event.payload.state === "resolved",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("并发两个 respond 经 mutation queue 串行，第二个 superseded 且 Trust 只落一次", async () => {
    const value = fixture();
    const { request } = await pendingRequest(value);
    let releaseGrant!: () => void;
    const grantGate = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    let markGrantStarted!: () => void;
    const grantStarted = new Promise<void>((resolve) => {
      markGrantStarted = resolve;
    });
    value.store.grant.mockImplementationOnce(async (records) => {
      markGrantStarted();
      await grantGate;
      return { schemaVersion: 1 as const, records };
    });
    const target = {
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      workspaceIdentity: request.workspaceIdentity,
      bundleDigest: request.bundleDigest,
      reviewFlowId: request.reviewFlowId,
      generation: request.generation,
      interactionId: request.interactionId,
    };

    const first = value.controller.respond(target, {
      action: "trust_selected",
      reviewItemIds: ["item-0"],
    });
    const second = value.controller.respond(target, {
      action: "trust_selected",
      reviewItemIds: ["item-0"],
    });
    await grantStarted;
    releaseGrant();

    await expect(first).resolves.toEqual({ accepted: true, reviewItemIds: ["item-0"] });
    await expect(second).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_review_superseded",
    });
    expect(value.store.grant).toHaveBeenCalledTimes(1);
  });

  it("记录 review request 与精确持久信任的安全 telemetry，不包含命令原文", async () => {
    const value = fixture();
    const { activation, request } = await pendingRequest(value);

    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toMatchObject({ accepted: true });
    await activation;

    expect(value.telemetry.map((entry) => entry.context?.event)).toEqual(
      expect.arrayContaining([
        "workspace_hook.review_request_created",
        "workspace_hook.trust_selected",
      ]),
    );
    expect(JSON.stringify(value.telemetry)).not.toContain("echo project");
    expect(JSON.stringify(value.telemetry)).not.toContain("command");
  });

  it("Trust selected 原子写 store 后才提升 coordinator 并 resolve activation", async () => {
    const value = fixture();
    const { activation, request } = await pendingRequest(value);

    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toEqual({ accepted: true, reviewItemIds: ["item-0"] });
    await activation;

    expect(value.store.grant).toHaveBeenCalledTimes(1);
    expect(
      value.coordinator.evaluateSnapshot({
        snapshot: snapshot(),
      }).items[0]?.trustState,
    ).toBe("trusted_persistent");
    expect(value.events.at(-1)?.type).toBe(
      SessionEventType.WorkspaceHookAdmissionUpdated,
    );
    // 软门禁(D2):settle 后追加 AdmissionUpdated(pendingCount=0),但它必须在 ReviewSettled 之后
    expect(value.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([SessionEventType.WorkspaceHookReviewSettled]),
    );
  });

  it("只信任一行后为剩余未信任行发布下一代审核绑定，包括关闭状态的 Hook", async () => {
    const value = fixture({
      initialSnapshot: snapshot({ includeDisabledSecond: true }),
    });
    const { activation, request } = await pendingRequest(value);

    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toEqual({ accepted: true, reviewItemIds: ["item-0"] });
    await activation;

    const requests = value.events.filter(
      (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
    );
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)).toEqual(
      expect.objectContaining({
        payload: {
          request: expect.objectContaining({
            generation: request.generation + 1,
            summary: expect.objectContaining({ pendingCount: 1 }),
            items: [
              expect.objectContaining({
                reviewItemId: "item-0",
                trustState: "trusted_persistent",
              }),
              expect.objectContaining({
                configuredEnabled: false,
                reviewItemId: "item-1",
                trustState: "pending_trust",
              }),
            ],
          }),
        },
      }),
    );
  });

  it("stale generation response 不触发任何 Trust mutation", async () => {
    const value = fixture();
    const { request } = await pendingRequest(value);

    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation + 1,
          interactionId: "stale",
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_review_superseded",
    });
    expect(value.store.grant).not.toHaveBeenCalled();
  });

  it("respond 对 snapshot 与 request 的 bundle digest 不一致 fail closed", async () => {
    // Review 防线（spec D5 watcher 前置）：request 绑定当时的 immutable snapshot bundle。
    // 若 admission snapshot 被替换（当前仅 toggle 经 refreshPendingFlow 合法调用，
    // 未来热监听 watcher 不能绕过），授权不得落到新 bundle 的声明上。
    const value = fixture();
    const { request } = await pendingRequest(value);
    value.admission.replaceSnapshot(snapshot({ bundle: "d".repeat(64) }));

    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(value.store.grant).not.toHaveBeenCalled();
  });

  it("toggle 的 mutation mismatch 不再被误报为 config write 失败（错误归属）", async () => {
    // Bug 原因：controller.toggle 的裸 catch 把 mutation port 抛出的
    // WorkspaceHookMutationError("workspace_hooks_snapshot_mismatch")（如 review 后
    // bundle 已变、discovery 读败）一律吞成 workspace_hooks_config_write_failed。
    // 用户看到"配置写入失败"但写路径根本没走到；真实原因（mismatch）被掩盖，
    // 也断送了 fail-fast 语义（mismatch 应提示刷新而非重试写）。
    const mismatchError = new Error(
      "Workspace Hook bundle changed after review",
    ) as Error & {
      name: string;
      code: string;
    };
    mismatchError.name = "WorkspaceHookMutationError";
    mismatchError.code = "workspace_hooks_snapshot_mismatch";
    const value = fixture();
    const { request } = await pendingRequest(value);
    value.mutation.toggle.mockReset();
    value.mutation.toggle.mockRejectedValueOnce(mismatchError);

    await expect(
      value.controller.toggle(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        "item-0",
        false,
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
  });

  it("policy 在 pending 后收紧时 grant 被显式策略拒绝而非误报存储损坏", async () => {
    // Bug 原因：respond 的 catch-all 曾把 assertPersistentTrustMutationAllowed 的策略
    // 拒绝一律报成 workspace_hooks_trust_store_corrupt（"信任存储损坏"），错误归属错误。
    // 修法与 revoke 路径对齐：grant 前显式检查 policy 并返回精确 reasonCode。
    const policyProvider = new InMemoryWorkspaceHookPolicyProvider();
    const value = fixture({ policyProvider });
    const { request } = await pendingRequest(value);
    policyProvider.setWorkspacePolicy(WORKSPACE, {
      mode: "deny",
      reason: "managed",
      policyRevision: "rev-1",
    });

    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_blocked_by_policy",
    });
    expect(value.store.grant).not.toHaveBeenCalled();
  });

  it("D23：worktree target（workspaceKey）经 resolver 归一后与 Trust identity snapshot 匹配，不再误判 mismatch", async () => {
    const WORKTREE_KEY = "/data/.zcode/worktrees/3f2a/workspace";
    const resolveTargetTrustIdentity = vi.fn(async (identity: string) =>
      identity === WORKTREE_KEY ? WORKSPACE : identity,
    );
    const value = fixture({ resolveTargetTrustIdentity });
    void value.admission.activate("startup");

    await expect(
      value.controller.requestReview({
        workspaceIdentity: WORKTREE_KEY,
        bundleDigest: "b".repeat(64),
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      value.controller.revokeCurrent({
        sessionId: "session-1",
        workspaceIdentity: WORKTREE_KEY,
        bundleDigest: "b".repeat(64),
        hookDeclarationDigests: [DIGEST],
      }),
    ).resolves.toMatchObject({ accepted: true });
    // revoke 写入的仍是 Trust identity（源仓库），不是 worktree 的 workspaceKey。
    expect(value.store.revoke).toHaveBeenCalledWith({
      workspaceIdentity: WORKSPACE,
      hookDeclarationDigests: [DIGEST],
    });
    expect(resolveTargetTrustIdentity).toHaveBeenCalledWith(WORKTREE_KEY);

    // resolver 不认的其他路径仍按 mismatch 拒绝。
    await expect(
      value.controller.requestReview({
        workspaceIdentity: "/other/workspace",
        bundleDigest: "b".repeat(64),
      }),
    ).resolves.toEqual({ accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" });
  });

  it("D23：对外 request 与 AdmissionUpdated 只发会话 workspaceKey，Trust identity 只留在内部", async () => {
    const WORKTREE_KEY = "/data/.zcode/worktrees/3f2a/workspace";
    const value = fixture({
      workspaceKey: WORKTREE_KEY,
      resolveTargetTrustIdentity: async (identity) =>
        identity === WORKTREE_KEY ? WORKSPACE : identity,
    });
    const activation = value.admission.activate("startup");
    // UI Banner 用自己的 workspaceKey（worktree 路径）发起 requestReview。
    await expect(
      value.controller.requestReview({
        workspaceIdentity: WORKTREE_KEY,
        bundleDigest: "b".repeat(64),
      }),
    ).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => {
      expect(
        value.events.some((event) => event.type === SessionEventType.WorkspaceHookReviewRequested),
      ).toBe(true);
    });
    const requested = value.events.find(
      (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
    );
    if (!requested || !("request" in requested.payload)) throw new Error("expected review request");
    const request = requested.payload.request;
    // UI 的 matchesWorkspaceBinding 用 request.workspaceIdentity 与 workspaceKey 比较。
    expect(request.workspaceIdentity).toBe(WORKTREE_KEY);

    // UI 回显 request 构造 respond target：flow 校验通过，Trust 仍写入源仓库 Trust identity。
    await expect(
      value.controller.respond(toWorkspaceHookReviewTarget(request), {
        action: "trust_selected",
        reviewItemIds: ["item-0"],
      }),
    ).resolves.toMatchObject({ accepted: true });
    await activation;
    expect(value.store.grant).toHaveBeenCalledWith([
      expect.objectContaining({ workspaceIdentity: WORKSPACE, hookDeclarationDigest: DIGEST }),
    ]);
    const admissionUpdates = value.events.filter(
      (event) => event.type === SessionEventType.WorkspaceHookAdmissionUpdated,
    );
    expect(admissionUpdates.length).toBeGreaterThan(0);
    for (const event of admissionUpdates) {
      expect(event.payload).toMatchObject({ workspaceIdentity: WORKTREE_KEY });
    }
  });

  it("Settings 可在没有 pending generation 时按当前 snapshot 精确撤销 persistent Trust", async () => {
    const value = fixture();

    await expect(
      value.controller.revokeCurrent({
        sessionId: "session-1",
        workspaceIdentity: WORKSPACE,
        bundleDigest: "b".repeat(64),
        hookDeclarationDigests: [DIGEST],
      }),
    ).resolves.toEqual({ accepted: true, reviewItemIds: ["item-0"] });
    expect(value.store.revoke).toHaveBeenCalledWith({
      workspaceIdentity: WORKSPACE,
      hookDeclarationDigests: [DIGEST],
    });
  });

  it("审核已 resolved 后 revoke 重新开启审核（当前会话可再次授权）", async () => {
    // 回归（2026-08-10 UAT）：授权后面板 resolved 关闭，此时撤销信任，
    // refreshPendingFlow 因「无 pending flow」直接返回，当前会话再无重新授权入口，
    // 用户只能新建对话。撤销的语义是 revoked → admission=pending（spec §10.2），
    // 应当重新征询；且授权仍只能经审核面板完成，不新增直接授予的旁路。
    const value = fixture();
    const { request } = await pendingRequest(value);

    // 先正常授权，让 flow 进入 resolved（面板关闭）。
    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toMatchObject({ accepted: true });

    const requestedAfterTrust = value.events.filter(
      (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
    ).length;

    await expect(
      value.controller.revokeCurrent({
        sessionId: request.sessionId,
        taskId: request.taskId,
        runId: request.runId,
        ...(request.remoteSessionId
          ? { remoteSessionId: request.remoteSessionId }
          : {}),
        workspaceIdentity: request.workspaceIdentity,
        bundleDigest: request.bundleDigest,
        hookDeclarationDigests: [DIGEST],
      }),
    ).resolves.toMatchObject({ accepted: true });

    // 撤销后必须新发一次 ReviewRequested：这正是"立刻弹面板"的可观测判据。
    const requested = value.events.filter(
      (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
    );
    expect(requested.length).toBe(requestedAfterTrust + 1);
    expect(requested.at(-1)).toEqual(
      expect.objectContaining({
        payload: {
          request: expect.objectContaining({
            items: [expect.objectContaining({ trustState: "revoked" })],
          }),
        },
      }),
    );
  });

  it("revoke 新开的 flow 受监管：超时必须发出 ReviewSettled(timed_out)", async () => {
    // 回归（2026-08-11 UAT）：revoke 触发的新 flow 此前不经 review() 监管，
    // 无人 await flow.result —— 10 分钟 deadline 到期后它在 registry 内静默
    // settle 成 timed_out，前端收不到 ReviewSettled、面板继续按 pending 渲染，
    // 之后每次点击都被 validate 判为 review_superseded，面板永久失效。
    vi.useFakeTimers();
    try {
      const value = fixture();
      const { request } = await pendingRequest(value);

      // 先授权，让首个 flow resolved（面板关闭），复现用户的真实前序状态。
      await value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      );

      await value.controller.revokeCurrent({
        sessionId: request.sessionId,
        taskId: request.taskId,
        runId: request.runId,
        ...(request.remoteSessionId
          ? { remoteSessionId: request.remoteSessionId }
          : {}),
        workspaceIdentity: request.workspaceIdentity,
        bundleDigest: request.bundleDigest,
        hookDeclarationDigests: [DIGEST],
      });

      const reopened = value.events
        .filter(
          (event) =>
            event.type === SessionEventType.WorkspaceHookReviewRequested,
        )
        .at(-1);
      expect(reopened).toBeDefined();

      // 推进到 deadline 之后：监管者必须把 timed_out 通知出去，面板才能自愈。
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      const settled = value.events.filter(
        (event) => event.type === SessionEventType.WorkspaceHookReviewSettled,
      );
      expect(settled.at(-1)).toEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: "timed_out",
            reasonCode: "workspace_hooks_interaction_timeout",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("revoke during a pending review supersedes the projected generation", async () => {
    const value = fixture();
    const { request } = await pendingRequest(value);

    await expect(
      value.controller.revokeCurrent({
        sessionId: request.sessionId,
        taskId: request.taskId,
        runId: request.runId,
        ...(request.remoteSessionId
          ? { remoteSessionId: request.remoteSessionId }
          : {}),
        workspaceIdentity: request.workspaceIdentity,
        bundleDigest: request.bundleDigest,
        hookDeclarationDigests: [DIGEST],
      }),
    ).resolves.toEqual({ accepted: true, reviewItemIds: ["item-0"] });

    const requested = value.events.filter(
      (event) => event.type === SessionEventType.WorkspaceHookReviewRequested,
    );
    expect(requested).toHaveLength(2);
    expect(requested.at(-1)).toEqual(
      expect.objectContaining({
        payload: {
          request: expect.objectContaining({
            generation: request.generation + 1,
            items: [expect.objectContaining({ trustState: "revoked" })],
          }),
        },
      }),
    );
    await expect(
      value.controller.respond(
        {
          sessionId: request.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId
            ? { remoteSessionId: request.remoteSessionId }
            : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
        },
        { action: "trust_selected", reviewItemIds: ["item-0"] },
      ),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_review_superseded",
    });
  });

  it("Settings revoke 对 stale bundle 或 snapshot 外 digest fail closed", async () => {
    const value = fixture();

    await expect(
      value.controller.revokeCurrent({
        sessionId: "session-1",
        workspaceIdentity: WORKSPACE,
        bundleDigest: "c".repeat(64),
        hookDeclarationDigests: [DIGEST],
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    await expect(
      value.controller.revokeCurrent({
        sessionId: "session-1",
        workspaceIdentity: WORKSPACE,
        bundleDigest: "b".repeat(64),
        hookDeclarationDigests: ["d".repeat(64)],
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(value.store.revoke).not.toHaveBeenCalled();
  });

  it("toggle 原子写后 supersede old generation 并安装新 immutable snapshot", async () => {
    const next = snapshot({ bundle: "c".repeat(64), enabled: false });
    const value = fixture({ nextSnapshot: next });
    const { request } = await pendingRequest(value);
    const target = {
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      ...(request.remoteSessionId
        ? { remoteSessionId: request.remoteSessionId }
        : {}),
      workspaceIdentity: request.workspaceIdentity,
      bundleDigest: request.bundleDigest,
      reviewFlowId: request.reviewFlowId,
      generation: request.generation,
      interactionId: request.interactionId,
    };

    const result = await value.controller.toggle(target, "item-0", false);

    expect(result.accepted).toBe(true);
    expect(value.mutation.toggle).toHaveBeenCalledWith(
      {
        snapshot: expect.objectContaining({
          bundleDigest: request.bundleDigest,
        }),
        reviewItemId: "item-0",
        enabled: false,
      },
      expect.any(Function),
    );
    expect(value.admission.getCurrentSnapshot().bundleDigest).toBe(
      next.bundleDigest,
    );
    expect(value.events.map((event) => event.type)).toContain(
      SessionEventType.WorkspaceHookReviewSuperseded,
    );
    await expect(
      value.controller.respond(target, {
        action: "trust_selected",
        reviewItemIds: ["item-0"],
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_review_superseded",
    });
  });

  it("atomic write 成功但 rebuild 失败后 invalidates admission 并 fail closed", async () => {
    const value = fixture({ rebuildError: new Error("parse failed") });
    const { request } = await pendingRequest(value);
    const target = {
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      ...(request.remoteSessionId
        ? { remoteSessionId: request.remoteSessionId }
        : {}),
      workspaceIdentity: request.workspaceIdentity,
      bundleDigest: request.bundleDigest,
      reviewFlowId: request.reviewFlowId,
      generation: request.generation,
      interactionId: request.interactionId,
    };

    await expect(
      value.controller.toggle(target, "item-0", false),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_config_rebuild_failed",
    });
    expect(
      value.admission.evaluateDispatch({
        reviewItemId: "item-0",
        hookDeclarationDigest: DIGEST,
      }),
    ).toEqual({
      allowed: false,
      reasonCode: "workspace_hooks_config_rebuild_failed",
    });
    expect(value.events.at(-1)).toEqual(
      expect.objectContaining({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: expect.objectContaining({ state: "configuration_error" }),
      }),
    );
  });

  it("applyDecision 失败时 telemetry 记录 errorMessage，不再静默丢弃 cause（错误归属）", async () => {
    // Bug 原因：respond 的裸 catch 把 applyDecision 的全部失败一律报成
    // trust_store_corrupt，且 trustStoreFailure 不接收 errorMessage，原始 cause
    // 被彻底丢弃。日志里只剩 reasonCode，无法区分是 store 损坏、coordinator 错误
    // 还是 resolveWorkspaceHookReviewDigests 对未知 reviewItemId 抛错。
    // 修法：catch (error) 并把 error.message 透传进 telemetry。
    const value = fixture();
    const { request } = await pendingRequest(value);
    value.store.grant.mockReset();
    value.store.grant.mockRejectedValueOnce(
      new Error("trust store disk write failed"),
    );

    const result = await value.controller.respond(
      {
        sessionId: request.sessionId,
        taskId: request.taskId,
        runId: request.runId,
        ...(request.remoteSessionId
          ? { remoteSessionId: request.remoteSessionId }
          : {}),
        workspaceIdentity: request.workspaceIdentity,
        bundleDigest: request.bundleDigest,
        reviewFlowId: request.reviewFlowId,
        generation: request.generation,
        interactionId: request.interactionId,
      },
      { action: "trust_selected", reviewItemIds: ["item-0"] },
    );

    expect(result).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_trust_store_corrupt",
    });
    // telemetry 必须携带 errorMessage，否则排查时无法区分非存储失败。
    const failure = value.telemetry.find(
      (entry) => entry.context?.event === "workspace_hook.trust_store_failure",
    );
    expect(failure).toBeDefined();
    expect(failure?.context?.errorMessage).toBe(
      "trust store disk write failed",
    );
  });
});

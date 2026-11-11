import {
  createDefaultFileWorkspaceHookTrustStore,
} from "@zcode/adapters/storage";
import { resolveWorkspaceHookTrustIdentityForWorkspace } from "@zcode/adapters/config";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  InMemoryWorkspaceHookPolicyProvider,
  WorkspaceHookTrustCoordinator,
  createWorkspaceHookRuntimeAdmission,
  emitWorkspaceHookTelemetry,
  type WorkspaceHookAdmissionState,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookPolicyProvider,
} from "@zcode/core";
import { SessionEventType } from "@zcode/contracts";
import type {
  Logger,
  SessionId,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookPolicy,
  WorkspaceHookAdmissionUpdatedPayload,
} from "@zcode/contracts";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookRuntimeRoot } from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookReviewController,
  type WorkspaceHookReviewCommandResult,
  type WorkspaceHookReviewHostPort,
  type WorkspaceHookReviewLifecycleEvent,
} from "./workspace-hook-review-controller.js";
import { createWorkspaceHookReviewMutationPort } from "./workspace-hook-review-mutation.js";
import type { WorkspaceHookReviewHostContext } from "./types.js";

export interface WorkspaceHookRuntimeSecurity {
  admission: WorkspaceHookRuntimeAdmissionPort;
  snapshot: WorkspaceHookBundleSnapshot;
  /**
   * Trust store 是文件，而 coordinator 的
   * persistentRecords 是 per-session 内存镜像，只在 session 创建时 load 一次。
   * Settings 行内信任（无 task 的 pretrust 路径）直接写文件后返回，运行中 session
   * 的 coordinator 既不更新记录也不 bump revision——已信任 Hook 继续被拒、banner
   * pendingCount 停留旧值。pretrust 授权成功后必须调用本方法把文件内容重载进本
   * session 的 coordinator 并重发 admission 状态，与 task 内 respond 路径对齐。
   */
  reloadTrust(): Promise<void>;
  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  >;
  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult>;
  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult>;
}

export function createWorkspaceHookRuntimeSecurity(input: {
  appVersion?: string;
  emitAdmissionEvent?: (event: {
    type: typeof SessionEventType.WorkspaceHookAdmissionUpdated;
    payload: WorkspaceHookAdmissionUpdatedPayload;
  }) => Promise<void>;
  emitReviewEvent?: (event: WorkspaceHookReviewLifecycleEvent) => Promise<void>;
  /** 解析受管 worktree 数据根目录用（ZCODE_DATA_BASE_DIR）；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /**
   * 会话 workspaceKey（本地 = workspacePath，远程 = identity）。AdmissionUpdated 与审核 request
   * 对外只发它；snapshot.workspaceIdentity 是 Trust identity，只用于 record/policy/revision（D23）。
   * 缺省回落 snapshot.workspaceIdentity。
   */
  workspaceKey?: string;
  logger: Logger;
  projectConfigPath?: string;
  policy?: WorkspaceHookPolicy;
  policyProvider?: WorkspaceHookPolicyProvider;
  reviewHost?: WorkspaceHookReviewHostContext;
  workspaceHookTrustEnabled?: boolean;
  runtimeRoot: WorkspaceHookRuntimeRoot;
  sessionId: SessionId;
  snapshot?: WorkspaceHookBundleSnapshot;
  userConfigPath: string;
  workingDirectory: string;
  /** 测试注入临时 HOME；生产不传，Trust store 落在真实 ~/.zcode/security。 */
  homeDir?: string;
}): WorkspaceHookRuntimeSecurity | undefined {
  if (!input.snapshot) return undefined;
  const externalWorkspaceIdentity = input.workspaceKey ?? input.snapshot.workspaceIdentity;
  const policyProvider =
    input.policyProvider ?? new InMemoryWorkspaceHookPolicyProvider(input.policy);
  const coordinator = new WorkspaceHookTrustCoordinator({
    coordinatorEpoch: crypto.randomUUID(),
    policyProvider,
  });
  // Rollout 关闭时必须保持旧 hard block，且不能读取已有 Trust store；Trust 文件保留，
  // 方便后续重新打开开关后继续使用用户已做出的选择。
  const trustEnabled = input.workspaceHookTrustEnabled === true;
  const store = trustEnabled
    ? createDefaultFileWorkspaceHookTrustStore({
        userConfigPath: input.userConfigPath,
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      })
    : undefined;
  const ready = trustEnabled
    ? loadWorkspaceHookTrustStore({
        coordinator,
        logger: input.logger,
        store: store as NonNullable<typeof store>,
      })
    : Promise.resolve();
  let controller: WorkspaceHookReviewController | undefined;
  // 软门禁:onAdmissionStateChanged → 发射 WorkspaceHookAdmissionUpdated 会话事件。
  // activate() 完成 evaluate 后、replaceSnapshot 后均会触发,供投影层写入 snapshot 字段。
  const onAdmissionStateChanged:
    | ((state: WorkspaceHookAdmissionState) => void)
    | undefined = input.emitAdmissionEvent
    ? (state) => {
        void input.emitAdmissionEvent!({
          type: SessionEventType.WorkspaceHookAdmissionUpdated,
          payload: {
            pendingCount: state.pendingCount,
            bundleDigest: state.bundleDigest,
            // 修复原因（D23）：state.workspaceIdentity 来自 snapshot，是 Trust identity；受管 worktree 中
            // 它是源仓库路径。UI Banner 用 workspaceKey 比较，发 Trust identity 会让提示条被隐藏。
            workspaceIdentity: externalWorkspaceIdentity,
          },
        }).catch((error: unknown) => {
          input.logger.warn("Failed to emit WorkspaceHookAdmissionUpdated", {
            errorType: error instanceof Error ? error.name : typeof error,
            event: "workspace_hook.admission_event_emit_failed",
            module: "bootstrap.workspace_hook_trust",
          });
        });
      }
    : undefined;
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    enabled: trustEnabled,
    logger: input.logger,
    ready,
    ...(onAdmissionStateChanged ? { onAdmissionStateChanged } : {}),
    snapshot: input.snapshot,
  });

  if (trustEnabled && input.reviewHost && input.emitReviewEvent) {
    const host: WorkspaceHookReviewHostPort = {
      ...input.reviewHost,
      emit: input.emitReviewEvent,
    };
    controller = new WorkspaceHookReviewController({
      admission,
      appVersion: input.appVersion,
      coordinator,
      host,
      logger: input.logger,
      mutation: createWorkspaceHookReviewMutationPort({
        workingDirectory: input.workingDirectory,
        workspaceIdentity: input.snapshot.workspaceIdentity,
        projectConfigPath: input.projectConfigPath,
        runtimeRoot: input.runtimeRoot,
      }),
      sessionId: input.sessionId,
      store: store as NonNullable<typeof store>,
      // target 的 workspaceIdentity 是 workspaceKey：远程 identity 原样，本地按路径解析 Trust identity。
      workspaceKey: externalWorkspaceIdentity,
      resolveTargetTrustIdentity: (workspaceKey) =>
        resolveWorkspaceHookTrustIdentityForWorkspace({
          workspacePath: workspaceKey,
          ...(isRemoteWorkspaceIdentity(workspaceKey) ? { workspaceIdentity: workspaceKey } : {}),
          ...(input.env ? { env: input.env } : {}),
        }),
    });
  }

  const unavailable = (): WorkspaceHookReviewCommandResult => ({
    accepted: false,
    reasonCode: trustEnabled
      ? "workspace_hooks_require_trust_capable_host"
      : "workspace_hooks_feature_disabled",
  });
  return {
    admission,
    snapshot: input.snapshot,
    reloadTrust: async () => {
      if (!trustEnabled || !store) return;
      await loadWorkspaceHookTrustStore({ coordinator, logger: input.logger, store });
      // replacePersistentTrustRecords 已 bump revision 并清空 evaluation 缓存；
      // activate 幂等（跳过 ready 等待），重新 evaluate 并重发 admission 状态
      // （pendingCount === 0 也会发，用于清空 banner）。
      await admission.activate("resume");
    },
    requestReview: (target) =>
      controller
        ? controller.requestReview(target)
        : Promise.resolve(unavailable()),
    respond: (target, decision) =>
      controller ? controller.respond(target, decision) : Promise.resolve(unavailable()),
    toggle: (target, reviewItemId, enabled) =>
      controller
        ? controller.toggle(target, reviewItemId, enabled)
        : Promise.resolve(unavailable()),
    revoke: (target, reviewItemIds) =>
      controller ? controller.revoke(target, reviewItemIds) : Promise.resolve(unavailable()),
    revokeCurrent: (target) =>
      controller ? controller.revokeCurrent(target) : Promise.resolve(unavailable()),
  };
}

async function loadWorkspaceHookTrustStore(input: {
  coordinator: WorkspaceHookTrustCoordinator;
  logger: Logger;
  store: ReturnType<typeof createDefaultFileWorkspaceHookTrustStore>;
}): Promise<void> {
  try {
    const loaded = await (await input.store).load();
    input.coordinator.replacePersistentTrustRecords(loaded.records, {
      status: loaded.status,
      ...(loaded.status === "corrupt" ? { recoveredCorruptPath: loaded.recoveredCorruptPath } : {}),
    });
  } catch (error) {
    input.coordinator.replacePersistentTrustRecords([], { status: "corrupt" });
    emitWorkspaceHookTelemetry(input.logger, "workspace_hook.trust_store_failure", {
      reasonCode: "workspace_hooks_trust_store_corrupt",
    });
    input.logger.warn("Workspace Hook Trust store bootstrap failed closed", {
      errorType: error instanceof Error ? error.name : typeof error,
      event: "workspace_hook.trust_store.bootstrap_failed",
      module: "bootstrap.workspace_hook_trust",
      reasonCode: "workspace_hooks_trust_store_corrupt",
      status: "completed",
    });
  }
}

import type {
  Logger,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookReasonCode,
  WorkspaceHookScriptEntry,
  WorkspaceHookSecurityRevision,
} from "@zcode/contracts";
import type { WorkspaceHookTrustCoordinator } from "./workspace-hook-trust-coordinator.js";
import {
  emitWorkspaceHookTelemetry,
  type WorkspaceHookTelemetryEvent,
  type WorkspaceHookTelemetryFields,
} from "./workspace-hook-telemetry.js";
import type { WorkspaceHookSnapshotEvaluation } from "./workspace-hook-trust-types.js";

export type WorkspaceHookActivationSource = "startup" | "resume" | "fork" | "clear" | "compact";

export interface WorkspaceHookDispatchInput {
  /** Compatibility assertion for callers that hold a bundle target. Runtime registrations omit it. */
  bundleDigest?: string;
  hookDeclarationDigest: string;
  reviewItemId: string;
}

export type WorkspaceHookDispatchDecision =
  | { allowed: true }
  | {
      allowed: false;
      reasonCode: WorkspaceHookReasonCode;
      skipLifecycle?: boolean;
    };

// 软门禁:准入层完成评估后通过此 port 上报 pending 状态。
// pendingCount = configuredEnabled && admissionClass === "pending" 的声明数。
// pendingCount === 0 也要上报(供投影层清空提示条)。
export interface WorkspaceHookAdmissionState {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type WorkspaceHookAdmissionStateCallback = (state: WorkspaceHookAdmissionState) => void;

/** 读取入口脚本状态的 I/O 端口（D24），生产由 bootstrap 注入 shared 的 readWorkspaceHookScriptState。 */
export type WorkspaceHookScriptStateReader = (
  cwd: string,
  path: string,
  signal?: AbortSignal,
) => Promise<WorkspaceHookScriptEntry["state"]>;

export interface WorkspaceHookRuntimeAdmissionPort {
  activate(source: WorkspaceHookActivationSource, signal?: AbortSignal): Promise<void>;
  evaluateDispatch(input: WorkspaceHookDispatchInput): WorkspaceHookDispatchDecision;
  /** evaluateDispatch 允许后、创建进程前，在实际 cwd 下复核入口脚本（D24）。 */
  verifyScriptEntry(input: {
    reviewItemId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<WorkspaceHookDispatchDecision>;
  getCurrentSnapshot(): WorkspaceHookBundleSnapshot;
  replaceSnapshot(snapshot: WorkspaceHookBundleSnapshot): void;
  invalidate(reasonCode: WorkspaceHookReasonCode): void;
}

export interface WorkspaceHookRuntimeAdmissionOptions {
  coordinator: WorkspaceHookTrustCoordinator;
  enabled?: boolean;
  logger?: Logger;
  ready: Promise<void>;
  /** 软门禁:activate() 完成评估后回调,上报 pending 状态 */
  onAdmissionStateChanged?: WorkspaceHookAdmissionStateCallback;
  /** 缺省时有入口的 Hook 一律 fail closed。 */
  readScriptState?: WorkspaceHookScriptStateReader;
  snapshot: WorkspaceHookBundleSnapshot;
}

export class WorkspaceHookRuntimeAdmission implements WorkspaceHookRuntimeAdmissionPort {
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly enabled: boolean;
  private readonly logger?: Logger;
  private readonly ready: Promise<void>;
  private readonly onAdmissionStateChanged?: WorkspaceHookAdmissionStateCallback;
  private readonly readScriptState?: WorkspaceHookScriptStateReader;
  private snapshot: WorkspaceHookBundleSnapshot;
  private readonly entriesByReviewItemId = new Map<string, string>();
  private evaluation?: WorkspaceHookSnapshotEvaluation;
  private validatedRevision?: WorkspaceHookSecurityRevision;
  private invalidatedReason?: WorkspaceHookReasonCode;
  private readonly emittedTelemetry = new Set<string>();
  private activated = false;
  private bootstrapFailed = false;

  constructor(options: WorkspaceHookRuntimeAdmissionOptions) {
    this.coordinator = options.coordinator;
    this.enabled = options.enabled ?? true;
    this.logger = options.logger;
    this.ready = options.ready;
    this.onAdmissionStateChanged = options.onAdmissionStateChanged;
    this.readScriptState = options.readScriptState;
    this.snapshot = options.snapshot;
    this.indexSnapshot(options.snapshot);
  }

  async activate(source: WorkspaceHookActivationSource, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.enabled) {
      if (!this.activated) {
        this.activated = true;
        this.emitTelemetryOnce("workspace_hook.feature_disabled", {
          workspaceIdentity: this.snapshot.workspaceIdentity,
          reasonCode: "workspace_hooks_feature_disabled",
          source,
        });
        // 功能关闭时 pendingCount = 0,上报清空状态
        this.emitAdmissionState();
      }
      return;
    }
    if (!this.activated) {
      try {
        await waitForWorkspaceHookAdmission(this.ready, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // Trust store bootstrap 失败不能扩大执行面；主任务和其他来源 Hook 仍可继续。
        this.bootstrapFailed = true;
      }
      this.activated = true;
    }
    this.safeRefreshEvaluation();
    // 软门禁:不等待 review,直接上报 pending 状态供投影层/使用
    this.emitAdmissionState();
  }

  evaluateDispatch(input: WorkspaceHookDispatchInput): WorkspaceHookDispatchDecision {
    if (!this.matchesSnapshot(input)) {
      this.emitTelemetryOnce("workspace_hook.snapshot_mismatch", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        reasonCode: "workspace_hooks_snapshot_mismatch",
        bundleDigest: input.bundleDigest,
        declarationDigest: input.hookDeclarationDigest,
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    if (this.invalidatedReason) {
      return { allowed: false, reasonCode: this.invalidatedReason };
    }
    if (!this.activated) {
      return { allowed: false, reasonCode: "workspace_hooks_pending_trust" };
    }
    if (!this.enabled) {
      return { allowed: false, reasonCode: "workspace_hooks_feature_disabled" };
    }
    if (this.bootstrapFailed) {
      this.emitTelemetryOnce("workspace_hook.trust_store_failure", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        reasonCode: "workspace_hooks_trust_store_corrupt",
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_trust_store_corrupt",
      };
    }
    if (
      !this.validatedRevision ||
      !this.coordinator.validateSecurityRevision(
        this.snapshot.workspaceIdentity,
        this.validatedRevision,
      )
    ) {
      // 懒刷新曾只更新 evaluation 漏发 admission 状态——外部写入 Trust store
      // （如 Settings pretrust）bump revision 后，banner pendingCount 停留旧值直到下一
      // 次 activate。刷新后必须重发（pendingCount === 0 也会发，用于清空提示条）。
      this.refreshEvaluation();
      this.emitAdmissionState();
    }
    const item = this.evaluation?.items.find(
      (candidate) => candidate.reviewItemId === input.reviewItemId,
    );
    if (!item || item.hookDeclarationDigest !== input.hookDeclarationDigest) {
      this.emitTelemetryOnce("workspace_hook.snapshot_mismatch", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        bundleDigest: this.snapshot.bundleDigest,
        declarationDigest: input.hookDeclarationDigest,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      });
      return {
        allowed: false,
        reasonCode: "workspace_hooks_snapshot_mismatch",
      };
    }
    if (item.effectiveRunnable) return { allowed: true };
    const reasonCode = item.reasonCode ?? "workspace_hooks_blocked_untrusted";
    if (reasonCode === "workspace_hooks_blocked_by_policy") {
      this.emitTelemetryOnce("workspace_hook.policy_blocked", {
        workspaceIdentity: this.snapshot.workspaceIdentity,
        bundleDigest: this.snapshot.bundleDigest,
        declarationDigest: item.hookDeclarationDigest,
        reasonCode,
      });
    }
    return {
      allowed: false,
      reasonCode,
      ...(!item.configuredEnabled ? { skipLifecycle: true } : {}),
    };
  }

  /**
   * 修复 ZP-20261110-06：Trust 只在 discovery 时绑定脚本内容，会话中替换或删除已信任的脚本仍会被执行。
   * 每次派发前按实际 cwd 重新读取，与 snapshot 记录不同即阻断；不热替换 snapshot，
   * 下一个会话按当时内容计算 digest。
   */
  async verifyScriptEntry(input: {
    reviewItemId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<WorkspaceHookDispatchDecision> {
    const entry = this.snapshot.hooks.find(
      (candidate) => candidate.reviewItemId === input.reviewItemId,
    );
    if (!entry) return { allowed: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
    const recorded = entry.scriptEntry;
    if (!recorded) return { allowed: true };
    if (recorded.state.kind !== "file" || !this.readScriptState) {
      return { allowed: false, reasonCode: "workspace_hook_script_unavailable" };
    }
    const current = await this.readScriptState(input.cwd, recorded.path, input.signal);
    if (current.kind === "file" && current.sha256 === recorded.state.sha256) {
      return { allowed: true };
    }
    const reasonCode =
      current.kind === "file"
        ? "workspace_hook_declaration_changed"
        : "workspace_hook_script_unavailable";
    this.logger?.warn("Workspace Hook script verification blocked dispatch", {
      event: "workspace_hook.script_verification_blocked",
      module: "core.hooks",
      reasonCode,
      currentState: current.kind,
    });
    return { allowed: false, reasonCode };
  }

  getCurrentSnapshot(): WorkspaceHookBundleSnapshot {
    return this.snapshot;
  }

  replaceSnapshot(snapshot: WorkspaceHookBundleSnapshot): void {
    if (snapshot.workspaceIdentity !== this.snapshot.workspaceIdentity) {
      // 不变式：调用方只能用同一 workspaceIdentity 的快照替换当前快照。跨 identity
      // 替换意味着调用方混淆了 workspace 边界——这是编程错误而非运行时条件，故抛错
      // 而非静默 no-op 或返回软结果（fail-loud）。调用方必须：
      //   1. 在调用前完成其自身的写入提交（本 Runtime 不回滚外部写入）；
      //   2. 用 try/catch 包裹本调用——抛出的异常不得冒泡到 turn 级别。
      // 当前唯一调用方：workspace-hook-review-controller.ts 的 toggle 路径，
      // 其 writeCommitted 逻辑已满足上述条件。新增调用方，必须在调用点单独处理此异常。
      throw new Error("Cannot replace a Workspace Hook snapshot across workspace identities");
    }
    this.snapshot = snapshot;
    this.entriesByReviewItemId.clear();
    this.indexSnapshot(snapshot);
    this.evaluation = undefined;
    this.validatedRevision = undefined;
    this.invalidatedReason = undefined;
    if (this.activated) {
      this.refreshEvaluation();
      this.emitAdmissionState();
    }
  }

  invalidate(reasonCode: WorkspaceHookReasonCode): void {
    this.invalidatedReason = reasonCode;
    this.evaluation = undefined;
    this.validatedRevision = undefined;
  }

  private indexSnapshot(snapshot: WorkspaceHookBundleSnapshot): void {
    for (const entry of snapshot.hooks) {
      this.entriesByReviewItemId.set(entry.reviewItemId, entry.hookDeclarationDigest);
    }
  }

  private matchesSnapshot(input: WorkspaceHookDispatchInput): boolean {
    return (
      (input.bundleDigest === undefined || input.bundleDigest === this.snapshot.bundleDigest) &&
      this.entriesByReviewItemId.get(input.reviewItemId) === input.hookDeclarationDigest
    );
  }

  // 软门禁:上报 pending 状态。pendingCount = configuredEnabled && admissionClass === "pending"。
  private emitAdmissionState(): void {
    if (!this.onAdmissionStateChanged) return;
    const evaluation = this.evaluation;
    const pendingCount = evaluation
      ? evaluation.items.filter(
          (item) => item.configuredEnabled && item.admissionClass === "pending",
        ).length
      : 0;
    this.onAdmissionStateChanged({
      pendingCount,
      bundleDigest: this.snapshot.bundleDigest,
      ...(this.snapshot.workspaceIdentity
        ? { workspaceIdentity: this.snapshot.workspaceIdentity }
        : {}),
    });
  }

  private emitTelemetryOnce(
    event: WorkspaceHookTelemetryEvent,
    fields: WorkspaceHookTelemetryFields,
  ): void {
    const key = [
      event,
      fields.reasonCode,
      fields.bundleDigest,
      fields.declarationDigest,
      fields.source,
    ].join(":");
    if (this.emittedTelemetry.has(key)) return;
    this.emittedTelemetry.add(key);
    emitWorkspaceHookTelemetry(this.logger, event, fields);
  }

  private refreshEvaluation(): void {
    if (!this.enabled || this.bootstrapFailed || this.invalidatedReason) return;
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot: this.snapshot });
    this.evaluation = evaluation;
    this.validatedRevision = { ...evaluation.securityRevision };
  }

  /**
   * refreshEvaluation 调用 coordinator.evaluateSnapshot，
   * 后者在持久状态畸形（zod parse 失败）时会抛错。该异常不能直接冒泡出 activate →
   * runSessionStartHooks → 整个 turn，导致用户/插件 Hook 也一并失败，且每轮重试
   * （文件本身的注释也说"主任务和其他来源 Hook 仍可继续"）。
   *
   * 对比 evaluateDispatch 路径已通过 resolveHookRunAdmission 的 try/catch 兜底，
   * activate 路径也必须有同等兜底：捕获后置 bootstrapFailed=true——fail-closed，
   * evaluateDispatch 命中该标志即返回 workspace_hooks_trust_store_corrupt 拒绝执行，
   * refreshEvaluation 自身也被该标志短路不再重试。turn 继续推进，非 workspace Hook 不受影响。
   */
  private safeRefreshEvaluation(): void {
    if (!this.enabled || this.bootstrapFailed || this.invalidatedReason) return;
    try {
      this.refreshEvaluation();
    } catch {
      this.bootstrapFailed = true;
      this.evaluation = undefined;
      this.validatedRevision = undefined;
    }
  }
}

function waitForWorkspaceHookAdmission<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Workspace Hook admission aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createWorkspaceHookRuntimeAdmission(
  options: WorkspaceHookRuntimeAdmissionOptions,
): WorkspaceHookRuntimeAdmission {
  return new WorkspaceHookRuntimeAdmission(options);
}

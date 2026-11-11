import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
  type WorkspaceHookTrustRecord,
  type Logger,
  type WorkspaceHookAdmissionUpdatedPayload,
} from "@zcode/contracts";
import type { WorkspaceHookRuntimeAdmissionPort, WorkspaceHookTrustCoordinator } from "@zcode/core";
import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";

export type WorkspaceHookReviewLifecycleEvent =
  | {
      type: typeof SessionEventType.WorkspaceHookReviewRequested;
      payload: { request: WorkspaceHookReviewRequestPayload };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookReviewSettled;
      payload: {
        interactionId: string;
        state: "resolved" | "timed_out" | "configuration_error";
        reasonCode?: string;
      };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookReviewSuperseded;
      payload: { interactionId: string; supersededByInteractionId: string };
    }
  | {
      type: typeof SessionEventType.WorkspaceHookAdmissionUpdated;
      payload: WorkspaceHookAdmissionUpdatedPayload;
    };

export interface WorkspaceHookReviewHostPort {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
  emit(event: WorkspaceHookReviewLifecycleEvent): Promise<void>;
}

export interface WorkspaceHookReviewMutationPort {
  toggle(
    input: {
      snapshot: WorkspaceHookBundleSnapshot;
      reviewItemId: string;
      enabled: boolean;
    },
    onWriteCommitted: () => void | Promise<void>,
  ): Promise<WorkspaceHookBundleSnapshot>;
}

export interface WorkspaceHookTrustStoreMutationPort {
  grant(
    records: readonly WorkspaceHookTrustRecord[],
  ): Promise<{ records: WorkspaceHookTrustRecord[] }>;
  revoke(input: {
    workspaceIdentity: string;
    hookDeclarationDigests?: readonly string[];
  }): Promise<{ records: WorkspaceHookTrustRecord[] }>;
}

export type WorkspaceHookReviewCommandResult =
  | { accepted: true; reviewItemIds: string[] }
  | { accepted: false; reasonCode: WorkspaceHookReasonCode };

export interface WorkspaceHookReviewControllerOptions {
  admission: WorkspaceHookRuntimeAdmissionPort;
  appVersion?: string;
  coordinator: WorkspaceHookTrustCoordinator;
  host: WorkspaceHookReviewHostPort;
  logger?: Logger;
  mutation: WorkspaceHookReviewMutationPort;
  sessionId: string;
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
  now?: () => number;
  createId?: () => string;
  /**
   * 把命令 target 的 workspaceIdentity（UI 侧是 workspaceKey：本地路径或远程 identity）解析为
   * Hook Trust identity（D23），再与 snapshot 比较。缺省原样返回（非受管 worktree 场景等价）。
   */
  resolveTargetTrustIdentity?: (workspaceIdentity: string) => Promise<string>;
  /**
   * 会话自身的 workspaceKey（本地 = workspacePath，远程 = identity）。对外字段（审核 request、
   * AdmissionUpdated）只发它；snapshot.workspaceIdentity 是 Trust identity，只在内部使用（D23）。
   * 缺省回落 snapshot.workspaceIdentity（非受管 worktree 时两者相同）。
   */
  workspaceKey?: string;
}

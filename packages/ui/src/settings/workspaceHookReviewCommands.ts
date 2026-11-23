import type {
  CommandPayloadMap,
  CommandType,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { Hook } from "@zcode/shared";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBindingForItem,
  useWorkspaceHookReviewStore,
  waitForWorkspaceHookReviewBindingForItem,
  type WorkspaceHookCommandBinding,
} from "@/store/workspaceHookReviewStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

export async function sendWorkspaceHookCommand<T extends CommandType>(
  binding: Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
  sessionId: string,
  type: T,
  payload: CommandPayloadMap[T],
): Promise<{ accepted: boolean; reasonCode?: string }> {
  const envelope = createCommandEnvelope({ type, sessionId, payload } as never);
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await binding.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    return {
      accepted: ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop",
      ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
    };
  } finally {
    binding.onCommandSettled?.(envelope.commandId);
  }
}

export function toWorkspaceHookReviewCommandTarget(request: WorkspaceHookReviewRequestPayload) {
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    runId: request.runId,
    ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
    workspaceIdentity: request.workspaceIdentity,
    bundleDigest: request.bundleDigest,
    reviewFlowId: request.reviewFlowId,
    generation: request.generation,
    interactionId: request.interactionId,
  };
}

const DEFAULT_REVIEW_WAIT_TIMEOUT_MS = 5_000;

function shouldGrantCurrentWorkspaceSnapshot(reasonCode: string | undefined): boolean {
  return (
    reasonCode === "workspace_hooks_require_trust_capable_host" ||
    reasonCode === "workspace_hooks_snapshot_mismatch" ||
    reasonCode === "workspace_hooks_bundle_changed"
  );
}

/**
 * Settings 行内 Trust 的单次用户动作：已有精确 flow 时直接 respond；否则先通过当前
 * session command binding 请求 flow，再等待 Runtime 投影出的 immutable request。
 * 当前 session 的 immutable snapshot 无法审核 Settings bundle 时，转由 workspace
 * Agent authority 重新发现 canonical snapshot；UI 静态 snapshot 始终只提供 exact target。
 */
export async function trustWorkspaceHookWithReview(input: {
  hook: Hook;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 无会话授权时 Agent 重新发现的目录；受管 worktree 审核时是 worktree，缺省为 workspacePath。 */
  grantWorkspacePath?: string | null;
  reviewWaitTimeoutMs?: number;
  grantWithoutSession?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }) => Promise<{ accepted: boolean; reasonCode?: string }>;
}): Promise<{ accepted: boolean; reasonCode?: string }> {
  const workspaceHook = input.hook.workspaceHook;
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceHook || !workspaceKey || workspaceHook.workspaceIdentity !== workspaceKey) {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  const grantWorkspacePath = input.grantWorkspacePath ?? input.workspacePath;
  const grantCurrentWorkspaceSnapshot = () => {
    if (!input.grantWithoutSession || !grantWorkspacePath) return undefined;
    return input.grantWithoutSession({
      workspacePath: grantWorkspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      bundleDigest: workspaceHook.bundleDigest,
      hookDeclarationDigest: workspaceHook.hookDeclarationDigest,
    });
  };
  const reviewTarget = {
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    bundleDigest: workspaceHook.bundleDigest,
    reviewItemId: workspaceHook.reviewItemId,
  };
  let reviewBinding = findWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    reviewTarget,
  );

  if (!reviewBinding) {
    const commandBinding = findWorkspaceHookCommandBinding(
      useWorkspaceHookReviewStore.getState().commandBindings,
      input.workspacePath,
      input.workspaceIdentity,
    );
    if (!commandBinding) {
      const granted = grantCurrentWorkspaceSnapshot();
      if (granted) return granted;
      return {
        accepted: false,
        reasonCode: "workspace_hooks_require_trust_capable_host",
      };
    }
    const requested = await sendWorkspaceHookCommand(
      commandBinding,
      commandBinding.sessionId,
      "requestWorkspaceHookReview",
      {
        sessionId: commandBinding.sessionId,
        ...(commandBinding.remoteSessionId
          ? { remoteSessionId: commandBinding.remoteSessionId }
          : {}),
        workspaceIdentity: workspaceHook.workspaceIdentity,
        bundleDigest: workspaceHook.bundleDigest,
      },
    );
    if (!requested.accepted) {
      // 只要存在活跃 session binding 就把 Trust 固定路由给该
      // session；Settings 保存新 Hook 后，活跃 session 仍持有启动时不可变 snapshot，
      // 因而无法审核当前 bundle，却也阻断了本来安全可用的 workspace pretrust。
      if (shouldGrantCurrentWorkspaceSnapshot(requested.reasonCode)) {
        const granted = grantCurrentWorkspaceSnapshot();
        if (granted) return granted;
      }
      return requested;
    }

    reviewBinding = await waitForWorkspaceHookReviewBindingForItem(
      reviewTarget,
      input.reviewWaitTimeoutMs ?? DEFAULT_REVIEW_WAIT_TIMEOUT_MS,
    );
    if (!reviewBinding) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_interaction_timeout",
      };
    }
  }

  const request = reviewBinding.request;
  return sendWorkspaceHookCommand(reviewBinding, request.sessionId, "respondWorkspaceHookReview", {
    ...toWorkspaceHookReviewCommandTarget(request),
    decision: {
      action: "trust_selected",
      reviewItemIds: [workspaceHook.reviewItemId],
    },
  });
}

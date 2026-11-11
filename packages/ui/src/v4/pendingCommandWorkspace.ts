import type { SessionCreateSource } from "@zcode/shared";
import type { ComposerRecentReceipt, FullAccessRecentReceipt } from "@/lib/composerRecent.js";
export interface PendingCommandClientContext {
  fullAccess?: FullAccessRecentReceipt;
  composer?: ComposerRecentReceipt & { draftId?: string; submittedText?: string };
  workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  projectId?: string | null;
  taskGroupId?: string | null;
  sessionCreateSource?: SessionCreateSource;
}

interface WorkspaceScopedPendingCommand {
  clientContext?: PendingCommandClientContext;
  replay: {
    kind: "input" | "sensitiveDigest";
    type: string;
    payload?: Record<string, unknown>;
  };
}

export function resolvePendingCommandWorkspaceKey(
  entry: WorkspaceScopedPendingCommand,
): string | null {
  const workspace = entry.clientContext?.workspace;
  if (workspace) {
    return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  }
  if (entry.replay.kind !== "input" || entry.replay.type !== "createSession") {
    return null;
  }
  // 兼容升级前已落盘的 createSession 恢复线索：协议 payload 的 workspaceId
  // 本身就是发起端 workspaceKey，不能因缺少新 clientContext 而跨 workspace 展示。
  const workspaceId = entry.replay.payload?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
}

export function isPendingCommandForWorkspace(
  entry: WorkspaceScopedPendingCommand,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return resolvePendingCommandWorkspaceKey(entry) === (workspaceIdentity?.trim() || workspacePath);
}

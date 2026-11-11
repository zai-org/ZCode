import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity, type ZCodeWorkspaceRef } from "@zcode/shared";

const REMOTE_WORKSPACE_ID_PREFIX = "remote:";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): ZCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
  };
}

/**
 * 将 V4 workspaceId 的本地路径/远程 identity 双形态统一还原为 workspace ref。
 */
export function resolveWorkspaceRefFromId(workspaceId: string): ZCodeWorkspaceRef {
  const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
  if (!parsedRemote) {
    // 非法 remote identity 若继续按本地路径处理，会再次把 identity 写入
    // directory/path。remote 命名空间必须 fail-closed，本地路径仍保留原 fallback。
    if (workspaceId.startsWith(REMOTE_WORKSPACE_ID_PREFIX)) {
      throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
    }
    return buildWorkspaceRef({ workspacePath: workspaceId });
  }

  // 带显式 user 的 WSL identity 以前解析失败后会落入本地路径分支，
  // 使完整 identity 被当成 workingDirectory。这里统一通过 shared parser 拆分身份与路径。
  return buildWorkspaceRef({
    workspaceIdentity: workspaceId,
    workspacePath: parsedRemote.workspacePath,
  });
}

// ── 会话 cwd 与 workspace 分离（受管 worktree，docs/git/worktree.md §1.1 / §9.3）──
// worktree 任务的 workspace key 属于项目，cwd 是 worktree。这里只做纯解析与校验，不碰存储。

export const WORKTREE_CWD_LOCAL_ONLY = "guard.worktreeCwdLocalOnly";

/** 第一版只支持本地 workspace；远程 identity 结构化拒绝，不尝试解析远端目录。 */
export class WorktreeCwdLocalOnlyError extends Error {
  readonly reasonCode = WORKTREE_CWD_LOCAL_ONLY;

  constructor(workspaceKey: string) {
    super(`session cwd override only supports local workspaces: ${workspaceKey}`);
    this.name = "WorktreeCwdLocalOnlyError";
  }
}

/** workspace 身份（key）不变，执行路径换成 cwd。远程 workspace 拒绝。 */
export function workspaceRefWithCwd(workspace: ZCodeWorkspaceRef, cwd: string): ZCodeWorkspaceRef {
  if (workspace.workspaceIdentity?.trim() || workspace.workspaceKey.startsWith(REMOTE_WORKSPACE_ID_PREFIX)) {
    throw new WorktreeCwdLocalOnlyError(workspace.workspaceKey);
  }
  return { workspaceKey: workspace.workspaceKey, workspacePath: cwd };
}

/**
 * 冷恢复的 workspace：Host 请求携带的本地 workspace 提供身份（key）。请求路径与持久化的
 * session 目录指向同一目录时沿用请求路径（保留当前 attachment 的路径表示，例如末尾 `/`）；
 * 指向不同目录时执行路径取持久化目录（cwd 创建后不变，I2）——worktree 任务的 Host workspace
 * 是项目主目录，沿用请求路径会让会话在主目录中恢复执行。远程 workspace 保持原行为。
 */
export function resolveResumeWorkspaceRef(
  requested: ZCodeWorkspaceRef | undefined,
  stored: { workspaceID?: string; path?: string; directory: string },
): ZCodeWorkspaceRef {
  const storedPath = stored.path ?? stored.directory;
  if (!requested) {
    return buildWorkspaceRef({
      ...(stored.workspaceID ? { workspaceIdentity: stored.workspaceID } : {}),
      workspacePath: storedPath,
    });
  }
  if (requested.workspaceIdentity?.trim()) return requested;
  if (resolve(requested.workspacePath) === resolve(storedPath)) return requested;
  return { ...requested, workspacePath: storedPath };
}

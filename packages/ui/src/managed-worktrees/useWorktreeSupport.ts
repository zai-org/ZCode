// worktree 入口（composer 复选框、"在新 worktree 中分叉"）的可见性与可用性（docs/git/worktree.md §3.1）。
// 可见：本地 Git 仓库；可用：项目 CLI 在 runtime/capabilities 中声明 worktreeCwd。
import { useEffect, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface WorktreeSupport {
  visible: boolean;
  available: boolean;
}

const HIDDEN: WorktreeSupport = { visible: false, available: false };

export function useWorktreeSupport(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  enabled: boolean,
): WorktreeSupport {
  const { managedWorktreeService, gitService } = useServices();
  const [state, setState] = useState<{ path: string; support: WorktreeSupport } | null>(null);
  const active = enabled && Boolean(managedWorktreeService) && !workspaceIdentity?.trim();
  useEffect(() => {
    if (!active || !managedWorktreeService) return;
    let disposed = false;
    void Promise.all([
      gitService.getWorkspaceRepositoryInfo({ workspacePath }),
      managedWorktreeService.supportsWorktreeCwd({ workspacePath }),
    ]).then(
      ([info, supported]) => {
        if (disposed) return;
        const visible = info.kind !== "not-repository";
        setState({ path: workspacePath, support: { visible, available: visible && supported } });
      },
      (error: unknown) => {
        // 查询失败按不可见处理：保留原有一键分叉，不阻断对话。
        logger.warn("[worktree] 读取 worktree 能力失败", { error });
        if (!disposed) setState({ path: workspacePath, support: HIDDEN });
      },
    );
    return () => {
      disposed = true;
    };
  }, [active, gitService, managedWorktreeService, workspacePath]);
  return active && state?.path === workspacePath ? state.support : HIDDEN;
}

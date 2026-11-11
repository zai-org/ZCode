// 会话的 cwd 与所在受管 worktree（docs/git/worktree.md §2.1、§3.7、§3.12）。
// 只读 Host tasks-index 的任务元数据（与会话头部同一数据源）；worktree 任务只在本地出现，
// 远程会话不读取。cwd 缺省为 workspace 目录。
import { useEffect, useState } from "react";
import { useIndexedTaskMeta } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useServices } from "@/hooks/useServices.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface TaskWorktreePlacement {
  cwd: string;
  /** 普通任务为 undefined。 */
  worktreeRoot: string | undefined;
  /** worktree 已被删除时为 false，任务按只读处理；普通任务恒为 true。 */
  worktreeAvailable: boolean;
}

export function useTaskWorktreePlacement({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null | undefined;
}): TaskWorktreePlacement {
  const { managedWorktreeService } = useServices();
  const { broadcastService } = useBaseWorkspaceServices();
  // Bug 原因：曾从 renderer store 的任务列表缓存读取，新会话与 fork 子任务不在缓存中，
  // cwd 退回 workspace，Git 面板与分叉菜单把 worktree 任务当成普通任务。
  const local = !workspaceIdentity?.trim() && !remoteSessionId;
  const meta = useIndexedTaskMeta({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    taskId: local ? (sessionId ?? null) : null,
  });
  const worktreeRoot = meta?.worktreeRoot;
  const [unavailableRoot, setUnavailableRoot] = useState<string | null>(null);
  useEffect(() => {
    if (!worktreeRoot || !managedWorktreeService) return;
    let disposed = false;
    // 每次检查递增序号，只有最新一次的结果能写入，避免较早的请求晚到后覆盖新结果。
    let latest = 0;
    const check = () => {
      const request = ++latest;
      void managedWorktreeService.isWorktreeAvailable({ worktreeRoot }).then(
        (available) => {
          if (!disposed && request === latest) setUnavailableRoot(available ? null : worktreeRoot);
        },
        // 查询失败不判定为只读：只读只由确定的"不存在"触发。
        (error: unknown) => logger.warn("[worktree] 读取 worktree 可用性失败", { error }),
      );
    };
    // 修复原因：曾只在 worktreeRoot 变化时查询；删除 worktree 后 worktreeRoot 不变，已打开的任务
    // 输入区仍可写。删除成功后 Host 发布项目变更，以它为唯一触发源重新查询，不轮询（§3.12）。
    const projects = broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") check();
    });
    check();
    return () => {
      disposed = true;
      projects.dispose();
    };
  }, [broadcastService, managedWorktreeService, worktreeRoot]);
  return {
    cwd: meta?.cwd ?? workspacePath,
    worktreeRoot,
    worktreeAvailable: !worktreeRoot || unavailableRoot !== worktreeRoot,
  };
}

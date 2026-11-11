// 受管 worktree 管理弹窗的数据 hook（docs/git/worktree.md §3.6）。
// 唯一事实源是 Host 的 listWorktrees；这里只保存最近一次读取结果的展示投影，不缓存、不合并。
import { useCallback, useEffect, useRef, useState } from "react";
import type { IManagedWorktreeService, ManagedWorktreeGroup } from "@/project-sidebar/contract.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/**
 * worktree 只存在于本机 Host：当前 tab 是远端时 useServices() 指向远端，
 * 所以固定从 base services 读取；手机与旧 Host 缺省时返回 undefined，入口不显示。
 */
export function useManagedWorktreeService(): IManagedWorktreeService | undefined {
  return useOptionalBaseWorkspaceServices()?.managedWorktreeService;
}

export interface ManagedWorktreeListState {
  /** null = 尚未成功读取过。重新读取期间保留上一次结果，避免列表闪空。 */
  groups: ManagedWorktreeGroup[] | null;
  loading: boolean;
  /** 最近一次读取失败的诊断信息；成功读取后清空。 */
  error: string | null;
}

export function useManagedWorktreeList(service: IManagedWorktreeService, projectId: string) {
  const [state, setState] = useState<ManagedWorktreeListState>({
    groups: null,
    loading: true,
    error: null,
  });
  // 删除、移除记录后都会重新读取；只采纳最后一次请求的结果，迟到的旧结果丢弃。
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const { groups } = await service.listWorktrees({ projectId });
      if (current !== sequence.current) return;
      setState({ groups, loading: false, error: null });
    } catch (cause) {
      if (current !== sequence.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[managed-worktree] 读取 worktree 列表失败", { projectId, error: message });
      setState((previous) => ({ ...previous, loading: false, error: message }));
    }
  }, [service, projectId]);

  useEffect(() => {
    void reload();
    return () => {
      // 弹窗关闭后不再写入已卸载组件的状态。
      sequence.current += 1;
    };
  }, [reload]);

  return { ...state, reload };
}

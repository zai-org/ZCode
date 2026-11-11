import type {
  CreateManagedWorktreeRequest,
  CreateManagedWorktreeResult,
  ListManagedWorktreesRequest,
  ListManagedWorktreesResult,
  ManagedWorktreeStartRefs,
  PruneWorktreesRequest,
  RemoveManagedWorktreeRequest,
  RemoveManagedWorktreeResult,
} from "@zcode/shared";

export interface GitWorktreeCreateOptions {
  /** git 输出与进度行，按到达顺序回调（写入创建记录，§6.2）。 */
  onOutput?: (text: string) => void;
  /** bucket 预留后立即回调 worktree 根目录，供创建记录与中断后的清理使用。 */
  onPathAllocated?: (worktreeRoot: string) => void;
}

/**
 * 受管 worktree 的 Git 端口。唯一事实源是 `git worktree list` + 受管目录布局；
 * 实现不缓存任何副本。任务占用（运行中、终端）检查不在这里，由 Host 编排负责。
 */
export interface GitWorktreeRepo {
  list(request: ListManagedWorktreesRequest): Promise<ListManagedWorktreesResult>;
  create(
    request: CreateManagedWorktreeRequest,
    options?: GitWorktreeCreateOptions,
  ): Promise<CreateManagedWorktreeResult>;
  remove(request: RemoveManagedWorktreeRequest): Promise<RemoveManagedWorktreeResult>;
  prune(request: PruneWorktreesRequest): Promise<void>;
  /** 起点候选：当前 HEAD、本地分支、远端分支（不 fetch）。非仓库返回 null。 */
  listStartRefs(request: { sourcePath: string }): Promise<ManagedWorktreeStartRefs | null>;
  /**
   * worktree 是否有改动或未跟踪文件（与 remove 预检同一判定）；读取失败返回 null。
   * 编排层在卸载会话之前调用，被拒绝的删除不产生副作用（docs/git/worktree.md §8.3）。
   */
  isDirty(worktreeRoot: string): Promise<boolean | null>;
  /** 路径是否位于某个受管 worktree 内；返回 worktree 根与源仓库，否则 null。 */
  resolveManagedWorktree(
    path: string,
  ): Promise<{ worktreeRoot: string; sourceRoot: string } | null>;
}

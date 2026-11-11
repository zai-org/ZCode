// 受管 worktree 的删除租约与会话操作闸门（docs/git/worktree.md §8.3）。
// 租约按 worktree 根目录记录，是"删除中"的唯一数据源；Agent 服务的会话命令、冷订阅与终端创建
// 都经这里检查。会话忙闲不在这里判断，由项目 CLI 判定（session/releaseUnderDirectory）。
import { isPathInside } from "@zcode/shared/managed-worktree";

export const WORKTREE_REMOVING_ERROR = "worktree.removing";

export interface WorktreeRemovalGate {
  /**
   * 取得删除租约；同一 worktree 已在删除中时返回 false。同步完成，调用方在取得租约之前不能 await，
   * 取得之后再做任务、终端与忙闲检查。
   */
  acquire(worktreeRoot: string): boolean;
  release(worktreeRoot: string): void;
  /** 路径位于某个删除中的 worktree 内。 */
  isRemoving(path: string): boolean;
  /**
   * 包裹一次会话操作：先登记为进行中，再检查会话 cwd 是否在删除中的 worktree 内（是则拒绝），
   * 最后执行。登记早于检查，所以删除方取得租约后等待 settle 即可覆盖租约之前已通过检查的操作。
   * 操作按 sessionId 登记只用于诊断；settle 等待全部操作，因为同目录 fork 会在操作中产生新会话。
   */
  runSessionOperation<T>(
    sessionId: string,
    /** 会话 cwd；null 表示无法确定（例如 tasks-index 还没有该会话的行），删除期间一律拒绝。 */
    resolveCwd: () => Promise<string | null>,
    operation: () => Promise<T>,
  ): Promise<T>;
  /**
   * 等待当前已登记的全部会话操作结束（成功或失败）；不使用超时。
   * 不按会话过滤：tasks-index 还没有镜像的会话（例如同目录 fork 刚产生的子会话）也要覆盖。
   */
  settle(): Promise<void>;
}

export function createWorktreeRemovalGate(): WorktreeRemovalGate {
  const leases = new Set<string>();
  const inflight = new Map<string, Set<Promise<void>>>();

  const isRemoving = (path: string) => [...leases].some((root) => isPathInside(root, path));

  return {
    acquire(worktreeRoot) {
      if (isRemoving(worktreeRoot)) return false;
      leases.add(worktreeRoot);
      return true;
    },
    release(worktreeRoot) {
      leases.delete(worktreeRoot);
    },
    isRemoving,
    async runSessionOperation(sessionId, resolveCwd, operation) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entries = inflight.get(sessionId) ?? new Set<Promise<void>>();
      entries.add(done);
      inflight.set(sessionId, entries);
      try {
        // 没有租约时不必读取 cwd；之后取得的租约会等待本次登记结束。
        if (leases.size > 0) {
          const cwd = await resolveCwd();
          // 修复原因：cwd 未知时曾回退为项目目录并放行；同目录 fork 刚产生、尚未镜像的子会话
          // 因此能在删除期间重新激活 worktree 中的会话（§8.3）。删除期间未知 cwd 一律拒绝。
          if (cwd === null || isRemoving(cwd)) throw new Error(WORKTREE_REMOVING_ERROR);
        }
        return await operation();
      } finally {
        entries.delete(done);
        if (entries.size === 0) inflight.delete(sessionId);
        finish();
      }
    },
    async settle() {
      await Promise.all([...inflight.values()].flatMap((entries) => [...entries]));
    },
  };
}

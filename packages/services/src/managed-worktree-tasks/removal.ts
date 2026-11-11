// 受管 worktree 的删除（docs/git/worktree.md §8.3）：删除租约、检查顺序与 CLI 卸载会话集中在这里。
// 由 service.ts 装配；与创建流程共用"请 CLI 卸载某目录内的驻留会话"。
import type { ManagedWorktreeError, ManagedWorktreeErrorCode } from "@zcode/shared";
import { isPathInside } from "@zcode/shared/managed-worktree";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ManagedWorktreeServicePorts } from "#src/managed-worktree-tasks/ports.js";
import type { IManagedWorktreeService, ManagedWorktreeWorkspace } from "./contract.js";

const log = createServiceLogger("managed-worktree");

export function errorOf(code: ManagedWorktreeErrorCode, detail?: string): ManagedWorktreeError {
  return { code, ...(detail ? { detail } : {}) };
}

interface WorktreeRemovalDeps {
  ports: ManagedWorktreeServicePorts;
  requireProject(
    projectId: string,
  ): Promise<{ id: string; roots: ReadonlyArray<{ rootPath: string }> }>;
  /** 该 worktree 是否有进行中的创建记录。 */
  isCreatingAt(worktreeRoot: string): boolean;
}

export function createWorktreeRemoval(deps: WorktreeRemovalDeps) {
  /**
   * 请求项目 CLI 卸载 cwd 位于 directory 内的全部驻留会话（session/releaseUnderDirectory）。
   * 项目 CLI 以任务的归属 workspace 为 key；任务行尚未镜像时，项目 roots 覆盖同一进程。
   * 任一 workspace 报告忙时停止并返回；请求失败时抛出。
   */
  async function releaseCliSessionsUnder(
    projectId: string,
    workspacesInUse: readonly ManagedWorktreeWorkspace[],
    directory: string,
  ): Promise<{ released: string[]; busy: string[] }> {
    const project = await deps.requireProject(projectId);
    const workspaces = new Map<string, ManagedWorktreeWorkspace>();
    for (const workspace of workspacesInUse)
      workspaces.set(workspace.workspacePath, {
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      });
    for (const root of project.roots)
      if (!workspaces.has(root.rootPath))
        workspaces.set(root.rootPath, { workspacePath: root.rootPath });
    const released: string[] = [];
    for (const workspace of workspaces.values()) {
      const result = await deps.ports.runtime.releaseSessionsUnder({ ...workspace, directory });
      if (result.busy.length > 0) return { released, busy: result.busy };
      released.push(...result.released);
    }
    return { released, busy: [] };
  }

  async function removeWorktree(
    params: Parameters<IManagedWorktreeService["removeWorktree"]>[0],
  ): ReturnType<IManagedWorktreeService["removeWorktree"]> {
    const project = await deps.requireProject(params.projectId);
    const managed = await deps.ports.git.resolveManagedWorktree(params.path);
    // 只允许删除源仓库属于本项目 root 的受管 worktree，不能借项目入口删除其他仓库的目录。
    if (!managed || !project.roots.some((root) => isPathInside(managed.sourceRoot, root.rootPath)))
      return { ok: false, error: errorOf("not-managed") };
    if (deps.isCreatingAt(managed.worktreeRoot))
      return { ok: false, error: errorOf("worktree-in-use", "creating") };
    // 先同步取得租约（与上面的创建检查之间没有 await），再做所有检查（§8.3）：
    // 曾先读运行状态、再阻断会话命令，中间的 await 让新命令进入，删除与新 turn 并发。
    if (!deps.ports.removalGate.acquire(managed.worktreeRoot))
      return { ok: false, error: errorOf("worktree-in-use", "removing") };
    try {
      // 租约之前已通过闸门的全部会话操作在这里结束：被 CLI 接受的输入会让下面的忙闲判断为忙，
      // 同目录 fork 产生的子会话也已进入 CLI 驻留表。任务列表在这之后读取（§8.3）。
      await deps.ports.removalGate.settle();
      const tasks = (await deps.ports.repository()).listTasksByWorktree({
        worktreeRoot: managed.worktreeRoot,
      });
      if (params.force && tasks.length > 0)
        return { ok: false, error: errorOf("worktree-in-use", "tasks") };
      if (await deps.ports.runtime.hasTerminalsUnder(managed.worktreeRoot))
        return { ok: false, error: errorOf("worktree-in-use", "terminal") };
      // 有改动的判定先于卸载会话：被拒绝的删除不能留下"会话已被卸载"的副作用（§8.3 第 6 步）。
      // 不带 --force 的 git worktree remove 仍是最终保护。
      if (!params.force) {
        const dirty = await deps.ports.git.isDirty(managed.worktreeRoot);
        if (dirty === null) return { ok: false, error: errorOf("git-failed") };
        if (dirty) return { ok: false, error: errorOf("worktree-dirty") };
      }
      // 卸载哪些会话、是否忙，都由 CLI 按自己的驻留表判断（§8.3）。Bug 原因：曾按 tasks-index 镜像
      // 逐个关闭，镜像滞后时看不到同目录 fork 刚产生的子会话，目录在它驻留时被删除。
      let cli: { released: string[]; busy: string[] };
      try {
        cli = await releaseCliSessionsUnder(project.id, tasks, managed.worktreeRoot);
      } catch (error) {
        log.warn(undefined, "删除 worktree 前卸载会话失败，保留 worktree", {
          worktreeRoot: managed.worktreeRoot,
          error: String(error),
        });
        return { ok: false, error: errorOf("session-close-failed", String(error)) };
      }
      if (cli.busy.length > 0) return { ok: false, error: errorOf("worktree-in-use", "running") };
      // 修复原因：强制删除曾只看 tasks-index 镜像；刚分叉、尚未镜像的子会话不在镜像中，
      // 会被当作"无任务使用"而连同改动一起强制删除。CLI 驻留表是"谁在用"的权威事实（§8.3）。
      if (params.force && cli.released.length > 0)
        return { ok: false, error: errorOf("worktree-in-use", "tasks") };
      const result = await deps.ports.git.remove({
        path: managed.worktreeRoot,
        ...(params.force ? { force: true } : {}),
      });
      if (result.ok) await deps.ports.afterChange?.();
      return result;
    } finally {
      deps.ports.removalGate.release(managed.worktreeRoot);
    }
  }

  return { releaseCliSessionsUnder, removeWorktree };
}

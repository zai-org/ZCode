import type { IManagedWorktreeService } from "./contract.js";

// 示例：管理弹窗读取项目的受管 worktree，并在没有任务占用时删除第一个。
export async function exampleCleanup(service: IManagedWorktreeService, projectId: string) {
  const { groups } = await service.listWorktrees({ projectId });
  const first = groups[0]?.worktrees.find((worktree) => worktree.tasks.length === 0);
  return first ? await service.removeWorktree({ projectId, path: first.path }) : null;
}

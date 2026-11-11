import type { GitWorktreeRepo } from "./contract.js";

// 示例：Host 编排在删除前先完成任务占用检查，再调用 git 层删除，并把结构化错误交给 UI。
export async function exampleRemove(repo: GitWorktreeRepo, path: string): Promise<string> {
  const result = await repo.remove({ path });
  return result.ok ? "removed" : result.error.code;
}

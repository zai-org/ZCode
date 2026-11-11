import type { StartManagedWorktreeCreationResult } from "./contract.js";

// 示例：启动创建后，成功时只得到创建记录 ID；进度从 Host 推送的创建记录读取。
export function exampleCreationId(result: StartManagedWorktreeCreationResult): string | null {
  return result.ok ? result.creationId : null;
}

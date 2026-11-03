/**
 * project-storage 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { DatabaseSync } from "node:sqlite";
import type { ProjectStorageContract } from "#src/project-storage/contract.js";

export async function exampleProjectStorage(
  port: ProjectStorageContract,
  db: DatabaseSync,
  backupDirectory: string,
): Promise<void> {
  await port.migrate(db, { backupDirectories: [backupDirectory] });
}

export function exampleForkOwnership(port: ProjectStorageContract, db: DatabaseSync): void {
  port.repository(db).reserveCreatedTask({
    task: { workspacePath: "/project", taskId: "fork" },
    parentTaskId: "parent",
  });
}

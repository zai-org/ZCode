import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !memory.cliStorageRoot) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  return resolveProjectMemoryRoot({
    cliStorageRoot: memory.cliStorageRoot,
    workspaceIdentity: memory.workspaceIdentity,
    // 受管 worktree 会话与源仓库共用项目记忆（docs/git/worktree.md §6.6.3）。
    workspacePath: config.projectDirectory ?? workspacePath,
  });
}

export function isMainMemoryTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}

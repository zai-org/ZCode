import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ProjectTaskRef } from "#src/project-storage/contract.js";

const log = createServiceLogger("project-storage");

const HOST_MISMATCH_CODES = {
  owner: "project.host-mismatch.owner",
  project: "project.host-mismatch.project",
  "fork-parent": "project.host-mismatch.fork",
} as const;

/**
 * 会话归属不符时先记录诊断再抛错。
 * 原因：用户反馈定时任务立即运行每次失败（session/resume 物化目录时被拒），三处抛错文字相同且没有日志，
 * 无法判断是哪一条归属检查拒绝、会话行 host_id 实际是什么。这里只在出错时打一条 warn，
 * 不记录完整路径；错误码按分支拆开但保留 project.host-mismatch 前缀，按前缀检索与 UI 识别仍成立。
 */
export function hostMismatch(
  branch: keyof typeof HOST_MISMATCH_CODES,
  task: ProjectTaskRef,
  fields: {
    rowHostId: unknown;
    ownerHostId?: string;
    projectId?: unknown;
    projectHostId?: string;
    parentHostId?: unknown;
  },
): Error {
  const code = HOST_MISMATCH_CODES[branch];
  log.warn(undefined, "会话归属不符，拒绝解析会话目录", {
    event: "project_storage.host_mismatch",
    branch,
    code,
    taskId: task.taskId,
    remoteWorkspace: Boolean(task.workspaceIdentity?.trim()),
    rowHostId: fields.rowHostId ?? null,
    ownerHostId: fields.ownerHostId ?? null,
    projectId: fields.projectId ?? null,
    projectHostId: fields.projectHostId ?? null,
    ...(branch === "fork-parent" ? { parentHostId: fields.parentHostId ?? null } : {}),
  });
  return new Error(code);
}

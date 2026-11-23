import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { V4SessionDeletionPreviewBatchItem } from "@zcode/shared/zcode-protocol-v4";
import { isArchivedTaskDeletionBatchUnsupported } from "@/project-sidebar/contract.js";
import type {
  ProjectTaskRef,
  IZCodeTaskService,
  IWindowControllerService,
  WindowHostControllerMutation,
  WindowHostTaskAddress,
} from "@/project-sidebar/contract.js";
export type ProjectTaskMutation = Exclude<
  WindowHostControllerMutation,
  { kind: "open" | "resume" }
>;
interface ProjectTaskPorts {
  service: IZCodeTaskService;
  controller?: IWindowControllerService;
}
function taskAddress(task: ProjectTaskRef, remoteSessionId?: string | null): WindowHostTaskAddress {
  const identity = parseRemoteWorkspaceIdentity(task.workspaceIdentity ?? "");
  return {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    ...(identity?.kind === "server" ? { sourceServerId: identity.sourceServerId } : {}),
  };
}
/** 已查看事件读取唯一 owner 的 marker；不借用 UI 行缓存，也不跨 Source 使用本机服务。 */
export function readProjectTaskMeta(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  remoteSessionId?: string | null,
) {
  return ports.controller
    ? ports.controller.getTaskMeta({ address: taskAddress(task, remoteSessionId) })
    : ports.service.getTaskMeta(task);
}
/** 两个列表入口共用完整地址与命令路由；组织态和 CLI 事实仍各自只由原 owner 写入。 */
export async function mutateProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  mutation: ProjectTaskMutation,
  remoteSessionId?: string | null,
) {
  const target = {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  if (ports.controller)
    return ports.controller.mutateTask({
      address: taskAddress(task, remoteSessionId),
      mutation,
    });
  switch (mutation.kind) {
    case "archive":
      return mutation.archived
        ? ports.service.archiveTask(target)
        : ports.service.unarchiveTask(target);
    case "delete":
      await ports.service.deleteTask(target);
      return null;
    case "rename":
      return ports.service.renameTask({ ...target, title: mutation.title });
    case "pin":
      return ports.service.setTaskPinned({ ...target, pinned: mutation.pinned });
    case "mark-read":
      return ports.service.setTaskUnread({
        ...target,
        unread: false,
        expectedUnreadAt: mutation.expectedUnreadAt,
      });
    case "mark-unread":
      return ports.service.setTaskUnread({ ...target, unread: true });
  }
}

/** 单项预检：批量方法不可用（旧 Host）时逐项回退使用。 */
function previewProjectTaskDeletion(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  remoteSessionId?: string | null,
) {
  return ports.controller
    ? ports.controller.previewArchivedTaskDeletion({ address: taskAddress(task, remoteSessionId) })
    : ports.service.previewArchivedTaskDeletion(task);
}
/** 归档永久删除独立于旧软删除命令；预检与执行使用同一 Source 身份。
 * 预检按批进行，结果按入参顺序；每项沿用各自的 Source 身份。 */
export async function previewProjectTaskDeletions(
  ports: ProjectTaskPorts,
  targets: Array<{ task: ProjectTaskRef; remoteSessionId?: string | null }>,
): Promise<{ results: V4SessionDeletionPreviewBatchItem[] }> {
  try {
    return ports.controller
      ? await ports.controller.previewArchivedTaskDeletions({
          addresses: targets.map(({ task, remoteSessionId }) => taskAddress(task, remoteSessionId)),
        })
      : await ports.service.previewArchivedTaskDeletions({
          tasks: targets.map(({ task }) => ({
            taskId: task.taskId,
            workspacePath: task.workspacePath,
            ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          })),
        });
  } catch (error) {
    if (!isArchivedTaskDeletionBatchUnsupported(error)) throw error;
    // 兼容旧 Host：它不认识批量方法，逐项调用单项预检，拼成同样的按序结果。
    const results: V4SessionDeletionPreviewBatchItem[] = [];
    for (const { task, remoteSessionId } of targets)
      results.push(
        await previewProjectTaskDeletion(ports, task, remoteSessionId).then(
          (preview) => ({ preview }),
          (itemError: unknown) => ({
            error: {
              code: (itemError instanceof Error && itemError.message) || "session-data.unavailable",
            },
          }),
        ),
      );
    return { results };
  }
}
export function permanentlyDeleteProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  revision: string,
  operationId: string,
  remoteSessionId?: string | null,
) {
  return ports.controller
    ? ports.controller.permanentlyDeleteArchivedTask({
        address: taskAddress(task, remoteSessionId),
        revision,
        operationId,
      })
    : ports.service.permanentlyDeleteArchivedTask({ ...task, revision, operationId });
}

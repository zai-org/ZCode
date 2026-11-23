import type {
  V4SessionDeletionPreview,
  V4SessionDeletionPreviewBatchResult,
  V4SessionDeletionResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { Event } from "@zcode/rpc";
import { isProxyMethodNotFoundError } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeArchivedTaskDeletionResult } from "#src/session/zcodeTaskService.js";
import type {
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
} from "../session/zcodeTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "rename"; title: string }
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = ZCodeTaskListItem & {
  sourceServerId?: string;
  serverDisplayName?: string;
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<ZCodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/** 仅实时发送；列表快照与重同步不能重放一次完成提醒。 */
export interface WindowHostTaskUnreadSignal {
  address: WindowHostTaskAddress;
  updatedAt: number;
  status: "completed" | "error";
}

/** 归档仅实时发送；永久删除可由持久凭据补发，渲染层幂等清理离线缓存与 side pane。 */
export interface WindowHostTasksRemovedSignal {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  taskIds: string[];
  permanentlyDeleted?: boolean;
}

/** 桌面侧栏项目的显示顺序键，与侧栏偏好的 (hostId, projectId) 相同。 */
export interface ProjectDisplayOrderKey {
  hostId: string;
  projectId: string;
}

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
  previewArchivedTaskDeletion(params: {
    address: WindowHostTaskAddress;
  }): Promise<V4SessionDeletionPreview>;
  /** 一批地址的预检，结果按顺序；按原 source 分组，每组一次批量 RPC，单项失败只记在该项。 */
  previewArchivedTaskDeletions(params: {
    addresses: WindowHostTaskAddress[];
  }): Promise<V4SessionDeletionPreviewBatchResult>;
  permanentlyDeleteArchivedTask(params: {
    address: WindowHostTaskAddress;
    revision: string;
    operationId: string;
  }): Promise<V4SessionDeletionResult>;
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;
  listTaskList(params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  /** 直接读取所属 owner 的轻量 meta；未读 CAS 不得使用可能降级为旧快照的列表投影。 */
  getTaskMeta(params: { address: WindowHostTaskAddress }): Promise<ZCodeTaskMeta | null>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<ZCodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
  onDynamicTaskUnreadSignal(): Event<WindowHostTaskUnreadSignal>;
  onDynamicTasksRemovedSignal(): Event<WindowHostTasksRemovedSignal>;
  /**
   * 桌面 renderer 上报侧栏实际显示的项目顺序（置顶区在前），只供手机项目树投影使用。
   * 只有桌面 attachment 生效，手机 attachment 调用为空操作；不写 Host 的 projects.position。
   */
  setProjectDisplayOrder(params: { order: ProjectDisplayOrderKey[] }): Promise<void>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);

/**
 * 批量预检的版本偏差判定：旧 Host / Source 的 RPC 代理不认识批量方法时抛固定消息。
 * 调用方据此改为逐项调用单项预检。
 */
export function isArchivedTaskDeletionBatchUnsupported(error: unknown): boolean {
  return isProxyMethodNotFoundError(error, "previewArchivedTaskDeletions");
}

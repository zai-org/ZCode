import type {
  V4SessionDeletionPreview,
  V4SessionDeletionResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { Event } from "@zcode/rpc";
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

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
  previewArchivedTaskDeletion(params: {
    address: WindowHostTaskAddress;
  }): Promise<V4SessionDeletionPreview>;
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
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);

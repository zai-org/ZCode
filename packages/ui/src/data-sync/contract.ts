import type {
  IDeviceSyncStateService,
  IServiceAccessor,
  ProviderSettingsView,
} from "@zcode/services";
import type {
  DataSyncWorkspaceMapping,
  DeviceSyncResult,
  ProviderProvisioningLaneStatus,
  RemoteTarget,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/** 当前已接入的数据同步分类；新分类在 categories.ts 注册适配器后加入这里。 */
export type DataSyncCategoryId = "skills" | "plugins" | "subagents" | "mcp" | "commands" | "hooks";

/** 弹窗顶部与设备行共用的设备展示信息（来自 Source Server 管理快照）。 */
export interface DataSyncDeviceSummary {
  sourceServerId: string;
  name: string;
  /** 「传输方式 · 目标地址」，例如 `SSH · dev@host:22`。 */
  description: string;
  /** 传输方式，用于插件同步埋点的 remote_kind；与 description 取自同一份展示输入。 */
  remoteKind?: RemoteTarget["kind"];
}

export interface DataSyncDialogProps {
  open: boolean;
  /** 最小化只隐藏模态内容，保留推送 owner。 */
  minimized?: boolean;
  onMinimizedChange?(minimized: boolean): void;
  device: DataSyncDeviceSummary;
  /** 设备在管理快照中是否在线；离线时弹窗不关闭，只禁用操作。 */
  online: boolean;
  /** 本机 base services（source）。 */
  sourceServices: IServiceAccessor | undefined;
  /** 设备的 source-settings attachment services（target）；换代即新的 generation。 */
  targetServices: IServiceAccessor | undefined;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
  /** 打开时定位的分类；不传停在概览。旧入口按所选项传入。 */
  initialCategory?: DataSyncCategoryId;
  /**
   * 带项目上下文的入口（连接向导、Header、侧栏项目菜单）传入；MCP 比较与推送据此做 workspace 改写。
   * 设置页入口不传，只做 home 改写。
   */
  workspace?: DataSyncWorkspaceMapping;
  /** 推送后刷新该设备上已打开项目的运行态（技能列表、草稿会话）。 */
  workspaceTabs?: readonly WorkspaceTabState[];
  onOpenChange(open: boolean): void;
  /** 每次推送（单个分类或推送全部）结束后调用，由调用方写入设备同步状态。 */
  onPushFinished(result: DeviceSyncResult): void | Promise<void>;
}

/** 窗口内同步入口的意图；已有弹窗时恢复该实例，不替换它的设备。 */
export interface DataSyncDialogRequest {
  sourceServerId: string;
  category?: DataSyncCategoryId;
  workspace?: DataSyncWorkspaceMapping;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
}

export type {
  DataSyncWorkspaceMapping,
  DeviceSyncResult,
  IDeviceSyncStateService,
  IServiceAccessor,
};
export type { ProviderProvisioningLaneStatus, ProviderSettingsView };

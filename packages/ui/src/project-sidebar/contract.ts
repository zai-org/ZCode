import type { Locale, RemoteTarget, UserInfo } from "@zcode/shared";
import type { LucideIcon } from "lucide-react";
import type {
  AppProps,
  CreateTaskRequest,
  RemoteWorkspaceRecoveryStatus,
} from "@/app-shell/types.js";
import type { Theme } from "@/useTheme.js";
export { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@zcode/services";
export type { WebRemoteControlMobileTaskView, WebRemoteControlStatus } from "@zcode/shared";
export interface ProjectDevice {
  id: string;
  label: string;
  status: string;
  sourceServerId?: string;
}

export interface ProjectRowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  run(): void;
  disabled?: boolean;
  destructive?: boolean;
  /** 与上一组操作之间画分隔线；首项忽略。 */
  separatorBefore?: boolean;
}
export {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
export type {
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@zcode/shared/zcode-protocol-v4";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  SaveProjectInput,
  IProjectService,
  IWindowControllerService,
  IZCodeTaskService,
  WindowHostControllerMutation,
  WindowHostControllerFrame,
  WindowHostTaskUnreadSignal,
  IRemoteProjectService,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  RemoteProjectHost,
  IManagedWorktreeService,
  ManagedWorktreeGroup,
} from "@zcode/services";
export type {
  ManagedWorktreeEntry,
  ManagedWorktreeTaskRef as ManagedWorktreeTask,
} from "@zcode/shared";
export interface ProjectAvailability {
  entryId?: string;
  /** 仅首次升级入口用于替换旧排序键，不改变项目身份。 */
  upgradeEntryId?: string;
  online: boolean;
  unresolved?: boolean;
}
export type { Locale, Theme };
export type ProjectSidebarView = "projects" | "grouped" | "timeline" | "unread";
export interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}
export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}
export type { AppNavigationTarget, AppNavigationHandler } from "@zcode/shared";

export type ProjectTaskNavigationResult =
  | { status: "opened" }
  | { status: "unavailable"; reason: string };
export type ProjectTaskNavigation = (
  targetWorkspacePath: string,
  taskId: string,
  targetWorkspaceIdentity?: string,
  targetRemoteSessionId?: string,
  expectedUnreadAt?: number,
  options?: { signal?: AbortSignal },
) => Promise<ProjectTaskNavigationResult>;

/** 项目、时间线共用同一 Host 行集合；回调只负责现有导航，不维护组织状态。 */
export interface ProjectSidebarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onOpenFileManager?: (target: SidebarFileTreeTarget) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void | Promise<void>;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onCreateConversationTaskOnSource?: (sourceServerId: string) => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  webRemoteControlWorkspaceSwitcher?: import("@/root/types.js").WebRemoteControlWorkspaceSwitcherApi;
  theme: Theme;
  onConnectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: { confirmSourceServerInstall?: boolean },
    feedback?: import("@/app-shell/types.js").RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    preparedWorkspaceIdentity?: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceRecoveryByWorkspaceKey?: Record<string, RemoteWorkspaceRecoveryStatus>;
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  isDesktop?: boolean;
  isWebRemoteControl?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenRepoWiki?: () => void;
  repoWikiActive?: boolean;
  onOpenAutomations?: () => void;
  onOpenPluginStore?: () => void;
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
  /** 「插件市场」之后的扩展导航条目（docs/plugins/extension-host.md §16.4）；Shell 提供打开入口。 */
  navPrimarySlot?: import("@/extension-slots/contract.js").NavPrimarySlotHost;
  onFileTreeOpenChange?: (open: boolean) => void;
  onWebRemoteTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onWebRemoteTaskSwitchingChange?: (switching: boolean) => void;
}

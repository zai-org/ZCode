import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import type { ComposerDraftHandoff } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import type { RefObject } from "react";
import type {
  ZCodeProvider,
  SessionCreateSource,
  ZCodeTaskRuntimeStatus,
  ZCodeTaskMeta,
  GitChangeSourceId,
  DesktopWindowChromeState,
  IPlatformService,
  RemoteTarget,
  SourceServerUpdateTarget,
  RemoteWorkspaceSessionEntry,
  UpdateStatePayload,
  UserInfo,
} from "@zcode/shared";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type {
  BrowserSidePaneMetadata,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { Theme } from "@/useTheme.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import type { AutomationsNavigationTab, OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { SidePaneFullViewController } from "@/side-pane-full-view/contract.js";

export interface WorkspaceShellZCodeState {
  activeTaskId: WorkspaceZCodeUIState["activeTaskId"];
  draftFocusVersion: WorkspaceZCodeUIState["draftFocusVersion"];
  modelSwitchPending: WorkspaceZCodeUIState["modelSwitchPending"];
  modelSwitchStage: WorkspaceZCodeUIState["modelSwitchStage"];
  selectedProvider: WorkspaceZCodeUIState["selectedProvider"];
  optimisticTaskListByTaskId: WorkspaceZCodeUIState["optimisticTaskListByTaskId"];
  workspaceInit: WorkspaceZCodeUIState["workspaceInit"];
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

export interface CreateTaskOptions {
  /** Renderer 发起方租约；异步准备期间取消或换草稿后不得导航。 */
  isCurrent?: () => boolean;
  remoteProjectMembershipId?: string;
  /** 只在目标准备和新草稿导航完成后通知发起界面；不自动发送。 */
  onComplete?: () => void;
  onError?: (error: unknown) => void;
  /** 异步预填只能提交到解析 Skill 时的同一新任务目标。 */
  expectedWorkspaceKey?: string;
  provider?: ZCodeProvider;
  projectId?: string | null;
  /** 未归类任务目录准备的幂等身份，不作为 session 身份。 */
  draftId?: string;
  /** 仅分组组织意图，不决定执行项目或 cwd。 */
  taskGroupId?: string | null;
  hostId?: string;
  createSource?: SessionCreateSource;
  /** 新草稿输入框预填文本；只写草稿，不自动发送。 */
  initialPrompt?: string;
  /** 创建项目后的当前草稿交接，仅在 renderer 内存中传递。 */
  initialComposerDraft?: ComposerDraftHandoff;
  /**
   * 在新的受管 worktree 中准备草稿（docs/git/worktree.md §3.2）：Host 立即创建 worktree，
   * 草稿迁入后由用户照常发送。仅本地项目；远程由 Host 拒绝。
   */
  worktree?: { startRef?: string };
  /** 与 initialPrompt canonical 前缀对应的结构化 mention；仅用于编辑器展示。 */
  initialPromptMention?: ComposerMentionPrefill;
  /** 新任务落在哪个 workspace；缺省取活动 workspace。 */
  targetWorkspace?: {
    projectId?: string | null;
    hostId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

export type CreateTaskRequest = ZCodeProvider | CreateTaskOptions;

export interface RemoteWorkspaceRecoveryStatus {
  mode: "automatic" | "manual";
  attempt?: number;
  limit?: number;
}

/** 仅用于 Renderer 连接反馈，不传入 Host 的恢复/遥测协议。 */
export interface RemoteConnectionFeedbackOptions {
  announceReusedConnection?: boolean;
}

export type DeviceAdditionResult =
  | { kind: "connected"; sourceServerId: string | undefined }
  | { kind: "cancelled"; background?: boolean };

/** 仅当前 renderer 内存中的原 owner 引用；不序列化草稿或凭据。 */
export interface DeviceAdditionReturnTarget {
  /**
   * 已有设备连接留在原项目页；只有新增设备往返设置。
   * data-sync：从「设置 → 数据同步」发起（连接已有设备或新增设备），完成后留在数据同步页，
   * 不跳到「远程设备」页。
   */
  kind: "connect-device" | "add-device" | "data-sync";
  isCurrent(): boolean;
  /** 只投递连接层可见性；原 owner 决定自己的提交门禁。 */
  onVisibilityChange?(visible: boolean): void;
  /** 返回导航前由原 owner 校验异步成员资格；Root 随后重验原意图。 */
  canFinish?(result: DeviceAdditionResult): Promise<boolean>;
  finish(result: DeviceAdditionResult): void | Promise<void>;
}

export interface RemoteConnectionOpenPreference {
  returnTarget?: DeviceAdditionReturnTarget;
  /** 完成意图由发起入口确定；凭据、安装和重试不得替换它。 */
  completion?: "device-management";
  /** 原地重连交接的失败/等待事实；打开时只展示，不自动重发。 */
  initialFailure?: {
    code?: string;
    message: string;
    logs?: RemoteConnectionLogEntry[];
    profileId?: string;
    /** 交接前固定的非敏感失败身份，不从最新 Profile 重建。 */
    failedTarget?: SourceServerUpdateTarget;
    resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
  };
  /** 已有项目的连接意图；安装、升级和凭据交互结束后仍打开该目录。 */
  preferredDirectoryPath?: string;
  preferredWorkspaceTabId?: string;
  /** 未加载 tab 的已保存项目；完成后恢复该入口，不进入新建项目选择。 */
  preferredProjectEntryId?: string;
  preferredTarget?: RemoteTarget;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  preferredSourceServerId?: string;
  /** 用户从设备/连接记录点击“连接”时精确选择的 Profile；弹窗消费后直达第 4 步。 */
  preferredProfileId?: string;
}

export interface AppProps {
  services: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
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

  remoteConnectionLogs?: RemoteConnectionLogEntry[];
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask?: () => void;
  onCreateConversationTaskOnSource?: (sourceServerId: string) => void;
  /** 解析“在项目外工作”的目标；identity 由 Root 按 Source 归属给出，Shell 不得按路径反查。 */
  onResolveConversationWorkspace?: () => Promise<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  onOpenWorkspace: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void | boolean;
  remoteConnectionInProgress?: boolean;
  onReturnToWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  initialSidebarFileTreeOpen?: boolean;
  initialWebRemoteControlMobileNavigationIntent?: import("@zcode/shared").WebRemoteControlMobileNavigationIntent;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
  allowRemoteWorkspace?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  workspaceAbsPath: string;
  workspaceRemoteSessionId?: string;
  workspaceIdentity?: string;
  isWorkspaceVisible?: boolean;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  supportsEmbeddedBrowser?: boolean;
}

export interface GitChangeSummary {
  added: number;
  removed: number;
}

export type WorkspaceMainView = "chat" | "automations" | "plugin-store";

export interface WorkspaceShellLayoutProps extends Omit<AppProps, "baseFeedbackService"> {
  workspaceReadOnlyReason?: string;
  workspaceMainView: WorkspaceMainView;
  pluginStoreOpenVersion: number;
  openAutomationId: string | null;
  openAutomationTab: AutomationsNavigationTab | null;
  /** 中枢深链：落到某个已保存工作流的详情页；定位后由 `onOpenWorkflowConsumed` 清空。 */
  openWorkflow: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed: () => void;
  /**
   * 完成卡「已保存」芯片 → 中枢那一页（docs/dynamic-workflow/transcript-and-notifications.md
   * 「Saving the run, and running it again」）：切到自动化主视图的「工作流」标签并设深链。
   */
  onOpenSavedWorkflowInHub: (target: SavedWorkflowHubTarget) => void;
  onWorkspaceMainViewChange: (view: WorkspaceMainView) => void;
  onOpenAutomationConsumed: () => void;
  handleOpenAutomations: OpenAutomationsMain;
  handleOpenPluginStore: () => void;
  workspaceShellZCodeState: WorkspaceShellZCodeState;
  theme: Theme;
  isMacFullscreen: boolean;
  desktopWindowChromeState: DesktopWindowChromeState | null;
  macWindowControlsLeftPaddingPx: number;
  windowsWindowControlsRightPaddingPx: number;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  sidebarContainerRef: RefObject<HTMLElement | null>;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  goBackShortcutLabel: string;
  goForwardShortcutLabel: string;
  toggleSidePaneShortcutLabel: string;
  /** 「进入 / 退出完整视图」快捷键标签（仅桌面）。 */
  toggleSidePaneFullViewShortcutLabel?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canTaskNavBack: boolean;
  canTaskNavForward: boolean;
  isTerminalOpen: boolean;
  isSidebarVisible: boolean;
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser: boolean;
  isGitOpen: boolean;
  isSidePaneOpen: boolean;
  /** Side Pane 完整视图控制器（仅桌面；spec：docs/ui/side-pane-full-view.md）。 */
  sidePaneFullView?: SidePaneFullViewController;
  summaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange: (variant: ChatViewSummaryPanelVariant | null) => void;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  shellPanelIds: string[];
  projectName: string;
  workspaceTabs: Array<{
    workspacePath: string;
    label: string;
    remoteSessionId?: string;
    remoteTarget?: import("@zcode/shared").RemoteTarget;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    localWorkspacePath?: string;
    availability?: import("@/store/tabStore.js").WorkspaceAvailability;
  }>;
  activeTaskId: string | null;
  /** 右侧栏的正式会话归属 ID；草稿为空，不复制 pane 内部预热 session。 */
  sidePaneOwnerId: string | null;
  handleSidePaneDraftPromotion: (sessionId: string) => void;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  activeTaskTitle: string;
  activeTaskChangeSummary: ReturnType<
    typeof import("@/lib/taskChangeSummary.js").getTaskChangeSummary
  >;
  gitWorktreeReviewSourceId: GitChangeSourceId | null;
  gitWorktreeChangeSummary: GitChangeSummary;
  activeGitSourceId: GitChangeSourceId;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  providerConfigFile: ReturnType<
    typeof import("@/hooks/useWorkspaceProviderConfigFile.js").useWorkspaceProviderConfigFile
  >;
  taskNativeSessionLogFile: ReturnType<
    typeof import("@/hooks/useTaskNativeSessionLogFile.js").useTaskNativeSessionLogFile
  >;
  taskSessionFile: ReturnType<
    typeof import("@/hooks/useTaskSessionFilePath.js").useTaskSessionFilePath
  >;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  conversationFindQuery: string;
  onConversationFindMatchStateChange: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  appLogoUrl: string;
  platform: IPlatformService;
  reloadSessionDisabled: boolean;
  reloadSessionPending: boolean;
  handleReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => Promise<void>;
  handleSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  handleTaskNavBack: () => void;
  handleTaskNavForward: () => void;
  handleStartDraftInWorkspace: (
    targetWorkspacePath: string,
    targetWorkspaceIdentity?: string,
    targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
    createSource?: SessionCreateSource,
  ) => void;
  handleOpenCommandCenter: () => void;
  handleRefreshGit: () => void;
  handleBrowserUrlChange: (tabId: string, url: string) => void;
  handleBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  handleToggleSidebar: () => void;
  handleToggleTerminal: () => void;
  handleToggleBrowser: () => void;
  handleOpenBrowserTab: () => void;
  handleOpenBrowserPermissionSettings: (origin: string) => void;
  handleOpenWhiteboard: () => void;
  handleOpenDeveloperTools: () => void;
  handleOpenFileManager: (target?: FileManagerTarget) => void;
  handleNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  handleOpenPluginMarket: () => void;
  handleOpenTerminalTab: () => void;
  handleToggleGit: () => void;
  handleOpenGitReview: (sourceId?: GitChangeSourceId) => void;
  handleToggleSidePane: () => void;
  handleOpenBrowserUrl: (url: string) => void;
  handleOpenCodeViewer: (source: CodeViewerSource) => void;
  handleAutoOpenAssistantPptx: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  handleOpenBackgroundBash: (request: OpenBackgroundBashSideTabRequest) => void;
  handleOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  handleOpenSubagentDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedSubagentDirectorySideTabRequest,
  ) => void;
  handleSyncSubagentSessionTabs: (
    request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest,
  ) => void;
  handleOpenSelectionSideChat: (request: OpenSelectionSideChatRequest) => void;
  handleOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  handleOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  handleOpenWorkflowRunDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedWorkflowRunDirectorySideTabRequest,
  ) => void;
  handleOpenWorkflowActorSession: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  handleOpenWorkflowWorkspace: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  handleOpenWorkflowArtifact: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  handleCloseCodeViewer: () => void;
  handleCloseGit: () => void;
  handleOpenNewSidePaneTab: () => void;
  handleActivateSidePaneTab: (tabId: string) => void;
  handleReorderSidePaneTab: (activeTabId: string, overTabId: string) => void;
  handleCloseSidePaneTab: (tabId: string) => void;
  handleCloseOtherSidePaneTabs: (tabId: string) => void;
  handleCloseAllSidePaneTabs: () => void;
  handleReopenClosedSidePaneTab: (tabId: string) => void;
  handleBrowserNavigationRequestHandled: (requestId: string) => void;
  setIsTerminalOpen: (open: boolean) => void;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  taskFindDialogProps: TaskFindDialogProps;
}

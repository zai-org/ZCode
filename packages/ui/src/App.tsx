import { PluginUiWorkspaceProvider } from "@/plugin-ui/index.js";
/* eslint-disable max-lines -- App 当前集中编排 workspace 级状态、导航、Git 派生数据和 shell wiring；已将新增 side pane memory 桥接抽出，剩余拆分需要按 shell 边界单独重构。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { resolveWorkspaceKey, type GitChangeSourceId, type WorkspacePurpose } from "@zcode/shared";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";
import {
  setSidePaneFullViewActive,
  SIDE_PANE_FULL_VIEW_ENTER_REQUEST_EVENT,
  useSidePaneFullView,
} from "@/side-pane-full-view/index.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useEnsureWorkspaceMcpLoaded } from "@/hooks/useEnsureWorkspaceMcpLoaded.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab } from "@/store/tabStore.js";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPluginStoreOpenListener,
  type PluginStoreOpenTarget,
} from "@/lib/pluginStoreNavigation.js";
import { resolveWorkspaceSwitchDraftProvider } from "@/lib/workspaceDraftProvider.js";
import { useTestActions } from "@/test-actions.js";
import type { TestActions } from "@/test-actions.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";
import { createQuickPickCommands } from "@/quickpick/quickPickCommands.js";
import {
  ExtensionViewsProvider,
  useReloadExtensions,
  type StartExtensionDraft,
} from "@/extension-slots/index.js";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { FeedbackHost } from "@/feedback/FeedbackHost.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  resolveQuickPickConversationNavigation,
  selectQuickPickConversationTaskIds,
} from "@/lib/quickPickConversationNavigation.js";
import {
  setPendingSettingsPluginIntent,
  setPendingSettingsSection,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import { runWorkspaceVisibleCommand } from "@/lib/workspaceVisibleCommand.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import { resolveTheme } from "@/useTheme.js";
import { WorkspaceShellLayout } from "@/app-shell/WorkspaceShellLayout.js";
import { useAppChromeState } from "@/app-shell/useAppChromeState.js";
import { useWorkspaceSessionReload } from "@/app-shell/useWorkspaceSessionReload.js";
import { useWorkspaceShellLifecycle } from "@/app-shell/useWorkspaceShellLifecycle.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";
import {
  useWorkspaceTaskNavigation,
  type AutomationsNavigationTarget,
} from "@/app-shell/useWorkspaceTaskNavigation.js";
import { useTaskSidePaneMemoryBridge } from "@/app-shell/useTaskSidePaneMemoryBridge.js";
import { resolveAppWorkspaceRpcTarget } from "@/app-shell/workspaceRpcTarget.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceTerminalTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { useMarketingTaskCompletionRefresh } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";
import { useOffPeakTaskNotifications } from "@/hooks/useOffPeakTaskNotifications.js";
import type { AppProps, WorkspaceMainView } from "@/app-shell/types.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { taskListE2EActions } from "@/lib/taskListE2EActions.js";
import {
  CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
  getCloseActiveContextSidePaneTab,
} from "@/lib/closeActiveContext.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { startMemoryDiagnosticsLogger } from "@/lib/memoryDiagnostics.js";
import {
  adoptDraftTaskSidePaneFullView,
  buildTaskSidePaneMemoryKey,
} from "@/lib/taskSidePaneMemory.js";

const EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY: NonNullable<
  AppProps["remoteWorkspaceRecoveryByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_CONNECTION_LOGS: NonNullable<AppProps["remoteConnectionLogs"]> = [];

export function App({
  services,
  baseFeedbackService,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceRecoveryByWorkspaceKey = EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY,
  remoteWorkspaceErrorByWorkspaceKey,

  remoteConnectionLogs = EMPTY_REMOTE_CONNECTION_LOGS,
  onCreateTask,
  onCreateConversationTask,
  onCreateConversationTaskOnSource,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  remoteConnectionInProgress = false,
  onReturnToWorkspace,
  allowOpenWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  allowRemoteWorkspace = true,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity: explicitWorkspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
}: AppProps) {
  // 展示 label 统一从快捷键生效表取（用户改键后 tooltip 同步更新），不再硬编码键位。
  const toggleSidebarShortcutLabel = useShortcutCommandLabel("toggleSidebar");
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const goBackShortcutLabel = useShortcutCommandLabel("navigateBack");
  const goForwardShortcutLabel = useShortcutCommandLabel("navigateForward");
  const toggleTerminalShortcutLabel = useShortcutCommandLabel("toggleTerminal");
  const toggleSidePaneShortcutLabel = useShortcutCommandLabel("toggleSidePane");
  const toggleSidePaneFullViewShortcutLabel = useShortcutCommandLabel("toggleSidePaneFullView");
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const { intl, locale, setLocale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const platform = usePlatform();
  // 命令中心「重新加载扩展」：只有桌面本机 Host 提供扩展门面时才出现。
  const reloadExtensions = useReloadExtensions();
  // 进程内存本地诊断日志：每窗口一个 60s 采样器，
  // 经门控后写桌面主日志；Web 端无日志桥时为 no-op。同一次读数还经 preload 桥把 heap 送 main 的
  // renderer_main 资源事件，无桥时同样 no-op。
  const reportRendererHeapSample = platform.reportRendererHeapSample;
  useEffect(() => {
    const memoryDiagnosticsLogger = startMemoryDiagnosticsLogger({
      reportHeapSample: reportRendererHeapSample,
    });
    return () => memoryDiagnosticsLogger.stop();
  }, [reportRendererHeapSample]);
  const activeWorkspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!state.activeTabId) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (
        !activeTab ||
        !isWorkspaceTab(activeTab) ||
        activeTab.workspacePath !== workspaceAbsPath
      ) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      return {
        workspaceIdentity: activeTab.workspaceIdentity,
        remoteSessionId: activeTab.remoteSessionId,
        remoteTarget: activeTab.remoteTarget,
      };
    }),
  );
  const workspaceRpcTarget = resolveAppWorkspaceRpcTarget({
    activeTarget: activeWorkspaceRpcTarget,
    explicitWorkspaceIdentity,
    explicitRemoteSessionId: workspaceRemoteSessionId,
  });
  // Settings tab 覆盖 workspace 时 active tab 不是 workspace tab。
  // 这里必须使用 Root 传入的 workspaceIdentity 兜底，否则远程断连态会把 /home/... 当成本地 base workspace 预热。
  const workspaceIdentity = workspaceRpcTarget.workspaceIdentity;
  const { rpcReady: workspaceRpcReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRpcTarget.remoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspaceAbsPath, workspaceIdentity),
  );
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const { workspaceShellZCodeState, reloadSessionDisabled } = useWorkspaceShellZCodeState(
    workspaceAbsPath,
    workspaceIdentity,
  );
  const activeTaskId = workspaceShellZCodeState.activeTaskId;
  const sidePaneOwnerId = activeTaskId;
  const [summaryPanelVariantOverride, setSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const draftFocusVersion = workspaceShellZCodeState.draftFocusVersion;
  const {
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings,
    handleToggleGit,
    handleOpenGit,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenExtensionView,
    handleOpenExtensionLogs,
    handleOpenFileManager,
    handleNavigateFileManager,
    handleOpenPluginMarket,
    handleOpenTerminalTab,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenPluginUi,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleTerminal,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleOpenNewSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
    markSidePaneDraftPromotion,
  } = useAppPanels({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    isWorkspaceVisible,
    supportsEmbeddedBrowser,
    platform,
    defaultWhiteboardNamePrefix: intl.formatMessage({
      id: "whiteboard.defaultName",
    }),
  });
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const notificationEnabled = useZCodeStore((s) => s.notificationEnabled);
  useMarketingTaskCompletionRefresh({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    rpcReady: workspaceRpcReady,
  });
  useWorkspaceTerminalTaskNotifications({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    enabled: notificationEnabled,
    rpcReady: workspaceRpcReady,
    platform,
    formatMessage: intl.formatMessage,
  });
  // 闲时任务终态/等确认通知：仅桌面本地链路，main 进程按 status:taskId 去重多窗口重复。
  useOffPeakTaskNotifications({
    offPeakTaskService: services.offPeakTaskService,
    platform,
    enabled: Boolean(notificationEnabled && isDesktop),
    formatMessage: intl.formatMessage,
  });
  const lastHandledDraftSidePaneCloseRef = useRef({
    workspaceKey,
    draftFocusVersion,
  });

  useEffect(() => {
    const previous = lastHandledDraftSidePaneCloseRef.current;
    if (previous.workspaceKey !== workspaceKey) {
      lastHandledDraftSidePaneCloseRef.current = {
        workspaceKey,
        draftFocusVersion,
      };
      return;
    }

    if (previous.draftFocusVersion === draftFocusVersion) {
      return;
    }

    lastHandledDraftSidePaneCloseRef.current = {
      workspaceKey,
      draftFocusVersion,
    };
    if (draftFocusVersion === 0) {
      return;
    }

    // 新建任务只会把 activeTaskId 切到 draft，不会触发 side pane 的 workspace 级内存切换。
    // 因此用 startDraft 递增的版本号统一收起右侧面板，覆盖按钮、菜单、快捷键和远控入口。
    const sidePaneTabCount = sidePaneState?.tabs.length ?? 0;
    if (!isSidePaneCollapsed) {
      logger.info(
        `[App] 新建任务时收起右侧面板 workspace=${workspaceAbsPath} tabs=${sidePaneTabCount}`,
      );
    }
    // scope effect 可能在同一轮更新展开态，不能用本次渲染的旧值跳过新草稿收起。
    setIsSidePaneCollapsed(true);
  }, [
    draftFocusVersion,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    sidePaneState,
    workspaceAbsPath,
    workspaceKey,
  ]);
  const [testMessages, setTestMessages] = useState<TestChatMessage[] | null>(null);
  const [isQuickPickOpen, setIsQuickPickOpen] = useState(false);
  const [isTaskFindOpen, setIsTaskFindOpen] = useState(false);
  const [taskFindFocusRequestId, setTaskFindFocusRequestId] = useState(0);
  const [conversationFindState, setConversationFindState] = useState(createTaskFindNavigationState);
  const [conversationFindMatchCount, setConversationFindMatchCount] = useState(0);
  const searchResultHighlightRequestIdRef = useRef(0);
  const [searchResultHighlightRequest, setSearchResultHighlightRequest] =
    useState<ChatSearchResultHighlightRequest | null>(null);
  const [fileChangeFindState, setFileChangeFindState] = useState(createTaskFindNavigationState);
  const [fileChangeFindMatchCount, setFileChangeFindMatchCount] = useState(0);
  const [canOpenCommunityFromQuickPick, setCanOpenCommunityFromQuickPick] = useState(false);
  const [gitSelectedSourceId, setGitSelectedSourceId] = useState<GitChangeSourceId>("unstaged");
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const { browserRestoreUrls, handleBrowserUrlChange } = useTaskSidePaneMemoryBridge({
    activeTaskId,
    gitSelectedSourceId,
    setGitSelectedSourceId,
    workspaceAbsPath,
    workspaceIdentity,
  });
  const theme = useZCodeStore((s) => s.theme);
  const setTheme = useZCodeStore((s) => s.setTheme);
  const {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  } = useAppChromeState({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
    workspaceAbsPath,
  });
  const tabStoreApi = useTabStoreApi();
  const tabs = useTabStore((s) => s.tabs);
  const addTab = useTabStore((s) => s.addTab);
  const activateTabByPath = useTabStore((s) => s.activateTabByPath);

  const {
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  } = useWorkspaceActiveTaskState({
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
    intl,
  });
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspaceAbsPath,
    workspaceHeaderProvider,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const workspaceTabs = useMemo(
    () =>
      tabs.filter(isWorkspaceTab).map((tab) => ({
        workspacePath: tab.workspacePath,
        label: tab.label,
        remoteSessionId: tab.remoteSessionId,
        remoteTarget: tab.remoteTarget,
        workspaceIdentity: tab.workspaceIdentity,
        workspacePurpose: tab.workspacePurpose,
        localWorkspacePath: tab.localWorkspacePath,
        availability: tab.availability,
      })),
    [tabs],
  );
  const commandCenterWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeSidePaneTab = useMemo(() => getActiveSidePaneTab(sidePaneState), [sidePaneState]);
  const isBrowserOpen = activeSidePaneTab?.type === "browser";
  const isGitOpen = activeSidePaneTab?.type === "git";
  const hasGitTab = sidePaneState?.tabs.some((tab) => tab.type === "git") ?? false;
  const handleRefreshGit = useCallback(() => {
    setGitRefreshVersion((value) => value + 1);
  }, []);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  // worktree 任务的 cwd 不是 workspace 目录；Git 状态必须读任务自己的 cwd（docs/git/worktree.md §3.7）。
  const activeTaskCwd =
    (resolvedActiveTaskMeta?.taskId === activeTaskId ? resolvedActiveTaskMeta?.cwd : undefined) ??
    workspaceAbsPath;
  const gitState = useGitRepository({
    workspacePath: activeTaskCwd,
    activeTaskId,
    includeExtendedData: hasGitTab,
    // 关键逻辑：真实 Git 只在 workspace 变化、Git pane 打开、或用户显式点刷新时重拉。
    // task 切换 / last-turn 摘要变化只更新本地衍生数据，不再顺带重跑 Git 命令。
    refreshToken: gitRefreshVersion,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    remoteTarget: workspaceRpcTarget.remoteTarget,
    workspaceIdentity,
  });
  useGitAutoRefresh({
    workspacePath: activeTaskCwd,
    workspaceIdentity,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: isWorkspaceVisible,
    onRefreshGit: handleRefreshGit,
  });
  const activeGitSourceId =
    gitState.sourceOptions.find((option) => option.id === gitSelectedSourceId)?.id ??
    gitState.sourceOptions[0]?.id ??
    "unstaged";
  const gitChangeSummaryBySourceId = useMemo(() => {
    // 关键业务逻辑：workspace header 和 Git pane 都依赖同一套来源统计，
    // 这里先把各来源的 +/- 汇总成稳定映射，避免不同位置各自重复计算后出现展示不一致。
    return Object.fromEntries(
      gitState.sourceOptions.map((option) => {
        const dataset = gitState.datasets[option.id] ?? gitState.datasets.unstaged;
        const summary = dataset.sections
          .flatMap((section) => section.changes)
          .reduce(
            (result, change) => {
              result.added += change.added;
              result.removed += change.removed;
              return result;
            },
            { added: 0, removed: 0 },
          );
        return [option.id, summary];
      }),
    ) as Record<GitChangeSourceId, { added: number; removed: number }>;
  }, [gitState.datasets, gitState.sourceOptions]);
  const gitWorktreeChangeSummary = useMemo(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    return {
      added: unstaged.added + staged.added,
      removed: unstaged.removed + staged.removed,
    };
  }, [gitChangeSummaryBySourceId]);
  const gitWorktreeReviewSourceId = useMemo<GitChangeSourceId | null>(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    if (unstaged.added + unstaged.removed > 0) {
      return "unstaged";
    }
    if (staged.added + staged.removed > 0) {
      return "staged";
    }
    return null;
  }, [gitChangeSummaryBySourceId]);
  const handleOpenGitReview = useCallback(
    (sourceId?: GitChangeSourceId) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      if (sourceId) {
        setGitSelectedSourceId(sourceId);
      }
      handleOpenGit();
    },
    [handleOpenGit, workspaceReadOnlyReason],
  );
  const isSidePaneOpen = !isSidePaneCollapsed;
  useEffect(() => {
    const handleCloseActiveContextRequest = (event: Event) => {
      const activeTab = getCloseActiveContextSidePaneTab({
        isWorkspaceVisible,
        isSidePaneCollapsed,
        sidePaneState,
      });
      if (!activeTab) {
        return;
      }

      // 桌面菜单的 Cmd/Ctrl+W 会先到 main 进程。
      // 这里在可见 workspace 层拦下请求，确保右侧 side pane 打开时关闭的是 active tab，
      // 而不是让 Root fallback 继续关闭整个窗口。
      event.preventDefault();
      handleCloseSidePaneTab(activeTab.id);
    };

    window.addEventListener(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, handleCloseActiveContextRequest);
    return () => {
      window.removeEventListener(
        CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
        handleCloseActiveContextRequest,
      );
    };
  }, [handleCloseSidePaneTab, isSidePaneCollapsed, isWorkspaceVisible, sidePaneState]);
  const handleToggleSidePane = useCallback(() => {
    // 交互说明：toggle panel 只改变右侧容器显隐，不隐式创建或切换任何 tab。
    // 之前无 tab 时会按 diff/browser 兜底自动开内容，导致用户只是想打开 side pane
    // 却得到一个新 Browser 或 Review。现在空内容统一交给 Open tab 空态承接。
    handleToggleSidePaneCollapse();
  }, [handleToggleSidePaneCollapse]);
  // Side Pane 完整视图只在桌面端提供（docs/ui/side-pane-full-view.md）。
  const supportsSidePaneFullView = Boolean(isDesktop) && !webRemoteControlWorkspaceSwitcher;
  const sidePaneFullView = useSidePaneFullView({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    ownerId: sidePaneOwnerId,
    isSidePaneOpen,
    enabled: supportsSidePaneFullView,
  });
  // 草稿首发：草稿里打开的面板 tab 与完整视图形态一起交给新任务，发完仍停在原来的浮窗 / 完整视图里
  const handleSidePaneDraftPromotion = useCallback(
    (sessionId: string) => {
      markSidePaneDraftPromotion(sessionId);
      adoptDraftTaskSidePaneFullView(
        buildTaskSidePaneMemoryKey({
          workspacePath: workspaceAbsPath,
          workspaceIdentity,
          taskId: null,
        }),
        sessionId,
      );
    },
    [markSidePaneDraftPromotion, workspaceAbsPath, workspaceIdentity],
  );
  // 面板里的内容（设计稿点选打开设计面板）请求铺满：只在面板开着、还不在完整视图时进，enter 自己也会兜住
  const enterSidePaneFullView = sidePaneFullView.enter;
  const isSidePaneFullViewActive = sidePaneFullView.fullView !== null;
  useEffect(() => {
    setSidePaneFullViewActive(isSidePaneFullViewActive);
  }, [isSidePaneFullViewActive]);
  useEffect(() => {
    if (!supportsSidePaneFullView || !isSidePaneOpen) return;
    window.addEventListener(SIDE_PANE_FULL_VIEW_ENTER_REQUEST_EVENT, enterSidePaneFullView);
    return () =>
      window.removeEventListener(SIDE_PANE_FULL_VIEW_ENTER_REQUEST_EVENT, enterSidePaneFullView);
  }, [enterSidePaneFullView, isSidePaneOpen, supportsSidePaneFullView]);
  const handleToggleSidePaneFullView = useCallback(() => {
    // 面板关闭时快捷键先打开面板再进入完整视图；记录先写入，面板展开后即生效。
    if (!sidePaneFullView.fullView && !isSidePaneOpen) {
      handleToggleSidePaneCollapse();
      sidePaneFullView.enter();
      return;
    }
    sidePaneFullView.toggle();
  }, [handleToggleSidePaneCollapse, isSidePaneOpen, sidePaneFullView]);
  const runVisibleWorkspaceCommand = useCallback(
    (run: () => void) => {
      runWorkspaceVisibleCommand({
        isWorkspaceVisible,
        onReturnToWorkspace,
        run,
      });
    },
    [isWorkspaceVisible, onReturnToWorkspace],
  );
  const handleCreateTaskIfWritable = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      if (!workspaceReadOnlyReason) {
        onCreateTask(request);
      }
    },
    [onCreateTask, workspaceReadOnlyReason],
  );
  const handleToggleTerminalIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleTerminal();
    }
  }, [handleToggleTerminal, workspaceReadOnlyReason]);
  const handleOpenTerminalTabIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenTerminalTab();
    }
  }, [handleOpenTerminalTab, workspaceReadOnlyReason]);
  const handleOpenGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenGit();
    }
  }, [handleOpenGit, workspaceReadOnlyReason]);
  const handleToggleGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleGit();
    }
  }, [handleToggleGit, workspaceReadOnlyReason]);
  const handleOpenCodeViewerIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenCodeViewer>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenCodeViewer(...args);
      }
    },
    [handleOpenCodeViewer, workspaceReadOnlyReason],
  );
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!isDesktop || webRemoteControlWorkspaceSwitcher || workspaceReadOnlyReason) {
        return;
      }
      handleOpenCodeViewers(request.sources);
    },
    [handleOpenCodeViewers, isDesktop, webRemoteControlWorkspaceSwitcher, workspaceReadOnlyReason],
  );
  const projectName = getPathLeaf(workspaceAbsPath);
  const handleOpenTaskFind = useCallback(() => {
    // Cmd/Ctrl+F 语义是“查找对话”，之前误复用了 Cmd/Ctrl+P 的文件搜索入口，
    // 导致用户在 quick pick 里点 Find 或按快捷键时会跳到打开文件。这里拆成独立状态，避免影响文件搜索链路。
    runVisibleWorkspaceCommand(() => {
      setTaskFindFocusRequestId((requestId) => requestId + 1);
      setIsTaskFindOpen(true);
    });
  }, [runVisibleWorkspaceCommand]);
  const handleTaskFindOpenChange = useCallback((open: boolean) => {
    setIsTaskFindOpen(open);
    if (!open) {
      setConversationFindState((state) => changeTaskFindSelection(state, "", -1));
      setConversationFindMatchCount(0);
      setFileChangeFindState((state) => changeTaskFindSelection(state, "", -1));
      setFileChangeFindMatchCount(0);
    }
  }, []);
  const handleConversationFindChange = useCallback((query: string, activeIndex: number) => {
    setConversationFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindNavigate = useCallback((query: string, activeIndex: number) => {
    // 单命中时上/下/Enter 都会回到同一 index；独立版本确保重复导航仍触发滚动。
    setConversationFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindMatchStateChange = useCallback(
    (state: ConversationFindMatchState) => {
      setConversationFindMatchCount(state.matchCount);
      if (state.activeIndex !== undefined) {
        setConversationFindState((current) => {
          const activeIndex = state.activeIndex ?? -1;
          // 消息索引随流式帧反复回报相同命中；被动回报没有导航意图，不能让整个 App 跟着更新。
          return current.activeIndex === activeIndex
            ? current
            : changeTaskFindSelection(current, current.query, activeIndex);
        });
      }
    },
    [],
  );
  const handleSearchResultHighlightRequest = useCallback(
    (request: Omit<ChatSearchResultHighlightRequest, "requestId">) => {
      searchResultHighlightRequestIdRef.current += 1;
      setSearchResultHighlightRequest({
        ...request,
        requestId: searchResultHighlightRequestIdRef.current,
      });
    },
    [],
  );
  const handleSearchResultHighlightDone = useCallback((requestId: number) => {
    setSearchResultHighlightRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);
  const handleFileChangeFindChange = useCallback((query: string, activeIndex: number) => {
    setFileChangeFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleFileChangeFindNavigate = useCallback((query: string, activeIndex: number) => {
    // 文件变更范围也可能只有一个命中；重复导航必须重新展开并聚焦同一处。
    setFileChangeFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleOpenQuickPick = useCallback(() => {
    setIsQuickPickOpen((open) => !open);
  }, []);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeedbackTickets = useFeedbackStore((state) => state.openTickets);
  const isLoggedIn = Boolean(user);
  const handleOpenFeedback = useCallback(() => {
    void platform.openFeedback();
  }, [platform]);

  useEffect(() => {
    // 内置反馈中心合并了"提交反馈 / 我的反馈"两个 Tab，
    // 老的 OpenTicketsPanel IPC 仍然兼容（直接打开列表），未来如果还需要单独入口可以复用。
    const disposeFeedbackDialog = platform.onOpenFeedbackDialog?.(() => {
      openFeedbackSubmit();
    });
    const disposeTicketsPanel = platform.onOpenTicketsPanel?.(() => {
      openFeedbackTickets();
    });
    return () => {
      disposeFeedbackDialog?.();
      disposeTicketsPanel?.();
    };
  }, [openFeedbackSubmit, openFeedbackTickets, platform]);
  const handleOpenCommunity = useCallback(() => platform.openCommunity(), [platform]);
  const handleOpenProductDocs = useCallback(() => {
    platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
  }, [platform]);
  const themeTarget = resolveTheme(theme) === "dark" ? "light" : "dark";
  const handleSwitchTheme = useCallback(() => {
    setTheme(themeTarget);
  }, [setTheme, themeTarget]);
  const handleOpenSettingsSection = useCallback(
    (section: SettingsSectionId) => {
      setPendingSettingsSection(section);
      openSettingsTab();
    },
    [openSettingsTab],
  );
  const { reloadSessionPending, handleReloadSession } = useWorkspaceSessionReload({
    intl,
    services,
    workspaceAbsPath,
    reloadSessionDisabled,
  });
  const handleStartDraftInWorkspace = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      const store = useZCodeSessionStore.getState();
      // 首次新建补全 tab 分类曾重建侧栏回调；点击时读取唯一 tab owner，避免依赖整份列表。
      const { tabs: currentTabs } = tabStoreApi.getState();
      const resolvedTargetWorkspaceIdentity =
        targetWorkspaceIdentity ??
        currentTabs.filter(isWorkspaceTab).find((tab) => tab.workspacePath === targetWorkspacePath)
          ?.workspaceIdentity;
      if (
        isWorkspaceReadOnly(
          { tabs: currentTabs },
          targetWorkspacePath,
          resolvedTargetWorkspaceIdentity,
        )
      ) {
        return;
      }
      const targetSelectedProvider = resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: workspaceShellZCodeState.selectedProvider,
        targetWorkspacePath,
        targetWorkspaceIdentity: resolvedTargetWorkspaceIdentity,
        workspaces: store.workspaces,
      });

      // 空态里的 workspace 选择器要表达"在这个项目里开始工作"，
      // 目标 workspace 如果已经记住了自己的 Agent，切过去后应当继续沿用那份选择；
      // 只有首次进入、还没建立 workspace UI 状态时，才继承当前空态里正在看的 Agent。
      // 否则来回切项目时会把目标项目刚用过的 Agent 覆盖掉，看起来就像“总是重置成默认值”。
      // 另外 Home 这类固定入口并不保证已经存在于 tab 列表里，之前直接 activateTabByPath 会静默失败，
      // 看起来就像"点了没反应"。这里先确保目标 workspace 已打开，再把当前空态的 provider 一并传给 startDraft，
      // 保证首次进入的新 workspace 也能继续沿用当前上下文。
      const targetTabOptions =
        resolvedTargetWorkspaceIdentity || targetWorkspacePurpose
          ? {
              ...(resolvedTargetWorkspaceIdentity
                ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
                : {}),
              ...(targetWorkspacePurpose ? { workspacePurpose: targetWorkspacePurpose } : {}),
            }
          : undefined;
      if (targetWorkspacePurpose) {
        // purpose 是分类元数据；即使 tab 已存在也要合并，避免首次从项目解绑时被默认成 project。
        addTab(targetWorkspacePath, targetTabOptions);
      } else if (
        !activateTabByPath(
          targetWorkspacePath,
          resolvedTargetWorkspaceIdentity
            ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
            : undefined,
        )
      ) {
        addTab(targetWorkspacePath, targetTabOptions);
      }
      if (!webRemoteControlWorkspaceSwitcher) {
        // 修复原因：workspace 行“新建对话”以前由叶子组件直接 activateTab + startDraft，
        // 没有退出重启恢复的 workbench group/pane。group primary binding 因而仍可覆盖草稿。
        // desktop 所有显式新建入口统一先回到单 primary pane；手机 /remote 不消费这份本地布局。
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      store.startDraft(
        targetWorkspacePath,
        targetSelectedProvider,
        resolvedTargetWorkspaceIdentity,
        { createSource: createSource ?? "project" },
      );
    },
    [
      activateTabByPath,
      addTab,
      tabStoreApi,
      workspaceShellZCodeState.selectedProvider,
      webRemoteControlWorkspaceSwitcher,
    ],
  );

  useWorkspaceShellLifecycle({
    workspaceAbsPath,
    workspaceIdentity,
    services,
    setBrowserNavigationRequest,
    setTestMessages,
  });

  useEnsureWorkspaceMcpLoaded(workspaceAbsPath, workspaceIdentity, workspaceRpcReady);

  const testActions = useMemo<TestActions>(
    () => ({
      ...taskListE2EActions,
      sendBotMessage: (message) => services.botsService.handleInboundMessage(message),
      submitBotGroupInput: (params) => {
        const submit = services.zcodeTaskService.submitBotGroupInput;
        if (!submit) throw new Error("Task material admission unavailable");
        return submit.call(services.zcodeTaskService, params);
      },
      getTheme: () => theme,
      setTheme,
      getLocale: () => locale,
      setLocale,
      setChatMessages: (messages) => {
        setTestMessages([...messages]);
      },
      getChatMessageCount: () => testMessages?.length ?? 0,
      getPluginsOverview: (params) => services.zcodeAgentService.getPluginsOverview(params),
      addPluginMarketplace: (params) => services.zcodeAgentService.addPluginMarketplace(params),
      updatePluginMarketplace: (params) =>
        services.zcodeAgentService.updatePluginMarketplace(params),
      installPlugin: (params) => services.zcodeAgentService.installPlugin(params),
      listPlugins: (params) => services.zcodeAgentService.listPlugins(params),
      getPluginReferenceCatalog: (params) =>
        services.zcodeAgentService.getPluginReferenceCatalog(params),
    }),
    [
      locale,
      services.botsService,
      services.zcodeTaskService,
      services.zcodeAgentService,
      setLocale,
      theme,
      setTheme,
      testMessages,
    ],
  );
  useTestActions(testActions);
  const [workspaceMainView, setWorkspaceMainView] = useState<WorkspaceMainView>("chat");
  const [openAutomationId, setOpenAutomationId] = useState<string | null>(null);
  const [openAutomationTab, setOpenAutomationTab] = useState<NonNullable<
    AutomationsNavigationTarget["automationTab"]
  > | null>(null);
  const [pluginStoreOpenVersion, setPluginStoreOpenVersion] = useState(0);
  const handleNavigateToTaskMain = useCallback(() => {
    setWorkspaceMainView("chat");
  }, []);
  // 能力 workbench.startDraft（docs/plugins/extension-host.md §18.1 H2）：与插件市场「试用」同一条新建任务路径，
  // 只预填不发送。先回到工作区与对话主视图（与 Shell 的 handleCreateTaskInChat 相同），新草稿才可见。
  // 只读判断同 handleCreateTaskInChat：没有指定工作区时看当前工作区；指定时由 Root 按目标判断。
  const handleStartExtensionDraft = useCallback<StartExtensionDraft>(
    ({ text, workspace }) => {
      if (!workspace && workspaceReadOnlyReason) return false;
      runVisibleWorkspaceCommand(() => {
        handleNavigateToTaskMain();
        onCreateTask({ initialPrompt: text, ...(workspace ? { targetWorkspace: workspace } : {}) });
      });
      return true;
    },
    [handleNavigateToTaskMain, onCreateTask, runVisibleWorkspaceCommand, workspaceReadOnlyReason],
  );
  const { preserveNextSettingsExit } = useWorkspaceMainViewSettingsExit({
    isWorkspaceVisible,
    workspaceMainView,
    onExitSettings: handleNavigateToTaskMain,
  });
  const handleNavigateToAutomationsMain = useCallback((target: AutomationsNavigationTarget) => {
    setOpenAutomationId(target.automationId ?? null);
    setOpenAutomationTab(target.automationTab ?? null);
    setWorkspaceMainView("automations");
  }, []);
  const handleNavigateToPluginStoreMain = useCallback(() => {
    setPluginStoreOpenVersion((version) => version + 1);
    preserveNextSettingsExit();
    setWorkspaceMainView("plugin-store");
  }, [preserveNextSettingsExit]);
  const handleOpenAutomationConsumed = useCallback(() => {
    setOpenAutomationId(null);
    setOpenAutomationTab(null);
  }, []);
  // 中枢深链（「已保存」芯片 → 那个工作流的详情页）：中枢定位后由它回调清空。
  const [openWorkflow, setOpenWorkflow] = useState<SavedWorkflowsOpenTarget | null>(null);
  const handleOpenWorkflowConsumed = useCallback(() => setOpenWorkflow(null), []);
  const {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath,
    workspaceIdentity,
    isWebRemoteControl: Boolean(webRemoteControlWorkspaceSwitcher),
    activateTabByPath,
    onNavigateToTask: handleNavigateToTaskMain,
    onNavigateToAutomations: handleNavigateToAutomationsMain,
    onNavigateToPluginStore: handleNavigateToPluginStoreMain,
  });
  // 完成卡「已保存」芯片的落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
  // run, and running it again」）：走「自动化」入口的同一条导航（进历史、切主视图），落在「工作流」
  // 标签，再由深链把中枢定位到那一页。项目档按 workspaceKey 找组，全局档只要名字。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      setOpenWorkflow(
        target.scope === "global"
          ? { scope: "global", name: target.name }
          : {
              scope: "project",
              name: target.name,
              workspaceKey: resolveWorkspaceKey({
                workspacePath: target.workspacePath,
                ...(target.workspaceIdentity
                  ? { workspaceIdentity: target.workspaceIdentity }
                  : {}),
              }),
            },
      );
      handleOpenAutomations(undefined, "workflow");
    },
    [handleOpenAutomations],
  );
  const handleOpenPluginStoreForScope = useCallback(
    (_target: PluginStoreOpenTarget = {}) => {
      // 管理范围由市场内视图持有，重复打开只重置市场导航。
      if (workspaceMainView === "plugin-store") {
        setPluginStoreOpenVersion((version) => version + 1);
        return;
      }
      handleOpenPluginStore();
    },
    [handleOpenPluginStore, workspaceMainView],
  );
  useEffect(
    () => addPluginStoreOpenListener(handleOpenPluginStoreForScope),
    [handleOpenPluginStoreForScope],
  );
  const handleSelectAdjacentConversation = useCallback(
    (direction: "previous" | "next") => {
      runVisibleWorkspaceCommand(() => {
        const sessionState = useZCodeSessionStore.getState();
        const workspaceState = sessionState.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        const fallbackTaskIds = getVisibleTaskMetas(workspaceState).map((task) => task.taskId);
        const taskQueryCacheState = useTaskQueryCacheStore.getState();
        // 性能修复：task meta 在恢复和流式事件期间会高频写入 query cache。
        // 上/下一个会话只在快捷键触发时需要最新快照，不能让 App 订阅整个 cache 后带动 shell 重渲染。
        const quickPickConversationNavigation = resolveQuickPickConversationNavigation({
          taskIds: selectQuickPickConversationTaskIds({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            resultsByQueryKey: taskQueryCacheState.resultsByQueryKey,
            taskMetaByEntityKey: taskQueryCacheState.taskMetaByEntityKey,
            fallbackTaskIds,
          }),
          activeTaskId,
        });
        const targetTaskId =
          direction === "previous"
            ? quickPickConversationNavigation.previousTaskId
            : quickPickConversationNavigation.nextTaskId;
        if (!targetTaskId) {
          return;
        }

        handleSelectTask(workspaceAbsPath, targetTaskId, workspaceIdentity);
      });
    },
    [
      activeTaskId,
      handleSelectTask,
      runVisibleWorkspaceCommand,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleSelectPreviousConversation = useCallback(() => {
    handleSelectAdjacentConversation("previous");
  }, [handleSelectAdjacentConversation]);
  const handleSelectNextConversation = useCallback(() => {
    handleSelectAdjacentConversation("next");
  }, [handleSelectAdjacentConversation]);
  const handlePrimaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleNavigateToTaskMain : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  const shellPanelIds = useMemo(() => ["sidebar", "content"], []);

  useAppKeyboard({
    openCommandCenter: handleOpenQuickPick,
    // 打开设置页：与设置入口按钮共用 tabStore.openSettingsTab；默认 ⌘,/Ctrl+,（系统惯例）
    openSettings: openSettingsTab,
    findInTask: handleOpenTaskFind,
    toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
    switchTheme: handleSwitchTheme,
    toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
    // ⌥⌘B 与 header 最右侧按钮共用同一条 toggle 入口，
    // 避免快捷键和按钮行为漂移；空面板的展示统一由 Open tab 空态承接。
    toggleSidePane: () => runVisibleWorkspaceCommand(handleToggleSidePane),
    toggleSidePaneFullView: supportsSidePaneFullView
      ? () => runVisibleWorkspaceCommand(handleToggleSidePaneFullView)
      : null,
    previousConversation: handleSelectPreviousConversation,
    nextConversation: handleSelectNextConversation,
    navigateBack: canPrimaryNavigationBack
      ? () => runVisibleWorkspaceCommand(handlePrimaryNavigationBack)
      : null,
    navigateForward: canTaskNavForward
      ? () => runVisibleWorkspaceCommand(handleTaskNavForward)
      : null,
  });

  useEffect(() => {
    let disposed = false;

    void platform.canOpenCommunity(locale).then(
      (visible) => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(visible);
        }
      },
      () => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(false);
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [locale, platform]);

  const quickPickCommands = useMemo(
    () =>
      createQuickPickCommands({
        supportsTerminal: !isOfficeMode,
        supportsReview: !isOfficeMode,
        allowOpenWorkspace,
        canOpenCommunity: canOpenCommunityFromQuickPick,
        isSidebarVisible,
        supportsEmbeddedBrowser,
        // quick pick 命令只关心登录态布尔值。
        // 如果依赖完整 user 对象，auth store 返回等价新引用时会重建整组 command/run 闭包。
        isLoggedIn,
        themeTarget,
        shortcuts: {
          newTask: newTaskShortcutLabel,
          openWorkspace: openWorkspaceShortcutLabel,
          toggleSidebar: toggleSidebarShortcutLabel,
          toggleTerminal: toggleTerminalShortcutLabel,
        },
        handlers: {
          createTask: () => runVisibleWorkspaceCommand(() => handleCreateTaskIfWritable()),
          openWorkspace: () => runVisibleWorkspaceCommand(onOpenWorkspace),
          openSettings: openSettingsTab,
          openSkillsSettings: () => {
            setPendingSettingsPluginIntent("skills");
            openSettingsTab();
          },
          openMcpSettings: () => {
            setPendingSettingsPluginIntent("mcps");
            openSettingsTab();
          },
          switchTheme: handleSwitchTheme,
          openFeedback: handleOpenFeedback,
          openCommunity: handleOpenCommunity,
          openProductDocs: handleOpenProductDocs,
          login: onLogin,
          logout: onLogout,
          toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
          toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
          togglePreview: () => runVisibleWorkspaceCommand(handleToggleBrowser),
          openTerminalTab: () => runVisibleWorkspaceCommand(handleOpenTerminalTabIfWritable),
          openBrowserTab: () => runVisibleWorkspaceCommand(handleOpenBrowserTab),
          openReviewTab: () => runVisibleWorkspaceCommand(handleOpenGitIfWritable),
          // 「打开扩展日志」与「重新加载扩展」同一条件：有扩展门面（docs/plugins/extension-host.md §16.8）。
          ...(reloadExtensions
            ? {
                reloadExtensions,
                openExtensionLogs: () => runVisibleWorkspaceCommand(handleOpenExtensionLogs),
              }
            : {}),
        },
      }),
    [
      reloadExtensions,
      handleOpenExtensionLogs,
      allowOpenWorkspace,
      isOfficeMode,
      canOpenCommunityFromQuickPick,
      handleOpenCommunity,
      handleOpenFeedback,
      handleOpenProductDocs,
      handleOpenSettingsSection,
      handleSwitchTheme,
      handleOpenBrowserTab,
      handleOpenGitIfWritable,
      handleOpenTerminalTabIfWritable,
      handleToggleBrowser,
      handleToggleSidebar,
      handleToggleTerminalIfWritable,
      isLoggedIn,
      isSidebarVisible,
      newTaskShortcutLabel,
      handleCreateTaskIfWritable,
      onLogin,
      onLogout,
      onOpenWorkspace,
      runVisibleWorkspaceCommand,
      openSettingsTab,
      openWorkspaceShortcutLabel,
      supportsEmbeddedBrowser,
      toggleSidebarShortcutLabel,
      toggleTerminalShortcutLabel,
      themeTarget,
    ],
  );
  const taskFindDialogProps = useMemo<TaskFindDialogProps>(
    () => ({
      open: isTaskFindOpen,
      focusRequestId: taskFindFocusRequestId,
      isMacDesktop,
      isWindowsDesktop,
      isLinuxDesktop,
      conversationMatchCount: conversationFindMatchCount,
      conversationMatchIndex: conversationFindState.activeIndex,
      fileChangeMatchCount: fileChangeFindMatchCount,
      fileChangeMatchIndex: fileChangeFindState.activeIndex,
      onOpenChange: handleTaskFindOpenChange,
      onConversationFindChange: handleConversationFindChange,
      onConversationFindNavigate: handleConversationFindNavigate,
      onFileChangeFindChange: handleFileChangeFindChange,
      onFileChangeFindNavigate: handleFileChangeFindNavigate,
      onOpenFileChanges: handleOpenGitIfWritable,
    }),
    [
      conversationFindMatchCount,
      conversationFindState.activeIndex,
      fileChangeFindMatchCount,
      fileChangeFindState.activeIndex,
      handleConversationFindChange,
      handleConversationFindNavigate,
      handleFileChangeFindChange,
      handleFileChangeFindNavigate,
      handleOpenGitIfWritable,
      handleTaskFindOpenChange,
      isLinuxDesktop,
      isMacDesktop,
      isTaskFindOpen,
      isWindowsDesktop,
      taskFindFocusRequestId,
    ],
  );

  return (
    <>
      <CommandCenterDialog
        open={isQuickPickOpen}
        commands={quickPickCommands}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        activeTaskId={activeTaskId}
        activeTaskChangeSummary={activeTaskChangeSummary}
        workspaceTabs={commandCenterWorkspaceTabs}
        onOpenChange={setIsQuickPickOpen}
        onSelectTask={handleSelectTask}
        onSearchResultHighlightRequest={handleSearchResultHighlightRequest}
        onOpenCodeViewer={handleOpenCodeViewerIfWritable}
      />
      {/* Bugfix: 反馈是应用级能力，必须固定走本机 base host；SSH session 连接中或断开时，
          workspace-scoped services 会切成断连代理，不能让反馈提交跟随远程 session 失效。 */}
      <FeedbackHost feedbackService={baseFeedbackService} platform={platform} />
      <PluginUiWorkspaceProvider onOpenSidePane={handleOpenPluginUi}>
        {/* 扩展视图标签的打开入口：启动页条目与能力 views.open（docs/plugins/extension-host.md §8）。 */}
        <ExtensionViewsProvider
          onOpenTab={handleOpenExtensionView}
          onOpenLogs={handleOpenExtensionLogs}
          onStartDraft={handleStartExtensionDraft}
        >
          <WorkspaceShellLayout
            services={services}
            workspaceReadOnlyReason={workspaceReadOnlyReason}
            workspaceMainView={workspaceMainView}
            pluginStoreOpenVersion={pluginStoreOpenVersion}
            openAutomationId={openAutomationId}
            openAutomationTab={openAutomationTab}
            openWorkflow={openWorkflow}
            onOpenWorkflowConsumed={handleOpenWorkflowConsumed}
            onOpenSavedWorkflowInHub={handleOpenSavedWorkflowInHub}
            onWorkspaceMainViewChange={setWorkspaceMainView}
            onOpenAutomationConsumed={handleOpenAutomationConsumed}
            handleOpenAutomations={handleOpenAutomations}
            handleOpenPluginStore={handleOpenPluginStoreForScope}
            onConnectRemote={onConnectRemote}
            onSelectRemoteProject={onSelectRemoteProject}
            onCancelRemoteProject={onCancelRemoteProject}
            onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
            onLogout={onLogout}
            onLogin={onLogin}
            user={user}
            reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
            remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
            remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
            remoteConnectionLogs={remoteConnectionLogs}
            onCreateTask={handleCreateTaskIfWritable}
            onCreateConversationTask={onCreateConversationTask}
            onCreateConversationTaskOnSource={onCreateConversationTaskOnSource}
            onResolveConversationWorkspace={onResolveConversationWorkspace}
            onOpenWorkspace={onOpenWorkspace}
            onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
            onOpenRemoteWorkspace={onOpenRemoteWorkspace}
            remoteConnectionInProgress={remoteConnectionInProgress}
            allowOpenWorkspace={allowOpenWorkspace}
            webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
            initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
            initialWebRemoteControlMobileNavigationIntent={
              initialWebRemoteControlMobileNavigationIntent
            }
            webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
            allowRemoteWorkspace={allowRemoteWorkspace}
            workspaceAbsPath={workspaceAbsPath}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            workspaceIdentity={workspaceIdentity}
            isWorkspaceVisible={isWorkspaceVisible}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            workspaceShellZCodeState={workspaceShellZCodeState}
            theme={theme}
            isMacFullscreen={isMacFullscreen}
            desktopWindowChromeState={desktopWindowChromeState}
            macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            sidebarContainerRef={sidebarContainerRef}
            toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
            newTaskShortcutLabel={newTaskShortcutLabel}
            goBackShortcutLabel={goBackShortcutLabel}
            goForwardShortcutLabel={goForwardShortcutLabel}
            toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
            toggleSidePaneFullViewShortcutLabel={toggleSidePaneFullViewShortcutLabel}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            canTaskNavBack={canTaskNavBack}
            canTaskNavForward={canTaskNavForward}
            isTerminalOpen={isTerminalOpen}
            isSidebarVisible={isSidebarVisible}
            isBrowserOpen={isBrowserOpen}
            supportsEmbeddedBrowser={supportsEmbeddedBrowser}
            isGitOpen={isGitOpen}
            isSidePaneOpen={isSidePaneOpen}
            sidePaneFullView={supportsSidePaneFullView ? sidePaneFullView : undefined}
            summaryPanelVariantOverride={summaryPanelVariantOverride}
            onSummaryPanelVariantOverrideChange={setSummaryPanelVariantOverride}
            sidePaneState={sidePaneState}
            recentClosedSidePaneTabs={recentClosedSidePaneTabs}
            shellPanelIds={shellPanelIds}
            projectName={projectName}
            workspaceTabs={workspaceTabs}
            activeTaskId={activeTaskId}
            sidePaneOwnerId={sidePaneOwnerId}
            handleSidePaneDraftPromotion={handleSidePaneDraftPromotion}
            activeTraceId={activeTraceId}
            activeSessionId={activeSessionId}
            activeTaskProvider={activeTaskProvider}
            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
            activeTaskTitle={activeTaskTitle}
            activeTaskChangeSummary={activeTaskChangeSummary}
            gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
            gitWorktreeChangeSummary={gitWorktreeChangeSummary}
            activeGitSourceId={activeGitSourceId}
            gitState={gitState}
            browserNavigationRequest={browserNavigationRequest}
            browserRestoreUrls={browserRestoreUrls}
            providerConfigFile={providerConfigFile}
            taskNativeSessionLogFile={taskNativeSessionLogFile}
            taskSessionFile={taskSessionFile}
            conversationFindActiveIndex={conversationFindState.activeIndex}
            conversationFindNavigationRequestId={conversationFindState.navigationRequestId}
            conversationFindQuery={conversationFindState.query}
            onConversationFindMatchStateChange={handleConversationFindMatchStateChange}
            searchResultHighlightRequest={searchResultHighlightRequest}
            onSearchResultHighlightDone={handleSearchResultHighlightDone}
            fileChangeFindActiveIndex={fileChangeFindState.activeIndex}
            fileChangeFindNavigationRequestId={fileChangeFindState.navigationRequestId}
            fileChangeFindQuery={fileChangeFindState.query}
            onFileChangeFindMatchCountChange={setFileChangeFindMatchCount}
            appLogoUrl={appLogoUrl}
            platform={platform}
            reloadSessionDisabled={reloadSessionDisabled}
            reloadSessionPending={reloadSessionPending}
            handleReloadSession={handleReloadSession}
            handleSelectTask={handleSelectTask}
            handleTaskNavBack={handleTaskNavBack}
            handleTaskNavForward={handleTaskNavForward}
            handleStartDraftInWorkspace={handleStartDraftInWorkspace}
            handleOpenCommandCenter={handleOpenQuickPick}
            handleRefreshGit={handleRefreshGit}
            handleOpenGitReview={handleOpenGitReview}
            handleBrowserUrlChange={handleBrowserUrlChange}
            handleBrowserPageMetadataChange={handleBrowserPageMetadataChange}
            handleToggleSidebar={handleToggleSidebar}
            handleToggleTerminal={handleToggleTerminalIfWritable}
            handleToggleBrowser={handleToggleBrowser}
            handleOpenBrowserTab={handleOpenBrowserTab}
            handleOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
            handleOpenWhiteboard={handleOpenWhiteboard}
            handleOpenDeveloperTools={handleOpenDeveloperTools}
            handleOpenFileManager={handleOpenFileManager}
            handleNavigateFileManager={handleNavigateFileManager}
            handleOpenPluginMarket={handleOpenPluginMarket}
            handleOpenTerminalTab={handleOpenTerminalTabIfWritable}
            handleToggleGit={handleToggleGitIfWritable}
            handleToggleSidePane={handleToggleSidePane}
            handleOpenBrowserUrl={handleOpenBrowserUrl}
            handleOpenCodeViewer={handleOpenCodeViewerIfWritable}
            handleAutoOpenAssistantPptx={handleAutoOpenAssistantPptx}
            handleOpenSubagentSession={handleOpenSubagentSession}
            handleOpenBackgroundBash={handleOpenBackgroundBash}
            handleOpenSubagentDirectory={handleOpenSubagentDirectory}
            handleSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
            handleOpenSelectionSideChat={handleOpenSelectionSideChat}
            handleOpenPlanDetail={handleOpenPlanDetail}
            handleOpenWorkflowRun={handleOpenWorkflowRun}
            handleOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
            handleOpenWorkflowActorSession={handleOpenWorkflowActorSession}
            handleOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
            handleOpenWorkflowArtifact={handleOpenWorkflowArtifact}
            handleCloseCodeViewer={handleCloseCodeViewer}
            handleCloseGit={handleCloseGit}
            handleActivateSidePaneTab={handleActivateSidePaneTab}
            handleOpenNewSidePaneTab={handleOpenNewSidePaneTab}
            handleReorderSidePaneTab={handleReorderSidePaneTab}
            handleCloseSidePaneTab={handleCloseSidePaneTab}
            handleCloseOtherSidePaneTabs={handleCloseOtherSidePaneTabs}
            handleCloseAllSidePaneTabs={handleCloseAllSidePaneTabs}
            handleReopenClosedSidePaneTab={handleReopenClosedSidePaneTab}
            handleBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
            setIsTerminalOpen={setIsTerminalOpen}
            setGitSelectedSourceId={setGitSelectedSourceId}
            // taskFindDialogProps 是对象 prop，内联创建会让 shell 在流式刷新中每轮都看到新引用。
            taskFindDialogProps={taskFindDialogProps}
          />
        </ExtensionViewsProvider>
      </PluginUiWorkspaceProvider>
    </>
  );
}

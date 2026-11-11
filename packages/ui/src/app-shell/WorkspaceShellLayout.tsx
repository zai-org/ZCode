import type { DraftPluginUiOpenRequest } from "@/plugin-ui/contract.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
/* eslint-disable max-lines -- workspace shell 当前集中编排 sidebar、chat、terminal 和 browser pane 的布局联动，先保持单文件收口，避免为满足行数限制打散关键布局状态。*/
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ReactNode,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { GripHorizontal, LoaderCircle } from "lucide-react";
import { TID_APP_HEADER } from "@zcode/shared/test-ids";
// 保活：workspace tab 真正关闭时，按 workspaceKey 回收 side pane terminal 的常驻 PTY/xterm。
// 对称下侧 Terminal.tsx 的 openWorkspaceKeys 回收。
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";
import {
  readFloatingAnchorPreference,
  SidePaneFullViewConversationHost,
  writeFloatingAnchorPreference,
  type FloatingAnchor,
  type SidePaneFullViewFloating,
  type SidePaneFullViewHostMode,
} from "@/side-pane-full-view/index.js";
import {
  SavedWorkflowHubProvider,
  type SavedWorkflowHubTarget,
} from "@/v4/savedWorkflowHubContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import { useConversationDropTarget } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  selectWorkbenchSession,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";
import {
  usePaneSessionPersistence,
  useRemotePaneSessionLookup,
} from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { ProjectComposerMenu, ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { WorkspacePluginPreview } from "@/workspace-plugin-preview/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import {
  ManagedWorktreeCreationView,
  WorktreeBranchPicker,
  WorktreeToggle,
  useManagedWorktreeCreations,
  useManagedWorktreeSettlements,
  useWorktreeSupport,
} from "@/managed-worktrees/index.js";
import type { ManagedWorktreeCreationSettlement } from "@zcode/shared";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import { AUTOMATIONS_TOAST_ANCHOR_ID, AutomationsSection } from "@/settings/AutomationsSection.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";
import { resolveTopOverlayLeadingPaddingClass, WorkspaceHeader } from "@/WorkspaceHeader.js";
import { WorkspaceSidebar, type SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "@/app-shell/workspaceShellWindowChrome.js";
import {
  getDefaultWebRemoteNavigationHeightPx,
  resolveWebRemoteNavigationDragState,
  resolveWebRemoteNavigationToggleState,
  shouldRenderWebRemoteNavigationPanel,
} from "@/app-shell/webRemoteNavigationLayout.js";
import type { WebRemoteNavigationState } from "@/app-shell/webRemoteNavigationLayout.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import {
  getGitDirtyFileCount,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  areWorkspaceFilePathsEqual,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type {
  ComposerMentionPrefill,
  ZCodeSessionStoreState,
} from "@/store/zcodeSessionStoreTypes.js";

const WEB_REMOTE_CONTROL_MOBILE_QUERY = "(max-width: 767px)";
const WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY =
  "zcode:web-remote-control:collapse-navigation-once";
const WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX = 4;
const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// 修复原因：WorkspaceShellLayout 是 memo 组件，默认 []/{} 会在缺省调用时每次创建新引用；
// 远控/本地入口缺省这些集合时复用常量，避免浅比较误判 props 变化。
const EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceRecoveryByWorkspaceKey"]
> = {};
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// 性能修复：ResizablePanelGroup 收到深相等的新 panelIds 数组，
// 会跟随 chat streaming render 重算布局上下文；固定数组语义上不会随消息变化。
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

type WebRemoteNavigationDragSession = {
  pointerId: number;
  startHeightPx: number;
  startY: number;
  didDrag: boolean;
};

type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

// Bug 原因：头部 JSX 的内联回调共享 Shell render 环境，旧头部会串起历次文件链接回调。
// 在独立作用域创建操作，只保留原 store action 与工作区身份，不改变工作树选择语义。
function createDraftWorktreeCallbacks(
  setDraftWorktree: ZCodeSessionStoreState["setDraftWorktree"],
  workspacePath: string,
  workspaceIdentity: string | undefined,
) {
  return {
    onSelect: (ref: string | null) => setDraftWorktree(workspacePath, { ref }, workspaceIdentity),
    onCheckedChange: (checked: boolean) =>
      setDraftWorktree(workspacePath, checked ? { ref: null } : null, workspaceIdentity),
  };
}

function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

function getWebRemoteControlViewportHeight() {
  if (typeof window === "undefined") {
    return WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
  }

  return window.innerHeight || WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
}

function getIsWebRemoteControlMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches
  );
}

function consumeWebRemoteControlCollapseIntent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.sessionStorage.getItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY) === "1") {
      window.sessionStorage.removeItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function markWebRemoteControlCollapseIntent() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY, "1");
  } catch {
    // ignore
  }
}

export const WorkspaceShellLayout = memo(function WorkspaceShellLayout(
  props: WorkspaceShellLayoutProps,
) {
  return (
    <ProjectDirectoryProvider isDesktop={props.isDesktop}>
      <WorkspaceShellLayoutContent {...props} />
    </ProjectDirectoryProvider>
  );
});

const WorkspaceShellLayoutContent = memo(function WorkspaceShellLayoutComponent({
  services,
  workspaceReadOnlyReason,
  workspaceMainView,
  pluginStoreOpenVersion,
  openAutomationId,
  openAutomationTab,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSavedWorkflowInHub,
  onWorkspaceMainViewChange,
  onOpenAutomationConsumed,
  handleOpenAutomations,
  handleOpenPluginStore,
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

  onCreateTask,
  onCreateConversationTask,
  onCreateConversationTaskOnSource,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  allowOpenWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  allowRemoteWorkspace = true,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  workspaceShellZCodeState,
  theme,
  isMacFullscreen,
  desktopWindowChromeState,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx = 136,
  updateReadyVersion,
  updateState,
  sidebarContainerRef,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  toggleSidePaneShortcutLabel,
  toggleSidePaneFullViewShortcutLabel,
  canGoBack,
  canGoForward,
  canTaskNavBack,
  canTaskNavForward,
  isTerminalOpen,
  isSidebarVisible,
  isSidePaneOpen,
  sidePaneFullView,
  isBrowserOpen,
  supportsEmbeddedBrowser,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  sidePaneState,
  recentClosedSidePaneTabs,
  projectName,
  workspaceTabs,
  activeTaskId,
  sidePaneOwnerId,
  handleSidePaneDraftPromotion,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  activeTaskTitle,
  activeTaskChangeSummary,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeGitSourceId,
  gitState,
  browserNavigationRequest,
  browserRestoreUrls,
  providerConfigFile,
  taskNativeSessionLogFile,
  taskSessionFile,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  conversationFindQuery,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  appLogoUrl,
  platform,
  reloadSessionDisabled,
  reloadSessionPending,
  handleReloadSession,
  handleSelectTask,
  handleTaskNavBack,
  handleTaskNavForward,
  handleStartDraftInWorkspace,
  handleOpenCommandCenter,
  handleRefreshGit,
  handleBrowserUrlChange,
  handleBrowserPageMetadataChange,
  handleToggleSidebar,
  handleToggleTerminal,
  handleToggleBrowser,
  handleOpenBrowserTab,
  handleOpenBrowserPermissionSettings,
  handleOpenWhiteboard,
  handleOpenDeveloperTools,
  handleOpenFileManager,
  handleNavigateFileManager,
  handleOpenPluginMarket,
  handleOpenTerminalTab,
  handleToggleGit,
  handleOpenGitReview,
  handleToggleSidePane,
  handleOpenBrowserUrl,
  handleOpenCodeViewer,
  handleAutoOpenAssistantPptx,
  handleOpenSubagentSession,
  handleOpenBackgroundBash,
  handleOpenSubagentDirectory,
  handleSyncSubagentSessionTabs,
  handleOpenSelectionSideChat,
  handleOpenPlanDetail,
  handleOpenWorkflowRun,
  handleOpenWorkflowRunDirectory,
  handleOpenWorkflowActorSession,
  handleOpenWorkflowWorkspace,
  handleOpenWorkflowArtifact,
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
  setIsTerminalOpen,
  setGitSelectedSourceId,
  taskFindDialogProps,
}: WorkspaceShellLayoutProps) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  useLayoutEffect(
    () =>
      tabStoreApi.subscribe((next, previous) => {
        if (
          next.activeTabId === previous.activeTabId &&
          next.activeWorkspacePath === previous.activeWorkspacePath &&
          next.activeWorkspaceIdentity === previous.activeWorkspaceIdentity
        )
          return;
        // 切工作区不会触发原工作区的 startDraft；在导航提交时取消请求，避免返回后误开新草稿。
        if (!previous.activeWorkspacePath) return;
        const store = useZCodeSessionStore.getState();
        const identity = previous.activeWorkspaceIdentity ?? undefined;
        const request = store.getWorkspaceState(
          previous.activeWorkspacePath,
          identity,
        ).pluginUiOpenRequest;
        if (request)
          store.clearPluginUiOpenRequest(previous.activeWorkspacePath, request.requestId, identity);
      }),
    [tabStoreApi],
  );
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher);
  // Windows/Linux 原先遗漏外层留白，导致独立面板贴住窗口边缘；桌面统一使用 4px 间距。
  const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const workspaceShellRadiusOptions = {
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
  };
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(
    workspaceShellRadiusOptions,
  );
  const collapsedSidebarWidthPx = hasDesktopPanelInset ? (isWindowsDesktop ? 6 : 4) : 0;
  const [isWebRemoteControlNavigationCollapsed, setIsWebRemoteControlNavigationCollapsed] =
    useState(() => (isWebRemoteControlShell ? consumeWebRemoteControlCollapseIntent() : false));
  const [webRemoteControlNavigationHeightPx, setWebRemoteControlNavigationHeightPx] = useState(
    () => {
      const viewportHeight = getWebRemoteControlViewportHeight();
      return resolveWebRemoteNavigationDragState({
        heightPx: getDefaultWebRemoteNavigationHeightPx(viewportHeight),
        viewportHeight,
      }).heightPx;
    },
  );
  const [isWebRemoteControlTaskSwitching, setIsWebRemoteControlTaskSwitching] = useState(false);
  const [draftHeaderDropTargetController, registerDraftHeaderDropTarget] =
    useConversationDropTarget();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const fileTreeOpenRequestIdRef = useRef(0);
  const [fileTreeOpenRequest, setFileTreeOpenRequest] = useState<SidebarFileTreeOpenRequest | null>(
    () =>
      initialSidebarFileTreeOpen
        ? {
            id: 0,
            target: {
              workspacePath: workspaceAbsPath,
              workspaceName: getPathLeaf(workspaceAbsPath),
              workspaceIdentity,
              workspaceRemoteSessionId,
            },
          }
        : null,
  );
  const handleOpenSidebarFiles = useCallback(
    (target: SidebarFileTreeOpenRequest["target"]) => {
      // 文件入口由右侧标签页承接，消费后清除请求，避免侧栏重新挂载时重复打开。
      setFileTreeOpenRequest(null);
      handleOpenFileManager(target);
    },
    [handleOpenFileManager],
  );
  const [isWebRemoteControlMobileViewport, setIsWebRemoteControlMobileViewport] = useState(
    getIsWebRemoteControlMobileViewport,
  );
  const [isWebRemoteControlNavigationDragging, setIsWebRemoteControlNavigationDragging] =
    useState(false);
  const webRemoteControlNavigationHeightRef = useRef(webRemoteControlNavigationHeightPx);
  const webRemoteControlNavigationCollapsedRef = useRef(isWebRemoteControlNavigationCollapsed);
  const webRemoteControlNavigationDragRef = useRef<WebRemoteNavigationDragSession | null>(null);
  const suppressWebRemoteControlNavigationClickRef = useRef(false);
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);
  const screenshotSurfaceTab = screenshotSurfaceRequest
    ? findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)
    : undefined;
  const restorePaneSession = useTabStore((state) =>
    state.tabs.some(
      (tab) =>
        isWorkspaceTab(tab) &&
        tab.restorePaneSession &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
    ),
  );
  const lookupPaneSession = useRemotePaneSessionLookup(
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  );
  // 页签决定启动位置，pane 复用既有选择持久化；services ready 前不查询远端。
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    enabled: !isWebRemoteControlShell,
    restoreOnStartup: Boolean(isDesktop && restorePaneSession),
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
    lookupSession: isDesktop ? lookupPaneSession : undefined,
    onSessionMissing: () => handleStartDraftInWorkspace(workspaceAbsPath, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const shell = workspaceShellRef.current;
    if (!shell) return;
    const scope =
      "[data-project-sidebar-panel], [data-workspace-conversation-frame], [data-workspace-side-frame]";
    const timers = new Map<HTMLElement, number>();
    let hovered: HTMLElement | null = null;
    let dragging = false;
    const animations = new Map<HTMLElement, Animation>();
    const setVisible = (element: HTMLElement, visible: boolean) => {
      if (element.hasAttribute("data-scrollbar-active") === visible) return;
      const current = getComputedStyle(element).getPropertyValue("--zcode-scrollbar-thumb");
      animations.get(element)?.cancel();
      element.toggleAttribute("data-scrollbar-active", visible);
      const target = visible
        ? getComputedStyle(element).getPropertyValue("--color-border")
        : "transparent";
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const animation = element.animate(
          [{ "--zcode-scrollbar-thumb": current }, { "--zcode-scrollbar-thumb": target }],
          { duration: 200, easing: "ease" },
        );
        animations.set(element, animation);
        animation.onfinish = () => {
          animations.delete(element);
        };
      }
    };
    const hideLater = (element: HTMLElement) => {
      window.clearTimeout(timers.get(element));
      timers.set(
        element,
        window.setTimeout(() => {
          timers.delete(element);
          if (element === hovered || dragging) return;
          setVisible(element, false);
        }, 1000),
      );
    };
    const reveal = (element: HTMLElement) => {
      setVisible(element, true);
      hideLater(element);
    };
    const onScroll = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && element.closest(scope)) {
        element.setAttribute("data-scrollbar-container", "");
        reveal(element);
      }
    };
    let thumbHovered: HTMLElement | null = null;
    const setThumbHovered = (element: HTMLElement | null) => {
      if (thumbHovered === element) return;
      thumbHovered?.removeAttribute("data-scrollbar-hover");
      thumbHovered = element;
      element?.setAttribute("data-scrollbar-hover", "");
    };
    let pointerFrame = 0;
    let pendingPointer: MouseEvent | null = null;
    const updatePointer = (event: MouseEvent) => {
      let element = event.target instanceof HTMLElement ? event.target : null;
      let next: HTMLElement | null = null;
      if (!element || !element.closest(scope)) {
        setThumbHovered(null);
        if (hovered) hideLater(hovered);
        hovered = null;
        return;
      }
      while (element && shell.contains(element)) {
        if (
          element.scrollHeight <= element.clientHeight &&
          element.scrollWidth <= element.clientWidth
        ) {
          element = element.parentElement;
          continue;
        }
        const rect = element.getBoundingClientRect();
        const vertical =
          element.scrollHeight > element.clientHeight &&
          element.offsetWidth > element.clientWidth &&
          event.clientX >= rect.right - 10 &&
          event.clientX <= rect.right;
        const horizontal =
          element.scrollWidth > element.clientWidth &&
          element.offsetHeight > element.clientHeight &&
          event.clientY >= rect.bottom - 10 &&
          event.clientY <= rect.bottom;
        if (vertical || horizontal) {
          next = element;
          break;
        }
        element = element.parentElement;
      }
      if (!next) {
        // Query mounted nodes instead of retaining removed session/panel DOM in a Set.
        for (const candidate of shell.querySelectorAll<HTMLElement>("[data-scrollbar-container]")) {
          const rect = candidate.getBoundingClientRect();
          if (
            event.clientX >= rect.right - 14 &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom &&
            candidate.scrollHeight > candidate.clientHeight
          ) {
            next = candidate;
            break;
          }
        }
      }
      const previous = hovered;
      hovered = next;
      if (previous && previous !== next) hideLater(previous);
      let hitThumb = false;
      if (next) {
        reveal(next);
        const rect = next.getBoundingClientRect();
        const vertical = event.clientX >= rect.right - 14 && next.scrollHeight > next.clientHeight;
        const track = vertical ? next.clientHeight : next.clientWidth;
        const extent = vertical ? next.scrollHeight : next.scrollWidth;
        const offset = vertical ? next.scrollTop : next.scrollLeft;
        const length = Math.min(track, Math.max(32, (track * track) / extent));
        const start = extent > track ? (offset / (extent - track)) * (track - length) : 0;
        const position = vertical
          ? event.clientY - rect.top - next.clientTop
          : event.clientX - rect.left - next.clientLeft;
        hitThumb = position >= start && position <= start + length;
      }
      setThumbHovered(hitThumb ? next : null);
    };
    const onPointerMove = (event: MouseEvent) => {
      pendingPointer = event;
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        if (pendingPointer) updatePointer(pendingPointer);
        pendingPointer = null;
      });
    };
    const onPointerDown = () => {
      dragging = thumbHovered !== null;
      if (dragging) thumbHovered?.setAttribute("data-scrollbar-dragging", "");
    };
    const onPointerUp = () => {
      dragging = false;
      shell
        .querySelectorAll("[data-scrollbar-dragging]")
        .forEach((element) => element.removeAttribute("data-scrollbar-dragging"));
      shell.querySelectorAll<HTMLElement>("[data-scrollbar-active]").forEach(hideLater);
    };
    const onPointerLeave = () => {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      pendingPointer = null;
      setThumbHovered(null);
      const previous = hovered;
      hovered = null;
      if (previous) hideLater(previous);
    };
    const onBlur = () => {
      setThumbHovered(null);
      hovered = null;
      onPointerUp();
    };
    // 捕获真实滚动，不切换 overflow/宽度；每个滚动容器独立计时，避免内容抖动。
    shell.addEventListener("scroll", onScroll, true);
    shell.addEventListener("mousemove", onPointerMove, true);
    shell.addEventListener("mousedown", onPointerDown, true);
    shell.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("mouseup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      shell.removeEventListener("scroll", onScroll, true);
      shell.removeEventListener("mousemove", onPointerMove, true);
      shell.removeEventListener("mousedown", onPointerDown, true);
      shell.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onBlur);
      setThumbHovered(null);
      shell
        .querySelectorAll("[data-scrollbar-dragging]")
        .forEach((element) => element.removeAttribute("data-scrollbar-dragging"));
      cancelAnimationFrame(pointerFrame);
      timers.forEach(window.clearTimeout);
      timers.clear();
      shell
        .querySelectorAll("[data-scrollbar-container]")
        .forEach((element) => element.removeAttribute("data-scrollbar-container"));
      animations.forEach((animation) => animation.cancel());
      animations.clear();
      shell
        .querySelectorAll("[data-scrollbar-active]")
        .forEach((element) => element.removeAttribute("data-scrollbar-active"));
    };
  }, []);

  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationAutoCollapseStateRef = useRef({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  const openWorkspaceKeys = useMemo(
    () => workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
    [workspaceTabs],
  );
  // 保活回收：workspace tab 真正关闭（从 openWorkspaceKeys 移除）时，回收属于该 workspace 的
  // side pane terminal 常驻 session（杀 PTY + 销 xterm），避免孤儿进程泄漏。
  // 切 workspace 不会让 workspaceKey 离开这个集合，所以保活的 session 不受影响。
  // 对称下侧 Terminal.tsx:145-177 的 openWorkspaceKeys 回收逻辑。
  useEffect(() => {
    const retained = new Set(openWorkspaceKeys);
    sidePaneTerminalSessionRegistry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
  }, [openWorkspaceKeys]);
  // 完整视图（docs/ui/side-pane-full-view.md）只读派生：不改侧栏、面板宽度等原有状态，退出后自然恢复。
  const fullViewController = isWebRemoteControlShell ? undefined : sidePaneFullView;
  const activeFullView =
    workspaceMainView === "chat" ? (fullViewController?.fullView ?? null) : null;
  const isFullView = activeFullView !== null;
  const fullViewMode: SidePaneFullViewHostMode = !activeFullView
    ? "normal"
    : activeFullView.surface === "conversation"
      ? "conversation"
      : "floating";
  const isFloatingFullView = fullViewMode === "floating";
  const isFullViewRef = useRef(isFullView);
  isFullViewRef.current = isFullView;
  const [fullViewSlotElement, setFullViewSlotElement] = useState<HTMLDivElement | null>(null);
  const [floatingAnchor, setFloatingAnchor] = useState<FloatingAnchor>(
    readFloatingAnchorPreference,
  );
  const handleFloatingAnchorChange = useCallback((anchor: FloatingAnchor) => {
    setFloatingAnchor(anchor);
    writeFloatingAnchorPreference(anchor);
  }, []);
  const handleFullViewFloatingChange = useCallback(
    (floating: SidePaneFullViewFloating) => fullViewController?.setFloating(floating),
    [fullViewController],
  );
  const handleOpenFullViewConversation = useCallback(
    () => fullViewController?.setSurface("conversation"),
    [fullViewController],
  );
  const fullViewConversationTitle =
    activeTaskTitle?.trim() || intl.formatMessage({ id: "taskList.untitled" });
  // 完整视图保留左侧任务列表与左上角按钮组，侧栏显隐只由用户开关决定。
  const isSidebarPanelVisible = isSidebarVisible;
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    // 浮窗只承载对话本身；终端只在普通视图和完整视图的对话 tab 中显示，开合状态不变。
    open: isTerminalOpen && !isFloatingFullView,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    // 截图 surface 由 browser-use tab 自己的 fixed 承载层提供尺寸，不能再把整个右侧
    // ResizablePanel 撑开；否则自动化页会闪出空白的 tab 栏，且面板过渡期间 guest surface
    // 仍可能被 Chromium 判定为不可合成。
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
    animateWidth: true,
  });
  const mobileSidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
  const mobileSidePanePanelElementRef = useRef<HTMLDivElement | null>(null);
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  const simplifyHeaderForNarrowRemote = isWebRemoteControlShell && isWebRemoteControlMobileViewport;
  const showTopOverlayNewTaskButton = !isSidebarVisible;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    };
  }, [handleToggleSidebar, handleToggleSidePane, isSidebarVisible, isSidePaneOpen, workspaceKey]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    const collapseSidebarIfStillNarrow = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;
      // 完整视图中对话由宿主 fixed 定位，对话列宽度不代表可见对话区，不能据此收起面板或侧栏。
      if (isFullViewRef.current) {
        return;
      }

      // 功能说明：自动收起只响应用户改变窗口尺寸后的 conversation 实际宽度。
      // 不监听 conversation 自身 ResizeObserver，避免用户手动打开面板时又被策略关回去。
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // Bugfix: 大会话 resize trace 显示自动收起侧栏会触发 WorkspaceSidebar
      // 和大量 tooltip/menu 子树重渲染；拖拽窗口过程中先等 resize idle，再保留原收起语义。
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView]);

  useEffect(() => {
    workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
  }, [workspaceSidebarPanelWidthPx]);

  const applyWorkspaceSidebarWidthDuringDrag = useCallback(
    (nextWidthPx: number) => {
      workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      // Bugfix: 大会话 trace 显示拖拽侧栏时每个 pointermove 都 setState，
      // 会让 WorkspaceShellLayout、WorkspaceSidebar 和 ChatView 大树反复 render。
      // 拖拽中的宽度只是瞬时布局值，直接写 CSS 变量；释放时再提交 React state。
      shellElement.style.setProperty(
        WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
        `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
      );
      shellElement.style.setProperty(WORKSPACE_SIDEBAR_WIDTH_CSS_VAR, `${nextWidthPx}px`);
    },
    [collapsedSidebarWidthPx, isSidebarPanelVisible],
  );

  useEffect(() => {
    if (readStoredWorkspaceSidebarWidthPx() !== null) {
      return;
    }

    const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
    const shellElement = workspaceShellRef.current;
    if (legacyRatio === null || !shellElement) {
      return;
    }

    const containerWidthPx = shellElement.getBoundingClientRect().width;
    if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
      return;
    }

    // 修复原因：外层 workspace shell 不再使用 react-resizable-panels，
    // 但旧版本已持久化过 sidebar/content 百分比。迁移成像素宽度后，
    // 普通窗口 resize 不会再触发 RRP layout store，同时仍保留用户拖出的侧栏宽度。
    const migratedWidthPx = clampWorkspaceSidebarWidth(
      containerWidthPx * legacyRatio,
      containerWidthPx,
    );
    workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
    setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
    persistWorkspaceSidebarWidthPx(migratedWidthPx);
  }, []);

  const applyWorkspaceSidebarWidth = useCallback(
    (nextWidthPx: number, options: { persist: boolean }) => {
      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const resolvedWidthPx = clampWorkspaceSidebarWidth(nextWidthPx, containerWidthPx);
      workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
        currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
      );
      if (options.persist) {
        persistWorkspaceSidebarWidthPx(resolvedWidthPx);
      }
      return resolvedWidthPx;
    },
    [],
  );

  const handleWorkspaceSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      workspaceSidebarResizeSessionRef.current = {
        containerWidthPx,
        pointerId: event.pointerId,
        startWidthPx: workspaceSidebarPanelWidthPxRef.current,
        startX: event.clientX,
      };
      setWorkspaceSidebarResizeActive({
        active: true,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isSidebarPanelVisible],
  );

  const handleWorkspaceSidebarResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const nextWidthPx = clampWorkspaceSidebarWidth(
        resizeSession.startWidthPx + event.clientX - resizeSession.startX,
        resizeSession.containerWidthPx,
      );
      applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
      event.currentTarget.setAttribute("aria-valuenow", String(Math.round(nextWidthPx)));
    },
    [applyWorkspaceSidebarWidthDuringDrag],
  );

  const finishWorkspaceSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      workspaceSidebarResizeSessionRef.current = null;
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
        const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
        return currentWidthPx === finalWidthPx ? currentWidthPx : finalWidthPx;
      });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!cancelled) {
        persistWorkspaceSidebarWidthPx(workspaceSidebarPanelWidthPxRef.current);
      }
    },
    [],
  );

  const handleWorkspaceSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible) {
        return;
      }

      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const maxWidthPx =
        containerWidthPx && containerWidthPx > 0
          ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
          : workspaceSidebarPanelWidthPxRef.current;
      let nextWidthPx: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current - WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "ArrowRight") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current + WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "Home") {
        nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
      } else if (event.key === "End") {
        nextWidthPx = maxWidthPx;
      }

      if (nextWidthPx === null) {
        return;
      }

      event.preventDefault();
      applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
    },
    [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
  );

  useEffect(() => {
    return () => {
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
    };
  }, []);

  useEffect(() => {
    webRemoteControlNavigationHeightRef.current = webRemoteControlNavigationHeightPx;
    webRemoteControlNavigationCollapsedRef.current = isWebRemoteControlNavigationCollapsed;
  }, [isWebRemoteControlNavigationCollapsed, webRemoteControlNavigationHeightPx]);
  useEffect(() => {
    if (
      !isWebRemoteControlShell ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQueryList = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY);
    const syncMobileViewport = () => {
      setIsWebRemoteControlMobileViewport(mediaQueryList.matches);
    };

    syncMobileViewport();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", syncMobileViewport);
      return () => {
        mediaQueryList.removeEventListener("change", syncMobileViewport);
      };
    }

    mediaQueryList.addListener(syncMobileViewport);
    return () => {
      mediaQueryList.removeListener(syncMobileViewport);
    };
  }, [isWebRemoteControlShell]);

  useEffect(() => {
    if (!isWebRemoteControlShell || typeof window === "undefined") {
      return;
    }

    const clampNavigationHeightToViewport = () => {
      if (webRemoteControlNavigationCollapsedRef.current) {
        return;
      }

      const viewportHeight = getWebRemoteControlViewportHeight();
      setWebRemoteControlNavigationHeightPx(
        (currentHeightPx) =>
          resolveWebRemoteNavigationDragState({
            heightPx: currentHeightPx,
            viewportHeight,
          }).heightPx,
      );
    };

    window.addEventListener("resize", clampNavigationHeightToViewport);
    return () => {
      window.removeEventListener("resize", clampNavigationHeightToViewport);
    };
  }, [isWebRemoteControlShell]);
  const applyWebRemoteNavigationState = useCallback((nextState: WebRemoteNavigationState) => {
    setWebRemoteControlNavigationHeightPx(nextState.heightPx);
    setIsWebRemoteControlNavigationCollapsed(nextState.isCollapsed);
  }, []);
  const toggleWebRemoteNavigation = useCallback(() => {
    const nextState = resolveWebRemoteNavigationToggleState({
      currentHeightPx: webRemoteControlNavigationHeightRef.current,
      isCollapsed: webRemoteControlNavigationCollapsedRef.current,
      viewportHeight: getWebRemoteControlViewportHeight(),
    });

    logger.debug("[WorkspaceShellLayout] Web 远控导航快速切换", nextState);
    applyWebRemoteNavigationState(nextState);
  }, [applyWebRemoteNavigationState]);
  const handleWebRemoteNavigationResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      const startHeightPx = webRemoteControlNavigationCollapsedRef.current
        ? 0
        : webRemoteControlNavigationHeightRef.current;
      webRemoteControlNavigationDragRef.current = {
        pointerId: event.pointerId,
        startHeightPx,
        startY: event.clientY,
        didDrag: false,
      };
      suppressWebRemoteControlNavigationClickRef.current = true;
      setIsWebRemoteControlNavigationDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽开始", {
        startHeightPx,
      });
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteNavigationResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      const deltaY = event.clientY - dragSession.startY;
      if (!dragSession.didDrag && Math.abs(deltaY) < WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX) {
        return;
      }

      event.preventDefault();
      dragSession.didDrag = true;
      applyWebRemoteNavigationState(
        resolveWebRemoteNavigationDragState({
          heightPx: dragSession.startHeightPx + deltaY,
          viewportHeight: getWebRemoteControlViewportHeight(),
        }),
      );
    },
    [applyWebRemoteNavigationState],
  );
  const finishWebRemoteNavigationResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      webRemoteControlNavigationDragRef.current = null;
      setIsWebRemoteControlNavigationDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (cancelled) {
        suppressWebRemoteControlNavigationClickRef.current = false;
        return;
      }

      if (!dragSession.didDrag) {
        toggleWebRemoteNavigation();
        return;
      }

      const nextState = resolveWebRemoteNavigationDragState({
        heightPx: dragSession.startHeightPx + event.clientY - dragSession.startY,
        viewportHeight: getWebRemoteControlViewportHeight(),
      });
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽结束", nextState);
      applyWebRemoteNavigationState(nextState);
    },
    [applyWebRemoteNavigationState, toggleWebRemoteNavigation],
  );
  const handleWebRemoteNavigationHandleClick = useCallback(() => {
    if (suppressWebRemoteControlNavigationClickRef.current) {
      suppressWebRemoteControlNavigationClickRef.current = false;
      return;
    }

    toggleWebRemoteNavigation();
  }, [toggleWebRemoteNavigation]);
  const handleWebRemoteTaskOpen = useCallback(
    ({ crossWorkspace }: { crossWorkspace: boolean }) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }

      // Bugfix: 远控移动端在“选中任务”后仍保持顶部导航展开，会挤压会话区域，读写消息时需要再手动折叠一次。
      // 这里在任务点击后自动折叠；跨 workspace 跳转时再写一次 session intent，确保新页面首帧也保持折叠态。
      setIsWebRemoteControlNavigationCollapsed(true);
      if (crossWorkspace) {
        markWebRemoteControlCollapseIntent();
      }
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteTaskSwitchingChange = useCallback((switching: boolean) => {
    setIsWebRemoteControlTaskSwitching(switching);
  }, []);
  const renderWebRemoteNavigationPanel = shouldRenderWebRemoteNavigationPanel({
    isCollapsed: isWebRemoteControlNavigationCollapsed,
    isMobileViewport: isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
  });
  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  const renderChatFindDialog = () => <TaskFindDialog {...taskFindDialogProps} placement="chat" />;
  const gitDirtyFileCount = useMemo(() => {
    // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
    // 这里按 path 去重后再统计，避免入口里“未提交更改文件数”被重复计算。
    return getGitDirtyFileCount(gitState.datasets);
  }, [gitState.datasets.staged, gitState.datasets.unstaged]);
  // Bug 原因：此前本地 workspace 没有 identity 时只按路径取第一个 tab；同路径远程 tab 在前时，
  // 本地任务的 Header 会显示远程设备与连接状态。与 TabStore 共用匹配规则，未传 identity 只命中本地 tab。
  const currentWorkspaceTab = useMemo(
    () =>
      workspaceTabs.find((tab) => isSameWorkspaceTab(tab, workspaceAbsPath, { workspaceIdentity })),
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceRemoteTarget = currentWorkspaceTab?.remoteTarget;
  const workspaceLocalPathForRemoteMcpSync = currentWorkspaceTab?.localWorkspacePath;
  const webRemoteNavigationPanelStyle = useMemo<CSSProperties | undefined>(
    () =>
      isWebRemoteControlShell
        ? ({
            "--web-remote-navigation-height": `${webRemoteControlNavigationHeightPx}px`,
          } as CSSProperties)
        : undefined,
    [isWebRemoteControlShell, webRemoteControlNavigationHeightPx],
  );
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        ...webRemoteNavigationPanelStyle,
        "--workspace-sidebar-panel-width": `${
          isSidebarPanelVisible ? workspaceSidebarPanelWidthPx : collapsedSidebarWidthPx
        }px`,
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
      webRemoteNavigationPanelStyle,
    ],
  );
  const findFileLinkOwnerWorkspace = useCallback(
    (
      targetPath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspaceRemoteSessionId?: string,
    ) => {
      const matches = workspaceTabs.filter(
        (tab) =>
          isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity) &&
          (!targetWorkspaceRemoteSessionId ||
            tab.remoteSessionId === targetWorkspaceRemoteSessionId),
      );
      if (matches.length === 0) {
        return null;
      }
      return (
        matches.sort((left, right) => {
          const leftActive = left.workspaceIdentity === workspaceIdentity ? 1 : 0;
          const rightActive = right.workspaceIdentity === workspaceIdentity ? 1 : 0;
          if (leftActive !== rightActive) {
            return rightActive - leftActive;
          }
          return right.workspacePath.length - left.workspacePath.length;
        })[0] ?? null
      );
    },
    [workspaceIdentity, workspaceTabs],
  );
  const openFileTreeRequest = useCallback((request: Omit<SidebarFileTreeOpenRequest, "id">) => {
    fileTreeOpenRequestIdRef.current += 1;
    setFileTreeOpenRequest({
      id: fileTreeOpenRequestIdRef.current,
      ...request,
    });
  }, []);
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  const handleOpenDraftPluginUi = useCallback(
    (request: DraftPluginUiOpenRequest) => {
      if (!isDesktop || workspaceReadOnlyReason || workspaceRemoteSessionId) return;
      const store = useZCodeSessionStore.getState();
      const draft = store.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      // 返回已有根草稿，保留项目和输入；不能将当前正式会话当作插件目标。
      if (draft.activeTaskId !== null)
        store.startDraft(workspaceAbsPath, undefined, workspaceIdentity, {
          projectId: draft.draftProjectId,
          taskGroupId: draft.draftTaskGroupId,
        });
      store.requestPluginUiOpen(request);
      showChatMainView();
    },
    [
      isDesktop,
      workspaceReadOnlyReason,
      workspaceRemoteSessionId,
      workspaceAbsPath,
      workspaceIdentity,
      showChatMainView,
    ],
  );
  // nav.primary 插槽的 Shell 入口（docs/plugins/extension-host.md §16.4）：根草稿与回到对话都归 Shell。
  // 用 useMemo 保持引用稳定，避免穿透侧栏的 memo。
  const navPrimarySlot = useMemo(
    () => ({
      sessionId: activeTaskId,
      onOpenDraftUi: handleOpenDraftPluginUi,
      onShowChat: showChatMainView,
    }),
    [activeTaskId, handleOpenDraftPluginUi, showChatMainView],
  );
  const primaryNavigationBack =
    workspaceMainView === "plugin-store" ? showChatMainView : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  useEffect(() => {
    if (
      isWebRemoteControlShell &&
      (workspaceMainView === "automations" || workspaceMainView === "plugin-store")
    ) {
      // 修复原因：手机远控复用桌面 shell 时可能保留上一次主视图状态；
      // 远控不承载 Automations，必须立即回落到 continuous/replayable 边界之外的聊天页。
      onWorkspaceMainViewChange("chat");
    }
  }, [isWebRemoteControlShell, onWorkspaceMainViewChange, workspaceMainView]);
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason 判定的是活动 workspace；当 request 显式带 targetWorkspace 时
      // 目标另属他项目（跨项目发起已保存工作流，docs/dynamic-workflow/launch.md「The detail page」），
      // 活动 workspace 的只读性不适用，真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly。
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      showChatMainView();
      onCreateTask(request);
    },
    [onCreateTask, showChatMainView, workspaceReadOnlyReason],
  );
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  // 切入草稿曾改变侧栏选任务回调，让全部项目重渲染；点击时使用最近已提交的绑定，保留分屏导航语义。
  const shellWorkbenchBindingRef = useRef(shellWorkbenchBinding);
  useLayoutEffect(() => {
    shellWorkbenchBindingRef.current = shellWorkbenchBinding;
  }, [shellWorkbenchBinding]);
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // 带 target 时跳过活动 workspace 只读检查，交由 handleCreateTaskInChat / root 动作在
      // target 上校验（docs/dynamic-workflow/launch.md「The detail page」）；无 target 时形状不变。
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // 工作流「运行」现由中枢直接启动（docs/dynamic-workflow/launch.md）：GUI 建空会话 +
  // 发 startSavedWorkflow 命令，不再合成对话文案。本层只在 accepted 后把会话切到前台。
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      if (!isWebRemoteControlShell) {
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            tabStoreApi.getState().addTab(workspacePath);
          },
        });
        if (!workspaceResult.accepted) {
          logger.warn("[automations] 运行历史目标远程 workspace 未连接，保留当前页面", {
            sessionId: taskId,
            workspaceIdentity: targetWorkspaceIdentity,
            workspacePath: targetWorkspacePath,
          });
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          // tab 分类变化不影响点击回调；目标连接从窗口 store 读取，保持最新远端身份。
          tabStoreApi
            .getState()
            .tabs.filter(isWorkspaceTab)
            .find(
              (tab) =>
                (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
                (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
            )?.remoteSessionId;
        const target: WorkbenchSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        selectWorkbenchSession(shellWorkbenchBindingRef.current, target);
      }
      // 只有目标 workspace 已经激活或补开成功后才关闭 Automations，避免失败时看起来像跳转成功。
      showChatMainView();
      if (typeof expectedUnreadAt === "number") {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity, expectedUnreadAt);
      } else {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      }
    },
    [handleSelectTask, intl, isWebRemoteControlShell, showChatMainView, tabStoreApi],
  );
  // 中枢直接启动 accepted 后切到新会话（run 卡已在顶部）：复用运行历史那条导航，
  // target 恒带工作流所属项目坐标（不变式 7），remoteSessionId 决定连接 endpoint。
  // 「已保存」芯片的落点：交给 App 切主视图并设深链（与「自动化」入口同一条导航历史）。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      onOpenSavedWorkflowInHub(target);
    },
    [onOpenSavedWorkflowInHub],
  );
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // 工作流运行历史「查看实例」：先回到发起它的会话（侧栏页只在 chat 视图里可见），再开实例详情页。
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // 中枢是跨项目视图：实例必须开在发起它的项目，而非活动项目（不变式 8）。
      // params 恒带 workspacePath/identity；仅在异常缺省时兜底回退到活动 workspace。
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId 不在契约里：按目标 workspace 从已打开 tab 反查；命中活动项目即取活动值。
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowRun({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        toolCallId: params.toolCallId,
        runId: params.runId,
        workflowName: params.workflowName,
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // 侧栏运行行（docs/dynamic-workflow/presentation.md「The sidebar run line」）：与 composer 徽标
  // 同一跳转——先选中会话，再开 run pane。没有 toolCallId 的 run（不该有）只选中会话。
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // 中枢的产物 chip：与「查看实例」逐字同构（同一条「先回到发起它的会话」的路径），
  // 只是终点是 `workflow-artifact` tab 而不是 run 详情页。
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowArtifact({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.title === undefined ? {} : { title: params.title }),
        // 中枢的 chip 载荷带得到 contentType（html 产物据它直接开浏览器 tab）；`sourcePath`
        // 那份载荷没有，由 `handleOpenWorkflowArtifact` 自己查 journal 补。
        ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
      origin?: "draft-promotion",
    ) => {
      if (origin === "draft-promotion") handleSidePaneDraftPromotion(sessionId);
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat, handleSidePaneDraftPromotion],
  );

  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      showChatMainView();
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        targetWorkspacePurpose,
        createSource,
      );
    },
    [handleStartDraftInWorkspace, showChatMainView],
  );
  const handleCreateProjectDraft = useCallback(
    (path: string, identity?: string) =>
      handleStartDraftInWorkspaceInChat(path, identity, undefined, "project"),
    [handleStartDraftInWorkspaceInChat],
  );
  const activeWorkspacePurpose = currentWorkspaceTab?.workspacePurpose ?? "project";
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    let target: Awaited<ReturnType<typeof onResolveConversationWorkspace>>;
    try {
      target = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
        error,
      });
      return;
    }
    // Bug 原因：这里曾用 targetWorkspacePath 在 workspaceTabs 里反查 conversation tab 的 identity。
    // 多设备的 conversation backing path 同为各自 home 下的固定目录，home 相同时会命中别的设备。
    // 现在 identity 由 Root 按 Source 归属解析后一并回传，Shell 直接消费，不再按路径判等。
    const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspaceKey) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath: target.workspacePath,
        targetWorkspaceIdentity: target.workspaceIdentity,
      });
    }
    handleStartDraftInWorkspaceInChat(
      target.workspacePath,
      target.workspaceIdentity,
      "conversation",
    );
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleSelectComposerPlugin = useCallback(
    (mention: ComposerMentionPrefill) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspaceAbsPath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceAbsPath, workspaceIdentity],
  );
  // v4 pane 生命周期回调（稳定引用，供 memo 友好的 pane 宿主消费）：
  // createSession/fork 后接入既有选择路径；删除会话后回 draft。
  const handleV4SessionCreated = useCallback(
    (sessionId: string, origin?: "draft-promotion") => {
      if (origin === "draft-promotion") handleSidePaneDraftPromotion(sessionId);
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, handleSidePaneDraftPromotion, workspaceAbsPath, workspaceIdentity],
  );
  // 草稿头部保留项目菜单与 Git 分支；项目目录由共享 Provider 提供。
  // Shell 只连接既有导航回调，pane 不持有另一份项目列表或 cwd 归属推断。
  const draftProjectId = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspaceAbsPath, workspaceIdentity).draftProjectId ?? null,
  );
  // worktree 复选框只对本地桌面的 Git 项目草稿开放（docs/git/worktree.md §3.1）。
  const worktreeEligible =
    activeWorkspacePurpose === "project" &&
    !isOfficeMode &&
    !isWebRemoteControlShell &&
    !workspaceIdentity &&
    !workspaceRemoteSessionId &&
    gitState.summary.isRepository &&
    Boolean(draftProjectId);
  const worktreeSupport = useWorktreeSupport(workspaceAbsPath, workspaceIdentity, worktreeEligible);
  const draftWorktree = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspaceAbsPath, workspaceIdentity).draftWorktree ?? null,
  );
  const setDraftWorktree = useZCodeSessionStore((state) => state.setDraftWorktree);
  const draftWorktreeCallbacks = useMemo(
    () => createDraftWorktreeCallbacks(setDraftWorktree, workspaceAbsPath, workspaceIdentity),
    [setDraftWorktree, workspaceAbsPath, workspaceIdentity],
  );
  const viewWorktreeCreation = useZCodeSessionStore((state) => state.viewWorktreeCreation);
  const viewedCreationId = useZCodeSessionStore(
    (state) =>
      state.getWorkspaceState(workspaceAbsPath, workspaceIdentity).draftWorktreeCreationId ?? null,
  );
  const worktreeCreations = useManagedWorktreeCreations();
  // 结束事件先于记录列表推送到达（§3.3），此时列表里仍有这条记录；用 ref 在回调中读取最新列表。
  const worktreeCreationsRef = useRef(worktreeCreations);
  worktreeCreationsRef.current = worktreeCreations;
  const beginWorktreeHandoff = useZCodeSessionStore((state) => state.beginWorktreeHandoff);
  const worktreeHandoff = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspaceAbsPath, workspaceIdentity).worktreeHandoff ?? null,
  );
  const viewedCreation =
    activeTaskId === null && viewedCreationId
      ? (worktreeCreations.find((creation) => creation.id === viewedCreationId) ?? null)
      : null;
  // 会话首个快照到达前，创建视图盖在已挂载的会话上（§3.3）。
  const handoffCreation =
    worktreeHandoff && worktreeHandoff.sessionId === activeTaskId ? worktreeHandoff.creation : null;
  // 创建结束：会话已启动则打开它；放弃则把首条消息放回新草稿（§3.5）。只处理当前展示的记录。
  const handleWorktreeSettlement = useCallback(
    (settlement: ManagedWorktreeCreationSettlement) => {
      const state = useZCodeSessionStore
        .getState()
        .getWorkspaceState(settlement.workspacePath, workspaceIdentity);
      if (state.draftWorktreeCreationId !== settlement.creationId) return;
      const creation = worktreeCreationsRef.current.find(
        (entry) => entry.id === settlement.creationId,
      );
      // Bug 原因：曾在结束事件时直接卸载创建视图并打开会话，会话首个快照要几百毫秒后才到，
      // 中间主区一片空白。现在保留最后一份记录，盖在会话上，直到时间线出现内容（§3.3）。
      if (settlement.outcome === "session-started" && creation)
        beginWorktreeHandoff(
          settlement.workspacePath,
          { sessionId: settlement.sessionId, creation },
          workspaceIdentity,
        );
      viewWorktreeCreation(settlement.workspacePath, null, workspaceIdentity);
      if (settlement.outcome === "session-started") {
        handleSelectTaskInChat(settlement.workspacePath, settlement.sessionId);
        return;
      }
      handleCreateTaskInChat({
        ...(state.draftProjectId !== undefined ? { projectId: state.draftProjectId } : {}),
        ...(settlement.promptText ? { initialPrompt: settlement.promptText } : {}),
      });
    },
    [
      beginWorktreeHandoff,
      handleCreateTaskInChat,
      handleSelectTaskInChat,
      viewWorktreeCreation,
      workspaceIdentity,
    ],
  );
  useManagedWorktreeSettlements(handleWorktreeSettlement);
  const draftComposerHeader = useMemo(
    () => (
      <>
        <ProjectComposerMenu
          showEditProject
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          compactForRemoteControl={isWebRemoteControlShell}
          onCreateTask={handleCreateTaskInChat}
          onSelectConversationWorkspace={handleSelectConversationWorkspace}
          allowRemoteWorkspace={allowRemoteWorkspace}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          onConnectRemote={onConnectRemote}
          onCancelRemote={onCancelRemoteProject}
        >
          {isOfficeMode && !isWebRemoteControlShell ? (
            <WorkspacePluginPreview
              onOpen={handleOpenPluginStore}
              onSelectPlugin={handleSelectComposerPlugin}
              workspacePath={workspaceAbsPath}
              workspaceIdentity={workspaceIdentity}
              remoteSessionId={workspaceRemoteSessionId ?? undefined}
            />
          ) : !isOfficeMode &&
            activeWorkspacePurpose === "project" &&
            draftWorktree &&
            draftProjectId ? (
            // worktree 模式：分支只决定新 worktree 的起点，不切换主目录（§3.2）。
            <WorktreeBranchPicker
              projectId={draftProjectId}
              selectedRef={draftWorktree.ref}
              // Bug 原因：这里曾用 branchName ?? "HEAD"，GitBranchSwitcher 用 resolveGitBranchTriggerLabel；
              // 游离 HEAD 时一个显示"HEAD"、一个显示"游离 HEAD"，勾选 worktree 时胶囊文字和宽度跳变（WT-34）。
              currentBranchLabel={resolveGitBranchTriggerLabel({
                headRefType: gitState.summary.headRefType,
                currentBranchName: gitState.summary.branchName ?? null,
                detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
                fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
              })}
              onSelect={draftWorktreeCallbacks.onSelect}
              // Bug 原因：两个分支胶囊的外层间距不同（px-1 pt-2 与 px-0 pt-0），勾选 worktree 时
              // composer 头部变高 4px、复选框右移 8px，看起来抖动。两者使用同一外层间距。
              className="px-0 pt-0"
            />
          ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
            <GitBranchSwitcher
              workspacePath={workspaceAbsPath}
              gitSummary={gitState.summary}
              dirtyFileCount={gitDirtyFileCount}
              onRefreshGit={handleRefreshGit}
              compactForRemoteControl={isWebRemoteControlShell}
              className="px-0 pt-0"
              popoverClassName="w-72"
              branchListClassName="max-h-48"
              // Bugfix（旧注释保真）：输入框区域在底部，Radix 碰撞避让会把分支菜单翻到下方。
              // 这里锁定上方弹出，避免菜单遮挡输入区并保持操作方向稳定。
              avoidPopoverCollisions={false}
            />
          ) : null}
        </ProjectComposerMenu>
        {/* worktree 复选框固定贴在头部最右端（docs/git/worktree.md §3.2）：渲染在项目菜单之后，
            ml-auto 吃掉中间剩余空间。高度跟随其他胶囊的 h-7，避免三个 hover 容器高度不一致。 */}
        {worktreeEligible && worktreeSupport.visible ? (
          <WorktreeToggle
            className="ml-auto"
            checked={Boolean(draftWorktree)}
            disabled={!worktreeSupport.available}
            onCheckedChange={draftWorktreeCallbacks.onCheckedChange}
          />
        ) : null}
      </>
    ),
    [
      isOfficeMode,
      workspaceRemoteSessionId,
      handleOpenPluginStore,
      handleSelectComposerPlugin,
      allowRemoteWorkspace,
      activeWorkspacePurpose,
      gitDirtyFileCount,
      gitState.summary,
      handleRefreshGit,
      handleSelectConversationWorkspace,
      handleCreateTaskInChat,
      isWebRemoteControlShell,
      onOpenRemoteWorkspace,
      onConnectRemote,
      onCancelRemoteProject,
      workspaceAbsPath,
      workspaceIdentity,
      worktreeEligible,
      worktreeSupport.available,
      worktreeSupport.visible,
      draftWorktree,
      draftProjectId,
      draftWorktreeCallbacks,
    ],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleOpenMarkdownFileLink = useCallback(
    async (target: WorkspacePathOpenRequest) => {
      if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
        return;
      }
      try {
        const fileService = selectWorkspacePathFileService(
          target,
          services.fileService,
          baseServices.fileService,
        );
        const fileStat = await fileService.stat({
          path: target.path,
        });
        if (fileStat.type === "file") {
          if (
            shouldOpenAssistantHtmlInBrowser({
              path: target.path,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
              compactForRemoteControl: isWebRemoteControlShell,
            })
          ) {
            handleOpenBrowserUrl(toFileUrl(target.path));
            return;
          }
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
          return;
        }

        if (target.serviceScope === "base-local") {
          openFileTreeRequest({
            target: {
              workspacePath: target.path,
              workspaceName: target.label || getPathLeaf(target.path),
              revealPath: target.path,
              temporaryExternalDirectory: true,
            },
          });
          return;
        }

        const ownerWorkspace = findFileLinkOwnerWorkspace(
          target.path,
          target.workspaceIdentity,
          target.workspaceRemoteSessionId,
        );
        if (ownerWorkspace) {
          openFileTreeRequest({
            target: {
              workspacePath: ownerWorkspace.workspacePath,
              workspaceName: ownerWorkspace.label,
              workspaceIdentity: ownerWorkspace.workspaceIdentity,
              workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
              revealPath: areWorkspaceFilePathsEqual(ownerWorkspace.workspacePath, target.path)
                ? undefined
                : target.path,
            },
          });
          return;
        }

        openFileTreeRequest({
          target: {
            workspacePath: target.path,
            workspaceName: target.label || getPathLeaf(target.path),
            revealPath: target.path,
            temporaryExternalDirectory: true,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceShell] 打开 markdown 文件链接失败", {
          path: target.path,
          error: message,
        });
        if (shouldFallbackWorkspacePathToCodeViewer(target)) {
          // Bugfix: markdown file link 可能指向已不存在的路径。
          // stat 失败时保持旧行为交给 CodeViewer 展示具体读文件错误，避免点击完全无反馈。
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
        }
        toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
      }
    },
    [
      findFileLinkOwnerWorkspace,
      baseServices.fileService,
      handleOpenBrowserUrl,
      handleOpenCodeViewer,
      intl,
      isWebRemoteControlShell,
      openFileTreeRequest,
      services.fileService,
      workspaceReadOnlyReason,
    ],
  );
  useEffect(
    () =>
      addWorkspacePathOpenRequestListener((target) => {
        void handleOpenMarkdownFileLink(target);
      }),
    [handleOpenMarkdownFileLink],
  );
  const handleRevealGitFileInTree = useCallback(
    (path: string) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      openFileTreeRequest({
        target: {
          workspacePath: workspaceAbsPath,
          workspaceName: projectName,
          workspaceIdentity,
          workspaceRemoteSessionId,
          revealPath: path,
        },
      });
    },
    [
      openFileTreeRequest,
      projectName,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      workspaceReadOnlyReason,
    ],
  );
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // 固定入口由当前主 SessionPane 承接命令；若 pane 尚未挂载，不允许壳层自行拼接远程身份或协议。
      logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  const hasUpdateStatusButton =
    updateReadyVersion !== null ||
    updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded";
  const renderSidePanePanel = (options: { mobileOverlay?: boolean } = {}) => (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isWindowsDesktop={isWindowsDesktop}
      frameClassName={resolveWorkspaceShellWindowChromeClass({
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
        isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
        supportsNativeRoundedCorners:
          desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
      })}
      showWindowControls={!options.mobileOverlay && usesInlineWindowControls}
      // 工作区保活与侧栏动画会保留 DOM；独立 guest 浮层必须同步服从当前页面的展示状态。
      isVisible={
        isWorkspaceVisible &&
        workspaceMainView === "chat" &&
        isSidePaneOpen &&
        (options.mobileOverlay || isSidePaneVisible)
      }
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      fullViewToggle={
        !options.mobileOverlay && fullViewController
          ? {
              active: isFullView,
              onToggle: fullViewController.toggle,
              shortcutLabel: toggleSidePaneFullViewShortcutLabel,
            }
          : undefined
      }
      fullView={
        !options.mobileOverlay && activeFullView && fullViewController
          ? {
              surface: activeFullView.surface,
              conversationTitle: fullViewConversationTitle,
              leadingInsetClassName: resolveTopOverlayLeadingPaddingClass({
                isSidebarVisible,
                isMacDesktop,
                isMacFullscreen,
                hasUpdateReady: hasUpdateStatusButton,
              }),
              onSelectSurface: fullViewController.setSurface,
            }
          : null
      }
      fullViewSlotRef={options.mobileOverlay ? undefined : setFullViewSlotElement}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      isBrowserOpen={isBrowserOpen}
      supportsEmbeddedBrowser={supportsEmbeddedBrowser}
      workspaceAbsPath={workspaceAbsPath}
      taskCwd={
        resolvedActiveTaskMeta?.taskId === activeTaskId ? resolvedActiveTaskMeta?.cwd : undefined
      }
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      gitState={gitState}
      activeGitSourceId={activeGitSourceId}
      panelRef={options.mobileOverlay ? mobileSidePanePanelRef : sidePanePanelRef}
      panelElementRef={
        options.mobileOverlay ? mobileSidePanePanelElementRef : sidePanePanelElementRef
      }
      browserNavigationRequest={browserNavigationRequest}
      browserRestoreUrls={browserRestoreUrls}
      screenshotSurfaceRequest={options.mobileOverlay ? null : screenshotSurfaceRequest}
      screenshotSurfaceTabId={options.mobileOverlay ? null : (screenshotSurfaceTab?.id ?? null)}
      fileChangeFindActiveIndex={fileChangeFindActiveIndex}
      fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
      fileChangeFindQuery={fileChangeFindQuery}
      onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
      onCloseCodeViewer={handleCloseCodeViewer}
      onCloseGit={handleCloseGit}
      onActivateTab={handleActivateSidePaneTab}
      onOpenNewTab={handleOpenNewSidePaneTab}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenBrowserTab={handleOpenBrowserTab}
      onOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
      onOpenWhiteboard={handleOpenWhiteboard}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenFileManager={handleOpenFileManager}
      onNavigateFileManager={handleNavigateFileManager}
      onOpenPluginMarket={handleOpenPluginMarket}
      onCreateTask={handleCreateTaskInChat}
      isMacDesktop={isMacDesktop}
      onOpenTerminalTab={handleOpenTerminalTab}
      onOpenReviewTab={handleToggleGit}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onRevealGitFileInTree={handleRevealGitFileInTree}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenFileLink={handleOpenMarkdownFileLink}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      onRefreshGit={handleRefreshGit}
      onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
      onBrowserUrlChange={handleBrowserUrlChange}
      onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
      onSelectGitSource={setGitSelectedSourceId}
      mobileOverlay={options.mobileOverlay}
      mobileStacked={isWebRemoteControlShell}
    />
  );
  const sidePanePanel = renderSidePanePanel();
  // 修复原因：Draft 之前维护一套独立轻量 header，导致 side pane、caption 安全区和拖拽入口
  // 与 Task Header 分叉。桌面端统一复用 WorkspaceHeader，只由 variant 裁剪 task 专属内容；
  // 手机远控无 active task 时仍不渲染桌面 chrome，继续遵守 replayable overlay 边界。
  const shouldRenderMainViewHeader =
    workspaceMainView !== "automations" && workspaceMainView !== "plugin-store";
  const shouldRenderWorkspaceHeader =
    shouldRenderMainViewHeader && (activeTaskId !== null || isDesktop);
  // 修复原因：ErrorBoundary resetKeys 的数组如果每次 render 都重新创建，
  // 即使 workspace/task 没变化也会在 React DevTools Components 轨道里持续表现为子树 props 变化。
  const workspaceOnlyResetKeys = useMemo(() => [workspaceKey], [workspaceKey]);
  const workspaceDraftResetKeys = useMemo(
    () => [workspaceKey, activeTaskId ?? "draft"],
    [workspaceKey, activeTaskId],
  );
  const workspaceSidebarVisibilityResetKeys = useMemo(
    () => [workspaceKey, isSidebarVisible],
    [workspaceKey, isSidebarVisible],
  );

  // 手机 home 与桌面 sidebar 共用同一个项目入口；Shell 只接收导航完成事件。
  // 侧栏不消费代码预览；该回调随 session 变化，传入会让无关列表穿透 memo。
  const renderWorkspaceSidebar = (mobile?: {
    navigateToChat(): void;
    setSwitching(switching: boolean): void;
  }) => (
    <WorkspaceSidebar
      workspacePath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      onOpenFileManager={
        mobile
          ? (target) => {
              handleOpenSidebarFiles(target);
              // 手机 Home 不挂载 side pane，文件入口必须同时进入 Chat。
              mobile.navigateToChat();
            }
          : handleOpenSidebarFiles
      }
      onSelectTask={handleSelectTaskInChat}
      onStartDraftInWorkspace={handleStartDraftInWorkspaceInChat}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      fileTreeOpenRequest={fileTreeOpenRequest}
      onCreateTask={handleCreateTaskInChat}
      onCreateConversationTask={onCreateConversationTask ?? handleCreateTaskInChat}
      onCreateConversationTaskOnSource={onCreateConversationTaskOnSource}
      onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
      onOpenRemoteWorkspace={onOpenRemoteWorkspace}
      webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
      theme={theme}
      onConnectRemote={onConnectRemote}
      onSelectRemoteProject={onSelectRemoteProject}
      onCancelRemoteProject={onCancelRemoteProject}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      onLogout={onLogout}
      onLogin={onLogin}
      user={user}
      isDesktop={isDesktop}
      isWebRemoteControl={isWebRemoteControlShell}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      isSidebarVisible={isSidebarVisible}
      onToggleSidebar={handleToggleSidebar}
      toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
      canGoBack={canPrimaryNavigationBack}
      canGoForward={canTaskNavForward}
      onGoBack={primaryNavigationBack}
      onGoForward={handleTaskNavForward}
      goBackShortcutLabel={goBackShortcutLabel}
      goForwardShortcutLabel={goForwardShortcutLabel}
      onOpenCommandCenter={handleOpenCommandCenter}
      onOpenAutomations={handleOpenAutomations}
      automationsActive={workspaceMainView === "automations"}
      onOpenPluginStore={handleOpenPluginStore}
      pluginStoreActive={workspaceMainView === "plugin-store"}
      navPrimarySlot={navPrimarySlot}
      // 桌面没有 mobile 导航动作；内联包装曾让右侧开关穿透侧栏 memo，重复渲染全部项目。
      onWebRemoteTaskOpen={
        mobile
          ? (event) => {
              handleWebRemoteTaskOpen(event);
              // 跨工作区由目标 Root 消费 chat 意图后再导航，不能提前展示旧会话。
              if (!event.crossWorkspace) mobile.navigateToChat();
            }
          : handleWebRemoteTaskOpen
      }
      onWebRemoteTaskSwitchingChange={
        mobile
          ? (switching) => {
              handleWebRemoteTaskSwitchingChange(switching);
              mobile.setSwitching(switching);
            }
          : handleWebRemoteTaskSwitchingChange
      }
    />
  );

  // 断点切换曾卸载查看 Reporter，伪造离开后返回并清掉手动未读。
  // 同一 Shell 持有查看与手机导航，只替换布局内容；真实 Home/后台仍立即撤销查看。
  const renderRemoteShell = (wideContent: ReactNode) =>
    webRemoteControlWorkspaceSwitcher ? (
      <WebRemoteControlMobileShell
        isMobileViewport={isWebRemoteControlMobileViewport}
        taskViewEnabled={
          isWorkspaceVisible && workspaceMainView === "chat" && !isWebRemoteControlTaskSwitching
        }
        activeTaskId={activeTaskId}
        activeWorkspaceIdentity={workspaceIdentity}
        activeWorkspacePath={workspaceAbsPath}
        initialNavigationIntent={initialWebRemoteControlMobileNavigationIntent}
        webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
        isSidePaneOpen={isSidePaneOpen}
        onCloseSidePane={isSidePaneOpen ? handleToggleSidePane : undefined}
        renderTaskHome={renderWorkspaceSidebar}
        switcher={webRemoteControlWorkspaceSwitcher}
        renderChatHeader={() =>
          shouldRenderWorkspaceHeader ? (
            <ScopedErrorBoundary
              scope="workspace-header"
              resetKeys={workspaceOnlyResetKeys}
              variant="compact"
              className="border-b"
            >
              <WorkspaceHeader
                variant={activeTaskId === null ? "draft" : "task"}
                draftDropTargetController={
                  activeTaskId === null ? draftHeaderDropTargetController : undefined
                }
                readOnlyReason={workspaceReadOnlyReason}
                workspaceAbsPath={workspaceAbsPath}
                remoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                remoteTarget={workspaceRemoteTarget}
                localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                projectName={projectName}
                activeTaskTitle={activeTaskTitle}
                activeTaskChangeSummary={activeTaskChangeSummary}
                hasUpdateReady={hasUpdateStatusButton}
                activeTaskId={activeTaskId}
                user={user}
                activeTraceId={activeTraceId}
                activeSessionId={activeSessionId}
                activeTaskProvider={activeTaskProvider}
                resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                sessionLogPath={taskSessionFile.path}
                nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                nativeSessionLogPath={taskNativeSessionLogFile.path}
                nativeSessionLogExists={taskNativeSessionLogFile.exists}
                nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                providerWorkspaceConfigPath={providerConfigFile.path}
                providerWorkspaceConfigExists={providerConfigFile.exists}
                providerWorkspaceConfigLoading={providerConfigFile.loading}
                workspaceHeaderState={workspaceShellZCodeState}
                gitSummary={gitState.summary}
                gitDirtyFileCount={gitDirtyFileCount}
                isMacDesktop={isMacDesktop}
                isMacFullscreen={isMacFullscreen}
                isWindowsDesktop={isWindowsDesktop}
                isWebRemoteControl={isWebRemoteControlShell}
                windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
                isDesktop={isDesktop}
                simplifyForNarrowRemote
                isSidebarVisible={isSidebarVisible}
                isTerminalOpen={isTerminalOpen}
                isSidePaneOpen={isSidePaneOpen}
                onRefreshGit={handleRefreshGit}
                onToggleTerminal={handleToggleTerminal}
                onToggleBrowser={handleToggleBrowser}
                onToggleSidePane={handleToggleSidePane}
                toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                onReloadSession={handleReloadSession}
                reloadSessionDisabled={workspaceSessionActionDisabled}
                reloadSessionPending={reloadSessionPending}
                onCreateTask={handleCreateTaskInChat}
                onOpenWorkspace={onOpenWorkspace}
                allowOpenWorkspace={allowOpenWorkspace}
              />
            </ScopedErrorBoundary>
          ) : null
        }
        chatOverlay={workspaceMainView === "chat" ? renderChatFindDialog() : undefined}
        chatContent={
          workspaceMainView === "automations" && !isWebRemoteControlShell ? (
            <main
              id={AUTOMATIONS_TOAST_ANCHOR_ID}
              className="flex h-full min-h-0 flex-1 flex-col bg-background"
            >
              <AutomationsMainBreadcrumbFrame
                isDesktop={Boolean(isDesktop)}
                sectionLabel={intl.formatMessage({
                  id: "settings.automations.title",
                })}
                ariaLabel={intl.formatMessage({
                  id: "automations.breadcrumbLabel",
                })}
              >
                <div
                  // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                  // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                  className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                >
                  <ScopedErrorBoundary
                    scope="automations-main"
                    resetKeys={workspaceOnlyResetKeys}
                    variant="panel"
                    className="min-h-full"
                  >
                    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                      <AutomationsSection
                        workspacePath={workspaceAbsPath}
                        workspaceIdentity={workspaceIdentity}
                        onCreateViaChat={handleCreateAutomationInChat}
                        onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                        onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                        onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                        openAutomationId={openAutomationId}
                        openAutomationTab={openAutomationTab}
                        onOpenAutomationConsumed={onOpenAutomationConsumed}
                        openWorkflow={openWorkflow}
                        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                        onOpenSession={({ sessionId, workspacePath, workspaceIdentity }) =>
                          handleSelectTaskInChat(workspacePath, sessionId, workspaceIdentity)
                        }
                      />
                    </div>
                  </ScopedErrorBoundary>
                </div>
              </AutomationsMainBreadcrumbFrame>
            </main>
          ) : workspaceMainView === "plugin-store" && !isWebRemoteControlShell ? (
            <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
              <AutomationsMainBreadcrumbFrame
                isDesktop={Boolean(isDesktop)}
                sectionLabel={intl.formatMessage({
                  id: "workspace.openPluginsSettings",
                })}
                ariaLabel={intl.formatMessage({
                  id: "settings.breadcrumbLabel",
                })}
              >
                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                  <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                    <PluginStorePage
                      isDesktop={isDesktop}
                      isMacDesktop={isMacDesktop}
                      isWindowsDesktop={isWindowsDesktop}
                      isWebRemoteControl={isWebRemoteControlShell}
                      key={`plugin-store:${pluginStoreOpenVersion}`}
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      // Bug 根因：独立插件页曾绕过切回聊天页的包装回调，任务虽被创建，
                      // 视图仍停在插件详情，用户看到“立即试用”与示例 Prompt 点击无反应。
                      onCreateTask={handleCreateTaskInChat}
                      onOpenDraftUi={handleOpenDraftPluginUi}
                      sessionId={activeTaskId}
                      remoteSessionId={workspaceRemoteSessionId}
                    />
                  </div>
                </div>
              </AutomationsMainBreadcrumbFrame>
            </main>
          ) : (
            <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
              {/* Bugfix: 手机远控聊天页中间层必须继续提供 flex 高度链。
                只有 h-full 的普通 block 会让 ChatView 的 flex-1 失效，草稿空态贴顶且内部滚动被外层裁掉。 */}
              <ScopedErrorBoundary
                scope="workspace-chat"
                resetKeys={workspaceDraftResetKeys}
                variant="panel"
                className="h-full"
              >
                {/* Bugfix(2026-07-05, M3 验收)：同桌面布局——绑定 activeTaskId 而非 meta 派生的
                  activeSessionId，避免新建 v4 session 因 meta 缓存未刷新而停在 draft。 */}
                {/* Bug 根因：计划详情功能只给桌面 V4WorkspaceChatArea 接了回调，手机卡片因此
                  显示按钮却无法打开抽屉；两端必须复用同一个 renderer Side Pane 入口。 */}
                <V4ChatPane
                  allowEscapeStopOutsidePane={
                    isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible
                  }
                  readOnly={Boolean(workspaceReadOnlyReason)}
                  readOnlyReason={workspaceReadOnlyReason}
                  workspacePath={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  isDesktop={isDesktop === true}
                  compactForRemoteControl={isWebRemoteControlShell}
                  sessionId={activeTaskId}
                  provider={activeTaskProvider ?? undefined}
                  onSessionCreated={handleV4SessionCreated}
                  onSessionDeleted={handleV4SessionDeleted}
                  draftComposerHeader={draftComposerHeader}
                  gitSummary={gitState.summary}
                  gitDirtyFileCount={gitDirtyFileCount}
                  gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                  gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                  activeTaskChangeSummary={activeTaskChangeSummary}
                  summaryPanelVariantOverride={summaryPanelVariantOverride}
                  onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
                  onRefreshGit={handleRefreshGit}
                  onOpenGitReview={handleOpenGitReview}
                  onOpenBrowserUrl={handleOpenBrowserUrl}
                  onOpenAutomationsMain={handleOpenAutomations}
                  onOpenCodeViewer={handleOpenCodeViewer}
                  onAutoOpenAssistantPptx={
                    isDesktop && !isWebRemoteControlShell ? handleAutoOpenAssistantPptx : undefined
                  }
                  onOpenFileLink={handleOpenMarkdownFileLink}
                  onOpenBackgroundBash={handleOpenBackgroundBash}
                  onOpenSubagentSession={handleOpenSubagentSession}
                  onOpenSubagentDirectory={handleOpenSubagentDirectory}
                  onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                  onOpenPlanDetail={handleOpenPlanDetail}
                  onOpenWorkflowRun={handleOpenWorkflowRun}
                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                  onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                  conversationFindQuery={conversationFindQuery}
                  conversationFindActiveIndex={conversationFindActiveIndex}
                  conversationFindNavigationRequestId={conversationFindNavigationRequestId}
                  onConversationFindMatchStateChange={onConversationFindMatchStateChange}
                  searchResultHighlightRequest={activeSearchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                />
              </ScopedErrorBoundary>
            </div>
          )
        }
        sidePaneContent={renderSidePanePanel({ mobileOverlay: true })}
      >
        {wideContent}
      </WebRemoteControlMobileShell>
    ) : (
      wideContent
    );

  const wideContent = (
    // 完成卡上那两个壳级落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
    // run, and running it again」）：芯片开到中枢那一页、「再次运行」启动后切到新会话。只包桌面
    // 这一支——手机远控壳本来就不提供中枢，那边芯片是纯文字。
    <SavedWorkflowHubProvider
      openWorkflow={handleOpenSavedWorkflowInHub}
      navigateToRun={handleNavigateToLaunchedRun}
    >
      <div
        ref={workspaceShellRef}
        data-workspace-shell="true"
        style={workspaceShellSplitStyle}
        className={cn(
          "relative flex h-full min-h-0 w-full overflow-hidden [anchor-scope:--sidebar-task-list-divider]",
          // 修复原因：窗口原生 resize 时，外层 react-resizable-panels 会把每一帧
          // 都写进 layout store，连带侧栏 tooltip/menu 子树反复 commit。这里改成
          // CSS 变量驱动的专用 split，普通窗口 resize 只走浏览器布局，不触发 React 状态。
          isWebRemoteControlShell && "max-md:flex-col",
        )}
      >
        <div
          ref={workspaceSidebarPanelElementRef}
          data-panel=""
          data-workspace-sidebar-panel="true"
          id="sidebar"
          className={cn(
            "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity motion-reduce:transition-none",
            // Bugfix：性能优化曾删掉展开/收起的宽度过渡，导致侧栏瞬切。
            // 恢复原动画；拖动仍直接跟手，不把指针位移变成延迟的尺寸过渡。
            isWebRemoteControlShell &&
              cn(
                // Bugfix: Web 远程控制在手机浏览器里仍复用桌面横向 shell，
                // 264px 侧栏 + 320px 内容区会直接超过视口宽度，导致页面只能横向滚动。
                // 这里只在远控模式的小屏断点把主布局改为上下堆叠，桌面端仍保持原来的分栏。
                // 交互修复：远控移动端改为拖动 WorkspaceHeader 下边框的按钮控制顶部高度，
                // 这里用 CSS 变量同步高度，避免拖动时卸载导航内容或打断任务列表状态。
                renderWebRemoteNavigationPanel
                  ? "max-md:!h-[var(--web-remote-navigation-height)] max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-b max-md:border-border max-md:bg-sidebar"
                  : "max-md:!h-0 max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-0 max-md:!border-b-0",
              ),
            isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {/* Bugfix: 折叠远控顶部导航时保持组件挂载，避免展开后整块 sidebar 重新加载。 */}
          <aside
            id={isWebRemoteControlShell ? "web-remote-control-navigation-panel" : undefined}
            ref={sidebarContainerRef}
            className={cn(
              "h-full overflow-hidden select-none",
              isWebRemoteControlShell && "max-md:min-h-0 max-md:flex-1",
              !renderWebRemoteNavigationPanel && "max-md:hidden",
            )}
            aria-hidden={!isSidebarPanelVisible || !renderWebRemoteNavigationPanel}
          >
            <ScopedErrorBoundary
              scope="workspace-sidebar"
              resetKeys={workspaceOnlyResetKeys}
              variant="panel"
              className="h-full"
            >
              <V4SplitPaneEntryProvider
                enabled={!isWebRemoteControlShell && !isWebRemoteControlMobileViewport}
              >
                <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  {renderWorkspaceSidebar()}
                </WorkflowRunOpenProvider>
              </V4SplitPaneEntryProvider>
            </ScopedErrorBoundary>
          </aside>
        </div>

        {isSidebarPanelVisible && renderWebRemoteNavigationPanel ? (
          <div
            role="separator"
            tabIndex={0}
            aria-controls="sidebar"
            aria-label={workspaceSidebarResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
            aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
            data-testid="resizable-handle"
            onKeyDown={handleWorkspaceSidebarResizeKeyDown}
            onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
            onPointerDown={handleWorkspaceSidebarResizeStart}
            onPointerMove={handleWorkspaceSidebarResizeMove}
            onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
            className={cn(
              "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
              "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 platform-mac-desktop:after:bg-resize-handle platform-windows-desktop:after:bg-resize-handle platform-linux-desktop:after:bg-resize-handle after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
              "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
              hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
              isWebRemoteControlShell && "max-md:hidden",
            )}
          />
        ) : null}
        {isSidebarPanelVisible && renderWebRemoteNavigationPanel ? (
          // 原因：侧栏 overflow 裁掉横线末端；延伸装饰放在共同布局容器，不改变拖拽命中区。
          <span
            aria-hidden="true"
            data-sidebar-divider-extension="true"
            className={cn(
              "pointer-events-none absolute h-px w-1 bg-border/50 [left:anchor(--sidebar-task-list-divider_right,-4px)] [top:anchor(--sidebar-task-list-divider_top,-1px)]",
              isWebRemoteControlShell && "max-md:hidden",
            )}
          />
        ) : null}
        {/* 右侧主工作区：上方 header，下面左侧会话+终端，右侧共享 browser/code-viewer 槽位 */}
        <div
          data-panel=""
          id="content"
          className={cn(
            "flex min-w-[320px] flex-1 flex-col",
            hasDesktopPanelInset ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            isWebRemoteControlShell &&
              "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0",
          )}
        >
          {
            hasDesktopPanelInset && (
              <div className={cn("w-full [app-region:drag]", isWindowsDesktop ? "h-1.5" : "h-1")} />
            ) /* 修复 macOS 顶部窗口控制按钮被 header 遮挡无法点击的问题 */
          }
          <ResizablePanelGroup
            layoutId="workspace-body-layout"
            panelIds={WORKSPACE_BODY_PANEL_IDS}
            className={cn(
              "min-h-0 flex-1",
              isWebRemoteControlShell && "max-md:!flex-col",
              // 完整视图：面板外框以 Group 为定位容器铺满整行，对话内容由宿主 fixed 定位。
              // 修复原因：曾用 CSS 把对话列 flex 压成 0，react-resizable-panels 以各 panel offsetWidth
              // 之和作为 group 尺寸，面板从收起展开时两者皆为 0，resize 得到 NaN，面板一直停在收起态。
              // 这里不改库管理的 flex，已保存的面板占比也不写入。
              isFullView && "relative",
            )}
          >
            <ResizablePanel
              id="conversation-column"
              minSize={isWebRemoteControlShell ? "0px" : "35%"}
              defaultSize={isSidePaneVisible ? "52%" : undefined}
              className={
                isWebRemoteControlShell
                  ? "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0"
                  : undefined
              }
            >
              <SidePaneFullViewConversationHost
                mode={fullViewMode}
                floating={activeFullView?.floating ?? "collapsed"}
                anchor={floatingAnchor}
                slotElement={fullViewSlotElement}
                onFloatingChange={handleFullViewFloatingChange}
                onAnchorChange={handleFloatingAnchorChange}
                onOpenConversation={handleOpenFullViewConversation}
              >
                <ResizablePanelGroup
                  orientation="vertical"
                  layoutId="workspace-conversation-column-layout"
                  panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
                  className="h-full min-h-0"
                >
                  <ResizablePanel
                    id="conversation"
                    elementRef={conversationPanelElementRef}
                    minSize="35%"
                  >
                    <section
                      data-workspace-conversation-frame="true"
                      className={cn(
                        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                        isSidePaneVisible
                          ? "rounded-[var(--workspace-panel-radius)] border border-border"
                          : resolveWorkspaceShellWindowChromeClass({
                              isMacDesktop,
                              isWindowsDesktop,
                              isLinuxDesktop,
                              macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                              isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                              supportsNativeRoundedCorners:
                                desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                            }),
                        isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                        "border-[0.5px]",
                        !isFullView && "shadow-xs",
                        isWebRemoteControlShell &&
                          "max-md:rounded-none max-md:border-x-0 max-md:border-b-0",
                        // 完整视图由面板外框或浮窗外框承担边框与圆角，对话 frame 不再叠一层。
                        isFullView && "rounded-none border-0",
                      )}
                    >
                      {shouldRenderWorkspaceHeader && !isFullView ? (
                        <ScopedErrorBoundary
                          scope="workspace-header"
                          resetKeys={workspaceOnlyResetKeys}
                          variant="compact"
                          className="border-b"
                        >
                          <WorkspaceHeader
                            reserveWindowControls={!isSidePaneVisible}
                            variant={activeTaskId === null ? "draft" : "task"}
                            draftDropTargetController={
                              activeTaskId === null ? draftHeaderDropTargetController : undefined
                            }
                            readOnlyReason={workspaceReadOnlyReason}
                            workspaceAbsPath={workspaceAbsPath}
                            remoteSessionId={workspaceRemoteSessionId}
                            workspaceIdentity={workspaceIdentity}
                            remoteTarget={workspaceRemoteTarget}
                            localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                            projectName={projectName}
                            activeTaskTitle={activeTaskTitle}
                            activeTaskChangeSummary={activeTaskChangeSummary}
                            hasUpdateReady={hasUpdateStatusButton}
                            activeTaskId={activeTaskId}
                            user={user}
                            activeTraceId={activeTraceId}
                            activeSessionId={activeSessionId}
                            activeTaskProvider={activeTaskProvider}
                            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                            sessionLogPath={taskSessionFile.path}
                            nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                            nativeSessionLogPath={taskNativeSessionLogFile.path}
                            nativeSessionLogExists={taskNativeSessionLogFile.exists}
                            nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                            providerWorkspaceConfigPath={providerConfigFile.path}
                            providerWorkspaceConfigExists={providerConfigFile.exists}
                            providerWorkspaceConfigLoading={providerConfigFile.loading}
                            workspaceHeaderState={workspaceShellZCodeState}
                            gitSummary={gitState.summary}
                            gitDirtyFileCount={gitDirtyFileCount}
                            isMacDesktop={isMacDesktop}
                            isMacFullscreen={isMacFullscreen}
                            isWindowsDesktop={isWindowsDesktop}
                            isWebRemoteControl={isWebRemoteControlShell}
                            windowsWindowControlsRightPaddingPx={
                              windowsWindowControlsRightPaddingPx
                            }
                            isDesktop={isDesktop}
                            simplifyForNarrowRemote={simplifyHeaderForNarrowRemote}
                            isSidebarVisible={isSidebarVisible}
                            isTerminalOpen={isTerminalOpen}
                            isSidePaneOpen={isSidePaneOpen}
                            onRefreshGit={handleRefreshGit}
                            onToggleTerminal={handleToggleTerminal}
                            onToggleBrowser={handleToggleBrowser}
                            onToggleSidePane={handleToggleSidePane}
                            toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                            onReloadSession={handleReloadSession}
                            reloadSessionDisabled={workspaceSessionActionDisabled}
                            reloadSessionPending={reloadSessionPending}
                            onCreateTask={handleCreateTaskInChat}
                            onOpenWorkspace={onOpenWorkspace}
                            allowOpenWorkspace={allowOpenWorkspace}
                          />
                        </ScopedErrorBoundary>
                      ) : null}
                      {isWebRemoteControlShell ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-md"
                          data-web-remote-navigation-resize-handle="true"
                          className={cn(
                            "absolute left-1/2 z-30 hidden -translate-x-1/2 -translate-y-1/2 touch-none cursor-ns-resize border-border bg-surface text-foreground-subtle shadow-sm hover:bg-surface-hover hover:text-foreground max-md:inline-flex [app-region:no-drag]",
                            shouldRenderWorkspaceHeader ? "top-12" : "top-0",
                            isWebRemoteControlNavigationDragging &&
                              "border-border-hover bg-surface-hover text-foreground",
                          )}
                          aria-expanded={!isWebRemoteControlNavigationCollapsed}
                          aria-controls="web-remote-control-navigation-panel"
                          aria-label={intl.formatMessage({
                            id: isWebRemoteControlNavigationCollapsed
                              ? "webRemoteControl.expandNavigation"
                              : "webRemoteControl.collapseNavigation",
                          })}
                          onPointerDown={handleWebRemoteNavigationResizeStart}
                          onPointerMove={handleWebRemoteNavigationResizeMove}
                          onPointerUp={(event) => {
                            finishWebRemoteNavigationResize(event);
                          }}
                          onPointerCancel={(event) => {
                            finishWebRemoteNavigationResize(event, true);
                          }}
                          onClick={handleWebRemoteNavigationHandleClick}
                        >
                          <GripHorizontal className="size-4" />
                        </Button>
                      ) : null}
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {workspaceMainView === "automations" && !isWebRemoteControlShell ? (
                          <main
                            id={AUTOMATIONS_TOAST_ANCHOR_ID}
                            className="flex h-full min-h-0 flex-1 flex-col bg-background"
                          >
                            <AutomationsMainBreadcrumbFrame
                              isDesktop={Boolean(isDesktop)}
                              sectionLabel={intl.formatMessage({
                                id: "settings.automations.title",
                              })}
                              ariaLabel={intl.formatMessage({
                                id: "automations.breadcrumbLabel",
                              })}
                            >
                              <div
                                // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                                // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                                className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                              >
                                <ScopedErrorBoundary
                                  scope="automations-main"
                                  resetKeys={workspaceOnlyResetKeys}
                                  variant="panel"
                                  className="min-h-full"
                                >
                                  <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                                    <AutomationsSection
                                      workspacePath={workspaceAbsPath}
                                      workspaceIdentity={workspaceIdentity}
                                      onCreateViaChat={handleCreateAutomationInChat}
                                      onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                                      onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                                      onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                                      openAutomationId={openAutomationId}
                                      openAutomationTab={openAutomationTab}
                                      onOpenAutomationConsumed={onOpenAutomationConsumed}
                                      openWorkflow={openWorkflow}
                                      onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                                      onOpenSession={({
                                        sessionId,
                                        workspacePath,
                                        workspaceIdentity,
                                      }) =>
                                        handleSelectTaskInChat(
                                          workspacePath,
                                          sessionId,
                                          workspaceIdentity,
                                        )
                                      }
                                    />
                                  </div>
                                </ScopedErrorBoundary>
                              </div>
                            </AutomationsMainBreadcrumbFrame>
                          </main>
                        ) : workspaceMainView === "plugin-store" && !isWebRemoteControlShell ? (
                          <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                            <AutomationsMainBreadcrumbFrame
                              isDesktop={Boolean(isDesktop)}
                              sectionLabel={intl.formatMessage({
                                id: "workspace.openPluginsSettings",
                              })}
                              ariaLabel={intl.formatMessage({
                                id: "settings.breadcrumbLabel",
                              })}
                            >
                              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                                <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                                  <PluginStorePage
                                    isDesktop={isDesktop}
                                    isMacDesktop={isMacDesktop}
                                    isWindowsDesktop={isWindowsDesktop}
                                    isWebRemoteControl={isWebRemoteControlShell}
                                    key={`plugin-store:${pluginStoreOpenVersion}`}
                                    workspacePath={workspaceAbsPath}
                                    workspaceIdentity={workspaceIdentity}
                                    onCreateTask={handleCreateTaskInChat}
                                    onOpenDraftUi={handleOpenDraftPluginUi}
                                    sessionId={activeTaskId}
                                    remoteSessionId={workspaceRemoteSessionId}
                                  />
                                </div>
                              </div>
                            </AutomationsMainBreadcrumbFrame>
                          </main>
                        ) : (
                          <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                            {renderChatFindDialog()}
                            <ScopedErrorBoundary
                              scope="workspace-chat"
                              resetKeys={workspaceDraftResetKeys}
                              variant="panel"
                              className="h-full"
                            >
                              {/* Bugfix(2026-07-05, M3 验收)：pane 绑定必须用原始选择态 activeTaskId，
                                  不能用 meta 派生的 activeSessionId——v4 createSession 刚建的会话
                                  不在 taskListCache/optimistic 缓存里，meta 解析为 null 会让 pane
                                  永远停在 draft。v4 语义下 sessionId ≡ taskId，meta 只服务 Header 显示。
                                  M5⑤：桌面主区升级为分屏宿主（Layout/Focus 两层）；primary pane
                                  绑定语义与 testid 契约（paneId=workspace-main）不变。 */}
                              {handoffCreation ? (
                                <div className="absolute inset-0 z-10 flex flex-col bg-background">
                                  <ManagedWorktreeCreationView creation={handoffCreation} />
                                </div>
                              ) : null}
                              {viewedCreation ? (
                                <ManagedWorktreeCreationView creation={viewedCreation} />
                              ) : (
                                <V4WorkspaceChatArea
                                  allowEscapeStopOutsidePane={
                                    isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible
                                  }
                                  readOnly={Boolean(workspaceReadOnlyReason)}
                                  readOnlyReason={workspaceReadOnlyReason}
                                  foregroundEnabled={isWorkspaceVisible}
                                  workspacePath={workspaceAbsPath}
                                  workspaceIdentity={workspaceIdentity}
                                  isDesktop={isDesktop === true}
                                  remoteSessionId={workspaceRemoteSessionId}
                                  compactForRemoteControl={isWebRemoteControlShell}
                                  sessionId={activeTaskId}
                                  activeSelectionSideChatSessionId={
                                    activeSelectionSideChatSessionId
                                  }
                                  provider={activeTaskProvider ?? undefined}
                                  onSessionCreated={handleV4SessionCreated}
                                  onSessionDeleted={handleV4SessionDeleted}
                                  draftComposerHeader={draftComposerHeader}
                                  onPrimaryDraftDropTargetControllerChange={
                                    registerDraftHeaderDropTarget
                                  }
                                  gitSummary={gitState.summary}
                                  gitDirtyFileCount={gitDirtyFileCount}
                                  activeTaskChangeSummary={activeTaskChangeSummary}
                                  gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                                  gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                                  summaryPanelVariantOverride={summaryPanelVariantOverride}
                                  onSummaryPanelVariantOverrideChange={
                                    onSummaryPanelVariantOverrideChange
                                  }
                                  onRefreshGit={handleRefreshGit}
                                  onOpenGitReview={handleOpenGitReview}
                                  onPaneActiveSessionChange={handlePaneActiveSessionChange}
                                  onOpenBrowserUrl={handleOpenBrowserUrl}
                                  onOpenAutomationsMain={handleOpenAutomations}
                                  onOpenCodeViewer={handleOpenCodeViewer}
                                  onAutoOpenAssistantPptx={
                                    isDesktop && !isWebRemoteControlShell
                                      ? handleAutoOpenAssistantPptx
                                      : undefined
                                  }
                                  onOpenBackgroundBash={handleOpenBackgroundBash}
                                  onOpenSubagentSession={handleOpenSubagentSession}
                                  onOpenSubagentDirectory={handleOpenSubagentDirectory}
                                  onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                                  onOpenSelectionSideChat={handleOpenSelectionSideChat}
                                  onOpenPlanDetail={handleOpenPlanDetail}
                                  onOpenWorkflowRun={handleOpenWorkflowRun}
                                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                                  onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                                  onOpenFileLink={handleOpenMarkdownFileLink}
                                  conversationFindQuery={conversationFindQuery}
                                  conversationFindActiveIndex={conversationFindActiveIndex}
                                  conversationFindNavigationRequestId={
                                    conversationFindNavigationRequestId
                                  }
                                  onConversationFindMatchStateChange={
                                    onConversationFindMatchStateChange
                                  }
                                  searchResultHighlightRequest={activeSearchResultHighlightRequest}
                                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                                />
                              )}
                            </ScopedErrorBoundary>
                          </main>
                        )}
                      </div>
                    </section>
                  </ResizablePanel>
                  {isWebRemoteControlShell ||
                  (workspaceMainView !== "automations" && workspaceMainView !== "plugin-store") ? (
                    <AnimatedTerminalPanel
                      frameClassName={cn(
                        isSidePaneVisible
                          ? "rounded-[var(--workspace-panel-radius)] border border-border"
                          : resolveWorkspaceShellWindowChromeClass({
                              isMacDesktop,
                              isWindowsDesktop,
                              isLinuxDesktop,
                              macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                              isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                              supportsNativeRoundedCorners:
                                desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                            }),
                        "rounded-t-[var(--workspace-panel-radius)] border-t",
                      )}
                      services={services}
                      workspaceAbsPath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      openWorkspaceKeys={openWorkspaceKeys}
                      isVisible={isTerminalVisible}
                      isWindowsDesktop={isWindowsDesktop}
                      panelRef={terminalPanelRef}
                      panelElementRef={terminalPanelElementRef}
                      onClose={() => setIsTerminalOpen(false)}
                      onOpenBrowserUrl={handleOpenBrowserUrl}
                    />
                  ) : null}
                </ResizablePanelGroup>
              </SidePaneFullViewConversationHost>
            </ResizablePanel>
            {/* Bugfix：Browser Guest Host 必须与主视图路由解耦，避免 automations/plugin
                    切换时卸载 Guest；截图请求期间由上层临时展开真实面板承载可合成的 WebContents。 */}
            {sidePanePanel}
          </ResizablePanelGroup>
        </div>
        <ScopedErrorBoundary
          scope="desktop-top-overlay"
          resetKeys={workspaceSidebarVisibilityResetKeys}
          variant="silent"
        >
          <DesktopTopOverlay
            newTaskDisabledReason={workspaceReadOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            isWindowsDesktop={isWindowsDesktop}
            isDesktop={isDesktop}
            isSidebarVisible={isSidebarVisible}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
            newTaskShortcutLabel={newTaskShortcutLabel}
            goBackShortcutLabel={goBackShortcutLabel}
            goForwardShortcutLabel={goForwardShortcutLabel}
            canTaskNavBack={canPrimaryNavigationBack}
            canTaskNavForward={canTaskNavForward}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            showNewTaskButton={showTopOverlayNewTaskButton}
            appLogoUrl={appLogoUrl}
            platform={platform}
            onToggleSidebar={handleToggleSidebar}
            onCreateTask={handleCreateTaskInChat}
            onGoBack={primaryNavigationBack}
            onGoForward={handleTaskNavForward}
            hideTaskNavigationButtons={simplifyHeaderForNarrowRemote}
          />
        </ScopedErrorBoundary>

        {isWebRemoteControlShell && isWebRemoteControlTaskSwitching ? (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
              <LoaderCircle className="size-4 animate-spin" />
              {/* Bugfix: 跨 workspace 点击任务时旧页会很快卸载，之前在卸载前缺少统一占位，视觉上像“先白屏再渲染”。
                  这里补一个全局 loading overlay，给切换过程稳定反馈。 */}
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          </div>
        ) : null}
      </div>
    </SavedWorkflowHubProvider>
  );
  return (
    <DesktopWindowFrame
      title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
      showHeader
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      headerTestId={TID_APP_HEADER}
    >
      {isWebRemoteControlShell ? renderRemoteShell(wideContent) : wideContent}
    </DesktopWindowFrame>
  );
});

/* eslint-disable max-lines -- Side pane 当前集中承载 tabs、browser/git/code-viewer 内容；完整拆分需按 pane 功能边界继续推进。 */
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { ServiceProvider, useComposerClientNamespace } from "@/hooks/useServices.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import {
  isRemoteWorkspaceIdentity,
  type BrowserViewScreenshotSurfacePreparePayload,
  type GitChangeSourceId,
} from "@zcode/shared";
import { FileManagerPane } from "@/WorkspaceFileTree.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { composerScopeKey, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import { SidePaneTerminalPane } from "@/SidePaneTerminalPane.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import {
  SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE,
  SidePaneFullViewConversationTab,
  SidePaneFullViewToggleButton,
  type SidePaneFullViewSurface,
} from "@/side-pane-full-view/index.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { BrowserUseSidePaneContent } from "@/browser-use/BrowserUseSidePaneContent.js";
import { BrowserSitePermissionsPage } from "@/browser-use/BrowserSitePermissionsPage.js";
import { findScreenshotSurfaceTabForRender } from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { HumanBrowserView } from "@/browser-use/HumanBrowserView.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { GitPane } from "@/GitPane.js";
import { TreemappingPane } from "@/TreemappingPane.js";
import { WhiteboardPane } from "@/WhiteboardPane.js";
import { ModelTrajectoryPane } from "@/ModelTrajectoryPane.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { DeveloperToolsPane } from "@/DeveloperToolsPane.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

import {
  ResizableHandle,
  ResizablePanel,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { SidePaneTabOverview } from "@/app-shell/SidePaneTabOverview.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";
import { BackgroundBashOutputSidePane } from "@/app-shell/BackgroundBashOutputSidePane.js";
import { PlanDetailSidePane } from "@/app-shell/PlanDetailSidePane.js";
import {
  usePluginUiPaneTarget,
  PluginUiLauncherItems,
  PluginUiSidePane,
  SidePaneLauncherRow,
  useMarketPluginUi,
  useOpenPluginUi,
} from "@/plugin-ui/index.js";
import {
  ExtensionLauncherSection,
  ExtensionLogsPane,
  ExtensionViewPane,
} from "@/extension-slots/index.js";
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
import { WorkflowRunDirectorySidePane } from "@/app-shell/WorkflowRunDirectorySidePane.js";
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
import { WorkflowWorkspaceSidePane } from "@/app-shell/WorkflowWorkspaceSidePane.js";
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
import {
  getSidePaneTabTitle,
  SidePaneTabDragOverlay,
  SortableSidePaneTabTrigger,
} from "@/app-shell/SidePaneTabTrigger.js";
import { resolveSidePaneTabsOverflow } from "@/app-shell/sidePaneLayout.js";
import {
  resolveAnimatedSidePanePanelLayout,
  resolveOpenTabLauncherItemIds,
  SITES_PLUGIN_ID,
  shouldOfferSelectionSideConversation,
  shouldRenderPreviewPaneHeavyContent,
  type OpenTabLauncherItemId,
} from "@/app-shell/animatedSidePanePanelModel.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import { useDeveloperToolsVisibility } from "@/hooks/useDeveloperToolsVisibility.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import { logger } from "@/logger.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  shouldMountSidePaneContent,
  shouldMountBrowserTabGuest,
  type BrowserSidePaneTab,
  type BrowserUseSidePaneTab,
  type BrowserSidePaneMetadata,
  type OpenScopedSubagentSideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import { inferMediaPreview, type CodeViewerSource } from "@/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { getVisibleSidePaneTabs } from "@/lib/workspaceSidePane.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BugIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderOpenIcon,
  EarthIcon,
  GlobeIcon,
  MessageSquareTextIcon,
  PlusIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";

const PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS = 220;
type TabsScrollMaskEdges = {
  left: boolean;
  right: boolean;
};
type OpenTabLauncherItem = {
  id: OpenTabLauncherItemId;
  label: string;
  description: string;
  icon: LucideIcon;
  onOpen: () => void;
};
const EMPTY_SIDE_PANE_TABS: WorkspaceSidePaneState["tabs"] = [];
const EMPTY_TABS_SCROLL_MASK_EDGES: TabsScrollMaskEdges = {
  left: false,
  right: false,
};

function SuspendedBrowserSidePaneContent({
  tab,
}: {
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab;
}) {
  const platform = usePlatform();
  const tabId = tab.type === "browser-use" ? tab.tabId : tab.id;
  const generation = tab.residencyGeneration ?? 0;

  useEffect(() => {
    if (tab.residency !== "suspended") return;
    // React effect 在旧 UnifiedBrowserView 提交 unmount 后运行；此时回 ack，main 才能安全
    // 关闭对应 guest WebContents，避免 suspend 被 render-process-gone 当成 crash 立即重建。
    // info 级打点：挂起换壳会先卸载 <webview>，若卸载瞬间
    // CDP 仍 attached 即打开主进程 UAF 窗口；这条日志把换壳时刻与 UnifiedBrowserView 的
    // 卸载打点对齐，用于归因 guest destroyed 的销毁者。
    logger.info("[browser-use] tab 换挂起壳，suspend ready ack", { generation, tabId });
    void platform.browserViewSuspendReady?.({ tabId, generation }).catch((error) => {
      logger.debug("[browser-use] suspend ready ack 失败", {
        error: error instanceof Error ? error.message : String(error),
        generation,
        tabId,
      });
    });
  }, [generation, platform, tab.residency, tabId]);

  return (
    <TabsContent
      value={tab.id}
      forceMount
      data-browser-tab-residency="suspended"
      className="relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden"
    />
  );
}

function readViewportInlineIntersectionSize(element: HTMLElement | null) {
  if (!element || typeof window === "undefined") {
    return null;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  if (viewportWidth <= 0) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(viewportWidth, rect.right);
  return Math.max(0, Math.round(visibleRight - visibleLeft));
}

function useViewportInlineIntersectionSize<TElement extends HTMLElement>(
  elementRef: RefObject<TElement | null>,
  enabled: boolean,
) {
  const [visibleInlineSizePx, setVisibleInlineSizePx] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setVisibleInlineSizePx(null);
      return;
    }

    const element = elementRef.current;
    if (!element) {
      setVisibleInlineSizePx(null);
      return;
    }

    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const next = readViewportInlineIntersectionSize(element);
      setVisibleInlineSizePx((current) => (current === next ? current : next));
    };
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }

      frameId = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    window.addEventListener("scroll", scheduleUpdate, {
      capture: true,
      passive: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, { capture: true });
      resizeObserver?.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [elementRef, enabled]);

  return visibleInlineSizePx;
}

function useWindowResizeSettling(enabled: boolean) {
  const [isResizeSettling, setIsResizeSettling] = useState(false);
  const resizeSettleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setIsResizeSettling(false);
      return;
    }

    const finishSettling = () => {
      resizeSettleTimerRef.current = null;
      setIsResizeSettling(false);
    };

    const markSettling = () => {
      // 窗口 resize 期间，大文件 PreviewPane 的千行 Shadow DOM 会在每帧参与
      // React commit + Layout。这里只把 resize 视为短暂的不稳定阶段，等尺寸停止抖动后再恢复重内容。
      setIsResizeSettling((current) => (current ? current : true));
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
      }
      resizeSettleTimerRef.current = window.setTimeout(
        finishSettling,
        PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS,
      );
    };

    window.addEventListener("resize", markSettling, { passive: true });
    window.visualViewport?.addEventListener("resize", markSettling, {
      passive: true,
    });

    return () => {
      window.removeEventListener("resize", markSettling);
      window.visualViewport?.removeEventListener("resize", markSettling);
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
        resizeSettleTimerRef.current = null;
      }
    };
  }, [enabled]);

  return isResizeSettling;
}

export function AnimatedSidePanePanel({
  services,
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isVisible,
  sidePaneState,
  recentClosedSidePaneTabs,
  isBrowserOpen,
  supportsEmbeddedBrowser = true,
  workspaceAbsPath,
  taskCwd,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  sidePaneOwnerId,
  gitState,
  activeGitSourceId,
  panelRef,
  panelElementRef,
  browserNavigationRequest,
  browserRestoreUrls,
  screenshotSurfaceRequest: screenshotSurfaceRequestProp = null,
  screenshotSurfaceTabId = null,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onCloseGit,
  onActivateTab,
  onOpenNewTab,
  onReorderTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReopenClosedTab,
  onOpenBrowserTab,
  onOpenBrowserPermissionSettings,
  onOpenWhiteboard: _onOpenWhiteboard,
  onOpenDeveloperTools,
  onOpenFileManager,
  onNavigateFileManager,
  onOpenPluginMarket,
  onCreateTask,
  onOpenTerminalTab,
  onOpenReviewTab,
  onOpenSelectionSideConversation,
  onRevealGitFileInTree,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenBackgroundBash,
  onRefreshGit,
  onBrowserNavigationRequestHandled,
  onBrowserUrlChange,
  onBrowserPageMetadataChange,
  onSelectGitSource,
  frameClassName = "rounded-xl border border-border",
  captionControlsStyle,
  showWindowControls,
  onCloseSidePane,
  toggleSidePaneShortcutLabel,
  fullViewToggle,
  fullView = null,
  fullViewSlotRef,
  mobileOverlay = false,
  mobileStacked = false,
}: {
  services: IServiceAccessor;
  frameClassName?: string;
  captionControlsStyle?: CSSProperties;
  showWindowControls?: boolean;
  onCloseSidePane?: () => void;
  toggleSidePaneShortcutLabel?: string;
  /** 桌面端「进入 / 退出完整视图」按钮；缺省不渲染（Web、手机远控）。 */
  fullViewToggle?: { active: boolean; onToggle: () => void; shortcutLabel?: string };
  /** 完整视图生效时的 tab 栏状态（spec：docs/ui/side-pane-full-view.md）。 */
  fullView?: {
    surface: SidePaneFullViewSurface;
    conversationTitle: string;
    /** 侧栏收起时为左上角浮层按钮组留出的左侧留白（与 WorkspaceHeader 同一规则）。 */
    leadingInsetClassName?: string | false;
    onSelectSurface: (surface: SidePaneFullViewSurface) => void;
  } | null;
  /** 面板内容区（tab 栏下方），完整视图的对话宿主按它定位。 */
  fullViewSlotRef?: (element: HTMLDivElement | null) => void;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isVisible: boolean;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser?: boolean;
  workspaceAbsPath: string;
  /** 当前任务的 cwd；worktree 任务不是 workspace 目录（docs/git/worktree.md §3.7）。 */
  taskCwd?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  activeGitSourceId: GitChangeSourceId;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  screenshotSurfaceTabId?: string | null;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onCloseCodeViewer: () => void;
  onCloseGit: () => void;
  onActivateTab: (tabId: string) => void;
  onOpenNewTab: () => void;
  /** "插件"分组打开面板 tab；缺省不渲染分组（web / 无宿主）。 */
  onReorderTab: (activeTabId: string, overTabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  onReopenClosedTab: (tabId: string) => void;
  onOpenBrowserTab: () => void;
  onOpenBrowserPermissionSettings?: (origin: string) => void;
  onOpenWhiteboard: () => void;
  onOpenDeveloperTools: () => void;
  onOpenFileManager: (target?: FileManagerTarget) => void;
  onNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  onOpenPluginMarket?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenTerminalTab: () => void;
  onOpenReviewTab: () => void;
  onOpenSelectionSideConversation: () => void;
  onRevealGitFileInTree?: (path: string) => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /** run 详情页里点 ask 节点 → 打开那个 actor 实例的 transcript tab。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** run 详情页里点脚本行 → 打开该 run 的脚本 transcript tab，落到那一站。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  /** run 详情页里点一张产物卡 → 打开那个产物的全尺寸查看 tab。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** run 目录页里点一行 → 打开那个 run 的详情页 tab（目录 → 详情是这一页存在的理由）。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onRefreshGit: () => void;
  onBrowserNavigationRequestHandled: (requestId: string) => void;
  onBrowserUrlChange: (tabId: string, url: string) => void;
  onBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  onSelectGitSource: (value: GitChangeSourceId) => void;
  mobileOverlay?: boolean;
  mobileStacked?: boolean;
}) {
  const onOpenPluginUi = useOpenPluginUi();
  const pluginUiTarget = usePluginUiPaneTarget({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRemoteSessionId ?? undefined,
    sessionId: activeTaskId,
  });
  const pluginUiWorkspaceKey =
    pluginUiTarget.workspaceIdentity?.trim() || pluginUiTarget.workspacePath;
  const { intl, locale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const developerToolsEnabled = useDeveloperToolsVisibility();
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const isDragCollapsible = !isVisible;
  const isResizeDisabled = !isVisible;
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const composerClientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const draftScopeKey = composerScopeKey(
    resolveComposerScope(draftProjectId, workspaceIdentity, composerClientNamespace),
  );
  const tabs = sidePaneState?.tabs ?? EMPTY_SIDE_PANE_TABS;
  const screenshotSurfaceRequest = screenshotSurfaceRequestProp;
  const isScreenshotSurfaceActive = Boolean(screenshotSurfaceRequest);
  const screenshotSurfaceTab = screenshotSurfaceTabId
    ? tabs.find((tab) => tab.id === screenshotSurfaceTabId)
    : screenshotSurfaceRequest
      ? findScreenshotSurfaceTabForRender(tabs, screenshotSurfaceRequest)
      : undefined;
  const visibleTabs = useMemo(
    () =>
      getVisibleSidePaneTabs(tabs, {
        workspaceKey,
        ownerTaskId: sidePaneOwnerId,
        pluginUiSessionId: pluginUiTarget.sessionId,
        pluginUiWorkspaceKey,
      }),
    [sidePaneOwnerId, tabs, workspaceKey, pluginUiTarget.sessionId, pluginUiWorkspaceKey],
  );
  // 「当前对话」与标签栏可见性共用 scope 判定；后台对话的 guest 据此由 main 静音。
  const currentTaskTabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs]);
  const activeTabId = sidePaneState?.activeTabId ?? "";
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (visibleTabs.at(-1)?.id ?? "");
  // 完整视图切到对话 tab 时，面板内容全部视为未选中：对话宿主覆盖内容区，webview / 终端不再自认可见。
  const contentActiveTabId = fullView?.surface === "conversation" ? "" : visibleActiveTabId;
  // 面板 tab trigger 在 pointerdown 上阻止了默认行为，Radix 收不到 mousedown，不会走 onValueChange；
  // 所有激活面板 tab 的入口都必须经过这里，才能把完整视图切回面板 surface。
  const activateSidePaneTab = (tabId: string) => {
    fullView?.onSelectSurface("side-pane");
    onActivateTab(tabId);
  };
  const [marketReturnTarget, setMarketReturnTarget] = useState<{
    workspaceKey: string;
    ownerId: string | null;
    tabId: string;
  } | null>(null);
  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.type === "plugin-market")) {
      setMarketReturnTarget(null);
    }
  }, [visibleTabs]);
  const hasVisibleTabs = visibleTabs.length > 0;
  const tabsScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tabsScrollContentRef = useRef<HTMLDivElement | null>(null);
  const shouldMountContent = shouldMountSidePaneContent(isVisible, tabs);
  const [hasRenderedSidePane, setHasRenderedSidePane] = useState(shouldMountContent);
  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false);
  const [tabsScrollMaskEdges, setTabsScrollMaskEdges] = useState<TabsScrollMaskEdges>({
    left: false,
    right: false,
  });
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const sidePaneVisibleInlineSizePx = useViewportInlineIntersectionSize(
    panelElementRef,
    hasRenderedSidePane,
  );
  const isWindowResizeSettling = useWindowResizeSettling(hasRenderedSidePane);
  const panelLayout = resolveAnimatedSidePanePanelLayout({ mobileOverlay });
  const hasReviewTab = visibleTabs.some((tab) => tab.type === "git");
  const canOpenSelectionSideConversation = shouldOfferSelectionSideConversation({
    activeTaskId,
    isMobileTextInputViewport,
    mobileOverlay,
  });
  // Sites 面板是会话级 UI 插件，和辅助对话同样需要正式会话；远端工作区不支持插件面板。
  const canOpenSites =
    canOpenSelectionSideConversation &&
    !workspaceRemoteSessionId &&
    !isRemoteWorkspaceIdentity(workspaceIdentity ?? "");
  const sitesPluginUi = useMarketPluginUi({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRemoteSessionId ?? null,
    sessionId: activeTaskId,
  });
  const tabDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );

  const handleTabDragStart = (event: DragStartEvent) => {
    setDraggingTabId(String(event.active.id));
  };

  const handleTabDragEnd = (event: DragEndEvent) => {
    setDraggingTabId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorderTab(String(active.id), String(over.id));
  };

  const handleTabDragCancel = () => {
    setDraggingTabId(null);
  };

  useEffect(() => {
    if (shouldMountContent) {
      // 收起时不能卸载 Tabs/Git/Browser，否则再次打开会丢失内容状态并重复初始化。
      // 尺寸过渡期间也保留实例，避免内容先消失、恢复后重复初始化。
      setHasRenderedSidePane(true);
    }
  }, [shouldMountContent]);

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!viewport || !content) {
      setIsTabsOverflowing(false);
      // sidePaneState 为空或内容尚未挂载时 refs 会持续为空。
      // 这里不能每次写入新的 mask 对象，否则 effect 会在空 tabs 阶段反复触发更新。
      setTabsScrollMaskEdges((current) =>
        current.left || current.right ? EMPTY_TABS_SCROLL_MASK_EDGES : current,
      );
      return;
    }

    const updateOverflowState = () => {
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const addButton = viewport.parentElement?.querySelector<HTMLElement>(
        "[data-side-pane-add-tab-trigger]",
      );
      const addButtonWidth = addButton?.getBoundingClientRect().width ?? 0;
      // 旧判定直接读取 content.scrollWidth，但 overflow 状态本身会把新增按钮
      // 移进/移出 content 并改变 viewport 宽度，临界区会形成 ResizeObserver 反馈环。
      // 这里统一还原“新增按钮位于 tabs 末尾”的假想布局，只用稳定的最小宽度预算判定。
      const isOverflowing = resolveSidePaneTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: visibleTabs.length,
        viewportWidth: viewport.clientWidth,
      });
      // 新增按钮在 tabs 尚可等宽收缩时跟随末尾，只有达到 60px 下限仍溢出后才固定到右侧。
      setIsTabsOverflowing(isOverflowing);
      // tabs 溢出时不能两侧一直显示渐变 mask：滚动到起点/终点也像还能继续滚。
      // 这里把 mask 和实际 scrollLeft 绑定，只提示仍可继续滚动的一侧。
      setTabsScrollMaskEdges((current) => {
        const next = {
          left: isOverflowing && viewport.scrollLeft > 1,
          right: isOverflowing && viewport.scrollLeft < maxScrollLeft - 1,
        };

        if (current.left === next.left && current.right === next.right) {
          return current;
        }

        return next;
      });
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateOverflowState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateOverflowState();
    viewport.addEventListener("scroll", updateOverflowState, {
      passive: true,
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateOverflowState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateOverflowState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateOverflowState);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visibleTabs]);

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!visibleActiveTabId || !viewport || !content) {
      return;
    }

    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null;
      const activeTab = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).find((element) => element.dataset.sidePaneTabId === visibleActiveTabId);

      if (!activeTab) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeTabRect = activeTab.getBoundingClientRect();
      const leftOverflow = activeTabRect.left - viewportRect.left;
      const rightOverflow = activeTabRect.right - viewportRect.right;

      if (leftOverflow < 0) {
        // 从外部激活 tab（例如打开文件或切回旧 Browser）时，
        // active tab 可能已经被横向滚动区域遮住。这里按真实 DOM 宽度滚回可视区，
        // 避免使用固定宽度估算导致长标题 / favicon tab 对不齐。
        viewport.scrollBy({ left: leftOverflow, behavior: "smooth" });
        return;
      }

      if (rightOverflow > 0) {
        viewport.scrollBy({ left: rightOverflow, behavior: "smooth" });
      }
    });

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [visibleActiveTabId, visibleTabs]);

  const addTabButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className="shrink-0"
      data-side-pane-add-trigger
      data-side-pane-add-tab-trigger=""
      aria-label={intl.formatMessage({ id: "sidePane.addTab" })}
      onClick={() => {
        fullView?.onSelectSurface("side-pane");
        onOpenNewTab();
      }}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
  const openTabLauncherItemById: Record<OpenTabLauncherItemId, OpenTabLauncherItem> = {
    sites: {
      id: "sites",
      label: intl.formatMessage({ id: "sidePane.sites" }),
      description: intl.formatMessage({ id: "sidePane.launcher.sites" }),
      icon: EarthIcon,
      onOpen: () => void sitesPluginUi.open(SITES_PLUGIN_ID),
    },
    "selection-side-conversation": {
      id: "selection-side-conversation",
      label: intl.formatMessage({ id: "sidePane.selectionChat" }),
      description: intl.formatMessage({ id: "sidePane.launcher.selection-side-conversation" }),
      icon: MessageSquareTextIcon,
      onOpen: onOpenSelectionSideConversation,
    },
    files: {
      id: "files",
      label: intl.formatMessage({ id: "fileManager.title" }),
      description: intl.formatMessage({ id: "fileManager.empty" }),
      icon: FolderOpenIcon,
      onOpen: () => onOpenFileManager(),
    },
    review: {
      id: "review",
      label: intl.formatMessage({ id: "sidePane.review" }),
      description: intl.formatMessage({ id: "sidePane.launcher.review" }),
      icon: FileDiffIcon,
      onOpen: onOpenReviewTab,
    },
    terminal: {
      id: "terminal",
      label: intl.formatMessage({ id: "terminal.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.terminal" }),
      icon: SquareTerminalIcon,
      onOpen: onOpenTerminalTab,
    },
    browser: {
      id: "browser",
      label: intl.formatMessage({ id: "browser.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.browser" }),
      icon: GlobeIcon,
      onOpen: onOpenBrowserTab,
    },
    "developer-tools": {
      id: "developer-tools",
      label: intl.formatMessage({ id: "developerTools.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.developer-tools" }),
      icon: BugIcon,
      onOpen: onOpenDeveloperTools,
    },
  };
  const openTabLauncherItems: OpenTabLauncherItem[] = resolveOpenTabLauncherItemIds({
    canOpenSelectionSideConversation,
    canOpenSites,
    developerToolsEnabled,
    hasReviewTab,
    supportsEmbeddedBrowser,
  })
    .filter((itemId) => !isOfficeMode || (itemId !== "terminal" && itemId !== "review"))
    .map((itemId) => openTabLauncherItemById[itemId]);
  const closeSidePaneButton =
    isVisible && !mobileOverlay && onCloseSidePane ? (
      <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
        {fullViewToggle ? (
          <SidePaneFullViewToggleButton
            active={fullViewToggle.active}
            onToggle={fullViewToggle.onToggle}
            shortcutLabel={fullViewToggle.shortcutLabel}
          />
        ) : null}
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen
          onToggleSidePane={onCloseSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
        />
        {showWindowControls ? <DesktopWindowControls /> : null}
      </div>
    ) : null;
  const openTabLauncher = (
    <div className="side-pane-open-tab-shell @container/launcher flex h-full min-h-0 flex-col bg-background">
      {/* 对齐原型：顶部对齐滚动、左对齐标题；内置应用与 UI 插件同为横向行，短分割线分区。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <h2 className="pl-2 text-ui-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "sidePane.openTab" })}
          </h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
            {openTabLauncherItems.map((item) => (
              <SidePaneLauncherRow
                key={item.id}
                itemId={item.id}
                icon={item.icon}
                label={item.label}
                description={item.description}
                onOpen={item.onOpen}
              />
            ))}
          </div>
          {/* 草稿已有真实预热 session；按正式 task 判断会隐藏整个插件入口。 */}
          {pluginUiTarget.sessionId ? (
            <>
              <div aria-hidden="true" className="my-4 h-px w-24 self-center bg-border" />
              <section className="min-w-0" data-testid="side-pane-ui-recommendations">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <h2 className="pl-2 text-ui-lg font-semibold text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.store.ui.title" })}
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-foreground-subtle"
                    data-testid="side-pane-plugin-market"
                    onClick={() => {
                      if (!onOpenPluginMarket) return;
                      setMarketReturnTarget({
                        workspaceKey,
                        ownerId: sidePaneOwnerId ?? null,
                        tabId: visibleActiveTabId,
                      });
                      onOpenPluginMarket();
                    }}
                  >
                    {intl.formatMessage({ id: "sidePane.launcher.viewAllPlugins" })}
                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
                  {onOpenPluginUi ? (
                    <PluginUiLauncherItems
                      workspacePath={pluginUiTarget.workspacePath}
                      workspaceIdentity={pluginUiTarget.workspaceIdentity}
                      remoteSessionId={pluginUiTarget.remoteSessionId ?? undefined}
                      sessionId={pluginUiTarget.sessionId}
                      paneId={pluginUiTarget.paneId}
                      onOpenPluginUi={onOpenPluginUi}
                    />
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
          {/* 扩展分区不依赖会话（docs/plugins/extension-host.md §6）；没有要显示的行时不渲染。 */}
          <ExtensionLauncherSection
            workspacePath={pluginUiTarget.workspacePath}
            workspaceIdentity={pluginUiTarget.workspaceIdentity}
          />
        </div>
      </div>
    </div>
  );
  const sidePaneTabOverview = (
    <SidePaneTabOverview
      tabs={visibleTabs}
      activeTabId={visibleActiveTabId}
      recentClosedTabs={recentClosedSidePaneTabs}
      labels={{
        title: intl.formatMessage({ id: "sidePane.tabOverview" }),
        searchPlaceholder: intl.formatMessage({
          id: "sidePane.searchTabs",
        }),
        openTabs: intl.formatMessage({ id: "sidePane.openTabs" }),
        recentlyClosedTabs: intl.formatMessage({
          id: "sidePane.recentlyClosedTabs",
        }),
        noResults: intl.formatMessage({ id: "sidePane.noTabsFound" }),
        closeTab: (title) => intl.formatMessage({ id: "sidePane.closeTab" }, { title }),
        relativeTime: (timestamp) => formatTaskRelativeTime(timestamp, intl),
        browserTitle: intl.formatMessage({ id: "browser.title" }),
        reviewTitle: intl.formatMessage({ id: "sidePane.review" }),
        fileManagerTitle: intl.formatMessage({ id: "fileManager.title" }),
        codeViewerTitle: intl.formatMessage({ id: "codeViewer.title" }),
        treemappingTitle: intl.formatMessage({ id: "treemapping.title" }),
        whiteboardTitle: intl.formatMessage({ id: "whiteboard.title" }),
        modelTrajectoryTitle: intl.formatMessage({
          id: "modelTrajectory.title",
        }),
        newTabTitle: intl.formatMessage({ id: "sidePane.newTab" }),
        pluginMarketTitle: intl.formatMessage({ id: "workspace.openPluginsSettings" }),
        developerToolsTitle: intl.formatMessage({
          id: "developerTools.title",
        }),
        extensionLogsTitle: intl.formatMessage({ id: "extensions.logs.title" }),
        browserPermissionsTitle: intl.formatMessage({
          id: "browser.permission.settings",
        }),
        terminalTitle: intl.formatMessage({ id: "terminal.title" }),
        subagentTypeLabel: intl.formatMessage({ id: "sidePane.subagent" }),
        subagentDirectoryTitle: intl.formatMessage({
          id: "sidePane.subagentDirectory",
        }),
        selectionChatTitle: intl.formatMessage({
          id: "sidePane.selectionChat",
        }),
        planTitle: intl.formatMessage({ id: "planTool.panel.planTab" }),
        workflowRunTitle: intl.formatMessage({ id: "sidePane.workflowRun" }),
        workflowDirectoryTitle: intl.formatMessage({ id: "sidePane.workflowDirectory" }),
        workflowActorTitle: intl.formatMessage({ id: "sidePane.workflowActor" }),
        workflowScriptTitle: intl.formatMessage({ id: "sidePane.workflowScript" }),
        workflowArtifactTitle: intl.formatMessage({ id: "sidePane.workflowArtifact" }),
        locale,
      }}
      onActivateTab={activateSidePaneTab}
      onCloseTab={onCloseTab}
      onReopenClosedTab={onReopenClosedTab}
    />
  );
  const draggingTab = draggingTabId
    ? (visibleTabs.find((tab) => tab.id === draggingTabId) ?? null)
    : null;

  const panelContent = (
    <div
      aria-hidden={!isVisible}
      data-workspace-side-frame={mobileOverlay ? undefined : "true"}
      className={cn(
        // 独立外框放在内容层：关闭仍保留 Browser Guest 和 tab 实例，不改变面板持久化边界。
        "h-full overflow-hidden bg-background",
        // 开关动画期间保持内容展开宽度；截图、完整视图和手机布局仍由各自宿主定尺寸。
        !mobileOverlay &&
          !mobileStacked &&
          !fullView &&
          !isScreenshotSurfaceActive &&
          "w-[var(--side-pane-content-width,100%)]",
        !mobileOverlay && frameClassName,
        !mobileOverlay && "border-[0.5px] shadow-xs",
        mobileStacked && "max-md:rounded-none max-md:border-0",
        mobileOverlay && "min-w-0",
        mobileStacked && "max-md:!w-full",
        // 完整视图：相对外层 PanelGroup 铺满整行，库管理的 panel 宽度保持不变。
        // 修复原因：插件 UI 页面挂在 body 末尾的 fixed 停靠层（无 z-index）里，外框曾用 z-10
        // 把不透明背景画在它上面，插件 tab 显示为空白。对话列内容都在 z-30 的宿主里，
        // 外框只需 z-0 建立自己的层叠上下文，按 DOM 顺序排在停靠层之下。
        fullView && "absolute inset-0 z-0",
      )}
    >
      <ScopedErrorBoundary
        scope="workspace-side-pane"
        resetKeys={[workspaceKey, visibleActiveTabId]}
        variant="panel"
        className="h-full"
      >
        {hasRenderedSidePane && (sidePaneState || fullView) ? (
          <>
            {/* 收起或切换对话时保留其他对话的内容挂载，避免丢失辅助对话草稿和引用。
                展开后的空标签集合由 useAppPanels 统一补建「新标签页」。 */}
            <div
              className={cn(
                "h-full min-h-0",
                !hasVisibleTabs && !screenshotSurfaceRequest && !fullView && "hidden",
              )}
            >
              <Tabs
                value={
                  fullView?.surface === "conversation"
                    ? SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE
                    : visibleActiveTabId
                }
                onValueChange={(value) => {
                  if (fullView && value === SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE) {
                    fullView.onSelectSurface("conversation");
                    return;
                  }
                  activateSidePaneTab(value);
                }}
                className="relative h-full gap-0"
              >
                <TabsList
                  style={mobileOverlay ? undefined : captionControlsStyle}
                  className={cn(
                    "flex justify-start w-full rounded-none p-0 border-0 border-b border-border/50 bg-transparent shadow-none !h-12 overflow-hidden",
                    fullView?.leadingInsetClassName,
                    // 独立面板将标签栏移至窗口顶部，需补充窗口拖拽区域；标签和按钮仍处理自身交互。
                    isDesktop &&
                      !mobileOverlay &&
                      "[app-region:drag] [&_button]:[app-region:no-drag] [&_[data-side-pane-tab-id]]:[app-region:no-drag]",
                  )}
                >
                  <div className="flex items-center justify-start flex-1 min-w-0">
                    {/* 与 WorkspaceHeader 的 p-2 对齐，避免切换面板后左右操作区跳动。 */}
                    <div className="flex h-full shrink-0 items-center p-2">
                      {sidePaneTabOverview}
                    </div>
                    {fullView ? (
                      <div className="flex h-full shrink-0 items-center pr-1">
                        <SidePaneFullViewConversationTab
                          title={fullView.conversationTitle}
                          isActive={fullView.surface === "conversation"}
                        />
                      </div>
                    ) : null}
                    <DndContext
                      sensors={tabDragSensors}
                      collisionDetection={closestCenter}
                      onDragStart={handleTabDragStart}
                      onDragEnd={handleTabDragEnd}
                      onDragCancel={handleTabDragCancel}
                    >
                      <div
                        ref={tabsScrollViewportRef}
                        data-side-pane-tabs-viewport=""
                        className={cn(
                          "min-w-0 flex-1 overflow-x-auto !scrollbar-hide h-12 items-center",
                          tabsScrollMaskEdges.left &&
                            tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)]",
                          tabsScrollMaskEdges.left &&
                            !tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)]",
                          !tabsScrollMaskEdges.left &&
                            tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)]",
                        )}
                      >
                        {/* tab strip 固定占满滚动 viewport：每个 tab 先从 156px 等宽收缩到
                            60px，只有最小宽度之和仍超出 viewport 时才产生横向滚动。 */}
                        <div
                          ref={tabsScrollContentRef}
                          data-side-pane-tabs-content=""
                          className="flex w-full gap-1 py-2.5"
                        >
                          <SortableContext
                            items={visibleTabs.map((tab) => tab.id)}
                            strategy={horizontalListSortingStrategy}
                          >
                            {visibleTabs.map((tab) => {
                              const title = getSidePaneTabTitle(tab, intl.formatMessage, locale);
                              return (
                                <SortableSidePaneTabTrigger
                                  key={tab.id}
                                  tab={tab}
                                  title={title}
                                  closeTabLabel={intl.formatMessage(
                                    { id: "sidePane.closeTab" },
                                    { title },
                                  )}
                                  closeTabMenuLabel={intl.formatMessage({
                                    id: "sidePane.closeCurrentTab",
                                  })}
                                  closeOtherTabsLabel={intl.formatMessage({
                                    id: "sidePane.closeOtherTabs",
                                  })}
                                  closeAllTabsLabel={intl.formatMessage({
                                    id: "sidePane.closeAllTabs",
                                  })}
                                  diffBadgeLabel={intl.formatMessage({
                                    id: "diff.title",
                                  })}
                                  isActive={tab.id === contentActiveTabId}
                                  onActivateTab={activateSidePaneTab}
                                  onCloseTab={onCloseTab}
                                  onCloseOtherTabs={onCloseOtherTabs}
                                  onCloseAllTabs={onCloseAllTabs}
                                  canCloseOtherTabs={visibleTabs.length > 1}
                                />
                              );
                            })}
                          </SortableContext>
                          {!isTabsOverflowing ? addTabButton : null}
                        </div>
                      </div>
                      <DragOverlay dropAnimation={null}>
                        {draggingTab ? (
                          <SidePaneTabDragOverlay
                            tab={draggingTab}
                            title={getSidePaneTabTitle(draggingTab, intl.formatMessage, locale)}
                            diffBadgeLabel={intl.formatMessage({
                              id: "diff.title",
                            })}
                          />
                        ) : null}
                      </DragOverlay>
                    </DndContext>

                    <div className="ml-auto flex h-full shrink-0 items-center gap-1 px-2">
                      {isTabsOverflowing ? addTabButton : null}
                      {closeSidePaneButton}
                    </div>
                  </div>
                  {/* Expand Panel 按钮按要求先注释保留，相关逻辑已删除。
                <div className="flex h-full shrink-0 items-center pl-1.5 pr-2">
                  <ControlHintTooltip title="" side="bottom" align="end">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="">
                      Expand Panel
                    </Button>
                  </ControlHintTooltip>
                </div>
                */}
                </TabsList>

                <div
                  ref={mobileOverlay ? undefined : fullViewSlotRef}
                  data-side-pane-content-slot=""
                  className={cn("relative min-h-0 flex-1 isolate", mobileOverlay && "min-w-0")}
                >
                  {fullView && !hasVisibleTabs ? (
                    <div className="absolute inset-0 z-10">{openTabLauncher}</div>
                  ) : null}
                  {tabs.map((tab) => {
                    if (
                      (tab.type === "browser" || tab.type === "browser-use") &&
                      !shouldMountBrowserTabGuest(tab)
                    ) {
                      return <SuspendedBrowserSidePaneContent key={tab.id} tab={tab} />;
                    }
                    if (tab.type === "browser-use") {
                      return (
                        <BrowserUseSidePaneContent
                          key={tab.id}
                          tab={tab}
                          onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                          isPanelVisible={isVisible}
                          isSelected={tab.id === contentActiveTabId}
                          isCurrentTask={currentTaskTabIds.has(tab.id)}
                          screenshotSurfaceRequest={
                            screenshotSurfaceTab?.id === tab.id ? screenshotSurfaceRequest : null
                          }
                          // restoring guest 的完整 history 由 main 在 did-attach 后写入；
                          // renderer 同时消费 initialUrl 会抢先提交导航，使 Chromium 拒绝 restore。
                          automaticRestoreUrl={
                            tab.residency === "restoring"
                              ? (browserRestoreUrls[tab.id] ?? tab.restoreUrl ?? undefined)
                              : undefined
                          }
                          initialUrl={
                            tab.residency === "restoring" ? undefined : browserRestoreUrls[tab.id]
                          }
                          workspacePath={workspaceAbsPath}
                          workspaceIdentity={workspaceIdentity}
                          residencyGeneration={tab.residencyGeneration}
                          onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                          onPageMetadataChange={(metadata) =>
                            onBrowserPageMetadataChange(tab.id, metadata)
                          }
                        />
                      );
                    }
                    return (
                      <TabsContent
                        key={tab.id}
                        value={tab.id}
                        forceMount
                        className={cn(
                          "relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden",
                          mobileOverlay && "min-w-0",
                        )}
                      >
                        {tab.type === "bash-output" ? (
                          <BackgroundBashOutputSidePane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "subagent-session" ? (
                          <SubagentSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            compactForRemoteControl={mobileOverlay}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onOpenSubagentSession={onOpenSubagentSession}
                            onOpenBackgroundBash={onOpenBackgroundBash}
                          />
                        ) : tab.type === "subagent-directory" ? (
                          <SubagentDirectorySidePane
                            tab={tab}
                            onOpenSubagentSession={onOpenSubagentSession}
                          />
                        ) : tab.type === "selection-side-chat" ? (
                          <SelectionSideChatPane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onUnavailable={onCloseTab}
                          />
                        ) : tab.type === "plugin-ui" ? (
                          <PluginUiSidePane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onCloseTab={onCloseTab}
                          />
                        ) : tab.type === "extension-view" ? (
                          // 实例作用域跟随侧栏当前目标（焦点窗格的会话，草稿为预热会话）。
                          <ExtensionViewPane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            target={pluginUiTarget}
                            onOpenExternal={onOpenBrowserUrl}
                          />
                        ) : tab.type === "extension-logs" ? (
                          <ExtensionLogsPane visible={isVisible && tab.id === contentActiveTabId} />
                        ) : tab.type === "plan-detail" ? (
                          <PlanDetailSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-run" ? (
                          <WorkflowRunSidePane
                            tab={tab}
                            {...(onOpenWorkflowActorSession === undefined
                              ? {}
                              : { onOpenWorkflowActorSession })}
                            {...(onOpenWorkflowArtifact === undefined
                              ? {}
                              : { onOpenWorkflowArtifact })}
                            {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
                            {...(onOpenWorkflowWorkspace === undefined
                              ? {}
                              : { onOpenWorkflowWorkspace })}
                          />
                        ) : tab.type === "workflow-directory" ? (
                          // 类型分支必须先收窄，回调缺席在**分支内部**处理：把
                          // `&& onOpenWorkflowRun` 写进条件会让这个 tab 类型继续留在后面
                          // 那些分支的联合里（browser 分支于是拿它去读 residency）。
                          onOpenWorkflowRun ? (
                            <WorkflowRunDirectorySidePane
                              tab={tab}
                              onOpenWorkflowRun={onOpenWorkflowRun}
                            />
                          ) : null
                        ) : tab.type === "workflow-actor-session" ? (
                          <WorkflowActorSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-workspace" ? (
                          <WorkflowWorkspaceSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "workflow-artifact" ? (
                          // 「在工作区显示」复用 Git 面板那条文件树 reveal（同一个宿主回调），
                          // 不新造第二条定位路径。
                          <WorkflowArtifactSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            {...(onRevealGitFileInTree === undefined
                              ? {}
                              : { onRevealFileInTree: onRevealGitFileInTree })}
                          />
                        ) : tab.type === "code-viewer" || tab.type === "file-manager" ? (
                          <FileManagerPane
                            markdownSelectionTarget={{
                              sessionId: activeTaskId,
                              workspaceKey,
                              draftScopeKey,
                            }}
                            source={tab.source}
                            target={
                              tab.type === "file-manager"
                                ? tab.target
                                : {
                                    workspacePath: tab.source.workspacePath ?? workspaceAbsPath,
                                    workspaceIdentity: tab.source.workspacePath
                                      ? tab.source.workspaceIdentity
                                      : workspaceIdentity,
                                    workspaceRemoteSessionId: tab.source.workspacePath
                                      ? tab.source.workspaceRemoteSessionId
                                      : workspaceRemoteSessionId,
                                  }
                            }
                            mobileOverlay={mobileOverlay}
                            canOpenLocalFileManager={Boolean(isDesktop)}
                            onNavigate={(source) => onNavigateFileManager(tab.id, source)}
                            onClose={() => onCloseTab(tab.id)}
                            workspacePath={taskCwd ?? workspaceAbsPath}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            // inactive/窄条/resize 中的 code preview 不应继续让
                            // @pierre/diffs 的千行 Shadow DOM 参与布局；这里只裁剪 body，保留 tab/source/file state。
                            renderHeavyContent={shouldRenderPreviewPaneHeavyContent({
                              isActiveTab: tab.id === contentActiveTabId,
                              // video/audio 原生全屏会触发 resize，resize settling
                              // 期间必须保持当前媒体节点挂载，否则浏览器会立即退出全屏。
                              isMediaPreview:
                                tab.source?.type === "media" ||
                                (tab.source?.type === "file" &&
                                  inferMediaPreview(tab.source.path) !== null),
                              isMobileOverlay: mobileOverlay,
                              isResizeSettling: isWindowResizeSettling,
                              isSidePaneVisible: isVisible,
                              visibleInlineSizePx: sidePaneVisibleInlineSizePx,
                            })}
                          />
                        ) : tab.type === "git" ? (
                          <GitPane
                            workspacePath={taskCwd ?? workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            workspaceRemoteSessionId={workspaceRemoteSessionId}
                            gitState={gitState}
                            isDesktop={isDesktop}
                            selectedSourceId={activeGitSourceId}
                            fileChangeFindActiveIndex={fileChangeFindActiveIndex}
                            fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
                            fileChangeFindQuery={fileChangeFindQuery}
                            onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
                            onSelectSource={onSelectGitSource}
                            onClose={onCloseGit}
                            onRefresh={onRefreshGit}
                            onRevealFileInTree={onRevealGitFileInTree}
                          />
                        ) : tab.type === "treemapping" ? (
                          <TreemappingPane
                            activeTaskId={activeTaskId}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            source={tab.source ?? { kind: "current" }}
                          />
                        ) : tab.type === "whiteboard" ? (
                          <WhiteboardPane
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            boardId={tab.boardId}
                          />
                        ) : tab.type === "model-trajectory" ? (
                          <ModelTrajectoryPane
                            taskId={tab.taskId}
                            title={tab.title}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            onClose={() => onCloseTab(tab.id)}
                          />
                        ) : tab.type === "new-tab" ? (
                          openTabLauncher
                        ) : tab.type === "plugin-market" ? (
                          <ServiceProvider services={services}>
                            <div className="h-full min-w-0 overflow-y-auto p-4">
                              <PluginStorePage
                                onBack={
                                  marketReturnTarget?.workspaceKey === workspaceKey &&
                                  marketReturnTarget.ownerId === (sidePaneOwnerId ?? null)
                                    ? () => {
                                        const targetId = marketReturnTarget.tabId;
                                        setMarketReturnTarget(null);
                                        onCloseTab(tab.id);
                                        if (visibleTabs.some((item) => item.id === targetId)) {
                                          onActivateTab(targetId);
                                        } else {
                                          onOpenNewTab();
                                        }
                                      }
                                    : undefined
                                }
                                embedded
                                onCreateTask={onCreateTask}
                                workspacePath={pluginUiTarget.workspacePath}
                                workspaceIdentity={pluginUiTarget.workspaceIdentity}
                                remoteSessionId={pluginUiTarget.remoteSessionId ?? undefined}
                                sessionId={pluginUiTarget.sessionId}
                                paneId={pluginUiTarget.paneId}
                                isDesktop={isDesktop}
                                isWindowsDesktop={isWindowsDesktop}
                                isMacDesktop={isMacDesktop}
                                isWebRemoteControl={mobileOverlay}
                              />
                            </div>
                          </ServiceProvider>
                        ) : tab.type === "developer-tools" ? (
                          <ServiceProvider services={services}>
                            <DeveloperToolsPane
                              workspacePath={workspaceAbsPath}
                              workspaceIdentity={workspaceIdentity}
                              taskId={activeTaskId}
                              enabled={isVisible && tab.id === contentActiveTabId}
                            />
                          </ServiceProvider>
                        ) : tab.type === "terminal" ? (
                          <SidePaneTerminalPane
                            services={services}
                            sessionId={tab.id}
                            workspaceKey={workspaceKey}
                            cwd={tab.cwd ?? taskCwd ?? workspaceAbsPath}
                            isVisible={isVisible && tab.id === contentActiveTabId}
                            isWindowsDesktop={isWindowsDesktop}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                          />
                        ) : tab.type === "browser-permissions" ? (
                          <BrowserSitePermissionsPage
                            origin={tab.origin}
                            isVisible={isVisible && tab.id === contentActiveTabId}
                          />
                        ) : (
                          <HumanBrowserView
                            browserKey={tab.id}
                            onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                            agentOpened={tab.agentOpened}
                            deferEmptyGuest
                            isResidencyRestore={tab.residency === "restoring"}
                            isVisible={isVisible && isBrowserOpen && tab.id === contentActiveTabId}
                            isSelected={tab.id === contentActiveTabId}
                            isCurrentTask={currentTaskTabIds.has(tab.id)}
                            // restoring 只挂载不会提交 document 的 bootstrap URL，
                            // 由 main 独占 pageState/URL 恢复事务。
                            automaticRestoreUrl={
                              tab.residency === "restoring"
                                ? (browserRestoreUrls[tab.id] ?? tab.initialUrl)
                                : undefined
                            }
                            initialUrl={
                              tab.residency === "restoring"
                                ? undefined
                                : (browserRestoreUrls[tab.id] ?? tab.initialUrl)
                            }
                            faviconUrl={tab.faviconUrl}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            // 切换 workspace 的那次 commit 里 props 已是新 workspace，tabs 仍是旧的；
                            // 读当前 workspace 会以错误 scope attach，触发 workspace-mismatch。
                            workspaceKey={tab.workspaceKey ?? workspaceKey}
                            remoteSessionId={tab.remoteSessionId ?? workspaceRemoteSessionId}
                            residencyGeneration={tab.residencyGeneration}
                            sessionId={tab.ownerTaskId ?? "unscoped"}
                            onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                            onPageMetadataChange={(metadata) =>
                              onBrowserPageMetadataChange(tab.id, metadata)
                            }
                            navigationRequest={
                              browserNavigationRequest?.targetTabId === tab.id
                                ? {
                                    id: browserNavigationRequest.id,
                                    url: browserNavigationRequest.url,
                                  }
                                : null
                            }
                            onNavigationRequestHandled={onBrowserNavigationRequestHandled}
                          />
                        )}
                      </TabsContent>
                    );
                  })}
                </div>
              </Tabs>
            </div>
          </>
        ) : null}
      </ScopedErrorBoundary>
    </div>
  );

  if (!panelLayout.useResizablePanel) {
    return (
      <>
        {/* Bugfix: 手机远控侧栏是覆盖聊天区的抽屉，不在 ResizablePanelGroup 的布局上下文里。
            如果继续渲染 ResizablePanel，外层 auto 宽度会把子级 100% 宽度链路解析成 0px，
            diff / preview 内容就会挂载但不可见；这里改用普通满宽容器承接内容。 */}
        <div
          ref={panelElementRef}
          aria-hidden={!isVisible}
          className={cn(
            "h-full w-full min-w-0 border-l border-border bg-background transition-opacity duration-200 ease-out",
            isVisible || isScreenshotSurfaceActive
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
          {panelContent}
        </div>
      </>
    );
  }

  return (
    <>
      {isVisible && !fullView ? (
        <ResizableHandle
          data-workspace-side-pane-resize-handle="true"
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            "aria-[orientation=vertical]:w-[3px] after:left-px",
            mobileStacked && "max-md:hidden",
          )}
        />
      ) : null}
      <ResizablePanel
        id="browser"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize={panelLayout.defaultSize}
        minSize={panelLayout.minSize}
        maxSize={panelLayout.maxSize}
        collapsedSize={panelLayout.collapsedSize}
        // 右侧面板常驻声明成 collapsible 时，拖到最小宽度会被库判定为 collapse。
        // 这里改成只在显式关闭时允许折叠，避免用户只是想拖到最小宽度时面板自动收起。
        collapsible={isDragCollapsible}
        // preview/side pane 收起时没有 ResizableHandle，但库仍会暴露 collapsed panel 边缘拖拽区。
        // 收起后禁用面板 resize target，避免用户绕过显式开关从右侧边缘拖出面板。
        disabled={isResizeDisabled}
        className={cn(
          "!overflow-hidden transition-opacity duration-200 ease-out motion-reduce:transition-none",
          mobileOverlay &&
            "max-md:!h-full max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-1 max-md:!basis-auto max-md:border-l",
          mobileStacked &&
            !mobileOverlay &&
            "max-md:!h-[min(45dvh,24rem)] max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-l-0 max-md:border-t",
          // 截图期间 panel 仍保持 opacity=1，避免 opacity=0 让 Chromium 丢弃 guest
          // compositor surface；实际 browser surface 已 fixed 到窗口内的低透明合成层，不会露出 tab 栏。
          isVisible || isScreenshotSurfaceActive ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {panelContent}
      </ResizablePanel>
    </>
  );
}

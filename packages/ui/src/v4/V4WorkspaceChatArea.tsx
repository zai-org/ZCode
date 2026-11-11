/* oxlint-disable eslint(max-lines) -- V4WorkspaceChatArea 是分屏 workbench 宿主，集中管理 pane layout/focus/session binding；拆散会让 store action 和 shell binding 链路跨文件跳转。 */
import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  effectiveFocusedPaneId,
  paneWorkspaceKey,
  PRIMARY_LEAF,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import {
  collectWorkbenchLayout,
  dividerStyle,
  FULL_WORKBENCH_RECT,
  SPLIT_VAR_PREFIX,
} from "@/v4/workbenchLayout.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchSplitDivider } from "@/v4/WorkbenchSplitDivider.js";
import { type RegisterConversationDropTarget } from "@/v4/composer/conversationDropTarget.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  closeWorkbenchGroupPane,
  selectWorkbenchGroupActiveBinding,
  selectWorkbenchGroupPaneBinding,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";

export interface V4WorkspaceChatAreaProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop；Web / 手机远控保留 UI 行为但不触发该事件。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  allowEscapeStopOutsidePane?: boolean;
  /** Settings 等覆盖层打开时为 false，隐藏 Pane 不得消费一次性 Composer 请求。 */
  foregroundEnabled?: boolean;
  remoteSessionId?: string;
  compactForRemoteControl?: boolean;
  /** primary pane 绑定的 CLI session（既有选择态 activeTaskId）；null = draft。 */
  sessionId: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  /** primary pane createSession/fork 后接入既有选择路径（handleSelectTask）。 */
  onSessionCreated?: (sessionId: string, origin?: "draft-promotion") => void;
  /** primary pane 会话删除后回 draft（shell 起新草稿）。 */
  onSessionDeleted?: () => void;
  /**
   * 草稿态 composer contextHeader（m5：workspace 菜单 + Git 分支），
   * 仅下发给 primary pane——其余 pane 的 draft 不承载壳级 workspace 切换。
   */
  draftComposerHeader?: ReactNode;
  /** 桌面轻量草稿标题栏复用主草稿 composer 的 drop controller。 */
  onPrimaryDraftDropTargetControllerChange?: RegisterConversationDropTarget;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPaneActiveSessionChange?: (
    scope: PaneWorkspaceScope,
    sessionId: string,
    origin?: "draft-promotion",
  ) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/**
 * 分屏 workspace 主聊天区：多 pane 跨 workspace 工作台
 *
 * - 布局：paneLayoutStore 的二叉分割树 → 绝对定位 rect（CSS 变量驱动占比）；
 *   叶子扁平渲染（key = paneId），拆分/关闭不重挂任何存活 pane。
 * - 数据面：每个 pane 一个 V4PaneConversationProvider——连接经
 *   workspaceConnectionRegistry 按 endpoint+workspaceKey 引用计数复用
 *   （同 workspace 的 pane 共享一条 transport + SessionDataLayer）。
 * - primary pane 绑定沿用 activeTaskId（shell props，随 workspace tab 切换）；
 *   其余 pane 绑定归 paneLayoutStore，自带 workspaceScope、跨 tab 常驻。
 * - Focus 层：快捷键（Esc stop）/add-to-chat 只路由到 focused pane。
 * - 恢复守卫：restoredUnvalidated pane 各自经其 scope 的 sessions-index 验证。
 */
export function V4WorkspaceChatArea({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  readOnlyReason,
  allowEscapeStopOutsidePane = false,
  foregroundEnabled = true,
  remoteSessionId,
  compactForRemoteControl = false,
  sessionId,
  activeSelectionSideChatSessionId = null,
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
  onPrimaryDraftDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onPaneActiveSessionChange,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: V4WorkspaceChatAreaProps) {
  const shellWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  // selector 返回 store 内既有引用/派生原语，未变化不触发重渲染。
  const paneRoot = usePaneLayoutStore((state) => state.root);
  const paneBindings = usePaneLayoutStore((state) => state.panes);
  const paneFocusedPaneId = usePaneLayoutStore((state) => effectiveFocusedPaneId(state));
  // zustand action 引用稳定。
  const closePaneAction = usePaneLayoutStore((state) => state.closePane);
  const confirmRestoredPaneSessionAction = usePaneLayoutStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const focusPaneAction = usePaneLayoutStore((state) => state.focusPane);
  const bindPaneSessionAction = usePaneLayoutStore((state) => state.bindPaneSession);
  const setSplitRatioAction = usePaneLayoutStore((state) => state.setSplitRatio);
  const resetPaneLayoutAction = usePaneLayoutStore((state) => state.resetToPrimaryPane);
  const activeGroup = useWorkbenchGroupStore((state) =>
    compactForRemoteControl || !state.activeGroupId
      ? null
      : (state.groups[state.activeGroupId] ?? null),
  );
  const focusGroupPaneAction = useWorkbenchGroupStore((state) => state.focusPane);
  const closeGroupPaneAction = useWorkbenchGroupStore((state) => state.closePane);
  const confirmRestoredGroupPaneSessionAction = useWorkbenchGroupStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const bindGroupPaneSessionAction = useWorkbenchGroupStore((state) => state.bindPaneSession);
  const setGroupSplitRatioAction = useWorkbenchGroupStore((state) => state.setSplitRatio);
  const promotePaneLayoutToGroupAction = useWorkbenchGroupStore(
    (state) => state.promotePaneLayoutToGroup,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  const root = compactForRemoteControl ? PRIMARY_LEAF : (activeGroup?.root ?? paneRoot);
  const panes = compactForRemoteControl ? {} : (activeGroup?.panes ?? paneBindings);
  const focusedPaneId = compactForRemoteControl
    ? V4_PRIMARY_PANE_ID
    : (activeGroup?.focusedPaneId ?? paneFocusedPaneId);
  const layout = useMemo(() => collectWorkbenchLayout(root), [root]);
  const shellSessionOwnedBySplitPane = useMemo(() => {
    if (compactForRemoteControl || activeGroup || !sessionId) {
      return false;
    }
    return Object.values(paneBindings).some(
      (binding) =>
        binding.sessionId === sessionId &&
        paneWorkspaceKey(binding.workspaceScope) === shellWorkspaceKey,
    );
  }, [activeGroup, compactForRemoteControl, paneBindings, sessionId, shellWorkspaceKey]);
  // 修复原因：primary draft 没有自己的 sessionId；拖入 session 时 shell active
  // 可能已经切到右侧 pane 的 session，不能再把这个 sessionId 下发给 primary。
  const primaryPaneSessionId = shellSessionOwnedBySplitPane ? null : sessionId;

  // 占比接线：store 值只在提交（pointerup/恢复）时变化；拖动中由分隔条直写 CSS 变量。
  const containerStyle = useMemo<CSSProperties>(() => {
    const style: Record<string, string> = {};
    for (const divider of layout.dividers) {
      style[`${SPLIT_VAR_PREFIX}${divider.splitId}`] = String(divider.ratio);
    }
    return style as CSSProperties;
  }, [layout]);

  const paneCount = layout.leaves.length;
  const { presentation } = useConversationPanePresentation();
  // 完整视图浮窗只容纳一个对话：旧的拆分布局只显示焦点 pane，其余隐藏但保持挂载。
  const soloPaneId = presentation === "floating" && paneCount > 1 ? focusedPaneId : null;
  const showFocusIndicator = paneCount > 1 && !soloPaneId;

  const shellScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspacePath, workspaceIdentity],
  );

  const shell = useMemo<WorkbenchShellBinding>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      isDesktop,
      compactForRemoteControl,
      readOnly,
      readOnlyReason,
      allowEscapeStopOutsidePane,
      sessionId: primaryPaneSessionId,
      // primaryPaneSessionId 在 active task 被 split pane 接管时会刻意置空，
      // 辅助对话划词路由仍需保留 shell 真正的 active task id。
      activeSessionId: sessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary: primaryPaneSessionId ? activeTaskChangeSummary : null,
      summaryPanelVariantOverride,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx,
      onOpenFileLink,
      onOpenSubagentSession,
      onOpenBackgroundBash,
      onOpenSubagentDirectory,
      onSyncSubagentSessionTabs,
      onOpenSelectionSideChat,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
      onOpenWorkflowRunDirectory,
      onOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    }),
    [
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
      readOnly,
      readOnlyReason,
      allowEscapeStopOutsidePane,
      primaryPaneSessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary,
      summaryPanelVariantOverride,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx,
      onOpenFileLink,
      onOpenSubagentSession,
      onOpenBackgroundBash,
      onOpenSubagentDirectory,
      onSyncSubagentSessionTabs,
      onOpenSelectionSideChat,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
      onOpenWorkflowRunDirectory,
      onOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    ],
  );

  const resolvePaneSessionBinding = useMemo(
    () =>
      (paneId: string): WorkbenchSessionBinding | null => {
        if (activeGroup) {
          return selectWorkbenchGroupPaneBinding(activeGroup, paneId);
        }
        if (paneId === V4_PRIMARY_PANE_ID) {
          return primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        }
        const binding = paneBindings[paneId];
        return binding?.sessionId
          ? {
              workspaceScope: binding.workspaceScope,
              sessionId: binding.sessionId,
              ...(binding.readOnly ? { readOnly: true } : {}),
            }
          : null;
      },
    [activeGroup, paneBindings, primaryPaneSessionId, shellScope],
  );

  const syncShellActiveSession = useCallback(
    (binding: WorkbenchSessionBinding | null) => {
      if (!binding || binding.readOnly) {
        return;
      }
      // readOnly subagent pane 只是 workbench 内观察视图，不是左侧
      // task 导航目标；反写 shell activeTaskId 会让左侧高亮/乐观 task 误切到 child。
      onPaneActiveSessionChange?.(binding.workspaceScope, binding.sessionId);
    },
    [onPaneActiveSessionChange],
  );

  const handleFocusRequest = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        focusGroupPaneAction(activeGroup.id, paneId);
      } else {
        focusPaneAction(paneId);
      }
      syncShellActiveSession(resolvePaneSessionBinding(paneId));
    },
    [
      activeGroup,
      focusGroupPaneAction,
      focusPaneAction,
      resolvePaneSessionBinding,
      syncShellActiveSession,
    ],
  );

  const handleClosePane = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        const nextGroup = closeWorkbenchGroupPane(activeGroup, paneId);
        const nextActiveBinding =
          activeGroup.focusedPaneId === paneId
            ? nextGroup
              ? selectWorkbenchGroupActiveBinding(nextGroup)
              : paneId === V4_PRIMARY_PANE_ID
                ? null
                : activeGroup.primaryBinding
            : null;
        closeGroupPaneAction(activeGroup.id, paneId);
        // close store 只负责布局塌缩；若被关 pane 正是 focused pane，
        // shell activeTaskId 必须回到关闭后的可导航 session，不能继续停在已关闭 session。
        syncShellActiveSession(nextActiveBinding);
      } else {
        const nextActiveBinding =
          focusedPaneId === paneId && primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        closePaneAction(paneId);
        syncShellActiveSession(nextActiveBinding);
      }
    },
    [
      activeGroup,
      closeGroupPaneAction,
      closePaneAction,
      focusedPaneId,
      primaryPaneSessionId,
      shellScope,
      syncShellActiveSession,
    ],
  );

  const handleConfirmRestoredSession = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        confirmRestoredGroupPaneSessionAction(activeGroup.id, paneId);
      } else {
        confirmRestoredPaneSessionAction(paneId);
      }
    },
    [activeGroup, confirmRestoredGroupPaneSessionAction, confirmRestoredPaneSessionAction],
  );

  const handleCommitSplitRatio = useMemo(
    () => (splitId: string, ratio: number) => {
      if (activeGroup) {
        setGroupSplitRatioAction(activeGroup.id, splitId, ratio);
      } else {
        setSplitRatioAction(splitId, ratio);
      }
    },
    [activeGroup, setGroupSplitRatioAction, setSplitRatioAction],
  );

  const handleBindSession = useMemo(
    () => (paneId: string, createdSessionId: string) => {
      if (activeGroup) {
        bindGroupPaneSessionAction(activeGroup.id, paneId, createdSessionId);
        return true;
      }
      if (paneId === V4_PRIMARY_PANE_ID) {
        const sourceLayout = usePaneLayoutStore.getState();
        if (Object.keys(sourceLayout.panes).length > 0) {
          // draft primary 本身不在 paneLayout.panes 中。首发 accepted 后若只让
          // shell 记住新 session，focus 已绑定的 secondary 会覆盖 shell activeTaskId，
          // primary 随即丢失身份并回到 draft。这里先以新 session 作为 primaryBinding
          // 原子提升可见布局，再由上层同步 shell active，两个 pane 都有稳定 owner。
          const promoted = promotePaneLayoutToGroupAction(
            { workspaceScope: shellScope, sessionId: createdSessionId },
            sourceLayout,
          );
          if (promoted) {
            resetPaneLayoutAction();
            logger.info("[v4-workbench] primary draft promoted to session group", {
              createdSessionId,
              workspaceKey: paneWorkspaceKey(shellScope),
            });
          }
        }
        return true;
      }
      bindPaneSessionAction(paneId, createdSessionId);
      if (!sessionId) {
        return false;
      }
      // 非 primary draft 首发会先产生新 session；若此时直接
      // 反写 shell activeTaskId，primary pane 仍由 shell.sessionId 驱动，
      // 会跟着显示右侧新 session。先把当前 paneLayout 提升为 group，
      // 用 primaryBinding 固定原 session，再允许 shell active 跟随新 pane。
      const promoted = promotePaneLayoutToGroupAction(
        { workspaceScope: shellScope, sessionId },
        usePaneLayoutStore.getState(),
      );
      if (promoted) {
        // promotion 是布局 owner 转移，不是复制后双写。group 已持有完整
        // workspace scope/binding 后立即消费 source，避免刷新或 group GC 时旧 split 复活。
        resetPaneLayoutAction();
      }
      return promoted;
    },
    [
      activeGroup,
      bindGroupPaneSessionAction,
      bindPaneSessionAction,
      promotePaneLayoutToGroupAction,
      resetPaneLayoutAction,
      sessionId,
      shellScope,
    ],
  );

  return (
    <div ref={containerRef} style={containerStyle} className="relative h-full min-h-0 w-full">
      {layout.leaves.map((leaf) => (
        <WorkbenchLeafPane
          key={leaf.paneId}
          paneId={leaf.paneId}
          rect={soloPaneId ? FULL_WORKBENCH_RECT : leaf.rect}
          hidden={soloPaneId !== null && leaf.paneId !== soloPaneId}
          // Settings 只把 workspace 设为 inert，Pane 之前仍保留 focused=true，
          // 会在隐藏状态提前消费 Plugin 试用的一次性预填。可见性并入 focus 后，
          // 请求只会由返回 workspace 后真正可交互的 Composer 消费。
          focused={foregroundEnabled && focusedPaneId === leaf.paneId}
          showFocusIndicator={showFocusIndicator}
          shellWorkspaceKey={shellWorkspaceKey}
          binding={leaf.paneId === V4_PRIMARY_PANE_ID ? null : (panes[leaf.paneId] ?? null)}
          primaryBinding={
            leaf.paneId === V4_PRIMARY_PANE_ID ? (activeGroup?.primaryBinding ?? null) : null
          }
          shell={shell}
          onFocusRequest={handleFocusRequest}
          onClosePane={handleClosePane}
          onConfirmRestoredSession={handleConfirmRestoredSession}
          onBindSession={handleBindSession}
          onPaneActiveSessionChange={onPaneActiveSessionChange}
        />
      ))}
      {(soloPaneId ? [] : layout.dividers).map((divider) => (
        <WorkbenchSplitDivider
          key={divider.splitId}
          containerRef={containerRef}
          splitId={divider.splitId}
          direction={divider.direction}
          ratio={divider.ratio}
          regionFraction={divider.regionFraction}
          style={dividerStyle(divider)}
          onCommitRatio={handleCommitSplitRatio}
        />
      ))}
    </div>
  );
}

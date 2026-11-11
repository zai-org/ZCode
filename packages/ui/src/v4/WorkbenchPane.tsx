import {
  RemoteConversationBanner,
  RemoteConversationDisconnected,
} from "@/project-sidebar/RemoteConversationDisconnected.js";
/* oxlint-disable eslint(max-lines) -- WorkbenchLeafPane 集中承载 pane focus、per-pane provider 与恢复守卫；拆散会让 focus/session 绑定链路跨文件跳转。 */
// 分屏叶子 pane：Focus 层外壳 + per-pane 数据面接线 + 恢复守卫。宿主 = V4WorkspaceChatArea。
import { memo, useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { TID_V4_PANE_SHELL, testId } from "@zcode/shared/test-ids";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
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
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { type RegisterConversationDropTarget } from "@/v4/composer/conversationDropTarget.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  paneWorkspaceKey,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import { rectStyle, type RectExpr } from "@/v4/workbenchLayout.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

interface ChatPaneShellProps {
  paneId: string;
  focused: boolean;
  /** 单 pane 布局时不画焦点框（无歧义，避免视觉噪音）。 */
  showFocusIndicator: boolean;
  onFocusRequest: (paneId: string) => void;
  /** 绝对定位 rect（布局层计算的 calc 表达式）。 */
  style: CSSProperties;
  hidden?: boolean;
  children: ReactNode;
  restoredUnvalidated?: boolean;
}

const INACTIVE_PANE_OVERLAY_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-background) 34%, transparent)",
  backdropFilter: "brightness(0.94) saturate(0.94)",
};

/**
 * Focus 层外壳：点击/聚焦 pane 内任意处 → focus 该 pane（capture，不干扰子树交互）。
 * memo + 稳定回调：焦点切换只翻转 data-focused/边框类名，不牵动 pane 内容子树。
 */
const ChatPaneShell = memo(function ChatPaneShell({
  paneId,
  focused,
  showFocusIndicator,
  onFocusRequest,
  style,
  hidden = false,
  children,
  restoredUnvalidated = false,
}: ChatPaneShellProps) {
  const handleFocusRequest = useCallback(() => {
    onFocusRequest(paneId);
  }, [onFocusRequest, paneId]);

  return (
    <div
      data-testid={testId(TID_V4_PANE_SHELL, paneId)}
      data-pane-id={paneId}
      data-focused={focused ? "true" : "false"}
      data-restored-unvalidated={restoredUnvalidated ? "true" : "false"}
      onPointerDownCapture={handleFocusRequest}
      onFocusCapture={handleFocusRequest}
      style={style}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        hidden && "hidden",
        showFocusIndicator && focused && "ring-1 ring-inset ring-[var(--color-brand)]",
      )}
    >
      {showFocusIndicator && !focused ? (
        <div
          aria-hidden="true"
          data-v4-pane-inactive-overlay="true"
          style={INACTIVE_PANE_OVERLAY_STYLE}
          className="pointer-events-none absolute inset-0 z-30 rounded-md transition-[background-color,backdrop-filter]"
        />
      ) : null}
      {children}
    </div>
  );
});

interface PaneRestoredGuardProps {
  paneId: string;
  scope: PaneWorkspaceScope;
  sessionId: string;
  onConfirmed: (paneId: string) => void;
  onMissing: (paneId: string) => void;
}

/**
 * 持久化恢复守卫（per-pane 泛化）：localStorage 恢复的绑定可能指向已删 session
 * （删除发生在上次运行/其他窗口）。用 pane 自己 scope 的 sessions-index（按
 * endpoint + workspaceKey 隔离）等首个真 snapshot（workspaceId 就绪）后做一次
 * 存在性验证：在场 → 清 restoredUnvalidated；已删 → closePane 优雅塌缩。
 * 不用 useWorkspaceSessionsIndexItems——其聚合 memo 在
 * 订阅 effect 之前按空 store 集计算会误判「已加载且不在」；直连 registry store，
 * 订阅错误/远程 endpoint 不在场（断连代理 reject）时不判定，pane 保留为
 * error/等待连接态，交由 pane 自身 retry 兜底，不误关。
 * 必须挂在 V4PaneConversationProvider 内：useServices 取的是 pane 自己的 accessor
 * （远程 pane 走对应远程连接的 sessions-index，不误查本机 host）。
 */
function PaneRestoredGuard({
  paneId,
  scope,
  sessionId,
  onConfirmed,
  onMissing,
}: PaneRestoredGuardProps) {
  const services = useServices();
  const agentService = services.zcodeAgentService;
  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;

  useEffect(() => {
    if (!agentService) {
      return;
    }
    const indexScope: SessionsIndexScope = {
      workspaceKey: paneWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    const store = acquireSessionsIndex(indexScope, agentService);
    let disposed = false;
    let settled = false;
    const evaluate = () => {
      if (disposed || settled || store.getState().workspaceId === null) {
        return;
      }
      settled = true;
      const exists = store.getSessions().some((summary) => summary.sessionId === sessionId);
      if (exists) {
        onConfirmed(paneId);
      } else {
        onMissing(paneId);
      }
    };
    const unsubscribe = store.subscribe(evaluate);
    evaluate();
    return () => {
      disposed = true;
      unsubscribe();
      releaseSessionsIndex(indexScope, store);
    };
  }, [
    agentService,
    paneId,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onConfirmed,
    onMissing,
  ]);

  return null;
}

/** primary pane 的 shell 侧绑定（activeTaskId 选择态 + 回调，不进 paneLayoutStore）。 */
export interface WorkbenchShellBinding {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  allowEscapeStopOutsidePane?: boolean;
  compactForRemoteControl?: boolean;
  sessionId: string | null;
  /** Shell 当前真正激活的 task；split pane 接管 active task 时不等于 primary sessionId。 */
  activeSessionId?: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string, origin?: "draft-promotion") => void;
  onSessionDeleted?: () => void;
  draftComposerHeader?: ReactNode;
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
  /** 插件 UI 侧栏：与 onOpenPlanDetail 同路径经 shell binding 下发到 SessionPane。 */
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

export interface WorkbenchLeafPaneProps {
  paneId: string;
  rect: RectExpr;
  /** 完整视图浮窗只显示焦点 pane；其余 pane 隐藏但不卸载。 */
  hidden?: boolean;
  focused: boolean;
  showFocusIndicator: boolean;
  shellWorkspaceKey: string;
  /** 非 primary pane 的绑定；primary 传 null（用 shell 绑定）。 */
  binding: PaneBinding | null;
  /** session workbench group 中 primary pane 的显式绑定；无 group 时为 null。 */
  primaryBinding?: WorkbenchSessionBinding | null;
  shell: WorkbenchShellBinding;
  onFocusRequest: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onConfirmRestoredSession: (paneId: string) => void;
  onBindSession: (paneId: string, sessionId: string) => boolean | void;
  onPaneActiveSessionChange?: (
    scope: PaneWorkspaceScope,
    sessionId: string,
    origin?: "draft-promotion",
  ) => void;
}

function workspaceBadgeFor(scope: PaneWorkspaceScope): PaneWorkspaceBadge {
  const label = scope.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? scope.workspacePath;
  return {
    label,
    workspacePath: scope.workspacePath,
    remote: Boolean(scope.workspaceIdentity || scope.remoteSessionId),
  };
}

export function WorkbenchLeafPane({
  paneId,
  rect,
  hidden = false,
  focused,
  showFocusIndicator,
  shellWorkspaceKey,
  binding,
  primaryBinding,
  shell,
  onFocusRequest,
  onClosePane,
  onConfirmRestoredSession,
  onBindSession,
  onPaneActiveSessionChange,
}: WorkbenchLeafPaneProps) {
  const isPrimary = paneId === V4_PRIMARY_PANE_ID;
  const isGroupPrimary = isPrimary && Boolean(primaryBinding);
  const scope = useMemo<PaneWorkspaceScope>(() => {
    if (!isPrimary && binding) {
      return binding.workspaceScope;
    }
    if (isPrimary && primaryBinding) {
      return primaryBinding.workspaceScope;
    }
    return {
      workspacePath: shell.workspacePath,
      ...(shell.workspaceIdentity ? { workspaceIdentity: shell.workspaceIdentity } : {}),
      ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
    };
  }, [
    isPrimary,
    binding,
    primaryBinding,
    shell.workspacePath,
    shell.workspaceIdentity,
    shell.remoteSessionId,
  ]);

  const style = useMemo(() => rectStyle(rect), [rect]);

  const handleClosePane = useCallback(() => {
    onClosePane(paneId);
  }, [onClosePane, paneId]);
  const handleSessionDeleted = useCallback(() => {
    if (isGroupPrimary) {
      // group primary 删除过去只关闭布局，shell 仍指向已删除 session。
      // accepted 后必须先解散 group，再让 shell 回当前 workspace draft；secondary
      // 仅恢复普通 session 身份，不能在这里被隐式提升。
      handleClosePane();
      shell.onSessionDeleted?.();
      return;
    }
    if (isPrimary) {
      shell.onSessionDeleted?.();
      return;
    }
    handleClosePane();
  }, [handleClosePane, isGroupPrimary, isPrimary, shell.onSessionDeleted]);
  const handleBindSession = useCallback(
    (createdSessionId: string, origin?: "draft-promotion") => {
      const shouldSyncShellActive = onBindSession(paneId, createdSessionId) !== false;
      if (shouldSyncShellActive) {
        onPaneActiveSessionChange?.(scope, createdSessionId, origin);
      }
    },
    [onBindSession, onPaneActiveSessionChange, paneId, scope],
  );
  const handleSessionCreated = useCallback(
    (createdSessionId: string, origin?: "draft-promotion") => {
      if (isPrimary && !primaryBinding) {
        // primary draft 旁边已经有拖入的 session 时，首发不能只更新 shell。
        // 必须先让 workbench 宿主把 draft pane 原地绑定并接管整个布局；否则随后
        // focus secondary 会改写 shell activeTaskId，primary 就因没有独立 binding 退回 draft。
        onBindSession(paneId, createdSessionId);
        shell.onSessionCreated?.(createdSessionId, origin);
        return;
      }
      handleBindSession(createdSessionId, origin);
    },
    [handleBindSession, isPrimary, onBindSession, paneId, primaryBinding, shell.onSessionCreated],
  );
  if (!isPrimary && !binding) {
    // sanitize/迁移保证非 primary 叶子必有绑定；此处是转移瞬间的防御渲染。
    return null;
  }

  const isShellWorkspace = paneWorkspaceKey(scope) === shellWorkspaceKey;
  const sessionId = isPrimary
    ? (primaryBinding?.sessionId ?? shell.sessionId)
    : (binding?.sessionId ?? null);
  const readOnly = Boolean(
    (isPrimary ? primaryBinding?.readOnly : binding?.readOnly) ||
    (isShellWorkspace && shell.readOnly),
  );
  const shouldUseShellStatusPanel = isShellWorkspace;
  const paneSearchResultHighlightRequest =
    sessionId === shell.searchResultHighlightRequest?.taskId
      ? shell.searchResultHighlightRequest
      : null;

  return (
    <ChatPaneShell
      paneId={paneId}
      focused={focused}
      showFocusIndicator={showFocusIndicator}
      onFocusRequest={onFocusRequest}
      style={style}
      hidden={hidden}
      restoredUnvalidated={Boolean((isPrimary ? primaryBinding : binding)?.restoredUnvalidated)}
    >
      <V4PaneConversationProvider
        scope={scope}
        sessionId={sessionId}
        unavailableFallback={<RemoteConversationDisconnected {...scope} sessionId={sessionId} />}
        disconnectedBanner={<RemoteConversationBanner {...scope} sessionId={sessionId} />}
      >
        {(isPrimary ? primaryBinding : binding)?.restoredUnvalidated && sessionId ? (
          <PaneRestoredGuard
            paneId={paneId}
            scope={scope}
            sessionId={sessionId}
            onConfirmed={onConfirmRestoredSession}
            onMissing={onClosePane}
          />
        ) : null}
        <SessionPane
          paneId={paneId}
          readOnly={readOnly}
          readOnlyReason={isShellWorkspace ? shell.readOnlyReason : undefined}
          sessionId={sessionId}
          openTrigger={isPrimary ? "sidebar" : "split"}
          activeSelectionSideChatSessionId={resolvePaneActiveSelectionSideChatSessionId(
            sessionId,
            shell.activeSessionId ?? shell.sessionId,
            shell.activeSelectionSideChatSessionId,
          )}
          workspacePath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
          remoteSessionId={scope.remoteSessionId}
          isDesktop={shell.isDesktop}
          compactForRemoteControl={shell.compactForRemoteControl ?? false}
          provider={isPrimary && isShellWorkspace ? shell.provider : undefined}
          onSessionCreated={handleSessionCreated}
          onSessionDeleted={handleSessionDeleted}
          focused={focused}
          allowEscapeStopOutsidePane={shell.allowEscapeStopOutsidePane}
          onClosePane={isPrimary ? undefined : handleClosePane}
          workspaceBadge={!isPrimary && !isShellWorkspace ? workspaceBadgeFor(scope) : undefined}
          draftComposerHeader={isPrimary && !primaryBinding ? shell.draftComposerHeader : undefined}
          // 草稿页头才需要上行拖拽控制器。普通会话上传它会把 Composer 的闭包送回壳层，
          // 再经壳层回调连回旧 SessionPane，形成跨会话的 snapshot / store 保留链。
          onDropTargetControllerChange={
            isPrimary && !primaryBinding && sessionId === null
              ? shell.onPrimaryDraftDropTargetControllerChange
              : undefined
          }
          gitSummary={shouldUseShellStatusPanel ? shell.gitSummary : undefined}
          gitDirtyFileCount={shouldUseShellStatusPanel ? shell.gitDirtyFileCount : undefined}
          gitWorktreeReviewSourceId={
            shouldUseShellStatusPanel ? shell.gitWorktreeReviewSourceId : undefined
          }
          gitWorktreeChangeSummary={
            shouldUseShellStatusPanel ? shell.gitWorktreeChangeSummary : undefined
          }
          activeTaskChangeSummary={isPrimary ? shell.activeTaskChangeSummary : undefined}
          summaryPanelVariantOverride={
            shouldUseShellStatusPanel ? shell.summaryPanelVariantOverride : undefined
          }
          onSummaryPanelVariantOverrideChange={
            shouldUseShellStatusPanel ? shell.onSummaryPanelVariantOverrideChange : undefined
          }
          onRefreshGit={shouldUseShellStatusPanel ? shell.onRefreshGit : undefined}
          onOpenGitReview={shouldUseShellStatusPanel ? shell.onOpenGitReview : undefined}
          onOpenBrowserUrl={shell.onOpenBrowserUrl}
          onOpenAutomationsMain={shell.onOpenAutomationsMain}
          onOpenCodeViewer={shell.onOpenCodeViewer}
          onAutoOpenAssistantPptx={shell.onAutoOpenAssistantPptx}
          onOpenFileLink={shell.onOpenFileLink}
          onOpenSubagentSession={shell.onOpenSubagentSession}
          onOpenBackgroundBash={shell.onOpenBackgroundBash}
          onOpenSubagentDirectory={shell.onOpenSubagentDirectory}
          onSyncSubagentSessionTabs={shell.onSyncSubagentSessionTabs}
          onOpenSelectionSideChat={shell.onOpenSelectionSideChat}
          onOpenPlanDetail={shell.onOpenPlanDetail}
          onOpenWorkflowRun={shell.onOpenWorkflowRun}
          onOpenWorkflowArtifact={shell.onOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={shell.onOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={shell.onOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={shell.onOpenWorkflowWorkspace}
          conversationFindQuery={focused ? shell.conversationFindQuery : ""}
          conversationFindActiveIndex={focused ? (shell.conversationFindActiveIndex ?? -1) : -1}
          conversationFindNavigationRequestId={
            focused ? (shell.conversationFindNavigationRequestId ?? 0) : 0
          }
          onConversationFindMatchStateChange={
            focused ? shell.onConversationFindMatchStateChange : undefined
          }
          searchResultHighlightRequest={paneSearchResultHighlightRequest}
          onSearchResultHighlightDone={shell.onSearchResultHighlightDone}
        />
      </V4PaneConversationProvider>
    </ChatPaneShell>
  );
}

export function resolvePaneActiveSelectionSideChatSessionId(
  paneSessionId: string | null,
  shellActiveSessionId: string | null,
  activeSelectionSideChatSessionId: string | null | undefined,
): string | null {
  return paneSessionId && paneSessionId === shellActiveSessionId
    ? (activeSelectionSideChatSessionId ?? null)
    : null;
}

import {
  RemoteConversationBanner,
  RemoteConversationDisconnected,
} from "@/project-sidebar/RemoteConversationDisconnected.js";
import type { ReactNode } from "react";
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
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { V4ConversationProvider } from "@/v4/V4ConversationContext.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

export interface V4ChatPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  allowEscapeStopOutsidePane?: boolean;
  compactForRemoteControl?: boolean;
  /** CLI session id；null = draft 首发。 */
  sessionId: string | null;
  /** 当前 workspace 主 pane 的打开入口，未提供时按 sidebar 统计。 */
  openTrigger?: SessionOpenTrigger;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string, origin?: "draft-promotion") => void;
  /** deleteSession：删除当前会话后回到 draft。 */
  onSessionDeleted?: () => void;
  /** 草稿态 composer contextHeader（m5，壳层构造下发）。 */
  draftComposerHeader?: ReactNode;
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
 * 竖切聊天区：替换 ChatView 的最小入口。
 * 外层按 workspace 包 V4ConversationProvider；单 pane paneId 固定 workspace-main。
 */
export function V4ChatPane({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  readOnlyReason,
  allowEscapeStopOutsidePane = false,
  compactForRemoteControl = false,
  sessionId,
  openTrigger = "sidebar",
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
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
}: V4ChatPaneProps) {
  return (
    <V4ConversationProvider
      sessionId={sessionId ?? null}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      unavailableFallback={
        <RemoteConversationDisconnected
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={sessionId}
        />
      }
      disconnectedBanner={
        <RemoteConversationBanner
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={sessionId}
        />
      }
    >
      <SessionPane
        paneId="workspace-main"
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        allowEscapeStopOutsidePane={allowEscapeStopOutsidePane}
        sessionId={sessionId}
        openTrigger={openTrigger}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        isDesktop={isDesktop}
        compactForRemoteControl={compactForRemoteControl}
        provider={provider}
        onSessionCreated={onSessionCreated}
        onSessionDeleted={onSessionDeleted}
        draftComposerHeader={draftComposerHeader}
        gitSummary={gitSummary}
        gitDirtyFileCount={gitDirtyFileCount}
        gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
        gitWorktreeChangeSummary={gitWorktreeChangeSummary}
        activeTaskChangeSummary={activeTaskChangeSummary}
        summaryPanelVariantOverride={summaryPanelVariantOverride}
        onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
        onRefreshGit={onRefreshGit}
        onOpenGitReview={onOpenGitReview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenAutomationsMain={onOpenAutomationsMain}
        onOpenCodeViewer={onOpenCodeViewer}
        onAutoOpenAssistantPptx={onAutoOpenAssistantPptx}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenBackgroundBash={onOpenBackgroundBash}
        onOpenSubagentDirectory={onOpenSubagentDirectory}
        onSyncSubagentSessionTabs={onSyncSubagentSessionTabs}
        onOpenPlanDetail={onOpenPlanDetail}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        onOpenWorkflowRunDirectory={onOpenWorkflowRunDirectory}
        onOpenWorkflowActorSession={onOpenWorkflowActorSession}
        onOpenWorkflowWorkspace={onOpenWorkflowWorkspace}
        conversationFindQuery={conversationFindQuery}
        conversationFindActiveIndex={conversationFindActiveIndex}
        conversationFindNavigationRequestId={conversationFindNavigationRequestId}
        onConversationFindMatchStateChange={onConversationFindMatchStateChange}
        searchResultHighlightRequest={searchResultHighlightRequest}
        onSearchResultHighlightDone={onSearchResultHighlightDone}
      />
    </V4ConversationProvider>
  );
}

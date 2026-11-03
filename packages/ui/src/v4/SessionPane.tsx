import { V4_PRIMARY_PANE_ID } from "@/v4/paneLayoutStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSessionRuntimeRestart } from "@/app-shell/useWorkspaceSessionReload.js";
import { isRequestVerificationConfigNetworkError } from "@/request-security-edition/errors.js";
import { useShallow } from "zustand/react/shallow";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import {
  createRemoteWorkspaceDisconnectedError,
  getRemoteConnectionFailureCode,
} from "@/lib/remoteWorkspaceServiceError.js";
import { buildConversationShareItems } from "@/v4/conversationShareItems.js";
import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import type { SessionCreateSource } from "@zcode/shared";
import { reportSessionCreate } from "@/lib/sessionCreateTelemetry.js";
import { getLocalTtftObserver } from "@/v4/telemetry/local-ttft/contract.js";
import { BotGroupDeliveryProvider } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- SessionPane 是单 pane 竖切的命令编排收口（订阅/发送/停止/fork/edit/retry/queue/slash 全集），与旧 ChatView 同粒度；HEAD 已超限（693 行计数），拆散命令组会打散 dispatchCommand/snapshotRef 的闭包纪律。 */
import { useOptionalProjectDirectoryActions } from "@/project-sidebar/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hand } from "lucide-react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildCustomSupplierKey,
  isHighspeedProviderId,
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import { TID_CHAT_EMPTY, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import type {
  ConversationShareAccessMode,
  GitChangeSourceId,
  HighspeedCardSnapshot,
  HighspeedPrepareTurnResult,
  GitRepositorySummary,
  ModelSelection,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationSnapshot,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionModelTransition,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import {
  PluginUiSessionProvider,
  registerPluginUiPaneSession,
  useOpenPluginUi,
} from "@/plugin-ui/index.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";
import { localizeConversationShareUrl } from "@zcode/shared";
import type {
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  ImportedConversationShare,
} from "@zcode/services";
import { useCodingPlanBillingDiscountFromService } from "@/CodingPlanBillingDiscount.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { browserGlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";
import {
  HIGHSPEED_SEND_WAIT_BUDGET_MS,
  prepareHighspeedSendContext,
  readRegularTpsWithinSendBudget,
  resolveHighspeedPrepareSelection,
  type HighspeedSendContext,
  type HighspeedTurnPreparer,
} from "@/highspeed/highspeedSend.js";
import {
  calculateHighspeedSavedDurationFromMetrics,
  readHighspeedRegularTpsFromHealth,
} from "@/highspeed/highspeedSavedTime.js";
import { buildHighspeedShareNotice } from "@/highspeed/highspeedShare.js";
import {
  findTurnHeaderBySourceCommandId,
  findUserInputBySourceCommandId,
  listHighspeedInputRows,
} from "@/highspeed/highspeedConversationRows.js";
import {
  claimHighspeedCardAutoShare,
  claimHighspeedHealthyAttempt,
  completeHighspeedTurn,
  discardHighspeedTurn,
  getHighspeedCardTps,
  getHighspeedSessionDependencies,
  hydrateHighspeedTurnsFromTranscript,
  listExpiredHighspeedCardsAwaitingTps,
  listHighspeedCardAutoShareCandidates,
  listHighspeedTurnsAwaitingMetricsPersistence,
  listPendingHighspeedTurns,
  markHighspeedCardAutoShared,
  markHighspeedTurnMetricsPersisted,
  recordHighspeedTurn,
  resolveNextHighspeedAutoShareAt,
  setHighspeedCardTps,
  subscribeHighspeedTurns,
} from "@/highspeed/highspeedTurnStore.js";
import {
  claimHighspeedCardInvalidation,
  claimHighspeedFallbackToast,
  releaseHighspeedCardInvalidation,
} from "@/highspeed/highspeedToastClaims.js";
import {
  collectHighspeedCardShareBlockers,
  listHighspeedCardsAwaitingAutoShare,
} from "@/highspeed/highspeedShareDiagnostics.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import {
  workflowSessionModelOf,
  type WorkflowRunSettingsChange,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { selectGenUiModelContext } from "@zcode/shared/gen-ui";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { prepareComposerRecentReceipt } from "@/lib/composerRecent.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  readPendingTaskDraft,
  resolveComposerScope,
  composerScopeKey,
} from "@/v4/composer/composerDraftStore.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { getProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import {
  buildDraftCreateConfigPayload,
  useDraftConfigControl,
} from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import {
  createComposerSubmissionConfig,
  type ComposerSubmissionConfig,
} from "@/v4/composer/composerSubmissionConfig.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedProductTurnIds,
  useConversationShareSelectionStore,
  type ConversationShareDisplayWarnings,
} from "@/store/conversationShareSelectionStore.js";
import {
  ConversationComposer,
  type ComposerRestoreRequest,
  type ConversationComposerSendOptions,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import {
  ConversationSharePreflightStatus,
  type ConversationSharePreflightState,
} from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationSharePopover } from "@/conversation-share-interaction/ConversationSharePopover.js";
import {
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  aggregateConversationShareBlockingIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import { createConversationSharePreflightResponseHandlers } from "@/conversation-share-interaction/conversationSharePreflightResponse.js";
import { scheduleConversationSharePreflightRequest } from "@/conversation-share-interaction/conversationSharePreflightRequest.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import {
  ensureConversationShareAttempt,
  retainConversationShareAttemptAfterFailure,
} from "@/v4/conversationShareAttempt.js";
import { resolveConversationSelectionTooltipEnabled } from "@/v4/conversationShareModePolicy.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildWorkflowRunByRunId,
  buildWorkflowSaveCandidatesByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  selectWorkflowJoinRowsInPartition,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import {
  getConversationRowsPartition,
  hasOlderRows,
  requiresAcceptedInputProjection,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
  type AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import {
  hasPluginReferenceRowsInPartition,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  useScopedConversationTelemetryForegroundEnabled,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { resolveSendAckSettlement } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionSubscriptionErrorTelemetry } from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";
import {
  parseV4VisibleSlashCommand,
  parseSelectionSideSlashCommand,
  v4QueuedCommandText,
  type V4VisibleSlashCommand,
} from "@/v4/slashCommands.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import { resolveMcpUnavailableNoticeInPartition } from "@/v4/mcpUnavailableBannerNotice.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type { ChatErrorBannerModelConfigTarget } from "@/ChatErrorBanner.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  SyncSubagentSessionTabsRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  setSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import {
  normalizeSlashCommandValue,
  shouldOfferSideSlashCommand,
  type AppSlashCommand,
} from "@/slashCommandHelpers.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export interface SessionPaneProps {
  paneId: string;
  sessionId: string | null;
  /** 低基数打开入口，由 pane 宿主提供；缺省仅用于兼容旧调用。 */
  openTrigger?: SessionOpenTrigger;
  rootSessionId?: string;
  /** subagent 右侧详情等观察视图：不显示 composer/input，也不发送行内编辑类命令。 */
  readOnly?: boolean;
  /** 工作区只读原因；普通 subagent 观察视图不传，避免误报目录失效。 */
  readOnlyReason?: string;
  /** 观察视图的显式例外：允许文件摘要恢复 workspace，但不开放会话编辑能力。 */
  allowWorkspaceFileRewind?: boolean;
  /** 框选副屏：保留普通 composer/tools，但隐藏并禁止 edit/retry/fork/goal。 */
  selectionSideChat?: boolean;
  /** 主会话划词动作只投递到 Side Pane 当前激活的辅助 child。 */
  activeSelectionSideChatSessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Prompt 模板埋点当前仅覆盖 Desktop；Web / 手机远控保留 UI 行为但不触发该事件。 */
  isDesktop?: boolean;
  compactForRemoteControl?: boolean;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession：删除当前会话后回到 draft（shell 起新草稿）。 */
  onSessionDeleted?: () => void;
  /** 隐藏副屏的 child 已不存在时，由宿主移除对应 tab。 */
  onSelectionSideChatUnavailable?: () => void;
  /**
   * Focus 层：全局快捷键（Esc stop）与 add-to-chat 事件只路由到
   * focused pane。单 pane 消费者（V4ChatPane）缺省 true。
   */
  focused?: boolean;
  /** 右侧面板关闭时，主区 focused pane 可接收对话外的 Esc。 */
  allowEscapeStopOutsidePane?: boolean;
  /**
   * pane 是否真实可见。分屏的非 focused pane 仍传 true；forceMount 的隐藏侧栏 tab 传 false。
   * 只影响 foreground UI telemetry，不影响 live subscription 或后台 /event/report。
   */
  telemetryVisible?: boolean;
  /** 关闭本窗格（仅非 primary pane 下发；关 pane ≠ 停 session）。 */
  onClosePane?: () => void;
  /** 跨 workspace pane 的归属徽标（pane workspace ≠ shell 当前 workspace 时下发）。 */
  workspaceBadge?: PaneWorkspaceBadge;
  /**
   * 草稿态 composer 上方的 contextHeader（m5：workspace 切换菜单 + Git 分支）。
   * 由 app-shell 构造下发（依赖 workspaceTabs / 远程连接回调等壳层能力）；
   * 非 primary pane 不下发（workspace 切换是壳级动作）。
   */
  draftComposerHeader?: ReactNode;
  /** 主草稿把 drop controller 提给 app shell 的标题栏；其他 pane 只在自身 surface 消费。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
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
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 通知行的产物 chip → 全尺寸查看 tab。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  /** 工具卡上的子代理药丸 → transcript tab；与详情页子代理行同一个宿主处理器。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** 工具卡上的脚本药丸 → 脚本 transcript tab；与详情页脚本行同一个宿主处理器。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

const MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS = 500;
function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // V4 snapshot 已携带安全归因；此处透传归因字段，保证错误按安全归因聚类。
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

export interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

export function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const restoresModelSelection =
    item.modelSelection !== undefined &&
    // Bug 根因：旧版本曾把单轮 Highspeed Provider 持久化进队列；撤回编辑若恢复它，
    // Composer 与下一轮 fallback 都会被污染。新队列保存普通模型，这里只兼容旧快照。
    // 旧版本的污染重发可能留下不带卡元数据的此类项，所以只按 Provider Family 判断，
    // 与 CLI 提升迁移保持一致。
    !isHighspeedProviderId(item.modelSelection.providerId);
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(restoresModelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

/**
 * Highspeed 发送起点的 pane 绑定（spec §9.2）：在触发发送的同步阶段冻结，prepare 返回时据此
 * 判断 pane 是否仍停在本轮发送所属的 Task / 草稿，决定是否在本 pane 呈现卡并登记激活。
 */
interface HighspeedPaneOrigin {
  sessionId: string | null;
  /** 发送起点时的 pane 绑定代次；草稿首发据此判断 pane 是否离开过该草稿。 */
  paneBinding: number;
  draftId: string | null;
}

interface SessionPaneLeaseBinding {
  sessionId: string | null;
  layer: object;
  lease: SessionLease | null;
}

// 原始 binding 留在独立 hook 作用域，不能让 SessionPane 的事件闭包捕获失效 owner。
export function useSessionPaneLease(sessionId: string | null, layer: object) {
  const [binding, setBinding] = useState<SessionPaneLeaseBinding>({
    sessionId,
    layer,
    lease: null,
  });
  if (binding.sessionId !== sessionId || binding.layer !== layer) {
    // Bug 根因：新 session 的首帧若读取旧 lease，稳定回调会捕获旧 snapshot/store，
    // 不同代的共享 render 闭包便会串成保留链。先收紧 owner，再让 acquire effect 接管。
    // 草稿晋升仍复用同一预热 lease；不重挂 Composer，也不提前释放原 effect 的资源。
    const promoted =
      binding.layer === layer &&
      binding.sessionId === null &&
      binding.lease?.sessionId === sessionId;
    const lease = promoted ? binding.lease : null;
    setBinding({ sessionId, layer, lease });
    return [lease, setBinding] as const;
  }
  return [binding.lease, setBinding] as const;
}

/**
 * 单 pane 竖切：订阅 → 渲染 rows → composer 发送 / stop（06-ui §SessionPane）。
 *
 * React 性能（vercel-react-best-practices）：
 * - 叶子组件（Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner）均 memo；
 * - 所有回调用 useCallback 且**不依赖高频变化的 snapshot**——snapshot/composer 文本经 ref 读取，
 *   使回调在流式增量期间保持稳定引用，避免把新函数灌进 memo 子组件触发无谓重渲染；
 * - 模型表单的本地输入 state 下沉到对应子组件，输入时不牵动整个 pane。
 */
export function SessionPane({
  paneId,
  sessionId,
  openTrigger,
  rootSessionId,
  readOnly = false,
  readOnlyReason,
  allowWorkspaceFileRewind = false,
  selectionSideChat = false,
  activeSelectionSideChatSessionId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isDesktop = false,
  compactForRemoteControl = false,
  provider,
  onSessionCreated,
  onSelectionSideChatUnavailable,
  focused = true,
  allowEscapeStopOutsidePane = false,
  telemetryVisible = true,
  onClosePane,
  workspaceBadge,
  draftComposerHeader,
  onDropTargetControllerChange,
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
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: SessionPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const remoteAvailable = useRemoteConversationAvailable();
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  } = useV4Conversation();
  const platform = useOptionalPlatform();
  const {
    conversationShareService,
    highspeedCardService,
    modelSelectionService,
    usageStatsService,
    zcodeSessionService,
    zcodeTaskService,
  } = useServices();
  const { intl, locale } = useZCodeIntl();
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const composerClientNamespace = useComposerClientNamespace();
  const composerProjectId = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  const newTaskComposerScope = useMemo(
    () => resolveComposerScope(composerProjectId, workspaceIdentity, composerClientNamespace),
    [composerProjectId, workspaceIdentity, composerClientNamespace],
  );
  const composerDraftGeneration = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  const pendingAtEntry = useMemo(() => {
    if (sessionId !== null || newTaskComposerScope.projectId !== null) return null;
    const pending = readPendingTaskDraft(newTaskComposerScope);
    return pending?.workspacePath === workspacePath && pending.commandId ? pending : null;
  }, [sessionId, workspacePath, newTaskComposerScope, composerDraftGeneration]);
  const [resolvedDraftCommand, setResolvedDraftCommand] = useState<string | null>(null);
  const recoveringDraft =
    pendingAtEntry?.commandId !== resolvedDraftCommand ? pendingAtEntry : null;
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane 已位于目标 Workspace 的 ServiceProvider 内，直接订阅该 Host Service；
  // 不再从展示组件二次解析 workspace/remote 路由。
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundEnabled = useScopedConversationTelemetryForegroundEnabled({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundOwnerRef = useRef<object>({});
  useEffect(() => {
    if (
      !conversationTelemetry ||
      !conversationTelemetryForegroundEnabled ||
      !telemetryVisible ||
      !sessionId
    ) {
      return undefined;
    }
    return conversationTelemetry.attachForeground(
      conversationTelemetryForegroundOwnerRef.current,
      sessionId,
    );
  }, [conversationTelemetry, conversationTelemetryForegroundEnabled, sessionId, telemetryVisible]);
  const [lease, setLease] = useSessionPaneLease(sessionId, layer);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // 「冻结历史 + 尾轮」分区（spec：docs/ui/chat-virtual-scroll.md「每帧派生成本」）：
  // 下面随 snapshot 每帧执行的行扫描都按 history 引用缓存历史段，只扫尾轮。
  const rowsPartition = snapshot ? getConversationRowsPartition(snapshot.rows.window) : null;
  const confirmLifecycleRecovery = useConfirmDialog();
  const taskRestart = useSessionRuntimeRestart(
    workspacePath,
    sessionId,
    remoteSessionId,
    workspaceIdentity,
  );
  const runtimeReady =
    sessionId === null ||
    (state.status === "live" &&
      state.projectionReady !== false &&
      (!state.lifecycle || state.lifecycle.state === "ready") &&
      snapshot?.sessionId === sessionId &&
      (!snapshot.runtimeInitialization || snapshot.runtimeInitialization.status === "ready"));
  const newlyCreatedSessionIdRef = useRef<string | null>(null);
  const shareDraft = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.drafts[sessionId] : undefined,
  );
  const shareDockState = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.dockStates[sessionId] : undefined,
  );
  const shareDock = shareDockState ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const shareTitle = shareDock.title ?? snapshot?.meta.title?.trim() ?? sessionId ?? "";
  const shareDisclosureAccepted = shareDock.disclosureAccepted;
  const sharePublishing = shareDock.publishing;
  const shareProgress = shareDock.progress;
  const shareCompletedArtifacts = shareDock.completedArtifacts;
  const shareTotalArtifacts = shareDock.totalArtifacts;
  const publishedShareUrl = shareDock.publishedShareUrl;
  const shareError = shareDock.error;
  const shareWarnings = shareDock.warnings;
  const shareActive = shareDraft?.open === true;
  // pending 草稿存在即处于范围编辑，避免维护第二套 stage/view 状态。
  const shareSelectionPanelVisible = shareActive && shareDraft?.pendingExcludedRowIds != null;
  const closeShare = useConversationShareSelectionStore((value) => value.closeShare);
  const updateShareDockState = useConversationShareSelectionStore((value) => value.updateDockState);
  const confirmShareSelection = useConversationShareSelectionStore(
    (value) => value.confirmSelectionEdit,
  );
  const beginShareSelection = useConversationShareSelectionStore(
    (value) => value.beginSelectionEdit,
  );
  const syncAvailableTurns = useConversationShareSelectionStore(
    (value) => value.syncAvailableTurns,
  );
  const toggleShareRow = useConversationShareSelectionStore((value) => value.togglePendingRow);
  const setAllPendingShareRows = useConversationShareSelectionStore(
    (value) => value.setAllPendingRowsSelected,
  );
  const deselectShareProductTurn = useConversationShareSelectionStore(
    (value) => value.deselectProductTurn,
  );
  const setShareAccessMode = useConversationShareSelectionStore((value) => value.setAccessMode);
  const cancelShareSelection = useConversationShareSelectionStore(
    (value) => value.cancelSelectionEdit,
  );
  const dismissShareSelectionPanel = useCallback(() => {
    if (sessionId) cancelShareSelection(sessionId);
  }, [sessionId, cancelShareSelection]);
  const pendingShareRowIds = useMemo(
    () =>
      new Set(
        (shareDraft?.availableRowIds ?? []).filter(
          (id) =>
            !(shareDraft?.pendingExcludedRowIds ?? shareDraft?.excludedRowIds ?? []).includes(id),
        ),
      ),
    [shareDraft],
  );
  const pendingShareTurnCount = useMemo(
    () =>
      new Set([...pendingShareRowIds].map((id) => shareDraft?.productTurnIdByRowId[id] ?? id)).size,
    [pendingShareRowIds, shareDraft],
  );
  const shareRenderUnits = useMemo(
    // 分享未打开时无需目录；原先每个文本 delta 都重复构建全部历史并生成分享摘要。
    () => (shareActive ? buildConversationTurnRenderUnits(snapshot?.rows.window ?? []) : null),
    [shareActive, snapshot?.rows.window],
  );
  const shareItems = useMemo(
    () =>
      shareRenderUnits
        ? buildConversationShareItems(shareRenderUnits, {
            assistantEmptyPreview: intl.formatMessage({
              id: "chat.turnNavigator.emptyAssistant",
            }),
            assistantRunningPreview: intl.formatMessage({
              id: "chat.turnNavigator.runningAssistant",
            }),
            userFallbackPreview: intl.formatMessage({
              id: "chat.turnNavigator.userFallback",
            }),
          })
        : [],
    [intl, shareRenderUnits],
  );
  const eligibleShareItems = useMemo(
    () => shareItems.filter((item) => !item.isRunning),
    [shareItems],
  );
  useEffect(() => {
    if (!sessionId || !shareActive) return;
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    syncAvailableTurns(
      sessionId,
      eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [eligibleShareItems, sessionId, shareActive, snapshot?.rows.window, syncAvailableTurns]);
  const selectedShareProductTurnIds = useMemo(
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
          )
        : [],
    [sessionId, shareDraft],
  );
  const preflightShareProductTurnIds = useMemo(
    // 选择器预检读取待确认草稿；取消后自动回到已确认范围，不提前提交选择。
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
            "pending",
          )
        : [],
    [sessionId, shareDraft],
  );
  const sharePreflightMetaRef = useRef<{
    revision: number;
    logEpoch: string;
    capabilitiesFingerprint: string;
    supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  }>({
    revision: 0,
    logEpoch: "",
    capabilitiesFingerprint: "",
    supportedArtifactTypes: [],
  });
  const [sharePreflightVersion, setSharePreflightVersion] = useState(0);
  const selectedShareTurnFingerprints = useMemo(
    () =>
      new Map(
        preflightShareProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(
            snapshot?.rows.window ?? [],
            productTurnId,
            workspacePath,
            {
              workspaceKey: workspaceIdentity?.trim() || workspacePath,
              remoteSessionId: remoteSessionId ?? "",
              sessionId: sessionId ?? "",
              revision: snapshot?.revision,
              logEpoch: snapshot?.logEpoch,
              capabilitiesFingerprint: sharePreflightMetaRef.current.capabilitiesFingerprint,
            },
          ),
        ]),
      ),
    [
      remoteSessionId,
      preflightShareProductTurnIds,
      sessionId,
      sharePreflightVersion,
      snapshot?.logEpoch,
      snapshot?.revision,
      snapshot?.rows.window,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const eligibleShareProductTurnIds = useMemo(() => {
    if (eligibleShareItems.length === 0) return [];
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    return eligibleShareItems.flatMap((item) => {
      const productTurnId = rowsById.get(item.rowId)?.productTurnId;
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
  }, [eligibleShareItems, snapshot?.rows.window]);
  const sharePreflightCacheRef = useRef(new Map<string, ConversationShareTurnPreflightResult>());
  // 传输类失败会被按 turn 缓存成阻断项，仅靠选择变化无法再次触发 RPC；
  // 重试 token 变化时清缓存并重新发起，避免一次网络抖动把用户卡死在选择阶段。
  const [sharePreflightRetryToken, setSharePreflightRetryToken] = useState(0);
  const sharePreflightScopeKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${remoteSessionId ?? ""}\u0000${sessionId ?? ""}`;
  const sharePreflightScopeKeyRef = useRef<string | null>(null);
  const sharePreflightCacheKey = useCallback(
    (productTurnId: string) =>
      conversationSharePreflightCacheKey(sharePreflightScopeKey, productTurnId),
    [sharePreflightScopeKey],
  );
  const retrySharePreflight = useCallback(() => {
    for (const productTurnId of preflightShareProductTurnIds) {
      sharePreflightCacheRef.current.delete(sharePreflightCacheKey(productTurnId));
    }
    setSharePreflightRetryToken((token) => token + 1);
    setSharePreflightVersion((version) => version + 1);
  }, [preflightShareProductTurnIds, sharePreflightCacheKey]);
  const shareHydratedSessionRef = useRef<string | null>(null);
  const sharePreflight = useMemo<ConversationSharePreflightState>(() => {
    if (!shareActive || !sessionId || compactForRemoteControl) {
      return { status: "idle" };
    }
    if (preflightShareProductTurnIds.length === 0) {
      return { status: "idle" };
    }
    const entries = preflightShareProductTurnIds.map((productTurnId) => {
      const entry = sharePreflightCacheRef.current.get(sharePreflightCacheKey(productTurnId));
      return entry?.turnFingerprint === selectedShareTurnFingerprints.get(productTurnId)
        ? entry
        : undefined;
    });
    if (entries.some((entry) => entry === undefined)) {
      return { status: "checking" };
    }
    const resolvedEntries = entries.filter(
      (entry): entry is ConversationShareTurnPreflightResult => entry !== undefined,
    );
    return {
      status: "ready",
      ...sharePreflightMetaRef.current,
      blockingIssues: aggregateConversationShareBlockingIssues(resolvedEntries),
      skippableWarnings: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.skippableWarnings),
      ),
      deferredIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.deferredIssues),
      ),
      turnResults: resolvedEntries,
    };
  }, [
    compactForRemoteControl,
    sessionId,
    preflightShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    shareActive,
    sharePreflightVersion,
  ]);

  useEffect(() => {
    if (sharePreflightScopeKeyRef.current === sharePreflightScopeKey) return;
    sharePreflightScopeKeyRef.current = sharePreflightScopeKey;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sharePreflightScopeKey]);

  useEffect(() => {
    if (shareActive && sessionId) return;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sessionId, shareActive]);

  useEffect(() => {
    // 预检结果按 turn 缓存：选择/取消只重新聚合当前选中项，只有首次加入或 turn fingerprint
    // 变化才触发 RPC；发布阶段仍走独立的权威 stat/read/SHA 校验，不能把这里的缓存当成最终事实。
    const requestScopeKey = sharePreflightScopeKey;
    if (
      !shareActive ||
      !sessionId ||
      compactForRemoteControl ||
      preflightShareProductTurnIds.length === 0
    ) {
      return undefined;
    }
    const missingProductTurnIds = getMissingConversationSharePreflightTurnIds(
      sharePreflightScopeKey,
      preflightShareProductTurnIds,
      sharePreflightCacheRef.current,
      selectedShareTurnFingerprints,
    );
    if (missingProductTurnIds.length === 0) return undefined;
    const requestRows = snapshot?.rows.window ?? [];
    return scheduleConversationSharePreflightRequest({
      request: () =>
        conversationShareService.preflight({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          selection: {
            kind: "productTurns",
            productTurnIds: missingProductTurnIds,
          },
        }),
      ...createConversationSharePreflightResponseHandlers({
        sessionId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        missingProductTurnIds,
        requestRows,
        selectedShareTurnFingerprints,
        sharePreflightCacheRef,
        sharePreflightMetaRef,
        sharePreflightCacheKey,
        isCurrent: () => shareActive && requestScopeKey === sharePreflightScopeKeyRef.current,
        onUpdated: () => setSharePreflightVersion((version) => version + 1),
      }),
    });
  }, [
    compactForRemoteControl,
    conversationShareService,
    remoteSessionId,
    preflightShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    sharePreflightRetryToken,
    sharePreflightScopeKey,
    sessionId,
    shareActive,
    snapshot?.rows.window,
    workspaceIdentity,
    workspacePath,
  ]);
  const sessionLeaseReady = lease?.sessionId === sessionId;
  const shouldMeasureExistingSessionOpen =
    sessionLeaseReady && newlyCreatedSessionIdRef.current !== sessionId;
  useSessionOpenArmsTelemetry({
    sessionId,
    snapshot,
    openTiming: sessionLeaseReady ? state.openTiming : undefined,
    rendererTiming: sessionLeaseReady ? state.rendererTiming : undefined,
    openKind: sessionLeaseReady ? lease?.openKind : undefined,
    openTrigger,
    startedAt: sessionLeaseReady ? lease?.startedAt : undefined,
    status: state.status,
    lastError: state.lastError,
    enabled: shouldMeasureExistingSessionOpen,
    readOnly,
    reporter: platform,
  });
  useEffect(() => {
    const newlyCreatedSessionId = newlyCreatedSessionIdRef.current;
    if (newlyCreatedSessionId !== null && newlyCreatedSessionId !== sessionId) {
      newlyCreatedSessionIdRef.current = null;
    }
  }, [sessionId]);
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  const handleMobilePlanInteractionAccepted = useCallback(
    (interactionId: string) => {
      if (!compactForRemoteControl || !lease) return;
      const timers = mobilePlanInteractionReconcileTimersRef.current;
      if (timers.has(interactionId)) return;
      const timer = setTimeout(() => {
        timers.delete(interactionId);
        const authoritativeSnapshot = lease.store.getState().snapshot;
        const stillPending = authoritativeSnapshot?.pendingInteractions.some(
          (interaction) => interaction.interactionId === interactionId,
        );
        if (!stillPending) return;
        // Bug 根因：手机 Plan 回执 ACK 与 replayable 清场分属两条异步路径；清场帧
        // 丢失时旧 interaction 会永久驻留。只在 grace 后仍读到权威 pending 时复用
        // 既有 same-sub recovery，不本地隐藏弹窗，也不影响 desktop continuous。
        logger.warn("[v4-pane] 手机 Plan ACK 后 pending 未收口，触发权威恢复", {
          interactionId,
          sessionId,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
        });
        lease.store.recoverFromStaleAuthority();
      }, MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS);
      timers.set(interactionId, timer);
    },
    [compactForRemoteControl, lease, sessionId, workspaceIdentity, workspacePath],
  );
  const pluginReferenceIconsEnabled =
    isSessionPluginCatalogReady(state.status, sessionId, snapshot?.sessionId) &&
    rowsPartition !== null &&
    hasPluginReferenceRowsInPartition(rowsPartition);
  // send_result 的落定信号：用户消息真正画进对话历史。z-code 没有乐观渲染，
  // 气泡必须等投影回流出 userInput row 才出现，所以 ACK accepted 不能算发送完成。
  // 取 useEffect 而非 store 订阅回调 —— effect 在 DOM commit 之后跑，此刻气泡已在屏幕上。
  useEffect(() => {
    const rows = snapshot?.rows.window;
    if (!rows || rows.length === 0) return;
    // Bug 根因：原先每个流式帧都逐行扫描全部历史；没有发送在等渲染时通知必然是空操作，直接跳过。
    if (!conversationTelemetry?.hasPendingSendRenders()) return;
    // 不能只取最后一条 userInput：后台结果行可能紧随其后插到尾部，
    // 只看尾部会漏掉用户自己那条，误判成 render_timeout。supervisor 侧按
    // 待渲染表 O(1) 过滤，历史回填 / 切会话重载推来的老 row 不会误触发。
    for (const row of rows) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        conversationTelemetry.notifyUserInputRendered(row.sourceCommandId);
      }
    }
  }, [conversationTelemetry, snapshot]);
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;
  const isMobileTextInputViewport = useIsMobileTextInputViewport();

  // 稳定回调读取的最新值经 ref 透传，避免回调依赖高频变化的 snapshot/文本。
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const sessionIdRef = useRef(sessionId);
  const [activeHighspeedCard, setActiveHighspeedCard] = useState<HighspeedCardSnapshot | null>(
    null,
  );
  const invalidateActiveHighspeedCard = useCallback(
    (cardId: string, failureKey: string) => {
      if (!claimHighspeedCardInvalidation(failureKey)) return;
      void highspeedCardService
        .invalidateCard(cardId)
        .then(() => {
          // Bug 根因：Highspeed 失败后若卡仍留在服务里，Composer 会继续显示加速态并锁死模型选择。
          // Service 按 cardId 作废唯一真相，再清同一张卡的展示投影；旧失败不能清掉后来抽中的新卡。
          setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
        })
        .catch((error) => {
          releaseHighspeedCardInvalidation(failureKey);
          logger.warn("[highspeed] 作废失败的加速卡失败", {
            cardId,
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    [highspeedCardService, sessionId],
  );
  // 激活动效的一次性请求：只由发送路径 draw 新命中登记，composer 锁定入场方式后消费。
  const [highspeedActivationCardId, setHighspeedActivationCardId] = useState<string | null>(null);
  // 本 pane 最近呈现过的卡片身份：恢复与复用同一张卡的发送据此判定不是新命中。
  const presentedHighspeedCardIdRef = useRef<string | null>(null);
  const highspeedMetricsInFlightRef = useRef(new Set<string>());
  const selectHighspeed = useShallow(getHighspeedSessionDependencies);
  const highspeedState = useSyncExternalStore(
    subscribeHighspeedTurns,
    () => selectHighspeed(sessionId),
    () => selectHighspeed(sessionId),
  );
  const [highspeedAutoShareClock, refreshHighspeedAutoShareClock] = useState(0);
  const dispatchCommandRef = useRef<
    | ((
        type: CommandType,
        payload: Record<string, unknown>,
        targetSessionId: string | null,
        baseRevision?: number,
        baseLogEpoch?: string,
      ) => Promise<CommandAck>)
    | null
  >(null);
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  sessionIdRef.current = sessionId;
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const conversationLayoutContainerRef = useRef<HTMLDivElement>(null);
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // pane 每次重新绑定 Task / 工作区时递增代次：A → B → A 后 sessionId 相同但代次不同。
  // 与 sessionIdRef 一样在渲染期同步，供跨 await 的发送回调读取最新绑定。
  const paneBindingKey = `${workspaceKey}\u0000${sessionId ?? ""}`;
  const paneBindingRef = useRef({ key: paneBindingKey, generation: 0 });
  if (paneBindingRef.current.key !== paneBindingKey) {
    paneBindingRef.current = {
      key: paneBindingKey,
      generation: paneBindingRef.current.generation + 1,
    };
  }
  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      setActiveHighspeedCard(null);
      return () => undefined;
    }
    void highspeedCardService
      .getSnapshot()
      .then((serviceSnapshot) => {
        if (disposed) return;
        const card = serviceSnapshot.card;
        const now = Date.now();
        if (!card || card.taskId !== sessionId || card.expiresAt <= now) {
          setActiveHighspeedCard(null);
          return;
        }
        presentedHighspeedCardIdRef.current = card.cardId;
        setActiveHighspeedCard(card);
      })
      .catch((error) => {
        if (disposed) return;
        setActiveHighspeedCard(null);
        logger.warn("[highspeed] 读取卡片状态失败，输入框按普通状态展示", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    return () => {
      disposed = true;
    };
  }, [highspeedCardService, sessionId]);
  useEffect(() => {
    if (!activeHighspeedCard) return;
    const cardId = activeHighspeedCard.cardId;
    const expiresAt = activeHighspeedCard.expiresAt;
    // Bug 根因：清卡曾只依赖一次性 setTimeout；窗口隐藏/息屏时页面被 Chromium 冻结、
    // 定时器停摆，唤醒后积压的 timeout 迟迟不触发，而 composer 倒计时是每秒读 Date.now()
    // 的 interval、唤醒即自愈——出现「倒计时已到 00:00:00 但输入框加速态不退出」的僵尸卡，
    // 只能等下一条消息的 prepareTurn 救活。回到窗口时按真实时钟重估：已过期立即清卡，
    // 未过期重挂剩余时长（与下方分享时钟补偿同口径，spec §9.2/§9.3）。
    const clearIfExpired = () => {
      if (Date.now() < expiresAt) return false;
      setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
      return true;
    };
    if (clearIfExpired()) return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      // Bug 根因：setTimeout 按单调时钟计时，到期判定读墙钟 Date.now()；两者的毫秒级偏差或
      // NTP 回拨会让 timer 在墙钟到期前触发。只判定不重挂时，窗口常驻前台的加速态永不退出。
      timer = window.setTimeout(() => {
        if (!clearIfExpired()) arm();
      }, expiresAt - Date.now());
    };
    arm();
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      if (!clearIfExpired()) arm();
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [activeHighspeedCard]);
  useEffect(() => {
    if (!sessionId) return;
    const nextAutoShareAt = resolveNextHighspeedAutoShareAt(sessionId);
    if (nextAutoShareAt === null) return;
    const delayMs = Math.max(0, nextAutoShareAt - Date.now()) + 20;
    // Bug 根因：旧逻辑以 Turn 完成为分享时钟，第一轮结束就发布卡片；这里改由整张卡
    // 的 expiresAt 唤醒聚合流程，卡到期时若仍有 Turn 运行，则等待其完成事件再次触发。
    const timer = window.setTimeout(
      () => refreshHighspeedAutoShareClock((revision) => revision + 1),
      delayMs,
    );
    return () => window.clearTimeout(timer);
  }, [highspeedState, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    // Bug 根因（2026-08-31）：到期唤醒依赖 renderer setTimeout；窗口隐藏/被遮挡时页面被
    // Chromium 冻结，定时器停摆，卡级 TPS 采样与完成态持久化停在原地，footer 查看按钮
    // 一直置灰，直到用户再发一条消息才被 store 版本号变化救活（违反 spec 9.3「到期边界
    // 由会话时间时钟触发重渲染，不要求用户再发送一条消息」）。回到窗口时立即补一次
    // 时钟；聚合链路各入口均有 claim/幂等保护，重复触发无副作用。
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      refreshHighspeedAutoShareClock((revision) => revision + 1);
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [refreshHighspeedAutoShareClock, sessionId]);
  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const terminalStates = new Set(["completedSuccess", "completedInterrupted", "failed"]);
    const partition = getConversationRowsPartition(snapshot.rows.window);
    // 只有带 highspeed 元数据与 sourceCommandId 的行会被 hydration 采用；历史段索引按引用缓存。
    hydrateHighspeedTurnsFromTranscript(
      sessionId,
      listHighspeedInputRows(partition).map((row) => ({
        sourceCommandId: row.sourceCommandId,
        createdAt: row.createdAt,
        highspeed: row.highspeed,
      })),
    );
    const pendingTurns = listPendingHighspeedTurns(sessionId);
    for (const record of pendingTurns) {
      const userRow = findUserInputBySourceCommandId(partition, record.sourceCommandId);
      if (userRow && !userRow.highspeed) {
        // Bug 根因：Highspeed queue 在 admission ACK 时先登记统计；若真正提升时卡已过期，
        // CLI 会移除 Highspeed intent 并走原模型。以权威 user row 撤销预登记，避免普通
        // 输出被错误计入 Highspeed 分享。
        discardHighspeedTurn(record.sourceCommandId);
        continue;
      }
      const header = findTurnHeaderBySourceCommandId(partition, record.sourceCommandId);
      // 诊断（debug，随 snapshot 高频触发）：完成态统计迟迟收不了口时，日志直接点名卡在哪。
      if (!header) {
        logger.debug("[highspeed] turn 统计未完成：rows.window 中缺少 turnHeader", {
          sourceCommandId: record.sourceCommandId,
        });
        continue;
      }
      if (!terminalStates.has(header.state) || header.outputTokens === undefined) {
        logger.debug("[highspeed] turn 统计未完成：turnHeader 非终态或无 outputTokens", {
          sourceCommandId: record.sourceCommandId,
          state: header.state,
          hasOutputTokens: header.outputTokens !== undefined,
        });
        continue;
      }
      const durationMs = Math.max(
        0,
        header.activeMs ?? (header.endedAt !== undefined ? header.endedAt - header.startedAt : 0),
      );
      completeHighspeedTurn({
        sourceCommandId: record.sourceCommandId,
        outputTokens: header.outputTokens,
        durationMs,
        ...(header.modelDurationMs !== undefined
          ? { modelDurationMs: header.modelDurationMs }
          : {}),
        ...(header.toolDurationMs !== undefined ? { toolDurationMs: header.toolDurationMs } : {}),
        ...(header.otherDurationMs !== undefined
          ? { otherDurationMs: header.otherDurationMs }
          : {}),
      });
    }

    const autoShareNow = Date.now();
    for (const card of listExpiredHighspeedCardsAwaitingTps(sessionId, autoShareNow)) {
      if (!claimHighspeedHealthyAttempt(card.cardId, card.allTurnsCompleted)) {
        // 诊断（debug）：每卡到期一次 + 完成后补查一次，机会用尽仍无 TPS 时分享链路必然停摆。
        logger.debug("[highspeed] 卡级 healthy 查询机会已用尽，仍无有效 TPS", {
          cardId: card.cardId,
          allTurnsCompleted: card.allTurnsCompleted,
        });
        continue;
      }
      void highspeedCardService
        .healthy(card.cardId)
        .then((usage) => {
          if (usage.completionTokens <= 0 || usage.durationSeconds <= 0) {
            logger.warn("[highspeed] 卡级 healthy 未返回有效 TPS，本轮完成后再补查", {
              cardId: card.cardId,
              completionTokens: usage.completionTokens,
              durationSeconds: usage.durationSeconds,
            });
            return;
          }
          setHighspeedCardTps(card.cardId, usage.completionTokens / usage.durationSeconds);
        })
        .catch((error) => {
          logger.warn("[highspeed] 卡级 healthy 查询失败，本轮完成后再补查", {
            cardId: card.cardId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const dispatch = dispatchCommandRef.current;
    if (dispatch) {
      for (const record of listHighspeedTurnsAwaitingMetricsPersistence(sessionId)) {
        if (!record.metrics || highspeedMetricsInFlightRef.current.has(record.sourceCommandId)) {
          continue;
        }
        const userRow = findUserInputBySourceCommandId(partition, record.sourceCommandId);
        const regularTps = record.card.regularTps ?? userRow?.highspeed?.regularTps;
        const highspeedTps = getHighspeedCardTps(record.card.cardId);
        // 诊断（debug）：持久化前置条件缺失会让该轮永远停在等待队列里，静默跳过无法定位。
        if (!userRow || !userRow.entityId || !regularTps || !highspeedTps) {
          logger.debug("[highspeed] 完成态持久化前置缺失，本轮暂不派发", {
            sourceCommandId: record.sourceCommandId,
            userRowInWindow: userRow !== undefined && userRow !== null,
            hasEntityId: Boolean(userRow?.entityId),
            hasRegularTps: Boolean(regularTps),
            hasCardTps: Boolean(highspeedTps),
          });
          continue;
        }
        const savedDurationMs = calculateHighspeedSavedDurationFromMetrics(
          record.metrics,
          regularTps,
          highspeedTps,
        );
        highspeedMetricsInFlightRef.current.add(record.sourceCommandId);
        let metricsPersisted = false;
        void dispatch(
          "setHighspeedMetrics",
          {
            target: { rowId: userRow.rowId, entityId: userRow.entityId },
            regularTps,
            outputTokens: record.metrics.outputTokens,
            durationMs: record.metrics.durationMs,
            highspeedTps,
            savedDurationMs,
            ...(record.metrics.modelDurationMs !== undefined
              ? { modelDurationMs: record.metrics.modelDurationMs }
              : {}),
            ...(record.metrics.toolDurationMs !== undefined
              ? { toolDurationMs: record.metrics.toolDurationMs }
              : {}),
            ...(record.metrics.otherDurationMs !== undefined
              ? { otherDurationMs: record.metrics.otherDurationMs }
              : {}),
          },
          sessionId,
          snapshot.revision,
          snapshot.logEpoch,
        )
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "duplicate") {
              logger.warn("[highspeed] 完成态统计持久化被拒绝", {
                reasonCode: ack.reasonCode,
                sourceCommandId: record.sourceCommandId,
                status: ack.status,
              });
              return;
            }
            markHighspeedTurnMetricsPersisted(record.sourceCommandId, savedDurationMs);
            metricsPersisted = true;
          })
          .catch((error) => {
            logger.warn("[highspeed] 完成态统计持久化失败", {
              error: error instanceof Error ? error.message : String(error),
              sourceCommandId: record.sourceCommandId,
            });
          })
          .finally(() => {
            highspeedMetricsInFlightRef.current.delete(record.sourceCommandId);
            // Bug 根因：持久化 ACK 触发的 store 更新可能先于 in-flight 清理被 React 消费，
            // 导致本轮重算被跳过；ACK 成功后显式唤醒一次，避免必须发送下一条 prompt。
            if (metricsPersisted) {
              refreshHighspeedAutoShareClock((revision) => revision + 1);
            }
          });
      }
    }

    for (const candidate of listHighspeedCardAutoShareCandidates(sessionId)) {
      if (candidate.expiresAt > autoShareNow) continue;
      // Bug 根因：失败后只清理 in-flight 会让后续 snapshot 重复触发自动分享，最终打到 429。
      if (!claimHighspeedCardAutoShare(candidate.cardId, autoShareNow)) continue;
      // 分享卡片改为客户端生成，不再请求后端 share 接口；到期后直接把本地统计发布到左下角。
      browserGlobalNoticeStore?.publish(
        buildHighspeedShareNotice({ cardId: candidate.cardId, metrics: candidate.metrics }),
      );
      markHighspeedCardAutoShared(candidate.cardId);
    }

    // 诊断（debug，随 snapshot 高频触发）：卡已到期、从未尝试分享、但也没进候选时，
    // 直接输出阻塞原因。2026-08-31 左下角分享卡停留在旧卡 36 分钟无任何日志可查，
    // 根因就是这些门禁此前全部静默跳过。
    for (const cardId of listHighspeedCardsAwaitingAutoShare(sessionId, autoShareNow)) {
      const blockers = collectHighspeedCardShareBlockers(cardId);
      if (blockers.length > 0) {
        logger.debug("[highspeed] 卡已到期但未进入自动分享，阻塞原因", {
          cardId,
          blockers,
        });
      }
    }
  }, [highspeedAutoShareClock, highspeedCardService, highspeedState, sessionId, snapshot]);
  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Bug 原因：V4 session 配置只存在 ConversationSnapshot，legacy task 配置桶一直为空；
    // 用户从 custom model 会话新建任务时，startDraft 只能继承 workspace 默认模型。
    // 这里仅把权威配置叠到完整目录并按 task 缓存，不改变 session 或 workspace 事实源。
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // 防止切换 workspace/session/logEpoch 后沿用旧 key；key 本身已隔离，清理仅是
    // 生命周期边界，避免长时间 workbench 中 Set 随会话数增长。
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  const timelineBottomRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).timelineBottomRequest,
  );
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // 软审核不是阻塞交互，不能隐藏 Composer 或禁用选区引用。
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  const panePresentation = useConversationPanePresentation();
  const isFloatingPresentation = panePresentation.presentation === "floating";
  const isRunning = Boolean(snapshot?.control.canStop);
  const { reportFloatingStatus } = panePresentation;
  const floatingOwnerKey = sessionId ?? "__draft__";
  // 浮窗形态下由时间线上报最后一个回合（同一个 render unit 的运行状态、时长与最终回答）；
  // 记录带上 owner，切换会话后旧会话的摘要不会混进新会话。
  const [floatingLatestTurn, setFloatingLatestTurn] = useState<{
    ownerKey: string;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  const handleFloatingLatestTurnSummaryChange = useCallback(
    (summary: ConversationLatestTurnSummary) =>
      setFloatingLatestTurn({ ownerKey: floatingOwnerKey, summary }),
    [floatingOwnerKey],
  );
  const floatingLatestTurnSummary =
    isFloatingPresentation && floatingLatestTurn?.ownerKey === floatingOwnerKey
      ? floatingLatestTurn.summary
      : null;
  const floatingTurnKey = floatingLatestTurnSummary?.turnKey ?? null;
  const floatingTurnRunning = floatingLatestTurnSummary?.running ?? false;
  const floatingTurnAnswer = floatingLatestTurnSummary?.answer ?? null;
  const hasFloatingLatestTurn = floatingLatestTurnSummary !== null;
  useEffect(() => {
    // 完整视图浮窗只展示焦点 pane 的状态；docked 时 reportFloatingStatus 为 noop。
    if (!focused) return;
    reportFloatingStatus({
      running: isRunning,
      blockingInteractionId,
      ownerKey: floatingOwnerKey,
      latestTurn: hasFloatingLatestTurn
        ? { turnKey: floatingTurnKey, running: floatingTurnRunning, answer: floatingTurnAnswer }
        : null,
    });
  }, [
    blockingInteractionId,
    floatingOwnerKey,
    floatingTurnAnswer,
    floatingTurnKey,
    floatingTurnRunning,
    focused,
    hasFloatingLatestTurn,
    isRunning,
    reportFloatingStatus,
  ]);
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  const {
    agentStartupAllowed: providerAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  // 冷恢复可能先连上远端、后恢复项目归属；此时预热会发出缺 projectId 的创建并反复失败。
  // 直接使用草稿 owner 的归属作为创建前置，选择项目后自然恢复；正式会话和本地未归类不受限。
  const draftProjectReady =
    sessionId !== null ||
    !isRemoteWorkspaceIdentity(workspaceIdentity ?? "") ||
    Boolean(composerProjectId);
  const draftAgentStartupAllowed =
    providerAgentStartupAllowed && remoteAvailable && draftProjectReady;

  // Composer 保存下一次 Submission 的 renderer intent；prewarm session 仅承载草稿预热。
  const {
    composerDraft,
    composerDraftScopeToken,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    observeDraftPermissionGrant,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    stageComposerContent,
    captureComposerContentLifecycleCommit,
    captureComposerSubmissionDraftTransaction,
    updateComposerContent,
    persistComposerContent,
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig: runtimeReady && snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: draftAgentStartupAllowed,
    modelSelectionService,
  });
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      snapshot.control.phase !== "error" ||
      !snapshot.control.lastError ||
      activeHighspeedCard?.taskId !== sessionId
    ) {
      return;
    }
    const lastError = snapshot.control.lastError;
    const attribution = lastError.attribution;
    if (attribution?.highspeedCardId !== undefined) {
      // 新 Agent 用 string/null 明确表达本轮是否使用 Highspeed，并在创建期或请求期失败命中退回声明、
      // 却没有任何退回目标可创建时发布 highspeedFallbackUnavailable（spec §2.2 失败即退卡）。
      // Bug 根因：这里曾只认 provider_not_found / model_not_found 两个目录错误码。请求期 3402 或网络
      // 失败无处可退时没有 fallback 事件，TurnError 的 code 是 provider 错误码 "3402"，白名单漏掉它，
      // 卡一直锁住模型选择器、下一轮继续复用已失效的卡。退卡只看 Core 发布的结构化事实，不再按错误码
      // 推断：超窗、本地 runtime 失败等不参与退回的错误不带该字段，不会误作废卡。
      if (
        attribution.highspeedCardId !== activeHighspeedCard.cardId ||
        attribution.highspeedFallbackUnavailable !== true
      ) {
        return;
      }
    } else if (
      !["provider_not_found", "model_not_found"].includes(lastError.code) ||
      lastError.at < activeHighspeedCard.issuedAt
    ) {
      // 兼容旧 Agent（无 highspeedCardId 字段）：只接受模型目录错误作为恢复边界，避免工具或本地运行时
      // 错误误作废卡；错误终态在下一轮开始前一直留在投影里，而抽卡发生在发送之前，时间下界保证上一轮的
      // 目录错误不清掉刚抽到的新卡（claim key 含新 cardId，去重防不住）。
      return;
    }
    // 仍由 Service owner 按 cardId 作废，保留 nextDrawAt 冷却。
    invalidateActiveHighspeedCard(
      activeHighspeedCard.cardId,
      `turn-error:${sessionId}:${lastError.at}:${activeHighspeedCard.cardId}`,
    );
  }, [activeHighspeedCard, invalidateActiveHighspeedCard, sessionId, snapshot]);

  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const now = Date.now();
    // 只有带 highspeed 元数据与 sourceCommandId 的 userInput 才可能有 fallbackAt；历史段按引用缓存。
    for (const row of listHighspeedInputRows(getConversationRowsPartition(snapshot.rows.window))) {
      if (row.highspeed.fallbackAt === undefined) continue;
      const sourceCommandId = row.sourceCommandId;
      if (
        !compactForRemoteControl &&
        activeHighspeedCard?.taskId === sessionId &&
        activeHighspeedCard.cardId === row.highspeed.cardId
      ) {
        // Bug 根因：历史 fallback 行曾无条件作废“当前卡”，旧卡事件会误清新卡，手机端还会调用
        // 未开放的写 RPC。权益写操作只接受 Service 当前卡的精确身份；Toast 仍独立展示历史事实。
        invalidateActiveHighspeedCard(
          row.highspeed.cardId,
          `fallback:${sourceCommandId}:${row.highspeed.cardId}`,
        );
      }
      if (
        focused &&
        now - row.highspeed.fallbackAt >= -5_000 &&
        now - row.highspeed.fallbackAt <= 15_000 &&
        claimHighspeedFallbackToast(sourceCommandId)
      ) {
        // 卡过期与加速服务不可用分别提示；旧数据没有 fallbackReason，按卡过期文案处理。
        toast(
          intl.formatMessage({
            id:
              row.highspeed.fallbackReason === "highspeed_card_expired" ||
              row.highspeed.fallbackReason === undefined
                ? "chat.highspeed.cardExpiredFallback"
                : "chat.highspeed.requestFailedFallback",
          }),
        );
      }
    }
  }, [
    activeHighspeedCard,
    compactForRemoteControl,
    focused,
    intl,
    invalidateActiveHighspeedCard,
    sessionId,
    snapshot,
  ]);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // selection 重读不代表 Provider 目录失效。历史名称沿用 hook 保留的同 Host 目录，
  // 避免先回退内部 ID 再跳回名称；提交配置仍只使用 ready 的完整 View。
  const modelSelectionDisplayView =
    modelSelectionView ??
    (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // Bug 原因：冷启动时普通 Provider 会先让草稿预热，Account Overlay 随后才进入
    // Selection View。旧预热会话冻结了早期 fallback，即使最新 View 已包含当前账号连接，
    // Renderer 也会永久停在旧模型。未发送且无显式选择的草稿不是执行事实；View 更新时
    // 回收并按最新选择事实重建，已显式选择和正式会话仍保持冻结。
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const createSubmissionFromComposer = useCallback(
    () => createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView),
    [draftConfigRef, modelSelectionView],
  );
  const composerSubmissionReady = useMemo(
    () => createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null,
    [draftConfig, modelSelectionView],
  );
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const billingDiscount = useCodingPlanBillingDiscountFromService(
    baseWorkspaceServices.codingPlanSubscriptionService,
  );
  const projectDirectory = useOptionalProjectDirectoryActions();
  const commitCreatedTask = projectDirectory?.commitCreatedTask;
  const refreshTaskGroups = projectDirectory?.refreshTaskGroups;
  const draftNavigation = useMemo(
    () => ({ controller: new AbortController() }),
    [workspaceKey, sessionId],
  );
  useEffect(() => {
    // StrictMode 会重放 effect；旧 scope 的请求仍使用各自的取消信号。
    draftNavigation.controller = new AbortController();
    return () => draftNavigation.controller.abort();
  }, [draftNavigation]);
  // 首发 commandId 在 accepted 时已存在，也是 completion 的 message_id；不必等回复完成。
  const reportDraftCreated = useCallback(
    (createdSessionId: string, source: SessionCreateSource, messageId: string) => {
      void reportSessionCreate(platform, {
        sessionId: createdSessionId,
        messageId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        source,
        clientKind: isDesktop ? "desktop" : compactForRemoteControl ? "mobile" : "web",
      });
    },
    [
      platform,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
    ],
  );
  const handleDraftSessionCreated = useCallback(
    async (
      createdSessionId: string,
      createSource?: SessionCreateSource,
      messageId?: string,
      taskGroupId?: string | null,
    ) => {
      if (messageId) reportDraftCreated(createdSessionId, createSource ?? "session", messageId);
      const commit = () => {
        // 旧首发接纳不能抢回已经切走的页面；导航与草稿交接共用 owner 的代际判断。
        if (!promoteComposerDraft(createdSessionId)) return;
        // Bug 根因：Session 打开埋点只衡量已有 Session，但草稿首发过去会把新建/预热提升的
        // sessionId 直接交给同一 hook。预热 lease 还保留草稿期的 startedAt 与空 snapshot timing，
        // 因而把数小时闲置时间误记为 total/react。创建边界先标记本 pane 的首次绑定；离开后
        // 再次显式打开同一 Session 时标记会清除，恢复正常的已有 Session 打开测量。
        newlyCreatedSessionIdRef.current = createdSessionId;
        onSessionCreated?.(createdSessionId);
      };
      const organize =
        taskGroupId !== undefined
          ? async () => {
              const task = {
                taskId: createdSessionId,
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                hostId: remoteHostIdFromWorkspaceIdentity(workspaceIdentity ?? "") ?? "local",
              };
              const attempt = async () => {
                try {
                  if (!baseWorkspaceServices.taskGroupService)
                    throw new Error("task-group.service-unavailable");
                  await baseWorkspaceServices.taskGroupService.admit({
                    tasks: [task],
                    placement: {
                      task,
                      groupId: taskGroupId,
                      creationId: messageId ?? createdSessionId,
                    },
                  });
                  // 分组结构是独立投影；重读迟滞不能延长已接受首发或组织写入的完成时间。
                  void refreshTaskGroups?.();
                } catch (cause) {
                  // 会话已创建；组织失败不能向发送层抛错，否则会诱导用户再发一次。
                  // 重试闭包只持有这次创建的地址和 placement，绝不调用 createSession。
                  logger.error("[task-groups] 新任务归属提交失败", cause);
                  toast(intl.formatMessage({ id: "taskGroup.failed" }), {
                    durationMs: 0,
                    actionLabel: intl.formatMessage({ id: "taskGroup.retryPlacement" }),
                    onAction: () => void attempt(),
                    dedupeKey: `task-group:${createdSessionId}`,
                  });
                }
              };
              await attempt();
            }
          : undefined;
      if (commitCreatedTask) {
        await commitCreatedTask(
          { taskId: createdSessionId, workspacePath, workspaceIdentity },
          commit,
          draftNavigation.controller.signal,
          organize,
        );
      } else {
        void organize?.();
        commit();
      }
    },
    [
      commitCreatedTask,
      baseWorkspaceServices.taskGroupService,
      refreshTaskGroups,
      intl,
      draftNavigation,
      reportDraftCreated,
      onSessionCreated,
      promoteComposerDraft,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const { settings: sharedSettings } = useSettings();
  const readPlanIdentitySnapshot = usePlanIdentitySnapshot(
    sharedSettings?.providerFamilyDomain,
    sharedSettings?.providerFamilyDomain
      ? sharedSettings.providerFamilyConnectionSelections?.[sharedSettings.providerFamilyDomain]
      : undefined,
    baseWorkspaceServices.usageStatsService,
  );
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const messageStreamShowReasoning = sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = sharedSettings?.toolGroupingChangesEnabled ?? false;
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // 注入模式对齐 PermissionDialog：theme/codePreviewSettings 在宿主取 store，
  // 经稳定引用的 rowContext 下发给 memo 行组件（MessageResponse/ToolCallBlocks）。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // Tier 1 fork 跳转：点 child 会话的 forkNotice → 把当前 pane 原地切到父会话，复用 fork
  // 落地同款 onSessionCreated（primary→setActiveTaskId、分屏→bindPaneSession）。rowId 预留
  // Tier 2 精确滚动——当前 forkNotice.parentRowId 恒为 0 占位，此处忽略。
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      telemetrySeed?: ConversationPromptTelemetrySeed,
      highspeedCard?: HighspeedCardSnapshot,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      creationProjectId?: string | null,
      sessionCreateSource?: SessionCreateSource,
      recentSubmissionOverride?: ComposerSubmissionConfig | null,
      creationTaskGroupId?: string | null,
      submittedDraftText?: string,
    ): Promise<CommandAck> => {
      // 离线点击/快捷键不得进入 accepted 命令恢复账本，更不能在重连后自动发送。
      if (!remoteAvailable) throw createRemoteWorkspaceDisconnectedError();
      const submission = submissionConfigFromCommand(type, payload);
      // 加速轮 payload 的 modelSelection 会被执行材料覆盖为隐藏加速 Provider；Recent 记录的是
      // 用户在 Composer 的原始选择（新任务草稿的模型种子），加速轮必须由调用方传入发送前
      // 冻结的 submission（spec §5.1）。接纳写入另有加速身份兜底拦截。
      const recentSubmission = recentSubmissionOverride ?? submission;
      // 发送时固定组织归属；同 cwd 可属于多个项目，切页和迟到 ACK 不得改写目标。
      let recentScope =
        creationProjectId === undefined
          ? newTaskComposerScope
          : { ...newTaskComposerScope, projectId: creationProjectId };
      // 在异步查询归属前冻结选择与发起顺序，避免慢查询把早发命令排成最新。
      const recentReceipt = recentSubmission
        ? prepareComposerRecentReceipt(recentScope, recentSubmission)
        : undefined;
      if (recentSubmission && sessionId && targetSessionId) {
        const projectService = baseWorkspaceServices.projectService;
        if (!projectService) throw new Error("project.service-unavailable");
        const directories = await projectService.resolveSessionDirectories(
          {
            workspacePath,
            workspaceIdentity,
            // 辅助 child 不进主任务索引；Recent 查所属主会话，输入仍发给 child。
            // 普通会话和 fork 即使带 rootSessionId 也必须保留自身项目归属。
            taskId:
              selectionSideChat && targetSessionId === sessionId && rootSessionId
                ? rootSessionId
                : targetSessionId,
          },
          recentScope.hostId,
        );
        recentScope = { ...recentScope, projectId: directories.projectId };
      }
      if (recentReceipt) recentReceipt.scope = recentScope;
      const pendingDraft =
        sessionId === null && recentScope.projectId === null
          ? readPendingTaskDraft(recentScope)
          : null;
      const acceptSelection =
        submission && (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      onEnvelopeCreated?.(envelope);
      const projectId =
        type === "createSession"
          ? creationProjectId !== undefined
            ? creationProjectId
            : useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                .draftProjectId
          : undefined;
      // 必须早于第一次上行：transport error/renderer refresh 后仍有可查询线索。
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(projectId !== undefined ? { projectId } : {}),
              ...(recentReceipt
                ? {
                    composer: {
                      ...recentReceipt,
                      submittedText: submittedDraftText,
                      ...(pendingDraft?.workspacePath === workspacePath
                        ? { draftId: pendingDraft.draftId }
                        : {}),
                    },
                  }
                : {}),
              taskGroupId:
                creationTaskGroupId !== undefined
                  ? creationTaskGroupId
                  : useZCodeSessionStore
                      .getState()
                      .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
              sessionCreateSource:
                sessionCreateSource ??
                useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftCreateSource,
            }
          : recentReceipt
            ? {
                workspace: { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) },
                ...(sessionId === null
                  ? {
                      projectId: recentScope.projectId,
                      taskGroupId:
                        creationTaskGroupId ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
                      sessionCreateSource:
                        sessionCreateSource ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource,
                    }
                  : {}),
                composer: {
                  ...recentReceipt,
                  submittedText: submittedDraftText,
                  ...(pendingDraft?.workspacePath === workspacePath
                    ? { draftId: pendingDraft.draftId }
                    : {}),
                },
              }
            : undefined,
      );
      // 首发等待预热时，闭包里的页面 lease 可能仍为空；按命令目标取得同一个投影 owner，
      // 避免漏记待投影输入造成 placeholder 闪回，也避免切页后把命令状态写进另一会话。
      const commandLease =
        targetSessionId && type !== "createSession" ? layer.acquire(targetSessionId) : null;
      try {
        if (commandLease) {
          commandLease.store.markCommandPending({
            commandId: envelope.commandId,
            type: envelope.type,
            issuedAt: envelope.issuedAt,
          });
        }
        let ack: CommandAck;
        try {
          if (telemetrySeed?.localTtft && !workspaceIdentity?.trim()) {
            envelope.ttft = getLocalTtftObserver()?.dispatch(
              telemetrySeed.localTtft,
              workspacePath,
              envelope.commandId,
              targetSessionId,
            );
          }
          ack =
            projectId !== undefined
              ? await sendCommand(envelope, { projectId })
              : await sendCommand(envelope);
          if (telemetrySeed?.localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
            getLocalTtftObserver()?.confirmationRetry(telemetrySeed.localTtft);
          else if (telemetrySeed?.localTtft)
            getLocalTtftObserver()?.ack(telemetrySeed.localTtft, ack.status, ack.ttftExcluded);
        } catch (error) {
          if (telemetrySeed?.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
          if (commandLease) {
            commandLease.store.settleCommand(envelope.commandId);
          }
          if (isProviderNotReadyError(error)) {
            // provider_not_ready 在 Host getClient 前确定性拒绝，CLI 不可能已经
            // admission。unknown 查询只保留待确认状态，因此必须在此明确清除被拒绝的记录。
            pendingCommandRegistry.rejectCommand(envelope.sessionId, envelope.commandId);
          }
          recordV4CommandAck({
            type,
            status: "transport-error",
            reasonCode: String(error),
            at: Date.now(),
          });
          // 发送漏斗落定：telemetrySeed 只有真实用户发送才携带，两步式 createSession
          // 与后台任务无 seed，天然不会伪造 send_result。
          if (telemetrySeed) {
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: targetSessionId,
              commandId: envelope.commandId,
              status: "fail",
              reasonCode: isProviderNotReadyError(error) ? "provider_not_ready" : "transport_error",
            });
          }
          throw error;
        }
        pendingCommandRegistry.applyAck(envelope, ack);
        if (ack.status === "accepted") {
          acceptSelection?.();
        }
        if (
          commandLease &&
          requiresAcceptedInputProjection(type) &&
          (ack.status === "accepted" || ack.status === "duplicate")
        ) {
          // Bug 根因：editUserQuery 会先发布 branch cut；若 replacement user row 的 topic
          // 投影静默，UI 只剩截断结果。ACK 后必须和 sendText 一样等待权威输入投影；
          // watchdog 只重订阅，不伪造消息、不恢复旧分支，也不重放命令。
          commandLease.store.expectAcceptedInputProjection(envelope.commandId);
        }
        if (ack.status === "accepted" && telemetrySeed) {
          const acceptedSessionId =
            ack.result?.type === "createSelectionSideSession"
              ? ack.result.sessionId
              : (targetSessionId ??
                (ack.result?.type === "createSession" ? ack.result.sessionId : null));
          if (acceptedSessionId) {
            conversationTelemetry?.acceptPromptSeed({
              ...telemetrySeed,
              sessionId: acceptedSessionId,
              sourceCommandId: envelope.commandId,
              memoryEnabled: ack.memoryEnabled,
            });
          }
        }
        if (ack.status === "accepted" && highspeedCard && targetSessionId) {
          recordHighspeedTurn({
            sessionId: targetSessionId,
            sourceCommandId: envelope.commandId,
            card: highspeedCard,
            createdAt: Date.now(),
          });
        }
        if (telemetrySeed) {
          // 队列二次确认的 ACK 返回 null（非终态），落定会让 first-wins 吃掉真实结果。
          const outcome = resolveSendAckSettlement(ack);
          if (outcome) {
            const settledSessionId =
              ack.result?.type === "createSelectionSideSession"
                ? ack.result.sessionId
                : (targetSessionId ??
                  (ack.result?.type === "createSession" ? ack.result.sessionId : null));
            if (outcome.kind === "awaitRender") {
              // ACK 只代表 Host 收下了命令，用户气泡此刻还没画出来；
              // 等投影回流出 userInput row（或 30s 超时）再落定端到端耗时。
              conversationTelemetry?.awaitSendRender({
                seed: telemetrySeed,
                sessionId: settledSessionId,
                commandId: envelope.commandId,
                ackStatus: outcome.ackStatus,
              });
            } else {
              conversationTelemetry?.settleSendResult({
                seed: telemetrySeed,
                sessionId: settledSessionId,
                commandId: envelope.commandId,
                status: outcome.status,
                ackStatus: outcome.ackStatus,
                reasonCode: outcome.reasonCode,
              });
            }
          }
        }
        // 生产构建 renderer 日志关闭，ack 摘要写入有界调试缓冲供 e2e/现场 probe。
        recordV4CommandAck({
          type,
          status: ack.status,
          ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
          revisionAtDecision: ack.revisionAtDecision,
          at: Date.now(),
        });
        if (shouldResyncForStaleAuthority(ack)) {
          // epoch/entity authority 已变化时只清 optimistic overlay 仍会继续拿旧
          // target 发命令；统一 same-sub recovery 后才能基于同代 rowId/entityId 再裁决。
          commandLease?.store?.recoverFromStaleAuthority();
        }
        // rejected/stale/failed 时若不 settle，optimistic overlay 会永久残留。
        if (commandLease && ack.status !== "accepted" && ack.status !== "duplicate") {
          commandLease.store.settleCommand(envelope.commandId);
        }
        return ack;
      } finally {
        commandLease?.release();
      }
    },
    [
      captureAcceptedModelSelection,
      newTaskComposerScope,
      baseWorkspaceServices.projectService,
      conversationTelemetry,
      layer,
      provider,
      sendCommand,
      remoteAvailable,
      rootSessionId,
      selectionSideChat,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  dispatchCommandRef.current = dispatchCommand;

  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // rewind 会在同一 logEpoch、row/entity 下把 active 切为 reverted；
        // 终态缓存必须带上这个语义版本，不能继续复用撤销前的完整 diff。
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // 虚拟行卸载会丢失行内 state，复挂载后预览卡片会重复拉取包含完整
      // patch 的 fileChanges；缓存必须放在 SessionPane，才能与文件变更面板共享同一请求。
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // 运行中成功结果仍可能只是当前 revision 的局部 diff；只共享
          // in-flight Promise，settled 后删除，避免最终卡片复用早期结果。
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // 失败不能污染后续重试；仅删除当前 Promise，避免旧请求误删同 key 的新请求。
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      if (compactForRemoteControl) return;
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [
      compactForRemoteControl,
      onOpenSubagentDirectory,
      remoteSessionId,
      rootSessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 与 plan-detail 完全同构：卡片只发意图（runId + toolCallId + 展示名），
  // 会话与 workspace 身份一律由宿主（这里）补齐，卡片不感知 scope。
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 药丸 → 子代理 transcript：与 plan-detail / workflow-run 同构，卡片只交出实例身份，scope 在这里补。
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 脚本药丸同构：卡片交出 run + 发起行 + 阶段，scope 在这里补。
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 产物 chip 与 run 详情同构：卡片/通知行只发意图，scope 由这里补齐。
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 工具卡 → workflow run 的关联表。权威来源是 workflowRuns 投影里每条 run 的 toolCallId
  // （schema 注释就写着它是「工具卡 → 详情页的关联键」）；工具行自己的 output 在 v4 下
  // 只剩 formatCreateWorkflowModelContent 挑出的那句散文，结构化字段拿不到。
  //
  // 值不只是 runId：run 态的卡片本身要渲染状态词与步数，所以联接一次就把摘要算完
  // （计数规则见 buildWorkflowRunByToolCallId，它的单测穷举 settled / observed 语义）。
  // 重启后投影不再为空：CLI 冷物化把 journal 回放进同一个 reducer，
  // 卡片 join 只读投影，不再合并发现查询。发现查询在这里只剩一个用途——
  //
  // `limit` 与 `refreshKey` 服务的是任务列表那条「已结束的工作流 · N」页脚行：
  // - 深度取 run 目录页的同一个常量，否则页脚行的计数与页面上的行会是两套口径；
  // - 触发器取**同一个派生函数**（run 数 + 已结算数），所以页脚行与它开出来的目录页新鲜度一致；
  //   接投影的 `revision` 则会把一次分页读变成一条跟着节点事件走的流。
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Bug 根因（2026-08-24 实测）：嵌套只读 transcript（dwf actor / subagent）也是 SessionPane，
    // 无差别发这条查询等于拿子会话 id 去问一条按**父会话**建键的 journal；CLI 的冷会话前置
    // 随即为正在运行的 detached actor 会话物化第二个 runtime（幽灵），双写事件日志，
    // 直播冻结在「已工作 xx 秒」。只读 pane 也不消费 join 回退与任务列表页脚，直接关掉。
    enabled: !readOnly && runtimeReady,
    live: state.status === "live" && runtimeReady,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // runId 键的同源表：ResumeWorkflowRun 工具行的联接入口（display 带 runId，投影的
  // toolCallId 跨 resume 沿用原始 CreateWorkflow 行，resume 行按 toolCallId 查不到）。
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 发起 toolCallId → 静态图：图是 run 的属性，
  // 三种来源的轮尾 run 卡都到这一张表取图。行窗口一遍建成，随窗口重建。
  const selectWorkflowRows = useShallow(selectWorkflowJoinRowsInPartition);
  const workflowRows = selectWorkflowRows(rowsPartition);
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(workflowRows),
    [workflowRows],
  );
  // runId → 最新补全的有效脚本图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：补全之后
  // run 卡与侧板取它。行窗口一遍建成，随窗口重建。
  const workflowFillGraphByRunId = useMemo(
    () => buildWorkflowFillGraphByRunId(workflowRows),
    [workflowRows],
  );
  // 工作流工具行 → 草稿位置：稿号与
  // 「后面还有更新的一稿」都只能从行序读出，行窗口一遍建成，随窗口重建。
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(workflowRows),
    [workflowRows],
  );
  // runId → 转写里认领过它的 SaveWorkflow 候选（docs/dynamic-workflow/transcript-and-notifications.md
  // 「Which workflow a run is saved as」规则 1）。行窗口一遍建成，随窗口重建。
  const workflowSaveCandidatesByRunId = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(workflowRows),
    [workflowRows],
  );
  // Workflow 通知 manifest 的升级条目 Waiting→Answered 联查表（runId → 停驻 qid 集合）。
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 详情页入口（面板 Workflows 分区的行）。行只把「打开哪个 run」交出来（runId + toolCallId），
  // 会话与 workspace 身份照旧由这里补齐——与工具卡走的是同一个 handler，不存在第二条打开路径。
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // run 目录页的入口（同一条页脚行）。同样只补 scope，不在这里多造一条打开路径。
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // 多开后 tab id 包含 child，旧单例实现依靠新 child 覆盖同一个父 tab
            // 来移除失效项已不成立。这里显式携带 replacesChildSessionId，让宿主原子删旧开新。
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        logger.warn("[v4-pane] 创建框选副屏会话失败", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, telemetrySeed?: ConversationPromptTelemetrySeed): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      const inherited = resolveSelectionSideInheritedModel(
        snapshotRef.current?.config,
        modelSelectionView,
      );
      const chosen = inherited ? await recommendStartPlan(inherited) : undefined;
      if (chosen === null) return false;
      const modelSelection = chosen && chosen !== inherited ? chosen : undefined;
      // 参数命令每次都是新 child；同一条文本在 ACK 未回时重试仍复用 pending，
      // 不同文本则不能与 bare `/side` 或另一条 prompt 合并。
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text, ...(modelSelection ? { modelSelection } : {}) } },
          sessionId,
          undefined,
          undefined,
          telemetrySeed,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      modelSelectionView,
      recommendStartPlan,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      isMobileTextInputViewport ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // Side Pane 固定入口没有会话 Provider；这里只注册主 pane 已有的命令编排能力。
    // 父会话即使处于 Permission/AskUser 等阻塞态也保持注册，直接入口仍可创建/激活副屏。
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // 合并时曾丢弃 reference，导致 Markdown 入口只建空白副屏；复用现有引用路由。
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // Plan 选中即开启标准 Composer 开关，不能等发送时解析文本；与 /side 共用本地操作入口。
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (readOnly) return undefined;
    const reloadActions: AppSlashCommand[] = sessionId
      ? [
          {
            value: "reload",
            recovery: true,
            description: intl.formatMessage({ id: "chat.slash.app.reload.description" }),
            keywords: ["reload", "restart", "重启"],
            run: taskRestart.restart,
          },
        ]
      : [];
    const planAction: AppSlashCommand = {
      value: "plan",
      description: intl.formatMessage({ id: "chat.slash.app.plan.description" }),
      keywords: ["plan", "计划", "计划模式"],
      run: () => handleDraftSwitchMode("plan"),
    };
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: isMobileTextInputViewport,
      })
    ) {
      return [...reloadActions, planAction];
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // 关键词固定同时包含中英文别名，任一 locale 下输入 side / btw / 辅助 都能搜到。
    // `/btw` 是 `/side` 的等价别名，适配不同用户输入习惯，面板中各自独立展示。
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      ...reloadActions,
      planAction,
      ...[
        { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
        { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      ].filter((command) => !cliSlashCommandNames.has(command.value)),
    ];
  }, [
    taskRestart.restart,
    cliSlashCommandNames,
    handleDraftSwitchMode,
    handleOpenSelectionSideConversation,
    intl,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // 子智能体详情的会话内容仍只读；文件撤销恢复的是 workspace，必须作为独立能力判断。
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork：启动卡 / 后台任务卡的「取消」入口。定义在 rowContext memo 之前，
  // 供其绑定（onOpenWorkflowRun 同样在 memo 前定义）；只读模式下不下发（与 4213 处一致）。
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // 动态工作流灰度快照：只读 store，
  // 取数在 Root 里做一次。未就绪时 enabled 为 false，按未命中处理。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // resumeWorkflowRun：工具卡页脚的 Resume。与详情页
  // 同一条 v4 命令，不携 baseRevision；`name` 喂恢复后完成通知的主题。
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] resumeWorkflowRun 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // amendWorkflowRunSettings：run 卡的「配置」。回 ACK 给弹层——拒绝理由画在弹层里，不是控制台的一行 warn。门与 Resume 相同。
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  /**
   * 「让 ZCode 帮我提炼保存」那条用户消息的发送口（docs/dynamic-workflow/transcript-and-notifications.md
   * 「The message the lead sends」）：与中枢的「提升为全局」同一条先例——GUI 写、自动发、用户不再确认。
   *
   * 经 ref 转一手而不是直接引 `handleSendText`：后者定义在本文件更下面，而 rowContext 的 memo
   * 工厂在**同一次渲染里**就会跑到，直接引会落进 TDZ。ref 在渲染中赋值，点击总在挂载之后。
   */
  const sendTextRef = useRef<typeof handleSendText | null>(null);
  const handleSendWorkflowSaveRequest = useCallback(async (text: string) => {
    const send = sendTextRef.current;
    if (send === null) throw new Error("send path not mounted");
    const result = await send(text);
    // 被挡下（会话忙着确认别的、队列暂停待确认）就不是「已交给 ZCode」：抛回弹层，让它留在原处。
    if (result !== "sent") throw new Error(`workflow save request not sent: ${result}`);
  }, []);

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView: modelSelectionDisplayView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: runtimeReady ? handleAutoOpenAssistantPptx : undefined,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession:
        runtimeReady && onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: runtimeReady && onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: runtimeReady && onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor:
        runtimeReady && onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace:
        runtimeReady && onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact:
        runtimeReady && onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly || !runtimeReady ? undefined : handleCancelBackgroundWork,
      // Resume 进入会话上下文的唯一供给点；灰度与只读两道门都在 resolveWorkflowResumeHandler 里，
      // 断在这里等于工具卡页脚与摘要卡的按钮一起消失。
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly: readOnly || !runtimeReady,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleAmendWorkflowRunSettings,
            })
          : undefined,
      // 保存与 Resume 同一道门、同一个供给点：写文件与起引擎都属于「Resume 被收走的地方一并收走」
      // （docs/dynamic-workflow/launch.md「Gray release」）。芯片不经这道门，它只是一条事实。
      onSendWorkflowSaveRequest:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleSendWorkflowSaveRequest,
            })
          : undefined,
      workflowSaveCandidatesByRunId,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      fetchFileChanges: runtimeReady ? handleFetchFileChanges : undefined,
      previewFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: runtimeReady ? attachmentRead : undefined,
      readAttachmentRange: runtimeReady ? attachmentReadRange : undefined,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionDisplayView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      runtimeReady,
      handleCancelBackgroundWork,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      handleSendWorkflowSaveRequest,
      workflowSaveCandidatesByRunId,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  // ── 草稿态 v4 draft session 预热（m5）──
  // pane 未绑定会话时后台建 phase=draft 会话作预热载体：配置写 CAS 直达、首发复用。
  // 对外绑定语义不变（shell activeTaskId 仍 null），预热会话只是 pane 内部 effective 订阅目标。
  const { binding: prewarmBinding, waitForSession: waitForDraftSession } = useDraftSessionPrewarm({
    enabled: sessionId === null && draftAgentStartupAllowed && !recoveringDraft,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer 来自 workspace connection registry：同 transport generation 的 pane/remount
    // 共享 identity；provider wrapper 重建产生的新 sendCommand 函数不能误判为 transport 换代。
    transportIdentity: layer,
    dispatchCommand,
    // 预热会话只消费当前 Root Composer Draft 的一次性初始化结果。
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // runtime 换代（CUA Helper 就绪、liveness 恢复等触发 workspace-dispose）会冲掉草稿态尚未
  // 持久化的预热会话。重建期间禁止发送，否则附件会挂在已消失的会话上（sessionNotFound）。
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  const effectiveSessionId = sessionId ?? recoveringDraft?.sessionId ?? prewarmSessionId;
  const pluginUiRuntimeReady = Boolean(
    effectiveSessionId &&
    lease?.sessionId === effectiveSessionId &&
    snapshot?.sessionId === effectiveSessionId &&
    (!snapshot.runtimeInitialization || snapshot.runtimeInitialization.status === "ready"),
  );
  useEffect(() => {
    if (sessionId === null && effectiveSessionId && pluginUiRuntimeReady && snapshot) {
      observeDraftPermissionGrant(effectiveSessionId, snapshot.config);
    }
  }, [
    sessionId,
    effectiveSessionId,
    pluginUiRuntimeReady,
    snapshot?.config,
    observeDraftPermissionGrant,
  ]);
  useLayoutEffect(() => {
    if (!effectiveSessionId || !pluginUiRuntimeReady || readOnly) return;
    return registerPluginUiPaneSession(
      paneId,
      sessionId,
      {
        workspacePath,
        workspaceIdentity,
        remoteSessionId: remoteSessionId ?? undefined,
        sessionId: effectiveSessionId,
      },
      sessionId === null ? prewarmBinding?.retain : undefined,
    );
  }, [
    paneId,
    sessionId,
    effectiveSessionId,
    pluginUiRuntimeReady,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    readOnly,
    prewarmBinding,
  ]);
  const openPluginUi = useOpenPluginUi();
  const pluginUiOpenRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).pluginUiOpenRequest,
  );
  useEffect(() => {
    if (
      !pluginUiOpenRequest ||
      paneId !== V4_PRIMARY_PANE_ID ||
      !focused ||
      sessionId !== null ||
      readOnly
    )
      return;
    const store = useZCodeSessionStore.getState();
    // 请求归属原草稿代际；StrictMode 重放与配置变化不能让旧请求打开新会话。
    if (
      store.getWorkspaceState(workspacePath, workspaceIdentity).pluginUiOpenRequest !==
      pluginUiOpenRequest
    )
      return;
    if (pluginUiOpenRequest.invalidationVersion !== draftRuntimeInvalidationVersion) {
      store.clearPluginUiOpenRequest(
        workspacePath,
        pluginUiOpenRequest.requestId,
        workspaceIdentity,
      );
      return;
    }
    if (!pluginUiRuntimeReady || !effectiveSessionId || !openPluginUi) return;
    store.clearPluginUiOpenRequest(workspacePath, pluginUiOpenRequest.requestId, workspaceIdentity);
    const {
      requestId: _requestId,
      invalidationVersion: _version,
      ...request
    } = pluginUiOpenRequest;
    openPluginUi({ ...request, parentSessionId: effectiveSessionId });
  }, [
    pluginUiOpenRequest,
    paneId,
    focused,
    sessionId,
    readOnly,
    workspacePath,
    workspaceIdentity,
    draftRuntimeInvalidationVersion,
    pluginUiRuntimeReady,
    effectiveSessionId,
    openPluginUi,
  ]);

  useEffect(() => {
    if (!recoveringDraft?.commandId || !remoteAvailable) return;
    let current = true;
    const commandId = recoveringDraft.commandId;
    const off = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
      if (!current) return;
      if (
        resolution === "accepted" ||
        resolution === "duplicate" ||
        resolution === "authoritative"
      ) {
        const entry = pendingCommandRegistry.findCommand(commandId);
        const recoveredSessionId = entry?.sessionId ?? recoveringDraft.sessionId;
        if (recoveredSessionId)
          void handleDraftSessionCreated(
            recoveredSessionId,
            entry?.clientContext?.sessionCreateSource,
            commandId,
            entry?.clientContext?.taskGroupId,
          );
      } else if (resolution === "failed" || resolution === "discarded") {
        setResolvedDraftCommand(commandId);
      }
    });
    void pendingCommandRegistry
      .reconcileSession(
        pendingCommandRegistry.findCommand(commandId)?.sessionId ??
          recoveringDraft.sessionId ??
          null,
        (params) => layer.queryCommands(params),
        workspaceIdentity?.trim() || workspacePath,
      )
      .catch((error) => {
        logger.warn("[v4-composer] 首发结果恢复查询失败，保留草稿身份", error);
      });
    return () => {
      current = false;
      off();
    };
  }, [
    recoveringDraft,
    remoteAvailable,
    layer,
    handleDraftSessionCreated,
    newTaskComposerScope,
    workspacePath,
    workspaceIdentity,
  ]);
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug 原因：草稿尚未形成实际会话，模型选择本身已经在 composer 中可见；
      // 若此时重复弹出切换结果，会把初始化或 prewarm fallback 误报成一次会话内切换。
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug 原因：自动 fallback 的提示与偏好晋升过去分别由 online 事件和任意
      // snapshot 差异驱动，recovery/历史投影可能静默改写下一草稿。现在两者都只
      // 消费 store 已按 deliveryKind 去重后的同一 realtime online 事件。
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  useEffect(() => {
    if (!effectiveSessionId) {
      setLease({ sessionId, layer, lease: null });
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // Bug 原因：acquire 会立即启动 connect，activation 可能在下一轮 effect 前释放
    // 一次性 online 帧；必须在 acquire 返回后同步监听，不能靠 snapshot 重放补偿。
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease({ sessionId, layer, lease: nextLease });
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  useEffect(() => {
    if (!sessionId || !lease || snapshot?.sessionId !== sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, sessionId, snapshot?.sessionId, state.planDirectoryRevision]);

  // 预热会话订阅失败（CLI 重启内存会话消失等）→ 丢弃旧 binding，下一次发送由 owner 重试。
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] 预热会话订阅失败，丢弃旧 binding", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // 副屏是临时 UI 绑定；持久 child 丢失后清 tab，下一次框选按父会话重建。
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
      onAccepted?: (messageId: string) => void,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // compact 是可排队 input command，不走 CAS；resumeGoal 仍是 CAS。
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          // 旧命令丢掉 Composer 选择，摘要因此沿用旧会话模型；固定本次提交，后续改选不回写。
          if (!submission) return false;
          payload = { modelSelection: submission.modelSelection };
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // 人工合并曾让 /goal 在准备完成后重新读取 Composer，覆盖点击时已冻结的档位。
          // 与 sendText 一样沿用本次 Submission；后续菜单修改只影响下一次发送。
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal 需要目标文本");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] 暂不支持 /goal ${command.action}`);
          return true;
        default:
          return false;
      }
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} 缺少 baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.status === "accepted") onAccepted?.(ack.commandId);
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // 兼容尚未升级的 CLI：旧端仍会返回 activeTurn，不能再次无声清空命令。
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  const readGroupedDraftId = useCallback(
    () =>
      String(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion,
      ),
    [workspacePath, workspaceIdentity],
  );
  /**
   * 冻结本次发送起点（spec §9.2）。必须在触发发送的同步阶段调用：早于配置屏障、草稿模型就绪、
   * Start 套餐推荐、空 session 创建等所有发送前 await，否则起点会被读成用户切换后的 Task。
   */
  const captureHighspeedPaneOrigin = useCallback(
    (): HighspeedPaneOrigin => ({
      sessionId: sessionIdRef.current,
      paneBinding: paneBindingRef.current.generation,
      draftId: sessionIdRef.current === null ? readGroupedDraftId() : null,
    }),
    [readGroupedDraftId],
  );

  const prepareHighspeedTurnFrom = useCallback(
    (origin: HighspeedPaneOrigin): HighspeedTurnPreparer =>
      async (
        taskId: string,
        submissionSelection?: ModelSelection,
      ): Promise<HighspeedPrepareTurnResult | null> => {
        // 规则 15：prepare 的选择与本次提交同源——用户刚切换的模型必须在首次发送就驱动
        // admission。曾按会话投影旧组合抽卡，抽中后把用户切到非 Coding Plan 模型的提交
        // 覆盖成卡模型，表现为"选了别的模型还是抽中加速"。
        const selection = resolveHighspeedPrepareSelection({
          submissionSelection,
          projectedConfig:
            snapshotRef.current?.sessionId === taskId ? snapshotRef.current.config : null,
          draftConfig: draftConfigRef.current,
          initialDraftConfig: resolveInitialDraftConfig(),
        });
        if (!selection) return null;
        // 加速卡沿用会话模型，必须带上会话生效的思考档位；缺档位时 CLI 会因 execution 选择
        // 不完整报 "Reasoning level is required" 让整轮发送失败。优先取提交选择的 options，
        // 再回落 thought（CLI 投影的生效档位）；空串表示该模型无档位，交给 service 省略 options。
        const { provider, model, reasoningLevel } = selection;
        try {
          const sendStartedAt = Date.now();
          const result = await highspeedCardService.prepareTurn({
            taskId,
            providerId: provider,
            model,
            ...(reasoningLevel ? { reasoningLevel } : {}),
            waitBudgetMs: HIGHSPEED_SEND_WAIT_BUDGET_MS,
          });
          if (result.kind === "accelerated") {
            // Bug 根因：该查询只决定节省时间展示，却曾在抽中后同步 await；monitor 侧 15s 超时把
            // 1s 发送承诺拉长到最多 16s（新会话首发尤其明显：空 session 已建、正文长期未发）。
            // 现在只在剩余发送预算内 best-effort 等待，超时/失败本轮不附加 regularTps，
            // 请求由 Service 层继续完成并缓存供下一轮（spec §3 规则 12、§9.4）。
            const regularTps = await readRegularTpsWithinSendBudget({
              read: async () => {
                // 节省时间的基准 TPS 来自 Coding Plan 用量健康接口，请求期鉴权只能由账号访问
                // 上下文解析。这里按当前选中的 Coding Plan Provider 现取快照，不订阅配置面
                // （SessionPane 不需要为此重渲染）；未连接或无权益时直接不展示节省时间。
                const providerSettingsState = getProviderSettingsSnapshot();
                const accountAccess =
                  providerSettingsState.status === "ready"
                    ? resolveEntitledAccountProviderAccess(providerSettingsState.view, provider)
                    : null;
                if (!accountAccess) return undefined;
                return readHighspeedRegularTpsFromHealth({
                  usageStatsService,
                  preferredProviderId: provider,
                  accountAccess: accountAccess.access,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              },
              elapsedMs: Date.now() - sendStartedAt,
              onError: (error) =>
                logger.warn("[highspeed] 读取普通 Decode TPS 失败，本轮不展示节省时间", {
                  error: error instanceof Error ? error.message : String(error),
                  provider,
                  taskId,
                }),
              onTimeout: (budgetMs) =>
                logger.info(
                  "[highspeed] 普通 Decode TPS 未在发送预算内返回，本轮不附加 regularTps",
                  {
                    budgetMs,
                    provider,
                    taskId,
                  },
                ),
            });
            const acceleratedResult: HighspeedPrepareTurnResult = regularTps
              ? { ...result, card: { ...result.card, regularTps } }
              : result;
            const cardId = acceleratedResult.card.cardId;
            // Bug 根因：SessionPane 跨 Task 复用同一实例，发送前的配置屏障、套餐推荐、建会话以及
            // prepare 与 TPS 读取 await 期间用户都可能切到其他 Task；此时写卡片状态会把旧 Task 的卡
            // 呈现到新 Task 的输入框并播放激活。起点曾在 prepare 入口才读取，切换发生在 prepare 之前时
            // 起点已是新 Task，判定失效；现由调用方在发送同步阶段冻结。只有 pane 正显示卡所属 Task，
            // 或草稿首发且 pane 从未离开该草稿（首发 session 尚未绑定回 pane）时才呈现。卡仍交给本轮
            // 发送继续加速，只跳过本 pane 的呈现；切回所属 Task 由快照恢复按 restore 呈现。
            const paneSessionId = sessionIdRef.current;
            const paneShowsSendTarget =
              paneSessionId === taskId ||
              (origin.sessionId === null &&
                paneSessionId === null &&
                paneBindingRef.current.generation === origin.paneBinding &&
                readGroupedDraftId() === origin.draftId);
            if (!paneShowsSendTarget) {
              return acceleratedResult;
            }
            // Bug 根因：恢复链路与 draw 命中共用同一条卡片渲染路径，按“卡片出现”触发激活动效会在
            // 切回 Task 时重播；prepare 复用已有卡同样返回 accelerated。只有本 pane 首次呈现的卡才登记。
            if (presentedHighspeedCardIdRef.current !== cardId) {
              presentedHighspeedCardIdRef.current = cardId;
              setHighspeedActivationCardId(cardId);
            }
            setActiveHighspeedCard(acceleratedResult.card);
            return acceleratedResult;
          } else if (
            !result.card ||
            result.card.taskId !== taskId ||
            result.card.expiresAt <= Date.now()
          ) {
            setActiveHighspeedCard((current) => (current?.taskId === taskId ? null : current));
          }
          return result;
        } catch (error) {
          logger.warn("[highspeed] 抽卡失败，本轮按普通模型发送", {
            error: error instanceof Error ? error.message : String(error),
            taskId,
          });
          return null;
        }
      },
    [
      draftConfigRef,
      highspeedCardService,
      readGroupedDraftId,
      resolveInitialDraftConfig,
      usageStatsService,
    ],
  );

  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      createSourceAtSend: SessionCreateSource,
      highspeedOriginAtSend: HighspeedPaneOrigin,
      taskGroupIdAtSend?: string | null,
    ) => {
      let onAcceptedSelection: (() => void) | undefined;
      const prepareHighspeedTurn = prepareHighspeedTurnFrom(highspeedOriginAtSend);
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        args[9] = createSourceAtSend;
        args[11] = taskGroupIdAtSend;
        args[12] = options?.submittedDraftText ?? text;
        if (args[0] === "sendText") args[1] = { ...args[1], genUiContext: [] };
        if (
          args[0] === "sendText" &&
          args[2] &&
          baseWorkspaceServices.genUiService &&
          typeof args[1]?.text === "string"
        ) {
          try {
            const context = selectGenUiModelContext(
              await baseWorkspaceServices.genUiService.listState({
                workspacePath,
                workspaceIdentity,
                sessionId: args[2],
              }),
            );
            // 页面状态曾混入 text，队列等出口因此泄漏尾块；正文与快照随同一命令分开传递。
            args[1] = { ...args[1], genUiContext: context };
          } catch {
            // 状态是辅助上下文；读取失败不能阻断既有 CommandInbox 输入路径。
            logger.warn("[gen-ui] Widget context unavailable");
          }
        }
        const ack = await dispatchCommand(...args);
        // 在原 accepted 边界写回推荐选择，早于新 Session 的草稿转移；失败不改用户意图。
        if (ack.status === "accepted" && submissionConfigFromCommand(args[0], args[1]))
          onAcceptedSelection?.();
        return ack;
      };
      // 进入 barrier 前已经冻结；等待配置/附件期间不再回读 Composer 或 Session。
      let submission = options?.submission ?? null;
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const sharedContextRefs = options?.sharedContextRefs;
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      const slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      if (!draftProjectReady || !(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      const selectionSideSlashCommand =
        sessionId &&
        appSlashCommands?.some((command) => command.value === "side" || command.value === "btw")
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.telemetrySeed,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan 模式不能创建、更新或恢复 goal。必须在 draft promotion / command dispatch
        // 之前拒绝，否则即使 CLI 后续拒绝，composer 也会误以为发送成功并清空用户输入。
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      if (!submission) {
        logger.warn("[v4-pane] Submission 缺少完整模型或模式配置");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // UI choice 只对普通输入和 /goal <新目标> 生效；/compact 直接追加暂停队列，
        // resumeGoal 等控制命令也不应被发送消息确认框截获。
        return "confirmationRequired" as const;
      }
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 复用同一个预热会话。
      if (slashCommand === null || slashCommand.kind === "sendGoalCommand") {
        const original = submission.modelSelection;
        const chosen = await recommendStartPlan(original);
        if (!chosen) return "blocked" as const;
        if (chosen !== original) {
          onAcceptedSelection = captureAcceptedModelSelection(chosen, original);
          submission = { ...submission, modelSelection: chosen };
        }
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      if (prewarmTargetBeforeSend) {
        // 屏障只保证已经入队的命令完成；若点击配置时预热 session/snapshot 尚未
        // 就绪，命令可能当时没有目标。首发绑定确定的预热 session 前再同步一次
        // 草稿权威配置，禁止 UI 新值与 runtime 旧值分叉。
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 先建空会话再发命令。
      // 携带附件或网页元素上下文时不消费为 v4 原生命令（compact/goal 等无附件语义），随 sendText 直发。
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          onAcceptedSelection?.();
          return;
        }
      }
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
      }
      // Bug 根因：首发曾把 binding=null 当成无预热，绕过 owner 再建一个会话。
      // 文本、附件/context 和 goal 都等待同一创建任务，创建失败或换代直接保留草稿。
      const draftBinding = sessionId === null ? await waitForDraftSession() : null;
      if (draftBinding) {
        await ensureDraftPrewarmConfigBeforeSendRef.current(draftBinding.sessionId);
        if (!draftBinding.beginPromotion()) throw new Error("草稿会话已切换，请重新发送");
      }
      const targetSessionId = sessionId ?? draftBinding!.sessionId;
      if (draftBinding && draftSlashCommand) {
        const consumed = await dispatchSlashCommand(
          draftSlashCommand,
          targetSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
          (messageId) => reportDraftCreated(targetSessionId, createSourceAtSend, messageId),
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          draftBinding.promote();
          await handleDraftSessionCreated(
            targetSessionId,
            createSourceAtSend,
            undefined,
            taskGroupIdAtSend,
          );
          return;
        }
      }
      // admission 写出后的失败或 transport error 不能证明 CLI 没有执行；保留原 binding
      // 的 pending 生命周期，交给 Composer 保留输入，禁止自动换会话/command 重发。
      // 附件 ref 已在 composer 预传状态机中收口。
      const highspeed = await prepareHighspeedSendContext(
        targetSessionId,
        prepareHighspeedTurn,
        submission.modelSelection,
      );
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text,
          ...submission,
          ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
          conversationQuotes: options?.conversationQuotes,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(sessionId && options?.requestedDelivery
            ? {
                // Bug 根因：立即发送曾先投影 QueueItem，再等待二次
                // sendQueuedNow，导致队列中间态外泄且输入框延迟清空。现在由
                // CLI 原子 stop + start，accepted ACK 即是 Composer 清空边界。
                requestedDelivery: options.requestedDelivery,
              }
            : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
          ...(options?.source ? { source: options.source } : {}),
          ...highspeed.override,
        },
        targetSessionId,
        undefined,
        undefined,
        options?.telemetrySeed,
        highspeed.acceleratedCard,
        options?.onCommandCreated
          ? (envelope) => {
              if (envelope.type === "sendText") options.onCommandCreated?.(envelope.commandId);
            }
          : undefined,
        undefined,
        undefined,
        // Recent 记录加速前的 Composer 原始选择，不用被覆盖的 payload Selection。
        submission,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        if (
          ack.reasonCode === "modelUnavailable" &&
          highspeed.acceleratedCard &&
          highspeed.override.modelExecution?.selectionFallback
        ) {
          // Bug 根因：Highspeed 与退回模型都不可用时，准入拒绝曾按普通发送异常处理，
          // Composer 虽保留输入，但卡仍锁住模型选择且显示无助于恢复的错误。作废 Service
          // 持有的同一张卡，并返回 blocked，让 Composer 的提交事务恢复正文和附件。
          setSendSubmissionError(null);
          invalidateActiveHighspeedCard(
            highspeed.acceleratedCard.cardId,
            `admission:${ack.commandId}:${highspeed.acceleratedCard.cardId}`,
          );
          return "blocked" as const;
        }
        throw new Error(ack.reasonCode ?? "sendText 被拒绝");
      }
      if (draftBinding) {
        // 合并后普通首发漏传 commandId；只在 accepted 边界统计，避免预热空创建重复计数。
        draftBinding.promote();
        await handleDraftSessionCreated(
          targetSessionId,
          createSourceAtSend,
          ack.commandId,
          taskGroupIdAtSend,
        );
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
    },
    [
      dispatchCommand,
      recommendStartPlan,
      baseWorkspaceServices,
      captureAcceptedModelSelection,
      dispatchSlashCommand,
      draftProjectReady,
      ensureDraftModelReadyForSend,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      handleDraftSessionCreated,
      reportDraftCreated,
      handleOpenSelectionSideConversationWithPrompt,
      invalidateActiveHighspeedCard,
      intl,
      prepareHighspeedTurnFrom,
      resolveInitialDraftConfig,
      createSubmissionFromComposer,
      sessionId,
      settleCurrentQueueInputs,
      waitForDraftSession,
    ],
  );

  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const createSource = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource;
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      // 进入配置屏障前冻结 Highspeed 发送起点；屏障与后续 await 期间用户可能切换 Task。
      const highspeedOrigin = captureHighspeedPaneOrigin();
      const taskGroupId =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .draftTaskGroupId
          : undefined;
      // followupMode 仍通过 Session CAS 同步；模型和模式已封装进 Submission，不再
      // 依赖“配置命令先到、sendText 后到”的跨命令时序。
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(
            text,
            submissionOptions,
            createSource,
            highspeedOrigin,
            taskGroupId,
          );
        } catch (error) {
          if (sessionId === null && isProviderNotReadyError(error)) {
            // UI 预检查与 Host getClient 之间 registry 仍可能失效。竞态命中时收敛成
            // 同一个正常等待态，不走异常发送路径，也不清空 composer。
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // 发送前冻结本次 admission 预期：command ACK 回来时 projection 可能已经切到 running，
      // 不能用更新后的 enqueue mode 反推刚提交的 prompt 是否原本立即发送。
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // 首发前 switchModelConfig 失败只会抛回 Composer；Composer 为了保留草稿
        // 仅写日志，不会生成 snapshot.control.lastError，用户看到的结果就是“点击没反应”。
        // 这里把 admission 前失败收口为 pane-local 错误横幅，不改变 desktop continuous 或
        // Web remote replayable 的发送/恢复语义，草稿仍由 Composer 原路径保留。
        setSendSubmissionError({
          code:
            getRemoteConnectionFailureCode(error) ??
            (runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED"),
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );
  // 上面那个 ref 的唯一赋值点（见 handleSendWorkflowSaveRequest 的说明）。
  sendTextRef.current = handleSendText;

  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );
  const handleHighspeedActivationApplied = useCallback((cardId: string) => {
    // 按 cardId 消费：迟到的旧卡回调不能清掉新卡的激活请求。
    setHighspeedActivationCardId((current) => (current === cardId ? null : current));
  }, []);

  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant 是 CAS 命令：baseRevision 取当前投影 revision。
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // 原地切到 child session（与新建会话同一选择路径）。
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
      conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (
        !newText.trim() &&
        (!attachments || attachments.length === 0) &&
        !conversationQuotes?.length
      ) {
        logger.warn("[v4-pane] edit 跳过：行内编辑内容为空且无附件");
        return false;
      }
      const highspeed = await prepareHighspeedSendContext(
        sessionId,
        prepareHighspeedTurnFrom(captureHighspeedPaneOrigin()),
      );
      const latest = snapshotRef.current;
      if (!latest || latest.sessionId !== sessionId) {
        logger.warn("[v4-pane] edit 跳过：Highspeed prepare 后 session 已切换");
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          conversationQuotes,
          // editUserQuery 的 attachments 缺省表示保留 canonical 原附件；
          // 只有显式透传 []，CLI 才能区分“用户删除全部”与“调用方未修改附件”。
          ...(attachments ? { attachments: [...attachments] } : {}),
          ...highspeed.override,
        },
        sessionId,
        latest.revision,
        latest.logEpoch,
        undefined,
        highspeed.acceleratedCard,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        return false;
      }
      // fork ACK 只做旧协议解码兼容；新 edit 永不导航 child。blocked 由行内冲突弹窗处理。
      return ack;
    },
    [captureHighspeedPaneOrigin, dispatchCommand, prepareHighspeedTurnFrom, sessionId],
  );

  const dispatchRetryTurn = useCallback(
    async (target: ConversationRowTarget): Promise<CommandAck> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) {
        throw new Error("retryTurn 缺少当前 session 投影");
      }
      // retryTurn 是 CAS 命令：baseRevision 取当前投影 revision。
      return dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleRetry = useCallback(
    (target: ConversationRowTarget) => {
      void dispatchRetryTurn(target)
        .then((ack) => {
          if (ack.status !== "accepted") {
            logger.warn(`[v4-pane] retry 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn("[v4-pane] retry 提交失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [dispatchRetryTurn],
  );

  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant 反馈被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] deleteQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(`[v4-pane] queue 撤回编辑跳过：queue item 不存在或不可编辑 ${queueItemId}`);
        return;
      }
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      try {
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          logger.warn(`[v4-pane] queue 撤回编辑被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // delete ACK 异步返回时 pane 可能已切 task；旧实现若直接 setText，
          // 会把原 session 的 queue payload 写进新 task。权威删除保留，但本地恢复必须放弃。
          logger.warn("[v4-pane] queue 撤回编辑未恢复：ACK 返回前 composer 已切换", {
            queueItemId,
            sessionId,
            workspaceKey,
          });
          clearQueueEditOperation();
          return;
        }
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          config: restoreTarget.config,
        });
      } catch (error) {
        logger.warn("[v4-pane] queue 撤回编辑命令失败", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [clearQueueEditOperation, dispatchCommand, intl, sessionId, workspaceKey],
  );

  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // 用户明确点击“立即发送”时，视觉意图等价于点击“滚动到底部”；command 的
      // reserve/stop/promote 生命周期仍由 CLI 裁决，不把滚动状态混入协议。
      focusTimelineToLatest();
      const highspeedOrigin = captureHighspeedPaneOrigin();
      void (async () => {
        const queueItem = current.queue.items.find((item) => item.queueItemId === queueItemId);
        let highspeedOverride: HighspeedSendContext["override"] = {};
        if (queueItem?.highspeed && queueItem.highspeed.expiresAt > Date.now()) {
          const refreshed = await prepareHighspeedSendContext(
            sessionId,
            prepareHighspeedTurnFrom(highspeedOrigin),
            queueItem.modelSelection,
          );
          // Bug 原因：CLI 暂存 runtime 可能跨异步边界缺失；手动提升时补充同一张卡的
          // 新 runtime。若服务返回了不同卡，不得把原队列意图悄悄改绑到另一张卡。
          if (refreshed.acceleratedCard?.cardId === queueItem.highspeed.cardId) {
            highspeedOverride = refreshed.override;
          }
        }
        const latest = snapshotRef.current;
        const latestQueueItem = latest?.queue.items.find(
          (item) => item.queueItemId === queueItemId,
        );
        if (!latest || latest.sessionId !== sessionId || !latestQueueItem) {
          logger.warn("[v4-pane] sendQueuedNow 跳过：Highspeed prepare 后队列状态已变化", {
            queueItemId,
          });
          return null;
        }
        return dispatchCommand(
          "sendQueuedNow",
          { queueItemId, ...highspeedOverride },
          sessionId,
          latest.revision,
        );
      })().then((ack) => {
        if (!ack) return;
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] sendQueuedNow 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      dispatchCommand,
      focusTimelineToLatest,
      prepareHighspeedTurnFrom,
      sessionId,
    ],
  );

  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(`[v4-pane] 恢复暂停队列被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
    }
  }, [dispatchCommand, sessionId]);

  // 配置面 CAS 命令的 stale 重试。模型→思考深度→模式连续操作时，前一条命令的
  // revision bump 可能尚未回流到本地投影，直接用本地 revision 会被 CAS 判 stale。
  // stale ack 带 revisionAtDecision（CLI 当前 revision），用它重试即可收敛（有界 3 次）。
  // m5：目标 = effective session（已绑定会话或草稿预热会话）；投影必须与目标
  // 同源（snapshot.sessionId 校验），防止预热切换瞬间用错 revision。
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // draft 预热会话已经创建、snapshot 尚未投影时，旧逻辑直接跳过
      // 配置 CAS；首发随后沿用 runtime 的 build 缺省。CAS 本身支持 stale revision
      // 回包重试，因此无 snapshot 时从 0 起步也能确定收敛，不能把“未投影”当成功。
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      let lastAck: CommandAck | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        logger.warn(`[v4-pane] ${type} 连续 stale，放弃重试`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // provider readiness 竞态被配置 CAS 吞成 null 后，首发会改写成
          // missing-ack，草稿页无法恢复成模型配置引导。确定性启动门禁必须原样上抛。
          throw error;
        }
        // 生产 renderer 日志关闭，异常也进 ack 调试缓冲，避免静默丢失。
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} 失败: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode 仍是 Session 行为设置；模型与模式属于本次 Submission，随 sendText
      // 原子提交，不能在发送前通过 CAS 改写共享 Session。
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} 未在首发前收敛: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // 交互行为的用户事实源是 app 设置页；v4 投影 followupMode 只是
    // CLI/runtime 同步结果。这里把设置变更补发成既有 setFollowupMode 命令，
    // 避免 composer 再暴露一个同义“追加模式”入口造成上下游分叉。
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // Composer 选择表达“下一次提交”。点击只更新 renderer intent；Session Selection
  // 在 Submission 真正开跑（Guide 为下一次 model-step）时由 CLI/Core 更新。
  const handleSelectModel = useCallback(
    (
      modelProvider: string,
      model: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) => {
      // 加速卡在本轮已把 Selection 锁定成卡上模型，选型菜单此时不可用；仍有快捷键
      // 或竞态调用进来时明确提示，不能静默把草稿改成另一个模型。
      if (activeHighspeedCard) {
        toast(intl.formatMessage({ id: "chat.highspeed.modelLocked" }));
        return;
      }
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      handleDraftSelectModel(resolvedProvider, model, reasoningLevel);
    },
    [activeHighspeedCard, draftConfigRef, handleDraftSelectModel, intl],
  );

  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn("[v4-pane] custom provider 恢复跳过：provider 没有可用模型", {
            customProviderId: decoded.providerId,
            workspacePath,
          });
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug 原因：configOptions error 的 custom provider 选择绕过普通 onSelectModel；
      // 已绑定任务仍复用同一提示入口，草稿态由入口统一静默。
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  // 模式与模型一样属于下一次 Submission；选择时只更新 Composer。
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // context usage 面板的压缩入口（命令文本 = "/compact"，复用 slash 解析路径）。
  const handleSendCompressionCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      const parsed = parseV4VisibleSlashCommand(command);
      if (!parsed) return;
      const submission = createSubmissionFromComposer();
      if (!submission) return;
      void dispatchSlashCommand(
        parsed,
        sessionId,
        snapshotRef.current?.revision,
        undefined,
        undefined,
        submission,
      );
    },
    [createSubmissionFromComposer, dispatchSlashCommand, sessionId],
  );

  // 误停排障需要区分按钮与 Esc；普通 info 在生产禁用，必须走生命周期日志。
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      if (!sessionId || !current?.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop 命令被跳过（无可停执行）", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop 命令发出", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop 失败: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // 主、辅对话可同时 focused（各自布局的可见态），不能据此争抢窗口 Esc。
  // 面板打开时按 DOM 归属隔离；关闭时由 Shell 授权主区接收对话外 Esc，避免焦点离开输入框后无法停止。
  // 保留窗口冒泡阶段，让 mention/slash 的 preventDefault 和 dialog 优先处理。
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!sessionId || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!paneRef.current) return;
      if (!allowEscapeStopOutsidePane && !event.composedPath().includes(paneRef.current)) return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    allowEscapeStopOutsidePane,
    focused,
    handleStop,
    readOnly,
    sessionId,
    snapshot?.control.canStop,
  ]);

  // handleStop 带 source 参数（button / escape 两个调用点），但 ConversationComposer 是 memo：
  // 直接写 onStop={() => handleStop("button")} 每次 render 都换引用，memo 白做，而 composer
  // 恰好是每次输入都可能重渲染的组件。这里固定 button 版的引用，不动 handleStop 的双入口设计。
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  const handleRetrySubscribe = useCallback(() => {
    if (state.lifecycle?.state !== "faulted") {
      void lease?.store.retry();
      return;
    }
    // faulted 不能通过重复单任务 close 恢复；扩大到工作区必须由用户明确选择。
    void (async () => {
      if (
        !(await confirmLifecycleRecovery({
          title: intl.formatMessage({ id: "taskList.recoverWorkspace" }),
          description: intl.formatMessage({ id: "taskList.recoverWorkspaceDescription" }),
          confirmLabel: intl.formatMessage({ id: "taskList.recoverWorkspace" }),
        }))
      )
        return;
      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: provider ?? ZCODE_AGENT_PROVIDER,
          bumpRuntimeEpoch: true,
        });
        await lease?.store.retry();
      } catch (error) {
        logger.warn("[session-lifecycle] 工作区恢复失败", { workspacePath, error });
        toast(intl.formatMessage({ id: "taskList.restartFailed" }));
      }
    })();
  }, [
    lease,
    state.lifecycle?.state,
    confirmLifecycleRecovery,
    intl,
    zcodeTaskService,
    workspacePath,
    workspaceIdentity,
    provider,
  ]);

  // loadOlder 触发（接近顶部自动预取）。store 内部单飞防重入。
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  useEffect(() => {
    if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return;
    const key = `${sessionId}:${snapshot?.logEpoch ?? "unknown"}`;
    if (shareHydratedSessionRef.current === key) return;
    shareHydratedSessionRef.current = key;
    void handleLoadAllOlder().catch((error) => {
      shareHydratedSessionRef.current = null;
      logger.warn("[conversation-share] 补齐分享目录失败", { error });
    });
  }, [handleLoadAllOlder, sessionId, shareActive, snapshot]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows 按 row 截尾，可能把一个长 turn 的 header/user
    // 留在窗口外。旧 UI 只在 scroll 事件到达顶边时 loadOlder；内容不足一屏或 scrollTop
    // 已经为 0 时不会再产生事件，于是只渲染 assistant，必须先下滚再上滚。检测到首 turn
    // 缺 header 后立即逐窗补齐；cursor 去重避免空 range 或失败时 effect 自旋。
    logger.debug("[v4-pane] 冷快照首 turn 不完整，自动补拉更早行", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  // subscribe ACK 会先把 store 置 live，initial snapshot 稍后才到；只看
  // status 会在无投影窗口提前启用编辑器。正式 session 必须等首个 snapshot 才可输入。
  const connecting =
    sessionId !== null &&
    (snapshot === null || (state.status === "connecting" && !snapshot.runtimeInitialization));
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  const errored = sessionId !== null && state.status === "error";
  useSessionSubscriptionErrorTelemetry({
    supervisor: conversationTelemetry,
    sessionId,
    lastError: state.lastError,
    visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled,
  });
  // retry 的产品裁决属于行级权威投影。这里仅提供命令能力，入口是否展示
  // 完全读取 row.actions.canRetry，禁止再用 pane phase 形成第二套 guard。
  const retryActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // fork 可用性完全由 row.actions.canFork（CLI stable resolver 投影）裁决；pane 只提供命令回调。
  const forkActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // editUserQuery 已由 command 层防御 latest real user query，并在 running
  // 提交时先 stop barrier 再 rewind/rerun；UI 不应再用 completed gate 把入口整轮隐藏。
  const editActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // 滚动恢复必须使用与 sessionId 匹配的 lease projection。切换 session 的 render 与
  // passive effect 不在同一时刻，旧 lease 的 rows 若提前交给 timeline，会让新记忆按旧
  // 内容高度 clamp，后续目标 rows 到达时也无法区分这次临时落点。
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  const shareHandoverContext =
    snapshot?.sharedContextImport && "contextId" in snapshot.sharedContextImport
      ? snapshot.sharedContextImport
      : null;
  // 导入的分享对话：读取落盘的公开 rows 用于会话顶部的只读块。
  // 分享页可能过期或未上线，所以只读本地副本，不回源。
  const [importedShare, setImportedShare] = useState<ImportedConversationShare | null>(null);
  const importedShareContextId =
    shareHandoverContext && shareHandoverContext.status !== "discarded"
      ? shareHandoverContext.contextId
      : null;
  useEffect(() => {
    if (!importedShareContextId || compactForRemoteControl) {
      setImportedShare(null);
      return;
    }
    let disposed = false;
    void conversationShareService
      .getImportedConversation({
        workspacePath,
        contextId: importedShareContextId,
      })
      .then((imported) => {
        if (disposed) return;
        setImportedShare(imported);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // 只读块是增强，读不到就不渲染，不打断会话。
        logger.warn("[conversation-share] 读取导入的分享对话失败", { error });
        setImportedShare(null);
      });
    return () => {
      disposed = true;
    };
  }, [compactForRemoteControl, conversationShareService, importedShareContextId, workspacePath]);
  // normalizeConversationShareMarkdown 在 artifactNames 里找不到匹配名字时，会把正文里的
  // 文件引用替换成空字符串（直接删掉）。不接这份映射，只读块里的文件引用会静默消失。
  const importedShareArtifactNames = useMemo(
    () =>
      new Map(
        (importedShare?.artifacts ?? []).map((artifact) => [
          artifact.artifactId,
          artifact.displayName,
        ]),
      ),
    [importedShare],
  );
  const importedShareArtifactWorkspaceRelativePaths = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const artifact of importedShare?.artifacts ?? []) {
      if (artifact.workspaceRelativePath) {
        entries.push([artifact.artifactId, artifact.workspaceRelativePath]);
      }
    }
    return new Map(entries);
  }, [importedShare]);
  useLayoutEffect(() => {
    if (
      compactForRemoteControl ||
      !timelineBottomRequest ||
      timelineBottomRequest.taskId !== sessionId ||
      !importedShare ||
      importedShare.contextId !== importedShareContextId
    ) {
      return;
    }
    // 分享块是异步挂载的；请求保留到目标 task 与本地副本都就绪，再在布局稳定后消费。
    const scrollToBottom = () => {
      const action = timelineScrollToBottomRef.current;
      if (!action) return false;
      action();
      return true;
    };
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollToBottom()) return;
        useZCodeSessionStore
          .getState()
          .clearTimelineBottomRequest(
            workspacePath,
            timelineBottomRequest.requestId,
            workspaceIdentity,
          );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    compactForRemoteControl,
    importedShare,
    importedShareContextId,
    sessionId,
    timelineBottomRequest,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleOpenImportedShareUrl = useCallback(() => {
    if (!shareHandoverContext || !onOpenBrowserUrl) return;
    // 持久化的是规范 /cn/share/ 路径；展示/打开时才按界面语言本地化。
    onOpenBrowserUrl(localizeConversationShareUrl(shareHandoverContext.shareUrl, locale));
  }, [locale, onOpenBrowserUrl, shareHandoverContext]);
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  const telemetryDraftConfig = draftConfig;
  // CLI V4 projection 是 running/count/manifest 的唯一权威；renderer 不再在 spawn
  // 事件后另发查询拼接第二份状态，避免并发 child 的 in-flight refresh 丢更新。
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  // 「工作流」分区跟着「有没有活的 run」走（docs/dynamic-workflow/presentation.md「Other places a
  // run appears」）：在跑数从 0 变成 ≥1 时打开、归零时折起，进入会话时按该会话重新判定。只在这个
  // 布尔翻转（或换会话）时写入，所以读者手动折起后，run 还在跑就一直保持折起。
  // Bug 原因：过去它和终端 / 智能体一样默认折起；胶囊改为按名字显示工作流后，点开胶囊反而把刚才
  // 看到的那条 run 折进了分区里——展开后看到的比胶囊还少。
  const hasLiveWorkflowRun = runningWorkflowCount > 0;
  useEffect(() => {
    setWorkflowSectionOpen(hasLiveWorkflowRun);
  }, [hasLiveWorkflowRun, sessionId]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // composer 徽标直达：唯一在跑的是一条可开
  // 详情页的 workflow run 时，徽标点击直接开它的 side tab，胶囊不动。判定吃胶囊的同一份模型；
  // 宿主没给 onOpenWorkflowRun（面板行同样不可点）时不直达。
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // 与面板行同一个 handler：不存在第二条打开路径。
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // 产品规则：Composer 是全部实时活动的入口；分区拆开后一次点击仍要展开所有非空类型，
    // 但三个区块后续保持独立折叠状态，不能再共享一个 open 布尔值。
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // 若只有 status panel 内部知道自动展开态，而 timeline/composer 未同步调整布局，
  // 宽屏下就会出现面板覆盖内容。因此外层布局也必须使用同一展开状态。
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  const statusPanelLayout = !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // 官方 Server MCP 不可用（额度耗尽 / 无 Coding Plan）：事实来自 tool row 上的结构化标识，
  // 与模型额度是两条独立信息通道，这里只做投影。
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNoticeInPartition(rowsPartition),
    [rowsPartition],
  );
  const quotaBanner = useV4SessionQuotaBanner({
    sessionId: snapshot?.sessionId ?? sessionId,
    error: controlLastError,
    errorKey: controlLastErrorKey,
    phase: snapshot?.control.phase ?? null,
    providerId: snapshot?.config.provider ?? null,
    modelId: snapshot?.config.model ?? null,
    usageStatsService: baseWorkspaceServices.usageStatsService,
    mcpUnavailableNotice,
  });
  const composerError =
    draftModelReadinessError ??
    sendSubmissionError ??
    (quotaBanner.takesOverError ? null : projectedComposerError);
  const retryConfigReadRow = snapshot?.rows.window.findLast(
    (row) => row.kind === "userInput" && row.origin === "realUser",
  );
  const retryConfigReadEnabled =
    retryActionsEnabled &&
    !isRunning &&
    isRequestVerificationConfigNetworkError(composerError) &&
    retryConfigReadRow?.actions?.canEdit === true &&
    Boolean(retryConfigReadRow.entityId);
  const handleRetryConfigRead = useCallback(() => {
    const current = snapshotRef.current;
    if (
      !retryActionsEnabled ||
      !current ||
      current.control.canStop ||
      !isRequestVerificationConfigNetworkError(current.control.lastError)
    )
      return;
    const row = current.rows.window.findLast(
      (item) => item.kind === "userInput" && item.origin === "realUser",
    );
    if (!row || row.kind !== "userInput" || !row.actions?.canEdit || !row.entityId) return;
    // 配置失败时没有 assistant 行；复用权威 edit 命令重跑原输入，保留附件且不追加第二条消息。
    const text = row.epilogueStart === undefined ? row.text : row.text.slice(0, row.epilogueStart);
    void handleEdit(
      { rowId: row.rowId, entityId: row.entityId },
      text,
      row.attachments,
      "preserve",
      row.conversationQuotes,
    ).catch((error: unknown) => {
      logger.warn("[v4-pane] 配置读取失败后重试原消息失败", { error });
    });
  }, [handleEdit, retryActionsEnabled]);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError 是投影事实，单纯关闭 banner 不会改投影。
    // 这里只记录当前错误指纹，避免下一次 render 把同一条错误立刻重新顶回来；新错误 at/message 变化仍会显示。
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  // 远端 workspace 的模型目录来自远端 Registry；本机配置保存后由 Provisioning 自动下发，
  // 因此缺模型横幅只切换措辞，配置/升级动作仍统一指向本机。
  const modelConfigTarget: ChatErrorBannerModelConfigTarget = isRemoteWorkspaceIdentity(
    workspaceIdentity ?? "",
  )
    ? "remote"
    : "local";
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const handleOpenModelUpgrade = useCallback(() => {
    if (!codingPlanUpgradeDialog) return;
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    codingPlanUpgradeDialog.openCodingPlanUpgrade({ providerId });
  }, [codingPlanUpgradeDialog, sharedSettings?.providerFamilyDomain]);
  const handleOpenQuotaUpgrade = useCallback(() => {
    const providerId = quotaBanner.upgradeProviderId;
    if (!providerId || !codingPlanUpgradeDialog) return;
    const eventText = intl.formatMessage({
      id: quotaBanner.upgradeActionLabelId,
    });
    // 横幅只建立漏斗上下文；coding_plan_upgrade_ck 仍由真实购买面板打开后统一上报。
    codingPlanUpgradeDialog.openCodingPlanUpgrade({
      providerId,
      funnelContext: createCodingPlanFunnelContext({
        providerId,
        upgradeSource: "session_quota_alert",
        eventRegion: "app.session",
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanState({
          providerId,
          displayStatus: "purchased",
          planLevel: "start",
        }),
      }),
    });
  }, [
    codingPlanUpgradeDialog,
    intl,
    quotaBanner.upgradeActionLabelId,
    quotaBanner.upgradeProviderId,
  ]);

  const handleConfirmShareDisclosure = useCallback(async () => {
    if (!sessionId || !shareDraft || sharePublishing) return;
    const productTurnIds = getConversationShareSelectedProductTurnIds(
      useConversationShareSelectionStore.getState(),
      sessionId,
    );
    if (productTurnIds.length === 0 || !shareTitle.trim()) return;
    const attemptKey = JSON.stringify({
      title: shareTitle.trim(),
      accessMode: shareDraft.accessMode,
      productTurnIds,
      revision: snapshot?.revision ?? null,
      logEpoch: snapshot?.logEpoch ?? null,
    });
    const shareAttempt = ensureConversationShareAttempt(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), sessionId)
        .attempt,
      attemptKey,
      sessionId,
      { randomUUID: () => globalThis.crypto?.randomUUID?.() },
    );
    const operationId = `share-operation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    let activePhase = "collecting";
    let collectedWarnings: ConversationShareDisplayWarnings | null = null;
    const progressSubscription = conversationShareService.onDynamicPublishProgress(operationId)((
      progress,
    ) => {
      activePhase = progress.phase;
      updateShareDockState(sessionId, {
        progress: progress.phase === "complete" ? "checking" : progress.phase,
        completedArtifacts: progress.completedArtifacts,
        totalArtifacts: progress.totalArtifacts,
      });
      const warnings = sanitizeConversationShareWarnings(progress.warnings);
      if (warnings.length > 0) {
        collectedWarnings = {
          issues: warnings,
          issueCount: warnings.length,
          ...(progress.omittedWarningCount
            ? { omittedIssueCount: progress.omittedWarningCount }
            : {}),
        };
      }
    });
    updateShareDockState(sessionId, {
      attempt: shareAttempt,
      publishing: true,
      progress: "collecting",
      completedArtifacts: 0,
      totalArtifacts: 0,
      publishedShareUrl: null,
      error: null,
      warnings: null,
    });
    try {
      const share = await conversationShareService.publish(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          title: shareTitle.trim(),
          accessMode: shareDraft.accessMode,
          selection: { kind: "productTurns", productTurnIds },
          clientRequestId: shareAttempt.clientRequestId,
          disclosureAcceptedAt: shareAttempt.disclosureAcceptedAt,
          locale,
        },
        operationId,
      );
      const warnings = collectedWarnings as ConversationShareDisplayWarnings | null;
      updateShareDockState(sessionId, {
        publishedShareUrl: share.share_url,
        warnings,
      });
      // collectedWarnings 只在 progress 回调里赋值，TS 的控制流分析看不到跨闭包写入，
      // 会把它收窄成 null，这里显式还原真实类型。
      if (warnings) {
        toast(
          intl.formatMessage(
            { id: "conversationShare.publishSucceededWithSkips" },
            { count: warnings.issueCount },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "conversationShare.publishSucceeded" }));
      }
    } catch (error) {
      const details = getConversationShareErrorDetails(error);
      // 401 等传输错误通常没有服务端 issues，不能再降级成 collecting 阶段的通用文案。
      const resolvedMessageId = resolveConversationSharePublishErrorMessageId(error);
      const messageId =
        resolvedMessageId === "conversationShare.publishFailed" ? undefined : resolvedMessageId;
      updateShareDockState(sessionId, {
        attempt: retainConversationShareAttemptAfterFailure(shareAttempt, details.code),
        error:
          details.issues && details.issues.length > 0
            ? {
                issues: details.issues,
                issueCount: details.issueCount ?? details.issues.length,
                omittedIssueCount: details.omittedIssueCount,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                rejection: details.rejection,
              }
            : {
                issues: [
                  {
                    code: resolveConversationShareFallbackIssueCode(details),
                    scope: "transport",
                    phase: activePhase as "collecting" | "uploading" | "checking" | "complete",
                  },
                ],
                issueCount: 1,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                rejection: details.rejection,
                messageId,
              },
      });
      logger.warn("[conversation-share] 会话发布失败", {
        sessionId,
        operationId,
        phase: activePhase,
        accessMode: shareDraft.accessMode,
        selectedProductTurnCount: productTurnIds.length,
        remoteWorkspace: Boolean(workspaceIdentity || remoteSessionId),
        errorName: details.name,
        kind: details.kind,
        ...(details.reasonCode === undefined ? {} : { reasonCode: details.reasonCode }),
        ...(details.diagnostics === undefined ? {} : { diagnostics: details.diagnostics }),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.rejection ? { rejection: details.rejection } : {}),
        ...(details.requestId === undefined ? {} : { requestId: details.requestId }),
      });
    } finally {
      progressSubscription.dispose();
      updateShareDockState(sessionId, { publishing: false });
    }
  }, [
    conversationShareService,
    intl,
    remoteSessionId,
    sessionId,
    shareDraft,
    sharePublishing,
    shareTitle,
    snapshot?.logEpoch,
    snapshot?.revision,
    updateShareDockState,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCopyPublishedShare = useCallback(async () => {
    if (!publishedShareUrl || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(publishedShareUrl);
      toast(intl.formatMessage({ id: "conversationShare.copySucceeded" }));
      return true;
    } catch {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return false;
    }
  }, [intl, publishedShareUrl]);

  const handleOpenPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !onOpenBrowserUrl) return;
    // 服务端保存规范 /cn/share/ 路径；打开时再按当前界面语言切换落地页路径。
    onOpenBrowserUrl(localizeConversationShareUrl(publishedShareUrl, locale));
  }, [locale, onOpenBrowserUrl, publishedShareUrl]);

  const handleCopyShareRequestId = useCallback(() => {
    const requestId = shareError?.requestId;
    if (!requestId || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(requestId).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, shareError?.requestId]);

  const handleShareCancel = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    closeShare(sessionId);
  }, [closeShare, sessionId, sharePublishing]);

  const handleConfirmShareSelection = useCallback(() => {
    if (!sharePublishing && sessionId) confirmShareSelection(sessionId);
  }, [confirmShareSelection, sessionId, sharePublishing]);

  const handleDismissShareError = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { error: null });
  }, [sessionId, updateShareDockState]);
  const handleDismissShareWarnings = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { warnings: null });
  }, [sessionId, updateShareDockState]);

  const handleDeselectShareTurn = useCallback(
    (productTurnId: string) => {
      if (!sessionId || !productTurnId) return;
      // 按 product turn 身份整轮移除：service 的 issue 已带 productTurnId，
      // 不再用 turnOrdinal 索引 UI 的 per-query 列表（两套编号会错位）。
      deselectShareProductTurn(sessionId, productTurnId);
    },
    [deselectShareProductTurn, sessionId],
  );

  const handleShareTitleChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      updateShareDockState(sessionId, {
        title: value,
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, updateShareDockState],
  );

  const handleShareAccessModeChange = useCallback(
    (accessMode: ConversationShareAccessMode) => {
      if (!sessionId) return;
      setShareAccessMode(sessionId, accessMode);
      updateShareDockState(sessionId, {
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, setShareAccessMode, updateShareDockState],
  );

  // 内联回调会让 memo 确认 Dock 每次重渲染；依赖当前 session，避免切换后写回旧会话。
  const handleShareDisclosureAcceptedChange = useCallback(
    (accepted: boolean) => {
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: accepted });
      }
    },
    [sessionId, updateShareDockState],
  );

  const handleEditShareSelection = useCallback(() => {
    if (sharePublishing || publishedShareUrl || !sessionId) return;
    updateShareDockState(sessionId, { error: null });
    beginShareSelection(sessionId);
  }, [beginShareSelection, publishedShareUrl, sessionId, sharePublishing, updateShareDockState]);

  const handleShareConfirm = useCallback(() => {
    if (
      !shareDisclosureAccepted ||
      shareSelectionPanelVisible ||
      sharePreflight.status !== "ready" ||
      sharePreflight.blockingIssues.length > 0
    )
      return;
    void handleConfirmShareDisclosure();
  }, [
    handleConfirmShareDisclosure,
    shareDisclosureAccepted,
    shareSelectionPanelVisible,
    sharePreflight,
  ]);

  const handleShareSelectionToggle = useCallback(
    (rowId: number) => {
      if (sessionId) toggleShareRow(sessionId, rowId);
    },
    [sessionId, toggleShareRow],
  );

  const handleShareSelectionInspect = useCallback(
    (target: { unitIndex: number; rowId: number }) => {
      timelineScrollToQueryRef.current?.(target);
    },
    [],
  );

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(
      replay.type,
      replay.payload,
      replay.sessionId,
      replay.baseRevision,
      undefined,
      undefined,
      undefined,
      undefined,
      replay.clientContext?.projectId,
      replay.clientContext?.sessionCreateSource,
      undefined,
      replay.clientContext?.taskGroupId,
    )
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // 防御 stale UI/旧闭包直接触发跨 workspace replay；正常入口已在 hook 过滤。
            logger.error("[v4-pending-command] 拒绝跨 workspace 提交 createSession 恢复结果", {
              originWorkspaceKey,
              workspaceKey,
            });
            return;
          }
          return handleDraftSessionCreated(
            ack.result.sessionId,
            replay.clientContext?.sessionCreateSource,
            replay.payload.firstInput ? ack.commandId : undefined,
            replay.clientContext?.taskGroupId,
          );
        }
      })
      .catch((error) => {
        // 新 command 已先写入 registry；本次 transport 失败仍可在下次连接继续对账。
        logger.warn("[v4-pending-command] 用户确认重发失败", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  // subagent 右侧 child tab 是观察视图；复用普通 SessionPane 时
  // 若仍创建 composer，会让用户误以为可以直接向 child session 继续输入。
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // Snapshot 仍服务用量、路由与运行态；工具栏的 mode/model 只读下方 Composer Draft。
      snapshot={snapshot}
      inputPending={state.optimisticCommands.some((command) =>
        requiresAcceptedInputProjection(command.type),
      )}
      lifecycle={state.lifecycle}
      sessionId={sessionId}
      // 草稿 taskId 仍为 null，但 prewarm 已经拥有独立 AgentRuntime。
      // 只给 Skill catalog 下发 effective id，避免 UI 扫到 prewarm runtime 尚未加载的新 Skill。
      skillCatalogSessionId={effectiveSessionId}
      pluginUiSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      composerDraftScopeToken={composerDraftScopeToken}
      rootDraftScopeKey={composerScopeKey(newTaskComposerScope)}
      replaceComposerDraft={replaceComposerDraft}
      submissionReady={
        draftProjectReady && composerSubmissionReady && runtimeReady && !recoveringDraft
      }
      stageComposerContent={stageComposerContent}
      captureComposerContentLifecycleCommit={captureComposerContentLifecycleCommit}
      captureComposerSubmissionDraftTransaction={captureComposerSubmissionDraftTransaction}
      updateComposerContent={updateComposerContent}
      persistComposerContent={persistComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      telemetryDraftConfig={telemetryDraftConfig}
      // 完整视图浮窗默认是一条输入框：草稿项目栏不进入浮窗，切到对话 tab 再选择项目。
      contextHeader={isDraft && !isFloatingPresentation ? draftComposerHeader : undefined}
      centered={isDraft}
      layout={isFloatingPresentation ? "inline" : "stacked"}
      workingDurationMs={
        floatingTurnRunning ? floatingLatestTurnSummary?.workDurationMs : undefined
      }
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused && sessionId === null ? composerTextInsertRequest : null}
      onExternalTextInsertApplied={handleExternalTextInsertApplied}
      autoFocusEnabled={focused}
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
      isWebRemoteControl={compactForRemoteControl}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={modelSelectionDisplayView}
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      modelSelectionRefresh={modelSelectionRead.refresh}
      attachmentSessionId={effectiveSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      telemetryVisible={telemetryVisible && conversationTelemetryForegroundEnabled}
      readPlanIdentitySnapshot={readPlanIdentitySnapshot}
      onSendText={handleSendText}
      highspeedCard={activeHighspeedCard}
      highspeedActivationCardId={highspeedActivationCardId}
      onHighspeedActivationApplied={handleHighspeedActivationApplied}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // 父轮结束后 subagents.running 的目录投影可能短暂落后于仍为 running 的
      // backgroundWorks；Composer 若直接读目录会提前隐藏 Agent 入口。这里复用状态面板按
      // childSessionId 精确回退后的计数，让两个入口共享同一份运行态真值。
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      onSendCompressionCommand={handleSendCompressionCommand}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onRetryInitialization={handleRetrySubscribe}
      onRetryError={retryConfigReadEnabled ? handleRetryConfigRead : undefined}
      onOpenModelSettings={handleOpenModelSettings}
      onOpenModelUpgrade={handleOpenModelUpgrade}
      modelConfigTarget={modelConfigTarget}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
    />
  );
  const sharePreflightContent = useMemo(
    () => (
      <ConversationSharePreflightStatus
        preflight={sharePreflight}
        onDeselectTurn={handleDeselectShareTurn}
        onRetryPreflight={retrySharePreflight}
      />
    ),
    [sharePreflight, handleDeselectShareTurn, retrySharePreflight],
  );
  const handleSelectAllShareRows = useCallback(
    (selected: boolean) => {
      if (sessionId) setAllPendingShareRows(sessionId, selected);
    },
    [sessionId, setAllPendingShareRows],
  );
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;
  const sharePopoverContent =
    readOnly || !sessionId ? null : publishedShareUrl ? (
      <ConversationShareSuccessDock
        url={publishedShareUrl}
        title={shareTitle}
        warnings={shareWarnings}
        onOpen={handleOpenPublishedShare}
        onCopy={handleCopyPublishedShare}
        onDismiss={handleShareCancel}
      />
    ) : (
      <ConversationShareConfirmationDock
        preflightChecking={
          sharePreflight.status === "checking" ||
          sharePreflight.status === "stale" ||
          (sharePreflight.status === "idle" && preflightShareProductTurnIds.length > 0)
        }
        selectionEditing={shareSelectionPanelVisible}
        publishDisabled={
          sharePreflight.status !== "ready" || sharePreflight.blockingIssues.length > 0
        }
        preflightContent={sharePreflightContent}
        selectedCount={selectedShareProductTurnIds.length}
        totalCount={eligibleShareProductTurnIds.length}
        title={shareTitle}
        accessMode={shareDraft?.accessMode ?? DEFAULT_CONVERSATION_SHARE_ACCESS_MODE}
        progressLabel={intl.formatMessage({
          id:
            shareProgress === "uploading"
              ? "conversationShare.progress.uploading"
              : shareProgress === "checking"
                ? "conversationShare.progress.checking"
                : "conversationShare.progress.collecting",
        })}
        progressPhase={shareProgress}
        completedArtifacts={shareCompletedArtifacts}
        totalArtifacts={shareTotalArtifacts}
        pending={sharePublishing}
        error={shareError}
        warnings={shareWarnings}
        onDismissError={handleDismissShareError}
        onDismissWarnings={handleDismissShareWarnings}
        onCopyRequestId={handleCopyShareRequestId}
        onDeselectTurn={handleDeselectShareTurn}
        onTitleChange={handleShareTitleChange}
        onAccessModeChange={handleShareAccessModeChange}
        disclosureAccepted={shareDisclosureAccepted}
        onDisclosureAcceptedChange={handleShareDisclosureAcceptedChange}
        onCancel={handleShareCancel}
        onEditSelection={handleEditShareSelection}
        onConfirm={handleShareConfirm}
      />
    );
  // 目录失效仍禁止输入；将宿主已有原因放回原输入区，不在 pane 内探测或恢复目录。
  const conversationBottomDockContent = readOnly ? (
    readOnlyReason ? (
      <div
        role="status"
        data-testid="v4-workspace-readonly-notice"
        className="w-full min-w-0 break-words rounded-xl border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle"
      >
        {readOnlyReason}
      </div>
    ) : null
  ) : (
    <>
      {quotaBanner.state.visible &&
      !quotaBanner.dismissed &&
      (!projectedComposerError || quotaBanner.takesOverError || quotaBanner.state.blocksSubmit) ? (
        <ConversationQuotaBanner
          state={quotaBanner.state}
          onShown={quotaBanner.markShown}
          billingDiscountActive={billingDiscount.active}
          billingDiscountConfig={billingDiscount.config}
          upgradeActionLabelId={quotaBanner.upgradeActionLabelId}
          onUpgrade={
            quotaBanner.upgradeProviderId && codingPlanUpgradeDialog
              ? handleOpenQuotaUpgrade
              : undefined
          }
          onDismiss={quotaBanner.dismiss}
        />
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer ? queueEditOperation.queueItemId : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
        />
      ) : null}
      {/* Bugfix: v4 权限/问答等待态只是 runtime 的阻塞交互，必须和 composer
          共享 timeline bottom dock；渲染在 SessionPane 外层会脱离主列宽度并挤占下半屏。 */}
      {effectiveSessionId && snapshot?.sessionId === effectiveSessionId ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={effectiveSessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          provider={provider}
          snapshot={snapshot}
          onPlanInteractionAccepted={
            compactForRemoteControl ? handleMobilePlanInteractionAccepted : undefined
          }
        />
      ) : null}
      {composerNode}
      {/* 办公模式显示主动任务推荐；编程模式保留原有小型场景入口。 */}
      {/* 完整视图浮窗只露出输入框，草稿推荐提示不进入浮窗。 */}
      {isDraft &&
      !isFloatingPresentation &&
      (!isOfficeMode || sharedSettings?.proactiveSuggestionsEnabled === true) ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          proactive={isOfficeMode}
          onOpenAutomations={
            onOpenAutomationsMain && !compactForRemoteControl
              ? (automationTab) => onOpenAutomationsMain(undefined, automationTab)
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          isDesktop={isDesktop}
        />
      ) : null}
    </>
  );
  // 插件图片与草稿附件共用有效 session，首发提升不迁移附件。
  const pluginUiUploadAttachment = useCallback(
    async (input: { fileName: string; mime: string; dataBase64: string }) => {
      if (!effectiveSessionId) throw new Error("Plugin UI attachments need an open session");
      const { ref } = await attachmentPut({ sessionId: effectiveSessionId, ...input });
      const padding = input.dataBase64.endsWith("==") ? 2 : input.dataBase64.endsWith("=") ? 1 : 0;
      return {
        ref,
        fileName: input.fileName,
        mime: input.mime,
        bytes: Math.floor((input.dataBase64.length * 3) / 4) - padding,
      };
    },
    [attachmentPut, effectiveSessionId],
  );
  // 分享浮窗不再替换输入区，保持 Composer 与对话滚动位置稳定。
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode="chat">
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return (
    <PluginUiSessionProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      sessionId={pluginUiRuntimeReady ? effectiveSessionId : null}
      readOnly={readOnly || !pluginUiRuntimeReady || (sessionId === null && !focused)}
      sendText={dispatchSendText}
      uploadAttachment={pluginUiUploadAttachment}
      projectionStore={pluginUiRuntimeReady ? lease?.store : null}
    >
      <div
        ref={paneRef}
        data-testid={testId(TID_V4_SESSION_PANE, paneId)}
        data-session-id={sessionId ?? "draft"}
        data-session-lifecycle={state.lifecycle?.state}
        data-session-generation={state.lifecycle?.generation}
        data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
        data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
        data-projection-seq={snapshot?.seq ?? ""}
        data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
        data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
          .filter((work) => work.kind === "subagent" && work.status === "running")
          .map((work) => work.childSessionId ?? work.workId)
          .join(",")}
        data-v4-conversation-drop-target="true"
        onDragOver={effectiveDropTargetController?.onDragOver}
        onDragLeave={effectiveDropTargetController?.onDragLeave}
        onDrop={effectiveDropTargetController?.onDrop}
        className={cn(
          "relative flex h-full min-h-0 flex-col",
          compactForRemoteControl && "min-w-0",
        )}
      >
        {effectiveDropTargetController?.active ? (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>
                {intl.formatMessage({
                  id:
                    effectiveDropTargetController.kind === "workspace"
                      ? "chat.composer.workspaceFileDragHint"
                      : "chat.attachments.dragHint",
                })}
              </span>
            </div>
          </div>
        ) : null}
        <ConversationHeader
          title={snapshot?.meta.title ?? ""}
          onClosePane={onClosePane}
          workspaceBadge={workspaceBadge}
        />

        <div
          ref={conversationLayoutContainerRef}
          className={cn(
            "@container/conversation relative flex min-h-0 flex-1 flex-col",
            compactForRemoteControl && "min-w-0",
          )}
        >
          {sessionId && !compactForRemoteControl ? (
            <ConversationSharePopover
              key={sessionId}
              sessionId={sessionId}
              open={shareActive}
              publishing={sharePublishing}
              selecting={shareSelectionPanelVisible}
              onClose={handleShareCancel}
              onCancelSelection={dismissShareSelectionPanel}
            >
              {sharePopoverContent}
            </ConversationSharePopover>
          ) : null}
          <ConversationShareSelectionPanel
            visible={shareSelectionPanelVisible}
            items={shareItems}
            selectedRowIds={pendingShareRowIds}
            selectedCount={pendingShareTurnCount}
            preflight={sharePreflight}
            onSelectAllChange={handleSelectAllShareRows}
            onToggle={handleShareSelectionToggle}
            onInspect={handleShareSelectionInspect}
            onConfirm={handleConfirmShareSelection}
            onCancel={dismissShareSelectionPanel}
          />
          {!isDraft ? (
            <ConversationStatusPanel
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              gitSummary={gitSummary}
              gitDirtyFileCount={gitDirtyFileCount}
              gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
              gitWorktreeChangeSummary={gitWorktreeChangeSummary}
              activeTaskChangeSummary={activeTaskChangeSummary}
              goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
              sessionPlans={state.sessionPlans}
              plan={snapshot?.plan ?? null}
              backgroundWorks={snapshot?.backgroundWorks ?? []}
              runningSubagents={subagents.running}
              workflowRuns={snapshot?.workflowRuns?.runs ?? []}
              endedSubagentCount={subagents.endedTotal}
              rootSessionId={rootSessionId ?? sessionId ?? undefined}
              parentSessionId={sessionId ?? undefined}
              isWebRemoteControl={compactForRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              layoutMode={statusPanelLayout}
              summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
              onVariantChange={handleSummaryPanelVariantChange}
              terminalSectionOpen={terminalSectionOpen}
              onTerminalSectionOpenChange={setTerminalSectionOpen}
              agentSectionOpen={agentSectionOpen}
              onAgentSectionOpenChange={setAgentSectionOpen}
              workflowSectionOpen={workflowSectionOpen}
              onWorkflowSectionOpenChange={setWorkflowSectionOpen}
              onRefreshGit={onRefreshGit}
              onOpenGitReview={onOpenGitReview}
              onPauseGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                  ? handlePauseGoal
                  : undefined
              }
              onResumeGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                  ? handleResumeGoal
                  : undefined
              }
              onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
              onOpenBackgroundBash={
                onOpenBackgroundBash && sessionId
                  ? (work) =>
                      onOpenBackgroundBash({
                        workspacePath,
                        workspaceIdentity: workspaceIdentity ?? undefined,
                        remoteSessionId: remoteSessionId ?? undefined,
                        rootSessionId: rootSessionId ?? sessionId,
                        sessionId,
                        workId: work.workId,
                        title: work.title,
                      })
                  : undefined
              }
              onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
              onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
              onOpenSubagentDirectory={
                onOpenSubagentDirectory && !compactForRemoteControl
                  ? handleOpenSubagentDirectory
                  : undefined
              }
              onOpenWorkflowRun={
                onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined
              }
              endedWorkflowRunCount={endedWorkflowRunCount}
              onOpenWorkflowRunDirectory={
                onOpenWorkflowRunDirectory && !compactForRemoteControl
                  ? handleOpenWorkflowRunDirectoryFromPanel
                  : undefined
              }
            />
          ) : null}

          {readOnly && controlLastError ? (
            <div
              role="alert"
              data-testid="v4-subagent-readonly-error"
              className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
            >
              {controlLastError.message}
            </div>
          ) : null}

          {errored && remoteAvailable ? (
            <SessionSubscriptionErrorPanel
              error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
              sessionId={sessionId}
              workspacePath={workspacePath}
              onReconnect={handleRetrySubscribe}
              reconnectLabel={
                state.lifecycle?.state === "faulted"
                  ? intl.formatMessage({ id: "taskList.recoverWorkspace" })
                  : undefined
              }
            />
          ) : (
            <SessionPluginReferenceIconBoundary
              enabled={pluginReferenceIconsEnabled}
              remoteSessionId={remoteSessionId}
              sessionId={sessionId}
              workspaceIdentity={workspaceIdentity}
              workspacePath={workspacePath}
            >
              <BotGroupDeliveryProvider
                taskId={sessionId}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
              >
                <ConversationTimeline
                  compactForRemoteControl={compactForRemoteControl}
                  scrollToBottomActionRef={timelineScrollToBottomRef}
                  scrollToQueryActionRef={timelineScrollToQueryRef}
                  selectionPanelLayoutContainerRef={conversationLayoutContainerRef}
                  rows={timelineSnapshot?.rows.window ?? []}
                  pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
                  apiRetry={timelineSnapshot?.control.apiRetry ?? null}
                  totalCount={timelineSnapshot?.rows.totalCount ?? 0}
                  sessionKey={sessionId ?? "draft"}
                  scrollMemoryKey={timelineScrollMemoryKey}
                  rowContext={rowContext}
                  onFork={forkActionsEnabled ? handleFork : undefined}
                  onRetry={retryActionsEnabled ? handleRetry : undefined}
                  onFeedbackChange={
                    !readOnly && !selectionSideChat && sessionId
                      ? handleAssistantFeedback
                      : undefined
                  }
                  onEdit={editActionsEnabled ? handleEdit : undefined}
                  canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
                  loadingOlder={timelineSnapshot ? state.loadingOlder : false}
                  onLoadOlder={handleLoadOlder}
                  onLoadAllOlder={handleLoadAllOlder}
                  turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
                  bottomDock={conversationBottomDock}
                  hideTurnNavigator={shareSelectionPanelVisible && !compactForRemoteControl}
                  backgroundScrollLocked={false}
                  headerSlot={
                    // unsupportedRowCount 也要开这个门：整份副本的行都被本 build 跳过时
                    // rows 为空，但只读块必须留下来显示「需要更新 ZCode」，不能整块消失。
                    importedShare &&
                    (importedShare.rows.length > 0 || importedShare.unsupportedRowCount > 0) ? (
                      <ConversationShareImportNotice
                        rows={importedShare.rows}
                        contentBlocks={importedShare.contentBlocks}
                        unsupportedRowCount={importedShare.unsupportedRowCount}
                        artifactNames={importedShareArtifactNames}
                        artifactWorkspaceRelativePaths={importedShareArtifactWorkspaceRelativePaths}
                        workspacePath={workspacePath}
                        {...(workspaceIdentity ? { workspaceIdentity } : {})}
                        {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
                        locale={locale}
                        theme={theme}
                        codePreviewSettings={codePreviewSettings}
                        onOpenShareUrl={onOpenBrowserUrl ? handleOpenImportedShareUrl : undefined}
                        onOpenFileLink={onOpenFileLink}
                        onOpenCodeViewer={onOpenCodeViewer}
                      />
                    ) : null
                  }
                  emptyState={
                    !remoteAvailable ? (
                      <div className="p-6 text-center text-ui-base text-foreground-subtle">
                        {intl.formatMessage({ id: "remote.conversation.placeholder" })}
                      </div>
                    ) : isDraft ? (
                      <div data-testid={TID_CHAT_EMPTY} className="w-full">
                        <ConversationDraftEmptyState
                          compactForRemoteControl={compactForRemoteControl}
                        />
                      </div>
                    ) : null
                  }
                  // 浮窗形态只露出底部输入区，空会话也必须贴底，不能居中。
                  centerEmptyStateWithDock={isDraft && !isFloatingPresentation}
                  floatingComposerDock={isFloatingPresentation}
                  onComposerDockHeightChange={
                    isFloatingPresentation && focused
                      ? panePresentation.reportComposerDockHeight
                      : undefined
                  }
                  onLatestTurnSummaryChange={
                    isFloatingPresentation && focused
                      ? handleFloatingLatestTurnSummaryChange
                      : undefined
                  }
                  compactEmptyStateWithDock={compactForRemoteControl}
                  summaryPanelLayout={statusPanelLayout}
                  conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
                  conversationFindActiveIndex={
                    !isDraft && focused ? conversationFindActiveIndex : -1
                  }
                  conversationFindNavigationRequestId={
                    !isDraft && focused ? conversationFindNavigationRequestId : 0
                  }
                  onConversationFindMatchStateChange={
                    !isDraft && focused ? onConversationFindMatchStateChange : undefined
                  }
                  searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                  sessionPhase={isDraft ? undefined : snapshot?.control.phase}
                  selectionActions={
                    !isDraft &&
                    sessionId &&
                    !readOnly &&
                    !selectionSideChat &&
                    !isMobileTextInputViewport
                      ? {
                          enabled: resolveConversationSelectionTooltipEnabled({
                            selectionActionsEnabled: focused && !blockingInteractionId,
                            partialShareActive: shareActive,
                          }),
                          sideActionDisabled: selectionSideActionBlocked,
                          onAddToCurrentTask: handleAddSelectionToCurrentTask,
                          onAskInSideChat: handleOpenSelectionSideConversation,
                        }
                      : undefined
                  }
                />
              </BotGroupDeliveryProvider>
            </SessionPluginReferenceIconBoundary>
          )}
        </div>
      </div>
    </PluginUiSessionProvider>
  );
}

export { basename, join, resolve as resolvePath } from "node:path";
import {
  createChildTraceContext as createContractChildTraceContext,
  traceContextToLogContext as contractTraceContextToLogContext,
} from "@zcode/contracts";
import type {
  LogContext as ContractLogContext,
  QueryId as ContractQueryId,
  SessionId as ContractSessionId,
  TraceContext as ContractTraceContext,
  TurnId as ContractTurnId,
} from "@zcode/contracts";

export function createQueryId(): ContractQueryId {
  return `query_${crypto.randomUUID()}` as ContractQueryId;
}

export function createChildTraceContext(
  parent: ContractTraceContext,
  options: {
    queryId?: ContractQueryId;
    sessionId?: ContractSessionId;
    rootSessionId?: ContractSessionId;
    turnId?: ContractTurnId;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): ContractTraceContext {
  const child = createContractChildTraceContext(parent, options);
  return {
    ...child,
    queryId: options.queryId ?? parent.queryId,
  };
}

export function traceContextToLogContext(context: ContractTraceContext): ContractLogContext {
  return {
    ...contractTraceContextToLogContext(context),
    queryId: context.queryId,
  };
}

export {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  CoreErrorType,
  EventReducer,
  HookEventName,
  ModelErrorCode,
  RewindScope,
  RewindStrategy,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  createCoreError,
  createModelUsageSummaryFromEvents,
  createMessageId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createToolCallId,
  createTurnId,
  createUnsupportedModelInputMediaText,
  getModelUsageTotalTokens,
  getCurrentTraceContext,
  getCurrentModelInvocationContext,
  getUnsupportedModelInputMediaKind,
  isFileSystemPortError,
  isCoreError,
  isProviderVisibleModelInputMediaBlock,
  isProviderVisiblePdfModelInputBlock,
  isProviderVisibleVideoModelInputBlock,
  modelMessageContentToText,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  parseCompactBoundaryPayload,
  parseWorkspaceCheckpointArtifact,
  evaluateRewindTarget,
  selectActiveConversationBranch,
  formatLocalIsoDate,
  runWithContextAsync,
  runWithModelInvocationContext,
  formatTodoStateForModel,
  formatGoalStateForModel,
  formatGoalContinuationPrompt,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationFailurePrompt,
  formatGoalCompletionVerificationPassedContent,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  escapeGoalPromptText,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_TARGET_BYTES,
  VIDEO_INPUT_MAX_BYTES,
  READ_VIDEO_MAX_INPUT_BYTES,
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  BROWSER_TURN_SCREENSHOT_SOURCE,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
} from "@zcode/contracts";
export type {
  CollaborationMode,
  GoalStatus,
  Logger,
  AttachmentStorageMetadata,
  AutomationPort,
  OffPeakPort,
  TopicResourcePort,
  BackgroundExecutionSnapshot,
  BackgroundTaskCancelResult,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
  CompactBoundaryPayload,
  CompactPreservedSegment,
  CompactTimelinePayload,
  MessageAnchorOrigin,
  MessageId,
  MessageWithParts,
  MessageInfo,
  MessagePart,
  MessageProjectionAnchor,
  MessageSemantics,
  MessageVisibility,
  SavedWorkflowScope,
  WorkflowLaunchMeta,
  FilePartSource,
  ModelSelectionOrigin,
  ModelNetworkStatusEvent,
  ModelAnomalyGuardConfig,
  Model,
  ModelEvent,
  ModelInvocationContext,
  ModelOptions,
  ModelProperties,
  ModelRequest,
  ModelRequestAdmission,
  ModelSelection,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  ModelStreamEvent,
  ModelStreamingPayload,
  ModelToolSideEffectScope,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelVideoContentBlock,
  ModelInputMessage,
  ModelInputFormat,
  ModelReasoningContentBlock,
  ModelTextContentBlock,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  PendingInputEditLock,
  PendingSteerInputInfo,
  PendingTurnInput,
  TurnAttachmentMeta,
  PartId,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  PermissionUpdate,
  ProjectId,
  SessionEvent,
  SessionEntryInfo,
  SessionEventSink,
  SessionEventStorePort,
  SessionInfo,
  SessionMailboxEnvelope,
  SessionMailboxPort,
  SessionModePort,
  StreamRecoveryAnchorPayload,
  StreamingToolExecutionTiming,
  StreamingToolLedgerPayload,
  StreamingToolLedgerStatus,
  DynamicWorkflowRunProgressPayload,
  TargetChangedPayload,
  UserInputAutoResolutionUpdatedPayload,
  TargetCompletionVerificationPayload,
  TimelinePart,
  TimelinePartDraft,
  GoalCompletionVerificationOutput,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SessionTaskType,
  SessionTitleSource,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  InteractionRequestOrigin,
  HooksRuntimeConfig,
  SkillLoadOutcome,
  SkillContent,
  SkillOperationOptions,
  SkillPort,
  SyntheticUserMessageSource,
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  SubagentPort,
  SubagentTaskSnapshot,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowSubmitPort,
  TodoItem,
  SessionGoal,
  SessionModeChangedPayload,
  QueryId,
  TokenUsageInfo,
  TraceContext,
  TraceId,
  TurnFileChangeSummary,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnExecutionKind,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
  ContextSourceSnapshot,
  DiffHunk,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  CompletedToolPartMetadata,
} from "@zcode/contracts";
export type { ToolCall, TurnAttachment, TurnState } from "../agent/turn-state.js";
export {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "../agent/session-history-hydrator.js";
export type { SessionHistoryHydrationResult } from "../agent/session-history-hydrator.js";
export { hydrateReadFileStateFromSession } from "../agent/read-file-state-hydrator.js";
export type { ReadFileStateHydrationResult } from "../agent/read-file-state-hydrator.js";
export { countContextPrefixMessages, MessageHistoryImpl } from "../agent/message-history.js";
export type { MessageHistory } from "../agent/message-history.js";
export { TurnMachineImpl } from "../agent/turn-machine.js";
export {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
} from "../hooks/index.js";
export type { HookRunner, HookRunResult } from "../hooks/index.js";
export type { ToolDependency, ToolSchedule } from "../tool/scheduler.js";
export { defaultToolScheduler as defaultScheduler, ToolScheduler } from "../tool/scheduler.js";
export { PermissionService, defaultPermissionConfig } from "../permission/service.js";
export { createDenyPermissionBroker } from "../permission/broker.js";
export { createToolExecutor, createToolRegistry, registerBuiltInTools } from "../tool/index.js";
export type {
  ExecutableToolCall,
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
} from "../tool/index.js";
export type {
  ContextBuilder,
  ContextBuilderConfig,
  ContextBuildResult,
  OutputStylePromptConfig,
} from "../context/index.js";
export { createContextBuilder, estimateTokens } from "../context/index.js";
export type { EnvInfo, ProjectContext, UserInstructionsOptions } from "../context/index.js";
export {
  COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  estimateMessageTokens,
  formatCompactSummary,
  getAutoCompactThreshold,
  getMessagesToSummarize,
  getUsageTotalTokens,
  maybeLocalMicrocompactMessages,
  shouldAutoCompact,
  buildDefaultMicrocompactThreshold,
} from "../compact/index.js";
export type { AutoCompactPolicyConfig } from "../compact/index.js";
export type { AutoCompactTokenOverride } from "../compact/index.js";
export type { LocalMicrocompactPolicyConfig } from "../compact/index.js";
export {
  EXPLORE_AGENT_ALLOWED_TOOLS,
  EXPLORE_AGENT_TYPE,
  GENERAL_PURPOSE_AGENT_TYPE,
  DEFAULT_SUBAGENT_TYPE,
  buildGeneralPurposeSystemPrompt,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  buildExploreSystemPrompt,
  createSubagentContextBuilder,
  createExploreSubagentPort,
} from "../subagent/index.js";
export type { AgentProfile, ExploreSubagentRuntimeRequest } from "../subagent/index.js";
export { registerMcpTools } from "../mcp/index.js";
export type { PluginDiscoveryPort } from "@zcode/contracts";

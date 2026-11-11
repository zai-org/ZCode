import type { AgentRuntimeInternal } from "../internal.js";
import { sampleModel } from "./sample-model.js";
import { grantPermissionMode } from "../permission-full-access.js";
import {
  getSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded,
  updateConfig,
  setExecutionState,
} from "./config.js";
import { getMode, getPlanEnabled } from "./config.js";
import { getSessionModelSelection, setSessionModelSelection } from "./config.js";
import { getProjectId } from "./config.js";
import { setWorkingDirectory } from "./config.js";
import { ensureSessionPersistedForExternalActivity } from "./config.js";
import { getActiveTurnInfo } from "./config.js";
import { getTools } from "./config.js";
import { invalidateToolCache } from "./config.js";
import { getToolRegistry } from "./config.js";
import { getToolExecutor } from "./config.js";
import { subscribeEvents } from "./config.js";
import {
  markContextCompositionChanged,
  subscribeContextCompositionChanged,
} from "../context-composition/state.js";
import { getContextComposition } from "../context-composition/query.js";
import { getSessionEventStore } from "./config.js";
import { notifyExternalChildSessionEvent } from "./config.js";
import { createChildClientPorts } from "./config.js";
import { getContextBuilder } from "./config.js";
import { getPendingPermissionRequests } from "./config.js";
import { recordUserInputAutoResolutionUpdate } from "./interaction-auto-resolution.js";
import { recordDynamicWorkflowRunProgress } from "./dynamic-workflow-run-progress.js";
import { trackResumedDynamicWorkflowRun } from "./dynamic-workflow-run-track.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";
import { recordSessionFeature } from "../session-features/contract.js";
import { startSavedWorkflowRun } from "./dynamic-workflow-run-start.js";
import { amendWorkflowRunSettings } from "./dynamic-workflow-run-settings.js";
import { getProjection } from "./config.js";
import { getSessionId } from "./config.js";
import { enqueueDeferredInput } from "./steering.js";
import { steerTurn } from "./steering.js";
import { beginActiveTurn } from "./steering.js";
import { reserveTurnStart } from "./steering.js";
import { releaseTurnStart } from "./steering.js";
import { finishActiveTurn } from "./steering.js";
import { createPendingInputId } from "./steering.js";
import { rejectTurnSteer } from "./steering.js";
import { hasPendingInput } from "./steering.js";
import { hasInlineGuidePendingInput } from "./steering.js";
import { fallbackPendingGuidesToQueue } from "./steering.js";
import { drainPendingInput } from "./steering.js";
import {
  enqueueBackgroundTaskNotification,
  sealBackgroundTaskNotifications,
} from "./background-notifications.js";
import { drainPendingRuntimeCommandsForActiveLoop } from "./runtime-command-active-loop.js";
import { enqueueSubagentMessage } from "./subagent-messages.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
  enqueueRuntimeCommand,
  getActiveForegroundExecutionId,
  hasActiveOrQueuedTurnWork,
  releaseForegroundPromotionLease,
  stopActiveForegroundExecution,
} from "./runtime-command-queue.js";
import { hasResidencyBlockingWork, trackResidencyBlockingWork } from "./residency.js";
import {
  clearAllPendingInputs,
  completeExternalQueueDrain,
  discardHeldPendingInputById,
  discardPendingInput,
  editPendingInputById,
  emitModeChanged,
  getPendingInputEditLock,
  lockPendingInputEdit,
  releasePendingInputEdit,
  emitModelSelected,
  markPendingInputPromoting,
  releasePendingInputReservation,
  removePendingInputById,
  reorderPendingInput,
  reservePendingInputById,
  setFollowupMode,
  setQueueAutoDrain,
} from "./steering.js";
import { discardPersistedPendingSteerInputs } from "./steering.js";
import { createDefaultSubagentPort } from "./subagent.js";
import { ensureContextInitialized, getSkillCatalog } from "./context.js";
import { createContextBuilderFromSnapshot } from "./context.js";
import { loadProjectMemoryRoot } from "./context.js";
import { logMemorySkipped } from "./context.js";
import { injectPluginReferenceReminderFromTurn } from "./plugin-reference.js";
import { initializeMcp, refreshMcpToolsIfChanged } from "./mcp.js";
import { startMcpStartup } from "./mcp.js";
import { discoverSkillsForContext } from "./context.js";
import { createConfigOnlyContextSnapshot } from "./context.js";
import { initializeMessageHistoryFromContext } from "./context.js";
import { extractToolCallsFromResult } from "./context.js";
import { shouldStreamModelText } from "./context.js";
import { runModelTextRequest } from "./model.js";
import { emitModelStreamingEvent } from "./model-streaming-event.js";
import { createModelStatusSink } from "./model-status.js";
import { logModelNetworkStatus } from "./model-status.js";
import { logContextUsageSnapshot } from "./context-usage.js";
import { logModelRequestSteeringContext } from "./context-usage.js";
import { buildModelMessageTailDiagnostics } from "./context-usage.js";
import { buildContextUsageSnapshot } from "./context-usage.js";
import { buildContextUsageBreakdownFromSnapshot } from "./context-usage.js";
import { buildContextUsageCategory } from "./context-usage.js";
import { buildToolUsageDetail } from "./context-usage.js";
import { buildSkillUsageDetails } from "./context-usage.js";
import { buildMessageRoleBreakdown } from "./context-usage.js";
import { estimatedMetric } from "./context-usage.js";
import { estimatedMetricFromKnown } from "./context-usage.js";
import { sumMetrics } from "./context-usage.js";
import { toScheduleState } from "./resume.js";
import { resumeFromStore } from "./resume.js";
import { readSessionTodosForContext } from "./resume.js";
import { readSessionTargetForContext } from "./resume.js";
import { injectTargetStateIntoMessageHistory } from "./resume.js";
import { recordTargetChanged } from "./target.js";
import { recordGoalStateChangeReminder } from "./goal-state-reminder.js";
import { continueActiveTargetIfIdle } from "./target.js";
import { continueActiveTargetLoop } from "./target-continuation-loop.js";
import { targetContinuationCandidate } from "./target.js";
import { accountTargetTurnCompletion } from "./target.js";
import { startTargetTurnAccounting } from "./target.js";
import { heartbeatTargetTurnAccounting } from "./target.js";
import { finishTargetTurnAccounting } from "./target.js";
import { pauseActiveTargetForCancellation } from "./target.js";
import { activatePausedTargetAfterResume } from "./target.js";
import {
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
  shouldContinueAfterStopHooks,
} from "./hooks.js";
import { executeTurn, executeTurnCommand } from "./turn.js";
import { admitPrompt } from "./prompt-admission.js";
import { executeManualCompact } from "./compact.js";
import { autoCompactIfNeeded } from "./compact.js";
import { microcompactIfNeeded } from "./microcompact.js";
import { reactiveCompactAfterContextExceeded } from "./compact.js";
import { compactActiveConversation } from "./compact-active.js";
import { executeRewindCommand } from "./rewind.js";
import { formatRewindStatus } from "./rewind.js";
import { rewindWorkspaceToCheckpoint } from "./rewind.js";
import { finishUnavailableRewind } from "./rewind.js";
import { rewindConversationToMessage } from "./rewind-message.js";
import { rewindCascadeToMessage } from "./rewind-message.js";
import { rewindToMessage } from "./rewind-message.js";
import { rewindWorkspaceToMessage } from "./rewind-message.js";
import { restoreWorkspaceCheckpointArtifact } from "./workspace-checkpoints.js";
import { copySessionMessagesForFork } from "./workspace-checkpoints.js";
import { listWorkspaceCheckpoints } from "./workspace-checkpoints.js";
import { forkWorkspaceFromCheckpoint } from "./workspace-checkpoints.js";
import {
  createSelectionSideConversation,
  forkConversationBeforeMessage,
  forkStableConversationAtMessage,
} from "./session-fork.js";
import { loadCheckpointMessagePreviews } from "./workspace-checkpoints.js";
import { applyWorkspaceFileRewind, previewWorkspaceFileRewind } from "./file-rewind.js";
import { scheduleTools } from "./tools.js";
import { executeTools } from "./tools.js";
import { emitToolScheduledEvents } from "./tools.js";
import { emitFileMutationCheckpoint } from "./tools.js";
import { emitPermissionRequest } from "./tools.js";
import { resolvePermission } from "./tools.js";
import {
  cancelBackgroundTask,
  cancelRunningRuntimeBackgroundTasks,
  hasRunningBackgroundTasks,
  stopBackgroundTask,
} from "./background.js";
import { buildBackgroundTaskPayload } from "./background.js";
import { readBackgroundBashOutput } from "./background-bash-output.js";
import { createEvent } from "./events.js";
import { appendEvent } from "./events.js";
import { notifyEventSinks } from "./events.js";
import { ensureSessionPersisted, isSessionPersisted } from "./events.js";
import { buildCompactTimelinePayload } from "./compact-persistence.js";
import { persistCompactTimeline } from "./compact-persistence.js";
import { finishCompactTimelineFailure } from "./compact-persistence.js";
import { recoverInterruptedCompactTimelines } from "./compact-persistence.js";
import { persistCompactSummary } from "./compact-persistence.js";
import { recordExternalUserPrompt } from "./control-only-turn.js";
import { persistUserPrompt } from "./message-persistence.js";
import { persistSyntheticUserNotice } from "./message-persistence.js";
import { persistSyntheticUserNoticeForSession } from "./message-persistence.js";
import { persistAssistantMessage } from "./message-persistence.js";
import { persistMessage } from "./message-persistence.js";
import { persistPart } from "./message-persistence.js";
import { rebuildProjection } from "./message-persistence.js";
import {
  persistPendingWorktreeCreationTimeline,
  recordPendingModelChange,
  recordPendingWorktreeCreation,
} from "./timeline-persistence.js";
import { persistPendingModelChangeTimeline } from "./timeline-persistence.js";
import { persistAssistantTimelinePartForSession } from "./timeline-persistence.js";
import { generateWorkspaceText, testModelConnectivity } from "./workspace-generate-text.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { maybeStartSessionTitleGenerationFromExternalInput } from "./session-title.js";
import { setCustomSessionTitle } from "./session-title.js";
import {
  drainMemoryExtractions,
  isProjectMemoryEnabled,
} from "../helpers/project-memory-extraction.js";

type AgentRuntimeConstructor = { prototype: object };

export function installAgentRuntimeMethods(ctor: AgentRuntimeConstructor): void {
  const proto = ctor.prototype as Record<string, unknown>;
  proto.updateConfig = updateConfig;
  proto.setExecutionState = setExecutionState;
  proto.grantPermissionMode = grantPermissionMode;
  proto.initializeSessionShellEnvironmentIfNeeded = initializeSessionShellEnvironmentIfNeeded;
  proto.getSessionShellSelection = getSessionShellSelection;
  proto.getMode = getMode;
  proto.getPlanEnabled = getPlanEnabled;
  proto.getSessionModelSelection = getSessionModelSelection;
  proto.setSessionModelSelection = setSessionModelSelection;
  proto.getProjectId = getProjectId;
  proto.setWorkingDirectory = setWorkingDirectory;
  proto.ensureSessionPersistedForExternalActivity = ensureSessionPersistedForExternalActivity;
  proto.maybeStartSessionTitleGenerationFromExternalInput =
    maybeStartSessionTitleGenerationFromExternalInput;
  proto.setCustomSessionTitle = setCustomSessionTitle;
  proto.maybeStartGoalSummaryTitleGeneration = maybeStartGoalSummaryTitleGeneration;
  proto.testModelConnectivity = testModelConnectivity;
  proto.recordExternalUserPrompt = recordExternalUserPrompt;
  proto.getActiveTurnInfo = getActiveTurnInfo;
  proto.getTools = getTools;
  proto.invalidateToolCache = invalidateToolCache;
  proto.getToolRegistry = getToolRegistry;
  proto.getToolExecutor = getToolExecutor;
  proto.subscribeEvents = subscribeEvents;
  proto.getContextComposition = getContextComposition;
  proto.subscribeContextCompositionChanged = subscribeContextCompositionChanged;
  proto.markContextCompositionChanged = markContextCompositionChanged;
  proto.getSessionEventStore = getSessionEventStore;
  proto.notifyExternalChildSessionEvent = notifyExternalChildSessionEvent;
  proto.createChildClientPorts = createChildClientPorts;
  proto.getContextBuilder = getContextBuilder;
  proto.getPendingPermissionRequests = getPendingPermissionRequests;
  proto.recordUserInputAutoResolutionUpdate = recordUserInputAutoResolutionUpdate;
  proto.recordDynamicWorkflowRunProgress = recordDynamicWorkflowRunProgress;
  proto.trackResumedDynamicWorkflowRun = trackResumedDynamicWorkflowRun;
  proto.activateDynamicWorkflowTools = activateDynamicWorkflowTools;
  proto.recordSessionFeature = recordSessionFeature;
  proto.startSavedWorkflowRun = startSavedWorkflowRun;
  proto.amendWorkflowRunSettings = amendWorkflowRunSettings;
  proto.getProjection = getProjection;
  proto.getSessionId = getSessionId;
  proto.enqueueDeferredInput = enqueueDeferredInput;
  proto.steerTurn = steerTurn;
  proto.beginActiveTurn = beginActiveTurn;
  proto.reserveTurnStart = reserveTurnStart;
  proto.releaseTurnStart = releaseTurnStart;
  proto.finishActiveTurn = finishActiveTurn;
  proto.createPendingInputId = createPendingInputId;
  proto.rejectTurnSteer = rejectTurnSteer;
  proto.hasPendingInput = hasPendingInput;
  proto.hasInlineGuidePendingInput = hasInlineGuidePendingInput;
  proto.fallbackPendingGuidesToQueue = fallbackPendingGuidesToQueue;
  proto.drainPendingInput = drainPendingInput;
  proto.enqueueRuntimeCommand = enqueueRuntimeCommand;
  proto.drainRuntimeCommandQueue = drainRuntimeCommandQueue;
  proto.hasActiveOrQueuedTurnWork = hasActiveOrQueuedTurnWork;
  proto.hasResidencyBlockingWork = hasResidencyBlockingWork;
  proto.trackResidencyBlockingWork = trackResidencyBlockingWork;
  proto.acquireForegroundPromotionLease = acquireForegroundPromotionLease;
  proto.getActiveForegroundExecutionId = getActiveForegroundExecutionId;
  proto.releaseForegroundPromotionLease = releaseForegroundPromotionLease;
  proto.stopActiveForegroundExecution = stopActiveForegroundExecution;
  proto.enqueueBackgroundTaskNotification = enqueueBackgroundTaskNotification;
  proto.enqueueSubagentMessage = enqueueSubagentMessage;
  proto.drainPendingRuntimeCommandsForActiveLoop = drainPendingRuntimeCommandsForActiveLoop;
  proto.sealBackgroundTaskNotifications = sealBackgroundTaskNotifications;
  proto.discardPendingInput = discardPendingInput;
  proto.removePendingInputById = removePendingInputById;
  proto.reservePendingInputById = reservePendingInputById;
  proto.markPendingInputPromoting = markPendingInputPromoting;
  proto.releasePendingInputReservation = releasePendingInputReservation;
  proto.editPendingInputById = editPendingInputById;
  proto.lockPendingInputEdit = lockPendingInputEdit;
  proto.releasePendingInputEdit = releasePendingInputEdit;
  proto.getPendingInputEditLock = getPendingInputEditLock;
  proto.reorderPendingInput = reorderPendingInput;
  proto.setQueueAutoDrain = setQueueAutoDrain;
  proto.completeExternalQueueDrain = completeExternalQueueDrain;
  proto.setFollowupMode = setFollowupMode;
  proto.emitModelSelected = emitModelSelected;
  proto.emitModeChanged = emitModeChanged;
  proto.discardPersistedPendingSteerInputs = discardPersistedPendingSteerInputs;
  proto.discardHeldPendingInputById = discardHeldPendingInputById;
  proto.clearAllPendingInputs = clearAllPendingInputs;
  proto.createDefaultSubagentPort = createDefaultSubagentPort;
  proto.ensureContextInitialized = ensureContextInitialized;
  proto.getSkillCatalog = getSkillCatalog;
  proto.createContextBuilderFromSnapshot = createContextBuilderFromSnapshot;
  proto.loadProjectMemoryRoot = loadProjectMemoryRoot;
  proto.logMemorySkipped = logMemorySkipped;
  proto.injectPluginReferenceReminderFromTurn = injectPluginReferenceReminderFromTurn;
  proto.initializeMcp = initializeMcp;
  proto.refreshMcpToolsIfChanged = refreshMcpToolsIfChanged;
  proto.startMcpStartup = startMcpStartup;
  proto.discoverSkillsForContext = discoverSkillsForContext;
  proto.createConfigOnlyContextSnapshot = createConfigOnlyContextSnapshot;
  proto.initializeMessageHistoryFromContext = initializeMessageHistoryFromContext;
  proto.extractToolCallsFromResult = extractToolCallsFromResult;
  proto.shouldStreamModelText = shouldStreamModelText;
  proto.runModelTextRequest = runModelTextRequest;
  proto.emitModelStreamingEvent = emitModelStreamingEvent;
  proto.createModelStatusSink = createModelStatusSink;
  proto.logModelNetworkStatus = logModelNetworkStatus;
  proto.logContextUsageSnapshot = logContextUsageSnapshot;
  proto.logModelRequestSteeringContext = logModelRequestSteeringContext;
  proto.buildModelMessageTailDiagnostics = buildModelMessageTailDiagnostics;
  proto.buildContextUsageSnapshot = buildContextUsageSnapshot;
  proto.buildContextUsageBreakdownFromSnapshot = buildContextUsageBreakdownFromSnapshot;
  proto.buildContextUsageCategory = buildContextUsageCategory;
  proto.buildToolUsageDetail = buildToolUsageDetail;
  proto.buildSkillUsageDetails = buildSkillUsageDetails;
  proto.buildMessageRoleBreakdown = buildMessageRoleBreakdown;
  proto.estimatedMetric = estimatedMetric;
  proto.estimatedMetricFromKnown = estimatedMetricFromKnown;
  proto.sumMetrics = sumMetrics;
  proto.toScheduleState = toScheduleState;
  proto.resumeFromStore = resumeFromStore;
  proto.readSessionTodosForContext = readSessionTodosForContext;
  proto.readSessionTargetForContext = readSessionTargetForContext;
  proto.injectTargetStateIntoMessageHistory = injectTargetStateIntoMessageHistory;
  proto.recordTargetChanged = recordTargetChanged;
  proto.recordGoalStateChangeReminder = recordGoalStateChangeReminder;
  proto.continueActiveTargetIfIdle = continueActiveTargetIfIdle;
  proto.continueActiveTargetLoop = continueActiveTargetLoop;
  proto.targetContinuationCandidate = targetContinuationCandidate;
  proto.accountTargetTurnCompletion = accountTargetTurnCompletion;
  proto.startTargetTurnAccounting = startTargetTurnAccounting;
  proto.heartbeatTargetTurnAccounting = heartbeatTargetTurnAccounting;
  proto.finishTargetTurnAccounting = finishTargetTurnAccounting;
  proto.pauseActiveTargetForCancellation = pauseActiveTargetForCancellation;
  proto.activatePausedTargetAfterResume = activatePausedTargetAfterResume;
  proto.runSessionStartHooks = runSessionStartHooks;
  proto.runUserPromptSubmitHooks = runUserPromptSubmitHooks;
  proto.runStopHooks = runStopHooks;
  proto.shouldContinueAfterStopHooks = shouldContinueAfterStopHooks;
  proto.executeTurn = executeTurn;
  proto.admitPrompt = admitPrompt;
  proto.executeTurnCommand = function (
    this: AgentRuntimeInternal,
    ...args: Parameters<typeof executeTurnCommand>
  ) {
    return this.trackResidencyBlockingWork(executeTurnCommand.apply(this, args));
  };
  proto.executeManualCompact = executeManualCompact;
  proto.autoCompactIfNeeded = autoCompactIfNeeded;
  proto.microcompactIfNeeded = microcompactIfNeeded;
  proto.reactiveCompactAfterContextExceeded = reactiveCompactAfterContextExceeded;
  proto.compactActiveConversation = compactActiveConversation;
  proto.executeRewindCommand = executeRewindCommand;
  proto.formatRewindStatus = formatRewindStatus;
  proto.rewindWorkspaceToCheckpoint = rewindWorkspaceToCheckpoint;
  proto.rewindToMessage = rewindToMessage;
  proto.rewindCascadeToMessage = rewindCascadeToMessage;
  proto.rewindConversationToMessage = rewindConversationToMessage;
  proto.rewindWorkspaceToMessage = rewindWorkspaceToMessage;
  proto.finishUnavailableRewind = finishUnavailableRewind;
  proto.restoreWorkspaceCheckpointArtifact = restoreWorkspaceCheckpointArtifact;
  proto.copySessionMessagesForFork = copySessionMessagesForFork;
  proto.listWorkspaceCheckpoints = listWorkspaceCheckpoints;
  proto.forkWorkspaceFromCheckpoint = forkWorkspaceFromCheckpoint;
  proto.forkStableConversationAtMessage = forkStableConversationAtMessage;
  proto.createSelectionSideConversation = createSelectionSideConversation;
  proto.forkConversationBeforeMessage = forkConversationBeforeMessage;
  proto.loadCheckpointMessagePreviews = loadCheckpointMessagePreviews;
  proto.previewWorkspaceFileRewind = previewWorkspaceFileRewind;
  proto.applyWorkspaceFileRewind = applyWorkspaceFileRewind;
  proto.scheduleTools = scheduleTools;
  proto.executeTools = executeTools;
  proto.emitToolScheduledEvents = emitToolScheduledEvents;
  proto.emitFileMutationCheckpoint = emitFileMutationCheckpoint;
  proto.emitPermissionRequest = emitPermissionRequest;
  proto.resolvePermission = resolvePermission;
  proto.readBackgroundBashOutput = readBackgroundBashOutput;
  proto.cancelBackgroundTask = cancelBackgroundTask;
  proto.stopBackgroundTask = stopBackgroundTask;
  proto.cancelRunningRuntimeBackgroundTasks = cancelRunningRuntimeBackgroundTasks;
  proto.hasRunningBackgroundTasks = hasRunningBackgroundTasks;
  proto.buildBackgroundTaskPayload = buildBackgroundTaskPayload;
  proto.createEvent = createEvent;
  proto.appendEvent = appendEvent;
  proto.notifyEventSinks = notifyEventSinks;
  proto.ensureSessionPersisted = ensureSessionPersisted;
  proto.isSessionPersisted = isSessionPersisted;
  proto.buildCompactTimelinePayload = buildCompactTimelinePayload;
  proto.persistCompactTimeline = persistCompactTimeline;
  proto.finishCompactTimelineFailure = finishCompactTimelineFailure;
  proto.recoverInterruptedCompactTimelines = recoverInterruptedCompactTimelines;
  proto.persistCompactSummary = persistCompactSummary;
  proto.persistUserPrompt = persistUserPrompt;
  proto.recordPendingModelChange = recordPendingModelChange;
  proto.recordPendingWorktreeCreation = recordPendingWorktreeCreation;
  proto.persistPendingWorktreeCreationTimeline = persistPendingWorktreeCreationTimeline;
  proto.persistPendingModelChangeTimeline = persistPendingModelChangeTimeline;
  proto.persistSyntheticUserNotice = persistSyntheticUserNotice;
  proto.persistSyntheticUserNoticeForSession = persistSyntheticUserNoticeForSession;
  proto.persistAssistantTimelinePartForSession = persistAssistantTimelinePartForSession;
  proto.persistAssistantMessage = persistAssistantMessage;
  proto.persistMessage = persistMessage;
  proto.persistPart = persistPart;
  proto.rebuildProjection = rebuildProjection;
  proto.generateWorkspaceText = generateWorkspaceText;
  proto.sampleModel = sampleModel;
  proto.drainMemoryExtractions = drainMemoryExtractions;
  proto.isProjectMemoryEnabled = isProjectMemoryEnabled;
}

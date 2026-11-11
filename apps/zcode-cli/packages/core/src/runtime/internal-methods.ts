import type {
  CollaborationMode,
  Model,
  ModelInputMessage,
  ModelSelection,
  ModelSelectionOrigin,
  ModelUsageSummary,
  ModelStreamingPayload,
  ModelToolCall,
  ModelToolContract,
  MessageId,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SkillLoadOutcome,
  SubagentPort,
  TodoItem,
  SessionGoal,
  McpConnectionSnapshot,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnId,
  ContextSourceSnapshot,
  TurnState,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ExecutionShellSelection,
  PendingInputEditLock,
} from "./deps.js";
import type { BackgroundResultOriginMeta, ContextUsageBreakdownItem } from "@zcode/contracts";
import type { RuntimeCommand, RuntimeCommandId } from "./command-queue.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  ActiveTurnInfo,
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnKind,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContextUsageCategory,
  ContextUsageConfidence,
  ContextUsageMetric,
  ContextUsageMessageRoleBreakdown,
  ContextUsageSkillDetail,
  ContextUsageToolDetail,
  ContinueActiveTargetLoopOptions,
  DrainedPendingInputDiagnostics,
  ForegroundPromotionLeaseMode,
  EnqueueSubagentMessageInput,
  ResumeSessionOptions,
  ResumeSessionResult,
  RunModelTextRequestOptions,
  RuntimeModelTextResult,
  SealBackgroundTaskNotificationsInput,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  EditPendingInputOptions,
  EditPendingInputResult,
  LockPendingInputEditResult,
} from "./types.js";

export interface AgentRuntimeCoreMethods {
  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionMode(
    interactionId: string,
    mode: "guarded" | "yolo",
    signal?: AbortSignal,
  ): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  getProjectId(): ProjectId;
  setWorkingDirectory(cwd: string): void;
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  beginActiveTurn(
    turnId: TurnId,
    traceContext: TraceContext,
    kind: ActiveTurnKind,
    steerable: boolean,
    options?: { inputId?: string },
  ): ActiveTurnSteeringState;
  reserveTurnStart(turnId: TurnId, traceContext: TraceContext, kind: ActiveTurnKind): void;
  releaseTurnStart(turnId: TurnId): void;
  finishActiveTurn(activeTurn: ActiveTurnSteeringState | undefined): void;
  createPendingInputId(turnId: TurnId): string;
  rejectTurnSteer(
    reason: TurnSteerRejectReason,
    options: {
      activeTurn?: ActiveTurnSteeringState;
      expectedTurnId?: TurnId;
      inputPreview?: string;
      inputSize?: number;
      traceContext?: TraceContext;
    },
  ): Promise<TurnSteerResult>;
  hasPendingInput(activeTurn: ActiveTurnSteeringState): boolean;
  hasInlineGuidePendingInput(activeTurn: ActiveTurnSteeringState): boolean;
  fallbackPendingGuidesToQueue(options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  }): Promise<number>;
  drainPendingInput(options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  }): Promise<DrainedPendingInputDiagnostics | undefined>;
  enqueueRuntimeCommand(command: RuntimeCommand): void;
  drainRuntimeCommandQueue(): Promise<void>;
  hasActiveOrQueuedTurnWork(): boolean;
  hasResidencyBlockingWork(): boolean;
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  enqueueBackgroundTaskNotification(notification: {
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  }): void;
  enqueueSubagentMessage(input: EnqueueSubagentMessageInput): undefined;
  drainPendingRuntimeCommandsForActiveLoop(): Promise<{
    backgroundSubagentResultConsumed: boolean;
    workflowResultConsumed: boolean;
    consumedCommandIds: RuntimeCommandId[];
    drained: number;
    messageIds: MessageId[];
    runtimeEntries: readonly RuntimeMessageEntry[];
  }>;
  sealBackgroundTaskNotifications(input: SealBackgroundTaskNotificationsInput): void;
  discardPendingInput(options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  }): Promise<void>;
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  editPendingInputById(
    options: EditPendingInputOptions & { traceContext: TraceContext },
  ): Promise<EditPendingInputResult>;
  lockPendingInputEdit(options: {
    pendingInputId: string;
    editLock: PendingInputEditLock;
    traceContext: TraceContext;
  }): Promise<LockPendingInputEditResult>;
  releasePendingInputEdit(options: {
    pendingInputId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  getPendingInputEditLock(pendingInputId: string): PendingInputEditLock | undefined;
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  }): Promise<boolean>;
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext: TraceContext }): Promise<void>;
  completeExternalQueueDrain(): void;
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext: TraceContext }): Promise<void>;
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  }): Promise<void>;
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  discardPersistedPendingSteerInputs(traceContext: TraceContext): Promise<number>;
  /** held 项按 id 丢弃（held 回落）：active turn 结束后经投影定位补 TurnSteerDiscarded。 */
  discardHeldPendingInputById(
    pendingInputId: string,
    traceContext: TraceContext,
    reservationId?: string,
    reason?: "user_removed" | "promoted",
  ): Promise<boolean>;
  /** 清空全部排队输入（clearQueueAndSend 执行件），返回丢弃条数。 */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  createDefaultSubagentPort(deps: AgentRuntimeDeps): SubagentPort | undefined;
  getTools(model?: Model): ModelToolContract[];
  invalidateToolCache(): void;
  getToolRegistry(): ToolRegistry;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  getContextBuilder(): ContextBuilder;
  ensureContextInitialized(traceContext: TraceContext, model?: Model): Promise<void>;
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  createContextBuilderFromSnapshot(
    snapshot: ContextSourceSnapshot,
    memoryRoot?: string,
    options?: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean },
  ): ContextBuilder;
  loadProjectMemoryRoot(traceContext: TraceContext): Promise<string | undefined>;
  logMemorySkipped(
    traceContext: TraceContext,
    reason: string,
    context?: Record<string, unknown>,
  ): void;
  injectPluginReferenceReminderFromTurn(
    userInput: string,
    traceContext: TraceContext,
    toolDisallowlist?: readonly string[],
  ): Promise<void>;
  startMcpStartup(traceContext: TraceContext): Promise<McpConnectionSnapshot> | undefined;
  initializeMcp(traceContext: TraceContext): Promise<void>;
  refreshMcpToolsIfChanged(traceContext: TraceContext): Promise<void>;
  discoverSkillsForContext(traceContext: TraceContext): Promise<SkillLoadOutcome | undefined>;
  createConfigOnlyContextSnapshot(workingDirectory: string): ContextSourceSnapshot;
  initializeMessageHistoryFromContext(
    contextBuilder: ContextBuilder,
    traceContext: TraceContext,
  ): void;
  extractToolCallsFromResult(result: any): ModelToolCall[];
  shouldStreamModelText(): boolean;
  runModelTextRequest(options: RunModelTextRequestOptions): Promise<RuntimeModelTextResult>;
  logContextUsageSnapshot(
    options: RunModelTextRequestOptions,
    snapshot?: Record<string, unknown>,
  ): void;
  logModelRequestSteeringContext(options: {
    activeTurn?: ActiveTurnSteeringState;
    drained?: DrainedPendingInputDiagnostics;
    messages: ModelInputMessage[];
    modelStepCount: number;
    traceContext: TraceContext;
  }): void;
  buildModelMessageTailDiagnostics(
    messages: ModelInputMessage[],
    limit?: unknown,
  ): Array<Record<string, unknown>>;
  buildContextUsageSnapshot(
    options: RunModelTextRequestOptions,
  ): import("./methods/context-usage.js").ContextUsageSnapshot;
  buildContextUsageBreakdownFromSnapshot(
    snapshot: Record<string, unknown>,
  ): ContextUsageBreakdownItem[];
  buildContextUsageCategory(
    name: ContextUsageCategory["name"],
    source: ContextUsageCategory["source"],
    metric: ContextUsageMetric,
  ): ContextUsageCategory;
  buildToolUsageDetail(tool: ModelToolContract): ContextUsageToolDetail;
  buildSkillUsageDetails(): ContextUsageSkillDetail[];
  buildMessageRoleBreakdown(
    messages: RunModelTextRequestOptions["messages"],
  ): ContextUsageMessageRoleBreakdown[];
  estimatedMetric(content: string, confidence: ContextUsageConfidence): ContextUsageMetric;
  estimatedMetricFromKnown(
    chars: number,
    tokens: number,
    confidence: ContextUsageConfidence,
  ): ContextUsageMetric;
  sumMetrics(
    values: Array<Pick<ContextUsageMetric, "chars" | "tokens">>,
    confidence: ContextUsageConfidence,
  ): ContextUsageMetric;
  emitModelStreamingEvent(
    payload: ModelStreamingPayload,
    traceContext: TraceContext,
    events: SessionEvent[],
  ): Promise<void>;
  isProjectMemoryEnabled(): boolean;
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
  toScheduleState(schedule: ToolSchedule): TurnState["scheduledTools"];
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  readSessionTodosForContext(traceContext: TraceContext): Promise<TodoItem[]>;
  readSessionTargetForContext(traceContext: TraceContext): Promise<SessionGoal | null>;
  injectTargetStateIntoMessageHistory(target: SessionGoal | null): void;
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  continueActiveTargetIfIdle(options?: {
    traceContext?: TraceContext;
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  targetContinuationCandidate(traceContext: TraceContext): Promise<SessionGoal | null>;
  accountTargetTurnCompletion(input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
    usage?: ModelUsageSummary;
  }): Promise<void>;
  startTargetTurnAccounting(input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  }): Promise<SessionGoal | null>;
  heartbeatTargetTurnAccounting(input: {
    inputID: string;
    seenAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  }): Promise<void>;
  finishTargetTurnAccounting(input: {
    inputID: string;
    endedAtMs: number;
    startedTarget: SessionGoal | null;
    status?: "paused";
    traceContext: TraceContext;
  }): Promise<SessionGoal | null>;
  pauseActiveTargetForCancellation(traceContext: TraceContext): Promise<void>;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
}

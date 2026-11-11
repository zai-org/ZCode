import { PermissionService, ToolScheduler } from "./deps.js";
import type { ModelRequestSessionFeature } from "@zcode/contracts";
import type { PromptSnapshot } from "./helpers/prompt-snapshot.js";
import type { TotalTokensBudgetState } from "./helpers/total-tokens-budget.js";
import type { InstructionRefreshReason } from "../context/types.js";
import type {
  Logger,
  ModelSelection,
  EventReducer,
  MessageId,
  TurnId,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  ContextSourcePort,
  ContextSourceSnapshot,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  PendingInputEditLock,
} from "./deps.js";
import type {
  ActiveTurnSteeringState,
  ActiveTurnStartReservation,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  BackgroundTaskNotificationSealReason,
  PendingModelChangeTimeline,
  ProviderRuntimeHeadersPort,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import type { BackgroundSubagentStallClock } from "../subagent/background-stall.js";
import type { DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import type { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

export interface AgentRuntimeInternal
  extends AgentRuntimeCoreMethods, AgentRuntimeTurnMethods, AgentRuntimeHookMethods {
  sessionId: SessionId;
  turnNumber: number;
  config: AgentRuntimeConfig;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  rootTraceContext: TraceContext;
  appVersion: string;
  logger?: Logger;
  eventSinks: Set<SessionEventSink>;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
  registry: ToolRegistry;
  executor: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  sessionModelSelection: ModelSelection | undefined;
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  cachedTools: ModelToolContract[] | null;
  /** 首次装配选定的会话工具运行位置；分支刷新复用它，不能回落到另一种实现。 */
  sessionControlKind?: "cli" | "app";
  /** 工作流工具面是否已注册（launch.md「On demand: activation」）；非 onDemand 会话出生即 true。 */
  dynamicWorkflowToolsActivated: boolean;
  dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  /** 本会话用过的能力标签（session-features 模块是唯一写入方）；只增不减。 */
  sessionFeatures: Set<ModelRequestSessionFeature>;
  /** session-features entry 写入队列的尾部；串行写，避免旧集合覆盖新集合。 */
  sessionFeaturesWrite: Promise<void>;
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  contextSourceSnapshot?: ContextSourceSnapshot;
  // 新会话初始化时刚读过的 Git 尚未用于宣告；第一次判断后清除，恢复的会话不设。
  sessionStartGitPrefetch?: boolean;
  // 本 runtime 已确认不是 Git 仓库的目录；同一目录不再检查（目录里 git init 后由新 runtime 发现）。
  nonGitDirectories?: Set<string>;
  // 从存储恢复的 runtime 还没有自己读过是否仓库；第一次环境公告读一次后清除。
  repositoryRecheckPending?: boolean;
  latestContextBuildResult?: ContextBuildResult;
  // 指令增量的 reason：未设置即 session_start；compaction 提交重读后改为 compaction，之后不再改回。
  instructionRefreshReason?: InstructionRefreshReason;
  // 最近一次读取时读不出来的指令文件与 Memory 索引路径（启动与 compaction 采用重读时写入）；不算删除。
  unreadableInstructionPaths?: ReadonlySet<string>;
  // 主会话的 prompt 快照（helpers/prompt-snapshot.ts 是唯一写入方）；undefined 没有，null 已清掉。
  promptSnapshot?: PromptSnapshot | null;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryRecallState: MemoryRecallState;
  memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  memoryDreamLastScanAtMs: number;
  pendingMemoryUpdate?: ProjectMemoryUpdate;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  residencyBlockingWorkCount: number;
  residencyBlockingWork: Set<Promise<unknown>>;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  /** 初始化 / 上次刷新时注册的 MCP 工具名与集合签名。 */
  registeredMcpToolNames?: string[];
  mcpToolsSignature?: string;
  mcpToolListRevision?: number;
  subagentPort?: SubagentPort;
  getAgentDefinitions: NonNullable<AgentRuntimeDeps["getAgentDefinitions"]>;
  prepareAgentDefinitions: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;

  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  /**
   * 「run 还欠着决定、主代理闲着」的提醒钟（methods/dynamic-workflow-blocked-reminder.ts）。真实 runtime 上
   * 恒在场；可选只为让手写的局部 runtime 桩不必带它。
   */
  workflowBlockedReminder?: WorkflowBlockedReminderClock;
  /** 后台 Agent 无进展提醒（subagent/background-stall.ts）。 */
  subagentStallReminder?: BackgroundSubagentStallClock;
  branchGeneration: number;
  artifactStore?: ToolArtifactStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillLoadOutcome?: SkillLoadOutcome;
  workingDirectory: string;
  workspaceRoot: string;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  sessionPersisted: boolean;
  needsPlanModeExitReminder: boolean;
  /** 恢复时对账出的「上一代 runtime 退出时被中断的后台 Agent」提醒，下一轮请求前落盘后清空。 */
  pendingPreviousRuntimeAgentNotice?: string;
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  /** token 预算倒数的计数器；只在内存，resume 时重新开始。 */
  totalTokensBudget: TotalTokensBudgetState;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
  lastAssistantCompletedAtMs?: number;
  autoCompactConsecutiveFailures: number;
  runtimeCommandQueue: RuntimeCommandQueue;
  runtimeCommandDrainActive: boolean;
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  activeTurn?: ActiveTurnSteeringState;
  activeTurnStartReservation?: ActiveTurnStartReservation;
  pendingInputSequence: number;
  pendingInputReservations: Map<string, string>;
  pendingInputEditLocks: Map<string, PendingInputEditLock>;
  permissionFullAccessPending?: boolean;
  pendingInputDrains?: number;
  lastPermissionGrantId?: string;
  queueAutoDrain: boolean;
  queueExternalDrainActive: boolean;
  shuttingDown: boolean;
  readonly shutdownSignal: AbortSignal;
  workChanged: Set<() => void>;
  backgroundTaskNotificationsSealed: boolean;
  backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
  pendingModelChangeTimeline?: PendingModelChangeTimeline;
  pendingWorktreeCreation?: import("@zcode/contracts").WorktreeCreationFact;
  sessionStartHookRan: boolean;
  sessionTitleGenerationAttempted: boolean;
  agentTelemetry: RuntimeTelemetryFacade;
}

import type { ToolSearchExecutionContext, ToolSearchMode } from "@zcode/contracts";
import type { SessionControlBinding } from "../tool/session-control/contract.js";
import type { ExecutionState, RequestVerificationReason } from "@zcode/shared";
import type { GetAgentDefinitions, LoadAgentDefinitions } from "../subagent/definitions.js";
import type { RuntimeInputPresentation, TurnExecutionModelFallbackReason } from "@zcode/contracts";
/* eslint-disable max-lines -- Runtime 类型集中承载 core/runtime 对外结构，拆分需要单独迁移。 */
import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  JsonSchema,
  AgentExecutionTelemetryPort,
  AgentTelemetryCausation,
  BackgroundResultOriginMeta,
  ContextUsageBreakdownItem,
  CoordinatorResponsePort,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelSelection,
  PluginReferenceCatalog,
  ResolvedUserInstructions,
  StableForkGoalBoundaryMetadata,
  StableForkTargetMetadata,
  WorkspaceHookBundleSnapshot,
  ProjectId,
  WorkspaceId,
  PendingTurnAttachment,
  WorktreeCreationFact,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type { ProviderToolRound } from "./provider-tool-rounds/contract.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CollaborationMode,
  EmbeddedSearchBackend,
  Logger,
  AttachmentStorageMetadata,
  MessageId,
  MessageVisibility,
  FilePartSource,
  ModelRequestAdmission,
  Model,
  ModelNetworkStatusEvent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelTextContentBlock,
  ModelStreamRecoveryStatus,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  ModelInputMessage,
  MessageWithParts,
  PendingTurnInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  PartId,
  PermissionBrokerPort,
  PermissionUpdate,
  QueryId,
  RewindScope,
  RewindStrategy,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionTaskType,
  SessionMailboxPort,
  SessionProjection,
  SessionStorePort,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  TopicResourcePort,
  PluginDiscoveryPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  HooksRuntimeConfig,
  SkillPort,
  McpPort,
  McpServerConfig,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowSubmitPort,
  TraceContext,
  TraceId,
  TurnId,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  SessionHistoryHydrationResult,
  SyntheticUserMessageSource,
  HookRunner,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  EnvInfo,
  ProjectContext,
  UserInstructionsOptions,
  AutoCompactPolicyConfig,
  ModelAnomalyGuardConfig,
  OutputStylePromptConfig,
} from "./deps.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { BashTimeoutPolicy } from "../tool/bash-timeout-policy.js";
import type { PresentationSurface } from "../context/types.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

// -----------------------------------------------
// Agent Runtime
// -----------------------------------------------

export interface AgentRuntimeConfig {
  toolSearch?: { mode?: ToolSearchMode };
  /** shared-host CUA request routing metadata; desktop is the safe default. */
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  remoteSessionId?: string;
  bashTimeoutPolicy?: BashTimeoutPolicy;
  presentationSurface?: PresentationSurface;
  /** Execution Host's output root, independent of the working repository. */
  genUiOutputRoot?: string;
  mode?: CollaborationMode;
  planEnabled?: boolean;
  modelStreaming?: "off" | "on";
  streamingToolExecution?: "off" | "readOnly";
  /** Session 创建时固定；缺省使用共享的模型上下文预算默认策略。 */
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  maxTurns?: number;
  permissionTimeoutMs?: number;
  compact?: AutoCompactPolicyConfig;
  targetCompletionVerification?: { enabled?: boolean };
  midConversationSystem?: {
    mode?: "auto" | "force";
  };
  subagents?: {
    enabled?: boolean;
    // foreground subagent 没有任何 child 事件的最大静默时间；默认对齐模型流 idle timeout。
    inactivityTimeoutMs?: number;
    autoBackgroundMs?: number;
    backgroundBashMaxMs?: number;
    /** 后台 Agent 无进展多久后第一次提醒父会话；之后每次间隔加倍。默认 15 分钟。 */
    backgroundStallNotifyMs?: number;
    /** 无进展提醒的最大间隔。默认 4 小时。 */
    backgroundStallMaxIntervalMs?: number;
    maxTurns?: number;
    outputRootDir?: string;
    profiles?: readonly AgentProfile[];
    builtInModelSelectionOverrides?: Partial<Record<"general-purpose" | "Explore", ModelSelection>>;
  };
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
  /**
   * Defaults to main. Explore child runtimes use the explore toolset to opt into
   * 只读探索工具白名单；是否包含 direct Glob/Grep 由 embedded search branch 决定。
   * 主模式下 allowlist 仅做直接交集过滤，explore 子运行时还会补齐默认只读白名单。
   */
  toolset?: "main" | "explore";
  toolConcurrency?: { maxConcurrency?: number };
  runtimeFeatures?: {
    /**
     * 是否注册 node_repl 工具（js）。
     * 由 bootstrap 根据 ZCode 官方插件启停推导，不由普通插件 manifest 自声明。
     */
    nodeRepl?: boolean;
    /**
     * 是否允许 node_repl 注入 agent.browsers。还需要宿主提供 browserControlPort。
     */
    browserUse?: boolean;
    /** 是否把 CUA broker 凭据注入共享 node_repl；不代表注册独立 CUA MCP。 */
    computerUse?: boolean;
    /**
     * 官方 browser-use plugin 的 docs 资产目录。由 bootstrap 从 plugin metadata.rootPath 推导，
     * 不属于 plugin manifest schema。
     */
    browserDocumentationRoot?: string;
  };
  modelAnomalyGuard?: Partial<ModelAnomalyGuardConfig>;
  mcp?: {
    enabled?: boolean;
    servers?: Record<string, McpServerConfig>;
    /**
     * Process-local provenance supplied by bootstrap after resolving bundled
     * official plugins. Never derive this list from serialized MCP config.
     */
    trustedOfficialCuaServerNames?: readonly string[];
  };
  /**
   * Session 冻结的 Plugin 身份 catalog。
   * 由 bootstrap 在 App 创建时从 plugin loader 结果构建；runtime 只读，
   * 用于 turn start 解析 `plugin://` 引用并与 live inventory 取交集。
   */
  pluginReferenceCatalog?: PluginReferenceCatalog;
  hooks?: HooksRuntimeConfig;
  bashShellSelection?: ExecutionShellSelection | undefined;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  /** 根 Session runtime 创建时固定；false 只关闭 Bash 的 bfs/ugrep prelude。 */
  nativeSearchEnhancementsEnabled?: boolean;
  memory?: MemoryRuntimeConfig;
  /** 历史恢复允许未绑定；只有完整选择才能创建本轮执行 Model。 */
  modelSelection?: ModelSelection;
  titleGeneration?: {
    enabled?: boolean;
    modelSelection?: ModelSelection;
    timeoutMs?: number;
  };
  parentSessionId?: SessionId;
  taskType?: SessionTaskType;
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）：Host 判定后经
   * ZCode Protocol 下发，runtime 只消费。**缺席即开启**（进程内嵌入方靠这个极性）；
   * 独立 CLI 的 TUI 与 headless 按 --workflow-mode 显式传 true/false（缺省 disabled，DWG-04），
   * workflow_child 继承父配置。
   * false 会关闭十个工作流工具，不改变其他工具的注册策略。
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * 灰度 mode `onDemand`（docs/dynamic-workflow/launch.md「On demand: activation」）：十个工作流
   * 工具推迟到会话首次 `/workflow`（或 GUI 对本会话 run 的 Resume / 配置 / 直接启动、冷恢复时记录里
   * 已有工作流）才注册。**缺席即立刻注册**，与 dynamicWorkflowEnabled 同极性；只有协议服务端在
   * Host 下发的 mode 为 onDemand 时写 true。激活状态归 runtime（dynamicWorkflowToolsActivated）。
   */
  dynamicWorkflowToolsOnDemand?: boolean;

  // Context Builder config
  systemPrompt?: string;
  /**
   * 动态工作流子代理的身份输入：在场即让
   * context builder 走「基座 + 工作流子代理契约 + persona 叠加」路径，而不是把 persona 当
   * `systemPrompt` 整段替换。与 `systemPrompt` 互斥（builder 抛错）。
   */
  workflowActor?: { name?: string; persona?: string };
  /**
   * Selects the subagent-specific context builder for child runtimes. The
   * builder still receives env/date/model data through the normal runtime
   * context snapshot, but assembles provider-visible system sections with the
   * subagent prompt shape instead of the main ContextBuilder stack.
   */
  subagentContext?: {
    agentPrompt: string;
    userInstructions?: ResolvedUserInstructions;
  };
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  agentName?: string; // Default: "zcode-agent"
  workingDirectory?: string; // Required for context builder
  /** 本次运行的附加目录，仅用于环境 prompt 展示，不参与配置发现或持久化。 */
  additionalDirectories?: readonly string[];
  /**
   * 调用方传入的实际工作区路径表示，用于 session 持久化与本地身份恢复。
   * 文件和命令执行仍只使用规范化后的 workingDirectory。
   */
  workspacePath?: string;
  /** 仅用于持久化隔离；文件与命令执行仍使用 workingDirectory。 */
  workspaceIdentity?: WorkspaceId;
  /**
   * 会话所属 workspace 的 key：MCP 工具调用的 `workspace_key`、官方 MCP 授权头等发往 Host 的
   * 请求都以它为身份。受管 worktree 会话 = 项目，不等于工作目录（docs/git/worktree.md §9.3）；
   * 缺省按 workspaceIdentity || 工作目录。
   */
  workspaceKey?: string;
  /**
   * 派生项目身份（权限 project_id、项目记忆目录）使用的目录。受管 worktree 会话映射回
   * 源仓库中对应路径，与 Hook Trust 继承同一规则（docs/git/worktree.md §6.6.3）；缺省 = 工作区根。
   */
  projectDirectory?: string;
  envInfo?: EnvInfo; // Optional, will be auto-detected if not provided
  /**
   * YYYY-MM-DD，缺省由 adapter 解析。只用于 ContextBuilder 日期段的用量统计；
   * 模型看到的日期公告一律取运行时时钟（固定日期请注入 `now`）。
   */
  currentDate?: string;
  userInstructions?: UserInstructionsOptions; // P1: AGENTS.md
  projectContext?: ProjectContext; // P2: auto-detected if not provided
  skillMetadataBudget?: number;
}

export interface ResumeSessionOptions {
  /** 中止 cold-resume admission wait；不会伪造 Workspace Hook review decision。 */
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  /** 冷恢复调用方提供的调用级已物化结果；不进入生命周期缓存，修补后按返回值重新读取。 */
  persistedMessages?: MessageWithParts[];
  /**
   * 本次 invocation 已解析出的 mode。显式 --mode 与 headless 默认 yolo 都属于调用级覆盖，
   * 必须高于历史 session mode；交互式 resume 未指定时保持 undefined，让历史 mode 生效。
   */
  modeOverride?: CollaborationMode;
  /**
   * 调用方已算出的完整执行状态（模式与 Plan），覆盖历史 mode 与落盘的执行状态。子会话恢复时传入：
   * 子会话模式必须按父会话当前状态重算，不能沿用子会话落盘时的模式。
   */
  executionStateOverride?: ExecutionState;
}

export interface MainTurnCacheHitAggregate {
  requestCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

export type BackgroundTaskNotificationSealReason = "subagent_terminal" | "subagent_cancelled";

export interface SealBackgroundTaskNotificationsInput {
  reason: BackgroundTaskNotificationSealReason;
  traceContext?: TraceContext;
}

export interface PendingModelChangeTimeline {
  createdAt: number;
  fromModel?: ModelSelection;
  fromModelLabel?: string;
  requestId: string;
  toModel: ModelSelection;
  toModelLabel: string;
}

export interface EnqueueSubagentMessageInput {
  responseId: string;
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  childToolCallId: string;
  parentToolCallId?: string;
  summary: string;
  message: string;
  traceContext: TraceContext;
}

export interface MemoryRuntimeConfig {
  cliStorageRoot?: string;
  enabled?: boolean;
  /** 是否调度成功 Main turn 后的自动 Extraction；缺省按 true 处理。 */
  extractionEnabled?: boolean;
  storageRoot?: string;
  use?: boolean;
  workspaceIdentity?: string;
}

export interface AgentRuntimeDeps {
  /** 只读目录入口；必须同步读取内存，不在请求收集阶段进行 I/O。 */
  getAgentDefinitions?: GetAgentDefinitions;
  /** 新父上下文读取一次；子执行不得继承此加载器。 */
  loadAgentDefinitions?: LoadAgentDefinitions;
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryCausation?: AgentTelemetryCausation;
  agentTelemetryCausationMode?: "child" | "linked_root";
  appVersion?: string;
  eventStore: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  modelFactory: RuntimeModelFactory;
  /** 可选宿主能力：解析未来执行的显式意图；不用于修改已冻结 Model。 */
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  permissionService?: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  toolScheduler?: ToolScheduler;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
  executionPort?: ExecutionPort;
  /** browser-use 控制端口；透传到 ToolExecutionContext.browserControlPort 供 node_repl 使用。 */
  browserControlPort?: BrowserControlPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** 工作流 actor 提交终态结果的端口；存在即作为 submit_result 工具的注册门。 */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * mono 子代理的 typed `submit_result`：在场时注册的工具声明是 `{ result: <这份 schema> }` 而非
   * 任意 JSON。只改
   * provider 可见的声明与 strict 资格；handler、权限、终止语义与 workflowSubmitPort 单独在场时相同。
   * 没有端口时忽略（端口才是注册门）。
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * 工作流 actor 升级阻塞问题的端口；存在即作为 escalate 工具的注册门。与 workflowSubmitPort 同一注入方式与同一条门。
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * 工作流 actor 每个 ask 的 WebSearch 预算（计数与重置归 driver）。缺席即无上限，
   * 所以主会话与 Agent 子代理不受影响。
   */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  /**
   * 模型请求的进程级准入端口：在场时
   * 每次模型请求尝试先经它拿票据；沿调用上下文到 adapter。dwf actor runtime 拿 driver 的 per-actor
   * 包装（受闸门约束），主 runtime 拿治理器的 observer（只喂信号）；缺席即不设闸门。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * 主代理 subagent（`Agent` 工具）的准入端口工厂：派生 subagent 时以**当前**父 sessionId 调用，
   * 结果作为子 runtime 的 `modelRequestAdmission`（受闸门约束，同一父会话的 subagent 共用一条队列）。
   * 缺席时子 runtime 沿用父的 `modelRequestAdmission`。
   */
  subagentModelRequestAdmission?: (parentSessionId: string) => ModelRequestAdmission;
  onOffPeakLifecycleEvent?: (
    event: import("./off-peak/lifecycle.js").OffPeakLifecycleEvent,
  ) => void;
  workflowPort?: WorkflowPort;
  /** workflow run 的提交/观察/取消端口；存在即 CreateWorkflow 真启动，缺席则回占位诊断。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  artifactStore?: ToolArtifactStorePort;
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  logger?: Logger;
  traceContext?: TraceContext;
  contextBuilder?: ContextBuilder; // Optional, will be created from config
  now?: () => Date;
  isRemoteWorkspace?: () => boolean;
  memoryRoot?: string;
}

export interface RuntimeModelFactoryInput {
  selection: ModelSelection;
  /** 只绑定到本次创建的 Model，不进入公共 ModelRequest 或 Session 持久化。 */
  requestDependencies?: ModelRequestDependencies;
}

export type RuntimeModelFactory = (input: RuntimeModelFactoryInput) => Model;

/**
 * 面向协议客户端的 provider runtime headers 端口。
 *
 * 入参的 sessionId 必须能路由到客户端持有的会话。child runtime 的账本身份不能
 * 直接用于客户端请求，否则客户端无法找到会话并返回响应，首个模型请求会一直等待。
 * 子 runtime 通过 deriveChildClientPorts 派生端口，将请求路由到父端口绑定的客户端会话。
 */
export interface ProviderRuntimeHeadersPort {
  shouldRefreshBeforeModelRequest?(input: { providerId: string; modelId: string }): boolean;
  refreshBeforeModelRequest(input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    abortSignal?: AbortSignal;
    modelId: string;
    providerId: string;
    reason: RequestVerificationReason;
    sessionId: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  }): Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

export interface TurnResult {
  response: string;
  turnId: TurnId;
  traceId: TraceId;
  usage?: ModelUsageSummary;
  events: SessionEvent[];
  projection: SessionProjection;
}

/**
 * 标准 Submission Selection 的执行期约束。它不携带 Provider/Model 静态事实，
 * 也不会成为 Session Selection 的第二份来源。
 */
export interface ModelExecutionContext {
  offPeak?: { executionId: string; ticketId: string; providerErrorCode: string };
  /** 仅当前 Turn 跳过自动 Project Memory Extraction；不修改 Session Memory 配置。 */
  memoryExtraction?: "skip";
  selectionScope: "execution";
  /** 接纳加速输入前固定的 Session 候选；仅在内存中随本条命令传递。 */
  highspeedFallbackSelection?: ModelSelection;
  requestDependencies?: ModelRequestDependencies;
  subagents?: {
    foregroundModel: "submission";
    background: "deny" | "allow";
  };
  /**
   * 本次执行的 Selection 失败时，同一 Turn 内退回原模型继续跑完（保留已提交历史，只替换后续请求的
   * 模型），而不是让整轮直接失败。触发条件必须由发起方声明：`providerId` 限定只匹配本轮 execution
   * Selection 指向的 provider，`rules` 按声明顺序匹配、首个命中决定退回原因，`providerErrorCode` 缺省
   * 表示该 provider 的任何失败。core 不按 provider id、模型名或错误文案硬编码。
   * 退回目标先取 `target`（发起方抽卡时的提交选择，即会话原模型），再取本轮接纳前复制的会话常驻 Session Selection；
   * 两者都解析不出时无处可退，按真实错误失败。
   */
  selectionFallback?: {
    providerId: string;
    rules: Array<{
      reason: TurnExecutionModelFallbackReason;
      providerErrorCode?: string;
    }>;
    target?: ModelSelection;
  };
}

export interface ExecuteTurnOptionsBase {
  /** 内存后台命令归属；不进入 canonical intent 或持久化模型默认。 */
  offPeakExecutionId?: string;
  executionSelection?: ModelSelection;
  abortSignal?: AbortSignal;
  browserAmbientContext?: {
    tabCount: number;
    currentUrl?: string;
  };
  continueActiveTargetAfterTurn?: boolean;
  displayInput?: string;
  /**
   * `input` 从此下标起是调用方追加的引擎文本（dwf ask 尾注 / nudge）。只进 TurnStarted 与用户
   * 消息 metadata 供 GUI 折叠；模型历史、持久 text part 仍是全文（amend-resume 的转录复制要全文）。
   */
  epilogueStart?: number;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputPresentation?: RuntimeInputPresentation;
  inputVisibility?: MessageVisibility;
  originMeta?: BackgroundResultOriginMeta;
  /** 仅用于冻结 background notification batch 的整批因果来源，不用于展示。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  /** 由 runtime command drain 计算，表示本轮消费过 subagent 后台结果。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 由 runtime command drain 计算，表示本轮消费过 dynamic-workflow run 的通知（完成 / 提问）。 */
  workflowResultConsumed?: boolean;
  recordedInputMessageId?: MessageId;
  skipInputRecord?: boolean;
  skipUserPromptSubmitHooks?: boolean;
  targetId?: string;
  /** 仅当前 turn 对 provider 隐藏的工具；不修改 session runtime 的持久工具面。 */
  toolDisallowlist?: readonly string[];
  traceContext?: TraceContext;
  /** 当前 Submission 的 Selection 只用于本次执行，并可绑定逐请求依赖。 */
  modelExecution?: ModelExecutionContext;
}

export type ExecuteTurnOptions = ExecuteTurnOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

/**
 * Core prompt admission 的调用参数。Bootstrap 只提供输入事实和期望投递语义，
 * start/queue 的选择由持有该 session 状态的 AgentRuntime 原子完成。
 */
export type PromptAdmissionOptions = ExecuteTurnOptions & {
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  delivery?: "auto" | "start_turn" | "steer_active_turn";
  expectedTurnId?: TurnId;
  /** busy 时的产品队列语义；附件或不可 steer 时由 Core 回退 queue。 */
  queueDelivery?: "guide" | "queue";
  /** 强制进入 FIFO；用于携带只能在未来独立 turn 安装的临时运行模型。 */
  requireQueue?: boolean;
  /** queue promotion 等内部调用要求 admission 必须 idle，否则直接拒绝。 */
  requireIdle?: boolean;
};

/** composer 编辑态写回排队项（docs/ui/composer-edit-mode.md）；可选字段缺省 = 保留原值。 */
export interface EditPendingInputOptions {
  pendingInputId: string;
  /**
   * 缺省 = 保留原输入，只改配置（applyQueueItemsConfig）。不能由调用方用投影 text 回填：
   * 投影 text 经过 genUi 归一化，写回会丢掉输入里的上下文。
   */
  newText?: string;
  /** 携带时必须持有该编辑器的锁；成功后同一调用释放锁。 */
  editorId?: string;
  attachmentRefs?: NonNullable<TurnInputIntentMetadata["attachmentRefs"]>;
  attachments?: PendingTurnAttachment[];
  conversationQuotes?: TurnInputIntentMetadata["conversationQuotes"];
  modelSelection?: ModelSelection;
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  /** 用户改了模型：入队时冻结的 Highspeed 卡不能再覆盖用户的新选择。 */
  dropHighspeed?: boolean;
}

/** editLocked = 该项被他人锁定且调用方未持锁；lockLost = 调用方声明的锁已不在。 */
export type EditPendingInputResult = "edited" | "missing" | "editLocked" | "lockLost";

export type LockPendingInputEditResult = "locked" | "missing" | "reserved" | "lockedByOther";

export type PromptAdmissionReceipt =
  | {
      kind: "started";
      completion: Promise<TurnResult>;
      turnId: TurnId;
    }
  | TurnSteerResult;

export type ActiveTargetLoopTrigger = "manual" | "user-prompt" | "task-notification";

export interface ContinueActiveTargetLoopOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  traceContext?: TraceContext;
  trigger: ActiveTargetLoopTrigger;
  verifyBeforeFirstContinue?: boolean;
}

export interface ActiveForegroundExecutionState {
  controller: AbortController;
  disposeParentAbort: () => void;
  foregroundExecutionId: string;
  preserveQueueAutoDrainOnCancel: boolean;
}

export interface StopActiveForegroundExecutionOptions {
  expectedForegroundExecutionId?: string;
  preserveQueueAutoDrainOnCancel?: boolean;
  reason?: string;
}

export type StopActiveForegroundExecutionResult =
  | { kind: "stopped"; foregroundExecutionId: string }
  | { kind: "idle" }
  | { kind: "mismatch"; activeForegroundExecutionId: string };

export type ForegroundPromotionLeaseMode = "after-current" | "idle-only";

export interface ForegroundPromotionLeaseState {
  leaseId: string;
  promotedInputId: string;
}

export type AcquireForegroundPromotionLeaseResult =
  | { kind: "acquired"; leaseId: string }
  | { kind: "busy" }
  | { kind: "conflict"; leaseId: string };

export interface ActiveTurnInfo {
  kind: ActiveTurnKind;
  /** 本轮的 inputId（TurnStarted.inputId 的同一个值）；workflow run 的发起锚点从这里取。 */
  inputId?: string;
  queueLength: number;
  steerable: boolean;
  turnId: TurnId;
}

export interface WorkspaceRewindRestoredFile {
  action: "delete" | "restore";
  bytesWritten?: number;
  path: string;
}

export interface WorkspaceRewindResult {
  checkpoint?: CheckpointCreatedPayload;
  evaluation?: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
}

export type WorkspaceFileRewindAction = "restore" | "delete";

export type WorkspaceFileRewindUnsafeReason =
  | "checkpoint_missing"
  | "checkpoint_unreadable"
  | "external_modified"
  | "file_read_failed"
  | "unsupported_checkpoint";

export interface WorkspaceFileRewindSafeFile {
  action: WorkspaceFileRewindAction;
  operationCount: number;
  path: string;
  toolNames: string[];
}

export interface WorkspaceFileRewindUnsafeFile {
  currentHash?: string;
  expectedHash?: string;
  message?: string;
  operationCount: number;
  path: string;
  reason: WorkspaceFileRewindUnsafeReason;
  toolNames: string[];
}

export interface WorkspaceFileRewindIgnoredFile {
  operationCount: number;
  path: string;
  reason: "bash_ignored";
  toolNames: string[];
}

export interface WorkspaceFileRewindPreview {
  canApply: boolean;
  ignoredFiles: WorkspaceFileRewindIgnoredFile[];
  safeFiles: WorkspaceFileRewindSafeFile[];
  unsafeFiles: WorkspaceFileRewindUnsafeFile[];
}

export interface WorkspaceFileRewindApplyResult {
  applied: boolean;
  preview: WorkspaceFileRewindPreview;
  response: string;
}

export interface ConversationRewindResult {
  branchGeneration?: number;
  evaluation?: RewindTargetEvaluation;
  keptMessageCount: number;
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
  targetMessageId: MessageId;
}

export interface WorkspaceForkResult {
  checkpoint?: CheckpointCreatedPayload;
  copiedMessageCount: number;
  forkedSessionId: SessionId;
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
}

/** V4 resolver 已固定的目标 product turn raw transcript segment。 */
export type StableConversationForkTarget = StableForkTargetMetadata;

/** 显式 none 或完整 fork 点 goal/verifier 快照；undefined 不属于新数据。 */
export type StableConversationForkGoalBoundary = StableForkGoalBoundaryMetadata;

export type StableConversationForkChildMetadata = ForkChildSessionMetadata;

/**
 * 显式 forkAssistant 把子会话放到同一 workspace 下的另一个 cwd（受管 worktree，
 * docs/git/worktree.md §8.2）。bootstrap 负责解析并校验；core 只写入子会话。
 */
export interface StableConversationForkTargetCwd {
  /** 子会话 cwd，同时写入 session.directory / path。workspaceID 沿用父会话（本地为空）。 */
  directory: string;
  /** 权限与记忆使用的项目 ID：由 cwd 映射回源仓库路径派生（§6.6.3），映射失败时按 cwd。 */
  projectID: ProjectId;
  /** 追加在复制历史之后的 "已创建 worktree" 时间线事实。 */
  worktreeCreation: WorktreeCreationFact;
}

export interface StableConversationForkOptions {
  forkedSessionId?: SessionId;
  /** 缺省 = 父会话 cwd（原行为）。 */
  targetCwd?: StableConversationForkTargetCwd;
  modelSelection?: ModelSelection;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  revisionAtDecision?: number;
  target: StableConversationForkTarget;
  traceContext?: TraceContext;
}

/** 从父会话稳定落盘边界创建隐藏副屏 child；不复制 goal/queue/阻塞运行态。 */
export interface SelectionSideChatCreateOptions {
  modelSelection?: ModelSelection;
  sourceCommandId: string;
  revisionAtDecision?: number;
  traceContext?: TraceContext;
}

export interface ConversationBeforeInputForkOptions {
  modelSelection?: ModelSelection;
  forkedSessionId?: SessionId;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  targetMessageId: MessageId;
  targetProductTurnId: string;
  targetTranscriptTurnId: string;
  initialInput: ForkCommitBundle["initialInput"];
  commandFact: ForkCommitBundle["commandFact"];
  traceContext?: TraceContext;
}

export interface WorkspaceCheckpointSummary {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  diffRef?: string;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  preview?: string;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RuntimeTurnFileChangeEntry {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

export type RuntimeTurnFileChangeMap = Map<string, RuntimeTurnFileChangeEntry>;

export interface CompactTimelineContext {
  operationId: string;
  messageId: MessageId;
  partId: PartId;
  trigger: CompactTrigger;
  phase: CompactPhase;
  compactReason: CompactReason;
  sourceCommandId?: string;
  startedAt: number;
  preCompactTokenCount?: number;
}

export interface ResumeSessionResult extends SessionHistoryHydrationResult {
  directory: string;
  /** 当前恢复候选：允许仅有有效模型身份供界面补选档位，不代表 Runtime 已绑定。 */
  modelSelection?: ModelSelection;
  /** resume 是否写回了当前 materialization 无法完整反映的 compact 修补事实。 */
  persistedMessagesReloadRequired: boolean;
  readFileStateRestoredCount: number;
  readFileStateSkippedUnreadableEditCount: number;
  traceId: TraceId;
}

export interface PermissionDecisionResult {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
}

export interface ExecuteToolsOptions {
  toolSearch?: ToolSearchExecutionContext;
  pluginDiscoveryUi?: boolean;
  automationTurn?: boolean;
  automationId?: string;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  /** 仅透传给当前 turn 同步等待的 Agent child。 */
  subagentModelOverride?: import("@zcode/contracts").SubagentRunOptions["modelOverride"];
  model?: Model;
  onBatchStart?: (toolCallIds: string[]) => Promise<void>;
}

export interface ExecuteToolsResult {
  results: ToolExecutionResult[];
  events: SessionEvent[];
}

export type ActiveTurnKind = "regular" | "compact" | "rewind";

export const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export const INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const MAX_IMAGE_ATTACHMENT_DIMENSION = 2000;

export interface ResolvedTurnAttachment {
  contentBlock: ModelMessageContentBlock;
  filename?: string;
  metadata: AttachmentStorageMetadata;
  mime: string;
  source?: FilePartSource;
  url: string;
}

export interface PreparedImageData {
  dataUrl: string;
  mediaType: string;
  metadata?: AttachmentStorageMetadata["image"];
}

export interface ActiveTurnSteeringState {
  kind: ActiveTurnKind;
  // active turn 被 Stop 时，goal reminder 不能插进尚未闭合的 tool results。
  // deferral 只在 regular model/tool loop 内打开，退出 loop 时先关闭再物化 pending。
  goalStateChangeReminderDeferralOpen: boolean;
  pendingGoalStateChangeReminder?: {
    text: string;
  };
  pendingInputs: PendingTurnInput[];
  steerable: boolean;
  traceContext: TraceContext;
  turnId: TurnId;
  /** 本轮的 inputId（与 TurnStarted.inputId 同源）；regular turn 在 beginActiveTurn 时记下。 */
  inputId?: string;
}

export interface ActiveTurnStartReservation {
  kind: ActiveTurnKind;
  traceContext: TraceContext;
  turnId: TurnId;
}

export interface DrainedPendingInputDiagnostics {
  pluginDiscoveryUi?: boolean;
  injectedMessageIds: MessageId[];
  /** 行内 Guide 本身携带的原子 Submission 配置；由下一次 model-step 边界消费。 */
  intent?: TurnInputIntentMetadata;
  latestMessageId: MessageId | undefined;
  pendingInputIds: string[];
  queryIds?: QueryId[];
  /** 本次 drain 已提交 canonical history 的不可变 entries，供 turn-local query 同步推进。 */
  runtimeEntries: readonly RuntimeMessageEntry[];
  /** 本次 drain 注入的输入附带的工具隐藏列表，下一次 provider 请求必须继续生效。 */
  toolDisallowlist?: readonly string[];
  /** 本次取出的输入里至少一条是用户亲手 steer 的（`user_steer`）；信箱、工具跟进、协调者都不算。 */
  userSteered: boolean;
}

export interface ProviderContextUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokens?: number;
  inputTokens: number;
  messageCount: number;
  model: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  outputTokens?: number;
  recordedAt: number;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface RunModelTextRequestOptions {
  toolSearchEnabled?: boolean;
  abortSignal?: AbortSignal;
  assistantMessageId: MessageId;
  events: SessionEvent[];
  maxOutputTokens?: number;
  latestRealUserMessageIndex?: number;
  messages: ModelInputMessage[];
  /** 与 messages 按索引对应的 canonical 来源，仅用于本地用量统计。 */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  /** 与 messages 按索引对应的全部来源条目（含 attachment），仅用于 context 组成统计。 */
  originEntries?: readonly (readonly RuntimeMessageEntry[])[];
  model: Model;
  onStreamSnapshot?: (snapshot: RuntimeModelStreamSnapshot) => void;
  onStreamReasoningDelta?: (text: string) => void;
  onStreamTextDelta?: (text: string) => void;
  onStreamToolCall?: (toolCall: ModelToolCall) => void;
  onModelNetworkStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
  tools: ModelToolContract[];
  traceContext: TraceContext;
}

export interface RuntimeModelStreamSnapshot {
  /** 当前轮（最后一个服务端内置工具之后）的内容；之前的轮在 providerToolRounds。 */
  reasoning: ModelReasoningContentBlock[];
  text: string;
  /** 当前轮按到达顺序的文字块；`text` 是它们的直接拼接。 */
  textBlocks?: ModelTextContentBlock[];
  providerToolRounds?: readonly ProviderToolRound[];
}

export interface StreamedToolExecutionResult {
  input: Record<string, unknown>;
  ledgerRecorded?: boolean;
  partID: PartId;
  result: ToolExecutionResult;
  toolCallId: ToolCallId;
}

export interface RuntimeModelTextResult {
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  reasoning?: ModelReasoningContentBlock[];
  text: string;
  /** 最后一轮按到达顺序的文字块；`text` 是它们的直接拼接。缺失时按旧数据写入和回放。 */
  textBlocks?: ModelTextContentBlock[];
  toolCalls?: ModelToolCall[];
  /** 服务端内置工具切出的前序轮次；text/reasoning 只保留最后一轮。 */
  providerToolRounds?: ProviderToolRound[];
  usage: ModelUsage;
  /** 结果来自签名修复后的重试，提交 assistant 时要记 signedReasoningReset。 */
  signedReasoningReset?: boolean;
}

export type ParsedRewindCommand =
  | {
      action: "apply";
      targetCheckpointId?: string;
    }
  | {
      action: "fork";
      targetCheckpointId?: string;
    }
  | {
      action: "cascade-message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "status";
    };

export type ContextUsageTokenMethod = "estimated" | "provider_count" | "proportional_estimate";

export type ContextUsageConfidence = "high" | "medium" | "low";

export interface ContextUsageMetric {
  chars: number;
  confidence: ContextUsageConfidence;
  tokenMethod: ContextUsageTokenMethod;
  tokenizer: string;
  tokens: number;
}

export interface ContextUsageCategory extends ContextUsageMetric {
  name: string;
  percentTokens: number;
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
  source: "system_tool" | "mcp_tool";
}

export interface ContextUsageSkillDetail extends ContextUsageMetric {
  name: string;
  path: string;
  scope: string;
  source: string;
}

export interface ContextUsageMessageRoleBreakdown extends ContextUsageMetric {
  count: number;
  role: string;
}

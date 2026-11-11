import type { ToolSearchExecutionContext, ModelCallWrapper } from "@zcode/contracts";
import type { SessionControlBinding } from "./session-control/contract.js";
import type { McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
// ============================================================
// Tool Types - Core tool types for registry and executor
// ============================================================

import type {
  CollaborationMode,
  AutomationPort,
  BrowserControlPort,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  PluginDiscoveryPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  JsonSchema,
  Logger,
  Model,
  ModelCatalogPort,
  ModelContentProtection,
  ModelMessageContent,
  ModelToolSideEffectScope,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerReasonSource,
  PermissionCapabilityGroup,
  PermissionRuleBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  ProviderNativeToolSpec,
  RiskLevel,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SkillTelemetryMetadata,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  ToolCancellationPolicy,
  ToolContractDeclaration,
  ToolExecutionMode,
  ToolExecutionSpanWriter,
  ToolExecutionTelemetry,
  ToolResultBudgetStrategy,
  ToolResultDisplayPayload,
  ToolTimeoutPolicy,
  TraceContext,
  TraceId,
  TurnId,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { SystemReminderSource } from "../system-reminder/source.js";
import type {
  PersistedReadFileStateMetadata,
  PersistedReadFileStateTool,
} from "./read-file-state-metadata.js";

// -----------------------------------------------
// Tool Metadata
// -----------------------------------------------

export interface ToolMetadata {
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  name: string;
  description?: string;
  modelInstructions?: readonly string[];
  allowedInPlanMode?: boolean;
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  requiresUserInteraction?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  providerVisible?: boolean;
  /**
   * 声明该工具是“成功即终止 turn”的终态工具：一旦返回成功结果，executor 就在该结果上挂
   * turnControl 终止当前 turn。这是工具的内在能力声明（像 concurrentSafe/destructive），
   * 由 executor 读取，而不是在调用点按工具名猜测。submit_result 用它实现 actor 的终态提交。
   */
  stopTurnOnSuccess?: boolean;
  /** MCP discovery 的可信展示来源；只参与 UI 投影，不参与权限判定。 */
  mcpPresentation?: {
    serverName: string;
    toolName: string;
    description?: string;
    /** 来自声明 zcode_official 鉴权的 MCP server；仅用于信任其结果里的结构化标识。 */
    official?: boolean;
    /** 该 server 所属插件的稳定 id（`${name}@${marketplace}`）；非插件 MCP 为空。 */
    pluginId?: string;
    /** 工具 `_meta` 归一化后的 MCP App 描述；存在即投影 display.ui（pluginId 缺省时用 serverName 顶替）。 */
    ui?: McpToolUiDescriptor;
  };
}

// -----------------------------------------------
// Tool Execution Context
// -----------------------------------------------

export type ToolRuntimeScope = "main" | "subagent";

export interface BackgroundTaskControlStopOptions {
  /** 谁在停：TaskStop 填 "model"，终态通知据此措辞。 */
  initiator?: "user" | "model";
  strict: true;
  traceContext?: TraceContext;
}

export interface BackgroundTaskControlStopResult {
  command?: string;
  ok: boolean;
  reason?:
    | "background_task_cancel_not_supported"
    | "background_task_not_found"
    | "background_task_not_running";
  status?: string;
  taskId: string;
  type?: string;
}

export interface BackgroundTaskControlPort {
  stopBackgroundTask(
    taskId: string,
    options: BackgroundTaskControlStopOptions,
  ): Promise<BackgroundTaskControlStopResult>;
}

export interface ToolExecutionContext {
  toolSearch?: ToolSearchExecutionContext;
  toolCallId: string;
  /**
   * 当前 Tool 的实时观测写入器。Handler 只能通过窄接口写事实，不能接触原始 OTel Span。
   */
  telemetry?: ToolExecutionSpanWriter;
  /**
   * Runtime 日志。只给需要记录工具内部事实（如 Bash 子进程 pid）的 handler 用，
   * 工具调用开始/结束的通用日志仍由 executor 写。
   */
  logger?: Logger;
  /** 当前工具调用是否属于 automation 派发轮；写工具 handler 用它做最终权限校验。 */
  automationTurn?: boolean;
  /** Host 准入注入的本轮 automationId；CronPauseSelf 唯一的暂停目标，不来自模型输入。 */
  automationId?: string;
  /** 当前工具调用是否属于闲时任务派发轮；OffPeakCreate handler 用它做最终拒绝。 */
  offPeakTurn?: boolean;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort?: ExecutionPort;
  /** browser-use 控制端口；node_repl 的 agent.browsers.* 经此执行。缺省则 browser 不可用。 */
  browserControlPort?: BrowserControlPort;
  /** 官方 browser-use plugin docs 资产目录；只在 browser-use 启用时用于 agent.browsers.documentation()。 */
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  /** Core Server 对前台 child 的 Selection override。 */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** 工作流 actor 提交终态结果并等待引擎裁决的端口；仅在 workflow actor 会话注入。 */
  workflowSubmitPort?: WorkflowSubmitPort;
  /** 工作流 actor 升级阻塞问题并等待主代理作答的端口；仅在 workflow actor 会话注入。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  /** 工作流 actor 每个 ask 的 WebSearch 预算；仅在 workflow actor 会话注入，缺席即无上限。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  artifactStore?: ToolArtifactStorePort;
  /** 仅可信根会话装配；子代理不继承此控制权。 */
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 提交端口；缺席则 CreateWorkflow 回占位诊断而不启动。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** dwf snippet 同步执行端口；缺席则 EvalWorkflowSnippet 报能力缺席的业务失败。 */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** 记录 Skill resolved metadata；仅用于 telemetry，不改变模型可见结果。 */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  /** 会话所属 workspace 的 key；受管 worktree 会话 = 项目，不等于 workingDirectory。 */
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  memoryRoot?: string;
  runtimeScope?: ToolRuntimeScope;
  providerVisibleToolNames?: readonly string[];
  sessionId: SessionId;
  turnId?: TurnId;
  /**
   * 用户在确认窗里调整过、且已应用到本次入参的字段（{@link ToolEntry.applyInputAdjustments} 的
   * `applied`）。handler 据它告诉模型「实际跑的不是你传的那个值」；缺席即没有调整。
   */
  inputAdjustments?: Readonly<Record<string, unknown>>;
}

export interface ToolEmbeddedSearchContext {
  backend?: EmbeddedSearchBackend;
  enabled: boolean;
  findAndGrepEnabled?: boolean;
}

export interface ReadFileStateEntry {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: PersistedReadFileStateTool;
  /**
   * 工具输入里 `file_path` 的原始写法，和 path 不同时才有。读权限规则按原始字符串匹配，
   * compaction 补回用它和 path 各判定一次 deny（见 rewind-compact.md 的文件恢复）。
   */
  requestedPath?: string;
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
  /** 会话开始由 context 写入（MEMORY.md 索引）；只在进程内使用，不进 tool part metadata。 */
  seededFromContext?: true;
  /** 冷恢复从 tool part 快照写入；只在进程内使用。compaction 选择补回文件时按读取时间排序。 */
  restoredFromSession?: true;
}

/** 键是 `createReadFileStatePathKey(path)`：每个文件一条。 */
export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

// -----------------------------------------------
// Tool Handler
// -----------------------------------------------

// tool handler 用该返回值表达可预期业务失败；成功 output 不使用此保留形状。
export interface ToolHandlerFailure {
  result: false;
  errorCode: number;
  message: string;
}

export interface ToolInputValidationContext {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
}

export type ToolInputValidationResult = { result: true } | ToolHandlerFailure;

/**
 * {@link ToolEntry.resolveInput} 的上下文。窄到只有解析真正需要的东西——工作目录是「项目内
 * 的东西住在哪」的唯一入口，再多给就会把一个归一化钩子变成第二个执行入口。
 */
export interface ToolInputResolutionContext {
  workingDirectory?: string;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /**
   * workflow run 端口与本会话 id：AmendWorkflow 用它们把 `run_id` 解析成「前驱是不是本会话的、
   * 还在不在跑」的事实块。仍然只读——
   * 归一化钩子不因此变成第二个执行入口。
   */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /**
   * 模型目录端口：CreateWorkflow / AmendWorkflow 用它把 `subagent_model` 解析成规范形，解不出来
   * 在确认窗**之前**就作为业务失败退回。
   * 同步、只读，与 `dynamicWorkflowRunPort` 同一条理由待在这里。缺席时给了字段即被拒——
   * 不静默放行一个宿主解不了的字符串。
   */
  modelCatalogPort?: ModelCatalogPort;
  sessionId?: string;
  /**
   * 「这个会话此刻加载着某个技能吗」的探针（handlers/workflow-skill-gate.ts）。由 runtime 用
   * provider 可见历史回答（agent/loaded-skills.ts），所以 compaction 之后答案随历史一起变回
   * 否。缺席 = 本会话没有 Skill 工具或调用方不参与（单元测试直接造的 context），门不生效。
   */
  hasLoadedSkill?: (skillName: string) => boolean;
}

export type ToolInputResolutionResult = { result: true; input: unknown } | ToolHandlerFailure;

/**
 * {@link ToolEntry.applyInputAdjustments} 的结果：调整后的入参，与**实际生效**的那部分调整
 * （键同入参字段名；与入参原值相同的改动不算）。`applied` 缺席即什么都没变。
 */
export type ToolInputAdjustmentResult =
  | { result: true; input: unknown; applied?: Readonly<Record<string, unknown>> }
  | ToolHandlerFailure;

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

// -----------------------------------------------
// Tool Entry
// -----------------------------------------------

export interface ToolEntry extends ToolContractDeclaration {
  /** 宿主资源在审批之前固定归属；所有返回路径均释放，撤销信号进入现有取消链。 */
  retainExecution?: (callId: string) => { signal: AbortSignal; release(): void };
  aliases?: readonly string[];
  /**
   * Host-issued atomicity policy for model content. Only an authority-verified
   * registration path may set this; executor code must never infer it from a
   * tool name or from model-visible content.
   */
  modelContentProtection?: ModelContentProtection["kind"];
  /**
   * Optional provider-visible character threshold for tools whose upstream contract
   * budgets UTF-16 characters rather than UTF-8 bytes.
   */
  maxModelChars?: number;
  /**
   * MIME type for provider-visible model content persisted by the result budget.
   * Defaults to the handler result shape when omitted.
   */
  resultArtifactContentType?: string;
  metadata: ToolMetadata;
  /**
   * 只由宿主验证后的可信来源写入；不能从模型可见的 MCP 名称或 descriptor 推导。
   */
  permissionCapabilityGroup?: PermissionCapabilityGroup;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  handler: ToolHandler;
  /**
   * 调用在 handler 返回之前超时或取消时，追加给模型的对账说明（规格 0.15）；返回 undefined 不追加。
   *
   * 只服务「请求可能已被受理、但回执没能送回」的写操作：它们靠回执把请求身份交给模型，回执送不回来，
   * 模型就拿不到身份，只能另起新请求，于是重复执行。执行器只在超时与执行中取消这两种错误上调用它。
   */
  describeUnsettledCall?: (input: unknown, toolCallId: string) => string | undefined;
  /**
   * handler 抛错后追加给模型的补充文本，接在错误原文之后；返回 undefined 不追加。
   * 只进入 `ToolExecutionResult.modelContent`，不改 `error.message`、工具错误事件和日志。
   */
  formatErrorModelContent?: (error: unknown) => string | undefined;
  /** 当前 turn 模型能力对 provider descriptor 与 executor schema 的同源投影。 */
  resolveModelContract?: (context: ToolExecutionModelContext) => {
    description?: string;
    inputSchema?: JsonSchema;
  };
  validateInput?: (
    input: unknown,
    context: ToolInputValidationContext,
  ) => ToolInputValidationResult;
  /**
   * 把模型发出的入参**归一化成将要发生的执行事实**。executor 在 `validateInput` 之后、
   * PreToolUse hook 之前调用，返回值直接替换 `executionInput`。
   *
   * 位置就是全部的意义。此后 hook、项目权限规则、权限事件载荷、`prepareApproval`、handler
   * 读到的都是同一份归一化输入，于是三件事一次到位：
   *   1. 策略不被绕开——一条扫描脚本的 PreToolUse hook 在 saved run 上也能看到真正的脚本；
   *   2. 跨版本可见——入参通道对每个客户端版本都是无 schema 的透传，而 display 通道不是；
   *   3. 确认与执行同字节——只解析一次，那份字节一路带到 handler，不存在批准 A 跑 B。
   *
   * 因此返回值必须仍然满足 `inputSchema` / `runtimeInputSchema`（hook 改写后 executor 会
   * 再校验一次）。解析失败回 {@link ToolHandlerFailure}，executor 在 hook 之前收口——那是
   * 业务失败，不是基础设施故障，不该先打断用户一次确认。
   */
  resolveInput?: (
    input: unknown,
    context: ToolInputResolutionContext,
  ) => Promise<ToolInputResolutionResult> | ToolInputResolutionResult;
  /**
   * 应用用户在确认窗里对入参做的调整（docs/dynamic-workflow/launch.md「Adjusting the settings in
   * the window」）。executor 在授权之后、handler 之前调用，`adjustments` 是 broker 结果的
   * `inputAdjustments`。返回的入参必须仍是 `resolveInput` 产出的那种形状——handler 不为调整另开
   * 一条路；失败即工具失败，handler 不跑。同步：只读上下文里已有的端口，不做 I/O。
   * 不声明的工具忽略一切调整。
   */
  applyInputAdjustments?: (
    input: unknown,
    adjustments: Readonly<Record<string, unknown>>,
    context: ToolInputResolutionContext,
  ) => ToolInputAdjustmentResult;
  formatModelContent?: (output: unknown) => ModelMessageContent;
  /**
   * formatModelContent 已对该输出自行限长时返回 true（例如 Bash 失败结果按字符保留头尾）；
   * serializer 对这类输出不再按 resultBudget 落盘或截断。
   */
  isModelContentBounded?: (output: unknown) => boolean;
  /** 工具批次结算后紧跟在这批结果之后的提示，不进 tool_result（例如 Read 部分视图的截断说明）。 */
  formatBatchNotice?: (output: unknown) => ToolBatchNotice | undefined;
  formatPersistedModelContent?: (
    input: ToolPersistedModelContentInput,
  ) => ModelMessageContent | undefined;
  resolveTimeoutBudgetMs?: (
    input: unknown,
    context?: ToolExecutionModelContext,
  ) => number | undefined;
  resolvePermissionCapability?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolRuntimePermissionCapability | undefined;
  resolvePermissionRulePolicy?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolPermissionRulePolicy | undefined;
  /**
   * Last word on an `ask` decision, owned by the tool. Runs after the permission service
   * has already decided to ask, so it can only narrow the ask to a pass (`proceed`) or
   * enrich it with a preview — it can never turn an allow into an ask.
   *
   * Synchronous like the other permission hooks: it inspects the input the executor
   * already holds and must not perform I/O on the approval path. A tool that needs to
   * read the world before it can build a preview belongs in {@link resolveInput}, which
   * runs earlier, is async, and whose result the whole downstream chain shares.
   */
  prepareApproval?: (input: unknown) => ToolApprovalGate;
  inputSchema: JsonSchema;
  runtimeInputSchema?: unknown;
  runtimeOutputSchema?: unknown;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
}

export type ToolApprovalGate =
  | { gate: "proceed" }
  | { gate: "ask"; display?: ToolResultDisplayPayload };

export interface ToolPermissionRulePolicy {
  evaluateRules: (
    behavior: PermissionRuleBehavior,
    rules: readonly PermissionRuleValue[],
  ) => boolean;
  suggestedPermissionUpdates: PermissionUpdate[];
}

export interface ToolPersistedModelContentInput {
  output: unknown;
  content: string;
  persistedPath: string;
  originalBytes: number;
}

export interface ToolRuntimePermissionCapability {
  userApprovalRule?: string;
  allowedInPlanMode?: boolean;
  destructive?: boolean;
  needsApproval?: boolean;
  readOnly?: boolean;
  requiresUserInteraction?: boolean;
  riskLevel?: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: Partial<ToolContractDeclaration["permission"]>;
}

export interface ToolRuntimePermissionCapabilityContext {
  mode?: CollaborationMode;
  bashShellSelection?: ExecutionShellSelection;
  runtimeScope?: ToolRuntimeScope;
  workingDirectory?: string;
  workspaceRoot?: string;
}

export interface ToolExecutionModelContext {
  model?: Model;
}

// -----------------------------------------------
// Execution Results
// -----------------------------------------------

export interface ToolBatchNotice {
  source: SystemReminderSource;
  content: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  output: unknown;
  turnControl?: ToolExecutionTurnControl;
  followUpUserInput?: ToolExecutionFollowUpUserInput;
  display?: ToolResultDisplayPayload;
  modelContent?: ModelMessageContent;
  /**
   * 工具 Hook 给模型的附加上下文，每条已写成 `<Event>:<ToolName> hook additional context: …`。
   * 不进 tool result；结算把每条写成这批 tool result 之后的 `tool_hook_context` 附件。
   */
  hookAdditionalContexts?: string[];
  readFileStateMetadata?: PersistedReadFileStateMetadata;
  serialization?: ToolResultSerialization;
  /** Executor 汇总后的内部性能事实；不进入模型可见 Tool Output。 */
  performance?: ToolExecutionTelemetry;
  error?: {
    code?: string;
    detail?: string;
    type: string;
    message: string;
    reasonSource?: PermissionBrokerReasonSource;
    stack?: string;
  };
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
}

export interface ToolExecutionFollowUpUserInput {
  input: string;
  reasonSource: PermissionBrokerReasonSource;
}

export interface ToolExecutionTurnControl {
  reason: "automation_create_limit" | "plan_exit_denied" | "subagent_terminal";
  stopTurnAfterResult: boolean;
}

export interface ToolResultSerialization {
  content: string;
  modelContent?: ModelMessageContent;
  originalBytes: number;
  /**
   * 实际进入模型请求的字节。对受保护 CUA 结构化帧，序列化文本里 image 块
   * 只渲染为短占位符，但真实 base64 栅格原样发送——因此这里 = 序列化文本
   * 字节 + 真实媒体载荷，成本/用量观测（setOutputBytes、turn-tool-usage、
   * usage-observability）不得少计图片。该 aggregate 是唯一公开计量状态。
   */
  returnedBytes: number;
  truncated: boolean;
  budgetStrategy: ToolResultBudgetStrategy;
  artifactPath?: string;
}

export interface ToolBatchResult {
  toolCallId: string;
  results: ToolExecutionResult[];
  allSucceeded: boolean;
}

// -----------------------------------------------
// Executable Tool Call
// -----------------------------------------------

export interface ExecutableToolCall {
  modelCallWrapper?: ModelCallWrapper;
  id: string;
  name: string;
  input: unknown;
}

// -----------------------------------------------
// Batch Events
// -----------------------------------------------

export type ToolBatchEvent =
  | { type: "batch_start"; parallelGroupIndex: number; toolCallIds: string[] }
  | {
      type: "batch_complete";
      parallelGroupIndex: number;
      results: ToolExecutionResult[];
    }
  | { type: "tool_start"; toolCallId: string }
  | { type: "tool_complete"; result: ToolExecutionResult }
  | { type: "error"; error: Error; toolCallId?: string };

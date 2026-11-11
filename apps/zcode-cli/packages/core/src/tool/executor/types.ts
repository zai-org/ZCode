import type { ToolSearchExecutionContext } from "@zcode/contracts";
import type { SessionControlBinding } from "../session-control/contract.js";
import type {
  AgentExecutionTelemetryPort,
  AgentTelemetryActorKind,
  AutomationPort,
  BackgroundResultOriginMeta,
  BrowserControlPort,
  CollaborationMode,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  PluginDiscoveryPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Logger,
  Model,
  ModelCatalogPort,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerPort,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { HookRunner } from "../../hooks/index.js";
import type { PermissionService } from "../../permission/service.js";
import type { RuntimeTaskRegistry } from "../../runtime-task/registry.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolSchedule } from "../scheduler.js";
import type {
  BackgroundTaskControlPort,
  ExecutableToolCall,
  ReadFileStateMap,
  ToolBatchEvent,
  ToolExecutionResult,
  ToolRuntimeScope,
} from "../types.js";

export interface BackgroundTaskNotificationCommand {
  originMeta?: BackgroundResultOriginMeta;
  taskId?: string;
  text: string;
  toolName?: string;
  traceContext: TraceContext;
}

export type EnqueueBackgroundTaskNotification = (
  notification: BackgroundTaskNotificationCommand,
) => undefined;

export interface BackgroundTaskNotificationPolicyInput {
  runtimeScope: ToolRuntimeScope;
  status: string;
  taskId: string;
  toolName: string;
  traceContext: TraceContext;
}

export type ShouldEnqueueBackgroundTaskNotification = (
  input: BackgroundTaskNotificationPolicyInput,
) => boolean;

export interface ToolExecutorOptions {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryActorKind?: AgentTelemetryActorKind;
  registry: ToolRegistry;
  permissionService: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  emitEvent: (event: SessionEvent) => Promise<void>;
  /** 后台跟踪的真实完成链（含终态写入）属于 runtime，不能随工具返回丢失。 */
  registerResidencyBlockingWork?: (work: Promise<void>) => void;
  enqueueBackgroundTaskNotification?: EnqueueBackgroundTaskNotification;
  shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification;
  sessionId: SessionId;
  turnId?: TurnId;
  defaultTimeoutMs?: number;
  permissionTimeoutMs?: number;
  logger?: Logger;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  executionPort?: ExecutionPort;
  browserControlPort?: BrowserControlPort;
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  nativeSearchEnhancementsEnabled?: boolean;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  workflowSubmitPort?: WorkflowSubmitPort;
  /** actor 的升级端口；存在即为该会话注册 escalate。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  /** actor 每个 ask 的 WebSearch 预算；缺席即无上限。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  artifactStore?: ToolArtifactStorePort;
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 端口；按工具名查表时 CreateWorkflow 的后台生命周期提供者。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  /** 技能门的探针（ToolInputResolutionContext.hasLoadedSkill）；runtime 按 provider 可见历史回答。 */
  hasLoadedSkill?: (skillName: string) => boolean;
  subagentBackgroundBashMaxMs?: number;
  bashShellSelection?: ExecutionShellSelection;
  getBashShellSelection?: () => ExecutionShellSelection | undefined;
  workingDirectory?: string;
  workspaceRoot?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  runtimeScope?: ToolRuntimeScope;
  getWorkingDirectory?: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  getWorkspaceRoot?: () => string;
  getMemoryRoot?: () => string | undefined;
  traceContext?: TraceContext;
  mode?: CollaborationMode;
  getMode?: () => CollaborationMode;
  maxConcurrency?: number;
  hookRunner?: HookRunner;
}

export interface ToolExecutor {
  /** 同一权限链供 MCP App 使用；返回审批后的输入，不执行 handler / 不做模型结果投影。 */
  authorizeAppTool?(
    toolCall: ExecutableToolCall,
    entry: import("../types.js").ToolEntry,
    options?: ToolExecuteOptions,
  ): Promise<unknown>;

  /**
   * 不跑 hook、不弹确认、不发事件：按当前模式与权限规则逐个判定 Read 是否被拒绝（Read 未注册时全部算拒绝）。
   * 和 Read 工具调用共用同一套静态判定，规则只加载一次；compaction 补回文件用它跳过读权限 deny 的文件。
   */
  areReadsDeniedWithoutPrompt(
    filePaths: readonly string[],
    traceContext: TraceContext,
  ): Promise<boolean[]>;

  execute(toolCall: ExecutableToolCall, options?: ToolExecuteOptions): Promise<ToolExecutionResult>;
  executeBatch(
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ): Promise<ToolExecutionResult[]>;
  executeSchedule(
    toolCalls: ExecutableToolCall[],
    schedule: ToolSchedule,
    options?: ToolBatchExecuteOptions,
  ): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void>;
  /**
   * 把一个**不由本回合工具调用启动**的后台任务纳入追踪（dwf run 的 resume 重臂）。`toolCall` 是调用方合成的描述子（id = 原始
   * toolCallId、name 决定 per-tool 生命周期分派）——tracker 只读它的 id/name/input，
   * 不要求一个真实在飞的工具调用。效果与 submit 路径完全同源：runtime-task registry 登记
   * （会话回收护栏）、BackgroundTaskStarted（backgroundWorks 面板 + cancellable）、
   * 轮询/终态 waiter、结算通知。同 taskId 重复调用由 tracker 的 poller 去重（幂等）。
   */
  trackExternalBackgroundTask(
    toolCall: ExecutableToolCall,
    output: Record<string, unknown>,
    traceContext: TraceContext,
    turnId?: TurnId,
  ): Promise<void>;
}

export interface ToolExecuteOptions {
  toolSearch?: ToolSearchExecutionContext;
  pluginDiscoveryUi?: boolean;
  automationTurn?: boolean;
  automationId?: string;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  model?: Model;
}

export interface ToolBatchExecuteOptions extends ToolExecuteOptions {
  maxConcurrency?: number;
}

export interface ToolExecutorDeps {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryActorKind?: AgentTelemetryActorKind;
  registry: ToolRegistry;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  emitEvent: (event: SessionEvent) => Promise<void>;
  /** 后台跟踪的真实完成链（含终态写入）属于 runtime，不能随工具返回丢失。 */
  registerResidencyBlockingWork?: (work: Promise<void>) => void;
  enqueueBackgroundTaskNotification?: EnqueueBackgroundTaskNotification;
  shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification;
  sessionId: SessionId;
  turnId?: TurnId;
  defaultTimeoutMs: number;
  permissionTimeoutMs?: number;
  logger?: Logger;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  executionPort?: ExecutionPort;
  browserControlPort?: BrowserControlPort;
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  nativeSearchEnhancementsEnabled?: boolean;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  workflowSubmitPort?: WorkflowSubmitPort;
  /** actor 的升级端口；存在即为该会话注册 escalate。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  /** actor 每个 ask 的 WebSearch 预算；缺席即无上限。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  artifactStore?: ToolArtifactStorePort;
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 端口；按工具名查表时 CreateWorkflow 的后台生命周期提供者。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState: ReadFileStateMap;
  /** 文件读取快照的下一个序号；执行器持有计数器，只增不减。 */
  nextReadFileStateSnapshotIndex: () => number;
  hasLoadedSkill?: (skillName: string) => boolean;
  subagentBackgroundBashMaxMs?: number;
  bashShellSelection?: ExecutionShellSelection;
  getBashShellSelection?: () => ExecutionShellSelection | undefined;
  getWorkingDirectory: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  getWorkspaceRoot: () => string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  getMemoryRoot?: () => string | undefined;
  runtimeScope: ToolRuntimeScope;
  traceContext?: TraceContext;
  getMode: () => CollaborationMode;
  maxConcurrency: number;
  hookRunner?: HookRunner;
}

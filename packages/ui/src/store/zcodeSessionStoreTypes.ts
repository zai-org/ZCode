import type { DraftPluginUiOpenRequest } from "@/plugin-ui/contract.js";
/* oxlint-disable eslint(max-lines) -- ZCode Agent store 类型和默认状态集中导出，避免切片间重复定义共享结构。 */
/**
 * ZCode Session Store 类型定义、接口、常量与默认值工厂
 *
 * 从 zcodeSessionStore.ts 拆分出来，供 store 本体和 selectors / navigation 等子模块共享。
 */
import {
  buildNativeSupplierKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeApiRetryStatus,
  type ModelSelectionGhostReason,
  type ModelSelectionResolution,
  type ZCodeWorkspaceInitStatus,
  type ZCodeTaskRuntimeStatus,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  type ZCodeContextCacheUsage,
  type ZCodeConfigOption,
  type ZCodeSlashCommand,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeSessionActiveTurnKind,
  type ZCodeContextUsageBreakdownItem,
  type InputId,
  type SessionCreateSource,
} from "@zcode/shared";
import type { SessionConfigState, SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type {
  AutomationsNavigationTab,
  TaskNavigationHistory,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";

// ────────────────────────────────────────────
// Interfaces
// ────────────────────────────────────────────

export interface WorkspaceInitState {
  status: ZCodeWorkspaceInitStatus;
  error: string | null;
  attempts: number;
}

export interface TaskRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
  /** 该 task 当前运行态绑定的 ZCode Agent 进程 provider，用于 workspace 级进程重建 busy lock。 */
  provider?: ZCodeProvider;
  /** 当前模型上下文窗口容量；模型状态事件只更新这里，不覆盖真实 usage.used。 */
  contextWindow: number | null;
  usage: TaskUsageState | null;
  apiRetry: ZCodeApiRetryStatus | null;
  /** Agent 明确上报的后台任务控制项；host 运行期状态，不落盘持久化。 */
  backgroundTaskControls: ZCodeBackgroundTaskControlItem[];
  /** 当前 session active turn 的类型；用于区分普通生成和 compact 维护态。 */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  activeInputId?: InputId;
  activeInputOwnerClientId?: string;
}

export interface DraftRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
}

export interface TaskUsageState {
  /** 当前上下文窗口已使用的 token 数 */
  used: number;
  /** 当前上下文窗口总 token 容量 */
  size: number;
  /** Agent 上报的累计费用 */
  cost?: { amount: number; currency: string } | null;
  /** Agent/app 协议返回的当前主轮缓存命中信息。 */
  cache?: ZCodeContextCacheUsage;
  /** Agent 按来源估算的上下文字符量，只用于 context usage 弹窗比例展示。 */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

export interface ElicitationAnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export interface ElicitationFormDraft {
  questionIndex: number;
  drafts: Record<string, ElicitationAnswerDraft>;
}

/**
 * store 收尾：TaskUiState 收敛为「远端广播仍需回放的人工介入面」——
 * 权限/问答弹窗 pending 队列、renderer-local 问答草稿 + 错误横幅。plan/goal/token debug 等旧 ChatView
 * 展示态的写入方已随旧协议链路删除，读侧由 v4 conversation 投影承接。
 */
export interface TaskUiState {
  permissionRequest: ZCodePermissionRequest | null;
  pendingPermissionRequests: ZCodePermissionRequest[];
  elicitationRequest: ZCodeElicitationRequest | null;
  pendingElicitationRequests: ZCodeElicitationRequest[];
  elicitationFormDraftsByRequestId: Record<string, ElicitationFormDraft>;
  error: ZCodeUiError | null;
}

export type ModelSwitchStage =
  | "idle"
  | "settingModel"
  | "fallbackConfigOption"
  | "applyingCustomProvider"
  | "restartingRuntime"
  | "syncingSession"
  | "persistingWorkspace";

export type ConfigOptionsStatus = "idle" | "loading" | "ready" | "error";

export interface ComposerMentionPrefill {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string;
  data?: MentionItemData;
}

export interface ComposerTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export interface TimelineBottomRequest {
  requestId: number;
  taskId: string;
}

export type ComposerInitialConfig = Pick<
  Partial<SessionConfigState>,
  "planEnabled" | "modelSelection"
> & { mode?: SubmissionMode };
export interface ComposerInitialization {
  taskId: string;
  config: ComposerInitialConfig;
}

export interface WorkspaceZCodeUIState {
  /** 首次分享导入的导航参数；接收、换任务或新建后结束，不持久化。 */
  composerInitialization?: ComposerInitialization;
  /** 当前 workspace 激活中的 task */
  activeTaskId: string | null;
  /**
   * ZCode Agent 的 workspace 初始化状态。
   *
   * 单 ZCode Agent 迁移后继续按 provider 分桶会保留多份已经不会再被真实运行时更新的旧状态，
   * UI 在 task / draft / remote identity 切换时容易读到历史 provider 的 ready/failed。这里把状态收敛成
   * workspace 单一事实源，provider 参数只作为旧调用兼容输入。
   */
  workspaceInit: WorkspaceInitState;
  /** 草稿态尚未创建 taskId 前的短期运行状态；已有 task 的状态从 taskRuntimeByTaskId 派生。 */
  draftRuntime: DraftRuntimeState;
  /** 未提交草稿的项目选择；已提交归属只在 Host。 */
  draftProjectId?: string | null;
  /** 未提交任务的分组意图；无文字时仅保留在当前 Renderer 内存。 */
  draftTaskGroupId?: string | null;
  /**
   * 草稿运行时能力失效版本；插件、Skill 等能力变化时递增。
   * V4 pane 独占预热会话，配置界面只发布失效版本。
   */
  draftRuntimeInvalidationVersion: number;
  pluginUiOpenVersion: number;
  pluginUiOpenRequest:
    | (DraftPluginUiOpenRequest & { requestId: number; invalidationVersion: number })
    | null;
  composerTextInsertVersion: number;
  composerTextInsertRequest: ComposerTextInsertRequest | null;
  timelineBottomRequestVersion: number;
  timelineBottomRequest: TimelineBottomRequest | null;
  /** 草稿态错误需要跨页面保留，避免切走再回来后提示被本地 state 一起卸载 */
  draftError: ZCodeUiError | null;
  /** 模型切换中的并发保护 requestId；只允许最新请求落库 */
  modelSwitchRequestId: string | null;
  /** 模型切换是否进行中（用于禁发和工具栏 loading） */
  modelSwitchPending: boolean;
  /** 模型切换阶段（用于细分 loading 文案） */
  modelSwitchStage: ModelSwitchStage;
  /** 每个 task 各自的运行时状态，供任务列表和状态栏读取真实 task 状态 */
  taskRuntimeByTaskId: Record<string, TaskRuntimeState>;
  /** 每个 task 自己的临时 UI 态，避免切换任务后丢失计划面板和权限弹窗 */
  taskUiByTaskId: Record<string, TaskUiState>;
  taskConfigOptionsByTaskId: Record<string, ZCodeConfigOption[]>;
  taskConfigOptionsStatusByTaskId: Record<string, ConfigOptionsStatus>;
  /** task 未读状态的兼容缓存；真实未读状态以 task meta.unreadAt 为准 */
  taskUnreadByTaskId: Record<string, boolean>;
  /** 任务列表的乐观元数据，解决新 task 落盘前左侧列表显示慢半拍的问题 */
  optimisticTaskListByTaskId: Record<string, ZCodeTaskMeta>;
  draftCreateSource: SessionCreateSource;
  /** 当前 workspace 选中的 ZCode Agent provider */
  selectedProvider: ZCodeProvider;
  /** 当前模型供应商选中键（native/custom/ghost） */
  selectedSupplierKey: string;
  /** 当前供应商是否为 ghost 态 */
  isGhostSupplier: boolean;
  /** 当前 ghost 态来源 */
  supplierMismatchReason: ModelSelectionGhostReason | null;
  /** ZCode Agent configOptions（模型、模式、思考级别等） */
  configOptions: ZCodeConfigOption[] | null;
  /** configOptions 加载状态 */
  configOptionsStatus: ConfigOptionsStatus;
  /** 可用的 slash commands */
  slashCommands: ZCodeSlashCommand[];
  /** 任务列表版本号，每次创建/删除任务时自增，驱动 TaskList 刷新 */
  taskListVersion: number;
  /** 缓存已拉取的任务列表，避免组件 remount 时闪烁 */
  taskListCache: ZCodeTaskMeta[] | null;
  /** 新建草稿时递增，驱动输入框在切到草稿态后主动聚焦 */
  draftFocusVersion: number;
}

export interface ZCodeSessionStoreState {
  /** 按 workspace 维护聊天相关 UI 状态 */
  workspaces: Record<string, WorkspaceZCodeUIState>;
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) => WorkspaceZCodeUIState;

  setActiveTaskId: (
    workspacePath: string,
    id: string | null,
    workspaceIdentity?: string,
    composerConfig?: ComposerInitialConfig,
  ) => void;
  consumeComposerInitialization: (
    workspacePath: string,
    initialization: ComposerInitialization,
    workspaceIdentity?: string,
  ) => void;
  invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => void;
  requestPluginUiOpen: (request: DraftPluginUiOpenRequest) => void;
  clearPluginUiOpenRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  requestComposerTextInsert: (
    workspacePath: string,
    text: string,
    workspaceIdentity?: string,
    mention?: ComposerMentionPrefill,
    mode?: "replace" | "prepend-if-missing",
  ) => number;
  clearComposerTextInsertRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  requestTimelineBottom: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => number;
  clearTimelineBottomRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  clearDraftTaskGroup: (workspacePath: string, workspaceIdentity?: string) => void;
  startDraft: (
    workspacePath: string,
    provider?: ZCodeProvider,
    workspaceIdentity?: string,
    options?: {
      projectId?: string | null;
      taskGroupId?: string | null;
      createSource?: SessionCreateSource;
    },
  ) => void;
  bindRuntimeProvider: (
    workspacePath: string,
    provider: ZCodeProvider,
    workspaceIdentity?: string,
  ) => void;
  setModelSelectionResolution: (
    workspacePath: string,
    resolution: Pick<
      ModelSelectionResolution,
      "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
    >,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitState: (
    workspacePath: string,
    status: ZCodeWorkspaceInitStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitAttempts: (
    workspacePath: string,
    attempts: number,
    workspaceIdentity?: string,
  ) => void;
  setTaskState: (
    workspacePath: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskRuntimeState: (
    workspacePath: string,
    taskId: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
    provider?: ZCodeProvider,
  ) => void;
  setTaskUsage: (
    workspacePath: string,
    taskId: string,
    usage: TaskUsageState | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskContextWindow: (
    workspacePath: string,
    taskId: string,
    contextWindow: number | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskApiRetryStatus: (
    workspacePath: string,
    taskId: string,
    apiRetry: ZCodeApiRetryStatus | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodePermissionRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodeElicitationRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    draft: ElicitationFormDraft,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskError: (
    workspacePath: string,
    taskId: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  setDraftError: (
    workspacePath: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  startModelSwitch: (
    workspacePath: string,
    requestId: string,
    stage?: ModelSwitchStage,
    workspaceIdentity?: string,
    options?: { pending?: boolean },
  ) => void;
  updateModelSwitchStage: (
    workspacePath: string,
    requestId: string,
    stage: ModelSwitchStage,
    workspaceIdentity?: string,
  ) => void;
  finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => void;
  setTaskConfigOptions: (
    workspacePath: string,
    taskId: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
    status?: ConfigOptionsStatus,
  ) => void;
  initializeBackgroundTaskRuntime: (
    workspacePath: string,
    params: {
      task: ZCodeTaskMeta;
      provider: ZCodeProvider;
      activeInputId: InputId;
      workspaceIdentity?: string;
    },
  ) => void;
  upsertOptimisticTaskListItem: (
    workspacePath: string,
    task: ZCodeTaskMeta,
    workspaceIdentity?: string,
  ) => void;
  removeOptimisticTaskListItem: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  /** 删除任务后同步回收选中态和乐观态，避免右侧继续展示已删除任务 */
  removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

  setConfigOptions: (
    workspacePath: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
  ) => void;
  setConfigOptionsStatus: (
    workspacePath: string,
    status: "idle" | "loading" | "ready" | "error",
    workspaceIdentity?: string,
  ) => void;
  setSlashCommands: (
    workspacePath: string,
    commands: ZCodeSlashCommand[],
    workspaceIdentity?: string,
  ) => void;
  setCurrentModeId: (
    workspacePath: string,
    modeId: string | null,
    workspaceIdentity?: string,
  ) => void;
  /** 任务列表变更时调用（创建/删除任务），驱动 zcodeTaskMetaMerge 重新拉取列表 */
  bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => void;
  /** 更新已拉取的任务列表缓存 */
  setTaskListCache: (
    workspacePath: string,
    tasks: ZCodeTaskMeta[],
    workspaceIdentity?: string,
  ) => void;
  /** 更新 task 的未读提示，控制左侧蓝点显示 */
  setTaskUnreadIndicator: (
    workspacePath: string,
    taskId: string,
    hasUnread: boolean,
    workspaceIdentity?: string,
  ) => void;

  /** workspace 导航历史（全局、跨 workspace，包含 task 与 Automations） */
  taskNavHistory: TaskNavigationHistory;
  /** 记录 Automations 主视图或详情导航。 */
  taskNavPushAutomations: (
    workspacePath: string,
    workspaceIdentity?: string,
    automationId?: string,
    automationTab?: AutomationsNavigationTab,
  ) => void;
  /** 记录插件市场主视图导航。 */
  taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => void;
  /** 后退，返回目标 entry；到头了返回 null */
  taskNavGoBack: () => WorkspaceNavEntry | null;
  /** 前进，返回目标 entry；到头了返回 null */
  taskNavGoForward: () => WorkspaceNavEntry | null;
  /** task 被删除时清理导航历史中的对应 task 条目 */
  removeTaskFromNavHistory: (taskId: string) => void;
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

export const DEFAULT_WORKSPACE_INIT_STATE: WorkspaceInitState = {
  status: "idle",
  error: null,
  attempts: 0,
};

export const FALLBACK_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;

export const DEFAULT_TASK_UI_STATE: TaskUiState = {
  permissionRequest: null,
  pendingPermissionRequests: [],
  elicitationRequest: null,
  pendingElicitationRequests: [],
  elicitationFormDraftsByRequestId: {},
  error: null,
};

export const DEFAULT_TASK_RUNTIME_STATE: TaskRuntimeState = {
  status: "notReady",
  error: null,
  provider: undefined,
  contextWindow: null,
  usage: null,
  apiRetry: null,
  backgroundTaskControls: [],
  activeTurnKind: undefined,
  activeInputId: undefined,
  activeInputOwnerClientId: undefined,
};

// ────────────────────────────────────────────
// Factory functions
// ────────────────────────────────────────────

export function createDefaultWorkspaceState(
  selectedProvider: ZCodeProvider,
): WorkspaceZCodeUIState {
  return {
    activeTaskId: null,
    workspaceInit: { ...DEFAULT_WORKSPACE_INIT_STATE },
    draftRuntime: { status: "idle", error: null },
    draftRuntimeInvalidationVersion: 0,
    pluginUiOpenVersion: 0,
    pluginUiOpenRequest: null,
    composerTextInsertVersion: 0,
    composerTextInsertRequest: null,
    timelineBottomRequestVersion: 0,
    timelineBottomRequest: null,
    draftError: null,
    modelSwitchRequestId: null,
    modelSwitchPending: false,
    modelSwitchStage: "idle",
    taskRuntimeByTaskId: {},
    taskUiByTaskId: {},
    taskConfigOptionsByTaskId: {},
    taskConfigOptionsStatusByTaskId: {},
    taskUnreadByTaskId: {},
    optimisticTaskListByTaskId: {},
    draftCreateSource: "session",
    selectedProvider,
    selectedSupplierKey: buildNativeSupplierKey(selectedProvider),
    isGhostSupplier: false,
    supplierMismatchReason: null,
    configOptions: null,
    configOptionsStatus: "idle",
    slashCommands: [],
    taskListVersion: 0,
    taskListCache: null,
    draftFocusVersion: 0,
  };
}

const DEFAULT_WORKSPACE_STATE = createDefaultWorkspaceState(FALLBACK_PROVIDER);

export function getDefaultWorkspaceState(): WorkspaceZCodeUIState {
  // 单 ZCode Agent 迁移后默认 provider 必须收敛到 glm。
  // 这里返回稳定引用，避免未写入 workspace bucket 的连续 selector 读取产生不同快照。
  return DEFAULT_WORKSPACE_STATE;
}

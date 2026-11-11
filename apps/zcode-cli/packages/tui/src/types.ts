import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelection, ZCodeModelOption } from "@zcode/shared";
import type {
  CollaborationMode,
  InputDelivery,
  ModelUsageSummary,
  McpServerStatus,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  SessionEvent,
  SessionProjection,
  SupportedLocale,
  ToolResultDisplayPayload,
  UiThemeMode,
  UiThemePreference,
  TurnId,
  TurnSteerResult,
} from "@zcode/contracts";

export type TuiContextUsage = Pick<SessionProjection, "contextUsed" | "contextWindow">;

export type TuiSessionMetadata = Pick<
  TuiSubmitPromptResult,
  "locale" | "model" | "theme" | "thoughtLevel" | "modelOptions" | "effortOptions" | "loginRequired"
>;

export type TuiSwitchableMode = Extract<
  CollaborationMode,
  "plan" | "build" | "edit" | "yolo" | "guarded"
>;

export type TuiSetModeResult = {
  mode: CollaborationMode;
  response?: string;
};

export type TuiSetMode = (mode: TuiSwitchableMode) => Promise<TuiSetModeResult> | TuiSetModeResult;

export type TuiPromptAttachment = {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
};

export type TuiPromptInput =
  | string
  | {
      text: string;
      attachments?: TuiPromptAttachment[];
      /** Model picker commands retain the reference separately from their display text. */
      modelSelection?: ModelSelection;
    };

export type TuiImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type TuiClipboardImage = {
  dataUrl: string;
  mediaType: TuiImageMediaType;
  sizeBytes?: number;
};

export type TuiReadClipboardImage = (options?: {
  abortSignal?: AbortSignal;
}) => Promise<TuiClipboardImage | null>;

export type TuiWriteClipboardText = (text: string) => Promise<void> | void;

export type TuiWorkspacePathKind = "directory" | "file";

export type TuiWorkspacePathSuggestion = {
  kind: TuiWorkspacePathKind;
  path: string;
};

export type TuiWorkspacePathSuggestionResult = {
  items: readonly TuiWorkspacePathSuggestion[];
  truncated: boolean;
};

export type TuiListWorkspacePathSuggestions = (request: {
  abortSignal?: AbortSignal;
  limit?: number;
  token: string;
}) => Promise<TuiWorkspacePathSuggestionResult>;

export type TuiSelectionItem = {
  command: string;
  disabledReason?: string;
  id: string;
  input?: TuiSelectionInput;
  keywords?: readonly string[];
  meta?: string;
  pending?: TuiSelectionPending;
  primary: string;
  secondary?: string;
};

export type TuiSelectionInput = {
  cancelStatus?: string;
  clearStatus?: string;
  emptyStatus?: string;
  help?: string;
  mask?: boolean;
  placeholder?: string;
  primary: string;
  secondary?: string;
  status?: string;
  submitStatus?: string;
};

export type TuiSelectionPending = {
  cancelStatus?: string;
  help?: string;
  primary: string;
  secondary?: string;
  status?: string;
};

export type TuiSelection = {
  emptyMessage: string;
  filterable?: boolean;
  help?: string;
  items: TuiSelectionItem[];
  placement?: "action" | "composer";
  prompt: string;
  selectedIndex?: number;
  title: string;
};

export type TuiRestoredTranscriptPart =
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "thought";
    }
  | {
      error?: string;
      input: Record<string, unknown>;
      output?: string;
      resultDisplay?: ToolResultDisplayPayload;
      status: "pending" | "running" | "completed" | "failed";
      title?: string;
      toolCallId: string;
      toolName: string;
      type: "tool";
    };

export type TuiSubmitPromptResult = {
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  locale?: SupportedLocale;
  loginRequired?: boolean;
  mode?: CollaborationMode;
  model?: string;
  theme?: UiThemePreference;
  projection?: Partial<TuiContextUsage>;
  response: string;
  resetSessionProjection?: boolean;
  restoredMessages?: Array<{
    id?: string;
    content: string;
    parts?: TuiRestoredTranscriptPart[];
    role: "agent" | "system" | "user";
  }>;
  selection?: TuiSelection;
  sessionId?: string;
  thoughtLevel?: string;
  traceId?: string;
  turnId?: string;
  usage?: ModelUsageSummary;
};

export type TuiRequestPermission = (
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
) => Promise<PermissionBrokerResult>;

/**
 * TUI 挂载时登记审批入口，返回注销函数。入口在挂载期间一直有效，不随单次提交切换：
 * 主会话回合之外的询问（通知驱动的回合、CreateSession 建的后台会话）也走同一个审批队列。
 */
export type TuiRegisterPermissionRequester = (
  requestPermission: TuiRequestPermission,
) => () => void;

export type TuiSubmitPrompt = (
  prompt: TuiPromptInput,
  options: {
    abortSignal: AbortSignal;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
  },
) => Promise<TuiSubmitPromptResult>;

export type TuiSendInputResult =
  | {
      kind: "started_turn";
      result: TuiSubmitPromptResult;
    }
  | {
      kind: "command_result";
      result: TuiSubmitPromptResult;
    }
  | TurnSteerResult;

export type TuiSendInput = (
  input: TuiPromptInput,
  options: {
    abortSignal?: AbortSignal;
    delivery?: InputDelivery;
    expectedTurnId?: TurnId;
    onEvent?: (event: SessionEvent) => void | Promise<void>;
  },
) => Promise<TuiSendInputResult>;

export type TuiRecallPreviousInput = (
  skip?: number,
) => Promise<{ attachments?: TuiPromptAttachment[]; text: string } | null>;

export type TuiCancelBackgroundTask = (taskId: string) => Promise<unknown>;

export type TuiReadSubagents = (input?: {
  endedCursor?: string;
  endedLimit?: number;
}) => Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
export type TuiSubagentTranscriptSnapshot = {
  sessionId: string;
  sequenceNumber: number;
  messages: NonNullable<TuiSubmitPromptResult["restoredMessages"]>;
  events: SessionEvent[];
  replayMessageIds: string[];
};
export type TuiReadSubagentTranscript = (
  childSessionId: string,
) => Promise<TuiSubagentTranscriptSnapshot>;

/**
 * 跨回合常驻的会话事件订阅。
 *
 * 为什么不复用 `submitPrompt` / `sendInput` 的 per-turn `onEvent`：dwf 进度是**出回合事件**
 * （turnId 为空），per-turn sink 在回合结束即死——这正是 TUI 今天丢 dwf 事件的结构性原因。
 * 后台完成通知驱动的模型回合同理（它由 runtime 命令队列自驱，没有任何 per-turn sink 在听）。
 *
 * 返回 unsubscribe；`replaceApp`（`/new` `/resume` `/fork`）时由 CLI 侧重挂。
 */
export type TuiSubscribeSessionEvents = (sink: (event: SessionEvent) => void) => () => void;

/**
 * 会话级 workflow run 摘要（`app.listDynamicWorkflowRuns`），用于冷启动/恢复时补种镜像。
 *
 * `label` / `updatedAt` 是 additive optional：老服务端不发这两个键，读侧退回 runId、不显示时间。
 * `resumable` 由服务端裁定，**绝不**在 TUI 重推导。
 */
export type TuiWorkflowRunSummary = {
  runId: string;
  toolCallId?: string;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
  label?: string;
  updatedAt?: number;
  resumable?: boolean;
};

export type TuiListWorkflowRuns = () => Promise<readonly TuiWorkflowRunSummary[]>;

/**
 * workflow run 的冷回放：把本会话名下、镜像里
 * 还没有的 run 从 journal 回放成进度事件信封，逐条喂给镜像的共享 reducer——重启 / `/resume`
 * 之后卡片显示的是真实步数、用量与子代理，而不是 0/0 的空壳。
 */
export type TuiReplayWorkflowRuns = (input: {
  excludeRunIds: ReadonlySet<string>;
}) => Promise<readonly WorkflowRunProgressEnvelope[]>;

/**
 * 当前**主会话** id。是 getter 而不是值：`/new` `/resume` `/fork` 会换会话，
 * 快照下来的 id 会立刻过期，然后把整条转写误判成外来事件。
 */
export type TuiGetMainSessionId = () => string | undefined;

export type TuiListMcpServers = () => Promise<Record<string, McpServerStatus>>;

export type TuiSlashCommandSuggestion = {
  aliases?: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export type TuiModelOption = ZCodeModelOption;

export type TuiEffortOption = {
  description?: string;
  id: string;
  label: string;
};

export type TuiModeOption = {
  description: string;
  id: TuiSwitchableMode;
  label: string;
};

export type TuiOptions = {
  /** Called after the startup screen has painted; runtime ownership stays in CLI. */
  loadStartupOptions?: () => Promise<TuiStartupOptions>;
  initialMode?: CollaborationMode;
  initialModel?: string;
  initialResult?: TuiSubmitPromptResult;
  initialThoughtLevel?: string;
  loginRequired?: boolean;
  locale?: SupportedLocale;
  theme?: UiThemePreference;
  initialThemeMode?: UiThemeMode;
  developerMode?: boolean;
  version?: string;
  workspaceDirectory?: string;
  workspaceGitBranch?: string;
  noColor: boolean;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  cancelBackgroundTask?: TuiCancelBackgroundTask;
  readSubagents?: TuiReadSubagents;
  readSubagentTranscript?: TuiReadSubagentTranscript;
  listWorkspacePathSuggestions?: TuiListWorkspacePathSuggestions;
  listMcpServers?: TuiListMcpServers;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  getMainSessionId?: TuiGetMainSessionId;
  registerPermissionRequester?: TuiRegisterPermissionRequester;
  readClipboardImage?: TuiReadClipboardImage;
  recallPreviousInput?: TuiRecallPreviousInput;
  sendInput?: TuiSendInput;
  setMode?: TuiSetMode;
  effortOptions?: readonly TuiEffortOption[];
  modelOptions?: readonly TuiModelOption[];
  listModelOptions?: () => Promise<readonly TuiModelOption[]>;
  slashCommands?: readonly TuiSlashCommandSuggestion[];
  submitPrompt: TuiSubmitPrompt;
  subscribeSessionEvents?: TuiSubscribeSessionEvents;
  subscribeThemeMode?: (listener: (mode: UiThemeMode) => void) => () => void;
  setTerminalBackgroundColor?: (color: string) => void;
  writeClipboardText?: TuiWriteClipboardText;
};

export type TuiStartupOptions = Pick<
  TuiOptions,
  | "initialMode"
  | "initialModel"
  | "initialThoughtLevel"
  | "loginRequired"
  | "locale"
  | "theme"
  | "modelOptions"
  | "effortOptions"
  | "slashCommands"
  | "workspaceGitBranch"
>;

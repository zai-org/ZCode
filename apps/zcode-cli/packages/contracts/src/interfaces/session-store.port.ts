// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================

import type {
  MessageId,
  PartId,
  ProjectId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./shared.js";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactReason,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  CompactTrigger,
} from "../compact/index.js";
import {
  isBlockIndex,
  type ModelId,
  type ModelProviderId,
  type ModelSelection,
  type ModelToolSideEffectScope,
} from "../model/index.js";
import type { TodoItem } from "../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { PermissionRuleset } from "./permission.port.js";
import type { CollaborationMode } from "./session.port.js";
import type { EnvInfo } from "./context-source.port.js";

export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;
export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export type SessionLastOutcome = "completed" | "error" | "interrupted";

export const MESSAGE_VISIBILITIES = ["user-visible", "model-only"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const SYNTHETIC_USER_MESSAGE_SOURCES = [
  "agent_listing_delta",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "bot_topic_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动已保存工作流时落的那条 user 消息的来源。
  // 它虽是 synthetic（GUI 用元数据画启动卡而非显示文本），语义上却是用户真实动作：
  // origin=real_user、kind=user_prompt，与其余「运行时注入的提醒」类来源不同档。
  "workflow_launch",
  "shared_context",
] as const;
export type SyntheticUserMessageSource = (typeof SYNTHETIC_USER_MESSAGE_SOURCES)[number];

export type MessageSemanticsOrigin =
  | "real_user"
  | "agent_runtime"
  | "system"
  | "migration"
  | "import";

export type MessageSemanticsKind =
  | "user_prompt"
  | "slash_command"
  | "system_reminder"
  | "background_notification"
  | "subagent_notification"
  | "todo_reminder"
  | "rewind_notice"
  | "fork_notice"
  | "timeline_event"
  | "compact_summary"
  | "shared_context"
  | "assistant_response";

export interface MessageSemantics {
  origin: MessageSemanticsOrigin;
  kind: MessageSemanticsKind;
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}

// v4 投影锚点词表（userInput.origin）。
// 与 MessageSemanticsOrigin 并存不互替：semantics.origin 是旧读侧语义，
// anchor.origin 是新协议 row 派生依据；老值由读侧只读映射。
export const MESSAGE_ANCHOR_ORIGINS = [
  "realUser",
  "backgroundResult",
  "goalContinuation",
  "mailbox",
  "synthetic",
] as const;
export type MessageAnchorOrigin = (typeof MESSAGE_ANCHOR_ORIGINS)[number];

/**
 * stable fork 的 fork 点 goal 事实。undefined 只表示旧数据；新数据必须显式写 none
 * 或完整快照，避免 fork 时读取 parent 当前 goal 冒充历史状态。
 */
export type StableForkGoalBoundaryMetadata =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

/**
 * v4 transcript 锚点（清单）：全部 optional，
 * 走 message JSON blob 的 additive 演进，历史数据留空、读侧宽容降级。
 * sourceCommandId 是命令幂等的 transcript 兜底查重键，
 * 由 v4 command inbox 铺路后写入（接线）。
 */
export interface MessageProjectionAnchor {
  turnId?: TurnId;
  origin?: MessageAnchorOrigin;
  sourceCommandId?: string;
  /** 最终 assistant 固化当前 query 的历史轮次，供 cold hydration 精确恢复。 */
  historyRoundCount?: number;
  /** 新数据的 stable fork 固定边界；历史消息缺省，由唯一 resolver 无歧义时惰性补写。 */
  productTurnId?: string;
  orderedMessageIds?: MessageId[];
  boundaryMessageId?: MessageId;
  goalBoundary?: StableForkGoalBoundaryMetadata;
}

export interface SessionInfo {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  lastOutcome?: SessionLastOutcome;
  shareURL?: string;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  summaryDiffs?: FileDiff[];
  revert?: SessionRevert;
  permission?: PermissionRuleset;
  time: {
    created: number;
    updated: number;
    titleUpdated?: number;
    compacting?: number;
    deleted?: number;
  };
}

export interface CreateSessionInput {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType?: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  permission?: PermissionRuleset;
  time?: {
    created?: number;
    updated?: number;
  };
}

/** V4 stable fork resolver 固定的目标 product turn segment。 */
export interface StableForkTargetMetadata {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

/** 与 child session 同事务落盘的命令幂等事实。 */
export interface ForkChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string;
  forkTarget: StableForkTargetMetadata;
}

export type ForkCommandResult =
  | { type: "forkAssistant"; sessionId: string }
  | { type: "createSelectionSideSession"; sessionId: string }
  | { type: "editUserQuery"; disposition: "fork"; sessionId: string };

/**
 * 数据库内 fork 的规划输入。messages 只供选择边界和改写引用：正文、文件 URL、
 * 工具输入/输出等载荷已省略，不能用于展示或模型请求。隐藏系统提醒保留选型所需文本。
 * build 必须同步、无 I/O，返回的 copySources 指向该快照；源记录在提交前保持不变。
 */
export interface ForkFromSourceInput {
  sessionID: SessionId;
  build(source: { session: SessionInfo; messages: MessageWithParts[] }): ForkCommitBundle;
}

/**
 * conversation fork 的唯一原子提交载荷。core 在内存完成 remap；adapter 不参与业务裁决，
 * 只保证 child/copy/goal/entries/input/parent command fact 全有或全无。
 */
export interface ForkCommitBundle {
  child: CreateSessionInput;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  /** 存储复制来源（目标 ID -> 父记录 ID）；用于数据库复制/旧字段保留，不参与模型选择。 */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  goal?: { source: SessionGoal; status: GoalStatus };
  initialInput?: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  };
  commandFact: {
    parentSessionId: string;
    sourceCommandId: string;
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    metadata: Record<string, unknown>;
  };
}

/**
 * 同一 session 的多条消息及其 part 按顺序写入，全有或全无。
 * 用于 compaction 的请求前公告、summary 与附件，以及空闲整批通知（一条消息多个文本 part）。
 */
export interface MessageCommitBundle {
  sessionID: SessionId;
  messages: MessageWithParts[];
}

export interface UpdateSessionInput {
  id: SessionId;
  lastOutcome?: SessionLastOutcome;
  directory?: string;
  path?: string | null;
  timeUpdated?: number;
  title?: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId | null;
  expectedTitleSources?: readonly SessionTitleSource[];
  shareURL?: string | null;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
    diffs?: FileDiff[];
  } | null;
  revert?: SessionRevert | null;
  permission?: PermissionRuleset | null;
  timeCompacting?: number | null;
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  oldPath?: string;
  newPath?: string;
}

export interface SessionRevert {
  messageID: MessageId;
  partID?: PartId;
  snapshot?: string;
  diff?: string;
  kind?: "conversation_rewind";
  scope?: "conversation" | "workspace" | "both";
  targetMessageID?: MessageId;
  createdMessageID?: MessageId;
  keptMessageIDs?: MessageId[];
  /**
   * append-only conversation branch 的 cut 游标：本次 rewind 提交前最后一条持久消息。
   * active branch = keptMessageIDs + 该消息之后新追加的消息。旧 createdMessageID 仅用于兼容。
   */
  branchCutAfterMessageID?: MessageId;
  /** 每次 destructive conversation rewind 单调递增，用于隔离旧分支异步结果。 */
  branchGeneration?: number;
}

export interface ListSessionsInput {
  projectID?: ProjectId;
  /** undefined = 不按 identity 过滤；null = 仅本地/legacy 空 identity；字符串 = 精确 workspace identity。 */
  workspaceID?: WorkspaceId | null;
  directory?: string;
  path?: string;
  roots?: boolean;
  taskTypes?: SessionTaskType[];
  limit?: number;
}

export interface ClaimLegacySessionWorkspaceInput {
  sessionIDs: SessionId[];
  directory: string;
  workspaceID: WorkspaceId;
}

export interface RepairLegacyRemoteSessionWorkspaceInput {
  sessionID: SessionId;
  projectID: ProjectId;
  legacyWorkspaceDirectory: string;
  workspaceID: WorkspaceId;
  workspacePath: string;
}

export interface RepairRemoteSessionPathsInput {
  sessionID: SessionId;
  workspaceID: WorkspaceId;
  expectedDirectory: string;
  expectedPath: string | null;
  directory: string;
  path: string | null;
  timeUpdated: number;
}

export type OutputFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

export interface MessageSummary {
  title?: string;
  body?: string;
  diffs: FileDiff[];
}

export interface MessageContextSnapshot {
  envInfo?: EnvInfo;
}

export interface UserMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: MessageSummary;
  agent: string;
  /** 未绑定会话的合成消息、缺少模型信息的旧消息不伪造请求来源。 */
  modelSelection?: ModelSelection;
  system?: string;
  tools?: Record<string, boolean>;
  contextSnapshot?: MessageContextSnapshot;
  synthetic?: boolean;
  source?: SyntheticUserMessageSource;
  visibility?: MessageVisibility;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  metadata?: Record<string, unknown>;
}

export interface AssistantErrorInfo {
  name: string;
  data?: Record<string, unknown>;
}

export interface TokenUsageInfo {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface AssistantMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: AssistantErrorInfo;
  parentID: MessageId;
  /** 真正模型输出应携带来源；历史恢复的合成时间线允许没有执行模型。 */
  modelId?: ModelId;
  providerId?: ModelProviderId;
  mode: string;
  /** 当前输出对应的 Plan 状态；旧记录缺失时按旧 mode 解释，不回填历史。 */
  planEnabled?: boolean;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: TokenUsageInfo;
  structured?: unknown;
  reasoningLevel?: string;
  finish?: string;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  /** 附加领域语义（fork copy 的 forkOrigin provenance 等）。 */
  metadata?: Record<string, unknown>;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface TextPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  /** assistant 块到达序号，见 docs/design/v2/model/assistant-block-order.md；旧记录缺失。 */
  blockIndex?: number;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ReasoningPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "reasoning";
  text: string;
  /** assistant 块到达序号；不放进 metadata，因为 metadata 会原样变成 providerOptions。 */
  blockIndex?: number;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end?: number;
  };
}

export type FilePartSource =
  | {
      type: "file";
      path: string;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "symbol";
      path: string;
      range: unknown;
      name: string;
      kind: number;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "resource";
      clientName: string;
      uri: string;
      text: { value: string; start: number; end: number };
    };

export interface AttachmentStorageMetadata {
  sizeBytes?: number;
  sha256?: string;
  image?: {
    maxDimension?: number;
    originalWidth?: number;
    originalHeight?: number;
    width?: number;
    height?: number;
    resized?: boolean;
    transformedSizeBytes?: number;
  };
  storageKind?: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  artifactUri?: string;
  originalUrl?: string;
  /** 路径引用首次发送的完整说明；恢复时原样复用，不能用文件内容 preview 代替。 */
  pathReferenceText?: string;
  recoverability?: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  preview?: {
    text?: string;
    truncated?: boolean;
    originalBytes?: number;
    startLine?: number;
    totalLines?: number;
    truncatedByTokenCap?: boolean;
    partialViewNotice?: string;
  };
  errorCode?: string;
}

export interface FilePart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
  metadata?: AttachmentStorageMetadata;
}

export interface AgentPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
}

export interface CompactionPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "compaction";
  auto: boolean;
  trigger?: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  overflow?: boolean;
  tail_start_id?: MessageId;
  compactBoundary?: CompactBoundaryPayload;
  operationId?: string;
  timelineStatus?: CompactTimelineStatus;
  timelineDisplay?: CompactTimelineDisplay;
  timelineText?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  time?: {
    start?: number;
    end?: number;
  };
  /** 不进入 strict 的 compactBoundary 与 App 协议；旧版本按 JSON 读取时忽略。 */
  metadata?: CompactionPartMetadata;
}

export interface CompactionPartMetadata {
  /** summary 之前的请求前公告；冷恢复放回 summary 之前，切片之后的保留段时跳过。 */
  compactLeadingMessageIds?: MessageId[];
}

export type TimelinePartDisplay = "separator" | "worklog";

export type TimelinePartStatus =
  | "started"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | string;

export interface TimelineModelSelection extends ModelSelection {
  label?: string;
}

export interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  display: TimelinePartDisplay;
  status?: TimelinePartStatus;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  /** 用户命令产生的 marker 查重锚点；auto/system marker 缺省。 */
  sourceCommandId?: string;
  /**
   * fork copy 降级 provenance：anchor 指向未被复制的消息/父轮时，
   * 本地 anchor 必须清空（不得参与 child 落位），原引用降级到 origin* 仅供溯源。
   */
  originAnchorMessageId?: MessageId;
  originAnchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface ContextCompactionTimelinePart extends TimelinePartBase {
  timelineType: "context_compaction";
  operationId: string;
  trigger: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

export interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}

export interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: TimelineModelSelection;
  /** 回滚再升级后模型配置可缺失；不能因此丢掉整条历史内容。 */
  toModel?: TimelineModelSelection & { label: string };
}

/** 受管 worktree 的创建结果（docs/git/worktree.md §6.6.4）；由 Host 创建 worktree 后交给 CLI 落盘。 */
export interface WorktreeCreationFact {
  /** worktree 根目录。 */
  path: string;
  /** 检出的 commit。 */
  sha: string;
  /** 用户选择的起点；null = 源目录当前 HEAD。 */
  ref: string | null;
  /** git 与拷贝输出的末尾。 */
  output: string;
}

export interface WorktreeCreationTimelinePart extends TimelinePartBase {
  timelineType: "worktree_creation";
  worktreeCreation: WorktreeCreationFact;
}

export type TimelinePart =
  | ContextCompactionTimelinePart
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart
  | WorktreeCreationTimelinePart;

export type TimelinePartDraft = TimelinePart extends infer Part
  ? Part extends TimelinePart
    ? Omit<Part, "id" | "messageID" | "sessionID" | "type">
    : never
  : never;

export interface SubtaskPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerId: ModelProviderId;
    modelId: ModelId;
  };
  command?: string;
}

export interface RetryPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "retry";
  attempt: number;
  error: AssistantErrorInfo;
  time: {
    created: number;
  };
}

export interface StepStartPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: TokenUsageInfo;
}

export interface SnapshotPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "snapshot";
  snapshot: string;
}

export interface PatchPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "patch";
  hash: string;
  files: string[];
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: FilePart[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "tool";
  callID: string;
  /** 旧记录的本地工具声明序号；新记录改写 blockIndex，读取保留给旧数据。 */
  declarationIndex?: number;
  /**
   * assistant 块到达序号，与 text / reasoning part 共用；重试新建的 part 沿用同一序号。
   * 每次写入都必须带上：savePart 冲突更新整体替换 data，漏写一次这条消息就静默按旧数据排序。
   */
  blockIndex?: number;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | CompactionPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

/** 浏览器轮尾截图 tool part 的 `state.input.source`。它只用于展示，不是模型块，不带 blockIndex。 */
export const BROWSER_TURN_SCREENSHOT_SOURCE = "browser_turn_end" as const;

// 返回 boolean 而不是类型谓词：它只认一种 tool part，取反时不能把所有 ToolPart 都收窄掉。
// 仓库每次读取都会对所有 tool part 调用它；part data 没有 schema 校验，损坏数据可能没有 state 或 input，
// 按非截图处理，不能让一个坏 part 中断整个会话的读取。
export function isBrowserTurnScreenshotPart(part: MessagePart): boolean {
  return part.type === "tool" && part.state?.input?.source === BROWSER_TURN_SCREENSHOT_SOURCE;
}

type AssistantBlockPart = TextPart | ReasoningPart | ToolPart;

// 类型谓词只按 part 类型判断。截图也是 ToolPart，单独用 isBrowserTurnScreenshotPart 排除：
// 把截图判断放进类型谓词，false 分支会把所有 ToolPart 都收窄掉。
function isBlockTypePart(part: MessagePart): part is AssistantBlockPart {
  return part.type === "reasoning" || part.type === "text" || part.type === "tool";
}

/** 是否参与 assistant 块顺序：reasoning、text、tool，浏览器轮尾截图除外。 */
export function isAssistantBlockPart(part: MessagePart): boolean {
  return isBlockTypePart(part) && !isBrowserTurnScreenshotPart(part);
}

/** 参与 assistant 块顺序的 part，保持原顺序。 */
export function assistantBlockParts(parts: readonly MessagePart[]): AssistantBlockPart[] {
  return parts.filter(isBlockTypePart).filter((part) => !isBrowserTurnScreenshotPart(part));
}

/**
 * 有序 assistant 消息：至少有一个块 part，且所有块 part 的 blockIndex 都合法（isBlockIndex）。
 * 不满足时整条消息按旧数据处理，不存在“部分有序”。要求至少一个块 part：没有块 part 的旧消息
 * 留在旧路径，空消息的处理不变。
 * 见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
 */
export function hasOrderedAssistantBlocks(parts: readonly MessagePart[]): boolean {
  const blockParts = assistantBlockParts(parts);
  return blockParts.length > 0 && blockParts.every((part) => isBlockIndex(part.blockIndex));
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */
export interface SharedContextImportCommitBundle {
  session: CreateSessionInput;
  contextMessage: MessageWithParts;
  provenance: SessionEntryInfo;
}

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}

export const SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION =
  "target_completion_verification" as const;
export const SESSION_ENTRY_MODEL_SELECTION = "runtime/model_selection" as const;
export const SESSION_ENTRY_EXECUTION_STATE = "runtime/execution_state" as const;
export const SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION =
  "runtime/user_input_auto_resolution" as const;
export const SESSION_ENTRY_WORKSPACE_CHECKPOINT = "runtime/workspace_checkpoint" as const;
export const SESSION_ENTRY_WORKSPACE_FILE_REWIND = "runtime/workspace_file_rewind" as const;
/** 动态工作流工具面已在本会话激活（docs/dynamic-workflow/launch.md「On demand: activation」）。 */
export const SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION =
  "runtime/dynamic_workflow_activation" as const;
/** 本会话用过的能力标签（docs/design/v2/model/session-features-header.md）。 */
export const SESSION_ENTRY_SESSION_FEATURES = "runtime/session_features" as const;
/** 主会话发出的 system 与它对应的模型；不含工具定义（docs/design/v2/loop/prompt-snapshot.md）。 */
export const SESSION_ENTRY_PROMPT_SNAPSHOT = "runtime/prompt_snapshot" as const;

export const SESSION_ENTRY_TYPES = [
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  SESSION_ENTRY_SESSION_FEATURES,
  SESSION_ENTRY_PROMPT_SNAPSHOT,
] as const;

export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number];

export interface SessionEntryInfo {
  id: string;
  sessionID: SessionId;
  type: SessionEntryType | string;
  // session entry 既承载用户/工具活动，也承载 session-local 配置快照。
  // 配置恢复或切换只应更新 entry 自己的版本，不能把任务活动时间伪装成“刚刚”。
  touchSession?: boolean;
  time: {
    created: number;
    updated: number;
  };
  /**
   * 逻辑 payload，不等同于数据库 JSON。runtime/model_selection 的读写为公共
   * ModelSelection（无选择沿用 null）；SQLite adapter 负责 modelSelection 包装，
   * 旧平铺字段仅供一次性迁移/回滚，不能暴露给普通消费者或复制到 fork 子记录。
   */
  data: unknown;
}

// ── session_input 账本──
// 输入的 durable 生命周期：admitted（已接受，排队/待注入）→ promoted（已消费成
// transcript user message，与消息持久化同事务）/ cancelled（用户删除队列项等）/
// discarded（session_resumed=重启不保留队列；user_cleared=heldQueue 清空发送）/
// failed（已接受但运行时无法启动；保留终态，重启时禁止再改写成 discarded）。
// id = input/command id（admission 时即存在）；promoted_message_id 是 nullable 外键——
// messageId 在 drain 时才生成。startNow 也必须先经过 durable admission：即使 CLI 在 ACK 后、
// user message 原子 promotion 前崩溃，恢复端也能把输入明确标成 discarded。
export type SessionInputDelivery = "startNow" | "guide" | "queue";

export type SessionInputStatus = "admitted" | "promoted" | "cancelled" | "discarded" | "failed";

export interface SessionInputRecord {
  id: string;
  sessionID: SessionId;
  kind: string;
  delivery: SessionInputDelivery;
  payload: { text: string; [key: string]: unknown };
  admittedSequence: number;
  promotedSequence?: number;
  promotedMessageID?: MessageId;
  status: SessionInputStatus;
  statusReason?: string;
  time: { created: number; updated: number };
}

export type UsageQuerySource =
  | "main_turn"
  | "compact"
  | "session_title"
  | "goal_completion_verification"
  | "subagent"
  | "workflow_child"
  | "unknown";

export type UsageStatus = "running" | "completed" | "error" | "cancelled";

export interface ModelUsageRecord {
  id: string;
  logicalRequestId: string;
  attemptIndex?: number;
  sessionID: SessionId;
  turnID?: TurnId;
  traceID?: TraceId;
  spanID?: string;
  assistantMessageID?: MessageId;
  parentUserMessageID?: MessageId;
  querySource: UsageQuerySource | string;
  providerId: ModelProviderId | string;
  modelId: ModelId | string;
  reasoningLevel?: string;
  agent?: string;
  mode?: string;
  taskType?: SessionTaskType;
  status: UsageStatus;
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  providerTotalTokens?: number;
  computedTotalTokens?: number;
  retryCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  rawUsage?: unknown;
  providerMetadata?: unknown;
}

export interface TurnUsageRecord {
  sessionID: SessionId;
  turnID: TurnId;
  traceID?: TraceId;
  userMessageID?: MessageId;
  status: UsageStatus;
  startedAt: number;
  firstModelStartAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  modelRequestCount?: number;
  modelRetryCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  computedTotalTokens?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
}

export interface ToolUsageRecord {
  id: string;
  sessionID: SessionId;
  turnID?: TurnId;
  traceID?: TraceId;
  toolCallID: ToolCallId | string;
  toolName: string;
  sideEffectScope?: ModelToolSideEffectScope | string;
  readOnly?: boolean;
  destructive?: boolean;
  approvalStatus?: "none" | "requested" | "allowed" | "denied";
  status: UsageStatus;
  startedAt: number;
  firstOutputAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstOutputMs?: number;
  exitCode?: number;
  outputBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  truncated?: boolean;
  retryCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AppUsageQueryInput {
  /** 含 (since, until] 的下界（unix ms）。 */
  since: number;
  /** 上界（unix ms），通常为 now。 */
  until: number;
  /** 调用端时区相对 UTC 的固定偏移（ms），用于按本地日归桶。 */
  tzOffsetMs: number;
}

export interface AppUsageTotalsRow {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  avgTimeToFirstTokenMs: number | null;
}

export interface AppUsageTurnTotalsRow {
  totalSessions: number;
  totalTurns: number;
  avgTurnDurationMs: number | null;
  longestSessionMs: number;
}

export interface AppUsageToolTotalsRow {
  toolCallCount: number;
  toolErrorCount: number;
}

export interface AppUsageModelRow {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface AppUsageToolRow {
  toolName: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number | null;
}

export interface AppUsageDayRow {
  dayIndex: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

export interface AppUsageDayModelRow {
  dayIndex: number;
  modelId: string | null;
  totalTokens: number;
}

export interface AppUsageQueryResult {
  totals: AppUsageTotalsRow;
  turnTotals: AppUsageTurnTotalsRow;
  toolTotals: AppUsageToolTotalsRow;
  models: AppUsageModelRow[];
  tools: AppUsageToolRow[];
  days: AppUsageDayRow[];
  dayModels: AppUsageDayModelRow[];
}

export interface TaskUsageQueryInput {
  sessionID: SessionId;
}

export interface TaskUsageQueryResult {
  sessionID: SessionId;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  inputBaselineBySource: Record<string, number>;
}

export interface UsageStorePort {
  recordModelUsage(input: ModelUsageRecord): Promise<void>;
  upsertTurnUsage(input: TurnUsageRecord): Promise<void>;
  upsertToolUsage(input: ToolUsageRecord): Promise<void>;
  queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult>;
  queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult>;
}

export interface LocalSettingStorePort {
  getProjectPermissionMode(
    projectID: ProjectId,
  ): CollaborationMode | null | Promise<CollaborationMode | null>;
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode | Promise<CollaborationMode>;
}

/** 永久删除只保留身份与附件引用元数据，不备份会话正文。 */
export interface SessionDeletionReference {
  sessionId: SessionId;
  artifactId: string;
  referrers: Array<{ sessionId: SessionId; title: string }>;
}
export interface SessionDeletionSnapshot {
  workspacePath?: string;
  workspaceIdentity?: string;
  revision: string;
  sessionIds: SessionId[];
  forks: Array<{ sessionId: SessionId; title: string }>;
  references: SessionDeletionReference[];
  foreignRuntime: boolean;
  localRuntimeIds: SessionId[];
  pendingWork: boolean;
  deleting: boolean;
  completed: boolean;
}

export interface SessionStorePort {
  inspectSessionDeletion?(sessionID: SessionId): Promise<SessionDeletionSnapshot>;
  beginSessionDeletion?(
    sessionID: SessionId,
    revision: string,
    operationId: string,
    retained: Array<{ sessionId: SessionId; artifactId: string }>,
  ): Promise<void>;
  completeSessionDeletion?(sessionID: SessionId): Promise<void>;
  registerSessionRuntime?(sessionID: SessionId): Promise<void>;
  unregisterSessionRuntime?(sessionID: SessionId): Promise<void>;
  assertSessionNotDeleting?(sessionID: SessionId): Promise<void>;
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** legacy 兼容原语；V4 stable/compact-edit fork 禁止调用，统一走 commitForkBundle。 */
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** V4 stable/compact-edit fork 的唯一事务入口。legacy workspace fork 不调用。 */
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  /** 在同一写事务内读取轻量快照、同步规划、批量复制并提交 fork。 */
  commitForkFromSource?(input: ForkFromSourceInput): Promise<SessionInfo>;
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  /** 一组消息的唯一事务入口；未实现时调用方逐条写入。 */
  commitMessageBundle?(bundle: MessageCommitBundle): Promise<void>;
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  /** 只写一次删除时间；正文保留，普通列表永不返回软删除行。 */
  softDeleteSession?(sessionID: SessionId, timeDeleted?: number): Promise<void>;
  /** 每个根会话 → 根自身与附属后代（subagent / workflow / 侧边问答，不含 fork）；根不存在为空数组。 */
  listOwnedSessionTrees?(sessionIDs: SessionId[]): Promise<Map<SessionId, SessionId[]>>;
  /** 每个目标会话 → part 中仍引用其附件（`zcode-artifact://<目标>/…`）的其他未删除会话；无引用的目标不出现。 */
  listArtifactReferrers?(sessionIDs: SessionId[]): Promise<Map<SessionId, SessionId[]>>;
  /** 彻底删除会话及附属后代的全部行；只用于用户确认的「删除数据」，已不存在的会话是空操作。 */
  purgeSessions?(sessionIDs: SessionId[]): Promise<void>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /**
   * 用 host task-index allowlist 为旧远端 session 补写 workspace identity。
   * 实现必须同时校验 id、directory 与 workspace_id is null，禁止覆盖已有 identity。
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * 修复曾把 remote identity 写入 directory/path 的单条历史 session。
   * 实现必须校验 session id、NULL workspace_id 及旧目录精确匹配，禁止批量路径迁移。
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * 已有 remote identity 的维护性路径自愈 CAS。
   * 实现只能更新 directory、path 和单调 time_updated，禁止写回其它 session 元数据。
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]>;
  // ── session_input 账本（可选方法，旧宿主可不实现）──
  /** admission：输入已被接受（排队/待注入），durable 记账。幂等（同 id 重入更新 payload）。 */
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** 审批完全访问：execution、固定队列权限和幂等 receipt 同一事务；无 schema migration。 */
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** queue 编辑/重排的 durable 原子更新；只允许修改 admitted 记录。 */
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("./session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * promotion（原子性硬要求）：账本置 promoted + user message/parts
   * 持久化在同一事务——杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
   */
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * 非原子 promotion 标记：message 持久化已在别处完成的路径（background wake 的
   * synthetic notice）只补账本状态。新路径应优先用 promoteSessionInput（原子）。
   */
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** 终态收口：cancelled（user_removed 等）/ discarded（session_resumed / user_cleared）。 */
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** global createSession.firstInput 查重：由 queue_<sourceCommandId> 找回真实 session。 */
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionId): Promise<void>;
}

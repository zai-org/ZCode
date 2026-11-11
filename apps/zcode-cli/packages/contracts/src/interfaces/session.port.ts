import type { GenUiModelContext } from "@zcode/shared/gen-ui";
import type { RuntimeInputPresentation } from "./runtime-input-presentation.js";
// ============================================================
// Session Ports - Core interfaces for session management
// ============================================================

import type { ErrorAttribution, SessionEvent } from "../events/session.events.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  QueryId,
  SessionId,
  TurnId,
  TraceId,
} from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CompactProjectionInfo } from "../compact/index.js";
import type { CheckpointProjectionInfo, RewindProjectionInfo } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorProjectionInfo,
  StreamingToolLedgerProjectionInfo,
} from "../events/stream-recovery.events.js";
import type { SessionGoal } from "../tools/target.js";
import type { GoalCompletionVerificationOutput } from "../tools/target.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "./permission.port.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ModelSelection } from "../model/model.js";

// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto";

/** 父 guarded 只收紧内部 YOLO 派生；显式的其它子模式保留各自策略。 */
export function inheritPermissionMode<T extends CollaborationMode | undefined>(
  parent: CollaborationMode | undefined,
  resolved: T,
): T | "guarded" {
  return parent === "guarded" && resolved === "yolo" ? "guarded" : resolved;
}

/**
 * 从严到宽，按各模式的默认策略排列；auto 尚未实现，不参与比较。
 * 例外：guarded 的危险命令审批先于 allow 规则，配置 allow 规则时 build/edit 可能放行 guarded 会询问的命令。
 */
const PERMISSION_MODE_STRICTNESS: readonly CollaborationMode[] = [
  "plan",
  "build",
  "edit",
  "guarded",
  "yolo",
];

/** 子模式只能收紧父模式：返回更严格的一个；任一方无法比较时继承父模式。 */
export function restrictPermissionMode(
  parent: CollaborationMode,
  child: CollaborationMode,
): CollaborationMode {
  const parentRank = PERMISSION_MODE_STRICTNESS.indexOf(parent);
  const childRank = PERMISSION_MODE_STRICTNESS.indexOf(child);
  return parentRank >= 0 && childRank >= 0 && childRank < parentRank ? child : parent;
}
export type SessionStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type InputDelivery = "auto" | "start_turn" | "steer_active_turn";
export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

// -----------------------------------------------
// Session Event Store Port
// -----------------------------------------------

/** 内存 event store 的驻留规模；只用于本地内存诊断日志。 */
export interface SessionEventStoreStats {
  sessions: number;
  events: number;
  /** 按 turn 窗口策略已淘汰的瞬态事件累计数；unbounded 模式恒为 0。 */
  evictedEvents?: number;
  /** 当前仍驻留的瞬态事件数（进行中 turn + 一个滞后 turn）。 */
  retainedTransient?: number;
}

export interface SessionEventStorePort {
  append(event: SessionEvent): Promise<SessionEvent>;
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  deleteSession(sessionId: SessionId): Promise<void>;
  /** 同步、O(sessions) 的只读统计；持久化实现可不提供。 */
  getStats?(): SessionEventStoreStats;
  /**
   * 低频 tick 触发的瞬态事件时间兜底淘汰；
   * 返回淘汰条数。持久化实现可不提供。
   */
  pruneTransientEvents?(nowMs?: number): number;
}

// -----------------------------------------------
// Live Session Event Sink Port
// -----------------------------------------------

export interface SessionEventSink {
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}

// -----------------------------------------------
// Session Projection Port
// -----------------------------------------------

export interface SessionProjection {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  planEnabled?: boolean;
  status: SessionStatus;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  pendingPermissions: PendingPermission[];
  pendingSteerInputs: PendingSteerInputInfo[];
  activeToolCalls: ActiveToolCall[];
  streamingToolLedger: StreamingToolLedgerProjectionInfo[];
  backgroundTasks: BackgroundTaskInfo[];
  currentTurnId?: TurnId;
  lastError?: ErrorInfo;
  lastCompact?: CompactProjectionInfo;
  lastCheckpoint?: CheckpointProjectionInfo;
  lastStreamRecoveryAnchor?: StreamRecoveryAnchorProjectionInfo;
  lastRewind?: RewindProjectionInfo;
  target?: SessionGoal | null;
  targetCompletionVerifications: GoalCompletionVerificationOutput[];
  targetCompletionVerificationTimeline: TargetCompletionVerificationProjectionInfo[];
}

export interface TargetCompletionVerificationProjectionInfo {
  targetId: string;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verificationId: string;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
  startedAt?: Date;
  updatedAt: Date;
}

export interface PendingPermission {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: string;
  toolName: string;
  reason?: string;
  riskLevel: RiskLevel;
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /** 请求事件携带的 ask 预览；冷恢复重建的会话弹窗仍需带图，所以必须进 projection 状态。 */
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
}

export interface PendingSteerInputInfo {
  pendingInputId: string;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** Host 准入注入的可信 automation 身份；队列提升时必须原样恢复。 */
  automationId?: string;
  /** 当前排队输入附带的工具隐藏列表；automation busy 入队必须在消费时继续生效。 */
  toolDisallowlist?: readonly string[];
  queuedAt: Date;
  targetTurnId: TurnId;
  traceId: TraceId;
  intent?: TurnInputIntentMetadata;
}

export interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt?: Date;
}

export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

export type BackgroundTaskInfoStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskInfo {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: string;
  blocked?: boolean;
  blockedReason?: string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskInfoStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export interface BackgroundTaskCancelResult {
  cancelled: boolean;
  reason?: string;
  snapshot?: BackgroundTaskInfo;
  status: BackgroundTaskInfoStatus;
  taskId: string;
}

export interface ErrorInfo {
  attribution?: ErrorAttribution;
  code?: string;
  detail?: string;
  type: string;
  message: string;
}

// -----------------------------------------------
// Event Reducer Port
// -----------------------------------------------

export interface EventReducerPort {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// -----------------------------------------------
// Session Manager Port
// -----------------------------------------------

export interface SessionManagerPort {
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
}

export interface SessionConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  traceId?: TraceId;
}

export interface Session {
  id: SessionId;
  config: SessionConfig;
  eventStore: SessionEventStorePort;
  projection: SessionProjection;
  eventReducer: EventReducerPort;
}

export interface TurnSteerInput {
  /** 临时执行的选型不可成为普通 Session 续跑默认；不包含请求凭据。 */
  modelSelectionScope?: "execution";
  /** 仅加速卡输入携带普通模型快照，不含凭据；用于接纳时更新 Session。 */
  highspeedFallbackSelection?: ModelSelection;
  input: string;
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  pendingInputId?: string;
  traceContext?: TraceContext;
  /** Host 准入注入的可信 automation 身份；不能从 inputId/queryId 推断。 */
  automationId?: string;
  /** 当前输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
}

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * 输入投递语义：
 * - "queue"：排队的未来意图，消费时切新 product turn（每条一轮，自己的回复/工时/edit 范围）；
 * - "guide"：对进行中工作的补充引导，内联在当前轮，不切轮。
 * runtime 注入机制两者相同（boundary 注入），差异只在产品呈现与账本语义。
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

/** message.data metadata.highspeed 的持久化契约；不包含运行时凭据。 */
export interface HighspeedMessageMetadata {
  schemaVersion: 1;
  ownerKey?: string;
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
  outputTokens?: number;
  durationMs?: number;
  savedDurationMs?: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  fallbackAt?: number;
  fallbackReason?:
    | "highspeed_card_expired"
    | "highspeed_request_failed"
    | "highspeed_selection_unavailable";
}

/**
 * 协议无关的输入 intent metadata；bootstrap v4 在事件边界组装为 ConversationInputIntent。
 * 与 @zcode/shared 的 conversationInputSourceSchema 一一对应（docs/design/v2/conversation-input-source.md）。
 */
export type TurnInputSourceMetadata =
  | { kind: "pluginUi"; pluginId: string; toolCallId: string }
  | { kind: "genUi"; path: string; title?: string }
  // title 只读旧数据（规格 0.13）：标题是会变的派生展示字段，新数据只带身份。
  | { kind: "session"; sessionId: string; title?: string }
  // 扩展经 Window Host 代发；只由 Host 注入，模型与工具不能设置。
  | { kind: "extension"; pluginId: string };

// 仅当前 CLI 实例内传递本次输入的能力。Symbol 键不进入 JSON 历史，冷恢复不能继承旧端的授权。
export const PLUGIN_DISCOVERY_INPUT = Symbol("pluginDiscoveryInput");
export interface TurnInputIntentMetadata {
  [PLUGIN_DISCOVERY_INPUT]?: true;
  planEnabled?: boolean;
  conversationQuotes?: Array<{
    text: string;
    path?: string;
    senderName?: string;
    senderId?: string;
    messageId?: string;
    sentAt?: string;
    /** 用户对该选区的批注，随引用一起作为模型材料。 */
    comment?: string;
    /** 选区来自子 agent 输出时的 agent 类型。 */
    agent?: string;
  }>;
  inputOrigin?: "desktop" | "mobile";
  botGroupSource?: {
    botIdentity?: { name: string; openId?: string };
    mentionedBot?: boolean;
    appId?: string;
    contentParts?: import("@zcode/shared").ChannelContentPart[];
    messages?: Array<{
      mentionedBot?: boolean;
      messageId: string;
      senderId: string;
      senderName: string;
      text: string;
      attachmentIndexes: number[];
      contentParts?: import("@zcode/shared").ChannelContentPart[];
    }>;
    /** 入队时由 Host 注入，历史资源请求不能借用后续重新授权的版本。 */
    authorizationId?: string;
    botId: string;
    provider: "feishu" | "lark";
    chatId: string;
    threadId?: string;
    rootMessageId?: string;
    topicContext?: {
      checkpoint: string;
      hasGap: boolean;
      messages: Array<{
        id: string;
        chatId: string;
        threadId: string;
        senderId: string;
        senderType: "user" | "app";
        text: string;
        createdAt: number;
        kind: string;
        deleted?: boolean;
      }>;
    };
    senderId: string;
    senderName: string;
    messageId: string;
  };
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** transcript hydration 贯穿完整 ConversationInputIntent 的 canonical command text。 */
  text?: string;
  /** Admission 时固定；Queue/Guide 后续不得重新读取 Composer 或 Session 最新选择。 */
  modelSelection?: ModelSelection;
  /** 与本次用户 Submission 一起固定的协作模式。 */
  mode?: "build" | "edit" | "plan" | "yolo" | "guarded";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
    sourceKind?: "clipboard-text" | "topic-history";
    messageCount?: number;
  }>;
  highspeed?: HighspeedMessageMetadata;
  /** 发送时冻结的页面状态；不得混入用户正文或出队时重新读取。 */
  genUiContext?: GenUiModelContext;
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** edit/retry 重建的新 command 对原始 canonical input cause 的稳定追溯。 */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  /** 插件、交互视图或会话代发的结构化来源；用户亲自输入时缺省。 */
  source?: TurnInputSourceMetadata;
}

/** queue 内保留尚未 resolve 的附件描述；消费时与普通 turn 使用同一 resolver。 */
export interface PendingTurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface PendingTurnInput {
  id: string;
  input: string;
  queuedAt: Date;
  traceId: TraceId;
  queryId?: QueryId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  /** Host 准入注入的可信 automation 身份；队列编辑和提升必须原样保留。 */
  automationId?: string;
  /** 当前 pending input drain 后不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  turnId: TurnId;
}

export type TurnSteerResult =
  | {
      kind: "queued";
      pendingInputId: string;
      queueLength: number;
      turnId: TurnId;
    }
  | {
      activeTurnId?: TurnId;
      kind: "rejected";
      reason: TurnSteerRejectReason;
    };

export interface SessionSummary {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
}

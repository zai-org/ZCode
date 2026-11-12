import {
  pluginUiToolResultNotificationSchema,
  type PluginUiToolResultNotification,
} from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import { LocalTtftRecorder } from "./local-ttft/contract.js";
import { localTtftNow, localTtftFactsSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  type BackgroundBashOutputResult,
} from "@zcode/shared/zcode-protocol-v4";
// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowRunSessionSummary,
  MessageWithParts,
  SessionEvent,
  TargetChangedPayload,
  TurnId,
  FileSystemErrorCode,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  isFileSystemPortError,
  slimRetainedModelRequest,
} from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type {
  CommandAck,
  AttachmentRef,
  CommandEnvelope,
  CommandKey,
  CommandResult,
  ConversationRowTarget,
  CommandsQueryResult,
  ConversationInputIntent,
  ConversationTopicFrame,
  QueueItem,
  RoutedTopicFrame,
  RoutedTopicWireFrame,
  SessionSummary,
  SessionsIndexReconcileParams,
  SessionsIndexReconcileResult,
  SessionsIndexTopicFrame,
  SubscribeAck,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationOpenTiming,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  readZCodeAttachmentFaultCode,
  encodeTopicWireFrames,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  parseCommandEnvelope,
  measureTopicNotificationEnvelopeBytes,
  parseConversationTopic,
  parseSessionsIndexTopic,
  sessionsIndexReconcileParamsSchema,
  sessionsIndexReconcileResultSchema,
  parseWorkspaceConfigTopic,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindPreviewParamsSchema,
  v4ConversationPlansParamsSchema,
  WORKFLOW_ARTIFACT_LIMITS,
  v4ConversationWorkflowRunArtifactDataParamsSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadParamsSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsParamsSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultParamsSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceParamsSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  WORKFLOW_WORKSPACE_LIMITS,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  v4ConversationWorkflowRunEventsParamsSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunsParamsSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import {
  ColdSessionResumeCoordinator,
  V4SessionNotResidentError,
  V4SubscribeSessionUnavailableError,
  type ColdSessionResumeOutcome,
} from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type {
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { V4CapabilityUnsupportedError } from "./commands/handlers/interaction-background.js";

function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection 为了 row 索引用 string 保存 product turnId；
  // 离开 gateway 调 runtime 文件摘要/回退能力时，需要恢复 contracts 的品牌类型。
  return turnId as TurnId | null;
}

function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
    case "setHighspeedMetrics":
      return type;
    default:
      return null;
  }
}

interface PersistedEventsLoadResult {
  events: SessionEvent[];
  synthesized: boolean;
  /** durable transcript 重放后、live buffer 补回前注入的 store-verified child manifest。 */
  subagentsSeed?: SessionSubagentsSeed;
  /** shared_context 不生成可见 row；只把脱敏 handover metadata 下发。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** memory eventStore 取快照时已包含的 raw sequence 水位。 */
  sourceEventSeq?: number;
  /** 与本次历史事件使用同一容量的种子；null 表示已查询但没有历史水位。 */
  usageSeed?: SessionUsageSeed | null;
}

export type V4GatewayErrorContext = Record<string, unknown>;

/**
 * 一条已读回的**整份字节**，供分块读取复用。
 *
 * 两个家族共用这张表：已发送附件的预览（`attachmentRead`）与 dwf 用户面产物的字节
 * （`workflowRunArtifactRead`）。共用是有意的——两者的失效规则逐字相同（TTL、字节预算、
 * 最旧先逐、会话销毁时按 `sessionId` 清），而分成两张表会得到两份**各自**的字节预算，
 * 于是"最多缓存多少字节"这条约束就再也说不清了。
 *
 * 键空间靠**首段标签**区分（`att` / `dwfart`），不靠字段个数或内容——两个家族的键都是
 * NUL 分隔的四五段，段数相同、内容也可能撞（一个叫 "1" 的产物 id 与一个 attachmentIndex
 * 1 会长得一样），只有一个不可能相等的首段才是可证明的隔离。
 *
 * `bytes` 为 null 表示读还在飞：此时它不计入预算，也不会被按预算逐出（逐出一个正在被
 * await 的条目只会让下一块重新读一遍整份文件，正是这张表要消灭的事）。
 */
interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export interface V4GatewayHost {
  /** 正在拆旧实例时，不允许订阅抢先重建 publisher。 */
  isSessionStopping?(sessionId: string): boolean;
  cliVersion?: string;
  /** 会话是否在宿主注册表中活跃（inbox 的 sessionNotFound 裁决依据）。 */
  sessionExists(sessionId: string): boolean;
  /**
   * V4 冷恢复钩子。gateway 用同一个 READY promise 包住 runtime activation 与 projection
   * hydration；宿主只负责恢复 record。
   */
  loadPersistedMessages?(sessionId: string): Promise<MessageWithParts[]>;
  retainSessionRuntime?(sessionId: string): Promise<() => void>;
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    persistedMessages?: MessageWithParts[],
  ): Promise<ColdSessionResumeOutcome>;
  /**
   * 下行物理帧出口（宿主负责投递：stdio notification / MessagePort / ws）。
   *
   * 逻辑帧 fallback 会绕过 1MiB 上限、分片和接收端原子组装边界；因此生产
   * host 与测试 host 都必须显式接收 physical wire，类型层不再允许退回逻辑帧。
   */
  emitWireFrame(frame: RoutedTopicWireFrame): void;
  /** 当前进程 live ingest 的无正文事实；不缓存、不进入 topic replay。 */
  emitConversationTelemetryFact?(fact: ConversationTelemetryFact): void;
  /** 当前进程 live 的模型请求指标；独立通知，不进 telemetry fact union。 */
  emitModelRequestMetrics?(
    fact: import("@zcode/shared/zcode-protocol-v4").ModelRequestMetricsFact,
  ): void;
  emitLocalTtftFacts?(facts: import("@zcode/shared").LocalTtftFacts): void;
  /** 当前进程 live request_access 权限事实；不缓存、不进入 topic replay。 */
  emitCuaPermissionObservation?(observation: CuaPermissionObservation): void;
  /** 成功 UI 工具结果的窗口副作用；与 conversation 订阅、历史 hydration 无关。 */
  emitPluginUiToolResult?(result: PluginUiToolResultNotification): void;
  /**
   * sessions-index：会话 → 所属 workspaceId（列表 topic 的分桶键）。
   * 未实现（旧宿主）→ sessions-index 路径整体不激活（no-op），不影响 conversation。
   */
  getSessionWorkspaceId?(sessionId: string): string | null;
  /** sessions-index：会话的列表用元信息（createdAt/父会话/最后活动时刻）。 */
  getSessionIndexMeta?(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    lastOutcome?: SessionSummary["lastOutcome"];
    parentSessionId?: string;
  } | null;
  /**
   * config 种子：会话 runtime 的当前真值（模型选型/思考深度/协作模式）。
   * 投影初值不能写死空值——runtime 的启动默认模型、项目持久化 mode 偏好、历史会话
   * resume 恢复的上次选型都只活在 runtime 里（ModelSelected 仅在 switchModelConfig 后
   * 补发，日志里可能根本没有），种子是它们进投影的唯一通道。
   * 会话不在册返回 null（gateway 跳过，保持空初值）；未实现（旧宿主/测试桩）同。
   */
  getSessionConfigSeed?(sessionId: string): SessionConfigSeed | null;
  /** 只读会话创建期 App 开关，不读取实时设置或推断 Memory 工具使用。 */
  getSessionMemoryEnabled?(sessionId: string): boolean | undefined;
  /**
   * 冷恢复 usage 种子：transcript 合成路径可能只能生成 0/默认窗口的占位
   * ModelComplete；宿主可从持久化 assistant tokens / runtime snapshot 提供真实水位。
   * 未实现时保持事件日志归约结果。
   */
  getSessionUsageSeed?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<SessionUsageSeed | null> | SessionUsageSeed | null;
  /** sessions-index：某 workspace 下当前在册的会话 id（冷启动 snapshot 用）。 */
  listWorkspaceSessionIds?(workspaceId: string): string[];
  /**
   * sessions-index：draft 判定——deferred 持久化且未发首条输入的会话不进列表。
   * 旧 workspace prepare 路径会预建 deferred 会话（历史上列表读 sqlite、
   * deferred 不落盘故不可见）；sessions-index 从活注册表派生后这些幽灵 draft 会
   * 以「新任务」出现在侧栏。首条 sendText 把 persistence 提升为 immediate 后，
   * 事件流自然触发 fanOutToIndex 使会话入列。未实现（旧宿主/测试桩）→ 不过滤。
   */
  isDraftSession?(sessionId: string): boolean;
  /**
   * sessions-index：从持久化 store 直接构造某 workspace 全部会话的轻量摘要（冷启动种子）。
   * 未加载（无 live publisher）的会话靠它进列表；已加载的会话由 gateway 用 live 投影覆盖。
   * store 读取是异步的，故允许返回 Promise（gateway 订阅时 await；同步 stub 直接返回数组）。
   */
  getStoredSessionSummaries?(workspaceId: string): Promise<SessionSummary[]> | SessionSummary[];
  reconcileSessions?(params: SessionsIndexReconcileParams): Promise<SessionsIndexReconcileResult>;
  /**
   * 3.3.6 远端历史兼容：用精确 task allowlist 幂等认领后返回严格 identity 摘要。
   * 非远端 workspace 返回 null；失败可降级为空数组，后续携带 allowlist 的订阅会重试。
   */
  refreshLegacySessionSummaries?(
    workspaceId: string,
    legacyTaskIds: readonly string[],
  ): Promise<SessionSummary[] | null> | SessionSummary[] | null;
  /**
   * 本地 workspace 下 cwd 位于受管 worktree 的会话摘要（docs/git/worktree.md §6.6.2）。
   * id 由 Host 从 tasks-index 精确提供；只读，宿主校验归属后才返回。
   */
  getWorktreeSessionSummaries?(
    workspaceId: string,
    sessionIds: readonly string[],
  ): Promise<SessionSummary[]> | SessionSummary[];
  /**
   * workspace-config：某 workspace 的配置目录（config options + slash 命令）。
   * 订阅时的种子与 invalidateWorkspaceConfig 重拉都走这里。
   * 未实现（旧宿主 / 测试桩）→ workspace-config 路径退化为空目录快照。
   */
  getWorkspaceConfig?(
    workspaceId: string,
  ): Promise<WorkspaceConfigState | null> | WorkspaceConfigState | null;
  readBackgroundBashOutput?(sessionId: string, workId: string): Promise<BackgroundBashOutputResult>;
  /** 执行 accepted 命令的副作用；返回值进 ACK.result（fork/createSession 带 sessionId）。 */
  executeCommand(
    envelope: CommandEnvelope,
    admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<CommandResult | undefined>;
  /** 输入命令执行前先落 durable admission；返回同一份完整 intent 供 inbox pin。 */
  admitCommandInput?(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelCommandInput?(
    envelope: CommandEnvelope,
    queueItemId: string,
    reason: string,
  ): Promise<void>;
  /** projection 运行中越过 16MiB 时终止当前 turn；同一 fault 周期由 gateway 保证只调用一次。 */
  terminateTurnForProjectionFault?(
    sessionId: string,
    reasonCode: "proto.payloadTooLarge",
  ): Promise<void> | void;
  /** commands/query 持久化 fallback；四个来源必须按 sourceCommandId 精确命中。 */
  lookupTranscriptCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupTimelineCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupChildCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupDiscardedCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  /** transcript 原子 promotion 后同步失效旧 lazy seed，再解除 CommandInbox live pin。 */
  invalidatePersistentCommandFacts?(sessionId: string): void;
  /** canonical goal complete 已进入 projection；宿主副作用必须 detached，禁止阻塞 ingest。 */
  onTargetCompleted?(sessionId: string, event: SessionEvent): void;
  /** Highspeed 真实耗时在 CLI 终态落 transcript；宿主副作用必须 detached。 */
  onHighspeedTurnTerminal?(
    sessionId: string,
    event: SessionEvent,
    snapshot: ConversationSnapshot,
  ): void;
  /** 完整 chunk transaction commit 后一次性写 session artifact。 */
  putSessionAttachment?(
    sessionId: string,
    input: { fileName: string; mime: string; bytes: Uint8Array },
  ): Promise<{ ref: string }>;
  /** 已发送 image/video/PDF 只读查询；gateway 完成 row/ref 授权后才允许进入宿主。 */
  readSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      maxBytes: number;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share 选择阶段的 userInput 附件 metadata stat；gateway 先完成 row/index 授权。 */
  statSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local 已发送视频路径；gateway 完成 row/index 授权后才允许进入宿主。 */
  resolveSessionAttachmentPreviewSource?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<V4AttachmentPreviewSourceResult>;
  getConversationFileChanges?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileChangesResult>;
  previewConversationFileRewind?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /**
   * workflow run 的事件日志分页（详情页审计面）。缺席 = 该会话 runtime 没有这个能力
   * （dwf journal 不可用 → run service 整个没构造），gateway 据此回结构化能力不支持错误。
   */
  listDynamicWorkflowRunEvents?(
    sessionId: string,
    input: { runId: string; afterSequence?: number; limit?: number; maxBytes?: number },
  ): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * dwf run 的枚举面（重启后的发现查询）。
   * 缺席条件同 {@link listDynamicWorkflowRunEvents}。
   */
  listDynamicWorkflowRuns?(
    sessionId: string,
    input: { limit?: number },
  ): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * workflow run 的**用户面产物**读面。三条一起在场、
   * 一起缺席（app 侧同一个条件注册）。缺席条件同 {@link listDynamicWorkflowRunEvents}。
   *
   * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
   */
  listDynamicWorkflowRunArtifacts?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  listDynamicWorkflowRunArtifactItems?(
    sessionId: string,
    input: {
      runId: string;
      artifactId: string;
      afterSequence?: number;
      limit: number;
      maxBytes: number;
      fields?: readonly string[];
    },
  ): Promise<DynamicWorkflowRunArtifactItemsResult>;
  readDynamicWorkflowRunArtifact?(
    sessionId: string,
    input: { runId: string; artifactId: string; version: number },
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * workflow run 的工作区 transcript：两条一起在场、
   * 一起缺席。授权在宿主侧（run 属于本会话）；拒绝与未知都回 `undefined`。
   */
  listDynamicWorkflowRunWorkspaceNodes?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(
    sessionId: string,
    input: { runId: string; siteId: string; ordinal: number; maxBytes: number },
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  /**
   * hydration：读取 session 的持久化事件用于冷订阅重建投影（fork child / resume /
   * app-restart）。`synthesized=true` 表示事件日志覆盖不了 transcript，events 是从
   * transcript 反向合成的——此时即便已有 cold publisher（fork resume 的 ingest 抢先
   * 建的）也要**重建**，否则历史不进投影。`synthesized=false`（完整事件日志）则保留
   * 已有 live publisher（流式不能被重建打断）。未实现（旧宿主）冷订阅退化为空投影。
   */
  loadPersistedEvents?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<PersistedEventsLoadResult>;
  /** 仅用于低频生命周期和恢复裁决；高频 event/stream trace 禁止走生产日志。 */
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: V4GatewayErrorContext): void;
}

export interface ConversationV4GatewayOptions {
  now?: () => number;
  /** logEpoch 生成器（默认进程内随机；测试注入固定值保证确定性）。 */
  createLogEpoch?: (sessionId: string) => string;
}

interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

interface RawSequenceState {
  /** 已经由 cold snapshot 或 live replay 消费的 runtime raw cursor。 */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset；遇到 sequence=0 时会向前校正。 */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** publisher 已成功 apply 的 event；runtime sink 已看见但仍在 gap buffer 的不在此集合。 */
  appliedEventIds: Set<string>;
  /** publisher apply 失败事实；临时 sink 迟到注册 waiter 时也必须立即 reject。 */
  failedEventById: Map<string, Error>;
  /** notify sink 可乱序；只有从 sourceEventSeq+1 连续时才可向投影 drain。 */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** synthesized hydration 重建投影时，补回持久读取边界之后已经到达的 raw 事实。 */
  recentRawEventsById: Map<string, SessionEvent>;
}

interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;
const MAX_TELEMETRY_EVENT_IDS = 2_000;
/** detached subagent child 终态后无订阅者时，publisher 由低频 tick 释放前的保留时长。 */
export const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;

class ProjectionEventCommitWaitError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.projectionEventCommit.aborted"
      | "fault.projectionEventCommit.applyFailed"
      | "fault.projectionEventCommit.disposed"
      | "fault.projectionEventCommit.gatewayDisposed"
      | "fault.projectionEventCommit.rehydrated"
      | "fault.projectionEventCommit.timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionEventCommitWaitError";
  }
}

/**
 * server 内部分派结果：initial frame 只供 request-scoped post-response outbox
 * 消费，公共 JSON-RPC result schema 始终严格为 `{ ack }`。
 */
export interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & { openTiming?: ConversationOpenTiming };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

export function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

/** 所有 physical wire 都被下游接受后才 commit publisher 水位。 */
export function emitReservedTopicFrame<F extends RoutedTopicFrame>(
  reservation: TopicFrameReservation<F>,
  emit: (wire: RoutedTopicWireFrame) => unknown,
): boolean {
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) emit(wire);
  return reservation.commit();
}

function subscriptionRouteKey(topic: string, subscriptionId: string, connectionId: string): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** 附件在文件系统层「确定不存在」的错误码集合。 */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * 把 host / FileSystemPort 抛出的错误归一成带稳定码的附件 fault。
 * host 已经给出结构化 fault 码时原样透传，其余按 FileSystemPortError.code 判定；
 * 都不匹配则保持原错误，让上层按「未知」处理，而不是猜成确定分类。
 */
function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}

export class ConversationV4Gateway {
  private readonly publishers = new Map<string, ConversationTopicPublisher>();
  /** sessions-index：workspaceId → 列表 publisher（与 conversation 并列，独立 seq/logEpoch）。 */
  private readonly indexPublishers = new SessionsIndexPublisherRegistry();
  /** workspace-config：workspaceId → 配置目录 publisher（conflated 整体替换态）。 */
  private readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();
  /** 已完成首次 hydration 的 session（避免重复重建 / 双计，见 hydratePublisher）。 */
  private readonly hydratedSessions = new Set<string>();
  /** 首次 hydration 按 session 单飞；并发 pane 共享同一份重建结果。 */
  private readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();
  /** cold activation 到 hydration 的 READY 水位；只阻塞本次恢复期间的 command/query。 */
  private readonly historyOpenings = new Map<
    string,
    {
      history: Promise<ConversationTopicPublisher>;
      messages: Promise<MessageWithParts[]>;
      finished: Promise<void>;
      start: () => void;
      cancel: () => void;
    }
  >();
  private readonly readyFlights = new Map<string, Promise<ConversationTopicPublisher>>();
  /** load await 窗口内的 raw accepted events；重建后按 cursor/eventId 补回。 */
  private readonly hydrationBuffers = new Map<string, HydrationBuffer>();
  /** transcript 合成序列与 runtime raw 序列之间的 per-session 单调映射。 */
  private readonly rawSequenceStates = new Map<string, RawSequenceState>();
  /** connection-independent；command admission 与 transport subscription 生命周期解耦。 */
  private readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();
  /** 没有独立 bootstrap record、但由父 runtime 持续转发 raw events 的 live child。 */
  private readonly detachedLiveSessions = new Set<string>();
  /**
   * detached subagent child 的父 record 归属与终态时间。child 没有自己的 record，publisher 只能随父 record 释放，
   * 或在 turn 结束且无订阅者、超过 grace 后由低频 tick 释放；否则会驻留到进程退出。
   */
  private readonly detachedChildParent = new Map<string, string>();
  private readonly detachedChildrenByParent = new Map<string, Set<string>>();
  private readonly detachedTerminalAt = new Map<string, number>();
  /** 冷恢复协调器（既有 activation 单飞 + 错误分型）。 */
  private readonly coldResume: ColdSessionResumeCoordinator;
  /** 订阅 → flush 调度状态（publisher 内部不持有定时器，调度归网关）。 */
  private readonly flushStates = new Map<string, FlushState>();
  /** ACK/outbox 尚未 admission 的 control reservation 禁止被 online flush 抢先发送。 */
  private readonly controlReservations = new WeakSet<object>();
  /** transport high-water pause 只按 trusted connectionId 隔离，不改变 ingest/publisher 真值。 */
  private readonly pausedConnections = new Set<string>();
  /** 一个越界周期只触发一次 runtime stop；终态事件到达后解除。 */
  private readonly projectionFaultedSessions = new Set<string>();
  private readonly inbox: CommandInbox;
  private readonly attachmentUploads: AttachmentUploadRegistry;
  private readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();
  private binaryReadCacheBytes = 0;
  private readonly localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      this.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) this.host.emitLocalTtftFacts?.(parsed.data);
    },
  );
  /** 高频进度事件的 index fan-out 节流（14-sessions-index「事件 fan-out 节奏」）。 */
  private readonly indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => this.publishCurrentSummaryToIndex(sessionId),
  });
  private readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly createLogEpoch: (sessionId: string) => string;
  private readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  private readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  private readonly telemetryEventIds = new Set<string>();
  private disposed = false;

  /** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) return;
    publisher.seedSharedContextImport(source);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
    }
  }

  /** durable session_input 已提交后、Core 启动前发布；仍由原 owner 控制生命周期。 */
  admitPendingInput(sessionId: string, envelope: CommandEnvelope, admittedAt: number): void {
    const publisher = this.ensurePublisher(sessionId);
    const snapshot = publisher.getSnapshot();
    if (
      snapshot.pendingCommands.some((command) => command.commandId === envelope.commandId) ||
      snapshot.queue.items.some((item) => item.sourceCommandId === envelope.commandId)
    )
      return;
    this.updatePendingInputs(sessionId, publisher, [
      ...snapshot.pendingCommands,
      {
        commandId: envelope.commandId,
        clientId: envelope.clientId,
        type: envelope.type,
        state: "accepted",
        at: admittedAt,
      },
    ]);
  }

  cancelPendingInput(sessionId: string, commandId: string): void {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) return;
    const pending = publisher.getSnapshot().pendingCommands;
    const remaining = pending.filter((command) => command.commandId !== commandId);
    if (remaining.length !== pending.length)
      this.updatePendingInputs(sessionId, publisher, remaining);
  }

  private updatePendingInputs(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    pending: ConversationSnapshot["pendingCommands"],
  ): void {
    publisher.setPendingCommands(pending);
    const sequence = this.getOrCreateRawSequenceState(sessionId);
    sequence.lastTransportSeq = publisher.getSnapshot().seq;
    sequence.offset = sequence.lastTransportSeq - sequence.sourceEventSeq;
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId === sessionId) this.scheduleFlush(routeKey, state, publisher);
    }
  }

  constructor(
    private readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      prepareDecision: async (envelope) => {
        // 重启正在等待旧 inbox 收口，不能让迟到命令反向等待同一个 restart，形成互等。
        if (envelope.sessionId && this.host.isSessionStopping?.(envelope.sessionId))
          throw new Error("fault.sessionLifecycle.stopping");
        if (
          envelope.sessionId &&
          (envelope.type === "renameSession" || envelope.type === "deleteSession") &&
          !this.host.sessionExists(envelope.sessionId)
        ) {
          // 历史行的重命名 / 删除仍由 CLI 原命令写持久事实；只在真实命令 admission 后冷恢复。
          // 身份取 Host 注入的 workspace（docs/git/worktree.md §9.3），否则 worktree 会话的 key
          // 会按存储 cwd 重建为 worktree 路径。
          // 旧标题交接可能先于订阅启动恢复。复用两阶段 opening，让后到的历史订阅
          // 可读首帧；迁移命令仍等待同一个 READY，不另建 publisher 或执行实例。
          if (this.host.loadPersistedMessages)
            await this.prepareSessionHistory(envelope.sessionId, envelope.workspace);
          await this.ensureColdReadyPublisher(envelope.sessionId, undefined, envelope.workspace);
        }
      },
      getRevision: (sessionId) => {
        if (
          !this.host.sessionExists(sessionId) &&
          !this.publishers.get(sessionId)?.getSnapshot().runtimeInitialization
        )
          return null;
        // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      // 在 inbox 去重之后拒绝新执行，不把未就绪输入接受进运行队列。
      guard: (envelope) => {
        const initialization =
          envelope.sessionId === null
            ? undefined
            : this.publishers.get(envelope.sessionId)?.getSnapshot().runtimeInitialization;
        return initialization && initialization.status !== "ready"
          ? {
              verdict: "reject",
              reasonCode:
                initialization.status === "failed"
                  ? "guard.runtimeInitializationFailed"
                  : "guard.runtimeInitializing",
            }
          : { verdict: "allow" };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }

  setConnectionFlowState(rawParams: unknown): void {
    const params = v4ConnectionFlowParamsSchema.parse(rawParams);
    if (params.state === "closed") {
      this.pausedConnections.delete(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      this.attachmentUploads.clearConnection(params.connectionId);
      return;
    }
    if (params.state === "saturated") {
      if (this.pausedConnections.has(params.connectionId)) return;
      this.pausedConnections.add(params.connectionId);
      this.clearConnectionFlushTimers(params.connectionId);
      return;
    }
    if (!this.pausedConnections.delete(params.connectionId)) return;
    this.flushConnection(params.connectionId);
  }

  private clearConnectionFlushTimers(connectionId: string): void {
    for (const state of this.flushStates.values()) {
      if (state.connectionId !== connectionId || state.timer === null) continue;
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private flushConnection(connectionId: string): void {
    for (const [routeKey, state] of this.flushStates) {
      if (state.connectionId !== connectionId) continue;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      const publisher = this.publishers.get(state.sessionId);
      if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
        this.flushStates.delete(routeKey);
        continue;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }
    for (const workspaceId of this.indexPublishers.keys()) {
      this.flushIndex(workspaceId, connectionId);
    }
    for (const workspaceId of this.configPublishers.keys()) {
      this.flushConfig(workspaceId, connectionId);
    }
  }

  /** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
  ingest(sessionId: string, event: SessionEvent): void {
    if (this.disposed) return;
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) {
      const eventId = String(event.id);
      if (hydrationBuffer.eventIds.has(eventId)) return;
      // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
      hydrationBuffer.eventIds.add(eventId);
      hydrationBuffer.rawEvents.push(event);
    }
    this.emitLiveTelemetryFact(sessionId, event);
    for (const normalizedEvent of this.normalizeRuntimeEventSequence(sessionId, event)) {
      try {
        this.localTtft.event(sessionId, normalizedEvent);
      } catch (error) {
        try {
          this.host.onError?.("v4.localTtft.observe", error);
        } catch {
          /* 诊断回调也不能阻断实际内容。 */
        }
      }
      this.ingestNormalizedEvent(sessionId, normalizedEvent);
    }
  }

  private emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void {
    const eventId = String(event.id);
    // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
    // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
    // 导致前台 Subagent 的真实轮次事实被静默丢弃。
    const telemetryEventKey = `${sessionId}\0${eventId}`;
    if (this.telemetryEventIds.has(telemetryEventKey)) return;
    this.telemetryEventIds.add(telemetryEventKey);
    if (this.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
      const oldest = this.telemetryEventIds.values().next().value;
      if (typeof oldest === "string") this.telemetryEventIds.delete(oldest);
    }
    try {
      const config =
        this.publishers.get(sessionId)?.getSnapshot().config ??
        this.host.getSessionConfigSeed?.(sessionId) ??
        undefined;
      const fact = this.telemetryNormalizer.normalize(sessionId, event, {
        memoryEnabled: this.host.getSessionMemoryEnabled?.(sessionId),
        modelName: config?.model,
        modelProvider: config?.provider,
      });
      if (fact) {
        this.host.emitConversationTelemetryFact?.(fact);
      }
      const metrics = this.telemetryNormalizer.normalizeModelRequestMetrics(sessionId, event, {
        memoryEnabled: this.host.getSessionMemoryEnabled?.(sessionId),
      });
      if (metrics) this.host.emitModelRequestMetrics?.(metrics);
    } catch (error) {
      // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
      this.host.onError?.("v4.telemetry.normalize", error);
    }
    try {
      const observation = this.cuaPermissionNormalizer.normalize(sessionId, event);
      if (observation) this.host.emitCuaPermissionObservation?.(observation);
    } catch (error) {
      // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
      this.host.onError?.("v4.cuaPermissionObservation.normalize", error);
    }
  }

  /** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway is disposed",
        ),
      );
    }
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.appliedEventIds.has(eventId)) return Promise.resolve();
    const failed = state.failedEventById.get(eventId);
    if (failed) return Promise.reject(failed);
    if (options.signal?.aborted) {
      return Promise.reject(
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal.reason },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const byEvent = this.projectionEventCommitWaiters.get(sessionId) ?? new Map();
      this.projectionEventCommitWaiters.set(sessionId, byEvent);
      const waiters = byEvent.get(eventId) ?? new Set();
      byEvent.set(eventId, waiters);
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) byEvent.delete(eventId);
        if (byEvent.size === 0) this.projectionEventCommitWaiters.delete(sessionId);
      };
      const waiter: ProjectionEventCommitWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
        // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
        // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.aborted",
            `projection event commit wait aborted: ${eventId}`,
            { cause: options.signal?.reason },
          ),
        );
      };
      const timeout = setTimeout(() => {
        this.rejectProjectionEventCommit(
          sessionId,
          eventId,
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.timeout",
            `projection event commit wait timed out: ${eventId}`,
          ),
        );
      }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
      timeout.unref?.();
      waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
  async waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void> {
    const state = this.getOrCreateRawSequenceState(sessionId);
    if (state.failedEventById.has(eventId)) {
      const event = state.recentRawEventsById.get(eventId);
      if (
        event?.type !== SessionEventType.SessionModeChanged ||
        !(event.payload as { permissionGrant?: unknown }).permissionGrant
      ) {
        throw new Error("Permission grant event unavailable for recovery");
      }
      await this.hydrationInFlight.get(sessionId);
      this.hydratedSessions.delete(sessionId);
      await this.hydratePublisher(sessionId, undefined, true);
    }
    await this.waitForProjectionEventCommit(sessionId, eventId);
  }

  private ingestNormalizedEvent(sessionId: string, event: SessionEvent): void {
    const publisher = this.ensurePublisher(sessionId);
    const promotedQueueRemoval =
      event.type === SessionEventType.TurnSteerDiscarded &&
      (event.payload as { reason?: string }).reason === "promoted";
    const removedQueueItems =
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded
        ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
            (queueItemId) => {
              const item = publisher
                .getSnapshot()
                .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
              return item ? [item] : [];
            },
          )
        : [];
    try {
      publisher.ingest(event);
    } catch (error) {
      const commitError =
        error instanceof ProjectionEventCommitWaitError
          ? error
          : new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply event ${String(event.id)}`,
              { cause: error },
            );
      this.rejectProjectionEventCommit(sessionId, String(event.id), commitError);
      if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
      this.host.onError?.("v4.projection.payloadTooLarge", error);
      if (!this.projectionFaultedSessions.has(sessionId)) {
        this.projectionFaultedSessions.add(sessionId);
        void Promise.resolve(
          this.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
        ).catch((terminateError) => {
          this.host.onError?.("v4.projection.terminate", terminateError);
        });
      }
      return;
    }
    this.resolveProjectionEventCommit(sessionId, String(event.id));
    // 原因：后台会话没有卡片/订阅时无法创建 guest。只在 live 投影提交后投递，
    // 从同一权威工具行取输入和 UI 描述；历史 hydration 直接写 publisher，不走此入口。
    if (event.type === SessionEventType.ToolCallResult && this.host.emitPluginUiToolResult) {
      const toolCallId = (event.payload as { toolCallId: string }).toolCallId;
      const row = publisher
        .getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
      if (
        row?.kind === "toolCall" &&
        row.status === "success" &&
        row.display?.kind === "mcp_tool"
      ) {
        const result = pluginUiToolResultNotificationSchema.safeParse({
          sessionId,
          toolCallId,
          serverName: row.display.serverName,
          ui: row.display.ui,
          ...(row.input && typeof row.input === "object" && !Array.isArray(row.input)
            ? { input: row.input }
            : {}),
        });
        if (result.success) this.host.emitPluginUiToolResult(result.data);
      }
    }
    if (
      !this.hydrationBuffers.has(sessionId) &&
      (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError)
    ) {
      try {
        this.host.onHighspeedTurnTerminal?.(sessionId, event, publisher.getSnapshot());
      } catch (error) {
        this.host.onError?.("v4.projection.highspeedMetrics", error);
      }
    }
    if (
      event.type === SessionEventType.TargetChanged &&
      (event.payload as TargetChangedPayload).target?.status === "complete"
    ) {
      try {
        this.host.onTargetCompleted?.(sessionId, event);
      } catch (error) {
        this.host.onError?.("v4.projection.targetCompleted", error);
      }
    }
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.projectionFaultedSessions.delete(sessionId);
    }
    if (event.type === SessionEventType.TurnSteerQueued) {
      const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
      const item = queueItemId
        ? publisher
            .getSnapshot()
            .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
        : undefined;
      if (item) this.inbox.pinLiveInput(sessionId, item);
    }
    if (!promotedQueueRemoval) {
      if (removedQueueItems.length > 0) {
        // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
        // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
        // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
        this.host.invalidatePersistentCommandFacts?.(sessionId);
      }
      for (const item of removedQueueItems) {
        this.inbox.releaseLiveInput({
          sessionId,
          commandId: item.sourceCommandId,
        });
      }
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
      if (sourceCommandId) {
        // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
        // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
        this.host.invalidatePersistentCommandFacts?.(sessionId);
        this.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
      }
    }
    // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
    // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
    // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
    if (publisher.getDroppedContentStreamEventCount() > 0 && this.hydratedSessions.has(sessionId)) {
      this.hydratedSessions.delete(sessionId);
      this.host.onError?.(
        "v4.assistantConservation",
        new Error(
          `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
        ),
      );
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      this.scheduleFlush(routeKey, state, publisher);
    }
    // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
    this.fanOutToIndex(sessionId, event);
  }

  /**
   * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
   * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
   */
  ingestDetachedLiveSession(
    sessionId: string,
    event: SessionEvent,
    parentSessionId?: string,
  ): void {
    if (!this.detachedLiveSessions.has(sessionId)) {
      this.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
    }
    this.detachedLiveSessions.add(sessionId);
    if (parentSessionId && parentSessionId !== sessionId) {
      this.detachedChildParent.set(sessionId, parentSessionId);
      let children = this.detachedChildrenByParent.get(parentSessionId);
      if (!children) {
        children = new Set();
        this.detachedChildrenByParent.set(parentSessionId, children);
      }
      children.add(sessionId);
    }
    // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
    // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      this.detachedTerminalAt.set(sessionId, Date.now());
    } else if (event.type === SessionEventType.TurnStarted) {
      this.detachedTerminalAt.delete(sessionId);
    }
    this.ingest(sessionId, event);
  }

  /**
   * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
   * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
   */
  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ): number {
    let released = 0;
    for (const [childId, terminalAt] of [...this.detachedTerminalAt]) {
      if (nowMs - terminalAt < graceMs) continue;
      if (this.host.sessionExists(childId)) continue;
      if (this.publishers.get(childId)?.hasSubscribers()) continue;
      this.releaseDetachedChild(childId);
      released += 1;
    }
    return released;
  }

  private releaseDetachedChild(childId: string): void {
    this.host.onDebug?.(`release detached live child publisher session=${childId}`);
    this.cleanupSessionRuntime(childId, { clearCommandInbox: false, notifyIndexRemoved: false });
  }

  /**
   * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
   * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
   * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
   * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
   */
  private fanOutToIndex(sessionId: string, event: SessionEvent): void {
    if (event.type === SessionEventType.ModelStreaming) return;
    // 工作流进度同样是高频流（实测 8s 4000 条），但列表要继续动，所以不是丢弃而是
    // leading + trailing 窗口节流：窗内合并为窗末一帧，终态仍在一个窗口内送达。
    if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
      this.indexFanoutThrottle.request(sessionId);
      return;
    }
    this.publishCurrentSummaryToIndex(sessionId);
  }

  /**
   * 把当前完整 projection 发布到 sessions-index。
   *
   * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
   * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
   * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
   * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
   */
  private publishCurrentSummaryToIndex(sessionId: string): void {
    // 这一次发布带的就是窗内合并后的当前摘要：待发的 trailing 到此被满足，不重复发帧。
    this.indexFanoutThrottle.notePublished(sessionId);
    const getWorkspaceId = this.host.getSessionWorkspaceId;
    if (!getWorkspaceId) return;
    try {
      const workspaceId = getWorkspaceId.call(this.host, sessionId);
      if (!workspaceId) return;
      if (this.host.isDraftSession?.(sessionId)) return;
      const indexPublisher = this.indexPublishers.get(workspaceId);
      if (!indexPublisher) return;
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) return;
      const changed = indexPublisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
      if (changed) this.flushIndex(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.sessionsIndex.ingest", error);
    }
  }

  /** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
  private resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    lastOutcome?: SessionSummary["lastOutcome"];
    parentSessionId?: string;
  } {
    const meta = this.host.getSessionIndexMeta?.(sessionId);
    return {
      createdAt: meta?.createdAt ?? 0,
      lastActivityAt: meta?.lastActivityAt ?? this.now(),
      ...(meta?.lastOutcome ? { lastOutcome: meta.lastOutcome } : {}),
      ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    };
  }

  /** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
  private flushIndex(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.indexPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.emit", error);
      }
    }
  }

  /**
   * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
   */
  async subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const dispatch = await this.subscribeSessionsIndexReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async reconcileSessions(rawParams: unknown): Promise<SessionsIndexReconcileResult> {
    const params = sessionsIndexReconcileParamsSchema.parse(rawParams);
    if (!this.host.reconcileSessions) throw new Error("sessionsIndex/reconcile is unavailable");
    return sessionsIndexReconcileResultSchema.parse(await this.host.reconcileSessions(params));
  }

  async subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a sessions-index topic: ${params.topic}`);
    }
    const publisher = await this.ensureIndexPublisher(
      workspaceId,
      params.legacyTaskIds,
      params.worktreeSessionIds,
    );
    // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
    this.indexPublishers.ensureActive();
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushIndex(workspaceId),
      );
    } catch (error) {
      // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
      // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
      result.rollback();
      throw error;
    }
  }

  /** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
  private async ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
    worktreeSessionIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const existing = this.indexPublishers.get(workspaceId);
    const shouldRefreshLegacy =
      Boolean(legacyTaskIds?.length) && Boolean(this.host.refreshLegacySessionSummaries);
    const shouldLoadWorktree =
      Boolean(worktreeSessionIds?.length) && Boolean(this.host.getWorktreeSessionSummaries);
    if (existing && !shouldRefreshLegacy && !shouldLoadWorktree) return existing;

    return this.indexPublishers.runExclusive(workspaceId, () =>
      this.ensureIndexPublisherExclusive(workspaceId, legacyTaskIds, worktreeSessionIds),
    );
  }

  /** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
  private async ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
    worktreeSessionIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    const refreshed =
      legacyTaskIds && legacyTaskIds.length > 0
        ? ((await this.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
        : null;
    // 受管 worktree 会话不在目录扫描结果里；每次带 id 订阅都补读一次（只补缺失项）。
    const worktreeSummaries =
      worktreeSessionIds && worktreeSessionIds.length > 0
        ? ((await this.host.getWorktreeSessionSummaries?.(workspaceId, worktreeSessionIds)) ?? [])
        : [];
    const existing = this.indexPublishers.get(workspaceId);
    if (existing) {
      // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
      // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
      const mergedLegacy = refreshed ? existing.mergeMissingStoredSummaries(refreshed) : false;
      const mergedWorktree =
        worktreeSummaries.length > 0 && existing.mergeMissingStoredSummaries(worktreeSummaries);
      if (mergedLegacy || mergedWorktree) this.flushIndex(workspaceId);
      return existing;
    }
    const publisher = new SessionsIndexPublisher(
      workspaceId,
      this.createLogEpoch(`sessions-index/${workspaceId}`),
      this.now,
    );
    // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
    const stored = refreshed ?? (await this.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
    for (const summary of stored) publisher.seed(summary);
    for (const summary of worktreeSummaries) publisher.seed(summary);
    // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
    const liveIds = this.host.listWorkspaceSessionIds?.(workspaceId) ?? [...this.publishers.keys()];
    for (const sessionId of liveIds) {
      const conversationPublisher = this.publishers.get(sessionId);
      if (!conversationPublisher) continue;
      // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
      if (this.host.isDraftSession?.(sessionId)) continue;
      publisher.ingestConversation(
        conversationPublisher.getSnapshot(),
        this.resolveIndexMeta(sessionId),
      );
    }
    this.indexPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /**
   * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
   */
  async subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const dispatch = await this.subscribeWorkspaceConfigReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const workspaceId = parseWorkspaceConfigTopic(params.topic);
    if (workspaceId === null) {
      throw new Error(`Not a workspace-config topic: ${params.topic}`);
    }
    const publisher = await this.ensureConfigPublisher(workspaceId);
    const result = publisher.subscribeReserved(params.connectionId, params.base);
    try {
      return this.subscribeDispatch(
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => this.flushConfig(workspaceId),
      );
    } catch (error) {
      // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
      result.rollback();
      throw error;
    }
  }

  /**
   * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
   * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
   * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
   * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
   */
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void {
    if (this.disposed) return;
    let publisher = this.configPublishers.get(workspaceId);
    if (!publisher) {
      publisher = new WorkspaceConfigPublisher(
        workspaceId,
        this.createLogEpoch(`workspace-config/${workspaceId}`),
        this.now,
      );
      this.configPublishers.set(workspaceId, publisher);
    }
    try {
      if (publisher.publish(state)) this.flushConfig(workspaceId);
    } catch (error) {
      this.host.onError?.("v4.workspaceConfig.publish", error);
    }
  }

  private async pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null> {
    if (!this.host.getWorkspaceConfig) return null;
    return (await this.host.getWorkspaceConfig(workspaceId)) ?? null;
  }

  /** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
  private async ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher> {
    const existing = this.configPublishers.get(workspaceId);
    if (existing) return existing;
    const publisher = new WorkspaceConfigPublisher(
      workspaceId,
      this.createLogEpoch(`workspace-config/${workspaceId}`),
      this.now,
    );
    const seed = await this.pullWorkspaceConfig(workspaceId).catch((error) => {
      this.host.onError?.("v4.workspaceConfig.seed", error);
      return null;
    });
    if (seed) publisher.publish(seed);
    // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
    const raced = this.configPublishers.get(workspaceId);
    if (raced) return raced;
    this.configPublishers.set(workspaceId, publisher);
    return publisher;
  }

  /** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
  private flushConfig(workspaceId: string, onlyConnectionId?: string): void {
    const publisher = this.configPublishers.get(workspaceId);
    if (!publisher) return;
    for (const subscriptionId of publisher.subscriptionIds()) {
      const connectionId = publisher.connectionIdForSubscription(subscriptionId);
      if (
        connectionId === null ||
        this.pausedConnections.has(connectionId) ||
        (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
      ) {
        continue;
      }
      const reservation = publisher.reserveFlush(subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.workspaceConfig.emit", error);
      }
    }
  }

  /** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */
  async subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const dispatch = await this.subscribeReserved(rawParams);
    dispatch.commit();
    return dispatch;
  }

  async subscribeReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      throw new Error(`Unsupported topic: ${params.topic}`);
    }
    if (this.host.isSessionStopping?.(sessionId))
      throw new Error("fault.sessionLifecycle.stopping");
    const isLiveConversation = this.hasLiveConversation(sessionId);
    this.host.onDebug?.(
      `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
    );
    // Hydration：首次订阅时从权威来源重建投影。
    // - 无 publisher（cold）→ 建 + 重放。
    // - 有 publisher 但事件日志覆盖不了 transcript（fork child：resume 的 ingest 抢先
    //   建了个只含 fork 事件的 cold publisher）→ 用 transcript 合成**重建**。
    // - 有 publisher 且事件日志完整（流式 live）→ 保留，重放会双计且打断流。
    const restoreStartedAt = performance.now();
    const existingReady = this.readyFlights.get(sessionId);
    const historyFirst = params.historyFirst === true && Boolean(this.host.loadPersistedMessages);
    const initialState = this.publishers.get(sessionId)?.getSnapshot().runtimeInitialization;
    if (!historyFirst && initialState?.status === "failed") {
      throw new V4SubscribeSessionUnavailableError(
        sessionId,
        "fault.subscribe.resumeFailed",
        initialState.message,
      );
    }
    const publisher =
      historyFirst &&
      (this.historyOpenings.has(sessionId) ||
        initialState?.status === "failed" ||
        (!isLiveConversation && !existingReady))
        ? await this.ensureHistoryReadyPublisher(
            sessionId,
            params.resumeThoughtLevel,
            params.workspace,
            params.additionalDirectories,
            params.retryInitialization,
          )
        : existingReady
          ? await existingReady
          : !isLiveConversation
            ? await this.ensureColdReadyPublisher(
                sessionId,
                params.resumeThoughtLevel,
                params.workspace,
                params.additionalDirectories,
              )
            : await this.hydratePublisher(sessionId);
    const cliSessionRestoreMs = !isLiveConversation
      ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
      : undefined;
    // 旧入口允许 UI 自选 deliveryProfile，桌面调用遗漏时还会默认成
    // replayable。现在只认 host attachment 注入的可信 clientMode。
    const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
    // subscribeReserved 已构建 wire projection；若在它之后才开始计时，大会话的
    // 行过滤/窗口截断会落在 restore 与 encode 两段之外。起点必须覆盖构建与 physical encode。
    const initialFrameEncodeStartedAt = performance.now();
    const result = publisher.subscribeReserved({
      connectionId: params.connectionId,
      base: params.base,
      deliveryProfile: profileName,
      // 与 clientMode 同族的可信注入：能力位来自该连接的 clientHello，缺席一律按旧消费者办
      // （整键 patch + 旧界裁剪）。resync / rehydrate 沿用订阅上已记下的这一位，不再重取。
      workflowRunDeltas: params.workflowRunDeltas === true,
      pluginDiscoveryUi: params.pluginDiscoveryUi === true,
    });
    const routeKey = subscriptionRouteKey(
      params.topic,
      result.ack.subscriptionId,
      params.connectionId,
    );
    let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
    try {
      dispatch = this.subscribeDispatch(result.ack, result.reservation, () => {
        const state = this.flushStates.get(routeKey);
        if (state) this.scheduleFlush(routeKey, state, publisher);
        this.historyOpenings.get(sessionId)?.start();
      });
      dispatch.ack = {
        ...dispatch.ack,
        openTiming: {
          version: 1,
          ...(cliSessionRestoreMs !== undefined
            ? historyFirst
              ? { historyReadyMs: cliSessionRestoreMs }
              : { cliSessionRestoreMs }
            : {}),
          initialFrameEncodeMs: Math.max(
            0,
            Math.round(performance.now() - initialFrameEncodeStartedAt),
          ),
          sessionRuntimeState: isLiveConversation ? "warm" : "cold",
          snapshotRowCount: publisher.getSnapshot().rows.window.length,
        },
      };
    } catch (error) {
      // 重订 initial encode 失败时客户端仍持有旧 subId；replacement 必须
      // 原子 rollback，旧 publisher subscription 与 flush timer 都继续有效。
      result.rollback();
      throw error;
    }
    // encode 成功后 replacement 才 admission；此时再清旧调度状态，失败路径不碰旧 owner。
    for (const [staleRouteKey, staleState] of this.flushStates) {
      if (staleState.sessionId !== sessionId) continue;
      if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
        continue;
      }
      if (staleState.timer) clearTimeout(staleState.timer);
      this.flushStates.delete(staleRouteKey);
    }
    this.flushStates.set(routeKey, {
      sessionId,
      topic: params.topic,
      subscriptionId: result.ack.subscriptionId,
      connectionId: params.connectionId,
      deliveryProfile: profileName,
      flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
      timer: null,
    });
    return dispatch;
  }

  /**
   * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
   * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
   */
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame> {
    const params = v4ConversationResyncParamsSchema.parse(rawParams);
    const request = {
      base: params.base,
      ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
    };
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId !== null) {
      const publisher = this.publishers.get(sessionId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const routeKey = subscriptionRouteKey(
        params.topic,
        params.subscriptionId,
        params.connectionId,
      );
      const flushState = this.flushStates.get(routeKey);
      if (flushState?.timer) {
        clearTimeout(flushState.timer);
        flushState.timer = null;
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(result.ack, result.reservation, () => {
          const state = this.flushStates.get(routeKey);
          if (state) this.scheduleFlush(routeKey, state, publisher);
        });
      } catch (error) {
        // physical encode 在 ACK admission 前失败时，same-sub recovery
        // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
        result.rollback();
        if (flushState) this.scheduleFlush(routeKey, flushState, publisher);
        throw error;
      }
    }

    const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
    if (indexWorkspaceId !== null) {
      const publisher = this.indexPublishers.get(indexWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushIndex(indexWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }

    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      const publisher = this.configPublishers.get(configWorkspaceId);
      if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
        throw new Error("fault.subscription.notOwned");
      }
      const result = publisher.resyncReserved(params.subscriptionId, request);
      if (!result) throw new Error("fault.subscription.notOwned");
      try {
        return this.subscribeDispatch(
          {
            subscriptionId: result.subscriptionId,
            mode: result.mode,
            logEpoch: publisher.logEpoch,
          },
          result.reservation,
          () => this.flushConfig(configWorkspaceId),
        );
      } catch (error) {
        result.rollback();
        throw error;
      }
    }
    throw new Error(`Unsupported topic: ${params.topic}`);
  }

  /**
   * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
   * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
   * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
   */
  async rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    const params = v4ConversationRowsRangeParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    if (
      params.residency === "resident-only" &&
      !existingReady &&
      !this.historyOpenings.has(params.sessionId) &&
      !this.publishers.has(params.sessionId) &&
      !this.hasLiveConversation(params.sessionId)
    ) {
      // 预加载只读热会话：冷会话不恢复（恢复要读库重放、可能续期运行时），由调用方跳过。
      throw new V4SessionNotResidentError(params.sessionId);
    }
    const publisher = this.historyOpenings.has(params.sessionId)
      ? await this.historyOpenings.get(params.sessionId)!.history
      : this.publishers.get(params.sessionId)?.getSnapshot().runtimeInitialization?.status ===
          "failed"
        ? this.publishers.get(params.sessionId)!
        : existingReady
          ? await existingReady
          : !this.hasLiveConversation(params.sessionId)
            ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
            : await this.hydratePublisher(params.sessionId);
    return publisher.getRowsRange(
      {
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      },
      // clientMode 决定行可见性过滤档位：桌面 continuous（默认）/ 断线恢复 replayable。
      params.clientMode === "desktop-continuous" ? "continuous" : "replayable",
    );
  }

  /** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */
  async plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    const params = v4ConversationPlansParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    return publisher.getPlans();
  }

  /**
   * workflow run 事件日志的分页读取（cursor = journal sequence）。
   *
   * 与 rows/range、plans 同族：只读、无状态、超时重发安全。刻意**不是** v4 command——
   * command 的 ACK 结果是那个封闭的「变更结果」判别联合，一页只读事件不属于那个词汇表。
   *
   * 一页的条数与字节两道界在这里定（docs/execution-engine.md「Reading the journal」）：条数取
   * 调用方的 limit，缺省为协议上限；字节恒为协议上限，renderer 不能放宽。`hasMore` 由存储层
   * 判定——页可能因字节提前收尾，「取满 limit」已经不是判据。
   */
  async workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult> {
    const params = v4ConversationWorkflowRunEventsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunEvents) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const page = await this.host.listDynamicWorkflowRunEvents(params.sessionId, {
      runId: params.runId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      limit: params.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
      maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
    });
    return v4ConversationWorkflowRunEventsResultSchema.parse(page);
  }

  /**
   * dwf run 的枚举 query。与
   * workflowRunEvents 同族：只读、无状态、超时重发安全。limit 的缺省与钳制在 CLI 侧
   * （run service），这里只透传；`resumable` 由 CLI 按 resume 门的同一个谓词算好。
   */
  async workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult> {
    const params = v4ConversationWorkflowRunsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRuns) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const runs = await this.host.listDynamicWorkflowRuns(params.sessionId, {
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return v4ConversationWorkflowRunsResultSchema.parse({ runs });
  }

  /**
   * workflow run 的**用户面产物**清单。
   * 与 workflowRunEvents 同族：只读、无状态、超时重发安全。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层
   * 返回值（引擎内部对后者的同名叫法）。
   *
   * 未知 runId 回空清单而不是错误：一个已被淘汰 / 从未存在的 run 没有产物，这是一个
   * 事实而不是故障——同一姿态见事件日志对越界 cursor 的处理。
   */
  async workflowRunArtifacts(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactsResult> {
    const params = v4ConversationWorkflowRunArtifactsParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifacts) {
      throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const artifacts = await this.host.listDynamicWorkflowRunArtifacts(params.sessionId, {
      runId: params.runId,
    });
    return v4ConversationWorkflowRunArtifactsResultSchema.parse({ artifacts: artifacts ?? [] });
  }

  /**
   * 预置看板的取数面：喂给某个产物的 `report` 条目分页。
   *
   * 条数的**缺省与钳制**、以及字节上界都在这里定（存储层精确兑现、绝不自造页大小也绝不再钳）。`fields` 原样下传：看板只要 spec 点名的字段，由 SQLite 取出；`hasMore` 由存储层判定——页可能因字节提前收尾，所以判据绝不能是
   * 「这页正好满」，也不再是网关多取一条。
   */
  async workflowRunArtifactData(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
    const params = v4ConversationWorkflowRunArtifactDataParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunArtifactItems) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunArtifactItems",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const limit = Math.max(
      1,
      Math.min(
        params.limit ?? WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
        WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage,
      ),
    );
    const page = await this.host.listDynamicWorkflowRunArtifactItems(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
      limit,
      maxBytes: WORKFLOW_ARTIFACT_LIMITS.maxPageBytes,
      ...(params.fields === undefined ? {} : { fields: params.fields }),
    });
    return v4ConversationWorkflowRunArtifactDataResultSchema.parse(page);
  }

  /**
   * 内容产物的字节，**逐字照 attachmentRead**：一次一块、≤ 512 KiB（schema 已钉住 limit 的
   * 上界），`nextOffset` 为 null 即读到尾。
   *
   * **授权全在宿主侧**（端口实现）：该 run 必须属于 `sessionId` 这个会话 ∧ journal 里有
   * `(artifactId, version)` 的 completed 行，然后才拿**行上的** uri 去 store 读。网关只做
   * 参数校验与分块——它没有 journal，也不该有第二份授权判据（两处各判一次，同一个 id
   * 迟早会在两层上得到不同的解释）。宿主回 `undefined` = 无此版本 / 不是你的 run /
   * 这是块看板（没有字节），三者对调用方是同一个业务事实，这里归一成结构化的 not found。
   *
   * `offset` 越界不是错误：返回空块 + `nextOffset: null`，与读到尾同一形态。
   */
  async workflowRunArtifactRead(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
    const params = v4ConversationWorkflowRunArtifactReadParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunArtifact) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const artifact = await this.readWorkflowArtifactPayload(params);
    const totalBytes = artifact.bytes.byteLength;
    const start = Math.min(params.offset, totalBytes);
    const end = Math.min(start + params.limit, totalBytes);
    const chunk = artifact.bytes.subarray(start, end);
    return v4ConversationWorkflowRunArtifactReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: artifact.mediaType,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    });
  }

  /**
   * 工作区 transcript 的清单：一个 run 的
   * `files.*` / `git.*` / `world.run` 行，不带正文。
   *
   * 宿主回 `undefined`（未知 run / 不是你的 run）得到空清单而不是错误：与产物清单同一姿态，
   * 也是授权链「不告诉越权者猜对了哪一半」的要求。清单超过 maxNodes 截尾并置 `truncated`——
   * 一个循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
   */
  async workflowRunWorkspace(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
    const params = v4ConversationWorkflowRunWorkspaceParamsSchema.parse(rawParams);
    if (!this.host.listDynamicWorkflowRunWorkspaceNodes) {
      throw new V4CapabilityUnsupportedError(
        "listDynamicWorkflowRunWorkspaceNodes",
        params.sessionId,
      );
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const nodes =
      (await this.host.listDynamicWorkflowRunWorkspaceNodes(params.sessionId, {
        runId: params.runId,
      })) ?? [];
    const truncated = nodes.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes;
    return v4ConversationWorkflowRunWorkspaceResultSchema.parse({
      nodes: truncated ? nodes.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes) : nodes,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化（缺省与上限都是 resultMaxBytes，钳在这里）。
   * 授权全在宿主侧；宿主回 `undefined` = 无此节点 / 不是你的 run / 不是 world 行，归一成
   * 结构化的 not found。
   */
  async workflowRunNodeResult(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunNodeResultResult> {
    const params = v4ConversationWorkflowRunNodeResultParamsSchema.parse(rawParams);
    if (!this.host.readDynamicWorkflowRunNodeResult) {
      throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", params.sessionId);
    }
    await this.ensureHostRecordForJournalRead(params.sessionId, params.workspace);
    const maxBytes = Math.max(
      1,
      Math.min(
        params.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
        WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
      ),
    );
    const result = await this.host.readDynamicWorkflowRunNodeResult(params.sessionId, {
      runId: params.runId,
      siteId: params.siteId,
      ordinal: params.ordinal,
      maxBytes,
    });
    if (result === undefined) {
      throw new Error(
        `fault.workflowRunNodeResult.notFound: ${params.runId}/${params.siteId}@${params.ordinal}`,
      );
    }
    return v4ConversationWorkflowRunNodeResultResultSchema.parse(result);
  }

  /**
   * 一个产物版本的**整份**字节，带缓存。
   *
   * 端口的 `readArtifact` 返回的是整份字节，而
   * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
   * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
   * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
   * 关于两个家族共用一张表的论证）。
   *
   * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
   * 同一次读，而不是各自发起一次再各自写一遍缓存。
   *
   * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
   * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
   * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
   *
   * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
   * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
   * 负缓存钉死 30 秒。
   */
  private readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
    const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    const payload = this.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      version: params.version,
    })
      .then((artifact) => {
        if (artifact === undefined) {
          throw new Error(
            `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
          );
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = artifact.bytes.byteLength;
          this.binaryReadCacheBytes += artifact.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
        // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
        return { bytes: artifact.bytes, mediaType: artifact.contentType };
      })
      .catch((error: unknown) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, {
      sessionId: params.sessionId,
      accessedAt: now,
      bytes: null,
      payload,
    });
    return payload;
  }

  /**
   * dwf 两个 journal 读面的宿主 record 前置。
   *
   * 这两个 query 都经 app 能力读 journal，而宿主按 sessionId 找 record——历史
   * 会话的 record 只由**订阅**路径激活。renderer 里发现查询的 effect 声明在 lease/订阅
   * effect 之前，而 CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop
   * 越队），于是「重启后打开历史会话」时它必然先于订阅被处理、必然拿到 sessionNotFound：
   * 工具卡的 join 回退整块消失，卡片退回编译态，被打断的 run 连入口都没有。
   *
   * 只拉 record，**不**建 READY publisher：journal 与 conversation log 无关，读一页 run
   * 不需要投影（同一判断见这两个 query 刻意不带 atSeq/atLogEpoch）。习语与 attachmentBegin
   * 逐字相同；宿主生命周期 owner 按会话单飞，与并发订阅共享同一次 activation。
   *
   * 活性判定必须与 subscribe 同一条
   * `hasLiveConversation`，不能只看 `sessionExists`。dwf actor transcript 是 detached live
   * 会话——真 runtime 活在 run service 里、宿主刻意没有 record；嵌套 SessionPane 的发现
   * 查询带着 actor id 打到这里，旧判定就对一条**正在运行**的会话物化出第二个（幽灵）
   * runtime：它向同一份事件日志追加 SessionResumed、丢弃 pending steer、重放 resume hooks，
   * 双写把序列账搞乱，transcript 从此定格（症状是直播冻结在「已工作 xx 秒」）。
   */
  private async ensureHostRecordForJournalRead(
    sessionId: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<void> {
    const ready = this.readyFlights.get(sessionId);
    if (ready) await ready;
    if (this.publishers.get(sessionId)?.getSnapshot().runtimeInitialization?.status === "failed")
      throw new Error("fault.subscribe.resumeFailed");
    if (this.hasLiveConversation(sessionId)) return;
    await this.coldResume.ensureResumed(sessionId, undefined, workspace);
  }

  async fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    const params = v4ConversationFileChangesParamsSchema.parse(rawParams);
    if (!this.host.getConversationFileChanges) {
      throw new Error("fault.fileChanges.unsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.hasLiveConversation(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileChanges");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.getConversationFileChanges(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  async backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    const { sessionId, workId } = v4BackgroundBashOutputParamsSchema.parse(rawParams);
    // 观察查询不能 hydrate/恢复冷会话；任务由现有 runtime 授权。
    if (!this.host.readBackgroundBashOutput) return { kind: "unsupported", workId };
    return backgroundBashOutputResultSchema.parse(
      await this.host.readBackgroundBashOutput(sessionId, workId),
    );
  }

  async fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult> {
    const params = v4ConversationFileRewindPreviewParamsSchema.parse(rawParams);
    if (!this.host.previewConversationFileRewind) {
      throw new Error("fault.fileRewindPreview.unsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveQueryRowTarget(publisher, params, "fileRewindPreview");
    const messageIds = resolution.messageIds ?? [];
    const targetTurnId = toRuntimeTurnId(resolution.row.turnId);
    return this.host.previewConversationFileRewind(
      params.sessionId,
      params.target.rowId,
      messageIds,
      targetTurnId,
    );
  }

  private resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
    const snapshot = publisher.getSnapshot();
    if (params.baseLogEpoch !== snapshot.logEpoch) throw new Error("proto.staleLogEpoch");
    if (params.baseRevision !== snapshot.revision) throw new Error("proto.staleRevision");
    const resolution = publisher.resolveRowActionTarget(params.target, action);
    if (!resolution.ok) throw new Error(resolution.reasonCode);
    return resolution;
  }

  /** begin 只 admission metadata，不解码/暂存 full payload。 */
  async attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult> {
    const params = v4AttachmentBeginParamsSchema.parse(rawParams);
    if (!this.host.putSessionAttachment) {
      throw new Error("fault.attachment.putUnsupported");
    }
    if (!this.host.sessionExists(params.sessionId)) {
      await this.coldResume.ensureResumed(params.sessionId, undefined, params.workspace);
    }
    return this.attachmentUploads.begin(params);
  }

  async attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult> {
    return this.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
  }

  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult> {
    return this.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
  }

  async attachmentAbort(rawParams: unknown): Promise<void> {
    await this.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
  }

  async attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult> {
    const params = v4AttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new Error("fault.attachment.readUnsupported");
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      // renderer 传来的 ref 不能直接成为文件路径；必须先由当前 session
      // 的权威 user row 证明归属，避免跨 session 或任意路径读取。
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }

    const payload = await this.readAttachmentPayload(
      params.sessionId,
      params.ref,
      resolution.attachment.mime,
      resolution.messageId,
      resolution.attachmentIndex,
    );
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return {
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    };
  }

  async conversationAttachmentRead(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentReadResult> {
    const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
    if (!this.host.readSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let payload: { bytes: Uint8Array; mediaType: string };
    try {
      payload = await this.readAttachmentPayload(
        params.sessionId,
        params.ref,
        attachment.mime,
        messageId,
        params.attachmentIndex,
        true,
      );
    } catch (error) {
      throw toShareStatFault(error);
    }
    if (params.offset > payload.bytes.byteLength) {
      throw new Error("fault.attachment.previewRangeInvalid");
    }
    const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
    const chunk = payload.bytes.subarray(params.offset, end);
    return v4ConversationAttachmentReadResultSchema.parse({
      dataBase64: Buffer.from(chunk).toString("base64"),
      mediaType: payload.mediaType,
      totalBytes: payload.bytes.byteLength,
      nextOffset: end < payload.bytes.byteLength ? end : null,
    });
  }

  async conversationAttachmentStat(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentStatResult> {
    const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
    if (!this.host.statSessionAttachment) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
    }
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) =>
          candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
      );
    if (row?.kind !== "userInput") {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const attachment = row.attachments?.[params.attachmentIndex];
    if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
    }
    const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
    let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
    try {
      result = await this.host.statSessionAttachment(params.sessionId, {
        ref: params.ref,
        mime: attachment.mime,
        ...(messageId ? { messageId } : {}),
        attachmentIndex: params.attachmentIndex,
      });
    } catch (error) {
      // 「附件确实不在了」是 share 预检唯一能确定判定为跳过的分类，必须以稳定码上抛；
      // 否则 service 只能猜错误文本。
      throw toShareStatFault(error);
    }
    // stat 结果曾被 30MiB 的 schema 上限卡住，超大附件在这里抛 ZodError，
    // 于是 share 预检把「已知容量超限」这个确定阻断降级成 deferred 并静默丢内容。
    // 上限放宽后仍需要一个显式出口：真的超过协议可表达范围时给出稳定码。
    if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
      throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
    }
    return v4ConversationAttachmentStatResultSchema.parse(result);
  }

  async attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult> {
    const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
    const existingReady = this.readyFlights.get(params.sessionId);
    const publisher = existingReady
      ? await existingReady
      : !this.host.sessionExists(params.sessionId)
        ? await this.ensureColdReadyPublisher(params.sessionId, undefined, params.workspace)
        : await this.hydratePublisher(params.sessionId);
    const resolution = this.resolveReadableMediaAttachment(
      publisher,
      params.sessionId,
      params.ref,
      params.target,
      params.attachmentIndex,
    );
    if (!resolution) {
      throw new Error("fault.attachment.previewRefNotAuthorized");
    }
    if (
      params.clientMode !== "desktop-continuous" ||
      !resolution.attachment.mime.startsWith("video/") ||
      !this.host.resolveSessionAttachmentPreviewSource
    ) {
      return { kind: "chunked" };
    }
    const result = await this.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
      ref: params.ref,
      mime: resolution.attachment.mime,
      ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
      ...(resolution.attachmentIndex !== undefined
        ? { attachmentIndex: resolution.attachmentIndex }
        : {}),
    });
    return v4AttachmentPreviewSourceResultSchema.parse(result);
  }

  private resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
    const isPreviewable = (attachment: AttachmentRef) => {
      const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      // 根因：原预览仅放行图片、视频和 PDF，文本附件即使归属当前行也被拒绝。
      // 文本只开放既有材料标记，后续仍须通过权威行、附件索引和 ref 的归属校验。
      return (
        mime.startsWith("image/") ||
        mime.startsWith("video/") ||
        mime === "application/pdf" ||
        (mime === "text/plain" &&
          (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text"))
      );
    };
    const matchesRef = (attachment: AttachmentRef) =>
      attachment.ref === ref || attachment.previewRef === ref;
    if (target && attachmentIndex !== undefined) {
      const row = publisher
        .getSnapshot()
        .rows.window.find(
          (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
        );
      if (row?.kind !== "userInput") return null;
      const attachment = row.attachments?.[attachmentIndex];
      if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
        return null;
      }
      // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
      // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
      const messageId = publisher.getMessageIdForRow(row.rowId);
      return {
        attachment,
        attachmentIndex,
        ...(messageId ? { messageId } : {}),
      };
    }

    // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
    // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
    for (const row of publisher.getSnapshot().rows.window) {
      if (row.kind === "userInput") {
        for (const attachment of row.attachments ?? []) {
          if (!isPreviewable(attachment)) continue;
          if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
        }
      }
      if (
        row.kind === "assistantText" &&
        artifactRefBelongsToSession(ref, sessionId) &&
        extractMarkdownArtifactImageRefs(row.text).includes(ref)
      ) {
        // assistant Markdown 可以引用工具产出的 session artifact，
        // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
        // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
        // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
        // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
        // 读取另一个 session 的 artifact。
        return {
          attachment: {
            ref,
            fileName: "assistant-image",
            mime: "image/*",
            bytes: 0,
          },
        };
      }
    }
    return null;
  }

  /**
   * 读取附件全部字节（带 TTL/容量缓存）。
   *
   * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
   * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
   * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
   * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
   */
  private readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric = false,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const now = this.now();
    this.pruneBinaryReadCache(now);
    // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
    // 只能靠一个不可能相等的首段隔离。
    const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
    const cached = this.binaryReadCache.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
    // image 和上传事务继续保持原边界。
    const maxBytes = allowGeneric
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : mime.startsWith("video/")
        ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
        : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
    const payload = this.host.readSessionAttachment!(sessionId, {
      ref,
      mime,
      maxBytes,
      ...(messageId ? { messageId } : {}),
      ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
    })
      .then((result) => {
        const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          !allowGeneric &&
          !resultMime.startsWith("image/") &&
          !resultMime.startsWith("video/") &&
          resultMime !== "application/pdf" &&
          !(
            resultMime === "text/plain" &&
            mime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
          )
        ) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
        }
        if (result.bytes.byteLength > maxBytes) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
        }
        const current = this.binaryReadCache.get(key);
        if (current) {
          current.bytes = result.bytes.byteLength;
          this.binaryReadCacheBytes += result.bytes.byteLength;
          this.pruneBinaryReadCache(this.now());
        }
        return result;
      })
      .catch((error) => {
        this.deleteBinaryReadCacheEntry(key);
        throw error;
      });
    this.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
    return payload;
  }

  private pruneBinaryReadCache(now = this.now()): void {
    for (const [key, entry] of this.binaryReadCache) {
      if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
        this.deleteBinaryReadCacheEntry(key);
      }
    }
    if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
    const oldest = [...this.binaryReadCache.entries()]
      .filter(([, entry]) => entry.bytes !== null)
      .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key] of oldest) {
      this.deleteBinaryReadCacheEntry(key);
      if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
    }
  }

  private deleteBinaryReadCacheEntry(key: string): void {
    const entry = this.binaryReadCache.get(key);
    if (!entry) return;
    this.binaryReadCache.delete(key);
    this.binaryReadCacheBytes = Math.max(0, this.binaryReadCacheBytes - (entry.bytes ?? 0));
  }

  /** v4/conversation/unsubscribe。 */
  unsubscribe(rawParams: unknown): void {
    const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
    const sessionId = parseConversationTopic(params.topic);
    if (sessionId === null) {
      const workspaceId = parseSessionsIndexTopic(params.topic);
      if (workspaceId !== null) {
        this.indexPublishers
          .get(workspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
        return;
      }
      const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
      if (configWorkspaceId !== null) {
        this.configPublishers
          .get(configWorkspaceId)
          ?.unsubscribe(params.subscriptionId, params.connectionId);
      }
      return;
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const state = this.flushStates.get(routeKey);
    if (!state) return;
    if (state?.timer) clearTimeout(state.timer);
    this.flushStates.delete(routeKey);
    // 裸 subscriptionId 在不同 topic/connection 可碰撞；旧网关先按 subId
    // 反查再对三类 publisher 广撒网，会删掉别的连接。topic + connection 必须同时命中。
    this.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
  }

  /**
   * v4/command：inbox 六态裁决；accepted 时执行副作用并把终态随响应返回。
   *
   * 这里曾经"立即回初始 ACK、后台 settle"，
   * 导致 createSession/forkAssistant 的调用方拿不到 result.sessionId（settle 只回填
   * 幂等表，只有同 commandId 重试才能读到）——违反
   * 「accepted 即时带 result」。命令副作用本身是快返回的（sendPrompt 后台起 turn），
   * await 不会把 RPC 挂到整个 turn 结束，所以同步等待终态。
   * settle 仍然固化结果供 duplicate 重放。
   */
  async handleCommand(rawParams: unknown): Promise<CommandAck> {
    let ttftCapacityRejected = false;
    const ttftCommand =
      typeof rawParams === "object" && rawParams !== null && "ttft" in rawParams
        ? parseCommandEnvelope(rawParams)
        : undefined;
    if (ttftCommand?.ok && ttftCommand.envelope.ttft) {
      const sessionId = ttftCommand.envelope.sessionId;
      const control = sessionId ? this.publishers.get(sessionId)?.getSnapshot().control : undefined;
      ttftCapacityRejected = !this.localTtft.receive(
        ttftCommand.envelope,
        control?.canStop === true,
      );
    }
    // READY 只存在于冷恢复窗口；正常命令直接进入 inbox，避免重复解析信封。
    if (this.readyFlights.size > 0) {
      const parsed = parseCommandEnvelope(rawParams);
      const sessionId = parsed.ok ? parsed.envelope.sessionId : null;
      const ready = sessionId === null ? undefined : this.readyFlights.get(sessionId);
      if (ready && sessionId !== null && !this.historyOpenings.has(sessionId)) await ready;
    }

    const outcome = await this.inbox.handle(rawParams);
    if (outcome.kind === "ack")
      return {
        ...outcome.ack,
        ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
      };
    this.localTtft.admitted(outcome.envelope.commandId);
    let durableInputIntent: ConversationInputIntent | null = null;
    let settledAck: CommandAck | null = null;
    type CommandFinal = Parameters<typeof outcome.settle>[0];
    const reportError = (scope: string, error: unknown): void => {
      try {
        this.host.onError?.(scope, error);
      } catch {
        // 错误观察器不能反向破坏 command final 与 session FIFO 的收口。
      }
    };
    const settleOnce = (final: CommandFinal): CommandAck => {
      if (settledAck) return settledAck;
      const ack = {
        ...outcome.ack,
        ...final,
        ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
      };
      outcome.settle(final);
      settledAck = ack;
      return ack;
    };
    const cancelDurableInput = async (reason: string): Promise<void> => {
      if (!durableInputIntent) return;
      try {
        await this.host.cancelCommandInput?.(outcome.envelope, outcome.queueItemId, reason);
      } catch (cancelError) {
        // 原命令 ACK 必须保留真实执行结果；ledger cancel 失败单独告警，不能覆盖原错误。
        reportError("v4.command.input.cancel", cancelError);
      }
    };
    const releaseDurableInput = (
      final: Pick<CommandAck, "status" | "reasonCode" | "message" | "result">,
    ) => {
      if (!durableInputIntent || outcome.envelope.sessionId === null) return;
      try {
        this.inbox.releaseLiveInput(
          {
            sessionId: outcome.envelope.sessionId,
            commandId: durableInputIntent.sourceCommandId,
          },
          { ...outcome.ack, ...final },
        );
      } catch (releaseError) {
        reportError("v4.command.input.release", releaseError);
      }
    };
    try {
      const admission = {
        admissionSeq: outcome.admissionSeq,
        admittedAt: outcome.admittedAt,
        queueItemId: outcome.queueItemId,
      };
      const admissionPublisher =
        outcome.envelope.type === "createSession"
          ? new ConversationTopicPublisher(`pending-${outcome.envelope.commandId}`, "admission", {
              now: this.now,
            })
          : outcome.envelope.sessionId === null
            ? null
            : this.ensurePublisher(outcome.envelope.sessionId);
      const admissionProjectionBytes = admissionPublisher?.measureInputAdmissionProjectionBytes(
        outcome.envelope,
        admission,
      );
      if (
        admissionProjectionBytes !== null &&
        admissionProjectionBytes !== undefined &&
        admissionProjectionBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      ) {
        return settleOnce({
          status: "failed",
          reasonCode: "proto.payloadTooLarge",
          message: `conversation projection would exceed ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
        });
      }
      durableInputIntent =
        (await this.host.admitCommandInput?.(outcome.envelope, admission)) ?? null;
      if (durableInputIntent && outcome.envelope.sessionId !== null) {
        this.inbox.pinLiveInput(outcome.envelope.sessionId, durableInputIntent);
      }
      const result = await this.host.executeCommand(outcome.envelope, admission);
      // Bug 根因：首输入标题先于 deferred 提升发出，列表会过滤它；ACK 后若初始化/Hook
      // 尚未结束便没有下一事件。沿用成功执行边界补发当前摘要，不等待 TurnStarted。
      const admittedSessionId =
        result?.type === "createSession" ? result.sessionId : outcome.envelope.sessionId;
      if (admittedSessionId) this.publishCurrentSummaryToIndex(admittedSessionId);
      // 新建/侧聊命令采用结果会话的开关，避免把父会话或当前 App 设置误记到新会话。
      const telemetrySessionId =
        result?.type === "createSession" || result?.type === "createSelectionSideSession"
          ? result.sessionId
          : outcome.envelope.sessionId;
      const memoryEnabled = telemetrySessionId
        ? this.host.getSessionMemoryEnabled?.(telemetrySessionId)
        : undefined;
      const final = {
        status: "accepted" as const,
        ...(result ? { result } : {}),
        ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
      };
      return settleOnce(final);
    } catch (error) {
      // noop 不是失败（同值切换收口）：不进 onError，noop ACK 返回。
      if (error instanceof V4CommandNoopError) {
        await cancelDurableInput(error.reasonCode);
        const final = {
          status: "noop" as const,
          reasonCode: error.reasonCode,
        };
        releaseDurableInput(final);
        return settleOnce(final);
      }
      reportError("v4.command.execute", error);
      // 携带 reasonCode 的领域错误（V4PromptRejectedError / heldQueueDispositionRequired 等）
      // 原样上行，客户端才能按 guard 错误码分流；否则归一 executionFailed。
      const domainReasonCode =
        typeof (error as { reasonCode?: unknown } | null)?.reasonCode === "string"
          ? String((error as { reasonCode: string }).reasonCode)
          : null;
      const final = {
        status: "failed" as const,
        reasonCode:
          error instanceof V4CommandNotImplementedError
            ? "fault.command.notImplemented"
            : (domainReasonCode ?? "fault.command.executionFailed"),
        message: error instanceof Error ? error.message : String(error),
      };
      await cancelDurableInput(final.reasonCode);
      releaseDurableInput(final);
      return settleOnce(final);
    } finally {
      if (!settledAck) {
        // publisher/measure/admission 任一同步异常过去会跳过 settle，
        // 导致相同 command 永久等待、同 session FIFO 也无法继续 admission。
        const final = {
          status: "failed" as const,
          reasonCode: "fault.command.executionFailed",
          message: "command admission terminated before a durable final was recorded",
        };
        releaseDurableInput(final);
        settleOnce(final);
      }
    }
  }

  /** v4/commands/query：同 key 与 handleCommand 共用 CommandInbox gate。 */
  async queryCommands(rawParams: unknown): Promise<CommandsQueryResult> {
    const receivedAt = localTtftNow();
    const params = commandsQueryParamsSchema.parse(rawParams);
    // 校准是纯时钟探测，不能触发命令账本查询、恢复或 admission gate。
    if (params.clock)
      return {
        results: params.commands.map((key) => ({ key, result: "unknown" as const })),
        clock: { instanceId: this.localTtft.instanceId, receivedAt, sentAt: localTtftNow() },
      };
    await Promise.all(
      params.commands.map((key) => {
        const ready = key.sessionId === null ? undefined : this.readyFlights.get(key.sessionId);
        return ready;
      }),
    );
    const results = await this.inbox.query(params.commands);
    return commandsQueryResultSchema.parse({
      results: results.map((item) => {
        const turn = this.commandTurn(item.key);
        return turn ? { ...item, turn } : item;
      }),
    });
  }

  /**
   * 修复原因：Host 只能在快照尾窗（60 行）里按 sourceCommandId 找 turnHeader，长回合的 header
   * 滚出窗口后 wait 拿到 unknown、审批匹配不到回合。投影内部快照保留全量行，由 owner 直接回答。
   * 取第一个匹配的 header，与客户端在尾窗中的匹配规则一致。
   */
  private commandTurn(key: { sessionId: string | null; commandId: string }) {
    if (key.sessionId === null) return undefined;
    const header = this.publishers
      .get(key.sessionId)
      ?.getSnapshot()
      .rows.window.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === key.commandId,
      );
    return header?.kind === "turnHeader"
      ? { turnId: header.turnId, state: header.state }
      : undefined;
  }

  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
    return item ?? null;
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.kind === kind),
    );
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
    );
  }

  getQueueLength(sessionId: string): number {
    return this.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
  }

  /** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */
  hasResidencyBlockingCommands(sessionId: string): boolean {
    return this.getQueueLength(sessionId) > 0 || this.inbox.hasPinnedSessionState(sessionId);
  }

  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    editLocked: boolean;
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items[0];
    if (!snapshot || !item) return null;
    return {
      autoDrain: snapshot.queue.autoDrain,
      dispatchState: item.dispatch.state,
      editLocked: item.editLock !== undefined,
      kind: item.kind,
      queueItemId: item.queueItemId,
      text: item.text,
    };
  }

  /**
   * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
   * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
   */
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
    return this.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
  }

  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null {
    return this.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
  }

  /**
   * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
   * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
   */
  getMessageIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return this.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
  }

  /** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[] {
    return this.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
  }

  /** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return this.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
  }

  /** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  getTurnIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
  }

  /**
   * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
   * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
   */
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
  }

  /** 关闭只释放运行态；只有 CLI 已持久化软删除时才向列表发 session.removed。
   * 修复原因：Host 将 removed 视为删除事实，普通 tab 关闭不能删除持久化会话。 */
  disposeSession(sessionId: string, options: { deleted?: boolean } = {}): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: false,
      notifyIndexRemoved: options.deleted === true,
    });
  }

  /** 释放之前等待旧 hydration 真正退出；取消 ready Promise 不等于异步重建已经停止。 */
  async releaseSessionProjection(sessionId: string): Promise<void> {
    const opening = this.historyOpenings.get(sessionId);
    const hydration = this.hydrationInFlight.get(sessionId);
    this.disposeSession(sessionId);
    await Promise.allSettled([opening?.history, opening?.finished, hydration]);
    this.disposeSession(sessionId);
  }

  /** 旧 runner 的 finally 可能发布过终态；释放屏障后再次清理，不能留给新实例继承。 */
  async finishSessionRelease(sessionId: string): Promise<void> {
    await this.inbox.resetReleasedSession(sessionId);
    this.disposeSession(sessionId);
  }

  /**
   * 彻底删除（项目数据删除）后从全部 sessions-index 投影中移除该会话。会话未加载时没有
   * 注册表记录可查 workspace，所以遍历所有投影；会话 ID 全局唯一，不会误删别的会话。
   * 不移除会让已存在的投影在下次快照里带回该会话，Host 会把它当作新发现的会话重新登记。
   */
  forgetIndexedSession(sessionId: string): void {
    for (const workspaceId of this.indexPublishers.keys()) {
      if (this.indexPublishers.get(workspaceId)?.removeSession(sessionId))
        this.flushIndex(workspaceId);
    }
  }

  /**
   * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
   * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
   * 保留，再次订阅经冷恢复透明重建。
   */
  deactivateSession(sessionId: string): void {
    this.cleanupSessionRuntime(sessionId, {
      clearCommandInbox: true,
      notifyIndexRemoved: false,
    });
  }

  /**
   * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
   * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
   */
  assertSessionRuntimeDeactivatable(sessionId: string): void {
    if (!this.inbox.hasPinnedSessionState(sessionId)) return;
    throw new Error(`Session command inbox is still pinned: ${sessionId}`);
  }

  /** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
  hasConversationSubscribers(sessionId: string): boolean {
    return this.publishers.get(sessionId)?.hasSubscribers() ?? false;
  }

  /**
   * 内存诊断计数器。只读 size，不触碰状态。
   * detachedLive 用于观察子 session publisher 是否随父 session 释放。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      publishers: this.publishers.size,
      detachedLive: this.detachedLiveSessions.size,
      detachedTerminal: this.detachedTerminalAt.size,
      rawSeqStates: this.rawSequenceStates.size,
      hydrations: this.hydrationInFlight.size,
      historyOpenings: this.historyOpenings.size,
      binaryCacheEntries: this.binaryReadCache.size,
      binaryCacheBytes: this.binaryReadCacheBytes,
    };
  }

  private cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void {
    if (options.clearCommandInbox) {
      // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
      // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
      this.assertSessionRuntimeDeactivatable(sessionId);
    }
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.disposed",
        `conversation session disposed while waiting for projection event commit: ${sessionId}`,
      ),
    );
    this.attachmentUploads.clearSession(sessionId);
    for (const [key, entry] of this.binaryReadCache) {
      if (entry.sessionId === sessionId) this.deleteBinaryReadCacheEntry(key);
    }
    if (options.notifyIndexRemoved) {
      // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
      try {
        const workspaceId = this.host.getSessionWorkspaceId?.(sessionId) ?? null;
        if (workspaceId !== null) {
          const indexPublisher = this.indexPublishers.get(workspaceId);
          // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
          // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
          if (indexPublisher?.removeSession(sessionId)) {
            this.flushIndex(workspaceId);
          }
        }
      } catch (error) {
        this.host.onError?.("v4.sessionsIndex.remove", error);
      }
    }
    this.indexFanoutThrottle.clearSession(sessionId);
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (state.timer) clearTimeout(state.timer);
      this.flushStates.delete(routeKey);
    }
    this.publishers.delete(sessionId);
    this.hydratedSessions.delete(sessionId);
    const hydrationBuffer = this.hydrationBuffers.get(sessionId);
    if (hydrationBuffer) hydrationBuffer.cancelled = true;
    this.hydrationBuffers.delete(sessionId);
    this.hydrationInFlight.delete(sessionId);
    this.readyFlights.delete(sessionId);
    this.historyOpenings.get(sessionId)?.cancel();
    this.rawSequenceStates.delete(sessionId);
    if (options.clearCommandInbox) this.inbox.clearSession(sessionId);
    this.telemetryNormalizer.clearSession(sessionId);
    this.detachedLiveSessions.delete(sessionId);
    this.projectionFaultedSessions.delete(sessionId);
    // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
    this.detachedTerminalAt.delete(sessionId);
    const parentId = this.detachedChildParent.get(sessionId);
    if (parentId !== undefined) {
      this.detachedChildParent.delete(sessionId);
      const siblings = this.detachedChildrenByParent.get(parentId);
      siblings?.delete(sessionId);
      if (siblings && siblings.size === 0) this.detachedChildrenByParent.delete(parentId);
    }
    const children = this.detachedChildrenByParent.get(sessionId);
    if (children) {
      this.detachedChildrenByParent.delete(sessionId);
      for (const childId of children) {
        this.detachedChildParent.delete(childId);
        if (this.host.sessionExists(childId)) continue;
        this.releaseDetachedChild(childId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.localTtft.clear();
    for (const sessionId of this.projectionEventCommitWaiters.keys()) {
      this.rejectProjectionEventWaiters(
        sessionId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.gatewayDisposed",
          "conversation gateway disposed while waiting for projection event commit",
        ),
      );
    }
    clearInterval(this.attachmentPruneTimer);
    this.indexFanoutThrottle.clear();
    this.attachmentUploads.clear();
    this.binaryReadCache.clear();
    this.binaryReadCacheBytes = 0;
    for (const state of this.flushStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.flushStates.clear();
    this.publishers.clear();
    this.hydratedSessions.clear();
    for (const buffer of this.hydrationBuffers.values()) buffer.cancelled = true;
    this.hydrationBuffers.clear();
    this.hydrationInFlight.clear();
    this.readyFlights.clear();
    for (const opening of this.historyOpenings.values()) opening.cancel();
    this.historyOpenings.clear();
    this.rawSequenceStates.clear();
    this.telemetryEventIds.clear();
    this.detachedLiveSessions.clear();
    this.detachedChildParent.clear();
    this.detachedChildrenByParent.clear();
    this.detachedTerminalAt.clear();
    this.projectionFaultedSessions.clear();
    this.indexPublishers.dispose();
    this.configPublishers.clear();
    this.pausedConnections.clear();
  }

  /** 测试探针：立即排空某订阅（绕过定时器）。 */
  flushNow(subscriptionId: string): ConversationTopicFrame | null {
    const match = [...this.flushStates.entries()].find(
      ([, state]) => state.subscriptionId === subscriptionId,
    );
    const state = match?.[1];
    if (!state) return null;
    if (this.pausedConnections.has(state.connectionId)) return null;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const publisher = this.publishers.get(state.sessionId);
    if (!publisher) return null;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private ensurePublisher(sessionId: string): ConversationTopicPublisher {
    let publisher = this.publishers.get(sessionId);
    if (!publisher) {
      publisher = new ConversationTopicPublisher(sessionId, this.createLogEpoch(sessionId), {
        now: this.now,
      });
      this.publishers.set(sessionId, publisher);
      // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
      this.seedPublisherConfig(sessionId, publisher);
    }
    return publisher;
  }

  /**
   * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
   * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
   * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
   * 事件接线期间），hydration 处补一次兜住该窗口。
   */
  private seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void {
    const getSeed = this.host.getSessionConfigSeed;
    if (!getSeed) return;
    try {
      const seed = getSeed.call(this.host, sessionId);
      if (seed) publisher.seedConfig(seed);
    } catch (error) {
      this.host.onError?.("v4.configSeed", error);
    }
  }

  /**
   * 生命周期 owner 只复用历史结果，直接执行实例激活；不能等待投影的激活回调。
   * 旧实现复用 opening 时丢弃新回调，ensureReady 因而永远等不到 activated。
   */
  async prepareSessionHistory(
    sessionId: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<MessageWithParts[]> {
    const history = this.ensureHistoryReadyPublisher(
      sessionId,
      undefined,
      workspace,
      undefined,
      this.publishers.get(sessionId)?.getSnapshot().runtimeInitialization?.attemptId,
    );
    const opening = this.historyOpenings.get(sessionId)!;
    await history;
    // start 只观察同一生命周期结果，不由调用方等待；无订阅者也会完成投影。
    opening.start();
    // 让已登记订阅的历史首帧先进入 outbox，随后 owner 才执行可能同步扫描插件的激活。
    await new Promise<void>((resolve) => setImmediate(resolve));
    return opening.messages;
  }

  /** 首帧先落 transport queue，再启动会同步扫描插件的 runtime；重连不重跑失败 hook。 */
  private ensureHistoryReadyPublisher(
    sessionId: string,
    thought?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    retryAttempt?: string,
  ): Promise<ConversationTopicPublisher> {
    const existing = this.historyOpenings.get(sessionId);
    if (existing) return existing.history;
    const publisher = this.publishers.get(sessionId);
    const failed = publisher?.getSnapshot().runtimeInitialization;
    if (failed?.status === "failed" && failed.attemptId !== retryAttempt)
      return Promise.resolve(publisher!);
    // 失败 app 已回收，旧 raw tail 不属于下一次 runtime 的事件水位。
    if (failed?.status === "failed") this.rawSequenceStates.delete(sessionId);
    const attemptId = randomUUID();
    const initializationStartedAt = performance.now();
    let resolveReady!: (publisher: ConversationTopicPublisher) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<ConversationTopicPublisher>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // 没有旧客户端等待时失败也由状态条消费，避免无人 await 的 rejection。
    void ready.catch(() => undefined);
    this.readyFlights.set(sessionId, ready);
    let messages: MessageWithParts[] | undefined;
    let started = false;
    const clear = () => {
      messages = undefined;
      if (this.readyFlights.get(sessionId) === ready) this.readyFlights.delete(sessionId);
      if (this.historyOpenings.get(sessionId) === opening) this.historyOpenings.delete(sessionId);
    };
    const finished = Promise.withResolvers<void>();
    const persistedMessages = Promise.resolve().then(() =>
      this.host.loadPersistedMessages!(sessionId),
    );
    const opening = {
      messages: persistedMessages,
      finished: finished.promise,
      cancel: () => {
        if (!started) finished.resolve();
        rejectReady(new Error("cold opening disposed"));
        clear();
      },
      history: persistedMessages
        .then(async (loadedMessages) => {
          messages = loadedMessages;
          if (this.disposed || this.historyOpenings.get(sessionId) !== opening)
            throw new Error("cold opening disposed");
          const result = await this.hydratePublisher(sessionId, messages, true);
          this.setInitialization(sessionId, result, { status: "initializing", attemptId });
          return result;
        })
        .catch((error: unknown) => {
          rejectReady(error);
          clear();
          throw error;
        }),
      start: () => {
        if (started) return;
        started = true;
        // post-response commit 已确认首帧入队；下一轮让 stdio I/O 有机会交付，不用定时猜测 UI。
        setImmediate(() => {
          let releaseRuntime: (() => void) | undefined;
          void (async () => {
            if (this.disposed || this.historyOpenings.get(sessionId) !== opening)
              throw new Error("cold opening disposed");
            releaseRuntime = await this.host.retainSessionRuntime?.(sessionId);
            if (this.disposed || this.historyOpenings.get(sessionId) !== opening)
              throw new Error("cold opening disposed");
            const restored = await this.coldResume.ensureResumed(
              sessionId,
              thought,
              workspace,
              additionalDirectories,
              messages,
            );
            if (this.disposed || this.historyOpenings.get(sessionId) !== opening)
              throw new Error("cold opening disposed");
            const result = await this.hydratePublisher(sessionId, restored ?? messages, true);
            this.setInitialization(sessionId, result, { status: "ready", attemptId });
            this.host.onDebug?.(
              `v4 runtime ready session=${sessionId} attempt=${attemptId} runtimeReadyMs=${Math.round(performance.now() - initializationStartedAt)}`,
            );
            resolveReady(result);
          })()
            .catch(async (error: unknown) => {
              // 实例失败由生命周期 owner 清理；纯投影失败不能拆掉已 ready 的执行环境。
              if (!this.disposed && this.historyOpenings.get(sessionId) === opening) {
                const result = this.publishers.get(sessionId);
                if (result)
                  this.setInitialization(sessionId, result, {
                    status: "failed",
                    attemptId,
                    reasonCode: "fault.subscribe.resumeFailed",
                    message: error instanceof Error ? error.message : String(error),
                  });
                this.host.onError?.("v4.initialize", error, { sessionId, attemptId });
              }
              rejectReady(error);
            })
            .finally(() => {
              releaseRuntime?.();
              clear();
              finished.resolve();
            });
        });
      },
    };
    this.historyOpenings.set(sessionId, opening);
    return opening.history;
  }

  private setInitialization(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  ): void {
    publisher.setRuntimeInitialization(state);
    const sequence = this.rawSequenceStates.get(sessionId);
    if (sequence) {
      sequence.lastTransportSeq = publisher.getSnapshot().seq;
      sequence.offset = sequence.lastTransportSeq - sequence.sourceEventSeq;
    }
    for (const connectionId of new Set(
      [...this.flushStates.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.connectionId),
    )) {
      if (!this.pausedConnections.has(connectionId)) this.flushConnection(connectionId);
    }
  }

  /**
   * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
   * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
   */
  private ensureColdReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
  ): Promise<ConversationTopicPublisher> {
    const existingFlight = this.readyFlights.get(sessionId);
    if (existingFlight) return existingFlight;
    // 先登记同一个 READY，再开始所有耗时工作。
    const operation = Promise.resolve().then(async () => {
      const persistedMessages = await this.coldResume.ensureResumed(
        sessionId,
        resumeThoughtLevel,
        workspace,
        additionalDirectories,
      );
      return this.hydratePublisher(sessionId, persistedMessages);
    });
    this.readyFlights.set(sessionId, operation);
    // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
    const clear = () => {
      if (this.readyFlights.get(sessionId) === operation) this.readyFlights.delete(sessionId);
    };
    void operation.then(clear, clear);
    return operation;
  }

  /**
   * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
   * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
   */
  private hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existing = this.publishers.get(sessionId);
    // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
    if (!forceRebuild && existing && this.hydratedSessions.has(sessionId))
      return Promise.resolve(existing);

    const inFlight = this.hydrationInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const buffer: HydrationBuffer = {
      cancelled: false,
      eventIds: new Set<string>(),
      rawEvents: [],
    };
    this.hydrationBuffers.set(sessionId, buffer);
    const hydration = this.performHydration(
      sessionId,
      buffer,
      persistedMessages,
      forceRebuild,
    ).finally(() => {
      if (this.hydrationBuffers.get(sessionId) === buffer) {
        this.hydrationBuffers.delete(sessionId);
      }
      if (this.hydrationInFlight.get(sessionId) === hydration) {
        this.hydrationInFlight.delete(sessionId);
      }
    });
    this.hydrationInFlight.set(sessionId, hydration);
    return hydration;
  }

  private async performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    const existingAtStart = this.publishers.get(sessionId);
    const liveSessionAtStart = this.host.sessionExists(sessionId);
    const hydrationStartedAt = performance.now();
    this.host.onDebug?.(
      `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
        `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
        `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
    );
    const loaded: PersistedEventsLoadResult = this.host.loadPersistedEvents
      ? await this.host.loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
          this.host.onError?.("v4.hydrate", error, {
            durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
            existingPublisherAtStart: existingAtStart !== undefined,
            liveSessionAtStart,
            phase: "loadPersistedEvents",
            persistedMessages: persistedMessages?.length ?? 0,
            sessionId,
          });
          if (this.historyOpenings.has(sessionId)) throw error;
          return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
        })
      : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };

    this.host.onDebug?.(
      `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
        `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
        `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
    );

    if (this.disposed || buffer.cancelled) {
      throw new Error(`v4 hydration cancelled for session ${sessionId}`);
    }

    // assistant 守恒：拒收过正文流的 publisher 不可信——它建立于
    // TurnStarted 之后，缺段无法用 append-only 重放补进中间位置，只能整体重建。
    const latestPublisher = this.publishers.get(sessionId);
    const existingDroppedContent =
      latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
    // 事件日志完整（synthesized=false）且已有健康 live publisher（流式）→ 保留，不重放。
    if (
      existingAtStart &&
      latestPublisher === existingAtStart &&
      !loaded.synthesized &&
      !forceRebuild &&
      !existingDroppedContent
    ) {
      // 创建时种子可能落空（record 尚未入册），首次订阅补一次（幂等、事件优先）。
      this.hydrationBuffers.delete(sessionId);
      this.seedPublisherConfig(sessionId, latestPublisher);
      if (loaded.sharedContextImport) {
        latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
      }
      await this.seedPublisherUsage(
        sessionId,
        latestPublisher,
        persistedMessages,
        loaded.usageSeed,
      );
      this.hydratedSessions.add(sessionId);
      this.publishCurrentSummaryToIndex(sessionId);
      return latestPublisher;
    }

    // 只记住 await 之前的 existing 引用是不够的：load 等待期间 raw event
    // 会继续推进这个 publisher，synthesized 返回后却把它整体删除，queue/stream 随之
    // 消失。重建以 sourceEventSeq 为 raw snapshot 边界，并把等待窗口内事件补回。
    const publisher = latestPublisher ?? existingAtStart ?? this.ensurePublisher(sessionId);
    this.rejectProjectionEventWaiters(
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.rehydrated",
        `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
      ),
    );
    publisher.rehydrate(loaded.events, {
      // 恢复时 transcript/event store 可能仍含运行期已拒绝的超大正文。不能让同一事实
      // 在 CLI 重启后再次把 subscribe 卡死；跳过该不可传输 projection event，继续归约
      // 后续持久 TurnError/TurnComplete，使冷快照停在最后一个可恢复边界。
      onPayloadTooLarge: (error) =>
        this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "publisher.rehydrate",
          sessionId,
        }),
    });
    if (loaded.sharedContextImport) {
      publisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
    // 同次恢复的种子先应用，再补 live buffer；较新的使用量和选模事件始终获胜。
    if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
    const sourceEventSeq = Math.max(
      0,
      loaded.sourceEventSeq ??
        (loaded.synthesized
          ? 0
          : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
    );
    const previousSequenceState = this.rawSequenceStates.get(sessionId);
    const sequenceState: RawSequenceState = {
      sourceEventSeq,
      offset: publisher.getSnapshot().seq - sourceEventSeq,
      lastTransportSeq: publisher.getSnapshot().seq,
      seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
      appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
      failedEventById: new Map(previousSequenceState?.failedEventById),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, sequenceState);
    // 持久读取的 sourceEventSeq 是 load 开始时的水位；hydration buffer
    // 只能记录 load 开始后的事件。若 seq=N 已在 buffer 创建前进入 live publisher，而
    // load 只读到 N-1 时，rehydrate 后不能仅重放 N+1：raw reorder 会永久等待已经被
    // 丢掉的 N，连带让 running Agent 控制行消失。保留与 publisher 相同大小的 raw tail，
    // 与 await 窗口 buffer 合并后从持久边界连续重放。
    const replayByEventId = new Map<string, SessionEvent>();
    for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    for (const rawEvent of buffer.rawEvents) {
      if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
        replayByEventId.set(String(rawEvent.id), rawEvent);
      }
    }
    const replayEvents = [...replayByEventId.values()].sort((left, right) => {
      if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
        return left.sequenceNumber - right.sequenceNumber;
      }
      if (left.sequenceNumber > 0) return -1;
      if (right.sequenceNumber > 0) return 1;
      return 0;
    });
    for (const rawEvent of replayEvents) {
      for (const normalized of this.normalizeRuntimeEventSequence(sessionId, rawEvent)) {
        try {
          publisher.ingest(normalized);
          this.resolveProjectionEventCommit(sessionId, String(normalized.id));
        } catch (error) {
          this.rejectProjectionEventCommit(
            sessionId,
            String(normalized.id),
            new ProjectionEventCommitWaitError(
              "fault.projectionEventCommit.applyFailed",
              `projection failed to apply hydrated event ${String(normalized.id)}`,
              { cause: error },
            ),
          );
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          this.host.onError?.("v4.hydrate.payloadTooLarge", error, {
            phase: "replayBufferedEvents",
            sessionId,
          });
        }
      }
    }
    // publisher 已替换且 buffer 已同步补齐；在 usage seed 的异步等待窗口内，新 raw
    // event 直接走上面的 per-session sequence state 进入新 publisher，不再需要二次 replay。
    if (this.hydrationBuffers.get(sessionId) === buffer) {
      this.hydrationBuffers.delete(sessionId);
    }
    // 冷恢复种子（重放之后）：resume 已把历史会话的上次选型写回 runtime
    // （reconcileResumedRuntimeSettings），而合成/持久化事件里可能没有 ModelSelected——
    // 种子只填事件未触碰的字段，日志有值时以日志为准（冷恢复口径）。
    this.seedPublisherConfig(sessionId, publisher);
    if (loaded.usageSeed === undefined) {
      await this.seedPublisherUsage(sessionId, publisher, persistedMessages);
    }
    for (const [routeKey, state] of this.flushStates) {
      if (state.sessionId !== sessionId) continue;
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (this.pausedConnections.has(state.connectionId)) continue;
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) continue;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.hydrate.subscriptionResync", error, {
          phase: "subscriptionResync",
          sessionId,
        });
        this.scheduleFlush(routeKey, state, publisher);
      }
    }
    this.hydratedSessions.add(sessionId);
    this.publishCurrentSummaryToIndex(sessionId);
    return publisher;
  }

  /**
   * cold 合成会把事件重新编号为 1..N，而 runtime 仍沿用 eventStore raw seq。这里用
   * source cursor 建立 N-C 偏移；raw seq=0（live-only child）则顺延，并同步校正后续偏移。
   * eventId 兜住 snapshot/buffer 同时看见同一事件的竞态，cursor 兜住已入 snapshot 的事件。
   */
  private normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[] {
    const state = this.getOrCreateRawSequenceState(sessionId);
    const eventId = String(event.id);
    if (state.seenEventIds.has(eventId)) return [];

    const rawSeq = event.sequenceNumber;
    // EventStore 瘦身会替换对象，无法释放此缓存持有的旧 messages；回放只需元数据与序号。
    state.recentRawEventsById.set(eventId, slimRetainedModelRequest(event));
    while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
      const oldestEventId = state.recentRawEventsById.keys().next().value;
      if (oldestEventId === undefined) break;
      state.recentRawEventsById.delete(oldestEventId);
    }
    if (rawSeq <= 0) {
      state.seenEventIds.add(eventId);
      state.lastTransportSeq += 1;
      return [{ ...event, sequenceNumber: state.lastTransportSeq }];
    }
    if (event.type === SessionEventType.SessionResumed) {
      // 旧 runtime 在 unsubscribe/重建窗口时可能遗漏尾部 raw event。新 runtime
      // 延续持久 eventStore 高水位时，SessionResumed 的 raw seq 会大于旧 cursor；
      // 若只处理 seq 回退，resume 和后续 TurnStarted 就会永久等待无法补齐的旧 gap。
      // SessionResumed 是明确 epoch 边界：丢弃边界前的旧 pending，同时保留可能乱序先到的
      // 新 epoch 后续事件，再从 resume 自身连续 drain。
      for (const pendingSeq of state.pendingByRawSeq.keys()) {
        if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
      }
      state.sourceEventSeq = rawSeq - 1;
      state.offset = state.lastTransportSeq - state.sourceEventSeq;
    }
    if (rawSeq <= state.sourceEventSeq) {
      state.seenEventIds.add(eventId);
      this.resolveProjectionEventCommit(sessionId, eventId);
      return [];
    }

    state.seenEventIds.add(eventId);
    if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
    const ready: SessionEvent[] = [];
    // eventStore 先编号，各事件各自 await 持久化后再 notify，
    // 因此 N+1 可以先于 N 到达。高水位过滤会把迟到 N 错判成 duplicate；
    // 必须按 raw seq 暂存，只连续 drain，才能保住 queue/stream 总序。
    for (;;) {
      const nextRawSeq = state.sourceEventSeq + 1;
      const next = state.pendingByRawSeq.get(nextRawSeq);
      if (!next) break;
      state.pendingByRawSeq.delete(nextRawSeq);
      let transportSeq = nextRawSeq + state.offset;
      if (transportSeq <= state.lastTransportSeq) {
        transportSeq = state.lastTransportSeq + 1;
        state.offset = transportSeq - nextRawSeq;
      }
      state.sourceEventSeq = nextRawSeq;
      state.lastTransportSeq = transportSeq;
      // waiter timeout/abort 只清 listener 是不够的，还要终止已在 raw gap 中的
      // event。command 返回 failed 后，缺失 seq 一到仍会把同一 TurnStarted 投影出来。
      // 失败事件仍消费 raw 序号以解除后续事件阻塞，但绝不能再成为 canonical fact。
      if (state.failedEventById.has(String(next.id))) {
        continue;
      }
      ready.push(
        transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
      );
    }
    return ready;
  }

  private getOrCreateRawSequenceState(sessionId: string): RawSequenceState {
    const existing = this.rawSequenceStates.get(sessionId);
    if (existing) return existing;
    const created: RawSequenceState = {
      sourceEventSeq: 0,
      offset: 0,
      lastTransportSeq: 0,
      seenEventIds: new Set(),
      appliedEventIds: new Set(),
      failedEventById: new Map(),
      pendingByRawSeq: new Map(),
      recentRawEventsById: new Map(),
    };
    this.rawSequenceStates.set(sessionId, created);
    return created;
  }

  private resolveProjectionEventCommit(sessionId: string, eventId: string): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.delete(eventId);
    state.appliedEventIds.add(eventId);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.resolve();
  }

  private rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void {
    const state = this.getOrCreateRawSequenceState(sessionId);
    state.failedEventById.set(eventId, error);
    const waiters = this.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.reject(error);
  }

  private rejectProjectionEventWaiters(sessionId: string, error: Error): void {
    const byEvent = this.projectionEventCommitWaiters.get(sessionId);
    if (!byEvent) return;
    for (const waiters of byEvent.values()) {
      for (const waiter of [...waiters]) waiter.reject(error);
    }
    this.projectionEventCommitWaiters.delete(sessionId);
  }

  /**
   * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
   * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
   * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
   */
  private hasLiveConversation(sessionId: string): boolean {
    return this.host.sessionExists(sessionId) || this.detachedLiveSessions.has(sessionId);
  }

  private async seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void> {
    if (loadedSeed !== undefined) {
      if (loadedSeed) publisher.seedUsage(loadedSeed);
      return;
    }
    const getSeed = this.host.getSessionUsageSeed;
    if (!getSeed) return;
    try {
      const seed = await getSeed.call(this.host, sessionId, persistedMessages);
      if (seed) publisher.seedUsage(seed);
    } catch (error) {
      this.host.onError?.("v4.usageSeed", error);
    }
  }

  private scheduleFlush(
    routeKey: string,
    state: FlushState,
    publisher: ConversationTopicPublisher,
  ): void {
    if (this.pausedConnections.has(state.connectionId)) return;
    if (state.timer !== null) return;
    const timer = setTimeout(() => {
      state.timer = null;
      // timer 排队后可能收到 SAT；reserve 前必须二次检查，不能产生竞态帧。
      if (this.pausedConnections.has(state.connectionId)) return;
      // 惰性清理：订阅已被替换/退订→ 删调度状态，不产帧。
      if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
        this.flushStates.delete(routeKey);
        return;
      }
      const reservation = publisher.reserveFlush(state.subscriptionId);
      if (!reservation) return;
      try {
        this.emitReservation(reservation);
      } catch (error) {
        this.host.onError?.("v4.frame.emit", error);
      }
    }, state.flushWindowMs);
    // CLI 进程退出不被 flush 定时器挂住。
    timer.unref?.();
    state.timer = timer;
  }

  private emitReservation<F extends RoutedTopicFrame>(
    reservation: TopicFrameReservation<F>,
  ): boolean {
    // resync/subscribe recovery 已进入 request-scoped outbox 时，online
    // flush 若复用同一 inFlight 会让 physical wire 抢在 ACK response 前出站。
    if (this.controlReservations.has(reservation)) return false;
    const sessionId = parseConversationTopic(reservation.frame.topic);
    const route = this.flushStates.get(
      subscriptionRouteKey(
        reservation.frame.topic,
        reservation.frame.subscriptionId,
        sessionId
          ? (this.publishers
              .get(sessionId)
              ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
          : "",
      ),
    );
    if (
      sessionId &&
      route?.deliveryProfile === "continuous" &&
      reservation.deliveryKind === "online" &&
      reservation.frame.payload.kind === "deltas" &&
      this.localTtft.forSession(sessionId)
    ) {
      const rows = this.publishers.get(sessionId)?.getSnapshot().rows.window ?? [];
      const turns = new Set<string>();
      for (const delta of reservation.frame.payload.deltas) {
        if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
        else if (delta.op === "row.delta") {
          const row = rows.find((item) => item.rowId === delta.rowId);
          if (row) turns.add(row.turnId);
        }
      }
      const related = rows
        .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
        .flatMap((header) =>
          header.kind === "turnHeader" && header.sourceCommandId
            ? [this.localTtft.forSession(sessionId, header.sourceCommandId)]
            : [],
        )
        .filter((facts) => facts !== undefined);
      const candidates = related.length ? related : [this.localTtft.forSession(sessionId)];
      const observations: import("@zcode/shared").LocalTtftFacts[] = [];
      for (const facts of candidates) {
        if (!facts || observations.some((item) => item.observationId === facts.observationId))
          continue;
        const header = rows.find(
          (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
        );
        const observation = localTtftFactsSchema.safeParse({
          ...facts,
          ...(this.host.cliVersion ? { cliVersion: this.host.cliVersion } : {}),
          ...(header ? { productTurnId: header.turnId } : {}),
        });
        // 转正前后的内容可能被同批发送；按实际 row 所属原输入携带事实，不能取最新队列项。
        if (observation.success) observations.push(observation.data);
      }
      if (observations.length) {
        (reservation.frame as ConversationTopicFrame).ttft = observations[0];
        if (observations.length > 1)
          (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
      }
    }
    const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
    for (const wire of wires) this.host.emitWireFrame(wire);
    return reservation.commit();
  }

  private subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F> {
    const initialWires = reservation
      ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
      : [];
    if (reservation) this.controlReservations.add(reservation);
    let afterCommitRan = false;
    return {
      ack,
      initialFrame: reservation?.frame ?? null,
      initialWires,
      commit: () => {
        if (!reservation) return true;
        this.controlReservations.delete(reservation);
        const committed = reservation.commit();
        if (committed && !afterCommitRan) {
          afterCommitRan = true;
          // control reservation 等 ACK/outbox admission 时，既有 flush timer
          // 可能已触发并因同一 inFlight 被抑制。commit 后必须主动重驱动 publisher，
          // 否则期间积累的 delta 会一直等到下一次 ingest/publish 才可见。
          afterCommit?.();
        }
        return committed;
      },
    };
  }
}

/** 宿主 executor 对未接线命令抛出此错误 → ACK failed fault.notImplemented。 */
export class V4CommandNotImplementedError extends Error {
  constructor(type: string) {
    super(`v4 command not implemented in M3: ${type}`);
    this.name = "V4CommandNotImplementedError";
  }
}

/**
 * 命令 handler 的 noop 收口通道（「同值切换 ACK 必须可判别」）：
 * handler 判定命令无事可做（如 switchModelConfig/switchCollaborationMode 命中
 * runtime 当前值）时抛出，gateway 映射为 ACK status="noop" + reasonCode——
 * 不得以 accepted（无 result）静默吞掉，客户端才能区分「已生效」与「本来就是这个值」。
 */
export class V4CommandNoopError extends Error {
  constructor(
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ?? `v4 command is a no-op (${reasonCode})`);
    this.name = "V4CommandNoopError";
  }
}

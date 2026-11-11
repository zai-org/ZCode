// v4 原生命令层的 core 能力契约（原生重做版）。
//
// 分层纪律（不做桥接）：
// - 本目录是命令的原生实现：决策逻辑（steer 分流 / draft 提升 / abort 生命周期 /
//   goal-pause barrier）在 handler 里直驱 core（ZCodeApp / runtime），不经旧协议 op。
// - 会话注册表仍归宿主：通过 V4CommandCoreHost 以「结构化窄视图」透传旧
//   ZCodeProtocolSessionRecord（同一对象引用，字段变更双向可见，不产生第二份注册表）。
// - 环境能力（模型就绪 / legacy 广播 / shell 解析）是注入钩子：旧协议 binder 在过渡期
//   提供实现，与旧协议同生命周期——每个钩子都标注过渡归宿，新增钩子必须标注。
import type {
  SessionTaskType,
  StableForkGoalBoundaryMetadata,
  TraceContext,
} from "@zcode/contracts";
import type {
  DynamicWorkflowMode,
  ModelSelection,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  ConversationInputIntent,
  QueueItem,
  StableForkTarget,
  StableForkTargetResolution,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";
import type { V4InteractionRegistry } from "../interaction-registry.js";
import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "../product-projection.js";

/** 最小日志面（结构化字段直传宿主 logger）。 */
export interface V4CommandLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export type V4QueueItemCommand = QueueItem;

/** 单轮执行材料的协议原形。 */
export type V4TurnExecution = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;

/**
 * Highspeed 队列项的临时执行包。QueueItem.modelSelection 只保存普通提交模型；
 * 加速 Selection 必须与动态凭据一起驻留内存，提升时再冻结进本轮。
 */
export interface V4QueuedTurnExecution {
  modelSelection: NonNullable<CommandPayloadMap["sendText"]["modelSelection"]>;
  modelExecution: V4TurnExecution;
}

export type V4StableForkTargetResolution =
  | {
      ok: true;
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
    }
  | Extract<StableForkTargetResolution, { ok: false }>;

/**
 * 旧 ZCodeProtocolSessionRecord 的结构化窄视图（只声明命令层需要的字段）。
 * 结构兼容：binder 直接把旧 record 对象透传进来；v4 自持会话注册表后由其提供同形对象。
 */
export interface V4SessionRecordView {
  app: ZCodeApp;
  /** 冷恢复保留的 Session 原选择；运行绑定暂不可用时仍保留，显式选模后由 owner 清除。 */
  restoredModelSelection?: ModelSelection;
  /**
   * 会话根 traceContext（traceId 位于 sessionId 之上，对应整条任务链）。
   * 命令层调 runtime 方法/补发 core 事件时透传沿用，不得中途另起 trace。
   * 旧 record 本就携带此字段，窄视图直接透传。
   */
  traceContext: TraceContext;
  workspace: { workspacePath: string };
  /** draft 语义：deferred = 未发送首条消息，不进 sqlite；首条 send 时提升 immediate。 */
  persistence: "immediate" | "deferred";
  /** active turn 锁：存在 = turn 运行中（sendText 走 steer 分流、stop 有目标）。 */
  activeAbortController?: AbortController;
  /** ready lock 已释放但 state mutation 收尾仍在使用 record/runtime 的引用计数。 */
  residencyFinalizationCount?: number;
  /** 当前正在执行的 automation 派发 turn；只在 turn 运行期间存在。 */
  activeAutomationId?: string;
  /** 当前正在执行的闲时派发 turn；只在 turn 运行期间存在。 */
  activeOffPeakTaskId?: string;
  /** 当前 Bot 入站 turn 的稳定回推地址；turn 结束后必须恢复。 */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  /** 恢复失败告警：存在时拒绝新 turn（历史损坏不能静默续写）。 */
  restoreWarning?: { message: string; type: string };
  taskType?: SessionTaskType;
}

export interface V4CommandCoreHost {
  /** 会话查找（同一注册表对象引用；不存在返回 undefined → handler 拒绝）。 */
  getRecord(sessionId: string): V4SessionRecordView | undefined;
  logger?: V4CommandLogger;

  // ── v4 原生能力（非过渡钩子）────────────────────────────────
  /** queue 项完整权威 intent；sendQueuedNow 禁止退化成 text-only 重发。 */
  getQueueItem?(sessionId: string, queueItemId: string): V4QueueItemCommand | null;
  /** typed maintenance 命令去重；判据来自同一 projection queue，不维护旁路集合。 */
  hasQueueItemKind?(sessionId: string, kind: QueueItem["kind"]): boolean;
  /** guide eligibility：只阻止已有 ordinary queue；已有 guide 仍允许继续按 FIFO admission。 */
  hasQueuedDelivery?(sessionId: string, delivery: "guide" | "queue"): boolean;
  getQueueLength?(sessionId: string): number;
  /** 队首正被 composer 编辑态冻结（投影 queue.items[0].editLock）。 */
  isQueueHeadEditLocked?(sessionId: string): boolean;
  /** Highspeed queue 的执行材料含凭据，只允许驻留内存，禁止进入 queue event/snapshot。 */
  retainQueuedTurnExecution?(
    sessionId: string,
    sourceCommandId: string,
    execution: V4QueuedTurnExecution,
  ): void;
  readQueuedTurnExecution?(
    sessionId: string,
    sourceCommandId: string,
  ): V4QueuedTurnExecution | undefined;
  deleteQueuedTurnExecution?(sessionId: string, sourceCommandId: string): void;
  clearQueuedTurnExecutions?(sessionId: string): void;
  /** timeline/child 这类无 user message 的成功副作用持久化查重事实。 */
  recordPersistentCommandFact?(
    sessionId: string,
    source: "timeline" | "child",
    ack: CommandAck,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** createSession.firstInput / selection side firstInput 与普通 send 共用的 durable admission 边界。 */
  admitInputCommand?(
    envelope: CommandEnvelope,
    sessionId: string,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelInputCommand?(sessionId: string, queueItemId: string, reason: string): Promise<void>;
  discardSharedContext?(sessionId: string, contextId: string): Promise<boolean>;
  /**
   * 当前输入路由模式（数据源 = v4 投影 inputRouting.mode）。
   * sendText/sendGoalCommand 的 held choice 裁决（heldQueueInputRequiresChoice）依赖它判定是否必须携带 heldQueueDisposition。
   * 会话无投影（尚无事件）→ null（按非 held 处理）。
   */
  getInputRoutingMode?(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null;
  /** runtime event notification 后，等待目标 event 真正完成 reorder drain + projection apply。 */
  waitForProjectionEventCommit?(
    sessionId: string,
    eventId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * rowId → 权威 messageId（数据源 = v4 投影 rowId→messageId 翻译表）。
   * 历史兼容查询：把投影 rowId（assistant 行）翻译成
   * transcript 的 messageId。翻译不到（非 assistant 行/迟到 rowId）→ null → handler
   * reject，绝不静默兜底 latestCheckpoint（会 fork/rewind 错点）。
   */
  getMessageIdForRow?(sessionId: string, rowId: number): string | null;
  /** row.actions/CommandInbox/handler 共用的唯一 row target resolver。 */
  resolveRowActionTarget?(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution | null;
  /**
   * rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销用）。
   * 多段 assistant / 多个 checkpoint 必须一次性交给 core，避免只撤最后一段文件。
   */
  getMessageIdsForTurnRow?(sessionId: string, rowId: number): string[];
  /**
   * core 侧强校验：fork 只挂每轮结尾最后一段。
   * true=是轮尾段；false=中间段（reject）；null=无投影/未知（按翻译失败处理）。
   */
  isLatestAssistantSegmentRow?(sessionId: string, rowId: number): boolean | null;
  /** 唯一 stable fork resolver：projection 闸门 + transcript 持久 anchor/fallback。 */
  resolveStableForkTarget?(sessionId: string, rowId: number): Promise<V4StableForkTargetResolution>;
  /**
   * latestAssistantRetryOnly core 侧防御：retryTurn 只能指向当前投影里的最后一条
   * assistantText row。false/null 都由 handler 拒绝，避免旧客户端绕过 UI。
   */
  isLatestRetryAssistantRow?(sessionId: string, rowId: number): boolean | null;
  /**
   * latestQueryEditOnly core 侧防御：editUserQuery 只能指向当前投影里的最后一条
   * realUser userInput row。false/null 都由 handler 拒绝，避免旧客户端绕过 UI。
   */
  isLatestEditableUserRow?(sessionId: string, rowId: number): boolean | null;
  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 store 用）。 */
  getTurnIdForRow?(sessionId: string, rowId: number): string | null;
  /**
   * restoreWarning 时序自愈探针：当前进程 Registry 是否已经发布可用模型。
   * binder 实现；宿主不支持 → 不自愈，维持拒绝。
   */
  hasUsableRuntimeModelTarget?(record: V4SessionRecordView): boolean;
  /**
   * rowId → 所属 turn 的 rewind 锚点 messageId（数据源同上）。
   * editUserQuery targets user 行（user 行无 messageId），rewind 需要 messageId——
   * 用同 turn 内 assistant 行的 messageId 作锚点。
   */
  getTurnRewindAnchor?(sessionId: string, rowId: number): string | null;
  /**
   * running latest edit 在 assistant anchor 尚未出现时的兜底：
   * stop 后按 row 所属 turn 回查 sessionStore 中的 real user messageId。
   */
  resolveUserMessageIdForRow?(sessionId: string, rowId: number): Promise<string | null>;
  /**
   * retryTurn 的原 prompt 解析：assistant messageId → parentID（user 消息）→ 文本。
   * 数据源 = core sessionStore（transcript 权威），非旧协议——binder 实现只是
   * 因为 deps 注入点在宿主；v4 自持会话注册表后随 host 原生持有。
   * 找不到（无 parent / 无 store）→ null → handler 只截断不重发。
   */
  resolveTurnUserPrompt?(sessionId: string, assistantMessageId: string): Promise<string | null>;
  /** assistant 反馈先持久化 transcript metadata，再发布同一 entity 的投影事件。 */
  setAssistantFeedback?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      feedback: "like" | "dislike" | null;
    },
  ): Promise<void>;
  /** Highspeed 完成态统计先更新 user transcript metadata，再发布同一 entity 的投影事件。 */
  setHighspeedMetrics?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      metrics: {
        regularTps: number;
        outputTokens: number;
        durationMs: number;
        highspeedTps: number;
        savedDurationMs: number;
        modelDurationMs?: number;
        toolDurationMs?: number;
        otherDurationMs?: number;
      };
    },
  ): Promise<void>;
  /**
   * 交互应答登记表（v4 原生基础设施，非过渡钩子）：interaction-broker 发起
   * 反向请求（permission/AskUserQuestion）时注册 deferred，resolveInteraction 命令
   * 经此投递应答。binder 注入与 broker 同一实例；类型上可选仅为测试夹具便利——
   * 未注入时按未命中处理（幂等成功收口）。
   */
  interactions?: V4InteractionRegistry;

  // ── 过渡期钩子（legacy 兼容窗口）─────────────────────────
  /**
   * 切模型前由 Agent 进程 Registry 校验目标 Provider。普通模型命令只携带 Selection，
   * 因此这里不能接收或安装 Host 运行快照。
   */
  ensureProviderAvailable?(
    sessionId: string,
    providerId: string,
  ): Promise<{ available: boolean; reason?: string }>;
  /**
   * legacy 广播（state.updated + record.stateRevision）：旧协议消费者（侧栏/任务索引）
   * 在侧栏迁移完成前仍靠它感知状态变更。v4 自身投影走 gateway 事件 ingest，
   * 不依赖本钩子；旧广播机制收口时本钩子随之收口。
   */
  afterLegacyStateMutation?(record: V4SessionRecordView, reason: string): Promise<void>;
  /**
   * 会话删除（deleteSession 的执行面：软删除持久化 → 退订事件 → app.close → 注册表摘除 →
   * gateway 清通道）。
   * 过渡形态：会话注册表现归旧协议宿主，binder 内联实现（顺序对齐旧 closeSession op，
   * 见 zcode-protocol/server-operations.ts）；v4 自持会话注册表后收编为原生实现。
   */
  deleteSession?(sessionId: string): Promise<void>;
  /**
   * 会话记录创建（createSession 的执行面：record 建立/事件接线/模型 catalog 同步/
   * 失败清理，全部与旧协议宿主纠缠）。binder 实现调旧 createSession op；
   * v4 自持会话注册表后由原生实现取代本钩子。
   * 语义决策（draft persistence / firstInput 提交）留在原生 handler，不进钩子。
   */
  createSessionRecord?(params: {
    sessionId?: string;
    additionalDirectories?: string[];
    workspaceId: string;
    /** 会话 cwd 与 workspace 不同（受管 worktree）；只允许本地 workspace。 */
    cwd?: string;
    permissionScope?: "session";
    mcpServers?: CommandPayloadMap["createSession"]["mcpServers"];
    /** host 判定的 Off-Peak 工具面门禁；缺省不注册工具。 */
    offPeakToolEnabled?: boolean;
    /**
     * host 判定的动态工作流灰度门；
     * 缺省回落到进程级 workspace 结论，仍是 fail-closed。
     */
    dynamicWorkflowEnabled?: boolean;
    /** 与布尔同行的灰度 mode（launch.md「On demand: activation」）；缺省按 alwaysOn。 */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }): Promise<{ sessionId: string }>;
  /** 从父会话稳定落盘边界创建隐藏 selection_side_chat child。 */
  createSelectionSideSession?(
    sessionId: string,
    options: {
      sourceCommandId: string;
      revisionAtDecision: number;
      modelSelection?: NonNullable<
        CommandPayloadMap["createSelectionSideSession"]["firstInput"]
      >["modelSelection"];
    },
  ): Promise<{ sessionId: string }>;
  /** conversation-only stable fork；不得 stop parent、rewind workspace 或复制 active work/queue。 */
  forkStableConversation?(
    sessionId: string,
    options: {
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
      sourceCommandId: string;
      revisionAtDecision: number;
      /** 协议原样透传；校验（仅本地）与项目身份派生由宿主负责。 */
      targetCwd?: CommandPayloadMap["forkAssistant"]["targetCwd"];
    },
  ): Promise<{ forkedSessionId: string }>;
  /** @deprecated 仅旧宿主结构兼容；新 editUserQuery 永不调用，显式 forkAssistant 不受影响。 */
  forkConversationBeforeInput?(
    sessionId: string,
    options: {
      editTarget: ConversationEditTarget;
      envelope: CommandEnvelope;
      admission: { admissionSeq: number; admittedAt: number; queueItemId: string };
    },
  ): Promise<{ forkedSessionId: string }>;
  /** bundle 已提交后 runtime 同步启动失败：只记 child failure，parent fork ACK 保持 accepted。 */
  recordForkStartFailure?(
    sessionId: string,
    envelope: CommandEnvelope,
    error: unknown,
  ): Promise<void>;
}

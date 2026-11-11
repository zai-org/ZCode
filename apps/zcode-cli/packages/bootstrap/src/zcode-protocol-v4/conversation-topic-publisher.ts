// Conversation topic 发布器（传输外壳）。
// CLI 侧权威运行时：内存有界 delta 日志（logEpoch + 保留窗）+ subscribe(base)
// 裁决（resume/snapshot）+ 每订阅者 flush 管线（filter → coalesce → 打帧）。
//
// 职责边界：
// - 本类只做「事件 → 帧」的权威记账，不做网络 IO / 定时器——flush 时机由宿主驱动
//   （host 通道层按 profile.flushWindowMs 调度；测试里手动调用），保持可测的纯推进。
// - 恢复与续流共用一条管线：resume 的初始帧 = 保留窗内 (base.seq, current] 的 delta
//   过该订阅者 profile 过滤再 coalesce，
//   因此「snapshot(W)+续流 ≡ 全量重放」黄金测试可直接覆盖恢复路径。
// - 重订阅 = 替换：同 connectionId 重复 subscribe 即作废旧订阅并清其
//   flush buffer，旧 subscriptionId 不再产帧，客户端按 subId 丢弃旧代际帧。
import {
  pluginInstallDeltasForConnection,
  pluginInstallSnapshotForConnection,
} from "../plugin-discovery/subscription.js";
import { type SessionEvent } from "@zcode/contracts";
import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  SubscribeAck,
  TopicFrameDeliveryKind,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isWireConversationRow,
  DELIVERY_PROFILES,
  statePatchSchema,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  coalesceConversationDeltas,
  filterConversationDeltasForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import { encodeConversationDeltasForLegacy } from "./conversation-workflow-run-deltas.js";
import {
  ProductProjection,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
  type StableForkCandidateResolution,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

import {
  applyConversationEvent,
  conversationPlans,
  conversationRowsRange,
  conversationWireSnapshot,
  hydrateConversationCandidate,
  measureConversationSnapshotBytes,
  measureInputAdmissionBytes,
  ProjectionPayloadTooLargeError,
  PROJECTION_TERMINAL_RESERVE_BYTES,
} from "./materialization/index.js";
export {
  coldHydrationJsonByteLength,
  ProjectionPayloadTooLargeError,
  PROJECTION_TERMINAL_RESERVE_BYTES,
} from "./materialization/index.js";

interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /**
   * 这条订阅认不认得 `workflowRun.*` 键级增量（握手能力位，由可信 host 注入）。
   * false = 旧消费者：增量折成整键 patch、快照裁到旧界（conversation-workflow-run-deltas.ts）。
   */
  workflowRunDeltas: boolean;
  pluginDiscoveryUi: boolean;
  /** flush buffer：push 时已过 profile 过滤与该订阅的编码，flush 时 coalesce 打帧。 */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** buffer 超限后只保留恢复意图，不继续为慢订阅者积压 delta。 */
  resyncRequired: boolean;
  /** 帧区间记账水位：下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  /** 编码/写入期间保留的稳定 logical frame。 */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

export interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** 缺省 replayable（ws 默认；MessagePort 宿主显式传 continuous）。 */
  deliveryProfile?: DeliveryProfileName;
  /**
   * 该连接的 clientHello 声明过认得 `workflowRun.*` 增量。与 deliveryProfile 同族：可信 host
   * 注入，面向 UI 的 subscribe 选不了。缺省 false——能力位缺席一律按旧消费者办。
   */
  workflowRunDeltas?: boolean;
  pluginDiscoveryUi?: boolean;
}

export interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** initial encode 失败且 ACK 未 admission 时，原子恢复被替换的旧 subscription。 */
  rollback(): boolean;
  /** snapshot 帧或 resume 的续传帧；resume 且无新增时为 null（客户端水位已对齐）。 */
  readonly frame: ConversationTopicFrame | null;
}

export interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

export interface ConversationTopicPublisherOptions {
  /** CLI 时钟（frame.sentAt / clockOffset 估计源）。 */
  now?: () => number;
  /** 事件保留窗（条），默认 PROTOCOL_V4_LIMITS.eventRetentionPerSession。 */
  retention?: number;
  /** 每订阅者 coalesce 后 op 上限；主要用于协议配置与边界测试。 */
  subscriberBufferMaxOps?: number;
  /** 每订阅者 logical deltas payload 的 UTF-8 byte 上限。 */
  subscriberBufferMaxBytes?: number;
}

export interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  /** 字节下限（默认 1MiB）；实际上限见 conversationSubscriberBufferByteLimit。 */
  maxBytes?: number;
  /** 当前 wire snapshot logical frame 的保守上界；缺省 0 = 只按下限裁决。 */
  snapshotBytesUpperBound?: number;
}

export type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

function nonNegativeHardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

/**
 * subscriber buffer 的实际字节上限 = min(max(下限, snapshot 上界), 16MiB - 64KiB)（05 §3）。
 * 修复原因：overflow 的意义是用更小的 snapshot 换掉积压 delta；旧实现固定 1MiB，单条大
 * delta（如 3MiB bash 输出的 tool row upsert）就会降级为 snapshot，而 snapshot 因同一行仍在
 * 尾部窗口只会更大，还让客户端整份替换、丢掉已分页的历史行，turn navigator 随即全量重新
 * 分页——长 session 中每轮循环一次。外层钳位给帧外壳留出 assembly 余量，deltas 帧仍 <=16MiB。
 */
export function conversationSubscriberBufferByteLimit(
  floorBytes: number,
  snapshotBytesUpperBound: number,
): number {
  return Math.min(
    Math.max(floorBytes, snapshotBytesUpperBound),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES,
  );
}

/**
 * profile filter 后的 delta 进入此纯函数；先与现有 buffer 合并并 coalesce，
 * 再按 op/UTF-8 bytes 双限额裁决——限额必须真正执行，只存裸 delta[] 不裁决的话，
 * 慢订阅者会持续堆积并最终生成不可控的大帧。
 */
export function appendConversationSubscriberBuffer(
  current: readonly ConversationDelta[],
  incoming: readonly ConversationDelta[],
  limits: ConversationSubscriberBufferLimits = {},
): ConversationSubscriberBufferResult {
  const maxOps = nonNegativeHardBound(
    limits.maxOps,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
    "maxOps",
  );
  const maxBytes = nonNegativeHardBound(
    limits.maxBytes,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    "maxBytes",
  );
  const byteLimit = conversationSubscriberBufferByteLimit(
    maxBytes,
    limits.snapshotBytesUpperBound ?? 0,
  );
  const deltas = coalesceConversationDeltas([...current, ...incoming]);
  if (deltas.length > maxOps) return { kind: "overflow" };
  const encodedBytes = utf8JsonByteLength({ kind: "deltas", deltas });
  if (encodedBytes > byteLimit) return { kind: "overflow" };
  return { kind: "buffered", deltas, encodedBytes };
}

export class ConversationTopicPublisher {
  readonly topic: string;
  private projection: ProductProjection;
  private readonly now: () => number;
  private readonly retention: number;
  private readonly subscriberBufferMaxOps: number;
  private readonly subscriberBufferMaxBytes: number;
  /** 有界日志：seq 升序；resume 只在 (floorSeq, currentSeq] 内合法。 */
  private readonly log: LogEntry[] = [];
  /** 保留窗下界：base.seq < floorSeq 的恢复请求已无法无损续传 → 只能 snapshot。 */
  private floorSeq = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;
  /** 当前 snapshot logical frame 的保守上界；流式追加只累计增量，逼近上限才精确序列化。 */
  private wireSnapshotBytesUpperBound: number;

  constructor(
    private readonly sessionId: string,
    private readonly logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.topic = `conversation/${sessionId}`;
    this.projection = new ProductProjection(sessionId, logEpoch);
    this.now = options.now ?? Date.now;
    this.retention = options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    this.subscriberBufferMaxOps = nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    );
    this.subscriberBufferMaxBytes = nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    );
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  getSnapshot(): ConversationSnapshot {
    return this.projection.getSnapshot();
  }

  /** 初始化只变化几次，沿既有 snapshot 恢复边界发布，不引入第二份事件流。 */
  setRuntimeInitialization(
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  ): void {
    this.projection.setRuntimeInitialization(state);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
    this.appendDeltas(this.currentSeq, [
      { op: "state.updated", patch: statePatchSchema.parse(this.getSnapshot()) },
    ]);
  }

  setPendingCommands(
    pendingCommands: ConversationSnapshot["pendingCommands"],
    minimumSeq = 0,
  ): void {
    const candidate = {
      ...this.getSnapshot(),
      pendingCommands,
      seq: Math.max(this.currentSeq + 1, minimumSeq),
    };
    const bytes = this.measureWireSnapshotBytes(this.getWireSnapshot(candidate));
    if (bytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES)
      throw new ProjectionPayloadTooLargeError(bytes);
    const deltas = this.projection.setPendingCommands(pendingCommands, minimumSeq);
    this.wireSnapshotBytesUpperBound = bytes;
    this.appendDeltas(this.currentSeq, deltas);
  }

  /** 测试/闸门共用的 logical TopicFrame 字节口径（不是裸 snapshot 大小）。 */
  getWireSnapshotLogicalBytes(): number {
    return this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return this.projection.resolveStableForkCandidate(rowId);
  }

  /** config 种子注入：直改投影初值，不产 delta / 不进事件日志。语义见 ProductProjection.seedConfig。 */
  seedConfig(seed: SessionConfigSeed): void {
    this.projection.seedConfig(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** 分享导入提示是静态只读元数据，不进入 delta/revision；可在 hydration 后幂等补种。 */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    this.projection.seedSharedContextImport(source);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** usage 种子注入：冷恢复用持久化 token 水位覆盖 transcript 合成的 0 占位。 */
  seedUsage(seed: SessionUsageSeed): void {
    this.projection.seedUsage(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** cold hydration 的 store-verified subagent manifest，不产 delta。 */
  seedSubagents(seed: SessionSubagentsSeed): void {
    this.projection.seedSubagents(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * 下发用快照：rows 只带尾部窗口（snapshotTailWindowRows），
   * totalCount/firstRowId 保留全序口径——客户端以 `window[0].rowId === firstRowId`
   * 判定已到顶，更早历史经 rows/range 游标拉取。投影内部快照保持全量
   * （rows/range 数据源 + findRow/messageId 锚点都依赖它），只在打帧边界截断。
   */
  private getWireSnapshot(snapshot = this.projection.getSnapshot()): ConversationSnapshot {
    return this.getWireSnapshotForProfile(DELIVERY_PROFILES.continuous, snapshot);
  }

  private getWireSnapshotForProfile(
    profile: DeliveryProfile,
    snapshot = this.getSnapshot(),
  ): ConversationSnapshot {
    return conversationWireSnapshot(snapshot, profile);
  }

  /**
   * 一个订阅者的快照帧：profile 决定行可见性，能力位决定 `workflowRuns` 发全量还是旧界。
   *
   * 快照与增量必须同一档：一个收着旧界整键 patch 的客户端，如果快照里突然来了 512 个节点，
   * 它的 `.max(256)` 会让**整帧**解析失败（已知键上的解析错误不会只剥掉一个键）。
   */
  private getWireSnapshotForSubscription(subscription: Subscription): ConversationSnapshot {
    const snapshot = pluginInstallSnapshotForConnection(
      this.getWireSnapshotForProfile(subscription.profile),
      subscription.pluginDiscoveryUi,
    );
    if (subscription.workflowRunDeltas || snapshot.workflowRuns === undefined) return snapshot;
    const workflowRuns = clampWorkflowRunsForLegacy(snapshot.workflowRuns);
    return workflowRuns === snapshot.workflowRuns ? snapshot : { ...snapshot, workflowRuns };
  }

  /**
   * 一批 delta 的**每订阅者**编码：profile 过滤 + 旧消费者的整键折叠。
   *
   * 折叠取的是**当前**投影状态，所以恢复回放上历史增量会折成终态——中间态被跳过，终态一致，
   * 与 coalesce 的既有行为同规（conversation-workflow-run-deltas.ts 的文件头）。
   */
  private encodeDeltasForSubscription(
    deltas: readonly ConversationDelta[],
    subscription: Subscription,
  ): readonly ConversationDelta[] {
    const filtered = pluginInstallDeltasForConnection(
      filterConversationDeltasForProfile(deltas, subscription.profile),
      subscription.pluginDiscoveryUi,
    );
    if (subscription.workflowRunDeltas) return filtered;
    return encodeConversationDeltasForLegacy(filtered, this.projection.getSnapshot().workflowRuns);
  }

  /**
   * 输入 admission 的候选 projection：用完整 QueueItem 表达同一份 intent，覆盖文本与附件引用。
   * QueueItem 元数据不小于立即启动后的 user row，因此通过此闸门的输入不会在后续首次
   * snapshot 才变成不可传输。此方法只读，不写 admission / event log。
   */
  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null {
    return measureInputAdmissionBytes(this.getSnapshot(), envelope, admission, (snapshot) =>
      this.measureWireSnapshotBytes(snapshot),
    );
  }

  private measureWireSnapshotBytes(snapshot: ConversationSnapshot): number {
    return measureConversationSnapshotBytes(snapshot, {
      topic: this.topic,
      logEpoch: this.logEpoch,
    });
  }

  /**
   * rows/range（游标制）：取 rowId < beforeRowId 的最后 limit 行
   * （rowId 升序返回）。数据源 = 投影全量行（事件重放/transcript hydration 已灌入），
   * 与订阅流出自同一归约，天然满足「与全量重放前缀逐字节一致」。
   * 只读、无状态、超时重发安全；atLogEpoch 供客户端陈旧读整体丢弃。
   */
  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile: DeliveryProfileName = "replayable",
  ): V4ConversationRowsRangeResult {
    return conversationRowsRange(this.getSnapshot(), params, deliveryProfile);
  }

  getPlans(): V4ConversationPlansResult {
    return conversationPlans(this.getSnapshot());
  }

  /** rowId → 权威 messageId（forkAssistant/editUserQuery 桥接翻译）。 */
  getMessageIdForRow(rowId: number): string | null {
    return this.projection.getMessageIdForRow(rowId);
  }

  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return this.projection.resolveRowActionTarget(target, action);
  }

  /** rowId → 同一 product turn 内所有 transcript messageId。 */
  getMessageIdsForTurnRow(rowId: number): string[] {
    return this.projection.getMessageIdsForTurnRow(rowId);
  }

  /** fork 目标必须是所属轮最后一段 assistantText。 */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    return this.projection.isLatestAssistantSegmentRow(rowId);
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(rowId: number): boolean {
    return this.projection.isLatestRetryAssistantRow(rowId);
  }

  /** latestQueryEditOnly：只有最后一轮 realUser userInput row 可 edit。 */
  isLatestEditableUserRow(rowId: number): boolean {
    return this.projection.isLatestEditableUserRow(rowId);
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  getTurnIdForRow(rowId: number): string | null {
    return this.projection.getTurnIdForRow(rowId);
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段）。 */
  getDroppedContentStreamEventCount(): number {
    return this.projection.getDroppedContentStreamEventCount();
  }

  /** rowId → 其 turn 的 rewind 锚点 messageId（editUserQuery user 行定位）。 */
  getTurnRewindAnchor(rowId: number): string | null {
    return this.projection.getTurnRewindAnchor(rowId);
  }

  private get currentSeq(): number {
    return this.projection.getSnapshot().seq;
  }

  /** 应用权威事件：投影推进 + 日志记账 + 扇出到各订阅者 flush buffer。 */
  ingest(event: SessionEvent): void {
    const applied = applyConversationEvent(
      this.projection,
      event,
      this.wireSnapshotBytesUpperBound,
      (snapshot) => this.measureWireSnapshotBytes(snapshot),
    );
    this.wireSnapshotBytesUpperBound = applied.bytesUpperBound;
    this.appendDeltas(event.sequenceNumber, applied.deltas);
  }

  private appendDeltas(seq: number, deltas: ConversationDelta[]): void {
    this.log.push({ seq, deltas });
    while (this.log.length > this.retention) {
      const evicted = this.log.shift();
      if (evicted) this.floorSeq = evicted.seq;
    }
    if (deltas.length === 0) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.resyncRequired) continue;
      const filtered = this.encodeDeltasForSubscription(deltas, subscription);
      const next = appendConversationSubscriberBuffer(
        subscription.buffer,
        filtered,
        this.subscriberBufferLimits(),
      );
      if (next.kind === "overflow") {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
        continue;
      }
      subscription.buffer = next.deltas;
      subscription.bufferBytes = next.encodedBytes;
    }
  }

  /**
   * 在现有 publisher 内重物化 projection，保留 connection-owned subscriptions。
   *
   * gateway 过去 delete publisher 后新建实例，projection 虽恢复了，旧实例
   * 的 subscription registry / ownership / in-flight reservation 却一起丢失。重物化属于
   * 同一 topic authority 的状态替换，只应让既有订阅 resync，不应换 publisher 身份。
   */
  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    // 重放不能先清空当前 projection/log/subscription delivery，再逐条 replay：
    // 任一普通 reducer 异常都会把 topic 留在半重放状态。候选 publisher 不承接订阅，
    // 完整 replay（含 logical size 校验）成功后才一次 adopt 权威数据面。
    let candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
      now: this.now,
      retention: this.retention,
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    const usedBatchHydration = candidate.tryBatchHydration(events);
    if (!usedBatchHydration) {
      // 保守上界超限不代表权威 projection 一定超限；重新从空候选走原逐事件原子
      // admission，保留 16MiB fail-closed 与“拒绝单个 oversize 后继续终态”的旧语义。
      candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
        now: this.now,
        retention: this.retention,
        subscriberBufferMaxOps: this.subscriberBufferMaxOps,
        subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
      });
      for (const event of events) {
        try {
          candidate.ingest(event);
        } catch (error) {
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          if (!options.onPayloadTooLarge) throw error;
          options.onPayloadTooLarge(error);
        }
      }
    }

    const previous = this.projection.getSnapshot();
    // 同进程订阅 hydration 不能抹掉 durable admission 的启动窗口；新 publisher 冷启动仍为空。
    const pendingCommands = previous.pendingCommands.filter((command) => {
      const snapshot = candidate.getSnapshot();
      return (
        !snapshot.queue.items.some((item) => item.sourceCommandId === command.commandId) &&
        !snapshot.rows.window.some(
          (row) => row.kind === "turnHeader" && row.sourceCommandId === command.commandId,
        )
      );
    });
    if (pendingCommands.length) candidate.setPendingCommands(pendingCommands, previous.seq + 1);
    if (previous.runtimeInitialization) {
      // 首帧已对外发布，最终恢复不得让同一 epoch 的 seq/revision 倒退。
      candidate.projection.setRuntimeInitialization(
        previous.runtimeInitialization,
        previous.seq + 1,
        previous.revision + 1,
      );
    }
    this.projection = candidate.projection;
    const current = this.getSnapshot();
    if (
      previous.runtimeInitialization &&
      previous.rows.window.length === current.rows.window.length &&
      previous.rows.window.every(
        (row, index) =>
          row.rowId === current.rows.window[index]?.rowId &&
          row.kind === current.rows.window[index]?.kind,
      )
    ) {
      // 正常初始化只补控制/摘要，不能用尾窗 snapshot 丢掉用户已分页读出的历史与滚动锚点。
      // 真正改变历史结构（如 compact 修复）仍走既有完整 snapshot 边界。
      const deltas: ConversationDelta[] = [
        { op: "state.updated", patch: statePatchSchema.parse(current) },
      ];
      current.rows.window.forEach((row, index) => {
        // rows.window 的**消费端**类型含 unreadable 占位行（封闭规则 13 的逐行降级）。发送端
        // 自产的快照不可能有它，这里只是把类型窄回 wire 行；真出现了也不能往 wire 上发。
        if (!isWireConversationRow(row)) return;
        if (JSON.stringify(row) !== JSON.stringify(previous.rows.window[index]))
          deltas.push({ op: "row.upserted", row });
      });
      this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
      this.appendDeltas(current.seq, deltas);
      return;
    }

    if (usedBatchHydration || previous.runtimeInitialization) {
      // 批量重放会把派生 actions 延迟到最终 materialization；若允许客户端
      // 用逐事件旧快照的中间 base 续这份日志，batch 从未持有的旧 canEdit/canRetry 无法被
      // 定点撤销。rehydrate 本来就要求所有现有订阅 resync，因此在当前 seq 建立 snapshot
      // recovery boundary；此后新事件仍从该水位正常 resume，不改变 replayable 恢复语义。
      this.log.splice(0, this.log.length);
      this.floorSeq = candidate.currentSeq;
    } else {
      // strict fallback 没有延迟 materialization，完整保留原有 retained-log 恢复语义。
      this.log.splice(0, this.log.length, ...candidate.log);
      this.floorSeq = candidate.floorSeq;
    }
    this.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.sentSeq = 0;
      // adopt 后旧 projection 上预留的帧不可再 commit；失败 replay 从未触碰该 reservation。
      subscription.inFlight = null;
    }
  }

  /**
   * 冷恢复快路径：只修改尚未发布的 candidate。协议 wire snapshot 固定只含末尾 60 行，
   * 因此 row 更新只累计仍在 tail 的 delta，再给尚未 materialize 的 actions 按行预留
   * 完整 schema 上界；已滑出 tail 的保守增长在触及 payload limit 时通过精确测量消除。
   * 最终只做一次全行 actions 收敛，整体成本随事件/行数线性增长。
   */
  private tryBatchHydration(events: readonly SessionEvent[]): boolean {
    const bytes = hydrateConversationCandidate({
      projection: this.projection,
      events,
      initialBytesUpperBound: this.wireSnapshotBytesUpperBound,
      measureWireSnapshot: (snapshot) => this.measureWireSnapshotBytes(snapshot),
    });
    if (bytes === null) return false;
    this.wireSnapshotBytesUpperBound = bytes;
    return true;
  }

  /**
   * 订阅裁决：base.logEpoch 匹配且 base.seq 在保留窗内 → resume，
   * 否则 snapshot。同 connectionId 重订阅 = 替换旧订阅并清其 flush buffer。
   */
  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const result = this.subscribeReserved(params);
    result.reservation?.commit();
    return result;
  }

  /** 生产 gateway 入口：初始帧也必须等 physical batch 全接受才 commit。 */
  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(params.connectionId);
    const previousSubscription =
      previousId === undefined ? undefined : this.subscriptions.get(previousId);
    if (previousId !== undefined) this.subscriptions.delete(previousId);

    const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
    const subscription: Subscription = {
      subscriptionId: `sub-${this.logEpoch}-${this.nextSubscriptionSerial++}`,
      connectionId: params.connectionId,
      profile,
      workflowRunDeltas: params.workflowRunDeltas === true,
      pluginDiscoveryUi: params.pluginDiscoveryUi === true,
      buffer: [],
      bufferBytes: 0,
      resyncRequired: false,
      sentSeq: 0,
      inFlight: null,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    this.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
    const rollback = (): boolean => {
      // initial reservation commit 后 replacement 已 admission，禁止迟到 rollback。
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscription.subscriptionId);
      if (previousId !== undefined && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(params.connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(params.connectionId);
      }
      return true;
    };

    // 同一 seq 可能对应不同卡片投影。能力变化或挂起卡片的 base 来源未知时，用快照校正。
    const sameProjection = previousSubscription
      ? previousSubscription.pluginDiscoveryUi === subscription.pluginDiscoveryUi
      : !this.getSnapshot().pendingInteractions.some((item) => item.kind === "pluginInstall");
    const base = sameProjection ? params.base : undefined;
    const resumable =
      base !== undefined &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "initial",
      );
      return this.subscribeResult(this.ackFor(subscription, "snapshot"), reservation, rollback);
    }

    // resume：保留窗内 (base.seq, current] 重放，与在线续流同一条 filter→编码→coalesce 管线。
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    if (base.seq === this.currentSeq) {
      subscription.sentSeq = base.seq;
      return this.subscribeResult(this.ackFor(subscription, "resume"), null, () => false);
    }
    subscription.sentSeq = base.seq;
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "initial",
    );
    return this.subscribeResult(this.ackFor(subscription, "resume"), reservation, rollback);
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /** Resident 回收判定：仍有任一订阅者时该会话不可被去激活。 */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }

  /**
   * 排空一个订阅者的 flush buffer 打成一帧（宿主按 flushWindowMs 驱动）。
   * 无新内容返回 null；帧区间 (sentSeq, currentSeq] 覆盖中途被过滤掉的 seq，
   * 保证客户端 `frame.fromSeq === store.seq` 的连续性判定不受 profile 过滤影响。
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.resyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      return this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        true,
        "online",
      );
    }
    if (subscription.buffer.length === 0 && subscription.sentSeq === this.currentSeq) {
      return null;
    }
    const deltas = subscription.buffer;
    const frame: ConversationTopicFrame = {
      ...this.frameShell(subscription),
      fromSeq: subscription.sentSeq,
      toSeq: this.currentSeq,
      payload: { kind: "deltas", deltas },
    };
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this.reserveFrame(subscription, frame, false, "online");
  }

  /** 旧单测便利面；生产 gateway 必须 reserve 后在 emit-all 成功才 commit。 */
  flush(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 活跃订阅 same-sub 恢复：客户端 base 是唯一恢复起点，不能拿 sentSeq
   * 猜客户端已应用到哪里。新 recovery admission 会作废旧 reservation；迟到 commit
   * 因 inFlight 身份不再匹配而返回 false。
   */
  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;

    const previous = {
      buffer: subscription.buffer,
      bufferBytes: subscription.bufferBytes,
      resyncRequired: subscription.resyncRequired,
      sentSeq: subscription.sentSeq,
      inFlight: subscription.inFlight,
    };

    // 旧 resync 会先 commit 当前 reservation，再基于服务端 sentSeq 发 snapshot，
    // 这会把客户端未收到的帧误记为已送达。same-sub recovery 必须直接 supersede。
    subscription.inFlight = null;
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    subscription.resyncRequired = false;

    const base = request.base;
    const resumable =
      !request.forceSnapshot &&
      base !== null &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      subscription.sentSeq = 0;
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "recovery",
      );
      return this.subscribeResult(
        this.ackFor(subscription, "snapshot"),
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }

    subscription.sentSeq = base.seq;
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "recovery",
    );
    return this.subscribeResult(
      this.ackFor(subscription, "resume"),
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  private resyncRollback(
    subscription: Subscription,
    reservation: TopicFrameReservation<ConversationTopicFrame>,
    previous: Pick<
      Subscription,
      "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
    >,
  ): () => boolean {
    let rolledBack = false;
    return (): boolean => {
      if (rolledBack) return true;
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      const recoveryBuffer = subscription.buffer;
      const recoveryResyncRequired = subscription.resyncRequired;
      const merged = appendConversationSubscriberBuffer(
        previous.buffer,
        recoveryBuffer,
        this.subscriberBufferLimits(),
      );
      if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
      } else {
        subscription.buffer = merged.deltas;
        subscription.bufferBytes = merged.encodedBytes;
        subscription.resyncRequired = false;
      }
      subscription.sentSeq = previous.sentSeq;
      subscription.inFlight = previous.inFlight;
      rolledBack = true;
      return true;
    };
  }

  private subscriberBufferLimits(): ConversationSubscriberBufferLimits {
    return {
      maxOps: this.subscriberBufferMaxOps,
      maxBytes: this.subscriberBufferMaxBytes,
      snapshotBytesUpperBound: this.wireSnapshotBytesUpperBound,
    };
  }

  /** 溢出降级（05 §两级背压）：清缓冲、回发 snapshot 帧重对齐。 */
  resync(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.resyncReserved(subscriptionId, {
      base: null,
      forceSnapshot: true,
    })?.reservation;
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private reserveFrame(
    subscription: Subscription,
    frame: ConversationTopicFrame,
    snapshotRecovery: boolean,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<ConversationTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<ConversationTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        if (snapshotRecovery) {
          // snapshot 在途时 resyncRequired 会停止收 delta。
          // 若权威水位又推进，下一 reservation 必须再发最新 snapshot。
          subscription.resyncRequired = this.currentSeq > frame.toSeq;
        }
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  private subscribeResult(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<ConversationTopicFrame> | null,
    rollback: () => boolean,
  ): ConversationSubscribeResult {
    return {
      ack,
      reservation,
      rollback,
      // 兼容旧 publisher 单测：读 frame 即表示本地 transport 已接受。
      // 生产 gateway 只读 reservation，不会触发该 getter。
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  private ackFor(subscription: Subscription, mode: SubscribeAck["mode"]): SubscribeAck {
    return {
      subscriptionId: subscription.subscriptionId,
      mode,
      logEpoch: this.logEpoch,
    };
  }

  private frameShell(
    subscription: Subscription,
  ): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
    return {
      topic: this.topic,
      subscriptionId: subscription.subscriptionId,
      sentAt: this.now(),
    };
  }
}

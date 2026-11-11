/* eslint-disable max-lines -- index projection、applied-base 与 recovery flight 必须由同一原子 store 裁决。 */
// sessions-index topic 的 renderer 只读 store：
// snapshot 帧全量替换；delta 帧仅在区间衔接（frame.fromSeq === watermark）时 apply，
// 断档不猜、不缓存补偿——重订阅交由服务端裁决续传或全量（与 ConversationProjectionStore 同策略）。
import {
  isDeterministicContentFault,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { logger } from "@/logger.js";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";

export interface SessionsIndexState {
  /** workspaceId → 已知；null = 尚无 snapshot。 */
  workspaceId: string | null;
  logEpoch: string | null;
  /** 帧区间水位（= 最近一帧 toSeq）。 */
  seq: number;
  /** 会话摘要，按 sessionId 索引（conflated）。 */
  sessions: Map<string, SessionSummary>;
}

export const EMPTY_SESSIONS_INDEX_STATE: SessionsIndexState = {
  workspaceId: null,
  logEpoch: null,
  seq: 0,
  sessions: new Map(),
};

export type SessionsIndexStoreStatus = "idle" | "dormant" | "connecting" | "live" | "error";

const RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS = 100;
const RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS = 5_000;
const RUNTIME_RESTART_BURST_RESET_MS = 30_000;
const TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const ERROR_RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

function isTransientSubscribeError(error: unknown): boolean {
  if (isZCodeFileLockTimeoutError(error)) {
    return true;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (["EBUSY", "EMFILE", "ENFILE"].includes(code)) {
    return true;
  }
  if (code === "EEXIST" && message.includes("config.json.lock")) {
    return true;
  }
  return /\b(?:EBUSY|EMFILE|ENFILE)\b/.test(message) || message.includes("config.json.lock");
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

async function unsubscribeIgnoringFailure(
  transport: SessionsIndexTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    // service proxy 换代后旧 store cleanup 仍会命中已断开的 RPC。
    // cleanup 失败不能变成 unhandled rejection，也不能影响新一代 registry entry。
    logger.warn(
      `[v4-sessions-index] unsubscribe ${subscriptionId} 失败（忽略）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface ApplySessionsIndexResult {
  state: SessionsIndexState;
  /** true = 帧区间断档（fromSeq 与水位不衔接），调用方应重订阅。 */
  gap: boolean;
}

/** 纯 apply：snapshot 全量替换；deltas 仅在衔接时逐条 upsert/remove。 */
export function applySessionsIndexFrame(
  current: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): ApplySessionsIndexResult {
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot;
    const sessions = new Map<string, SessionSummary>();
    for (const session of snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return {
      gap: false,
      state: {
        workspaceId: snapshot.workspaceId,
        logEpoch: snapshot.logEpoch,
        seq: frame.toSeq,
        sessions,
      },
    };
  }
  if (frame.toSeq <= current.seq) {
    return { state: current, gap: false };
  }
  // deltas：区间必须衔接（fromSeq === 当前水位），否则断档。
  if (frame.fromSeq !== current.seq) {
    return { state: current, gap: true };
  }
  const sessions = new Map(current.sessions);
  for (const delta of frame.payload.deltas) {
    if (delta.op === "session.upserted") {
      sessions.set(delta.session.sessionId, delta.session);
    } else {
      sessions.delete(delta.sessionId);
    }
  }
  return {
    gap: false,
    state: { ...current, seq: frame.toSeq, sessions },
  };
}

/**
 * useSyncExternalStore 兼容的只读 store：subscribe + getState 返回稳定引用。
 * 状态本体与纯 applyFrame 可独立单测；传输绑定（connect/handleFrame/close）
 * 负责订阅生命周期与断档重订阅。
 */
export class SessionsIndexStore {
  private state: SessionsIndexState = EMPTY_SESSIONS_INDEX_STATE;
  private readonly listeners = new Set<() => void>();
  /** 缓存的有序列表（getSessions 稳定引用，避免每次 new array 触发重渲染）。 */
  private cachedList: SessionSummary[] | null = null;
  // 传输绑定（可选：纯 applyFrame 单测不需要）。
  private transport: SessionsIndexTransport | null = null;
  private frameUnsub: (() => void) | null = null;
  private faultUnsub: (() => void) | null = null;
  private restartUnsub: (() => void) | null = null;
  private lifecycleUnsub: (() => void) | null = null;
  private subscriptionId: string | null = null;
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /** 本次 flight 是为内容确定性失败发起的：终态用 contentRejected，且不再无限退避重订阅。 */
    contentFault: boolean;
  } | null = null;
  private status: SessionsIndexStoreStatus = "idle";
  private generation = 0;
  private closed = false;
  private runtimeRestartReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRestartBurstCount = 0;
  private lastRuntimeRestartAt = 0;
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryAttempt = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionsIndexState => this.state;

  getStatus(): SessionsIndexStoreStatus {
    return this.status;
  }

  /**
   * 绑定传输并发起订阅：注册帧监听 + subscribe（水位不变量：仅当真持有一致状态才带 base）。
   * 断档帧 → 丢 base 重订阅（handleFrame 触发）。close 后可再次 connect（React
   * effect 卸载/重挂载——StrictMode 双调——走同一路径复活）。
   */
  async connect(
    transport: SessionsIndexTransport,
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      subscribeRetryAttempt?: number;
      errorRecoveryRetryAttempt?: number;
    } = {},
  ): Promise<void> {
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.clearSubscribeRetry();
    if (options.errorRecoveryRetryAttempt === undefined) {
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
    }
    this.closed = false;
    this.transport = transport;
    if (!this.frameUnsub) {
      this.frameUnsub = transport.onFrame((frame, context) => this.handleFrame(frame, context));
      this.faultUnsub = transport.onAssemblyFault((fault) => {
        if (fault.subscriptionId === this.subscriptionId) {
          this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
        }
      });
      if (transport.onRuntimeLifecycle) {
        this.lifecycleUnsub = transport.onRuntimeLifecycle((state) => {
          if (state === "available") this.handleRuntimeAvailable();
          else this.handleRuntimeUnavailable();
        });
      } else {
        this.restartUnsub = transport.onRuntimeRestart(() => this.handleRuntimeRestart());
      }
    }
    const generation = ++this.generation;
    this.discardRecovery();
    this.status = "connecting";
    this.emit();
    const base =
      options.forceSnapshot || this.state.logEpoch === null
        ? undefined
        : { logEpoch: this.state.logEpoch, seq: this.state.seq };
    try {
      const result = await transport.subscribe(base ? { base } : {});
      if (generation !== this.generation || this.closed) {
        void unsubscribeIgnoringFailure(transport, result.ack.subscriptionId);
        return;
      }
      // 与 conversationProjectionStore.connect 同因（线上 notOwned 卡死）：
      // subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery，而 host scope 在
      // 新 ACK remember() 时已静默驱逐旧 ownership。换代成功即丢弃旧 recovery，避免其
      // 迟到失败把 live 的新订阅打成 error。
      this.discardRecovery();
      this.subscriptionId = result.ack.subscriptionId;
      this.status = "live";
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
      this.subscriptionHasAppliedBase = Boolean(
        base && result.ack.mode === "resume" && result.ack.logEpoch === base.logEpoch,
      );
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      // initial 只经 notification 到达；先绑定代际，再 activate 释放 ACK 前早帧。
      transport.activate(result.ack.subscriptionId);
      this.emit();
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (isRuntimeUnavailableError(error)) {
        // restored workspace 的被动列表订阅曾把 runtime 缺失当成普通失败并
        // 退避重试，最终由 getClient 批量启动 CLI。dormant 等待 lifecycle，不设 timer。
        this.handleRuntimeUnavailable();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        await this.connect(transport, {
          forceSnapshot: true,
          initialOverflowRetry: true,
          ...(options.errorRecoveryRetryAttempt !== undefined
            ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
            : {}),
        });
        return;
      }
      const retryAttempt = options.subscribeRetryAttempt ?? 0;
      const retryDelay = TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS[retryAttempt];
      if (isTransientSubscribeError(error) && retryDelay !== undefined) {
        // Host 冷启动时 provider registry 的配置锁可能短暂冲突。若把
        // 首次 subscribe 失败永久定格为 error，聚合层随即发布空列表并显示“还没有对话”。
        // 瞬时文件锁错误保持 hydrating，用有界退避重订阅；已有 snapshot 也继续保留。
        this.status = "connecting";
        logger.warn(`[v4-sessions-index] subscribe 瞬时失败，${retryDelay}ms 后重试: ${message}`);
        this.subscribeRetryTimer = setTimeout(() => {
          this.subscribeRetryTimer = null;
          if (this.closed || generation !== this.generation) return;
          void this.connect(transport, {
            ...(options.forceSnapshot ? { forceSnapshot: true } : {}),
            subscribeRetryAttempt: retryAttempt + 1,
            ...(options.errorRecoveryRetryAttempt !== undefined
              ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
              : {}),
          });
        }, retryDelay);
        this.emit();
        return;
      }
      this.failAndScheduleRecovery(`subscribe:${message}`);
    }
  }

  /**
   * 远程 RPC proxy 换代时原地替换 transport。
   *
   * 先同步解除旧 transport 的本地监听，再对新 transport 强制取 snapshot；远端退订只做
   * best-effort，不能阻塞新 proxy 接管。服务端按 subscriptionId 精确退订，迟到 cleanup
   * 不会删除新代际。并发换代由 store generation 失效旧结果，store 身份和最后一份投影保持不变。
   */
  async replaceTransport(transport: SessionsIndexTransport): Promise<void> {
    if (!this.closed && this.transport === transport) return;

    const generation = ++this.generation;
    const previous = this.detachTransport();
    this.status = "connecting";
    this.emit();

    if (previous.transport && previous.subscriptionId) {
      // proxy handoff 后旧 RPC 可能永远不 settle；等待它会让新 transport
      // 永久停在 connecting。先完成本地 detach，远端精确退订异步收尾即可。
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
    if (generation !== this.generation || this.closed) return;

    await this.connect(transport, { forceSnapshot: true });
  }

  /** 帧路由入口（initial / online notification）。断档 → 重订阅。 */
  handleFrame(
    frame: SessionsIndexTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际闸门：workspace 级 fan-out 会把同 topic 其他订阅者的帧也送到这里
    // （host 侧 task-index syncer 用独立 connectionId 常驻订阅 sessions-index）。
    // 不按自己的 subscriptionId 过滤会把别人的 (fromSeq, toSeq] 窗口当成断档，触发重订阅风暴。
    // subscriptionId 尚未就位时的 own initial 由 transport 有界 staging；绑定后 activate
    // 才释放。其他旧代际/foreign frame 在这里继续丢弃。
    if (this.subscriptionId === null || frame.subscriptionId !== this.subscriptionId) {
      return;
    }
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      const gap = this.applyFrame(frame);
      if (!gap) this.subscriptionHasAppliedBase = true;
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      if (frame.toSeq > this.state.seq) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    const gap = this.applyFrame(frame);
    if (gap && this.transport) {
      logger.warn(
        `[v4-sessions-index] 帧断档 fromSeq=${frame.fromSeq} local=${this.state.seq}，重订阅`,
      );
      if (initial) void this.connect(this.transport, { forceSnapshot: true });
      else this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.subscriptionHasAppliedBase = true;
    if (deliveryKind === "recovery") this.markRecoveryFrameSeen();
  }

  private handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (subscriptionId !== this.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 内容确定性失败不进瞬态阶梯（04-sync 封闭规则 11）：resume 只会重投同一批被拒的内容。
    // 直接跳到唯一可能产出不同字节的强制 snapshot；它再被内容拒绝就停手。本 store 的 fail
    // closed 会清空投影并有界退避重订阅——对确定性失败那就是一个永不收敛的重订阅循环。
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null),
    );
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    const transport = this.transport;
    const subscriptionId = this.subscriptionId;
    if (this.closed || !transport || !subscriptionId) return;
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // 一旦本次 flight 出现过内容失败，终态就归内容失败：后续瞬态 fault 不该把它洗白。
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null as "snapshot" | "resume" | null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // 内容失败跳过 resume 档直接强制 snapshot；瞬态失败仍按原阶梯先试 resume。
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<SessionsIndexStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    const transport = this.transport;
    if (!transport) return;
    this.clearRecoveryDeadline(recovery);
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.validFrameSeen = false;
    recovery.upgradePending = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          !this.subscriptionHasAppliedBase || this.state.logEpoch === null
            ? null
            : { logEpoch: this.state.logEpoch, seq: this.state.seq },
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-sessions-index] resync 失败: ${message}`);
        if (isRuntimeUnavailableError(error)) {
          this.handleRuntimeUnavailable();
          return;
        }
        if (message.includes("fault.subscription.notOwned") && this.transport) {
          // 与 conversationProjectionStore.issueRecovery 同因（线上事件）：
          // notOwned 是 ownership 状态分歧的确定性失效而非瞬态故障，停在 error 会让
          // 会话列表永久卡死。携当前水位 fresh subscribe 由服务端裁决 resume/snapshot，
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect(this.transport);
          return;
        }
        this.failAndScheduleRecovery(`resync:${message}`);
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) this.issueRecovery(recovery, false);
      else this.recovery = null;
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  private clearSubscribeRetry(): void {
    if (!this.subscribeRetryTimer) return;
    clearTimeout(this.subscribeRetryTimer);
    this.subscribeRetryTimer = null;
  }

  private clearErrorRecoveryRetry(): void {
    if (!this.errorRecoveryRetryTimer) return;
    clearTimeout(this.errorRecoveryRetryTimer);
    this.errorRecoveryRetryTimer = null;
  }

  /**
   * 内容确定性失败：终态 code 与传输失败区分，且**不排退避重订阅**——重订阅会拿到同一份读不懂的
   * 内容，本 store 的退避会因此变成永不收敛的循环（清空投影 → 重订阅 → 再被拒 → …）。自愈仍有
   * 路径：runtime 换代、fresh connect、用户重连都会重新订阅；被拿掉的只是那个循环。
   *
   * `contentEligible: false` 给**超时**终态用：deadline 没等到 recovery 帧是传输症状，不该被重标
   * 成 contentRejected，更不该因此取消那次仍然有意义的重试。
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    // contentFault 必须在 discardRecovery 之前读。
    const contentFault = this.recovery?.contentFault === true && options.contentEligible !== false;
    this.failAndScheduleRecovery(contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode, {
      scheduleRetry: !contentFault,
    });
  }

  /**
   * recovery/subscribe 失败时撤销旧 projection 的 live 证明，并用有界退避重新取权威
   * snapshot。error 仍对外可观测；重试仅在 transport/runtime 仍属于当前代际时执行。
   *
   * `scheduleRetry: false` 只给确定性失败用：重试必然得到同一结果时不该排它。
   */
  private failAndScheduleRecovery(
    reasonCode: string,
    options: { scheduleRetry?: boolean } = {},
  ): void {
    const transport = this.transport;
    const previousSubscriptionId = this.subscriptionId;
    this.discardRecovery();
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "error";
    // 同 conversationProjectionStore：原 logger.warn 在生产构建下 no-op。这里的终态还会把
    // 整个任务列表清空成 EMPTY_SESSIONS_INDEX_STATE，影响面比单个会话更大，更需要在打包版留痕。
    logger.lifecycle.warn("v4 sessions index recovery fail-closed", {
      event: "v4.sessions_index.recovery.fail_closed",
      module: "ui.v4.sessions_index_store",
      reasonCode,
      scheduleRetry: options.scheduleRetry !== false,
      status: "error",
    });
    if (transport && previousSubscriptionId) {
      void unsubscribeIgnoringFailure(transport, previousSubscriptionId);
    }
    this.clearErrorRecoveryRetry();
    if (transport && !this.closed && options.scheduleRetry !== false) {
      const attempt = this.errorRecoveryRetryAttempt;
      const delayMs =
        ERROR_RECOVERY_RETRY_DELAYS_MS[
          Math.min(attempt, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1)
        ];
      const nextAttempt = Math.min(attempt + 1, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1);
      const generation = this.generation;
      this.errorRecoveryRetryAttempt = nextAttempt;
      this.errorRecoveryRetryTimer = setTimeout(() => {
        this.errorRecoveryRetryTimer = null;
        if (this.closed || this.transport !== transport || this.generation !== generation) {
          return;
        }
        void this.connect(transport, {
          forceSnapshot: true,
          errorRecoveryRetryAttempt: nextAttempt,
        });
      }, delayMs);
    }
    this.emit();
  }

  private handleRuntimeRestart(): void {
    if (this.closed || !this.transport) return;
    const transport = this.transport;
    const now = Date.now();
    if (now - this.lastRuntimeRestartAt >= RUNTIME_RESTART_BURST_RESET_MS) {
      this.runtimeRestartBurstCount = 0;
    }
    this.lastRuntimeRestartAt = now;
    const delayMs =
      this.runtimeRestartBurstCount === 0
        ? 0
        : Math.min(
            RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS *
              2 ** Math.min(this.runtimeRestartBurstCount - 1, 16),
            RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS,
          );
    this.runtimeRestartBurstCount += 1;
    this.generation += 1;
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    if (this.status !== "connecting") {
      this.status = "connecting";
      this.emit();
    }
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
    }
    // runtimeRestarted 不能每到一条就立即 connect。若上游异常地连续发布
    // restart，subscribe 会反向触发更多 runtime 启动，形成无上限重连风暴。这里将 burst
    // 合并为一次 fresh subscribe，并按连续次数指数退避；稳定 30 秒后恢复首跳立即重连。
    this.runtimeRestartReconnectTimer = setTimeout(() => {
      this.runtimeRestartReconnectTimer = null;
      if (this.closed || this.transport !== transport) return;
      void this.connect(transport, { forceSnapshot: true });
    }, delayMs);
  }

  private handleRuntimeAvailable(): void {
    if (this.closed || !this.transport) return;
    this.handleRuntimeRestart();
  }

  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.generation += 1;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    // runtime 已不存在时旧 summary 的 running/attention 失去 live 证明；持久 task 行由
    // tasks-index 保留，sessions-index 投影必须清空以避免孤儿 spinner。
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "dormant";
    this.emit();
  }

  /** 释放订阅与监听（组件卸载 / workspace 切换）。 */
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.status = "idle";
    const previous = this.detachTransport();
    if (previous.subscriptionId && previous.transport) {
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
  }

  private detachTransport(): {
    transport: SessionsIndexTransport | null;
    subscriptionId: string | null;
  } {
    const previous = {
      transport: this.transport,
      subscriptionId: this.subscriptionId,
    };
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.runtimeRestartBurstCount = 0;
    this.lastRuntimeRestartAt = 0;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.frameUnsub?.();
    this.frameUnsub = null;
    this.faultUnsub?.();
    this.faultUnsub = null;
    this.restartUnsub?.();
    this.restartUnsub = null;
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.transport = null;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    return previous;
  }

  /** 应用一帧；断档返回 true（调用方重订阅）。 */
  applyFrame(frame: SessionsIndexTopicFrame): boolean {
    const { state, gap } = applySessionsIndexFrame(this.state, frame);
    if (gap) return true;
    if (state !== this.state) {
      this.state = state;
      this.cachedList = null;
      this.emit();
    }
    return false;
  }

  /** 断档/重连时清空，等待新 snapshot。 */
  reset(): void {
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.emit();
  }

  /** 会话列表（默认按 lastActivityAt 降序；分组/pin 是更上层逻辑）。 */
  getSessions(): SessionSummary[] {
    if (this.cachedList === null) {
      this.cachedList = [...this.state.sessions.values()].sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt,
      );
    }
    return this.cachedList;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

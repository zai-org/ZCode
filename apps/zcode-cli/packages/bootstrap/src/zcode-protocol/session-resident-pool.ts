// CLI session 常驻池。
//
// 这是容量与生命周期控制器，不拥有 session 内容。宿主提供当前 resident registry、同步
// 安全事实和去激活执行面；pool 只维护 idle TTL、LRU touch、operation lease 与
// deactivation gate。

export const DEFAULT_SESSION_RESIDENT_TARGET_COUNT = 8;
export const DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT = 16;
export const DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

export type SessionDeactivationReason = "high_water_lru" | "idle_timeout";

export interface SessionDeactivationDecision {
  highWaterCount: number;
  idleMs: number;
  idleTimeoutMs: number;
  reason: SessionDeactivationReason;
  residentCountBefore: number;
  targetCount: number;
}

export interface SessionResidencyFacts {
  persisted: boolean;
  hasResidencyBlockingWork: boolean;
  hasPendingInteractions: boolean;
  hasQueuedCommands: boolean;
  hasSubscribers: boolean;
  hasLegacySubscriber: boolean;
  lastActivityAt: number;
}

export interface SessionResidentPoolHost {
  listSessionIds(): string[];
  onOperationsReleased?(sessionId: string): void;
  readResidencyFacts(sessionId: string): SessionResidencyFacts | null;
  /**
   * 首个同步执行片必须把 session 从 resident registry 摘除；返回 Promise 只等待
   * app.close 等异步收尾。
   */
  deactivate(sessionId: string): Promise<void>;
  onDeactivated?(sessionId: string, decision: SessionDeactivationDecision): void;
  onError?(sessionId: string, error: unknown, decision: SessionDeactivationDecision): void;
}

export interface SessionResidentPoolOptions {
  highWaterCount?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  targetCount?: number;
}

interface ResidencyCandidate {
  eligibleSinceAt: number;
  lastUsedAt: number;
  sessionId: string;
}

export class SessionResidentPool {
  private readonly highWaterCount: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly targetCount: number;
  private readonly eligibleSinceAt = new Map<string, number>();
  private readonly lastTouchedAt = new Map<string, number>();
  private readonly operationLeaseCounts = new Map<string, number>();
  private readonly inFlightDeactivations = new Map<string, Promise<void>>();
  private activeOperationCount = 0;
  private rebalancing = false;

  constructor(
    private readonly host: SessionResidentPoolHost,
    options: SessionResidentPoolOptions = {},
  ) {
    const targetCount = options.targetCount ?? DEFAULT_SESSION_RESIDENT_TARGET_COUNT;
    const highWaterCount = options.highWaterCount ?? DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS;
    if (!Number.isInteger(targetCount) || targetCount < 0) {
      throw new RangeError("session resident targetCount must be a non-negative integer");
    }
    if (!Number.isInteger(highWaterCount) || highWaterCount < targetCount) {
      throw new RangeError(
        "session resident highWaterCount must be an integer greater than or equal to targetCount",
      );
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new RangeError("session resident idleTimeoutMs must be a non-negative number");
    }
    this.targetCount = targetCount;
    this.highWaterCount = highWaterCount;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * 获取协议请求租约。全进程计数防跨 session 的 async workspace 操作与 sampler
   * 回收并发；按 session 计数表达精确所有权并参与该 session 的 eligibility。
   */
  async acquireOperation(sessionIdsInput?: string | readonly string[]): Promise<() => void> {
    const sessionIds = [
      ...new Set(
        (typeof sessionIdsInput === "string" ? [sessionIdsInput] : (sessionIdsInput ?? [])).filter(
          (sessionId) => sessionId.length > 0,
        ),
      ),
    ];
    this.activeOperationCount += 1;
    for (const sessionId of sessionIds) {
      this.operationLeaseCounts.set(sessionId, (this.operationLeaseCounts.get(sessionId) ?? 0) + 1);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const sessionId of sessionIds) {
        this.touch(sessionId);
        const next = (this.operationLeaseCounts.get(sessionId) ?? 1) - 1;
        if (next <= 0) {
          this.operationLeaseCounts.delete(sessionId);
          this.host.onOperationsReleased?.(sessionId);
        }
        else this.operationLeaseCounts.set(sessionId, next);
      }
      this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
      this.rebalance();
    };

    try {
      for (const sessionId of sessionIds) {
        await this.waitForDeactivation(sessionId);
        this.touch(sessionId);
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  touch(sessionId: string, usedAt = this.now()): void {
    if (!Number.isFinite(usedAt)) return;
    const previous = this.lastTouchedAt.get(sessionId);
    if (previous === undefined || usedAt > previous) {
      this.lastTouchedAt.set(sessionId, usedAt);
    }
    // idle TTL 表达“最后一次使用后的连续空闲”，协议请求重新使用 session
    // 后必须重新计时，不能沿用 touch 前已经接近到期的 eligible 窗口。
    this.eligibleSinceAt.delete(sessionId);
  }

  /** sampler 与 request-release 共用的 TTL / 高低水位收敛入口。 */
  rebalance(): void {
    if (this.activeOperationCount > 0 || this.rebalancing) return;
    this.rebalancing = true;
    try {
      const observedAt = this.now();
      const initialResidentIds = this.host.listSessionIds();
      this.pruneMetadata(new Set(initialResidentIds));
      const initialCandidates = this.readCandidates(initialResidentIds, observedAt);
      const expiredCandidates = initialCandidates
        .filter((candidate) => observedAt - candidate.eligibleSinceAt >= this.idleTimeoutMs)
        .sort(
          (left, right) =>
            left.eligibleSinceAt - right.eligibleSinceAt ||
            left.lastUsedAt - right.lastUsedAt ||
            left.sessionId.localeCompare(right.sessionId),
        );

      let residentCount = initialResidentIds.length;
      for (const candidate of expiredCandidates) {
        if (this.activeOperationCount > 0) break;
        // 候选收集后可能重新订阅或启动后台任务，TTL 到期也不能绕过
        // fresh facts 与 eligibleSince 二次校验。
        const freshFacts = this.host.readResidencyFacts(candidate.sessionId);
        if (!freshFacts || !this.isEligible(candidate.sessionId, freshFacts)) {
          this.eligibleSinceAt.delete(candidate.sessionId);
          continue;
        }
        const eligibleSinceAt = this.eligibleSinceAt.get(candidate.sessionId);
        if (eligibleSinceAt === undefined || observedAt - eligibleSinceAt < this.idleTimeoutMs) {
          continue;
        }
        const decision = this.createDecision(
          "idle_timeout",
          residentCount,
          observedAt - eligibleSinceAt,
        );
        if (this.executeDeactivation(candidate.sessionId, decision)) {
          residentCount -= 1;
        }
      }

      const remainingResidentIds = this.host.listSessionIds();
      residentCount = remainingResidentIds.length;
      if (residentCount <= this.highWaterCount) return;

      const highWaterCandidates = this.readCandidates(remainingResidentIds, observedAt).sort(
        (left, right) =>
          left.lastUsedAt - right.lastUsedAt || left.sessionId.localeCompare(right.sessionId),
      );

      for (const candidate of highWaterCandidates) {
        if (residentCount <= this.targetCount || this.activeOperationCount > 0) break;
        // 候选收集与执行之间可能有订阅/后台任务等新事实。执行前必须重读，
        // 不能让过期 LRU 快照取消仍在运行的 session。
        const freshFacts = this.host.readResidencyFacts(candidate.sessionId);
        if (!freshFacts || !this.isEligible(candidate.sessionId, freshFacts)) {
          this.eligibleSinceAt.delete(candidate.sessionId);
          continue;
        }
        const eligibleSinceAt = this.eligibleSinceAt.get(candidate.sessionId) ?? observedAt;
        const decision = this.createDecision(
          "high_water_lru",
          residentCount,
          observedAt - eligibleSinceAt,
        );
        if (this.executeDeactivation(candidate.sessionId, decision)) {
          residentCount -= 1;
        }
      }
    } finally {
      this.rebalancing = false;
    }
  }

  waitForDeactivation(sessionId: string): Promise<void> {
    return this.inFlightDeactivations.get(sessionId) ?? Promise.resolve();
  }

  operationCount(sessionId: string): number {
    return this.operationLeaseCounts.get(sessionId) ?? 0;
  }

  private isEligible(sessionId: string, facts: SessionResidencyFacts): boolean {
    return (
      facts.persisted &&
      !facts.hasResidencyBlockingWork &&
      !facts.hasPendingInteractions &&
      !facts.hasQueuedCommands &&
      !facts.hasSubscribers &&
      !facts.hasLegacySubscriber &&
      (this.operationLeaseCounts.get(sessionId) ?? 0) === 0 &&
      !this.inFlightDeactivations.has(sessionId)
    );
  }

  private readCandidates(sessionIds: readonly string[], observedAt: number): ResidencyCandidate[] {
    const candidates: ResidencyCandidate[] = [];
    for (const sessionId of sessionIds) {
      const facts = this.host.readResidencyFacts(sessionId);
      if (!facts || !this.isEligible(sessionId, facts)) {
        this.eligibleSinceAt.delete(sessionId);
        continue;
      }
      let eligibleSinceAt = this.eligibleSinceAt.get(sessionId);
      if (eligibleSinceAt === undefined) {
        eligibleSinceAt = observedAt;
        this.eligibleSinceAt.set(sessionId, eligibleSinceAt);
      }
      candidates.push({
        eligibleSinceAt,
        lastUsedAt: Math.max(
          facts.lastActivityAt,
          this.lastTouchedAt.get(sessionId) ?? Number.NEGATIVE_INFINITY,
        ),
        sessionId,
      });
    }
    return candidates;
  }

  private createDecision(
    reason: SessionDeactivationReason,
    residentCountBefore: number,
    idleMs: number,
  ): SessionDeactivationDecision {
    return {
      highWaterCount: this.highWaterCount,
      idleMs: Math.max(0, idleMs),
      idleTimeoutMs: this.idleTimeoutMs,
      reason,
      residentCountBefore,
      targetCount: this.targetCount,
    };
  }

  private executeDeactivation(sessionId: string, decision: SessionDeactivationDecision): boolean {
    let pending: Promise<void>;
    try {
      pending = this.host.deactivate(sessionId);
    } catch (error) {
      this.host.onError?.(sessionId, error, decision);
      return false;
    }

    const tracked = pending
      .then(() => this.host.onDeactivated?.(sessionId, decision))
      .catch((error: unknown) => this.host.onError?.(sessionId, error, decision))
      .finally(() => {
        if (this.inFlightDeactivations.get(sessionId) === tracked) {
          this.inFlightDeactivations.delete(sessionId);
        }
      });
    this.inFlightDeactivations.set(sessionId, tracked);
    this.eligibleSinceAt.delete(sessionId);
    this.lastTouchedAt.delete(sessionId);
    return true;
  }

  private pruneMetadata(residentIds: ReadonlySet<string>): void {
    for (const sessionId of this.lastTouchedAt.keys()) {
      if (
        !residentIds.has(sessionId) &&
        !this.inFlightDeactivations.has(sessionId) &&
        !this.operationLeaseCounts.has(sessionId)
      ) {
        this.lastTouchedAt.delete(sessionId);
      }
    }
    for (const sessionId of this.eligibleSinceAt.keys()) {
      if (!residentIds.has(sessionId) && !this.inFlightDeactivations.has(sessionId)) {
        this.eligibleSinceAt.delete(sessionId);
      }
    }
  }
}

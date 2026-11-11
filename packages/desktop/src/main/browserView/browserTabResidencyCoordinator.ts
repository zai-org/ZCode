import {
  BROWSER_TAB_LIMIT,
  selectBrowserTabLimitVictim,
  type BrowserTabResidencyCandidate,
} from "./browserTabResidencyPolicy.js";

export interface BrowserTabResidencyRecord extends BrowserTabResidencyCandidate {
  generation: number;
}

interface BrowserTabResidencyCoordinatorOptions {
  tabLimit?: number;
  now?: () => number;
  onEvict(record: BrowserTabResidencyRecord): Promise<boolean>;
}

/**
 * 每个 main 进程实例协调所有 BrowserWindow，但逻辑 tab 上限与 victim 选择都按 window 隔离。
 * BrowserGuestManager 仍拥有 guest/CDP；本类只维护正交 residency 状态与串行关闭事务。
 */
export class BrowserTabResidencyCoordinator {
  private readonly records = new Map<string, BrowserTabResidencyRecord>();
  private readonly pendingWindows = new Set<number>();
  private evaluation: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: BrowserTabResidencyCoordinatorOptions) {}

  upsert(candidate: BrowserTabResidencyCandidate): BrowserTabResidencyRecord {
    const existing = this.records.get(candidate.tabId);
    const record: BrowserTabResidencyRecord = {
      ...candidate,
      generation: existing?.generation ?? 0,
    };
    this.records.set(candidate.tabId, record);
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  get(tabId: string): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    return record ? { ...record } : null;
  }

  list(): BrowserTabResidencyRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  report(
    tabId: string,
    patch: Partial<
      Pick<
        BrowserTabResidencyRecord,
        | "currentTask"
        | "selected"
        | "visible"
        | "loading"
        | "operationActive"
        | "captureActive"
        | "audible"
        | "mediaActive"
        | "downloadActive"
      >
    >,
  ): void {
    const record = this.records.get(tabId);
    if (!record) return;
    const now = this.now();
    const runtimeActivityStarted = (
      [
        "operationActive",
        "captureActive",
        "audible",
        "mediaActive",
        "loading",
        "downloadActive",
      ] as const
    ).some((key) => patch[key] === true && record[key] !== true);
    Object.assign(record, patch);
    if (patch.selected === true) {
      for (const candidate of this.records.values()) {
        if (
          candidate.tabId !== record.tabId &&
          candidate.windowId === record.windowId &&
          candidate.sessionId === record.sessionId
        ) {
          candidate.preferred = false;
        }
      }
      record.preferred = true;
      record.lastSelectedAt = now;
      record.lastActivityAt = now;
    }
    if (patch.visible === true) record.lastActivityAt = now;
    if (runtimeActivityStarted) record.lastActivityAt = now;

    const protectedDuringSuspend =
      record.residency === "suspend-pending" &&
      (record.selected ||
        record.visible ||
        record.loading ||
        record.operationActive ||
        record.captureActive ||
        record.audible ||
        record.mediaActive ||
        record.downloadActive);
    if (protectedDuringSuspend) {
      // 迟到 suspend ack 只能命中旧 generation；保护状态出现后立即取消本轮淘汰。
      record.generation += 1;
      record.residency = record.visible ? "live-visible" : "live-background";
    }
    if (
      record.residency !== "suspended" &&
      record.residency !== "restoring" &&
      record.residency !== "suspend-pending"
    ) {
      record.residency = record.visible ? "live-visible" : "live-background";
    }
    this.requestEvaluation(record.windowId);
  }

  markRestoring(tabId: string): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (!record) return null;
    if (record.residency !== "suspended") return { ...record };
    record.generation += 1;
    record.residency = "restoring";
    record.loading = true;
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  completeRestore(tabId: string, generation: number): boolean {
    const record = this.records.get(tabId);
    if (!record || record.generation !== generation || record.residency !== "restoring") {
      return false;
    }
    record.loading = false;
    record.residency = record.visible ? "live-visible" : "live-background";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return true;
  }

  failRestore(tabId: string, generation: number): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (!record || record.generation !== generation || record.residency !== "restoring") {
      return null;
    }
    // attach timeout/恢复取消原来没有失败终态，tab 会永久停在 restoring，
    // 且同 generation 的迟到 guest 仍能 attach。推进 generation 后回到 suspended，
    // 下一次访问才能安全重发恢复事务。
    record.generation += 1;
    record.loading = false;
    record.residency = "suspended";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  commitCancelledSuspend(
    tabId: string,
    cancelledGeneration: number,
  ): BrowserTabResidencyRecord | null {
    const record = this.records.get(tabId);
    if (
      !record ||
      record.generation <= cancelledGeneration ||
      (record.residency !== "live-visible" && record.residency !== "live-background")
    ) {
      return null;
    }
    // renderer 已收到旧 suspend 后，main 仅拒绝 stale ack 会造成两端分裂。
    // 此处提交 renderer 已卸载的物理事实，随后 manager 再用新 generation 完整恢复。
    record.loading = false;
    record.residency = "suspended";
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return { ...record };
  }

  markAttached(tabId: string, visible: boolean, generation?: number): boolean {
    const record = this.records.get(tabId);
    if (!record) return false;
    if (
      record.residency === "restoring" &&
      (generation === undefined || generation !== record.generation)
    ) {
      return false;
    }
    record.guestAttached = true;
    record.visible = visible;
    if (record.residency !== "restoring") {
      record.residency = visible ? "live-visible" : "live-background";
    }
    record.lastActivityAt = this.now();
    this.requestEvaluation(record.windowId);
    return true;
  }

  markDetached(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    // guest destroyed/detach 后 logical residency 仍可能暂时是 live-background。
    // 单独清除物理事实；logical shell 仍计入 32 个上限，也允许在没有 guest 时被完整关闭。
    record.guestAttached = false;
    this.requestEvaluation(record.windowId);
  }

  isTransitionCurrent(
    tabId: string,
    generation: number,
    residency: BrowserTabResidencyRecord["residency"],
  ): boolean {
    const record = this.records.get(tabId);
    return Boolean(record && record.generation === generation && record.residency === residency);
  }

  rekeySession(tabId: string, sessionId: string): void {
    const record = this.records.get(tabId);
    if (!record || record.sessionId === sessionId) return;
    this.records.set(tabId, { ...record, sessionId });
    this.requestEvaluation(record.windowId);
  }

  remove(tabId: string): void {
    const record = this.records.get(tabId);
    if (!record) return;
    this.records.delete(tabId);
    this.requestEvaluation(record.windowId);
  }

  async whenIdle(): Promise<void> {
    await this.evaluation;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingWindows.clear();
    this.records.clear();
  }

  private requestEvaluation(windowId: number): void {
    if (this.disposed) return;
    this.pendingWindows.add(windowId);
    if (this.evaluation) return;
    this.evaluation = Promise.resolve()
      .then(() => this.evaluatePendingWindows())
      .finally(() => {
        this.evaluation = null;
        if (this.pendingWindows.size > 0) {
          const nextWindowId = this.pendingWindows.values().next().value as number | undefined;
          if (nextWindowId !== undefined) this.requestEvaluation(nextWindowId);
        }
      });
  }

  private async evaluatePendingWindows(): Promise<void> {
    while (!this.disposed && this.pendingWindows.size > 0) {
      const windowId = this.pendingWindows.values().next().value as number;
      this.pendingWindows.delete(windowId);
      while (!this.disposed) {
        const victim = selectBrowserTabLimitVictim([...this.records.values()], {
          windowId,
          tabLimit: this.options.tabLimit ?? BROWSER_TAB_LIMIT,
        });
        if (!victim) break;
        const record = this.records.get(victim.tabId);
        if (!record) continue;
        const evicted = await this.options.onEvict({ ...record });
        if (!evicted) break;
        // manager 的 durable close 会先移除本记录；纯协调器调用方则由这里收口。
        this.remove(record.tabId);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

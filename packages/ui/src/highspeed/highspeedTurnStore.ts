import type { HighspeedCardSnapshot, HighspeedMessageMeta } from "@zcode/shared";
import { planHighspeedTranscriptHydration } from "@/highspeed/highspeedTurnHydration.js";
import { calculateHighspeedSavedDurationMs } from "@/highspeed/highspeedSavedTime.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";

export interface HighspeedTranscriptRow {
  sourceCommandId?: string;
  createdAt: number;
  highspeed?: HighspeedMessageMeta;
}

export interface HighspeedTurnMetrics {
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  regularTps: number;
  highspeedTps?: number;
  savedDurationMs?: number;
}

export interface HighspeedShareMetrics extends HighspeedTurnMetrics {
  highspeedTps: number;
}

export interface HighspeedTurnRecord {
  sessionId: string;
  sourceCommandId: string;
  card: HighspeedCardSnapshot;
  createdAt: number;
  completedAt?: number;
  metrics?: HighspeedTurnMetrics;
  metricsPersistedAt?: number;
  autoShareAttemptedAt?: number;
  autoSharedAt?: number;
}

export interface HighspeedCardAutoShareCandidate {
  cardId: string;
  expiresAt: number;
  metrics: HighspeedShareMetrics;
}

const MAX_RECORDS = 300;

let records: HighspeedTurnRecord[] = [];
const highspeedTpsByCardId = new Map<string, number>();
let healthyAttemptSequence = 0;
const healthyAttemptsByCardId = new Map<string, { expiry?: number; completion?: number }>();
export interface HighspeedHealthyAttempt {
  cardId: string;
  phase: "expiry" | "completion";
  id: number;
}
const listeners = new Set<() => void>();

function publishChange(): void {
  for (const listener of listeners) listener();
}

export function recordHighspeedTurn(record: HighspeedTurnRecord): void {
  records = [
    record,
    ...records.filter((candidate) => candidate.sourceCommandId !== record.sourceCommandId),
  ].slice(0, MAX_RECORDS);
  publishChange();
}

/**
 * 冷启动恢复与跨端追平：到期时 renderer 可能不在场，内存 store 没有机会登记/收口这张卡；
 * 远控 Renderer 也可能先登记运行中 row、桌面端随后才把完成态持久化进 transcript。
 * 合并口径见 planHighspeedTranscriptHydration；这里只负责按序落库并发一次通知。
 * 返回产生变化的 row 数；无变化不发通知，重复水合不会造成渲染抖动。
 */
export function hydrateHighspeedTurnsFromTranscript(
  sessionId: string,
  rows: readonly HighspeedTranscriptRow[],
): number {
  const plan = planHighspeedTranscriptHydration(rows, {
    sessionId,
    now: Date.now(),
    findRecord: getHighspeedTurnByCommandId,
    getCardTps: getHighspeedCardTps,
  });
  for (const [cardId, highspeedTps] of plan.cardTps) {
    highspeedTpsByCardId.set(cardId, highspeedTps);
  }
  for (const { record, existed } of plan.records) {
    records = existed
      ? records.map((candidate) =>
          candidate.sourceCommandId === record.sourceCommandId ? record : candidate,
        )
      : [record, ...records].slice(0, MAX_RECORDS);
  }
  if (plan.changedRows > 0) publishChange();
  return plan.changedRows;
}

export function discardHighspeedTurn(sourceCommandId: string): boolean {
  const nextRecords = records.filter((record) => record.sourceCommandId !== sourceCommandId);
  if (nextRecords.length === records.length) return false;
  records = nextRecords;
  publishChange();
  return true;
}

export function completeHighspeedTurn(params: {
  sourceCommandId: string;
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  completedAt?: number;
}): HighspeedTurnRecord | null {
  const current = getHighspeedTurnByCommandId(params.sourceCommandId);
  if (!current) return null;
  if (current.metrics) return current;
  const completed: HighspeedTurnRecord = {
    ...current,
    completedAt: params.completedAt ?? Date.now(),
    metrics: {
      outputTokens: Math.max(0, Math.floor(params.outputTokens)),
      durationMs: Math.max(0, params.durationMs),
      ...(params.modelDurationMs !== undefined
        ? { modelDurationMs: Math.max(0, params.modelDurationMs) }
        : {}),
      ...(params.toolDurationMs !== undefined
        ? { toolDurationMs: Math.max(0, params.toolDurationMs) }
        : {}),
      ...(params.otherDurationMs !== undefined
        ? { otherDurationMs: Math.max(0, params.otherDurationMs) }
        : {}),
      regularTps: current.card.regularTps ?? 0,
    },
  };
  records = records.map((record) =>
    record.sourceCommandId === params.sourceCommandId ? completed : record,
  );
  publishChange();
  return completed;
}

export function setHighspeedCardTps(cardId: string, highspeedTps: number): void {
  if (!Number.isFinite(highspeedTps) || highspeedTps <= 0) return;
  if (highspeedTpsByCardId.get(cardId) === highspeedTps) return;
  highspeedTpsByCardId.set(cardId, highspeedTps);
  publishChange();
}

export function getHighspeedCardTps(cardId: string): number | undefined {
  return highspeedTpsByCardId.get(cardId);
}

/**
 * 卡级 healthy 查询防重必须跨 SessionPane 生命周期存在；组件 ref 会在重挂载后清空，
 * 导致同一张已过期卡持续请求并放大服务端限流。每张卡最多允许到期查询一次，
 * 若当时仍有 Turn 运行，再允许最后一轮结束后补查一次。
 */
export function claimHighspeedHealthyAttempt(
  cardId: string,
  allTurnsCompleted: boolean,
): HighspeedHealthyAttempt | null {
  const attempts = healthyAttemptsByCardId.get(cardId) ?? {};
  const phase = allTurnsCompleted ? "completion" : "expiry";
  if (attempts[phase] !== undefined) return null;
  const id = ++healthyAttemptSequence;
  attempts[phase] = id;
  healthyAttemptsByCardId.set(cardId, attempts);
  return { cardId, phase, id };
}

/** 跳过归属不明的请求不消费机会；旧Promise只能释放自己的占位，不广播空转重试。 */
export function releaseHighspeedHealthyAttempt(attempt: HighspeedHealthyAttempt): void {
  const current = healthyAttemptsByCardId.get(attempt.cardId);
  if (current?.[attempt.phase] === attempt.id) delete current[attempt.phase];
}

/** 重登可重新核验未取得TPS的卡；已存TPS和分享结果不清理。 */
export function resetHighspeedHealthyAttempts(): void {
  healthyAttemptsByCardId.clear();
}

export function markHighspeedTurnMetricsPersisted(
  sourceCommandId: string,
  savedDurationMs: number,
  persistedAt = Date.now(),
): void {
  let changed = false;
  records = records.map((record) => {
    if (
      record.sourceCommandId !== sourceCommandId ||
      !record.metrics ||
      record.metricsPersistedAt !== undefined
    ) {
      return record;
    }
    const highspeedTps = getHighspeedCardTps(record.card.cardId);
    if (!highspeedTps) return record;
    changed = true;
    return {
      ...record,
      metricsPersistedAt: persistedAt,
      metrics: {
        ...record.metrics,
        highspeedTps,
        savedDurationMs: Math.max(0, savedDurationMs),
      },
    };
  });
  if (changed) publishChange();
}

export function markHighspeedCardAutoShared(cardId: string, autoSharedAt = Date.now()): void {
  let changed = false;
  records = records.map((record) => {
    if (record.card.cardId !== cardId || record.autoSharedAt !== undefined) return record;
    changed = true;
    return { ...record, autoSharedAt };
  });
  if (changed) publishChange();
}

export function claimHighspeedCardAutoShare(
  cardId: string,
  attemptedAt = Date.now(),
): HighspeedTurnRecord[] | null {
  const cardRecords = listHighspeedTurnsByCard(cardId);
  const metrics = aggregateHighspeedCardMetrics(cardId);
  if (
    cardRecords.length === 0 ||
    metrics.outputTokens <= 0 ||
    cardRecords.some(
      (record) =>
        !record.metrics ||
        record.metrics.regularTps <= 0 ||
        record.metricsPersistedAt === undefined ||
        record.autoShareAttemptedAt !== undefined ||
        record.autoSharedAt !== undefined ||
        record.card.expiresAt > attemptedAt,
    )
  ) {
    return null;
  }
  const claimed = cardRecords.map((record) => ({ ...record, autoShareAttemptedAt: attemptedAt }));
  const claimedByCommandId = new Map(
    claimed.map((record) => [record.sourceCommandId, record] as const),
  );
  records = records.map((record) => claimedByCommandId.get(record.sourceCommandId) ?? record);
  publishChange();
  return claimed;
}

export function getHighspeedTurnByCommandId(
  sourceCommandId: string | undefined,
): HighspeedTurnRecord | null {
  if (!sourceCommandId) return null;
  return records.find((record) => record.sourceCommandId === sourceCommandId) ?? null;
}

export function listHighspeedTurnsByCard(cardId: string): HighspeedTurnRecord[] {
  return records.filter((record) => record.card.cardId === cardId);
}

export function listHighspeedTurnsBySession(sessionId: string): HighspeedTurnRecord[] {
  return records.filter((record) => record.sessionId === sessionId);
}

export function listPendingHighspeedTurns(sessionId: string): HighspeedTurnRecord[] {
  return listHighspeedTurnsBySession(sessionId).filter((record) => record.metrics === undefined);
}

export function listExpiredHighspeedCardsAwaitingTps(
  sessionId: string,
  now: number,
): Array<{ cardId: string; ownerKey: string; allTurnsCompleted: boolean }> {
  const sessionRecords = listHighspeedTurnsBySession(sessionId);
  const cardIds = [...new Set(sessionRecords.map((record) => record.card.cardId))];
  return cardIds.flatMap((cardId) => {
    const cardRecords = sessionRecords.filter((record) => record.card.cardId === cardId);
    if (
      highspeedTpsByCardId.has(cardId) ||
      cardRecords.every((record) => record.card.expiresAt > now)
    ) {
      return [];
    }
    const owners = new Set(cardRecords.map((record) => record.card.ownerKey));
    const ownerKey = cardRecords[0]?.card.ownerKey;
    // 旧卡不能由当前账号认领；同卡归属冲突也不能拿任一用户的JWT补查。
    if (!ownerKey || owners.size !== 1) return [];
    return [{ cardId, ownerKey, allTurnsCompleted: cardRecords.every((record) => record.metrics) }];
  });
}

export function listHighspeedTurnsAwaitingMetricsPersistence(
  sessionId: string,
): HighspeedTurnRecord[] {
  return listHighspeedTurnsBySession(sessionId).filter(
    (record) =>
      record.metrics !== undefined &&
      record.metricsPersistedAt === undefined &&
      getHighspeedCardTps(record.card.cardId) !== undefined,
  );
}

export function listHighspeedCardAutoShareCandidates(
  sessionId: string,
): HighspeedCardAutoShareCandidate[] {
  const sessionRecords = listHighspeedTurnsBySession(sessionId);
  const cardIds = [...new Set(sessionRecords.map((record) => record.card.cardId))];
  return cardIds.flatMap((cardId) => {
    const cardRecords = sessionRecords.filter((record) => record.card.cardId === cardId);
    if (
      cardRecords.some(
        (record) =>
          !record.metrics ||
          record.metrics.regularTps <= 0 ||
          record.metricsPersistedAt === undefined ||
          record.autoShareAttemptedAt !== undefined ||
          record.autoSharedAt !== undefined,
      )
    ) {
      return [];
    }
    const metrics = aggregateHighspeedCardMetrics(cardId);
    // Bug 原因：零输出卡过去仍会进入自动分享，build request 再把 token_usage 强制成 1，
    // 既违背“没有生成内容不展示/分享”的产品语义，也会向后端写入虚假 usage。
    if (metrics.outputTokens <= 0) return [];
    // 未达标（总体加速倍率 ≤1.2x）不发布左下角分享卡：发布门禁与「查看」按钮门禁同口径，
    // 否则会出现「卡弹出来却没有查看按钮」的半残态（spec §9）。诊断 blocker below-min-speedup
    // 与此保持一致，避免达标判定漂移或静默丢卡。
    if (!isHighspeedShareEligible(metrics)) return [];
    return [
      {
        cardId,
        expiresAt: Math.max(...cardRecords.map((record) => record.card.expiresAt)),
        metrics,
      },
    ];
  });
}

export function resolveNextHighspeedAutoShareAt(sessionId: string): number | null {
  const sessionRecords = listHighspeedTurnsBySession(sessionId).filter(
    (record) => record.autoShareAttemptedAt === undefined && record.autoSharedAt === undefined,
  );
  if (sessionRecords.length === 0) return null;
  return Math.min(...sessionRecords.map((record) => record.card.expiresAt));
}

export function subscribeHighspeedTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 记录本身是不可变快照。消费者浅比较这些依赖，不能订阅全局版本使无关会话一起更新。
// 卡级聚合跨会话，必须包含同卡全部记录与 TPS，而不能只截取当前会话的记录。
function highspeedCardDependencies(
  cardIds: ReadonlySet<string>,
): readonly (HighspeedTurnRecord | number | undefined)[] {
  return [
    ...records.filter((record) => cardIds.has(record.card.cardId)),
    ...Array.from(cardIds, getHighspeedCardTps),
  ];
}

export function getHighspeedSessionDependencies(
  sessionId: string | null,
): readonly (HighspeedTurnRecord | number | undefined)[] {
  return highspeedCardDependencies(
    new Set(
      records
        .filter((record) => record.sessionId === sessionId)
        .map((record) => record.card.cardId),
    ),
  );
}

export function getHighspeedTurnDependencies(
  sourceCommandId: string | undefined,
): readonly (HighspeedTurnRecord | number | undefined)[] {
  const record = getHighspeedTurnByCommandId(sourceCommandId);
  return highspeedCardDependencies(new Set(record ? [record.card.cardId] : []));
}

export function aggregateHighspeedCardMetrics(cardId: string): HighspeedShareMetrics {
  const records = listHighspeedTurnsByCard(cardId).filter(
    (record): record is HighspeedTurnRecord & { metrics: HighspeedTurnMetrics } =>
      record.metrics !== undefined,
  );
  const outputTokens = records.reduce((total, record) => total + record.metrics.outputTokens, 0);
  const highspeedTps =
    getHighspeedCardTps(cardId) ??
    records.find((record) => record.metrics.highspeedTps)?.metrics.highspeedTps ??
    0;
  const savedDurationMs = records.reduce(
    (total, record) =>
      total +
      (record.metrics.savedDurationMs ??
        calculateHighspeedSavedDurationMs({
          outputTokens: record.metrics.outputTokens,
          regularTps: record.metrics.regularTps,
          highspeedTps,
          durationMs: record.metrics.durationMs,
          modelDurationMs: record.metrics.modelDurationMs,
          toolDurationMs: record.metrics.toolDurationMs,
          otherDurationMs: record.metrics.otherDurationMs,
        })),
    0,
  );
  const regularDurationSeconds = records.reduce(
    (total, record) =>
      total +
      (record.metrics.regularTps > 0 ? record.metrics.outputTokens / record.metrics.regularTps : 0),
    0,
  );
  const hasRealTiming =
    records.length > 0 &&
    records.every(
      (record) =>
        record.metrics.modelDurationMs !== undefined && record.metrics.toolDurationMs !== undefined,
    );
  return {
    outputTokens,
    durationMs: records.reduce((total, record) => total + record.metrics.durationMs, 0),
    ...(hasRealTiming
      ? {
          modelDurationMs: records.reduce(
            (total, record) => total + (record.metrics.modelDurationMs ?? 0),
            0,
          ),
          toolDurationMs: records.reduce(
            (total, record) => total + (record.metrics.toolDurationMs ?? 0),
            0,
          ),
          otherDurationMs: records.reduce(
            (total, record) =>
              total +
              (record.metrics.otherDurationMs ??
                Math.max(
                  0,
                  record.metrics.durationMs -
                    (record.metrics.modelDurationMs ?? 0) -
                    (record.metrics.toolDurationMs ?? 0),
                )),
            0,
          ),
        }
      : {}),
    savedDurationMs,
    regularTps:
      regularDurationSeconds > 0 ? Number((outputTokens / regularDurationSeconds).toFixed(3)) : 0,
    highspeedTps,
  };
}

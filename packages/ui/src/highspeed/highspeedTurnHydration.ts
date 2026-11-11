// transcript → 内存记录的水合合并纯逻辑。从 highspeedTurnStore 拆出：store 只做状态 owner
// 与查询，合并口径在这里收敛，便于单独理解与测试。本模块不触碰 store 状态，读取一律通过
// context 注入，因此不与 store 形成运行时循环依赖（只保留编译期擦除的 type import）。
import type { HighspeedMessageMeta } from "@zcode/shared";
import type {
  HighspeedTranscriptRow,
  HighspeedTurnMetrics,
  HighspeedTurnRecord,
} from "@/highspeed/highspeedTurnStore.js";

const METRIC_KEYS = [
  "outputTokens",
  "durationMs",
  "modelDurationMs",
  "toolDurationMs",
  "otherDurationMs",
  "regularTps",
  "highspeedTps",
  "savedDurationMs",
] as const satisfies readonly (keyof HighspeedTurnMetrics)[];

/** 水合一批 transcript row 的结果；store 按序应用后只发一次通知。 */
export interface HighspeedHydrationPlan {
  /** 需要落库的记录，按 transcript 顺序；`existed` 区分替换已有记录与新登记。 */
  records: Array<{ record: HighspeedTurnRecord; existed: boolean }>;
  /** 需要写入的卡级 TPS。 */
  cardTps: Array<[cardId: string, highspeedTps: number]>;
  /** 产生变化的 row 数；0 表示整批无变化，调用方不必通知订阅者。 */
  changedRows: number;
}

export interface HighspeedHydrationContext {
  sessionId: string;
  now: number;
  findRecord(sourceCommandId: string): HighspeedTurnRecord | null;
  getCardTps(cardId: string): number | undefined;
}

type HydratableRow = HighspeedTranscriptRow & {
  sourceCommandId: string;
  highspeed: HighspeedMessageMeta;
};

function sameMetrics(a: HighspeedTurnMetrics | undefined, b: HighspeedTurnMetrics | undefined) {
  if (!a || !b) return a === b;
  return METRIC_KEYS.every((key) => a[key] === b[key]);
}

/**
 * 把 transcript 的权威 meta 合并进（可能已存在的）记录。transcript/CLI 持久化是跨端恢复的
 * 权威事实：完成态字段覆盖运行期临时值；meta 仍是运行态时绝不清空已完成字段。
 * 没有任何字段变化时返回 null，让调用方跳过通知。
 */
function mergeTranscriptRow(
  existing: HighspeedTurnRecord | null,
  sessionId: string,
  row: HydratableRow,
  now: number,
  highspeedTpsOfCard: number | undefined,
): HighspeedTurnRecord | null {
  const meta = row.highspeed;
  const base: HighspeedTurnRecord = existing ?? {
    sessionId,
    sourceCommandId: row.sourceCommandId,
    card: {
      cardId: meta.cardId,
      ...(meta.ownerKey ? { ownerKey: meta.ownerKey } : {}),
      taskId: meta.taskId,
      provider: meta.provider,
      model: meta.model,
      issuedAt: meta.issuedAt,
      expiresAt: meta.expiresAt,
      ...(meta.regularTps !== undefined ? { regularTps: meta.regularTps } : {}),
    },
    createdAt: row.createdAt,
  };
  let next = base;
  if (next.card.ownerKey !== meta.ownerKey)
    next = { ...next, card: { ...next.card, ownerKey: meta.ownerKey } };
  // 发送时采样的 regularTps 是持久事实；内存记录缺失时补齐。
  if (meta.regularTps !== undefined && next.card.regularTps !== meta.regularTps) {
    next = { ...next, card: { ...next.card, regularTps: meta.regularTps } };
  }
  if (meta.outputTokens !== undefined && meta.durationMs !== undefined) {
    const metrics: HighspeedTurnMetrics = {
      ...next.metrics,
      outputTokens: Math.max(0, Math.floor(meta.outputTokens)),
      durationMs: Math.max(0, meta.durationMs),
      ...(meta.modelDurationMs !== undefined
        ? { modelDurationMs: Math.max(0, meta.modelDurationMs) }
        : {}),
      ...(meta.toolDurationMs !== undefined
        ? { toolDurationMs: Math.max(0, meta.toolDurationMs) }
        : {}),
      ...(meta.otherDurationMs !== undefined
        ? { otherDurationMs: Math.max(0, meta.otherDurationMs) }
        : {}),
      regularTps: meta.regularTps ?? next.metrics?.regularTps ?? next.card.regularTps ?? 0,
    };
    if (!sameMetrics(next.metrics, metrics)) {
      next = { ...next, completedAt: next.completedAt ?? now, metrics };
    }
  }
  // 与 markHighspeedTurnMetricsPersisted 同口径：只有拿到卡级 TPS 才能落 savedDurationMs；已标记过不重复。
  const highspeedTps = meta.highspeedTps ?? highspeedTpsOfCard;
  if (
    meta.savedDurationMs !== undefined &&
    next.metrics &&
    highspeedTps &&
    next.metricsPersistedAt === undefined
  ) {
    next = {
      ...next,
      metricsPersistedAt: now,
      metrics: {
        ...next.metrics,
        highspeedTps,
        savedDurationMs: Math.max(0, meta.savedDurationMs),
      },
    };
  }
  return existing && next === base ? null : next;
}

/**
 * 冷启动恢复与跨端追平：到期时 renderer 可能不在场，内存 store 没有机会登记/收口这张卡；
 * 远控 Renderer 也可能先登记运行中 row、桌面端随后才把完成态持久化进 transcript。
 * transcript 中的 userInput.highspeed 是持久事实，按 sourceCommandId 幂等合并（spec §8）。
 * Bug 根因：旧实现对已存在的 sourceCommandId 直接 continue，迟到的 outputTokens/durationMs/
 * highspeedTps/savedDurationMs 永远吸收不进来，远端的卡级 TPS、节省时间与自动分享候选无法收口。
 */
export function planHighspeedTranscriptHydration(
  rows: readonly HighspeedTranscriptRow[],
  context: HighspeedHydrationContext,
): HighspeedHydrationPlan {
  const plan: HighspeedHydrationPlan = { records: [], cardTps: [], changedRows: 0 };
  // 同一批内后续 row 必须看到前面 row 刚产生的记录与卡级 TPS，口径与逐条落库的旧实现一致。
  const stagedByCommandId = new Map<string, number>();
  const stagedCardTps = new Map<string, number>();
  for (const row of rows) {
    const meta = row.highspeed;
    if (!meta || !row.sourceCommandId) continue;
    const sourceCommandId = row.sourceCommandId;
    const stagedIndex = stagedByCommandId.get(sourceCommandId);
    const staged = stagedIndex === undefined ? undefined : plan.records[stagedIndex];
    const existing = staged?.record ?? context.findRecord(sourceCommandId);
    let changed = false;
    let cardTps = stagedCardTps.get(meta.cardId) ?? context.getCardTps(meta.cardId);
    // 守卫与 setHighspeedCardTps 同口径：非正或非有限值不落库，也不算变化。
    if (
      meta.highspeedTps !== undefined &&
      Number.isFinite(meta.highspeedTps) &&
      meta.highspeedTps > 0 &&
      cardTps !== meta.highspeedTps
    ) {
      stagedCardTps.set(meta.cardId, meta.highspeedTps);
      plan.cardTps.push([meta.cardId, meta.highspeedTps]);
      cardTps = meta.highspeedTps;
      changed = true;
    }
    const merged = mergeTranscriptRow(
      existing,
      context.sessionId,
      { ...row, sourceCommandId, highspeed: meta },
      context.now,
      cardTps,
    );
    if (merged) {
      if (stagedIndex !== undefined && staged) {
        plan.records[stagedIndex] = { record: merged, existed: staged.existed };
      } else {
        stagedByCommandId.set(sourceCommandId, plan.records.length);
        plan.records.push({ record: merged, existed: existing !== null });
      }
      changed = true;
    }
    if (changed) plan.changedRows += 1;
  }
  return plan;
}

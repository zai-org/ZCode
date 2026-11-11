import type { BotTopicPreparation } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  sameItems,
  type ConversationTurnRenderUnit,
  type ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";

// 准备消息挂在历史末项上时（尾轮为空）的结果，按 history 数组缓存：同一份材料复用同一个数组，
// 下游按 history 引用缓存的派生不会每次失效。
const topicPreparationHistories = new WeakMap<
  readonly ConversationTurnRenderUnit[],
  {
    pending: readonly BotTopicPreparation[];
    history: readonly ConversationTurnRenderUnit[];
  }
>();

/**
 * bot 话题准备消息挂在全部 unit 的最后一个上，结果与对 history ++ tail 调用
 * withTopicPreparationMessages 相同。没有准备中的材料时结果必为空，直接返回、不扫描 rows
 * （流式帧的常见情况）；有材料时只在 bot 话题准备期间按整窗计算。
 */
export function withTopicPreparationUnits(
  units: ConversationTurnRenderUnitsPartition,
  rows: readonly ConversationRow[],
  items: readonly BotTopicPreparation[],
): ConversationTurnRenderUnitsPartition {
  if (items.length === 0) return units;
  const all = [...units.history, ...units.tail];
  const merged = withTopicPreparationMessages(all, rows, items);
  if (merged === all) return units;
  if (units.tail.length > 0 || units.history.length === 0) {
    return { history: units.history, tail: merged.slice(units.history.length) };
  }
  const pending = merged.at(-1)?.topicPreparations ?? [];
  const cached = topicPreparationHistories.get(units.history);
  if (cached && sameItems(cached.pending, pending)) return { history: cached.history, tail: [] };
  topicPreparationHistories.set(units.history, { pending, history: merged });
  return { history: merged, tail: [] };
}

export interface ConversationTimelineLiveTailSplit {
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
}

/**
 * running turn 继续放在绝对定位虚拟行里时，正文 DOM 会先长高，
 * ResizeObserver 下一帧才回填 totalSize/scrollTop，导致轮尾 ChatLoading 来回跳。
 * 最后一轮始终放在 normal-flow live tail；其余轮次仍归虚拟列表，只常驻一个尾轮。
 * Bugfix：曾按 isRunning 切换父容器，Stop 后整轮重挂，过程区从透明重新淡入。
 * 以轮次位置决定容器，让终态沿用已有组件；新一轮出现时旧轮才进入虚拟历史。
 *
 * 输入按「历史 + 尾轮」分区：运行中的最后一轮通常是唯一的尾轮 unit，此时虚拟列表直接用
 * 历史数组，引用在流式帧之间不变，virtualizer 与目录不会随每个 token 重建。
 */
export function splitConversationTimelineLiveTail(
  units: ConversationTurnRenderUnitsPartition,
): ConversationTimelineLiveTailSplit {
  const { history, tail } = units;
  const liveUnit = tail.at(-1) ?? history.at(-1);
  if (!liveUnit) {
    return {
      virtualizedUnits: tail.length === 0 ? history : [...history, ...tail],
      liveUnit: null,
      liveUnitIndex: null,
    };
  }
  return {
    virtualizedUnits:
      tail.length === 0
        ? history.slice(0, -1)
        : tail.length === 1
          ? history
          : [...history, ...tail.slice(0, -1)],
    liveUnit,
    liveUnitIndex: history.length + tail.length - 1,
  };
}

/**
 * 时间线最后一个回合的摘要（spec：docs/ui/side-pane-full-view.md）。
 * 运行状态、运行时长和最终回答取自同一个 render unit，供完整视图浮窗一次性使用，
 * 避免运行状态与回答来自两个数据源时先后不一致。
 */
export interface ConversationLatestTurnSummary {
  /** 最后一个回合的 turnId；同一轮运行中和结束后不变。 */
  readonly turnKey: string | null;
  readonly running: boolean;
  /** 运行中最后一个 work segment 的时长，与流式消息「工作中 N 秒」同值。 */
  readonly workDurationMs: number | undefined;
  /** 已结束回合的最终回答；运行中或回答未完成时为 null。 */
  readonly answer: { readonly rowId: number; readonly text: string } | null;
}

export function resolveConversationLatestTurnSummary(
  units: readonly ConversationTurnRenderUnit[],
): ConversationLatestTurnSummary {
  const unit = units.at(-1);
  if (!unit) return { turnKey: null, running: false, workDurationMs: undefined, answer: null };
  const running = unit.isRunning;
  const row = unit.latestAssistantTextRow;
  return {
    turnKey: unit.key,
    running,
    workDurationMs: running ? unit.workSegments?.at(-1)?.workStatus?.durationMs : undefined,
    answer:
      !running && row?.state === "complete" && row.text.trim()
        ? { rowId: row.rowId, text: row.text }
        : null,
  };
}

export function isSameConversationLatestTurnSummary(
  a: ConversationLatestTurnSummary,
  b: ConversationLatestTurnSummary,
): boolean {
  return (
    a.turnKey === b.turnKey &&
    a.running === b.running &&
    a.workDurationMs === b.workDurationMs &&
    a.answer?.rowId === b.answer?.rowId &&
    a.answer?.text === b.answer?.text
  );
}

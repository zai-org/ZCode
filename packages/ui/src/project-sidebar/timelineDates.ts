import type { Locale } from "@/project-sidebar/contract.js";

interface TimelineDateHeading {
  key: string;
  id: string;
  values?: { days: string };
}

// 日期段按本地日历计算；夏令时的一天可能为 23/25 小时，不能直接用毫秒差取整。
function calendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** 只给已有顺序插入标题；分页、行集合与时间排序仍归列表 owner。 */
export function timelineDateHeadings(
  timestamps: readonly number[],
  now: number,
  locale: Locale,
): Array<TimelineDateHeading | null> {
  const today = calendarDay(now);
  const date = new Date(now);
  // 「本周」起点按地区习惯：美/日/韩从周日开始，中/俄从周一开始。
  const weekStartsOnSunday = locale === "en-US" || locale === "ja-JP" || locale === "ko-KR";
  const weekStart = today - ((date.getDay() + (weekStartsOnSunday ? 0 : 6)) % 7);
  const monthStart = calendarDay(new Date(date.getFullYear(), date.getMonth(), 1).getTime());
  const lastMonthStart = calendarDay(
    new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime(),
  );
  let previousKey: string | undefined;
  return timestamps.map((timestamp) => {
    const day = calendarDay(timestamp);
    const daysAgo = today - day;
    const kind =
      daysAgo <= 0
        ? "today"
        : daysAgo === 1
          ? "yesterday"
          : daysAgo <= 3
            ? "daysAgo"
            : day >= weekStart
              ? "thisWeek"
              : day >= weekStart - 7
                ? "lastWeek"
                : day >= monthStart
                  ? "thisMonth"
                  : day >= lastMonthStart
                    ? "lastMonth"
                    : "older";
    const key = kind === "daysAgo" ? `${kind}:${daysAgo}` : kind;
    if (key === previousKey) return null;
    previousKey = key;
    return {
      key,
      id: `taskTimeline.${kind}`,
      ...(kind === "daysAgo" ? { values: { days: String(daysAgo) } } : {}),
    };
  });
}

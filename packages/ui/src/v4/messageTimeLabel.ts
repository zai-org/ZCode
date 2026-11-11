import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 时刻里「时」的位数：24 小时制语言补零（zh/ja/ru 的 09:05），12 小时制语言不补零。
 * Bug 原因：直接写 hour: "2-digit" 时，韩语显示「오후 05:02」、英语「05:02 PM」，
 * 12 小时制本地习惯是「오후 5:02」「5:02 PM」。
 */
const hourDigitsCache = new Map<string, "numeric" | "2-digit">();

export function resolveHourDigits(locale: string): "numeric" | "2-digit" {
  const cached = hourDigitsCache.get(locale);
  if (cached) return cached;
  let digits: "numeric" | "2-digit" = "2-digit";
  try {
    const { hourCycle } = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
    digits = hourCycle === "h11" || hourCycle === "h12" ? "numeric" : "2-digit";
  } catch {
    // 非法 locale 维持原有补零写法。
  }
  hourDigitsCache.set(locale, digits);
  return digits;
}

type DateTimeFormatterKind = "time" | "monthDayTime" | "yearMonthDayTime";

const MESSAGE_TIME_LABEL_CACHE_LIMIT = 4_000;
const messageTimeLabelCache = new Map<string, string>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function getDayCacheKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateTimeFormatter(locale: string, kind: DateTimeFormatterKind): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${kind}`;
  const cached = dateTimeFormatterCache.get(cacheKey);
  if (cached) return cached;

  // 12 小时制语言（ko/en）时不补零，见 resolveHourDigits。
  const hour = resolveHourDigits(locale);
  const formatter = new Intl.DateTimeFormat(
    locale,
    kind === "time"
      ? { hour, minute: "2-digit" }
      : kind === "monthDayTime"
        ? { month: "numeric", day: "numeric", hour, minute: "2-digit" }
        : {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour,
            minute: "2-digit",
          },
  );
  dateTimeFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function cacheMessageTimeLabel(cacheKey: string, label: string): string {
  if (messageTimeLabelCache.size >= MESSAGE_TIME_LABEL_CACHE_LIMIT) {
    messageTimeLabelCache.clear();
  }
  messageTimeLabelCache.set(cacheKey, label);
  return label;
}

export function formatMessageTimeLabel(
  timestamp: number,
  locale: string,
  intl: IntlInstance,
  nowTimestamp = Date.now(),
): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const messageDate = new Date(timestamp);
  const now = new Date(nowTimestamp);
  if (Number.isNaN(messageDate.getTime()) || Number.isNaN(now.getTime())) return null;

  const cacheKey = `${locale}:${timestamp}:${getDayCacheKey(now)}`;
  const cached = messageTimeLabelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const timeText = getDateTimeFormatter(locale, "time").format(messageDate);
  if (isSameDay(messageDate, now)) {
    return cacheMessageTimeLabel(cacheKey, timeText);
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(messageDate, yesterday)) {
    return cacheMessageTimeLabel(
      cacheKey,
      intl.formatMessage({ id: "chat.message.time.yesterday" }, { time: timeText }),
    );
  }

  if (messageDate.getFullYear() === now.getFullYear()) {
    return cacheMessageTimeLabel(
      cacheKey,
      getDateTimeFormatter(locale, "monthDayTime").format(messageDate),
    );
  }

  return cacheMessageTimeLabel(
    cacheKey,
    getDateTimeFormatter(locale, "yearMonthDayTime").format(messageDate),
  );
}

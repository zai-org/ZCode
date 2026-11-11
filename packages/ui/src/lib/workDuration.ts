/**
 * 「工作了 1 分 42 秒」的时长写法（`chat.history.workedFor`），从 `ConversationTurnGroup` 抽出，
 * 好让工作流完成卡的「时间」格与轮头的折叠标签
 * 一字不差：同一段时间在两处必须写成同一个样子。
 *
 * 规则：秒向最近取整、至少 1 秒；天 / 时 / 分 / 秒里只写非零的，**最多两段**（`1h 3m`，
 * 不写秒）；英文/日/韩单位紧贴数字，中文、俄语单位前留一个空格。
 */
type FormatMessage = (descriptor: { id: string }) => string;

interface WorkDurationPart {
  value: number;
  /** 本地化后的单位词（`m` / `分`）。 */
  unit: string;
}

const UNIT_IDS = {
  day: "chat.history.duration.day",
  hour: "chat.history.duration.hour",
  minute: "chat.history.duration.minute",
  second: "chat.history.duration.second",
} as const;

/** 拆成 `[{value, unit}]`，给要把数字与单位分开排的地方（完成卡的大数字）。 */
export function workDurationParts(
  durationMs: number,
  formatMessage: FormatMessage,
): WorkDurationPart[] {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: WorkDurationPart[] = [];
  if (days > 0) parts.push({ value: days, unit: formatMessage({ id: UNIT_IDS.day }) });
  if (hours > 0) parts.push({ value: hours, unit: formatMessage({ id: UNIT_IDS.hour }) });
  if (minutes > 0) parts.push({ value: minutes, unit: formatMessage({ id: UNIT_IDS.minute }) });
  if (seconds > 0 || parts.length === 0) {
    parts.push({ value: seconds, unit: formatMessage({ id: UNIT_IDS.second }) });
  }
  return parts.slice(0, 2);
}

/**
 * 中文、俄语时长单位与数字之间留空格；英文缩写单位与日/韩单位紧贴数字。
 * 俄语按规范写「10 с」：语言表里其它时长（倒计时、思考用时等）都是「{seconds} с」，
 * 过去这里只给中文留空格，俄语同屏出现「10с」与「9 с」两种写法。
 */
const SPACED_DURATION_UNIT_LOCALES: ReadonlySet<string> = new Set(["zh-CN", "ru-RU"]);

export function workDurationUnitSeparator(locale: string): string {
  return SPACED_DURATION_UNIT_LOCALES.has(locale) ? " " : "";
}

export function formatWorkDuration(
  durationMs: number | undefined,
  formatMessage: FormatMessage,
  locale: string,
): string | null {
  if (durationMs === undefined) return null;
  const separator = workDurationUnitSeparator(locale);
  return workDurationParts(durationMs, formatMessage)
    .map((part) => `${part.value}${separator}${part.unit}`)
    .join(" ");
}

/** 按已完整经过的秒拆分，不显示小数；完成耗时保持原有格式。 */
export function formatRunningWorkDuration(
  durationMs: number,
  formatMessage: FormatMessage,
  locale: string,
): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const separator = workDurationUnitSeparator(locale);
  const parts: string[] = [];
  if (hours) parts.push(`${hours}${separator}${formatMessage({ id: UNIT_IDS.hour })}`);
  if (hours || minutes)
    parts.push(`${minutes}${separator}${formatMessage({ id: UNIT_IDS.minute })}`);
  parts.push(`${seconds}${separator}${formatMessage({ id: UNIT_IDS.second })}`);
  return parts.join(" ");
}

/**
 * 观察类工作流工具卡的数值/时间格式化（GetWorkflowRun 与 ListWorkflowRuns 共用）。
 * 纯函数、无 i18n 依赖：数字与时间走 Intl 默认 locale，文案才走 message 表。
 */

export function formatWorkflowTokenCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) {
    return `${trimTrailingZero((value / 1_000).toFixed(1))}k`;
  }
  return `${trimTrailingZero((value / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

// 按界面语言格式化；同一语言复用 formatter（以前固定用系统语言）。
const SHORT_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};
const shortTimestampFormats = new Map<string, Intl.DateTimeFormat>();

export function formatWorkflowTimestamp(epochMs: number, locale?: string): string {
  const key = locale ?? "";
  let format = shortTimestampFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, SHORT_TIMESTAMP_OPTIONS);
    shortTimestampFormats.set(key, format);
  }
  if (!Number.isFinite(epochMs)) return String(epochMs);
  return format.format(new Date(epochMs));
}

const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `40s` / `5m 10s` / `2h 15m` / `3d 2h`：情势截面里每一段时长与年龄的写法。
 *
 * 刻意与 GetWorkflowRun 模型面的 `formatWorkflowRunDuration`
 * （apps/zcode-cli/packages/core/src/tool/handlers/workflow-run-introspection.ts）逐字同款：
 * 同一份快照的同一个数，模型读到的和卡上画的不能长得不一样。
 */
export function formatWorkflowDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    return `${minutes}m ${padTwo(Math.floor((total % DURATION_MS.minute) / DURATION_MS.second))}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    return `${hours}h ${padTwo(Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute))}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  return `${days}d ${Math.floor((total % DURATION_MS.day) / DURATION_MS.hour)}h`;
}

/**
 * 「多久以前」的裸时长（文案里的「前」由 message 表拼）。
 *
 * 基准是快照时刻 `generatedAt`，**不是** `Date.now()`：一条三天前的 transcript 重新打开时，
 * 卡上的年龄仍该是当时那个年龄，否则同一张卡每次重渲染都在漂。没有基准或没有那个时刻就回
 * `undefined`——读侧据此整段省略这个年龄，绝不用 0 或「未知」顶替一件不知道的事。
 */
export function formatWorkflowAge(
  generatedAt: number | undefined,
  at: number | undefined,
): string | undefined {
  if (generatedAt === undefined || at === undefined) return undefined;
  if (!Number.isFinite(generatedAt) || !Number.isFinite(at)) return undefined;
  return formatWorkflowDuration(generatedAt - at);
}

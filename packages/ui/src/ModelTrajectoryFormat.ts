/** locale 传界面语言；不传时沿用运行环境默认语言。 */
export function formatTrajectoryClockTime(value: string, locale?: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatTrajectoryDateTime(value: string, locale?: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toLocaleString(locale);
}

export function formatTrajectoryDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 2 : 1)}s`;
}

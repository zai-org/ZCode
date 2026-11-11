import {
  EXTENSION_LOG_BUFFER_LIMIT,
  type ExtensionLogEntry,
  type ExtensionLogLevel,
} from "@zcode/shared/extension-host";
import type {
  ExtensionLogLevelFilter,
  ExtensionLogSourceFilter,
} from "@/extension-slots/contract.js";

// 日志标签的纯函数（docs/plugins/extension-host.md §16.8）：合入、过滤、格式化。不读 store，不做 IO。

const LEVEL_RANK: Record<ExtensionLogLevel, number> = { info: 0, warn: 1, error: 2 };
const MIN_LEVEL_RANK: Record<ExtensionLogLevelFilter, number> = { all: 0, warn: 1, error: 2 };

/** 追加已去重、按 seq 升序的条目，只留最近 limit 条（与 Main 的缓冲同一上限）。 */
export function appendExtensionLogs(
  current: readonly ExtensionLogEntry[],
  incoming: readonly ExtensionLogEntry[],
  limit: number = EXTENSION_LOG_BUFFER_LIMIT,
): ExtensionLogEntry[] {
  const next = current.length === 0 ? [...incoming] : [...current, ...incoming];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function filterExtensionLogs(
  entries: readonly ExtensionLogEntry[],
  source: ExtensionLogSourceFilter,
  level: ExtensionLogLevelFilter,
): ExtensionLogEntry[] {
  const minRank = MIN_LEVEL_RANK[level];
  const pluginId = source.startsWith("plugin:") ? source.slice("plugin:".length) : null;
  return entries.filter((entry) => {
    if (LEVEL_RANK[entry.level] < minRank) return false;
    if (source === "host") return entry.pluginId === undefined;
    if (pluginId !== null) return entry.pluginId === pluginId;
    return true;
  });
}

/** 当前条目里出现过的插件 id（来源过滤的选项），按字典序。 */
export function listExtensionLogPlugins(entries: readonly ExtensionLogEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) if (entry.pluginId) ids.add(entry.pluginId);
  return [...ids].sort();
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** 本地时间 `HH:MM:SS.mmm`：等宽列，不随语言变化。 */
export function formatExtensionLogTime(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 复制用的文本：每行 `时间 级别 [来源] 消息`；没有插件 id 的行来源是 hostLabel。 */
export function formatExtensionLogsForCopy(
  entries: readonly ExtensionLogEntry[],
  hostLabel: string,
): string {
  return entries
    .map(
      (entry) =>
        `${formatExtensionLogTime(entry.ts)} ${entry.level.toUpperCase()} [${entry.pluginId ?? `${hostLabel} gen=${entry.gen}`}] ${entry.message}`,
    )
    .join("\n");
}

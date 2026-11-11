import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLineIcon, CopyIcon, EraserIcon } from "lucide-react";
import type { ExtensionLogEntry } from "@zcode/shared/extension-host";
import {
  TID_EXTENSION_LOGS,
  TID_EXTENSION_LOGS_AUTO_SCROLL,
  TID_EXTENSION_LOGS_CLEAR,
  TID_EXTENSION_LOGS_COPY,
  TID_EXTENSION_LOGS_LEVEL_FILTER,
  TID_EXTENSION_LOGS_ROW,
  TID_EXTENSION_LOGS_SOURCE_FILTER,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useExtensionLogs } from "@/extension-slots/adapters/useExtensionLogs.js";
import {
  filterExtensionLogs,
  formatExtensionLogTime,
  formatExtensionLogsForCopy,
  listExtensionLogPlugins,
} from "@/extension-slots/domain/logSelectors.js";
import type {
  ExtensionLogLevelFilter,
  ExtensionLogSourceFilter,
  ExtensionLogsPaneProps,
} from "@/extension-slots/contract.js";

const EMPTY_ENTRIES: ExtensionLogEntry[] = [];
const LEVEL_FILTERS: Array<{ value: ExtensionLogLevelFilter; labelId: string }> = [
  { value: "all", labelId: "extensions.logs.level.all" },
  { value: "warn", labelId: "extensions.logs.level.warn" },
  { value: "error", labelId: "extensions.logs.level.error" },
];

/** 级别只用语义色的文字与行底色表达，文字本身可读（DESIGN.md「Color Usage Rules」）。 */
const LEVEL_ROW_CLASS: Record<ExtensionLogEntry["level"], string> = {
  info: "",
  warn: "bg-warning-surface",
  error: "bg-destructive-surface",
};
const LEVEL_TEXT_CLASS: Record<ExtensionLogEntry["level"], string> = {
  info: "text-foreground-subtlest",
  warn: "text-warning-surface-foreground",
  error: "text-destructive-surface-foreground",
};

const ExtensionLogRow = memo(function ExtensionLogRow({
  entry,
  hostLabel,
}: {
  entry: ExtensionLogEntry;
  hostLabel: string;
}) {
  const source = entry.pluginId ?? `${hostLabel} gen=${entry.gen}`;
  // 终端式的一行：元信息与消息连成一段文字，换行处悬挂缩进。
  // 修复：最初用 flex 分列，侧栏宽度下消息列只剩约 230px，长消息被挤成窄长条；
  // 超出时整段消息又换到下一行，各行对不齐。连成一段后续行用满整行宽度。
  return (
    <div
      data-testid={TID_EXTENSION_LOGS_ROW}
      data-seq={entry.seq}
      data-level={entry.level}
      data-gen={entry.gen}
      data-plugin-id={entry.pluginId}
      title={`${new Date(entry.ts).toLocaleString()} · gen=${entry.gen}`}
      className={cn(
        "min-w-0 py-0.5 pr-3 pl-9 -indent-6 font-mono text-ui-sm break-words whitespace-pre-wrap",
        LEVEL_ROW_CLASS[entry.level],
      )}
    >
      <span className="tabular-nums text-foreground-subtlest">
        {formatExtensionLogTime(entry.ts)}
      </span>{" "}
      {/* 级别补齐到 5 个字符，等宽字体下各行的来源列对齐。 */}
      <span className={LEVEL_TEXT_CLASS[entry.level]}>
        {entry.level.toUpperCase().padEnd(5)}
      </span>{" "}
      <span className="text-foreground-subtle">{source}</span>{" "}
      <span className="text-foreground">{entry.message}</span>
    </div>
  );
});

/**
 * 扩展日志标签页（docs/plugins/extension-host.md §16.8）：Main 日志缓冲在 Renderer 的投影。
 * 来源、级别过滤与自动滚动是标签内的状态；「清空」只清视图（store 记下 seq）。
 */
export function ExtensionLogsPane({ visible }: ExtensionLogsPaneProps) {
  const { intl } = useZCodeIntl();
  const model = useExtensionLogs();
  const [source, setSource] = useState<ExtensionLogSourceFilter>("all");
  const [level, setLevel] = useState<ExtensionLogLevelFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const entries = model?.entries ?? EMPTY_ENTRIES;
  const hostLabel = intl.formatMessage({ id: "extensions.logs.source.host" });
  const selectedPlugin = source.startsWith("plugin:") ? source.slice("plugin:".length) : null;
  const plugins = useMemo(() => listExtensionLogPlugins(entries), [entries]);
  // 已选的插件暂时没有条目（例如清空后）也留在选项里，选择不被悄悄换掉。
  const pluginOptions = useMemo(
    () =>
      selectedPlugin && !plugins.includes(selectedPlugin)
        ? [...plugins, selectedPlugin].sort()
        : plugins,
    [plugins, selectedPlugin],
  );
  const visibleEntries = useMemo(
    () => filterExtensionLogs(entries, source, level),
    [entries, level, source],
  );
  const lastVisibleSeq = visibleEntries[visibleEntries.length - 1]?.seq ?? 0;

  // 自动滚到底：新条目、过滤变化、标签重新可见时。
  useLayoutEffect(() => {
    if (!autoScroll || !visible) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [autoScroll, lastVisibleSeq, visible, visibleEntries.length]);

  const copy = async () => {
    const count = visibleEntries.length;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard-unavailable");
      }
      await navigator.clipboard.writeText(formatExtensionLogsForCopy(visibleEntries, hostLabel));
      toast(intl.formatMessage({ id: "extensions.logs.copied" }, { count }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.lifecycle.warn("[extension-slots] copy logs failed", { message });
      toast(intl.formatMessage({ id: "extensions.logs.copyFailed" }, { error: message }));
    }
  };

  const autoScrollLabel = intl.formatMessage({ id: "extensions.logs.autoScroll" });
  const copyLabel = intl.formatMessage({ id: "extensions.logs.copy" });
  const clearLabel = intl.formatMessage({ id: "extensions.logs.clear" });
  const placeholder = !model?.loaded
    ? intl.formatMessage({ id: "extensions.logs.loading" })
    : entries.length === 0
      ? intl.formatMessage({ id: "extensions.logs.empty" })
      : visibleEntries.length === 0
        ? intl.formatMessage({ id: "extensions.logs.noMatch" })
        : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid={TID_EXTENSION_LOGS}
      data-loaded={model?.loaded ? "true" : "false"}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Select
          value={source}
          onValueChange={(value) => setSource(value as ExtensionLogSourceFilter)}
        >
          <SelectTrigger
            className="max-w-56 min-w-0 rounded-lg"
            data-testid={TID_EXTENSION_LOGS_SOURCE_FILTER}
            aria-label={intl.formatMessage({ id: "extensions.logs.sourceFilter" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem className="pr-8" value="all">
              {intl.formatMessage({ id: "extensions.logs.source.all" })}
            </SelectItem>
            <SelectItem className="pr-8" value="host">
              {hostLabel}
            </SelectItem>
            {pluginOptions.map((pluginId) => (
              <SelectItem
                key={pluginId}
                className="pr-8"
                value={`plugin:${pluginId}`}
                data-plugin-id={pluginId}
              >
                <span className="font-mono">{pluginId}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={level} onValueChange={(value) => setLevel(value as ExtensionLogLevelFilter)}>
          <SelectTrigger
            className="min-w-0 rounded-lg"
            data-testid={TID_EXTENSION_LOGS_LEVEL_FILTER}
            aria-label={intl.formatMessage({ id: "extensions.logs.levelFilter" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {LEVEL_FILTERS.map((option) => (
              <SelectItem key={option.value} className="pr-8" value={option.value}>
                {intl.formatMessage({ id: option.labelId })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ControlHintTooltip title={autoScrollLabel}>
            <Button
              type="button"
              variant={autoScroll ? "secondary" : "ghost"}
              size="icon-md"
              aria-pressed={autoScroll}
              aria-label={autoScrollLabel}
              data-testid={TID_EXTENSION_LOGS_AUTO_SCROLL}
              onClick={() => setAutoScroll((current) => !current)}
            >
              <ArrowDownToLineIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={copyLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              aria-label={copyLabel}
              data-testid={TID_EXTENSION_LOGS_COPY}
              disabled={visibleEntries.length === 0}
              onClick={() => void copy()}
            >
              <CopyIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={clearLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              aria-label={clearLabel}
              data-testid={TID_EXTENSION_LOGS_CLEAR}
              disabled={entries.length === 0}
              onClick={() => model?.clear()}
            >
              <EraserIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1" role="log">
        {placeholder ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-ui-sm text-foreground-subtle">
            {placeholder}
          </div>
        ) : (
          visibleEntries.map((entry) => (
            <ExtensionLogRow key={entry.seq} entry={entry} hostLabel={hostLabel} />
          ))
        )}
      </div>
    </div>
  );
}

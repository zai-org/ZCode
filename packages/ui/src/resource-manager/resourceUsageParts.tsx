/**
 * 资源管理器 CPU / 内存 tab 的展示零件：双层指标卡、分组列表、进程行。
 * 只做格式化与布局，不持有任何指标状态。
 */
import { ChevronRight } from "lucide-react";
import type { ResourceUsageProcess } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { formatBytes, formatPercent, type ResourceUsageGroupView } from "./resourceUsageView.js";

export const UNSAMPLED_PLACEHOLDER = "—";

export type UsageMetric = "cpu" | "memory";

interface UsageMeterProps {
  testId: string;
  label: string;
  appValue: string;
  systemValue: string;
  appPercent: number;
  systemPercent: number;
  appLabel: string;
  systemLabel: string;
}

/** 双层进度条：灰色 = 整机总占用，brand = ZCode 自身占用；图例文字做颜色之外的第二编码 */
export function UsageMeter({
  testId,
  label,
  appValue,
  systemValue,
  appPercent,
  systemPercent,
  appLabel,
  systemLabel,
}: UsageMeterProps) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-4" data-testid={testId}>
      <div className="text-ui-sm font-medium text-foreground-subtle">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-ui-xl font-medium" data-testid={`${testId}-app`}>
          {appValue}
        </span>
        <span className="text-ui-xs text-foreground-subtlest">{appLabel}</span>
      </div>
      <div
        className="relative mt-3 h-2 overflow-hidden rounded-sm bg-surface-hover"
        role="img"
        aria-label={`${appLabel} ${appValue}, ${systemLabel} ${systemValue}`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-foreground-subtlest/40"
          style={{ width: `${systemPercent}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-brand"
          style={{ width: `${appPercent}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-brand" aria-hidden="true" />
          {appLabel}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-sm bg-foreground-subtlest/40" aria-hidden="true" />
          {systemLabel}
          <span className="font-mono text-foreground" data-testid={`${testId}-system`}>
            {systemValue}
          </span>
        </span>
      </div>
    </div>
  );
}

interface UsageGroupProps {
  group: ResourceUsageGroupView;
  metric: UsageMetric;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  emptyText: string;
  samplingText: string;
  columns: { process: string; pid: string; cpu: string; memory: string };
}

const ROW_GRID_CLASS = "grid grid-cols-[minmax(0,1fr)_72px_96px] items-center gap-2";

export function UsageGroup({
  group,
  metric,
  title,
  expanded,
  onToggle,
  emptyText,
  samplingText,
  columns,
}: UsageGroupProps) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-card-border bg-card"
      data-testid={`resource-manager-group-${group.category}`}
    >
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-hover"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-foreground-subtle transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium">{title}</span>
        <span className="rounded-sm bg-tag px-1.5 text-ui-xs text-foreground-subtle">
          {group.processCount}
        </span>
        <span className="w-24 text-right font-mono text-ui-sm text-foreground-subtle">
          {metric === "cpu" ? formatPercent(group.cpuPercent) : formatBytes(group.memoryBytes)}
        </span>
      </button>
      {expanded ? (
        group.processes.length === 0 ? (
          <div className="border-t border-border px-3 py-2 text-ui-sm text-foreground-subtlest">
            {emptyText}
          </div>
        ) : (
          <div className="border-t border-border">
            <div
              className={cn(
                ROW_GRID_CLASS,
                "h-7 border-b border-border px-3 text-ui-xs font-medium text-foreground-subtle",
              )}
            >
              <div>{columns.process}</div>
              <div className="text-right">{columns.pid}</div>
              <div className="text-right">{metric === "cpu" ? columns.cpu : columns.memory}</div>
            </div>
            {group.processes.map((process) => (
              <ProcessRow
                key={process.pid}
                process={process}
                metric={metric}
                samplingText={samplingText}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function ProcessRow({
  process,
  metric,
  samplingText,
}: {
  process: ResourceUsageProcess;
  metric: UsageMetric;
  samplingText: string;
}) {
  return (
    <div
      className={cn(
        ROW_GRID_CLASS,
        "min-h-8 border-b border-border px-3 text-ui-sm last:border-b-0",
      )}
      data-testid="resource-manager-process-row"
      data-process-name={process.name}
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground" title={process.name}>
          {process.name}
        </div>
        {process.category === "builtin-plugin" || process.category === "community-plugin" ? (
          <div className="truncate text-ui-xs text-foreground-subtlest" title={process.groupLabel}>
            {process.groupLabel}
          </div>
        ) : null}
      </div>
      <div className="text-right font-mono text-foreground-subtle">{process.pid}</div>
      <div
        className="text-right font-mono text-foreground-subtle"
        title={process.sampled ? undefined : samplingText}
      >
        {!process.sampled
          ? UNSAMPLED_PLACEHOLDER
          : metric === "cpu"
            ? formatPercent(process.cpuPercent)
            : formatBytes(process.memoryBytes)}
      </div>
    </div>
  );
}

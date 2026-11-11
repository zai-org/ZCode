import { useLayoutEffect, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { FlipMetricValue } from "@/components/ui/flip-metric-value.js";
import { getPathLeaf } from "@/lib/path.js";
import { inferEditOperation } from "@/ToolCallBlocks/fileSummaries.js";
import type {
  EditKindSource,
  EditKindLabelId,
  EditOperationKind,
  RawToolCallFileSummary,
} from "@/ToolCallBlocks/fileSummaryTypes.js";

export function renderDiffCount(
  changeStat?: {
    added: number;
    removed: number;
  },
  options?: { animateInitial?: boolean },
) {
  if (!changeStat) {
    return null;
  }

  if (changeStat.added <= 0 && changeStat.removed <= 0) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
      {changeStat.added > 0 ? (
        <span
          aria-label={`+${changeStat.added}`}
          className="inline-flex items-center text-diff-added"
          role="text"
          title={`+${changeStat.added}`}
        >
          +{/* 性能修复：投影已按秒给出真实统计，数字只做一次短翻页，不再逐行 rAF 追赶。 */}
          <FlipMetricValue
            value={String(changeStat.added)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
      {changeStat.removed > 0 ? (
        <span
          aria-label={`-${changeStat.removed}`}
          className="inline-flex items-center text-diff-removed"
          role="text"
          title={`-${changeStat.removed}`}
        >
          -
          <FlipMetricValue
            value={String(changeStat.removed)}
            animateInitial={options?.animateInitial}
          />
        </span>
      ) : null}
    </span>
  );
}

export function renderFileSummaryName(name: string, path: string) {
  return (
    <ControlHintTooltip
      title={path}
      triggerClassName="min-w-0 shrink"
      className="max-w-[min(240px,calc(100vw-1rem))] text-center break-all"
    >
      <span data-tool-file-name className="min-w-0 truncate">
        {name}
      </span>
    </ControlHintTooltip>
  );
}

export function renderFileChip({
  summary,
  clickable = false,
  onClick,
  title,
  basePath,
}: {
  summary: RawToolCallFileSummary;
  clickable?: boolean;
  onClick?: () => void;
  title?: string;
  basePath?: string;
}) {
  const descriptor = resolveFileDisplayDescriptor(summary.path, {
    basePath,
  });
  const chipTitle = title ?? summary.path;

  if (clickable) {
    return (
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground hover:underline"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.();
        }}
      >
        <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
        {renderFileSummaryName(getPathLeaf(summary.path), chipTitle)}
      </button>
    );
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground">
      <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
      {renderFileSummaryName(getPathLeaf(summary.path), chipTitle)}
    </span>
  );
}

export function getEditKindLabelMessageId(
  operationKinds: EditOperationKind[],
  actionLabels: Array<RawToolCallFileSummary["actionLabel"]>,
  isRunning: boolean,
  source?: EditKindSource,
): EditKindLabelId {
  const inferredOperation = inferEditOperation(operationKinds, actionLabels, source);

  // 完成态曾回退到工具类型名，导致子项仍显示 Write / Edit；复用已有过去式文案。
  if (inferredOperation === "write") {
    return isRunning ? "chat.toolCall.edit.writing" : "chat.toolCall.edit.wrote";
  }

  if (inferredOperation === "delete") {
    return isRunning ? "chat.toolCall.edit.deleting" : "chat.toolCall.edit.deleted";
  }

  if (actionLabels.length === 0) {
    return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.edit.edited";
  }

  return isRunning ? "chat.toolCall.edit.editing" : "chat.toolCall.edit.edited";
}

export function renderJoinedFileChips(
  summaries: RawToolCallFileSummary[],
  options: {
    clickable?: boolean;
    onClick?: (summary: RawToolCallFileSummary) => void;
    basePath?: string;
  } = {},
) {
  return (
    <div className="inline-flex min-w-0 items-center">
      {summaries.map((summary, index) => (
        <span key={summary.path} className="inline-flex min-w-0 items-center">
          {index > 0 ? <span className="mx-1 text-foreground-subtlest">,</span> : null}
          {renderFileChip({
            summary,
            clickable: options.clickable,
            basePath: options.basePath,
            onClick: options.onClick ? () => options.onClick?.(summary) : undefined,
          })}
        </span>
      ))}
    </div>
  );
}

/** 仅复用旧 Changes 的响应式文件展示，不持有工具运行态或分组状态。 */
export function CollapsedChangeSummary({
  files,
  label,
  basePath,
  onOpenFile,
}: {
  files: readonly RawToolCallFileSummary[];
  label: string;
  basePath?: string;
  onOpenFile?: (file: RawToolCallFileSummary) => void;
}) {
  const listRef = useRef<HTMLSpanElement>(null);
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const overflowRef = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(files.length);
  useLayoutEffect(() => {
    const list = listRef.current;
    const boundary = list?.closest<HTMLElement>("[data-consecutive-summary-group]");
    if (!list || !boundary) return;
    const update = () => {
      // 按整组右边界测量；按收缩后的列表宽度计算会越藏越窄。预留箭头及间距 24px。
      const available = Math.max(
        0,
        boundary.getBoundingClientRect().right - list.getBoundingClientRect().left - 24,
      );
      const widths = files.map((_, index) => chipRefs.current[index]?.offsetWidth ?? 0);
      const total =
        widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 8;
      let count = files.length;
      if (total > available) {
        count = 0;
        let width = 0;
        for (const chipWidth of widths) {
          const next = width + chipWidth;
          if (next + (count + 1) * 8 + (overflowRef.current?.offsetWidth ?? 0) > available) break;
          width = next;
          count++;
        }
      }
      setVisibleCount((previous) => (previous === count ? previous : count));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(boundary);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [files]);
  const visible = Math.min(visibleCount, files.length);
  return (
    <span className="flex min-w-0 max-w-full items-center gap-2" data-change-summary-files>
      <span className="min-w-0">{label}</span>
      <span ref={listRef} className="relative inline-flex min-w-0 items-center gap-2">
        {files.map((file, index) => (
          <span
            key={file.path}
            ref={(element) => {
              chipRefs.current[index] = element;
            }}
            aria-hidden={index >= visible ? true : undefined}
            onKeyDown={onOpenFile ? (event) => event.stopPropagation() : undefined}
            className={
              index < visible
                ? "inline-flex shrink-0"
                : "pointer-events-none invisible absolute inline-flex shrink-0"
            }
          >
            {renderFileChip({
              summary: file,
              basePath,
              clickable: index < visible && Boolean(onOpenFile),
              onClick: () => onOpenFile?.(file),
            })}
          </span>
        ))}
        {visible < files.length ? (
          <span className="shrink-0" data-change-summary-overflow>
            +{files.length - visible}
          </span>
        ) : null}
        <span
          ref={overflowRef}
          aria-hidden
          className="pointer-events-none invisible absolute shrink-0"
        >
          +{files.length}
        </span>
      </span>
    </span>
  );
}

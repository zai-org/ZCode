"use client";

import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";

type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string;
  indeterminate?: boolean;
  segments?: readonly ProgressSegment[];
};

export interface ProgressSegment {
  className?: string;
  id: string;
  percent: number;
  style?: React.CSSProperties;
}

function Progress({
  className,
  indicatorClassName,
  indeterminate = false,
  segments,
  value,
  ...props
}: ProgressProps) {
  const normalizedValue = Math.min(Math.max(value ?? 0, 0), 100);
  const normalizedSegments =
    segments
      ?.map((segment) => ({
        ...segment,
        percent: Math.min(Math.max(segment.percent, 0), 1),
      }))
      .filter((segment) => segment.percent > 0) ?? [];

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-md bg-muted",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full",
          // left 动画需要定位；滚动阶段不沿用下载进度的宽度过渡。
          indeterminate ? "absolute inset-y-0" : "transition-[width]",
          normalizedSegments.length > 0 ? "flex overflow-hidden bg-transparent" : "bg-primary",
          (indeterminate || normalizedValue > 0) && indicatorClassName,
        )}
        style={{ width: indeterminate ? "35%" : `${normalizedValue}%` }}
      >
        {normalizedSegments.map((segment) => (
          <span
            aria-hidden="true"
            className={cn("h-full shrink-0", segment.className)}
            key={segment.id}
            style={{ ...segment.style, flexBasis: `${segment.percent * 100}%` }}
          />
        ))}
      </ProgressPrimitive.Indicator>
    </ProgressPrimitive.Root>
  );
}

export { Progress };

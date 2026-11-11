import { memo, useMemo, useState } from "react";
import {
  AnchorIcon,
  CircleSlash2Icon,
  CircleXIcon,
  ClockAlertIcon,
  LoaderCircle,
  ShieldAlertIcon,
} from "lucide-react";
import {
  TID_V4_HOOK_DETAILS_CONTENT,
  TID_V4_HOOK_DETAILS_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import type { HookExecutionProjection, HookInvocationRow } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type HookDetailStatus = "running" | "blocked" | "failed" | "cancelled" | "timedOut";

interface HookDetailItem {
  key: string;
  blockReason?: string;
  durationMs?: number;
  eventName: HookInvocationRow["hookEventName"];
  sourceKind: HookExecutionProjection["sourceKind"];
  status: HookDetailStatus | null;
}

function buildHookDetailItems(rows: readonly HookInvocationRow[]): HookDetailItem[] {
  const items: HookDetailItem[] = [];
  for (const row of rows) {
    for (const execution of row.executions.toSorted(
      (left, right) => left.hookIndex - right.hookIndex,
    )) {
      if (!execution.didExecute) continue;
      items.push({
        key: `${row.entityId}:${execution.hookRunId}`,
        ...(execution.outcome === "blocked" && execution.blockReason
          ? { blockReason: execution.blockReason }
          : {}),
        ...(execution.state !== "running" && execution.durationMs !== undefined
          ? { durationMs: execution.durationMs }
          : {}),
        eventName: row.hookEventName,
        sourceKind: execution.sourceKind,
        status: hookDetailStatus(execution),
      });
    }
  }
  return items;
}

function formatHookDuration(durationMs: number): string {
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  if (roundedDurationMs < 1000) return `${roundedDurationMs}ms`;
  return `${(roundedDurationMs / 1000).toFixed(roundedDurationMs < 10_000 ? 2 : 1)}s`;
}

function hookDetailStatus(execution: HookExecutionProjection): HookDetailStatus | null {
  if (execution.state === "running") return "running";
  if (execution.outcome === "timed_out") return "timedOut";
  if (execution.outcome === "cancelled") return "cancelled";
  if (execution.outcome === "blocked") return "blocked";
  if (execution.state === "failed" || execution.outcome === "failed") return "failed";
  return null;
}

const HookStatusIcon = memo(function HookStatusIcon({ status }: { status: HookDetailStatus }) {
  if (status === "running") {
    return (
      <LoaderCircle
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-foreground-subtle motion-reduce:animate-none"
      />
    );
  }
  if (status === "blocked") {
    return <ShieldAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />;
  }
  if (status === "timedOut") {
    return <ClockAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />;
  }
  if (status === "cancelled") {
    return <CircleSlash2Icon aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />;
  }
  return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />;
});

const HookDetailItemRow = memo(function HookDetailItemRow({ item }: { item: HookDetailItem }) {
  const { intl } = useZCodeIntl();
  const sourceLabel = intl.formatMessage({ id: `chat.hooks.source.${item.sourceKind}` });
  const durationLabel = item.durationMs === undefined ? null : formatHookDuration(item.durationMs);
  return (
    <li className="min-w-0 px-3 py-1.5 text-ui-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 break-words font-mono text-foreground">
          {item.eventName}
        </span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-ui-xs text-foreground-subtle">
          <span>{sourceLabel}</span>
          {durationLabel ? <span className="text-foreground-subtlest">{durationLabel}</span> : null}
          {item.status ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <HookStatusIcon status={item.status} />
              {intl.formatMessage({ id: `chat.hooks.state.${item.status}` })}
              {item.blockReason ? (
                <span className="min-w-0 break-words text-warning">：{item.blockReason}</span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
});

export const ConversationHookDetailsAction = memo(function ConversationHookDetailsAction({
  className,
  rows,
  turnId,
}: {
  className?: string;
  rows: readonly HookInvocationRow[];
  turnId: string;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const items = useMemo(() => buildHookDetailItems(rows), [rows]);
  if (items.length === 0) return null;

  const label = intl.formatMessage({ id: "chat.hooks.label" });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              className={cn(className)}
              data-testid={testId(TID_V4_HOOK_DETAILS_TRIGGER, turnId)}
            >
              <AnchorIcon className="size-3.5" />
              <span className="sr-only">{label}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={16}
        sticky="always"
        onOpenAutoFocus={(event) => event.preventDefault()}
        style={{
          maxHeight: "min(20rem, var(--radix-popover-content-available-height))",
        }}
        className="w-80 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border-popover-border p-0"
        data-testid={testId(TID_V4_HOOK_DETAILS_CONTENT, turnId)}
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <h3 className="text-ui-base font-medium text-foreground">{label}</h3>
        </div>
        <ul className="min-h-0 overflow-y-auto py-0.5">
          {items.map((item) => (
            <HookDetailItemRow key={item.key} item={item} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
});

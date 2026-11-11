import { memo, type ReactNode } from "react";
import { Ban, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_MENU,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  AutomationMoreHorizontalIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { formatRelativeToNow } from "@/settings/automationFormat.js";
import { savedWorkflowRunBadgeKind } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";

const MAX_ARG_CHIPS = 3;

/** 卡片「上次运行」徽标：四态 + 尚未运行。沿用定时任务卡的徽标形状（rounded-lg，20px 图标槽）。 */
export function SavedWorkflowLastRunBadge({
  run,
  now,
}: {
  run: ZCodeSavedWorkflowRun | undefined;
  now: number;
}) {
  const { intl } = useZCodeIntl();
  const kind = savedWorkflowRunBadgeKind(run?.status);
  if (kind === "never" || !run) {
    return (
      <span className="text-ui-base text-foreground-subtlest" data-workflow-last-run="never">
        {intl.formatMessage({ id: "workflows.hub.lastRun.never" })}
      </span>
    );
  }
  const when = formatRelativeToNow(run.updatedAt, now, intl);
  const label = `${intl.formatMessage({ id: `workflows.hub.lastRun.${kind}` })} · ${when}`;
  let icon: ReactNode;
  let className: string;
  switch (kind) {
    case "completed":
      icon = <CircleCheck className="size-4" strokeWidth={1.33} aria-hidden="true" />;
      className = "rounded-lg bg-success/10 text-success";
      break;
    case "errored":
      icon = <TriangleAlert className="size-4" strokeWidth={1.33} aria-hidden="true" />;
      className = "text-destructive";
      break;
    case "running":
      // running 用活动色 warning（与实例详情页状态头同源）。
      icon = <LoaderCircle className="size-4 animate-spin" strokeWidth={1.33} aria-hidden="true" />;
      className = "rounded-lg bg-warning/10 text-warning";
      break;
    case "stopped":
      icon = <Ban className="size-4" strokeWidth={1.33} aria-hidden="true" />;
      className = "text-foreground-subtle";
      break;
  }
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-0.5 py-0.5 pl-1 pr-2 text-ui-base font-normal",
        className,
      )}
      data-workflow-last-run={kind}
      title={label}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

interface SavedWorkflowCardProps {
  entry: ZCodeSavedWorkflowEntry;
  lastRun: ZCodeSavedWorkflowRun | undefined;
  now: number;
  busy?: boolean;
  onOpen: (entry: ZCodeSavedWorkflowEntry) => void;
  onRun: (entry: ZCodeSavedWorkflowEntry) => void;
  onRevise: (entry: ZCodeSavedWorkflowEntry) => void;
  onCopyPath: (entry: ZCodeSavedWorkflowEntry) => void;
  /** 作用域动作：项目档「提升为全局」（AI 概括）/ 全局档「移到项目…」；仅在传入时出现。 */
  onMove?: (entry: ZCodeSavedWorkflowEntry) => void;
  onDelete: (entry: ZCodeSavedWorkflowEntry) => void;
}

/**
 * 与定时任务卡同一张网格（132px 行、rounded-xl、p-3）：标题行 = 名字 + 右上「运行」与 ⋯；
 * 两行说明；底栏左 = 上次运行徽标、右 = 实参名芯片（最多 3 个 + `+N`）。整卡可点进详情。
 */
export const SavedWorkflowCard = memo(function SavedWorkflowCard({
  entry,
  lastRun,
  now,
  busy = false,
  onOpen,
  onRun,
  onRevise,
  onCopyPath,
  onMove,
  onDelete,
}: SavedWorkflowCardProps) {
  const { intl } = useZCodeIntl();
  const argNames = Object.keys(entry.args ?? {});
  const visibleArgs = argNames.slice(0, MAX_ARG_CHIPS);
  const hiddenArgCount = argNames.length - visibleArgs.length;
  const runLabel = intl.formatMessage({ id: "workflows.hub.card.run" });
  const menuLabel = intl.formatMessage({ id: "workflows.hub.card.menu" });

  return (
    <div
      data-testid={testId(TID_WORKFLOW_CARD, entry.name)}
      data-workflow-name={entry.name}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(entry);
        }
      }}
      className="group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
        <span className="block truncate pr-28 text-ui-base font-medium leading-5 text-foreground">
          {entry.name}
        </span>
        <p className="text-wrap-phrase line-clamp-2 h-10 text-ui-base font-normal leading-5 text-foreground-subtle">
          {entry.description}
        </p>
        <div className="mt-auto flex h-6 min-w-0 items-center gap-2 text-ui-base leading-5">
          <div className="flex min-w-0 flex-1 items-center">
            <SavedWorkflowLastRunBadge run={lastRun} now={now} />
          </div>
          {argNames.length === 0 ? null : (
            <div className="flex shrink-0 items-center gap-1" data-workflow-args="true">
              {visibleArgs.map((argName) => (
                <span
                  key={argName}
                  className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                >
                  {argName}
                </span>
              ))}
              {hiddenArgCount > 0 ? (
                <span className="font-mono text-ui-xs leading-none text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "workflows.hub.card.argsMore" },
                    { count: String(hiddenArgCount) },
                  )}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* 卡面动作与整卡点击分层：按钮 stopPropagation，键盘上也不会把 Enter 冒泡成「打开详情」。 */}
      <div
        className="absolute right-3 top-3 flex items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-icon="inline-start"
          data-testid={testId(TID_WORKFLOW_CARD_RUN, entry.name)}
          disabled={busy}
          onClick={() => onRun(entry)}
        >
          <AutomationRunNowIcon className="size-3" aria-hidden="true" />
          {runLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={menuLabel}
              data-testid={testId(TID_WORKFLOW_CARD_MENU, entry.name)}
              disabled={busy}
            >
              <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpen(entry)}>
              {intl.formatMessage({ id: "workflows.hub.card.open" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRevise(entry)}>
              {intl.formatMessage({ id: "workflows.hub.card.revise" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopyPath(entry)}>
              {intl.formatMessage({ id: "workflows.hub.card.copyPath" })}
            </DropdownMenuItem>
            {onMove ? (
              <DropdownMenuItem
                data-testid={testId(TID_WORKFLOW_ACTION_MOVE, entry.name)}
                onSelect={() => onMove(entry)}
              >
                {intl.formatMessage({
                  id:
                    entry.scope === "global"
                      ? "workflows.hub.card.moveToProject"
                      : "workflows.hub.card.promoteToGlobal",
                })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={testId(TID_WORKFLOW_ACTION_DELETE, entry.name)}
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete(entry)}
            >
              <AutomationTrashIcon />
              {intl.formatMessage({ id: "workflows.hub.card.delete" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

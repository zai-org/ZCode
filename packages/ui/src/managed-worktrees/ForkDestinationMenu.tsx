// assistant 行的"分叉"目的地菜单（docs/git/worktree.md §3.6）：在当前目录（或当前 worktree）分叉 /
// 在新 worktree 中分叉（带上未提交的改动）。
import { FolderGit2Icon, TrendingUpDownIcon } from "lucide-react";
import {
  testId,
  TID_V4_FORK,
  TID_V4_FORK_HERE,
  TID_V4_FORK_TO_WORKTREE,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ForkDestinationMenu({
  rowId,
  label,
  tooltip,
  worktreeAvailable,
  inWorktree,
  onForkHere,
  onForkToWorktree,
}: {
  rowId: string | number;
  label: string;
  tooltip?: string;
  worktreeAvailable: boolean;
  /** 父任务运行在受管 worktree 中：子任务共用这个 worktree。 */
  inWorktree: boolean;
  onForkHere: () => void;
  onForkToWorktree: () => void;
}) {
  const { intl } = useZCodeIntl();
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        size="icon-sm"
        type="button"
        variant="ghost"
        aria-label={label}
        data-testid={testId(TID_V4_FORK, String(rowId))}
      >
        <TrendingUpDownIcon className="size-3.5" />
        <span className="sr-only">{label}</span>
      </Button>
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu>
      {tooltip ? (
        <ControlHintTooltip title={tooltip} side="bottom">
          {trigger}
        </ControlHintTooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem
          data-testid={testId(TID_V4_FORK_HERE, String(rowId))}
          onSelect={onForkHere}
        >
          <TrendingUpDownIcon className="size-4" />
          <span className="min-w-0">
            {intl.formatMessage({
              id: inWorktree ? "chat.message.fork.hereWorktree" : "chat.message.fork.here",
            })}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={testId(TID_V4_FORK_TO_WORKTREE, String(rowId))}
          disabled={!worktreeAvailable}
          onSelect={onForkToWorktree}
          title={
            worktreeAvailable
              ? undefined
              : intl.formatMessage({ id: "chat.message.fork.worktreeUnsupported" })
          }
        >
          <FolderGit2Icon className="size-4" />
          <span className="flex min-w-0 flex-col">
            <span>{intl.formatMessage({ id: "chat.message.fork.toWorktree" })}</span>
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({
                id: worktreeAvailable
                  ? "chat.message.fork.toWorktreeHint"
                  : "chat.message.fork.worktreeUnsupported",
              })}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

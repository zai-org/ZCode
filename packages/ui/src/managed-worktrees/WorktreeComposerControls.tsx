// 新建任务 composer 头部的 worktree 复选框与分支选择（docs/git/worktree.md §3.2）。
// 开关与所选分支存放在 session store 的草稿状态，每次新建草稿重置为关闭；这里不持有第二份状态。
import { CheckIcon, ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ManagedWorktreeStartRefs } from "@zcode/shared";
import { TID_WORKTREE_TOGGLE } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";

/** 分支很多时只展示前若干项，保持菜单紧凑。 */
const MAX_LISTED_REFS = 30;
const SHORT_SHA_LENGTH = 7;

export function WorktreeToggle({
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** 允许调用方做位置对齐；高度固定 `h-7`，与项目/分支胶囊的 Button `size="default"` 一致。 */
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <label
      title={intl.formatMessage({ id: "git.managedWorktree.toggle.tooltip" })}
      className={cn(
        "flex h-7 shrink-0 cursor-pointer select-none items-center gap-2 rounded-full px-3 text-ui-base/relaxed text-foreground-subtle hover:bg-hover hover:text-foreground",
        className,
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Checkbox
        data-testid={TID_WORKTREE_TOGGLE}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span>{intl.formatMessage({ id: "git.managedWorktree.toggle.label" })}</span>
    </label>
  );
}

/**
 * worktree 模式下的分支胶囊：只记录新 worktree 从哪个分支检出，不切换主目录（§3.2）。
 * 文字与普通分支胶囊相同，只显示分支名。
 */
export function WorktreeBranchPicker({
  projectId,
  selectedRef,
  currentBranchLabel,
  onSelect,
  className,
}: {
  projectId: string;
  /** null = 当前 HEAD。 */
  selectedRef: string | null;
  /** 主目录当前分支名（来自 Git 摘要），用于 selectedRef 为 null 时的显示。 */
  currentBranchLabel: string;
  onSelect: (ref: string | null) => void;
  /** 与 GitBranchSwitcher 的外层 className 一致，切换复选框时头部布局不变（§3.3）。 */
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const { managedWorktreeService } = useServices();
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<ManagedWorktreeStartRefs | null>(null);

  useEffect(() => {
    if (!open || !managedWorktreeService) return;
    let disposed = false;
    void managedWorktreeService.listStartRefs({ projectId }).then(
      (next) => {
        if (!disposed) setRefs(next);
      },
      (error: unknown) => logger.warn("[worktree] 读取分支候选失败", { error }),
    );
    return () => {
      disposed = true;
    };
  }, [managedWorktreeService, open, projectId]);

  const head = refs?.head ?? null;
  const headLabel = head
    ? (head.branchName ??
      intl.formatMessage(
        { id: "git.managedWorktree.ref.detached" },
        { sha: head.sha.slice(0, SHORT_SHA_LENGTH) },
      ))
    : currentBranchLabel;
  const triggerLabel = selectedRef ?? currentBranchLabel;

  return (
    <div className={cn("flex items-center px-1 pt-2", className)}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            data-worktree-branch-picker="true"
            aria-label={intl.formatMessage({ id: "git.managedWorktree.ref.title" })}
            className="min-w-0 max-w-full rounded-full pl-3 pr-2 text-ui-base/relaxed"
          >
            <GitBranchIcon className="size-4 text-foreground-subtle" />
            <span className="min-w-0 max-w-25 truncate text-left">{triggerLabel}</span>
            <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          avoidCollisions={false}
          className="max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "git.managedWorktree.ref.title" })}
          </DropdownMenuLabel>
          <RefItem
            label={intl.formatMessage(
              { id: "git.managedWorktree.ref.currentHead" },
              { ref: headLabel },
            )}
            selected={selectedRef === null}
            onSelect={() => onSelect(null)}
          />
          <RefGroup
            label={intl.formatMessage({ id: "git.managedWorktree.ref.localBranches" })}
            refs={refs?.localBranches ?? []}
            selectedRef={selectedRef}
            onSelect={onSelect}
          />
          <RefGroup
            label={intl.formatMessage({ id: "git.managedWorktree.ref.remoteBranches" })}
            refs={refs?.remoteBranches ?? []}
            selectedRef={selectedRef}
            onSelect={onSelect}
          />
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "git.managedWorktree.ref.note" })}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RefItem({
  label,
  selected,
  onSelect,
  mono,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  mono?: boolean;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="justify-between gap-2">
      <span className={cn("min-w-0 truncate", mono && "font-mono text-ui-sm")} title={label}>
        {label}
      </span>
      {selected ? <CheckIcon className="size-4 shrink-0" /> : null}
    </DropdownMenuItem>
  );
}

function RefGroup({
  label,
  refs,
  selectedRef,
  onSelect,
}: {
  label: string;
  refs: readonly string[];
  selectedRef: string | null;
  onSelect: (ref: string) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">{label}</DropdownMenuLabel>
      {refs.slice(0, MAX_LISTED_REFS).map((ref) => (
        <RefItem
          key={ref}
          label={ref}
          mono
          selected={selectedRef === ref}
          onSelect={() => onSelect(ref)}
        />
      ))}
    </>
  );
}

// worktree 创建的 git 输出与"已创建 worktree"历史项共用的展示块（docs/git/worktree.md §3.3）。
import { ChevronRightIcon, FolderGit2Icon, LoaderCircle, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeOutputBlock({
  title,
  status,
  output,
  defaultExpanded = false,
  testId,
  phase,
  children,
}: {
  title: ReactNode;
  status: "running" | "done" | "failed";
  output: string;
  defaultExpanded?: boolean;
  testId?: string;
  phase?: string;
  /** 卡片底部的操作区（创建失败时的按钮）。 */
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasOutput = output.trim().length > 0;
  return (
    <div
      data-testid={testId}
      data-phase={phase}
      className="flex w-full min-w-0 flex-col gap-2 text-ui-base text-foreground-subtle"
    >
      <button
        type="button"
        disabled={!hasOutput}
        aria-expanded={hasOutput ? expanded : undefined}
        aria-label={intl.formatMessage({
          id: expanded
            ? "git.managedWorktree.creation.hideOutput"
            : "git.managedWorktree.creation.showOutput",
        })}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-fit min-w-0 items-center gap-2 rounded-md text-left hover:text-foreground disabled:cursor-default disabled:hover:text-foreground-subtle"
      >
        {status === "running" ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
        ) : status === "failed" ? (
          <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
        ) : (
          <FolderGit2Icon className="size-4 shrink-0" />
        )}
        <span className={cn("min-w-0 truncate", status === "failed" && "text-foreground")}>
          {title}
        </span>
        {hasOutput ? (
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
          />
        ) : null}
      </button>
      {hasOutput && expanded ? (
        <pre className="max-h-60 w-full overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-sm whitespace-pre-wrap break-all text-foreground">
          {output}
        </pre>
      ) : null}
      {children}
    </div>
  );
}

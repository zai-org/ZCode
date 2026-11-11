// 项目菜单 → Worktrees 管理弹窗（docs/git/worktree.md §3.6、§3.7、§3.8）。
// 列表每次打开都向 Host 重新读取；删除、移除记录后同样重新读取，不在 UI 侧推算结果。
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranch,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import type { EditorInfo, ManagedWorktreeError } from "@zcode/shared";
import type {
  IManagedWorktreeService,
  ManagedWorktreeEntry,
  ManagedWorktreeTask,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { useManagedWorktreeList } from "@/project-sidebar/useManagedWorktrees.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { isFileManagerOpenTarget, sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";

type ZCodeIntl = ReturnType<typeof useZCodeIntl>["intl"];

interface RowError {
  message: string;
  detail?: string;
}

/** 名称格式固定为 `<仓库名> · <bucket>`；仓库名取源仓库目录名，兼容 Windows 分隔符。 */
function worktreeName(worktree: ManagedWorktreeEntry): string {
  return `${getPathLeaf(worktree.sourceRoot)} · ${worktree.bucket}`;
}

/** 只按结构化 code（及 in-use 的 detail）选择文案，不解析 git 原始报错。 */
function describeRemoveError(intl: ZCodeIntl, error: ManagedWorktreeError): RowError {
  const msg = (id: string) => intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` });
  if (error.code === "worktree-dirty") return { message: msg("error.dirty") };
  if (error.code === "worktree-in-use" && error.detail === "running")
    return { message: msg("error.running") };
  if (error.code === "worktree-in-use" && error.detail === "terminal")
    return { message: msg("error.terminal") };
  if (error.code === "worktree-in-use" && error.detail === "creating")
    return { message: msg("error.creating") };
  if (error.code === "worktree-in-use" && error.detail === "tasks")
    return { message: msg("error.tasks") };
  if (error.code === "worktree-in-use" && error.detail === "removing")
    return { message: msg("error.removing") };
  if (error.code === "session-close-failed") return { message: msg("error.sessionClose") };
  return { message: msg("error.generic"), detail: error.detail || error.code };
}

/** 外部编辑器沿用顶部编辑器按钮持久化的偏好；文件管理器单独成项，不作为编辑器候选。 */
function usePreferredEditor(): EditorInfo | null {
  const platform = usePlatform();
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  useEffect(() => {
    let disposed = false;
    platform
      .getInstalledEditors()
      .then((installed) => {
        if (!disposed) setEditors(installed);
      })
      .catch((error: unknown) => {
        logger.warn("[managed-worktree] 获取已安装编辑器失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [platform]);
  return useMemo(() => {
    const candidates = sortInstalledEditorsForOpenWith(editors).filter(
      (editor) => !isFileManagerOpenTarget(editor),
    );
    const preferredId = readLastSelectedEditorId();
    return candidates.find((editor) => editor.id === preferredId) ?? candidates[0] ?? null;
  }, [editors]);
}

/** 图标按钮 + 提示。禁用原因用 aria-disabled 表达，保留键盘焦点，让提示仍可通过键盘读到。 */
function IconAction({
  label,
  disabledReason,
  onClick,
  className,
  children,
  testId,
}: {
  label: string;
  disabledReason?: string;
  onClick(): void;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const disabled = Boolean(disabledReason);
  return (
    <ControlHintTooltip title={disabledReason ?? label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        className={cn(
          "rounded-lg text-foreground-subtle hover:text-foreground",
          className,
          // 禁用态放在最后，覆盖调用方的 hover 强调色（如删除的 destructive）。
          disabled &&
            "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-foreground-subtle",
        )}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

function TaskActions({
  tasks,
  onOpenTask,
}: {
  tasks: ManagedWorktreeTask[];
  onOpenTask(task: ManagedWorktreeTask): void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` });
  const buttonProps: ComponentProps<typeof Button> = {
    type: "button",
    variant: "outline",
    size: "sm",
    className: "rounded-lg",
  };
  const [task] = tasks;
  if (!task) return null;
  if (tasks.length === 1) {
    return (
      <ControlHintTooltip title={task.title || msg("untitledTask")}>
        <Button
          {...buttonProps}
          data-testid="managed-worktree-open-task"
          onClick={() => onOpenTask(task)}
        >
          {msg("openTask")}
        </Button>
      </ControlHintTooltip>
    );
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button {...buttonProps} data-testid="managed-worktree-open-task">
          {msg("openTask")}
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-80">
        {tasks.map((item) => (
          <DropdownMenuItem
            key={`${item.workspacePath}:${item.taskId}`}
            data-testid="managed-worktree-task-item"
            onSelect={() => onOpenTask(item)}
          >
            <span className="min-w-0 flex-1 break-words">{item.title || msg("untitledTask")}</span>
            {item.archived ? (
              <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                {msg("archived")}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorktreeRow({
  worktree,
  error,
  editor,
  pruning,
  busy,
  onOpenTask,
  onDelete,
  onPrune,
}: {
  worktree: ManagedWorktreeEntry;
  error?: RowError;
  editor: EditorInfo | null;
  pruning: boolean;
  busy: boolean;
  onOpenTask(task: ManagedWorktreeTask): void;
  onDelete(): void;
  onPrune(): void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` }, values);
  const platform = usePlatform();
  const { copyPath, revealInFileManager } = useFileContextActions({
    canOpenLocalFileManager: true,
  });
  const missing = worktree.state === "missing";
  const branch = worktree.branchName
    ? worktree.branchName
    : worktree.head
      ? msg("detached", { sha: worktree.head.slice(0, 7) })
      : null;
  const openInEditor = async () => {
    if (!editor) return;
    const result = await platform.openInEditor(editor.id, worktree.path, {
      pathKind: "directory",
    });
    if (result.success) return;
    logger.warn("[managed-worktree] 在编辑器中打开 worktree 失败", {
      path: worktree.path,
      editor: editor.id,
      error: result.error ?? "unknown-error",
    });
    toast(msg("openInEditorFailed", { editor: editor.name }));
  };
  return (
    <li
      data-testid="managed-worktree-row"
      data-path={worktree.path}
      data-state={worktree.state}
      className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-all text-ui-base font-medium text-foreground">
            {worktreeName(worktree)}
          </span>
          {missing ? (
            <Badge className="h-5 rounded-lg bg-tag px-2 text-ui-xs font-medium text-foreground-subtle">
              {msg("missing")}
            </Badge>
          ) : null}
          {worktree.dirty ? (
            <Badge className="h-5 rounded-lg bg-warning-surface px-2 text-ui-xs font-medium text-warning-surface-foreground">
              {msg("dirty")}
            </Badge>
          ) : null}
        </div>
        {branch ? (
          <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate font-mono">{branch}</span>
          </div>
        ) : null}
        <ControlHintTooltip title={worktree.path} triggerClassName="min-w-0 max-w-full">
          <span className="block truncate font-mono text-ui-sm text-foreground-subtlest">
            {worktree.path}
          </span>
        </ControlHintTooltip>
        {worktree.tasks.length === 0 ? (
          <span className="text-ui-sm text-foreground-subtlest">{msg("noTasks")}</span>
        ) : null}
        {error ? (
          <p role="alert" className="break-words text-ui-sm text-destructive">
            {error.message}
            {error.detail ? (
              <span className="mt-0.5 block break-all font-mono text-foreground-subtle">
                {error.detail}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <TaskActions tasks={worktree.tasks} onOpenTask={onOpenTask} />
        <IconAction
          label={intl.formatMessage({ id: "appHeader.copyPath" })}
          testId="managed-worktree-copy-path"
          onClick={() => void copyPath({ path: worktree.path, kind: "directory" })}
        >
          <Copy className="size-3.5" />
        </IconAction>
        {missing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-lg"
            data-testid="managed-worktree-prune"
            disabled={busy}
            onClick={onPrune}
          >
            {pruning ? <Spinner className="size-3.5" /> : null}
            {msg("prune")}
          </Button>
        ) : (
          <>
            <IconAction
              label={getFileManagerLabel(intl)}
              testId="managed-worktree-reveal"
              onClick={() => void revealInFileManager({ path: worktree.path, kind: "directory" })}
            >
              <FolderOpen className="size-3.5" />
            </IconAction>
            {editor ? (
              <IconAction
                label={intl.formatMessage(
                  { id: "appHeader.openInEditor" },
                  { editor: editor.name },
                )}
                testId="managed-worktree-open-editor"
                onClick={() => void openInEditor()}
              >
                <SquareArrowOutUpRight className="size-3.5" />
              </IconAction>
            ) : null}
            {/* 创建中的 worktree 由创建记录的"放弃"处理，不显示删除（§3.11）。
                有任务使用且有改动时禁用；没有任务时允许强制删除，确认框写明会丢弃改动。
                删除时 Host 仍会重新检查所有条件。 */}
            {worktree.creating ? null : (
              <IconAction
                label={msg("delete")}
                testId="managed-worktree-delete"
                disabledReason={
                  worktree.dirty && worktree.tasks.length > 0 ? msg("error.dirty") : undefined
                }
                className="hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" />
              </IconAction>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function ManagedWorktreesDialog({
  project,
  service,
  onClose,
  onOpenTask,
}: {
  project: VirtualProject;
  service: IManagedWorktreeService;
  onClose(): void;
  onOpenTask: ProjectSidebarProps["onSelectTask"];
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` }, values);
  const { groups, loading, error, reload } = useManagedWorktreeList(service, project.id);
  const editor = usePreferredEditor();
  const [confirming, setConfirming] = useState<ManagedWorktreeEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const [pruningRoot, setPruningRoot] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const busy = removing || pruningRoot !== null;
  const visibleGroups = (groups ?? []).filter((group) => group.worktrees.length > 0);

  const setRowError = (path: string, value: RowError | null) =>
    setRowErrors((previous) => {
      const next = { ...previous };
      if (value) next[path] = value;
      else delete next[path];
      return next;
    });

  const openTask = (task: ManagedWorktreeTask) => {
    void onOpenTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    onClose();
  };

  const confirmRemove = async () => {
    const target = confirming;
    if (!target || removing) return;
    setRemoving(true);
    setRowError(target.path, null);
    try {
      // 只有没有任务使用的残留 worktree 才允许丢弃改动（§3.11）；Host 会再次校验。
      const force = target.dirty === true && target.tasks.length === 0;
      const result = await service.removeWorktree({
        projectId: project.id,
        path: target.path,
        ...(force ? { force: true } : {}),
      });
      if (result.ok) {
        logger.info("[managed-worktree] 已删除 worktree", { path: target.path });
        await reload();
      } else {
        logger.warn("[managed-worktree] 删除 worktree 被拒绝", {
          path: target.path,
          code: result.error.code,
          detail: result.error.detail,
        });
        setRowError(target.path, describeRemoveError(intl, result.error));
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[managed-worktree] 删除 worktree 失败", { path: target.path, error: detail });
      setRowError(target.path, { message: msg("error.generic"), detail });
    } finally {
      setRemoving(false);
      setConfirming(null);
    }
  };

  const prune = async (worktree: ManagedWorktreeEntry) => {
    if (busy) return;
    setPruningRoot(worktree.sourceRoot);
    setRowError(worktree.path, null);
    try {
      await service.pruneWorktrees({ projectId: project.id, sourceRoot: worktree.sourceRoot });
      logger.info("[managed-worktree] 已清理缺失 worktree 记录", {
        sourceRoot: worktree.sourceRoot,
      });
      await reload();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      logger.warn("[managed-worktree] 清理 worktree 记录失败", {
        sourceRoot: worktree.sourceRoot,
        error: detail,
      });
      setRowError(worktree.path, { message: msg("pruneFailed"), detail });
    } finally {
      setPruningRoot(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="managed-worktrees-dialog"
        className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{msg("title")}</DialogTitle>
          <DialogDescription className="break-words">
            {msg("description", { project: project.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {error ? (
            <div
              role="alert"
              data-testid="managed-worktrees-error"
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-start"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui-base text-destructive">{msg("loadFailed")}</span>
                <span className="break-all font-mono text-ui-sm text-foreground-subtle">
                  {error}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 self-start rounded-lg"
                disabled={loading}
                onClick={() => void reload()}
              >
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            </div>
          ) : null}
          {groups === null && loading ? (
            <div className="flex items-center gap-2 py-6 text-ui-base text-foreground-subtle">
              <Spinner />
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : null}
          {groups !== null && visibleGroups.length === 0 ? (
            <p
              data-testid="managed-worktrees-empty"
              className="py-6 text-center text-ui-base text-foreground-subtle"
            >
              {msg("empty")}
            </p>
          ) : null}
          {visibleGroups.map((group) => (
            <section
              key={group.sourceRoot}
              data-testid="managed-worktree-group"
              className="flex min-w-0 flex-col gap-1.5"
            >
              <h3 className="break-all font-mono text-ui-sm font-normal text-foreground-subtle">
                {group.sourceRoot}
              </h3>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {group.worktrees.map((worktree) => (
                  <WorktreeRow
                    key={worktree.path}
                    worktree={worktree}
                    error={rowErrors[worktree.path]}
                    editor={editor}
                    pruning={pruningRoot === worktree.sourceRoot}
                    busy={busy}
                    onOpenTask={openTask}
                    onDelete={() => setConfirming(worktree)}
                    onPrune={() => void prune(worktree)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
      <AlertDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          // 删除进行中不允许关闭确认框，避免结果回写到已离开的上下文。
          if (!open && !removing) setConfirming(null);
        }}
      >
        <AlertDialogContent data-testid="managed-worktree-delete-confirm">
          {confirming ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="break-words">
                  {msg("confirm.title", { name: worktreeName(confirming) })}
                </AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>{msg("confirm.directory")}</li>
                    <li>{msg("confirm.ignored")}</li>
                    {confirming.dirty && confirming.tasks.length === 0 ? (
                      <li className="text-destructive">{msg("confirm.discardChanges")}</li>
                    ) : null}
                    <li>{msg("confirm.tasks")}</li>
                  </ul>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <p className="break-all font-mono text-ui-sm text-foreground-subtle">
                {confirming.path}
              </p>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={removing}>
                  {intl.formatMessage({ id: "common.cancel" })}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  data-testid="managed-worktree-delete-confirm-action"
                  disabled={removing}
                  onClick={(event) => {
                    // Action 默认点击即关闭；需要等删除结果，由 confirmRemove 结束后关闭。
                    event.preventDefault();
                    void confirmRemove();
                  }}
                >
                  {removing ? <Spinner className="size-3.5" /> : null}
                  {intl.formatMessage({ id: "common.delete" })}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

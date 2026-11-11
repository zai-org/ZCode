/* eslint-disable max-lines -- 顶部 Git 操作当前集中承载 trigger、commit dialog 和 push dialog；先按工作流边界收口，避免为了拆行数把状态机打散。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  GitCommitMessageConversationContext,
  GitIdentity,
  GitRepositorySummary,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchCommitPreviewFiles,
  getGitBranchCommitTotals,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import {
  canUseGitActionMenu,
  canPushGitBranch,
  resolveGitActionMenuPrimaryAction,
} from "@/git-action-menu/display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";
import {
  AlertCircleIcon,
  ArrowUpFromLine,
  CheckIcon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  LoaderCircle,
  SparklesIcon,
} from "lucide-react";

interface GitActionMenuProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  commitMessageConversationContext?: GitCommitMessageConversationContext | null;
  onRefreshGit: () => void;
  className?: string;
  triggerIconOnly?: boolean;
  triggerLayout?: "header" | "status-row";
}

type GitCommitPreviewFile = ReturnType<typeof buildGitBranchCommitPreviewFiles>[number];

const COMMIT_DIALOG_ACTION_IDS = ["commit", "commitAndPush", "push"] as const;
const GIT_COMMIT_MESSAGE_TEXTAREA_ID = "git-action-menu-commit-message";
const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";

type CommitDialogActionId = (typeof COMMIT_DIALOG_ACTION_IDS)[number];

function gitCommitActionItemTestId(actionId: CommitDialogActionId): string {
  return `${TID_GIT_COMMIT_ACTION_ITEM}-${actionId}`;
}

function isCommitDialogActionId(value: string): value is CommitDialogActionId {
  return COMMIT_DIALOG_ACTION_IDS.includes(value as CommitDialogActionId);
}

function isCommitMessageTextAreaTarget(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.id === GIT_COMMIT_MESSAGE_TEXTAREA_ID;
}

interface GitCommitDialogState {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  activeTaskChangeSummary: ZCodeTaskChangeSummary | null;
  stagedFiles: GitCommitPreviewFile[];
  unstagedFiles: GitCommitPreviewFile[];
}

interface GitCommitDialogProps {
  open: boolean;
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  pushEnabled: boolean;
  onRefreshGit: () => void;
  onOpenChange: (nextOpen: boolean) => void;
  onMessageChange: (nextValue: string) => void;
  onIncludeUnstagedChange: (nextValue: boolean) => void;
  onGenerateMessage: () => void;
  onSubmit: () => void;
  onSubmitAndPush: () => void;
  onPushOnly: () => void;
}

function getCommitDialogFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): GitCommitPreviewFile[] {
  return includeUnstaged ? [...state.unstagedFiles, ...state.stagedFiles] : state.stagedFiles;
}

function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): string[] {
  return Array.from(
    new Set(getCommitDialogFiles(state, includeUnstaged).map((file) => file.stagePath)),
  );
}

function CommitCommandActionItem({
  id,
  icon,
  label,
  shortcutLabel,
  disabled,
  loading,
  onSelect,
}: {
  id: CommitDialogActionId;
  icon: ReactNode;
  label: string;
  shortcutLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      data-testid={gitCommitActionItemTestId(id)}
      value={id}
      disabled={disabled}
      onSelect={() => {
        if (!disabled) {
          onSelect();
        }
      }}
      className={cn(
        "h-9 px-2.5 py-1.5 font-medium",
        disabled ? "cursor-default text-foreground-subtlest" : "text-foreground",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {loading ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
    </CommandItem>
  );
}

function GitCommitDialog({
  open,
  loading,
  state,
  workspacePath,
  message,
  error,
  mutationPending,
  generationPending,
  includeUnstaged,
  pushEnabled,
  onRefreshGit,
  onOpenChange,
  onMessageChange,
  onIncludeUnstagedChange,
  onGenerateMessage,
  onSubmit,
  onSubmitAndPush,
  onPushOnly,
}: GitCommitDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const [selectedActionId, setSelectedActionId] = useState<CommitDialogActionId>("commit");
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpenRef = useRef(false);
  const numberFormatter = new Intl.NumberFormat(locale);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const messageReady = message.trim().length > 0;
  const actionPending = mutationPending || generationPending;
  const selectedFiles = state ? getCommitDialogFiles(state, includeUnstaged) : [];
  const stagePaths = state ? getCommitDialogStagePaths(state, includeUnstaged) : [];
  const dirtyFileCount = state ? getCommitDialogStagePaths(state, true).length : 0;
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(selectedFiles);
  const displayChangeSummary = state?.activeTaskChangeSummary ?? null;
  const displayAdded = displayChangeSummary?.added ?? totalAdded;
  const displayRemoved = displayChangeSummary?.removed ?? totalRemoved;
  const hasSelectedChanges = stagePaths.length > 0;
  const hasUnstagedChanges = Boolean(state?.unstagedFiles.length);
  const commitActionDisabled =
    actionPending || !hasSelectedChanges || (!hasIdentity && state?.identity !== null);
  const pushOnlyDisabled = actionPending || !pushEnabled;
  const commitShortcutLabel = formatCommandShortcutLabel("⏎");
  const commitActions = useMemo(
    () => [
      {
        id: "commit" as const,
        icon: <GitCommitIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commit",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmit,
      },
      {
        id: "commitAndPush" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commitAndPush",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmitAndPush,
      },
      {
        id: "push" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.push",
        }),
        disabled: pushOnlyDisabled,
        loading: false,
        onSelect: onPushOnly,
      },
    ],
    [
      commitActionDisabled,
      intl,
      mutationPending,
      onPushOnly,
      onSubmit,
      onSubmitAndPush,
      pushOnlyDisabled,
    ],
  );

  useEffect(() => {
    if (open) {
      setSelectedActionId("commit");
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      messageInputFocusedOnOpenRef.current = false;
      return;
    }
    if (loading || !state || actionPending || messageInputFocusedOnOpenRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // 打开弹窗后的默认焦点要落在提交信息里，方便立即编辑或生成后微调。
      messageTextareaRef.current?.focus();
      messageInputFocusedOnOpenRef.current = true;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [actionPending, loading, open, state]);

  useEffect(() => {
    // 弹窗加载 Git 状态前提交动作会短暂不可用，不能在 loading 阶段把默认选择跳到推送。
    if (!open || loading || !state || actionPending) {
      return;
    }

    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (selectedAction && !selectedAction.disabled) {
      return;
    }

    const firstEnabledAction = commitActions.find((action) => !action.disabled);
    if (firstEnabledAction && firstEnabledAction.id !== selectedActionId) {
      setSelectedActionId(firstEnabledAction.id);
    }
  }, [actionPending, commitActions, loading, open, selectedActionId, state]);

  const triggerSelectedAction = useCallback(() => {
    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (!selectedAction || selectedAction.disabled) {
      return;
    }
    selectedAction.onSelect();
  }, [commitActions, selectedActionId]);

  const selectAdjacentAction = useCallback(
    (direction: 1 | -1) => {
      setSelectedActionId((currentActionId) => {
        const enabledActions = commitActions.filter((action) => !action.disabled);
        if (enabledActions.length === 0) {
          return currentActionId;
        }

        const currentIndex = enabledActions.findIndex((action) => action.id === currentActionId);
        if (currentIndex === -1) {
          return enabledActions[0]?.id ?? currentActionId;
        }

        const nextIndex =
          (currentIndex + direction + enabledActions.length) % enabledActions.length;
        return enabledActions[nextIndex]?.id ?? currentActionId;
      });
    },
    [commitActions],
  );

  const handleActionCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
    },
    [selectAdjacentAction],
  );

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if (
        isCommitMessageTextAreaTarget(event.target) &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        // 输入框保持焦点时也允许切换下方 Command 操作，避免键盘流断掉。
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (!matchesPrimaryShortcut(event, "Enter")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      triggerSelectedAction();
    },
    [selectAdjacentAction, triggerSelectedAction],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_GIT_COMMIT_DIALOG}
        showCloseButton={false}
        className="max-w-md gap-0 overflow-hidden border-popover-border bg-popover p-0 shadow-lg"
        onOpenAutoFocus={(event) => {
          if (!loading && state && !actionPending) {
            event.preventDefault();
          }
        }}
      >
        {loading ? (
          <div className="flex h-56 items-center justify-center px-5 py-5 text-foreground-subtle">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : state ? (
          <form
            className="space-y-0"
            onKeyDownCapture={handleDialogKeyDown}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              triggerSelectedAction();
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
              <GitBranchSwitcher
                workspacePath={workspacePath}
                gitSummary={state.summary}
                dirtyFileCount={dirtyFileCount}
                onRefreshGit={onRefreshGit}
                className="min-w-0 px-0 pt-0"
                triggerClassName="h-7 max-w-64 justify-start rounded-lg px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground [&>span]:max-w-48"
                popoverSide="bottom"
                popoverClassName="w-80"
                branchListClassName="max-h-56"
                showFooterActions={false}
              />
              <div className="flex shrink-0 items-center gap-1.5 font-mono text-ui-base">
                <span className="text-diff-added">+{numberFormatter.format(displayAdded)}</span>
                <span className="text-diff-removed">-{numberFormatter.format(displayRemoved)}</span>
              </div>
            </div>

            <div className="min-h-36 px-4 pb-2">
              <label htmlFor={GIT_COMMIT_MESSAGE_TEXTAREA_ID} className="sr-only">
                {intl.formatMessage({
                  id: "git.actionMenu.commitDialog.messageLabel",
                })}
              </label>
              <div className="relative">
                <Textarea
                  ref={messageTextareaRef}
                  data-testid={TID_GIT_COMMIT_MESSAGE_INPUT}
                  id={GIT_COMMIT_MESSAGE_TEXTAREA_ID}
                  value={message}
                  disabled={actionPending}
                  placeholder={intl.formatMessage({
                    id: "git.actionMenu.commitDialog.messagePlaceholder",
                  })}
                  className="field-sizing-fixed min-h-28 rounded-none border-0 bg-transparent px-0 py-2 pr-8 text-ui-base font-medium text-foreground shadow-none placeholder:text-foreground-subtle focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-ui-base"
                  onChange={(event) => {
                    onMessageChange(event.target.value);
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid={TID_GIT_COMMIT_GENERATE_BUTTON}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={onGenerateMessage}
                      disabled={
                        actionPending ||
                        !hasSelectedChanges ||
                        (!hasIdentity && state.identity !== null)
                      }
                      aria-label={intl.formatMessage({
                        id: messageReady
                          ? "git.actionMenu.commitDialog.regenerate"
                          : "git.actionMenu.commitDialog.generate",
                      })}
                      className="absolute right-0 top-1.5 text-foreground-subtle hover:text-foreground"
                    >
                      {generationPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <SparklesIcon className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" sideOffset={6}>
                    {intl.formatMessage({
                      id: messageReady
                        ? "git.actionMenu.commitDialog.regenerate"
                        : "git.actionMenu.commitDialog.generate",
                    })}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="px-2.5 pb-2">
              <button
                type="button"
                role="checkbox"
                data-testid={TID_GIT_COMMIT_INCLUDE_UNSTAGED}
                aria-checked={includeUnstaged}
                disabled={actionPending || !hasUnstagedChanges}
                onClick={() => onIncludeUnstagedChange(!includeUnstaged)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base font-medium transition-colors",
                  actionPending || !hasUnstagedChanges
                    ? "cursor-default text-foreground-subtle"
                    : "cursor-pointer text-foreground hover:bg-menu-hover",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border",
                      includeUnstaged
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-transparent",
                    )}
                  >
                    <CheckIcon className="size-3.5" />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {intl.formatMessage({
                    id: "git.actionMenu.commitDialog.includeUnstaged",
                  })}
                </span>
                <span className="shrink-0 text-ui-base font-normal text-foreground-subtle">
                  {intl.formatMessage(
                    {
                      id: "git.actionMenu.commitDialog.changesValue",
                    },
                    {
                      count: numberFormatter.format(fileCount),
                    },
                  )}
                </span>
              </button>
            </div>

            <div className="border-t border-border/50 px-2.5 py-2">
              {!hasIdentity ? (
                <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {intl.formatMessage({
                      id: "git.actionMenu.commitDialog.identityMissing",
                    })}
                  </p>
                </div>
              ) : null}

              {error ? <p className="px-3 py-1.5 text-ui-base text-destructive">{error}</p> : null}

              <Command
                data-testid={TID_GIT_COMMIT_ACTION_COMMAND}
                shouldFilter={false}
                loop
                tabIndex={0}
                value={selectedActionId}
                onValueChange={(nextValue) => {
                  if (isCommitDialogActionId(nextValue)) {
                    setSelectedActionId(nextValue);
                  }
                }}
                onKeyDown={handleActionCommandKeyDown}
                aria-label={intl.formatMessage({
                  id: "git.actionMenu.trigger.ariaLabel",
                })}
                className="rounded-none bg-transparent p-0 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <CommandList className="max-h-none scroll-py-1">
                  {commitActions.map((action) => (
                    <CommitCommandActionItem
                      key={action.id}
                      id={action.id}
                      icon={action.icon}
                      label={action.label}
                      shortcutLabel={
                        selectedActionId === action.id ? commitShortcutLabel : undefined
                      }
                      disabled={action.disabled}
                      loading={action.loading}
                      onSelect={action.onSelect}
                    />
                  ))}
                </CommandList>
              </Command>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface GitPushDialogProps {
  open: boolean;
  gitSummary: GitRepositorySummary;
  currentBranchLabel: string;
  pushEnabled: boolean;
  error: string | null;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onSubmit: () => void;
}

function GitPushDialog({
  open,
  gitSummary,
  currentBranchLabel,
  pushEnabled,
  error,
  mutationPending,
  onOpenChange,
  onSubmit,
}: GitPushDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [errorCopied, setErrorCopied] = useState(false);
  const descriptionId = gitSummary.trackingBranchName
    ? "git.actionMenu.pushDialog.description.tracked"
    : "git.actionMenu.pushDialog.description.untracked";

  const handleCopyError = useCallback(() => {
    if (!error) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.copyFailed" },
          { error: "clipboard-unavailable" },
        ),
      );
      return;
    }

    void navigator.clipboard.writeText(error).then(
      () => {
        setErrorCopied(true);
        window.setTimeout(() => {
          setErrorCopied(false);
        }, 1500);
      },
      (copyError: unknown) => {
        const message = copyError instanceof Error ? copyError.message : String(copyError);
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.error.copyFailed" },
            { error: message },
          ),
        );
      },
    );
  }, [error, intl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "git.actionMenu.pushDialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: descriptionId })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-6">
          {!error && (
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="space-y-3 border-t border-border/50 p-4 text-ui-base">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.upstreamLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {gitSummary.trackingBranchName
                      ? gitSummary.trackingBranchName
                      : intl.formatMessage({
                          id: "git.actionMenu.pushDialog.upstreamPending",
                        })}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.aheadBehindLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: "git.actionMenu.pushDialog.aheadBehindValue",
                      },
                      {
                        ahead: numberFormatter.format(gitSummary.ahead),
                        behind: numberFormatter.format(gitSummary.behind),
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.pushLabel",
                    })}
                  </div>
                  <div className="flex items-center gap-2 text-foreground-subtle">
                    <ArrowUpFromLine className="size-4" />
                    <span>
                      {intl.formatMessage({
                        id: "git.actionMenu.pushDialog.pushValue",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!pushEnabled ? (
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {intl.formatMessage({
                  id: "git.actionMenu.pushDialog.upToDate",
                })}
              </span>
            </div>
          ) : null}

          {error ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.error.summary",
                  })}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.error.detailsLabel",
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
                    onClick={handleCopyError}
                  >
                    {intl.formatMessage({
                      id: errorCopied
                        ? "git.actionMenu.pushDialog.error.copy.copied"
                        : "git.actionMenu.pushDialog.error.copy",
                    })}
                  </Button>
                </div>
                <Textarea
                  // Textarea 默认带 field-sizing-content，长错误文本会按内容扩张并把弹窗横向撑爆。
                  // 这里改成固定尺寸模式，并允许长内容换行，保证错误详情始终被限制在弹窗宽度内。
                  className="field-sizing-fixed w-full max-w-full min-h-56 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground whitespace-pre-wrap break-words placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  readOnly
                >
                  {error}
                </Textarea>
              </div>
            </>
          ) : null}

          <DialogFooter className="gap-2 pt-4">
            {error ? (
              <Button
                type="button"
                size="lg"
                onClick={() => onOpenChange(false)}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => onOpenChange(false)}
                  disabled={mutationPending}
                  className="h-10 min-w-0 px-5"
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  onClick={onSubmit}
                  disabled={mutationPending || !pushEnabled}
                  className="h-10 min-w-0 px-5"
                >
                  {mutationPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.confirm",
                  })}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GitActionMenu({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary = null,
  commitMessageConversationContext = null,
  onRefreshGit,
  className,
  triggerIconOnly = false,
  triggerLayout = "header",
}: GitActionMenuProps) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogLoading, setCommitDialogLoading] = useState(false);
  const [commitDialogState, setCommitDialogState] = useState<GitCommitDialogState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitIncludeUnstaged, setCommitIncludeUnstaged] = useState(true);
  const [commitMessageGenerationPending, setCommitMessageGenerationPending] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);

  const actionAvailable = canUseGitActionMenu(gitSummary);
  const currentBranchLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [gitSummary.branchName, gitSummary.headRefType, intl],
  );
  const commitEnabled = gitSummary.isDirty;
  const pushEnabled = canPushGitBranch(gitSummary);
  const triggerPending = mutationPending || commitMessageGenerationPending || commitDialogLoading;
  const primaryActionId = useMemo(
    () =>
      resolveGitActionMenuPrimaryAction({
        actionAvailable,
        commitEnabled,
        pushEnabled,
      }),
    [actionAvailable, commitEnabled, pushEnabled],
  );
  const primaryActionDisabled = !actionAvailable || triggerPending || primaryActionId === null;
  const isStatusRowTrigger = triggerLayout === "status-row";

  useEffect(() => {
    // 顶部 commit 入口改成“始终展示、异常时置灰”后，
    // 这里记录低频可用性日志，方便继续区分是仓库探测失败，
    // 还是 UI 交互本身出现了禁用/启用状态不一致。
    logger.info("[GitActionMenu] 顶部 Git 操作入口可用性变化", {
      workspacePath,
      available: actionAvailable,
      primaryActionDisabled,
      primaryActionId,
      isGitAvailable: gitSummary.isGitAvailable,
      isRepository: gitSummary.isRepository,
      headRefType: gitSummary.headRefType,
      branchName: gitSummary.branchName,
      trackingBranchName: gitSummary.trackingBranchName,
      isDirty: gitSummary.isDirty,
    });
  }, [
    gitSummary.branchName,
    gitSummary.headRefType,
    gitSummary.isDirty,
    gitSummary.isGitAvailable,
    gitSummary.isRepository,
    gitSummary.trackingBranchName,
    actionAvailable,
    primaryActionId,
    primaryActionDisabled,
    workspacePath,
  ]);

  const closeCommitDialog = useCallback(() => {
    setCommitDialogOpen(false);
    setCommitDialogLoading(false);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    setCommitMessageGenerationPending(false);
  }, []);

  const closePushDialog = useCallback(() => {
    setPushDialogOpen(false);
    setPushError(null);
  }, []);

  const openPushDialog = useCallback(() => {
    setPushError(null);
    setPushDialogOpen(true);
  }, []);

  const loadCommitDialogState = useCallback(
    async (options?: { resetMessage?: boolean }) => {
      setCommitDialogLoading(true);
      setCommitError(null);
      if (options?.resetMessage) {
        setCommitMessage("");
      }

      try {
        const refreshResult = await gitService.refresh({
          workspacePath,
          includeIdentity: true,
        });
        const rawUnstagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.unstagedChanges);
        const rawStagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.stagedChanges);
        const unstagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawUnstagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        const stagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawStagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        setCommitDialogState({
          summary: refreshResult.summary,
          activeTaskChangeSummary,
          identity: refreshResult.identity,
          stagedFiles,
          unstagedFiles,
        });
        setCommitIncludeUnstaged(unstagedFiles.length > 0);
        setCommitDialogLoading(false);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 读取提交弹窗状态失败", {
          workspacePath,
          error: message,
        });
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.commitDialog.error.requestFailed" },
            { error: message },
          ),
        );
        closeCommitDialog();
      }
    },
    [activeTaskChangeSummary, closeCommitDialog, gitService, intl, workspacePath],
  );

  const openCommitDialog = useCallback(async () => {
    setCommitDialogOpen(true);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    await loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState]);

  const refreshCommitDialogAfterBranchChange = useCallback(() => {
    onRefreshGit();
    void loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState, onRefreshGit]);

  const generateCommitMessage = useCallback(
    async (state: GitCommitDialogState, includeUnstaged: boolean): Promise<string> => {
      const files = getCommitDialogFiles(state, includeUnstaged);
      const currentSessionFilePaths = getCurrentSessionFilePaths(state.activeTaskChangeSummary);
      logger.info("[GitActionMenu] 开始生成提交消息", {
        workspacePath,
        branchName: gitSummary.branchName,
        selectedFileCount: files.length,
        currentSessionFileCount: currentSessionFilePaths?.length ?? 0,
        includeUnstaged,
        conversationMessageCount: commitMessageConversationContext?.messages.length ?? 0,
      });

      const result = await gitService.generateCommitMessage({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        locale,
        includeUnstaged,
        ...(currentSessionFilePaths ? { currentSessionFilePaths } : {}),
        ...(commitMessageConversationContext
          ? { conversationContext: commitMessageConversationContext }
          : {}),
      });

      logger.info("[GitActionMenu] 提交消息生成成功", {
        workspacePath,
        branchName: gitSummary.branchName,
        providerId: result.providerId,
        model: result.model,
      });
      return result.message;
    },
    [
      commitMessageConversationContext,
      gitService,
      gitSummary.branchName,
      locale,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!commitDialogState) {
      return;
    }

    const stagePaths = getCommitDialogStagePaths(commitDialogState, commitIncludeUnstaged);
    if (stagePaths.length === 0) {
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.noChanges",
        }),
      );
      return;
    }

    setCommitError(null);
    setCommitMessageGenerationPending(true);

    try {
      const nextCommitMessage = await generateCommitMessage(
        commitDialogState,
        commitIncludeUnstaged,
      );
      setCommitMessage(nextCommitMessage);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 生成提交消息失败", {
        workspacePath,
        branchName: gitSummary.branchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.generateFailed",
        }),
      );
    } finally {
      setCommitMessageGenerationPending(false);
    }
  }, [
    commitIncludeUnstaged,
    commitDialogState,
    generateCommitMessage,
    gitSummary.branchName,
    intl,
    workspacePath,
  ]);

  const pushCurrentBranch = useCallback(
    async (options?: { showToast?: boolean }) => {
      const result = await gitService.push({ workspacePath });
      logger.info("[GitActionMenu] 推送更改成功", {
        workspacePath,
        branchName: result.branchName,
        trackingBranchName: result.trackingBranchName,
        remoteName: result.remoteName,
        setUpstream: result.setUpstream,
      });
      if (options?.showToast !== false) {
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.toast.success" },
            {
              target:
                result.trackingBranchName?.trim() ||
                result.branchName?.trim() ||
                currentBranchLabel,
            },
          ),
        );
      }
      return result;
    },
    [currentBranchLabel, gitService, intl, workspacePath],
  );

  const handleCommitAction = useCallback(
    async (options?: { pushAfterCommit?: boolean }) => {
      if (!commitDialogState) {
        return;
      }

      if (!hasGitCommitIdentity(commitDialogState.identity)) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.identityMissing",
          }),
        );
        return;
      }

      const includeUnstaged = commitIncludeUnstaged;
      const stagePaths = getCommitDialogStagePaths(commitDialogState, includeUnstaged);
      const pathsToStage = includeUnstaged ? stagePaths : [];
      if (stagePaths.length === 0) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.error.noChanges",
          }),
        );
        return;
      }

      let nextCommitMessage = commitMessage.trim();
      if (!nextCommitMessage) {
        setCommitError(null);
        setCommitMessageGenerationPending(true);
        try {
          nextCommitMessage = await generateCommitMessage(commitDialogState, includeUnstaged);
          setCommitMessage(nextCommitMessage);
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          logger.warn("[GitActionMenu] 生成提交消息失败", {
            workspacePath,
            branchName: gitSummary.branchName,
            error: message,
          });
          setCommitError(
            intl.formatMessage({
              id: "git.actionMenu.commitDialog.error.generateFailed",
            }),
          );
          return;
        } finally {
          setCommitMessageGenerationPending(false);
        }
      }

      setCommitError(null);
      setMutationPending(true);
      let committed = false;

      try {
        logger.info("[GitActionMenu] 开始提交当前更改", {
          workspacePath,
          branchName: gitSummary.branchName,
          selectedPathCount: stagePaths.length,
          stagedPathCount: pathsToStage.length,
          includeUnstaged,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        if (pathsToStage.length > 0) {
          await gitService.stagePaths({
            workspacePath,
            paths: pathsToStage,
          });
        }
        await gitService.commit({
          workspacePath,
          message: nextCommitMessage,
          paths: stagePaths,
          stagedOnly: !includeUnstaged,
        });
        committed = true;

        if (options?.pushAfterCommit) {
          await pushCurrentBranch({ showToast: false });
        }

        logger.info("[GitActionMenu] 提交当前更改成功", {
          workspacePath,
          branchName: gitSummary.branchName,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        toast(
          intl.formatMessage({
            id: options?.pushAfterCommit
              ? "git.actionMenu.commitDialog.toast.commitAndPushSuccess"
              : "git.actionMenu.commitDialog.toast.success",
          }),
        );
        closeCommitDialog();
        onRefreshGit();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 提交当前更改失败", {
          workspacePath,
          error: message,
          committed,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        setCommitError(
          intl.formatMessage(
            {
              id:
                committed && options?.pushAfterCommit
                  ? "git.actionMenu.commitDialog.error.pushAfterCommitFailed"
                  : "git.actionMenu.commitDialog.error.requestFailed",
            },
            { error: message },
          ),
        );
        if (committed) {
          onRefreshGit();
        }
      } finally {
        setMutationPending(false);
      }
    },
    [
      closeCommitDialog,
      commitIncludeUnstaged,
      commitDialogState,
      commitMessage,
      generateCommitMessage,
      gitService,
      gitSummary.branchName,
      intl,
      onRefreshGit,
      pushCurrentBranch,
      workspacePath,
    ],
  );

  const handleCommitSubmit = useCallback(async () => {
    await handleCommitAction();
  }, [handleCommitAction]);

  const handleCommitAndPushSubmit = useCallback(async () => {
    await handleCommitAction({ pushAfterCommit: true });
  }, [handleCommitAction]);

  const handlePushSubmit = useCallback(async () => {
    if (!pushEnabled) {
      return;
    }

    setMutationPending(true);
    setPushError(null);

    try {
      await pushCurrentBranch();
      closePushDialog();
      onRefreshGit();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 推送更改失败", {
        workspacePath,
        error: message,
      });
      setPushError(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [closePushDialog, intl, onRefreshGit, pushCurrentBranch, pushEnabled, workspacePath]);

  const handlePrimaryAction = useCallback(() => {
    if (primaryActionDisabled) {
      return;
    }

    runUserAction({
      input: { featureId: "workbench.git", action: "open", trigger: "button" },
      operation: () => {
        if (primaryActionId === "push") {
          openPushDialog();
          return;
        }
        void openCommitDialog();
      },
      completed: { resultSource: "local_commit" },
      failureStage: "git_action_open",
    });
  }, [openCommitDialog, openPushDialog, primaryActionId, primaryActionDisabled]);

  const handleStatusRowContainerClick = useCallback(() => {
    handlePrimaryAction();
  }, [handlePrimaryAction]);

  return (
    <>
      <div
        onClick={isStatusRowTrigger && !triggerIconOnly ? handleStatusRowContainerClick : undefined}
        className={cn(
          // macOS/Windows 小窗口下，顶部 Git 主按钮的中文文案会和分支入口、窗口控制区挤在同一行。
          // 在 header 容器变窄时只隐藏主按钮文字，保留图标入口，避免丢失核心 Git 操作。
          // transition-all 会把 scrollbar-color 等非合成属性也启动动画，
          // 进而触发整页 UpdateLayoutTree；Git 入口只需要颜色反馈，不动画尺寸和滚动条属性。
          "flex h-7 items-center overflow-hidden rounded-lg border border-border bg-input transition-colors hover:border-border-hover @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:justify-center",
          triggerIconOnly && "w-7 justify-center",
          isStatusRowTrigger &&
            "h-8 w-full justify-start rounded-lg border-0 bg-transparent hover:border-transparent hover:bg-hover @max-[560px]/workspace-header:w-full @max-[560px]/workspace-header:justify-start",
          className,
        )}
      >
        <Button
          data-testid={TID_GIT_ACTION_TRIGGER}
          type="button"
          variant="ghost"
          size="default"
          disabled={primaryActionDisabled}
          aria-label={intl.formatMessage({
            id: "git.actionMenu.trigger.ariaLabel",
          })}
          className={cn(
            "h-7 rounded-lg border-0 gap-1 px-1.5 @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:px-0 @max-[560px]/workspace-header:[&>span]:hidden",
            triggerIconOnly && "w-7 px-0 [&>span]:hidden",
            isStatusRowTrigger &&
              "h-8 min-w-0 w-full justify-start gap-2 px-2 text-left text-ui-base hover:bg-transparent hover:text-foreground @max-[560px]/workspace-header:w-auto @max-[560px]/workspace-header:[&>span]:inline",
          )}
          onClick={isStatusRowTrigger && !triggerIconOnly ? undefined : handlePrimaryAction}
        >
          {/* 主按钮进入 pending 时直接替换左侧动作图标，避免在紧凑头部里额外追加 loading 图标把按钮挤宽。*/}
          {triggerPending ? (
            <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
          ) : primaryActionId === "push" ? (
            <ArrowUpFromLine className="size-4 text-foreground" />
          ) : (
            <GitCommitIcon className="size-4 text-foreground" />
          )}
          <span className={cn(isStatusRowTrigger && "min-w-0 truncate")}>
            {intl.formatMessage({ id: "git.actionMenu.trigger" })}
          </span>
        </Button>
      </div>

      <GitCommitDialog
        open={commitDialogOpen}
        loading={commitDialogLoading}
        state={commitDialogState}
        workspacePath={workspacePath}
        message={commitMessage}
        error={commitError}
        mutationPending={mutationPending}
        generationPending={commitMessageGenerationPending}
        includeUnstaged={commitIncludeUnstaged}
        pushEnabled={pushEnabled}
        onRefreshGit={refreshCommitDialogAfterBranchChange}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeCommitDialog();
          }
        }}
        onMessageChange={setCommitMessage}
        onIncludeUnstagedChange={setCommitIncludeUnstaged}
        onGenerateMessage={() => {
          void handleGenerateCommitMessage();
        }}
        onSubmit={() => {
          void handleCommitSubmit();
        }}
        onSubmitAndPush={() => {
          void handleCommitAndPushSubmit();
        }}
        onPushOnly={() => {
          closeCommitDialog();
          openPushDialog();
        }}
      />

      <GitPushDialog
        open={pushDialogOpen}
        gitSummary={gitSummary}
        currentBranchLabel={currentBranchLabel}
        pushEnabled={pushEnabled}
        error={pushError}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closePushDialog();
          }
        }}
        onSubmit={() => {
          void handlePushSubmit();
        }}
      />
    </>
  );
}

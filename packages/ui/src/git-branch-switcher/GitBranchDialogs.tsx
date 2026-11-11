import { type FormEvent } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { AlertCircleIcon, GitBranchIcon, LoaderCircle } from "lucide-react";

interface GitBranchCreateDialogProps {
  open: boolean;
  branchName: string;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onBranchNameChange: (nextValue: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function GitBranchCreateDialog({
  open,
  branchName,
  mutationPending,
  onOpenChange,
  onBranchNameChange,
  onCancel,
  onSubmit,
}: GitBranchCreateDialogProps) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({
              id: "git.branchSwitcher.createDialog.title",
            })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({
              id: "git.branchSwitcher.createDialog.description",
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5 px-6 py-6"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="git-branch-switcher-create-input"
              className="inline-flex text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({
                id: "git.branchSwitcher.createDialog.nameLabel",
              })}
            </label>
            <Input
              id="git-branch-switcher-create-input"
              size="lg"
              autoFocus
              value={branchName}
              disabled={mutationPending}
              placeholder={intl.formatMessage({
                id: "git.branchSwitcher.createDialog.placeholder",
              })}
              className="h-10 rounded-lg bg-background/50"
              onChange={(event) => {
                onBranchNameChange(event.target.value);
              }}
            />
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "git.branchSwitcher.createDialog.helper",
              })}
            </p>
          </div>

          <DialogFooter className="gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={onCancel}
              disabled={mutationPending}
              className="h-10 min-w-0 px-5"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={mutationPending || branchName.trim().length === 0}
              className="h-10 min-w-0 px-5"
            >
              {mutationPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {intl.formatMessage({
                id: "git.branchSwitcher.createDialog.confirm",
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface GitBranchSwitchAssistDialogProps {
  step: GitBranchSwitchAssistDialogStep | null;
  state: GitBranchSwitchAssistState | null;
  currentBranchLabel: string;
  commitMessage: string;
  commitError: string | null;
  mutationPending: boolean;
  onClose: () => void;
  onOpenCommit: () => void;
  onCommitMessageChange: (nextValue: string) => void;
  onSubmit: () => void;
}

export function GitBranchSwitchAssistDialog({
  step,
  state,
  currentBranchLabel,
  commitMessage,
  commitError,
  mutationPending,
  onClose,
  onOpenCommit,
  onCommitMessageChange,
  onSubmit,
}: GitBranchSwitchAssistDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const descriptionId =
    state?.issue.code === "untracked-changes-would-be-overwritten"
      ? "git.branchSwitcher.blockedDialog.description.untracked"
      : "git.branchSwitcher.blockedDialog.description.tracked";
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);

  return (
    <Dialog
      open={Boolean(step && state)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      {step === "blocked" && state ? (
        <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="gap-2 px-6 py-5 pb-0">
            <DialogTitle className="text-lg font-medium text-foreground">
              {intl.formatMessage({
                id: "git.branchSwitcher.blockedDialog.title",
              })}
            </DialogTitle>
            <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: descriptionId })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 px-6 py-6">
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <p>
                {intl.formatMessage({
                  id: "git.branchSwitcher.blockedDialog.helper",
                })}
              </p>
            </div>

            <div className="rounded-xl bg-background/30">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.blockedDialog.filesLabel",
                  })}
                </div>
                <div className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage(
                    {
                      id: "git.branchSwitcher.commitDialog.changesValue",
                    },
                    {
                      count: numberFormatter.format(state.fileCount),
                    },
                  )}
                </div>
              </div>

              <div className="space-y-1 overflow-y-auto p-1 max-h-56 overflow-y-auto">
                {state.affectedFiles.map((file) => (
                  <div
                    key={file.repoRelativePath}
                    className="flex items-start justify-between gap-4 h-10 rounded-lg bg-background/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <FileDisplayInline
                        path={file.workspaceRelativePath}
                        options={{
                          className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                          fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                        }}
                      />
                    </div>
                    <div className="flex shrink-0 items-center gap-2 font-mono text-ui-base">
                      <span className="text-diff-added">+{file.added}</span>
                      <span className="text-diff-removed">-{file.removed}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={onClose}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={onOpenCommit}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({
                  id: "git.branchSwitcher.blockedDialog.submitAction",
                })}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      ) : null}

      {step === "commit" && state ? (
        <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="gap-2 px-6 py-5 pb-0">
            <DialogTitle className="text-lg font-medium text-foreground">
              {intl.formatMessage({
                id: "git.branchSwitcher.commitDialog.title",
              })}
            </DialogTitle>
            <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage(
                {
                  id: "git.branchSwitcher.commitDialog.description",
                },
                {
                  branchName: state.targetBranchName,
                },
              )}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-5 px-6 py-6"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border/50 p-4 text-ui-base">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.changesLabel",
                  })}
                </div>
                <div className="flex gap-2">
                  <span className="text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: "git.branchSwitcher.commitDialog.changesValue",
                      },
                      {
                        count: numberFormatter.format(state.fileCount),
                      },
                    )}
                  </span>
                  <span className="text-diff-added font-mono">
                    +{numberFormatter.format(state.totalAdded)}
                  </span>
                  <span className="text-diff-removed font-mono">
                    -{numberFormatter.format(state.totalRemoved)}
                  </span>
                </div>
              </div>
            </div>

            {!hasIdentity ? (
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <p>
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.identityMissing",
                  })}
                </p>
              </div>
            ) : null}

            <div>
              <div className="space-y-2">
                <label
                  htmlFor="git-branch-switcher-commit-message"
                  className="inline-flex text-ui-base font-medium text-foreground-subtle"
                >
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.messageLabel",
                  })}
                </label>
                <Textarea
                  id="git-branch-switcher-commit-message"
                  value={commitMessage}
                  disabled={mutationPending}
                  placeholder={intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.messagePlaceholder",
                  })}
                  className="min-h-32 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  onChange={(event) => {
                    onCommitMessageChange(event.target.value);
                  }}
                />
                <p className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({
                    id: "git.branchSwitcher.commitDialog.messageHelper",
                  })}
                </p>
              </div>
            </div>

            {commitError ? <p className="text-ui-base text-destructive">{commitError}</p> : null}

            <DialogFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={onClose}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={mutationPending || (!hasIdentity && state.identity !== null)}
                className="h-10 min-w-0 px-5"
              >
                {mutationPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {intl.formatMessage({
                  id: "git.branchSwitcher.commitDialog.confirm",
                })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

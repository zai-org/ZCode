// 发送后、会话创建前的展示（docs/git/worktree.md §3.3、§3.5）：用户消息 + 进度卡片 + 失败操作。
// 数据全部来自 Host 的创建记录；renderer 只发出操作，不推算阶段。
import { useCallback, useState } from "react";
import type { ManagedWorktreeCreation } from "@zcode/shared";
import {
  TID_WORKTREE_CREATION_CARD,
  TID_WORKTREE_CREATION_CONTINUE_LOCAL,
  TID_WORKTREE_CREATION_DISMISS,
  TID_WORKTREE_CREATION_RETRY,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { formatManagedWorktreeError } from "./managedWorktreeErrors.js";
import { WorktreeOutputBlock } from "./WorktreeOutputBlock.js";

type CreationAction = "retryCreation" | "continueWithoutWorktree" | "dismissCreation";

export function ManagedWorktreeCreationView({ creation }: { creation: ManagedWorktreeCreation }) {
  const { intl } = useZCodeIntl();
  const { managedWorktreeService } = useServices();
  const [pendingAction, setPendingAction] = useState<CreationAction | null>(null);

  const runAction = useCallback(
    (action: CreationAction) => {
      if (!managedWorktreeService) return;
      setPendingAction(action);
      void managedWorktreeService[action]({ creationId: creation.id })
        .catch((error: unknown) => {
          logger.warn("[worktree] 创建记录操作失败", { action, error });
          toast(formatManagedWorktreeError(intl, error));
        })
        .finally(() => setPendingAction(null));
    },
    [creation.id, intl, managedWorktreeService],
  );

  const failed = creation.phase === "failed";
  const title = failed
    ? intl.formatMessage({ id: "git.managedWorktree.creation.failed" })
    : intl.formatMessage({
        id:
          creation.phase === "starting-session"
            ? "git.managedWorktree.creation.startingSession"
            : creation.kind === "fork"
              ? "git.managedWorktree.creation.forkTitle"
              : "git.managedWorktree.creation.creating",
      });
  const busy = pendingAction !== null;

  return (
    <div className="@container/conversation flex h-full min-h-0 w-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
        {creation.promptText?.trim() ? (
          <div className="flex justify-end">
            <ConversationUserInputBubble
              text={creation.promptText}
              rowId={`worktree-creation-${creation.id}`}
            />
          </div>
        ) : null}
        <WorktreeOutputBlock
          testId={TID_WORKTREE_CREATION_CARD}
          phase={creation.phase}
          title={title}
          status={failed ? "failed" : "running"}
          output={creation.output}
          defaultExpanded={failed}
        >
          {failed ? (
            <div className="flex flex-col gap-3">
              {creation.error ? (
                <p className="text-ui-base text-foreground">
                  {formatManagedWorktreeError(intl, creation.error.code)}
                  {creation.error.detail ? (
                    <span className="block font-mono text-ui-sm text-foreground-subtle break-all">
                      {creation.error.detail}
                    </span>
                  ) : null}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  data-testid={TID_WORKTREE_CREATION_RETRY}
                  onClick={() => runAction("retryCreation")}
                >
                  {intl.formatMessage({ id: "git.managedWorktree.creation.retry" })}
                </Button>
                {creation.kind === "new-task" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid={TID_WORKTREE_CREATION_CONTINUE_LOCAL}
                    onClick={() => runAction("continueWithoutWorktree")}
                  >
                    {intl.formatMessage({ id: "git.managedWorktree.creation.continueLocal" })}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  data-testid={TID_WORKTREE_CREATION_DISMISS}
                  onClick={() => runAction("dismissCreation")}
                >
                  {intl.formatMessage({ id: "git.managedWorktree.creation.dismiss" })}
                </Button>
              </div>
            </div>
          ) : null}
        </WorktreeOutputBlock>
      </div>
    </div>
  );
}

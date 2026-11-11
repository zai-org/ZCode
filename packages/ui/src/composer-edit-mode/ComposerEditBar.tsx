// Composer 编辑态状态条（docs/ui/composer-edit-mode.md）：渲染在输入框卡片内顶部，
// 说明正在编辑哪条消息，并提供「对话 + 文件重置」（仅编辑最后一条消息）与「取消」。
// 发送按钮、Enter 与工具栏都保持原样，不在这里重复。
import { FileClockIcon, PencilIcon } from "lucide-react";
import {
  TID_V4_COMPOSER_EDIT_BAR,
  TID_V4_COMPOSER_EDIT_CANCEL,
  TID_V4_EDIT_REWIND_WORKSPACE,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ComposerEditInvalidReason,
  ComposerEditTarget,
  ComposerEditWorkspaceRewind,
} from "./contract.js";

export interface ComposerEditBarProps {
  target: ComposerEditTarget;
  invalidReason: ComposerEditInvalidReason | null;
  workspaceRewind?: ComposerEditWorkspaceRewind;
  submitting: boolean;
  onRewindWorkspace: () => void;
  onCancel: () => void;
}

export function ComposerEditBar({
  target,
  invalidReason,
  workspaceRewind,
  submitting,
  onRewindWorkspace,
  onCancel,
}: ComposerEditBarProps) {
  const { intl } = useZCodeIntl();
  const targetId = target.kind === "userQuery" ? String(target.rowId) : target.queueItemId;
  const label = invalidReason
    ? intl.formatMessage({ id: `chat.composerEdit.invalid.${invalidReason}` })
    : intl.formatMessage({
        id:
          target.kind === "userQuery"
            ? "chat.composerEdit.editingUserQuery"
            : "chat.composerEdit.editingQueueItem",
      });
  const showRewind = target.kind === "userQuery" && invalidReason === null;
  const rewindDisabled = submitting || workspaceRewind?.enabled !== true;
  const rewindLabel = intl.formatMessage({ id: "chat.edit.resetConversationAndFiles" });
  const rewindButton = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={rewindDisabled}
      data-testid={testId(TID_V4_EDIT_REWIND_WORKSPACE, targetId)}
      onClick={onRewindWorkspace}
    >
      <FileClockIcon />
      <span className="text-ui-sm">{rewindLabel}</span>
    </Button>
  );
  return (
    <div
      data-testid={TID_V4_COMPOSER_EDIT_BAR}
      data-edit-target-kind={target.kind}
      data-edit-target-id={targetId}
      data-edit-state={invalidReason ? "invalid" : "editing"}
      {...(invalidReason ? { "data-edit-invalid-reason": invalidReason } : {})}
      className="flex w-full min-w-0 items-center gap-2 rounded-md bg-secondary px-2 py-1"
    >
      <PencilIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden />
      <span role="status" className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
        {label}
      </span>
      {showRewind ? (
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.edit.resetConversationAndFiles.tooltip" })}
          description={
            workspaceRewind?.reason === "available"
              ? undefined
              : intl.formatMessage({
                  id: `chat.edit.resetConversationAndFiles.${workspaceRewind?.reason ?? "noFiles"}`,
                })
          }
        >
          {rewindDisabled ? (
            // Button disabled 会应用 pointer-events-none；外层 span 承接 hover 才能看到不可用原因。
            <span className="inline-flex" data-disabled-tooltip-trigger="true">
              {rewindButton}
            </span>
          ) : (
            rewindButton
          )}
        </ControlHintTooltip>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid={TID_V4_COMPOSER_EDIT_CANCEL}
        onClick={onCancel}
      >
        <span className="text-ui-sm">{intl.formatMessage({ id: "common.cancel" })}</span>
      </Button>
    </div>
  );
}

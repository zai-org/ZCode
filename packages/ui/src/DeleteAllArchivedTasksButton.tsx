import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  collectArchivedTaskDeletion,
  deleteArchivedTaskSelection,
  type ArchivedTaskDeletionWorkspace,
  type ArchivedTaskDeletionTarget,
} from "@/lib/archivedTaskDeletion.js";
import { logger } from "@/logger.js";

export function DeleteAllArchivedTasksButton({
  workspaces,
  count,
  disabled,
  actionsContainer,
  onDeleted,
  onRefresh,
}: {
  workspaces: ArchivedTaskDeletionWorkspace[];
  count: number;
  disabled: boolean;
  actionsContainer?: HTMLElement | null;
  onDeleted: (target: ArchivedTaskDeletionTarget) => void;
  onRefresh?: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  async function handleDeleteAll() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setResultMessage(null);
    try {
      const selection = await collectArchivedTaskDeletion(workspaces);
      const unavailable =
        selection.unavailableWorkspaces.length > 0
          ? intl.formatMessage(
              { id: "taskList.deleteAllArchivedUnavailable" },
              { projects: selection.unavailableWorkspaces.join("、") },
            )
          : "";
      if (selection.count === 0) {
        setResultMessage(unavailable || intl.formatMessage({ id: "taskList.noArchivedTasks" }));
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage(
          { id: "taskList.deleteAllArchivedTitle" },
          { count: selection.count },
        ),
        description: [
          intl.formatMessage({ id: "confirmDialog.archivedTaskDeleteDescription" }),
          unavailable,
        ]
          .filter(Boolean)
          .join("\n\n"),
        confirmLabel: intl.formatMessage({ id: "taskList.deleteAllArchived" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      const result = await deleteArchivedTaskSelection(selection, onDeleted);
      setResultMessage(
        [
          intl.formatMessage(
            { id: "taskList.deleteAllArchivedResult" },
            { deleted: result.deleted, skipped: result.skipped, failed: result.failed },
          ),
          unavailable,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      await onRefresh?.();
    } catch (error) {
      logger.error("[ArchivedTaskDeletion] 批量删除或刷新失败", error);
      setResultMessage((current) =>
        [current, intl.formatMessage({ id: "taskList.deleteAllArchivedError" })]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const actionLabel = intl.formatMessage({
    id: busy ? "taskList.deleteAllArchivedBusy" : "taskList.archivedActions",
  });
  const menu = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ControlHintTooltip title={actionLabel}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || busy}
            data-testid="archived-tasks-actions"
            aria-label={actionLabel}
            aria-busy={busy}
            className="shrink-0 text-foreground-subtle hover:text-foreground max-md:size-8"
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <MoreHorizontal className="size-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-ui-sm font-normal text-foreground-subtle">
          {intl.formatMessage({ id: "taskList.archivedTaskCount" }, { count })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled || busy}
          data-testid="delete-all-archived-tasks"
          className="max-md:min-h-9"
          onSelect={() => {
            setMenuOpen(false);
            void handleDeleteAll();
          }}
        >
          <Trash2 className="size-3.5" />
          {intl.formatMessage({ id: "taskList.deleteAllArchivedMenu" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {/* 只移动控件的渲染位置，查询/确认/删除仍随归档列表存活，菜单关闭不会卸载这些状态。 */}
      {actionsContainer === undefined
        ? menu
        : actionsContainer
          ? createPortal(menu, actionsContainer)
          : null}
      {resultMessage ? (
        <p
          role="status"
          className="min-w-0 whitespace-pre-line break-words px-2 py-1 text-ui-sm text-foreground-subtle"
        >
          {resultMessage}
        </p>
      ) : null}
    </>
  );
}

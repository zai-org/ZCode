import {
  Download,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  SquareArrowRightEnter,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SettingsResourceHeaderActionsProps {
  onRefresh?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onNew?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  importDisabled?: boolean;
  exportDisabled?: boolean;
  newDisabled?: boolean;
  refreshTestId?: string;
  newTestId?: string;
  refreshLabel?: string;
  newLabel?: string;
  importActionId?: string;
  exportActionId?: string;
  newActionId?: string;
}

export function SettingsResourceHeaderActions({
  onRefresh,
  onImport,
  onExport,
  onNew,
  refreshing = false,
  refreshDisabled = false,
  importDisabled = false,
  exportDisabled = false,
  newDisabled = false,
  refreshTestId,
  newTestId,
  refreshLabel,
  newLabel: customNewLabel,
  importActionId,
  exportActionId,
  newActionId,
}: SettingsResourceHeaderActionsProps) {
  const { intl } = useZCodeIntl();
  const resolvedRefreshLabel = refreshLabel ?? intl.formatMessage({ id: "common.refresh" });
  const importLabel = intl.formatMessage({
    id: "settings.resourceActions.import",
  });
  const exportLabel = intl.formatMessage({
    id: "settings.resourceActions.export",
  });
  const moreActionsLabel = intl.formatMessage({
    id: "settings.resourceActions.more",
  });
  const newLabel = customNewLabel ?? intl.formatMessage({ id: "settings.create.action" });
  const hasOverflowActions = Boolean(onImport || onExport);

  return (
    // 手机窄屏下描述文字会把操作组挤到换行错位；compact-web 下操作组保持一行且不被压缩。
    <div className="flex flex-wrap items-center gap-2 compact-web:shrink-0 compact-web:flex-nowrap">
      {hasOverflowActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon-md" aria-label={moreActionsLabel}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onImport ? (
              <DropdownMenuItem
                data-settings-import-action={importActionId}
                disabled={importDisabled}
                onSelect={onImport}
              >
                <SquareArrowRightEnter aria-hidden="true" />
                {importLabel}
              </DropdownMenuItem>
            ) : null}
            {onExport ? (
              <DropdownMenuItem
                data-settings-export-action={exportActionId}
                disabled={exportDisabled}
                onSelect={onExport}
              >
                <Download aria-hidden="true" />
                {exportLabel}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {onRefresh ? (
        <ControlHintTooltip title={resolvedRefreshLabel}>
          <Button
            type="button"
            variant="outline"
            size="icon-md"
            aria-label={resolvedRefreshLabel}
            data-testid={refreshTestId}
            disabled={refreshDisabled || refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCcw aria-hidden="true" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onNew ? (
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-lg"
          data-settings-create-action={newActionId}
          aria-label={newLabel}
          data-testid={newTestId}
          disabled={newDisabled}
          onClick={onNew}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {newLabel}
        </Button>
      ) : null}
    </div>
  );
}

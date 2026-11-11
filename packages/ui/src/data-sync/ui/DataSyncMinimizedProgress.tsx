import { createPortal } from "react-dom";
import { Minus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 非模态状态条始终挂在窗口根部，不受设置页滚动容器或页面卸载影响。 */
export function DataSyncMinimizedProgress(props: {
  deviceName: string;
  pushing: boolean;
  failed: boolean;
  finished: boolean;
  onRestore(): void;
}) {
  const { intl } = useZCodeIntl();
  const status = props.pushing
    ? "remoteSync.minimized.pushing"
    : props.failed
      ? "remoteSync.minimized.failed"
      : props.finished
        ? "remoteSync.minimized.finished"
        : "remoteSync.minimized.restore";
  return createPortal(
    <button
      type="button"
      data-testid="remote-sync-minimized"
      onClick={props.onRestore}
      className="fixed right-4 bottom-4 left-4 z-50 flex items-center gap-3 rounded-xl border border-popover-border bg-popover px-4 py-3 text-left text-foreground shadow-md sm:left-auto sm:max-w-sm [app-region:no-drag]"
    >
      <RefreshCw
        className={cn("size-4 shrink-0", props.pushing && "animate-spin")}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block truncate text-ui-base font-medium">
          {intl.formatMessage({ id: "remoteSync.dialog.title" })} · {props.deviceName}
        </span>
        <span className="block text-ui-sm text-foreground-subtle" role="status">
          {intl.formatMessage({ id: status })}
        </span>
      </span>
    </button>,
    document.body,
  );
}

export function DataSyncMinimizeButton(props: { pushing: boolean; onMinimize(): void }) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "remoteSync.dialog.minimize" });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="remote-sync-minimize"
      className={cn(
        "absolute top-4 z-20 hover:bg-surface-hover",
        props.pushing ? "right-4" : "right-12",
      )}
      title={label}
      aria-label={label}
      onClick={props.onMinimize}
    >
      <Minus aria-hidden="true" />
    </Button>
  );
}

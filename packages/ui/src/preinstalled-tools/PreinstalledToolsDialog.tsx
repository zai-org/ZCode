import { useEffect, useState } from "react";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import type {
  PreinstalledToolsCommand,
  PreinstalledToolsState,
  PreinstalledToolState,
} from "@zcode/shared/preinstalled-tools";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Progress } from "@/components/ui/progress.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog.js";
import { Separator } from "@/components/ui/separator.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import type { PreinstalledToolsDialogProps } from "@/preinstalled-tools/contract.js";

const statusClasses = {
  "not-installed": "bg-surface text-foreground-subtle",
  preparing: "bg-progress-surface text-progress-surface-foreground",
  ready: "bg-success-surface text-success-surface-foreground",
  failed: "bg-destructive-surface text-destructive-surface-foreground",
};
function usePreinstalledToolsState(open: boolean) {
  const platform = usePlatform();
  const [state, setState] = useState<PreinstalledToolsState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    setState(null);
    setLoadFailed(false);
    let active = true;
    let eventReceived = false;
    const dispose = platform.onPreinstalledToolsState?.((snapshot) => {
      eventReceived = true;
      if (active) setState(snapshot);
    });
    void platform.getPreinstalledToolsState?.().then(
      (snapshot) => {
        // 推送先到时，迟到的初始查询不能回滚工具状态。
        if (active && !eventReceived) setState(snapshot);
      },
      (error) => {
        logger.warn("[PreinstalledTools] 读取状态失败", { error });
        // 修复原因：预装进程在初始化前退出后，Main 让查询以错误结束且不再推送状态；此前这里只记日志，
        // state 保持 null，对话框永远显示“正在读取…”。读取失败要结束加载，之后若有推送仍按推送显示。
        if (active && !eventReceived) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
      dispose?.();
    };
  }, [open, platform]);
  return { state, loadFailed };
}
function usePreinstalledCommand() {
  const platform = usePlatform();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const execute = async (command: PreinstalledToolsCommand) => {
    setPending(true);
    setError(false);
    try {
      if (!platform.executePreinstalledToolsCommand) throw new Error("预装工具命令不可用");
      // 回执只结束本次控件请求；显示状态始终来自 owner 的完整快照。
      await platform.executePreinstalledToolsCommand(command);
    } catch (cause) {
      logger.warn("[PreinstalledTools] 操作失败", { command, error: cause });
      setError(true);
    } finally {
      setPending(false);
    }
  };
  return { execute, pending, error };
}
function PreinstalledToolCard({
  state,
  autoInstallEnabled,
}: {
  state: PreinstalledToolState;
  autoInstallEnabled: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const { execute, pending, error } = usePreinstalledCommand();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const text = (key: string) => intl.formatMessage({ id: `preinstalledTools.${key}` });
  const size = (bytes: number, power = 2) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** power);
  const installed = state.installed;
  const deleteNoticeKey = `preinstalledTools.deleteNotice.${state.toolId}`;
  const translatedDeleteNotice = intl.formatMessage({ id: deleteNoticeKey });
  const deleteNotice = translatedDeleteNotice === deleteNoticeKey ? null : translatedDeleteNotice;
  const updateAvailable = Boolean(
    installed && state.target && installed.resourceId !== state.target.resourceId,
  );
  let info: string;
  if (state.status === "failed") {
    info = intl.formatMessage(
      { id: `preinstalledTools.error.${state.error ?? "runtime"}` },
      {
        size: size(
          (state.target?.archiveSizeBytes ?? 0) + (state.target?.installedSizeBytes ?? 0),
          3,
        ),
      },
    );
  } else if (!state.target) {
    info = text("unavailable");
  } else if (state.status === "preparing") {
    info =
      state.phase === "downloading"
        ? intl.formatMessage(
            { id: "preinstalledTools.downloadInfo" },
            {
              loaded: size(state.downloadedBytes ?? 0),
              total: size(state.target.archiveSizeBytes),
            },
          )
        : text(`phase.${state.phase}`);
  } else if (state.status === "ready" && installed) {
    info = intl.formatMessage(
      { id: "preinstalledTools.readyInfo" },
      { version: installed.version, size: size(installed.installedSizeBytes, 3) },
    );
  } else if (updateAvailable && installed) {
    info = intl.formatMessage(
      { id: "preinstalledTools.updateInfo" },
      {
        current: installed.version,
        version: state.target.version,
        download: size(state.target.archiveSizeBytes),
        installed: size(state.target.installedSizeBytes, 3),
      },
    );
  } else {
    info = intl.formatMessage(
      { id: "preinstalledTools.sizeInfo" },
      {
        download: size(state.target.archiveSizeBytes),
        installed: size(state.target.installedSizeBytes, 3),
      },
    );
  }
  if (installed && (!state.target || state.status === "preparing" || state.status === "failed")) {
    info += ` ${intl.formatMessage({ id: "preinstalledTools.currentInfo" }, { current: installed.version })}`;
  }
  const progress =
    state.target && state.phase === "downloading"
      ? ((state.downloadedBytes ?? 0) / state.target.archiveSizeBytes) * 100
      : undefined;
  return (
    <>
      <div
        className="rounded-xl border border-card-border bg-card p-4 space-y-3"
        data-testid="preinstalled-tools-card"
        data-tool-id={state.toolId}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-ui-base font-medium">{state.displayName}</span>
          <Badge
            className={`rounded-md ${statusClasses[state.status]}`}
            data-testid="preinstalled-tools-status"
            data-status={state.status}
            data-phase={state.phase}
          >
            {text(
              state.status === "not-installed" && updateAvailable
                ? "status.update-available"
                : `status.${state.status}`,
            )}
          </Badge>
        </div>
        <p className="text-ui-caption text-foreground-subtle">{text(`purpose.${state.toolId}`)}</p>
        {state.status === "preparing" ? (
          <Progress
            aria-label={info}
            indeterminate={state.phase !== "downloading"}
            aria-valuenow={progress}
            value={progress}
            indicatorClassName={
              state.phase === "downloading"
                ? "bg-progress-surface-foreground"
                : "bg-progress-surface-foreground tool-call-progress-indeterminate"
            }
          />
        ) : null}
        <p className="text-ui-caption text-foreground-subtle" role="status">
          {info}
        </p>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <label
              className="text-ui-base font-medium"
              htmlFor={`preinstalled-agent-${state.toolId}`}
            >
              {text("agentEnabled")}
            </label>
            <p
              id={`preinstalled-agent-description-${state.toolId}`}
              className="text-ui-sm text-foreground-subtle"
            >
              {intl.formatMessage(
                { id: "preinstalledTools.agentEnabledDescription" },
                { name: state.displayName },
              )}
            </p>
          </div>
          <Switch
            id={`preinstalled-agent-${state.toolId}`}
            data-testid="preinstalled-tools-agent-enabled"
            aria-describedby={`preinstalled-agent-description-${state.toolId}`}
            checked={state.agentEnabled}
            disabled={pending}
            onCheckedChange={(enabled) =>
              void execute({ type: "set-agent-enabled", toolId: state.toolId, enabled })
            }
          />
        </div>
        {state.entryOutOfSync ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-surface p-3 text-ui-sm text-warning-surface-foreground"
            role="alert"
            data-testid="preinstalled-tools-entry-out-of-sync"
          >
            <span>{text("entryOutOfSync")}</span>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              data-testid="preinstalled-tools-sync-entries"
              onClick={() => void execute({ type: "sync-entries", toolId: state.toolId })}
            >
              {text("retry")}
            </Button>
          </div>
        ) : null}
        {state.deletionBlocked ? (
          <p
            className="rounded-lg bg-warning-surface p-3 text-ui-sm text-warning-surface-foreground"
            role="alert"
            data-testid="preinstalled-tools-delete-blocked"
          >
            {intl.formatMessage(
              { id: "preinstalledTools.deletionBlocked" },
              { name: state.displayName },
            )}
          </p>
        ) : null}
        {state.target || installed ? (
          <div className="flex justify-end gap-2">
            {state.status === "preparing" ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                data-testid="preinstalled-tools-cancel"
                onClick={() => void execute({ type: "cancel", toolId: state.toolId })}
              >
                {text("cancel")}
              </Button>
            ) : (
              <>
                {installed ? (
                  <Button
                    variant="outline"
                    disabled={pending}
                    data-testid="preinstalled-tools-delete"
                    onClick={() => setDeleteOpen(true)}
                  >
                    {text("delete")}
                  </Button>
                ) : null}
                {state.target && state.status !== "ready" ? (
                  <Button
                    type="button"
                    disabled={pending}
                    data-testid={
                      state.status === "failed"
                        ? "preinstalled-tools-retry"
                        : updateAvailable
                          ? "preinstalled-tools-update"
                          : "preinstalled-tools-download"
                    }
                    onClick={() => void execute({ type: "prepare", toolId: state.toolId })}
                  >
                    {text(
                      state.status === "failed" ? "retry" : updateAvailable ? "update" : "download",
                    )}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-testid="preinstalled-tools-command-error"
            className="text-ui-sm text-destructive"
          >
            {text("commandFailed")}
          </p>
        ) : null}
      </div>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent data-testid="preinstalled-tools-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage(
                { id: "preinstalledTools.deleteTitle" },
                { name: state.displayName },
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: "preinstalledTools.deleteDescription" },
                { size: size(installed?.installedSizeBytes ?? 0, 3) },
              )}
              {autoInstallEnabled ? ` ${text("deleteAutoNotice")}` : null}
              {deleteNotice ? ` ${deleteNotice}` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="preinstalled-tools-delete-confirm-cancel">
              {text("deleteCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="preinstalled-tools-delete-confirm-accept"
              onClick={() => {
                setDeleteOpen(false);
                void execute({ type: "delete", toolId: state.toolId });
              }}
            >
              {text("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
export function PreinstalledToolsDialog({ open, onOpenChange }: PreinstalledToolsDialogProps) {
  const { intl } = useZCodeIntl();
  const { state, loadFailed } = usePreinstalledToolsState(open);
  const { execute, pending, error } = usePreinstalledCommand();
  const remoteWorkspace = useOptionalTabStore((store) =>
    store.tabs.some(
      (tab) =>
        tab.kind === "workspace" &&
        tab.workspacePath === store.activeWorkspacePath &&
        (tab.workspaceIdentity ?? null) === store.activeWorkspaceIdentity &&
        Boolean(
          tab.remoteSessionId ||
          tab.remoteTarget ||
          isRemoteWorkspaceIdentity(tab.workspaceIdentity ?? ""),
        ),
    ),
  );
  const text = (key: string) => intl.formatMessage({ id: `preinstalledTools.${key}` });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto"
        data-testid="preinstalled-tools-dialog"
      >
        <DialogHeader>
          <DialogTitle>{text("title")}</DialogTitle>
          <DialogDescription>{text("description")}</DialogDescription>
        </DialogHeader>
        {remoteWorkspace ? (
          <p
            className="rounded-xl bg-warning-surface p-3 text-ui-sm text-warning-surface-foreground"
            data-testid="preinstalled-tools-remote-notice"
          >
            {text("remoteNotice")}
          </p>
        ) : null}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <label className="text-ui-base font-medium" htmlFor="preinstalled-tools-auto-install">
              {text("autoInstall")}
            </label>
            <p
              id="preinstalled-tools-auto-description"
              className="text-ui-sm text-foreground-subtle"
            >
              {text("autoInstallDescription")}
            </p>
          </div>
          <Switch
            id="preinstalled-tools-auto-install"
            data-testid="preinstalled-tools-auto-install"
            aria-describedby="preinstalled-tools-auto-description"
            checked={state?.autoInstallEnabled ?? false}
            disabled={!state || pending}
            onCheckedChange={(enabled) => void execute({ type: "set-auto-install", enabled })}
          />
        </div>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {text("commandFailed")}
          </p>
        ) : null}
        <Separator />
        {state ? (
          state.tools.map((tool) => (
            <PreinstalledToolCard
              key={tool.toolId}
              state={tool}
              autoInstallEnabled={state.autoInstallEnabled}
            />
          ))
        ) : loadFailed ? (
          <p
            role="alert"
            className="text-ui-sm text-destructive"
            data-testid="preinstalled-tools-load-failed"
          >
            {text("loadFailed")}
          </p>
        ) : (
          <p className="text-ui-sm text-foreground-subtle">{text("loading")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

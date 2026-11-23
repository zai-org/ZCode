import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateActionInFlight,
  type UpdateStatusViewModel,
} from "@/updateStatusModel.js";

export function UpdateStatusDialogController({
  platform,
  version,
  updateState,
  open,
  onOpenChange,
  edgeToEdge = false,
  showOverlay = true,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edgeToEdge?: boolean;
  showOverlay?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [updateActionInFlight, setUpdateActionInFlightState] = useState<UpdateActionInFlight>(null);
  const updateActionInFlightRef = useRef<typeof updateActionInFlight>(null);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const setUpdateActionInFlight = useCallback((nextAction: typeof updateActionInFlight) => {
    updateActionInFlightRef.current = nextAction;
    setUpdateActionInFlightState(nextAction);
  }, []);
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const lastVisibleUpdateStatusViewModelSelection = useRef<UpdateStatusViewModel | null>(null);
  const renderedUpdateStatusViewModel =
    updateStatusViewModel.displayVersion || updateActionInFlight === null
      ? updateStatusViewModel
      : (lastVisibleUpdateStatusViewModelSelection.current ?? updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    progressValue,
    releaseNotesPayload: updateReleaseNotesPayload,
    skippableVersion,
  } = renderedUpdateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;

  useEffect(() => {
    if (!updateStatusViewModel.displayVersion) {
      return;
    }

    // 点击“下载更新”后，真实下载进度依赖 main 侧异步广播。
    // 中间若短暂收到 checking/idle 等不带版本的过渡状态，不能让入口 return null
    // 连带卸载已打开的弹窗；命令进行中复用上一帧可见模型，等进度态收口。
    lastVisibleUpdateStatusViewModelSelection.current = updateStatusViewModel;
  }, [updateStatusViewModel]);

  useEffect(() => {
    let disposed = false;

    const refreshAutoUpdatePreferences = () => {
      void platform
        .getAutoUpdatePreferences?.()
        .then((preferences) => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(preferences.autoDownloadAndInstallUpdates);
          }
        })
        .catch(() => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(false);
          }
        });
    };

    refreshAutoUpdatePreferences();
    const disposeSettingsChanged =
      platform.onSettingsChanged?.(refreshAutoUpdatePreferences) ?? (() => {});

    return () => {
      disposed = true;
      disposeSettingsChanged();
    };
  }, [platform]);

  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // 下载中会隐藏更新日志，但 electron-updater 的 update-downloaded
    // 事件在部分平台只稳定带 version。缓存当前版本的说明，下载完成后即使 ready
    // 状态缺少 releaseNotes，也能把刚才隐藏的内容恢复显示。
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);

  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  const handleDownloadUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // 如果 electron-updater 命中本地已下载缓存，main 侧会直接广播
    // update-downloaded。renderer 不能在 IPC ACK 前后乐观切到“下载中”，否则会闪过
    // 一帧无意义的 0%/下载态；这里只锁按钮，真实阶段完全跟随 main 的状态广播。
    setUpdateActionInFlight("download");
    try {
      await platform.downloadUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      setAutoDownloadAndInstallUpdates(enabled);
      await platform.setAutoDownloadAndInstallUpdates?.(enabled);
      if (enabled && updateState?.kind === "update-available") {
        // 功能原因：用户在“已发现更新”弹窗里勾选自动下载时，期望当前版本也进入自动流程。
        // 这里只触发同一个下载入口；真正是否下载、缓存命中和状态广播仍由 main 进程裁决。
        await handleDownloadUpdate();
      }
    },
    [handleDownloadUpdate, platform, updateState?.kind],
  );
  const handleCancelDownload = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    setUpdateActionInFlight("cancel");
    try {
      await platform.cancelUpdateDownload();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleSkipUpdate = useCallback(async () => {
    if (!skippableVersion || updateActionInFlightRef.current) {
      return;
    }
    setUpdateActionInFlight("skip");
    try {
      await platform.skipUpdateVersion(skippableVersion);
      onOpenChange(false);
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [onOpenChange, platform, setUpdateActionInFlight, skippableVersion]);
  const handleRestartUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    const activity = await platform.getDesktopSessionActivity?.();
    const runningTaskCount = activity?.runningAgentSessionCount ?? 0;
    if (runningTaskCount > 0) {
      const confirmed = await requestConfirmation({
        presentation: "update-confirmation",
        testId: "update-restart-confirmation",
        showKeyboardHints: false,
        title: intl.formatMessage(
          { id: "updateReady.confirm.title" },
          {
            version: displayVersion ?? "",
          },
        ),
        description: intl.formatMessage({
          id: "updateReady.confirm.description",
        }),
        confirmLabel: intl.formatMessage({ id: "updateReady.confirm.ok" }),
        cancelLabel: intl.formatMessage({ id: "updateReady.confirm.cancel" }),
      });
      if (!confirmed) {
        return;
      }
    }

    // 重启安装之前是 fire-and-forget，renderer 发完 IPC 就关闭弹窗。
    // dev/mock 下 updater 若没有接管安装，用户只会看到弹窗消失，误以为按钮没有响应。
    setUpdateActionInFlight("restart");
    try {
      await platform.quitAndInstallUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [displayVersion, intl, platform, requestConfirmation, setUpdateActionInFlight]);

  useEffect(() => {
    if (!displayVersion && updateState !== null) {
      onOpenChange(false);
    }
  }, [displayVersion, onOpenChange, updateState]);

  useEffect(() => {
    if (!updateActionInFlight) {
      return;
    }

    if (isUpdateActionCompleted(updateActionInFlight, updateState)) {
      setUpdateActionInFlight(null);
      return;
    }

    // 退出准备和 Windows 安装器交接可能超过 5 秒；旧的统一 ACK 定时器会在
    // 应用真正退出前恢复“重启以更新”，让用户误判失败并重复点击。restart 成功路径保持
    // pending 直到应用退出，只有 IPC 明确失败时才由调用处 catch 恢复按钮。
    if (updateActionInFlight === "restart") {
      if (updateState !== null && updateState.kind !== "update-downloaded") {
        // main 会在退出准备失败时广播 error/idle。即使 IPC reject 因窗口
        // 生命周期丢失，状态已经离开 ready 也必须释放按钮，不能保留上一帧永久 pending。
        setUpdateActionInFlight(null);
      }
      return;
    }

    // 下载/取消 IPC 在 main 进程会立即 ACK，真实状态靠后续广播收口。
    // 连点时需要先锁住按钮；若广播丢失或 main 侧 no-op，也要短超时释放，避免 UI 自己卡住。
    const timeout = globalThis.setTimeout(() => {
      setUpdateActionInFlight(null);
    }, 1500);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [setUpdateActionInFlight, updateActionInFlight, updateState?.kind]);

  if (!displayVersion) return null;

  const releaseDateLabel = restoredReleaseDate
    ? intl.formatMessage({ id: "updateDialog.releaseDate" }, { date: restoredReleaseDate })
    : null;

  return (
    <UpdateStatusDialog
      autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
      displayVersion={displayVersion}
      edgeToEdge={edgeToEdge}
      intl={intl}
      isUpdateActionPending={updateActionInFlight !== null}
      localizedUpdateReleaseNotes={visibleUpdateReleaseNotes}
      onAutoDownloadAndInstallUpdatesChange={handleAutoDownloadAndInstallUpdatesChange}
      onCancelDownload={handleCancelDownload}
      onDownloadUpdate={handleDownloadUpdate}
      onOpenChange={onOpenChange}
      onOpenReleaseNotesExternalUrl={handleOpenReleaseNotesExternalUrl}
      onRestartUpdate={handleRestartUpdate}
      onSkipUpdate={handleSkipUpdate}
      open={open}
      phase={dialogPhase}
      progressLabel={progressLabel}
      progressValue={progressValue}
      releaseDateLabel={releaseDateLabel}
      showOverlay={showOverlay}
      skippableVersion={skippableVersion}
    />
  );
}

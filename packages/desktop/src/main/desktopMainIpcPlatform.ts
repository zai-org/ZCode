import { decorateRequestSecurityLogArgs } from "./request-security-edition/index.js";
/* eslint-disable max-lines -- 桌面平台 IPC 集中装配，拆散会让权限边界更难审计；行数随平台能力增长。 */
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import {
  DesktopCommandIds,
  appSettingsPatchSchema,
  formatZodError,
  localeSchema,
  nonEmptyStringSchema,
  PlatformChannels,
  rendererLogPayloadSchema,
  stringArraySchema,
  webRemoteControlWorkspaceTargetsSchema,
  type DesktopCommandId,
  type ApplicationIconRequest,
  type Locale,
  type LoadCliMcpFromUserDirectoryRequest,
  type MigrateLegacyCommonMcpRequest,
  type OpenInEditorOptions,
  type SaveCliMcpToUserDirectoryRequest,
  type CreateTempTextAttachmentRequest,
  type MaterializeWorkflowArtifactFileRequest,
  type UpdateStatePayload,
  type WebRemoteControlWorkspaceTarget,
  type WindowControlsOverlayReadyPayload,
} from "@zcode/shared";
import { getAppIconDataUrl, getInstalledEditors } from "./editors.js";
import { createFileApplicationService } from "@desktop/main/file-open-apps/index.js";
import type { FileApplicationTarget } from "@zcode/shared";
import { getApplicationIcon } from "./applicationIcons.js";
import { exportLogs } from "./exportLogs.js";
import { resolveCommunityUrl } from "./desktopCommandHandlers.js";
import { openInEditor } from "./openInEditor.js";
import {
  openResourceManager,
  getResourceUsageSnapshot,
  setResourceUsageSamplingActive,
} from "./resourceManagerWindow.js";
import { registerResourceManagerStorageIpc } from "./resourceManagerStorage.js";
import { registerResourceManagerNetworkIpc } from "./resourceManagerNetwork.js";
import { applyWindowsTitleBarTheme, getWindowOverlayTheme } from "./desktopWindowChrome.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import { resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import { handleWindowUnreadCountSync } from "./desktopWindowLifecycle.js";
import { captureWindowScreenshot, openPathInFileManager } from "./desktopMainIpcHelpers.js";
import { registerCuaPermissionIpcHandlers } from "./desktopCuaPermissionIpc.js";
import {
  registerDesktopBrowserIpcHandlers,
  type AttachBrowserGuest,
  type ReportBrowserScreenshotSurfaceReady,
  type UpdateBrowserGuestViewport,
  type BrowserViewResidencyIpcHandlers,
} from "./desktopBrowserViewIpc.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { materializeWorkflowArtifactFile } from "./workflowArtifactFile.js";
import { registerDesktopSaveFileIpcHandler } from "./desktopSaveFile.js";
import { registerDesktopPrintToPdfIpcHandler } from "./desktopPrintToPdf.js";
import { registerDesktopMicrophoneIpcHandlers } from "./microphone-access/index.js";
import { registerDesktopCaptureBrowserGuestPageIpcHandler } from "./desktopCaptureBrowserGuestPage.js";
import { registerDesktopCommandIpcHandler } from "./desktopCommandIpc.js";
import { registerCuaPipActiveSessionIpc } from "./desktopCuaPipIpc.js";

export function registerPlatformIpcHandlers(options: {
  fetchHelpConfig?: () => Promise<unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  applyApplicationLocale: (locale: Locale) => Promise<void>;
  resolveSystemLocale: () => Locale;
  focusWorkspaceInExistingWindow: (
    path: string,
    extra?: { skipWindowId?: number },
  ) => { activated: boolean; winId?: number };
  windowWorkspaceMap: Map<number, Set<string>>;
  windowUnreadCountMap: Map<number, number>;
  currentApplicationLocale: () => Locale;
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  acknowledgePostUpdateReleaseNotes: (version: string) => Promise<void>;
  syncActiveTaskSession: (windowId: number, sessionId: string | null) => void;
  syncTaskRealtimeWorkspaceKeys: (windowId: number, workspaceKeys: Iterable<string>) => void;
  getUpdateState: () => UpdateStatePayload;
  openUpdateStatusWindow: () => void;
  syncWebRemoteControlWorkspaces: (
    windowId: number,
    workspaces: WebRemoteControlWorkspaceTarget[],
  ) => void;
  getDesktopSessionActivity: () => {
    runningAgentSessionCount: number;
  };
  getAutoUpdatePreferences: () => Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;
  setAutoDownloadAndInstallUpdates: (enabled: boolean) => Promise<void>;
  syncAppSettings: (patch: ReturnType<typeof appSettingsPatchSchema.parse>) => void;
  /** 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）；传入 monitor 的 refresh */
  refreshCloseToTrayCapability: () => Promise<import("@zcode/shared").DesktopCloseToTrayCapability>;
  /** 快捷键设置页录制态开关：true 时 main 重建菜单摘除可配置 accelerator（见 shortcut-settings-spec §7） */
  setShortcutRecordingActive?: (active: boolean, ownerWebContentsId?: number | null) => void;
  /** 桌面端设备标识符（基于 userData 路径的 SHA-256） */
  deviceMid: string;
  /** CDP-on-guest pivot：renderer `<webview>` 上报 guest webContentsId → main attach。 */
  attachBrowserGuest?: AttachBrowserGuest;
  /** renderer 自由尺寸变化 → 当前窗口所属的受控 tab。 */
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport;
  /** 可信 owner renderer 上报的后台截图表面 ready。 */
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady;
  /** Browser tab 关闭、挂起、恢复与跨重启 shell IPC。 */
  browserViewResidencyHandlers?: BrowserViewResidencyIpcHandlers;
}) {
  ipcMain.handle(PlatformChannels.SelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectDirectories, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(PlatformChannels.SelectFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return result.filePaths;
  });

  registerDesktopSaveFileIpcHandler(options.logger);
  registerDesktopPrintToPdfIpcHandler(options.logger);
  registerDesktopMicrophoneIpcHandlers(options.logger);
  registerDesktopCaptureBrowserGuestPageIpcHandler(options.logger);

  ipcMain.handle(
    PlatformChannels.CreateTempTextAttachment,
    async (_event, payload: CreateTempTextAttachmentRequest) => {
      return createTempTextAttachment(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.MaterializeWorkflowArtifactFile,
    async (_event, payload: MaterializeWorkflowArtifactFileRequest) => {
      return materializeWorkflowArtifactFile(payload);
    },
  );

  registerDesktopBrowserIpcHandlers(
    options.attachBrowserGuest,
    options.updateBrowserGuestViewport,
    options.logger,
    options.reportBrowserScreenshotSurfaceReady,
    options.browserViewResidencyHandlers,
  );

  ipcMain.handle(PlatformChannels.ActivateOrSetWorkspace, (event, path: string) => {
    const validatedPath = nonEmptyStringSchema.parse(path);
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const activated = options.focusWorkspaceInExistingWindow(validatedPath, {
      skipWindowId: senderWin?.id,
    });
    if (activated.activated) {
      return { activated: true };
    }

    if (senderWin) {
      let pathSet = options.windowWorkspaceMap.get(senderWin.id);
      if (!pathSet) {
        pathSet = new Set();
        options.windowWorkspaceMap.set(senderWin.id, pathSet);
        senderWin.on("closed", () => options.windowWorkspaceMap.delete(senderWin.id));
      }
      pathSet.add(validatedPath);
      options.syncTaskRealtimeWorkspaceKeys(senderWin.id, pathSet);
    }
    return { activated: false };
  });

  ipcMain.handle(PlatformChannels.GetResourceUsageSnapshot, (event) =>
    getResourceUsageSnapshot(event.sender.id),
  );
  // 设置页 Linux 置灰判断入口；monitor 带 stale 缓存，用户装完扩展重开设置页即可解除置灰。
  ipcMain.handle(PlatformChannels.GetCloseToTrayCapability, () =>
    options.refreshCloseToTrayCapability(),
  );
  ipcMain.on(PlatformChannels.SetResourceUsageSamplingActive, (event, active: unknown) => {
    if (typeof active === "boolean") setResourceUsageSamplingActive(event.sender.id, active);
  });
  registerResourceManagerStorageIpc();
  registerResourceManagerNetworkIpc();
  ipcMain.handle(PlatformChannels.GetZCodeStdioTapDevState, () => readZCodeStdioTapDevState());
  ipcMain.on(PlatformChannels.OpenResourceManager, () => {
    openResourceManager();
  });

  ipcMain.handle(
    PlatformChannels.LoadMcpFromUserDirectory,
    async (_event, payload?: LoadCliMcpFromUserDirectoryRequest) => {
      return loadCliMcpFromUserDirectory(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.SaveMcpToUserDirectory,
    async (_event, payload: SaveCliMcpToUserDirectoryRequest) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn("[mcp-user-directory] save failed", message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PlatformChannels.MigrateLegacyCommonMcp,
    async (_event, payload?: MigrateLegacyCommonMcpRequest) => {
      return migrateLegacyCommonMcp(payload);
    },
  );

  ipcMain.handle(PlatformChannels.SetTitleBarTheme, (event, theme: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) {
      return;
    }

    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      options.logger.warn("[title-bar-theme] invalid theme:", theme);
      return;
    }

    nativeTheme.themeSource = theme;
    applyWindowsTitleBarTheme(senderWindow, theme === "system" ? getWindowOverlayTheme() : theme);
  });

  ipcMain.handle(PlatformChannels.SetApplicationLocale, (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[application-locale] invalid locale:", formatZodError(result.error));
      return;
    }

    return options.applyApplicationLocale(result.data);
  });

  ipcMain.handle(PlatformChannels.GetSystemLocale, () => options.resolveSystemLocale());

  ipcMain.on(PlatformChannels.SyncWindowTabs, (event, paths: string[]) => {
    const result = stringArraySchema.safeParse(paths);
    if (!result.success) {
      options.logger.warn("[sync-window-tabs] invalid payload:", formatZodError(result.error));
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      options.windowWorkspaceMap.set(win.id, new Set(result.data));
      options.syncTaskRealtimeWorkspaceKeys(win.id, result.data);
      // 远控恢复统一由 SyncWebRemoteControlWorkspaces 的完整快照驱动。
    }
  });

  ipcMain.on(PlatformChannels.SyncWebRemoteControlWorkspaces, (event, payload: unknown) => {
    const result = webRemoteControlWorkspaceTargetsSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[sync-web-remote-control-workspaces] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    options.syncWebRemoteControlWorkspaces(win.id, result.data);
  });

  ipcMain.on(PlatformChannels.SyncWindowUnreadCount, (event, payload: unknown) => {
    handleWindowUnreadCountSync(
      BrowserWindow.fromWebContents(event.sender),
      payload,
      options.windowUnreadCountMap,
      options.logger,
    );
  });
  registerCuaPipActiveSessionIpc({
    syncActiveTaskSession: options.syncActiveTaskSession,
    warn: (message) => options.logger.warn(message),
  });
  ipcMain.on(
    PlatformChannels.WindowControlsOverlayReady,
    (event, payload: WindowControlsOverlayReadyPayload) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !Number.isFinite(payload.zoomLevel)) {
        return;
      }

      // preload 早于 React 页面运行，用它同步到的 zoom 档位先调整 macOS 红绿灯，
      // 避免等 RootStartupLoading 切到 App 页面后才重置位置。
      syncWindowControlsOverlayForZoomLevel(senderWindow, payload.zoomLevel);
    },
  );

  ipcMain.on(PlatformChannels.SyncAppSettings, (_event, payload: unknown) => {
    const result = appSettingsPatchSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[settings] invalid app settings sync payload:",
        formatZodError(result.error),
      );
      return;
    }

    options.syncAppSettings(result.data);
  });

  // 快捷键录制态：renderer 设置页进入/退出录制时通知。macOS 系统菜单会先于 renderer
  // 吃掉按键，录制 menu 通道命令必须先摘掉可配置 accelerator，否则按键直接触发原命令。
  // 附带发起方 webContents id：录制中窗口销毁时 main 侧据此复位（见 index.ts）。
  ipcMain.on(PlatformChannels.SetShortcutRecordingActive, (event, payload: unknown) => {
    if (typeof payload !== "boolean") {
      options.logger.warn("[shortcuts] invalid recording-active payload:", payload);
      return;
    }
    options.setShortcutRecordingActive?.(payload, event.sender.id);
  });

  ipcMain.on(PlatformChannels.Log, (event, payload: unknown) => {
    const result = rendererLogPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn("[renderer-log] invalid payload:", formatZodError(result.error));
      return;
    }
    (
      options.logger as unknown as { fromRenderer(level: string, args: unknown[]): void }
    ).fromRenderer?.(
      result.data.level,
      decorateRequestSecurityLogArgs(result.data.args, event.sender.id),
    );
  });

  ipcMain.handle(PlatformChannels.OpenInFileManager, async (_event, rawPath: string) =>
    openPathInFileManager(rawPath, options.logger),
  );

  registerCuaPermissionIpcHandlers({
    logger: options.logger,
    currentApplicationLocale: options.currentApplicationLocale,
  });

  ipcMain.handle(PlatformChannels.CanOpenCommunity, async (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[community] invalid locale:", formatZodError(result.error));
      return false;
    }

    const communityUrl = await resolveCommunityUrl({
      locale: result.data,
      fetchRemoteConfig: options.fetchHelpConfig,
      logger: options.logger,
    });

    return typeof communityUrl === "string" && communityUrl.length > 0;
  });

  ipcMain.handle(
    PlatformChannels.AcknowledgePostUpdateReleaseNotes,
    async (_event, version: string) => {
      const validatedVersion = nonEmptyStringSchema.parse(version);
      await options.acknowledgePostUpdateReleaseNotes(validatedVersion);
    },
  );

  ipcMain.handle(PlatformChannels.GetUpdateState, () => options.getUpdateState());
  ipcMain.handle(PlatformChannels.OpenUpdateStatusWindow, () => {
    options.openUpdateStatusWindow();
  });
  ipcMain.handle(PlatformChannels.GetAutoUpdatePreferences, () =>
    options.getAutoUpdatePreferences(),
  );
  ipcMain.handle(
    PlatformChannels.SetAutoDownloadAndInstallUpdates,
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return;
      }
      await options.setAutoDownloadAndInstallUpdates(enabled);
    },
  );
  ipcMain.handle(PlatformChannels.GetDesktopSessionActivity, () =>
    options.getDesktopSessionActivity(),
  );
  ipcMain.handle(PlatformChannels.GetDesktopZoomLevel, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return { zoomLevel: 0 };
    }

    return {
      zoomLevel: resolveDesktopZoomLevelFromFactor(senderWindow.webContents.getZoomFactor()),
    };
  });
  ipcMain.handle(PlatformChannels.GetDesktopWindowChromeState, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return resolveDesktopWindowChromeState(senderWindow?.isMaximized() ?? false);
  });
  ipcMain.handle(PlatformChannels.GetInstalledEditors, (_event, filePath?: string) =>
    getInstalledEditors(typeof filePath === "string" ? filePath : undefined),
  );
  const fileApplications = createFileApplicationService({
    getIcon: (id, path) => getAppIconDataUrl(id, path),
    logger: options.logger,
  });
  ipcMain.handle(PlatformChannels.GetFileApplications, (_event, target: FileApplicationTarget) =>
    fileApplications.getFileApplications(target),
  );
  ipcMain.handle(
    PlatformChannels.OpenFileWithApplication,
    (_event, payload: { applicationId: string; target: FileApplicationTarget }) =>
      fileApplications.openFileWithApplication(payload?.applicationId, payload?.target),
  );
  ipcMain.handle(
    PlatformChannels.GetApplicationIcon,
    (_event, request: string | ApplicationIconRequest) => getApplicationIcon(request),
  );
  ipcMain.handle(PlatformChannels.GetDeviceId, () => options.deviceMid);
  ipcMain.handle(PlatformChannels.ExportLogs, () => exportLogs());
  ipcMain.handle(PlatformChannels.CaptureWindowScreenshot, async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return captureWindowScreenshot(senderWindow);
  });
  ipcMain.handle(
    PlatformChannels.OpenInEditor,
    (_event, payload: { editorId: string; path: string; options?: OpenInEditorOptions }) =>
      openInEditor(payload.editorId, payload.path, payload.options),
  );

  registerDesktopCommandIpcHandler({
    executeDesktopCommand: options.executeDesktopCommand,
    logger: options.logger,
  });
}

import { recordArmsCustomEventForE2E } from "@zcode/ui";
import {
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  resolveLocaleFromLanguageTag,
  unwrapRemoteWorkspaceBindResult,
  type IPlatformService,
} from "@zcode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { registerAppControlNavigationHandler } from "#src/app-control-navigation/renderer.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    onAppControlNavigation: (handler) =>
      registerAppControlNavigationHandler(
        {
          subscribe: (listener) => window.zcode.onAppControlNavigationMessage(listener),
          register: (generation) =>
            window.zcode.sendAppControlNavigation({ type: "register", generation }),
          unregister: (generation) =>
            window.zcode.sendAppControlNavigation({ type: "unregister", generation }),
          reply: (message) => window.zcode.sendAppControlNavigation({ type: "result", ...message }),
        },
        handler,
        crypto.randomUUID(),
      ),
    canSelectFilePath: true,
    canOpenLocalFiles: true,
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.zcode.selectDirectory(),
    selectDirectories: () => window.zcode.selectDirectories(),
    selectFile: () => window.zcode.selectFile(),
    selectFiles: () => window.zcode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.zcode.createTempTextAttachment(payload),
    materializeWorkflowArtifactFile: (payload) =>
      window.zcode.materializeWorkflowArtifactFile(payload),
    onRemoteConnectionLog: (handler) => window.zcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.zcode.onRemoteSessionClosed(handler),
    // Source 自动重连会替换 logical session；统一由 preload bridge 转发换代事件。
    onRemoteSessionReconnected: (handler) =>
      window.zcode.onRemoteSessionReconnected?.(handler) ?? (() => {}),
    activateOrSetWorkspace: (path) =>
      window.zcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.zcode.connectRemote(remoteOptions, requestId, context),
    requestSourceSettingsAttachment: (sourceServerId) =>
      window.zcode.requestSourceSettingsAttachment?.(sourceServerId) ??
      Promise.reject(new Error("Source settings attachment bridge unavailable")),
    cancelPendingRemoteConnection: (requestId) =>
      window.zcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: async (context) => {
      if (!window.zcode.bindRemoteWorkspaceSessionContext) {
        throw new Error("Desktop bindRemoteWorkspaceSessionContext bridge unavailable");
      }
      // preload 返回结构化结果，在页面一侧还原错误才能保留 code/retryable。
      return unwrapRemoteWorkspaceBindResult(
        await window.zcode.bindRemoteWorkspaceSessionContext(context),
      );
    },
    startWebRemoteControl: (context) => window.zcode.startWebRemoteControl(context),
    stopWebRemoteControl: () => window.zcode.stopWebRemoteControl(),
    getWebRemoteControlStatus: () => window.zcode.getWebRemoteControlStatus(),
    onWebRemoteControlStatusChanged: (handler) =>
      window.zcode.onWebRemoteControlStatusChanged?.(handler) ?? (() => {}),
    disposeRemoteSession: (sessionId) => window.zcode.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.zcode.isDockerAvailable(),
    listWSLDistros: () => window.zcode.listWSLDistros(),
    listDockerContainers: () => window.zcode.listDockerContainers(),
    listSSHConfigAliases: () => window.zcode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.zcode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.zcode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.zcode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.zcode.openExternal(url),
    openFeedback: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.zcode.canOpenCommunity(locale),
    openInFileManager: (path) => window.zcode.openInFileManager(path),
    openExternalFile: (path) => window.zcode.openExternalFile(path),
    openCuaPermissionOnboarding: window.zcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.zcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.zcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.zcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.zcode.startCuaHelperPermissionDrag
      ? () => window.zcode.startCuaHelperPermissionDrag?.()
      : undefined,
    notifyWebRemoteControlAuthStateChanged: (change) =>
      window.zcode.notifyWebRemoteControlAuthStateChanged(change),
    registerOAuthState: (payload) => window.zcode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.zcode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.zcode.onPaymentCallback(callback),
    onShareImport: (callback) => window.zcode.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.zcode.notifyRendererReady(),
    syncTelemetryContext: (context) => window.zcode.syncTelemetryContext(context),
    reportTelemetryEvent: (payload) => window.zcode.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.zcode.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.zcode.getRendererActionTraceConfig
      ? () => window.zcode.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.zcode.onRendererActionTraceConfigChanged
      ? (callback) => window.zcode.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.zcode.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.zcode.reportRendererActionTraceBatch
      ? (batch) => window.zcode.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.zcode.reportRendererHeapSample
      ? (sample) => window.zcode.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.zcode.showTaskNotification(payload),
    // 扩展的系统通知（§18.1 H8）：只有桌面实现；Web 与手机远控没有这两个方法，Renderer 按 unsupported 处理。
    showExtensionNotification: (payload) => window.zcode.showExtensionNotification(payload),
    onExtensionNotificationClick: (handler) => window.zcode.onExtensionNotificationClick(handler),
    syncWindowTabs: (paths) => window.zcode.syncWindowTabs(paths),
    syncWebRemoteControlWorkspaces: (workspaces) =>
      window.zcode.syncWebRemoteControlWorkspaces?.(workspaces),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.zcode.onWebRemoteControlReconnectWorkspace?.(handler) ?? (() => {}),
    onWebRemoteControlRendererAction: (handler) =>
      window.zcode.onWebRemoteControlRendererAction?.(handler) ?? (() => {}),
    syncWindowUnreadCount: (count) => window.zcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.zcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.zcode.syncAppSettings?.(patch),
    // 桥缺失（旧 preload 升级窗口）时按 supported 兜底，与 Windows 现状一致，设置开关可用。
    getCloseToTrayCapability: () =>
      window.zcode.getCloseToTrayCapability?.() ??
      Promise.resolve({ supported: true, gnomeLikeWithoutTray: false }),
    setShortcutRecordingActive: (active) => window.zcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.zcode.onFocusTab(handler),
    onNewTab: (handler) => window.zcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.zcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.zcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onEmbeddedBrowserPermissionPrompt: (handler) =>
      window.zcode.onEmbeddedBrowserPermissionPrompt?.(handler) ?? (() => {}),
    resolveEmbeddedBrowserPermissionPrompt: (request) =>
      window.zcode.resolveEmbeddedBrowserPermissionPrompt?.(request),
    getEmbeddedBrowserSitePermissions: () =>
      window.zcode.getEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    setEmbeddedBrowserSitePermission: (request) =>
      window.zcode.setEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    clearEmbeddedBrowserSitePermissions: () =>
      window.zcode.clearEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    resetEmbeddedBrowserSitePermission: (request) =>
      window.zcode.resetEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.zcode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.zcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.zcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.zcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.zcode.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.zcode.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.zcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.zcode.getDesktopWindowChromeState
      ? () => window.zcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.zcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.zcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.zcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.zcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.zcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.zcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.zcode.onTaskNotificationClick(handler),
    exportLogs: () => window.zcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.zcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.zcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.zcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.zcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.zcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.zcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.zcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.zcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.zcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.zcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.zcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getZCodeStdioTapDevState: () =>
      window.zcode.getZCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.zcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.zcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.zcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.zcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.zcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.zcode.quitAndInstallUpdate(),
    getInstalledEditors: (filePath) => window.zcode.getInstalledEditors(filePath),
    getFileApplications: (target) => window.zcode.getFileApplications(target),
    openFileWithApplication: (applicationId, target) =>
      window.zcode.openFileWithApplication(applicationId, target),
    getApplicationIcon: (bundleId) =>
      window.zcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.zcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.zcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.zcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.zcode.getSystemLocale?.() ??
      Promise.resolve(resolveLocaleFromLanguageTag(navigator.language)),
    setTitleBarTheme: (theme) => window.zcode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __ZCODE_DEVICE_ID__?: string }).__ZCODE_DEVICE_ID__ ?? "",
  };
}

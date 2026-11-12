import { installPluginSandboxHostBridge } from "./pluginSandbox/hostBridge.js";
import type {
  ExtensionNotificationClick,
  ExtensionNotificationPayload,
  NotificationsShowResult,
} from "@zcode/shared/extension-host";
import {
  APP_NAVIGATION_IPC,
  appNavigationRendererMessageSchema,
  appNavigationRendererIpcSchema,
  type AppNavigationRendererMessage,
} from "#src/app-control-navigation/contract.js";
import {
  databaseStartupControlSchema,
  databaseStartupStateSchema,
  databaseStartupPortPayloadSchema,
} from "@zcode/shared";
/* eslint-disable max-lines -- preload bridge 集中暴露桌面平台 IPC，拆散会让 contextBridge 权限边界更难审计。 */
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";

// ARMS frame preload 闭包内的 send 不会随后序 ipcRenderer.send 补丁生效，须同步包装 Bridge.send
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** 从 command-line 参数中解析 --device-id= */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// 在 contextBridge 建立之前就暴露同步值，让 renderer 在 React 渲染前就能读到
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());

import type {
  AppSettings,
  ApplicationIconRequest,
  BindRemoteWorkspaceSessionContextIpcResult,
  BrowserViewOperationPayload,
  BrowserGuestAttachResult,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewPromoteDraftTabsRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewportSize,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopCommandId,
  DesktopTitleBarTheme,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  Locale,
  OAuthStateRegistration,
  WebRemoteControlAuthStateChange,
  OpenInEditorOptions,
  FileApplicationTarget,
  RemoteTarget,
  TaskNotificationPayload,
  TelemetryRendererContext,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  ZCodeStdioTapDevState,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  SaveCliMcpToUserDirectoryRequest,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  MicrophoneAccessResetResult,
  MicrophoneAccessResult,
  MicrophoneSettingsTarget,
  CaptureBrowserGuestPageRequest,
  CaptureBrowserGuestPageResult,
  SSHConfigAliasOption,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlRendererActionRequest,
  WebRemoteControlRendererActionResult,
  WebRemoteControlStatus,
  WebRemoteControlWorkspaceTarget,
  RemoteConnectionRuntimeLog,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
  CreateTempTextAttachmentRequest,
  MaterializeWorkflowArtifactFileRequest,
  OpenCuaPermissionOnboardingOptions,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
} from "@zcode/shared";
import {
  InternalChannels,
  PlatformChannels,
  formatZCodeRendererProcessName,
  scopedServicePortPayloadSchema,
  shouldEnableE2ETestBridge,
} from "@zcode/shared";
import { createOAuthCallbackHandler } from "./oauthCallbackBridge.js";

if (shouldEnableE2ETestBridge(process.env)) {
  contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
    read: (): Promise<FinalArmsCustomEventE2EEntry[]> =>
      ipcRenderer.invoke(PlatformChannels.ReadFinalArmsCustomEventsE2E),
    clear: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.ClearFinalArmsCustomEventsE2E),
    configure: (request: ConfigureFinalArmsCustomEventE2ERequest): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ConfigureFinalArmsCustomEventsE2E, request),
  });
}

const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
const openWorkspacePathCallbacks = new Set<(path: string) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
const pendingOpenWorkspacePaths: string[] = [];
const shareImportCallbacks = new Set<(payload: { shareCode: string }) => void>();
const pendingShareImports: { shareCode: string }[] = [];
const MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
let latestWindowControlsOverlayMetrics: WindowControlsOverlayMetrics | null = null;
let latestDesktopZoomLevel = 0;

function clampDesktopZoomLevel(level: number) {
  return Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, level));
}

function resolveDesktopZoomLevelFromFactor(zoomFactor: number) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return 0;
  }

  return clampDesktopZoomLevel(
    Math.round(Math.log(zoomFactor) / Math.log(DESKTOP_ZOOM_FACTOR_STEP)),
  );
}

function resolveDesktopZoomFactorForLevel(level: number) {
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampDesktopZoomLevel(level));
}

function readCurrentWindowControlsOverlayReadyPayload(): WindowControlsOverlayReadyPayload {
  const zoomLevel = resolveDesktopZoomLevelFromFactor(webFrame.getZoomFactor());
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const metrics: WindowControlsOverlayMetrics =
    process.platform === "darwin"
      ? {
          leftPaddingPx: Math.round(MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX / zoomFactor),
        }
      : process.platform === "win32"
        ? {
            rightPaddingPx: Math.round(WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / zoomFactor),
            titleBarHeightPx: Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * zoomFactor),
          }
        : {};
  return {
    zoomLevel,
    metrics,
  };
}

function readCurrentWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics {
  return readCurrentWindowControlsOverlayReadyPayload().metrics;
}

const initialWindowControlsOverlayPayload = readCurrentWindowControlsOverlayReadyPayload();
latestDesktopZoomLevel = initialWindowControlsOverlayPayload.zoomLevel;
latestWindowControlsOverlayMetrics = initialWindowControlsOverlayPayload.metrics;
// RootStartupLoading 渲染前 main 进程就需要拿到当前 zoom 对应的红绿灯位置。
// preload 比 React 页面更早运行，这里主动通知 main，避免等进入 App 页面后才调整。
ipcRenderer.send(PlatformChannels.WindowControlsOverlayReady, initialWindowControlsOverlayPayload);

ipcRenderer.on(
  PlatformChannels.WindowControlsOverlayChanged,
  (_event: unknown, metrics: WindowControlsOverlayMetrics) => {
    latestWindowControlsOverlayMetrics = metrics;
  },
);

ipcRenderer.on(
  PlatformChannels.DesktopZoomLevelChanged,
  (_event: unknown, state: DesktopZoomState) => {
    if (Number.isFinite(state.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
  },
);

ipcRenderer.on(PlatformChannels.OpenWorkspacePath, (_event: unknown, path: string) => {
  if (openWorkspacePathCallbacks.size === 0) {
    // 冷启动 open-workspace 会在 renderer ready 后立刻从 main 进程投递，
    // 但 React 的 platform effect 可能尚未注册 onOpenWorkspacePath。preload 先接住
    // 这条 IPC，等 UI 订阅建立后再回放，避免只打开 App 而不打开目录。
    pendingOpenWorkspacePaths.push(path);
    return;
  }

  for (const callback of openWorkspacePathCallbacks) {
    callback(path);
  }
});

ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
  if (shareImportCallbacks.size === 0) {
    pendingShareImports.push(payload);
    return;
  }
  for (const callback of shareImportCallbacks) callback(payload);
});

function updateRendererProcessTitle(): void {
  process.title = formatZCodeRendererProcessName(document.title);
}

function notifyUpdateReadyCallbacks(version: string): void {
  latestReadyUpdateVersion = version;
  for (const callback of updateReadyCallbacks) {
    callback(version);
  }
}

function notifyPostUpdateReleaseNotesCallbacks(payload: PostUpdateReleaseNotesPayload): void {
  latestPostUpdateReleaseNotes = payload;
  for (const callback of postUpdateReleaseNotesCallbacks) {
    callback(payload);
  }
}

function notifyUpdateStateCallbacks(payload: UpdateStatePayload): void {
  latestUpdateState = payload;
  // UpdateReady 是兼容旧交互的一次性缓存，但 update-downloaded
  // 之后 Squirrel.Mac 可能再上报 staging error。此时 main 会广播 idle/error，
  // preload 必须同步清掉旧 ready，否则 React 重新订阅时会把已失效版本回放出来。
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

// 进程检索体验优化：renderer 在系统里通常只会显示成通用 helper 名称，
// 这里在 preload 阶段补上 zcode-* title，便于按窗口角色筛选。
updateRendererProcessTitle();
window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
  once: true,
});

/**
 * Preload bridge —— 仅暴露需要 main 进程参与的平台操作
 *
 * 凭据管理已迁移到 host process 的 ICredentialService，
 * 通过 MessagePort RPC 访问，不再经过此 bridge。
 */
contextBridge.exposeInMainWorld("zcode", {
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      confirmSourceServerInstall?: boolean;
    },
  ) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
      target: options,
      requestId,
      ...(context ? context : {}),
    }),
  requestSourceSettingsAttachment: (sourceServerId: string) =>
    ipcRenderer.invoke(PlatformChannels.RequestSourceSettingsAttachment, {
      sourceServerId,
    }),
  cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
      requestId,
    }),
  bindRemoteWorkspaceSessionContext: (context: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  }): Promise<BindRemoteWorkspaceSessionContextIpcResult> =>
    // 原样返回结构化结果：在 preload 抛出的 Error 跨 contextBridge 会丢失 code，由 renderer 还原。
    ipcRenderer.invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context),
  startWebRemoteControl: (context: WebRemoteControlContext) =>
    ipcRenderer.invoke(PlatformChannels.StartWebRemoteControl, context),
  stopWebRemoteControl: (): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StopWebRemoteControl),
  getWebRemoteControlStatus: () => ipcRenderer.invoke(PlatformChannels.GetWebRemoteControlStatus),
  onWebRemoteControlStatusChanged: (
    callback: (status: WebRemoteControlStatus) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: WebRemoteControlStatus) => callback(payload);
    ipcRenderer.on(PlatformChannels.WebRemoteControlStatusChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlStatusChanged, handler);
  },
  disposeRemoteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.DisposeRemoteSession, sessionId),
  isDockerAvailable: (): Promise<boolean> => ipcRenderer.invoke(PlatformChannels.IsDockerAvailable),
  listWSLDistros: () => ipcRenderer.invoke(PlatformChannels.ListWSLDistros),
  listDockerContainers: () => ipcRenderer.invoke(PlatformChannels.ListDockerContainers),
  listSSHConfigAliases: (): Promise<SSHConfigAliasOption[]> =>
    ipcRenderer.invoke(PlatformChannels.ListSSHConfigAliases),
  loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.LoadMcpFromUserDirectory, payload ?? {}),
  saveMcpToUserDirectory: (payload: SaveCliMcpToUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.SaveMcpToUserDirectory, payload),
  migrateLegacyCommonMcp: (payload?: MigrateLegacyCommonMcpRequest) =>
    ipcRenderer.invoke(PlatformChannels.MigrateLegacyCommonMcp, payload ?? {}),
  /** renderer 日志通过 IPC 传到 main 进程统一存储 */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** 打开系统目录选择框，返回选中路径或 null */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** 打开系统多目录选择框；取消时返回空数组 */
  selectDirectories: (): Promise<string[]> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectories),
  /** 打开系统文件选择框，返回选中文件路径或 null */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(PlatformChannels.SelectFile),
  /** 打开系统多文件选择框，返回选中文件路径；取消时返回空数组 */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(PlatformChannels.SelectFiles),
  /** 通过 main process 的原生另存为对话框明确落盘 */
  saveFile: (payload: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke(PlatformChannels.SaveFile, payload),
  /** 将当前页面的 print 媒体版面导出为 PDF（Chromium 打印引擎，矢量文本） */
  printPageToPdf: (): Promise<PrintPageToPdfResult> =>
    ipcRenderer.invoke(PlatformChannels.PrintToPdf),
  /** 语音输入：检查并按需请求系统麦克风权限 */
  ensureMicrophoneAccess: (): Promise<MicrophoneAccessResult> =>
    ipcRenderer.invoke(PlatformChannels.MicrophoneAccess),
  /** 语音输入：macOS 重置本 App 的麦克风授权记录并重新请求 */
  resetMicrophoneAccess: (): Promise<MicrophoneAccessResetResult> =>
    ipcRenderer.invoke(PlatformChannels.ResetMicrophoneAccess),
  /** 语音输入：打开系统麦克风权限 / 声音输入设置页 */
  openMicrophoneSettings: (target: MicrophoneSettingsTarget): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.OpenMicrophoneSettings, target),
  /** 在 main 截取内置浏览器 guest 当前视口为 PNG（renderer 侧 <webview>.capturePage 会崩溃） */
  captureBrowserGuestPage: (
    payload: CaptureBrowserGuestPageRequest,
  ): Promise<CaptureBrowserGuestPageResult> =>
    ipcRenderer.invoke(PlatformChannels.CaptureBrowserGuestPage, payload),
  /** 从系统拖拽/文件输入得到的 Web File 解析真实本地路径 */
  getPathForFile: (file: File): string | null => {
    // Electron 32 起移除了非标准 File.path，renderer 不能再直接从拖拽 File 上取路径。
    // webUtils 只能在 preload 安全使用；取不到路径时返回 null，让 Web/内联附件逻辑继续兜底。
    const path = webUtils.getPathForFile(file).trim();
    return path.length > 0 ? path : null;
  },
  /** 长文本粘贴落盘为真正的本地附件，避免正文和 prompt payload 被撑大 */
  createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
    ipcRenderer.invoke(PlatformChannels.CreateTempTextAttachment, payload),
  /** dwf 产物「作为文件打开」：把某一版的字节落成本机副本 */
  materializeWorkflowArtifactFile: (payload: MaterializeWorkflowArtifactFileRequest) =>
    ipcRenderer.invoke(PlatformChannels.MaterializeWorkflowArtifactFile, payload),
  /** 订阅当前窗口内远程连接过程日志，返回 disposer */
  onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteConnectionRuntimeLog);
    ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
  },
  /** 订阅当前窗口内远程 session 关闭事件，返回 disposer */
  onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionClosedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
  },
  /** 订阅 Source 自动重连后的 logical session 换代事件。 */
  onRemoteSessionReconnected: (callback: (event: RemoteSessionReconnectedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionReconnectedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionReconnected, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionReconnected, handler);
  },
  /** 检查目录是否已在其他窗口打开 */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程 */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** 同步当前窗口里 Web 远程控制允许切换的 workspace */
  syncWebRemoteControlWorkspaces: (workspaces: WebRemoteControlWorkspaceTarget[]) =>
    ipcRenderer.send(PlatformChannels.SyncWebRemoteControlWorkspaces, workspaces),
  onWebRemoteControlReconnectWorkspace: (
    callback: (
      request: WebRemoteControlReconnectWorkspaceRequest,
    ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
  ) => {
    const handler = async (event: Electron.IpcRendererEvent, payload: unknown) => {
      const request = payload as WebRemoteControlReconnectWorkspaceRequest;
      try {
        const result = await callback(request);
        event.sender.send(PlatformChannels.WebRemoteControlReconnectWorkspace, result);
      } catch (error) {
        event.sender.send(PlatformChannels.WebRemoteControlReconnectWorkspace, {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WebRemoteControlReconnectWorkspaceResult);
      }
    };
    ipcRenderer.on(PlatformChannels.WebRemoteControlReconnectWorkspace, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlReconnectWorkspace, handler);
  },
  onWebRemoteControlRendererAction: (
    callback: (
      request: WebRemoteControlRendererActionRequest,
    ) => Promise<WebRemoteControlRendererActionResult>,
  ) => {
    const handler = async (event: Electron.IpcRendererEvent, payload: unknown) => {
      const request = payload as WebRemoteControlRendererActionRequest;
      try {
        event.sender.send(PlatformChannels.WebRemoteControlRendererAction, await callback(request));
      } catch (error) {
        event.sender.send(PlatformChannels.WebRemoteControlRendererAction, {
          requestId: request.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WebRemoteControlRendererActionResult);
      }
    };
    ipcRenderer.on(PlatformChannels.WebRemoteControlRendererAction, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlRendererAction, handler);
  },
  /** 同步当前窗口的未读 task 数到 main 进程 */
  syncWindowUnreadCount: (count: number) =>
    ipcRenderer.send(PlatformChannels.SyncWindowUnreadCount, count),
  syncActiveTaskSession: (sessionId: string | null) =>
    ipcRenderer.send(PlatformChannels.SyncActiveTaskSession, sessionId),
  /** 同步需要 main 进程即时感知的应用设置 */
  syncAppSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.send(PlatformChannels.SyncAppSettings, patch),
  /** 查询关闭驻留托盘能力（Linux 置灰判断；spec：docs/desktop/linux-close-to-tray.md） */
  getCloseToTrayCapability: () => ipcRenderer.invoke(PlatformChannels.GetCloseToTrayCapability),
  /** 快捷键设置页录制态开关：main 暂时摘除可配置菜单 accelerator，防止录制按键触发原命令 */
  setShortcutRecordingActive: (active: boolean) =>
    ipcRenderer.send(PlatformChannels.SetShortcutRecordingActive, active),
  /** 注册 main 进程要求聚焦指定 workspace tab 的回调，返回 disposer */
  onFocusTab: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(PlatformChannels.FocusTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FocusTab, handler);
  },
  /** 注册 main 进程触发新建 tab 的回调，返回 disposer */
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTab, handler);
  },
  /** 注册 main 进程请求关闭当前上下文的回调，返回 disposer */
  onCloseActiveContextRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.CloseActiveContextRequest, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.CloseActiveContextRequest, handler);
  },
  /** 注册内置 webview 的受控新页面请求，返回 disposer */
  onOpenBrowserUrl: (callback: (request: EmbeddedBrowserOpenUrlRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: EmbeddedBrowserOpenUrlRequest) => callback(request);
    ipcRenderer.on(PlatformChannels.OpenBrowserUrl, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenBrowserUrl, handler);
  },
  /** 注册内置浏览器网页权限/源选择/设备选择弹窗请求，返回 disposer */
  onEmbeddedBrowserPermissionPrompt: (
    callback: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: EmbeddedBrowserPermissionPromptEvent) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
  },
  /** 回传用户对内置浏览器权限弹窗的决策 */
  resolveEmbeddedBrowserPermissionPrompt: (
    request: EmbeddedBrowserPermissionResolveRequest,
  ): void => {
    ipcRenderer.send(PlatformChannels.EmbeddedBrowserPermissionResolve, request);
  },
  /** 读取内置浏览器站点权限记录（设置页「网站权限」） */
  getEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetEmbeddedBrowserSitePermissions),
  /** 修改/删除单条站点权限 */
  setEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.SetEmbeddedBrowserSitePermission, request),
  /** 清空全部站点权限记录 */
  clearEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserSitePermissions),
  /** 重置单个站点的全部权限记录 */
  resetEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ResetEmbeddedBrowserSitePermission, request),
  /** 注册 agent 首次 browser 命令建好受控 view 的回调（自动开 browser-use tab），返回 disposer */
  onBrowserViewDownloadStarted: (
    callback: (payload: { webContentsId: number; urls: string[] }) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: { webContentsId: number; urls: string[] }) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewDownloadStarted, handler);
    return () => {
      ipcRenderer.removeListener(PlatformChannels.BrowserViewDownloadStarted, handler);
    };
  },
  onBrowserViewReady: (
    callback: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        tabId: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewReady, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewReady, handler);
  },
  /** 注册 agent browser-use 命中真实 tab 的操作状态回调，返回 disposer。 */
  onBrowserViewOperation: (
    callback: (payload: BrowserViewOperationPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewOperationPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewOperation, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewOperation, handler);
  },
  /** 注册当前受控 tab viewport 变化回调，Agent 设置时用于同步自由尺寸模式。 */
  onBrowserViewViewportChanged: (
    callback: (payload: BrowserViewViewportChangedPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewViewportChangedPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewViewportChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewViewportChanged, handler);
  },
  onBrowserViewScreenshotSurfacePrepare: (
    callback: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfacePreparePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
  },
  onBrowserViewScreenshotSurfaceRelease: (
    callback: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfaceReleasePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
  },
  browserViewScreenshotSurfaceReady: (payload: BrowserViewScreenshotSurfaceReadyPayload): void => {
    ipcRenderer.send(PlatformChannels.BrowserViewScreenshotSurfaceReady, payload);
  },
  onBrowserViewVisibility: (
    callback: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        visible: boolean;
        workspaceKey: string;
        remoteSessionId: string | undefined;
        sessionId: string;
        tabId?: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewVisibility, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewVisibility, handler);
  },
  /** 注册 agent close 命令要求卸载受控 tab 的回调，返回 disposer */
  onBrowserViewCloseTab: (
    callback: (payload: BrowserViewCloseTabNotification) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewCloseTabNotification) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewCloseTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewCloseTab, handler);
  },
  onBrowserViewSuspend: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewSuspend, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewSuspend, handler);
  },
  onBrowserViewRestore: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewRestore, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewRestore, handler);
  },
  /** 注册 main 进程触发新建任务的回调，返回 disposer */
  onNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTask, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTask, handler);
  },
  /** 注册 main 进程触发打开工作区的回调，返回 disposer */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenWorkspace, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenWorkspace, handler);
  },
  /** 注册 deep link 直接打开本地工作区目录回调，返回 disposer */
  onOpenWorkspacePath: (callback: (path: string) => void): (() => void) => {
    openWorkspacePathCallbacks.add(callback);
    while (pendingOpenWorkspacePaths.length > 0) {
      const path = pendingOpenWorkspacePaths.shift();
      if (path) {
        callback(path);
      }
    }
    return () => openWorkspacePathCallbacks.delete(callback);
  },
  onOpenFeedbackDialog: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenFeedbackDialog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFeedbackDialog, handler);
  },
  onOpenTicketsPanel: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenTicketsPanel, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenTicketsPanel, handler);
  },
  /** 注册窗口全屏状态变化回调，返回 disposer */
  onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on(PlatformChannels.WindowFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowFullscreenChanged, handler);
  },
  /** 读取窗口最大化状态与系统原生圆角能力 */
  getDesktopWindowChromeState: (): Promise<DesktopWindowChromeState> =>
    ipcRenderer.invoke(PlatformChannels.GetDesktopWindowChromeState),
  /** 注册窗口最大化状态与系统原生圆角能力变化回调 */
  onDesktopWindowChromeStateChanged: (
    callback: (state: DesktopWindowChromeState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: DesktopWindowChromeState) => callback(state);
    ipcRenderer.on(PlatformChannels.DesktopWindowChromeStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.DesktopWindowChromeStateChanged, handler);
  },
  /** 同步读取当前原生窗口控制区安全边距 */
  getWindowControlsOverlayMetrics: (): WindowControlsOverlayMetrics =>
    latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics(),
  /** 注册原生窗口控制区安全边距变化回调，返回 disposer */
  onWindowControlsOverlayChanged: (
    callback: (metrics: WindowControlsOverlayMetrics) => void,
  ): (() => void) => {
    const handler = (_event: unknown, metrics: WindowControlsOverlayMetrics) => callback(metrics);
    callback(latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics());
    ipcRenderer.on(PlatformChannels.WindowControlsOverlayChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowControlsOverlayChanged, handler);
  },
  /** 同步读取当前桌面窗口页面缩放档位 */
  getDesktopZoomLevel: async (): Promise<DesktopZoomState> => {
    const state = await ipcRenderer.invoke(PlatformChannels.GetDesktopZoomLevel);
    if (Number.isFinite(state?.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
    return { zoomLevel: latestDesktopZoomLevel };
  },
  /** 注册当前桌面窗口页面缩放档位变化回调，返回 disposer */
  onDesktopZoomLevelChanged: (callback: (state: DesktopZoomState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopZoomState) => {
      if (!Number.isFinite(state.zoomLevel)) {
        return;
      }
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
      callback({ zoomLevel: latestDesktopZoomLevel });
    };
    callback({ zoomLevel: latestDesktopZoomLevel });
    ipcRenderer.on(PlatformChannels.DesktopZoomLevelChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopZoomLevelChanged, handler);
  },
  /** 用户点了扩展通知（§18.1 H8）：Main 已聚焦窗口，带插件 id 与要打开的视图。返回 disposer。 */
  onExtensionNotificationClick: (
    callback: (click: ExtensionNotificationClick) => void,
  ): (() => void) => {
    const handler = (_event: unknown, click: ExtensionNotificationClick) => callback(click);
    ipcRenderer.on(PlatformChannels.ExtensionNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.ExtensionNotificationClick, handler);
  },
  /** 注册用户点击系统通知后跳转到对应任务的回调，返回 disposer */
  onTaskNotificationClick: (callback: (taskId: string) => void): (() => void) => {
    const handler = (_event: unknown, taskId: string) => callback(taskId);
    ipcRenderer.on(PlatformChannels.TaskNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.TaskNotificationClick, handler);
  },
  onAppControlNavigationMessage: (callback: (message: AppNavigationRendererMessage) => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      const parsed = appNavigationRendererMessageSchema.safeParse(payload);
      if (parsed.success) callback(parsed.data);
    };
    ipcRenderer.on(APP_NAVIGATION_IPC, listener);
    return () => ipcRenderer.removeListener(APP_NAVIGATION_IPC, listener);
  },
  sendAppControlNavigation: (payload: unknown) => {
    ipcRenderer.send(APP_NAVIGATION_IPC, appNavigationRendererIpcSchema.parse(payload));
  },
  /** 打开外部 URL（用于 OAuth 跳转浏览器） */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** 查询当前语言下是否存在可用的用户社群入口 */
  canOpenCommunity: (locale: Locale): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.CanOpenCommunity, locale),
  /** 在系统文件管理器中打开指定路径 */
  openInFileManager: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenInFileManager, path),
  /** 使用系统默认应用打开本地文件 */
  openExternalFile: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenExternalFile, path),
  /** 打开 ZCode Computer Use 完整权限引导 */
  openCuaPermissionOnboarding: (options?: OpenCuaPermissionOnboardingOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenCuaPermissionOnboarding, options),
  /** 只取消当前 renderer 以 operationId 发起的 onboarding participant。 */
  cancelCuaPermissionOnboarding: (operationId: string) =>
    ipcRenderer.send(PlatformChannels.CancelCuaPermissionOnboarding, {
      operationId,
    }),
  /** 预热并缓存已验证的 Helper 路径，使 dragstart 能同步 startDrag（避免异步 I/O 错过手势） */
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** 从权限浮窗拖拽 Helper.app 到 macOS 权限列表。必须是 send —— invoke 的往返会错过手势。 */
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  notifyWebRemoteControlAuthStateChanged: (change: WebRemoteControlAuthStateChange) =>
    ipcRenderer.send(PlatformChannels.WebRemoteControlAuthStateChanged, change),
  /** 上报 OAuth state 用于 deep link 路由 */
  registerOAuthState: (payload: OAuthStateRegistration) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, payload),
  /** 注册 OAuth deep link 回调，返回 disposer */
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = createOAuthCallbackHandler(cb, () => {
      ipcRenderer.send(PlatformChannels.OAuthCallbackHandled);
    });
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** 注册支付 deep link 回调，返回 disposer */
  onPaymentCallback: (callback: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on(PlatformChannels.PaymentCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.PaymentCallback, handler);
  },
  onShareImport: (callback: (payload: { shareCode: string }) => void): (() => void) => {
    shareImportCallbacks.add(callback);
    while (pendingShareImports.length > 0) {
      const payload = pendingShareImports.shift();
      if (payload) callback(payload);
    }
    return () => shareImportCallbacks.delete(callback);
  },
  /** 通知 main process renderer 已就绪 */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
  /** 同步 renderer telemetry 上下文到 main process */
  syncTelemetryContext: (context: TelemetryRendererContext) =>
    ipcRenderer.send(PlatformChannels.SyncTelemetryContext, context),
  /** 通过 main process 统一上报业务 telemetry 事件 */
  reportTelemetryEvent: (payload: {
    context: TelemetryRendererContext;
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  }) => ipcRenderer.invoke(PlatformChannels.ReportTelemetryEvent, payload),
  /** 通过 main process 统一上报 ARMS 自定义事件 */
  reportArmsCustomEvent: (payload: {
    name: string;
    group: string;
    value?: number;
    properties?: Record<string, string | number | boolean | undefined>;
  }) => ipcRenderer.invoke(PlatformChannels.ReportArmsCustomEvent, payload),
  /** 读取 Renderer 用户操作 Trace 灰度配置。 */
  getRendererActionTraceConfig: (): Promise<RendererActionTraceConfigV1> =>
    ipcRenderer.invoke(PlatformChannels.GetRendererActionTraceConfig),
  /** 订阅 Main 推送的 Renderer 用户操作 Trace 配置变化。 */
  onRendererActionTraceConfigChanged: (
    callback: (config: RendererActionTraceConfigV1) => void,
  ): (() => void) => {
    const handler = (_event: unknown, config: RendererActionTraceConfigV1) => callback(config);
    ipcRenderer.on(PlatformChannels.RendererActionTraceConfigChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.RendererActionTraceConfigChanged, handler);
  },
  /** 发送已结束 Span；使用 send 避免遥测往返阻塞业务。 */
  reportLocalTtftBatch: (batch: import("@zcode/shared").LocalTtftBatch): void =>
    ipcRenderer.send(PlatformChannels.ReportLocalTtftBatch, batch),
  reportRendererActionTraceBatch: (batch: RendererActionTraceBatchV1): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererActionTraceBatch, batch),
  /**
   * 主窗口 renderer 的 60 秒 heap 读数。
   * 只提供单向 send：main 不回执，renderer 也不能靠它反查 main 的进程事实。
   */
  reportRendererHeapSample: (sample: RendererHeapSample): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample),
  /** 通过 main process 触发原生任务通知 */
  showTaskNotification: (payload: TaskNotificationPayload) =>
    ipcRenderer.send(PlatformChannels.ShowTaskNotification, payload),
  showExtensionNotification: (
    payload: ExtensionNotificationPayload,
  ): Promise<NotificationsShowResult> =>
    ipcRenderer.invoke(PlatformChannels.ShowExtensionNotification, payload),
  /** 导出日志：打包 ~/.zcode/v2 及外部 agent 日志为 zip 并在 Finder 中显示 */
  exportLogs: (): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke(PlatformChannels.ExportLogs),
  /** 截取当前窗口，用于错误反馈携带现场画面 */
  captureWindowScreenshot: () => ipcRenderer.invoke(PlatformChannels.CaptureWindowScreenshot),
  // CDP-on-guest pivot：`<webview>` guest dom-ready 后上报 webContentsId 给 main attach。
  browserViewLoadUrl: (payload: { webContentsId: number; url: string }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewLoadUrl, payload),
  browserViewAttachGuest: (payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewAttachGuest, payload),
  /** React 卸载旧 `<webview>` 前同步等待 main 断开 native CDP session。 */
  browserViewDetachGuest: (payload: { key: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewDetachGuest, payload),
  browserViewCloseTab: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewCloseTabFromRenderer, payload),
  browserViewReportResidency: (payload: BrowserViewResidencyReportPayload): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewReportResidency, payload),
  browserViewPromoteDraftTabs: (payload: BrowserViewPromoteDraftTabsRequest): Promise<string[]> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewPromoteDraftTabs, payload),
  browserViewSuspendReady: (payload: { tabId: string; generation: number }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewSuspendReady, payload),
  browserViewEnsureResident: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewEnsureResident, payload),
  browserViewRestoreTabs: (
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewRestoreTabs, payload),
  /** 将 UI 自由尺寸同步为当前受控 tab 的真实 viewport。 */
  browserViewUpdateViewport: (payload: { tabId: string; viewport: BrowserViewportSize | null }) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewUpdateViewport, payload),
  /** 从自动发现的 Chrome Profile 一次性导入内置浏览器数据。 */
  importChromeBrowserData: (options?: import("@zcode/shared").ChromeBrowserDataImportOptions) =>
    ipcRenderer.invoke(PlatformChannels.ImportChromeBrowserData, options),
  /** 清理内置浏览器缓存或全部站点数据。 */
  clearEmbeddedBrowserData: (mode: "cache" | "all") =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserData, mode),
  /** 读取开发态 stdio tap proxy 开关状态 */
  getZCodeStdioTapDevState: (): Promise<ZCodeStdioTapDevState> =>
    ipcRenderer.invoke(PlatformChannels.GetZCodeStdioTapDevState),
  /** 注册 main 进程修改 settings 后的通知，返回 disposer */
  onSettingsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.SettingsChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.SettingsChanged, handler);
  },
  /** 注册应用语言变化，返回 disposer */
  onApplicationLocaleChanged: (callback: (locale: Locale) => void): (() => void) => {
    const handler = (_event: unknown, locale: Locale) => callback(locale);
    ipcRenderer.on(PlatformChannels.ApplicationLocaleChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.ApplicationLocaleChanged, handler);
  },
  /** 注册"手动检查更新"结果的回调，返回 disposer */
  onUpdateCheckResult: (callback: (payload: UpdateCheckResultPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: UpdateCheckResultPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.UpdateCheckResult, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.UpdateCheckResult, handler);
  },
  getUpdateState: (): Promise<UpdateStatePayload> =>
    ipcRenderer.invoke(PlatformChannels.GetUpdateState),
  /** 开始下载当前已发现的更新 */
  downloadUpdate: () => ipcRenderer.invoke(PlatformChannels.DownloadUpdate),
  /** 取消当前正在下载的更新 */
  cancelUpdateDownload: () => ipcRenderer.invoke(PlatformChannels.CancelUpdateDownload),
  /** 打开独立更新窗口 */
  openUpdateStatusWindow: () => ipcRenderer.invoke(PlatformChannels.OpenUpdateStatusWindow),
  /** 读取自动更新偏好 */
  getAutoUpdatePreferences: () => ipcRenderer.invoke(PlatformChannels.GetAutoUpdatePreferences),
  /** 写入“自动下载并安装更新”偏好 */
  setAutoDownloadAndInstallUpdates: (enabled: boolean) =>
    ipcRenderer.invoke(PlatformChannels.SetAutoDownloadAndInstallUpdates, enabled),
  getDesktopSessionActivity: () => ipcRenderer.invoke(PlatformChannels.GetDesktopSessionActivity),
  /** 注册自动更新持续状态变化，返回 disposer */
  onUpdateStateChanged: (callback: (payload: UpdateStatePayload) => void): (() => void) => {
    updateStateCallbacks.add(callback);
    if (latestUpdateState) {
      callback(latestUpdateState);
    }
    return () => {
      updateStateCallbacks.delete(callback);
    };
  },
  /** 注册新版本已下载完毕的回调，返回 disposer */
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    // 主进程的 update-ready 是一次性事件，常常早于 React effect 注册。
    // 这里在 preload 层先缓存最新版本，并在订阅时立即回放，
    // 这样 UI 即使晚挂载，也能拿到“更新已下载完毕”的稳定状态。
    updateReadyCallbacks.add(callback);
    if (latestReadyUpdateVersion) {
      callback(latestReadyUpdateVersion);
    }
    return () => {
      updateReadyCallbacks.delete(callback);
    };
  },
  /** 注册更新安装后的版本说明，返回 disposer */
  onPostUpdateReleaseNotes: (
    callback: (payload: PostUpdateReleaseNotesPayload) => void,
  ): (() => void) => {
    postUpdateReleaseNotesCallbacks.add(callback);
    if (latestPostUpdateReleaseNotes) {
      callback(latestPostUpdateReleaseNotes);
    }
    return () => {
      postUpdateReleaseNotesCallbacks.delete(callback);
    };
  },
  /** 标记当前版本说明已读 */
  acknowledgePostUpdateReleaseNotes: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.AcknowledgePostUpdateReleaseNotes, version),
  /** 跳过当前已发现的更新版本 */
  skipUpdateVersion: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.SkipUpdateVersion, version),
  /** 用户确认重启安装更新 */
  quitAndInstallUpdate: () => ipcRenderer.invoke(PlatformChannels.QuitAndInstallUpdate),
  /** 获取已安装的编辑器/终端列表（含图标） */
  getInstalledEditors: (filePath?: string) =>
    ipcRenderer.invoke(PlatformChannels.GetInstalledEditors, filePath),
  getFileApplications: (target: FileApplicationTarget) =>
    ipcRenderer.invoke(PlatformChannels.GetFileApplications, target),
  openFileWithApplication: (applicationId: string, target: FileApplicationTarget) =>
    ipcRenderer.invoke(PlatformChannels.OpenFileWithApplication, { applicationId, target }),
  getApplicationIcon: (request: string | ApplicationIconRequest) =>
    ipcRenderer.invoke(PlatformChannels.GetApplicationIcon, request),
  /** 用指定编辑器打开路径 */
  openInEditor: (editorId: string, path: string, options?: OpenInEditorOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenInEditor, {
      editorId,
      path,
      options,
    }),
  /** 执行桌面窗口级命令 */
  executeDesktopCommand: (command: DesktopCommandId) =>
    ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand, command),
  /** 同步应用菜单语言 */
  setApplicationLocale: (locale: Locale) =>
    ipcRenderer.invoke(PlatformChannels.SetApplicationLocale, locale),
  /** 读取宿主系统语言 */
  getSystemLocale: (): Promise<Locale> => ipcRenderer.invoke(PlatformChannels.GetSystemLocale),
  /** 同步标题栏亮暗色 */
  setTitleBarTheme: (theme: DesktopTitleBarTheme) =>
    ipcRenderer.invoke(PlatformChannels.SetTitleBarTheme, theme),
  /** 获取桌面端设备标识符（deviceMid） */
  getDeviceId: () => ipcRenderer.invoke(PlatformChannels.GetDeviceId),
});

installPluginSandboxHostBridge();

/**
 * MessagePort 不能通过 contextBridge 传递（contextBridge 会把它包成 Proxy，
 * 丢失 addEventListener 等原生方法）。改用 window.postMessage 的 transfer
 * 机制将 MessagePort 原样传递到 renderer 的 window context 中。
 */
ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
  if (port && parsed.success)
    window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
  else port?.close();
});

ipcRenderer.on(InternalChannels.ScopedServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = scopedServicePortPayloadSchema.safeParse(payload);
  if (!port || !parsed.success) return;
  // Bug 根因：这里曾用手工字段白名单重建 payload；Main 新增 workspace scope 后
  // Preload 未同步白名单，Renderer 因而把 project logical session 原地绑定成 conversation。
  window.postMessage(
    {
      type: InternalChannels.ScopedServicePort,
      ...parsed.data,
    },
    "*",
    [port],
  );
});

ipcRenderer.on(InternalChannels.ScopedServicePortReleased, (_event, payload: unknown) => {
  // 与 port 一样交给 renderer world；是否释放由 renderer 按当前登记判断。
  if (!payload || typeof payload !== "object") return;
  window.postMessage({ ...payload, type: InternalChannels.ScopedServicePortReleased }, "*");
});

ipcRenderer.on(
  InternalChannels.SourceSettingsServicePort,
  (
    event,
    payload: {
      attachmentId?: string;
      sourceServerId?: string;
    },
  ) => {
    const [port] = event.ports;
    if (!port) return;
    window.postMessage(
      {
        type: InternalChannels.SourceSettingsServicePort,
        attachmentId: payload.attachmentId,
        sourceServerId: payload.sourceServerId,
      },
      "*",
      [port],
    );
  },
);

window.addEventListener("message", (event) => {
  if (event.source !== window || typeof event.data !== "object" || event.data === null) {
    return;
  }
  const payload = event.data as {
    type?: unknown;
    attachmentId?: unknown;
    sessionId?: unknown;
  };
  if (
    payload.type !== InternalChannels.ScopedServicePortReady ||
    typeof payload.attachmentId !== "string" ||
    !payload.attachmentId ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId
  ) {
    return;
  }
  // MessagePort 注册发生在隔离的 renderer world，Main 不能把“已投递”误当作“已可用”。
  // preload 只把 renderer 的 ready ACK 薄转发给 Main，业务 attachment 状态仍由窗口 session manager 管理。
  ipcRenderer.send(InternalChannels.ScopedServicePortReady, {
    attachmentId: payload.attachmentId,
    sessionId: payload.sessionId,
  });
});

ipcRenderer.on(PlatformChannels.TaskNotificationSound, () => {
  window.postMessage(InternalChannels.TaskNotificationSound, "*");
});

ipcRenderer.on(PlatformChannels.UpdateReady, (_event, version: string) => {
  notifyUpdateReadyCallbacks(version);
});

ipcRenderer.on(PlatformChannels.UpdateStateChanged, (_event, payload: UpdateStatePayload) => {
  notifyUpdateStateCallbacks(payload);
});

ipcRenderer.on(
  PlatformChannels.PostUpdateReleaseNotes,
  (_event, payload: PostUpdateReleaseNotesPayload) => {
    notifyPostUpdateReleaseNotesCallbacks(payload);
  },
);

// dom-ready autoInject 之后 Bridge 若被重置，再尝试一次包装
scheduleArmsEventBridgePatch();

// 启动控制面先于普通 RPC；reload 从 Main 的通知镜像补齐，不触发新迁移。
ipcRenderer.on(InternalChannels.DatabaseStartupState, (_event, raw: unknown) => {
  const parsed = databaseStartupStateSchema.safeParse(raw);
  if (parsed.success)
    window.postMessage({ type: InternalChannels.DatabaseStartupState, state: parsed.data }, "*");
});
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupControl)
    return;
  const parsed = databaseStartupControlSchema.safeParse(event.data.control);
  if (parsed.success) ipcRenderer.send(InternalChannels.DatabaseStartupControl, parsed.data);
});

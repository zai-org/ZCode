import {
  BROWSER_LOCAL_PREVIEW_PRIVILEGES,
  installBrowserLocalPreview,
} from "@desktop/main/browser-local-preview/index.js";
import { createRemoteConversationTelemetryDispatcher } from "@zcode/shared/conversation-telemetry";
import { installRequestSecurityDiagnostics } from "./request-security-edition/index.js";
import { createLocalTtftExporter } from "./localTtftExporter.js";
/* eslint-disable max-lines */
import "./desktopEarlyDataBaseDirBootstrap.js";
import "./desktopEarlyChromiumHardwareAccelerationBootstrap.js";
import { powerMonitor, powerSaveBlocker } from "electron";
import { crashCapturePaths } from "./appCrashCaptureBootstrap.js";
import { armsInitPromise } from "./appARMSBootstrap.js";
import {
  onLocalDatabaseStartupReady,
  configureDatabaseStartupQuit,
} from "./databaseStartupRelay.js";
import armsRum from "@arms/rum-electron";
import { createArmsUserIdentitySync } from "./armsUserIdentity.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import {
  createDesktopContextPromptRollout,
  createElectronDesktopContextPromptConfigFetcher,
} from "./desktopContextPromptRollout.js";
import { buildBrowserViewCloseTabNotification } from "./browserView/browserCloseTabNotification.js";
import { BrowserGuestManager } from "./browserView/browserGuestManager.js";
import { createElectronBrowserWebmRecorder } from "./browserView/electronBrowserWebmRecorder.js";
import { installBrowserRestoreBootstrapProtocol } from "./browserView/browserRestoreBootstrapProtocol.js";
import {
  createLocalMediaPreviewPathRegistry,
  installLocalMediaPreviewProtocol,
  registerLocalMediaPreviewScheme,
} from "./localMediaPreviewProtocol.js";
import { createDesktopBrowserScreenshotSurfaceCoordinator } from "./browserView/browserScreenshotSurfaceCoordinatorWiring.js";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";
import { EmbeddedBrowserJavaScriptDialogController } from "./embeddedBrowserJavaScriptDialog.js";
import {
  browserOperationResetsResizeBaseline,
  resolveBrowserOperationTabId,
} from "./browserView/browserOperationIndicator.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeImage,
  net,
  protocol,
  session,
  shell,
  webContents,
} from "electron";
import { randomUUID } from "node:crypto";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import {
  createCredentialService,
  createSettingService,
  createTelemetryCore,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
  createTelemetryAuthorizationLoader,
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  getAppConfigDir,
  getConversationWorkspaceDir,
  getDataBaseDir,
  getExportLogDir,
  getZCodeDataRootDir,
  normalizeRuntimeProcessEnv,
  setDataBaseDir,
  migrateApplicationStorage,
  resolveDefaultZCodeAgentCommand,
  startupStorage,
} from "@zcode/services/node";
import {
  desktopMenuMessageIds,
  type Locale,
  type AppSettings,
  type appSettingsPatchSchema,
  PlatformChannels,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_AUTO_UPDATE_ENABLED,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DEFAULT_LOCALE,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  resolveWebRemoteControlRelayWsUrl,
  resolveZCodeEndpointOrigin,
  shouldEnableE2ETestBridge,
  type UpdateStatePayload,
  type TelemetryEventPayload,
  HostMessageTypes,
  InternalChannels,
} from "@zcode/shared";
import { logger, webRemoteControlRelayLogger, flushLocalTtftLogs } from "./logger.js";
import { markMainLaunchAppReady } from "./desktopLaunchMarks.js";
import { createCuaPipFocusRouter, resolveCuaPipWindowKey } from "./cuaPipFocusRouter.js";
import { createDesktopTelemetryFetch } from "./desktopTelemetryFetch.js";
import {
  acknowledgePostUpdateReleaseNotes,
  getAutoUpdaterState,
  hydratePendingPostUpdateReleaseNotes,
  initAutoUpdater,
  onAutoUpdaterStateChanged,
  refreshAutoUpdaterReleaseChannel,
  resolveUpdateFeedSourceFromStartupConfig,
  syncAutoUpdaterStateToWindow,
  syncPostUpdateReleaseNotesToWindow,
  syncReadyUpdateToWindow,
} from "./autoUpdater.js";
import { BroadcastHub } from "./broadcastHub.js";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";
import { createAppLaunchGate } from "./appLaunchGate.js";
import { createAppLaunchCoordinator } from "./appLaunchCoordinator.js";
import { createAppTelemetryRuntime } from "./appTelemetryRuntime.js";
import { createRendererActionTraceBroker } from "./rendererActionTraceBroker.js";
import { createRendererActionTraceExporter } from "./rendererActionTraceExporter.js";
import { registerRendererActionTraceIpc } from "./rendererActionTraceIpc.js";
import { createRendererActionTraceRollout } from "./rendererActionTraceRollout.js";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
  type AppShutdownKind,
} from "./appShutdownPolicy.js";
import { createPrimaryWindowCoordinator } from "./primaryWindowCoordinator.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { flushMainE2ECoverage } from "./e2eCoverage.js";
import { resolveStartupWindowBootstrap, type StartupWindowBootstrap } from "./startupWorkspace.js";
import {
  createStartupDeepLinkConsumptionGate,
  type ExplicitStartupWorkspaceRequest,
  resolveExplicitStartupWorkspaceBootstrap,
} from "./startupWorkspaceDeepLinkGate.js";
import { createWebRemoteControlManager } from "./webRemoteControlManager.js";
import {
  createMobileLogSink,
  createWebRemoteControlDeviceStorage,
  pullAndExportMobileLogs,
  runWebRemoteControlActionInRenderer,
  type MobileLogSink,
} from "#src/main/web-remote-relay/index.js";
import { createWebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";
import { reconnectWebRemoteControlWorkspaceInRenderer } from "./webRemoteControlRendererReconnect.js";
import { sendWebRemoteControlStatusChangedToWindow } from "./webRemoteControlStatusEvents.js";
import { executeDesktopCommand } from "./desktopCommandHandlers.js";
import { clampDesktopZoomLevel, resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import {
  getDesktopMenuLabel as getDesktopMenuLabelByLocale,
  rebuildApplicationMenu,
  resolveSystemApplicationLocale,
  updateZCodeStdioTapDevMenuState,
} from "./desktopApplicationMenu.js";
import { applyAppIcon } from "./desktopWindowChrome.js";
import { resolveWindowsAppUserModelIdForFlavor } from "../../scripts/desktop-product-identity.mjs";
import type { DesktopWindowSize } from "./desktopWindowSize.js";
import { maybeWarnArchitectureMismatch } from "./desktopArchitectureGuard.js";
import { maybeBlockStartupForForceUpdate } from "./forceUpdateGuard.js";
import { createDesktopTray, updateWindowsDesktopTrayMenu } from "./desktopTray.js";
import {
  createCloseToTrayCapabilityMonitor,
  resolveCloseToTrayBootstrapValue,
  resolveCloseToTrayRuntimeValue,
  resolveCloseToTraySupported,
} from "./desktopTraySupport.js";
import { createWindowsCuaOperationIndicator } from "./windowsCuaOperationIndicator.js";
import {
  configureDockMenu,
  createWindow,
  focusWorkspaceInExistingWindow,
  showCurrentWindowFromDock,
  syncApplicationUnreadBadge,
  handleDesktopWindowCloseRequest,
} from "./desktopWindowLifecycle.js";
import { resolveZCodeBuiltinProviderConfigFilePath } from "./desktopProviderConfig.js";
import {
  getCredentialsDir,
  isDockerDaemonAvailable,
  listSSHConfigAliases,
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  loadHostProcessEnvFromLocalFiles,
  resolveBundledGlmBinaryPath,
  resolveRemoteAssetDirs,
  resolveZCodeEndpointEnvBaseOrigin,
  desktopRuntimeEnv,
  runtimeApplicationName,
  runtimeHomePath,
  runtimeSessionDataPath,
  runtimeUserDataPath,
  shouldUseElectronDefaultUserDataPath,
} from "./desktopRuntimeEnv.js";
import {
  disposeHostProcess,
  disposeHostProcessAndWait,
  listDisposingHostProcesses,
  loadWindow,
  spawnHostProcess,
} from "./desktopHostProcess.js";
import { spawnCronScheduler, type CronSchedulerHandle } from "./desktopCronScheduler.js";
import {
  clearOAuthRoutesForWindow,
  handleDeepLink,
  handleOpenWorkspacePath,
  registerDeepLinkProtocol,
  resolveExternalWorkspaceOpenDialogCopy,
} from "./desktopOAuthDeepLink.js";
import { handleSecondInstanceWorkspaceRequest } from "./desktopSecondInstanceDeepLink.js";
import { installFinderOpenFolderWorkflow } from "./desktopFinderOpenFolderWorkflow.js";
import { installWindowsOpenFolderContextMenu } from "./desktopWindowsOpenFolderContextMenu.js";
import {
  createDeepLinkSingleInstanceData,
  extractWorkspaceOpenPath,
  extractDeepLinkUrlFromArgs,
  extractOpenWorkspacePathFromArgs,
  isWorkspaceOpenUrl,
} from "./desktopDeepLinkUrl.js";
import { createRemoteWorkspaceSessionManager } from "./desktopRemoteSessions.js";
import {
  reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnectToArms,
  stopRemoteUsageArmsPeriodicSampling,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { resolveCanonicalWslTarget } from "./desktopWslTargetResolver.js";
import {
  listRegisteredHostAgentProcessIds,
  setBrowserUseGuestWebContentsIdsProvider,
} from "./resourceManagerWindow.js";
import { createWebRemoteControlSharedHostAttachments } from "./webRemoteControlSharedHostAttachments.js";
import { createDesktopHelpConfigReader } from "./desktopHelpConfig.js";
import { registerPlatformIpcHandlers } from "./desktopMainIpcPlatform.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { registerRemoteIpcHandlers } from "./desktopMainIpcRemote.js";
import {
  configureDesktopStabilityTelemetry,
  getStabilityLifecycleScene,
  notifyStabilityAppExit,
  notifyStabilityLifecycle,
  reportAgentProcessExitToArms,
  reportAgentProcessReadyToArms,
  reportAgentProcessStartToArms,
  reportAgentProcessSpawnErrorToArms,
  reportAgentProcessExceptionToArms,
  registerDesktopStabilityMonitors,
  registerStabilityMainWindow,
  scheduleReportPerfAppStartAfterMainViewReady,
} from "./desktopStabilityTelemetry.js";
import {
  configureDesktopResourceTelemetry,
  registerDesktopResourceTelemetry,
  resolveResourceUsageScene,
  stopDesktopResourceTelemetry,
} from "./desktopResourceTelemetry.js";
import { registerRendererHeapSampleIpc } from "./processResourceRendererHeapSource.js";
import {
  registerDesktopZCodeDataSizeTelemetry,
  stopDesktopZCodeDataSizeTelemetry,
} from "./desktopZCodeDataSizeTelemetry.js";
import { configureDesktopMcpTelemetry, reportMcpTelemetryToArms } from "./desktopMcpTelemetry.js";
import {
  configureDesktopNetworkTelemetry,
  registerDesktopNetworkTelemetry,
  stopDesktopNetworkTelemetry,
} from "./desktopNetworkTelemetry.js";
import { applyDesktopChromiumNetworkPolicies } from "./desktopNetworkPolicy.js";
import { applyEmbeddedBrowserPermissionPolicy } from "./embeddedBrowserPermissionPolicy.js";
import { createEmbeddedBrowserSitePermissionStore } from "./embeddedBrowserSitePermissionStore.js";
import {
  createEmbeddedBrowserPermissionUiBridge,
  setActiveEmbeddedBrowserPermissionUiBridge,
} from "./embeddedBrowserPermissionUiBridge.js";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import {
  findWindowsProcessesReferencingResourceMarkers,
  probeWindowsPackagedResourceWritable,
  resolveWindowsPackagedResourceLockMarkers,
  runWindowsUpdateProcessCleanup,
  snapshotWindowsPackagedResources,
  WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
} from "./windowsInstallResourceLocks.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import {
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
  getPluginSandboxHost,
  installPluginSandboxHost,
} from "./pluginSandbox/index.js";

registerLocalMediaPreviewScheme(protocol, [
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
  BROWSER_LOCAL_PREVIEW_PRIVILEGES,
]);
const localMediaPreviewPathRegistry = createLocalMediaPreviewPathRegistry();

// e2e 由 Chromedriver 管理远程调试端口；如果这里继续固定到 9229，
// 会和开发态已打开的 ZCode Dev 抢端口，导致 WebDriver session 创建前白屏超时。
// 仅本地开发运行默认开启远程调试端口，并允许 e2e 通过环境变量交给 Chromedriver 接管。
if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9229");
}

app.setName(runtimeApplicationName);
if (runtimeHomePath) {
  app.setPath("home", runtimeHomePath);
}
if (!shouldUseElectronDefaultUserDataPath) {
  if (!runtimeUserDataPath || !runtimeSessionDataPath) {
    throw new Error(
      "Desktop runtime data paths are required when Electron default userData is disabled",
    );
  }
  app.setPath("userData", runtimeUserDataPath);
  app.setPath("sessionData", runtimeSessionDataPath);
}
process.title = runtimeApplicationName;

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection:", reason);
});

const iconPath =
  process.platform === "win32"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_windows.png")
      : join(import.meta.dirname, "../../build/icon_windows.png")
    : app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/icon.png");
const linuxDesktopIntegrationIconPath =
  process.platform === "linux"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_512x512.png")
      : join(import.meta.dirname, "../../build/icons/512x512.png")
    : iconPath;
let currentApplicationLocale: Locale = DEFAULT_LOCALE;
let closeToTrayOnWindows = true;
// CR-01：托盘实例创建结果（模块级，关窗分支读取）。DBus 能力探测通过不等于 Electron
// Tray 创建成功；隐藏窗口前必须确认最终用户入口真实存在，否则隐藏即失联。
let desktopTrayReady = false;
// 关闭驻留托盘能力 monitor（spec：docs/desktop/linux-close-to-tray.md）。
// Linux 关窗分支是同步回调，只能读缓存；启动后首次探测完成前按"不可用"安全默认。
const closeToTrayCapabilityMonitor = createCloseToTrayCapabilityMonitor({
  platform: process.platform,
});
// keep-awake：全局开关 keepAwakeWhileRunning。打开后主进程持有
// powerSaveBlocker("prevent-app-suspension")，阻止系统闲置休眠（防不了合盖/手动睡眠）。
// 不再绑定闲时任务活跃计数——设置页「常规」与 Automations 入口镜像同一配置。
let keepAwakeWhileRunning = false;
let powerSaveBlockerId: number | null = null;
function reconcileKeepAwakeBlocker(): void {
  const shouldBlock = keepAwakeWhileRunning;
  if (shouldBlock && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    logger.info(`[keep-awake] powerSaveBlocker started id=${powerSaveBlockerId}`);
  } else if (!shouldBlock && powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch {
      // 忽略：id 可能已失效。
    }
    logger.info(`[keep-awake] powerSaveBlocker stopped id=${powerSaveBlockerId}`);
    powerSaveBlockerId = null;
  }
}

const embeddedBrowserDialogController = new EmbeddedBrowserJavaScriptDialogController({
  iconPath,
  getLocale: () => currentApplicationLocale,
  logger,
});
ipcMain.on(PlatformChannels.EmbeddedBrowserJavaScriptDialog, (event, payload: unknown) => {
  event.returnValue = embeddedBrowserDialogController.handleDialogRequest(
    event.sender.id,
    event.senderFrame?.url ?? "",
    payload,
  );
});
// browser-use CDP-on-guest pivot：main 进程按 key 管理 `<webview>` guest 的
// webContents + CDP，为 executor 提供 ControlledView。所有 execute/attach 出口都走这里。
// BrowserGuestManager 虽是 main singleton，但 tab owner 带 window/workspace/session/generation；
// create/close 只投递到 owner window，禁止旧的全窗口广播造成跨窗口 attach。
const browserScreenshotSurfaceCoordinator = createDesktopBrowserScreenshotSurfaceCoordinator({
  fromId: (windowId) => BrowserWindow.fromId(windowId),
  fromWebContentsId: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  log: (message) => logger.debug(message),
  warn: (message) => logger.warn(message),
});
const browserGuestManager = new BrowserGuestManager(
  (msg) => logger.debug(msg),
  undefined,
  (tabId, owner) => {
    const win = owner ? BrowserWindow.fromId(owner.windowId) : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send(
        PlatformChannels.BrowserViewCloseTab,
        buildBrowserViewCloseTabNotification(tabId, owner),
      );
    }
  },
  (tabId, owner) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewReady, {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  (visible, owner, tabId) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewVisibility, {
        visible,
        workspaceKey: owner.workspaceKey,
        remoteSessionId: owner.remoteSessionId,
        sessionId: owner.sessionId,
        ...(tabId ? { tabId } : {}),
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  (viewport, owner, tabId) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewViewportChanged, {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
        viewport,
      });
    }
  },
  (base64Png, target) => {
    const source = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
    if (source.isEmpty()) return undefined;
    const resized = source.resize({
      width: target.width,
      height: target.height,
      quality: "best",
    });
    if (resized.isEmpty()) return undefined;
    return resized.toPNG().toString("base64");
  },
  browserScreenshotSurfaceCoordinator,
  {
    // Browser shell/pageState 不跨进程恢复，以保持“完整退出即清空”的语义，
    // 并避免恢复的 shell 与新 webview 重复 attach。因此不注入 recoveryStore；
    // 进程内 residency 事件仍保留给现有 IPC 兼容层。
    onSuspendTabRequested: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewSuspend, payload);
      }
    },
    onRestoreTabRequested: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    onResidencyChanged: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    onRecoveryOrphanCloseRequested: ({ tabId, reason }) => {
      const tabOwner = browserGuestManager.getTabOwner(tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewCloseTab, {
          tabId,
          reason,
        });
      }
    },
    warn: (message) => logger.warn(message),
    recording: {
      createRecorder: (input) =>
        createElectronBrowserWebmRecorder(input, (message) => logger.debug(message)),
    },
  },
  // 隐藏窗口截图的透明 presentation：capture 期间 showInactive + opacity 0 主动要帧。
  (windowId) => BrowserWindow.fromId(windowId),
);
setBrowserUseGuestWebContentsIdsProvider(() => browserGuestManager.listGuestWebContentsIds());

// browser-use：带诊断日志地执行 browser 命令（两处 spawnHostProcess wiring 共用）。
// 打入口/出口便于定位卡点（如 navigate loadURL 挂起、CDP 报错等）。
// CDP-on-guest pivot：execute 走 browserGuestManager（不再传 win —— guest 已由 attachGuest 关联）。
async function runBrowserCommandOnView(params: {
  win: BrowserWindow;
  requestId: string;
  browserId?: string;
  browserGeneration?: number;
  controlScopeId?: string;
  sessionId: string;
  turnId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  sessionContext?: "live" | "cached";
  command: unknown;
}): Promise<{ ok: boolean; [k: string]: unknown }> {
  const endDialogAutomation = embeddedBrowserDialogController.beginAutomation(params.win.id);
  const command = params.command as { method?: string; tabId?: unknown } | null;
  const method = command?.method ?? "?";
  const workspaceKey =
    params.workspaceIdentity?.trim() ||
    params.workspaceKey ||
    params.workspacePath ||
    params.sessionId;
  const requestedTabId = resolveBrowserOperationTabId(command);
  const resetsResizeBaseline = browserOperationResetsResizeBaseline(command);
  const sendOperation = (tabId: string) => {
    if (params.win.isDestroyed()) return;
    params.win.webContents.send(PlatformChannels.BrowserViewOperation, {
      workspaceKey,
      ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      sessionId: params.sessionId,
      tabId,
      browserId: params.browserId ?? "legacy-iab",
      browserGeneration: params.browserGeneration ?? 0,
      resetsResizeBaseline,
    });
  };
  // 交互说明：绝大多数 Tab API 都显式携带 tabId，可在命令真正执行前亮起操作图标；
  // newTab / default-tab 兼容调用要等 manager 返回真实 meta.tabId 后再补发，避免猜 tab identity。
  if (requestedTabId) sendOperation(requestedTabId);
  logger.debug(
    `[browser-use] execute start browserId=${params.browserId ?? "legacy-iab"} sessionId=${params.sessionId} method=${method}`,
  );
  try {
    const result = await browserGuestManager.execute(
      {
        requestId: params.requestId,
        controlScopeId: params.controlScopeId,
        browserId: params.browserId ?? "legacy-iab",
        browserGeneration: params.browserGeneration ?? 0,
        windowId: params.win.id,
        workspaceKey,
        sessionId: params.sessionId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        clientMode: params.clientMode ?? "desktop-continuous",
      },
      params.command as Parameters<typeof browserGuestManager.execute>[1],
    );
    logger.debug(
      `[browser-use] execute done sessionId=${params.sessionId} method=${method} ok=${result.ok} elapsedMs=${(result as { elapsedMs?: number }).elapsedMs ?? "?"}`,
    );
    if (!requestedTabId) {
      const resolvedTabId = resolveBrowserOperationTabId(command, result);
      if (resolvedTabId) sendOperation(resolvedTabId);
    }
    return result;
  } catch (error) {
    logger.error(
      `[browser-use] execute threw sessionId=${params.sessionId} method=${method}:`,
      error,
    );
    throw error;
  } finally {
    endDialogAutomation();
  }
}
let currentDesktopZoomLevel = 0;
let currentDesktopWindowSize: DesktopWindowSize | undefined;
const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
const settingsFile = join(homedir(), ".zcode", "v2", "setting.json");
let activeAppShutdownPolicy = resolveAppShutdownPolicy("normal", process.platform);
let activeAppShutdownKind: AppShutdownKind | null = null;
const WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS = 2_000;

const broadcastHub = new BroadcastHub();
const taskRealtimeBus = new TaskRealtimeBus({ logger });
// 内存诊断计数器：desktopResourceTelemetry 每 60s collect
// 一次写主日志。will-download 监听数用于观察关窗后 defaultSession 是否残留监听。
mainMemoryDiagnosticsRegistry.register("taskBus", () => taskRealtimeBus.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("broadcast", () => broadcastHub.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("guest", () =>
  browserGuestManager.collectMemoryDiagnostics(),
);
mainMemoryDiagnosticsRegistry.register("app", () => ({
  windows: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
  willDownloadListeners: session.defaultSession.listenerCount("will-download"),
}));
const hostProcessLocalEnv = loadHostProcessEnvFromLocalFiles();
interface RuntimeProcessEnvPreparation {
  patchPromise: Promise<Record<string, string>>;
  fallbackPatch: Record<string, string>;
}

let runtimeProcessEnvPrewarmSequence = 0;
function createRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const prewarmId = ++runtimeProcessEnvPrewarmSequence;
  const startedAt = Date.now();
  // Windows process.env 保留 Path 的原始大小写，展开到普通对象后不再大小写不敏感。
  // dotenv 先合并、真实进程环境后合并，再统一成唯一 PATH，保持旧 Host 继承的优先级语义。
  const baseEnv = normalizeRuntimeProcessEnv(
    {
      ...hostProcessLocalEnv,
      ...process.env,
    },
    process.platform,
  );
  const fallbackPatch = buildRuntimeProcessEnvPatch(baseEnv, null, {
    platform: process.platform,
  });
  const patchPromise = captureLoginShellEnvSnapshot({
    baseEnv,
    platform: process.platform,
  }).then(
    (snapshot) => {
      const patch = buildRuntimeProcessEnvPatch(baseEnv, snapshot, {
        platform: process.platform,
      });
      if (process.platform !== "win32" && !snapshot) {
        logger.warn(
          `[startup] login shell env unavailable id=${prewarmId}; using shell-free fallback after ${Date.now() - startedAt}ms`,
        );
        return patch;
      }
      logger.info(
        `[startup] runtime process env prepared asynchronously id=${prewarmId} in ${Date.now() - startedAt}ms`,
      );
      return patch;
    },
    (error) => {
      logger.warn(
        `[startup] runtime process env prewarm failed id=${prewarmId}; using shell-free fallback`,
        error,
      );
      return fallbackPatch;
    },
  );
  return { patchPromise, fallbackPatch };
}

// 首窗在 Main import 时就开始采集；后续窗口各自刷新，避免永久复用进程启动时的 shell snapshot。
let initialRuntimeProcessEnvPreparation: RuntimeProcessEnvPreparation | null =
  createRuntimeProcessEnvPreparation();
function takeRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const initialPreparation = initialRuntimeProcessEnvPreparation;
  if (initialPreparation) {
    initialRuntimeProcessEnvPreparation = null;
    return initialPreparation;
  }
  return createRuntimeProcessEnvPreparation();
}
const forceQuitRef = { current: false };
const explicitQuitRef = { current: false };
let appQuitPreparationInFlight: Promise<void> | null = null;
let hasPreparedAppQuit = false;
const windowWorkspaceMap = new Map<number, Set<string>>();
const windowTaskRealtimeHostIdMap = new Map<number, string>();
const windowUnreadCountMap = new Map<number, number>();
const windowHostProcessMap = new Map<number, ElectronUtilityProcess>();
const cuaPipFocusRouter = createCuaPipFocusRouter({
  send: (windowId, event) => {
    windowHostProcessMap.get(windowId)?.postMessage({
      type: HostMessageTypes.CuaPipFocusChanged,
      event,
    });
  },
});
const hostRunningTaskCountMap = new Map<ElectronUtilityProcess, number>();
const windowsCuaOperationIndicator = createWindowsCuaOperationIndicator({
  platform: process.platform,
  getLocale: () => currentApplicationLocale,
  logger,
});

// 常驻 cron scheduler 进程句柄；app ready 后拉起，退出前销毁。
let cronScheduler: CronSchedulerHandle | null = null;
// host → main 的定时任务派发结果，转交给 scheduler 结算。经模块变量转发以避免 spawn 顺序耦合。
function forwardCronRunResult(
  result: Parameters<CronSchedulerHandle["handleCronRunResult"]>[0],
): void {
  cronScheduler?.handleCronRunResult(result);
}
function forwardOffPeakRunResult(
  result: Parameters<CronSchedulerHandle["handleOffPeakRunResult"]>[0],
): void {
  cronScheduler?.handleOffPeakRunResult(result);
}
function wakeCronScheduler(automationId: string): void {
  cronScheduler?.wake(automationId);
}
function wakeOffPeakScheduler(offPeakTaskId?: string): void {
  // 复用同一条 scheduler-wake 通道（tick 同时覆盖 cron 与 off-peak 分支），仅日志标签区分。
  cronScheduler?.wake(`offpeak:${offPeakTaskId ?? "sync"}`);
}
// 选一个本地 host 执行派发：本期本地 workspace 由任一本地窗口 host 的 createTask 按 path 拉起/复用 agent。
function resolveCronDispatchHost(): ElectronUtilityProcess | null {
  const first = windowHostProcessMap.values().next();
  return first.done ? null : first.value;
}
const disposingHostProcessTimers = new WeakMap<
  ElectronUtilityProcess,
  ReturnType<typeof setTimeout>
>();
const webRemoteControlManagerRef = {
  current: null as ReturnType<typeof createWebRemoteControlManager> | null,
};
let updateStatusWindow: BrowserWindow | null = null;
const UPDATE_STATUS_WINDOW_WIDTH = 512;
const UPDATE_STATUS_WINDOW_COMPACT_HEIGHT = 205;
const UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT = 224;
const UPDATE_STATUS_WINDOW_READY_HEIGHT = UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT - 54;
const UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 10, y: 10 } as const;
const mainSettingService = createSettingService();
const webRemoteControlCredentialService = createCredentialService();
const appLaunchGate = createAppLaunchGate();
const appLaunchCoordinator = createAppLaunchCoordinator(appLaunchGate);
const appTelemetryCredentialService = createCredentialService();
async function resolveCurrentZCodeEndpointOrigin() {
  return resolveZCodeEndpointOrigin({
    env: ZCODE_ENV,
    envBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    overrideOrigin: (await mainSettingService.get()).zcodeEndpointOrigin,
  });
}
let desktopContextPromptRollout: ReturnType<typeof createDesktopContextPromptRollout> | undefined;
function resolveDesktopContextPromptEnabledForHost(): boolean {
  const rollout = desktopContextPromptRollout;
  if (!rollout) {
    return false;
  }
  // Host 创建时顺便触发过期刷新，但只读取当前快照；网络请求不能阻塞 Local/Remote Host。
  void rollout.refresh();
  return rollout.getSnapshot().enabled;
}

// 首个 Host 创建前的有界灰度裁决门。Host/Agent 的 presentation surface 在进程启动时
// 冻结（services/node.ts 顶层 const + CLI --surface），而灰度请求是旁路、不阻塞 Host。若首个
// Host fork 早于请求 resolve，成功结果（enabled:true）对已冻结的 Host/Agent 无可达生效路径。
// 这里给"成功结果"一条有界的生效路径：首 Host fork 前 await 一次裁决（≤2s），失败/超时仍按当前
// 快照继续（desktopContextPrompt fail-open）。first-only 永久
// latch——后续 Host fork await 已 resolve 的 promise（近乎 0ms），且各 resolve*ForHost()
// 同步读取已被刷新的 live 快照。
const DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000;
let firstHostSpawnDecisionPromise: Promise<void> | null = null;
function awaitFirstHostSpawnDecision(): Promise<void> {
  if (firstHostSpawnDecisionPromise) {
    return firstHostSpawnDecisionPromise;
  }
  firstHostSpawnDecisionPromise = (async () => {
    const rollout = desktopContextPromptRollout;
    if (!rollout) {
      return;
    }
    try {
      const decision = await rollout.awaitFirstDecision(
        DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS,
      );
      logger.info("[desktop-context-prompt] first host spawn decision resolved", {
        enabled: decision.enabled,
        configVersion: decision.configVersion,
      });
    } catch (error) {
      // awaitFirstDecision 永不 reject（refresh 内部已 catch + timeout 回退快照），此处仅兜底。
      logger.warn("[desktop-context-prompt] first host spawn decision failed, fail-open", {
        error,
      });
    }
  })();
  return firstHostSpawnDecisionPromise;
}
const appTelemetryCore = createTelemetryCore({
  loadUserId: createTelemetryUserIdLoader(appTelemetryCredentialService),
  loadAuthorization: createTelemetryAuthorizationLoader(appTelemetryCredentialService),
  loadMarketingParams: createTelemetryMarketingParamsLoader(appTelemetryCredentialService),
  resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  fetchImpl: createDesktopTelemetryFetch({
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
  }),
});
const appTelemetryRuntime = createAppTelemetryRuntime({
  telemetryCore: appTelemetryCore,
  appLaunchCoordinator,
});

const reportRemoteConversationTelemetry = createRemoteConversationTelemetryDispatcher(
  async (event) => {
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const context = appTelemetryRuntime.getLatestRendererContext() ?? {
      clientTimezone: locale.timeZone,
      clientLanguage: locale.locale,
      screenResolution: "",
    };
    await appTelemetryCore.reportEvent({ ...event, context });
  },
  appTelemetryCore.trackPendingReport,
);

function reportRemoteUsageEventForRenderer(rendererId: number, event: TelemetryEventPayload): void {
  const context =
    appTelemetryRuntime.getRendererContext(rendererId) ??
    appTelemetryRuntime.getLatestRendererContext();
  if (!context) {
    logger.warn("[remote-usage-telemetry] renderer context unavailable", {
      elementName: event.elementName,
      rendererId,
    });
    return;
  }
  // 最终失败由 TelemetryCore 统一记录一条脱敏告警；这里仅隔离远程连接主链路。
  void appTelemetryCore.reportEvent({ context, ...event }).catch(() => {});
}

function syncAppTelemetryInteractiveState(): void {
  appTelemetryRuntime.setInteractive(
    getApplicationWindowsExcludingCuaIndicator().some(
      (win) => !win.isDestroyed() && win.isVisible() && win.isFocused(),
    ),
  );
  // 登出/切号发生在 host 子进程，主进程无即时信号；窗口聚焦时兜底刷新 ARMS user.name
  void armsUserIdentitySync.refresh();
}

app.on("browser-window-focus", (_event, win) => {
  syncAppTelemetryInteractiveState();
  rebuildMenu();
  // 设置/更新等无 Host 的 ZCode 窗口也算前台：router 会先把旧 workspace Host 清成 null，
  // 再把无 Host 的新窗口事实静默丢弃，避免旧会话 PiP 继续显示。
  cuaPipFocusRouter.focusWindow(resolveCuaPipWindowKey(win));
});
app.on("browser-window-blur", (_event, win) => {
  syncAppTelemetryInteractiveState();
  cuaPipFocusRouter.blurWindow(resolveCuaPipWindowKey(win));
});
app.on("browser-window-created", (_event, win) => {
  const windowKey = resolveCuaPipWindowKey(win);
  win.once("closed", () => cuaPipFocusRouter.removeWindow(windowKey));
});

const remoteSessionManager = createRemoteWorkspaceSessionManager({
  logger,
  windowHostProcessMap,
  resolveRemoteAssetDirs: () =>
    resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
  resolveWslTarget: resolveCanonicalWslTarget,
  reportRemoteConnectionStateChanged: reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnect: reportRemoteDisconnectToArms,
  webRemoteControlManagerRef,
});

// 复用既有只读账号入口；HTTP 由 main 的 Node fetch 执行，不触发 host OAuth 登出。
const loadRemoteControlUserId = createTelemetryUserIdLoader(webRemoteControlCredentialService);
const loadRemoteControlAuthorization = createTelemetryAuthorizationLoader(
  webRemoteControlCredentialService,
);
const webRemoteControlSharedHostAttachments = createWebRemoteControlSharedHostAttachments({
  windowHostProcessMap,
  attachRemoteWorkspaceSessionHost: remoteSessionManager.attachRemoteWorkspaceSessionHost,
  logger,
});
const deviceMid = ensureDesktopDeviceMidSync();
// 帮助配置是公开读取，不能复用下面附带账号鉴权的灰度响应缓存。
const readHelpConfig = createDesktopHelpConfigReader({
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  getClientLanguage: () => currentApplicationLocale,
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
// 同一个 /api/v1/client/configs fetcher 供两个灰度 rollout 共用（请求参数与鉴权完全一致，
// 各自独立缓存/去重，服务端按 data.configs.<key> 区分功能）。
const electronClientConfigsFetcher = createElectronDesktopContextPromptConfigFetcher({
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  getClientLanguage: () => currentApplicationLocale,
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
desktopContextPromptRollout = createDesktopContextPromptRollout({
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
const rendererActionTraceRollout = createRendererActionTraceRollout({
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
const localTtftExporter = createLocalTtftExporter({
  env: { ...hostProcessLocalEnv, ...process.env },
  version: ZCODE_VERSION || app.getVersion(),
  logger,
});
ipcMain.on(PlatformChannels.ReportLocalTtftBatch, (_event, batch: unknown) =>
  localTtftExporter.enqueue(batch),
);
const rendererActionTraceBroker = createRendererActionTraceBroker({
  exporter: createRendererActionTraceExporter({
    ...hostProcessLocalEnv,
    ...process.env,
  }),
  logger,
});
let disposeRendererActionTraceIpc: (() => void) | undefined;
const armsUserIdentitySync = createArmsUserIdentitySync({
  deviceMid,
  setUser: (user) => armsRum.setConfig("user", user),
});
const webRemoteControlAppVersion = ZCODE_VERSION || app.getVersion();
const defaultZCodeEndpointUrls = buildZCodeEndpointUrls(DEFAULT_ZCODE_ENDPOINT_ORIGIN, {
  appVersion: webRemoteControlAppVersion,
});
const webRemoteControlRelayWsEnvOverride =
  process.env["ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL"]?.trim();
const webRemoteControlUrlEnvOverride = process.env["ZCODE_WEB_REMOTE_CONTROL_URL"]?.trim();

function extractOpenWorkspacePathFromDeepLinkUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return isWorkspaceOpenUrl(parsedUrl) ? extractWorkspaceOpenPath(parsedUrl) : null;
  } catch {
    return null;
  }
}

const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);
const startupProtocolUrl = extractDeepLinkUrlFromArgs(process.argv);
const startupDeepLinkWorkspacePath = startupOpenWorkspaceArgPath
  ? null
  : extractOpenWorkspacePathFromDeepLinkUrl(startupProtocolUrl ?? "");
const startupDeepLinkConsumptionGate = createStartupDeepLinkConsumptionGate(startupProtocolUrl);
let startupOpenWorkspaceRequest: ExplicitStartupWorkspaceRequest | null =
  startupOpenWorkspaceArgPath
    ? { path: startupOpenWorkspaceArgPath, source: "open-workspace-arg" }
    : startupDeepLinkWorkspacePath
      ? { path: startupDeepLinkWorkspacePath, source: "deep-link" }
      : null;

// 手机实时日志落盘目录：放在 logs/ 下，「导出日志」打包时自动带上。
function getMobileRealtimeLogDir(): string {
  return join(getAppConfigDir(), "logs", "mobile");
}
let mobileLogSink: MobileLogSink | undefined;
// 首次收到 mobile-log 时再创建：数据目录在启动后才最终确定，不能在模块加载时固化路径。
function getMobileLogSink(): MobileLogSink {
  mobileLogSink ??= createMobileLogSink({ rootDir: getMobileRealtimeLogDir(), logger });
  return mobileLogSink;
}

const webRemoteControlManager = createWebRemoteControlManager({
  mobileLogSink: { append: (target, events) => getMobileLogSink().append(target, events) },
  getEndpointUrls: async () => {
    const derived = buildZCodeEndpointUrls(await resolveCurrentZCodeEndpointOrigin(), {
      appVersion: webRemoteControlAppVersion,
    });
    return {
      ...derived,
      relayWsUrl: resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: derived.origin,
        overrideUrl: webRemoteControlRelayWsEnvOverride,
      }),
      remoteUrl: webRemoteControlUrlEnvOverride || derived.remoteUrl,
    };
  },
  relayWsUrl: resolveWebRemoteControlRelayWsUrl({
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    overrideUrl: webRemoteControlRelayWsEnvOverride,
  }),
  mobileRemoteControlUrl: webRemoteControlUrlEnvOverride || defaultZCodeEndpointUrls.remoteUrl,
  deviceMid,
  deviceName: hostname(),
  appVersion: webRemoteControlAppVersion,
  getLogin: async () => {
    const userId = await loadRemoteControlUserId();
    const authorization = await loadRemoteControlAuthorization(userId);
    return authorization ? { userId, jwt: authorization.slice("Bearer ".length) } : undefined;
  },
  deviceStorage: createWebRemoteControlDeviceStorage({
    deleteLegacyCredential: () =>
      webRemoteControlCredentialService.delete("web-remote-control:external-relay:pass_hash"),
    loadSettings: () => mainSettingService.get(),
    patchSettings: (patch) => mainSettingService.update(patch),
  }),
  startupRestoreStorageProvider: {
    load: async () => (await mainSettingService.get()).webRemoteControlLastEnabledContext,
    save: async (context) => {
      await mainSettingService.update({
        webRemoteControlLastEnabledContext: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          initialTaskId: context.initialTaskId,
        },
      });
    },
    clear: async () => {
      await mainSettingService.update({
        webRemoteControlLastEnabledContext: undefined,
      });
    },
  },
  featureGate: createWebRemoteControlFeatureGate(),
  logger,
  relayMessageLogger: webRemoteControlRelayLogger,
  platformHandlers: {
    isDockerAvailable: () => isDockerDaemonAvailable(),
    listWSLDistros: () => listAvailableWSLDistros(),
    listDockerContainers: () => listAvailableDockerContainers(),
    listSSHConfigAliases: () => listSSHConfigAliases(),
    createTempTextAttachment: (payload) => createTempTextAttachment(payload),
    loadMcpFromUserDirectory: (payload) => loadCliMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: async (payload) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[web-remote-control] MCP save failed", message);
        return { success: false, error: message };
      }
    },
    migrateLegacyCommonMcp: (payload) => migrateLegacyCommonMcp(payload),
  },
  reconnectWorkspace: reconnectWebRemoteControlWorkspaceInRenderer,
  runRendererAction: runWebRemoteControlActionInRenderer,
  prepareProjectWorkspace: async (windowId, project, requestId) => {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) throw new Error("项目导航窗口已关闭");
    return remoteSessionManager.prepareProjectWorkspace(win, project, requestId);
  },
  cancelProjectPreparation: (windowId, requestId) => {
    const win = BrowserWindow.fromId(windowId);
    if (win && !win.isDestroyed())
      remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow(
        win.webContents.id,
        "mobile-navigation-superseded",
        requestId,
      );
  },
  reportRendererTelemetryEvent: (event) => {
    void appTelemetryCore.reportEvent(event).catch(() => {});
  },
  reportRemoteUsageEvent: (windowId, event) => {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.webContents.isDestroyed()) {
      return;
    }
    reportRemoteUsageEventForRenderer(win.webContents.id, event);
  },
  onStatusChanged: (windowId, status) => {
    sendWebRemoteControlStatusChangedToWindow(BrowserWindow.fromId(windowId), status);
  },
  attachWorkspaceHost: webRemoteControlSharedHostAttachments.attachWorkspaceHost,
  setTerminalOwner: webRemoteControlSharedHostAttachments.setTerminalOwner,
  releaseWorkspaceHostAttachment: webRemoteControlSharedHostAttachments.releaseAttachment,
  disposeWorkspaceHostAttachmentsForWindow: (windowId) =>
    webRemoteControlSharedHostAttachments.disposeWindow(windowId),
  disposeWorkspaceHostAttachmentsForRemoteSession: (remoteSessionId) =>
    webRemoteControlSharedHostAttachments.disposeRemoteSession(remoteSessionId),
});
webRemoteControlManagerRef.current = webRemoteControlManager;
webRemoteControlManager.startNotifications();
broadcastHub.onMobilePushRun = (run) => webRemoteControlManager.observeNotificationRun(run);
// owner 必须在事件到达时同步确认；locale 由 MobilePushConnection 在确认后再异步读取。
broadcastHub.onMobilePushEvent = (event) =>
  webRemoteControlManager.sendNotification(event, () =>
    mainSettingService.get().then(
      (settings) => (settings.locale?.startsWith("zh") ? "zh-CN" : "en-US"),
      () => {
        logger.warn("[mobile-push] notification locale unavailable");
        throw new Error("locale_unavailable");
      },
    ),
  );
app
  .whenReady()
  .then(() => powerMonitor.on("resume", () => void webRemoteControlManager.refreshNotifications()));
app.on("will-quit", () => webRemoteControlManager.disposeNotifications());

let forceUpdateMainWindowCreationBlocked = false;

function resolveExternalWorkspaceConfirmationCopy() {
  const effectiveLocale =
    currentApplicationLocale === DEFAULT_LOCALE && app.isReady()
      ? resolveSystemApplicationLocale()
      : currentApplicationLocale;
  return resolveExternalWorkspaceOpenDialogCopy(effectiveLocale);
}

function focusForceUpdateGateWindow() {
  const gateWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (!gateWindow) {
    return;
  }

  if (gateWindow.isMinimized()) {
    gateWindow.restore();
  }
  if (!gateWindow.isVisible()) {
    gateWindow.show();
  }
  gateWindow.focus();
}

const primaryWindowCoordinator = createPrimaryWindowCoordinator({
  listWindows: getApplicationWindowsExcludingCuaIndicator,
  resolveStartupWindowBootstrap: () => {
    if (startupOpenWorkspaceRequest) {
      const request = startupOpenWorkspaceRequest;
      startupOpenWorkspaceRequest = null;
      startupDeepLinkConsumptionGate.markStartupRequestConsumed(request);
      const explicitBootstrap = resolveExplicitStartupWorkspaceBootstrap(request, {
        confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
        logger,
      });
      if (explicitBootstrap) {
        return Promise.resolve(explicitBootstrap);
      }
    }

    return resolveStartupWindowBootstrap({
      settingsFile,
      // dataBaseDir 可能在 bootstrap 设置阶段被覆盖，必须在真正解析启动工作区时再取值。
      conversationWorkspaceDir: getConversationWorkspaceDir(),
      logger,
    });
  },
  createWindow: (startupBootstrap) => {
    createWindowInstance(startupBootstrap);
  },
  canCreateWindow: (reason) => {
    if (!forceUpdateMainWindowCreationBlocked) {
      return true;
    }

    // 强制升级命中后，Dock/托盘/activate/deep link 不能绕过 app-ready gate 创建旧版主界面。
    logger.warn(`[force-update] 已阻止主窗口创建入口：${reason}`);
    focusForceUpdateGateWindow();
    return false;
  },
  logger,
});

function markForceQuit(reason: string) {
  if (forceQuitRef.current) {
    return;
  }

  forceQuitRef.current = true;
  logger.info(`[app-quit] forceQuit enabled (${reason})`);
}

function markExplicitQuit(reason: string) {
  explicitQuitRef.current = true;
  logger.info(`[app-quit] explicit quit requested (${reason})`);
}

function syncCloseToTrayOnWindows(value: unknown) {
  if (typeof value !== "boolean") {
    return;
  }

  closeToTrayOnWindows = value;
  logger.info(`[settings] closeToTrayOnWindows=${value}`);
}

function syncImmediateAppSettings(patch: ReturnType<typeof appSettingsPatchSchema.parse>) {
  syncCloseToTrayOnWindows(patch.closeToTrayOnWindows);

  if (typeof patch.keepAwakeWhileRunning === "boolean") {
    keepAwakeWhileRunning = patch.keepAwakeWhileRunning;
    reconcileKeepAwakeBlocker();
  }

  if (typeof patch.receivePreviewUpdates === "boolean") {
    // receivePreviewUpdates 由 renderer host 写入 setting.json。
    // main 进程的自动更新器不会订阅 host 设置变化，必须借 syncAppSettings 这条即时通道刷新 manifest channel。
    refreshAutoUpdaterReleaseChannel(
      patch.receivePreviewUpdates,
      "settings receivePreviewUpdates changed",
    );
  }

  if (patch.shortcutBindings !== undefined) {
    // 快捷键改绑：
    // 落盘已完成（useSettings.update 先 await settingService.update 再走本通道），
    // 这里重建应用菜单 accelerator，并通知所有窗口刷新设置快照 —— 其他窗口的
    // useAppKeyboard 生效表与设置页跟随更新。先例：setAutoDownloadAndInstallUpdates 的全窗口广播。
    rebuildMenu();
    for (const win of getApplicationWindowsExcludingCuaIndicator()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.SettingsChanged);
      }
    }
  }
}

async function getAutoUpdatePreferences() {
  const settings = await mainSettingService.get();
  return {
    autoDownloadAndInstallUpdates: settings.autoDownloadAndInstallUpdates ?? false,
  };
}

async function setAutoDownloadAndInstallUpdates(enabled: boolean) {
  await mainSettingService.update({
    autoDownloadAndInstallUpdates: enabled,
  });
  syncImmediateAppSettings({
    autoDownloadAndInstallUpdates: enabled,
  });
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.SettingsChanged);
    }
  }
}

async function prepareAppQuit(reason: string, kind: AppShutdownKind = "normal"): Promise<void> {
  const selection = selectAppShutdownPolicy(activeAppShutdownKind, kind, process.platform);
  activeAppShutdownKind = selection.kind;
  activeAppShutdownPolicy = selection.policy;
  if (selection.upgraded && (hasPreparedAppQuit || appQuitPreparationInFlight)) {
    // 更新请求可能晚于普通退出屏障。已创建的 4s timer 无法靠修改全局策略延长；
    // 明确保留既有预算，并允许更新继续进入 fail-open 资源扫描和安装器。
    logger.warn(
      `[app-quit] update install joined an existing normal shutdown barrier (${reason}); existing timers keep their original budget`,
    );
  }
  if (hasPreparedAppQuit) {
    return;
  }
  if (appQuitPreparationInFlight) {
    await appQuitPreparationInFlight;
    return;
  }

  markForceQuit(reason);
  windowsCuaOperationIndicator.dispose();
  browserScreenshotSurfaceCoordinator.dispose();
  // Bug 根因：资源样本改为 5 分钟窗口后，退出仍直接 stop 会清空未满窗口的数据。
  // 退出时只排空已存在的角色 / Agent 内存窗口，不启动新采样、目录扫描或外部探针。
  stopDesktopResourceTelemetry({ flushPendingWindows: true });
  stopDesktopZCodeDataSizeTelemetry();
  stopDesktopNetworkTelemetry();
  stopRemoteUsageArmsPeriodicSampling();
  disposeRendererActionTraceIpc?.();
  disposeRendererActionTraceIpc = undefined;
  notifyStabilityAppExit(
    getStabilityLifecycleScene() === "update_install" ? "update_install" : "app_quit",
    logger,
    { exitCode: 0, exitKind: "normal" },
  );

  const cronSchedulerToDispose = cronScheduler;
  cronScheduler = null;

  const hostProcesses = [
    ...new Set([...windowHostProcessMap.values(), ...listDisposingHostProcesses()]),
  ];
  logger.info(
    `[app-quit] waiting for host process cleanup (${reason}), kind=${activeAppShutdownKind}, hosts=${hostProcesses.length}, forceKillDelayMs=${activeAppShutdownPolicy.forceKillDelayMs}, waitTimeoutMs=${activeAppShutdownPolicy.waitTimeoutMs}`,
  );

  appQuitPreparationInFlight = Promise.all([
    // 退出屏障结束后再启动窗口尺寸写入，可能在 app.exit 前留下 setting.json.lock。
    // 尺寸已在 resize 防抖或最大化状态变化时保存，退出屏障不再创建新的尺寸写入。
    // 修复原因：Main 过去不会等待仍在发送的 /event/report，正常退出也会直接丢事件。
    // 与其它 owner 并行进入既有屏障，最多等待 2 秒，避免 telemetry 串行放大退出预算。
    appTelemetryCore.flushPendingReports({ timeoutMs: 2_000 }),
    localTtftExporter.shutdown(),
    flushLocalTtftLogs(),
    rendererActionTraceBroker.shutdown().catch((error) => {
      logger.warn(`[app-quit] renderer action trace shutdown failed (${reason}):`, error);
    }),
    // 旧流程先等待 Cron 的 1.5s deadline，再启动 Host timer，导致声明的
    // 4.5s/9s 退出总预算被串行放大。两类 owner 无关闭依赖，统一并行进入同一屏障。
    (async () => {
      try {
        await cronSchedulerToDispose?.dispose();
      } catch (error) {
        logger.warn(`[app-quit] cron scheduler dispose failed (${reason}):`, error);
      }
    })(),
    // remote session、attachment 和 transport 都由窗口 Host 持有；这里先清理
    // Main 的请求关联，再由下方每窗口唯一 Host 的 shutdown barrier 释放真实连接与 Agent。
    remoteSessionManager.disposeAllAndWaitForAppShutdown(reason),
    ...hostProcesses.map((child, index) =>
      disposeHostProcessAndWait(
        child,
        `${reason}-${index + 1}`,
        disposingHostProcessTimers,
        logger,
        {
          forceKillDelayMs: activeAppShutdownPolicy.forceKillDelayMs,
          waitTimeoutMs: activeAppShutdownPolicy.waitTimeoutMs,
        },
      ),
    ),
  ])
    .then(() => {
      logger.info(`[app-quit] host process cleanup completed (${reason})`);
    })
    .catch((error) => {
      logger.error(`[app-quit] host process cleanup failed (${reason}):`, error);
    })
    .finally(() => {
      // before-quit 是同步事件。只发 Dispose 就继续退出 main 的话，
      // host 还没等到 agent 进程树的 SIGTERM/SIGKILL 兜底完成就被带走，zcode-cli 会被 init 接管成残留进程。
      // 这里先拦截第一次退出，等待 host 清理完成后再放行第二次 app.quit。
      hasPreparedAppQuit = true;
      appQuitPreparationInFlight = null;
    });

  await appQuitPreparationInFlight;
}

function exitPreparedApp(reason: string): never | void {
  logger.info(`[app-quit] exiting prepared app (${reason})`);
  if (process.env.ZCODE_E2E_RUN_ID?.trim()) {
    flushMainE2ECoverage((error) => {
      logger.warn("[e2e-coverage] main coverage flush failed", error);
    });
    // ChromeDriver 正在执行 deleteSession 时，Electron app.exit(0)
    // 和进程内的 process.kill 都可能被 Electron 生命周期吞掉。这里只在 E2E
    // run 身份明确、且 prepareAppQuit 已完成 host/agent 回收之后，启动独立系统
    // 命令终止当前 PID；不按名称扫描，也不会影响产品退出或下一轮 session。
    const killer =
      process.platform === "win32"
        ? spawn("taskkill", ["/PID", String(process.pid), "/F"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("kill", ["-9", String(process.pid)], {
            detached: true,
            stdio: "ignore",
          });
    killer.unref();
    return;
  }
  app.exit(0);
}

function getRunningAgentSessionCount() {
  return [...hostRunningTaskCountMap.values()].reduce((total, count) => total + count, 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(ms, 0));
    timer.unref?.();
  });
}

async function execWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
  spawnOptions: { windowsHide?: boolean; encoding?: BufferEncoding } = {},
): Promise<{
  timedOut: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = execFile(file, args, {
      windowsHide: spawnOptions.windowsHide,
      encoding: spawnOptions.encoding,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // 进程可能已自行退出，忽略
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, signal });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, error: error.message });
    });
  });
}

async function forceTerminateWindowsAgentProcesses(pids: number[]): Promise<
  Array<{
    pid: number;
    timedOut: boolean;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
  }>
> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  return Promise.all(
    uniquePids.map((pid) =>
      execWithTimeout(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS,
        {
          windowsHide: true,
        },
      ).then((result) => ({ pid, ...result })),
    ),
  );
}

function logWindowsPackagedResourceSnapshot(stage: string) {
  logger.info(
    `[auto-update] Windows packaged resources snapshot (${stage}): ${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

function logWindowsPackagedResourceWritableProbe(stage: string) {
  const probes = probeWindowsPackagedResourceWritable(process.resourcesPath);
  const failed = probes.filter((probe) => probe.exists && !probe.writable);
  logger.info(
    `[auto-update] Windows packaged resources writable probe (${stage}): ${JSON.stringify(probes)}`,
  );
  if (failed.length > 0) {
    logger.warn(
      `[auto-update] Windows packaged resource dirs are not writable (${stage}): ${JSON.stringify(
        failed,
      )}`,
    );
  }
}

function logWindowsBundledRuntimeIntegrityDiagnostic() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return;
  }

  const binaryPaths = {
    glm: resolveBundledGlmBinaryPath(),
  };
  const missingProviders = Object.entries(binaryPaths)
    .filter(([, binaryPath]) => !binaryPath)
    .map(([provider]) => provider);
  if (missingProviders.length === 0) {
    return;
  }

  // bundled runtime 缺失不一定影响用户当前 provider，启动阶段只静默落日志。
  // 这样既能在下次用户日志里确认安装资源是否已损坏，也不会因为未使用的 provider 缺失打断启动。
  logger.warn(
    `[startup] Windows bundled runtime missing providers: ${missingProviders.join(", ")} resources=${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

async function prepareWindowsProcessesForUpdateInstall() {
  const trackedAgentCount = listRegisteredHostAgentProcessIds().length;

  logger.info(`[auto-update] preparing Windows update install: trackedAgent=${trackedAgentCount}`);
  logWindowsPackagedResourceSnapshot("before-dispose");

  const resourceLockMarkers = resolveWindowsPackagedResourceLockMarkers(process.resourcesPath);
  // prepareAppQuit 已经用同一屏障回收每窗口唯一 Host，并在 7.5 秒强杀、
  // 9 秒收口；Windows 专项阶段不能再追加一轮等待，也不能用退出前记录的 Host/Agent PID
  // 强杀，因为 PID 可能已经复用。这里只清理实时扫描仍引用随包资源的 runtime 进程，
  // 当前 main/renderer 的最终退出交给 updater 与 NSIS。
  const cleanup = await runWindowsUpdateProcessCleanup({
    resourceLockMarkers,
    lockReleaseGraceMs: WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
    scan: findWindowsProcessesReferencingResourceMarkers,
    terminate: forceTerminateWindowsAgentProcesses,
    delay,
  });

  logger.info(
    `[auto-update] Windows resource lock scan: matches=${cleanup.initialLockProcesses.length} trackedAgent=${trackedAgentCount} details=${JSON.stringify(
      cleanup.initialLockProcesses,
    )}`,
  );
  for (const error of cleanup.errors) {
    logger.warn(`[auto-update] Windows process cleanup degraded: ${error}`);
  }

  if (cleanup.terminationPids.length === 0) {
    logWindowsPackagedResourceWritableProbe("no-lock-processes");
    return;
  }

  // 少量 Windows 用户更新后安装目录里的 bundled agent 文件会缺失。
  // 根因通常是 NSIS 覆盖 resources/glm 等目录时，旧 agent/helper 进程或杀软触发的残留进程仍持有句柄；
  // 只杀 host 上报过的 agent pid 会漏掉未登记或已经脱离登记的后代。这里在更新前按命令行再扫描一次安装资源路径，
  // 对仍引用随包资源的进程树做强制清理，降低半更新导致环境损坏的概率。
  logger.info(
    `[auto-update] Windows taskkill results: ${JSON.stringify(cleanup.terminationResults)}`,
  );
  logger.info(
    `[auto-update] Windows resource lock release grace elapsed: ${WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS}ms`,
  );

  if (cleanup.remainingLockProcesses.length > 0) {
    logger.warn(
      `[auto-update] Windows resource lock processes still alive after taskkill: ${JSON.stringify(
        cleanup.remainingLockProcesses,
      )}`,
    );
  }
  logWindowsPackagedResourceWritableProbe("after-taskkill");
}

function shouldConfirmAppQuit() {
  // 开发环境里的普通会话经常需要重启 Electron，只在 production 下拦截，避免打断调试。
  return ZCODE_ENV === "production" && getRunningAgentSessionCount() > 0;
}

function confirmAppQuit(originWindow?: BrowserWindow | null) {
  if (!shouldConfirmAppQuit()) {
    logger.info(`[app-quit] quit confirmation skipped in ${ZCODE_ENV}`);
    return true;
  }

  const isZh = currentApplicationLocale === "zh-CN";
  const runningAgentSessionCount = getRunningAgentSessionCount();
  const detailLines = [
    runningAgentSessionCount > 0
      ? isZh
        ? `正在进行的会话：${runningAgentSessionCount} 个，退出后会被中断。`
        : `In-progress sessions: ${runningAgentSessionCount}. They will be interrupted after quitting.`
      : null,
  ].filter((line): line is string => line !== null);
  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        getApplicationWindowsExcludingCuaIndicator()[0] ??
        null);
  const dialogOptions = {
    type: "question" as const,
    buttons: isZh ? ["退出", "取消"] : ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: isZh ? "退出确认" : "Confirm Quit",
    message: isZh ? "确认退出 Z Code?" : "Quit Z Code?",
    detail: detailLines.join("\n"),
    icon: nativeImage.createFromPath(iconPath),
  };

  const result = targetWindow
    ? dialog.showMessageBoxSync(targetWindow, dialogOptions)
    : dialog.showMessageBoxSync(dialogOptions);
  return result === 0;
}

async function executeDesktopCommandForApp(
  command: Parameters<typeof executeDesktopCommand>[0]["command"],
  senderWindow?: BrowserWindow | null,
) {
  return executeDesktopCommand({
    fetchHelpConfig: readHelpConfig,
    command,
    senderWindow,
    logger,
    updateZCodeStdioTapDevMenuState,
    onDesktopZoomChanged: (zoomLevel) => {
      currentDesktopZoomLevel = clampDesktopZoomLevel(zoomLevel);
      rebuildMenu();
    },
    settingService: mainSettingService,
    onZCodeEndpointChanged: handleZCodeEndpointChanged,
    zcodeEndpointEnvBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    onRelaunchApp: async () => {
      await prepareAppQuit("desktop-command-relaunch");
      app.relaunch();
      app.quit();
    },
    credentialsDir: getCredentialsDir(),
    currentApplicationLocale,
    pullMobileLogs: (windowId) =>
      pullAndExportMobileLogs(windowId, {
        findTarget: (id) => webRemoteControlManager.findMobileLogPullTarget(id),
        pull: (id, query, onShard) => webRemoteControlManager.pullMobileLogs(id, query, onShard),
        exportDir: getExportLogDir(),
        realtimeLogDir: getMobileRealtimeLogDir(),
        locale: currentApplicationLocale,
        showMessage: async (options) => {
          const parent = senderWindow && !senderWindow.isDestroyed() ? senderWindow : undefined;
          const result = parent
            ? await dialog.showMessageBox(parent, options)
            : await dialog.showMessageBox(options);
          return result.response;
        },
        showItemInFolder: (path) => shell.showItemInFolder(path),
        logger,
      }),
  });
}

async function resolveZCodeEndpointSelection(): Promise<"production" | "test" | "custom"> {
  if (ZCODE_ENV === "production") {
    return "production";
  }
  const origin = await resolveCurrentZCodeEndpointOrigin();
  if (origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    return "production";
  }
  if (origin === TEST_ZCODE_ENDPOINT_ORIGIN) {
    return "test";
  }
  return "custom";
}

async function handleZCodeEndpointChanged() {
  rebuildMenu();
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    await webRemoteControlManagerRef.current?.suspend(win.id, "endpoint-changed");
  }
}

/** 快捷键设置页录制态（renderer 经 SetShortcutRecordingActive 同步）；true 时菜单摘除可配置 accelerator。 */
let shortcutRecordingActive = false;
/** 发起录制的 webContents id；窗口关闭/崩溃时 renderer 不会发复位 IPC，main 侧据此收口。 */
let shortcutRecordingOwnerWebContentsId: number | null = null;

function setShortcutRecordingActive(active: boolean, ownerWebContentsId: number | null = null) {
  if (active) {
    shortcutRecordingOwnerWebContentsId = ownerWebContentsId;
  }
  if (shortcutRecordingActive === active) {
    return;
  }
  shortcutRecordingActive = active;
  if (!active) {
    shortcutRecordingOwnerWebContentsId = null;
  }
  rebuildMenu();
}

/**
 * 录制态是跨进程的临时全局状态，收口不能依赖 renderer 合作——录制中关窗
 * 或渲染进程崩溃时 React cleanup 与复位 IPC 都不会执行，标志会永久为 true，之后所有
 * rebuildMenu（切语言/zoom/设置同步）都建出无 accelerator 的菜单且波及全部窗口。
 * 在既有窗口销毁清理里按发起 webContents 复位。
 */
function resetShortcutRecordingForWebContents(webContentsId: number) {
  if (!shortcutRecordingActive || shortcutRecordingOwnerWebContentsId !== webContentsId) {
    return;
  }
  shortcutRecordingOwnerWebContentsId = null;
  shortcutRecordingActive = false;
  rebuildMenu();
}

function rebuildMenu() {
  void Promise.all([resolveZCodeEndpointSelection(), mainSettingService.get()]).then(
    ([zcodeEndpointSelection, settings]) => {
      rebuildApplicationMenu({
        currentApplicationLocale,
        zcodeEndpointSelection,
        executeDesktopCommand: executeDesktopCommandForApp,
        currentZoomLevel: resolveFocusedDesktopZoomLevel(),
        // 菜单 accelerator 跟随用户快捷键设置（shortcutBindings 用户覆盖）
        shortcutBindings: settings.shortcutBindings,
        // 快捷键录制态：摘掉可配置 accelerator，防止录制 menu 通道命令时按键直接触发原命令
        // （macOS 系统菜单先于 renderer 吃掉按键，renderer 侧 preventDefault 拦不住）。
        disableShortcutAccelerators: shortcutRecordingActive,
      });
    },
  );
  updateWindowsDesktopTrayMenu();
}

function resolveFocusedDesktopZoomLevel(): number {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    return 0;
  }
  return resolveDesktopZoomLevelFromFactor(focusedWindow.webContents.getZoomFactor());
}

function getApplicationWindowsExcludingCuaIndicator(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !windowsCuaOperationIndicator.ownsWindow(win),
  );
}

function getMainApplicationWindows(): BrowserWindow[] {
  return getApplicationWindowsExcludingCuaIndicator().filter((win) => win !== updateStatusWindow);
}

function isUpdateStatusWindowCloseLocked(state: UpdateStatePayload) {
  return state.kind === "download-progress" || state.kind === "update-downloaded";
}

function syncUpdateStatusWindowClosePolicy(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }
  const closeLocked = isUpdateStatusWindowCloseLocked(getAutoUpdaterState());
  win.setClosable(!closeLocked || forceQuitRef.current);
  win.setMinimizable(true);
}

function syncUpdateStatusWindowChrome(win: BrowserWindow) {
  if (win.isDestroyed() || process.platform !== "darwin") {
    return;
  }
  // 独立更新窗口的红绿灯位置不能只依赖 BrowserWindow 构造参数。
  // macOS 在窗口 show / resize 后可能继续沿用 hidden titlebar 的默认坐标，
  // 因此每次同步布局时都显式写入更靠上的按钮位置。
  win.setWindowButtonPosition(UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION);
}

function resolveUpdateStatusWindowHeight(state: UpdateStatePayload) {
  if (state.kind === "download-progress") {
    return UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT;
  }
  if (state.kind === "update-downloaded") {
    return UPDATE_STATUS_WINDOW_READY_HEIGHT;
  }
  return UPDATE_STATUS_WINDOW_COMPACT_HEIGHT;
}

function shouldUseUpdateStatusWindowContentSize(): boolean {
  return process.platform === "linux";
}

function syncUpdateStatusWindowLayout(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }
  const state = getAutoUpdaterState();
  const height = resolveUpdateStatusWindowHeight(state);
  const bounds = shouldUseUpdateStatusWindowContentSize()
    ? win.getContentBounds()
    : win.getBounds();
  if (!shouldUseUpdateStatusWindowContentSize()) {
    win.setMinimumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    win.setMaximumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
  }
  if (bounds.width !== UPDATE_STATUS_WINDOW_WIDTH || bounds.height !== height) {
    // 独立更新窗口复用页内 Dialog 的 240px 高度后，普通状态只有两行内容，
    // footer 会吃掉剩余网格行形成大块空白；按状态收紧窗口高度，让内容贴合实际密度。
    // 取消下载会从 download-progress 回到 update-available；这里同步 min/max 再 setSize，
    // 避免 macOS 在非 resizable BrowserWindow 上沿用下载态高度，导致弹窗没有收回。
    if (shouldUseUpdateStatusWindowContentSize()) {
      // Linux 的系统标题栏会占用 BrowserWindow 外框高度。
      // 如果继续用 setSize 锁外框，WebContents 实际高度会少一截，底部按钮被裁掉。
      win.setContentSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    } else {
      win.setSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    }
  }
  syncUpdateStatusWindowChrome(win);
}

function openUpdateStatusWindow() {
  if (updateStatusWindow && !updateStatusWindow.isDestroyed()) {
    if (updateStatusWindow.isMinimized()) {
      updateStatusWindow.restore();
    }
    updateStatusWindow.show();
    updateStatusWindow.focus();
    syncAutoUpdaterStateToWindow(updateStatusWindow);
    syncReadyUpdateToWindow(updateStatusWindow);
    syncPostUpdateReleaseNotesToWindow(updateStatusWindow);
    syncUpdateStatusWindowClosePolicy(updateStatusWindow);
    syncUpdateStatusWindowLayout(updateStatusWindow);
    return;
  }

  const parentWindow =
    getMainApplicationWindows().find((candidate) => candidate.isFocused()) ??
    getMainApplicationWindows()[0] ??
    undefined;
  const win = new BrowserWindow({
    width: UPDATE_STATUS_WINDOW_WIDTH,
    height: resolveUpdateStatusWindowHeight(getAutoUpdaterState()),
    useContentSize: shouldUseUpdateStatusWindowContentSize(),
    ...(shouldUseUpdateStatusWindowContentSize()
      ? {}
      : {
          minWidth: UPDATE_STATUS_WINDOW_WIDTH,
          minHeight: UPDATE_STATUS_WINDOW_READY_HEIGHT,
          maxWidth: UPDATE_STATUS_WINDOW_WIDTH,
          maxHeight: UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT,
        }),
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    // 更新状态已经从页内 Dialog 改成独立 BrowserWindow。
    // 独立窗口应保留系统窗口控件，不能沿用页内弹窗时期的无边框透明窗口配置。
    frame: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION,
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: true,
          }
        : {}),
    transparent: false,
    backgroundColor: "#ffffff",
    title: "",
    icon: iconPath,
    parent: parentWindow,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--device-id=${deviceMid}`],
    },
  });
  // 更新窗口要保留系统窗口控件，但不能允许缩放或全屏。
  // 构造参数之外再显式锁定一次，避免不同平台对标题栏控件能力的默认处理不一致。
  win.setResizable(false);
  win.setMinimizable(true);
  win.setMaximizable(false);
  win.setFullScreenable(false);
  if (process.platform === "darwin") {
    syncUpdateStatusWindowChrome(win);
  }
  syncUpdateStatusWindowClosePolicy(win);
  syncUpdateStatusWindowLayout(win);

  updateStatusWindow = win;
  const disposeAutoUpdaterStateListener = onAutoUpdaterStateChanged(() => {
    syncUpdateStatusWindowClosePolicy(win);
    syncUpdateStatusWindowLayout(win);
  });
  const showUpdateStatusWindow = () => {
    if (win.isDestroyed()) {
      return;
    }
    if (!win.isVisible()) {
      win.center();
      syncUpdateStatusWindowChrome(win);
      win.show();
      syncUpdateStatusWindowChrome(win);
    }
    win.moveTop();
    win.focus();
    win.setAlwaysOnTop(true, "floating");
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setAlwaysOnTop(false);
      }
    }, 250);
    logger.info(
      `[auto-update] update status window shown visible=${win.isVisible()} focused=${win.isFocused()} bounds=${JSON.stringify(win.getBounds())}`,
    );
  };
  win.webContents.on("dom-ready", () => {
    logger.info("[auto-update] update status window dom-ready");
    syncAutoUpdaterStateToWindow(win);
    syncReadyUpdateToWindow(win);
    syncPostUpdateReleaseNotesToWindow(win);
    // 更新窗口在开发态或部分 macOS 渲染路径下不一定稳定触发 ready-to-show。
    // 加载完成后也尝试显示，避免窗口已加载却保持隐藏，让更新入口看起来无响应。
    setTimeout(showUpdateStatusWindow, 0);
  });
  win.once("ready-to-show", () => {
    showUpdateStatusWindow();
  });
  win.on("close", (event) => {
    if (forceQuitRef.current || !isUpdateStatusWindowCloseLocked(getAutoUpdaterState())) {
      return;
    }
    // 下载开始后更新窗口承担安装状态反馈，用户仍可最小化，但不能误关闭窗口。
    // close 事件兜底拦截 native close / 快捷键路径，setClosable(false) 只负责系统控件状态。
    event.preventDefault();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    disposeAutoUpdaterStateListener();
    if (updateStatusWindow === win) {
      updateStatusWindow = null;
    }
  });

  loadWindow(win, "index", {
    restoreSession: false,
    supportsSettings: false,
    windowKind: "update-status",
    locale: currentApplicationLocale,
  });
}

function createWindowInstance(startupBootstrap: StartupWindowBootstrap = {}) {
  const runtimeProcessEnvPreparation = takeRuntimeProcessEnvPreparation();
  const win = createWindow({
    iconPath,
    preloadPath,
    logger,
    forceQuitRef,
    handleBeforeClose: (win, label) =>
      handleDesktopWindowCloseRequest({
        platform: process.platform,
        forceQuit: forceQuitRef.current,
        explicitQuitRequested: explicitQuitRef.current,
        closeToTray: closeToTrayOnWindows,
        // 空缓存按不可用处理：隐藏前兜底确认托盘真的可渲染，防 GNOME 静默失败失联。
        // CR-01：DBus 探测 ∧ Tray 实例创建成功才可隐藏；任一不满足按不可用走确认退出。
        closeToTraySupported: resolveCloseToTraySupported({
          platform: process.platform,
          desktopTrayReady,
          capabilitySupported: closeToTrayCapabilityMonitor.getSync()?.supported,
        }),
        isLastWindow: getMainApplicationWindows().length === 1,
        label,
        logger,
        shouldConfirmQuit: shouldConfirmAppQuit(),
        confirmQuit: () => confirmAppQuit(win),
        requestQuit: () => {
          markForceQuit(`last-window-close:${label}`);
          app.quit();
        },
        hideWindow: () => win.hide(),
      }),
    windowHostProcessMap,
    onHostProcessReady: (windowKey) => cuaPipFocusRouter.refreshWindow(windowKey),
    awaitFirstHostSpawnDecision,
    spawnHostProcess: (win, label, initMessage) =>
      spawnHostProcess(
        win,
        label,
        {
          ...initMessage,
          browserBackendIdentity: browserGuestManager.getBackendIdentity(win.id),
          zcodeBuiltinProviderConfigFilePath: resolveZCodeBuiltinProviderConfigFilePath(),
        },
        {
          hostProcessLocalEnv,
          desktopContextPromptEnabled: resolveDesktopContextPromptEnabledForHost,
          logger,
          broadcastHub,
          taskRealtimeBus,
          windowHostProcessMap,
          hostRunningTaskCountMap,
          onCuaOperationStateChanged: (source, event) =>
            windowsCuaOperationIndicator.handleState(source, event),
          onCuaOperationStateSourceExited: (source) =>
            windowsCuaOperationIndicator.clearSource(source),
          onAgentProcessExited: (event) => reportAgentProcessExitToArms(event, logger),
          onAgentProcessError: (event) => reportAgentProcessSpawnErrorToArms(event, logger),
          onAgentProcessException: (event) => reportAgentProcessExceptionToArms(event, logger),
          onAgentProcessReady: (event) => reportAgentProcessReadyToArms(event, logger),
          onAgentProcessSpawned: (event) => reportAgentProcessStartToArms(event, logger),
          onMcpTelemetry: (message) =>
            reportMcpTelemetryToArms(message.event, message.runtimeSurface),
          onPluginTelemetry: (message) => {
            void appTelemetryCore.reportEvent(message.event).catch(() => {});
          },
          onRemoteConversationTelemetry: (message) => {
            void reportRemoteConversationTelemetry(message.event);
          },
          onSessionCreateTelemetry: (message) => {
            void appTelemetryCore.reportEvent(message.event).catch(() => {});
          },
          onCronRunResult: forwardCronRunResult,
          onOffPeakRunResult: forwardOffPeakRunResult,
          onCronSchedulerWakeRequested: wakeCronScheduler,
          onOffPeakSchedulerWakeRequested: wakeOffPeakScheduler,
          authorizeLocalMediaPreviewPath: localMediaPreviewPathRegistry.authorize,
          registerPluginSandbox: (input) => {
            const host = getPluginSandboxHost();
            if (!host) throw new Error("Plugin UI sandbox host is not installed.");
            const { requestId: _requestId, ...registerInput } = input;
            return host.registerFromHost(registerInput);
          },
          // browser-use：main 用 WebContentsView+CDP 执行命令（替换 T4 占位）。
          handleBrowserExecuteRequest: ({ win: browserWin, ...request }) =>
            runBrowserCommandOnView({ win: browserWin, ...request }),
          // 数据同步页「模型提供商」分类：最近结果与重试都以 Main 协调器的 lane 为唯一数据源。
          providerProvisioningLanes: {
            getStatus: (sourceServerId, laneOptions) =>
              remoteSessionManager.getProviderProvisioningLaneStatus(sourceServerId, laneOptions),
            retry: (sourceServerId) =>
              remoteSessionManager.retryProviderProvisioning(sourceServerId),
          },
        },
        {
          taskRealtime: {
            workspaceKeys: windowWorkspaceMap.get(win.id) ?? [],
            onHostId: (hostId) => {
              windowTaskRealtimeHostIdMap.set(win.id, hostId);
            },
          },
        },
      ),
    disposeHostProcess: (child, label, forceKillDelayMs) =>
      disposeHostProcess(
        child,
        label,
        disposingHostProcessTimers,
        logger,
        label.includes("window-closed")
          ? activeAppShutdownPolicy.forceKillDelayMs
          : forceKillDelayMs,
      ),
    syncAutoUpdaterStateToWindow,
    syncReadyUpdateToWindow,
    syncPostUpdateReleaseNotesToWindow,
    webRemoteControlManager,
    disposeRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.disposeRemoteWorkspaceSessionsForWindow,
    reattachRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.reattachRemoteWorkspaceSessionsForWindow,
    bootstrap: {
      restoreSession: startupBootstrap.restoreSession,
      initialWorkspacePath: startupBootstrap.initialWorkspacePath,
      initialWorkspacePurpose: startupBootstrap.initialWorkspacePurpose,
      unavailableWorkspacePath: startupBootstrap.unavailableWorkspacePath,
    },
    agentWarmupTargets: startupBootstrap.agentWarmupTargets,
    // startupBootstrap 只标记 active workspace 是否不可用，但 local Host 会为所有
    // 已恢复 workspace 建立后台索引。始终注入 canonical fallback，才能覆盖非 active 历史目录已删除的情况。
    agentSpawnFallbackCwd: getConversationWorkspaceDir(),
    deviceMid,
    remoteAssets: resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
    runtimeProcessEnvPatchPromise: runtimeProcessEnvPreparation.patchPromise,
    runtimeProcessEnvFallbackPatch: runtimeProcessEnvPreparation.fallbackPatch,
    initialDesktopZoomLevel: currentDesktopZoomLevel,
    initialWindowSize: currentDesktopWindowSize,
    currentApplicationLocale: () => currentApplicationLocale,
    resolveBrowserViewOwner: (webContentsId) =>
      browserGuestManager.getTabOwnerByWebContentsId(webContentsId) ?? undefined,
    persistWindowSize: async (state) => {
      currentDesktopWindowSize = state;
      await mainSettingService.update({ desktopWindowSize: state });
    },
  });
  registerStabilityMainWindow(win);
  return win;
}

registerDeepLinkProtocol(logger, { iconPath: linuxDesktopIntegrationIconPath });
app.on("open-url", (event, url) => {
  event.preventDefault();
  const workspacePath = extractOpenWorkspacePathFromDeepLinkUrl(url);
  if (workspacePath && forceUpdateMainWindowCreationBlocked) {
    logger.warn("[force-update] 已忽略强制升级期间的 open-url workspace 请求");
    focusForceUpdateGateWindow();
    return;
  }
  if (workspacePath && getApplicationWindowsExcludingCuaIndicator().length === 0) {
    // macOS 冷启动 Finder Service 会先触发 open-url，再创建首窗。
    // 把目标目录按 deep link 来源记录，首窗 bootstrap 前仍要走确认 gate。
    startupOpenWorkspaceRequest = { path: workspacePath, source: "deep-link" };
    if (app.isReady()) {
      void primaryWindowCoordinator.ensurePrimaryWindow("open-url-workspace");
    }
    return;
  }
  handleDeepLink(url, logger, {
    confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
    resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
  });
});
const gotTheLock = app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv));
if (!gotTheLock) {
  app.quit();
}
app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
  if (
    handleSecondInstanceWorkspaceRequest({
      additionalData,
      argv,
      focusForceUpdateGateWindow,
      forceUpdateBlocked: forceUpdateMainWindowCreationBlocked,
      handleDeepLink: (url, options) => handleDeepLink(url, logger, options),
      handleOpenWorkspacePath: (path, options) =>
        handleOpenWorkspacePath(path, logger, {
          allowWithoutReadyWindow: true,
          ...options,
          resolveApplicationWindow:
            options?.resolveApplicationWindow ??
            (() => getApplicationWindowsExcludingCuaIndicator()[0] ?? null),
        }),
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
      logger,
      workspaceConfirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
    })
  ) {
    return;
  }

  const win = getApplicationWindowsExcludingCuaIndicator()[0];
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }
});

app.whenReady().then(async () => {
  markMainLaunchAppReady();
  installRequestSecurityDiagnostics(session.defaultSession.webRequest, logger);
  installLocalMediaPreviewProtocol(session.defaultSession.protocol, {
    isPathAuthorized: localMediaPreviewPathRegistry.isAuthorized,
  });
  // 插件 UI 沙箱：注册表 + renderer 可调 IPC；scheme 的 privileged 注册已随 zcode-media 在 ready 前完成。
  installPluginSandboxHost({
    preloadPath: join(import.meta.dirname, "../preload/pluginSandbox.cjs"),
    rendererDir: join(import.meta.dirname, "../renderer"),
    aliasDir: join(import.meta.dirname, "../plugin-sandbox"),
    // 开发模式 out/renderer 没有 shell 产物，从 renderer dev server 代理（同 cua-permission-panel 的做法）。
    ...(!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
      ? { devServerUrl: process.env["ELECTRON_RENDERER_URL"] }
      : {}),
    logger: console,
    // e2e L05（配额）：只在 e2e run 里允许缩小注册表容量。
    ...(process.env.ZCODE_E2E_RUN_ID?.trim() &&
    Number.isInteger(Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES)) &&
    Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) > 0
      ? { registryMaxEntries: Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) }
      : {}),
  });
  installBrowserLocalPreview(session.fromPartition(EMBEDDED_BROWSER_PARTITION));
  installBrowserRestoreBootstrapProtocol(
    session.fromPartition(EMBEDDED_BROWSER_PARTITION).protocol,
  );
  // Bootstrap: 从设置文件读取自定义数据目录，在所有 host 进程启动前生效
  let loadedBootstrapLocale = false;
  let bootstrapSettings: AppSettings | undefined;
  try {
    bootstrapSettings = await mainSettingService.get();
    if (bootstrapSettings.dataBaseDir) {
      setDataBaseDir(bootstrapSettings.dataBaseDir);
    }
    if (bootstrapSettings.locale) {
      loadedBootstrapLocale = true;
      currentApplicationLocale = bootstrapSettings.locale;
    }
    // Linux 默认值归位迁移（spec：docs/desktop/linux-close-to-tray.md）：shared 迁移无平台
    // 概念、曾把存量 Linux 用户归为 true，但 Linux 此前无设置入口，存量 true 非用户显式
    // 选择；首次启动强制归位为默认关并落标记，之后尊重用户选择。
    const closeToTrayBootstrap = resolveCloseToTrayBootstrapValue({
      platform: process.platform,
      stored: bootstrapSettings.closeToTrayOnWindows,
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
    });
    // CR-02：必须 await 持久化完成再继续启动，renderer 设置页才不会读到文件旧值。
    // 写失败时不阻断启动，但内存值回退为文件当前值（resolveCloseToTrayRuntimeValue）：
    // 持久层不可写时维持"文件是唯一可信来源"，避免 main 按 false、设置页显示 true 的
    // 双数据源；迁移在下次启动重试，失败期间保持迁移未完成的旧行为。
    let closeToTrayMigrationPersisted = true;
    if (closeToTrayBootstrap.needsLinuxMigration) {
      try {
        await mainSettingService.update({
          closeToTrayOnWindows: false,
          closeToTrayLinuxMigrationInitialized: true,
        });
      } catch (error) {
        closeToTrayMigrationPersisted = false;
        logger.warn("[settings] failed to persist linux close-to-tray default migration", error);
      }
    }
    closeToTrayOnWindows = resolveCloseToTrayRuntimeValue({
      platform: process.platform,
      stored: bootstrapSettings.closeToTrayOnWindows,
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
      migrationPersisted: closeToTrayMigrationPersisted,
    });
    keepAwakeWhileRunning = bootstrapSettings.keepAwakeWhileRunning ?? false;
    currentDesktopZoomLevel = clampDesktopZoomLevel(bootstrapSettings.desktopZoomLevel ?? 0);
    currentDesktopWindowSize = bootstrapSettings.desktopWindowSize;
    // 全局 keep-awake：启动时若设置已开，立刻持有 powerSaveBlocker，不必等设置变更事件。
    reconcileKeepAwakeBlocker();
  } catch {
    // 读取失败不影响启动，使用默认 homedir
  }

  // scheduler 也会打开 tasks-index；等 Host 完成统一准备，避免在启动页出现前抢先迁移。
  configureDatabaseStartupQuit(() => {
    markExplicitQuit("database-startup-exit");
    app.quit();
  });
  onLocalDatabaseStartupReady(() => {
    try {
      cronScheduler = spawnCronScheduler({
        hostProcessLocalEnv,
        logger,
        resolveDispatchHost: resolveCronDispatchHost,
        // keep-awake 已改为纯设置驱动；计数上报保留给后续诊断/配额用途，不再联动 blocker。
        onOffPeakActiveCountChanged: () => {},
      });
    } catch (error) {
      logger.error("[cron-scheduler] failed to spawn scheduler process:", error);
    }
  });

  if (process.platform === "win32") {
    // 打包态必须与 NSIS 快捷方式使用同一 AUMID，否则 Shell 把它们当成不同应用。
    // 使用构建期产品身份，不依赖用户机器环境；开发态继续保持独立身份。
    app.setAppUserModelId(
      resolveWindowsAppUserModelIdForFlavor(ZCODE_PRODUCT_FLAVOR, { isPackaged: app.isPackaged }),
    );
  }

  applyAppIcon(iconPath);
  if (!loadedBootstrapLocale) {
    currentApplicationLocale = resolveSystemApplicationLocale();
  }
  // Electron 的 net.request 只能在 app ready 后使用；灰度请求仍是旁路预热，不阻塞首个 Host。
  // 预热曾在读取持久化语言之前启动，X-Client-Language 会带默认语言并进入 1 小时缓存；
  // 必须在 currentApplicationLocale 确定之后再启动。
  void desktopContextPromptRollout?.refresh();
  installFinderOpenFolderWorkflow({
    platform: process.platform,
    locale: currentApplicationLocale,
    homeDir: app.getPath("home"),
    logger,
  });
  await installWindowsOpenFolderContextMenu({
    platform: process.platform,
    executablePath: process.execPath,
    argv: process.argv,
    isDefaultApp: Boolean(process.defaultApp),
    locale: currentApplicationLocale,
    logger,
  });
  try {
    await applyDesktopChromiumNetworkPolicies(session, bootstrapSettings ?? {}, logger);
  } catch (error) {
    logger.warn("[desktop-network] Chromium network policy bootstrap failed:", error);
  }

  // 内置浏览器权限闸门（CNVD 未授权访问修复）：必须在任何 guest attach 前完成注册。
  // 弹窗桥把策略决策点接到主窗口 UI；store 落盘「访问此网站时允许/阻止」的站点同意记录。
  const embeddedBrowserPermissionUiBridge = createEmbeddedBrowserPermissionUiBridge({ logger });
  embeddedBrowserPermissionUiBridge.registerResolveListener();
  setActiveEmbeddedBrowserPermissionUiBridge(embeddedBrowserPermissionUiBridge);
  try {
    await applyEmbeddedBrowserPermissionPolicy(session.fromPartition(EMBEDDED_BROWSER_PARTITION), {
      logger,
      prompt: embeddedBrowserPermissionUiBridge.promptPermission,
      devicePicker: embeddedBrowserPermissionUiBridge.devicePicker,
      onDisplayMediaRequest: embeddedBrowserPermissionUiBridge.onDisplayMediaRequest,
      store: createEmbeddedBrowserSitePermissionStore(
        join(app.getPath("userData"), "embedded-browser-site-permissions.json"),
      ),
    });
  } catch (error) {
    logger.warn("[embedded-browser-permission] policy bootstrap failed:", error);
  }

  await hydratePendingPostUpdateReleaseNotes(mainSettingService);
  logWindowsBundledRuntimeIntegrityDiagnostic();

  // 启动自动更新检查（后台执行，不阻塞主界面）
  // Preview 身份无论连接哪个后端都不自动更新：stable feed 上只分发正式 ZCode 安装包，
  // 不向 Preview 渠道提供更新。构建期未启用自动更新时同样不更新
  // （见 docs/desktop/build-time-optional-capabilities.md）。
  void initAutoUpdater({
    enabled: ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED,
    onBeforeQuitAndInstall: async () => {
      notifyStabilityLifecycle("update_install");
      await prepareAppQuit("auto-update quitAndInstall", "update-install");
      if (process.platform === "win32") {
        await prepareWindowsProcessesForUpdateInstall();
      }
    },
    settingService: mainSettingService,
    locale: currentApplicationLocale,
    deviceMid,
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    updateFeedSource: resolveUpdateFeedSourceFromStartupConfig({
      argv: process.argv,
      env: process.env,
    }),
  });

  if (process.platform === "darwin" || process.platform === "win32") {
    app.clearRecentDocuments();
  }

  rebuildMenu();
  configureDockMenu(
    () =>
      getDesktopMenuLabelByLocale(
        currentApplicationLocale,
        desktopMenuMessageIds.dockShowCurrentWindow,
      ),
    () => showCurrentWindowFromDock(primaryWindowCoordinator),
  );
  const desktopTrayOptions = {
    getLocale: () => currentApplicationLocale,
    showCurrentWindow: () =>
      primaryWindowCoordinator.ensurePrimaryWindow("tray-show-current-window"),
    executeDesktopCommand: executeDesktopCommandForApp,
    quitApp: () => {
      markExplicitQuit("tray-quit");
      app.quit();
    },
    logger,
  };
  // CR-01：托盘实例是否创建成功必须成为可隐藏能力的一部分。DBus watcher 只能证明桌面
  // 可能有 host，new Tray() 仍可能因图标缺失/会话未就绪抛错；此时隐藏窗口会让用户失去
  // 唯一入口（失联）。trayReady 由创建结果置位，关窗与设置页能力查询都读它。
  if (process.platform === "win32") {
    desktopTrayReady = createDesktopTray(desktopTrayOptions) !== null;
  }

  const ensureLinuxDesktopTray = async (): Promise<void> => {
    if (process.platform !== "linux" || desktopTrayReady) {
      return;
    }
    // Linux 托盘创建跟随能力而非设置开关（spec：docs/desktop/linux-close-to-tray.md）：
    // 无 StatusNotifierWatcher 的桌面（GNOME 默认）上 new Tray() 静默失败，注册无人渲染的
    // DBus name 没有意义；能力探测通过后再创建。用户装扩展后经设置页查询也会走到这里补建。
    const capability = await closeToTrayCapabilityMonitor.refresh();
    if (capability.supported) {
      desktopTrayReady = createDesktopTray({ ...desktopTrayOptions, platform: "linux" }) !== null;
      // 托盘补建成功时回放当前未读数：创建前已有的未读不能等到下一次计数变化才出现在红点上。
      if (desktopTrayReady) {
        syncApplicationUnreadBadge(windowUnreadCountMap);
      }
    }
  };
  if (process.platform === "linux") {
    void ensureLinuxDesktopTray().catch((error: unknown) => {
      logger.warn("[desktop-tray] linux tray capability probe failed", error);
    });
  }

  registerPlatformIpcHandlers({
    fetchHelpConfig: readHelpConfig,
    logger,
    // CDP-on-guest pivot：renderer `<webview>` dom-ready 上报 guest webContentsId → attach。
    attachBrowserGuest: (key, webContentsId, options) => {
      const result = browserGuestManager.attachGuest(key, webContentsId, options);
      if (result.ok && options?.windowId !== undefined) {
        embeddedBrowserDialogController.bindGuest(key, webContentsId, options.windowId);
      }
      return result;
    },
    updateBrowserGuestViewport: (tabId, viewport, windowId) =>
      browserGuestManager.updateViewportFromRenderer(tabId, viewport, windowId),
    reportBrowserScreenshotSurfaceReady: (windowId, senderWebContentsId, payload) => {
      logger.debug("[browser-screenshot-surface] renderer ready", {
        windowId,
        senderWebContentsId,
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
        viewport: payload.viewport,
        surfaceScale: payload.surfaceScale,
      });
      browserScreenshotSurfaceCoordinator.handleReady({
        windowId,
        senderWebContentsId,
        payload,
      });
    },
    browserViewResidencyHandlers: {
      detachBrowserGuest: (key, webContentsId, windowId) =>
        browserGuestManager.detachGuestBeforeReplacement(key, webContentsId, windowId),
      closeBrowserTab: (payload) => browserGuestManager.closeTabFromRenderer(payload),
      reportBrowserTabResidency: (payload) => browserGuestManager.reportResidency(payload),
      acknowledgeBrowserTabSuspend: (payload) => browserGuestManager.acknowledgeSuspend(payload),
      ensureBrowserTabResident: (payload) =>
        browserGuestManager.ensureResidentFromRenderer(payload),
      restoreBrowserTabs: (payload) => browserGuestManager.restoreTabs(payload),
    },
    applyApplicationLocale: async (locale) => {
      currentApplicationLocale = locale;
      // Host 的 ZCode endpoint 请求以此为实时语言；setting.json 写入可能滞后或失败，不能作为来源。
      for (const child of windowHostProcessMap.values()) {
        child.postMessage({ type: HostMessageTypes.ApplicationLocaleChanged, locale });
      }
      windowsCuaOperationIndicator.refreshContent();
      rebuildMenu();
      for (const win of getApplicationWindowsExcludingCuaIndicator()) {
        if (!win.isDestroyed()) {
          win.webContents.send(PlatformChannels.ApplicationLocaleChanged, currentApplicationLocale);
        }
      }
      installFinderOpenFolderWorkflow({
        platform: process.platform,
        locale: currentApplicationLocale,
        homeDir: app.getPath("home"),
        logger,
      });
      // Windows Explorer 右键菜单是注册表持久项，renderer 切换语言不会自动刷新。
      // 这里跟 macOS Finder Service 一样在 locale 变化时重写菜单文案，避免继续显示旧语言。
      await installWindowsOpenFolderContextMenu({
        platform: process.platform,
        executablePath: process.execPath,
        argv: process.argv,
        isDefaultApp: Boolean(process.defaultApp),
        locale: currentApplicationLocale,
        logger,
      });
      configureDockMenu(
        () =>
          getDesktopMenuLabelByLocale(
            currentApplicationLocale,
            desktopMenuMessageIds.dockShowCurrentWindow,
          ),
        () => showCurrentWindowFromDock(primaryWindowCoordinator),
      );
    },
    focusWorkspaceInExistingWindow: (path, extra) =>
      focusWorkspaceInExistingWindow(path, windowWorkspaceMap, extra),
    windowWorkspaceMap,
    windowUnreadCountMap,
    resolveSystemLocale: resolveSystemApplicationLocale,
    currentApplicationLocale: () => currentApplicationLocale,
    executeDesktopCommand: executeDesktopCommandForApp,
    acknowledgePostUpdateReleaseNotes: (version) =>
      acknowledgePostUpdateReleaseNotes(version, mainSettingService),
    syncActiveTaskSession: (windowId, sessionId) =>
      cuaPipFocusRouter.updateActiveSession(windowId, sessionId),
    syncTaskRealtimeWorkspaceKeys: (windowId, workspaceKeys) => {
      const hostId = windowTaskRealtimeHostIdMap.get(windowId);
      if (hostId) {
        taskRealtimeBus.updateHostWorkspaceKeys(hostId, workspaceKeys);
      }
    },
    getUpdateState: getAutoUpdaterState,
    openUpdateStatusWindow,
    getAutoUpdatePreferences,
    setAutoDownloadAndInstallUpdates,
    getDesktopSessionActivity: () => ({
      runningAgentSessionCount: getRunningAgentSessionCount(),
    }),
    syncWebRemoteControlWorkspaces: (windowId, workspaces) => {
      webRemoteControlManager.syncAvailableWorkspaces(windowId, workspaces);
      void webRemoteControlManager.restorePreviouslyEnabled(windowId, workspaces);
    },
    syncAppSettings: syncImmediateAppSettings,
    // 设置页置灰查询：monitor 带 stale 缓存，装完 AppIndicator 扩展重开设置页即可刷新。
    // 设置页置灰查询：先确保托盘实例就绪（用户装扩展后首次查询会补建），再返回合并了
    // trayReady 的最终能力，避免设置页显示可开启但关窗实际走确认退出的不一致（CR-01）。
    refreshCloseToTrayCapability: async () => {
      await ensureLinuxDesktopTray();
      const capability = await closeToTrayCapabilityMonitor.refresh();
      return {
        supported: resolveCloseToTraySupported({
          platform: process.platform,
          desktopTrayReady,
          capabilitySupported: capability.supported,
        }),
        gnomeLikeWithoutTray: capability.gnomeLikeWithoutTray,
      };
    },
    setShortcutRecordingActive,
    deviceMid,
  });

  disposeRendererActionTraceIpc = registerRendererActionTraceIpc({
    rollout: rendererActionTraceRollout,
    broker: rendererActionTraceBroker,
    env: process.env,
    logger,
  });

  registerRemoteIpcHandlers({
    logger,
    appTelemetryRuntime,
    onOAuthCallbackHandledSideEffect: () => {
      void armsUserIdentitySync.refresh();
    },
    appTelemetryCore,
    reportRemoteUsageEvent: reportRemoteUsageEventForRenderer,
    armsCustomContext: {
      deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    },
    finalArmsCustomEventE2EEnabled: shouldEnableE2ETestBridge(process.env),
    webRemoteControlManager,
    createRemoteWorkspaceSession: remoteSessionManager.createRemoteWorkspaceSession,
    getRemoteConnectionStats: remoteSessionManager.getRemoteConnectionStats,
    disposeRemoteWorkspaceSession: remoteSessionManager.disposeRemoteWorkspaceSession,
    cancelPendingRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow,
    bindRemoteWorkspaceSessionContext: remoteSessionManager.bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady: remoteSessionManager.confirmRendererAttachmentReady,
    attachSourceSettings: (sender, sourceServerId) => {
      const child = windowHostProcessMap.get(sender.id);
      if (!child) throw new Error("Desktop Window Host is unavailable");
      const { port1, port2 } = new MessageChannelMain();
      const attachmentId = `source-settings-${randomUUID()}`;
      child.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId,
          clientMode: "desktop-continuous",
          scope: { kind: "source-settings", sourceServerId },
        },
        [port2],
      );
      sender.postMessage(
        InternalChannels.SourceSettingsServicePort,
        { attachmentId, sourceServerId },
        [port1],
      );
      return { attachmentId };
    },
    isDockerDaemonAvailable,
    listAvailableWSLDistros,
    listAvailableDockerContainers,
    listSSHConfigAliases,
  });

  // 等待 ARMS 完成 init（含渲染进程注入监听），避免首窗 dom-ready 早于 SDK 注册导致无上报
  await armsInitPromise;

  // ARMS init 完成后首次写入 user.name（落 device_mid）
  void armsUserIdentitySync.refresh();

  configureDesktopStabilityTelemetry({
    deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopResourceTelemetry({
    deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopMcpTelemetry({
    deviceMid,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopNetworkTelemetry({
    deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  registerDesktopStabilityMonitors(logger, crashCapturePaths);
  registerDesktopResourceTelemetry(logger);
  // 主窗口 renderer 的 60 秒 heap 样本入口；随 App 生命周期常驻，只注册一次。
  registerRendererHeapSampleIpc();
  const defaultDataBaseDir = process.env.HOME?.trim() || homedir();
  registerDesktopZCodeDataSizeTelemetry({
    context: {
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
      dataRootKind:
        resolve(getDataBaseDir()) === resolve(defaultDataBaseDir) ? "default" : "custom",
      deviceMid,
      platform: process.platform,
    },
    getSystemIdleTimeSeconds: () => powerMonitor.getSystemIdleTime(),
    isAppBackground: () => resolveResourceUsageScene() === "background",
    isZCodeBusy: () => getRunningAgentSessionCount() > 0,
    logger,
    rootPath: getZCodeDataRootDir(),
    stateFile: join(app.getPath("userData"), "zcode-data-size-telemetry.json"),
  });
  registerDesktopNetworkTelemetry(logger);

  // 本地未打包 dev 构建（app.isPackaged === false）必须跳过远端强制升级 gate。
  // 原因：force-update gate 只看 ZCODE_ENV === "production"，但 dev 构建（如 dev:desktop:cua
  // 连真实后端测 computer use）虽指向 production 后端，版本号却滞后于线上 release（feature
  // 分支不 bump 版本），会被 release minimalVersion 误判为"需强制升级"而启动秒退。force-update
  // 是面向打包发布客户端的安全门，对未打包 dev 运行时无意义。打包版 app.isPackaged === true，
  // gate 照常生效，对真实用户零影响。
  const skipForceUpdateForLocalDevRuntime = !app.isPackaged;
  const forceUpdateGuardResult =
    ZCODE_PRODUCT_FLAVOR === "production" && !skipForceUpdateForLocalDevRuntime
      ? await maybeBlockStartupForForceUpdate({
          locale: currentApplicationLocale,
          logger,
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          onBlocked: () => {
            forceUpdateMainWindowCreationBlocked = true;
          },
        })
      : { blocked: false };
  if (ZCODE_PRODUCT_FLAVOR !== "production") {
    logger.info("[force-update] Preview 跳过远端强制升级检查");
  } else if (skipForceUpdateForLocalDevRuntime) {
    logger.info("[force-update] 本地 dev 构建（未打包）跳过远端强制升级检查");
  }
  if (forceUpdateGuardResult.blocked) {
    return;
  }

  logger.info("[startup] 创建主窗口");
  await primaryWindowCoordinator.ensurePrimaryWindow("app-ready");

  const primaryWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (primaryWindow) {
    scheduleReportPerfAppStartAfterMainViewReady(primaryWindow.webContents, logger);
  }

  // 启动后检测 CPU 架构是否匹配（如 Apple 芯片误装 x64 版本经 Rosetta 转译运行），
  // 命中后异步弹框提示安装原生架构版本，不阻塞主界面。
  void maybeWarnArchitectureMismatch({
    locale: currentApplicationLocale,
    logger,
    parentWindow: getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    icon: nativeImage.createFromPath(iconPath),
  }).catch((error) => {
    logger.warn("[architecture] 架构检测弹框失败:", error);
  });

  const protocolUrl = extractDeepLinkUrlFromArgs(process.argv);
  if (protocolUrl && startupDeepLinkConsumptionGate.shouldHandleReadyProtocolUrl(protocolUrl)) {
    handleDeepLink(protocolUrl, logger, {
      confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    });
  }
});

app.on("browser-window-created", (_, win) => {
  const windowWebContentsId = win.webContents.id;
  win.on("closed", () => {
    browserScreenshotSurfaceCoordinator.handleWindowDestroyed(win.id);
    browserGuestManager.closeWindow(win.id);
    windowWorkspaceMap.delete(win.id);
    windowTaskRealtimeHostIdMap.delete(win.id);
    if (windowUnreadCountMap.delete(win.id)) {
      syncApplicationUnreadBadge(windowUnreadCountMap);
    }
    // Electron 进入 closed 回调时，win.webContents 可能已经被销毁。
    // 之前这里现取 win.webContents.id，会在关窗收尾阶段抛出 "Object has been destroyed"。
    // 改为在窗口创建时缓存 webContents id，确保清理 OAuth 路由时不再访问已销毁对象。
    clearOAuthRoutesForWindow(windowWebContentsId);
    // 录制中关窗/崩溃时 renderer 不会发复位 IPC，这里按发起 webContents 复位录制态，
    // 防止菜单 accelerator 被永久摘除。
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
  // 渲染进程崩溃但窗口存活时 closed 不会触发，崩溃路径同样按 owner 复位
  // （owner 不匹配时天然幂等）。
  win.webContents.on("render-process-gone", () => {
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
});
app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    // macOS: keep app running when all windows are closed
    return;
  }

  app.quit();
});
app.on("before-quit", (event) => {
  // Windows 最后窗口关闭会在 close 阶段提前确认并标记 forceQuit；
  // macOS 的 Cmd+Q / 菜单退出不会走该窗口关闭确认，必须在 before-quit 保留应用级确认兜底。
  if (!forceQuitRef.current && shouldConfirmAppQuit() && !confirmAppQuit()) {
    event.preventDefault();
    // 托盘退出等显式退出如果被确认框取消，不能继续保留 explicitQuit。
    // 否则用户下一次点 Windows 关闭按钮会绕过“隐藏到托盘”设置，误触发完整退出路径。
    explicitQuitRef.current = false;
    return;
  }

  if (!hasPreparedAppQuit) {
    localMediaPreviewPathRegistry.clear();
    event.preventDefault();
    void prepareAppQuit("app-before-quit").finally(() => {
      const remainingWindows = getApplicationWindowsExcludingCuaIndicator();
      logger.info(
        `[app-quit] preparation finished, resuming quit with windows=${remainingWindows.length}`,
      );
      // ChromeDriver 关闭最后一个 renderer 后才触发 app.quit 时，
      // 第一次 before-quit 会被异步 host 清理拦截；清理完成时窗口可能仍处于
      // closing 状态，此时重入 app.quit 会被 Electron 忽略，ChromeDriver 会等待
      // 约 70 秒。这里把最后一次退出绑定到真实 closed 事件，不依赖超时猜测。
      if (remainingWindows.length === 0) {
        exitPreparedApp("no-windows-after-preparation");
        return;
      }

      let exitRequested = false;
      const exitAfterLastWindowClosed = () => {
        if (exitRequested || getApplicationWindowsExcludingCuaIndicator().length > 0) {
          return;
        }
        exitRequested = true;
        logger.info("[app-quit] all windows closed after preparation, exiting app");
        exitPreparedApp("all-windows-closed-after-preparation");
      };
      for (const win of remainingWindows) {
        win.once("closed", exitAfterLastWindowClosed);
      }
      app.quit();
    });
  }
});
app.on("activate", () => {
  void primaryWindowCoordinator.ensurePrimaryWindow("app-activate");
});

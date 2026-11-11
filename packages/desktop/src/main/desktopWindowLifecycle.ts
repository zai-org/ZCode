import { getDatabaseStartupPortPayload } from "./databaseStartupRelay.js";
import { randomUUID } from "node:crypto";
import { release as readPlatformRelease } from "node:os";
import { app, BrowserWindow, Menu, MessageChannelMain, nativeImage } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, InternalChannels, PlatformChannels, type Locale } from "@zcode/shared";
import { scheduleArmsBrowserPerfLoadNudge } from "./armsBrowserPerfLoadNudge.js";
import { createBrowserWindow } from "./desktopWindowChrome.js";
import type { HostInitMessage, WindowBootstrapOptions } from "./desktopHostProcess.js";
import type { StartupWorkspaceWarmupTarget } from "./startupWorkspace.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import { handleDarwinWindowCloseRequest } from "./desktopDarwinCloseBehavior.js";
import { supportsNativeWindowsRoundedCorners } from "./desktopWindowChromeState.js";
import {
  createWindowsTaskbarOverlayApplier,
  maxWindowUnreadCounts,
  parseWindowUnreadCount,
  renderTaskbarStatusDotPixels,
  syncUnreadBadgeForPlatform,
} from "./unreadBadge.js";
import { attachDesktopWindowSizePersistence, type DesktopWindowSize } from "./desktopWindowSize.js";
import {
  registerMainApplicationWindow,
  unregisterMainApplicationWindow,
} from "./resourceManagerWindow.js";

const DEFAULT_RUNTIME_PROCESS_ENV_WAIT_TIMEOUT_MS = 4_500;

export function createWindow(options: {
  iconPath: string;
  preloadPath: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  forceQuitRef: { current: boolean };
  handleBeforeClose?: (win: BrowserWindow, label: string) => boolean;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  spawnHostProcess: (
    win: BrowserWindow,
    label: string,
    // Main 在包装层统一注入 zcodeBuiltinProviderConfigFilePath（Electron 安装布局只有 Main 知道），
    // 窗口生命周期只负责组装其余 InitLocal 字段。
    initMessage: Omit<HostInitMessage, "zcodeBuiltinProviderConfigFilePath">,
  ) => ElectronUtilityProcess;
  disposeHostProcess: (
    child: ElectronUtilityProcess,
    label: string,
    forceKillDelayMs?: number,
  ) => void;
  syncAutoUpdaterStateToWindow: (win: BrowserWindow) => void;
  syncReadyUpdateToWindow: (win: BrowserWindow) => void;
  syncPostUpdateReleaseNotesToWindow: (win: BrowserWindow) => void;
  webRemoteControlManager: { disposeWindow(windowId: number): Promise<void> };
  disposeRemoteWorkspaceSessionsForWindow: (windowId: number, reason: string) => void;
  reattachRemoteWorkspaceSessionsForWindow: (win: BrowserWindow, reason: string) => void;
  bootstrap?: WindowBootstrapOptions;
  agentWarmupTargets?: readonly StartupWorkspaceWarmupTarget[];
  agentSpawnFallbackCwd: string;
  deviceMid: string;
  remoteAssets?: RemoteAssetDirs;
  initialDesktopZoomLevel?: number;
  initialWindowSize?: DesktopWindowSize;
  currentApplicationLocale?: () => Locale;
  persistWindowSize?: (state: DesktopWindowSize) => Promise<void>;
  /** Main 模块初始化期已开始的异步环境采集；通常在 renderer dom-ready 前完成。 */
  runtimeProcessEnvPatchPromise?: Promise<Record<string, string>>;
  /** 不执行 shell 即可计算的完整降级 patch；预热失败/超时时仍要注入 Local Host。 */
  runtimeProcessEnvFallbackPatch: Record<string, string>;
  /** 仅供启动门禁和测试注入；超过该时间必须 fail-open 创建 Local Host。 */
  runtimeProcessEnvWaitTimeoutMs?: number;
  /**
   * 首个 Local Host 创建前的有界灰度裁决门。
   *
   * 缺省（undefined）时完全不触发 await，dom-ready handler 同步执行——保证既有调用方
   * 与测试零回归。仅 desktop main 注入：在 spawnLocalHost 之前等待一次 rollout 裁决，
   * 避免冷启动快照 { enabled:false } 被烤进首 Host env 后无法被异步成功结果覆盖。
   */
  awaitFirstHostSpawnDecision?: () => Promise<void>;
  /** Local Host map insertion completed; presentation facts can now be replayed safely. */
  onHostProcessReady?: (windowKey: number) => void;
  resolveBrowserViewOwner?: Parameters<typeof createBrowserWindow>[0]["resolveBrowserViewOwner"];
}) {
  const win = createBrowserWindow({
    iconPath: options.iconPath,
    preloadPath: options.preloadPath,
    bootstrap: {
      restoreSession: options.bootstrap?.restoreSession ?? true,
      supportsSettings: options.bootstrap?.supportsSettings ?? true,
      initialWorkspacePath: options.bootstrap?.initialWorkspacePath,
      initialWorkspacePurpose: options.bootstrap?.initialWorkspacePurpose,
      unavailableWorkspacePath: options.bootstrap?.unavailableWorkspacePath,
    },
    logger: options.logger,
    deviceMid: options.deviceMid,
    initialDesktopZoomLevel: options.initialDesktopZoomLevel,
    initialWindowSize: options.initialWindowSize,
    currentApplicationLocale: options.currentApplicationLocale,
    resolveBrowserViewOwner: options.resolveBrowserViewOwner,
  });
  const label = `local-${win.webContents.id}`;

  if (options.persistWindowSize) {
    attachDesktopWindowSizePersistence(win, options.persistWindowSize, (error) => {
      options.logger.warn("[desktop-window] failed to persist main window size", error);
    });
  }

  if (process.platform === "darwin") {
    win.on("close", (event) => {
      if (
        handleDarwinWindowCloseRequest({
          win,
          forceQuit: options.forceQuitRef.current,
          label,
          logger: options.logger,
        })
      ) {
        event.preventDefault();
      }
    });
  } else if (options.handleBeforeClose) {
    win.on("close", (event) => {
      if (options.handleBeforeClose?.(win, label)) {
        event.preventDefault();
      }
    });
  }

  const wcId = win.webContents.id;
  const browserWindowId = win.id;
  // 资源遥测据此把主窗口 renderer 归 renderer_main；辅助窗口与 DevTools 归 chromium_other。
  registerMainApplicationWindow(wcId);
  let domReadyGeneration = 0;
  let cancelRuntimeProcessEnvWait: (() => void) | null = null;
  scheduleArmsBrowserPerfLoadNudge(win.webContents);
  win.webContents.on("dom-ready", async () => {
    cancelRuntimeProcessEnvWait?.();
    cancelRuntimeProcessEnvWait = null;
    const currentDomReadyGeneration = ++domReadyGeneration;
    options.logger.info(`[createWindow] dom-ready fired (${label})`);

    if (process.platform === "win32" && !win.isDestroyed()) {
      win.show();
      win.focus();
    }

    const oldChild = options.windowHostProcessMap.get(wcId);
    // renderer 刷新（reload）
    // 曾经无条件杀掉旧 host 进程再重建——host 连带 CLI agent 一起死，运行中的会话直接消失，
    // 这正是「会话身份易失」病根。host/CLI 的生命周期属于窗口而非
    // renderer 加载周期：reload 只需给存活的 host 补挂一条新 RPC MessagePort
    // （复用 web 远控的 AttachServicePort 通道），renderer 重新订阅即可恢复投影。
    // 旧端口的 ChannelServer 会随 renderer 上下文销毁触发 close 自行回收。
    if (oldChild && oldChild.pid !== undefined) {
      try {
        const startupPayload = getDatabaseStartupPortPayload(oldChild);
        if (!startupPayload) throw new Error("Previous Host startup binding is unavailable");
        const { port1, port2 } = new MessageChannelMain();
        oldChild.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId: randomUUID(),
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ServicePort, startupPayload, [port1]);
        options.logger.info(
          `[createWindow] renderer reloaded, reattached to existing host (${label}), pid=${oldChild.pid}`,
        );
        options.syncAutoUpdaterStateToWindow(win);
        options.syncReadyUpdateToWindow(win);
        options.syncPostUpdateReleaseNotesToWindow(win);
        options.reattachRemoteWorkspaceSessionsForWindow(win, `${label}:renderer-reload`);
        return;
      } catch (error) {
        options.logger.warn(
          `[createWindow] reattach to existing host failed (${label}), falling back to respawn:`,
          error,
        );
      }
    }
    if (oldChild) {
      options.logger.info(
        `[createWindow] killing previous host process for (${label}), pid=${oldChild.pid ?? "unknown"}`,
      );
      options.disposeHostProcess(oldChild, `${label}:reload`, 150);
    }

    // 首个 Local Host 创建前的有界灰度裁决门。用 `if` 守卫而非 `await cb?.()`——
    // cb 缺省时不触发任何 await，async handler 同步跑完，保证既有调用方与测试零回归。
    // 仅在需要 spawn 新 Host 的路径上等待（reattach 早退路径已在上方 return，不触发）。
    if (options.awaitFirstHostSpawnDecision) {
      await options.awaitFirstHostSpawnDecision();
    }

    const spawnLocalHost = (runtimeProcessEnvPatch: Record<string, string>) => {
      if (currentDomReadyGeneration !== domReadyGeneration || win.isDestroyed()) {
        return;
      }
      const primaryWarmupTarget = options.agentWarmupTargets?.[0];
      const child = options.spawnHostProcess(win, label, {
        type: HostMessageTypes.InitLocal,
        deviceMid: options.deviceMid,
        workspacePath: primaryWarmupTarget?.workspacePath,
        workspaceIdentity: primaryWarmupTarget?.workspaceIdentity,
        ...(options.agentWarmupTargets && options.agentWarmupTargets.length > 0
          ? { agentWarmupTargets: [...options.agentWarmupTargets] }
          : {}),
        runtimeProcessEnvPatch,
        // 同一窗口会后台索引所有已恢复 workspace，不只索引启动时的 active workspace。
        // fallback 必须跟随 local Host 生命周期常驻，否则非 active 历史目录被删除后会用失效 cwd 反复 spawn。
        agentSpawnFallbackCwd: options.agentSpawnFallbackCwd,
        remoteAssets: options.remoteAssets,
        // Host 的 X-Client-Language 以 Main 的实时界面语言为准；与后续变更消息同端口按序到达。
        ...(options.currentApplicationLocale ? { locale: options.currentApplicationLocale() } : {}),
      });
      options.windowHostProcessMap.set(wcId, child);
      options.onHostProcessReady?.(wcId);
      options.syncAutoUpdaterStateToWindow(win);
      options.syncReadyUpdateToWindow(win);
      options.syncPostUpdateReleaseNotesToWindow(win);
      options.reattachRemoteWorkspaceSessionsForWindow(win, `${label}:renderer-ready`);
    };

    if (!options.runtimeProcessEnvPatchPromise) {
      spawnLocalHost(options.runtimeProcessEnvFallbackPatch);
      return;
    }
    let settled = false;
    const waitTimeoutMs =
      options.runtimeProcessEnvWaitTimeoutMs ?? DEFAULT_RUNTIME_PROCESS_ENV_WAIT_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cancelWait = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    };
    const completeWait = (runtimeProcessEnvPatch: Record<string, string>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (cancelRuntimeProcessEnvWait === cancelWait) {
        cancelRuntimeProcessEnvWait = null;
      }
      spawnLocalHost(runtimeProcessEnvPatch);
    };
    cancelRuntimeProcessEnvWait = cancelWait;
    timeout = setTimeout(() => {
      options.logger.warn(
        `[createWindow] runtime env prewarm exceeded ${waitTimeoutMs}ms after dom-ready (${label}), using shell-free fallback`,
      );
      completeWait(options.runtimeProcessEnvFallbackPatch);
    }, waitTimeoutMs);
    void options.runtimeProcessEnvPatchPromise.then(completeWait, (error) => {
      options.logger.warn(
        `[createWindow] runtime env prewarm failed (${label}), using shell-free fallback:`,
        error,
      );
      // 旧 rejection 分支传 undefined，Host 随后又同步执行同一个 login shell，
      // 可能把 Main 的白屏转移成 Host 卡死。Main 路径始终传入预计算 fallback patch。
      completeWait(options.runtimeProcessEnvFallbackPatch);
    });
  });

  win.on("closed", () => {
    unregisterMainApplicationWindow(wcId);
    cancelRuntimeProcessEnvWait?.();
    cancelRuntimeProcessEnvWait = null;
    options.logger.info(`[createWindow] window closed, killing host process (${label})`);
    const child = options.windowHostProcessMap.get(wcId);
    if (child) {
      options.disposeHostProcess(child, `${label}:window-closed`);
      options.windowHostProcessMap.delete(wcId);
    }
    void options.webRemoteControlManager.disposeWindow(browserWindowId);
    options.disposeRemoteWorkspaceSessionsForWindow(wcId, `${label}:window-closed`);
  });

  return win;
}

export function showCurrentWindowFromDock(primaryWindowCoordinator: {
  ensurePrimaryWindow(reason: string): Promise<void>;
}) {
  if (process.platform === "darwin") {
    app.show();
  }

  void primaryWindowCoordinator.ensurePrimaryWindow("dock-show-current-window");
}

export function focusWorkspaceInExistingWindow(
  path: string,
  windowWorkspaceMap: Map<number, Set<string>>,
  options?: { skipWindowId?: number },
): { activated: boolean; winId?: number } {
  for (const [winId, pathSet] of windowWorkspaceMap) {
    if (options?.skipWindowId === winId) {
      continue;
    }
    if (!pathSet.has(path)) {
      continue;
    }

    const existingWin = BrowserWindow.fromId(winId);
    if (existingWin && !existingWin.isDestroyed()) {
      if (existingWin.isMinimized()) {
        existingWin.restore();
      }
      existingWin.focus();
      existingWin.webContents.send(PlatformChannels.FocusTab, path);
      return { activated: true, winId };
    }

    windowWorkspaceMap.delete(winId);
  }

  return { activated: false };
}

// Windows 任务栏 overlay 的 electron 侧装配：像素渲染在 unreadBadge.ts（纯逻辑，可单测），
// 这里只负责 BrowserWindow 枚举与 nativeImage 构造。spec 见 docs/desktop/windows-taskbar-unread-badge.md
const windowsTaskbarOverlayLayout = supportsNativeWindowsRoundedCorners(
  process.platform,
  readPlatformRelease(),
)
  ? "windows-11"
  : "windows-10";

const applyWindowsTaskbarOverlay = createWindowsTaskbarOverlayApplier({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  // Windows 固定把 overlay 显示为 16×16。直接传硬边 32px 圆再让 Shell 缩放会发糊、
  // 边缘像缺口；这里提供原生 1x(16px) + 2x(32px) 纯红抗锯齿表示。
  // label 只用于无障碍 description，屏幕阅读器仍播报具体数量。
  createBadgeImage: () => {
    const image = nativeImage.createEmpty();
    image.addRepresentation({
      scaleFactor: 1,
      width: 16,
      height: 16,
      buffer: Buffer.from(renderTaskbarStatusDotPixels(1, windowsTaskbarOverlayLayout)),
    });
    image.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: Buffer.from(renderTaskbarStatusDotPixels(2, windowsTaskbarOverlayLayout)),
    });
    return image;
  },
});

export function syncApplicationUnreadBadge(windowUnreadCountMap: Map<number, number>) {
  const totalUnreadCount = maxWindowUnreadCounts(windowUnreadCountMap);
  syncUnreadBadgeForPlatform({
    platform: process.platform,
    totalUnreadCount,
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
    },
    applyOverlay: applyWindowsTaskbarOverlay,
  });
}

export function handleWindowUnreadCountSync(
  win: BrowserWindow | null,
  payload: unknown,
  windowUnreadCountMap: Map<number, number>,
  logger: { warn: (...args: unknown[]) => void },
) {
  const unreadCount = parseWindowUnreadCount(payload);
  if (unreadCount == null) {
    logger.warn("[sync-window-unread-count] invalid payload:", payload);
    return false;
  }

  if (!win) {
    return false;
  }

  if (unreadCount === 0) {
    windowUnreadCountMap.delete(win.id);
  } else {
    windowUnreadCountMap.set(win.id, unreadCount);
  }
  syncApplicationUnreadBadge(windowUnreadCountMap);
  return true;
}

export function configureDockMenu(getLabel: () => string, onShowCurrentWindow: () => void) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  const dockMenu = Menu.buildFromTemplate([
    {
      label: getLabel(),
      click: onShowCurrentWindow,
    },
  ]);

  app.dock.setMenu(dockMenu);
}

export function handleDesktopWindowCloseRequest(options: {
  platform: NodeJS.Platform;
  forceQuit: boolean;
  explicitQuitRequested?: boolean;
  closeToTray?: boolean;
  /**
   * Linux 关闭驻留的托盘能力（spec：docs/desktop/linux-close-to-tray.md）。
   * GNOME 等无 StatusNotifierWatcher 的桌面托盘不渲染且不报错，必须在隐藏前显式确认能力；
   * 空值按"不可用"安全默认，走确认退出路径，避免窗口隐藏后失联。
   */
  closeToTraySupported?: boolean;
  isLastWindow: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
  shouldConfirmQuit?: boolean;
  confirmQuit: () => boolean;
  /**
   * 只关窗口（不退出应用）时的确认：该窗口的 Host 有关闭后无法恢复的事项时返回用户的选择，
   * 没有这类事项时直接返回 true（docs/git/worktree.md §3.9）。缺省视为无需确认。
   */
  confirmWindowClose?: () => boolean;
  requestQuit: () => void;
  hideWindow?: () => void;
}) {
  // CR 修复:win32 不能短路丢弃 closeToTraySupported——它承载 resolveCloseToTraySupported
  // 的合并裁决(Windows=托盘实例创建成功)。托盘创建失败时隐藏窗口即失联,与 spec
  // "关窗分支与设置页能力查询都读同一合并结果"保持一致。
  const canHideToTray =
    (options.platform === "win32" || options.platform === "linux") &&
    options.closeToTraySupported === true;
  if (
    canHideToTray &&
    options.closeToTray &&
    !options.forceQuit &&
    !options.explicitQuitRequested
  ) {
    options.logger.info(`[createWindow] window close hidden to tray (${options.label})`);
    options.hideWindow?.();
    return true;
  }

  if (options.forceQuit) return false;
  if (options.platform === "darwin" || !options.isLastWindow) {
    // 关闭窗口会结束该窗口的 Host；Host 内正在进行、无法恢复的事项需要用户确认。
    if (options.confirmWindowClose && !options.confirmWindowClose()) {
      options.logger.info(`[createWindow] window close canceled by user (${options.label})`);
      return true;
    }
    return false;
  }

  if (options.shouldConfirmQuit === false) {
    options.logger.info(
      `[createWindow] last window close skipped confirmation, quitting app (${options.label})`,
    );
    options.requestQuit();
    return true;
  }

  if (!options.confirmQuit()) {
    options.logger.info(`[createWindow] last window close canceled by user (${options.label})`);
    return true;
  }

  options.logger.info(
    `[createWindow] last window close confirmed, quitting app (${options.label})`,
  );
  options.requestQuit();
  return true;
}

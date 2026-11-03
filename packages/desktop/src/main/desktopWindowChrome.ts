/* eslint-disable max-lines -- 桌面窗口 chrome、webview 安全策略和 popup 路由共享同一 BrowserWindow 生命周期上下文。 */
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { join } from "node:path";
import type {
  ContextMenuParams,
  DownloadItem,
  Event,
  Input,
  MenuItemConstructorOptions,
  WebContents,
  WindowOpenHandlerResponse,
} from "electron";
import type { DesktopTitleBarTheme, Locale } from "@zcode/shared";
import {
  DEFAULT_LOCALE,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isTrustedCodingPlanWebviewOrigin,
  isTrustedRewardsUrl,
  PlatformChannels,
} from "@zcode/shared";
import { loadWindow, type WindowBootstrapOptions } from "./desktopHostProcess.js";
import {
  buildWindowsTitleBarOverlayForZoomLevel,
  hasCustomWindowsControls,
  registerCustomWindowsControls,
  MACOS_TRAFFIC_LIGHT_BASE_POSITION,
  syncWindowControlsOverlayForZoomLevel,
} from "./desktopWindowButtonPosition.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  resolveDesktopWindowSize,
  type DesktopWindowSize,
} from "./desktopWindowSize.js";
import { getPluginSandboxHost, isPluginSandboxSrc } from "./pluginSandbox/index.js";
import { installEmbeddedBrowserBluetoothDeviceGuard } from "./embeddedBrowserBluetoothGuard.js";
import { getEmbeddedBrowserDevicePicker } from "./embeddedBrowserPermissionUiBridge.js";
// CDP-on-guest pivot：内置浏览器改回 `<webview>` 渲染，宿主 BrowserWindow 需重新开 webviewTag，
// 并在 will/did-attach-webview 里做 guest 硬化 + URL 白名单 + popup 路由回内部 tab。
const ALLOWED_EMBEDDED_BROWSER_PROTOCOLS = new Set([
  "about:",
  "data:",
  "http:",
  "https:",
  "zcode-browser-restore:",
  "zcode-html:",
]);
const ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_BROWSER_DISPOSITIONS = new Set(["background-tab"]);
const CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS = new Set(["api.z.ai", "api.z.ai"]);
const embeddedBrowserJavaScriptDialogPreloadPath = join(
  import.meta.dirname,
  "../preload/embeddedBrowserJavaScriptDialog.cjs",
);
// Coding Plan 官网页专用 preload：挂 window.zcodeBridge 供官网回传购买完成信号。
const codingPlanWebviewPreloadPath = join(import.meta.dirname, "../preload/codingPlanWebview.cjs");

/**
 * 判断 webview 是否加载 Coding Plan 官网购买页（/coding-plan?...&embedded=app）。
 * 用于在 will-attach-webview 里把这种 webview 的 preload 切到 codingPlanWebviewPreloadPath，
 * 其余 webview（如内置浏览器）仍用 embeddedBrowserJavaScriptDialogPreloadPath。
 */
function isCodingPlanEmbeddedWebviewSrc(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (url.pathname !== "/coding-plan") return false;
    const embedded = url.searchParams.get("embedded");
    return embedded === "app";
  } catch {
    return false;
  }
}

/**
 * 宽松判断 webview 当前 URL 是否属于 coding-plan 购买页。
 *
 * setWindowOpenHandler 回调触发时 webview 可能已发生 locale 重定向
 * （/coding-plan → /cn/coding-plan），故 pathname 用 includes 匹配。
 * embedded=app 仍是硬条件，避免误判内置浏览器的外链。
 */
function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isLinuxDesktopWindow() {
  return process.platform === "linux";
}

function buildDesktopWindowVisualOptions() {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      titleBarStyle: "hidden" as const,
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_BASE_POSITION,
      vibrancy: "under-window" as const,
      visualEffectState: "active" as const,
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00000000",
      // Windows 窗口操作由 renderer 绘制，禁用原生标题栏，避免出现两套按钮。
      frame: false,
      backgroundMaterial: "acrylic" as const,
    };
  }

  return {
    // 不透明 BrowserWindow 会把 renderer 的圆角裁切重新填成直角黑底，
    // Linux 外壳无法与内层 12px 面板形成同心圆弧。透明底只负责露出四角，
    // renderer 根面仍使用不透明 token，避免桌面底色混入侧栏。
    backgroundColor: "#00000000",
    transparent: true,
    // Linux 原生标题栏会和 renderer 自绘顶部菜单重复，隐藏 frame 后统一用自定义窗口控制。
    frame: false,
    // Linux 部分窗口管理器会给 frameless 窗口绘制额外外侧阴影/描边，
    // 用户看到的是窗口外缘黑线。只在 Linux 禁用系统阴影，避免影响 macOS/Windows 的原生材质。
    hasShadow: false,
  };
}

export function applyAppIcon(iconPath: string) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  // TypeScript 不会因为 process.platform === "darwin" 自动收窄 app.dock。
  // app.dock 的类型在定义上仍然可能是 undefined，直接调用会持续报 ts(18048)。
  // 这里把平台判断和空值判断合并，既符合运行时语义，也让类型系统明确知道 Dock 一定存在。
  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function syncWindowFullscreenState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send(
    PlatformChannels.WindowFullscreenChanged,
    targetWindow.isFullScreen(),
  );
}

function syncDesktopWindowChromeState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) return;

  targetWindow.webContents.send(
    PlatformChannels.DesktopWindowChromeStateChanged,
    resolveDesktopWindowChromeState(targetWindow.isMaximized()),
  );
}

export function getWindowOverlayTheme(): Exclude<DesktopTitleBarTheme, "system"> {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function applyWindowsTitleBarTheme(
  targetWindow: BrowserWindow,
  theme: DesktopTitleBarTheme,
) {
  if (
    process.platform !== "win32" ||
    targetWindow.isDestroyed() ||
    hasCustomWindowsControls(targetWindow)
  ) {
    return;
  }

  const resolvedTheme = theme === "system" ? getWindowOverlayTheme() : theme;
  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  targetWindow.setTitleBarOverlay(
    buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, resolvedTheme),
  );
}

function attachWindowsWindowRepaint(targetWindow: BrowserWindow) {
  if (process.platform !== "win32") {
    return;
  }

  let pendingRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
      return;
    }

    targetWindow.webContents.invalidate();
  };

  const scheduleRepaint = () => {
    repaint();
    if (pendingRepaintTimer !== null) {
      clearTimeout(pendingRepaintTimer);
    }
    pendingRepaintTimer = setTimeout(() => {
      pendingRepaintTimer = null;
      repaint();
    }, 32);
  };

  targetWindow.on("resized", () => {
    // Windows 手动拉伸结束后，Electron/Chromium 偶发只更新窗口 bounds，
    // 但 renderer 最后一帧没有完整 repaint，新扩展区域会留下宿主底色。resized 是低频结束事件，
    // 这里补一次完整窗口重绘，确保内容层按最终 viewport 尺寸重新铺满。
    scheduleRepaint();
  });
  targetWindow.on("show", () => {
    // Windows Acrylic 窗口 hide 到托盘后再次 show 时可能继续复用失效的合成 surface，
    // renderer 与 host 仍存活但窗口只剩宿主底色；复用 resize 的有界双帧重绘，不 reload renderer 或会话。
    scheduleRepaint();
  });
  targetWindow.on("focus", () => {
    // Bug 原因（ZCT-202610-E0C5B48D）：窗口被其他程序完全覆盖后，Chromium 的 Windows
    // 遮挡检测（native window occlusion）把它标记为 occluded 并停止提交帧、暂停计时器；
    // 部分 Intel 核显驱动组合下切回前台（Alt-Tab / 点通知 / 点击窗口）时遮挡状态不重算，
    // 画面停留在最后一帧，像一张截图。该路径只触发 focus，不触发 show/resized，托盘恢复
    // 与手动拉伸的补丁都盖不到。用户手动拖动窗口或点标题栏能恢复，说明强制重绘一帧即可
    // 打破残留状态；focus 时补同样的有界双帧重绘，等价于把用户的手动恢复动作自动化。
    scheduleRepaint();
  });
}

function isAllowedEmbeddedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isAllowedEmbeddedBrowserNewWindowUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    // 后端下发的 PayPal approveUrl 可能先指向 Z.AI 支付 API 中转地址，
    // 由该地址再 302 到 PayPal。中转 URL 也必须留在当前 webview，否则会被系统浏览器接管。
    return (
      CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function hasExternalBrowserModifier(input: Input): boolean {
  const modifiers = new Set(input.modifiers ?? []);
  return (
    input.meta === true ||
    input.control === true ||
    modifiers.has("meta") ||
    modifiers.has("command") ||
    modifiers.has("cmd") ||
    modifiers.has("control") ||
    modifiers.has("ctrl")
  );
}

function isExternalBrowserModifierKey(input: Input): boolean {
  const key = input.key.toLowerCase();
  const code = input.code.toLowerCase();
  return (
    key === "meta" ||
    key === "control" ||
    code === "metaleft" ||
    code === "metaright" ||
    code === "controlleft" ||
    code === "controlright"
  );
}

function shouldOpenEmbeddedBrowserRequestExternally(input: {
  disposition: string;
  externalBrowserModifierActive: boolean;
}): boolean {
  return (
    input.externalBrowserModifierActive || EXTERNAL_BROWSER_DISPOSITIONS.has(input.disposition)
  );
}

function attachEmbeddedBrowserWindowOpenHandler(options: {
  hostWebContents: WebContents;
  guestWebContents: WebContents;
  isCodingPlanGuest: boolean;
  isRewardsGuest: boolean;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
  logger: { warn: (...args: unknown[]) => void };
}) {
  // 下载响应会让 loadURL 以 ERR_FAILED 拒绝；用真实下载事件区分网络失败。
  const downloadSession = options.guestWebContents.session;
  const onDownload = (_event: Event, item: DownloadItem, contents: WebContents) => {
    if (contents !== options.guestWebContents || options.hostWebContents.isDestroyed()) return;
    options.hostWebContents.send(PlatformChannels.BrowserViewDownloadStarted, {
      webContentsId: contents.id,
      urls: item.getURLChain(),
    });
  };
  downloadSession.on("will-download", onDownload);
  options.guestWebContents.once("destroyed", () => {
    downloadSession.removeListener("will-download", onDownload);
  });
  let externalBrowserModifierActive = false;

  options.guestWebContents.on("before-input-event", (_event, input) => {
    // 某些平台的 keyUp 仍可能带 modifier 标记，直接记最近一次 modifiers
    // 会让"用系统浏览器打开"的状态粘住，导致后续普通点击也被外部打开。
    if (input.type === "keyUp" && isExternalBrowserModifierKey(input)) {
      externalBrowserModifierActive = false;
      return;
    }

    externalBrowserModifierActive = hasExternalBrowserModifier(input);
  });

  options.guestWebContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const { url, disposition } = details;
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview popup url: ${url}`);
      return { action: "deny" };
    }

    // Coding Plan webview 的外链（条款/管理等 target=_blank）直接拉起系统默认浏览器，
    // 不路由到内部 Browser tab（对齐原生购买面板行为）。回调触发时 webview URL 已
    // 加载完成，可能因 locale 重定向变成 /cn/coding-plan，用宽松判断。
    // 支付链接走 location.href（不触发 setWindowOpenHandler），不受影响。
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldRouteCodingPlanPopup =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (shouldRouteCodingPlanPopup) {
      if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
        // PayPal 授权/回调是 Coding Plan 购买流程的一部分，不能走系统浏览器，
        // 否则授权回跳会脱离当前 webview 并丢失购买上下文。popup 形态改为当前 guest 导航。
        void options.guestWebContents.loadURL(url).catch((error: unknown) => {
          options.logger.warn(
            "[browser-pane] failed to load coding-plan embedded popup in webview",
            {
              error: error instanceof Error ? error.message : String(error),
              url,
            },
          );
        });
        return { action: "deny" };
      }
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open coding-plan popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    if (
      shouldOpenEmbeddedBrowserRequestExternally({
        disposition,
        externalBrowserModifierActive,
      })
    ) {
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open webview popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    const owner = options.resolveBrowserViewOwner?.(options.guestWebContents.id);
    options.hostWebContents.send(PlatformChannels.OpenBrowserUrl, {
      disposition,
      url,
      ...(owner
        ? {
            workspaceKey: owner.workspaceKey,
            ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
            sessionId: owner.sessionId,
            browserId: owner.browserId,
            browserGeneration: owner.browserGeneration,
            sourceTabId: owner.tabId,
          }
        : {}),
    });
    return { action: "deny" };
  });

  options.guestWebContents.on("will-navigate", (event, url) => {
    if (options.isRewardsGuest) {
      if (
        isTrustedRewardsUrl(url, {
          dev: !app.isPackaged,
          e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
        })
      )
        return;
      // 邀请页离开受信任路径必须外开，不能让第三方页面使用已注入凭据的容器。
      event.preventDefault();
      if (isAllowedEmbeddedBrowserNewWindowUrl(url))
        void shell
          .openExternal(url)
          .catch(() => options.logger.warn("[rewards] external navigation failed"));
      return;
    }
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldGuardCodingPlanNavigation =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (!shouldGuardCodingPlanNavigation || isCodingPlanWebviewUrl(url)) {
      return;
    }
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported coding-plan navigation url: ${url}`);
      event.preventDefault();
      return;
    }
    if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
      // 官网用 location.href 发起 PayPal 授权时会触发主 frame 导航。
      // PayPal/中转/可信官网回跳需要留在当前 webview，后续 callback 才能继续订阅。
      return;
    }

    // Coding Plan 专用 preload 会在后续主 frame 导航中继续存在。
    // 离开可信购买页时必须阻断 guest 导航并交给系统浏览器，避免第三方页面继承 zcodeBridge。
    event.preventDefault();
    void shell.openExternal(url).catch((error: unknown) => {
      options.logger.warn("[browser-pane] failed to open coding-plan navigation externally", {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
    });
  });
}

function buildTextContextMenuTemplate(
  params: ContextMenuParams,
  locale: Locale,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
      getDesktopMenuMessage(locale, id);

    return [
      {
        label: getLabel(desktopMenuMessageIds.editUndo),
        role: "undo",
        enabled: params.editFlags.canUndo,
      },
      {
        label: getLabel(desktopMenuMessageIds.editRedo),
        role: "redo",
        enabled: params.editFlags.canRedo,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editCut),
        role: "cut",
        enabled: params.editFlags.canCut,
      },
      {
        label: getLabel(desktopMenuMessageIds.editCopy),
        role: "copy",
        enabled: params.editFlags.canCopy,
      },
      {
        label: getLabel(desktopMenuMessageIds.editPaste),
        role: "paste",
        enabled: params.editFlags.canPaste,
      },
      {
        label: getLabel(desktopMenuMessageIds.editDelete),
        role: "delete",
        enabled: params.editFlags.canDelete,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editSelectAll),
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      },
    ];
  }

  if (params.selectionText.trim().length > 0) {
    return [{ role: "copy", enabled: params.editFlags.canCopy }];
  }

  return [];
}

export function createBrowserWindow(options: {
  iconPath: string;
  preloadPath: string;
  title?: string;
  bootstrap?: WindowBootstrapOptions;
  logger: { warn: (...args: unknown[]) => void };
  /** 桌面端设备标识符（基于 userData 路径的 SHA-256），用于 renderer 同步读取 */
  deviceMid?: string;
  /** 桌面端持久化页面缩放档位；窗口创建时先应用，避免首屏回到默认大小。 */
  initialDesktopZoomLevel?: number;
  /** 主进程设置服务读取的最近一次普通窗口尺寸与最大化状态。 */
  initialWindowSize?: DesktopWindowSize;
  /** 每次弹出原生菜单时读取，确保应用切换语言后无需重建窗口。 */
  currentApplicationLocale?: () => Locale;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
}): BrowserWindow {
  const initialDesktopZoomLevel = clampDesktopZoomLevel(options.initialDesktopZoomLevel ?? 0);
  const initialDesktopZoomFactor = resolveDesktopZoomFactorForLevel(initialDesktopZoomLevel);
  const initialWindowSize = resolveDesktopWindowSize(
    options.initialWindowSize,
    screen.getPrimaryDisplay().workAreaSize,
  );
  const win = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_DESKTOP_WINDOW_WIDTH,
    // 1280x720 桌面环境的可用高度通常低于 768，过高的最小高度会导致用户无法继续缩小窗口。
    minHeight: MIN_DESKTOP_WINDOW_HEIGHT,
    title: options.title,
    icon: options.iconPath,
    // Linux frameless 后部分桌面环境仍可能显示 Electron 原生菜单栏，自动隐藏避免顶部出现两套菜单。
    autoHideMenuBar: isLinuxDesktopWindow(),
    ...buildDesktopWindowVisualOptions(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // CDP-on-guest pivot：内置浏览器改回 `<webview>` 渲染，宿主需开 webviewTag。
      webviewTag: true,
      // 永久 backgroundThrottling=false 会唤醒整窗 renderer、所有 webview guest
      // 和 GPU。窗口保持默认节流；截图期只临时唤醒 owner renderer 与当前目标 guest。
      zoomFactor: initialDesktopZoomFactor,
      // 将 deviceMid 透传给 preload，供 renderer 在 React 渲染前同步读取
      additionalArguments: [`--device-id=${options.deviceMid ?? ""}`],
    },
  });

  // 文档渲染库曾直接 window.open 绕过 DOM 链接检查；主窗口不创建未经管控的原生子窗口。
  // 合法外链复用现有 Browser 路由，guest 仍由各自的策略管理。
  win.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      win.webContents.send(PlatformChannels.OpenBrowserUrl, { url, disposition });
    } else {
      options.logger.warn("[desktop-window] blocked unsupported popup protocol");
    }
    return { action: "deny" };
  });

  // 缩放命令原本只改当前运行窗口，没有在重启后恢复。
  // 创建窗口时由 main 进程先应用 setting.json 中的桌面缩放档位，同时覆盖 Chromium 可能残留的 per-host zoom。
  win.webContents.setZoomFactor(initialDesktopZoomFactor);
  if (process.platform === "win32") registerCustomWindowsControls(win);
  syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);

  if (initialWindowSize.maximized) {
    win.maximize();
  }

  win.on("enter-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("leave-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("maximize", () => syncDesktopWindowChromeState(win));
  win.on("unmaximize", () => syncDesktopWindowChromeState(win));
  attachWindowsWindowRepaint(win);
  // will-attach 与 did-attach 按顺序配对；队列元素记录 guest 种类，did-attach 据此分派策略。
  const pendingWebviewGuestKinds: Array<
    | { kind: "browser" | "codingPlan"; isRewards: boolean }
    | { kind: "pluginSandbox"; sandboxId: string }
  > = [];

  win.webContents.once("did-finish-load", () => {
    // 生产包使用 loadFile(file://...) 导航时，Chromium 可能在页面加载完成后重放
    // origin 级 zoom 状态，把窗口创建阶段设置的持久化缩放覆盖回默认值。
    // did-finish-load 后再按 setting.json 的档位重放一次，确保生产包和开发态 localhost 行为一致。
    win.webContents.setZoomFactor(initialDesktopZoomFactor);
    syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);
    syncWindowFullscreenState(win);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // 导航失败时 CDP target 元数据可能仍保留原 file:// URL，而 renderer
      // 实际 document 已经进入 chrome-error://；记录主 frame 失败才能定位真实导航根因。
      options.logger.warn("[desktop-window] renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        webContentsId: win.webContents.id,
      });
    },
  );

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // CDP 在原生 Dialog 已创建后再替换 UI，macOS 仍可能显示已经排队的
    // Chromium NSAlert。固定 preload 在每个 frame 调用原生 API 前拦截，且隔离世界只
    // 暴露 alert/confirm 同步桥；网页主世界仍没有 Node 或任意 IPC 能力。
    //
    // Coding Plan 官网页例外：它需要 window.zcodeBridge 回传购买完成信号，
    // 改用专用 preload（codingPlanWebview.ts），其余 webview 保持原生 Dialog 桥。
    const targetUrl = params.src ?? "about:blank";
    // 插件 UI 沙箱 guest：独立分支，不走内置浏览器的 preload / allowpopups / 协议白名单。
    if (isPluginSandboxSrc(targetUrl)) {
      const host = getPluginSandboxHost();
      const decision = host?.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!decision?.ok) {
        options.logger.warn(
          `[plugin-sandbox] blocked webview attach: ${decision ? decision.reason : "host-not-installed"}`,
        );
        event.preventDefault();
        return;
      }
      pendingWebviewGuestKinds.push({ kind: "pluginSandbox", sandboxId: decision.sandboxId });
      return;
    }
    const isCodingPlanWebview = isCodingPlanEmbeddedWebviewSrc(targetUrl);
    webPreferences.preload = isCodingPlanWebview
      ? codingPlanWebviewPreloadPath
      : embeddedBrowserJavaScriptDialogPreloadPath;
    const isRewardsWebview = isTrustedRewardsUrl(targetUrl, {
      dev: !app.isPackaged,
      e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
    });
    if (isRewardsWebview) {
      webPreferences.preload = join(import.meta.dirname, "../preload/rewardsWebview.cjs");
      if (!app.isPackaged)
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          "--zcode-rewards-dev",
        ];
    }
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = true;

    delete params.preload;
    delete params.nodeintegration;
    // nodeIntegrationInSubFrames 是 guest 创建期偏好；派生 WebPreferences 与原始 attach
    // 参数都固定为 true，确保发生真实导航的子 frame 在网页脚本前加载同一 preload。
    // 无 src 的继承型空 frame 不触发 preload，由 preload 内的同源 frame 观察器接管。
    params.nodeintegrationinsubframes = "true";
    delete params.disablewebsecurity;
    delete params.allowpopups;

    // webview 内 target=_blank/window.open 如果完全禁用 popup 会表现为点击无响应；
    // 如果放任 Electron 默认处理，又会创建脱离 ZCode 的 BrowserWindow。这里由宿主重新打开
    // allowpopups，并在 did-attach-webview 中用 setWindowOpenHandler 统一 deny 默认窗口创建，
    // 再把合法 URL 路由到内部 Browser tab 或系统浏览器。
    params.allowpopups = "true";

    if (!isAllowedEmbeddedBrowserUrl(targetUrl)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview url: ${targetUrl}`);
      event.preventDefault();
      return;
    }

    pendingWebviewGuestKinds.push({
      kind: isCodingPlanWebview ? "codingPlan" : "browser",
      isRewards: isRewardsWebview,
    });
  });

  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    const guestKind = pendingWebviewGuestKinds.shift() ?? {
      kind: "browser" as const,
      isRewards: false,
    };
    if (guestKind.kind === "pluginSandbox") {
      getPluginSandboxHost()?.attachGuest({
        guest: guestWebContents,
        hostWebContents: win.webContents,
        sandboxId: guestKind.sandboxId,
      });
      return;
    }
    attachEmbeddedBrowserWindowOpenHandler({
      guestWebContents,
      hostWebContents: win.webContents,
      resolveBrowserViewOwner: options.resolveBrowserViewOwner,
      // PayPal/relay 的 30x 重定向不保证逐跳触发 will-navigate。
      // Coding Plan guest 身份必须按初始 src 粘住，不能由当前 URL 解防护。
      isCodingPlanGuest: guestKind.kind === "codingPlan",
      isRewardsGuest: guestKind.isRewards,
      logger: options.logger,
    });
    // 蓝牙设备选择事件挂在 guest WebContents 上（Session 只覆盖 hid/usb/serial）；
    // 仅内置浏览器 guest 安装守卫，阻断 Electron 未监听时静默授权第一个设备的默认行为。
    if (guestKind.kind === "browser") {
      installEmbeddedBrowserBluetoothDeviceGuard(guestWebContents, options.logger.warn, {
        devicePicker: getEmbeddedBrowserDevicePicker(),
        hostWebContentsId: win.webContents.id,
      });
    }
  });

  win.webContents.on("context-menu", (_event, params) => {
    // 只设置 Electron role 时，菜单文案跟随系统/Electron 语言，可能与应用语言不一致。
    // 每次右键时读取当前 locale 并显式设置 label，切换语言后下一次打开即可生效。
    const template = buildTextContextMenuTemplate(
      params,
      options.currentApplicationLocale?.() ?? DEFAULT_LOCALE,
    );

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) {
      return;
    }

    // 之前为避免和终端等 DOM 右键菜单双弹，生产环境完全不弹 Electron 原生菜单；
    // 但普通文本选区和输入框没有 DOM 菜单，导致右键复制/粘贴像被禁用。这里仅在文本编辑语义下补原生菜单。
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  void Promise.resolve(loadWindow(win, "index", options.bootstrap)).catch((error: unknown) => {
    // loadFile/loadURL 返回的导航 Promise 过去被丢弃，长跑中的导航失败
    // 只会表现为 chrome-error 页面，主进程日志没有原始异常可供追踪。
    options.logger.warn("[desktop-window] renderer navigation rejected", error);
  });
  return win;
}

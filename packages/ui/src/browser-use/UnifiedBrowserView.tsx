/* oxlint-disable eslint(max-lines) -- UnifiedBrowserView 集中维护稳定 webview 的导航、事件和 guest 生命周期；横向滚动链已下沉独立 hook。 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { browserPreviewSourceUrl, EmbeddedBrowserWebviewChannels } from "@zcode/shared";
import { requestSidePaneFullView, useSidePaneFullViewActive } from "@/side-pane-full-view/index.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWebElementPicker } from "@/hooks/useWebElementPicker.js";
import type { WebElementRect } from "@/lib/webElementContext.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BrowserSiteSettingsEntry } from "@/browser-use/BrowserSiteSettingsEntry.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { useBrowserPageExport } from "@/browser-use/useBrowserPageExport.js";
import { captureBrowserElementScreenshot } from "@/browser-use/browserElementScreenshot.js";
import { BrowserDesignInspector } from "@/browser-use/BrowserDesignInspector.js";
import { BrowserDesignToolbar } from "@/browser-use/BrowserDesignToolbar.js";
import { useBrowserDesignMode } from "@/browser-use/useBrowserDesignMode.js";
import { useBrowserFileLiveReload } from "@/browser-use/useBrowserFileLiveReload.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { EmbeddedBrowserPermissionPrompts } from "@/browser-use/EmbeddedBrowserPermissionPrompts.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { BrowserViewportToolbar } from "@/browser-use/BrowserViewportToolbar.js";
import { useBrowserResizeOperationWarning } from "@/browser-use/useBrowserResizeOperationWarning.js";
import { useBrowserScreenshotSurfaceReady } from "@/browser-use/useBrowserScreenshotSurfaceReady.js";
import { useEmbeddedBrowserWheelChain } from "@/browser-use/useEmbeddedBrowserWheelChain.js";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { useResponsiveBrowserViewportControl } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import {
  getBrowserVisitScopeKey,
  isTrackableBrowserVisitUrl,
  recordBrowserVisit,
  removeBrowserRecentVisit,
  updateBrowserVisitMetadata,
  useBrowserRecentVisits,
} from "@/store/browserRecentVisitsStore.js";
import {
  DEFAULT_BROWSER_URL,
  INITIAL_BROWSER_STATE,
  displayBrowserUrl,
  isDefaultBrowserOpenableUrl,
  isRecoverableBrowserGuestExitReason,
  normalizeBrowserUrl,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

type PendingGuestNavigationCompletion = {
  resolve: () => void;
  url: string;
};

/**
 * UnifiedBrowserView —— 统一浏览器视图（`<webview>` + CDP-on-guest 架构）。
 *
 * 网页像素由 renderer 内的 `<webview>` guest 直接渲染（DOM 内合成，可被 DOM 浮层覆盖，
 * 彻底解决 WebContentsView 原生层遮挡菜单的问题）。human 导航经过 main 的本地文件准入，
 * 前进后退/刷新/元素拾取直接调用 webview 方法；chrome 状态由 webview 事件驱动。
 *
 * 同时在 did-attach 时把 guest 的 webContentsId 上报给 main（browserViewAttachGuest），
 * 让 main 能给该 guest 挂 CDP（webContents.debugger），供 agent 通过协议控制这个 tab。
 *
 * chrome 复用 EmbeddedBrowserPaneParts 的 BrowserToolbar；
 * URL 归一化 / 未挂载兜底复用 embeddedBrowserHelpers。
 */
export function UnifiedBrowserView({
  browserKey,
  onOpenPermissionSettings,
  isResidencyRestore = false,
  isVisible,
  isSelected = isVisible,
  isCurrentTask = isSelected,
  initialUrl,
  faviconUrl,
  navigationRequest,
  automaticRestoreUrl,
  onUrlChange,
  onPageMetadataChange,
  onNavigationRequestHandled,
  workspacePath,
  workspaceIdentity,
  workspaceKey,
  remoteSessionId,
  sessionId,
  residencyGeneration,
  browserUseOperationUntil,
  browserResizeBaselineVersion,
  screenshotSurfaceRequest,
  deferEmptyGuest = false,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
}: {
  /** 受控视图 key（= tab.id / sessionId，agent 定位该 tab 用）。 */
  browserKey: string;
  /** 地址栏站点设置入口：打开该站点的权限设置标签页。 */
  onOpenPermissionSettings?: (origin: string) => void;
  /** 预算恢复时 guest 创建后立即撤销 bootstrap src，首次有效导航由 main 独占。 */
  isResidencyRestore?: boolean;
  /** pane 是否可见（激活 + 展开）。隐藏时仅从布局里移除，不卸载 webview，保住网页与历史。 */
  isVisible: boolean;
  /** tab strip 选中态与 panel 展示态正交；折叠时仍保留 selected。 */
  isSelected?: boolean;
  /** 当前 task 的 tab 用于 main 的 eviction tier。 */
  isCurrentTask?: boolean;
  /** 挂载时导航到的初始/恢复 URL（human tab 恢复态）。 */
  initialUrl?: string | null;
  /** tab shell 当前 favicon；随 residency report 持久化。 */
  faviconUrl?: string | null;
  /** 外部请求把该 tab 导航到某 URL（{id,url}）；消费后回执 onNavigationRequestHandled。 */
  navigationRequest?: { id: string; url: string } | null;
  /** main 驱动的自动恢复 URL；仅匹配其提交时跳过访问排序。 */
  automaticRestoreUrl?: string | null;
  /** 当前 URL 变化回传（human tab URL 持久化）。 */
  onUrlChange?: (url: string) => void;
  /** 页面标题/favicon 变化回传（驱动 tab 标签）。 */
  onPageMetadataChange?: (metadata: { title?: string; faviconUrl?: string | null }) => void;
  /** navigationRequest 消费完回执。 */
  onNavigationRequestHandled?: (requestId: string) => void;
  /** 元素选择加入聊天所需的工作区路径（human 分支传入；agent 分支可不传）。 */
  workspacePath?: string;
  /** 元素选择上下文归属的工作区标识（human 分支传入）。 */
  workspaceIdentity?: string;
  /** browser-use tab 创建时冻结的身份 scope；存在时优先于当前 workspace ambient props。 */
  workspaceKey?: string;
  remoteSessionId?: string;
  /** tab 创建时冻结的对话归属；不得用 dom-ready 到达时的 active task 回填。 */
  sessionId?: string;
  residencyGeneration?: number;
  /** 与 tab 鼠标图标共用的 operation deadline；仅 browser-use tab 传入。 */
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  /** 截图前临时保持后台 guest 的真实布局；不改变任何 active/focus 语义。 */
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  /** human 空白 tab 延迟创建 guest；agent/browser-use 必须保持创建期 attach。 */
  deferEmptyGuest?: boolean;
  /** 仅 human Browser surface 传入；Agent Browser Use 必须保持 undefined。 */
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  /** 只接收 human UI 主动变更；Agent viewport event 不得调用。 */
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
}): React.JSX.Element {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const desktopZoomFactor = useDesktopZoomFactor();
  const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
  const recentVisitsScopeKey = getBrowserVisitScopeKey({
    workspaceKey: effectiveWorkspaceKey ?? "",
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: sessionId ?? "",
  });
  const recentVisits = useBrowserRecentVisits(recentVisitsScopeKey);

  const [addressValue, setAddressValue] = useState("");
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE);
  const hasInitialNavigation = Boolean(initialUrl && initialUrl !== DEFAULT_BROWSER_URL);
  const [hasNavigated, setHasNavigated] = useState(hasInitialNavigation);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [webview, setWebview] = useState<ElectronWebviewTag | null>(null);
  // 权限气泡的 tab 归属过滤：attach/dom-ready 后读取 guest webContents id；
  // 读不到时保持 undefined（组件按「请求缺归属 id 则兜底渲染」处理）。
  const [permissionGuestWebContentsId, setPermissionGuestWebContentsId] = useState<
    number | undefined
  >(undefined);
  useEffect(() => {
    if (!webview || typeof webview.getWebContentsId !== "function") return;
    const id = safeWebviewCall(() => webview.getWebContentsId(), 0);
    setPermissionGuestWebContentsId(id > 0 ? id : undefined);
  }, [webview, browserState.isReady]);
  const [guestAttachRetryNonce, setGuestAttachRetryNonce] = useState(0);
  // 恢复失败不能留下“跳过下一个提交”的状态，否则会漏记用户的首次真实访问。
  // 崩溃恢复只抑制已提交页面的自动重载，不改变 residency restore 的消费时序。
  const restoreVisitUrlRef = useRef<string | null>(
    isResidencyRestore && automaticRestoreUrl && isTrackableBrowserVisitUrl(automaticRestoreUrl)
      ? automaticRestoreUrl
      : null,
  );
  useEffect(() => {
    if (!isResidencyRestore) restoreVisitUrlRef.current = null;
  }, [isResidencyRestore]);
  useBrowserScreenshotSurfaceReady({
    request: screenshotSurfaceRequest ?? null,
    webview,
  });
  const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
  const setGuestZoomFactor = useCallback((target: ElectronWebviewTag, targetZoomFactor: number) => {
    if (typeof target.setZoomFactor !== "function") return;
    safeWebviewCall(
      () => target.setZoomFactor(targetZoomFactor),
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的 zoom 同步", {
          error: error instanceof Error ? error.message : String(error),
          targetZoomFactor,
        });
      },
    );
  }, []);
  const normalizeResponsiveGuestZoom = useCallback(() => {
    if (webview) setGuestZoomFactor(webview, 1);
  }, [setGuestZoomFactor, webview]);
  const {
    browserRegionRef,
    notifyBrowserViewportResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  } = useBrowserResizeOperationWarning({
    browserKey,
    isVisible,
    operationUntil: browserUseOperationUntil,
    resizeBaselineVersion: browserResizeBaselineVersion,
  });
  const {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  } = useResponsiveBrowserViewportControl({
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange: prepareForAgentViewportChange,
    onViewportSynchronized: normalizeResponsiveGuestZoom,
    onViewportResize: notifyBrowserViewportResize,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    sessionId,
  });
  // MediaRecorder 录到的是 renderer 中实际合成的 WebView surface。若沿用用户的 Fit/50%
  // 预览，后续 canvas 只能把低分辨率源放大到目标尺寸。录制 lease 因此派生一份 100% surface，
  // 不修改用户的自由尺寸、缩放选择或持久状态；request 释放后 React 会自然恢复原预览。
  const forceUnscaledSurface = screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // 普通后台 tab 的 fallback viewport 可能大于窗口；仅传 Fit 不会启用布局，
  // webview 随准备层缩小后永远无法 ready。截图期间统一派生请求尺寸的 responsive 布局，
  // release 后恢复用户模式与尺寸，不写偏好，也不重建 guest。
  const effectiveIsResponsiveMode = isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize = screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // 普通截图只临时改变布局；fallback metrics 的 guest zoom 由 main 管理。
  // 若把临时 Fit 当作用户模式切换，release 会错误恢复 desktop zoom，破坏后续 CDP 坐标。
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // 固定 100%/200% 预览不会随截图画布缩小，Windows 高 DPI 的 guest raster
  // 仍可能被宿主可见范围裁剪。普通截图临时 Fit，释放后恢复用户比例；录制保持 unscaled。
  const effectiveViewportZoom = forceUnscaledSurface
    ? "100"
    : screenshotSurfaceRequest
      ? "fit"
      : responsiveViewportZoom;
  useEmbeddedBrowserWheelChain({
    browserRegionRef,
    isResponsiveMode: effectiveIsResponsiveMode,
    webview,
  });

  // dom-ready 前排队的导航 URL；webview 就绪后统一 loadURL（<webview> 的 src 只在首挂生效）。
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // 已消费的 initialUrl / navigationRequest，避免重复导航。
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  // 只记录主框架已提交的 URL。附件 URL 会开始下载但不提交页面，曾在导航前被写入恢复状态，
  // 每次 rebind / 重新挂载都会再下载一次。
  const lastRestorableUrlRef = useRef<string | null>(null);
  const guestRecoveryInProgressRef = useRef(false);
  // 失败 guest 接到外部导航时，回执必须等替代 guest 实际接管 loadURL 后再完成。
  const pendingGuestNavigationCompletionRef = useRef<PendingGuestNavigationCompletion | null>(null);
  // guestId 上报去重：did-attach 与 dom-ready 会连续触发；只有 guest 或 active 状态变化才重报。
  const lastReportedGuestRef = useRef<{
    active: boolean;
    webContentsId: number;
    scopeFingerprint: string;
  } | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // guest 销毁归因打点：线上主进程 UAF（EXC_BAD_ACCESS at
  // 0x10，DevToolsSession 在途通知访问已析构 client）发生前，main 日志只能看到
  // 「cdp still attached on destroyed guest」，无法区分 webview 节点是被谁卸载的：
  // residency 挂起换壳 / 父级整树卸载 / shouldMountWebview 条件翻转 / generation 换代。
  // ref(null) 是 React 卸载 <webview> 节点的第一现场；配合组件卸载打点与挂起壳 ack 日志，
  // 可把销毁者与时序钉死。仅在 webview 实际存在过后才打，量级与 tab 生命周期一致。
  const webviewTeardownProbeRef = useRef({
    browserKey: "",
    generation: 0,
    hasNavigated: hasInitialNavigation,
    hadWebview: false,
  });
  webviewTeardownProbeRef.current.browserKey = browserKey;
  webviewTeardownProbeRef.current.generation = webviewGeneration;
  webviewTeardownProbeRef.current.hasNavigated = hasNavigated;
  const logWebviewTeardown = useCallback((trigger: string) => {
    const probe = webviewTeardownProbeRef.current;
    logger.info("[browser-use] webview 节点离开 DOM（guest 将被销毁）", {
      browserKey: probe.browserKey,
      generation: probe.generation,
      guestReported: lastReportedGuestRef.current,
      hasNavigated: probe.hasNavigated,
      trigger,
    });
  }, []);
  const onPageMetadataChangeRef = useRef(onPageMetadataChange);
  onPageMetadataChangeRef.current = onPageMetadataChange;
  const activeCommittedUrlRef = useRef(DEFAULT_BROWSER_URL);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  const completePendingGuestNavigation = useCallback(
    (completion?: PendingGuestNavigationCompletion | null) => {
      const pendingCompletion =
        completion === undefined ? pendingGuestNavigationCompletionRef.current : completion;
      if (!pendingCompletion || pendingGuestNavigationCompletionRef.current !== pendingCompletion) {
        return;
      }
      pendingGuestNavigationCompletionRef.current = null;
      pendingCompletion.resolve();
    },
    [],
  );

  const waitForGuestNavigationTakeover = useCallback((url: string) => {
    // 同一个 view 同时只保留一个外部导航意图；若未来入口允许并发，新请求明确取代旧请求，
    // 先结束旧回执，避免被覆盖的 Promise 永久悬空。
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // view 被关闭时属于明确取消，不能让上层 navigationRequest 永久等待。
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // 组件卸载意味着 <webview> 必然离开 DOM：residency 挂起换壳 / 父级面板关闭 /
      // 会话切换整树重挂。与 ref-null 打点的时间差可用于区分「换代重建」与「真卸载」。
      if (webviewTeardownProbeRef.current.hadWebview || lastReportedGuestRef.current) {
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("component-unmount");
      }
    },
    [logWebviewTeardown],
  );

  const reportBrowserGuest = useCallback(
    (active: boolean) => {
      if (!webview) return;
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = safeWebviewCall(() => webview.getWebContentsId(), 0);
      if (webContentsId <= 0) return;
      const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
      const scopeFingerprint = JSON.stringify({
        active,
        webContentsId,
        workspaceKey: effectiveWorkspaceKey ?? "",
        remoteSessionId: remoteSessionId ?? "",
        sessionId: sessionId ?? "",
        residencyGeneration: residencyGeneration ?? null,
      });
      const lastReported = lastReportedGuestRef.current;
      if (lastReported?.scopeFingerprint === scopeFingerprint) {
        return;
      }
      lastReportedGuestRef.current = { active, webContentsId, scopeFingerprint };
      const attachRequest = platform.browserViewAttachGuest?.({
        key: browserKey,
        webContentsId,
        active,
        ...(effectiveWorkspaceKey ? { workspaceKey: effectiveWorkspaceKey } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      });
      if (!attachRequest) return;
      void attachRequest
        .then((result) => {
          // 旧 preload 仍可能只返回 undefined；成功 attach 的兼容语义保持不变。
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn("[browser-use] main 拒绝 guest attach，等待按 owner scope 重绑", {
            browserKey,
            reason: result.reason,
            recoveryRequested: result.recoveryRequested,
          });
          // main 会重放 BrowserViewReady；清掉去重标记，确保同一个 webContentsId 也能重新上报。
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] 上报 guest webContentsId 失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      browserKey,
      platform,
      remoteSessionId,
      residencyGeneration,
      sessionId,
      synchronizeInitialHumanViewport,
      webview,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const detachBrowserGuestBeforeReplacement = useCallback(async (): Promise<boolean> => {
    const lastReported = lastReportedGuestRef.current;
    // guest 尚未上报给 main 时就没有 native CDP session，Web 端也不会暴露该桌面能力。
    if (!lastReported || !platform.browserViewDetachGuest) return true;
    try {
      const detached = await platform.browserViewDetachGuest({
        key: browserKey,
        webContentsId: lastReported.webContentsId,
      });
      if (!detached) {
        logger.warn("[browser-use] main 未确认旧 guest CDP 已断开，取消 webview 重建", {
          browserKey,
          webContentsId: lastReported.webContentsId,
        });
      }
      return detached;
    } catch (error) {
      logger.warn("[browser-use] 请求 main 断开旧 guest CDP 失败，取消 webview 重建", {
        browserKey,
        error: error instanceof Error ? error.message : String(error),
        webContentsId: lastReported.webContentsId,
      });
      return false;
    }
  }, [browserKey, platform]);

  // 按元素 rect 由 main 取帧裁剪，给点选进输入框的元素 token 用（截图随消息发出、不占附件行）。宿主不支持取帧（Web 端）时只带文字。
  const captureGuestPage = platform.captureBrowserGuestPage;
  const captureElement = useMemo(
    () =>
      captureGuestPage
        ? (rect: WebElementRect) =>
            webview
              ? captureBrowserElementScreenshot({ captureGuestPage, rect, webview })
              : Promise.resolve(null)
        : undefined,
    [captureGuestPage, webview],
  );
  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // 传输无关出口：webview 就绪时走 <webview>.executeJavaScript(script, true)；
    // 尚为 null 时返回 cancelled（合法选择结果），保持 no-op。
    executeJs: (script) =>
      webview ? webview.executeJavaScript(script, true) : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });
  // 人类 tab 的「选择元素」就是设计模式的点选；Agent tab 仍用元素 chip 选择器，两者不同时拦截页面点击。
  const cancelPickingForDesign = useCallback(() => {
    void cancelWebElementPicking();
  }, [cancelWebElementPicking]);
  const isHumanBrowser = onHumanViewportPreferenceChange !== undefined;
  // file:// 指向本机磁盘，自动刷新与设计工具写回一律走本机 base host，与当前 workspace 是否远端无关。
  const { fileService: localFileService, fileWatcherService: localFileWatcherService } =
    useBaseWorkspaceServices();
  const designChipTarget = useMemo(
    () =>
      isHumanBrowser && workspacePath
        ? {
            workspacePath,
            ...((workspaceKey ?? workspaceIdentity)
              ? { workspaceIdentity: workspaceKey ?? workspaceIdentity }
              : {}),
          }
        : null,
    [isHumanBrowser, workspaceIdentity, workspaceKey, workspacePath],
  );
  const design = useBrowserDesignMode({
    captureElement,
    chipTarget: designChipTarget,
    currentUrl: browserState.currentUrl,
    fileService: localFileService,
    onSelectModeStart: cancelPickingForDesign,
    isVisible,
    probeEnabled: isHumanBrowser,
    remoteSessionId,
    workspaceIdentity,
    webview,
    webviewGeneration,
  });

  // ---- 从 webview 同步 chrome 状态（url/前进后退/标题）----
  const syncBrowserState = useCallback(
    (target: ElectronWebviewTag) => {
      // guest 在 dom-ready 前 / 导航 churn / 重附过程中未 attach，同步方法会抛
      // "must be attached to the DOM"，统一走 safeWebviewCall 兜底，避免冒泡到 window.onerror。
      const onDetached = (error: unknown) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的状态同步", {
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const currentUrl =
        safeWebviewCall(() => target.getURL(), "", onDetached) || DEFAULT_BROWSER_URL;
      const canGoBack = safeWebviewCall(() => target.canGoBack(), false, onDetached);
      const canGoForward = safeWebviewCall(() => target.canGoForward(), false, onDetached);
      const title = safeWebviewCall(() => target.getTitle(), "", onDetached);
      if (currentUrl !== DEFAULT_BROWSER_URL) {
        lastRestorableUrlRef.current = currentUrl;
      }
      setBrowserState((prev) => ({
        ...prev,
        canGoBack,
        canGoForward,
        currentUrl,
        isReady: true,
        title,
      }));
      onPageMetadataChangeRef.current?.({ title: title || undefined });
      updateBrowserVisitMetadata(recentVisitsScopeKey, currentUrl, {
        title,
        faviconUrl: null,
      });
      // 页面 url 不可信：仅用于展示与 tab 持久化，不参与任何执行路径。
      if (currentUrl !== DEFAULT_BROWSER_URL) {
        onUrlChangeRef.current?.(currentUrl);
      }
    },
    [recentVisitsScopeKey],
  );

  const downloadNavigationRef = useRef({ urls: new Set<string>(), failedUrl: "" });

  // 一次导航结束后恢复 URL 跟随已提交的 URL：下载响应、ERR_ABORTED、ERR_FAILED 都不提交页面，
  // 回落后 initialUrl / 恢复 URL 不再指向附件，重新挂载时不会再次下载。
  const settleRestorableUrl = useCallback((target: ElectronWebviewTag) => {
    const committedUrl = safeWebviewCall(() => target.getURL(), "") || DEFAULT_BROWSER_URL;
    lastRestorableUrlRef.current = committedUrl === DEFAULT_BROWSER_URL ? null : committedUrl;
    onUrlChangeRef.current?.(committedUrl);
    const { urls, failedUrl } = downloadNavigationRef.current;
    if (urls.has(failedUrl)) {
      // 下载不会提交页面；移除普通状态回填后，必须在确认下载时显式恢复地址。
      // 通知可能晚于拒绝到达，只替换原下载地址，不能覆盖后续草稿或新导航。
      setAddressValue((value) =>
        value === displayBrowserUrl(failedUrl) ? displayBrowserUrl(committedUrl) : value,
      );
    }
  }, []);

  const isDownloadNavigationFailure = useCallback((url: string, message: string) => {
    if (!message.includes("ERR_FAILED")) return false;
    downloadNavigationRef.current.failedUrl = url;
    return downloadNavigationRef.current.urls.has(url);
  }, []);

  const loadBrowserUrl = useCallback(
    async (target: ElectronWebviewTag, url: string) => {
      // file 的额外读取权限必须在 main/session 边界收敛，不能只检查首次 attach 的 src。
      if (!platform.browserViewLoadUrl) throw new Error("Browser navigation is unavailable");
      await platform.browserViewLoadUrl({ webContentsId: target.getWebContentsId(), url });
    },
    [platform],
  );

  // ---- webview 事件接线 + did-attach 上报 guestId ----
  useEffect(() => {
    if (!webview) return;

    const stopDownloadSubscription = platform.onBrowserViewDownloadStarted?.((payload) => {
      if (safeWebviewCall(() => webview.getWebContentsId(), -1) !== payload.webContentsId) return;
      const navigation = downloadNavigationRef.current;
      payload.urls.forEach((url) => navigation.urls.add(url));
      // will-download 与 loadURL 拒绝可先后到达；晚到时收敛同 URL 的下载错误与地址。
      if (navigation.urls.has(navigation.failedUrl)) {
        settleRestorableUrl(webview);
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: null,
          loadErrorCode: null,
          isLoading: false,
        }));
      }
    });
    const handleDidAttach = () => {
      // navigationHistory.restore 只能用于从未加载过页面的新 guest。若等到
      // dom-ready 才上报，默认 about:blank 已提交，只能退化为 URL 重载；attach 后立即上报，
      // 让 main 有机会在首次导航提交前恢复完整 Chromium pageState。
      if (isResidencyRestore) {
        // `<webview>` 必须先有 src 才会创建 guest，但保留属性会在 attach 后再次提交
        // about:blank 并中断 main 的 history restore。guest 已存在后立刻撤销 bootstrap src。
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    const handleDomReady = () => {
      // Electron/Chromium 会把主窗口页面 zoom 继续传播到 guest；仅补偿外层
      // transform 时，guest innerWidth/DPR 仍会变化。自由尺寸必须把 guest zoom 固定为 1，
      // 普通模式仍交给 Electron 自然传播，避免主动改写网页 zoom。
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach 是完整历史恢复的最早时机；dom-ready 保留为 Electron 版本兼容兜底。
      reportBrowserGuest(isSelected);

      // <webview> 的 src 属性只在首挂生效，后续导航统一走命令式 loadURL：消费排队 URL。
      const pending = pendingUrlRef.current;
      if (pending) {
        const pendingCompletion = pendingGuestNavigationCompletionRef.current;
        pendingUrlRef.current = null;
        setBrowserState((prev) => ({ ...prev, isReady: true }));
        void (async () => {
          try {
            await loadBrowserUrl(webview, pending);
          } catch (loadError: unknown) {
            const message = loadError instanceof Error ? loadError.message : String(loadError);
            if (
              !message.includes("ERR_ABORTED") &&
              !isDownloadNavigationFailure(pending, message)
            ) {
              setBrowserState((prev) => ({
                ...prev,
                errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
                isLoading: false,
              }));
            }
          } finally {
            settleRestorableUrl(webview);
            // 只把外部请求写入 pendingUrl 后就回执是不够的：失败 guest 永远不会消费它。
            // 替代 guest 到达 dom-ready 并完成一次 loadURL 尝试，才算真正接管该导航意图。
            completePendingGuestNavigation(pendingCompletion);
          }
        })();
        return;
      }
      guestRecoveryInProgressRef.current = false;
      syncBrowserState(webview);
    };

    const handleDidStartLoading = () => {
      downloadNavigationRef.current = { urls: new Set(), failedUrl: "" };
      void cancelWebElementPicking();
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
        isLoading: true,
      }));
    };

    const handleDidStopLoading = () => {
      guestRecoveryInProgressRef.current = false;
      setBrowserState((prev) => ({ ...prev, isLoading: false }));
      syncBrowserState(webview);
    };

    const handleNavigation = (event: ElectronWebviewNavigationEvent) => {
      const isMainFrame = event.type === "did-navigate" || event.isMainFrame === true;
      if (isMainFrame) {
        // 首次 guest 的 about:blank 提交早于排队 URL，普通加载结束也会读到旧地址。
        // 地址栏只随主框架导航提交更新，并跳过仍有待导航 URL 的初始化空白页。
        if (event.url !== DEFAULT_BROWSER_URL || !pendingUrlRef.current) {
          setAddressValue(displayBrowserUrl(event.url));
        }
        activeCommittedUrlRef.current = event.url;
        if (isTrackableBrowserVisitUrl(event.url)) {
          // 恢复抑制只覆盖首个可记录的主框架提交；重定向提交也会结束本次恢复生命周期，
          // 避免旧恢复 URL 在后续页面链接、历史或 Agent 导航中吞掉真实访问。
          const isAutomaticRestoreCommit = restoreVisitUrlRef.current === event.url;
          restoreVisitUrlRef.current = null;
          if (!isAutomaticRestoreCommit) {
            recordBrowserVisit(recentVisitsScopeKey, {
              url: event.url,
              title: "",
              faviconUrl: null,
              lastVisitedAt: Date.now(),
            });
          }
        }
      }
      syncBrowserState(webview);
    };

    const handleTitleUpdated = (event: ElectronWebviewTitleEvent) => {
      setBrowserState((prev) => ({ ...prev, title: event.title }));
      onPageMetadataChangeRef.current?.({ title: event.title || undefined });
      updateBrowserVisitMetadata(recentVisitsScopeKey, activeCommittedUrlRef.current, {
        title: event.title,
        faviconUrl: null,
      });
    };

    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      // 忽略子帧、-3(ERR_ABORTED，被后续导航打断)与下载失败。
      if (!event.isMainFrame) return;
      if (restoreVisitUrlRef.current === event.validatedURL) restoreVisitUrlRef.current = null;
      if (event.errorCode === -3) return;
      if (event.errorCode === -2 && isDownloadNavigationFailure(event.validatedURL, "ERR_FAILED"))
        return;
      logger.warn("[browser-use] 页面加载失败", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        url: event.validatedURL,
      });
      // 失败的主框架导航没有提交，不能当成当前页 URL：它会被 residency 上报成恢复地址，
      // 附件 URL 因此每轮恢复都再下载一次。地址栏与错误态仍用 validatedURL。
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.loadFailed" },
          { message: event.errorDescription },
        ),
        loadErrorCode: event.errorCode,
        isLoading: false,
      }));
      setAddressValue(
        displayBrowserUrl(
          event.validatedURL || safeWebviewCall(() => webview.getURL(), "") || DEFAULT_BROWSER_URL,
        ),
      );
      guestRecoveryInProgressRef.current = false;
    };

    const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
      const { exitCode, reason } = event.details;
      if (!isRecoverableBrowserGuestExitReason(reason)) {
        logger.warn("[browser-use] guest renderer 异常退出且不可自动恢复", {
          browserKey,
          exitCode,
          reason,
        });
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: `renderer ${reason} (${exitCode})` },
          ),
          // renderer 退出后需要重建整个 guest，单纯重新导航无法恢复。
          // guestFailure 让界面优先展示重建入口，而不是普通页面加载错误的重试入口。
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // 替代 guest 若再次启动失败，已经形成明确失败结果；结束等待，让上层不再永久挂起请求。
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      restoreVisitUrlRef.current =
        recoveryUrl && isTrackableBrowserVisitUrl(recoveryUrl) ? recoveryUrl : null;
      void cancelWebElementPicking();

      logger.warn("[browser-use] guest renderer 异常退出，原位重建并恢复最近 URL", {
        browserKey,
        exitCode,
        reason,
        recoveryUrl,
      });
      void (async () => {
        const detached = await detachBrowserGuestBeforeReplacement();
        if (!detached) {
          guestRecoveryInProgressRef.current = false;
          restoreVisitUrlRef.current = null;
          setBrowserState((prev) => ({
            ...prev,
            errorMessage: null,
            loadErrorCode: null,
            guestFailure: { exitCode, reason },
            isLoading: false,
            isReady: false,
          }));
          completePendingGuestNavigation();
          return;
        }

        pendingUrlRef.current = recoveryUrl;
        lastRequestedUrlRef.current = null;
        lastAppliedInitialUrlRef.current = null;
        lastReportedGuestRef.current = null;
        setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
        setHasNavigated(Boolean(recoveryUrl));
        setBrowserState((prev) => ({
          ...prev,
          canGoBack: false,
          canGoForward: false,
          currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: null,
          isLoading: Boolean(recoveryUrl),
          isReady: false,
        }));
        // renderer 观察到了 guest 退出，但 main 的 render-process-gone 监听并非
        // 每次都先到达。必须等待上面的 CDP detach ACK 后再递增 key；否则 React 卸载旧
        // `<webview>` 会让 Electron DevToolsSession 在在途通知中访问已析构 client。
        setWebviewGeneration((current) => current + 1);
      })();
    };

    webview.addEventListener("did-attach", handleDidAttach);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      stopDownloadSubscription?.();
      webview.removeEventListener("did-attach", handleDidAttach);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
    };
  }, [
    browserKey,
    cancelWebElementPicking,
    completePendingGuestNavigation,
    detachBrowserGuestBeforeReplacement,
    intl,
    isResidencyRestore,
    isDownloadNavigationFailure,
    isSelected,
    platform,
    recentVisitsScopeKey,
    reportBrowserGuest,
    setGuestZoomFactor,
    settleRestorableUrl,
    syncBrowserState,
    loadBrowserUrl,
    webview,
  ]);

  useEffect(() => {
    if (!webview) return;
    const wasResponsiveMode = wasResponsiveModeRef.current;
    wasResponsiveModeRef.current = shouldNormalizeGuestZoom;

    if (shouldNormalizeGuestZoom) {
      setGuestZoomFactor(webview, 1);
    } else if (wasResponsiveMode) {
      // 只在退出自由尺寸时恢复当前应用 zoom；普通浏览期间继续沿用 Electron 原生传播。
      setGuestZoomFactor(webview, desktopZoomFactor);
    }
  }, [desktopZoomFactor, shouldNormalizeGuestZoom, setGuestZoomFactor, webview]);

  useEffect(() => {
    reportBrowserGuest(isSelected);
  }, [guestAttachRetryNonce, isSelected, reportBrowserGuest]);

  useEffect(() => {
    const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
    if (!effectiveWorkspaceKey || !sessionId) return;
    // 恢复 URL 只有 lastRestorableUrlRef 一个数据源（只在主框架提交后写入），
    // 不再回退到 currentUrl：后者可能被未提交的导航或失败态改写。
    const restoreUrl = lastRestorableUrlRef.current;
    void platform
      .browserViewReportResidency?.({
        tabId: browserKey,
        workspaceKey: effectiveWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        selected: isSelected,
        visible: isVisible,
        currentTask: isCurrentTask,
        loading: browserState.isLoading,
        restoreUrl,
        title: browserState.title || null,
        // favicon 不能只停留在 renderer tab state：residency 上报遗漏后，
        // 挂起与冷启动恢复得到的 shell 必然退回地球图标。
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] 上报 tab residency 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabId: browserKey,
        });
      });
  }, [
    browserKey,
    browserState.currentUrl,
    browserState.isLoading,
    browserState.title,
    faviconUrl,
    isCurrentTask,
    isSelected,
    isVisible,
    platform,
    remoteSessionId,
    sessionId,
    workspaceKey,
    workspaceIdentity,
    workspacePath,
  ]);

  const rebuildBrowserGuest = useCallback(
    async (
      recoveryUrl: string | null,
      trigger: "address-navigation" | "external-navigation" | "manual-retry",
    ): Promise<boolean> => {
      guestRecoveryInProgressRef.current = true;
      void cancelWebElementPicking();

      const detached = await detachBrowserGuestBeforeReplacement();
      if (!detached) {
        guestRecoveryInProgressRef.current = false;
        return false;
      }

      pendingUrlRef.current = recoveryUrl;
      lastRequestedUrlRef.current = null;
      lastAppliedInitialUrlRef.current = null;
      lastReportedGuestRef.current = null;

      logger.warn("[browser-use] 显式导航触发重建失败的 guest renderer", {
        browserKey,
        recoveryUrl,
        trigger,
      });
      setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
      setHasNavigated(Boolean(recoveryUrl));
      setBrowserState((prev) => ({
        ...prev,
        canGoBack: false,
        canGoForward: false,
        currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
        errorMessage: null,
        loadErrorCode: null,
        guestFailure: null,
        isLoading: Boolean(recoveryUrl),
        isReady: false,
      }));
      setWebviewGeneration((current) => current + 1);
      return true;
    },
    [browserKey, cancelWebElementPicking, detachBrowserGuestBeforeReplacement],
  );

  // ---- 导航（human 通过 main 准入；未就绪则排队到 dom-ready 消费）----
  const openUrl = useCallback(
    async (input: string, source: "toolbar" | "restore" | "request" = "toolbar") => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // 地址非法与上一次的网络失败无关；不清空会让错误态继续挂着旧的证书指引。
          loadErrorCode: null,
        }));
        return;
      }

      // 主动导航取代旧恢复意图，包括目标相同的重试；initialUrl 同步不代表用户动作。
      if (source !== "restore") restoreVisitUrlRef.current = null;
      // 外部请求若只能排队给尚未就绪的 guest，必须等 dom-ready 真正接管 loadURL 后再回执；
      // 地址栏/恢复导航没有上游消费确认，不需要等待该生命周期信号。
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // launch-failed 后 isReady=false，只把地址栏 URL 写进 pendingUrl 不够：
      // 失效 guest 永远不会再触发 dom-ready，失败态与排队导航都会永久卡住。
      if (browserState.guestFailure && (source === "toolbar" || source === "request")) {
        const rebuilt = await rebuildBrowserGuest(
          nextUrl,
          source === "request" ? "external-navigation" : "address-navigation",
        );
        if (!rebuilt) completePendingGuestNavigation();
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      // 去重：外部 request 与 restore 可能同拍给出同一 URL，连续 loadURL 会触发 ERR_ABORTED(-3)。
      if (
        nextUrl === lastRequestedUrlRef.current &&
        (pendingUrlRef.current === nextUrl || browserState.isLoading)
      ) {
        setAddressValue(displayBrowserUrl(nextUrl));
        setHasNavigated(true);
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      setAddressValue(displayBrowserUrl(nextUrl));
      setHasNavigated(true);
      setBrowserState((prev) => ({ ...prev, errorMessage: null, loadErrorCode: null }));
      lastRequestedUrlRef.current = nextUrl;

      if (!webview || !browserState.isReady) {
        pendingUrlRef.current = nextUrl;
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      try {
        await loadBrowserUrl(webview, nextUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ERR_ABORTED") || isDownloadNavigationFailure(nextUrl, message))
          return;
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
          isLoading: false,
        }));
      } finally {
        settleRestorableUrl(webview);
      }
    },
    [
      browserState.guestFailure,
      browserState.isLoading,
      browserState.isReady,
      completePendingGuestNavigation,
      intl,
      isDownloadNavigationFailure,
      rebuildBrowserGuest,
      loadBrowserUrl,
      settleRestorableUrl,
      waitForGuestNavigationTakeover,
      webview,
    ],
  );

  // ---- 挂载时导航到初始/恢复 URL（human tab 恢复态）----
  useEffect(() => {
    if (!initialUrl || initialUrl === DEFAULT_BROWSER_URL) return;
    if (lastAppliedInitialUrlRef.current === initialUrl) return;
    if (browserState.currentUrl === initialUrl) {
      lastAppliedInitialUrlRef.current = initialUrl;
      setHasNavigated(true);
      setAddressValue(displayBrowserUrl(initialUrl));
      return;
    }
    lastAppliedInitialUrlRef.current = initialUrl;
    void openUrl(initialUrl, "restore");
  }, [browserState.currentUrl, initialUrl, openUrl]);

  // ---- 外部导航请求（{id,url}）：导航并回执 ----
  useEffect(() => {
    if (!navigationRequest) return;
    if (lastHandledNavigationRequestIdRef.current === navigationRequest.id) return;
    lastHandledNavigationRequestIdRef.current = navigationRequest.id;
    void openUrl(navigationRequest.url, "request").finally(() => {
      onNavigationRequestHandled?.(navigationRequest.id);
    });
  }, [navigationRequest, onNavigationRequestHandled, openUrl]);

  // ---- 工具/导航按钮（isReady 门控 + safeWebviewCall 兜底点击瞬间 detach 竞态）----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的操作", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openUrl(addressValue);
    },
    [addressValue, openUrl],
  );

  const handleGoBack = useCallback(() => {
    if (!webview || !browserState.canGoBack) return;
    runWebviewAction(() => webview.goBack());
  }, [browserState.canGoBack, runWebviewAction, webview]);

  const handleGoForward = useCallback(() => {
    if (!webview || !browserState.canGoForward) return;
    runWebviewAction(() => webview.goForward());
  }, [browserState.canGoForward, runWebviewAction, webview]);

  const handleReload = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.reload());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenDevTools = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.openDevTools());
  }, [browserState.isReady, runWebviewAction, webview]);

  // 只给人类用户 tab 开：onHumanViewportPreferenceChange 只在人类主动打开的 tab 上传入。
  useBrowserFileLiveReload({
    currentUrl: browserState.currentUrl,
    enabled: onHumanViewportPreferenceChange !== undefined,
    fileService: localFileService,
    fileWatcherService: localFileWatcherService,
    isOwnWrite: design.isOwnSourceWrite,
    isVisible,
    webview,
  });

  const pageExport = useBrowserPageExport({
    currentUrl: browserState.currentUrl,
    isReady: browserState.isReady,
    webview,
  });

  const handleOpenExternal = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => {
      const currentUrl = browserPreviewSourceUrl(webview.getURL());
      // 安全边界：系统默认浏览器入口只允许 Web URL 和 file URL，仍禁止 about/data 等内联协议。
      if (!isDefaultBrowserOpenableUrl(currentUrl)) return;
      platform.openExternal(currentUrl);
    });
  }, [browserState.isReady, platform, runWebviewAction, webview]);

  const { stopSelecting: stopDesignSelecting, requestSelectMode: requestDesignSelectMode } = design;

  // 页面里按 Cmd/Ctrl + Z：guest preload 只认真实按键、且按键目标不是页面输入框时才发（页面脚本发不出这条），
  // 只在点选时撤销 / 重做写回（!3450 CR-01）；任何本机 HTML 点选时都可能写回过，不只设计稿
  const { undo: undoDesignWrite, redo: redoDesignWrite } = design;
  const designUndoActive = design.mode === "select";
  useEffect(() => {
    if (!webview || !designUndoActive) return;
    const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
      if (event.channel !== EmbeddedBrowserWebviewChannels.DesignUndoShortcut) return;
      const payload: unknown = event.args[0];
      const redo =
        typeof payload === "object" &&
        payload !== null &&
        "redo" in payload &&
        payload.redo === true;
      void (redo ? redoDesignWrite() : undoDesignWrite());
    };
    webview.addEventListener("ipc-message", handleIpcMessage);
    return () => webview.removeEventListener("ipc-message", handleIpcMessage);
  }, [designUndoActive, redoDesignWrite, undoDesignWrite, webview]);
  const isDesignToolsVisible = design.toolsVisible;
  // 调整面板：设计稿页面，或任何页面上正在点选（人类 tab 的「选择元素」统一成这套点选，11-06）
  const isDesignPanelAvailable = isDesignToolsVisible || design.mode !== "off";
  // 设计面板只在完整视图里出（11-05 反馈：半屏放不下原型 + 面板，不缩小原型）：
  // 半屏里面板要出来（选中了元素）就请求进完整视图；退出完整视图时面板收起。
  // 不支持完整视图（Web 端等）时请求会被忽略，面板照常盖在画布右侧。
  const fullViewActive = useSidePaneFullViewActive();
  const designPanelShown =
    isDesignPanelAvailable && design.panelOpen && design.selections.length > 0;
  const wasFullViewActiveRef = useRef(fullViewActive);
  const { setPanelOpen: setDesignPanelOpen } = design;
  useEffect(() => {
    const wasActive = wasFullViewActiveRef.current;
    wasFullViewActiveRef.current = fullViewActive;
    // 退出完整视图时 tab 可能不在前台：不管可不可见都收起面板，切回来才不会没选元素就又被拉进完整视图（!3450 需要确认）
    if (wasActive && !fullViewActive) {
      setDesignPanelOpen(false);
      return;
    }
    if (!isVisible || !isDesignPanelAvailable) return;
    if (designPanelShown && !fullViewActive) requestSidePaneFullView();
  }, [designPanelShown, fullViewActive, isDesignPanelAvailable, isVisible, setDesignPanelOpen]);

  // 人类 tab：地址栏「选择元素」在任何页面上都是同一套点选（再点一次或页面里 Esc 退出），取代原来的元素选择器（11-06）；
  // 能不能改由页面决定：本机 HTML 在调整面板里直接改，其他页面面板只读、交给 Agent。Agent tab 仍是元素 chip 选择器。
  const handleTogglePicker = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    if (isHumanBrowser) {
      void requestDesignSelectMode();
      return;
    }
    stopDesignSelecting();
    void toggleWebElementPicking().catch((error: unknown) => {
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.elementPickerFailed" },
          { message: error instanceof Error ? error.message : String(error) },
        ),
      }));
    });
  }, [
    browserState.isReady,
    intl,
    isHumanBrowser,
    requestDesignSelectMode,
    stopDesignSelecting,
    toggleWebElementPicking,
    webview,
  ]);

  const handleToggleResponsiveMode = useCallback(() => {
    toggleResponsiveMode();
  }, [toggleResponsiveMode]);

  const handleResponsiveViewportSizeChange = updateResponsiveViewportSize;

  const handleResponsiveViewportInput = useCallback(
    (viewportSize: typeof responsiveViewportSize) => {
      notifyBrowserViewportResize();
      updateResponsiveViewportSize(viewportSize);
    },
    [notifyBrowserViewportResize, updateResponsiveViewportSize],
  );

  const faviconListenerRef = useRef<{
    node: ElectronWebviewTag;
    listener: (event: ElectronWebviewFaviconEvent) => void;
  } | null>(null);
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      const current = faviconListenerRef.current;
      if (current?.node === node) return;
      if (current) {
        current.node.removeEventListener("page-favicon-updated", current.listener);
        faviconListenerRef.current = null;
      }
      if (node) {
        const listener = (event: ElectronWebviewFaviconEvent) => {
          onPageMetadataChangeRef.current?.({
            faviconUrl: event.favicons[0] ?? null,
          });
          updateBrowserVisitMetadata(recentVisitsScopeKey, activeCommittedUrlRef.current, {
            title: "",
            faviconUrl: event.favicons[0] ?? null,
          });
        };

        // favicon 是可能只触发一次的 guest 事件；等 useEffect 才接线时，
        // 它可能已在 webview ref 提交与 effect 执行之间发出。ref 阶段同步监听可封住该窗口。
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // generation 换代（受控重建）与父级卸载都会先走到这里；紧随其后若有新节点 ref
        // 回调则是换代，否则是整树/条件卸载。销毁归因打点见 webviewTeardownProbeRef 注释。
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("ref-null");
      }
      if (node) webviewTeardownProbeRef.current.hadWebview = true;
      setWebview(node);
    },
    [logWebviewTeardown],
  );

  const handleRetryGuest = useCallback(() => {
    void rebuildBrowserGuest(
      lastRestorableUrlRef.current ?? lastRequestedUrlRef.current,
      "manual-retry",
    );
  }, [rebuildBrowserGuest]);

  // 加载失败只是这次导航被拒，guest 本身还活着：重走 openUrl 即可，不必重建 guest。
  const handleRetryLoad = useCallback(() => {
    const retryUrl =
      lastRequestedUrlRef.current ?? lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl]);

  // 把 addressValue 草稿纳入空置态判断后，用户只要开始输入、尚未回车，
  // 就会提前隐藏空置态并裸露 webview。空置态只由已确认导航与加载/错误状态决定。
  const isEmptyBrowserState =
    !hasNavigated && !browserState.isLoading && !browserState.errorMessage;
  const shouldMountWebview =
    !deferEmptyGuest || isResidencyRestore || hasNavigated || hasInitialNavigation;
  const prevShouldMountWebviewRef = useRef(shouldMountWebview);
  useEffect(() => {
    const previous = prevShouldMountWebviewRef.current;
    prevShouldMountWebviewRef.current = shouldMountWebview;
    if (previous && !shouldMountWebview && webviewTeardownProbeRef.current.hadWebview) {
      logWebviewTeardown("should-mount-flip");
    }
  }, [logWebviewTeardown, shouldMountWebview]);

  let permissionOrigin: string | null = null;
  try {
    const url = new URL(browserState.currentUrl);
    if (["http:", "https:"].includes(url.protocol)) permissionOrigin = url.origin;
  } catch {
    /* 空白页没有站点权限。 */
  }

  // inactive 的 display:none 会让 Electron 保留旧 compositor surface，后台截图会按旧表面平铺。
  // prepare 期间的 flex 只用于合成；外层 inert、pointer-events-none 和 aria-hidden 隔离交互与 a11y。
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "relative h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        permissionControl={
          permissionOrigin ? (
            <BrowserSiteSettingsEntry
              origin={permissionOrigin}
              onOpenSettings={onOpenPermissionSettings}
            />
          ) : null
        }
        onOpenSiteSettings={
          permissionOrigin && onOpenPermissionSettings
            ? () => onOpenPermissionSettings(permissionOrigin)
            : undefined
        }
        formatMessage={intl.formatMessage}
        onAddressChange={setAddressValue}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenExternal={handleOpenExternal}
        onOpenDevTools={handleOpenDevTools}
        canExport={pageExport.canExport}
        isExporting={pageExport.isExporting}
        onExportPdf={pageExport.exportPdf}
        onExportPng={pageExport.exportPng}
        onPickElement={handleTogglePicker}
        onReload={handleReload}
        onToggleResponsiveMode={handleToggleResponsiveMode}
        onSubmit={handleSubmit}
        isElementPickerActive={isHumanBrowser ? design.mode === "select" : isWebElementPicking}
        isResponsiveMode={isResponsiveMode}
      />
      {/* 权限弹窗层：只在可见 tab 挂载（多 tab 共享 store，避免重复渲染与
          后台请求误显示）；permission 请求再按 guest 归属过滤到发起 tab。 */}
      {isVisible ? (
        <EmbeddedBrowserPermissionPrompts guestWebContentsId={permissionGuestWebContentsId} />
      ) : null}
      {isResponsiveMode && !isDesignToolsVisible ? (
        <BrowserViewportToolbar
          isVisible={isVisible}
          onViewportSizeChange={handleResponsiveViewportInput}
          onZoomChange={setResponsiveViewportZoom}
          viewportSize={responsiveViewportSize}
          zoom={responsiveViewportZoom}
        />
      ) : null}
      {isDesignToolsVisible ? (
        <BrowserDesignToolbar
          design={design}
          viewportControls={
            isResponsiveMode ? (
              <BrowserViewportToolbar
                embedded
                isVisible={isVisible}
                onViewportSizeChange={handleResponsiveViewportInput}
                onZoomChange={setResponsiveViewportZoom}
                viewportSize={responsiveViewportSize}
                zoom={responsiveViewportZoom}
              />
            ) : null
          }
        />
      ) : null}
      <div className="@container/browser-canvas relative flex min-h-0 flex-1">
        <BrowserViewportSurface
          browserRegionRef={browserRegionRef}
          browserState={browserState}
          desktopZoomFactor={desktopZoomFactor}
          isResidencyRestore={isResidencyRestore}
          formatMessage={intl.formatMessage}
          isEmptyBrowserState={isEmptyBrowserState}
          recentVisits={recentVisits}
          onOpenRecentVisit={(url) => void openUrl(url)}
          onRemoveRecentVisit={(url) => removeBrowserRecentVisit(recentVisitsScopeKey, url)}
          designCanvas={isDesignToolsVisible}
          designStage={isDesignToolsVisible && design.pageInfo?.stageBackdrop === true}
          isComposed={isVisible || shouldComposeSurface}
          isResponsiveMode={effectiveIsResponsiveMode}
          isViewportEmulated={
            effectiveIsResponsiveMode && screenshotSurfaceRequest?.viewportMode !== "natural"
          }
          onRetryGuest={handleRetryGuest}
          onRetryLoad={handleRetryLoad}
          onViewportResize={notifyBrowserViewportResize}
          onViewportSizeChange={handleResponsiveViewportSizeChange}
          onWebviewRef={handleWebviewRef}
          shouldMountWebview={shouldMountWebview}
          showResizeWarning={showResizeWarning}
          webviewGeneration={webviewGeneration}
          viewportSize={effectiveViewportSize}
          viewportZoom={effectiveViewportZoom}
        />
        {/* 调整面板悬浮在画布右上，不撑满一列（11-05 反馈） */}
        {isDesignPanelAvailable && design.panelOpen ? (
          <BrowserDesignInspector design={design} />
        ) : null}
      </div>
    </div>
  );
}

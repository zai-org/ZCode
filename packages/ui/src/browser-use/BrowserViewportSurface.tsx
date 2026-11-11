import { useCallback, type RefObject } from "react";
import { BROWSER_VIEW_RESTORE_BOOTSTRAP_URL, type BrowserViewportSize } from "@zcode/shared";
import { TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { TriangleAlertIcon } from "lucide-react";
import { ResponsiveBrowserViewport } from "@/browser-use/ResponsiveBrowserViewport.js";
import {
  resolveResponsiveBrowserGuestLayout,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import { cn } from "@/components/lib/utils.js";
import type { BrowserVisitRecord } from "@/store/browserRecentVisitsStore.js";
import {
  BrowserEmptyState,
  BrowserGuestFailureState,
  BrowserLoadErrorState,
} from "@/EmbeddedBrowserPaneParts.js";
import {
  DEFAULT_BROWSER_URL,
  isCertificateBrowserLoadErrorCode,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

export function BrowserViewportSurface({
  browserRegionRef,
  browserState,
  desktopZoomFactor,
  isResidencyRestore,
  formatMessage,
  isEmptyBrowserState,
  recentVisits = [],
  onOpenRecentVisit,
  onRemoveRecentVisit,
  designCanvas = false,
  designStage = false,
  isComposed,
  isResponsiveMode,
  isViewportEmulated = isResponsiveMode,
  onRetryGuest,
  onRetryLoad,
  onViewportResize,
  onViewportSizeChange,
  onWebviewRef,
  shouldMountWebview = true,
  showResizeWarning,
  webviewGeneration,
  viewportSize,
  viewportZoom,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  browserState: BrowserState;
  desktopZoomFactor: number;
  isResidencyRestore: boolean;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isEmptyBrowserState: boolean;
  recentVisits?: BrowserVisitRecord[];
  onOpenRecentVisit?: (url: string) => void;
  onRemoveRecentVisit?: (url: string) => void;
  /** 设计稿页面：深色点阵画布（自由尺寸下可见） */
  designCanvas?: boolean;
  /** 舞台式设计稿：页面整页底色已在预览里透明，去掉视口外框与 webview 白底，画板直接落在画布上 */
  designStage?: boolean;
  isComposed: boolean;
  isResponsiveMode: boolean;
  isViewportEmulated?: boolean;
  onRetryGuest: () => void;
  onRetryLoad: () => void;
  onViewportResize: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  onWebviewRef: (node: ElectronWebviewTag | null) => void;
  shouldMountWebview?: boolean;
  showResizeWarning: boolean;
  webviewGeneration: number;
  viewportSize: BrowserViewportSize;
  viewportZoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { guestFailure } = browserState;
  // guest 进程级失败优先于 load error：前者连画面都没有，后者只是这次导航被拒。
  const loadError = !guestFailure && browserState.errorMessage ? browserState.errorMessage : null;
  // 自然 viewport 没有 metrics 固定逻辑尺寸，临时 responsive frame 不代表 guest 可以扩张。
  const responsiveGuestLayout = resolveResponsiveBrowserGuestLayout(desktopZoomFactor);
  const responsiveGuestLayoutScale = isViewportEmulated ? responsiveGuestLayout.layoutScale : 1;
  const responsiveGuestTransformScale = isViewportEmulated
    ? responsiveGuestLayout.transformScale
    : 1;
  const needsResponsiveGuestLayout = isResponsiveMode && responsiveGuestLayoutScale !== 1;
  const responsiveGuestLayoutSize = `calc(100% * ${responsiveGuestLayoutScale})`;
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      onWebviewRef(node);
    },
    [onWebviewRef],
  );

  return (
    <div
      ref={browserRegionRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {showResizeWarning ? (
        <div
          role="status"
          aria-live="polite"
          data-browser-resize-warning="visible"
          className="pointer-events-none absolute top-2 right-2 left-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-xl border border-popover-border bg-popover px-3 py-2 text-ui-base font-medium text-foreground shadow-md"
        >
          <span
            aria-hidden="true"
            data-browser-resize-warning-accent="visible"
            className="h-5 w-0.5 shrink-0 rounded-full bg-warning"
          />
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <span>{formatMessage({ id: "browser.resizeDuringOperationWarning" })}</span>
        </div>
      ) : null}
      <ResponsiveBrowserViewport
        active={isResponsiveMode}
        designCanvas={designCanvas}
        designStage={designStage}
        desktopZoomFactor={desktopZoomFactor}
        isComposed={isComposed}
        onResize={onViewportResize}
        onViewportSizeChange={onViewportSizeChange}
        viewportSize={viewportSize}
        zoom={viewportZoom}
      >
        {guestFailure ? (
          <BrowserGuestFailureState
            formatMessage={formatMessage}
            guestFailure={guestFailure}
            onRetry={onRetryGuest}
          />
        ) : loadError ? (
          <BrowserLoadErrorState
            errorMessage={loadError}
            formatMessage={formatMessage}
            isCertificateError={isCertificateBrowserLoadErrorCode(browserState.loadErrorCode)}
            onRetry={onRetryLoad}
          />
        ) : isEmptyBrowserState ? (
          <BrowserEmptyState
            key="empty-state"
            browserState={browserState}
            formatMessage={formatMessage}
            isGuestStarting={shouldMountWebview && !browserState.isReady}
            visits={recentVisits}
            onOpenRecentVisit={onOpenRecentVisit}
            onRemoveRecentVisit={onRemoveRecentVisit}
          />
        ) : null}
        {/* 自由尺寸开关只改变稳定 frame 的 CSS 宽高，不能条件替换 webview 的父层级；
            否则 Electron guest 会被重建并丢失网页历史。空白页仍直接隐藏 webview，确保空置态可见。
            Electron 41 还要求 nodeintegrationinsubframes 随 guest 创建声明，供发生真实导航的子 frame 加载固定 preload。
            allowpopups 若等 ref 回调再 setAttribute，guest 已完成 attach，target=_blank 会在
            Chromium 权限边界被静默吞掉。必须让 React 在插入节点前输出字符串 attribute；类型断言只用于
            绕过 @types/react 把 Electron boolean attribute 建模为 boolean 所引发的 React DOM 告警。
            generation 只在 guest renderer 已异常退出时递增；普通切换/resize 必须继续复用原节点。
            新建 human tab 与 about:blank guest 同帧挂载时，Electron 的独立合成面
            可能先于宿主隐藏样式绘制白色首帧。因此只在确认导航后创建 human guest；
            已创建的 guest 仍保持稳定挂载。 */}
        {shouldMountWebview ? (
          <webview
            key={`webview:${webviewGeneration}`}
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            src={isResidencyRestore ? BROWSER_VIEW_RESTORE_BOOTSTRAP_URL : DEFAULT_BROWSER_URL}
            partition="persist:zcode-embedded-browser"
            nodeintegrationinsubframes="true"
            data-browser-compositor-scale={isResponsiveMode ? desktopZoomFactor : undefined}
            data-browser-layout-scale={isResponsiveMode ? responsiveGuestLayoutScale : undefined}
            data-browser-transform-scale={
              isResponsiveMode ? responsiveGuestTransformScale : undefined
            }
            data-testid={TID_BROWSER_WEBVIEW}
            data-browser-resize-dimmed={showResizeWarning ? "true" : undefined}
            className={cn(
              "browser-use-viewport h-full min-h-0 w-full",
              isEmptyBrowserState || guestFailure || loadError ? "hidden" : "inline-flex",
            )}
            // Electron 的 `<webview>` 独立 guest surface 按布局尺寸分配 raster：放大和缩小都先按
            // 1 / zoom 布局，再 transform 回 frame，guest 自然 viewport 即等于目标 viewport。
            // absolute 避免补偿布局污染 Fit 的 scroll extent。
            // 这里只改变宿主布局/合成；guest zoom、CSS viewport、DPR 与 Browser Use 回读保持不变。
            style={{
              // 网页画布默认按浏览器语义使用白色；这里只设置 webview 节点底色，
              // 不增加覆盖层，也不向 guest 页面注入或覆盖任何样式。
              // 舞台式设计稿例外：页面底色已透明，白底会重新垫出一块「页面」
              backgroundColor: designStage ? "transparent" : "#fff",
              // Electron guest surface 可能早于 Tailwind hidden 类完成首次合成，
              // 导致新 tab 闪一帧白色；创建期内联 visibility 可封住该时序窗口。
              ...(isEmptyBrowserState ? { visibility: "hidden" as const } : {}),
              ...(isResponsiveMode
                ? {
                    ...(needsResponsiveGuestLayout
                      ? {
                          height: responsiveGuestLayoutSize,
                          left: 0,
                          position: "absolute" as const,
                          top: 0,
                          width: responsiveGuestLayoutSize,
                        }
                      : {}),
                    ...(responsiveGuestTransformScale !== 1
                      ? {
                          transform: `scale(${responsiveGuestTransformScale})`,
                          transformOrigin: "top left",
                        }
                      : {}),
                  }
                : {}),
            }}
          />
        ) : null}
      </ResponsiveBrowserViewport>
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { type BrowserViewportSize } from "@zcode/shared";
import {
  TID_BROWSER_RESPONSIVE_SCALED_FRAME,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
} from "@zcode/shared/test-ids";
import {
  resolveBrowserViewportRendererScale,
  resolveBrowserViewportScale,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import {
  RESPONSIVE_BROWSER_VIEWPORT_LIMITS,
  ResponsiveBrowserResizeHandles,
  type ResizeDirection,
  type ResizeHandleDirections,
} from "@/browser-use/ResponsiveBrowserResizeHandles.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export const DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE = {
  width: 393,
  height: 852,
} as const;

interface ResizeDragState {
  captureTarget: HTMLDivElement;
  heightDirection: ResizeDirection;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSize: BrowserViewportSize;
  widthDirection: ResizeDirection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampViewportSize(size: BrowserViewportSize): BrowserViewportSize {
  return {
    width: clamp(
      size.width,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minWidth,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxWidth,
    ),
    height: clamp(
      size.height,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minHeight,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxHeight,
    ),
  };
}

/**
 * 保持同一层 DOM 包装，仅切换 frame 的 CSS 尺寸，避免开关自由尺寸时重建 Electron guest。
 * 尺寸只属于当前 Browser tab 的 React 实例，不写入跨端 store 或持久化状态。
 */
export function ResponsiveBrowserViewport({
  active,
  designCanvas = false,
  designStage = false,
  children,
  desktopZoomFactor,
  isComposed,
  onResize,
  onViewportSizeChange,
  viewportSize,
  zoom,
}: {
  active: boolean;
  /** 设计稿页面：画布是深色无限画布（点阵），让设计稿像放在画板上 */
  designCanvas?: boolean;
  /** 舞台式设计稿：视口不画外框，画板直接落在画布上（不再框套框） */
  designStage?: boolean;
  children: ReactNode;
  desktopZoomFactor: number;
  isComposed: boolean;
  onResize?: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewportSizeRef = useRef<BrowserViewportSize>(viewportSize);
  const rendererScaleRef = useRef(1);
  const dragRef = useRef<ResizeDragState | null>(null);
  const pendingViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const resizeAnimationFrameRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState<BrowserViewportSize | null>(null);
  const visualScale = active
    ? resolveBrowserViewportScale({ canvasSize, desktopZoomFactor, viewportSize, zoom })
    : 1;
  // Electron 的应用全局 zoom 会继续乘到自由尺寸 frame 的 CSS transform 上，
  // 导致 100%/固定比例与拖拽换算随应用一起变化。frame 使用倒数抵消父 zoom，
  // guest CSS viewport 仍由 width/height 单独控制，不把视觉补偿写回 Browser Use。
  const rendererScale = active
    ? resolveBrowserViewportRendererScale({ desktopZoomFactor, visualScale })
    : 1;
  rendererScaleRef.current = rendererScale;

  const applyViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      const nextSize = clampViewportSize(requestedSize);
      const previousSize = viewportSizeRef.current;
      if (previousSize.width === nextSize.width && previousSize.height === nextSize.height) {
        return;
      }
      viewportSizeRef.current = nextSize;
      onViewportSizeChange(nextSize);
      onResize?.();
    },
    [onResize, onViewportSizeChange],
  );

  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  const scheduleViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      pendingViewportSizeRef.current = clampViewportSize(requestedSize);
      if (resizeAnimationFrameRef.current !== 0) return;
      // pointermove 频率可能高于刷新率；每帧只提交最后一组尺寸，避免无效 React render。
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = 0;
        const pendingSize = pendingViewportSizeRef.current;
        pendingViewportSizeRef.current = null;
        if (pendingSize) applyViewportSize(pendingSize);
      });
    },
    [applyViewportSize],
  );

  const finishResize = useCallback(
    (reason: string, pointerId?: number, commitPendingSize = true) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
      dragRef.current = null;
      if (resizeAnimationFrameRef.current !== 0) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
        resizeAnimationFrameRef.current = 0;
      }
      const pendingSize = pendingViewportSizeRef.current;
      pendingViewportSizeRef.current = null;
      if (pendingSize && commitPendingSize) applyViewportSize(pendingSize);
      try {
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
          drag.captureTarget.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // capture 可能已被系统或浏览器撤销；状态已先清理，lostpointercapture 重入不会续拖。
      }
      logger.debug("[browser-use] 结束自由尺寸拖拽", {
        pointerId: drag.pointerId,
        reason,
      });
    },
    [applyViewportSize],
  );

  const beginResize = useCallback(
    (directions: ResizeHandleDirections, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      finishResize("pointer-replaced");
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 自动化合成事件可能没有活跃 pointer；同一节点上的 move 仍可验证尺寸逻辑。
      }
      dragRef.current = {
        ...directions,
        captureTarget: event.currentTarget,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSize: viewportSizeRef.current,
      };
    },
    [finishResize],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // mousemove 的 buttons 是浏览器对当前物理按键的事实来源；即使窗口 blur 被系统截图层吞掉，
      // 松开主键后的第一帧也必须终止旧手势，不能继续相信 pointerdown 时留下的 dragRef。
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        finishResize("mouse-button-released", event.pointerId);
        return;
      }
      event.preventDefault();
      // frame 使用 CSS transform 缩放后，pointer delta 是视觉像素；若直接累加，
      // 50%/200% 下同样的拖动距离会错误地产生相同 CSS viewport 变化。
      const scale = rendererScaleRef.current > 0 ? rendererScaleRef.current : 1;
      const widthDelta = (event.clientX - drag.startClientX) / scale;
      const heightDelta = (event.clientY - drag.startClientY) / scale;
      scheduleViewportSize({
        width: drag.startSize.width + widthDelta * drag.widthDirection,
        height: drag.startSize.height + heightDelta * drag.heightDirection,
      });
    },
    [finishResize, scheduleViewportSize],
  );

  const endResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishResize(event.type, event.pointerId);
    },
    [finishResize],
  );

  const handleResizeKeyDown = useCallback(
    (directions: ResizeHandleDirections, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      const currentSize = viewportSizeRef.current;
      if (
        directions.widthDirection !== 0 &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          width:
            currentSize.width +
            (event.key === "ArrowRight" ? step : -step) * directions.widthDirection,
        });
      }
      if (
        directions.heightDirection !== 0 &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          height:
            currentSize.height +
            (event.key === "ArrowDown" ? step : -step) * directions.heightDirection,
        });
      }
    },
    [applyViewportSize],
  );

  useLayoutEffect(() => {
    if (!active || !isComposed || zoom !== "fit") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasSize = (size: BrowserViewportSize) => {
      // inactive tab 的 display:none 会让 ResizeObserver 回报 0×0；若清掉最后有效画布，
      // 切回首帧 Fit 会先回退为 1，下一帧才缩小。
      // 非正尺寸不具备布局权威；重新 composed 时由 layout effect 在首绘前重测。
      if (size.width <= 0 || size.height <= 0) return;
      setCanvasSize((previous) =>
        previous?.width === size.width && previous.height === size.height ? previous : size,
      );
    };
    const rect = canvas.getBoundingClientRect();
    updateCanvasSize({ width: rect.width, height: rect.height });
    logger.debug("[browser-use] 重测自由尺寸 Fit 画布", {
      desktopZoomFactor,
      height: rect.height,
      width: rect.width,
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCanvasSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, desktopZoomFactor, isComposed, zoom]);

  useEffect(() => {
    if (!active) {
      finishResize("mode-inactive", undefined, false);
      return;
    }
    // 系统截图、应用切换等会让窗口在 pointerup 前失焦，原 handle
    // 收不到结束事件，pointer capture 与 dragRef 因而残留；重新聚焦后的普通移动会继续 resize。
    const handleWindowBlur = () => finishResize("window-blur");
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      finishResize("mode-exit", undefined, false);
    };
  }, [active, finishResize]);

  return (
    <div
      ref={canvasRef}
      className={cn(
        "h-full min-h-0 w-full min-w-0",
        active
          ? designCanvas
            ? // 纯黑不透气：深色底 + 一层浅色点阵（11-05 反馈）
              "overflow-auto bg-neutral-950 [background-image:radial-gradient(color-mix(in_oklab,var(--color-white)_16%,transparent)_1px,transparent_1px)] [background-size:16px_16px]"
            : "overflow-auto bg-background-alt"
          : "overflow-hidden bg-background",
      )}
      data-responsive-browser-mode={active ? "active" : "inactive"}
    >
      <div
        className={cn(
          active
            ? "flex min-h-full w-max min-w-full items-center justify-center p-4"
            : "h-full w-full",
        )}
      >
        <div
          className={cn(
            "relative shrink-0",
            active ? !designStage && "bg-card shadow-sm ring-1 ring-border" : "h-full w-full",
          )}
          data-testid={TID_BROWSER_RESPONSIVE_SCALED_FRAME}
          style={
            active
              ? {
                  height: `${viewportSize.height * rendererScale}px`,
                  width: `${viewportSize.width * rendererScale}px`,
                }
              : undefined
          }
        >
          <div
            aria-label={intl.formatMessage({ id: "browser.responsive.viewport" })}
            className={cn("relative", active ? "shrink-0" : "h-full w-full")}
            data-responsive-height={active ? viewportSize.height : undefined}
            data-responsive-scale={active ? visualScale : undefined}
            data-responsive-width={active ? viewportSize.width : undefined}
            data-testid={TID_BROWSER_RESPONSIVE_VIEWPORT}
            style={
              active
                ? {
                    height: `${viewportSize.height}px`,
                    transform: `scale(${rendererScale})`,
                    transformOrigin: "top left",
                    width: `${viewportSize.width}px`,
                  }
                : undefined
            }
          >
            {children}
            {active ? (
              <ResponsiveBrowserResizeHandles
                height={viewportSize.height}
                heightLabel={intl.formatMessage({
                  id: "browser.responsive.resizeHeight",
                })}
                onBeginResize={beginResize}
                onEndResize={endResize}
                onPointerMove={handlePointerMove}
                onResizeKeyDown={handleResizeKeyDown}
                width={viewportSize.width}
                widthLabel={intl.formatMessage({
                  id: "browser.responsive.resizeWidth",
                })}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

import type { CaptureBrowserGuestPageRequest, CaptureBrowserGuestPageResult } from "@zcode/shared";
import type { WebElementRect } from "@/lib/webElementContext.js";

// 选元素带截图（docs/browser-use/2026-11-03-browser-element-screenshot-and-live-reload-spec.md）。
// renderer 侧 <webview>.capturePage() 会让 renderer 原生崩溃，所以和导出 PNG 一样交给 main 取帧，
// main 再按 CSS rect 与实测「帧 / CSS 视口」比例裁剪，DPR、Windows 小数缩放与自由尺寸都在 main 一处换算。

/**
 * 等两帧再读视口：选择器脚本在 resolve 前已移除高亮层，但移除后的画面要到下一次合成才进帧，
 * 不等的话截图里会带上蓝色高亮框。
 */
const READ_VIEWPORT_AFTER_PAINT_SCRIPT = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resolve({ width: window.innerWidth, height: window.innerHeight });
  }));
})`;

export interface BrowserElementScreenshotWebview {
  getWebContentsId(): number;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

function readViewport(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width, height }
    : null;
}

export async function captureBrowserElementScreenshot({
  captureGuestPage,
  rect,
  webview,
}: {
  captureGuestPage: (
    request: CaptureBrowserGuestPageRequest,
  ) => Promise<CaptureBrowserGuestPageResult>;
  rect: WebElementRect;
  webview: BrowserElementScreenshotWebview;
}): Promise<ArrayBuffer | null> {
  const webContentsId = webview.getWebContentsId();
  if (!(webContentsId > 0)) return null;
  const viewport = readViewport(await webview.executeJavaScript(READ_VIEWPORT_AFTER_PAINT_SCRIPT));
  if (!viewport) return null;
  const result = await captureGuestPage({
    webContentsId,
    clip: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    },
  });
  if (!result.success || !result.data) throw new Error(result.error ?? "capture_failed");
  return result.data;
}

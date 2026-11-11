import type {
  CaptureBrowserGuestPageRequest,
  CaptureBrowserGuestPageResult,
  SaveFileRequest,
  SaveFileResult,
} from "@zcode/shared";
import { isDefaultBrowserOpenableUrl } from "@/embeddedBrowserHelpers.js";

// 内置浏览器人类用户「导出 PNG / PDF」（docs/browser-use/2026-10-16-browser-device-presets-and-export-spec.md）。
// PDF 由 renderer 直接调 <webview>.printToPDF；PNG 必须经 main 取帧（renderer 侧 capturePage 会让
// renderer 原生崩溃，与 Agent 截图规避的是同一个坑）。两者都经既有 saveFile 落盘，不改 guest metrics。

export type BrowserPageExportKind = "pdf" | "png";

export type BrowserPageExportResult =
  | { status: "saved"; path: string }
  | { status: "canceled" }
  | { status: "failed"; error: string };

export interface BrowserPageExportWebview {
  /** guest webContents id；dom-ready 后有效，main 据此取帧 */
  getWebContentsId(): number;
  printToPDF(options: {
    printBackground?: boolean;
    preferCSSPageSize?: boolean;
  }): Promise<Uint8Array>;
  getTitle(): string;
}

const MAX_FILE_STEM_LENGTH = 120;
// Windows 与 macOS 文件名都不允许的字符，加上控制字符（含换行、制表）。
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]+/gu;

/** 用页面标题建议文件名：去掉不允许的字符、折叠空白、截断；为空时退回 page。 */
export function browserExportFileName(title: string, kind: BrowserPageExportKind): string {
  const stem = title
    .replace(UNSAFE_FILE_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILE_STEM_LENGTH)
    .trim();
  return `${stem || "page"}.${kind}`;
}

/** 与「在默认浏览器中打开」同一可用条件：只允许 Web URL 与 file URL。 */
export function canExportBrowserPage(url: string): boolean {
  return Boolean(url) && isDefaultBrowserOpenableUrl(url);
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Uint8Array 可能是更大 buffer 的视图；复制出独立 ArrayBuffer 再走 IPC structured clone。
  return Uint8Array.from(bytes).buffer;
}

async function readExportBytes({
  captureGuestPage,
  kind,
  webview,
}: {
  captureGuestPage: (
    request: CaptureBrowserGuestPageRequest,
  ) => Promise<CaptureBrowserGuestPageResult>;
  kind: BrowserPageExportKind;
  webview: BrowserPageExportWebview;
}): Promise<ArrayBuffer> {
  if (kind === "pdf") {
    return toOwnedArrayBuffer(
      await webview.printToPDF({ printBackground: true, preferCSSPageSize: true }),
    );
  }
  const webContentsId = webview.getWebContentsId();
  if (!(webContentsId > 0)) throw new Error("guest_not_ready");
  const captured = await captureGuestPage({ webContentsId });
  if (!captured.success || !captured.data) throw new Error(captured.error ?? "capture_failed");
  return captured.data;
}

export async function exportBrowserPage({
  captureGuestPage,
  kind,
  saveFile,
  webview,
}: {
  captureGuestPage: (
    request: CaptureBrowserGuestPageRequest,
  ) => Promise<CaptureBrowserGuestPageResult>;
  kind: BrowserPageExportKind;
  saveFile: (request: SaveFileRequest) => Promise<SaveFileResult>;
  webview: BrowserPageExportWebview;
}): Promise<BrowserPageExportResult> {
  try {
    const data = await readExportBytes({ captureGuestPage, kind, webview });
    const saved = await saveFile({
      data,
      suggestedName: browserExportFileName(webview.getTitle(), kind),
    });
    if (saved.canceled) return { status: "canceled" };
    if (!saved.success || !saved.path)
      return { status: "failed", error: saved.error ?? "save_failed" };
    return { status: "saved", path: saved.path };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

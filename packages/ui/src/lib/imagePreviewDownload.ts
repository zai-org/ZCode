import type { IPlatformService } from "@zcode/shared";

export interface ImagePreviewDialogItem {
  alt: string;
  error?: boolean;
  filename?: string;
  loading?: boolean;
  mediaType?: string;
  src?: string;
}

interface PreviewOffset {
  x: number;
  y: number;
}

interface PreviewSize {
  height: number;
  width: number;
}

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
// 预览动作进行中会锁住关闭入口，读取必须有上限，网络卡住时不能让预览永远关不掉。
const DOWNLOAD_TIMEOUT_MS = 30_000;

const imageExtensionByMediaType: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function imageDownloadFilename(item: ImagePreviewDialogItem, mediaType = item.mediaType ?? "") {
  const knownExtension = imageExtensionByMediaType[mediaType.toLowerCase().split(";")[0] ?? ""];
  let sourcePath: string | undefined;
  if (item.src && isHttpSource(item.src)) sourcePath = new URL(item.src).pathname;
  const supportedExtensions = new Set([...Object.values(imageExtensionByMediaType), "jpeg"]);
  const sourceExtension = [item.filename, sourcePath, item.alt]
    .map((name) => /\.([a-z0-9]+)$/iu.exec(name?.trim() ?? "")?.[1]?.toLowerCase())
    .find((extension) => extension !== undefined && supportedExtensions.has(extension));
  // 原字节不能统一命名成 PNG；未知 MIME 保留可信图片后缀，已知 MIME 拒绝不相容的后缀。
  const compatible =
    !knownExtension || (sourceExtension === "jpeg" ? "jpg" : sourceExtension) === knownExtension;
  const extension = (compatible ? sourceExtension : undefined) ?? knownExtension ?? "bin";
  return `${safeDownloadBaseName(item)}.${extension}`;
}

export function clampImagePreviewOffset(
  offset: PreviewOffset,
  scale: number,
  imageSize: PreviewSize,
  viewportSize: PreviewSize,
): PreviewOffset {
  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportSize.height) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

function safeDownloadBaseName(item: ImagePreviewDialogItem) {
  return (
    (item.filename || item.alt)
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
      .slice(0, 80) || "image"
  );
}

class ImageDownloadError extends Error {
  constructor(readonly code: "download_failed" | "file_too_large") {
    super(code);
  }
}

function isHttpSource(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function sanitizeImageSourceForLog(source: string) {
  if (source.startsWith("data:")) return "data-url";
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

export async function readBoundedImageBlob(source: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok || !response.body) throw new ImageDownloadError("download_failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new ImageDownloadError("file_too_large");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // Web 下载也必须在读取过程中截断，不能等 response.blob() 完整占用 renderer 内存。
        controller.abort();
        throw new ImageDownloadError("file_too_large");
      }
      chunks.push(value);
    }
    if (receivedBytes === 0) throw new ImageDownloadError("download_failed");
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes.buffer], {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

function startBrowserNativeDownload(source: string) {
  const link = document.createElement("a");
  link.href = source;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function downloadImagePreview(
  item: ImagePreviewDialogItem,
  saveFile?: IPlatformService["saveFile"],
): Promise<{ kind: "saved"; path: string } | { kind: "started" } | { kind: "canceled" }> {
  if (!item.src) throw new ImageDownloadError("download_failed");
  if (saveFile && isHttpSource(item.src)) {
    const result = await saveFile({
      sourceUrl: item.src,
      suggestedName: imageDownloadFilename(item),
    });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success) throw new Error(result.error || "save_failed");
    // Web 保存成功只表示浏览器已开始下载，不会返回可供本机打开的路径。
    return result.path ? { kind: "saved", path: result.path } : { kind: "started" };
  }
  let blob: Blob;
  try {
    blob = await readBoundedImageBlob(item.src);
  } catch (error) {
    if (
      !saveFile &&
      isHttpSource(item.src) &&
      !(error instanceof ImageDownloadError && error.code === "file_too_large")
    ) {
      startBrowserNativeDownload(item.src);
      return { kind: "started" };
    }
    throw error;
  }
  const filename = imageDownloadFilename(item, blob.type);
  if (saveFile) {
    const result = await saveFile({ data: await blob.arrayBuffer(), suggestedName: filename });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success) throw new Error(result.error || "save_failed");
    // Web 保存成功只表示浏览器已开始下载，不会返回可供本机打开的路径。
    return result.path ? { kind: "saved", path: result.path } : { kind: "started" };
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  return { kind: "started" };
}

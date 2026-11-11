import { readBoundedImageBlob } from "@/lib/imagePreviewDownload.js";

export function copyPreviewImage(image: HTMLImageElement): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    return Promise.reject(new Error("Image clipboard is unavailable"));
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return Promise.reject(new Error("Preview image is not loaded"));
  }
  const png = (async () => {
    let source = image;
    let objectUrl: string | undefined;
    try {
      const url = new URL(image.currentSrc || image.src, window.location.href);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin !== window.location.origin
      ) {
        // 外域 <img> 可以显示但会污染 canvas。只复制 CORS 允许读取的有界字节，
        // 不修改原图的 crossorigin 属性，以免破坏本来能显示的预览。
        const blob = await readBoundedImageBlob(url.href);
        objectUrl = URL.createObjectURL(blob);
        source = new Image();
        source.src = objectUrl;
        await source.decode();
      }
      if (source.naturalWidth * source.naturalHeight > 32_000_000)
        throw new Error("Image exceeds clipboard canvas limit");
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image canvas is unavailable");
      context.drawImage(source, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
          "image/png",
        ),
      );
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  })();
  // Safari 在异步转换后可能丢失用户激活，在点击栈内提交带 Promise 的 ClipboardItem。
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

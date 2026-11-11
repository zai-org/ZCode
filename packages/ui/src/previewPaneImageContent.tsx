import { copyPreviewImage } from "@/lib/copyPreviewImage.js";
import type { CSSProperties, SyntheticEvent } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Copy, Download, Ellipsis, MessageSquarePlus } from "lucide-react";
import { downloadImagePreview } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  dispatchWorkspaceFileAddToChat,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";

interface ImagePreviewContentProps {
  title: string;
  imageSource: string;
  fitToContainer?: boolean;
  sourcePath?: string;
  fileReference?: WorkspaceFileDragPayload;
  loadDownloadSource?: () => Promise<string>;
}

interface ImageNaturalSize {
  source: string;
  width: number;
  height: number;
}

const IMAGE_PREVIEW_CHECKERBOARD_CLASS =
  "[background-color:var(--color-background)] [background-image:linear-gradient(45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(-45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-surface)_75%),linear-gradient(-45deg,transparent_75%,var(--color-surface)_75%)] [background-position:0_0,0_4px,4px_-4px,-4px_0] [background-size:8px_8px]";

export function getImagePreviewPixelRatio(sourceName: string): number {
  const fileName = sourceName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(fileName);
  const ratio = match ? Number(match[1]) : 1;

  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export { copyPreviewImage } from "@/lib/copyPreviewImage.js";

export function ImagePreviewContent({
  title,
  fitToContainer = false,
  imageSource,
  sourcePath,
  fileReference,
  loadDownloadSource,
}: ImagePreviewContentProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const imageRef = useRef<HTMLImageElement>(null);
  const actionPendingRef = useRef(false);
  const keepComposerFocusOnMenuCloseRef = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null);
  const copyLabel = intl.formatMessage({ id: "preview.image.copy" });
  const canUseImage =
    !actionPending &&
    naturalSize?.source === imageSource &&
    naturalSize.width > 0 &&
    naturalSize.height > 0;
  const handleCopy = useCallback(async () => {
    const image = imageRef.current;
    if (!image || actionPendingRef.current || !canUseImage) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      await copyPreviewImage(image);
      toast(intl.formatMessage({ id: "preview.image.copied" }));
      logger.info("[ImagePreview] 图片已复制");
    } catch (error) {
      logger.warn("[ImagePreview] 复制图片失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "preview.image.copyFailed" }));
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  }, [canUseImage, intl]);
  const handleDownload = useCallback(async () => {
    if (actionPendingRef.current || !canUseImage) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      const src = loadDownloadSource ? await loadDownloadSource() : imageSource;
      const result = await downloadImagePreview(
        { alt: title, filename: sourcePath ? getPathLeaf(sourcePath) : title, src },
        platform?.saveFile,
      );
      if (result.kind === "saved") {
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
      } else if (result.kind === "started") {
        toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
      }
    } catch (error) {
      logger.warn("[ImagePreview] 下载图片失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  }, [canUseImage, imageSource, intl, loadDownloadSource, platform, sourcePath, title]);
  const handleAddToChat = useCallback(() => {
    if (!fileReference || !canUseImage) return;
    const added = dispatchWorkspaceFileAddToChat(fileReference);
    // Bug 根因：Composer 在事件里已聚焦，但菜单随后关闭时 Radix 会把焦点还给图片预览区，
    // 用户添加引用后无法直接继续输入。仅在添加成功时让本次关闭跳过焦点归还。
    keepComposerFocusOnMenuCloseRef.current = added;
    toast(intl.formatMessage({ id: added ? "preview.image.added" : "preview.image.addFailed" }));
  }, [canUseImage, fileReference, intl]);
  const handleMenuCloseAutoFocus = useCallback((event: Event) => {
    if (!keepComposerFocusOnMenuCloseRef.current) return;
    keepComposerFocusOnMenuCloseRef.current = false;
    event.preventDefault();
  }, []);
  const pixelRatio = useMemo(
    () => getImagePreviewPixelRatio(sourcePath ?? title),
    [sourcePath, title],
  );
  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (
      fitToContainer ||
      pixelRatio <= 1 ||
      naturalSize?.source !== imageSource ||
      naturalSize.width <= 0 ||
      naturalSize.height <= 0
    ) {
      return undefined;
    }

    return {
      // Retina 文件名里的 @2x/@3x 表示物理像素倍率，预览时折算为 CSS 像素，避免素材被放大显示。
      height: naturalSize.height / pixelRatio,
      width: naturalSize.width / pixelRatio,
    };
  }, [fitToContainer, imageSource, naturalSize, pixelRatio]);
  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const image = event.currentTarget;

      setNaturalSize({
        source: imageSource,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    },
    [imageSource],
  );
  const imageClassName = fitToContainer
    ? "h-full max-h-full w-full max-w-full object-contain"
    : "h-auto max-h-full w-auto max-w-full object-contain";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-image-preview
          aria-busy={actionPending || undefined}
          tabIndex={0}
          aria-label={title}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            // Radix 只监听 contextmenu；Chromium/Electron 不会始终为聚焦的 div 派发键盘菜单事件。
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + bounds.width / 2,
                clientY: bounds.top + bounds.height / 2,
              }),
            );
          }}
          className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden p-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${IMAGE_PREVIEW_CHECKERBOARD_CLASS}`}
        >
          <img
            ref={imageRef}
            alt={title}
            className={imageClassName}
            onLoad={handleLoad}
            onError={() => setNaturalSize(null)}
            src={imageSource}
            style={imageStyle}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="absolute top-3 right-3 min-h-11 gap-2 bg-menu sm:hidden"
                variant="outline"
                aria-label={intl.formatMessage({ id: "preview.image.actions" })}
              >
                <Ellipsis aria-hidden="true" />
                {intl.formatMessage({ id: "preview.image.actions" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onCloseAutoFocus={handleMenuCloseAutoFocus}>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-add
                disabled={!canUseImage || !fileReference}
                onSelect={handleAddToChat}
              >
                <MessageSquarePlus aria-hidden="true" />
                {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-copy
                disabled={!canUseImage}
                onSelect={() => void handleCopy()}
              >
                <Copy aria-hidden="true" />
                {copyLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-download
                disabled={!canUseImage}
                onSelect={() => void handleDownload()}
              >
                <Download aria-hidden="true" />
                {intl.formatMessage({ id: "markdownImage.download" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
        <ContextMenuItem
          data-image-preview-add
          disabled={!canUseImage || !fileReference}
          onSelect={handleAddToChat}
        >
          <MessageSquarePlus aria-hidden="true" />
          {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
        </ContextMenuItem>
        <ContextMenuItem
          data-image-preview-copy
          disabled={!canUseImage}
          onSelect={() => void handleCopy()}
        >
          <Copy aria-hidden="true" />
          {copyLabel}
        </ContextMenuItem>
        <ContextMenuItem
          data-image-preview-download
          disabled={!canUseImage}
          onSelect={() => void handleDownload()}
        >
          <Download aria-hidden="true" />
          {intl.formatMessage({ id: "markdownImage.download" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function SvgPreviewContent({
  title,
  svgContent,
  fileReference,
  sourcePath,
  loadDownloadSource,
}: {
  title: string;
  svgContent: string;
  fileReference?: WorkspaceFileDragPayload;
  sourcePath?: string;
  loadDownloadSource?: () => Promise<string>;
}) {
  return (
    <ImagePreviewContent
      fitToContainer
      title={title}
      fileReference={fileReference}
      sourcePath={sourcePath}
      loadDownloadSource={loadDownloadSource}
      imageSource={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`}
    />
  );
}

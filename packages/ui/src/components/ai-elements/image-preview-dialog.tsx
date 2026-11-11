"use client";

import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ImagePreviewSurface } from "@/image-preview-editor/index.js";

import {
  downloadImagePreview,
  sanitizeImageSourceForLog,
  type ImagePreviewDialogItem,
} from "@/lib/imagePreviewDownload.js";
export {
  downloadImagePreview,
  sanitizeImageSourceForLog,
  clampImagePreviewOffset,
  type ImagePreviewDialogItem,
} from "@/lib/imagePreviewDownload.js";

export function ImagePreviewDialog({
  dialogTestId,
  imageTestId,
  initialIndex,
  items,
  onActiveIndexChange,
  onOpenChange,
  open,
}: {
  dialogTestId?: string;
  imageTestId?: string;
  initialIndex: number;
  items: readonly ImagePreviewDialogItem[];
  onActiveIndexChange?: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [isDownloading, setIsDownloading] = useState(false);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const activeItem = items[activeIndex];
  const activeItemIsVideo = activeItem?.mediaType?.startsWith("video/") === true;
  const hasMultiple = items.length > 1;

  const guardRef = useRef<((proceed: () => void) => void) | null>(null);
  const registerGuard = useCallback((guard: ((proceed: () => void) => void) | null) => {
    guardRef.current = guard;
  }, []);
  const requestTransition = (proceed: () => void) => {
    if (guardRef.current) guardRef.current(proceed);
    else proceed();
  };
  const requestClose = () => requestTransition(() => onOpenChange(false));
  const navigate = (direction: -1 | 1) => {
    if (items.length <= 1) return;
    const next = (activeIndex + direction + items.length) % items.length;
    requestTransition(() => {
      setActiveIndex(next);
      onActiveIndexChange?.(next);
    });
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0)));
  }, [initialIndex, items.length, open]);

  useEffect(() => {
    setVideoState("loading");
  }, [activeIndex, activeItem?.src, open]);

  useEffect(() => {
    return () => {
      // 媒体 gallery 切离 video 时旧播放器可能继续解码或发声；显式暂停，
      // 让图片/视频混合导航只保留当前项的播放生命周期。
      previewVideoRef.current?.pause();
    };
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      )
        return;
      if (event.key === "ArrowLeft") navigate(-1);
      else if (event.key === "ArrowRight") navigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, items.length, open]);

  const downloadActiveImage = async (): Promise<string | null> => {
    if (!activeItem?.src || activeItemIsVideo || isDownloading) return null;
    setIsDownloading(true);
    try {
      const result = await downloadImagePreview(activeItem, platform?.saveFile);
      if (result.kind === "saved") {
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
      } else if (result.kind === "started") {
        toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
      }
      return result.kind === "saved" ? result.path : null;
    } catch (error) {
      logger.warn("[ImagePreviewDialog] 图片下载失败", {
        // 签名 URL 的 userinfo/query/fragment 不参与排障，禁止写入持久化日志。
        src: sanitizeImageSourceForLog(activeItem.src),
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
      return null;
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent
        overlayClassName="bg-background/95 backdrop-blur-md"
        aria-describedby={undefined}
        // Radix modal 会禁用 body 指针事件；预览层需显式恢复命中并退出 Electron 拖拽区。
        className="pointer-events-auto h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none place-items-center gap-0 overflow-hidden border-0 bg-transparent p-10 shadow-none [app-region:no-drag] sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] platform-linux-desktop:h-[calc(100dvh-4rem)]"
        onClick={(event) => {
          // 透明内容层覆盖遮罩；只把真实空白点击当关闭，图片与控件不冒充遮罩。
          if (event.target === event.currentTarget) requestClose();
        }}
        data-testid={dialogTestId}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {activeItem?.alt || intl.formatMessage({ id: "chat.attachments.preview.title" })}
        </DialogTitle>
        <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 [app-region:no-drag] platform-mac-desktop:top-12 platform-linux-desktop:right-6 platform-linux-desktop:top-4 platform-windows-desktop:right-6 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]">
          <DialogClose asChild>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="rounded-full border border-border bg-popover text-foreground shadow-sm hover:bg-hover"
              size="icon-md"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        {/* 侧边圈画工具展开后占据中段；图库导航固定底角，避免箭头工具截获下一张点击。 */}
        {hasMultiple ? (
          <>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.previous" })}
              className="pointer-events-auto absolute bottom-4 left-4 z-20 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(-1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.next" })}
              className={cn(
                "pointer-events-auto absolute bottom-4 right-4 z-20 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80",
              )}
              onClick={() => navigate(1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowRightIcon />
            </Button>
          </>
        ) : null}
        {activeItem ? (
          activeItemIsVideo ? (
            <div className="flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
              {activeItem.src ? (
                videoState === "unsupported" ? (
                  <p
                    className="max-w-xl px-6 text-center text-ui-base text-foreground-subtle"
                    role="alert"
                  >
                    {intl.formatMessage({
                      id: "chat.attachments.preview.videoUnsupported",
                    })}
                  </p>
                ) : (
                  <>
                    {videoState === "loading" ? (
                      <p className="text-ui-base text-foreground-subtle" role="status">
                        {intl.formatMessage({
                          id: "chat.attachments.preview.videoLoading",
                        })}
                      </p>
                    ) : null}
                    {/* 可发送的 video MIME 不保证当前 Chromium 能解码其容器或 codec；
                解码失败只收口当前 gallery item，不能关闭预览或影响相邻媒体。 */}
                    <video
                      controls
                      playsInline
                      className={cn(
                        "max-h-full max-w-full rounded-xl border border-border bg-background shadow-2xl",
                        videoState === "loading" && "invisible absolute",
                      )}
                      onError={() => setVideoState("unsupported")}
                      onLoadedMetadata={() => setVideoState("ready")}
                      ref={previewVideoRef}
                      src={activeItem.src}
                    />
                  </>
                )
              ) : activeItem.error ? (
                <p className="px-6 text-center text-ui-base text-destructive" role="alert">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoUnavailable",
                  })}
                </p>
              ) : activeItem.loading ? (
                <p className="text-ui-base text-foreground-subtle" role="status">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoLoading",
                  })}
                </p>
              ) : null}
            </div>
          ) : activeItem.src && open ? (
            <ImagePreviewSurface
              key={`${activeIndex}:${activeItem.src}`}
              src={activeItem.src}
              alt={activeItem.alt}
              filename={activeItem.filename}
              onDownload={downloadActiveImage}
              downloading={isDownloading}
              imageTestId={imageTestId}
              onClose={requestClose}
              onNavigationGuardChange={registerGuard}
              onSaved={() => onOpenChange(false)}
            />
          ) : activeItem.error ? (
            <p className="text-center text-ui-base text-destructive" role="alert">
              {intl.formatMessage({ id: "chat.attachments.preview.unavailable" })}
            </p>
          ) : activeItem.loading ? (
            <p className="text-ui-base text-foreground-subtle" role="status">
              {intl.formatMessage({ id: "chat.attachments.preview.loading" })}
            </p>
          ) : null
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

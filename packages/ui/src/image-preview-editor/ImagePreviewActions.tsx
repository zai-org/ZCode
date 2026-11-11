import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { FileApplicationInfo } from "@zcode/shared";
import { ChevronDown, Copy, Download, Ellipsis, FolderOpen, MessageSquarePlus } from "lucide-react";
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
import { downloadImagePreview, readBoundedImageBlob } from "@/lib/imagePreviewDownload.js";
import { DefaultFileApplicationLabel, FileApplicationChoices } from "@/file-menu/index.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { captureImageComposerTarget } from "@/image-preview-editor/composerTarget.js";
import { copyPreviewImage } from "@/lib/copyPreviewImage.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import {
  getFileManagerLabel,
  getSystemFileLocatorEditorId,
} from "@/workspace-file-tree/helpers.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

export function ImagePreviewActions({
  children,
  zoomControls,
  src,
  alt,
  filename,
  imageRef,
  ready,
  onAdded,
  onAddEdited,
  onBusyChange,
  onDownload,
  downloading,
}: {
  children: ReactNode;
  zoomControls: ReactNode;
  src: string;
  alt: string;
  filename?: string;
  imageRef: RefObject<HTMLImageElement | null>;
  ready: boolean;
  onAdded: () => void;
  onAddEdited?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDownload: () => Promise<string | null>;
  downloading: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    alive = useRef(true);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [applications, setApplications] = useState<FileApplicationInfo[]>([]);
  const [appsOpen, setAppsOpen] = useState(false);
  const defaultApplication = applications.find((app) => app.isDefault) ?? null;
  const native = Boolean(
    platform?.canOpenLocalFiles && platform.saveFile && platform.openExternalFile,
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!localPath || !native || !platform?.getFileApplications) return;
    let canceled = false;
    // 只有保存后的真实本机文件才能查询系统关联；下载/定位也必须刷新默认应用身份。
    void platform
      .getFileApplications({ path: localPath, pathKind: "file" })
      .then((apps) => {
        if (!canceled) setApplications(apps);
      })
      .catch(() => {
        if (!canceled) setApplications([]);
      });
    return () => {
      canceled = true;
    };
  }, [localPath, native, platform]);
  const run = async (action: string, task: () => Promise<void>) => {
    if (pending.current || downloading) return;
    pending.current = true;
    onBusyChange?.(true);
    setBusy(true);
    try {
      await task();
    } catch (error) {
      if (alive.current) {
        logger.warn("[ImagePreview] 图片操作失败", {
          action,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(
          intl.formatMessage({
            id: action === "copy" ? "preview.image.copyFailed" : "preview.image.actionFailed",
          }),
        );
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  };
  const ensureLocalPath = async () => {
    if (localPath) return localPath;
    // 对话图片只有预览字节，不能猜测宿主路径。用户明确保存后才使用返回的本机副本。
    const result = await downloadImagePreview({ src, alt, filename }, platform?.saveFile);
    if (!alive.current || result.kind !== "saved") return null;
    setLocalPath(result.path);
    return result.path;
  };
  const openApplication = (app?: FileApplicationInfo) =>
    run("open", async () => {
      const path = await ensureLocalPath();
      if (!path || !alive.current) return;
      const result =
        app && platform?.openFileWithApplication
          ? await platform.openFileWithApplication(app.id, { path, pathKind: "file" })
          : await platform?.openExternalFile?.(path);
      if (!result?.success) throw new Error(result?.error || "open_failed");
    });
  const chooseApplication = () =>
    run("applications", async () => {
      const path = await ensureLocalPath();
      if (!path || !alive.current) return;
      const apps = (await platform?.getFileApplications?.({ path, pathKind: "file" })) ?? [];
      if (!alive.current) return;
      setApplications(apps);
      setAppsOpen(true);
    });
  const download = async () => {
    const path = await onDownload();
    // 常规下载与“保存并打开”共享同一份本机副本，避免定位仍禁用或打开时重复保存。
    if (path && alive.current) setLocalPath(path);
  };
  const actions = [
    {
      id: "add",
      label: intl.formatMessage({ id: "workspaceFileTree.addToChat" }),
      Icon: MessageSquarePlus,
      disabled: !ready,
      select: () => {
        if (onAddEdited) {
          onAddEdited();
          return;
        }
        // 异步读图前锁定接收方，切换会话或关闭弹层后不把附件加到另一段对话。
        const target = captureImageComposerTarget();
        if (!target) {
          toast(intl.formatMessage({ id: "imageEditor.noComposer" }));
          return;
        }
        void run("add", async () => {
          const blob = await readBoundedImageBlob(src);
          if (!alive.current) return;
          const file = new File([blob], filename || alt || "image.png", { type: blob.type });
          if (!target.append(file)) throw new Error("composer_rejected");
          onAdded();
        });
      },
    },
    {
      id: "copy",
      label: intl.formatMessage({ id: "preview.image.copy" }),
      Icon: Copy,
      disabled: !ready,
      select: () =>
        void run("copy", async () => {
          if (!imageRef.current) return;
          await copyPreviewImage(imageRef.current);
          if (alive.current) toast(intl.formatMessage({ id: "preview.image.copied" }));
        }),
    },
    ...(native
      ? [
          {
            id: "reveal",
            label: getFileManagerLabel(intl),
            Icon: FolderOpen,
            disabled: !ready,
            select: () =>
              void run("reveal", async () => {
                const path = await ensureLocalPath();
                if (!path || !platform || !alive.current) return;
                const locator = getSystemFileLocatorEditorId();
                const result = locator
                  ? await platform.openInEditor(locator, path, { pathKind: "file" })
                  : await platform.openInFileManager(getContainingDirectoryPath(path) ?? path);
                if (!result.success) throw new Error(result.error || "reveal_failed");
              }),
          },
        ]
      : []),
    {
      id: "download",
      label: intl.formatMessage({ id: "markdownImage.download" }),
      Icon: Download,
      disabled: !ready,
      select: () => void download(),
    },
  ];
  const actionItems = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    return actions.map(({ id, label, Icon, disabled, select }) => (
      <Item
        key={id}
        data-image-preview-action={id}
        disabled={disabled || busy || downloading}
        onSelect={select}
      >
        <Icon aria-hidden="true" />
        {label}
      </Item>
    ));
  };
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>{actionItems(true)}</ContextMenuContent>
      </ContextMenu>
      <div className="absolute right-16 top-4 z-20 flex max-w-[calc(100%-5rem)] items-center gap-1 rounded-xl border border-popover-border bg-popover p-1.5 shadow-sm platform-mac-desktop:top-12 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)] platform-windows-desktop:right-20 platform-linux-desktop:right-20">
        {zoomControls}
        {native ? (
          <DropdownMenu open={appsOpen} onOpenChange={setAppsOpen}>
            <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border">
              <Button
                size="sm"
                variant="ghost"
                className="rounded-none px-2"
                disabled={!ready || busy || downloading}
                onClick={() => void openApplication(defaultApplication ?? undefined)}
              >
                <DefaultFileApplicationLabel application={defaultApplication}>
                  {defaultApplication
                    ? undefined
                    : intl.formatMessage({
                        id: localPath ? "common.open" : "preview.image.saveAndOpen",
                      })}
                </DefaultFileApplicationLabel>
              </Button>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-none"
                  aria-label={intl.formatMessage({
                    id: localPath ? "appHeader.selectOpenApp" : "preview.image.saveAndChooseApp",
                  })}
                  disabled={!ready || busy || downloading}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    void chooseApplication();
                  }}
                  onKeyDown={(event) => {
                    if (["Enter", " ", "ArrowDown"].includes(event.key)) {
                      event.preventDefault();
                      void chooseApplication();
                    }
                  }}
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
            </div>
            <DropdownMenuContent align="end">
              <FileApplicationChoices
                applications={applications}
                onSelect={(app) => void openApplication(app)}
                onOpenDefault={() => void openApplication()}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={intl.formatMessage({ id: "markdownImage.download" })}
          disabled={!ready || busy || downloading}
          onClick={() => void download()}
        >
          <Download />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={intl.formatMessage({ id: "preview.image.actions" })}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{actionItems(false)}</DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

import { useCallback } from "react";
import type { OpenInEditorRemoteTarget } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { getSystemFileLocatorEditorId } from "@/workspace-file-tree/helpers.js";

interface FileContextActionOptions {
  canOpenLocalFileManager?: boolean;
  isRemoteWorkspace?: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  openFailedMessage?: string;
}

interface FileContextActionTarget {
  path: string;
  relativePath?: string;
  deleted?: boolean;
  kind?: "file" | "directory";
}

function resolveFileManagerOpenPath(target: FileContextActionTarget): string {
  if (target.kind === "directory") {
    return target.path;
  }

  // 交互语义：审查面板里的“在文件管理器中打开”用于回到文件所在目录，
  // 不能把文件路径直接交给系统，否则部分平台会打开默认应用而不是文件夹。
  return getContainingDirectoryPath(target.path) ?? target.path;
}

export function useFileContextActions(options: FileContextActionOptions = {}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const canOpenLocalFileManager = Boolean(options.canOpenLocalFileManager);
  const isRemoteWorkspace = Boolean(options.isRemoteWorkspace);
  const remoteTarget = options.remoteTarget;
  const workspaceIdentity = options.workspaceIdentity;
  const openFailedMessage =
    options.openFailedMessage ?? intl.formatMessage({ id: "appHeader.openInFileManagerFailed" });

  const canRevealInFileManager = useCallback(
    (target: FileContextActionTarget) =>
      canOpenLocalFileManager &&
      !target.deleted &&
      (!isRemoteWorkspace || remoteTarget?.kind === "wsl"),
    [canOpenLocalFileManager, isRemoteWorkspace, remoteTarget?.kind],
  );

  const copyPathText = useCallback(async (path: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[FileContextActions] 复制文件路径失败", {
        path,
        error: "clipboard-unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      logger.info("[FileContextActions] 文件路径已复制", { path });
    } catch (error) {
      logger.warn("[FileContextActions] 复制文件路径失败", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);
  const copyPath = useCallback(
    (target: FileContextActionTarget) => copyPathText(target.path),
    [copyPathText],
  );
  const copyAbsolutePath = copyPath;
  const copyRelativePath = useCallback(
    (target: FileContextActionTarget) => copyPathText(target.relativePath ?? target.path),
    [copyPathText],
  );

  const revealInFileManager = useCallback(
    async (target: FileContextActionTarget) => {
      if (!canRevealInFileManager(target)) {
        return;
      }

      const openPath = resolveFileManagerOpenPath(target);
      // 审查区过去把所有远程工作区统一禁用；如果直接放开，又会把 WSL 的
      // Linux 路径交给本机文件管理器。只有精确解析到 WSL target 时才走 Explorer，
      // 并保留该入口“打开文件所在目录”的既有语义，由 main 在平台边界转换为 UNC。
      const result =
        remoteTarget?.kind === "wsl"
          ? await platform.openInEditor("explorer", openPath, {
              pathKind: "directory",
              remoteTarget,
              workspaceIdentity,
            })
          : await platform.openInFileManager(openPath);
      if (result.success) {
        return;
      }
      logger.warn("[FileContextActions] 在文件管理器中显示条目失败", {
        path: target.path,
        openPath,
        error: result.error ?? "unknown-error",
      });
      toast(openFailedMessage);
    },
    [canRevealInFileManager, openFailedMessage, platform, remoteTarget, workspaceIdentity],
  );

  // 打开下拉的定位项要“直达文件”：macOS Finder / Windows 资源管理器打开所在目录并选中该文件。
  // 复用 openInEditor 的 finder / explorer 分支（本机走 shell.showItemInFolder，WSL 走 UNC + /select），
  // 不新增 IPC；没有系统定位能力的平台或定位失败时，回退到只打开所在目录。
  const revealFileInFileManager = useCallback(
    async (target: FileContextActionTarget) => {
      if (!canRevealInFileManager(target)) {
        return;
      }
      const locatorId = remoteTarget?.kind === "wsl" ? "explorer" : getSystemFileLocatorEditorId();
      if (!locatorId || target.kind === "directory") {
        await revealInFileManager(target);
        return;
      }
      const result = await platform.openInEditor(locatorId, target.path, {
        pathKind: "file",
        ...(remoteTarget?.kind === "wsl" ? { remoteTarget, workspaceIdentity } : {}),
      });
      if (result.success) {
        return;
      }
      logger.warn("[FileContextActions] 定位并选中文件失败，回退到打开所在目录", {
        path: target.path,
        locatorId,
        error: result.error ?? "unknown-error",
      });
      await revealInFileManager(target);
    },
    [canRevealInFileManager, platform, remoteTarget, revealInFileManager, workspaceIdentity],
  );

  return {
    canRevealInFileManager,
    copyAbsolutePath,
    copyPath,
    copyRelativePath,
    revealFileInFileManager,
    revealInFileManager,
  };
}

import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { toFileUrl } from "@/lib/path.js";
import type { WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function replaceSetValue(set: Set<string>, value: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

/**
 * 本机系统文件管理器在 main 侧对应的编辑器 id：finder / explorer 收到文件路径时
 * 走 shell.showItemInFolder（打开所在目录并选中该文件）。其他平台没有统一定位能力，返回 null。
 */
export function getSystemFileLocatorEditorId(): "finder" | "explorer" | null {
  if (isMacLike()) {
    return "finder";
  }
  if (isWindowsLike()) {
    return "explorer";
  }
  return null;
}

export function getFileManagerLabel(intl: { formatMessage: (desc: { id: string }) => string }) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}

export function isWorkspaceFileTreeHtmlFile(
  row: Pick<WorkspaceFileTreeRow, "path" | "type">,
): boolean {
  if (row.type !== "file") {
    return false;
  }

  return /\.(?:html|htm)$/i.test(row.path);
}

export function createWorkspaceFileTreeHtmlBrowserUrl(
  row: Pick<WorkspaceFileTreeRow, "path" | "type">,
): string | null {
  if (!isWorkspaceFileTreeHtmlFile(row)) {
    return null;
  }

  return toFileUrl(row.path);
}

export const sortInstalledEditorsForFileTree = sortInstalledEditorsForOpenWith;

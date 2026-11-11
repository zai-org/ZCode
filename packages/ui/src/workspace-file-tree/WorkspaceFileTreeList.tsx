import type { CSSProperties, KeyboardEvent, RefCallback } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { AlertCircle, Files, LoaderCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  areWorkspaceFilePathsEqual,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileGitStatus,
  isWorkspaceFileGitIgnored,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import { WorkspaceFileTreeNotice } from "@/workspace-file-tree/WorkspaceFileTreeNotice.js";
import { WorkspaceFileTreeRowView } from "@/workspace-file-tree/WorkspaceFileTreeRowView.js";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
  WorkspaceFileTreeEditorState,
} from "@/workspace-file-tree/types.js";

export const WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY = "--workspace-file-tree-mask-offset";

export function getWorkspaceFileTreeListMaskStyle({
  stickyFolderCount,
}: {
  stickyFolderCount: number;
}): CSSProperties | undefined {
  if (stickyFolderCount === 0) {
    return undefined;
  }
  const hiddenHeight = stickyFolderCount * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
  // 修复原因：sticky 与虚拟列表是滚动容器内的兄弟节点，列表原行仍会从 sticky 下方经过。
  // 遮罩通过原生 scroll 事件同步 CSS 变量，只隐藏视口顶部的吸顶高度，不改变列表布局和滚动范围。
  const maskImage = `linear-gradient(to bottom, transparent 0 ${hiddenHeight}px, black ${hiddenHeight}px)`;
  const maskPosition = `0 var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY})`;
  const maskSize = `100% calc(100% - var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY}))`;
  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskPosition: maskPosition,
    maskPosition,
    WebkitMaskSize: maskSize,
    maskSize,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}

export function WorkspaceFileTreeList({
  rootError,
  showInitialLoading,
  rows,
  virtualItems,
  listRef,
  stickyFolderCount,
  totalSize,
  emptyTitle,
  workspaceTitle,
  workspacePath,
  workspaceIdentity,
  selectedPath,
  gitStatusByPath,
  ignoredPathSet,
  gitStatusLabelByStatus,
  contextMenuLabels,
  editorState,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  rootError: Error | null;
  showInitialLoading: boolean;
  rows: WorkspaceFileTreeRow[];
  virtualItems: VirtualItem[];
  listRef: RefCallback<HTMLDivElement>;
  stickyFolderCount: number;
  totalSize: number;
  emptyTitle: string;
  workspaceTitle: string;
  workspacePath: string;
  workspaceIdentity?: string;
  selectedPath: string | null;
  gitStatusByPath: Map<string, WorkspaceFileGitStatus>;
  ignoredPathSet: Set<string>;
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  editorState: WorkspaceFileTreeEditorState;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  const { intl } = useZCodeIntl();
  if (rootError) {
    return (
      <WorkspaceFileTreeNotice
        icon={<AlertCircle className="size-4" />}
        title={intl.formatMessage({ id: "workspaceFileTree.readFailed" })}
        description={rootError.message}
      />
    );
  }
  if (showInitialLoading) {
    return (
      <WorkspaceFileTreeNotice
        icon={<LoaderCircle className="size-4 animate-spin" />}
        title={intl.formatMessage({ id: "common.loading" })}
      />
    );
  }
  if (rows.length === 0) {
    return <WorkspaceFileTreeNotice icon={<Files className="size-4" />} title={emptyTitle} />;
  }
  const renderRow = (row: WorkspaceFileTreeRow, style: CSSProperties) => (
    <WorkspaceFileTreeRowView
      key={row.path}
      row={row}
      selected={selectedPath !== null && areWorkspaceFilePathsEqual(selectedPath, row.path)}
      gitStatus={
        getWorkspaceFileGitStatus(gitStatusByPath, row.path) ??
        (isWorkspaceFileGitIgnored(ignoredPathSet, row.path) ? "ignored" : null)
      }
      directoryGitStatuses={
        row.type === "directory" ? getWorkspaceDirectoryGitStatuses(gitStatusByPath, row.path) : []
      }
      gitStatusLabelByStatus={gitStatusLabelByStatus}
      contextMenuLabels={contextMenuLabels}
      canOpenLocalFileManager={editorState.canOpenLocalFileManager}
      installedEditors={editorState.installedEditors}
      isRemoteWorkspaceFileTree={editorState.isRemoteWorkspaceFileTree}
      remoteTarget={editorState.remoteTarget}
      htmlClickOpensBrowser={editorState.htmlClickOpensBrowser === true}
      workspaceRemoteSessionId={editorState.workspaceRemoteSessionId}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      style={style}
      onSelect={onSelect}
      onToggleDirectory={onToggleDirectory}
      onOpenPreview={onOpenPreview}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onKeyDown={onKeyDown}
    />
  );
  const listStyle: CSSProperties & Record<typeof WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY, string> =
    {
      [WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY]: "0px",
      height: `${totalSize}px`,
      ...getWorkspaceFileTreeListMaskStyle({ stickyFolderCount }),
    };
  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={listStyle}
      role="tree"
      aria-label={workspaceTitle}
    >
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index];
        if (!row) {
          return null;
        }
        return renderRow(row, {
          height: `${virtualItem.size}px`,
          transform: `translateY(${virtualItem.start}px)`,
        });
      })}
    </div>
  );
}

import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* eslint-disable max-lines -- 文件树行集中维护拖拽、打开方式、Git 状态与上下文菜单交互。 */
import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import {
  AlertCircle,
  ChevronRight,
  CopyIcon,
  FolderOpenIcon,
  GlobeIcon,
  LoaderCircle,
  MessageSquarePlusIcon,
  PanelRightIcon,
} from "lucide-react";
import { TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import {
  FileApplicationChoices,
  FileSaveAsMenuItem,
  useFileApplications,
} from "@/file-menu/index.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceFileManagerEditor } from "@/lib/workspaceEditorSelection.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import {
  dispatchWorkspaceFileAddToChat,
  dispatchWorkspaceFileDragState,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
} from "@/lib/workspaceFileDrag.js";
import {
  getWorkspaceFileRelativePath,
  isWorkspaceFileTreeDeletedFile,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import {
  getWorkspaceFileGitStatusDotClassName,
  getWorkspaceFileGitStatusIndicator,
  getWorkspaceFileGitStatusIndicatorClassName,
  getWorkspaceFileGitStatusTextClassName,
  getWorkspaceFileTreeRowDisplayGitStatus,
} from "@/workspace-file-tree/statusStyles.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
} from "@/workspace-file-tree/types.js";
import {
  createWorkspaceFileTreeHtmlBrowserUrl,
  isWorkspaceFileTreeHtmlFile,
} from "@/workspace-file-tree/helpers.js";
import { getWorkspaceFileTreeHierarchyGuideStyle } from "@/workspace-file-tree/hierarchyGuides.js";
import { useWorkspaceFileTreeRowDragState } from "@/workspace-file-tree/useWorkspaceFileTreeRowDragState.js";
import { WorkspaceFileTreeRowName } from "@/workspace-file-tree/WorkspaceFileTreeRowName.js";

export function WorkspaceFileTreeRowView({
  layout = "absolute",
  row,
  selected,
  gitStatus,
  directoryGitStatuses,
  gitStatusLabelByStatus,
  contextMenuLabels,
  canOpenLocalFileManager,
  installedEditors,
  isRemoteWorkspaceFileTree,
  remoteTarget,
  htmlClickOpensBrowser = false,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  style,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  layout?: "absolute" | "static";
  row: WorkspaceFileTreeRow;
  selected: boolean;
  gitStatus: WorkspaceFileGitStatus | null;
  directoryGitStatuses: WorkspaceFileGitStatus[];
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
  htmlClickOpensBrowser?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  style: CSSProperties;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  const platform = usePlatform();
  const fileApplications = useFileApplications(
    row.type === "file" ? { path: row.path, pathKind: "file", workspaceIdentity } : null,
    isRemoteWorkspaceFileTree,
  );
  const openApps =
    row.type === "file" && !isRemoteWorkspaceFileTree ? fileApplications.apps : installedEditors;
  const { isDragging, setIsDragging } = useWorkspaceFileTreeRowDragState();
  const fileActions = useFileContextActions({
    canOpenLocalFileManager,
    isRemoteWorkspace: isRemoteWorkspaceFileTree,
    openFailedMessage: contextMenuLabels.openFailed,
  });
  const relativePath = getWorkspaceFileRelativePath(workspacePath, row.path);
  const isDirectory = row.type === "directory";
  const isDeletedFile = isWorkspaceFileTreeDeletedFile(row, gitStatus);
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(installedEditors, remoteTarget);
  const rowStyle = {
    ...style,
    "--workspace-file-tree-depth": row.depth,
  } as CSSProperties;
  const hierarchyGuideStyle = getWorkspaceFileTreeHierarchyGuideStyle(row.depth);
  const fileIconSrc = isDirectory ? null : resolveFileDisplayDescriptor(row.path).fileIconSrc;
  const gitStatusLabel = gitStatus ? gitStatusLabelByStatus[gitStatus] : null;
  const gitStatusText = gitStatus ? getWorkspaceFileGitStatusIndicator(gitStatus) : null;
  const gitStatusIndicatorClassName = gitStatus
    ? getWorkspaceFileGitStatusIndicatorClassName(gitStatus)
    : null;
  const rowDisplayStatus = getWorkspaceFileTreeRowDisplayGitStatus({
    gitStatus,
    directoryGitStatuses,
  });
  const rowStatusTextClassName = getWorkspaceFileGitStatusTextClassName(rowDisplayStatus);
  // 目录展开加载时右侧已经有 loading spinner，继续显示 Git 小圆点会让状态含义混在一起。
  // 加载期间隐藏目录聚合状态点，等目录加载完成后再展示真实 Git 状态。
  const shouldShowDirectoryGitDots = !row.loading && directoryGitStatuses.length > 0;
  const workspaceFilePayload = {
    type: row.type === "directory" ? ("directory" as const) : ("file" as const),
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    path: row.path,
    relativePath,
    name: row.name,
  };

  const canOpenInBrowser =
    !isDeletedFile &&
    !isRemoteWorkspaceFileTree &&
    Boolean(onOpenBrowserUrl) &&
    isWorkspaceFileTreeHtmlFile(row);
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    onSelect(row.path);
    if (event.detail > 1) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    if (isDeletedFile) {
      // 修复：Git deleted 行是从状态里补出来的虚拟文件，真实文件已不存在。
      // 点击时只保留选中能力，避免继续打开预览导致文件读取失败。
      return;
    }
    // 用户开了「单击 HTML 在内置浏览器打开」时，本地 .html 单击进浏览器；
    // 条件与右键「在浏览器中打开」相同（远端 workspace 的文件不在本机磁盘，仍走源码预览）。
    if (htmlClickOpensBrowser && canOpenInBrowser) {
      handleOpenInBrowser();
      return;
    }
    // 文件树单击文件之前只更新选中态，必须双击才打开预览。
    // 这里让文件和目录都保持“单击执行主要动作”：目录展开，文件预览。
    onOpenPreview(row);
  };
  const handleCopyAbsolutePath = async () => {
    await fileActions.copyAbsolutePath({ path: row.path });
  };
  const handleCopyRelativePath = async () => {
    await fileActions.copyRelativePath({ path: row.path, relativePath });
  };
  const handleOpenPrimary = () => {
    if (isDeletedFile) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    onOpenPreview(row);
  };
  const handleOpenInEditor = async (editor: EditorInfo) => {
    if (isDeletedFile) {
      return;
    }
    // 远程文件树以前整项禁用第三方打开，且调用只传 Linux path；
    // 这里把已脱敏 remoteTarget 与文件/目录类型交给 main，由唯一平台边界生成正确 URI。
    const result = await platform.openInEditor(editor.id, row.path, {
      pathKind: isDirectory ? "directory" : "file",
      remoteTarget,
      workspaceIdentity,
    });
    if (result.success) {
      return;
    }
    logger.warn("[WorkspaceFileTree] 打开文件树条目失败", {
      editorId: editor.id,
      path: row.path,
      error: result.error ?? "unknown-error",
    });
    toast(contextMenuLabels.openFailed);
  };
  const handleOpenInBrowser = () => {
    const url = createWorkspaceFileTreeHtmlBrowserUrl(row);
    if (!url) {
      return;
    }

    onOpenBrowserUrl?.(url);
  };
  const handleRevealInFileManager = async () => {
    if (wslFileManagerEditor) {
      await handleOpenInEditor(wslFileManagerEditor);
      return;
    }
    await fileActions.revealInFileManager({
      path: row.path,
      deleted: isDeletedFile,
      kind: isDirectory ? "directory" : "file",
    });
  };
  const rowElement = (
    <SidebarNativeTooltip>
      <div
        role="treeitem"
        data-testid={testId(TID_WORKSPACE_FILE_TREE_ROW, row.path)}
        aria-expanded={isDirectory ? row.expanded : undefined}
        tabIndex={0}
        draggable={!isDeletedFile}
        className={cn(
          "group/file-tree-row relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg border pr-2 py-1 text-left text-ui-base text-foreground outline-none transition-[background-color,border-color,box-shadow]",
          isDeletedFile ? "cursor-default" : "cursor-pointer",
          "pl-[calc(var(--workspace-file-tree-depth)*0.75rem+0.5rem)]",
          selected
            ? "border-input-border-focused bg-transparent hover:bg-surface-hover"
            : "border-transparent hover:bg-surface-hover",
          "focus-visible:border-border-hover",
        )}
        title={relativePath}
        onClick={handleRowClick}
        onContextMenu={() => onSelect(row.path)}
        onKeyDown={(event) => {
          if (isDeletedFile && event.key === "Enter") {
            // 修复：键盘 Enter 和鼠标点击走的是两条路径；deleted 虚拟文件同样不能打开预览。
            event.preventDefault();
            onSelect(row.path);
            return;
          }
          onKeyDown(event, row);
        }}
        onDragStart={(event) => {
          if (isDeletedFile) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(
            WORKSPACE_FILE_DRAG_MIME,
            serializeWorkspaceFileDragPayload(workspaceFilePayload),
          );
          event.dataTransfer.setData(
            "text/plain",
            buildFileMentionMarkdown(relativePath, row.name, row.type),
          );
          setIsDragging(true);
          dispatchWorkspaceFileDragState(true);
        }}
        onDragEnd={() => {
          setIsDragging(false);
          dispatchWorkspaceFileDragState(false);
        }}
      >
        {/* 引导线上下各延伸 1px；12px 层级步进让最后一条线与当前层级图标之间稳定保留 4px。 */}
        {hierarchyGuideStyle && !isDragging ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-y-px left-2.5"
            data-workspace-file-tree-hierarchy-guides={row.depth}
            style={hierarchyGuideStyle}
          />
        ) : null}
        {isDirectory ? (
          <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3 text-foreground-subtlest transition-transform",
                row.expanded && "rotate-90",
              )}
            />
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {fileIconSrc ? <FileDisplayIcon src={fileIconSrc} className="shrink-0 size-4" /> : null}
          <WorkspaceFileTreeRowName
            name={row.name}
            className={cn("min-w-0 flex-1 truncate", rowStatusTextClassName)}
            slashClassName="mx-1 text-foreground-subtlest"
          />
        </span>
        {gitStatusText && gitStatusLabel ? (
          <ControlHintTooltip
            title={gitStatusLabel}
            side="right"
            align="center"
            sideOffset={4}
            triggerClassName="ml-auto"
          >
            <span
              className={cn(
                "inline-flex shrink-0 justify-center font-mono text-ui-base font-bold leading-none",
                gitStatusIndicatorClassName,
              )}
              aria-label={gitStatusLabel}
            >
              {gitStatusText}
            </span>
          </ControlHintTooltip>
        ) : null}
        {shouldShowDirectoryGitDots ? (
          <ControlHintTooltip
            title={directoryGitStatuses.map((status) => gitStatusLabelByStatus[status]).join(", ")}
            side="right"
            align="center"
            sideOffset={4}
            triggerClassName="ml-1"
          >
            <span className="flex shrink-0 items-center" aria-label="●">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  getWorkspaceFileGitStatusDotClassName(directoryGitStatuses[0]),
                )}
              />
            </span>
          </ControlHintTooltip>
        ) : null}
        {row.loading ? (
          <LoaderCircle className="ml-2 size-3 shrink-0 animate-spin text-foreground-subtlest" />
        ) : row.error ? (
          <AlertCircle className="ml-2 size-3 shrink-0 text-warning" />
        ) : null}
      </div>
    </SidebarNativeTooltip>
  );
  // 普通远程路径不能交给本机文件管理器，但 WSL Explorer 会在 main 边界
  // 转成 UNC；因此它和“打开方式 → 资源管理器”必须共享相同的可用性与执行路径。
  const canRevealInFileManager =
    (!isDeletedFile && Boolean(wslFileManagerEditor)) ||
    fileActions.canRevealInFileManager({
      path: row.path,
      deleted: isDeletedFile,
    });
  const canOpenPrimary = !isDeletedFile;

  return (
    <div
      className={cn(layout === "absolute" ? "absolute left-0 top-0 w-full px-1" : "w-full")}
      style={rowStyle}
    >
      <ContextMenu
        onOpenChange={(open) => {
          if (open && !isDeletedFile) void fileApplications.load();
        }}
      >
        <ContextMenuTrigger asChild>{rowElement}</ContextMenuTrigger>
        <ContextMenuContent className="w-64 max-w-[calc(100vw-1rem)]">
          <ContextMenuItem disabled={!canOpenPrimary} onSelect={handleOpenPrimary}>
            {/* 修复：第一项之前复用了默认外部应用文案，Finder/Explorer 置顶后会显示成“在 Finder 中打开”。
                这里改为复用行主动作：文件打开预览，目录走当前行的展开/收起逻辑。 */}
            {isDirectory ? (
              <FolderOpenIcon aria-hidden="true" className="size-4" />
            ) : (
              <PanelRightIcon aria-hidden="true" className="size-4" />
            )}
            {contextMenuLabels.open}
          </ContextMenuItem>
          <FileApplicationChoices
            variant="context"
            applications={[...openApps]}
            loading={fileApplications.loading}
            disabled={isDeletedFile}
            onOpenDefault={
              !isDirectory &&
              !isRemoteWorkspaceFileTree &&
              platform.canOpenLocalFiles &&
              platform.openExternalFile
                ? () => void fileApplications.openDefault()
                : undefined
            }
            onSelect={(editor) => {
              if (isDirectory || isRemoteWorkspaceFileTree)
                void handleOpenInEditor({ ...editor, iconDataUrl: editor.iconDataUrl ?? "" });
              else
                void fileApplications.open({
                  ...editor,
                  isDefault: "isDefault" in editor && Boolean(editor.isDefault),
                });
            }}
          />
          {canOpenInBrowser ? (
            <ContextMenuItem onSelect={handleOpenInBrowser}>
              <GlobeIcon aria-hidden="true" className="size-4" />
              {contextMenuLabels.openInBrowser}
            </ContextMenuItem>
          ) : null}
          {!isDirectory && (
            <FileSaveAsMenuItem
              variant="context"
              disabled={isDeletedFile}
              path={row.path}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              workspaceRemoteSessionId={workspaceRemoteSessionId}
            />
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => void handleRevealInFileManager()}
          >
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            {contextMenuLabels.reveal}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopyAbsolutePath()}>
            <CopyIcon aria-hidden="true" className="size-4" />
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopyRelativePath()}>
            <CopyIcon aria-hidden="true" className="size-4" />
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => dispatchWorkspaceFileAddToChat(workspaceFilePayload)}>
            <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
            {contextMenuLabels.addToChat}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

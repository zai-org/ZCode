import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* eslint-disable max-lines -- WorkspaceFileTree 需要集中编排数据、虚拟列表、吸顶和入口操作状态。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Copy,
  Ellipsis,
  FolderOpen,
  GitCommitVertical,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
} from "@zcode/shared/test-ids";
import {
  areWorkspaceFilePathsEqual,
  createCodeViewerSourceForWorkspaceFile,
  getWorkspaceFileGitStatus,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  filterWorkspaceFileTreeRows,
  isWorkspaceFileTreeDeletedFile,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";
import { useInstalledFileTreeEditors } from "@/workspace-file-tree/useInstalledFileTreeEditors.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import {
  resolveWorkspaceEditorSelection,
  resolveWorkspaceFileManagerEditor,
} from "@/lib/workspaceEditorSelection.js";
import { useWorkspaceFileTreeData } from "@/workspace-file-tree/useWorkspaceFileTreeData.js";
import { useWorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/useWorkspaceFileTreeStickyFolders.js";
import {
  useWorkspaceFileSearchIndex,
  useWorkspaceFileSearchResults,
} from "@/workspace-file-tree/useWorkspaceFileSearchIndex.js";
import {
  WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
  WorkspaceFileTreeList,
} from "@/workspace-file-tree/WorkspaceFileTreeList.js";
import { WorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/WorkspaceFileTreeStickyFolders.js";
import {
  createWorkspaceFileTreeRowsFromSearchEntries,
  getWorkspaceFileSearchDirectoryRevealPaths,
} from "@/workspace-file-tree/searchRows.js";
import type {
  WorkspaceFileTreeProps,
  WorkspaceFileTreeStickyFolderItem,
} from "@/workspace-file-tree/types.js";

export function getWorkspaceFileTreeDirectoryLoadDepth(
  workspacePath: string,
  directoryPath: string,
): number {
  return getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath);
}

export function WorkspaceFileTree({
  workspacePath,
  workspaceName,
  workspaceIdentity,
  workspaceRemoteSessionId,
  revealPath,
  temporaryExternalDirectory = false,
  canOpenLocalFileManager = false,
  activePreviewPath,
  onClose,
  onOpenBrowserUrl,
  onOpenPreview,
}: WorkspaceFileTreeProps) {
  const { intl } = useZCodeIntl();
  // HTML 单击打开方式是本机界面偏好；远端 workspace 下也读本机设置。
  const { settings: localSettings } = useSettings({ services: useBaseWorkspaceServices() });
  const platform = usePlatform();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingActivePreviewRevealPathRef = useRef<string | null>(null);
  const pendingSearchDirectoryRevealPathRef = useRef<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [showScrollBottomMask, setShowScrollBottomMask] = useState(false);
  const [hasScrollableFileTree, setHasScrollableFileTree] = useState(false);
  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) {
      node.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollRef.current?.scrollTop ?? 0}px`,
      );
    }
  }, []);
  const treeData = useWorkspaceFileTreeData({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enableWorkspaceFeatures: !temporaryExternalDirectory,
  });
  const { installedEditors } = useInstalledFileTreeEditors();
  const isRemoteWorkspaceFileTree = Boolean(workspaceRemoteSessionId || workspaceIdentity);
  const { remoteTarget } = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const availableEditors = useMemo(
    () =>
      isRemoteWorkspaceFileTree && !remoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors,
            selectedEditorId: null,
            remoteTarget,
          }).availableEditors,
    [installedEditors, isRemoteWorkspaceFileTree, remoteTarget],
  );
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(availableEditors, remoteTarget);
  const canOpenInFileManager =
    Boolean(wslFileManagerEditor) || (canOpenLocalFileManager && !isRemoteWorkspaceFileTree);
  const hasFileSearchQuery = fileSearchQuery.trim().length > 0;
  const searchIndex = useWorkspaceFileSearchIndex({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enabled: hasFileSearchQuery,
  });
  const {
    entries: searchIndexEntries,
    error: searchIndexError,
    loaded: searchIndexLoaded,
    loading: searchIndexLoading,
    refresh: refreshSearchIndex,
  } = searchIndex;
  const searchEntries = useWorkspaceFileSearchResults({
    entries: searchIndexEntries,
    query: fileSearchQuery,
    workspacePath,
  });
  const searchRows = useMemo(
    () => createWorkspaceFileTreeRowsFromSearchEntries(searchEntries),
    [searchEntries],
  );
  const visibleRows = useMemo(() => {
    if (hasFileSearchQuery) {
      return showChangedOnly
        ? searchRows.filter((row) => getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path))
        : searchRows;
    }
    return filterWorkspaceFileTreeRows({
      rows: treeData.rows,
      searchQuery: fileSearchQuery,
      changedOnly: showChangedOnly,
      statusByPath: treeData.gitStatusByPath,
    });
  }, [
    fileSearchQuery,
    hasFileSearchQuery,
    searchRows,
    showChangedOnly,
    treeData.gitStatusByPath,
    treeData.rows,
  ]);
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    overscan: 12,
  });

  useEffect(() => {
    setSelectedPath(null);
    setFileSearchQuery("");
    setShowChangedOnly(false);
  }, [workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!treeData.gitStatusAvailable) {
      setShowChangedOnly(false);
    }
  }, [treeData.gitStatusAvailable]);

  const rootLoading = treeData.loadingDirectoryPaths.has(workspacePath);
  const rootLoaded = treeData.loadedDirectoryPaths.has(workspacePath);
  const rootError = treeData.errorByDirectory.get(workspacePath) ?? null;
  const blockingRootError = getWorkspaceFileTreeBlockingRootError({
    rootLoaded,
    rootError,
  });
  const showInitialLoading = !rootLoaded && !blockingRootError;
  const lastNonBlockingRootErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootLoaded || !rootError) {
      lastNonBlockingRootErrorRef.current = null;
      return;
    }
    const errorMessage = rootError.message;
    if (lastNonBlockingRootErrorRef.current === errorMessage) {
      return;
    }
    lastNonBlockingRootErrorRef.current = errorMessage;
    // Bugfix: 根目录已有缓存时，刷新失败只能作为非阻塞提示；阻塞错误页会把保留的旧文件树隐藏掉。
    toast(`${intl.formatMessage({ id: "workspaceFileTree.readFailed" })}: ${errorMessage}`);
  }, [intl, rootError, rootLoaded]);
  const gitStatusLabelByStatus = useMemo<Record<WorkspaceFileGitStatus, string>>(
    () => ({
      added: intl.formatMessage({ id: "git.kind.added" }),
      deleted: intl.formatMessage({ id: "git.kind.deleted" }),
      ignored: intl.formatMessage({
        id: "workspaceFileTree.gitStatus.ignored",
      }),
      modified: intl.formatMessage({ id: "git.kind.modified" }),
      renamed: intl.formatMessage({ id: "git.kind.renamed" }),
      untracked: intl.formatMessage({ id: "git.section.untracked" }),
    }),
    [intl],
  );
  const fileManagerLabel = getFileManagerLabel(intl);
  const fileContextMenuLabels = useMemo(
    () => ({
      addToChat: intl.formatMessage({ id: "workspaceFileTree.addToChat" }),
      copyAbsolutePath: intl.formatMessage({
        id: "fileActions.copyAbsolutePath",
      }),
      copyRelativePath: intl.formatMessage({
        id: "fileActions.copyRelativePath",
      }),
      open: intl.formatMessage({ id: "common.open" }),
      openInBrowser: intl.formatMessage({
        id: "workspaceFileTree.openInBrowser",
      }),
      openFailed: intl.formatMessage({ id: "workspaceFileTree.openFailed" }),
      openWith: intl.formatMessage({ id: "workspaceFileTree.openWith" }),
      reveal: fileManagerLabel,
    }),
    [fileManagerLabel, intl],
  );

  const scrollMaskStyle = useMemo<CSSProperties | undefined>(() => {
    if (!showScrollBottomMask) {
      return undefined;
    }
    return {
      WebkitMaskImage:
        "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      maskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showScrollBottomMask]);
  const scrollContainerStyle = useMemo<CSSProperties>(
    () => ({ ...scrollMaskStyle, overflowAnchor: "none" }),
    [scrollMaskStyle],
  );

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || !isWorkspaceFilePathInside(workspacePath, previewPath)) {
      return;
    }
    let disposed = false;
    const ancestorDirectories = getWorkspaceFileAncestorDirectories(workspacePath, previewPath);
    const directoryPathsToExpand = revealPath?.trim()
      ? [...ancestorDirectories, previewPath]
      : ancestorDirectories;
    pendingActivePreviewRevealPathRef.current = previewPath;
    setSelectedPath(previewPath);
    treeData.setExpandedPaths((current) => {
      const next = new Set(current);
      for (const directoryPath of directoryPathsToExpand) {
        next.add(directoryPath);
      }
      return next;
    });
    void (async () => {
      for (const [index, directoryPath] of directoryPathsToExpand.entries()) {
        if (disposed) {
          return;
        }
        await treeData.loadDirectory(directoryPath, index + 1);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    activePreviewPath,
    revealPath,
    treeData.loadDirectory,
    treeData.setExpandedPaths,
    workspacePath,
  ]);

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || visibleRows.length === 0) {
      return;
    }
    if (
      !isWorkspaceFilePathInside(workspacePath, previewPath) ||
      !pendingActivePreviewRevealPathRef.current ||
      !areWorkspaceFilePathsEqual(pendingActivePreviewRevealPathRef.current, previewPath)
    ) {
      return;
    }
    const activeRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, previewPath),
    );
    if (activeRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(activeRowIndex, { align: "auto" });
      pendingActivePreviewRevealPathRef.current = null;
    }
  }, [activePreviewPath, revealPath, rowVirtualizer, visibleRows, workspacePath]);

  useEffect(() => {
    const revealDirectoryPath = pendingSearchDirectoryRevealPathRef.current;
    if (!revealDirectoryPath || visibleRows.length === 0 || hasFileSearchQuery) {
      return;
    }
    const revealRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, revealDirectoryPath),
    );
    if (revealRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(revealRowIndex, { align: "center" });
      pendingSearchDirectoryRevealPathRef.current = null;
    }
  }, [hasFileSearchQuery, rowVirtualizer, visibleRows]);

  useEffect(() => {
    const scrollNode = scrollRef.current;
    if (!scrollNode) {
      return;
    }
    const contentNode = scrollNode.firstElementChild;
    const updateScrollMask = () => {
      // virtualizer 的 scrollOffset 需要经过 React 重渲染，拖拽滚动条时
      // mask 会落后一帧。原生 scroll 回调直接更新 CSS 变量，与浏览器滚动同步绘制。
      listRef.current?.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollNode.scrollTop}px`,
      );
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;
      setHasScrollableFileTree(hasOverflow);
      setShowScrollBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateScrollMask();
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }
    scrollNode.addEventListener("scroll", updateScrollMask, { passive: true });
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rootError, rootLoaded, rootLoading, visibleRows.length]);

  const handleRefresh = useCallback(() => {
    void treeData.refreshLoadedDirectories();
    if (hasFileSearchQuery) {
      refreshSearchIndex();
    }
  }, [hasFileSearchQuery, refreshSearchIndex, treeData]);
  const refreshInProgress =
    rootLoading || treeData.refreshingLoadedDirectories || searchIndexLoading;

  const handleOpenInFileManager = useCallback(async () => {
    if (!canOpenInFileManager) {
      return;
    }
    const result = wslFileManagerEditor
      ? await platform.openInEditor(wslFileManagerEditor.id, workspacePath, {
          pathKind: "directory",
          remoteTarget,
          workspaceIdentity,
        })
      : await platform.openInFileManager(workspacePath);
    if (!result.success) {
      logger.warn("[WorkspaceFileTree] 打开 workspace 路径失败", {
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [
    canOpenInFileManager,
    intl,
    platform,
    remoteTarget,
    workspaceIdentity,
    workspacePath,
    wslFileManagerEditor,
  ]);

  const handleCopyPath = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: "clipboard-unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(workspacePath);
      logger.info("[WorkspaceFileTree] workspace 路径已复制", {
        path: workspacePath,
      });
    } catch (error) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [workspacePath]);

  const handleToggleDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      const representedPaths = row.compactedPaths ?? [row.path];
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        // 懒加载合并后可能只有前段路径已展开；只查末段会让首次折叠变成补加展开标记。
        // 与行展示使用相同的组成路径，并在更新函数内读取最新集合，避免旧渲染状态干扰切换。
        if (representedPaths.some((path) => current.has(path))) {
          for (const path of representedPaths) {
            next.delete(path);
          }
          return next;
        }
        next.add(row.path);
        return next;
      });
      if (!row.expanded) {
        // compact folders 的 row.depth 是压缩后的视觉深度，不能用于写入新加载节点。
        // 使用物理路径深度后，flatten 阶段再扣除 compact offset，子内容才不会与父目录同级。
        void treeData.loadDirectory(
          row.path,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, row.path),
        );
      }
    },
    [treeData, workspacePath],
  );
  const handleRevealSearchDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      const directoryPathsToExpand = getWorkspaceFileSearchDirectoryRevealPaths({
        workspacePath,
        directoryPath: row.path,
      });
      if (directoryPathsToExpand.length === 0) {
        return;
      }
      pendingSearchDirectoryRevealPathRef.current = row.path;
      setSelectedPath(row.path);
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        for (const directoryPath of directoryPathsToExpand) {
          next.add(directoryPath);
        }
        return next;
      });
      // 搜索结果是 listWorkspaceFiles 的平铺索引，不受 expandedPaths 驱动。
      // 目录点击必须先回到树态，再逐级加载祖先目录，目标目录才会在懒加载树中可见并保持展开。
      setFileSearchQuery("");
      void (async () => {
        for (const directoryPath of directoryPathsToExpand) {
          await treeData.loadDirectory(
            directoryPath,
            getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, directoryPath),
          );
        }
      })();
    },
    [treeData, workspacePath],
  );
  const handleDirectoryAction = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (hasFileSearchQuery) {
        handleRevealSearchDirectory(row);
        return;
      }
      handleToggleDirectory(row);
    },
    [handleRevealSearchDirectory, handleToggleDirectory, hasFileSearchQuery],
  );
  const handleOpenPreview = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type === "directory") {
        handleDirectoryAction(row);
        return;
      }
      if (
        isWorkspaceFileTreeDeletedFile(
          row,
          getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path),
        )
      ) {
        // 修复：deleted 文件行来自 Git 状态补全，不对应现存文件。
        // 即使未来有其它入口直接调用预览，也要在父级兜底阻止打开。
        return;
      }
      onOpenPreview?.(createCodeViewerSourceForWorkspaceFile(row.path));
    },
    [handleDirectoryAction, onOpenPreview, treeData.gitStatusByPath],
  );
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleOpenPreview(row);
        return;
      }
      if (event.key === "ArrowRight" && row.type === "directory") {
        event.preventDefault();
        if (!row.expanded || hasFileSearchQuery) {
          handleDirectoryAction(row);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
        event.preventDefault();
        handleToggleDirectory(row);
      }
    },
    [handleDirectoryAction, handleOpenPreview, handleToggleDirectory, hasFileSearchQuery],
  );

  const hasActiveFileTreeFilter = fileSearchQuery.trim().length > 0 || showChangedOnly;
  const virtualItems = rowVirtualizer.getVirtualItems();
  const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
  const stickyFolderItems = useWorkspaceFileTreeStickyFolders({
    rows: visibleRows,
    virtualItems,
    scrollDirection: rowVirtualizer.scrollDirection,
    scrollOffset,
    enabled: hasScrollableFileTree && !hasFileSearchQuery,
  });
  const handleRevealStickyFolderRow = useCallback(
    (item: WorkspaceFileTreeStickyFolderItem) =>
      rowVirtualizer.scrollToIndex(item.index, { align: "start" }),
    [rowVirtualizer],
  );
  const workspaceTitle =
    workspaceName?.trim() ||
    getPathLeaf(workspacePath) ||
    intl.formatMessage({ id: "workspaceFileTree.title" });
  const editorState = {
    workspaceRemoteSessionId,
    canOpenLocalFileManager,
    installedEditors: availableEditors,
    isRemoteWorkspaceFileTree,
    remoteTarget,
    htmlClickOpensBrowser: localSettings?.fileTreeHtmlClickOpensBrowser === true,
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col text-foreground"
      data-testid={TID_WORKSPACE_FILE_TREE_PANEL}
    >
      {onClose ? (
        <div className="px-2 pb-3 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full justify-start gap-2 rounded-xl px-2.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onClose}
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "workspaceFileTree.backToTasks" })}
            </span>
          </Button>
        </div>
      ) : (
        <div className="h-2 shrink-0" />
      )}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            type="text"
            size="default"
            value={fileSearchQuery}
            className="h-7 bg-transparent pl-7 pr-7 focus-visible:bg-input-focused"
            placeholder={intl.formatMessage({
              id: "workspaceFileTree.searchPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "workspaceFileTree.searchLabel",
            })}
            onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
          />
          {fileSearchQuery.length > 0 ? (
            <SidebarNativeTooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
                aria-label={intl.formatMessage({
                  id: "workspaceFileTree.clearSearch",
                })}
                title={intl.formatMessage({
                  id: "workspaceFileTree.clearSearch",
                })}
                onClick={() => setFileSearchQuery("")}
              >
                <X className="size-3" />
              </Button>
            </SidebarNativeTooltip>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <h3 className="min-w-0 truncate py-1 pr-0.5 pl-2.5 text-ui-base font-medium text-foreground-subtlest">
            {workspaceTitle}
          </h3>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarNativeTooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                aria-label={intl.formatMessage({ id: "common.more" })}
                title={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </SidebarNativeTooltip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={!canOpenInFileManager}
              onSelect={() => void handleOpenInFileManager()}
            >
              <FolderOpen className="size-4" />
              {fileManagerLabel}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopyPath()}>
              <Copy className="size-4" />
              {intl.formatMessage({ id: "appHeader.copyPath" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {treeData.gitStatusAvailable ? (
          <ControlHintTooltip
            title={intl.formatMessage({
              id: showChangedOnly
                ? "workspaceFileTree.showAllFiles"
                : "workspaceFileTree.showChangedFiles",
            })}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={showChangedOnly}
              aria-label={intl.formatMessage({
                id: showChangedOnly
                  ? "workspaceFileTree.showAllFiles"
                  : "workspaceFileTree.showChangedFiles",
              })}
              className={cn(
                "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                showChangedOnly && "bg-selected text-foreground",
              )}
              onClick={() => setShowChangedOnly((current) => !current)}
            >
              <GitCommitVertical className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        ) : null}
        <ControlHintTooltip title={intl.formatMessage({ id: "workspaceFileTree.refresh" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid={TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON}
            className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label={intl.formatMessage({ id: "workspaceFileTree.refresh" })}
            disabled={treeData.refreshingLoadedDirectories}
            onClick={handleRefresh}
          >
            <RefreshCw className={cn("size-3.5", refreshInProgress && "animate-spin")} />
          </Button>
        </ControlHintTooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-auto px-1 px-2"
          style={scrollContainerStyle}
        >
          <WorkspaceFileTreeStickyFolders
            items={stickyFolderItems}
            selectedPath={selectedPath}
            gitStatusByPath={treeData.gitStatusByPath}
            ignoredPathSet={treeData.ignoredPathSet}
            gitStatusLabelByStatus={gitStatusLabelByStatus}
            contextMenuLabels={fileContextMenuLabels}
            editorState={editorState}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            onSelect={setSelectedPath}
            onToggleDirectory={handleToggleDirectory}
            onRevealRow={handleRevealStickyFolderRow}
            onOpenPreview={handleOpenPreview}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onKeyDown={handleRowKeyDown}
          />
          <WorkspaceFileTreeList
            rootError={hasFileSearchQuery ? searchIndexError : blockingRootError}
            showInitialLoading={
              showInitialLoading || (hasFileSearchQuery && searchIndexLoading && !searchIndexLoaded)
            }
            rows={visibleRows}
            virtualItems={virtualItems}
            listRef={handleListRef}
            stickyFolderCount={stickyFolderItems.length}
            totalSize={rowVirtualizer.getTotalSize()}
            emptyTitle={intl.formatMessage({
              id: hasActiveFileTreeFilter
                ? "workspaceFileTree.noResults"
                : "workspaceFileTree.empty",
            })}
            workspaceTitle={workspaceTitle}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            selectedPath={selectedPath}
            gitStatusByPath={treeData.gitStatusByPath}
            ignoredPathSet={treeData.ignoredPathSet}
            gitStatusLabelByStatus={gitStatusLabelByStatus}
            contextMenuLabels={fileContextMenuLabels}
            editorState={editorState}
            onSelect={setSelectedPath}
            onToggleDirectory={handleDirectoryAction}
            onOpenPreview={handleOpenPreview}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onKeyDown={handleRowKeyDown}
          />
        </div>
      </div>
    </section>
  );
}

export function getWorkspaceFileTreeBlockingRootError({
  rootLoaded,
  rootError,
}: {
  rootLoaded: boolean;
  rootError: Error | null;
}) {
  return rootLoaded ? null : rootError;
}

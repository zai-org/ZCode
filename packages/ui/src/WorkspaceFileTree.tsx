import { usePanelRef } from "react-resizable-panels";
import { logger } from "@/logger.js";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { FolderOpenIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { PreviewPane } from "@/PreviewPane.js";
import { WorkspaceFileTree } from "@/workspace-file-tree/WorkspaceFileTree.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";

export { WorkspaceFileTree };
const FILE_MANAGER_PANEL_IDS = ["directory", "preview"];

type FileManagerPaneProps = Omit<ComponentProps<typeof PreviewPane>, "source"> & {
  source: CodeViewerSource | null;
  target: FileManagerTarget;
  mobileOverlay: boolean;
  canOpenLocalFileManager: boolean;
  onNavigate: (source: CodeViewerSource) => void;
};

export function FileManagerPane({
  source,
  target,
  mobileOverlay,
  canOpenLocalFileManager,
  onNavigate,
  ...previewProps
}: FileManagerPaneProps) {
  const { intl } = useZCodeIntl();
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(mobileOverlay);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const previewPanelRef = usePanelRef();
  const directoryPanelRef = usePanelRef();
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setIsNarrow(entry.contentRect.width < 384);
      // Bug 原因：组宽某帧 <80px 时两个 collapsible 分栏会被一起折叠到 0，库按分栏宽度之和测组宽，之后无法自愈（黑屏）。
      // 容器恢复宽度时若两栏仍都是 0，重挂载分组让它按默认/已存布局重新测量。
      if (
        entry &&
        entry.contentRect.width >= 160 &&
        previewPanelRef.current?.getSize().asPercentage === 0 &&
        directoryPanelRef.current?.getSize().asPercentage === 0
      ) {
        setLayoutEpoch((epoch) => epoch + 1);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [previewPanelRef, directoryPanelRef]);
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const storedNavigationPreferenceOpen = useZCodeStore(
    (state) => state.fileManagerNavigationOpenByWorkspace[workspaceKey],
  );
  const setNavigationPreferenceOpen = useZCodeStore((state) => state.setFileManagerNavigationOpen);
  // 空白文件标签需要先显示目录供用户选择；仅覆盖当前标签，不改写工作区的历史偏好。
  const [initialNavigationOpenOverride, setInitialNavigationOpenOverride] = useState<true | null>(
    source ? null : true,
  );
  const [compactNavigationOpenOverride, setCompactNavigationOpenOverride] = useState<
    boolean | null
  >(mobileOverlay ? !source : null);
  const compactLayout = mobileOverlay || isNarrow;
  // 已选文件继承 workspace 偏好；空白标签默认展开，紧凑布局选中文件后仅临时收起当前面板。
  const navigationOpen = compactLayout
    ? (compactNavigationOpenOverride ??
      initialNavigationOpenOverride ??
      storedNavigationPreferenceOpen ??
      (!mobileOverlay || !source))
    : (initialNavigationOpenOverride ?? storedNavigationPreferenceOpen ?? true);
  const canNavigate = Boolean(target.workspacePath && (!source || source.path));
  const showNavigation = canNavigate && navigationOpen;
  const navigationOnly = showNavigation && (isNarrow || mobileOverlay);
  useLayoutEffect(() => {
    // layoutEpoch：分组重挂载后需要重新应用显隐。
    // Panel 的 className 只作用于内层，hidden 会留下外层占位；用库的布局状态收起并恢复宽度。
    if (navigationOnly) previewPanelRef.current?.collapse();
    else previewPanelRef.current?.expand();
    if (showNavigation) directoryPanelRef.current?.expand();
    else directoryPanelRef.current?.collapse();
    logger.debug("[FileManager] 更新目录布局", { showNavigation, navigationOnly });
  }, [showNavigation, navigationOnly, previewPanelRef, directoryPanelRef, layoutEpoch]);
  const navigationLabel = intl.formatMessage({
    id: showNavigation ? "fileManager.hideNavigation" : "fileManager.showNavigation",
  });
  const navigate = (nextSource: CodeViewerSource) => {
    onNavigate({
      ...nextSource,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      workspaceRemoteSessionId: target.workspaceRemoteSessionId,
    });
    if (mobileOverlay || isNarrow) {
      setCompactNavigationOpenOverride(false);
    }
  };
  const toggleNavigation = () => {
    const nextOpen = !navigationOpen;
    setNavigationPreferenceOpen(workspaceKey, nextOpen);
    setInitialNavigationOpenOverride(null);
    setCompactNavigationOpenOverride(null);
  };

  return (
    <div
      ref={containerRef}
      className="@container flex h-full min-h-0 min-w-0 flex-col"
      data-file-manager-pane
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-surface/30">
        {canNavigate ? (
          <div className="flex shrink-0 items-center border-r border-border px-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleNavigation}
              aria-label={navigationLabel}
              title={navigationLabel}
              aria-expanded={showNavigation}
            >
              {showNavigation ? (
                <PanelLeftCloseIcon className="size-4" />
              ) : (
                <PanelLeftOpenIcon className="size-4" />
              )}
            </Button>
          </div>
        ) : null}
        <div ref={setHeaderContainer} className="min-w-0 flex-1">
          {!source ? (
            <span className="px-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "fileManager.title" })}
            </span>
          ) : null}
        </div>
      </div>
      <ResizablePanelGroup
        key={layoutEpoch}
        layoutId="file-manager-layout"
        panelIds={FILE_MANAGER_PANEL_IDS}
        disabled={!showNavigation || isNarrow || mobileOverlay}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="directory"
          panelRef={directoryPanelRef}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize="160px"
          maxSize={navigationOnly ? "100%" : "60%"}
          className="h-full min-w-0"
          onResize={(size) => logger.debug("[FileManager] 目录面板尺寸", size)}
        >
          {canNavigate ? (
            <WorkspaceFileTree
              {...target}
              canOpenLocalFileManager={canOpenLocalFileManager}
              activePreviewPath={source?.path}
              onOpenPreview={navigate}
              onOpenBrowserUrl={previewProps.onOpenBrowserUrl}
            />
          ) : null}
        </ResizablePanel>
        <ResizableHandle
          aria-label={intl.formatMessage({ id: "fileManager.resizeNavigation" })}
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            // 内部分隔线没有面板圆角，高亮需上下贴边，并与目录边框共用热区中线。
            "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] after:inset-y-0 after:rounded-none after:left-1/2 after:-translate-x-1/2",
            (!showNavigation || isNarrow || mobileOverlay) && "hidden",
          )}
        />
        <ResizablePanel
          id="preview"
          panelRef={previewPanelRef}
          collapsible
          collapsedSize="0px"
          minSize="160px"
          className="min-h-0 min-w-0"
        >
          {source ? (
            <PreviewPane {...previewProps} source={source} headerContainer={headerContainer} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-ui-base text-foreground-subtle">
              <FolderOpenIcon className="size-6" />
              <span>{intl.formatMessage({ id: "fileManager.empty" })}</span>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

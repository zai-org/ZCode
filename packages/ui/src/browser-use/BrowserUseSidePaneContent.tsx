import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import type { CSSProperties } from "react";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { cn } from "@/components/lib/utils.js";
import { TabsContent } from "@/components/ui/tabs.js";
import type { BrowserSidePaneMetadata, BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

export interface BrowserUseSidePaneContentProps {
  tab: BrowserUseSidePaneTab;
  onOpenPermissionSettings?: (origin: string) => void;
  isPanelVisible: boolean;
  isSelected: boolean;
  isCurrentTask: boolean;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  initialUrl?: string;
  automaticRestoreUrl?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  residencyGeneration?: number;
  onUrlChange(url: string): void;
  onPageMetadataChange(metadata: BrowserSidePaneMetadata): void;
}

/** browser-use 专用 TabsContent：非活动 tab 仅在截图准备期间保留真实合成布局。 */
export function BrowserUseSidePaneContent({
  tab,
  onOpenPermissionSettings,
  isPanelVisible,
  isSelected,
  isCurrentTask,
  screenshotSurfaceRequest,
  initialUrl,
  automaticRestoreUrl,
  workspacePath,
  workspaceIdentity,
  residencyGeneration,
  onUrlChange,
  onPageMetadataChange,
}: BrowserUseSidePaneContentProps): React.JSX.Element {
  // 截图 surface 不能依赖收起的 ResizablePanel 提供尺寸：面板宽度为 0 时，Electron
  // guest 会被 Chromium 当成没有 compositor surface，capturePage 会直接失败。把同一份
  // TabsContent 临时固定到窗口内的合成层，并用接近透明的 opacity 隔离视觉；完全移到窗口外
  // 会被 Viz 视为 offscreen 而继续返回 UnknownVizError。它仍不参与右侧布局，也不卸载 guest。
  const screenshotSurfaceStyle: CSSProperties | undefined = screenshotSurfaceRequest
    ? {
        position: "fixed",
        left: 0,
        top: 0,
        // 固定层超过窗口时，Fit 误以为 viewport 能完整显示；Windows 高 DPI
        // 的 Chromium 会裁剪超出可见范围的 guest raster，native 截图归一后横向拉伸。
        // 以宿主窗口为上限，让 Fit 按真实可见画布缩放，保持逻辑 viewport 与用户偏好。
        width: `${screenshotSurfaceRequest.viewport.width}px`,
        height: `${screenshotSurfaceRequest.viewport.height + 48}px`,
        maxWidth: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vw",
        maxHeight: screenshotSurfaceRequest.surfaceScaleMode === "unscaled" ? undefined : "100vh",
        pointerEvents: "none",
        // opacity=0 会让 Chromium 丢弃 guest layer；0.001 保留 compositor surface，视觉上不可见。
        opacity: 0.001,
      }
    : undefined;

  return (
    <TabsContent
      value={tab.id}
      forceMount
      aria-hidden={!isSelected}
      inert={!isSelected ? true : undefined}
      data-browser-use-tab-id={tab.tabId}
      data-browser-screenshot-surface-state={screenshotSurfaceRequest ? "preparing" : undefined}
      className={cn(
        "h-full min-h-0 bg-background",
        isSelected
          ? "relative z-10 flex"
          : screenshotSurfaceRequest
            ? "pointer-events-none fixed z-0 flex overflow-hidden"
            : "hidden",
      )}
      style={screenshotSurfaceStyle}
    >
      <UnifiedBrowserView
        browserKey={tab.tabId}
        onOpenPermissionSettings={onOpenPermissionSettings}
        isResidencyRestore={tab.residency === "restoring"}
        isVisible={isPanelVisible && isSelected}
        isSelected={isSelected}
        isCurrentTask={isCurrentTask}
        screenshotSurfaceRequest={screenshotSurfaceRequest}
        initialUrl={initialUrl}
        automaticRestoreUrl={automaticRestoreUrl}
        faviconUrl={tab.faviconUrl}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceKey={tab.workspaceKey ?? (workspaceIdentity?.trim() || workspacePath)}
        remoteSessionId={tab.remoteSessionId ?? undefined}
        sessionId={tab.sessionId}
        residencyGeneration={tab.residencyGeneration ?? residencyGeneration}
        browserUseOperationUntil={tab.browserUseOperationUntil}
        browserResizeBaselineVersion={tab.browserUseResizeBaselineVersion}
        onUrlChange={onUrlChange}
        onPageMetadataChange={onPageMetadataChange}
      />
    </TabsContent>
  );
}

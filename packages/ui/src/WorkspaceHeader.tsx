import type {
  ZCodeProvider,
  ZCodeTaskMeta,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  RemoteTarget,
  UserInfo,
} from "@zcode/shared";
import { useState } from "react";
import { TID_WORKSPACE_HEADER } from "@zcode/shared/test-ids";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { cn } from "@/components/lib/utils.js";
import {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderState,
  WorkspaceHeaderTitleSection,
} from "@/WorkspaceHeaderSections.js";
import type { WorkspaceHeaderVariant } from "@/WorkspaceHeaderSections/shared.js";

/**
 * 侧栏收起时左上角浮层（侧栏开关、前进后退、新建、更新）盖在内容区顶栏上，顶栏需要让出的左侧留白。
 * WorkspaceHeader 与 Side Pane 完整视图的 tab 栏共用这一规则。
 */
export function resolveTopOverlayLeadingPaddingClass({
  isSidebarVisible,
  isMacDesktop,
  isMacFullscreen,
  hasUpdateReady,
}: {
  isSidebarVisible: boolean;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  hasUpdateReady?: boolean;
}): string | false {
  if (isSidebarVisible) return false;
  if (isMacDesktop) {
    if (hasUpdateReady) return isMacFullscreen ? "pl-48" : "pl-66";
    return isMacFullscreen ? "pl-38" : "pl-58";
  }
  return hasUpdateReady ? "pl-44" : "pl-38";
}

export function WorkspaceHeader({
  variant = "task",

  draftDropTargetController,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary,
  hasUpdateReady,
  activeTaskId,
  user,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  sessionLogPath,
  nativeSessionLogProvider,
  nativeSessionLogPath,
  nativeSessionLogExists,
  nativeSessionLogLoading,
  providerWorkspaceConfigPath,
  providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading,
  workspaceHeaderState,
  gitSummary,
  gitDirtyFileCount,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,
  isWebRemoteControl = false,

  isDesktop,
  simplifyForNarrowRemote = false,
  isSidebarVisible,
  isTerminalOpen,
  isSidePaneOpen,
  onRefreshGit,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onReloadSession,
  reloadSessionDisabled,
  reloadSessionPending,
}: {
  variant?: WorkspaceHeaderVariant;
  draftDropTargetController?: ConversationDropTargetController | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  hasUpdateReady: boolean;
  activeTaskId: string | null;
  user?: UserInfo | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  providerWorkspaceConfigPath: string | null;
  providerWorkspaceConfigExists: boolean;
  providerWorkspaceConfigLoading: boolean;
  workspaceHeaderState: WorkspaceHeaderState;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  reserveWindowControls?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  isDesktop?: boolean;
  simplifyForNarrowRemote?: boolean;
  isSidebarVisible: boolean;
  isTerminalOpen: boolean;
  isSidePaneOpen: boolean;
  onRefreshGit: () => void;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  onReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
}) {
  const [selectedEditor, setSelectedEditor] = useState<EditorInfo | null>(null);
  // Linux 与 Windows 共用内联窗控，不再预留旧悬浮窗控的标题栏区域。
  const usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop));
  const headerWindowControlsPaddingClass = resolveTopOverlayLeadingPaddingClass({
    isSidebarVisible,
    isMacDesktop,
    isMacFullscreen,
    hasUpdateReady,
  });

  return (
    <header
      data-testid={TID_WORKSPACE_HEADER}
      data-workspace-header-variant={variant}
      className={cn(
        "@container/workspace-header relative flex w-full shrink-0 h-12 border-b",
        variant === "draft" ? "border-transparent" : "border-border/50",
      )}
    >
      {variant === "draft" && draftDropTargetController?.active ? (
        <div
          className="absolute inset-0 z-40 bg-accent/55 backdrop-blur-sm pointer-events-auto [app-region:no-drag]"
          data-testid="new-task-draft-drop-mask"
          onDragOver={draftDropTargetController.onDragOver}
          onDragLeave={draftDropTargetController.onDragLeave}
          onDrop={draftDropTargetController.onDrop}
        />
      ) : null}
      <div
        className={cn(
          // 运行时记录确认侧栏切换后的 padding 动画仍逐帧触发布局；预留空间与侧栏同时到位。
          "flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 [app-region:drag]",
          // 旧 caption 菜单移除后不能继续清零右边距，否则终端按钮会贴住面板边框。
          headerWindowControlsPaddingClass,
        )}
      >
        {variant === "task" || remoteTarget || workspaceIdentity || remoteSessionId ? (
          <WorkspaceHeaderTitleSection
            variant={variant}
            readOnlyReason={readOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            remoteSessionId={remoteSessionId}
            workspaceIdentity={workspaceIdentity}
            remoteTarget={remoteTarget}
            localWorkspacePath={localWorkspacePath}
            projectName={projectName}
            activeTaskTitle={activeTaskTitle}
            activeTaskChangeSummary={activeTaskChangeSummary}
            activeTaskId={activeTaskId}
            activeTraceId={activeTraceId}
            activeSessionId={activeSessionId}
            activeTaskProvider={activeTaskProvider}
            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            sessionLogPath={sessionLogPath}
            nativeSessionLogProvider={nativeSessionLogProvider}
            nativeSessionLogPath={nativeSessionLogPath}
            nativeSessionLogExists={nativeSessionLogExists}
            nativeSessionLogLoading={nativeSessionLogLoading}
            providerWorkspaceConfigPath={providerWorkspaceConfigPath}
            providerWorkspaceConfigExists={providerWorkspaceConfigExists}
            providerWorkspaceConfigLoading={providerWorkspaceConfigLoading}
            workspaceHeaderState={workspaceHeaderState}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            simplifyForNarrowRemote={simplifyForNarrowRemote}
            selectedEditor={selectedEditor}
            onReloadSession={onReloadSession}
            reloadSessionDisabled={reloadSessionDisabled}
            reloadSessionPending={reloadSessionPending}
            onRefreshGit={onRefreshGit}
          />
        ) : (
          <div className="min-w-0 flex-1" aria-hidden="true" />
        )}
        <WorkspaceHeaderActionSection
          variant={variant}
          activeTaskId={activeTaskId}
          user={user}
          readOnlyReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          remoteTarget={remoteTarget}
          isWebRemoteControl={isWebRemoteControl}
          isDesktop={isDesktop}
          isTerminalOpen={isTerminalOpen}
          isSidePaneOpen={isSidePaneOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleSidePane={onToggleSidePane}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          simplifyForNarrowRemote={simplifyForNarrowRemote}
          hideHelpMenu={false}
          showWindowControls={usesInlineWindowControls}
          // 面板操作按钮沿用 macOS 紧凑样式，Windows/Linux 窗控跟随最右侧 Header。
          onSelectedEditorChange={setSelectedEditor}
        />
      </div>
    </header>
  );
}

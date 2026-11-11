import { memo, useEffect } from "react";
import { ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import type { AppProps } from "@/app-shell/types.js";
import type { RootProps, WorkspaceSettingsLayerProps } from "@/root/types.js";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import { ConversationTelemetryWorkspaceAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const StableWorkspaceApp = memo(App);

interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeWorkspacePath: string | null;
  isSettingsTabActive: boolean;
  handleConnectRemote: AppProps["onConnectRemote"];
  handleSelectRemoteProject: AppProps["onSelectRemoteProject"];
  handleCancelRemoteProject: AppProps["onCancelRemoteProject"];
  handleReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  handleOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  remoteConnectionInProgress?: AppProps["remoteConnectionInProgress"];
  remoteWorkspaceSessions: NonNullable<AppProps["remoteWorkspaceSessions"]>;
  allowRemoteWorkspace: NonNullable<RootProps["allowRemoteWorkspace"]>;
  handleBackFromSettings: () => void;
  // Bugfix：工作区内的设置层显式转发 props，漏掉它会让分享管理解析到会话却不显示「跳转对话」。
  handleOpenTaskFromSettings: NonNullable<WorkspaceSettingsLayerProps["onOpenTask"]>;
  handleLogout?: () => void;
  onLogin?: () => void;
  user: AppProps["user"];
  reconnectingRemoteWorkspaceKeys: AppProps["reconnectingRemoteWorkspaceKeys"];
  remoteWorkspaceRecoveryByWorkspaceKey: AppProps["remoteWorkspaceRecoveryByWorkspaceKey"];
  remoteWorkspaceErrorByWorkspaceKey: AppProps["remoteWorkspaceErrorByWorkspaceKey"];

  remoteConnectionLogs?: AppProps["remoteConnectionLogs"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  webRemoteControlWorkspaceSwitcher?: RootProps["webRemoteControlWorkspaceSwitcher"];
  initialSidebarFileTreeOpen?: boolean;
  initialWebRemoteControlMobileNavigationIntent?: RootProps["initialWebRemoteControlMobileNavigationIntent"];
  webRemoteControlTerminalTransportState?: RootProps["webRemoteControlTerminalTransportState"];
  isDesktop?: RootProps["isDesktop"];
  isMacDesktop?: RootProps["isMacDesktop"];
  isWindowsDesktop?: RootProps["isWindowsDesktop"];
  supportsEmbeddedBrowser: NonNullable<RootProps["supportsEmbeddedBrowser"]>;
  windowsWindowControlsRightPaddingPx?: number;
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeWorkspacePath,
  isSettingsTabActive,
  handleConnectRemote,
  handleSelectRemoteProject,
  handleCancelRemoteProject,
  handleReconnectRemoteWorkspace,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  handleOpenRemoteWorkspace,
  remoteConnectionInProgress,
  remoteWorkspaceSessions,
  allowRemoteWorkspace,
  handleBackFromSettings,
  handleOpenTaskFromSettings,
  handleLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceRecoveryByWorkspaceKey,
  remoteWorkspaceErrorByWorkspaceKey,

  remoteConnectionLogs,
  allowOpenWorkspace,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser,
  windowsWindowControlsRightPaddingPx,
}: RootWorkspaceContentProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;

  useEffect(() => {
    logger.info("[RootWorkspaceContent] settings layer visibility changed", {
      isSettingsTabActive,
      workspaceShellPath,
      workspaceHiddenByLayout: false,
    });
  }, [isSettingsTabActive, workspaceShellPath]);

  return (
    <ProjectDirectoryProvider isDesktop={isDesktop}>
      <div
        className={isSettingsTabActive ? "h-full opacity-0 pointer-events-none" : "h-full"}
        aria-hidden={isSettingsTabActive}
        data-root-workspace-surface={isSettingsTabActive ? "inert" : "interactive"}
        inert={isSettingsTabActive ? true : undefined}
      >
        {/* Bugfix: 设置页之前通过条件分支直接替换整个 App，关闭设置时会把主界面整棵树卸载再重建，
            聊天区、终端等本地 UI 状态都会被当成一次“重新进入 workspace”。
            这里改成让 workspace 壳层常驻挂载，只把设置页覆盖到上面。
            之前再额外按 workspacePath 改 key，会让跨工作区切 task 时把侧边栏和任务列表整棵卸载重建，
            用户看到的就是列表闪烁、日志里大量 mount/unmount。
            现在保持 App 实例连续，只在内部按需同步 workspace 相关局部状态，关闭设置和切换工作区都不会再触发整树重挂载。
            另外这里不能在切到设置页时直接用 hidden 把底层 workspace 壳层 display:none。
            侧边栏设置入口本身挂着 Radix DropdownMenu，菜单关闭动画仍在跑时如果锚点节点突然退出布局，
            Floating UI 会短暂失去定位参考，表现成菜单内容先闪到左上角再消失。
            之前这里用 invisible，虽然也能保留几何信息，但部分平台在整棵 workspace 壳层切成 visibility:hidden
            的那一帧会把 sidebar 视为一次突兀的可见性切换，切到 settings 时容易感觉“左侧闪一下”。
            这里改成 opacity-0 + pointer-events-none：仍然保留布局和菜单锚点，避免 DropdownMenu 丢参考点，
            同时把切层从“可见/不可见硬切”改成稳定的透明覆盖，减少 sidebar 闪烁。
            修复原因：这里如果误用 hidden，workspace 子树虽然还挂载，但 quickpick 弹层也会继承 display:none，
            用户在设置页按 Cmd/Ctrl+K 时状态已打开却完全不可见，所以必须保持布局占位只关闭交互。
            修复原因：只用 opacity 和 pointer-events 仍会让底层权限/AskUserQuestion 卡片的 autofocus
            抢走设置表单焦点；设置页覆盖期间必须把整棵 workspace 标为 inert，等用户显式返回后再恢复交互。 */}
        <ConversationTelemetryWorkspaceAttachment
          enabled={isDesktop === true}
          foregroundEnabled={!isSettingsTabActive}
          services={workspaceScopedServices}
          workspacePath={workspaceShellPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={workspaceRemoteSessionId}
        >
          <ServiceProvider services={workspaceScopedServices}>
            <ScopedErrorBoundary
              scope="workspace-app"
              resetKeys={[workspaceKey]}
              variant="panel"
              className="h-full"
            >
              <StableWorkspaceApp
                services={workspaceScopedServices}
                baseFeedbackService={baseFeedbackService}
                onConnectRemote={handleConnectRemote}
                onSelectRemoteProject={handleSelectRemoteProject}
                onCancelRemoteProject={handleCancelRemoteProject}
                onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                onLogout={handleLogout}
                onLogin={onLogin}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                remoteConnectionLogs={remoteConnectionLogs}
                workspaceAbsPath={workspaceShellPath}
                workspaceRemoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                onCreateTask={handleCreateTask}
                onCreateConversationTask={handleCreateConversationTask}
                onResolveConversationWorkspace={handleResolveConversationWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
                remoteConnectionInProgress={remoteConnectionInProgress}
                onReturnToWorkspace={handleBackFromSettings}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                allowRemoteWorkspace={allowRemoteWorkspace}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                isWorkspaceVisible={!isSettingsTabActive}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </ScopedErrorBoundary>
          </ServiceProvider>
        </ConversationTelemetryWorkspaceAttachment>
      </div>

      {isSettingsTabActive ? (
        <ScopedErrorBoundary
          scope="workspace-settings-layer"
          resetKeys={[workspaceKey, isSettingsTabActive]}
          variant="panel"
          className="absolute inset-0 z-10"
        >
          <WorkspaceSettingsLayer
            workspaceScopedServices={workspaceScopedServices}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={activeWorkspacePath}
            onBack={activeWorkspacePath ? handleBackFromSettings : undefined}
            onOpenTask={handleOpenTaskFromSettings}
            onCreateTask={handleCreateTask}
            onOpenWorkspace={handleOpenWorkspace}
            onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={handleLogout}
            user={user}
          />
        </ScopedErrorBoundary>
      ) : null}
    </ProjectDirectoryProvider>
  );
}

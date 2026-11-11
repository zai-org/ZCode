import { useEffect } from "react";
import { SettingsPage } from "@/SettingsPage.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { WorkspaceSettingsLayerProps } from "@/root/types.js";

export function WorkspaceSettingsLayer({
  workspaceScopedServices,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onOpenTask,
  onCreateTask,
  onOpenWorkspace,
  onOpenRemoteWorkspace,
  allowOpenWorkspace,
  onLogin,
  onLogout,
  user,
}: WorkspaceSettingsLayerProps) {
  useEffect(() => {
    logger.info("[Root] settings layer mounted");
    return () => {
      logger.info("[Root] settings layer unmounted");
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10">
      {workspaceScopedServices ? (
        <ServiceProvider services={workspaceScopedServices}>
          <SettingsPage
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={captionWorkspacePath}
            onBack={onBack}
            onOpenTask={onOpenTask}
            onCreateTask={onCreateTask}
            onOpenWorkspace={onOpenWorkspace}
            onOpenRemoteWorkspace={onOpenRemoteWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
          />
        </ServiceProvider>
      ) : (
        <SettingsPage
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          isWebRemoteControl={isWebRemoteControl}
          windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
          captionWorkspacePath={captionWorkspacePath}
          onBack={onBack}
          onOpenTask={onOpenTask}
          onCreateTask={onCreateTask}
          onOpenWorkspace={onOpenWorkspace}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          allowOpenWorkspace={allowOpenWorkspace}
          onLogin={onLogin}
          onLogout={onLogout}
          user={user}
        />
      )}
    </div>
  );
}

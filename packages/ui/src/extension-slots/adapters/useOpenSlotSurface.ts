import { useCallback, useRef } from "react";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  documentViewerInstance,
  resolvePluginUiSurfaceTitle,
  useOpenPluginUi,
  usePluginUiPaneTarget,
  type DraftPluginUiOpenRequest,
} from "@/plugin-ui/index.js";
import type { NavPrimarySlotProps, SlotSurfaceTarget } from "@/extension-slots/contract.js";

/**
 * 插槽的 surface target：打开插件的 MCP App 页面（docs/plugins/extension-host.md §16.3）。
 * 页面要挂在会话上。焦点窗格有会话（草稿为预热会话）就在它里面打开；没有会话时交给 Shell 的
 * handleOpenDraftPluginUi：先进根草稿，草稿的 SessionPane 在预热会话就绪后打开。
 * 用的是插件市场打开界面的同一组原语（listSurfaces、documentViewerInstance、标题解析、提示文案），
 * 这里只多一个「焦点窗格有会话就直接用」的分支。
 */
export function useOpenSlotSurface(
  shell: NavPrimarySlotProps,
): (target: SlotSurfaceTarget) => void {
  const platform = useOptionalPlatform();
  const bridge = useOptionalServices()?.pluginUiBridgeService;
  const openPluginUi = useOpenPluginUi();
  const { intl, locale } = useZCodeIntl();
  const paneTarget = usePluginUiPaneTarget({
    workspacePath: shell.workspacePath,
    workspaceIdentity: shell.workspaceIdentity,
    remoteSessionId: shell.workspaceRemoteSessionId,
    sessionId: shell.sessionId,
  });
  // 点击时读最新值：打开入口保持稳定，不随窗格或会话变化重建。
  const latestRef = useRef({ shell, platform, bridge, openPluginUi, intl, locale, paneTarget });
  latestRef.current = { shell, platform, bridge, openPluginUi, intl, locale, paneTarget };

  return useCallback((target: SlotSurfaceTarget) => {
    const current = latestRef.current;
    // 按点击那一刻决定路径：焦点窗格的会话，或根草稿。回到对话主视图后窗格才挂载，
    // 预热会话随之登记，不能等 listSurfaces 返回后再判断，否则同一次点击会换路径。
    const sessionId = current.openPluginUi ? current.paneTarget.sessionId : null;
    const scope = sessionId
      ? current.paneTarget
      : {
          workspacePath: current.shell.workspacePath,
          workspaceIdentity: current.shell.workspaceIdentity,
          remoteSessionId: current.shell.workspaceRemoteSessionId,
        };
    const remote =
      Boolean(scope.remoteSessionId) || isRemoteWorkspaceIdentity(scope.workspaceIdentity ?? "");
    const message = (id: string) => current.intl.formatMessage({ id });
    if (!current.platform?.pluginSandbox || !current.bridge || remote) {
      logger.lifecycle.info("[extension-slots] open surface unsupported", {
        itemId: target.itemId,
        remote,
      });
      toast(message("settings.plugins.store.ui.unsupported"));
      return;
    }
    const onOpenDraftUi = current.shell.onOpenDraftUi;
    if (!sessionId && !onOpenDraftUi) {
      toast(message("settings.plugins.store.ui.needsSession"));
      return;
    }
    const bridge = current.bridge;
    const openPluginUi = current.openPluginUi;
    void (async () => {
      try {
        const surfaces = await bridge.listSurfaces({
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        });
        const surface = surfaces.find(
          (item) => item.pluginId === target.pluginId && item.id === target.surfaceId,
        );
        if (!surface) {
          logger.lifecycle.warn("[extension-slots] open surface unavailable", {
            itemId: target.itemId,
            surfaceId: target.surfaceId,
          });
          toast(message("settings.plugins.store.ui.unavailable"));
          return;
        }
        const request: DraftPluginUiOpenRequest = {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          remoteSessionId: null,
          pluginId: surface.pluginId,
          surfaceId: surface.id,
          serverName: surface.server,
          resourceUri: surface.resourceUri,
          ...documentViewerInstance(surface.resourceUri),
          title: resolvePluginUiSurfaceTitle(surface.title, latestRef.current.locale),
        };
        logger.lifecycle.info("[extension-slots] open surface", {
          itemId: target.itemId,
          surfaceId: surface.id,
          path: sessionId ? "session" : "draft",
          sessionId,
        });
        if (sessionId && openPluginUi) openPluginUi({ ...request, parentSessionId: sessionId });
        else onOpenDraftUi?.(request);
      } catch (error) {
        logger.lifecycle.warn("[extension-slots] open surface failed", {
          itemId: target.itemId,
          message: error instanceof Error ? error.message : String(error),
        });
        toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
      }
    })();
  }, []);
}

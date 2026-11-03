import { documentViewerInstance, type DraftPluginUiOpenRequest } from "@/plugin-ui/contract.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { isRemoteWorkspaceIdentity, type ZCodePluginUiSurface } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/adapters/usePluginUiSurfaces.js";
import { useOpenPluginUi } from "@/plugin-ui/adapters/PluginUiProviders.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

export interface MarketPluginUiTarget {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId?: string | null;
  paneId?: string;
  onOpenDraftUi?: (request: DraftPluginUiOpenRequest) => void;
}

/** 市场只接现有会话与面板契约；不创建会话，也不保存另一份安装状态。 */
export function useMarketPluginUi(target: MarketPluginUiTarget) {
  const platform = useOptionalPlatform();
  const bridge = useOptionalServices()?.pluginUiBridgeService;
  const openSidePane = useOpenPluginUi();
  const { intl, locale } = useZCodeIntl();
  const key = `${target.workspaceIdentity?.trim() || target.workspacePath}\0${target.remoteSessionId ?? ""}\0${target.sessionId ?? ""}\0${target.paneId ?? ""}`;
  const currentKey = useRef<string | null>(key);
  currentKey.current = key;
  // 页面退出后迟到的启用或目录响应不能打开另一会话的面板。
  useEffect(() => {
    currentKey.current = key;
    return () => {
      currentKey.current = null;
    };
  }, [key]);
  const [selection, setSelection] = useState<{
    key: string;
    surfaces: ZCodePluginUiSurface[];
  } | null>(null);
  const surfaces = selection?.key === key ? selection.surfaces : [];
  const closeSelection = useCallback(() => setSelection(null), []);
  const selectSurface = useCallback(
    (surface: ZCodePluginUiSurface) => {
      if (currentKey.current !== key || !target.workspacePath) return;
      const request: DraftPluginUiOpenRequest = {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId ?? null,
        pluginId: surface.pluginId,
        surfaceId: surface.id,
        serverName: surface.server,
        resourceUri: surface.resourceUri,
        ...documentViewerInstance(surface.resourceUri),
        title: resolvePluginUiSurfaceTitle(surface.title, locale),
      };
      if (target.onOpenDraftUi) target.onOpenDraftUi(request);
      else if (target.sessionId && openSidePane)
        openSidePane({ ...request, parentSessionId: target.sessionId });
      closeSelection();
    },
    [closeSelection, key, locale, openSidePane, target],
  );

  const open = useCallback(
    async (pluginId: string, enable?: () => Promise<boolean>) => {
      if (
        !platform?.pluginSandbox ||
        !bridge ||
        target.remoteSessionId ||
        isRemoteWorkspaceIdentity(target.workspaceIdentity ?? "")
      ) {
        toast(intl.formatMessage({ id: "settings.plugins.store.ui.unsupported" }));
        return;
      }
      if (
        !target.workspacePath ||
        (!target.onOpenDraftUi && (!target.sessionId || !openSidePane))
      ) {
        toast(intl.formatMessage({ id: "settings.plugins.store.ui.needsSession" }));
        return;
      }
      try {
        if (enable && !(await enable())) return;
        if (currentKey.current !== key) return;
        const available = (
          await bridge.listSurfaces({
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
          })
        ).filter((surface) => surface.pluginId === pluginId);
        if (currentKey.current !== key) return;
        if (available.length === 1) selectSurface(available[0]!);
        else if (available.length > 1) setSelection({ key, surfaces: available });
        else toast(intl.formatMessage({ id: "settings.plugins.store.ui.unavailable" }));
      } catch (error) {
        logger.warn("[plugins] 打开插件界面失败", { pluginId, error: String(error) });
        toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
      }
    },
    [bridge, intl, key, openSidePane, platform, selectSurface, target],
  );
  return { open, surfaces, selectSurface, closeSelection };
}

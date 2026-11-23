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
  /** 当前项目覆盖禁用导致没有面板时，提示并经此进入插件管理（当前项目视图）；缺省只显示通用提示。 */
  onManageWorkspacePlugins?: () => void;
}

/** 市场只接现有会话与面板契约；不创建会话，也不保存另一份安装状态。 */
export function useMarketPluginUi(target: MarketPluginUiTarget) {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const bridge = services?.pluginUiBridgeService;
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
        else {
          // 市场卡片读 User 层，User 已启用而当前项目覆盖禁用时面板为空。曾在写入前先查生效状态，
          // 等待期间按钮不忙碌，迟到结果会覆盖用户随后的启停。现在打开失败后才查，查询之后只提示不写配置。
          const effective = target.onManageWorkspacePlugins
            ? await services?.pluginManagementService
                .listPlugins({
                  workspacePath: target.workspacePath,
                  ...(target.workspaceIdentity
                    ? { workspaceIdentity: target.workspaceIdentity }
                    : {}),
                })
                .then((result) => result.plugins.find((plugin) => plugin.id === pluginId))
                .catch((error: unknown) => {
                  logger.warn("[plugins] 查询插件生效状态失败", { pluginId, error: String(error) });
                  return undefined;
                })
            : undefined;
          if (currentKey.current !== key) return;
          if (effective?.enabled === false && effective.enabledSource === "workspace") {
            // 默认样式的 toast 不渲染操作按钮，引导入口需要 info 样式。
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.disabledInWorkspace" }), {
              variant: "info",
              durationMs: 8000,
              actionLabel: intl.formatMessage({ id: "settings.plugins.store.manageInstalled" }),
              onAction: target.onManageWorkspacePlugins,
            });
          } else toast(intl.formatMessage({ id: "settings.plugins.store.ui.unavailable" }));
        }
      } catch (error) {
        logger.warn("[plugins] 打开插件界面失败", { pluginId, error: String(error) });
        toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
      }
    },
    [bridge, intl, key, openSidePane, platform, selectSurface, services, target],
  );
  return { open, surfaces, selectSurface, closeSelection };
}

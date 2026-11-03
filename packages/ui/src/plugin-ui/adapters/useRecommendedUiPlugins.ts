import { withPluginTelemetry } from "@zcode/services";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  buildStoreItems,
  isItemBusy,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { useUiPluginRecommendations } from "@/plugin-ui/adapters/useUiPluginRecommendations.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { logger } from "@/logger.js";

/** 推荐曝光读取完整市场目录；安装和启用继续由现有管理 store 与 CLI 负责。 */
export function useRecommendedUiPlugins(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  paneId?: string;
  remoteSessionId?: string | null;
}) {
  const {
    pluginManagementService: service,
    skillsService,
    pluginUiBridgeService: bridge,
  } = useServices();
  const store = useScopedPluginManagementStore(service);
  const state = store();
  const { recommendations, loading: configLoading } = useUiPluginRecommendations(
    target.sessionId !== null,
  );
  const key = JSON.stringify([
    target.workspacePath,
    target.workspaceIdentity,
    target.sessionId,
    target.paneId,
    target.remoteSessionId,
  ]);
  const context = useMemo(() => ({ key, service }), [key, service]);
  const current = useRef<typeof context | null>(context);
  current.current = context;
  const [ready, setReady] = useState<typeof context>();
  const [failure, setFailure] = useState<{
    context: typeof context;
    message: string;
  }>();
  useEffect(() => {
    let active = true;
    current.current = context;
    setReady(undefined);
    if (service && target.sessionId !== null) {
      void store
        .getState()
        .initialize({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          pluginService: service,
        })
        .then(() => {
          if (active) setReady(context);
        });
    }
    return () => {
      active = false;
      current.current = null;
    };
  }, [context, service, store, target.workspaceIdentity, target.workspacePath, target.sessionId]);
  const items = ready === context ? buildStoreItems(state) : [];
  const entries = recommendations.flatMap((entry, index) => {
    const item = items.find((candidate) => candidate.id === entry.pluginId);
    if (
      !item ||
      recommendations.findIndex(
        (candidate) =>
          candidate.pluginId === entry.pluginId && candidate.surfaceId === entry.surfaceId,
      ) !== index
    )
      return [];
    return [{ ...entry, item }];
  });
  // 已安装插件优先展示；稳定排序保留各组原有的推荐顺序，暂停的插件仍算已安装。
  entries.sort((a, b) => Number(b.item.installed) - Number(a.item.installed));
  const isCurrent = () => current.current === context;
  const prepare = async (item: StorePluginItem) => {
    // 读取 store 的即时状态，同插件重复点击被拦截，其他插件不受影响。
    if (!isCurrent() || !service || isItemBusy(item, store.getState())) return;
    setFailure(undefined);
    try {
      const management = store.getState();
      const operationService = withPluginTelemetry(service, {
        entry: "recommended_ui",
        client_kind: "desktop",
      });
      const succeeded = !item.installed
        ? item.restorable
          ? await management.restoreBuiltin(item.id, operationService)
          : await management.installPlugin(item.name, item.marketplace, operationService, "user")
        : await management.setEnabled(item.id, true, operationService, "workspace");
      if (!succeeded) {
        const message = store.getState().error;
        if (message && isCurrent()) setFailure({ context, message });
        return;
      }
      if (!item.installed) {
        await invalidateDeferredDraftSessionForSkillChange({
          ...target,
          reason: "settings-plugin-enabled",
        });
        await refreshSharedSkillStoreForWorkspace({ ...target, skillsService });
      }
      // 成功只刷新安装/启用态，不替用户打开面板；旧目标完成也不能打开新会话。
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[plugin-ui] 推荐插件操作失败", { pluginId: item.id, message });
        setFailure({ context, message });
      }
    }
  };
  const resolveSurface = async (pluginId: string, surfaceId: string) => {
    if (!bridge) return null;
    try {
      const surfaces = await bridge.listSurfaces({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
      if (!isCurrent()) return undefined;
      return (
        surfaces.find((surface) => surface.pluginId === pluginId && surface.id === surfaceId) ??
        null
      );
    } catch (error) {
      if (!isCurrent()) return undefined;
      logger.warn("[plugin-ui] 推荐面板读取失败", { pluginId, message: String(error) });
      return null;
    }
  };
  return {
    entries,
    loading:
      target.sessionId !== null && (configLoading || (Boolean(service) && ready !== context)),
    resolveSurface,
    prepare,
    isBusy: (item: StorePluginItem) => isItemBusy(item, state),
    error: failure?.context === context ? failure.message : null,
  };
}

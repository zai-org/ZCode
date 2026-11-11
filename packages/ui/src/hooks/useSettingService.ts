/**
 * useSettingService —— 设置服务 hooks
 */
import { useState, useEffect, useCallback } from "react";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@zcode/shared";
import type { IServiceAccessor, ISettingService } from "@zcode/services";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";

type SettingsSnapshot = {
  settings: AppSettings | null;
  loading: boolean;
  error: unknown | null;
};

const INITIAL_SETTINGS_SNAPSHOT: SettingsSnapshot = {
  settings: null,
  loading: true,
  error: null,
};
const snapshots = new Map<string, SettingsSnapshot>();
const inflightRefreshes = new Map<string, Promise<void>>();
const listenersByKey = new Map<string, Set<(snapshot: SettingsSnapshot) => void>>();
const defaultCacheKeyByServices = new WeakMap<object, string>();
let nextDefaultCacheKey = 0;

function resolveSettingsCacheKey(
  explicitCacheKey: string | undefined,
  settingService: object | undefined,
): string {
  const explicit = explicitCacheKey?.trim();
  if (explicit) return explicit;

  // 测试/SSR 的最小 ServiceAccessor 可能暂时没有 settingService；不要把 undefined
  // 作为 WeakMap key 抛出同步异常，真实 Host 服务就绪后仍会使用按服务隔离的缓存键。
  if (!settingService) return "settings-services:missing";

  const existing = defaultCacheKeyByServices.get(settingService);
  if (existing) return existing;

  // Bug 原因：默认 cacheKey 曾固定为 "local"。远端 workspace 的 SessionPane 与
  // Controller SettingsPage 同时挂载时会互相覆盖同一快照，使 Source 选择器消失，
  // 也可能把本机运行偏好投影到远端。缓存必须跟服务 accessor 的权威边界一致。
  const created = `settings-services:${++nextDefaultCacheKey}`;
  defaultCacheKeyByServices.set(settingService, created);
  return created;
}

function getSettingsSnapshot(cacheKey: string): SettingsSnapshot {
  return snapshots.get(cacheKey) ?? INITIAL_SETTINGS_SNAPSHOT;
}

function setSettingsSnapshot(cacheKey: string, snapshot: SettingsSnapshot): void {
  snapshots.set(cacheKey, snapshot);
  for (const listener of listenersByKey.get(cacheKey) ?? []) {
    listener(snapshot);
  }
}

async function refreshSharedSettings(cacheKey: string, getSettings: () => Promise<AppSettings>) {
  const inflight = inflightRefreshes.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  setSettingsSnapshot(cacheKey, {
    ...getSettingsSnapshot(cacheKey),
    loading: true,
    error: null,
  });

  const refreshPromise = (async () => {
    try {
      const result = await getSettings();
      setSettingsSnapshot(cacheKey, {
        settings: result,
        loading: false,
        error: null,
      });
    } catch (error) {
      setSettingsSnapshot(cacheKey, {
        // 修复原因：设置读取失败时保留旧快照，避免一次刷新错误把已可用的设置页降级为空状态。
        settings: getSettingsSnapshot(cacheKey).settings,
        loading: false,
        error,
      });
    }
  })().finally(() => {
    inflightRefreshes.delete(cacheKey);
  });
  inflightRefreshes.set(cacheKey, refreshPromise);

  return refreshPromise;
}

export async function updateSettingsAndRefreshSnapshot(params: {
  settingService: Pick<ISettingService, "get" | "update">;
  patch: Partial<AppSettings>;
}): Promise<void> {
  const cacheKey = resolveSettingsCacheKey(undefined, params.settingService);
  await params.settingService.update(params.patch);
  await refreshSharedSettings(cacheKey, () => params.settingService.get());
}

/** 获取和更新应用设置 */
export function useSettings(options: { cacheKey?: string; services?: IServiceAccessor } = {}) {
  const contextualServices = useServices();
  // Bug 原因：SettingsPage 可在远端 workspace 的 ServiceProvider 下渲染；若继续隐式取当前
  // context，“记住 Source 选择”会写入远端 setting，Controller 本地快照随后把选择重置为本机。
  const settingsServices = options.services ?? contextualServices;
  const { botsService, broadcastService, settingService, zcodeAgentService } = settingsServices;
  const platform = usePlatform();
  const cacheKey = resolveSettingsCacheKey(options.cacheKey, settingService);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(() => getSettingsSnapshot(cacheKey));

  const refresh = useCallback(async () => {
    await refreshSharedSettings(cacheKey, () => settingService.get());
  }, [cacheKey, settingService]);

  useEffect(() => {
    const listener = (nextSnapshot: SettingsSnapshot) => {
      setSnapshot(nextSnapshot);
    };

    const listeners = listenersByKey.get(cacheKey) ?? new Set();
    listeners.add(listener);
    listenersByKey.set(cacheKey, listeners);
    setSnapshot(getSettingsSnapshot(cacheKey));
    void refresh();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByKey.delete(cacheKey);
    };
  }, [cacheKey, refresh]);

  useEffect(() => {
    return (
      platform.onSettingsChanged?.(() => {
        void refresh();
      }) ?? (() => {})
    );
  }, [platform, refresh]);

  const update = useCallback(
    async (
      patch: Partial<AppSettings>,
      expectedAccountSettings?: Parameters<ISettingService["update"]>[1],
    ) => {
      try {
        if (expectedAccountSettings) await settingService.update(patch, expectedAccountSettings);
        else await settingService.update(patch);
      } catch (error) {
        // 原因：CAS 失败后页面仍持有旧快照；重读事实后报告失败，下一次用户重试才有新预期。
        if (expectedAccountSettings) await refresh();
        throw error;
      }
      platform.syncAppSettings?.(patch);
      await refresh();
      if (
        typeof patch.askUserQuestionAutoResolutionEnabled === "boolean" ||
        typeof patch.modelIoFullRetentionEnabled === "boolean" ||
        typeof patch.pluginAutoRecommendationEnabled === "boolean"
      ) {
        const currentSettings = getSettingsSnapshot(cacheKey).settings;
        const preferences = {
          pluginAutoRecommendationEnabled:
            patch.pluginAutoRecommendationEnabled ??
            currentSettings?.pluginAutoRecommendationEnabled === true,
          askUserQuestionAutoResolutionEnabled:
            patch.askUserQuestionAutoResolutionEnabled ??
            currentSettings?.askUserQuestionAutoResolutionEnabled !== false,
          modelIoFullRetentionEnabled:
            patch.modelIoFullRetentionEnabled ??
            currentSettings?.modelIoFullRetentionEnabled === true,
        };
        const syncResults = await Promise.allSettled([
          zcodeAgentService.syncAppRuntimePreferences(preferences),
          botsService.syncAppRuntimePreferences(preferences),
        ]);
        const syncError = syncResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )?.reason;
        await broadcastService.send({
          channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
          payload: preferences,
        });
        if (syncError) {
          throw syncError;
        }
      }
    },
    [botsService, broadcastService, cacheKey, settingService, zcodeAgentService, platform, refresh],
  );

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    error: snapshot.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}

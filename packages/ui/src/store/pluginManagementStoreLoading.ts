import type { IPluginManagementService } from "@zcode/services";
import {
  remoteHostIdFromWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type ZCodePluginScope,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildWorkspaceKey(
  workspacePath: string,
  workspaceIdentity: string | null,
  authorityKey: string | null,
): string {
  return `${authorityKey?.trim() || "workspace"}\0${workspaceIdentity?.trim() || workspacePath}`;
}

// 只共享同服务、同身份、同配置投影的在途查询；每个视图仍独立写回和保存错误态。
const loadsByService = new WeakMap<
  IPluginManagementService,
  Map<string, { task: Promise<Partial<PluginManagementState>>; revision: number }>
>();
export interface PluginManagementChange {
  owner?: () => PluginManagementState;
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  scope: ZCodePluginScope;
}
const changeListeners = new Set<(change: PluginManagementChange) => void | Promise<void>>();
let revision = 0;
export const getPluginManagementRevision = () => revision;
export function subscribePluginManagementChanges(
  listener: (change: PluginManagementChange) => void | Promise<void>,
) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
export function notifyPluginManagementChange(change: PluginManagementChange): void {
  revision += 1;
  // 派生视图不能拖住已成功的写入；发布失效信号后，后台查询各自收口。
  for (const listener of changeListeners) {
    void Promise.resolve()
      .then(() => listener(change))
      .catch((error: unknown) => {
        logger.warn("[plugins] background projection refresh failed", {
          message: toMessage(error),
        });
      });
  }
}
export function isPluginManagementChangeRelevant(
  state: Pick<
    PluginManagementState,
    "workspacePath" | "workspaceIdentity" | "authorityKey" | "configScope"
  >,
  change: PluginManagementChange,
): boolean {
  if (!state.workspacePath) return false;
  if (change.scope === "workspace") {
    return (
      state.configScope !== "user" &&
      buildWorkspaceKey(state.workspacePath, state.workspaceIdentity, state.authorityKey) ===
        buildWorkspaceKey(change.workspacePath, change.workspaceIdentity, change.authorityKey)
    );
  }
  const hostKey = (target: { workspaceIdentity: string | null; authorityKey: string | null }) => {
    const identity = target.workspaceIdentity ?? "";
    const sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    // Source 用户设置没有项目 identity，但和该 Source 下项目共享用户配置。
    return (
      target.authorityKey ??
      (sourceServerId
        ? `source-settings:${sourceServerId}`
        : (remoteHostIdFromWorkspaceIdentity(identity) ?? "local"))
    );
  };
  return hostKey(state) === hostKey(change);
}

// 单个 operationId 会被后一次安装覆盖；每次调用持有独立条目，完成时只移除自己。
// 通过条目身份清理，同名并发操作以及切换配置层后的新操作都不会被误清除。
export function beginPluginOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  id: string,
): () => void {
  const entry = { id };
  set({
    activeOperations: [...get().activeOperations, entry],
    operationVersion: get().operationVersion + 1,
    error: null,
    lastFailedPluginId: null,
  });
  return () => {
    set({ activeOperations: get().activeOperations.filter((operation) => operation !== entry) });
  };
}

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  const finish = beginPluginOperation(set, get, operationId);
  const operationVersion = get().operationVersion;
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationVersion === operationVersion;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // 并发刷新不能把已成功落盘的安装报告成失败；结果只受当前目标上下文约束。
    if (!isCurrentContext()) {
      await notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    await notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentContext();
  } catch (error) {
    // marketplace add/update 等通用操作失败：无插件目标，归属清空。
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // 旧操作不能覆盖同一配置层中新操作的错误态；只有最近发起的操作才回写。
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    finish();
  }
}

interface PluginLoadParams {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  pluginService: IPluginManagementService;
  fresh?: boolean;
  background?: boolean;
}
export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: PluginLoadParams,
): Promise<void> {
  let inFlightLoads = loadsByService.get(params.pluginService);
  if (!inFlightLoads) {
    inFlightLoads = new Map();
    loadsByService.set(params.pluginService, inFlightLoads);
  }
  const workspaceKey = buildWorkspaceKey(
    params.workspacePath,
    params.workspaceIdentity,
    params.authorityKey,
  );
  const loadKey = `${workspaceKey}\0${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  // 变更前启动的查询不能充当变更后的刷新；同一轮通知的新查询仍可共用。
  if (existing && (params.fresh || (params.background && existing.revision < revision))) {
    await existing.task;
    return loadInto(set, get, { ...params, fresh: false });
  }
  const request = existing ?? { task: runLoadInto({ ...params, workspaceKey }), revision };
  inFlightLoads.set(loadKey, request);
  try {
    const result = await request.task;
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.authorityKey !== params.authorityKey ||
      current.configScope !== params.configScope
    )
      return;
    // 其它视图的成功操作只刷新数据，不能抹掉本视图尚未处理的操作错误。
    set(
      params.background && current.error
        ? { ...result, error: current.error, lastFailedPluginId: current.lastFailedPluginId }
        : result,
    );
  } finally {
    if (inFlightLoads.get(loadKey) === request) inFlightLoads.delete(loadKey);
  }
}

async function runLoadInto(
  params: PluginLoadParams & { workspaceKey: string },
): Promise<Partial<PluginManagementState>> {
  // 列表的单插件协议错误曾丢弃成功目录；分别收口，失败接口不在这里重复请求。
  const [listResult, overviewResult] = await Promise.allSettled([
    params.pluginService.listPlugins({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      ...(params.configScope ? { configScope: params.configScope } : {}),
    }),
    params.pluginService.getPluginsOverview({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      ...(params.configScope ? { configScope: params.configScope } : {}),
    }),
  ]);
  const errors: string[] = [];
  for (const [method, result] of [
    ["list", listResult],
    ["overview", overviewResult],
  ] as const) {
    if (result.status === "rejected") {
      const message = toMessage(result.reason);
      errors.push(message);
      logger.error(`[plugins] ${method} failed`, {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        error: message,
      });
    }
  }
  const list = listResult.status === "fulfilled" ? listResult.value : undefined;
  const overview = overviewResult.status === "fulfilled" ? overviewResult.value : undefined;
  return {
    plugins: list?.plugins ?? [],
    marketplaces: overview?.marketplaces ?? [],
    // 目录失败表示来源未知，不能把仍在工作的已安装插件误判为孤立安装。
    marketplaceAvailabilityKnown: overview !== undefined,
    availablePlugins: overview?.availablePlugins ?? [],
    installedPlugins: overview?.installedPlugins ?? [],
    restorableBuiltins: overview?.restorableBuiltins ?? [],
    diagnostics: [...(list?.diagnostics ?? []), ...(overview?.diagnostics ?? [])],
    loading: false,
    lastFailedPluginId: null,
    error: errors.length > 0 ? errors.join("\n") : null,
  };
}

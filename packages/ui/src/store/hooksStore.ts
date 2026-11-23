import { create } from "zustand";
import type { Hook, HookConfig } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";

interface HooksStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  loadedWorkspaceKey: string | null;
  hooks: Hook[];
  loading: boolean;
  error: string | null;
  operatingHookId: string | null;
  initialize: (
    workspacePath: string | undefined,
    workspaceIdentity: string | undefined,
    hooksService: IHooksService,
    authorityKey?: string,
  ) => Promise<void>;
  /**
   * refresh 必须显式传入发起时的 target（path/identity/service 三元组）。
   * 旧签名只传 service，load 时才从 store 读 workspace——Trust 等待期间用户从
   * workspace A 切到 B 会形成「A 的 service + B 的 path/identity」，把 B 的列表
   * 污染成 A 的数据。现在三元组在调用点原子捕获，store 状态只用于漂移守卫。
   */
  refresh: (
    hooksService: IHooksService,
    target: {
      workspacePath?: string | null;
      workspaceIdentity?: string | null;
      authorityKey?: string | null;
    },
  ) => Promise<void>;
  addHook: (config: HookConfig, hooksService: IHooksService) => Promise<void>;
  updateHook: (id: string, config: HookConfig, hooksService: IHooksService) => Promise<void>;
  deleteHook: (id: string, hooksService: IHooksService) => Promise<void>;
  toggleHook: (id: string, enabled: boolean, hooksService: IHooksService) => Promise<void>;
  importHook: (id: string, hooksService: IHooksService) => Promise<void>;
}

type StoreSet = (state: Partial<HooksStoreState>) => void;
type StoreGet = () => HooksStoreState;

const inflightLoads = new Map<string, Promise<void>>();

export function getHooksCacheKey(
  workspacePath: string,
  workspaceIdentity?: string | null,
  authorityKey?: string | null,
): string {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  // 受管 worktree 审核时 identity 是项目 key、发现路径是 worktree（D23）。只用 key 会让
  // 项目与 worktree 两份投影共用缓存和 in-flight 去重，切换后读到另一份；路径不同就并入 key。
  const targetKey =
    workspaceKey === workspacePath ? workspaceKey : `${workspaceKey}\0${workspacePath}`;
  return authorityKey?.trim() ? `${authorityKey.trim()}\0${targetKey}` : targetKey;
}

// Bugfix：store 是单例，切换 workspace 后先发起的加载可能后到。任何异步结果写回 store 之前
// 都要比对发起时的 target key，否则旧 workspace 的 hooks 会覆盖当前投影，并被后续写操作落盘
// 到当前 workspace。
function currentWorkspaceKey(get: StoreGet): string | null {
  const { workspacePath, workspaceIdentity, authorityKey } = get();
  return workspacePath ? getHooksCacheKey(workspacePath, workspaceIdentity, authorityKey) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildZCodeHookLocation(
  workspacePath: string,
  storageLevel: "user" | "project" = "user",
): Hook["location"] {
  return storageLevel === "project"
    ? {
        source: "zcode",
        scope: "project",
        directoryPath: "",
        projectPath: workspacePath,
      }
    : {
        source: "zcode",
        scope: "user",
        directoryPath: "",
      };
}

function isEditableHook(hook: Hook): boolean {
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

function hookFromConfig(config: HookConfig, workspacePath: string): Hook {
  return {
    id: `hook-${crypto.randomUUID()}`,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    ...(config.type === "process" ? { args: config.args ?? [] } : {}),
    ...(config.type === "command" && config.async !== undefined ? { async: config.async } : {}),
    ...(config.type === "command" && config.shell !== undefined ? { shell: config.shell } : {}),
    ...(config.statusMessage ? { statusMessage: config.statusMessage } : {}),
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? true,
    custom: config.custom,
    location: buildZCodeHookLocation(workspacePath, config.storageLevel),
  };
}

function updateHookFromConfig(hook: Hook, config: HookConfig): Hook {
  return {
    ...hook,
    event: config.event,
    matcher: config.matcher,
    type: config.type,
    command: config.command,
    args: config.type === "process" ? (config.args ?? []) : undefined,
    async: config.type === "command" ? config.async : undefined,
    shell: config.type === "command" ? config.shell : undefined,
    statusMessage: config.statusMessage,
    timeout: config.timeout ?? 60,
    enabled: config.enabled ?? hook.enabled,
    custom: config.custom,
  };
}

async function loadCurrentHooks(get: StoreGet, set: StoreSet, hooksService: IHooksService) {
  const { workspacePath, workspaceIdentity, authorityKey } = get();
  if (!workspacePath) return;
  const key = getHooksCacheKey(workspacePath, workspaceIdentity, authorityKey);
  const result = await hooksService.loadHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  if (currentWorkspaceKey(get) !== key) return;
  set({
    hooks: result.hooks,
    loadedWorkspaceKey: key,
  });
}

async function persistHooks(
  hooks: Hook[],
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
): Promise<void> {
  const { workspacePath, workspaceIdentity } = get();
  if (!workspacePath) throw new Error("No workspace path set");
  await hooksService.saveHooks({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    hooks,
  });
  await loadCurrentHooks(get, set, hooksService);
}

// 五个写操作共享同一条乐观更新 → 持久化 → 回滚流程，收敛到一处以便 stale 守卫只写一遍。
async function applyHookMutation(
  get: StoreGet,
  set: StoreSet,
  hooksService: IHooksService,
  updatedHooks: Hook[],
  operatingHookId?: string,
): Promise<void> {
  const previousHooks = get().hooks;
  const key = currentWorkspaceKey(get);
  set({
    hooks: updatedHooks,
    error: null,
    ...(operatingHookId ? { operatingHookId } : {}),
  });
  try {
    await persistHooks(updatedHooks, get, set, hooksService);
    set({ operatingHookId: null });
  } catch (error) {
    // 保存失败时若已切换 workspace，把捕获的旧 hooks 回滚进 store 会污染当前 workspace。
    set(
      currentWorkspaceKey(get) === key
        ? { hooks: previousHooks, operatingHookId: null, error: errorMessage(error) }
        : { operatingHookId: null },
    );
    throw error;
  }
}

export const useHooksStore = create<HooksStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  authorityKey: null,
  loadedWorkspaceKey: null,
  hooks: [],
  loading: false,
  error: null,
  operatingHookId: null,

  initialize: async (workspacePath, workspaceIdentity, hooksService, authorityKey) => {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const normalizedAuthorityKey = authorityKey?.trim() || null;
    set({
      workspacePath: workspacePath ?? null,
      workspaceIdentity: normalizedIdentity,
      authorityKey: normalizedAuthorityKey,
    });
    if (!workspacePath) {
      set({ hooks: [], loading: false, loadedWorkspaceKey: null });
      return;
    }
    const key = getHooksCacheKey(workspacePath, normalizedIdentity, normalizedAuthorityKey);
    // Bugfix：切到另一个 workspace 时立即丢弃上一份投影，避免新数据到达前展示并操作别人的 hooks。
    if (get().loadedWorkspaceKey !== key) {
      set({ hooks: [], loadedWorkspaceKey: null });
    }
    const existing = inflightLoads.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await hooksService.loadHooks({
          workspacePath,
          ...(normalizedIdentity ? { workspaceIdentity: normalizedIdentity } : {}),
        });
        if (currentWorkspaceKey(get) !== key) return;
        set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
      } catch (error) {
        if (currentWorkspaceKey(get) !== key) return;
        set({ error: errorMessage(error), loading: false });
      } finally {
        inflightLoads.delete(key);
      }
    })();
    inflightLoads.set(key, promise);
    await promise;
  },

  refresh: async (hooksService, target) => {
    // 三元组在调用点原子捕获：service 与 path/identity 必须来自同一时刻的同一 target。
    const targetPath = target.workspacePath ?? null;
    const targetIdentity = target.workspaceIdentity?.trim() || null;
    const targetAuthorityKey = target.authorityKey?.trim() || null;
    if (!targetPath) return;
    const key = getHooksCacheKey(targetPath, targetIdentity, targetAuthorityKey);
    // Bugfix：发起前 target 已不是当前 workspace（Trust 等待期间用户已切走）时必须直接
    // 放弃——loading/error 是全局单一字段，若仍 set({loading:true}) 会在结果因 key 不匹配
    // 被丢弃后，把当前 workspace 永久留在 loading=true。
    if (currentWorkspaceKey(get) !== key) return;
    set({ loading: true, error: null });
    try {
      const result = await hooksService.loadHooks({
        workspacePath: targetPath,
        ...(targetIdentity ? { workspaceIdentity: targetIdentity } : {}),
      });
      // 等待期间 store 已切到别的 workspace → 本次结果对当前投影无效，静默丢弃；
      // loading 生命周期归新 workspace 自己的 initialize 所有，这里不得触碰。
      if (currentWorkspaceKey(get) !== key) return;
      set({ hooks: result.hooks, loadedWorkspaceKey: key, loading: false });
    } catch (error) {
      if (currentWorkspaceKey(get) !== key) return;
      set({ error: errorMessage(error), loading: false });
    }
  },

  addHook: async (config, hooksService) => {
    const { workspacePath, hooks } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    await applyHookMutation(get, set, hooksService, [
      ...hooks,
      hookFromConfig(config, workspacePath),
    ]);
  },

  updateHook: async (id, config, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? updateHookFromConfig(hook, config) : hook)),
      id,
    );
  },

  deleteHook: async (id, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.filter((hook) => hook.id !== id),
      id,
    );
  },

  toggleHook: async (id, enabled, hooksService) => {
    const { hooks } = get();
    const target = hooks.find((hook) => hook.id === id);
    if (!target || !isEditableHook(target)) throw new Error("Hook is not editable");
    await applyHookMutation(
      get,
      set,
      hooksService,
      hooks.map((hook) => (hook.id === id ? { ...hook, enabled } : hook)),
      id,
    );
  },

  importHook: async (id, hooksService) => {
    const { hooks, workspacePath } = get();
    if (!workspacePath) throw new Error("No workspace path set");
    const source = hooks.find((hook) => hook.id === id);
    if (!source || source.location?.source === "zcode") throw new Error("Hook is not importable");
    const imported: Hook = {
      ...source,
      id: `hook-${crypto.randomUUID()}`,
      enabled: true,
      location: buildZCodeHookLocation(workspacePath, source.location?.scope ?? "user"),
    };
    await applyHookMutation(get, set, hooksService, [...hooks, imported], id);
  },
}));

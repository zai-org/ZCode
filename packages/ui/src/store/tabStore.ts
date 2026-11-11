/* oxlint-disable eslint(max-lines) */
/**
 * Tab Store —— 多标签页状态管理
 *
 * 每个窗口拥有独立的 tab store（不跨窗口广播）。
 * 标签页状态通过 settingService 持久化（见 useTabPersistence）。
 */
import { create } from "zustand";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import {
  createUuid,
  resolveWorkspaceKey,
  type RemoteTarget,
  type TabId,
  type TabState,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  persistWorkspaceExpandedPreference,
  readWorkspaceExpansionState,
  resolveExpandedWorkspacePaths,
  type WorkspaceExpansionState,
} from "@/lib/workspaceExpansionPreference.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

export const SETTINGS_TAB_ID = "__settings__" satisfies TabId;

export type WorkspaceAvailability = "available" | "unavailable-local-directory";

export interface SettingsTabState {
  id: typeof SETTINGS_TAB_ID;
  kind: "settings";
  label: "settings";
}

export interface WorkspaceTabState extends TabState {
  kind: "workspace";
  /** 启动恢复的激活页签可消费既有 pane 选择；只属窗口导航，不写回 settings。 */
  restorePaneSession?: boolean;
  /** 启动期一次性校验结果；不持久化，运行期间不重检。 */
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  /** Host bind rekey 的前一个 identity；仅用于一次生命周期 transition 判定，不持久化。 */
  previousWorkspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface WorkspaceTabOptions {
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  /** Host stable identity 换代前的 route identity，只用于原子 rekey 已有 tab。 */
  previousWorkspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RestorableWorkspaceTab {
  workspacePath: string;
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export type WindowTabState = WorkspaceTabState | SettingsTabState;

export function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

export function isWorkspaceTabReadOnly(tab: WindowTabState): tab is WorkspaceTabState & {
  availability: "unavailable-local-directory";
} {
  return isWorkspaceTab(tab) && tab.availability === "unavailable-local-directory";
}

export function isWorkspaceReadOnly(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return state.tabs.some(
    (tab) =>
      isWorkspaceTabReadOnly(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
  );
}

export function isSettingsTab(tab: WindowTabState): tab is SettingsTabState {
  return tab.kind === "settings";
}

// ============================================================================
// State 定义
// ============================================================================

export interface TabStoreState {
  /** 仅窗口内的一次性导航请求，目标 Shell 消费后清除，不持久化。 */
  pendingFileManagerTarget: FileManagerTarget | null;
  requestFileManager: (target: FileManagerTarget) => void;
  consumeFileManager: (target: FileManagerTarget) => boolean;
  /** 当前窗口所有打开的标签页（有序） */
  tabs: WindowTabState[];
  /** 当前激活的标签页 ID，null 表示无激活标签 */
  activeTabId: TabId | null;
  /** 当前或最近一次激活的 workspace 路径 */
  activeWorkspacePath: string | null;
  /** 当前或最近一次激活的 workspace identity（远端同路径隔离） */
  activeWorkspaceIdentity: string | null;
  /** 左侧侧边栏中已展开的 workspace 路径集合 */
  expandedWorkspacePaths: Set<string>;
  /** 新增标签页，返回新 tab 的 ID */
  addTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** 确保 workspace 出现在任务区数据源中，但不抢走当前焦点 */
  ensureWorkspaceTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** 关闭标签页 */
  closeTab: (tabId: TabId, origin?: "user-close" | "restore" | "rekey") => void;
  /** Renderer lifecycle 使用的显式 close intent；不是持久化业务状态。 */
  lastClosedWorkspaceEvent: {
    sequence: number;
    workspaceKey: string;
    origin: "user-close" | "restore" | "rekey";
  } | null;
  /** 激活指定标签页 */
  activateTab: (tabId: TabId) => void;
  /** 拖拽排序：将 fromIndex 位置的 tab 移动到 toIndex */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /** 仅按 workspace 子序列重排，保留设置页等非 workspace tab 的位置槽位 */
  reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => void;
  /** 打开设置标签页（窗口内唯一） */
  openSettingsTab: () => void;
  /** 通过 workspace 路径激活 tab（跨窗口 focus 用），返回是否找到 */
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  /** 切换 workspace 的展开/收起态 */
  toggleWorkspaceExpanded: (path: string) => void;
  /** 展开当前任务区里的全部 workspace */
  expandAllWorkspaceTabs: (paths: string[]) => void;
  /** 收起当前任务区里的全部 workspace */
  collapseAllWorkspaceTabs: (paths: string[]) => void;
  /** 批量恢复标签页（启动时从持久化数据恢复用） */
  restoreTabs: (tabs: Array<string | RestorableWorkspaceTab>, activeIndex: number) => void;
  /** 启动首帧后补齐持久化标签页；保留当前 active identity 和用户在此期间新增的标签页。 */
  completeTabRestore: (tabs: Array<string | RestorableWorkspaceTab>) => void;
}

// ============================================================================
// 工具函数
// ============================================================================

/** 从路径提取文件夹名作为标签显示名 */
function labelFromPath(path: string): string {
  // 兼容 Windows 反斜杠和 Unix 正斜杠
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function createWorkspaceTab(
  workspacePath: string,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    id: createUuid(),
    kind: "workspace",
    workspacePath,
    label: labelFromPath(workspacePath),
    availability: options?.availability,
    remoteSessionId: options?.remoteSessionId,
    remoteTarget: options?.remoteTarget,
    workspaceIdentity: options?.workspaceIdentity,
    previousWorkspaceIdentity: options?.previousWorkspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose,
  };
}

function mergeWorkspaceTabOptions(
  tab: WorkspaceTabState,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  const merged: WorkspaceTabState = {
    ...tab,
    availability: options?.availability ?? tab.availability,
    remoteSessionId: options?.remoteSessionId ?? tab.remoteSessionId,
    remoteTarget: options?.remoteTarget ?? tab.remoteTarget,
    remoteHistoryId: options?.remoteHistoryId ?? tab.remoteHistoryId,
    workspaceIdentity: options?.workspaceIdentity ?? tab.workspaceIdentity,
    previousWorkspaceIdentity: options?.previousWorkspaceIdentity ?? tab.previousWorkspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath ?? tab.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose ?? tab.workspacePurpose,
  };
  // Cmd+N 会复用当前 tab；等值元数据不应制造新引用，导致 App 和整个项目侧栏重渲染。
  return Object.entries(merged).every(([key, value]) =>
    Object.is(tab[key as keyof WorkspaceTabState], value),
  )
    ? tab
    : merged;
}

function normalizeRestorableWorkspaceTab(
  tab: string | RestorableWorkspaceTab,
): RestorableWorkspaceTab {
  if (typeof tab === "string") {
    return {
      workspacePath: tab,
    };
  }

  return tab;
}

function createSettingsTab(): SettingsTabState {
  return {
    id: SETTINGS_TAB_ID,
    kind: "settings",
    label: "settings",
  };
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return nextItems;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function ensureWorkspaceExpanded(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.add(workspacePath);
  return next;
}

function pruneExpandedWorkspace(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (!expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.delete(workspacePath);
  return next;
}

// ============================================================================
// Store 创建
// ============================================================================

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createTabStore(storage: StorageLike | null | undefined = undefined) {
  return create<TabStoreState>()((set, get) => ({
    tabs: [],
    pendingFileManagerTarget: null,
    requestFileManager: (target) => {
      // 先记录目标再激活 workspace，目标 Shell 完成切换后才创建标签，避免借用旧任务归属。
      set({ pendingFileManagerTarget: target });
      get().addTab(target.workspacePath, {
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.workspaceRemoteSessionId,
      });
    },
    consumeFileManager: (target) => {
      if (get().pendingFileManagerTarget !== target) return false;
      set({ pendingFileManagerTarget: null });
      return true;
    },
    activeTabId: null,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: new Set<string>(),

    addTab: (workspacePath: string, options) => {
      // 之前复用 tab 只按 workspacePath + history/session 片段判断，
      // 同路径不同远端（例如 10.0.0.1:/home/dev 与 10.0.0.2:/home/dev）会被当成一个 tab。
      // 这里优先按 workspaceIdentity（authority + canonicalPath）匹配，路径只作为最后兜底。
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        const merged = mergeWorkspaceTabOptions(existing, options);
        persistWorkspaceExpandedPreference(
          resolveWorkspaceKey({
            ...existing,
            workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
          }),
          true,
          storage,
        );
        set((state) => ({
          // 远程 workspace 手动重连成功后会再次走 addTab，
          // 但这里之前命中已有 tab 只做激活，不把新的 remoteSessionId 等元数据写回旧 tab。
          // 结果 UI 仍然读到“remoteSessionId 还没更新”的旧状态，
          // reconnect 按钮就会一直显示，像是还没连上。这里在复用 tab 时同步覆盖远程会话字段。
          tabs:
            merged === existing
              ? state.tabs
              : state.tabs.map((tab) => (tab.id === existing.id ? merged : tab)),
          activeTabId: existing.id,
          activeWorkspacePath: existing.workspacePath,
          // Settings 页的插件管理要按“最近激活 workspace”的 identity 继续命中同一远端。
          // 之前这里只保存路径，切到 settings tab 后 identity 会丢失，导致同路径远端隔离失效。
          activeWorkspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity ?? null,
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            resolveWorkspaceKey({
              ...existing,
              workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
            }),
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);
      set((state) => ({
        // 左侧 workspace 列表现在支持手动排序，但新打开项目仍然默认追加到底部，
        // 连续开新项目时最新 workspace 总要滚到下面找，和侧栏“最新上下文优先”的浏览方式不一致。
        // 这里改成把新 workspace 插到最前面，让新打开的项目直接出现在列表顶部。
        tabs: [tab, ...state.tabs],
        activeTabId: tab.id,
        activeWorkspacePath: workspacePath,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          resolveWorkspaceKey(tab),
        ),
      }));
      return tab.id;
    },

    ensureWorkspaceTab: (workspacePath: string, options) => {
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(
          resolveWorkspaceKey({
            ...existing,
            workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
          }),
          true,
          storage,
        );
        set((state) => {
          const rekeysActiveWorkspace =
            state.activeTabId === existing.id ||
            (state.activeWorkspacePath === existing.workspacePath &&
              state.activeWorkspaceIdentity === existing.workspaceIdentity);
          return {
            tabs: state.tabs.map((tab) =>
              tab.id !== existing.id || !isWorkspaceTab(tab)
                ? tab
                : mergeWorkspaceTabOptions(tab, options),
            ),
            // Bug 原因：stable identity 原地 rekey 只更新了 tab，activeWorkspaceIdentity
            // 仍保留 legacy route key，当前或最近焦点会继续按旧 scope 查询任务与服务。
            // ensure 不改变焦点，但必须让 active workspace identity 与 tab 本体原子一致。
            activeWorkspaceIdentity: rekeysActiveWorkspace
              ? (options?.workspaceIdentity ?? existing.workspaceIdentity ?? null)
              : state.activeWorkspaceIdentity,
            expandedWorkspacePaths: ensureWorkspaceExpanded(
              state.expandedWorkspacePaths,
              resolveWorkspaceKey({
                ...existing,
                workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
              }),
            ),
          };
        });
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);
      set((state) => ({
        // Bugfix: Claude 历史导入可能把任务写入一个“当前窗口从未打开过”的 workspace。
        // 项目树的行集合来自 Host readProjects，不依赖 tab；但导入目录若没有 tab，本窗口就没有
        // 可导航到它的入口。这里补一个仅确保可见的入口，不打断用户当前正在看的 tab / settings 上下文。
        tabs: [tab, ...state.tabs],
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          resolveWorkspaceKey(tab),
        ),
      }));
      return tab.id;
    },

    lastClosedWorkspaceEvent: null,

    closeTab: (tabId: TabId, origin = "user-close") => {
      const stateBefore = get();
      const { tabs, activeTabId } = stateBefore;
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index === -1) {
        return;
      }

      const closingTab = tabs[index] ?? null;
      const newTabs = tabs.filter((t) => t.id !== tabId);
      const closedWorkspaceKey =
        closingTab && isWorkspaceTab(closingTab)
          ? closingTab.workspaceIdentity?.trim() ||
            (closingTab.remoteSessionId || closingTab.remoteTarget
              ? closingTab.workspacePath
              : null)
          : null;

      // 如果关闭的是当前激活的 tab，需要切换到相邻 tab
      let newActiveTabId = activeTabId;
      if (activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveTabId = null;
        } else {
          // 优先激活右边的 tab，如果是最后一个则激活左边
          const newIndex = Math.min(index, newTabs.length - 1);
          newActiveTabId = newTabs[newIndex]!.id;
        }
      }

      const nextWorkspaceTab = newTabs.find((tab) => tab.id === newActiveTabId);
      const fallbackWorkspacePath = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspacePath;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspacePath ?? null;
        }

        return stateBefore.activeWorkspacePath;
      })();
      const fallbackWorkspaceIdentity = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspaceIdentity ?? null;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspaceIdentity ?? null;
        }

        return stateBefore.activeWorkspaceIdentity;
      })();

      const nextState = {
        tabs: newTabs,
        activeTabId: newActiveTabId,
        activeWorkspacePath: fallbackWorkspacePath,
        activeWorkspaceIdentity: fallbackWorkspaceIdentity,
        expandedWorkspacePaths: (() => {
          const prunedExpandedWorkspacePaths =
            closingTab && isWorkspaceTab(closingTab)
              ? pruneExpandedWorkspace(
                  stateBefore.expandedWorkspacePaths,
                  resolveWorkspaceKey(closingTab),
                )
              : stateBefore.expandedWorkspacePaths;

          // 关闭当前 workspace 后，主内容会自动切到相邻 tab。
          // 之前侧边栏把展开态放在组件本地状态时，会在 workspacePath 变化后顺手把接替项展开；
          // 现在改由 store 托管后，这个兜底也要一起搬过来，否则“关闭当前 tab”会留下一个已激活但折叠的 workspace。
          return fallbackWorkspacePath
            ? ensureWorkspaceExpanded(
                prunedExpandedWorkspacePaths,
                fallbackWorkspaceIdentity?.trim() || fallbackWorkspacePath,
              )
            : prunedExpandedWorkspacePaths;
        })(),
      };

      if (fallbackWorkspacePath) {
        persistWorkspaceExpandedPreference(
          fallbackWorkspaceIdentity?.trim() || fallbackWorkspacePath,
          true,
          storage,
        );
      }

      set(nextState);
      if (closedWorkspaceKey) {
        set((state) => ({
          lastClosedWorkspaceEvent: {
            sequence: (state.lastClosedWorkspaceEvent?.sequence ?? 0) + 1,
            workspaceKey: closedWorkspaceKey,
            origin,
          },
        }));
      }
    },

    activateTab: (tabId: TabId) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }

      const nextState = {
        activeTabId: tabId,
        activeWorkspacePath: isWorkspaceTab(tab)
          ? tab.workspacePath
          : stateBefore.activeWorkspacePath,
        activeWorkspaceIdentity: isWorkspaceTab(tab)
          ? (tab.workspaceIdentity ?? null)
          : stateBefore.activeWorkspaceIdentity,
        expandedWorkspacePaths: isWorkspaceTab(tab)
          ? ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, resolveWorkspaceKey(tab))
          : stateBefore.expandedWorkspacePaths,
      };

      if (isWorkspaceTab(tab)) {
        persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);
      }

      set(nextState);
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= state.tabs.length ||
          toIndex >= state.tabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const newTabs = moveItem(state.tabs, fromIndex, toIndex);
        return { tabs: newTabs };
      });
    },

    reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        const workspaceTabs = state.tabs.filter(isWorkspaceTab);
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= workspaceTabs.length ||
          toIndex >= workspaceTabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const reorderedWorkspaceTabs = moveItem(workspaceTabs, fromIndex, toIndex);
        let workspaceIndex = 0;
        const newTabs = state.tabs.map((tab) => {
          if (!isWorkspaceTab(tab)) {
            return tab;
          }

          return reorderedWorkspaceTabs[workspaceIndex++] ?? tab;
        });

        return { tabs: newTabs };
      });
    },

    openSettingsTab: () => {
      const existing = get().tabs.find(isSettingsTab);
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }

      const settingsTab = createSettingsTab();
      set((state) => ({
        tabs: [...state.tabs, settingsTab],
        activeTabId: settingsTab.id,
      }));
    },

    toggleWorkspaceExpanded: (path: string) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        const nextExpanded = !expandedWorkspacePaths.has(path);
        if (expandedWorkspacePaths.has(path)) {
          expandedWorkspacePaths.delete(path);
        } else {
          expandedWorkspacePaths.add(path);
        }

        persistWorkspaceExpandedPreference(path, nextExpanded, storage);

        return { expandedWorkspacePaths };
      });
    },

    expandAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.add(path);
          persistWorkspaceExpandedPreference(path, true, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    collapseAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.delete(path);
          persistWorkspaceExpandedPreference(path, false, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    activateTabByPath: (path: string, options) => {
      const stateBefore = get();
      // Bug 原因：未传 identity 时这里只按路径取第一个 tab；本地项目与远程项目同路径且远程 tab
      // 在前时，点击本地任务会激活远程 tab，主区继续显示远程任务。与 addTab 共用匹配规则：
      // 未传 identity 只命中本地 tab。
      const tab = stateBefore.tabs.find(
        (currentTab): currentTab is WorkspaceTabState =>
          isWorkspaceTab(currentTab) && isSameWorkspaceTab(currentTab, path, options),
      );
      if (!tab) {
        return false;
      }

      const nextState = {
        activeTabId: tab.id,
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          stateBefore.expandedWorkspacePaths,
          resolveWorkspaceKey(tab),
        ),
      };

      persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);

      set(nextState);
      return true;
    },

    restoreTabs: (tabsInput, activeIndex: number) => {
      if (tabsInput.length === 0) return;
      const tabs = tabsInput.map((tab) => {
        const normalized = normalizeRestorableWorkspaceTab(tab);
        return createWorkspaceTab(normalized.workspacePath, {
          remoteSessionId: normalized.remoteSessionId,
          remoteTarget: normalized.remoteTarget,
          workspaceIdentity: normalized.workspaceIdentity,
          workspacePurpose: normalized.workspacePurpose,
          availability: normalized.availability,
        });
      });
      const safeIndex = Math.min(Math.max(activeIndex, 0), tabs.length - 1);
      const activeWorkspaceTab = tabs[safeIndex];
      if (!activeWorkspaceTab || !isWorkspaceTab(activeWorkspaceTab)) {
        return;
      }
      activeWorkspaceTab.restorePaneSession = true;
      const expansionState: WorkspaceExpansionState = readWorkspaceExpansionState(storage);
      set({
        tabs,
        activeTabId: activeWorkspaceTab.id,
        activeWorkspacePath: activeWorkspaceTab.workspacePath,
        activeWorkspaceIdentity: activeWorkspaceTab.workspaceIdentity ?? null,
        expandedWorkspacePaths: resolveExpandedWorkspacePaths(
          tabs.map(resolveWorkspaceKey),
          expansionState,
        ),
      });
    },

    completeTabRestore: (tabsInput) => {
      if (tabsInput.length === 0) return;
      set((state) => {
        const consumedTabIds = new Set<TabId>();
        const completedTabs = tabsInput.map((tabInput) => {
          const normalized = normalizeRestorableWorkspaceTab(tabInput);
          const options: WorkspaceTabOptions = {
            remoteSessionId: normalized.remoteSessionId,
            remoteTarget: normalized.remoteTarget,
            workspaceIdentity: normalized.workspaceIdentity,
            localWorkspacePath: normalized.localWorkspacePath,
            workspacePurpose: normalized.workspacePurpose,
            availability: normalized.availability,
          };
          const existing = state.tabs.find(
            (tab): tab is WorkspaceTabState =>
              isWorkspaceTab(tab) &&
              !consumedTabIds.has(tab.id) &&
              isSameWorkspaceTab(tab, normalized.workspacePath, options),
          );
          if (existing) {
            consumedTabIds.add(existing.id);
            return mergeWorkspaceTabOptions(existing, options);
          }
          return createWorkspaceTab(normalized.workspacePath, options);
        });
        const extraWorkspaceTabs = state.tabs.filter(
          (tab): tab is WorkspaceTabState => isWorkspaceTab(tab) && !consumedTabIds.has(tab.id),
        );
        const nonWorkspaceTabs = state.tabs.filter((tab) => !isWorkspaceTab(tab));
        const tabs = [...extraWorkspaceTabs, ...completedTabs, ...nonWorkspaceTabs];
        const expansionState = readWorkspaceExpansionState(storage);

        // active-first 的第二阶段若再次调用 restoreTabs，会重建 active tab id，
        // 让已经挂载的会话视图丢失 identity；用户在首帧后新开的 tab 也会被覆盖。
        // 补齐阶段只合并缺失 tab，明确保留当前焦点和 active workspace 投影。
        return {
          tabs,
          activeTabId: state.activeTabId,
          activeWorkspacePath: state.activeWorkspacePath,
          activeWorkspaceIdentity: state.activeWorkspaceIdentity,
          expandedWorkspacePaths: resolveExpandedWorkspacePaths(
            tabs.filter(isWorkspaceTab).map(resolveWorkspaceKey),
            expansionState,
          ),
        };
      });
    },
  }));
}

export type TabStore = ReturnType<typeof createTabStore>;

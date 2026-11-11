/* eslint-disable max-lines -- task query cache 的 descriptor、membership 与 mutation 必须在同一 Zustand 事务里维护，拆散会增加缓存一致性风险。 */
import { create } from "zustand";
import type { ZCodeTaskListItem } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import {
  buildTaskEntityKey,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
  type TaskListCacheDescriptor,
  type TaskEntityKey,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TaskListMembershipState {
  pinned: boolean;
  archived: boolean;
}

interface TaskQueryCacheState {
  resultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  /** 覆盖正在提交或等待 membership 确认的 unreadAt 字段；null 表示清除。 */
  taskUnreadOverlayByEntityKey: Record<TaskEntityKey, number | null>;
  setQueryResult: (params: {
    queryKey: TaskListCacheKey;
    descriptor: TaskListCacheDescriptor;
    items: CachedTaskListItem[];
    total: number;
    hasMore: boolean;
    unreadTaskKeys?: TaskEntityKey[];
    partial?: boolean;
    loadingShardKeys?: string[];
    failedShardKeys?: string[];
  }) => void;
  setQueryResults: (
    entries: Array<{
      queryKey: TaskListCacheKey;
      descriptor: TaskListCacheDescriptor;
      items: CachedTaskListItem[];
      total: number;
      hasMore: boolean;
      unreadTaskKeys?: TaskEntityKey[];
      partial?: boolean;
      loadingShardKeys?: string[];
      failedShardKeys?: string[];
      /** 该异步查询启动时观察到的 invalidationVersion；不匹配时整条结果丢弃。 */
      expectedInvalidationVersion?: number;
    }>,
  ) => void;
  upsertTaskMeta: (task: ZCodeTaskMeta) => void;
  updateTaskMetaPreservingMembership: (task: ZCodeTaskMeta) => void;
  applyTaskMutation: (params: {
    previousTask: ZCodeTaskMeta;
    nextTask: ZCodeTaskMeta;
    previousState: TaskListMembershipState;
    nextState: TaskListMembershipState;
  }) => void;
  setTaskUnreadOverlay: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  reconcileTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  rollbackTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  removeTask: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  markWorkspaceKeysStale: (workspaceKeys: string[]) => void;
  invalidateWorkspaceKeys: (workspaceKeys: string[]) => void;
  clearAll: () => void;
}

type CachedTaskListItem = ZCodeTaskListItem & { searchSnippets?: string[] };

function buildCachedTaskListResult(params: {
  descriptor: TaskListCacheDescriptor;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial?: boolean;
  loadingShardKeys?: string[];
  failedShardKeys?: string[];
  invalidationVersion?: number;
}): CachedTaskListResult {
  return {
    taskKeys: params.taskKeys,
    unreadTaskKeys: params.unreadTaskKeys,
    searchSnippetsByTaskKey: params.searchSnippetsByTaskKey,
    searchSnippetListsByTaskKey: params.searchSnippetListsByTaskKey,
    total: params.total,
    hasMore: params.hasMore,
    fetchedAt: Date.now(),
    invalidationVersion: params.invalidationVersion ?? 0,
    stale: false,
    partial: params.partial ?? false,
    loadingShardKeys: params.loadingShardKeys ?? [],
    failedShardKeys: params.failedShardKeys ?? [],
    descriptor: params.descriptor,
  };
}

function matchesTaskMembership(
  descriptor: TaskListCacheDescriptor,
  membership: TaskListMembershipState,
): boolean {
  const kind = descriptor.kind === "workspace" ? "timeline" : descriptor.kind;
  return matchesTaskListMembershipKind(membership, kind);
}

function matchesTaskSearch(descriptor: TaskListCacheDescriptor, task: ZCodeTaskMeta): boolean {
  if (!descriptor.search) {
    return true;
  }

  return task.title.toLocaleLowerCase().includes(descriptor.search);
}

function matchesTaskDescriptor(
  descriptor: TaskListCacheDescriptor,
  task: ZCodeTaskMeta,
  membership: TaskListMembershipState,
): boolean {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  if (!descriptor.workspaceKeys.includes(workspaceKey)) {
    return false;
  }

  return matchesTaskMembership(descriptor, membership) && matchesTaskSearch(descriptor, task);
}

function sortTaskKeysByDescriptor(params: {
  taskKeys: TaskEntityKey[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): TaskEntityKey[] {
  const uniqueTaskKeys = [...new Set(params.taskKeys)];
  return uniqueTaskKeys.sort((leftKey, rightKey) => {
    const leftTask = params.taskMetaByEntityKey[leftKey];
    const rightTask = params.taskMetaByEntityKey[rightKey];
    if (!leftTask && !rightTask) {
      return leftKey.localeCompare(rightKey);
    }
    if (!leftTask) {
      return 1;
    }
    if (!rightTask) {
      return -1;
    }
    return compareZCodeTaskListItems(leftTask, rightTask, params.descriptor.sortBy);
  });
}

// republish（membership 重拉、sessions-index 帧）产出的 item 都是全新对象引用。
// 内容没变时如果照样换引用，taskMetaByEntityKey 和派生 items memo 会整列表换新，
// 所有列表行无效重渲染。这里做逐字段等价判断，等价则保留旧引用。
// 嵌套字段（lastError/target 等）用 JSON 比较；task meta 是小对象，代价可接受。
function areCachedTaskListItemsEquivalent(
  left: CachedTaskListItem,
  right: CachedTaskListItem,
): boolean {
  if (left === right) {
    return true;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (
      typeof leftValue === "object" &&
      leftValue !== null &&
      typeof rightValue === "object" &&
      rightValue !== null
    ) {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function mergeIncomingTaskListItem(params: {
  item: CachedTaskListItem;
  existingItem: CachedTaskListItem | undefined;
  descriptor: TaskListCacheDescriptor;
  hasUnreadOverlay: boolean;
  unreadAtOverlay: number | null | undefined;
}): CachedTaskListItem {
  const incomingActivity = getTaskListRowActivity(params.item);
  const existingActivity = params.existingItem ? getTaskListRowActivity(params.existingItem) : null;
  // 搜索结果来自 tasks-index，但实体缓存可能已有 sessions-index activity。
  // 合并时保留 sidecar，否则用户一输入搜索词，running/等待确认就会消失。
  const incomingWithActivity =
    params.descriptor.search && params.existingItem && existingActivity && !incomingActivity
      ? (mergeTaskListMembershipFields(params.existingItem, params.item) as CachedTaskListItem)
      : params.item;
  const keepExistingNonPlaceholderTitle =
    params.existingItem &&
    incomingActivity &&
    (params.item.title.trim().length === 0 ||
      params.item.title.trim().toLocaleLowerCase() === "new session") &&
    params.existingItem.title.trim().length > 0 &&
    params.existingItem.title.trim().toLocaleLowerCase() !== "new session";
  // 非搜索列表的 incoming item 是 sessions-index activity + 最新 membership join，
  // 不能再按 tasks-index updatedAt 做 whole-meta winner；否则 rename/unread 响应会覆盖实时
  // phase/lastActivityAt。只保留 sessions-index 尚未补齐时的首发标题和非 activity 展示字段。
  const mergedItem = params.descriptor.search
    ? incomingWithActivity
    : ({
        ...incomingWithActivity,
        ...(keepExistingNonPlaceholderTitle ? { title: params.existingItem?.title } : {}),
        changeSummary: incomingWithActivity.changeSummary ?? params.existingItem?.changeSummary,
        model: incomingWithActivity.model ?? params.existingItem?.model,
        provider: incomingWithActivity.provider ?? params.existingItem?.provider,
      } as CachedTaskListItem);
  const itemWithUnreadOverlay = params.hasUnreadOverlay
    ? ({
        ...mergedItem,
        unreadAt: params.unreadAtOverlay ?? undefined,
      } as CachedTaskListItem)
    : mergedItem;
  const nextItem =
    params.descriptor.search || !params.existingItem?.searchSnippet
      ? itemWithUnreadOverlay
      : {
          ...itemWithUnreadOverlay,
          searchSnippet: params.existingItem.searchSnippet,
          searchSnippets: params.existingItem.searchSnippets,
        };
  // 引用保持：合并结果与现值等价时沿用旧对象，让下游 memo/浅比较短路。
  return params.existingItem && areCachedTaskListItemsEquivalent(nextItem, params.existingItem)
    ? params.existingItem
    : nextItem;
}

// republish 内容与现缓存完全等价时，直接跳过整个 setState，
// 避免 resultsByQueryKey/taskMetaByEntityKey 换新引用引发全列表无效重渲染。
// fetchedAt/stale 不参与比较（保留旧值不影响正确性，preserve 窗口只会更保守）。
function isQueryResultEquivalent(params: {
  previousResult: CachedTaskListResult | undefined;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
}): boolean {
  const previous = params.previousResult;
  if (!previous || previous.stale) {
    return false;
  }
  if (
    previous.total !== params.total ||
    previous.hasMore !== params.hasMore ||
    previous.partial !== params.partial
  ) {
    return false;
  }
  if (
    previous.taskKeys.length !== params.taskKeys.length ||
    previous.taskKeys.some((taskKey, index) => taskKey !== params.taskKeys[index])
  ) {
    return false;
  }
  const sameStringArray = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    !sameStringArray(previous.unreadTaskKeys ?? [], params.unreadTaskKeys ?? []) ||
    !sameStringArray(previous.loadingShardKeys, params.loadingShardKeys) ||
    !sameStringArray(previous.failedShardKeys, params.failedShardKeys)
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.searchSnippetsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetsByTaskKey ?? null) &&
    JSON.stringify(previous.searchSnippetListsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetListsByTaskKey ?? null)
  );
}

function preserveFreshLocalTaskKeys(params: {
  incomingTaskKeys: TaskEntityKey[];
  previousResult: CachedTaskListResult | undefined;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): { taskKeys: TaskEntityKey[]; preservedCount: number } {
  if (!params.previousResult || params.descriptor.search) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const previousResult = params.previousResult;
  const incomingTaskKeySet = new Set(params.incomingTaskKeys);
  const preservedTaskKeys = previousResult.taskKeys.filter((taskKey) => {
    if (incomingTaskKeySet.has(taskKey)) {
      return false;
    }
    const task = params.taskMetaByEntityKey[taskKey];
    return Boolean(task && task.updatedAt > previousResult.fetchedAt);
  });
  if (preservedTaskKeys.length === 0) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const sortedTaskKeys = sortTaskKeysByDescriptor({
    // sqlite 列表刷新可能晚于首发 optimistic 插入。
    // 只有本地更新时间新于上一轮列表快照的 key 才临时保留，避免旧刷新把新 task 从侧栏抹掉。
    taskKeys: [...params.incomingTaskKeys, ...preservedTaskKeys],
    taskMetaByEntityKey: params.taskMetaByEntityKey,
    descriptor: params.descriptor,
  });
  const visibleTaskKeys =
    params.descriptor.visibleLimit === null
      ? sortedTaskKeys
      : sortedTaskKeys.slice(0, params.descriptor.visibleLimit);
  return {
    taskKeys: visibleTaskKeys,
    preservedCount: preservedTaskKeys.length,
  };
}

export const useTaskQueryCacheStore = create<TaskQueryCacheState>()((set) => ({
  resultsByQueryKey: {},
  taskMetaByEntityKey: {},
  taskUnreadOverlayByEntityKey: {},
  setQueryResult: ({
    queryKey,
    descriptor,
    items,
    total,
    hasMore,
    unreadTaskKeys,
    partial,
    loadingShardKeys,
    failedShardKeys,
  }) =>
    set((state) => {
      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
      const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
      const incomingTaskKeys = items.map((item) => {
        const entityKey = buildTaskEntityKey(item);
        if (item.searchSnippet) {
          searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
        }
        if (item.searchSnippets?.length) {
          searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
        }
        const existingItem = nextTaskMetaByEntityKey[entityKey];
        const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
          state.taskUnreadOverlayByEntityKey,
          entityKey,
        );
        const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
        const mergedItem = mergeIncomingTaskListItem({
          item,
          existingItem,
          descriptor,
          hasUnreadOverlay,
          unreadAtOverlay,
        });
        if (
          hasUnreadOverlay &&
          (unreadAtOverlay === null
            ? typeof item.unreadAt !== "number"
            : item.unreadAt === unreadAtOverlay)
        ) {
          // RPC 成功不等于所有在途 membership 查询都已更新。
          // overlay 只有在 query 真正发布出同一字段值后才可释放，旧回包前后都不能覆盖新状态。
          delete nextTaskUnreadOverlayByEntityKey[entityKey];
          taskUnreadOverlayChanged = true;
        }
        if (mergedItem !== existingItem) {
          taskMetaChanged = true;
          nextTaskMetaByEntityKey[entityKey] = mergedItem;
        }
        return entityKey;
      });
      const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
        incomingTaskKeys,
        previousResult: state.resultsByQueryKey[queryKey],
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        descriptor,
      });

      const resultParams = {
        descriptor,
        taskKeys,
        unreadTaskKeys,
        searchSnippetsByTaskKey:
          Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
        searchSnippetListsByTaskKey:
          Object.keys(searchSnippetListsByTaskKey).length > 0
            ? searchSnippetListsByTaskKey
            : undefined,
        total:
          preservedCount > 0
            ? Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length)
            : total,
        hasMore:
          hasMore ||
          (preservedCount > 0 &&
            Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length) >
              taskKeys.length),
        partial,
        loadingShardKeys,
        failedShardKeys,
        invalidationVersion: state.resultsByQueryKey[queryKey]?.invalidationVersion ?? 0,
      };
      // 内容与现缓存完全等价时跳过 setState，republish 不再引发全列表无效重渲染。
      if (
        !taskMetaChanged &&
        !taskUnreadOverlayChanged &&
        isQueryResultEquivalent({
          previousResult: state.resultsByQueryKey[queryKey],
          taskKeys,
          unreadTaskKeys: resultParams.unreadTaskKeys,
          searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
          searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
          total: resultParams.total,
          hasMore: resultParams.hasMore,
          partial: partial ?? false,
          loadingShardKeys: loadingShardKeys ?? [],
          failedShardKeys: failedShardKeys ?? [],
        })
      ) {
        return state;
      }

      return {
        resultsByQueryKey: {
          ...state.resultsByQueryKey,
          [queryKey]: buildCachedTaskListResult(resultParams),
        },
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  setQueryResults: (entries) =>
    set((state) => {
      if (entries.length === 0) {
        return state;
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let resultsChanged = false;

      for (const entry of entries) {
        const previousResult = state.resultsByQueryKey[entry.queryKey];
        const currentInvalidationVersion = previousResult?.invalidationVersion ?? 0;
        if (
          entry.expectedInvalidationVersion !== undefined &&
          entry.expectedInvalidationVersion !== currentInvalidationVersion
        ) {
          // sessions-index activity 与 tasks-index membership 是异步 join。
          // 在途期间再次失效时，旧结果不能写 entity、释放 unread overlay 或把 query 标 fresh；
          // hook 会按最新 activity/membership revision 自动重算。
          continue;
        }
        const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
        const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
        const incomingTaskKeys = entry.items.map((item) => {
          const entityKey = buildTaskEntityKey(item);
          if (item.searchSnippet) {
            searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
          }
          if (item.searchSnippets?.length) {
            searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
          }
          const existingItem = nextTaskMetaByEntityKey[entityKey];
          const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
            state.taskUnreadOverlayByEntityKey,
            entityKey,
          );
          const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
          const mergedItem = mergeIncomingTaskListItem({
            item,
            existingItem,
            descriptor: entry.descriptor,
            hasUnreadOverlay,
            unreadAtOverlay,
          });
          if (
            hasUnreadOverlay &&
            (unreadAtOverlay === null
              ? typeof item.unreadAt !== "number"
              : item.unreadAt === unreadAtOverlay)
          ) {
            delete nextTaskUnreadOverlayByEntityKey[entityKey];
            taskUnreadOverlayChanged = true;
          }
          if (mergedItem !== existingItem) {
            taskMetaChanged = true;
            nextTaskMetaByEntityKey[entityKey] = mergedItem;
          }
          return entityKey;
        });
        const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
          incomingTaskKeys,
          previousResult,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: entry.descriptor,
        });

        const resultParams = {
          descriptor: entry.descriptor,
          taskKeys,
          unreadTaskKeys: entry.unreadTaskKeys,
          searchSnippetsByTaskKey:
            Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
          searchSnippetListsByTaskKey:
            Object.keys(searchSnippetListsByTaskKey).length > 0
              ? searchSnippetListsByTaskKey
              : undefined,
          total:
            preservedCount > 0
              ? Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length)
              : entry.total,
          hasMore:
            entry.hasMore ||
            (preservedCount > 0 &&
              Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length) > taskKeys.length),
          partial: entry.partial,
          loadingShardKeys: entry.loadingShardKeys,
          failedShardKeys: entry.failedShardKeys,
          invalidationVersion: currentInvalidationVersion,
        };
        // 与单条 setQueryResult 同一等价短路——内容没变的条目保留旧结果引用。
        if (
          isQueryResultEquivalent({
            previousResult,
            taskKeys,
            unreadTaskKeys: resultParams.unreadTaskKeys,
            searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
            searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
            total: resultParams.total,
            hasMore: resultParams.hasMore,
            partial: entry.partial ?? false,
            loadingShardKeys: entry.loadingShardKeys ?? [],
            failedShardKeys: entry.failedShardKeys ?? [],
          })
        ) {
          continue;
        }
        resultsChanged = true;
        nextResultsByQueryKey[entry.queryKey] = buildCachedTaskListResult(resultParams);
      }

      if (!taskMetaChanged && !resultsChanged && !taskUnreadOverlayChanged) {
        return state;
      }

      return {
        resultsByQueryKey: resultsChanged ? nextResultsByQueryKey : state.resultsByQueryKey,
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  upsertTaskMeta: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // 重启恢复时 raw session snapshot 可能先于列表刷新写入 query cache。
      // 这里必须和已有 indexed meta 合并，避免缺少 titleOverridden 的 snapshot 把用户手动标题覆盖掉。
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      const nextTask = getTaskListRowActivity(task)
        ? mergeTaskListMembershipFields(task, mergedTask)
        : existingTask
          ? mergeTaskListMembershipFields(existingTask, mergedTask)
          : mergedTask;
      return {
        ...state,
        taskMetaByEntityKey: {
          ...state.taskMetaByEntityKey,
          [entityKey]: nextTask,
        },
      };
    }),
  updateTaskMetaPreservingMembership: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // workspace_task_list_changed 可能携带 runtime snapshot 投影标题。
      // 保留 query cache 里已存在的手动重命名事实源，只用新 meta 补 status/updatedAt 等运行态字段。
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      // workspace_task_list_changed 带来的 tasks-index updatedAt
      // 只是 metadata 更新，不是用户真实会话活动。已有 sessions-index sidecar 时
      // 只合并 membership/meta 字段，否则 rename/unread 会让任务错误跳到顶部。
      const nextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, mergedTask)
        : mergedTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [entityKey]: nextTask,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          continue;
        }

        // workspace_task_list_changed 的 meta 增量只说明任务内容/状态变化，
        // 不代表 pinned/archived 成员关系变化；因此只重排已经包含该任务的列表，不能把它从 pinned 区移走。
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: sortTaskKeysByDescriptor({
            taskKeys: result.taskKeys,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: result.descriptor,
          }),
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  applyTaskMutation: ({ previousTask, nextTask, previousState, nextState }) =>
    set((state) => {
      const previousEntityKey = buildTaskEntityKey(previousTask);
      const nextEntityKey = buildTaskEntityKey(nextTask);
      const existingTask =
        state.taskMetaByEntityKey[nextEntityKey] ?? state.taskMetaByEntityKey[previousEntityKey];
      const mergedNextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, nextTask)
        : nextTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [nextEntityKey]: mergedNextTask,
      };
      if (previousEntityKey !== nextEntityKey) {
        delete nextTaskMetaByEntityKey[previousEntityKey];
      }

      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (result.descriptor.search) {
          // 正文搜索结果由服务端 sqlite searchable_text 决定，前端缓存只有 task meta/title，
          // 不能用 title-only 规则判断增量列表成员资格；否则正文命中的会话会被本地缓存误判为不匹配。
          nextResultsByQueryKey[queryKey] = {
            ...result,
            invalidationVersion: result.invalidationVersion + 1,
            stale: true,
          };
          continue;
        }

        const previousIncluded = matchesTaskDescriptor(
          result.descriptor,
          previousTask,
          previousState,
        );
        const nextIncluded = matchesTaskDescriptor(result.descriptor, nextTask, nextState);
        const wasVisible =
          result.taskKeys.includes(previousEntityKey) || result.taskKeys.includes(nextEntityKey);

        if (!previousIncluded && !nextIncluded && !wasVisible) {
          continue;
        }

        const taskKeysWithoutTarget = result.taskKeys.filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const unreadTaskKeysWithoutTarget = (result.unreadTaskKeys ?? []).filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const visibleCandidateKeys = nextIncluded
          ? [...taskKeysWithoutTarget, nextEntityKey]
          : taskKeysWithoutTarget;
        const nextUnreadTaskKeys =
          nextIncluded && typeof mergedNextTask.unreadAt === "number"
            ? [...unreadTaskKeysWithoutTarget, nextEntityKey]
            : unreadTaskKeysWithoutTarget;
        const sortedTaskKeys = sortTaskKeysByDescriptor({
          taskKeys: visibleCandidateKeys,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: result.descriptor,
        });
        const visibleTaskKeys =
          result.descriptor.visibleLimit === null
            ? sortedTaskKeys
            : sortedTaskKeys.slice(0, result.descriptor.visibleLimit);
        const nextTotal = Math.max(
          0,
          result.total + Number(nextIncluded) - Number(previousIncluded),
        );
        const shouldBackgroundRefresh =
          result.descriptor.visibleLimit !== null &&
          previousIncluded !== nextIncluded &&
          nextTotal > visibleTaskKeys.length;

        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: visibleTaskKeys,
          ...(result.unreadTaskKeys ? { unreadTaskKeys: nextUnreadTaskKeys } : {}),
          total: nextTotal,
          hasMore: nextTotal > visibleTaskKeys.length,
          stale: result.stale || shouldBackgroundRefresh,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  setTaskUnreadOverlay: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  reconcileTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // 服务端回包只确认 mutation 已持久化；旧 membership 请求仍可能稍后返回。
      // 把 overlay 更新成服务端值，直到 setQueryResult 观察到同值后再自动释放。
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  rollbackTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      const nextOverlays = { ...state.taskUnreadOverlayByEntityKey };
      delete nextOverlays[entityKey];
      return {
        taskUnreadOverlayByEntityKey: nextOverlays,
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  removeTask: (task) => {
    let removedFromVisibleCache = false;
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      if (!state.taskMetaByEntityKey[entityKey]) {
        const hasCachedResult = Object.values(state.resultsByQueryKey).some((result) =>
          result.taskKeys.includes(entityKey),
        );
        if (!hasCachedResult) {
          return state;
        }
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      delete nextTaskMetaByEntityKey[entityKey];
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      delete nextTaskUnreadOverlayByEntityKey[entityKey];

      const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {};
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          nextResultsByQueryKey[queryKey] = result;
          continue;
        }

        const taskKeys = result.taskKeys.filter((taskKey) => taskKey !== entityKey);
        removedFromVisibleCache = true;
        // 删除 task 以前只能整表刷新；这里只对实际可见缓存命中的列表扣减 total。
        // 对未出现在折叠可见区的隐藏项不猜 membership，避免误扣其它列表计数。
        const total = Math.max(0, result.total - 1);
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys,
          total,
          hasMore: total > taskKeys.length,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: nextTaskUnreadOverlayByEntityKey,
      };
    });
    return removedFromVisibleCache;
  },
  markWorkspaceKeysStale: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const staleWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let changed = false;

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (
          !result.descriptor.workspaceKeys.some((workspaceKey) =>
            staleWorkspaceKeySet.has(workspaceKey),
          )
        ) {
          continue;
        }

        // 删除折叠/分页隐藏 task 时无法只靠 taskId 安全扣 total。
        // 这里保留当前可见列表，只标脏匹配 workspace，让 hook 的下一轮 effect 真正回源刷新计数。
        nextResultsByQueryKey[queryKey] = {
          ...result,
          invalidationVersion: result.invalidationVersion + 1,
          stale: true,
        };
        changed = true;
      }

      if (!changed) {
        return state;
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
      };
    }),
  invalidateWorkspaceKeys: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const invalidatedWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = Object.fromEntries(
        Object.entries(state.resultsByQueryKey).filter(([queryKey]) => {
          return ![...invalidatedWorkspaceKeySet].some(
            (workspaceKey) =>
              queryKey.includes(`workspaces=${workspaceKey}`) ||
              queryKey.includes(`|${workspaceKey}`),
          );
        }),
      );
      const nextTaskMetaByEntityKey = Object.fromEntries(
        Object.entries(state.taskMetaByEntityKey).filter(([entityKey]) => {
          const workspaceKey = entityKey.split("::")[0] ?? "";
          return !invalidatedWorkspaceKeySet.has(workspaceKey);
        }),
      );

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  clearAll: () =>
    set(() => ({
      // clearAll 是 Zustand action，必须通过 set 写回 store。
      // 之前只返回对象，测试和开发态清理 query cache 时旧 task meta 会继续残留。
      resultsByQueryKey: {},
      taskMetaByEntityKey: {},
      taskUnreadOverlayByEntityKey: {},
    })),
}));

export function selectTaskListCacheResult(queryKey: TaskListCacheKey) {
  return (state: TaskQueryCacheState): CachedTaskListResult | null => {
    return state.resultsByQueryKey[queryKey] ?? null;
  };
}

export function invalidateTaskQueryCacheByScopes(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys(workspaceKeys);
}

export function markTaskQueryCacheScopesStale(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale(workspaceKeys);
}

export function upsertTaskQueryCacheTaskMeta(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().upsertTaskMeta(task);
}

export function updateTaskQueryCacheTaskMetaPreservingMembership(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().updateTaskMetaPreservingMembership(task);
}

export function applyTaskQueryCacheMutation(params: {
  previousTask: ZCodeTaskMeta;
  nextTask: ZCodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
}): void {
  useTaskQueryCacheStore.getState().applyTaskMutation(params);
}

export function setTaskQueryCacheUnreadOverlay(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().setTaskUnreadOverlay(task, unreadAt);
}

export function reconcileTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().reconcileTaskUnread(task, unreadAt);
}

export function rollbackTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().rollbackTaskUnread(task, unreadAt);
}

export function removeTaskFromTaskQueryCaches(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): boolean {
  return useTaskQueryCacheStore.getState().removeTask(task);
}

// 内存诊断计数器：版本化 queryKey 只增不删，先落日志。
uiMemoryDiagnosticsRegistry.register("taskQueryCache", () => {
  const state = useTaskQueryCacheStore.getState();
  return {
    queryKeys: Object.keys(state.resultsByQueryKey).length,
    taskMetas: Object.keys(state.taskMetaByEntityKey).length,
  };
});

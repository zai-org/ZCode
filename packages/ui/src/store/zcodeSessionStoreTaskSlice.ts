import { clearV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
/* oxlint-disable eslint(max-lines) -- 当前文件承接 task 级状态切片，先保持最小改动修复草稿逻辑，后续再统一拆分 */
import {
  normalizeAgentProviderToZCodeAgent,
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeProvider,
  type ZCodeTaskRuntimeStatus,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { removeTaskFromHistory } from "@/lib/taskNavigationHistory.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import type {
  ConfigOptionsStatus,
  ElicitationFormDraft,
  ZCodeSessionStoreState,
  TaskUsageState,
} from "@/store/zcodeSessionStoreTypes.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";
import { clearPersistedComposerDraft } from "@/lib/chatComposerDraftStorage.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import {
  getTaskRuntimeState,
  getTaskUiState,
  getWorkspaceState,
  resolveWorkspaceStateKey,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

function arePermissionOptionsEqual(
  left: ZCodePermissionRequest["options"],
  right: ZCodePermissionRequest["options"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((option, index) => {
    const otherOption = right[index];
    if (!otherOption) {
      return false;
    }

    return (
      option.optionId === otherOption.optionId &&
      option.kind === otherOption.kind &&
      option.name === otherOption.name
    );
  });
}

function arePermissionRequestsEquivalent(
  left: ZCodePermissionRequest,
  right: ZCodePermissionRequest,
): boolean {
  if (left === right) {
    return true;
  }

  // 同一 requestId 可能被连续投递成不同对象。raw 只用于展示预览，协议上 requestId 才是权限请求身份；
  // 这里按可见字段去重，避免重复请求把权限弹窗和 ChatView 整体重渲染。
  return (
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.inputId === right.inputId &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.description === right.description &&
    arePermissionOptionsEqual(left.options, right.options)
  );
}

function areTaskUsageCostsEqual(
  left: TaskUsageState["cost"] | undefined,
  right: TaskUsageState["cost"] | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return (
    normalizedLeft.amount === normalizedRight.amount &&
    normalizedLeft.currency === normalizedRight.currency
  );
}

function areTaskUsageCachesEqual(
  left: TaskUsageState["cache"] | undefined,
  right: TaskUsageState["cache"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.inputTokens === right.inputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.latestHitRate === right.latestHitRate &&
    left.hitRate === right.hitRate &&
    left.hitRateRequestCount === right.hitRateRequestCount &&
    left.totalInputTokens === right.totalInputTokens &&
    left.totalCacheReadTokens === right.totalCacheReadTokens &&
    left.totalCacheWriteTokens === right.totalCacheWriteTokens
  );
}

function areTaskUsageBreakdownsEqual(
  left: TaskUsageState["breakdown"] | undefined,
  right: TaskUsageState["breakdown"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) => item.source === right[index]?.source && item.chars === right[index]?.chars,
  );
}

function areTaskUsageStatesEqual(
  left: TaskUsageState | null,
  right: TaskUsageState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.size === right.size &&
    left.used === right.used &&
    areTaskUsageCostsEqual(left.cost, right.cost) &&
    areTaskUsageCachesEqual(left.cache, right.cache) &&
    areTaskUsageBreakdownsEqual(left.breakdown, right.breakdown)
  );
}

function normalizeTaskContextWindow(contextWindow: number | null): number | null {
  if (contextWindow === null) {
    return null;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.floor(contextWindow);
}

function updateWorkspaceStateForIdentityScopedTaskState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  updater: (
    current: ReturnType<typeof getDefaultWorkspaceState>,
  ) => ReturnType<typeof getDefaultWorkspaceState>,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return updateWorkspaceState(state, workspacePath, updater);
  }
  const current = state.workspaces[workspaceKey] ?? getDefaultWorkspaceState();
  return {
    workspaces: {
      ...state.workspaces,
      [workspaceKey]: updater(current),
    },
  };
}

export function createTaskSlice(set: SetFn) {
  return {
    setTaskRuntimeState: (
      workspacePath: string,
      taskId: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
      provider?: ZCodeProvider,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const currentTaskRuntime = getTaskRuntimeState(current, taskId);
            const isRunningStatus =
              status === "creating" || status === "restoring" || status === "streaming";
            const nextTaskRuntime = {
              ...currentTaskRuntime,
              status,
              error: error ?? null,
              provider: provider ?? currentTaskRuntime.provider,
              // activeInputId 是当前生成轮次的命令路由标识。
              // 终态/非运行态如果继续保留旧 inputId，移动端只靠快照补齐时会把已结束任务误判成仍在 loading。
              // activeTurnKind 同样是 session 运行态；compact 完成后必须清掉，
              // 否则 app 层会继续把同一 task 的发送误判为“压缩中”并吞掉。
              activeTurnKind: isRunningStatus ? currentTaskRuntime.activeTurnKind : undefined,
              activeInputId: isRunningStatus ? currentTaskRuntime.activeInputId : undefined,
              activeInputOwnerClientId: isRunningStatus
                ? currentTaskRuntime.activeInputOwnerClientId
                : undefined,
            };
            return {
              ...current,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [taskId]: nextTaskRuntime,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskUsage: (
      workspacePath: string,
      taskId: string,
      usage: TaskUsageState | null,
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (areTaskUsageStatesEqual(currentRuntime.usage, usage)) {
          // usage_update 在流式期间可能以相同数值重复到达。
          // 如果继续创建新的 workspace/taskRuntime 对象，React 会被无意义唤醒并造成掉帧。
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                usage,
              },
            },
          }),
        );
      });
    },

    setTaskContextWindow: (
      workspacePath: string,
      taskId: string,
      contextWindow: number | null,
      workspaceIdentity?: string,
    ) => {
      const normalizedContextWindow = normalizeTaskContextWindow(contextWindow);
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (currentRuntime.contextWindow === normalizedContextWindow) {
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                // contextWindow 来自模型状态，usage.used 来自运行时 token 统计。
                // 两者流式到达顺序不同，窗口刷新不能重建 usage 对象，否则会把正数 used 覆盖成 0。
                contextWindow: normalizedContextWindow,
              },
            },
          }),
        );
      });
    },

    setTaskApiRetryStatus: (
      workspacePath: string,
      taskId: string,
      apiRetry: ZCodeApiRetryStatus | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                apiRetry,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskConfigOptions: (
      workspacePath: string,
      taskId: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
      status: ConfigOptionsStatus = "ready",
    ) => {
      const normalizedOptions = [...options];
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentOptions = current.taskConfigOptionsByTaskId[taskId] ?? [];
        const currentStatus = current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready";
        if (
          currentStatus === status &&
          areConfigOptionsEquivalent(currentOptions, normalizedOptions)
        ) {
          // 历史 task 恢复旧模型或无 API key 自动清空模型时，多个恢复路径可能反复提交
          // 内容相同但引用不同的 configOptions。这里直接跳过等价写入，避免 Zustand 通知触发 React effect 循环。
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            return {
              ...current,
              taskConfigOptionsByTaskId: {
                ...current.taskConfigOptionsByTaskId,
                [taskId]: normalizedOptions,
              },
              taskConfigOptionsStatusByTaskId: {
                ...current.taskConfigOptionsStatusByTaskId,
                [taskId]: status,
              },
            };
          },
          workspaceIdentity,
        );
      });
    },

    setTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodePermissionRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              if (
                taskUiState.permissionRequest === null &&
                taskUiState.pendingPermissionRequests.length === 0
              ) {
                return current;
              }

              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: null,
                    pendingPermissionRequests: [],
                  },
                },
              };
            }

            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            let nextPermissionRequest = currentPermissionRequest;
            let nextPendingPermissionRequests = pendingPermissionRequests;

            if (currentPermissionRequest?.requestId === request.requestId) {
              if (arePermissionRequestsEquivalent(currentPermissionRequest, request)) {
                return current;
              }
              nextPermissionRequest = request;
            } else if (currentPermissionRequest === null) {
              nextPermissionRequest = request;
              nextPendingPermissionRequests = pendingPermissionRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingPermissionRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                const existingPendingRequest = pendingPermissionRequests[existingPendingIndex];
                if (!existingPendingRequest) {
                  return current;
                }
                if (arePermissionRequestsEquivalent(existingPendingRequest, request)) {
                  return current;
                }
                nextPendingPermissionRequests = pendingPermissionRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                // 同一 task 里可能连续出现多个权限请求。只有一个 permissionRequest 字段时，
                // 后到的请求会直接覆盖前一个，导致前面的 pending 权限永远没人响应，任务表面上像是“卡住”。
                // 这里把后续请求按 task 入队，保证用户确认当前请求后，下一个还能自动顶上来继续处理。
                nextPendingPermissionRequests = [...pendingPermissionRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  permissionRequest: nextPermissionRequest,
                  pendingPermissionRequests: nextPendingPermissionRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            if (currentPermissionRequest?.requestId === requestId) {
              const [nextPermissionRequest, ...restPendingPermissionRequests] =
                pendingPermissionRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: nextPermissionRequest ?? null,
                    pendingPermissionRequests: restPendingPermissionRequests,
                  },
                },
              };
            }

            const pendingPermissionIndex = pendingPermissionRequests.findIndex(
              (item) => item.requestId === requestId,
            );
            if (pendingPermissionIndex < 0) {
              // 权限响应会走本地乐观清理，也会再收到一次 stream 回放的 permission_response。
              // 第二次清理如果继续重建 taskUiState，会触发 ChatView 和权限预览树无意义重渲染，导致确认后 CPU 飙高。
              return current;
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingPermissionRequests: pendingPermissionRequests.filter(
                    (_item, index) => index !== pendingPermissionIndex,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodeElicitationRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: null,
                    pendingElicitationRequests: [],
                  },
                },
              };
            }

            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            let nextElicitationRequest = currentElicitationRequest;
            let nextPendingElicitationRequests = pendingElicitationRequests;

            if (currentElicitationRequest?.requestId === request.requestId) {
              nextElicitationRequest = request;
            } else if (currentElicitationRequest === null) {
              nextElicitationRequest = request;
              nextPendingElicitationRequests = pendingElicitationRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingElicitationRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                nextPendingElicitationRequests = pendingElicitationRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                nextPendingElicitationRequests = [...pendingElicitationRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationRequest: nextElicitationRequest,
                  pendingElicitationRequests: nextPendingElicitationRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            if (currentElicitationRequest?.requestId === requestId) {
              const [nextElicitationRequest, ...restPendingElicitationRequests] =
                pendingElicitationRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: nextElicitationRequest ?? null,
                    pendingElicitationRequests: restPendingElicitationRequests,
                  },
                },
              };
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingElicitationRequests: pendingElicitationRequests.filter(
                    (item) => item.requestId !== requestId,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      draft: ElicitationFormDraft,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  // 问答进度原本只存在弹窗 useState，切换 task 后组件卸载，
                  // 再挂载只能从原始 request 初始化。按 task/request 提升到 renderer store，
                  // 既能恢复本地草稿，也不会把分题状态误写入 runtime/replayable snapshot。
                  elicitationFormDraftsByRequestId: {
                    ...taskUiState.elicitationFormDraftsByRequestId,
                    [requestId]: draft,
                  },
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (!(requestId in taskUiState.elicitationFormDraftsByRequestId)) {
              return current;
            }
            const nextDrafts = { ...taskUiState.elicitationFormDraftsByRequestId };
            delete nextDrafts[requestId];
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationFormDraftsByRequestId: nextDrafts,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskError: (
      workspacePath: string,
      taskId: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskUiByTaskId: {
              ...current.taskUiByTaskId,
              [taskId]: {
                ...getTaskUiState(current, taskId),
                // 完整错误对象之前只放在 ChatView/useZCodeChat 的本地 state。
                // 一旦切换页面或任务，组件卸载后 traceId/code 就会一起丢失，只剩 taskRuntime.error 的纯文本。
                // 这里改成按 task 写进 store，让错误提示能跟 plan/permission 一样跨页面恢复。
                error,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    initializeBackgroundTaskRuntime: (
      workspacePath: string,
      params: {
        task: ZCodeTaskMeta;
        provider: ZCodeProvider;
        activeInputId: string;
        workspaceIdentity?: string;
      },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[params.task.taskId];
            const nextTask = existingTask
              ? mergeTaskWithOptimisticMeta(params.task, existingTask)
              : params.task;
            const currentTaskRuntime = getTaskRuntimeState(current, params.task.taskId);
            const cachedTasks = current.taskListCache ?? [];
            const nextTaskListCache =
              current.taskListCache === null
                ? current.taskListCache
                : sortTasksByUpdatedAt([
                    nextTask,
                    ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== params.task.taskId),
                  ]);

            return {
              ...current,
              selectedProvider: normalizeAgentProviderToZCodeAgent(params.provider),
              // 性能优化：后台首发不需要先经历 optimistic -> cache -> runtime 多轮 set。
              // 合到一次写入可以削掉并发压测创建任务时的 renderer 订阅风暴。
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                [params.task.taskId]: nextTask,
              },
              taskListCache: nextTaskListCache,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [params.task.taskId]: {
                  ...currentTaskRuntime,
                  status: "streaming",
                  error: null,
                  provider: params.provider,
                  activeInputId: params.activeInputId,
                },
              },
            };
          },
          params.workspaceIdentity ?? params.task.workspaceIdentity,
        ),
      );
    },

    upsertOptimisticTaskListItem: (
      workspacePath: string,
      task: ZCodeTaskMeta,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[task.taskId];
            const nextTask = existingTask ? mergeTaskWithOptimisticMeta(task, existingTask) : task;

            return {
              ...current,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // desktop-continuous 的 readSession 快照可能旧于首发 optimistic Date.now()。
                // 这里按 updatedAt 单调合并，避免旧快照把新 task 压回列表下面。
                [task.taskId]: nextTask,
              },
            };
          },
          workspaceIdentity ?? task.workspaceIdentity,
        ),
      );
    },

    removeOptimisticTaskListItem: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;
            return {
              ...current,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      // task 删除会清内存 task state，但 composer 草稿还有桌面端 localStorage 桶。
      // 如果不在统一删除 action 里同步清理，重启后已删除 task 的草稿会继续残留。
      clearPersistedComposerDraft(workspacePath, taskId, workspaceIdentity);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, taskId);
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskRuntime, ...restTaskRuntimeByTaskId } =
              current.taskRuntimeByTaskId;
            const { [taskId]: _removedTaskUi, ...restTaskUiByTaskId } = current.taskUiByTaskId;
            const { [taskId]: _removedTaskConfigOptions, ...restTaskConfigOptionsByTaskId } =
              current.taskConfigOptionsByTaskId;
            const {
              [taskId]: _removedTaskConfigOptionsStatus,
              ...restTaskConfigOptionsStatusByTaskId
            } = current.taskConfigOptionsStatusByTaskId;
            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;

            const shouldCloseDeletedTask = current.activeTaskId === taskId;

            // 删除左侧当前正在查看的任务时，之前只更新了任务列表数据，
            // workspace 里的 activeTaskId 仍指向已删除 task，右侧主区就会继续按旧 taskId 渲染详情。
            // 这里在删除成功后统一回收选中态和运行态，让主区域立即退出这条已删除任务。
            return {
              ...current,
              activeTaskId: shouldCloseDeletedTask ? null : current.activeTaskId,
              draftRuntime: shouldCloseDeletedTask
                ? { status: "idle", error: null }
                : current.draftRuntime,
              taskRuntimeByTaskId: restTaskRuntimeByTaskId,
              taskUiByTaskId: restTaskUiByTaskId,
              taskConfigOptionsByTaskId: restTaskConfigOptionsByTaskId,
              taskConfigOptionsStatusByTaskId: restTaskConfigOptionsStatusByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        );

        return {
          ...workspaceUpdate,
          taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
        };
      });
    },
  };
}

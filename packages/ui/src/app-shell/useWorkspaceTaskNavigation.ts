/* eslint-disable max-lines -- workspace 的 task、自动化与插件市场共享浏览器式历史，集中处理才能保证前进/后退目标一致。 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  goBack,
  goForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  type AutomationsNavigationTab,
} from "@/lib/taskNavigationHistory.js";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import {
  onTaskNavigationCommitted,
  onTaskNavigationRequested,
} from "@/store/zcodeSessionStoreNavigation.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import { selectWorkbenchSession } from "@/v4/workbenchSessionPlacement.js";

export interface AutomationsNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export function useWorkspaceTaskNavigation({
  intl,
  workspaceAbsPath,
  workspaceIdentity,
  isWebRemoteControl = false,
  activateTabByPath,
  onNavigateToTask,
  onNavigateToAutomations,
  onNavigateToPluginStore,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  isWebRemoteControl?: boolean;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  onNavigateToTask?: () => void;
  onNavigateToAutomations?: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore?: (target: Omit<AutomationsNavigationTarget, "automationId">) => void;
}) {
  // 跨 workspace 选择会先同步切换 tab，但本次 React render 捕获的 ambient
  // services 仍可能属于旧 remote attachment。local 目标必须固定从 window base attachment
  // 发起，再由 Host Controller 路由，不能把本地路径送进旧 remote scope。
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const setActiveTaskId = useZCodeSessionStore((s) => s.setActiveTaskId);
  const taskNavHistory = useZCodeSessionStore((s) => s.taskNavHistory);
  const taskNavPushAutomations = useZCodeSessionStore((s) => s.taskNavPushAutomations);
  const taskNavPushPluginStore = useZCodeSessionStore((s) => s.taskNavPushPluginStore);
  const navigationVersion = useRef(0);
  useEffect(() => {
    const subscription = onTaskNavigationCommitted(() => {
      navigationVersion.current += 1;
    });
    return () => {
      navigationVersion.current += 1;
      subscription.dispose();
    };
  }, []);

  const handleSelectTask = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentityHint?: string,
      selectedRowUnreadAt?: number,
    ) => {
      const targetWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(targetWorkspacePath, targetWorkspaceIdentityHint);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          targetWorkspaceState.modelSwitchPending,
          targetWorkspaceState.modelSwitchStage,
        )
      ) {
        // 模型供应商切换触发 runtime 重建时，当前 provider-workspace 的 task handle 会被短暂回收。
        // 若此时切到其他 task，会并发触发 resumeTask 与重建流程，容易把切换失败误判成任务恢复失败。
        // 这里在 task 切换入口统一拦截，等重建完成后再允许切换，避免 UI 进入 notReady/error 的假失败态。
        logger.info(
          `[App] 模型运行时重建中，忽略 task 切换 workspace=${targetWorkspacePath} taskId=${taskId} stage=${targetWorkspaceState.modelSwitchStage}`,
        );
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }

      // 远程 workspace 的未读清理不能再只靠 workspacePath 反查 session。
      // 当同一窗口里存在相同路径的多个 remote tab 时，路径映射会命中旧 session，
      // 导致“点开这个任务”却把已读状态写到另一条远端连接上。
      // 这里先激活目标 tab，再从当前激活 tab 上读取更精确的 remoteSessionId。
      // 全局搜索可返回尚未打开的目录；仅 activate 会失败并把用户留在原任务。
      const workspaceResult = ensureTaskNavigationWorkspace({
        workspacePath: targetWorkspacePath,
        workspaceIdentity: targetWorkspaceIdentityHint,
        activateTabByPath,
        addLocalWorkspaceTab: (path) => {
          tabStoreApi.getState().addTab(path);
        },
      });
      if (!workspaceResult.accepted) {
        toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
        return;
      }
      const activeTab = tabStoreApi
        .getState()
        .tabs.find((tab) => tab.id === tabStoreApi.getState().activeTabId);
      const targetWorkspaceKey = buildTaskWorkspaceKey(
        targetWorkspacePath,
        targetWorkspaceIdentityHint,
      );
      const activeWorkspaceTabMatchesTarget = Boolean(
        activeTab &&
        isWorkspaceTab(activeTab) &&
        buildTaskWorkspaceKey(activeTab.workspacePath, activeTab.workspaceIdentity) ===
          targetWorkspaceKey,
      );
      const resolvedRemoteSessionId =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? activeTab.remoteSessionId
          : undefined;
      const targetWorkspaceIdentity =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? (activeTab.workspaceIdentity ?? targetWorkspaceIdentityHint)
          : targetWorkspaceIdentityHint;
      const targetTask = {
        taskId,
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
      };
      const taskEntityKey = buildTaskEntityKey(targetTask);
      const cachedTaskMeta = useTaskQueryCacheStore.getState().taskMetaByEntityKey[taskEntityKey];
      const previousUnreadAt = cachedTaskMeta?.unreadAt;
      // 「任务」时间线由 Window Controller 直接提供行数据，不会像项目列表一样
      // 把后台创建的 task 写入 query cache。点击事务若只查 cache，会把已显示蓝点的行误判为已读。
      // 被点击行是本次用户实际看到的快照，优先用它的 unreadAt 做 compare-and-clear；
      // 未传行快照的旧入口继续回退 query cache，保持兼容。
      const expectedUnreadAt =
        typeof selectedRowUnreadAt === "number" ? selectedRowUnreadAt : previousUnreadAt;
      const shouldClearUnread = typeof expectedUnreadAt === "number";
      const isRemoteWorkspace = Boolean(
        targetWorkspaceIdentity ||
        (activeTab &&
          isWorkspaceTab(activeTab) &&
          activeWorkspaceTabMatchesTarget &&
          (activeTab.remoteSessionId || activeTab.remoteTarget)),
      );

      if (shouldClearUnread) {
        // unread 之前只在 useTaskRestore 的 resumeTask 后持久化清除。
        // 当用户再次点击当前 task 时，不会重新走 restore，磁盘里的 unreadAt 就会残留，
        // 表现成“已经点开看过了，但重启 app 后又回到未读”。
        // 这里把显式选择 task 也视为已读入口，保证同一条 task 重复进入时也能清掉持久化未读状态。
        // v4 任务行已由 query cache 渲染，只更新旧 Zustand unread map
        // 不会让蓝点重渲染。先对精确 entity key 加字段级 overlay，服务端回包
        // 后再 reconcile；期间的旧 membership 刷新也不能把蓝点写回来。
        setTaskQueryCacheUnreadOverlay(targetTask, undefined);
        const targetServices = resolvedRemoteSessionId
          ? (getRemoteWorkspaceSession(resolvedRemoteSessionId)?.services ?? null)
          : isRemoteWorkspace
            ? null
            : baseServices;
        if (!targetServices) {
          // 远程 workspace 断开时不能按相同 workspacePath 回退到
          // 其他 remote session 或本地 base services，否则会把另一个工作区的未读状态清掉。
          rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
          logger.warn(
            `[App] 选择 task 时跳过未读持久化，远程 workspace 未连接 workspace=${targetWorkspacePath} taskId=${taskId}`,
          );
        } else {
          void targetServices.zcodeTaskService
            .setTaskUnread({
              ...targetTask,
              unread: false,
              expectedUnreadAt,
            })
            .then((meta) => {
              reconcileTaskQueryCacheUnread(targetTask, meta.unreadAt);
              bumpTaskListMembershipVersion();
            })
            .catch((error: unknown) => {
              rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
              markTaskQueryCacheScopesStale([targetTask]);
              bumpTaskListMembershipVersion();
              logger.warn(
                `[App] 选择 task 时清除未读状态失败 workspace=${targetWorkspacePath} taskId=${taskId}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }

      // slashCommands 是 workspace identity 级目录，不是 task projection。
      // 选择已有 task 时先清空的话，随后却只有 conversation projection 恢复，
      // composer 读取的 workspace 目录永远得不到回填。这里保留同一 identity 桶；
      // 冷恢复确实为空时由 workspace catalog 水合独立补齐。
      setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      onNavigateToTask?.();
    },
    [activateTabByPath, intl, onNavigateToTask, baseServices, tabStoreApi, setActiveTaskId],
  );

  const handleOpenAutomations = useCallback(
    (automationId?: string, automationTab?: AutomationsNavigationTab) => {
      const normalizedAutomationId = automationId?.trim() || undefined;
      // Automations 过去只切换 WorkspaceShellLayout 的本地视图，完全绕过
      // 浏览器式导航历史，导致顶部前进/后退无法返回或恢复该页面。这里把它作为
      // workspace 身份隔离的正式导航目标入栈；历史回放只消费条目，不会再次入栈。
      taskNavPushAutomations(
        workspaceAbsPath,
        workspaceIdentity,
        normalizedAutomationId,
        automationTab,
      );
      onNavigateToAutomations?.({
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(normalizedAutomationId ? { automationId: normalizedAutomationId } : {}),
        ...(automationTab ? { automationTab } : {}),
      });
    },
    [onNavigateToAutomations, taskNavPushAutomations, workspaceAbsPath, workspaceIdentity],
  );

  const handleOpenPluginStore = useCallback(() => {
    taskNavPushPluginStore(workspaceAbsPath, workspaceIdentity);
    onNavigateToPluginStore?.({ workspacePath: workspaceAbsPath, workspaceIdentity });
  }, [onNavigateToPluginStore, taskNavPushPluginStore, workspaceAbsPath, workspaceIdentity]);

  const navigateHistory = useCallback(
    async (direction: "back" | "forward") => {
      const sessionStore = useZCodeSessionStore.getState();
      const origin = sessionStore.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          origin.modelSwitchPending,
          origin.modelSwitchStage,
        )
      ) {
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }
      const request = ++navigationVersion.current;
      const originalHistory = sessionStore.taskNavHistory;
      const originalTabId = tabStoreApi.getState().activeTabId;
      const isCurrent = () => {
        const state = useZCodeSessionStore.getState();
        const current = state.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        return (
          request === navigationVersion.current &&
          state.taskNavHistory === originalHistory &&
          tabStoreApi.getState().activeTabId === originalTabId &&
          current.activeTaskId === origin.activeTaskId &&
          current.draftFocusVersion === origin.draftFocusVersion
        );
      };
      const step = direction === "back" ? goBack : goForward;
      let history = originalHistory;
      try {
        for (let next = step(history); next; next = step(history)) {
          const { entry } = next;
          if (isAutomationsNavEntry(entry) || isPluginStoreNavEntry(entry)) {
            if (!isCurrent()) return;
            useZCodeSessionStore.setState({ taskNavHistory: next.history });
            activateTabByPath(entry.workspacePath, { workspaceIdentity: entry.workspaceIdentity });
            if (isAutomationsNavEntry(entry)) onNavigateToAutomations?.(entry);
            else onNavigateToPluginStore?.(entry);
            return;
          }
          const targetTab = tabStoreApi
            .getState()
            .tabs.find(
              (tab) =>
                isWorkspaceTab(tab) &&
                buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
                  buildTaskWorkspaceKey(entry.workspacePath, entry.workspaceIdentity),
            );
          const remoteSessionId =
            targetTab && isWorkspaceTab(targetTab) ? targetTab.remoteSessionId : undefined;
          const remote = Boolean(
            entry.workspaceIdentity ||
            (targetTab && isWorkspaceTab(targetTab) && targetTab.remoteTarget),
          );
          const services = remoteSessionId
            ? getRemoteWorkspaceSession(remoteSessionId)?.services
            : remote
              ? undefined
              : baseServices;
          if (!services) throw new Error("Navigation target is disconnected");
          // 侧栏已迁到项目树，旧缓存未命中不代表删除；只信 Host 索引的明确空结果。
          // 查询期间不移动真实游标，新选择、草稿或连接换代会使迟到结果失效。
          const meta = await services.zcodeTaskService.getTaskMeta({
            workspacePath: entry.workspacePath,
            workspaceIdentity: entry.workspaceIdentity,
            taskId: entry.taskId,
          });
          if (
            !isCurrent() ||
            (remoteSessionId && getRemoteWorkspaceSession(remoteSessionId)?.services !== services)
          )
            return;
          if (!meta) {
            // 只删除本次查询的精确条目，保持当前位置；批量删除重复 task 会跳过相邻目标。
            history = {
              entries: history.entries.filter((_, index) => index !== next.history.cursor),
              cursor: history.cursor - (next.history.cursor < history.cursor ? 1 : 0),
            };
            continue;
          }
          const targetState = useZCodeSessionStore
            .getState()
            .getWorkspaceState(entry.workspacePath, entry.workspaceIdentity);
          if (
            shouldBlockTaskSelectionDuringModelRestart(
              targetState.modelSwitchPending,
              targetState.modelSwitchStage,
            )
          ) {
            toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
            return;
          }
          const workspace = ensureTaskNavigationWorkspace({
            workspacePath: entry.workspacePath,
            workspaceIdentity: entry.workspaceIdentity,
            activateTabByPath,
            addLocalWorkspaceTab: (path) => {
              tabStoreApi.getState().addTab(path);
            },
          });
          if (!workspace.accepted) throw new Error("Navigation target is disconnected");
          // 与侧栏选择共用工作台 owner，避免只改 shell activeTaskId 而分屏仍显示原会话。
          if (!isWebRemoteControl)
            selectWorkbenchSession(
              origin.activeTaskId
                ? {
                    sessionId: origin.activeTaskId,
                    workspaceScope: { workspacePath: workspaceAbsPath, workspaceIdentity },
                  }
                : null,
              {
                workspacePath: entry.workspacePath,
                workspaceIdentity: entry.workspaceIdentity,
                remoteSessionId,
                sessionId: entry.taskId,
              },
            );
          useZCodeSessionStore.setState({ taskNavHistory: next.history });
          handleSelectTask(
            entry.workspacePath,
            entry.taskId,
            entry.workspaceIdentity,
            meta.unreadAt,
          );
          return;
        }
        if (isCurrent()) {
          useZCodeSessionStore.setState({ taskNavHistory: history });
          toast(
            intl.formatMessage({
              id: direction === "back" ? "taskNav.noMoreBack" : "taskNav.noMoreForward",
            }),
          );
        }
      } catch (error) {
        if (!isCurrent()) return;
        logger.warn("[task-navigation] 历史目标查询或打开失败，保留当前选择和历史", {
          direction,
          error,
        });
        toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
      }
    },
    [
      activateTabByPath,
      baseServices,
      handleSelectTask,
      intl,
      isWebRemoteControl,
      onNavigateToAutomations,
      onNavigateToPluginStore,
      tabStoreApi,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleTaskNavBack = useCallback(() => {
    void navigateHistory("back");
  }, [navigateHistory]);
  const handleTaskNavForward = useCallback(() => {
    void navigateHistory("forward");
  }, [navigateHistory]);

  const canGoBack = navCanGoBack(taskNavHistory);
  const canGoForward = navCanGoForward(taskNavHistory);
  // 深层组件的跳转请求（规格 0.13）在这里落地：本 hook 是 handleSelectTask 的唯一持有者，
  // 订阅放在它这儿才不会出现第二条导航路径。App 只挂一次，所以订阅者唯一。
  const selectTaskRef = useRef(handleSelectTask);
  useLayoutEffect(() => {
    selectTaskRef.current = handleSelectTask;
  });
  useEffect(() => {
    const subscription = onTaskNavigationRequested((request) => {
      selectTaskRef.current(request.workspacePath, request.taskId, request.workspaceIdentity);
    });
    return () => subscription.dispose();
  }, []);

  const currentWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspaceAbsPath);
  const isTaskSwitchLockedByModelRestart = shouldBlockTaskSelectionDuringModelRestart(
    currentWorkspaceState.modelSwitchPending,
    currentWorkspaceState.modelSwitchStage,
  );
  const canTaskNavBack = canGoBack && !isTaskSwitchLockedByModelRestart;
  const canTaskNavForward = canGoForward && !isTaskSwitchLockedByModelRestart;

  return {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  };
}

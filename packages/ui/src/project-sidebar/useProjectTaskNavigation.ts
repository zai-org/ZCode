import { useCallback, useLayoutEffect, useRef } from "react";
import type {
  ProjectSidebarProps,
  ProjectTree,
  IRemoteProjectService,
  ProjectTaskNavigation,
  ProjectTaskNavigationResult,
} from "@/project-sidebar/contract.js";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { openWebRemoteControlTask } from "@/hooks/useWebRemoteControlTaskOpen.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { onTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceConnectionGate } from "@/project-sidebar/useRemoteWorkspaceConnectionGate.js";

/** 打开任务才绑定 workspace；列表 mutation 不借导航创建 scope。 */
export function useProjectTaskNavigation(
  props: ProjectSidebarProps,
  tree: ProjectTree,
  remoteService?: IRemoteProjectService,
): ProjectTaskNavigation {
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const tabStore = useTabStoreApi();
  const waitForConnection = useRemoteWorkspaceConnectionGate(props.reconnectingRemoteWorkspaceKeys);
  const sequence = useRef(0);
  useLayoutEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const latest = useRef({ props, tree, remoteService, activeWorkspaceIdentity, waitForConnection });
  useLayoutEffect(() => {
    latest.current = { props, tree, remoteService, activeWorkspaceIdentity, waitForConnection };
  });
  return useCallback(
    (path, taskId, identity, remoteSessionId, unreadAt, options) => {
      const request = ++sequence.current;
      const cancelled: ProjectTaskNavigationResult = {
        status: "unavailable",
        reason: "project.navigation-cancelled",
      };
      const { props, tree, remoteService, activeWorkspaceIdentity, waitForConnection } =
        latest.current;
      const readFocus = () =>
        props.workspacePath
          ? useZCodeSessionStore
              .getState()
              .getWorkspaceState(props.workspacePath, activeWorkspaceIdentity ?? undefined)
          : undefined;
      const originFocus = readFocus();
      let selecting = false;
      let supersededByNavigation = false;
      const navigationObserver = onTaskNavigationCommitted(() => {
        if (!selecting) supersededByNavigation = true;
      });
      // 同一目录内切换任务或新草稿也会使旧连接失效，不能仅比较 workspace 身份。
      const isCurrent = () =>
        !options?.signal?.aborted &&
        !supersededByNavigation &&
        sequence.current === request &&
        latest.current.activeWorkspaceIdentity === activeWorkspaceIdentity &&
        readFocus()?.activeTaskId === originFocus?.activeTaskId &&
        readFocus()?.draftFocusVersion === originFocus?.draftFocusVersion &&
        (!identity ||
          latest.current.tree.tasks.some(
            (task) => task.taskId === taskId && task.workspaceIdentity === identity,
          ));
      const selectionResult = (): ProjectTaskNavigationResult => {
        const state = tabStore.getState();
        // 原回调会在模型重建或远端 scope 不可用时拒绝选择；投递事件不能冒充实际打开。
        return (state.activeWorkspaceIdentity || state.activeWorkspacePath) ===
          (identity || path) &&
          useZCodeSessionStore.getState().getWorkspaceState(path, identity).activeTaskId === taskId
          ? { status: "opened" }
          : { status: "unavailable", reason: "project.navigation-rejected" };
      };
      const open = async (): Promise<ProjectTaskNavigationResult> => {
        if (options?.signal?.aborted) return cancelled;
        const task = tree.tasks.find(
          (item) =>
            item.taskId === taskId &&
            (item.workspaceIdentity || item.workspacePath) === (identity || path),
        );
        if (props.webRemoteControlWorkspaceSwitcher) {
          if (!task) throw new Error("project.task-not-found");
          await openWebRemoteControlTask({
            switcher: props.webRemoteControlWorkspaceSwitcher,
            activeWorkspacePath: props.workspacePath,
            activeWorkspaceIdentity: activeWorkspaceIdentity ?? undefined,
            activeTaskId: null,
            task: {
              ...task,
              workspacePath: path,
              workspaceIdentity: identity,
              taskId,
              unreadAt,
              workspaceLabel: path,
              workspaceKind: task.hostId === "local" ? "local" : "remote",
            },
            markTaskReadOnOpen: true,
            mobileNavigationIntent: "chat",
            onSelectTask: props.onSelectTask,
            onTaskOpen: props.onWebRemoteTaskOpen,
            onSwitchingChange: props.onWebRemoteTaskSwitchingChange,
            setError: (error) => {
              if (error) toast(error);
            },
          });
          return selectionResult();
        }
        if (identity && task && remoteService) {
          const directory = await remoteService.readDirectory();
          if (!isCurrent()) return cancelled;
          if (directory.hosts.some((host) => host.id === task.hostId)) {
            remoteSessionId = await attachRemoteProjectWorkspace({
              hostId: task.hostId,
              workspacePath: path,
              workspaceIdentity: identity,
              remoteService,
              isCurrent,
              findSession: (key) =>
                Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
                  (session) => session.workspaceIdentity === key,
                ),
              waitForPendingConnection: waitForConnection,
              connect: props.onConnectRemote,
              bind: (sessionId, workspacePath, guard) =>
                props.onSelectRemoteProject(sessionId, workspacePath, undefined, identity, guard),
              cancel: props.onCancelRemoteProject,
            });
          }
        }
        // 远端绑定会合法改变 workspace/focus；提交选择前只复验本请求的取消及代际。
        if (options?.signal?.aborted || sequence.current !== request || supersededByNavigation)
          return cancelled;
        // 必须观察本次调用产生的完整导航提交；缓存 activeTaskId 可能仍属于已离开的草稿。
        let committed = false;
        const subscription = onTaskNavigationCommitted((target) => {
          if (
            sequence.current === request &&
            !options?.signal?.aborted &&
            target.taskId === taskId &&
            (target.workspaceIdentity || target.workspacePath) === (identity || path)
          )
            committed = true;
        });
        try {
          selecting = true;
          await props.onSelectTask(path, taskId, identity, remoteSessionId, unreadAt);
          if (sequence.current !== request || options?.signal?.aborted) return cancelled;
          return committed
            ? selectionResult()
            : { status: "unavailable", reason: "project.navigation-rejected" };
        } finally {
          subscription.dispose();
        }
      };
      return open()
        .catch((error): ProjectTaskNavigationResult => {
          // Bug 原因：首连等待期间连点任务，被替代的旧点击会抛 navigation-cancelled，或与新点击共享
          // 同一连接失败，每次都弹错误。被替代是用户的新意图，结果只由最新导航提示。
          if (
            options?.signal?.aborted ||
            supersededByNavigation ||
            sequence.current !== request ||
            (error instanceof Error && error.message === "project.navigation-cancelled")
          )
            return cancelled;
          logger.error("[project-sidebar] 打开任务失败", error);
          toast(String(error));
          return {
            status: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        })
        .finally(() => navigationObserver.dispose());
    },
    [tabStore],
  );
}

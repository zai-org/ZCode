import { useCallback, useEffect, useRef } from "react";
import type {
  IRemoteProjectService,
  ProjectSidebarProps,
  ProjectTask,
  RemoteProjectDirectory,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { getPathLeaf } from "@/lib/path.js";
import { resolveProjectFileTarget } from "@/project-sidebar/project-file-navigation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useRemoteWorkspaceConnectionGate } from "@/project-sidebar/useRemoteWorkspaceConnectionGate.js";

export function useProjectFileTree(
  props: ProjectSidebarProps,
  directory: RemoteProjectDirectory,
  remoteService?: IRemoteProjectService,
) {
  const {
    workspacePath,
    workspaceIdentity,
    webRemoteControlWorkspaceSwitcher,
    onConnectRemote,
    onSelectRemoteProject,
    onCancelRemoteProject,
    onOpenFileManager,
    fileTreeOpenRequest,
    reconnectingRemoteWorkspaceKeys,
  } = props;
  const { hosts } = directory;
  const request = useRef(0);
  const waitForConnection = useRemoteWorkspaceConnectionGate(reconnectingRemoteWorkspaceKeys);
  const consumedRequest = useRef<ProjectSidebarProps["fileTreeOpenRequest"]>(null);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    const next = fileTreeOpenRequest;
    if (!next || consumedRequest.current === next || !onOpenFileManager) return;
    consumedRequest.current = next;
    request.current++;
    onOpenFileManager(next.target);
  }, [fileTreeOpenRequest, onOpenFileManager]);
  const openFiles = useCallback(
    async (project: VirtualProject, rootPath: string) => {
      const generation = ++request.current;
      const isCurrent = () => generation === request.current;
      // Bug 原因：代际只在最后挡住文件面板，被取代的旧请求在等重连结束后仍会连接设备并 bind，
      // bind 会切换 tab、新建草稿，还会抢走同设备的在途连接，让最新请求失败。现在把代际交给导航
      // 和 bind，旧请求在发起连接、接管连接和写 tab 前退出；取代是用户的新意图，旧请求不提示错误。
      const target = await resolveProjectFileTarget({
        isCurrent,
        project,
        rootPath,
        props: {
          workspacePath,
          workspaceIdentity,
          webRemoteControlWorkspaceSwitcher,
          onConnectRemote,
          onSelectRemoteProject,
          onCancelRemoteProject,
        },
        remoteService,
        isRemote: hosts.some((host) => host.id === project.hostId),
        findSession: (identity) =>
          Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
            (session) => session.workspaceIdentity === identity,
          ),
        waitForPendingConnection: waitForConnection,
      }).catch((error: unknown) => {
        if (isCurrent()) throw error;
        return null;
      });
      // 原因：连接完成可能晚于另一次查看/关闭，旧目标不得覆盖最新文件树选择。
      if (target && isCurrent()) onOpenFileManager?.(target);
    },
    // 原因：依赖整个 props 会把返回按钮等无关变化传播到全部项目；保留真实导航依赖及取消代际。
    [
      workspacePath,
      workspaceIdentity,
      webRemoteControlWorkspaceSwitcher,
      onConnectRemote,
      onSelectRemoteProject,
      onCancelRemoteProject,
      onOpenFileManager,
      hosts,
      remoteService,
      waitForConnection,
    ],
  );

  const openTaskFiles = useCallback(
    async (task: ProjectTask, remoteSessionId?: string) => {
      const generation = ++request.current;
      const identity = task.workspaceIdentity?.trim();
      const key = identity || task.workspacePath;
      if (
        webRemoteControlWorkspaceSwitcher &&
        (workspaceIdentity?.trim() || workspacePath) !== key
      ) {
        await webRemoteControlWorkspaceSwitcher.switchWorkspace(key, {
          taskHostId: task.hostId,
          fileTreeTaskId: task.taskId,
          mobileNavigationIntent: "chat",
        });
        // 跨 workspace 由新 Root 消费文件请求，旧页面不能再次创建标签。
        return;
      }
      if (generation !== request.current) return;
      const sessions = useRemoteWorkspaceSessionStore.getState();
      const sessionId = identity
        ? (sessions.sessionIdByWorkspaceIdentity[identity] ?? remoteSessionId)
        : undefined;
      const session = sessionId ? sessions.sessionsById[sessionId] : undefined;
      // 原因：远端 cwd 可与本地同名；只接受该任务 identity 对应的 session，不能退回本机读取。
      // 手机 bridge 将 identity 绑定单独保存在索引，不一定重复写入 session 元数据。
      if (
        identity &&
        (!session ||
          (sessions.sessionIdByWorkspaceIdentity[identity] !== sessionId &&
            session.workspaceIdentity !== identity))
      )
        throw new Error("project.connection-unavailable");
      // worktree 任务的文件在它自己的 cwd 中，不在项目主目录（docs/git/worktree.md §3.7）。
      const filesPath = task.cwd ?? task.workspacePath;
      onOpenFileManager?.({
        workspacePath: filesPath,
        workspaceName: getPathLeaf(filesPath) || filesPath,
        ...(identity ? { workspaceIdentity: identity, workspaceRemoteSessionId: sessionId } : {}),
      });
    },
    [webRemoteControlWorkspaceSwitcher, workspaceIdentity, workspacePath, onOpenFileManager],
  );
  return { openFiles, openTaskFiles };
}

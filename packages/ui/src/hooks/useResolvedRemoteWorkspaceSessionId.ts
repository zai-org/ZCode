import { useTabStore } from "@/store/TabStoreProvider.js";
import { useShallow } from "zustand/react/shallow";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  resolveWorkspaceRemoteSessionId,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";

export function resolveRemoteWorkspaceSessionIdForTarget<TServices>(params: {
  workspacePath: string | null | undefined;
  preferredRemoteSessionId?: string | null;
  workspaceIdentity?: string | null;
  remoteTarget?: unknown;
  activeTab?: Pick<
    WorkspaceTabState,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "remoteTarget"
  > | null;
  state: WorkspaceServiceResolverState<TServices>;
}): string | null {
  if (!params.workspacePath) {
    return null;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const matchingActiveTab =
    params.activeTab &&
    (workspaceIdentity
      ? params.activeTab.workspaceIdentity?.trim() === workspaceIdentity
      : params.activeTab.workspacePath === params.workspacePath)
      ? params.activeTab
      : null;
  const activeTabWorkspaceIdentity = matchingActiveTab?.workspaceIdentity?.trim() || undefined;
  const explicitRemoteSessionId = [
    params.preferredRemoteSessionId,
    matchingActiveTab?.remoteSessionId,
  ].find((candidateSessionId): candidateSessionId is string =>
    Boolean(candidateSessionId && params.state.sessionsById[candidateSessionId]),
  );

  return (
    resolveWorkspaceRemoteSessionId(
      {
        workspacePath: params.workspacePath,
        workspaceIdentity: workspaceIdentity ?? activeTabWorkspaceIdentity,
        remoteSessionId: explicitRemoteSessionId,
        // 缺少 identity 也可能是 local workspace，不能一律伪造成旧 remote tab。
        // 只有精确匹配的 active tab，或调用方已定位的目标 tab 真正携带 remoteTarget 时，
        // 才开放旧数据的 path fallback。
        remoteTarget: matchingActiveTab?.remoteTarget ?? params.remoteTarget,
      },
      params.state,
    ) ?? null
  );
}

export function useResolvedRemoteWorkspaceSessionId(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): string | null {
  const activeWorkspaceTab = useTabStore(
    useShallow((state) => {
      if (!workspacePath || !state.activeTabId) {
        return null;
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!activeTab || !isWorkspaceTab(activeTab)) {
        return null;
      }

      const matches = workspaceIdentity
        ? activeTab.workspaceIdentity?.trim() === workspaceIdentity.trim()
        : activeTab.workspacePath === workspacePath;
      // 首次新建补全 tab 分类曾让同工作区所有会话行更新；只订阅连接解析真正消费的字段。
      return matches
        ? {
            workspacePath: activeTab.workspacePath,
            workspaceIdentity: activeTab.workspaceIdentity,
            remoteSessionId: activeTab.remoteSessionId,
            remoteTarget: activeTab.remoteTarget,
          }
        : null;
    }),
  );

  return useRemoteWorkspaceSessionStore((state) =>
    resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath,
      preferredRemoteSessionId,
      workspaceIdentity,
      remoteTarget,
      activeTab: activeWorkspaceTab,
      state,
    }),
  );
}

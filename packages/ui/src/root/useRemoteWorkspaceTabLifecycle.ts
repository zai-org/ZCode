import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspaceIdentity,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import {
  isWorkspaceTab,
  type TabStoreState,
  type WindowTabState,
  type WorkspaceTabState,
} from "@/store/tabStore.js";

function remoteWorkspaceKey(tab: WorkspaceTabState): string | null {
  if (
    !tab.workspaceIdentity?.trim() &&
    !tab.remoteSessionId &&
    !tab.remoteTarget
  ) {
    return null;
  }

  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

export function collectClosedRemoteWorkspaceKeys(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
): string[] {
  const nextRemoteWorkspaceKeys = new Set(
    nextWorkspaceTabs.flatMap((tab) => {
      const workspaceKey = remoteWorkspaceKey(tab);
      return workspaceKey ? [workspaceKey] : [];
    }),
  );
  const closedRemoteWorkspaceKeys = new Set<string>();

  for (const previousTab of previousWorkspaceTabs) {
    const workspaceKey = remoteWorkspaceKey(previousTab);
    const sameTab = nextWorkspaceTabs.find((tab) => tab.id === previousTab.id);
    const rekeyedTab = nextWorkspaceTabs.find(
      (tab) => tab.previousWorkspaceIdentity?.trim() === workspaceKey,
    );
    if (
      !workspaceKey ||
      nextRemoteWorkspaceKeys.has(workspaceKey) ||
      Boolean(sameTab) ||
      Boolean(rekeyedTab)
    ) {
      continue;
    }
    closedRemoteWorkspaceKeys.add(workspaceKey);
  }

  return [...closedRemoteWorkspaceKeys];
}

export function collectClosedRemoteWorkspaceSessionIds(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
  rememberedSessionIdsByWorkspaceKey: ReadonlyMap<string, string>,
): string[] {
  const previousLiveSessionIds = new Set(
    previousWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  return collectClosedRemoteWorkspaceKeys(
    previousWorkspaceTabs,
    nextWorkspaceTabs,
  ).flatMap((workspaceKey) => {
      const sessionId = rememberedSessionIdsByWorkspaceKey.get(workspaceKey);
      // 仍带 remoteSessionId 的 tab 会由本 hook 下方的正常移除流程释放，
      // 这里只补释放“先断连、后清掉 tab 字段”的 session，避免重复 dispose。
    return sessionId && !previousLiveSessionIds.has(sessionId)
      ? [sessionId]
      : [];
  });
}

export function useRemoteWorkspaceTabLifecycle({
  tabs,
  activeWorkspaceTab,
  platform,
  onRemoteWorkspaceTabsClosed,
  tabStoreApi,
}: {
  tabs: WindowTabState[];
  activeWorkspaceTab: WorkspaceTabState | null;
  platform: IPlatformService;
  onRemoteWorkspaceTabsClosed?: (workspaceKeys: string[]) => void;
  tabStoreApi?: {
    getState(): { lastClosedWorkspaceEvent: TabStoreState["lastClosedWorkspaceEvent"] };
    subscribe(
      listener: (state: {
        lastClosedWorkspaceEvent: TabStoreState["lastClosedWorkspaceEvent"];
      }) => void,
    ): () => void;
  };
}) {
  const previousWorkspaceTabsRef = useRef<WindowTabState[]>([]);
  const rememberedSessionIdsByWorkspaceKeyRef = useRef<Map<string, string>>(
    new Map(),
  );
  const explicitlyClosedWorkspaceKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const previousWorkspaceTabs =
      previousWorkspaceTabsRef.current.filter(isWorkspaceTab);
    const nextWorkspaceTabs = tabs.filter(isWorkspaceTab);
    const closedRemoteWorkspaceKeys = collectClosedRemoteWorkspaceKeys(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
    );
    const closedRemoteSessionIds = collectClosedRemoteWorkspaceSessionIds(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      rememberedSessionIdsByWorkspaceKeyRef.current,
    );
    if (!tabStoreApi && closedRemoteWorkspaceKeys.length > 0) {
      onRemoteWorkspaceTabsClosed?.(closedRemoteWorkspaceKeys);
      for (const workspaceKey of closedRemoteWorkspaceKeys) {
        rememberedSessionIdsByWorkspaceKeyRef.current.delete(workspaceKey);
      }
    }
    for (const tab of nextWorkspaceTabs) {
      const workspaceKey = remoteWorkspaceKey(tab);
      if (workspaceKey && tab.remoteSessionId) {
        rememberedSessionIdsByWorkspaceKeyRef.current.set(
          workspaceKey,
          tab.remoteSessionId,
        );
      }
    }

    for (const sessionId of closedRemoteSessionIds) {
      if (
        tabStoreApi &&
        ![...explicitlyClosedWorkspaceKeysRef.current].some(
          (workspaceKey) =>
            rememberedSessionIdsByWorkspaceKeyRef.current.get(workspaceKey) ===
            sessionId,
        )
      ) {
        continue;
      }
      void (async () => {
        try {
          // 断连事件会先清掉 tab 上的 remoteSessionId，导致下方正常移除流程
          // 无法释放该 session。这里使用记忆的 sessionId 补齐“断连后再关闭 tab”的清理路径。
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放断连远程 session 失败:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    const nextRemoteSessionIds = new Set(
      nextWorkspaceTabs
        .map((tab) => tab.remoteSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );

    for (const previousTab of previousWorkspaceTabs) {
      const stillExists = nextWorkspaceTabs.some(
        (nextTab) => nextTab.id === previousTab.id,
      );
      if (stillExists) {
        continue;
      }

      if (!previousTab.remoteSessionId) {
        continue;
      }

      const survivingRemoteTab = nextWorkspaceTabs.find((nextTab) => {
        if (!nextTab.remoteSessionId) {
          return false;
        }

        if (previousTab.workspaceIdentity && nextTab.workspaceIdentity) {
          return nextTab.workspaceIdentity === previousTab.workspaceIdentity;
        }

        return nextTab.workspacePath === previousTab.workspacePath;
      });

      if (survivingRemoteTab?.remoteSessionId) {
        // 之前只按 workspacePath 维护映射，关闭同路径 remote tab 时会把另一个远端 tab 一起“解绑”。
        // 这里优先复用幸存 tab 的绑定，并同步刷新 workspaceIdentity 映射，避免后续 RPC 命中错误 session。
        bindRemoteWorkspacePath(
          survivingRemoteTab.workspacePath,
          survivingRemoteTab.remoteSessionId,
        );
        if (survivingRemoteTab.workspaceIdentity) {
          bindRemoteWorkspaceIdentity(
            survivingRemoteTab.workspaceIdentity,
            survivingRemoteTab.remoteSessionId,
          );
        }
      } else {
        unbindRemoteWorkspacePath(previousTab.workspacePath);
        if (previousTab.workspaceIdentity) {
          unbindRemoteWorkspaceIdentity(previousTab.workspaceIdentity);
        }
      }
    }

    const disposedSessionIds = new Set<string>();
    for (const previousTab of previousWorkspaceTabs) {
      const sessionId = previousTab.remoteSessionId;
      if (
        !sessionId ||
        nextRemoteSessionIds.has(sessionId) ||
        disposedSessionIds.has(sessionId)
      ) {
        continue;
      }
      if (
        tabStoreApi &&
        !explicitlyClosedWorkspaceKeysRef.current.has(
          remoteWorkspaceKey(previousTab) ?? "",
        )
      ) {
        continue;
      }

      disposedSessionIds.add(sessionId);
      const workspacePath = previousTab.workspacePath;
      void (async () => {
        try {
          logger.info(
            "[Root] remote workspace tab 已移除，主动释放远程 session",
            {
            workspacePath,
            workspaceIdentity: previousTab.workspaceIdentity,
            sessionId,
            },
          );
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放远程 session 失败:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    previousWorkspaceTabsRef.current = nextWorkspaceTabs;
    explicitlyClosedWorkspaceKeysRef.current.clear();
  }, [onRemoteWorkspaceTabsClosed, platform, tabStoreApi, tabs]);

  useEffect(() => {
    if (!tabStoreApi || !onRemoteWorkspaceTabsClosed) return;
    // Bug 原因：lastSequence 每次重新订阅都归零；回调随 controller 重建而变化，重订阅后的下一次
    // store 变化会重放订阅前的 user-close，清掉同目录重新打开后的“连接中”、取消其在途重连并删除
    // 远程历史。从订阅时的最新序号开始，只处理之后的关闭事件。
    let lastSequence = tabStoreApi.getState().lastClosedWorkspaceEvent?.sequence ?? 0;
    return tabStoreApi.subscribe((state) => {
      const event = state.lastClosedWorkspaceEvent;
      if (!event || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      if (event.origin === "user-close") {
        explicitlyClosedWorkspaceKeysRef.current.add(event.workspaceKey);
        onRemoteWorkspaceTabsClosed([event.workspaceKey]);
      }
    });
  }, [onRemoteWorkspaceTabsClosed, tabStoreApi]);

  useEffect(() => {
    if (!activeWorkspaceTab?.remoteSessionId) {
      return;
    }

    // 同一路径的多个 remote tab 之间切换时，不能只在建连时绑定一次路径映射，
    // 否则切换后映射仍停留在旧 tab，按 workspacePath 解析服务的 hook 仍可能命中旧 session。
    // 这里在 active tab 切换后把路径与 workspaceIdentity 映射刷新到当前 tab，保证 workspace 级 RPC 跟着当前 tab 走。
    bindRemoteWorkspacePath(
      activeWorkspaceTab.workspacePath,
      activeWorkspaceTab.remoteSessionId,
    );
    if (activeWorkspaceTab.workspaceIdentity) {
      bindRemoteWorkspaceIdentity(
        activeWorkspaceTab.workspaceIdentity,
        activeWorkspaceTab.remoteSessionId,
      );
    }
  }, [
    activeWorkspaceTab?.remoteSessionId,
    activeWorkspaceTab?.workspaceIdentity,
    activeWorkspaceTab?.workspacePath,
  ]);
}

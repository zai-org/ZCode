import { useSyncExternalStore } from "react";
import { buildPluginUiSessionKey, type PluginUiSessionScope } from "@/plugin-ui/contract.js";
import {
  effectiveFocusedPaneId,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

type RetainSession = (onInvalidated: () => void) => () => void;
interface PaneSession {
  paneSessionId: string | null;
  scope: PluginUiSessionScope;
  retain?: RetainSession;
}

// 这里只投影挂载 pane 的有效绑定；创建、换代与回收仍由草稿协调器唯一持有。
const sessions = new Map<string, PaneSession>();
const listeners = new Set<() => void>();
const keyOf = (workspaceKey: string, paneId: string) => JSON.stringify([workspaceKey, paneId]);
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function getPluginUiPaneSession(workspaceKey: string, paneId: string): PaneSession | null {
  return sessions.get(keyOf(workspaceKey, paneId)) ?? null;
}

export function registerPluginUiPaneSession(
  paneId: string,
  paneSessionId: string | null,
  scope: PluginUiSessionScope,
  retain?: RetainSession,
): () => void {
  const key = keyOf(scope.workspaceIdentity?.trim() || scope.workspacePath, paneId);
  const value = { paneSessionId, scope, retain };
  sessions.set(key, value);
  notify();
  return () => {
    if (sessions.get(key) !== value) return;
    sessions.delete(key);
    notify();
  };
}

export function retainPluginUiSession(
  scope: PluginUiSessionScope,
  onInvalidated: () => void,
): (() => void) | undefined {
  const key = buildPluginUiSessionKey(scope);
  for (const session of sessions.values()) {
    if (buildPluginUiSessionKey(session.scope) === key) return session.retain?.(onInvalidated);
  }
}

export function usePluginUiPaneTarget(
  shell: Omit<PluginUiSessionScope, "sessionId"> & { sessionId: string | null },
) {
  const group = useWorkbenchGroupStore((state) =>
    state.activeGroupId ? state.groups[state.activeGroupId] : undefined,
  );
  const paneId = usePaneLayoutStore((state) => effectiveFocusedPaneId(state));
  const panes = usePaneLayoutStore((state) => state.panes);
  const focusedPaneId = group?.focusedPaneId ?? paneId;
  const binding = (group?.panes ?? panes)[focusedPaneId];
  const scope = binding?.workspaceScope ?? shell;
  const shellWorkspaceKey = shell.workspaceIdentity?.trim() || shell.workspacePath;
  const shellOwnedBySplit =
    !group &&
    shell.sessionId &&
    Object.values(panes).some(
      (pane) =>
        pane.sessionId === shell.sessionId &&
        (pane.workspaceScope.workspaceIdentity?.trim() || pane.workspaceScope.workspacePath) ===
          shellWorkspaceKey,
    );
  const paneSessionId = binding
    ? binding.sessionId
    : focusedPaneId === V4_PRIMARY_PANE_ID && !shellOwnedBySplit
      ? shell.sessionId
      : null;
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  const projected = useSyncExternalStore(
    subscribe,
    () => getPluginUiPaneSession(workspaceKey, focusedPaneId),
    () => null,
  );
  return {
    ...scope,
    paneId: focusedPaneId,
    sessionId: binding?.readOnly
      ? null
      : projected?.paneSessionId === paneSessionId
        ? projected.scope.sessionId
        : paneSessionId,
  };
}

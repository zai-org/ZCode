import { useCallback, useEffect, useSyncExternalStore } from "react";
import { buildPluginUiSessionKey, type PluginUiSessionScope } from "@/plugin-ui/contract.js";
import type { PluginUiModelContext } from "@/plugin-ui/domain/pluginUiModelContext.js";

// 待发送上下文随 session 保存在窗口内；卸载 Composer 只撤销投递能力。
const pending = new Map<string, readonly PluginUiModelContext[]>();
const empty: readonly PluginUiModelContext[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function update(key: string, items: readonly PluginUiModelContext[]) {
  if (items.length) pending.set(key, items);
  else pending.delete(key);
  for (const listener of listeners) listener();
}
export function clearPluginUiModelContexts(scope: PluginUiSessionScope) {
  update(buildPluginUiSessionKey(scope), empty);
}
const receivers = new Map<string, (context: PluginUiModelContext) => void>();

export function registerPluginUiModelContextReceiver(
  scope: PluginUiSessionScope,
  receive: (context: PluginUiModelContext) => void,
): () => void {
  const key = buildPluginUiSessionKey(scope);
  receivers.set(key, receive);
  return () => {
    if (receivers.get(key) === receive) receivers.delete(key);
  };
}

/** 修复：window 事件只按 sessionId 过滤，会把相同 session 的上下文投给其它 workspace。 */
export function dispatchPluginUiModelContextAdd(
  scope: PluginUiSessionScope,
  context: PluginUiModelContext,
): boolean {
  const receive = receivers.get(buildPluginUiSessionKey(scope));
  if (!receive || scope.sessionId !== context.sessionId) return false;
  receive(context);
  return true;
}

export function usePluginUiModelContexts(
  input: Omit<PluginUiSessionScope, "sessionId"> & { sessionId: string | null },
): {
  contexts: readonly PluginUiModelContext[];
  hasContexts: boolean;
  removeContext: (id: string) => void;
  clearContexts: () => void;
} {
  const key = input.sessionId
    ? buildPluginUiSessionKey({ ...input, sessionId: input.sessionId })
    : null;
  const { sessionId, workspacePath, workspaceIdentity } = input;
  const contexts = useSyncExternalStore(
    subscribe,
    () => (key ? (pending.get(key) ?? empty) : empty),
    () => empty,
  );
  useEffect(() => {
    if (!sessionId) return;
    return registerPluginUiModelContextReceiver(
      { workspacePath, workspaceIdentity, sessionId },
      (context) => {
        if (!key) return;
        const items = pending.get(key) ?? empty;
        const index = items.findIndex((item) => item.id === context.id);
        update(
          key,
          index < 0
            ? [...items, context]
            : items.map((item) => (item.id === context.id ? context : item)),
        );
      },
    );
  }, [key, sessionId, workspacePath, workspaceIdentity]);
  const removeContext = useCallback(
    (id: string) => {
      if (key)
        update(
          key,
          (pending.get(key) ?? empty).filter((item) => item.id !== id),
        );
    },
    [key],
  );
  const clearContexts = useCallback(() => {
    if (key) update(key, empty);
  }, [key]);
  return { contexts, hasContexts: contexts.length > 0, removeContext, clearContexts };
}

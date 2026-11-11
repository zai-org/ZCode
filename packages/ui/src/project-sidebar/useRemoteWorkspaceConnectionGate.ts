import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * 把 Root 的 reconnectingRemoteWorkspaceKeys 变成可等待的门：key 离开集合即放行。
 * 集合由重连 helper（finally 移除）与 Source 可恢复断连（换代、终止或关闭 tab 时移除）维护；
 * 这里只观察这一事实，不新增状态或超时。
 */
export function useRemoteWorkspaceConnectionGate(pendingKeys: readonly string[]) {
  const keys = useRef(pendingKeys);
  const waiters = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    keys.current = pendingKeys;
    for (const wake of waiters.current) wake();
  }, [pendingKeys]);
  return useCallback(
    (workspaceKey: string) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          if (keys.current.includes(workspaceKey)) return;
          waiters.current.delete(wake);
          resolve();
        };
        waiters.current.add(wake);
        wake();
      }),
    [],
  );
}

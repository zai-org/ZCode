import type {
  AppControlNavigationBridge,
  AppNavigationHostMessage,
  AppNavigationResult,
} from "#src/app-control-navigation/contract.js";

/** 只关联在途导航 RPC；项目权限与会话事实仍由 AppControlService 校验。 */
export function createAppControlNavigationBridge(deps: {
  post(message: AppNavigationHostMessage): void;
}): AppControlNavigationBridge {
  const pending = new Map<string, { finish(result: AppNavigationResult): void }>();
  let disposed = false;
  return {
    async openSession(input) {
      if (disposed) return { status: "unavailable", reason: "host-disposed" };
      if (input.binding.signal.aborted) return { status: "unavailable", reason: "cancelled" };
      try {
        input.binding.assertCurrent();
      } catch {
        return { status: "unavailable", reason: "stale-connection" };
      }
      const requestId = crypto.randomUUID();
      return new Promise<AppNavigationResult>((resolve) => {
        const finish = (result: AppNavigationResult) => {
          if (!pending.delete(requestId)) return;
          input.binding.signal.removeEventListener("abort", cancel);
          if (result.status === "opened") {
            try {
              input.binding.assertCurrent();
              if (input.binding.signal.aborted) {
                resolve({ status: "unavailable", reason: "cancelled" });
                return;
              }
            } catch {
              resolve({ status: "unavailable", reason: "stale-connection" });
              return;
            }
          }
          resolve(result);
        };
        const cancel = () => {
          try {
            deps.post({ type: "app-navigation-cancel", requestId });
          } catch {
            // 取消时通道可能已关闭；本地等待仍需结束，旧回执不能再接纳。
          }
          finish({ status: "unavailable", reason: "cancelled" });
        };
        pending.set(requestId, { finish });
        input.binding.signal.addEventListener("abort", cancel, { once: true });
        if (input.binding.signal.aborted) {
          finish({ status: "unavailable", reason: "cancelled" });
          return;
        }
        try {
          deps.post({
            type: "app-navigation-open",
            requestId,
            uiTarget: input.uiTarget ?? input.binding.uiTarget,
            target: {
              workspacePath: input.session.workspacePath,
              ...(input.session.workspaceIdentity
                ? { workspaceIdentity: input.session.workspaceIdentity }
                : {}),
              taskId: input.session.sessionId,
            },
          });
        } catch {
          finish({ status: "unavailable", reason: "transport-unavailable" });
        }
      });
    },
    receive(message) {
      pending.get(message.requestId)?.finish(message.result);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [requestId, entry] of pending) {
        try {
          deps.post({ type: "app-navigation-cancel", requestId });
        } catch {
          // 通道已断时仍必须释放等待者，不能等待一个不可能到达的 renderer 回执。
        }
        entry.finish({ status: "unavailable", reason: "host-disposed" });
      }
    },
  };
}

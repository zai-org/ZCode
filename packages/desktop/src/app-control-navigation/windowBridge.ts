import type {
  AppControlNavigationWindow,
  AppNavigationRendererMessage,
  AppNavigationResult,
  AppNavigationSource,
} from "#src/app-control-navigation/contract.js";

/** BrowserWindow 生命周期内的在途关联；不持有 session、项目或已接纳命令状态。 */
export function createAppControlNavigationWindow(deps: {
  uiTarget: string;
  send(message: AppNavigationRendererMessage): void;
}): AppControlNavigationWindow {
  let generation: string | undefined;
  let disposed = false;
  const pending = new Map<string, { source: AppNavigationSource; generation: string }>();
  const finish = (requestId: string, result: AppNavigationResult, cancel = false) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    if (cancel) {
      try {
        deps.send({ type: "cancel", requestId, generation: entry.generation });
      } catch {
        /* renderer 已销毁时只能结束 Host 等待。 */
      }
    }
    try {
      entry.source.reply({
        type: "app-navigation-result",
        requestId,
        result: result.status === "opened" ? { status: "opened", uiTarget: deps.uiTarget } : result,
      });
    } catch {
      /* Host 已退出，不再保留无法交付的等待者。 */
    }
  };
  const invalidate = (reason: string) => {
    generation = undefined;
    for (const requestId of pending.keys())
      finish(requestId, { status: "unavailable", reason }, true);
  };
  return {
    register(next) {
      if (disposed || generation === next) return;
      invalidate("renderer-replaced");
      generation = next;
    },
    unregister(current) {
      if (generation === current) invalidate("renderer-unavailable");
    },
    open(source, message) {
      const reject = (reason: string) =>
        source.reply({
          type: "app-navigation-result",
          requestId: message.requestId,
          result: { status: "unavailable", reason },
        });
      if (message.uiTarget && message.uiTarget !== deps.uiTarget) {
        reject("ui-target-unavailable");
        return;
      }
      if (disposed || !generation) {
        reject("renderer-unavailable");
        return;
      }
      if (pending.has(message.requestId)) {
        reject("duplicate-request");
        return;
      }
      pending.set(message.requestId, { source, generation });
      try {
        deps.send({
          type: "open",
          requestId: message.requestId,
          generation,
          target: message.target,
        });
      } catch {
        finish(message.requestId, { status: "unavailable", reason: "renderer-unavailable" });
      }
    },
    cancel(source, requestId) {
      if (pending.get(requestId)?.source === source)
        finish(requestId, { status: "unavailable", reason: "cancelled" }, true);
    },
    complete(message) {
      const entry = pending.get(message.requestId);
      // 旧 renderer 即使重用了同一 requestId，也不能为新 generation 提交回执。
      if (!entry || entry.generation !== message.generation || generation !== message.generation)
        return;
      finish(message.requestId, message.result);
    },
    detach(source) {
      for (const [requestId, entry] of pending) {
        if (entry.source === source)
          finish(requestId, { status: "unavailable", reason: "host-unavailable" }, true);
      }
    },
    invalidate() {
      invalidate("renderer-unavailable");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate("window-closed");
    },
  };
}

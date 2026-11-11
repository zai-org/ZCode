import type {
  AppNavigationRendererMessage,
  AppNavigationRendererResult,
  AppNavigationResult,
  AppNavigationTarget,
} from "#src/app-control-navigation/contract.js";

export function registerAppControlNavigationHandler(
  transport: {
    subscribe(handler: (message: AppNavigationRendererMessage) => void): () => void;
    register(generation: string): void;
    unregister(generation: string): void;
    reply(message: AppNavigationRendererResult): void;
  },
  handler: (target: AppNavigationTarget, signal: AbortSignal) => Promise<AppNavigationResult>,
  generation: string,
): () => void {
  let disposed = false;
  const pending = new Map<string, AbortController>();
  const unsubscribe = transport.subscribe((message) => {
    if (disposed || message.generation !== generation) return;
    if (message.type === "cancel") {
      pending.get(message.requestId)?.abort();
      pending.delete(message.requestId);
      return;
    }
    if (pending.has(message.requestId)) return;
    // 同一窗口只有一个导航意图，新请求让旧远端连接结果失去选择资格。
    for (const [requestId, current] of pending) {
      pending.delete(requestId);
      current.abort();
      transport.reply({
        requestId,
        generation,
        result: { status: "unavailable", reason: "superseded" },
      });
    }
    const controller = new AbortController();
    pending.set(message.requestId, controller);
    const finish = (result: AppNavigationResult) => {
      if (pending.get(message.requestId) !== controller) return;
      pending.delete(message.requestId);
      if (disposed) return;
      transport.reply({
        requestId: message.requestId,
        generation,
        result: controller.signal.aborted ? { status: "unavailable", reason: "cancelled" } : result,
      });
    };
    try {
      void handler(message.target, controller.signal).then(finish, (error: unknown) =>
        finish({
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } catch (error) {
      finish({
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  try {
    transport.register(generation);
  } catch (error) {
    disposed = true;
    for (const current of pending.values()) current.abort();
    pending.clear();
    unsubscribe();
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    for (const current of pending.values()) current.abort();
    pending.clear();
    try {
      transport.unregister(generation);
    } finally {
      unsubscribe();
    }
  };
}

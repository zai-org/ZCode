export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export interface McpDeadline {
  expiresAt: number;
  timeoutMs: number;
}

export function createMcpDeadline(timeoutMs: number): McpDeadline {
  const normalizedTimeoutMs = Math.max(0, Math.floor(timeoutMs));
  return {
    expiresAt: Date.now() + normalizedTimeoutMs,
    timeoutMs: normalizedTimeoutMs,
  };
}

export function remainingMcpDeadlineMs(deadline: McpDeadline, timeoutMessage: string): number {
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) {
    throw new McpTimeoutError(timeoutMessage);
  }
  return remainingMs;
}

/**
 * 只限制当前 waiter，不取消传入的共享 promise。底层任务是否取消由自己的 owner signal 决定。
 */
export function waitWithinMcpDeadline<T>(
  promise: Promise<T>,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return withTimeout(promise, Math.max(0, deadline.expiresAt - Date.now()), timeoutMessage, signal);
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"),
      );
    };

    // 共享任务先接上结果处理；caller 已取消或预算耗尽也不能留下无人接管的 rejection。
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    const timeoutHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new McpTimeoutError(timeoutMessage));
    };
    if (timeoutMs !== undefined) {
      if (timeoutMs <= 0) {
        timeoutHandler();
        return;
      }
      timer = setTimeout(timeoutHandler, timeoutMs);
    }
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

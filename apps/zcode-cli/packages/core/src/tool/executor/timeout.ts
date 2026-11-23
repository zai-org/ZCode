import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  isInputPreemptionAbortReason,
  type InputPreemptionHandling,
  type SessionEvent,
} from "@zcode/contracts";
import type {
  InputPreemptionSlot,
  ToolExecutionContext,
  ToolEntry,
  ToolExecutionModelContext,
} from "../types.js";
import { isRecord } from "./utils.js";

/**
 * 可暂停的工具 deadline。
 *
 * 工具内部的模型请求在进程级准入闸门前排队时暂停计时，拿到票再续，剩余时长守恒。超时守的是
 * 「provider 挂了」，不是「我们自己的队列长」：否则闸门把 cap 压低时会把 WebSearch / WebFetch 逐个
 * 逼成 60 s 超时，模型再补搜，越限流越吵（deep-research 实例里 7 次这样的 cancel）。
 * 多个请求并存取并集（计数器）；退避 sleep 不暂停（那是 provider 慢）；`timeoutMs` 缺席时只累计
 * 排队时长、不计时。
 */
export class ToolDeadline {
  private remainingMs: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armedAt = 0;
  private pausedAt = 0;
  private pauseDepth = 0;
  private queuedTotalMs = 0;
  private onExpire: (() => void) | undefined;

  constructor(readonly timeoutMs: number | undefined) {
    this.remainingMs = timeoutMs;
  }

  start(onExpire: () => void): void {
    this.onExpire = onExpire;
    this.arm();
  }

  pause(): void {
    this.pauseDepth += 1;
    if (this.pauseDepth !== 1) return;
    this.pausedAt = Date.now();
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = Math.max(0, (this.remainingMs ?? 0) - (this.pausedAt - this.armedAt));
  }

  resume(): void {
    if (this.pauseDepth === 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth !== 0) return;
    this.queuedTotalMs += Date.now() - this.pausedAt;
    this.arm();
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.onExpire = undefined;
  }

  /** 累计的排队时长（含仍在暂停中的这一段）；超时错误的 context 带它，便于区分「慢」与「等」。 */
  get queuedMs(): number {
    return this.queuedTotalMs + (this.pauseDepth > 0 ? Date.now() - this.pausedAt : 0);
  }

  private arm(): void {
    if (this.onExpire === undefined || this.remainingMs === undefined || this.pauseDepth > 0)
      return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpire?.();
    }, this.remainingMs);
  }
}

/**
 * 从本次工具调用自己的模型状态事件里读准入等待的两端：`queued` 暂停、`admitted` 续。
 * 只认带本 toolCallId 的事件——同一 emitEvent 也会流过别的工具调用的状态。
 */
export function observeToolAdmissionClock(
  event: SessionEvent,
  toolCallId: string,
  deadline: ToolDeadline,
): void {
  if (event.type !== SessionEventType.ModelNetworkStatus) return;
  const payload = event.payload as { type?: unknown; toolCallId?: unknown } | undefined;
  if (payload?.toolCallId !== toolCallId) return;
  if (payload.type === "model_request_queued") deadline.pause();
  else if (payload.type === "model_request_admitted") deadline.resume();
}

export async function executeWithTimeout<TInput, TOutput>(
  handler: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>,
  input: TInput,
  context: ToolExecutionContext,
  deadline: ToolDeadline,
  abortController: AbortController,
  entry: ToolEntry,
  /** 本次调用的输入抢占接管点；context 上只放它的 register，decide 只在这里调用。 */
  inputPreemption?: InputPreemptionSlot,
): Promise<TOutput> {
  return new Promise((resolve, reject) => {
    if (context.abortSignal.aborted) {
      reject(
        createCoreError(
          CoreErrorType.ToolCancelled,
          entry.cancellation?.userVisibleMessage ?? "Tool execution cancelled",
        ),
      );
      return;
    }

    let settled = false;
    let timedOut = false;
    const cleanup = () => {
      deadline.clear();
      context.abortSignal.removeEventListener("abort", abortHandler);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (result: TOutput) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // 无 timeout 工具仍保留父级 abort 监听，但不创建墙钟定时器（deadline.start 对缺席的 timeoutMs 是空操作）。
    const timeoutMs = deadline.timeoutMs;
    deadline.start(() => {
      timedOut = true;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Tool execution timed out after ${timeoutMs}ms`,
        {
          context: {
            cancellation: entry.cancellation?.cleanup ?? "none",
            queuedMs: deadline.queuedMs,
            timeoutMs,
            toolName: entry.metadata.name,
          },
          recoverable: true,
        },
      );
      abortController.abort(error);
      rejectOnce(error);
    });

    const abortHandler = () => {
      if (timedOut) return;
      // 立即发送抢占时，工具注册的判断函数说 wait（前台 Agent 已转后台），就不在这里判取消，
      // 等 handler 返回。runner 在同一次 abort 里调用同一个函数，两边结果一致；
      // 没有注册、判断为 cancel 或其他停止原因时照旧立即取消。
      if (
        isInputPreemptionAbortReason(context.abortSignal.reason) &&
        inputPreemption?.decide() === "wait"
      ) {
        return;
      }
      rejectOnce(
        createCoreError(
          CoreErrorType.ToolCancelled,
          entry.cancellation?.userVisibleMessage ?? "Tool execution cancelled",
          {
            context: {
              cancellation: entry.cancellation?.cleanup ?? "none",
              toolName: entry.metadata.name,
            },
            recoverable: true,
          },
        ),
      );
    };

    context.abortSignal.addEventListener("abort", abortHandler);

    handler(input, context)
      .then((result) => {
        resolveOnce(result);
      })
      .catch((error) => {
        rejectOnce(error);
      });
  });
}

/** 新建一次工具调用的输入抢占接管点；后注册的判断函数覆盖先注册的。 */
export function createInputPreemptionSlot(): InputPreemptionSlot {
  let registered: (() => InputPreemptionHandling) | undefined;
  return {
    register(decide) {
      registered = decide;
    },
    decide: () => registered?.() ?? "cancel",
  };
}

export function resolveTimeoutMs(
  entry: ToolEntry,
  input: unknown,
  defaultTimeoutMs: number,
  context?: ToolExecutionModelContext,
): number | undefined {
  const policy = entry.timeout;
  if (policy?.kind === "none") {
    return undefined;
  }

  const defaultMs = policy?.defaultMs ?? entry.metadata.timeoutMs ?? defaultTimeoutMs;
  const entryResolvedMs = entry.resolveTimeoutBudgetMs?.(input, context);
  const requestedMs =
    entryResolvedMs ??
    (policy?.allowCallOverride && isRecord(input) && typeof input.timeout_ms === "number"
      ? input.timeout_ms
      : policy?.allowCallOverride && isRecord(input) && typeof input.timeout === "number"
        ? input.timeout
        : defaultMs);
  const cappedMs = policy?.maxMs === undefined ? requestedMs : Math.min(requestedMs, policy.maxMs);
  const cleanupGraceMs = Math.max(0, Math.trunc(policy?.cleanupGraceMs ?? 0));
  return Math.max(1, Math.trunc(cappedMs)) + cleanupGraceMs;
}

export function linkAbortSignal(
  parentSignal: AbortSignal | undefined,
  childController: AbortController,
): () => void {
  if (!parentSignal) {
    return () => {};
  }

  const abortChild = () => {
    if (!childController.signal.aborted) {
      childController.abort(parentSignal.reason);
    }
  };

  if (parentSignal.aborted) {
    abortChild();
    return () => {};
  }

  parentSignal.addEventListener("abort", abortChild);
  return () => {
    parentSignal.removeEventListener("abort", abortChild);
  };
}

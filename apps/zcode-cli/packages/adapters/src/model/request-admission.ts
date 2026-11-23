import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";

/**
 * 一次尝试的准入。
 *
 * runner 在每次尝试**发出前** `admitAttempt`，拿到票据后才发请求；尝试结束（成功、失败、抛出、消费者
 * 提前放弃流）即 `release`——退避 sleep 期间不持票，所以进程级 cap 约束的是 provider 真正看到的在飞
 * 请求数。票据同时是该尝试的状态事件汇：`publishModelStatus` 把该尝试的事件也投递给它（见
 * `statusPublishOptions`），治理器据此判定结果；`release` 只是兜底，幂等。
 *
 * 请求没有 `modelRequestAdmission` 时返回一个空实现：调用点不必分叉，runner 行为逐字不变。
 */
export interface AttemptAdmission {
  /** 准入票据；请求没有准入端口时缺席（此时 publish 不转投）。 */
  readonly ticket?: ModelRequestAdmissionTicket;
  /** 归还槽位；幂等（finally 与「退避 sleep 之前」两处都会调）。 */
  release(): void;
}

const NO_ADMISSION: AttemptAdmission = { release() {} };

/**
 * 准入端口报告的重试冷却（ms）；端口不实现 `retryCooldownMs`（排队准入、无准入）或报出非正数、非有限值时为 0。
 * 只在重试的退避里读，首次请求不读：主代理（observer）的首次请求照常立刻发出。
 */
export function readAdmissionRetryCooldownMs(
  admission: ModelRequestAdmission | undefined,
  model: ModelRequestTarget,
): number {
  const value = admission?.retryCooldownMs?.({ model });
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 等待准入。先试同步快路径 `tryAcquire`；未命中才排队 `acquire`，并在两端回调 `onQueued` / `onAdmitted`
 * （runner 据此发 `model_request_queued` / `model_request_admitted`）。没有快路径的端口分不清
 * 「排了队」与「立即放行」，所以不回调。`signal` 被 abort 时 reject（以 `signal.reason`，与 `sleep` 的
 * abort 错误同一形状，由调用方按 cancelled 归类）。
 */
export async function admitAttempt(input: {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  onQueued?: () => Promise<void>;
  onAdmitted?: (queuedMs: number) => Promise<void>;
}): Promise<AttemptAdmission> {
  if (input.admission === undefined) return NO_ADMISSION;
  const hasFastPath = typeof input.admission.tryAcquire === "function";
  let ticket = hasFastPath ? input.admission.tryAcquire!({ model: input.model }) : undefined;
  if (ticket === undefined) {
    const queuedAt = Date.now();
    if (hasFastPath) await input.onQueued?.();
    ticket = await input.admission.acquire({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (hasFastPath) await input.onAdmitted?.(Date.now() - queuedAt);
  }
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}

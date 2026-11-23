import { ModelErrorCode, ModelFailureReason, ModelRetryReason } from "@zcode/contracts";
import type { Logger, ModelRequestAdmission, ModelStatusSink } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import type { AttemptAdmission } from "./request-admission.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  retryDelayWithAdmissionCooldown,
  sleep,
} from "./runner-retry.js";
import { publishModelStatus, type ModelStatusContext } from "./runner-status.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

export const EMPTY_COMPLETION_MAX_RETRIES = 1;
export const EMPTY_COMPLETION_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

export function createEmptyCompletionFailure(): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.InvalidModelResponse,
    message: EMPTY_COMPLETION_MESSAGE,
    reason: ModelFailureReason.Unknown,
    retryReason: ModelRetryReason.ServerError,
    retryable: true,
  };
}

export function canRetryEmptyCompletion(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  maxAttempts: number;
  retryCount: number;
}): boolean {
  return (
    !input.abortSignal?.aborted &&
    input.retryCount < EMPTY_COMPLETION_MAX_RETRIES &&
    input.attempt < input.maxAttempts
  );
}

export async function scheduleEmptyCompletionRetry(input: {
  abortSignal?: AbortSignal;
  /** 本次尝试的准入票据：退避之前归还（幂等，外层 finally 照旧兜底）。 */
  admission?: AttemptAdmission;
  attempt: number;
  completedAt: number;
  errorPhase: "response" | "stream";
  logger?: Logger;
  /** 请求的准入端口：读重试冷却（只有主代理的 observer 实现，其余端口读到 0）。 */
  modelRequestAdmission?: ModelRequestAdmission;
  requestHeaders: Record<string, string>;
  requestStatusSink?: ModelStatusSink;
  responseHeaders: Record<string, string>;
  retry: ResolvedAiSdkModelRetryOptions;
  retryBudgetAttempt: number;
  startedAt: number;
  statusContext: ModelStatusContext;
  statusSink?: ModelStatusSink;
  streamOutputCommitted?: boolean;
}): Promise<void> {
  const failure = createEmptyCompletionFailure();
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      durationMs: input.completedAt - input.startedAt,
      errorCode: failure.code,
      errorPhase: input.errorPhase,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryable: true,
      ...(input.streamOutputCommitted !== undefined
        ? { streamOutputCommitted: input.streamOutputCommitted }
        : {}),
      timestamp: new Date(input.completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );

  // 与其他普通重试同一条规则：等待取 max(本地退避, 准入端口的剩余冷却)，冷却拉长等待时加正向抖动。
  // 只有主代理的 observer 报冷却；子 agent / workflow 的端口读到 0，等待仍是本地退避。
  const { admissionCooldownMs, backoffMs, delayMs } = retryDelayWithAdmissionCooldown({
    admission: input.modelRequestAdmission,
    backoffMs: calculateRetryDelay(input.retry, input.retryBudgetAttempt),
    jitter: input.retry.jitter,
    statusContext: input.statusContext,
  });
  logRetryDelayDecision({
    admissionCooldownMs,
    attempt: input.attempt,
    backoffMs,
    canRetry: true,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders: input.responseHeaders,
    statusContext: input.statusContext,
  });
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      delayMs,
      errorCode: failure.code,
      message: failure.message,
      nextAttempt: input.attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );
  // 退避期间不持票（与其他重试一致），槽位让给别人，重试再准入。
  //
  // 两条状态事件**不**转投票据：治理器对这次尝试的信号保持原样，仍是 release 即 `ended`（空响应不是并发
  // 信号）。转投的话 `retry_scheduled{server_error}` 会变成 `failedTransient`、清掉成功 streak，
  // 改变 workflow cap 的增长；这里只把归还挪到 sleep 之前。
  input.admission?.release();
  await sleep(delayMs, input.abortSignal);
}

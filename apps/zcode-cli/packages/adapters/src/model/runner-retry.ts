import {
  ModelErrorCode,
  ModelFailureReason,
  type Logger,
  type ModelRequestAdmission,
} from "@zcode/contracts";
import { isProviderBusinessError } from "./model-execution.js";
import { findProviderBusinessError, type ClassifiedModelFailure } from "./failure-classifier.js";
import { readMappedAiSdkProviderBusinessError } from "./failure-ai-sdk-provider-error.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { readAdmissionRetryCooldownMs } from "./request-admission.js";
import {
  AiSdkModelAdapterError,
  ModelErrorSource,
  type ModelErrorSource as ModelErrorSourceType,
} from "./errors.js";
import { retryWaitJitterSpreadMs, type ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";
import { modelFailureAttributionFields } from "./runner-telemetry.js";

const MAX_REASONABLE_RETRY_AFTER_MS = 5 * 60_000;
const RELIABLE_ATTRIBUTION_CONTEXT_KEYS = [
  "errorPhase",
  "exceptionKind",
  "providerCode",
  "providerRequestId",
  "reason",
  "responseBodySummary",
  "responseStatus",
  "retryable",
  "source",
  "statusCode",
] as const;

export class TerminalStreamChunkError extends Error {
  constructor(readonly adapterError: AiSdkModelAdapterError) {
    super(adapterError.message);
    this.name = "TerminalStreamChunkError";
    // 流终止包装器只复制 message，丢失底层网络原因；公开 cause 但不改文案与重试策略。
    this.cause = adapterError.cause ?? adapterError;
  }
}

export function calculateRetryDelay(
  retry: ResolvedAiSdkModelRetryOptions,
  attempt: number,
  retryAfterMs?: number,
): number {
  const uncapped = retry.baseDelayMs * retry.backoffFactor ** Math.max(0, attempt - 1);
  const capped = Math.min(uncapped, retry.maxDelayMs);
  // provider 会返回几十秒到数分钟的 retry-after；
  // 旧 60s 上限会把合法限流等待退化为本地短退避。
  if (isReasonableRetryAfterMs(retryAfterMs, uncapped)) {
    // 同一时刻被限流的一批请求拿到同一个 retry-after：不加抖动会在同一毫秒一起醒来、再一起撞上
    // 限流（2026-10 线上 1302 风暴）。抖动只往后加，绝不早于 provider 要求的时间。
    // 抖动档（最多 20%、不超过 5 秒）见 retryWaitJitterSpreadMs。
    if (!retry.jitter) return retryAfterMs;
    return retryAfterMs + Math.round(Math.random() * retryWaitJitterSpreadMs(retryAfterMs));
  }

  if (!retry.jitter || capped === 0) {
    return capped;
  }

  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/**
 * 重试等待取 `max(本地退避, 准入端口报告的剩余冷却)`；冷却部分封顶 {@link MAX_REASONABLE_RETRY_AFTER_MS}，
 * 本地退避本身不受影响（冷却只会让等待变长，不会变短）。
 *
 * 主代理是 observer：首次请求不排队、不看冷却（用户自己的对话不排在 workflow 后面），但重试若在冷却期里
 * 照常按 2s、4s… 发出，几乎一定还是 1302，白白消耗重试次数（2026-11 线上：3.17.x 里「10 次重试用完」
 * 的段 94% 来自主循环）。冷却来自同一 provider/model 桶里别的请求（其他会话、subagent、workflow、工具侧请求）
 * 收到的 Retry-After，或者它们在缺 Retry-After 时自己算出的退避（docs/dynamic-workflow/concurrency.md
 * 「Cooldown and idle reset」）。
 */
export function applyAdmissionRetryCooldown(backoffMs: number, cooldownMs: number): number {
  if (!(cooldownMs > 0)) return backoffMs;
  return Math.max(backoffMs, Math.min(cooldownMs, MAX_REASONABLE_RETRY_AFTER_MS));
}

/**
 * 普通重试（非 off-peak 排队）的最终等待：本地退避叠加准入端口的剩余冷却。三处重试点（generate、stream
 * 外层、stream 内 SSE error chunk）共用；冷却按本次请求的模型身份（与准入同一个 key）读。
 *
 * 冷却拉长了等待时（`retry.jitter` 开启）再往后加一段正向抖动，档位与 Retry-After 相同
 * （{@link retryWaitJitterSpreadMs}）：跟着同一个冷却等的请求（多个主会话、主代理的 sidecar）
 * 否则会在同一毫秒醒来、再一起撞上限流。抖动只往后加，绝不早于冷却；总等待仍不超过 5 分钟。
 * 冷却没有拉长等待时，等待就是本地退避本身（它已有自己的抖动），不再叠加。
 */
export function retryDelayWithAdmissionCooldown(input: {
  admission?: ModelRequestAdmission;
  backoffMs: number;
  jitter: boolean;
  statusContext: Pick<ModelStatusContext, "modelId" | "providerId">;
}): { admissionCooldownMs: number; backoffMs: number; delayMs: number } {
  const admissionCooldownMs = readAdmissionRetryCooldownMs(input.admission, {
    providerId: String(input.statusContext.providerId),
    modelId: String(input.statusContext.modelId),
  });
  const waitMs = applyAdmissionRetryCooldown(input.backoffMs, admissionCooldownMs);
  const delayMs =
    input.jitter && waitMs > input.backoffMs
      ? Math.min(
          waitMs + Math.round(Math.random() * retryWaitJitterSpreadMs(waitMs)),
          MAX_REASONABLE_RETRY_AFTER_MS,
        )
      : waitMs;
  return { admissionCooldownMs, backoffMs: input.backoffMs, delayMs };
}

export async function sleep(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (abortSignal?.aborted) {
      throw createAbortError(abortSignal);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(createAbortError(abortSignal));
      return;
    }

    const timeout = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError(abortSignal));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function logRetryDelayDecision(input: {
  /** 准入端口报告的剩余冷却（只有 observer 会报）；为 0 或缺席时不记。 */
  admissionCooldownMs?: number;
  attempt: number;
  /** 未叠加冷却前的本地退避；只在叠加了冷却时记，便于区分「退避」与「等冷却」。 */
  backoffMs?: number;
  canRetry: boolean;
  delayMs?: number;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  responseHeaders: Record<string, string>;
  statusContext: ModelStatusContext;
}): void {
  // retry-after 可能在 header 保留、错误归一化或 delay 计算任一层断链；
  // 这里集中记录安全 header 摘要和最终等待时间，方便复现后直接定位。
  const cooldownApplied = input.admissionCooldownMs !== undefined && input.admissionCooldownMs > 0;
  input.logger?.warn("Model retry delay decision inspected", {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    ...(cooldownApplied
      ? { admissionCooldownMs: input.admissionCooldownMs, backoffMs: input.backoffMs }
      : {}),
    canRetry: input.canRetry,
    delayMs: input.delayMs,
    event: "model.retry.delay.resolved",
    nextAttempt: input.canRetry ? input.attempt + 1 : undefined,
    reason: input.failure.reason,
    retryAfterHeader: readHeader(input.responseHeaders, "retry-after"),
    retryAfterMs: input.failure.retryAfterMs,
    retryAfterMsHeader: readHeader(input.responseHeaders, "retry-after-ms"),
    retryAfterSource: retryAfterSource(input.failure.retryAfterMs, input.responseHeaders),
    retryReason: input.failure.retryReason,
    status: input.canRetry ? "waiting" : "failed",
    statusCode: input.failure.statusCode,
    xShouldRetryHeader: readHeader(input.responseHeaders, "x-should-retry"),
  });
}

export function toAdapterError(
  error: unknown,
  failure: ClassifiedModelFailure,
  statusContext: ModelStatusContext,
  attempt: number,
  additionalContext?: Record<string, unknown>,
): AiSdkModelAdapterError {
  const unwrapped = unwrapRetryError(error);
  const providerBusinessError =
    findProviderBusinessError(unwrapped) ?? readMappedAiSdkProviderBusinessError(unwrapped);
  const normalizedContext = {
    attempt,
    maxAttempts: statusContext.maxAttempts,
    modelId: statusContext.modelId,
    ...modelFailureAttributionFields(unwrapped, failure, additionalContext?.errorPhase),
    ...providerBusinessErrorContext(providerBusinessError),
    providerId: statusContext.providerId,
    // 错误离开 adapter 后无法再反推出实际协议与传输方式；在归一化边界保留安全事实。
    providerKind: statusContext.providerKind,
    reason: failure.reason,
    requestId: statusContext.requestId,
    retryable: failure.retryable,
    // Retry-After 只活在分类结果里，离开 adapter 就丢了；workflow 的配额停止通知
    // 要靠它算 resetAt，所以随归一化上下文带出去。
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    source: modelFailureSource(providerBusinessError ?? error, failure, additionalContext),
    statusCode: failure.statusCode,
    traceId: statusContext.traceId,
    transport: statusContext.transport,
  };

  if (error instanceof AiSdkModelAdapterError) {
    // 已有 adapter error 的因果归因可能来自更接近失败现场的可靠证据；
    // 重新包装并用 runner 的粗粒度分类覆盖它，会改变归因和错误 identity。这里只补齐缺失归因和当前请求事实。
    return error.enrichContext({
      ...error.context,
      ...normalizedContext,
      ...additionalContext,
      ...existingReliableAttributionContext(error.context),
    });
  }

  return new AiSdkModelAdapterError(failure.code, failure.message, {
    cause: error,
    context: {
      ...normalizedContext,
      ...additionalContext,
    },
  });
}

function existingReliableAttributionContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!context) return {};

  return Object.fromEntries(
    RELIABLE_ATTRIBUTION_CONTEXT_KEYS.flatMap((key) =>
      context[key] === undefined ? [] : [[key, context[key]]],
    ),
  );
}

function modelFailureSource(
  error: unknown,
  failure: ClassifiedModelFailure,
  additionalContext?: Record<string, unknown>,
): ModelErrorSourceType {
  const reason = failure.reason;
  if (reason === ModelFailureReason.Cancelled) return ModelErrorSource.Runtime;
  if (
    reason === ModelFailureReason.NetworkError ||
    reason === ModelFailureReason.ProxyError ||
    reason === ModelFailureReason.StaleConnection ||
    reason === ModelFailureReason.StreamIdleTimeout ||
    reason === ModelFailureReason.Timeout ||
    reason === ModelFailureReason.TlsError
  ) {
    return ModelErrorSource.Network;
  }

  if (failure.statusCode !== undefined || isProviderBusinessError(error)) {
    return ModelErrorSource.Provider;
  }

  if (failure.code === ModelErrorCode.InvalidModelResponse) {
    return ModelErrorSource.Provider;
  }

  // SSE 已创建并进入 response body 后，即使 provider 没有返回 status/code，
  // 也已经有明确的上游边界事实；仅按 status/provider error 判断会误把这类未知失败归为 runtime。
  if (
    additionalContext?.streamFailurePhase === "response_body" ||
    additionalContext?.errorPhase === "response" ||
    additionalContext?.errorPhase === "stream" ||
    additionalContext?.errorPhase === "parse"
  ) {
    return ModelErrorSource.Provider;
  }

  // invalid_request/unknown 同时覆盖请求前的本地配置校验和 provider 响应失败；
  // 只按 reason 归因会把尚未发出网络请求的错误也记到 provider。缺少上游证据时归 runtime。
  if (
    reason === ModelFailureReason.InvalidRequest ||
    reason === ModelFailureReason.ProviderNotConfigured ||
    reason === ModelFailureReason.Unknown
  ) {
    return ModelErrorSource.Runtime;
  }

  return ModelErrorSource.Provider;
}

function isReasonableRetryAfterMs(
  value: number | undefined,
  exponentialDelayMs: number,
): value is number {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    (value <= MAX_REASONABLE_RETRY_AFTER_MS || value < exponentialDelayMs)
  );
}

function retryAfterSource(
  retryAfterMs: number | undefined,
  headers: Record<string, string>,
): string {
  const xShouldRetry = readHeader(headers, "x-should-retry")?.trim().toLowerCase();
  if (xShouldRetry === "false" || xShouldRetry === "0") {
    return "blocked_by_x_should_retry";
  }
  if (retryAfterMs !== undefined) {
    return "provider_header";
  }
  if (readHeader(headers, "retry-after-ms") !== undefined || readHeader(headers, "retry-after")) {
    return "header_unparsed_or_ignored";
  }
  return "missing";
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function createAbortError(abortSignal?: AbortSignal): Error {
  const reason = abortSignal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("The model request was cancelled.");
  error.name = "AbortError";
  return error;
}

function providerBusinessErrorContext(error: unknown): Record<string, unknown> | undefined {
  if (!isProviderBusinessError(error)) {
    return undefined;
  }

  return {
    providerCode: error.providerCode,
    providerRequestId: error.providerRequestId,
    responseBodySummary: error.responseBodySummary,
    responseStatus: error.responseStatus,
  };
}

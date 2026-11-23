import {
  ZCODE_PROVIDER_CONFIG_NETWORK_ERROR,
  ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR,
  type RequestVerificationReason,
} from "@zcode/shared";
import type { ModelRequestAuth } from "@zcode/contracts";
import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export class RuntimeHeadersRefreshError extends Error {
  readonly retryable: boolean;
  /** 请求校验配置读取失败有专属重试文案；项目 Token 传输失败按普通网络错误展示。 */
  readonly configNetwork: boolean;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RuntimeHeadersRefreshError";
    // 只信任 Host 的结构化分类；旧文案也可能来自无效配置，不能按文本扩大重试。
    const code =
      typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
    this.configNetwork = code === ZCODE_PROVIDER_CONFIG_NETWORK_ERROR;
    // Bug 原因（ZCT-2122890271808978944 等）：项目 Token 断网/超时原先没有结构化码，
    // 冷缓存换证失败直接结束整轮。Host 现以 -32033 标出这两类传输故障，并入同一 network_error 预算。
    this.retryable = this.configNetwork || code === ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR;
  }
}

export async function resolveModelForAttempt(input: {
  attempt: number;
  reason?: RequestVerificationReason;
  request: AiSdkModelTextRequest;
  resolveModel: (requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel;
}): Promise<ResolvedAiSdkModel> {
  const signal = input.request.abortSignal;
  signal?.throwIfAborted();
  const boundModel = input.resolveModel();
  if (!input.request.refreshRuntimeHeadersBeforeAttempt) return boundModel;
  try {
    const refreshResult = await waitForHeaders(
      () =>
        input.request.refreshRuntimeHeadersBeforeAttempt!({
          attempt: input.attempt,
          reason: input.reason ?? "model-request",
          abortSignal: signal,
          providerId: String(boundModel.providerId),
          modelId: String(boundModel.modelId),
          traceContext: input.request.traceContext,
        }),
      signal,
    );
    signal?.throwIfAborted();
    if (!refreshResult.headersApplied || !refreshResult.requestAuth) {
      throw new Error("Provider request auth was not returned before model request attempt.");
    }
    // 当前绑定负责将完整鉴权材料投影到私有请求，不写共享 Registry，也不重新选择模型。
    return input.resolveModel(refreshResult.requestAuth);
  } catch (error) {
    if (signal?.aborted) throw error;
    // 执行作用域凭据缺失已有稳定错误码；不能被 headers 等待的通用包装吞掉。
    if (
      error instanceof ModelProtocolError &&
      error.code === ModelErrorCode.ModelRequestAuthMissing
    )
      throw error;
    throw new RuntimeHeadersRefreshError(error);
  }
}

async function waitForHeaders<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

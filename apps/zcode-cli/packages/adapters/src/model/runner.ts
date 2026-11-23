import type { ModelRequestSecurityState } from "./request-security.js";
// ============================================================
// Vercel AI SDK model runner
// ============================================================

import {
  ModelErrorCode,
  ModelProtocolError,
  getCurrentModelInvocationContext,
} from "@zcode/contracts";
import type {
  Logger,
  Model,
  ModelOptions,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelRequestAuthSourceInput,
  ModelStatusSink,
  ModelStreamEvent,
  ModelTextResult,
} from "@zcode/contracts";
import type { RegistryModelConfig, RegistryProviderConfig } from "@zcode/provider";
import {
  AiSdkModelExecution,
  type AiSdkResolvedModel,
  type AiSdkNetworkConfig,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "./model-execution.js";
import {
  resolveAiSdkModelRetryOptions,
  type AiSdkModelRetryOptions,
  type ResolvedAiSdkModelRetryOptions,
} from "./retry-policy.js";
import { resolveRetryOptionsForBudget } from "./retry-budget.js";
import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle-timeout.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import {
  normalizeOpenAiReasoningHistory,
  normalizeReasoningHistory,
} from "./reasoning-history-normalization.js";
import {
  defaultRuntime,
  type AiSdkModelRuntime,
  type AiSdkModelTextRequest,
  type ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { resolveModelRequestCapabilities } from "./tool-search.js";
import { createModel, type ModelExecutionRequest } from "./model.js";
import { refreshOffPeakRequestAuth } from "./off-peak-request-auth.js";

export type { AiSdkModelRetryOptions } from "./retry-policy.js";
export type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
} from "./runner-runtime.js";
export { normalizeUsage, toModelStreamEvent } from "./runner-normalization.js";

export interface AiSdkModelAdapterOptions {
  /** 注入请求观测或测试传输，仍经过现有代理、协议及参数映射链。 */
  transport?: typeof globalThis.fetch;
  observeTransport?: (transport: typeof globalThis.fetch) => typeof globalThis.fetch;
  defaultHeaders?: AiSdkModelExecutionConfig["defaultHeaders"];
  requestSecurityState?: ModelRequestSecurityState;
  endpointRoutingPort?: import("@zcode/contracts").ProviderEndpointRoutingPort;
  network?: AiSdkNetworkConfig;
  runtime?: AiSdkModelRuntime;
  env?: EnvRecord;
  debugDir?: string;
  logger?: Logger;
  retry?: AiSdkModelRetryOptions;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs?: number;
  modelIoFullRetentionEnabled?: boolean;
}

export interface CreateAiSdkModelOptions {
  providerId: string;
  modelId: string;
  providerConfig: RegistryProviderConfig;
  modelConfig: RegistryModelConfig;
  displayName?: string;
  options?: ModelOptions;
  requestDependencies?: ModelRequestDependencies;
}

export class AiSdkModelAdapter {
  private readonly execution: AiSdkModelExecution;
  private readonly runtime: AiSdkModelRuntime;
  private readonly env: EnvRecord;
  private readonly debugDir?: string;
  private readonly logger?: Logger;
  private readonly retry: ResolvedAiSdkModelRetryOptions;
  private statusSink?: ModelStatusSink;
  private readonly streamIdleTimeoutMs: number;
  private modelIoFullRetentionEnabled: boolean;

  constructor(options: AiSdkModelAdapterOptions) {
    this.execution = new AiSdkModelExecution(
      {
        defaultHeaders: options.defaultHeaders,
        ...(options.endpointRoutingPort
          ? { endpointRoutingPort: options.endpointRoutingPort }
          : {}),
        ...(options.network ? { network: options.network } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      {
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.observeTransport ? { observeTransport: options.observeTransport } : {}),
        ...(options.requestSecurityState
          ? { requestSecurityState: options.requestSecurityState }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    this.runtime = options.runtime ?? defaultRuntime;
    this.env = options.env ?? process.env;
    this.debugDir = options.debugDir;
    this.logger = options.logger;
    this.retry = resolveAiSdkModelRetryOptions(options.retry, this.env);
    this.statusSink = options.statusSink;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
    this.modelIoFullRetentionEnabled = options.modelIoFullRetentionEnabled ?? false;
  }

  setModelIoFullRetentionEnabled(enabled: boolean): void {
    this.modelIoFullRetentionEnabled = enabled;
  }

  addStatusSink(sink: ModelStatusSink): void {
    const current = this.statusSink;
    if (!current || current === sink) {
      this.statusSink = sink;
      return;
    }
    this.statusSink = {
      async publish(event) {
        // 多个 sink 必须独立执行：任一 sink 失败不得连带影响其他 sink，
        // 也不能阻塞原有调用链。
        const results = await Promise.allSettled([
          Promise.resolve().then(() => current.publish(event)),
          Promise.resolve().then(() => sink.publish(event)),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      },
    };
  }

  createModel(options: CreateAiSdkModelOptions): Model {
    const boundResolution = this.execution.bindModel({
      providerId: options.providerId,
      modelId: options.modelId,
      providerConfig: options.providerConfig,
      supportsJsonSchemaOutput: options.modelConfig.properties.supportsJsonSchemaOutput,
      optionSpecs: options.modelConfig.optionSpecs,
    });
    const properties = options.modelConfig.properties;
    const resolved = {
      ...boundResolution.resolved,
      properties,
      ...(options.providerConfig.access.type === "zhipu-account"
        ? { accountAccess: options.providerConfig.access }
        : {}),
    };
    const optionSpecs = options.modelConfig.optionSpecs;
    const toLegacyRequest = (request: ModelExecutionRequest): AiSdkModelTextRequest => {
      const context = getCurrentModelInvocationContext();
      const {
        refreshRuntimeHeadersBeforeAttempt: contextRefreshRuntimeHeadersBeforeAttempt,
        ...invocationContext
      } = context ?? {};
      const shouldAttachReasoningTelemetry = request.options.reasoningLevel !== undefined;
      const selectedReasoningLevel = request.options.reasoningLevel;
      const requestAuthDependency = options.requestDependencies?.requestAuth;
      // Bug 根因：加速卡（highspeed）与 Off-Peak 同为 Coding Plan 派生模式，本轮动态鉴权
      // （zcode JWT + Coding Plan 双 JWT + X-Highspeed-Card-ID，见 docs/highspeed/highspeed-card-spec.md
      // §2.2）经 modelExecution.requestAuth 下发到执行作用域 Source。若门禁只认 off-peak，highspeed
      // 会落到下面的账号 runtime-header 刷新分支，把整包 requestAuth（含卡 ID）丢弃，加速请求因缺卡 ID/
      // 错误鉴权被 /api/v1/highspeed 网关判 401。两种派生免签模式必须同样消费执行作用域 Source。
      const requestAuthRequired =
        options.providerConfig.access.type === "zhipu-account" &&
        (options.providerConfig.access.mode === "off-peak" ||
          options.providerConfig.access.mode === "highspeed");
      // 调用级 runtime header Port 只服务绑定完整 Account Access 的账号型 Model；
      // 普通 API-key Model 若也消费该 Port，会把静态鉴权误送到 Host 刷新并在请求前失败。
      // 派生模式保留执行作用域票据/卡身份；Off-Peak 的 PAT 仍逐请求向原账号 owner 刷新。
      const refreshRuntimeHeadersBeforeAttempt = requestAuthRequired
        ? async (input: ModelRequestAuthSourceInput) => {
            const requestAuth = await requestAuthDependency?.source?.resolve(input);
            if (!hasRequestAuth(requestAuth)) {
              throw new ModelProtocolError(
                ModelErrorCode.ModelRequestAuthMissing,
                `Model request auth is unavailable: ${resolved.providerId}/${resolved.modelId}`,
              );
            }
            const refreshedAuth =
              options.providerConfig.access.type === "zhipu-account" &&
              options.providerConfig.access.mode === "off-peak"
                ? await refreshOffPeakRequestAuth({
                    auth: requestAuth,
                    input,
                    accountAccess: options.providerConfig.access,
                    refresh: contextRefreshRuntimeHeadersBeforeAttempt,
                  })
                : requestAuth;
            return { headersApplied: true, requestAuth: refreshedAuth };
          }
        : options.providerConfig.access.type === "zhipu-account"
          ? (contextRefreshRuntimeHeadersBeforeAttempt ??
            (async () => {
              throw new ModelProtocolError(
                ModelErrorCode.ModelRequestAuthMissing,
                `Account model request auth is unavailable: ${resolved.providerId}/${resolved.modelId}`,
              );
            }))
          : undefined;
      return {
        toolSearchEnabled: request.toolSearchEnabled,
        messages: request.messages,
        tools: request.tools,
        responseJsonSchema: request.responseJsonSchema,
        abortSignal: request.abortSignal,
        maxOutputTokens: request.options.maxOutputTokens,
        ...invocationContext,
        ...(shouldAttachReasoningTelemetry
          ? {
              modelCall: {
                ...invocationContext.modelCall,
                reasoning: {
                  ...invocationContext.modelCall?.reasoning,
                  // 过去按 none/off 等档位名称猜测 enabled/disabled，导致 Telemetry
                  // 把 Provider 方言当成统一语义。这里只记录请求实际选择的公开档位。
                  ...(selectedReasoningLevel ? { requestedLevel: selectedReasoningLevel } : {}),
                },
              },
            }
          : {}),
        ...(refreshRuntimeHeadersBeforeAttempt
          ? {
              refreshRuntimeHeadersBeforeAttempt: (input) =>
                refreshRuntimeHeadersBeforeAttempt({
                  ...input,
                  ...(options.providerConfig.access.type === "zhipu-account"
                    ? { accountAccess: options.providerConfig.access }
                    : {}),
                }),
            }
          : {}),
      };
    };
    const resolveForRequest = (
      request: AiSdkModelTextRequest,
      optionValues: Required<ModelOptions>,
    ): ((requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel) => {
      const maxOutputTokens = requireMaxOutputTokens(optionValues);
      return request.refreshRuntimeHeadersBeforeAttempt
        ? (requestAuth) => ({
            ...assertSameBoundModel(
              resolved,
              boundResolution.resolveRequest({
                options: {
                  maxOutputTokens,
                  reasoningLevel: optionValues.reasoningLevel,
                },
                requestAuth,
              }),
            ),
            properties,
            ...(options.providerConfig.access.type === "zhipu-account"
              ? { accountAccess: options.providerConfig.access }
              : {}),
          })
        : () => ({
            ...boundResolution.resolveRequest({
              options: {
                maxOutputTokens,
                reasoningLevel: optionValues.reasoningLevel,
              },
            }),
            properties,
            ...(options.providerConfig.access.type === "zhipu-account"
              ? { accountAccess: options.providerConfig.access }
              : {}),
          });
    };
    return createModel({
      requestCapabilities: resolveModelRequestCapabilities(
        options.providerConfig.api.type,
        options.providerConfig.access,
      ),
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      displayName: options.displayName,
      properties,
      optionSpecs: {
        maxOutputTokens: optionSpecs.maxOutputTokens,
        reasoningLevel: optionSpecs.reasoningLevel,
      },
      options: options.options,
      executor: {
        generateText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.generateTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
        streamText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.streamTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
      },
    });
  }

  private generateTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): Promise<ModelTextResult> {
    const projectedRequest = projectRequestHistory(request, resolved);
    return runGenerateText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }

  private async *streamTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): AsyncGenerator<ModelStreamEvent> {
    const projectedRequest = projectRequestHistory(request, resolved);
    yield* runStreamText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      // single-attempt 预算（带 selectionFallback 的执行作用域句柄）把 maxAttempts 收敛为 1。
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }
}

function requireMaxOutputTokens(options: ModelOptions): number {
  if (options.maxOutputTokens === undefined) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "maxOutputTokens requires an explicit request value",
    );
  }
  return options.maxOutputTokens;
}

function hasRequestAuth(
  requestAuth: ModelRequestAuth | undefined,
): requestAuth is ModelRequestAuth {
  if (requestAuth?.apiKey?.trim()) return true;
  return Object.values(requestAuth?.headers ?? {}).some((value) => value.trim().length > 0);
}

function assertSameBoundModel(
  bound: ResolvedAiSdkModel,
  refreshed: AiSdkResolvedModel,
): AiSdkResolvedModel {
  if (bound.providerId !== refreshed.providerId || bound.modelId !== refreshed.modelId) {
    throw new Error("Runtime header refresh changed the bound model identity.");
  }
  return refreshed;
}

function projectRequestHistory(
  request: AiSdkModelTextRequest,
  resolved: ResolvedAiSdkModel,
): AiSdkModelTextRequest {
  const targetModel = { providerId: resolved.providerId, modelId: resolved.modelId };
  if (resolved.providerKind === "openai") {
    const messages = normalizeOpenAiReasoningHistory(request.messages, targetModel);
    return messages === request.messages ? request : { ...request, messages };
  }
  if (resolved.providerKind !== "anthropic") return request;

  // 结构归一化过去位于每次物理请求都会经过的 serializer，签名修复重试
  // 因而会再次删除上一轮刚补出的 assistant 占位并合并 user。逻辑请求入口只投影一次，
  // 后续 attempt 只能复用或从这份 request-local history 派生。
  const messages = normalizeReasoningHistory(request.messages, targetModel);
  return messages === request.messages ? request : { ...request, messages };
}

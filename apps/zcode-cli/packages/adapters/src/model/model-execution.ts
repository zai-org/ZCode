import { withoutRequestVerificationHeaders } from "@zcode/shared";
/* eslint-disable max-lines -- AI SDK 模型执行装配集中维护 provider factory、鉴权和网络错误适配，拆分会让状态同步更脆弱。 */
// ============================================================
// Vercel AI SDK model execution
// ============================================================

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  compileModelOptionMaps,
  type CompiledModelOptionMaps,
  type ModelOptionValues,
} from "@zcode/model-option-map";
import {
  type Logger,
  type ModelId,
  type ModelProviderId,
  type ModelRequestAuth,
  type ProviderEndpointRoutingPort,
} from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import { withOpenRouterAttributionHeaders } from "@zcode/shared";
import { createAnthropicCompatFetch } from "./anthropic-stream-compat.js";
import { createModelRequestSecurityState } from "./request-security-edition/index.js";
import type { ModelRequestSecurityState, ModelRequestSecurityPort } from "./request-security.js";
import { createOpenAIResponsesJsonCompatFetch } from "./openai-responses-json-compat.js";
import { createModelOptionMapFetch, type RawRequestBodyCapture } from "./model-option-map-fetch.js";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { createProviderEndpointRoutingFetch } from "./provider-endpoint-routing-fetch.js";
import { normalizeModelTlsFailure } from "./failure-tls.js";
import {
  mergeModelRequestHeaders,
  withoutModelAuthHeaders,
  withoutContextOwnedModelHeaders,
} from "./model-request-headers.js";

export type AiSdkProviderKind = "openai" | "anthropic" | "openai-compatible";

const OPENAI_ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

export type EnvRecord = Record<string, string | undefined>;

interface AiSdkProviderConfig {
  access: RegistryProviderConfig["access"];
  kind: AiSdkProviderKind;
  apiKey?: string;
  baseURL: string;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  name?: string;
}

export interface AiSdkModelExecutionConfig {
  /** 执行环境提供的默认来源信息，不属于 Provider 持久化配置。 */
  defaultHeaders?: Readonly<Record<string, string>>;
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  env?: EnvRecord;
  network?: AiSdkNetworkConfig;
}

export interface AiSdkModelExecutionOptions {
  requestSecurityState?: ModelRequestSecurityState;
  logger?: Logger;
  transport?: ProviderFetch;
  /** 在代理和 CA 解析之后旁路观测，不替换产品网络策略。 */
  observeTransport?: (transport: ProviderFetch) => ProviderFetch;
}

export interface AiSdkNetworkConfig {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
}

export interface AiSdkResolvedModel {
  baseURL?: string;
  headers?: Record<string, string>;
  providerId: ModelProviderId;
  modelId: ModelId;
  model: LanguageModel;
  providerKind: AiSdkProviderKind;
  providerOptions?: Record<string, unknown>;
  rawRequestBodyCapture?: RawRequestBodyCapture;
  requestObservations?: ModelRequestSecurityPort;
  /** 每次 resolveRequest 独立持有，不能跨并发请求或重试共享。 */
  streamTiming?: { firstContentAt?: number };
}

export interface AiSdkBoundModelResolution {
  readonly resolved: AiSdkResolvedModel;
  resolveRequest(input: {
    readonly options: ModelOptionValues;
    readonly requestAuth?: ModelRequestAuth;
  }): AiSdkResolvedModel;
}

type LanguageModelFactory = (modelId: string) => LanguageModel;
type ProviderFetch = typeof globalThis.fetch;
type ProviderCode = string | number;

export interface ProviderBusinessErrorFetchOptions {
  caCertFile?: string;
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  env?: EnvRecord;
  providerId: string;
  providerKind: AiSdkProviderKind;
  streamTiming?: { firstContentAt?: number };
  fetch?: ProviderFetch;
  httpProxy?: string;
  noProxy?: string;
}

export interface ProviderBusinessErrorOptions {
  providerCode?: ProviderCode;
  providerId: string;
  providerKind: AiSdkProviderKind;
  providerMessage?: string;
  providerRequestId?: string;
  responseBodySummary?: Record<string, unknown>;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  statusCode?: number;
}

export class ProviderBusinessError extends Error {
  readonly code = "PROVIDER_BUSINESS_ERROR";
  readonly isProviderBusinessError = true;
  readonly providerCode?: ProviderCode;
  readonly providerId: string;
  readonly providerKind: AiSdkProviderKind;
  readonly providerMessage?: string;
  readonly providerRequestId?: string;
  readonly responseBodySummary?: Record<string, unknown>;
  readonly responseHeaders?: Record<string, string>;
  readonly responseStatus?: number;
  readonly statusCode?: number;

  constructor(options: ProviderBusinessErrorOptions) {
    const providerMessage =
      normalizeProviderMessage(options.providerMessage) ?? "Provider returned a business error.";
    super(providerMessage);
    this.name = "ProviderBusinessError";
    this.providerCode = options.providerCode;
    this.providerId = options.providerId;
    this.providerKind = options.providerKind;
    this.providerMessage = providerMessage;
    this.providerRequestId = options.providerRequestId;
    this.responseBodySummary = options.responseBodySummary;
    this.responseHeaders = options.responseHeaders;
    this.responseStatus = options.responseStatus;
    this.statusCode = options.statusCode;
  }
}

export function isProviderBusinessError(error: unknown): error is ProviderBusinessError {
  if (error instanceof ProviderBusinessError) {
    return true;
  }

  const record = asRecord(error);
  return record?.isProviderBusinessError === true && record.name === "ProviderBusinessError";
}

const MAX_BUSINESS_ERROR_BODY_CHARS = 64_000;
const MAX_PROVIDER_MESSAGE_CHARS = 1_000;
const PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS = 1_000;
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";
const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;
const AUTHORIZATION_HEADER_NAME = "Authorization";

export class AiSdkModelExecution {
  private readonly env: EnvRecord;
  private readonly defaultHeaders: Record<string, string>;
  private readonly network: AiSdkNetworkConfig;
  private readonly endpointRoutingPort?: ProviderEndpointRoutingPort;
  private readonly logger?: Logger;
  private readonly baseTransport?: ProviderFetch;
  private readonly observeTransport?: AiSdkModelExecutionOptions["observeTransport"];
  private readonly providerTransports = new Map<string, ProviderFetch>();
  private readonly requestSecurity: ModelRequestSecurityPort;

  constructor(config: AiSdkModelExecutionConfig = {}, options: AiSdkModelExecutionOptions = {}) {
    this.env = config.env ?? process.env;
    this.defaultHeaders = { ...config.defaultHeaders };
    this.network = { ...config.network };
    this.endpointRoutingPort = config.endpointRoutingPort;
    this.logger = options.logger;
    this.baseTransport = options.transport;
    this.observeTransport = options.observeTransport;
    this.requestSecurity = (
      options.requestSecurityState ?? createModelRequestSecurityState()
    ).createExecution({ logger: options.logger });
  }

  /**
   * 固定一个 Model 创建时使用的 Provider 静态事实。
   *
   * 请求期鉴权只覆盖 API Key 与 Header；Registry 后续热更新不会让已经创建的
   * Model 静默切换 Endpoint、协议、Provider Options 或 SDK Factory。
   */
  bindModel(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly supportsJsonSchemaOutput: boolean;
    readonly optionSpecs: {
      readonly reasoningLevel: { readonly map: string };
      readonly maxOutputTokens: { readonly map: string };
    };
  }): AiSdkBoundModelResolution {
    const snapshot = this.captureModelSnapshot(input);
    const optionMaps = compileModelOptionMaps(input.optionSpecs);
    return {
      // 这里只构造不执行请求的基础 Model；真正请求必须通过 resolveRequest 绑定完整 options。
      resolved: this.resolveSnapshot(snapshot, undefined, undefined, undefined),
      resolveRequest: ({ options, requestAuth }) =>
        this.resolveSnapshot(snapshot, requestAuth, optionMaps, options),
    };
  }

  private captureModelSnapshot(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly supportsJsonSchemaOutput: boolean;
  }): AiSdkModelSnapshot {
    const configuredProvider = toAiSdkProviderConfig(input.providerId, input.providerConfig);
    // 重构后模型 SDK 曾只接到用户 Header，漏掉版本和站点归因；在公共绑定边界恢复，
    // 不依赖签名成功，不给各业务重复补头，也不修改 Provider 或已绑定 Model 的配置。
    configuredProvider.headers = mergeModelRequestHeaders(
      withOpenRouterAttributionHeaders(this.defaultHeaders, configuredProvider.baseURL),
      configuredProvider.headers,
    );
    const apiKey = this.resolveApiKey(configuredProvider);
    return {
      providerConfig: {
        ...configuredProvider,
        ...(apiKey ? { apiKey } : {}),
        ...(configuredProvider.headers ? { headers: { ...configuredProvider.headers } } : {}),
        ...(configuredProvider.providerOptions
          ? { providerOptions: { ...configuredProvider.providerOptions } }
          : {}),
      },
      providerId: input.providerId as ModelProviderId,
      modelId: input.modelId as ModelId,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput,
    };
  }

  private resolveSnapshot(
    snapshot: AiSdkModelSnapshot,
    requestAuth: ModelRequestAuth | undefined,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
  ): AiSdkResolvedModel {
    const providerConfig = applyModelRequestAuth(snapshot.providerConfig, requestAuth);
    // Model 创建时的 Provider 事实必须被冻结在当前 binding 中。若按 providerId 缓存
    // factory，配置更新后创建的新 Model 会错误复用旧 Endpoint / Header / API Key。
    const rawRequestBodyCapture: RawRequestBodyCapture = {};
    const streamTiming: NonNullable<AiSdkResolvedModel["streamTiming"]> = {};
    const factory = this.createFactory(
      snapshot.providerId,
      providerConfig,
      optionMaps,
      optionValues,
      rawRequestBodyCapture,
      streamTiming,
      snapshot.supportsJsonSchemaOutput,
      snapshot.providerConfig.access?.type === "zhipu-account" ? requestAuth?.apiKeyId : undefined,
    );
    return {
      baseURL: providerConfig.baseURL,
      headers: providerConfig.headers,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      model: factory(snapshot.modelId.toString()),
      providerKind: providerConfig.kind,
      providerOptions: withOpenAiResponsesReplayOptions(providerConfig, optionMaps, optionValues),
      rawRequestBodyCapture,
      requestObservations: this.requestSecurity,
      streamTiming,
    };
  }

  private createFactory(
    providerId: string,
    providerConfig: AiSdkProviderConfig,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
    rawRequestBodyCapture: RawRequestBodyCapture,
    streamTiming: NonNullable<AiSdkResolvedModel["streamTiming"]>,
    supportsJsonSchemaOutput: boolean,
    apiKeyId?: string,
  ): LanguageModelFactory {
    const apiKey = this.resolveApiKey(providerConfig);
    // SDK 会合并 factory 默认 header；必须在这里去掉静态来源，才能保证缺失时真正省略。
    const headers = withoutContextOwnedModelHeaders(providerConfig.headers);
    const networkTransport = observeProviderFetch(
      this.resolveProviderTransport(providerId),
      this.logger,
      providerId,
    );
    // ID 属于当前 attempt，不能放入按 Provider 缓存的 transport，避免切换账号后串用。
    const providerTransport = this.endpointRoutingPort
      ? createProviderEndpointRoutingFetch({
          fetch: networkTransport,
          routingPort: this.endpointRoutingPort,
          apiKeyId,
        })
      : networkTransport;
    const requestTransport = this.requestSecurity.protectTransport({
      providerId,
      providerConfig,
      transport: providerTransport,
    });
    const fetch = createProviderBusinessErrorFetch({
      fetch: requestTransport,
      providerId,
      providerKind: providerConfig.kind,
      streamTiming,
    });
    const optionFetch =
      optionMaps && optionValues
        ? createModelOptionMapFetch({
            capture: rawRequestBodyCapture,
            fetch,
            maps: optionMaps,
            values: optionValues,
          })
        : fetch;

    switch (providerConfig.kind) {
      case "openai": {
        const provider = createOpenAI({
          apiKey,
          baseURL: providerConfig.baseURL,
          fetch: createOpenAIResponsesJsonCompatFetch(optionFetch),
          headers,
        });
        return provider.responses as LanguageModelFactory;
      }

      case "anthropic": {
        const provider = createAnthropic({
          apiKey,
          baseURL: normalizeAnthropicBaseURL(providerConfig.baseURL),
          fetch: createAnthropicCompatFetch(optionFetch),
          headers: withAnthropicAuthorizationHeader(apiKey, headers),
        });
        return provider as LanguageModelFactory;
      }

      case "openai-compatible": {
        const provider = createOpenAICompatible<string, string, string, string>({
          name: providerConfig.name ?? providerId,
          baseURL: providerConfig.baseURL,
          apiKey,
          fetch: optionFetch,
          headers,
          // OpenAI Compatible 流式 usage 需要显式请求，Usage 是执行结果的一部分。
          includeUsage: true,
          // 缺少这一装配时 SDK 默认 false，会把已声明支持的 Schema 静默降为 JSON object。
          // 使用 binding 冻结的模型事实，不按供应商或实时 Registry 另查一套能力。
          supportsStructuredOutputs: supportsJsonSchemaOutput,
        });
        return provider as LanguageModelFactory;
      }
    }
  }

  private resolveApiKey(providerConfig: AiSdkProviderConfig): string | undefined {
    return providerConfig.apiKey;
  }

  private resolveProviderTransport(providerId: string): ProviderFetch {
    const current = this.providerTransports.get(providerId);
    if (current) {
      return current;
    }
    const networkTransport = createProviderProxyFetch({
      caCertFile: this.network.caCertFile,
      env: this.env,
      fetch: this.baseTransport,
      httpProxy: this.network.httpProxy,
      noProxy: this.network.noProxy,
    });
    // 观测若放在底层 fetch 注入点，配置代理或 CA 时会被网络适配器绕过。
    const observedTransport = this.observeTransport?.(networkTransport) ?? networkTransport;
    this.providerTransports.set(providerId, observedTransport);
    return observedTransport;
  }
}

interface AiSdkModelSnapshot {
  readonly supportsJsonSchemaOutput: boolean;
  readonly providerConfig: AiSdkProviderConfig;
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
}

function toAiSdkProviderConfig(
  providerId: string,
  config: RegistryProviderConfig,
): AiSdkProviderConfig {
  const common = {
    ...(config.access.type !== "zhipu-account" && config.access.apiKey
      ? { apiKey: config.access.apiKey }
      : {}),
    baseURL: config.api.baseUrl,
    ...(config.api.headers ? { headers: { ...config.api.headers } } : {}),
    providerOptions: { apiFormat: config.api.type },
    access: config.access,
  };
  switch (config.api.type) {
    case "anthropic-messages":
      return { kind: "anthropic", ...common };
    case "openai-responses":
      return { kind: "openai", ...common };
    case "openai-chat-completions":
      return { kind: "openai-compatible", name: providerId, ...common };
  }
  throw new Error(`Unsupported Provider API type: ${String(config.api.type)}`);
}

/**
 * Responses 加密推理回传的请求选项，store 和 include 只在这里写，transform 和 SDK 读同一个对象。
 * - 根因：不发 store 时上游按 store=true 处理，不返回加密推理；zcode 没有 previousResponseId，
 *   下一轮只能丢掉 reasoning，所有模型的推理在工具步之间断开。改为无状态，下一轮由 transform
 *   按 itemId 原样带回密文。
 * - include 必须自己发：SDK 只给名单内模型（o1/o3/o4-mini/gpt-5*）自动补，gpt-6 等新模型不在名单里。
 *   但非推理模型带 include 会被上游 400（Encrypted content is not supported with this model）。
 *   推理映射本来就决定本次请求是否要推理，所以用同一份映射和本次档位求值：写了 reasoning 才补 include。
 */
function withOpenAiResponsesReplayOptions(
  providerConfig: AiSdkProviderConfig,
  optionMaps: CompiledModelOptionMaps | undefined,
  optionValues: ModelOptionValues | undefined,
): Record<string, unknown> | undefined {
  const providerOptions = providerConfig.providerOptions;
  if (providerConfig.kind !== "openai") return providerOptions;
  const optionFragment = optionMaps && optionValues ? optionMaps.apply({}, optionValues) : {};
  return {
    ...providerOptions,
    openai: {
      ...asRecord(providerOptions?.openai),
      store: false,
      ...(asRecord(optionFragment.reasoning)
        ? { include: [OPENAI_ENCRYPTED_REASONING_INCLUDE] }
        : {}),
    },
  };
}

function applyModelRequestAuth(
  providerConfig: AiSdkProviderConfig,
  requestAuth: ModelRequestAuth | undefined,
): AiSdkProviderConfig {
  if (!requestAuth) return providerConfig;
  const staticHeaders = withoutRequestVerificationHeaders(providerConfig.headers);
  // 账号动态身份头必须先清理静态认证头，避免 SDK 优先使用旧凭据。
  const headers =
    providerConfig.access.type === "zhipu-account"
      ? withoutModelAuthHeaders(staticHeaders)
      : staticHeaders;
  return {
    ...providerConfig,
    ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
    headers: mergeModelRequestHeaders(headers, requestAuth.headers),
  };
}

function withAnthropicAuthorizationHeader(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!apiKey || hasHeader(headers, AUTHORIZATION_HEADER_NAME)) {
    return headers;
  }

  // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；显式配置的 Authorization 保持优先。
  return {
    [AUTHORIZATION_HEADER_NAME]: `Bearer ${apiKey}`,
    ...headers,
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = pathname;
      return url.href;
    }

    // Anthropic's AI SDK provider appends /messages to baseURL, so explicit
    // gateway roots must include the /v1 API prefix at the adapter boundary.
    url.pathname = `${pathname}/v1`;
    return url.href;
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/u, "");
    return withoutTrailingSlash.toLowerCase().endsWith("/v1")
      ? withoutTrailingSlash
      : `${withoutTrailingSlash}/v1`;
  }
}

export function createProviderBusinessErrorFetch(
  options: ProviderBusinessErrorFetchOptions,
): ProviderFetch {
  const networkFetch = createProviderProxyFetch(options);
  const baseFetch = options.endpointRoutingPort
    ? createProviderEndpointRoutingFetch({
        fetch: networkFetch,
        routingPort: options.endpointRoutingPort,
      })
    : networkFetch;

  return async (input, init) => {
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      throw normalizeModelTlsFailure(error);
    }

    // zcode-plan 安全校验拒绝（3007）等场景返回 HTTP 403 + JSON，但未必带
    // Content-Type: application/json。若只在启发式命中时才读 body，fetch 会把 403 原样交给
    // AI SDK，流式请求可能以空 completion 结束，core 最终误报 suspicious empty。
    if (!response.ok) {
      const nonOkBusinessError = await detectProviderBusinessError(response, options);
      if (nonOkBusinessError) {
        await consumeBusinessErrorResponseBodyBestEffort(response);
        throw nonOkBusinessError;
      }
    }

    if (responseMayContainSseBusinessError(response)) {
      return createProviderBusinessErrorSseResponse(response, options);
    }

    const businessError = await detectProviderBusinessError(response, options);
    if (businessError) {
      await consumeBusinessErrorResponseBodyBestEffort(response);
      throw businessError;
    }
    return response;
  };
}

/** 位于请求安全处理以内的网络边界；只读关联头，不记录 URL 或消费响应 body。 */
export function observeProviderFetch(
  fetch: ProviderFetch,
  logger: Logger | undefined,
  providerId: string,
): ProviderFetch {
  if (!logger) return fetch;
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const requestId = headers.get("x-request-id");
    const querySource = headers.get("x-zcode-query-source");
    if (!requestId || (querySource !== "main_turn" && querySource !== "compact"))
      return fetch(input, init);
    const start = performance.timeOrigin + performance.now();
    const log = (name: string, statusCode?: number) => {
      const at = performance.timeOrigin + performance.now();
      try {
        logger.info("Model transport diagnostic", {
          event: `ttft.model.${name}`,
          requestId,
          querySource,
          providerId,
          queryId: headers.get("x-query-id") ?? undefined,
          sessionId: headers.get("x-session-id") ?? undefined,
          traceId: (headers.get("x-zcode-trace-id") ?? undefined) as
            | import("@zcode/contracts").TraceId
            | undefined,
          at,
          durationMs: at - start,
          statusCode,
        });
      } catch {
        /* 日志异常不能改变网络返回值。 */
      }
    };
    log("fetch_started");
    try {
      const response = await fetch(input, init);
      log("response_headers", response.status);
      return response;
    } catch (error) {
      log("fetch_failed");
      throw error;
    }
  };
}

async function consumeBusinessErrorResponseBodyBestEffort(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // 业务错误检测消费的是 response.clone()；只 cancel 原始 tee 分支时，
    // Undici 的 cancel Promise 完成也不保证连接已可复用，连续 429 仍会耗尽连接槽。
    // 已识别的业务错误体受 64KB 上限保护，完整消费原始分支后连接才能稳定复用；
    // 异常 stream 永不收敛时则由清理上限兜底，不能阻塞已经解析出的原始错误。
    await Promise.race([
      response.arrayBuffer().then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 清理失败不能覆盖已经解析出的 provider 原始错误。
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

interface ProviderProxyFetchOptions {
  caCertFile?: string;
  env?: EnvRecord;
  fetch?: ProviderFetch;
  httpProxy?: string;
  noProxy?: string;
}

function createProviderProxyFetch(options: ProviderProxyFetchOptions): ProviderFetch {
  // Node 的 global fetch 不会自动读取 HTTP_PROXY/http_proxy。
  // 模型 provider 和 MCP HTTP transport 都复用同一层 proxy-aware fetch，避免多套出口规则漂移。
  return createNetworkProxyFetch(options);
}

async function detectProviderBusinessError(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Promise<ProviderBusinessError | undefined> {
  if (!responseMayContainBusinessJson(response)) {
    return undefined;
  }

  let body: unknown;
  try {
    const text = await readLimitedResponseText(response);
    if (text === undefined || text.trim().length === 0) {
      return undefined;
    }
    body = JSON.parse(text);
  } catch {
    return undefined;
  }

  const failure = readProviderBusinessFailureFromBody(body);
  if (!failure) {
    return undefined;
  }

  return new ProviderBusinessError({
    providerCode: failure.providerCode,
    providerId: options.providerId,
    providerKind: options.providerKind,
    providerMessage: failure.providerMessage,
    providerRequestId: failure.providerRequestId,
    responseBodySummary: failure.responseBodySummary,
    // fetch 层的 ProviderBusinessError 会绕过 APICallError；
    // 不保留响应头会导致 retry-after/retry-after-ms 在重试计算前丢失。
    responseHeaders: responseHeadersToRecord(response.headers),
    responseStatus: response.status,
    statusCode: failure.statusCode,
  });
}

/** 从 HTTP JSON body 解析 zcode-plan 等业务错误（供 failure-classifier 在 APICallError 路径复用）。 */
export function readProviderBusinessFailureFromBody(body: unknown):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }

  const errorRecord = asRecord(record.error);
  const providerCode =
    toProviderCode(record.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(record.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 二次包装后的外层 code 是 ZCode 自己的 PROVIDER_BUSINESS_ERROR，
    // 真实上游码在 providerCode；只有没有 providerCode 时才退回读取 code。
    toProviderCode(record.code) ??
    toProviderCode(errorRecord?.code);
  const providerMessage = readProviderMessage(record);
  const failedBySuccess = record.success === false;
  const failedByCode = isNonZeroProviderCode(providerCode);

  if (!failedBySuccess && !failedByCode) {
    return undefined;
  }

  return {
    providerCode,
    providerMessage,
    providerRequestId: readProviderRequestId(record),
    responseBodySummary: summarizeProviderBusinessBody(record),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

function responseMayContainBusinessJson(response: Response): boolean {
  // 非 2xx 一律尝试读 body 解析业务码（403/3007、429/3002 等），不依赖 Content-Type 猜测。
  if (!response.ok) {
    return true;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("event-stream")) {
    return false;
  }
  if (contentType.includes("json")) {
    return true;
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  return contentLength !== undefined && contentLength <= MAX_BUSINESS_ERROR_BODY_CHARS;
}

async function readLimitedResponseText(response: Response): Promise<string | undefined> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_BUSINESS_ERROR_BODY_CHARS) {
    return undefined;
  }

  const clone = response.clone();
  if (!clone.body) {
    const text = await clone.text();
    return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
  }

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
      }

      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_BUSINESS_ERROR_BODY_CHARS) {
        await reader.cancel();
        return undefined;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function responseMayContainSseBusinessError(response: Response): boolean {
  return (
    response.body !== null &&
    response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true
  );
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function createProviderBusinessErrorSseResponse(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const responseHeaders = responseHeadersToRecord(response.headers);

  return new Response(
    body.pipeThrough(
      createProviderBusinessErrorSseTransform(options, response.status, responseHeaders),
    ),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

function createProviderBusinessErrorSseTransform(
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let streamFailed = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
    },
    flush(controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode();
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
      if (!streamFailed && pending.length > 0) {
        emitProviderBusinessSseFrame(
          pending,
          "",
          controller,
          encoder,
          options,
          responseStatus,
          responseHeaders,
          () => {
            streamFailed = true;
          },
        );
      }
    },
  });
}

function emitCompleteProviderBusinessSseFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    const emitted = emitProviderBusinessSseFrame(
      frame,
      separator,
      controller,
      encoder,
      options,
      responseStatus,
      responseHeaders,
      markFailed,
    );
    if (!emitted) {
      return "";
    }
  }
}

function emitProviderBusinessSseFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): boolean {
  const failure = detectProviderBusinessSseFrameFailure(frame);
  if (failure) {
    // 部分 OpenAI-compatible provider 只在 HTTP 200 SSE error frame 中报告业务错误；
    // 同时保留原始响应头，保证限流场景的 retry-after 能进入后续重试退避。
    controller.error(
      new ProviderBusinessError({
        providerCode: failure.providerCode,
        providerId: options.providerId,
        providerKind: options.providerKind,
        providerMessage: failure.providerMessage,
        providerRequestId: failure.providerRequestId,
        responseBodySummary: failure.responseBodySummary,
        responseHeaders,
        responseStatus,
        statusCode: failure.statusCode,
      }),
    );
    markFailed();
    return false;
  }

  // 工具参数和部分文本会在后续兼容层/重试层暂存；释放时再计时会把接收耗时压成几毫秒。
  // 复用接口层已有分帧，在任何内容缓冲前记录首个有效输出，不改变重试提交边界。
  if (
    options.streamTiming &&
    options.streamTiming.firstContentAt === undefined &&
    providerSseFrameHasContent(frame, options.providerKind)
  ) {
    options.streamTiming.firstContentAt = Date.now();
  }
  controller.enqueue(encoder.encode(`${frame}${separator}`));
  return true;
}

function providerSseFrameHasContent(frame: string, kind: AiSdkProviderKind): boolean {
  const data = readSseFrame(frame).data;
  const body = data ? safeParseRecord(data) : undefined;
  if (!body) return false;
  const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.length > 0;
  if (kind === "anthropic") {
    if (body.type === "content_block_delta") {
      const delta = asRecord(body.delta);
      switch (delta?.type) {
        case "text_delta":
          return nonEmpty(delta.text);
        case "thinking_delta":
          return nonEmpty(delta.thinking);
        case "input_json_delta":
          return nonEmpty(delta.partial_json);
        default:
          return false;
      }
    }
    if (body.type === "content_block_start") {
      const block = asRecord(body.content_block);
      if (block?.type === "text") return nonEmpty(block.text);
      if (block?.type === "thinking") return nonEmpty(block.thinking);
      if (block?.type === "tool_use" || block?.type === "server_tool_use") {
        const input = asRecord(block.input);
        return input !== undefined && Object.keys(input).length > 0;
      }
    }
    return false;
  }
  if (kind === "openai") {
    return (
      (body.type === "response.output_text.delta" ||
        body.type === "response.reasoning_text.delta" ||
        body.type === "response.reasoning_summary_text.delta" ||
        body.type === "response.function_call_arguments.delta") &&
      nonEmpty(body.delta)
    );
  }
  return (
    Array.isArray(body.choices) &&
    body.choices.some((choice) => {
      const delta = asRecord(asRecord(choice)?.delta);
      if (!delta) return false;
      return (
        nonEmpty(delta.content) ||
        nonEmpty(delta.reasoning_content) ||
        nonEmpty(delta.reasoning) ||
        nonEmpty(asRecord(delta.function_call)?.arguments) ||
        (Array.isArray(delta.tool_calls) &&
          delta.tool_calls.some((call) => nonEmpty(asRecord(asRecord(call)?.function)?.arguments)))
      );
    })
  );
}

function detectProviderBusinessSseFrameFailure(frame: string):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const sse = readSseFrame(frame);
  const data = sse.data?.trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  const body = safeParseRecord(data);
  if (!body) {
    return undefined;
  }

  const businessFailure = readProviderBusinessFailureFromBody(body);
  if (businessFailure) {
    return {
      ...businessFailure,
      providerRequestId: readProviderRequestId(body),
    };
  }

  if (sse.event?.toLowerCase() !== "error") {
    return undefined;
  }

  const errorRecord = asRecord(body.error);
  const providerCode =
    toProviderCode(body.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(body.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 包装码不能覆盖真实 providerCode。
    toProviderCode(body.code) ??
    toProviderCode(errorRecord?.code);

  return {
    providerCode,
    providerMessage: readProviderMessage(body),
    providerRequestId: readProviderRequestId(body),
    responseBodySummary: summarizeProviderBusinessBody(body),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

function readSseFrame(frame: string): { data?: string; event?: string } {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (rawLine.startsWith("event:")) {
      event = trimSseFieldValue(rawLine.slice("event:".length));
      continue;
    }
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    dataLines.push(trimSseFieldValue(rawLine.slice("data:".length)));
  }

  return {
    data: dataLines.length === 0 ? undefined : dataLines.join("\n"),
    event,
  };
}

function trimSseFieldValue(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function isNonZeroProviderCode(value: ProviderCode | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

function providerCodeToStatusCode(value: ProviderCode | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const statusCode = Math.trunc(value);
    return isHttpStatusCode(statusCode) ? statusCode : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const statusCode = Number(normalized);
  return isHttpStatusCode(statusCode) ? statusCode : undefined;
}

function isHttpStatusCode(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

/**
 * 上游业务码只可能是数字或短标识符（3007、1113、insufficient_quota 等）。
 *
 * 曾出现的问题：某个上游在 HTTP 499 响应体里带了 `code` 字段，内容是一段多行脚本，
 * 原先只要是非空字符串就当作 providerCode，于是报错详情显示成 `provider_code=<整段脚本>`，
 * 还会因为“非零码”被误判成业务错误。这里统一按码值形状过滤，不像码值的当作没有码，
 * 让错误回到按 HTTP 状态码分类的通用路径。
 */
const PROVIDER_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isProviderCodeShaped(value: string): boolean {
  return PROVIDER_CODE_SHAPE.test(value);
}

function toProviderCode(value: unknown): ProviderCode | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const normalized = value.trim();
    // 不像码值的字符串（如整段脚本）不能当 providerCode，原因见 model-execution.ts 的 isProviderCodeShaped。
    if (!isProviderCodeShaped(normalized)) {
      return undefined;
    }
    return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE
      ? undefined
      : normalized;
  }
  return undefined;
}

function readProviderMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeProviderMessage(record.msg) ??
    normalizeProviderMessage(record.message) ??
    normalizeProviderMessage(errorRecord?.msg) ??
    normalizeProviderMessage(errorRecord?.message) ??
    normalizeProviderMessage(record.error)
  );
}

function readProviderRequestId(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeProviderId(record.request_id) ??
    normalizeProviderId(record.requestId) ??
    normalizeProviderId(record.id) ??
    normalizeProviderId(errorRecord?.request_id) ??
    normalizeProviderId(errorRecord?.requestId) ??
    normalizeProviderId(errorRecord?.id)
  );
}

function normalizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}...`
    : normalized;
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}...`
    : normalized;
}

function summarizeProviderBusinessBody(record: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    keys: Object.keys(record).slice(0, 20),
  };

  copyScalar(record, summary, "success");
  copyScalar(record, summary, "code");
  copyScalar(record, summary, "error_code");
  copyScalar(record, summary, "msg");
  copyScalar(record, summary, "message");
  copyScalar(record, summary, "request_id");
  copyScalar(record, summary, "requestId");

  const errorRecord = asRecord(record.error);
  if (errorRecord) {
    const errorSummary: Record<string, unknown> = {
      keys: Object.keys(errorRecord).slice(0, 20),
    };
    copyScalar(errorRecord, errorSummary, "code");
    copyScalar(errorRecord, errorSummary, "error_code");
    copyScalar(errorRecord, errorSummary, "msg");
    copyScalar(errorRecord, errorSummary, "message");
    copyScalar(errorRecord, errorSummary, "request_id");
    copyScalar(errorRecord, errorSummary, "requestId");
    copyScalar(errorRecord, errorSummary, "type");
    summary.error = errorSummary;
  }

  return summary;
}

function copyScalar(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    target[key] = value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

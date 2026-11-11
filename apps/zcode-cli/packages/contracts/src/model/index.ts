import type { ModelToolReferenceContentBlock } from "../tools/tool-search.js";
import { zcodeProviderRuntimeHeadersErrorCode } from "@zcode/shared";
// ============================================================
// Model Protocol - provider-neutral model contracts
// ============================================================

import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import type {
  ProviderNativeToolSpec,
  ToolExecutionMode,
  ToolPermissionSpec,
  ToolResultBudget,
} from "../tools/contract.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelApiCallObservation,
  ModelApiErrorPhase,
  ResolvedModelApiCallObservation,
} from "../telemetry/index.js";

export * from "./image-media.js";
export * from "./model.js";
export * from "./invocation-context.js";

export type JsonSchema = Record<string, unknown>;

export type ModelProviderId = string & { readonly __brand: "ModelProviderId" };
export type ModelId = string & { readonly __brand: "ModelId" };

export const ModelRequestSessionType = {
  Main: "main",
  Other: "other",
  SideChat: "side_chat",
  Subagent: "subagent",
} as const;

/**
 * 模型请求的重试预算档位（runtime-only）。
 * - `default`：adapter 构造时解析出的 maxAttempts（默认 10 次重试）。
 * - `unbounded`：**瞬态**失败无上限重试（退避曲线不变、封顶 60s 后无限探测），永久失败照旧立即抛。
 *   给 workflow actor（taskType workflow_child / nested_workflow_child）使用：模型错误绝不是
 *   workflow 错误，唯一出口是用户 cancel。
 * - `single-attempt`：本次请求 maxAttempts 收敛为 1，瞬态失败也不重试、首次失败即上抛。
 *   给带 selectionFallback 声明的执行作用域 Selection（如 Highspeed 加速卡）使用：失败后由 core
 *   退回会话模型继续本轮，适配层再按默认 10 次退避重试只会把降级拖到数分钟之后。
 */
export const ModelRetryBudget = {
  Default: "default",
  Unbounded: "unbounded",
  SingleAttempt: "single-attempt",
} as const;

export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

/**
 * 一次模型请求尝试的准入票据（runtime-only）。
 *
 * 它同时是**这一次尝试**的状态事件汇：runner 把该尝试的 ModelNetworkStatus 事件
 * （`model_request_started` / `model_request_completed` / `model_request_failed` /
 * `model_retry_scheduled`）原样也投递给它，治理器据此判定这次请求的结果（成功 / 限流 / 瞬态失败 /
 * 终结），不需要 runner 在每个失败分支上另写一遍结果。`release()` 是兜底：尝试无论如何结束（成功、
 * 抛出、消费者提前放弃流）runner 都在 finally 里调一次；未见终结事件即按终结处理。**幂等**。
 */
export interface ModelRequestAdmissionTicket extends ModelStatusSink {
  release(): void;
}

/**
 * 模型请求的准入端口（runtime-only）。runner 在**每一次尝试发出前**先试同步快路径
 * `tryAcquire`，未命中再 `acquire` 排队；拿到票据后才发请求；尝试结束即 `release`，退避 sleep 期间
 * 不持票——所以进程级并发 cap 约束的是 provider 真正看到的在飞请求数。`signal` 被 abort 时
 * `acquire` 以 `signal.reason` reject。
 *
 * `tryAcquire` 未命中是 runner 发 `model_request_queued` / `model_request_admitted` 的唯一依据
 * 没有快路径的实现 runner 无法分辨「排了队」与「立即放行」，一律不发这两条事件。
 *
 * 端口绑定在 runtime 的模型工厂上：runtime 交出的每一个模型句柄——turn step、工具内部
 * 的模型调用、压缩、标题 sidecar——都带它；缺席即不设闸门（runner 行为逐字不变）。主代理拿的是
 * 治理器的 observer 实现：`tryAcquire` 总命中、只喂信号。
 */
export interface ModelRequestAdmission {
  /** 同步快路径：闸门开着且无人排队即给票；否则 undefined，runner 转 `acquire` 并报排队。 */
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined;
  acquire(input: {
    model: ModelRequestTarget;
    signal?: AbortSignal;
  }): Promise<ModelRequestAdmissionTicket>;
}

/**
 * 准入端口看到的模型身份：配额键的最小事实。既不是 Selection（那是执行意图），也不是
 * Active Model（那带完整配置）——treaty 只要 provider/model 两段。
 */
export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

export type ModelRequestSessionType =
  (typeof ModelRequestSessionType)[keyof typeof ModelRequestSessionType];

export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection",
  ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found",
  ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found",
  InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response",
  ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing",
  ModelRequestVerificationConfigNetwork: zcodeProviderRuntimeHeadersErrorCode.configNetwork,
  ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

export const ModelTransportKind = {
  Http: "http",
  Sse: "sse",
  WebSocket: "websocket",
} as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** Anthropic 明确拒绝历史 thinking signature 后，对请求副本清理并立即重试一次。 */
  ReasoningSignatureRepair: "reasoning_signature_repair",
  /** off-peak 闲时排队（429/3105+Retry-After）：豁免重试预算、无限探测（仅 idle plan provider）。 */
  OffpeakQueued: "offpeak_queued",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

interface ModelNetworkStatusBase {
  timestamp: string;
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: SessionId;
  turnId?: TurnId;
  parentSessionId?: SessionId;
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ModelProviderId;
  modelId: ModelId;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  attempt: number;
  /**
   * 本次请求的重试预算总尝试数（含首次）。**`0` = 无上限**（`ModelRetryBudget.Unbounded`）：`Infinity` 不可序列化，而 0 不占用任何既有合法值。
   * 消费方渲染「第 n/N 次」或推导 maxRetries 时必须特判 0。
   */
  maxAttempts: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestHeaderCount?: number;
  responseHeaderCount?: number;
  modelCall?: ResolvedModelApiCallObservation;
}

export interface ModelStreamRecoveryStatus {
  attemptId: string;
  retryNumber: number;
  maxRetries: number;
  recoveredFromRequestId?: string;
  anchorId?: string;
}

export interface ModelRequestStartedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_started";
}

/**
 * 准入等待的两端：runner 的 `tryAcquire` 未命中
 * 即发 `queued`，拿到票即发 `admitted`（带排队时长）。它们是 runtime 观测——driver 据此报「等待槽位」，
 * 工具执行器据此暂停工具超时——不进 provider 请求；协议侧凡枚举状态类型的消费方显式忽略。
 */
export interface ModelRequestQueuedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_queued";
}

export interface ModelRequestAdmittedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_admitted";
  queuedMs: number;
}

export interface ModelRequestCompletedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_completed";
  durationMs: number;
  finishReason?: string;
  usage?: ModelUsage;
  providerRequestId?: string;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
  streamMaxIdleMs?: number;
  streamStallCount?: number;
  streamOutputCommitted?: boolean;
}

export interface ModelRequestFailedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_failed";
  /** Provider 已报告的失败请求用量；不为失败响应伪造成功完成事件。 */
  usage?: ModelUsage;
  durationMs?: number;
  reason: ModelFailureReason;
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
  errorPhase?: ModelApiErrorPhase;
  exceptionType?: string;
  streamOutputCommitted?: boolean;
}

export interface ModelRetryScheduledStatusEvent extends ModelNetworkStatusBase {
  type: "model_retry_scheduled";
  delayMs: number;
  nextAttempt: number;
  reason: ModelRetryReason;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}

export interface ModelStreamStalledStatusEvent extends ModelNetworkStatusBase {
  type: "model_stream_stalled";
  idleMs: number;
  timeoutMs: number;
  message: string;
}

/**
 * 仅供实时观测 Sink 消费的 Provider 里程碑。它们不进入 SessionEvent/回放协议，
 * 避免为了 Trace 事件扩大产品状态面。
 */
export interface ModelTelemetryMilestoneStatusEvent extends ModelNetworkStatusBase {
  type: "model_first_provider_event" | "model_first_content" | "model_first_text";
  elapsedMs: number;
}

/** 仅投递进程内 telemetry statusSink，不进入请求 UI 事件；字段不得携带凭据或用户内容。 */
export type ModelRequestObservation = Readonly<{
  kind: string;
  [field: string]: string | number | boolean | undefined;
}>;

export interface ModelRequestObservationStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_observation";
  observation: ModelRequestObservation;
}

export type ModelNetworkStatusEvent =
  | ModelRequestQueuedStatusEvent
  | ModelRequestAdmittedStatusEvent
  | ModelRequestObservationStatusEvent
  | ModelRequestStartedStatusEvent
  | ModelRequestCompletedStatusEvent
  | ModelRequestFailedStatusEvent
  | ModelRetryScheduledStatusEvent
  | ModelStreamStalledStatusEvent
  | ModelTelemetryMilestoneStatusEvent;

export interface ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void | Promise<void>;
  /**
   * Transport 捕获失败时可把原始异常直接交给进程级观测 Sink。产品 SessionEvent/日志仍只消费
   * publish(event)，避免原始异常对象和消息正文进入持久化领域状态。
   */
  publishFailure?(event: ModelRequestFailedStatusEvent, error: unknown): void | Promise<void>;
}

export class ModelProtocolError extends Error {
  readonly code: ModelErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
    this.context = context;
  }
}

export function createModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelSelection,
      "Model provider id is empty",
    );
  }
  return normalized as ModelProviderId;
}

export function createModelId(modelId: string): ModelId {
  const normalized = modelId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(ModelErrorCode.InvalidModelSelection, "Model id is empty");
  }
  return normalized as ModelId;
}

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
  providerExecuted?: boolean;
  /** 本次模型响应内的块到达序号，与 text / reasoning 块共用序号空间；旧数据可缺失。 */
  blockIndex?: number;
}

export type AttachmentKind = "local_file" | "resource" | "inline";

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
}

export interface ModelTextContentBlock {
  type: "text";
  text: string;
  /** assistant 块到达序号，只用于请求投影排序，不进入 provider 请求。 */
  blockIndex?: number;
}

export interface ModelReasoningContentBlock {
  type: "reasoning";
  text: string;
  providerOptions?: Record<string, unknown>;
  /** assistant 块到达序号，只用于请求投影排序，不进入 provider 请求。 */
  blockIndex?: number;
}

export interface ModelImageContentBlock {
  type: "image";
  mediaType: string;
  dataUrl: string;
  detail?: "auto" | "low" | "high" | "original";
  source?: AttachmentRef;
}

export interface ModelFileContentBlock {
  type: "file";
  mediaType: string;
  name?: string;
  uri?: string;
  dataUrl?: string;
  text?: string;
  source?: AttachmentRef;
}

/** 视频输入内容块（provider-neutral，与 image 同构；只承载 base64 dataUrl）。 */
export interface ModelVideoContentBlock {
  type: "video";
  mediaType: string;
  dataUrl: string;
  source?: AttachmentRef;
}

export interface ModelResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  title?: string;
}

export type ModelMessageContentBlock =
  | ModelToolReferenceContentBlock
  | ModelTextContentBlock
  | ModelReasoningContentBlock
  | ModelImageContentBlock
  | ModelVideoContentBlock
  | ModelFileContentBlock
  | ModelResourceLinkContentBlock;

export type ModelMessageContent = string | ModelMessageContentBlock[];

export interface ModelCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "global" | "org";
}

export interface ModelInputMessage {
  role: ModelMessageRole;
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  providerId?: ModelProviderId;
  modelId?: ModelId;
  /**
   * 这条 assistant 由一次签名修复后成功的请求产出：它之前的已签名/redacted reasoning
   * 已被服务端判为失效，之后的请求投影一律不再发送（见 anthropic-reasoning-history-replay.md）。
   */
  signedReasoningReset?: boolean;
}

export function modelMessageContentToText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

/**
 * blockIndex 是否合法（非负整数）。库、runtime、请求投影判定"有序"都用它，三层结论才一致。
 * 见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
 */
export function isBlockIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * 每一项的序号都合法（isBlockIndex）时，返回按序号稳定排序的新数组；
 * 有任何一项缺失或非法时返回 undefined，由调用方决定退回哪种顺序。
 */
export function sortByCompleteIndex<T>(
  items: readonly T[],
  indexOf: (item: T) => unknown,
): T[] | undefined {
  if (!items.every((item) => isBlockIndex(indexOf(item)))) return undefined;
  return [...items].sort((left, right) => (indexOf(left) as number) - (indexOf(right) as number));
}

export function modelMessageContentBlockToText(block: ModelMessageContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return "";
    case "tool_reference":
      return block.toolName;
    case "image":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "video":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "file":
      if (block.text !== undefined && block.text.length > 0) return block.text;
      return attachmentPlaceholder(
        "Attached",
        block.mediaType,
        block.name ?? block.source?.placeholder,
      );
    case "resource_link":
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`;
  }
}

function attachmentPlaceholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`;
}

export interface ModelToolExecutionContext {
  toolCallId: string;
  abortSignal?: AbortSignal;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export type ModelToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

export interface ModelToolContract {
  deferLoading?: boolean;
  name: string;
  description?: string;
  capability?: string;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** 见 ToolContractDeclaration.strict：严格模式的资格声明，adapter 按 provider/model 落地。 */
  strict?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  requiresUserInteraction?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
  needsApproval?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: ToolPermissionSpec;
  resultBudget?: ToolResultBudget;
  execute?: (input: unknown, context: ModelToolExecutionContext) => Promise<unknown> | unknown;
}

export type ModelToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

export interface ModelServerToolUsage {
  webSearchRequests?: number;
  webFetchRequests?: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  serverToolUse?: ModelServerToolUsage;
}

export interface ModelUsageSummary {
  source: "provider";
  modelRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
}

export function getModelUsageTotalTokens(usage?: ModelUsage): number {
  if (!usage) return 0;
  const inputTokens =
    usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return usage.totalTokens ?? inputTokens + (usage.outputTokens ?? 0);
}

export function getModelUsageContextTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = getModelUsageInputWindowTokens(usage);
  const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
  const contextTokens = (inputTokens ?? 0) + outputTokens;
  if (contextTokens > 0) {
    return contextTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  return totalTokens;
}

export function getModelUsageInputWindowTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = positiveInteger(usage.inputTokens);
  if (inputTokens !== undefined) {
    // AI SDK v6 的 Anthropic inputTokens 已经是普通输入 + cache read/write 的 total input。
    // 这里再叠 cacheReadTokens 会把 context meter 和 compact 阈值放大一截。
    return inputTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  if (totalTokens !== undefined) {
    const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
    return Math.max(0, totalTokens - outputTokens);
  }

  const cacheTokens =
    (nonNegativeInteger(usage.cacheReadTokens) ?? 0) +
    (nonNegativeInteger(usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

export function hasModelUsage(usage?: ModelUsage): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.serverToolUse?.webSearchRequests !== undefined ||
    usage.serverToolUse?.webFetchRequests !== undefined
  );
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

export function createModelUsageSummary(
  usages: readonly ModelUsage[],
): ModelUsageSummary | undefined {
  const realUsages = usages.filter(hasModelUsage);
  if (realUsages.length === 0) return undefined;

  return realUsages.reduce<ModelUsageSummary>(
    (summary, usage) => ({
      source: "provider",
      modelRequestCount: summary.modelRequestCount + 1,
      inputTokens: summary.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: summary.totalTokens + getModelUsageTotalTokens(usage),
      cacheReadTokens: summary.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: summary.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: summary.reasoningTokens + (usage.reasoningTokens ?? 0),
      webFetchRequests: summary.webFetchRequests + (usage.serverToolUse?.webFetchRequests ?? 0),
      webSearchRequests: summary.webSearchRequests + (usage.serverToolUse?.webSearchRequests ?? 0),
    }),
    {
      source: "provider",
      modelRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webFetchRequests: 0,
      webSearchRequests: 0,
    },
  );
}

export interface ModelRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
}

export interface ModelTextRequest extends ModelRequestSettings {
  toolSearchEnabled?: boolean;
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  toolChoice?: ModelToolChoice;
  responseJsonSchema?: JsonSchema;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Runtime-only hook for propagating model transport status to UI/session layers.
   * This is intentionally omitted from the JSON schema below because it is not serializable.
   */
  statusSink?: ModelStatusSink;
  /**
   * Runtime-only trace context. Serialized requests should pass trace ids through metadata.
   */
  traceContext?: TraceContext;
  /** Runtime-only、强类型的模型 API 调用分类；不会进入 Provider 请求。 */
  modelCall?: ModelApiCallObservation;
  /**
   * Runtime-only 的宿主 session 粗分类。Adapter 将它写入受控归因 header；
   * 不允许调用方通过 provider 静态 headers 覆盖。
   */
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Runtime-only 重试预算档位（见 {@link ModelRetryBudget}）。与 modelRequestSessionType 同族：
   * 不进 JSON schema、不进 provider 请求。缺省即 `default`。
   */
  modelRetryBudget?: ModelRetryBudget;
  /**
   * Runtime-only 准入端口（见 {@link ModelRequestAdmission}）：在场时 runner 每次尝试先 acquire、
   * 结束即 release。与 statusSink 同族：不进 JSON schema、不进 provider 请求。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * Runtime-only SSE idle timeout 递增序号。0/undefined 表示首请求；
   * 每重试一次在 adapter base timeout 上加 30000ms。
   */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution；只进入 status/telemetry，不发送给 Provider。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /**
   * Runtime-only provider stream 边界开关。compact 隐藏流用它保留首个真实 provider event
   * 与 content block provenance；tool input 提交不受此开关控制，所有请求都等待 AI SDK end。
   */
  preserveProviderStreamBoundaries?: boolean;
}

export interface ModelSource {
  type: "source";
  sourceType: "url" | "document";
  id?: string;
  url?: string;
  title?: string;
  mediaType?: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelToolResult {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  providerExecuted?: boolean;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelTextResult {
  text: string;
  /** 按到达顺序的文字块，每块带 blockIndex；`text` 仍是所有文字块直接拼接。 */
  textBlocks?: ModelTextContentBlock[];
  finishReason: string;
  usage: ModelUsage;
  reasoning?: ModelReasoningContentBlock[];
  toolCalls?: ModelToolCall[];
  toolResults?: ModelToolResult[];
  sources?: ModelSource[];
  providerMetadata?: Record<string, unknown>;
  /** 本次结果来自签名修复后的重试：调用方要在产出的 assistant 上记 signedReasoningReset。 */
  signedReasoningReset?: boolean;
}

export type ModelStreamEvent =
  | {
      type: "start";
    }
  | {
      /**
       * Compact-only replay boundary。Adapter 从 raw provider stream 提炼真实边界；
       * 无 raw provenance 的 direct tool-call 校验失败可补一个 inferred commit。
       * 事件不携带 provider 正文，也不进入 session/UI streaming。
       */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      blockType: string | null;
      index: number | null;
    }
  | {
      /** Raw delta 只携带 provenance type，不携带正文。 */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      deltaType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      index: number | null;
    }
  | {
      /** 每个 provider message_delta 覆盖当前 stop reason 状态，后续 null 会清掉先前值。 */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      present: boolean;
    }
  | {
      type: "text_start";
      id: string;
    }
  | {
      type: "text_delta";
      id?: string;
      text: string;
    }
  | {
      type: "text_end";
      id: string;
    }
  | {
      type: "reasoning_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool_input_start";
      id: string;
      toolName: string;
      providerExecuted?: boolean;
    }
  | {
      type: "tool_input_delta";
      id: string;
      delta: string;
    }
  | {
      type: "tool_input_end";
      id: string;
    }
  | {
      type: "tool_call";
      toolCall: ModelToolCall;
    }
  | {
      /**
       * Provider 在服务端执行完内置工具（toolCall.providerExecuted）后随流下发的结果。
       * 客户端不执行这类工具，只用于展示、持久化和下一次请求回放。
       */
      type: "provider_tool_result";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
      /** 同 ModelTextResult.signedReasoningReset。 */
      signedReasoningReset?: boolean;
    }
  | {
      type: "error";
      error: unknown;
    };

export const modelSelectionJsonSchema = {
  type: "object",
  required: ["providerId", "modelId"],
  additionalProperties: false,
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningLevel: { type: "string", minLength: 1 },
        maxOutputTokens: { type: "number", minimum: 1 },
      },
    },
  },
} satisfies JsonSchema;

const attachmentRefJsonSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { enum: ["local_file", "resource", "inline"] },
    uri: { type: "string" },
    path: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "number" },
    sha256: { type: "string" },
    placeholder: { type: "string" },
  },
} satisfies JsonSchema;

const modelMessageContentBlockJsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool_reference"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["text"] },
        text: { type: "string" },
        blockIndex: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["reasoning"] },
        text: { type: "string" },
        providerOptions: { type: "object" },
        blockIndex: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["image"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        detail: { enum: ["auto", "low", "high", "original"] },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["video"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType"],
      additionalProperties: false,
      properties: {
        type: { enum: ["file"] },
        mediaType: { type: "string", minLength: 1 },
        name: { type: "string" },
        uri: { type: "string" },
        dataUrl: { type: "string" },
        text: { type: "string" },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "uri"],
      additionalProperties: false,
      properties: {
        type: { enum: ["resource_link"] },
        uri: { type: "string", minLength: 1 },
        name: { type: "string" },
        title: { type: "string" },
      },
    },
  ],
} satisfies JsonSchema;

const modelMessageContentJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "array",
      items: modelMessageContentBlockJsonSchema,
    },
  ],
} satisfies JsonSchema;

export const modelInputMessageJsonSchema = {
  type: "object",
  required: ["role", "content"],
  additionalProperties: false,
  properties: {
    role: { enum: ["system", "user", "assistant", "tool"] },
    content: modelMessageContentJsonSchema,
    cacheControl: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { enum: ["ephemeral"] },
        ttl: { enum: ["5m", "1h"] },
        scope: { enum: ["global", "org"] },
      },
    },
    toolCalls: { type: "array" },
    toolCallId: { type: "string" },
    toolName: { type: "string" },
    isError: { type: "boolean" },
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    signedReasoningReset: { type: "boolean" },
  },
} satisfies JsonSchema;

const modelToolChoiceJsonSchema = {
  oneOf: [
    { enum: ["auto", "none", "required"] },
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
  ],
} satisfies JsonSchema;

export const modelTextRequestJsonSchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: { type: "array", items: modelInputMessageJsonSchema },
    tools: { type: "array" },
    toolChoice: modelToolChoiceJsonSchema,
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    topP: { type: "number" },
    topK: { type: "number" },
    presencePenalty: { type: "number" },
    frequencyPenalty: { type: "number" },
    stopSequences: { type: "array", items: { type: "string" } },
    seed: { type: "number" },
    responseJsonSchema: { type: "object" },
    providerOptions: { type: "object" },
    metadata: { type: "object" },
  },
} satisfies JsonSchema;

export const modelNetworkStatusEventJsonSchema = {
  type: "object",
  required: [
    "type",
    "timestamp",
    "traceId",
    "requestId",
    "model",
    "transport",
    "attempt",
    "maxAttempts",
  ],
  additionalProperties: true,
  properties: {
    type: {
      enum: [
        "model_request_started",
        "model_request_completed",
        "model_request_failed",
        "model_retry_scheduled",
        "model_stream_stalled",
      ],
    },
    timestamp: { type: "string", minLength: 1 },
    traceId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    turnId: { type: "string", minLength: 1 },
    querySource: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    model: modelSelectionJsonSchema,
    transport: { enum: Object.values(ModelTransportKind) },
    attempt: { type: "number", minimum: 1 },
    // 0 = 无上限重试预算，故下界是 0 而不是 1。
    maxAttempts: { type: "number", minimum: 0 },
    delayMs: { type: "number", minimum: 0 },
    durationMs: { type: "number", minimum: 0 },
    idleMs: { type: "number", minimum: 0 },
    nextAttempt: { type: "number", minimum: 1 },
    reason: { enum: Object.values(ModelFailureReason) },
    retryable: { type: "boolean" },
    message: { type: "string" },
    statusCode: { type: "number" },
    requestHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    responseHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    requestHeaderCount: { type: "number", minimum: 0 },
    responseHeaderCount: { type: "number", minimum: 0 },
    streamRecovery: {
      type: "object",
      required: ["attemptId", "retryNumber", "maxRetries"],
      additionalProperties: false,
      properties: {
        attemptId: { type: "string", minLength: 1 },
        retryNumber: { type: "number", minimum: 1 },
        maxRetries: { type: "number", minimum: 0 },
        recoveredFromRequestId: { type: "string", minLength: 1 },
        anchorId: { type: "string", minLength: 1 },
      },
    },
    timeoutMs: { type: "number", minimum: 0 },
  },
} satisfies JsonSchema;

// Re-export for backwards compatibility with code using ToolCall
export type { ModelToolCall as ToolCall };

export * from "./content-protection.js";

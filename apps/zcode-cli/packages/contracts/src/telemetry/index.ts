import type { ModelRequestObservation, ModelId, ModelProviderId } from "../model/index.js";
import type {
  AgentExecutionTelemetryPort,
  AgentTelemetryAbandonReason,
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  AgentTelemetryOperation,
  AgentTelemetryScope,
} from "./agent-execution.js";

export * from "./agent-execution.js";

export const ModelApiOperation = {
  AgentStep: "agent_step",
  ContextCompaction: "context_compaction",
  GoalTitle: "goal_title_generation",
  GoalVerification: "goal_completion_verification",
  GitCommitMessage: "workspace_git_commit_message",
  ProjectMemoryExtract: "project_memory_extract",
  ProjectMemoryDream: "project_memory_dream",
  ProjectMemoryRecall: "project_memory_recall",
  SessionTitle: "session_title_generation",
  ToolInternalModelCall: "tool_internal_model_call",
  WebFetch: "web_fetch_processing",
  WebSearch: "web_search",
  WorkspaceGenerateText: "workspace_generate_text",
} as const;

export type ModelApiOperation = (typeof ModelApiOperation)[keyof typeof ModelApiOperation];

export function mapModelApiOperationToAgentOperation(
  operation: ModelApiOperation,
): AgentTelemetryOperation {
  return operation;
}

export const ModelApiActorKind = {
  MainAgent: "main",
  Subagent: "subagent",
  WorkflowChild: "workflow_child",
  System: "system",
  Tool: "tool",
} as const;

export type ModelApiActorKind = (typeof ModelApiActorKind)[keyof typeof ModelApiActorKind];
export type ModelApiCallCause = "initial" | "continuation" | "fallback_replacement" | "recovery";
export type ModelApiRuntimeSurface =
  | "standalone_cli"
  | "desktop_local_host"
  | "remote_workspace_host";
export type ModelApiErrorPhase =
  | "prepare"
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";
export const ModelFailureExceptionKind = {
  ApiCall: "api_call",
  Generic: "generic",
  Protocol: "protocol",
  ProviderBusiness: "provider_business",
  Transport: "transport",
  TypeError: "type_error",
  Validation: "validation",
} as const;
export type ModelFailureExceptionKind =
  (typeof ModelFailureExceptionKind)[keyof typeof ModelFailureExceptionKind];
export type ModelReasoningCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ModelReasoningState = "enabled" | "disabled" | "provider_default" | "unknown";
export type ModelReasoningControlType =
  | "fixed_level"
  | "fixed_budget"
  | "adaptive"
  | "toggle"
  | "provider_default"
  | "unknown";

/** 调用点只声明用户/业务请求的 reasoning 意图，Provider Adapter 决定最终事实。 */
export interface ModelReasoningCallHint {
  requestedLevel?: string;
  explicit?: {
    state: Exclude<ModelReasoningState, "unknown">;
    controlType?: Exclude<ModelReasoningControlType, "unknown">;
    effectiveLevel?: string;
    effectiveBudgetTokens?: number;
  };
}

/** 一次最终 Provider 请求的 canonical reasoning 事实。 */
export interface ModelReasoningObservation {
  capability: ModelReasoningCapabilityStatus;
  requestedState: ModelReasoningState;
  requestedControl: ModelReasoningControlType;
  requestedLevel?: string;
  requestedBudgetTokens?: number;
  effectiveState: ModelReasoningState;
  effectiveControl: ModelReasoningControlType;
  effectiveLevel?: string;
  effectiveBudgetTokens?: number;
}

/**
 * 受控调用专属事实。禁止 prompt、message、header、body、原始 URL、命令和工具 I/O。
 */
export interface ModelApiCustomAttributes {
  compactionOuterAttempt?: number;
  compactionTrigger?: string;
  streamRecoveryNumber?: number;
}

export interface ModelApiCallObservation {
  operation?: ModelApiOperation;
  actorKind?: ModelApiActorKind;
  operationId?: string;
  logicalCallId?: string;
  callCause?: ModelApiCallCause;
  previousLogicalCallId?: string;
  runtimeSurface?: ModelApiRuntimeSurface;
  agentName?: string;
  stepIndex?: number;
  reasoning?: ModelReasoningCallHint;
  attributes?: ModelApiCustomAttributes;
}

export type ResolvedModelApiCallObservation = Omit<ModelApiCallObservation, "reasoning"> & {
  logicalCallId: string;
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
  reasoning: ModelReasoningObservation;
};

export function resolveModelApiCallObservation(
  querySource: string | undefined,
  observation: ModelApiCallObservation | undefined,
): Required<Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">> &
  ModelApiCallObservation {
  const mapped = mapQuerySourceToModelApiOperation(querySource);
  return {
    ...mapped,
    ...observation,
    operation: observation?.operation ?? mapped.operation,
    actorKind: observation?.actorKind ?? mapped.actorKind,
    logicalCallId: observation?.logicalCallId?.trim() || crypto.randomUUID(),
  };
}

function mapQuerySourceToModelApiOperation(querySource: string | undefined): {
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
} {
  switch (querySource?.trim()) {
    case "main_turn":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.MainAgent };
    case "subagent":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.Subagent };
    case "workflow_child":
      return {
        operation: ModelApiOperation.AgentStep,
        actorKind: ModelApiActorKind.WorkflowChild,
      };
    case "compact":
      return {
        operation: ModelApiOperation.ContextCompaction,
        actorKind: ModelApiActorKind.System,
      };
    case "session_title":
      return {
        operation: ModelApiOperation.SessionTitle,
        actorKind: ModelApiActorKind.System,
      };
    case "goal_summary_title":
      return { operation: ModelApiOperation.GoalTitle, actorKind: ModelApiActorKind.System };
    case "target_completion_verification":
      return {
        operation: ModelApiOperation.GoalVerification,
        actorKind: ModelApiActorKind.System,
      };
    case "git_commit_message":
      return {
        operation: ModelApiOperation.GitCommitMessage,
        actorKind: ModelApiActorKind.System,
      };
    case "web_search_tool":
      return { operation: ModelApiOperation.WebSearch, actorKind: ModelApiActorKind.Tool };
    case "web_fetch_processing":
      return { operation: ModelApiOperation.WebFetch, actorKind: ModelApiActorKind.Tool };
    case "project_memory_extract":
      return {
        operation: ModelApiOperation.ProjectMemoryExtract,
        actorKind: ModelApiActorKind.System,
      };
    case "project_memory_dream":
      return {
        operation: ModelApiOperation.ProjectMemoryDream,
        actorKind: ModelApiActorKind.System,
      };
    case "project_memory_recall":
      return {
        operation: ModelApiOperation.ProjectMemoryRecall,
        actorKind: ModelApiActorKind.System,
      };
    default:
      return {
        operation: ModelApiOperation.ToolInternalModelCall,
        actorKind: ModelApiActorKind.System,
      };
  }
}

export interface ProviderEndpointIdentity {
  origin: string;
  route: string;
  sanitizerVersion: string;
}

export interface TelemetryIdentitySnapshot {
  identityState: "authenticated" | "anonymous" | "unknown";
  userSubjectId?: string;
}

export interface TelemetryResourceContext {
  buildCommitId?: string;
  cliVersion?: string;
  deploymentEnvironment?: string;
  installationId?: string;
  productVersion?: string;
  runtimeDistribution?: "source" | "development_bundle" | "packaged" | "unknown";
  runtimeSurface: ModelApiRuntimeSurface;
  serviceInstanceId: string;
  serviceName: string;
}

export type ModelApiOperationKind =
  | "messages"
  | "chat_completions"
  | "responses"
  | "generate_content"
  | "unknown";

export type ModelCallFailureStage =
  | "resolve_target"
  | "attempts"
  | "fallback"
  | "aggregate"
  | "unhandled";

export type ModelAttemptFailureStage =
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";

/** Provider/SDK 实际返回的有界结束原因，不在领域层折叠成 other。 */
export type ModelFinishReason = string;

export interface ResolvedModelTelemetryDescriptor {
  providerId: string;
  providerKind: string;
  providerOrigin?: string;
  providerRoute?: string;
  reasoning: ModelReasoningObservation;
  requestedModel: string;
}

export interface ResponseModelTelemetryDescriptor {
  model: string;
}

export type ModelCallTraceStart = {
  logicalCallId: string;
  modelRole?: string;
  operation: ModelApiOperation;
  requested: ResolvedModelTelemetryDescriptor;
  streaming: boolean;
} & (
  | {
      callCause: "initial";
      previousLogicalCallId?: never;
    }
  | {
      callCause: Exclude<ModelApiCallCause, "initial">;
      previousLogicalCallId: string;
    }
);

export type ModelAttemptTraceStart = {
  apiOperation: ModelApiOperationKind;
  attemptNumber: number;
  maxAttempts: number;
  requestId: string;
  target: ResolvedModelTelemetryDescriptor;
  transport: import("../model/index.js").ModelTransportKind;
} & (
  | {
      attemptCause: "initial";
      previousRequestId?: never;
      retryDelayMs?: never;
    }
  | {
      attemptCause: "retry" | "fallback";
      previousRequestId: string;
      retryDelayMs?: number;
    }
);

export interface ModelCallSpanWriter extends AgentTelemetryScope {
  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter;
  markFallbackSelected(reason: string): void;
  finishCompleted(): void;
  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  finishAbandoned(reason: AgentTelemetryAbandonReason): void;
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

export interface ModelAttemptSpanWriter extends AgentTelemetryScope {
  setProviderRequestId(requestId: string): void;
  setResponseModel(model: ResponseModelTelemetryDescriptor): void;
  setEffectiveReasoningState(state: ModelReasoningState): void;
  setEffectiveReasoningControl(control: ModelReasoningControlType): void;
  setEffectiveReasoningLevel(level: string): void;
  setEffectiveReasoningBudgetTokens(tokens: number): void;
  setFinishReason(reason: ModelFinishReason): void;
  setInputTokens(tokens: number): void;
  setOutputTokens(tokens: number): void;
  setReasoningTokens(tokens: number): void;
  setCacheReadTokens(tokens: number): void;
  setCacheWriteTokens(tokens: number): void;
  setStreamOutputCommitted(committed: boolean): void;
  setHttpStatusCode(statusCode: number): void;
  setProviderErrorCode(code: string): void;
  setProviderErrorMessage(message: string): void;
  setRetryAfterMs(delayMs: number): void;
  markFirstProviderEvent(): void;
  markFirstContent(): void;
  markFirstText(): void;
  markStreamStalled(idleMs: number): void;
  /** 请求观测交由发行实现映射到 Attribute 与 Event。 */
  recordRequestObservation(observation: ModelRequestObservation): void;
  finishCompleted(): void;
  finishFailed(
    stage: ModelAttemptFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  finishAbandoned(reason: AgentTelemetryAbandonReason): void;
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

export interface ModelExecutionTelemetryPort {
  startCall(input: ModelCallTraceStart): ModelCallSpanWriter;
}

/**
 * App 注入和 Standalone 初始化共用的进程级 Owner。一个 CLI 进程只能创建一个 Owner。
 */
export interface AgentTelemetryRuntimeOwner {
  readonly agentExecution: AgentExecutionTelemetryPort;
  readonly enabled: boolean;
  readonly modelExecution: ModelExecutionTelemetryPort;
  readonly statusSink?: import("../model/index.js").ModelStatusSink;
  abandonSession(sessionId: string): void;
  flush(options?: { timeoutMs?: number }): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  updateIdentity(snapshot: TelemetryIdentitySnapshot): void;
}

export interface ModelApiCallDescriptor {
  observation: Required<
    Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">
  > &
    ModelApiCallObservation;
  providerId: ModelProviderId;
  modelId: ModelId;
}

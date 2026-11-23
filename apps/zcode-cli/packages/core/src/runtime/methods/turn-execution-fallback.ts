import { committedToolSearchDelivery } from "./turn-output-token-continuation.js";
import {
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  ModelErrorCode,
  SessionEventType,
  TurnMachineImpl,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import type { ModelSelection } from "@zcode/contracts";
import { isModelContextExceededError, projectExecutionErrorPayload } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ModelExecutionContext } from "../types.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import { createTurnModel, sameModelSelection } from "./turn-model.js";

type SelectionFallbackDeclaration = NonNullable<ModelExecutionContext["selectionFallback"]>;

export interface ExecutionSelectionFallbackMatch {
  reason: SelectionFallbackDeclaration["rules"][number]["reason"];
  providerErrorCode?: string;
  statusCode?: number;
}

export interface ExecutionSelectionCreationFallbackMatch {
  reason: "highspeed_selection_unavailable";
}

export type ExecutionFallbackCandidateSource = "declared_target" | "session_selection";

export interface ExecutionFallbackCandidate {
  source: ExecutionFallbackCandidateSource;
  selection: ModelSelection;
}

export interface ExecutionSelectionFallbackResult {
  applied: boolean;
  settledAcceptedTools: boolean;
}

/**
 * 纯匹配：execution-scoped Selection 在请求发出前无法解析时，退回声明目标继续本轮。
 * Bug 根因：请求期退回只观察 adapter 归因；Provider/Model 从 Registry 消失会在 createTurnModel
 * 阶段先失败，永远到不了该边界。这里只接收明确的 Registry 解析错误，不能吞掉配置或请求构造错误。
 */
export function matchExecutionSelectionCreationFallback(input: {
  error: unknown;
  selection: ModelSelection | undefined;
  selectionFallback: ModelExecutionContext["selectionFallback"];
  selectionScope: ModelExecutionContext["selectionScope"] | undefined;
}): ExecutionSelectionCreationFallbackMatch | undefined {
  const fallback = input.selectionFallback;
  if (input.selectionScope !== "execution" || !input.selection || !fallback) return undefined;
  if (input.selection.providerId !== fallback.providerId) return undefined;
  const code =
    typeof input.error === "object" && input.error !== null && "code" in input.error
      ? (input.error as { code?: unknown }).code
      : undefined;
  if (code !== ModelErrorCode.ProviderNotFound && code !== ModelErrorCode.ModelNotFound) {
    return undefined;
  }
  return { reason: "highspeed_selection_unavailable" };
}

/**
 * 纯解析：退回目标候选按优先级排序（docs/highspeed/highspeed-card-spec.md §2.2）。
 * - 先取发起方声明的 `target`（抽卡时的提交选择，即会话原模型），再取 runtime 会话常驻 Selection。
 *   Bug 根因：退回目标曾只依赖会话常驻 Selection，而它只在 runtime 内存里——冷恢复落在 Registry
 *   刚就绪、账号权益未解析的窗口时校验失败不绑定，之后只发加速轮也不会再绑定，3402 时降级静默跳过、
 *   整轮失败弹错。发起方抽卡时明确知道原模型，由它声明目标后不再押注 runtime 状态。
 * - 候选不能是本轮 execution provider 本身：退回同一个失败端点只会再失败一次。
 * - 两个候选相同只保留一个，避免同一目标建模失败记两次。
 */
export function resolveExecutionFallbackCandidates(input: {
  declaredTarget: ModelSelection | undefined;
  executionProviderId: string;
  sessionSelection: ModelSelection | undefined;
}): ExecutionFallbackCandidate[] {
  const candidates: ExecutionFallbackCandidate[] = [];
  const seen = new Set<string>();
  const push = (
    source: ExecutionFallbackCandidateSource,
    selection: ModelSelection | undefined,
  ) => {
    if (!selection || selection.providerId === input.executionProviderId) return;
    const key = `${selection.providerId}/${selection.modelId}$${selection.options?.reasoningLevel ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ source, selection });
  };
  push("declared_target", input.declaredTarget);
  push("session_selection", input.sessionSelection);
  return candidates;
}

/**
 * 纯匹配：本次模型请求失败是否命中执行 Selection 的退回声明（docs/highspeed/highspeed-card-spec.md §2.2）。
 * - 只看本轮 step 实际使用的模型 provider 是否就是声明 provider；失败必须明确归因到该 provider/network 边界。
 * - 用户取消与上下文超窗不参与退回：取消按取消收口，超窗交给 reactive compact（退回同模型同窗口只会再超一次）。
 * - 规则按声明顺序匹配，缺省 providerErrorCode 的规则匹配任意上游请求失败；core 不自行解释 provider 错误码，
 *   也不按 provider id 前缀、模型名或错误文案硬编码。
 */
export function matchExecutionSelectionFallback(input: {
  error: unknown;
  executionProviderId: string;
  selectionFallback: ModelExecutionContext["selectionFallback"];
  turnAborted: boolean;
}): ExecutionSelectionFallbackMatch | undefined {
  const fallback = input.selectionFallback;
  if (!fallback || input.turnAborted) return undefined;
  if (input.executionProviderId !== fallback.providerId) return undefined;
  if (isModelContextExceededError(input.error)) return undefined;
  const attribution = projectExecutionErrorPayload(input.error).attribution;
  // Bug 根因：无错误码兜底规则过去也接收无归因异常，stream 事件落库失败会被误判成 provider
  // 请求失败并触发第二次模型请求。只有 adapter 明确归因到本轮 provider/network 边界的失败才能退回。
  if (
    (attribution?.source !== "provider" && attribution?.source !== "network") ||
    attribution.providerId !== fallback.providerId
  ) {
    return undefined;
  }
  const providerErrorCode = attribution.providerErrorCode;
  const rule = fallback.rules.find(
    (candidate) =>
      candidate.providerErrorCode === undefined ||
      candidate.providerErrorCode === providerErrorCode,
  );
  if (!rule) return undefined;
  return {
    reason: rule.reason,
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(attribution?.statusCode !== undefined ? { statusCode: attribution.statusCode } : {}),
  };
}

/**
 * 退回原模型继续本轮：保留已提交历史，只替换后续请求的模型，且只退一次。
 * 即使无处可退，也先返回已接受工具的 settlement 事实，让调用方保留原错误终止且不重复 abandon。
 */
export async function applyExecutionSelectionFallback(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    error: unknown;
    executionModel: Model;
    match: ExecutionSelectionFallbackMatch;
    modelTraceContext: TraceContext;
    streamingToolCoordinator: {
      settleForModelFallback(assistantCreatedAt: number): Promise<boolean>;
    };
  },
): Promise<ExecutionSelectionFallbackResult> {
  const executionModelSelection = {
    providerId: input.executionModel.providerId,
    modelId: input.executionModel.modelId,
  };
  const executionProviderId = String(executionModelSelection.providerId);
  const declaredTarget = state.selectionFallback?.target;
  // 后续输入可能已更新 Session；旧加速轮只能读取启动时固定的普通选择。
  const sessionSelection = state.highspeedFallbackSelection;
  // 退回请求走用户自己的常规鉴权，因此不再携带本次执行的 requestDependencies，重试预算也回到默认档。
  const candidates = resolveExecutionFallbackCandidates({
    declaredTarget,
    executionProviderId,
    sessionSelection,
  });
  const skippedCandidates: Array<{
    source: ExecutionFallbackCandidateSource;
    providerId: string;
    modelId: string;
    error: string;
  }> = [];
  let resolved: { candidate: ExecutionFallbackCandidate; model: Model } | undefined;
  for (const candidate of candidates) {
    try {
      // 目标在当前 Registry 不可解析（例如 provider 未发布）时建模会抛错：只跳到下一候选，
      // 不能让建模错误替换掉真实的加速失败原因。
      resolved = { candidate, model: createTurnModel(runtime, { selection: candidate.selection }) };
      break;
    } catch (error) {
      skippedCandidates.push({
        source: candidate.source,
        providerId: candidate.selection.providerId,
        modelId: candidate.selection.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failureAttribution = {
    ...(input.match.statusCode !== undefined ? { statusCode: input.match.statusCode } : {}),
    ...(input.match.providerErrorCode !== undefined
      ? { providerErrorCode: input.match.providerErrorCode }
      : {}),
    errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
  };
  // Bug 根因：旧实现把工具 settlement 放在目标解析成功之后；无目标时调用方又禁止同模型 recovery，
  // 最终只执行 abandon，导致真实结果丢失且 durable ToolPart 停在 pending/running。是否闭合已接受工具
  // 与是否能继续请求模型是两个决定，必须先由 coordinator 统一提交 live/durable/cold history。
  const settledAcceptedTools = await input.streamingToolCoordinator.settleForModelFallback(
    input.assistantCreatedAt,
  );
  if (!resolved) {
    // 无处可退只能让本轮按真实错误失败，但必须留痕：这个分支过去完全静默，用户只看到整轮失败的横幅，
    // 日志里无法区分「没降级」和「降级后原模型又失败」。
    runtime.logger?.warn(
      "Execution model request failed but no fallback target could be resolved",
      {
        ...traceContextToLogContext(input.modelTraceContext),
        event: "model.execution_selection.fallback_unavailable",
        module: "core.runtime",
        status: "failed",
        reason: input.match.reason,
        fromProviderId: executionProviderId,
        fromModelId: String(executionModelSelection.modelId),
        hasDeclaredTarget: declaredTarget !== undefined,
        hasSessionSelection: sessionSelection !== undefined,
        skippedCandidates,
        ...failureAttribution,
      },
    );
    // 没有 fallback 事件可供 Renderer 退卡，整轮错误的 code 又是 provider 错误码；把“已归因且无处可退”
    // 记在本轮状态上，TurnError 归因据此发布（spec §2.2 失败即退卡）。
    state.highspeedFallbackUnavailable = true;
    return { applied: false, settledAcceptedTools };
  }
  const fallbackSelection = resolved.candidate.selection;
  const fallbackModel = resolved.model;
  // 降级会掩盖加速端点的真实故障（例如少发 Coding Plan 头导致的 401），留一条带归因的 warn 让回归
  // 仍可从日志发现；只记录归因字段，不记录鉴权材料与请求体。
  runtime.logger?.warn("Execution model request failed; falling back to the original model", {
    ...traceContextToLogContext(input.modelTraceContext),
    event: "model.execution_selection.fallback",
    module: "core.runtime",
    status: "completed",
    reason: input.match.reason,
    fromProviderId: executionProviderId,
    fromModelId: String(executionModelSelection.modelId),
    toProviderId: fallbackSelection.providerId,
    toModelId: fallbackSelection.modelId,
    toSource: resolved.candidate.source,
    ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
    ...failureAttribution,
  });
  await runtime.persistAssistantMessage(
    input.assistantMessageId,
    state.userMessageId,
    input.assistantCreatedAt,
    {
      completed: Date.now(),
      toolSearchDelivery: committedToolSearchDelivery(state.turnRequestState),
      // Bug 根因：仅写 completed 会让进程在退回答案落盘前退出时，被冷恢复误判为成功。
      // 复用统一 discarded 契约，表示该 attempt 已作废但整个用户请求仍等待后续 assistant。
      error: {
        name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
        data: {
          message:
            "Execution-model output was discarded before continuing with the fallback model.",
        },
      },
      finish: STREAM_RECOVERY_DISCARDED_FINISH,
    },
    input.modelTraceContext,
    input.executionModel,
  );
  const fallbackEvent = runtime.createEvent(
    SessionEventType.TurnExecutionModelFallback,
    {
      ...(state.inputId ? { inputId: state.inputId } : {}),
      reason: input.match.reason,
      fromModelSelection: executionModelSelection,
      toModelSelection: {
        providerId: fallbackSelection.providerId,
        modelId: fallbackSelection.modelId,
      },
    },
    state.turnTraceContext,
  );
  await runtime.appendEvent(fallbackEvent, state.turnTraceContext);
  state.events.push(fallbackEvent);
  // 修复原因：Context Prefix 的 Harness 文案按请求模型的 mid-conversation system 能力生成；
  // 只换 state.model 时，退回请求仍带执行模型的文案，与实际的 reminder 通道不一致。
  const selectionChanged = !sameModelSelection(state.model, fallbackModel);
  state.model = fallbackModel;
  if (selectionChanged) {
    state.turnRequestState.entries = rebuildContextPrefix(runtime, {
      model: fallbackModel,
      turnRequestEntries: state.turnRequestState.entries,
    });
  }
  // 只降级一次：退回后的普通模型若再失败，必须让整轮按真实错误失败。
  state.selectionFallback = undefined;
  if (!settledAcceptedTools) {
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  }
  return { applied: true, settledAcceptedTools };
}

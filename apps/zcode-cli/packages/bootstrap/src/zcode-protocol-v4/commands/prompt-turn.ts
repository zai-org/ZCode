import { OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";
// 原生 prompt turn 运行器。
//
// Core admission 只负责接受输入并建立 session-scoped reservation；本文件不再拥有
// activeAbortController，也不等待 projection commit。这样 TurnStarted 之后的任意 Core
// starting/active 状态都会继续挡住同一 session 的第二次 start。
import {
  type ModelSelection,
  type TurnBackgroundAttribution,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import type { TurnAttachment } from "@zcode/core";
import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type { SendInputOptions, SendInputResult } from "../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../session-execution/index.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

/**
 * 所有会创建 Turn 的入口共用的模型准入结果码：Selection 不在当前 Worker Provider Registry。
 * V4 命令以 ACK reasonCode 透出；旧协议以 ProtocolRequestError.data.reasonCode 透出。
 */
export const MODEL_UNAVAILABLE_REASON_CODE = "modelUnavailable";

/** 旧协议与 restoreWarning 共用的稳定错误 code；Renderer 按它本地化，不展示 Registry 内部文案。 */
export const RUNTIME_MODEL_UNAVAILABLE_ERROR_CODE = "ZCODE_RUNTIME_MODEL_UNAVAILABLE";

type ModelCatalogRecord = Pick<V4SessionRecordView, "app">;

/**
 * 读取 Worker 当前 Registry 发布的模型目录；宿主不提供目录时返回 undefined，表示无法判定（放行给 Core）。
 */
export function listAvailableModelSelections(
  record: ModelCatalogRecord,
): readonly Pick<ModelSelection, "providerId" | "modelId">[] | undefined {
  if (typeof record.app.listModels !== "function") return undefined;
  return record.app.listModels().map((model) => model.ref);
}

export function isModelSelectionAvailable(
  selection: Pick<ModelSelection, "providerId" | "modelId"> | undefined,
  availableModels: readonly Pick<ModelSelection, "providerId" | "modelId">[],
): boolean {
  return (
    selection !== undefined &&
    availableModels.some(
      (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
    )
  );
}

/**
 * 唯一的模型准入判定：Selection 必须存在于当前 Worker Provider Registry。返回拒绝文案；可用或无法判定时返回 undefined。
 *
 * Bug 根因：体验套餐（Start Plan）到期、活动结束或切换账号后，账号 Provider 从 Registry 下架，
 * 但会话常驻选择仍指向它。此前只有 V4 sendText 在 ACK 前校验；旧协议 session/send、/compact、
 * /goal 续跑都依赖一个已退化为空实现的 ensureModelReady 钩子，输入被接纳后才在 Core 建模阶段
 * 抛出 "Provider Registry 中不存在 Provider: account:bigmodel-start-plan" 并以 TurnError 结束，
 * 用户看到的是 Registry 内部文案而不是"请重新选择模型"。所有入口改为共用这一份判定，
 * 以稳定的 reasonCode 在接纳前拒绝；这里不自动改写会话模型，重选由用户完成。
 */
export function resolveModelUnavailableMessage(
  record: ModelCatalogRecord,
  selection: Pick<ModelSelection, "providerId" | "modelId"> | undefined,
): string | undefined {
  if (!selection) return undefined;
  const availableModels = listAvailableModelSelections(record);
  if (!availableModels || isModelSelectionAvailable(selection, availableModels)) return undefined;
  return `Provider Registry 中不存在 Model: ${selection.providerId}/${selection.modelId}`;
}

export interface TurnModelAdmissionInput {
  selection: Pick<ModelSelection, "providerId" | "modelId"> | undefined;
  modelExecution?: Pick<
    NonNullable<SendInputOptions["modelExecution"]>,
    "selectionScope" | "selectionFallback"
  >;
  /** 排队输入的 execution 只在提升边界应用，准入阶段一律按普通 Selection 预检。 */
  requireQueue?: boolean;
}

/**
 * 一次 Turn 的完整模型准入裁决（V4 sendText 与旧协议 session/send 共用）。
 * 带同 Provider 退回声明的 execution Selection 允许加速模型临时缺失，交给 Core 做创建期退回，
 * 只有执行模型和退回目标都缺失时才拒绝；其余 Selection 必须在 Registry 中。
 */
export function resolveTurnModelAdmissionMessage(
  record: ModelCatalogRecord,
  input: TurnModelAdmissionInput,
): string | undefined {
  const { selection, modelExecution, requireQueue } = input;
  const selectionFallback = modelExecution?.selectionFallback;
  const defersSelectionValidationToCore =
    modelExecution?.selectionScope === "execution" &&
    !requireQueue &&
    selection !== undefined &&
    selectionFallback !== undefined &&
    selectionFallback.providerId === selection.providerId;
  if (!defersSelectionValidationToCore) return resolveModelUnavailableMessage(record, selection);
  const availableModels = listAvailableModelSelections(record);
  if (!availableModels) return undefined;
  const fallbackTarget = selectionFallback?.target;
  if (
    isModelSelectionAvailable(selection, availableModels) ||
    isModelSelectionAvailable(fallbackTarget, availableModels)
  ) {
    return undefined;
  }
  // Bug 根因：准入曾强制要求退回目标存在，即使 Highspeed 执行模型仍可用也拒绝编辑；
  // 正确门禁是至少保留一条可创建路径，只有执行模型和退回目标都缺失时才拒绝。
  const requestedLabel = selection ? `${selection.providerId}/${selection.modelId}` : "未声明";
  const fallbackLabel = fallbackTarget
    ? `${fallbackTarget.providerId}/${fallbackTarget.modelId}`
    : "未声明";
  return `Provider Registry 中不存在执行 Model (${requestedLabel}) 或退回目标 Model (${fallbackLabel})`;
}

export interface StartPromptTurnParamsBase {
  content: string;
  /** v4 锚点：inputId=queryId=commandId（权威数据 sourceCommandId 对账）。 */
  inputId: string;
  /** 附件命令面：AttachmentRef 已在 handler 层映射为 core TurnAttachment。 */
  attachments?: TurnAttachment[];
  browserAmbientContext?: SendInputOptions["browserAmbientContext"];
  intent?: TurnInputIntentMetadata;
  /** 标准 Selection 的单次执行约束；不会改写 Session Selection。 */
  modelExecution?: SendInputOptions["modelExecution"];
  sharedContextRefs?: SendInputOptions["sharedContextRefs"];
  toolDisallowlist?: readonly string[];
  /** 当前输入必须保留为未来独立 turn，不能因 admission 瞬间转为空闲而直接启动。 */
  requireQueue?: boolean;
  /** sendQueuedNow 已持有 Core promotion lease，要求这次 admission 只能占用空闲位。 */
  requireIdle?: boolean;
  /** Bot 入站 turn 的稳定回推地址；仅在本 turn 内暴露给 CronCreate。 */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type StartPromptTurnParams = StartPromptTurnParamsBase & TurnBackgroundAttribution;

export interface PromptTurnStartResult {
  /** Core admission 已完成；不等待 TurnStarted 或 projection commit。 */
  turnStarted: Promise<void>;
  /** Core 真实完成 promise，仅供生命周期清理使用，不属于 ACK 边界。 */
  completion?: Promise<unknown>;
  admission: SendInputResult;
  /** 兼容旧调用方；初始 ACK 不再依赖 messageId。 */
  messageId?: string;
}

export class V4PromptRejectedError extends Error {
  readonly turnStartUncertain = false;

  constructor(
    readonly reasonCode: "restoreWarning" | "activePrompt" | typeof MODEL_UNAVAILABLE_REASON_CODE,
    message: string,
  ) {
    super(message);
    this.name = "V4PromptRejectedError";
  }
}

/** 旧 queue promotion 兼容谓词：新的 Core admission 不再产生 projection authority 不确定态。 */
export function isPromptTurnStartUncertainFailure(_error: unknown): boolean {
  return false;
}

/**
 * 只执行 prompt 的模型准入检查，不接纳输入或修改 turn 生命周期。
 * edit/retry 在提交 branch cut 前复用此入口，避免破坏性操作与普通发送使用两套目录规则。
 */
export async function preflightPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<void> {
  // 排队输入的 execution 只在提升边界应用，准入阶段一律按普通 Selection 预检，供卡失效后提升。
  const usesExecutionSelection =
    params.modelExecution?.selectionScope === "execution" && !params.requireQueue;
  if (!usesExecutionSelection && record.restoreWarning) {
    // app 重启后冷恢复可能跑在 provider registry 推送
    // 之前，record 创建时判「模型不可解析」挂上告警；registry 随后到达时 runtime
    // 早已可服务，但这个一次性标志没人回来清——发送被永久拒（用户只能手动切模型
    // 解锁）。闸前经宿主能力重评：已有可用目标则清除过期告警，随后仍由下方同一份
    // 模型准入校验当前选择；不能在这里兜底换模型或清空持久选择。
    // 仍无可用模型/宿主不支持 → 维持拒绝。
    if (host.hasUsableRuntimeModelTarget?.(record) === true) {
      host.logger?.info?.("v4 restoreWarning cleared by model catalog recovery", {
        sessionId: record.app.sessionId,
        warningType: record.restoreWarning.type,
      });
      record.restoreWarning = undefined;
    }
  }
  if (!usesExecutionSelection && record.restoreWarning) {
    throw new V4PromptRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // 普通 Selection 必须在 ACK 前拒绝，避免后台创建 Model 失败后静默丢输入。
  // Bug 原因：这里曾把带声明式退回的 execution Selection 也按普通 Selection 拒绝，
  // 导致 Highspeed 的 Provider/Model 缺失在 Core 执行 fallback 前直接失败。只有非排队、
  // 且退回声明与执行 Provider 一致时，才把解析延迟到 Core；compact、goal、旧协议
  // session/send 与这里共用同一份裁决。
  const unavailable = resolveTurnModelAdmissionMessage(record, {
    selection: params.intent?.modelSelection,
    modelExecution: params.modelExecution,
    requireQueue: params.requireQueue,
  });
  if (unavailable) throw new V4PromptRejectedError(MODEL_UNAVAILABLE_REASON_CODE, unavailable);
}

/**
 * 入口只做模型/持久化前置校验，然后调用 app -> Core admission。Core 返回 started 时，
 * 后台生命周期等待 completion 清理 turn 归因和广播状态；RPC 本身立即返回 admission receipt。
 */
export async function startPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  await preflightPromptTurn(host, record, params);
  return startPromptTurnAfterPreflight(host, record, params);
}

/**
 * destructive edit/retry 已在 branch cut 前完成同一份准入检查；提交后必须直接消费该结果。
 * Bug 根因：再次读取可变 Registry 会在历史已截断后拒绝 replacement input。
 */
export async function startPreflightedPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  return startPromptTurnAfterPreflight(host, record, params);
}

async function startPromptTurnAfterPreflight(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  if (record.persistence === "deferred") record.persistence = "immediate";

  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolveTurnAutomationId(params);
  const activeOffPeakTaskId = resolveTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) record.activeAutomationId = activeAutomationId;
  if (activeOffPeakTaskId) {
    // 闲时派发轮同型标记，供 offpeak-port 在工具执行前拒绝递归 OffPeakCreate。
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;

  let admission: SendInputResult;
  try {
    admission = await record.app.sendInput(
      {
        text: params.content,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      {
        // Bootstrap controller 曾经被当成 Core busy 真相，并由 projection watchdog
        // 清理它；现在 Core admission 自己持有 reservation，Stop 也直接调用 Core execution。
        delivery: "start_turn",
        ...(params.intent?.requestedDelivery === "guide"
          ? { queueDelivery: "guide" as const }
          : {}),
        ...(params.browserAmbientContext
          ? { browserAmbientContext: params.browserAmbientContext }
          : {}),
        inputId: params.inputId,
        ...turnBackgroundAttributionOf({
          automationId: activeAutomationId,
          // 归因用解析后的 id：resume 段仅靠 inputId 前缀兜底时也要进 core loop state。
          offPeakTaskId: activeOffPeakTaskId,
          offPeakRunType: params.offPeakRunType,
        }),
        intent: params.intent,
        ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
        ...(params.sharedContextRefs ? { sharedContextRefs: params.sharedContextRefs } : {}),
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
        ...(params.requireQueue ? { requireQueue: true } : {}),
        ...(params.requireIdle ? { requireIdle: true } : {}),
        queryId: params.inputId as SendInputOptions["queryId"],
      },
    );
  } catch (error) {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    await host.afterLegacyStateMutation?.(record, "prompt_failed");
    throw error;
  }

  if (admission.kind === "rejected") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    throw new V4PromptRejectedError(
      "activePrompt",
      `Core prompt admission rejected: ${admission.reason}`,
    );
  }

  if (admission.kind === "queued") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    return { admission, turnStarted: Promise.resolve() };
  }

  const completion = runWithSessionResidencyFinalization(record, async () => {
    let mutationReason = "prompt_completed";
    try {
      await admission.completion;
    } catch (error) {
      mutationReason = "prompt_failed";
      host.logger?.warn?.("v4 background turn failed", {
        error: error instanceof Error ? error.message : String(error),
        inputId: params.inputId,
        sessionId: record.app.sessionId,
      });
    } finally {
      clearPromptRecordState(
        record,
        previousAutomationId,
        previousOffPeakTaskId,
        previousBotDeliveryTarget,
      );
      await host.afterLegacyStateMutation?.(record, mutationReason);
    }
  });
  void completion.catch(() => undefined);
  host.logger?.info?.("v4 prompt admitted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
  });
  return { admission, completion, turnStarted: Promise.resolve() };
}

function clearPromptRecordState(
  record: V4SessionRecordView,
  previousAutomationId: string | undefined,
  previousOffPeakTaskId: string | undefined,
  previousBotDeliveryTarget: V4SessionRecordView["activeBotDeliveryTarget"],
): void {
  record.activeAutomationId = previousAutomationId;
  // 闲时轮身份与 automation 同规则随 turn 还原，防止跨轮残留误拒 OffPeakCreate。
  record.activeOffPeakTaskId = previousOffPeakTaskId;
  record.activeBotDeliveryTarget = previousBotDeliveryTarget;
}

export function buildTurnToolDisallowlist(
  params: Pick<StartPromptTurnParams, "automationId" | "offPeakTaskId" | "toolDisallowlist">,
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDisallowlist ?? []);
  if (activeAutomationId) {
    // Host 显式注入 automation 身份后，后续 model step 不能重新暴露 Cron 写工具。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  if (activeOffPeakTaskId) {
    // 闲时派发轮隐藏 OffPeakCreate（防递归自我派生）；OffPeakList 只读保留。
    // automation 轮不加此项——cron 轮放行 OffPeakCreate（定时派生闲时任务）。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

export function resolveTurnAutomationId(
  params: Pick<StartPromptTurnParams, "automationId">,
): string | undefined {
  // Bug 原因：commandId/inputId 可由调用方指定，追踪字段不能提升为 CronPauseSelf 的授权身份。
  return params.automationId?.trim() || undefined;
}

export function resolveTurnOffPeakTaskId(
  params: Pick<StartPromptTurnParams, "offPeakTaskId" | "inputId">,
): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // 兜底：续跑派发的 inputId 形如 `offpeak-<uuid>:resume:<uuid>`；首段派发无固定前缀，
  // 主信号必须是显式 offPeakTaskId（host 派发一律显式传）。
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(OFF_PEAK_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > OFF_PEAK_INPUT_ID_PREFIX.length ? offPeakTaskId : undefined;
}

export function turnBackgroundAttributionOf(params: {
  automationId?: string;
  offPeakTaskId?: string;
  offPeakRunType?: "init" | "resume";
}): TurnBackgroundAttribution {
  if (params.automationId) return { automationId: params.automationId };
  if (params.offPeakTaskId) {
    return {
      offPeakTaskId: params.offPeakTaskId,
      ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
    };
  }
  return {};
}

const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES（cron 轮放行 OffPeakCreate）。
// 与 core turn-loop-state 同值——闲时轮同时隐藏 SendMessage / Workflow（两者会在本轮
// modelExecution 之外重启子 Agent）。
const OFF_PEAK_INPUT_ID_PREFIX = "offpeak-";
const OFF_PEAK_MUTATION_TOOL_NAMES = OFF_PEAK_EXECUTION_TOOL_DENYLIST;

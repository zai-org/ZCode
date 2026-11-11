// goal/compact 命令组：compact / sendGoalCommand / pauseGoal / resumeGoal。
// 语义自旧 server-operations compactSession/goalSession/continueGoalAfterChange 搬运，
// 决策逻辑（compact 去重 / active turn barrier / goal 续跑）直驱 core，不经旧协议 op。
//
// 与旧协议路径的映射（保真基线）：
// - compactSession（server-operations.ts:1805）→ compact
// - goalSession action:"set"（:1919，含重复 set 收敛 replace）→ sendGoalCommand
// - goalSession action:"resume"（:1980）→ resumeGoal
// - continueGoalAfterChange / runGoalContinuationInBackground（:2204-2269）→ 组内私有共用函数
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { SteerTurnOptions, SubmitPromptOptions } from "../../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../../session-execution/index.js";
import { inputIntentMetadata } from "../input-intent.js";
import { MODEL_UNAVAILABLE_REASON_CODE, resolveModelUnavailableMessage } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  applyHeldQueueDisposition,
  enqueueDeferredInputForBusyWork,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";

/** goal/compact 组的裁决拒绝（gateway 捕获后进 ACK failed，message 透传给客户端）。 */
export class V4GoalCompactRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "activeTurn"
      | "compactOperationLock"
      | "restoreWarning"
      | "guard.planGoalMutuallyExclusive"
      | "emptyObjective"
      | typeof MODEL_UNAVAILABLE_REASON_CODE,
    message: string,
  ) {
    super(message);
    this.name = "V4GoalCompactRejectedError";
  }
}

// 手动 compact 在后台 turn 真正登记前，下一条 command 已可能完成 admission。
// 仅看 runtime activeTurn 会留下一个极短的重复 compact 窗口；controller WeakSet 只补齐
// operation lock 的同步边界，不复制 queue 或 lifecycle 业务状态。
const manualCompactControllers = new WeakSet<AbortController>();

/**
 * compact：手动上下文压缩，模型选择固定在命令接收边界，无 instructions 变体。
 *
 * barrier 语义：
 * 1. running/goal verifier/goal continuation/tool work → typed compact intent 入 FIFO。
 * 2. held queue → 追加队尾，不绕过既有 future intent。
 * 3. running 或 queued compact 已存在 → compactOperationLock，禁止重复压缩。
 */
async function compact(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  const activeController = record.activeAbortController;
  if (
    activeTurn?.kind === "compact" ||
    (activeController ? manualCompactControllers.has(activeController) : false) ||
    host.hasQueueItemKind?.(record.app.sessionId, "compact")
  ) {
    host.logger?.info?.("v4 compact already running or queued, rejected", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
    throw new V4GoalCompactRejectedError(
      "compactOperationLock",
      "Compact is already running or queued",
    );
  }
  if (record.restoreWarning) {
    // 与 prompt-turn 相同的闸门：恢复失败的会话不能静默续写（含 compact turn）。
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }

  // 旧 compact 没有携带选择，导致菜单 B 被忽略；旧客户端也在此固定会话选择，
  // 不能等模型就绪或排队结束后再读可变 Session。只取模型，不消费草稿模式/Plan。
  const payload = envelope.payload as CommandPayloadMap["compact"];
  const modelSelection = structuredClone(
    resolveSubmittedExecutionState(record, payload).modelSelection,
  );
  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  const busy = Boolean(record.activeAbortController) || Boolean(activeTurn);
  if (busy || routingMode === "enqueue" || routingMode === "guide" || routingMode === "choice") {
    const intent = inputIntentMetadata(envelope, {
      requestedDelivery: "queue",
      text: "/compact",
      modelSelection,
    });
    const queueOptions = {
      commandKind: "compact" as const,
      inputId: envelope.commandId,
      intent,
      queryId: envelope.commandId as NonNullable<SteerTurnOptions["queryId"]>,
    };
    if (await enqueueDeferredInputForBusyWork(record, "/compact", queueOptions)) {
      return undefined;
    }
    const queued = await record.app.steerTurn("/compact", {
      ...queueOptions,
      delivery: "queue",
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `compact input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }

  await startManualCompact(host, record, {
    inputId: envelope.commandId,
    intent: inputIntentMetadata(envelope, {
      requestedDelivery: "startNow",
      text: "/compact",
      modelSelection,
    }),
  });
  return undefined;
}

/** queue promotion 与直接命令共用唯一手动 compact 启动路径。 */
export async function startManualCompact(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    inputId: string;
    intent: NonNullable<SubmitPromptOptions["intent"]>;
    foregroundPromotionLeaseId?: string;
  },
): Promise<void> {
  if (record.restoreWarning) {
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // 冷恢复后用户可能直接触发 /compact（不先经 sendText），排队的 compact 提升时也不再经过
  // sendText 的 preflight；与 sendText 共用同一份模型准入，模型不在 Registry 时在接纳前拒绝，
  // 不让 Core 建模失败后以 Registry 内部文案结束 compact。
  rejectUnavailableModel(record, params.intent.modelSelection);
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过
  // record.activeAbortController 中断。不登记 controller，压缩中的请求会跑到自然结束。
  record.activeAbortController = abortController;
  manualCompactControllers.add(abortController);
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(host, record, {
      ...params,
      abortController,
    }),
  ).catch(() => {
    // 后台 compact 的错误经事件流（CompactStarted/终态 marker）降级上报；兜底防 unhandled rejection。
  });
}

async function runCompactTurnInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent: NonNullable<SubmitPromptOptions["intent"]>;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  let lifecycleStatus: "success" | "failed" | "cancelled" = "success";
  host.logger?.info?.("v4 background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt("/compact", {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
    });
  } catch (error) {
    lifecycleStatus = params.abortController.signal.aborted ? "cancelled" : "failed";
    mutationReason =
      lifecycleStatus === "cancelled" ? "session_compact_cancelled" : "session_compact_failed";
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // queued compact 是 FIFO barrier；失败/Stop 后若继续 auto-drain，
        // 后续文本会越过用户显式维护意图。与普通 Stop 一致切为 held。
        await record.app.setQueueAutoDrain(false);
      } catch (holdError) {
        host.logger?.warn?.("v4 compact failed to hold following queue", {
          error: holdError instanceof Error ? holdError.message : String(holdError),
          inputId: params.inputId,
          sessionId: record.app.sessionId,
        });
      }
    }
    host.logger?.warn?.("v4 background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    manualCompactControllers.delete(params.abortController);
    if (record.activeAbortController === params.abortController) {
      // ready 边界（关键约束）：compact 结束后必须先释放 active lock 再广播；
      // 否则 queued prompt 或后续 /compact 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  try {
    // compact 没有 user message，不能依赖 SessionInputPromoted 解 pin；无论 lifecycle
    // 成功/失败/取消，都用 timeline command fact 阻止重启后把已执行命令再次提示重放。
    await host.recordPersistentCommandFact?.(
      record.app.sessionId,
      "timeline",
      {
        commandId: params.inputId,
        status: "accepted",
        revisionAtDecision: 0,
      },
      { lifecycleStatus },
    );
  } catch (error) {
    // compact 已执行，不能因查重旁路写失败伪装为模型执行失败。
    host.logger?.warn?.("v4 compact persistent command fact failed", {
      commandId: params.inputId,
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
  }
  // 旧协议路径在此调 afterStateMutation → 用钩子等价替代（随旧广播删除）。
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

/**
 * sendGoalCommand：设置/更新 goal（旧 goalSession action:"set"）。
 *
 * barrier 语义（自旧协议路径保真 + v4 队列补齐）：
 * 1. active turn → 入队为 sendGoalCommand：/goal 是目标状态写入，不是普通 prompt；
 *    运行中不能直接改 target，但也不能丢弃。队列项必须保留命令身份，等 ready 边界执行。
 * 2. 重复 set 收敛 replace 语义（关键约束）：输入框里的 `/goal 新目标` 是用户
 *    显式提交的新目标；已有目标时继续要求 replace 会让用户以为目标已变更但数据库仍保留
 *    旧目标。这里读到已有 target 就按替换路径处理（差异只体现在广播 reason）。
 */
async function sendGoalCommand(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendGoalCommand"];
  const record = requireRecord(host, envelope.sessionId);
  const objective = payload.text.trim();
  if (objective.length === 0) {
    throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
  }
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  if (submittedExecutionState.planEnabled) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(envelope, { ...options, ...submittedExecutionState });
  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (record.activeAbortController || routingMode === "enqueue" || routingMode === "guide") {
    // /goal 是目标控制命令，active turn 中不能直接写 target；
    // 但产品语义要求 running/compacting/goal verifier 可入队。busy projection 可能
    // 早于 controller 登记，因此同时消费 inputRouting；commandKind 保住控制命令身份，
    // 后续消费时走 sendGoalCommand，而不是普通 user prompt。
    const queuedText = goalCommandQueueText(payload.displayText, objective);
    if (
      await enqueueDeferredInputForBusyWork(record, queuedText, {
        commandKind: "sendGoalCommand",
        inputId: envelope.commandId,
        queryId: envelope.commandId as SteerTurnOptions["queryId"],
        intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
      })
    ) {
      return undefined;
    }
    const queued = await record.app.steerTurn(queuedText, {
      commandKind: "sendGoalCommand",
      inputId: envelope.commandId,
      queryId: envelope.commandId as SteerTurnOptions["queryId"],
      intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `goal input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }
  await applyGoalCommand(host, record, {
    displayText: goalCommandQueueText(payload.displayText, objective),
    heldQueueDisposition: payload.heldQueueDisposition,
    expectedHeldQueueItemIds: payload.expectedHeldQueueItemIds,
    inputId: envelope.commandId,
    objective,
    intent: submissionIntent({ requestedDelivery: "startNow", text: objective }),
  });
  return undefined;
}

export async function applyGoalCommand(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    displayText?: string;
    heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
    expectedHeldQueueItemIds?: readonly string[];
    inputId: string;
    objective: string;
    foregroundPromotionLeaseId?: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  // 目标写入后会立刻后台续跑；模型准入必须先于 held queue 裁决与 setTarget，避免先改目标再拒绝。
  rejectUnavailableModel(
    record,
    params.intent?.modelSelection ?? record.app.runtime?.getSessionModelSelection?.(),
  );
  // held choice 裁决（同 sendText；sendGoalCommand）。
  await applyHeldQueueDisposition(
    host,
    record,
    params.heldQueueDisposition,
    params.expectedHeldQueueItemIds,
  );
  const replacesExistingGoal = Boolean(await record.app.readTarget());
  // Goal 的提交也已冻结执行状态；先关闭本次明确取消的 Plan，不能按旧 Runtime 状态拦住续跑。
  if (params.intent?.planEnabled !== undefined) {
    if (params.intent.planEnabled)
      throw new V4GoalCompactRejectedError(
        "guard.planGoalMutuallyExclusive",
        "Plan and Goal cannot be active at the same time.",
      );
    await record.app.runtime.setExecutionState(
      { mode: params.intent.mode, planEnabled: false },
      record.traceContext,
    );
  }
  await record.app.setTarget({
    ...(params.displayText ? { displayText: params.displayText } : {}),
    objective: params.objective,
    status: "active",
    ...(params.intent ? { intent: params.intent } : {}),
  });
  await continueGoalAfterChange(host, record, {
    foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
    inputId: params.inputId,
    intent: params.intent,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
  });
}

export function parseGoalObjectiveFromCommandText(text: string): string {
  const trimmed = text.trim();
  const match = /^\/(?:goal|target)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return trimmed;
  const args = match[1]?.trim() ?? "";
  return args.replace(/^replace\s+/i, "").trim();
}

function goalCommandQueueText(displayText: string | undefined, objective: string): string {
  const trimmed = displayText?.trim();
  return trimmed ? trimmed : `/goal ${objective}`;
}

/**
 * pauseGoal：独立 target 控制，不复用通用 stop 的 queue hold/disposition。
 * 旧 V4 只有 stop，导致没有 active controller 时无法暂停目标，也让 UI 无法
 * 准确表达“暂停目标”与“终止本轮”的差别。先结算 target active run，再终止当前 goal work。
 */
async function pauseGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return undefined;
  }

  const activeController = record.activeAbortController;
  const paused = await record.app.updateTargetStatus("paused");
  if (!paused) return undefined;

  activeController?.abort(new Error("v4 goal paused"));
  await host.afterLegacyStateMutation?.(record, "goal_paused");
  return undefined;
}

/**
 * resumeGoal：paused → active（stopPausesActiveGoalTarget 的逆操作）。
 * 无 target → 幂等成功（旧协议路径返回 "No goal to resume." 且不改状态，不抛错）。
 */
async function resumeGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.activeAbortController) {
    // 同 sendGoalCommand：resume 属旧 goalSession 的非 pause 动作，运行中拒绝。
    throw new V4GoalCompactRejectedError(
      "activeTurn",
      "Cannot manage goals while a prompt is running",
    );
  }
  // 只跳过续跑仍会留下 active Goal + Plan；恢复目标前就检查，不能先写入再拒绝。
  const planEnabled = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  if (planEnabled && (await record.app.readTarget())) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  // 恢复目标后会用会话常驻模型续跑；同样先于状态写入做模型准入。
  rejectUnavailableModel(record, record.app.runtime?.getSessionModelSelection?.());
  const target = await record.app.updateTargetStatus("active");
  if (!target) {
    host.logger?.info?.("v4 resumeGoal without target, noop", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
  await continueGoalAfterChange(host, record, {
    inputId: envelope.commandId,
    reason: "goal_resumed",
  });
  return undefined;
}

/** goal/compact 组内统一的模型准入拒绝；判定本体在 prompt-turn 的模型准入，与 sendText 完全一致。 */
function rejectUnavailableModel(
  record: V4SessionRecordView,
  selection: Parameters<typeof resolveModelUnavailableMessage>[1],
): void {
  const message = resolveModelUnavailableMessage(record, selection);
  if (message) throw new V4GoalCompactRejectedError(MODEL_UNAVAILABLE_REASON_CODE, message);
}

/**
 * goal 变更后的续跑（旧 continueGoalAfterChange 搬运，set/resume 两处共用）：
 * plan 模式或已有 active turn 时不续跑（只落库目标，用户后续显式推进）；
 * 否则上锁 → 后台 continueActiveTarget。模型准入已在目标写入前完成。
 */
async function continueGoalAfterChange(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
    reason: string;
  },
): Promise<void> {
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;
  if (canContinue) {
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(host, record, {
        abortController,
        foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
        inputId: params.inputId,
        intent: params.intent,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败经事件流降级上报；兜底防 unhandled rejection。
    });
  }
  // 旧协议路径在续跑起跑后立即 afterStateMutation(goal_set/goal_replaced/goal_resumed)
  // → 钩子等价替代；v4 投影经 TargetChanged 事件自然收口。
  await host.afterLegacyStateMutation?.(record, params.reason);
}

async function runGoalContinuationInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
      queryId: params.inputId as SubmitPromptOptions["queryId"],
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    if (record.activeAbortController === params.abortController) {
      // 续跑结束后应立刻释放活跃锁；广播只是后续动作，
      // 如果继续占锁，连续 /goal 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

export const goalCompactHandlers = { compact, pauseGoal, resumeGoal, sendGoalCommand };

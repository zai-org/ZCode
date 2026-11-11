import { normalizeGenUiInput } from "@zcode/core";
// 会话流命令组：sendText / stop（模式样板）。
// 每个命令组一个文件：handler 纯函数 (host, envelope) → CommandResult|undefined，
// 决策逻辑直驱 core，环境能力走 host 钩子（见 ../types.ts 的过渡标注）。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../session-execution/index.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import {
  applyHeldQueueDisposition,
  hasPromptInput,
  resolveOrdinaryQueueModelSelection,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";
import { inputIntentMetadata } from "../input-intent.js";
import {
  resolveTurnAutomationId,
  startPromptTurn,
  turnBackgroundAttributionOf,
  V4PromptRejectedError,
} from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView, V4TurnExecution } from "../types.js";
import { V4CommandNoopError } from "../../v4-gateway.js";

/** 等 idle 轮询参数：25ms 间隔、5s 超时。 */
const IDLE_POLL_INTERVAL_MS = 25;
const IDLE_POLL_TIMEOUT_MS = 5_000;
const HIGHSPEED_QUEUE_FALLBACK_REASON = "highspeed.requiresQueue";

/** 等 idle 超时（active turn 的 finally 5s 内未释放锁）→ 放弃重发并报错。 */
export class V4SessionIdleTimeoutError extends Error {
  constructor(sessionId: string) {
    super(`v4 timed out waiting for session idle: ${sessionId}`);
    this.name = "V4SessionIdleTimeoutError";
  }
}

/**
 * sendText：只做协议/held/model/附件校验，start/queue 交给同一 session 的 Core admission。
 * held（choice）时仍按 heldQueueDisposition 裁决。
 */
async function sendText(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const originalPayload = envelope.payload as CommandPayloadMap["sendText"];
  const rawPayload = {
    ...originalPayload,
    ...normalizeGenUiInput(originalPayload.text, originalPayload.genUiContext),
  };
  const record = requireRecord(host, envelope.sessionId);
  // Bug 根因：旧校验只看正文，UI 已允许的 attachment-only query 会在 CLI 被误判为空。
  if (
    !hasPromptInput(rawPayload.text, rawPayload.attachments) &&
    !rawPayload.conversationQuotes?.length
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const activeAutomationId = resolveTurnAutomationId({
    automationId: rawPayload.automationId,
  });
  // Bug 根因：Highspeed admission 与 automation 派发来自不同上游；契约漂移时可能把
  // automationId、highspeedMeta 和加速执行材料同时送到同一轮。定时执行身份必须优先：
  // 既不能拿加速卡凭据发请求，也不能把普通模型输出持久化成 Highspeed 消息。
  const dropsHighspeed =
    activeAutomationId !== undefined &&
    (rawPayload.highspeedMeta !== undefined ||
      isHighspeedProviderId(rawPayload.modelSelection?.providerId));
  const payload: CommandPayloadMap["sendText"] = dropsHighspeed
    ? {
        ...rawPayload,
        highspeedMeta: undefined,
        modelSelection: undefined,
        modelExecution: undefined,
      }
    : rawPayload;
  // canonical intent 必须和 admission 看同一份净荷，否则 transcript 会留下没有凭据的加速标记。
  const intentEnvelope = { ...envelope, payload } as CommandEnvelope;
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, payload.attachments);
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(intentEnvelope, {
      ...options,
      ...submittedExecutionState,
      genUiContext: payload.genUiContext,
    });
  const routingMode = host.getInputRoutingMode?.(envelope.sessionId ?? "") ?? null;
  const forceStartNow = payload.requestedDelivery === "startNow";
  // 队首被 composer 编辑态冻结时 Core 可能完全空闲；不强制入队会 startNow 越过冻结项。
  const queueHeadEditLocked =
    !forceStartNow &&
    routingMode === "enqueue" &&
    host.isQueueHeadEditLocked?.(record.app.sessionId) === true;
  // 加速本轮由「标准 Selection 指向加速 Provider + 单次执行材料」表达；判定必须用 Family
  // 谓词，不能和单个 provider id 常量比较，否则 BigModel 账号的卡会被当成普通轮静默丢弃。
  const highspeedExecution: V4TurnExecution | undefined = isHighspeedProviderId(
    payload.modelSelection?.providerId,
  )
    ? payload.modelExecution
    : undefined;
  const highspeedActiveTurn = highspeedExecution
    ? record.app.runtime?.getActiveTurnInfo?.()
    : undefined;
  const highspeedRequiresQueue =
    !forceStartNow &&
    highspeedExecution !== undefined &&
    (record.activeAbortController !== undefined ||
      highspeedActiveTurn !== undefined ||
      routingMode === "enqueue" ||
      routingMode === "guide");

  const queueHighspeedTurn = async (): Promise<CommandResult | undefined> => {
    const highspeedSelection = payload.modelSelection;
    if (!highspeedExecution || !highspeedSelection) {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "Highspeed queue requires turn execution material",
      );
    }
    const ordinarySelection = resolveOrdinaryQueueModelSelection(
      record,
      highspeedExecution.selectionFallback?.target,
    );
    const retainQueuedTurnExecution = host.retainQueuedTurnExecution;
    // Bug 根因：队列曾把单轮 Highspeed Selection 持久化进 QueueItem，撤回编辑会把它
    // 恢复到 Composer，并污染下一次 fallback。队列只保存普通提交模型；加速 Selection
    // 与凭据必须作为同一 execution bundle 驻留 CLI 内存。
    if (retainQueuedTurnExecution) {
      retainQueuedTurnExecution(record.app.sessionId, envelope.commandId, {
        modelSelection: highspeedSelection,
        modelExecution: highspeedExecution,
      });
    }
    try {
      const requestedDelivery = routingMode === "guide" ? "guide" : "queue";
      const intent = submissionIntent({
        text: payload.text,
        requestedDelivery,
        admittedDelivery: "queue",
        ...(routingMode === "guide" ? { fallbackReasonCode: HIGHSPEED_QUEUE_FALLBACK_REASON } : {}),
        attachmentRefs: payload.attachments,
      });
      intent.modelSelection = ordinarySelection;
      if (!retainQueuedTurnExecution) delete intent.highspeed;
      // 入队与 canonical 编辑入队一致，只提交普通 Selection：Core 用它写会话常驻模型，
      // execution 不进入准入，只在提升边界由暂存 bundle 应用。
      const queued = await startPromptTurn(host, record, {
        content: payload.text,
        ...(payload.browserAmbientContext
          ? { browserAmbientContext: payload.browserAmbientContext }
          : {}),
        inputId: envelope.commandId,
        intent,
        requireQueue: true,
        ...(attachments ? { attachments } : {}),
        toolDisallowlist: payload.toolDisallowlist,
      });
      if (queued.admission.kind !== "queued") {
        throw new V4InputAdmissionRejectedError(
          "fault.command.inputRejected",
          "Highspeed input was not admitted to the queue",
        );
      }
      return {
        type: "inputAccepted",
        delivery: "queue",
        inputId: envelope.commandId,
      };
    } catch (error) {
      if (retainQueuedTurnExecution) {
        host.deleteQueuedTurnExecution?.(record.app.sessionId, envelope.commandId);
      }
      throw error;
    }
  };

  if (highspeedRequiresQueue) {
    // Bug 根因：临时 Highspeed provider 不能 guide 到当前 turn；交给 Core 的 requireQueue
    // 原子准入，避免跨层 busy 快照在 await 期间失效后用普通模型直接启动。
    return await queueHighspeedTurn();
  }
  const foregroundPromotionLeaseId = forceStartNow ? `send-now:${envelope.commandId}` : undefined;
  let foregroundPromotionLeaseAcquired = false;
  const releaseForegroundPromotionLease = () => {
    if (!foregroundPromotionLeaseAcquired || !foregroundPromotionLeaseId) return;
    record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    foregroundPromotionLeaseAcquired = false;
  };
  if (forceStartNow) {
    // Bug 根因：Highspeed prepare 让“立即发送”更容易落入 Core busy admission；先持有
    // 前台租约并抢占当前轮，才能保证 requestedDelivery=startNow 不被静默改成 queue。
    const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
      leaseId: foregroundPromotionLeaseId!,
      mode: "after-current",
      promotedInputId: envelope.commandId,
    });
    if (leaseResult.kind !== "acquired") {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "send now foreground promotion is busy",
      );
    }
    foregroundPromotionLeaseAcquired = true;
    try {
      // 单条消息的 delivery 只决定新输入何时消费，不能绕过已有队列的用户裁决。
      await applyHeldQueueDisposition(
        host,
        record,
        payload.heldQueueDisposition,
        payload.expectedHeldQueueItemIds,
      );
      await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendText startNow preempts active turn",
        goalPausedMutationReason: "send_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    } catch (error) {
      releaseForegroundPromotionLease();
      throw error;
    }
  }
  if (!forceStartNow) {
    await applyHeldQueueDisposition(
      host,
      record,
      payload.heldQueueDisposition,
      payload.expectedHeldQueueItemIds,
    );
  }
  let started;
  // 附件命令面：AttachmentRef → TurnAttachment 在闸门后映射（active turn 已排除）。
  try {
    const intent = submissionIntent({
      text: payload.text,
      inputOrigin: payload.inputOrigin,
      botGroupSource: payload.botGroupSource,
      conversationQuotes: payload.conversationQuotes,
      requestedDelivery:
        payload.requestedDelivery ??
        (routingMode === "guide" ? "guide" : routingMode === "enqueue" ? "queue" : "startNow"),
      ...(payload.requestedDelivery !== "guide" && routingMode === "guide" && attachments?.length
        ? { fallbackReasonCode: "guide.attachmentsUnsupported" }
        : {}),
      attachmentRefs: payload.attachments,
      sharedContextRefs: payload.context_refs,
      ...(payload.source ? { source: payload.source } : {}),
    });
    started = await startPromptTurn(host, record, {
      content: payload.text,
      ...(payload.browserAmbientContext
        ? { browserAmbientContext: payload.browserAmbientContext }
        : {}),
      inputId: envelope.commandId,
      // 立即发送是用户的新指令：抢占后与空闲时一样按普通用户消息开新一轮，不加中途提示。
      // 修复原因：原来抢占后标成 user_steer，模型看到"在当前轮继续"的提示；MCS 关时这段提示
      // 还并入上一次请求已发出的 tool_result，改写了那次请求写入的缓存。
      intent,
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...turnBackgroundAttributionOf(payload),
      ...(payload.botDeliveryTarget ? { botDeliveryTarget: payload.botDeliveryTarget } : {}),
      toolDisallowlist: payload.toolDisallowlist,
      ...(payload.modelExecution
        ? { modelExecution: createModelExecutionContext(payload.modelExecution) }
        : {}),
      ...(attachments ? { attachments } : {}),
      // promotion lease 本身属于 Core busy authority；若不声明 requireIdle，
      // 抢占完成后的 startNow 会先落 deferred queue，待 lease 释放后再被自动 drain。
      ...(forceStartNow ? { requireIdle: true } : {}),
      ...(queueHeadEditLocked ? { requireQueue: true } : {}),
    });
  } catch (error) {
    if (
      highspeedExecution &&
      error instanceof V4PromptRejectedError &&
      error.reasonCode === "activePrompt"
    ) {
      // Bug 根因：Bootstrap 读取空闲后到 Core admission 之间可能新建 reservation。
      // 此时 Highspeed 不能降级丢失，也不能把加速凭据插进当前 turn，改由 Core 强制入队。
      return await queueHighspeedTurn();
    }
    throw error;
  } finally {
    releaseForegroundPromotionLease();
  }
  if (started.admission.kind === "queued") {
    return {
      type: "inputAccepted",
      delivery: "queue",
      inputId: envelope.commandId,
    };
  }
  return {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: envelope.commandId,
  };
}

/** stop：精确取消投影中看到的 runtime 前台执行，并把 active goal 收口为 paused。 */
async function stop(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as CommandPayloadMap["stop"];
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
    reason: "v4 session stopped",
  });
  host.logger?.info?.("v4 stop foreground execution inspected", {
    activeForegroundExecutionId:
      runtimeStop?.kind === "mismatch"
        ? runtimeStop.activeForegroundExecutionId
        : runtimeStop?.kind === "stopped"
          ? runtimeStop.foregroundExecutionId
          : undefined,
    event: "v4.stop.foreground_execution_inspected",
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
    module: "bootstrap.zcode_protocol_v4.commands",
    runtimeStopKind: runtimeStop?.kind ?? "unsupported",
    sessionId: record.app.sessionId,
  });
  if (
    payload.expectedForegroundExecutionId !== undefined &&
    (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch")
  ) {
    // Stop 从 renderer 到 host 有异步窗口；若 verifier 已结束且下一轮已启动，
    // 继续 abort 外层 controller 会误杀用户没看到的新执行。execution id 不匹配只能 noop。
    throw new V4CommandNoopError("guard.stopTargetChanged");
  }
  if (runtimeStop?.kind === "stopped") {
    // 先打断 runtime-owned verifier/continuation，再等待 goal pause；否则 verifier 可能在
    // pause RPC 完成前通过并接入下一次 continuation。
    record.activeAbortController?.abort(new Error("v4 session stopped"));
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // verifier 已越过普通 turn catch，不能依赖 TurnComplete(cancelled)
        // 翻转 runtime queue gate；显式写入 false，确保 future queue 原位 held。
        await record.app.setQueueAutoDrain(false);
      } catch (error) {
        host.logger?.warn?.("v4 stop failed to hold following queue", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: record.app.sessionId,
        });
      }
    }
    const pausedGoal = await pauseActiveGoal(host, record);
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
    }
    return undefined;
  }

  // 兼容 compact 与旧客户端：它们没有 runtime foreground execution token，仍由
  // bootstrap 外层 controller 提供取消窗口。
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedGoal = false;
  if (hadActivePrompt) {
    pausedGoal = await pauseActiveGoal(host, record);
  }
  record.activeAbortController?.abort(new Error("v4 session stopped"));
  if (pausedGoal) {
    await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
  }
  return undefined;
}

/** goal-pause barrier 共用件：stop 与 sendQueuedNow（抢占重发）复用，不复制。 */
export async function pauseActiveGoal(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
): Promise<boolean> {
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return false;
  }
  try {
    const paused = await record.app.updateTargetStatus("paused");
    return Boolean(paused);
  } catch (error) {
    host.logger?.warn?.("v4 stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
    return false;
  }
}

/** 轮询等 Bootstrap turn 与 Core turn 的 finally 都释放 authority。 */
export async function waitForSessionIdle(record: V4SessionRecordView): Promise<void> {
  const deadline = Date.now() + IDLE_POLL_TIMEOUT_MS;
  while (true) {
    // Bug 根因：Bootstrap 的 abort/foreground 标记会早于 Core activeTurn 清理，编辑在这
    // 个窗口内 rewind 后重新 admission 会收到 turn_not_steerable。Core 的 activeTurn
    // 是 prompt admission 使用的权威收口边界，必须一起等待。
    const coreTurnActive = record.app.runtime?.getActiveTurnInfo?.() !== undefined;
    if (
      record.activeAbortController === undefined &&
      record.app.runtime?.getActiveForegroundExecutionId?.() === undefined &&
      !coreTurnActive
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new V4SessionIdleTimeoutError(record.app.sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
  }
}

export async function preemptActiveTurnAndWait(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  options: {
    abortMessage: string;
    goalPausedMutationReason: string;
    preserveQueueAutoDrainOnCancel?: boolean;
  },
): Promise<void> {
  const bootstrapAbortController = record.activeAbortController;
  // background notification 的 model-only turn 由 Core runtime command
  // 独立持有 foreground authority，不会创建 Bootstrap activeAbortController。
  // 忽略这点会误判 idle，随后把被提升的 queue item steer 回旧 notification turn。
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    preserveQueueAutoDrainOnCancel: options.preserveQueueAutoDrainOnCancel === true,
    reason: options.abortMessage,
  });
  if (bootstrapAbortController || runtimeStop?.kind === "stopped") {
    const pausedGoal = await pauseActiveGoal(host, record);
    if (runtimeStop?.kind !== "stopped") {
      bootstrapAbortController?.abort(new Error(options.abortMessage));
    }
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, options.goalPausedMutationReason);
    }
  }
  await waitForSessionIdle(record);
}

export const sessionFlowHandlers = { sendText, stop };

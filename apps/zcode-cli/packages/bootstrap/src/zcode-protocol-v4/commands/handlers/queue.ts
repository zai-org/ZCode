// queue 命令组：deleteQueueItem / editQueueItem / lockQueueItemEdit / releaseQueueItemEdit /
// reorderQueueItem / setAutoDrain / setFollowupMode / sendQueuedNow（原生重做，组文件样板见 session-flow.ts）。
// 决策逻辑直驱 core（app 层 queue API，批1 已搬运）；queueItemId ≡ core 的
// pendingInputId（同一 id 空间，无需翻译）。queue 变更的事件由 core runtime 自发，
// 经 gateway ingest 推进 v4 投影——本组不需要 legacy 广播钩子。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../session-execution/index.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn, turnBackgroundAttributionOf } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  startManualCompact,
  V4GoalCompactRejectedError,
} from "./goal-compact.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow 在投影里查不到该项原文（已被 drain/删除或 id 无效）→ 拒绝。 */
export class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

export class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

export class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

export class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

/** 冻结项（composer 编辑态，docs/ui/composer-edit-mode.md）拒绝删除、重排、立即发送和他人改写。 */
export class V4QueueItemEditLockedError extends Error {
  readonly reasonCode = "guard.queueItemEditLocked";
  constructor(queueItemId: string) {
    super(`v4 queue item is locked by composer edit: ${queueItemId}`);
    this.name = "V4QueueItemEditLockedError";
  }
}

/** editQueueItem 声明的编辑锁已被解除或换主：提交不能覆盖他人此后看到的内容。 */
export class V4QueueEditLockLostError extends Error {
  readonly reasonCode = "guard.queueEditLockLost";
  constructor(queueItemId: string) {
    super(`v4 queue edit lock is no longer held: ${queueItemId}`);
    this.name = "V4QueueEditLockLostError";
  }
}

export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  // Core 同样拒绝删除冻结项；这里先给出可判别的 guard，避免误报成 itemMissing。
  if (record.app.runtime.getPendingInputEditLock?.(payload.queueItemId)) {
    throw new V4QueueItemEditLockedError(payload.queueItemId);
  }
  // 未命中（并发 drain/重复删除的竞态）= noop，不算失败；留 warn 供观测。
  const removed = await record.app.removeQueueItem(payload.queueItemId);
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // 未命中曾返回 undefined，gateway 会把并发 drain/重复删除误报为 accepted；
    // queue 撤回编辑因此可能把已消费的旧投影再次恢复到 composer。
    throw new V4CommandNoopError("queue.itemMissing");
  }
  if (queueItem) {
    host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  return undefined;
}

async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") {
    // compact 是 typed maintenance intent；允许改文本会把它伪装成普通输入，
    // 但 commandKind 仍是 compact，消费时产生与 UI 文案不一致的压缩副作用。
    throw new V4QueueItemNotEditableError(payload.queueItemId);
  }
  // 附件映射在写回前完成：引用失效要在改写队列项之前暴露。
  const attachments = payload.attachments
    ? await mapAttachmentRefsToTurnAttachments(record.app, payload.attachments)
    : undefined;
  // 用户在编辑态改了模型：入队时冻结的 Highspeed 卡与暂存凭据不能再覆盖新选择。
  const modelChanged =
    payload.modelSelection !== undefined &&
    JSON.stringify(payload.modelSelection) !== JSON.stringify(queueItem?.modelSelection);
  // core reducer 同 id 原地更新（保位）；未命中 = noop + warn（同 delete 的竞态语义）。
  const result = await record.app.editQueueItem(payload.queueItemId, payload.newText, {
    ...(payload.editorId ? { editorId: payload.editorId } : {}),
    ...(payload.attachments
      ? {
          attachmentRefs: payload.attachments.map((ref) => ({ ...ref })),
          ...(attachments ? { attachments } : {}),
        }
      : {}),
    ...(payload.conversationQuotes ? { conversationQuotes: payload.conversationQuotes } : {}),
    ...(payload.modelSelection ? { modelSelection: payload.modelSelection } : {}),
    ...(payload.mode ? { mode: payload.mode } : {}),
    ...(payload.planEnabled !== undefined ? { planEnabled: payload.planEnabled } : {}),
    ...(modelChanged ? { dropHighspeed: true } : {}),
  });
  if (result === "editLocked") throw new V4QueueItemEditLockedError(payload.queueItemId);
  if (result === "lockLost") throw new V4QueueEditLockLostError(payload.queueItemId);
  if (result === "missing") {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // 编辑态据此进入失效态（原项已被消费或删除），不能把未命中当成已保存。
    throw new V4CommandNoopError("queue.itemMissing");
  }
  if (modelChanged && queueItem) {
    host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  // 编辑提交同时解锁；冻结的若是队首，需要重评自动续跑。
  await host.afterLegacyStateMutation?.(record, "queue_item_edited");
  return undefined;
}

/**
 * 编辑提交后把新模型/mode 应用到其他排队项（docs/ui/composer-edit-mode.md）。
 * 同一命令内逐项走 editQueueItem 的原地改写路径，正文缺省由 core 保留原输入；
 * 弹窗期间已被提升、删除、冻结的项跳过，不报错——用户的意图只针对仍在等待的项。
 */
async function applyQueueItemsConfig(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["applyQueueItemsConfig"];
  const record = requireRecord(host, envelope.sessionId);
  let applied = 0;
  for (const queueItemId of payload.queueItemIds) {
    const queueItem = host.getQueueItem?.(record.app.sessionId, queueItemId) ?? null;
    if (!queueItem || queueItem.kind === "compact" || queueItem.dispatch.state !== "queued") {
      continue;
    }
    const modelChanged =
      payload.modelSelection !== undefined &&
      JSON.stringify(payload.modelSelection) !== JSON.stringify(queueItem.modelSelection);
    const result = await record.app.editQueueItem(queueItemId, undefined, {
      ...(payload.modelSelection ? { modelSelection: payload.modelSelection } : {}),
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(modelChanged ? { dropHighspeed: true } : {}),
    });
    if (result !== "edited") continue;
    applied += 1;
    if (modelChanged) host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  if (applied === 0) throw new V4CommandNoopError("queue.itemMissing");
  return undefined;
}

/** composer 编辑态冻结排队项：编辑期间自动续跑停在该项前，所有端可见锁归属。 */
async function lockQueueItemEdit(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["lockQueueItemEdit"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") throw new V4QueueItemNotEditableError(payload.queueItemId);
  const result = await record.app.lockQueueItemEdit(payload.queueItemId, {
    editorId: payload.editorId,
    clientId: envelope.clientId,
    // inputOrigin 由 Host 可信注入，只用于其他端展示锁来自桌面还是手机。
    ...(envelope.inputOrigin ? { inputOrigin: envelope.inputOrigin } : {}),
  });
  if (result === "reserved") throw new V4QueueItemReservedError(payload.queueItemId);
  if (result === "lockedByOther") throw new V4QueueItemEditLockedError(payload.queueItemId);
  if (result === "missing") throw new V4CommandNoopError("queue.itemMissing");
  return undefined;
}

/** 解除编辑锁：发起端取消/刷新自愈，或其他端在发起端离线时手动解除。 */
async function releaseQueueItemEdit(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["releaseQueueItemEdit"];
  const record = requireRecord(host, envelope.sessionId);
  const released = await record.app.releaseQueueItemEdit(payload.queueItemId);
  if (!released) throw new V4CommandNoopError("queue.editLockMissing");
  // 冻结的可能正是队首：解锁后必须重评自动续跑，否则空闲会话会一直停在这里。
  await host.afterLegacyStateMutation?.(record, "queue_edit_lock_released");
  return undefined;
}

async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  if (record.app.runtime.getPendingInputEditLock?.(payload.queueItemId)) {
    throw new V4QueueItemEditLockedError(payload.queueItemId);
  }
  // beforeQueueItemId = null → 移到队尾（协议与 app API 同形，直传）。
  const moved = await record.app.reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setQueueAutoDrain(payload.autoDrain);
  if (payload.autoDrain) {
    // 不能只翻授权位：idle 暂停队列没有 active turn 可替它启动队首。复用 CLI
    // 权威 ready hook，busy 时只武装，idle 时立即按 sendQueuedNow 原子路径提升。
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setFollowupMode(payload.mode);
  return undefined;
}

/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - 必须读取完整 QueueItem；text-only fallback 会丢 sourceCommandId/附件/client/order，禁止使用。
 * - stop 复用 session-flow 的语义：goal-pause barrier（否则 verifier 未收 abort 时
 *   queue 无法 drain）→ abort；只 abort 不 await。
 * - 等 idle 语义：锁由后台 turn 的 finally 释放（见 prompt-turn 文件头 3），
 *   abort 后立刻重发会撞 "A prompt is already running"，必须轮询等锁释放。
 * - start 之前任一步失败都 release reservation，原项原位保留；start 成功后才 remove。
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    // 冻结项不能被提升；auto-drain 据此只停住、不把队列误判为失败而暂停。
    if (record.app.runtime.getPendingInputEditLock?.(payload.queueItemId)) {
      throw new V4QueueItemEditLockedError(payload.queueItemId);
    }
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (!(await record.app.reserveQueueItem(payload.queueItemId, reservationId, traceOptions))) {
      // reserve 与加锁之间有 await 窗口；被锁抢先时仍报可判别的锁错误。
      if (record.app.runtime.getPendingInputEditLock?.(payload.queueItemId)) {
        throw new V4QueueItemEditLockedError(payload.queueItemId);
      }
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments =
      queueItem.kind === "compact"
        ? undefined
        : await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    if (!autoDrainPromotion) {
      await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    }
    if (
      !(await record.app.markQueueItemPromoting(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    if (queueItem.kind === "compact") {
      // 旧提升只传 commandId，丢失入队时的 B；与普通输入一样恢复完整意图，禁止重读 Composer。
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      intent.modelSelection ??= resolveSessionFallbackModelSelection(record);
      await startManualCompact(host, record, {
        inputId: queueItem.sourceCommandId,
        foregroundPromotionLeaseId,
        intent,
      });
      leaseReleaseOwnedByBackground = true;
    } else if (queueItem.kind === "sendGoalCommand") {
      const intent = inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text);
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        record.app.runtime?.getPlanEnabled?.() ??
        record.app.getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      // 手动提升允许 Renderer 为同一张卡补一份新执行材料；卡不同一律忽略，避免跨卡换凭据。
      const refreshedHighspeedMatchesQueue =
        payload.highspeedMeta !== undefined &&
        queueItem.highspeed !== undefined &&
        payload.highspeedMeta.cardId === queueItem.highspeed.cardId &&
        payload.highspeedMeta.taskId === queueItem.highspeed.taskId;
      const ordinarySelection = isHighspeedProviderId(intent.modelSelection?.providerId)
        ? resolveSessionFallbackModelSelection(record)
        : intent.modelSelection;
      // Bug 根因：旧版本已把临时 Highspeed Selection 持久化到 QueueItem。进程升级后
      // execution bundle 必然丢失；若不在提升边界迁移，会继续用内部 Provider 并直接报错。
      intent.modelSelection = ordinarySelection;
      if (refreshedHighspeedMatchesQueue && payload.highspeedMeta) {
        intent.highspeed = payload.highspeedMeta;
      }
      // 凭据不入队列持久化面：先用本次补供的完整 bundle，其次取 CLI 内存暂存。
      const refreshedExecution =
        refreshedHighspeedMatchesQueue && payload.modelSelection && payload.modelExecution
          ? { modelSelection: payload.modelSelection, modelExecution: payload.modelExecution }
          : undefined;
      const stagedExecution =
        refreshedExecution ??
        host.readQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      // Bug 根因：QueueItem.modelSelection 同时承担普通模型和临时加速模型，导致编辑恢复与
      // 降级目标互相污染。提升边界才临时应用 bundle；失败时保留队列项自己的普通 Selection。
      const highspeedStillValid =
        intent.highspeed !== undefined &&
        intent.highspeed.expiresAt > Date.now() &&
        stagedExecution !== undefined &&
        isHighspeedProviderId(stagedExecution.modelSelection.providerId);
      if (highspeedStillValid && stagedExecution) {
        intent.modelSelection = stagedExecution.modelSelection;
      } else if (intent.highspeed) {
        if (intent.highspeed.expiresAt > Date.now()) {
          host.logger?.warn?.("v4 queued Highspeed execution unavailable; using queued model", {
            cardId: intent.highspeed.cardId,
            queueItemId: queueItem.queueItemId,
            reason: "execution_missing",
            sessionId: record.app.sessionId,
          });
        }
        delete intent.highspeed;
        host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      }
      // 退回目标统一为上面的普通 Selection（规则 9）。新队列项的 bundle target 本来就相同；
      // 旧队列项“立即发送”且服务仍持有同一张卡时，Renderer 以持久化的临时 Provider 重新准备，
      // target 也是临时 Provider，这里改回，避免降级仍落到内部 Provider。
      const turnExecution =
        highspeedStillValid && stagedExecution
          ? {
              ...stagedExecution.modelExecution,
              ...(stagedExecution.modelExecution.selectionFallback
                ? {
                    selectionFallback: {
                      ...stagedExecution.modelExecution.selectionFallback,
                      target: ordinarySelection,
                    },
                  }
                : {}),
            }
          : undefined;
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
        inputId: queueItem.sourceCommandId,
        // 手动提升即使抢占了旧执行，被点文本也是普通用户消息，与自动 drain 相同（原因见 sendText）。
        intent,
        requireIdle: true,
        // Bug 根因：提升曾只回放 inputId 和 denylist，导致可信 automation attribution 丢失。
        ...turnBackgroundAttributionOf({ automationId: queueItem.automationId }),
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(turnExecution ? { modelExecution: createModelExecutionContext(turnExecution) } : {}),
        ...(attachments ? { attachments } : {}),
      });
      // 旧 fake app/兼容命令可能不返回 admission receipt；真实 app 已在 Core admission
      // 处完成 started 校验。只有明确 queued/rejected 才能判定 promotion 未启动。
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
      // 凭据已随本轮冻结进 Core；启动成功后立刻销毁暂存副本，失败路径保留以便重试仍能加速。
      host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
    }
    startAdmitted = true;
    const removed = await record.app.removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    if (queueItem.kind === "compact") {
      // no-op compact 可能在 promoting 项删除前就完成；它的 ready hook 此时看见的
      // 仍是 dispatch=promoting，无法继续消费下一条 typed intent。删除后再过一次 mutation
      // 边界可关闭这个竞态；正常慢 compact 因 active controller 存在不会重复 drain。
      await host.afterLegacyStateMutation?.(record, "queue_compact_promoted");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // start 一旦 admitted 就不能 release，否则 remove 异常时另一端会重复执行；此时保持
    // promoting 供显式 resync/故障处理。start 前失败则安全回滚到 queued。
    if (queueItemReserved && !startAdmitted) {
      await record.app.releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

export const queueHandlers = {
  applyQueueItemsConfig,
  deleteQueueItem,
  editQueueItem,
  lockQueueItemEdit,
  releaseQueueItemEdit,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  sendQueuedNow,
};

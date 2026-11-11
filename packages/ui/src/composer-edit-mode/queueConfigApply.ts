// 编辑提交后把新模型/mode 应用到其他排队消息（docs/ui/composer-edit-mode.md「提交后应用到其他排队消息」）。
// 候选项与要带的字段只从当前投影派生；弹窗确认时按当时投影重算，不缓存弹窗打开时的列表。
import { useCallback, useEffect, useRef } from "react";
import { isHighspeedProviderId, ZCODE_AGENT_PROVIDER, type ModelSelection } from "@zcode/shared";
import type { CommandAck, QueueItem, SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_COMPOSER_EDIT_APPLY_QUEUE_DIALOG } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { getModeOptionLabelMessageId } from "@/chat-input-toolbar/display.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
import { logger } from "@/logger.js";

export interface QueueConfigApplySubmission {
  modelSelection?: ModelSelection;
  mode?: SubmissionMode;
}

export interface QueueConfigApplyPlan {
  queueItemIds: string[];
  modelSelection?: ModelSelection;
  mode?: SubmissionMode;
}

function sameModelSelection(a: ModelSelection | undefined, b: ModelSelection): boolean {
  return (
    a?.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.options?.reasoningLevel === b.options?.reasoningLevel
  );
}

/**
 * 候选项：仍在等待（queued）、无编辑锁、非 compact、不是本次编辑的项。只带与候选项不同的字段；
 * 都相同返回 null（不提示）。Highspeed 是单轮加速卡，不作为排队项的模型。
 */
export function planQueueConfigApply(
  items: readonly QueueItem[],
  submitted: QueueConfigApplySubmission,
  excludeQueueItemId?: string,
): QueueConfigApplyPlan | null {
  const eligible = items.filter(
    (item) =>
      item.queueItemId !== excludeQueueItemId &&
      item.dispatch.state === "queued" &&
      !item.editLock &&
      item.kind !== "compact",
  );
  const model =
    submitted.modelSelection && !isHighspeedProviderId(submitted.modelSelection.providerId)
      ? submitted.modelSelection
      : undefined;
  const modelDiffers = (item: QueueItem) =>
    model !== undefined && !sameModelSelection(item.modelSelection, model);
  const modeDiffers = (item: QueueItem) =>
    submitted.mode !== undefined && item.mode !== submitted.mode;
  const targets = eligible.filter((item) => modelDiffers(item) || modeDiffers(item));
  if (targets.length === 0) return null;
  return {
    queueItemIds: targets.map((item) => item.queueItemId),
    ...(targets.some(modelDiffers) ? { modelSelection: model } : {}),
    ...(targets.some(modeDiffers) ? { mode: submitted.mode } : {}),
  };
}

/**
 * 发起端的确认弹窗。会话切换或卸载时关闭未结算的弹窗，不把配置写到另一个会话。
 */
export function useQueueConfigApplyPrompt(params: {
  sessionId: string | null;
  readQueueItems: () => readonly QueueItem[] | null;
  dispatchCommand: (
    type: "applyQueueItemsConfig",
    payload: Record<string, unknown>,
    targetSessionId: string | null,
  ) => Promise<CommandAck>;
}): (submitted: QueueConfigApplySubmission, excludeQueueItemId?: string) => void {
  const { sessionId, readQueueItems, dispatchCommand } = params;
  const { intl } = useZCodeIntl();
  const pendingRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pendingRef.current?.abort();
      pendingRef.current = null;
    },
    [sessionId],
  );
  return useCallback(
    (submitted, excludeQueueItemId) => {
      const items = readQueueItems();
      const initial = items ? planQueueConfigApply(items, submitted, excludeQueueItemId) : null;
      if (!sessionId || !initial) return;
      const modeLabelId = initial.mode
        ? getModeOptionLabelMessageId(ZCODE_AGENT_PROVIDER, { value: initial.mode })
        : null;
      const modeLabel = modeLabelId ? intl.formatMessage({ id: modeLabelId }) : initial.mode;
      const reasoning = initial.modelSelection?.options?.reasoningLevel;
      const reasoningId = reasoning ? thoughtLevelLabelId(reasoning) : undefined;
      const modelLabel = initial.modelSelection
        ? reasoning
          ? `${initial.modelSelection.modelId} · ${reasoningId ? intl.formatMessage({ id: reasoningId }) : reasoning}`
          : initial.modelSelection.modelId
        : undefined;
      const descriptionId =
        modeLabel && modelLabel
          ? "chat.composerEdit.applyQueue.modelAndMode"
          : modelLabel
            ? "chat.composerEdit.applyQueue.model"
            : "chat.composerEdit.applyQueue.mode";
      pendingRef.current?.abort();
      const controller = new AbortController();
      pendingRef.current = controller;
      void useConfirmDialogStore
        .getState()
        .requestConfirmation(
          {
            testId: TID_V4_COMPOSER_EDIT_APPLY_QUEUE_DIALOG,
            intent: "composer-edit-apply-queue",
            title: intl.formatMessage({ id: "chat.composerEdit.applyQueue.title" }),
            description: intl.formatMessage(
              { id: descriptionId },
              { mode: modeLabel ?? "", model: modelLabel ?? "" },
            ),
            confirmLabel: intl.formatMessage({ id: "chat.composerEdit.applyQueue.confirm" }),
            cancelLabel: intl.formatMessage({ id: "chat.composerEdit.applyQueue.cancel" }),
          },
          controller.signal,
        )
        .then(async (confirmed) => {
          if (pendingRef.current === controller) pendingRef.current = null;
          if (!confirmed || controller.signal.aborted) return;
          // 弹窗期间队列照常消费：按确认时的投影重算，已离开队列的项不发送。
          const latest = readQueueItems();
          const plan = latest
            ? planQueueConfigApply(
                latest,
                { modelSelection: initial.modelSelection, mode: initial.mode },
                excludeQueueItemId,
              )
            : null;
          if (!plan) return;
          try {
            const ack = await dispatchCommand("applyQueueItemsConfig", { ...plan }, sessionId);
            logger.info("[composer-edit] 应用配置到排队消息", {
              sessionId,
              count: plan.queueItemIds.length,
              status: ack.status,
              reasonCode: ack.reasonCode,
            });
            if (ack.status === "rejected" || ack.status === "failed" || ack.status === "stale")
              toast(intl.formatMessage({ id: "chat.composerEdit.applyQueue.failed" }));
          } catch (error) {
            logger.warn("[composer-edit] 应用配置到排队消息失败", { sessionId, error });
            toast(intl.formatMessage({ id: "chat.composerEdit.applyQueue.failed" }));
          }
        });
    },
    [dispatchCommand, intl, readQueueItems, sessionId],
  );
}

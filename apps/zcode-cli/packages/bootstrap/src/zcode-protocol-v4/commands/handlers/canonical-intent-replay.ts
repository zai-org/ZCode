// edit/retry 的 canonical intent 重发原语：rewind 截断之后，把 projection resolver 解析出的
// canonical user intent（含附件引用、模型 Selection、goal 命令语义）重新发起为一轮。
// 从 fork-edit-retry.ts 抽出：editUserQuery 与 retryTurn 共用，forkAssistant 不经过这里
// （fork 只做 conversation-only copy，不 rewind、不重发）。
import type { CommandEnvelope, CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import type { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import {
  resolveOrdinaryQueueModelSelection,
  resolveSessionFallbackModelSelection,
} from "../input-admission.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { preflightPromptTurn, startPreflightedPromptTurn } from "../prompt-turn.js";
import { createModelExecutionContext } from "../../../session-execution/index.js";
import type { V4CommandCoreHost, V4SessionRecordView, V4TurnExecution } from "../types.js";
import { applyGoalCommand } from "./goal-compact.js";
import type { ConversationEditTarget } from "../../product-projection.js";

const EDIT_QUEUE_FALLBACK_REASON = "edit.admissionRace";

type CanonicalHighspeed = {
  card: NonNullable<CommandPayloadMap["editUserQuery"]["highspeedMeta"]>;
  modelSelection: NonNullable<CommandPayloadMap["editUserQuery"]["modelSelection"]>;
  execution: V4TurnExecution;
};

export function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

function buildCanonicalIntent(
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  highspeed: CanonicalHighspeed | undefined,
  requireQueue: boolean,
  canRetainQueuedHighspeed: boolean,
) {
  // composer 编辑态复用普通发送的工具栏：edit 携带的模型/模式/Plan 是本次重跑的提交配置，
  // 与 sendText 同语义；缺省（旧客户端、retry）沿用原 canonical intent。
  const editPayload =
    envelope.type === "editUserQuery"
      ? (envelope.payload as CommandPayloadMap["editUserQuery"])
      : undefined;
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    {
      kind: editTarget.intent.kind,
      conversationQuotes:
        envelope.type === "editUserQuery"
          ? ((envelope.payload as CommandPayloadMap["editUserQuery"]).conversationQuotes ??
            editTarget.intent.conversationQuotes)
          : editTarget.intent.conversationQuotes,
      text: editTarget.intent.text,
      genUiContext: editTarget.intent.genUiContext,
      sourceCommandId: editTarget.intent.sourceCommandId,
      clientId: editTarget.intent.clientId,
      queueItemId: editTarget.intent.queueItemId,
      requestedDelivery: editTarget.intent.requestedDelivery,
      admittedDelivery: editTarget.intent.admittedDelivery,
      fallbackReasonCode: editTarget.intent.fallbackReasonCode,
      modelSelection: editPayload?.modelSelection ?? editTarget.intent.modelSelection,
      mode: editPayload?.mode ?? editTarget.intent.mode,
      planEnabled: editPayload?.planEnabled ?? editTarget.intent.planEnabled,
      attachmentRefs,
      provenance: editTarget.intent.provenance,
    },
    text,
  );
  const appliesHighspeed = highspeed !== undefined && (!requireQueue || canRetainQueuedHighspeed);
  if (appliesHighspeed && highspeed) {
    intent.highspeed = highspeed.card;
    if (requireQueue) {
      // Bug 根因：编辑重发进入队列时曾把临时 Highspeed Selection 写回 canonical intent，
      // 后续撤回会污染 Composer。普通 Selection 在下方统一写入边界过滤。
      intent.modelSelection = highspeed.execution.selectionFallback?.target;
    } else {
      intent.modelSelection = highspeed.modelSelection;
    }
  } else if (isHighspeedProviderId(intent.modelSelection?.providerId)) {
    // Bug 根因：retry、卡过期/未重新抽到卡的 edit、宿主无法暂存凭据的入队 edit 都没有本轮执行材料，
    // 却沿用了被 rewind 那轮持久化的 account:*-highspeed-card Selection。加速 Selection 只有与同一轮
    // requestAuth 成对才有效：单独保留会让 Core 以 ModelRequestAuthMissing 失败，还会被固定进新的
    // canonical intent，让后续普通发送继续携带无法使用的加速 Provider。与队列提升共用同一 resolver
    // 退回会话常驻 Selection，只改本轮 intent、不改 session 模型（spec §3 规则 13）。
    intent.modelSelection = resolveSessionFallbackModelSelection(record);
  }
  if (requireQueue) {
    intent.modelSelection = resolveOrdinaryQueueModelSelection(record, intent.modelSelection);
    intent.requestedDelivery = "queue";
    intent.admittedDelivery = "queue";
    intent.fallbackReasonCode = EDIT_QUEUE_FALLBACK_REASON;
  }
  return intent;
}

/** destructive edit/retry 在提交 branch cut 前调用；只检查模型，不接纳输入。 */
export async function preflightCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  highspeed?: CanonicalHighspeed,
): Promise<void> {
  if (editTarget.intent.kind === "sendGoalCommand") return;
  const intent = buildCanonicalIntent(
    record,
    envelope,
    editTarget,
    text,
    attachmentRefs,
    highspeed,
    false,
    false,
  );
  await preflightPromptTurn(host, record, {
    content: text,
    inputId: envelope.commandId,
    intent,
    ...(highspeed ? { modelExecution: createModelExecutionContext(highspeed.execution) } : {}),
    ...(attachments ? { attachments } : {}),
  });
}

export async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  highspeed?: CanonicalHighspeed,
  options?: { requireQueue?: boolean },
): Promise<void> {
  const requireQueue = options?.requireQueue === true;
  const retainQueuedTurnExecution = host.retainQueuedTurnExecution;
  // 入队路径的凭据只能驻留内存；宿主不提供暂存能力时必须整体退回会话模型，不留半程加速。
  const canRetainQueuedHighspeed =
    requireQueue && highspeed !== undefined && retainQueuedTurnExecution !== undefined;
  const intent = buildCanonicalIntent(
    record,
    envelope,
    editTarget,
    text,
    attachmentRefs,
    highspeed,
    requireQueue,
    canRetainQueuedHighspeed,
  );
  if (requireQueue) {
    if (canRetainQueuedHighspeed && highspeed && retainQueuedTurnExecution) {
      retainQueuedTurnExecution(record.app.sessionId, envelope.commandId, {
        modelSelection: highspeed.modelSelection,
        modelExecution: highspeed.execution,
      });
    }
  }
  if (editTarget.intent.kind === "sendGoalCommand") {
    await applyGoalCommand(host, record, {
      inputId: envelope.commandId,
      objective: text,
      intent,
    });
    return;
  }
  try {
    const started = await startPreflightedPromptTurn(host, record, {
      content: text,
      inputId: envelope.commandId,
      intent,
      ...(requireQueue
        ? { requireQueue: true }
        : highspeed
          ? { modelExecution: createModelExecutionContext(highspeed.execution) }
          : {}),
      ...(attachments ? { attachments } : {}),
    });
    if (requireQueue && started.admission.kind !== "queued") {
      throw new Error("edited input was not admitted to the queue");
    }
  } catch (error) {
    if (canRetainQueuedHighspeed) {
      host.deleteQueuedTurnExecution?.(record.app.sessionId, envelope.commandId);
    }
    throw error;
  }
}

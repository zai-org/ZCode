// fork/edit/retry 命令组：forkAssistant / editUserQuery / retryTurn。
// 共同点：都以 {rowId, entityId} 定位历史实体，经 host 的 v4 投影翻译面换成 transcript messageId
// （翻译是 v4 原生决策，翻译不到直接 reject，绝不静默兜底 latestCheckpoint——会错点）。
// - editUserQuery = 换文本的 retryTurn：rewind 截断该 turn → 原生 prompt turn 重发新文本。
// - retryTurn = rewind 截断 + 重发原 user prompt（原文必须在 rewind 前解析，截断后拿不到）。
// - forkAssistant = stable resolver + conversation-only copy；running parent 与 workspace 不动。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import {
  RewindStrategy,
  traceContextToLogContext,
  type MessageId,
  type TurnId,
} from "@zcode/contracts";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { V4PromptRejectedError } from "../prompt-turn.js";
import { commandAdmissionOf } from "../executor.js";
import { hasPromptInput, V4InputAdmissionRejectedError } from "../input-admission.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  preflightCanonicalIntent,
  stableAttachmentRefs,
  startCanonicalIntent,
} from "./canonical-intent-replay.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";

const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";
const EDIT_USER_QUERY_COMPLETED_EVENT = "conversation.command.edit_user_query.completed";
const FORK_ASSISTANT_COMPLETED_EVENT = "conversation.command.fork_assistant.completed";

/** row target → messageId 翻译失败（非 assistant 行 / 迟到实体 / 会话无投影）。 */
export class V4RowTranslationError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(command: string, targetRowId: number) {
    super(`${command} targetRowId ${targetRowId} 无法解析到 transcript messageId`);
    this.name = "V4RowTranslationError";
  }
}

/** fork 目标不是所属轮最后一段 assistantText → 明确拒绝。 */
export class V4ForkTargetNotLatestSegmentError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(targetRowId: number) {
    super(
      `forkAssistant targetRowId ${targetRowId} 不是所属轮的最后一段 assistant（fork 只挂轮尾段）`,
    );
    this.name = "V4ForkTargetNotLatestSegmentError";
  }
}

export class V4ForkTargetGuardError extends Error {
  constructor(
    readonly reasonCode: string,
    targetRowId: number,
  ) {
    super(`forkAssistant targetRowId ${targetRowId} 被稳定目标解析器拒绝: ${reasonCode}`);
    this.name = "V4ForkTargetGuardError";
  }
}

/** latestQueryEditOnly：旧 row / 非 realUser row / 无投影均直接拒绝，不 stop 当前 turn。 */
export class V4EditTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestQueryEditOnly";

  constructor(targetRowId: number) {
    super(`editUserQuery targetRowId ${targetRowId} 不是最后一轮 real user query`);
    this.name = "V4EditTargetNotLatestError";
  }
}

/** latestAssistantRetryOnly：历史 assistant 回复 retry 会回退 active branch，必须拒绝。 */
export class V4RetryTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestAssistantRetryOnly";

  constructor(targetRowId: number) {
    super(`retryTurn targetRowId ${targetRowId} 不是最后一轮 assistant 回复`);
    this.name = "V4RetryTargetNotLatestError";
  }
}

/**
 * rewind 截断（直驱 core）：edit/retry 不再伪造 `/rewind` slash turn，而是
 * 直接提交 same-session active branch cut。workspaceMode=rewind 会在文件写入全部
 * 成功后，于同一 commit gate 调用这个 primitive。
 *
 * 组合 rewind 过去在 file transaction callback 中调用 app.submitPrompt，
 * 它会把 `/rewind` 再排入 runtime command queue；当前 edit 命令等待回调，
 * 嵌套 rewind 又等待当前命令释放队列，最终 UI 永久停在编辑态。
 * 完成后 legacy 广播 session_rewound（过渡钩子，旧侧栏消费者感知；v4 投影走
 * RewindTriggered 事件自收口，不依赖本广播）。
 */
async function submitConversationRewind(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  anchorMessageId: string,
): Promise<void> {
  const result = await record.app.runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: anchorMessageId as MessageId,
    traceContext: record.traceContext,
  });
  if (result.strategy !== RewindStrategy.ActiveChain) {
    throw new Error(`conversation rewind unavailable for ${anchorMessageId}: ${result.strategy}`);
  }
  await host.afterLegacyStateMutation?.(record, "session_rewound");
}

/**
 * editUserQuery：target 是 user 实体，用其 canonical transcript messageId 作 rewind
 * 锚点 → 整段截断 → 原生 prompt turn 重发 newText。
 * 附件命令面：attachments（AttachmentRef → TurnAttachment）随重发提交。
 */
async function editUserQuery(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "editUserQuery",
  );
  if (!resolution?.ok || !resolution.editTarget) {
    throw new V4EditTargetNotLatestError(payload.target.rowId);
  }
  const editTarget = resolution.editTarget;
  const attachmentRefs = payload.attachments ?? stableAttachmentRefs(editTarget);
  // attachments 缺省与 [] 语义不同；必须基于 effective refs 校验，
  // 才能同时允许 attachment-only edit，并在正文和附件都被清空时于 rewind 前拒绝。
  if (
    !hasPromptInput(payload.newText, attachmentRefs) &&
    !(payload.conversationQuotes ?? editTarget.intent.conversationQuotes)?.length
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  // 附件映射在 rewind 前完成：引用失效要在截断历史之前暴露，避免半程失败。
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  // 编辑重发按新的主动发送处理：只认本次重新 prepare 的卡（本会话 taskId、未过期），
  // 且 Selection 必须真的指向加速 Provider，避免拿旧凭据或跨会话卡加速。
  const highspeedEdit =
    editTarget.intent.kind === "sendText" &&
    payload.highspeedMeta !== undefined &&
    payload.highspeedMeta.taskId === record.app.sessionId &&
    payload.highspeedMeta.expiresAt > Date.now() &&
    payload.modelSelection !== undefined &&
    payload.modelExecution !== undefined &&
    isHighspeedProviderId(payload.modelSelection.providerId)
      ? {
          card: payload.highspeedMeta,
          modelSelection: payload.modelSelection,
          execution: payload.modelExecution,
        }
      : undefined;
  // Bug 根因：模型检查曾位于 branch cut 之后；modelUnavailable 会留下已持久化的历史截断，
  // workspaceMode=rewind 还会先改文件。必须用本次真正重发的 canonical intent 在所有破坏性操作前预检。
  await preflightCanonicalIntent(
    host,
    record,
    envelope,
    editTarget,
    payload.newText,
    attachmentRefs,
    attachments,
    highspeedEdit,
  );
  const runtimeHasActiveTurn =
    record.app.runtime?.getActiveTurnInfo?.() !== undefined ||
    record.app.runtime?.getActiveForegroundExecutionId?.() !== undefined;
  if (record.activeAbortController || runtimeHasActiveTurn) {
    // Bug 根因：Highspeed/notification turn 由 Core runtime 持有时没有 Bootstrap
    // activeAbortController；只检查后者会让 rewind 与旧模型请求并发，随后新 prompt 被
    // turn_not_steerable 拒绝。必须把 runtime-owned active turn 也纳入 preempt barrier。
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 editUserQuery preempts active turn",
      goalPausedMutationReason: "edit_user_query_goal_paused",
    });
  }
  let conversationRewindCommitted = false;
  if ((payload.workspaceMode ?? "preserve") === "rewind") {
    const turnMessageIds = resolution.messageIds ??
      host.getMessageIdsForTurnRow?.(record.app.sessionId, resolution.row.rowId) ?? [
        editTarget.transcriptMessageId,
      ];
    const fileOptions = {
      targetMessageIds: turnMessageIds as MessageId[],
      targetTurnId: resolution.row.turnId as TurnId,
      traceContext: record.traceContext,
    };
    const preview = await record.app.runtime.previewWorkspaceFileRewind(fileOptions);
    // shell/ignored 变更无法证明完整回滚。组合模式 fail closed，并把最新 preview 原样返回 UI。
    if (!preview.canApply || preview.ignoredFiles.length > 0 || preview.safeFiles.length === 0) {
      const reasonCode =
        preview.unsafeFiles.length > 0
          ? "guard.workspaceRewindUnsafeFiles"
          : preview.ignoredFiles.length > 0
            ? "guard.workspaceRewindIgnoredFiles"
            : preview.safeFiles.length === 0
              ? "guard.workspaceRewindUnavailable"
              : "guard.workspaceRewindApplyConflict";
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        reasonCode,
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode,
        preview,
      };
    }
    const applied = await record.app.runtime.applyWorkspaceFileRewind({
      ...fileOptions,
      commitAfterApply: async () => {
        await submitConversationRewind(host, record, editTarget.transcriptMessageId);
        conversationRewindCommitted = true;
      },
    });
    if (!applied.applied) {
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        "guard.workspaceRewindApplyConflict",
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode: "guard.workspaceRewindApplyConflict",
        preview: applied.preview,
      };
    }
  }
  if (!conversationRewindCommitted) {
    await submitConversationRewind(host, record, editTarget.transcriptMessageId);
  }
  try {
    await startCanonicalIntent(
      host,
      record,
      envelope,
      editTarget,
      payload.newText,
      attachmentRefs,
      attachments,
      highspeedEdit,
    );
  } catch (error) {
    if (
      editTarget.intent.kind === "sendText" &&
      error instanceof V4PromptRejectedError &&
      error.reasonCode === "activePrompt"
    ) {
      // Bug 根因：rewind 已经提交后，Core 仍可能在收口旧 turn，带加速执行材料的 admission
      // 不能 steer，只会返回 turn_not_steerable。此时必须把新文本原子入队，
      // 否则旧消息已被截断而新消息会随异常一起丢失。
      host.logger?.warn?.("v4 editUserQuery admission recovered by queue", {
        reason: error.message,
        sessionId: record.app.sessionId,
        targetRowId: payload.target.rowId,
      });
      await startCanonicalIntent(
        host,
        record,
        envelope,
        editTarget,
        payload.newText,
        attachmentRefs,
        attachments,
        highspeedEdit,
        { requireQueue: true },
      );
    } else {
      throw error;
    }
  }
  // Bugfix：生产 renderer 不落日志，过去只能从通用 rewind + send 猜测发生过编辑，
  // 无法与 retry 稳定区分。命令副作用完成后由 Agent server 写低频 info 审计索引。
  host.logger?.info?.("v4 editUserQuery completed", {
    ...traceContextToLogContext(record.traceContext),
    attachmentCount: attachmentRefs?.length ?? 0,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: EDIT_USER_QUERY_COMPLETED_EVENT,
    intentKind: editTarget.intent.kind,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode: payload.workspaceMode ?? "preserve",
  });
  return {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: record.app.sessionId,
  };
}

/**
 * retryTurn：assistant target → canonical 输入 messageId → rewind 截断 + 重发
 * canonical user intent。intent 在 projection resolver 阶段、rewind **之前**完成解析，
 * 截断后不再回读可见文本或 transcript parent 猜测原输入。
 */
async function retryTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["retryTurn"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "retryTurn",
  );
  if (!resolution?.ok || !resolution.messageId || !resolution.editTarget) {
    throw new V4RetryTargetNotLatestError(payload.target.rowId);
  }
  const attachmentRefs = stableAttachmentRefs(resolution.editTarget);
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  // retry 与 edit 共用破坏性 branch cut；模型不可用时必须保留原活动分支。
  await preflightCanonicalIntent(
    host,
    record,
    envelope,
    resolution.editTarget,
    resolution.editTarget.intent.text,
    attachmentRefs,
    attachments,
  );
  // 从 assistant 就近回溯 user 会误选中途的合成提醒；使用已解析的原始输入边界。
  await submitConversationRewind(host, record, resolution.editTarget.transcriptMessageId);
  await startCanonicalIntent(
    host,
    record,
    envelope,
    resolution.editTarget,
    resolution.editTarget.intent.text,
    attachmentRefs,
    attachments,
  );
  return undefined;
}

/**
 * forkAssistant：唯一 stable resolver 固定 logical-turn/message boundary，再走
 * conversation-only fork。此路径不读取 activeAbortController、不 stop parent，也不进入
 * legacy forkSession（后者含 ensureNoActiveTurn + workspace rewind）。
 */
async function forkAssistant(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["forkAssistant"];
  const record = requireRecord(host, envelope.sessionId);
  const targetResolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "forkAssistant",
  );
  if (!targetResolution?.ok) {
    throw new V4ForkTargetGuardError("guard.forkTargetNotStable", payload.target.rowId);
  }
  if (!host.resolveStableForkTarget) {
    throw new Error("v4 forkAssistant requires host.resolveStableForkTarget capability");
  }
  const resolution = await host.resolveStableForkTarget(record.app.sessionId, payload.target.rowId);
  if (!resolution.ok) {
    throw new V4ForkTargetGuardError(resolution.reasonCode, payload.target.rowId);
  }
  if (!host.forkStableConversation) {
    throw new Error("v4 forkAssistant requires host.forkStableConversation capability");
  }
  const { forkedSessionId } = await host.forkStableConversation(record.app.sessionId, {
    target: resolution.target,
    goalBoundary: resolution.goalBoundary,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    // 目标 cwd 只改变 child 的执行目录；仍是 conversation-only fork，不触发 checkpoint 回退。
    ...(payload.targetCwd ? { targetCwd: payload.targetCwd } : {}),
  });
  // fork 完成事实过去只在 session event/debug 中，生产默认 JSONL 无法直接检索。
  // child 已创建并完成宿主注册后再写 info，避免把被拒绝或失败的请求误记为成功。
  host.logger?.info?.("v4 forkAssistant completed", {
    ...traceContextToLogContext(record.traceContext),
    childSessionId: forkedSessionId,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: FORK_ASSISTANT_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    parentSessionId: record.app.sessionId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
    targetBoundaryMessageId: resolution.target.boundaryMessageId,
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    ...(payload.targetCwd ? { targetCwd: payload.targetCwd.cwd } : {}),
  });
  const result = { type: "forkAssistant" as const, sessionId: forkedSessionId };
  return result;
}

export const forkEditRetryHandlers = {
  forkAssistant,
  editUserQuery,
  retryTurn,
};

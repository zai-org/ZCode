/* eslint-disable max-lines -- rewind message primitive 与 cascade 封装共享 conversation/workspace 语义，避免拆分时误改原 /rewind 行为。 */
import {
  RewindScope,
  RewindStrategy,
  SessionEventType,
  activeSessionMessages,
  createMessageId,
  evaluateRewindTarget,
  hydrateMessageHistoryFromSession,
  hydrateReadFileStateFromSession,
  parseWorkspaceCheckpointArtifact,
  selectActiveConversationBranch,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  MessageWithParts,
  SessionEvent,
  TraceContext,
  TurnId,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  activeSuffixMessageIdsForRewind,
  buildMessageRewindEvaluationItems,
  createTurnCancelledError,
  formatUnavailableRewindResponse,
  formatWorkspaceRewindNoticeBody,
  getLatestActiveSessionMessageId,
  isHiddenReminderMessage,
  isTurnCancellationError,
  selectCheckpointForMessage,
  selectCheckpointsForMessages,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type {
  ConversationRewindResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { mainTurnCacheHitAggregateFromMessages } from "./turn-model-step-usage.js";

export async function rewindToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult | WorkspaceRewindResult> {
  if (options.scope === RewindScope.Workspace) {
    return this.rewindWorkspaceToMessage(options);
  }

  if (options.scope === RewindScope.Both) {
    const workspace = await this.rewindWorkspaceToMessage(options);
    if (workspace.strategy !== RewindStrategy.ActiveChain) {
      return workspace;
    }
    const conversation = await this.rewindConversationToMessage(options);
    return {
      ...conversation,
      response: `${workspace.response}\n${conversation.response}`,
    };
  }

  return this.rewindConversationToMessage(options);
}

export async function rewindCascadeToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult | WorkspaceRewindResult> {
  if (options.scope === RewindScope.Workspace) {
    return rewindWorkspaceCascadeToMessage.call(this, options);
  }

  if (options.scope === RewindScope.Both) {
    const conversationPlan = await buildConversationRewindPlan.call(this, options);
    if (conversationPlan.kind === "unavailable") {
      return finishUnavailableConversationRewind.call(this, {
        evaluation: conversationPlan.evaluation,
        events: options.events,
        reason: conversationPlan.reason,
        rewindId: conversationPlan.rewindId,
        targetMessageId: options.targetMessageId,
        traceContext: options.traceContext,
      });
    }

    const workspace = await rewindWorkspaceCascadeToMessage.call(this, options);
    if (workspace.strategy !== RewindStrategy.ActiveChain) {
      return workspace;
    }
    const conversation = await applyConversationRewindPlan.call(this, {
      abortSignal: options.abortSignal,
      events: options.events,
      plan: conversationPlan,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
    return {
      ...conversation,
      response: `${workspace.response}\n${conversation.response}`,
    };
  }

  return this.rewindConversationToMessage(options);
}

export async function rewindWorkspaceToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const checkpoint = selectCheckpointForMessage(sessionEvents, options.targetMessageId);
  if (!checkpoint) {
    return this.finishUnavailableRewind({
      events: options.events,
      reason: "target_checkpoint_not_found",
      rewindId: `rewind_${crypto.randomUUID()}`,
      scope: options.scope,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  return this.rewindWorkspaceToCheckpoint({
    abortSignal: options.abortSignal,
    events: options.events,
    targetCheckpointId: checkpoint.checkpointId,
    traceContext: options.traceContext,
  });
}

async function rewindWorkspaceCascadeToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const activeMessages = await readActiveMessagesForWorkspaceRewind.call(this);
  const suffixMessageIds = activeSuffixMessageIdsForRewind(activeMessages, options.targetMessageId);
  const checkpoints = selectCheckpointsForMessages(
    sessionEvents,
    suffixMessageIds.length > 0 ? suffixMessageIds : [options.targetMessageId],
  );
  if (checkpoints.length === 0) {
    return this.finishUnavailableRewind({
      events: options.events,
      reason: "target_checkpoint_not_found",
      rewindId: `rewind_${crypto.randomUUID()}`,
      scope: options.scope,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  if (checkpoints.length === 1) {
    return this.rewindWorkspaceToCheckpoint({
      abortSignal: options.abortSignal,
      events: options.events,
      targetCheckpointId: checkpoints[0]!.checkpointId,
      traceContext: options.traceContext,
    });
  }

  return rewindWorkspaceToCheckpoints.call(this, {
    abortSignal: options.abortSignal,
    checkpoints,
    events: options.events,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext,
  });
}

async function readActiveMessagesForWorkspaceRewind(
  this: AgentRuntimeInternal,
): Promise<MessageWithParts[]> {
  if (!this.sessionStore) return [];

  const session = await this.sessionStore.getSession(this.sessionId);
  const persistedMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  return activeSessionMessages(persistedMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
}

async function rewindWorkspaceToCheckpoints(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    checkpoints: CheckpointCreatedPayload[];
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  const baselineCheckpoint = options.checkpoints[0]!;
  const latestCheckpoint = options.checkpoints.at(-1)!;
  const rewindId = `rewind_${crypto.randomUUID()}`;

  if (!this.artifactStore || !this.fileSystemPort) {
    return this.finishUnavailableRewind({
      checkpoint: latestCheckpoint,
      events: options.events,
      reason: !this.artifactStore
        ? "artifact_store_not_configured"
        : "file_system_port_not_configured",
      rewindId,
      targetCheckpointId: latestCheckpoint.checkpointId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  const evaluation = evaluateRewindTarget({
    checkpointAvailable: true,
    items: buildMessageRewindEvaluationItems(await readActiveMessagesForWorkspaceRewind.call(this)),
    scope: RewindScope.Workspace,
    targetMessageId: options.targetMessageId,
  });

  if (
    evaluation.strategy !== RewindStrategy.ActiveChain &&
    evaluation.strategy !== RewindStrategy.FileOnly
  ) {
    return this.finishUnavailableRewind({
      checkpoint: latestCheckpoint,
      evaluation,
      events: options.events,
      reason: evaluation.reason,
      rewindId,
      targetCheckpointId: latestCheckpoint.checkpointId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  const checkpointsToRestore = [...options.checkpoints].reverse();
  const artifacts: Array<{
    checkpoint: CheckpointCreatedPayload;
    artifact: WorkspaceCheckpointArtifact;
  }> = [];
  for (const checkpoint of checkpointsToRestore) {
    throwIfTurnAborted(options.abortSignal);
    try {
      artifacts.push({
        checkpoint,
        artifact: await readWorkspaceCheckpointArtifact.call(this, {
          checkpoint,
          traceContext: options.traceContext,
          abortSignal: options.abortSignal,
        }),
      });
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        throw createTurnCancelledError(error);
      }
      this.logger?.warn("Workspace cascade rewind checkpoint read failed", {
        ...traceContextToLogContext(options.traceContext),
        checkpointId: checkpoint.checkpointId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "rewind.cascade.snapshot.read.failed",
        module: "core.runtime",
        snapshotRef: checkpoint.snapshotRef,
        status: "failed",
      });
      return this.finishUnavailableRewind({
        checkpoint,
        events: options.events,
        reason: "checkpoint_snapshot_unavailable",
        rewindId,
        targetCheckpointId: checkpoint.checkpointId,
        targetMessageId: options.targetMessageId,
        traceContext: options.traceContext,
      });
    }
  }

  const restoredFiles: WorkspaceRewindRestoredFile[] = [];
  for (const { artifact } of artifacts) {
    throwIfTurnAborted(options.abortSignal);
    // cascade 是 UI 消息级撤销的外置高阶接口。一个消息级撤销可能跨过多个
    // 文件变更 checkpoint。先完整读取全部 artifact，再按创建顺序倒序写文件；这样
    // artifact 缺失/损坏这类可预见失败不会发生在 workspace 已经半回退之后。
    restoredFiles.push(
      ...(await this.restoreWorkspaceCheckpointArtifact(
        artifact,
        options.traceContext,
        options.abortSignal,
      )),
    );
  }

  const createdMessageId = createMessageId();
  const noticeBody = `${formatWorkspaceRewindNoticeBody({
    checkpoint: baselineCheckpoint,
    evaluation,
    restoredFiles,
    rewindId,
  })}\nrestoredCheckpoints: ${options.checkpoints.length}`;
  await this.persistSyntheticUserNotice(createdMessageId, noticeBody, options.traceContext);
  this.messageHistory.addAttachment("rewind_notice", noticeBody);

  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Workspace,
      strategy: evaluation.strategy,
      targetMessageId: options.targetMessageId,
      targetCheckpointId: baselineCheckpoint.checkpointId,
      compactBoundaryId: evaluation.compactBoundaryId,
      restoredSnapshotRef: baselineCheckpoint.snapshotRef,
      createdMessageId,
      reason: evaluation.reason,
    },
    options.traceContext,
  );
  await this.appendEvent(event, options.traceContext);
  options.events.push(event);

  const fileText = `${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"}`;
  const checkpointText = `${options.checkpoints.length} checkpoint${options.checkpoints.length === 1 ? "" : "s"}`;
  const strategyText =
    evaluation.strategy === RewindStrategy.FileOnly
      ? " Workspace files were restored; conversation history stayed at the compacted context."
      : "";

  return {
    checkpoint: baselineCheckpoint,
    evaluation,
    restoredFiles,
    response: `Rewound workspace through ${checkpointText} to checkpoint ${baselineCheckpoint.checkpointId}: restored ${fileText}.${strategyText}`,
    rewindId,
    strategy: evaluation.strategy,
  };
}

async function readWorkspaceCheckpointArtifact(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    checkpoint: CheckpointCreatedPayload;
    traceContext: TraceContext;
  },
): Promise<WorkspaceCheckpointArtifact> {
  const read = await this.artifactStore!.readToolResultArtifact(
    {
      uri: options.checkpoint.snapshotRef,
      trace: options.traceContext,
    },
    { signal: options.abortSignal },
  );
  return parseWorkspaceCheckpointArtifact(JSON.parse(read.content));
}
type ConversationRewindPlan =
  | {
      // ConversationRewindResult.evaluation 是对外结果的可选字段，
      // 但 available plan 已经完成 active-chain 校验，后续落事件必须有 evaluation。
      evaluation: NonNullable<ConversationRewindResult["evaluation"]>;
      branchCutAfterMessageId: MessageId;
      branchGeneration: number;
      keptMessages: MessageWithParts[];
      kind: "available";
      persistedMessages: MessageWithParts[];
      removedTurnIds: string[];
      removedMessageIds: string[];
      rewindId: string;
    }
  | {
      evaluation?: NonNullable<ConversationRewindResult["evaluation"]>;
      kind: "unavailable";
      reason: string;
      rewindId: string;
    };

export async function rewindConversationToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope?: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult> {
  const plan = await buildConversationRewindPlan.call(this, {
    targetMessageId: options.targetMessageId,
    // 仅纯 conversation scope 开启 assistant 锚点回溯（v4 edit/retry 路径）；
    // both/cascade 的显式流保持严格目标校验。
    remapAssistantAnchor: options.scope === undefined || options.scope === RewindScope.Conversation,
  });
  if (plan.kind === "unavailable") {
    return finishUnavailableConversationRewind.call(this, {
      evaluation: plan.evaluation,
      events: options.events,
      reason: plan.reason,
      rewindId: plan.rewindId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  return applyConversationRewindPlan.call(this, {
    abortSignal: options.abortSignal,
    events: options.events,
    plan,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext,
  });
}

async function buildConversationRewindPlan(
  this: AgentRuntimeInternal,
  options: {
    targetMessageId: MessageId;
    /**
     * assistant 锚点回溯映射开关：仅纯 conversation scope（v4 editUserQuery/retryTurn
     * 的 `/rewind conversation <assistantMessageId>`）开启；cascade/both 的显式 TUI
     * 流保持严格 user prompt 目标校验（precheck reject，不隐式扩大回滚范围）。
     */
    remapAssistantAnchor?: boolean;
  },
): Promise<ConversationRewindPlan> {
  const rewindId = `rewind_${crypto.randomUUID()}`;
  if (!this.sessionStore) {
    return {
      kind: "unavailable",
      reason: "conversation_rewind_requires_session_store",
      rewindId,
    };
  }

  const session = await this.sessionStore.getSession(this.sessionId);
  const persistedMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  // rewind target 可以位于当前 compact boundary 之前。定位 edit target 时只能
  // 应用 append-only branch cut，compact scope 只用于 provider history，不能提前隐藏 target。
  const activeMessages = selectActiveConversationBranch(persistedMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  const requestedIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  // v4 editUserQuery/retryTurn 使用同一 turn 的 assistant messageId 作为 rewind 锚点，
  // 因为 user 行没有稳定的 messageId。将该锚点回溯到所属 turn 的 user prompt，
  // 让持久消息与运行时历史都从该 prompt 开始截断，避免编辑重跑或冷恢复时带回旧分支。
  let targetIndex = requestedIndex;
  if (
    options.remapAssistantAnchor === true &&
    requestedIndex >= 0 &&
    !isRewindableUserPrompt(activeMessages[requestedIndex]!)
  ) {
    targetIndex = -1;
    for (let index = requestedIndex - 1; index >= 0; index -= 1) {
      if (isRewindableUserPrompt(activeMessages[index]!)) {
        targetIndex = index;
        break;
      }
    }
  }
  const effectiveTargetMessageId =
    targetIndex >= 0 ? activeMessages[targetIndex]!.info.id : options.targetMessageId;
  const evaluation = evaluateRewindTarget({
    items: buildMessageRewindEvaluationItems(activeMessages),
    scope: RewindScope.Conversation,
    targetMessageId: effectiveTargetMessageId,
  });

  if (evaluation.strategy !== RewindStrategy.ActiveChain || targetIndex < 0) {
    return {
      evaluation,
      kind: "unavailable",
      reason:
        targetIndex < 0
          ? requestedIndex < 0
            ? "target_message_not_found"
            : "target_message_is_not_user_prompt"
          : evaluation.reason,
      rewindId,
    };
  }

  const targetMessage = activeMessages[targetIndex]!;
  if (!isRewindableUserPrompt(targetMessage)) {
    // 严格路径（remapAssistantAnchor 未开启）：非 user prompt 目标维持 precheck reject。
    return {
      evaluation,
      kind: "unavailable",
      reason: "target_message_is_not_user_prompt",
      rewindId,
    };
  }

  return {
    evaluation,
    branchCutAfterMessageId: persistedMessages.at(-1)!.info.id as MessageId,
    branchGeneration: (session?.revert?.branchGeneration ?? 0) + 1,
    keptMessages: activeMessages.slice(0, targetIndex),
    kind: "available",
    persistedMessages,
    removedMessageIds: activeMessages.slice(targetIndex).map((message) => String(message.info.id)),
    removedTurnIds: activeMessages
      .slice(targetIndex)
      .flatMap((message) =>
        message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
      ),
    rewindId,
  };
}

async function applyConversationRewindPlan(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    plan: Extract<ConversationRewindPlan, { kind: "available" }>;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult> {
  throwIfTurnAborted(options.abortSignal);
  const {
    branchCutAfterMessageId,
    branchGeneration,
    evaluation,
    keptMessages,
    persistedMessages,
    removedTurnIds,
    removedMessageIds,
    rewindId,
  } = options.plan;
  await cancelRemovedBranchBackgroundTasks.call(this, {
    removedTurnIds,
    traceContext: options.traceContext,
  });
  await this.sessionStore!.setRevert({
    sessionID: this.sessionId,
    revert: {
      // 只保存 target/created 无法在连续编辑或重启后还原旧 rewind 前缀。
      // keptMessageIDs 保存的是本次 rewind 前 active branch 的保留前缀，避免旧分支重新浮出。
      keptMessageIDs: keptMessages.map((message) => message.info.id as MessageId),
      branchCutAfterMessageID: branchCutAfterMessageId,
      branchGeneration,
      messageID: keptMessages.at(-1)?.info.id ?? options.targetMessageId,
      kind: "conversation_rewind",
      scope: RewindScope.Conversation,
      targetMessageID: options.targetMessageId,
    },
  });
  this.branchGeneration = branchGeneration;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(branchGeneration);

  await rebuildConversationDerivedState.call(this, {
    branchCutAfterMessageId,
    keptMessageIds: keptMessages.map((message) => message.info.id as MessageId),
    persistedMessages,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext,
  });

  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Conversation,
      strategy: evaluation.strategy,
      targetMessageId: options.targetMessageId,
      compactBoundaryId: evaluation.compactBoundaryId,
      branchCutAfterMessageId,
      branchGeneration,
      // 完整 child 身份可能没有投影行；用已提交分支的实际后缀证明哪些来源被撤销。
      removedMessageIds,
      reason: evaluation.reason,
    },
    options.traceContext,
  );
  await this.appendEvent(event, options.traceContext);
  options.events.push(event);

  this.logger?.info("Conversation rewind applied", {
    ...traceContextToLogContext(options.traceContext),
    event: "rewind.conversation.completed",
    keptMessageCount: keptMessages.length,
    branchGeneration,
    module: "core.runtime",
    status: "completed",
    targetMessageId: options.targetMessageId,
  });

  return {
    evaluation,
    keptMessageCount: keptMessages.length,
    response: `Rewound conversation to before message ${options.targetMessageId}.`,
    rewindId,
    strategy: evaluation.strategy,
    targetMessageId: options.targetMessageId,
  };
}

async function cancelRemovedBranchBackgroundTasks(
  this: AgentRuntimeInternal,
  options: { removedTurnIds: string[]; traceContext: TraceContext },
): Promise<void> {
  const removed = new Set(options.removedTurnIds);
  if (removed.size === 0) return;
  const tasks = Object.values(this.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.branchGeneration === this.branchGeneration &&
      task.turnId !== undefined &&
      removed.has(String(task.turnId)) &&
      task.status === "running",
  );
  for (const task of tasks) {
    const result = await this.stopBackgroundTask(task.taskId, {
      traceContext: options.traceContext,
    });
    if (!result.ok) {
      // fail closed：无法确认旧分支后台工作已停时，不提交 branch cut，也不碰 workspace。
      throw new Error(`rewind background task cancellation failed: ${task.taskId}`);
    }
  }
}

async function finishUnavailableConversationRewind(
  this: AgentRuntimeInternal,
  options: {
    evaluation?: NonNullable<ConversationRewindResult["evaluation"]>;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult> {
  // 失败/冲突不是一次已经提交的 branch cut，不能伪造 RewindTriggered。
  // 否则 live projection 会裁 UI，而 store/provider history 仍保留旧分支。
  return {
    evaluation: options.evaluation,
    keptMessageCount: 0,
    response: formatUnavailableRewindResponse(options.reason, undefined, options.targetMessageId),
    rewindId: options.rewindId,
    strategy: options.evaluation?.strategy ?? RewindStrategy.Unavailable,
    targetMessageId: options.targetMessageId,
  };
}

async function rebuildConversationDerivedState(
  this: AgentRuntimeInternal,
  options: {
    branchCutAfterMessageId: MessageId;
    keptMessageIds: MessageId[];
    persistedMessages: MessageWithParts[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const branchOptions = {
    branchCutAfterMessageId: options.branchCutAfterMessageId,
    rewindKeptMessageIds: options.keptMessageIds,
    rewindTargetMessageId: options.targetMessageId,
  };

  // branch 重建，避免 compact/microcompact/read cache 或 provider usage 泄漏旧分支。
  this.messageHistory.reset();
  await hydrateMessageHistoryFromSession({
    artifactStore: this.artifactStore,
    history: this.messageHistory,
    messages: options.persistedMessages,
    ...branchOptions,
  });
  await hydrateReadFileStateFromSession({
    messages: options.persistedMessages,
    readFileState: this.readFileState,
    // rewind 不重新加载 context：保留会话开始写入的 MEMORY.md 记录。
    retainContextSeeds: true,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
    ...branchOptions,
  });
  rebuildContextPrefix(this);
  this.injectTargetStateIntoMessageHistory(
    await this.readSessionTargetForContext(options.traceContext),
  );

  const activeMessages = activeSessionMessages(options.persistedMessages, branchOptions);
  const timelineActiveMessages = activeSessionMessages(options.persistedMessages, {
    ...branchOptions,
    includeCompactPreservedSegment: false,
  });
  const latestAssistant = [...timelineActiveMessages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  this.latestConversationMessageId = getLatestActiveSessionMessageId(timelineActiveMessages);
  this.latestAssistantMessageId = latestAssistant?.info.id;
  this.latestAssistantTurnId = latestAssistant?.info.anchor?.turnId as TurnId | undefined;
  this.lastAssistantCompletedAtMs =
    latestAssistant && "completed" in latestAssistant.info.time
      ? latestAssistant.info.time.completed
      : undefined;
  this.messageHistory.setCacheMiss();
  this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages({
    activeMessages,
    persistedMessages: options.persistedMessages,
  });
  this.turnNumber = activeMessages.filter(isRewindableUserPrompt).length;
  this.currentTurnFileChanges = new Map();
  this.autoCompactConsecutiveFailures = 0;
}

// 修复原因：隐藏提醒写在用户输入与 assistant 之间。assistant 锚点回溯停在它上面，旧输入留在历史里；
// turnNumber 也把它算成一轮，冷恢复比 live 大。它不是对话消息，两处都跳过。
function isRewindableUserPrompt(message: MessageWithParts): boolean {
  return message.info.role === "user" && !message.info.summary && !isHiddenReminderMessage(message);
}

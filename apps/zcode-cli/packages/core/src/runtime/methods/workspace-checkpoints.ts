import {
  CoreErrorType,
  RewindScope,
  RewindStrategy,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  getCurrentTraceContext,
  parseCheckpointCreatedPayload,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  MessageId,
  MessageWithParts,
  SessionId,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointForRewind,
  previewTextFromMessage,
  formatWorkspaceForkNoticeBody,
  cloneMessageForFork,
  clonePartForFork,
} from "../helpers/index.js";
import {
  buildForkHistoryMessages,
  copyGoalStateForFork,
  createForkedSession,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
} from "./session-fork.js";
import { forkWorkspaceAtMessage, restoreWorkspaceCheckpointFiles } from "./workspace-fork.js";
import { buildForkEnvironmentUpdate } from "../session-fork-commit/index.js";
import type {
  WorkspaceRewindRestoredFile,
  WorkspaceForkResult,
  WorkspaceCheckpointSummary,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function restoreWorkspaceCheckpointArtifact(
  this: AgentRuntimeInternal,
  artifact: WorkspaceCheckpointArtifact,
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<WorkspaceRewindRestoredFile[]> {
  return await restoreWorkspaceCheckpointFiles(this, artifact.files, traceContext, abortSignal);
}

export async function copySessionMessagesForFork(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId: SessionId;
    messages: MessageWithParts[];
    traceContext: TraceContext;
  },
): Promise<{
  copiedMessageCount: number;
  messageIdMap: Map<MessageId, MessageId>;
}> {
  if (!this.sessionStore) {
    return { copiedMessageCount: 0, messageIdMap: new Map() };
  }

  const messageIdMap = new Map<MessageId, MessageId>();
  let copied = 0;
  for (const message of options.messages) {
    const nextMessageId = createMessageId();
    messageIdMap.set(message.info.id, nextMessageId);
    await this.persistMessage(
      cloneMessageForFork(message.info, {
        forkedSessionId: options.forkedSessionId,
        messageIdMap,
        nextMessageId,
      }),
      options.traceContext,
      { sessionID: message.info.sessionID, id: message.info.id },
    );

    for (const part of message.parts) {
      await this.persistPart(
        clonePartForFork(part, {
          forkedSessionId: options.forkedSessionId,
          nextMessageId,
          messageIdMap,
        }),
        options.traceContext,
        { sessionID: part.sessionID, id: part.id },
      );
    }
    copied += 1;
  }

  // 修复原因：Gen UI 目录随 session id 变化，写在环境公告里；legacy fork 原来只复制消息，child 历史里
  // 是父会话的目录。child 第一个请求若不收集输入附件（如新轮通知），模型会把文件写进父会话目录，
  // 不在 child 自己的目录里。与原子 fork 一样，在复制的消息之后、分割线和 fork 提示之前写一条子会话的环境
  // 更新：目录换成 child 的，Desktop 段按当前运行面重新取（三条 legacy 路径都经过这里复制历史）；
  // 不计入复制条数。
  const environmentUpdate = buildForkEnvironmentUpdate(
    this,
    options.messages,
    options.forkedSessionId,
    undefined,
  );
  if (environmentUpdate) {
    await this.persistMessage(environmentUpdate.info, options.traceContext);
    for (const part of environmentUpdate.parts) {
      await this.persistPart(part, options.traceContext);
    }
  }

  return { copiedMessageCount: copied, messageIdMap };
}

export async function listWorkspaceCheckpoints(
  this: AgentRuntimeInternal,
  options: { limit?: number } = {},
): Promise<WorkspaceCheckpointSummary[]> {
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const previews = await this.loadCheckpointMessagePreviews();
  const summaries = sessionEvents
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => {
      const checkpoint = parseCheckpointCreatedPayload(event.payload);
      return { checkpoint, timestamp: event.timestamp };
    })
    .filter(
      ({ checkpoint }) =>
        checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both,
    )
    .map(({ checkpoint, timestamp }) => ({
      checkpointId: checkpoint.checkpointId,
      compactBoundaryId: checkpoint.compactBoundaryId,
      coveredByCompact: checkpoint.coveredByCompact,
      createdAt: timestamp,
      diffRef: checkpoint.diffRef,
      fileCount: checkpoint.fileCount,
      messageId: checkpoint.messageId,
      targetMessageId: checkpoint.targetMessageId,
      toolMessageId: checkpoint.toolMessageId,
      preview: previews.get(checkpoint.targetMessageId ?? checkpoint.messageId),
      scope: checkpoint.scope,
      snapshotRef: checkpoint.snapshotRef,
    }))
    .reverse();

  return options.limit && options.limit > 0 ? summaries.slice(0, options.limit) : summaries;
}

export async function forkWorkspaceFromCheckpoint(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  } = {},
): Promise<WorkspaceForkResult> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;

  // message 目标的 fork 语义是"历史包含目标回合，工作区停在 fork 点时刻"。
  // 恢复目标回合自身 checkpoint 的 beforeContent 会把该回合刚产出的文件回退/删除——
  // fork 与父会话共用工作区目录，父会话的产物也随之丢失（在最新回复上分叉时最明显）。
  // message fork 只撤销 fork 点之后的 checkpoint；显式 checkpoint 目标（/fork latest、
  // targetCheckpointId）仍保留"回到该 checkpoint 修改前"的 rewind 式语义。
  if (options.targetMessageId && !options.targetCheckpointId) {
    return await forkWorkspaceAtMessage.call(this, {
      abortSignal: options.abortSignal,
      forkedSessionId: options.forkedSessionId,
      targetMessageId: options.targetMessageId,
      traceContext,
    });
  }

  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const checkpoint = selectCheckpointForRewind(sessionEvents, options.targetCheckpointId);

  if (!checkpoint) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      options.targetCheckpointId
        ? `Checkpoint not found: ${options.targetCheckpointId}`
        : "No workspace checkpoint is available yet.",
      {
        context: {
          targetCheckpointId: options.targetCheckpointId,
          targetMessageId: options.targetMessageId,
        },
        recoverable: true,
      },
    );
  }

  if (!this.sessionStore || !this.artifactStore || !this.fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Fork requires session, artifact, and file-system adapters.",
      {
        context: {
          hasArtifactStore: Boolean(this.artifactStore),
          hasFileSystemPort: Boolean(this.fileSystemPort),
          hasSessionStore: Boolean(this.sessionStore),
        },
        recoverable: true,
      },
    );
  }

  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  const read = await this.artifactStore.readToolResultArtifact(
    {
      uri: checkpoint.snapshotRef,
      trace: traceContext,
    },
    { signal: options.abortSignal },
  );
  const artifact = parseWorkspaceCheckpointArtifact(JSON.parse(read.content));
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  // 编辑重发后 session store 会保留被 rewind 掉的旧分支。
  // fork 复制历史必须基于 active branch，否则子会话会重新带入旧 prompt 和被取消的 assistant。
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetMessageIdResolved = checkpoint.targetMessageId ?? checkpoint.messageId;
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === targetMessageIdResolved,
  );
  if (targetIndex < 0) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      `Checkpoint message not found in session store: ${targetMessageIdResolved}`,
      {
        context: {
          checkpointId: checkpoint.checkpointId,
          messageId: targetMessageIdResolved,
        },
        recoverable: true,
      },
    );
  }

  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
    traceContext,
  });

  const forkHistoryEndIndex = resolveForkHistoryEndIndex(forkSourceMessages, targetIndex, false);
  const forkHistoryMessages = buildForkHistoryMessages(
    parentMessages,
    forkSourceMessages,
    targetIndex,
    forkHistoryEndIndex,
  );
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext,
  });
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext,
  });
  const restoredFiles = await this.restoreWorkspaceCheckpointArtifact(
    artifact,
    traceContext,
    options.abortSignal,
  );
  const copiedTargetMessageId = messageIdMap.get(targetMessageIdResolved);
  const forkTimelineCreated = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(targetMessageIdResolved)}_${checkpoint.checkpointId}_timeline`,
    ),
    parentID: copiedTargetMessageId,
    created: forkTimelineCreated,
    completed: forkTimelineCreated,
    finish: "completed",
    timeline: {
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
      anchorMessageId: copiedTargetMessageId,
      parentSessionId: this.sessionId,
      targetMessageId: targetMessageIdResolved,
      targetCheckpointId: checkpoint.checkpointId,
      restoredFileCount: restoredFiles.length,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatWorkspaceForkNoticeBody({
      checkpoint,
      parentSessionId: this.sessionId,
      restoredFiles,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: targetMessageIdResolved,
        targetCheckpointId: checkpoint.checkpointId,
        restoredFileCount: restoredFiles.length,
      },
    },
    traceContext,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: forkHistoryEndIndex,
      targetMessageId: targetMessageIdResolved,
      targetCheckpointId: checkpoint.checkpointId,
      restoredSnapshotRef: checkpoint.snapshotRef,
      restoredFileCount: restoredFiles.length,
      strategy: RewindStrategy.ForkRequired,
    },
    traceContext,
  );
  await this.appendEvent(forkedEvent, traceContext);

  const response = `Forked session ${forkedSessionId} from checkpoint ${checkpoint.checkpointId}: copied ${copiedMessageCount} messages and restored ${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"}.`;
  return {
    checkpoint,
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: targetMessageIdResolved,
    targetCheckpointId: checkpoint.checkpointId,
    restoredFiles,
    response,
  };
}

export async function loadCheckpointMessagePreviews(
  this: AgentRuntimeInternal,
): Promise<Map<MessageId, string>> {
  if (!this.sessionStore) return new Map();

  const messages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const messagesById = new Map(messages.map((message) => [message.info.id, message]));
  const previews = new Map<MessageId, string>();

  for (const message of messages) {
    const source =
      message.info.role === "assistant" ? messagesById.get(message.info.parentID) : message;
    const preview = source ? previewTextFromMessage(source) : undefined;
    if (preview) {
      previews.set(message.info.id, preview);
    }
  }

  return previews;
}

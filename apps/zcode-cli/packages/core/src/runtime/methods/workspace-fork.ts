import {
  CoreErrorType,
  RewindStrategy,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  MessageId,
  SessionId,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointsForMessages,
  formatWorkspaceForkAtMessageNoticeBody,
  throwIfTurnAborted,
} from "../helpers/index.js";
import {
  buildForkHistoryMessages,
  copyGoalStateForFork,
  createForkedSession,
  forkConversationFromMessage,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
} from "./session-fork.js";
import type { WorkspaceRewindRestoredFile, WorkspaceForkResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function restoreWorkspaceCheckpointFiles(
  runtime: AgentRuntimeInternal,
  files: WorkspaceCheckpointArtifact["files"],
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<WorkspaceRewindRestoredFile[]> {
  if (!runtime.fileSystemPort) {
    throw createCoreError(CoreErrorType.ConfigurationError, "FileSystemPort is not configured", {
      recoverable: true,
    });
  }

  const restoredFiles: WorkspaceRewindRestoredFile[] = [];
  for (const file of files) {
    throwIfTurnAborted(abortSignal);
    if (!file.existedBefore || file.beforeContent === null) {
      await runtime.fileSystemPort.removeFile(
        {
          path: file.path,
          missingOk: true,
          trace: traceContext,
        },
        { signal: abortSignal },
      );
      restoredFiles.push({
        action: "delete",
        path: file.path,
      });
      continue;
    }

    const write = await runtime.fileSystemPort.writeTextFile(
      {
        path: file.path,
        content: file.beforeContent,
        createParents: true,
        atomic: true,
        trace: traceContext,
      },
      { signal: abortSignal },
    );
    restoredFiles.push({
      action: "restore",
      bytesWritten: write.bytesWritten,
      path: file.path,
    });
  }

  return restoredFiles;
}

export async function forkWorkspaceAtMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
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

  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      `Fork target message not found in session store: ${options.targetMessageId}`,
      {
        context: {
          messageId: options.targetMessageId,
        },
        recoverable: true,
      },
    );
  }

  const forkHistoryEndIndex = resolveForkHistoryEndIndex(forkSourceMessages, targetIndex, true);
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  // fork 点之后的 checkpoint 才需要撤销。目标回合自身的 checkpoint 属于已复制的历史，
  // 必须保留其产物；一个 checkpoint 可能同时挂在 assistant / tool 消息上，凡是命中
  // 历史前缀的都按"fork 点之前"处理，避免跨界 turn 被误回退。
  const historyMessageIds = forkSourceMessages
    .slice(0, forkHistoryEndIndex)
    .map((message) => message.info.id);
  const historyCheckpointIds = new Set(
    selectCheckpointsForMessages(sessionEvents, historyMessageIds).map(
      (checkpoint) => checkpoint.checkpointId,
    ),
  );
  const laterMessageIds = forkSourceMessages
    .slice(forkHistoryEndIndex)
    .map((message) => message.info.id);
  const laterCheckpoints = selectCheckpointsForMessages(sessionEvents, laterMessageIds).filter(
    (checkpoint) => !historyCheckpointIds.has(checkpoint.checkpointId),
  );

  if (laterCheckpoints.length === 0) {
    // fork 点之后没有文件变更，工作区已经处于 fork 点状态：等价纯对话 fork，不碰任何文件。
    return await forkConversationFromMessage.call(this, {
      forkedSessionId: options.forkedSessionId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  if (!this.artifactStore || !this.fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Fork requires session, artifact, and file-system adapters.",
      {
        context: {
          hasArtifactStore: Boolean(this.artifactStore),
          hasFileSystemPort: Boolean(this.fileSystemPort),
          hasSessionStore: true,
        },
        recoverable: true,
      },
    );
  }

  // 先读全所有快照、再产生任何副作用：任何一个 artifact 缺失都让 fork 整体失败，
  // 避免文件写到一半停在既不是 fork 点也不是当前态的中间状态。
  const artifacts: WorkspaceCheckpointArtifact[] = [];
  for (const checkpoint of laterCheckpoints) {
    throwIfTurnAborted(options.abortSignal);
    const read = await this.artifactStore.readToolResultArtifact(
      {
        uri: checkpoint.snapshotRef,
        trace: options.traceContext,
      },
      { signal: options.abortSignal },
    );
    artifacts.push(parseWorkspaceCheckpointArtifact(JSON.parse(read.content)));
  }

  // 文件在 fork 点时刻的状态 = fork 点之后第一次变更记录的 before 状态；
  // 同一文件多次变更时只应用最早那份，后面的都被它覆盖。
  const earliestFileByPath = new Map<string, WorkspaceCheckpointArtifact["files"][number]>();
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      if (!earliestFileByPath.has(file.path)) {
        earliestFileByPath.set(file.path, file);
      }
    }
  }

  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
    traceContext: options.traceContext,
  });
  const forkHistoryMessages = buildForkHistoryMessages(
    parentMessages,
    forkSourceMessages,
    targetIndex,
    forkHistoryEndIndex,
  );
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext: options.traceContext,
  });
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext: options.traceContext,
  });
  const restoredFiles = await restoreWorkspaceCheckpointFiles(
    this,
    Array.from(earliestFileByPath.values()),
    options.traceContext,
    options.abortSignal,
  );
  // 三路径归一：forkWorkspaceAtMessage 不能只写 synthetic notice、不写
  // session_fork timeline part（与另外两条 fork 路径不一致，冷恢复 fork 边界形态漂移）。
  const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);
  const forkTimelineCreated = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(options.targetMessageId)}_timeline`,
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
      targetMessageId: options.targetMessageId,
      restoredFileCount: restoredFiles.length,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext: options.traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatWorkspaceForkAtMessageNoticeBody({
      parentSessionId: this.sessionId,
      restoredFiles,
      targetMessageId: options.targetMessageId,
      undoneCheckpointCount: laterCheckpoints.length,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: options.targetMessageId,
        restoredFileCount: restoredFiles.length,
      },
    },
    traceContext: options.traceContext,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: forkHistoryEndIndex,
      targetMessageId: options.targetMessageId,
      restoredFileCount: restoredFiles.length,
      strategy: RewindStrategy.ForkRequired,
    },
    options.traceContext,
  );
  await this.appendEvent(forkedEvent, options.traceContext);

  return {
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles,
    response: `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${copiedMessageCount} messages and restored ${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"} to the fork point.`,
  };
}

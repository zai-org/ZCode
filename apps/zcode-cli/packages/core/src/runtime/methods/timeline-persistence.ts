import {
  createModelId,
  createModelProviderId,
  SessionEventType,
  type WorktreeCreationFact,
} from "@zcode/contracts";
import { createMessageId, createPartId } from "../deps.js";
import type {
  MessageId,
  ModelSelection,
  PartId,
  SessionId,
  TimelinePart,
  TimelinePartDraft,
  TraceContext,
} from "../deps.js";
import { emptyTokenUsageInfo } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function recordPendingModelChange(
  this: AgentRuntimeInternal,
  input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  },
): void {
  const existing = this.pendingModelChangeTimeline;
  const fromModel = existing?.fromModel ?? input.fromModel;
  const fromModelLabel = existing?.fromModelLabel ?? input.fromModelLabel;
  if (fromModel && isSameModelSelection(fromModel, input.toModel)) {
    this.pendingModelChangeTimeline = undefined;
    return;
  }
  this.pendingModelChangeTimeline = {
    createdAt: existing?.createdAt ?? Date.now(),
    fromModel,
    fromModelLabel,
    requestId: existing?.requestId ?? String(createPartId()),
    toModel: input.toModel,
    toModelLabel: input.toModelLabel,
  };
}

export async function persistPendingModelChangeTimeline(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const pending = this.pendingModelChangeTimeline;
  if (!pending) return;
  this.pendingModelChangeTimeline = undefined;

  const created = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: this.sessionId,
    messageID: createMessageId(`${pending.requestId}_message`),
    partID: createPartId(`${pending.requestId}_timeline`),
    parentID: this.latestConversationMessageId,
    created,
    completed: created,
    finish: "completed",
    timeline: {
      timelineType: "model_change",
      display: "separator",
      status: "completed",
      anchorMessageId: this.latestConversationMessageId,
      fromModel: pending.fromModel
        ? {
            providerId: pending.fromModel.providerId,
            modelId: pending.fromModel.modelId,
            ...(pending.fromModel.options ? { options: pending.fromModel.options } : {}),
            label: pending.fromModelLabel ?? formatModelSelectionLabel(pending.fromModel),
          }
        : undefined,
      toModel: {
        providerId: pending.toModel.providerId,
        modelId: pending.toModel.modelId,
        ...(pending.toModel.options ? { options: pending.toModel.options } : {}),
        label: pending.toModelLabel,
      },
      time: {
        start: created,
        end: created,
      },
    },
    traceContext,
  });
}

export function recordPendingWorktreeCreation(
  this: AgentRuntimeInternal,
  fact: WorktreeCreationFact,
): void {
  // 只在新建会话首轮之前记录一次；重复调用（例如命令重试）保持第一次的事实。
  this.pendingWorktreeCreation ??= { ...fact };
}

/**
 * 首轮持久化会话之后、TurnStarted 之前写入 "已创建 worktree"（docs/git/worktree.md §6.6.4）：
 * 落盘为 timeline part 以便冷恢复，同时发 WorktreeCreated 让 live 投影在首轮之前显示。
 * 与 model_change 一样不进入模型上下文（providerVisibility = hidden）。
 */
export async function persistPendingWorktreeCreationTimeline(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const fact = this.pendingWorktreeCreation;
  if (!fact) return;
  this.pendingWorktreeCreation = undefined;
  const created = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: this.sessionId,
    created,
    completed: created,
    finish: "completed",
    timeline: {
      timelineType: "worktree_creation",
      display: "worklog",
      status: "completed",
      worktreeCreation: fact,
      time: { start: created, end: created },
    },
    traceContext,
  });
  await this.appendEvent(
    this.createEvent(SessionEventType.WorktreeCreated, { ...fact }, traceContext),
    traceContext,
  );
}

export async function persistAssistantTimelinePartForSession(
  this: AgentRuntimeInternal,
  options: {
    sessionId: SessionId;
    messageID?: MessageId;
    partID?: PartId;
    parentID?: MessageId;
    created?: number;
    completed?: number;
    finish?: string;
    timeline: TimelinePartDraft;
    traceContext: TraceContext;
  },
): Promise<{ messageID: MessageId; partID: PartId }> {
  if (!this.sessionStore) {
    return {
      messageID: options.messageID ?? createMessageId(),
      partID: options.partID ?? createPartId(),
    };
  }

  const messageID = options.messageID ?? createMessageId();
  const partID = options.partID ?? createPartId();
  const created = options.created ?? options.timeline.time?.start ?? Date.now();
  const selection = this.getSessionModelSelection();
  await this.persistMessage(
    {
      id: messageID,
      sessionID: options.sessionId,
      role: "assistant",
      time: {
        created,
        completed: options.completed ?? options.timeline.time?.end,
      },
      parentID: options.parentID ?? this.latestConversationMessageId ?? messageID,
      modelId: selection && createModelId(selection.modelId),
      providerId: selection && createModelProviderId(selection.providerId),
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        root: this.workspaceRoot,
      },
      cost: 0,
      tokens: emptyTokenUsageInfo(),
      finish: options.finish ?? options.timeline.status,
      semantics: {
        origin: "system",
        kind: "timeline_event",
        uiVisibility: "visible",
        providerVisibility: "hidden",
        transcriptVisibility: "visible",
      },
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      ...options.timeline,
      id: partID,
      sessionID: options.sessionId,
      messageID,
      type: "timeline",
    } as TimelinePart,
    options.traceContext,
  );

  return { messageID, partID };
}

function isSameModelSelection(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

function formatModelSelectionLabel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

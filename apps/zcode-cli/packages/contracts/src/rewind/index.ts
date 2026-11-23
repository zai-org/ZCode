// ============================================================
// Rewind Contracts - checkpoint payloads and compact-aware helpers
// ============================================================

import { z } from "zod";

import { isCompactBoundaryItem, parseCompactBoundaryPayload } from "../compact/index.js";
import type { CompactBoundaryPayload, CompactContextItem } from "../compact/index.js";
import type { MessageId } from "../interfaces/shared.js";

const diffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

export const RewindScope = {
  Conversation: "conversation",
  Workspace: "workspace",
  Both: "both",
} as const;

export type RewindScope = (typeof RewindScope)[keyof typeof RewindScope];

export const RewindStrategy = {
  ActiveChain: "active_chain",
  FileOnly: "file_only",
  ForkRequired: "fork_required",
  Unavailable: "unavailable",
} as const;

export type RewindStrategy = (typeof RewindStrategy)[keyof typeof RewindStrategy];

export const RewindTargetStatus = {
  ActiveChain: "active_chain",
  CoveredByCompact: "covered_by_compact",
  Missing: "missing",
} as const;

export type RewindTargetStatus = (typeof RewindTargetStatus)[keyof typeof RewindTargetStatus];

export const checkpointCreatedPayloadSchema = z
  .object({
    checkpointId: z.string().min(1),
    messageId: z.string().min(1),
    targetMessageId: z.string().min(1).optional(),
    toolMessageId: z.string().min(1).optional(),
    scope: z.enum([RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]),
    snapshotRef: z.string().min(1),
    diffRef: z.string().min(1).optional(),
    fileCount: z.number().int().nonnegative().optional(),
    compactBoundaryId: z.string().min(1).optional(),
    coveredByCompact: z.boolean().optional(),
  })
  .strict();

export type CheckpointCreatedPayload = Omit<
  z.infer<typeof checkpointCreatedPayloadSchema>,
  "messageId" | "targetMessageId" | "toolMessageId"
> & {
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
};

export const rewindTriggeredPayloadSchema = z
  .object({
    rewindId: z.string().min(1),
    scope: z.enum([RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]),
    strategy: z.enum([
      RewindStrategy.ActiveChain,
      RewindStrategy.FileOnly,
      RewindStrategy.ForkRequired,
      RewindStrategy.Unavailable,
    ]),
    targetMessageId: z.string().min(1).optional(),
    targetCheckpointId: z.string().min(1).optional(),
    compactBoundaryId: z.string().min(1).optional(),
    restoredSnapshotRef: z.string().min(1).optional(),
    branchCutAfterMessageId: z.string().min(1).optional(),
    branchGeneration: z.number().int().nonnegative().optional(),
    removedMessageIds: z.array(z.string().min(1)).optional(),
    createdMessageId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export type RewindTriggeredPayload = Omit<
  z.infer<typeof rewindTriggeredPayloadSchema>,
  "targetMessageId" | "branchCutAfterMessageId" | "createdMessageId"
> & {
  branchCutAfterMessageId?: MessageId;
  targetMessageId?: MessageId;
  createdMessageId?: MessageId;
};

export const workspaceCheckpointArtifactSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("workspace_file_before_change"),
    createdAt: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            existedBefore: z.boolean(),
            beforeContent: z.string().nullable(),
            afterContent: z.string().optional(),
            afterContentLength: z.number().int().nonnegative().optional(),
            structuredPatch: z.array(diffHunkSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type WorkspaceCheckpointArtifact = z.infer<typeof workspaceCheckpointArtifactSchema>;

export interface CheckpointProjectionInfo {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RewindProjectionInfo {
  compactBoundaryId?: string;
  reason?: string;
  rewindId: string;
  scope: RewindScope;
  strategy: RewindStrategy;
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  triggeredAt: Date;
}

export interface RewindTargetEvaluation {
  allowedScopes: RewindScope[];
  compactBoundary?: CompactBoundaryPayload;
  compactBoundaryId?: string;
  reason: string;
  strategy: RewindStrategy;
  targetStatus: RewindTargetStatus;
}

export interface EvaluateRewindTargetInput<T extends { id: string }> {
  checkpointAvailable?: boolean;
  getId?: (item: T) => string;
  isBoundary?: (item: T) => boolean;
  items: readonly T[];
  scope: RewindScope;
  targetMessageId: MessageId | string;
}

export interface ActiveConversationBranchOptions {
  branchCutAfterMessageId?: MessageId;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}

/** runtime resume、cold projection 与 stable fork 共用的 conversation active-branch 裁剪。 */
export function selectActiveConversationBranch<T extends { info: { id: MessageId } }>(
  messages: readonly T[],
  options: ActiveConversationBranchOptions = {},
): T[] {
  if (!options.rewindTargetMessageId) return [...messages];
  const messagesById = new Map(messages.map((message) => [message.info.id, message]));
  const targetIndex = messages.findIndex(
    (message) => message.info.id === options.rewindTargetMessageId,
  );
  const kept = options.rewindKeptMessageIds
    ? options.rewindKeptMessageIds
        .map((messageId) => messagesById.get(messageId))
        .filter((message): message is T => message !== undefined)
    : targetIndex >= 0
      ? messages.slice(0, targetIndex)
      : [...messages];

  if (options.branchCutAfterMessageId) {
    const cutIndex = messages.findIndex(
      (message) => message.info.id === options.branchCutAfterMessageId,
    );
    // rewind 不再写 model-visible reminder。cut 游标直接指向提交前 transcript
    // 尾部，之后追加的任意 canonical message 自动属于新分支；旧分支仍留在 append-only store。
    return cutIndex >= 0 ? [...kept, ...messages.slice(cutIndex + 1)] : kept;
  }

  if (options.rewindKeptMessageIds) {
    if (!options.rewindCreatedMessageId) return kept;
    const createdIndex = messages.findIndex(
      (message) => message.info.id === options.rewindCreatedMessageId,
    );
    return createdIndex >= 0 ? [...kept, ...messages.slice(createdIndex)] : kept;
  }
  if (targetIndex < 0) return [...messages];
  if (!options.rewindCreatedMessageId) return kept;
  const createdIndex = messages.findIndex(
    (message) => message.info.id === options.rewindCreatedMessageId,
  );
  return createdIndex >= 0 ? [...kept, ...messages.slice(createdIndex)] : kept;
}

export function parseCheckpointCreatedPayload(input: unknown): CheckpointCreatedPayload {
  return checkpointCreatedPayloadSchema.parse(input) as CheckpointCreatedPayload;
}

export function parseRewindTriggeredPayload(input: unknown): RewindTriggeredPayload {
  return rewindTriggeredPayloadSchema.parse(input) as RewindTriggeredPayload;
}

export function parseWorkspaceCheckpointArtifact(input: unknown): WorkspaceCheckpointArtifact {
  return workspaceCheckpointArtifactSchema.parse(input) as WorkspaceCheckpointArtifact;
}

export function evaluateRewindTarget<T extends { id: string }>(
  input: EvaluateRewindTargetInput<T>,
): RewindTargetEvaluation {
  const getId = input.getId ?? ((item: T) => item.id);
  const targetIndex = input.items.findIndex((item) => getId(item) === input.targetMessageId);
  const boundaryIndex = input.items.findLastIndex(
    input.isBoundary ?? ((item) => isCompactBoundaryItem(item as CompactContextItem)),
  );
  const compactBoundary =
    boundaryIndex >= 0
      ? parseCompactBoundaryPayload(
          (input.items[boundaryIndex] as CompactContextItem).compactBoundary,
        )
      : undefined;

  if (targetIndex < 0) {
    return {
      allowedScopes: [],
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_not_found",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.Missing,
    };
  }

  const checkpointAvailable = input.checkpointAvailable === true;
  const coveredByCompact = boundaryIndex >= 0 && targetIndex < boundaryIndex;

  if (!coveredByCompact) {
    const allowedScopes = activeChainAllowedScopes(checkpointAvailable);
    if (!isRequestedScopeAllowed(input.scope, allowedScopes)) {
      return {
        allowedScopes,
        compactBoundary,
        compactBoundaryId: compactBoundary?.boundaryId,
        reason: "checkpoint_required_for_workspace_rewind",
        strategy: RewindStrategy.Unavailable,
        targetStatus: RewindTargetStatus.ActiveChain,
      };
    }

    return {
      allowedScopes,
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_in_active_chain",
      strategy: RewindStrategy.ActiveChain,
      targetStatus: RewindTargetStatus.ActiveChain,
    };
  }

  if (input.scope === RewindScope.Workspace && checkpointAvailable) {
    return {
      allowedScopes: [RewindScope.Workspace],
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_covered_by_compact_file_only_available",
      strategy: RewindStrategy.FileOnly,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    };
  }

  if (input.scope === RewindScope.Workspace) {
    return {
      allowedScopes: [],
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_covered_by_compact_without_checkpoint",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    };
  }

  const allowedScopes = checkpointAvailable
    ? [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]
    : [RewindScope.Conversation];
  if (!isRequestedScopeAllowed(input.scope, allowedScopes)) {
    return {
      allowedScopes,
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "checkpoint_required_for_workspace_rewind",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    };
  }
  // message/part 是 append-only，compact 只是 active provider history 的派生边界。
  // conversation rewind 可以先 branch cut 再重建 compact scope，不应再强制创建 child。
  return {
    allowedScopes,
    compactBoundary,
    compactBoundaryId: compactBoundary?.boundaryId,
    reason: "target_covered_by_compact_active_branch_rebuild",
    strategy: RewindStrategy.ActiveChain,
    targetStatus: RewindTargetStatus.CoveredByCompact,
  };
}

function activeChainAllowedScopes(checkpointAvailable: boolean): RewindScope[] {
  return checkpointAvailable
    ? [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]
    : [RewindScope.Conversation];
}

function isRequestedScopeAllowed(
  scope: RewindScope,
  allowedScopes: readonly RewindScope[],
): boolean {
  return allowedScopes.includes(scope);
}

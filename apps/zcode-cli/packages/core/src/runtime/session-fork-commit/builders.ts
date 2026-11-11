import { randomUUID } from "node:crypto";
import {
  createModelId,
  createModelProviderId,
  type CreateSessionInput,
  type ModelSelection,
  type PermissionRuleset,
} from "@zcode/contracts";
import type { ExecutionState } from "@zcode/shared";
import { systemReminderRuntimeMetadata } from "../../agent/message-history.js";
import {
  CoreErrorType,
  createCoreError,
  createMessageId,
  createPartId,
  createToolCallId,
  createTurnId,
} from "../deps.js";
import type {
  SessionEntryInfo,
  MessageId,
  MessageWithParts,
  PartId,
  SessionGoal,
  SessionId,
  SessionInfo,
  TargetCompletionVerificationPayload,
} from "../deps.js";
import {
  emptyTokenUsageInfo,
  formatConversationForkNoticeBody,
  slugify,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { readRuntimeExecutionState } from "../execution-state.js";
import { cloneModelSelection } from "../model-selection.js";
import { buildSyntheticUserNoticePartMetadata } from "../methods/synthetic-notice-metadata.js";
import type { StableConversationForkTargetCwd } from "../types.js";
import { activeSessionMessages } from "../../agent/session-history-hydrator.js";
import { parseEnvironmentAnnouncement } from "../../context/sections/env-info.js";
import { buildChildEnvironmentUpdate } from "../methods/context-refresh.js";
import { buildRuntimeReminderMessage } from "../methods/runtime-reminder-persistence.js";
import type { ForkIdentityInput, ForkIdentityMap } from "./contract.js";

/**
 * Gen UI 目录随 session id 变化，子会话复制的历史里是父会话的目录。
 * 修复原因：原来等子会话下一次收集输入附件时才宣告；子会话第一个请求若是新轮通知（不收集），
 * 模型按父会话的目录写文件，文件不在子会话自己的目录里。现在 fork 时直接写入一条环境更新。
 * fork 到另一个 cwd（受管 worktree）时传 childCwd：更新同时写出新的工作目录，目录按它计算；
 * 父会话公告没有目录时，带 childCwd 也要写，否则子会话第一个请求看到的仍是父会话的工作目录
 * （cwd 没有变化时不产生工作目录这一行）。
 */
export function buildForkEnvironmentUpdate(
  runtime: AgentRuntimeInternal,
  sourceMessages: readonly MessageWithParts[],
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
  childCwd?: string,
): MessageWithParts | undefined {
  // 基线取子会话恢复后的模型视图，与子会话下一次公告的比较对象相同；
  // 公告只在压缩之前时不补，子会话下一次公告发完整块。
  const announced = latestEnvironmentAnnouncement(activeSessionMessages([...sourceMessages]));
  if (!announced || (!announced.snapshot.visualizationDirectory && !childCwd)) return undefined;
  const entry = buildChildEnvironmentUpdate(
    runtime,
    announced.snapshot,
    childSessionId,
    announced.hasFullBlock,
    childCwd,
  );
  const record = entry && buildRuntimeReminderMessage(runtime, entry);
  if (!record) return undefined;
  return {
    info: {
      ...record.info,
      sessionID: childSessionId,
      ...(modelSelection ? { modelSelection: cloneModelSelection(modelSelection) } : {}),
    },
    parts: record.parts.map((part) => ({ ...part, sessionID: childSessionId })),
  };
}

/** 消息里最近一次环境公告的快照；最近一条没有可解析的元数据时视为没有。 */
function latestEnvironmentAnnouncement(messages: readonly MessageWithParts[]) {
  let latest: ReturnType<typeof parseEnvironmentAnnouncement> | null = null;
  let hasFullBlock = false;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const runtimeMessage = part.metadata?.runtimeMessage as Record<string, unknown> | undefined;
      if (runtimeMessage?.source !== "environment") continue;
      latest = parseEnvironmentAnnouncement(runtimeMessage.environment);
      if (latest?.full) hasFullBlock = true;
    }
  }
  return latest ? { snapshot: latest.snapshot, hasFullBlock } : undefined;
}

export function stableForkError(message: string, context: Record<string, unknown> = {}): Error {
  return createCoreError(CoreErrorType.InvalidStateTransition, message, {
    context,
    recoverable: true,
  });
}

export function buildForkedSessionInput(
  runtime: AgentRuntimeInternal,
  parentSession: SessionInfo,
  forkedSessionId: SessionId,
  kind: "fork" | "selection_side_chat" = "fork",
  targetCwd?: StableConversationForkTargetCwd,
): CreateSessionInput {
  const now = Date.now();
  // fork 到同一 workspace 下的受管 worktree：只换 cwd，workspaceID 沿用父会话（本地为空），
  // 会话仍按 workspace key 归属项目。projectID 由 bootstrap 按映射后的源仓库路径派生，
  // 与新建 worktree 会话一致；会话级 allow 规则与父 cwd 绑定，不带入新目录。
  const placement = targetCwd
    ? {
        projectID: targetCwd.projectID,
        directory: targetCwd.directory,
        path: targetCwd.directory,
        permission: migrateForkPermissionToWorkspace(parentSession.permission),
      }
    : {
        projectID: parentSession.projectID,
        directory: parentSession.directory,
        path: parentSession.path,
        permission: parentSession.permission,
      };
  return {
    id: forkedSessionId,
    projectID: placement.projectID,
    workspaceID: parentSession.workspaceID,
    parentID: runtime.sessionId,
    traceID: runtime.rootTraceContext.traceId,
    taskType: kind,
    slug: `${slugify(parentSession.slug)}-${kind}-${now.toString(36)}`.slice(0, 120),
    directory: placement.directory,
    path: placement.path,
    title:
      kind === "selection_side_chat" ? "Selection side chat" : `Fork of ${parentSession.title}`,
    titleSource: "generated",
    version: parentSession.version,
    permission: placement.permission,
    time: {
      created: now,
      updated: now,
    },
  };
}

/**
 * fork 到另一个 cwd（受管 worktree）时的会话权限迁移规则。
 * 会话级 ruleset 只存在于 `scope: "session"` 的任务；其中 allow 规则来自用户“始终允许”的沉淀，
 * ruleContent 取自工具输入（file_path/path 的绝对路径、相对父 cwd 的命令），与父目录绑定。
 * - allow：不跨目录继承，子会话在新目录里重新确认；
 * - deny/ask：只会收紧权限，原样保留，避免 fork 换目录后反而放宽；
 * - mode/scope/version 等非规则字段与路径无关，原样保留。
 */
export function migrateForkPermissionToWorkspace(
  permission: PermissionRuleset | undefined,
): PermissionRuleset | undefined {
  if (!permission || !("allow" in permission)) return permission;
  const { allow: _pathBoundAllowRules, ...rest } = permission;
  return rest;
}

export function createForkIdentityMap(options: ForkIdentityInput): ForkIdentityMap {
  const messageIds = new Map<MessageId, MessageId>();
  const partIds = new Map<PartId, PartId>();
  const turnIds = new Map<string, string>();
  const productTurnIds = new Map<string, string>();
  const targetIds = new Map<string, string>();
  const verifierEntryIds = new Map<string, string>();
  const verificationIds = new Map<string, string>();
  const toolCallIds = new Map<string, string>();
  const noticeHiddenMessageId = createMessageId();
  const notice = {
    hiddenMessageId: noticeHiddenMessageId,
    hiddenPartId: createPartId(),
    messageId: createMessageId(),
    partId: createPartId(),
    turnId: createTurnId(),
    productTurnId: String(noticeHiddenMessageId),
  };
  const addTurn = (id: unknown) => {
    if (typeof id === "string" && id && !turnIds.has(id)) {
      turnIds.set(id, String(createTurnId()));
    }
  };
  const addProductTurn = (id: unknown) => {
    if (typeof id !== "string" || !id || productTurnIds.has(id)) return;
    const messageId = messageIds.get(id as MessageId);
    productTurnIds.set(id, String(messageId ?? createTurnId()));
  };

  for (const message of options.messages) {
    messageIds.set(message.info.id, createMessageId());
    for (const part of message.parts) {
      partIds.set(part.id, createPartId());
      if (part.type === "tool") {
        toolCallIds.set(part.callID, String(createToolCallId()));
        if (part.state.status === "completed") {
          for (const attachment of part.state.attachments ?? []) {
            partIds.set(attachment.id, createPartId());
          }
        }
      }
    }
  }
  for (const message of options.messages) {
    addTurn(message.info.anchor?.turnId);
    addProductTurn(message.info.anchor?.productTurnId);
    for (const part of message.parts) {
      if (part.type === "timeline") {
        addTurn(part.anchorTurnId);
        if (part.timelineType === "goal_verification") {
          if (!targetIds.has(part.targetId)) {
            targetIds.set(part.targetId, `fork_target_${randomUUID()}`);
          }
          if (!verificationIds.has(part.verificationId)) {
            verificationIds.set(part.verificationId, `fork_verify_${randomUUID()}`);
          }
        }
      }
      if (part.type === "compaction") addTurn(part.compactBoundary?.turnId);
    }
  }
  for (const goal of options.goalSnapshots) {
    if (!targetIds.has(goal.targetID)) {
      targetIds.set(goal.targetID, `fork_target_${randomUUID()}`);
    }
  }
  for (const entry of options.entries) {
    verifierEntryIds.set(entry.id, `fork_goal_verify_${randomUUID()}`);
    const payload = asRecord(asRecord(entry.data).payload);
    if (
      typeof payload.verificationId === "string" &&
      !verificationIds.has(payload.verificationId)
    ) {
      verificationIds.set(payload.verificationId, `fork_verify_${randomUUID()}`);
    }
    addTurn(payload.anchorTurnId);
  }
  return {
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    messageIds,
    partIds,
    turnIds,
    productTurnIds,
    targetIds,
    verifierEntryIds,
    verificationIds,
    toolCallIds,
    notice,
  };
}

function mapForkIdentity(map: ReadonlyMap<string, string>, id: string, field: string): string {
  const mapped = map.get(id);
  if (!mapped) throw stableForkError(`Stable fork cannot remap ${field}`, { id });
  return mapped;
}

export function remapGoalForFork(goal: SessionGoal, identities: ForkIdentityMap): SessionGoal {
  return {
    ...goal,
    sessionID: identities.childSessionId,
    targetID: mapForkIdentity(identities.targetIds, goal.targetID, "goal target"),
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
  };
}

export function cloneVerifierEntryForAtomicFork(
  entry: SessionEntryInfo,
  identities: ForkIdentityMap,
): { entry: SessionEntryInfo; payload: TargetCompletionVerificationPayload } {
  const data = asRecord(entry.data);
  const payload = asRecord(data.payload);
  if (typeof payload.targetId !== "string" || typeof payload.verificationId !== "string") {
    throw stableForkError("Stable fork verifier entry has invalid identity", { entryId: entry.id });
  }
  const clonedPayload: Record<string, unknown> = {
    ...payload,
    targetId: mapForkIdentity(identities.targetIds, payload.targetId, "verifier target"),
    verificationId: mapForkIdentity(
      identities.verificationIds,
      payload.verificationId,
      "verification id",
    ),
  };
  if (typeof payload.anchorAssistantMessageId === "string") {
    clonedPayload.anchorAssistantMessageId = mapForkIdentity(
      identities.messageIds,
      payload.anchorAssistantMessageId,
      "verifier assistant anchor",
    );
  }
  if (typeof payload.anchorTurnId === "string") {
    clonedPayload.anchorTurnId = mapForkIdentity(
      identities.turnIds,
      payload.anchorTurnId,
      "verifier turn anchor",
    );
  }
  const nextEntryId = mapForkIdentity(identities.verifierEntryIds, entry.id, "verifier entry");
  const nextPayload = clonedPayload as unknown as TargetCompletionVerificationPayload;
  return {
    entry: {
      ...entry,
      id: nextEntryId,
      sessionID: identities.childSessionId,
      data: {
        ...data,
        eventId: randomUUID(),
        payload: nextPayload,
        forkOrigin: {
          entryId: entry.id,
          eventId: data.eventId,
          verificationId: payload.verificationId,
        },
      },
    },
    payload: nextPayload,
  };
}

export function buildAtomicForkNotice(
  runtime: AgentRuntimeInternal,
  options: {
    identities: ForkIdentityMap;
    modelSelection?: ModelSelection;
    executionState?: ExecutionState;
    sourceCommandId: string;
    targetMessageId: MessageId;
    /** fork 到受管 worktree 时，在 fork 分隔标记后追加 "已创建 worktree"（§8.2）。 */
    targetCwd?: StableConversationForkTargetCwd;
  },
): MessageWithParts[] {
  const created = Date.now();
  const {
    hiddenMessageId: hiddenId,
    hiddenPartId,
    messageId: noticeId,
    partId: noticePartId,
    turnId: noticeTurnId,
    productTurnId,
  } = options.identities.notice;
  const anchorMessageId = options.identities.messageIds.get(options.targetMessageId) ?? hiddenId;
  const anchor = {
    turnId: noticeTurnId,
    productTurnId,
    orderedMessageIds: [hiddenId, noticeId],
    boundaryMessageId: noticeId,
  };
  const forkOrigin = {
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
  };
  const runtimeSelection = runtime.getSessionModelSelection();
  const modelSelection = options.modelSelection ?? runtimeSelection;
  return [
    {
      info: {
        id: hiddenId,
        sessionID: options.identities.childSessionId,
        role: "user",
        time: { created },
        agent: runtime.config.agentName ?? "zcode-agent",
        modelSelection: modelSelection && cloneModelSelection(modelSelection),
        synthetic: true,
        source: "fork",
        visibility: "model-only",
        semantics: {
          origin: "system",
          kind: "fork_notice",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: hiddenPartId,
          sessionID: options.identities.childSessionId,
          messageID: hiddenId,
          type: "text",
          text: formatConversationForkNoticeBody(forkOrigin),
          synthetic: true,
          time: { start: created, end: created },
          // hydrate 只读 part metadata；独立 source 保留 fork 边界且不改变 checkpoint 的 MCS 行为。
          metadata: buildSyntheticUserNoticePartMetadata("fork", "model-only", {
            forkOrigin,
            runtimeMessage: systemReminderRuntimeMetadata("conversation_fork"),
          }),
        },
      ],
    },
    {
      info: {
        id: noticeId,
        sessionID: options.identities.childSessionId,
        role: "assistant",
        time: { created, completed: created },
        parentID: hiddenId,
        modelId: modelSelection && createModelId(modelSelection.modelId),
        providerId: modelSelection && createModelProviderId(modelSelection.providerId),
        ...(modelSelection?.options?.reasoningLevel
          ? { reasoningLevel: modelSelection.options.reasoningLevel }
          : {}),
        // 分支提示本身也属于新分支历史，必须与分支的持久化状态保持一致。
        ...(options.executionState ?? readRuntimeExecutionState(runtime)),
        agent: runtime.config.agentName ?? "zcode-agent",
        path: { cwd: runtime.workingDirectory, root: runtime.workspaceRoot },
        cost: 0,
        tokens: emptyTokenUsageInfo(),
        finish: "completed",
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: noticePartId,
          sessionID: options.identities.childSessionId,
          messageID: noticeId,
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          anchorMessageId,
          anchorTurnId: noticeTurnId,
          sourceCommandId: options.sourceCommandId,
          parentSessionId: runtime.sessionId,
          targetMessageId: options.targetMessageId,
          restoredFileCount: 0,
          time: { start: created, end: created },
        },
        ...(options.targetCwd
          ? [
              {
                id: createPartId(`${String(noticePartId)}_worktree`),
                sessionID: options.identities.childSessionId,
                messageID: noticeId,
                type: "timeline" as const,
                timelineType: "worktree_creation" as const,
                display: "worklog" as const,
                status: "completed" as const,
                anchorMessageId,
                anchorTurnId: noticeTurnId,
                worktreeCreation: { ...options.targetCwd.worktreeCreation },
                time: { start: created, end: created },
              },
            ]
          : []),
      ],
    },
  ];
}

const SELECTION_SIDE_CHAT_BOUNDARY = [
  "The preceding conversation was inherited from the parent task for reference only.",
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  "Modify the workspace only when the user explicitly asks you to do so in this side chat.",
].join(" ");

export function buildSelectionSideChatBoundary(
  runtime: AgentRuntimeInternal,
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): MessageWithParts {
  const created = Date.now();
  const messageId = createMessageId();
  const turnId = createTurnId();
  return {
    info: {
      id: messageId,
      sessionID: childSessionId,
      role: "user",
      time: { created },
      agent: runtime.config.agentName ?? "zcode-agent",
      modelSelection: modelSelection && cloneModelSelection(modelSelection),
      synthetic: true,
      source: "selection_side_chat",
      visibility: "model-only",
      semantics: {
        origin: "system",
        kind: "system_reminder",
        source: "selection_side_chat",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      anchor: {
        turnId,
        productTurnId: String(messageId),
        orderedMessageIds: [messageId],
        boundaryMessageId: messageId,
        origin: "synthetic",
      },
    },
    parts: [
      {
        id: createPartId(),
        sessionID: childSessionId,
        messageID: messageId,
        type: "text",
        text: SELECTION_SIDE_CHAT_BOUNDARY,
        synthetic: true,
        time: { start: created, end: created },
        // hydrate 读取 part metadata；只写 info.source 会退化为普通 user 文本。
        metadata: buildSyntheticUserNoticePartMetadata(
          "selection_side_chat",
          "model-only",
          undefined,
        ),
      },
    ],
  };
}

export function withoutSelectionSideChatGoalBoundary(message: MessageWithParts): MessageWithParts {
  const anchor = message.info.anchor;
  if (!anchor?.goalBoundary) return message;
  const anchorWithoutGoalBoundary = { ...anchor };
  delete anchorWithoutGoalBoundary.goalBoundary;
  return {
    ...message,
    info: {
      ...message.info,
      anchor: anchorWithoutGoalBoundary,
    },
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

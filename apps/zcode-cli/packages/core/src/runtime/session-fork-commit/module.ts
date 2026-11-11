import { isHighspeedProviderId, resolveExecutionState } from "@zcode/shared";
import type { ForkCommitBundle, ModelSelection } from "@zcode/contracts";
import {
  RewindStrategy,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createSessionId,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageWithParts, SessionEntryInfo, SessionGoal, SessionId } from "../deps.js";
import {
  cloneMessageForFork,
  clonePartForFork,
  isHiddenReminderMessage,
} from "../helpers/index.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import { buildForkedPromptSnapshotEntry } from "../helpers/prompt-snapshot.js";
import { cloneModelSelection } from "../model-selection.js";
import type { StableConversationForkGoalBoundary, WorkspaceForkResult } from "../types.js";
import type { AtomicConversationForkOptions, ForkCommitRuntime } from "./contract.js";
import {
  buildAtomicForkNotice,
  buildForkEnvironmentUpdate,
  buildForkedSessionInput,
  buildSelectionSideChatBoundary,
  cloneVerifierEntryForAtomicFork,
  createForkIdentityMap,
  remapGoalForFork,
  stableForkError,
  withoutSelectionSideChatGoalBoundary,
} from "./builders.js";

const MODEL_SELECTION_ENTRY_SUFFIX = ":runtime-model-selection";

function modelSelectionFromMessage(message: MessageWithParts): ModelSelection | undefined {
  // 隐藏提醒（如停止后的中断标记）只记 provider/model，不带 options，不是这一点的选型事实。
  if (isHiddenReminderMessage(message)) return undefined;
  const selection = persistedModelSelectionOfMessage(message);
  // 加速卡 Selection 是 `selectionScope=execution` 的单轮执行事实（highspeed-card-spec §5），
  // 只有与同一轮 requestAuth 成对才有效。child 继承它会常驻在无凭据的加速 Provider 上：
  // 用户看到「分叉后原模型没带过来」，子会话首轮还会以 ModelRequestAuthMissing 失败。
  // 因此跳过该消息，继续向前找最近一次普通选型，最终回落 runtime 常驻 Selection。
  return selection && isHighspeedProviderId(selection.providerId) ? undefined : selection;
}

function persistedModelSelectionOfMessage(message: MessageWithParts): ModelSelection | undefined {
  if (message.info.role === "user") {
    return message.info.modelSelection && cloneModelSelection(message.info.modelSelection);
  }
  if (!message.info.modelId || !message.info.providerId) return undefined;
  return {
    modelId: message.info.modelId,
    providerId: message.info.providerId,
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  };
}

function resolveForkModelSelection(
  runtime: ForkCommitRuntime,
  messages: readonly MessageWithParts[],
  explicit?: ModelSelection,
): ModelSelection | undefined {
  // 加速 Provider 不能成为 child 的常驻 Selection（理由见 modelSelectionFromMessage），
  // 调用方显式传入时同样跳过，回落历史普通选型 / runtime 常驻 Selection。
  if (explicit && !isHighspeedProviderId(explicit.providerId)) return cloneModelSelection(explicit);
  const historical = [...messages].reverse().map(modelSelectionFromMessage).find(Boolean);
  const runtimeSelection = runtime.getSessionModelSelection();
  const identity = historical ?? runtimeSelection;
  if (!identity) return undefined;
  const historicalOptions = historical?.options;
  const reasoningLevel =
    historicalOptions?.reasoningLevel ?? runtimeSelection?.options?.reasoningLevel;
  return {
    modelId: identity.modelId,
    providerId: identity.providerId,
    ...(reasoningLevel !== undefined
      ? {
          options: { reasoningLevel },
        }
      : {}),
  };
}

function buildModelSelectionEntry(
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${childSessionId}${MODEL_SELECTION_ENTRY_SUFFIX}`,
    sessionID: childSessionId,
    type: SESSION_ENTRY_MODEL_SELECTION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: modelSelection ? cloneModelSelection(modelSelection) : null,
  };
}

function collectForkGoalSnapshots(
  messages: readonly MessageWithParts[],
  boundary: StableConversationForkGoalBoundary,
): SessionGoal[] {
  const byId = new Map<string, SessionGoal>();
  for (const message of messages) {
    const goalBoundary = message.info.anchor?.goalBoundary;
    if (goalBoundary?.kind === "snapshot") {
      byId.set(goalBoundary.target.targetID, goalBoundary.target);
    }
  }
  if (boundary.kind === "snapshot") byId.set(boundary.target.targetID, boundary.target);
  return [...byId.values()];
}

function collectVerifierEntryIds(
  messages: readonly MessageWithParts[],
  boundary: StableConversationForkGoalBoundary,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const goalBoundary = message.info.anchor?.goalBoundary;
    if (goalBoundary?.kind === "snapshot") {
      for (const id of goalBoundary.verificationEntryIds) ids.add(id);
    }
  }
  if (boundary.kind === "snapshot") {
    for (const id of boundary.verificationEntryIds) ids.add(id);
  }
  return ids;
}

/** 纯同步规划：数据库可在同一事务内用轻量快照复用完整的边界与 ID 改写规则。 */
export function buildAtomicConversationForkBundle(
  runtime: ForkCommitRuntime,
  options: AtomicConversationForkOptions,
  allEntries: readonly SessionEntryInfo[] = [],
): ForkCommitBundle {
  const childSessionId = options.forkedSessionId ?? createSessionId();
  const kind = options.kind ?? "fork";
  const currentExecutionState = readRuntimeExecutionState(runtime);
  const historicalInfo = [...options.messages]
    .reverse()
    .find((message) => message.info.role === "assistant")?.info;
  // 保留原 stable fork 的历史权限选择，不能让新增 entry 把它覆盖成父任务当前权限。
  const executionState =
    kind === "selection_side_chat" || historicalInfo?.role !== "assistant"
      ? currentExecutionState
      : resolveExecutionState(historicalInfo);
  // 辅助对话明确不复制 Goal target/verifier entries，不能仍将
  // 父消息的 goalBoundary 交给 strict fork clone，否则任意 Goal 状态都会要求不存在的
  // child-local identity。只移除用于 Goal 恢复的 boundary，保留父对话正文作为模型上下文。
  const sourceMessages =
    kind === "selection_side_chat"
      ? options.messages.map(withoutSelectionSideChatGoalBoundary)
      : options.messages;
  const modelSelection = resolveForkModelSelection(runtime, sourceMessages, options.modelSelection);
  const referencedEntryIds =
    kind === "selection_side_chat"
      ? new Set<string>()
      : collectVerifierEntryIds(sourceMessages, options.goalBoundary);
  const entryById = new Map((allEntries ?? []).map((entry) => [entry.id, entry]));
  const entries = [...referencedEntryIds].map((id) => {
    const entry = entryById.get(id);
    if (!entry) {
      throw stableForkError("Stable fork verifier boundary references missing entries", {
        verificationEntryId: id,
      });
    }
    return entry;
  });
  const goalSnapshots =
    kind === "selection_side_chat"
      ? []
      : collectForkGoalSnapshots(sourceMessages, options.goalBoundary);
  const identities = createForkIdentityMap({
    childSessionId,
    entries,
    goalSnapshots,
    messages: sourceMessages,
    parentSessionId: runtime.sessionId,
  });
  const copiedMessages = sourceMessages.map((message) => {
    const nextMessageId = identities.messageIds.get(message.info.id)!;
    const cloned = {
      info: cloneMessageForFork(message.info, {
        forkedSessionId: childSessionId,
        messageIdMap: identities.messageIds,
        nextMessageId,
        turnIdMap: identities.turnIds,
        productTurnIdMap: identities.productTurnIds,
        targetIdMap: identities.targetIds,
        verificationEntryIdMap: identities.verifierEntryIds,
        strictLocalReferences: true,
      }),
      parts: message.parts.map((part) =>
        clonePartForFork(part, {
          forkedSessionId: childSessionId,
          nextMessageId,
          nextPartId: identities.partIds.get(part.id),
          partIdMap: identities.partIds,
          messageIdMap: identities.messageIds,
          turnIdMap: identities.turnIds,
          targetIdMap: identities.targetIds,
          verificationIdMap: identities.verificationIds,
          toolCallIdMap: identities.toolCallIds,
          strictLocalReferences: true,
        }),
      ),
    };
    if (kind !== "selection_side_chat") return cloned;
    // 副屏继承历史仅供模型参考；UI 从空白副屏开始，避免把它误认成普通 fork。
    return {
      ...cloned,
      info: {
        ...cloned.info,
        visibility: "model-only" as const,
        semantics: {
          origin: cloned.info.semantics?.origin ?? "migration",
          kind: cloned.info.semantics?.kind ?? "system_reminder",
          ...(cloned.info.semantics?.source ? { source: cloned.info.semantics.source } : {}),
          uiVisibility: "hidden" as const,
          providerVisibility: "visible" as const,
          transcriptVisibility: "hidden" as const,
        },
      },
    };
  });
  const clonedEntries = entries.map((entry) => cloneVerifierEntryForAtomicFork(entry, identities));
  const modelSelectionEntry = buildModelSelectionEntry(childSessionId, modelSelection);
  const forkedPromptSnapshotEntry = buildForkedPromptSnapshotEntry(runtime, childSessionId);
  const environmentUpdate = buildForkEnvironmentUpdate(
    runtime,
    sourceMessages,
    childSessionId,
    modelSelection,
    options.targetCwd?.directory,
  );
  if (environmentUpdate) copiedMessages.push(environmentUpdate);
  if (kind === "selection_side_chat") {
    copiedMessages.push(buildSelectionSideChatBoundary(runtime, childSessionId, modelSelection));
  } else {
    copiedMessages.push(
      ...buildAtomicForkNotice(runtime, {
        identities,
        modelSelection,
        executionState,
        sourceCommandId: options.sourceCommandId,
        targetMessageId: options.targetMessageId,
        ...(options.targetCwd ? { targetCwd: options.targetCwd } : {}),
      }),
    );
  }
  const commandFact = options.commandFact ?? {
    parentSessionId: String(runtime.sessionId),
    sourceCommandId: options.sourceCommandId,
    ack: {
      commandId: options.sourceCommandId,
      status: "accepted" as const,
      revisionAtDecision: options.revisionAtDecision ?? 0,
      result: {
        type: kind === "selection_side_chat" ? "createSelectionSideSession" : "forkAssistant",
        sessionId: String(childSessionId),
      },
    },
    metadata: {
      forkOrigin: {
        parentSessionId: String(runtime.sessionId),
        targetMessageId: String(options.targetMessageId),
      },
      ...(options.target ? { forkTarget: options.target } : {}),
    },
  };
  const goal =
    kind !== "selection_side_chat" && options.goalBoundary.kind === "snapshot"
      ? {
          source: remapGoalForFork(options.goalBoundary.target, identities),
          status: options.goalBoundary.target.status,
        }
      : undefined;
  const child = buildForkedSessionInput(
    runtime,
    options.parentSession,
    childSessionId,
    kind,
    options.targetCwd,
  );
  // App control 工具不能继承历史批准。Host 只读设置不含完整 permission，必须在唯一
  // owner 检查即将提交的同一个 bundle；检查后无 await，不从另一次查询复制权限。
  // 前缀只触发额外拒绝，绝不提供身份/权限。普通 UI fork 继续原历史配置合同。
  if (
    options.sourceCommandId.startsWith("app-control-") &&
    (Object.keys(child.permission ?? {}).some((key) => key !== "mode") ||
      (child.permission?.mode !== undefined && child.permission.mode !== "build") ||
      executionState.mode !== "build" ||
      executionState.planEnabled)
  ) {
    throw Object.assign(stableForkError("guard.appControlForkPermissionUnsafe"), {
      reasonCode: "guard.appControlForkPermissionUnsafe",
    });
  }
  return {
    child,
    messages: copiedMessages,
    copySources: {
      messages: Object.fromEntries(
        [...identities.messageIds].map(([source, target]) => [target, source]),
      ),
      parts: Object.fromEntries(
        [...identities.partIds].map(([source, target]) => [target, source]),
      ),
    },
    // 选型 entry 与 child/message/verifier 同事务提交；否则 child 首次注册能读到
    // 运行态，冷恢复却会回到 workspace 默认 thought。entry 的磁盘包装由 adapter 负责。
    // Plan 必须与权限一并进入原子的 child bundle，不能只复制创建时的旧 permission。
    entries: [
      ...clonedEntries.map((item) => item.entry),
      modelSelectionEntry,
      buildExecutionStateEntry(childSessionId, executionState),
      // child 沿用父会话当前的 system 快照。fork 点在父会话最近一次压缩之后时，child 的前缀与父会话
      // 一致，首个请求能复用父会话的前缀缓存；fork 点早于那次压缩时，快照属于压缩之后的窗口，
      // child 的历史属于压缩之前，只有两个窗口的 system 相同才能复用。
      // system 不含按会话变化的值；child 的 Gen UI 目录在 fork 时写入环境更新。
      ...(forkedPromptSnapshotEntry ? [forkedPromptSnapshotEntry] : []),
    ],
    ...(goal ? { goal } : {}),
    ...(options.initialInput ? { initialInput: options.initialInput } : {}),
    commandFact,
  };
}

export async function commitAtomicConversationFork(
  runtime: ForkCommitRuntime,
  options: AtomicConversationForkOptions,
): Promise<WorkspaceForkResult> {
  const store = runtime.sessionStore;
  if (!store?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const kind = options.kind ?? "fork";
  const referencedEntryIds =
    kind === "selection_side_chat"
      ? new Set<string>()
      : collectVerifierEntryIds(options.messages, options.goalBoundary);
  const entries = referencedEntryIds.size
    ? await store.sessionEntries?.({
        sessionID: runtime.sessionId,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
      })
    : [];
  if (referencedEntryIds.size && !entries) {
    throw stableForkError("Stable fork verifier boundary cannot be loaded");
  }
  const committedChild = await store.commitForkBundle(
    buildAtomicConversationForkBundle(runtime, options, entries),
  );
  const forkedSessionId = committedChild.id;
  if (kind !== "selection_side_chat") {
    const forkedEvent = runtime.createEvent(
      SessionEventType.SessionForked,
      {
        originalSessionId: runtime.sessionId,
        forkedSessionId,
        forkPoint: options.messages.length,
        targetMessageId: options.targetMessageId,
        restoredFileCount: 0,
        strategy: RewindStrategy.ForkRequired,
      },
      options.traceContext,
    );
    try {
      await runtime.appendEvent(forkedEvent, options.traceContext);
    } catch (error) {
      runtime.logger?.warn("Parent fork event append failed after durable fork commit", {
        ...traceContextToLogContext(options.traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "session.fork.parent_event.failed_after_commit",
        forkedSessionId,
        module: "core.runtime",
        parentSessionId: runtime.sessionId,
      });
    }
  }
  return {
    copiedMessageCount: options.messages.length,
    forkedSessionId,
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles: [],
    response:
      kind === "selection_side_chat"
        ? `Created selection side chat ${forkedSessionId}.`
        : `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${options.messages.length} messages.`,
  };
}

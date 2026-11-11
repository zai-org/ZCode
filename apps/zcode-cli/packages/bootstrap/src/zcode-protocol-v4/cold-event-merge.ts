import {
  SessionEventType,
  selectActiveConversationBranch,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionGoal,
  type TurnFileChangeSummary,
  type TurnId,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  HOOK_LIFECYCLE_EVENT_TYPES,
  LIVE_ONLY_EVENT_TYPES,
  MEMORY_ONLY_EVENT_TYPES,
  TRANSCRIPT_DERIVED_EVENT_TYPES,
  goalVerificationEntriesFromSessionEntries,
  synthesizeEventsFromMessages,
  type HydratedGoalVerificationEntry,
} from "./transcript-hydration.js";

export interface ConversationMaterializationSource {
  goalVerificationEntries: HydratedGoalVerificationEntry[];
  memoryEvents: SessionEvent[];
  messages: MessageWithParts[];
  /** shared_context 正文仍是 provider-only；这里只下发脱敏的 handover metadata。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** 只有成功读取 session_target 后才存在；显式 null 也是持久 authority。 */
  target?: SessionGoal | null;
}

interface PersistedConversationMaterializationStore {
  getSession(sessionId: import("@zcode/contracts").SessionId): Promise<{
    title?: string;
    revert?: {
      branchCutAfterMessageID?: import("@zcode/contracts").MessageId;
      branchGeneration?: number;
      createdMessageID?: import("@zcode/contracts").MessageId;
      keptMessageIDs?: import("@zcode/contracts").MessageId[];
      targetMessageID?: import("@zcode/contracts").MessageId;
    };
  } | null>;
  messages(input: { sessionID: import("@zcode/contracts").SessionId }): Promise<MessageWithParts[]>;
  readTarget(input: {
    sessionID: import("@zcode/contracts").SessionId;
  }): Promise<SessionGoal | null>;
  sessionEntries?(input: {
    sessionID: import("@zcode/contracts").SessionId;
    type?: string;
  }): Promise<SessionEntryInfo[]>;
}

/**
 * cold materialization 的单一持久事实入口。
 *
 * 旧 bridge 只读取全量 message/part，既没有读取 session.revert 来裁掉
 * 已回滚分支，也没有读取 session_target；结果 runtime resume / stable fork 已经使用
 * active branch，而刷新 projection 却会复活旧分支并把 goal 恢复成 null。
 */
export async function loadPersistedConversationMaterialization(input: {
  memoryEvents: readonly SessionEvent[];
  persistedMessages?: MessageWithParts[];
  sessionId: string;
  store?: PersistedConversationMaterializationStore;
}): Promise<ConversationMaterializationSource> {
  if (!input.store) {
    // 无 sessionStore 时旧 bridge 人工填 target:null，把“没有读取”误当成
    // “持久层明确清空”，进而压掉唯一的内存 TargetChanged 并强制 synthesized。
    return {
      goalVerificationEntries: [],
      memoryEvents: [...input.memoryEvents],
      messages: [],
    };
  }
  const sessionID = input.sessionId as import("@zcode/contracts").SessionId;
  const [session, allMessages, target, entries] = await Promise.all([
    input.store.getSession(sessionID),
    input.persistedMessages ?? input.store.messages({ sessionID }),
    input.store.readTarget({ sessionID }),
    input.store.sessionEntries ? input.store.sessionEntries({ sessionID }) : Promise.resolve([]),
  ]);
  const messages = selectActiveConversationBranch(allMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  const sharedContextMessage = messages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.source === "shared_context" &&
      message.info.semantics?.origin === "import" &&
      message.info.semantics?.kind === "shared_context",
  );
  const sharedContextEntry = entries.find((entry) => entry.type === "v4/shared_context_import");
  const sharedContextData =
    sharedContextEntry?.data && typeof sharedContextEntry.data === "object"
      ? (sharedContextEntry.data as Record<string, unknown>)
      : undefined;
  const contextId =
    typeof sharedContextData?.contextId === "string" ? sharedContextData.contextId : undefined;
  const shareUrl =
    typeof sharedContextData?.shareUrl === "string" ? sharedContextData.shareUrl : undefined;
  const status = sharedContextData?.status;
  const sharedContextImport =
    sharedContextMessage && session?.title?.trim()
      ? contextId &&
        shareUrl &&
        ["pending", "reserved", "attached", "discarded"].includes(String(status))
        ? {
            contextId,
            title: session.title.trim(),
            shareUrl,
            status: status as "pending" | "reserved" | "attached" | "discarded",
          }
        : { title: session.title.trim() }
      : undefined;
  return {
    goalVerificationEntries: goalVerificationEntriesFromSessionEntries(entries),
    memoryEvents: [...input.memoryEvents],
    messages,
    ...(sharedContextImport ? { sharedContextImport } : {}),
    target,
  };
}

export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}

export interface ColdEventMergeResult {
  diagnostics: ColdEventMergeDiagnostic[];
  events: SessionEvent[];
  usedDurableTranscript: boolean;
}

interface MergeInput {
  contextWindow?: number;
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  memoryEvents: readonly SessionEvent[];
  messages: readonly MessageWithParts[];
  sessionId: string;
  target?: SessionGoal | null;
}

function hookInvocationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      if (!invocationId) continue;
      const eventName = stringField(event.payload, "hookEventName");
      if (eventName === "SessionStart") {
        // startup SessionStart 可能已经携带尚未映射的 runtime turnId；只有后续真实
        // TurnStarted 才能给出 durable product turn。async terminal 若已解析则沿用。
        if (!resolved.has(invocationId)) pending.add(invocationId);
        continue;
      }
      if (event.turnId) {
        resolved.set(invocationId, String(event.turnId));
        pending.delete(invocationId);
      } else if (!resolved.has(invocationId)) {
        pending.add(invocationId);
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnStarted || !event.turnId || pending.size === 0) {
      continue;
    }
    // model-only 维护 turn（manual /compact、goal continuation）没有资格承载
    // SessionStart 摘要；resume SessionStart 必须等下一条 user-visible 真实 turn 归位。
    if (stringField(event.payload, "inputVisibility") === "model-only") continue;
    // resume SessionStart 在 Runtime 中先于下一条真实 TurnStarted；cold merge 必须沿
    // 同一事件顺序建立归属，不能把它追加到历史末尾或由 Renderer 猜最近一轮。
    for (const invocationId of pending) resolved.set(invocationId, String(event.turnId));
    pending.clear();
  }
  return resolved;
}

function recordDiagnostic(
  diagnostics: Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>,
  code: ColdEventMergeDiagnostic["code"],
  event: SessionEvent,
): void {
  const existing = diagnostics.get(code);
  if (existing) {
    existing.count += 1;
    existing.eventTypes[event.type] = (existing.eventTypes[event.type] ?? 0) + 1;
    return;
  }
  diagnostics.set(code, {
    code,
    count: 1,
    eventTypes: { [event.type]: 1 },
  });
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayField(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function memoryAuthorityTurnIds(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
): { ambiguousLegacyStarts: SessionEvent[]; turnIds: Set<string> } {
  const started = new Map<string, SessionEvent>();
  const terminal = new Set<string>();
  for (const event of events) {
    const turnId = event.turnId ? String(event.turnId) : null;
    if (!turnId) continue;
    if (event.type === SessionEventType.TurnStarted) started.set(turnId, event);
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      terminal.add(turnId);
    }
  }

  const persistedMessageIds = new Set(messages.map((message) => String(message.info.id)));
  const persistedTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
    ),
  );
  const authority = new Set<string>();
  const ambiguousLegacyStarts: SessionEvent[] = [];
  for (const [turnId, start] of started) {
    if (!terminal.has(turnId)) {
      authority.add(turnId);
      continue;
    }
    const messageId = stringField(start.payload, "messageId");
    const hasDurableStarter =
      (messageId !== null && persistedMessageIds.has(messageId)) || persistedTurnIds.has(turnId);
    if (!hasDurableStarter) {
      authority.add(turnId);
      if (messageId === null) ambiguousLegacyStarts.push(start);
    }
  }
  return { ambiguousLegacyStarts, turnIds: authority };
}

function resumedSubagentLifecycleEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const keep = new Set<number>();
  const resumedAgentIds = new Set<string>();
  events.forEach((event, index) => {
    const agentId = stringField(event.payload, "agentId");
    if (!agentId) return;
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.resumed === true) {
        resumedAgentIds.add(agentId);
        keep.add(index);
      }
      return;
    }
    if (event.type === SessionEventType.SubagentStopped && resumedAgentIds.has(agentId)) {
      keep.add(index);
    }
  });
  return keep;
}

function queueStateEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const queuedLifecycleById = new Map<string, number[]>();
  const latestDispatchById = new Map<string, number>();
  // 编辑锁与 dispatch 同为进程内状态：仍在队列中的项只需最近一次锁变化。
  const latestEditLockById = new Map<string, number>();
  const latestDeliveryChangeById = new Map<string, number>();
  const pendingIds = new Set<string>();
  let latestReorder: number | null = null;
  let latestAutoDrain: number | null = null;
  let latestFollowupMode: number | null = null;

  // dispatch / 编辑锁 / delivery 都只需每个 id 最近一次变化。
  const latestByType = new Map<string, Map<string, number>>([
    [SessionEventType.TurnSteerDispatchChanged, latestDispatchById],
    [SessionEventType.TurnSteerEditLockChanged, latestEditLockById],
    [SessionEventType.TurnSteerDeliveryChanged, latestDeliveryChangeById],
  ]);
  // 出队（drain/discard/promote）后该 id 的全部队列事实都不再需要保留。
  const forget = (id: string) => {
    pendingIds.delete(id);
    queuedLifecycleById.delete(id);
    for (const byId of latestByType.values()) byId.delete(id);
  };

  events.forEach((event, index) => {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.add(id);
        queuedLifecycleById.set(id, [...(queuedLifecycleById.get(id) ?? []), index]);
      }
      return;
    }
    const latestById = latestByType.get(event.type);
    if (latestById) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestById.set(id, index);
      return;
    }
    if (
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded
    ) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) forget(id);
      return;
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) forget(id);
      return;
    }
    if (event.type === SessionEventType.TurnSteerReordered) latestReorder = index;
    if (event.type === SessionEventType.QueueAutoDrainChanged) latestAutoDrain = index;
    if (event.type === SessionEventType.FollowupModeChanged) latestFollowupMode = index;
  });

  const keep = new Set<number>();
  for (const id of pendingIds) {
    const queuedLifecycle = queuedLifecycleById.get(id) ?? [];
    const dispatch = latestDispatchById.get(id);
    const deliveryChange = latestDeliveryChangeById.get(id);
    // editQueueItem 在旧事件里可能只重发新 text，完整 intent/附件/来源
    // 仍只在首次 queued 事件。从空投影 cold replay 时必须保留该 id
    // 自最近一次 admission 起的全部 queued 生命周期，让 reducer 原地合并字段。
    for (const queued of queuedLifecycle) keep.add(queued);
    const latestQueued = queuedLifecycle.at(-1) ?? -1;
    if (dispatch !== undefined && dispatch > latestQueued) keep.add(dispatch);
    const editLock = latestEditLockById.get(id);
    if (editLock !== undefined) keep.add(editLock);
    if (deliveryChange !== undefined && deliveryChange > latestQueued) keep.add(deliveryChange);
  }
  if (latestReorder !== null && pendingIds.size > 0) keep.add(latestReorder);
  if (latestAutoDrain !== null) keep.add(latestAutoDrain);
  if (latestFollowupMode !== null) keep.add(latestFollowupMode);
  return keep;
}

function setupModelEventIndexes(
  events: readonly SessionEvent[],
  authorityTurnIds: ReadonlySet<string>,
  messages: readonly MessageWithParts[],
): Set<number> {
  const keep = new Set<number>();
  let latestModelSelected: number | null = null;
  events.forEach((event, index) => {
    if (event.type === SessionEventType.ModelSelected) latestModelSelected = index;
    if (
      event.type === SessionEventType.TurnStarted &&
      event.turnId &&
      authorityTurnIds.has(String(event.turnId)) &&
      latestModelSelected !== null
    ) {
      keep.add(latestModelSelected);
    }
  });
  if (messages.length === 0 && latestModelSelected !== null) keep.add(latestModelSelected);
  return keep;
}

interface DurableBoundaryKeys {
  compact: Set<string>;
  fork: Set<string>;
  goal: Set<string>;
}

function goalKey(payload: unknown): string | null {
  const targetId = stringField(payload, "targetId");
  const verificationId = stringField(payload, "verificationId");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const goalIteration = (payload as Record<string, unknown>).goalIteration;
  if (targetId && typeof goalIteration === "number") return `${targetId}_${goalIteration}`;
  return verificationId;
}

function durableBoundaryKeys(
  messages: readonly MessageWithParts[],
  goalEntries: readonly HydratedGoalVerificationEntry[],
): DurableBoundaryKeys {
  const compact = new Set<string>();
  const fork = new Set<string>();
  const goal = new Set<string>();
  for (const entry of goalEntries) {
    const key = goalKey(entry.payload);
    if (key) goal.add(key);
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "timeline") {
        if (part.timelineType === "goal_verification") {
          const key = goalKey(part);
          if (key) goal.add(key);
        } else if (part.timelineType === "context_compaction") {
          compact.add(String(part.operationId));
        } else if (part.timelineType === "session_fork") {
          fork.add(`${String(part.parentSessionId)}\u0000${String(part.targetMessageId)}`);
        }
        continue;
      }
      if (part.type === "compaction") {
        compact.add(String(part.operationId ?? part.boundaryId ?? `legacy-compact-${part.id}`));
      }
    }
  }
  return { compact, fork, goal };
}

function durableBoundaryKeyForEvent(
  event: SessionEvent,
): { key: string | null; kind: keyof DurableBoundaryKeys } | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return { kind: "goal", key: goalKey(event.payload) };
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return { kind: "compact", key: stringField(event.payload, "operationId") };
  }
  if (event.type === SessionEventType.SessionForked) {
    const parent = stringField(event.payload, "originalSessionId");
    const target = stringField(event.payload, "targetMessageId");
    return { kind: "fork", key: parent && target ? `${parent}\u0000${target}` : null };
  }
  return null;
}

function eventMessageIds(event: SessionEvent): string[] {
  const ids = [
    stringField(event.payload, "messageId"),
    stringField(event.payload, "assistantMessageId"),
  ].filter((id): id is string => id !== null);
  ids.push(...stringArrayField(event.payload, "injectedMessageIds"));
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const drainedInputs = (event.payload as Record<string, unknown>).drainedInputs;
    if (Array.isArray(drainedInputs)) {
      for (const input of drainedInputs) {
        const messageId = stringField(input, "messageId");
        if (messageId) ids.push(messageId);
      }
    }
  }
  return ids;
}

/**
 * 只靠持久实体 ID 建立 transcript message → hydration turn 映射。
 * assistant 没有 text part 时可能不直接产 assistantMessageId，因此再用持久的
 * parentID / anchor.turnId 传播；禁止用文本或时间邻近猜测轮归属。
 */
function durableTurnByMessageId(
  messages: readonly MessageWithParts[],
  events: readonly SessionEvent[],
): Map<string, string> {
  const turnByMessageId = new Map<string, string>();
  for (const event of events) {
    if (!event.turnId) continue;
    for (const messageId of eventMessageIds(event)) {
      turnByMessageId.set(messageId, String(event.turnId));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const turnByRuntimeAnchor = new Map<string, string>();
    for (const message of messages) {
      const turnId = turnByMessageId.get(String(message.info.id));
      const runtimeAnchor = message.info.anchor?.turnId;
      if (turnId && runtimeAnchor) turnByRuntimeAnchor.set(String(runtimeAnchor), turnId);
    }
    for (const message of messages) {
      const messageId = String(message.info.id);
      if (turnByMessageId.has(messageId)) continue;
      const parentTurn =
        message.info.role === "assistant" && message.info.parentID
          ? turnByMessageId.get(String(message.info.parentID))
          : undefined;
      const anchorTurn = message.info.anchor?.turnId
        ? turnByRuntimeAnchor.get(String(message.info.anchor.turnId))
        : undefined;
      const turnId = parentTurn ?? anchorTurn;
      if (!turnId) continue;
      turnByMessageId.set(messageId, turnId);
      changed = true;
    }
  }
  return turnByMessageId;
}

/**
 * Hook lifecycle 只携带 runtime turnId，没有持久 messageId；cold transcript 则会
 * 重新生成 hydrate-turn-*。这里只使用持久 message anchor 建立无歧义身份映射，
 * 禁止按文本或时间邻近猜测。若同一 runtime anchor 指向多个 hydration turn，宁可
 * 保留原事件等待显式恢复边界，也不能把 Hook 错挂到另一轮。
 */
function durableTurnByRuntimeAnchor(
  messages: readonly MessageWithParts[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const turnByRuntimeAnchor = new Map<string, string>();
  const ambiguousRuntimeAnchors = new Set<string>();
  for (const message of messages) {
    const runtimeAnchor = message.info.anchor?.turnId;
    const durableTurnId = turnByMessageId.get(String(message.info.id));
    if (!runtimeAnchor || !durableTurnId) continue;
    const runtimeTurnId = String(runtimeAnchor);
    if (ambiguousRuntimeAnchors.has(runtimeTurnId)) continue;
    const existing = turnByRuntimeAnchor.get(runtimeTurnId);
    if (existing && existing !== durableTurnId) {
      turnByRuntimeAnchor.delete(runtimeTurnId);
      ambiguousRuntimeAnchors.add(runtimeTurnId);
      continue;
    }
    turnByRuntimeAnchor.set(runtimeTurnId, durableTurnId);
  }
  return turnByRuntimeAnchor;
}

/**
 * queue drain 可在同一 runtime turn 内切出多个 product turn；Hook 仍只携带
 * runtime turnId，因此必须按事件顺序跟随持久 message boundary。首次 lifecycle
 * 一旦解析成功就冻结 invocation 归属，避免后台 terminal 跨 boundary 后改挂。
 */
function durableHookTurnByInvocationId(
  events: readonly SessionEvent[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const currentTurnByRuntimeId = new Map<string, string>();
  const runtimeTurnByPendingInputId = new Map<string, string>();
  const runtimeTurnByInvocationId = hookInvocationTurnIds(events);
  const durableTurnByInvocationId = new Map<string, string>();

  const advance = (runtimeTurnId: string | null, messageId: string | null): void => {
    if (!runtimeTurnId || !messageId) return;
    const durableTurnId = turnByMessageId.get(messageId);
    if (durableTurnId) currentTurnByRuntimeId.set(runtimeTurnId, durableTurnId);
  };

  for (const event of events) {
    if (event.type === SessionEventType.TurnStarted) {
      advance(event.turnId ? String(event.turnId) : null, stringField(event.payload, "messageId"));
    } else if (event.type === SessionEventType.TurnSteerDrained) {
      const runtimeTurnId =
        stringField(event.payload, "targetTurnId") ?? (event.turnId ? String(event.turnId) : null);
      const drainedInputs =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>).drainedInputs
          : undefined;
      if (runtimeTurnId && Array.isArray(drainedInputs)) {
        for (const input of drainedInputs) {
          const pendingInputId = stringField(input, "pendingInputId");
          if (pendingInputId) runtimeTurnByPendingInputId.set(pendingInputId, runtimeTurnId);
          if (stringField(input, "delivery") !== "guide") {
            advance(runtimeTurnId, stringField(input, "messageId"));
          }
        }
      }
    } else if (event.type === SessionEventType.SessionInputPromoted) {
      const pendingInputId = stringField(event.payload, "pendingInputId");
      const runtimeTurnId = event.turnId
        ? String(event.turnId)
        : pendingInputId
          ? (runtimeTurnByPendingInputId.get(pendingInputId) ?? null)
          : null;
      advance(runtimeTurnId, stringField(event.payload, "messageId"));
    }

    if (!HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    const invocationId = stringField(event.payload, "hookInvocationId");
    if (!invocationId || durableTurnByInvocationId.has(invocationId)) continue;
    const runtimeTurnId =
      runtimeTurnByInvocationId.get(invocationId) ??
      (event.turnId ? String(event.turnId) : undefined);
    const durableTurnId = runtimeTurnId ? currentTurnByRuntimeId.get(runtimeTurnId) : undefined;
    if (durableTurnId) durableTurnByInvocationId.set(invocationId, durableTurnId);
  }
  return durableTurnByInvocationId;
}

function boundaryAnchorMessageId(event: SessionEvent): string | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return (
      stringField(event.payload, "anchorAssistantMessageId") ??
      stringField(event.payload, "anchorMessageId")
    );
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return stringField(event.payload, "anchorMessageId");
  }
  if (event.type === SessionEventType.SessionForked) {
    return (
      stringField(event.payload, "targetMessageId") ?? stringField(event.payload, "anchorMessageId")
    );
  }
  return null;
}

function insertAtDurableTurnBoundaries(input: {
  durableEvents: readonly SessionEvent[];
  trailingEvents: readonly SessionEvent[];
  turnPrefixEvents: ReadonlyMap<string, readonly SessionEvent[]>;
  turnTailEvents: ReadonlyMap<string, readonly SessionEvent[]>;
}): SessionEvent[] {
  const firstIndexByTurnId = new Map<string, number>();
  const tailIndexByTurnId = new Map<string, number>();
  input.durableEvents.forEach((event, index) => {
    if (!event.turnId) return;
    const turnId = String(event.turnId);
    if (!firstIndexByTurnId.has(turnId)) firstIndexByTurnId.set(turnId, index);
    tailIndexByTurnId.set(turnId, index);
  });
  const beforeIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnPrefixEvents) {
    const firstIndex = firstIndexByTurnId.get(turnId);
    if (firstIndex === undefined) continue;
    beforeIndex.set(firstIndex, [...(beforeIndex.get(firstIndex) ?? []), ...events]);
  }
  const afterIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnTailEvents) {
    const tailIndex = tailIndexByTurnId.get(turnId);
    if (tailIndex === undefined) continue;
    afterIndex.set(tailIndex, [...(afterIndex.get(tailIndex) ?? []), ...events]);
  }

  const merged: SessionEvent[] = [];
  input.durableEvents.forEach((event, index) => {
    merged.push(...(beforeIndex.get(index) ?? []));
    merged.push(event);
    merged.push(...(afterIndex.get(index) ?? []));
  });
  merged.push(...input.trailingEvents);
  return merged;
}

function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
}

/**
 * 冷恢复三源合并：message/part 是已完成正文权威；session_entry 只补 legacy goal；
 * 内存事件只补未完成 turn 与没有 transcript 形态的当前状态。
 */
export function mergeColdConversationEvents(input: MergeInput): ColdEventMergeResult {
  const diagnostics = new Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>();
  const hasPersistedTargetAuthority = Object.prototype.hasOwnProperty.call(input, "target");
  const authorityTurns = memoryAuthorityTurnIds(input.memoryEvents, input.messages);
  const authorityTurnIds = authorityTurns.turnIds;
  for (const event of authorityTurns.ambiguousLegacyStarts) {
    // 旧 TurnStarted 既没有 messageId，transcript 也没有同 turn anchor 时，
    // 禁止用 input 文本/时间猜测实体同一性。相同文本可以是两次真实提交；
    // 宁可保留该内存 turn 并显式诊断，也不能把未持久 in-flight 误当重复删掉。
    recordDiagnostic(diagnostics, "cold_merge.ambiguous_legacy_turn_preserved", event);
  }
  const durableMessages = input.messages.filter(
    (message) =>
      !message.info.anchor?.turnId || !authorityTurnIds.has(String(message.info.anchor.turnId)),
  );
  const durableGoalEntries = (input.goalVerificationEntries ?? []).filter(
    (entry) => !entry.payload.anchorTurnId || !authorityTurnIds.has(entry.payload.anchorTurnId),
  );
  const transcriptEvents = synthesizeEventsFromMessages(durableMessages, {
    sessionId: input.sessionId,
    contextWindow: input.contextWindow,
    fileChangeSummariesByMessageId: input.fileChangeSummariesByMessageId,
    goalVerificationEntries: durableGoalEntries,
  });
  const durableEvents = input.target
    ? [
        ...transcriptEvents.slice(0, 1),
        {
          id: "hydrate-goal-state" as SessionEvent["id"],
          sessionId: input.sessionId as SessionEvent["sessionId"],
          type: SessionEventType.TargetChanged,
          timestamp: new Date(input.target.time.updated),
          traceId: "trace-hydration" as SessionEvent["traceId"],
          sequenceNumber: 0,
          payload: { action: "set", source: "runtime", target: input.target },
        },
        ...transcriptEvents.slice(1),
      ]
    : transcriptEvents;
  const durableTurnIds = new Set(
    durableEvents.flatMap((event) => (event.turnId ? [String(event.turnId)] : [])),
  );
  const queueIndexes = queueStateEventIndexes(input.memoryEvents);
  const resumedSubagentIndexes = resumedSubagentLifecycleEventIndexes(input.memoryEvents);
  const modelSetupIndexes = setupModelEventIndexes(
    input.memoryEvents,
    authorityTurnIds,
    input.messages,
  );
  const supplements: SessionEvent[] = [];
  const prefixEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryKeys = durableBoundaryKeys(durableMessages, durableGoalEntries);
  const turnByMessageId = durableTurnByMessageId(durableMessages, durableEvents);
  const turnByRuntimeAnchor = durableTurnByRuntimeAnchor(durableMessages, turnByMessageId);
  const hookTurnIdByInvocationId = hookInvocationTurnIds(input.memoryEvents);
  const durableHookTurnByInvocation = durableHookTurnByInvocationId(
    input.memoryEvents,
    turnByMessageId,
  );

  input.memoryEvents.forEach((event, index) => {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      // invocation 扫描会把 startup/resume SessionStart 的临时 runtime turn 修正为
      // 后续真实 TurnStarted；因此它必须优先于单条事件上尚未建立 product mapping
      // 的 turnId。普通 prompt/tool invocation 得到的仍是同一个 runtime turn。
      const resolvedTurnId = invocationId
        ? (hookTurnIdByInvocationId.get(invocationId) ??
          (event.turnId ? String(event.turnId) : undefined))
        : event.turnId
          ? String(event.turnId)
          : undefined;
      const durableTurnId =
        (invocationId ? durableHookTurnByInvocation.get(invocationId) : undefined) ??
        (resolvedTurnId
          ? durableTurnIds.has(resolvedTurnId)
            ? resolvedTurnId
            : turnByRuntimeAnchor.get(resolvedTurnId)
          : undefined);
      if (durableTurnId) {
        const eventName = stringField(event.payload, "hookEventName");
        const target = eventName === "SessionStart" ? prefixEventsByTurnId : boundaryEventsByTurnId;
        const events = target.get(durableTurnId) ?? [];
        // memory Hook 保留 runtime turnId，而 transcript synthesis 使用
        // hydrate-turn-*；直接比较两者会让 completed Hook 变成 orphan row，
        // SessionStart 也会残留 pending。先改写到 hydration turn 后，既有
        // ProductProjection TurnStarted 映射会继续收敛到稳定 message product turn。
        events.push({ ...event, turnId: durableTurnId as TurnId });
        target.set(durableTurnId, events);
      } else {
        // 只打开历史而尚无下一真实 turn 的 resume SessionStart 继续留作 projection
        // pending，不为它制造 synthetic turn；后续 live TurnStarted 会完成归位。
        supplements.push(event);
      }
      return;
    }
    const boundary = durableBoundaryKeyForEvent(event);
    if (boundary) {
      if (boundary.key && boundaryKeys[boundary.kind].has(boundary.key)) {
        recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
        return;
      }
      // durable boundary 写 part/session_entry 失败时，内存事件是唯一剩余事实。
      // boundary 的持久实体 anchor 优先于事件到达时所在的 active runtime turn；
      // 否则迟到 boundary 会被误留在 unfinished turn 末尾。
      const anchorMessageId = boundaryAnchorMessageId(event);
      const durableTurnId = anchorMessageId ? turnByMessageId.get(anchorMessageId) : undefined;
      if (durableTurnId) {
        const events = boundaryEventsByTurnId.get(durableTurnId) ?? [];
        // durableEvents + supplements 不能直接拼接：即使 boundary
        // 带持久 message anchor，也会被挪到整个 transcript 末尾。这里同时改写为
        // hydration product turn 并插入该轮 tail，身份和物理顺序一次对齐。
        events.push({ ...event, turnId: durableTurnId as TurnId });
        boundaryEventsByTurnId.set(durableTurnId, events);
      } else {
        // legacy 无显式/可解析 anchor：按冻结 fallback 放最后一个已知宿主之后；
        // memory_boundary_preserved diagnostic 让这次降级保持可观测。
        supplements.push(event);
      }
      recordDiagnostic(diagnostics, "cold_merge.memory_boundary_preserved", event);
      return;
    }
    const turnId = event.turnId ? String(event.turnId) : null;
    if (turnId && authorityTurnIds.has(turnId)) {
      supplements.push(event);
      return;
    }
    if (queueIndexes.has(index) || modelSetupIndexes.has(index)) {
      supplements.push(event);
      return;
    }
    if (
      event.type === SessionEventType.TurnSteerQueued ||
      event.type === SessionEventType.TurnSteerDeliveryChanged ||
      event.type === SessionEventType.TurnSteerDispatchChanged ||
      event.type === SessionEventType.TurnSteerEditLockChanged ||
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded ||
      event.type === SessionEventType.SessionInputPromoted ||
      event.type === SessionEventType.TurnSteerReordered ||
      event.type === SessionEventType.QueueAutoDrainChanged ||
      event.type === SessionEventType.FollowupModeChanged
    ) {
      recordDiagnostic(diagnostics, "cold_merge.settled_queue_event_suppressed", event);
      return;
    }
    if (event.type === SessionEventType.TargetChanged && hasPersistedTargetAuthority) {
      // session_target 已是持久权威，旧 merge 却把内存 TargetChanged 当
      // ephemeral 尾事件追加，冷恢复终态会被旧 goal 覆盖；显式 null 也必须压掉旧事件。
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    if (LIVE_ONLY_EVENT_TYPES.has(event.type)) {
      // 插件 UI 资源通知只对当时活着的沙箱实例有意义，冷恢复一律丢弃。
      recordDiagnostic(diagnostics, "cold_merge.non_product_event_suppressed", event);
      return;
    }
    if (MEMORY_ONLY_EVENT_TYPES.has(event.type)) {
      supplements.push(event);
      return;
    }
    if (resumedSubagentIndexes.has(index)) {
      // SendMessage tool transcript 不会合成它恢复的 child lifecycle；若按普通
      // transcript-derived Subagent* 去重，replayable 重连会丢失正在运行的 row 和 Stop 控制。
      supplements.push(event);
      return;
    }
    if (TRANSCRIPT_DERIVED_EVENT_TYPES.has(event.type)) {
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    // ProductProjection 当前可能忽略这类事件，但读取层不能把未知老事实静默删掉；
    // 保留原事件并聚合诊断，后续 normalizer 扩词表时仍有输入可追溯。
    supplements.push(event);
    recordDiagnostic(diagnostics, "cold_merge.unclassified_event_preserved", event);
  });

  return {
    diagnostics: [...diagnostics.values()],
    events: resequence(
      insertAtDurableTurnBoundaries({
        durableEvents,
        trailingEvents: supplements,
        turnPrefixEvents: prefixEventsByTurnId,
        turnTailEvents: boundaryEventsByTurnId,
      }),
    ),
    usedDurableTranscript:
      durableMessages.length > 0 || durableGoalEntries.length > 0 || hasPersistedTargetAuthority,
  };
}

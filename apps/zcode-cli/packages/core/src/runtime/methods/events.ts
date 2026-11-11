import type { WorkspaceId } from "@zcode/contracts";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SessionEventType,
  createMessageId,
  createPartId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  PartId,
  SessionEvent,
  SessionId,
  TargetCompletionVerificationPayload,
  TraceContext,
  TurnInputIntentMetadata,
  UserInputAutoResolutionUpdatedPayload,
} from "../deps.js";
import { titleFromInput, slugify, projectIdFromDirectory } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { recordToolUsageFromEvent } from "./usage-observability.js";
import { persistRuntimeModelSelection } from "./turn-model.js";
import { writeDynamicWorkflowActivationEntryIfActivated } from "./dynamic-workflow-activation.js";
import { writeSessionFeaturesEntryAfterFirstPersist } from "../session-features/contract.js";
import {
  persistWorkspaceCheckpointEntry,
  persistWorkspaceFileRewindEntry,
} from "./workspace-checkpoint-persistence.js";

const SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT = 100;

const SUMMARY_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ModelStreaming,
  SessionEventType.ModelNetworkStatus,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ToolCallProgress,
]);

// 生产环境只记录会改变 Turn/Session 生命周期的低频事件；stream/progress 仍由
// 现有 debug 聚合日志覆盖，避免诊断日志和消息流同频刷盘。
const LIFECYCLE_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.SessionTitleUpdated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelRequest,
  SessionEventType.ModelComplete,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
]);

interface SessionEventAppendAggregate {
  eventCount: number;
  eventType: SessionEventType;
  firstEventId: string;
  firstSessionEventSequenceNumber: number;
  lastEventId: string;
  lastSessionEventSequenceNumber: number;
  payloadBytes: number;
  payloadKinds: Record<string, number>;
}

const sessionEventAppendAggregates = new WeakMap<
  AgentRuntimeInternal,
  Map<string, SessionEventAppendAggregate>
>();

export function createEvent(
  this: AgentRuntimeInternal,
  type: SessionEventType,
  payload: unknown,
  traceContext: TraceContext,
): SessionEvent {
  return createSessionEvent(type, this.sessionId, payload, {
    turnId: traceContext.turnId,
    traceId: traceContext.traceId,
  });
}

export async function appendEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  // live sink 以前拿到的是 createSessionEvent 默认的 sequenceNumber=0，
  // 而 replay/read 路径拿到的是 eventStore 补号后的事件，导致同一 session 有两套顺序事实。
  // 这里只发布已落库事件，让 live、replay、snapshot 的 eventSeq 全部来自同一个 event store。
  const shouldLogLifecycle = LIFECYCLE_SESSION_EVENT_TYPES.has(event.type);
  const startedAt = Date.now();
  if (shouldLogLifecycle) {
    this.logger?.info("Session event persistence started", {
      ...traceContextToLogContext(traceContext),
      event: "session.event.persistence.started",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "started",
    });
  }

  let phase = "event_store.append";
  try {
    const storedEvent = await this.eventStore.append(event);
    phase = "session_event.persist_durable";
    await persistDurableSessionEvent.call(this, storedEvent, traceContext);
    phase = "session_event.record_usage";
    await recordToolUsageFromEvent(this, storedEvent, traceContext);
    phase = "session_event.notify_sinks";
    await this.notifyEventSinks(storedEvent, traceContext);
    if (shouldLogLifecycle) {
      this.logger?.info("Session event persistence completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "session.event.persistence.completed",
        module: "core.runtime",
        sessionEventSequenceNumber: storedEvent.sequenceNumber,
        sessionEventType: storedEvent.type,
        status: "completed",
      });
    }
    if (recordSessionEventAppendAggregate.call(this, storedEvent, traceContext)) {
      return;
    }
    flushSessionEventAppendAggregates.call(this, traceContext, "low_frequency_event");
    this.logger?.debug("Session event appended", {
      ...traceContextToLogContext(traceContext),
      event: "event_store.appended",
      module: "core.runtime",
      sessionEventSequenceNumber: storedEvent.sequenceNumber,
      sessionEventType: storedEvent.type,
    });
  } catch (error) {
    if (shouldLogLifecycle) {
      this.logger?.warn("Session event persistence failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.event.persistence.failed",
        module: "core.runtime",
        phase,
        sessionEventType: event.type,
        status: "failed",
      });
    }
    throw error;
  }
}

function recordSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): boolean {
  if (!SUMMARY_SESSION_EVENT_TYPES.has(event.type)) {
    return false;
  }

  const aggregateKey = `${traceContext.turnId ?? "session"}:${event.type}`;
  const aggregateMap = getSessionEventAppendAggregateMap(this);
  const payloadKind = getPayloadKind(event.payload);
  const existing = aggregateMap.get(aggregateKey);
  if (existing) {
    existing.eventCount += 1;
    existing.lastEventId = String(event.id);
    existing.lastSessionEventSequenceNumber = event.sequenceNumber;
    existing.payloadBytes += measureJsonBytes(event.payload);
    existing.payloadKinds[payloadKind] = (existing.payloadKinds[payloadKind] ?? 0) + 1;
    if (existing.eventCount >= SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT) {
      flushSessionEventAppendAggregate.call(
        this,
        aggregateKey,
        existing,
        traceContext,
        "count_threshold",
      );
    }
    return true;
  }

  aggregateMap.set(aggregateKey, {
    eventCount: 1,
    eventType: event.type,
    firstEventId: String(event.id),
    firstSessionEventSequenceNumber: event.sequenceNumber,
    lastEventId: String(event.id),
    lastSessionEventSequenceNumber: event.sequenceNumber,
    payloadBytes: measureJsonBytes(event.payload),
    payloadKinds: { [payloadKind]: 1 },
  });
  return true;
}

function flushSessionEventAppendAggregates(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  if (!aggregateMap || aggregateMap.size === 0) {
    return;
  }
  for (const [aggregateKey, aggregate] of aggregateMap) {
    flushSessionEventAppendAggregate.call(this, aggregateKey, aggregate, traceContext, reason);
  }
}

function flushSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  aggregateKey: string,
  aggregate: SessionEventAppendAggregate,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  aggregateMap?.delete(aggregateKey);
  // 日志治理原因：model streaming / progress 类事件与 token 流同频，
  // 逐条写默认日志会把 eventStore 索引复制成巨量 daily log；这里保留 seq 范围和 kind 分布用于定位。
  this.logger?.debug("Session event append summary", {
    ...traceContextToLogContext(traceContext),
    event: "event_store.appended.summary",
    eventCount: aggregate.eventCount,
    firstEventId: aggregate.firstEventId,
    firstSessionEventSequenceNumber: aggregate.firstSessionEventSequenceNumber,
    flushReason: reason,
    lastEventId: aggregate.lastEventId,
    lastSessionEventSequenceNumber: aggregate.lastSessionEventSequenceNumber,
    module: "core.runtime",
    payloadBytes: aggregate.payloadBytes,
    payloadKinds: aggregate.payloadKinds,
    sessionEventType: aggregate.eventType,
  });
}

function getSessionEventAppendAggregateMap(
  runtime: AgentRuntimeInternal,
): Map<string, SessionEventAppendAggregate> {
  let aggregateMap = sessionEventAppendAggregates.get(runtime);
  if (!aggregateMap) {
    aggregateMap = new Map();
    sessionEventAppendAggregates.set(runtime, aggregateMap);
  }
  return aggregateMap;
}

function getPayloadKind(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const kind = (payload as Record<string, unknown>).kind;
    if (typeof kind === "string" && kind.length > 0) {
      return kind;
    }
  }
  return "<missing>";
}

function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

async function persistDurableSessionEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    // 终态由 CLI 在发布事件前持久化；Host 冷启动不能再把全部历史任务推导为成功。
    await this.sessionStore.updateSession({
      id: event.sessionId,
      lastOutcome:
        event.type === SessionEventType.TurnError
          ? "error"
          : payload.resultType === "cancelled"
            ? "interrupted"
            : "completed",
      timeUpdated: event.timestamp.getTime(),
    });
    return;
  }

  if (event.type === SessionEventType.CheckpointCreated) {
    await persistWorkspaceCheckpointEntry(this, event, traceContext);
    return;
  }

  if (event.type === SessionEventType.RewindTriggered) {
    await persistWorkspaceFileRewindEntry(this, event, traceContext);
    return;
  }

  if (event.type === SessionEventType.UserInputAutoResolutionUpdated) {
    const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
    try {
      await this.sessionStore.saveSessionEntry?.({
        id: `user-input-auto-resolution:${payload.interactionId}`,
        sessionID: event.sessionId,
        type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
        time: {
          created: payload.autoResolution.startedAt,
          updated: event.timestamp.getTime(),
        },
        data: {
          interactionId: payload.interactionId,
          toolCallId: payload.toolCallId,
          autoResolution: payload.autoResolution,
          eventId: event.id,
          sequenceNumber: event.sequenceNumber,
          traceId: event.traceId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    } catch (error) {
      // 原因：自动结束绝对时间若只在内存 eventStore，CLI 重启会错误重开五分钟窗口。
      // session entry 使用 interactionId 稳定覆写最新阶段，恢复时只读取最终状态。
      this.logger?.warn("Failed to persist user input auto-resolution state", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "user_input_auto_resolution.persist_failed",
        interactionId: payload.interactionId,
        module: "core.runtime",
        status: "failed",
      });
    }
    return;
  }

  // ── session_input 账本：queue/steer 生命周期集中记账 ──
  // 在事件汇处理（而非各发射点）：TurnSteerQueued/Discarded 有 5+ 个发射点
  // （steer/编辑重发/单删/清空/resume 清扫），单点接线保证不漏。promotion 在
  // drain 持久化处原子完成（persistUserPrompt sessionInputId 路径），不经此处。
  if (event.type === SessionEventType.TurnSteerQueued) {
    const payload = event.payload as {
      pendingInputId: string;
      input: string;
      commandKind?: string;
      delivery?: "guide" | "queue";
      intent?: TurnInputIntentMetadata;
    };
    const conversationInputIntent = buildPersistedConversationInputIntent(
      payload.input,
      payload.intent,
      "queued",
    );
    try {
      await this.sessionStore.saveSessionInput?.({
        id: payload.pendingInputId,
        sessionID: event.sessionId,
        kind: payload.intent?.kind ?? payload.commandKind ?? "sendText",
        delivery: payload.delivery ?? "queue",
        payload: {
          text: payload.input,
          ...(payload.intent ? { intent: payload.intent } : {}),
          ...(conversationInputIntent ? { conversationInputIntent } : {}),
        },
      });
    } catch (error) {
      this.logger?.warn("Failed to admit session input to ledger", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        pendingInputId: payload.pendingInputId,
        status: "failed",
      });
    }
    return;
  }
  if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
    const payload = event.payload as {
      admittedDelivery: "queue";
      intent?: TurnInputIntentMetadata;
      pendingInputId: string;
    };
    try {
      await this.sessionStore.updateSessionInputs?.({
        sessionID: event.sessionId,
        updates: [
          {
            delivery: payload.admittedDelivery,
            id: payload.pendingInputId,
            ...(payload.intent ? { intent: payload.intent } : {}),
          },
        ],
      });
    } catch (error) {
      this.logger?.warn("Failed to persist session input delivery fallback", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.delivery_change_failed",
        module: "core.runtime",
        pendingInputId: payload.pendingInputId,
        status: "failed",
      });
    }
    return;
  }
  if (event.type === SessionEventType.TurnSteerDiscarded) {
    const payload = event.payload as {
      pendingInputIds: string[];
      reason?: string;
    };
    // sendQueuedNow 只是在执行权已保留后把项从 queue 投影摘除；此时若把 ledger
    // 标成 cancelled，会制造 remove→后台 user message promotion 之间的崩溃丢失窗口。
    // 保持 admitted，随后由 persistUserPrompt 原子置 promoted；若进程先退出，恢复清扫
    // 会把它明确置 discarded/session_resumed。
    if (payload.reason === "promoted") return;
    // session_resumed=重启不保留队列（裁决，留痕不静默）；其余用户动作归 cancelled。
    const status = payload.reason === "session_resumed" ? "discarded" : "cancelled";
    for (const pendingInputId of payload.pendingInputIds) {
      try {
        await this.sessionStore.settleSessionInput?.({
          id: pendingInputId,
          sessionID: event.sessionId,
          status,
          reason: payload.reason,
        });
      } catch (error) {
        this.logger?.warn("Failed to settle session input in ledger", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.settle_failed",
          module: "core.runtime",
          pendingInputId,
          status: "failed",
        });
      }
    }
    return;
  }

  if (event.type !== SessionEventType.TargetCompletionVerification) {
    return;
  }

  try {
    const timestamp = event.timestamp.getTime();
    const payload = event.payload as TargetCompletionVerificationPayload;
    const timelinePartId = targetCompletionVerificationTimelinePartId(payload);
    const existingTimeline = await readExistingTimelineTiming.call(this, {
      partID: timelinePartId,
      sessionID: event.sessionId,
    });
    const created = existingTimeline?.messageCreated ?? timestamp;
    const startedAt = existingTimeline?.partStarted ?? timestamp;
    if (this.sessionStore.saveSessionEntry) {
      await this.sessionStore.saveSessionEntry({
        id: String(event.id),
        sessionID: event.sessionId,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        time: {
          created: timestamp,
          updated: timestamp,
        },
        // goal verifier 生命周期是恢复 UI 轮次和分割线的业务事实；
        // 只写内存 eventStore 会导致冷启动后 goal iteration/todo 分组丢失。
        data: {
          eventId: event.id,
          payload: event.payload,
          sequenceNumber: event.sequenceNumber,
          traceId: event.traceId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    }
    await this.persistAssistantTimelinePartForSession({
      sessionId: event.sessionId,
      messageID: targetCompletionVerificationTimelineMessageId(payload),
      partID: timelinePartId,
      parentID: payload.anchorAssistantMessageId,
      created,
      completed: payload.status === "started" ? undefined : timestamp,
      finish: payload.status,
      timeline: {
        timelineType: "goal_verification",
        display: "separator",
        status: payload.status,
        anchorMessageId: payload.anchorAssistantMessageId,
        anchorTurnId: payload.anchorTurnId,
        targetId: payload.targetId,
        verificationId: payload.verificationId,
        goalIteration: payload.goalIteration,
        verification: payload.verification,
        time: {
          start: startedAt,
          end: payload.status === "started" ? undefined : timestamp,
        },
      },
      traceContext,
    });
  } catch (error) {
    this.logger?.warn("Failed to persist target completion verification event", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.target_completion_verification.persist_failed",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "failed",
    });
  }
}

function targetCompletionVerificationTimelineMessageId(
  payload: TargetCompletionVerificationPayload,
): MessageId {
  return createMessageId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}`);
}

function targetCompletionVerificationTimelinePartId(
  payload: TargetCompletionVerificationPayload,
): PartId {
  return createPartId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}_timeline`);
}

function targetCompletionVerificationTimelineKey(
  payload: TargetCompletionVerificationPayload,
): string {
  return payload.goalIteration !== undefined
    ? `${payload.targetId}_${payload.goalIteration}`
    : payload.verificationId;
}

async function readExistingTimelineTiming(
  this: AgentRuntimeInternal,
  input: { partID: PartId; sessionID: SessionId },
): Promise<{ messageCreated?: number; partStarted?: number } | undefined> {
  const messages = await this.sessionStore?.messages({ sessionID: input.sessionID });
  if (!messages) return undefined;
  for (const message of messages) {
    const part = message.parts.find((candidate) => candidate.id === input.partID);
    if (part?.type !== "timeline") continue;
    return {
      messageCreated: message.info.time.created,
      partStarted: part.time?.start,
    };
  }
  return undefined;
}

export async function notifyEventSinks(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  for (const sink of this.eventSinks) {
    try {
      await sink.onSessionEvent(event);
    } catch (error) {
      this.logger?.warn("Session event sink failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_event_sink.failed",
        module: "core.runtime",
        sessionEventType: event.type,
        status: "failed",
      });
    }
  }
}

/**
 * 会话是否已进入持久化 store（首条输入 / 外部活动 / 直接启动的启动轮 / 冷恢复任一路径落过行）。
 * 协议层的 session record 以它为 draft 判定的事实源（bootstrap `onSessionEvent` 每条事件对齐一次），
 * 不再靠各命令 handler 各自翻 `record.persistence`。
 */
export function isSessionPersisted(this: AgentRuntimeInternal): boolean {
  return this.sessionPersisted;
}

const pendingSessionPersistence = new WeakMap<AgentRuntimeInternal, Promise<void>>();

/** 授权复用已有持久化等待；读取不能使草稿提前成为正式任务。 */
export function getPendingSessionPersistence(
  runtime: AgentRuntimeInternal,
): Promise<void> | undefined {
  return pendingSessionPersistence.get(runtime);
}

export async function ensureSessionPersisted(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;
  const pending = pendingSessionPersistence.get(this);
  if (pending) return pending;
  // App sampling 可与首轮任务并发；同一任务创建必须合并，避免重复插入及模型配置覆盖。
  const created = persistSession
    .call(this, input, traceContext)
    .finally(() => pendingSessionPersistence.delete(this));
  pendingSessionPersistence.set(this, created);
  return created;
}

async function persistSession(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;

  const startedAt = Date.now();
  let phase = "session_store.create";
  this.logger?.info("Session persistence started", {
    ...traceContextToLogContext(traceContext),
    event: "session.persistence.started",
    module: "core.runtime",
    sessionId: this.sessionId,
    status: "started",
  });

  try {
    const directory = this.workingDirectory;
    // bootstrap 会用 path.resolve 规范化执行 cwd；过去又把同一个值写入
    // session.path/directory，导致本地 workspacePath 的末尾 `/` 丢失。冷恢复随后按精确
    // workspaceKey 查 provider registry 时就会落到另一个身份。持久化必须保留协议入口路径。
    const persistedWorkspacePath = this.config.workspacePath ?? directory;
    const title = titleFromInput(input);
    const workspaceIdentity = this.config.memory?.workspaceIdentity?.trim();
    await this.sessionStore.createSession({
      id: this.sessionId,
      // 受管 worktree 会话的项目身份映射回源仓库路径（§6.6.3），directory 仍是实际 cwd。
      projectID: projectIdFromDirectory(this.config.projectDirectory ?? directory),
      // Memory workspaceIdentity 是上游提供的不透明隔离键。这里只做类型品牌化，
      // 不能调用会改写字符串的 ID 生成器，否则恢复后的 Memory root 会发生漂移。
      workspaceID: this.config.workspaceIdentity ?? (workspaceIdentity as WorkspaceId | undefined),
      parentID: this.config.parentSessionId,
      traceID: traceContext.traceId,
      taskType: this.config.taskType,
      slug: slugify(this.sessionId),
      directory: persistedWorkspacePath,
      path: persistedWorkspacePath,
      title,
      titleSource: "first_input",
      version: this.appVersion,
      permission: {
        mode: this.config.mode ?? "build",
      },
    });
    // 初始模型过去只写进首条 user message，没有写稳定的 session selection。
    // 冷恢复从末尾 assistant 反推时只能得到 provider/model，必选 reasoning 会丢失，
    // Subagent 因此在 hydration 前就无法重新创建 Model。会话创建时同步固定完整选型，
    // 后续显式切模仍复用同一个稳定 entry 覆盖。
    phase = "session_model_selection";
    const initialSelection = this.getSessionModelSelection();
    if (initialSelection) await persistRuntimeModelSelection(this, initialSelection);
    phase = "session_execution_state";
    await this.sessionStore.saveSessionEntry?.(
      buildExecutionStateEntry(this.sessionId, readRuntimeExecutionState(this)),
    );
    // `/workflow` 作为首轮时激活先于落盘（launch.md「On demand: activation」），entry 在这里补写。
    await writeDynamicWorkflowActivationEntryIfActivated(this);
    this.sessionPersisted = true;
    // 落盘前打的会话能力标签只在内存里，这里补写；之后的打点各自排队写入。
    await writeSessionFeaturesEntryAfterFirstPersist(this, traceContext);
    this.logger?.debug("Session persisted", {
      ...traceContextToLogContext(traceContext),
      event: "session.persisted",
      module: "core.runtime",
      status: "completed",
    });
    // 之前只把 first_input title 写进 sessionStore 但不 appendEvent，
    // 导致下游 (z-code services 层的 task index sqlite syncer) 等不到 session.titleUpdated，
    // 侧边栏一直显示 "New session" 直到后台 LLM 生成 title。这里补一条 source="first_input"
    // 事件，让 desktop/web/mobile 三端的 syncer 走同一条收敛路径。
    phase = "session_title_event";
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionTitleUpdated,
        {
          previousTitle: "",
          source: "first_input",
          title,
        },
        traceContext,
      ),
      traceContext,
    );
    this.logger?.info("Session persistence completed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "session.persistence.completed",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "completed",
    });
  } catch (error) {
    this.logger?.warn("Session persistence failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session.persistence.failed",
      module: "core.runtime",
      phase,
      sessionId: this.sessionId,
      status: "failed",
    });
    throw error;
  }
}

import { PLUGIN_DISCOVERY_INPUT } from "@zcode/contracts";
import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { refreshWorkspaceTrustAdmission } from "./mcp.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createMessageId,
  createQueryId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CollaborationMode,
  MessageId,
  ModelSelection,
  ModelSelectionOrigin,
  PendingInputEditLock,
  PendingSteerInputInfo,
  PendingTurnInput,
  QueryId,
  SessionEvent,
  TraceContext,
  TurnSteerInput,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
  TurnInputIntentMetadata,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import { acceptSubmissionModelSelection, recordPublishedModelSelection } from "./turn-model.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  buildUserContentFromTurn,
  measureUtf8Bytes,
  MAX_TURN_STEER_INPUT_BYTES,
  previewInput,
  resolveTurnAttachments,
} from "../helpers/index.js";
import type {
  ActiveTurnKind,
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
  EditPendingInputOptions,
  EditPendingInputResult,
  LockPendingInputEditResult,
} from "../types.js";
import {
  attachGenUiContext,
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

function hasSteerInput(request: Pick<TurnSteerInput, "attachments" | "input" | "intent">): boolean {
  return (
    request.input.trim().length > 0 ||
    Boolean(request.attachments?.length) ||
    Boolean(request.intent?.conversationQuotes?.length)
  );
}

export async function steerTurn(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const activeTurn = this.activeTurn;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);

  // 附件输入可以没有正文；旧校验只看 input，导致已 accepted 的附件无法进入权威 queue。
  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn) {
    return await this.rejectTurnSteer("no_active_turn", {
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (request.expectedTurnId !== undefined && request.expectedTurnId !== activeTurn.turnId) {
    return await this.rejectTurnSteer("expected_turn_mismatch", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn.steerable) {
    return await this.rejectTurnSteer("turn_not_steerable", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery;
  const automationId = request.automationId;
  const toolDisallowlist = request.toolDisallowlist;
  const queuePosition = activeTurn.pendingInputs.length;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: request.delivery ?? request.intent.admittedDelivery,
        queuePosition,
      }
    : undefined;
  const pendingInput: PendingTurnInput = {
    id:
      request.pendingInputId ??
      request.intent?.queueItemId ??
      this.createPendingInputId(activeTurn.turnId),
    input: request.input,
    queuedAt: new Date(),
    traceId: activeTurn.traceContext.traceId,
    queryId,
    ...(commandKind ? { commandKind } : {}),
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    ...(delivery ? { delivery } : {}),
    ...(intent ? { intent } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(automationId ? { automationId } : {}),
    ...(toolDisallowlist ? { toolDisallowlist } : {}),
    turnId: activeTurn.turnId,
  };
  const selectionAccepted = acceptSubmissionModelSelection(
    this,
    intent,
    activeTurn.traceContext,
    request.modelSelectionScope
      ? {
          selectionScope: request.modelSelectionScope,
          highspeedFallbackSelection: request.highspeedFallbackSelection,
        }
      : undefined,
  );
  activeTurn.pendingInputs.push(pendingInput);
  // 与 prompt 一样，用户亲手 steer 进来的话给每个欠着决定的 run 一对新的提醒。
  if (isUserSteer(request)) this.workflowBlockedReminder?.userSpoke();
  const queueLength = activeTurn.pendingInputs.length;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      inputId: request.inputId,
      queryId,
      pendingInputId: pendingInput.id,
      input: pendingInput.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      ...(delivery ? { delivery } : {}),
      ...(intent ? { intent } : {}),
      ...(automationId ? { automationId } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId: activeTurn.turnId,
      queueLength,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, activeTurn.traceContext);
  await selectionAccepted;
  this.logger?.debug("Turn steer queued", {
    ...traceContextToLogContext(activeTurn.traceContext),
    activeTurnKind: activeTurn.kind,
    activeTurnSteerable: activeTurn.steerable,
    inputId: request.inputId,
    queryId,
    event: "turn.steer.queued",
    expectedTurnId: request.expectedTurnId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId: pendingInput.id,
    queueLength,
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    status: "waiting",
    targetTurnId: activeTurn.turnId,
  });

  return {
    kind: "queued",
    pendingInputId: pendingInput.id,
    queueLength,
    turnId: activeTurn.turnId,
  };
}

export async function enqueueDeferredInput(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);
  const traceContext = request.traceContext ?? this.rootTraceContext;

  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  const targetTurnId =
    this.activeTurn?.turnId ??
    this.latestAssistantTurnId ??
    traceContext.turnId ??
    ("deferred" as TurnId);
  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery ?? "queue";
  const automationId = request.automationId;
  const toolDisallowlist = request.toolDisallowlist;
  const pendingInputId =
    request.pendingInputId ??
    request.intent?.queueItemId ??
    this.createPendingInputId(targetTurnId);
  const projection = await this.rebuildProjection();
  const queueLength = projection.pendingSteerInputs.length + 1;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: delivery,
        queuePosition: queueLength - 1,
      }
    : undefined;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      ...(request.inputId ? { inputId: request.inputId } : {}),
      queryId,
      pendingInputId,
      input: request.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      delivery,
      ...(intent ? { intent } : {}),
      ...(automationId ? { automationId } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId,
      queueLength,
    },
    {
      traceId: traceContext.traceId,
      turnId: targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  await acceptSubmissionModelSelection(
    this,
    intent,
    traceContext,
    request.modelSelectionScope
      ? {
          selectionScope: request.modelSelectionScope,
          highspeedFallbackSelection: request.highspeedFallbackSelection,
        }
      : undefined,
  );
  this.logger?.debug("Deferred input queued", {
    ...traceContextToLogContext(traceContext),
    delivery,
    event: "turn.deferred_input.queued",
    inputId: request.inputId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId,
    queueLength,
    status: "waiting",
    targetTurnId,
  });

  return {
    kind: "queued",
    pendingInputId,
    queueLength,
    turnId: targetTurnId,
  };
}

export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
  }
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

function pendingInputDelivery(pendingInput: PendingTurnInput | undefined): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

function isInlineGuide(pendingInput: PendingTurnInput): boolean {
  return (
    pendingInput.commandKind !== "sendGoalCommand" &&
    pendingInput.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 * 用户亲手 steer 进来的输入（App、远控、bot 都标 `user_steer`）。协调者、信箱、工具跟进也走 steer，
 * 它们不算。入队时和取出时共用这一个判据；取出后写进历史的 metadata 在带附件或 source 时不留标记，
 * 所以不能从历史反推。
 */
function isUserSteer(input: Pick<PendingTurnInput, "inputPresentation">): boolean {
  return input.inputPresentation === "user_steer";
}

function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs 同时承载 future queue 与 current-turn guide，只检查
  // 数组队首，导致先入队的普通消息把后续显式 guide 永久挡住。delivery 才是消费车道；
  // 这里只在 guide 子序列内保持 admission FIFO，普通 queue 留在原位等待外层提升。
  return activeTurn.pendingInputs.findIndex(isInlineGuide);
}

function withQueryId(traceContext: TraceContext, queryId: QueryId | undefined): TraceContext {
  return queryId ? { ...traceContext, queryId } : traceContext;
}

export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 * 当前 product turn 被 stop/interrupted，或 FIFO barrier 阻止安全 inline 时，把尚未消费的
 * guide 原地改投普通 queue。正常可消费的 text-only guide 仍在当前 active turn 内续跑。
 */
export async function fallbackPendingGuidesToQueue(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  },
): Promise<number> {
  if (this.activeTurn !== options.activeTurn) return 0;
  let changed = 0;
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (pendingInputDelivery(pendingInput) !== "guide") continue;
    const intent = pendingInput.intent
      ? {
          ...pendingInput.intent,
          admittedDelivery: "queue" as const,
          fallbackReasonCode: options.reasonCode,
        }
      : undefined;
    const event = this.createEvent(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        admittedDelivery: "queue",
        fallbackReasonCode: options.reasonCode,
        ...(intent ? { intent } : {}),
        pendingInputId: pendingInput.id,
        requestedDelivery: "guide",
        targetTurnId: options.activeTurn.turnId,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events?.push(event);
    pendingInput.delivery = "queue";
    if (intent) pendingInput.intent = intent;
    changed += 1;
    this.logger?.debug("Guide input fell back to ordinary queue", {
      ...traceContextToLogContext(options.traceContext),
      event: "turn.guide.fell_back",
      fallbackReasonCode: options.reasonCode,
      module: "core.runtime",
      pendingInputId: pendingInput.id,
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }
  return changed;
}

async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // 只删内存 queue/event 会留下 admitted 的 durable session_input。
  // LRU 淘汰后 commands/query 会退成 unknown，CLI restart 又会把用户主动删除误报为
  // inputDiscardedOnRestart。先写 cancelled 终态，失败时不允许 UI queue 先消失。
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}

export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  // 编辑锁与 reservation 互斥：冻结项不能被立即发送或自动续跑提升。
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId) ||
    this.pendingInputEditLocks.has(options.pendingInputId)
  )
    return false;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // rebuildProjection 上方有 await；落锁前必须复查，避免两端同时读到未占用。
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId) ||
    this.pendingInputEditLocks.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // 事件写失败时 reservation 仍必须保持，不能让第二端重复执行。
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}

/**
 * （v4 queue 单项管理）：按 id 从当前 active turn 的 pendingInputs 移除一条，
 * 发 TurnSteerDiscarded([id])。v4 ProductProjection 已消费该事件移除对应 queue row。
 * 旧架构 queue 是 renderer-local，无单项 op；v4 queue 移入 CLI 投影后需此原生能力。
 * 返回是否移除（未命中 id / 无 active turn → false）。
 */
export async function removePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const reservationId = this.pendingInputReservations.get(options.pendingInputId);
  if (reservationId && reservationId !== options.reservationId) return false;
  // 冻结项只能由编辑提交或解锁改变；单项删除不得越过编辑锁。
  if (this.pendingInputEditLocks.has(options.pendingInputId)) return false;
  const activeTurn = this.activeTurn;
  const index =
    activeTurn?.pendingInputs.findIndex(
      (pendingInput) => pendingInput.id === options.pendingInputId,
    ) ?? -1;
  if (!activeTurn || index < 0) {
    // held 回落（stop/完成后 queue 保留成 held）：held 项只存在于
    // 事件日志/投影（active turn 已结束），按投影定位后补 TurnSteerDiscarded。
    return this.discardHeldPendingInputById(
      options.pendingInputId,
      options.traceContext,
      options.reservationId,
      options.reason,
    );
  }
  await settleRemovedSessionInput(this, options.pendingInputId, options.reason);
  activeTurn.pendingInputs.splice(index, 1);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [options.pendingInputId],
      reason: options.reason,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  this.pendingInputReservations.delete(options.pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(options.traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId: options.pendingInputId,
    status: "completed",
    targetTurnId: activeTurn.turnId,
  });
  return true;
}

/**
 * held 项按 id 丢弃（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * active turn 结束后 pendingInputs 内存态即消亡，held queue 的权威在事件日志——
 * 经投影反查该项仍未 drain/discard 后补 TurnSteerDiscarded(user_removed)。
 */
export async function discardHeldPendingInputById(
  this: AgentRuntimeInternal,
  pendingInputId: string,
  traceContext: TraceContext,
  reservationId?: string,
  reason: "user_removed" | "promoted" = "user_removed",
): Promise<boolean> {
  const currentReservation = this.pendingInputReservations.get(pendingInputId);
  if (currentReservation && currentReservation !== reservationId) return false;
  const projection = await this.rebuildProjection();
  const held = projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId);
  if (!held) return false;
  await settleRemovedSessionInput(this, pendingInputId, reason);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [pendingInputId],
      reason,
      targetTurnId: held.targetTurnId,
    },
    {
      traceId: traceContext.traceId,
      turnId: held.targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.pendingInputReservations.delete(pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId,
    status: "completed",
    targetTurnId: held.targetTurnId,
  });
  return true;
}

/**
 * 清空全部排队输入（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * 先摘 active turn 内存项（防后续 roundtrip drain），再按投影清扫 held 残留。
 * 返回丢弃条数。
 */
export async function clearAllPendingInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  let cleared = 0;
  // 「清空队列并发送」是用户对全部已确认项的显式处置，冻结项一并删除；发起编辑端从投影
  // 看到项不存在后进入失效态。
  // Bug 根因：曾在开头一次性清空锁表，丢弃事件写入失败时项仍留在投影（仍显示锁），
  // runtime 却已无锁：解除返回 false、删除守卫失效。锁与项同生同灭：只在丢弃事件写入后删除。
  const releaseLocks = (pendingInputIds: readonly string[]) => {
    for (const pendingInputId of pendingInputIds) this.pendingInputEditLocks.delete(pendingInputId);
  };
  const activeTurn = this.activeTurn;
  if (activeTurn && activeTurn.pendingInputs.length > 0) {
    for (const item of activeTurn.pendingInputs) {
      await settleRemovedSessionInput(this, item.id, "user_removed");
    }
    const removed = activeTurn.pendingInputs.splice(0);
    cleared += removed.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: removed.map((item) => item.id),
        reason: "user_removed",
        targetTurnId: activeTurn.turnId,
      },
      {
        traceId: activeTurn.traceContext.traceId,
        turnId: activeTurn.turnId,
      },
    );
    await this.appendEvent(event, traceContext);
    releaseLocks(removed.map((item) => item.id));
  }
  const projection = await this.rebuildProjection();
  const heldByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const item of projection.pendingSteerInputs) {
    const group = heldByTurn.get(item.targetTurnId) ?? [];
    group.push(item);
    heldByTurn.set(item.targetTurnId, group);
  }
  for (const [targetTurnId, group] of heldByTurn) {
    for (const item of group) {
      await settleRemovedSessionInput(this, item.pendingInputId, "user_removed");
    }
    cleared += group.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: group.map((item) => item.pendingInputId),
        reason: "user_removed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    releaseLocks(group.map((item) => item.pendingInputId));
  }
  return cleared;
}

/** 按编辑写回合成新 intent；缺省字段保留原值。 */
function editedIntent(
  intent: TurnInputIntentMetadata | undefined,
  options: EditPendingInputOptions,
): TurnInputIntentMetadata | undefined {
  if (!intent) return undefined;
  const next: TurnInputIntentMetadata = {
    ...intent,
    ...(options.newText !== undefined ? { text: options.newText } : {}),
    ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
    ...(options.conversationQuotes ? { conversationQuotes: options.conversationQuotes } : {}),
    ...(options.modelSelection
      ? { modelSelection: cloneModelSelection(options.modelSelection) }
      : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
  };
  if (options.dropHighspeed) delete next.highspeed;
  return next;
}

/** 编辑锁裁决：携带 editorId 必须仍持锁；未携带时不得改写他人冻结项。 */
function editLockVerdict(
  runtime: AgentRuntimeInternal,
  options: EditPendingInputOptions,
): "ok" | "editLocked" | "lockLost" {
  const lock = runtime.pendingInputEditLocks.get(options.pendingInputId);
  if (options.editorId !== undefined) {
    return lock?.editorId === options.editorId ? "ok" : "lockLost";
  }
  return lock ? "editLocked" : "ok";
}

/**
 * （v4 queue 单项编辑）：按 id 原地替换排队输入，重发 TurnSteerQueued（同 id）。
 * v4 reducer 的 onTurnSteerQueued 对同 id 原地更新（保位）。composer 编辑态的写回同时
 * 改附件与提交配置，并在同一调用释放编辑锁，不存在「已解锁但内容仍旧」的中间态。
 */
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: EditPendingInputOptions & { traceContext: TraceContext },
): Promise<EditPendingInputResult> {
  const verdict = editLockVerdict(this, options);
  if (verdict !== "ok") return verdict;
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // held 回落：held 项只在事件日志/投影，经投影定位后
    // 重发同 id TurnSteerQueued（v4 reducer 原地更新，保位）。
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    if (!held) return "missing";
    const input = options.newText ?? held.input;
    if (options.newText !== undefined)
      await persistSessionInputUpdates(this, [{ id: held.pendingInputId, text: input }]);
    const intent = editedIntent(held.intent, options);
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input,
        inputPreview: previewInput(input),
        inputSize: measureUtf8Bytes(input),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(intent ? { intent } : {}),
        ...(held.automationId ? { automationId: held.automationId } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    await releaseEditLockAfterEdit(this, held.pendingInputId, held.targetTurnId, options);
    return "edited";
  }
  if (options.newText !== undefined) {
    await persistSessionInputUpdates(this, [{ id: pendingInput.id, text: options.newText }]);
    pendingInput.input = options.newText;
  }
  // 编辑正文后必须同步 canonical text，否则结构化引用恢复时会显示旧正文。
  pendingInput.intent = editedIntent(pendingInput.intent, options);
  if (options.attachments) pendingInput.attachments = options.attachments;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: pendingInput.input,
      inputPreview: previewInput(pendingInput.input),
      inputSize: measureUtf8Bytes(pendingInput.input),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.automationId ? { automationId: pendingInput.automationId } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  await releaseEditLockAfterEdit(this, pendingInput.id, activeTurn.turnId, options);
  return "edited";
}

async function releaseEditLockAfterEdit(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  targetTurnId: TurnId,
  options: EditPendingInputOptions & { traceContext: TraceContext },
): Promise<void> {
  const lock = runtime.pendingInputEditLocks.get(pendingInputId);
  // 编辑期间锁可能已被其他端解除；只释放本次调用持有的锁。
  if (!lock || options.editorId === undefined || lock.editorId !== options.editorId) return;
  await commitEditLockRelease(runtime, pendingInputId, targetTurnId, options.traceContext);
}

/**
 * 解锁的唯一写入点（编辑提交与取消/解除共用）：先写解锁事件，成功后才删内存锁。
 * Bug 根因：曾先删内存锁再写事件，写入失败时投影仍显示锁、runtime 却已无锁，
 * 解除返回 false、删除/重排/立即发送的守卫失效。锁与事件同生同灭，失败无需回滚。
 */
async function commitEditLockRelease(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  targetTurnId: TurnId,
  traceContext: TraceContext,
): Promise<void> {
  await appendPendingInputEditLock(runtime, { pendingInputId, targetTurnId, traceContext });
  runtime.pendingInputEditLocks.delete(pendingInputId);
}

async function appendPendingInputEditLock(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    editLock?: PendingInputEditLock;
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerEditLockChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      targetTurnId: options.targetTurnId,
      ...(options.editLock ? { editLock: { ...options.editLock } } : {}),
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

/**
 * composer 编辑态冻结（docs/ui/composer-edit-mode.md）：锁与 reservation 互斥，只对仍在队列中的
 * 项生效；同一编辑器重复加锁幂等。锁只活在当前 CLI 进程，不使用超时释放。
 */
export async function lockPendingInputEdit(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    editLock: PendingInputEditLock;
    traceContext: TraceContext;
  },
): Promise<LockPendingInputEditResult> {
  const decide = (): LockPendingInputEditResult | undefined => {
    if (this.pendingInputReservations.has(options.pendingInputId)) return "reserved";
    const current = this.pendingInputEditLocks.get(options.pendingInputId);
    if (current) return current.editorId === options.editLock.editorId ? "locked" : "lockedByOther";
    return undefined;
  };
  const early = decide();
  if (early) return early;
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return "missing";
  // 上方 await 期间可能已被 reserve 或被其他编辑器抢先加锁，落锁前复查。
  const late = decide();
  if (late) return late;
  this.pendingInputEditLocks.set(options.pendingInputId, { ...options.editLock });
  try {
    await appendPendingInputEditLock(this, {
      pendingInputId: options.pendingInputId,
      editLock: options.editLock,
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    this.pendingInputEditLocks.delete(options.pendingInputId);
    throw error;
  }
  return "locked";
}

/** 解除编辑锁：发起端取消、刷新后自愈，或其他端在发起端离线时手动解除。无锁返回 false。 */
export async function releasePendingInputEdit(
  this: AgentRuntimeInternal,
  options: { pendingInputId: string; traceContext: TraceContext },
): Promise<boolean> {
  if (!this.pendingInputEditLocks.has(options.pendingInputId)) return false;
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) {
    // 项已被消费或删除时锁随项消失，无需再投影。
    this.pendingInputEditLocks.delete(options.pendingInputId);
    return true;
  }
  await commitEditLockRelease(this, options.pendingInputId, targetTurnId, options.traceContext);
  return true;
}

export function getPendingInputEditLock(
  this: AgentRuntimeInternal,
  pendingInputId: string,
): PendingInputEditLock | undefined {
  const lock = this.pendingInputEditLocks.get(pendingInputId);
  return lock ? { ...lock } : undefined;
}

/**
 * （v4 queue 重排）：把 pendingInputId 移到 beforePendingInputId 之前（null = 移到队尾），
 * 发 TurnSteerReordered(新序)。v4 reducer 按新序重排 queue rows。未命中 → false。
 */
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputEditLocks.has(options.pendingInputId)) return false;
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // held 回落：在投影序上重排后发 TurnSteerReordered（v4 reducer 按新序重排）。
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // 目标锚点已消失 → 退回队尾，不丢项。
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // 只重排数组而不更新 intent.queuePosition，会让 live queue 顺序正确，
  // 但 drain 后 transcript 又写回 admission 时的旧位置，造成冷热投影事实分叉。
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 setAutoDrain）：翻转 queue autoDrain 授权位（会话级配置，与 active turn 无关）。
 * 仅追加 QueueAutoDrainChanged 事件供 v4 投影消费；held 派生（completed+queue>0+autoDrain=false
 * → choice 路由）与后续 heldQueueDisposition 命令闭合发送语义。
 */
export async function setQueueAutoDrain(
  this: AgentRuntimeInternal,
  options: {
    autoDrain: boolean;
    traceContext: TraceContext;
  },
): Promise<void> {
  // false -> true 表示用户从暂停队列恢复。旧暂停项只存在于事件投影，不在新
  // activeTurn.pendingInputs 中；恢复期间改由 CLI 外层按完整投影 FIFO 逐项提升。
  if (options.autoDrain && !this.queueAutoDrain) {
    this.queueExternalDrainActive = true;
  } else if (!options.autoDrain) {
    this.queueExternalDrainActive = false;
  }
  // 授权位同时进 runtime（drain 门）与事件日志（投影派生暂停队列）。
  this.queueAutoDrain = options.autoDrain;
  const event = createSessionEvent(
    SessionEventType.QueueAutoDrainChanged,
    this.sessionId,
    { autoDrain: options.autoDrain },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/** CLI 投影确认恢复队列已空后，重新允许 core 在后续 tool batch 边界消费 guide。 */
export function completeExternalQueueDrain(this: AgentRuntimeInternal): void {
  this.queueExternalDrainActive = false;
}

/**
 * （v4 setFollowupMode）：翻转 followup 路由模式（会话级配置）。
 * 仅追加 FollowupModeChanged 事件供 v4 投影消费；running 时 computeInputRouting 依此在
 * enqueue（queue）与 guide 之间选择。
 */
export async function setFollowupMode(
  this: AgentRuntimeInternal,
  options: {
    mode: "queue" | "guide";
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.FollowupModeChanged,
    this.sessionId,
    { mode: options.mode },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 * （v4 switchModelConfig）：模型选型变化后追加 ModelSelected 事件供投影消费。
 * v4 reducer 的 onModelSelected 依此更新 config.provider/model/thought 和实际 context window，
 * 并（中途切换时）产出 modelChange marker。实际 provider client 切换由 app.setModel 完成，
 * 此处把切换后的完整模型能力元组写入同一个事件。
 */
export async function emitModelSelected(
  this: AgentRuntimeInternal,
  options: {
    modelSelection: ModelSelection;
    model?: import("../deps.js").Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  const model = options.model ?? createRuntimeModel(this, { selection: options.modelSelection });
  const event = createSessionEvent(
    SessionEventType.ModelSelected,
    this.sessionId,
    {
      // 模型切换事件必须从本次创建的 Active Model 读取窗口，不能再复制 Runtime Config。
      contextWindow: model.properties.contextWindow,
      modelSelection: cloneModelSelection(options.modelSelection),
      ...(options.effectiveReasoningLevel
        ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
        : {}),
      // previousModelSelection=null 是显式 ∅→X 模型边界，不能按 truthy 判断丢失。
      ...(options.previousModelSelection !== undefined
        ? {
            previousModelSelection: options.previousModelSelection
              ? cloneModelSelection(options.previousModelSelection)
              : null,
          }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.supportedThoughtLevels
        ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
        : {}),
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
  recordPublishedModelSelection(this, options.modelSelection);
}

/**
 * （v4 switchCollaborationMode）：命令面切换协作模式后追加 SessionModeChanged 事件。
 * app.setMode 只更新 runtime config + 持久化偏好、不产事件（session-mode-port 的
 * enterPlanMode/exitPlanMode 仅覆盖 plan 工具路径），v4 投影的 config.mode 更新靠这条补发。
 */
export async function emitModeChanged(
  this: AgentRuntimeInternal,
  options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.SessionModeChanged,
    this.sessionId,
    {
      mode: this.getMode(),
      planEnabled: this.getPlanEnabled(),
      previousMode: options.previousMode,
      source: "command",
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

export async function drainPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  },
): Promise<DrainedPendingInputDiagnostics | undefined> {
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // Guide 出队先移除内存、后落事件；完整消费期间不能从旧投影捕获授权目标。
  this.pendingInputDrains = (this.pendingInputDrains ?? 0) + 1;
  try {
    return await drainPendingInputUnlocked.call(this, options);
  } finally {
    this.pendingInputDrains -= 1;
  }
}

async function drainPendingInputUnlocked(
  this: AgentRuntimeInternal,
  options: Parameters<typeof drainPendingInput>[0],
): Promise<DrainedPendingInputDiagnostics | undefined> {
  // 同一边界按 admission FIFO 取出全部已等待的 guide。普通 queue 只能由 bootstrap 在
  // session-ready + goal gate 后提升，留在原位，不能偷跑，也不能阻塞当前轮引导。
  // sendQueuedNow 已 reserve 的 guide 只能由 reservation owner 提升；取到它为止，避免
  // stop barrier 期间同一输入又被当前 turn 消费一次，后面的 guide 也不越过它。
  const pendingInputs: PendingTurnInput[] = [];
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (!isInlineGuide(pendingInput)) continue;
    if (this.pendingInputReservations.has(pendingInput.id)) break;
    pendingInputs.push(pendingInput);
  }
  if (pendingInputs.length === 0) return undefined;
  for (const pendingInput of pendingInputs) {
    options.activeTurn.pendingInputs.splice(
      options.activeTurn.pendingInputs.indexOf(pendingInput),
      1,
    );
  }
  const drainedQueryIds = pendingInputs.flatMap((pendingInput) =>
    pendingInput.queryId ? [pendingInput.queryId] : [],
  );
  const queryIds = drainedQueryIds.length > 0 ? drainedQueryIds : undefined;

  const drainedAt = Date.now();
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];
  // 每条 guide 的记录、移出队列（promote）与显示（drained 事件）按条完成，组装请求时才合并。
  // 修复原因：整批提交后才发 drained 事件时，后一条写库失败会让前一条已保存、已移出队列，
  // 却没有生成正式的 user 行，实时界面上看不到它。
  for (const pendingInput of pendingInputs) {
    const messageId = createMessageId();
    // 投递语义缺省按 queue（排队消费=独立轮）；guide 由 v4 命令面
    // 按 inputRouting 显式标注。落到持久 metadata 供冷恢复还原同一切分。
    const delivery = pendingInput.delivery ?? "queue";
    // 每条输入记自己的 query；一起取出时不能都归到最后一条。
    const inputTraceContext = withQueryId(options.traceContext, pendingInput.queryId);
    const resolvedAttachments = await resolveTurnAttachments(pendingInput.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: inputTraceContext,
      turnId: options.activeTurn.turnId,
      workingDirectory: this.workingDirectory,
    });
    // 只在实际 guide 消费且无附件时固化新标记；审批反馈仍走原合同。
    const inputPresentation =
      delivery === "guide" && !pendingInput.source && !pendingInput.attachments?.length
        ? parseRuntimeInputPresentation(pendingInput.inputPresentation)
        : undefined;
    const runtimeEntry = createRuntimeUserEntry(
      buildUserContentFromTurn(
        withConversationQuotes(
          pendingInput.input,
          pendingInput.intent?.conversationQuotes,
          pendingInput.intent?.botGroupSource,
        ),
        resolvedAttachments,
      ),
      runtimeInputMetadata(inputPresentation) ?? realUserRuntimeMetadata(),
    );
    await this.persistUserPrompt(
      messageId,
      pendingInput.input,
      resolvedAttachments,
      inputTraceContext,
      {
        steerDelivery: delivery,
        inputPresentation,
        sessionInputId: pendingInput.id,
        sourceCommandId:
          pendingInput.intent?.sourceCommandId ?? String(pendingInput.queryId ?? pendingInput.id),
        clientId: pendingInput.intent?.clientId,
        intent: pendingInput.intent,
      },
    );
    // 写库成功后才进入内存历史。
    // 修复原因：先进内存历史时，写库失败的 guide 仍在队列里，下一轮请求却已经带着它；
    // 用户继续队列后，模型会看到它两次，冷恢复后又只剩一次。
    const entry = attachGenUiContext(runtimeEntry, pendingInput.intent?.genUiContext);
    this.messageHistory.addEntries([entry]);
    runtimeEntries.push(entry);
    // 按原始来源判断；附件会省略展示标记，不能把合成消息误当成用户输入。
    if (
      this.mcpToolsRegistered &&
      runtimeInputMetadata(pendingInput.inputPresentation)?.source !== "legacy_synthetic"
    ) {
      await refreshWorkspaceTrustAdmission(this, inputTraceContext);
    }
    messageIds.push(messageId);
    const event = this.createEvent(
      SessionEventType.TurnSteerDrained,
      {
        injectedMessageIds: [messageId],
        pendingInputIds: [pendingInput.id],
        drainedInputs: [
          {
            pendingInputId: pendingInput.id,
            messageId,
            text: pendingInput.input,
            delivery,
            ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
            ...(pendingInput.toolDisallowlist
              ? { toolDisallowlist: pendingInput.toolDisallowlist }
              : {}),
          },
        ],
        ...(pendingInput.queryId ? { queryIds: [pendingInput.queryId] } : {}),
        targetTurnId: options.activeTurn.turnId,
      },
      inputTraceContext,
    );
    await this.appendEvent(event, inputTraceContext);
    options.events.push(event);
    this.logger?.debug("Turn steer drained", {
      ...traceContextToLogContext(inputTraceContext),
      drainedCount: 1,
      event: "turn.steer.drained",
      injectedMessageIds: [messageId],
      inputPreviews: [previewInput(pendingInput.input)],
      inputSizes: [measureUtf8Bytes(pendingInput.input)],
      module: "core.runtime",
      pendingInputIds: [pendingInput.id],
      queryIds: pendingInput.queryId ? [pendingInput.queryId] : undefined,
      queuedDurationsMs: [drainedAt - pendingInput.queuedAt.getTime()],
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }

  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);
  const toolDisallowlist = [
    ...new Set(pendingInputs.flatMap((pendingInput) => pendingInput.toolDisallowlist ?? [])),
  ];
  // 同一边界取出多条时，最后一条带意图的输入决定下一 step 的模型、权限与 Plan。
  const intent = pendingInputs.findLast((pendingInput) => pendingInput.intent)?.intent;
  return {
    injectedMessageIds: messageIds,
    ...(intent ? { intent } : {}),
    pluginDiscoveryUi: pendingInputs.every(
      (item) => item.intent?.[PLUGIN_DISCOVERY_INPUT] === true,
    ),
    latestMessageId: messageIds.at(-1),
    pendingInputIds,
    queryIds,
    runtimeEntries,
    ...(toolDisallowlist.length > 0 ? { toolDisallowlist } : {}),
    userSteered: pendingInputs.some(isUserSteer),
  };
}

export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  if (this.activeTurn !== options.activeTurn) return;
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // （重启不保留队列）：先清扫账本残留 admitted——事件日志是
  // 内存的，崩溃后投影里什么都没有，账本是唯一痕迹（含 background wake：后台
  // 子进程随 CLI 重启已死，其未消费通知不可恢复）。留痕（discarded/session_resumed）
  // 不静默，用户/诊断可查「这条输入去哪了」。
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}

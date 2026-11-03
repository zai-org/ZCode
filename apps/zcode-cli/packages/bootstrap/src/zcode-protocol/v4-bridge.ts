import { SessionLifecycleError } from "../session-lifecycle/index.js";
import { closeSessionRuntime, getSessionLifecycle } from "./session-residency.js";
import { isReadonlyAgentSessionKind } from "@zcode/shared";
import { readBackgroundBashOutputFromOwner } from "./background-work-owner.js";
// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（zcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / deleteSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧实现，
//   死期 = M5 波次 2（随旧协议一同删除）。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
import {
  isConversationRealUserTurnStarter,
  parseRemoteWorkspaceIdentity,
  type ZCodeSessionContextUsage,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { createExternalTurnFaultError, normalizeGenUiInput } from "@zcode/core";
import {
  V4_NOTIFICATIONS,
  conversationInputIntentSchema,
  type AttachmentRef,
  type CommandEnvelope,
  type ConversationInputIntent,
  type ConversationSnapshot,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import { V4QueuePromotionLeaseUnavailableError } from "../zcode-protocol-v4/commands/handlers/queue.js";
import { V4CapabilityUnsupportedError } from "../zcode-protocol-v4/commands/handlers/interaction-background.js";
import {
  buildColdFileChangeSummaries,
  readConversationFileChangesFromEvents,
} from "../zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../zcode-protocol-v4/cold-event-merge.js";
import { lookupGlobalCreateSessionCommand } from "../zcode-protocol-v4/create-session-command-fact.js";
import type {
  V4CommandCoreHost,
  V4QueuedTurnExecution,
} from "../zcode-protocol-v4/commands/types.js";
import type {
  ConversationRowTargetResolution,
  SessionUsageSeed,
} from "../zcode-protocol-v4/product-projection.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { queueItemIdForCommand } from "../zcode-protocol-v4/command-inbox.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import { shouldAutoDrainV4QueueHead } from "../zcode-protocol-v4/queue-auto-drain.js";
import { persistAssistantFeedback } from "../zcode-protocol-v4/assistant-feedback-persistence.js";
import {
  persistHighspeedMetrics,
  persistHighspeedTiming,
} from "../zcode-protocol-v4/highspeed-metrics-persistence.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import {
  loadPersistentCommandFacts,
  savePersistentCommandFact,
} from "../zcode-protocol-v4/persistent-command-facts.js";
import {
  ConversationV4Gateway,
  V4CommandNotImplementedError,
} from "../zcode-protocol-v4/v4-gateway.js";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createEventId,
  createSessionId,
} from "@zcode/contracts";
import type {
  CollaborationMode,
  DynamicWorkflowRunProgressPayload,
  EventId,
  ForkCommitBundle,
  GoalStatus,
  MessageId,
  MessageWithParts,
  SessionEvent,
  SessionEventStorePort,
  SessionId,
  SessionStorePort,
  StableForkGoalBoundaryMetadata,
  TraceId,
  TurnId,
  WorkspaceId,
} from "@zcode/contracts";
import { HYDRATION_TRACE_ID } from "../zcode-protocol-v4/projection-state.js";
import { cloneModelSelection, derivedSessionModelSelection } from "./fork-model-selection.js";
import { resolveWorkspaceRefFromId } from "./mapper.js";
import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import {
  hasSessionModelProvider,
  resolveSessionModelContextWindow,
} from "./workspace-model-runtime.js";
import {
  afterStateMutation,
  activateSessionRuntime,
  discardFailedSessionResume,
  createSessionRecordForV4,
  ensureSessionModelAvailableForNextTurn,
  listSessionSubagents,
  registerForkedSession,
  readSessionContextUsage,
} from "./server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createProtocolLogger } from "./server-types.js";

function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

const STABLE_FORK_MODES = new Set<CollaborationMode>([
  "plan",
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
]);

function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

async function readConversationFileChanges(
  record: ZCodeProtocolSessionRecord,
  sessionId: string,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileChangesResult> {
  const events = await record.eventStore.getEvents(sessionId as SessionId);
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async (snapshotRef) =>
      (await record.app.readToolResultArtifact(snapshotRef)).content,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

/**
 * 冷物化时把本会话的 workflow run 从 journal 回放成 `DynamicWorkflowRunProgress` 会话事件。
 *
 *   - 只对**直接命中** record 的父会话补种：经 parentID 回落到父 record 的子会话（actor
 *     transcript）不补——journal 按父会话建键，子会话的投影不该长出父会话的 run；
 *   - 内存事件里已出现过的 runId 交给 CLI 排除（本进程跑过的 run 事件全在内存 store 里，
 *     进度事件不带 turnId、不受 turn-window 淘汰），暖物化因此零重复；
 *   - 回放失败只记日志、回空：观察面绝不让冷开失败。
 *
 * 事件 id / traceId 照 transcript hydration 的合成事件；sequenceNumber 由 cold merge 统一重排。
 */
async function replayDynamicWorkflowRunEvents(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
  memoryEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  if (context.sessions.get(sessionId) !== record) return [];
  const replay = record.app.replayDynamicWorkflowRuns;
  if (!replay) return [];
  const excludeRunIds = new Set<string>();
  for (const event of memoryEvents) {
    if (event.type !== SessionEventType.DynamicWorkflowRunProgress) continue;
    const runId = (event.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") excludeRunIds.add(runId);
  }
  let payloads: DynamicWorkflowRunProgressPayload[];
  try {
    payloads = await replay({ excludeRunIds });
  } catch (error) {
    context.logger?.warn("v4 hydrate dynamic workflow replay failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.v4.hydrate_workflow_replay_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
    return [];
  }
  return payloads.map((payload, index) => ({
    id: `dwf-replay-${index + 1}` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: HYDRATION_TRACE_ID as TraceId,
    sequenceNumber: 0,
    payload,
  }));
}

async function resolveConversationBackingRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolSessionRecord | undefined> {
  const direct = context.sessions.get(sessionId);
  if (direct) return direct;

  // 运行中 subagent 有独立 child event log，但没有独立 bootstrap record。
  // 文件摘要只需要共享 event/artifact store，因此通过持久化 parentID 找到父 record 作为
  // artifact reader，读取事件时仍显式使用 childSessionId；不能为了只读查询 cold resume
  // 第二个 child runtime。
  const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  const parentSessionId = stored?.parentID ? String(stored.parentID) : null;
  return parentSessionId ? context.sessions.get(parentSessionId) : undefined;
}

async function previewConversationFileRewind(
  record: ZCodeProtocolSessionRecord,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileRewindPreviewResult> {
  return record.app.runtime.previewWorkspaceFileRewind({
    targetMessageIds: messageIds as MessageId[],
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

interface InputCommandForAdmission {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: ConversationInputIntent["botGroupSource"];
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  genUiContext?: ConversationInputIntent["genUiContext"];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  highspeed?: ConversationInputIntent["highspeed"];
  provenance?: ConversationInputIntent["provenance"];
}

type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              // 重试／编辑必须保留与原 row 相同的附件来源，不能重新枚举字段丢失文本材料标记。
              ...attachment,
              ref: attachment.ref,
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * admission 只持久化真正会产生输入的命令。edit/retry 不能从 payload 猜 intent；
 * 必须复用 projection 的 canonical target，并把旧来源折叠进 provenance。
 */
export function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string; attachments?: AttachmentRef[] };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const payload = envelope.payload as {
      text: string;
      attachments?: AttachmentRef[];
      context_refs?: ConversationInputIntent["sharedContextRefs"];
      genUiContext?: ConversationInputIntent["genUiContext"];
      highspeedMeta?: ConversationInputIntent["highspeed"];
      inputOrigin?: "desktop" | "mobile";
      conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
      botGroupSource?: ConversationInputIntent["botGroupSource"];
    };
    return {
      kind: envelope.type,
      ...(envelope.type === "sendText"
        ? normalizeGenUiInput(payload.text, payload.genUiContext)
        : { text: payload.text }),
      attachments: payload.attachments ?? [],
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...(payload.highspeedMeta ? { highspeed: payload.highspeedMeta } : {}),
      ...(payload.inputOrigin ? { inputOrigin: payload.inputOrigin } : {}),
      ...(payload.conversationQuotes ? { conversationQuotes: payload.conversationQuotes } : {}),
      ...(payload.botGroupSource ? { botGroupSource: payload.botGroupSource } : {}),
    };
  }
  if (envelope.type === "compact") {
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    conversationQuotes?: ConversationInputIntent["conversationQuotes"];
    attachments?: AttachmentRef[];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // 会先提交 append-only branch cut，不再为 edit 创建 hidden child。
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    ...(canonical.intent.genUiContext !== undefined
      ? { genUiContext: canonical.intent.genUiContext }
      : {}),
    ...(canonical.intent.inputOrigin ? { inputOrigin: canonical.intent.inputOrigin } : {}),
    ...((payload.conversationQuotes ?? canonical.intent.conversationQuotes)
      ? { conversationQuotes: payload.conversationQuotes ?? canonical.intent.conversationQuotes }
      : {}),
    ...(canonical.intent.botGroupSource ? { botGroupSource: canonical.intent.botGroupSource } : {}),
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

export function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}

function buildForkInitialInput(
  envelope: CommandEnvelope,
  childSessionId: string,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  input: InputCommandForAdmission,
): ForkCommitBundle["initialInput"] {
  const requested = input.requestedDelivery ?? "startNow";
  const fallbackReasonCode = input.fallbackReasonCode;
  const admitted =
    input.admittedDelivery ??
    (fallbackReasonCode ? "queue" : requested === "auto" ? "startNow" : requested);
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: input.kind,
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
    ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
    text: input.text,
    ...(input.genUiContext !== undefined ? { genUiContext: input.genUiContext } : {}),
    attachments: input.attachments,
    delivery: {
      requested,
      admitted,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: { admissionSeq: admission.admissionSeq },
    steer: fallbackReasonCode
      ? { state: "fellBack", reasonCode: fallbackReasonCode }
      : { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: admission.admittedAt,
    ...(input.highspeed ? { highspeed: input.highspeed } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return {
    id: admission.queueItemId,
    sessionID: childSessionId as SessionId,
    kind: intent.kind,
    delivery: intent.delivery.admitted,
    payload: {
      text: intent.text,
      conversationInputIntent: intent,
      attachments: intent.attachments,
      sourceCommandType: envelope.type,
    },
  };
}

async function recordForkStartFailureBestEffort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  command: Pick<CommandEnvelope, "commandId">,
  error: unknown,
  details: { parentSessionId?: string; registrationRequired?: boolean } = {},
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(sessionId);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const warn = (stage: string, failure: unknown) => {
    try {
      context.logger?.warn("fork child post-commit failure recording degraded", {
        commandId: command.commandId,
        error: failure instanceof Error ? failure.message : String(failure),
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        stage,
      });
    } catch {
      // 日志 sink 失败也属于 post-commit；durable child/fact 不得因此反转。
    }
  };

  try {
    await store?.settleSessionInput?.({
      id: queueItemIdForCommand(command.commandId),
      sessionID: sessionId as SessionId,
      status: "failed",
      reason: "fault.command.childStartFailed",
    });
  } catch (failure) {
    warn("ledger", failure);
  }
  try {
    await store?.saveSessionEntry?.({
      id: `v4_fork_start_failure:${command.commandId}`,
      sessionID: sessionId as SessionId,
      type: "v4/fork_start_failure",
      time: { created: now, updated: now },
      data: {
        commandId: command.commandId,
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        ...(details.registrationRequired ? { registrationRequired: true } : {}),
        retryable: true,
        status: "failed",
        reasonCode: "fault.command.childStartFailed",
        message,
      },
    });
  } catch (failure) {
    warn("entry", failure);
  }
  if (!record) return;
  try {
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as SessionId,
      type: SessionEventType.TurnError,
      timestamp: new Date(now),
      traceId: record.traceContext.traceId,
      sequenceNumber: (await record.eventStore.getLatestSequenceNumber(sessionId as SessionId)) + 1,
      payload: {
        inputId: command.commandId,
        turnPhase: "fork_child_start",
        error: {
          type: "fault.command.childStartFailed",
          message,
          retryable: true,
        },
      },
    };
    const persisted = await record.eventStore.append(event);
    context.v4Gateway?.ingest(sessionId, persisted);
  } catch (failure) {
    warn("event", failure);
  }
}

/**
 * Fork bundle commit 是命令 PONR；后续 catalog/model/resume/snapshot 仅恢复 runtime 可达性。
 * 该阶段失败必须留下可重试事实与 warning，但不能把 durable accepted child 反转成 failed。
 */
export async function registerCommittedForkBestEffort(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Parameters<typeof registerForkedSession>[2],
  options: Parameters<typeof registerForkedSession>[3] & { commandId: string },
  register: typeof registerForkedSession = registerForkedSession,
): Promise<void> {
  const { commandId, ...registrationOptions } = options;
  try {
    await register(context, record, fork, registrationOptions);
  } catch (error) {
    const forkedSessionId = String(fork.forkedSessionId);
    const parentSessionId = String(fork.parentSessionId ?? record.app.sessionId);
    await recordForkStartFailureBestEffort(context, forkedSessionId, { commandId }, error, {
      parentSessionId,
      registrationRequired: true,
    });
    try {
      context.logger?.warn("fork child registration failed after durable commit", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
        forkedSessionId,
        parentSessionId,
        retryable: true,
      });
    } catch {
      // logger 自身异常过去会越过 PONR 冒泡，让 gateway 错误 settle 为 failed。
    }
  }
}

/** turn 终态耗时持久化所需的窄化上下文；结构化类型保证与完整 server context 兼容。 */
export interface HighspeedTurnTerminalPersistenceContext {
  sessions: Map<
    string,
    { eventStore: SessionEventStorePort; traceContext: { traceId: string | number } }
  >;
  deps: { sessionStore?: SessionStorePort };
  v4Gateway?: { ingest(sessionId: string, event: SessionEvent): unknown };
  logger?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * turn 终态钩子：把投影累计的真实耗时拆分落到 transcript 的 metadata.highspeed。
 * Bug 根因（2026-08-31 审计 #1）：该钩子由 gateway 对所有 TurnComplete/TurnError 触发，
 * 且投影对普通 turn 也写入 modelDurationMs/toolDurationMs，原“双 undefined 才返回”的
 * 守卫永不生效——每个普通 turn 终态都会先做一次全量 sessionStore.messages() 扫描，
 * 最后才因 metadata.highspeed 缺失返回，长会话热路径白白承担 O(N) I/O。
 * userInput row 自带持久化的 highspeed 身份，进入扫描前先按它短路。
 */
export function persistHighspeedTimingOnTurnTerminal(
  context: HighspeedTurnTerminalPersistenceContext,
  sessionId: string,
  event: SessionEvent,
  snapshot: ConversationSnapshot,
): void {
  const record = context.sessions.get(sessionId);
  const sessionStore = context.deps.sessionStore;
  const payload = event.payload as { inputId?: unknown; duration?: unknown };
  const inputId = typeof payload.inputId === "string" ? payload.inputId : undefined;
  const header = snapshot.rows.window
    .filter(
      (row): row is Extract<(typeof snapshot.rows.window)[number], { kind: "turnHeader" }> =>
        row.kind === "turnHeader" &&
        (inputId === undefined
          ? row.turnId === String(event.turnId)
          : row.sourceCommandId === inputId),
    )
    .at(-1);
  if (!record || !sessionStore || !header?.sourceCommandId) return;
  const user = snapshot.rows.window.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === header.sourceCommandId,
  );
  if (!user || user.kind !== "userInput") return;
  if (!user.highspeed) return;
  if (header.modelDurationMs === undefined && header.toolDurationMs === undefined) {
    return;
  }
  void persistHighspeedTiming({
    sessionStore,
    eventStore: record.eventStore,
    sessionId,
    sourceCommandId: header.sourceCommandId,
    timing: {
      modelDurationMs: header.modelDurationMs ?? 0,
      toolDurationMs: header.toolDurationMs ?? 0,
      otherDurationMs: header.otherDurationMs ?? 0,
    },
    ...(header.outputTokens !== undefined ? { outputTokens: header.outputTokens } : {}),
    ...(header.activeMs !== undefined ? { durationMs: header.activeMs } : {}),
    // fallbackAt 只存在于 live 投影：终态一并写入 transcript，HighspeedMetricsUpdated 与 cold
    // hydration 才不会丢掉它（spec §5）。
    ...(user.highspeed.fallbackAt !== undefined ? { fallbackAt: user.highspeed.fallbackAt } : {}),
    ...(user.highspeed.fallbackReason !== undefined
      ? { fallbackReason: user.highspeed.fallbackReason }
      : {}),
    traceId: String(record.traceContext.traceId),
    onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
    onLiveProjectionError: (error) =>
      context.logger?.warn("v4 highspeed timing live projection failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      }),
  }).catch((error) => {
    context.logger?.warn("v4 highspeed timing persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  });
}

export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  const autoDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Highspeed 执行材料含临时凭据：只按 session/sourceCommandId 驻留内存，绝不进入
  // TurnSteerQueued、snapshot 或 transcript。CLI 重启后缺失时队列提升自动走原模型。
  const queuedTurnExecutions = new Map<string, Map<string, V4QueuedTurnExecution>>();
  const autoDrainV4QueueIfReady = async (record: ZCodeProtocolSessionRecord): Promise<void> => {
    const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
    if (!head) {
      // 外层恢复 FIFO 已消费到空；guide 仍只由 core tool-batch 边界行内消费。
      record.app.completeExternalQueueDrain();
      return;
    }
    const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
    if (
      head.autoDrain &&
      head.dispatchState === "queued" &&
      (record.activeAbortController !== undefined || coreForegroundBusy)
    ) {
      // Bootstrap controller 不覆盖 model-only notification；旧 auto-drain
      // 只看外层锁，因而把“空闲后消费”错误执行成抢占。busy 时不碰 reservation。
      scheduleAutoDrainRetry(record);
      return;
    }
    let targetStatus: GoalStatus | null = null;
    if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
      try {
        targetStatus = (await record.app.readTarget())?.status ?? null;
      } catch (error) {
        // target 读取失败时按“未知且未完成”处理；直接提升会让
        // goal verification 的持久终态尚未可证时普通 queue 偷跑。
        context.logger?.warn("v4 auto-drain held because target state could not be read", {
          error: error instanceof Error ? error.message : String(error),
          queueItemId: head.queueItemId,
          sessionId: record.app.sessionId,
        });
        return;
      }
    }
    if (
      !shouldAutoDrainV4QueueHead({
        autoDrain: head.autoDrain,
        dispatchState: head.dispatchState,
        sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
        targetStatus,
      })
    ) {
      return;
    }
    // 暂停队列恢复后，旧项只存在于投影而不在新 activeTurn 内存中；普通文本也必须
    // 和 typed /goal、/compact 一样走完整投影的队首，避免新输入越过旧暂停项。
    try {
      await nativeExecutor.execute(
        {
          baseRevision: 0,
          clientId: "v4-auto-drain",
          commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
          issuedAt: Date.now(),
          payload: { queueItemId: head.queueItemId },
          sessionId: record.app.sessionId,
          type: "sendQueuedNow",
        },
        undefined,
        { autoDrainPromotion: true },
      );
    } catch (error) {
      if (error instanceof V4QueuePromotionLeaseUnavailableError) {
        // precheck 与 handler 之间可能新入队 notification；idle-only 是最终原子判据。
        scheduleAutoDrainRetry(record);
        return;
      }
      // 自动提升失败不能继续越过该 FIFO barrier；重新暂停并保留原项，交用户重试。
      await record.app.setQueueAutoDrain(false);
      context.logger?.warn("v4 auto-drain failed and queue was paused", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
    }
  };
  const scheduleAutoDrainRetry = (record: ZCodeProtocolSessionRecord): void => {
    const sessionId = record.app.sessionId;
    if (autoDrainRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      autoDrainRetryTimers.delete(sessionId);
      if (context.sessions.get(sessionId) !== record) return;
      void autoDrainV4QueueIfReady(record).catch((error: unknown) => {
        context.logger?.warn("v4 auto-drain idle reevaluation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    }, 100);
    timer.unref?.();
    autoDrainRetryTimers.set(sessionId, timer);
  };
  const coreHost: V4CommandCoreHost = {
    // 同一注册表对象引用：view 是旧 record 的结构化窄视图，字段变更双向可见。
    getRecord: (sessionId) => context.sessions.get(sessionId),
    // 同一登记表实例：broker（旧目录）注册反向请求 deferred，
    // v4 resolveInteraction handler 经此投递应答（v4 原生基础设施，非过渡钩子）。
    interactions: context.v4Interactions,
    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },
    // v4 原生能力（非过渡钩子）：sendQueuedNow 必须读取 v4 投影里的完整 intent。
    // 命令执行时 context.v4Gateway 已由 server 注入（createConversationV4Gateway
    // 返回值回填），这里惰性取用避免构造期自引用。
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,
    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,
    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,
    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,
    retainQueuedTurnExecution: (sessionId, sourceCommandId, execution) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId) ?? new Map();
      sessionExecutions.set(sourceCommandId, execution);
      queuedTurnExecutions.set(sessionId, sessionExecutions);
    },
    readQueuedTurnExecution: (sessionId, sourceCommandId) =>
      queuedTurnExecutions.get(sessionId)?.get(sourceCommandId),
    deleteQueuedTurnExecution: (sessionId, sourceCommandId) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId);
      sessionExecutions?.delete(sourceCommandId);
      if (sessionExecutions?.size === 0) queuedTurnExecutions.delete(sessionId);
    },
    clearQueuedTurnExecutions: (sessionId) => {
      queuedTurnExecutions.delete(sessionId);
    },
    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },
    admitInputCommand: async (envelope, sessionId, admission) => {
      if (!context.deps.sessionStore?.saveSessionInput) return null;
      const input = resolveInputCommandForAdmission(
        envelope,
        sessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) return null;
      const kind = input.kind;
      const record = context.sessions.get(sessionId);
      if (record?.persistence === "deferred") {
        // session_input 有 session 外键；draft 要到 startPromptTurn 后台阶段才持久化，
        // 如果先写 ledger 会直接 FK 失败，accepted 前仍没有权威记录。因此 admission
        // 先走 runtime 的统一首发持久化边界，再落 ledger，随后 handler 只负责执行。
        await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
          traceContext: record.traceContext,
        });
        record.persistence = "immediate";
      }
      const routingMode = context.v4Gateway?.getInputRoutingMode(sessionId) ?? null;
      // 这是执行前账本的“预计投递边界”；TurnSteerQueued 会用实际 delivery/回退原因
      // 幂等更新同一记录。startNow 不能伪装成 queue，否则重启 discarded 的诊断事实失真。
      const requestedDelivery =
        input.requestedDelivery ??
        (kind === "compact" && routingMode !== null && routingMode !== "startNow"
          ? "queue"
          : routingMode === "enqueue"
            ? "queue"
            : routingMode === "guide" && kind === "sendText"
              ? "guide"
              : "startNow");
      const attachmentRefs = input.attachments;
      const fallbackReasonCode =
        input.fallbackReasonCode ??
        (requestedDelivery === "guide" && attachmentRefs.length > 0
          ? "guide.attachmentsUnsupported"
          : undefined);
      const admittedDelivery =
        input.admittedDelivery ??
        (fallbackReasonCode
          ? "queue"
          : requestedDelivery === "auto"
            ? "startNow"
            : requestedDelivery);
      const conversationInputIntent = conversationInputIntentSchema.parse({
        ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
        ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
        ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
        sourceCommandId: envelope.commandId,
        queueItemId: admission.queueItemId,
        clientId: envelope.clientId || "cli",
        kind,
        text: input.text ?? "",
        ...(input.genUiContext !== undefined ? { genUiContext: input.genUiContext } : {}),
        attachments: attachmentRefs,
        ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
        delivery: {
          requested: requestedDelivery,
          admitted: admittedDelivery,
          ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
        },
        order: { admissionSeq: admission.admissionSeq },
        steer: fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : requestedDelivery === "guide"
            ? { state: "submitting" }
            : { state: "notRequested" },
        dispatch: { state: "admitted" },
        admittedAt: admission.admittedAt,
        ...(input.highspeed ? { highspeed: input.highspeed } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      await context.deps.sessionStore.saveSessionInput({
        id: admission.queueItemId,
        sessionID: sessionId as SessionId,
        kind,
        delivery: conversationInputIntent.delivery.admitted,
        payload: {
          text: conversationInputIntent.text,
          intent: {
            sourceCommandId: conversationInputIntent.sourceCommandId,
            queueItemId: conversationInputIntent.queueItemId,
            clientId: conversationInputIntent.clientId,
            kind: conversationInputIntent.kind,
            admissionSeq: admission.admissionSeq,
            admittedAt: admission.admittedAt,
            requestedDelivery: conversationInputIntent.delivery.requested,
            admittedDelivery: conversationInputIntent.delivery.admitted,
            ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
            attachmentRefs,
            ...(conversationInputIntent.genUiContext !== undefined
              ? { genUiContext: conversationInputIntent.genUiContext }
              : {}),
            ...(conversationInputIntent.sharedContextRefs
              ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
              : {}),
          },
          conversationInputIntent,
          attachments: attachmentRefs,
          ...(conversationInputIntent.sharedContextRefs
            ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
            : {}),
          sourceCommandType: envelope.type,
        },
      });
      if (
        conversationInputIntent.sharedContextRefs?.length &&
        conversationInputIntent.delivery.admitted !== "startNow"
      ) {
        const reference = conversationInputIntent.sharedContextRefs[0]!;
        const reserved = await context.deps.sessionStore.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId: reference.context_id,
          expectedStatus: "pending",
          status: "reserved",
          sourceId: admission.queueItemId,
        });
        if (!reserved) {
          await context.deps.sessionStore.settleSessionInput?.({
            id: admission.queueItemId,
            sessionID: sessionId as SessionId,
            status: "failed",
            reason: "shared_context_not_attachable",
          });
          throw new Error("fault.command.sharedContextNotAttachable");
        }
        const entry = (
          await context.deps.sessionStore.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === reference.context_id,
          );
        });
        const data = entry?.data;
        const session = await context.deps.sessionStore.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: reference.context_id,
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "reserved",
          });
        }
      }
      return conversationInputIntent;
    },
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemId,
        sessionID: sessionId as SessionId,
        status: "cancelled",
        reason,
      });
      const store = context.deps.sessionStore;
      const entries = await store?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: "v4/shared_context_import",
      });
      const reserved = entries?.find((entry) => {
        const data = entry.data;
        return Boolean(
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).status === "reserved" &&
          (data as Record<string, unknown>).sourceId === queueItemId,
        );
      });
      const contextId =
        reserved?.data && typeof reserved.data === "object"
          ? (reserved.data as Record<string, unknown>).contextId
          : undefined;
      if (typeof contextId === "string") {
        await store?.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId,
          expectedStatus: "reserved",
          status: "pending",
          sourceId: queueItemId,
        });
      }
    },
    discardSharedContext: async (sessionId, contextId) => {
      const store = context.deps.sessionStore;
      if (!store?.transitionSharedContextImport) return false;
      const updated = await store.transitionSharedContextImport({
        sessionID: sessionId as SessionId,
        contextId,
        expectedStatus: "pending",
        status: "discarded",
      });
      if (updated) {
        const entry = (
          await store.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === contextId,
          );
        });
        const data = entry?.data;
        const session = await store.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          typeof (data as Record<string, unknown>).contextId === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: String((data as Record<string, unknown>).contextId),
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "discarded",
          });
        }
      }
      return updated;
    },
    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
    // held choice 裁决（heldQueueInputRequiresChoice）：读投影 inputRouting.mode。
    getInputRoutingMode: (sessionId) => context.v4Gateway?.getInputRoutingMode(sessionId) ?? null,
    // rowId→messageId 翻译面（fork/edit/retry 的定位决策，数据源 = v4 投影）：
    // 惰性走 gateway 的投影查表。
    getMessageIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdForRow(sessionId, rowId) ?? null,
    resolveRowActionTarget: (sessionId, target, action) =>
      context.v4Gateway?.resolveRowActionTarget(sessionId, target, action) ?? null,
    getMessageIdsForTurnRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdsForTurnRow(sessionId, rowId) ?? [],
    isLatestAssistantSegmentRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestAssistantSegmentRow(sessionId, rowId) ?? null,
    resolveStableForkTarget: async (sessionId, rowId) => {
      const candidate = context.v4Gateway?.resolveStableForkCandidate(sessionId, rowId) ?? null;
      if (!candidate) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      if (!candidate.ok) return candidate;
      const store = context.deps.sessionStore;
      if (!store) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      return await resolveStableForkTargetFromTranscript({
        candidate: candidate.candidate,
        messages,
        store,
      });
    },
    isLatestRetryAssistantRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestRetryAssistantRow(sessionId, rowId) ?? null,
    isLatestEditableUserRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestEditableUserRow(sessionId, rowId) ?? null,
    getTurnIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null,
    // restoreWarning 时序自愈探针：App 的模型视图直接来自进程 Registry。
    hasUsableRuntimeModelTarget: (record) => record.app.listModels().length > 0,
    getTurnRewindAnchor: (sessionId, rowId) =>
      context.v4Gateway?.getTurnRewindAnchor(sessionId, rowId) ?? null,
    resolveUserMessageIdForRow: async (sessionId, rowId) => {
      const turnId = context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null;
      const sessionStore = context.deps.sessionStore;
      if (!turnId || !sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const user = messages
        .filter(
          (message) =>
            message.info.role === "user" &&
            String(message.info.anchor?.turnId ?? "") === turnId &&
            isConversationRealUserTurnStarter(message),
        )
        .at(-1);
      return user ? String(user.info.id) : null;
    },
    // retryTurn 原 prompt 解析：assistant messageId → parentID（user 消息）→ 文本。
    // 数据源 = core sessionStore（transcript 权威）；实现放 binder 只因 deps 注入点
    // 在宿主（随 host 原生持有）。找不到返回 null → handler 只截断不重发。
    resolveTurnUserPrompt: async (sessionId, assistantMessageId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const assistantInfo = messages.find(
        (message) => message.info.id === assistantMessageId,
      )?.info;
      if (assistantInfo?.role !== "assistant") return null;
      const user = messages.find((message) => message.info.id === assistantInfo.parentID);
      if (!user || user.info.role !== "user") return null;
      const text = user.parts
        .filter(
          (part): part is Extract<(typeof user.parts)[number], { type: "text" }> =>
            part.type === "text" && part.ignored !== true,
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : null;
    },
    setAssistantFeedback: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // 原因：反馈必须先落 transcript，CLI 重启后才能从 cold hydration 恢复；
      // eventStore/投影随后推进，失败重试仍可从同一持久事实幂等补齐。
      await persistAssistantFeedback({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        feedback: input.feedback,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 assistant feedback live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    setHighspeedMetrics: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      await persistHighspeedMetrics({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        metrics: input.metrics,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 highspeed metrics live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    // ── 过渡钩子（死期 = M5 波次 2）──────────────────────────────
    ensureModelReady: (record) =>
      ensureSessionModelAvailableForNextTurn(context, record as ZCodeProtocolSessionRecord),
    // 切模型前确认目标 Provider 已存在于当前 Environment Registry。普通模型命令只提交
    // Selection；Provider 事实始终由 Worker 自己的 Registry 解释。
    ensureProviderAvailable: async (sessionId, providerId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return { available: false, reason: "session_not_found" };
      if (!hasSessionModelProvider(context, record, providerId)) {
        return { available: false, reason: "provider_not_in_registry" };
      }
      return { available: true };
    },
    afterLegacyStateMutation: async (record, reason) => {
      await afterStateMutation(context, record as ZCodeProtocolSessionRecord, reason);
      await autoDrainV4QueueIfReady(record as ZCodeProtocolSessionRecord);
    },
    // deleteSession 的执行面：先由 CLI 持久化软删除事实，再内联旧 closeSession op 的
    // 4 步释放运行实例（不 import 旧 op；随波次 2 会话注册表归 v4 后收编）。
    deleteSession: async (sessionId) => {
      if (!context.deps.sessionStore?.softDeleteSession)
        throw new Error("Session soft deletion is unavailable");
      await context.deps.sessionStore.softDeleteSession(sessionId as SessionId);
      const record = context.sessions.get(sessionId);
      if (!record) {
        // handler 已校验存在性；此处只兜并发竞态（重复删除幂等成功）。
        return;
      }
      await closeSessionRuntime(context, sessionId, true);
      queuedTurnExecutions.delete(sessionId);
    },
    // createSession 的执行面：record 建立/事件接线/catalog 同步/失败自清理全在旧
    // createSession op 内（半初始化 record 的回收顺序修过 bug，不重复实现）。
    // 语义决策（draft persistence / firstInput 走原生 prompt turn）在原生 handler。
    createSessionRecord: async ({
      sessionId,
      additionalDirectories,
      workspaceId,
      mcpServers,
      offPeakToolEnabled,
      dynamicWorkflowEnabled,
      dynamicWorkflowMode,
      permissionScope,
    }) => {
      if (permissionScope && !context.deps.sessionStore)
        throw new Error("Group task permission scope requires persistence");
      // workspaceId 双形态（Workspace Identity 约束）：
      // - 本地工作区 = workspacePath（identity 缺省时的 fallback）；
      // - 远程 pane（跨 workspace 分屏）= 远程 identity
      //   （remote:ssh/wsl/docker:...:<path>，UI buildRemoteWorkspaceIdentity 构造）。
      //   经统一解析工具还原真实 workspacePath 作 workingDirectory——CLI 本就跑在
      //   远端机器上，path 即本机路径；identity 原样保留进 workspace ref
      //   （workspaceKey = identity，sessions-index topic / 隔离语义不变）。
      // shared parser 统一兼容 WSL legacy 与显式 user identity；非远程格式继续按
      // 本地 workspacePath 处理。
      const created = await createSessionRecordForV4(context, {
        sessionId,
        additionalDirectories,
        workspace: resolveWorkspaceRefFromId(workspaceId),
        // 群任务已经由首条真实需求触发，先落盘隔离授权，再开放任务与配置。
        // 普通 Desktop draft 仍保持 deferred。
        persistence: "deferred",
        // MCP 是 runtime 创建期配置；v4 createSession 必须与 legacy
        // session/create 等价透传，否则创建的 session 永远不会启动这些工具。
        mcpServers,
        // Off-Peak 工具面 flag 同为 runtime 创建期配置，必须随 create 进入 record。
        ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
        // 动态工作流灰度门同为 runtime 创建期配置：
        // v4 createSession 必须与 legacy session/create 等价透传，否则无界面创建的会话
        // 会绕过 Host 的灰度判定，只剩进程级缺省。
        ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
        ...(dynamicWorkflowEnabled === true && dynamicWorkflowMode !== undefined
          ? { dynamicWorkflowMode }
          : {}),
      });
      if (permissionScope) {
        const record = context.sessions.get(created.sessionId);
        if (!record) throw new Error("Group task runtime is unavailable");
        await record.app.runtime.ensureSessionPersistedForExternalActivity("", {
          traceContext: record.traceContext,
        });
        await context.deps.sessionStore!.updateSession({
          id: created.sessionId as SessionId,
          permission: { version: 1, scope: "session", mode: "build" },
        });
        await record.app.runtime.setExecutionState({ mode: "build" }, record.traceContext);
        record.persistence = "immediate";
      }
      return { sessionId: created.sessionId };
    },
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
    // running stable fork：只走 core transcript copy，再注册 child record。父 runtime、queue、
    // background/continuation inbox 与 shared workspace 均不读取、不停止、不复制。
    forkStableConversation: async (sessionId, options) => {
      const { goalBoundary, revisionAtDecision, sourceCommandId, target } = options;
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      const boundary = messages.find(
        (message) => String(message.info.id) === target.boundaryMessageId,
      );
      if (boundary?.info.role !== "assistant") {
        throw new Error("guard.forkTargetAmbiguous");
      }
      // 分叉继承分叉点的会话选型；加速轮消息记录的是单轮执行 Selection，必须跳过后退回父会话常驻选型。
      const modelSelection = derivedSessionModelSelection(
        boundary.info.providerId && boundary.info.modelId
          ? {
              providerId: boundary.info.providerId,
              modelId: boundary.info.modelId,
              ...(boundary.info.reasoningLevel
                ? { options: { reasoningLevel: boundary.info.reasoningLevel } }
                : {}),
            }
          : undefined,
        record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.forkStableConversationAtMessage({
        modelSelection,
        target,
        goalBoundary,
        sourceCommandId,
        revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: sourceCommandId,
        runtimeConfig: {
          mode: stableForkMode(boundary.info.mode, record.app.getMode()),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        // core 已按 copied message/verifier 边界复制 goal；禁止再用 parent 当前 target 覆盖。
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    forkConversationBeforeInput: async (sessionId, { editTarget, envelope, admission }) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({
        sessionID: sessionId as SessionId,
      });
      const targetMessage = messages.find(
        (message) => String(message.info.id) === editTarget.transcriptMessageId,
      );
      if (targetMessage?.info.role !== "user") {
        throw new Error("guard.latestQueryEditOnly");
      }
      const modelSelection = derivedSessionModelSelection(
        targetMessage.info.modelSelection,
        record.app.runtime.getSessionModelSelection(),
      );
      const events = await record.eventStore.getEvents(sessionId as SessionId);
      const targetStarted = events.find(
        (event) =>
          event.type === SessionEventType.TurnStarted &&
          String((event.payload as { messageId?: unknown }).messageId ?? "") ===
            editTarget.transcriptMessageId,
      );
      const priorTargetChange = targetStarted
        ? events
            .filter(
              (event) =>
                event.sequenceNumber < targetStarted.sequenceNumber &&
                event.type === SessionEventType.TargetChanged,
            )
            .at(-1)
        : undefined;
      const forkedSessionId = String(createSessionId());
      const input = resolveInputCommandForAdmission(
        envelope,
        forkedSessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) throw new Error("fault.command.forkInputAdmissionMissing");
      const initialInput = buildForkInitialInput(envelope, forkedSessionId, admission, input);
      let goalBoundary: StableForkGoalBoundaryMetadata | null = priorTargetChange
        ? (() => {
            const target = (priorTargetChange.payload as { target?: unknown }).target;
            return target
              ? {
                  kind: "snapshot" as const,
                  target: target as Extract<
                    StableForkGoalBoundaryMetadata,
                    { kind: "snapshot" }
                  >["target"],
                  verificationEntryIds: [],
                }
              : { kind: "none" as const };
          })()
        : null;
      if (goalBoundary?.kind === "snapshot" && store.sessionEntries && targetStarted) {
        const targetId = goalBoundary.target.targetID;
        const boundaryTime = targetStarted.timestamp.getTime();
        const entries = await store.sessionEntries({
          sessionID: sessionId as SessionId,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        });
        goalBoundary = {
          ...goalBoundary,
          verificationEntryIds: entries.flatMap((entry) => {
            const data = entry.data as { payload?: { targetId?: unknown } };
            return entry.time.updated <= boundaryTime && data.payload?.targetId === targetId
              ? [entry.id]
              : [];
          }),
        };
      }
      if (!goalBoundary) {
        const targetIndex = messages.indexOf(targetMessage);
        const previousAssistant = messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.info.role === "assistant");
        goalBoundary = previousAssistant?.info.anchor?.goalBoundary ?? null;
        if (!previousAssistant) goalBoundary = { kind: "none" };
      }
      if (!goalBoundary) {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const fork = await record.app.runtime.forkConversationBeforeMessage({
        modelSelection,
        forkedSessionId: forkedSessionId as SessionId,
        targetMessageId: targetMessage.info.id,
        targetProductTurnId: editTarget.productTurnId,
        targetTranscriptTurnId: String(
          targetMessage.info.anchor?.turnId ?? editTarget.productTurnId,
        ),
        sourceCommandId: envelope.commandId,
        initialInput,
        commandFact: {
          parentSessionId: sessionId,
          sourceCommandId: envelope.commandId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: envelope.baseRevision ?? 0,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: forkedSessionId,
            },
          },
          metadata: {
            parentSessionId: sessionId,
            sourceCommandId: envelope.commandId,
            editTarget,
          },
        },
        // 严格取 TurnStarted 之前的 TargetChanged 或上一稳定 assistant anchor；禁止
        // 把 parent 当前（可能正由被编辑 goal 写入）的 target 冒充 input 前状态。
        goalBoundary,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: envelope.commandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    recordForkStartFailure: async (sessionId, envelope, error) => {
      await recordForkStartFailureBestEffort(context, sessionId, envelope, error, {
        parentSessionId: String(envelope.sessionId ?? ""),
      });
    },
  };
  nativeExecutor = new V4CommandExecutor(coreHost);
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // 未加载会话的轻量摘要：store 元信息 → SessionSummary（phase 取空闲完成态默认、
    // sessionEnded=true 对齐 「成功轮收口即 true」口径；加载后的准确
    // phase/preview/backgroundWork 由 gateway 用 live 投影覆盖）。
    // workspaceKey 的本地 fallback = workspacePath，故用它作 listSessions 的 directory 过滤。
    if (!context.deps.sessionStore) return [];
    try {
      // 远端 sessions-index 的 workspaceId 是隔离 identity，而 session store 的
      // directory 是实际文件路径。查询必须同时带路径和 identity；否则同一路径下其他
      // authority 的会话会被误标成当前 workspace。legacy 空 identity 不能只凭路径
      // claim，只允许使用 host task-index 给出的精确 taskId 归属证明。
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "zcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.zcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // claim 只是旧数据兼容步骤；失败后仍要读取已有完整 identity 的会话。
          // 后续携带 allowlist 的订阅会再次进入这里，不能用失败结果封死迁移。
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.zcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        limit: 200,
        // parentID 只表达会话层级，不能作为左侧任务 membership。
        // 显式 fork 必然带 parentID，但重启后仍应由 taskType 投影进 sessions-index。
        taskTypes: [...TASK_LIST_SESSION_TYPES],
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      return stored.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource: normalizeStoredTitleSource(session.titleSource),
        phase:
          session.lastOutcome === "error"
            ? ("error" as const)
            : session.lastOutcome === "interrupted"
              ? ("completedInterrupted" as const)
              : ("completedSuccess" as const),
        ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    } catch (error) {
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.zcode_protocol",
      });
      return [];
    }
  };
  return new ConversationV4Gateway({
    cliVersion: context.deps.version,
    isSessionStopping: (sessionId) => context.sessionLifecycle?.isStopping(sessionId) ?? false,
    sessionExists: (sessionId) =>
      context.sessions.has(sessionId) && (context.sessionLifecycle?.isReady(sessionId) ?? true),
    reconcileSessions: async ({ workspaceId, sessionIds }) => {
      const store = context.deps.sessionStore;
      if (!store) throw new Error("Session store is unavailable");
      const remote = parseRemoteWorkspaceIdentity(workspaceId);
      const directory = remote?.workspacePath ?? workspaceId;
      const sessions = await Promise.all(
        [...new Set(sessionIds)].map(async (sessionId) => {
          const session = await store.getSession(sessionId as SessionId);
          const sameWorkspace =
            session &&
            session.directory === directory &&
            (remote
              ? session.workspaceID === workspaceId
              : !session.workspaceID || session.workspaceID === workspaceId);
          if (!sameWorkspace) return { sessionId, exists: false as const, deleted: false as const };
          return {
            sessionId,
            exists: true as const,
            deleted: session.time.deleted !== undefined,
            title: session.title,
            titleSource: normalizeStoredTitleSource(session.titleSource),
            createdAt: session.time.created,
            updatedAt: session.time.updated,
            ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
          };
        }),
      );
      return { sessions };
    },
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // background task-notification 的 goal verifier 不经过 v4 prompt 的
      // finally/afterLegacyStateMutation；TargetChanged(complete) 虽已提交，future queue
      // 因而没有下一次 mutation 来重评。这里只 detached 触发既有 gate，不能阻塞投影。
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    onHighspeedTurnTerminal: (sessionId, event, snapshot) => {
      persistHighspeedTimingOnTurnTerminal(context, sessionId, event, snapshot);
    },
    // Gateway 的单一 READY promise 负责并发与水位；binder 只恢复 runtime 并返回 M0/M1。
    retainSessionRuntime: async (sessionId) =>
      (await context.sessionResidentPool?.acquireOperation(sessionId)) ?? (() => undefined),
    loadPersistedMessages: async (sessionId) => {
      const store = context.deps.sessionStore;
      if (!store || !(await store.getSession(sessionId as SessionId)))
        throw new Error("fault.subscribe.sessionNotFound");
      return store.messages({ sessionID: sessionId as SessionId });
    },
    resumePersistedSession: async (
      sessionId,
      resumeThoughtLevel,
      workspace?: ZCodeWorkspaceRef,
      additionalDirectories?: string[],
      persistedMessages?: MessageWithParts[],
    ) => {
      const existingRecord = context.sessions.get(sessionId);
      let activated: Awaited<ReturnType<typeof activateSessionRuntime>> | undefined;
      try {
        // 必须先登记生命周期，再读取启动信息。否则 restart 会等待旧 opening，
        // 迟到的旧读取又加入 restart，双方永久等待。
        await getSessionLifecycle(context).initialize(
          sessionId,
          async () => {
            const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
            if (!persisted || persisted.time.deleted !== undefined) {
              throw new SessionLifecycleError("sessionNotFound", `Session not found: ${sessionId}`);
            }
            activated = await activateSessionRuntime(
              context,
              {
                sessionId,
                // attachment 的 workspace 身份与附加目录仍由原恢复入口传递。
                ...(workspace ? { workspace } : {}),
                ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
                ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
              },
              { reusePersistedMessages: true, persistedMessages },
            );
          },
          workspace,
        );
      } catch (error) {
        if (!(error instanceof SessionLifecycleError) || error.code !== "sessionNotFound")
          throw error;
        context.logger?.warn("ZCode Protocol v4 cold resume has no persisted session", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.resume_persisted_missing",
          module: "bootstrap.zcode_protocol",
          sessionId,
        });
        return { status: "notFound" };
      }
      const record = activated?.record ?? context.sessions.get(sessionId);
      if (!record) throw new Error("Session runtime unavailable after initialization");
      return {
        status: "resumed",
        persistedMessages: activated?.persistedMessages,
        ...(!existingRecord
          ? { disposeOnFailure: () => discardFailedSessionResume(context, sessionId, record) }
          : {}),
      };
    },
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),
    emitPluginUiToolResult: (result) =>
      context.notify({ method: V4_NOTIFICATIONS.pluginUiToolResult, params: result }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    // ── config 种子：投影初值 = runtime 真值 ─────────────
    // 覆盖三个种子来源：启动缺省（Workspace 模型偏好 + 项目持久化 mode）、
    // createSession.config（handler 先应用到 runtime 再种）、历史会话 resume
    // （App 恢复结果可以只有模型身份，不能为了投影而绑定半成品执行模型）。
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,
    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },
    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // usage seed 会在 hydration 后再次覆盖首帧分母；必须与合成事件
      // 使用同一份当前模型 registry 真值，不能把旧 runtime projection 的窗口写回来。
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },
    // ── sessions-index hooks（workspace 分桶 + 冷启动 store 种子）──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },
    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.lastOutcome ? { lastOutcome: record.lastOutcome } : {}),
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },
    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),
    // draft 判定：deferred = 未发首条输入（prompt-turn 首发提升为 immediate）。
    // 旧 workspace prepare 预建的 deferred 会话不得以「新任务」漏进侧栏列表。
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",
    // ── workspace-config hook（配置目录订阅种子；live session 快路径，避免临时 app）──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),
    getStoredSessionSummaries: loadStoredSessionSummaries,
    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
    // 回落面已清零（20 命令全部原生）：supports 未命中（未知命令类型）→
    // notImplemented → ACK failed fault.command.notImplemented。
    executeCommand: (envelope, admission) =>
      nativeExecutor.supports(envelope.type)
        ? nativeExecutor.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type)),
    admitCommandInput: async (envelope, admission) => {
      // 仅隐藏 composer 不能阻止旧 child 标签页续聊。类型准入必须早于
      // ledger/输入历史写入；detached child 没有 record 时只查元数据，不激活第二个 runtime。
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (isReadonlyAgentSessionKind(taskType)) {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },
    cancelCommandInput: async (envelope, queueItemId, reason) => {
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },
    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      if (!controller || controller.signal.aborted) return;
      // 修复原因：投影越过 16MiB 后继续生成只会让所有后续 snapshot 都无法编码。
      // gateway 先原子拒绝越界事件并登记 protocol fault，再单次调用这里中止模型 turn；
      // abort 的正常终态负责释放 active lock，不能在 gateway 里越层伪造 TurnError。
      controller.abort(createExternalTurnFaultError(reasonCode));
    },
    // commands/query 持久化 fallback：同 session 首次查询惰性建索引，后续四个来源
    // 共用该索引；anchor/marker/child/discarded 写入走 record 增量更新。
    lookupTranscriptCommand: (key) =>
      key.sessionId === null
        ? lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId)
        : persistentCommands.lookup("transcript", key),
    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),
    lookupChildCommand: (key) => persistentCommands.lookup("child", key),
    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),
    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
    // gateway 已完成逐片总量/checksum 校验，只把完整 bytes 原子写 artifact。
    putSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.writePromptAttachment(input);
    },
    readBackgroundBashOutput: (sessionId, workId) =>
      readBackgroundBashOutputFromOwner(context, sessionId, workId),
    readSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.readPromptAttachment(input);
    },
    statSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.statPromptAttachment) {
        throw new Error("fault.attachment.statUnsupported");
      }
      return record.app.statPromptAttachment(input);
    },
    resolveSessionAttachmentPreviewSource: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.resolvePromptAttachmentPreviewSource(input);
    },
    getConversationFileChanges: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        throw new Error(`fault.fileChanges.sessionNotFound: ${sessionId}`);
      }
      return readConversationFileChanges(record, sessionId, messageIds, targetTurnId);
    },
    // dwf 事件日志：能力在 app 上（run service 构造成功才有），缺席时不在这里兜底成空页——
    // gateway 会回结构化的能力不支持错误，让 renderer 能区分"没有事件"与"没有这个能力"。
    listDynamicWorkflowRunEvents: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunEvents.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunEvents) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRunEvents(input);
    },
    // workflow run 枚举：能力条件同上（run service 构造成功才有）。
    listDynamicWorkflowRuns: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRuns) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRuns(input);
    },
    // dwf 用户面产物的三个读面：能力条件同上。
    // ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
    listDynamicWorkflowRunArtifacts: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifacts.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifacts) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifacts(input);
    },
    listDynamicWorkflowRunArtifactItems: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactData.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifactItems) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifactItems(input);
    },
    readDynamicWorkflowRunArtifact: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactRead.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunArtifact) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", sessionId);
      }
      return record.app.readDynamicWorkflowRunArtifact(input);
    },
    // dwf 工作区 transcript 的两个读面：能力条件同上。
    listDynamicWorkflowRunWorkspaceNodes: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunWorkspace.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunWorkspaceNodes) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunWorkspaceNodes", sessionId);
      }
      return record.app.listDynamicWorkflowRunWorkspaceNodes(input);
    },
    readDynamicWorkflowRunNodeResult: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunNodeResult.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunNodeResult) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", sessionId);
      }
      return record.app.readDynamicWorkflowRunNodeResult(input);
    },
    previewConversationFileRewind: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.fileRewindPreview.sessionNotFound: ${sessionId}`);
      }
      return previewConversationFileRewind(record, messageIds, targetTurnId);
    },
    // 冷订阅不再在 eventStore / transcript 之间 XOR。message/part
    // 是已完成正文权威，session_entry 只补 legacy goal，内存事件只补
    // 未持久 in-flight 和 queue/permission/control 等 ephemeral 状态。
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // dwf workflow actor / subagent 这类 detached live child 没有自己的
      // bootstrap record（事件经 ingestDetachedLiveSession 走父 record 的 sink 路由）。
      // context.sessions.get 取不到 record 时不能直接返回 synthesized:false——
      // 否则首次订阅的 performHydration 会走"保留健康 live publisher"早退分支，
      // durable transcript 三源合并从不执行——只由 live 事件喂养的投影会丢掉所有
      // 不以 live 事件形式出现的持久正文。amend-resume 把前驱 transcript 前缀直接
      // 复制进 session store 来播种 actor 会话，
      // 这段前缀正属于此类，于是侧栏 actor transcript 只剩本次 live 增量；
      // 普通崩溃恢复后 warm 窗口同样看不到 crash 前的 actor 消息。
      // 改用 resolveConversationBackingRecord：child 自身没有 record 时按持久
      // parentID 落到父 record，只借它的共享 event/artifact store，事件读取仍显式用
      // child 自己的 sessionId（script workflow child runtime 共享父 event store，
      // 事件按 child sessionId 归档），因此 sourceEventSeq 仍是 child 的真实水位。
      // 代价：contextWindow 分母会按父 record 的当前模型解析而不是 actor 模型，纯展示层偏差。
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // detached live child 继续使用在线尾部；仅显式携带 M0 的冷打开可以独立物化历史。
        if (persistedMessages === undefined)
          return { events: [], synthesized: false, sourceEventSeq: 0 };
        // 主对话历史只依赖持久化事实；旧路径在这里返回空数组会把冷会话误画成空白。
        const store = context.deps.sessionStore;
        if (!store) throw new Error("fault.subscribe.sessionNotFound");
        const source = await loadPersistedConversationMaterialization({
          sessionId,
          persistedMessages,
          memoryEvents: [],
          store,
        });
        const merged = mergeColdConversationEvents({ ...source, sessionId });
        return {
          events: merged.events,
          synthesized: true,
          sourceEventSeq: 0,
          ...(source.sharedContextImport
            ? { sharedContextImport: source.sharedContextImport }
            : {}),
        };
      }
      // message/part 与 session_entry 的异步读取期间 live sink 仍可收到新事件。
      // gateway 必须知道 memory eventStore 取快照时的 raw cursor，才能只补 await 窗口内
      // 的尾部，并把 transcript 合成的 1..N 序列稳定映射回后续 runtime raw seq。
      // 内存 event store 会淘汰已完成 turn 的瞬态事件，max(events.seq) 会小于真实
      // 游标，让已淘汰的 delta 被当成 await 窗口尾部重放。两次调用之间没有 await，拿到的是
      // 同一时刻的一致快照。
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // workflow run 的冷回放：journal 回放出的进度
      // 事件前置到内存事件之前——cold merge 已把该类型归为 memory-only 权威（保序进 supplements），
      // 投影经同一个 reducer 归约，`workflowRuns` 因此在重启前后一致。
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "zcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.zcode_protocol",
                          });
                          return [];
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges 只存在于内存事件；cold merge 以持久
      // transcript 为正文权威时会压掉该事件，而 transcript 本身没有文件摘要字段。
      // workspace checkpoint + artifact 才是跨进程持久事实，这里按 user messageId
      // 重建摘要，再交给 transcript hydration 合成同构 ModelComplete。
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.zcode_protocol",
            sessionId,
          }),
      });
      // 冷恢复 transcript 不保存模型能力，旧 hydration 自行填 20 万；
      // provider registry 已在 resume 前同步完成，应按恢复/退避后的当前模型精确取值。
      const contextWindow = resolveSessionModelContextWindow(context, record);
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "zcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.zcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // transcript 可恢复 Agent row，却不能证明 child session 已经落库。
      // 这里在 gateway 的 raw-event buffer 补回前生成校验种子，既排除旧幽灵引用，
      // 又避免异步查询覆盖 seed 之后新到达的 live spawn/stop。
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
        // 与合成事件共用本次查询结果；不在后续回填阶段重新读取另一份容量。
        usageSeed,
        // gateway 旧字段名仍叫 synthesized；这里表示投影已由 durable
        // transcript 重物化，需替换 ingest 抢先建的 cold publisher。
        synthesized: merged.usedDurableTranscript,
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        sourceEventSeq,
      };
    },
    onError: (scope, error, errorContext) =>
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  });
}

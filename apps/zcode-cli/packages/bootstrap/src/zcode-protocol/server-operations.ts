import { isAbsolute, resolve } from "node:path";
import {
  isAuxiliarySessionKind,
  isReadonlyAgentSessionKind,
  OFF_PEAK_EXECUTION_TOOL_DENYLIST,
} from "@zcode/shared";
/* eslint-disable max-lines -- ZCode Protocol 的 session/workspace 方法共享同一个 server context 与 snapshot helpers，迁移期先集中维护。 */
import { observeSessionDebug } from "./session-debug.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";
import { inputIntentMetadata } from "../zcode-protocol-v4/commands/input-intent.js";
import { createModelExecutionContext } from "./model-execution.js";
import type { SendInputOptions } from "../app/types.js";
import { repairPersistedRemoteSessionPaths, type TurnAttachment } from "@zcode/core";
import {
  CoreErrorType,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  createMessageId,
  createPartId,
  createSessionId,
  createCoreError,
  parseRewindTriggeredPayload,
  RewindScope,
  RewindStrategy,
  type EventId,
  type ExecutionShellSelection,
  type MessageWithParts,
  type ModelSelection,
  type MessageId,
  type ModelId,
  type ModelProviderId,
  type QueryId,
  type SessionEvent,
  SessionEventType,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
  type CollaborationMode,
  type TargetCompletionVerificationPayload,
  type TraceId,
  type TurnBackgroundAttribution,
  type TurnId,
  type UsageStorePort,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  subagentRuntimeConfigSchema,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
  zcodeSessionCancelBackgroundTaskParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionCloseParamsSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionEventsParamsSchema,
  zcodeSessionForkParamsSchema,
  zcodeSessionGoalParamsSchema,
  zcodeSessionListParamsSchema,
  zcodeSessionMessagesParamsSchema,
  zcodeSessionReadParamsSchema,
  elideSessionSnapshotForIndex,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionSetModeParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSetThoughtLevelParamsSchema,
  zcodeSessionStopParamsSchema,
  zcodeSessionSubscribeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeTaskTokenUsageParamsSchema,
  zcodeUsageStatsParamsSchema,
  zcodeWorkspaceGenerateTextParamsSchema,
  getConversationMessageProjectionPolicy,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type AppToolSearchMode,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeSessionCreateParams,
  type ZCodeDeliveryKind,
  type IntegratedTerminalShellSelection,
  type ZCodeSessionRuntimePreferencesScope,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolTrace,
  type ZCodeSessionEvent,
  type ZCodeSessionHistoryTarget,
  type ZCodeSessionResumeParams,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
  type ZCodeStateUpdatedNotification,
} from "@zcode/shared";
import {
  buildSessionSnapshot,
  buildWorkspaceRef,
  formatProtocolModelSelection,
  mapSessionEventForProtocol,
  mapSessionInfo,
  resolveSessionContextUsage,
  shouldExposeSessionEventToProtocol,
} from "./mapper.js";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  createProtocolLogger,
  createProtocolRootTraceContext,
  protocolTraceFromTraceContext,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
  type ZCodeProtocolToolInputTransmissionState,
} from "./server-types.js";
import { createWorkspaceZCodeApp, ensureSessionModelAvailable } from "./workspace-model-runtime.js";
import { buildAppUsageSnapshot, resolveTzOffsetMs } from "./usage-stats-builder.js";
import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createProtocolAutomationPort } from "./automation-port.js";
import { createProtocolOffPeakPort } from "./offpeak-port.js";
import { createProtocolTopicResourcePort } from "./topic-resource-port.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  collectSubagentChildSessionIds,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "./subagent-session-query.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { resolveDynamicWorkflowRuntimeGate } from "./dynamic-workflow-policy.js";
import {
  runWithSessionResidencyFinalization,
  getSessionLifecycle,
  closeSessionRuntime,
  discardSessionRuntime,
} from "./session-residency.js";

const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE = "Plan mode 下已记录 goal，但不会自动继续。";
const SLOW_SNAPSHOT_LOG_THRESHOLD_MS = 1000;
const REMOTE_AUTOMATION_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
  "CronPauseSelf",
] as const;

type ProtocolGoalTarget = NonNullable<
  Awaited<ReturnType<NonNullable<ZCodeProtocolSessionRecord["app"]["readTarget"]>>>
>;

type ZCodeSessionRecordParams = (
  | ZCodeSessionCreateParams
  | (ZCodeSessionResumeParams & {
      mode?: ZCodeSessionCreateParams["mode"];
      model?: ZCodeSessionCreateParams["model"];
      parentSessionId?: ZCodeSessionCreateParams["parentSessionId"];
      thoughtLevel?: ZCodeSessionCreateParams["thoughtLevel"];
      // 自动化会话会在创建期关闭标题二次生成，而 create/resume
      // 共用 record 初始化函数；resume 兼容分支也必须声明该策略字段。
      titleGenerationEnabled?: ZCodeSessionCreateParams["titleGenerationEnabled"];
    })
) & { taskType?: SessionTaskType };

interface SessionStartupPreferences {
  additionalDirectories?: readonly string[];
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  resolveInitialBashShellSelection: () => Promise<ExecutionShellSelection | undefined>;
}

type SessionStartupPreferencesSource =
  | { kind: "host" }
  | { kind: "inherit"; parent: ZCodeProtocolSessionRecord };

function resolveSupportedAppThoughtLevel(
  app: Pick<ZCodeProtocolSessionRecord["app"], "listThoughtLevels">,
  thoughtLevel: string | undefined,
): string | undefined {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return undefined;
  }
  const supportedLevels = app.listThoughtLevels();
  return supportedLevels.includes(normalizedThoughtLevel) ? normalizedThoughtLevel : undefined;
}

const DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY = "__default__";
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS = 4 * 1024;
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS = 750;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS = 2 * 1024;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS = 250;

type ProtocolStreamingDeltaKind = "reasoning_delta" | "text_delta" | "tool_input_delta";

interface ProtocolStreamingDeltaBatchInfo {
  batchKey: string;
  delta: string;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  shouldFlushFirstDelta: boolean;
  timestampMs: number;
}

interface ProtocolStreamingDeltaBatch {
  batchKey: string;
  delta: string;
  event: SessionEvent;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  startedAtMs: number;
  updatedAtMs: number;
}

interface LiveProtocolStreamingDeltaBatch {
  batch?: ProtocolStreamingDeltaBatch;
  flushedFirstDeltaBatchKeys: Set<string>;
  lastFlushAtByBatchKey: Map<string, number>;
}

const liveProtocolStreamingDeltaBatches = new WeakMap<
  ZCodeProtocolSessionRecord,
  Map<string, LiveProtocolStreamingDeltaBatch>
>();

function protocolEventSequenceKey(deliveryKind?: ZCodeDeliveryKind): string {
  return deliveryKind ?? DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY;
}

function getProtocolEventSequenceState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
) {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolEventSequences.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    lastSeq: 0,
    seqBySourceEventKey: new Map<string, number>(),
  };
  record.protocolEventSequences.set(key, created);
  return created;
}

function getProtocolToolInputTransmissionState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeProtocolToolInputTransmissionState {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolToolInputTransmissions.get(key);
  if (existing) {
    return existing;
  }
  const created: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  record.protocolToolInputTransmissions.set(key, created);
  return created;
}

function protocolSourceEventKey(event: SessionEvent): string {
  return event.sequenceNumber > 0 ? `seq:${event.sequenceNumber}` : `event:${String(event.id)}`;
}

function assignProtocolEventSeq(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): number {
  const state = getProtocolEventSequenceState(record, deliveryKind);
  const sourceEventKey = protocolSourceEventKey(event);
  const existing = state.seqBySourceEventKey.get(sourceEventKey);
  if (existing !== undefined) {
    return existing;
  }
  const nextSeq = state.lastSeq + 1;
  state.lastSeq = nextSeq;
  state.seqBySourceEventKey.set(sourceEventKey, nextSeq);
  return nextSeq;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getLiveProtocolStreamingDeltaBatchState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): LiveProtocolStreamingDeltaBatch {
  let byDeliveryKind = liveProtocolStreamingDeltaBatches.get(record);
  if (!byDeliveryKind) {
    byDeliveryKind = new Map();
    liveProtocolStreamingDeltaBatches.set(record, byDeliveryKind);
  }
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = byDeliveryKind.get(key);
  if (existing) {
    return existing;
  }
  const created: LiveProtocolStreamingDeltaBatch = {
    flushedFirstDeltaBatchKeys: new Set(),
    lastFlushAtByBatchKey: new Map(),
  };
  byDeliveryKind.set(key, created);
  return created;
}

function buildProtocolStreamingDeltaBatchKey(params: {
  assistantMessageId?: string;
  inputId?: string;
  kind: ProtocolStreamingDeltaKind;
  partId?: string;
  parentToolUseId?: string;
  toolCallId?: string;
}): string {
  return [
    params.kind,
    params.assistantMessageId ?? "",
    params.inputId ?? "",
    params.partId ?? "",
    params.parentToolUseId ?? "",
    params.toolCallId ?? "",
  ].join(":");
}

function readProtocolStreamingParentToolUseId(
  payload: Record<string, unknown>,
): string | undefined {
  const direct = stringValue(payload.parentToolUseId) ?? stringValue(payload.parentToolCallId);
  if (direct) {
    return direct;
  }
  const meta = asRecord(payload._meta);
  const zcode = asRecord(meta.zcode);
  const claudeCode = asRecord(meta.claudeCode);
  return (
    stringValue(meta.parentToolUseId) ??
    stringValue(meta.parentToolCallId) ??
    stringValue(zcode.parentToolUseId) ??
    stringValue(zcode.parentToolCallId) ??
    stringValue(claudeCode.parentToolUseId) ??
    stringValue(claudeCode.parentToolCallId)
  );
}

function timestampMsForProtocolEvent(event: SessionEvent): number {
  const timestampMs = event.timestamp.getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function readStreamingDeltaBatchableEvent(
  event: SessionEvent,
): ProtocolStreamingDeltaBatchInfo | null {
  if (event.type !== SessionEventType.ModelStreaming) {
    return null;
  }
  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind) as ProtocolStreamingDeltaKind | undefined;
  if (kind !== "tool_input_delta" && kind !== "text_delta" && kind !== "reasoning_delta") {
    return null;
  }
  const delta = stringValue(payload.delta);
  if (!delta) {
    return null;
  }
  const assistantMessageId = stringValue(payload.assistantMessageId);
  const inputId = stringValue(payload.inputId);
  const partId = stringValue(payload.partId);
  const parentToolUseId = readProtocolStreamingParentToolUseId(payload);
  const toolCallId = stringValue(payload.toolCallId);
  if (kind === "tool_input_delta" && !toolCallId) {
    return null;
  }
  return {
    batchKey: buildProtocolStreamingDeltaBatchKey({
      assistantMessageId,
      inputId,
      kind,
      partId,
      parentToolUseId,
      toolCallId,
    }),
    delta,
    kind,
    maxChars:
      kind === "tool_input_delta"
        ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS
        : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS,
    shouldFlushFirstDelta:
      kind === "text_delta" || kind === "reasoning_delta" || kind === "tool_input_delta",
    timestampMs: timestampMsForProtocolEvent(event),
  };
}

function mergeProtocolStreamingDeltaBatch(
  batch: ProtocolStreamingDeltaBatch | undefined,
  event: SessionEvent,
  deltaInfo: ProtocolStreamingDeltaBatchInfo,
): ProtocolStreamingDeltaBatch {
  if (!batch || batch.batchKey !== deltaInfo.batchKey) {
    return {
      batchKey: deltaInfo.batchKey,
      delta: deltaInfo.delta,
      event,
      kind: deltaInfo.kind,
      maxChars: deltaInfo.maxChars,
      startedAtMs: deltaInfo.timestampMs,
      updatedAtMs: deltaInfo.timestampMs,
    };
  }
  return {
    batchKey: deltaInfo.batchKey,
    delta: `${batch.delta}${deltaInfo.delta}`,
    event,
    kind: deltaInfo.kind,
    maxChars: deltaInfo.maxChars,
    startedAtMs: batch.startedAtMs,
    updatedAtMs: deltaInfo.timestampMs,
  };
}

function materializeProtocolStreamingDeltaBatch(batch: ProtocolStreamingDeltaBatch): SessionEvent {
  const payload = asRecord(batch.event.payload);
  return {
    ...batch.event,
    payload: {
      ...payload,
      delta: batch.delta,
    },
  };
}

function rememberProtocolStreamingDeltaBatchFlush(
  lastFlushAtByBatchKey: Map<string, number>,
  batch: ProtocolStreamingDeltaBatch,
): void {
  lastFlushAtByBatchKey.set(batch.batchKey, batch.updatedAtMs);
}

function shouldFlushProtocolStreamingDeltaBatchForInterval(
  batch: ProtocolStreamingDeltaBatch,
  lastFlushAtByBatchKey: Map<string, number>,
): boolean {
  const lastFlushAt = lastFlushAtByBatchKey.get(batch.batchKey);
  if (lastFlushAt === undefined) {
    return false;
  }
  // active 任务的流式 function call 不能只按 4KB 字节预算出包。
  // 单行 JSON 参数会在 protocol 边界长时间滞留，表现为工具卡参数不再流式更新。
  const maxIntervalMs =
    batch.kind === "tool_input_delta"
      ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS
      : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS;
  return batch.updatedAtMs - lastFlushAt >= maxIntervalMs;
}

function markStreamedToolInputIfPresent(
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): void {
  if (mappedEvent.type !== "model.streaming") {
    return;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "tool_call" || !("input" in payload)) {
    return;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return;
  }
  toolInputTransmissions.streamedToolCallIdsWithInput.add(toolCallId);
}

function omitDuplicateScheduledToolInput(
  event: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): ZCodeSessionEvent {
  markStreamedToolInputIfPresent(mappedEvent, toolInputTransmissions);
  if (event.type !== SessionEventType.ToolCallScheduled || mappedEvent.type !== "tool.updated") {
    return mappedEvent;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "scheduled" || !("input" in payload)) {
    return mappedEvent;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId || !toolInputTransmissions.streamedToolCallIdsWithInput.has(toolCallId)) {
    return mappedEvent;
  }

  const nextPayload: Record<string, unknown> = { ...payload };
  const input = nextPayload.input;
  delete nextPayload.input;
  nextPayload.inputByteLength = measureJsonBytes(input);
  nextPayload.inputOmitted = true;
  nextPayload.inputRef = "model_stream";
  // 性能修复：AI SDK 的 tool_call 已经在 model.streaming 里交付完整 input；
  // scheduled 只是生命周期边界，重复携带 Write/Edit 大参数会让 stdio 和 renderer 双重放大。
  return {
    ...mappedEvent,
    payload: nextPayload,
  };
}

function mapProtocolPromptAttachments(
  attachments: unknown[] | undefined,
): TurnAttachment[] | undefined {
  const mapped = (attachments ?? [])
    .map(mapProtocolPromptAttachment)
    .filter((attachment): attachment is TurnAttachment => attachment !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}

function mapProtocolPromptAttachment(attachment: unknown): TurnAttachment | undefined {
  const record = asRecord(attachment);
  const kind = stringValue(record.kind);
  const filename = stringValue(record.filename) ?? "attachment";
  const localPath = stringValue(record.localPath);
  const mimeType = stringValue(record.mimeType);
  const isPdf =
    kind === "pdf" || mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  // GUI 协议附件使用 kind/localPath/dataBase64，而 core runtime 只认 type/path/content。
  // 这里在协议边界完成语义转换，避免把 renderer 的传输格式泄漏到 agent 内部。
  // 展示元信息（filename/mimeType/sizeBytes）在协议边界保真透传，
  // TurnStarted 事件与 v4 userInput row 的附件展示不再依赖 basename/扩展名推断。
  const displayMeta = {
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
  };
  if (isPdf) {
    if (localPath) {
      return { path: localPath, type: "pdf", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    return dataBase64
      ? {
          content: `data:application/pdf;base64,${dataBase64}`,
          path: filename,
          type: "pdf",
          ...displayMeta,
        }
      : undefined;
  }
  if (kind === "image") {
    if (localPath) {
      return { path: localPath, type: "image", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "image/*";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "image",
          ...displayMeta,
        }
      : undefined;
  }

  // video：localPath 零拷贝（agent 侧读文件做大小校验）；Web 端 dataBase64 组 data URL inline。
  if (kind === "video") {
    if (localPath) {
      return { path: localPath, type: "video", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "video/mp4";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "video",
          ...displayMeta,
        }
      : undefined;
  }

  if (kind === "file" || kind === "audio") {
    if (localPath) {
      return {
        path: localPath,
        ...(kind === "file" &&
        (stringValue(record.sourceKind) === "clipboard-text" ||
          stringValue(record.sourceKind) === "topic-history")
          ? { sourceKind: stringValue(record.sourceKind) as "clipboard-text" | "topic-history" }
          : {}),
        type: "file",
        ...displayMeta,
      };
    }
    const textContent = stringValue(record.textContent);
    if (textContent !== undefined) {
      return {
        content: textContent,
        path: filename,
        type: "file",
        ...displayMeta,
      };
    }
    const decoded = decodeTextProtocolAttachment(record);
    return decoded !== undefined
      ? { content: decoded, path: filename, type: "file", ...displayMeta }
      : undefined;
  }

  return undefined;
}

function decodeTextProtocolAttachment(record: Record<string, unknown>): string | undefined {
  const dataBase64 = stringValue(record.dataBase64);
  if (!dataBase64) return undefined;
  const sizeBytes = numberValue(record.sizeBytes);
  if (sizeBytes !== undefined && sizeBytes > 64 * 1024) return undefined;
  try {
    return Buffer.from(dataBase64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function shouldHideProtocolSessionEvent(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): boolean {
  const payload = asRecord(event.payload);
  const querySource = stringValue(payload.querySource);
  if (event.type === "model_request" && querySource === "session_title") {
    return true;
  }
  if (event.type === "model_network_status" && querySource === "session_title") {
    // 不能用标题生成的全局 suppress 标记隐藏 model_network_status：
    // 标题请求重试时会把并发主请求的 retry 事件也吞掉，导致 app 输入框右下角看不到重试次数。
    // status 事件带 querySource，只隐藏标题生成自己的网络状态。
    return true;
  }
  if (event.type === "model_complete" && querySource === "session_title") {
    return true;
  }
  return false;
}

function mapProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: {
    toolInputTransmissions?: ZCodeProtocolToolInputTransmissionState;
  } = {},
): ZCodeSessionEvent | null {
  if (shouldHideProtocolSessionEvent(record, event)) {
    return null;
  }
  if (!shouldExposeSessionEventToProtocol(event)) {
    const payload = asRecord(event.payload);
    context.logger?.debug("ZCode Protocol session event filtered", {
      event: "zcode_protocol.session_event.filtered",
      eventId: String(event.id),
      module: "bootstrap.zcode_protocol",
      payloadKind: stringValue(payload.kind),
      sessionEventSequenceNumber: event.sequenceNumber,
      sessionEventType: event.type,
      sessionId: String(event.sessionId),
      turnId: event.turnId ? String(event.turnId) : undefined,
    });
    return null;
  }
  // eventStore 的 sequenceNumber 是内部全量账本，包含被协议过滤的
  // tool_input_delta 等高频模型中间态。ZCode Protocol 的 seq 是 UI/replay 的恢复键，
  // 必须按“协议实际可见事件流”重新连续编号，不能直接暴露内部 sequenceNumber。
  // sequenceNumber=0 的 subagent mirror/live-only 事件没有进入父 eventStore，也必须
  // 按 eventId 分配独立 seq，不能全部复用同一个 0 号映射。
  const protocolSeq = assignProtocolEventSeq(record, event, deliveryKind);
  const mappedEvent = mapSessionEventForProtocol(event, deliveryKind, {
    seq: protocolSeq,
  });
  if (!mappedEvent) {
    return null;
  }
  return omitDuplicateScheduledToolInput(
    event,
    mappedEvent,
    options.toolInputTransmissions ?? getProtocolToolInputTransmissionState(record, deliveryKind),
  );
}

async function readProtocolSessionEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ZCodeSessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  const visibleEvents: ZCodeSessionEvent[] = [];
  const toolInputTransmissions: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  let pendingStreamingDeltaBatch: ProtocolStreamingDeltaBatch | undefined;
  const flushedFirstDeltaBatchKeys = new Set<string>();
  const lastFlushAtByBatchKey = new Map<string, number>();
  const pushMappedEvent = (event: SessionEvent): void => {
    const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind, {
      toolInputTransmissions,
    });
    if (!mappedEvent) return;
    if (options.afterSeq !== undefined && mappedEvent.seq <= options.afterSeq) return;
    visibleEvents.push(mappedEvent);
  };
  const flushPendingStreamingDeltaBatch = (): void => {
    if (!pendingStreamingDeltaBatch) {
      return;
    }
    rememberProtocolStreamingDeltaBatchFlush(lastFlushAtByBatchKey, pendingStreamingDeltaBatch);
    pushMappedEvent(materializeProtocolStreamingDeltaBatch(pendingStreamingDeltaBatch));
    pendingStreamingDeltaBatch = undefined;
  };
  const resetPendingStreamingDeltaBatch = (): void => {
    flushPendingStreamingDeltaBatch();
    flushedFirstDeltaBatchKeys.clear();
    lastFlushAtByBatchKey.clear();
  };
  for (const event of events) {
    if (
      shouldHideProtocolSessionEvent(record, event) ||
      !shouldExposeSessionEventToProtocol(event)
    ) {
      resetPendingStreamingDeltaBatch();
      pushMappedEvent(event);
      continue;
    }
    const deltaInfo = readStreamingDeltaBatchableEvent(event);
    if (deltaInfo) {
      if (
        pendingStreamingDeltaBatch &&
        pendingStreamingDeltaBatch.batchKey !== deltaInfo.batchKey
      ) {
        flushPendingStreamingDeltaBatch();
      }
      pendingStreamingDeltaBatch = mergeProtocolStreamingDeltaBatch(
        pendingStreamingDeltaBatch,
        event,
        deltaInfo,
      );
      if (deltaInfo.shouldFlushFirstDelta && !flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)) {
        flushPendingStreamingDeltaBatch();
        flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
        continue;
      }
      if (
        pendingStreamingDeltaBatch.delta.length >= pendingStreamingDeltaBatch.maxChars ||
        shouldFlushProtocolStreamingDeltaBatchForInterval(
          pendingStreamingDeltaBatch,
          lastFlushAtByBatchKey,
        )
      ) {
        flushPendingStreamingDeltaBatch();
      }
      continue;
    }
    resetPendingStreamingDeltaBatch();
    pushMappedEvent(event);
  }
  flushPendingStreamingDeltaBatch();
  return options.limit ? visibleEvents.slice(-options.limit) : visibleEvents;
}

async function getProtocolEventSeq(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): Promise<number> {
  await readProtocolSessionEvents(context, record, deliveryKind);
  return getProtocolEventSequenceState(record, deliveryKind).lastSeq;
}

function logProtocolSessionEventSent(
  context: ZCodeProtocolAgentServerContext,
  sourceEvent: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
): void {
  const payload =
    typeof mappedEvent.payload === "object" && mappedEvent.payload !== null
      ? (mappedEvent.payload as Record<string, unknown>)
      : {};
  const protocolMessage = {
    method: "session/event",
    params: mappedEvent,
  };
  context.logger?.debug("ZCode Protocol session event sent", {
    deliveryKind: mappedEvent.deliveryKind,
    event: "zcode_protocol.session_event.sent",
    eventId: mappedEvent.eventId,
    method: "session/event",
    module: "bootstrap.zcode_protocol",
    payloadKeys: Object.keys(payload).sort(),
    payloadKind: typeof payload.kind === "string" ? payload.kind : undefined,
    payloadSummary: summarizeProtocolPayload(payload),
    protocolMessageBytes: measureJsonBytes(protocolMessage),
    protocolPayloadBytes: measureJsonBytes(mappedEvent.payload),
    protocolEventType: mappedEvent.type,
    protocolSeq: mappedEvent.seq,
    sessionEventSequenceNumber: sourceEvent.sequenceNumber,
    sessionEventType: sourceEvent.type,
    sessionId: mappedEvent.sessionId,
    turnId: mappedEvent.turnId,
  });
}

function summarizeProtocolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  copyStringFields(summary, payload, [
    "action",
    "anchorId",
    "assistantMessageId",
    "inputId",
    "kind",
    "queryId",
    "reason",
    "requestId",
    "resultPartId",
    "source",
    "status",
    "taskId",
    "terminalId",
    "toolCallId",
    "toolName",
  ]);
  copyBooleanFields(summary, payload, ["concurrentSafe", "destructive", "done", "readOnly"]);
  copyNumberFields(summary, payload, [
    "durationMs",
    "elapsedMs",
    "outputBytes",
    "stderrBytes",
    "stdoutBytes",
    "tokenCount",
    "toolCallCount",
  ]);
  copyByteLength(summary, payload, "content", "contentBytes");
  copyByteLength(summary, payload, "delta", "deltaBytes");
  copyByteLength(summary, payload, "input", "inputBytes");
  copyByteLength(summary, payload, "outputTail", "outputTailBytes");
  copyByteLength(summary, payload, "previousTarget", "previousTargetBytes");
  copyByteLength(summary, payload, "response", "responseBytes");
  copyByteLength(summary, payload, "result", "resultBytes");
  copyByteLength(summary, payload, "stderrTail", "stderrTailBytes");
  copyByteLength(summary, payload, "stdoutTail", "stdoutTailBytes");
  copyByteLength(summary, payload, "target", "targetBytes");
  copyObjectKeySummary(summary, payload, "input", "input");
  copyObjectKeySummary(summary, payload, "requestHeaders", "requestHeader");
  copyObjectKeySummary(summary, payload, "responseHeaders", "responseHeader");
  copyObjectKeySummary(summary, payload, "result", "result");
  copySmallObject(summary, payload, "usage");
  copyContextUsageBreakdownSummary(summary, payload);
  return summary;
}

function copyStringFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

function copyBooleanFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      target[key] = value;
    }
  }
}

function copyNumberFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

function copyByteLength(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = measureJsonBytes(source[sourceKey]);
  }
}

function copyObjectKeySummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetPrefix: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const keys = Object.keys(value).sort();
  target[`${targetPrefix}KeyCount`] = keys.length;
  target[`${targetPrefix}Keys`] = keys.slice(0, 20);
}

function copySmallObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (measureJsonBytes(value) <= 1024) {
    target[sourceKey] = value;
  }
}

function copyContextUsageBreakdownSummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const value = source.contextUsageBreakdown;
  if (!Array.isArray(value)) {
    return;
  }
  target.contextUsageBreakdownCount = value.length;
  target.contextUsageBreakdownSources = value
    .map((item) => asRecord(item).source)
    .filter((source): source is string => typeof source === "string")
    .slice(0, 20);
}

function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

function slugifyImportedSession(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug.length > 0 ? slug : "imported-session";
}

function isImportedHistoryMessage(
  message: MessageWithParts,
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"],
): boolean {
  const messageId = String(message.info.id);
  if (/^msg_import_\d+$/u.test(messageId) || messageId.startsWith("msg_claude-import-")) {
    return true;
  }
  const messageMetadata = asRecord((message.info as unknown as { metadata?: unknown }).metadata);
  if (messageMetadata.migrationSource === source) {
    return true;
  }
  return message.parts.some((part) => {
    const partMetadata = asRecord((part as unknown as { metadata?: unknown }).metadata);
    return partMetadata.migrationSource === source;
  });
}

async function removePreviousImportedSessionHistory(params: {
  sessionStore: NonNullable<ZCodeProtocolAgentServerContext["deps"]["sessionStore"]>;
  sessionId: SessionId;
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"];
}): Promise<number> {
  const existingMessages = await params.sessionStore.messages({
    sessionID: params.sessionId,
  });
  let removedCount = 0;
  for (const message of existingMessages) {
    if (!isImportedHistoryMessage(message, params.source)) {
      continue;
    }
    // 旧导入版本复用了 msg_import_0/msg_import_1 这类全局固定 ID。
    // 第二个导入 session 会通过 saveMessage 的 upsert 把前一个 session 的消息改绑过来，
    // 并保留旧 time_created，最终导致会话串消息、顺序反转或恢复为空。重导入前只清理
    // 当前 session 的迁移消息，保留用户后续在导入会话里继续聊出的真实消息。
    await params.sessionStore.removeMessage({
      sessionID: params.sessionId,
      messageID: message.info.id,
    });
    removedCount += 1;
  }
  return removedCount;
}

async function persistImportedSessionHistory(params: {
  context: ZCodeProtocolAgentServerContext;
  record: ZCodeProtocolSessionRecord;
  sessionId: SessionId;
  createParams: ZCodeSessionCreateParams;
}): Promise<void> {
  const importedHistory = params.createParams.importedHistory;
  const sessionStore = params.context.deps.sessionStore;
  if (!importedHistory) return;
  if (!sessionStore) {
    throw new ProtocolRequestError(-32003, "Cannot import session history without session store");
  }

  const workspace = params.record.workspace;
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  const now = Date.now();
  const createdAt =
    importedHistory.createdAt ??
    (importedHistory.source === "claudeCode"
      ? importedHistory.messages[0]?.timestamp
      : undefined) ??
    now;
  const updatedAt =
    importedHistory.source === "claudeCode"
      ? (importedHistory.updatedAt ?? importedHistory.messages.at(-1)?.timestamp ?? createdAt)
      : createdAt;
  // 历史导入不执行模型；未绑定时保留消息内容，不能要求当前选择或伪造消息来源。
  const currentModel = optionalModelSelectionFromString(params.record.app.getModel());
  const providerId = currentModel?.providerId as ModelProviderId | undefined;
  const modelId = currentModel?.modelId as ModelId | undefined;

  if (importedHistory.source === "sharedContext") {
    if (!sessionStore.commitSharedContextImportBundle) {
      throw new ProtocolRequestError(
        -32003,
        "Shared context import requires atomic session storage",
      );
    }
    const messageId = createMessageId(`${params.sessionId}_shared_context`);
    const importedAt = importedHistory.createdAt ?? now;
    const contextId =
      importedHistory.provenance.contextId ?? `legacy-shared-context-${params.sessionId}`;
    const contextStatus = importedHistory.provenance.status ?? "pending";
    await sessionStore.commitSharedContextImportBundle({
      session: {
        id: params.sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        workspaceID: workspaceIdentity as WorkspaceId | undefined,
        traceID: params.record.traceContext.traceId,
        slug: slugifyImportedSession(params.sessionId),
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: importedHistory.title,
        titleSource: "custom",
        version: params.context.deps.version ?? "0.0.0",
        permission: { mode: params.record.app.getMode() },
        time: { created: importedAt, updated: importedAt },
      },
      contextMessage: {
        info: {
          id: messageId,
          sessionID: params.sessionId,
          role: "user",
          time: { created: importedAt },
          agent: "zcode-agent",
          // 合并新增分享导入时仍沿用旧 model 字段，既引用了失效变量，也会丢失未绑定语义。
          // 与普通导入共用结构化选择合同；导入不要求模型可执行。
          ...(currentModel ? { modelSelection: currentModel } : {}),
          synthetic: true,
          source: "shared_context",
          visibility: "model-only",
          semantics: {
            origin: "import",
            kind: "shared_context",
            source: "conversation_share",
            uiVisibility: "hidden",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
          metadata: {
            shareId: importedHistory.provenance.shareId,
            contextId,
            sharedContextStatus: contextStatus,
          },
        },
        parts: [
          {
            id: createPartId(`${params.sessionId}_shared_context_text`),
            sessionID: params.sessionId,
            messageID: messageId,
            type: "text",
            text: importedHistory.markdown,
            time: { start: importedAt, end: importedAt },
            metadata: { sharedContext: true },
          },
        ],
      },
      provenance: {
        // session_entry.id 是全库主键（同类修复见 sqlite-session-store.ts
        // 的 fork command fact），旧模板只含 shareId。同一个 share 导入到第二个
        // workspace 时按 (shareCode, workspaceKey) 的去重不命中、marker 也各在自己
        // workspace 下不冲突，saveSessionEntry 的 on conflict(id) 就把第一个会话的
        // provenance 改绑到新会话，旧会话的 shared context 记录静默消失。
        // 校验：所有读取都走 (session_id, type) + data.contextId，没有一处按 id 反查，
        // 因此新旧 id 共存安全，不需要数据迁移。
        id: `v4_shared_context_import:${params.sessionId}:${importedHistory.provenance.shareId}`,
        sessionID: params.sessionId,
        type: "v4/shared_context_import",
        time: { created: importedAt, updated: importedAt },
        data: {
          ...importedHistory.provenance,
          contextId,
          status: contextStatus,
        },
      },
    });
    return;
  }

  await sessionStore.createSession({
    id: params.sessionId,
    projectID: projectIdFromDirectory(workspace.workspacePath),
    // 导入会话创建后会立即 resume；必须先落盘当前 identity，避免恢复时退化为路径隔离。
    workspaceID: workspaceIdentity as WorkspaceId | undefined,
    traceID: params.record.traceContext.traceId,
    slug: slugifyImportedSession(params.sessionId),
    directory: workspace.workspacePath,
    path: workspace.workspacePath,
    title: importedHistory.title?.trim() || "Imported session",
    titleSource: "custom",
    version: params.context.deps.version ?? "0.0.0",
    permission: {
      mode: params.record.app.getMode(),
    },
    time: {
      created: createdAt,
      updated: Math.max(createdAt, updatedAt),
    },
  });

  const removedMessageCount = await removePreviousImportedSessionHistory({
    sessionStore,
    sessionId: params.sessionId,
    source: importedHistory.source,
  });
  let lastUserMessageId: MessageId | undefined;
  let lastImportedMessageTimestamp = createdAt - 1;
  for (const [index, message] of importedHistory.messages.entries()) {
    const rawTimestamp = message.timestamp ?? createdAt + index;

    // sessionStore 按 time_created 排序读取消息，如果 assistant 时间早于 user，
    // UI 会把导入会话显示成 assistant 在上、user 在下。导入边界以数组顺序为准，
    // 只在写库前把时间戳收敛为单调递增，保留消息内容和角色不变。
    const timestamp =
      rawTimestamp > lastImportedMessageTimestamp ? rawTimestamp : lastImportedMessageTimestamp + 1;
    lastImportedMessageTimestamp = timestamp;
    const messageId = createMessageId(`${params.sessionId}_import_${index}`);
    if (message.role === "user") {
      lastUserMessageId = messageId;
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "user",
        time: { created: timestamp },
        agent: "zcode-agent",
        ...(currentModel ? { modelSelection: currentModel } : {}),
        metadata: { migrationSource: importedHistory.source },
      });
    } else {
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "assistant",
        time: { created: timestamp, completed: timestamp },
        parentID:
          lastUserMessageId ?? createMessageId(`${params.sessionId}_import_parent_${index}`),
        ...(currentModel ? { modelId, providerId } : {}),
        mode: params.record.app.getMode(),
        agent: "zcode-agent",
        path: {
          cwd: workspace.workspacePath,
          root: workspace.workspacePath,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
      });
    }
    await sessionStore.savePart({
      id: createPartId(`${params.sessionId}_import_${index}_text`),
      sessionID: params.sessionId,
      messageID: messageId,
      type: "text",
      text: message.content,
      time: { start: timestamp, end: timestamp },
      metadata: { migrationSource: importedHistory.source },
    });
  }

  params.context.logger?.info("ZCode Protocol imported history persisted", {
    event: "zcode_protocol.session_import.persisted",
    messageCount: importedHistory.messages.length,
    module: "bootstrap.zcode_protocol",
    removedMessageCount,
    sessionId: params.sessionId,
    source: importedHistory.source,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
}

export async function createSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace?: ZCodeProtocolTrace,
) {
  return createSessionWithProjection(context, rawParams, trace, async (record) => {
    const result = await snapshotWithDiagnostics(context, record);
    return {
      value: result.snapshot,
      phaseDurationsMs: result.phaseDurationsMs,
      messageCount: result.snapshot.messages.length,
    };
  });
}

/** V4 创建只需要 record；不要为了丢弃的 legacy snapshot 强制解析空模型。 */
export async function createSessionRecordForV4(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return createSessionWithProjection(context, rawParams, undefined, async (record) => ({
    value: { sessionId: record.app.sessionId },
  }));
}

async function createSessionWithProjection<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const sessionId = (params.sessionId ?? createSessionId()) as SessionId;
  const claims = (context.sessionCreationIds ??= new Set<string>());
  // Host 预留只决定身份与归属，不能覆盖 CLI 已有/软删/正在创建的会话。
  // 在任何 await 前占用 ID，防止 native 与 V4 并发 materialize 同一 runtime。
  if (context.sessions.has(sessionId) || claims.has(sessionId))
    throw new ProtocolRequestError(-32602, "sessionId already exists");
  claims.add(sessionId);
  try {
    if (await context.deps.sessionStore?.getSession(sessionId))
      throw new ProtocolRequestError(-32602, "sessionId already exists");
    let result!: T;
    await getSessionLifecycle(context).initialize(
      sessionId,
      async () => {
        result = await materializeCreatedSession(context, { ...params, sessionId }, trace, project);
      },
      params.workspace,
      "create",
    );
    return result;
  } finally {
    claims.delete(sessionId);
  }
}

async function materializeCreatedSession<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const startedAt = Date.now();
  const sessionId = params.sessionId! as SessionId;
  const workspace = params.workspace;
  context.logger?.info("ZCode Protocol session/create started", {
    event: "zcode_protocol.session_create.started",
    hasInitialModel: params.model !== undefined,
    hasInitialThoughtLevel: params.thoughtLevel !== undefined,
    inboundTraceId: trace?.traceId,
    module: "bootstrap.zcode_protocol",
    persistence: params.persistence,
    sessionId,
    status: "started",
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  const recordStartedAt = Date.now();
  const record = await materializeSessionRecord(
    context,
    { ...params, workspace },
    sessionId,
    false,
    { kind: "host" },
    trace,
  );
  const recordCreateDurationMs = Date.now() - recordStartedAt;
  context.assertServing?.();
  let setInitialModelDurationMs: number | undefined;
  let setInitialThoughtLevelDurationMs: number | undefined;
  let snapshotDurationMs = 0;
  let snapshotPhaseDurationsMs: SnapshotPhaseDurationsMs | undefined;
  const initialModel = params.model;
  const initialThoughtLevel = params.thoughtLevel;
  try {
    await runSessionModelConfigMutation(record.app, async () => {
      if (initialModel) {
        const setInitialModelStartedAt = Date.now();
        await record.app.setModel(formatProtocolModelSelection(initialModel));
        setInitialModelDurationMs = Date.now() - setInitialModelStartedAt;
        record.stateRevision++;
      }
      const supportedInitialThoughtLevel = resolveSupportedAppThoughtLevel(
        record.app,
        initialThoughtLevel,
      );
      if (supportedInitialThoughtLevel) {
        // app 已接管默认模型/思考深度持久化，session/create 会显式传入 thoughtLevel。
        // Workspace Preferences 必须持久化读取：只读 Agent 内存会在重启后丢掉用户上次选择。
        const setInitialThoughtLevelStartedAt = Date.now();
        await record.app.setThoughtLevel(supportedInitialThoughtLevel);
        setInitialThoughtLevelDurationMs = Date.now() - setInitialThoughtLevelStartedAt;
        record.stateRevision++;
      } else if (initialThoughtLevel) {
        // workspace 默认 thoughtLevel 可能来自上一个模型。新 session 继承另一模型时，
        // 不能把不支持的档位硬塞给 runtime，否则创建阶段会抛 Unsupported reasoning effort。
        context.logger?.warn("ZCode Protocol session/create skipped unsupported thought level", {
          event: "zcode_protocol.session_create.thought_level_skipped",
          module: "bootstrap.zcode_protocol",
          requestedThoughtLevel: initialThoughtLevel,
          sessionId,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
        });
      }
    });
    if (params.importedHistory) {
      // 历史导入过去只写 legacy snapshot，taskId 不是真实 protocol sessionId，
      // setModel/sendPrompt 会打到不存在的 runtime。这里在创建期把历史写入 sessionStore 并 resume，
      // 让导入结果从第一刻起就是可续聊、可切模型的 ZCode session。
      await persistImportedSessionHistory({
        context,
        record,
        sessionId,
        createParams: params,
      });
      await record.app.resume();
      record.stateRevision++;
    }
    const snapshotStartedAt = Date.now();
    const createdSnapshotResult = await project(record);
    const createdSnapshot = createdSnapshotResult.value;
    snapshotPhaseDurationsMs = createdSnapshotResult.phaseDurationsMs;
    snapshotDurationMs = Date.now() - snapshotStartedAt;
    context.logger?.info("ZCode Protocol session/create completed", {
      durationMs: Date.now() - startedAt,
      event: "zcode_protocol.session_create.completed",
      hasInitialModel: initialModel !== undefined,
      hasInitialThoughtLevel: initialThoughtLevel !== undefined,
      messageCount: createdSnapshotResult.messageCount,
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "completed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    context.assertServing?.();
    return createdSnapshot;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/create failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.session_create.failed",
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "failed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    // 新建失败不保留临时投影；恢复失败的历史投影则由 gateway 自己管理。
    context.v4Gateway?.disposeSession(sessionId);
    // 生命周期 owner 统一清理半初始化实例；不能吞掉 close 失败后允许再次创建。
    throw error;
  }
}

export interface ActivatedSessionForResume {
  record: ZCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  /** 仅供启动本次 V4 hydration，不写入 record 或跨请求缓存。 */
  persistedMessages?: MessageWithParts[];
}

/** 只拆掉本次失败的 record；不删除持久历史或 gateway publisher。 */
export async function discardFailedSessionResume(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (context.sessions.get(sessionId) !== record) return;
  await discardSessionRuntime(context, sessionId);
}

/**
 * 只恢复 session runtime 生命周期，不物化任何协议表示。
 *
 * V4 冷订阅过去复用 resumeSession，虽然返回值会被直接丢弃，仍会为大历史
 * 构建一份完整 legacy snapshot。runtime 激活和 legacy 表示是两个职责；这里保留
 * snapshot 之前的原有顺序与副作用，让 V4 随后用自己的 durable projection 水合。
 */
export async function activateSessionForResume(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ActivatedSessionForResume> {
  let activated: ActivatedSessionForResume | undefined;
  await getSessionLifecycle(context).initialize(
    params.sessionId,
    async () => {
      activated = await activateSessionRuntime(context, params, options);
    },
    params.workspace,
  );
  const record = activated?.record ?? context.sessions.get(params.sessionId);
  if (!record) throw new Error("Session runtime unavailable after initialization");
  return activated ?? { record };
}

/** 生命周期 owner 专用的初始化执行面；外部恢复必须调用 activateSessionForResume。 */
export async function activateSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ActivatedSessionForResume> {
  const resumeStartedAt = Date.now();
  const activeBeforeWait = context.sessions.has(params.sessionId);
  context.logger?.debug("ZCode Protocol session resume started", {
    activeBeforeWait,
    event: "zcode_protocol.session.resume_started",
    hasSessionStore: Boolean(context.deps.sessionStore),
    module: "bootstrap.zcode_protocol",
    sessionId: params.sessionId,
  });
  const existing = context.sessions.get(params.sessionId);
  if (existing) {
    return { record: existing };
  }
  let session = await getPersistedSession(context, params.sessionId);
  if (!session || session.time.deleted !== undefined) {
    // 诊断：冷恢复只有在持久化记录也不存在时才会走到这里；单凭错误文本无法和
    // readSession 的“runtime 尚未活跃”区分，因此把两层状态和等待耗时一起落盘。
    context.logger?.warn("ZCode Protocol session resume found no persisted record", {
      activeBeforeWait,
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_persisted_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  session = await repairLegacyRemoteSessionWorkspaceForResume(context, session);
  const workspace =
    params.workspace ??
    buildWorkspaceRef({
      // V4 历史会话冷订阅只传 sessionId；远端会话若在这里仅用目录
      // 重建 workspace，identity 会退化成 path key，无法命中按 workspaceID 隔离的
      // provider registry，最终把可用模型误判为不可用并永久触发 restoreWarning。
      workspaceIdentity: session.workspaceID,
      workspacePath: session.path ?? session.directory,
    });
  let persistedMessages =
    options.persistedMessages ?? (await readPersistedSessionMessages(context, params.sessionId));
  const mode = derivePersistedSessionMode(persistedMessages);
  // shell 设置变更只对新 session 生效；冷恢复必须使用创建时落库的
  // Bash shell 快照。runtime.resumeFromStore 会读取快照；这里只负责不把
  // resume 请求里携带的当前 settings 重新注入老 session。
  const record = await materializeSessionRecord(
    context,
    {
      ...params,
      mode,
      // 模型只由 App 的单向迁移/当前 entry 恢复，不能先用消息或调用方 hint 构造一次选择。
      model: undefined,
      ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
      // resume 曾丢掉持久化 taskType，createRecord 落回缺省
      // "interactive"。于是被 resume 的 workflow_child / subagent_child 会话通过
      // isTaskListSessionType 的筛，经 getSessionWorkspaceId 漏进 sessions-index，
      // desktop 任务列表长出「workflow actor actor#N@k」假任务，任务索引同步器还会
      // 反复对它们发 session/resume。fork 路径一直带着 taskType，这里必须同样带。
      taskType: session.taskType,
      workspace,
    },
    params.sessionId as SessionId,
    true,
    { kind: "host" },
    session.traceID ? { traceId: session.traceID } : undefined,
  );
  // createRecord 把 createdAt/updatedAt 写死为 Date.now()——resume 老会话
  // 会让 sessions-index 把它当"刚创建"的会话（配合 hydration 前的空标题，侧栏
  // 表现为原会话消失、冒出"新任务刚刚"）。恢复路径回填 store 的真实时间。
  if (session.time?.created) record.createdAt = session.time.created;
  if (session.time?.updated) record.updatedAt = session.time.updated;
  record.lastOutcome = session.lastOutcome;
  context.assertServing?.();
  const resumeResult = await runSessionModelConfigMutation(record.app, async () => {
    const result = options.reusePersistedMessages
      ? await record.app.resume({ persistedMessages })
      : await record.app.resume();
    // 仅用于首次投影种子，包含有效模型+空档位；它不是第二份可执行 Runtime 选择。
    record.restoredModelSelection = result.modelSelection;
    return result;
  });
  if (options.reusePersistedMessages && resumeResult.persistedMessagesReloadRequired) {
    persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
  }
  context.logger?.info("ZCode Protocol session resume completed", {
    activeSessionCount: context.sessions.size,
    durationMs: Math.max(0, Date.now() - resumeStartedAt),
    event: "zcode_protocol.session.resume_completed",
    module: "bootstrap.zcode_protocol",
    persistedMessageCount: persistedMessages.length,
    sessionId: params.sessionId,
    traceId: record.traceContext.traceId,
  });
  context.assertServing?.();
  return {
    knownSession: session,
    record,
    ...(options.reusePersistedMessages ? { persistedMessages } : {}),
  };
}

export async function resumeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionResumeParamsSchema, rawParams);
  const activated = await activateSessionForResume(context, params);
  return await snapshot(context, activated.record, activated.knownSession);
}

async function repairLegacyRemoteSessionWorkspaceForResume(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
): Promise<SessionInfo> {
  const legacyRemote = resolveLegacyRemoteSessionWorkspace(context, session);
  if (!legacyRemote || !context.deps.sessionStore?.repairLegacyRemoteSessionWorkspace)
    return session;
  const legacyWorkspaceDirectory = session.path ?? session.directory;

  const repaired = await context.deps.sessionStore.repairLegacyRemoteSessionWorkspace({
    sessionID: session.id,
    projectID: projectIdFromDirectory(legacyRemote.workspacePath),
    legacyWorkspaceDirectory,
    workspaceID: legacyRemote.workspaceIdentity,
    workspacePath: legacyRemote.workspacePath,
  });
  // 原子修复返回 false 后仍用旧 directory/path 物化 runtime，最终在错误 cwd
  // 中执行工具。这里必须读取原始持久事实，不能让已有 identity 的内存路径修复伪装成已落盘。
  const refreshed = await context.deps.sessionStore.getSession(session.id);
  const repairPersisted =
    refreshed?.workspaceID === legacyRemote.workspaceIdentity &&
    refreshed.directory === legacyRemote.workspacePath &&
    refreshed.path === legacyRemote.workspacePath;
  if (!repairPersisted) {
    context.logger?.warn("legacy remote session workspace repair was not persisted", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repair_rejected",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      repaired,
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Legacy remote session workspace repair was not persisted",
      {
        context: {
          directory: refreshed?.directory ?? session.directory,
          path: refreshed?.path ?? session.path,
          reason: "legacy_remote_session_workspace_repair_rejected",
          sessionId: session.id,
          workspaceIdentity: legacyRemote.workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (repaired) {
    context.logger?.info("legacy remote session workspace repaired", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repaired",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
  }
  // Core resumeFromStore 会重新读库；NULL identity 修复必须先持久化，不能只改 bootstrap 内存值。
  return refreshed;
}

/** 预检与原子修复共享精确识别规则；识别本身只读，不能提前改写历史。 */
function resolveLegacyRemoteSessionWorkspace(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
) {
  const directory = session.path ?? session.directory;
  return !session.workspaceID && session.directory === directory
    ? resolveLegacyRemoteWorkspace(context, directory)
    : null;
}

function resolveLegacyRemoteWorkspace(
  context: ZCodeProtocolAgentServerContext,
  legacyWorkspaceDirectory: string,
): { workspaceIdentity: WorkspaceId; workspacePath: string } | null {
  const currentWorkspacePath = context.deps.cwd ?? process.cwd();
  const direct = parseRemoteWorkspaceIdentity(legacyWorkspaceDirectory);
  if (direct?.kind === "wsl" && direct.workspacePath === currentWorkspacePath) {
    return {
      workspaceIdentity: legacyWorkspaceDirectory as WorkspaceId,
      workspacePath: direct.workspacePath,
    };
  }

  const identityPrefix = currentWorkspacePath === "/" ? "/" : `${currentWorkspacePath}/`;
  if (!legacyWorkspaceDirectory.startsWith(identityPrefix)) return null;
  const embeddedIdentity = legacyWorkspaceDirectory.slice(identityPrefix.length);
  const embedded = parseRemoteWorkspaceIdentity(embeddedIdentity);
  if (
    embedded?.kind !== "wsl" ||
    `${identityPrefix}${embeddedIdentity}` !== legacyWorkspaceDirectory ||
    embedded.workspacePath !== currentWorkspacePath
  ) {
    return null;
  }

  // 只接受当前 app-server cwd 直接拼出的精确形态，不在任意路径中模糊搜索 remote: 前缀。
  return {
    workspaceIdentity: embeddedIdentity as WorkspaceId,
    workspacePath: embedded.workspacePath,
  };
}

async function resolvePersistedDirectorySession(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
  workspace: ZCodeWorkspaceRef,
  resolveOwner: boolean,
): Promise<SessionInfo | null> {
  const expectedKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const visited = new Set<string>();
  let current: SessionInfo | null = session;
  while (current && current.time.deleted === undefined && !visited.has(current.id)) {
    visited.add(current.id);
    // 旧 WSL 记录必须先按原修复规则解释归属，否则新增预检会挡住本来可恢复的数据。
    const legacy = resolveLegacyRemoteSessionWorkspace(context, current);
    const identity = current.workspaceID?.trim() || legacy?.workspaceIdentity;
    const path = legacy?.workspacePath ?? (current.path || current.directory);
    const key = identity || path;
    const auxiliary = isAuxiliarySessionKind(current.taskType);
    // 旧 root 曾保存规范化 cwd；只在目标 OS 的绝对路径词法等价时兼容，绝不重写身份 key。
    const samePath =
      path === workspace.workspacePath ||
      (isAbsolute(path) &&
        isAbsolute(workspace.workspacePath) &&
        resolve(path) === resolve(workspace.workspacePath));
    const sameIdentity =
      key === expectedKey || (!identity && !workspace.workspaceIdentity?.trim() && samePath);
    if (samePath && sameIdentity && (!resolveOwner || !auxiliary)) return current;
    // 历史 child 的执行 cwd 不能否定完整父链；显式身份、缺父、删除、环仍不能跨归属。
    if (!auxiliary || !current.parentID || (identity && (!sameIdentity || !samePath))) return null;
    current = (await context.deps.sessionStore?.getSession(current.parentID)) ?? null;
  }
  return null;
}

/** 激活前验证既有会话归属；restart 必须在释放旧实例之前调用。 */
export async function validateSessionActivationWorkspace(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<void> {
  if (!workspace) return; // 旧协议调用仍由持久记录提供上下文。
  const active = context.sessions.get(sessionId);
  if (active) {
    // key 相同不保证显式 identity 相同；与在途操作一样逐字段校验，避免错误请求关闭原实例。
    if (
      active.workspace.workspaceKey !== workspace.workspaceKey ||
      active.workspace.workspacePath !== workspace.workspacePath ||
      active.workspace.workspaceIdentity !== workspace.workspaceIdentity ||
      active.workspace.remoteSessionId !== workspace.remoteSessionId
    )
      throw new Error("project.session-lineage-invalid");
    return;
  }
  const session = await getPersistedSession(context, sessionId);
  if (
    !session ||
    !(await resolvePersistedDirectorySession(
      context,
      session,
      workspace,
      context.sessionDirectorySourceEnabled === true,
    ))
  )
    throw new Error("project.session-lineage-invalid");
}

export async function listSessions(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionListParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  // 显式 ID 查询只读持久化身份，供 Host 修复旧索引；不能为了识别 child 激活 runtime。
  const candidates = params.sessionIds
    ? await Promise.all(params.sessionIds.map((id) => store?.getSession(id as SessionId) ?? null))
    : store
      ? await store.listSessions({
          directory: params.workspace?.workspacePath,
          limit: params.limit ?? 50,
          taskTypes: [...TASK_LIST_SESSION_TYPES],
        })
      : [];
  const scoped = await Promise.all(
    candidates.map(async (session) => {
      if (!session || session.time.deleted !== undefined) return null;
      const includeDirectorySource = Boolean(
        params.sessionIds && context.sessionDirectorySourceEnabled,
      );
      const source = params.workspace
        ? await resolvePersistedDirectorySession(
            context,
            session,
            params.workspace,
            includeDirectorySource,
          )
        : session;
      if (!source) return null;
      return {
        session,
        directorySessionId:
          includeDirectorySource && params.workspace ? String(source.id) : undefined,
      };
    }),
  );
  const stored = scoped.filter((entry) => entry !== null);
  const storedIds = new Set(stored.map(({ session }) => String(session.id)));
  const sessions = stored.map(({ session, directorySessionId }) => ({
    ...mapSessionInfo({
      session,
      workspace:
        params.workspace ?? buildWorkspaceRef({ workspacePath: session.path ?? session.directory }),
    }),
    ...(directorySessionId ? { directorySessionId } : {}),
  }));
  if (params.sessionIds) return { sessions };
  for (const record of context.sessions.values()) {
    if (record.persistence === "deferred") continue;
    if (!isTaskListSessionType(record.taskType)) continue;
    if (storedIds.has(record.app.sessionId)) continue;
    if (params.workspace && params.workspace.workspaceKey !== record.workspace.workspaceKey)
      continue;
    sessions.push(
      mapSessionInfo({
        app: record.app,
        workspace: record.workspace,
        taskType: record.taskType,
        parentSessionId: record.parentSessionId,
      }),
    );
  }
  return { sessions };
}

export async function listSessionSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  persistedMessages?: MessageWithParts[],
) {
  const params = parseParams(zcodeSessionSubagentsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  const liveParent = context.sessions.get(params.sessionId);
  if (!store) {
    return {
      revision: liveParent?.stateRevision ?? 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    };
  }

  const parentSession = await store.getSession(params.sessionId as SessionId);
  if (!parentSession) {
    // 诊断：hydrate 会复用子任务种子读取；若 task index/旧 ACP task 残留了无效 ID，
    // 这里会把“持久化记录不存在”包装成 v4.hydrate，必须记录调用阶段而不是只看错误文本。
    context.logger?.warn("ZCode Protocol session subagents has no persisted parent", {
      activeSessionCount: context.sessions.size,
      activeSession: Boolean(liveParent),
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation: "session_subagents",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const parentEvents = liveParent
    ? await liveParent.eventStore.getEvents(parentSession.id).catch(() => [])
    : [];
  const childSessionIds = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
  const childEntries = await Promise.all(
    childSessionIds.map(async (childSessionId) => {
      const childSession = await store.getSession(childSessionId as SessionId);
      if (!childSession || childSession.taskType !== "subagent_child") return null;
      const childMessages = await store.messages({
        sessionID: childSession.id,
      });
      const liveChild = context.sessions.get(childSessionId);
      const childProjection = liveChild
        ? await liveChild.app.runtime.getProjection().catch(() => undefined)
        : undefined;
      return { childMessages, childProjection, childSession, childSessionId };
    }),
  );
  const persistedChildren = childEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  const parentProjection = liveParent
    ? await liveParent.app.runtime.getProjection().catch(() => undefined)
    : undefined;
  const projection = projectSessionSubagents({
    revision: liveParent?.stateRevision ?? parentSession.time.updated,
    parentSession,
    messages,
    childSessionsById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childSession]),
    ),
    childMessagesById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childMessages]),
    ),
    childProjectionsById: new Map(
      persistedChildren.flatMap((entry) =>
        entry.childProjection ? [[entry.childSessionId, entry.childProjection]] : [],
      ),
    ),
    ...(parentProjection ? { parentProjection } : {}),
    ...(parentEvents.length > 0 ? { parentEvents } : {}),
  });
  const ended = paginateEndedSubagents(projection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  return {
    revision: projection.revision,
    childSessionIds: persistedChildren.map((entry) => entry.childSessionId),
    running: projection.running,
    ended: {
      total: projection.ended.length,
      items: ended.items,
      ...(ended.nextCursor ? { nextCursor: ended.nextCursor } : {}),
    },
  };
}

const APP_USAGE_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

export async function getUsageStats(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  const timeZone = params.timeZone ?? "UTC";
  const until = Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const rangeDays = APP_USAGE_RANGE_DAYS[params.range] ?? 30;
  const since = params.range === "all" ? 0 : until - rangeDays * 86_400_000;
  const buildOptions = {
    range: params.range,
    timeZone,
    tzOffsetMs,
    generatedAt: until,
    since,
    until,
  };

  // SessionStorePort 与 UsageStorePort 是分离接口，但实际 store 同时实现两者；
  // 沿用 core/usage-observability 的运行时收窄方式访问只读聚合方法。
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryAppUsage) {
    // 无 usage store（不应发生）：返回空快照而非抛错，便于 UI 显示空态。
    return buildAppUsageSnapshot(
      {
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 0,
          modelErrorCount: 0,
          avgTimeToFirstTokenMs: null,
        },
        turnTotals: {
          totalSessions: 0,
          totalTurns: 0,
          avgTurnDurationMs: null,
          longestSessionMs: 0,
        },
        toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
        models: [],
        tools: [],
        days: [],
        dayModels: [],
      },
      buildOptions,
    );
  }

  const result = await usageStore.queryAppUsage({ since, until, tzOffsetMs });
  return buildAppUsageSnapshot(result, buildOptions);
}

export async function readSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionReadParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    deliveryKind: params.deliveryKind,
    operation: "session_read",
  });
  record.deliveryKind = params.deliveryKind ?? record.deliveryKind;
  const result = await snapshot(context, record, undefined, {
    messageLimit: params.messageLimit,
    modelAvailability: "current",
  });
  // task index resync 只需标题/搜索文本/可见性/状态，完整历史单行可达 ~15MB 会打满 host stdio；
  // 先按 full 构建再裁剪大载荷，保证 index 派生字段与 full 同源一致。
  return params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result;
}

/**
 * V4 冷恢复 usage 的窄读取：复用 legacy snapshot 的 meter 计算，但不映射完整协议快照。
 */
export async function readSessionContextUsage(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
) {
  const record = context.sessions.get(sessionId);
  if (!record) return undefined;
  const [resolvedPersistedMessages, session, events] = await Promise.all([
    persistedMessages ?? readSessionMessages(context, record),
    getPersistedSession(context, sessionId),
    record.eventStore.getEvents(sessionId as SessionId),
  ]);
  // 保持 legacy buildSessionSnapshot 的取数顺序：先固定持久事实，再读取 runtime
  // projection。运行中首订阅若恰逢 ModelComplete/rewind，不能因窄读把 projection
  // 提前到并行阶段而制造新的跨水位组合。
  const projection = await record.app.runtime.getProjection();
  const messages = projectActiveSessionMessages(
    resolvedPersistedMessages,
    session,
    events.filter((event) => event.type === SessionEventType.RewindTriggered),
  );
  return resolveSessionContextUsage({
    messages,
    persistedContextUsageBreakdownEvents: events,
    projection,
  });
}

export async function readMessages(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionMessagesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const allMessages = await readActiveSessionMessages(context, record);
  const afterMessageIndex = params.afterMessageId
    ? allMessages.findIndex((message) => String(message.info.id) === params.afterMessageId)
    : -1;
  const messages = afterMessageIndex >= 0 ? allMessages.slice(afterMessageIndex + 1) : allMessages;
  return {
    messages: params.limit ? messages.slice(-params.limit) : messages,
  };
}

export async function readEvents(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionEventsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  return {
    events: await readProtocolSessionEvents(context, record, record.deliveryKind, {
      afterSeq: params.afterSeq,
      limit: params.limit,
    }),
  };
}

export async function subscribeSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSubscribeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  record.deliveryKind = params.deliveryKind;
  // 兼容保护：旧 replayable 流没有 unsubscribe RPC。这里只记录真正的 subscribe，
  // 不复用会被 session/read 写入的 deliveryKind，避免普通读取永久阻止 resident 回收。
  record.legacyStreamSubscribed = true;
  const events =
    params.afterSeq === undefined
      ? []
      : await readProtocolSessionEvents(context, record, record.deliveryKind, {
          afterSeq: params.afterSeq,
        });
  return {
    eventSeq: await getProtocolEventSeq(context, record, record.deliveryKind),
    events,
    sessionId: params.sessionId,
    snapshot: params.includeSnapshot
      ? await snapshot(context, record, undefined, {
          modelAvailability: "current",
        })
      : undefined,
  };
}

export async function sendPrompt(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSendParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  // legacy 输入入口同样必须保持子代理只读，不能绕过 V4 用户输入准入。
  if (isReadonlyAgentSessionKind(record.taskType)) {
    throw new ProtocolRequestError(-32010, "Subagent sessions are read-only", {
      reasonCode: "guard.subagentReadOnly",
    });
  }
  assertExpectedRevision(record, params.expectedRevision);
  assertExpectedProviderRevision(context, record, params.expectedProviderRevision);
  if (record.activeAbortController) {
    context.logger?.warn("ZCode Protocol session/send rejected: active prompt exists", {
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: params.sessionId,
      textLength: params.content.length,
      workspacePath: record.workspace.workspacePath,
    });
    throw new ProtocolRequestError(-32010, "A prompt is already running for this session");
  }
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  if (record.persistence === "deferred") {
    // 未发送前的 draft session 不进入两份 sqlite；用户真正发送首条消息时，
    // 才把它提升为普通 session，让后续 list/syncer/task index 按真实任务处理。
    record.persistence = "immediate";
  }
  const abortController = new AbortController();
  record.activeAbortController = abortController;
  context.logger?.info("ZCode Protocol session/send accepted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: params.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  const inputId = params.inputId ?? (params.modelSelection ? crypto.randomUUID() : undefined);
  // 旧附件载荷也经同一个 canonical intent 固定本次选择，不先改 Session。这里只借用
  // 公共 metadata 构造器（非 V4 ACK/重放入口）；无 V4 admission 的序号沿既有值 0。
  const intent =
    params.modelSelection && inputId
      ? inputIntentMetadata(
          {
            commandId: inputId,
            clientId: "legacy-session-send",
            sessionId: params.sessionId,
            type: "sendText",
            payload: {},
            issuedAt: Date.now(),
          },
          {
            text: params.content,
            requestedDelivery: "startNow",
            modelSelection: params.modelSelection,
          },
        )
      : undefined;
  void runWithSessionResidencyFinalization(record, () =>
    runPromptTurnInBackground(context, record, {
      abortController,
      attachments: params.attachments,
      browserAmbientContext: params.browserAmbientContext,
      inputId,
      intent,
      modelExecution: params.modelExecution
        ? createModelExecutionContext(params.modelExecution)
        : undefined,
      queryId: (params.queryId ?? inputId) as QueryId | undefined,
      content: params.content,
      ...(params.automationId
        ? { automationId: params.automationId }
        : params.offPeakTaskId
          ? {
              offPeakTaskId: params.offPeakTaskId,
              ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
            }
          : {}),
      toolDenylist: params.toolDenylist,
      botDeliveryTarget: params.botDeliveryTarget,
    }),
  ).catch(() => {
    // 后台 turn 的错误会通过状态/事件流降级上报；这里兜底防止协议进程出现 unhandled rejection。
  });
  // session/send 只是“提交用户输入”的协议请求，不能同步等待整轮模型生成完成。
  // 同步等待首 token/整轮会让超过 30s 的请求触发 host timeout，并且阻塞后续 session/resume、list 等协议消息。
  // 这里收到输入后立即 ACK，后台 turn 继续通过 session event/state.updated 推送进度。
  return afterPromptAccepted(context, record, "prompt_started");
}

export async function compactSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCompactParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  if (activeTurn?.kind === "compact") {
    // 重复 `/compact` 是同一 session 的上下文维护请求；压缩中再收到时应直接丢弃，
    // 不能进入普通 prompt/steer 队列，也不能渲染成一次失败的压缩横条。
    return {
      response: "",
      snapshot: await snapshot(context, record, undefined, {
        modelAvailability: "current",
      }),
      compact: {
        state: "already_running" as const,
        ...(params.inputId ? { inputId: params.inputId } : {}),
      },
    };
  }
  ensureNoActiveTurn(record, "Cannot compact while a prompt is running");
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  const instructions = params.instructions?.trim();
  const command = instructions ? `/compact ${instructions}` : "/compact";
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过 record.activeAbortController 中断。
  // 如果这里不登记 controller，压缩中的模型请求会继续跑到自然结束。
  record.activeAbortController = abortController;
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(context, record, {
      abortController,
      command,
      inputId: params.inputId,
    }),
  ).catch(() => {
    // 后台 compact 的错误会通过 compact timeline/state.updated 降级上报；这里兜底防 unhandled rejection。
  });
  record.stateRevision++;
  record.updatedAt = Date.now();
  const acceptedSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, "compact_started", { status: "running" });
  return {
    response: "",
    snapshot: acceptedSnapshot,
    compact: {
      state: "accepted" as const,
      ...(params.inputId ? { inputId: params.inputId } : {}),
    },
  };
}

async function runCompactTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    command: string;
    inputId?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  context.logger?.info("ZCode Protocol background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.command, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
    context.logger?.info("ZCode Protocol background compact completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = params.abortController.signal.aborted
      ? "session_compact_cancelled"
      : "session_compact_failed";
    context.logger?.warn("ZCode Protocol background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // compact 结束后必须先释放 active lock 再广播状态；否则 queued prompt
      // 或后续 `/compact` 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function goalSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionGoalParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  // /goal 是目标状态写入，不是普通 prompt；除 pause 外运行中允许执行会绕过前端队列并污染当前 turn。
  // pause 是用户显式停止 active goal 的控制面命令，必须能打断当前 assistant turn 或 verifier。
  const goalPauseMayInterruptActiveTurn = params.action === "pause";
  if (!goalPauseMayInterruptActiveTurn) {
    ensureNoActiveTurn(record, "Cannot manage goals while a prompt is running");
  }

  if (
    !record.app.readTarget ||
    !record.app.setTarget ||
    !record.app.updateTargetStatus ||
    !record.app.clearTarget
  ) {
    return {
      response: "Goal management is not available in this client.",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "show") {
    return {
      response: formatGoalSummary(await record.app.readTarget()),
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "pause") {
    const activeAbortController = record.activeAbortController;
    const target = await record.app.updateTargetStatus("paused");
    if (target && activeAbortController) {
      context.logger?.info("ZCode Protocol goal pause aborting active turn", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        targetId: target.targetID,
        workspacePath: record.workspace.workspacePath,
      });
      activeAbortController.abort(new Error("ZCode Protocol goal paused"));
    }
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_paused");
    return {
      // pause 是状态控制动作，UI 已通过目标面板和 runtime 收口体现结果；
      // 返回 "Goal paused Objective..." 会被渲染成一条无意义 assistant 气泡并重复暴露目标正文。
      response: target ? "" : "No goal to pause.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  if (params.action === "resume") {
    const target = await record.app.updateTargetStatus("active");
    if (!target) {
      return {
        response: "No goal to resume.",
        snapshot: await snapshot(context, record),
        startedTurn: false,
      };
    }
    return await continueGoalAfterChange(context, record, {
      inputId: params.inputId,
      reason: "goal_resumed",
      target,
      title: "Goal resumed",
    });
  }

  if (params.action === "clear") {
    const cleared = await record.app.clearTarget();
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_cleared");
    return {
      response: cleared ? "Goal cleared." : "No goal to clear.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  const objective = params.objective?.trim() ?? "";
  if (objective.length === 0) {
    return {
      response:
        params.action === "replace"
          ? "Usage: /goal replace <objective>"
          : "Usage: /goal <objective>",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  // App 输入框里的 `/goal 新目标` 是用户显式提交的新目标；已有目标时继续要求
  // replace 会让用户以为目标已变更但数据库仍保留旧目标。这里把重复 set 收敛成 replace 语义。
  const replacesExistingGoal =
    params.action === "replace" || Boolean(await record.app.readTarget());

  const target = await record.app.setTarget({ objective, status: "active" });
  return await continueGoalAfterChange(context, record, {
    inputId: params.inputId,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
    target,
    title: "Goal active",
  });
}

export async function forkSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionForkParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  ensureNoActiveTurn(record, "Cannot fork while a prompt is running");
  const forkTarget = await resolveForkTarget(context, record, params.target);
  const parentMode = record.app.getMode();
  const parentModel = record.app.getModel();
  const parentThoughtLevel = record.app.getThoughtLevel();
  const fork = await record.app.forkFromCheckpoint({
    targetCheckpointId: forkTarget.targetCheckpointId,
    targetMessageId: forkTarget.targetMessageId,
  });
  return await registerForkedSession(context, record, fork, {
    runtimeConfig: {
      mode: parentMode,
      model: parentModel,
      thoughtLevel: parentThoughtLevel,
    },
    inheritLatestTarget: true,
  });
}

/**
 * 已完成 core copy 后只注册 child record。V4 running fork 复用这段宿主生命周期，
 * 但不会进入 forkSession 的 active-turn guard / workspace fork；runtimeConfig 可固定在 fork 点。
 */
export async function registerForkedSession(
  ...args: Parameters<typeof registerForkedSessionRuntime>
) {
  const [context, record, fork] = args;
  let result: Awaited<ReturnType<typeof registerForkedSessionRuntime>> | undefined;
  await getSessionLifecycle(context).initialize(
    fork.forkedSessionId,
    async () => {
      result = await registerForkedSessionRuntime(...args);
    },
    record.workspace,
  );
  if (!result) throw new Error("Fork runtime already initialized");
  return result;
}

async function registerForkedSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["forkFromCheckpoint"]>>,
  options: {
    runtimeConfig: {
      mode: CollaborationMode;
      model: string;
      thoughtLevel?: string;
      followupMode?: "queue" | "guide";
    };
    inheritLatestTarget: boolean;
  },
) {
  const parentMode = options.runtimeConfig.mode;
  const parentModel = options.runtimeConfig.model;
  const parentThoughtLevel = options.runtimeConfig.thoughtLevel;
  const parentFollowupMode = options.runtimeConfig.followupMode;
  const forkedSession = await getPersistedSession(context, fork.forkedSessionId);
  if (!forkedSession) {
    throw new Error(`Persisted child session not found: ${fork.forkedSessionId}`);
  }
  const forkRecord = await materializeSessionRecord(
    context,
    {
      sessionId: fork.forkedSessionId,
      mode: parentMode,
      // 未绑定父会话也允许复制历史；不能因分叉而选择默认模型或解析空字符串。
      model: optionalModelSelectionFromString(parentModel),
      ...(fork.parentSessionId ? { parentSessionId: fork.parentSessionId } : {}),
      taskType: forkedSession.taskType,
      workspace: record.workspace,
    },
    fork.forkedSessionId as SessionId,
    true,
    { kind: "inherit", parent: record },
  );
  context.assertServing?.();
  await runSessionModelConfigMutation(forkRecord.app, async () => {
    // fork 是父会话运行态的分支；只复制消息的话新 record 会从 workspace 默认值恢复，
    // 于是 fork 后的当前模型/模式会被最新默认设置覆盖。这里在 resume 前显式继承父会话设置。
    if (forkRecord.app.getMode() !== parentMode) {
      await forkRecord.app.setMode(parentMode);
      forkRecord.stateRevision++;
    }
    if (parentModel && forkRecord.app.getModel() !== parentModel) {
      await forkRecord.app.setModel(parentModel);
      forkRecord.stateRevision++;
    }
    if (parentThoughtLevel && forkRecord.app.getThoughtLevel() !== parentThoughtLevel) {
      await forkRecord.app.setThoughtLevel(parentThoughtLevel);
      forkRecord.stateRevision++;
    }
    if (parentFollowupMode && parentFollowupMode !== "queue") {
      await forkRecord.app.setFollowupMode(parentFollowupMode);
      forkRecord.stateRevision++;
    }
  });
  if (options.inheritLatestTarget) {
    await inheritForkedSessionTarget(context, record, forkRecord, fork.forkedSessionId);
  }
  await forkRecord.app.resume();
  context.assertServing?.();
  return {
    forkedSessionId: fork.forkedSessionId,
    parentSessionId: fork.parentSessionId,
    targetMessageId: fork.targetMessageId,
    targetCheckpointId: fork.targetCheckpointId,
    response: fork.response,
    snapshot: await snapshot(context, forkRecord, forkedSession),
  };
}

async function inheritForkedSessionTarget(
  context: ZCodeProtocolAgentServerContext,
  parentRecord: ZCodeProtocolSessionRecord,
  forkRecord: ZCodeProtocolSessionRecord,
  forkedSessionId: string,
) {
  const parentTarget = await parentRecord.app.readTarget();
  if (!parentTarget || !context.deps.sessionStore) {
    return;
  }
  const existingChildTarget = await context.deps.sessionStore.readTarget({
    sessionID: forkedSessionId as SessionId,
  });
  if (existingChildTarget) {
    return;
  }
  if (!context.deps.sessionStore.cloneTargetForFork) {
    return;
  }

  // core fork 现在会复制 goal state；bootstrap 只保留旧 app/fake app 的兜底。
  // 不能再 setTarget 新建 targetId，否则 verifier timeline 会和 copied transcript 断开。
  await context.deps.sessionStore.cloneTargetForFork({
    sessionID: forkedSessionId as SessionId,
    source: parentTarget,
    status: parentTarget.status,
  });
  forkRecord.stateRevision++;
  forkRecord.updatedAt = Date.now();
}

async function runPromptTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    intent?: SendInputOptions["intent"];
    modelExecution?: SendInputOptions["modelExecution"];
    attachments?: unknown[];
    browserAmbientContext?: {
      tabCount: number;
      currentUrl?: string;
    };
    inputId?: string;
    queryId?: QueryId;
    content: string;
    toolDenylist?: readonly string[];
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  } & TurnBackgroundAttribution,
): Promise<void> {
  const startedAt = Date.now();
  context.logger?.info("ZCode Protocol background turn started", {
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  let mutationReason = "prompt_completed";
  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolvePromptTurnAutomationId(params);
  const activeOffPeakTaskId = resolvePromptTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildPromptTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) {
    // automation 身份只接受 Host 调度派发显式注入。inputId 是调用方可控的追踪字段，
    // 不能用于恢复权限身份，否则普通用户轮可伪造 CronPauseSelf 的暂停目标。
    record.activeAutomationId = activeAutomationId;
  }
  if (activeOffPeakTaskId) {
    // 闲时派发轮同型兜底标记，供 offpeak-port 拒绝递归 OffPeakCreate。
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;
  try {
    const admission = await record.app.sendInput(
      {
        attachments: mapProtocolPromptAttachments(params.attachments),
        text: params.content,
      },
      {
        abortSignal: params.abortController.signal,
        intent: params.intent,
        modelExecution: params.modelExecution,
        browserAmbientContext: params.browserAmbientContext,
        inputId: params.inputId,
        queryId: params.queryId,
        // 只透传 Host 显式注入的任务身份；inputId 只用于追踪和幂等。
        ...(activeAutomationId
          ? { automationId: activeAutomationId }
          : activeOffPeakTaskId
            ? {
                offPeakTaskId: activeOffPeakTaskId,
                ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
              }
            : {}),
        // legacy session/send 同样可能复用 active runtime；只做 port 拒绝时模型仍看得到
        // CronCreate，并可能在失败后改调 CronDelete。automation turn 与 cron task 会话后续输入
        // 都直接从本轮 provider 工具面移除。
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
      },
    );
    // admission 不是整轮结束。提前清理会丢失 automation 归属及 Stop controller；
    // ACK 已由 session/send 返回，后台只在真实 completion 后释放本轮资源。
    if (admission.kind === "rejected") {
      throw new ProtocolRequestError(-32010, `Prompt admission rejected: ${admission.reason}`);
    }
    if (admission.kind === "started_turn") await admission.completion;
    context.logger?.info("ZCode Protocol background turn completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = "prompt_failed";
    context.logger?.warn("ZCode Protocol background turn failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // prompt_completed/prompt_failed 是下游 host queue 的 ready 边界。
      // 必须先释放 active lock 再广播状态，否则手机端收到 ready 后立刻 drain 会被
      // session/send 拒绝为 "A prompt is already running for this session"。
      record.activeAbortController = undefined;
      context.logger?.info("ZCode Protocol background turn cleared active controller", {
        durationMs: Date.now() - startedAt,
        inputId: params.inputId,
        sessionId: record.app.sessionId,
        workspacePath: record.workspace.workspacePath,
      });
    }
    record.activeAutomationId = previousAutomationId;
    record.activeOffPeakTaskId = previousOffPeakTaskId;
    // Bug 原因：legacy record 会跨 turn 复用；必须恢复 Bot 地址，避免后续普通 UI turn
    // 创建的定时任务错误继承上一轮 Bot 会话。
    record.activeBotDeliveryTarget = previousBotDeliveryTarget;
  }
  await afterStateMutation(context, record, mutationReason);
}

function resolveSessionToolDenylist(
  params: Pick<ZCodeSessionCreateParams, "toolDenylist">,
  workspace: ZCodeWorkspaceRef,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)) {
    // Bug 原因：SSH/WSL/Docker/Server 等远程会话仍注入 automationPort，导致 Cron 工具在远端被注册；
    // 远程 workspace 没有本地调度器的可靠触发边界，所以必须在 session 初始化时统一禁用，
    // 不能只依赖 UI 或 prompt 文本约束。
    for (const toolName of REMOTE_AUTOMATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function buildPromptTurnToolDisallowlist(
  params: {
    automationId?: string;
    offPeakTaskId?: string;
    inputId?: string;
    toolDenylist?: readonly string[];
  },
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (activeAutomationId) tools.add("CronCreate");
  // 闲时派发轮隐藏 OffPeakCreate（防递归自我派生）；OffPeakList 只读保留。
  // 注意 automation 轮不加 OffPeakCreate——cron 轮放行（定时派生闲时任务）。
  // SendMessage / Workflow 同样隐藏，与 V4 prompt-turn 及 core turn-loop-state 同值。
  if (activeOffPeakTaskId) {
    for (const toolName of OFF_PEAK_EXECUTION_TOOL_DENYLIST) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function resolvePromptTurnAutomationId(params: { automationId?: string }): string | undefined {
  // Bug 原因：inputId 可由 session/send 调用方指定，不能把追踪字段提升为授权身份。
  return params.automationId?.trim() || undefined;
}

function resolvePromptTurnOffPeakTaskId(params: {
  offPeakTaskId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // 兜底：续跑派发的 inputId 形如 `offpeak-<uuid>:resume:<uuid>`（首段 traceId 无固定前缀，
  // 主信号必须是显式 offPeakTaskId）。
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("offpeak-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > "offpeak-".length ? offPeakTaskId : undefined;
}

async function continueGoalAfterChange(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    inputId?: string;
    reason: string;
    target: ProtocolGoalTarget;
    title: string;
  },
) {
  const response = formatGoalChanged(params.title, params.target);
  const isPlanMode = record.app.runtime.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;

  if (canContinue) {
    await ensureSessionModelAvailableForNextTurn(context, record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(context, record, {
        abortController,
        inputId: params.inputId,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败会通过状态/事件流降级上报；这里兜底防 unhandled rejection。
    });
  }

  const snapshotAfterGoal = await afterStateMutation(context, record, params.reason);
  return {
    response: isPlanMode ? appendPlanModeGoalContinuationNote(response) : response,
    snapshot: snapshotAfterGoal,
    startedTurn: canContinue,
  };
}

async function runGoalContinuationInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    inputId?: string;
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (record.activeAbortController === params.abortController) {
      // 续跑本身结束后应立刻释放活跃锁；snapshot/command discovery 只是后续广播，
      // 如果继续占锁，连续 `/goal` 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function stopSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionStopParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedTarget: ProtocolGoalTarget | null = null;
  context.logger?.info("ZCode Protocol session/stop received", {
    hadActivePrompt,
    sessionId: params.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  if (hadActivePrompt) {
    pausedTarget = await pauseActiveGoalForSessionStop(context, record, {
      sessionId: params.sessionId,
    });
  }
  record.activeAbortController?.abort(new Error("ZCode Protocol session stopped"));
  if (pausedTarget) {
    await afterStateMutation(context, record, "session_stop_goal_paused");
  }
  return {};
}

async function pauseActiveGoalForSessionStop(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: { sessionId: string },
): Promise<ProtocolGoalTarget | null> {
  if (!record.app.readTarget || !record.app.updateTargetStatus) {
    return null;
  }
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return null;
  }

  try {
    // Stop 只 abort controller 时，goal verifier 若没及时收到 abort，
    // 会在队列仍持有 stopRequested 的情况下保留 active goal，导致后续队列无法 drain。
    const pausedTarget = await record.app.updateTargetStatus("paused");
    if (pausedTarget) {
      context.logger?.info("ZCode Protocol session/stop paused active goal", {
        sessionId: params.sessionId,
        targetId: pausedTarget.targetID,
        workspacePath: record.workspace.workspacePath,
      });
    }
    return pausedTarget;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: params.sessionId,
      targetId: target.targetID,
      workspacePath: record.workspace.workspacePath,
    });
    return null;
  }
}

export async function cancelBackgroundTask(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionCancelBackgroundTaskParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  context.logger?.info("ZCode Protocol session/cancelBackgroundTask received", {
    sessionId: params.sessionId,
    taskId: params.taskId,
    workspacePath: record.workspace.workspacePath,
  });

  if (!record.app.cancelBackgroundTask) {
    throw new ProtocolRequestError(
      -32031,
      "Background task cancellation is not supported by this session runtime",
      {
        sessionId: params.sessionId,
        taskId: params.taskId,
      },
    );
  }

  const result = await record.app.cancelBackgroundTask(params.taskId);
  // 后台 bash 取消是运行态变更，不会经过普通 prompt 终态。
  // 取消后立即发 state.updated，让桌面 continuous 和手机 replayable 都通过各自 snapshot 边界刷新投影。
  await afterStateMutation(context, record, "background_task_cancelled");
  return result;
}

export async function setModel(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModelParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    // 完整 Session 配置命令不能经身份字符串丢掉 reasoning；由共享 setter 原子校验/保存。
    await record.app.setModel(params.model);
  });
  return await afterStateMutation(context, record, "model_changed");
}

export async function setThoughtLevel(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSetThoughtLevelParamsSchema, rawParams);
  if (!params.thoughtLevel) {
    throw new ProtocolRequestError(-32602, "thoughtLevel is required");
  }
  const thoughtLevel = params.thoughtLevel;
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    await record.app.setThoughtLevel(thoughtLevel);
  });
  return await afterStateMutation(context, record, "thought_level_changed");
}

export async function setMode(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await record.app.setMode(params.mode);
  return await afterStateMutation(context, record, "mode_changed");
}

export async function closeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCloseParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (!shouldCloseSessionForExpectedPersistence(record.persistence, params.expectedPersistence)) {
    // 连接切换与跨端首发可能并发。session/send 会先把 deferred 提升为
    // immediate；条件关闭必须在 Agent record 上原子判断，不能依赖 renderer 的旧快照。
    return { closed: false };
  }
  await closeSessionRuntime(context, params.sessionId);
  return { closed: true };
}

export function shouldCloseSessionForExpectedPersistence(
  currentPersistence: ZCodeSessionPersistence,
  expectedPersistence?: ZCodeSessionPersistence,
): boolean {
  return expectedPersistence === undefined || currentPersistence === expectedPersistence;
}

export async function generateWorkspaceText(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeWorkspaceGenerateTextParamsSchema, rawParams);
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const input = {
    selection: params.selection,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.messages ? { messages: params.messages } : {}),
    ...(params.tools
      ? {
          tools: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    querySource: params.querySource,
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
  };
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: context.deps.createSessionEventStore("workspace-generate-text"),
      runtimeConfig: {
        workingDirectory: params.workspace.workspacePath,
      },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));

  try {
    const result = await app.generateWorkspaceText(input, { abortSignal });
    return {
      text: result.text,
      selection: result.selection,
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  } finally {
    if (!active) {
      await app.close?.();
    }
  }
}

function ensureNoActiveTurn(record: ZCodeProtocolSessionRecord, message: string): void {
  if (!record.activeAbortController) {
    return;
  }
  throw new ProtocolRequestError(-32010, message);
}

function appendPlanModeGoalContinuationNote(response: string): string {
  return `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`;
}

function formatGoalSummary(target: ProtocolGoalTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatGoalChanged(`Goal ${target.status}`, target);
}

function formatGoalChanged(title: string, target: ProtocolGoalTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget =
      target.tokenBudget === null || target.tokenBudget === undefined
        ? "none"
        : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}

function assertExpectedProviderRevision(
  _context: ZCodeProtocolAgentServerContext,
  _record: ZCodeProtocolSessionRecord,
  expectedProviderRevision: string | undefined,
): void {
  // 兼容旧客户端字段。Provider revision 已由进程 Registry 自己管理，不再接受 Host CAS。
  void expectedProviderRevision;
}

export async function ensureSessionModelAvailableForNextTurn(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (await ensureSessionModelAvailable(context, record)) {
    record.stateRevision++;
  }
}

async function resolveForkTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  target: ZCodeSessionHistoryTarget,
): Promise<{ targetCheckpointId?: string; targetMessageId?: string }> {
  if (target.kind === "latestCheckpoint") {
    return {};
  }
  if (target.kind === "checkpoint") {
    return { targetCheckpointId: target.checkpointId };
  }
  if (target.kind === "message") {
    return { targetMessageId: target.messageId };
  }
  return {
    targetMessageId: await resolveTurnMessageId(context, record, target.turnIndex, "assistant"),
  };
}

async function resolveTurnMessageId(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  turnIndex: number,
  role: "assistant" | "user",
): Promise<MessageId> {
  const messages = (await readActiveSessionMessages(context, record)).filter(
    isUserVisibleSessionMessage,
  );
  let currentTurn = -1;
  let lastAssistantForTargetTurn: MessageId | undefined;
  for (const message of messages) {
    if (message.info.role === "user") {
      if (role === "assistant" && currentTurn === turnIndex && lastAssistantForTargetTurn) {
        // fork/rewind 的 legacy turn target 是“目标轮次的 assistant”，
        // 不是“扫描到历史末尾时仍然处于目标轮次”。遇到下一条 user 就清空已找到的
        // assistant，导致只有最后一轮能 fork；compact summary 和 fork notice 这类 synthetic
        // user 又会把最后一轮变成非最后一轮。离开目标轮次前直接返回稳定目标。
        return lastAssistantForTargetTurn;
      }
      currentTurn += 1;
      if (role === "user" && currentTurn === turnIndex) {
        return message.info.id as MessageId;
      }
      continue;
    }
    if (message.info.role === "assistant" && currentTurn === turnIndex) {
      lastAssistantForTargetTurn = message.info.id as MessageId;
    }
  }
  if (role === "assistant" && lastAssistantForTargetTurn) {
    return lastAssistantForTargetTurn;
  }
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    `Cannot resolve ${role} message for turnIndex=${turnIndex}`,
  );
}

export async function getTaskTokenUsage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeTaskTokenUsageParamsSchema, rawParams ?? {});
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryTaskUsage) {
    return {
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    };
  }

  const usage = await usageStore.queryTaskUsage({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
    inputBaselineBySource: usage.inputBaselineBySource,
  };
}

/**
 * 纯配置事件集合：只改变会话选型（模型/协作模式），不代表用户消息活动。
 * 这些事件不 bump record.updatedAt（= sessions-index lastActivityAt），
 * 避免配置操作驱动侧栏列表按活动时间重排。
 * - ModelSelected / SessionModeChanged：纯配置变更（切模型/切模式）。
 * - FollowupModeChanged：打开会话会自动同步 queue/guide 偏好；这是配置，不应刷新历史活动时间。
 * - SessionTitleUpdated：标题是会话元数据；冷恢复会为了 v4 投影补发标题事件，
 *   不能因此把历史任务当成刚活动过并顶到列表最前。
 * - SessionResumed：打开/恢复会话是读取，不是活动。冷恢复路径刚把
 *   record.updatedAt 回填成 store 的真实时间（见 resumeSession op 内说明），
 *   若再被 resume 事件冲成 Date.now()，点开/刷新任务就会被顶到列表最前并整列重排。
 * - WorkspaceHookAdmissionUpdated / WorkspaceMcpAdmissionUpdated：准入提示刷新不代表用户活动；
 *   若漏掉黑名单，SessionResumed 后的准入状态事件会把历史任务显示为“刚刚”。
 * - HookRun*：hook lifecycle 是 turn/session 的内部执行细节；正常 turn 已有消息、工具等
 *   活动事件负责更新时间，冷恢复的 SessionStart hook 不能单独制造一次用户活动。
 */
function isNonActivitySessionEvent(event: SessionEvent): boolean {
  return (
    event.type === SessionEventType.ModelSelected ||
    event.type === SessionEventType.SessionModeChanged ||
    event.type === SessionEventType.FollowupModeChanged ||
    event.type === SessionEventType.SessionTitleUpdated ||
    event.type === SessionEventType.SessionResumed ||
    event.type === SessionEventType.WorkspaceHookAdmissionUpdated ||
    event.type === SessionEventType.WorkspaceMcpAdmissionUpdated ||
    event.type === SessionEventType.HookRunStarted ||
    event.type === SessionEventType.HookRunProgress ||
    event.type === SessionEventType.HookRunCompleted ||
    event.type === SessionEventType.HookRunFailed ||
    event.type === SessionEventType.HookRunBlocked
  );
}

/**
 * `record.persistence` 是 runtime「会话已持久化」事实的协议侧镜像：deferred = draft（不进 session/list、
 * 不进 sessions-index、可被 expectedPersistence="deferred" 的条件关闭收回）。首发路径在 accepted 时刻
 * 抢先提升（关闭竞态需要原子判断，见 startPromptTurn / admission），但**任何**经 runtime 首次持久化的
 * 路径都必须让会话离开 draft——中枢直接启动的会话由 runtime 落行、走 controlOnly
 * 启动轮，没有首发，record 一直是 deferred，sessions-index 视其为 draft 而跳过，侧栏永远不出现。
 * 于是在事件流的唯一入口按 runtime 事实对齐一次：持久化之后 runtime 必定至少发一条事件
 * （SessionTitleUpdated first_input），紧随其后的 ingest 便把会话推进 sessions-index。
 * 测试桩的 runtime 可能没有这个方法（`as never`），缺席即不对齐。
 */
function reconcileRecordPersistence(record: ZCodeProtocolSessionRecord): void {
  if (record.persistence !== "deferred") return;
  if (record.app.runtime?.isSessionPersisted?.() === true) record.persistence = "immediate";
}

export function onSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  const computerUseOperationEvent = mapComputerUseOperationEvent(event);
  if (computerUseOperationEvent) {
    try {
      // 桌面 v4 主链没有旧 session/event 的 deliveryKind 订阅，顶部提示不能继续
      // 依赖该旧门控；这里只发送无内容的生命周期元数据，并与 v4 投影并行、互不阻断。
      context.notify({
        method: zcodeProtocolMethods.computerUseOperationEvent,
        params: computerUseOperationEvent,
      });
      // 这条 notify 过去只在抛错时有日志，成功路径无痕，于是「agent 压根没发」
      // 与「发了但宿主侧静默丢弃」无法区分。CLI 自己的 jsonl 收 debug 级，足够闭环到源头。
      context.logger?.debug("Computer Use operation lifecycle notification sent", {
        event: "zcode_protocol.computer-use.operation-event.sent",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        kind: computerUseOperationEvent.kind,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    } catch (error) {
      context.logger?.warn("Computer Use operation lifecycle notification failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.computer-use.operation-event.failed",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    }
  }
  if (String(event.sessionId) !== record.app.sessionId) {
    // subagent runtime 复用父 runtime 的外部 event sink，但 raw child event
    // 仍属于 child session。无条件用 parent record id ingest 会让 child topic 打开后
    // 不再更新，同时还可能错误 bump 父任务活动时间。这里必须先按事件自己的 sessionId
    // 路由并返回；parent mirror event 本身使用 parent sessionId，继续走下方既有链路。
    context.v4Gateway?.ingestDetachedLiveSession(
      String(event.sessionId),
      event,
      record.app.sessionId,
    );
    return;
  }
  // record.updatedAt 是 sessions-index 的 lastActivityAt 事实源（v4-bridge
  // getSessionIndexMeta），UI 侧栏按它排序。纯配置/恢复/标题元数据事件不是用户会话活动，
  // 之前无差别 bump 会让"切一次模型/点开任务"把任务顶到列表最前并触发整表重排。
  // core 已在发布终态前持久化结果；列表复用同一事实，不从裁剪正文窗口猜测结果。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    record.lastOutcome =
      event.type === SessionEventType.TurnError
        ? "error"
        : payload.resultType === "cancelled"
          ? "interrupted"
          : "completed";
  }
  const nonActivityEvent = isNonActivitySessionEvent(event);
  if (event.type === SessionEventType.ModelSelected) {
    // 恢复候选只服务初始 UI；用户新选择生效后不能在后续清空时被旧候选复活。
    delete record.restoredModelSelection;
  }
  if (!nonActivityEvent) {
    record.updatedAt = Date.now();
  }
  reconcileRecordPersistence(record);
  // 调试旁路不依赖聊天订阅；放在 deliveryKind 判断之前，避免旧订阅退出后诊断再次断流。
  observeSessionDebug(record, event);
  // v4 通道：权威事件无条件喂给 v4 投影/发布器——v4 订阅不依赖旧协议的
  // deliveryKind 订阅态，帧节奏由 gateway 按订阅者 profile 自行调度。
  context.v4Gateway?.ingest(record.app.sessionId, event);
  if (!record.deliveryKind) return;
  const deltaInfo = readStreamingDeltaBatchableEvent(event);
  if (deltaInfo && !shouldHideProtocolSessionEvent(record, event)) {
    const batchState = getLiveProtocolStreamingDeltaBatchState(record, record.deliveryKind);
    if (batchState.batch && batchState.batch.batchKey !== deltaInfo.batchKey) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    batchState.batch = mergeProtocolStreamingDeltaBatch(batchState.batch, event, deltaInfo);
    if (
      deltaInfo.shouldFlushFirstDelta &&
      !batchState.flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
      batchState.flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
      return;
    }
    if (
      batchState.batch.delta.length >= batchState.batch.maxChars ||
      shouldFlushProtocolStreamingDeltaBatchForInterval(
        batchState.batch,
        batchState.lastFlushAtByBatchKey,
      )
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    return;
  }

  resetLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
  sendProtocolSessionEvent(context, record, event, record.deliveryKind);
}

function flushLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  if (!batchState.batch) {
    return;
  }
  rememberProtocolStreamingDeltaBatchFlush(batchState.lastFlushAtByBatchKey, batchState.batch);
  const event = materializeProtocolStreamingDeltaBatch(batchState.batch);
  batchState.batch = undefined;
  // 性能修复：provider 会把 Write/Edit input 和 reasoning/text 输出切成大量很小的 delta。
  // 在 protocol 边界按确定性字节预算合并相邻 diff，renderer 仍按 delta 追加，但不再被每个小包唤醒。
  // 文本体感用 SessionEvent.timestamp 做低频 flush，不能用 live setTimeout，否则 replay 无法复现边界。
  sendProtocolSessionEvent(context, record, event, deliveryKind);
}

function resetLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  flushLiveProtocolStreamingDeltaBatch(context, record, deliveryKind);
  batchState.flushedFirstDeltaBatchKeys.clear();
  batchState.lastFlushAtByBatchKey.clear();
}

function sendProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind);
  if (!mappedEvent) return;
  context.notify({
    method: "session/event",
    params: mappedEvent,
  });
  logProtocolSessionEventSent(context, event, mappedEvent);
}

function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  if (!selection || selection.mode === "auto") {
    return undefined;
  }
  return {
    display: {
      name: selection.dialect === "git-bash" ? "Git Bash" : "CMD",
    },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}

function resolveProtocolBashShellSelection(
  context: ZCodeProtocolAgentServerContext,
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection {
  const configuredSelection = integratedTerminalShellToExecutionSelection(selection);
  return resolveEffectiveBashShellSelection({
    env: context.deps.env ?? process.env,
    override: configuredSelection,
    platform: context.deps.platform ?? process.platform,
  }).selection;
}

async function requestSessionRuntimePreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  scope: ZCodeSessionRuntimePreferencesScope,
  trace?: ZCodeProtocolTrace,
  directorySessionId?: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<ZCodeSessionRuntimePreferencesResult> {
  const startedAt = Date.now();
  // ZCodeProtocolTrace.traceId 是协议层的 string；LogContext 需要 branded TraceId，
  // 按本文件既有惯例断言收口，避免多处日志构造重复转换。
  const traceId = trace?.traceId as TraceId | undefined;
  context.logger?.debug("ZCode Protocol runtime preferences request started", {
    event: "zcode_protocol.runtime_preferences.request_started",
    module: "bootstrap.zcode_protocol",
    scope,
    sessionId,
    traceId,
  });
  try {
    const result = await context.requestClient(
      zcodeProtocolMethods.sessionRequestRuntimePreferences,
      {
        sessionId,
        scope,
        ...(directorySessionId ? { directorySessionId } : {}),
        ...(context.sessionWorkspaceRoutingEnabled && workspace ? { workspace } : {}),
      },
      zcodeSessionRuntimePreferencesResultSchema,
      {
        timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        ...(trace ? { trace } : {}),
      },
    );
    context.logger?.debug("ZCode Protocol runtime preferences response received", {
      durationMs: Math.max(0, Date.now() - startedAt),
      event: "zcode_protocol.runtime_preferences.response_received",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof ProtocolRequestError ? error.code : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      errorMessage,
      event: "zcode_protocol.runtime_preferences.request_failed",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    };
    if (errorCode === -32022) {
      // 诊断：偏好请求超时发生在 runtime 注册前；记录 session/scope，区分
      // “Host 没收到/没回包”和“恢复过程中其他阶段失败”。
      context.logger?.warn("ZCode Protocol runtime preferences request timed out", diagnostic);
    } else if (errorCode !== -32601 && errorCode !== -32020) {
      context.logger?.warn("ZCode Protocol runtime preferences request failed", diagnostic);
    } else {
      context.logger?.debug(
        "ZCode Protocol runtime preferences compatibility fallback",
        diagnostic,
      );
    }
    if (error instanceof ProtocolRequestError && (error.code === -32601 || error.code === -32020)) {
      // 兼容旧 Host 或无 Host 的纯 CLI 创建路径；Memory 服从产品默认关闭，
      // 增强搜索维持原有默认开启，其他协议/传输错误仍阻止 runtime 创建。
      return {
        askUserQuestionAutoResolutionEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "off",
      };
    }
    throw error;
  }
}

async function resolveSessionStartupPreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
  directorySessionId?: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<SessionStartupPreferences> {
  if (source.kind === "inherit") {
    const inheritedShellSelection = source.parent.app.runtime.getSessionShellSelection();
    return {
      memoryEnabled: source.parent.memoryEnabled,
      subagentRuntimeConfigEnabled: source.parent.subagentRuntimeConfigEnabled,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      nativeSearchEnhancementsEnabled: source.parent.nativeSearchEnhancementsEnabled,
      toolSearchMode: source.parent.toolSearchMode,
      resolveInitialBashShellSelection: async () => inheritedShellSelection,
    };
  }

  const runtimePreferences = await requestSessionRuntimePreferences(
    context,
    sessionId,
    "runtime-materialization",
    trace,
    directorySessionId,
    workspace,
  );
  // 必须在 session runtime 可发出第一次提问前应用；关闭路径会等待已有 snooze 持久化完成。
  await context.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(
    runtimePreferences.askUserQuestionAutoResolutionEnabled,
  );
  return {
    additionalDirectories: runtimePreferences.additionalDirectories,
    subagentRuntimeConfigEnabled: runtimePreferences.subagentRuntimeConfigEnabled,
    memoryEnabled: runtimePreferences.memoryEnabled,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    nativeSearchEnhancementsEnabled: runtimePreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: runtimePreferences.toolSearchMode,
    resolveInitialBashShellSelection: async () => {
      const executionPreferences = await requestSessionRuntimePreferences(
        context,
        sessionId,
        "user-execution",
        trace,
        undefined,
        workspace,
      );
      return resolveProtocolBashShellSelection(
        context,
        executionPreferences.integratedTerminalShell,
      );
    },
  };
}

async function materializeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  let directorySessionId: string | undefined;
  if (source.kind === "host" && context.sessionDirectorySourceEnabled) {
    directorySessionId = sessionId;
    if (resume) {
      const session = await getPersistedSession(context, sessionId);
      const workspace =
        params.workspace ?? buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
      const directorySession = session
        ? await resolvePersistedDirectorySession(context, session, workspace, true)
        : null;
      if (!directorySession) throw new Error("project.session-lineage-invalid");
      directorySessionId = directorySession.id;
    }
  }
  // 冷恢复曾把 child 当主任务查项目。反向请求直接带持久化归属，避免 Host 再发
  // session/list 排在当前恢复请求之后，形成双方互等；原 sessionId 和写入目标不变。
  const startupPreferences = await resolveSessionStartupPreferences(
    context,
    sessionId,
    source,
    trace,
    directorySessionId,
    params.workspace ?? buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() }),
  );
  return createRecord(context, params, sessionId, resume, startupPreferences, trace);
}

async function createRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  startupPreferences: SessionStartupPreferences,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const workspace =
    "workspace" in params && params.workspace
      ? params.workspace
      : buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
  const eventStore = context.deps.createSessionEventStore(sessionId);
  const traceContext = createProtocolRootTraceContext(sessionId, trace);
  const initialModel = "model" in params ? params.model : undefined;
  const parentSessionId =
    "parentSessionId" in params && params.parentSessionId
      ? (params.parentSessionId as SessionId)
      : undefined;
  const taskType = params.taskType ?? "interactive";
  const runtimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  context.logger?.info("ZCode Protocol createRecord MCP config", {
    event: "zcode_protocol.create_record.mcp_config",
    rootTraceId: traceContext.traceId,
    inboundTraceId: trace?.traceId,
    paramMcpServerCount: params.mcpServers?.length ?? 0,
    runtimeHasMcpConfig: Boolean(runtimeMcp),
    runtimeMcpServerCount: Object.keys(runtimeMcp?.servers ?? {}).length,
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  // automation-port 需要读取「本会话」的实时 model/mode/thought；record 在 app 之后才建。
  // 用可变持有者做惰性绑定：CronCreate 在 turn 中调用 create() 时 record 早已就绪。
  let ownSessionRecord: ZCodeProtocolSessionRecord | undefined;
  const app = await createWorkspaceZCodeApp(context, workspace, {
    env: context.deps.env,
    eventStore,
    resume,
    additionalDirectories: params.additionalDirectories ?? startupPreferences.additionalDirectories,
    runtimeConfig: {
      mode: "mode" in params ? params.mode : undefined,
      modelSelection: "model" in params ? toRuntimeModelSelection(initialModel) : undefined,
      parentSessionId,
      taskType,
      // 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」「On demand: activation」）：
      // 与 offPeakPort 同一套读法——本次 create/resume 参数优先，缺席时读 Host 同步到进程的
      // workspace 级结论。取值与「必须显式布尔」的理由收在 resolveDynamicWorkflowRuntimeGate。
      ...resolveDynamicWorkflowRuntimeGate(
        {
          dynamicWorkflowEnabled:
            "dynamicWorkflowEnabled" in params ? params.dynamicWorkflowEnabled : undefined,
          dynamicWorkflowMode:
            "dynamicWorkflowMode" in params ? params.dynamicWorkflowMode : undefined,
        },
        context.appRuntimePreferences,
      ),
      // 修复原因：协议侧的工具允许/拒绝列表是 session 级安全边界，必须进入 runtimeConfig，
      // 不能只依赖 prompt 文本约束，否则内置工具和动态 MCP 工具仍可能越过调用面。
      toolAllowlist: "toolAllowlist" in params ? params.toolAllowlist : undefined,
      toolDisallowlist: resolveSessionToolDenylist(params, workspace),
      nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
      toolSearch: { mode: startupPreferences.toolSearchMode },
      modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
      // Memory Settings 是现有 CLI features.memory/use 之外的总开关。只在关闭时
      // 写入 override，避免开启值反向覆盖用户已有的 CLI 禁用配置。
      ...(startupPreferences.memoryEnabled ? {} : { memory: { enabled: false } }),
      // desktop-continuous session/create 由 UI 先解析 ~/.zcode/.agents 的 enabled MCP，
      // 但 protocol app-server 自己不会读取 UI/main 侧的 MCP store；之前 createRecord 没把
      // params.mcpServers 注入 runtimeConfig，导致日志里 runtimeHasMcpConfig=false，工具永远不启动。
      // MCP 是 runtime 启动期配置，因此必须在 session 创建/恢复边界一次性写入 runtimeConfig.mcp。
      ...(runtimeMcp ? { mcp: runtimeMcp } : {}),
      // 之前只有 TUI 路径（tui-prompt-handler）注入 titleGeneration，
      // ZCode Protocol app-server 创建的 session（desktop/web/mobile）没有传，导致
      // shouldAttemptSessionTitleGeneration 的 `if (!config.titleGeneration) return false`
      // 永远命中，模型生成 title 的请求从不触发，侧边栏标题一直停在 first_input 的用户 query。
      // 这里补一份默认配置开启；具体是否生成仍由 runtime 按 parent/taskType/turnNumber 把关。
      // automation 执行会话显式关闭二次命名，避免回答内容覆盖原始用户 query 标题。
      titleGeneration: params.titleGenerationEnabled === false ? { enabled: false } : {},
      workingDirectory: workspace.workspacePath,
      // 身份隔离与路径执行分开：core 只把 identity 写入 session.workspace_id，
      // workingDirectory 仍是远端机器上的实际路径；本地 workspace 保持 undefined。
      workspaceIdentity: workspace.workspaceIdentity as WorkspaceId | undefined,
    },
    // ZCode Protocol app-server 以前没有注入可等待的交互 broker，
    // core 遇到 permission / AskUserQuestion 只能走默认拒绝，UI 永远收不到阻塞请求。
    // 这里把阻塞交互转换成 server-to-client JSON-RPC request，由 app 通过 response 释放 runtime。
    permissionBroker: createProtocolInteractionBroker(context),
    automationPort: createProtocolAutomationPort(context, () => ownSessionRecord),
    topicResourcePort: createProtocolTopicResourcePort(context),
    // 只接入 Host 已开放的工具面；缺省不注入。复用现行异步工厂，
    // 不恢复旧 deferred ModelAdapter/Registry overlay，也不改变 Session Selection。
    ...(("offPeakToolEnabled" in params && params.offPeakToolEnabled === true) ||
    context.appRuntimePreferences.offPeakToolEnabled === true
      ? { offPeakPort: createProtocolOffPeakPort(context, () => ownSessionRecord) }
      : {}),
    resolveInitialBashShellSelection: startupPreferences.resolveInitialBashShellSelection,
    // 修复：这里曾按 workspace 身份排除远程，远端 Host 有快照也接不上，推送的子智能体要新建 task 才能用。
    // 是否接入只看持有本 stdio 的 Host 声明的能力。
    ...(startupPreferences.subagentRuntimeConfigEnabled
      ? {
          readSubagentRuntimeConfig: async ({ signal, traceContext }) => {
            signal.throwIfAborted();
            const result = await context.requestClient(
              zcodeProtocolMethods.subagentsReadRuntimeConfig,
              { sessionId, ...(context.sessionWorkspaceRoutingEnabled ? { workspace } : {}) },
              subagentRuntimeConfigSchema,
              {
                signal,
                timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
                trace: { traceId: traceContext.traceId },
              },
            );
            signal.throwIfAborted();
            return result;
          },
        }
      : {}),
    // browser-use：agent.browsers.* 经此把命令转成 interaction/browserExecute 反向请求。
    browserControlPort: createProtocolBrowserControlBroker(context),
    // Protocol server 是受信任的 Desktop/Web/Mobile Host；灰度开关由这里显式注入，
    // 不从 workspace/project 配置或环境变量读取，关闭时仍可通过删掉该字段回滚到 hard block。
    workspaceHookTrustEnabled: true,
    // 无 session 的 Settings Trust 曾绕过 managed policy；session Runtime 与
    // workspace RPC 必须共享 Host 持有的同一 provider，不能各自创建默认 policy。
    workspaceHookPolicyProvider: context.deps.workspaceHookPolicyProvider,
    workspaceHookReviewHost: {
      taskId: sessionId,
      runId: `workspace-hook-run:${sessionId}:${crypto.randomUUID()}`,
      workspaceLabel:
        workspace.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.workspacePath,
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    },
    sessionId,
    sessionStore: context.deps.sessionStore,
    traceContext,
    version: context.deps.version,
    modelIoFullRetentionEnabled: context.appRuntimePreferences.modelIoFullRetentionEnabled,
  });
  const now = Date.now();
  const record: ZCodeProtocolSessionRecord = {
    app,
    createdAt: now,
    eventStore,
    memoryEnabled: startupPreferences.memoryEnabled,
    subagentRuntimeConfigEnabled: startupPreferences.subagentRuntimeConfigEnabled,
    modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
    nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: startupPreferences.toolSearchMode,
    ...(parentSessionId ? { parentSessionId } : {}),
    persistence: "persistence" in params ? (params.persistence ?? "immediate") : "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType,
    traceContext,
    updatedAt: now,
    workspace,
  };
  // app 一旦物化就交给生命周期执行面持有。订阅接线抛错时也必须能找到并释放它。
  context.sessions.set(sessionId, record);
  context.assertServing?.();
  let subscribed = true;
  let unsubscribeSessionEvents = () => {};
  record.unsubscribe = () => {
    subscribed = false;
    unsubscribeSessionEvents();
  };
  unsubscribeSessionEvents = app.runtime.subscribeEvents({
    // 解除订阅前已排队的 callback 仍可能迟到，不能污染重启后的同名 session 投影。
    onSessionEvent: (event) => {
      if (subscribed) onSessionEvent(context, record, event);
    },
  });
  // 绑定归属会话，供 automation-port 读取本会话实时 model/mode/thought。
  ownSessionRecord = record;
  return record;
}

async function readPersistedSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<MessageWithParts[]> {
  return await (context.deps.sessionStore?.messages({
    sessionID: sessionId as SessionId,
  }) ?? []);
}

function derivePersistedSessionMode(
  messages: readonly MessageWithParts[],
): ZCodeSessionCreateParams["mode"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "assistant" && isZCodeSessionMode(info.mode)) return info.mode;
  }
  return undefined;
}

function isZCodeSessionMode(
  value: unknown,
): value is NonNullable<ZCodeSessionCreateParams["mode"]> {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

function toRuntimeModelSelection(
  model: ZCodeSessionCreateParams["model"],
): ModelSelection | undefined {
  if (!model) return undefined;
  return {
    modelId: model.modelId,
    providerId: model.providerId,
    ...(model.options ? { options: model.options } : {}),
  };
}

interface SnapshotPhaseDurationsMs {
  contextUsageBreakdownEvents: number;
  eventSeq: number;
  goalVerificationEvents: number;
  persistedMessages: number;
  persistedSession: number;
  rewindEvents: number;
  target: number;
  todos: number;
  buildSnapshot: number;
}

interface SnapshotWithDiagnostics {
  snapshot: Awaited<ReturnType<typeof buildSessionSnapshot>>;
  phaseDurationsMs: SnapshotPhaseDurationsMs;
}

async function snapshot(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
) {
  return (await snapshotWithDiagnostics(context, record, knownSession, options)).snapshot;
}

async function snapshotWithDiagnostics(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<SnapshotWithDiagnostics> {
  const snapshotStartedAt = Date.now();
  const phaseDurationsMs: SnapshotPhaseDurationsMs = {
    contextUsageBreakdownEvents: 0,
    eventSeq: 0,
    goalVerificationEvents: 0,
    persistedMessages: 0,
    persistedSession: 0,
    rewindEvents: 0,
    target: 0,
    todos: 0,
    buildSnapshot: 0,
  };
  const measureSnapshotPhase = async <T>(
    phase: keyof Omit<SnapshotPhaseDurationsMs, "buildSnapshot">,
    read: () => Promise<T>,
  ): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await read();
    } finally {
      phaseDurationsMs[phase] = Date.now() - phaseStartedAt;
    }
  };
  const [
    eventSeq,
    persistedMessages,
    session,
    rewindEvents,
    persistedTarget,
    persistedTodos,
    persistedGoalVerificationEvents,
    persistedContextUsageBreakdownEvents,
  ] = await Promise.all([
    measureSnapshotPhase("eventSeq", () =>
      getProtocolEventSeq(context, record, record.deliveryKind),
    ),
    measureSnapshotPhase("persistedMessages", () => readSessionMessages(context, record)),
    knownSession === undefined
      ? measureSnapshotPhase("persistedSession", () =>
          getPersistedSession(context, record.app.sessionId),
        )
      : knownSession,
    measureSnapshotPhase("rewindEvents", () => readSessionRewindEvents(record)),
    measureSnapshotPhase("target", () => readSnapshotTarget(context, record)),
    measureSnapshotPhase("todos", () => readSnapshotTodos(context, record)),
    measureSnapshotPhase("goalVerificationEvents", () =>
      readSessionTargetCompletionVerificationEvents(context, record),
    ),
    measureSnapshotPhase("contextUsageBreakdownEvents", () =>
      readSessionContextUsageBreakdownEvents(record),
    ),
  ]);
  const messages = projectActiveSessionMessages(persistedMessages, session, rewindEvents);
  const buildStartedAt = Date.now();
  const builtSnapshot = await buildSessionSnapshot({
    app: record.app,
    deliveryKind: record.deliveryKind,
    eventSeq,
    fallbackCreatedAt: record.createdAt,
    fallbackUpdatedAt: record.updatedAt,
    lastError: record.restoreWarning,
    messages: limitMessages(messages, options.messageLimit),
    modelAvailability: options.modelAvailability,
    persistedContextUsageBreakdownEvents,
    persistedGoalVerificationEvents,
    session,
    slashCommandOptions: {
      // session snapshot 的 `/` 目录与 workspace presentation 必须给出同一份灰度结论，
      // 否则关闭态下侧栏面板还能看到 `workflow`。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
    },
    stateRevision: record.stateRevision,
    target: persistedTarget,
    todos: persistedTodos,
    workspace: record.workspace,
  });
  phaseDurationsMs.buildSnapshot = Date.now() - buildStartedAt;
  const totalDurationMs = Date.now() - snapshotStartedAt;
  if (totalDurationMs >= SLOW_SNAPSHOT_LOG_THRESHOLD_MS) {
    // SSH 场景下慢点集中在 session snapshot，但旧日志只有总耗时。
    // 超过阈值时记录各子阶段，便于区分 sqlite 等待、消息读取和 projection 构建。
    context.logger?.warn("ZCode Protocol session snapshot slow", {
      durationMs: totalDurationMs,
      event: "zcode_protocol.session_snapshot.slow",
      messageCount: messages.length,
      module: "bootstrap.zcode_protocol",
      phaseDurationsMs,
      sessionId: record.app.sessionId,
      status: "completed",
      workspaceKey: record.workspace.workspaceKey,
      workspacePath: record.workspace.workspacePath,
    });
  }
  return { snapshot: builtSnapshot, phaseDurationsMs };
}

async function readSnapshotTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTarget();
  } catch (error) {
    // goal 是 session_target 的持久业务状态；snapshot 恢复失败时不能静默吞掉，
    // 否则 UI 会误以为历史 session 没有目标。这里保留运行期 projection 并记录协议层日志。
    context.logger?.warn("Failed to read persisted session goal for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.target_read_failed",
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
}

async function readSnapshotTodos(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTodos();
  } catch (error) {
    // todo 是 DB 中的权威短期计划；如果恢复读取失败，UI 需要看到明确日志，
    // 但协议 snapshot 仍可用消息历史继续恢复首屏。
    context.logger?.warn("Failed to read persisted session todos for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.todos_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

async function readSessionTargetCompletionVerificationEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return [];
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: record.app.sessionId as SessionId,
      type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
    });
    return entries
      .map((entry, index) =>
        sessionEntryToTargetCompletionVerificationEvent(entry, record.app.sessionId, index),
      )
      .filter((event): event is SessionEvent => event !== null);
  } catch (error) {
    // goal verifier timeline 是 UI 轮次的持久事实；读取失败时不能影响
    // session 主体恢复，但必须留下日志，否则冷启动后分组丢失很难排查。
    context.logger?.warn("Failed to read persisted goal verification entries", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.goal_verification_entries_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

function sessionEntryToTargetCompletionVerificationEvent(
  entry: {
    id: string;
    sessionID: SessionId;
    time: { created: number; updated: number };
    data: unknown;
  },
  fallbackSessionId: string,
  index: number,
): SessionEvent | null {
  const data = asRecord(entry.data);
  const payload = readTargetCompletionVerificationPayload(data.payload);
  if (!payload) {
    return null;
  }
  const eventId = stringValue(data.eventId) ?? entry.id;
  const traceId = stringValue(data.traceId) ?? "trace_restored_goal_verification";
  const turnId = stringValue(data.turnId);
  return {
    id: eventId as EventId,
    payload,
    sequenceNumber: numberValue(data.sequenceNumber) ?? index + 1,
    sessionId: (entry.sessionID ?? fallbackSessionId) as SessionId,
    timestamp: new Date(entry.time.updated || entry.time.created),
    traceId: traceId as TraceId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type: SessionEventType.TargetCompletionVerification,
  };
}

function readTargetCompletionVerificationPayload(
  value: unknown,
): TargetCompletionVerificationPayload | null {
  const record = asRecord(value);
  const targetId = stringValue(record.targetId);
  const verificationId = stringValue(record.verificationId);
  const status = stringValue(record.status);
  if (!targetId || !verificationId || !isTargetCompletionVerificationStatus(status)) {
    return null;
  }
  const verification = asGoalCompletionVerification(record.verification);
  const goalIteration = numberValue(record.goalIteration);
  const anchorAssistantMessageId = stringValue(record.anchorAssistantMessageId);
  const anchorTurnId = stringValue(record.anchorTurnId);
  return {
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId
      ? { anchorAssistantMessageId: anchorAssistantMessageId as MessageId }
      : {}),
    ...(anchorTurnId ? { anchorTurnId: anchorTurnId as TurnId } : {}),
  };
}

function isTargetCompletionVerificationStatus(
  status: string | undefined,
): status is TargetCompletionVerificationPayload["status"] {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed_closed" ||
    status === "cancelled"
  );
}

function asGoalCompletionVerification(
  value: unknown,
): TargetCompletionVerificationPayload["verification"] | undefined {
  const record = asRecord(value);
  if (typeof record.passed !== "boolean") {
    return undefined;
  }
  const reason = stringValue(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    nextAction: stringValue(record.nextAction),
    passed: record.passed,
    reason,
  };
}

function limitMessages<T>(messages: T[], limit?: number): T[] {
  return limit && limit > 0 ? messages.slice(-limit) : messages;
}

async function readSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  if (!context.deps.sessionStore) return [];
  return await context.deps.sessionStore.messages({
    sessionID: record.app.sessionId as SessionId,
  });
}

async function readSessionContextUsageBreakdownEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.ModelComplete);
}

async function readActiveSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<MessageWithParts[]> {
  const [messages, session, rewindEvents] = await Promise.all([
    readSessionMessages(context, record),
    getPersistedSession(context, record.app.sessionId),
    readSessionRewindEvents(record),
  ]);
  return projectActiveSessionMessages(messages, session, rewindEvents);
}

async function readSessionRewindEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.RewindTriggered);
}

function projectActiveSessionMessages(
  messages: MessageWithParts[],
  session: SessionInfo | null | undefined,
  rewindEvents: readonly SessionEvent[],
): MessageWithParts[] {
  const activeConversationRewinds: ActiveConversationRewindPayload[] = [];
  const sessionRewindPayload = activeConversationRewindPayloadFromSession(session);
  if (sessionRewindPayload) {
    activeConversationRewinds.push(sessionRewindPayload);
  }
  let activeMessages = applyRewindBranch(messages, messages, {
    createdMessageId: sessionRewindPayload?.createdMessageId,
    keptMessageIds: session?.revert?.keptMessageIDs,
    targetMessageId: sessionRewindPayload?.targetMessageId,
  });

  for (const event of rewindEvents) {
    const payload = parseActiveConversationRewindPayload(event);
    if (!payload?.targetMessageId) {
      continue;
    }
    activeConversationRewinds.push(payload);
    activeMessages = applyRewindBranch(activeMessages, messages, payload);
  }

  return filterRewindCommandAckMessages(activeMessages, activeConversationRewinds);
}

type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}

function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core 会为不可用的 rewind 记录 unavailable event，但这类事件没有 createdMessageId。
      // 它不是新的 active branch 起点，协议投影不能用它裁剪消息，否则连续编辑会把可见消息投空。
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // 内部 `/rewind conversation <messageId>` 的成功回执可能被旧事件投影落成
  // assistant 文本。它只是编辑/重试的控制命令 ACK，刷新或恢复时不能再渲染给用户。
  return text === ackText || text.endsWith(`\n${ackText}`);
}

function isUserVisibleSessionMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "realUserInput" || policy === "timelineOnly";
}

function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  if (options.keptMessageIds) {
    // 连续 rewind 后，账本里的 target 前缀不等于 active branch 前缀。
    // 优先使用 runtime 在 rewind 当时保存的 keptMessageIDs，避免旧分支在 snapshot/readMessages 中复活。
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // conversation rewind 的持久化账本会保留被回滚的旧分支。
  // UI snapshot/readMessages 必须投影 active branch，否则编辑重发后会同时看到错发原文和新消息。
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}

async function getPersistedSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return null;
  const session = await sessionStore.getSession(sessionId as SessionId);
  if (!session) return null;
  // 协议冷恢复先用 session.path 创建 runtime，必须在物化前清理旧版 identity/cwd 混写数据。
  return await repairPersistedRemoteSessionPaths(sessionStore, session, {
    onPersistenceFailure: (error) => {
      context.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.path_repair.persist_failed",
        sessionId,
      });
    },
  });
}

/**
 * 纯配置类 mutation reason：只改会话选型，不算用户活动。
 * 与 isConfigOnlySessionEvent 同一裁决——record.updatedAt 是 sessions-index
 * lastActivityAt / snapshot.session.updatedAt（task index 排序时间）的事实源，
 * 切模型/切思考深度/切模式不能把任务顶到列表最前。
 */
const CONFIG_ONLY_MUTATION_REASONS = new Set([
  "model_changed",
  "thought_level_changed",
  "mode_changed",
]);

export async function afterStateMutation(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  if (!record.activeAbortController) {
    // provider registry 可能在 turn 运行中删除当前模型。更新时不能改写在途请求；turn/compact/
    // goal continuation 释放 active lock 后统一经过此安全边界，立即完成同一 Agent fallback，
    // 无需等待用户下一次发送，也不把兜底职责重新交给 renderer。
    await ensureSessionModelAvailable(context, record);
  }
  record.stateRevision++;
  const configOnlyMutation = CONFIG_ONLY_MUTATION_REASONS.has(reason);
  if (!configOnlyMutation) {
    record.updatedAt = Date.now();
  }
  const stateSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, reason, stateSnapshot.settings);
  return stateSnapshot;
}

function afterPromptAccepted(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  record.stateRevision++;
  record.updatedAt = Date.now();
  emitStateUpdated(context, record, reason, { status: "running" });
  return {
    accepted: true as const,
    sessionId: record.app.sessionId,
    stateRevision: record.stateRevision,
  };
}

function emitStateUpdated(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
  patch: unknown,
): void {
  const notification: ZCodeStateUpdatedNotification = {
    patch,
    reason,
    revision: record.stateRevision,
    scope: "session",
    sessionId: record.app.sessionId,
    type: "state.updated",
    workspace: record.workspace,
  };
  context.notify({ method: "state.updated", params: notification });
}

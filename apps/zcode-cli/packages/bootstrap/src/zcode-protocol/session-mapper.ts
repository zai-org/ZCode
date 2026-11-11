import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  getZCodeGoalActiveIterationCount,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeContextUsageBreakdownSchema,
  type ZCodeActiveToolCall,
  type ZCodeContextUsageBreakdownItem,
  type ZCodeDeliveryKind,
  type ZCodePendingPermission,
  type ZCodeSessionContextUsage,
  type ZCodeSessionEvent,
  type ZCodeSessionGoal,
  type ZCodeSessionGoalVerification,
  type ZCodeSessionGoalVerificationTimeline,
  type ZCodeSessionGoalStats,
  type ZCodeSessionInfo,
  type ZCodeSessionKind,
  type ZCodeSessionProjection,
  type ZCodeSessionRuntimeState,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeSessionTodoGroup,
  type ZCodeWorkspaceRef,
  isMainAgentToolProjectionSource,
  isConversationRealUserTurnStarter,
} from "@zcode/shared";
import {
  EventReducer,
  SessionEventType,
  getModelUsageContextTokens,
  type ActiveToolCall,
  type BackgroundTaskInfo,
  type GoalCompletionVerificationOutput,
  type MessageWithParts,
  type ModelCompletePayload,
  type PendingPermission,
  type SessionEvent,
  type SessionGoal,
  type SessionInfo,
  type SessionProjection,
  type TodoItem,
  type ToolState,
} from "@zcode/contracts";
import type { ZCodeApp } from "../app/types.js";
import { mapMessageWithParts } from "./message-mapper.js";
import { formatProtocolModelSelection, optionalModelSelectionFromString } from "./model-mapper.js";
import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
} from "./permission-options.js";
import {
  listProtocolSlashCommands,
  type ListProtocolSlashCommandsOptions,
} from "./slash-commands.js";

const SNAPSHOT_INLINE_IMAGE_DATA_URL_MAX_BYTES = 20 * 1024 * 1024;

export async function buildSessionSnapshot(input: {
  app: ZCodeApp;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  lastError?: SessionProjection["lastError"];
  messages: MessageWithParts[];
  modelAvailability?: "all" | "current";
  persistedGoalVerificationEvents?: SessionEvent[];
  persistedContextUsageBreakdownEvents?: SessionEvent[];
  session?: SessionInfo | null;
  stateRevision: number;
  slashCommandOptions?: ListProtocolSlashCommandsOptions;
  target?: SessionGoal | null;
  todos?: TodoItem[];
  workspace: ZCodeWorkspaceRef;
}): Promise<ZCodeSessionStateSnapshot> {
  const runtimeProjection = await input.app.runtime.getProjection();
  const activeTurn = input.app.runtime.getActiveTurnInfo();
  const persistedGoalProjection = mergePersistedGoalVerificationEvents(
    runtimeProjection,
    input.persistedGoalVerificationEvents ?? [],
    input.target === undefined ? runtimeProjection.target : input.target,
  );
  // runtime projection 是运行期 eventStore reducer，恢复历史 session 时可能没有
  // target_changed 账本；session_target 表才是 goal 权威状态，snapshot 必须以 DB 读取值为准。
  const projectionWithoutTitleFallback =
    input.target === undefined && input.lastError === undefined
      ? persistedGoalProjection
      : {
          ...persistedGoalProjection,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        };
  const projection = withGoalSummaryTitleFallback(
    projectionWithoutTitleFallback,
    input.session,
    input.messages,
  );
  const messages = await mapSnapshotMessages(input.app, input.messages);
  return {
    messages,
    projection: mapSessionProjection(projection),
    protocol: {
      name: ZCODE_PROTOCOL_NAME,
      version: ZCODE_PROTOCOL_VERSION,
    },
    runtime: mapRuntimeState({
      activeTurn,
      deliveryKind: input.deliveryKind,
      eventSeq: input.eventSeq,
      messages: input.messages,
      persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
      projection,
      stateRevision: input.stateRevision,
    }),
    session: mapSessionInfo({
      app: input.app,
      fallbackCreatedAt: input.fallbackCreatedAt,
      fallbackUpdatedAt: input.fallbackUpdatedAt,
      projection,
      session: input.session,
      workspace: input.workspace,
    }),
    settings: await mapSessionSettings(input.app, {
      currentModelContextWindow: projection.contextWindow,
      modelAvailability: input.modelAvailability,
    }),
    slashCommands: await listProtocolSlashCommands({
      ...input.slashCommandOptions,
      workingDirectory: input.workspace.workspacePath,
    }),
    goalStats: buildGoalStats(projection, input.messages),
    todos: input.todos?.map(mapTodoItem) ?? [],
    todoGroups: buildTodoGroups(input.messages, input.todos ?? [], projection),
  };
}

export async function mapSnapshotMessages(
  app: Pick<ZCodeApp, "readToolResultArtifact">,
  messages: readonly MessageWithParts[],
) {
  const mapped = messages.map(mapMessageWithParts);
  return await Promise.all(
    mapped.map(async (message) => ({
      ...message,
      parts: await Promise.all(message.parts.map((part) => hydrateSnapshotFilePartUrl(app, part))),
    })),
  );
}

async function hydrateSnapshotFilePartUrl(
  app: Pick<ZCodeApp, "readToolResultArtifact">,
  part: ReturnType<typeof mapMessageWithParts>["parts"][number],
) {
  // 历史图片附件持久化后只剩 zcode-artifact:// 引用，UI/手机端不能直接渲染。
  // snapshot 出协议前在 agent 侧回填 data URL，避免把本地 artifact 目录读法泄漏给前端。
  if (part.type !== "file" || !isImageMime(part.mime) || isUsableDataUrl(part.url)) {
    return part;
  }
  const artifactUri = snapshotFilePartArtifactUri(part);
  if (!artifactUri) {
    return part;
  }

  try {
    const artifact = await app.readToolResultArtifact(artifactUri);
    const dataUrl = dataUrlFromSnapshotArtifact(artifact.content, artifact.contentType, part.mime);
    if (!dataUrl || Buffer.byteLength(dataUrl, "utf8") > SNAPSHOT_INLINE_IMAGE_DATA_URL_MAX_BYTES) {
      return part;
    }
    return { ...part, url: dataUrl };
  } catch {
    return part;
  }
}

function snapshotFilePartArtifactUri(
  part: Extract<ReturnType<typeof mapMessageWithParts>["parts"][number], { type: "file" }>,
): string | undefined {
  const metadataArtifactUri =
    typeof part.metadata?.artifactUri === "string" ? part.metadata.artifactUri : undefined;
  const artifactUri = metadataArtifactUri ?? part.url;
  return artifactUri.startsWith("zcode-artifact://") ? artifactUri : undefined;
}

function dataUrlFromSnapshotArtifact(
  content: string,
  contentType: string,
  fallbackMime: string,
): string | undefined {
  if (isUsableDataUrl(content)) {
    return content;
  }
  const mediaType = concreteImageMime(contentType) ?? concreteImageMime(fallbackMime);
  if (!mediaType) {
    return undefined;
  }
  return `data:${mediaType};base64,${content}`;
}

function isImageMime(mime: string): boolean {
  return mime === "image/*" || mime.startsWith("image/");
}

function concreteImageMime(mime: string): string | undefined {
  const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") && normalized !== "image/*" ? normalized : undefined;
}

function isUsableDataUrl(value: string): boolean {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 && value.slice(commaIndex + 1).length > 0;
}

export async function mapSessionSettings(
  app: ZCodeApp,
  options: {
    currentModelContextWindow?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<ZCodeSessionSettingsState> {
  const thoughtLevels = app.listThoughtLevels();
  const rawCurrentThoughtLevel = app.getThoughtLevel();
  // setModel 后 runtime 可能短暂保留上一个模型的 thoughtLevel。
  // 协议 snapshot 是 UI/测试共同事实源，不能返回不在当前模型可选列表里的 current。
  const currentThoughtLevel =
    rawCurrentThoughtLevel && thoughtLevels.includes(rawCurrentThoughtLevel)
      ? rawCurrentThoughtLevel
      : undefined;
  const rawDefaultThoughtLevel = app.getDefaultThoughtLevel();
  const defaultThoughtLevel =
    rawDefaultThoughtLevel && thoughtLevels.includes(rawDefaultThoughtLevel)
      ? rawDefaultThoughtLevel
      : undefined;
  const currentModel = app.getModel();
  const currentModelOption = app.getCurrentModelOption?.();
  const availableModels =
    options.modelAvailability === "current"
      ? currentModelOption
        ? [
            {
              ...currentModelOption,
              contextWindow:
                positiveInteger(options.currentModelContextWindow) ??
                currentModelOption.contextWindow,
            },
          ]
        : app
            .listModels()
            .filter((candidate) => formatProtocolModelSelection(candidate.ref) === currentModel)
      : app.listModels();
  return {
    mode: {
      current: app.getMode(),
    },
    model: {
      // app/stdio 场景下 provider catalog 属于 app 状态，不应随每次 session/read、
      // setModel 回包返回完整模型市场；session settings 只需要表达当前运行模型即可。
      available: availableModels,
      // Session 原选择是后续输入解析的依据；字符串和过滤后的档位会丢失原意图。
      // current 允许暂时不可执行，展示/派发的有效性由公共 Selection View 决定。
      current: app.runtime.getSessionModelSelection(),
      lastUsed: optionalModelSelectionFromString(currentModel),
    },
    permission: {
      mode: app.getMode(),
    },
    thoughtLevel: {
      available: thoughtLevels.map((level) => ({ label: level, value: level })),
      current: currentThoughtLevel,
      // 云端 reasoning.defaultLevel 只存在于模型事实中，旧 settings
      // 没有携带默认档位，UI 在 current 为空时只能误选 available[0]。
      ...(defaultThoughtLevel ? { defaultLevel: defaultThoughtLevel } : {}),
      enabled: thoughtLevels.length > 0,
    },
  };
}

export function mapSessionInfo(input: {
  app?: Pick<ZCodeApp, "getMode" | "getModel" | "sessionId" | "traceId">;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  projection?: SessionProjection;
  session?: SessionInfo | null;
  taskType?: SessionInfo["taskType"];
  parentSessionId?: string;
  workspace: ZCodeWorkspaceRef;
}): ZCodeSessionInfo {
  const sessionId = String(input.session?.id ?? input.app?.sessionId ?? "unknown");
  // 刚创建的 protocol session 可能还没有持久化 session 行。
  // 此时 runtime projection 的时间可能继承 workspace 预热 draft，不能作为正式 session 时间。
  const createdAt =
    input.session?.time.created ??
    input.fallbackCreatedAt ??
    input.projection?.createdAt.getTime() ??
    Date.now();
  const updatedAt =
    input.session?.time.updated ??
    input.fallbackUpdatedAt ??
    input.projection?.updatedAt.getTime() ??
    createdAt;
  return {
    createdAt,
    mode: input.projection?.mode ?? input.app?.getMode?.() ?? "build",
    model: input.app ? optionalModelSelectionFromString(input.app.getModel()) : undefined,
    parentSessionId: input.session?.parentID ?? input.parentSessionId,
    traceId: input.session?.traceID ?? input.app?.traceId,
    sessionId,
    sessionKind: (input.session?.taskType ?? input.taskType ?? "interactive") as ZCodeSessionKind,
    status: input.projection?.status ?? "idle",
    target: mapSessionGoal(input.projection?.target),
    title: input.session?.title ?? "",
    titleSource: input.session?.titleSource,
    updatedAt,
    workspace: input.workspace,
  };
}

export function mapSessionEvent(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent {
  return {
    deliveryKind,
    eventId: String(event.id),
    payload: mapSessionEventPayload(event),
    seq: options.seq ?? event.sequenceNumber,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp.getTime(),
    traceId: String(event.traceId),
    turnId: event.turnId ? String(event.turnId) : undefined,
    type: mapSessionEventType(event.type),
  };
}

export function mapSessionEventForProtocol(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent | null {
  if (!shouldExposeSessionEventToProtocol(event)) {
    return null;
  }
  return mapSessionEvent(event, deliveryKind, options);
}

export function mapSessionEvents(
  events: readonly SessionEvent[],
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeSessionEvent[] {
  return events
    .map((event) => mapSessionEventForProtocol(event, deliveryKind))
    .filter((event): event is ZCodeSessionEvent => event !== null);
}

export function shouldExposeSessionEventToProtocol(event: SessionEvent): boolean {
  if (event.type === SessionEventType.StreamingToolLedgerUpdated) {
    // 性能修复：StreamingToolLedgerUpdated 是 runtime replay 账本，常在 closed/queued/started/committed
    // 阶段携带同一份完整 tool input。UI 协议流已有 model.streaming/tool.updated 生命周期，
    // 继续透出会造成大参数反复全量跨进程传输，且 mapper 最终也不会消费这些内部状态。
    return false;
  }

  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    // 与上面同一个 seam、同一个理由：workflow run 事件对 v3 完全同构——v4 面已有权威投影
    // （workflowRuns 状态键），v3 mapper 不消费这些内部状态，继续透出只是把每个节点相位
    // 迁移都跨进程搬一遍。**注意与前置特性的偏斜危害不同**：这里的剥离不是为了防丢事件，
    // 新类型不会被 v3 拒收（mapSessionEventType 的 default 落到 session.updated，其 payload
    // 是宽松的 jsonObjectSchema），纯粹是带宽与语义干净。
    return false;
  }

  if (event.type !== SessionEventType.ModelStreaming) {
    return true;
  }

  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  // UI 已支持工具参数预览后，tool_input_* 不能再在协议边界丢弃；
  // 否则 Write/Edit 会在模型思考阶段完全不可见。小包压力由 runtime 合并 delta 控制。
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(delta);
  }
  return (
    kind === "tool_input_start" ||
    kind === "tool_input_delta" ||
    kind === "tool_input_end" ||
    kind === "tool_call"
  );
}

function mapSessionEventPayload(event: SessionEvent): unknown {
  const payload = event.payload;
  switch (event.type) {
    case SessionEventType.ModelRequest:
      return mapModelRequestPayload(payload);
    case SessionEventType.ModelNetworkStatus:
      return mapModelNetworkStatusPayload(payload);
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return mapStreamRecoveryPayload(payload);
    case SessionEventType.ToolCallScheduled:
      return { ...(payload as Record<string, unknown>), kind: "scheduled" };
    case SessionEventType.ToolCallStarted:
      return mapToolCallStartedPayload(payload, event.timestamp);
    case SessionEventType.ToolCallProgress:
      return { ...(payload as Record<string, unknown>), kind: "progress" };
    case SessionEventType.ToolCallResult:
      return { ...(payload as Record<string, unknown>), kind: "result" };
    case SessionEventType.ToolCallError:
      return { ...(payload as Record<string, unknown>), kind: "error" };
    case SessionEventType.ToolBatchComplete:
      return { ...(payload as Record<string, unknown>), kind: "batch" };
    case SessionEventType.PermissionRequested:
      return mapPermissionRequestedPayload(payload);
    case SessionEventType.PermissionDenied:
      return mapPermissionDeniedPayload(payload);
    default:
      return payload;
  }
}

function mapPermissionDeniedPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // PermissionDenied 复用 permission.resolved 协议事件。
    // 下游投影依赖 decision=deny 才会把已出现的工具卡收口成失败态。
    decision: "deny",
  };
}

function mapToolCallStartedPayload(
  payload: unknown,
  eventTimestamp: Date,
): Record<string, unknown> {
  // 修复原因（2026-11-06 PLM-JARVIS-2 的运行时证据；该用例的示例插件 Jarvis 已迁出到市场仓库，用例已删除，
  // 回归由 tests/session-mapper-legacy-strip.test.ts 守住。当时 App 的 readSession(view:"summary") 报 ZodError，
  // events.N.payload 有多余的键 readOnly、sideEffectScope）：bc4d317e93 给 ToolCallStartedPayload 加了解析后的
  // 副作用能力，这里整体 spread，两个字段漏进 strict 的 tool.updated(started)。App 读事件是整页 safeParse，
  // 一条失败整页失败：调用过工具、正在运行的会话读不到 executionId，中断不了。
  // 与 mapPermissionRequestedPayload 的剥离同理：只改 App 的 schema 保护不了已经装出去的旧桌面，所以在源头剥掉。
  const { readOnly: _readOnly, sideEffectScope: _sideEffectScope, ...record } = asRecord(payload);
  return {
    ...record,
    // ToolCallStarted 的 startedAt 来自 runtime Date 对象；协议跨进程后必须是
    // 稳定 JSON 值，否则接收侧 strict schema 会把 started 事件当成无效消息丢弃。
    startedAt: protocolInstantValue(record.startedAt) ?? eventTimestamp.getTime(),
    kind: "started",
  };
}

function protocolInstantValue(value: unknown): number | string | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function mapModelRequestPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  // 内存 event store 淘汰 sealed turn 时把 messages 瘦身为 messageCount（session-event-store-retention.md），
  // 两种形态都要映射出同一个 messageCount。
  const messageCount =
    typeof record.messageCount === "number"
      ? record.messageCount
      : Array.isArray(record.messages)
        ? record.messages.length
        : 0;
  const result: Record<string, unknown> = {
    messageCount,
  };
  for (const key of [
    "providerId",
    "modelId",
    "temperature",
    "maxTokens",
    "toolCount",
    "iteration",
  ]) {
    if (record[key] !== undefined) {
      result[key] = record[key];
    }
  }
  // model_request 的 messages 是发给模型的完整上下文，只用于 core 内部追踪。
  // 之前映射成 session.updated 后会把全量上下文反复推给桌面，工具轮次越多单包越大。
  return result;
}

function mapModelNetworkStatusPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromModelNetworkStatusPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // 网络重试是模型请求运行态，不属于可持久化消息内容。
        // 这里通过 app 私有 meta 暴露给旧 task 投影，app 再写入 host runtime snapshot。
        apiRetry,
      },
    },
  };
}

function mapStreamRecoveryPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromStreamRecoveryPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // streamRecovery.updated 才是 SSE 断流恢复的核心进度事件。
        // 之前只在后续 model_request_started 上补 meta，UI 错过该事件时不会显示重试次数。
        apiRetry,
      },
    },
  };
}

export function mapSessionProjection(projection: SessionProjection): ZCodeSessionProjection {
  return {
    activeToolCalls: projection.activeToolCalls.map(mapActiveToolCall),
    backgroundJobs: projection.backgroundTasks.map(mapBackgroundTask),
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    currentTurnId: projection.currentTurnId ? String(projection.currentTurnId) : undefined,
    lastError: projection.lastError,
    mode: projection.mode,
    pendingPermissions: projection.pendingPermissions.map(mapPendingPermission),
    sessionId: String(projection.id),
    status: projection.status,
    target: mapSessionGoal(projection.target),
    totalTokenCount: projection.totalTokenCount,
    turnCount: projection.turnCount,
  };
}

function mapRuntimeState(input: {
  activeTurn?: ReturnType<ZCodeApp["runtime"]["getActiveTurnInfo"]>;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  messages: MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
  stateRevision: number;
}): ZCodeSessionRuntimeState {
  // projection.currentTurnId 是投影最后处理过的 turn，不代表当前仍在运行。
  // session 恢复/subscribe 快照如果把它回填成 runtime.activeTurnId，会让已 idle/complete 的任务误显示为 thinking。
  const activeTurnId = input.activeTurn?.turnId;
  const contextUsage = resolveSessionContextUsage({
    messages: input.messages,
    persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
    projection: input.projection,
  });
  // 共享 runtime schema 已用 activeTurnId/activeTurnKind 表达运行中 turn；
  // mainActive 是旧 UI 派生字段，继续从 CLI 快照写出会让 bootstrap 独立 build 失败。
  return {
    activeTurnId: activeTurnId ? String(activeTurnId) : undefined,
    activeTurnKind: input.activeTurn?.kind,
    deliveryKind: input.deliveryKind,
    eventSeq: input.eventSeq,
    pendingRequestIds: input.projection.pendingPermissions.map(
      (permission) => permission.requestId ?? permission.toolCallId,
    ),
    ...(contextUsage ? { contextUsage } : {}),
    goalVerifications: mapGoalVerifications(input.projection.targetCompletionVerifications),
    goalVerificationTimeline: mapGoalVerificationTimeline(
      input.projection.targetCompletionVerificationTimeline,
    ),
    stateRevision: input.stateRevision,
  };
}

interface ContextUsageBreakdownCandidate {
  breakdown: ZCodeContextUsageBreakdownItem[];
  contextWindow?: number;
  used: number;
}

/**
 * legacy snapshot 与 V4 usage 窄种子的共享计算口径。
 *
 * V4 冷恢复只需要 context usage，过去却通过 full legacy snapshot 间接读取。
 * 抽出纯投影后，两条路径继续共享 active-branch token/cache 与 breakdown 对齐规则。
 */
export function resolveSessionContextUsage(input: {
  messages: readonly MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
}): ZCodeSessionContextUsage | undefined {
  const persistedContextUsage = contextUsageFromPersistedMessages(
    input.messages,
    input.projection.contextWindow,
  );
  return applyContextUsageBreakdown(
    contextUsageFromProjection(
      input.projection,
      persistedContextUsage?.used === input.projection.contextUsed
        ? persistedContextUsage.cache
        : undefined,
    ) ?? persistedContextUsage,
    latestContextUsageBreakdownFromEvents(input.persistedContextUsageBreakdownEvents ?? []),
  );
}

function applyContextUsageBreakdown(
  contextUsage: ZCodeSessionContextUsage | undefined,
  candidate: ContextUsageBreakdownCandidate | undefined,
): ZCodeSessionContextUsage | undefined {
  if (!contextUsage || !candidate || candidate.breakdown.length === 0) {
    return contextUsage;
  }
  if (contextUsage.breakdown && contextUsage.breakdown.length > 0) {
    return contextUsage;
  }
  if (candidate.used !== contextUsage.used) {
    return contextUsage;
  }
  if (candidate.contextWindow !== undefined && candidate.contextWindow !== contextUsage.size) {
    return contextUsage;
  }
  return {
    ...contextUsage,
    breakdown: candidate.breakdown,
  };
}

function latestContextUsageBreakdownFromEvents(
  events: readonly SessionEvent[],
): ContextUsageBreakdownCandidate | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== SessionEventType.ModelComplete) {
      continue;
    }
    const payload = event.payload as Partial<ModelCompletePayload>;
    const querySource = stringValue(payload.querySource);
    if (querySource !== undefined && querySource !== "main_turn") {
      continue;
    }
    const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
    const used = getModelUsageContextTokens(payload.usage);
    if (!parsed.success || parsed.data.length === 0 || used === undefined) {
      continue;
    }
    const contextWindow = positiveInteger(payload.contextWindow);
    // 冷恢复只能从 eventStore 重建 context breakdown；必须用 usage/window 对齐，
    // 避免把旧分支或 sidecar 模型请求的来源比例挂到当前 task meter 上。
    return {
      breakdown: parsed.data,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      used,
    };
  }
  return undefined;
}

function mapGoalVerifications(
  verifications: SessionProjection["targetCompletionVerifications"] | undefined,
): ZCodeSessionGoalVerification[] {
  return (verifications ?? []).map((verification) => ({
    nextAction: verification.nextAction ?? null,
    passed: verification.passed,
    reason: verification.reason,
  }));
}

function mapGoalVerificationTimeline(
  timeline: SessionProjection["targetCompletionVerificationTimeline"] | undefined,
): ZCodeSessionGoalVerificationTimeline[] {
  return (timeline ?? []).map((item) => ({
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId: item.targetId,
    verificationId: item.verificationId,
    status: item.status,
    ...(item.goalIteration ? { goalIteration: item.goalIteration } : {}),
    ...(item.anchorAssistantMessageId
      ? { anchorAssistantMessageId: item.anchorAssistantMessageId }
      : {}),
    ...(item.anchorTurnId ? { anchorTurnId: item.anchorTurnId } : {}),
    ...(item.verification
      ? {
          verification: {
            nextAction: item.verification.nextAction ?? null,
            passed: item.verification.passed,
            reason: item.verification.reason,
          },
        }
      : {}),
    ...(item.startedAt ? { startedAt: item.startedAt.getTime() } : {}),
    updatedAt: item.updatedAt.getTime(),
  }));
}

function contextUsageFromProjection(
  projection: SessionProjection,
  cache: ZCodeSessionContextUsage["cache"] | undefined,
): ZCodeSessionContextUsage | undefined {
  if (projection.contextUsed <= 0 || projection.contextWindow <= 0) {
    return undefined;
  }
  return {
    ...(cache ? { cache } : {}),
    cost: null,
    size: projection.contextWindow,
    used: projection.contextUsed,
  };
}

function contextUsageFromPersistedMessages(
  messages: readonly MessageWithParts[],
  contextWindow: number,
): ZCodeSessionContextUsage | undefined {
  if (contextWindow <= 0) {
    return undefined;
  }
  const cache = contextCacheUsageFromMessages(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.info.role === "user" && message.info.summary) {
      const compactPart = message.parts.find(
        (part) => part.type === "compaction" && part.compactBoundary,
      );
      if (compactPart?.type === "compaction" && compactPart.compactBoundary) {
        const used = positiveInteger(
          compactPart.compactBoundary.truePostCompactTokenCount ??
            compactPart.compactBoundary.postCompactTokenCount,
        );
        // 成功 compact 的 usage 持久化在 user summary 的 boundary；
        // 只扫描 assistant 会越过它并恢复压缩前水位。旧 assistant boundary 和
        // 不完整历史仍走原有 fallback，且不能把压缩前 cache 重新挂到压缩后水位。
        if (used !== undefined) {
          return {
            cost: null,
            size: contextWindow,
            used,
          };
        }
      }
    }
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const used = contextUsedFromTokens(message.info.tokens);
    if (used === undefined) {
      continue;
    }
    // protocol eventStore 是运行期内存账本，重启 resume 后 projection.contextUsed 会回到 0。
    // context window 消耗是 input + output；恢复时优先用 provider total，否则用持久化的 input/output 还原 meter。
    return {
      ...(cache ? { cache } : {}),
      cost: null,
      size: contextWindow,
      used,
    };
  }
  return undefined;
}

function contextUsedFromTokens(
  tokens:
    | {
        total?: number;
        input: number;
        output?: number;
      }
    | undefined,
): number | undefined {
  if (!tokens) {
    return undefined;
  }

  const total = positiveInteger(tokens.total);
  if (total !== undefined) {
    return total;
  }

  const input = positiveInteger(tokens.input);
  if (input === undefined) {
    return undefined;
  }

  return input + (nonNegativeInteger(tokens.output) ?? 0);
}

function contextCacheUsageFromMessages(
  messages: readonly MessageWithParts[],
): ZCodeSessionContextUsage["cache"] | undefined {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requestCount = 0;
  let latestInputTokens = 0;
  let latestCacheReadTokens = 0;
  let latestCacheWriteTokens = 0;

  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const input = nonNegativeInteger(message.info.tokens.input) ?? 0;
    const read = nonNegativeInteger(message.info.tokens.cache.read) ?? 0;
    const write = nonNegativeInteger(message.info.tokens.cache.write) ?? 0;
    if (input <= 0 && read <= 0 && write <= 0) {
      continue;
    }
    requestCount += 1;
    inputTokens += input;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    latestInputTokens = input;
    latestCacheReadTokens = read;
    latestCacheWriteTokens = write;
  }

  if (requestCount <= 0) {
    return undefined;
  }
  return {
    inputTokens: latestInputTokens,
    cacheReadTokens: latestCacheReadTokens,
    cacheWriteTokens: latestCacheWriteTokens,
    latestHitRate: latestInputTokens > 0 ? latestCacheReadTokens / latestInputTokens : null,
    hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null,
    hitRateRequestCount: requestCount,
    totalInputTokens: inputTokens,
    totalCacheReadTokens: cacheReadTokens,
    totalCacheWriteTokens: cacheWriteTokens,
  };
}

function mapPendingPermission(permission: PendingPermission): ZCodePendingPermission {
  // display / optionsPolicy 刻意不进 legacy v3 输出。
  // 根因不是"扩 schema 只能单向兼容"，而是 strict schema 随 packages/shared 打进每个桌面端
  // 的产物：今天把 zcodePendingPermissionSchema（shared/src/zcode-protocol/index.ts:1139）和
  // zcodePermissionRequestedEventPayloadSchema（同文件:1536）改成可选，也保护不了已经装出去
  // 的旧桌面。新 CLI 一旦在 v3 路径上带这两个字段，旧桌面会整份快照解析失败、并用 safeParse
  // 静默丢弃整个 permission.requested 事件——确认窗本身就没了，这违反"只允许预览降级、
  // 不允许 gate 降级"。剥离在源头是唯一对版本偏斜安全的做法；legacy 也没有画因果图的界面。
  // optionsPolicy 的效果仍然生效：它作为 buildProtocolPermissionOptions 的输入裁掉
  // allow_always，只有裁剪后的 options 列表过协议。会话免确认同样降级为裁剪：
  // 旧桌面回传的是 response 原文，认不出会话语义（见 toLegacyPermissionOptionsPolicy）。
  return {
    input: permission.input,
    ...(permission.origin ? { origin: permission.origin } : {}),
    options: buildProtocolPermissionOptions({
      ...permission,
      optionsPolicy: toLegacyPermissionOptionsPolicy(permission.optionsPolicy),
    }),
    reason: permission.reason ?? "",
    requestId: permission.requestId ?? permission.toolCallId,
    requestedAt: permission.requestedAt.getTime(),
    riskLevel: permission.riskLevel,
    toolCallId: permission.toolCallId,
    toolName: permission.toolName,
  };
}

function mapPermissionRequestedPayload(payload: unknown): Record<string, unknown> {
  // 同 mapPendingPermission：这个 payload 是整体 spread 出去的，新字段必须在这里显式解构
  // 剔除，否则会直接漏进 strict 的 zcodePermissionRequestedEventPayloadSchema。
  // fullAccessSupported（adf550c6e6，审批里「授予完全访问」）同样只给 v4：legacy 剥掉，原因见上面 started 的注释。
  const {
    display: _display,
    optionsPolicy,
    fullAccessSupported: _fullAccessSupported,
    ...record
  } = asRecord(payload);
  const toolName = stringValue(record.toolName) ?? "unknown";
  return {
    ...record,
    options: buildProtocolPermissionOptions({
      approvalMode: record.approvalMode === "user-once" ? "user-once" : undefined,
      input: record.input,
      suggestedPermissionUpdates: Array.isArray(record.suggestedPermissionUpdates)
        ? (record.suggestedPermissionUpdates as PendingPermission["suggestedPermissionUpdates"])
        : undefined,
      optionsPolicy: toLegacyPermissionOptionsPolicy(optionsPolicy),
      toolName,
    }),
  };
}

function mapActiveToolCall(toolCall: ActiveToolCall): ZCodeActiveToolCall {
  return {
    startedAt: toolCall.startedAt?.getTime(),
    status: toolCall.status,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
  };
}

function mapBackgroundTask(task: BackgroundTaskInfo): Record<string, unknown> {
  return { ...task };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function mergePersistedGoalVerificationEvents(
  projection: SessionProjection,
  events: readonly SessionEvent[],
  target?: SessionGoal | null,
): SessionProjection {
  if (events.length === 0) {
    return projection;
  }

  const baseProjection = {
    ...projection,
    targetCompletionVerifications: projection.targetCompletionVerifications ?? [],
    targetCompletionVerificationTimeline: projection.targetCompletionVerificationTimeline ?? [],
  };
  const targetId = target?.targetID ?? projection.target?.targetID;
  const reducer = new EventReducer();
  const restored = [...events]
    .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
    .filter((event) => {
      const payload = asRecord(event.payload);
      const eventTargetId = stringValue(payload.targetId);
      return !targetId || !eventTargetId || eventTargetId === targetId;
    })
    .sort(compareEventsByTimelineTime)
    .reduce((current, event) => reducer.apply(current, event), baseProjection);
  const timeline = getTargetGoalVerificationTimeline(restored, target).sort(
    compareGoalVerificationTimeline,
  );
  return {
    ...restored,
    targetCompletionVerificationTimeline: timeline,
    targetCompletionVerifications: mergeGoalVerificationSummaries(
      restored.targetCompletionVerifications,
      timeline,
    ),
  };
}

function compareEventsByTimelineTime(left: SessionEvent, right: SessionEvent): number {
  const byTime = left.timestamp.getTime() - right.timestamp.getTime();
  if (byTime !== 0) return byTime;
  return left.sequenceNumber - right.sequenceNumber;
}

function mergeGoalVerificationSummaries(
  verifications: readonly GoalCompletionVerificationOutput[],
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): GoalCompletionVerificationOutput[] {
  const result: GoalCompletionVerificationOutput[] = [];
  const seen = new Set<string>();
  for (const verification of [
    ...verifications,
    ...timeline
      .map((item) => item.verification)
      .filter((item): item is GoalCompletionVerificationOutput => item !== undefined),
  ]) {
    const key = goalVerificationSummaryKey(verification);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(verification);
  }
  return result;
}

function goalVerificationSummaryKey(verification: GoalCompletionVerificationOutput): string {
  return [
    verification.passed ? "1" : "0",
    normalizeTodoContent(verification.reason),
    normalizeTodoContent(verification.nextAction ?? ""),
  ].join("\u0000");
}

function withGoalSummaryTitleFallback(
  projection: SessionProjection,
  session: SessionInfo | null | undefined,
  messages: readonly MessageWithParts[],
): SessionProjection {
  const target = projection.target;
  if (!target || target.summaryTitle || !session?.title) {
    return projection;
  }
  // 只取真实用户输入：SessionStart hook 的上下文写在首条 prompt 之前，按时间它才是最早的 user 行。
  // 修复原因：只按 role 取最早一行时会取到这条隐藏提醒，正文对不上 goal，首轮标题补不回来。
  const firstUserMessage = messages
    .filter(isConversationRealUserTurnStarter)
    .sort(compareMessagesByCreatedTime)[0];
  if (
    !firstUserMessage ||
    Math.abs(firstUserMessage.info.time.created - target.time.created) > 5_000
  ) {
    return projection;
  }
  if (normalizeText(readMessageText(firstUserMessage)) !== normalizeText(target.objective)) {
    return projection;
  }
  return {
    ...projection,
    target: {
      ...target,
      // 首条用户请求就是 goal 时，session 标题才是第一轮标题的持久来源；
      // 老数据可能没有写 target.summaryTitle，恢复后需要用 session.title 补齐首轮标题。
      summaryTitle: session.title,
    },
  };
}

function readMessageText(message: MessageWithParts): string {
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function mapSessionGoal(goal: SessionGoal | null | undefined): ZCodeSessionGoal | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  return {
    createdAt: goal.time.created,
    objective: goal.objective,
    sessionId: String(goal.sessionID),
    status: goal.status,
    summaryTitle: goal.summaryTitle,
    targetId: goal.targetID,
    timeUsedSeconds: goal.timeUsedSeconds ?? 0,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed ?? 0,
    activeInputId: goal.activeInputId ?? null,
    activeRunStartedAtMs: goal.activeRunStartedAtMs ?? null,
    activeRunLastSeenAtMs: goal.activeRunLastSeenAtMs ?? null,
    updatedAt: goal.time.updated,
  };
}

function mapTodoItem(todo: TodoItem): TodoItem {
  return {
    content: todo.content,
    priority: todo.priority,
    status: todo.status,
  };
}

interface GoalIterationBucket {
  goalIteration: number;
  id: string;
  messageIds: Set<string>;
  startedAt?: number;
  targetId?: string;
  toolCallCount: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt?: number;
}

function buildGoalStats(
  projection: SessionProjection,
  messages: readonly MessageWithParts[],
): ZCodeSessionGoalStats | undefined {
  const target = projection.target;
  if (!target) {
    return undefined;
  }
  const goalIterations = collectGoalIterationBuckets(messages, {
    projection,
    target,
  });
  const activeIterationCount = getGoalActiveIterationCount(projection, target);
  const derivedTokensUsed = goalIterations.reduce(
    (sum, iteration) => sum + iteration.tokensUsed,
    0,
  );
  const derivedTimeUsedSeconds = goalIterations.reduce(
    (sum, iteration) => sum + iteration.timeUsedSeconds,
    0,
  );
  return {
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    // goal 轮次只能由 verifier 生命周期边界推进；用户消息、TodoWrite
    // 或手动继续都只是落入当前打开轮次，不能单独开新轮。
    iterationCount: activeIterationCount,
    // active goal run 已由 session_target.active_run_started_at 表达。
    // 运行中不能再用 assistant 消息推导出的时间当已结算 base，否则 UI 会再叠加 live run 导致切换恢复后双算。
    timeUsedSeconds:
      target.timeUsedSeconds > 0 || target.activeRunStartedAtMs != null
        ? target.timeUsedSeconds
        : derivedTimeUsedSeconds,
    // 旧 session_target 行可能没有 tokenBudget；协议 schema 需要稳定 JSON 值，
    // 与 mapSessionGoal 保持一致用 null 表示未设置预算。
    tokenBudget: target.tokenBudget ?? null,
    tokensUsed: target.tokensUsed > 0 ? target.tokensUsed : derivedTokensUsed,
    toolCallCount: goalIterations.reduce((sum, iteration) => sum + iteration.toolCallCount, 0),
  };
}

function buildTodoGroups(
  messages: readonly MessageWithParts[],
  currentTodos: readonly TodoItem[],
  projection: SessionProjection,
): ZCodeSessionTodoGroup[] {
  const target = projection.target;
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  const groups = new Map<string, ZCodeSessionTodoGroup>();
  const todoOwners = new Map<string, { fingerprint: string; groupId: string }>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    for (const part of message.parts) {
      if (
        part.type !== "tool" ||
        !isTodoWriteToolName(part.tool) ||
        !isMainAgentToolProjectionSource(part.metadata, readToolStateMetadata(part.state))
      ) {
        continue;
      }
      const todos = readTodosFromToolInput(part.state.input);
      if (!todos) {
        continue;
      }
      const updatedAt =
        readToolStateUpdatedAt(part.state) ??
        message.info.time.completed ??
        message.info.time.created;
      const groupId = goalIteration ? `goal-iteration-${goalIteration}` : "session";
      const group = ensureTodoGroup(groups, {
        goalIteration,
        groupId,
        startedAt: goalIteration
          ? getGoalIterationStartedAt(goalIteration, target, timeline, message.info.time.created)
          : message.info.time.created,
        targetId: goalIteration ? target?.targetID : undefined,
        updatedAt,
      });
      for (const todo of todos) {
        const fingerprint = normalizeTodoContent(todo.content);
        const ownerKey = `${target?.targetID ?? "session"}\u0000${fingerprint}`;
        const owner = todoOwners.get(ownerKey);
        if (owner) {
          const ownerGroup = groups.get(owner.groupId);
          if (ownerGroup) {
            addOrUpdateTodoInGroup(ownerGroup, owner.fingerprint, todo);
            ownerGroup.updatedAt = Math.max(ownerGroup.updatedAt ?? 0, updatedAt);
          }
          continue;
        }
        todoOwners.set(ownerKey, { fingerprint, groupId });
        addOrUpdateTodoInGroup(group, fingerprint, todo);
      }
    }
  }

  if (groups.size === 0 && currentTodos.length > 0) {
    groups.set("session-current", {
      id: "session-current",
      source: "session",
      todos: currentTodos.map(mapTodoItem),
    });
  }

  return [...groups.values()].sort((left, right) => {
    const leftTime = left.startedAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.startedAt ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });
}

function ensureTodoGroup(
  groups: Map<string, ZCodeSessionTodoGroup>,
  input: {
    goalIteration: number | undefined;
    groupId: string;
    startedAt: number;
    targetId?: string;
    updatedAt: number;
  },
): ZCodeSessionTodoGroup {
  const existing = groups.get(input.groupId);
  if (existing) {
    existing.updatedAt = Math.max(existing.updatedAt ?? 0, input.updatedAt);
    return existing;
  }
  const group: ZCodeSessionTodoGroup = {
    id: input.groupId,
    source: input.goalIteration ? "goal_iteration" : "session",
    ...(input.goalIteration ? { goalIteration: input.goalIteration } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    todos: [],
  };
  groups.set(input.groupId, group);
  return group;
}

function addOrUpdateTodoInGroup(
  group: ZCodeSessionTodoGroup,
  fingerprint: string,
  todo: TodoItem,
): void {
  const nextTodo = mapTodoItem(todo);
  const existingIndex = group.todos.findIndex(
    (item) => normalizeTodoContent(item.content) === fingerprint,
  );
  if (existingIndex >= 0) {
    group.todos[existingIndex] = nextTodo;
    return;
  }
  group.todos.push(nextTodo);
}

function getGoalActiveIterationCount(
  projection: SessionProjection,
  target?: SessionGoal | null,
): number {
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  return getZCodeGoalActiveIterationCount({
    targetStatus: target?.status ?? null,
    timeline,
  });
}

function collectGoalIterationBuckets(
  messages: readonly MessageWithParts[],
  options: { projection: SessionProjection; target?: SessionGoal | null },
): GoalIterationBucket[] {
  const target = options.target ?? null;
  const timeline = getTargetGoalVerificationTimeline(options.projection, target);
  const buckets: GoalIterationBucket[] = [];
  const byIteration = new Map<number, GoalIterationBucket>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    if (!goalIteration) {
      continue;
    }
    const bucket =
      byIteration.get(goalIteration) ??
      createGoalIterationBucket(goalIteration, target, timeline, message.info.time.created);
    if (!byIteration.has(goalIteration)) {
      byIteration.set(goalIteration, bucket);
      buckets.push(bucket);
    }
    const messageId = String(message.info.id);
    bucket.messageIds.add(messageId);
    const completedAt = message.info.time.completed ?? message.info.time.created;
    bucket.toolCallCount += message.parts.filter((part) => part.type === "tool").length;
    bucket.tokensUsed += tokenTotal(message.info.tokens);
    bucket.timeUsedSeconds += Math.max(
      0,
      Math.ceil((completedAt - message.info.time.created) / 1000),
    );
    bucket.updatedAt = Math.max(bucket.updatedAt ?? 0, completedAt);
  }

  return buckets;
}

function createGoalIterationBucket(
  goalIteration: number,
  target: SessionGoal | null,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): GoalIterationBucket {
  return {
    goalIteration,
    id: `goal-iteration-${goalIteration}`,
    messageIds: new Set(),
    startedAt: getGoalIterationStartedAt(goalIteration, target, timeline, fallbackStartedAt),
    targetId: target?.targetID,
    toolCallCount: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    updatedAt: fallbackStartedAt,
  };
}

function getTargetGoalVerificationTimeline(
  projection: SessionProjection,
  target?: SessionGoal | null,
): SessionProjection["targetCompletionVerificationTimeline"] {
  const targetId = target?.targetID;
  return (projection.targetCompletionVerificationTimeline ?? [])
    .filter((item) => !targetId || item.targetId === targetId)
    .sort(compareGoalVerificationTimeline);
}

function compareGoalVerificationTimeline(
  left: SessionProjection["targetCompletionVerificationTimeline"][number],
  right: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  const leftIteration = left.goalIteration ?? 0;
  const rightIteration = right.goalIteration ?? 0;
  if (leftIteration !== rightIteration && leftIteration > 0 && rightIteration > 0) {
    return leftIteration - rightIteration;
  }
  const byTime = goalVerificationTimelineTime(left) - goalVerificationTimelineTime(right);
  if (byTime !== 0) return byTime;
  return left.verificationId.localeCompare(right.verificationId);
}

function goalVerificationTimelineTime(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  return (item.startedAt ?? item.updatedAt).getTime();
}

function getGoalIterationForMessageTime(
  messageCreatedAt: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): number | undefined {
  if (!target || messageCreatedAt < target.time.created) {
    return undefined;
  }
  let activeIteration = 1;
  for (const item of timeline) {
    const itemIteration = item.goalIteration ?? activeIteration;
    const boundaryTime = item.updatedAt.getTime();
    if (messageCreatedAt <= boundaryTime) {
      return itemIteration;
    }
    if (item.status === "started") {
      activeIteration = itemIteration;
      continue;
    }
    if (isPassingGoalVerification(item)) {
      return undefined;
    }
    activeIteration = itemIteration + 1;
  }
  return activeIteration;
}

function getGoalIterationStartedAt(
  goalIteration: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): number {
  if (!target || goalIteration <= 1) {
    return target?.time.created ?? fallbackStartedAt;
  }
  const previousBoundary = [...timeline]
    .filter((item) => (item.goalIteration ?? 0) === goalIteration - 1)
    .filter((item) => item.status !== "started")
    .sort(compareGoalVerificationTimeline)
    .at(-1);
  return previousBoundary?.updatedAt.getTime() ?? fallbackStartedAt;
}

function isPassingGoalVerification(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): boolean {
  return item.status === "completed" && item.verification?.passed === true;
}

function normalizeTodoContent(content: string): string {
  return normalizeText(content);
}

function readTodosFromToolInput(input: Record<string, unknown>): TodoItem[] | undefined {
  const rawTodos = input.todos;
  if (!Array.isArray(rawTodos)) {
    return undefined;
  }
  const todos = rawTodos.map(readTodoItem).filter((todo): todo is TodoItem => todo !== null);
  return todos.length === rawTodos.length ? todos : undefined;
}

function readTodoItem(value: unknown): TodoItem | null {
  const record = asRecord(value);
  const content = stringValue(record.content)?.trim();
  const status = stringValue(record.status);
  const priority = stringValue(record.priority);
  if (!content || !isTodoStatus(status) || !isTodoPriority(priority)) {
    return null;
  }
  return { content, priority, status };
}

function isTodoWriteToolName(toolName: string): boolean {
  return toolName.toLowerCase().replace(/[_\s-]/g, "") === "todowrite";
}

function readToolStateMetadata(state: ToolState): Record<string, unknown> | undefined {
  switch (state.status) {
    case "pending":
      return undefined;
    case "running":
    case "completed":
    case "error":
      return state.metadata;
  }
}

function isTodoStatus(status: string | undefined): status is TodoItem["status"] {
  return status === "pending" || status === "in_progress" || status === "completed";
}

function isTodoPriority(priority: string | undefined): priority is TodoItem["priority"] {
  return priority === "high" || priority === "medium" || priority === "low";
}

function readToolStateUpdatedAt(state: ToolState): number | undefined {
  if (state.status === "completed" || state.status === "error") {
    return state.time.end;
  }
  if (state.status === "running") {
    return state.time.start;
  }
  return undefined;
}

function tokenTotal(tokens: {
  cache: { read: number; write: number };
  input: number;
  output: number;
  reasoning: number;
  total?: number;
}): number {
  return (
    tokens.total ??
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  );
}

function compareMessagesByCreatedTime(left: MessageWithParts, right: MessageWithParts): number {
  const byTime = left.info.time.created - right.info.time.created;
  if (byTime !== 0) return byTime;
  return String(left.info.id).localeCompare(String(right.info.id));
}

function mapSessionEventType(type: SessionEvent["type"]): ZCodeSessionEvent["type"] {
  switch (type) {
    case SessionEventType.SessionCreated:
      return "session.created";
    case SessionEventType.SessionResumed:
      return "session.resumed";
    case SessionEventType.SessionTitleUpdated:
      return "session.titleUpdated";
    case SessionEventType.SessionEnded:
      return "session.closed";
    case SessionEventType.TurnStarted:
      return "turn.started";
    case SessionEventType.TurnSteerQueued:
      return "turn.steerQueued";
    case SessionEventType.TurnSteerDrained:
      return "turn.steerDrained";
    case SessionEventType.TurnComplete:
      return "turn.completed";
    case SessionEventType.TurnError:
      return "turn.failed";
    case SessionEventType.UserMessage:
    case SessionEventType.AssistantMessage:
    case SessionEventType.SystemMessage:
      return "message.upserted";
    case SessionEventType.ModelStreaming:
      return "model.streaming";
    case SessionEventType.ToolCallScheduled:
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError:
    case SessionEventType.ToolBatchComplete:
      return "tool.updated";
    case SessionEventType.PermissionRequested:
      return "permission.requested";
    case SessionEventType.PermissionResolved:
    case SessionEventType.PermissionDenied:
      return "permission.resolved";
    case SessionEventType.CheckpointCreated:
      return "checkpoint.created";
    case SessionEventType.RewindTriggered:
      return "rewind.triggered";
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return "streamRecovery.updated";
    default:
      return "session.updated";
  }
}

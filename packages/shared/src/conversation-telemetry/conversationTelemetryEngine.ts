import { normalizeTelemetryUiMode } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- 旧 message/ARMS builders 共用同一 prompt 生命周期与时钟；拆散 fact 状态机会增加跨模块同步漂移。 */
import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "./providerTelemetryIdentity.js";
import type {
  IPlatformService,
  TelemetryEventPayload,
  RemoteWorkspaceIdentityKind,
  ZCodeContextCompactionTimelineMeta,
  ZCodeStreamEvent,
  ZCodeUsage,
} from "@zcode/shared";
import type { ConversationTelemetryInput } from "@zcode/shared/zcode-protocol-v4";
import {
  activatePromptTelemetry,
  activateDetachedAgentStepTelemetry,
  composeAgentComposition,
  type AgentStepRole,
  type ComposerInputTimingSnapshot,
  type PromptMessageSource,
  buildCompactionTelemetryExtraDetail,
  discardPromptTelemetry,
  discardQueuedPromptTelemetry,
  finalizePromptTelemetry,
  getActivePromptModelName,
  getActivePromptMessageId,
  queuePromptTelemetry,
  consumeComposerInputTiming,
  recordAgentStepTelemetryEvent,
  recordComposerFocus,
  recordComposerInputStart,
  recordComposerTextChange,
  recordSubagentToolAttribution,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
  recordPromptAdmissionTelemetry,
  recordPromptRequestMetrics,
  resetComposerInputStart,
} from "./messageTelemetry.js";
import { resolveLegacyRuntimeModelValue } from "./runtimeModelTelemetry.js";
import { buildWorkflowRunResultTelemetryEvent } from "./workflowRunTelemetry.js";

export type SendFunnelReasonCode =
  | "attachment_not_ready"
  | "blocked"
  | "rejected"
  | "stale"
  | "failed"
  | "render_timeout"
  | "transport_error"
  | "provider_not_ready"
  | "composer_error";

export type ConversationTelemetryObservation =
  | "reportSendFunnelInputFocus"
  | "reportSendFunnelSendClick"
  | "reportSendFunnelSendResult"
  | "reportPlanUsageModelRequestStartedToArms"
  | "reportPlanUsageTtftToArms"
  | "clearStreamStallTracking"
  | "recordStreamChunkArrival"
  | "reportUiFirstToken"
  | "reportUiMessageComplete"
  | "reportUiToolCallDetail"
  | "reportUiTurnBreakdown";

const MAX_DEDUPE_KEYS = 2_000;
const MAX_BUFFERED_FACTS_PER_COMMAND = 128;
const MAX_BUFFERED_COMMANDS = 200;
/** workflow_run_result 的子 agent 计数最多跟踪这么多个 run；超出时丢最早登记的 run。 */
const MAX_TRACKED_WORKFLOW_RUNS = 256;

export type TelemetryPlatform = Pick<
  IPlatformService,
  "reportArmsCustomEvent" | "reportTelemetryEvent"
>;

export interface ConversationPromptTelemetrySeed {
  localTtft?: import("@zcode/shared").LocalTtftContext;
  /** 用户触发原始发送动作的 renderer 时钟。 */
  sendTime: number;
  /** 发送瞬间冻结的旧版模型/模式/套餐字段。 */
  extraDetail: Record<string, string>;
  /** 点击发送时冻结，避免程序化清空或下一条输入改写本次 timing。 */
  inputTiming?: ComposerInputTimingSnapshot;
  /**
   * 发送漏斗关联 ID，配对 send_click ↔ send_result。仅 composer 真实点击产生；
   * 后台任务（off_peak / automation）seed 无此字段，落定时直接跳过不报。
   */
  sendClickId?: string;
  /** 是否中途经过队列二次确认弹窗（该子集的 send_cost_ms 含用户停留时间）。 */
  queueConfirmed?: boolean;
}

/** 发送落定的失败原因，取值口径见 docs/monitoring/composer-send-funnel-telemetry.md。 */
export type ConversationSendFailureReason = SendFunnelReasonCode;

export interface AcceptedConversationPromptTelemetrySeed extends ConversationPromptTelemetrySeed {
  /** CLI 会话记录的开关；缺失保持未知，不能用实时设置补齐。 */
  memoryEnabled?: boolean;
  sessionId: string;
  sourceCommandId: string;
  /** 独立 background wake 的 completion 来源在 TurnStarted admission 时冻结。 */
  completionMessageSource?: PromptMessageSource;
}

/** 队列二次确认的 ACK reasonCode，语义是「等用户裁决后复用同一 seed 重发」，不是终态。 */
const HELD_QUEUE_CONFIRMATION_STALE_REASON = "guard.heldQueueConfirmationStale";

/** 从点击发送起算，超过这个时长仍未渲染出用户消息就判超时。 */
export const SEND_RENDER_WAIT_TIMEOUT_MS = 30_000;

/**
 * ACK 的处置：要么转入待渲染等待（命令被受理，但用户消息还没画出来），
 * 要么立即落定为失败。返回 null 表示本次两者都不做。
 */
export type ConversationSendAckOutcome =
  | { kind: "awaitRender"; ackStatus: string }
  | {
      kind: "settle";
      status: "fail";
      ackStatus: string;
      reasonCode: ConversationSendFailureReason;
    };

/**
 * 把 CommandAck 折算成 send_result 的处置口径，返回 null 表示本次不落定。
 * 抽成纯函数是为了让 dispatchCommand 只负责调用，分支逻辑可单测。
 */
export function resolveSendAckSettlement(ack: {
  status: string;
  reasonCode?: string;
  result?: { type: string; disposition?: string };
}): ConversationSendAckOutcome | null {
  // 必须先于 status 判断：这条 ACK 的 status 本身非 accepted，
  // 一旦落定，first-wins 会把用户确认后的真实成败结果吃掉。
  if (ack.reasonCode === HELD_QUEUE_CONFIRMATION_STALE_REASON) return null;
  // 「对话 + 文件」编辑遇到文件冲突：ACK 是 accepted，但没有发出新一轮、不会渲染用户消息；
  // 不能转入待渲染，否则 30s 后被误记为 render_timeout。
  if (ack.result?.type === "editUserQuery" && ack.result.disposition === "blocked") {
    return { kind: "settle", status: "fail", ackStatus: ack.status, reasonCode: "blocked" };
  }
  // accepted/duplicate 只代表 Host 收下了命令，此时屏幕上还什么都没有；
  // z-code 没有乐观渲染，要等投影回流出 userInput row 才算发送成功。
  if (ack.status === "accepted" || ack.status === "duplicate") {
    return { kind: "awaitRender", ackStatus: ack.status };
  }
  const reasonCode: ConversationSendFailureReason =
    ack.status === "rejected" || ack.status === "stale" ? ack.status : "failed";
  // noop 不单列 reason_code，用户视角就是没发出去；原始值保留在 ackStatus 供下钻。
  return { kind: "settle", status: "fail", ackStatus: ack.status, reasonCode };
}

/** ACK 已受理、等待用户消息渲染出来的一条待落定记录。 */
interface PendingSendRenderWait {
  seed: ConversationPromptTelemetrySeed;
  sessionId: string | null;
  ackStatus: string;
  ackCostMs: number;
  timer: ReturnType<typeof setTimeout>;
}

function backgroundSeedFromTurnStarted(
  fact: Extract<ConversationTelemetryInput, { kind: "turn.started" }>,
): AcceptedConversationPromptTelemetrySeed | null {
  if (!fact.sourceCommandId) return null;
  if (fact.offPeakTaskId) {
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: {
        message_source: "off_peak_task",
        off_peak_task_id: fact.offPeakTaskId,
        ...(fact.offPeakRunType ? { off_peak_run_type: fact.offPeakRunType } : {}),
      },
    };
  }
  if (!fact.automationId || !fact.taskTrigger) {
    if (fact.inputSource !== "background_task") return null;
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: { message_source: "background_task" },
      ...(fact.backgroundSource === "subagent"
        ? { completionMessageSource: "background_subagent" as const }
        : fact.backgroundSource === "workflow"
          ? { completionMessageSource: "background_workflow" as const }
          : {}),
    };
  }
  const scheduledAt = fact.taskTrigger === "schedule" ? fact.scheduledAt : undefined;
  return {
    sessionId: fact.sessionId,
    sourceCommandId: fact.sourceCommandId,
    sendTime: fact.occurredAt,
    extraDetail: {
      message_source: "scheduled_task",
      task_trigger: fact.taskTrigger,
      automation_id: fact.automationId,
      ...(scheduledAt !== undefined
        ? {
            scheduled_at: String(scheduledAt),
            schedule_lag_ms: String(Math.max(0, fact.occurredAt - scheduledAt)),
          }
        : {}),
    },
  };
}

/**
 * 冻结到每条 agent_step 的来源字段（与 completion 同值）。只挑来源归因字段：seed 里的模型/套餐
 * 维度不属于 step 契约，scheduled_at / schedule_lag_ms 描述整次运行、只随 completion 上报。
 */
const STEP_SOURCE_DETAIL_KEYS = [
  "ui_mode",
  "memory_enabled",
  "message_source",
  // 用户发送方式（normal / edit），编辑重发轮的每条 step 都要能单独筛出。
  "send_type",
  "task_trigger",
  "automation_id",
  "off_peak_task_id",
  "off_peak_run_type",
] as const;

function stepSourceDetailOf(extraDetail: Record<string, string>): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const key of STEP_SOURCE_DETAIL_KEYS) {
    const value = extraDetail[key];
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}

interface PromptLifecycle {
  sessionId: string;
  sourceCommandId: string;
  taskKey: string;
  sendTime: number;
  foregroundFirstTokenAt: number | null;
  legacyFirstTokenObserved: boolean;
  turnId?: string;
  active: boolean;
  lastErrorMessage?: string;
  completionMessageSource?: PromptMessageSource;
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  /** 本轮消费过 dynamic-workflow run 的通知（agent_composition 的 wf 维度）。 */
  hasWorkflowResult: boolean;
  startedToolCallIds: Set<string>;
  stepSourceDetail: Record<string, string>;
}

interface BufferedFact {
  fact: ConversationTelemetryInput;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

interface ForegroundSubagentUsage {
  agentId: string;
  parentCommandId: string;
  parentToolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  usage: ZCodeUsage | null;
  stopped: boolean;
  pendingFinalizedSteps: PendingFinalizedStep[];
}

/**
 * 一个 detached 子会话的埋点账本。两种来源共用：
 * - `background`：Agent 工具的后台子代理，登记自 `subagent.lifecycle`，终态是子会话自己的
 *   `turn.terminal` 或 `subagent.lifecycle(stopped)`；
 * - `workflow`：动态工作流子代理，登记自 `workflow.lifecycle(actor-spawned)`，终态**只有**
 *   `workflow.lifecycle(run-settled)`——子会话的每次 turn.terminal 只是一次 ask 的结束。
 */
interface BackgroundSubagentTelemetry {
  kind: "background" | "workflow";
  /** 仅 workflow：所属 run（终态汇总 step 的 tool_call_id 用它收尾）。 */
  runId?: string;
  parentSessionId: string;
  sourceCommandId: string;
  parentToolCallId: string;
  childSessionId: string;
  agentId: string;
  taskKey: string;
  stepSourceDetail: Record<string, string>;
  startedToolCallIds: Set<string>;
  usageReported: boolean;
  openToolCallIds: Set<string>;
  startedAt: number;
  requestIds: string[];
  requestCount: number;
  usage: ZCodeUsage | null;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

type FinalizedAgentStep = ReturnType<typeof recordAgentStepTelemetryEvent>[number];

interface PendingFinalizedStep {
  step: FinalizedAgentStep;
  extraDetail?: Record<string, string>;
}

interface DeferredTerminal {
  lifecycle: PromptLifecycle;
  fact: Extract<ConversationTelemetryInput, { kind: "turn.terminal" }>;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

export interface ConversationTelemetryWorkspaceDetail {
  workspace_kind: "local" | "remote";
  remote_kind: RemoteWorkspaceIdentityKind | "";
}

class BoundedKeySet {
  private readonly keys = new Set<string>();

  remember(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    if (this.keys.size > MAX_DEDUPE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") {
        this.keys.delete(oldest);
      }
    }
    return true;
  }

  clear(): void {
    this.keys.clear();
  }
}

function toLegacyNetworkEvent(
  fact: Extract<ConversationTelemetryInput, { kind: "model.request.status" }>,
): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> {
  return {
    type: "task_network_debug_status",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(fact.sourceCommandId ? { inputId: fact.sourceCommandId } : {}),
    ...(fact.queryId ? { queryId: fact.queryId } : {}),
    eventKey: fact.eventId,
    eventId: fact.eventId,
    statusType: fact.status,
    requestId: fact.requestId,
    providerId: fact.providerId,
    modelId: fact.modelId,
    providerKind: fact.providerKind,
    transport: fact.transport,
    // messageTelemetry 的旧入口只接受 baseURL；fact 已提前裁成 hostname，重新包装不扩大隐私面。
    baseURL: fact.providerHostname ? `https://${fact.providerHostname}` : undefined,
    querySource: fact.querySource,
    attempt: fact.attempt,
    maxAttempts: fact.maxAttempts,
    nextAttempt: fact.nextAttempt,
    retryable: fact.retryable,
    statusCode: fact.statusCode,
    durationMs: fact.durationMs,
    delayMs: fact.delayMs,
    idleMs: fact.idleMs,
    timeoutMs: fact.timeoutMs,
    reason: fact.reason,
    requestHeaders: {},
    responseHeaders: {},
    requestHeaderCount: 0,
    responseHeaderCount: 0,
  } as Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>;
}

function scopedSubagentToolCallId(agentId: string, childToolCallId: string): string {
  return `tool_subagent_${agentId}_${childToolCallId}`;
}

/** detached 子会话的 step 用来源前缀区分：Agent 工具子代理 `tool_subagent_`，工作流子代理 `tool_workflow_`。 */
function scopedChildToolCallId(
  child: BackgroundSubagentTelemetry,
  childToolCallId: string,
): string {
  return child.kind === "workflow"
    ? `tool_workflow_${child.agentId}_${childToolCallId}`
    : scopedSubagentToolCallId(child.agentId, childToolCallId);
}

/** 终态汇总 step 的收尾 id：后台子代理是父 Agent 工具调用，工作流子代理是 run。 */
function terminalToolCallIdOf(child: BackgroundSubagentTelemetry): string {
  return child.kind === "workflow"
    ? (child.runId ?? child.parentToolCallId)
    : child.parentToolCallId;
}

function childAgentRole(child: BackgroundSubagentTelemetry): AgentStepRole {
  return child.kind === "workflow" ? "workflow subagent" : "background subagent";
}

/** step 上的归属字段。 */
function childStepExtraDetail(child: BackgroundSubagentTelemetry): Record<string, string> {
  if (child.kind === "workflow") {
    return {
      child_session_id: child.childSessionId,
      ...(child.runId === undefined ? {} : { workflow_run_id: child.runId }),
      ...(child.parentToolCallId === "" ? {} : { workflow_tool_call_id: child.parentToolCallId }),
    };
  }
  return {
    child_session_id: child.childSessionId,
    parent_tool_call_id: child.parentToolCallId,
  };
}

/** detached 子会话终态汇总的输入：谁触发（eventId）、成败、错误原文和错误码。 */
interface DetachedChildTerminalOutcome {
  eventId: string;
  success: boolean;
  errorMessage?: string;
  errorCode?: string;
}

function terminalOutcomeOf(
  fact: Extract<ConversationTelemetryInput, { kind: "turn.terminal" | "subagent.lifecycle" }>,
): DetachedChildTerminalOutcome {
  const errorCode = fact.kind === "turn.terminal" ? fact.errorCode : undefined;
  const errorMessage = fact.errorMessage ?? errorCode;
  return {
    eventId: fact.eventId,
    success: fact.status === "success" || fact.status === "completed",
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function toToolLifecycleEvent(input: {
  fact: Extract<ConversationTelemetryInput, { kind: "tool.lifecycle" }>;
  toolId: string;
  inputId?: string;
  hasStarted: boolean;
}): ZCodeStreamEvent {
  const { fact } = input;
  const skillMetadata =
    fact.skillName || fact.skillQualifiedName || fact.skillPluginId || fact.skillSource
      ? {
          // 旧 CLI 的 scheduled 名称来自任意请求；只接受带解析来源的终态名称。
          ...(fact.skillName &&
          fact.skillSource &&
          (fact.phase === "completed" || fact.phase === "failed")
            ? { name: fact.skillName }
            : {}),
          ...(fact.skillQualifiedName ? { qualifiedName: fact.skillQualifiedName } : {}),
          ...(fact.skillPluginId ? { pluginId: fact.skillPluginId } : {}),
          ...(fact.skillSource ? { source: fact.skillSource } : {}),
        }
      : undefined;
  if (!input.hasStarted && fact.phase !== "completed" && fact.phase !== "failed") {
    return {
      type: "tool_call",
      taskId: fact.sessionId,
      traceId: fact.eventId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      toolId: input.toolId,
      parentToolUseId: fact.parentToolCallId,
      input: {},
      toolName: fact.toolName,
      kind: fact.toolName ?? "",
      title: "",
      raw: {},
      ...(skillMetadata ? { skillMetadata } : {}),
    } as Extract<ZCodeStreamEvent, { type: "tool_call" }>;
  }
  return {
    type: "tool_call_update",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    toolId: input.toolId,
    parentToolUseId: fact.parentToolCallId,
    status:
      fact.phase === "completed" ? "completed" : fact.phase === "failed" ? "failed" : "in_progress",
    toolName: fact.toolName,
    kind: fact.toolName,
    error: fact.errorMessage,
    ...(fact.errorCode ? { errorCode: fact.errorCode } : {}),
    raw: {},
    ...(skillMetadata ? { skillMetadata } : {}),
    ...(fact.pluginId
      ? { pluginMetadata: { pluginId: fact.pluginId, component: "mcp" as const } }
      : {}),
  } as Extract<ZCodeStreamEvent, { type: "tool_call_update" }>;
}

function toUsage(fact: Extract<ConversationTelemetryInput, { kind: "usage.delta" }>): ZCodeUsage {
  return {
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    totalTokens: fact.totalTokens,
    reasoningTokens: fact.reasoningTokens,
    cachedInputTokens: fact.cacheReadTokens,
    cachedWriteInputTokens: fact.cacheWriteTokens,
  };
}

function runtimeTelemetryModelName(providerId: string | undefined, modelId: string | undefined) {
  const provider = providerId?.trim() ?? "";
  const model = modelId?.trim() ?? "";
  if (!provider) return model;
  if (!model) return "";
  return model.includes("/") ? model : `${provider}/${model}`;
}

function mergeUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) return { ...right };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

function isToolTimeout(
  fact: Extract<ConversationTelemetryInput, { kind: "tool.lifecycle" }>,
): boolean {
  return fact.errorCode === "tool_timeout" || fact.performance?.timedOut === true;
}

function terminalStatus(
  status: Extract<ConversationTelemetryInput, { kind: "turn.terminal" }>["status"],
): "success" | "fail" | "user_interrupt" {
  if (status === "success") return "success";
  return status === "interrupted" ? "user_interrupt" : "fail";
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function createSendClickId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `send_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

/**
 * renderer workspace 级 live telemetry 状态机。
 *
 * 它不读取 rows/snapshot，也不跟随 pane lease 销毁；React 只负责 attachment 和
 * foreground 引用，所有高频 fact 都进入这个命令式对象，避免 streaming 触发渲染。
 */
export class ConversationTelemetryEngine {
  private readonly observer?: (
    name: ConversationTelemetryObservation,
    args: readonly unknown[],
  ) => void;
  private readonly reportEvent: (event: TelemetryEventPayload) => Promise<void>;
  private observe(name: ConversationTelemetryObservation, ...args: unknown[]): void {
    this.observer?.(name, args);
  }

  private readonly platform: TelemetryPlatform;
  private readonly workspaceTelemetryDetail: ConversationTelemetryWorkspaceDetail | null;
  private readonly workspaceScopeKey: string;
  private readonly now: () => number;
  private readonly eventIds = new BoundedKeySet();
  private readonly acceptedCommandIds = new BoundedKeySet();
  private readonly settledSendClickIds = new BoundedKeySet();
  private readonly terminalKeys = new BoundedKeySet();
  private readonly compactionKeys = new BoundedKeySet();
  private readonly foregroundOwnerSessions = new Map<object, string>();
  private readonly foregroundSessionCounts = new Map<string, number>();
  private readonly lifecyclesByCommandId = new Map<string, PromptLifecycle>();
  private readonly activeCommandBySessionId = new Map<string, string>();
  private readonly commandIdByTurnKey = new Map<string, string>();
  private readonly pendingFactsByCommandId = new Map<string, BufferedFact[]>();
  private readonly foregroundSubagentUsageByChildSession = new Map<
    string,
    ForegroundSubagentUsage
  >();
  /** 每个在飞 run 已登记的子代理会话（run-settled 时逐个结算）。 */
  private readonly workflowActorsByRun = new Map<string, Set<string>>();
  /**
   * 每个 run 在本窗口见过的子 agent（agentId 去重），供 workflow_run_result 的 actor_count。
   * 与上面的结算账本分开：账本在 run-settled 后清空、且同一子会话只建一次，这里要跨 resume 累计。
   */
  private readonly workflowActorIdsByRun = new Map<string, Set<string>>();
  private readonly backgroundSubagentTelemetryByChildSession = new Map<
    string,
    BackgroundSubagentTelemetry
  >();
  private readonly deferredTerminalsByCommandId = new Map<string, DeferredTerminal>();
  private readonly pendingSendRenderWaits = new Map<string, PendingSendRenderWait>();
  private reportTail: Promise<void> | null = null;
  private disposed = false;

  constructor(options: {
    platform: TelemetryPlatform;
    observer?: (name: ConversationTelemetryObservation, args: readonly unknown[]) => void;
    reportEvent: (event: TelemetryEventPayload) => Promise<void>;
    workspaceScopeKey: string;
    workspaceTelemetryDetail?: ConversationTelemetryWorkspaceDetail;
    now?: () => number;
  }) {
    this.platform = options.platform;
    this.observer = options.observer;
    this.reportEvent = options.reportEvent;
    this.workspaceTelemetryDetail = options.workspaceTelemetryDetail ?? null;
    this.workspaceScopeKey = options.workspaceScopeKey;
    this.now = options.now ?? Date.now;
  }

  recordComposerFocus(): void {
    if (this.disposed) return;
    recordComposerFocus(this.workspaceScopeKey, this.now());
  }

  recordComposerInputStart(): void {
    if (this.disposed) return;
    recordComposerInputStart(this.workspaceScopeKey, this.now());
  }

  resetComposerInputStart(): void {
    if (this.disposed) return;
    resetComposerInputStart(this.workspaceScopeKey);
  }

  recordComposerTextChange(nextText: string): void {
    if (this.disposed) return;
    recordComposerTextChange(this.workspaceScopeKey, nextText, this.now());
  }

  /**
   * 用户真实点击/聚焦输入框。程序性自动聚焦（新建任务、切会话、挂载回焦、上下文块移除后回焦）
   * 由 composer 侧拦截，不得进入本方法，否则「点击输入框」会被切会话动作污染。
   * 与 recordComposerFocus 是两条独立链路：后者只写时间戳喂 send_btn，本方法只负责上报。
   */
  recordComposerFocusClick(input: { sessionId: string | null }): void {
    if (this.disposed) return;
    this.observe("reportSendFunnelInputFocus", {
      sessionId: input.sessionId,
      focusTime: this.now(),
    });
  }

  /**
   * 用户点击发送键 / Enter 提交并通过发送门禁的瞬间。返回补齐 sendClickId 的 seed，
   * 调用方需把它一路带到落定处，保证 send_click 与 send_result 严格 1:1。
   * 队列二次确认复用既有 seed 时不得再调本方法（否则一次点击报两条）。
   */
  recordSendClick(input: {
    sessionId: string | null;
    seed: ConversationPromptTelemetrySeed;
    trigger: "button" | "shortcut";
  }): ConversationPromptTelemetrySeed {
    const sendClickId = input.seed.sendClickId ?? createSendClickId();
    if (this.disposed) return { ...input.seed, sendClickId };
    const seed: ConversationPromptTelemetrySeed = {
      ...input.seed,
      sendClickId,
      inputTiming:
        input.seed.inputTiming ??
        consumeComposerInputTiming(this.workspaceScopeKey, input.seed.sendTime),
    };
    this.observe("reportSendFunnelSendClick", {
      sessionId: input.sessionId,
      sendClickId: seed.sendClickId ?? "",
      sendTime: input.seed.sendTime,
      trigger: input.trigger,
      extraDetail: input.seed.extraDetail,
    });
    return seed;
  }

  /**
   * 发送落定（用户消息渲染完成、ACK 失败、产品 guard 拒绝、传输异常、等待渲染超时）。
   * 按 sendClickId first-wins 去重：ACK 与 catch 可能对同一次点击各调一次，只认最先到达的结果。
   */
  settleSendResult(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId?: string;
    status: "success" | "fail";
    ackStatus?: string;
    reasonCode?: ConversationSendFailureReason;
    /** 「点击发送 → 收到 ACK」那一段；未拿到 ACK 的失败路径不传。 */
    ackCostMs?: number;
    /** 覆盖端到端耗时；只有超时兜底会用（此时 now 已越过 30s 上限，需钉死在阈值上）。 */
    costMs?: number;
  }): void {
    if (this.disposed) return;
    const sendClickId = input.seed.sendClickId;
    // 后台自动任务的 seed 没有点击来源，落定不能伪造成用户发送。
    if (!sendClickId || !this.settledSendClickIds.remember(sendClickId)) return;
    this.observe("reportSendFunnelSendResult", {
      sessionId: input.sessionId,
      commandId: input.commandId,
      sendClickId,
      status: input.status,
      ackStatus: input.ackStatus,
      reasonCode: input.reasonCode,
      costMs: input.costMs ?? this.now() - input.seed.sendTime,
      ackCostMs: input.ackCostMs,
      queueConfirmed: input.seed.queueConfirmed === true,
      extraDetail: input.seed.extraDetail,
    });
  }

  /**
   * ACK 已 accepted/duplicate：命令被 Host 收下了，但用户消息还没画到屏幕上。
   * 登记待渲染并挂超时定时器，等 notifyUserInputRendered 或超时任一先到再落定。
   */
  awaitSendRender(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId: string;
    ackStatus: string;
  }): void {
    if (this.disposed) return;
    // 后台自动任务无点击来源；同一 commandId 重复登记时保留首次（含其定时器）。
    if (!input.seed.sendClickId) return;
    if (this.pendingSendRenderWaits.has(input.commandId)) return;
    const ackCostMs = Math.max(0, this.now() - input.seed.sendTime);
    // 超时口径从点击发送起算，故剩余时长要扣掉已经花在 ACK 上的那一段。
    const remainingMs = Math.max(0, SEND_RENDER_WAIT_TIMEOUT_MS - ackCostMs);
    const timer = setTimeout(() => {
      const wait = this.pendingSendRenderWaits.get(input.commandId);
      if (!wait) return;
      this.pendingSendRenderWaits.delete(input.commandId);
      this.settleSendResult({
        seed: wait.seed,
        sessionId: wait.sessionId,
        commandId: input.commandId,
        status: "fail",
        ackStatus: wait.ackStatus,
        reasonCode: "render_timeout",
        ackCostMs: wait.ackCostMs,
        costMs: SEND_RENDER_WAIT_TIMEOUT_MS,
      });
    }, remainingMs);
    this.pendingSendRenderWaits.set(input.commandId, {
      seed: input.seed,
      sessionId: input.sessionId,
      ackStatus: input.ackStatus,
      ackCostMs,
      timer,
    });
  }

  /**
   * 是否还有发送在等用户消息渲染。没有时 notifyUserInputRendered 对任何 commandId 都是空操作，
   * 调用方可以跳过逐行扫描（长会话里每个流式帧都扫描全部历史行）。
   */
  hasPendingSendRenders(): boolean {
    return !this.disposed && this.pendingSendRenderWaits.size > 0;
  }

  /**
   * 用户消息已渲染进对话历史（投影回流出 userInput row，且 React 完成 commit）。
   * 没登记过的 commandId 直接忽略——历史消息回填、切会话重载都会推一堆 row 过来。
   */
  notifyUserInputRendered(commandId: string): void {
    if (this.disposed) return;
    const wait = this.pendingSendRenderWaits.get(commandId);
    if (!wait) return;
    this.pendingSendRenderWaits.delete(commandId);
    clearTimeout(wait.timer);
    this.settleSendResult({
      seed: wait.seed,
      sessionId: wait.sessionId,
      commandId,
      status: "success",
      ackStatus: wait.ackStatus,
      ackCostMs: wait.ackCostMs,
    });
  }

  /** ACK=accepted 后才建立 seed；duplicate/retry/promotion 不会重复上报 send_btn。 */
  acceptPromptSeed(
    seed: AcceptedConversationPromptTelemetrySeed,
    options: { reportSendButton?: boolean } = {},
  ): void {
    if (this.disposed || !this.acceptedCommandIds.remember(seed.sourceCommandId)) {
      return;
    }
    const taskKey = this.taskKey(seed.sessionId);
    const extraDetail = {
      ...seed.extraDetail,
      ui_mode: normalizeTelemetryUiMode(seed.extraDetail.ui_mode),
      memory_enabled: seed.memoryEnabled === undefined ? "" : seed.memoryEnabled ? "1" : "0",
    };
    const eventExtraDetail = queuePromptTelemetry({
      workspacePath: this.workspaceScopeKey,
      taskId: taskKey,
      messageId: seed.sourceCommandId,
      sendTime: seed.sendTime,
      inputTiming: seed.inputTiming,
      extraDetail,
    });
    this.lifecyclesByCommandId.set(seed.sourceCommandId, {
      sessionId: seed.sessionId,
      sourceCommandId: seed.sourceCommandId,
      taskKey,
      sendTime: seed.sendTime,
      foregroundFirstTokenAt: null,
      legacyFirstTokenObserved: false,
      active: false,
      completionMessageSource: seed.completionMessageSource,
      hasForegroundSubagentResult: false,
      hasBackgroundSubagentResult: false,
      hasWorkflowResult: false,
      startedToolCallIds: new Set(),
      stepSourceDetail: stepSourceDetailOf(extraDetail),
    });
    if (this.lifecyclesByCommandId.size > MAX_DEDUPE_KEYS) {
      const oldestInactive = [...this.lifecyclesByCommandId].find(
        ([commandId, lifecycle]) => commandId !== seed.sourceCommandId && !lifecycle.active,
      );
      if (oldestInactive) {
        this.lifecyclesByCommandId.delete(oldestInactive[0]);
        discardQueuedPromptTelemetry(oldestInactive[1].taskKey, oldestInactive[1].sourceCommandId);
      }
    }
    if (options.reportSendButton !== false) {
      this.enqueueReport({
        elementName: "send_btn",
        eventRegion: "app",
        eventType: "ck",
        eventExtraDetail,
        talkId: seed.sessionId,
        messageId: seed.sourceCommandId,
      });
    }
    this.drainPendingFacts(seed.sourceCommandId);
  }

  /** 同一 session 多 pane 可见仍只记一份 foreground；不同 session 可同时可见。 */
  attachForeground(owner: object, sessionId: string): () => void {
    if (this.disposed) return () => undefined;
    const previous = this.foregroundOwnerSessions.get(owner);
    if (previous === sessionId) return () => this.detachForeground(owner);
    if (previous) this.decrementForeground(previous);
    this.foregroundOwnerSessions.set(owner, sessionId);
    this.foregroundSessionCounts.set(
      sessionId,
      (this.foregroundSessionCounts.get(sessionId) ?? 0) + 1,
    );
    return () => this.detachForeground(owner);
  }

  handleFact(fact: ConversationTelemetryInput): void {
    // 主 session 与 detached child 的 eventId 都只保证各自 session 内唯一；
    // 若只按 eventId 去重，同号 child fact 会在 renderer 再次被主会话事实误杀。
    // 同源 started/admission、completed/metrics 可共用 eventId，独立通知不能互相去重。
    const channel =
      fact.kind === "turn.admission" || fact.kind === "model.request.metrics" ? fact.kind : "fact";
    const eventKey = `${channel}\0${fact.sessionId}\0${fact.eventId}`;
    if (this.disposed || !this.eventIds.remember(eventKey)) {
      return;
    }
    const receivedAt = this.now();
    const foregroundAtReceipt = this.isForeground(fact.sessionId);

    // plan_request 只依赖真实模型网络事实，可前后台上报，也不要求本地 prompt seed。
    if (fact.kind === "model.request.status") {
      this.observe(
        "reportPlanUsageModelRequestStartedToArms",
        this.platform,
        toLegacyNetworkEvent(fact),
      );
    }
    if (fact.kind === "subagent.lifecycle") {
      this.handleSubagentLifecycle(fact, receivedAt);
      return;
    }
    if (fact.kind === "workflow.lifecycle") {
      this.handleWorkflowLifecycle(fact, receivedAt);
      return;
    }
    const backgroundSubagent = this.backgroundSubagentTelemetryByChildSession.get(fact.sessionId);
    if (backgroundSubagent) {
      this.handleBackgroundSubagentFact(backgroundSubagent, fact, receivedAt);
      return;
    }
    if (this.shouldIgnoreBackgroundMirror(fact)) {
      return;
    }
    const foregroundSubagent = this.foregroundSubagentUsageByChildSession.get(fact.sessionId);
    if (foregroundSubagent) {
      this.handleForegroundSubagentFact(foregroundSubagent, fact);
      return;
    }
    if (fact.kind === "compaction.terminal") {
      this.handleCompaction(fact, foregroundAtReceipt);
      return;
    }
    if (fact.kind === "turn.started") {
      const backgroundSeed = backgroundSeedFromTurnStarted(fact);
      if (backgroundSeed) {
        // 原因：后台任务不经过 renderer ACK；用 Host admission 透传的无正文事实建 seed，
        // 但不能伪造只代表用户点击的 send_btn。
        this.acceptPromptSeed(
          { ...backgroundSeed, memoryEnabled: fact.memoryEnabled },
          { reportSendButton: false },
        );
      }
    }

    const commandId = this.resolveCommandId(fact);
    if (!commandId) {
      return;
    }
    const lifecycle = this.lifecyclesByCommandId.get(commandId);
    const blockedByDeferredTerminal =
      lifecycle !== undefined &&
      fact.kind === "turn.started" &&
      this.hasDeferredTerminalForTask(lifecycle.taskKey, lifecycle.sourceCommandId);
    if (
      !lifecycle ||
      blockedByDeferredTerminal ||
      (!lifecycle.active && fact.kind !== "turn.started")
    ) {
      this.bufferFact(commandId, { fact, receivedAt, foregroundAtReceipt });
      return;
    }
    this.processPromptFact(lifecycle, fact, receivedAt, foregroundAtReceipt);
    if (fact.kind === "turn.started") {
      this.drainPendingFacts(commandId);
    }
  }

  private handleSubagentLifecycle(
    fact: Extract<ConversationTelemetryInput, { kind: "subagent.lifecycle" }>,
    receivedAt: number,
  ): void {
    if (fact.phase === "spawned") {
      if (fact.background) {
        if (!fact.sourceCommandId || !fact.parentToolCallId) return;
        const parentLifecycle = this.lifecyclesByCommandId.get(fact.sourceCommandId);
        const child: BackgroundSubagentTelemetry = {
          kind: "background",
          parentSessionId: fact.sessionId,
          sourceCommandId: fact.sourceCommandId,
          parentToolCallId: fact.parentToolCallId,
          childSessionId: fact.childSessionId,
          agentId: fact.agentId,
          taskKey: this.taskKey(fact.childSessionId),
          // child 启动事实可能早于父消息 ACK；直接使用同源父会话事实，避免丢失开关。
          stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
            memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
          },
          startedToolCallIds: new Set(),
          usageReported: false,
          openToolCallIds: new Set(),
          startedAt: this.now(),
          requestIds: [],
          requestCount: 0,
          usage: null,
          modelName: "",
          modelProvider: "",
          providerName: "",
        };
        this.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
        activateDetachedAgentStepTelemetry({
          taskId: child.taskKey,
          messageId: child.sourceCommandId,
          sendTime: fact.occurredAt,
          extraDetail: child.stepSourceDetail,
        });
        return;
      }
      if (!fact.parentToolCallId) return;
      const parentCommandId = this.resolveCommandId(fact);
      if (!parentCommandId) return;
      const lifecycle = this.lifecyclesByCommandId.get(parentCommandId);
      if (!lifecycle?.active) return;
      const child: ForegroundSubagentUsage = {
        agentId: fact.agentId,
        parentCommandId,
        parentToolCallId: fact.parentToolCallId,
        requestIds: [],
        requestCount: 0,
        modelName: "",
        modelProvider: "",
        providerName: "",
        usage: null,
        stopped: false,
        pendingFinalizedSteps: [],
      };
      this.foregroundSubagentUsageByChildSession.set(fact.childSessionId, child);
      this.syncForegroundSubagentToolAttribution(child);
      return;
    }

    const backgroundChild = this.backgroundSubagentTelemetryByChildSession.get(fact.childSessionId);
    if (backgroundChild && fact.background) {
      this.reportBackgroundAgentUsage(backgroundChild, terminalOutcomeOf(fact), receivedAt);
      this.maybeCleanupBackgroundSubagentTelemetry(backgroundChild);
      return;
    }

    const child = this.foregroundSubagentUsageByChildSession.get(fact.childSessionId);
    if (!child) return;
    if (fact.background) {
      child.stopped = true;
      this.reportPendingForegroundSubagentSteps(child, false);
      this.flushDeferredTerminal(child.parentCommandId);
      return;
    }
    // mirror 与 lifecycle 分属不同 event stream，stopped 之后仍可能收到已发出的 child tool
    // 终态。保留映射到父 message 收口，保证迟到工具仍能取得 child model 与 agent_id。
    this.syncForegroundSubagentToolAttribution(child);
    child.stopped = true;
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (lifecycle) lifecycle.hasForegroundSubagentResult = true;
    this.reportPendingForegroundSubagentSteps(child);
    this.flushDeferredTerminal(child.parentCommandId);
  }

  private handleForegroundSubagentFact(
    child: ForegroundSubagentUsage,
    fact: ConversationTelemetryInput,
  ): void {
    if (fact.kind === "model.request.status") {
      if (fact.status !== "model_request_started") return;
      child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
      child.modelProvider = fact.providerId;
      child.providerName = fact.providerHostname ?? "";
      this.syncForegroundSubagentToolAttribution(child);
      return;
    }
    if (fact.kind !== "usage.delta") return;

    child.usage = mergeUsage(child.usage, toUsage(fact));
    child.requestCount += 1;
    if (fact.requestId && !child.requestIds.includes(fact.requestId)) {
      child.requestIds.push(fact.requestId);
    }
    // Subagent 的 runtime model 在一次同步 Agent 调用内固定；usage fact 的 request identity
    // 比 spawned 配置更接近真实 provider 请求，因此到达时覆盖前一请求的同源值。
    if (fact.providerId || fact.modelId) {
      child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
      child.modelProvider = fact.providerId ?? child.modelProvider;
      child.providerName = fact.providerHostname ?? child.providerName;
    }
    this.syncForegroundSubagentToolAttribution(child);
  }

  private syncForegroundSubagentToolAttribution(child: ForegroundSubagentUsage): void {
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (!lifecycle?.active) return;
    recordSubagentToolAttribution({
      taskId: lifecycle.taskKey,
      toolCallId: child.parentToolCallId,
      requestIds: child.requestIds,
      requestCount: child.requestCount,
      modelName: child.modelName,
      modelProvider: child.modelProvider,
      providerName: child.providerName,
      agentId: child.agentId,
      ...(child.usage ? { usage: child.usage } : {}),
    });
  }

  private handleBackgroundSubagentFact(
    child: BackgroundSubagentTelemetry,
    fact: ConversationTelemetryInput,
    receivedAt: number,
  ): void {
    switch (fact.kind) {
      case "model.request.status":
        if (child.usageReported) return;
        recordPromptModelRequestStarted(child.taskKey, toLegacyNetworkEvent(fact));
        if (fact.status === "model_request_started") {
          child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
          child.modelProvider = fact.providerId;
          child.providerName = fact.providerHostname ?? "";
        }
        return;
      case "usage.delta": {
        if (child.usageReported) return;
        if (fact.requestId && child.requestIds.includes(fact.requestId)) return;
        if (fact.requestId) child.requestIds.push(fact.requestId);
        child.requestCount += 1;
        child.usage = mergeUsage(child.usage, toUsage(fact));
        if (fact.providerId || fact.modelId) {
          child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
          child.modelProvider = fact.providerId ?? child.modelProvider;
          child.providerName = fact.providerHostname ?? child.providerName;
        }
        return;
      }
      case "stream.chunk":
        return;
      case "tool.lifecycle":
        this.handleBackgroundToolLifecycle(child, fact, receivedAt);
        return;
      case "permission.lifecycle": {
        if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
        const toolCallId = scopedChildToolCallId(child, fact.toolCallId);
        const requestId = fact.requestId ?? fact.toolCallId;
        if (fact.phase === "requested") {
          recordPromptPermissionRequest({
            taskId: child.taskKey,
            requestId,
            toolCallId,
            now: receivedAt,
          });
        } else {
          recordPromptPermissionResponse({
            taskId: child.taskKey,
            requestId,
            now: receivedAt,
          });
        }
        return;
      }
      case "turn.terminal":
        // 工作流子代理会话承接多次 ask，每次 ask 是一个 turn：这里的终态只是一次 ask 结束，
        // 汇总 step 等 run-settled。
        if (child.kind === "workflow") return;
        this.reportBackgroundAgentUsage(child, terminalOutcomeOf(fact), receivedAt);
        this.cleanupBackgroundSubagentTelemetry(child);
        return;
      case "turn.started":
      case "subagent.lifecycle":
      case "workflow.lifecycle":
      case "compaction.terminal":
        return;
    }
  }

  /**
   * 动态工作流子代理的登记与结算。与后台子代理共用同一本
   * detached 账本，差异只在登记事实、终态时机与 step 上的归属字段。
   */
  private handleWorkflowLifecycle(
    fact: Extract<ConversationTelemetryInput, { kind: "workflow.lifecycle" }>,
    receivedAt: number,
  ): void {
    if (fact.phase === "actor-spawned") {
      // 缺锚点（升级前的 run）或缺子会话身份：不猜测归属，不上报。
      if (!fact.sourceCommandId || !fact.childSessionId || !fact.agentId) return;
      this.rememberWorkflowActor(fact.runId, fact.agentId);
      // resume 会再发一遍 actor-created；同一子会话的账本只建一次。
      if (this.backgroundSubagentTelemetryByChildSession.has(fact.childSessionId)) return;
      const parentLifecycle = this.lifecyclesByCommandId.get(fact.sourceCommandId);
      const child: BackgroundSubagentTelemetry = {
        kind: "workflow",
        runId: fact.runId,
        parentSessionId: fact.sessionId,
        sourceCommandId: fact.sourceCommandId,
        parentToolCallId: fact.toolCallId ?? "",
        childSessionId: fact.childSessionId,
        agentId: fact.agentId,
        taskKey: this.taskKey(fact.childSessionId),
        // child 启动事实可能早于父消息 ACK；直接使用同源父会话事实，避免丢失开关。
        stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
          memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
        },
        startedToolCallIds: new Set(),
        usageReported: false,
        openToolCallIds: new Set(),
        startedAt: this.now(),
        requestIds: [],
        requestCount: 0,
        usage: null,
        modelName: "",
        modelProvider: "",
        providerName: "",
      };
      this.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
      const siblings = this.workflowActorsByRun.get(fact.runId) ?? new Set<string>();
      siblings.add(fact.childSessionId);
      this.workflowActorsByRun.set(fact.runId, siblings);
      activateDetachedAgentStepTelemetry({
        taskId: child.taskKey,
        messageId: child.sourceCommandId,
        sendTime: fact.occurredAt,
        extraDetail: child.stepSourceDetail,
      });
      return;
    }

    // run 结果每次结算都报（resume 同一 runId 会再结算），不依赖有没有子代理。
    this.enqueueReport(
      buildWorkflowRunResultTelemetryEvent({
        sessionId: fact.sessionId,
        ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
        runId: fact.runId,
        ...(fact.status === undefined ? {} : { status: fact.status }),
        ...(fact.stopReason === undefined ? {} : { stopReason: fact.stopReason }),
        actorCount: this.workflowActorIdsByRun.get(fact.runId)?.size ?? 0,
      }),
    );

    // run-settled：该 run 全部子代理的终态。每个子代理一条汇总 step，然后排空迟到工具终态后清理。
    const actors = this.workflowActorsByRun.get(fact.runId);
    if (!actors) return;
    this.workflowActorsByRun.delete(fact.runId);
    for (const childSessionId of actors) {
      const child = this.backgroundSubagentTelemetryByChildSession.get(childSessionId);
      if (!child) continue;
      this.reportBackgroundAgentUsage(
        child,
        {
          eventId: fact.eventId,
          success: fact.status === "completed",
          ...(fact.errorMessage === undefined ? {} : { errorMessage: fact.errorMessage }),
        },
        receivedAt,
      );
      this.maybeCleanupBackgroundSubagentTelemetry(child);
    }
  }

  private rememberWorkflowActor(runId: string, agentId: string): void {
    const actors = this.workflowActorIdsByRun.get(runId);
    if (actors) {
      actors.add(agentId);
      return;
    }
    this.workflowActorIdsByRun.set(runId, new Set([agentId]));
    if (this.workflowActorIdsByRun.size > MAX_TRACKED_WORKFLOW_RUNS) {
      this.workflowActorIdsByRun.delete(this.workflowActorIdsByRun.keys().next().value!);
    }
  }

  private reportBackgroundAgentUsage(
    child: BackgroundSubagentTelemetry,
    outcome: DetachedChildTerminalOutcome,
    receivedAt: number,
  ): void {
    // Bug 根因：只等 child terminal 会漏掉准备阶段失败/取消；stopped 也必须结算。
    // 对齐 foreground 的已知 usage 快照：首个终态只报一次，后续不补算迟到 usage。
    if (child.usageReported) return;
    child.usageReported = true;
    // 无 usage 不代表调用未发生；真实终态仍上报，缺失 token 沿用 foreground builder 的零值。
    const toolId = scopedChildToolCallId(child, terminalToolCallIdOf(child));
    // Bug 根因：后台只报内部工具并丢弃 usage，缺少 foreground 外层 Agent 的 token owner。
    // 在 child 终态用共享 builder 结算一次；内部工具继续逐条上报，避免重复计算同一份 token。
    recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: {
        type: "tool_call",
        taskId: child.childSessionId,
        traceId: outcome.eventId,
        toolId,
        toolName: "Agent",
        kind: "Agent",
        input: {},
        title: "Agent",
        raw: {},
      },
      now: child.startedAt,
    });
    recordSubagentToolAttribution({
      taskId: child.taskKey,
      toolCallId: toolId,
      agentId: child.agentId,
      agentRole: childAgentRole(child),
      requestIds: child.requestIds,
      requestCount: child.requestCount,
      modelName: child.modelName,
      modelProvider: child.modelProvider,
      providerName: child.providerName,
      ...(child.usage ? { usage: child.usage } : {}),
    });
    const finalized = recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: {
        type: "tool_call_update",
        taskId: child.childSessionId,
        traceId: outcome.eventId,
        toolId,
        toolName: "Agent",
        kind: "Agent",
        raw: {},
        status: outcome.success ? "completed" : "failed",
        error: outcome.errorMessage,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      },
      now: receivedAt,
    });
    this.reportBackgroundFinalizedSteps(child, finalized, childStepExtraDetail(child));
  }

  private handleBackgroundToolLifecycle(
    child: BackgroundSubagentTelemetry,
    fact: Extract<ConversationTelemetryInput, { kind: "tool.lifecycle" }>,
    receivedAt: number,
  ): void {
    // stopped 后仅排空已经开始的工具，避免重放/迟到事件重新创建已收口的 step。
    if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
    const hasStarted = child.startedToolCallIds.has(fact.toolCallId);
    child.startedToolCallIds.add(fact.toolCallId);
    const isTerminal = fact.phase === "completed" || fact.phase === "failed";
    if (isTerminal) {
      child.openToolCallIds.delete(fact.toolCallId);
    } else {
      child.openToolCallIds.add(fact.toolCallId);
    }
    const finalized = recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: toToolLifecycleEvent({
        fact,
        toolId: scopedChildToolCallId(child, fact.toolCallId),
        hasStarted,
      }),
      clientMode: "desktop-continuous",
      toolAttribution: {
        agentId: child.agentId,
        agentRole: childAgentRole(child),
      },
      now: receivedAt,
    });
    const extraDetail = {
      ...childStepExtraDetail(child),
      ...(fact.automationId ? { automation_id: fact.automationId } : {}),
    };
    this.reportBackgroundFinalizedSteps(child, finalized, extraDetail);
    if (isTerminal) this.maybeCleanupBackgroundSubagentTelemetry(child);
  }

  private reportBackgroundFinalizedSteps(
    child: BackgroundSubagentTelemetry,
    finalized: ReturnType<typeof recordAgentStepTelemetryEvent>,
    extraDetail: Record<string, string>,
  ): void {
    for (const step of finalized) {
      this.enqueueReport({
        elementName: "agent_step",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: this.withWorkspaceTelemetryDetail({
          ...child.stepSourceDetail,
          ...step.eventExtraDetail,
          ...extraDetail,
        }),
        talkId: child.parentSessionId,
        messageId: child.sourceCommandId,
      });
    }
  }

  private cleanupBackgroundSubagentTelemetry(child: BackgroundSubagentTelemetry): void {
    discardPromptTelemetry(child.taskKey);
    this.backgroundSubagentTelemetryByChildSession.delete(child.childSessionId);
  }

  private maybeCleanupBackgroundSubagentTelemetry(child: BackgroundSubagentTelemetry): void {
    // 汇总上报与工具排空分开：stopped 不再丢汇总，也不丢已开始工具的迟到终态。
    if (child.usageReported && child.openToolCallIds.size === 0) {
      this.cleanupBackgroundSubagentTelemetry(child);
    }
  }

  private reportPendingForegroundSubagentSteps(
    child: ForegroundSubagentUsage,
    applyAttribution = true,
  ): void {
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (!lifecycle?.active) return;
    for (const pending of child.pendingFinalizedSteps.splice(0)) {
      if (applyAttribution) this.applyForegroundSubagentAttribution(pending.step, child);
      this.reportFinalizedSteps(lifecycle, [pending.step], pending.extraDetail);
    }
  }

  private applyForegroundSubagentAttribution(
    step: FinalizedAgentStep,
    child: ForegroundSubagentUsage,
  ): void {
    const detail = step.eventExtraDetail;
    detail.agent_id = child.agentId;
    if (child.modelName || child.modelProvider || child.providerName) {
      detail.model_name = legacyTelemetryModelValue(child.modelName);
      detail.model_provider = legacyTelemetryProviderId(child.modelProvider);
      detail.provider_name = child.providerName;
    }
    if (!child.usage) return;
    detail.model_request_id = child.requestIds.length === 1 ? (child.requestIds[0] ?? "") : "";
    detail.model_request_count = String(child.requestCount);
    detail.token_usage_scope = "subagent_requests";
    detail.input_tokens = String(child.usage.inputTokens);
    detail.output_tokens = String(child.usage.outputTokens);
    detail.reasoning_tokens = String(child.usage.reasoningTokens ?? 0);
    detail.cached_tokens = String(child.usage.cachedInputTokens ?? 0);
    detail.cache_write_input_tokens = String(child.usage.cachedWriteInputTokens ?? 0);
    detail.total_tokens = String(child.usage.totalTokens);
  }

  private flushDeferredTerminal(commandId: string): void {
    const deferred = this.deferredTerminalsByCommandId.get(commandId);
    if (
      !deferred ||
      [...this.foregroundSubagentUsageByChildSession.values()].some(
        (child) => child.parentCommandId === commandId && !child.stopped,
      )
    ) {
      return;
    }
    this.deferredTerminalsByCommandId.delete(commandId);
    this.handleTerminal(
      deferred.lifecycle,
      deferred.fact,
      deferred.receivedAt,
      deferred.foregroundAtReceipt,
    );
  }

  /** 仅供有界缓存单测观察；业务逻辑不依赖此值。 */
  getPendingCommandCountForTest(): number {
    return this.pendingFactsByCommandId.size;
  }

  /** 仅供 focused tests 等待串行 reporter 清空。 */
  async flushReportsForTest(): Promise<void> {
    await this.reportTail;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lifecycle of this.lifecyclesByCommandId.values()) {
      this.observe("clearStreamStallTracking", lifecycle.taskKey);
      discardPromptTelemetry(lifecycle.taskKey);
    }
    for (const child of this.backgroundSubagentTelemetryByChildSession.values()) {
      discardPromptTelemetry(child.taskKey);
    }
    // 待渲染的定时器不清会在卸载后继续跑，落定一批没有意义的 render_timeout。
    for (const wait of this.pendingSendRenderWaits.values()) {
      clearTimeout(wait.timer);
    }
    this.pendingSendRenderWaits.clear();
    this.eventIds.clear();
    this.acceptedCommandIds.clear();
    this.settledSendClickIds.clear();
    this.terminalKeys.clear();
    this.compactionKeys.clear();
    this.foregroundSubagentUsageByChildSession.clear();
    this.backgroundSubagentTelemetryByChildSession.clear();
    this.workflowActorsByRun.clear();
    this.workflowActorIdsByRun.clear();
    this.deferredTerminalsByCommandId.clear();
    this.foregroundOwnerSessions.clear();
    this.foregroundSessionCounts.clear();
    this.lifecyclesByCommandId.clear();
    this.activeCommandBySessionId.clear();
    this.commandIdByTurnKey.clear();
    this.pendingFactsByCommandId.clear();
  }

  private enqueueReport(payload: TelemetryEventPayload): void {
    const report = () => this.reportEvent(payload).catch(() => undefined);
    // 修复原因：renderer 发起顺序虽然是 step → completion，但两个异步 IPC 会在 main
    // 并发执行，最终 net.fetch 偶发反序。workspace supervisor 内串行化最终 reporter，
    // 同时保持第一条立即发起，避免额外推迟 send_btn。
    const queued = this.reportTail ? this.reportTail.then(report) : report();
    this.reportTail = queued;
    void queued.then(() => {
      if (this.reportTail === queued) this.reportTail = null;
    });
  }

  private withWorkspaceTelemetryDetail(detail: Record<string, string>): Record<string, string> {
    return this.workspaceTelemetryDetail ? { ...detail, ...this.workspaceTelemetryDetail } : detail;
  }

  private taskKey(sessionId: string): string {
    return `${this.workspaceScopeKey}\u0000${sessionId}`;
  }

  private isForeground(sessionId: string): boolean {
    return (this.foregroundSessionCounts.get(sessionId) ?? 0) > 0;
  }

  private shouldIgnoreBackgroundMirror(fact: ConversationTelemetryInput): boolean {
    if (fact.kind !== "tool.lifecycle" && fact.kind !== "permission.lifecycle") return false;
    return (
      fact.background === true &&
      (!fact.childSessionId || !this.foregroundSubagentUsageByChildSession.has(fact.childSessionId))
    );
  }

  private detachForeground(owner: object): void {
    const sessionId = this.foregroundOwnerSessions.get(owner);
    if (!sessionId) return;
    this.foregroundOwnerSessions.delete(owner);
    this.decrementForeground(sessionId);
  }

  private decrementForeground(sessionId: string): void {
    const next = (this.foregroundSessionCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) {
      this.foregroundSessionCounts.set(sessionId, next);
      return;
    }
    this.foregroundSessionCounts.delete(sessionId);
    // 切走期间的墙钟时间不能被下一次回前台误判为 stream stall。
    this.observe("clearStreamStallTracking", this.taskKey(sessionId));
  }

  private resolveCommandId(fact: ConversationTelemetryInput): string | undefined {
    if (fact.sourceCommandId) return fact.sourceCommandId;
    return fact.turnId
      ? this.commandIdByTurnKey.get(`${fact.sessionId}\u0000${fact.turnId}`)
      : this.activeCommandBySessionId.get(fact.sessionId);
  }

  private bufferFact(commandId: string, buffered: BufferedFact): void {
    const current = this.pendingFactsByCommandId.get(commandId) ?? [];
    current.push(buffered);
    if (current.length > MAX_BUFFERED_FACTS_PER_COMMAND) {
      // ACK 极慢时只优先裁普通后续 chunk；turn.started、firstChunk、真实模型状态、工具和
      // terminal 都是旧指标的生命周期锚，不能被高频正文挤掉。
      const ordinaryChunkIndex = current.findIndex(
        (item) => item.fact.kind === "stream.chunk" && !item.fact.firstChunk,
      );
      const removableIndex =
        ordinaryChunkIndex >= 0
          ? ordinaryChunkIndex
          : current.findIndex((item) => item.fact.kind !== "turn.started");
      current.splice(removableIndex >= 0 ? removableIndex : 0, 1);
    }
    // Map 的插入顺序即 LRU：命中 command 时先删除再写回，保证最久未收到事实的整组先淘汰。
    this.pendingFactsByCommandId.delete(commandId);
    this.pendingFactsByCommandId.set(commandId, current);
    if (this.pendingFactsByCommandId.size > MAX_BUFFERED_COMMANDS) {
      const oldestCommandId = this.pendingFactsByCommandId.keys().next().value;
      if (typeof oldestCommandId === "string") {
        this.pendingFactsByCommandId.delete(oldestCommandId);
      }
    }
  }

  private drainPendingFacts(commandId: string): void {
    const lifecycle = this.lifecyclesByCommandId.get(commandId);
    const pending = this.pendingFactsByCommandId.get(commandId);
    if (!lifecycle || !pending || pending.length === 0) return;
    this.pendingFactsByCommandId.delete(commandId);
    for (const item of pending) {
      if (!this.lifecyclesByCommandId.has(commandId)) return;
      if (
        item.fact.kind === "turn.started" &&
        this.hasDeferredTerminalForTask(lifecycle.taskKey, lifecycle.sourceCommandId)
      ) {
        this.bufferFact(commandId, item);
        continue;
      }
      if (!lifecycle.active && item.fact.kind !== "turn.started") {
        this.bufferFact(commandId, item);
        continue;
      }
      this.processPromptFact(lifecycle, item.fact, item.receivedAt, item.foregroundAtReceipt);
    }
  }

  private hasDeferredTerminalForTask(taskKey: string, exceptCommandId?: string): boolean {
    return [...this.deferredTerminalsByCommandId].some(
      ([commandId, deferred]) =>
        commandId !== exceptCommandId && deferred.lifecycle.taskKey === taskKey,
    );
  }

  private drainPromptBlockedByDeferredTerminal(taskKey: string): void {
    if (this.hasDeferredTerminalForTask(taskKey)) return;
    const nextLifecycle = [...this.lifecyclesByCommandId.values()]
      .filter(
        (candidate) =>
          candidate.taskKey === taskKey &&
          !candidate.active &&
          this.pendingFactsByCommandId
            .get(candidate.sourceCommandId)
            ?.some((item) => item.fact.kind === "turn.started"),
      )
      .sort((left, right) => left.sendTime - right.sendTime)[0];
    if (nextLifecycle) this.drainPendingFacts(nextLifecycle.sourceCommandId);
  }

  private processPromptFact(
    lifecycle: PromptLifecycle,
    fact: ConversationTelemetryInput,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    switch (fact.kind) {
      case "turn.started":
        lifecycle.active = true;
        lifecycle.turnId = fact.turnId;
        this.activeCommandBySessionId.set(fact.sessionId, lifecycle.sourceCommandId);
        if (fact.turnId) {
          this.commandIdByTurnKey.set(
            `${fact.sessionId}\u0000${fact.turnId}`,
            lifecycle.sourceCommandId,
          );
        }
        activatePromptTelemetry(lifecycle.taskKey, lifecycle.sourceCommandId);
        return;

      case "turn.admission":
        recordPromptAdmissionTelemetry(lifecycle.taskKey, fact);
        return;
      case "model.request.metrics":
        if (!fact.querySource || fact.querySource === "main_turn")
          recordPromptRequestMetrics({
            taskId: lifecycle.taskKey,
            requestId: fact.requestId,
            inputTokens: fact.inputTokens,
            cacheReadTokens: fact.cacheReadTokens,
          });
        return;

      case "model.request.status": {
        const legacyEvent = toLegacyNetworkEvent(fact);
        recordPromptModelRequestStarted(lifecycle.taskKey, legacyEvent, lifecycle.sourceCommandId);
        if (fact.status === "model_request_failed") {
          lifecycle.lastErrorMessage = fact.reason;
        }
        return;
      }

      case "stream.chunk": {
        lifecycle.legacyFirstTokenObserved = true;
        if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
          lifecycle.foregroundFirstTokenAt = receivedAt;
        }
        const legacyEvent = {
          type: fact.channel === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
          taskId: fact.sessionId,
          traceId: fact.eventId,
          inputId: lifecycle.sourceCommandId,
          content: "",
          ...(fact.channel === "text" && fact.assistantMessageId
            ? { messageId: fact.assistantMessageId }
            : {}),
          ...(fact.parentToolCallId ? { parentToolUseId: fact.parentToolCallId } : {}),
        } as Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" | "agent_message_chunk" }>;
        this.reportFinalizedSteps(
          lifecycle,
          recordAgentStepTelemetryEvent({
            taskId: lifecycle.taskKey,
            event: legacyEvent,
            activeInputId: lifecycle.sourceCommandId,
            clientMode: "desktop-continuous",
            now: receivedAt,
          }),
        );
        if (foregroundAtReceipt) {
          this.observe("recordStreamChunkArrival", lifecycle.taskKey, {
            now: receivedAt,
            talkId: fact.sessionId,
            waitingTool: false,
            model: getActivePromptModelName(lifecycle.taskKey),
            messageId: fact.assistantMessageId,
            chunkType: fact.channel === "thought" ? "thought" : "message",
          });
        }
        return;
      }

      case "tool.lifecycle":
        this.handleToolLifecycle(lifecycle, fact, receivedAt, foregroundAtReceipt);
        return;

      case "permission.lifecycle": {
        const requestId = fact.requestId ?? fact.toolCallId;
        if (fact.phase === "requested") {
          recordPromptPermissionRequest({
            taskId: lifecycle.taskKey,
            requestId,
            toolCallId: fact.toolCallId,
            now: receivedAt,
          });
        } else {
          recordPromptPermissionResponse({
            taskId: lifecycle.taskKey,
            requestId,
            now: receivedAt,
          });
        }
        return;
      }

      case "usage.delta":
        recordPromptTokenUsageDelta({
          taskId: lifecycle.taskKey,
          eventKey: fact.eventId,
          usage: toUsage(fact),
          requestId: fact.requestId,
          modelName: runtimeTelemetryModelName(fact.providerId, fact.modelId),
          modelProvider: fact.providerId,
          providerName: fact.providerHostname,
        });
        return;

      case "turn.terminal":
        // active-loop 没有独立 TurnStarted；消费事实随终态到达后再更新本轮 composition。
        if (fact.backgroundSubagentResultConsumed) {
          lifecycle.hasBackgroundSubagentResult = true;
        }
        if (fact.workflowResultConsumed) {
          lifecycle.hasWorkflowResult = true;
        }
        this.handleTerminal(lifecycle, fact, receivedAt, foregroundAtReceipt);
        return;

      case "compaction.terminal":
      case "workflow.lifecycle":
        return;
    }
  }

  private handleToolLifecycle(
    lifecycle: PromptLifecycle,
    fact: Extract<ConversationTelemetryInput, { kind: "tool.lifecycle" }>,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    lifecycle.legacyFirstTokenObserved = true;
    if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
      lifecycle.foregroundFirstTokenAt = receivedAt;
    }
    this.observe("clearStreamStallTracking", lifecycle.taskKey);
    const child =
      fact.childSessionId !== undefined
        ? this.foregroundSubagentUsageByChildSession.get(fact.childSessionId)
        : undefined;
    const agentId = fact.agentId ?? child?.agentId;
    const toolAttribution =
      agentId || child
        ? {
            ...(agentId ? { agentId } : {}),
            ...(child?.modelName ? { modelName: child.modelName } : {}),
            ...(child?.modelProvider ? { modelProvider: child.modelProvider } : {}),
            ...(child?.providerName ? { providerName: child.providerName } : {}),
          }
        : undefined;
    const hasStarted = lifecycle.startedToolCallIds.has(fact.toolCallId);
    lifecycle.startedToolCallIds.add(fact.toolCallId);
    const event = toToolLifecycleEvent({
      fact,
      toolId: fact.toolCallId,
      inputId: lifecycle.sourceCommandId,
      hasStarted,
    });
    const finalized = recordAgentStepTelemetryEvent({
      taskId: lifecycle.taskKey,
      event,
      activeInputId: lifecycle.sourceCommandId,
      clientMode: "desktop-continuous",
      ...(toolAttribution ? { toolAttribution } : {}),
      now: receivedAt,
    });
    const extraDetail = fact.automationId ? { automation_id: fact.automationId } : undefined;
    const isTerminal = fact.phase === "completed" || fact.phase === "failed";
    const foregroundChild = isTerminal
      ? [...this.foregroundSubagentUsageByChildSession.values()].find(
          (candidate) =>
            candidate.parentCommandId === lifecycle.sourceCommandId &&
            candidate.parentToolCallId === fact.toolCallId,
        )
      : undefined;
    if (foregroundChild && !foregroundChild.stopped) {
      const timeoutWon = isToolTimeout(fact);
      const immediate: FinalizedAgentStep[] = [];
      for (const step of finalized) {
        if (step.eventExtraDetail.tool_call_id === fact.toolCallId) {
          if (timeoutWon) {
            this.applyForegroundSubagentAttribution(step, foregroundChild);
            immediate.push(step);
          } else {
            // Bug 根因：父 Agent 工具终态可能早于 child usage。非 timeout 终态继续冻结，
            // 等 Runtime 的 SubagentStopped 后以 child 最终累计值回填，避免丢 token。
            foregroundChild.pendingFinalizedSteps.push({ step, extraDetail });
          }
        } else {
          immediate.push(step);
        }
      }
      this.reportFinalizedSteps(lifecycle, immediate, extraDetail);
      if (timeoutWon) {
        // 外层 Agent timeout 是 Runtime 的真实终态；与 SubagentStopped 谁先到谁收口，
        // 不再额外等待 telemetry grace，迟到 stopped 只会命中已完成生命周期。
        foregroundChild.stopped = true;
        this.flushDeferredTerminal(foregroundChild.parentCommandId);
      }
    } else {
      this.reportFinalizedSteps(lifecycle, finalized, extraDetail);
    }
    if (fact.errorMessage) lifecycle.lastErrorMessage = fact.errorMessage;

    const performance = fact.performance;
    if (
      !foregroundAtReceipt ||
      !isTerminal ||
      !performance ||
      Object.keys(performance).length === 0
    ) {
      return;
    }
    this.observe("reportUiToolCallDetail", {
      toolName: fact.toolName,
      status: fact.phase === "completed" ? "completed" : "failed",
      talkId: fact.sessionId,
      messageId: getActivePromptMessageId(lifecycle.taskKey),
      toolCallId: fact.toolCallId,
      parentToolCallId: fact.parentToolCallId,
      childSessionId: fact.childSessionId,
      childToolCallId: fact.childToolCallId,
      agentId: fact.agentId,
      agentType: fact.agentType,
      totalMs: performance.totalMs ?? fact.durationMs,
      permissionWaitMs: performance.permissionWaitMs,
      commandRunMs: performance.commandRunMs,
      firstOutputMs: performance.firstOutputMs,
      noOutputMs: performance.noOutputMs,
      exitCode: performance.exitCode,
      timedOut: performance.timedOut,
      outputBytes: performance.outputBytes,
      commandCategory: performance.commandCategory,
      commandName: performance.commandName,
      commandCount: performance.commandCount,
      commandStatus: performance.commandStatus,
      fsReadMs: performance.fsReadMs,
      fsWriteMs: performance.fsWriteMs,
      patchMatchMs: performance.patchMatchMs,
      fileCount: performance.fileCount,
      totalBytes: performance.totalBytes,
      maxFileBytes: performance.maxFileBytes,
      hunkCount: performance.hunkCount,
      matchAttempts: performance.matchAttempts,
      workspaceKind: performance.workspaceKind,
    });
  }

  private handleTerminal(
    lifecycle: PromptLifecycle,
    fact: Extract<ConversationTelemetryInput, { kind: "turn.terminal" }>,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    const hasRunningForegroundChild = [...this.foregroundSubagentUsageByChildSession.values()].some(
      (child) => child.parentCommandId === lifecycle.sourceCommandId && !child.stopped,
    );
    if (hasRunningForegroundChild) {
      if (this.deferredTerminalsByCommandId.has(lifecycle.sourceCommandId)) return;
      // 同一 parent stream 正常顺序是 Agent tool terminal -> turn terminal。这里只处理
      // transport 反序：等待真实 SubagentStopped 或 Agent tool terminal，二者都能立即 flush。
      this.deferredTerminalsByCommandId.set(lifecycle.sourceCommandId, {
        lifecycle,
        fact,
        receivedAt,
        foregroundAtReceipt,
      });
      return;
    }
    const terminalKey = `${fact.sessionId}\u0000${lifecycle.sourceCommandId}\u0000message_completion`;
    if (!this.terminalKeys.remember(terminalKey)) return;
    const status = terminalStatus(fact.status);
    const terminalEvent = // 修复原因：旧 adapter 把所有 TurnComplete（包括 cancelled）先投影成
      // task_complete；UI 再单独把 completion 标成 user_interrupt。
      (
        fact.status === "success" || fact.resultType !== undefined
          ? {
              type: "task_complete",
              taskId: fact.sessionId,
              traceId: fact.eventId,
              inputId: lifecycle.sourceCommandId,
              stopReason: fact.resultType ?? "complete",
            }
          : {
              type: "task_error",
              taskId: fact.sessionId,
              traceId: fact.eventId,
              inputId: lifecycle.sourceCommandId,
              error: fact.errorMessage ?? lifecycle.lastErrorMessage ?? fact.errorCode ?? "",
              code: fact.errorCode,
            }
      ) as Extract<ZCodeStreamEvent, { type: "task_complete" | "task_error" }>;
    this.reportFinalizedSteps(
      lifecycle,
      recordAgentStepTelemetryEvent({
        taskId: lifecycle.taskKey,
        event: terminalEvent,
        activeInputId: lifecycle.sourceCommandId,
        clientMode: "desktop-continuous",
        now: receivedAt,
      }),
    );
    const completion = finalizePromptTelemetry({
      taskId: lifecycle.taskKey,
      status,
      finishedAt: receivedAt,
      errorType: fact.errorCode,
      errorMsg: fact.errorMessage ?? lifecycle.lastErrorMessage,
      ...(lifecycle.completionMessageSource
        ? { messageSource: lifecycle.completionMessageSource }
        : {}),
      agentComposition: composeAgentComposition(lifecycle),
    });
    if (completion) {
      this.enqueueReport({
        elementName: "message_completion",
        eventRegion: "app",
        eventType: "agent_trace",
        // 修复原因：workspace 场景维度必须和 completion/step 一起出现在最终 report，
        // 不能只停留在 attachment 的隔离 key，否则数仓无法区分本地与远程对话。
        eventExtraDetail: this.withWorkspaceTelemetryDetail(completion.eventExtraDetail),
        talkId: fact.sessionId,
        messageId: lifecycle.sourceCommandId,
      });
      if (foregroundAtReceipt) {
        this.reportCompletionArms(
          fact.sessionId,
          lifecycle.sourceCommandId,
          completion.eventExtraDetail,
          lifecycle.foregroundFirstTokenAt === null
            ? lifecycle.legacyFirstTokenObserved
              ? undefined
              : -1
            : lifecycle.foregroundFirstTokenAt - lifecycle.sendTime,
        );
      }
    }
    this.observe("clearStreamStallTracking", lifecycle.taskKey);
    this.deferredTerminalsByCommandId.delete(lifecycle.sourceCommandId);
    // finalize 已清当前 active；同 session 后续 queued seed 仍需等待 promotion，不能整 task 丢弃。
    this.activeCommandBySessionId.delete(fact.sessionId);
    this.lifecyclesByCommandId.delete(lifecycle.sourceCommandId);
    if (lifecycle.turnId) {
      this.commandIdByTurnKey.delete(`${fact.sessionId}\u0000${lifecycle.turnId}`);
    }
    for (const [childSessionId, child] of this.foregroundSubagentUsageByChildSession) {
      if (child.parentCommandId === lifecycle.sourceCommandId) {
        this.foregroundSubagentUsageByChildSession.delete(childSessionId);
      }
    }
    this.drainPromptBlockedByDeferredTerminal(lifecycle.taskKey);
  }

  private reportCompletionArms(
    sessionId: string,
    sourceCommandId: string,
    detail: Record<string, string>,
    foregroundTtftMs: number | undefined,
  ): void {
    if (foregroundTtftMs !== undefined) {
      this.observe("reportUiFirstToken", {
        ttftMs: foregroundTtftMs,
        model: detail.model_name || undefined,
        talkId: sessionId,
        messageId: sourceCommandId,
      });
      this.observe("reportPlanUsageTtftToArms", this.platform, {
        providerId: detail.model_provider,
        modelName: detail.model_name,
        askMode: detail.ask_mode,
        ttftMs: foregroundTtftMs,
      });
    }
    const durationMs = finiteNumber(detail.duration_ms);
    if (durationMs === undefined) return;
    this.observe("reportUiMessageComplete", {
      durationMs,
      result: detail.status ?? "",
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
    });
    this.observe("reportUiTurnBreakdown", {
      durationMs,
      result: detail.status ?? "",
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
      ttftMs: foregroundTtftMs,
      waitingMs: finiteNumber(detail.waiting_ms),
      toolCallTotal: finiteNumber(detail.tool_call_total),
      toolCallFailed: finiteNumber(detail.tool_call_failed),
      agentStepCount: finiteNumber(detail.agent_step_cnt),
      retryCount: finiteNumber(detail.retry_cnt),
      fileChangeCount: finiteNumber(detail.file_change_cnt),
      generatedCodeLines: finiteNumber(detail.generated_code_lines),
    });
  }

  private reportFinalizedSteps(
    lifecycle: PromptLifecycle,
    finalized: ReturnType<typeof recordAgentStepTelemetryEvent>,
    extraDetail?: Record<string, string>,
  ): void {
    for (const step of finalized) {
      this.enqueueReport({
        elementName: "agent_step",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: this.withWorkspaceTelemetryDetail({
          ...lifecycle.stepSourceDetail,
          ...step.eventExtraDetail,
          ...extraDetail,
        }),
        talkId: lifecycle.sessionId,
        messageId: lifecycle.sourceCommandId,
      });
    }
  }

  private handleCompaction(
    fact: Extract<ConversationTelemetryInput, { kind: "compaction.terminal" }>,
    foregroundAtReceipt: boolean,
  ): void {
    const dedupeKey = `${fact.sessionId}\u0000${fact.operationId}\u0000context_compaction`;
    if (!this.compactionKeys.remember(dedupeKey)) return;
    // compaction 只按 terminal 到达瞬间是否前台决定；后台到达后切回不能补报。
    if (!foregroundAtReceipt) return;
    const timeline: ZCodeContextCompactionTimelineMeta = {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: fact.operationId,
      status: fact.status,
      trigger: fact.trigger,
      display: "separator",
      reason: fact.reason,
      summaryMessageId: fact.summaryMessageId,
      preCompactTokenCount: fact.preCompactTokenCount,
      postCompactTokenCount: fact.postCompactTokenCount,
      truePostCompactTokenCount: fact.truePostCompactTokenCount,
      attempt: fact.attempt,
      maxAttempts: fact.maxAttempts,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
    };
    const eventExtraDetail = buildCompactionTelemetryExtraDetail({
      timeline,
      modelName: resolveLegacyRuntimeModelValue({
        configProvider: fact.modelProvider,
        modelName: fact.modelName,
      }),
      modelProvider: fact.modelProvider,
    });
    if (!eventExtraDetail) return;
    this.enqueueReport({
      elementName: "context_compaction",
      eventRegion: "app",
      eventType: "agent_trace",
      eventExtraDetail,
      talkId: fact.sessionId,
      messageId: fact.summaryMessageId ?? fact.operationId,
    });
  }
}

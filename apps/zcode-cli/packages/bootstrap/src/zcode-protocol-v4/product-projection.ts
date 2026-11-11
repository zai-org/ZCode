import { normalizeGenUiInput } from "@zcode/core";
import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import { pluginInstallRequestPayloadSchema } from "@zcode/shared/zcode-protocol-v4";
import type {
  AssistantFeedbackUpdatedPayload,
  HighspeedMetricsUpdatedPayload,
  CompactLifecyclePayload,
  DynamicWorkflowRunProgressPayload,
  HookRunLifecyclePayload,
  ModelCompletePayload,
  ModelNetworkStatusPayload,
  ModelSelectedPayload,
  TurnExecutionModelFallbackPayload,
  ModelStreamingPayload,
  ModelUsage,
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
  SessionEvent,
  SessionForkedPayload,
  WorktreeCreatedPayload,
  SessionInputPromotedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamingToolLedgerPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolResultDisplayPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnInputIntentMetadata,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerEditLockChangedPayload,
  TurnSteerQueuedPayload,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceMcpAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "@zcode/contracts";
import {
  DEFERRED_TOOL_CALL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  CoreErrorType,
  ModelErrorCode,
  SessionEventType,
  getModelUsageContextTokens,
} from "@zcode/contracts";
import {
  clearSettledOutputPreviews,
  projectToolActivity,
} from "./product-projection-bash-progress.js";
// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  isHighspeedProviderId,
  isZCodeFileStreamingToolInputPreviewTool,
  isZCodeModelRetryRecoveryProgressPayload,
  parseZCodeBackgroundTaskNotifications,
  resolveZCodeBackgroundTaskControlKind,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  type ZCodeParsedBackgroundTaskNotification,
} from "@zcode/shared";
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";
import type {
  ApiRetryState,
  AssistantTextRow,
  BackgroundWorkSummary,
  ConversationDelta,
  ConversationRow,
  ConversationRowTarget,
  ConversationSnapshot,
  CuaAppIdentity,
  GoalState,
  HookExecutionProjection,
  HookInvocationRow,
  MutableConversationSnapshotAccumulator,
  PendingInteraction,
  QueueItem,
  ReasoningRow,
  RowActions,
  RunningSubagentSummary,
  SessionControl,
  SessionUsageState,
  StatePatch,
  SubagentProjectionState,
  SubagentRow,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  ToolCallDisplay,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
  UserInputQuestionPayload,
  UserInputRow,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workspaceHookReviewRequestPayloadSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
} from "../permission-options.js";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  parseListAppsSnapshot,
  readOfficialCuaAction,
  resolveCuaAppIdentity,
} from "./cua-app-snapshot.js";
import {
  normalizeConversationEvent,
  type CanonicalAssistantSegmentFact,
  type CanonicalConversationFact,
  type CanonicalModelStream,
  type CanonicalOpenSegmentIdentity,
  type CanonicalUserIntentFact,
  type ConversationNormalizationDiagnostic,
} from "./event-normalizer.js";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";
import {
  buildToolOutput,
  buildTurnHeaderRow,
  mapCompactMarkerOrigin,
  mapCompactMarkerStatus,
  mapGoalStatus,
  mapTurnResultToHeaderState,
  userInputSubmittedConfig,
} from "./projection-rows.js";
import {
  HYDRATION_TRACE_ID,
  availabilityContextOf,
  computeAvailability,
  computeInputRouting,
  createInitialConversationSnapshot,
  deltaBumpsRevision,
} from "./projection-state.js";

type HookInvocationRowContent = Omit<
  HookInvocationRow,
  | "actions"
  | "createdAt"
  | "createdAtSeq"
  | "entityId"
  | "productTurnId"
  | "rowId"
  | "turnId"
  | "visibility"
>;

interface PendingSessionHookInvocation {
  firstEvent: SessionEvent;
  content: HookInvocationRowContent;
}

const HOOK_SCRIPT_RUNNERS = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "node.exe",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);
const USER_PROMPT_HOOK_BLOCK_ERROR_TYPE = "hooks_prompt_block";

function unquoteHookDisplayToken(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return token.slice(1, -1);
    }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  return token;
}

function hookCommandLabel(commandDisplay: string): string | undefined {
  const tokens = commandDisplay.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/gu) ?? [];
  const executableToken = tokens[0];
  if (!executableToken) return undefined;
  const executable = unquoteHookDisplayToken(executableToken).split(/[\\/]/u).at(-1);
  if (!executable) return undefined;
  const scriptToken = tokens[1];
  if (!HOOK_SCRIPT_RUNNERS.has(executable.toLowerCase()) || !scriptToken) return executable;
  const script = unquoteHookDisplayToken(scriptToken);
  if (!script || script.startsWith("-")) return executable;
  const scriptName = script.split(/[\\/]/u).at(-1);
  return scriptName ? `${executable} · ${scriptName}` : executable;
}

function hookExecutionDisplayName(
  descriptor: NonNullable<HookRunLifecyclePayload["descriptor"]>,
  hookIndex: number,
): string {
  const executable = hookCommandLabel(descriptor.commandDisplay);
  return (
    descriptor.statusMessage?.trim() ||
    (descriptor.pluginName && executable
      ? `${descriptor.pluginName} · ${executable}`
      : descriptor.pluginName || executable) ||
    `Hook #${hookIndex + 1}`
  );
}

/**
 * config 种子：投影初始化/冷恢复后从 runtime 真值注入的初值。
 * 与事件写入路径（ModelSelected / SessionModeChanged）的关系：种子只填「事件尚未
 * 触碰」的字段——日志重放值永远优先（"最终值以日志为准"）。
 */
export interface SessionConfigSeed {
  permissionGrant?: { interactionId: string };
  planEnabled?: boolean;
  modelSelection?: ModelSelectedPayload["modelSelection"];
  provider?: string;
  model?: string;
  thought?: string;
  thoughtLevels?: readonly string[];
  mode?: string;
}

export interface SessionUsageSeed {
  contextWindow: Omit<NonNullable<SessionUsageState["contextWindow"]>, "maxTokens"> & {
    maxTokens: number | null;
  };
  cumulative?: Partial<SessionUsageState["cumulative"]>;
}

interface ContextWindowProjectionState {
  maxTokens: number | null;
  touchedByEvent: boolean;
  usedTokens: number;
}

export interface SessionSubagentsSeed {
  revision: number;
  childSessionIds: string[];
  running: RunningSubagentSummary[];
}

export interface StableForkCandidate {
  productTurnId: string;
  transcriptTurnId: string;
  startMessageId: string | null;
  boundaryMessageId: string;
}

function cloneSparseModelSelection(
  selection: ModelSelectedPayload["modelSelection"],
): ModelSelectedPayload["modelSelection"] {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

function sameSparseModelSelection(
  left: ModelSelectedPayload["modelSelection"] | undefined,
  right: ModelSelectedPayload["modelSelection"] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export type StableForkCandidateResolution =
  | { ok: true; candidate: StableForkCandidate }
  | {
      ok: false;
      reasonCode:
        | "guard.forkAssistantOnly"
        | "guard.forkTargetNotStable"
        | "guard.forkTargetAmbiguous"
        | "guard.compactOperationLock";
    };

export interface ConversationEditTarget {
  entityId: string;
  productTurnId: string;
  transcriptMessageId: string;
  coveredByStableCompact: boolean;
  intent: {
    inputOrigin?: "desktop" | "mobile";
    genUiContext?: import("@zcode/contracts").TurnInputIntentMetadata["genUiContext"];
    conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
    botGroupSource?: CanonicalUserIntentFact["botGroupSource"];
    kind: "sendText" | "sendGoalCommand";
    text: string;
    sourceCommandId?: string;
    clientId?: string;
    attachments?: CanonicalUserIntentFact["attachments"];
    queueItemId?: string;
    admissionSeq?: number;
    admittedAt?: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    admittedDelivery?: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
    modelSelection?: TurnInputIntentMetadata["modelSelection"];
    mode?: TurnInputIntentMetadata["mode"];
    planEnabled?: boolean;
    provenance?: CanonicalUserIntentFact["provenance"];
  };
}

export type ConversationRowTargetAction =
  | "forkAssistant"
  | "editUserQuery"
  | "retryTurn"
  | "applyFileRewind"
  | "fileChanges"
  | "fileRewindPreview"
  | "setAssistantFeedback"
  | "setHighspeedMetrics";

export type ConversationRowTargetResolution =
  | {
      ok: true;
      action: ConversationRowTargetAction;
      row: ConversationRow;
      editTarget?: ConversationEditTarget;
      messageId?: string;
      messageIds?: string[];
    }
  | {
      ok: false;
      status: "stale" | "rejected";
      reasonCode: "proto.staleTarget" | "guard.actionUnavailable";
    };

// 旧事件没有 retryable 字段；保持历史 UI 的可重试语义，但新事件必须尊重显式 false。
const LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK = true;

function modelRetryReasonCode(
  reason: Extract<ModelNetworkStatusPayload, { type: "model_retry_scheduled" }>["reason"],
): string {
  switch (reason) {
    case "rate_limited":
      return "fault.provider.rateLimited";
    // off-peak 排队（429/3105）语义上就是"上游让我们等"，UI 归入限流可恢复形态。
    case "offpeak_queued":
      return "fault.provider.rateLimited";
    case "provider_overloaded":
    case "server_error":
      return "fault.provider.serverError";
    case "timeout":
      return "fault.network.timeout";
    case "stream_idle_timeout":
      return "fault.network.sseStalled";
    case "stale_connection":
      return "fault.network.sseDisconnected";
    case "network_error":
      return "fault.network.unreachable";
    case "auth_refresh":
    case "reasoning_signature_repair":
      return "fault.provider.requestFailed";
  }
}

function streamRecoveryReasonCode(
  failureKind: StreamRecoveryStartedPayload["failureKind"],
): string {
  switch (failureKind) {
    case "provider_timeout":
      return "fault.network.timeout";
    case "provider_network_error":
      return "fault.network.unreachable";
    case "provider_stream_error":
      return "fault.network.sseDisconnected";
    case "provider_turn_failed":
    case "unknown":
      return "fault.provider.requestFailed";
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

interface FileToolInputPreviewState {
  lastPublishedAt: number | null;
  pendingAppend: string;
}

interface HighspeedToolInterval {
  startedAt: number;
  endedAt?: number;
}

type TurnModelBaseline =
  | { kind: "silentInitial" }
  | { kind: "sourceLess" }
  | { kind: "known"; provider: string; model: string; thought: string };

// 以下声明必须在 ProductProjection 之前：类字段初始值与方法会用到它们，放在类之后时一旦模块
// 求值期就实例化（例如循环 import），会在声明前访问而抛 ReferenceError。
type RowActionEntry = readonly [key: keyof RowActions, value: RowActions[keyof RowActions]];
/** 一个 action 开启时写入的键值（按写入顺序）；关闭时这些键全部删除。 */
type RowActionGroup = readonly RowActionEntry[];
/** 一种行的全部 action 分组，与 nextRowActions 的开关参数按位置对应。 */
type RowActionGroups = readonly [RowActionGroup] | readonly [RowActionGroup, RowActionGroup];

// 每种行的 action 只在这里定义：快速判等和慢路径写入读同一份分组，两者不会不一致。分组与组内键的
// 顺序就是写入顺序，决定 actions 的 JSON 键序，调整顺序会改变线上输出。
const TURN_HEADER_ACTION_GROUPS: RowActionGroups = [[["canRewindFiles", true]]];
const USER_INPUT_ACTION_GROUPS: RowActionGroups = [
  [
    ["canEdit", true],
    ["editDisposition", "rewind"],
  ],
];
/** 开关顺序：canRetry、canFork。 */
const ASSISTANT_TEXT_ACTION_GROUPS: RowActionGroups = [[["canRetry", true]], [["canFork", true]]];
const ROW_ACTIONS_UNCHANGED = Symbol("rowActionsUnchanged");

/**
 * 按分组开关算出一行的新 actions；不变时返回 ROW_ACTIONS_UNCHANGED。
 *
 * 先做快速判等，只在能证明结果不变时直接返回（不分配对象）：
 * - 原来没有 actions：所有分组都关闭（慢路径得到空对象，归一为 undefined）。
 * - 原来有 actions：至少一个分组开启（结果非空），开启分组的键已存在且值相同（赋同值不改变键序），
 *   关闭分组的键不存在（delete 不改变对象）。
 * 其余情况（例如要删掉一个键，或原对象带空值键）走慢路径：与原实现相同的展开、按组 set/delete、
 * 空对象归一与 JSON 比较。
 */
function nextRowActions(
  actions: RowActions | undefined,
  groups: RowActionGroups,
  firstOn: boolean,
  secondOn = false,
): RowActions | undefined | typeof ROW_ACTIONS_UNCHANGED {
  // 只有一个分组时忽略 secondOn，避免多传的开关影响判等。
  const anyOn = firstOn || (groups.length > 1 && secondOn);
  if (actions === undefined) {
    if (!anyOn) return ROW_ACTIONS_UNCHANGED;
  } else if (anyOn && groupsAlreadyApplied(actions, groups, firstOn, secondOn)) {
    return ROW_ACTIONS_UNCHANGED;
  }
  const next: Record<string, unknown> = { ...actions };
  for (let index = 0; index < groups.length; index += 1) {
    const on = index === 0 ? firstOn : secondOn;
    for (const [key, value] of groups[index]!) {
      if (on) next[key] = value;
      else delete next[key];
    }
  }
  const result = Object.keys(next).length > 0 ? (next as RowActions) : undefined;
  return JSON.stringify(result) === JSON.stringify(actions) ? ROW_ACTIONS_UNCHANGED : result;
}

function groupsAlreadyApplied(
  actions: RowActions,
  groups: RowActionGroups,
  firstOn: boolean,
  secondOn: boolean,
): boolean {
  for (let index = 0; index < groups.length; index += 1) {
    const on = index === 0 ? firstOn : secondOn;
    for (const [key, value] of groups[index]!) {
      if (
        on ? !Object.hasOwn(actions, key) || actions[key] !== value : Object.hasOwn(actions, key)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 支持单层事务回滚的 Map，供 ProductProjection 的原子事件路径共享大侧表
 * （docs/v4-refactor/02-projection.md「原子事件事务」）。
 *
 * 性能问题根因：原子路径每个事件都把候选投影的全部侧表复制一份，按行建的几张表随历史线性增长，
 * 10800 行时每个工具事件约 1.7ms 花在复制上。改为候选与当前实例共享这些表，只在共享实例上记录
 * 写入前的状态：拒绝或抛错时撤销，接受时丢弃记录。
 *
 * 回滚必须连迭代顺序一起恢复：rowIdForMessageId 等按插入顺序取第一个匹配。新增键与改写已有键的值
 * 都不改变已有键的相对顺序，按记录撤销即可；删除事务开始前就存在的键（或 clear）会让它之后重新
 * 插入时排到末尾，所以第一次发生这种删除时，先还原出事务开始时的完整内容并保存，回滚时整表恢复。
 *
 * 只拦截 set / delete / clear。值对象不复制，与原来的浅复制相同：调用方只能整体替换值，不能原地
 * 修改值对象。
 */
export class TransactionalMap<K, V> extends Map<K, V> {
  /** 事务未开启时为 null；键 → 事务内第一次写入前是否存在及旧值。 */
  #firstWrites: Map<K, { existed: boolean; value: V | undefined }> | null = null;
  /** 第一次删除事务前已有的键时保存的事务开始状态；保存后不再逐键记录。 */
  #startState: Map<K, V> | null = null;

  constructor(entries?: Iterable<readonly [K, V]> | null) {
    // 不把 entries 交给 super：Map 构造函数会调用被覆盖的 set，而那时私有字段还没初始化。
    super();
    if (entries) for (const [key, value] of entries) super.set(key, value);
  }

  beginTransaction(): void {
    if (this.#firstWrites !== null) throw new Error("TransactionalMap: transaction already open");
    this.#firstWrites = new Map();
    this.#startState = null;
  }

  commitTransaction(): void {
    this.#firstWrites = null;
    this.#startState = null;
  }

  rollbackTransaction(): void {
    const firstWrites = this.#firstWrites;
    const startState = this.#startState;
    this.#firstWrites = null;
    this.#startState = null;
    if (startState !== null) {
      super.clear();
      for (const [key, value] of startState) super.set(key, value);
      return;
    }
    if (firstWrites === null) return;
    for (const [key, write] of firstWrites) {
      if (write.existed) super.set(key, write.value as V);
      else super.delete(key);
    }
  }

  override set(key: K, value: V): this {
    const firstWrites = this.#firstWrites;
    if (firstWrites !== null && this.#startState === null && !firstWrites.has(key)) {
      firstWrites.set(key, { existed: super.has(key), value: super.get(key) });
    }
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    const firstWrites = this.#firstWrites;
    if (firstWrites !== null && this.#startState === null && super.has(key)) {
      // 本事务里新增的键删掉后不影响已有键的顺序，回滚时再删一次即可；其余是事务前就有的键。
      if (firstWrites.get(key)?.existed !== false) this.#saveStartState(firstWrites);
    }
    return super.delete(key);
  }

  override clear(): void {
    const firstWrites = this.#firstWrites;
    if (firstWrites !== null && this.#startState === null && super.size > 0) {
      this.#saveStartState(firstWrites);
    }
    super.clear();
  }

  #saveStartState(firstWrites: ReadonlyMap<K, { existed: boolean; value: V | undefined }>): void {
    // 到这里为止只发生过新增键和改写已有键，已有键的相对顺序没变；撤销这两类写入即得到开始状态。
    const start = new Map<K, V>(this);
    for (const [key, write] of firstWrites) {
      if (write.existed) start.set(key, write.value as V);
      else start.delete(key);
    }
    this.#startState = start;
  }
}

/**
 * 原子事件结束时逐张提交或回滚共享大侧表。
 *
 * 每张表单独 try：某张表回滚抛错时，其余表照常回滚，所有事务都会关闭（rollbackTransaction 先关事务
 * 再恢复内容），不会因残留事务让之后每个事件都报 "transaction already open"、投影从此不可用。抛错那张
 * 表的内容可能只恢复了一部分，所以处理完后统一抛出，由调用方按投影故障处理；归约或 accept 的原始错误
 * 一并放进去，便于排查。
 */
function settleTransactions(
  transactions: readonly TransactionalMap<unknown, unknown>[],
  accepted: boolean,
  failure: { error: unknown } | null,
): void {
  const errors: unknown[] = [];
  for (const map of transactions) {
    try {
      if (accepted) map.commitTransaction();
      else map.rollbackTransaction();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return;
  if (failure) errors.push(failure.error);
  throw new AggregateError(errors, "ProductProjection atomic event settle failed");
}

/**
 * 原子事务里共享一张大侧表：已是 TransactionalMap 时开启事务并共享同一实例。
 *
 * 不是 TransactionalMap 时照原来的方式复制一次，候选拿到可事务化的副本，提交后当前实例也换成它。
 * 正常路径不会走到：rewind 重建与冷恢复结束都直接生成 TransactionalMap，回归测试逐事件断言这一点。
 * 保留它是为了这条不变量被破坏时退化为整份复制（只是变慢），而不是共享一张无法回滚的普通 Map。
 */
function shareForTransaction<K, V>(
  map: Map<K, V>,
  transactions: TransactionalMap<unknown, unknown>[],
): Map<K, V> {
  if (!(map instanceof TransactionalMap)) return new TransactionalMap(map);
  map.beginTransaction();
  transactions.push(map as TransactionalMap<unknown, unknown>);
  return map;
}

export class ProductProjection {
  private snapshot: ConversationSnapshot;
  // reducer 内部的 rowId 查找必须与 rows.window 同步；冷恢复过去每次 find 都扫描全表，
  // tool/turn 终态越多退化越明显。普通归约增量维护，rewind 才重建。
  private rowIndexById: Map<number, number> = new TransactionalMap<number, number>();
  private hydrationAccumulator: MutableConversationSnapshotAccumulator | null = null;
  private nextRowId = 1;
  private streamingTextRowId: number | null = null;
  private streamingReasoningRowId: number | null = null;
  // output-token Continue 是同一 product turn 内的请求级恢复，不应泄漏成新的正文行。
  // 这里只保留上一条满足 length/zero-tool/视觉紧邻条件的 text row，任何真实边界都会清空。
  private outputContinuationTextRowId: number | null = null;
  // 上一条取出的 guide 之后还没有出现主模型 step：同一次取出的后续 guide 并入它开启的工作段。
  private guideDrainOpen = false;
  private toolRowIdByCallId: Map<string, number> = new TransactionalMap<string, number>();
  private latestListAppsSnapshot = new Map<number, CuaAppIdentity>();
  // snapshot 是权威状态；该 Set 只是 TurnComplete 缺终态兜底的派生索引，避免每轮扫描全表。
  private openForegroundToolCallIds = new Set<string>();
  private fileToolInputPreviewByCallId = new Map<string, FileToolInputPreviewState>();
  private liveSubagentStopControlByChildId = new Map<
    string,
    { taskId: string; executionId: string }
  >();
  private subagentRowIdByAgentId = new Map<string, number>();
  private hookRowIdByInvocationId = new Map<string, number>();
  // resume SessionStart 没有 turnId；先保留在 CLI projection，下一条真实 user-intent
  // TurnStarted 到达后再分配 rowId/turnId。不得构造 session-hooks:* synthetic turn。
  private pendingSessionHookInvocations = new Map<string, PendingSessionHookInvocation>();
  // rewind 后 async Hook 的 terminal 仍可能迟到；保留 invocation 墓碑，避免被删旧分支
  // 因找不到原 row 而被 terminal-only 兼容路径重新 append。
  private rewoundHookInvocationIds = new Set<string>();
  // 冷恢复 transcript 可能含旧版本先发布、后持久化失败的 ghost child。store seed 后
  // 必须持续排除，而不是只覆盖一次 snapshot；否则下一条无关事件会从历史 row 再物化它。
  private invalidSubagentChildSessionIds = new Set<string>();
  // rowId → 权威 messageId 侧表。forkAssistant/editUserQuery 的命令载荷用 rowId
  // 定位，但旧 fork/rewind operations 用 messageId（history target）——桥接层经本表翻译。
  // 不进 row schema（客户端只发 rowId，messageId 是服务端内部锚点，避免污染冻结的行结构）。
  private messageIdByRowId: Map<number, string> = new TransactionalMap<number, string>();
  // Continue 复用 rowId 后，动作锚点推进到最后一条 assistant message；旧 partial messageId
  // 仍需能命中同一 row，供 compact coverage、rewind 和整轮文件事实恢复使用。
  private outputContinuationRowIdByMessageId = new Map<string, number>();
  private entityIdByRowId: Map<number, string> = new TransactionalMap<number, string>();
  // canonical command target 只按稳定实体身份寻址；rowId 仅是本次 materialization 的
  // transient lookup，刷新/replay 后变化也不会改变 target identity。
  private editTargetByEntityId: Map<string, ConversationEditTarget> = new TransactionalMap<
    string,
    ConversationEditTarget
  >();
  private currentEditableEntityId: string | null = null;
  private stableCompactCoverageBoundaryRowId: number | null = null;
  private turnHeaderRowIdByTurnId: Map<string, number> = new TransactionalMap<string, number>();
  private compactMarkerRowIdByOperationId = new Map<string, number>();
  // goal verify boundary 身份 = targetId_goalIteration
  // （verificationId 仅 attempt alias——同 iteration 重试携带新 verificationId，
  // 旧实现按 verificationId keying 会长出第二个 marker）。
  private goalVerifyMarkerRowIdByLifecycleKey = new Map<string, number>();
  // queue drain 在同一 runtimeTurn 内切出新的
  // product turn。runtimeTurnId → 当前 productTurnId 映射；后续事件行经 turnIdOf
  // 归入最新 productTurn。steer（guide）不切轮，内联当前轮。
  private productTurnIdByRuntimeTurnId: Map<string, string> = new TransactionalMap<
    string,
    string
  >();
  private runtimeTurnIdByProductTurnId: Map<string, string> = new TransactionalMap<
    string,
    string
  >();
  private productTurnSplitOrdinalByRuntimeTurnId = new Map<string, number>();
  private currentProductTurnStartedAtMs: number | null = null;
  // Highspeed 分享需要的真实耗时由 CLI 事件聚合，避免 renderer 离场后丢失拆分数据。
  private highspeedModelDurationByTurnId = new Map<string, number>();
  private highspeedToolIntervalsByTurnId = new Map<string, Map<string, HighspeedToolInterval>>();
  // 投递语义侧表：TurnSteerQueued 时按事件 payload（或 followupMode 兜底）记录，
  // drain 时决定切轮 vs 内联；账本落地后以账本为准。
  private deliveryByPendingInputId = new Map<string, "guide" | "queue">();
  private currentTurnId: string | null = null;
  // 当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护 turn）。SessionStart 摘要的 pending 归位不得以维护
  // turn 为收口目标，必须等下一条 user-visible 真实 turn。
  private currentTurnStartedModelOnly = false;
  // contextWindow=null 时协议不暴露分母与已用量，但 reducer 仍需保留最新 context 用量，
  // 以便 registry 后续恢复已知容量时原子重建 usage，而不是错误归零。
  private contextWindowState: ContextWindowProjectionState = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };
  // modelChange marker 在「下一个 turn 开始时」生成。
  // silentInitial 保持普通 Main 首轮静默；sourceLess 表示显式 ∅→X；known 保存上一轮
  // 实际使用的 provider/model。thought 只随基线记录，不触发模型身份变化。
  private lastTurnModel: TurnModelBaseline = { kind: "silentInitial" };
  // 新建 worktree 会话：WorktreeCreated 先于首轮到达，暂存到首个 TurnStarted 时在轮顶落行
  // （docs/git/worktree.md §6.6.4）。已有轮次（fork 子会话）时直接落在当前轮尾。
  private pendingWorktreeCreated: { event: SessionEvent; payload: WorktreeCreatedPayload } | null =
    null;
  // 种子守卫：事件（权威日志）触碰过的 config 区块不再接受种子覆盖。
  private configModelTouchedByEvent = false;
  // 旧 ModelSelected 不含能力集合；独立守卫允许 runtime seed 补齐旧日志，
  // 又避免后续种子覆盖新事件已原子发布的模型能力。
  private configThoughtLevelsTouchedByEvent = false;
  private configModeTouchedByEvent = false;
  // assistant 守恒：非运行期拒收的正文流计数（gateway 据此置 stale）。
  private droppedContentStreamEventCount = 0;
  // 读取期 legacy fallback 必须可观测；否则 normalizer 缺字段后仍会退化为“可见但不可寻址”。
  private normalizationDiagnostics: ConversationNormalizationDiagnostic[] = [];

  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  getSnapshot(): ConversationSnapshot {
    return this.snapshot;
  }

  /** 生命周期状态独立于 run phase；更新必须推进水位，避免旧 base 漏掉门禁。 */
  setRuntimeInitialization(
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
    minimumSeq = this.snapshot.seq + 1,
    minimumRevision = this.snapshot.revision + 1,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      runtimeInitialization: state,
      seq: Math.max(this.snapshot.seq, minimumSeq),
      revision: Math.max(this.snapshot.revision, minimumRevision),
    };
  }

  /** 原 admission owner 的当前事实；不改变 CAS revision，也不作为冷启动恢复队列。 */
  setPendingCommands(
    pendingCommands: ConversationSnapshot["pendingCommands"],
    minimumSeq = 0,
  ): ConversationDelta[] {
    this.snapshot = {
      ...this.snapshot,
      pendingCommands,
      seq: Math.max(this.snapshot.seq + 1, minimumSeq),
    };
    return [{ op: "state.updated", patch: { pendingCommands } }];
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  getDroppedContentStreamEventCount(): number {
    return this.droppedContentStreamEventCount;
  }

  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[] {
    return this.normalizationDiagnostics;
  }

  /**
   * 是否为对已打开流式行的追加：是则返回用于估算增量的追加文本（文件工具节流期间为空串），否则返回
   * null。有两个使用方：publisher 的有界增量估算（null 时走候选快照精确校验），以及
   * applyEventInternal 的 actions 物化准入（docs/v4-refactor/02-projection.md「命令 actions 的物化
   * 时机」）。放宽这里的判定时，必须同时满足后者的约束。
   */
  establishedStreamingAppend(event: SessionEvent): string | null {
    if (event.type !== SessionEventType.ModelStreaming || !this.isRunning()) return null;
    const payload = event.payload as ModelStreamingPayload;
    if (payload.kind === "text_delta" && this.streamingTextRowId !== null) return payload.delta;
    if (payload.kind === "reasoning_delta" && this.streamingReasoningRowId !== null) {
      return payload.delta;
    }
    if (
      payload.kind === "tool_input_delta" &&
      this.toolRowIdByCallId.has(String(payload.toolCallId))
    ) {
      const state = this.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
      if (state) {
        if (
          state.lastPublishedAt !== null &&
          this.ms(event) - state.lastPublishedAt <
            ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
        ) {
          return "";
        }
        // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
        return `${state.pendingAppend}${payload.delta}`;
      }
      return payload.delta;
    }
    return null;
  }

  /**
   * config 种子注入。
   *
   * 初始快照 config 曾写死空 provider/model +
   * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
   * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
   * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
   * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
   * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
   *
   * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
   * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
   * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
   */
  seedConfig(seed: SessionConfigSeed): void {
    const config = { ...this.snapshot.config };
    let changed = false;
    if (!config.permissionGrant && seed.permissionGrant) {
      config.permissionGrant = seed.permissionGrant;
      changed = true;
    }
    if (!this.configModelTouchedByEvent) {
      if (
        Object.hasOwn(seed, "modelSelection") &&
        !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
      ) {
        // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
        config.modelSelection = seed.modelSelection
          ? cloneSparseModelSelection(seed.modelSelection)
          : undefined;
        changed = true;
      }
      if (seed.provider !== undefined && config.provider !== seed.provider) {
        config.provider = seed.provider;
        changed = true;
      }
      if (seed.model !== undefined && config.model !== seed.model) {
        config.model = seed.model;
        changed = true;
      }
      if (seed.thought !== undefined && config.thought !== seed.thought) {
        config.thought = seed.thought;
        changed = true;
      }
    }
    const seedThoughtLevels = seed.thoughtLevels;
    if (
      !this.configThoughtLevelsTouchedByEvent &&
      seedThoughtLevels !== undefined &&
      (config.thoughtLevels.length !== seedThoughtLevels.length ||
        config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
    ) {
      config.thoughtLevels = [...seedThoughtLevels];
      changed = true;
    }
    if (!this.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
      config.mode = seed.mode;
      changed = true;
    }
    if (
      !this.configModeTouchedByEvent &&
      seed.planEnabled !== undefined &&
      config.planEnabled !== seed.planEnabled
    ) {
      config.planEnabled = seed.planEnabled;
      changed = true;
    }
    if (changed) {
      this.snapshot = { ...this.snapshot, config };
    }
  }

  /**
   * 导入分享上下文的来源只读种子。
   *
   * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
   * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
   * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
   */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    const title = source?.title.trim();
    if (!title) return;
    if (
      this.snapshot.sharedContextImport?.title === title &&
      (source as { contextId?: string }).contextId ===
        (this.snapshot.sharedContextImport as { contextId?: string }).contextId &&
      (source as { status?: string }).status ===
        (this.snapshot.sharedContextImport as { status?: string }).status
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      sharedContextImport: {
        ...source,
        title,
      },
    };
  }

  seedUsage(seed: SessionUsageSeed): void {
    const current = this.snapshot.usage;
    const currentContextWindow = current.contextWindow;
    if (currentContextWindow) {
      this.contextWindowState.usedTokens = currentContextWindow.usedTokens;
    }
    // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
    if (this.contextWindowState.usedTokens > 0) {
      return;
    }
    const seededContextWindow = seed.contextWindow;
    if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
      return;
    }
    const cumulative = {
      inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
      outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
      cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
      cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
    };
    if (this.contextWindowState.touchedByEvent) {
      // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
      // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
      this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
      this.snapshot = {
        ...this.snapshot,
        usage: {
          contextWindow: currentContextWindow
            ? {
                ...currentContextWindow,
                usedTokens: seededContextWindow.usedTokens,
              }
            : null,
          cumulative,
        },
      };
      return;
    }
    if (
      seededContextWindow.maxTokens !== null &&
      (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
    ) {
      return;
    }

    // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
    this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    this.contextWindowState.maxTokens = seededContextWindow.maxTokens;
    this.snapshot = {
      ...this.snapshot,
      usage: {
        contextWindow:
          seededContextWindow.maxTokens === null
            ? null
            : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
        cumulative,
      },
    };
  }

  /**
   * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
   * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
   * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
   */
  seedSubagents(seed: SessionSubagentsSeed): void {
    const childSessionIds = [...new Set(seed.childSessionIds)];
    const allowed = new Set(childSessionIds);
    this.invalidSubagentChildSessionIds = new Set(
      this.snapshot.rows.window.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
          ? [row.childSessionId]
          : [],
      ),
    );
    const running = seed.running
      .filter((item) => allowed.has(item.childSessionId))
      .map((item) => {
        const { stopControl: _stopControl, ...display } = item;
        return display;
      });
    this.snapshot = {
      ...this.snapshot,
      subagents: {
        // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
        // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
        revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
        childSessionIds,
        running,
        endedTotal: Math.max(0, childSessionIds.length - running.length),
      },
    };
  }

  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  getMessageIdForRow(rowId: number): string | null {
    return this.messageIdByRowId.get(rowId) ?? null;
  }

  getEntityIdForRow(rowId: number): string | null {
    return this.entityIdByRowId.get(rowId) ?? null;
  }

  resolveEditTarget(rowId: number): ConversationEditTarget | null {
    if (!this.isLatestEditableUserRow(rowId)) return null;
    const entityId = this.entityIdByRowId.get(rowId);
    return entityId ? this.resolveEditTargetByEntityId(entityId) : null;
  }

  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null {
    if (entityId !== this.currentEditableEntityId) return null;
    const target = this.editTargetByEntityId.get(entityId);
    return target ? { ...target, intent: { ...target.intent } } : null;
  }

  /**
   * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
   * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
   * 不得再各自按位置、phase 或文本重算。
   */
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    const row = this.findRow(target.rowId);
    if (!row || this.entityIdByRowId.get(target.rowId) !== target.entityId) {
      return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
    }
    if (action === "editUserQuery") {
      const editTarget = this.resolveEditTargetByEntityId(target.entityId);
      if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, editTarget };
    }
    if (action === "retryTurn") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      const userRow = this.snapshot.rows.window.find(
        (candidate) =>
          candidate.turnId === row.turnId &&
          candidate.kind === "userInput" &&
          candidate.origin === "realUser",
      );
      const userEntityId = userRow ? this.entityIdByRowId.get(userRow.rowId) : undefined;
      const editTarget = userEntityId ? this.editTargetByEntityId.get(userEntityId) : undefined;
      if (row.actions?.canRetry !== true || !messageId || !editTarget) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId, editTarget };
    }
    if (action === "forkAssistant") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      // 行级资格与 session 锁分开下发（02-projection「会话锁与行级资格」），这里取两者的与。
      if (row.actions?.canFork !== true || !this.snapshot.availability.fork.allowed || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setAssistantFeedback") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.kind !== "assistantText" || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setHighspeedMetrics") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.kind !== "userInput" || !row.highspeed || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (row.kind !== "turnHeader") {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    if (
      (action === "applyFileRewind" || action === "fileRewindPreview") &&
      (!row.fileChanges ||
        row.actions?.canRewindFiles !== true ||
        // CLI 自己的快照总带 rewindFiles；schema 的 optional 只为客户端兼容旧 CLI。
        this.snapshot.availability.rewindFiles?.allowed !== true)
    ) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return {
      ok: true,
      action,
      row,
      messageIds: this.getMessageIdsForTurnRow(row.rowId),
    };
  }

  /**
   * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
   * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
   */
  getMessageIdsForTurnRow(rowId: number): string[] {
    const row = this.findRow(rowId);
    if (!row) return [];
    const messageIds = new Set<string>();
    const runtimeTurnId = this.runtimeTurnIdByProductTurnId.get(row.turnId);
    // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
    // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
    // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
    if (runtimeTurnId && runtimeTurnId !== row.turnId) {
      messageIds.add(row.turnId);
    }
    for (const candidate of this.snapshot.rows.window) {
      if (candidate.turnId !== row.turnId) continue;
      const messageId = this.messageIdByRowId.get(candidate.rowId);
      if (messageId) messageIds.add(messageId);
    }
    for (const [messageId, continuationRowId] of this.outputContinuationRowIdByMessageId) {
      const continuationRow = this.findRow(continuationRowId);
      if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
    }
    return [...messageIds];
  }

  /**
   * core 侧强校验：
   * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
   * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
   */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    if (row?.kind !== "assistantText") return false;
    for (let index = this.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
      const candidate = this.snapshot.rows.window[index]!;
      if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
        return candidate.rowId === rowId;
      }
    }
    return false;
  }

  /**
   * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
   * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
   */
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    if (this.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
      return { ok: false, reasonCode: "guard.compactOperationLock" };
    }
    const row = this.findRow(rowId);
    if (row?.kind !== "assistantText") {
      return { ok: false, reasonCode: "guard.forkAssistantOnly" };
    }
    const headerRowId = this.turnHeaderRowIdByTurnId.get(row.turnId);
    const header = headerRowId === undefined ? undefined : this.findRow(headerRowId);
    if (
      row.state !== "complete" ||
      row.actions?.canFork !== true ||
      header?.kind !== "turnHeader" ||
      header.state !== "completedSuccess" ||
      !this.isLatestAssistantSegmentRow(rowId)
    ) {
      return { ok: false, reasonCode: "guard.forkTargetNotStable" };
    }
    const boundaryMessageId = this.messageIdByRowId.get(rowId);
    if (!boundaryMessageId) {
      return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
    }
    const startMessageId =
      this.snapshot.rows.window
        .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
        .map((candidate) => this.messageIdByRowId.get(candidate.rowId))
        .find((messageId): messageId is string => Boolean(messageId)) ?? null;
    return {
      ok: true,
      candidate: {
        productTurnId: row.turnId,
        transcriptTurnId: this.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
        startMessageId,
        boundaryMessageId,
      },
    };
  }

  /** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    return Boolean(
      row?.kind === "assistantText" &&
      row.actions?.canRetry === true &&
      this.messageIdByRowId.has(rowId),
    );
  }

  /** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
  isLatestEditableUserRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    return Boolean(
      row?.kind === "userInput" &&
      row.origin === "realUser" &&
      row.actions?.canEdit === true &&
      this.messageIdByRowId.has(rowId),
    );
  }

  /** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
  getTurnIdForRow(rowId: number): string | null {
    return this.findRow(rowId)?.turnId ?? null;
  }

  /** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
  applyEvent(event: SessionEvent): ConversationDelta[] {
    return this.applyEventInternal(event, true);
  }

  /**
   * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
   * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
   */
  beginHydrationReplay(): void {
    if (this.hydrationAccumulator) throw new Error("hydration replay already active");
    // 冷恢复只能重建展示，历史 spawn 不能重新授予内存执行的停止能力。
    this.liveSubagentStopControlByChildId.clear();
    this.hydrationAccumulator = createMutableConversationSnapshotAccumulator(this.snapshot);
    this.snapshot = this.hydrationAccumulator.snapshot;
    this.rowIndexById = this.hydrationAccumulator.rowIndexById;
  }

  applyHydrationEvent(event: SessionEvent): ConversationDelta[] {
    if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
    return this.applyEventInternal(event, false);
  }

  /**
   * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
   * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
   */
  completeHydrationReplay(): ConversationDelta[] {
    if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
    const deltas = this.materializeCommandRowActions([]);
    applyConversationDeltasMutable(this.hydrationAccumulator, deltas);
    this.hydrationAccumulator = null;
    // 批量回放期间 rowIndexById 与 accumulator 共用同一个普通 Map（mutable apply 直接改它）。结束后换成
    // TransactionalMap，保持“hydration 之外八张共享表始终是 TransactionalMap”（02-projection「原子事件事务」）。
    this.rowIndexById = new TransactionalMap(this.rowIndexById);
    return deltas;
  }

  private applyEventInternal(
    event: SessionEvent,
    materializeActions: boolean,
  ): ConversationDelta[] {
    if (event.type === SessionEventType.SubagentSpawned) {
      const childSessionId = this.stringPayload(
        event.payload as Record<string, unknown>,
        "childSessionId",
      );
      // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
      // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
      if (childSessionId) this.invalidSubagentChildSessionIds.delete(childSessionId);
    }
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    const productTurnId =
      event.type === SessionEventType.TurnStarted
        ? undefined
        : (this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
    // 在归约前取，与 publisher 快路径（ingest）对同一状态判定“是否为已打开流式行的追加”。
    const streamingAppend = materializeActions && this.establishedStreamingAppend(event) !== null;
    const reduced =
      event.type === SessionEventType.AssistantFeedbackUpdated
        ? this.onAssistantFeedbackUpdated(event)
        : event.type === SessionEventType.HighspeedMetricsUpdated
          ? this.onHighspeedMetricsUpdated(event)
          : event.type === SessionEventType.TurnExecutionModelFallback
            ? this.onTurnExecutionModelFallback(event)
            : (() => {
                const fact = normalizeConversationEvent(event, {
                  productTurnId,
                  openAssistantSegments: this.openAssistantSegments(),
                });
                this.normalizationDiagnostics.push(...fact.diagnostics);
                return this.reduce(fact);
              })();
    const subagentDeltas = this.shouldMaterializeSubagentProjection(reduced)
      ? this.materializeSubagentProjection(reduced)
      : [];
    // 接纳先于 TurnStarted；只在同一归约事务已有执行/队列事实或明确失败时移除，
    // 不能在 ACK 后补 pending，否则快速完成会留下永久幽灵条目。
    const payload = event.payload as {
      inputId?: string;
      sourceCommandId?: string;
      intent?: { sourceCommandId?: string };
    };
    const pendingCommandId =
      payload.inputId ?? payload.sourceCommandId ?? payload.intent?.sourceCommandId;
    const resolvesPending =
      event.type === SessionEventType.TurnStarted ||
      event.type === SessionEventType.TurnSteerQueued ||
      event.type === SessionEventType.TurnError ||
      event.type === SessionEventType.TurnComplete ||
      event.type === SessionEventType.CompactStarted ||
      event.type === SessionEventType.CompactCompleted ||
      event.type === SessionEventType.CompactFailed;
    const pendingCommands =
      resolvesPending && pendingCommandId
        ? this.snapshot.pendingCommands.filter((command) => command.commandId !== pendingCommandId)
        : this.snapshot.pendingCommands;
    const pendingDeltas: ConversationDelta[] =
      pendingCommands.length !== this.snapshot.pendingCommands.length
        ? [{ op: "state.updated", patch: { pendingCommands } }]
        : [];
    const reducedWithSubagents = [...reduced, ...subagentDeltas, ...pendingDeltas];
    // row、命令 target 与 actions 必须属于同一个 materialization transaction。
    // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
    // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
    const deltas =
      materializeActions &&
      this.shouldMaterializeCommandRowActions(streamingAppend, reducedWithSubagents)
        ? [...reducedWithSubagents, ...this.materializeCommandRowActions(reducedWithSubagents)]
        : reducedWithSubagents;
    const finalDeltas = this.attachRevision(clearSettledOutputPreviews(deltas));
    if (this.hydrationAccumulator) {
      applyConversationDeltasMutable(this.hydrationAccumulator, finalDeltas);
      this.snapshot.seq = event.sequenceNumber;
    } else {
      const previousRowsLength = this.snapshot.rows.window.length;
      this.snapshot = {
        ...applyConversationDeltas(this.snapshot, finalDeltas),
        seq: event.sequenceNumber,
      };
      this.updateRowIndexAfterImmutableApply(previousRowsLength, finalDeltas);
    }
    this.updateToolIndexesAfterDeltas(finalDeltas);
    return finalDeltas;
  }

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。拒绝、accept 抛错或
   * 归约抛错时，当前实例的所有状态（含与候选共享的大侧表）都不变，客户端仍可从最后一个
   * 可传输 snapshot 恢复。
   *
   * `accept` 同时拿到这条事件**实际产出**的 delta：有些事件类别可以只按 delta 的字节数给出
   * 一个可靠上界，不必把整份候选快照再序列化一遍（publisher 的 ingest 快路径）。传的是实际
   * 产出而不是预演，正是因为预演算不准——投影在 reducer 之上还叠了 subagent 镜像与命令
   * actions 的 materialization，少算一条就把 16MiB 闸门算松了。
   *
   * 最大的八张侧表（按行或按轮增长）不再复制，由候选与当前实例共享，在共享实例上开事务
   * （TransactionalMap）：拒绝、accept 抛错或归约抛错时回滚，接受时提交，逐张处理见
   * settleTransactions。效果与复制相同：拒绝后当前实例的这些表内容与迭代顺序都不变。其余字段照旧
   * 复制，其中 hook 调用、subagent、compact/goal 标记与诊断数组也随历史增长，但通常很小。
   *
   * 约束：accept 只能读传入的 snapshot 与 deltas，不能调用本投影的查询方法（findRow、
   * resolveRowActionTarget 等）。accept 执行时共享大侧表已带上候选的写入，当前实例的 snapshot 却仍是
   * 旧的，二者不一致。accept 若读投影，判断依据就是新旧混合的状态，不论最终返回 true 还是 false
   * 都可能判错。
   */
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot, deltas: readonly ConversationDelta[]) => boolean,
  ): ConversationDelta[] | null {
    const transactions: TransactionalMap<unknown, unknown>[] = [];
    let accepted = false;
    let failure: { error: unknown } | null = null;
    try {
      const candidate = this.cloneProjection(transactions);
      const deltas = candidate.applyEvent(event);
      if (!accept(candidate.snapshot, deltas)) return null;
      this.adoptProjection(candidate);
      accepted = true;
      return deltas;
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      settleTransactions(transactions, accepted, failure);
    }
  }

  private cloneProjection(transactions: TransactionalMap<unknown, unknown>[]): ProductProjection {
    const share = <K, V>(map: Map<K, V>): Map<K, V> => shareForTransaction(map, transactions);
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    clone.snapshot = this.snapshot;
    clone.rowIndexById = share(this.rowIndexById);
    clone.hydrationAccumulator = null;
    clone.nextRowId = this.nextRowId;
    clone.streamingTextRowId = this.streamingTextRowId;
    clone.streamingReasoningRowId = this.streamingReasoningRowId;
    clone.outputContinuationTextRowId = this.outputContinuationTextRowId;
    clone.guideDrainOpen = this.guideDrainOpen;
    clone.toolRowIdByCallId = share(this.toolRowIdByCallId);
    // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
    clone.latestListAppsSnapshot = new Map(this.latestListAppsSnapshot);
    clone.openForegroundToolCallIds = new Set(this.openForegroundToolCallIds);
    clone.fileToolInputPreviewByCallId = new Map(
      [...this.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [
        toolCallId,
        { ...state },
      ]),
    );
    clone.subagentRowIdByAgentId = new Map(this.subagentRowIdByAgentId);
    clone.liveSubagentStopControlByChildId = new Map(this.liveSubagentStopControlByChildId);
    clone.hookRowIdByInvocationId = new Map(this.hookRowIdByInvocationId);
    clone.pendingSessionHookInvocations = new Map(
      [...this.pendingSessionHookInvocations].map(([invocationId, pending]) => [
        invocationId,
        {
          firstEvent: pending.firstEvent,
          content: {
            ...pending.content,
            executions: pending.content.executions.map((execution) => ({ ...execution })),
          },
        },
      ]),
    );
    clone.rewoundHookInvocationIds = new Set(this.rewoundHookInvocationIds);
    clone.invalidSubagentChildSessionIds = new Set(this.invalidSubagentChildSessionIds);
    clone.messageIdByRowId = share(this.messageIdByRowId);
    clone.outputContinuationRowIdByMessageId = new Map(this.outputContinuationRowIdByMessageId);
    clone.entityIdByRowId = share(this.entityIdByRowId);
    clone.editTargetByEntityId = share(this.editTargetByEntityId);
    clone.currentEditableEntityId = this.currentEditableEntityId;
    clone.stableCompactCoverageBoundaryRowId = this.stableCompactCoverageBoundaryRowId;
    clone.turnHeaderRowIdByTurnId = share(this.turnHeaderRowIdByTurnId);
    clone.compactMarkerRowIdByOperationId = new Map(this.compactMarkerRowIdByOperationId);
    clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(this.goalVerifyMarkerRowIdByLifecycleKey);
    clone.productTurnIdByRuntimeTurnId = share(this.productTurnIdByRuntimeTurnId);
    clone.runtimeTurnIdByProductTurnId = share(this.runtimeTurnIdByProductTurnId);
    clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
      this.productTurnSplitOrdinalByRuntimeTurnId,
    );
    clone.currentProductTurnStartedAtMs = this.currentProductTurnStartedAtMs;
    clone.highspeedModelDurationByTurnId = new Map(this.highspeedModelDurationByTurnId);
    clone.highspeedToolIntervalsByTurnId = new Map(
      [...this.highspeedToolIntervalsByTurnId].map(([turnId, intervals]) => [
        turnId,
        new Map([...intervals].map(([toolCallId, interval]) => [toolCallId, { ...interval }])),
      ]),
    );
    clone.deliveryByPendingInputId = new Map(this.deliveryByPendingInputId);
    clone.currentTurnId = this.currentTurnId;
    clone.currentTurnStartedModelOnly = this.currentTurnStartedModelOnly;
    clone.contextWindowState = { ...this.contextWindowState };
    clone.lastTurnModel = { ...this.lastTurnModel };
    clone.pendingWorktreeCreated = this.pendingWorktreeCreated;
    clone.configModelTouchedByEvent = this.configModelTouchedByEvent;
    clone.configThoughtLevelsTouchedByEvent = this.configThoughtLevelsTouchedByEvent;
    clone.configModeTouchedByEvent = this.configModeTouchedByEvent;
    clone.droppedContentStreamEventCount = this.droppedContentStreamEventCount;
    clone.normalizationDiagnostics = [...this.normalizationDiagnostics];
    return clone;
  }

  private adoptProjection(candidate: ProductProjection): void {
    this.snapshot = candidate.snapshot;
    this.rowIndexById = candidate.rowIndexById;
    this.hydrationAccumulator = null;
    this.nextRowId = candidate.nextRowId;
    this.streamingTextRowId = candidate.streamingTextRowId;
    this.streamingReasoningRowId = candidate.streamingReasoningRowId;
    this.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
    this.guideDrainOpen = candidate.guideDrainOpen;
    this.toolRowIdByCallId = candidate.toolRowIdByCallId;
    this.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
    this.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
    this.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
    this.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
    this.liveSubagentStopControlByChildId = candidate.liveSubagentStopControlByChildId;
    this.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
    this.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
    this.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
    this.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
    this.messageIdByRowId = candidate.messageIdByRowId;
    this.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
    this.entityIdByRowId = candidate.entityIdByRowId;
    this.editTargetByEntityId = candidate.editTargetByEntityId;
    this.currentEditableEntityId = candidate.currentEditableEntityId;
    this.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
    this.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
    this.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
    this.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
    this.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
    this.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
    this.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
    this.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
    this.highspeedModelDurationByTurnId = candidate.highspeedModelDurationByTurnId;
    this.highspeedToolIntervalsByTurnId = candidate.highspeedToolIntervalsByTurnId;
    this.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
    this.currentTurnId = candidate.currentTurnId;
    this.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
    this.contextWindowState = candidate.contextWindowState;
    this.lastTurnModel = candidate.lastTurnModel;
    this.pendingWorktreeCreated = candidate.pendingWorktreeCreated;
    this.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
    this.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
    this.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
    this.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
    this.normalizationDiagnostics = candidate.normalizationDiagnostics;
  }

  /**
   * live 事件的 actions 物化准入（docs/v4-refactor/02-projection.md「命令 actions 的物化时机」）。
   *
   * 性能问题根因：每个 token 都整窗物化 actions（建全行 Map、倒序扫描、逐行 JSON 比较），长会话
   * 流式输出时 CLI 每个事件的成本随历史线性增长（8000 行时每个事件超过 1ms）。
   *
   * 物化读取：prospective 行的种类、状态、轮次、userInput.origin、rowId 顺序与现有 actions，
   * turnHeader 的 fileChanges.state，control 的 phase 与 activeWorks，goal.status、queue 与
   * pendingInteractions，以及 messageIdByRowId / entityIdByRowId / editTargetByEntityId /
   * turnHeaderRowIdByTurnId 侧表；输出行 actions、availability 并写 currentEditableEntityId。
   * row.delta 只追加文本字段，流式追加路径也不写这些侧表，所以当本事件归约结果全是 row.delta
   * （或为空）时，物化结果必为空、可编辑目标不变。
   * 流式追加也可能附带其他增量（清除 apiRetry 的 state.updated、subagent 增量），这时照常物化。
   *
   * 前提：事件到达前 actions 已与当前状态一致。其他 live 事件都会物化，cold batch 结束时收敛一次；
   * 新增只产生 row.delta 却改写上述输入的 reducer，或在事件之外改写这些输入的写入方，必须自己物化。
   */
  private shouldMaterializeCommandRowActions(
    streamingAppend: boolean,
    reduced: readonly ConversationDelta[],
  ): boolean {
    return !streamingAppend || reduced.some((delta) => delta.op !== "row.delta");
  }

  /**
   * 基于本事件归约后的 prospective rows 原子生成行 actions 与 session availability。
   * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
   * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
   *
   * fork / 文件撤销的 session 锁（compact、active work、pending interaction）只写进
   * availability，不写进 canFork / canRewindFiles。性能问题根因：锁写在行上时，每轮开始/结束、
   * compact 开始/结束都要给全部历史行各发一条 row.upserted，长会话（8100 行）单次归约
   * 150–330ms，并超过订阅缓冲上限退化为 snapshot 重发（02-projection「会话锁与行级资格」）。
   *
   * 函数名沿用只产出行 actions 时的旧名。现在它也产出 availability；暂不改名，避免牵动
   * product-projection-streaming-actions.test.ts 里按方法名观察物化的回归断言。
   *
   * 性能问题根因：整窗物化每个事件都为全部行建 rowId Map、再从头扫一遍找本轮用户行，并对每行
   * 展开 actions、做两次 JSON.stringify 比较；Node 合成回放 10800 行、运行中时单次约 4.6ms
   * （02-projection）。现在一遍正向扫描收集 turnHeader、每轮最新 assistant 和 retry 所需的本轮
   * 首条 realUser 行；逐行由 nextRowActions 先证明不变，证明不了才走原来的展开 + JSON 比较，
   * 所以输出与原实现逐字节一致。
   */
  private materializeCommandRowActions(reduced: ConversationDelta[]): ConversationDelta[] {
    const prospective = applyConversationDeltas(this.snapshot, reduced);
    const rows = prospective.rows.window;
    const availabilityContext = availabilityContextOf(prospective);
    const compactActive = availabilityContext.compacting;
    const completionBlockingActive = availabilityContext.activeWorkCount > 0;
    let latestEditable: ConversationRow | undefined;
    let latestAssistant: AssistantTextRow | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (
        !latestEditable &&
        !compactActive &&
        row.kind === "userInput" &&
        row.origin === "realUser"
      ) {
        latestEditable = row;
      }
      if (!latestAssistant && row.kind === "assistantText") {
        latestAssistant = row;
      }
      if (latestEditable && latestAssistant) break;
    }
    // retry 的前置条件不依赖下面的正向扫描。满足时，正向扫描顺带找本轮第一条 realUser 行：
    // 与原来的 rows.find 同一顺序、同一条件，结果相同，省掉一次全窗扫描。
    const retryCandidate =
      !completionBlockingActive &&
      latestAssistant?.state === "complete" &&
      this.messageIdByRowId.has(latestAssistant.rowId)
        ? latestAssistant
        : undefined;
    const retryTurnId = retryCandidate?.turnId;
    // header 只经 turnHeaderRowIdByTurnId 按 rowId 查，原来的全行 Map 只用到这一种行。
    const headerByRowId = new Map<number, TurnHeaderRow>();
    const latestAssistantRowIdByTurn = new Map<string, number>();
    let canonicalUserRow: ConversationRow | undefined;
    for (const row of rows) {
      if (row.kind === "turnHeader") {
        headerByRowId.set(row.rowId, row);
        continue;
      }
      if (row.kind === "userInput") {
        if (
          canonicalUserRow === undefined &&
          row.turnId === retryTurnId &&
          row.origin === "realUser"
        ) {
          canonicalUserRow = row;
        }
        continue;
      }
      if (row.kind !== "assistantText") continue;
      const current = latestAssistantRowIdByTurn.get(row.turnId);
      if (current === undefined || row.rowId > current) {
        latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
      }
    }
    const headerOfTurn = (turnId: string): TurnHeaderRow | undefined => {
      const headerId = this.turnHeaderRowIdByTurnId.get(turnId);
      return headerId === undefined ? undefined : headerByRowId.get(headerId);
    };
    // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
    // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
    // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
    // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
    const latestRetryable = (() => {
      if (!retryCandidate) return undefined;
      const header = headerOfTurn(retryCandidate.turnId);
      if (header === undefined || header.state === "running") return undefined;
      const canonicalUserEntityId = canonicalUserRow
        ? this.entityIdByRowId.get(canonicalUserRow.rowId)
        : undefined;
      if (!canonicalUserEntityId || !this.editTargetByEntityId.has(canonicalUserEntityId)) {
        return undefined;
      }
      return retryCandidate;
    })();
    const latestEditableEntityId =
      latestEditable === undefined
        ? null
        : (this.entityIdByRowId.get(latestEditable.rowId) ?? null);
    // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
    // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
    const latestEditableRowId =
      latestEditable &&
      latestEditableEntityId &&
      this.messageIdByRowId.has(latestEditable.rowId) &&
      this.editTargetByEntityId.has(latestEditableEntityId)
        ? latestEditable.rowId
        : null;
    // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
    // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
    // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
    this.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
    const latestRetryableRowId = latestRetryable?.rowId ?? null;
    const deltas: ConversationDelta[] = [];

    for (const row of rows) {
      let nextActions: RowActions | undefined | typeof ROW_ACTIONS_UNCHANGED;
      if (row.kind === "turnHeader") {
        nextActions = nextRowActions(
          row.actions,
          TURN_HEADER_ACTION_GROUPS,
          row.state !== "running" && row.fileChanges?.state === "active",
        );
      } else if (row.kind === "userInput") {
        nextActions = nextRowActions(
          row.actions,
          USER_INPUT_ACTION_GROUPS,
          row.rowId === latestEditableRowId,
        );
      } else if (row.kind === "assistantText") {
        const header = headerOfTurn(row.turnId);
        const canFork =
          row.state === "complete" &&
          header?.state === "completedSuccess" &&
          latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
          this.messageIdByRowId.has(row.rowId);
        nextActions = nextRowActions(
          row.actions,
          ASSISTANT_TEXT_ACTION_GROUPS,
          row.rowId === latestRetryableRowId,
          canFork,
        );
      } else {
        continue;
      }
      if (nextActions === ROW_ACTIONS_UNCHANGED) continue;
      const nextRow: ConversationRow = { ...row, actions: nextActions };
      if (!nextActions) delete nextRow.actions;
      deltas.push({ op: "row.upserted", row: nextRow });
    }
    const availability = computeAvailability(availabilityContext);
    if (JSON.stringify(availability) !== JSON.stringify(prospective.availability)) {
      deltas.push({ op: "state.updated", patch: { availability } });
    }
    return deltas;
  }

  // revision 递进：本事件含任一结构性 delta → revision +1，
  // 且携带规则要求 deltas 中必含 state.updated.revision。
  private attachRevision(deltas: ConversationDelta[]): ConversationDelta[] {
    if (!deltas.some(deltaBumpsRevision)) return deltas;
    const revision = this.snapshot.revision + 1;
    const last = deltas[deltas.length - 1];
    if (last?.op === "state.updated") {
      return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
    }
    return [...deltas, { op: "state.updated", patch: { revision } }];
  }

  private reduce(fact: CanonicalConversationFact): ConversationDelta[] {
    const event = fact.event;
    switch (event.type) {
      case SessionEventType.SessionCreated:
        return this.onSessionCreated(event);
      case SessionEventType.SessionResumed:
        return this.onSessionResumed(event);
      case SessionEventType.SessionTitleUpdated:
        return this.onSessionTitleUpdated(event);
      case SessionEventType.TurnStarted:
        if (fact.semanticKind !== "userIntent") return [];
        return [
          ...this.onTurnStarted(fact),
          // model-only 维护 turn（manual /compact、goal continuation）没有资格
          // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
          ...(this.currentTurnStartedModelOnly
            ? []
            : this.flushPendingSessionHookInvocations(fact.productTurnId)),
        ];
      case SessionEventType.ModelStreaming: {
        if (fact.semanticKind !== "assistantSegment") return [];
        this.guideDrainOpen = false;
        const shouldClearApiRetry =
          this.acceptsActiveModelEvent(event) &&
          isZCodeModelRetryRecoveryProgressPayload(
            event.payload as unknown as Record<string, unknown>,
          );
        const streamingDeltas = this.onModelStreaming(fact);
        return shouldClearApiRetry
          ? [...streamingDeltas, ...this.setApiRetry(null)]
          : streamingDeltas;
      }
      case SessionEventType.ModelNetworkStatus:
        return this.onModelNetworkStatus(event);
      case SessionEventType.StreamRecoveryStarted:
        return this.onStreamRecoveryStarted(event);
      case SessionEventType.StreamRecoveryTailDiscarded:
        return this.onStreamRecoveryTailDiscarded(event);
      case SessionEventType.StreamRecoveryRetryStarted:
        return this.onStreamRecoveryRetryStarted(event);
      case SessionEventType.ModelSelected:
        return this.onModelSelected(event);
      case SessionEventType.ModelComplete:
        return this.onModelComplete(event);
      case SessionEventType.ToolCallScheduled:
        return this.onToolCallScheduled(event);
      case SessionEventType.StreamingToolLedgerUpdated:
        return this.onStreamingToolIdentity(event);
      case SessionEventType.ToolCallStarted:
        return this.onToolCallActivity(event);
      case SessionEventType.ToolCallProgress:
        return this.onToolCallProgress(event);
      case SessionEventType.ToolCallResult:
        return this.onToolCallResult(event);
      case SessionEventType.ToolCallError:
        return this.onToolCallError(event);
      case SessionEventType.PermissionRequested:
        return this.onPermissionRequested(event);
      case SessionEventType.PluginInstallRequested:
        return this.onPluginInstallRequested(event);
      case SessionEventType.PluginInstallResolved:
        return this.acceptsActiveModelEvent(event)
          ? this.settlePermission(
              String((event.payload as { toolCallId: string }).toolCallId),
              "running",
            )
          : [];
      case SessionEventType.PermissionResolved:
        return this.onPermissionResolved(event);
      case SessionEventType.PermissionDenied:
        return this.onPermissionDenied(event);
      case SessionEventType.PluginUiResourceUpdated: {
        // live-only，不改快照；renderer 按 subscribers 派发给沙箱实例。
        const payload = event.payload as PluginUiResourceUpdatedPayload;
        return [
          {
            op: "pluginUi.resourceUpdated",
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            uri: payload.uri,
            subscribers: payload.subscribers,
          },
        ];
      }
      case SessionEventType.PluginUiResourceListChanged: {
        const payload = event.payload as PluginUiResourceListChangedPayload;
        return [
          {
            op: "pluginUi.resourceListChanged",
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            subscribers: payload.subscribers,
          },
        ];
      }
      case SessionEventType.PluginUiInstanceClosed: {
        const payload = event.payload as PluginUiResourceListChangedPayload;
        return [{ op: "pluginUi.instanceClosed", ...payload }];
      }
      case SessionEventType.PluginUiAppToolCallRequested: {
        // App-Provided Tools 信箱：live-only，投递给 subscribers 里唯一的实例。
        const payload = event.payload as PluginUiAppToolCallRequestedPayload;
        return [
          {
            op: "pluginUi.appToolCall",
            activity: payload.activity,
            ...(payload.cancelled ? { cancelled: true } : {}),
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            subscribers: payload.subscribers,
            callId: payload.callId,
            toolName: payload.toolName,
            arguments: payload.arguments,
          },
        ];
      }
      case SessionEventType.UserInputAutoResolutionUpdated:
        return this.onUserInputAutoResolutionUpdated(event);
      case SessionEventType.WorkspaceHookReviewRequested:
        return this.onWorkspaceHookReviewRequested(event);
      case SessionEventType.WorkspaceHookReviewSettled:
        return this.onWorkspaceHookReviewSettled(event);
      case SessionEventType.WorkspaceHookReviewSuperseded:
        return this.onWorkspaceHookReviewSuperseded(event);
      case SessionEventType.WorkspaceHookAdmissionUpdated:
        return this.onWorkspaceHookAdmissionUpdated(event);
      case SessionEventType.WorkspaceMcpAdmissionUpdated: {
        const payload = event.payload as WorkspaceMcpAdmissionUpdatedPayload;
        const workspaceMcpAdmission = payload.pendingCount > 0 ? payload : null;
        return [{ op: "state.updated", patch: { workspaceMcpAdmission } }];
      }
      case SessionEventType.HookRunStarted:
      case SessionEventType.HookRunProgress:
      case SessionEventType.HookRunCompleted:
      case SessionEventType.HookRunFailed:
      case SessionEventType.HookRunBlocked:
        return this.onHookRunLifecycle(event);
      case SessionEventType.TurnSteerQueued:
        return this.onTurnSteerQueued(event);
      case SessionEventType.TurnSteerDeliveryChanged:
        return this.onTurnSteerDeliveryChanged(event);
      case SessionEventType.TurnSteerDispatchChanged:
        return this.onTurnSteerDispatchChanged(event);
      case SessionEventType.TurnSteerEditLockChanged:
        return this.onTurnSteerEditLockChanged(event);
      case SessionEventType.TurnSteerDrained:
        return this.onTurnSteerDrained(event);
      case SessionEventType.TurnSteerDiscarded:
        return this.onTurnSteerDiscarded(event);
      case SessionEventType.SessionInputPromoted:
        return this.onSessionInputPromoted(event);
      case SessionEventType.TurnSteerReordered:
        return this.onTurnSteerReordered(event);
      case SessionEventType.QueueAutoDrainChanged:
        return this.onQueueAutoDrainChanged(event);
      case SessionEventType.FollowupModeChanged:
        return this.onFollowupModeChanged(event);
      case SessionEventType.SessionModeChanged:
        return this.onSessionModeChanged(event);
      case SessionEventType.TurnComplete:
        return this.onTurnComplete(event);
      case SessionEventType.TurnError:
        return this.onTurnError(event);
      case SessionEventType.CompactStarted:
      case SessionEventType.CompactCompleted:
      case SessionEventType.CompactFailed:
        return this.onCompactLifecycle(event);
      case SessionEventType.TargetChanged:
        return this.onTargetChanged(event);
      case SessionEventType.TargetCompletionVerification:
        return this.onTargetVerification(event);
      case SessionEventType.SessionForked:
        return this.onSessionForked(event);
      case SessionEventType.WorktreeCreated:
        return this.onWorktreeCreated(event);
      case SessionEventType.RewindTriggered:
        return this.onRewindTriggered(event);
      case SessionEventType.BackgroundTaskStarted:
      case SessionEventType.BackgroundTaskUpdated:
      case SessionEventType.BackgroundTaskCompleted:
        return this.onBackgroundTaskLifecycle(event);
      case SessionEventType.DynamicWorkflowRunProgress:
        return this.onDynamicWorkflowRunProgress(event);
      case SessionEventType.SubagentSpawned:
        return this.onSubagentSpawned(event);
      case SessionEventType.SubagentMessage:
        return this.onSubagentMessage(event);
      case SessionEventType.SubagentStopped:
        return this.onSubagentStopped(event);
      default:
        return [];
    }
  }

  /** A persisted started-only Hook cannot still be running after a real runtime resume. */
  private onSessionResumed(event: SessionEvent): ConversationDelta[] {
    const endedAt = this.ms(event);
    const deltas: ConversationDelta[] = [];
    // Runtime epoch 切换前尚未归位的 session Hook 不得附着到新 epoch 的下一轮；
    // 新 Runtime 会重新产生自己的 resume SessionStart lifecycle。
    this.pendingSessionHookInvocations.clear();
    for (const row of this.snapshot.rows.window) {
      if (row.kind !== "hookInvocation" || row.state !== "running") continue;
      const executions = row.executions.map(
        (execution): HookExecutionProjection =>
          execution.state === "running"
            ? {
                ...execution,
                state: "failed",
                outcome: "cancelled",
                endedAt,
                durationMs: Math.max(0, endedAt - execution.startedAt),
              }
            : execution,
      );
      deltas.push({
        op: "row.upserted",
        row: {
          ...row,
          state: "failed",
          executions,
          endedAt,
          durationMs: Math.max(0, endedAt - row.startedAt),
        },
      });
    }
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (interaction) =>
        interaction.payload.kind !== "workspaceHookReview" &&
        interaction.payload.kind !== "pluginInstall",
    );
    if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
      // reviewFlowId/generation 只在单个 Runtime controller 内单调。
      // Runtime 重启后旧 Requested 会先被 replay，而新 flow 又从 generation=1 开始；
      // SessionResumed 是明确的新 Runtime epoch 边界，必须先淘汰旧 Runtime 无法再解析的审核。
      deltas.push({ op: "state.updated", patch: { pendingInteractions } });
    }
    // 软门禁:resume 后 activate 会重新上报 admission 状态。
    // epoch 清理时置 null,避免旧 Runtime 的提示条残留到新 Runtime 接管前。
    if (this.snapshot.workspaceHookAdmission !== null) {
      deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
    }
    // 冷恢复的旧提示不是当前授权事实，等新 gate 重读后再显示。
    if (this.snapshot.workspaceMcpAdmission) {
      deltas.push({ op: "state.updated", patch: { workspaceMcpAdmission: null } });
    }
    return deltas;
  }

  private onHookRunLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as HookRunLifecyclePayload;
    const hookInvocationId = payload.hookInvocationId;
    const hookCount = payload.hookCount;
    if (
      !hookInvocationId ||
      !payload.hookRunId ||
      !Number.isInteger(hookCount) ||
      (hookCount ?? 0) <= 0 ||
      !Number.isInteger(payload.hookIndex) ||
      payload.hookIndex < 0
    ) {
      return [];
    }
    if (this.rewoundHookInvocationIds.has(hookInvocationId)) return [];

    const rowId = this.hookRowIdByInvocationId.get(hookInvocationId);
    const existing = rowId === undefined ? undefined : this.findRow(rowId);
    const existingRow = existing?.kind === "hookInvocation" ? existing : undefined;
    const pending = this.pendingSessionHookInvocations.get(hookInvocationId);
    const previousExecutions = existingRow?.executions ?? pending?.content.executions ?? [];
    const previousExecution = previousExecutions.find(
      (execution) => execution.hookRunId === payload.hookRunId,
    );
    const descriptor = payload.descriptor;
    if (
      !previousExecution &&
      (descriptor?.clientVisible !== true || descriptor.sourceKind === "internal")
    ) {
      return [];
    }
    const state = this.hookExecutionState(event.type);
    const startedAt =
      typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt)
        ? payload.startedAt
        : (previousExecution?.startedAt ?? this.ms(event));
    const endedAt = state === "running" ? undefined : this.ms(event);
    const durationMs =
      typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
        ? Math.max(0, payload.durationMs)
        : endedAt === undefined
          ? undefined
          : Math.max(0, endedAt - startedAt);
    const outcome = this.hookExecutionOutcome(event.type, payload.outcome);
    const didExecute =
      previousExecution?.didExecute === true || event.type === SessionEventType.HookRunStarted;
    const sourceKind = previousExecution?.sourceKind ?? descriptor?.sourceKind;
    if (sourceKind === undefined || sourceKind === "internal") return [];
    const blockReason = payload.blockReason ?? previousExecution?.blockReason;
    const execution: HookExecutionProjection = {
      hookRunId: String(payload.hookRunId),
      hookIndex: payload.hookIndex,
      didExecute,
      state,
      ...(outcome ? { outcome } : {}),
      ...(blockReason ? { blockReason } : {}),
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      displayName:
        previousExecution?.displayName ??
        (descriptor
          ? hookExecutionDisplayName(descriptor, payload.hookIndex)
          : `Hook #${payload.hookIndex + 1}`),
      sourceKind,
      ...(previousExecution?.pluginName || descriptor?.pluginName
        ? { pluginName: previousExecution?.pluginName ?? descriptor?.pluginName }
        : {}),
      ...(payload.toolName || previousExecution?.toolName
        ? { toolName: payload.toolName ?? previousExecution?.toolName }
        : {}),
    };
    const byRunId = new Map(
      previousExecutions.map((candidate) => [candidate.hookRunId, candidate]),
    );
    byRunId.set(execution.hookRunId, execution);
    const executions = [...byRunId.values()].toSorted(
      (left, right) => left.hookIndex - right.hookIndex,
    );
    const rowState = this.hookInvocationState(executions, hookCount as number);
    const invocationStartedAt = Math.min(...executions.map((candidate) => candidate.startedAt));
    const invocationEndedAt =
      rowState === "running"
        ? undefined
        : Math.max(...executions.map((candidate) => candidate.endedAt ?? candidate.startedAt));

    const content: HookInvocationRowContent = {
      kind: "hookInvocation",
      hookInvocationId,
      hookEventName: payload.hookEventName,
      hookCount: hookCount as number,
      state: rowState,
      startedAt: invocationStartedAt,
      ...(invocationEndedAt !== undefined
        ? {
            endedAt: invocationEndedAt,
            durationMs: Math.max(0, invocationEndedAt - invocationStartedAt),
          }
        : {}),
      lane: this.hookInvocationLane(payload.hookEventName),
      ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
      executions,
    };

    if (existingRow) {
      const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
      return [
        {
          op: "row.upserted",
          row: {
            ...existingRow,
            ...content,
          },
        },
        ...(blockErrorDelta ? [blockErrorDelta] : []),
      ];
    }

    if (
      pending ||
      !event.turnId ||
      // 维护 turn 排除只属于 SessionStart——首条输入即 /compact 时
      // SessionStart Hook 携带 compact turnId 到达，不能直挂，先入 pending 等
      // 真实 turn。model-only ≠ 维护 turn：background_task / subagent_message /
      // goal continuation 轮同样是 model-only，但它们是会真实跑工具的 agent 轮，
      // 其 PreToolUse/PostToolUse/Stop 必须按 event.turnId 直挂原轮（与 cold
      // merge 归属对齐），否则会被 pending 吞掉、错误堆到下一个用户轮。
      (payload.hookEventName === "SessionStart" &&
        (this.currentTurnId === null || this.currentTurnStartedModelOnly))
    ) {
      // startup SessionStart 虽可能已经携带 runtime turnId，但此时 TurnStarted 尚未建立
      // runtimeTurnId -> productTurnId 映射；提前 append 会把它拆成独立 footer。
      this.pendingSessionHookInvocations.set(hookInvocationId, {
        firstEvent: pending?.firstEvent ?? event,
        content,
      });
      return [];
    }

    const turnId = this.turnIdOf(event);
    const rowBase = this.rowBase(event, turnId, hookInvocationId);
    const row: HookInvocationRow = {
      ...rowBase,
      ...content,
    };
    this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
    const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
    return [{ op: "row.appended", row }, ...(blockErrorDelta ? [blockErrorDelta] : [])];
  }

  /**
   * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
   * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
   * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
   */
  private hookBlockErrorDelta(
    event: SessionEvent,
    payload: HookRunLifecyclePayload,
    didExecute: boolean,
    blockReason: string | undefined,
  ): ConversationDelta | null {
    if (
      event.type !== SessionEventType.HookRunBlocked ||
      payload.hookEventName !== "UserPromptSubmit" ||
      !didExecute ||
      !blockReason
    ) {
      return null;
    }
    const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
      .map((value) => value?.trim())
      .find((value) => value && value !== blockReason);
    const displayReason = diagnosticMessage ?? blockReason;
    const message =
      displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
        ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
        : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
    const detail = [
      `Hook block reason: ${blockReason}`,
      ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
    ].join("\n");
    return {
      op: "state.updated",
      patch: this.controlPatch({
        lastError: {
          code: "fault.runtime.hookBlocked",
          message,
          recoverable: false,
          at: this.ms(event),
          source: "runtime",
          traceId: String(event.traceId),
          ...(detail ? { detail } : {}),
          attribution: {
            source: "runtime",
            reason: "hook_blocked",
          },
        },
      }),
    };
  }

  private flushPendingSessionHookInvocations(turnId: string): ConversationDelta[] {
    if (this.pendingSessionHookInvocations.size === 0) return [];
    const deltas: ConversationDelta[] = [];
    for (const [hookInvocationId, pending] of this.pendingSessionHookInvocations) {
      const row: HookInvocationRow = {
        ...this.rowBase(pending.firstEvent, turnId, hookInvocationId),
        ...pending.content,
      };
      this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
      deltas.push({ op: "row.appended", row });
    }
    this.pendingSessionHookInvocations.clear();
    return deltas;
  }

  private hookExecutionState(eventType: SessionEvent["type"]): HookExecutionProjection["state"] {
    if (eventType === SessionEventType.HookRunFailed) return "failed";
    if (
      eventType === SessionEventType.HookRunCompleted ||
      eventType === SessionEventType.HookRunBlocked
    ) {
      return "completed";
    }
    return "running";
  }

  private hookExecutionOutcome(
    eventType: SessionEvent["type"],
    outcome: HookRunLifecyclePayload["outcome"],
  ): HookExecutionProjection["outcome"] {
    if (outcome) return outcome;
    if (eventType === SessionEventType.HookRunCompleted) return "success";
    if (eventType === SessionEventType.HookRunBlocked) return "blocked";
    if (eventType === SessionEventType.HookRunFailed) return "failed";
    return undefined;
  }

  private hookInvocationState(
    executions: readonly HookExecutionProjection[],
    hookCount: number,
  ): HookInvocationRow["state"] {
    if (
      executions.length < hookCount ||
      executions.some((execution) => execution.state === "running")
    ) {
      return "running";
    }
    return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
  }

  private hookInvocationLane(
    eventName: HookRunLifecyclePayload["hookEventName"],
  ): HookInvocationRow["lane"] {
    if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
    if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
    return "assistantWork";
  }

  /**
   * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
   * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
   * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
   * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
   * 由 transcript 合成 hydration 兜底重建。
   * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
   */
  private onRewindTriggered(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      targetMessageId?: string;
      scope?: string;
      branchCutAfterMessageId?: string;
      branchGeneration?: number;
      createdMessageId?: string;
      reason?: string;
    };
    if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
      const targetMessageId = payload.targetMessageId;
      if (!targetMessageId) return [];
      const targetRowId = this.rowIdForMessageId(targetMessageId);
      if (targetRowId === null) return [];
      const targetRow = this.findRow(targetRowId);
      if (!targetRow) return [];
      const headerRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId);
      const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
      if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
      return [
        {
          op: "row.upserted",
          row: {
            ...headerRow,
            fileChanges: {
              ...headerRow.fileChanges,
              state: "reverted",
            },
          },
        },
      ];
    }
    // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
    // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
    const applied =
      (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
      payload.createdMessageId !== undefined;
    if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = this.rowIdForMessageId(targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = this.findRow(targetRowId);
    if (!targetRow) return [];
    // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
    const turnHeaderRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
    const fromRowId = Math.min(turnHeaderRowId, targetRowId);
    // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
    for (const [rowId] of this.messageIdByRowId) {
      if (rowId >= fromRowId) this.messageIdByRowId.delete(rowId);
    }
    for (const [messageId, rowId] of this.outputContinuationRowIdByMessageId) {
      if (rowId >= fromRowId) this.outputContinuationRowIdByMessageId.delete(messageId);
    }
    for (const [rowId, entityId] of this.entityIdByRowId) {
      if (rowId >= fromRowId) {
        this.entityIdByRowId.delete(rowId);
        this.editTargetByEntityId.delete(entityId);
      }
    }
    for (const [hookInvocationId, rowId] of this.hookRowIdByInvocationId) {
      if (rowId >= fromRowId) {
        this.rewoundHookInvocationIds.add(hookInvocationId);
        this.hookRowIdByInvocationId.delete(hookInvocationId);
      }
    }
    return [{ op: "row.removed", fromRowId }];
  }

  /** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
  private rowIdForMessageId(messageId: string): number | null {
    const continuationRowId = this.outputContinuationRowIdByMessageId.get(messageId);
    if (continuationRowId !== undefined) return continuationRowId;
    for (const [rowId, mid] of this.messageIdByRowId) {
      if (mid === messageId) return rowId;
    }
    return null;
  }

  /**
   * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
   * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
   * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
   */
  getTurnRewindAnchor(rowId: number): string | null {
    return this.rewindAnchorForRows(this.snapshot.rows.window, rowId);
  }

  private rewindAnchorForRows(rows: readonly ConversationRow[], rowId: number): string | null {
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (!row) return null;
    const turnId = row.turnId;
    for (const [candidateRowId, messageId] of this.messageIdByRowId) {
      const candidate = rows.find((item) => item.rowId === candidateRowId);
      if (candidate && candidate.turnId === turnId) return messageId;
    }
    return null;
  }

  /**
   * real-user row 的展示身份与命令身份必须原子登记。
   * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
   * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
   */
  private registerCanonicalUserRowTarget(
    rowId: number,
    entityId: string,
    editTarget?: ConversationEditTarget,
  ): void {
    this.entityIdByRowId.set(rowId, entityId);
    if (!editTarget) return;
    this.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
    this.editTargetByEntityId.set(entityId, editTarget);
  }

  // ── 生命周期 ──

  private onSessionCreated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { contextWindow?: number };
    this.contextWindowState.maxTokens = payload.contextWindow ?? null;
    // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
    return [];
  }

  // renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
  // custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。
  private onSessionTitleUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      title?: string;
      source?: string;
    };
    const title = payload.title ?? "";
    // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
    // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
    const source: "default" | "generated" | "custom" =
      payload.source === "custom"
        ? "custom"
        : payload.source === "default"
          ? "default"
          : "generated";
    const prev = this.snapshot.meta;
    if (prev.titleSource === "custom" && source === "generated") return [];
    if (prev.title === title && prev.titleSource === source) return [];
    return [
      {
        op: "state.updated",
        patch: { meta: { title, titleSource: source } },
      },
    ];
  }

  private onTurnStarted(fact: CanonicalUserIntentFact): ConversationDelta[] {
    const event = fact.event;
    const runtimeTurnId = fact.runtimeTurnId;
    const turnId = fact.productTurnId;
    this.currentTurnId = runtimeTurnId;
    this.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
    // 新 runtimeTurn：product turn 映射归零（1:1），工时基准 = 本轮起点。
    this.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
    if (turnId !== runtimeTurnId) this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
    this.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
    this.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
    this.currentProductTurnStartedAtMs = this.ms(event);
    this.streamingTextRowId = null;
    this.streamingReasoningRowId = null;
    this.outputContinuationTextRowId = null;
    this.guideDrainOpen = false;

    // background Agent 的 ToolCallResult 只是 launch ACK，先把工具行收口成
    // success；子 Agent 的真实终态随后只作为 model-only task-notification 开新轮。
    // V4 过去没有按 tool-use-id 消费这条权威事实，因此 429 后卡片会永久停在 completed。
    const deltas: ConversationDelta[] = this.applyBackgroundTaskNotification(fact);
    const sharedContextRef = fact.sharedContextRefs?.[0];
    if (
      sharedContextRef &&
      this.snapshot.sharedContextImport &&
      "contextId" in this.snapshot.sharedContextImport &&
      this.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
      (this.snapshot.sharedContextImport.status === "pending" ||
        this.snapshot.sharedContextImport.status === "reserved")
    ) {
      const sharedContextImport = {
        ...this.snapshot.sharedContextImport,
        status: "attached" as const,
      };
      this.snapshot = { ...this.snapshot, sharedContextImport };
      deltas.push({ op: "state.updated", patch: { sharedContextImport } });
    }
    // marker 时机：只有当
    // 本轮实际使用的 provider/model 身份与上一轮不同时，才在 turnHeader 之前落
    // modelChange marker。普通首轮 silentInitial 不产 marker；显式 sourceLess 边界
    // 生成“正在使用”marker。思考深度变化只更新 config.thought，不是模型身份变化。
    // Bug 背景：旧实现在 onModelSelected（切换动作时）即落 marker，草稿态预热会话
    // 切一次模型就会在首条消息上方挂出 [modelChange]。
    if (this.pendingWorktreeCreated) {
      const pending = this.pendingWorktreeCreated;
      this.pendingWorktreeCreated = null;
      deltas.push({
        op: "row.appended",
        row: this.worktreeCreatedRow(pending.event, turnId, pending.payload, "lightBoundary"),
      });
    }
    const config = this.snapshot.config;
    const hasModel = config.provider !== "" && config.model !== "";
    if (hasModel && this.lastTurnModel.kind === "sourceLess") {
      deltas.push({
        op: "row.appended",
        row: {
          ...this.rowBase(
            event,
            turnId,
            `model-initial:${turnId}:${config.provider}/${config.model}`,
          ),
          kind: "timelineMarker",
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            toProvider: config.provider,
            toModel: config.model,
            toThought: config.thought,
          },
        },
      });
    } else if (
      hasModel &&
      this.lastTurnModel.kind === "known" &&
      (this.lastTurnModel.provider !== config.provider || this.lastTurnModel.model !== config.model)
    ) {
      deltas.push({
        op: "row.appended",
        row: {
          ...this.rowBase(
            event,
            turnId,
            `model-change:${turnId}:${this.lastTurnModel.provider}/${this.lastTurnModel.model}->${config.provider}/${config.model}`,
          ),
          kind: "timelineMarker",
          // lane 由投影裁决（UI 不得按 marker type 自行推断落位语义）。
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            fromProvider: this.lastTurnModel.provider,
            fromModel: this.lastTurnModel.model,
            toProvider: config.provider,
            toModel: config.model,
            toThought: config.thought,
          },
        },
      });
    }
    if (hasModel) {
      this.lastTurnModel = {
        kind: "known",
        provider: config.provider,
        model: config.model,
        thought: config.thought,
      };
    }
    const headerBase = this.rowBase(event, turnId, turnId);
    const header: TurnHeaderRow = {
      ...headerBase,
      kind: "turnHeader",
      origin: fact.turnHeaderOrigin,
      executionKind: fact.executionKind,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      state: "running",
      startedAt: headerBase.createdAt,
    };
    this.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
    deltas.push({ op: "row.appended", row: header });

    // model-only 输入（goal continuation 等）不产生可见 userInput row。
    if (fact.visibility === "visible") {
      const rowBase = this.rowBase(event, turnId, fact.entityId);
      const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
      const attachments = fact.attachments?.map((attachment, index) => ({
        ...attachment,
        ref: attachment.ref ?? `turn-attachment/${rowBase.rowId}/${index}`,
      }));
      const row: UserInputRow = {
        ...rowBase,
        kind: "userInput",
        text:
          fact.conversationQuotes || fact.botGroupSource
            ? (fact.intentText ?? fact.input)
            : fact.input,
        origin: fact.origin,
        ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
        ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
        ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
        ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
        ...userInputSubmittedConfig(fact),
        ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
        ...(fact.clientId ? { clientId: fact.clientId } : {}),
        ...(fact.highspeed ? { highspeed: fact.highspeed } : {}),
        ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
        ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(fact.source ? { source: fact.source } : {}),
      };
      // workspace checkpoint 以 user messageId 为 targetMessageId。
      // 普通 TurnStarted 也要登记 userInput row 的内部锚点，否则文件摘要 query
      // 只能找到 assistant messageId，展开列表会查不到该轮 checkpoint。
      this.registerCanonicalUserRowTarget(
        row.rowId,
        fact.entityId,
        fact.transcriptMessageId
          ? {
              entityId: fact.entityId,
              productTurnId: fact.productTurnId,
              transcriptMessageId: fact.transcriptMessageId,
              coveredByStableCompact: false,
              intent: {
                kind: fact.intentKind,
                text: fact.intentText,
                genUiContext: fact.genUiContext,
                ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
                ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
                ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
                ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
                ...(fact.clientId ? { clientId: fact.clientId } : {}),
                ...(fact.attachments ? { attachments: fact.attachments } : {}),
                ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
                ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
                ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
                ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
                ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
                ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
                ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
                ...(fact.mode ? { mode: fact.mode } : {}),
                ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
                ...(fact.provenance ? { provenance: fact.provenance } : {}),
              },
            }
          : undefined,
      );
      deltas.push({
        op: "row.appended",
        row,
      });
    }

    if (fact.executionKind === "agent") {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          phase: "running",
          sessionEnded: false,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
          activeWorks: [
            {
              kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
              ...(fact.foregroundExecutionId
                ? { foregroundExecutionId: fact.foregroundExecutionId }
                : {}),
              // 自动中断必须关联实际执行输入，不能由客户端按最后一条消息猜测。
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              startedAt: this.ms(event),
            },
          ],
          // 新一轮被接受后，旧错误不再是当前事实（与旧 reducer 同一裁决）。
          lastError: null,
          apiRetry: null,
        }),
      });
    }
    // /goal 的可见 query 用 controlOnly turn 建立 live 时间线身份，
    // 但真实执行属于紧随其后的 goalContinuation。若控制轮也推进 running，连续链路
    // 会短暂生成第二份 activeWorks，恢复投影也会出现伪造的工作生命周期。
    return deltas;
  }

  private applyBackgroundTaskNotification(fact: CanonicalUserIntentFact): ConversationDelta[] {
    // 终态与失败原文优先取本轮 originMeta 的结构化结果，不解析 summary 文本。
    // 合并轮的每条通知各自更新自己的工具行。
    return parseZCodeBackgroundTaskNotifications(fact.input, fact.originMeta).flatMap((parsed) =>
      this.applyBackgroundTaskNotificationBlock(fact, parsed),
    );
  }

  private applyBackgroundTaskNotificationBlock(
    fact: CanonicalUserIntentFact,
    parsed: ZCodeParsedBackgroundTaskNotification,
  ): ConversationDelta[] {
    const row = this.findToolRow(parsed.toolUseId);
    if (!row) return [];

    const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
      parsed.notification.status,
    );
    const status: ToolCallRow["status"] =
      notificationStatus === "failed"
        ? "error"
        : notificationStatus === "stopped"
          ? "cancelled"
          : "success";
    const content =
      parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
    const next: ToolCallRow = {
      ...row,
      status,
      ...(content
        ? {
            output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
          }
        : {}),
      endedAt: this.ms(fact.event),
    };
    if (status === "error") {
      next.error = {
        code: "fault.runtime.backgroundTaskFailed",
        message: parsed.notification.error ?? content ?? "Background task failed.",
      };
    } else {
      delete next.error;
    }
    return [{ op: "row.upserted", row: next }];
  }

  private onTurnComplete(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnCompletePayload;
    this.outputContinuationTextRowId = null;
    const headerState = mapTurnResultToHeaderState(payload.resultType);
    const header = this.turnHeaderForEvent(event);
    if (header?.executionKind === "controlOnly") {
      // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
      // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
      // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
      const deltas = [
        ...this.upsertTurnHeader(event, headerState, undefined, payload.historyRoundCount),
        ...this.leaveDraftAfterControlOnlyTurn(
          payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
        ),
      ];
      this.currentTurnId = null;
      // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
      this.currentTurnStartedModelOnly = false;
      return deltas;
    }
    const phase: SessionControl["phase"] =
      payload.resultType === "success"
        ? "completedSuccess"
        : payload.resultType === "cancelled"
          ? "completedInterrupted"
          : "error";
    const streamClose = payload.resultType === "success" ? "complete" : "interrupted";
    const activeMs = this.activeMsForCompletion(event, payload.duration);

    // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
    // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
    const goal = this.snapshot.goal;
    const pausedGoal: GoalState | undefined =
      payload.resultType === "cancelled" &&
      (goal?.status === "active" || goal?.status === "verifying")
        ? { ...goal, status: "paused" }
        : undefined;

    // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
    // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
    const heldQueue =
      payload.resultType === "cancelled" &&
      payload.preserveQueueAutoDrainOnCancel !== true &&
      this.snapshot.queue.items.length > 0 &&
      (this.snapshot.queue.autoDrain || this.snapshot.queue.pauseReason !== "stopped")
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "stopped" as const,
          }
        : undefined;

    const deltas: ConversationDelta[] = [
      ...this.closeStreamingRows(streamClose),
      // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
      // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
      ...this.closeOpenToolRows(event, payload.resultType === "cancelled" ? "cancelled" : "error"),
      ...this.upsertTurnHeader(
        event,
        headerState,
        activeMs,
        payload.historyRoundCount,
        this.highspeedTimingForTurn(this.turnIdOf(event), activeMs),
      ),
      ...(payload.resultType === "success" ? this.markStableForkAssistant(event) : []),
      {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase,
            sessionEnded: phase !== "error",
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
            // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
            apiRetry: null,
          },
          pausedGoal,
          heldQueue,
        ),
      },
    ];
    this.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    this.currentTurnStartedModelOnly = false;
    return deltas;
  }

  /**
   * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
   * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
   * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
   * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
   * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
   * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
   * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
   */
  private leaveDraftAfterControlOnlyTurn(
    phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
  ): ConversationDelta[] {
    if (this.snapshot.control.phase !== "draft") return [];
    return [
      {
        op: "state.updated",
        patch: this.controlPatch({
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
        }),
      },
    ];
  }

  private onTurnError(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnErrorPayload;
    this.outputContinuationTextRowId = null;
    if (this.turnHeaderForEvent(event)?.executionKind === "controlOnly") {
      const deltas = [
        ...this.upsertTurnHeader(event, "failed"),
        ...this.leaveDraftAfterControlOnlyTurn("error"),
      ];
      this.currentTurnId = null;
      // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
      this.currentTurnStartedModelOnly = false;
      return deltas;
    }
    // TurnError 结束的是当前 turn，
    // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
    // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
    // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
    const heldQueue =
      this.snapshot.queue.items.length > 0
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "error" as const,
          }
        : undefined;
    return [
      ...this.closeStreamingRows("interrupted"),
      ...this.closeOpenToolRows(event, "error"),
      ...this.upsertTurnHeader(
        event,
        "failed",
        undefined,
        undefined,
        this.highspeedTimingForTurn(this.turnIdOf(event)),
      ),
      {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: "error",
            sessionEnded: false,
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
            lastError: {
              code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
              message: payload.error.message,
              recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
              at: this.ms(event),
              // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
              source: payload.error.attribution?.source ?? "runtime",
              traceId: String(event.traceId),
              ...(payload.error.detail ? { detail: payload.error.detail } : {}),
              ...(payload.error.underlyingErrorMessage
                ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
                : {}),
              ...(payload.error.underlyingErrorDetail
                ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
                : {}),
              ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
            },
            // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
            apiRetry: null,
          },
          undefined,
          heldQueue,
        ),
      },
    ];
  }

  // ── 流式输出 ──

  private onModelNetworkStatus(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as ModelNetworkStatusPayload;
    if (
      (payload.querySource === undefined || payload.querySource === "main_turn") &&
      (payload.type === "model_request_completed" || payload.type === "model_request_failed") &&
      // 加速卡按 family 拆成了多个隐藏 Provider（zai/bigmodel），不能再和单个常量比较，
      // 否则 BigModel 账号的加速轮会被判成普通轮、节省时间恒为 0。
      isHighspeedProviderId(payload.providerId) &&
      payload.durationMs !== undefined
    ) {
      // Bug 根因：混合 Turn 卡过期后会切到普通 provider，旧逻辑把普通模型的重试/超时
      // 也累计进 Highspeed modelDurationMs，导致节省时间按高速倍率放大数小时。
      const turnId = this.turnIdOf(event);
      this.highspeedModelDurationByTurnId.set(
        turnId,
        (this.highspeedModelDurationByTurnId.get(turnId) ?? 0) + Math.max(0, payload.durationMs),
      );
    }
    switch (payload.type) {
      case "model_retry_scheduled": {
        const attempt = positiveInteger(payload.attempt, 1);
        const maxAttempts = Math.max(
          positiveInteger(payload.maxAttempts, attempt + 1),
          attempt + 1,
        );
        return this.setApiRetry({
          attempt,
          maxAttempts,
          nextRetryAt: this.ms(event) + nonNegativeInteger(payload.delayMs, 0),
          reasonCode:
            payload.errorCode === ModelErrorCode.ModelRequestVerificationConfigNetwork
              ? ModelErrorCode.ModelRequestVerificationConfigNetwork
              : modelRetryReasonCode(payload.reason),
        });
      }
      case "model_request_started":
        if (payload.streamRecovery) {
          return this.setApiRetry(
            this.streamRecoveryApiRetry(
              payload.streamRecovery.retryNumber,
              payload.streamRecovery.maxRetries,
              this.ms(event),
              this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
            ),
          );
        }
        // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
        // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
        return positiveInteger(payload.attempt, 1) <= 1 ? this.setApiRetry(null) : [];
      case "model_request_completed":
        return this.setApiRetry(null);
      case "model_request_failed":
        return payload.retryable ? [] : this.setApiRetry(null);
      case "model_stream_stalled":
      case "model_first_provider_event":
      case "model_first_content":
      case "model_first_text":
      // 准入等待的两端是 runtime 观测，不是 UI 状态：
      // 不映射成重试/等待标签。
      case "model_request_queued":
      case "model_request_admitted":
      case "model_request_observation":
        return [];
    }
  }

  private onStreamRecoveryStarted(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamRecoveryStartedPayload;
    return this.setApiRetry(
      this.streamRecoveryApiRetry(
        payload.retryNumber,
        payload.maxRetries,
        this.ms(event),
        streamRecoveryReasonCode(payload.failureKind),
      ),
    );
  }

  private onStreamRecoveryTailDiscarded(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
    // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
    // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
    // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
    // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
    // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
    // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
    return [
      ...this.closeStreamingRows("interrupted"),
      ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
    ];
  }

  private onStreamRecoveryRetryStarted(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamRecoveryRetryStartedPayload;
    return this.setApiRetry(
      this.streamRecoveryApiRetry(
        payload.retryNumber,
        payload.maxRetries,
        this.ms(event),
        this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
      ),
    );
  }

  private streamRecoveryApiRetry(
    retryNumber: number,
    maxRetriesValue: number,
    nextRetryAt: number,
    reasonCode: string,
  ): ApiRetryState {
    const attempt = positiveInteger(retryNumber, 1);
    const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
    return {
      attempt,
      maxAttempts: maxRetries + 1,
      nextRetryAt,
      reasonCode,
    };
  }

  private setApiRetry(apiRetry: ApiRetryState | null): ConversationDelta[] {
    const current = this.snapshot.control.apiRetry;
    if (
      current === apiRetry ||
      (current !== null &&
        apiRetry !== null &&
        current.attempt === apiRetry.attempt &&
        current.maxAttempts === apiRetry.maxAttempts &&
        current.nextRetryAt === apiRetry.nextRetryAt &&
        current.reasonCode === apiRetry.reasonCode)
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.controlPatch({ apiRetry }),
      },
    ];
  }

  private acceptsActiveModelEvent(event: SessionEvent): boolean {
    if (!this.isRunning()) return false;
    // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
    // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
    return (
      this.currentTurnId === null ||
      event.turnId === undefined ||
      String(event.turnId) === this.currentTurnId
    );
  }

  private onModelStreaming(fact: CanonicalAssistantSegmentFact): ConversationDelta[] {
    const event = fact.event;
    // 迟到终态不复活：非运行期到达的流式事件一律拒收。
    // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
    // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
    // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
    // 下次订阅强制重新 hydration 从持久事实补齐。
    if (!this.isRunning()) {
      const dropped = fact.stream;
      if (
        dropped.kind === "text_start" ||
        dropped.kind === "text_delta" ||
        dropped.kind === "reasoning_start" ||
        dropped.kind === "reasoning_delta"
      ) {
        this.droppedContentStreamEventCount += 1;
      }
      return [];
    }
    const payload = fact.stream;
    switch (payload.kind) {
      case "text_start":
        return this.openTextRow(event, fact);
      case "text_delta": {
        const open = this.streamingTextRowId === null ? this.openTextRow(event, fact) : [];
        return [
          ...open,
          {
            op: "row.delta",
            rowId: this.streamingTextRowId as number,
            path: "text",
            append: payload.delta,
          },
        ];
      }
      case "text_end":
        return this.closeTextRow("complete");
      case "reasoning_start":
        return this.openReasoningRow(event, fact);
      case "reasoning_delta": {
        const open =
          this.streamingReasoningRowId === null ? this.openReasoningRow(event, fact) : [];
        return [
          ...open,
          {
            op: "row.delta",
            rowId: this.streamingReasoningRowId as number,
            path: "text",
            append: payload.delta,
          },
        ];
      }
      case "reasoning_end":
        return this.closeReasoningRow();
      case "tool_input_start":
        return this.openToolRow(event, payload, fact.entityId);
      case "tool_input_delta": {
        return this.appendStreamingToolInput(event, payload);
      }
      case "tool_input_end":
        return this.flushStreamingToolInput(String(payload.toolCallId ?? ""));
      case "tool_call":
        return this.finalizeStreamingToolInput(event, payload);
      default:
        return [];
    }
  }

  private openTextRow(
    event: SessionEvent,
    fact: CanonicalAssistantSegmentFact,
  ): ConversationDelta[] {
    const close = this.closeTextRow("complete");
    const continuationRowId = this.outputContinuationTextRowId;
    this.outputContinuationTextRowId = null;
    const continuationRow =
      continuationRowId === null ? undefined : this.findRow(continuationRowId);
    const currentTurnId = this.turnIdOf(event);
    const lastVisibleRow = this.snapshot.rows.window.at(-1);
    if (
      continuationRow?.kind === "assistantText" &&
      continuationRow.turnId === currentTurnId &&
      lastVisibleRow?.rowId === continuationRow.rowId
    ) {
      // runtime 的 output-token Continue 会为每次 provider 请求创建新的
      // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
      // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
      // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
      const {
        actions: _actions,
        assistantResponseId: _assistantResponseId,
        feedback: _feedback,
        ...continuedBase
      } = continuationRow;
      const row: AssistantTextRow = {
        ...continuedBase,
        entityId: fact.entityId,
        ...(fact.stream.assistantResponseId
          ? { assistantResponseId: fact.stream.assistantResponseId }
          : {}),
        state: "streaming",
      };
      this.streamingTextRowId = row.rowId;
      this.entityIdByRowId.set(row.rowId, fact.entityId);
      const previousMessageId = this.messageIdByRowId.get(row.rowId);
      if (previousMessageId) {
        this.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
      }
      if (fact.transcriptMessageId) {
        this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
      }
      return [...close, { op: "row.upserted", row }];
    }

    // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
    const row: AssistantTextRow = {
      ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
      kind: "assistantText",
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      text: "",
      state: "streaming",
    };
    this.streamingTextRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
    if (fact.transcriptMessageId) {
      this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.appended", row }];
  }

  private closeTextRow(state: "complete" | "interrupted"): ConversationDelta[] {
    if (this.streamingTextRowId === null) return [];
    const row = this.findRow(this.streamingTextRowId);
    this.streamingTextRowId = null;
    if (row?.kind !== "assistantText") return [];
    return [{ op: "row.upserted", row: { ...row, state } }];
  }

  private onAssistantFeedbackUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as AssistantFeedbackUpdatedPayload;
    // 一条消息有多个文字块时，live 与冷恢复都是一块一行；UI 从最后一个文字行读反馈，
    // 写到第一行会让反馈在多行时不显示（docs/chat/assistant-latest-part-actions.md）。
    const row = this.snapshot.rows.window.findLast(
      (candidate): candidate is AssistantTextRow =>
        candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    if (payload.feedback === null) {
      if (row.feedback === undefined) return [];
      const { feedback: _removedFeedback, ...withoutFeedback } = row;
      return [{ op: "row.upserted", row: withoutFeedback }];
    }
    if (row.feedback === payload.feedback) return [];
    return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
  }

  private onHighspeedMetricsUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as HighspeedMetricsUpdatedPayload;
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" && candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    // Bug 根因：终态指标更新曾整体替换 row.highspeed。payload 来自 transcript 原始 metadata + 耗时字段，
    // 不含 live 投影刚由 TurnExecutionModelFallback 写入的 fallbackAt；降级 Toast 依赖的字段被清空，
    // live 与 cold/replay 的结果也不一致。指标更新是增量补充：字段级合并、只增不删（spec §5）。
    return [
      {
        op: "row.upserted",
        row: { ...row, highspeed: { ...row.highspeed, ...payload.highspeed } },
      },
    ];
  }

  private onTurnExecutionModelFallback(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnExecutionModelFallbackPayload;
    // Bug 根因：fallback 会作废当前 assistant attempt，但旧投影只更新输入行元数据，仍把旧模型的
    // text/reasoning row 留在 streaming；原模型续流时这些内容会被误标 complete，缺少 text_start 时
    // 甚至直接拼到同一行。未定稿的 tool input 同样不会收到 tool_call，必须随废弃 attempt 一起收口。
    // 已提交执行的工具不在这里处理，它们由 core 的 tool_abandoned 事件收口。
    const discardedStreamDeltas = this.acceptsActiveModelEvent(event)
      ? [
          ...this.closeStreamingRows("interrupted"),
          ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
        ]
      : [];
    // 卡过期与其他加速请求失败都投影到同一张加速输入行：fallbackAt 触发一次性提示，
    // fallbackReason 让 Renderer 区分“卡已到期”与“加速服务不可用”两种文案。
    const turnId = this.turnIdOf(event);
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" &&
        // Bug 根因：cold hydration 会重建 product turnId，不能再拿 runtime turnId
        // 关联已持久化的输入；inputId/sourceCommandId 才是跨恢复稳定身份。
        (candidate.turnId === turnId ||
          (payload.inputId !== undefined && candidate.sourceCommandId === payload.inputId)) &&
        candidate.highspeed !== undefined,
    );
    if (!row?.highspeed) return discardedStreamDeltas;
    return [
      ...discardedStreamDeltas,
      {
        op: "row.upserted",
        row: {
          ...row,
          highspeed: {
            ...row.highspeed,
            fallbackAt: event.timestamp.getTime(),
            fallbackReason: payload.reason,
          },
        },
      },
    ];
  }

  private openReasoningRow(
    event: SessionEvent,
    fact: CanonicalAssistantSegmentFact,
  ): ConversationDelta[] {
    const close = this.closeReasoningRow();
    const row: ReasoningRow = {
      ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
      kind: "reasoning",
      // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
      // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      text: "",
      state: "streaming",
    };
    this.streamingReasoningRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    return [...close, { op: "row.appended", row }];
  }

  private closeReasoningRow(state: "complete" | "interrupted" = "complete"): ConversationDelta[] {
    if (this.streamingReasoningRowId === null) return [];
    const row = this.findRow(this.streamingReasoningRowId);
    this.streamingReasoningRowId = null;
    if (row?.kind !== "reasoning") return [];
    return [{ op: "row.upserted", row: { ...row, state } }];
  }

  private closeStreamingRows(state: "complete" | "interrupted"): ConversationDelta[] {
    return [...this.closeTextRow(state), ...this.closeReasoningRow(state)];
  }

  // turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
  // `only` 让 stream recovery 只收口未定稿的那一部分。
  private closeOpenToolRows(
    event: SessionEvent,
    status: "cancelled" | "error",
    only?: (row: ToolCallRow) => boolean,
  ): ConversationDelta[] {
    if (this.openForegroundToolCallIds.size === 0) return [];
    const openRows: ToolCallRow[] = [];
    for (const toolCallId of this.openForegroundToolCallIds) {
      const row = this.findToolRow(toolCallId);
      // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
      if (!row || !this.isOpenForegroundToolRow(row)) continue;
      if (only && !only(row)) continue;
      openRows.push(row);
    }
    if (openRows.length === 0) return [];
    // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
    if (openRows.length > 1) {
      openRows.sort((left, right) => left.rowId - right.rowId);
    }
    const deltas: ConversationDelta[] = [];
    const closedToolCallIds = new Set<string>();
    for (const row of openRows) {
      const next: ToolCallRow = {
        ...row,
        status,
        inputText: `${row.inputText ?? ""}${this.takePendingStreamingToolInput(row.toolCallId)}`,
        endedAt: this.ms(event),
      };
      delete next.approvalInteractionId;
      if (status === "error") {
        // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
        // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
        next.error = {
          code: "fault.runtime.toolLifecycleIncomplete",
          message: "Tool call ended without a terminal event.",
        };
      } else {
        delete next.error;
      }
      closedToolCallIds.add(row.toolCallId);
      deltas.push({ op: "row.upserted", row: next });
    }

    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (interaction) =>
        !(
          (interaction.payload.kind === "permission" ||
            interaction.payload.kind === "userInput" ||
            interaction.payload.kind === "pluginInstall") &&
          typeof interaction.payload.toolCallId === "string" &&
          closedToolCallIds.has(interaction.payload.toolCallId)
        ),
    );
    if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
      deltas.push({ op: "state.updated", patch: { pendingInteractions } });
    }
    return deltas;
  }

  private isOpenForegroundToolRow(row: ToolCallRow): boolean {
    return (
      row.backgrounded !== true &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    );
  }

  private updateToolIndexesAfterDeltas(deltas: readonly ConversationDelta[]): void {
    for (const delta of deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") {
        if (delta.row.kind !== "toolCall") continue;
        if (this.isOpenForegroundToolRow(delta.row)) {
          this.openForegroundToolCallIds.add(delta.row.toolCallId);
        } else {
          this.openForegroundToolCallIds.delete(delta.row.toolCallId);
        }
        continue;
      }
      if (delta.op !== "row.removed") continue;
      for (const [toolCallId, rowId] of this.toolRowIdByCallId) {
        if (rowId < delta.fromRowId) continue;
        // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
        // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
        this.toolRowIdByCallId.delete(toolCallId);
        this.openForegroundToolCallIds.delete(toolCallId);
        this.fileToolInputPreviewByCallId.delete(toolCallId);
      }
      this.pruneRemovedSubagentIndexes();
    }
  }

  private pruneRemovedSubagentIndexes(): void {
    for (const [agentId, rowId] of this.subagentRowIdByAgentId) {
      if (this.findRow(rowId)?.kind === "subagent") continue;
      // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
      // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
      // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
      this.subagentRowIdByAgentId.delete(agentId);
    }
  }

  // ── tool call 状态机 ──

  private openToolRow(
    event: SessionEvent,
    payload: CanonicalModelStream,
    entityId?: string,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    if (
      toolCallId === "" ||
      shouldHideInvalidToolCallFromProduct(payload.toolName) ||
      this.toolRowIdByCallId.has(toolCallId)
    ) {
      return [];
    }
    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
      toolCallId,
      toolName: payload.toolName ?? "",
      status: "inputStreaming",
      inputText: "",
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
      this.fileToolInputPreviewByCallId.set(toolCallId, {
        lastPublishedAt: null,
        pendingAppend: "",
      });
    }
    if (entityId) this.entityIdByRowId.set(row.rowId, entityId);
    return [{ op: "row.appended", row }];
  }

  private appendStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    if (rowId === undefined || this.findToolRow(toolCallId)?.input !== undefined) return [];
    const state = this.fileToolInputPreviewByCallId.get(toolCallId);
    if (!state) {
      return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
    }

    state.pendingAppend += payload.delta;
    const now = this.ms(event);
    if (
      state.lastPublishedAt !== null &&
      now - state.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    ) {
      return [];
    }

    const append = state.pendingAppend;
    state.pendingAppend = "";
    state.lastPublishedAt = now;
    return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
  }

  private flushStreamingToolInput(toolCallId: string): ConversationDelta[] {
    const append = this.takePendingStreamingToolInput(toolCallId);
    if (append === "") return [];
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
  }

  private takePendingStreamingToolInput(toolCallId: string): string {
    const state = this.fileToolInputPreviewByCallId.get(toolCallId);
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    return state?.pendingAppend ?? "";
  }

  private finalizeStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    if (toolCallId === "") return [];
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
    const inputText = stringifyToolInput(payload.input);
    const existing = this.findToolRow(toolCallId);
    // scheduled 或完整 tool_call 已定稿输入；迟到原始流不能覆盖执行身份。
    if (existing?.input !== undefined) return [];
    if (existing) {
      return [
        {
          op: "row.upserted",
          row: {
            ...existing,
            ...(payload.assistantResponseId
              ? { assistantResponseId: payload.assistantResponseId }
              : {}),
            toolName: existing.toolName || payload.toolName || "",
            inputText,
            input: payload.input,
          },
        },
      ];
    }

    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
      toolCallId,
      toolName: payload.toolName ?? "",
      status: "inputStreaming",
      inputText,
      input: payload.input,
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    return [{ op: "row.appended", row }];
  }

  private onStreamingToolIdentity(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamingToolLedgerPayload;
    if (
      payload.status !== "tool_call_closed" ||
      payload.input === undefined ||
      payload.toolName === DEFERRED_TOOL_CALL_NAME ||
      shouldHideInvalidToolCallFromProduct(payload.toolName)
    )
      return [];
    const row = this.findToolRow(String(payload.toolCallId));
    if (row?.toolName !== DEFERRED_TOOL_CALL_NAME) return [];
    // 断流恢复可能直接提交工具错误而不经过 scheduled；目标身份取 Core 已闭合的调用，
    // 只补齐包装行，不触发 scheduled 的 Todo 等业务更新，也不重置已有状态和错误。
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          toolName: payload.toolName,
          input: payload.input,
          inputText: stringifyToolInput(payload.input),
        },
      },
    ];
  }

  private onToolCallScheduled(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallScheduledPayload;
    const toolCallId = String(payload.toolCallId);
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
    const inputText = stringifyToolInput(payload.input);
    const cuaAction = readOfficialCuaAction(payload.toolName);
    const cuaApp =
      cuaAction && cuaAction !== "list_apps"
        ? resolveCuaAppIdentity(payload.input, this.latestListAppsSnapshot)
        : undefined;
    const existing = this.findToolRow(toolCallId);
    const planDeltas = this.todoPlanDeltas(
      event,
      extractPlanStepsFromToolInput({
        title: payload.toolName,
        kind: payload.toolName,
        input: payload.input,
      }),
    );
    if (existing) {
      // replayable 会过滤 row.delta(inputText)，定稿 upsert 必须携带完整 inputText。
      // 否则断线恢复只能看到结构化 input，丢失 v4 row 的输入文本终态。
      return [
        {
          op: "row.upserted",
          row: {
            ...existing,
            toolName: payload.toolName,
            ...(payload.assistantMessageId
              ? { assistantResponseId: String(payload.assistantMessageId) }
              : {}),
            inputText,
            input: payload.input,
            ...(cuaApp ? { cuaApp } : {}),
            ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
          },
        },
        ...planDeltas,
      ];
    }
    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantMessageId
        ? { assistantResponseId: String(payload.assistantMessageId) }
        : {}),
      toolCallId,
      toolName: payload.toolName,
      status: "inputStreaming",
      inputText,
      input: payload.input,
      ...(cuaApp ? { cuaApp } : {}),
      ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    return [{ op: "row.appended", row }, ...planDeltas];
  }

  private onToolCallActivity(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallStartedPayload;
    this.recordHighspeedToolStarted(
      this.turnIdOf(event),
      String(payload.toolCallId),
      this.ms(event),
    );
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row) return [];
    return projectToolActivity(event, row);
  }

  /**
   * MCP `notifications/progress`（A8）→ 行上的 progress。只在 running 时写：
   * 终态之后迟到的进度通知不能把 success/error 行重新点亮；bash 的 stdout 字节进度不在这里消费。
   */
  private onToolCallProgress(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallProgressPayload;
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row || row.status !== "running") return [];
    // 两个分支共用 ToolCallProgress：Bash 尾窗与 MCP 百分比必须分别投影，避免合并后互相覆盖。
    if (row.toolName === "Bash") return projectToolActivity(event, row);
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
        ? payload.total
        : undefined;
    const fraction =
      total !== undefined &&
      typeof payload.progress === "number" &&
      Number.isFinite(payload.progress)
        ? Math.min(1, Math.max(0, payload.progress / total))
        : undefined;
    const message =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim().slice(0, 200)
        : undefined;
    if (fraction === undefined && message === undefined && total === undefined) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          progress: {
            ...(fraction !== undefined ? { fraction } : {}),
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
            updatedAt: this.ms(event),
          },
        },
      },
    ];
  }

  private onToolCallResult(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallResultPayload;
    const toolCallId = String(payload.toolCallId);
    this.recordHighspeedToolEnded(
      this.turnIdOf(event),
      toolCallId,
      this.ms(event),
      payload.duration,
    );
    const row = this.findToolRow(toolCallId);
    if (!row) return [];
    const success = payload.result.success;
    if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
      // 摘要身份必须来自 Agent 已观察到的成功事实；失败结果不能清空旧快照。
      const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
      if (snapshot) this.latestListAppsSnapshot = snapshot;
    }
    const display = toProtocolToolCallDisplay(payload.result.display);
    const next: ToolCallRow = {
      ...row,
      status: success ? "success" : "error",
      // 终态清除运行中进度（R7）。
      progress: undefined,
      output: buildToolOutput(payload.result, toolCallId),
      ...(display ? { display } : {}),
      endedAt: this.ms(event),
    };
    if (!success) {
      next.error = {
        code: payload.result.error?.type ?? "fault.runtime.toolFailed",
        message: payload.result.error?.message ?? "Tool execution failed.",
      };
    }
    const planDeltas = success
      ? this.todoPlanDeltas(
          event,
          extractPlanStepsFromToolOutput({
            title: row.toolName,
            kind: row.toolName,
            output: payload.result.content,
          }),
        )
      : [];
    return [{ op: "row.upserted", row: next }, ...planDeltas];
  }

  /**
   * TodoWrite 同时投影 live plan 与当前 goal iteration。
   * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
   * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
   */
  private todoPlanDeltas(
    event: SessionEvent,
    steps: ReturnType<typeof extractPlanStepsFromToolInput>,
  ): ConversationDelta[] {
    if (!steps) return [];
    const items = steps.map((step, index) => ({
      id: step.id || `todo-${index + 1}`,
      content: step.title,
      status:
        step.status === "in_progress"
          ? ("inProgress" as const)
          : step.status === "completed"
            ? ("completed" as const)
            : ("pending" as const),
    }));
    const updatedAt = this.ms(event);
    const goal = this.snapshot.goal;
    if (!goal) {
      return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
    }

    const iteration =
      goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
        ? Math.max(1, goal.iteration)
        : Math.max(1, goal.iteration + 1);
    const iterations = [
      ...goal.iterations.filter((entry) => entry.iteration !== iteration),
      { iteration, items, updatedAt },
    ].sort((left, right) => left.iteration - right.iteration);
    return [
      {
        op: "state.updated",
        patch: {
          goal: { ...goal, iterations },
          plan: { items, updatedAt },
        },
      },
    ];
  }

  private onToolCallError(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallErrorPayload;
    this.recordHighspeedToolEnded(this.turnIdOf(event), String(payload.toolCallId), this.ms(event));
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row) return [];
    const cancelled =
      payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          // Stop 会先产生 tool_cancelled，再产生 cancelled turn；若先把工具
          // 终态写成 error，后续只收口 running row 的 turn reducer 无法纠正为 stopped。
          status: cancelled ? "cancelled" : "error",
          progress: undefined,
          ...(cancelled
            ? { error: undefined }
            : { error: { code: payload.error.type, message: payload.error.message } }),
          endedAt: this.ms(event),
        },
      },
    ];
  }

  // ── 权限交互（阻塞交互 → 状态）──

  private onPluginInstallRequested(event: SessionEvent): ConversationDelta[] {
    // 旧 turn 的异步目录解析/确认收尾不能覆盖新 turn 的交互投影。
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as { interactionId: string; request: unknown };
    const request = pluginInstallRequestPayloadSchema.parse(payload.request);
    const row = this.findToolRow(request.toolCallId);
    const interaction: PendingInteraction = {
      interactionId: payload.interactionId,
      kind: "pluginInstall",
      anchorRowId: row?.rowId ?? null,
      createdAt: this.ms(event),
      payload: request,
    };
    return [
      ...(row
        ? [
            {
              op: "row.upserted" as const,
              row: {
                ...row,
                status: "pendingApproval" as const,
                approvalInteractionId: interaction.interactionId,
              },
            },
          ]
        : []),
      {
        op: "state.updated",
        patch: {
          pendingInteractions: [
            ...this.snapshot.pendingInteractions.filter(
              (item) => item.interactionId !== interaction.interactionId,
            ),
            interaction,
          ],
        },
      },
    ];
  }

  private onPermissionRequested(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionRequestedPayload;
    const toolCallId = String(payload.toolCallId);
    const interactionId = payload.requestId ?? `perm-${toolCallId}`;
    const interaction = this.createPendingInteractionFromPermissionEvent(
      event,
      payload,
      toolCallId,
      interactionId,
    );
    const deltas: ConversationDelta[] = [];
    const row = this.findToolRow(toolCallId);
    if (row) {
      deltas.push({
        op: "row.upserted",
        row: {
          ...row,
          status: "pendingApproval",
          approvalInteractionId: interactionId,
        },
      });
    }
    deltas.push({
      op: "state.updated",
      patch: {
        pendingInteractions: [...this.snapshot.pendingInteractions, interaction],
      },
    });
    return deltas;
  }

  private createPendingInteractionFromPermissionEvent(
    event: SessionEvent,
    payload: PermissionRequestedPayload,
    toolCallId: string,
    interactionId: string,
  ): PendingInteraction {
    if (isAskUserQuestionToolName(payload.toolName)) {
      // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
      // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: { toolName: payload.toolName },
          questions: readAskUserQuestionPayloadQuestions(payload.input),
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
      // MCP elicitation：requestedSchema → 结构化问题，
      // 与 broker 用同一映射，v4 UI 复用 ElicitationDialog。
      const elicitation = isPlainRecord(payload.input) ? payload.input : {};
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: {
            interaction: MCP_ELICITATION_INTERACTION,
            serverName: elicitation.serverName,
            requestedSchema: elicitation.requestedSchema,
          },
          questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    if (isExitPlanModeToolName(payload.toolName)) {
      // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
      // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: { interaction: "plan_approval", toolName: payload.toolName },
          questions: [createExitPlanModeApprovalQuestion(payload.reason)],
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    const askDisplay = toProtocolToolCallDisplay(payload.display);
    return {
      interactionId,
      kind: "permission",
      anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: this.ms(event),
      payload: {
        kind: "permission",
        toolCallId,
        toolName: payload.toolName,
        summary: payload.reason,
        detail: payload.input,
        freeText: true,
        ...(payload.fullAccessSupported === true && !payload.origin && !payload.optionsPolicy
          ? payload.approvalMode === "user-once"
            ? { modeSwitch: "fullAccessOnly" as const }
            : {
                modeSwitch: "choose" as const,
                fullAccessOption: {
                  optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
                  label: "Full access",
                  kind: "custom" as const,
                  response: {
                    decision: "deny" as const,
                    reason: "Full access requires V4 approval",
                  },
                },
              }
          : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(askDisplay ? { display: askDisplay } : {}),
        options: [
          ...buildProtocolPermissionOptions({
            approvalMode: payload.approvalMode,
            input: payload.input,
            suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
            ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
            toolName: payload.toolName,
          }).map((option) => ({
            optionId:
              option.kind === "allow_once"
                ? "allowOnce"
                : option.kind === "allow_always"
                  ? "allowAlways"
                  : option.optionId,
            label: option.name,
            // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
            // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
            kind:
              option.kind === "allow_once"
                ? ("allowOnce" as const)
                : option.kind === "allow_always" ||
                    option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                  ? ("allowAlways" as const)
                  : ("deny" as const),
            response: option.response,
          })),
          // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
          // 静态 response 是普通 deny：任何不认识该
          // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
          // interaction-broker 对 freeText 的特判里。
          ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
          payload.toolName === AMEND_WORKFLOW_TOOL_NAME
            ? [
                {
                  optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                  label: "Refine",
                  kind: "custom" as const,
                  response: { decision: "deny" as const, reason: "Denied" },
                },
              ]
            : []),
        ],
      },
    };
  }

  private onPermissionResolved(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionResolvedPayload;
    return this.settlePermission(
      String(payload.toolCallId),
      payload.decision === "deny" ? "cancelled" : "running",
    );
  }

  private onPermissionDenied(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionDeniedPayload;
    return this.settlePermission(String(payload.toolCallId), "cancelled");
  }

  private onWorkspaceHookReviewRequested(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewRequestedPayload;
    const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
    const current = this.snapshot.pendingInteractions.find(
      (item) => item.payload.kind === "workspaceHookReview",
    );
    if (current?.payload.kind === "workspaceHookReview") {
      const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
      // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
      // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
      if (verdict !== "same_flow_advance") {
        return [];
      }
    }
    const interaction: PendingInteraction = {
      interactionId: request.interactionId,
      kind: "workspaceHookReview",
      anchorRowId: null,
      createdAt: request.createdAt,
      payload: request,
    };
    // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
    // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (item) => item.payload.kind !== "workspaceHookReview",
    );
    pendingInteractions.push(interaction);
    return [{ op: "state.updated", patch: { pendingInteractions } }];
  }

  private onWorkspaceHookReviewSettled(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewSettledPayload;
    return this.removeWorkspaceHookReview(payload.interactionId);
  }

  private onWorkspaceHookReviewSuperseded(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewSupersededPayload;
    return this.removeWorkspaceHookReview(payload.interactionId);
  }

  private removeWorkspaceHookReview(interactionId: string): ConversationDelta[] {
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (item) =>
        !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
    );
    return pendingInteractions.length === this.snapshot.pendingInteractions.length
      ? []
      : [{ op: "state.updated", patch: { pendingInteractions } }];
  }

  /**
   * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
   *
   * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
   * pendingCount === 0 → 置 null(提示条消失)。
   */
  private onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
    const workspaceHookAdmission =
      payload.pendingCount === 0
        ? null
        : {
            pendingCount: payload.pendingCount,
            bundleDigest: payload.bundleDigest,
            ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
          };
    return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
  }

  private onUserInputAutoResolutionUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
    let changed = false;
    const pendingInteractions = this.snapshot.pendingInteractions.map((interaction) => {
      if (
        interaction.interactionId !== payload.interactionId ||
        interaction.payload.kind !== "userInput"
      ) {
        return interaction;
      }
      changed = true;
      return {
        ...interaction,
        autoResolution: payload.autoResolution,
      };
    });
    return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
  }

  private settlePermission(toolCallId: string, status: ToolCallRow["status"]): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const row = this.findToolRow(toolCallId);
    if (row) {
      const next: ToolCallRow = { ...row, status };
      delete next.approvalInteractionId;
      deltas.push({ op: "row.upserted", row: next });
    }
    const remaining = this.snapshot.pendingInteractions.filter(
      (item) =>
        !(
          (item.payload.kind === "permission" ||
            item.payload.kind === "userInput" ||
            item.payload.kind === "pluginInstall") &&
          item.payload.toolCallId === toolCallId
        ),
    );
    if (remaining.length !== this.snapshot.pendingInteractions.length) {
      deltas.push({
        op: "state.updated",
        patch: { pendingInteractions: remaining },
      });
    }
    return deltas;
  }

  // ── turn-steer 队列──

  private onTurnSteerQueued(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerQueuedPayload;
    const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
    const existingIndex = this.snapshot.queue.items.findIndex(
      (item) => item.queueItemId === queueItemId,
    );
    const existing = existingIndex >= 0 ? this.snapshot.queue.items[existingIndex] : undefined;
    // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
    // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
    const admittedDelivery: "queue" | "guide" =
      payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
        ? payload.intent.admittedDelivery
        : (payload.delivery ??
          (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
            ? existing.delivery.admitted
            : this.snapshot.config.followupMode === "guide"
              ? "guide"
              : "queue"));
    const requestedDelivery =
      payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
    const fallbackReasonCode =
      payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
    // Bug 根因：队列投影曾漏掉 intent.highspeed，自动和手动提升都因此把有效卡误判为不存在。
    const highspeed = payload.intent?.highspeed ?? existing?.highspeed;
    const nextItem: QueueItem = {
      queueItemId,
      kind:
        payload.intent?.kind === "compact" || payload.commandKind === "compact"
          ? ("compact" as const)
          : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
            ? ("sendGoalCommand" as const)
            : (existing?.kind ?? ("sendText" as const)),
      ...normalizeGenUiInput(payload.input, payload.intent?.genUiContext ?? existing?.genUiContext),
      sourceCommandId:
        payload.intent?.sourceCommandId ??
        existing?.sourceCommandId ??
        payload.inputId ??
        payload.pendingInputId,
      clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
      attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
      ...((payload.intent?.source ?? existing?.source)
        ? { source: payload.intent?.source ?? existing?.source }
        : {}),
      // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
      // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
      modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
      mode: payload.intent?.mode ?? existing?.mode,
      planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
      sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
      provenance: payload.intent?.provenance ?? existing?.provenance,
      // 排队事件和原地编辑都必须保留可信接入来源，不能在 UI 投影时丢掉发送者。
      ...((payload.intent?.inputOrigin ?? existing?.inputOrigin)
        ? { inputOrigin: payload.intent?.inputOrigin ?? existing?.inputOrigin }
        : {}),
      ...((payload.intent?.conversationQuotes ?? existing?.conversationQuotes)
        ? { conversationQuotes: payload.intent?.conversationQuotes ?? existing?.conversationQuotes }
        : {}),
      ...((payload.intent?.botGroupSource ?? existing?.botGroupSource)
        ? { botGroupSource: payload.intent?.botGroupSource ?? existing?.botGroupSource }
        : {}),
      delivery: {
        requested: requestedDelivery,
        admitted: admittedDelivery,
        ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
      },
      order: {
        admissionSeq:
          payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
        queuePosition:
          payload.intent?.queuePosition ??
          existing?.order.queuePosition ??
          Math.max(0, (payload.queueLength ?? 1) - 1),
      },
      steer:
        !payload.intent && !payload.delivery && existing
          ? existing.steer
          : fallbackReasonCode
            ? { state: "fellBack", reasonCode: fallbackReasonCode }
            : admittedDelivery === "guide"
              ? { state: "steering" }
              : { state: "notRequested" },
      dispatch: { state: "queued" },
      ...(highspeed ? { highspeed } : {}),
      // 编辑锁由独立事件裁决；同 id 重发 queued（例如权限批量改写）不能顺带解锁。
      ...(existing?.editLock ? { editLock: existing.editLock } : {}),
      automationId: payload.automationId ?? existing?.automationId,
      ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
      admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? this.ms(event),
    };
    // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
    this.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
    // 同 id 编辑原地保位；filter+append 会把它移到队尾，破坏 queueContentIndependence。
    const items =
      existingIndex >= 0
        ? this.snapshot.queue.items.map((item, index) =>
            index === existingIndex ? nextItem : item,
          )
        : [...this.snapshot.queue.items, nextItem];
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  private onTurnSteerDispatchChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDispatchChangedPayload;
    if (
      !this.snapshot.queue.items.some(
        (candidate) => candidate.queueItemId === payload.pendingInputId,
      )
    ) {
      return [];
    }
    const dispatch =
      payload.state === "queued"
        ? ({ state: "queued" } as const)
        : ({
            state: payload.state,
            reservationId: payload.reservationId,
          } as const);
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((candidate) =>
            candidate.queueItemId === payload.pendingInputId
              ? { ...candidate, dispatch }
              : candidate,
          ),
        }),
      },
    ];
  }

  private onTurnSteerEditLockChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerEditLockChangedPayload;
    if (!this.snapshot.queue.items.some((item) => item.queueItemId === payload.pendingInputId)) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((item) => {
            if (item.queueItemId !== payload.pendingInputId) return item;
            const { editLock: _released, ...unlocked } = item;
            return payload.editLock ? { ...unlocked, editLock: { ...payload.editLock } } : unlocked;
          }),
        }),
      },
    ];
  }

  private onTurnSteerDeliveryChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDeliveryChangedPayload;
    const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
    if (!this.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
      return [];
    }
    this.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((item) =>
            item.queueItemId === queueItemId
              ? {
                  ...item,
                  delivery: {
                    requested: payload.requestedDelivery,
                    admitted: payload.admittedDelivery,
                    fallbackReasonCode: payload.fallbackReasonCode,
                  },
                  steer: {
                    state: "fellBack",
                    reasonCode: payload.fallbackReasonCode,
                  },
                }
              : item,
          ),
        }),
      },
    ];
  }

  private onTurnSteerDrained(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDrainedPayload;
    const runtimeTurnId = String(
      payload.targetTurnId ?? event.turnId ?? this.currentTurnId ?? "turn-unknown",
    );
    // drain 事实优先自带文本/messageId（drainedInputs），
    // 投影不再依赖内存 queue 状态取文本——旧实现查不到 queue item 就静默 continue，
    // 用户输入从 queue 消失后也不进 history。旧事件（无 drainedInputs）回退查表。
    const items =
      payload.drainedInputs ??
      payload.pendingInputIds.flatMap((pendingInputId, index) => {
        const queueItem = this.snapshot.queue.items.find(
          (candidate) => candidate.queueItemId === pendingInputId,
        );
        if (!queueItem) return [];
        const intent: TurnInputIntentMetadata = {
          sourceCommandId: queueItem.sourceCommandId,
          queueItemId: queueItem.queueItemId,
          clientId: queueItem.clientId,
          kind: queueItem.kind,
          text: queueItem.text,
          ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
          ...(queueItem.mode ? { mode: queueItem.mode } : {}),
          ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
          admissionSeq: queueItem.order.admissionSeq,
          admittedAt: queueItem.admittedAt,
          requestedDelivery: queueItem.delivery.requested,
          admittedDelivery: queueItem.delivery.admitted,
          queuePosition: queueItem.order.queuePosition,
          ...(queueItem.delivery.fallbackReasonCode
            ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
            : {}),
          attachmentRefs: queueItem.attachments,
          genUiContext: queueItem.genUiContext,
        };
        return [
          {
            pendingInputId,
            messageId: payload.injectedMessageIds?.[index],
            text: queueItem.text,
            delivery: this.deliveryByPendingInputId.get(pendingInputId),
            intent,
          },
        ];
      });

    const deltas: ConversationDelta[] = [];
    // 同一次取出的多条 guide（中间没有主模型 step）只由第一条开启工作段，后续并入。
    // 修复原因：原来每条取出的 guide 都开启一个工作段。runtime 现在在一个边界按 FIFO 取出全部
    // 已等待的 guide，逐条开段会把一次取出拆成多段。改为按模型 step 判定边界：live 由主模型流事件和
    // ModelComplete 关闭，cold 由每条 assistant 消息合成的 start 事件关闭，两边得到同一份工作段。
    for (const item of items) {
      const normalizedInput = normalizeGenUiInput(item.text, item.intent?.genUiContext);
      const delivery =
        item.delivery ?? this.deliveryByPendingInputId.get(item.pendingInputId) ?? "queue";
      // queue 消费 = product turn 边界（每条一轮：收口上一段
      // header、开新 turnHeader、后续 assistant 归新轮）；guide steer 内联当前轮。
      if (delivery === "queue") {
        deltas.push(
          ...this.splitProductTurn(
            event,
            runtimeTurnId,
            item.messageId ? String(item.messageId) : undefined,
          ),
        );
      }
      const messageId = item.messageId ? String(item.messageId) : null;
      const entityId = messageId ?? item.pendingInputId;
      const productTurnId = this.turnIdOf(event);
      const rootSourceCommandId =
        item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
      const row = {
        ...this.rowBase(event, productTurnId, entityId),
        kind: "userInput" as const,
        text:
          item.intent?.conversationQuotes || item.intent?.botGroupSource
            ? normalizeGenUiInput(item.intent.text ?? item.text, item.intent.genUiContext).text
            : normalizedInput.text,
        origin: "realUser" as const,
        ...(delivery === "guide" ? { guided: true as const } : {}),
        ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
        ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
        ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
        ...(item.intent?.conversationQuotes
          ? { conversationQuotes: item.intent.conversationQuotes }
          : {}),
        ...(item.intent?.botGroupSource ? { botGroupSource: item.intent.botGroupSource } : {}),
        // Bug 根因：queue/guide drain 的 real-user 行同样可编辑，曾漏投影提交配置，编辑时被当作
        // 旧消息沿用当前工具栏，重跑会静默换模型/权限（MR 3454 评审 CR-01）。与 TurnStarted 共用投影。
        ...userInputSubmittedConfig(item.intent),
        ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
        ...(item.intent?.highspeed ? { highspeed: item.intent.highspeed } : {}),
        ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
        ...(item.intent?.source ? { source: item.intent.source } : {}),
      };
      // queue/guide 消费后的 real-user row 与普通 TurnStarted 共用完整 canonical target；
      // 缺 messageId 的旧事件仍只可展示，不暴露无法执行的 edit action。
      this.registerCanonicalUserRowTarget(
        row.rowId,
        entityId,
        messageId && item.intent?.kind !== "compact"
          ? {
              entityId,
              productTurnId,
              transcriptMessageId: messageId,
              coveredByStableCompact: false,
              intent: {
                kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
                text: normalizeGenUiInput(item.intent?.text ?? item.text, item.intent?.genUiContext)
                  .text,
                genUiContext: normalizedInput.genUiContext,
                ...(item.intent?.sourceCommandId
                  ? { sourceCommandId: item.intent.sourceCommandId }
                  : {}),
                ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
                ...(item.intent?.conversationQuotes
                  ? { conversationQuotes: item.intent.conversationQuotes }
                  : {}),
                ...(item.intent?.botGroupSource
                  ? { botGroupSource: item.intent.botGroupSource }
                  : {}),
                ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
                ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
                ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
                ...(item.intent?.admissionSeq !== undefined
                  ? { admissionSeq: item.intent.admissionSeq }
                  : {}),
                ...(item.intent?.admittedAt !== undefined
                  ? { admittedAt: item.intent.admittedAt }
                  : {}),
                ...(item.intent?.requestedDelivery
                  ? { requestedDelivery: item.intent.requestedDelivery }
                  : {}),
                ...(item.intent?.admittedDelivery
                  ? { admittedDelivery: item.intent.admittedDelivery }
                  : {}),
                ...(item.intent?.fallbackReasonCode
                  ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                  : {}),
                ...(item.intent?.modelSelection
                  ? { modelSelection: item.intent.modelSelection }
                  : {}),
                ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
                ...(item.intent?.planEnabled !== undefined
                  ? { planEnabled: item.intent.planEnabled }
                  : {}),
                ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
              },
            }
          : undefined,
      );
      if (delivery === "guide" && !this.guideDrainOpen) {
        deltas.push(...this.openGuidedWorkSegment(event, row.entityId ?? item.pendingInputId));
      }
      deltas.push({ op: "row.appended", row });
      this.guideDrainOpen = delivery === "guide";
      this.deliveryByPendingInputId.delete(item.pendingInputId);
    }
    return [...deltas, ...this.removeQueueItems(payload.pendingInputIds)];
  }

  /**
   * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
   * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
   * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
   */
  private splitProductTurn(
    event: SessionEvent,
    runtimeTurnId: string,
    promotedUserMessageId?: string,
  ): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const previousProductTurnId =
      this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
    const headerRowId = this.turnHeaderRowIdByTurnId.get(previousProductTurnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      const endedAt = this.ms(event);
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          state: "completedSuccess",
          endedAt,
          activeMs: Math.max(
            0,
            endedAt - (this.currentProductTurnStartedAtMs ?? headerRow.startedAt),
          ),
          ...(headerRow.workSegments
            ? {
                workSegments: this.completeWorkSegments(headerRow.workSegments, endedAt),
              }
            : {}),
        },
      });
    }
    const ordinal = (this.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
    this.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
    // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
    // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
    // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
    // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
    const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
    this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
    this.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
    this.currentProductTurnStartedAtMs = this.ms(event);
    const header = buildTurnHeaderRow(this.rowBase(event, productTurnId, productTurnId), {
      turnNumber: 0,
      input: "",
    });
    this.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
    deltas.push({ op: "row.appended", row: header });
    return deltas;
  }

  // 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
  // = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。
  private activeMsForCompletion(event: SessionEvent, runtimeDuration?: number): number | undefined {
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
    // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
    // 会错误覆盖 transcript 已计算好的整轮 duration。
    if (!this.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
    if (this.currentProductTurnStartedAtMs === null) return runtimeDuration;
    return Math.max(0, this.ms(event) - this.currentProductTurnStartedAtMs);
  }

  private onTurnSteerDiscarded(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDiscardedPayload;
    return this.removeQueueItems(payload.pendingInputIds);
  }

  private onSessionInputPromoted(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as SessionInputPromotedPayload;
    // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
    // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
    // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
    // 因此它才是可以安全移除 queue 投影的 durable commit signal。
    return this.removeQueueItems([payload.pendingInputId]);
  }

  /** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
  private onTurnSteerReordered(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { orderedPendingInputIds?: string[] };
    const order = payload.orderedPendingInputIds ?? [];
    const byId = new Map(this.snapshot.queue.items.map((item) => [item.queueItemId, item]));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((item): item is (typeof this.snapshot.queue.items)[number] => item !== undefined);
    // 未在 order 里出现的项（防丢）追加保持原相对序。
    const orderedIds = new Set(order);
    const rest = this.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
    const reordered = [...ordered, ...rest];
    const items = reordered.map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
    // 顺序无变化则不产 delta（幂等）。
    if (
      items.length === this.snapshot.queue.items.length &&
      items.every((item, index) => item === this.snapshot.queue.items[index])
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  // setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
  // （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。
  private onQueueAutoDrainChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { autoDrain?: boolean };
    const autoDrain = payload.autoDrain ?? true;
    if (
      this.snapshot.queue.autoDrain === autoDrain &&
      (autoDrain || this.snapshot.queue.pauseReason === "manual")
    ) {
      return [];
    }
    const queue = { ...this.snapshot.queue, autoDrain };
    if (autoDrain) {
      delete queue.pauseReason;
    } else {
      queue.pauseReason = "manual";
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch(queue),
      },
    ];
  }

  // setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
  // enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 inputRouting。
  private onFollowupModeChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { mode?: "queue" | "guide" };
    const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
    if (this.snapshot.config.followupMode === mode) return [];
    const nextConfig: ConversationSnapshot["config"] = {
      ...this.snapshot.config,
      followupMode: mode,
    };
    const context = availabilityContextOf(this.snapshot);
    return [
      {
        op: "state.updated",
        patch: {
          config: nextConfig,
          inputRouting: computeInputRouting(context, mode),
        },
      },
    ];
  }

  /**
   * switchCollaborationMode：SessionModeChanged → config.mode。
   * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
   * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
   */
  private onSessionModeChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      mode?: string;
      planEnabled?: boolean;
      source?: string;
      toolCallId?: string;
      permissionGrant?: { interactionId: string; queueItemIds: string[] };
    };
    const mode = typeof payload.mode === "string" ? payload.mode : "";
    // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
    if (mode) this.configModeTouchedByEvent = true;
    if (!mode) return [];
    const planEnabled = payload.planEnabled ?? mode === "plan";
    const planTransition =
      payload.source === "tool" && payload.toolCallId
        ? { toolCallId: payload.toolCallId, planEnabled }
        : this.snapshot.config.planTransition;
    if (
      this.snapshot.config.mode === mode &&
      this.snapshot.config.planEnabled === planEnabled &&
      planTransition === this.snapshot.config.planTransition &&
      !payload.permissionGrant
    )
      return [];
    return [
      {
        op: "state.updated",
        patch: {
          ...(payload.permissionGrant && (mode === "guarded" || mode === "yolo")
            ? this.queuePatch({
                ...this.snapshot.queue,
                items: this.snapshot.queue.items.map((item) =>
                  payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                    ? { ...item, mode }
                    : item,
                ),
              })
            : {}),
          config: {
            ...this.snapshot.config,
            mode,
            planEnabled,
            planTransition,
            ...(payload.permissionGrant
              ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
              : {}),
          },
        },
      },
    ];
  }

  /**
   * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
   * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
   * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
   * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
   */
  private shouldMaterializeSubagentProjection(reduced: readonly ConversationDelta[]): boolean {
    // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
    // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
    // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
    if (!this.hydrationAccumulator) return true;

    for (const delta of reduced) {
      switch (delta.op) {
        case "row.appended":
        case "row.upserted":
          if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
            return true;
          }
          break;
        case "row.delta":
          if (this.findRow(delta.rowId)?.kind === "subagent") return true;
          break;
        case "row.removed":
          // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
          return true;
        case "state.updated":
          if (
            delta.patch.pendingInteractions !== undefined ||
            delta.patch.backgroundWorks !== undefined
          ) {
            return true;
          }
          break;
        case "pluginUi.resourceUpdated":
        case "pluginUi.resourceListChanged":
        case "pluginUi.instanceClosed":
        case "pluginUi.appToolCall":
        // 非行 op：只动 workflowRuns 状态键，与 subagent 行投影的输入没有交集。
        case "workflowRun.updated":
        case "workflowRun.removed":
          break;
        default: {
          const exhaustiveDelta: never = delta;
          return exhaustiveDelta;
        }
      }
    }
    return false;
  }

  private materializeSubagentProjection(
    reduced: readonly ConversationDelta[],
  ): ConversationDelta[] {
    const previous: SubagentProjectionState = this.snapshot.subagents ?? {
      revision: 0,
      childSessionIds: [],
      running: [],
      endedTotal: 0,
    };
    const previousRunningById = new Map(
      previous.running.map((item) => [item.childSessionId, item]),
    );
    const latestRowByChildId = new Map<string, SubagentRow>();
    const collectSubagentRow = (row: SubagentRow | null): void => {
      if (row?.childSessionId && !this.invalidSubagentChildSessionIds.has(row.childSessionId)) {
        latestRowByChildId.set(row.childSessionId, row);
      }
    };
    // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
    // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
    // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
    const currentRowIds = new Set(this.subagentRowIdByAgentId.values());
    for (const delta of reduced) {
      if (delta.op === "row.upserted") {
        if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
          currentRowIds.add(delta.row.rowId);
        }
      } else if (delta.op === "row.delta" && this.findRow(delta.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.rowId);
      }
    }
    const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
    for (const rowId of currentRowIds) {
      const rowIndex = this.rowIndexById.get(rowId);
      const row = rowIndex === undefined ? undefined : this.snapshot.rows.window[rowIndex];
      if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
    }
    currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
    for (const { row } of currentRows) {
      collectSubagentRow(this.prospectiveSubagentRow(row, reduced, 0));
    }
    for (let index = 0; index < reduced.length; index += 1) {
      const delta = reduced[index]!;
      if (delta.op !== "row.appended") continue;
      collectSubagentRow(this.prospectiveSubagentRow(delta.row, reduced, index + 1));
    }

    let pendingInteractions = this.snapshot.pendingInteractions;
    let backgroundWorks = this.snapshot.backgroundWorks;
    for (const delta of reduced) {
      if (delta.op !== "state.updated") continue;
      if (delta.patch.pendingInteractions !== undefined) {
        pendingInteractions = delta.patch.pendingInteractions;
      }
      if (delta.patch.backgroundWorks !== undefined) {
        backgroundWorks = delta.patch.backgroundWorks;
      }
    }
    const waitingChildIds = new Set<string>();
    // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
    for (const interaction of pendingInteractions) {
      if (!("origin" in interaction.payload)) continue;
      const origin = interaction.payload.origin;
      if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
    }
    const blockedChildIds = new Set(
      backgroundWorks.flatMap((work) =>
        work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
          ? [work.childSessionId]
          : [],
      ),
    );

    const childSessionIds = [...latestRowByChildId.keys()];
    for (const childId of this.liveSubagentStopControlByChildId.keys()) {
      if (
        !latestRowByChildId.has(childId) ||
        latestRowByChildId.get(childId)?.status !== "running"
      ) {
        this.liveSubagentStopControlByChildId.delete(childId);
      }
    }
    const running: RunningSubagentSummary[] = [];
    for (const [childSessionId, row] of latestRowByChildId) {
      if (row.status !== "running") continue;
      const previousItem = previousRunningById.get(childSessionId);
      const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
      running.push({
        childSessionId,
        ...(this.liveSubagentStopControlByChildId.get(childSessionId)
          ? { stopControl: this.liveSubagentStopControlByChildId.get(childSessionId) }
          : {}),
        agentId: row.entityId,
        ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
        subagentType: row.subagentType,
        title,
        status: waitingChildIds.has(childSessionId)
          ? "waiting"
          : blockedChildIds.has(childSessionId)
            ? "blocked"
            : "running",
        ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      });
    }
    running.sort(
      (left, right) =>
        (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
        right.childSessionId.localeCompare(left.childSessionId),
    );
    const endedTotal = childSessionIds.length - running.length;
    const semanticState = { childSessionIds, running, endedTotal };
    if (
      JSON.stringify(semanticState) ===
      JSON.stringify({
        childSessionIds: previous.childSessionIds,
        running: previous.running,
        endedTotal: previous.endedTotal,
      })
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: {
          subagents: {
            revision: previous.revision + 1,
            ...semanticState,
          },
        },
      },
    ];
  }

  private prospectiveSubagentRow(
    row: ConversationRow,
    reduced: readonly ConversationDelta[],
    startIndex: number,
  ): SubagentRow | null {
    let prospective: ConversationRow | null = row;
    for (let index = startIndex; index < reduced.length && prospective; index += 1) {
      const delta = reduced[index]!;
      switch (delta.op) {
        case "row.appended":
        case "state.updated":
        case "pluginUi.resourceUpdated":
        case "pluginUi.resourceListChanged":
        case "pluginUi.instanceClosed":
        case "pluginUi.appToolCall":
        // 非行 op：改不了这一行的 prospective 形态。
        case "workflowRun.updated":
        case "workflowRun.removed":
          break;
        case "row.upserted":
          if (delta.row.rowId === prospective.rowId) prospective = delta.row;
          break;
        case "row.delta":
          if (
            delta.rowId === prospective.rowId &&
            delta.path === "summaryText" &&
            prospective.kind === "subagent"
          ) {
            prospective = {
              ...prospective,
              summaryText: prospective.summaryText + delta.append,
            };
          }
          break;
        case "row.removed":
          if (prospective.rowId >= delta.fromRowId) prospective = null;
          break;
        default: {
          const exhaustiveDelta: never = delta;
          return exhaustiveDelta;
        }
      }
    }
    return prospective?.kind === "subagent" ? prospective : null;
  }

  // ── subagent 行镜像──
  // schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
  // cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

  private onSubagentSpawned(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const agentId = this.subagentAgentId(payload, event);
    const existing = this.findSubagentLifecycleRow(agentId, payload, event);
    if (existing) this.subagentRowIdByAgentId.set(agentId, existing.rowId);
    const childSessionId = this.stringPayload(payload, "childSessionId");
    const taskId = this.stringPayload(payload, "taskId");
    const executionId = this.stringPayload(payload, "executionId");
    if (childSessionId) {
      if (!this.hydrationAccumulator && taskId && executionId) {
        this.liveSubagentStopControlByChildId.set(childSessionId, { taskId, executionId });
      } else {
        this.liveSubagentStopControlByChildId.delete(childSessionId);
      }
    }
    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    const resumedBackgroundWork = this.resumedSubagentBackgroundWorkDelta(
      event,
      payload,
      agentId,
      childSessionId,
    );
    if (
      existing?.status === "running" &&
      (!childSessionId || childSessionId === existing.childSessionId) &&
      (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
      (payload.background !== true || existing.backgrounded === true)
    ) {
      return resumedBackgroundWork ? [resumedBackgroundWork] : [];
    }
    if (existing) {
      const row: SubagentRow = {
        ...existing,
        status: "running",
        summaryText:
          this.stringPayload(payload, "description") ??
          this.stringPayload(payload, "prompt") ??
          existing.summaryText,
        // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
        // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        startedAt: this.ms(event),
      };
      delete row.endedAt;
      return [
        { op: "row.upserted", row },
        ...(resumedBackgroundWork ? [resumedBackgroundWork] : []),
      ];
    }
    const row: SubagentRow = {
      ...this.rowBase(event, this.turnIdOf(event), agentId),
      kind: "subagent",
      ...(this.stringPayload(payload, "parentToolCallId")
        ? { parentToolCallId: this.stringPayload(payload, "parentToolCallId") }
        : {}),
      subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
      status: "running",
      summaryText:
        this.stringPayload(payload, "description") ??
        this.stringPayload(payload, "summaryText") ??
        this.stringPayload(payload, "prompt") ??
        "",
      ...(this.stringPayload(payload, "childSessionId")
        ? { childSessionId: this.stringPayload(payload, "childSessionId") }
        : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: this.ms(event),
    };
    this.subagentRowIdByAgentId.set(agentId, row.rowId);
    return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }

  private resumedSubagentBackgroundWorkDelta(
    event: SessionEvent,
    payload: Record<string, unknown>,
    agentId: string,
    childSessionId: string | undefined,
  ): ConversationDelta | undefined {
    if (payload.background !== true || payload.resumed !== true || !childSessionId) {
      return undefined;
    }

    // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
    // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
    // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
    const previous = this.snapshot.backgroundWorks;
    const existing = previous.find((work) => work.workId === agentId);
    const title =
      this.stringPayload(payload, "description") ??
      this.stringPayload(payload, "prompt") ??
      existing?.title ??
      agentId;
    if (
      existing?.status === "running" &&
      existing.kind === "subagent" &&
      existing.title === title &&
      existing.childSessionId === childSessionId &&
      existing.cancellable === true
    ) {
      return undefined;
    }
    const next: BackgroundWorkSummary = {
      workId: agentId,
      kind: "subagent",
      title,
      status: "running",
      startedAt: this.ms(event),
      cancellable: true,
      anchorRowId: existing?.anchorRowId ?? null,
      childSessionId,
    };
    const backgroundWorks = existing
      ? previous.map((work) => (work.workId === agentId ? next : work))
      : [...previous, next];
    return { op: "state.updated", patch: { backgroundWorks } };
  }

  private onSubagentMessage(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const row = this.findSubagentRow(this.subagentAgentId(payload, event));
    const append =
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "text") ??
      this.stringPayload(payload, "message");
    if (!row || !append) return [];
    return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
  }

  private onSubagentStopped(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const agentId = this.subagentAgentId(payload, event);
    const existing = this.findSubagentLifecycleRow(agentId, payload, event);
    const stoppedChildSessionId =
      this.stringPayload(payload, "childSessionId") ?? existing?.childSessionId;
    const executionId = this.stringPayload(payload, "executionId");
    const liveControl = stoppedChildSessionId
      ? this.liveSubagentStopControlByChildId.get(stoppedChildSessionId)
      : undefined;
    // 同一 child 恢复后会复用 row；旧执行的迟到终态不能清除新执行的控制能力。
    if (executionId && liveControl && executionId !== liveControl.executionId) return [];
    if (stoppedChildSessionId) this.liveSubagentStopControlByChildId.delete(stoppedChildSessionId);
    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    const status = this.mapSubagentStatus(this.stringPayload(payload, "status"));
    const summaryText =
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "result") ??
      this.stringPayload(payload, "error") ??
      this.stringPayload(payload, "description") ??
      existing?.summaryText ??
      "";
    const row: SubagentRow = existing
      ? {
          ...existing,
          status,
          summaryText,
          endedAt: this.ms(event),
          // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
          ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
          ...(this.stringPayload(payload, "childSessionId")
            ? { childSessionId: this.stringPayload(payload, "childSessionId") }
            : {}),
        }
      : {
          ...this.rowBase(event, this.turnIdOf(event), agentId),
          kind: "subagent",
          ...(this.stringPayload(payload, "parentToolCallId")
            ? {
                parentToolCallId: this.stringPayload(payload, "parentToolCallId"),
              }
            : {}),
          subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
          status,
          summaryText,
          ...(this.stringPayload(payload, "childSessionId")
            ? { childSessionId: this.stringPayload(payload, "childSessionId") }
            : {}),
          ...(payload.background === true ? { backgrounded: true as const } : {}),
          ...(payload.background === true ? { workId: agentId } : {}),
          endedAt: this.ms(event),
        };
    this.subagentRowIdByAgentId.set(agentId, row.rowId);
    return [{ op: existing ? "row.upserted" : "row.appended", row }];
  }

  // cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
  // → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
  // taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。
  private onBackgroundTaskLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      taskId?: string;
      toolName?: string;
      taskKind?: string;
      command?: string;
      description?: string;
      status?: string;
      cancellable?: boolean;
      blocked?: boolean;
      childSessionId?: string;
    };
    const workId = payload.taskId;
    if (!workId) return [];
    const prev = this.snapshot.backgroundWorks;
    const existing = prev.find((work) => work.workId === workId);
    const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
    // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
    // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
    // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
    // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
    const kind: BackgroundWorkSummary["kind"] =
      payload.taskKind === "subagent"
        ? "subagent"
        : payload.taskKind === "bash"
          ? "bash"
          : payload.taskKind === "workflow"
            ? "workflow"
            : legacyKind === "agent"
              ? "subagent"
              : legacyKind === "bash"
                ? "bash"
                : (existing?.kind ?? "bash");
    // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
    // → summary status（running/resultPending/failed/cancelled）。
    const rawStatus = payload.status ?? "running";
    const status: "running" | "resultPending" | "failed" | "cancelled" =
      rawStatus === "running"
        ? "running"
        : rawStatus === "cancelled"
          ? "cancelled"
          : rawStatus === "completed"
            ? "resultPending"
            : "failed";
    const title =
      payload.description?.trim() ||
      payload.command?.trim() ||
      existing?.title ||
      payload.toolName ||
      workId;
    const next: BackgroundWorkSummary = {
      workId,
      kind,
      title,
      status,
      startedAt: existing?.startedAt ?? this.ms(event),
      ...(status === "running" ? {} : { endedAt: this.ms(event) }),
      ...(typeof payload.cancellable === "boolean"
        ? { cancellable: payload.cancellable }
        : existing?.cancellable !== undefined
          ? { cancellable: existing.cancellable }
          : {}),
      ...(typeof payload.blocked === "boolean"
        ? { blocked: payload.blocked }
        : existing?.blocked !== undefined
          ? { blocked: existing.blocked }
          : {}),
      anchorRowId: existing?.anchorRowId ?? null,
      ...(payload.childSessionId
        ? { childSessionId: payload.childSessionId }
        : existing?.childSessionId
          ? { childSessionId: existing.childSessionId }
          : {}),
    };
    // 幂等：内容无变化不产 delta。
    if (
      existing &&
      existing.status === next.status &&
      existing.title === next.title &&
      existing.kind === next.kind &&
      existing.cancellable === next.cancellable &&
      existing.blocked === next.blocked &&
      existing.childSessionId === next.childSessionId
    ) {
      return [];
    }
    const backgroundWorks = existing
      ? prev.map((work) => (work.workId === workId ? next : work))
      : [...prev, next];
    return [{ op: "state.updated", patch: { backgroundWorks } }];
  }

  // ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
  // 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
  // 所以持久、可回放、冷恢复免费（先例：subagents 键）。
  //
  // 归约本体在 @zcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
  // 同一份归约，两处各写一份就是两个时钟（docs/dynamic-workflow/launch.md「The inline card」）。
  // 留在这里的只有投影的非纯部分——从事件信封取载荷、把新旧状态之差发成键级增量。
  private onDynamicWorkflowRunProgress(event: SessionEvent): ConversationDelta[] {
    // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
    // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
    const envelope: WorkflowRunProgressEnvelope =
      event.payload as DynamicWorkflowRunProgressPayload;
    const prior = this.snapshot.workflowRuns;
    const workflowRuns = reduceWorkflowRunsState(prior, envelope);
    // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
    if (workflowRuns === null) return [];
    // 发**差**而不是整键：一条引擎事件只动一个节点，整键重发是每事件 O(N) 字节、一条 run
    // 全程 O(N²)（workflow-runs-delta.ts 的文件头讲了这笔账怎么变成节点上界和 UI 卡死的）。
    // `applyAll(prior, diff(prior, next))` 与 next **逐字节**一致是被 property 测试钉住的契约，
    // 所以 applyEventInternal 把这串 delta 应用回去之后，this.snapshot.workflowRuns 仍是 next。
    return diffWorkflowRunsState(prior, workflowRuns);
  }

  private removeQueueItems(ids: readonly string[]): ConversationDelta[] {
    const idSet = new Set(ids);
    for (const id of ids) this.deliveryByPendingInputId.delete(id);
    const items = this.snapshot.queue.items
      .filter((item) => !idSet.has(item.queueItemId))
      .map((item, index) =>
        item.order.queuePosition === index
          ? item
          : { ...item, order: { ...item.order, queuePosition: index } },
      );
    if (items.length === this.snapshot.queue.items.length) return [];
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  // ── config / usage ──

  private onModelSelected(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as ModelSelectedPayload;
    // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
    // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
    // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
    if (payload.previousModelSelection === null) {
      this.lastTurnModel = { kind: "sourceLess" };
    }
    const prev = this.snapshot.config;
    const provider = payload.modelSelection.providerId;
    const model = payload.modelSelection.modelId;
    const thought =
      payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
    const modelSelection = cloneSparseModelSelection(payload.modelSelection);
    const thoughtLevels = payload.supportedThoughtLevels
      ? [...payload.supportedThoughtLevels]
      : prev.thoughtLevels;
    const contextWindow =
      payload.contextWindow === null
        ? null
        : payload.contextWindow !== undefined
          ? positiveInteger(payload.contextWindow, 0) || undefined
          : undefined;
    // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
    // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
    // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
    if (contextWindow !== undefined) {
      this.contextWindowState.touchedByEvent = true;
      this.contextWindowState.maxTokens =
        contextWindow !== null && contextWindow > 0 ? contextWindow : null;
    }
    const previousContextWindow = this.snapshot.usage.contextWindow;
    if (previousContextWindow) {
      this.contextWindowState.usedTokens = previousContextWindow.usedTokens;
    }
    const contextWindowChanged =
      contextWindow !== undefined &&
      (contextWindow === null
        ? previousContextWindow !== null
        : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
    // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
    // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
    // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
    // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
    if (String(event.traceId) !== HYDRATION_TRACE_ID) {
      this.configModelTouchedByEvent = true;
      if (payload.supportedThoughtLevels !== undefined) {
        this.configThoughtLevelsTouchedByEvent = true;
      }
    }
    // 选型事件只更新 config，不在选型时落 modelChange
    // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
    // 裁决（见彼处注释与 Bug 背景）。
    const configChanged = !(
      prev.provider === provider &&
      prev.model === model &&
      sameSparseModelSelection(prev.modelSelection, modelSelection) &&
      prev.thought === thought &&
      prev.thoughtLevels.length === thoughtLevels.length &&
      prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
    );
    const modelTransition =
      payload.origin === "registryFallback" &&
      payload.previousModelSelection != null &&
      (payload.previousModelSelection.providerId !== provider ||
        payload.previousModelSelection.modelId !== model)
        ? {
            eventId: String(event.id),
            origin: payload.origin,
            from: {
              provider: payload.previousModelSelection.providerId,
              model: payload.previousModelSelection.modelId,
            },
            to: { provider, model },
          }
        : undefined;
    if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: {
          ...(configChanged
            ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
            : {}),
          // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
          // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
          // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
          ...(modelTransition ? { modelTransition } : {}),
          ...(contextWindowChanged
            ? {
                usage: {
                  ...this.snapshot.usage,
                  // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                  // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                  contextWindow:
                    contextWindow === null
                      ? null
                      : previousContextWindow
                        ? { ...previousContextWindow, maxTokens: contextWindow }
                        : {
                            usedTokens: this.contextWindowState.usedTokens,
                            maxTokens: contextWindow,
                            autoCompactThresholdTokens: null,
                          },
                },
              }
            : {}),
        },
      },
    ];
  }

  private onModelComplete(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as ModelCompletePayload;
    const retryClearDeltas = this.acceptsActiveModelEvent(event) ? this.setApiRetry(null) : [];
    // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
    const isMainTurn =
      payload.querySource !== undefined
        ? payload.querySource === "main_turn"
        : payload.stopReason !== "tool_internal";
    if (isMainTurn) {
      this.outputContinuationTextRowId = null;
      this.guideDrainOpen = false;
    }
    if (
      isMainTurn &&
      payload.stopReason?.trim().toLowerCase() === "length" &&
      payload.toolCallCount === 0
    ) {
      const lastVisibleRow = this.snapshot.rows.window.at(-1);
      if (
        lastVisibleRow?.kind === "assistantText" &&
        lastVisibleRow.turnId === this.turnIdOf(event) &&
        lastVisibleRow.state === "complete"
      ) {
        this.outputContinuationTextRowId = lastVisibleRow.rowId;
      }
    }
    // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
    // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
    const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
    const usage = payload.usage as ModelUsage;
    const deltas: ConversationDelta[] = [];
    const turnId = this.turnIdOf(event);
    const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      const fileChanges =
        supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0
          ? {
              fileChanges: {
                additions: payload.fileChanges.additions,
                deletions: payload.fileChanges.deletions,
                files: payload.fileChanges.files,
                // Bug 根因：该条件对象随后与 headerRow 展开合并，TS 会把字面量扩宽为
                // string，导致 CLI 启动前构建无法满足 TurnFileChangeSummary 契约。
                state: "active" as const,
              },
            }
          : {};
      if (isMainTurn || "fileChanges" in fileChanges) {
        deltas.push({
          op: "row.upserted",
          row: {
            ...headerRow,
            ...fileChanges,
            // Bug 根因：Renderer 观察 running 快照的时机不可靠，continuous 可合并更新，
            // replayable 也可能首次恢复即终态。单 Turn token 必须在权威事件投影中累计。
            ...(isMainTurn
              ? { outputTokens: (headerRow.outputTokens ?? 0) + (usage.outputTokens ?? 0) }
              : {}),
          },
        });
      }
    }
    if (!isMainTurn) return [...deltas, ...retryClearDeltas];
    const usedTokens = getModelUsageContextTokens(usage) ?? 0;
    this.contextWindowState.usedTokens = usedTokens;
    const maxTokens = payload.contextWindow ?? this.contextWindowState.maxTokens;
    const cumulative = this.snapshot.usage.cumulative;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
          // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens,
                  maxTokens,
                  autoCompactThresholdTokens:
                    this.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                  ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                  ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                    ? { breakdown: payload.contextUsageBreakdown }
                    : {}),
                },
          cumulative: {
            inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
            outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
            cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
            cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
          },
        },
      },
    });
    // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
    deltas.push(...retryClearDeltas);
    return deltas;
  }

  // ── compact marker（compact 命令效果）──
  // 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
  // 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

  private onCompactLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as CompactLifecyclePayload & {
      anchorMessageId?: string;
      tailStartMessageId?: string;
    };
    const existingRowId = this.compactMarkerRowIdByOperationId.get(payload.operationId);
    const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
    const prev =
      existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
        ? existingRow.marker
        : undefined;

    const status = mapCompactMarkerStatus(payload.status);
    if (status === "success") {
      const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
      const coverageRowId = coverageMessageId ? this.rowIdForMessageId(coverageMessageId) : null;
      if (coverageRowId !== null) {
        this.stableCompactCoverageBoundaryRowId = Math.max(
          this.stableCompactCoverageBoundaryRowId ?? 0,
          coverageRowId,
        );
        for (const [rowId, entityId] of this.entityIdByRowId) {
          if (rowId > this.stableCompactCoverageBoundaryRowId) continue;
          const target = this.editTargetByEntityId.get(entityId);
          if (target && !target.coveredByStableCompact) {
            this.editTargetByEntityId.set(entityId, {
              ...target,
              coveredByStableCompact: true,
            });
          }
        }
      }
    }
    const tokensAfter =
      payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
    const marker: TimelineMarkerPayload = {
      type: "compact",
      origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
      status,
      // 终态事件才带 token 计数；upsert 时保留已知值（retry 不清零）。
      ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
        ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
        : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      // summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位。
      ...(payload.summaryMessageId !== undefined || prev?.summaryRef
        ? {
            summaryRef:
              payload.summaryMessageId !== undefined
                ? String(payload.summaryMessageId)
                : prev?.summaryRef,
          }
        : {}),
    };

    const deltas: ConversationDelta[] = [];
    if (existingRow?.kind === "timelineMarker") {
      deltas.push({
        op: "row.upserted",
        row: {
          ...existingRow,
          marker,
          ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
        },
      });
    } else {
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.turnIdOf(event), String(payload.operationId)),
        kind: "timelineMarker",
        lane: "assistantWork",
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      };
      this.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
      deltas.push({ op: "row.appended", row });
    }

    // compacting 进出 activeWorks（guard 同源派生：compactOperationLock /
    // compactingAcceptsFutureInput 由此驱动，与 formal-proof evaluateCompacting 对齐）。
    const otherWorks = this.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
    if (status === "running") {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          activeWorks: [...otherWorks, { kind: "compact", startedAt: this.ms(event) }],
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
        }),
      });
    } else {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          activeWorks: otherWorks,
          ...(otherWorks.length === 0
            ? {
                canStop: false,
                stopState: "idle" as const,
                stopTargetKind: "unknown" as const,
              }
            : {}),
        }),
      });
    }

    // compact 成功 → context 水位立即回落（usage.contextWindow 更新）。
    if (status === "success" && tokensAfter !== undefined) {
      this.contextWindowState.usedTokens = tokensAfter;
      const maxTokens =
        this.snapshot.usage.contextWindow?.maxTokens ?? this.contextWindowState.maxTokens;
      deltas.push({
        op: "state.updated",
        patch: {
          usage: {
            ...this.snapshot.usage,
            contextWindow:
              maxTokens === null
                ? null
                : {
                    usedTokens: tokensAfter,
                    maxTokens,
                    autoCompactThresholdTokens:
                      this.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                  },
          },
        },
      });
    }
    return deltas;
  }

  // ── goal 状态机──

  private onTargetChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TargetChangedPayload;
    switch (payload.action) {
      case "set": {
        if (!payload.target) return [];
        // 新目标：iteration/verifications 归零。
        // goalSet 是 stateOnly——不产 timeline row（旧实现
        // 的 goalSet marker 是「进 window 渲染 null」的隐形行，污染 turn 分组判定），
        // 目标展示归 goal 面板/状态区。
        const goal: GoalState = {
          targetId: payload.target.targetID,
          objective: payload.target.objective,
          summaryTitle: payload.target.summaryTitle,
          timeUsedSeconds: payload.target.timeUsedSeconds,
          activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
          status: mapGoalStatus(payload.target.status),
          iteration: 0,
          verifications: [],
          iterations: [],
        };
        return [{ op: "state.updated", patch: { goal } }];
      }
      case "cleared": {
        if (!this.snapshot.goal) return [];
        return [{ op: "state.updated", patch: { goal: null } }];
      }
      default: {
        // status_updated / run_started / run_finished / usage_accounted / summary_updated：
        // 同步刷新计时与摘要标题。旧实现只比较 status，会吞掉 1 秒以上 run accounting
        // 和 summaryTitle 更新，导致刷新前后的 UI 不一致。
        const goal = this.snapshot.goal;
        if (!goal || !payload.target) return [];
        const nextGoal: GoalState = {
          ...goal,
          targetId: payload.target.targetID,
          objective: payload.target.objective,
          summaryTitle: payload.target.summaryTitle,
          timeUsedSeconds: payload.target.timeUsedSeconds,
          activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
          status: mapGoalStatus(payload.target.status),
        };
        if (
          nextGoal.targetId === goal.targetId &&
          nextGoal.objective === goal.objective &&
          nextGoal.summaryTitle === goal.summaryTitle &&
          nextGoal.timeUsedSeconds === goal.timeUsedSeconds &&
          nextGoal.activeRunStartedAtMs === goal.activeRunStartedAtMs &&
          nextGoal.status === goal.status
        ) {
          return [];
        }
        return [{ op: "state.updated", patch: { goal: nextGoal } }];
      }
    }
  }

  private onTargetVerification(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TargetCompletionVerificationPayload;
    const goal = this.snapshot.goal;
    // goal verify boundary 不依赖 goal 状态在场。
    // 冷恢复合成事件流没有 TargetChanged → goal 为 null，旧实现在此整条丢弃
    // verification 事实，刷新后 goalVerify marker 消失。现在 marker
    // 恒生成/恒更新；goal 状态 patch 仍只在 goal 在场时生效。

    if (payload.status === "started") {
      const iteration = payload.goalIteration ?? (goal ? goal.iteration + 1 : 1);
      const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
      const verifyingGoal = goal ? { ...goal, status: "verifying" as const, iteration } : undefined;
      const otherWorks = this.snapshot.control.activeWorks.filter(
        (work) => work.kind !== "goalVerifier",
      );
      const controlDelta: ConversationDelta = {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: "running",
            sessionEnded: false,
            activeWorks: [
              ...otherWorks,
              {
                kind: "goalVerifier",
                ...(payload.foregroundExecutionId
                  ? { foregroundExecutionId: payload.foregroundExecutionId }
                  : {}),
                startedAt: this.ms(event),
              },
            ],
            canStop: true,
            stopState: "stoppable",
            stopTargetKind: otherWorks.length > 0 ? ("mixed" as const) : ("goalVerifier" as const),
            lastError: null,
            apiRetry: null,
          },
          verifyingGoal,
        ),
      };
      // GV-identity：同 targetId+iteration 的重试（新 verificationId）复用同一 marker
      // 行回到 running，不长出第二个 marker。
      const existingRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
      const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
      if (existingRow?.kind === "timelineMarker") {
        return [
          {
            op: "row.upserted",
            row: {
              ...existingRow,
              marker: { type: "goalVerify", iteration, outcome: "running" },
            },
          },
          controlDelta,
        ];
      }
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
        kind: "timelineMarker",
        lane: "turnTailBoundary",
        marker: { type: "goalVerify", iteration, outcome: "running" },
      };
      this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
      return [{ op: "row.appended", row }, controlDelta];
    }

    // 终态：completed（pass/notSatisfied 是有效结论）/ failed_closed（验证过程失败）
    // / cancelled（被 stop：过程未产出结论 → marker=failed(detail=cancelled)，goal 回 paused）。
    const iteration = payload.goalIteration ?? goal?.iteration ?? 1;
    const outcome: "pass" | "notSatisfied" | "failed" =
      payload.status === "completed"
        ? payload.verification?.passed
          ? "pass"
          : "notSatisfied"
        : "failed";
    const goalStatus: GoalState["status"] =
      payload.status === "cancelled"
        ? "paused"
        : payload.status === "failed_closed"
          ? "failed"
          : outcome === "pass"
            ? "verified"
            : "notSatisfied";

    const deltas: ConversationDelta[] = [];
    const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
    const markerRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
    let anchorRowId: number | null = null;
    const markerRow = markerRowId !== undefined ? this.findRow(markerRowId) : undefined;
    const terminalMarker: TimelineMarkerPayload = {
      type: "goalVerify",
      iteration,
      outcome,
      ...(payload.status === "cancelled"
        ? { detail: "cancelled" }
        : payload.verification?.reason
          ? { detail: payload.verification.reason }
          : {}),
    };
    if (markerRow?.kind === "timelineMarker") {
      anchorRowId = markerRow.rowId;
      deltas.push({
        op: "row.upserted",
        row: { ...markerRow, marker: terminalMarker },
      });
    } else {
      // GV-terminal-only：boundary 按 lifecycleKey upsert——任一生命周期
      // 事件先到都能创建实体。旧实现终态找不到 started marker 就整条丢弃（冷恢复
      // 后到达的终态、started 事件丢帧都触发）。
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
        kind: "timelineMarker",
        lane: "turnTailBoundary",
        marker: terminalMarker,
      };
      this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
      anchorRowId = row.rowId;
      deltas.push({ op: "row.appended", row });
    }

    const hadGoalVerifierWork = this.snapshot.control.activeWorks.some(
      (work) => work.kind === "goalVerifier",
    );
    const shouldPatchControl = hadGoalVerifierWork || this.snapshot.goal?.status === "verifying";
    const otherWorks = this.snapshot.control.activeWorks.filter(
      (work) => work.kind !== "goalVerifier",
    );
    const terminalPhase: SessionControl["phase"] =
      payload.status === "cancelled"
        ? "completedInterrupted"
        : payload.status === "failed_closed"
          ? "error"
          : "completedSuccess";
    const heldQueue =
      payload.status === "cancelled" &&
      payload.preserveQueueAutoDrainOnCancel !== true &&
      this.snapshot.queue.items.length > 0
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "stopped" as const,
          }
        : undefined;

    // goal 不在场（冷恢复合成流）：marker 行仍要保留；只有当前 live control
    // 确实处于 verifier work 时才收口 control，避免 terminal-only 历史事实把 draft
    // 冷恢复快照误推进成 completed。
    if (!goal) {
      if (!shouldPatchControl) return deltas;
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: terminalPhase,
            sessionEnded: terminalPhase !== "error",
            activeWorks: otherWorks,
            ...(otherWorks.length === 0
              ? {
                  canStop: false,
                  stopState: "idle" as const,
                  stopTargetKind: "unknown" as const,
                }
              : {
                  stopTargetKind: "mixed" as const,
                }),
          },
          undefined,
          heldQueue,
        ),
      });
      return deltas;
    }

    // verifications 只记结论（cancelled 不是结论，不入摘要）；最近 N 条。
    const verifications =
      payload.status === "cancelled"
        ? goal.verifications
        : [
            ...goal.verifications,
            {
              iteration,
              outcome,
              at: this.ms(event),
              anchorRowId,
              ...(payload.verification?.reason ? { reason: payload.verification.reason } : {}),
              ...(payload.verification?.nextAction
                ? { nextAction: payload.verification.nextAction }
                : {}),
            },
          ].slice(-PROTOCOL_V4_LIMITS.goalVerificationsRetained);

    const nextGoal = {
      ...goal,
      status: goalStatus,
      iteration,
      verifications,
    };
    deltas.push({
      op: "state.updated",
      patch: shouldPatchControl
        ? this.controlPatch(
            {
              phase: terminalPhase,
              sessionEnded: terminalPhase !== "error",
              activeWorks: otherWorks,
              ...(otherWorks.length === 0
                ? {
                    canStop: false,
                    stopState: "idle" as const,
                    stopTargetKind: "unknown" as const,
                  }
                : {
                    stopTargetKind: "mixed" as const,
                  }),
            },
            nextGoal,
            heldQueue,
          )
        : { goal: nextGoal },
    });
    return deltas;
  }

  /** goal verify boundary 身份：targetId_goalIteration。 */
  private goalVerifyLifecycleKey(
    payload: TargetCompletionVerificationPayload,
    iteration: number,
  ): string {
    return payload.targetId ? `${payload.targetId}_${iteration}` : payload.verificationId;
  }

  // 落位：优先 anchorAssistantMessageId（解析到已渲染
  // 行的所属轮——fork copy 后是 remap 过的 child local id）；次选 anchorTurnId
  // （必须是已知轮，未知 id 不得当 turnId 用——否则会长出幽灵 turn 分组，
  // fork 前的父 runtime turnId 就是典型）；最后按事件归属。
  private goalVerifyTurnId(
    payload: TargetCompletionVerificationPayload,
    event: SessionEvent,
  ): string {
    const anchorMessageId = payload.anchorAssistantMessageId
      ? String(payload.anchorAssistantMessageId)
      : null;
    if (anchorMessageId) {
      const rowId = this.rowIdForMessageId(anchorMessageId);
      const row = rowId !== null ? this.findRow(rowId) : undefined;
      if (row) return row.turnId;
    }
    const anchorTurnId = payload.anchorTurnId ? String(payload.anchorTurnId) : null;
    if (anchorTurnId) {
      const mapped = this.productTurnIdByRuntimeTurnId.get(anchorTurnId) ?? anchorTurnId;
      if (this.turnHeaderRowIdByTurnId.has(mapped)) return mapped;
    }
    return this.turnIdOf(event);
  }

  // ── fork marker（forkAssistant 命令效果）──

  private onSessionForked(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as SessionForkedPayload;
    const isParent = String(payload.originalSessionId) === this.snapshot.sessionId;
    if (isParent) {
      // 父时间线不显示 forkCreated——fork 关系只在 sessions
      // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
      // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
      return [];
    }
    // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
    // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
    const row: TimelineMarkerRow = {
      ...this.rowBase(
        event,
        this.turnIdOf(event),
        `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
      ),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: {
        type: "forkNotice",
        parentSessionId: String(payload.originalSessionId),
        parentRowId: 0,
      },
    };
    return [{ op: "row.appended", row }];
  }

  // ── worktree marker（受管 worktree 创建结果，docs/git/worktree.md §6.6.4）──

  private onWorktreeCreated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorktreeCreatedPayload;
    if (this.turnHeaderRowIdByTurnId.size === 0) {
      this.pendingWorktreeCreated = { event, payload };
      return [];
    }
    return [
      {
        op: "row.appended",
        row: this.worktreeCreatedRow(event, this.turnIdOf(event), payload, "turnTailBoundary"),
      },
    ];
  }

  private worktreeCreatedRow(
    event: SessionEvent,
    turnId: string,
    payload: WorktreeCreatedPayload,
    lane: "lightBoundary" | "turnTailBoundary",
  ): TimelineMarkerRow {
    return {
      ...this.rowBase(event, turnId, `worktree-created:${payload.path}`),
      kind: "timelineMarker",
      lane,
      marker: {
        type: "worktreeCreated",
        path: payload.path,
        sha: payload.sha,
        ref: payload.ref,
        output: payload.output,
      },
    };
  }

  // ── 内部工具 ──

  // goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换。
  // queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
  // queue.items.length + autoDrain，所以 control/queue 变化时同步重算 inputRouting。
  // availability 不在这里算：它在物化时从本事件归约后的完整状态派生（materializeCommandRowActions）。
  private controlPatch(
    control: Partial<SessionControl>,
    goal?: GoalState | null,
    queue?: ConversationSnapshot["queue"],
  ): StatePatch {
    const next: SessionControl = { ...this.snapshot.control, ...control };
    const context = availabilityContextOf({
      control: next,
      goal: goal === undefined ? this.snapshot.goal : goal,
      queue: queue ?? this.snapshot.queue,
      pendingInteractions: this.snapshot.pendingInteractions,
    });
    return {
      control: next,
      ...(goal === undefined ? {} : { goal }),
      ...(queue === undefined ? {} : { queue }),
      inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
    };
  }

  // queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 inputRouting。
  private queuePatch(queue: ConversationSnapshot["queue"]): StatePatch {
    const context = availabilityContextOf({ ...this.snapshot, queue });
    return {
      queue,
      inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
    };
  }

  private upsertTurnHeader(
    event: SessionEvent,
    state: "completedSuccess" | "completedInterrupted" | "failed",
    activeMs?: number,
    historyRoundCount?: number,
    highspeedTiming?: {
      modelDurationMs: number;
      toolDurationMs: number;
      otherDurationMs: number;
    },
  ): ConversationDelta[] {
    const row = this.turnHeaderForEvent(event);
    if (!row) return [];
    const endedAt = this.ms(event);
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          state,
          endedAt,
          ...(activeMs !== undefined ? { activeMs } : {}),
          ...highspeedTiming,
          ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
          ...(row.workSegments
            ? {
                workSegments: this.completeWorkSegments(row.workSegments, endedAt),
              }
            : {}),
        },
      },
    ];
  }

  private recordHighspeedToolStarted(turnId: string, toolCallId: string, startedAt: number): void {
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
    intervals.set(toolCallId, { startedAt });
    this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
  }

  private recordHighspeedToolEnded(
    turnId: string,
    toolCallId: string,
    endedAt: number,
    durationMs?: number,
  ): void {
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
    const existing = intervals.get(toolCallId);
    const startedAt = existing?.startedAt ?? Math.max(0, endedAt - Math.max(0, durationMs ?? 0));
    intervals.set(toolCallId, {
      startedAt,
      endedAt: Math.max(
        startedAt,
        existing && durationMs !== undefined ? startedAt + durationMs : endedAt,
      ),
    });
    this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
  }

  private highspeedTimingForTurn(
    turnId: string,
    activeMs?: number,
  ): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined {
    const modelDurationMs = this.highspeedModelDurationByTurnId.get(turnId);
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId);
    if (modelDurationMs === undefined && intervals === undefined) return undefined;
    const sorted = [...(intervals?.values() ?? [])]
      .filter((interval) => interval.endedAt !== undefined)
      .sort((left, right) => left.startedAt - right.startedAt);
    let toolDurationMs = 0;
    let unionEnd = -1;
    for (const interval of sorted) {
      const start = Math.max(0, interval.startedAt);
      const end = Math.max(start, interval.endedAt ?? start);
      if (start > unionEnd) toolDurationMs += end - start;
      else if (end > unionEnd) toolDurationMs += end - unionEnd;
      unionEnd = Math.max(unionEnd, end);
    }
    const model = Math.max(0, modelDurationMs ?? 0);
    const otherDurationMs = Math.max(
      0,
      (activeMs ?? model + toolDurationMs) - model - toolDurationMs,
    );
    this.highspeedModelDurationByTurnId.delete(turnId);
    this.highspeedToolIntervalsByTurnId.delete(turnId);
    return { modelDurationMs: model, toolDurationMs, otherDurationMs };
  }

  private openGuidedWorkSegment(event: SessionEvent, triggerEntityId: string): ConversationDelta[] {
    const row = this.turnHeaderForEvent(event);
    if (!row || row.executionKind === "controlOnly") return [];
    const startedAt = this.ms(event);
    const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
      {
        segmentId: `${row.turnId}:initial`,
        startedAt: row.startedAt,
      },
    ];
    // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
    // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
    const workSegments = [
      ...this.completeWorkSegments(existingSegments, startedAt),
      {
        segmentId: triggerEntityId,
        triggerEntityId,
        startedAt,
      },
    ];
    return [{ op: "row.upserted", row: { ...row, workSegments } }];
  }

  private completeWorkSegments(
    segments: readonly TurnWorkSegment[],
    endedAt: number,
  ): TurnWorkSegment[] {
    return segments.map((segment, index) =>
      index === segments.length - 1 && segment.endedAt === undefined
        ? {
            ...segment,
            endedAt,
            activeMs: Math.max(0, endedAt - segment.startedAt),
          }
        : segment,
    );
  }

  private turnHeaderForEvent(event: SessionEvent): TurnHeaderRow | undefined {
    const rowId = this.turnHeaderRowIdByTurnId.get(this.turnIdOf(event));
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "turnHeader" ? row : undefined;
  }

  private markStableForkAssistant(event: SessionEvent): ConversationDelta[] {
    const turnId = this.turnIdOf(event);
    const rows = this.snapshot.rows.window;
    const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
    const headerIndex = headerRowId === undefined ? undefined : this.rowIndexById.get(headerRowId);
    const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
    let row: AssistantTextRow | undefined;
    // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
    // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
    for (let index = rows.length - 1; index >= startIndex; index -= 1) {
      const candidate = rows[index];
      if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
      row = candidate;
      break;
    }
    if (!row || !this.messageIdByRowId.has(row.rowId)) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          state: "complete",
          actions: { ...row.actions, canFork: true },
        },
      },
    ];
  }

  private isRunning(): boolean {
    const phase = this.snapshot.control.phase;
    return phase === "running" || phase === "prewarming";
  }

  private isMirroredSubagentToolEvent(event: SessionEvent): boolean {
    const payload = event.payload as unknown as Record<string, unknown>;
    // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
    // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
    // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
    return payload.source === "subagent";
  }

  private openAssistantSegments(): Partial<
    Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>
  > {
    const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
    const text = this.openSegmentIdentity(this.streamingTextRowId);
    const reasoning = this.openSegmentIdentity(this.streamingReasoningRowId);
    if (text) segments.text = text;
    if (reasoning) segments.reasoning = reasoning;
    return segments;
  }

  private openSegmentIdentity(rowId: number | null): CanonicalOpenSegmentIdentity | null {
    if (rowId === null) return null;
    const entityId = this.entityIdByRowId.get(rowId);
    if (!entityId) return null;
    return {
      entityId,
      transcriptMessageId: this.messageIdByRowId.get(rowId) ?? null,
    };
  }

  private rowBase(event: SessionEvent, turnId: string, entityId = String(event.id)) {
    const rowId = this.nextRowId++;
    this.entityIdByRowId.set(rowId, entityId);
    return {
      rowId,
      turnId,
      entityId,
      productTurnId: turnId,
      visibility: "visible" as const,
      createdAt: this.ms(event),
      createdAtSeq: event.sequenceNumber,
    };
  }

  private turnIdOf(event: SessionEvent): string {
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
    return this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  }

  private ms(event: SessionEvent): number {
    return event.timestamp.getTime();
  }

  private findRow(rowId: number): ConversationRow | undefined {
    const index = this.rowIndexById.get(rowId);
    return index === undefined ? undefined : this.snapshot.rows.window[index];
  }

  private updateRowIndexAfterImmutableApply(
    previousRowsLength: number,
    deltas: readonly ConversationDelta[],
  ): void {
    if (deltas.some((delta) => delta.op === "row.removed")) {
      // 重建的索引直接用 TransactionalMap：之后的原子事件共享它，而不是先退回普通 Map 再复制一次。
      this.rowIndexById = new TransactionalMap<number, number>(
        this.snapshot.rows.window.map((row, index) => [row.rowId, index]),
      );
      return;
    }
    let nextIndex = previousRowsLength;
    for (const delta of deltas) {
      if (delta.op !== "row.appended") continue;
      this.rowIndexById.set(delta.row.rowId, nextIndex);
      nextIndex += 1;
    }
  }

  private findToolRow(toolCallId: string): ToolCallRow | undefined {
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "toolCall" ? row : undefined;
  }

  private findSubagentRow(agentId: string): SubagentRow | undefined {
    const rowId = this.subagentRowIdByAgentId.get(agentId);
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "subagent" ? row : undefined;
  }

  private findSubagentLifecycleRow(
    agentId: string,
    payload: Record<string, unknown>,
    event: SessionEvent,
  ): SubagentRow | undefined {
    const exact = this.findSubagentRow(agentId);
    if (exact) return exact;

    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    if (!parentToolCallId) return undefined;
    const turnId = this.turnIdOf(event);
    // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
    // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
    // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
    // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
    return this.snapshot.rows.window.find(
      (row): row is SubagentRow =>
        row.kind === "subagent" &&
        row.turnId === turnId &&
        row.parentToolCallId === parentToolCallId,
    );
  }

  private subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string {
    return (
      this.stringPayload(payload, "agentId") ??
      this.stringPayload(payload, "childSessionId") ??
      this.stringPayload(payload, "parentToolCallId") ??
      `subagent-${event.sequenceNumber}`
    );
  }

  private stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private mapSubagentStatus(status: string | undefined): SubagentRow["status"] {
    switch (status) {
      case "completed":
      case "success":
        return "success";
      case "cancelled":
      case "stopped":
        return "cancelled";
      default:
        return "failed";
    }
  }
}

function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === "AskUserQuestion";
}

/**
 * 把 core 的 tool display 收窄成 v4 协议能承载的那几种 kind。
 *
 * 这份白名单原先在每个投影点各写一份内联判断，引入
 * create_workflow display 时漏改了其中一份，实时投影把图整个丢掉、而 hydration 路径没过滤，
 * 于是桌面端只有重载之后才看得到。收成一个谓词后，所有投影点共用同一份名单。
 */
function toProtocolToolCallDisplay(
  display: ToolResultDisplayPayload | undefined,
): ToolCallDisplay | undefined {
  if (!display) return undefined;
  switch (display.kind) {
    case "node_repl_images":
    case "task_output":
    case "respond_to_coordinator":
    case "mcp_tool":
    case "create_workflow":
    // 观察类工作流工具的五个 display kind——shared 侧 toolCallDisplaySchema 已同步加
    // 成员，这里放行后 UI 才能在 row.display 上拿到结构化载荷。
    case "get_workflow_run":
    case "list_workflow_runs":
    case "eval_workflow_snippet":
    case "saved_workflow_list":
    case "list_models":
    // ResumeWorkflowRun 的恢复卡。
    case "resume_workflow_run":
      return display;
    default:
      return undefined;
  }
}

function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === "ExitPlanMode";
}

function createExitPlanModeApprovalQuestion(reason: string): UserInputQuestionPayload {
  return {
    question: reason,
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
  };
}

function readAskUserQuestionPayloadQuestions(input: unknown): UserInputQuestionPayload[] {
  const rawQuestions = readRawAskUserQuestions(input);
  return rawQuestions
    .map(normalizeAskUserQuestionPayloadQuestion)
    .filter((question): question is UserInputQuestionPayload => question !== null);
}

function readRawAskUserQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function normalizeAskUserQuestionPayloadQuestion(value: unknown): UserInputQuestionPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const question = nonEmptyString(value.question);
  const header = nonEmptyString(value.header) ?? question;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map(normalizeAskUserQuestionPayloadOption)
    .filter((option): option is UserInputQuestionPayload["options"][number] => option !== null);
  if (!question || !header || options.length === 0) {
    return null;
  }
  return {
    question,
    header,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

function normalizeAskUserQuestionPayloadOption(
  value: unknown,
): UserInputQuestionPayload["options"][number] | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const label = nonEmptyString(value.label) ?? nonEmptyString(value.value);
  const optionValue = nonEmptyString(value.value) ?? label;
  if (!label || !optionValue) {
    return null;
  }
  return {
    value: optionValue,
    label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

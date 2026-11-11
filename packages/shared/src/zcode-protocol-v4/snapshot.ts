/* oxlint-disable max-lines -- v4 snapshot schema is a frozen cross-process contract; additions stay grouped here. */
// ConversationSnapshot A 区。
// A 区更新语义 = 字段级整体替换（state.updated），绝不深合并——深合并是错乱之母。
import { pluginInstallRequestPayloadSchema } from "./pluginInstall.js";
import { z } from "zod";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
export { sharedContextImportStateSchema } from "./shared-context-import.js";
import { conversationInputDispatchSchema, conversationInputIntentSchema } from "./input-intent.js";
import {
  zcodeContextUsageBreakdownSchema,
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  zcodeSessionContextCacheUsageSchema,
} from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";
import { displayConversationRowSchema } from "./rows.js";
import { toolCallDisplaySchema } from "./toolDisplay.js";

import { workspaceHookReviewRequestPayloadSchema } from "./workspace-hook-review.js";
import { workflowRunsStateSchema } from "./workflow-runs.js";
import { sessionConfigStateSchema, sessionModelTransitionSchema } from "./session-config.js";
export {
  sessionConfigStateSchema,
  sessionModelTransitionSchema,
  type SessionConfigState,
  type SessionModelTransition,
} from "./session-config.js";
// ── SessionControl ──
export const sessionPhaseSchema = z.enum([
  // draft 裁决保留——纯内存态、sessions-index 可见、无 row、
  // 不落盘、CLI 重启即消失；firstInput 到达 → prewarming/running。
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

export const stopTargetKindSchema = z.enum([
  "assistant",
  "tool",
  "subagent",
  "compact",
  "goalVerifier",
  "goalContinuation",
  "turnSteer",
  "mixed",
  "unknown",
]);
export type StopTargetKind = z.infer<typeof stopTargetKindSchema>;

export const activeWorkSummarySchema = z.object({
  kind: z.enum([
    "primaryTurn",
    "foregroundSubagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
  ]),
  foregroundExecutionId: z.string().min(1).optional(),
  sourceCommandId: z.string().min(1).optional(),
  startedAt: timestampSchema,
});
export type ActiveWorkSummary = z.infer<typeof activeWorkSummarySchema>;

// 错误码分为 fault.*、proto.* 与 guard.*。
export const errorAttributionSchema = z
  .object({
    source: z.enum(["provider", "runtime", "tool", "network"]).optional(),
    reason: z.string().min(1).max(160).optional(),
    errorPhase: z
      .enum([
        "prepare",
        "configuration",
        "connect",
        "response",
        "stream",
        "parse",
        "validation",
        "unhandled",
      ])
      .optional(),
    exceptionKind: z
      .enum([
        "api_call",
        "generic",
        "protocol",
        "provider_business",
        "transport",
        "type_error",
        "validation",
      ])
      .optional(),
    providerId: z.string().min(1).max(160).optional(),
    modelId: z.string().min(1).max(160).optional(),
    providerKind: z.string().min(1).max(160).optional(),
    transport: z.enum(["http", "sse", "websocket"]).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().min(1).max(160).optional(),
    retryable: z.boolean().optional(),
    /** string=使用该 Highspeed 卡，null=明确未使用，undefined=旧 Agent 未发布。 */
    highspeedCardId: z.string().nullable().optional(),
    /** true=本轮 Highspeed 失败已命中退回声明但无可用退回目标；Renderer 据此作废匹配卡。 */
    highspeedFallbackUnavailable: z.boolean().optional(),
  })
  .strict();
export type ErrorAttribution = z.infer<typeof errorAttributionSchema>;

export const sessionErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  at: timestampSchema,
  source: z.enum(["provider", "runtime", "tool", "network"]),
  traceId: z.string().optional(),
  detail: z.string().optional(),
  underlyingErrorMessage: z.string().optional(),
  underlyingErrorDetail: z.string().optional(),
  attribution: errorAttributionSchema.optional(),
});
export type SessionErrorInfo = z.infer<typeof sessionErrorInfoSchema>;

export const apiRetryStateSchema = z.object({
  attempt: z.number(),
  maxAttempts: z.number(),
  nextRetryAt: timestampSchema,
  reasonCode: z.string(),
});
export type ApiRetryState = z.infer<typeof apiRetryStateSchema>;

export const sessionControlSchema = z.object({
  phase: sessionPhaseSchema,
  // 派生值（= phase ∈ completed*），为 UI 便利保留。
  sessionEnded: z.boolean(),
  canStop: z.boolean(),
  stopState: z.enum(["idle", "stoppable", "stopping"]),
  stopTargetKind: stopTargetKindSchema,
  // 轻量证据/悬浮提示用，UI 不得据此推导 flag。
  // hasBackgroundWork 不在载荷内：客户端按 backgroundWorks.some(w => w.status === "running") 一行派生。
  activeWorks: z.array(activeWorkSummarySchema),
  lastError: sessionErrorInfoSchema.nullable(),
  apiRetry: apiRetryStateSchema.nullable(),
});
export type SessionControl = z.infer<typeof sessionControlSchema>;

// ── availability 与 inputRouting ──
export const actionAvailabilitySchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  // reasonCode = product-protocol guard id，驱动禁用态 tooltip。
  z.object({ allowed: z.literal(false), reasonCode: z.string() }),
]);
export type ActionAvailability = z.infer<typeof actionAvailabilitySchema>;

export const sessionActionAvailabilitySchema = z.object({
  fork: actionAvailabilitySchema,
  compact: actionAvailabilitySchema,
  switchModelConfig: actionAvailabilitySchema,
  setFollowupMode: actionAvailabilitySchema,
  queueEdit: actionAvailabilitySchema,
  sendQueuedNow: actionAvailabilitySchema,
  pauseGoal: actionAvailabilitySchema,
  resumeGoal: actionAvailabilitySchema,
  // 文件撤销的 session 锁；目标资格看 turnHeader.actions.canRewindFiles。
  // optional 只用于兼容旧 CLI 的帧（旧 CLI 把锁写在行上）：客户端缺失时按允许处理。
  rewindFiles: actionAvailabilitySchema.optional(),
});
export type SessionActionAvailability = z.infer<typeof sessionActionAvailabilitySchema>;

export const inputRoutingSchema = z.object({
  // choice：held（completed+queue>0+autoDrain=false）下
  // 输入不静默入队，客户端呈现「清空 queue 后发送 / 保留 queue 立即发送」。
  mode: z.enum(["startNow", "enqueue", "guide", "reject", "choice"]),
  // mode=reject 必带；enqueue/guide/choice 可带（如 guide 不合格回退原因）。
  reasonCode: z.string().optional(),
});
export type InputRouting = z.infer<typeof inputRoutingSchema>;

// ── meta（会话级元信息：标题）。renameSession/自动标题落此。──
export const sessionMetaStateSchema = z.object({
  title: z.string(),
  // default = 未命名；generated = 模型自动生成；custom = 用户显式重命名（不再被自动标题覆盖）。
  titleSource: z.enum(["default", "generated", "custom"]),
});
export type SessionMetaState = z.infer<typeof sessionMetaStateSchema>;

/**
 * 分享导入的只读来源标记。
 *
 * shared_context 正文只给模型使用，不能通过 userInput row 伪造到会话气泡里；
 * 这个 additive 元数据让 Desktop 在新会话中仍能明确告诉用户上下文来自哪里。
 */
export type { SharedContextImportState } from "./shared-context-import.js";

// ── usage。conflation：值未变不下发──
export const sessionUsageStateSchema = z.object({
  contextWindow: z
    .object({
      usedTokens: z.number(),
      maxTokens: z.number(),
      autoCompactThresholdTokens: z.number().nullable(),
      cache: zcodeSessionContextCacheUsageSchema.optional(),
      breakdown: zcodeContextUsageBreakdownSchema.optional(),
    })
    .nullable(),
  cumulative: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
});
export type SessionUsageState = z.infer<typeof sessionUsageStateSchema>;

// ── queue（不持久化，裁决：CLI 进程死亡即丢，客户端对账后由用户决定重发）──
// editorId 标识单个编辑器实例（每个窗口/标签页一个，sessionStorage 持久）；clientId 同设备多窗口共享，
// 不能单独作为锁归属。inputOrigin 由 Host 可信注入，只用于展示「桌面 / 手机」。
export const queueItemEditLockSchema = z
  .object({
    editorId: z.string().min(1),
    clientId: z.string().min(1),
    inputOrigin: z.enum(["desktop", "mobile"]).optional(),
  })
  .strict();
export type QueueItemEditLock = z.infer<typeof queueItemEditLockSchema>;

export const queueItemSchema = conversationInputIntentSchema.extend({
  dispatch: conversationInputDispatchSchema.extend({
    state: z.enum(["queued", "reserved", "promoting"]),
  }),
  /** Host 准入注入的可信 automation 身份；只允许队列提升原样回放。 */
  automationId: z.string().min(1).optional(),
  toolDisallowlist: z.array(z.string().min(1)).optional(),
  /**
   * 底部 composer 正在编辑该项（docs/ui/composer-edit-mode.md）：CLI 内存权威，冻结期间
   * 自动续跑停在该项前，且不能删除、重排或立即发送。缺省 = 未锁。
   */
  editLock: queueItemEditLockSchema.optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueStateSchema = z.object({
  items: z.array(queueItemSchema),
  // stop 后 = false（暂停队列）；setAutoDrain 恢复。
  autoDrain: z.boolean(),
  // additive：旧快照缺省时 UI 使用通用暂停文案；Stop/TurnError 可显示原因文案。
  pauseReason: z.enum(["stopped", "manual", "error"]).optional(),
});
export type QueueState = z.infer<typeof queueStateSchema>;

// ── pendingInteractions（阻塞交互 → 状态）──
export const MAX_PERMISSION_FEEDBACK_CHARS = 4_096;

export const PERMISSION_FULL_ACCESS_OPTION_ID = "fullAccess";
export const PERMISSION_GUARDED_OPTION_ID = "allowAndSwitchGuarded";
export function permissionGrantMode(optionId: string | undefined): "guarded" | "yolo" | undefined {
  if (optionId === PERMISSION_GUARDED_OPTION_ID) return "guarded";
  if (optionId === PERMISSION_FULL_ACCESS_OPTION_ID) return "yolo";
  return undefined;
}
const permissionOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  kind: z.enum(["allowOnce", "allowAlways", "deny", "custom"]),
  response: zcodePermissionResponseSchema.optional(),
});

export const permissionRequestPayloadSchema = z.object({
  kind: z.literal("permission"),
  toolCallId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  detail: z.unknown(),
  // additive：旧 snapshot 缺省时 UI 不显示反馈输入；V4 新投影可显式开启。
  freeText: z.boolean().optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
  // 工具自报的确认预览，复用 row 的 display 投影（同一有界形状）。缺省 = 纯文本 ask。
  // 同样不设门：预览解析失败退化成纯文本 ask，不拒整份 snapshot（见 toolDisplay.ts 注释）。
  display: toolCallDisplaySchema.optional().catch(undefined),
  // 独立 additive 能力：旧 UI 忽略此字段，仍只显示原 options，不出现半实现授权入口。
  modeSwitch: z.enum(["choose", "fullAccessOnly"]).optional(),
  fullAccessOption: permissionOptionSchema
    .extend({
      optionId: z.literal(PERMISSION_FULL_ACCESS_OPTION_ID),
      kind: z.literal("custom"),
    })
    .optional(),
  options: z.array(permissionOptionSchema),
});
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;

export const userInputOptionPayloadSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type UserInputOptionPayload = z.infer<typeof userInputOptionPayloadSchema>;

export const userInputQuestionPayloadSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(userInputOptionPayloadSchema),
  multiSelect: z.boolean().optional(),
});
export type UserInputQuestionPayload = z.infer<typeof userInputQuestionPayloadSchema>;

export const userInputRequestPayloadSchema = z.object({
  kind: z.literal("userInput"),
  prompt: z.string(),
  freeText: z.boolean(),
  options: z.array(z.object({ optionId: z.string(), label: z.string() })).optional(),
  // true → 输入框按密码处理，客户端不入草稿/历史。
  sensitive: z.boolean().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  traceId: z.string().optional(),
  input: z.unknown().optional(),
  schema: z.unknown().optional(),
  questions: z.array(userInputQuestionPayloadSchema).optional(),
  currentQuestionIndex: z.number().optional(),
  answerDrafts: z.record(z.string(), z.array(z.string())).optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
});
export type UserInputRequestPayload = z.infer<typeof userInputRequestPayloadSchema>;

export const interactionAutoResolutionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum(["hiddenGrace", "visibleCountdown"]),
    startedAt: timestampSchema,
    visibleAt: timestampSchema,
    deadlineAt: timestampSchema,
  }),
  z.object({
    state: z.literal("snoozed"),
    startedAt: timestampSchema,
    snoozedAt: timestampSchema,
  }),
]);
export type InteractionAutoResolution = z.infer<typeof interactionAutoResolutionSchema>;

export const pendingInteractionSchema = z
  .object({
    interactionId: z.string(),
    kind: z.enum(["permission", "userInput", "workspaceHookReview", "pluginInstall"]),
    // null = 会话级（如 provider 交互和 workspace Hook review）。
    anchorRowId: z.number().nullable(),
    createdAt: timestampSchema,
    autoResolution: interactionAutoResolutionSchema.optional(),
    payload: z.discriminatedUnion("kind", [
      permissionRequestPayloadSchema,
      userInputRequestPayloadSchema,
      workspaceHookReviewRequestPayloadSchema,
      pluginInstallRequestPayloadSchema,
    ]),
  })
  .superRefine((interaction, context) => {
    if (interaction.kind !== interaction.payload.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "pending interaction kind must match payload kind",
      });
    }
    if (
      (interaction.kind === "workspaceHookReview" || interaction.kind === "pluginInstall") &&
      interaction.autoResolution
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoResolution"],
        message: "workspaceHookReview cannot use AskUserQuestion auto-resolution",
      });
    }
    if (
      interaction.payload.kind === "workspaceHookReview" &&
      interaction.interactionId !== interaction.payload.interactionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactionId"],
        message: "workspaceHookReview interaction id must match its immutable payload",
      });
    }
  });
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

// ── pendingCommands / backgroundWorks ──
export const commandStateSummarySchema = z.object({
  commandId: z.string(),
  clientId: z.string(),
  type: z.string(),
  state: z.enum(["accepted", "executing"]),
  at: timestampSchema,
});
export type CommandStateSummary = z.infer<typeof commandStateSummarySchema>;

export const backgroundWorkSummarySchema = z.object({
  workId: z.string(),
  // workflow = workflow run（CreateWorkflow）。**闭集加值的偏斜代价**：
  // 旧桌面收到未知值时整个 state.updated patch 解析失败（已知键的非法值是错误，不是剥离），
  // 于是整帧被 assembler 拒收，且 resync 的 snapshot 携带同一个值、同样失败——不能优雅降级。
  // CLI 与桌面同批发布才使它可接受。
  kind: z.enum(["bash", "subagent", "workflow"]),
  title: z.string(),
  // resultPending = 已完成、结果在 continuation inbox 等待前台空闲；
  // 投递后条目消失（结果本体成为 origin=backgroundResult 的 userInput row）。
  status: z.enum(["running", "resultPending", "failed", "cancelled"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  cancellable: z.boolean().optional(),
  blocked: z.boolean().optional(),
  anchorRowId: z.number().nullable(),
  childSessionId: z.string().optional(),
});
export type BackgroundWorkSummary = z.infer<typeof backgroundWorkSummarySchema>;

// subagent 运行态属于 conversation 权威投影，而不是 renderer 查询缓存。
// ended 详情保持 cursor query；snapshot 只携带目录总数，避免运行中并发数量依赖查询时序。
export const runningSubagentSummarySchema = z.object({
  childSessionId: z.string(),
  agentId: z.string().optional(),
  toolCallId: z.string().optional(),
  subagentType: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.enum(["running", "waiting", "blocked"]),
  stopControl: z
    .object({ taskId: z.string().min(1), executionId: z.string().min(1) })
    .strict()
    .optional(),
  startedAt: timestampSchema.optional(),
});
export type RunningSubagentSummary = z.infer<typeof runningSubagentSummarySchema>;

export const subagentProjectionStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  childSessionIds: z.array(z.string()),
  running: z.array(runningSubagentSummarySchema),
  endedTotal: z.number().int().nonnegative(),
});
export type SubagentProjectionState = z.infer<typeof subagentProjectionStateSchema>;

// ── goal / plan ──
export const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "inProgress", "completed"]),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const goalIterationStateSchema = z.object({
  iteration: z.number().int().positive(),
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type GoalIterationState = z.infer<typeof goalIterationStateSchema>;

export const goalStateSchema = z.object({
  // default 仅用于旧快照兼容；新投影始终携带当前 target 身份和计时事实。
  targetId: z.string().default(""),
  objective: z.string(),
  summaryTitle: z.string().nullable().default(null),
  timeUsedSeconds: z.number().int().nonnegative().default(0),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().default(null),
  // paused：stop 作用于任何 foreground work 时 target 强制进入（stopPausesActiveGoalTarget）。
  // notSatisfied 与 failed 分离：前者是有效结论，后者是验证过程失败。
  status: z.enum(["active", "paused", "verifying", "verified", "notSatisfied", "failed"]),
  iteration: z.number(),
  verifications: z.array(
    z.object({
      iteration: z.number(),
      outcome: z.enum(["pass", "notSatisfied", "failed"]),
      at: timestampSchema,
      anchorRowId: z.number().nullable(),
      reason: z.string().optional(),
      nextAction: z.string().optional(),
    }),
  ),
  iterations: z.array(goalIterationStateSchema).default([]),
});
export type GoalState = z.infer<typeof goalStateSchema>;

export const planStateSchema = z.object({
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type PlanState = z.infer<typeof planStateSchema>;

// ── Snapshot 总览 ──
export const rowsWindowSchema = z.object({
  // 尾部窗口，rowId 升序。逐行降级（封闭规则 13）：读不懂的行退化成 unreadable 占位行，
  // 不再让整帧被拒。totalCount/firstRowId 不受影响——降级只改变一行能否渲染，不改变它是否存在。
  window: z.array(displayConversationRowSchema),
  // 当前全序行数（截断后会减小；仅用于滚动条估计）。
  totalCount: z.number(),
  // 全序第一行 rowId；window 首行等于它 ⇔ 已到顶（游标分页判定）。
  firstRowId: z.number().nullable(),
});
export type RowsWindow = z.infer<typeof rowsWindowSchema>;

// 软门禁(Soft Gate)：会话级待审核 hook 准入状态。
// snapshot 与 StatePatch(delta.ts)共用,保证投影补丁与快照字段同构。
export const workspaceHookAdmissionStateSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  bundleDigest: z.string(),
  workspaceIdentity: z.string().optional(),
});
export type WorkspaceHookAdmissionSnapshotState = z.infer<typeof workspaceHookAdmissionStateSchema>;

export const workspaceMcpAdmissionStateSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceIdentity: z.string().min(1).optional(),
});
export type WorkspaceMcpAdmissionSnapshotState = z.infer<typeof workspaceMcpAdmissionStateSchema>;

// 冷历史可读不代表 runtime 已可执行；缺席兼容旧发送端。
export const runtimeInitializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("initializing"), attemptId: z.string().min(1) }),
  z.object({ status: z.literal("ready"), attemptId: z.string().min(1) }),
  z.object({
    status: z.literal("failed"),
    attemptId: z.string().min(1),
    reasonCode: z.string(),
    message: z.string(),
  }),
]);
export type RuntimeInitialization = z.infer<typeof runtimeInitializationSchema>;

export const conversationSnapshotSchema = z.object({
  runtimeInitialization: runtimeInitializationSchema.optional(),
  protocolVersion: z.literal(1),
  sessionId: z.string(),
  logEpoch: z.string(),
  // 快照对齐水位（= 所在帧 toSeq；从内存投影原子取值）。
  seq: z.number(),
  revision: z.number(),
  // A 区
  control: sessionControlSchema,
  availability: sessionActionAvailabilitySchema,
  inputRouting: inputRoutingSchema,
  // meta 是冻结 schema之后的
  // additive 新增，必须带 default 才不破坏旧快照/旧发送端的解析——备份分支曾把它设为
  // 必填，shared 的 round-trip 测试在该分支上一直是红的（当时未跑 root vitest 漏网）。
  meta: sessionMetaStateSchema.default({ title: "", titleSource: "default" }),
  // Additive：旧 CLI/旧快照不带该字段时仍按普通会话处理。
  sharedContextImport: sharedContextImportStateSchema.optional(),
  config: sessionConfigStateSchema,
  // 持久化稳定事实供 live 客户端识别一次性提示；旧快照缺字段时不触发。
  modelTransition: sessionModelTransitionSchema.nullable().default(null),
  usage: sessionUsageStateSchema,
  queue: queueStateSchema,
  pendingInteractions: z.array(pendingInteractionSchema),
  pendingCommands: z.array(commandStateSummarySchema),
  backgroundWorks: z.array(backgroundWorkSummarySchema),
  // optional 只服务旧快照 wire 兼容；新 CLI 的初始态和每次投影都始终携带该字段。
  subagents: subagentProjectionStateSchema.optional(),
  // 冷快照必须携带 workflowRuns：漏这一处，刷新/重连后正在跑的 run 会静默消失
  // （详情页因此空白，而 run 本身仍在飞）。optional 同样只服务旧快照 wire 兼容。
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable(),
  plan: planStateSchema.nullable(),
  // 软门禁(Soft Gate)：additive 字段,必须带 default(null)。
  // 旧快照/旧发送端不携带此字段 → 解析得 null,不破坏兼容性(遵守冻结规则)。
  // pendingCount === 0 时投影层置 null(提示条消失)。
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().default(null),
  // 旧发送端可缺席；null 或缺席均无 MCP 待审核提示。
  workspaceMcpAdmission: workspaceMcpAdmissionStateSchema.nullable().optional(),
  // （2026-09-12）：原 additive 字段 pluginUiSurfaces 已删除，插件面板 widgetState 只留在
  // 宿主 renderer 内存。
  // B 区
  rows: rowsWindowSchema,
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

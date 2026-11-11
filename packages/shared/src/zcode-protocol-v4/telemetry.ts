import { z } from "zod";
import { sanitizeTelemetrySkillName } from "../telemetry.js";
import { zcodeSyntheticUserMessageSourceSchema } from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";

const factBaseFields = {
  /** 会话创建期采用的 App Memory 开关，不表示记忆读写结果。 */
  memoryEnabled: z.boolean().optional(),
  version: z.literal(1),
  eventId: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  sessionId: z.string().min(1),
  sourceCommandId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
} as const;

const providerHostnameSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      /^\[[0-9a-f:.]+\]$/iu.test(value) ||
      (!/[\s/:?#@]/u.test(value) &&
        !value.includes("[") &&
        !value.includes("]") &&
        value.trim() === value),
    "providerHostname must be a hostname without scheme, port, path, query, credentials or fragment",
  );

const toolPerformanceFactSchema = z
  .object({
    totalMs: z.number().int().nonnegative().optional(),
    permissionWaitMs: z.number().int().nonnegative().optional(),
    commandRunMs: z.number().int().nonnegative().optional(),
    firstOutputMs: z.number().int().nonnegative().optional(),
    noOutputMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    commandCategory: z.string().max(64).optional(),
    commandName: z.string().max(128).optional(),
    commandCount: z.number().int().nonnegative().optional(),
    commandStatus: z
      .enum(["completed", "failed", "timed_out", "cancelled", "spawn_error", "backgrounded"])
      .optional(),
    commandHash: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .optional(),
    fsReadMs: z.number().int().nonnegative().optional(),
    fsWriteMs: z.number().int().nonnegative().optional(),
    patchMatchMs: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    maxFileBytes: z.number().int().nonnegative().optional(),
    hunkCount: z.number().int().nonnegative().optional(),
    matchAttempts: z.number().int().nonnegative().optional(),
    workspaceKind: z.enum(["local", "remote", "unknown"]).optional(),
  })
  .strict();

const turnStartedFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.started"),
    inputOrigin: z.enum(["desktop", "mobile"]).optional(),
    modelName: z.string().optional(),
    modelProvider: z.string().optional(),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    inputSource: zcodeSyntheticUserMessageSourceSchema.optional(),
    // `workflow`：dynamic-workflow run 的完成 / 提问通知唤起的独立轮。
    backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
    automationId: z.string().min(1).optional(),
    offPeakTaskId: z.string().min(1).optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    taskTrigger: z.enum(["schedule", "manual"]).optional(),
    scheduledAt: timestampSchema.optional(),
  })
  .strict();

const modelRequestStatusFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("model.request.status"),
    requestId: z.string().min(1),
    status: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    providerId: z.string(),
    modelId: z.string(),
    providerKind: z.string().optional(),
    providerHostname: providerHostnameSchema.optional(),
    transport: z.string(),
    querySource: z.string().optional(),
    queryId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
    reason: z.string().optional(),
    retryable: z.boolean().optional(),
    statusCode: z.number().int().optional(),
    delayMs: z.number().nonnegative().optional(),
    nextAttempt: z.number().int().nonnegative().optional(),
    idleMs: z.number().nonnegative().optional(),
    timeoutMs: z.number().nonnegative().optional(),
  })
  .strict();

const streamChunkFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("stream.chunk"),
    channel: z.enum(["thought", "text"]),
    chunkLength: z.number().int().nonnegative(),
    firstChunk: z.boolean(),
    assistantMessageId: z.string().min(1).optional(),
    partId: z.string().min(1).optional(),
    parentToolCallId: z.string().min(1).optional(),
  })
  .strict();

const toolLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("tool.lifecycle"),
    phase: z.enum(["scheduled", "started", "progress", "completed", "failed"]),
    toolCallId: z.string().min(1),
    toolName: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    parentToolCallId: z.string().min(1).optional(),
    childToolCallId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    agentType: z.string().optional(),
    childSessionId: z.string().min(1).optional(),
    background: z.boolean().optional(),
    skillName: z
      .string()
      .refine(
        (value) => sanitizeTelemetrySkillName(value) === value,
        "skillName must be a bounded, safe resolved Skill identifier",
      )
      .optional(),
    skillQualifiedName: z.string().min(1).optional(),
    skillPluginId: z.string().min(1).optional(),
    pluginId: z.string().min(1).max(256).optional(),
    pluginComponent: z.enum(["skill", "mcp"]).optional(),
    skillSource: z.enum(["agents", "zcode", "bundled", "plugin", "remote"]).optional(),
    performance: toolPerformanceFactSchema.optional(),
    automationId: z.string().min(1).optional(),
  })
  .strict();

const permissionLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("permission.lifecycle"),
    phase: z.enum(["requested", "resolved", "denied"]),
    requestId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    toolName: z.string().optional(),
    childSessionId: z.string().min(1).optional(),
    background: z.boolean().optional(),
    decision: z.enum(["allow", "deny", "escalate", "modify"]).optional(),
  })
  .strict();

const usageDeltaFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("usage.delta"),
    requestId: z.string().min(1).optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    providerKind: z.string().optional(),
    providerHostname: providerHostnameSchema.optional(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    reasoningTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
  })
  .strict();

const subagentLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("subagent.lifecycle"),
    phase: z.enum(["spawned", "stopped"]),
    agentId: z.string().min(1),
    agentType: z.string().optional(),
    childSessionId: z.string().min(1),
    parentToolCallId: z.string().min(1).optional(),
    background: z.boolean(),
    status: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

/**
 * 动态工作流子代理的归属事实。由父会话的 workflow run 进度事件派生：
 * - `actor-spawned`：一个子代理会话诞生。`childSessionId` 是 driver 生成的子会话 id，
 *   `sourceCommandId`（基字段）是该 run 的启动输入 id——子代理 step 挂在它下面。
 * - `run-settled`：run 结算即该 run 全部子代理的终态（子代理会话活到 run dispose）。
 *   `status` 是 run 的终态；`stopReason` 只在 `stopped` 时在场。
 * 只带 id 与状态，不带脚本、prompt、结果正文。
 */
const workflowLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("workflow.lifecycle"),
    phase: z.enum(["actor-spawned", "run-settled"]),
    runId: z.string().min(1),
    toolCallId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    childSessionId: z.string().min(1).optional(),
    status: z.enum(["completed", "errored", "stopped"]).optional(),
    stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

const turnTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.terminal"),
    status: z.enum(["success", "interrupted", "failed"]),
    resultType: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokenCount: z.number().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    errorRetryable: z.boolean().optional(),
    turnPhase: z.string().optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
    /** 本轮消费过 dynamic-workflow run 的通知（完成 / 提问）；`agent_composition` 的 wf 维度。 */
    workflowResultConsumed: z.boolean().optional(),
  })
  .strict();

const compactionTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("compaction.terminal"),
    operationId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    summaryMessageId: z.string().min(1).optional(),
    status: z.enum(["completed", "failed", "interrupted"]),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]),
    compactReason: z.string().optional(),
    reason: z.string().optional(),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    modelName: z.string().optional(),
    modelProvider: z.string().optional(),
  })
  .strict();

/**
 * CLI 经 `v4/telemetry/event` 上送的实时会话事实，供桌面埋点与运行中会话统计消费。
 * 每个分支都 strict，避免新增 runtime 字段时把 prompt、工具输入或 provider URL 意外外带。
 */
const conversationTelemetryFactRuntimeSchema = z
  .discriminatedUnion("kind", [
    turnStartedFactSchema,
    modelRequestStatusFactSchema,
    streamChunkFactSchema,
    toolLifecycleFactSchema,
    permissionLifecycleFactSchema,
    usageDeltaFactSchema,
    subagentLifecycleFactSchema,
    workflowLifecycleFactSchema,
    turnTerminalFactSchema,
    compactionTerminalFactSchema,
  ])
  .superRefine((fact, context) => {
    if (fact.kind === "turn.started" && fact.automationId && fact.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (fact.kind === "turn.started" && fact.offPeakRunType && !fact.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    // discriminatedUnion 的成员必须是裸 ZodObject，按 phase 的条件必填只能写在这里。
    if (
      fact.kind === "workflow.lifecycle" &&
      fact.phase === "actor-spawned" &&
      (!fact.agentId || !fact.childSessionId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actor-spawned requires agentId and childSessionId",
      });
    }
    if (fact.kind === "workflow.lifecycle" && fact.phase === "run-settled" && !fact.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "run-settled requires status",
        path: ["status"],
      });
    }
  });

type ConversationTelemetryFactBase = z.infer<typeof conversationTelemetryFactRuntimeSchema>;
type TurnStartedConversationTelemetryFact = Extract<
  ConversationTelemetryFactBase,
  { kind: "turn.started" }
> &
  import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution;

export type ConversationTelemetryFact =
  | Exclude<ConversationTelemetryFactBase, { kind: "turn.started" }>
  | TurnStartedConversationTelemetryFact;

export const conversationTelemetryFactSchema = conversationTelemetryFactRuntimeSchema.transform(
  (fact): ConversationTelemetryFact => fact as ConversationTelemetryFact,
);

/**
 * 模型请求指标：一次成功完成的模型请求的耗时与服务商 usage，供扩展进程算生成速率。
 * 规格：docs/monitoring/conversation-telemetry-v4.md「模型请求指标」。
 *
 * 兼容性：不进 `ConversationTelemetryFact` union，也不加到 `model.request.status`。
 * 上面每个分支都是 strict，旧 App 解析到未知字段会丢掉整条事实；它走独立通知
 * `V4_NOTIFICATIONS.modelRequestMetrics`，旧 App 对未知通知方法不做处理。
 * 只带 id、模型身份、耗时与 token 数，不带正文、header、URL 或 finish reason。
 */
export const modelRequestMetricsFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("model.request.metrics"),
    requestId: z.string().min(1),
    providerId: z.string(),
    modelId: z.string(),
    // 请求用途：main_turn / session_title / compact / subagent …，来自请求 trace 属性。
    querySource: z.string().optional(),
    queryId: z.string().min(1).optional(),
    durationMs: z.number().nonnegative(),
    timeToFirstContentMs: z.number().nonnegative().optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheWriteTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
  })
  .strict();
export type ModelRequestMetricsFact = z.infer<typeof modelRequestMetricsFactSchema>;

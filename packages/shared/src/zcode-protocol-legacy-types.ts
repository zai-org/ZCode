/* oxlint-disable eslint(max-lines) -- re-home 产物：旧协议消息/会话承重类型集中迁移，保持单文件契约面。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载旧 ZCode Protocol 中仍被存活栈（validation/background-task-notifications/
// v4 投影等）消费的承重类型与 schema：ZCodeSessionInfo / ZCodeMessageWithParts /
// ZCodePermissionResponse / ZCodeInteractionRequestOrigin 及其依赖闭包。
// 旧协议死亡（zcode-protocol/index.ts 删除）后，这是该协议面的唯一幸存面。

import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
export const zcodeDeliveryKindSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export const zcodeMessageVisibilitySchema = z.enum(["user-visible", "model-only"]);
export const zcodeSyntheticUserMessageSourceSchema = z.enum([
  "agent_listing_delta",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "bot_topic_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  // child 回复会作为 model-only synthetic user message 持久化；
  // app/agent 共用的承重消息 schema 必须与 CLI contracts 使用同一来源词表。
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动工作流的启动轮 source；与 contracts 的
  // SYNTHETIC_USER_MESSAGE_SOURCES 保持同一词表，否则 v3 mapper 收窄该 source 会 tsc 失败。
  "workflow_launch",
  "shared_context",
]);
export const zcodeWorkspaceRefSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
  })
  .strict();
export const zcodePermissionDecisionSchema = z.enum(["allow", "deny", "escalate", "modify"]);
export const zcodePermissionRuleBehaviorSchema = z.enum(["allow", "deny", "ask"]);
/** Backward-compatible wire/storage key interpreted only for trusted official CUA tools. */
export const OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME = "zcode:permission-capability:official_cua";
/**
 * workflow 运行确认窗第三选项「Refine」（拒绝并附修改意见）的稳定 optionId。
 * CLI 侧 v4 投影合成选项、broker 应答映射与 GUI 特判共用同一常量；
 * 该选项只在 v4 链路投放。
 */
export const WORKFLOW_REFINE_PERMISSION_OPTION_ID = "workflowRefine";
export const zcodePermissionRuleValueSchema = z
  .object({
    toolName: nonEmptyString,
    ruleContent: z.string().optional(),
  })
  .strict();
export const zcodePermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: zcodePermissionRuleBehaviorSchema,
    rules: z.array(zcodePermissionRuleValueSchema).min(1),
  })
  .strict();
export const zcodePermissionResponseSchema = z
  .object({
    decision: zcodePermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
  })
  .strict();
export type ZCodePermissionResponse = z.infer<typeof zcodePermissionResponseSchema>;
export const zcodeSessionModeSchema = z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]);
export const zcodeSessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "paused",
  "completed",
  "error",
]);
export const zcodeSessionKindSchema = z.enum([
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
]);
// 修复原因：只识别 subagent_child 会漏掉工作流与辅助对话的父归属、隐藏索引规则。
// fork 和 workflow_parent 是独立任务，即使有 parentSessionId 也不能沿父链改写项目。
export function isAuxiliarySessionKind(kind: string | undefined): boolean {
  return isReadonlyAgentSessionKind(kind) || kind === "selection_side_chat";
}

// 辅助对话可继续输入；只有由 Agent / 工作流驱动的子会话对用户只读。
export function isReadonlyAgentSessionKind(kind: string | undefined): boolean {
  return kind === "subagent_child" || kind === "workflow_child" || kind === "nested_workflow_child";
}

export const zcodeSessionGoalSchema = z
  .object({
    sessionId: nonEmptyString,
    targetId: nonEmptyString,
    objective: nonEmptyString,
    // 旧版持久化 session target 不包含 summaryTitle。
    // 协议读取历史 snapshot 时补 null，避免老会话恢复失败。
    summaryTitle: z.string().min(1).nullable().default(null),
    status: z.enum(["active", "paused", "budget_limited", "complete"]),
    tokenBudget: z.number().int().positive().nullable(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    activeInputId: nonEmptyString.nullable().optional(),
    activeRunStartedAtMs: timestampMsSchema.nullable().optional(),
    activeRunLastSeenAtMs: timestampMsSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
  })
  .strict();
export const zcodeSessionGoalVerificationSchema = z
  .object({
    nextAction: z.string().nullable().optional(),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();
export const zcodeSessionGoalVerificationTimelineSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("synthetic"),
    type: z.literal("goal_verification"),
    display: z.literal("separator"),
    targetId: nonEmptyString,
    verificationId: nonEmptyString,
    status: z.enum(["started", "completed", "failed_closed", "cancelled"]),
    verification: zcodeSessionGoalVerificationSchema.optional(),
    goalIteration: z.number().int().positive().optional(),
    anchorAssistantMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema,
  })
  .strict();
export const zcodeSessionInfoSchema = z
  .object({
    sessionId: nonEmptyString,
    directorySessionId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    sessionKind: zcodeSessionKindSchema,
    title: z.string(),
    titleSource: z.enum(["default", "first_input", "generated", "custom"]).optional(),
    mode: zcodeSessionModeSchema,
    status: zcodeSessionStatusSchema,
    model: modelSelectionSchema.optional(),
    target: zcodeSessionGoalSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
  })
  .strict();
export type ZCodeSessionInfo = z.infer<typeof zcodeSessionInfoSchema>;
export const zcodeInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    childSessionId: nonEmptyString,
    childTurnId: nonEmptyString.optional(),
    description: z.string().optional(),
    parentSessionId: nonEmptyString,
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeInteractionRequestOrigin = z.infer<typeof zcodeInteractionRequestOriginSchema>;
const messageTimeSchema = z
  .object({
    created: timestampMsSchema,
    completed: timestampMsSchema.optional(),
  })
  .strict();
export const zcodeTokenUsageSchema = z
  .object({
    total: z.number().int().nonnegative().optional(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cache: z
      .object({
        read: z.number().int().nonnegative(),
        write: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const zcodeMessageSemanticsSchema = z
  .object({
    origin: z.enum(["real_user", "agent_runtime", "system", "migration", "import"]),
    kind: z.enum([
      "user_prompt",
      "slash_command",
      "system_reminder",
      "background_notification",
      "subagent_notification",
      "todo_reminder",
      "rewind_notice",
      "fork_notice",
      "timeline_event",
      "compact_summary",
      "shared_context",
      "assistant_response",
    ]),
    source: z.string().optional(),
    commandName: z.string().optional(),
    uiVisibility: z.enum(["visible", "hidden", "debug"]),
    providerVisibility: z.enum(["visible", "hidden"]),
    transcriptVisibility: z.enum(["visible", "hidden"]),
  })
  .strict();
export const zcodeUserMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("user"),
    time: messageTimeSchema,
    agent: nonEmptyString,
    // 旧消息或未绑定会话的合成消息可能没有请求来源；不借默认模型补写。
    model: modelSelectionSchema.optional(),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    synthetic: z.boolean().optional(),
    source: zcodeSyntheticUserMessageSourceSchema.optional(),
    visibility: zcodeMessageVisibilitySchema.optional(),
    semantics: zcodeMessageSemanticsSchema.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();
export const zcodeAssistantMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("assistant"),
    time: messageTimeSchema,
    parentMessageId: nonEmptyString,
    agent: nonEmptyString,
    model: modelSelectionSchema.optional(),
    path: z
      .object({
        cwd: nonEmptyString,
        root: nonEmptyString,
      })
      .strict(),
    cost: z.number().nonnegative(),
    tokens: zcodeTokenUsageSchema,
    finish: z.string().optional(),
    error: jsonObjectSchema.optional(),
    semantics: zcodeMessageSemanticsSchema.optional(),
    structured: z.unknown().optional(),
  })
  .strict();
export const zcodeMessageInfoSchema = z.discriminatedUnion("role", [
  zcodeUserMessageInfoSchema,
  zcodeAssistantMessageInfoSchema,
]);
export type ZCodeMessageInfo = z.infer<typeof zcodeMessageInfoSchema>;
const partBaseSchema = z.object({
  partId: nonEmptyString,
  sessionId: nonEmptyString,
  messageId: nonEmptyString,
});
export const zcodeToolStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      input: jsonObjectSchema,
      raw: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("running"),
      input: jsonObjectSchema,
      title: z.string().optional(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      input: jsonObjectSchema,
      output: z.string(),
      title: z.string(),
      metadata: jsonObjectSchema,
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      input: jsonObjectSchema,
      error: z.string(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
]);
const zcodeTimelineModelSelectionSchema = modelSelectionSchema.extend({
  label: z.string().optional(),
});
const zcodeTimelinePartTimeSchema = z
  .object({
    start: timestampMsSchema.optional(),
    end: timestampMsSchema.optional(),
  })
  .strict();
export const zcodeTimelinePartSchema = partBaseSchema
  .extend({
    type: z.literal("timeline"),
    timelineType: z.enum([
      "context_compaction",
      "goal_verification",
      "session_fork",
      "model_change",
      "worktree_creation",
    ]),
    display: z.enum(["separator", "worklog"]),
    status: z.string().optional(),
    anchorMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    time: zcodeTimelinePartTimeSchema.optional(),
    operationId: z.string().optional(),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]).optional(),
    phase: z.enum(["standalone_turn", "pre_request", "mid_turn", "reactive"]).optional(),
    compactReason: z.string().optional(),
    boundaryId: z.string().optional(),
    summaryMessageId: nonEmptyString.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    targetId: z.string().optional(),
    verificationId: z.string().optional(),
    goalIteration: z.number().int().nonnegative().optional(),
    verification: z
      .object({
        passed: z.boolean(),
        reason: z.string(),
        nextAction: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: z.string().optional(),
    restoredFileCount: z.number().int().nonnegative().optional(),
    fromModel: zcodeTimelineModelSelectionSchema.optional(),
    toModel: zcodeTimelineModelSelectionSchema
      .extend({
        label: nonEmptyString,
      })
      .optional(),
    // timelineType = worktree_creation：受管 worktree 的创建结果（docs/git/worktree.md §6.6.4）。
    worktreeCreation: z
      .object({
        path: nonEmptyString,
        sha: nonEmptyString,
        ref: z.string().nullable(),
        output: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const zcodeMessagePartSchema = z.discriminatedUnion("type", [
  partBaseSchema
    .extend({
      type: z.literal("text"),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("reasoning"),
      text: z.string(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("file"),
      mime: nonEmptyString,
      filename: z.string().optional(),
      url: nonEmptyString,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("tool"),
      callId: nonEmptyString,
      tool: nonEmptyString,
      state: zcodeToolStateSchema,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({ type: z.literal("step-start"), snapshot: z.string().optional() })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("step-finish"),
      reason: z.string(),
      snapshot: z.string().optional(),
      cost: z.number().nonnegative(),
      tokens: zcodeTokenUsageSchema,
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("snapshot"), snapshot: z.string() }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("patch"),
      hash: nonEmptyString,
      files: z.array(z.string()),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("compaction"),
      auto: z.boolean(),
      reason: z.string().optional(),
      summaryMessageId: nonEmptyString.optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  zcodeTimelinePartSchema,
  partBaseSchema
    .extend({
      type: z.literal("subagent"),
      prompt: z.string(),
      description: z.string(),
      agent: nonEmptyString,
      model: modelSelectionSchema.optional(),
      command: z.string().optional(),
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("agent"), name: nonEmptyString }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("retry"),
      attempt: z.number().int().nonnegative(),
      error: jsonObjectSchema,
    })
    .strict(),
]);
export type ZCodeMessagePart = z.infer<typeof zcodeMessagePartSchema>;
export const zcodeMessageWithPartsSchema = z
  .object({
    info: zcodeMessageInfoSchema,
    parts: z.array(zcodeMessagePartSchema),
  })
  .strict();
export type ZCodeMessageWithParts = z.infer<typeof zcodeMessageWithPartsSchema>;
export const zcodeSessionApiRetryStatusSchema = z
  .object({
    kind: z.literal("api_retry"),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryDelayMs: z.number().int().nonnegative(),
    errorStatus: z.number().int().nonnegative().nullable(),
    error: z.string(),
  })
  .strict();
export const zcodeSessionContextCacheUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    latestHitRate: z.number().nonnegative().nullable().optional(),
    hitRateRequestCount: z.number().int().nonnegative().optional(),
    totalInputTokens: z.number().int().nonnegative().optional(),
    totalCacheReadTokens: z.number().int().nonnegative().optional(),
    totalCacheWriteTokens: z.number().int().nonnegative().optional(),
    hitRate: z.number().nonnegative().nullable(),
  })
  .strict();
export const zcodeContextUsageBreakdownSourceSchema = z.enum([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);
export const zcodeContextUsageBreakdownItemSchema = z
  .object({
    source: zcodeContextUsageBreakdownSourceSchema,
    chars: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeContextUsageBreakdownItem = z.infer<typeof zcodeContextUsageBreakdownItemSchema>;
export const zcodeContextUsageBreakdownSchema = z.array(zcodeContextUsageBreakdownItemSchema);
export const zcodeSessionContextUsageSchema = z
  .object({
    used: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: nonEmptyString,
      })
      .strict()
      .nullable()
      .optional(),
    cache: zcodeSessionContextCacheUsageSchema.optional(),
    breakdown: zcodeContextUsageBreakdownSchema.optional(),
  })
  .strict();
export const zcodeSessionRuntimeStateSchema = z
  .object({
    eventSeq: z.number().int().nonnegative(),
    stateRevision: z.number().int().nonnegative(),
    deliveryKind: zcodeDeliveryKindSchema.optional(),
    activeTurnId: nonEmptyString.optional(),
    activeTurnKind: z.enum(["regular", "compact", "rewind"]).optional(),
    pendingRequestIds: z.array(nonEmptyString),
    apiRetry: zcodeSessionApiRetryStatusSchema.nullable().optional(),
    contextUsage: zcodeSessionContextUsageSchema.optional(),
    goalVerifications: z.array(zcodeSessionGoalVerificationSchema).optional(),
    goalVerificationTimeline: z.array(zcodeSessionGoalVerificationTimelineSchema).optional(),
  })
  .strict();
export type ZCodeSessionRuntimeState = z.infer<typeof zcodeSessionRuntimeStateSchema>;
export type ZCodeSessionActiveTurnKind = NonNullable<ZCodeSessionRuntimeState["activeTurnKind"]>;
export function textFromZCodeMessageParts(parts: readonly ZCodeMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

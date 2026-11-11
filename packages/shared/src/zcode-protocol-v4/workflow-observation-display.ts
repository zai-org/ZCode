// ============================================================
// 观察类工作流工具（GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
// ListSavedWorkflows / ListModels）的工具卡 display 载荷
// ============================================================
// 照 create-workflow-display.ts 的先例单独成模块（特性级 schema 不堆进 toolDisplay.ts）。
//
// ⚠ 与 apps/zcode-cli/packages/contracts/src/tools/workflow-observation-display.ts 的
// toolResultDisplayPayloadSchema 成员必须同步——两侧都是 strict，少一侧整条 row/display
// 校验失败、工具卡退化成文本（create_workflow display 注释记录过同款坑）。
// 限长常量与 CLI 构造侧一一对应；display 不经过 result budget。

import { z } from "zod";

/** `stopped` 的原因。 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

export const WORKFLOW_RUN_OBSERVATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
] as const;

const usageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

const actorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

// 情势截面（阶段 / 子代理 / 健康）的卡面载荷。与 CLI 侧
// getWorkflowRunToolResultDisplayPayloadSchema 的对应成员**逐字段同步**，枚举集闭合且同词表——
// 两侧都是 strict，少一个字段或多一个枚举值，整条 row/display 校验失败、工具卡退化成文本。
// 数字界与 CLI 侧常量一一对应（32 阶段 / 64 子代理 / 240 指令头 / 400 摘要）。
const workflowRunPhaseViewSchema = z
  .object({
    name: z.string().min(1).max(128),
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

const workflowRunLastToolSchema = z
  .object({
    name: z.string().min(1).max(64),
    target: z.string().max(120).optional(),
    at: z.number().optional(),
  })
  .strict();

const workflowRunSubagentViewSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(128).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(128).optional(),
    instructionsHead: z.string().max(240).optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: workflowRunLastToolSchema.optional(),
    waitCause: z.enum(["slot", "backoff"]).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    waitSince: z.number().optional(),
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

const workflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: z
      .object({
        effective: z.number().int().nonnegative(),
        cap: z.number().int().positive(),
        reason: z.string().max(240).optional(),
        since: z.number().optional(),
      })
      .strict()
      .optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    leftoverRunning: z.number().int().positive().optional(),
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

const diagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(2_048),
  })
  .strict();

const workflowRunSummaryRowSchema = z
  .object({
    runId: z.string().min(1),
    label: z.string(),
    labelSource: z.enum(["name", "script"]),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    ownedByThisSession: z.boolean(),
    possiblyInterrupted: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    // 修订谱系。CLI 的列表行带这两个键而这里曾漏掉：strict 校验失败，整张列表卡读成空，
    // 只要列表里有一个被修订过的 run 就写「还没有工作流实例」。卡片不画它们，但必须认得。
    resumedFrom: z.string().min(1).max(128).optional(),
    supersededBy: z.string().min(1).max(128).optional(),
  })
  .strict();

export const toolCallGetWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    // 情势截面五件全部可选：情势上线前持久化的 transcript 载荷没有这些键，而本 schema 是
    // strict 的——设成必填会让升级后打开的每一条历史会话里这张卡整块被剥、退化成纯文本。
    // 构造侧每次仍然全填（CLI 侧同款注释）。
    summary: z.string().max(400).optional(),
    generatedAt: z.number().optional(),
    usage: usageSchema,
    phases: z.array(workflowRunPhaseViewSchema).max(32).optional(),
    subagents: z.array(workflowRunSubagentViewSchema).max(64).optional(),
    health: workflowRunHealthSchema.optional(),
    actors: z.array(actorSchema).max(32),
    logTail: z
      .array(
        z
          .object({
            sequence: z.number(),
            message: z.string().max(1_024),
            // 事件落 journal 的时刻（epoch ms）；卡上的「多久以前」对 generatedAt 算。
            // 可选：这一列在情势截面之前的载荷上不存在，读旧行时缺席而不是拒收。
            at: z.number().optional(),
          })
          .strict(),
      )
      .max(40),
    result: z.string().max(4_000).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallGetWorkflowRunDisplay = z.infer<typeof toolCallGetWorkflowRunDisplaySchema>;

export const toolCallListWorkflowRunsDisplaySchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(workflowRunSummaryRowSchema).max(50),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListWorkflowRunsDisplay = z.infer<typeof toolCallListWorkflowRunsDisplaySchema>;

export const toolCallEvalWorkflowSnippetDisplaySchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(100),
    logs: z.array(z.string().max(1_024)).max(40),
    response: z.string().max(4_000),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallEvalWorkflowSnippetDisplay = z.infer<
  typeof toolCallEvalWorkflowSnippetDisplaySchema
>;

export const toolCallSavedWorkflowListDisplaySchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(2_048).optional(),
            whenToUse: z.string().max(2_048).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(32),
          })
          .strict(),
      )
      .max(50),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(1_024).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallSavedWorkflowListDisplay = z.infer<
  typeof toolCallSavedWorkflowListDisplaySchema
>;

// ListModels 的目录卡载荷。与
// contracts 侧 listModelsToolResultDisplayPayloadSchema 成员同步——两侧都 strict，缺成员整块
// 被剥、工具卡退化成 `<models>` 文本。限长数字与 CLI 侧常量一一对应（100 行 / 2048 字符）。
export const toolCallListModelsDisplaySchema = z
  .object({
    kind: z.literal("list_models"),
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(2_048).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(2_048).optional(),
          })
          .strict(),
      )
      .max(100),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListModelsDisplay = z.infer<typeof toolCallListModelsDisplaySchema>;

// ResumeWorkflowRun 的结果卡载荷。与 contracts 侧
// resumeWorkflowRunToolResultDisplayPayloadSchema 成员同步——两侧都 strict，缺成员整块被剥、
// 工具卡退化成文本。载荷刻意最小 {runId}（理由见 contracts 侧注释）。
export const toolCallResumeWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ToolCallResumeWorkflowRunDisplay = z.infer<
  typeof toolCallResumeWorkflowRunDisplaySchema
>;

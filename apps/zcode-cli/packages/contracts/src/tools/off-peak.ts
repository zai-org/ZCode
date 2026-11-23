// ============================================================
// Off-Peak tools - session-level idle-time task creation
// ============================================================
// 闲时任务与 cron automation 是兄弟实体：schema 独立镜像，禁止互相复用。
// workspace/凭证不是模型入参；permissionMode/model/thoughtLevel 缺省在 host 端解析
// （yolo / allowed_models 末位 / 最高推理档），模型只在用户显式要求时覆盖。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const OffPeakCreateInputSchema = z
  .object({
    title: nonEmptyString.describe(
      "Concise idle-time task title describing the deferred work, for example '重构 utils 目录' or 'Fix flaky auth tests'. Keep it short and do not include file paths.",
    ),
    prompt: nonEmptyString.describe(
      "Instructions for the deferred run, which later continues THIS conversation unattended with the full history available, so it may refer to context already established here. State the expected deliverable explicitly (nobody will answer questions during the run); never ask the run to create, schedule, or configure another idle-time task or automation.",
    ),
    permissionMode: z
      .enum(["build", "edit", "plan", "yolo", "guarded"])
      .optional()
      .describe(
        "Unattended run permission mode. Omit for the default full-automatic mode (yolo). Set only when the user explicitly asks for confirmation-gated execution: 'build' pauses for approval before changes, 'edit' auto-applies edits, 'plan' is read-only planning, 'guarded' runs like yolo but pauses once for explicitly recognized dangerous shell commands (rm -rf, git reset --hard, force push, rsync --delete, etc.).",
      ),
    model: nonEmptyString
      .optional()
      .describe(
        "Idle-plan model id. Must be one of the idle-time allowed models; omit to use the default (the newest allowed model). Set only when the user names a specific model.",
      ),
    thoughtLevel: nonEmptyString
      .optional()
      .describe(
        "Reasoning effort level for the chosen model. Omit to use the default (the highest level). Set only when the user explicitly asks for a lower reasoning effort.",
      ),
  })
  .strict();
export type OffPeakCreateInput = z.infer<typeof OffPeakCreateInputSchema>;
export const OffPeakCreateInputJsonSchema = toToolJsonSchema(OffPeakCreateInputSchema);

/** 客户端执行态（与 shared ZCodeOffPeakTaskStatus 同值镜像；镜像来自 contracts 使用 zod 3 的时期）。 */
export const OffPeakTaskStatusSchema = z.enum([
  "queued",
  "paused",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type OffPeakTaskStatus = z.infer<typeof OffPeakTaskStatusSchema>;

/** 轮尾卡片与 OffPeakList 的最小任务快照：不暴露 serverTicketId / providerName。 */
export const OffPeakTaskSummarySchema = z
  .object({
    offPeakTaskId: nonEmptyString,
    title: z.string(),
    status: OffPeakTaskStatusSchema,
    queuePosition: z.number().int().positive().optional(),
    sessionId: nonEmptyString.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type OffPeakTaskSummary = z.infer<typeof OffPeakTaskSummarySchema>;

export const OffPeakCreateOutputSchema = z
  .object({
    task: OffPeakTaskSummarySchema,
    message: nonEmptyString,
  })
  .strict();
export type OffPeakCreateOutput = z.infer<typeof OffPeakCreateOutputSchema>;
export const OffPeakCreateOutputJsonSchema = toToolJsonSchema(OffPeakCreateOutputSchema);

export const OffPeakListInputSchema = z.object({}).strict();
export type OffPeakListInput = z.infer<typeof OffPeakListInputSchema>;
export const OffPeakListInputJsonSchema = toToolJsonSchema(OffPeakListInputSchema);

export const OffPeakListOutputSchema = z
  .object({
    tasks: z.array(OffPeakTaskSummarySchema),
  })
  .strict();
export type OffPeakListOutput = z.infer<typeof OffPeakListOutputSchema>;
export const OffPeakListOutputJsonSchema = toToolJsonSchema(OffPeakListOutputSchema);

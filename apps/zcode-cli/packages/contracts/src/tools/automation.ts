// ============================================================
// Cron automation tools - session-level scheduled task management
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);
// 字段契约与 shared ModelSelection 保持逐叶一致。本地声明来自 contracts 使用 zod 3 的时期；两边现在是同一个
// zod 4，改为直接复用 shared schema 会改动 tools 段字节，留作后续。
const cronModelSelectionSchema = z
  .object({
    providerId: nonEmptyString,
    modelId: nonEmptyString,
    options: z
      .object({
        reasoningLevel: nonEmptyString.optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 相对任务判定的唯一口径：只有显式的正整数才是相对延迟。
 * delayMinutes 曾是必填 nullable，普通 cron 创建被迫显式传 null——
 * 省略字段的旧调用方/不稳定保留 null 的 provider 会直接 parse 失败，或在
 * `!== null` 判定下把 undefined 误走相对分支、把 recurring 任务错建成一次性。
 * undefined 与 null 都表示“非相对”，向后兼容既有 { cron, prompt, title } 协议。 */
export function hasRelativeDelayMinutes(input: { delayMinutes?: number | null }): boolean {
  return typeof input.delayMinutes === "number";
}

export const CronCreateInputSchema = z
  .object({
    cron: nonEmptyString
      .optional()
      .describe(
        "Standard 5-field cron expression in the user's local timezone: minute hour day-of-month month day-of-week. Use it only for an absolute named date/time or a recurring schedule; required unless delayMinutes is set. For any relative delay such as 'in 8 minutes'/'8分钟后' or 'in 2 hours'/'2小时后', omit cron and use delayMinutes instead — never convert a relative phrase into a fixed clock time or calendar date, because a just-passed one-shot time silently rolls a full year forward. Examples: '*/20 * * * *' means every 20 minutes, '0 * * * *' means hourly, and '0 9 * * 1-5' means weekdays at 09:00. Do not convert to UTC.",
      ),
    delayMinutes: z
      .number()
      .int()
      .positive()
      .max(525_600)
      .nullable()
      .optional()
      .describe(
        "For any relative delay from now — 'in 3 minutes' (3), '8分钟后' (8), 'in 2 hours' (120), 'later'/'稍后' — set the exact positive delay in whole minutes and omit cron. The host calculates the future local schedule from its real current clock, so never compute an absolute time or cron yourself. For an absolute named date/time or a recurring schedule, omit it (or set null) and provide cron.",
      ),
    prompt: nonEmptyString.describe(
      "Complete prompt to send at every scheduled fire. Include all instructions needed when the automation runs. Describe the final work directly; do not ask it to create or schedule another automation or call CronCreate.",
    ),
    title: nonEmptyString.describe(
      "Concise automation title that preserves the user's natural-language schedule phrase verbatim. For example, for '每20分钟提醒我喝水', use '每20分钟喝水提醒', not '喝水提醒'.",
    ),
    recurring: z
      .boolean()
      .optional()
      .describe(
        "true (default) repeats until paused or deleted. false creates a finite automation; without maxRuns it runs once.",
      ),
    maxRuns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum successful scheduled dispatch count. Use only with recurring=false; omit for a one-shot automation (defaults to 1).",
      ),
    // 会话侧「自定义重复」carrier。每 N 分钟/小时/天/周/月/年与 UI 一样由
    // intervalUnit + interval 表示，真实间隔由 host scheduleRule 承载；cron 仅是合法兼容展示。
    // 不能让 cron 字段步长上限（minute 59、hour 24、day-of-month 31、month 12）篡改真实频率。
    // carrier 与 delayMinutes（一次性）互斥。
    intervalUnit: z
      .enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe(
        "Custom recurring interval unit for every N minutes/hours/days/weeks/months/years. Pair with interval (1-200) for every N-unit request, even if cron can express N; submit a legal compatible cron whose time/day slots are used by the scheduleRule. Omit both for ordinary calendar cron schedules.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Integer interval from 1 to 200 paired with intervalUnit. The host carries the real interval via scheduleRule; the compatible cron is only a legal display expression. Must be set together with intervalUnit.",
      ),
  })
  .strict()
  .refine((input) => hasRelativeDelayMinutes(input) || input.cron !== undefined, {
    message: "cron is required when delayMinutes is not set",
    path: ["cron"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.cron === undefined, {
    message: "a relative delay must omit cron; the host computes the schedule from its real clock",
    path: ["cron"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.recurring !== true, {
    message: "a relative delay creates a one-shot automation and cannot use recurring=true",
    path: ["recurring"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.maxRuns === undefined, {
    message: "a relative delay runs once and cannot use maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit+interval 是周期 carrier，与一次性相对延迟 delayMinutes 在语义上冲突
  // （周期 vs 一次性）；同传会形成矛盾状态，必须在 contract 层拒绝（service 层另有领域防御）。
  .refine((input) => input.intervalUnit === undefined || !hasRelativeDelayMinutes(input), {
    message: "intervalUnit is a recurring carrier and cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  // intervalUnit 与 interval 必须配对：只传其一无法确定真实间隔，拒绝。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // carrier 的定义就是长周期无限循环；一次性 / 有限次数与其调度语义冲突。
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and requires recurring=true",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type CronCreateInput = z.infer<typeof CronCreateInputSchema>;
export const CronCreateInputJsonSchema = toToolJsonSchema(CronCreateInputSchema);

const CronUpdateInputObjectSchema = z
  .object({
    id: nonEmptyString.describe("Automation id returned by CronCreate or CronList"),
    cron: nonEmptyString
      .optional()
      .describe(
        "Replacement standard 5-field cron expression in the user's local timezone. Omit to preserve the existing schedule. Do not convert to UTC.",
      ),
    prompt: nonEmptyString
      .optional()
      .describe(
        "Replacement prompt for future scheduled fires. Omit to preserve the existing prompt.",
      ),
    // title 可选时，模型只改 cron/prompt 会把旧时间或旧任务语义留在标题中。
    // 会话更新必须显式提交最终标题，让同一次原地更新同步持久化并回显一致结果。
    title: nonEmptyString.describe(
      "Required synchronized automation title describing the task after this update. Keep the user's natural-language schedule phrase consistent with cron (for example, changing every 5 minutes to every 6 minutes must also change the title), and update the title when the prompt meaning changes.",
    ),
    recurring: z
      .boolean()
      .optional()
      .describe(
        "Replacement recurrence mode. true repeats indefinitely and clears any old finite maxRuns limit; false is finite. Do not combine true with a numeric maxRuns.",
      ),
    maxRuns: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "Replacement maximum successful scheduled dispatch count for recurring=false. null clears the existing limit and is valid only when recurring=true is included in the same update; when recurring=true is supplied without maxRuns, the service clears the old limit automatically.",
      ),
    // 自定义重复 carrier，语义同 create 侧 intervalUnit+interval（每 N 单位统一经 scheduleRule 执行）。
    intervalUnit: z
      .enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe(
        "Switch this automation to a long recurring interval whose step exceeds a cron field ceiling (hourly N>24, daily N>31, etc.). Pair with interval and submit a legal compatible cron (omit cron to keep the existing schedule's minute).",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Positive integer interval paired with intervalUnit. Must be set together with intervalUnit.",
      ),
  })
  .strict();

const CRON_UPDATE_FIELDS = [
  "cron",
  "prompt",
  "title",
  "recurring",
  "maxRuns",
  "intervalUnit",
  "interval",
] as const;
export const CronUpdateInputSchema = CronUpdateInputObjectSchema.refine(
  (input) => CRON_UPDATE_FIELDS.some((field) => input[field] !== undefined),
  { message: "CronUpdate requires at least one field to update" },
)
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "Clearing maxRuns requires recurring=true in the same update",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit 与 interval 必须配对（同 create 侧语义）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // carrier 会将历史一次性任务切换为无限循环，调用方不能同传矛盾的有限次数语义。
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type CronUpdateInput = z.infer<typeof CronUpdateInputSchema>;
// provider-visible schema 曾用顶层 anyOf 表达 recurring/maxRuns 组合约束，
// 与 core 的跨 provider 守卫（禁止 $ref/$defs/anyOf 等 provider-internal key）直接冲突；
// anyOf 还引出“部分 provider 只读分支 required、漏掉顶层 id/title”的连带问题。
// provider 只投影干净的 object schema（顶层 required 自然生效），组合不变量由
// runtime CronUpdateInputSchema 的 refine 强制，模型侧靠 recurring/maxRuns 的
// description 提示，非法组合在工具执行时被拒绝并回带明确错误。
export const CronUpdateInputJsonSchema = toToolJsonSchema(CronUpdateInputObjectSchema);

export const CronListInputSchema = z.object({}).strict();
export type CronListInput = z.infer<typeof CronListInputSchema>;
export const CronListInputJsonSchema = toToolJsonSchema(CronListInputSchema);

// CronPauseSelf 没有任何模型可控输入：暂停目标只能是执行器注入的本轮 automationId。
export const CronPauseSelfInputSchema = z.object({}).strict();
export type CronPauseSelfInput = z.infer<typeof CronPauseSelfInputSchema>;
export const CronPauseSelfInputJsonSchema = toToolJsonSchema(CronPauseSelfInputSchema);

export const CronDeleteInputSchema = z
  .object({
    id: nonEmptyString.describe("Automation id returned by CronCreate or CronList"),
  })
  .strict();
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;
export const CronDeleteInputJsonSchema = toToolJsonSchema(CronDeleteInputSchema);

/**
 * 自定义重复规则的 contract 层镜像 schema。
 * 与 @zcode/shared 的 ZCodeAutomationScheduleRule 结构同步（镜像来自 contracts 使用 zod 3 的时期；两边现在是
 * 同一个 zod 4，改为直接复用会改动 tools 段字节，留作后续）。
 * cronExpr 保留为兼容展示，调度以本字段为权威；会话侧长间隔 carrier 归一化后由本字段承载。
 */
export const CronAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type CronAutomationScheduleRule = z.infer<typeof CronAutomationScheduleRuleSchema>;

export const CronAutomationSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: z.number().int().nonnegative().optional(),
    lastRunAt: z.number().int().nonnegative().optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    modelSelection: cronModelSelectionSchema.optional(),
    mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]).optional(),
    // 自定义重复规则；缺省时调度回退到解析 cronExpr。会话卡片必须读到本字段才能展示
    // cron 无法表达的真实间隔（如每50小时、每40天，兼容 cronExpr 只是 0 * * * *）。
    scheduleRule: CronAutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type CronAutomation = z.infer<typeof CronAutomationSchema>;

export const CronCreateOutputSchema = z
  .object({
    automation: CronAutomationSchema,
    message: nonEmptyString,
  })
  .strict();
export type CronCreateOutput = z.infer<typeof CronCreateOutputSchema>;
export const CronCreateOutputJsonSchema = toToolJsonSchema(CronCreateOutputSchema);

export const CronUpdateOutputSchema = z
  .object({
    automation: CronAutomationSchema,
    message: nonEmptyString,
  })
  .strict();
export type CronUpdateOutput = z.infer<typeof CronUpdateOutputSchema>;
export const CronUpdateOutputJsonSchema = toToolJsonSchema(CronUpdateOutputSchema);

export const CronListOutputSchema = z
  .object({
    automations: z.array(CronAutomationSchema),
  })
  .strict();
export type CronListOutput = z.infer<typeof CronListOutputSchema>;
export const CronListOutputJsonSchema = toToolJsonSchema(CronListOutputSchema);

export const CronDeleteOutputSchema = z
  .object({
    deleted: z.boolean(),
    id: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type CronDeleteOutput = z.infer<typeof CronDeleteOutputSchema>;
export const CronDeleteOutputJsonSchema = toToolJsonSchema(CronDeleteOutputSchema);

export const CronPauseSelfOutputSchema = z
  .object({
    paused: z.boolean(),
    id: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
export type CronPauseSelfOutput = z.infer<typeof CronPauseSelfOutputSchema>;
export const CronPauseSelfOutputJsonSchema = toToolJsonSchema(CronPauseSelfOutputSchema);

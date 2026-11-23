// ============================================================
// ListWorkflowRuns Tool - 按项目（cwd）枚举 workflow run，含跨会话历史
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_WORKFLOW_RUNS_TOOL_NAME = "ListWorkflowRuns";

/**
 * run 的生命周期词汇表。字面与 `DynamicWorkflowRunLifecycleStatus`（端口侧）同集，但在这里
 * 重新声明成 zod 枚举：schema 是**运行时**校验面，type-only 的联合类型在这里派不上用场。
 * 两处一旦分叉，症状是模型传下来的合法状态被工具拒掉——所以端口那一侧的注释也指回这里。
 */
export const WORKFLOW_RUN_LIFECYCLE_STATUSES = [
  "completed",
  "errored",
  "pending",
  "running",
  "stopped",
] as const;

/** `stopped` 的原因（端口 `DynamicWorkflowRunStopReason` 的 zod 面）。 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

/** limit 的界与默认值。50 是「run 是低基数实体」下不需要游标分页的那个上限。 */
export const LIST_WORKFLOW_RUNS_MIN_LIMIT = 1;
export const LIST_WORKFLOW_RUNS_MAX_LIMIT = 50;
export const LIST_WORKFLOW_RUNS_DEFAULT_LIMIT = 20;

export const ListWorkflowRunsInputSchema = z
  .object({
    limit: clampedLimit().describe(
      `Maximum number of runs to return (${LIST_WORKFLOW_RUNS_MIN_LIMIT}-${LIST_WORKFLOW_RUNS_MAX_LIMIT}, default ${LIST_WORKFLOW_RUNS_DEFAULT_LIMIT}). Most recently updated runs come first.`,
    ),
    statuses: z
      .array(z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES))
      .optional()
      .describe(
        "Optional status filter. Omit to see every run in this project. Pass [\"running\", \"pending\"] to see only what is still in flight.",
      ),
  })
  // 刻意没有 cwd 输入：工具恒查当前会话的工作目录（模型无权跨项目扫库，这同时是
  // `sideEffectScope: "none"` 成立的前提）。.strict() 让"多传一个 cwd"成为可见错误。
  .strict();

export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsInputSchema>;

export const ListWorkflowRunsInputJsonSchema = toToolJsonSchema(ListWorkflowRunsInputSchema);

/**
 * 列表与详情**共同的截面**（端口侧 `DynamicWorkflowRunSummary` 的 schema 面）。
 *
 * 之所以是一个共享的字段袋而不是两份各自演化的字段表：同一个 run 在列表里和详情里显示不同的
 * 名字或归属，是最难被测试抓住、又最直接损害信任的那类不一致。字段袋放在**列表**这一侧，
 * 因为列表就是这个截面最浅的投影；详情按它 extend。
 */
export const WorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** 已烹熟的展示标签（name → 脚本首行 → runId 由服务侧派生）。 */
  label: z.string(),
  /** `"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。 */
  labelSource: z.enum(["name", "script"]),
  status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
  /** `status === "stopped"` 才在场。 */
  stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
  /** 本 run 修订自哪个 run（`dwf_run.resumed_from`）；不是修订则缺席。 */
  resumedFrom: z.string().min(1).optional(),
  /** 本 run 被哪次修订停下并替代（`stopped(superseded)` 的结算袋）；未被替代则缺席。 */
  supersededBy: z.string().min(1).optional(),
  ownedByThisSession: z.boolean(),
  /** 「本会话无法证实它还活着」的标注，为真时才在场。绝不是状态改写。 */
  possiblyInterrupted: z.boolean().optional(),
  /** epoch ms（journal 的 time_created / time_updated）。 */
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ListWorkflowRunsRunSchema = WorkflowRunSummarySchema.extend({
  spentTokens: z.number(),
}).strict();

export type ListWorkflowRunsRun = z.infer<typeof ListWorkflowRunsRunSchema>;

export const ListWorkflowRunsOutputSchema = z
  .object({
    runs: z.array(ListWorkflowRunsRunSchema),
    /** 还有更多 run 没进这一页（按 limit+1 探到）。为真时才在场。 */
    truncated: z.boolean().optional(),
  })
  .strict();

export type ListWorkflowRunsOutput = z.infer<typeof ListWorkflowRunsOutputSchema>;

export const ListWorkflowRunsOutputJsonSchema = toToolJsonSchema(ListWorkflowRunsOutputSchema);

/**
 * limit 是**钳制**而不是拒绝：一次只读枚举没有理由因为一个越界数字变成模型要从中恢复的工具
 * 错误；`limit` 默认 20，并钳到 [1, 50]。
 *
 * 钳制放在 preprocess 里而不是 handler 里，图的是两件事同时成立：JSON schema 仍然按内层
 * schema 投影（`type: integer` + minimum/maximum/default，模型看得到界），而运行时的越界值被
 * 折进界内。写在 handler 里的 `Math.min/max` 会被本 schema 的 min/max 抢先拒掉，是永不执行的
 * 死代码。语义强制转换走 preprocess 是既有惯例（task-output 的 semanticBoolean、bash 的
 * timeout）。
 */
function clampedLimit() {
  // default 与 optional 包在 preprocess 外层：字段可以省略（不进 required），省略时取默认值。
  return z
    .preprocess((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return value;
      return Math.min(
        LIST_WORKFLOW_RUNS_MAX_LIMIT,
        Math.max(LIST_WORKFLOW_RUNS_MIN_LIMIT, Math.trunc(value)),
      );
    }, z.number().int().min(LIST_WORKFLOW_RUNS_MIN_LIMIT).max(LIST_WORKFLOW_RUNS_MAX_LIMIT))
    .default(LIST_WORKFLOW_RUNS_DEFAULT_LIMIT)
    .optional();
}

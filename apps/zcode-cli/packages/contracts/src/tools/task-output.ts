import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";
export const TASK_OUTPUT_ALIASES = [
  "AgentOutputTool",
  "BashOutputTool",
  "AgentOutput",
  "BashOutput",
] as const;

export const TASK_OUTPUT_PROVIDER_DESCRIPTION = `DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`;

export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().describe("The task ID to get output from"),
    block: semanticBoolean(z.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(600_000).default(30_000).describe("Max wait time in ms"),
  })
  .strict();

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export const TaskOutputInputJsonSchema = {
  ...toToolJsonSchema(TaskOutputInputSchema),

  // 的 provider schema 仍要求模型显式传入 task_id、block 和 timeout。
  required: ["task_id", "block", "timeout"],
};

export const TaskOutputTaskSchema = z
  .object({
    task_id: z.string(),
    task_type: z.string(),
    status: z.string(),
    description: z.string(),
    output: z.string(),
    exitCode: z.number().nullable().optional(),
    error: z.string().optional(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    outputFile: z.string().optional(),
    /** 运行中的后台 Agent 的当前进展（与无进展提醒同一份事实）。 */
    activity: z
      .object({
        last_progress_at: z.string(),
        no_progress_for_ms: z.number(),
        running_tools: z.array(
          z
            .object({
              tool_name: z.string(),
              running_for_ms: z.number(),
              summary: z.string().optional(),
            })
            .strict(),
        ),
        waiting_for_permission: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TaskOutputTask = z.infer<typeof TaskOutputTaskSchema>;

export const TaskOutputResultSchema = z
  .object({
    retrieval_status: z.enum(["success", "not_ready", "timeout"]),
    task: TaskOutputTaskSchema.nullable(),
  })
  .strict();

export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;

export const TaskOutputResultJsonSchema = toToolJsonSchema(TaskOutputResultSchema);

function semanticBoolean(
  schema: z.ZodDefault<z.ZodBoolean>,
): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown> {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, schema);
}

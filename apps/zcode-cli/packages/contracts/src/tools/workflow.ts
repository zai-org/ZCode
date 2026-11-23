// ============================================================
// Workflow Tool - deterministic multi-agent workflow launcher
// ============================================================

import { z } from "zod";
import type { TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const WORKFLOW_SCRIPT_MAX_LENGTH = 524_288;
export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

export const WorkflowInputSchema = z
  .object({
    args: z
      .unknown()
      .optional()
      .describe(
        "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "Ignored — set the workflow description in the script's `meta` block.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name of a predefined workflow (built-in or from .zcode/workflows/). Resolves to a self-contained script.",
      ),
    resumeFromRunId: z
      .string()
      .regex(WORKFLOW_RUN_ID_PATTERN)
      .optional()
      .describe(
        "Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming.",
      ),
    script: z
      .string()
      .max(WORKFLOW_SCRIPT_MAX_LENGTH)
      .optional()
      .describe(
        "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
      ),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
      ),
    title: z
      .string()
      .optional()
      .describe("Ignored — set the workflow title in the script's `meta` block."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scriptPath || input.script || input.name || input.resumeFromRunId) return;
    // 显式写 path：省略时 zod 把 path 补在 message 之后，模型看到的 key 顺序就不是 code、path、message。
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "Workflow requires scriptPath, script, name, or resumeFromRunId.",
    });
  });

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

export const WorkflowInputJsonSchema = toToolJsonSchema(WorkflowInputSchema);

export const WorkflowOutputStatusSchema = z.enum(["backgrounded", "completed", "failed"]);
export type WorkflowOutputStatus = z.infer<typeof WorkflowOutputStatusSchema>;

export const WorkflowOutputSchema = z
  .object({
    backgroundTaskId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    name: z.string().min(1).optional(),
    response: z.string(),
    runId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    scriptPath: z.string().min(1).optional(),
    status: WorkflowOutputStatusSchema,
    traceId: z.string().min(1),
  })
  .strict();

export type WorkflowOutput = z.infer<typeof WorkflowOutputSchema>;

export const WorkflowOutputJsonSchema = toToolJsonSchema(WorkflowOutputSchema);

export interface WorkflowToolResult {
  output: WorkflowOutput;
  traceId: TraceId;
}

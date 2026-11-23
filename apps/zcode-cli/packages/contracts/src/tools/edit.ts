// ============================================================
// Edit Tool - File Editing Tool
// ============================================================
// Reference: file edit input / output shape

import { z } from "zod";
import { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const EditInputSchema = z.object({
  /**
   * The absolute path to the file to modify.
   */
  file_path: z
    .string()
    .describe("The absolute path to the file to modify"),
  /**
   * The text to replace
   */
  old_string: z.string().describe("The text to replace"),
  /**
   * The text to replace it with (must be different from old_string)
   */
  new_string: z
    .string()
    .describe("The text to replace it with (must be different from old_string)"),
  /**
   * Replace all occurrences of old_string (default false)
   */
  replace_all: semanticBoolean()
    .default(false)
    .optional()
    .describe("Replace all occurrences of old_string (default false)"),
});

export type EditInput = z.infer<typeof EditInputSchema>;

export const EditInputJsonSchema = toToolJsonSchema(EditInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface EditOutput {
  /**
   * The file path that was edited
   */
  filePath: string;
  /**
   * The original string that was replaced
   */
  oldString: string;
  /**
   * The new string that replaced it
   */
  newString: string;
  /**
   * The original file contents before editing
   */
  originalFile: string;
  /**
   * Diff patch showing the changes
   */
  structuredPatch: DiffHunk[];
  /**
   * Whether the user modified the proposed changes
   */
  userModified: boolean;
  /**
   * Whether all occurrences were replaced
   */
  replaceAll: boolean;
  /**
   * Matching strategy used to find oldString. Exact is expected for normal edits.
   */
  matchStrategy?: string;
  /**
   * Number of candidate positions observed by the selected match strategy.
   */
  matchCandidateCount?: number;
  /**
   * Git diff information (for remote scenarios)
   */
  gitDiff?: GitDiff;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface GitDiff {
  filename: string;
  status: "modified" | "added";
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  /**
   * GitHub owner/repo when available
   */
  repository?: string | null;
}

export const EditDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const EditGitDiffSchema = z
  .object({
    filename: z.string(),
    status: z.enum(["modified", "added"]),
    additions: z.number().int(),
    deletions: z.number().int(),
    changes: z.number().int(),
    patch: z.string(),
    repository: z.string().nullable().optional(),
  })
  .strict();

export const EditOutputSchema = z
  .object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    originalFile: z.string(),
    structuredPatch: z.array(EditDiffHunkSchema),
    userModified: z.boolean(),
    replaceAll: z.boolean(),
    matchStrategy: z.string().optional(),
    matchCandidateCount: z.number().int().nonnegative().optional(),
    gitDiff: EditGitDiffSchema.optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

export const EditOutputJsonSchema = toToolJsonSchema(EditOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface EditToolCall {
  id: ToolCallId;
  name: "Edit";
  input: EditInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface EditToolResult {
  toolCallId: ToolCallId;
  output: EditOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Edit Errors
// -----------------------------------------------

export const EditErrorCode = {
  NO_CHANGE: 1,
  FILE_EXISTS_NO_OLD_STRING: 3,
  FILE_NOT_EXIST: 4,
  NOTEBOOK_FILE: 5,
  FILE_NOT_READ: 6,
  STALE_FILE: 7,
  OLD_STRING_NOT_FOUND: 8,
  AMBIGUOUS_REPLACE: 9,
  FILE_TOO_LARGE: 10,
  INVALID_PATH: 13,
  UNSUPPORTED_ENCODING: 15,
} as const;

export type EditErrorCode = (typeof EditErrorCode)[keyof typeof EditErrorCode];

function semanticBoolean(): z.ZodPreprocess<z.ZodBoolean> {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    if (typeof value !== "string") return value;

    const normalized = value.trim().toLowerCase();
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    return value;
  }, z.boolean());
}

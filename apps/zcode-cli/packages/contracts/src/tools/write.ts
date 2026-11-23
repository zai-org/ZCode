// ============================================================
// Write Tool - File Writing Tool
// ============================================================
// Reference: file write input / output shape

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const WriteInputSchema = z.object({
  /**
   * The absolute path to the file to write.
   */
  file_path: z
    .string()
    .describe("The absolute path to the file to write (must be absolute, not relative)"),
  /**
   * The content to write to the file
   */
  content: z.string().describe("The content to write to the file"),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export const WriteInputJsonSchema = toToolJsonSchema(WriteInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface WriteOutput {
  /**
   * Whether a new file was created or an existing file was updated
   */
  type: "create" | "update";
  /**
   * The path to the file that was written
   */
  filePath: string;
  /**
   * The content that was written to the file
   */
  content: string;
  /**
   * Diff patch showing the changes
   */
  structuredPatch: DiffHunk[];
  /**
   * The original file content before the write (null for new files)
   */
  originalFile: string | null;
  /**
   * Git diff information (for remote scenarios)
   */
  gitDiff?: GitDiff;
  /**
   * True when the user edited the proposed content in the permission dialog before accepting
   */
  userModified?: boolean;
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

export const WriteDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const WriteGitDiffSchema = z
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

export const WriteOutputSchema = z
  .object({
    type: z.enum(["create", "update"]),
    filePath: z.string(),
    content: z.string(),
    structuredPatch: z.array(WriteDiffHunkSchema),
    originalFile: z.string().nullable(),
    gitDiff: WriteGitDiffSchema.optional(),
    userModified: z.boolean().optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

export const WriteOutputJsonSchema = toToolJsonSchema(WriteOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface WriteToolCall {
  id: ToolCallId;
  name: "Write";
  input: WriteInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface WriteToolResult {
  toolCallId: ToolCallId;
  output: WriteOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Write Errors
// -----------------------------------------------

// Write handler 返回失败时的数字码（executor 包成 `<tool_use_error>`，02-write.md「模型看到的文字」）。
// 原来这里是一组没有调用方的字符串码，失败都是抛出的异常；改成与 Edit 一样的数字码。
export const WriteErrorCode = {
  FILE_NOT_READ: 2,
  STALE_FILE: 3,
  IS_DIRECTORY: 17,
  NOT_REGULAR_FILE: 18,
} as const;

export type WriteErrorCode = (typeof WriteErrorCode)[keyof typeof WriteErrorCode];

// ============================================================
// Read Tool - File Reading Tool
// ============================================================
// Reference: file read input / output shape

import { z } from "zod";
import { VIDEO_INPUT_MAX_BYTES } from "@zcode/shared";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import {
  getReadPdfPagesValidationFailure,
  READ_PDF_PAGES_DESCRIPTION,
  ReadErrorCode,
} from "./read-pdf.js";

export * from "./read-pdf.js";
export * from "./read-state.js";

export const READ_MAX_FILE_SIZE_BYTES = 256 * 1024;
export const READ_MAX_OUTPUT_TOKENS = 25_000;
export const READ_DEFAULT_MAX_LINES = 2_000;
export const READ_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;
export const READ_IMAGE_TARGET_BYTES = Math.floor((READ_IMAGE_MAX_BASE64_BYTES * 3) / 4);
export const READ_IMAGE_MAX_DIMENSION = 2000;
export const READ_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO = 0.125;
export const READ_VIDEO_MAX_INPUT_BYTES = VIDEO_INPUT_MAX_BYTES;

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".bz2",
  ".class",
  ".dll",
  ".dmg",
  ".dylib",
  ".exe",
  ".gz",
  ".jar",
  ".o",
  ".pyc",
  ".rar",
  ".so",
  ".tar",
  ".tgz",
  ".wasm",
  ".zip",
]);
const BLOCKING_DEVICE_PATHS = new Set([
  "/dev/console",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
  "/dev/full",
  "/dev/random",
  "/dev/stderr",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/tty",
  "/dev/urandom",
  "/dev/zero",
]);

const ReadProviderInputBaseSchema = z.object({
  /**
   * The absolute path to the file to read.
   */
  file_path: z.string().describe("The absolute path to the file to read"),
  /**
   * The line number to start reading from. Only provide if the file is too large to read at once
   */
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "The line number to start reading from. Only provide if the file is too large to read at once",
    ),
  /**
   * The number of lines to read. Only provide if the file is too large to read at once.
   */
  limit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "The number of lines to read. Only provide if the file is too large to read at once.",
    ),
});

const ReadProviderPdfInputSchema = ReadProviderInputBaseSchema.extend({
  pages: z.string().optional().describe(READ_PDF_PAGES_DESCRIPTION),
});

export const ReadInputSchema = z.preprocess(coerceReadInput, ReadProviderPdfInputSchema);

export const ReadInputJsonSchema = toToolJsonSchema(ReadProviderInputBaseSchema);
export const ReadPdfInputJsonSchema = toToolJsonSchema(ReadProviderPdfInputSchema);

/**
 * 字段校验前修正模型常写错的范围参数，规则见 docs/design/v2/tool/01-read.md「输入修正」。
 * 修复原因：`limit: -1` / `0` 能通过 JSON Schema（它不检查 exclusiveMinimum），随后被 handler 内的
 * runtime schema 拒绝，模型收到原始 ZodError JSON；`offset: -5`、`limit: [50]`、`limit: "50"` 收到参数错误；
 * `length` 被静默丢弃。这些输入意图清楚，修正后直接读取，不让模型多花一轮重试。
 */
function coerceReadInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const next: Record<string, unknown> = { ...input };
  for (const key of ["offset", "limit"]) {
    const value = next[key];
    if (Array.isArray(value) && value.length === 1) next[key] = value[0];
  }
  for (const key of ["offset", "limit", "length"]) {
    const value = next[key];
    if (typeof value === "string" && /^[-+]?\d+(\.\d+)?$/.test(value.trim())) next[key] = Number(value);
  }
  if (isFiniteNumber(next.offset) && next.offset < 0) delete next.offset;
  if (isFiniteNumber(next.limit) && next.limit <= 0) delete next.limit;
  if ("length" in next) {
    if (!("limit" in next) && isFiniteNumber(next.length) && next.length > 0) next.limit = next.length;
    delete next.length;
  }
  return next;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface ReadInputValidationFailure {
  errorCode: ReadErrorCode;
  message: string;
}

/**
 * Read 的路径与页码预检：pages → 二进制扩展名 → 设备文件。validateInput、handler 与压缩恢复读取共用。
 * 修复原因：这些检查原来是 ReadInputSchema 的 superRefine。runtime schema 失败会先返回
 * InputValidationError（docs/model-tool-call-validation.md），友好文字和错误码会变成 JSON，
 * 所以改由 validateInput 调用这里，runtime schema 只做输入修正和字段校验。
 */
export function getReadInputValidationFailure(
  filePath: string,
  pages?: string,
): ReadInputValidationFailure | undefined {
  const pagesFailure = getReadPdfPagesValidationFailure(filePath, pages);
  if (pagesFailure) return pagesFailure;

  const lowerPath = filePath.toLowerCase();
  const extension = readFileExtension(lowerPath);
  // 文字见 01-read.md（2026-11-14）：二进制指向 skill 或能读该格式的命令；扩展名表不变。
  if (extension && UNSUPPORTED_BINARY_EXTENSIONS.has(extension)) {
    return {
      errorCode: ReadErrorCode.BINARY_FILE,
      message: `This tool cannot read binary files. The file appears to be a binary ${extension} file. Use a skill for this file type if one is available, or a shell command or script that can read the format.`,
    };
  }
  if (BLOCKING_DEVICE_PATHS.has(lowerPath)) {
    return {
      errorCode: ReadErrorCode.DEVICE_FILE,
      message: `Cannot read '${filePath}': this path names a device or process file that this tool does not read.`,
    };
  }
  return undefined;
}

export type ReadInput = z.infer<typeof ReadInputSchema>;

function readFileExtension(path: string): string | undefined {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = path.slice(lastSlash + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) return undefined;
  return basename.slice(dotIndex);
}

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface ReadTextOutput {
  type: "text";
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
  sizeBytes?: number;
  bytesRead?: number;
  truncated?: boolean;
  truncatedByTokenCap?: boolean;
  partialViewNotice?: string;
}

export interface ReadImageOutput {
  type: "image";
  base64: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  originalSize: number;
  transformedSize?: number;
  resized?: boolean;
  compressed?: boolean;
  compressionStrategy?: string;
  dimensions?: {
    originalWidth?: number;
    originalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
}

/** Read 视频输出：不做转码/压缩，仅读取 base64 并做大小校验。 */
export interface ReadVideoOutput {
  type: "video";
  base64: string;
  mimeType:
    | "video/mp4"
    | "video/quicktime"
    | "video/webm"
    | "video/x-matroska"
    | "video/x-m4v"
    | "video/x-msvideo";
  originalSize: number;
}

export interface ReadNotebookOutput {
  type: "notebook";
  notebookPath: string;
  cells: NotebookCell[];
}

export interface NotebookCell {
  cellType: "code" | "markdown";
  source: string;
  outputs?: CellOutput[];
}

export interface CellOutput {
  type: "stream" | "execute_result" | "error" | "display_data";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ReadPdfOutput {
  type: "pdf";
  filePath: string;
  base64: string;
  originalSize: number;
  pages?: string;
}

export interface ReadPartsOutput {
  type: "parts";
  filePath: string;
  numParts: number;
  originalSize: number;
  pages: Array<ReadImageOutput & { pageNumber: number }>;
}

export interface ReadUnchangedOutput {
  type: "file_unchanged";
  filePath: string;
}

export type ReadOutput =
  | ReadTextOutput
  | ReadImageOutput
  | ReadVideoOutput
  | ReadNotebookOutput
  | ReadPdfOutput
  | ReadPartsOutput
  | ReadUnchangedOutput;

export const ReadTextOutputSchema = z
  .object({
    type: z.literal("text"),
    filePath: z.string(),
    content: z.string(),
    numLines: z.number().int().nonnegative(),
    startLine: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative().optional(),
    bytesRead: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    truncatedByTokenCap: z.boolean().optional(),
    partialViewNotice: z.string().optional(),
  })
  .strict();

export const ReadImageDimensionsSchema = z
  .object({
    originalWidth: z.number().int().nonnegative().optional(),
    originalHeight: z.number().int().nonnegative().optional(),
    displayWidth: z.number().int().nonnegative().optional(),
    displayHeight: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ReadImageOutputSchema = z
  .object({
    type: z.literal("image"),
    base64: z.string(),
    mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    originalSize: z.number().int().nonnegative(),
    transformedSize: z.number().int().nonnegative().optional(),
    resized: z.boolean().optional(),
    compressed: z.boolean().optional(),
    compressionStrategy: z.string().optional(),
    dimensions: ReadImageDimensionsSchema.optional(),
  })
  .strict();

export const ReadVideoOutputSchema = z
  .object({
    type: z.literal("video"),
    base64: z.string(),
    mimeType: z.enum([
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-matroska",
      "video/x-m4v",
      "video/x-msvideo",
    ]),
    originalSize: z.number().int().nonnegative(),
  })
  .strict();

export const ReadCellOutputSchema = z
  .object({
    type: z.enum(["stream", "execute_result", "error", "display_data"]),
    text: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const ReadNotebookCellSchema = z
  .object({
    cellType: z.enum(["code", "markdown"]),
    source: z.string(),
    outputs: z.array(ReadCellOutputSchema).optional(),
  })
  .strict();

export const ReadNotebookOutputSchema = z
  .object({
    type: z.literal("notebook"),
    notebookPath: z.string(),
    cells: z.array(ReadNotebookCellSchema),
  })
  .strict();

export const ReadPdfOutputSchema = z
  .object({
    type: z.literal("pdf"),
    filePath: z.string(),
    base64: z.string(),
    originalSize: z.number().int().nonnegative(),
    pages: z.string().optional(),
  })
  .strict();

export const ReadPartsOutputSchema = z
  .object({
    type: z.literal("parts"),
    filePath: z.string(),
    numParts: z.number().int().nonnegative(),
    originalSize: z.number().int().nonnegative(),
    pages: z.array(ReadImageOutputSchema.extend({ pageNumber: z.number().int().positive() })),
  })
  .strict();

export const ReadUnchangedOutputSchema = z
  .object({
    type: z.literal("file_unchanged"),
    filePath: z.string(),
  })
  .strict();

export const ReadOutputSchema = z.union([
  ReadTextOutputSchema,
  ReadImageOutputSchema,
  ReadVideoOutputSchema,
  ReadNotebookOutputSchema,
  ReadPdfOutputSchema,
  ReadPartsOutputSchema,
  ReadUnchangedOutputSchema,
]);

export const ReadOutputJsonSchema = toToolJsonSchema(ReadOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface ReadToolCall {
  id: ToolCallId;
  name: "Read";
  input: ReadInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface ReadToolResult {
  toolCallId: ToolCallId;
  output: ReadOutput;
  traceId: TraceId;
  durationMs: number;
}

// ============================================================
// Read Tool Handler
// ============================================================

import { basename, dirname, extname } from "node:path";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
  ToolHandler,
  ToolEntry,
  ToolInputValidationResult,
} from "../types.js";
import {
  CoreErrorType,
  READ_DEFAULT_MAX_LINES,
  READ_MAX_FILE_SIZE_BYTES,
  ReadInputJsonSchema,
  ReadInputSchema,
  ReadOutputJsonSchema,
  ReadOutputSchema,
  createCoreError,
  getReadInputValidationFailure,
  isCoreError,
  isFileSystemPortError,
  type ReadInput,
  type ReadImageOutput,
  type ReadVideoOutput,
  type ModelMessageContent,
  type ReadOutput,
  type ReadTextOutput,
  type FileSystemPort,
  type FileSystemStatResult,
  type TraceContext,
} from "@zcode/contracts";
import { levenshteinDistance } from "../levenshtein.js";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
  requestedPathField,
  setReadFileStateEntry,
} from "../read-file-state.js";
import { createReadFileStateMetadata } from "../read-file-state-metadata.js";
import { inferImageMimeFromPath, readImageFile } from "./read-image.js";
import { inferVideoMimeFromPath } from "../../runtime/helpers/attachment-video.js";
import { readVideoFile } from "./read-video.js";
import {
  READ_FILE_UNCHANGED_STUB,
  READ_OUTPUT_TOO_MANY_TOKENS_CODE,
  formatReadBatchNotice,
  formatReadTextOutput,
  readTextFileForModel,
} from "./read-text.js";
import {
  formatReadPdfOutput,
  formatReadPdfPagesOutput,
  isPdfPath,
  READ_PDF_TOOL_TIMEOUT_MS,
  readPdfFile,
  resolveReadInputSchema,
  resolveReadProviderDescription,
  resolveReadTimeoutBudgetMs,
  supportsPdfForExecution,
} from "./read-pdf.js";

export { addReadLineNumbers } from "./read-text.js";

const READ_PROVIDER_DESCRIPTION = [
  "Reads a file from the local filesystem.",
  "",
  "- `file_path` must be an absolute path.",
  `- Reads up to ${READ_DEFAULT_MAX_LINES} lines by default.`,
  "- When you already know which part of the file you need, only read that part. This can be important for larger files.",
  "- Results are returned using cat -n format, with line numbers starting at 1",
  "- Reads images (PNG, JPG, …) and presents them visually.",
  "- Reads videos (MP4, MOV, WEBM, …) and presents them as video input (subject to ZCode's video input limit).",
  "- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.",
  "- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.",
].join("\n");

const fallbackReadFileStates = new WeakMap<ToolExecutionContext, ReadFileStateMap>();

function formatReadModelContent(output: unknown): ModelMessageContent {
  const parsed = ReadOutputSchema.safeParse(output);
  if (!parsed.success) {
    return stringifyReadOutputFallback(output);
  }

  return formatReadOutput(parsed.data);
}

function formatReadOutput(output: ReadOutput): ModelMessageContent {
  switch (output.type) {
    case "text":
      return formatReadTextToolResult(output);
    case "file_unchanged":
      return READ_FILE_UNCHANGED_STUB;
    case "image":
      return formatReadImageOutput(output);
    case "video":
      return formatReadVideoOutput(output);
    case "pdf":
      return formatReadPdfOutput(output);
    case "parts":
      return formatReadPdfPagesOutput(output);
    case "notebook":
      return stringifyReadOutputFallback(output);
  }
}

/** 文本 Read 的 tool_result 正文；compaction 补回文件用同一格式。 */
export function formatReadTextToolResult(output: ReadTextOutput): string {
  // 部分视图提示由工具批次之后的附件发送，tool_result 只含带行号的正文。
  const { partialViewNotice: _notice, ...textOutput } = output;
  return formatReadTextOutput(textOutput);
}

function formatReadImageOutput(output: ReadImageOutput): ModelMessageContent {
  const imageBlock = {
    type: "image" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-image",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read image",
      sizeBytes: output.originalSize,
    },
  };
  // 尺寸提示拼进 tool result 会让 provider-visible content 随是否缩放而改变；
  // 图片结果只保留媒体 block，dimensions 继续留在结构化 output 供 UI 和调试使用。
  return [imageBlock];
}

// 与图片同构：tool result 只保留媒体 block；OpenAI 系 provider 由
// tool-result-media-projection 拆成后置 user part（AI SDK tool result 无 video part 变体）。
function formatReadVideoOutput(output: ReadVideoOutput): ModelMessageContent {
  const videoBlock = {
    type: "video" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-video",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read video",
      sizeBytes: output.originalSize,
    },
  };
  return [videoBlock];
}

function stringifyReadOutputFallback(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? "";
}

export const readHandler: ToolHandler = async (input, context) => {
  const parsed = ReadInputSchema.parse(input) as ReadInput;
  // hook 改写后的输入不再经过 validateInput，这里用同一个预检再拒绝一次。
  const invalid = validateReadInput(parsed);
  if (!invalid.result) return invalid;
  const { file_path, offset, limit, pages } = parsed;
  const fileSystemPort = context.fileSystemPort;

  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Read tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }

  const filePath = resolveWorkspacePath({
    inputPath: file_path,
    operation: "read",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  try {
    const imageMime = inferImageMimeFromPath(filePath);
    if (imageMime) {
      return await readImageFile(filePath, imageMime, context);
    }

    const videoMime = inferVideoMimeFromPath(filePath);
    if (videoMime) {
      return await readVideoFile(filePath, videoMime, context);
    }

    if (isPdfPath(filePath) && supportsPdfForExecution(context)) {
      return await readPdfFile({ filePath, pages }, context);
    }

    const trace = createReadTrace(context);
    const stat = await fileSystemPort.stat(
      { path: filePath, trace },
      { signal: context.abortSignal },
    );
    const readFileState = getReadFileState(context);
    const cacheOffset = normalizeCacheOffset(offset);
    const cached = findLatestReadFileState(readFileState, filePath);
    if (cached && isSameReadView(cached, cacheOffset, limit) && isCachedReadFresh(cached, stat)) {
      // 修复原因：这里的快照只是当时最新记录的副本，冷恢复按它重放会恢复出已不在 active history
      // 里的视图（例如那次真实读取已被 compact 摘要）。不写 live 状态，也不记录快照。
      return { type: "file_unchanged", filePath } satisfies ReadOutput;
    }

    let rangeReadRevision: FileSystemStatResult["revision"] | undefined;
    const output = await readTextFileForModel({
      abortSignal: context.abortSignal,
      filePath,
      fileSystemPort,
      limit,
      onRead: (read) => {
        rangeReadRevision = read.revision;
      },
      offset,
      trace,
    });
    updateReadFileState(readFileState, {
      output,
      path: filePath,
      requestedPath: file_path,
      stat,
      rangeReadRevision,
      offset,
      limit,
    });
    recordReadFileStateMetadata(context, {
      output,
      readFileState,
      toolInput: input,
    });
    return output;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      const message = await createMissingReadFileMessage(filePath, context);
      throw createCoreError(CoreErrorType.ToolExecutionFailed, message, {
        cause: error,
        context: {
          code: "read_file_not_found",
          filePath,
        },
        recoverable: true,
      });
    }
    if (isFileSystemPortError(error) && error.code === "too_large") {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_file_too_large",
          filePath,
          maxBytes: READ_MAX_FILE_SIZE_BYTES,
        },
        recoverable: true,
      });
    }
    throw error;
  }
};

/**
 * 路径与页码预检在 Hook 和权限之前完成，规则见 01-read.md。
 * 修复原因：二进制和设备文件的检查原来在 ReadInputSchema 的 superRefine 里，由 handler 抛出带
 * `<tool_use_error>` 标签的 error.message，Hook 与权限先跑一遍，UI 显示的错误也带着标签。
 */
function validateReadInput(input: unknown): ToolInputValidationResult {
  const candidate = (input ?? {}) as { file_path?: unknown; pages?: unknown };
  if (typeof candidate.file_path !== "string") return { result: true };
  const failure = getReadInputValidationFailure(
    candidate.file_path,
    typeof candidate.pages === "string" ? candidate.pages : undefined,
  );
  return failure ? { result: false, ...failure } : { result: true };
}

function createReadTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}

function getReadFileState(context: ToolExecutionContext): ReadFileStateMap {
  if (context.readFileState) return context.readFileState;
  const existing = fallbackReadFileStates.get(context);
  if (existing) return existing;
  const state: ReadFileStateMap = new Map();
  fallbackReadFileStates.set(context, state);
  return state;
}

function normalizeCacheOffset(offset: number | undefined): number {
  return offset === undefined ? 1 : offset;
}

// 只按该文件最近一次视图去重，且这个视图必须来自 Read。
// 修复原因：Edit/Write 写入后用完整视图的键记录状态，Read 按键命中时返回 Wasted call 存根，
// 但模型没看过写入后的内容；中间读过别的范围后再读完整文件，也会命中更早的完整视图。
function isSameReadView(
  entry: ReadFileStateEntry,
  offset: number,
  limit: number | undefined,
): boolean {
  return (
    (entry.sourceTool === undefined || entry.sourceTool === "Read") &&
    normalizeCacheOffset(entry.offset) === offset &&
    entry.limit === limit
  );
}

function isCachedReadFresh(entry: ReadFileStateEntry, stat: FileSystemStatResult): boolean {
  if (entry.isPartialView) return false;

  const mtimeMs = stat.revision?.mtimeMs ?? stat.mtimeMs;
  if (entry.mtimeMs !== undefined && mtimeMs !== undefined) {
    // 和写前 freshness 校验保持同一套策略，mtime 只比较整数毫秒。
    return (
      normalizeReadFileStateMtimeMs(entry.mtimeMs) === normalizeReadFileStateMtimeMs(mtimeMs) &&
      entry.sizeBytes === stat.sizeBytes
    );
  }

  const revisionId = stat.revision?.id;
  if (entry.revisionId && revisionId) return entry.revisionId === revisionId;

  return entry.sizeBytes !== undefined && entry.sizeBytes === stat.sizeBytes;
}

interface ReadTextFileStateInput {
  output: ReadTextOutput;
  path: string;
  requestedPath?: string;
  stat: FileSystemStatResult;
  rangeReadRevision?: FileSystemStatResult["revision"];
  offset?: number;
  limit?: number;
}

function updateReadFileState(state: ReadFileStateMap, input: ReadTextFileStateInput): void {
  setReadFileStateEntry(state, createReadTextFileStateEntry(input));
}

function createReadTextFileStateEntry(input: ReadTextFileStateInput): ReadFileStateEntry {
  const revision = input.stat.revision ?? input.rangeReadRevision;
  return {
    path: input.path,
    ...requestedPathField(input.requestedPath, input.path),
    content: input.output.content,
    offset: input.offset,
    limit: input.limit,
    // offset/limit 是 range view，不等价于 partial view。
    // partial view 只表示模型看到的内容被工具截断，Write/Edit 必须拒绝这种不完整视图。
    isPartialView: input.output.truncatedByTokenCap === true,
    readAt: new Date(),
    sourceTool: "Read",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs ?? input.stat.mtimeMs),
    sizeBytes: input.stat.sizeBytes,
  };
}

/** compaction 补回文件时一次整文件读取的结果。 */
export type PostCompactFileRead =
  | {
      type: "text";
      output: ReadTextOutput;
      /** 这次读取对应的读取状态记录；由调用方在 compaction 持久化成功后写入。 */
      readFileStateEntry: ReadFileStateEntry;
    }
  /** 超过 Read 的文件大小或 token 上限，只能放引用提示。 */
  | { type: "too_large" }
  /** 不补回的路径：Read 预检不通过的二进制、设备文件，以及图片、视频、PDF。 */
  | { type: "skipped" };

/**
 * compaction 补回文件：按 Read 的整文件语义（不带 offset / limit）读取磁盘上的当前内容。
 * 不经过执行器，不写读取状态。权限由调用方判定；其余读取错误原样抛出。
 */
export async function readFileForCompactRestore(input: {
  abortSignal?: AbortSignal;
  filePath: string;
  fileSystemPort: FileSystemPort;
  trace?: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<PostCompactFileRead> {
  if (getReadInputValidationFailure(input.filePath)) return { type: "skipped" };
  const filePath = resolveWorkspacePath({
    inputPath: input.filePath,
    operation: "read",
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
  if (inferImageMimeFromPath(filePath) || inferVideoMimeFromPath(filePath) || isPdfPath(filePath)) {
    return { type: "skipped" };
  }

  const { abortSignal, fileSystemPort, trace } = input;
  try {
    const stat = await fileSystemPort.stat({ path: filePath, trace }, { signal: abortSignal });
    let rangeReadRevision: FileSystemStatResult["revision"] | undefined;
    const output = await readTextFileForModel({
      abortSignal,
      filePath,
      fileSystemPort,
      onRead: (read) => {
        rangeReadRevision = read.revision;
      },
      trace,
    });
    return {
      type: "text",
      output,
      readFileStateEntry: createReadTextFileStateEntry({
        output,
        path: filePath,
        rangeReadRevision,
        stat,
      }),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") return { type: "too_large" };
    if (isCoreError(error) && error.context?.code === READ_OUTPUT_TOO_MANY_TOKENS_CODE) {
      return { type: "too_large" };
    }
    throw error;
  }
}

function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  input: {
    output: ReadTextOutput;
    readFileState: ReadFileStateMap;
    toolInput: unknown;
  },
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadata({
    completedAt: new Date(),
    output: input.output,
    readFileState: input.readFileState,
    toolInput: input.toolInput,
    toolName: "Read",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

async function createMissingReadFileMessage(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string> {
  const suggestion = await findSimilarFilename(filePath, context);
  return [
    `File does not exist. Note: your current working directory is ${context.workingDirectory}.`,
    suggestion ? ` Did you mean ${suggestion}?` : "",
  ].join("");
}

async function findSimilarFilename(
  filePath: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return undefined;

  try {
    const parent = dirname(filePath);
    const targetName = basename(filePath);
    const targetStem = basename(filePath, extname(filePath));
    const listed = await fileSystemPort.listDirectory(
      { path: parent, trace: createReadTrace(context) },
      { signal: context.abortSignal },
    );
    const entries = listed.entries
      .filter((entry) => entry.kind === "file" || entry.kind === "symlink")
      .map((entry) => entry.name)
      .filter((name) => name !== targetName)
      .sort();

    const sameStem = entries.find((name) => basename(name, extname(name)) === targetStem);
    if (sameStem) return sameStem;

    return entries.find((name) => levenshteinDistance(name, targetName) <= 3);
  } catch {
    return undefined;
  }
}

export const readToolEntry: ToolEntry = {
  capability:
    "Read text files and supported images from the file-system adapter without modifying files",
  metadata: {
    name: "Read",
    description: READ_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: READ_MAX_FILE_SIZE_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: readHandler,
  validateInput: validateReadInput,
  resolveModelContract: (context) => ({
    description: resolveReadProviderDescription(READ_PROVIDER_DESCRIPTION, context),
    inputSchema: resolveReadInputSchema(context),
  }),
  resolveTimeoutBudgetMs: resolveReadTimeoutBudgetMs,
  formatModelContent: formatReadModelContent,
  formatBatchNotice: formatReadBatchNotice,
  inputSchema: ReadInputJsonSchema,
  outputSchema: ReadOutputJsonSchema,
  runtimeInputSchema: ReadInputSchema,
  runtimeOutputSchema: ReadOutputSchema,
  permission: {
    permission: "read",
    reason: "Read only inspects file content and has no external side effects",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: READ_MAX_FILE_SIZE_BYTES,
    maxModelBytes: READ_MAX_FILE_SIZE_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: READ_MAX_FILE_SIZE_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: READ_PDF_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "required",
    userVisibleMessage: "Read was cancelled before file content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

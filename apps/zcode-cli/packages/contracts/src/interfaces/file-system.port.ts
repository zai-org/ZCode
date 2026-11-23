// ============================================================
// FileSystem Port - file I/O boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type FileSystemErrorCode =
  | "not_found"
  | "permission_denied"
  | "is_directory"
  | "not_file"
  | "too_large"
  | "stale_write"
  | "invalid_path"
  | "invalid_pattern"
  | "unsupported"
  | "cancelled"
  | "io_error";

export interface FileSystemErrorDetails {
  code: FileSystemErrorCode;
  path?: string;
  message: string;
  cause?: unknown;
}

export class FileSystemPortError extends Error {
  readonly code: FileSystemErrorCode;
  readonly path?: string;
  override readonly cause?: unknown;

  constructor(details: FileSystemErrorDetails) {
    super(details.message);
    this.name = "FileSystemPortError";
    this.code = details.code;
    this.path = details.path;
    this.cause = details.cause;
  }
}

export function createFileSystemError(details: FileSystemErrorDetails): FileSystemPortError {
  return new FileSystemPortError(details);
}

export function isFileSystemPortError(error: unknown): error is FileSystemPortError {
  return error instanceof FileSystemPortError;
}

export type FileSystemNodeKind = "file" | "directory" | "symlink" | "other" | "missing";

export interface FileSystemRevision {
  id: string;
  mtimeMs?: number;
  sizeBytes?: number;
  hash?: string;
}

export type FileSystemLineEndings = "LF" | "CRLF";
export type FileSystemTextEncoding = BufferEncoding | "gb2312" | "gbk" | "gb18030";

export interface FileSystemStatRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  trace?: TraceContext;
}

export interface FileSystemStatResult {
  path: string;
  kind: FileSystemNodeKind;
  sizeBytes: number;
  mtimeMs?: number;
  revision?: FileSystemRevision;
}

export interface FileSystemCreateDirectoryRequest {
  /** Normalized absolute path. Parent directories are created recursively. */
  path: string;
  trace?: TraceContext;
}

export interface FileSystemCreateDirectoryResult {
  path: string;
}

export interface FileSystemReadTextRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  encoding?: FileSystemTextEncoding;
  maxBytes?: number;
  trace?: TraceContext;
}

export interface FileSystemReadTextResult {
  path: string;
  /**
   * Text content normalized to LF line endings for tool/core consumption.
   * The original dominant file line ending is reported via `lineEndings`.
   */
  content: string;
  encoding: FileSystemTextEncoding;
  /** Dominant line ending style observed before LF normalization. */
  lineEndings?: FileSystemLineEndings;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  revision?: FileSystemRevision;
}

export interface FileSystemReadBytesRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Optional total file size guard. Exceeding it fails with `too_large`; it does not truncate. */
  maxBytes?: number;
  trace?: TraceContext;
}

export interface FileSystemReadBytesResult {
  path: string;
  content: Uint8Array;
  bytesRead: number;
  sizeBytes: number;
  revision?: FileSystemRevision;
}

export interface FileSystemReadTextRangeRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  encoding?: FileSystemTextEncoding;
  /** Zero-based logical line offset. Tool-facing one-based offsets are translated before this port. */
  offsetLine?: number;
  /** Number of logical lines to return. Omit to return from offset through EOF. */
  limitLines?: number;
  /** Optional total file size guard. Exceeding it fails with `too_large`; it does not truncate. */
  maxBytes?: number;
  trace?: TraceContext;
}

export interface FileSystemReadTextRangeResult {
  path: string;
  /**
   * Selected text content normalized to LF line endings for tool/core consumption.
   * The original dominant file line ending is reported via `lineEndings`.
   */
  content: string;
  encoding: FileSystemTextEncoding;
  /** Dominant line ending style observed before LF normalization. */
  lineEndings?: FileSystemLineEndings;
  /** Number of bytes consumed by the adapter while producing this range. */
  bytesRead: number;
  /** Total file size in bytes. */
  sizeBytes: number;
  /** True only for adapters that intentionally truncate range reads. Node adapter range reads fail instead. */
  truncated: boolean;
  /** One-based line number of the first returned/requested line. */
  startLine: number;
  /** Number of lines returned in `content`. */
  lineCount: number;
  /** Total logical line count in the file. */
  totalLines: number;
  revision?: FileSystemRevision;
}

export interface FileSystemWriteTextRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  content: string;
  encoding?: FileSystemTextEncoding;
  /** Restore this line ending style while writing logical LF-normalized text. */
  lineEndings?: FileSystemLineEndings;
  createParents?: boolean;
  atomic?: boolean;
  expectedRevision?: FileSystemRevision;
  /**
   * 写入执行点的符号链接核验：适配器从该目录（不含）逐级到目标本身（含）用 lstat 检查，任一级是符号链接即拒绝写入。
   * 必须是 `path` 的祖先目录。草稿写入（ZP-20261110-04）用它阻止 `.zcode/workflow-drafts` 被链接到项目外。
   */
  symlinkFreeBase?: string;
  trace?: TraceContext;
}

export interface FileSystemWriteTextResult {
  path: string;
  bytesWritten: number;
  revision?: FileSystemRevision;
}

export interface FileSystemRemoveFileRequest {
  /** Normalized absolute path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Treat a missing file as a completed no-op. */
  missingOk?: boolean;
  trace?: TraceContext;
}

export interface FileSystemRemoveFileResult {
  path: string;
  removed: boolean;
}

export interface FileSystemListDirectoryRequest {
  /** Normalized absolute directory path. Relative paths are resolved by the caller. */
  path: string;
  trace?: TraceContext;
}

export interface FileSystemListDirectoryEntry {
  kind: FileSystemNodeKind;
  name: string;
  path: string;
}

export interface FileSystemListDirectoryResult {
  durationMs: number;
  entries: FileSystemListDirectoryEntry[];
  numEntries: number;
  path: string;
}

export interface FileSystemSearchFilesRequest {
  /** Normalized absolute directory path. Relative paths are resolved by the tool layer. */
  path: string;
  /** Glob pattern relative to path unless the adapter documents additional support. */
  pattern: string;
  maxResults?: number;
  offset?: number;
  trace?: TraceContext;
}

export interface FileSystemSearchFilesResult {
  path: string;
  pattern: string;
  durationMs: number;
  files: string[];
  numFiles: number;
  truncated: boolean;
}

export type FileSystemTextSearchOutputMode = "content" | "files_with_matches" | "count";

export interface FileSystemSearchTextRequest {
  /** Normalized absolute file or directory path. Relative paths are resolved by the tool layer. */
  path: string;
  pattern: string;
  glob?: string;
  outputMode?: FileSystemTextSearchOutputMode;
  beforeContext?: number;
  afterContext?: number;
  context?: number;
  showLineNumbers?: boolean;
  onlyMatching?: boolean;
  ignoreCase?: boolean;
  type?: string;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
  trace?: TraceContext;
}

export interface FileSystemSearchTextEntry {
  path: string;
  lineNumber?: number;
  text?: string;
  count?: number;
  matched?: boolean;
}

export interface FileSystemSearchTextResult {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  durationMs: number;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
  truncated: boolean;
  appliedLimit?: number;
  appliedOffset?: number;
}

export interface FileSystemOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface FileSystemPort {
  createDirectory(
    request: FileSystemCreateDirectoryRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemCreateDirectoryResult>;
  stat(
    request: FileSystemStatRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemStatResult>;
  readTextFile(
    request: FileSystemReadTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadTextResult>;
  readBinaryFile(
    request: FileSystemReadBytesRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadBytesResult>;
  readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemReadTextRangeResult>;
  writeTextFile(
    request: FileSystemWriteTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemWriteTextResult>;
  removeFile(
    request: FileSystemRemoveFileRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemRemoveFileResult>;
  listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemListDirectoryResult>;
  searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemSearchFilesResult>;
  searchText(
    request: FileSystemSearchTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemSearchTextResult>;
}

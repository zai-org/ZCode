/* eslint-disable max-lines -- 存量文件已超过 max-lines 上限；本次只为 ZP-20261110-04 增加符号链接写入校验，拆分另开工单（架构例外 workflow-draft-symlink-index-lines）。 */
// ============================================================
// Node FileSystem Adapter
// ============================================================

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type { RgArg, RipgrepBufferedResult } from "ripgrep";
import {
  createFileSystemError,
  isFileSystemPortError,
  type FileSystemNodeKind,
  type FileSystemPort,
  type FileSystemCreateDirectoryRequest,
  type FileSystemCreateDirectoryResult,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemListDirectoryRequest,
  type FileSystemListDirectoryResult,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemRevision,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextEntry,
  type FileSystemTextSearchOutputMode,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";
import {
  applyRequestedLineEndings,
  decodeTextBuffer,
  detectLineEndings,
  encodeTextContent,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";
import { readTextFileRangeFromNode } from "./text-range-reader.js";
import { assertNoSymlinkBetween, getNodeErrorCode, SymlinkWriteRefusedError } from "./symlink-guard.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";

const DEFAULT_GLOB_MAX_RESULTS = 100;
const DEFAULT_GREP_HEAD_LIMIT = 250;
const DEFAULT_RIPGREP_TIMEOUT_MS = 30_000;
const VCS_DIRECTORIES_TO_EXCLUDE = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

type RipgrepWorker = Pick<Worker, "once" | "terminate">;

interface RipgrepWorkerData {
  args: string[];
  preopens: Record<string, string>;
}

interface SerializedWorkerError {
  code?: unknown;
  message?: string;
  name?: string;
  stack?: string;
}

type RipgrepWorkerMessage =
  | { type: "result"; result: RipgrepBufferedResult }
  | { type: "error"; error: SerializedWorkerError };

type RipgrepWorkerFactory = (workerData: RipgrepWorkerData) => RipgrepWorker;

let ripgrepWorkerFactoryForTests: RipgrepWorkerFactory | undefined;
let ripgrepTimeoutMsForTests: number | undefined;

const RIPGREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "Error" };
  }
  return {
    code: "code" in error ? error.code : undefined,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

(async () => {
  try {
    const { ripgrep } = await import("ripgrep");
    const result = await ripgrep(workerData.args, {
      buffer: true,
      env: {},
      nodeWasi: false,
      preopens: workerData.preopens,
      returnOnExit: true,
    });
    parentPort.postMessage({ type: "result", result });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) });
  }
})();
`;

export interface NodeFileSystemAdapterOptions {
  textSearchEngine?: "ripgrep" | "javascript";
}

export class NodeFileSystemAdapter implements FileSystemPort {
  constructor(private readonly adapterOptions: NodeFileSystemAdapterOptions = {}) {}

  async createDirectory(
    request: FileSystemCreateDirectoryRequest,
  ): Promise<FileSystemCreateDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      maybeThrowStorageFsFault({ operation: "mkdir", path });
      await mkdir(path, { recursive: true });
      return { path };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      const info = await stat(path);
      const kind = nodeKind(info);
      return {
        path,
        kind,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        revision:
          kind === "file"
            ? {
                id: revisionId(info.mtimeMs, info.size),
                mtimeMs: info.mtimeMs,
                sizeBytes: info.size,
              }
            : undefined,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as text file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as text: ${path}`,
        });
      }

      const maxBytes = request.maxBytes;
      const truncated = maxBytes !== undefined && info.size > maxBytes;
      const buffer = truncated ? await readFirstBytes(path, maxBytes) : await readFile(path);
      const decoded = decodeTextBuffer({ buffer, encoding: request.encoding, path });
      const rawContent = decoded.content;
      const encoding = decoded.encoding;
      const isText = shouldNormalizeLineEndings(encoding);
      const lineEndings = isText ? detectLineEndings(rawContent) : undefined;
      const content = isText ? normalizeLineEndings(rawContent) : rawContent;

      return {
        path,
        content,
        encoding,
        lineEndings,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        truncated,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readBinaryFile(request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as binary file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as binary: ${path}`,
        });
      }
      if (request.maxBytes !== undefined && info.size > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content (${formatByteCount(info.size)}) exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }

      const buffer =
        request.maxBytes === undefined
          ? await readFile(path)
          : await readAtMostBytes(path, request.maxBytes + 1, info.size);
      if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
        // stat 与 readFile 之间文件可能增长；实际读取也必须保持有界，
        // 否则 maxBytes 既挡不住超限内容，也挡不住一次性大内存分配。
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }
      return {
        path,
        content: buffer,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemReadTextRangeResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      if (info.isDirectory()) {
        throw createFileSystemError({
          code: "is_directory",
          path,
          message: `Cannot read directory as text file: ${path}`,
        });
      }
      if (!info.isFile()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Cannot read non-file path as text: ${path}`,
        });
      }

      return await readTextFileRangeFromNode({ ...request, path }, info, options?.signal);
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async writeTextFile(request: FileSystemWriteTextRequest): Promise<FileSystemWriteTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const encoding = request.encoding ?? "utf8";
    const textContent = applyRequestedLineEndings(request.content, request.lineEndings);
    const content = encodeTextContent({ content: textContent, encoding, path });

    try {
      // ZP-20261110-04：草稿写入的字符串路径在草稿目录内，但目录链接可把真实落点导向项目外。
      // 在建父目录前核验一次（避免经链接建出项目外的目录），写入前再核验一次（紧贴 rename）。
      if (request.symlinkFreeBase !== undefined) {
        await assertNoSymlinkBetween(request.symlinkFreeBase, path);
      }

      if (request.expectedRevision) {
        await this.assertExpectedRevision(path, request.expectedRevision);
      }

      if (request.createParents) {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(path) });
        await mkdir(dirname(path), { recursive: true });
      }

      if (request.symlinkFreeBase !== undefined) {
        await assertNoSymlinkBetween(request.symlinkFreeBase, path);
      }

      if (request.atomic ?? true) {
        await atomicWrite(path, content);
      } else {
        maybeThrowStorageFsFault({ operation: "writeFile", path });
        await writeFile(path, content);
      }

      const info = await stat(path);
      return {
        path,
        bytesWritten: content.byteLength,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(content),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async removeFile(
    request: FileSystemRemoveFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemRemoveFileResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      throwIfAborted(options?.signal);
      maybeThrowStorageFsFault({ operation: "rm", path });
      await unlink(path);
      return { path, removed: true };
    } catch (error) {
      const normalized = toFileSystemError(error, path);
      if (
        request.missingOk === true &&
        isFileSystemPortError(normalized) &&
        normalized.code === "not_found"
      ) {
        return { path, removed: false };
      }
      throw normalized;
    }
  }

  async listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemListDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const startedAt = Date.now();

    try {
      throwIfAborted(options?.signal);
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Directory listing path must be a directory: ${path}`,
        });
      }

      const entries = await readdir(path, { withFileTypes: true });
      throwIfAborted(options?.signal);
      const mapped = entries
        .map((entry) => ({
          kind: direntKind(entry),
          name: entry.name,
          path: join(path, entry.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        path,
        durationMs: Math.max(0, Date.now() - startedAt),
        entries: mapped,
        numEntries: mapped.length,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchFilesResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const pattern = request.pattern.trim();
    const startedAt = Date.now();

    if (pattern.length === 0) {
      throw createFileSystemError({
        code: "invalid_pattern",
        path,
        message: "Glob pattern must not be empty",
      });
    }

    try {
      throwIfAborted(options?.signal);
      const rootInfo = await stat(path);
      if (!rootInfo.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Glob search path must be a directory: ${path}`,
        });
      }

      const matcher = createGlobMatcher(pattern);
      const matches: Array<{ path: string; mtimeMs: number }> = [];

      await walkFiles(path, options?.signal, async (filePath, info) => {
        const relativePath = toPosixRelative(path, filePath);
        if (matcher(relativePath, basename(filePath))) {
          matches.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
        }
      });

      matches.sort((left, right) => {
        const timeComparison = right.mtimeMs - left.mtimeMs;
        return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
      });

      const offset = request.offset ?? 0;
      const maxResults = request.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
      const files = matches.slice(offset, offset + maxResults).map((match) => match.path);

      return {
        path,
        pattern,
        durationMs: Math.max(0, Date.now() - startedAt),
        files,
        numFiles: files.length,
        truncated: matches.length > offset + maxResults,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async searchText(
    request: FileSystemSearchTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const normalizedRequest = request.path === path ? request : { ...request, path };

    if (this.adapterOptions.textSearchEngine === "javascript") {
      return searchTextWithJavaScript(normalizedRequest, options?.signal);
    }

    try {
      return await searchTextWithRipgrep(normalizedRequest, options?.signal);
    } catch (error) {
      if (error instanceof RipgrepRuntimeFailure) {
        return searchTextWithJavaScript(normalizedRequest, options?.signal);
      }
      throw toFileSystemError(error, path);
    }
  }

  private async assertExpectedRevision(path: string, expected: FileSystemRevision): Promise<void> {
    const info = await stat(path);
    const actual = revisionId(info.mtimeMs, info.size);
    if (actual !== expected.id) {
      throw createFileSystemError({
        code: "stale_write",
        path,
        message: `File changed since it was read: ${path}`,
      });
    }
  }
}

export function createNodeFileSystemAdapter(
  options: NodeFileSystemAdapterOptions = {},
): NodeFileSystemAdapter {
  return new NodeFileSystemAdapter(options);
}

export function setRipgrepWorkerFactoryForTests(
  factory: RipgrepWorkerFactory | undefined,
): () => void {
  const previous = ripgrepWorkerFactoryForTests;
  ripgrepWorkerFactoryForTests = factory;
  return () => {
    ripgrepWorkerFactoryForTests = previous;
  };
}

export function setRipgrepTimeoutMsForTests(timeoutMs: number | undefined): () => void {
  const previous = ripgrepTimeoutMsForTests;
  ripgrepTimeoutMsForTests = timeoutMs;
  return () => {
    ripgrepTimeoutMsForTests = previous;
  };
}

async function searchTextWithRipgrep(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  let rootInfo: Awaited<ReturnType<typeof stat>>;
  try {
    throwIfAborted(signal);
    rootInfo = await stat(path);
  } catch (error) {
    throw toFileSystemError(error, path);
  }

  if (!rootInfo.isFile() && !rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  const mode = request.outputMode ?? "files_with_matches";
  const plan = createRipgrepSearchPlan(path, rootInfo, request, mode);
  const result = await runBundledRipgrep(plan.args, plan.preopens, { signal });
  throwIfAborted(signal);

  if (result.code === 2) {
    throw toRipgrepFileSystemError(result.stderr, path, pattern);
  }
  if (result.code !== 0 && result.code !== 1) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: `ripgrep exited with code ${result.code}: ${result.stderr || "unknown error"}`,
    });
  }

  const parsed =
    mode === "content"
      ? parseRipgrepJsonOutput(result.stdout, plan.outputRoot, request)
      : parseRipgrepCountOutput(result.stdout, plan.outputRoot, request);
  const files = await sortPathsByMtime(parsed.files);

  return finishTextSearchResult({
    path,
    pattern,
    mode,
    startedAt,
    request,
    files,
    entries: mode === "files_with_matches" ? [] : parsed.entries,
    numMatches: parsed.numMatches,
  });
}

async function searchTextWithJavaScript(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  try {
    throwIfAborted(signal);
    const regex = compileSearchRegex(pattern, request);
    const rootInfo = await stat(path);
    const mode = request.outputMode ?? "files_with_matches";
    const candidates = await collectTextSearchCandidates(path, rootInfo, request, signal);

    const searchRequest =
      mode === "content" ? request : { ...request, onlyMatching: false };
    const contentEntries: FileSystemSearchTextEntry[] = [];
    const countEntries: FileSystemSearchTextEntry[] = [];
    const matchingFiles: Array<{ path: string; mtimeMs: number }> = [];
    let numMatches = 0;

    for (const candidate of candidates) {
      throwIfAborted(signal);
      const content = await readFile(candidate.path, "utf8");
      if (looksBinary(content)) continue;

      const search = request.multiline
        ? searchMultilineContent(candidate.path, content, regex, searchRequest)
        : searchLineContent(candidate.path, content, regex, searchRequest);

      if (search.matchCount === 0) continue;

      numMatches += search.matchCount;
      matchingFiles.push({ path: candidate.path, mtimeMs: candidate.mtimeMs });
      if (mode === "content") {
        contentEntries.push(...search.entries);
      } else if (mode === "count") {
        countEntries.push({
          path: candidate.path,
          count: search.matchCount,
        });
      }
    }

    matchingFiles.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    return finishTextSearchResult({
      path,
      pattern,
      mode,
      startedAt,
      request,
      files: matchingFiles.map((item) => item.path),
      entries: mode === "content" ? contentEntries : countEntries,
      numMatches,
    });
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readAtMostBytes(
  path: string,
  maxBytes: number,
  initialSizeBytes: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    // 稳定文件按 stat 大小一次读取；只有文件在 stat 后增长时才继续分块追到硬上限。
    const firstBuffer = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1, initialSizeBytes + 1)));
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const chunk =
        bytesReadTotal === 0
          ? firstBuffer
          : Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytesReadTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytesReadTotal);
      // FileHandle.read 的短读不等于 EOF；只有明确返回 0 字节才能停止。
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (chunks.length === 0) return Buffer.alloc(0);
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesReadTotal);
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  let existingMode: number | undefined;

  try {
    const targetInfo = await lstat(path);
    if (targetInfo.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${path}. Resolve the symlink and pass the real target path explicitly.`,
      );
    }
    existingMode = targetInfo.mode;
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;

  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(content);
      if (existingMode !== undefined) {
        // 原子写会用临时文件 inode 覆盖目标文件；必须先复制原文件权限，避免抹掉脚本执行位。
        await handle.chmod(existingMode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
  } catch {
    await unlink(tempPath).catch(() => undefined);
    const fallbackHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (getNodeErrorCode(error) === "ELOOP") {
        throw new SymlinkWriteRefusedError(`Refusing to write through symlink: ${path} (O_NOFOLLOW)`);
      }
      throw error;
    });

    try {
      await fallbackHandle.writeFile(content);
      await fallbackHandle.sync();
    } finally {
      await fallbackHandle.close();
    }
  }
}

function nodeKind(info: Awaited<ReturnType<typeof stat>>): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function direntKind(info: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

function resolveAbsoluteRequestPath(path: string): string {
  if (!isAbsolute(path)) {
    throw createFileSystemError({
      code: "invalid_path",
      path,
      message: `FileSystemPort requires an absolute path: ${path}`,
    });
  }
  return normalize(path);
}

function hashBuffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatByteUnit(bytes / 1024)}KB`;
  return `${formatByteUnit(bytes / (1024 * 1024))}MB`;
}

function formatByteUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function toFileSystemError(error: unknown, path: string): Error {
  if (error instanceof Error && error.name === "FileSystemPortError") {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    // Preserve cancellation as its own code so tools do not report user aborts as I/O failures.
    return createFileSystemError({
      code: "cancelled",
      path,
      message: `File system operation was cancelled: ${path}`,
      cause: error,
    });
  }

  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return createFileSystemError({
      code: "not_found",
      path,
      message: `File not found: ${path}`,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message: `Permission denied for path: ${path}`,
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return createFileSystemError({
      code: "is_directory",
      path,
      message: `Path is a directory: ${path}`,
      cause: error,
    });
  }
  if (code === "ENAMETOOLONG") {
    return createFileSystemError({
      code: "invalid_path",
      path,
      message: `Invalid path: ${path}`,
      cause: error,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : `File system error for path: ${path}`,
    cause: error,
  });
}

interface FileSearchCandidate {
  path: string;
  mtimeMs: number;
}

interface TextSearchResult {
  matchCount: number;
  entries: FileSystemSearchTextEntry[];
}

interface LineRange {
  start: number;
  end: number;
}

interface OnlyMatchingMatches {
  matchCount: number;
  ranges: LineRange[];
  entriesByLine: Map<number, FileSystemSearchTextEntry[]>;
}

interface RipgrepSearchPlan {
  args: RgArg[];
  outputRoot: string;
  preopens: Record<string, string>;
}

interface ParsedTextSearch {
  entries: FileSystemSearchTextEntry[];
  files: string[];
  numMatches: number;
}

interface FinishTextSearchParams {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  startedAt: number;
  request: FileSystemSearchTextRequest;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
}

class RipgrepRuntimeFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Bundled ripgrep WASM failed to run");
    this.name = "RipgrepRuntimeFailure";
    this.cause = cause;
  }
}

class RipgrepTimeoutFailure extends Error {
  constructor(timeoutMs: number) {
    super(
      `ripgrep search timed out after ${timeoutMs}ms. The search was terminated before it completed.`,
    );
    this.name = "RipgrepTimeoutFailure";
  }
}

function createRipgrepSearchPlan(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  mode: FileSystemTextSearchOutputMode,
): RipgrepSearchPlan {
  const outputRoot = rootInfo.isDirectory() ? path : dirname(path);
  const target = rootInfo.isDirectory() ? "." : basename(path);
  const args: RgArg[] = [
    "--no-config",
    "--hidden",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--max-columns",
    "500",
  ];

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`, "--glob", `!**/${dir}/**`);
  }

  if (request.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  if (request.ignoreCase) {
    args.push("-i");
  }

  if (mode === "content") {
    args.push("--json");
    if (request.onlyMatching) {
      args.push("--only-matching");
    }
    addRipgrepContextArgs(args, request);
  } else {
    args.push("-c");
  }

  if (request.glob) {
    addRipgrepGlobArgs(args, request.glob);
  }
  if (request.type) {
    addRipgrepTypeArgs(args, request.type);
  }

  args.push("-e", request.pattern.trim(), "--", target);

  return {
    args,
    outputRoot,
    preopens: { ".": outputRoot },
  };
}

function addRipgrepContextArgs(args: RgArg[], request: FileSystemSearchTextRequest): void {
  if (request.context !== undefined) {
    args.push("-C", String(request.context));
    return;
  }
  if (request.beforeContext !== undefined) {
    args.push("-B", String(request.beforeContext));
  }
  if (request.afterContext !== undefined) {
    args.push("-A", String(request.afterContext));
  }
}

function addRipgrepGlobArgs(args: RgArg[], glob: string): void {
  for (const pattern of splitRipgrepGlobPatterns(glob)) {
    args.push("--glob", pattern);
  }
}

function splitRipgrepGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const rawPattern of glob.split(/\s+/)) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      patterns.push(rawPattern);
      continue;
    }
    patterns.push(...rawPattern.split(","));
  }
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}

function addRipgrepTypeArgs(args: RgArg[], type: string): void {
  for (const pattern of fileTypeGlobPatterns(type)) {
    args.push("--glob", pattern);
  }
}

function fileTypeGlobPatterns(type: string): string[] {
  const normalized = normalizeFileType(type);
  if (!/^[a-z0-9_+-]+$/i.test(normalized)) return [];
  const extensions = TYPE_EXTENSION_MAP[normalized] ?? [`.${normalized}`];
  return extensions.flatMap((extension) => [`*${extension}`, `**/*${extension}`]);
}

function normalizeFileType(type: string): string {
  return type.toLowerCase().replace(/^\./, "");
}

async function runBundledRipgrep(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal } = {},
): Promise<RipgrepBufferedResult> {
  try {
    return await runBundledRipgrepWorker(args, preopens, {
      signal: options.signal,
      timeoutMs: ripgrepTimeoutMsForTests ?? DEFAULT_RIPGREP_TIMEOUT_MS,
    });
  } catch (error) {
    if (isAbortError(error) || error instanceof RipgrepTimeoutFailure) {
      throw error;
    }
    throw new RipgrepRuntimeFailure(error);
  }
}

function runBundledRipgrepWorker(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<RipgrepBufferedResult> {
  if (options.signal?.aborted) {
    return Promise.reject(createAbortError("ripgrep search was cancelled before it started"));
  }

  // 不能在 agent 主线程里直接运行 WASI ripgrep。大目录搜索会占住 Node
  // event loop，导致 session/stop 虽然绕过协议队列，却没有机会被 agent 处理。
  // 放到 Worker 后，用户 stop 和超时都能从主线程 terminate 这个搜索执行单元。
  const worker = createRipgrepWorker({
    args: args.map(String),
    preopens,
  });

  return new Promise<RipgrepBufferedResult>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const terminateWorker = (): void => {
      const termination = worker.terminate();
      if (typeof termination === "object" && termination !== null && "catch" in termination) {
        void termination.catch(() => undefined);
      }
    };

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const settle = (settler: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settler();
    };

    const handleAbort = (): void => {
      terminateWorker();
      settle(() => reject(createAbortError("ripgrep search was cancelled")));
    };

    options.signal?.addEventListener("abort", handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      terminateWorker();
      settle(() => reject(new RipgrepTimeoutFailure(options.timeoutMs)));
    }, options.timeoutMs);

    worker.once("message", (message: unknown) => {
      settle(() => {
        const parsed = message as Partial<RipgrepWorkerMessage>;
        if (parsed.type === "result" && parsed.result) {
          resolve(parsed.result);
          return;
        }
        if (parsed.type === "error") {
          reject(deserializeWorkerError(parsed.error));
          return;
        }
        reject(new Error("ripgrep worker returned an unknown message"));
      });
    });

    worker.once("error", (error: Error) => {
      settle(() => reject(error));
    });

    worker.once("exit", (code: number) => {
      if (settled) return;
      settle(() => reject(new Error(`ripgrep worker exited before returning a result: ${code}`)));
    });
  });
}

function createRipgrepWorker(workerData: RipgrepWorkerData): RipgrepWorker {
  return (
    ripgrepWorkerFactoryForTests?.(workerData) ??
    new Worker(RIPGREP_WORKER_SOURCE, {
      eval: true,
      workerData,
    })
  );
}

function deserializeWorkerError(serialized: SerializedWorkerError | undefined): Error {
  const error = new Error(serialized?.message ?? "ripgrep worker failed");
  error.name = serialized?.name ?? "Error";
  if (serialized?.stack) {
    error.stack = serialized.stack;
  }
  if (serialized && "code" in serialized) {
    Object.assign(error, { code: serialized.code });
  }
  return error;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseRipgrepJsonOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const event = parseRipgrepJsonEvent(line, request.path);
    if (event.type !== "match" && event.type !== "context") continue;

    const rawPath = event.data?.path?.text;
    if (!rawPath) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    const matched = event.type === "match";
    if (matched) {
      files.add(path);
      numMatches += 1;
    }

    if (request.onlyMatching && matched) {
      const submatches = event.data?.submatches ?? [];
      if (submatches.length > 0) {
        const lineNumber =
          typeof event.data?.line_number === "number" ? event.data.line_number : undefined;
        for (const submatch of submatches) {
          entries.push(...createOnlyMatchingEntries({
            path,
            text: submatch.match?.text ?? "",
            lineNumber,
          }));
        }
        continue;
      }
    }

    entries.push({
      path,
      lineNumber: typeof event.data?.line_number === "number" ? event.data.line_number : undefined,
      text: stripTrailingLineEnding(event.data?.lines?.text ?? ""),
      matched,
    });
  }

  return { entries, files: [...files], numMatches };
}

function parseRipgrepCountOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const separatorIndex = line.lastIndexOf(":");
    if (separatorIndex <= 0) continue;

    const rawPath = line.slice(0, separatorIndex);
    const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
    if (!Number.isFinite(count) || count <= 0) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    files.add(path);
    numMatches += count;
    entries.push({ path, count });
  }

  return { entries, files: [...files], numMatches };
}

function finishTextSearchResult(params: FinishTextSearchParams): FileSystemSearchTextResult {
  if (params.mode === "files_with_matches") {
    const limited = applyHeadLimit(params.files, params.request.headLimit, params.request.offset);
    return {
      path: params.path,
      pattern: params.pattern,
      mode: params.mode,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      files: limited.items,
      entries: [],
      numMatches: params.numMatches,
      truncated: limited.truncated,
      appliedLimit: limited.appliedLimit,
      appliedOffset: limited.appliedOffset,
    };
  }

  const limited = applyHeadLimit(params.entries, params.request.headLimit, params.request.offset);
  return {
    path: params.path,
    pattern: params.pattern,
    mode: params.mode,
    durationMs: Math.max(0, Date.now() - params.startedAt),
    files: params.files,
    entries: limited.items,
    numMatches: params.numMatches,
    truncated: limited.truncated,
    appliedLimit: limited.appliedLimit,
    appliedOffset: limited.appliedOffset,
  };
}

async function sortPathsByMtime(paths: string[]): Promise<string[]> {
  const withStats = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        const info = await stat(path);
        return { path, mtimeMs: Number(info.mtimeMs) };
      } catch {
        return { path, mtimeMs: 0 };
      }
    }),
  );

  withStats.sort((left, right) => {
    const timeComparison = right.mtimeMs - left.mtimeMs;
    return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
  });
  return withStats.map((item) => item.path);
}

function splitOutputLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    submatches?: Array<{ match?: { text?: string } }>;
    line_number?: number;
  };
}

function parseRipgrepJsonEvent(line: string, path: string): RipgrepJsonEvent {
  try {
    return JSON.parse(line) as RipgrepJsonEvent;
  } catch (error) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: "Failed to parse ripgrep JSON output",
      cause: error,
    });
  }
}

function createTextResultFilter(
  root: string,
  request: FileSystemSearchTextRequest,
): (path: string) => boolean {
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;

  return (path) => {
    const relativePath = toPosixRelative(root, path);
    if (globMatcher && !globMatcher(relativePath, basename(path))) return false;
    if (request.type && !matchesFileType(path, request.type)) return false;
    return true;
  };
}

function resolveRipgrepOutputPath(root: string, rawPath: string): string {
  if (isAbsolute(rawPath)) return normalize(rawPath);
  const withoutLeadingDot = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  return normalize(join(root, withoutLeadingDot));
}

function stripTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function toRipgrepFileSystemError(stderr: string, path: string, pattern: string): Error {
  const message = stderr.trim() || `ripgrep failed while searching ${path}`;
  const normalized = message.toLowerCase();

  if (
    normalized.includes("regex parse error") ||
    normalized.includes("error parsing regex") ||
    normalized.includes("unclosed")
  ) {
    return createFileSystemError({
      code: "invalid_pattern",
      path,
      message: `Invalid grep regular expression: ${pattern}`,
    });
  }

  if (normalized.includes("permission denied") || normalized.includes("os error 13")) {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message,
    });
  }

  if (normalized.includes("no such file") || normalized.includes("os error 2")) {
    return createFileSystemError({
      code: "not_found",
      path,
      message,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message,
  });
}

function compileSearchRegex(pattern: string, request: FileSystemSearchTextRequest): RegExp {
  try {
    const flags = `${request.ignoreCase ? "i" : ""}${request.multiline ? "s" : ""}`;
    return new RegExp(pattern, flags);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path: request.path,
      message: `Invalid grep regular expression: ${pattern}`,
      cause: error,
    });
  }
}

async function collectTextSearchCandidates(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const candidates: FileSearchCandidate[] = [];
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;
  const root = rootInfo.isDirectory() ? path : dirname(path);

  const addIfCandidate = async (filePath: string, info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) return;
    const relativePath = toPosixRelative(root, filePath);
    if (globMatcher && !globMatcher(relativePath, basename(filePath))) return;
    if (request.type && !matchesFileType(filePath, request.type)) return;
    candidates.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
  };

  if (rootInfo.isFile()) {
    await addIfCandidate(path, rootInfo);
    return candidates;
  }

  if (!rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  await walkFiles(root, signal, addIfCandidate);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return candidates;
}

function searchLineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);

  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectLineOnlyMatchingMatches(path, lines, regex),
    });
  }

  const matchingIndexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[index] ?? "")) {
      matchingIndexes.push(index);
    }
  }

  const ranges = matchingIndexes.map((index) => ({ start: index, end: index }));
  const matchedLineIndexes = new Set(matchingIndexes);
  const entries = createContextLineIndexes(lines.length, ranges, request).map((lineIndex) => ({
    path,
    lineNumber: lineIndex + 1,
    text: lines[lineIndex] ?? "",
    matched: matchedLineIndexes.has(lineIndex),
  }));

  return {
    matchCount: matchingIndexes.length,
    entries,
  };
}

function searchMultilineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);
  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectMultilineOnlyMatchingMatches(path, content, regex),
    });
  }

  const flags = `${regex.ignoreCase ? "i" : ""}gs`;
  const globalRegex = new RegExp(regex.source, flags);
  const entries: FileSystemSearchTextEntry[] = [];
  let matchCount = 0;

  for (const match of content.matchAll(globalRegex)) {
    const index = match.index ?? 0;
    const lineNumber = lineNumberForIndex(content, index);
    const text = firstLine(match[0]);
    entries.push({
      path,
      lineNumber,
      text,
      matched: true,
    });
    matchCount += 1;
  }

  return { matchCount, entries };
}

function collectLineOnlyMatchingMatches(
  path: string,
  lines: string[],
  regex: RegExp,
): OnlyMatchingMatches {
  const entriesByLine = new Map<number, FileSystemSearchTextEntry[]>();
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}g`);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const entries: FileSystemSearchTextEntry[] = [];
    globalRegex.lastIndex = 0;
    for (const match of line.matchAll(globalRegex)) {
      entries.push(
        ...createOnlyMatchingEntries({
          path,
          lineNumber: lineIndex + 1,
          text: match[0],
        }),
      );
    }
    if (entries.length > 0) {
      entriesByLine.set(lineIndex, entries);
    }
  }

  return {
    matchCount: entriesByLine.size,
    ranges: Array.from(entriesByLine.keys()).map((lineIndex) => ({
      start: lineIndex,
      end: lineIndex,
    })),
    entriesByLine,
  };
}

function collectMultilineOnlyMatchingMatches(
  path: string,
  content: string,
  regex: RegExp,
): OnlyMatchingMatches {
  const matches: OnlyMatchingMatches = {
    matchCount: 0,
    ranges: [],
    entriesByLine: new Map(),
  };
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}gs`);

  for (const match of content.matchAll(globalRegex)) {
    const matchIndex = match.index ?? 0;
    const startLineNumber = lineNumberForIndex(content, matchIndex);
    const entries = createOnlyMatchingEntries({
      path,
      lineNumber: startLineNumber,
      text: match[0],
    });
    for (const entry of entries) {
      const lineIndex = (entry.lineNumber ?? startLineNumber) - 1;
      const existing = matches.entriesByLine.get(lineIndex) ?? [];
      existing.push(entry);
      matches.entriesByLine.set(lineIndex, existing);
    }

    const endIndex = Math.max(matchIndex, matchIndex + match[0].length - 1);
    matches.ranges.push({
      start: startLineNumber - 1,
      end: lineNumberForIndex(content, endIndex) - 1,
    });
    matches.matchCount += 1;
  }

  return matches;
}

function createOnlyMatchingSearchResult(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): TextSearchResult {
  return {
    matchCount: input.matches.matchCount,
    entries: createOnlyMatchingContentEntries(input),
  };
}

function createOnlyMatchingContentEntries(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): FileSystemSearchTextEntry[] {
  const matchedLineIndexes = createMatchedLineIndexes(input.matches.ranges);

  return createContextLineIndexes(input.lines.length, input.matches.ranges, input.request)
    .flatMap((lineIndex) => {
      const matchedEntries = input.matches.entriesByLine.get(lineIndex);
      if (matchedEntries) return matchedEntries;
      if (matchedLineIndexes.has(lineIndex)) return [];
      return [
        {
          path: input.path,
          lineNumber: lineIndex + 1,
          text: input.lines[lineIndex] ?? "",
          matched: false,
        },
      ];
    });
}

function createContextLineIndexes(
  lineCount: number,
  ranges: LineRange[],
  request: FileSystemSearchTextRequest,
): number[] {
  const context = request.context ?? 0;
  const beforeContext = request.beforeContext ?? context;
  const afterContext = request.afterContext ?? context;
  const indexes = new Set<number>();

  for (const range of ranges) {
    const start = Math.max(0, range.start - beforeContext);
    const end = Math.min(lineCount - 1, range.end + afterContext);
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

function createMatchedLineIndexes(ranges: LineRange[]): Set<number> {
  const indexes = new Set<number>();
  for (const range of ranges) {
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }
  return indexes;
}

function createOnlyMatchingEntries(input: {
  path: string;
  lineNumber?: number;
  text: string;
}): FileSystemSearchTextEntry[] {
  if (input.text.length === 0) {
    return [
      {
        path: input.path,
        lineNumber: input.lineNumber,
        text: "",
        matched: true,
      },
    ];
  }

  // ripgrep 只把 LF/CRLF 当作输出行边界；单独的 CR 是普通匹配文本。
  // 同时，跨行 match 内部的空行不生成 entry，但整段零长度 match 需要保留空 entry。
  return input.text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      line.length === 0
        ? []
        : [
            {
              path: input.path,
              lineNumber:
                input.lineNumber === undefined ? undefined : input.lineNumber + index,
              text: line,
              matched: true,
            },
          ],
    );
}

function splitRipgrepSearchLines(content: string): string[] {
  // ripgrep 以 LF/CRLF 作为行结束符；末尾换行不是额外空行，单独的 CR 保留在行内容中。
  if (content.length === 0) return [];
  return content.replace(/\r?\n$/, "").split(/\r?\n/);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function lineNumberForIndex(content: string, index: number): number {
  let lineNumber = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}

async function walkFiles(
  current: string,
  signal: AbortSignal | undefined,
  visitor: (path: string, info: Awaited<ReturnType<typeof stat>>) => Promise<void> | void,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    throwIfAborted(signal);
    const childPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (VCS_DIRECTORIES_TO_EXCLUDE.has(entry.name)) continue;
      await walkFiles(childPath, signal, visitor);
      continue;
    }

    if (!entry.isFile()) continue;

    const info = await stat(childPath);
    await visitor(childPath, info);
  }
}

function createGlobMatcher(pattern: string): (relativePath: string, fileName: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  const regex = globPatternToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : globPatternToRegExp(normalized);

  return (relativePath, fileName) =>
    regex.test(relativePath) || (basenameRegex ? basenameRegex.test(fileName) : false);
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        regex += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }

    regex += escapeRegExp(char ?? "");
  }

  regex += "$";
  try {
    return new RegExp(regex);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      message: `Invalid glob pattern: ${pattern}`,
      cause: error,
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function toPosixRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function applyHeadLimit<T>(
  items: T[],
  headLimit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number; appliedOffset?: number; truncated: boolean } {
  if (headLimit === 0) {
    return {
      items: items.slice(offset),
      appliedOffset: offset > 0 ? offset : undefined,
      truncated: false,
    };
  }

  const effectiveLimit = headLimit ?? DEFAULT_GREP_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const truncated = items.length - offset > effectiveLimit;

  return {
    items: sliced,
    appliedLimit: truncated ? effectiveLimit : undefined,
    appliedOffset: offset > 0 ? offset : undefined,
    truncated,
  };
}

function looksBinary(content: string): boolean {
  return content.includes("\0");
}

function matchesFileType(path: string, type: string): boolean {
  const normalized = type.toLowerCase().replace(/^\./, "");
  const extension = extname(path).toLowerCase();
  const known = TYPE_EXTENSION_MAP[normalized];
  if (known) {
    return known.includes(extension);
  }
  return extension === `.${normalized}`;
}

const TYPE_EXTENSION_MAP: Record<string, string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
  csharp: [".cs"],
  css: [".css"],
  go: [".go"],
  html: [".html", ".htm"],
  java: [".java"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  json: [".json", ".jsonc"],
  markdown: [".md", ".markdown"],
  md: [".md", ".markdown"],
  py: [".py"],
  python: [".py"],
  rs: [".rs"],
  rust: [".rs"],
  sh: [".sh", ".bash", ".zsh"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  tsx: [".tsx"],
  txt: [".txt"],
  yaml: [".yaml", ".yml"],
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled");
  error.name = "AbortError";
  throw error;
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSystemError,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  modelMessageContentToText,
  type FileSystemLineEndings,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemRevision,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextResult,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type ModelMessageContent,
  type PermissionRuleset,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { writeHandler, writeToolEntry } from "../src/tool/handlers/write.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";

const RUN_WRITE_STRICT_CONTRACT = process.env.ZCODE_RUN_WRITE_STRICT_CONTRACT === "1";
const describeWriteStrictContract = RUN_WRITE_STRICT_CONTRACT ? describe : describe.skip;
const WRITE_STORAGE_SUFFIX =
  " (file state is current in your context \u2014 no need to Read it back)";
const WRITE_USER_MODIFIED_NOTE = " The user modified your proposed content before accepting it.";
const WRITE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
const WRITE_STALE_MESSAGE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "zcode-write-contract-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Write model-result harness", () => {
  it("returns executor modelContent and serialization for create results", async () => {
    const file = join(tmpDir, "nested", "created.txt");
    const fs = createMemoryFileSystem({});

    const result = await executeWrite(
      {
        file_path: file,
        content: "alpha\nbeta\n",
      },
      fs,
    );

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      type: "create",
      filePath: file,
      content: "alpha\nbeta\n",
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    });
    expect(asModelText(result.modelContent)).toBe(
      `File created successfully at: ${file}${WRITE_STORAGE_SUFFIX}`,
    );
    expect(result.serialization?.content).toBe(
      `File created successfully at: ${file}${WRITE_STORAGE_SUFFIX}`,
    );
    expect(fs.files.get(file)).toBe("alpha\nbeta\n");
    expect(fs.readPaths).toEqual([file]);
  });

  it("documents update model content for existing nonempty files", async () => {
    const file = join(tmpDir, "existing.txt");
    const fs = createMemoryFileSystem({
      [file]: "old line\nkept line\n",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "old line\nkept line\n"),
    });

    const result = await writeForModel(
      {
        file_path: file,
        content: "new line\nkept line\n",
      },
      context,
    );

    expect(result.output).toMatchObject({
      type: "update",
      filePath: file,
      content: "new line\nkept line\n",
      originalFile: "old line\nkept line\n",
      userModified: false,
    });
    expect(result.output.structuredPatch[0]?.lines).toContain("-old line");
    expect(result.output.structuredPatch[0]?.lines).toContain("+new line");
    expect(asModelText(result.modelContent)).toBe(
      `The file ${file} has been updated successfully.${WRITE_STORAGE_SUFFIX}`,
    );
    expect(fs.files.get(file)).toBe("new line\nkept line\n");
  });

  it("adds Write performance attribution without exposing file content", async () => {
    const file = join(tmpDir, "perf-existing.txt");
    const fs = createMemoryFileSystem({
      [file]: "old line\n",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "old line\n"),
    });

    const result = await writeForModel(
      {
        file_path: file,
        content: "new line\nextra\n",
      },
      context,
    );

    expect(result.output).toMatchObject({
      type: "update",
      perf: {
        detail: {
          kind: "filesystem",
          filesystem: {
            readMs: expect.any(Number),
            writeMs: expect.any(Number),
            fileCount: 1,
            totalBytes: Buffer.byteLength("new line\nextra\n", "utf8"),
            maxFileBytes: Buffer.byteLength("new line\nextra\n", "utf8"),
            workspaceKind: "local",
          },
        },
      },
    });
    expect(JSON.stringify((result.output as any).perf)).not.toContain(file);
    expect(JSON.stringify((result.output as any).perf)).not.toContain("new line");
  });

  it("accepts a normalized read-state key when the stored display path differs", async () => {
    const file = join(tmpDir, "existing-normalized-key.txt");
    const fs = createMemoryFileSystem({
      [file]: "old line\n",
    });
    const revision = revisionFor(file, "old line\n");
    const readFileState: ReadFileStateMap = new Map([
      [
        createReadFileStatePathKey(file),
        {
          path: `${tmpDir}/nested/../existing-normalized-key.txt`,
          content: "old line\n",
          offset: 1,
          limit: undefined,
          isPartialView: false,
          readAt: new Date(),
          revisionId: revision.id,
          mtimeMs: revision.mtimeMs,
          sizeBytes: revision.sizeBytes,
        },
      ],
    ]);
    const context = contextWith(fs, { readFileState });

    const result = await writeForModel(
      {
        file_path: file,
        content: "new line\n",
      },
      context,
    );

    expect(result.output).toMatchObject({
      type: "update",
      filePath: file,
      content: "new line\n",
    });
    expect(fs.files.get(file)).toBe("new line\n");
  });

  it("allows writes after an unchanged range Read in the same runtime", async () => {
    const file = join(tmpDir, "same-runtime-range-read.txt");
    const fs = createMemoryFileSystem({
      [file]: "line one\nline two\n",
    });
    const readFileState = createReadFileState(file, "line two\n", {
      limit: 1,
      offset: 2,
      revisionContent: "line one\nline two\n",
    });

    await expect(
      writeForModel(
        {
          file_path: file,
          content: "replacement\n",
        },
        contextWith(fs, { readFileState }),
      ),
    ).resolves.toMatchObject({
      output: {
        filePath: file,
        originalFile: "line one\nline two\n",
        type: "update",
      },
    });
  });

  it("allows writes after an unchanged offset-1 full Read when only mtime advances", async () => {
    const file = join(tmpDir, "mtime-offset-one-write.txt");
    const fs = createMemoryFileSystem({
      [file]: "same content\n",
    });
    const readFileState = createReadFileState(file, "same content\n", {
      offset: 1,
      mtimeMs: 1,
    });
    fs.setMtime(file, 2);

    await expect(
      writeForModel(
        {
          file_path: file,
          content: "replacement\n",
        },
        contextWith(fs, { readFileState }),
      ),
    ).resolves.toMatchObject({
      output: {
        filePath: file,
        originalFile: "same content\n",
        type: "update",
      },
    });
  });

  it("rejects writes when content changes inside the same millisecond", async () => {
    const file = join(tmpDir, "same-ms-content-change-default.txt");
    const fs = createMemoryFileSystem({
      [file]: "before",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "before", { mtimeMs: 1000.2 }),
    });
    fs.files.set(file, "after!");
    fs.setMtime(file, 1000.8);

    await expect(
      writeHandler(
        {
          file_path: file,
          content: "replacement",
        },
        context,
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 3,
      message: WRITE_STALE_MESSAGE,
    });
  });

  it("rejects writes from a token-truncated partial view", async () => {
    const file = join(tmpDir, "partial-view-write.txt");
    const fs = createMemoryFileSystem({
      [file]: "full content\n",
    });

    await expect(
      writeHandler(
        {
          file_path: file,
          content: "replacement\n",
        },
        contextWith(fs, {
          readFileState: createReadFileState(file, "full", {
            isPartialView: true,
            revisionContent: "full content\n",
          }),
        }),
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 2,
      message: WRITE_NOT_READ_MESSAGE,
    });
  });

  // 截断注入的 MEMORY.md 也用“没读过”：Edit 同样要求先完整读过，不能提示“改用 Edit”（02-write.md）。
  it("treats a truncated MEMORY.md seeded from context as not read", async () => {
    const file = join(tmpDir, "MEMORY.md");
    const fs = createMemoryFileSystem({
      [file]: "full index\n",
    });
    const readFileState = createReadFileState(file, "full index\n", { isPartialView: true });
    const entry = readFileState.get(createReadFileStatePathKey(file));
    if (entry) entry.seededFromContext = true;

    await expect(
      writeHandler(
        { file_path: file, content: "replacement\n" },
        contextWith(fs, { readFileState }),
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 2,
      message: WRITE_NOT_READ_MESSAGE,
    });
    expect(fs.files.get(file)).toBe("full index\n");
  });

  it("wraps an unread-file failure for the model and keeps the raw message for the UI", async () => {
    const file = join(tmpDir, "unread-executor.txt");
    const fs = createMemoryFileSystem({
      [file]: "existing",
    });

    const result = await executeWrite({ file_path: file, content: "replacement" }, fs);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(WRITE_NOT_READ_MESSAGE);
    expect(result.error?.code).toBe("2");
    expect(result.modelContent).toBe(`<tool_use_error>${WRITE_NOT_READ_MESSAGE}</tool_use_error>`);
    expect(fs.files.get(file)).toBe("existing");
  });

  it.each([
    [
      "is_directory",
      17,
      (path: string) =>
        `${path} is a directory, not a file. To create a file inside it, include the file name in file_path.`,
    ],
    [
      "not_file",
      18,
      (path: string) =>
        `${path} exists but is not a regular file (a device, FIFO or socket). Write only creates or overwrites regular files.`,
    ],
  ] as const)("names a %s target in the model's file_path", async (code, errorCode, message) => {
    const fs = createMemoryFileSystem({});
    fs.readTextFile = async (request) => {
      throw createFileSystemError({ code, path: request.path, message: `fs: ${request.path}` });
    };

    await expect(
      writeHandler(
        { file_path: "target", content: "x" },
        contextWith(fs, { workingDirectory: tmpDir, workspaceRoot: tmpDir }),
      ),
    ).resolves.toEqual({ result: false, errorCode, message: message("target") });
    expect(fs.lastWrite).toBeUndefined();
  });

  it("documents existing-empty-file behavior as create", async () => {
    const file = join(tmpDir, "empty-existing.txt");
    const fs = createMemoryFileSystem({
      [file]: "",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, ""),
    });

    const result = await writeForModel(
      {
        file_path: file,
        content: "now filled\n",
      },
      context,
    );

    expect(fs.files.get(file)).toBe("now filled\n");
    expect(result.output).toEqual({
      type: "create",
      filePath: file,
      content: "now filled\n",
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    });
    expect(asModelText(result.modelContent)).toBe(
      `File created successfully at: ${file}${WRITE_STORAGE_SUFFIX}`,
    );
  });

  it("documents relative path output as the original input path", async () => {
    const fs = createMemoryFileSystem({});

    const result = await writeForModel(
      {
        file_path: "relative-created.txt",
        content: "relative content",
      },
      contextWith(fs, {
        workingDirectory: tmpDir,
        workspaceRoot: tmpDir,
      }),
    );

    const absolutePath = join(tmpDir, "relative-created.txt");
    expect(result.output).toEqual({
      type: "create",
      filePath: "relative-created.txt",
      content: "relative content",
      structuredPatch: [],
      originalFile: null,
      userModified: false,
    });
    expect(asModelText(result.modelContent)).toBe(
      `File created successfully at: relative-created.txt${WRITE_STORAGE_SUFFIX}`,
    );
    expect(fs.files.get(absolutePath)).toBe("relative content");
  });

  it("documents current update writes preserving the old file line-ending style", async () => {
    const file = join(tmpDir, "line-endings-update.txt");
    const fs = createMemoryFileSystem({
      [file]: "first\r\nsecond\r\n",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "first\r\nsecond\r\n"),
    });

    const result = await writeForModel(
      {
        file_path: file,
        content: "first\nchanged\n",
      },
      context,
    );

    expect(result.output).toMatchObject({
      type: "update",
      originalFile: "first\nsecond\n",
      content: "first\nchanged\n",
    });
    expect(fs.lastWrite?.lineEndings).toBe("CRLF");
    expect(fs.files.get(file)).toBe("first\r\nchanged\r\n");
  });
});

describeWriteStrictContract("Write strict model-result contract", () => {
  it("returns an update result even when a nonempty overwrite is a no-op", async () => {
    const file = join(tmpDir, "same-content.txt");
    const fs = createMemoryFileSystem({
      [file]: "same\ncontent\n",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "same\ncontent\n"),
    });

    const result = await writeForModel(
      {
        file_path: file,
        content: "same\ncontent\n",
      },
      context,
    );

    expect(fs.files.get(file)).toBe("same\ncontent\n");
    expect(result.output).toMatchObject({
      type: "update",
      filePath: file,
      content: "same\ncontent\n",
      originalFile: "same\ncontent\n",
      userModified: false,
    });
    expect(asModelText(result.modelContent)).toBe(
      `The file ${file} has been updated successfully.${WRITE_STORAGE_SUFFIX}`,
    );
  });

  it("uses the user-modified note instead of the storage freshness suffix", () => {
    expect(
      asModelText(
        formatWriteModelContent({
          type: "create",
          filePath: "/work/user-edited.txt",
          content: "edited",
          structuredPatch: [],
          originalFile: null,
          userModified: true,
        }),
      ),
    ).toBe(`File created successfully at: /work/user-edited.txt${WRITE_USER_MODIFIED_NOTE}`);

    expect(
      asModelText(
        formatWriteModelContent({
          type: "update",
          filePath: "/work/user-edited.txt",
          content: "edited",
          structuredPatch: [],
          originalFile: "old",
          userModified: true,
        }),
      ),
    ).toBe(
      `The file /work/user-edited.txt has been updated successfully.${WRITE_USER_MODIFIED_NOTE}`,
    );
  });

  it("preserves explicit CRLF content when creating a file", async () => {
    const file = join(tmpDir, "line-endings.txt");
    const fs = createMemoryFileSystem({});

    const result = await writeForModel(
      {
        file_path: file,
        content: "first\r\nsecond\r\n",
      },
      contextWith(fs),
    );

    expect(fs.files.get(file)).toBe("first\r\nsecond\r\n");
    expect(result.output).toMatchObject({
      type: "create",
      content: "first\r\nsecond\r\n",
    });
  });

  it("requires an existing file to be read before writing", async () => {
    const file = join(tmpDir, "unread.txt");
    const fs = createMemoryFileSystem({
      [file]: "existing",
    });

    await expect(
      writeHandler(
        {
          file_path: file,
          content: "replacement",
        },
        contextWith(fs),
      ),
    ).resolves.toEqual({ result: false, errorCode: 2, message: WRITE_NOT_READ_MESSAGE });
  });

  it("rejects writes when the file has changed since the cached read", async () => {
    const file = join(tmpDir, "stale.txt");
    const fs = createMemoryFileSystem({
      [file]: "before",
    });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "before"),
    });
    fs.files.set(file, "after");

    await expect(
      writeHandler(
        {
          file_path: file,
          content: "replacement",
        },
        context,
      ),
    ).resolves.toEqual({ result: false, errorCode: 3, message: WRITE_STALE_MESSAGE });
  });

  it("allows writes when unchanged content only drifts inside the same millisecond", async () => {
    const file = join(tmpDir, "mtime-sub-ms-write.txt");
    const fs = createMemoryFileSystem({
      [file]: "before",
    });
    fs.setMtime(file, 1000.8);
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "before", { mtimeMs: 1000.2 }),
    });

    await expect(
      writeForModel(
        {
          file_path: file,
          content: "replacement",
        },
        context,
      ),
    ).resolves.toMatchObject({
      output: {
        type: "update",
        filePath: file,
        originalFile: "before",
      },
    });
  });

  it("honors Edit deny rules before filesystem access", () => {
    const service = new PermissionService(defaultPermissionConfig);
    const file = join(tmpDir, "blocked", "secret.txt");
    const projectRules: PermissionRuleset = {
      version: 1,
      deny: [
        {
          toolName: "Edit",
          ruleContent: `${tmpDir}/blocked/*`,
        },
      ],
    };

    const decision = service.checkPermission(
      {
        input: {
          file_path: file,
          content: "secret",
        },
        mode: "edit",
        riskLevel: writeToolEntry.metadata.riskLevel,
        toolName: "Write",
      },
      {
        ...writeToolEntry.metadata,
        permission: writeToolEntry.permission,
      },
      projectRules,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
    });
  });
});

async function writeForModel(input: unknown, context: ToolExecutionContext) {
  const output = await writeHandler(input, context);
  return {
    output,
    modelContent: formatWriteModelContent(output),
  };
}

function formatWriteModelContent(output: unknown): ModelMessageContent {
  const modelContent = writeToolEntry.formatModelContent?.(output);
  if (modelContent === undefined) {
    throw new Error("Write tool is missing formatModelContent");
  }
  return modelContent;
}

function asModelText(content: ModelMessageContent | undefined): string {
  if (content === undefined) {
    throw new Error("Missing model content");
  }
  return modelMessageContentToText(content);
}

async function executeWrite(input: unknown, fileSystemPort: FileSystemPort) {
  const sessionId = createSessionId("write-contract");
  const turnId = createTurnId("write-contract");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(writeToolEntry);

  return createToolExecutor({
    emitEvent: async () => {},
    fileSystemPort,
    mode: "edit",
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    traceContext,
    turnId,
    workingDirectory: tmpDir,
    workspaceRoot: tmpDir,
  }).execute(
    {
      id: createToolCallId("write-contract"),
      input,
      name: "Write",
    },
    { traceContext },
  );
}

function contextWith(
  fileSystemPort: FileSystemPort,
  options: {
    readFileState?: ReadFileStateMap;
    workingDirectory?: string;
    workspaceRoot?: string;
  } = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    spanId: "span_test",
    abortSignal: new AbortController().signal,
    fileSystemPort,
    readFileState: options.readFileState,
    workingDirectory: options.workingDirectory ?? tmpDir,
    workspaceRoot: options.workspaceRoot ?? tmpDir,
    sessionId: "sess_test",
    turnId: "turn_test",
  };
}

function createReadFileState(
  filePath: string,
  content: string,
  options: {
    isPartialView?: boolean;
    limit?: number;
    mtimeMs?: number;
    offset?: number;
    readAt?: Date;
    revisionContent?: string;
  } = {},
): ReadFileStateMap {
  const revisionContent = options.revisionContent ?? content;
  const revision = revisionFor(filePath, revisionContent, options.mtimeMs ?? 1);
  return new Map([
    [
      createReadFileStatePathKey(filePath),
      {
        path: filePath,
        content: normalizeLineEndings(content),
        offset: options.offset,
        limit: options.limit,
        isPartialView: options.isPartialView ?? false,
        readAt: options.readAt ?? new Date(),
        revisionId: revision.id,
        mtimeMs: revision.mtimeMs,
        sizeBytes: revision.sizeBytes,
      },
    ],
  ]);
}

interface MemoryFileSystem extends FileSystemPort {
  files: Map<string, string>;
  lastWrite?: FileSystemWriteTextRequest;
  mtimes: Map<string, number>;
  readPaths: string[];
  setMtime(path: string, mtimeMs: number): void;
}

function createMemoryFileSystem(initial: Record<string, string>): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const mtimes = new Map<string, number>();
  const fs: MemoryFileSystem = {
    files,
    mtimes,
    readPaths: [],
    setMtime(path, mtimeMs) {
      mtimes.set(path, mtimeMs);
    },
    async stat(request): Promise<FileSystemStatResult> {
      const content = files.get(request.path);
      if (content === undefined) throw missingFile(request.path);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      return {
        kind: "file",
        path: request.path,
        mtimeMs,
        revision: revisionFor(request.path, content, mtimeMs),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    },
    async readTextFile(request): Promise<FileSystemReadTextResult> {
      fs.readPaths.push(request.path);
      const content = readTextOrThrow(request.path, files);
      const normalized = normalizeLineEndings(content);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      return {
        bytesRead: Buffer.byteLength(content, "utf8"),
        content: normalized,
        encoding: request.encoding ?? "utf8",
        lineEndings: detectLineEndings(content),
        path: request.path,
        revision: revisionFor(request.path, content, mtimeMs),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
      };
    },
    async readBinaryFile(request) {
      const content = readTextOrThrow(request.path, files);
      const buffer = Buffer.from(content, "utf8");
      return {
        bytesRead: buffer.byteLength,
        content: buffer,
        path: request.path,
        revision: revisionFor(request.path, content, mtimes.get(request.path) ?? 1),
        sizeBytes: buffer.byteLength,
      };
    },
    async readTextFileRange(request): Promise<FileSystemReadTextRangeResult> {
      const content = readTextOrThrow(request.path, files);
      const normalized = normalizeLineEndings(content);
      const lines = normalized.length === 0 ? [] : normalized.split("\n");
      const offsetLine = Math.max(0, Math.trunc(request.offsetLine ?? 0));
      const limitLines =
        request.limitLines === undefined ? undefined : Math.max(0, Math.trunc(request.limitLines));
      const selected =
        limitLines === undefined
          ? lines.slice(offsetLine)
          : lines.slice(offsetLine, offsetLine + limitLines);
      return {
        bytesRead: Buffer.byteLength(content, "utf8"),
        content: selected.join("\n"),
        encoding: request.encoding ?? "utf8",
        lineCount: selected.length,
        lineEndings: detectLineEndings(content),
        path: request.path,
        revision: revisionFor(request.path, content, mtimes.get(request.path) ?? 1),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        startLine: offsetLine + 1,
        totalLines: lines.length,
        truncated: false,
      };
    },
    async writeTextFile(request) {
      const content = applyLineEndings(request.content, request.lineEndings);
      fs.lastWrite = request;
      files.set(request.path, content);
      mtimes.set(request.path, (mtimes.get(request.path) ?? 1) + 1);
      return {
        bytesWritten: Buffer.byteLength(content, "utf8"),
        path: request.path,
        revision: revisionFor(request.path, content, mtimes.get(request.path) ?? 1),
      };
    },
    async removeFile(request) {
      const removed = files.delete(request.path);
      if (!removed && request.missingOk !== true) throw missingFile(request.path);
      return {
        path: request.path,
        removed,
      };
    },
    async listDirectory(request) {
      const prefix = `${request.path.replace(/\/+$/u, "")}/`;
      const entries = Array.from(files.keys())
        .filter((path) => path.startsWith(prefix))
        .map((path) => ({
          kind: "file" as const,
          name: path.slice(prefix.length),
          path,
        }));
      return {
        durationMs: 0,
        entries,
        numEntries: entries.length,
        path: request.path,
      };
    },
    async searchFiles(request): Promise<FileSystemSearchFilesResult> {
      return {
        durationMs: 0,
        files: [],
        numFiles: 0,
        path: request.path,
        pattern: request.pattern,
        truncated: false,
      };
    },
    async searchText(request): Promise<FileSystemSearchTextResult> {
      return {
        durationMs: 0,
        entries: [],
        files: [],
        mode: request.outputMode ?? "files_with_matches",
        numMatches: 0,
        path: request.path,
        pattern: request.pattern,
        truncated: false,
      };
    },
  };
  return fs;
}

function readTextOrThrow(path: string, files: Map<string, string>): string {
  const content = files.get(path);
  if (content === undefined) throw missingFile(path);
  return content;
}

function missingFile(path: string): Error {
  return createFileSystemError({
    code: "not_found",
    message: `missing: ${path}`,
    path,
  });
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

function applyLineEndings(content: string, lineEndings: FileSystemLineEndings | undefined): string {
  if (lineEndings !== "CRLF") return content;
  return content.replaceAll("\r\n", "\n").split("\n").join("\r\n");
}

function detectLineEndings(content: string): "LF" | "CRLF" {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") crlfCount += 1;
    else lfCount += 1;
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

function revisionFor(path: string, content: string, mtimeMs = 1): FileSystemRevision {
  return {
    id: `rev:${path}:${content.length}:${mtimeMs}`,
    mtimeMs,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

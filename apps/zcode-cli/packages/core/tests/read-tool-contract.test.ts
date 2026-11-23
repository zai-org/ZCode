import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoreErrorType,
  READ_MAX_FILE_SIZE_BYTES,
  READ_VIDEO_MAX_INPUT_BYTES,
  createFileSystemError,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  modelMessageContentToText,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemRevision,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextResult,
  type FileSystemStatResult,
  type ImageProcessorPort,
  type ModelMessageContent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import {
  readFileForCompactRestore,
  readHandler,
  readToolEntry,
} from "../src/tool/handlers/read.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";

const RUN_READ_STRICT_CONTRACT = process.env.ZCODE_RUN_READ_STRICT_CONTRACT === "1";
const describeReadStrictContract = RUN_READ_STRICT_CONTRACT ? describe : describe.skip;

const FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "zcode-read-contract-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Read model-result harness", () => {
  it("returns video bytes as one provider-visible video block", async () => {
    const file = join(tmpDir, "demo.mp4");
    const fs = createMemoryFileSystem({
      [file]: "video",
    });

    const result = await readForModel({ file_path: file }, contextWith(fs));

    expect(result.output).toEqual({
      type: "video",
      base64: "dmlkZW8=",
      mimeType: "video/mp4",
      originalSize: 5,
    });
    expect(result.modelContent).toEqual([
      {
        type: "video",
        mediaType: "video/mp4",
        dataUrl: "data:video/mp4;base64,dmlkZW8=",
        source: {
          id: "read-video",
          kind: "inline",
          mimeType: "video/mp4",
          placeholder: "Read video",
          sizeBytes: 5,
        },
      },
    ]);
  });

  it("rejects an empty video before creating provider-visible media", async () => {
    const file = join(tmpDir, "empty.mp4");
    const fs = createMemoryFileSystem({
      [file]: "",
    });

    await expect(readForModel({ file_path: file }, contextWith(fs))).rejects.toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: expect.objectContaining({ code: "read_video_input_empty" }),
    });
  });

  it("maps bounded binary-read overflow to the video-specific tool error", async () => {
    const file = join(tmpDir, "large.mp4");
    const fs = createMemoryFileSystem({ [file]: "video" });
    fs.readBinaryFile = async (request) => {
      throw createFileSystemError({
        code: "too_large",
        path: request.path,
        message: "video exceeds read limit",
      });
    };

    await expect(readForModel({ file_path: file }, contextWith(fs))).rejects.toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: expect.objectContaining({
        code: "read_video_input_too_large",
        maxBytes: READ_VIDEO_MAX_INPUT_BYTES,
      }),
    });
  });

  it("returns the executor modelContent as cat-n text for normal text reads", async () => {
    const file = join(tmpDir, "notes.txt");
    const fs = createMemoryFileSystem({
      [file]: "alpha\nbeta",
    });

    const result = await executeRead({ file_path: file }, fs);

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      type: "text",
      filePath: file,
      content: "alpha\nbeta",
      numLines: 2,
      startLine: 1,
      totalLines: 2,
    });
    expect(result.modelContent).toBe("1\talpha\n2\tbeta");
    expect(result.serialization?.content).toBe("1\talpha\n2\tbeta");
  });

  it("numbers offset zero from line zero while reading the first physical line", async () => {
    const file = join(tmpDir, "zero-offset.txt");
    const fs = createMemoryFileSystem({
      [file]: "first\nsecond",
    });

    const result = await readForModel(
      {
        file_path: file,
        offset: 0,
        limit: 1,
      },
      contextWith(fs),
    );

    expect(result.output).toMatchObject({
      type: "text",
      content: "first",
      numLines: 1,
      startLine: 0,
      totalLines: 2,
    });
    expect(asModelText(result.modelContent)).toBe("0\tfirst");
  });

  it("records explicit ranges as range views instead of partial views", async () => {
    const file = join(tmpDir, "range-state.txt");
    const fs = createMemoryFileSystem({
      [file]: "first\nsecond\nthird",
    });
    const readFileState: ReadFileStateMap = new Map();
    const context = contextWith(fs, { readFileState });

    await readForModel(
      {
        file_path: file,
        offset: 2,
        limit: 1,
      },
      context,
    );

    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      isPartialView: false,
      limit: 1,
      offset: 2,
    });
  });

  it("keeps empty-file output metadata on the fast path", async () => {
    const file = join(tmpDir, "empty.txt");
    const fs = createMemoryFileSystem({
      [file]: "",
    });

    const result = await readForModel({ file_path: file }, contextWith(fs));

    expect(result.output).toMatchObject({
      type: "text",
      content: "",
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    });
    // 与严格合同同一断言；严格套件默认跳过，这里保证默认测试也覆盖空文件提示。
    expect(asModelText(result.modelContent)).toBe(
      "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
    );
  });

  it("reads past 2000 lines by default when byte and token budgets allow", async () => {
    const file = join(tmpDir, "many-lines.txt");
    const lines = Array.from({ length: 2005 }, (_, index) => `line-${index + 1}`);
    const fs = createMemoryFileSystem({
      [file]: lines.join("\n"),
    });

    const result = await readForModel({ file_path: file }, contextWith(fs));

    expect(result.output).toMatchObject({
      type: "text",
      numLines: 2005,
      totalLines: 2005,
    });
    expect(result.output).toHaveProperty("content", expect.stringContaining("line-2005"));
  });

  it("deduplicates repeated unchanged reads in the handler path", async () => {
    const file = join(tmpDir, "dedup.txt");
    const fs = createMemoryFileSystem({
      [file]: "same\ncontent",
    });
    const context = contextWith(fs);

    const first = await readForModel({ file_path: file }, context);
    const second = await readForModel({ file_path: file }, context);

    expect(first.output).toMatchObject({ type: "text", content: "same\ncontent" });
    expect(second.output).toEqual({ type: "file_unchanged", filePath: file });
    expect(asModelText(second.modelContent)).toBe(FILE_UNCHANGED_STUB);
  });

  // 修复原因：file_unchanged 的快照是当时最新记录的副本。冷恢复按它重放时，会恢复出已不在
  // active history 里的视图（例如那次真实读取已被 compact 摘要）。冷恢复只由真实读取恢复。
  it("records a read-state snapshot for content reads but not for file_unchanged", async () => {
    const file = join(tmpDir, "snapshot.txt");
    const fs = createMemoryFileSystem({ [file]: "same\ncontent" });
    const snapshots: unknown[] = [];
    const context: ToolExecutionContext = {
      ...contextWith(fs, { readFileState: new Map() }),
      recordReadFileStateMetadata: (metadata) => snapshots.push(metadata),
    };

    await readForModel({ file_path: file }, context);
    const second = await readForModel({ file_path: file }, context);

    expect(second.output).toEqual({ type: "file_unchanged", filePath: file });
    expect(snapshots).toEqual([expect.objectContaining({ path: file, tool: "Read" })]);
  });

  it("re-reads the whole current file for compaction without touching the read state", async () => {
    const file = join(tmpDir, "restore.txt");
    const fs = createMemoryFileSystem({ [file]: "one\ntwo" });

    const result = await readFileForCompactRestore({
      filePath: file,
      fileSystemPort: fs,
      workingDirectory: tmpDir,
      workspaceRoot: tmpDir,
    });

    expect(result).toMatchObject({
      output: { content: "one\ntwo", startLine: 1, totalLines: 2, type: "text" },
      readFileStateEntry: {
        content: "one\ntwo",
        isPartialView: false,
        limit: undefined,
        mtimeMs: 1,
        offset: undefined,
        path: file,
        revisionId: expect.any(String),
        sizeBytes: 7,
        sourceTool: "Read",
      },
      type: "text",
    });
    expect(fs.readRangeRequests).toEqual([
      expect.objectContaining({
        limitLines: undefined,
        maxBytes: READ_MAX_FILE_SIZE_BYTES,
        path: file,
      }),
    ]);
  });

  it("records a token-capped compaction re-read as a partial view", async () => {
    const file = join(tmpDir, "token-capped.txt");
    // 约 4 万 token，没有超过 Read 的文件大小上限。
    const content = Array.from(
      { length: 4_000 },
      (_, index) => `line ${index} ${"word ".repeat(5)}`,
    ).join("\n");
    const fs = createMemoryFileSystem({ [file]: content });

    const result = await readFileForCompactRestore({
      filePath: file,
      fileSystemPort: fs,
      workingDirectory: tmpDir,
      workspaceRoot: tmpDir,
    });

    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(READ_MAX_FILE_SIZE_BYTES);
    expect(result).toMatchObject({
      output: { truncatedByTokenCap: true, type: "text" },
      readFileStateEntry: { isPartialView: true, path: file },
      type: "text",
    });
  });

  it("reports oversized files and skips paths Read would not read as text for compaction", async () => {
    const large = join(tmpDir, "large.txt");
    const image = join(tmpDir, "shot.png");
    const binary = join(tmpDir, "tool.exe");
    const fs = createMemoryFileSystem({
      [large]: "x".repeat(READ_MAX_FILE_SIZE_BYTES + 1),
      [image]: "not really an image",
      [binary]: "not really a binary",
    });
    const restore = (filePath: string) =>
      readFileForCompactRestore({
        filePath,
        fileSystemPort: fs,
        workingDirectory: tmpDir,
        workspaceRoot: tmpDir,
      });

    expect(await restore(large)).toEqual({ type: "too_large" });
    expect(await restore(image)).toEqual({ type: "skipped" });
    expect(await restore(binary)).toEqual({ type: "skipped" });
    await expect(restore(join(tmpDir, "missing.txt"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns content again after Edit or Write recorded the file state", async () => {
    for (const sourceTool of ["Edit", "Write"] as const) {
      const file = join(tmpDir, `after-${sourceTool}.txt`);
      const fs = createMemoryFileSystem({ [file]: "alpha\ngamma" });
      const readFileState: ReadFileStateMap = new Map();
      const context = contextWith(fs, { readFileState });
      await readForModel({ file_path: file }, context);
      const key = createReadFileStatePathKey(file);
      // 模拟 Edit/Write 写入后的状态：同一完整视图的键，文件 mtime/size 未再变化。
      readFileState.set(key, { ...readFileState.get(key)!, readAt: new Date(), sourceTool });

      const reread = await readForModel({ file_path: file }, context);

      // 写入后模型没有看过新内容，重读必须返回内容，不是 Wasted call 存根。
      expect(reread.output).toMatchObject({ type: "text", content: "alpha\ngamma" });
    }
  });

  it("deduplicates only against the latest Read view of the path", async () => {
    const file = join(tmpDir, "latest-view.txt");
    const fs = createMemoryFileSystem({ [file]: "one\ntwo\nthree" });
    const readFileState: ReadFileStateMap = new Map();
    const context = contextWith(fs, { readFileState });

    await readForModel({ file_path: file }, context);
    await readForModel({ file_path: file, offset: 2, limit: 1 }, context);
    expect(readFileState.size).toBe(1);
    const full = await readForModel({ file_path: file }, context);
    const repeated = await readForModel({ file_path: file }, context);

    // 每个文件只按最近一次视图去重：中间读过别的范围后，完整读取返回内容。
    expect(full.output).toMatchObject({ type: "text", content: "one\ntwo\nthree" });
    expect(repeated.output).toEqual({ type: "file_unchanged", filePath: file });
    // 每个文件只存一条，每次读取覆盖。
    expect(readFileState.size).toBe(1);
  });

  it("maps empty Read content the same way for an empty file and a blank line", async () => {
    const empty = join(tmpDir, "empty-file.txt");
    const blank = join(tmpDir, "blank-line.txt");
    const fs = createMemoryFileSystem({ [empty]: "", [blank]: "a\n\nb" });
    const context = contextWith(fs);

    const emptyRead = await readForModel({ file_path: empty }, context);
    const blankRead = await readForModel({ file_path: blank, offset: 2, limit: 1 }, context);
    const pastEnd = await readForModel({ file_path: blank, offset: 5 }, context);

    // 空文件说内容为空；按 offset 读到的空行带行号；只有超出末尾才说 offset 太大。
    expect(asModelText(emptyRead.modelContent)).toBe(
      "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
    );
    expect(asModelText(blankRead.modelContent)).toBe("2\t");
    expect(asModelText(pastEnd.modelContent)).toBe(
      "<system-reminder>Warning: the file exists but is shorter than the provided offset (5). The file has 3 lines.</system-reminder>",
    );
  });

  it("deduplicates repeated reads when mtime only drifts inside the same millisecond", async () => {
    const file = join(tmpDir, "dedup-sub-ms.txt");
    const fs = createMemoryFileSystem({
      [file]: "same\ncontent",
    });
    fs.setMtime(file, 1000.2);
    const context = contextWith(fs);

    await readForModel({ file_path: file }, context);
    fs.setMtime(file, 1000.8);
    const second = await readForModel({ file_path: file }, context);

    expect(second.output).toEqual({ type: "file_unchanged", filePath: file });
  });

  it("re-reads when mtime advances to the next millisecond bucket", async () => {
    const file = join(tmpDir, "dedup-next-ms.txt");
    const fs = createMemoryFileSystem({
      [file]: "same\ncontent",
    });
    fs.setMtime(file, 1000.9);
    const context = contextWith(fs);

    await readForModel({ file_path: file }, context);
    fs.setMtime(file, 1001);
    const second = await readForModel({ file_path: file }, context);

    expect(second.output).toMatchObject({
      type: "text",
      content: "same\ncontent",
    });
  });

  it("re-reads after the file revision changes", async () => {
    const file = join(tmpDir, "changed.txt");
    const fs = createMemoryFileSystem({
      [file]: "before",
    });
    const context = contextWith(fs);

    await readForModel({ file_path: file }, context);
    fs.files.set(file, "after");
    const second = await readForModel({ file_path: file }, context);

    expect(second.output).toMatchObject({
      type: "text",
      content: "after",
    });
  });

  it("returns a missing-file message with cwd and a suggestion", async () => {
    const existing = join(tmpDir, "target.ts");
    const missing = join(tmpDir, "target.js");
    const fs = createMemoryFileSystem({
      [existing]: "export const ok = true",
    });

    await expect(
      readForModel(
        { file_path: missing },
        contextWith(fs, {
          workingDirectory: tmpDir,
          workspaceRoot: tmpDir,
        }),
      ),
    ).rejects.toMatchObject({
      message: `File does not exist. Note: your current working directory is ${tmpDir}. Did you mean target.ts?`,
    });
  });

  // 检查移到 validateInput 后，标签由 executor 加在模型文本上，error.message 与 UI 只有原文。
  it("returns tool_use_error text for Read preflight failures", async () => {
    const fs = createMemoryFileSystem({});

    const binary = await executeRead({ file_path: "/tmp/archive.zip" }, fs);
    const device = await executeRead({ file_path: "/dev/zero" }, fs);

    const binaryText =
      "This tool cannot read binary files. The file appears to be a binary .zip file. Use a skill for this file type if one is available, or a shell command or script that can read the format.";
    const deviceText =
      "Cannot read '/dev/zero': this path names a device or process file that this tool does not read.";
    expect(binary.success).toBe(false);
    expect(binary.error?.message).toBe(binaryText);
    expect(binary.modelContent).toBe(`<tool_use_error>${binaryText}</tool_use_error>`);
    expect(device.success).toBe(false);
    expect(device.error?.message).toBe(deviceText);
    expect(device.modelContent).toBe(`<tool_use_error>${deviceText}</tool_use_error>`);
  });

  it("keeps the binary and device checks in the handler for rewritten input", async () => {
    const fs = createMemoryFileSystem({});

    expect(await readHandler({ file_path: "/dev/zero" }, contextWith(fs))).toEqual({
      result: false,
      errorCode: 9,
      message:
        "Cannot read '/dev/zero': this path names a device or process file that this tool does not read.",
    });
    expect(fs.readRangeRequests).toEqual([]);
  });

  // 规则见 docs/design/v2/tool/01-read.md「输入修正」：修正发生在 JSON Schema 校验之前，handler 读修正后的范围。
  it.each([
    ["drops a non-positive limit", { limit: -1 }, "1\ta\n2\tb\n3\tc\n4\td\n5\te"],
    ["drops a zero limit", { limit: 0 }, "1\ta\n2\tb\n3\tc\n4\td\n5\te"],
    ["drops a negative numeric-string limit", { limit: " -1 " }, "1\ta\n2\tb\n3\tc\n4\td\n5\te"],
    ["converts numeric strings", { offset: "2", limit: " 1 " }, "2\tb"],
    ["maps a numeric-string length", { length: "2" }, "1\ta\n2\tb"],
    ["drops a negative offset", { offset: -5, limit: 2 }, "1\ta\n2\tb"],
    ["unwraps one-element arrays", { offset: [2], limit: [2] }, "2\tb\n3\tc"],
    ["maps length to limit", { length: 2 }, "1\ta\n2\tb"],
    ["maps length after dropping limit", { limit: 0, length: 3 }, "1\ta\n2\tb\n3\tc"],
    ["keeps limit over length", { limit: 1, length: 3 }, "1\ta"],
  ])("%s before validation", async (_name, range, expected) => {
    const file = join(tmpDir, "range.txt");
    const fs = createMemoryFileSystem({ [file]: "a\nb\nc\nd\ne" });

    const result = await executeRead({ file_path: file, ...range }, fs);

    expect(result.success).toBe(true);
    expect(result.modelContent).toBe(expected);
  });

  it("leaves non-numeric strings to field validation", async () => {
    const file = join(tmpDir, "range.txt");
    const fs = createMemoryFileSystem({ [file]: "a\nb" });

    const result = await executeRead({ file_path: file, limit: "abc" }, fs);

    expect(result.success).toBe(false);
    expect(result.modelContent).toBe(
      "<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe parameter `limit` type is expected as `number` but provided as `string`</tool_use_error>",
    );
  });

  it("documents current non-text model-content formatting", () => {
    const pdf = {
      type: "pdf" as const,
      filePath: "/work/report.pdf",
      base64: "pdf-data",
      originalSize: 4,
    };
    expect(formatReadModelContent(pdf)).toEqual([
      { type: "text", text: "PDF file read: /work/report.pdf (4 bytes)" },
      {
        type: "file",
        mediaType: "application/pdf",
        name: "report.pdf",
        dataUrl: "data:application/pdf;base64,pdf-data",
        source: {
          id: "read-pdf",
          kind: "inline",
          mimeType: "application/pdf",
          placeholder: "report.pdf",
          sizeBytes: 4,
        },
      },
    ]);

    expect(
      formatReadModelContent({
        type: "image",
        base64: "abc123",
        mimeType: "image/png",
        originalSize: 3,
        dimensions: {
          originalWidth: 3000,
          originalHeight: 1000,
          displayWidth: 2000,
          displayHeight: 667,
        },
      }),
    ).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,abc123",
        source: {
          id: "read-image",
          kind: "inline",
          mimeType: "image/png",
          placeholder: "Read image",
          sizeBytes: 3,
        },
      },
    ]);
  });
});

describeReadStrictContract("Read strict model-result contract", () => {
  it("normalizes UTF-8 BOM and CRLF while preserving requested offset and limit", async () => {
    const file = join(tmpDir, "windows.txt");
    const fs = createMemoryFileSystem({
      [file]: "\uFEFFfirst\r\nsecond\r\nthird",
    });

    const result = await readForModel(
      {
        file_path: file,
        offset: 2,
        limit: 1,
      },
      contextWith(fs),
    );

    expect(result.output).toMatchObject({
      type: "text",
      filePath: file,
      content: "second",
      numLines: 1,
      startLine: 2,
      totalLines: 3,
    });
    expect(asModelText(result.modelContent)).toBe("2\tsecond");
  });

  it("reads relative paths against cwd while preserving the original input path in output data", async () => {
    const file = join(tmpDir, "relative.txt");
    const fs = createMemoryFileSystem({
      [file]: "relative content",
    });

    const result = await readForModel(
      { file_path: "relative.txt" },
      contextWith(fs, {
        workingDirectory: tmpDir,
        workspaceRoot: tmpDir,
      }),
    );

    expect(result.output).toMatchObject({
      type: "text",
      filePath: "relative.txt",
      content: "relative content",
      startLine: 1,
      totalLines: 1,
    });
    expect(asModelText(result.modelContent)).toBe("1\trelative content");
  });

  it("maps an offset beyond EOF to the shorter-than-offset system reminder", async () => {
    const file = join(tmpDir, "short.txt");
    const fs = createMemoryFileSystem({
      [file]: "one\ntwo",
    });

    const result = await readForModel({ file_path: file, offset: 10 }, contextWith(fs));

    expect(result.output).toMatchObject({
      type: "text",
      content: "",
      numLines: 0,
      startLine: 10,
      totalLines: 2,
    });
    expect(asModelText(result.modelContent)).toBe(
      "<system-reminder>Warning: the file exists but is shorter than the provided offset (10). The file has 2 lines.</system-reminder>",
    );
  });

  it("matches the empty-file fast-path result", async () => {
    const file = join(tmpDir, "empty.txt");
    const fs = createMemoryFileSystem({
      [file]: "",
    });

    const result = await readForModel({ file_path: file }, contextWith(fs));

    expect(result.output).toMatchObject({
      type: "text",
      content: "",
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    });
    expect(asModelText(result.modelContent)).toBe(
      "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
    );
  });

  it("maps a zero-total-lines text output to the empty-file system reminder", () => {
    const modelContent = formatReadModelContent({
      type: "text",
      filePath: "/tmp/empty.txt",
      content: "",
      numLines: 0,
      startLine: 1,
      totalLines: 0,
    });

    expect(asModelText(modelContent)).toBe(
      "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
    );
  });

  it("throws a file-size error for whole-file reads above the Read byte guard", async () => {
    const file = join(tmpDir, "too-large.txt");
    const fs = createMemoryFileSystem({
      [file]: "x".repeat(READ_MAX_FILE_SIZE_BYTES + 1),
    });

    await expect(readForModel({ file_path: file }, contextWith(fs))).rejects.toMatchObject({
      type: "tool_execution_failed",
      message: `File content (${READ_MAX_FILE_SIZE_BYTES + 1} bytes) exceeds maximum allowed size (${READ_MAX_FILE_SIZE_BYTES} bytes). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    });
  });

  it("does not apply the byte guard when an explicit line limit is provided", async () => {
    const file = join(tmpDir, "large-but-limited.txt");
    const fs = createMemoryFileSystem({
      [file]: `0123456789\n${"x".repeat(READ_MAX_FILE_SIZE_BYTES + 1)}`,
    });

    const result = await readForModel(
      {
        file_path: file,
        limit: 1,
      },
      contextWith(fs),
    );

    expect(result.output).toMatchObject({
      type: "text",
      content: "0123456789",
      numLines: 1,
      startLine: 1,
      totalLines: 2,
    });
  });

  it("returns file_unchanged for repeated reads of the same unchanged range", async () => {
    const file = join(tmpDir, "dedup.txt");
    const fs = createMemoryFileSystem({
      [file]: "same\ncontent",
    });
    const readFileState: ReadFileStateMap = new Map();
    const context = contextWith(fs, { readFileState });

    const first = await readForModel({ file_path: file }, context);
    const second = await readForModel({ file_path: file }, context);
    const differentRange = await readForModel(
      {
        file_path: file,
        offset: 2,
        limit: 1,
      },
      context,
    );

    expect(first.output).toMatchObject({ type: "text" });
    expect(second.output).toEqual({
      type: "file_unchanged",
      filePath: file,
    });
    expect(asModelText(second.modelContent)).toBe(FILE_UNCHANGED_STUB);
    expect(differentRange.output).toMatchObject({
      type: "text",
      content: "content",
      startLine: 2,
    });
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      isPartialView: false,
      limit: 1,
      offset: 2,
    });
  });

  it("throws the directory read error returned by the line reader", async () => {
    const dir = join(tmpDir, "folder");
    const fs = createMemoryFileSystem({}, [dir]);

    await expect(readForModel({ file_path: dir }, contextWith(fs))).rejects.toMatchObject({
      message: `EISDIR: illegal operation on a directory, read '${dir}'`,
    });
  });

  it("reads notebooks and maps cells to model-facing text blocks", async () => {
    const file = join(tmpDir, "demo.ipynb");
    const fs = createMemoryFileSystem({
      [file]: JSON.stringify({
        metadata: { language_info: { name: "python" } },
        cells: [
          {
            id: "markdown-1",
            cell_type: "markdown",
            source: ["# Title\n", "body"],
          },
          {
            id: "code-1",
            cell_type: "code",
            execution_count: 3,
            source: "print('hi')",
            outputs: [
              {
                output_type: "stream",
                text: "hi\n",
              },
            ],
          },
        ],
      }),
    });

    const result = await readForModel({ file_path: file }, contextWith(fs));

    expect(result.output).toMatchObject({
      type: "notebook",
      notebookPath: file,
    });
    expect(asModelText(result.modelContent)).toContain(
      '<cell id="markdown-1"><cell_type>markdown</cell_type># Title\nbody</cell id="markdown-1">',
    );
    expect(asModelText(result.modelContent)).toContain(
      '<cell id="code-1">print(\'hi\')</cell id="code-1">',
    );
  });

  it("serializes PDF parts Read output for the model", () => {
    const content = formatReadModelContent({
      type: "parts",
      filePath: "/tmp/report.pdf",
      numParts: 3,
      originalSize: 2048,
      pages: [1, 2, 3].map((pageNumber) => ({
        type: "image" as const,
        pageNumber,
        base64: `page-${pageNumber}`,
        mimeType: "image/jpeg" as const,
        originalSize: 6,
      })),
    });

    expect(content[0]).toEqual({
      type: "text",
      text: "PDF pages extracted: 3 page(s) from /tmp/report.pdf (2KB)",
    });
    expect(content.slice(1).map((block) => block.source?.id)).toEqual([
      "read-pdf-page-1",
      "read-pdf-page-2",
      "read-pdf-page-3",
    ]);
  });

  it("rejects malformed PDF page ranges before I/O", () => {
    expect(readInputValidation({ file_path: "/tmp/x.pdf", pages: "abc" })).toMatchObject({
      result: false,
      errorCode: 7,
    });
  });

  it("rejects oversized PDF page ranges before I/O", () => {
    expect(readInputValidation({ file_path: "/tmp/x.pdf", pages: "1-21" })).toMatchObject({
      result: false,
      errorCode: 8,
    });
    expect(readInputValidation({ file_path: "/tmp/x.pdf", pages: "20-" })).toMatchObject({
      result: false,
      errorCode: 8,
    });
  });
});

async function readForModel(input: unknown, context: ToolExecutionContext) {
  const output = await readHandler(input, context);
  return {
    output,
    modelContent: formatReadModelContent(output),
  };
}

function formatReadModelContent(output: unknown): ModelMessageContent {
  const modelContent = readToolEntry.formatModelContent?.(output);
  if (modelContent === undefined) {
    throw new Error("Read tool is missing formatModelContent");
  }
  return modelContent;
}

function asModelText(content: ModelMessageContent | undefined): string {
  if (content === undefined) {
    throw new Error("Missing model content");
  }
  return modelMessageContentToText(content);
}

async function executeRead(
  input: unknown,
  fileSystemPort: FileSystemPort,
  options: {
    imageProcessorPort?: ImageProcessorPort;
    workingDirectory?: string;
    workspaceRoot?: string;
  } = {},
) {
  const sessionId = createSessionId("read-contract");
  const turnId = createTurnId("read-contract");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(readToolEntry);

  return createToolExecutor({
    emitEvent: async () => {},
    fileSystemPort,
    imageProcessorPort: options.imageProcessorPort,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    traceContext,
    turnId,
    workingDirectory: options.workingDirectory ?? tmpDir,
    workspaceRoot: options.workspaceRoot ?? tmpDir,
  }).execute(
    {
      id: createToolCallId("read-contract"),
      input,
      name: "Read",
    },
    { traceContext },
  );
}

function contextWith(
  fileSystemPort: FileSystemPort,
  options: {
    imageProcessorPort?: ImageProcessorPort;
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
    imageProcessorPort: options.imageProcessorPort,
    readFileState: options.readFileState,
    workingDirectory: options.workingDirectory ?? tmpDir,
    workspaceRoot: options.workspaceRoot ?? tmpDir,
    sessionId: "sess_test",
    turnId: "turn_test",
  };
}

interface MemoryFileSystem extends FileSystemPort {
  files: Map<string, string>;
  directories: Set<string>;
  mtimes: Map<string, number>;
  readRangeRequests: Array<Parameters<FileSystemPort["readTextFileRange"]>[0]>;
  setMtime(path: string, mtimeMs: number): void;
}

function createMemoryFileSystem(
  initial: Record<string, string>,
  directories: string[] = [],
): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const directorySet = new Set(directories);
  const mtimes = new Map<string, number>();
  const fs: MemoryFileSystem = {
    files,
    directories: directorySet,
    mtimes,
    readRangeRequests: [],
    setMtime(path, mtimeMs) {
      mtimes.set(path, mtimeMs);
    },
    async stat(request): Promise<FileSystemStatResult> {
      if (directorySet.has(request.path)) {
        return {
          path: request.path,
          kind: "directory",
          sizeBytes: 0,
        };
      }
      const content = files.get(request.path);
      if (content === undefined) throw missingFile(request.path);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      return {
        path: request.path,
        kind: "file",
        mtimeMs,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        revision: revisionFor(request.path, content, mtimeMs),
      };
    },
    async readTextFile(request): Promise<FileSystemReadTextResult> {
      const content = readTextOrThrow(request.path, files, directorySet);
      const normalized = normalizeLineEndings(content);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      return {
        path: request.path,
        content: normalized,
        encoding: request.encoding ?? "utf8",
        lineEndings: detectLineEndings(content),
        bytesRead: Buffer.byteLength(content, "utf8"),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
        revision: revisionFor(request.path, content, mtimeMs),
      };
    },
    async readBinaryFile(request) {
      const content = readTextOrThrow(request.path, files, directorySet);
      const buffer = Buffer.from(content, "utf8");
      const mtimeMs = mtimes.get(request.path) ?? 1;
      if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path: request.path,
          message: `File content (${buffer.byteLength} bytes) exceeds maximum allowed size (${request.maxBytes} bytes).`,
        });
      }
      return {
        path: request.path,
        content: buffer,
        bytesRead: buffer.byteLength,
        sizeBytes: buffer.byteLength,
        revision: revisionFor(request.path, content, mtimeMs),
      };
    },
    async readTextFileRange(request): Promise<FileSystemReadTextRangeResult> {
      fs.readRangeRequests.push(request);
      const content = readTextOrThrow(request.path, files, directorySet);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (request.maxBytes !== undefined && sizeBytes > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path: request.path,
          message: `File content (${sizeBytes} bytes) exceeds maximum allowed size (${request.maxBytes} bytes). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
        });
      }
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
        path: request.path,
        content: selected.join("\n"),
        encoding: request.encoding ?? "utf8",
        lineEndings: detectLineEndings(content),
        bytesRead: sizeBytes,
        sizeBytes,
        truncated: false,
        startLine: offsetLine + 1,
        lineCount: selected.length,
        totalLines: lines.length,
        revision: revisionFor(request.path, content, mtimeMs),
      };
    },
    async writeTextFile(request) {
      files.set(request.path, request.content);
      mtimes.set(request.path, (mtimes.get(request.path) ?? 1) + 1);
      return {
        path: request.path,
        bytesWritten: Buffer.byteLength(request.content, "utf8"),
        revision: revisionFor(request.path, request.content, mtimes.get(request.path) ?? 1),
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
        path: request.path,
        durationMs: 0,
        entries,
        numEntries: entries.length,
      };
    },
    async searchFiles(request): Promise<FileSystemSearchFilesResult> {
      const prefix = `${request.path.replace(/\/+$/u, "")}/`;
      const filesMatched = Array.from(files.keys()).filter((path) => path.startsWith(prefix));
      return {
        path: request.path,
        pattern: request.pattern,
        durationMs: 0,
        files: filesMatched,
        numFiles: filesMatched.length,
        truncated: false,
      };
    },
    async searchText(request): Promise<FileSystemSearchTextResult> {
      return {
        path: request.path,
        pattern: request.pattern,
        mode: request.outputMode ?? "files_with_matches",
        durationMs: 0,
        files: [],
        entries: [],
        numMatches: 0,
        truncated: false,
      };
    },
  };
  return fs;
}

function readTextOrThrow(
  path: string,
  files: Map<string, string>,
  directories: Set<string>,
): string {
  if (directories.has(path)) {
    throw createFileSystemError({
      code: "is_directory",
      path,
      message: `EISDIR: illegal operation on a directory, read '${path}'`,
    });
  }
  const content = files.get(path);
  if (content === undefined) throw missingFile(path);
  return content;
}

function missingFile(path: string): Error {
  return createFileSystemError({
    code: "not_found",
    path,
    message: `missing: ${path}`,
  });
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
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

function readInputValidation(input: unknown) {
  if (!readToolEntry.validateInput) {
    throw new Error("Read tool is missing validateInput");
  }
  return readToolEntry.validateInput(input, {});
}

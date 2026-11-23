import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSystemError,
  type FileSystemLineEndings,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemRevision,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextResult,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type PermissionRuleset,
} from "@zcode/contracts";
import { EditInputSchema, EditOutputSchema } from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  createErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
} from "../src/tool/executor/errors.js";
import { editHandler, editToolEntry } from "../src/tool/handlers/edit.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import type {
  ExecutableToolCall,
  ReadFileStateMap,
  ToolExecutionContext,
} from "../src/tool/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "zcode-edit-contract-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Edit tool contract", () => {
  it("updates an existing file and maps the success result for the model", async () => {
    const file = join(tmpDir, "existing.txt");
    const fs = createMemoryFileSystem({ [file]: "old line\nkept line\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "old line\nkept line\n"),
    });
    const statSpy = vi.spyOn(fs, "stat");
    const readSpy = vi.spyOn(fs, "readTextFile");
    const writeSpy = vi.spyOn(fs, "writeTextFile");

    const output = await editHandler(
      { file_path: file, old_string: "old line", new_string: "new line" },
      context,
    );

    expect(fs.files.get(file)).toBe("new line\nkept line\n");
    expect(output).toMatchObject({
      filePath: file,
      oldString: "old line",
      newString: "new line",
      originalFile: "old line\nkept line\n",
      userModified: false,
      replaceAll: false,
    });
    expect(editToolEntry.formatModelContent?.(output)).toBe(
      `The file ${file} has been updated successfully. (file state is current in your context — no need to Read it back)`,
    );
    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("replaces all matches when replace_all is true", async () => {
    const file = join(tmpDir, "replace-all.txt");
    const fs = createMemoryFileSystem({ [file]: "foo\nfoo\nkeep\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "foo\nfoo\nkeep\n"),
    });

    const output = await editHandler(
      { file_path: file, old_string: "foo", new_string: "bar", replace_all: true },
      context,
    );

    expect(fs.files.get(file)).toBe("bar\nbar\nkeep\n");
    expect(editToolEntry.formatModelContent?.(output)).toBe(
      `The file ${file} has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)`,
    );
  });

  it("writes dollar replacement tokens literally", async () => {
    const file = join(tmpDir, "dollar-tokens.txt");
    const fs = createMemoryFileSystem({ [file]: "first TOKEN\nsecond TOKEN\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "first TOKEN\nsecond TOKEN\n"),
    });

    const output = await editHandler(
      { file_path: file, old_string: "first TOKEN", new_string: "first $$ and $&" },
      context,
    );

    expect(fs.files.get(file)).toBe("first $$ and $&\nsecond TOKEN\n");
    expect(output.newString).toBe("first $$ and $&");
  });

  it("creates a missing file from empty old_string but still maps it as an update", async () => {
    const file = join(tmpDir, "generated", "created.txt");
    const fs = createMemoryFileSystem({});

    const output = await editHandler(
      { file_path: file, old_string: "", new_string: "created\ncontent\n" },
      contextWith(fs),
    );

    expect(fs.files.get(file)).toBe("created\ncontent\n");
    expect(output).toMatchObject({ oldString: "", originalFile: "" });
    expect(editToolEntry.formatModelContent?.(output)).toBe(
      `The file ${file} has been updated successfully. (file state is current in your context — no need to Read it back)`,
    );
  });

  it("fills an existing empty file with empty old_string after it has been read", async () => {
    const file = join(tmpDir, "empty-existing.txt");
    const fs = createMemoryFileSystem({ [file]: "" });
    const context = contextWith(fs, { readFileState: createReadFileState(file, "") });

    const output = await editHandler(
      { file_path: file, old_string: "", new_string: "filled\n" },
      context,
    );

    expect(fs.files.get(file)).toBe("filled\n");
    expect(output).toMatchObject({ oldString: "", originalFile: "" });
  });

  it("preserves the input relative path in output and model content", async () => {
    const file = join(tmpDir, "relative.txt");
    const fs = createMemoryFileSystem({ [file]: "relative old\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "relative old\n"),
      workingDirectory: tmpDir,
      workspaceRoot: tmpDir,
    });

    const output = await editHandler(
      { file_path: "relative.txt", old_string: "relative old", new_string: "relative new" },
      context,
    );

    expect(fs.files.get(file)).toBe("relative new\n");
    expect(output.filePath).toBe("relative.txt");
    expect(editToolEntry.formatModelContent?.(output)).toBe(
      "The file relative.txt has been updated successfully. (file state is current in your context — no need to Read it back)",
    );
  });

  it("accepts a normalized read-state key when the stored display path differs", async () => {
    const file = join(tmpDir, "existing-normalized-key.txt");
    const fs = createMemoryFileSystem({ [file]: "original\n" });
    const revision = revisionFor(file, "original\n");
    const readFileState: ReadFileStateMap = new Map([
      [
        createReadFileStatePathKey(file),
        {
          path: `${tmpDir}/nested/../existing-normalized-key.txt`,
          content: "original\n",
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

    const output = await editHandler(
      { file_path: file, old_string: "original", new_string: "modified-by-edit" },
      context,
    );

    expect(output).toMatchObject({
      filePath: file,
      oldString: "original",
      newString: "modified-by-edit",
      originalFile: "original\n",
    });
    expect(fs.files.get(file)).toBe("modified-by-edit\n");
  });

  it("preserves CRLF on disk while using LF-normalized content internally", async () => {
    const file = join(tmpDir, "line-endings.txt");
    const fs = createMemoryFileSystem({ [file]: "first\r\nsecond\r\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "first\nsecond\n"),
    });

    const output = await editHandler(
      { file_path: file, old_string: "second", new_string: "changed" },
      context,
    );

    expect(fs.files.get(file)).toBe("first\r\nchanged\r\n");
    expect(output.originalFile).toBe("first\nsecond\n");
  });

  it("deleting a line removes the following newline when old_string omits it", async () => {
    const file = join(tmpDir, "delete-line.txt");
    const fs = createMemoryFileSystem({ [file]: "keep\nremove\nlast\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "keep\nremove\nlast\n"),
    });

    await editHandler({ file_path: file, old_string: "remove", new_string: "" }, context);

    expect(fs.files.get(file)).toBe("keep\nlast\n");
  });

  it("matches straight quotes against curly quotes and preserves the file quote style", async () => {
    const file = join(tmpDir, "quotes.txt");
    const fs = createMemoryFileSystem({ [file]: "const msg = “hello”\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "const msg = “hello”\n"),
    });

    const output = await editHandler(
      { file_path: file, old_string: '"hello"', new_string: '"bye"' },
      context,
    );

    expect(output.oldString).toBe("“hello”");
    expect(output.newString).toBe("“bye”");
    expect(fs.files.get(file)).toBe("const msg = “bye”\n");
  });

  it("uses the latest user-modified model text and no legacy freshness suffix", () => {
    const content = editToolEntry.formatModelContent?.({
      filePath: "/work/user-modified.txt",
      oldString: "before",
      newString: "after",
      originalFile: "before\n",
      structuredPatch: [],
      userModified: true,
      replaceAll: false,
    });

    expect(content).toBe(
      "The file /work/user-modified.txt has been updated successfully.  The user modified your proposed changes before accepting them. .",
    );
  });

  it("rejects no-op edits before filesystem access", async () => {
    await expect(
      editHandler(
        { file_path: join(tmpDir, "anything.txt"), old_string: "same", new_string: "same" },
        contextWith(createMemoryFileSystem({})),
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 1,
      message: "No changes to make: old_string and new_string are exactly the same.",
    });
  });

  it("returns a tool-owned error for an empty file path", async () => {
    const fs = createMemoryFileSystem({});
    const statSpy = vi.spyOn(fs, "stat");
    const toolCall: ExecutableToolCall = {
      id: "tool_empty_edit_path",
      input: {
        file_path: "",
        old_string: "before",
        new_string: "after",
      },
      name: "Edit",
    };

    const failure = await editHandler(toolCall.input, contextWith(fs));

    expect(failure).toEqual({
      result: false,
      errorCode: 13,
      message: "Tool path must not be empty",
    });
    expect(statSpy).not.toHaveBeenCalled();
    if (!isToolHandlerFailure(failure)) throw new Error("Expected Edit handler to fail");

    const result = createErrorResult(toolCall, createToolHandlerFailureError(toolCall, failure));
    expect(result.error).toMatchObject({
      code: "13",
      message: "Tool path must not be empty",
    });
    expect(result.modelContent).toBe(
      "<tool_use_error>Tool path must not be empty</tool_use_error>",
    );
  });

  it("wraps a tool-owned code + message only for the model", async () => {
    const toolCall: ExecutableToolCall = {
      id: "tool_test",
      input: {
        file_path: "/work/noop.txt",
        old_string: "same",
        new_string: "same",
      },
      name: "Edit",
    };
    const failure = await editHandler(toolCall.input, contextWith(createMemoryFileSystem({})));
    if (!isToolHandlerFailure(failure)) throw new Error("Expected Edit handler to fail");
    const result = createErrorResult(toolCall, createToolHandlerFailureError(toolCall, failure));

    expect(result.error?.message).toBe(
      "No changes to make: old_string and new_string are exactly the same.",
    );
    expect(result.modelContent).toBe(
      "<tool_use_error>No changes to make: old_string and new_string are exactly the same.</tool_use_error>",
    );
  });

  it("preserves raw multiline Edit error text in model-facing tool_result content", async () => {
    const file = join(tmpDir, "missing-string.txt");
    const oldString = "first line\nsecond line\n" + "x".repeat(520);
    const fs = createMemoryFileSystem({ [file]: "available content" });
    const toolCall: ExecutableToolCall = {
      id: "tool_test",
      input: {
        file_path: file,
        old_string: oldString,
        new_string: "replacement",
      },
      name: "Edit",
    };
    const rawMessage =
      "String to replace not found in file.\nString: first line\nsecond line\n" + "x".repeat(520);
    const failure = await editHandler(
      toolCall.input,
      contextWith(fs, {
        readFileState: createReadFileState(file, "available content"),
      }),
    );
    expect(failure).toEqual({
      result: false,
      errorCode: 8,
      message: rawMessage,
    });
    if (!isToolHandlerFailure(failure)) throw new Error("Expected Edit handler to fail");
    const result = createErrorResult(toolCall, createToolHandlerFailureError(toolCall, failure));

    expect(result.error?.message).not.toBe(rawMessage);
    expect(result.modelContent).toBe(`<tool_use_error>${rawMessage}</tool_use_error>`);
  });

  it("does not misclassify unexpected Edit exceptions as tool-owned failures", () => {
    const result = createErrorResult(
      {
        id: "tool_edit_race",
        input: {
          file_path: "/work/race.txt",
          old_string: "before",
          new_string: "after",
        },
        name: "Edit",
      },
      new Error("File write failed"),
    );

    expect(result.error?.message).toBe("File write failed");
    expect(result.modelContent).toBeUndefined();
  });

  it("returns missing-file messages with cwd and similar filename suggestions", async () => {
    const existing = join(tmpDir, "component.ts");
    const missing = join(tmpDir, "component.js");
    const fs = createMemoryFileSystem({ [existing]: "export const value = 1\n" });

    await expect(
      editHandler(
        { file_path: missing, old_string: "value", new_string: "renamed" },
        contextWith(fs),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 4,
      message: `File does not exist. Note: your current working directory is ${tmpDir}. Did you mean component.ts?`,
    });
  });

  it("rejects empty old_string for an existing nonempty file", async () => {
    const file = join(tmpDir, "nonempty.txt");
    const fs = createMemoryFileSystem({ [file]: "already here" });

    await expect(
      editHandler({ file_path: file, old_string: "", new_string: "replacement" }, contextWith(fs)),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 3,
      message: "Cannot create new file - file already exists.",
    });
  });

  it("rejects notebooks and points to a shell command or script", async () => {
    const file = join(tmpDir, "notebook.ipynb");
    const fs = createMemoryFileSystem({ [file]: '{"cells":[]}' });
    const context = contextWith(fs, { readFileState: createReadFileState(file, '{"cells":[]}') });

    await expect(
      editHandler({ file_path: file, old_string: "cells", new_string: "metadata" }, context),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 5,
      message:
        "File is a Jupyter Notebook. Edit does not change .ipynb files; change the notebook JSON with a shell command or script instead.",
    });
  });

  it("requires existing nonempty files to be read before editing", async () => {
    const file = join(tmpDir, "unread.txt");
    const fs = createMemoryFileSystem({ [file]: "old content" });

    await expect(
      editHandler(
        { file_path: file, old_string: "old", new_string: "new" },
        contextWith(fs, { readFileState: new Map() }),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 6,
      message: "File has not been read yet. Read it first before writing to it.",
    });
  });

  it("rejects token-truncated partial views even when the file is unchanged", async () => {
    const file = join(tmpDir, "partial-view.txt");
    const fs = createMemoryFileSystem({ [file]: "line one\nline two\n" });
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "line one", {
        isPartialView: true,
        limit: 1,
        revisionContent: "line one\nline two\n",
      }),
    });

    await expect(
      editHandler({ file_path: file, old_string: "line two", new_string: "line 2" }, context),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 6,
      message: "File has not been read yet. Read it first before writing to it.",
    });
  });

  it("uses the latest same-file range read state after an older full read becomes stale", async () => {
    const file = join(tmpDir, "latest-range.txt");
    const fs = createMemoryFileSystem({ [file]: "line one\nline two\n" });
    fs.setMtime(file, 3);
    const readFileState = createReadFileState(file, "outdated\nline two\n", {
      mtimeMs: 1,
      readAt: new Date(1),
    });
    const latestRevision = revisionFor(file, "line one\nline two\n", 3);
    readFileState.set(createReadFileStatePathKey(file), {
      path: file,
      content: "line two",
      offset: 2,
      limit: 1,
      isPartialView: false,
      readAt: new Date(2),
      revisionId: latestRevision.id,
      mtimeMs: latestRevision.mtimeMs,
      sizeBytes: latestRevision.sizeBytes,
    });

    await expect(
      editHandler(
        { file_path: file, old_string: "line two", new_string: "line 2" },
        contextWith(fs, { readFileState }),
      ),
    ).resolves.toMatchObject({ filePath: file });
    expect(fs.files.get(file)).toBe("line one\nline 2\n");
  });

  it("allows sub-millisecond mtime drift for partial read freshness", async () => {
    const file = join(tmpDir, "mtime-sub-ms-partial.txt");
    const fs = createMemoryFileSystem({ [file]: "target content" });
    fs.setMtime(file, 1000.8);
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "target", {
        limit: 1,
        mtimeMs: 1000.2,
        offset: 1,
        revisionContent: "target content",
      }),
    });

    await expect(
      editHandler({ file_path: file, old_string: "target", new_string: "updated" }, context),
    ).resolves.toMatchObject({ filePath: file });
    expect(fs.files.get(file)).toBe("updated content");
  });

  it("rejects range reads when normalized mtime advances", async () => {
    const file = join(tmpDir, "mtime-advanced-range.txt");
    const fs = createMemoryFileSystem({ [file]: "target content" });
    fs.setMtime(file, 1001);
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "target", {
        limit: 1,
        mtimeMs: 1000.9,
        revisionContent: "target content",
      }),
    });

    await expect(
      editHandler({ file_path: file, old_string: "target", new_string: "updated" }, context),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 7,
      message:
        "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    });
  });

  it("rejects range reads when file size changes inside the same millisecond", async () => {
    const file = join(tmpDir, "size-changed-range.txt");
    const fs = createMemoryFileSystem({ [file]: "target content" });
    fs.files.set(file, "target content!");
    fs.setMtime(file, 1000.8);
    const context = contextWith(fs, {
      readFileState: createReadFileState(file, "target", {
        limit: 1,
        mtimeMs: 1000.2,
        revisionContent: "target content",
      }),
    });

    await expect(
      editHandler({ file_path: file, old_string: "target", new_string: "updated" }, context),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 7,
      message:
        "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    });
  });

  it("rejects stale edits when content changed after the cached read", async () => {
    const file = join(tmpDir, "stale.txt");
    const fs = createMemoryFileSystem({ [file]: "old content" });
    const context = contextWith(fs, { readFileState: createReadFileState(file, "old content") });
    fs.files.set(file, "old content changed elsewhere");
    fs.touch(file);

    await expect(
      editHandler({ file_path: file, old_string: "old", new_string: "new" }, context),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 7,
      message:
        "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    });
  });

  it("allows mtime-only changes for offset-1 full reads but rejects later range stale fallbacks", async () => {
    const fullReadFile = join(tmpDir, "mtime-only.txt");
    const offsetOneReadFile = join(tmpDir, "mtime-offset-one.txt");
    const offsetRangeReadFile = join(tmpDir, "mtime-offset-range.txt");
    const fs = createMemoryFileSystem({
      [fullReadFile]: "target content",
      [offsetOneReadFile]: "target content",
      [offsetRangeReadFile]: "target content",
    });

    const fullContext = contextWith(fs, {
      readFileState: createReadFileState(fullReadFile, "target content", { mtimeMs: 1 }),
    });
    fs.setMtime(fullReadFile, 2);
    await expect(
      editHandler(
        { file_path: fullReadFile, old_string: "target", new_string: "updated" },
        fullContext,
      ),
    ).resolves.toMatchObject({ filePath: fullReadFile });

    const offsetOneContext = contextWith(fs, {
      readFileState: createReadFileState(offsetOneReadFile, "target content", {
        offset: 1,
        mtimeMs: 1,
      }),
    });
    fs.setMtime(offsetOneReadFile, 2);
    await expect(
      editHandler(
        { file_path: offsetOneReadFile, old_string: "target", new_string: "updated" },
        offsetOneContext,
      ),
    ).resolves.toMatchObject({ filePath: offsetOneReadFile });

    const offsetRangeContext = contextWith(fs, {
      readFileState: createReadFileState(offsetRangeReadFile, "target content", {
        offset: 2,
        mtimeMs: 1,
      }),
    });
    fs.setMtime(offsetRangeReadFile, 2);
    await expect(
      editHandler(
        { file_path: offsetRangeReadFile, old_string: "target", new_string: "updated" },
        offsetRangeContext,
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 7,
      message:
        "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    });
  });

  it("returns old_string not found and ambiguous-match messages", async () => {
    const missingFile = join(tmpDir, "missing-string.txt");
    const ambiguousFile = join(tmpDir, "ambiguous.txt");
    const fs = createMemoryFileSystem({
      [missingFile]: "available content",
      [ambiguousFile]: "name\nname\n",
    });

    await expect(
      editHandler(
        { file_path: missingFile, old_string: "not present", new_string: "replacement" },
        contextWith(fs, { readFileState: createReadFileState(missingFile, "available content") }),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 8,
      message: "String to replace not found in file.\nString: not present",
    });

    await expect(
      editHandler(
        { file_path: ambiguousFile, old_string: "name", new_string: "label" },
        contextWith(fs, { readFileState: createReadFileState(ambiguousFile, "name\nname\n") }),
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 9,
      message:
        "Found 2 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: name",
    });
  });

  it("matches unicode escape old_string against decoded file content", async () => {
    const file = join(tmpDir, "unicode-escape.txt");
    const fs = createMemoryFileSystem({ [file]: "<tag>value</tag>\n" });

    const output = await editHandler(
      { file_path: file, old_string: "\\u003Ctag\\u003E", new_string: "<node>" },
      contextWith(fs, { readFileState: createReadFileState(file, "<tag>value</tag>\n") }),
    );

    expect(output.oldString).toBe("<tag>");
    expect(fs.files.get(file)).toBe("<node>value</tag>\n");
  });

  it("adds Edit performance attribution with patch matching statistics", async () => {
    const file = join(tmpDir, "perf-edit.txt");
    const fs = createMemoryFileSystem({ [file]: "alpha\nbeta\n" });
    const byteLength = Buffer.byteLength;
    let newContentByteCountCalls = 0;
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (value === "alpha\ngamma\n" && encoding === "utf8") {
        newContentByteCountCalls += 1;
      }
      return byteLength(value, encoding);
    });

    try {
      const output = await editHandler(
        { file_path: file, old_string: "beta", new_string: "gamma" },
        contextWith(fs, { readFileState: createReadFileState(file, "alpha\nbeta\n") }),
      );

      expect(output).toMatchObject({
        filePath: file,
        perf: {
          detail: {
            kind: "patch",
            filesystem: {
              readMs: expect.any(Number),
              writeMs: expect.any(Number),
              fileCount: 1,
              totalBytes: byteLength("alpha\ngamma\n", "utf8"),
              maxFileBytes: byteLength("alpha\ngamma\n", "utf8"),
              workspaceKind: "local",
            },
            patch: {
              matchMs: expect.any(Number),
              hunkCount: 1,
              matchAttempts: 1,
            },
          },
        },
      });
      // 内存 FS 写入和 revision 计算会读取新内容大小；这里约束 perf 字段只额外计算一次。
      expect(newContentByteCountCalls).toBe(4);
      expect(JSON.stringify((output as any).perf)).not.toContain(file);
      expect(JSON.stringify((output as any).perf)).not.toContain("gamma");
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("rejects files larger than the edit limit before reading them", async () => {
    const file = join(tmpDir, "huge.txt");
    const fs = createMemoryFileSystem({ [file]: "old" });
    fs.sizes.set(file, 1024 * 1024 * 1024 + 1);

    await expect(
      editHandler({ file_path: file, old_string: "old", new_string: "new" }, contextWith(fs)),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 10,
      // 只比上限大一点时，格式化后同为 1GB，括号里写字节数。
      message: "File is too large to edit (1073741825 bytes). Maximum editable file size is 1GB.",
    });

    fs.sizes.set(file, 1536 * 1024 * 1024);
    await expect(
      editHandler({ file_path: file, old_string: "old", new_string: "new" }, contextWith(fs)),
    ).resolves.toMatchObject({
      errorCode: 10,
      message: "File is too large to edit (1.5GB). Maximum editable file size is 1GB.",
    });
  });

  it("explains an undecodable file instead of returning the raw file-system error", async () => {
    const file = join(tmpDir, "legacy.txt");
    const fs = createMemoryFileSystem({ [file]: "old" });
    fs.readTextFile = async (request) => {
      throw createFileSystemError({
        code: "unsupported",
        path: request.path,
        message: `Unsupported or binary text encoding: ${request.path}`,
      });
    };

    await expect(
      editHandler({ file_path: file, old_string: "old", new_string: "new" }, contextWith(fs)),
    ).resolves.toEqual({
      result: false,
      errorCode: 15,
      message:
        "File is not valid UTF-8 or a supported legacy encoding (GB2312, GBK, GB18030), or it is binary. Edit and Write never convert a file's encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.",
    });
    expect(fs.files.get(file)).toBe("old");
  });

  it("adds the escape note only when old_string has a \\uXXXX escape", async () => {
    const file = join(tmpDir, "escape-note.txt");
    const fs = createMemoryFileSystem({ [file]: "plain text" });
    const context = contextWith(fs, { readFileState: createReadFileState(file, "plain text") });

    await expect(
      editHandler({ file_path: file, old_string: "caf\\u00e9 menu", new_string: "x" }, context),
    ).resolves.toMatchObject({
      errorCode: 8,
      message:
        "String to replace not found in file.\nString: caf\\u00e9 menu\n(note: Edit also tried swapping \\uXXXX escapes and their characters; neither form matched, so the mismatch is likely elsewhere in old_string. Re-read the file and copy the exact surrounding text.)",
    });
    // 匹配器不会把字符换成 \uXXXX 再找，只有非 ASCII 字符时不加这句。
    await expect(
      editHandler({ file_path: file, old_string: "café menu", new_string: "x" }, context),
    ).resolves.toMatchObject({
      errorCode: 8,
      message: "String to replace not found in file.\nString: café menu",
    });
  });

  it("coerces semantic boolean strings for replace_all and requires originalFile to be a string", async () => {
    expect(
      EditInputSchema.parse({
        file_path: "/tmp/example.txt",
        old_string: "old",
        new_string: "new",
        replace_all: "false",
      }),
    ).toMatchObject({ replace_all: false });

    const file = join(tmpDir, "string-true.txt");
    const fs = createMemoryFileSystem({ [file]: "foo\nfoo\n" });
    const output = await editHandler(
      { file_path: file, old_string: "foo", new_string: "bar", replace_all: "true" },
      contextWith(fs, { readFileState: createReadFileState(file, "foo\nfoo\n") }),
    );

    expect(fs.files.get(file)).toBe("bar\nbar\n");
    expect(typeof output.originalFile).toBe("string");
    expect(() =>
      EditOutputSchema.parse({
        filePath: file,
        oldString: "old",
        newString: "new",
        originalFile: null,
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      }),
    ).toThrow();
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
          old_string: "secret",
          new_string: "redacted",
        },
        mode: "edit",
        riskLevel: editToolEntry.metadata.riskLevel,
        toolName: "Edit",
      },
      {
        ...editToolEntry.metadata,
        permission: editToolEntry.permission,
      },
      projectRules,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
    });
  });
});

function contextWith(
  fileSystemPort: MemoryFileSystem,
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
  return new Map([
    [
      createReadFileStatePathKey(filePath),
      {
        path: filePath,
        content,
        offset: options.offset,
        limit: options.limit,
        isPartialView: options.isPartialView ?? false,
        readAt: options.readAt ?? new Date(),
        revisionId: revisionFor(filePath, revisionContent, options.mtimeMs ?? 1).id,
        mtimeMs: options.mtimeMs ?? 1,
        sizeBytes: Buffer.byteLength(revisionContent, "utf8"),
      },
    ],
  ]);
}

interface MemoryFileSystem extends FileSystemPort {
  files: Map<string, string>;
  lastWrite?: FileSystemWriteTextRequest;
  sizes: Map<string, number>;
  mtimes: Map<string, number>;
  setMtime(path: string, mtimeMs: number): void;
  touch(path: string): void;
}

function createMemoryFileSystem(initial: Record<string, string>): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const sizes = new Map<string, number>();
  const mtimes = new Map<string, number>();
  const fs: MemoryFileSystem = {
    files,
    sizes,
    mtimes,
    setMtime(path, mtimeMs) {
      mtimes.set(path, mtimeMs);
    },
    touch(path) {
      mtimes.set(path, (mtimes.get(path) ?? 1) + 1);
    },
    async stat(request): Promise<FileSystemStatResult> {
      const content = files.get(request.path);
      if (content === undefined) throw missingFile(request.path);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      return {
        kind: "file",
        path: request.path,
        revision: revisionFor(request.path, content, mtimeMs),
        sizeBytes: sizes.get(request.path) ?? Buffer.byteLength(content, "utf8"),
        mtimeMs,
      };
    },
    async readTextFile(request): Promise<FileSystemReadTextResult> {
      const content = readTextOrThrow(request.path, files);
      const mtimeMs = mtimes.get(request.path) ?? 1;
      return {
        bytesRead: Buffer.byteLength(content, "utf8"),
        content: normalizeLineEndings(content),
        encoding: request.encoding ?? "utf8",
        lineEndings: detectLineEndings(content),
        path: request.path,
        revision: revisionFor(request.path, content, mtimeMs),
        sizeBytes: sizes.get(request.path) ?? Buffer.byteLength(content, "utf8"),
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
      fs.touch(request.path);
      return {
        bytesWritten: Buffer.byteLength(content, "utf8"),
        path: request.path,
        revision: revisionFor(request.path, content, mtimes.get(request.path) ?? 1),
      };
    },
    async removeFile(request) {
      const removed = files.delete(request.path);
      if (!removed && request.missingOk !== true) throw missingFile(request.path);
      return { path: request.path, removed };
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
      return { durationMs: 0, entries, numEntries: entries.length, path: request.path };
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
  return createFileSystemError({ code: "not_found", message: `missing: ${path}`, path });
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
    id: `rev:${path}:${content.length}:${Buffer.byteLength(content, "utf8")}:${mtimeMs}`,
    mtimeMs,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

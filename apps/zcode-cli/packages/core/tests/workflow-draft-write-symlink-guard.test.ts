// ZP-20261110-04：Write/Edit 处理器对草稿目录内的目标，必须把工作目录作为 symlinkFreeBase 交给 fs 端口，
// 由适配器在写入执行点逐级核验（见 adapters/tests/fs-workflow-draft-symlink.test.ts）。
// 普通路径不带该字段，行为不变。

import { describe, expect, it } from "vitest";
import {
  createFileSystemError,
  type FileSystemPort,
  type FileSystemWriteTextRequest,
} from "@zcode/contracts";
import { editHandler } from "../src/tool/handlers/edit.js";
import { writeHandler } from "../src/tool/handlers/write.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const WORKING_DIRECTORY = "/repo/project";

describe("Write handler workflow draft symlink guard", () => {
  it("passes the working directory as symlinkFreeBase for an absolute draft path", async () => {
    const port = createRecordingPort();
    await writeHandler(
      { file_path: `${WORKING_DIRECTORY}/.zcode/workflow-drafts/nightly.dwf.ts`, content: "x" },
      contextWith(port),
    );

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]?.symlinkFreeBase).toBe(WORKING_DIRECTORY);
  });

  it("passes symlinkFreeBase for a relative draft path resolved against the working directory", async () => {
    const port = createRecordingPort();
    await writeHandler(
      { file_path: ".zcode/workflow-drafts/nightly.dwf.ts", content: "x" },
      contextWith(port),
    );

    expect(port.writes[0]?.symlinkFreeBase).toBe(WORKING_DIRECTORY);
  });

  it("does not pass symlinkFreeBase for an ordinary workspace path", async () => {
    const port = createRecordingPort();
    await writeHandler({ file_path: "src/index.ts", content: "x" }, contextWith(port));

    expect(port.writes).toHaveLength(1);
    expect("symlinkFreeBase" in (port.writes[0] ?? {})).toBe(false);
  });
});

// Edit 与 Write 同属草稿免确认工具，写入走 writeEditResult，接线需单独守住。
// old_string 为空、文件不存在时走新建分支，直接进入写入。
describe("Edit handler workflow draft symlink guard", () => {
  it("passes the working directory as symlinkFreeBase for a draft path", async () => {
    const port = createRecordingPort();
    await editHandler(
      { file_path: ".zcode/workflow-drafts/nightly.dwf.ts", old_string: "", new_string: "x" },
      contextWith(port),
    );

    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]?.symlinkFreeBase).toBe(WORKING_DIRECTORY);
  });

  it("does not pass symlinkFreeBase for an ordinary workspace path", async () => {
    const port = createRecordingPort();
    await editHandler(
      { file_path: "src/index.ts", old_string: "", new_string: "x" },
      contextWith(port),
    );

    expect(port.writes).toHaveLength(1);
    expect("symlinkFreeBase" in (port.writes[0] ?? {})).toBe(false);
  });
});

function notFound(path: string): never {
  throw createFileSystemError({ code: "not_found", path, message: `File not found: ${path}` });
}

function createRecordingPort(): FileSystemPort & { writes: FileSystemWriteTextRequest[] } {
  const writes: FileSystemWriteTextRequest[] = [];
  // 只实现 Write/Edit 处理器用到的方法；读取和 stat 总是 not_found，让处理器直接进入写入。
  const port = {
    writes,
    async readTextFile(request: { path: string }) {
      notFound(request.path);
    },
    async stat(request: { path: string }) {
      notFound(request.path);
    },
    async writeTextFile(request: FileSystemWriteTextRequest) {
      writes.push(request);
      return { path: request.path, bytesWritten: request.content.length };
    },
  };
  return port as unknown as FileSystemPort & { writes: FileSystemWriteTextRequest[] };
}

function contextWith(fileSystemPort: FileSystemPort): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    spanId: "span_test",
    abortSignal: new AbortController().signal,
    fileSystemPort,
    readFileState: undefined,
    workingDirectory: WORKING_DIRECTORY,
    workspaceRoot: WORKING_DIRECTORY,
    sessionId: "sess_test",
    turnId: "turn_test",
  };
}

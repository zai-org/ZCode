import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  type FileSystemPort,
  type FileSystemRevision,
  type MessageId,
  type MessagePart,
  type MessageWithParts,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import {
  createReadFileStateMetadataFromEntry,
  parseReadFileStateMetadata,
} from "../src/tool/read-file-state-metadata.js";
import {
  createReadFileStatePathKey,
  hashReadFileStateContent,
  readFileStateContentMatches,
} from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 规格：docs/design/v2/tool/17-read-file-state-resume.md「快照不存正文」。
const STALE_MESSAGE = "File has been modified since read";
const NOT_READ_MESSAGE = "File has not been read yet";
const INITIAL_MTIME_MS = 1_000;
const TOUCH_STEP_MS = 1_000;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf16le").digest("hex");
}

describe("读取状态快照只存正文哈希", () => {
  it("新快照只存 contentSha256，不存正文", () => {
    const file = resolve("/tmp/zcode-read-state-hash/big.md");
    const content = "大文件正文\n".repeat(200_000);
    const sizeBytes = Buffer.byteLength(content, "utf8");

    const metadata = createReadFileStateMetadataFromEntry({
      completedAt: new Date(10),
      entry: {
        path: file,
        content,
        offset: undefined,
        limit: undefined,
        isPartialView: false,
        readAt: new Date(9),
        sourceTool: "Edit",
        revisionId: "rev-big",
        mtimeMs: INITIAL_MTIME_MS,
        sizeBytes,
      },
      toolName: "Edit",
    });

    expect(metadata).toEqual({
      schemaVersion: 1,
      tool: "Edit",
      path: file,
      contentSha256: sha256(content),
      isPartialView: false,
      readAtMs: 10,
      revisionId: "rev-big",
      mtimeMs: INITIAL_MTIME_MS,
      sizeBytes,
    });
    // 原来每次 Edit 都把整份文件写进 metadata；现在快照大小与文件大小无关。
    expect(JSON.stringify(metadata).length).toBeLessThan(1_000);
  });

  it("按字段区分新旧快照：有 contentSha256 得到哈希，没有时降级读正文", () => {
    const file = resolve("/tmp/zcode-read-state-hash/parse.ts");
    const freshness = {
      isPartialView: false,
      mtimeMs: INITIAL_MTIME_MS,
      path: file,
      readAtMs: 2,
      revisionId: "rev-parse",
      schemaVersion: 1,
      sizeBytes: 6,
      tool: "Edit",
    };

    const current = parseReadFileStateMetadata({
      readFileState: { ...freshness, contentSha256: sha256("after\n") },
    });
    expect(current).toMatchObject({ contentSha256: sha256("after\n"), path: file });
    expect(current).not.toHaveProperty("content");

    const legacy = parseReadFileStateMetadata({
      readFileState: { ...freshness, content: "after\n" },
    });
    expect(legacy).toMatchObject({ content: "after\n", path: file });
    expect(legacy).not.toHaveProperty("contentSha256");

    // 两个字段都没有就不参与恢复。
    expect(parseReadFileStateMetadata({ readFileState: freshness })).toBeUndefined();
  });

  it("只有哈希的记录与比较正文结果一致：只差一个孤立代理字符也判为不同", () => {
    // UTF-8 编码会把孤立代理字符都换成 U+FFFD，这两个正文按 UTF-8 算出的哈希相同。
    const before = "x\uD800y";
    const after = "x\uDC00y";
    const hashOnly = {
      path: resolve("/tmp/zcode-read-state-hash/surrogate.txt"),
      contentSha256: hashReadFileStateContent(before),
      isPartialView: false,
      readAt: new Date(1),
    };

    expect(readFileStateContentMatches({ ...hashOnly, content: before }, after)).toBe(false);
    expect(readFileStateContentMatches(hashOnly, after)).toBe(false);
    expect(readFileStateContentMatches(hashOnly, before)).toBe(true);
  });

  it("hydrator 把新快照恢复成只有哈希的记录，旧快照仍恢复正文", async () => {
    const workspaceRoot = resolve("/tmp/zcode-read-state-hash-hydrate");
    const currentFile = resolve(workspaceRoot, "current.ts");
    const legacyFile = resolve(workspaceRoot, "legacy.ts");
    const sessionID = createSessionId("read-state-hash-hydrate");
    const messageID = createMessageId("read-state-hash-hydrate-assistant");
    const readFileState: ReadFileStateMap = new Map();
    const snapshot = (path: string, body: Record<string, unknown>) => ({
      readFileState: {
        ...body,
        isPartialView: false,
        mtimeMs: INITIAL_MTIME_MS,
        path,
        readAtMs: 2,
        revisionId: `rev:${path}`,
        sizeBytes: 6,
        tool: "Edit",
      },
    });
    const editPart = (id: string, path: string, metadata: Record<string, unknown>) => ({
      callID: id,
      id: createPartId(id),
      messageID,
      sessionID,
      state: {
        input: { file_path: path, old_string: "before", new_string: "after" },
        metadata,
        output: "The file has been updated successfully.",
        status: "completed",
        title: "Edit",
        time: { start: 1, end: 2 },
      },
      tool: "Edit",
      type: "tool",
    });

    const result = await hydrateReadFileStateFromSession({
      messages: [
        {
          info: { id: messageID, role: "assistant", sessionID },
          parts: [
            editPart(
              "edit-current",
              currentFile,
              snapshot(currentFile, { schemaVersion: 1, contentSha256: sha256("after\n") }),
            ),
            editPart(
              "edit-legacy",
              legacyFile,
              snapshot(legacyFile, { schemaVersion: 1, content: "after\n" }),
            ),
          ],
        },
      ] as never,
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    const current = readFileState.get(createReadFileStatePathKey(currentFile));
    expect(current).toMatchObject({ contentSha256: sha256("after\n"), sourceTool: "Edit" });
    expect(current).not.toHaveProperty("content");
    const legacy = readFileState.get(createReadFileStatePathKey(legacyFile));
    expect(legacy).toMatchObject({ content: "after\n", sourceTool: "Edit" });
    expect(legacy).not.toHaveProperty("contentSha256");
  });

  it("冷恢复只有哈希的 Edit 快照：只 touch 时放行，内容变化时报 stale", async () => {
    const workingDirectory = resolve("/tmp/zcode-read-state-hash-edit");
    const file = resolve(workingDirectory, "target.txt");
    const sessionId = createSessionId("read-state-hash-edit");
    const store = await createSessionStore(sessionId, workingDirectory);
    const fileSystem = createTouchableFileSystem({ [file]: "alpha\nbeta\n" });

    await runScriptedTurn({
      fileSystem,
      sessionId,
      store,
      toolCalls: [
        { id: "hash-edit-read", input: { file_path: file }, name: "Read" },
        {
          id: "hash-edit-edit",
          input: { file_path: file, old_string: "alpha", new_string: "gamma" },
          name: "Edit",
        },
      ],
      workingDirectory,
    });

    const readSnapshot = await completedSnapshot(store, sessionId, "hash-edit-read");
    expect(readSnapshot).toMatchObject({
      schemaVersion: 1,
      tool: "Read",
      contentSha256: sha256("alpha\nbeta\n"),
    });
    expect(readSnapshot).not.toHaveProperty("content");
    const editSnapshot = await completedSnapshot(store, sessionId, "hash-edit-edit");
    expect(editSnapshot).toMatchObject({
      schemaVersion: 1,
      tool: "Edit",
      contentSha256: sha256("gamma\nbeta\n"),
    });
    expect(editSnapshot).not.toHaveProperty("content");

    // 只 touch：mtime 前进、内容不变。冷恢复记录没有正文，按哈希判断内容相同，放行。
    fileSystem.touch(file);
    const touched = await resumeAndExecute({
      fileSystem,
      sessionId,
      store,
      toolCall: {
        id: "hash-edit-after-touch",
        input: { file_path: file, old_string: "gamma", new_string: "delta" },
        name: "Edit",
      },
      workingDirectory,
    });
    expect(touched.restoredCount).toBeGreaterThan(0);
    expect(touched.result.success).toBe(true);
    expect(fileSystem.content(file)).toBe("delta\nbeta\n");

    // 内容变化且大小不变：只能靠哈希发现差异，必须报 stale，不能改文件。
    fileSystem.replace(file, "delta\nBETA\n");
    const changed = await resumeAndExecute({
      fileSystem,
      sessionId,
      store,
      toolCall: {
        id: "hash-edit-after-change",
        input: { file_path: file, old_string: "delta", new_string: "epsilon" },
        name: "Edit",
      },
      workingDirectory,
    });
    expect(changed.result.success).toBe(false);
    expect(changed.result.error?.message).toContain(STALE_MESSAGE);
    expect(fileSystem.content(file)).toBe("delta\nBETA\n");
  });

  it("冷恢复只有哈希的 Read / Write 快照：只 touch 时 Write 放行，内容变化时报 stale", async () => {
    const workingDirectory = resolve("/tmp/zcode-read-state-hash-write");
    const file = resolve(workingDirectory, "target.txt");
    const sessionId = createSessionId("read-state-hash-write");
    const store = await createSessionStore(sessionId, workingDirectory);
    const fileSystem = createTouchableFileSystem({ [file]: "alpha\n" });

    await runScriptedTurn({
      fileSystem,
      sessionId,
      store,
      toolCalls: [{ id: "hash-write-read", input: { file_path: file }, name: "Read" }],
      workingDirectory,
    });

    fileSystem.touch(file);
    const afterRead = await resumeAndExecute({
      fileSystem,
      sessionId,
      store,
      toolCall: {
        id: "hash-write-after-read",
        input: { file_path: file, content: "bravo\n" },
        name: "Write",
      },
      workingDirectory,
    });
    expect(afterRead.result.success).toBe(true);
    expect(fileSystem.content(file)).toBe("bravo\n");
    const writeSnapshot = await completedSnapshot(store, sessionId, "hash-write-after-read");
    expect(writeSnapshot).toMatchObject({
      schemaVersion: 1,
      tool: "Write",
      contentSha256: sha256("bravo\n"),
    });
    expect(writeSnapshot).not.toHaveProperty("content");

    fileSystem.replace(file, "BRAVO\n");
    const changed = await resumeAndExecute({
      fileSystem,
      sessionId,
      store,
      toolCall: {
        id: "hash-write-after-change",
        input: { file_path: file, content: "charlie\n" },
        name: "Write",
      },
      workingDirectory,
    });
    expect(changed.result.success).toBe(false);
    expect(changed.result.error?.message).toContain(STALE_MESSAGE);
    expect(fileSystem.content(file)).toBe("BRAVO\n");
  });

  it("同进程 rewind 从新快照重建只有哈希的记录：内容变化报 stale，内容相同时放行", async () => {
    const workingDirectory = resolve("/tmp/zcode-read-state-hash-rewind");
    const file = resolve(workingDirectory, "target.txt");
    const sessionId = createSessionId("read-state-hash-rewind");
    const store = await createSessionStore(sessionId, workingDirectory);
    // 会话级 rewind 把分支信息写回会话；本测试之后直接调执行器，不再读它。
    Object.assign(store, { async setRevert() {} });
    const fileSystem = createTouchableFileSystem({ [file]: "alpha\nbeta\n" });
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const toolStep = (id: string, name: string, input: Record<string, unknown>) => ({
      finishReason: "tool-calls",
      text: name,
      toolCalls: [{ id, input, name }],
      usage,
    });
    const stop = { finishReason: "stop", text: "done", usage };
    const runtime = createRuntime({
      fileSystem,
      modelResponses: [
        toolStep("rewind-read", "Read", { file_path: file }),
        toolStep("rewind-edit-kept", "Edit", {
          file_path: file,
          old_string: "alpha",
          new_string: "gamma",
        }),
        stop,
        toolStep("rewind-edit-removed", "Edit", {
          file_path: file,
          old_string: "gamma",
          new_string: "delta",
        }),
        stop,
      ],
      sessionId,
      store,
      workingDirectory,
    });
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    expect(fileSystem.content(file)).toBe("delta\nbeta\n");

    await runtime.rewindConversationToMessage({
      events: [],
      targetMessageId: userMessageId(await store.messages({ sessionID: sessionId }), "second"),
      traceContext: createRootTraceContext({ sessionId }),
    });

    // rewind 按 active history 重建：只剩第一轮 Edit 的快照，重建出的记录只有哈希，没有正文。
    const readFileState = (runtime as unknown as { readFileState: ReadFileStateMap }).readFileState;
    const rebuilt = readFileState.get(createReadFileStatePathKey(file));
    expect(rebuilt).toMatchObject({ contentSha256: sha256("gamma\nbeta\n"), sourceTool: "Edit" });
    expect(rebuilt).not.toHaveProperty("content");

    // 会话级 rewind 不改磁盘，文件仍是被回退那轮写下的内容，大小相同：只能靠哈希发现差异，
    // 必须报 stale，不能改文件。
    const changed = await runtime.getToolExecutor().execute({
      id: createToolCallId("rewind-edit-after-change"),
      input: { file_path: file, old_string: "delta", new_string: "epsilon" },
      name: "Edit",
    });
    expect(changed.success).toBe(false);
    expect(changed.error?.message).toContain(STALE_MESSAGE);
    expect(fileSystem.content(file)).toBe("delta\nbeta\n");

    // 内容改回与快照相同、mtime 仍前进：按哈希判断内容相同，放行。
    fileSystem.replace(file, "gamma\nbeta\n");
    const same = await runtime.getToolExecutor().execute({
      id: createToolCallId("rewind-edit-after-restore"),
      input: { file_path: file, old_string: "gamma", new_string: "epsilon" },
      name: "Edit",
    });
    expect(same.success).toBe(true);
    expect(fileSystem.content(file)).toBe("epsilon\nbeta\n");
  });

  it("升级前带正文、没有 contentSha256 的旧快照冷恢复后，只 touch 仍放行", async () => {
    const workingDirectory = resolve("/tmp/zcode-read-state-hash-legacy");
    const file = resolve(workingDirectory, "target.txt");
    const sessionId = createSessionId("read-state-hash-legacy");
    const store = await createSessionStore(sessionId, workingDirectory);
    const fileSystem = createTouchableFileSystem({ [file]: "after\n" });
    const assistantMessageId = createMessageId("read-state-hash-legacy-assistant");
    await store.saveMessage(assistantMessage(sessionId, assistantMessageId, workingDirectory));
    await store.savePart({
      callID: "legacy-edit",
      id: createPartId("legacy-edit"),
      messageID: assistantMessageId,
      sessionID: sessionId,
      state: {
        input: { file_path: file, old_string: "before", new_string: "after" },
        // 升级前的版本写下的形状：正文全文，没有 contentSha256。
        metadata: {
          readFileState: {
            content: "after\n",
            isPartialView: false,
            mtimeMs: INITIAL_MTIME_MS,
            path: file,
            readAtMs: 10,
            revisionId: fileSystem.revisionId(file),
            schemaVersion: 1,
            sizeBytes: Buffer.byteLength("after\n", "utf8"),
            tool: "Edit",
          },
          schemaVersion: 1,
        },
        output: "The file has been updated successfully.",
        status: "completed",
        title: "Edit",
        time: { start: 9, end: 10 },
      },
      tool: "Edit",
      type: "tool",
    } as MessagePart);

    fileSystem.touch(file);
    const touched = await resumeAndExecute({
      fileSystem,
      sessionId,
      store,
      toolCall: {
        id: "legacy-edit-after-touch",
        input: { file_path: file, old_string: "after", new_string: "later" },
        name: "Edit",
      },
      workingDirectory,
    });
    expect(touched.restoredCount).toBe(1);
    expect(touched.result.success).toBe(true);
    expect(touched.result.error?.message ?? "").not.toContain(NOT_READ_MESSAGE);
    expect(fileSystem.content(file)).toBe("later\n");
  });
});

interface TouchableFileSystem extends FileSystemPort {
  content(path: string): string | undefined;
  replace(path: string, content: string): void;
  revisionId(path: string): string;
  touch(path: string): void;
}

/** 可控 mtime 的内存文件系统：touch 只推进 mtime，replace 同时改内容与 mtime。 */
function createTouchableFileSystem(initial: Record<string, string>): TouchableFileSystem {
  const files = new Map(
    Object.entries(initial).map(([path, content]) => [
      path,
      { content, mtimeMs: INITIAL_MTIME_MS },
    ]),
  );
  let clock = INITIAL_MTIME_MS;
  const existing = (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error(`missing file: ${path}`);
    return file;
  };
  const revision = (path: string): FileSystemRevision => {
    const file = existing(path);
    return {
      id: `rev:${path}:${file.mtimeMs}:${file.content.length}`,
      mtimeMs: file.mtimeMs,
      sizeBytes: Buffer.byteLength(file.content, "utf8"),
    };
  };
  const advance = (path: string, content: string) => {
    clock += TOUCH_STEP_MS;
    files.set(path, { content, mtimeMs: clock });
  };
  const textResult = (path: string) => {
    const { content } = existing(path);
    return {
      bytesRead: Buffer.byteLength(content, "utf8"),
      content,
      encoding: "utf8",
      lineEndings: "LF",
      path,
      revision: revision(path),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
    };
  };
  return {
    content: (path: string) => files.get(path)?.content,
    replace: (path: string, content: string) => advance(path, content),
    revisionId: (path: string) => revision(path).id,
    touch: (path: string) => advance(path, existing(path).content),
    async stat(request: { path: string }) {
      const file = existing(request.path);
      return {
        kind: "file",
        mtimeMs: file.mtimeMs,
        path: request.path,
        revision: revision(request.path),
        sizeBytes: Buffer.byteLength(file.content, "utf8"),
      };
    },
    async readTextFile(request: { path: string }) {
      return textResult(request.path);
    },
    async readTextFileRange(request: { path: string }) {
      const lines = existing(request.path).content.split("\n").length;
      return { ...textResult(request.path), lineCount: lines, startLine: 1, totalLines: lines };
    },
    async writeTextFile(request: { path: string; content: string }) {
      advance(request.path, request.content);
      return {
        bytesWritten: Buffer.byteLength(request.content, "utf8"),
        path: request.path,
        revision: revision(request.path),
      };
    },
  } as unknown as TouchableFileSystem;
}

async function createSessionStore(
  sessionId: SessionId,
  workingDirectory: string,
): Promise<SessionStorePort> {
  const store = createRecordingSubagentSessionStore();
  await store.createSession({
    directory: workingDirectory,
    id: sessionId,
    projectID: createProjectId(`${sessionId}-project`),
    slug: sessionId,
    title: "read state hash",
    version: "test",
    time: { created: 1, updated: 1 },
  });
  return store;
}

function assistantMessage(
  sessionId: SessionId,
  id: ReturnType<typeof createMessageId>,
  workingDirectory: string,
) {
  return {
    agent: "zcode-agent",
    cost: 0,
    id,
    mode: "build",
    modelID: "model-test",
    parentID: createMessageId(`${id}-user`),
    path: { cwd: workingDirectory, root: workingDirectory },
    providerID: "provider-test",
    role: "assistant" as const,
    sessionID: sessionId,
    time: { created: 10 },
    tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
  };
}

function createRuntime(input: {
  fileSystem: TouchableFileSystem;
  modelResponses?: unknown[];
  sessionId: SessionId;
  store: SessionStorePort;
  workingDirectory: string;
}) {
  const responses = input.modelResponses ?? [];
  return createTestAgentRuntime(
    input.sessionId,
    { agentName: "read-state-hash-test", mode: "edit", workingDirectory: input.workingDirectory },
    {
      eventStore: createTestSessionEventStore(),
      fileSystemPort: input.fileSystem,
      modelFactory: createTestModelFactory({
        async generateText() {
          const response = responses.shift();
          if (!response) throw new Error("unexpected model request");
          return response;
        },
      } as never),
      sessionStore: input.store,
    },
  );
}

async function runScriptedTurn(input: {
  fileSystem: TouchableFileSystem;
  sessionId: SessionId;
  store: SessionStorePort;
  toolCalls: Array<{ id: string; input: Record<string, unknown>; name: string }>;
  workingDirectory: string;
}): Promise<void> {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const runtime = createRuntime({
    ...input,
    modelResponses: [
      ...input.toolCalls.map((toolCall) => ({
        finishReason: "tool-calls",
        text: toolCall.name,
        toolCalls: [toolCall],
        usage,
      })),
      { finishReason: "stop", text: "done", usage },
    ],
  });
  await runtime.executeTurn("run the read-state hash steps");
}

/** 新 runtime 从 store 冷恢复，再直接执行一次工具调用。 */
async function resumeAndExecute(input: {
  fileSystem: TouchableFileSystem;
  sessionId: SessionId;
  store: SessionStorePort;
  toolCall: { id: string; input: Record<string, unknown>; name: string };
  workingDirectory: string;
}) {
  const runtime = createRuntime(input);
  const resumed = await runtime.resumeFromStore();
  const result = await runtime.getToolExecutor().execute({
    ...input.toolCall,
    id: createToolCallId(input.toolCall.id),
  });
  // resumeAndExecute 绕过了模型回合，自己把结果落成 completed tool part，模拟这次调用写入的历史。
  if (result.success && result.readFileStateMetadata) {
    const messageID = createMessageId(`${input.toolCall.id}-assistant`);
    await input.store.saveMessage(
      assistantMessage(input.sessionId, messageID, input.workingDirectory),
    );
    await input.store.savePart({
      callID: input.toolCall.id,
      id: createPartId(input.toolCall.id),
      messageID,
      sessionID: input.sessionId,
      state: {
        input: input.toolCall.input,
        metadata: { readFileState: result.readFileStateMetadata },
        output: "ok",
        status: "completed",
        title: input.toolCall.name,
        time: { start: 1, end: 2 },
      },
      tool: input.toolCall.name,
      type: "tool",
    } as MessagePart);
  }
  return { restoredCount: resumed.readFileStateRestoredCount, result };
}

function userMessageId(messages: MessageWithParts[], text: string): MessageId {
  const message = messages.find(
    (candidate) =>
      candidate.info.role === "user" &&
      candidate.parts.some((part) => part.type === "text" && part.text === text),
  );
  if (!message) throw new Error(`missing user message: ${text}`);
  return message.info.id as MessageId;
}

async function completedSnapshot(
  store: SessionStorePort,
  sessionId: SessionId,
  callID: string,
): Promise<Record<string, unknown> | undefined> {
  const messages = await store.messages({ sessionID: sessionId });
  const part = messages
    .flatMap((message) => message.parts)
    .find(
      (candidate) =>
        candidate.type === "tool" &&
        candidate.callID === callID &&
        candidate.state.status === "completed",
    );
  if (part?.type !== "tool" || part.state.status !== "completed") return undefined;
  return (part.state.metadata as { readFileState?: Record<string, unknown> } | undefined)
    ?.readFileState;
}

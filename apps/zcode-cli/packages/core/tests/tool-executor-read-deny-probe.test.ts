import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  type CollaborationMode,
  type MessageWithParts,
  type PermissionRuleset,
  type SessionStorePort,
} from "@zcode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { restorePostCompactFiles } from "../src/runtime/helpers/compact-post-reminders.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ReadFileStateMap } from "../src/tool/types.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const workspace = "/tmp/zcode-read-deny-probe";
const denied = `${workspace}/secret.env`;
const asked = `${workspace}/asked.ts`;
const plain = `${workspace}/plain.ts`;
const sessionRules: PermissionRuleset = {
  version: 1,
  scope: "session",
  ask: [{ toolName: "Read", ruleContent: asked }],
  deny: [{ toolName: "Read", ruleContent: denied }],
};

function createExecutor(mode: CollaborationMode) {
  const sessionId = createSessionId("read-deny-probe");
  const getSession = vi.fn(async () => ({ id: sessionId, permission: sessionRules }));
  const registry = createToolRegistry();
  registry.register(readToolEntry);
  const executor = createToolExecutor({
    emitEvent: async () => {},
    fileSystemPort: new MemoryFileSystem({ [denied]: "TOKEN=1\n" }),
    mode,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    sessionStore: { getSession } as unknown as SessionStorePort,
    workingDirectory: workspace,
    workspaceRoot: workspace,
  });
  return { executor, getSession, traceContext: createRootTraceContext({ sessionId }) };
}

describe("Read deny probe without prompt", () => {
  it("judges a batch of Reads like Read tool calls and loads the rules once", async () => {
    const { executor, getSession, traceContext } = createExecutor("build");

    await expect(
      executor.areReadsDeniedWithoutPrompt([denied, asked, plain], traceContext),
    ).resolves.toEqual([true, false, false]);
    expect(getSession).toHaveBeenCalledTimes(1);

    // 同一条 deny 规则下，真实的 Read 调用也被拒绝。
    const toolCall = await executor.execute(
      { id: createToolCallId("read-denied"), input: { file_path: denied }, name: "Read" },
      { traceContext },
    );
    expect(toolCall.success).toBe(false);
    expect(toolCall.error?.message).toContain("denied by project permission rules");
  });

  it("follows the mode like a Read tool call", async () => {
    const { executor, traceContext } = createExecutor("yolo");

    await expect(executor.areReadsDeniedWithoutPrompt([denied], traceContext)).resolves.toEqual([
      false,
    ]);
  });
});

// 冷恢复只认带 revision 的读取状态快照；给内存文件系统补上按内容计算的 revision。
class RevisionedMemoryFileSystem extends MemoryFileSystem {
  private revisionOf(path: string) {
    const sizeBytes = Buffer.byteLength(this.files[path] ?? "", "utf8");
    return { id: `${path}:${sizeBytes}`, mtimeMs: 1, sizeBytes };
  }

  override async stat(request: { path: string }) {
    return { ...(await super.stat(request)), mtimeMs: 1, revision: this.revisionOf(request.path) };
  }

  override async readTextFile(request: { path: string; maxBytes?: number }) {
    return { ...(await super.readTextFile(request)), revision: this.revisionOf(request.path) };
  }

  override async writeTextFile(request: { content: string; path: string }) {
    return { ...(await super.writeTextFile(request)), revision: this.revisionOf(request.path) };
  }
}

describe("compaction restore under a Read deny rule written as a relative path", () => {
  // 修复原因：规则按原始字符串匹配，补回只用规范化后的绝对路径判定，相对写法的 deny 规则拦不住补回：
  // 模型用同一写法 Write 新建文件、用户填入密钥、同一写法 Read 被拒，compaction 补回却重读磁盘把密钥发给模型。
  const relativeRules: PermissionRuleset = {
    version: 1,
    scope: "session",
    deny: [{ toolName: "Read", ruleContent: "secret.env" }],
  };

  async function writeReadAndRestore(coldResume: boolean) {
    const sessionId = createSessionId("read-deny-restore");
    const traceContext = createRootTraceContext({ sessionId });
    const readFileState: ReadFileStateMap = new Map();
    const registry = createToolRegistry();
    registry.register(readToolEntry);
    registry.register(writeToolEntry);
    const fileSystemPort = new RevisionedMemoryFileSystem({});
    const executor = createToolExecutor({
      emitEvent: async () => {},
      fileSystemPort,
      mode: "edit",
      permissionService: new PermissionService(defaultPermissionConfig),
      readFileState,
      registry,
      sessionId,
      sessionStore: {
        getSession: async () => ({ id: sessionId, permission: relativeRules }),
      } as unknown as SessionStorePort,
      workingDirectory: workspace,
      workspaceRoot: workspace,
    });
    const writes = [
      { file_path: "secret.env", content: "TOKEN=1\n" },
      { file_path: "plain.ts", content: "export const plain = 1;\n" },
    ];
    const results = [];
    for (const [index, input] of writes.entries()) {
      const result = await executor.execute(
        { id: createToolCallId(`write-${index}`), input, name: "Write" },
        { traceContext },
      );
      expect(result.success).toBe(true);
      results.push(result);
    }
    // 同一写法的 Read 调用被拒绝。
    const read = await executor.execute(
      { id: createToolCallId("read-secret"), input: { file_path: "secret.env" }, name: "Read" },
      { traceContext },
    );
    expect(read.success).toBe(false);
    // 原始写法不写进快照，冷恢复从 tool part 的输入取：没有这个字段的旧记录也能按它判定。
    for (const result of results)
      expect(result.readFileStateMetadata).not.toHaveProperty("requestedPath");

    if (coldResume) {
      const messages = [
        {
          info: { id: "msg-1", role: "assistant" },
          parts: writes.map((input, index) => ({
            id: `part-${index}`,
            type: "tool",
            tool: "Write",
            callId: `call-${index}`,
            state: {
              status: "completed",
              input,
              output: results[index]!.output,
              metadata: { readFileState: results[index]!.readFileStateMetadata },
            },
          })),
        },
      ] as unknown as MessageWithParts[];
      readFileState.clear();
      await hydrateReadFileStateFromSession({
        markRestoredFromSession: true,
        messages,
        readFileState,
        workingDirectory: workspace,
        workspaceRoot: workspace,
      });
      expect(readFileState.size).toBe(2);
    }

    return restorePostCompactFiles(
      {
        executor,
        fileSystemPort,
        readFileState,
        sessionId,
        workingDirectory: workspace,
        workspaceRoot: workspace,
      } as never,
      { preservedEntries: [], traceContext },
    );
  }

  it.each([false, true])(
    "skips the file the relative rule denies and restores the others (cold resume=%s)",
    async (coldResume) => {
      const restore = await writeReadAndRestore(coldResume);
      const texts = restore.entries.map((entry) =>
        "content" in entry ? String(entry.content) : JSON.stringify(entry),
      );

      // 一个文件两条：调用说明一条，结果一条。
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain(`${workspace}/plain.ts`);
      expect(texts[1]).toContain("export const plain = 1;");
      expect(texts.join("\n")).not.toContain("TOKEN=1");
      expect(restore.readFileStateEntries.map((entry) => entry.path)).toEqual([
        `${workspace}/plain.ts`,
      ]);
      // 写回的记录保留原始写法，下一次 compaction 仍按它判定。
      expect(restore.readFileStateEntries.map((entry) => entry.requestedPath)).toEqual([
        "plain.ts",
      ]);
    },
  );
});

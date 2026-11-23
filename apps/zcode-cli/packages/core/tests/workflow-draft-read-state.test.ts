import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_DRAFTS_DIR,
  createFileSystemError,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type FileSystemPort,
  type MessageWithParts,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { saveSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";
import { findLatestReadFileState, hashReadFileStateContent } from "../src/tool/read-file-state.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

// docs/dynamic-workflow/launch.md「An inline draft counts as written by the model」：内联草稿的
// 字节就是模型那次调用的 `script`，所以 NOTE 要求的那一次 Edit 不必先 Read；而模型没亲手写过的
// 草稿（saved 拷贝、沿用的前驱脚本）照旧要先读，外部改动照旧判 stale。

const cwds: string[] = [];

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-draft-read-state-"));
  cwds.push(dir);
  return dir;
}

afterEach(() => {
  while (cwds.length > 0) rmSync(cwds.pop()!, { force: true, recursive: true });
});

const BROKEN_SCRIPT = 'const broken: number = "not a number";';
const FIXED_LITERAL = "1";
const FILE_NOT_READ = "File has not been read yet";
const STALE = "modified since";

function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

function draftPath(cwd: string, fileName: string): string {
  return join(cwd, WORKFLOW_DRAFTS_DIR, fileName);
}

/** 真盘上的最小端口：草稿由 node:fs 写下，Edit 必须经端口读到同一个文件。 */
function realFileSystemPort(): FileSystemPort {
  const revisionOf = async (path: string) => {
    const info = await stat(path);
    return { id: `${info.mtimeMs}:${info.size}`, mtimeMs: info.mtimeMs, sizeBytes: info.size };
  };
  const port = {
    async stat(request: { path: string }) {
      try {
        const info = await stat(request.path);
        return {
          path: request.path,
          kind: info.isDirectory() ? "directory" : "file",
          sizeBytes: info.size,
          mtimeMs: info.mtimeMs,
          revision: info.isFile() ? await revisionOf(request.path) : undefined,
        };
      } catch {
        throw createFileSystemError({ code: "not_found", path: request.path, message: "missing" });
      }
    },
    async readTextFile(request: { path: string }) {
      let content: string;
      try {
        content = await readFile(request.path, "utf8");
      } catch {
        throw createFileSystemError({ code: "not_found", path: request.path, message: "missing" });
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      return {
        path: request.path,
        content,
        encoding: "utf8",
        bytesRead: sizeBytes,
        sizeBytes,
        truncated: false,
        revision: await revisionOf(request.path),
      };
    },
    async writeTextFile(request: { path: string; content: string }) {
      await mkdir(dirname(request.path), { recursive: true });
      await writeFile(request.path, request.content, "utf8");
      return {
        path: request.path,
        bytesWritten: Buffer.byteLength(request.content, "utf8"),
        revision: await revisionOf(request.path),
      };
    },
  };
  return port as unknown as FileSystemPort;
}

function stubRunPort(runScript?: string, name?: string): DynamicWorkflowRunPort {
  return {
    async submit() {
      return { ok: true, runId: "dwfrun-new" };
    },
    async amend() {
      return { ok: true, runId: "dwfrun-amended" };
    },
    async getTask(taskId: string) {
      return {
        runId: taskId,
        taskId,
        startedAt: new Date(0),
        status: "running",
        ...(name === undefined ? {} : { name }),
      } as DynamicWorkflowRunSnapshot;
    },
    ...(runScript === undefined
      ? {}
      : {
          async getScript() {
            return runScript;
          },
        }),
  } as unknown as DynamicWorkflowRunPort;
}

interface Session {
  readFileState: ReadFileStateMap;
  call(toolName: string, input: Record<string, unknown>): Promise<ToolExecutionResult>;
}

/** 一个会话：同一张 readFileState 贯穿前后两次工具调用，和真实 runtime 一样。 */
function session(cwd: string, port: DynamicWorkflowRunPort): Session {
  const readFileState: ReadFileStateMap = new Map();
  const sessionId = createSessionId("draft-read-state");
  const turnId = createTurnId("draft-read-state");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(createWorkflowToolEntry);
  registry.register(amendWorkflowToolEntry);
  registry.register(editToolEntry);
  const executor = createToolExecutor({
    emitEvent: async () => {},
    dynamicWorkflowRunPort: port,
    fileSystemPort: realFileSystemPort(),
    mode: "build",
    permissionBroker: {
      async requestPermission() {
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    readFileState,
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: cwd,
  });
  let calls = 0;
  return {
    readFileState,
    async call(toolName, input) {
      calls += 1;
      return executor.execute(
        { id: createToolCallId(`draft-read-state-${calls}`), input, name: toolName },
        { traceContext },
      );
    },
  };
}

function editInput(filePath: string): Record<string, unknown> {
  return { file_path: filePath, old_string: '"not a number"', new_string: FIXED_LITERAL };
}

describe("an inline draft counts as written by the model", () => {
  it("CreateWorkflow: the Edit the failure note asks for needs no Read", async () => {
    const cwd = makeCwd();
    const s = session(cwd, stubRunPort());

    const created = await s.call("CreateWorkflow", { name: "triage", script: BROKEN_SCRIPT });
    expect((created.output as CreateWorkflowOutput).ok).toBe(false);
    const draft = draftPath(cwd, "triage.dwf.ts");

    const edited = await s.call("Edit", editInput(draft));
    expect(edited.error?.message).toBeUndefined();
    expect(edited.success).toBe(true);
    expect(readFileSync(draft, "utf8")).toBe(`const broken: number = ${FIXED_LITERAL};`);
  });

  it("AmendWorkflow: an inline revision's draft is editable too", async () => {
    const cwd = makeCwd();
    const s = session(cwd, stubRunPort(cleanScript("amend-prev"), "rev"));

    const amended = await s.call("AmendWorkflow", { run_id: "dwfrun-prev", script: BROKEN_SCRIPT });
    expect((amended.output as CreateWorkflowOutput).ok).toBe(false);

    const edited = await s.call("Edit", editInput(draftPath(cwd, "rev.dwf.ts")));
    expect(edited.success).toBe(true);
  });

  it("an external change after the submission is still refused as stale", async () => {
    const cwd = makeCwd();
    const s = session(cwd, stubRunPort());
    await s.call("CreateWorkflow", { name: "stale", script: BROKEN_SCRIPT });
    const draft = draftPath(cwd, "stale.dwf.ts");

    // 用户在编辑器里改了一笔：内容与 mtime 都前进。
    writeFileSync(draft, `${BROKEN_SCRIPT}\n// user note`, "utf8");
    const later = new Date(Date.now() + 5_000);
    utimesSync(draft, later, later);

    const edited = await s.call("Edit", editInput(draft));
    expect(edited.success).toBe(false);
    expect(edited.error?.message ?? "").toContain(STALE);
  });

  it("the copy of a saved workflow is not the model's bytes: Edit still asks for a Read", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "kept",
      meta: { description: "a saved one" },
      script: BROKEN_SCRIPT,
    });
    const s = session(cwd, stubRunPort());

    const created = await s.call("CreateWorkflow", { saved: { name: "kept" } });
    expect((created.output as CreateWorkflowOutput).ok).toBe(false);
    const draft = draftPath(cwd, "kept.dwf.ts");
    expect(readFileSync(draft, "utf8")).toContain(BROKEN_SCRIPT);

    const edited = await s.call("Edit", editInput(draft));
    expect(edited.success).toBe(false);
    expect(edited.error?.message ?? "").toContain(FILE_NOT_READ);
  });

  it("a kept predecessor script is not the model's bytes either", async () => {
    const cwd = makeCwd();
    const s = session(cwd, stubRunPort(BROKEN_SCRIPT, "inherited"));

    const amended = await s.call("AmendWorkflow", { run_id: "dwfrun-prev", subagent_model: null });
    expect((amended.output as CreateWorkflowOutput).ok).toBe(false);
    const draft = draftPath(cwd, "inherited.dwf.ts");
    expect(readFileSync(draft, "utf8")).toBe(BROKEN_SCRIPT);

    const edited = await s.call("Edit", editInput(draft));
    expect(edited.success).toBe(false);
    expect(edited.error?.message ?? "").toContain(FILE_NOT_READ);
  });

  it("survives a resume: the tool part's metadata restores the entry", async () => {
    const cwd = makeCwd();
    const s = session(cwd, stubRunPort());
    const created = await s.call("CreateWorkflow", { name: "resumed", script: BROKEN_SCRIPT });
    const draft = draftPath(cwd, "resumed.dwf.ts");
    expect(created.readFileStateMetadata).toMatchObject({
      tool: "CreateWorkflow",
      path: draft,
      contentSha256: hashReadFileStateContent(BROKEN_SCRIPT),
      isPartialView: false,
    });
    expect(created.readFileStateMetadata).not.toHaveProperty("content");

    const restored: ReadFileStateMap = new Map();
    const messages = [
      {
        info: { id: "msg-1", role: "assistant" },
        parts: [
          {
            id: "part-1",
            type: "tool",
            tool: "CreateWorkflow",
            callId: "call-1",
            state: {
              status: "completed",
              input: { name: "resumed", script: BROKEN_SCRIPT },
              output: created.output,
              metadata: { readFileState: created.readFileStateMetadata },
            },
          },
        ],
      },
    ] as unknown as MessageWithParts[];
    const result = await hydrateReadFileStateFromSession({
      messages,
      readFileState: restored,
      workingDirectory: cwd,
      workspaceRoot: cwd,
    });

    expect(result.restoredCount).toBe(1);
    const entry = findLatestReadFileState(restored, draft);
    expect(entry?.sourceTool).toBe("CreateWorkflow");
    expect(entry?.contentSha256).toBe(hashReadFileStateContent(BROKEN_SCRIPT));
    expect(entry?.mtimeMs).toBe(findLatestReadFileState(s.readFileState, draft)?.mtimeMs);
  });
});

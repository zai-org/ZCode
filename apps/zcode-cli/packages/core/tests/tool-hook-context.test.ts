import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type HookInput,
  type SessionEvent,
  type ToolArtifactStorePort,
  type ToolArtifactWriteRequest,
} from "@zcode/contracts";
import { NodeExecutionAdapter } from "../../adapters/src/exec/index.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import type { HookCallback } from "../src/hooks/types.js";
import { formatMcpToolResult } from "../src/mcp/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { isErrorForToolResult } from "../src/runtime/helpers/tool-result.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolHandler } from "../src/tool/types.js";

describe("ToolExecutor hook additional context", () => {
  it("keeps PreToolUse hook context out of the successful tool result", async () => {
    const fixture = createExecutorFixture("tool-hook-pre-context");
    fixture.registry.register(createTestToolEntry("ContextTool", async () => "tool-output"));
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "ContextTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "pre-tool context",
              hookEventName: input.hookEventName,
            },
          }),
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("pre-context"),
        input: {},
        name: "ContextTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toBe("tool-output");
    expect(result.serialization?.content).toBe("tool-output");
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:ContextTool hook additional context: pre-tool context",
    ]);
  });

  it("keeps the raw error as the failed tool result and carries Pre and Failure contexts", async () => {
    const fixture = createExecutorFixture("tool-hook-failure-context");
    fixture.registry.register(
      createTestToolEntry("FailingContextTool", async () => {
        throw new Error("tool exploded");
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "FailingContextTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "pre failure context",
              hookEventName: input.hookEventName,
            },
          }),
        },
        {
          event: HookEventName.PostToolUseFailure,
          matcher: "FailingContextTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "post failure context",
              hookEventName: input.hookEventName,
            },
          }),
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("pre-failure-context"),
        input: {},
        name: "FailingContextTool",
      },
      { traceContext: fixture.traceContext },
    );

    const withoutHooks = await fixture
      .createExecutor(createInMemoryHookRunner({ hooks: [] }))
      .execute(
        {
          id: createToolCallId("pre-failure-context-no-hooks"),
          input: {},
          name: "FailingContextTool",
        },
        { traceContext: fixture.traceContext },
      );

    expect(result.success).toBe(false);
    // 有 Hook 与没有 Hook 时，模型看到的是同一段错误原文。
    expect(result.modelContent).toEqual(withoutHooks.modelContent);
    expect(result.error?.message).toBe(withoutHooks.error?.message);
    expect(JSON.stringify(result.modelContent ?? "")).not.toContain("failure context");
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:FailingContextTool hook additional context: pre failure context",
      "PostToolUseFailure:FailingContextTool hook additional context: post failure context",
    ]);
  });

  it("keeps PreToolUse context when hook-updated input fails schema validation", async () => {
    const fixture = createExecutorFixture("tool-hook-invalid-update-context");
    let handlerRan = false;
    const entry = createTestToolEntry("InvalidHookUpdateTool", async () => {
      handlerRan = true;
      return "should-not-run";
    });
    entry.inputSchema = {
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
      type: "object",
    };
    fixture.registry.register(entry);
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "InvalidHookUpdateTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "invalid update context",
              hookEventName: input.hookEventName,
              updatedInput: {},
            },
          }),
        },
      ],
    });

    const result = await fixture.createExecutor(hookRunner).execute(
      {
        id: createToolCallId("invalid-hook-update-context"),
        input: { value: "valid-before-hook" },
        name: "InvalidHookUpdateTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      "PreToolUse hook for InvalidHookUpdateTool returned updatedInput that failed schema validation",
    );
    // 模型看到逐条问题和“模型自己的输入没错”一句，不加 <tool_use_error>（与 hook 拒绝相同）。
    expect(result.modelContent).toBe(
      [
        "PreToolUse hook for InvalidHookUpdateTool returned updatedInput that failed schema validation: InvalidHookUpdateTool failed due to the following issue:",
        "The required parameter `value` is missing",
        "The tool input from the model was valid; the hook's rewrite of it was not.",
      ].join("\n"),
    );
    expect(JSON.stringify(result.modelContent ?? "")).not.toContain("invalid update context");
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:InvalidHookUpdateTool hook additional context: invalid update context",
    ]);
    expect(handlerRan).toBe(false);
  });

  it("routes a handler failure through the existing failure lifecycle", async () => {
    const fixture = createExecutorFixture("tool-handler-failure");
    let handlerCalls = 0;
    let postSuccessRan = false;
    let postFailureRan = false;
    fixture.registry.register(
      createTestToolEntry("HandlerFailureTool", async () => {
        handlerCalls += 1;
        return {
          result: false,
          errorCode: 7,
          message: "Tool-specific failure",
        };
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "HandlerFailureTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "pre failure context",
              hookEventName: input.hookEventName,
            },
          }),
        },
        {
          event: HookEventName.PostToolUse,
          matcher: "HandlerFailureTool",
          callback: async () => {
            postSuccessRan = true;
            return {};
          },
        },
        {
          event: HookEventName.PostToolUseFailure,
          matcher: "HandlerFailureTool",
          callback: async (input) => {
            postFailureRan = true;
            return {
              hookSpecificOutput: {
                additionalContext: "post failure context",
                hookEventName: input.hookEventName,
              },
            };
          },
        },
      ],
    });

    const result = await fixture.createExecutor(hookRunner).execute(
      {
        id: createToolCallId("handler-failure"),
        input: {},
        name: "HandlerFailureTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: "7",
      message: "Tool-specific failure",
    });
    expect(result.modelContent).toBe("<tool_use_error>Tool-specific failure</tool_use_error>");
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:HandlerFailureTool hook additional context: pre failure context",
      "PostToolUseFailure:HandlerFailureTool hook additional context: post failure context",
    ]);
    expect(handlerCalls).toBe(1);
    expect(postSuccessRan).toBe(false);
    expect(postFailureRan).toBe(true);
    expect(fixture.events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallError,
    ]);
  });

  it("records non-blocking PostToolUse continue false without failing the tool", async () => {
    const fixture = createExecutorFixture("tool-hook-post-continue-false");
    const events: SessionEvent[] = [];
    let handlerRan = false;
    fixture.registry.register(
      createTestToolEntry("PostContinueTool", async () => {
        handlerRan = true;
        return "tool-output";
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          event: HookEventName.PostToolUse,
          matcher: "PostContinueTool",
          callback: async (input) => ({
            continue: false,
            reason: "post hook requested stop",
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
            },
          }),
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("post-continue-false"),
        input: {},
        name: "PostContinueTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(handlerRan).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      // D20：block 决策只产生一个终态事件（runner.ts:143 为 blocked ? Blocked : Completed）。
      // 此前同时断言 Completed + Blocked，会让「被拦截」在 UI 上呈现为已完成绿勾。
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunBlocked,
    ]);
  });

  it("matches Task hook matcher aliases without rewriting the Agent hook input", async () => {
    const fixture = createExecutorFixture("tool-hook-task-agent-alias");
    fixture.registry.register(createTestToolEntry("Agent", async () => "agent-output"));
    let observedToolName: string | undefined;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "Task",
          callback: async (input) => {
            observedToolName = "toolName" in input ? input.toolName : undefined;
            return {
              hookSpecificOutput: {
                additionalContext: "task matcher matched agent",
                hookEventName: input.hookEventName,
              },
            };
          },
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("agent-task-matcher"),
        input: {},
        name: "Agent",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:Agent hook additional context: task matcher matched agent",
    ]);
    expect(observedToolName).toBe("Agent");
  });

  it("matches Agent hook matcher aliases without rewriting the Task hook input", async () => {
    const fixture = createExecutorFixture("tool-hook-agent-task-alias");
    fixture.registry.register(createTestToolEntry("Task", async () => "task-output"));
    let observedToolName: string | undefined;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "Agent",
          callback: async (input) => {
            observedToolName = "toolName" in input ? input.toolName : undefined;
            return {
              hookSpecificOutput: {
                additionalContext: "agent matcher matched task",
                hookEventName: input.hookEventName,
              },
            };
          },
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("task-agent-matcher"),
        input: {},
        name: "Task",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.hookAdditionalContexts).toEqual([
      "PreToolUse:Task hook additional context: agent matcher matched task",
    ]);
    expect(observedToolName).toBe("Task");
  });
});

// hooks.md「失败的定义」：handler 正常返回、但结果是错误结果时，只运行 PostToolUseFailure；
// 判定与 tool_result 的 is_error 相同。真实 Bash 在全量并发下单次可到 4 秒以上，放宽到 15 秒。
describe.skipIf(process.platform === "win32")(
  "ToolExecutor hook event for error results",
  { timeout: 15_000 },
  () => {
    it("runs only PostToolUseFailure for a failed Bash command and passes the model text", async () => {
      const run = await runBashWithHooks(
        "hook-bash-failure",
        (root) => `ls ${join(root, "deliberately-nonexistent")}`,
      );

      expect(run.result.success).toBe(true);
      expect(isErrorForToolResult(run.result)).toBe(true);
      const modelText = String(run.result.modelContent);
      // ls 的退出码随系统不同（macOS 1，Linux 2）。
      expect(modelText).toMatch(/^Exit code \d+\nls: .*deliberately-nonexistent/u);
      expect(run.postInputs).toHaveLength(0);
      expect(run.failureInputs).toHaveLength(1);
      expect(run.failureInputs[0]).toMatchObject({
        error: { message: modelText, type: "tool_execution_failed" },
        hookEventName: HookEventName.PostToolUseFailure,
        isInterrupt: false,
        toolName: "Bash",
      });
      expect(run.failureInputs[0]).not.toHaveProperty("toolResponse");
      expect(run.result.hookAdditionalContexts).toEqual([
        "PostToolUseFailure:Bash hook additional context: AUDIT_PostToolUseFailure",
      ]);
    });

    it("runs only PostToolUseFailure for a Bash hard timeout, which is not an interrupt", async () => {
      const run = await runBashWithHooks(
        "hook-bash-timeout",
        () => "sleep 0.2; printf unexpected",
        {
          timeout: 10,
        },
      );

      expect(isErrorForToolResult(run.result)).toBe(true);
      const modelText = String(run.result.modelContent);
      expect(modelText).toMatch(/^Exit code 143\nCommand timed out after /u);
      expect(run.postInputs).toHaveLength(0);
      expect(run.failureInputs).toHaveLength(1);
      expect(run.failureInputs[0]).toMatchObject({
        error: { message: modelText, type: "tool_execution_failed" },
        isInterrupt: false,
      });
    });

    it("runs PostToolUse when grep exits 1 without matches", async () => {
      const run = await runBashWithHooks(
        "hook-grep-nomatch",
        (root) => `grep AUDIT_NO_SUCH_TEXT ${join(root, "sample.txt")}`,
      );

      expect(isErrorForToolResult(run.result)).toBe(false);
      expect(run.failureInputs).toHaveLength(0);
      expect(run.postInputs).toHaveLength(1);
      expect(run.result.hookAdditionalContexts).toEqual([
        "PostToolUse:Bash hook additional context: AUDIT_PostToolUse",
      ]);
    });
  },
);

// MCP 用例不调用 Bash，Windows 上也要跑。
describe("ToolExecutor hook event for an MCP error result", () => {
  it("runs only PostToolUseFailure when an MCP result has isError", async () => {
    const fixture = createExecutorFixture("hook-mcp-is-error");
    fixture.registry.register({
      ...createTestToolEntry("mcp__audit__quota", async () => ({
        content: [{ type: "text", text: "quota exhausted" }],
        isError: true,
      })),
      formatModelContent: formatMcpToolResult,
      outputSchema: { type: "object" },
    });
    const hooks = createRecordingHooks("mcp__audit__quota");

    const result = await fixture
      .createExecutor(hooks.hookRunner)
      .execute(
        { id: createToolCallId("hook-mcp-is-error-call"), input: {}, name: "mcp__audit__quota" },
        { traceContext: fixture.traceContext },
      );

    expect(isErrorForToolResult(result)).toBe(true);
    expect(result.modelContent).toBe("MCP tool returned an error:\nquota exhausted");
    expect(hooks.postInputs).toHaveLength(0);
    expect(hooks.failureInputs).toHaveLength(1);
    expect(hooks.failureInputs[0]).toMatchObject({
      error: { message: "MCP tool returned an error:\nquota exhausted" },
      isInterrupt: false,
    });
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUseFailure:mcp__audit__quota hook additional context: AUDIT_PostToolUseFailure",
    ]);
  });
});

async function runBashWithHooks(
  sessionName: string,
  command: (root: string) => string,
  extraInput: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-error-result-"));
  await writeFile(join(root, "sample.txt"), "AUDIT_SAMPLE first line\n");
  const executionPort = new NodeExecutionAdapter({ outputRootDir: root });
  const fixture = createExecutorFixture(sessionName);
  fixture.registry.register(bashToolEntry);
  const hooks = createRecordingHooks("Bash");
  try {
    const result = await createToolExecutor({
      emitEvent: async () => {},
      executionPort,
      hookRunner: hooks.hookRunner,
      mode: "yolo",
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: fixture.registry,
      sessionId: fixture.traceContext.sessionId!,
      traceContext: fixture.traceContext,
      turnId: fixture.traceContext.turnId!,
      workingDirectory: root,
    }).execute(
      {
        id: createToolCallId(`${sessionName}-call`),
        input: { command: command(root), description: "Audit exit status", ...extraInput },
        name: "Bash",
      },
      { traceContext: fixture.traceContext },
    );
    return { result, ...hooks };
  } finally {
    await executionPort.close();
    await rm(root, { recursive: true, force: true });
  }
}

// PostToolUse 与 PostToolUseFailure 各挂一个记录输入、返回固定 context 的 Hook。
function createRecordingHooks(matcher: string) {
  const postInputs: HookInput[] = [];
  const failureInputs: HookInput[] = [];
  const recordingHook =
    (inputs: HookInput[]): HookCallback =>
    async (input) => {
      inputs.push(input);
      return {
        hookSpecificOutput: {
          additionalContext: `AUDIT_${input.hookEventName}`,
          hookEventName: input.hookEventName,
        },
      };
    };
  const hookRunner = createInMemoryHookRunner({
    hooks: [
      { event: HookEventName.PostToolUse, matcher, callback: recordingHook(postInputs) },
      { event: HookEventName.PostToolUseFailure, matcher, callback: recordingHook(failureInputs) },
    ],
  });
  return { failureInputs, hookRunner, postInputs };
}

describe("ToolExecutor hook additional context size cap", () => {
  it("keeps a context of exactly 10000 chars unchanged", async () => {
    const context = "a".repeat(10_000);
    const store = createHookArtifactStore();
    const result = await executeWithPostContext("tool-hook-cap-exact", context, store);

    expect(store.requests).toHaveLength(0);
    expect(result.hookAdditionalContexts).toEqual([
      `PostToolUse:CapTool hook additional context: ${context}`,
    ]);
  });

  it("persists a longer context and shows a persisted-output preview", async () => {
    const context = "a".repeat(12_000);
    const store = createHookArtifactStore();
    const result = await executeWithPostContext("tool-hook-cap-persist", context, store);

    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]).toMatchObject({ content: context, contentType: "text/plain" });
    expect(result.hookAdditionalContexts).toEqual([
      "PostToolUse:CapTool hook additional context: <persisted-output>\n" +
        "Output too large (11.7KB). Full output saved to: /artifacts/hook-1.txt\n\n" +
        `Preview (first 2KB):\n${"a".repeat(2_000)}\n...\n</persisted-output>`,
    ]);
  });

  it("keeps the first 10000 chars and the reason when the write fails", async () => {
    const context = `${"a".repeat(9_999)}😀tail`;
    const store = createHookArtifactStore(new Error("disk full"));
    const result = await executeWithPostContext("tool-hook-cap-write-failed", context, store);

    // 第 10000 个字符是代理对的高位，截断时一起去掉，不留半个字符。
    expect(result.hookAdditionalContexts).toEqual([
      `PostToolUse:CapTool hook additional context: ${"a".repeat(9_999)}\n\n` +
        "[Hook additionalContext truncated at 10000 chars — persist-to-disk failed: disk full]",
    ]);
  });

  it("reuses the formatted PreToolUse context when the success path throws after formatting", async () => {
    const fixture = createExecutorFixture("tool-hook-cap-late-failure");
    fixture.registry.register(createTestToolEntry("CapTool", async () => "tool-output"));
    const context = "c".repeat(12_000);
    const store = createHookArtifactStore();
    const executor = createToolExecutor({
      artifactStore: store,
      // 成功路径格式化 Hook 上下文之后，写结果事件时失败，进入 catch。
      emitEvent: async (event) => {
        if (event.type === SessionEventType.ToolCallResult) throw new Error("event store down");
      },
      hookRunner: createInMemoryHookRunner({
        hooks: [
          {
            event: HookEventName.PreToolUse,
            matcher: "CapTool",
            callback: async (input) => ({
              hookSpecificOutput: {
                additionalContext: context,
                hookEventName: input.hookEventName,
              },
            }),
          },
        ],
      }),
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: fixture.registry,
      sessionId: fixture.traceContext.sessionId!,
      traceContext: fixture.traceContext,
      turnId: fixture.traceContext.turnId!,
    });

    const result = await executor.execute(
      { id: createToolCallId("cap-late-failure"), input: {}, name: "CapTool" },
      { traceContext: fixture.traceContext },
    );

    // catch 复用成功路径已过滤、已格式化的结果：只落盘一次，附件指向同一个文件。
    expect(result.success).toBe(false);
    expect(store.requests).toHaveLength(1);
    expect(result.hookAdditionalContexts).toEqual([
      expect.stringContaining("Full output saved to: /artifacts/hook-1.txt"),
    ]);
  });

  it("caps the PreToolUse context on the deny path", async () => {
    const fixture = createExecutorFixture("tool-hook-cap-deny");
    fixture.registry.register(createTestToolEntry("CapTool", async () => "tool-output"));
    const context = "b".repeat(10_001);
    const result = await fixture
      .createExecutor(
        createInMemoryHookRunner({
          hooks: [
            {
              event: HookEventName.PreToolUse,
              matcher: "CapTool",
              callback: async (input) => ({
                hookSpecificOutput: {
                  additionalContext: context,
                  hookEventName: input.hookEventName,
                  permissionDecision: "deny",
                },
              }),
            },
          ],
        }),
      )
      .execute(
        { id: createToolCallId("cap-deny"), input: {}, name: "CapTool" },
        { traceContext: fixture.traceContext },
      );

    expect(result.success).toBe(false);
    expect(result.hookAdditionalContexts).toEqual([
      `PreToolUse:CapTool hook additional context: ${"b".repeat(10_000)}\n\n` +
        "[Hook additionalContext truncated at 10000 chars — persist-to-disk failed: no artifact store]",
    ]);
  });
});

async function executeWithPostContext(
  sessionName: string,
  context: string,
  artifactStore: ToolArtifactStorePort,
) {
  const fixture = createExecutorFixture(sessionName);
  fixture.registry.register(createTestToolEntry("CapTool", async () => "tool-output"));
  const hookRunner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.PostToolUse,
        matcher: "CapTool",
        callback: async (input) => ({
          hookSpecificOutput: { additionalContext: context, hookEventName: input.hookEventName },
        }),
      },
    ],
  });
  return fixture
    .createExecutor(hookRunner, artifactStore)
    .execute(
      { id: createToolCallId(`${sessionName}-call`), input: {}, name: "CapTool" },
      { traceContext: fixture.traceContext },
    );
}

function createHookArtifactStore(writeError?: Error) {
  const requests: ToolArtifactWriteRequest[] = [];
  const store: ToolArtifactStorePort & { requests: ToolArtifactWriteRequest[] } = {
    requests,
    async writeToolResultArtifact(request) {
      if (writeError) throw writeError;
      requests.push(request);
      return {
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(),
        id: `hook-${requests.length}`,
        path: `/artifacts/hook-${requests.length}.txt`,
        uri: `zcode-artifact://test/hook-${requests.length}`,
      };
    },
    async readToolResultArtifact() {
      throw new Error("not used");
    },
  };
  return store;
}

function createExecutorFixture(sessionName: string) {
  const sessionId = createSessionId(sessionName);
  const turnId = createTurnId("tool-hook-context-turn");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  const events: SessionEvent[] = [];
  return {
    events,
    registry,
    traceContext,
    createExecutor(
      hookRunner: ReturnType<typeof createInMemoryHookRunner>,
      artifactStore?: ToolArtifactStorePort,
    ) {
      return createToolExecutor({
        artifactStore,
        emitEvent: async (event) => {
          events.push(event);
        },
        hookRunner,
        permissionService: new PermissionService(defaultPermissionConfig),
        registry,
        sessionId,
        traceContext,
        turnId,
      });
    },
  };
}

function createTestToolEntry(name: string, handler: ToolHandler): ToolEntry {
  return {
    capability: `${name} test capability`,
    handler,
    inputSchema: {
      additionalProperties: true,
      type: "object",
    },
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      timeoutMs: 30000,
    },
    outputSchema: {
      type: "string",
    },
    permission: {
      denyPriority: "beforeAsk",
      needsApproval: false,
      patternSources: ["none"],
      permission: "test",
      reason: "test tool",
      riskLevel: "low",
      sideEffectScope: "none",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 100_000,
      strategy: "truncate",
    },
  };
}

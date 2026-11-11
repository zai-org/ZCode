import { describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  CoreErrorType,
  ModelRequestSessionFeature,
  createCoreError,
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import {
  sessionFeaturesFromPersistedMessages,
  sessionFeaturesFromToolResult,
} from "../../src/runtime/session-features/contract.js";
import { createErrorResult, createPermissionErrorResult } from "../../src/tool/executor/errors.js";

// 规格：docs/design/v2/model/session-features-header.md「CreateWorkflow 尝试口径的补充规则」。
// 失败结果用 executor 自己的构造函数生成，错误类型与线上结果同源。
const { WorkflowAuto, WorkflowAutoAttempt } = ModelRequestSessionFeature;
const call = { id: "call_workflow", name: CREATE_WORKFLOW_TOOL_NAME, input: {} };

function failed(type: CoreErrorType, message = "failed") {
  return createErrorResult(call, createCoreError(type, message));
}

describe("sessionFeaturesFromToolResult：CreateWorkflow 尝试口径", () => {
  it("成功启动时与 workflow_auto 同时出现", () => {
    expect(
      sessionFeaturesFromToolResult({
        toolName: CREATE_WORKFLOW_TOOL_NAME,
        success: true,
        output: { ok: true, diagnostics: [], response: "started", status: "backgrounded" },
      }),
    ).toEqual([WorkflowAuto, WorkflowAutoAttempt]);
  });

  it("编译失败、没有 run 端口：只打 workflow_auto_attempt", () => {
    for (const output of [
      { ok: false, diagnostics: [], response: "errors" },
      { ok: true, diagnostics: [], response: "compiled cleanly" },
    ]) {
      expect(
        sessionFeaturesFromToolResult({
          toolName: CREATE_WORKFLOW_TOOL_NAME,
          success: true,
          output,
        }),
      ).toEqual([WorkflowAutoAttempt]);
    }
  });

  it("参数校验失败、handler 抛错、权限阶段的基础设施失败、取消：都打", () => {
    for (const type of [
      // schema 校验、validateInput / resolveInput 的语义校验都报 tool_execution_failed。
      CoreErrorType.ToolExecutionFailed,
      CoreErrorType.InvalidInput,
      CoreErrorType.UnknownError,
      // guarded 模式下 broker 失败、broker 超时。
      CoreErrorType.PermissionTimeout,
      CoreErrorType.ConfigurationError,
      // 等待确认或执行前用户停止。
      CoreErrorType.ToolCancelled,
      CoreErrorType.ToolTimeout,
    ]) {
      expect(sessionFeaturesFromToolResult(failed(type)), type).toEqual([WorkflowAutoAttempt]);
    }
    // handler 抛出的普通 Error：类型取 error.name。
    expect(sessionFeaturesFromToolResult(createErrorResult(call, new Error("boom")))).toEqual([
      WorkflowAutoAttempt,
    ]);
  });

  it("权限拒绝（含 hook、规则拦截）与工具未注册：不打", () => {
    expect(
      sessionFeaturesFromToolResult(
        createPermissionErrorResult(call, "The user denied this", { source: "broker" }),
      ),
    ).toEqual([]);
    expect(
      sessionFeaturesFromToolResult(
        createPermissionErrorResult(call, "Blocked by PreToolUse hook", {
          source: "hook.PreToolUse",
        }),
      ),
    ).toEqual([]);
    expect(sessionFeaturesFromToolResult(failed(CoreErrorType.ToolNotFound))).toEqual([]);
  });

  it("别的工具的结果不打", () => {
    for (const toolName of ["Bash", "AmendWorkflow", "SaveWorkflow", "DeferredToolCall"]) {
      expect(
        sessionFeaturesFromToolResult({
          toolName,
          success: true,
          output: { ok: true, status: "backgrounded" },
        }),
      ).toEqual([]);
    }
  });
});

describe("sessionFeaturesFromPersistedMessages：CreateWorkflow 尝试口径", () => {
  const sessionId = createSessionId("session-features-workflow-attempt-history");

  it("completed 的 CreateWorkflow 工具 part 不论 display 都推出 workflow_auto_attempt", () => {
    // 编译失败：display ok:false。
    expect(
      sessionFeaturesFromPersistedMessages([
        createWorkflowPart(sessionId, "completed", { kind: "create_workflow", ok: false }),
      ]),
    ).toEqual(new Set([WorkflowAutoAttempt]));
    // 没有 display（例如结果被截断后落盘）。
    expect(
      sessionFeaturesFromPersistedMessages([createWorkflowPart(sessionId, "completed", undefined)]),
    ).toEqual(new Set([WorkflowAutoAttempt]));
    // 成功启动（或没有 run 端口）：两个标签都推出。
    expect(
      sessionFeaturesFromPersistedMessages([
        createWorkflowPart(sessionId, "completed", { kind: "create_workflow", ok: true }),
      ]),
    ).toEqual(new Set([WorkflowAuto, WorkflowAutoAttempt]));
  });

  it("不应命中：error 状态（分不出权限拒绝）、pending/running、别的工具、GUI 直接启动", () => {
    expect(
      sessionFeaturesFromPersistedMessages([
        createWorkflowPart(sessionId, "error", { kind: "create_workflow", ok: true }),
        createWorkflowPart(sessionId, "pending", undefined),
        createWorkflowPart(sessionId, "running", undefined),
        createWorkflowPart(sessionId, "completed", { kind: "create_workflow", ok: true }, "Bash"),
        workflowLaunchMessage(sessionId),
      ]),
    ).toEqual(new Set());
  });
});

function createWorkflowPart(
  sessionId: SessionId,
  status: "completed" | "error" | "pending" | "running",
  display: Record<string, unknown> | undefined,
  tool: string = CREATE_WORKFLOW_TOOL_NAME,
): MessageWithParts {
  const messageId = createMessageId();
  const metadata = display === undefined ? {} : { display };
  const time = { start: 1, end: 2 };
  const state =
    status === "completed"
      ? { status, input: {}, output: "result", title: tool, metadata, time }
      : status === "error"
        ? { status, input: {}, error: "Permission denied for CreateWorkflow", metadata, time }
        : status === "running"
          ? { status, input: {}, title: tool, metadata, time: { start: 1 } }
          : { status, input: {}, raw: "{}" };
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      agent: "zcode-agent",
      time: { created: 2, completed: 3 },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: createPartId("t"),
        messageID: messageId,
        sessionID: sessionId,
        type: "tool",
        callID: "call_1",
        tool,
        state,
      },
    ],
  } as unknown as MessageWithParts;
}

/** GUI 直接启动的启动轮：只有一条带 workflowLaunch 元数据的 user 消息，没有 CreateWorkflow 工具 part。 */
function workflowLaunchMessage(sessionId: SessionId): MessageWithParts {
  const messageId = createMessageId();
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      agent: "zcode-agent",
      time: { created: 1 },
      metadata: { workflowLaunch: { runId: "run_1", toolCallId: "call_launch", name: "tidy" } },
    },
    parts: [
      {
        id: createPartId("u"),
        messageID: messageId,
        sessionID: sessionId,
        type: "text",
        text: 'Started the saved workflow "tidy" (project) from the workflows hub as run run_1.',
      },
    ],
  } as unknown as MessageWithParts;
}

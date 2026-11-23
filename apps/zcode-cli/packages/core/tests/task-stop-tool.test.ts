import { describe, expect, it } from "vitest";
import {
  TASK_STOP_TOOL_NAME,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  isErrorForToolResult,
  modelContentForToolResult,
} from "../src/runtime/helpers/tool-result.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { taskStopToolEntry } from "../src/tool/handlers/task-stop.js";
import { createToolRegistry } from "../src/tool/registry.js";

describe("TaskStop tool", () => {
  it("projects the complete TaskStop guidance to the provider", () => {
    const registry = createToolRegistry();
    registry.register(taskStopToolEntry);

    const contract = registry.toContracts().find((tool) => tool.name === TASK_STOP_TOOL_NAME);

    expect(contract?.description).toBe(
      "\n- Stops a running background task by its ID\n- Takes a task_id parameter identifying the task to stop\n- Returns a success or failure status\n- Use this tool when you need to terminate a long-running task\n",
    );
  });

  it("stops a running task through the runtime background task control port", async () => {
    const stopped: string[] = [];
    const output = await taskStopToolEntry.handler(
      { task_id: "task_123" },
      {
        abortSignal: new AbortController().signal,
        backgroundTaskControlPort: {
          async stopBackgroundTask(taskId, options) {
            stopped.push(`${taskId}:strict:${options.strict}:${options.initiator}`);
            return {
              command: "sleep 30",
              ok: true,
              status: "killed",
              taskId,
              type: "local_bash",
            };
          },
        },
        sessionId: "sess_task_stop" as never,
        toolCallId: "tool_task_stop",
        traceId: "trace_task_stop" as never,
        workingDirectory: "/tmp",
        workspaceRoot: "/tmp",
      },
    );

    // 模型自己停的：initiator 是 model，终态通知据此不会写成用户的决定。
    expect(stopped).toEqual(["task_123:strict:true:model"]);
    expect(output).toEqual({
      message: "Successfully stopped task: task_123 (sleep 30)",
      task_id: "task_123",
      task_type: "local_bash",
      command: "sleep 30",
    });
    expect(taskStopToolEntry.formatModelContent?.(output)).toBe(JSON.stringify(output));
  });

  it("passes the runtime background task control port through executor context", async () => {
    const sessionId = createSessionId("task-stop-executor");
    const turnId = createTurnId("task-stop-executor");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("task-stop-executor");
    const stopped: string[] = [];
    const registry = createToolRegistry();
    registry.register(taskStopToolEntry);
    const executor = createToolExecutor({
      backgroundTaskControlPort: {
        async stopBackgroundTask(taskId, options) {
          stopped.push(`${taskId}:strict:${options.strict}:${options.initiator}`);
          return {
            command: "Research the current odds",
            ok: true,
            status: "killed",
            taskId,
            type: "local_agent",
          };
        },
      },
      emitEvent: async () => undefined,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: { task_id: "agent_bg" },
        name: TASK_STOP_TOOL_NAME,
      },
      { traceContext },
    );

    expect(stopped).toEqual(["agent_bg:strict:true:model"]);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      message: "Successfully stopped task: agent_bg (Research the current odds)",
      task_id: "agent_bg",
      task_type: "local_agent",
      command: "Research the current odds",
    });
  });

  it("applies TaskStop permission rules when called through a legacy alias", async () => {
    const sessionId = createSessionId("task-stop-alias-permission");
    const turnId = createTurnId("task-stop-alias-permission");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const toolCallId = createToolCallId("task-stop-alias-permission");
    const stopped: string[] = [];
    const registry = createToolRegistry();
    registry.register(taskStopToolEntry);
    const executor = createToolExecutor({
      backgroundTaskControlPort: {
        async stopBackgroundTask(taskId) {
          stopped.push(taskId);
          return {
            ok: true,
            status: "killed",
            taskId,
            type: "local_bash",
          };
        },
      },
      emitEvent: async () => undefined,
      permissionService: new PermissionService({
        ...defaultPermissionConfig,
        disallowedTools: new Set([TASK_STOP_TOOL_NAME]),
      }),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: { task_id: "bash_bg" },
        name: "KillShell",
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(`Permission to use ${TASK_STOP_TOOL_NAME} has been denied.`);
    expect(stopped).toEqual([]);
  });

  it.each(["exec_12345678", "exec_12345678-1234-4234-8234-123456789abc"])(
    "keeps lookup failure for %s visible to the model as an error with full ID guidance",
    async (taskId) => {
      const sessionId = createSessionId("task-stop-lookup-failure");
      const turnId = createTurnId("task-stop-lookup-failure");
      const traceContext = createRootTraceContext({ sessionId, turnId });
      const registry = createToolRegistry();
      registry.register(taskStopToolEntry);
      const lookedUp: string[] = [];
      const executor = createToolExecutor({
        backgroundTaskControlPort: {
          async stopBackgroundTask(id) {
            lookedUp.push(id);
            return { ok: false, reason: "background_task_not_found", taskId: id };
          },
        },
        emitEvent: async () => undefined,
        permissionService: new PermissionService(defaultPermissionConfig),
        registry,
        sessionId,
        turnId,
        traceContext,
      });

      const result = await executor.execute(
        {
          id: createToolCallId("task-stop-lookup-failure"),
          input: { task_id: taskId },
          name: TASK_STOP_TOOL_NAME,
        },
        { traceContext },
      );

      expect(lookedUp).toEqual([taskId]);
      expect(result.success).toBe(false);
      expect(isErrorForToolResult(result)).toBe(true);
      expect(modelContentForToolResult(result)).toBe(
        `<tool_use_error>No task found with ID: ${taskId}. This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.</tool_use_error>`,
      );
    },
  );

  it("registers invisible stop aliases", async () => {
    const registry = createToolRegistry();
    registry.register(taskStopToolEntry);

    expect(registry.get("KillShell")?.handler).toBe(taskStopToolEntry.handler);
    expect(registry.get("KillBash")?.handler).toBe(taskStopToolEntry.handler);
    expect(registry.toContracts().map((tool) => tool.name)).toEqual([TASK_STOP_TOOL_NAME]);

    registry.unregister("KillShell");
    expect(registry.get(TASK_STOP_TOOL_NAME)).toBe(taskStopToolEntry);
    expect(registry.get("KillShell")).toBeUndefined();
    expect(registry.get("KillBash")?.handler).toBe(taskStopToolEntry.handler);

    registry.unregister(TASK_STOP_TOOL_NAME);
    expect(registry.get(TASK_STOP_TOOL_NAME)).toBeUndefined();
    expect(registry.get("KillBash")).toBeUndefined();
  });

  it("drops stale aliases when a tool is registered again with a smaller alias set", async () => {
    const registry = createToolRegistry();
    registry.register(taskStopToolEntry);
    registry.register(
      {
        ...taskStopToolEntry,
        aliases: ["KillShell"],
      },
      { silentDuplicateWarning: true },
    );

    expect(registry.get("KillShell")?.handler).toBe(taskStopToolEntry.handler);
    expect(registry.get("KillBash")).toBeUndefined();
  });

  it("accepts deprecated shell_id as task id", async () => {
    const output = await taskStopToolEntry.handler(
      { shell_id: "shell_123" },
      {
        abortSignal: new AbortController().signal,
        backgroundTaskControlPort: {
          async stopBackgroundTask(taskId) {
            return {
              command: "npm run dev",
              ok: true,
              status: "cancelled",
              taskId,
              type: "local_bash",
            };
          },
        },
        sessionId: "sess_task_stop_shell" as never,
        toolCallId: "tool_task_stop_shell",
        traceId: "trace_task_stop_shell" as never,
        workingDirectory: "/tmp",
        workspaceRoot: "/tmp",
      },
    );

    expect(output).toMatchObject({
      task_id: "shell_123",
      task_type: "local_bash",
      command: "npm run dev",
    });
  });

  it("returns stable error codes for invalid task ids", async () => {
    await expect(
      taskStopToolEntry.handler(
        {},
        {
          abortSignal: new AbortController().signal,
          sessionId: "sess_task_stop_missing" as never,
          toolCallId: "tool_task_stop_missing",
          traceId: "trace_task_stop_missing" as never,
          workingDirectory: "/tmp",
          workspaceRoot: "/tmp",
        },
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 1,
      message: "Missing required parameter: task_id",
    });
    await expect(
      taskStopToolEntry.handler(
        { task_id: "" },
        {
          abortSignal: new AbortController().signal,
          sessionId: "sess_task_stop_empty" as never,
          toolCallId: "tool_task_stop_empty",
          traceId: "trace_task_stop_empty" as never,
          workingDirectory: "/tmp",
          workspaceRoot: "/tmp",
        },
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 1,
      message: "Missing required parameter: task_id",
    });

    await expect(
      taskStopToolEntry.handler(
        { task_id: "done_task" },
        {
          abortSignal: new AbortController().signal,
          backgroundTaskControlPort: {
            async stopBackgroundTask(taskId) {
              return {
                ok: false,
                reason: "background_task_not_running",
                status: "completed",
                taskId,
                type: "local_agent",
              };
            },
          },
          sessionId: "sess_task_stop_done" as never,
          toolCallId: "tool_task_stop_done",
          traceId: "trace_task_stop_done" as never,
          workingDirectory: "/tmp",
          workspaceRoot: "/tmp",
        },
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 3,
      message: "Task done_task is not running (status: completed)",
    });

    await expect(
      taskStopToolEntry.handler(
        { task_id: "missing_task" },
        {
          abortSignal: new AbortController().signal,
          backgroundTaskControlPort: {
            async stopBackgroundTask(taskId) {
              return {
                ok: false,
                reason: "background_task_not_found",
                taskId,
              };
            },
          },
          sessionId: "sess_task_stop_not_found" as never,
          toolCallId: "tool_task_stop_not_found",
          traceId: "trace_task_stop_not_found" as never,
          workingDirectory: "/tmp",
          workspaceRoot: "/tmp",
        },
      ),
    ).resolves.toEqual({
      result: false,
      errorCode: 1,
      message:
        "No task found with ID: missing_task. This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.",
    });
  });

  it("reports unsupported stop targets separately from missing tasks", async () => {
    await expect(
      taskStopToolEntry.handler(
        { task_id: "workflow_bg" },
        {
          abortSignal: new AbortController().signal,
          backgroundTaskControlPort: {
            async stopBackgroundTask(taskId) {
              return {
                ok: false,
                reason: "background_task_cancel_not_supported",
                status: "running",
                taskId,
                type: "local_workflow",
              };
            },
          },
          sessionId: "sess_task_stop_unsupported" as never,
          toolCallId: "tool_task_stop_unsupported",
          traceId: "trace_task_stop_unsupported" as never,
          workingDirectory: "/tmp",
          workspaceRoot: "/tmp",
        },
      ),
    ).rejects.toMatchObject({
      context: {
        code: 1,
        reason: "background_task_cancel_not_supported",
        taskType: "local_workflow",
      },
      message: "Task workflow_bg cannot be stopped",
    });
  });
});

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  CoreErrorType,
  createModelId,
  createModelProviderId,
  createSessionEvent,
  createSessionId,
  createTurnId,
  type ExecutionPort,
  type SessionEvent,
} from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import {
  InMemoryRuntimeTaskRegistry,
  hasRunningBackgroundRuntimeTask,
} from "../src/runtime-task/registry.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import { updateRuntimeBackgroundTask } from "../src/tool/executor/background-task-registry.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { taskStopToolEntry } from "../src/tool/handlers/task-stop.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("background task control", () => {
  it("stops running local Bash tasks through the runtime registry dispatcher", async () => {
    const sessionId = createSessionId("background-control-bash");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const startedAt = new Date(0);
    const completedAt = new Date(1);
    const cancelledTaskIds: string[] = [];
    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async cancelBackgroundTask(taskId) {
        cancelledTaskIds.push(taskId);
        return {
          taskId,
          status: "cancelled",
          startedAt,
          completedAt,
          stdoutTail: "cancelled",
        };
      },
    };
    runtimeTaskRegistry.register({
      agentId: "bash_bg",
      agentType: "local_bash",
      command: "npm run dev",
      description: "npm run dev",
      isBackgrounded: true,
      startedAt,
      status: "running",
      taskId: "bash_bg",
      taskType: "local_bash",
      type: "local_bash",
    } as never);
    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        command: "npm run dev",
        startedAt,
        status: "running",
        taskId: "bash_bg",
        terminalId: "bash_bg",
        toolCallId: "tool_bash",
        toolName: "Bash",
      }),
    );
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, executionPort, runtimeTaskRegistry },
    );

    const result = await runtime.cancelBackgroundTask("bash_bg");
    const events = await eventStore.getEvents(sessionId);

    expect(cancelledTaskIds).toEqual(["bash_bg"]);
    expect(result).toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "bash_bg",
    });
    expect(
      events.filter((event) => event.type === SessionEventType.BackgroundTaskUpdated),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    ).toHaveLength(0);
  });

  it("does not ask the execution port to stop an unknown UI-control task", async () => {
    const sessionId = createSessionId("background-control-missing-ui");
    const eventStore = createTestSessionEventStore();
    let cancelCalled = false;
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        executionPort: {
          async run() {
            throw new Error("run should not be called");
          },
          async cancelBackgroundTask() {
            cancelCalled = true;
            return undefined;
          },
        },
      },
    );

    const result = await runtime.cancelBackgroundTask("missing_bg");

    expect(cancelCalled).toBe(false);
    expect(result).toMatchObject({
      cancelled: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: "missing_bg",
    });
  });

  it("marks a registry-backed local Bash task lost when the execution adapter no longer has it", async () => {
    const sessionId = createSessionId("background-control-bash-lost-adapter");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const startedAt = new Date(0);
    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async cancelBackgroundTask() {
        return undefined;
      },
    };
    runtimeTaskRegistry.register({
      agentId: "bash_lost_adapter",
      agentType: "local_bash",
      command: "sleep 999",
      description: "sleep 999",
      isBackgrounded: true,
      startedAt,
      status: "running",
      taskId: "bash_lost_adapter",
      taskType: "local_bash",
      type: "local_bash",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, executionPort, runtimeTaskRegistry },
    );

    const result = await runtime.cancelBackgroundTask("bash_lost_adapter");
    const events = await eventStore.getEvents(sessionId);

    expect(result).toMatchObject({
      cancelled: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: "bash_lost_adapter",
    });
    expect(runtimeTaskRegistry.get("bash_lost_adapter")).toMatchObject({
      status: "lost",
    });
    expect(
      events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    ).toHaveLength(1);
  });

  it("returns strict not-found and not-running results for model-tool callers", async () => {
    const sessionId = createSessionId("background-control-strict");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "terminal_bg",
      agentType: "local_bash",
      description: "finished",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "completed",
      taskId: "terminal_bg",
      taskType: "local_bash",
      type: "local_bash",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        executionPort: {
          async run() {
            throw new Error("run should not be called");
          },
        },
      },
    );

    await expect(
      (runtime as any).stopBackgroundTask("missing_bg", {
        strict: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "background_task_not_found",
      taskId: "missing_bg",
    });
    await expect(
      (runtime as any).stopBackgroundTask("terminal_bg", {
        strict: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "background_task_not_running",
      status: "completed",
      taskId: "terminal_bg",
      type: "local_bash",
    });
  });

  it("treats stopped runtime task results as successful cancellation", async () => {
    const sessionId = createSessionId("background-control-stopped-status");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "agent_stopped",
      agentType: "general-purpose",
      description: "stoppable agent",
      isBackgrounded: true,
      outputFile: "/tmp/agent_stopped/output.txt",
      parentToolCallId: "tool_agent_stopped",
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_stopped",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId) {
            return {
              agentId: taskId,
              agentType: "general-purpose",
              childSessionId: "child_stopped" as never,
              description: "stoppable agent",
              isBackgrounded: true,
              outputFile: "/tmp/agent_stopped/output.txt",
              parentToolCallId: "tool_agent_stopped",
              parentSessionId: sessionId,
              prompt: "stop",
              startedAt: new Date(0),
              status: "stopped",
              taskId,
              taskType: "local_agent",
              type: "local_agent",
            } as never;
          },
        },
      },
    );

    await expect(runtime.cancelBackgroundTask("agent_stopped")).resolves.toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "agent_stopped",
    });
  });

  it("returns unsupported for runtime task types without a stop handler", async () => {
    const sessionId = createSessionId("background-control-unsupported");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "workflow_bg",
      agentType: "local_workflow",
      description: "workflow",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "workflow_bg",
      taskType: "local_workflow",
      type: "local_workflow",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, runtimeTaskRegistry },
    );

    await expect((runtime as any).stopBackgroundTask("workflow_bg", {})).resolves.toMatchObject({
      ok: false,
      reason: "background_task_cancel_not_supported",
      taskId: "workflow_bg",
      type: "local_workflow",
    });
  });

  it("stops running local Agent tasks through the subagent port", async () => {
    const sessionId = createSessionId("background-control-agent");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const stoppedTaskIds: string[] = [];
    runtimeTaskRegistry.register({
      agentId: "agent_bg",
      agentType: "general-purpose",
      description: "research",
      isBackgrounded: true,
      outputFile: "/tmp/agent_bg/output.txt",
      parentToolCallId: "tool_agent",
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_bg",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId, options) {
            stoppedTaskIds.push(`${taskId}:${options?.initiator}`);
            return {
              agentId: taskId,
              agentType: "general-purpose",
              description: "research",
              outputFile: "/tmp/agent_bg/output.txt",
              startedAt: new Date(0),
              status: "killed",
              taskId,
            };
          },
        },
      },
    );

    const result = await runtime.cancelBackgroundTask("agent_bg");

    // GUI 入口是用户的停止：停止者随 stopTask 传给 subagent，终态通知据此写 "was stopped by user"。
    expect(stoppedTaskIds).toEqual(["agent_bg:user"]);
    expect(result).toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "agent_bg",
    });
  });

  it("uses the local Agent description as the TaskStop command", async () => {
    const sessionId = createSessionId("background-control-agent-command");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const prompt = "Read every source and return a complete multi-section report.";
    runtimeTaskRegistry.register({
      agentId: "agent_command",
      agentType: "general-purpose",
      description: "Research the current odds",
      isBackgrounded: true,
      prompt,
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_command",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        command: prompt,
        description: "Research the current odds",
        startedAt: new Date(0),
        status: "running",
        taskId: "agent_command",
        terminalId: "agent_command",
        toolCallId: "tool_agent_command",
        toolName: "Agent",
      }),
    );
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId) {
            return {
              agentId: taskId,
              agentType: "general-purpose",
              description: "Research the current odds",
              startedAt: new Date(0),
              status: "killed",
              taskId,
            };
          },
        },
      },
    );

    await expect(
      (runtime as any).stopBackgroundTask("agent_command", { strict: true }),
    ).resolves.toMatchObject({
      command: "Research the current odds",
      ok: true,
      status: "killed",
      taskId: "agent_command",
      type: "local_agent",
    });
  });

  it("aborts a running background subagent and enqueues one stopped notification", async () => {
    const sessionId = createSessionId("background-control-agent-port");
    const turnId = createTurnId("turn_background_control_agent_port");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-background-control-agent-port-"));
    const aborted = deferred();
    let abortObserved = false;
    const notifications: string[] = [];
    const notificationOriginMetas: unknown[] = [];
    const notificationArtifactStates: Array<{ exists: boolean; content: string }> = [];
    const emittedEvents: Array<{ type: SessionEventType; payload: unknown }> = [];
    const backgroundCompletedAbortStates: boolean[] = [];
    const registry = new InMemoryRuntimeTaskRegistry();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_stop",
      emitParentEvent: async (event) => {
        if (event.type === SessionEventType.BackgroundTaskCompleted) {
          backgroundCompletedAbortStates.push(abortObserved);
        }
        emittedEvents.push({ type: event.type, payload: event.payload });
      },
      enqueueParentTaskNotification: (notification) => {
        const outputFile = notification.text.match(/<output-file>([^<]+)<\/output-file>/u)?.[1];
        notificationArtifactStates.push({
          exists: outputFile ? existsSync(outputFile) : false,
          content: outputFile && existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
        });
        notifications.push(notification.text);
        notificationOriginMetas.push(notification.originMeta);
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              aborted.resolve();
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    try {
      await port.start?.({
        agentType: "general-purpose",
        description: "Stop me",
        parentToolCallId: "tool_agent_stop",
        prompt: "Wait until stopped",
        sessionId,
        trace: {
          traceId: "trace_background_control_agent_port",
          spanId: "span_background_control_agent_port",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });

      const stopped = await port.stopTask?.("agent_stop", { initiator: "model" });
      await aborted.promise;

      expect(stopped).toMatchObject({
        status: "killed",
        taskId: "agent_stop",
      });
      expect(registry.get("agent_stop")).toMatchObject({
        notified: true,
        status: "killed",
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("<status>killed</status>");
      // TaskStop 传入的停止者进入通知；killed 通知不带 usage。
      expect(notifications[0]).toContain('<summary>Agent "Stop me" was stopped by ZCode</summary>');
      expect(notifications[0]).not.toContain("<usage>");
      // 终态随 originMeta 结构化下发；killed 不带 error。
      expect(notificationOriginMetas).toEqual([
        {
          backgroundSource: "subagent",
          title: "Stop me",
          workId: "agent_stop",
          subagentResult: { status: "killed" },
        },
      ]);
      expect(notificationArtifactStates).toEqual([
        expect.objectContaining({
          exists: true,
          content: expect.stringContaining("Background agent task stopped."),
        }),
      ]);
      expect(backgroundCompletedAbortStates).toEqual([true]);
      expect(
        emittedEvents.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      ).toHaveLength(1);
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  // 停止者全链路：停止入口 → runtime.stopBackgroundTask → subagent stopTask → killed 通知 summary。
  it.each([
    { initiator: "model", summary: "was stopped by ZCode" },
    { initiator: "user", summary: "was stopped by user" },
  ])(
    "carries the $initiator stop initiator from the stop entry into the killed notification",
    async ({ initiator, summary }) => {
      const sessionId = createSessionId(`background-control-agent-initiator-${initiator}`);
      const turnId = createTurnId(`turn_background_control_agent_initiator_${initiator}`);
      const outputRootDir = await mkdtemp(
        join(tmpdir(), "zcode-background-control-agent-initiator-"),
      );
      const aborted = deferred();
      const notifications: string[] = [];
      const registry = new InMemoryRuntimeTaskRegistry();
      const port = createExploreSubagentPort({
        createAgentId: () => "agent_initiator",
        emitParentEvent: async () => {},
        enqueueParentTaskNotification: (notification) => {
          notifications.push(notification.text);
        },
        outputRootDir,
        runtimeTaskRegistry: registry,
        async runExploreAgent(request, options) {
          await request.onSessionReady?.();
          return await new Promise((_, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(options.signal?.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      });
      const runtime = createTestAgentRuntime(
        sessionId,
        { mode: "build" },
        {
          eventStore: createTestSessionEventStore(),
          runtimeTaskRegistry: registry,
          subagentPort: port,
        },
      );

      try {
        await port.start?.({
          agentType: "general-purpose",
          description: "Stop me",
          parentToolCallId: "tool_agent_initiator",
          prompt: "Wait until stopped",
          sessionId,
          trace: {
            traceId: "trace_background_control_agent_initiator",
            spanId: "span_background_control_agent_initiator",
            sessionId,
            turnId,
          },
          turnId,
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        });

        if (initiator === "model") {
          // 模型入口：TaskStop 用 runtime 交给工具执行上下文的同一个绑定。
          await taskStopToolEntry.handler({ task_id: "agent_initiator" }, {
            backgroundTaskControlPort: {
              stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
            },
            toolCallId: "tool_task_stop",
          } as never);
        } else {
          // App 入口：v4 cancelBackgroundWork 调 cancelBackgroundTask。
          await runtime.cancelBackgroundTask("agent_initiator");
        }
        await aborted.promise;

        expect(registry.get("agent_initiator")).toMatchObject({ status: "killed" });
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toContain(`<summary>Agent "Stop me" ${summary}</summary>`);
      } finally {
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("cleans up a background subagent when startup event emission fails before run starts", async () => {
    const sessionId = createSessionId("background-control-agent-startup-failure");
    const turnId = createTurnId("turn_background_control_agent_startup_failure");
    const outputRootDir = await mkdtemp(
      join(tmpdir(), "zcode-background-control-agent-startup-failure-"),
    );
    const registry = new InMemoryRuntimeTaskRegistry();
    let runCalled = false;
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_startup_fail",
      emitParentEvent: async (event) => {
        if (event.type === SessionEventType.SubagentSpawned) {
          throw new Error("spawn event failed");
        }
      },
      enqueueParentTaskNotification: () => {},
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request) {
        runCalled = true;
        await request.onSessionReady?.();
        throw new Error("run should not be called");
      },
    });

    try {
      await expect(
        port.start?.({
          agentType: "general-purpose",
          description: "Fail before run",
          parentToolCallId: "tool_agent_startup_fail",
          prompt: "This should not start",
          sessionId,
          trace: {
            traceId: "trace_background_control_agent_startup_failure",
            spanId: "span_background_control_agent_startup_failure",
            sessionId,
            turnId,
          },
          turnId,
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        }),
      ).rejects.toThrow("spawn event failed");

      expect(runCalled).toBe(true);
      expect(registry.get("agent_startup_fail")).toBeUndefined();
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("keeps a stopped background subagent terminal even when notification enqueue fails", async () => {
    const sessionId = createSessionId("background-control-agent-stop-finalize-failure");
    const turnId = createTurnId("turn_background_control_agent_stop_final_failure");
    const outputRootDir = await mkdtemp(
      join(tmpdir(), "zcode-background-control-agent-stop-finalize-failure-"),
    );
    const aborted = deferred();
    let abortObserved = false;
    const registry = new InMemoryRuntimeTaskRegistry();
    const events: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_stop_finalize_fail",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      enqueueParentTaskNotification: () => {
        throw new Error("enqueue failed");
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              aborted.resolve();
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    try {
      await port.start?.({
        agentType: "general-purpose",
        description: "Stop finalize failure",
        parentToolCallId: "tool_agent_stop_finalize_fail",
        prompt: "Wait until stopped",
        sessionId,
        trace: {
          traceId: "trace_background_control_agent_stop_final_failure",
          spanId: "span_background_control_agent_stop_final_failure",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });

      await expect(port.stopTask?.("agent_stop_finalize_fail")).rejects.toThrow(
        "stopped notification was not enqueued",
      );

      expect(abortObserved).toBe(true);
      expect(registry.get("agent_stop_finalize_fail")).toMatchObject({
        status: "killed",
      });
      expect(
        events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === SessionEventType.SubagentStopped)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            executionId: registry.get("agent_stop_finalize_fail")?.executionId,
            status: "stopped",
          }),
        }),
      ]);
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it.each([
    { background: false, blockedArtifact: "output.txt" },
    { background: false, blockedArtifact: "metadata.json" },
    { background: true, blockedArtifact: "output.txt" },
    { background: true, blockedArtifact: "metadata.json" },
  ])(
    "publishes stopped lifecycle after $blockedArtifact write failure (background=$background)",
    async ({ background, blockedArtifact }) => {
      const sessionId = createSessionId("agent-stop-artifact-failure");
      const turnId = createTurnId("turn_agent_stop_artifact_failure");
      const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-agent-stop-artifact-failure-"));
      const registry = new InMemoryRuntimeTaskRegistry();
      const events: SessionEvent[] = [];
      const notifications: string[] = [];
      let abortObserved = false;
      const port = createExploreSubagentPort({
        createAgentId: () => "agent_stop_artifact_failure",
        emitParentEvent: async (event) => {
          events.push(event);
        },
        enqueueParentTaskNotification: (notification) => {
          notifications.push(notification.text);
        },
        outputRootDir,
        runtimeTaskRegistry: registry,
        async runExploreAgent(request, options) {
          await request.onSessionReady?.();
          return await new Promise((_, reject) => {
            const onAbort = () => {
              abortObserved = true;
              reject(options?.signal?.reason);
            };
            if (options?.signal?.aborted) onAbort();
            else options?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      });
      try {
        const request = {
          agentType: "general-purpose",
          description: "Stop with failed artifact write",
          parentToolCallId: "tool_stop_artifact_failure",
          prompt: "Wait until stopped",
          sessionId,
          trace: {
            traceId: "trace_stop_artifact_failure",
            spanId: "span_stop_artifact_failure",
            sessionId,
            turnId,
          },
          turnId,
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        };
        const running = background ? undefined : port.run(request);
        const foregroundResult = running?.catch((error: unknown) => error);
        if (background) await port.start?.(request);
        else
          await waitForCondition(() =>
            events.some((event) => event.type === SessionEventType.SubagentSpawned),
          );
        const task = registry.get("agent_stop_artifact_failure")!;
        const blockedPath = join(dirname(task.outputFile!), blockedArtifact);
        await rm(blockedPath, { force: true });
        await mkdir(blockedPath);
        await expect(
          port.stopTask?.(task.taskId, {
            expectedExecutionId: task.executionId,
            initiator: "user",
          }),
        ).rejects.toMatchObject({ path: blockedPath });
        expect(abortObserved).toBe(true);
        expect(registry.get(task.taskId)?.status).toBe("killed");
        expect(events.filter((event) => event.type === SessionEventType.SubagentStopped)).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              childSessionId: task.childSessionId,
              executionId: task.executionId,
              status: "stopped",
            }),
          }),
        ]);
        expect(
          events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
        ).toHaveLength(background ? 1 : 0);
        expect(notifications).toHaveLength(background ? 1 : 0);
        if (foregroundResult)
          expect(await foregroundResult).toMatchObject({ type: CoreErrorType.ToolCancelled });
        const eventCount = events.length;
        await expect(
          port.stopTask?.(task.taskId, { expectedExecutionId: task.executionId }),
        ).resolves.toBeUndefined();
        expect(events).toHaveLength(eventCount);
      } finally {
        await port.close?.();
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("aborts a SendMessage-resumed background subagent when it is stopped", async () => {
    const sessionId = createSessionId("background-control-agent-resume");
    const turnId = createTurnId("turn_background_control_agent_resume");
    const childSessionId = createSessionId("subagent_agent_resume");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-background-control-agent-resume-"));
    const agentOutputDir = join(outputRootDir, sessionId, "agent_resume");
    const aborted = deferred();
    const parentEvents: SessionEvent[] = [];
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "agent_resume",
      agentType: "general-purpose",
      childSessionId,
      description: "Resume me",
      isBackgrounded: true,
      parentSessionId: sessionId,
      parentToolCallId: "tool_agent_resume",
      prompt: "Original prompt",
      startedAt: new Date(0),
      status: "completed",
      taskId: "agent_resume",
      taskType: "local_agent",
      traceContext: {
        traceId: "trace_background_control_agent_resume",
        spanId: "span_background_control_agent_resume",
        sessionId,
        turnId,
      },
      turnId,
      type: "local_agent",
    } as never);
    const port = createExploreSubagentPort({
      createAgentId: () => "unused_agent_id",
      emitParentEvent: async (event) => {
        parentEvents.push(event);
      },
      enqueueParentTaskNotification: () => {},
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    try {
      const result = await port.sendMessage?.({
        message: "Continue in background",
        parentToolCallId: "tool_agent_resume_send",
        sessionId,
        summary: "Continue resumed work",
        to: "agent_resume",
        trace: {
          traceId: "trace_background_control_agent_resume_send",
          spanId: "span_background_control_agent_resume_send",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });

      expect(result).toMatchObject({
        agentId: "agent_resume",
        delivery: "resumed_background",
        message: `Agent "agent_resume" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: ${join(agentOutputDir, "output.txt")}`,
        outputFile: join(agentOutputDir, "output.txt"),
        status: "success",
        taskId: "agent_resume",
      });
      const resumedStartEvents = parentEvents.filter(
        (event) =>
          event.type === SessionEventType.SubagentSpawned ||
          event.type === SessionEventType.BackgroundTaskStarted,
      );
      expect(resumedStartEvents.map((event) => event.type)).toEqual([
        SessionEventType.SubagentSpawned,
      ]);
      expect(resumedStartEvents[0]?.payload).toMatchObject({
        agentId: "agent_resume",
        background: true,
        childSessionId,
        resumed: true,
        status: "running",
      });

      const stopped = await port.stopTask?.("agent_resume");
      await Promise.race([
        aborted.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("resumed subagent was not aborted")), 100),
        ),
      ]);

      expect(stopped).toMatchObject({
        status: "killed",
        taskId: "agent_resume",
      });
      expect(registry.get("agent_resume")).toMatchObject({
        status: "killed",
      });
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("rejects a stale execution token after SendMessage resumes the same taskId", async () => {
    const sessionId = createSessionId("background-control-agent-stale-stop");
    const turnId = createTurnId("turn_background_control_agent_stale_stop");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-agent-stale-stop-"));
    const registry = new InMemoryRuntimeTaskRegistry();
    const notifications: string[] = [];
    const events: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_stale_stop",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.text);
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const trace = {
      traceId: "trace_agent_stale_stop",
      spanId: "span_agent_stale_stop",
      sessionId,
      turnId,
    };
    try {
      await port.start?.({
        agentType: "general-purpose",
        description: "Stop old generation",
        parentToolCallId: "tool_stale",
        prompt: "Wait",
        sessionId,
        trace,
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });
      const firstExecutionId = (
        registry.get("agent_stale_stop") as { executionId?: string } | undefined
      )?.executionId;
      expect(firstExecutionId).toBeTruthy();
      await port.stopTask?.("agent_stale_stop", { expectedExecutionId: firstExecutionId });
      await waitForCondition(() => registry.get("agent_stale_stop")?.status === "killed");
      const sent = await port.sendMessage?.({
        to: "agent_stale_stop",
        message: "Continue",
        parentToolCallId: "tool_resume",
        sessionId,
        trace,
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });
      expect(sent?.delivery).toBe("resumed_background");
      const secondExecutionId = (
        registry.get("agent_stale_stop") as { executionId?: string } | undefined
      )?.executionId;
      expect(secondExecutionId).toBeTruthy();
      expect(secondExecutionId).not.toBe(firstExecutionId);
      const oldStop = await port.stopTask?.("agent_stale_stop", {
        expectedExecutionId: firstExecutionId,
      });
      expect(oldStop).toBeUndefined();
      expect(registry.get("agent_stale_stop")?.status).toBe("running");
      expect(notifications).toHaveLength(1);
      await port.stopTask?.("agent_stale_stop", { expectedExecutionId: secondExecutionId });
      await waitForCondition(() => registry.get("agent_stale_stop")?.status === "killed");
      expect(notifications).toHaveLength(2);
      expect(
        events.filter((event) => event.type === SessionEventType.SubagentSpawned),
      ).toHaveLength(2);
    } finally {
      await port.close?.();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("stops a foreground child without a background notification or failed overwrite", async () => {
    const sessionId = createSessionId("foreground-control-agent-stop");
    const turnId = createTurnId("turn_foreground_control_agent_stop");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-foreground-control-agent-"));
    const registry = new InMemoryRuntimeTaskRegistry();
    const notifications: string[] = [];
    const events: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_foreground_stop",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.text);
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const trace = {
      traceId: "trace_foreground_stop",
      spanId: "span_foreground_stop",
      sessionId,
      turnId,
    };
    try {
      const running = port.run({
        agentType: "general-purpose",
        description: "Stop foreground",
        parentToolCallId: "tool_foreground",
        prompt: "Wait",
        sessionId,
        trace,
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });
      await waitForCondition(() =>
        events.some((event) => event.type === SessionEventType.SubagentSpawned),
      );
      const executionId = (
        registry.get("agent_foreground_stop") as { executionId?: string } | undefined
      )?.executionId;
      expect(executionId).toBeTruthy();
      await port.stopTask?.("agent_foreground_stop", { expectedExecutionId: executionId });
      await expect(running).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(registry.get("agent_foreground_stop")?.status).toBe("killed");
      expect(notifications).toEqual([]);
      expect(
        events.filter((event) => event.type === SessionEventType.SubagentStopped),
      ).toHaveLength(1);
    } finally {
      await port.close?.();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("lets the parent turn continue after a foreground Agent tool is stopped", async () => {
    const sessionId = createSessionId("foreground-stop-parent-continues");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-foreground-stop-turn-"));
    const registry = new InMemoryRuntimeTaskRegistry();
    const events: SessionEvent[] = [];
    let parentRequests = 0;
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_parent_continues",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: outputRootDir,
      },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
        subagentPort: port,
        modelFactory: createTestModelFactory({
          async generateText() {
            parentRequests++;
            return parentRequests === 1
              ? {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "call_parent_agent_stop",
                      name: "Agent",
                      input: {
                        description: "Stop child only",
                        prompt: "Wait for stop",
                        subagent_type: "general-purpose",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                }
              : {
                  finishReason: "stop",
                  text: "Parent continued",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
          },
        } as never),
      },
    );
    try {
      const turn = runtime.executeTurn("Stop this child, then continue");
      await waitForCondition(() =>
        events.some((event) => event.type === SessionEventType.SubagentSpawned),
      );
      const executionId = registry.get("agent_parent_continues")?.executionId;
      expect(executionId).toBeTruthy();
      await runtime.stopBackgroundTask("agent_parent_continues", {
        expectedExecutionId: executionId,
        initiator: "user",
        strict: true,
      });
      const result = await turn;
      expect(result).toMatchObject({ response: "Parent continued" });
      expect(parentRequests).toBe(2);
      expect(registry.get("agent_parent_continues")?.status).toBe("killed");
      expect(
        events.filter((event) => event.type === SessionEventType.SubagentStopped),
      ).toHaveLength(1);
    } finally {
      await port.close?.();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("keeps the first terminal decision when background completion races with stop", async () => {
    const sessionId = createSessionId("background-stop-completion-race");
    const turnId = createTurnId("turn_background_stop_completion_race");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-stop-completion-race-"));
    const releaseCompletion = deferred<{
      response: string;
      traceId: string;
      events: SessionEvent[];
    }>();
    const registry = new InMemoryRuntimeTaskRegistry();
    const notifications: string[] = [];
    const events: SessionEvent[] = [];
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_completion_race",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.text);
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request) {
        await request.onSessionReady?.();
        return releaseCompletion.promise;
      },
    });
    try {
      await port.start?.({
        agentType: "general-purpose",
        description: "Stop completion race",
        parentToolCallId: "tool_completion_race",
        prompt: "Wait",
        sessionId,
        trace: {
          traceId: "trace_completion_race",
          spanId: "span_completion_race",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });
      const executionId = registry.get("agent_completion_race")?.executionId;
      await port.stopTask?.("agent_completion_race", { expectedExecutionId: executionId });
      releaseCompletion.resolve({
        response: "late success",
        traceId: "trace_completion_race",
        events: [],
      });
      await port.close?.();
      expect(registry.get("agent_completion_race")?.status).toBe("killed");
      expect(notifications).toHaveLength(1);
      expect(
        events.filter((event) => event.type === SessionEventType.SubagentStopped),
      ).toHaveLength(1);
    } finally {
      releaseCompletion.resolve({
        response: "late success",
        traceId: "trace_completion_race",
        events: [],
      });
      await port.close?.();
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("does not overwrite a terminal runtime task when a late tracker snapshot arrives", () => {
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "bash_race",
      agentType: "local_bash",
      description: "sleep 30",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "killed",
      taskId: "bash_race",
      taskType: "local_bash",
      type: "local_bash",
    } as never);

    updateRuntimeBackgroundTask(
      { runtimeTaskRegistry } as never,
      {
        id: "tool_bash_race",
        input: { command: "sleep 30" },
        name: "Bash",
      } as never,
      "bash_race",
      "completed",
      {
        taskId: "bash_race",
        status: "completed",
        startedAt: new Date(0),
        completedAt: new Date(1),
        stdoutTail: "done",
      },
    );

    expect(runtimeTaskRegistry.get("bash_race")).toMatchObject({
      status: "killed",
    });
    expect(runtimeTaskRegistry.get("bash_race")).not.toHaveProperty("stdoutTail");
  });

  /**
   * TaskOutput 的投影只读得到 registry 条目（dwf 从不写 outputFile），所以产物必须在终态
   * 更新时就落到条目上。以下几条钉住「存什么、什么时候存、绝不用 undefined 清掉已有值」。
   */
  describe("dwf run 产物落到 registry 条目上", () => {
    const CREATE_WORKFLOW_CALL = {
      id: "tool_dwf_result",
      input: { script: "return 1;" },
      name: "CreateWorkflow",
    };

    function registryWithDwfRun(): InMemoryRuntimeTaskRegistry {
      const registry = new InMemoryRuntimeTaskRegistry();
      registry.register({
        agentId: "dwfrun-result",
        agentType: "local_dynamic_workflow",
        description: "Dynamic workflow run",
        isBackgrounded: true,
        startedAt: new Date(0),
        status: "running",
        taskId: "dwfrun-result",
        taskType: "local_dynamic_workflow",
        type: "local_dynamic_workflow",
      } as never);
      return registry;
    }

    function update(
      registry: InMemoryRuntimeTaskRegistry,
      status: string,
      snapshot: Record<string, unknown>,
    ): void {
      updateRuntimeBackgroundTask(
        { runtimeTaskRegistry: registry } as never,
        CREATE_WORKFLOW_CALL as never,
        "dwfrun-result",
        status,
        snapshot as never,
      );
    }

    it("终态的字符串产物原样存为 resultText", () => {
      const registry = registryWithDwfRun();
      update(registry, "completed", {
        taskId: "dwfrun-result",
        status: "completed",
        output: "the final answer",
      });

      expect(registry.get("dwfrun-result")?.resultText).toBe("the final answer");
    });

    it("终态的对象产物存为 pretty JSON", () => {
      const registry = registryWithDwfRun();
      update(registry, "completed", {
        taskId: "dwfrun-result",
        status: "completed",
        output: { report: "done" },
      });

      expect(registry.get("dwfrun-result")?.resultText).toBe(
        JSON.stringify({ report: "done" }, null, 2),
      );
    });

    it("running 的中途快照不写 resultText", () => {
      const registry = registryWithDwfRun();
      update(registry, "running", {
        taskId: "dwfrun-result",
        status: "running",
        output: "not settled yet",
      });

      expect(registry.get("dwfrun-result")?.resultText).toBeUndefined();
    });

    it("产物缺席的终态不写 resultText", () => {
      const registry = registryWithDwfRun();
      update(registry, "completed", { taskId: "dwfrun-result", status: "completed" });

      expect(registry.get("dwfrun-result")?.resultText).toBeUndefined();
    });

    // undefined 绝不清掉已有值：一次产物缺席的更新不该把先前存下的产物抹掉。
    it("已有的 resultText 不被产物缺席的更新清掉", () => {
      const registry = registryWithDwfRun();
      registry.update("dwfrun-result", (current) => ({
        ...current,
        resultText: "already captured",
      }));
      update(registry, "running", { taskId: "dwfrun-result", status: "running" });

      expect(registry.get("dwfrun-result")?.resultText).toBe("already captured");
    });

    it("legacy Workflow 的终态不写 resultText（不改它的契约）", () => {
      const registry = new InMemoryRuntimeTaskRegistry();
      registry.register({
        agentId: "wfrun-legacy",
        agentType: "local_workflow",
        description: "Workflow background task",
        isBackgrounded: true,
        startedAt: new Date(0),
        status: "running",
        taskId: "wfrun-legacy",
        taskType: "local_workflow",
        type: "local_workflow",
      } as never);

      updateRuntimeBackgroundTask(
        { runtimeTaskRegistry: registry } as never,
        { id: "tool_wf_legacy", input: { scriptPath: "w.ts" }, name: "Workflow" } as never,
        "wfrun-legacy",
        "completed",
        { runId: "wfrun-legacy", status: "completed", output: { response: "legacy" } } as never,
      );

      expect(registry.get("wfrun-legacy")?.resultText).toBeUndefined();
    });
  });

  it("emits non-cancellable terminal background task events", async () => {
    const sessionId = createSessionId("background-control-terminal-cancellable");
    const turnId = createTurnId("turn_background_control_terminal_cancellable");
    const events: Array<{ type: SessionEventType; payload: unknown }> = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ type: event.type, payload: event.payload });
      },
      executionPort: {
        async run() {
          throw new Error("run should not be called");
        },
        async cancelBackgroundTask() {
          throw new Error("cancelBackgroundTask should not be called");
        },
        async waitForBackgroundTask() {
          return {
            taskId: "bash_terminal_cancellable",
            status: "completed",
            startedAt: new Date(0),
            completedAt: new Date(1),
            stdoutTail: "done",
          };
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      {
        id: "tool_bash_terminal_cancellable",
        input: { command: "echo done" },
        name: "Bash",
      } as never,
      {
        backgroundTaskId: "bash_terminal_cancellable",
        status: "backgrounded",
      },
      {
        traceId: "trace_background_control_terminal_cancellable",
        spanId: "span_background_control_terminal_cancellable",
        sessionId,
        turnId,
      },
      turnId,
    );

    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );

    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({
      cancellable: false,
      status: "completed",
      taskId: "bash_terminal_cancellable",
    });
  });

  it("logs pid, exit code and duration of a background Bash process with its toolCallId", async () => {
    const sessionId = createSessionId("background-control-terminal-log");
    const turnId = createTurnId("turn_background_control_terminal_log");
    const logs: Array<{ message: string; context: Record<string, unknown> }> = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async () => {},
      executionPort: {
        async run() {
          throw new Error("run should not be called");
        },
        async waitForBackgroundTask() {
          return {
            taskId: "bash_terminal_log",
            status: "failed",
            startedAt: new Date(0),
            completedAt: new Date(2_000),
            pid: 5824,
            result: {
              status: "failed",
              exitCode: 137,
              signal: "SIGKILL",
              durationMs: 2_000,
              pid: 5824,
            },
          };
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      logger: {
        info: (message: string, context?: Record<string, unknown>) =>
          logs.push({ message, context: context ?? {} }),
      },
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_bash_terminal_log", input: { command: "python big.py" }, name: "Bash" } as never,
      { backgroundTaskId: "bash_terminal_log", status: "backgrounded" },
      { traceId: "trace_terminal_log", spanId: "span_terminal_log", sessionId, turnId },
      turnId,
    );

    await waitForCondition(() =>
      logs.some((entry) => entry.context.event === "background_task.tracking.terminal"),
    );
    expect(
      logs.find((entry) => entry.context.event === "background_task.tracking.terminal")?.context,
    ).toMatchObject({
      durationMs: 2_000,
      exitCode: 137,
      pid: 5824,
      signal: "SIGKILL",
      taskId: "bash_terminal_log",
      toolCallId: "tool_bash_terminal_log",
    });
  });
});

/**
 * 后台生命周期的按工具名硬分派已改成按工具查表（见 docs/dynamic-workflow/presentation.md 的
 * 「后台生命周期泛化」）。这一组测两件事：CreateWorkflow 经 dynamicWorkflowRunPort 拿到
 * 完整的快照/等待/取消能力，以及既有工具的语义逐字未变。
 */
describe("background task per-tool provider lookup", () => {
  interface TrackedRun {
    events: { payload: Record<string, unknown>; type: string }[];
    notifications: { taskId?: string; text: string; toolName?: string; originMeta?: unknown }[];
  }

  async function trackDynamicWorkflowRun(options: {
    getTask?: () => Promise<unknown>;
    input?: Record<string, unknown>;
    launchOutput?: Record<string, unknown>;
    name?: string;
    port?: Record<string, unknown>;
    waitForTask?: () => Promise<unknown>;
  }): Promise<TrackedRun> {
    const sessionId = createSessionId(options.name ?? "dwf-tracker");
    const turnId = createTurnId(options.name ?? "dwf-tracker");
    const events: TrackedRun["events"] = [];
    const notifications: TrackedRun["notifications"] = [];

    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
      },
      enqueueBackgroundTaskNotification: (notification) => {
        notifications.push(notification);
        return undefined;
      },
      dynamicWorkflowRunPort:
        options.port ??
        ({
          async submit() {
            throw new Error("submit should not be called by the tracker");
          },
          getTask: options.getTask ?? (async () => ({ status: "running", taskId: "dwfrun-1" })),
          waitForTask:
            options.waitForTask ??
            (async () => ({
              status: "completed",
              taskId: "dwfrun-1",
              output: { response: "workflow answer" },
            })),
          async cancel() {
            return true;
          },
          async listEvents() {
            return [];
          },
        } as never),
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      {
        id: "tool_create_workflow_1",
        input: options.input ?? { script: 'const r = await agent("a").ask("x");' },
        name: "CreateWorkflow",
      } as never,
      { backgroundTaskId: "dwfrun-1", status: "backgrounded", ...options.launchOutput },
      {
        traceId: `trace_${options.name ?? "dwf-tracker"}`,
        spanId: `span_${options.name ?? "dwf-tracker"}`,
        sessionId,
        turnId,
      },
      turnId,
    );

    return { events, notifications };
  }

  // 第五处分派（canCancelBackgroundTask）：它决定 started payload 的 cancellable。
  // 不修它，详情页与后台面板的 Cancel 按钮点不动——整条取消路径不可达。
  it("CreateWorkflow 的 started payload 可取消", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-cancellable" });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({
      cancellable: true,
      status: "running",
      taskId: "dwfrun-1",
      toolName: "CreateWorkflow",
    });
  });

  // taskKind 是展示类别（面板分组与图标）。dwf run 此前落进 "bash"——一个我们知情的错标。
  // 生命周期语义不受它影响（已由 per-tool lifecycleProvider 分派），但面板据它分组，
  // 而一个能点开详情页、能取消的 run 与一条后台 shell 命令不是同一种东西。
  it("CreateWorkflow 的 taskKind 是 workflow，不再错标成 bash", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-task-kind" });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect((started?.payload as { taskKind?: string }).taskKind).toBe("workflow");
  });

  /**
   * payload 的 `description` 是任务岛 Workflows 分区那一行的题名（经 backgroundWorks.title）。
   * 原实现只认 `input.description`，而 CreateWorkflow 的输入 schema 里根本没有这个键
   * （只有 `{name?, script}`，contracts/src/tools/create-workflow.ts），于是面板行退到 toolName
   * 显示成 "CreateWorkflow"——每个 run 都同名。改走既有的 workflowTaskSubject 兜底链。
   */
  it("CreateWorkflow 的展示名取 input.name", async () => {
    const { events } = await trackDynamicWorkflowRun({
      input: { name: "Nightly release audit", script: "" },
      name: "dwf-description-name",
    });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({ description: "Nightly release audit" });
  });

  // 名字缺席时兜底链走到最后一环 taskId：不是 undefined，也不是 toolName。
  // 投影对这两者的处理本就一致（都会落到 UI 侧的 fallbackName），所以 taskId 可接受。
  it("CreateWorkflow 无 name 时展示名兜底到 taskId 而不是工具名", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-description-fallback" });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect((started?.payload as { description?: string }).description).toBe("dwfrun-1");
  });

  // 快照提供者与直接等待者都来自同一个端口：终态经 waitForTask 到达并收口成 completed。
  it("经端口的快照提供者与等待者把 run 结算成终态", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-terminal" });

    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({ status: "completed", taskId: "dwfrun-1" });
  });

  // 完成通知复用 formatWorkflowTaskNotification，并带 backgroundSource "workflow"，
  // 这样主 agent 的新回合渲染成后台结果头而不是退化成裸 model-only 消息。
  it("终态通知走 workflow 通知格式并标记 backgroundSource", async () => {
    const { events, notifications } = await trackDynamicWorkflowRun({ name: "dwf-notify" });

    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.taskId).toBe("dwfrun-1");
    expect(notification.toolName).toBe("CreateWorkflow");
    // formatWorkflowTaskNotification 的形状（不是 Bash 的那套）：workflow 措辞的 summary
    // 加上截断后的结果。
    expect(notification.text).toContain('<summary>Workflow &quot;dwfrun-1&quot; completed.</summary>');
    expect(notification.text).toContain("workflow answer");
    expect(notification.originMeta).toMatchObject({
      backgroundSource: "workflow",
      workId: "dwfrun-1",
    });
  });

  /**
   * run 产物的回投（桌面实测 bug）。原实现按 legacy `Workflow` 的输出形状取 `output.response`：
   * dwf 产物是脚本的任意顶层返回值，record 时没有 `response` 键 → `<result>` 整个缺席；
   * 非 record 时 `isRecord` 门把 output 退到 **launch output**，其 `response` 是「run 已在后台
   * 启动」的陈旧散文——比缺席更糟。以下几条把序列化规则与「绝不回退散文」钉住。
   *
   * launchOutput 只在 `lost` 那两条路径上到得了通知（终态路径根本不传它），所以「不回退散文」
   * 唯一能真正失败的地方是 lost 用例。
   */
  const LAUNCH_PROSE =
    "The workflow script compiled cleanly and the run started in the background with ID: dwfrun-1.";

  async function notificationFor(name: string, artifact: unknown): Promise<string> {
    const { events, notifications } = await trackDynamicWorkflowRun({
      name,
      waitForTask: async () => ({
        status: "completed",
        taskId: "dwfrun-1",
        ...(artifact === undefined ? {} : { output: artifact }),
      }),
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    return notifications[0]!.text;
  }

  it("字符串产物原样进 <result>（不加 JSON 引号）", async () => {
    const text = await notificationFor("dwf-artifact-string", "the final answer");

    expect(text).toContain("<result>the final answer</result>");
    expect(text).not.toContain('"the final answer"');
  });

  it("对象产物按 pretty JSON 进 <result>", async () => {
    const text = await notificationFor("dwf-artifact-object", {
      report: "done",
      steps: [1, 2],
    });

    // JSON.stringify(v, null, 2)，随后经 escapeXml（引号变 &quot;）。
    expect(text).toContain("&quot;report&quot;: &quot;done&quot;");
    expect(text).toContain("&quot;steps&quot;");
    expect(text).toContain("<result>{\n");
  });

  it("非 record 的数组产物也走 pretty JSON", async () => {
    const text = await notificationFor("dwf-artifact-array", ["one", "two"]);

    expect(text).toContain("&quot;one&quot;");
    expect(text).toContain("<result>[\n");
  });

  // 产物缺席时 `<result>` 整字段缺席。
  it("undefined 产物没有 <result>", async () => {
    const text = await notificationFor("dwf-artifact-absent", undefined);

    expect(text).not.toContain("<result>");
  });

  it("失败的 run 带 <error> 不带 <result>", async () => {
    const { events, notifications } = await trackDynamicWorkflowRun({
      name: "dwf-artifact-failed",
      waitForTask: async () => ({
        status: "failed",
        taskId: "dwfrun-1",
        error: "script threw TypeError",
      }),
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );

    const text = notifications[0]!.text;
    expect(text).toContain("<error>script threw TypeError</error>");
    expect(text).not.toContain("<result>");
  });

  // 这条是「比缺席更糟」的那一种：lost 路径把 launch output 递进通知，原实现于是把
  // 「run 已在后台启动」的陈旧散文当成 run 的结果回给模型。dwf 必须整字段缺席。
  it("lost 的 dwf run 绝不把 launch 散文当结果回投", async () => {
    const { events, notifications } = await trackDynamicWorkflowRun({
      launchOutput: { response: LAUNCH_PROSE },
      name: "dwf-artifact-lost",
      waitForTask: async () => undefined,
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );

    const text = notifications[0]!.text;
    expect(text).toContain("its in-process state was lost");
    expect(text).not.toContain("<result>");
    expect(text).not.toContain(LAUNCH_PROSE);
  });

  // ── 渐进产物（report）随完成通知回投（docs/dynamic-workflow/transcript-and-notifications.md「Notifications」）──
  //
  // 三个终态一律携带，因为一个死在半途的 run 仍然做完了前面那些活——捞回它正是 report 存在
  // 的理由，而一句「失败」把它全扔了。条目来自 journal 的 kind="report" 行（run service 把它
  // 们放在快照的 `reports` 上），不是 memory-only 的 workflowRuns 投影。

  async function notificationWithReports(
    name: string,
    snapshot: Record<string, unknown>,
  ): Promise<string> {
    const { events, notifications } = await trackDynamicWorkflowRun({
      name,
      waitForTask: async () => ({ taskId: "dwfrun-1", ...snapshot }),
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    return notifications[0]!.text;
  }

  it("completed 的通知带 <reports>：真实总数 + 逐条预览（string 原样 / object pretty JSON）", async () => {
    const text = await notificationWithReports("dwf-reports-completed", {
      status: "completed",
      output: "final answer",
      reports: ["3 stale imports", { file: "a.ts", severity: "warn" }],
    });

    expect(text).toContain('<reports count="2">');
    expect(text).toContain("[1] 3 stale imports");
    // 序列化规则与 <result> 同源：object 走 pretty JSON（经 escapeXml，引号变 &quot;）。
    expect(text).toContain("[2] {");
    expect(text).toContain("&quot;file&quot;: &quot;a.ts&quot;");
    // 全部条目都进了预览，所以不带 shown 属性（shown 的存在本身就意味着"预览是局部的"）。
    expect(text).not.toContain("shown=");
    // 产物与 run 结果是两件事，两者同时在场。
    expect(text).toContain("<result>final answer</result>");
  });

  it("failed 与 cancelled 的通知一样带 reports（这条是 report 特性的目的）", async () => {
    const failed = await notificationWithReports("dwf-reports-failed", {
      status: "failed",
      error: "script threw TypeError",
      reports: ["finding before the crash"],
    });
    expect(failed).toContain('<reports count="1">');
    expect(failed).toContain("[1] finding before the crash");
    expect(failed).toContain("<error>script threw TypeError</error>");
    // 失败的 run 没有产物，但有报告——两者必须能分辨。
    expect(failed).not.toContain("<result>");

    const cancelled = await notificationWithReports("dwf-reports-cancelled", {
      status: "cancelled",
      reports: ["finding before the cancel"],
    });
    expect(cancelled).toContain('<reports count="1">');
    expect(cancelled).toContain("[1] finding before the cancel");
  });

  // ── 呈现指引（docs/dynamic-workflow/authoring.md「What the main agent is told when a run ends」）──
  //
  // XML 之后追加一段散文，告诉主代理把 run 的结果当交付物呈现。completed 与非 completed 各一段；
  // 散文排在 reports 之后，所以总截断先斩它。
  it("completed 的通知在 XML 之后带交付物呈现指引", async () => {
    const text = await notificationWithReports("dwf-guidance-completed", {
      status: "completed",
      output: "final answer",
      reports: ["one finding"],
    });
    const close = text.indexOf("</task-notification>");
    const guidance = text.indexOf("Present its outcome to the user as a deliverable");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(guidance).toBeGreaterThan(close);
    expect(text).toContain("which findings were confirmed by a deterministic check or an independent subagent");
    expect(text).toContain("Do not restate the phase graph or the script.");
    expect(text).not.toContain("Present what it salvaged first");
  });

  it("failed / cancelled 的通知带抢救优先的指引", async () => {
    const failed = await notificationWithReports("dwf-guidance-failed", {
      status: "failed",
      error: "script threw TypeError",
      reports: ["finding before the crash"],
    });
    expect(failed.indexOf("Present what it salvaged first")).toBeGreaterThan(
      failed.indexOf("</task-notification>"),
    );
    expect(failed).toContain("AmendWorkflow");
    expect(failed).not.toContain("Present its outcome to the user as a deliverable");

    const cancelled = await notificationWithReports("dwf-guidance-cancelled", {
      status: "cancelled",
      reports: ["finding before the cancel"],
    });
    expect(cancelled).toContain("Present what it salvaged first");
  });

  it("零条 report 时整节缺席，不发一节空的 <reports>", async () => {
    const noKey = await notificationWithReports("dwf-reports-absent", {
      status: "completed",
      output: "done",
    });
    expect(noKey).not.toContain("<reports");

    const emptyList = await notificationWithReports("dwf-reports-empty", {
      status: "completed",
      output: "done",
      reports: [],
    });
    expect(emptyList).not.toContain("<reports");
  });

  /**
   * 截断与计数**两者都重要**：计数才是让主 agent 知道「预览是局部的、全量可经 run id 取回」
   * 的那个信号。只给预览会让模型以为它看到了全部。
   */
  it("预览按预算截断，但 count 是真实总数且 shown 说明预览有多少条", async () => {
    const reports = Array.from({ length: 300 }, (_, index) => `finding ${index + 1} `.repeat(20));
    const text = await notificationWithReports("dwf-reports-truncated", {
      status: "completed",
      reports,
    });

    expect(text).toContain('count="300"');
    const shown = /shown="(\d+)"/u.exec(text);
    expect(shown).not.toBeNull();
    const shownCount = Number(shown![1]);
    expect(shownCount).toBeGreaterThan(0);
    expect(shownCount).toBeLessThan(300);
    // 预览从第一条开始给（最早的发现最可能是别的条目的前提）。
    expect(text).toContain("[1] finding 1");
  });

  // 快照只带前 256 条 item，真实总数在 `reportCount`（docs/execution-engine.md「Reading the
  // journal」）：count 必须说 run 的总数，而不是快照里的条数——否则一个报了 65,536 条的 run
  // 会在通知里自称只报了 256 条，模型就不会去取剩下的。
  it("count 读快照的 reportCount：快照截在 256 条时仍报真实总数", async () => {
    const reports = Array.from({ length: 256 }, (_, index) => `f${index + 1}`);
    const text = await notificationWithReports("dwf-reports-count-from-snapshot", {
      status: "completed",
      reports,
      reportCount: 65_536,
    });
    expect(text).toContain('count="65536"');
    const shown = /shown="(\d+)"/u.exec(text);
    expect(Number(shown?.[1])).toBeLessThanOrEqual(256);
    expect(text).toContain("[1] f1");
  });

  it("没有 reportCount 的老快照退回条目数", async () => {
    const text = await notificationWithReports("dwf-reports-count-legacy", {
      status: "completed",
      reports: ["a", "b", "c"],
    });
    expect(text).toContain('<reports count="3">');
  });

  // ── run 的脚本文件（docs/dynamic-workflow/launch.md「Script files」）──
  //
  // 端口在快照上给绝对路径（run 身份的一部分），追踪器交给指引的是**工作区相对**写法：
  // 主代理接下来要 Edit 这个文件，而那是它在别处读写文件时用的那一种路径。
  it("errored 的指引带上快照里的脚本文件，写成工作区相对路径", async () => {
    const text = await notificationWithReports("dwf-script-path-errored", {
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
      scriptPath: "/tmp/.zcode/workflow-drafts/audit.dwf.ts",
    });

    expect(text).toContain(
      'The run\'s script is at .zcode/workflow-drafts/audit.dwf.ts. Edit that file in place, then call AmendWorkflow (run_id="dwfrun-1", path=".zcode/workflow-drafts/audit.dwf.ts")',
    );
    expect(text).not.toContain("Fix the script and submit it with AmendWorkflow");
    // 路径只进指引，不进 XML 块：用户面一概不显示它（spec 的「What the user sees」）。
    expect(text.indexOf(".zcode/workflow-drafts")).toBeGreaterThan(
      text.indexOf("</task-notification>"),
    );
  });

  it("工作目录之外的脚本文件原样给绝对路径", async () => {
    const text = await notificationWithReports("dwf-script-path-outside", {
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
      scriptPath: "/elsewhere/shared/audit.dwf.ts",
    });

    expect(text).toContain("The run's script is at /elsewhere/shared/audit.dwf.ts.");
  });

  it("stopped(model) 的指引在快照有文件时多一句「编辑它、传 path」", async () => {
    const text = await notificationWithReports("dwf-script-path-stopped", {
      status: "cancelled",
      runStatus: "stopped",
      stopReason: "model",
      scriptPath: "/tmp/.zcode/workflow-drafts/audit.dwf.ts",
    });

    expect(text).toContain(
      "Its script is at .zcode/workflow-drafts/audit.dwf.ts: edit that file and pass `path`.",
    );
  });

  it("快照没有脚本文件时指引逐字节退回旧话（老端口 / 草稿写不下去的项目）", async () => {
    const text = await notificationWithReports("dwf-script-path-absent", {
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
    });

    expect(text).toContain(
      'Fix the script and submit it with AmendWorkflow (run_id="dwfrun-1") so finished work is reused.',
    );
    expect(text).not.toContain("Edit that file in place");
  });

  // ── 用户面产物（docs/dynamic-workflow/authoring.md「How the user sees them」）──
  //
  // ⚠ 术语：本 describe 里的 artifact 有两个义。`<result>` 那一族是脚本的**顶层返回值**
  // （引擎内部的 `RunSettlement.artifact`），`<artifacts>` 这一节是脚本经 `artifact.*`
  // **发布给用户看的产出**。两者在同一条通知里并列出现，措辞必须可区分。

  it("completed 的通知带 <artifacts>，排在 <reports> 之后，一行一件", async () => {
    const text = await notificationWithReports("dwf-artifacts-completed", {
      status: "completed",
      output: "final answer",
      reports: ["a finding"],
      artifacts: [
        {
          id: "audit",
          kind: "file",
          title: "审计报告",
          version: 2,
          contentType: "application/pdf",
          itemCount: 0,
          versions: [{ version: 1, publishedAt: 1, bytes: 10 }, { version: 2, publishedAt: 2, bytes: 4096 }],
        },
        {
          id: "perf",
          kind: "chart",
          version: 1,
          itemCount: 12,
          versions: [{ version: 1, publishedAt: 3 }],
        },
      ],
    });

    expect(text).toContain('<artifacts count="2">');
    // 内容产物：contentType + 最新版的字节数。
    expect(text).toContain("- audit (file, v2, application/pdf, 4096 bytes): 审计报告");
    // 预置看板：没有字节，数据量是标签 report 的条数；无 title 时不带冒号。
    expect(text).toContain("- perf (chart, v1, 12 items)");
    expect(text).not.toContain("- perf (chart, v1, 12 items):");
    // 顺序：<reports> 在前、<artifacts> 在后（120k 总截断先斩后者）。
    expect(text.indexOf("<reports")).toBeGreaterThan(-1);
    expect(text.indexOf("<artifacts")).toBeGreaterThan(text.indexOf("</reports>"));
    // 呈现指引追加句只在产物在场时出现。
    expect(text).toContain("already in front of the user as cards");
  });

  it("failed 与 cancelled 的通知一样带 <artifacts>，并给一句更短的指引", async () => {
    const artifacts = [
      { id: "notes", kind: "markdown", version: 1, contentType: "text/markdown", itemCount: 0, versions: [{ version: 1, publishedAt: 1, bytes: 128 }] },
    ];
    const failed = await notificationWithReports("dwf-artifacts-failed", {
      status: "failed",
      error: "ask #12 threw",
      artifacts,
    });
    expect(failed).toContain('<artifacts count="1">');
    expect(failed).toContain("- notes (markdown, v1, text/markdown, 128 bytes)");
    expect(failed).toContain("Artifacts listed above are already in front of the user.");
    expect(failed).not.toContain("already in front of the user as cards");

    const cancelled = await notificationWithReports("dwf-artifacts-cancelled", {
      status: "cancelled",
      artifacts,
    });
    expect(cancelled).toContain('<artifacts count="1">');
  });

  it("零件时整节缺席，指引也不长出那一句（没有清单可引用）", async () => {
    const noKey = await notificationWithReports("dwf-artifacts-absent", { status: "completed" });
    expect(noKey).not.toContain("<artifacts");
    expect(noKey).not.toContain("already in front of the user");

    const emptyList = await notificationWithReports("dwf-artifacts-empty", {
      status: "completed",
      artifacts: [],
    });
    expect(emptyList).not.toContain("<artifacts");
  });

  it("超过 8 件时 shown 在场且 count 仍是真实总数", async () => {
    const artifacts = Array.from({ length: 11 }, (_, index) => ({
      id: `a${index + 1}`,
      kind: "markdown",
      version: 1,
      itemCount: 0,
      versions: [{ version: 1, publishedAt: 1, bytes: 8 }],
    }));
    const text = await notificationWithReports("dwf-artifacts-truncated", {
      status: "completed",
      artifacts,
    });

    expect(text).toContain('<artifacts count="11" shown="8">');
    expect(text).toContain("- a1 (markdown, v1, 8 bytes)");
    expect(text).toContain("- a8 (markdown, v1, 8 bytes)");
    expect(text).not.toContain("- a9 (");
  });

  it("形状不合的条目被跳过而不是让整节消失", async () => {
    const text = await notificationWithReports("dwf-artifacts-malformed", {
      status: "completed",
      artifacts: [
        null,
        "not an object",
        { id: "ok", kind: "file", version: 1, itemCount: 0, versions: [] },
        // version 缺席 ⇒ 无法定位版本，整条丢。
        { id: "broken", kind: "file", itemCount: 0, versions: [] },
      ],
    });
    expect(text).toContain('<artifacts count="1">');
    expect(text).toContain("- ok (file, v1)");
    expect(text).not.toContain("broken");
  });

  // legacy `Workflow` 的通知逐字节不变：它的 `output.response` 真实存在，lost 路径上的
  // launchOutput 回退是它自己的契约。dwf 的修订不得溢出到这条路径上。
  it("legacy Workflow 的通知仍取 output.response 并保留 launchOutput 回退", async () => {
    async function legacyNotification(getTask?: () => Promise<unknown>): Promise<string> {
      const sessionId = createSessionId("legacy-workflow-result");
      const turnId = createTurnId("legacy-workflow-result");
      const events: { payload: Record<string, unknown>; type: string }[] = [];
      const notifications: { text: string }[] = [];
      const tracker = new BackgroundTaskTracker({
        emitEvent: async (event) => {
          events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
        },
        enqueueBackgroundTaskNotification: (notification) => {
          notifications.push(notification);
          return undefined;
        },
        ...(getTask ? { workflowPort: { getTask } } : {}),
        getWorkingDirectory: () => "/tmp",
        getWorkspaceRoot: () => "/tmp",
        readFileState: new Map(),
        runtimeScope: "main",
        sessionId,
      } as never);

      await tracker.trackBackgroundTask(
        { id: "tool_workflow_result", input: { scriptPath: "w.ts" }, name: "Workflow" } as never,
        { backgroundTaskId: "wfrun-1", response: "legacy launch prose", status: "backgrounded" },
        { traceId: "trace_legacy_result", spanId: "span_legacy_result", sessionId, turnId },
        turnId,
      );
      await waitForCondition(() =>
        events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      );
      return notifications[0]!.text;
    }

    const withResponse = await legacyNotification(async () => ({
      status: "completed",
      runId: "wfrun-1",
      output: { response: "legacy workflow answer" },
      // 即便端口硬塞一个 reports 字段，legacy 通知也不长出 <reports> 这一节：渐进产物是
      // dwf 独有的概念，两套 workflow 机制不共用通知形状。
      reports: ["should not surface"],
      // 用户面产物同理（docs/dynamic-workflow/authoring.md：legacy `Workflow` 通知逐字节不变）。
      artifacts: [
        {
          id: "should-not-surface",
          kind: "file",
          version: 1,
          itemCount: 0,
          versions: [{ version: 1, publishedAt: 1, bytes: 4 }],
        },
      ],
    }));
    expect(withResponse).toContain("<result>legacy workflow answer</result>");
    expect(withResponse).not.toContain("<reports");
    expect(withResponse).not.toContain("should not surface");
    expect(withResponse).not.toContain("<artifacts");
    expect(withResponse).not.toContain("should-not-surface");
    // 呈现指引整块也不属于 legacy：它的通知没有这一段。
    expect(withResponse).not.toContain("already in front of the user");

    // 端口缺席（lost）时回退到 launch output 的 response——legacy 的既有契约，逐字保留。
    const fallback = await legacyNotification();
    expect(fallback).toContain("<result>legacy launch prose</result>");
  });

  // 端口缺席的 CreateWorkflow：没有快照源就按既有语义标 lost，而不是永远挂着轮询。
  it("端口缺席时 CreateWorkflow 立即标记 lost", async () => {
    const sessionId = createSessionId("dwf-no-port");
    const turnId = createTurnId("dwf-no-port");
    const events: { payload: Record<string, unknown>; type: string }[] = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_cw_lost", input: { script: "" }, name: "CreateWorkflow" } as never,
      { backgroundTaskId: "dwfrun-lost", status: "backgrounded" },
      { traceId: "trace_dwf_lost", spanId: "span_dwf_lost", sessionId, turnId },
      turnId,
    );

    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({ status: "lost", taskId: "dwfrun-lost" });
  });

  // 回归护栏：legacy Workflow 的四处语义不能被泛化改写——它没有快照提供者以外的取消能力，
  // started payload 的 cancellable 必须仍为 false。
  it("legacy Workflow 的 cancellable 仍为 false", async () => {
    const sessionId = createSessionId("legacy-workflow-cancellable");
    const turnId = createTurnId("legacy-workflow-cancellable");
    const events: { payload: Record<string, unknown>; type: string }[] = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
      },
      workflowPort: {
        async getTask() {
          return { status: "running", runId: "wfrun-1" };
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_workflow_1", input: { scriptPath: "w.ts" }, name: "Workflow" } as never,
      { backgroundTaskId: "wfrun-1", status: "backgrounded" },
      { traceId: "trace_legacy_wf", spanId: "span_legacy_wf", sessionId, turnId },
      turnId,
    );

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({ cancellable: false, taskId: "wfrun-1" });
  });

  /**
   * 回归护栏：展示名的修订只对 CreateWorkflow 生效，其他工具的 `description` 逐字节不变。
   * Bash 的既有优先级是 `input.description` 先于 `snapshot.description`，两者都缺则整字段缺席
   * （面板据此退到命令行文本）——三种情形一次钉住。
   */
  it("Bash 的展示名仍是 input.description 优先于快照，缺席时为 undefined", async () => {
    async function trackBash(input: Record<string, unknown>): Promise<
      { payload: Record<string, unknown>; type: string }[]
    > {
      const sessionId = createSessionId("bash-description-pin");
      const turnId = createTurnId("bash-description-pin");
      const events: { payload: Record<string, unknown>; type: string }[] = [];
      const tracker = new BackgroundTaskTracker({
        emitEvent: async (event) => {
          events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
        },
        executionPort: {
          async run() {
            throw new Error("run should not be called");
          },
          async waitForBackgroundTask() {
            return {
              taskId: "bash_description",
              status: "completed",
              description: "snapshot description",
              startedAt: new Date(0),
              completedAt: new Date(1),
              stdoutTail: "done",
            };
          },
        },
        getWorkingDirectory: () => "/tmp",
        getWorkspaceRoot: () => "/tmp",
        readFileState: new Map(),
        runtimeScope: "main",
        sessionId,
      } as never);

      await tracker.trackBackgroundTask(
        { id: "tool_bash_description", input, name: "Bash" } as never,
        { backgroundTaskId: "bash_description", status: "backgrounded" },
        { traceId: "trace_bash_description", spanId: "span_bash_description", sessionId, turnId },
        turnId,
      );
      await waitForCondition(() =>
        events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      );
      return events;
    }

    const withDescription = await trackBash({ command: "npm run dev", description: "dev server" });
    // started 没有快照，只能来自 input；completed 有快照，input 仍然优先。
    expect(
      withDescription.find((event) => event.type === SessionEventType.BackgroundTaskStarted)
        ?.payload.description,
    ).toBe("dev server");
    expect(
      withDescription.find((event) => event.type === SessionEventType.BackgroundTaskCompleted)
        ?.payload.description,
    ).toBe("dev server");

    const withoutDescription = await trackBash({ command: "npm run dev" });
    expect(
      withoutDescription.find((event) => event.type === SessionEventType.BackgroundTaskStarted)
        ?.payload.description,
    ).toBeUndefined();
    expect(
      withoutDescription.find((event) => event.type === SessionEventType.BackgroundTaskCompleted)
        ?.payload.description,
    ).toBe("snapshot description");
  });
});

/**
 * 取消的唯一路径：`cancelBackgroundWork {workId}` → `app.cancelBackgroundTask` →
 * `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask` → 端口的 `cancel(runId)`。
 *
 * 这条链按 RuntimeTaskType 分派（runtime/methods/background.ts），与追踪器的按工具名查表
 * 是两处独立的分派。spec 只点了追踪器那五处；这一组测的是链路后半段——不接它，
 * `cancellable: true` 只会给出一个点下去毫无反应的按钮。
 */
describe("dynamic workflow run cancellation", () => {
  it("cancelBackgroundTask 经运行时分派打到端口的 cancel", async () => {
    const sessionId = createSessionId("dwf-cancel-dispatch");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const cancelled: string[] = [];
    const startedAt = new Date(0);

    runtimeTaskRegistry.register({
      agentId: "dwfrun-cancel",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt,
      status: "running",
      taskId: "dwfrun-cancel",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);
    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        startedAt,
        status: "running",
        taskId: "dwfrun-cancel",
        terminalId: "dwfrun-cancel",
        toolCallId: "tool_create_workflow",
        toolName: "CreateWorkflow",
      }),
    );

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask(taskId: string) {
            return { taskId, status: cancelled.includes(taskId) ? "cancelled" : "running" };
          },
          async waitForTask(taskId: string) {
            return { taskId, status: "cancelled" };
          },
          async cancel(runId: string) {
            cancelled.push(runId);
            return true;
          },
          async listEvents() {
            return [];
          },
        },
        eventStore,
        runtimeTaskRegistry,
      } as never,
    );

    const result = await runtime.cancelBackgroundTask("dwfrun-cancel");

    // 端口收到了 runId（workId ≡ taskId ≡ runId，无身份映射表）。
    expect(cancelled).toEqual(["dwfrun-cancel"]);
    expect(result).toMatchObject({ cancelled: true, status: "cancelled", taskId: "dwfrun-cancel" });
  });

  it("端口对未知 run 返回 false 时归一成 not_found 而不是静默成功", async () => {
    const sessionId = createSessionId("dwf-cancel-unknown");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "dwfrun-gone",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-gone",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask() {
            return undefined;
          },
          async waitForTask() {
            return undefined;
          },
          async cancel() {
            return false;
          },
          async listEvents() {
            return [];
          },
        },
        eventStore,
        runtimeTaskRegistry,
      } as never,
    );

    const result = await runtime.cancelBackgroundTask("dwfrun-gone");
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe("background_task_not_found");
  });

  // 端口整个缺席（未接线的宿主）：得结构化的"能力不支持"，不能假装取消成功。
  it("端口缺席时报能力不支持", async () => {
    const sessionId = createSessionId("dwf-cancel-no-port");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "dwfrun-noport",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-noport",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, runtimeTaskRegistry } as never,
    );

    const result = await runtime.cancelBackgroundTask("dwfrun-noport");
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe("background_task_cancel_not_supported");
  });
});

/**
 * FORK-1 的两个后果，各自钉一条测试。
 *
 * 1. **回收护栏**：runtime task registry 是 `hasRunningBackgroundRuntimeTask` 的数据源，
 *    而那个谓词决定常驻 session 会不会被回收。CreateWorkflow 此前在
 *    `runtimeTaskTypeForToolCall` 里没有映射，registerRuntimeBackgroundTask 因此整个早退——
 *    一个在飞的 run 会让 session 看起来空闲，被回收掉之后完成通知无处投递。这比"取消按钮
 *    点不动"更难查，所以单独成测。
 * 2. **两个入口一个实现**：GUI 的 cancelBackgroundWork 与模型的 TaskStop 都落到
 *    runtime.stopBackgroundTask（后者经 backgroundTaskControlPort，runtime-tools.ts:144
 *    绑定的正是同一个方法），只在 strict 上不同。
 */
describe("dynamic workflow background task registration", () => {
  async function trackWithRegistry(runtimeTaskRegistry: InMemoryRuntimeTaskRegistry) {
    const sessionId = createSessionId("dwf-registry");
    const turnId = createTurnId("dwf-registry");
    const tracker = new BackgroundTaskTracker({
      emitEvent: async () => {},
      dynamicWorkflowRunPort: {
        async submit() {
          throw new Error("submit should not be called");
        },
        async getTask(taskId: string) {
          return { taskId, runId: taskId, startedAt: new Date(0), status: "running" };
        },
        // 永不结算：run 在测试期间保持在飞。
        waitForTask: () => new Promise(() => {}),
        async cancel() {
          return true;
        },
        async listEvents() {
          return [];
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      runtimeTaskRegistry,
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_cw_registry", input: { script: "" }, name: "CreateWorkflow" } as never,
      { backgroundTaskId: "dwfrun-live", status: "backgrounded" },
      { traceId: "trace_dwf_registry", spanId: "span_dwf_registry", sessionId, turnId },
      turnId,
    );
  }

  it("在飞的 run 登记进 registry，回收护栏因此为真", async () => {
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    // 前提：没有任何在飞后台任务时护栏为假。
    expect(hasRunningBackgroundRuntimeTask(runtimeTaskRegistry)).toBe(false);

    await trackWithRegistry(runtimeTaskRegistry);

    // 登记发生了，且类型是 dwf 专属的那个（不是 legacy local_workflow，也不是 undefined）。
    expect(runtimeTaskRegistry.get("dwfrun-live")).toMatchObject({
      isBackgrounded: true,
      status: "running",
      taskId: "dwfrun-live",
      type: "local_dynamic_workflow",
    });
    // 护栏为真 → 有在飞 run 的 session 不会被当作空闲回收。
    expect(hasRunningBackgroundRuntimeTask(runtimeTaskRegistry)).toBe(true);
  });

  it("模型侧 TaskStop 与 GUI 侧取消共用 runtime.stopBackgroundTask，同样打到 port.cancel", async () => {
    const sessionId = createSessionId("dwf-taskstop");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const cancelled: string[] = [];
    runtimeTaskRegistry.register({
      agentId: "dwfrun-taskstop",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-taskstop",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask(taskId: string) {
            return { taskId, runId: taskId, startedAt: new Date(0), status: "running" };
          },
          async waitForTask(taskId: string) {
            return { taskId, runId: taskId, startedAt: new Date(0), status: "cancelled" };
          },
          async cancel(runId: string) {
            cancelled.push(runId);
            return true;
          },
          async listEvents() {
            return [];
          },
        },
        eventStore,
        runtimeTaskRegistry,
      } as never,
    );

    // 这就是 runtime-tools.ts:144 交给工具执行上下文的那个绑定。
    const backgroundTaskControlPort = {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    };
    const output = (await taskStopToolEntry.handler(
      { task_id: "dwfrun-taskstop" },
      { backgroundTaskControlPort, toolCallId: "tool_task_stop" } as never,
    )) as { task_id?: string; task_type?: string };

    // 关键断言：模型侧入口也把 runId 直送到了端口的 cancel。
    expect(cancelled).toEqual(["dwfrun-taskstop"]);
    // 并且工具向模型报告的是 dwf 专属类型，不是被归成 bash/legacy workflow。
    expect(output.task_id).toBe("dwfrun-taskstop");
    expect(output.task_type).toBe("local_dynamic_workflow");
  });
});

// 停止分支记「谁停的」（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Cancel and resume」 2026-09-09）：只在 dwf 分支、
// 只在调用方给了 initiator 时写；写在 port.cancel 之前。
describe("dwf 停止分支记录 stopInitiator", () => {
  function dwfRuntime(
    name: string,
    cancelled: string[],
  ): {
    runtime: AgentRuntime;
    registry: InMemoryRuntimeTaskRegistry;
  } {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "dwfrun-stop",
      agentType: "local_dynamic_workflow",
      description: "Dynamic workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-stop",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);
    const runtime = createTestAgentRuntime(
      createSessionId(name),
      { mode: "build" },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask() {
            return {
              runId: "dwfrun-stop",
              taskId: "dwfrun-stop",
              startedAt: new Date(),
              status: "running",
            };
          },
          async waitForTask() {
            return new Promise(() => undefined);
          },
          async cancel(runId: string) {
            // 断言顺序：abort 时 initiator 已经在条目上。
            cancelled.push(`${runId}:${registry.get(runId)?.stopInitiator ?? "none"}`);
            return true;
          },
          async listEvents() {
            return [];
          },
        } as never,
      },
    );
    return { runtime, registry };
  }

  it("stopBackgroundTask({initiator}) 在 abort 之前把 initiator 写进条目", async () => {
    const cancelled: string[] = [];
    const { runtime, registry } = dwfRuntime("dwf-stop-model", cancelled);
    await expect(
      (runtime as any).stopBackgroundTask("dwfrun-stop", { initiator: "model", strict: true }),
    ).resolves.toMatchObject({ ok: true, status: "cancelled", type: "local_dynamic_workflow" });
    expect(cancelled).toEqual(["dwfrun-stop:model"]);
    expect(registry.get("dwfrun-stop")?.stopInitiator).toBe("model");
  });

  it("cancelBackgroundTask（GUI 入口）写 user；不带 initiator 的停止不写", async () => {
    const viaGui: string[] = [];
    const gui = dwfRuntime("dwf-stop-user", viaGui);
    await gui.runtime.cancelBackgroundTask("dwfrun-stop");
    expect(viaGui).toEqual(["dwfrun-stop:user"]);
    expect(gui.registry.get("dwfrun-stop")?.stopInitiator).toBe("user");

    const plain: string[] = [];
    const system = dwfRuntime("dwf-stop-system", plain);
    await (system.runtime as any).stopBackgroundTask("dwfrun-stop", {});
    expect(plain).toEqual(["dwfrun-stop:none"]);
    expect(system.registry.get("dwfrun-stop")?.stopInitiator).toBeUndefined();
  });
});

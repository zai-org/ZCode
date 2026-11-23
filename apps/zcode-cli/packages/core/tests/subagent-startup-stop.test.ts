import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createInputPreemptionAbortReason,
  createModelId,
  createModelProviderId,
  createSessionId,
  createTurnId,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 前台 Agent 在 child 就绪前被停止：父会话的子代理事件必须成对，不能留下没有终态的运行中子代理。
// 规格见 apps/zcode-cli/docs/design/v2/tool/07-subagent.md 执行流程第 11 步。

const STOP_KINDS = [
  {
    label: "Stop",
    reason: () => new Error("v4 session stopped"),
    runtimeStop: { reason: "v4 session stopped" },
  },
  {
    label: "send-now",
    reason: () => createInputPreemptionAbortReason("v4 sendQueuedNow"),
    runtimeStop: { preserveQueueAutoDrainOnCancel: true, reason: "v4 sendQueuedNow" },
  },
] as const;

describe("foreground subagent stopped during startup", () => {
  for (const stopKind of STOP_KINDS) {
    it(`${stopKind.label} before SubagentSpawned writes no subagent events and stops the child`, async () => {
      const parent = new AbortController();
      const childStarted = createDeferred<void>();
      const childPersisted = createDeferred<void>();
      const readyResult = createDeferred<unknown>();
      const harness = createRunnerHarness({
        runExploreAgent: async (request) => {
          childStarted.resolve();
          await childPersisted.promise;
          // child 的持久化做完后仍会调用 onSessionReady；被停止后它应拒绝，让 child 收尾。
          await request.onSessionReady?.().then(
            () => readyResult.resolve("resolved"),
            (error: unknown) => readyResult.resolve(error),
          );
          return { events: [], response: "unreachable", traceId: "trace_child" };
        },
      });

      const run = harness.port.run(harness.request(), { signal: parent.signal });
      await childStarted.promise;
      parent.abort(stopKind.reason());

      await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      childPersisted.resolve();
      expect(await readyResult.promise).toBeInstanceOf(Error);
      await harness.port.close?.();
      expect(harness.emitted).toEqual([]);
    });

    it(`${stopKind.label} while SubagentSpawned is written adds SubagentStopped after it`, async () => {
      const parent = new AbortController();
      const spawnedWriteStarted = createDeferred<void>();
      const spawnedWriteMayFinish = createDeferred<void>();
      const readyResult = createDeferred<unknown>();
      const harness = createRunnerHarness({
        emitParentEvent: async (event, log) => {
          log.push(`start:${event.type}`);
          if (event.type === SessionEventType.SubagentSpawned) {
            spawnedWriteStarted.resolve();
            await spawnedWriteMayFinish.promise;
          }
          log.push(`end:${event.type}`);
        },
        runExploreAgent: async (request) => {
          await request.onSessionReady?.().then(
            () => readyResult.resolve("resolved"),
            (error: unknown) => readyResult.resolve(error),
          );
          return { events: [], response: "unreachable", traceId: "trace_child" };
        },
      });

      const run = harness.port.run(harness.request(), { signal: parent.signal });
      await spawnedWriteStarted.promise;
      parent.abort(stopKind.reason());

      // 取消结果不等事件写入：SubagentSpawned 还没写完，Agent 已经返回取消。
      await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(harness.log).toEqual([`start:${SessionEventType.SubagentSpawned}`]);

      spawnedWriteMayFinish.resolve();
      // Spawned 写完后 onSessionReady 仍拒绝：child 收尾，不在已取消的任务里继续运行。
      expect(await readyResult.promise).toBeInstanceOf(Error);
      await harness.port.close?.();
      expect(harness.log).toEqual([
        `start:${SessionEventType.SubagentSpawned}`,
        `end:${SessionEventType.SubagentSpawned}`,
        `start:${SessionEventType.SubagentStopped}`,
        `end:${SessionEventType.SubagentStopped}`,
      ]);
      expect(harness.emitted.at(-1)?.payload).toMatchObject({
        agentId: harness.agentId,
        parentToolCallId: harness.parentToolCallId,
        status: "failed",
        error:
          "Agent was cancelled before the subagent returned findings or background launch completed",
      });
    });
  }

  it("adds no SubagentStopped when the SubagentSpawned write itself fails", async () => {
    const parent = new AbortController();
    const spawnedWriteStarted = createDeferred<void>();
    const spawnedWriteMayFail = createDeferred<void>();
    const harness = createRunnerHarness({
      emitParentEvent: async (event, log) => {
        log.push(`start:${event.type}`);
        if (event.type === SessionEventType.SubagentSpawned) {
          spawnedWriteStarted.resolve();
          await spawnedWriteMayFail.promise;
          throw new Error("event store unavailable");
        }
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return { events: [], response: "unreachable", traceId: "trace_child" };
      },
    });

    const run = harness.port.run(harness.request(), { signal: parent.signal });
    await spawnedWriteStarted.promise;
    parent.abort(new Error("v4 session stopped"));
    await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });

    spawnedWriteMayFail.resolve();
    await harness.port.close?.();
    expect(harness.log).toEqual([`start:${SessionEventType.SubagentSpawned}`]);
  });

  it("a stop entry that commits first while SubagentSpawned is written leaves only its own terminal", async () => {
    const spawnedWriteStarted = createDeferred<void>();
    const spawnedWriteMayFinish = createDeferred<void>();
    const harness = createRunnerHarness({
      emitParentEvent: async (event) => {
        if (event.type === SessionEventType.SubagentSpawned) {
          spawnedWriteStarted.resolve();
          await spawnedWriteMayFinish.promise;
        }
      },
      enqueueParentTaskNotification: () => {},
      runExploreAgent: async (request, options) => {
        await request.onSessionReady?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw options?.signal?.reason ?? new Error("child aborted");
      },
    });

    // 父级没有取消：owner close 经 stopTask 先把任务收口为 killed、写好终态，再取消 child。
    const run = harness.port.run(harness.request(), { signal: new AbortController().signal });
    await spawnedWriteStarted.promise;
    const closing = harness.port.close?.();
    await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
    spawnedWriteMayFinish.resolve();
    await closing;

    const stopped = harness.emitted.filter(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.payload).toMatchObject({ agentId: harness.agentId, status: "stopped" });
  });

  it("a stop entry that commits before SubagentSpawned starts keeps Spawned from being written", async () => {
    const childStarted = createDeferred<void>();
    const childPersisted = createDeferred<void>();
    const readyResult = createDeferred<unknown>();
    const stoppedWriteStarted = createDeferred<void>();
    const stoppedWriteMayFinish = createDeferred<void>();
    const harness = createRunnerHarness({
      emitParentEvent: async (event, log) => {
        log.push(`start:${event.type}`);
        if (event.type === SessionEventType.SubagentStopped) {
          stoppedWriteStarted.resolve();
          await stoppedWriteMayFinish.promise;
        }
        log.push(`end:${event.type}`);
      },
      enqueueParentTaskNotification: () => {},
      runExploreAgent: async (request) => {
        childStarted.resolve();
        await childPersisted.promise;
        // 与生产 child 一样，onSessionReady 的拒绝直接冒泡结束 child，不多等任何微任务。
        try {
          await request.onSessionReady?.();
        } catch (error) {
          readyResult.resolve(error);
          throw error;
        }
        return { events: [], response: "unreachable", traceId: "trace_child" };
      },
    });

    // 父级没有取消：单项停止先把任务收口为 killed。前台任务要等 SubagentStopped(stopped) 写完才取消 child，
    // 这期间 child 就绪，不能再写出排在终态之后的 SubagentSpawned。
    const run = harness.port.run(harness.request(), { signal: new AbortController().signal });
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await childStarted.promise;
    const stopping = harness.port.stopTask?.(harness.agentId);
    await stoppedWriteStarted.promise;
    childPersisted.resolve();
    expect(await readyResult.promise).toBeInstanceOf(Error);
    // 结果由 registry 的 killed 决定，不看先到的是哪个错误：与就绪后的单项停止相同。
    expect(await outcome).toMatchObject({
      type: CoreErrorType.ToolCancelled,
      message: "Subagent was stopped by user",
    });

    stoppedWriteMayFinish.resolve();
    await stopping;
    await harness.port.close?.();
    expect(harness.log).toEqual([
      `start:${SessionEventType.SubagentStopped}`,
      `end:${SessionEventType.SubagentStopped}`,
    ]);
    expect(harness.emitted.at(-1)?.payload).toMatchObject({
      agentId: harness.agentId,
      status: "stopped",
    });
  });

  it("a parent stop and owner close in the same tick while SubagentSpawned is written still end with the stop terminal", async () => {
    const parent = new AbortController();
    const spawnedWriteStarted = createDeferred<void>();
    const spawnedWriteMayFinish = createDeferred<void>();
    const harness = createRunnerHarness({
      emitParentEvent: async (event) => {
        if (event.type === SessionEventType.SubagentSpawned) {
          spawnedWriteStarted.resolve();
          await spawnedWriteMayFinish.promise;
        }
      },
      enqueueParentTaskNotification: () => {},
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return { events: [], response: "unreachable", traceId: "trace_child" };
      },
    });

    const run = harness.port.run(harness.request(), { signal: parent.signal });
    await spawnedWriteStarted.promise;
    // 与生产 closeOwnedWork 同一顺序：先停前台执行，再在同一段同步代码里 close subagent owner。
    parent.abort(new Error("session_closed"));
    const closing = harness.port.close?.();
    await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
    spawnedWriteMayFinish.resolve();
    await closing;

    expect(
      harness.emitted.map(
        (event) => `${event.type}:${(event.payload as { status?: string }).status}`,
      ),
    ).toEqual([
      `${SessionEventType.SubagentSpawned}:running`,
      `${SessionEventType.SubagentStopped}:stopped`,
    ]);
  });

  it("does not write SubagentSpawned or remove the record when the task belongs to another execution", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    const childStarted = createDeferred<void>();
    const childPersisted = createDeferred<void>();
    const harness = createRunnerHarness({
      registry,
      runExploreAgent: async (request) => {
        childStarted.resolve();
        await childPersisted.promise;
        await request.onSessionReady?.();
        return { events: [], response: "unreachable", traceId: "trace_child" };
      },
    });

    const run = harness.port.run(harness.request());
    await childStarted.promise;
    // 同一 agentId 的记录已属于另一次执行：本次执行不再拥有它，既不能写 Spawned，也不能把它移除。
    registry.update(harness.agentId, (task) => ({ ...task, executionId: "another-execution" }));
    childPersisted.resolve();
    await expect(run).rejects.toThrow();

    expect(harness.emitted).toEqual([]);
    expect(registry.get(harness.agentId)).toMatchObject({ executionId: "another-execution" });
    await harness.port.close?.();
  });

  it("writes no subagent events when the child fails before it is ready", async () => {
    const harness = createRunnerHarness({
      runExploreAgent: async () => {
        throw new Error("child session store unavailable");
      },
    });

    await expect(harness.port.run(harness.request())).rejects.toThrow(
      "child session store unavailable",
    );
    await harness.port.close?.();
    expect(harness.emitted).toEqual([]);
  });

  it("a stop after ready still writes exactly one SubagentStopped", async () => {
    const parent = new AbortController();
    const childReady = createDeferred<void>();
    const harness = createRunnerHarness({
      runExploreAgent: async (request, options) => {
        await request.onSessionReady?.();
        childReady.resolve();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw options?.signal?.reason ?? new Error("child aborted");
      },
    });

    const run = harness.port.run(harness.request(), { signal: parent.signal });
    await childReady.promise;
    parent.abort(new Error("v4 session stopped"));
    await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
    await harness.port.close?.();

    expect(harness.emitted.map((event) => event.type)).toEqual([
      SessionEventType.SubagentSpawned,
      SessionEventType.SubagentStopped,
    ]);
  });

  for (const stopKind of STOP_KINDS) {
    it(`agent runtime: ${stopKind.label} during the SubagentSpawned write leaves no running subagent`, async () => {
      const harness = createRuntimeHarness();
      const pendingTurn = harness.runtime.executeTurn("Launch one foreground agent.");
      await harness.spawnedWriteStarted.promise;

      harness.runtime.stopActiveForegroundExecution(stopKind.runtimeStop);
      await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

      harness.spawnedWriteMayFinish.resolve();
      await waitForCondition(async () =>
        (await harness.eventStore.getEvents(harness.sessionId)).some(
          (event) => event.type === SessionEventType.SubagentStopped,
        ),
      );
      await harness.runtime.executeTurn("next prompt");

      const events = await harness.eventStore.getEvents(harness.sessionId);
      const spawned = events.filter((event) => event.type === SessionEventType.SubagentSpawned);
      const stopped = events.filter((event) => event.type === SessionEventType.SubagentStopped);
      expect(spawned).toHaveLength(1);
      expect(stopped).toHaveLength(1);
      // 序号来自同一个 event store：桌面与冷恢复都先看到 Spawned，再看到 Stopped。
      expect(stopped[0]!.sequenceNumber).toBeGreaterThan(spawned[0]!.sequenceNumber);
      expect(stopped[0]!.payload).toMatchObject({
        agentId: (spawned[0]!.payload as { agentId: string }).agentId,
        status: "failed",
      });
      // child 在启动阶段被停止后不再运行：没有发出任何模型请求。
      expect(harness.childModelCalls()).toBe(0);
      await harness.runtime.close();
    });
  }
});

interface RunnerHarnessOptions {
  emitParentEvent?: (event: SessionEvent, log: string[]) => Promise<void>;
  enqueueParentTaskNotification?: Parameters<
    typeof createExploreSubagentPort
  >[0]["enqueueParentTaskNotification"];
  registry?: InMemoryRuntimeTaskRegistry;
  runExploreAgent: Parameters<typeof createExploreSubagentPort>[0]["runExploreAgent"];
}

let harnessIndex = 0;

function createRunnerHarness(options: RunnerHarnessOptions) {
  harnessIndex += 1;
  const agentId = `agent_startup_stop_${harnessIndex}`;
  const parentToolCallId = `call_startup_stop_${harnessIndex}`;
  const sessionId = createSessionId(`startup-stop-runner-${harnessIndex}`);
  const turnId = createTurnId(`startup-stop-runner-${harnessIndex}-turn`);
  const emitted: SessionEvent[] = [];
  const log: string[] = [];
  const port = createExploreSubagentPort({
    createAgentId: () => agentId,
    emitParentEvent: async (event) => {
      await options.emitParentEvent?.(event, log);
      emitted.push(event);
    },
    ...(options.enqueueParentTaskNotification
      ? { enqueueParentTaskNotification: options.enqueueParentTaskNotification }
      : {}),
    ...(options.registry ? { runtimeTaskRegistry: options.registry } : {}),
    runExploreAgent: options.runExploreAgent,
  });
  const request = () => ({
    agentType: "general-purpose",
    description: "Startup stop test",
    parentToolCallId,
    prompt: "Run slowly",
    sessionId,
    trace: {
      traceId: "trace_startup_stop_parent",
      spanId: "span_startup_stop_parent",
      sessionId,
      turnId,
    },
    turnId,
    workingDirectory: "/tmp/zcode-subagent-startup-stop",
    workspaceRoot: "/tmp/zcode-subagent-startup-stop",
  });
  return { agentId, emitted, log, parentToolCallId, port, request };
}

function createRuntimeHarness() {
  harnessIndex += 1;
  const sessionId: SessionId = createSessionId(`startup-stop-runtime-${harnessIndex}`);
  const spawnedWriteStarted = createDeferred<void>();
  const spawnedWriteMayFinish = createDeferred<void>();
  const eventStore = createTestSessionEventStore();
  let gated = false;
  // 只卡住父会话的 SubagentSpawned 写入，其余事件照常落库。
  const gatedEventStore = new Proxy(eventStore, {
    get(target, property, receiver) {
      if (property === "append") {
        return async (event: SessionEvent) => {
          if (!gated && event.type === SessionEventType.SubagentSpawned) {
            gated = true;
            spawnedWriteStarted.resolve();
            await spawnedWriteMayFinish.promise;
          }
          return target.append(event);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SessionEventStorePort;
  let parentModelCalls = 0;
  let childModelCalls = 0;
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      mode: "yolo",
      modelSelection: {
        providerId: createModelProviderId("provider-test"),
        modelId: createModelId("parent-model"),
      },
      titleGeneration: { enabled: false },
      workingDirectory: "/workspace/project",
      // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
      subagents: { alwaysBackground: false },
    },
    {
      eventStore: gatedEventStore,
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (!toolNames.includes("Agent")) {
            childModelCalls += 1;
            return modelText("child result");
          }
          parentModelCalls += 1;
          if (parentModelCalls > 1) return modelText(`parent reply ${parentModelCalls}`);
          return {
            finishReason: "tool-calls",
            providerMetadata: undefined,
            text: "",
            toolCalls: [
              {
                id: "call_startup_stop_agent",
                name: "Agent",
                input: {
                  description: "Startup stop child",
                  prompt: "CHILD: do the work.",
                  subagent_type: "general-purpose",
                },
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
  return {
    childModelCalls: () => childModelCalls,
    eventStore,
    runtime,
    sessionId,
    spawnedWriteMayFinish,
    spawnedWriteStarted,
  };
}

function modelText(text: string) {
  return {
    finishReason: "stop",
    providerMetadata: undefined,
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

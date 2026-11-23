import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
} from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";
import { zcodeSessionEventTypeSchema } from "@zcode/shared";
import { run } from "../src/run.js";
import type { RunDependencies } from "../src/run.js";
import {
  WORKFLOW_RUN_PROGRESS_STREAM_TYPE,
  createHeadlessPermissionBroker,
  createWorkflowProgressReporter,
  isDynamicWorkflowRunProgressEvent,
  mapWorkflowRunProgressStreamLine,
  waitForHeadlessSettle,
} from "../src/headless-workflow.js";

const progressEvent = (
  payload: Partial<DynamicWorkflowRunProgressPayload> & { eventType: string },
  envelope: Partial<SessionEvent> = {},
): SessionEvent =>
  ({
    id: "evt-dwf-1",
    sessionId: "session-test",
    traceId: "trace-test",
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(1_700_000_000_000),
    sequenceNumber: 7,
    payload: {
      runId: "dwfrun-abc",
      sequence: 3,
      payload: {},
      ...payload,
    },
    ...envelope,
  }) as SessionEvent;

const permissionRequest = (toolName: string) =>
  ({
    requestId: "perm_1",
    sessionId: "session-test",
    traceId: "trace-test",
    toolCallId: "call-1",
    toolName,
    input: {},
    mode: "build",
    ruleId: "tool.alwaysAsk",
    reason: `Tool ${toolName} always requires explicit approval`,
    riskLevel: "low",
    requestedAt: new Date(),
  }) as never;

// —————————————————————————————————————————————————————————————
// 审批旁路（headless broker）
// —————————————————————————————————————————————————————————————

test("headless broker allows CreateWorkflow", async () => {
  const broker = createHeadlessPermissionBroker();
  const result = await broker.requestPermission(permissionRequest("CreateWorkflow"));
  assert.equal(result.decision, "allow");
});

test("headless broker leaves every other tool at today's deny semantics", async () => {
  // 回归钉：旁路必须是按工具名的一个洞，不是一把开关。文案也钉住——它来自 core 的
  // deny broker，旁路只委托、不复写，所以这里的断言同时证明"没有第二份文案"。
  const broker = createHeadlessPermissionBroker();
  for (const toolName of ["Bash", "Write", "Edit", "Agent", "Workflow"]) {
    const result = await broker.requestPermission(permissionRequest(toolName));
    assert.equal(result.decision, "deny", `${toolName} must stay denied`);
    assert.equal(
      result.reason,
      `ZCode requested permissions to use ${toolName}, but you haven't granted it yet.`,
    );
  }
});

// —————————————————————————————————————————————————————————————
// stream-json 定型行
// —————————————————————————————————————————————————————————————

test("dwf progress events are recognised, other session events are not", () => {
  assert.equal(
    isDynamicWorkflowRunProgressEvent(progressEvent({ eventType: "run-started" })),
    true,
  );
  assert.equal(
    isDynamicWorkflowRunProgressEvent(
      progressEvent({ eventType: "run-started" }, { type: SessionEventType.AssistantMessage }),
    ),
    false,
  );
});

test("the CLI-private stream type stays out of the v3 protocol enum", () => {
  // 绊线：定型行的 type 刻意不是 zcodeSessionEventTypeSchema 的成员。那个 enum 是闭集
  // 且喂给 zcodeSessionEventSchema 的 discriminated union，加值等于让 v3 app-server 在
  // 类型面上宣告一个它永不发出的事件（协议路径在 mapSessionEventForProtocol 里就已经
  // 把这个事件剥掉了）。谁把映射搬进协议枚举，这条先红。
  assert.equal(
    zcodeSessionEventTypeSchema.options.includes(WORKFLOW_RUN_PROGRESS_STREAM_TYPE as never),
    false,
  );
});

test("the typed stream-json line carries its own type and the bounded payload verbatim", () => {
  const event = progressEvent({
    eventType: "node-settled",
    runId: "dwfrun-abc",
    sequence: 12,
    toolCallId: "call-42",
    payload: { instance: { siteId: "ask#1", ordinal: 2 }, outcome: "ok" },
    truncated: true,
  });

  const line = mapWorkflowRunProgressStreamLine(event);

  // 定型：独立 type，不是 catch-all session.updated。
  assert.equal(line.type, WORKFLOW_RUN_PROGRESS_STREAM_TYPE);
  assert.notEqual(line.type as string, "session.updated");
  // 信封与 mapSessionEvent 对齐（同样的 String()/getTime() 规范化）。
  assert.equal(line.eventId, "evt-dwf-1");
  assert.equal(line.sessionId, "session-test");
  assert.equal(line.traceId, "trace-test");
  assert.equal(line.seq, 7);
  assert.equal(line.timestamp, 1_700_000_000_000);
  // dwf 事件是出回合的，信封里没有 turnId 键（不是 undefined 值）。
  assert.equal("turnId" in line, false);
  // payload 原样：不重塑字段名，读端按 eventType 解释。
  assert.deepEqual(line.payload, {
    runId: "dwfrun-abc",
    sequence: 12,
    toolCallId: "call-42",
    eventType: "node-settled",
    payload: { instance: { siteId: "ask#1", ordinal: 2 }, outcome: "ok" },
    truncated: true,
  });
  // 一行 NDJSON 必须能独立 parse。
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(line)));
});

// —————————————————————————————————————————————————————————————
// text 模式的 stderr 进度
// —————————————————————————————————————————————————————————————

const collectProgress = (
  events: readonly SessionEvent[],
  options: { throttleMs?: number; clock?: number[] } = {},
): string[] => {
  const lines: string[] = [];
  const clock = options.clock ? [...options.clock] : undefined;
  let fallbackNow = 0;
  const reporter = createWorkflowProgressReporter({
    now: () => (clock ? (clock.shift() ?? 0) : fallbackNow++),
    ...(options.throttleMs === undefined ? {} : { throttleMs: options.throttleMs }),
    write: (line) => lines.push(line),
  });
  for (const event of events) reporter(event);
  return lines;
};

test("run lifecycle and log lines are never throttled away", () => {
  const lines = collectProgress(
    [
      progressEvent({ eventType: "run-started" }),
      progressEvent({ eventType: "log", payload: { message: "compiled" } }),
      progressEvent({ eventType: "log", payload: { message: "asking reviewer" } }),
      progressEvent({ eventType: "run-settled", payload: { status: "completed" } }),
    ],
    // 时钟不动：任何按时间的节流都会在这里吃掉后三条——这正是这条用例要挡住的退步。
    { clock: [0, 0, 0, 0] },
  );
  assert.deepEqual(lines, [
    "workflow dwfrun-abc: started\n",
    "workflow dwfrun-abc: log: compiled\n",
    "workflow dwfrun-abc: log: asking reviewer\n",
    "workflow dwfrun-abc: completed\n",
  ]);
});

test("a failed settle carries the error message", () => {
  const lines = collectProgress([
    progressEvent({
      eventType: "run-settled",
      payload: { status: "errored", error: { code: "DriverError", message: "boom" } },
    }),
  ]);
  assert.deepEqual(lines, ["workflow dwfrun-abc: errored: boom\n"]);
});

test("a stopped settle prints the stop reason next to the status", () => {
  const lines = collectProgress([
    progressEvent({
      eventType: "run-settled",
      payload: {
        status: "stopped",
        stopReason: "provider",
        error: { code: "ProviderStop", message: "sign-in expired" },
      },
    }),
  ]);
  assert.deepEqual(lines, ["workflow dwfrun-abc: stopped/provider: sign-in expired\n"]);
});

test("node phase transitions are throttled but the first one gets through", () => {
  const nodeEvent = (eventType: string, ordinal: number) =>
    progressEvent({
      eventType,
      payload: {
        instance: { siteId: "ask#1", ordinal },
        ...(eventType === "node-settled" ? { outcome: "ok" } : {}),
      },
    });
  // 节流对**所有**节点相位一视同仁，`node-settled` 也会被吃掉——刻意如此：run 的
  // 端点由 run-settled 保证（上面那条用例），节点级的完成不是必达面，否则一个
  // 100 节点的 run 在 text 模式下会刷屏。
  const lines = collectProgress(
    [
      nodeEvent("node-queued", 1),
      nodeEvent("node-dispatched", 1),
      nodeEvent("node-settled", 1),
      nodeEvent("node-queued", 2),
    ],
    { clock: [0, 100, 200, 1_000], throttleMs: 400 },
  );
  assert.deepEqual(lines, [
    "workflow dwfrun-abc: queued ask#1@1\n",
    "workflow dwfrun-abc: queued ask#1@2\n",
  ]);
});

test("counting-only and non-transition events produce no progress line", () => {
  const lines = collectProgress([
    progressEvent({ eventType: "usage-updated", payload: { spentTokens: 12 } }),
    progressEvent({
      eventType: "actor-created",
      payload: { actor: { siteId: "actor#1", ordinal: 1 } },
    }),
    progressEvent({ eventType: "compaction", payload: {} }),
    progressEvent({ eventType: "log", payload: {} }),
    progressEvent({ eventType: "run-started" }, { type: SessionEventType.AssistantMessage }),
  ]);
  assert.deepEqual(lines, []);
});

// —————————————————————————————————————————————————————————————
// 经 run() 的端到端接线（headless prompt 路径）
// —————————————————————————————————————————————————————————————

type CapturedWriteStream = NodeJS.WriteStream & { output: () => string };

const createWriteStream = (): CapturedWriteStream => {
  let output = "";
  return {
    output: () => output,
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      (typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (
  argv: string[],
): RunContext & { stderr: CapturedWriteStream; stdout: CapturedWriteStream } => ({
  argv,
  stderr: createWriteStream(),
  stdin: { isTTY: false } as NodeJS.ReadStream,
  stdout: createWriteStream(),
});

const turnEvents: readonly SessionEvent[] = [
  progressEvent({ eventType: "run-started" }, { id: "evt-1" }),
  progressEvent(
    {
      eventType: "node-settled",
      payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
    },
    { id: "evt-2", sequenceNumber: 8 },
  ),
  {
    ...progressEvent({ eventType: "run-started" }),
    id: "evt-3",
    type: SessionEventType.TurnComplete,
    payload: {},
  } as SessionEvent,
];

const createRunDeps = (): RunDependencies & { appOptions: () => unknown } => {
  let appOptions: unknown;
  return {
    appOptions: () => appOptions,
    createZCodeApp: (options?: unknown) => {
      appOptions = options;
      return {
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (
          _prompt: unknown,
          submitOptions?: { onEvent?: (event: unknown) => void | Promise<void> },
        ) => {
          for (const event of turnEvents) submitOptions?.onEvent?.(event);
          return {
            events: turnEvents,
            projection: {
              contextUsed: 12,
              contextWindow: 1000,
              status: "idle",
              totalTokenCount: 12,
              turnCount: 1,
            } as never,
            response: "the answer",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      } as never;
    },
    loadDotenv: () => ({ keys: [], loaded: false }),
    // The prompt command now starts the process Provider Registry runtime before it
    // creates the app; without this stand-in `run` exits 1 before the broker is built.
    startProcessProviderRegistryRuntime: async () =>
      ({
        dispose: () => {},
        runtime: { registryService: {} },
      }) as never,
    mapSessionEvent: ((event: { id: string; type: string }) => ({
      eventId: event.id,
      type: event.type,
    })) as never,
  } as RunDependencies & { appOptions: () => unknown };
};

test("headless app creation installs the CreateWorkflow-only broker", async () => {
  const ctx = createContext(["--workflow-mode", "alwaysOn", "--prompt", "hi"]);
  const deps = createRunDeps();
  assert.equal(await run(ctx, deps), 0);

  const broker = (deps.appOptions() as { permissionBroker?: { requestPermission: unknown } })
    .permissionBroker;
  const allowed = await (
    broker as { requestPermission: (r: unknown) => Promise<{ decision: string }> }
  ).requestPermission(permissionRequest("CreateWorkflow"));
  assert.equal(allowed.decision, "allow");
  const denied = await (
    broker as { requestPermission: (r: unknown) => Promise<{ decision: string }> }
  ).requestPermission(permissionRequest("Bash"));
  assert.equal(denied.decision, "deny");
});

test("stream-json emits the typed workflow line and still terminates with the result line", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "stream-json",
    "--prompt",
    "hi",
  ]);
  assert.equal(await run(ctx, createRunDeps()), 0);

  const lines = ctx.stdout
    .output()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload?: { eventType?: string } });

  const workflowLines = lines.filter((line) => line.type === WORKFLOW_RUN_PROGRESS_STREAM_TYPE);
  assert.equal(workflowLines.length, 2);
  assert.deepEqual(
    workflowLines.map((line) => line.payload?.eventType),
    ["run-started", "node-settled"],
  );
  // 回归钉：这两条今天漏成 catch-all session.updated。
  assert.equal(
    lines.some((line) => line.type === "session.updated"),
    false,
  );
  // 非 dwf 事件仍走 mapSessionEvent，result 行仍是流的终止符。
  assert.equal(lines.at(-2)?.type, "turn_complete");
  assert.equal(lines.at(-1)?.type, "result");
});

test("text mode prints workflow progress to stderr and keeps stdout to the answer", async () => {
  const ctx = createContext(["--workflow-mode", "alwaysOn", "--prompt", "hi"]);
  assert.equal(await run(ctx, createRunDeps()), 0);

  assert.equal(ctx.stdout.output(), "the answer\n");
  const stderr = ctx.stderr.output();
  assert.match(stderr, /^workflow dwfrun-abc: started$/m);
  assert.match(stderr, /^workflow dwfrun-abc: settled ask#1@1 \(ok\)$/m);
});

test("json mode stays exactly one object: no progress, no stderr noise", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "json",
    "--prompt",
    "hi",
  ]);
  assert.equal(await run(ctx, createRunDeps()), 0);

  assert.doesNotThrow(() => JSON.parse(ctx.stdout.output()));
  assert.equal(ctx.stderr.output().includes("workflow dwfrun-abc"), false);
});

test("stream-json does not duplicate progress onto stderr", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "stream-json",
    "--prompt",
    "hi",
  ]);
  assert.equal(await run(ctx, createRunDeps()), 0);
  assert.equal(ctx.stderr.output().includes("workflow dwfrun-abc"), false);
});

// —————————————————————————————————————————————————————————————
// 等待结算（在飞 run + 通知驱动回合）
// —————————————————————————————————————————————————————————————

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

test("the wait returns immediately when the runtime reports no work", async () => {
  let polls = 0;
  await waitForHeadlessSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => {
        polls += 1;
        return false;
      },
      hasRunningBackgroundTasks: () => false,
    },
    signal: new AbortController().signal,
    sleep: async () => assert.fail("must not sleep when there is nothing to wait for"),
  });
  assert.equal(polls, 1);
});

test("the wait polls until both busy facts clear", async () => {
  // 谓词是"或"：后台任务先清空，但通知回合还在队列里，等待必须继续。
  // 两个计数器各自独立，因为谓词短路——后台任务为真时根本不问回合工作。
  let backgroundCalls = 0;
  let turnWorkCalls = 0;
  let sleeps = 0;
  await waitForHeadlessSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => {
        turnWorkCalls += 1;
        return turnWorkCalls <= 1;
      },
      hasRunningBackgroundTasks: () => {
        backgroundCalls += 1;
        return backgroundCalls <= 2;
      },
    },
    signal: new AbortController().signal,
    sleep: async () => {
      sleeps += 1;
    },
  });
  // 2 轮等后台 + 1 轮等通知回合，第 4 轮两者都清空才退出。
  assert.equal(sleeps, 3);
  assert.equal(backgroundCalls, 4);
});

test("an already-aborted signal never enters the wait: Ctrl-C is not swallowed", async () => {
  await waitForHeadlessSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => true,
      hasRunningBackgroundTasks: () => true,
    },
    signal: abortedSignal(),
    sleep: async () => assert.fail("an aborted wait must not sleep"),
  });
});

test("aborting mid-wait breaks the loop even while the runtime stays busy", async () => {
  const controller = new AbortController();
  let sleeps = 0;
  await waitForHeadlessSettle({
    runtime: {
      hasActiveOrQueuedTurnWork: () => true,
      hasRunningBackgroundTasks: () => true,
    },
    signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
  });
  assert.equal(sleeps, 2);
});

/**
 * 一个会「起 dwf run、结算、再由通知驱动一个回合」的 app 替身。
 *
 * 关键点：`submitPrompt` 把事件**同时**扇给常驻订阅的 sink 与 `options.onEvent`——真实
 * runtime 在两者都装上时就是这个行为。于是"恰好一次"这件事在这个装配下是可证的：
 * 若 prompt-command 两个都装，每条事件就会出现两行。
 */
const createWaitingRunDeps = (
  script: {
    busyPolls: number;
    /** 第一个回合的响应文本，缺省是工作流替身的文本。 */
    firstResponse?: string;
    notificationTurns?: readonly { turnId: string; response: string }[];
    /** 第一个回合的事件，缺省带 dwf 活动。 */
    turnEvents?: readonly SessionEvent[];
  } = {
    busyPolls: 2,
  },
): RunDependencies & { pollCount: () => number } => {
  let remainingBusyPolls = script.busyPolls;
  let polls = 0;
  const sinks: ((event: SessionEvent) => void)[] = [];
  const firstTurnEvents = script.turnEvents ?? turnEvents;
  return {
    pollCount: () => polls,
    createZCodeApp: () =>
      ({
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {
          subscribeEvents: (sink: { onSessionEvent: (event: SessionEvent) => void }) => {
            sinks.push(sink.onSessionEvent);
            return () => {
              const at = sinks.indexOf(sink.onSessionEvent);
              if (at >= 0) sinks.splice(at, 1);
            };
          },
          hasRunningBackgroundTasks: () => {
            polls += 1;
            return remainingBusyPolls-- > 0;
          },
          hasActiveOrQueuedTurnWork: () => false,
        } as never,
        submitPrompt: async (
          _prompt: unknown,
          submitOptions?: { onEvent?: (event: SessionEvent) => void | Promise<void> },
        ) => {
          const emit = (event: SessionEvent) => {
            for (const sink of [...sinks]) sink(event);
            void submitOptions?.onEvent?.(event);
          };
          for (const event of firstTurnEvents) emit(event);
          // 通知驱动的回合在等待期到达：sleep(100) 之前这个 0ms timer 必然先触发。
          setTimeout(() => {
            for (const turn of script.notificationTurns ?? []) {
              emit({
                ...progressEvent({ eventType: "run-settled" }),
                id: `evt-${turn.turnId}`,
                turnId: turn.turnId as never,
                type: SessionEventType.TurnComplete,
                payload: { response: turn.response },
              } as SessionEvent);
            }
          }, 0);
          return {
            events: firstTurnEvents,
            projection: {
              contextUsed: 12,
              contextWindow: 1000,
              status: "idle",
              totalTokenCount: 12,
              turnCount: 1,
            } as never,
            response: script.firstResponse ?? "starting the workflow",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      }) as never,
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({
        dispose: () => {},
        runtime: { registryService: {} },
      }) as never,
    mapSessionEvent: ((event: { id: string; type: string }) => ({
      eventId: event.id,
      type: event.type,
    })) as never,
  } as RunDependencies & { pollCount: () => number };
};

test("text mode waits for settle and prints every turn, ending with the post-settle answer", async () => {
  const ctx = createContext(["--workflow-mode", "alwaysOn", "--prompt", "run my workflow"]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  assert.equal(await run(ctx, deps), 0);

  // 等待真的发生了（谓词被轮询过不止一次）。
  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  // 两个回合按到达序，最后一段是结算后的总结。
  assert.equal(ctx.stdout.output(), "starting the workflow\n\nthe workflow produced 42\n");
});

test("json mode reports the last turn as response and every turn in turnResponses", async () => {
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "json",
    "--prompt",
    "run my workflow",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 1,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  assert.equal(await run(ctx, deps), 0);

  const parsed = JSON.parse(ctx.stdout.output()) as {
    response: string;
    turnResponses?: string[];
  };
  assert.equal(parsed.response, "the workflow produced 42");
  assert.deepEqual(parsed.turnResponses, ["starting the workflow", "the workflow produced 42"]);
});

test("a late turn_complete for the first turn is not counted twice", async () => {
  // 首个回合的文本来自 submitPrompt 的返回值。它的 turn_complete 若在等待期才到达，
  // 必须被 turnId 挡住——否则 response 会退回第一个回合的文本。
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "json",
    "--prompt",
    "run my workflow",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 1,
    notificationTurns: [
      { turnId: "turn-notify", response: "the workflow produced 42" },
      { turnId: "turn-test", response: "starting the workflow" },
    ],
  });
  assert.equal(await run(ctx, deps), 0);

  const parsed = JSON.parse(ctx.stdout.output()) as { response: string; turnResponses?: string[] };
  assert.equal(parsed.response, "the workflow produced 42");
  assert.deepEqual(parsed.turnResponses, ["starting the workflow", "the workflow produced 42"]);
});

test("every event reaches stdout exactly once even though both sinks are offered", async () => {
  // 这条钉的是重复行：替身把每条事件同时扇给常驻 sink 与 options.onEvent。
  // prompt-command 必须二选一——两个都装的话每条事件就是两行。
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--output-format",
    "stream-json",
    "--prompt",
    "run my workflow",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 1,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  assert.equal(await run(ctx, deps), 0);

  const lines = ctx.stdout
    .output()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; eventId?: string });

  const eventIds = lines.filter((line) => line.eventId !== undefined).map((line) => line.eventId);
  assert.deepEqual(
    eventIds.length,
    new Set(eventIds).size,
    `duplicate NDJSON lines for the same event: ${eventIds.join(", ")}`,
  );
  // 通知回合的事件也在流里（常驻订阅跨回合），且 result 行仍是唯一的终止符。
  assert.equal(
    lines.some((line) => line.eventId === "evt-turn-notify"),
    true,
  );
  assert.equal(lines.filter((line) => line.type === "result").length, 1);
  assert.equal(lines.at(-1)?.type, "result");
});

test("a resolvable custom command waits for settle instead of early-returning", async () => {
  // Bug 回归钉：自定义命令解析出来是 type === "unknown"，过去因此早退进 command-center，
  // 第一个回合结束就退出进程，把在飞的 run 孤儿化成 stopped(interrupted)。现在能解析成真实
  // 自定义命令的走普通 prompt 路径，于是等待与"最后一个回合"语义都生效；提交给 app 的是
  // 原文（展开由 facade 负责）。示例命令是一个项目自定义命令（`/workflow` 已是内置保留名，见下一条）。
  const ctx = createContext([
    "--workflow-mode",
    "alwaysOn",
    "--prompt",
    "/launch-plan build me a plan",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  const loadedNames: string[] = [];
  const exitCode = await run(ctx, {
    ...deps,
    isReservedSlashCommandName: () => false,
    loadCustomCommand: async (options) => {
      loadedNames.push(options.name);
      return {
        content: "Run the dynamic workflow: $ARGUMENTS.",
        metadata: {
          description: "Start a dynamic workflow",
          name: "launch-plan",
          path: "/workspace/.zcode/commands/launch-plan.md",
          scope: "project",
          source: "zcode",
        },
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(loadedNames, ["launch-plan"]);
  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  assert.equal(ctx.stdout.output(), "starting the workflow\n\nthe workflow produced 42\n");
});

test("the builtin /workflow command rides the plain prompt path without a custom command lookup", async () => {
  // `/workflow` 现在是 CLI 内置 prompt 命令（bootstrap/src/builtin-workflow-command.ts）：
  // 解析成 known 且不是 expert/goal，直接进普通 prompt 路径，不再探测自定义命令；原文交给
  // facade 展开。dwf 结算等待与"最后一个回合"语义与自定义命令一致。独立 CLI 缺省 disabled
  // （launch.md「The standalone CLI: `--workflow-mode`」），所以这里显式开启。
  const ctx = createContext([
    "--prompt",
    "/workflow build me a plan",
    "--workflow-mode",
    "alwaysOn",
  ]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    notificationTurns: [{ turnId: "turn-notify", response: "the workflow produced 42" }],
  });
  const loadedNames: string[] = [];
  const exitCode = await run(ctx, {
    ...deps,
    loadCustomCommand: async (options) => {
      loadedNames.push(options.name);
      throw new Error(`Custom command not found: ${options.name}`);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(loadedNames, []);
  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  assert.equal(ctx.stdout.output(), "starting the workflow\n\nthe workflow produced 42\n");
});

// 修复回归：等待原来只在观察到 dwf 活动后才开始。Agent 总在后台运行后，模型派出子代理、
// 第一个回合结束时进程就退出，子代理还没做完，benchmark 的校验随即开始。
test("a run waits for a background subagent although no workflow ran", async () => {
  const ctx = createContext(["--output-format", "json", "--prompt", "delegate the review"]);
  const deps = createWaitingRunDeps({
    busyPolls: 2,
    firstResponse: "I started a reviewer agent",
    notificationTurns: [{ turnId: "turn-notify", response: "the reviewer found 3 issues" }],
    turnEvents: [],
  });
  assert.equal(await run(ctx, deps), 0);

  assert.ok(deps.pollCount() >= 3, `expected repeated polling, got ${deps.pollCount()}`);
  const parsed = JSON.parse(ctx.stdout.output()) as { response: string; turnResponses?: string[] };
  assert.equal(parsed.response, "the reviewer found 3 issues");
  assert.deepEqual(parsed.turnResponses, [
    "I started a reviewer agent",
    "the reviewer found 3 issues",
  ]);
});

test("a run with no background work checks the runtime once and keeps its output", async () => {
  const ctx = createContext(["--prompt", "hi"]);
  const deps = createWaitingRunDeps({ busyPolls: 0, firstResponse: "the answer", turnEvents: [] });

  assert.equal(await run(ctx, deps), 0);
  assert.equal(ctx.stdout.output(), "the answer\n");
  assert.equal(deps.pollCount(), 1);
});

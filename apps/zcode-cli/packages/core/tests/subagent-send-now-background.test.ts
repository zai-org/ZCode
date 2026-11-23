import { describe, expect, it, onTestFinished } from "vitest";
import {
  CoreErrorType,
  InMemorySessionEventStore,
  SessionEventType,
  createInputPreemptionAbortReason,
  createModelId,
  createModelProviderId,
  createSessionId,
  createTurnId,
  isInputPreemptionAbortReason,
  type InputPreemptionControl,
  type InputPreemptionHandling,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
} from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import {
  InMemoryRuntimeTaskRegistry,
  isTerminalRuntimeTask,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import {
  ToolDeadline,
  createInputPreemptionSlot,
  executeWithTimeout,
} from "../src/tool/executor/timeout.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";
import type { OffPeakLifecycleEvent } from "../src/runtime/off-peak/lifecycle.js";
import { USER_STOPPED_TOOL_RESULT_CONTENT } from "../src/runtime/methods/interrupt-marker.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// 立即发送抢占前台 Agent：只有前台等待中（child 运行中）才转后台，结果经 task-notification 送回；
// 启动阶段、收尾阶段（child 已出结果）、禁止后台、任务已结束和其他停止照旧取消。
// 闲时运行允许后台，同样转后台。每个用例结束都关闭它建的 port / runtime。
// 规格见 apps/zcode-cli/docs/design/v2/loop/turn-steering.md「前台子代理转后台」。

const SEND_NOW_REASON = "v4 sendQueuedNow preempts active turn";
const ASYNC_LAUNCHED_TEXT = "Async agent launched successfully";
const AGENT_CANCELLED_TEXT = "Agent was cancelled before the subagent returned findings";
const INTERRUPT_MARKER_PREFIX = "[Request interrupted by user";
const FINISHED_CHILD_RESULT = "child result finished before send-now";
const INACTIVITY_TIMEOUT_MS = 50;

describe("send-now preemption of foreground subagents", () => {
  describe("subagent runner", () => {
    it("moves a ready foreground agent to background and keeps the child running", async () => {
      const sessionId = createSessionId("send-now-background-runner");
      const turnId = createTurnId("send-now-background-runner-turn");
      const parent = new AbortController();
      const preemption = createExecutorPreemption(parent.signal);
      const childReady = createDeferred<void>();
      const childGate = createDeferred<void>();
      const notifications: Array<{ text: string }> = [];
      let childSignal: AbortSignal | undefined;
      const port = createExploreSubagentPort({
        createAgentId: () => "agent_send_now_background",
        emitParentEvent: async () => {},
        enqueueParentTaskNotification: (notification) => {
          notifications.push(notification);
        },
        runExploreAgent: async (request, options) => {
          childSignal = options?.signal;
          await request.onSessionReady?.();
          childReady.resolve();
          await childGate.promise;
          return { events: [], response: "child finished after send-now", traceId: "trace_child" };
        },
      });
      onTestFinished(async () => {
        childGate.resolve();
        await port.close?.();
      });

      const run = port.run(createRunRequest(sessionId, turnId), {
        signal: parent.signal,
        inputPreemption: preemption.control,
      });
      await childReady.promise;
      parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      // executor 先调用判断函数（转后台），runner 在同一次 abort 里读到同一个结果。
      expect(preemption.decision()).toBe("wait");

      await expect(run).resolves.toMatchObject({
        status: "async_launched",
        agentId: "agent_send_now_background",
      });
      expect(childSignal?.aborted).toBe(false);
      expect(await port.getTask?.("agent_send_now_background")).toMatchObject({
        isBackgrounded: true,
        status: "running",
      });

      childGate.resolve();
      await waitForCondition(() => notifications.length === 1);
      expect(notifications[0]?.text).toContain("<status>completed</status>");
      expect(notifications[0]?.text).toContain("<result>child finished after send-now</result>");
    });

    it("cancels as before when the caller passes no preemption control", async () => {
      const parent = new AbortController();
      const { port, childReady, childSignal } = createGatedPort("agent_without_control");

      const run = port.run(
        createRunRequest(createSessionId("no-control"), createTurnId("no-control-turn")),
        { signal: parent.signal },
      );
      await childReady.promise;
      parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));

      await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(childSignal()?.aborted).toBe(true);
      expect(await port.getTask?.("agent_without_control")).toMatchObject({
        isBackgrounded: false,
      });
    });

    it("cancels a ready foreground agent when the parent stops for another reason", async () => {
      const parent = new AbortController();
      const preemption = createExecutorPreemption(parent.signal);
      const { port, childReady, childSignal } = createGatedPort("agent_plain_stop");

      const run = port.run(
        createRunRequest(createSessionId("plain-stop"), createTurnId("plain-stop-turn")),
        { signal: parent.signal, inputPreemption: preemption.control },
      );
      await childReady.promise;
      parent.abort(new Error("v4 session stopped"));

      await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(childSignal()?.aborted).toBe(true);
    });

    it("cancels a foreground agent preempted before its child session is ready", async () => {
      const parent = new AbortController();
      const preemption = createExecutorPreemption(parent.signal);
      const childStarted = createDeferred<void>();
      let childSignal: AbortSignal | undefined;
      const port = createExploreSubagentPort({
        createAgentId: () => "agent_preempted_during_startup",
        emitParentEvent: async () => {},
        runExploreAgent: async (_request, options) => {
          childSignal = options?.signal;
          childStarted.resolve();
          // 启动阶段永不就绪：只有取消才能结束这次 Agent 调用。
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw options?.signal?.reason ?? new Error("child aborted");
        },
      });
      onTestFinished(() => port.close?.());

      const run = port.run(
        createRunRequest(createSessionId("startup-preempt"), createTurnId("startup-preempt-turn")),
        { signal: parent.signal, inputPreemption: preemption.control },
      );
      await childStarted.promise;
      parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      // 启动阶段的判断是 cancel：executor 立即判取消，不等 runner。
      expect(preemption.decision()).toBe("cancel");

      await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(childSignal?.aborted).toBe(true);
    });

    it("cancels a foreground agent whose run does not allow background", async () => {
      const parent = new AbortController();
      const preemption = createExecutorPreemption(parent.signal);
      const { port, childReady, childSignal } = createGatedPort("agent_background_denied");

      const run = port.run(
        createRunRequest(createSessionId("deny-preempt"), createTurnId("deny-preempt-turn")),
        {
          signal: parent.signal,
          modelOverride: { background: "deny" } as never,
          inputPreemption: preemption.control,
        },
      );
      await childReady.promise;
      parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));

      await expect(run).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(preemption.decision()).toBe("cancel");
      expect(childSignal()?.aborted).toBe(true);
    });

    it.each([
      { outcome: "completed", fail: false },
      { outcome: "failed", fail: true },
    ])(
      "does not claim a foreground agent whose child already $outcome",
      async ({ outcome, fail }) => {
        const parent = new AbortController();
        const preemption = createExecutorPreemption(parent.signal);
        const notifications: Array<{ text: string }> = [];
        const agentId = `agent_${outcome}_before_send_now`;
        // child 已完成或失败，runner 已写完结果文件、正要把任务改成终态：前台等待已结束，registry
        // 仍是 running，requestBackground 仍会成功，只有认领开关能拒绝。
        const registry = new BeforeTerminalRegistry(() => {
          parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
        });
        const port = createExploreSubagentPort({
          createAgentId: () => agentId,
          emitParentEvent: async () => {},
          enqueueParentTaskNotification: (notification) => {
            notifications.push(notification);
          },
          runtimeTaskRegistry: registry,
          runExploreAgent: async (request) => {
            await request.onSessionReady?.();
            if (fail) throw new Error("provider failed before send-now");
            return { events: [], response: "finished before send-now", traceId: "trace_child" };
          },
        });
        onTestFinished(() => port.close?.());

        const run = port.run(
          createRunRequest(createSessionId(`settle-${outcome}`), createTurnId(`settle-${outcome}`)),
          { signal: parent.signal, inputPreemption: preemption.control },
        );

        // executor 按 cancel 立即判取消；runner 照常在前台写完收尾，不转后台、不发通知。
        await (fail ? expect(run).rejects.toBeDefined() : expect(run).resolves.toBeDefined());
        expect(preemption.decision()).toBe("cancel");
        expect(await port.getTask?.(agentId)).toMatchObject({
          isBackgrounded: false,
          status: outcome,
        });
        expect(notifications).toHaveLength(0);
      },
    );

    it("cancels a foreground agent whose task was already stopped", async () => {
      const parent = new AbortController();
      const preemption = createExecutorPreemption(parent.signal);
      const childReady = createDeferred<void>();
      const port = createExploreSubagentPort({
        createAgentId: () => "agent_stopped_before_send_now",
        emitParentEvent: async () => {},
        enqueueParentTaskNotification: () => {},
        runExploreAgent: async (request, options) => {
          await request.onSessionReady?.();
          childReady.resolve();
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw options?.signal?.reason ?? new Error("child aborted");
        },
      });
      onTestFinished(() => port.close?.());

      const run = port.run(
        createRunRequest(createSessionId("stopped-preempt"), createTurnId("stopped-preempt-turn")),
        { signal: parent.signal, inputPreemption: preemption.control },
      );
      await childReady.promise;
      // 单项停止同步提交 killed 后，同一段代码里立即发送到达：前台等待还在，但任务已结束，不能再转后台。
      const stopping = port.stopTask?.("agent_stopped_before_send_now");
      parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      expect(preemption.decision()).toBe("cancel");
      await stopping;
      // 取消结果来自单项停止：与就绪后的单项停止相同，不是转后台。
      await expect(run).rejects.toMatchObject({
        type: CoreErrorType.ToolCancelled,
        message: "Subagent was stopped by user",
      });
      expect(await port.getTask?.("agent_stopped_before_send_now")).toMatchObject({
        isBackgrounded: false,
      });
    });

    it.each([
      {
        outcome: "completed",
        fail: false,
        expected: "<result>finished right after the move</result>",
      },
      { outcome: "failed", fail: true, expected: "failed: provider failed right after the move" },
    ])(
      "keeps the background branch when the child $outcome right after the move",
      async ({ outcome, fail, expected }) => {
        const parent = new AbortController();
        const preemption = createExecutorPreemption(parent.signal);
        const childReady = createDeferred<void>();
        const childGate = createDeferred<void>();
        const notifications: Array<{ text: string }> = [];
        const agentId = `agent_moved_then_${outcome}`;
        const registry = new CompletionFirstRegistry();
        const port = createExploreSubagentPort({
          createAgentId: () => agentId,
          emitParentEvent: async () => {},
          enqueueParentTaskNotification: (notification) => {
            notifications.push(notification);
          },
          // 模拟同一轮微任务里 child 的结果先被 race 选中：转后台请求的等待永不先返回。
          runtimeTaskRegistry: registry,
          runExploreAgent: async (request) => {
            await request.onSessionReady?.();
            childReady.resolve();
            await childGate.promise;
            if (fail) throw new Error("provider failed right after the move");
            return {
              events: [],
              response: "finished right after the move",
              traceId: "trace_child",
            };
          },
        });
        onTestFinished(async () => {
          childGate.resolve();
          await port.close?.();
        });

        const run = port.run(
          createRunRequest(createSessionId(`moved-then-${outcome}`), createTurnId("moved-turn")),
          { signal: parent.signal, inputPreemption: preemption.control },
        );
        await childReady.promise;
        parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
        expect(preemption.decision()).toBe("wait");
        childGate.resolve();

        // registry 已标为后台：完成和失败都走后台分支，结果经 task-notification 送回，不在前台返回。
        await expect(run).resolves.toMatchObject({ status: "async_launched" });
        await waitForCondition(() => notifications.length === 1);
        expect(notifications[0]?.text).toContain(`<status>${outcome}</status>`);
        expect(notifications[0]?.text).toContain(expected);
        expect(registry.get(agentId)).toMatchObject({ isBackgrounded: true, status: outcome });
      },
    );

    it("finishes a moved agent with the known error when the wait ends by inactivity timeout", async () => {
      const parent = new AbortController();
      const preemption = createExecutorPreemption(parent.signal);
      const childReady = createDeferred<void>();
      const childRelease = createDeferred<void>();
      const notifications: Array<{ text: string }> = [];
      const agentId = "agent_moved_then_timed_out";
      const registry = new CompletionFirstRegistry();
      const port = createExploreSubagentPort({
        createAgentId: () => agentId,
        emitParentEvent: async () => {},
        enqueueParentTaskNotification: (notification) => {
          notifications.push(notification);
        },
        inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
        runtimeTaskRegistry: registry,
        runExploreAgent: async (request) => {
          await request.onSessionReady?.();
          childReady.resolve();
          // child 不响应取消，用例结束前一直不返回：只有按已知错误收尾才会有通知。
          await childRelease.promise;
          throw new Error("child released after the test");
        },
      });
      onTestFinished(async () => {
        childRelease.resolve();
        await port.close?.();
      });

      const run = port.run(
        createRunRequest(createSessionId("moved-then-timed-out"), createTurnId("timed-out-turn")),
        { signal: parent.signal, inputPreemption: preemption.control },
      );
      await childReady.promise;
      parent.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      expect(preemption.decision()).toBe("wait");

      // 等待随后因闲置超时以异常结束；registry 已标为后台，按超时错误直接在后台收尾。
      await expect(run).resolves.toMatchObject({ status: "async_launched" });
      await waitForCondition(() => notifications.length === 1);
      expect(notifications[0]?.text).toContain("<status>failed</status>");
      expect(notifications[0]?.text).toContain(
        `Subagent was inactive for ${INACTIVITY_TIMEOUT_MS}ms`,
      );
      expect(registry.get(agentId)).toMatchObject({ isBackgrounded: true, status: "failed" });
    });
  });

  describe("tool executor", () => {
    const entry = {
      metadata: { name: "Agent" },
      cancellation: {
        supported: true,
        cleanup: "bestEffort",
        userVisibleMessage: "Agent was cancelled",
      },
    } as unknown as ToolEntry;

    // 与 call-runner 一致：context 上只放接管点的 register，带 decide 的接管点单独交给 executeWithTimeout。
    const createCall = (controller: AbortController, decide?: () => InputPreemptionHandling) => {
      const inputPreemption = createInputPreemptionSlot();
      if (decide) inputPreemption.register(decide);
      const context = {
        abortSignal: controller.signal,
        inputPreemption,
      } as unknown as ToolExecutionContext;
      return { context, inputPreemption };
    };

    const execute = (
      call: ReturnType<typeof createCall>,
      controller: AbortController,
      output: unknown,
    ) =>
      executeWithTimeout(
        async () => output,
        {},
        call.context,
        new ToolDeadline(undefined),
        controller,
        entry,
        call.inputPreemption,
      );

    it("waits for the handler when the registered decision is wait", async () => {
      const controller = new AbortController();
      const handlerOutput = createDeferred<unknown>();
      const result = execute(
        createCall(controller, () => "wait"),
        controller,
        handlerOutput.promise,
      );

      controller.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      handlerOutput.resolve({ status: "async_launched" });

      await expect(result).resolves.toEqual({ status: "async_launched" });
    });

    it("cancels at once when the decision is cancel, when none is registered, or for other stops", async () => {
      const declined = new AbortController();
      const declinedResult = execute(
        createCall(declined, () => "cancel"),
        declined,
        new Promise(() => {}),
      );
      declined.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      await expect(declinedResult).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });

      const unregistered = new AbortController();
      const unregisteredResult = execute(
        createCall(unregistered),
        unregistered,
        new Promise(() => {}),
      );
      unregistered.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      await expect(unregisteredResult).rejects.toMatchObject({
        type: CoreErrorType.ToolCancelled,
      });

      let decideCalls = 0;
      const plainStop = new AbortController();
      const plainResult = execute(
        createCall(plainStop, () => {
          decideCalls += 1;
          return "wait";
        }),
        plainStop,
        new Promise(() => {}),
      );
      plainStop.abort(new Error("v4 session stopped"));
      await expect(plainResult).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(decideCalls).toBe(0);
    });

    it("does not start a tool after the preemption", async () => {
      const controller = new AbortController();
      controller.abort(createInputPreemptionAbortReason(SEND_NOW_REASON));
      let started = false;
      const call = createCall(controller, () => "wait");
      const result = executeWithTimeout(
        async () => {
          started = true;
          return {};
        },
        {},
        call.context,
        new ToolDeadline(undefined),
        controller,
        entry,
        call.inputPreemption,
      );

      await expect(result).rejects.toMatchObject({ type: CoreErrorType.ToolCancelled });
      expect(started).toBe(false);
    });
  });

  describe("agent runtime", () => {
    it("send-now keeps both foreground agents running and records async launch results", async () => {
      const harness = createRuntimeHarness({ agentCount: 2 });
      const pendingTurn = harness.runtime.executeTurn("Launch two slow foreground agents.");
      await waitForCondition(() => harness.childStarts.length === 2);

      expect(
        harness.runtime.stopActiveForegroundExecution({
          preserveQueueAutoDrainOnCancel: true,
          reason: SEND_NOW_REASON,
        }),
      ).toMatchObject({ kind: "stopped" });
      await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      expect(harness.childStarts.every((start) => start.signal?.aborted === false)).toBe(true);

      await harness.runtime.executeTurn("send this now");
      const sendNowRequest = JSON.stringify(harness.parentRequests[1]);
      expect(countOccurrences(sendNowRequest, ASYNC_LAUNCHED_TEXT)).toBe(2);
      expect(sendNowRequest).not.toContain(USER_STOPPED_TOOL_RESULT_CONTENT);
      expect(sendNowRequest).not.toContain(INTERRUPT_MARKER_PREFIX);
      expect(sendNowRequest).toContain("send this now");

      harness.childGate.resolve();
      await waitForCondition(
        () =>
          harness.parentRequests.some((request) =>
            JSON.stringify(request).includes("<status>completed</status>"),
          ),
        3000,
      );
      const notificationRequest = JSON.stringify(harness.parentRequests.at(-1));
      expect(notificationRequest).toContain("<task-notification>");
      expect(notificationRequest).toContain("child result after send-now");
      // 两个 Agent 都收口后再结束：清理时关闭 runtime，不能和还在收尾的后台 Agent 同时发生。
      await waitForCondition(
        () =>
          harness.liveEvents.filter(
            (event) =>
              event.sessionId === harness.sessionId &&
              event.type === SessionEventType.SubagentStopped,
          ).length === 2,
        3000,
      );
    });

    it("send-now during a finished agent's settle cancels it as before without waiting", async () => {
      const stoppedAppending = createDeferred<void>();
      const releaseStopped = createDeferred<void>();
      const harness = createRuntimeHarness({
        agentCount: 1,
        childResult: FINISHED_CHILD_RESULT,
        childWaits: false,
        eventStore: new BlockingSubagentStoppedEventStore(stoppedAppending, releaseStopped.promise),
      });
      const pendingTurn = harness.runtime.executeTurn("Launch one fast foreground agent.");
      // child 已出结果，runner 正在写完成事件，这次写入一直卡住。
      await stoppedAppending.promise;

      harness.runtime.stopActiveForegroundExecution({
        preserveQueueAutoDrainOnCancel: true,
        reason: SEND_NOW_REASON,
      });
      // 写入还卡着，旧轮照样立即结束：收尾阶段不认领，executor 立即取消。
      await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      releaseStopped.resolve();

      await harness.runtime.executeTurn("send this now");
      const sendNowRequest = JSON.stringify(harness.parentRequests[1]);
      expect(sendNowRequest).toContain(AGENT_CANCELLED_TEXT);
      expect(sendNowRequest).not.toContain(ASYNC_LAUNCHED_TEXT);
      expect(sendNowRequest).not.toContain(FINISHED_CHILD_RESULT);
      expect(sendNowRequest).toContain("send this now");
    });

    it("a child that finishes right after the move leaves the background work finished, not running", async () => {
      let releaseChild = () => {};
      const eventStore = new ResultAfterSettleEventStore("call_send_now_agent_0", () =>
        releaseChild(),
      );
      const harness = createRuntimeHarness({ agentCount: 1, eventStore });
      releaseChild = () => harness.childGate.resolve();
      const pendingTurn = harness.runtime.executeTurn("Launch one slow foreground agent.");
      await waitForCondition(() => harness.childStarts.length === 1);

      harness.runtime.stopActiveForegroundExecution({
        preserveQueueAutoDrainOnCancel: true,
        reason: SEND_NOW_REASON,
      });
      await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      await waitForCondition(
        () =>
          harness.parentRequests.some((request) =>
            JSON.stringify(request).includes("<status>completed</status>"),
          ),
        3000,
      );

      // runner 先收口并写了 BackgroundTaskCompleted；tracker 随后不再写 BackgroundTaskStarted，
      // 后台工作的最后一条生命周期事件是完成，面板不会停在运行中。
      const lifecycle = harness.liveEvents
        .filter(
          (event) =>
            event.sessionId === harness.sessionId &&
            (event.type === SessionEventType.BackgroundTaskStarted ||
              event.type === SessionEventType.BackgroundTaskCompleted),
        )
        .map((event) => event.type);
      expect(lifecycle).toEqual([SessionEventType.BackgroundTaskCompleted]);
      const notificationRequests = harness.parentRequests.filter((request) =>
        JSON.stringify(request).includes("<task-notification>"),
      );
      expect(notificationRequests.length).toBeGreaterThan(0);
      expect(JSON.stringify(notificationRequests.at(-1))).toContain("child result after send-now");
    });

    it("manual stop still cancels the foreground agent", async () => {
      const harness = createRuntimeHarness({ agentCount: 1 });
      const pendingTurn = harness.runtime.executeTurn("Launch one slow foreground agent.");
      await waitForCondition(() => harness.childStarts.length === 1);

      harness.runtime.stopActiveForegroundExecution({ reason: "v4 session stopped" });
      await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      await waitForCondition(() => harness.childStarts[0]?.signal?.aborted === true);

      await harness.runtime.executeTurn("next prompt");
      const nextRequest = JSON.stringify(harness.parentRequests[1]);
      expect(nextRequest).toContain(USER_STOPPED_TOOL_RESULT_CONTENT);
      expect(nextRequest).not.toContain(ASYNC_LAUNCHED_TEXT);
      harness.childGate.resolve();
    });

    it("a child waiting for approval moves to background with its request kept open", async () => {
      const userAnswered = createDeferred<void>();
      const permissionSignals: Array<AbortSignal | undefined> = [];
      const harness = createRuntimeHarness({
        agentCount: 1,
        childAsksUser: true,
        permissionBroker: {
          requestPermission(request: { input: unknown }, options?: { signal?: AbortSignal }) {
            permissionSignals.push(options?.signal);
            return userAnswered.promise.then(() => ({
              decision: "modify",
              modifiedInput: {
                ...(request.input as Record<string, unknown>),
                answers: { "Which path?": "A" },
              },
              reason: "answered in parent task",
            }));
          },
        },
      });
      // 先于 harness 的清理执行：用例中途失败时也让审批返回，child 才能结束。
      onTestFinished(() => userAnswered.resolve());
      const pendingTurn = harness.runtime.executeTurn("Launch an agent that asks the user.");
      await waitForCondition(() => permissionSignals.length === 1);

      harness.runtime.stopActiveForegroundExecution({
        preserveQueueAutoDrainOnCancel: true,
        reason: SEND_NOW_REASON,
      });
      await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      expect(permissionSignals[0]?.aborted).toBe(false);

      // 用户在审批框里作答后，后台 child 继续执行并完成。
      userAnswered.resolve();
      harness.childGate.resolve();
      await waitForCondition(
        () =>
          harness.liveEvents.some(
            (event) =>
              event.sessionId === harness.sessionId &&
              event.type === SessionEventType.BackgroundTaskCompleted,
          ),
        3000,
      );
      expect(harness.childCallCount()).toBe(2);
    });

    it("send-now in an off-peak run moves the foreground agent, and the off-peak run ends after it", async () => {
      const lifecycleEvents: OffPeakLifecycleEvent[] = [];
      const registry = new InMemoryRuntimeTaskRegistry();
      const childGate = createDeferred<void>();
      const childStarts: Array<{ providerId: string; signal?: AbortSignal }> = [];
      const mainRequests: Array<{ providerId: string; messages: string }> = [];
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const runtime = createTestAgentRuntime(
        createSessionId("send-now-off-peak"),
        {
          mode: "yolo",
          modelSelection: createTestModelSelection("user/normal"),
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace/project",
          // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
          subagents: { alwaysBackground: false },
        },
        {
          runtimeTaskRegistry: registry,
          eventStore: createTestSessionEventStore(),
          onOffPeakLifecycleEvent: (event) => lifecycleEvents.push(event),
          modelFactory: createTestModelFactory({
            async generateText(request, observation) {
              const providerId = String(observation.model.providerId);
              if (observation.invocationContext?.metadata?.querySource === "subagent") {
                childStarts.push({ providerId, signal: request.abortSignal });
                await childGate.promise;
                return { text: "off-peak child result", finishReason: "stop", usage };
              }
              mainRequests.push({ providerId, messages: JSON.stringify(request.messages) });
              if (mainRequests.length > 1)
                return { text: "parent reply", finishReason: "stop", usage };
              return {
                text: "",
                finishReason: "tool-calls",
                usage,
                toolCalls: [
                  {
                    id: "call_off_peak_agent",
                    name: "Agent",
                    input: {
                      description: "Off-peak child",
                      prompt: "Work slowly.",
                      subagent_type: "general-purpose",
                    },
                  },
                ],
              };
            },
          }),
        },
      );
      onTestFinished(async () => {
        childGate.resolve();
        await runtime.close();
      });

      const offPeakTurn = runtime.executeTurn("idle work", undefined, {
        offPeakTaskId: "idle-task",
        intent: {
          sourceCommandId: "idle-input",
          kind: "sendText",
          modelSelection: createTestModelSelection("idle/model"),
        } as never,
        modelExecution: {
          selectionScope: "execution",
          offPeak: { executionId: "off-peak-run", ticketId: "one", providerErrorCode: "3102" },
          requestDependencies: {
            requestAuth: { source: { resolve: async () => ({ headers: { ticket: "one" } }) } },
          },
        },
      });
      await waitForCondition(() => childStarts.length === 1);

      runtime.stopActiveForegroundExecution({
        preserveQueueAutoDrainOnCancel: true,
        reason: SEND_NOW_REASON,
      });
      await expect(offPeakTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      // 闲时运行允许后台：Agent 转后台，child 继续用闲时模型运行，算作这次闲时运行的后台工作。
      expect(childStarts[0]?.providerId).toBe("idle");
      expect(childStarts[0]?.signal?.aborted).toBe(false);
      expect(Object.values(registry.all())).toEqual([
        expect.objectContaining({
          isBackgrounded: true,
          offPeakExecutionId: "off-peak-run",
          status: "running",
        }),
      ]);

      // 立即发送的消息由用户接管，改用用户模型；child 还在运行，闲时运行不结束。
      await runtime.executeTurn("send this now", undefined, {
        intent: {
          sourceCommandId: "user-input",
          kind: "sendText",
          admissionSeq: 2,
          modelSelection: createTestModelSelection("paid/new"),
        } as never,
      });
      expect(mainRequests[1]?.providerId).toBe("paid");
      expect(mainRequests[1]?.messages).toContain(ASYNC_LAUNCHED_TEXT);
      expect(lifecycleEvents.some((event) => event.type === "completed")).toBe(false);

      // child 跑完：结果经 task-notification 回到父模型，闲时运行随后只结束一次。
      childGate.resolve();
      await waitForCondition(
        () => lifecycleEvents.some((event) => event.type === "completed"),
        3000,
      );
      expect(lifecycleEvents.filter((event) => event.type === "completed")).toHaveLength(1);
      expect(
        mainRequests.some(
          (request) =>
            request.messages.includes("<task-notification>") &&
            request.messages.includes("off-peak child result"),
        ),
      ).toBe(true);
    });
  });

  it("marks only send-now stops with the input preemption reason", () => {
    const reason = createInputPreemptionAbortReason(SEND_NOW_REASON);
    expect(reason).toBeInstanceOf(Error);
    expect(reason.message).toBe(SEND_NOW_REASON);
    expect(isInputPreemptionAbortReason(reason)).toBe(true);
    expect(isInputPreemptionAbortReason(new Error(SEND_NOW_REASON))).toBe(false);
    expect(isInputPreemptionAbortReason({ kind: "input_preemption" })).toBe(false);
    expect(isInputPreemptionAbortReason(undefined)).toBe(false);
  });
});

/** 转后台请求的等待永不先返回，让 race 只能选中 child 的结果。 */
class CompletionFirstRegistry extends InMemoryRuntimeTaskRegistry {
  override waitForBackgroundRequest(): Promise<RuntimeTaskSnapshot | undefined> {
    return new Promise(() => {});
  }
}

/** 任务第一次要变为终态时，先调用 beforeTerminal 再写入：用来停在 runner 收尾、registry 仍是 running 的窗口。 */
class BeforeTerminalRegistry extends InMemoryRuntimeTaskRegistry {
  constructor(private beforeTerminal: (() => void) | undefined) {
    super();
  }

  override update(
    id: string,
    updater: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.get(id);
    if (current && !isTerminalRuntimeTask(current) && isTerminalRuntimeTask(updater(current))) {
      const beforeTerminal = this.beforeTerminal;
      this.beforeTerminal = undefined;
      beforeTerminal?.();
    }
    // 回调可能已改动任务（例如标为后台），按写入时的最新值重新计算。
    return super.update(id, updater);
  }
}

/**
 * 父会话 Agent 的 ToolCallResult 写入要等 runner 写完 BackgroundTaskCompleted 才返回：复现转后台与
 * child 结束几乎同时发生时，executor 的 tracker 晚于 runner 收口。
 */
class ResultAfterSettleEventStore extends InMemorySessionEventStore {
  private readonly settled = createDeferred<void>();

  constructor(
    private readonly toolCallId: string,
    private readonly onResultAppended: () => void,
  ) {
    super({ retention: "unbounded" });
  }

  override async append(event: SessionEvent): Promise<SessionEvent> {
    const stored = await super.append(event);
    if (event.type === SessionEventType.BackgroundTaskCompleted) this.settled.resolve();
    if (
      event.type === SessionEventType.ToolCallResult &&
      (event.payload as { toolCallId?: string }).toolCallId === this.toolCallId
    ) {
      this.onResultAppended();
      await this.settled.promise;
    }
    return stored;
  }
}

/** 父会话的 SubagentStopped 写入卡住，直到测试放行；用来停在 runner 收尾阶段。 */
class BlockingSubagentStoppedEventStore extends InMemorySessionEventStore {
  constructor(
    private readonly appending: { resolve: (value: void) => void },
    private readonly release: Promise<void>,
  ) {
    super({ retention: "unbounded" });
  }

  override async append(event: SessionEvent): Promise<SessionEvent> {
    if (event.type === SessionEventType.SubagentStopped) {
      this.appending.resolve();
      await this.release;
    }
    return super.append(event);
  }
}

/**
 * 按生产顺序模拟 executor：用生产的接管点，并在 runner 之前挂上父 signal 的 abort 监听
 * （executeWithTimeout 先于 handler 注册监听），立即发送到达时先由它调用判断函数，记录结果。
 */
function createExecutorPreemption(parent: AbortSignal): {
  control: InputPreemptionControl;
  decision: () => InputPreemptionHandling | undefined;
} {
  const slot = createInputPreemptionSlot();
  let decision: InputPreemptionHandling | undefined;
  parent.addEventListener(
    "abort",
    () => {
      if (isInputPreemptionAbortReason(parent.reason)) decision = slot.decide();
    },
    { once: true },
  );
  return { control: slot, decision: () => decision };
}

let harnessIndex = 0;

interface RuntimeHarnessOptions {
  agentCount: number;
  childAsksUser?: boolean;
  /** child 的最终回复；缺省为短文本。 */
  childResult?: string;
  /** child 回复前是否等 childGate；缺省等待。 */
  childWaits?: boolean;
  eventStore?: SessionEventStorePort;
  permissionBroker?: unknown;
}

function createRuntimeHarness(options: RuntimeHarnessOptions) {
  harnessIndex += 1;
  const sessionId: SessionId = createSessionId(`send-now-agent-runtime-${harnessIndex}`);
  const childGate = createDeferred<void>();
  const childStarts: Array<{ signal?: AbortSignal }> = [];
  const parentRequests: unknown[] = [];
  const liveEvents: SessionEvent[] = [];
  const childCalls = new Map<string, number>();

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
      eventStore: options.eventStore ?? createTestSessionEventStore(),
      ...(options.permissionBroker ? { permissionBroker: options.permissionBroker as never } : {}),
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentRequests.push(structuredClone(request.messages));
            if (parentRequests.length === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: Array.from({ length: options.agentCount }, (_, index) => ({
                  id: `call_send_now_agent_${index}`,
                  name: "Agent",
                  input: {
                    description: `Slow child ${index}`,
                    prompt: `CHILD_${index}: work slowly.`,
                    subagent_type: "general-purpose",
                  },
                })),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `parent reply ${parentRequests.length}`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }

          const childKey = JSON.stringify(request.messages).match(/CHILD_\d+/)?.[0] ?? "CHILD";
          const call = (childCalls.get(childKey) ?? 0) + 1;
          childCalls.set(childKey, call);
          if (call === 1) {
            childStarts.push({ signal: request.abortSignal });
            if (options.childAsksUser) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: `call_child_ask_${childKey}`,
                    name: "AskUserQuestion",
                    input: {
                      questions: [
                        {
                          header: "Path",
                          multiSelect: false,
                          options: [
                            { description: "Use path A", label: "A" },
                            { description: "Use path B", label: "B" },
                          ],
                          question: "Which path?",
                        },
                      ],
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
          }
          if (options.childWaits !== false) await childGate.promise;
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: options.childResult ?? "child result after send-now",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );
  runtime.subscribeEvents({
    onSessionEvent: (event) => {
      liveEvents.push(event);
    },
  });
  onTestFinished(async () => {
    childGate.resolve();
    await runtime.close();
  });
  const childCallCount = () =>
    Array.from(childCalls.values()).reduce((total, count) => total + count, 0);
  return { runtime, sessionId, childGate, childStarts, childCallCount, parentRequests, liveEvents };
}

function createGatedPort(agentId: string) {
  const childReady = createDeferred<void>();
  let signal: AbortSignal | undefined;
  const port = createExploreSubagentPort({
    createAgentId: () => agentId,
    emitParentEvent: async () => {},
    runExploreAgent: async (request, options) => {
      signal = options?.signal;
      await request.onSessionReady?.();
      childReady.resolve();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal?.reason ?? new Error("child aborted");
    },
  });
  onTestFinished(() => port.close?.());
  return { port, childReady, childSignal: () => signal };
}

function createRunRequest(sessionId: SessionId, turnId: ReturnType<typeof createTurnId>) {
  return {
    agentType: "general-purpose",
    description: "Send-now background test",
    parentToolCallId: "call_send_now_background",
    prompt: "Run slowly",
    sessionId,
    trace: {
      traceId: "trace_send_now_background_parent",
      spanId: "span_send_now_background_parent",
      sessionId,
      turnId,
    },
    turnId,
    workingDirectory: "/tmp/zcode-subagent-send-now-background",
    workspaceRoot: "/tmp/zcode-subagent-send-now-background",
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

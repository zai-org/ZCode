// PermissionRequest hook 与交互 broker 的并发竞速（spec：docs/design/v2/permission-responder-race.md）。
//
// Bug 根因（2026-08-26 实机事故）：旧路径在 emitPermissionRequested 之后**串行** await
// PermissionRequest hook 链，broker 的应答通道要等 hook 返回才建立。同步 hook（外部审批
// 桥接）阻塞期间，确认窗已可见但用户点击全部被 resolveInteraction 按幂等语义静默丢弃，
// 确认窗永久死亡。本文件钉住新契约：通道先建立、双方竞速、先到者胜、败者被 abort。
import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  SessionEventType,
  type PermissionBrokerPort,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { racePermissionResponders } from "../src/tool/executor/permission-responder-race.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { HookRunResult } from "../src/hooks/index.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const EMPTY_HOOK_RESULT: HookRunResult = { additionalContexts: [] };

describe("racePermissionResponders (unit)", () => {
  it("broker claim 在提交期间排除迟到 Hook，Hook 已胜出则不能再 claim", async () => {
    const broker = createDeferred<PermissionBrokerResult>();
    const hook = createDeferred<PermissionBrokerResult>();
    let claim!: () => boolean;
    const outcome = racePermissionResponders({
      requestBroker: (_signal, claimResponse) => {
        claim = claimResponse;
        return broker.promise;
      },
      runHooks: () => hook.promise,
    });
    expect(claim()).toBe(true);
    hook.resolve({ decision: "deny" });
    await Promise.resolve();
    broker.resolve({ decision: "allow" });
    expect((await outcome).source).toBe("broker");
    expect(claim()).toBe(false);
    const next = racePermissionResponders({
      requestBroker: (_signal, claimResponse) => {
        claim = claimResponse;
        return new Promise(() => {});
      },
      runHooks: async () => ({ decision: "deny" }),
    });
    expect((await next).source).toBe("hook");
    expect(claim()).toBe(false);
  });

  it("resolves with the broker answer while hooks never settle, and aborts the hook side", async () => {
    let hookSignal: AbortSignal | undefined;
    const outcome = await racePermissionResponders({
      runHooks: (signal) => {
        hookSignal = signal;
        return new Promise(() => {});
      },
      requestBroker: async () => ({ decision: "allow", reason: "clicked in app" }),
    });
    expect(outcome).toEqual({
      result: { decision: "allow", reason: "clicked in app" },
      source: "broker",
    });
    expect(hookSignal?.aborted).toBe(true);
  });

  it("resolves with the hook decision while the broker never settles, and aborts the broker side", async () => {
    let brokerSignal: AbortSignal | undefined;
    const outcome = await racePermissionResponders({
      runHooks: async () => ({ decision: "deny", reason: "denied by hook" }),
      requestBroker: (signal) => {
        brokerSignal = signal;
        return new Promise(() => {});
      },
    });
    expect(outcome).toEqual({
      result: { decision: "deny", reason: "denied by hook" },
      source: "hook",
    });
    expect(brokerSignal?.aborted).toBe(true);
  });

  it("keeps waiting for the broker when hooks resolve without a decision", async () => {
    const broker = createDeferred<PermissionBrokerResult>();
    const outcomePromise = racePermissionResponders({
      runHooks: async () => undefined,
      requestBroker: () => broker.promise,
    });
    // hook 已退赛；broker 应答仍然收口整个竞速。
    broker.resolve({ decision: "allow", reason: "late click" });
    await expect(outcomePromise).resolves.toEqual({
      result: { decision: "allow", reason: "late click" },
      source: "broker",
    });
  });

  it("treats a hook chain failure as forfeiting the race instead of denying", async () => {
    const onHookFailure = vi.fn();
    const broker = createDeferred<PermissionBrokerResult>();
    const outcomePromise = racePermissionResponders({
      runHooks: async () => {
        throw new Error("hook infrastructure exploded");
      },
      requestBroker: () => broker.promise,
      onHookFailure,
    });
    await vi.waitFor(() => expect(onHookFailure).toHaveBeenCalledTimes(1));
    broker.resolve({ decision: "allow", reason: "user still decides" });
    await expect(outcomePromise).resolves.toEqual({
      result: { decision: "allow", reason: "user still decides" },
      source: "broker",
    });
  });

  it("propagates a broker rejection when no hook decision arrived, and aborts hooks", async () => {
    let hookSignal: AbortSignal | undefined;
    await expect(
      racePermissionResponders({
        runHooks: (signal) => {
          hookSignal = signal;
          return new Promise(() => {});
        },
        requestBroker: async () => {
          throw new Error("No permission client configured");
        },
      }),
    ).rejects.toThrow("No permission client configured");
    expect(hookSignal?.aborted).toBe(true);
  });

  it("swallows the broker rejection caused by our own abort after a hook win", async () => {
    const outcome = await racePermissionResponders({
      runHooks: async () => ({ decision: "allow", reason: "hook won" }),
      requestBroker: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    expect(outcome.source).toBe("hook");
  });

  it("settles exactly once when both sides decide in the same tick", async () => {
    const outcome = await racePermissionResponders({
      runHooks: async () => ({ decision: "deny", reason: "hook same tick" }),
      requestBroker: async () => ({ decision: "allow", reason: "broker same tick" }),
    });
    // 闩是先到先得：两个同 tick microtask 中启动顺序在前的 broker 先兑现。
    // 断言的是「恰好一个胜者」而不是具体是谁——避免测试锁死调度实现细节。
    expect(["hook", "broker"]).toContain(outcome.source);
    expect(outcome.result.reason).toBe(
      outcome.source === "hook" ? "hook same tick" : "broker same tick",
    );
  });

  it("aborts both sides when the outer signal fires and propagates the broker rejection", async () => {
    const outer = new AbortController();
    let hookSignal: AbortSignal | undefined;
    const racePromise = racePermissionResponders({
      runHooks: (signal) => {
        hookSignal = signal;
        return new Promise(() => {});
      },
      requestBroker: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled by turn")), {
            once: true,
          });
        }),
      signal: outer.signal,
    });
    outer.abort();
    await expect(racePromise).rejects.toThrow("cancelled by turn");
    expect(hookSignal?.aborted).toBe(true);
  });
});

describe("permission responder race (executor integration)", () => {
  function createApprovalExecutorHarness(options: {
    hookRun: (input: unknown, runOptions?: { signal?: AbortSignal }) => Promise<HookRunResult>;
    broker?: PermissionBrokerPort;
  }) {
    // 提供的 hookRun 只作用于 PermissionRequest 事件；PreToolUse / PostToolUse 等
    // 其余事件返回空结果，避免把与竞速无关的阶段也挂起。
    const scopedHookRun = (
      input: unknown,
      runOptions?: { signal?: AbortSignal },
    ): Promise<HookRunResult> => {
      const eventName = (input as { hookEventName?: string }).hookEventName;
      if (eventName !== "PermissionRequest") return Promise.resolve(EMPTY_HOOK_RESULT);
      return options.hookRun(input, runOptions);
    };
    const sessionId = createSessionId("perm-race");
    const turnId = createTurnId("perm-race-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const registry = createToolRegistry();
    const handled: unknown[] = [];
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: false,
        destructive: false,
        name: "WriteLike",
        needsApproval: true,
        readOnly: false,
        riskLevel: "medium",
        sideEffectScope: "workspace",
      },
      handler: async (input) => {
        handled.push(input);
        return "write-ok";
      },
    });
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      hookRunner: { run: scopedHookRun },
      mode: "build",
      ...(options.broker ? { permissionBroker: options.broker } : {}),
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });
    const execute = () =>
      executor.execute(
        { id: createToolCallId("race-call"), input: { file_path: "demo.txt" }, name: "WriteLike" },
        { traceContext },
      );
    return { events, execute, handled };
  }

  it("arms the broker while a PermissionRequest hook is still running (incident regression)", async () => {
    // 事故场景：hook 永不返回。用户在确认窗上的点击（broker 应答）必须照常生效。
    let hookStarted = false;
    let hookSignal: AbortSignal | undefined;
    const brokerCalled = createDeferred<void>();
    const brokerAnswer = createDeferred<PermissionBrokerResult>();
    const harness = createApprovalExecutorHarness({
      hookRun: (input, runOptions) => {
        void input;
        hookStarted = true;
        hookSignal = runOptions?.signal;
        return new Promise(() => {});
      },
      broker: {
        requestPermission: () => {
          brokerCalled.resolve();
          return brokerAnswer.promise;
        },
      },
    });

    const resultPromise = harness.execute();
    // 旧路径在 hook 返回前根本不会调用 broker——这一步就是回归断言本身。
    await brokerCalled.promise;
    expect(hookStarted).toBe(true);
    brokerAnswer.resolve({ decision: "allow", reason: "user clicked Start" });

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.output).toBe("write-ok");
    expect(hookSignal?.aborted).toBe(true);
    expect(harness.events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
    expect((harness.events[1]?.payload as { decision?: string }).decision).toBe("allow");
  });

  it("lets a hook deny win the race and aborts the broker wait", async () => {
    let brokerSignal: AbortSignal | undefined;
    const harness = createApprovalExecutorHarness({
      hookRun: async () => ({
        additionalContexts: [],
        permissionRequestResult: { behavior: "deny", message: "denied by external UI" },
      }),
      broker: {
        requestPermission: (_request, requestOptions) =>
          new Promise((_, reject) => {
            brokerSignal = requestOptions?.signal ?? undefined;
            requestOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      },
    });

    const result = await harness.execute();
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("permission_denied");
    expect(result.error?.message).toContain("denied by external UI");
    expect(brokerSignal?.aborted).toBe(true);
    expect(harness.events.map((event) => event.type)).toEqual([
      SessionEventType.PermissionRequested,
      SessionEventType.PermissionResolved,
    ]);
    expect((harness.events[1]?.payload as { decision?: string }).decision).toBe("deny");
  });

  it("lets a hook allow win the race and executes the tool", async () => {
    const harness = createApprovalExecutorHarness({
      hookRun: async () => ({
        additionalContexts: [],
        permissionRequestResult: { behavior: "allow" },
      }),
      broker: {
        requestPermission: (_request, requestOptions) =>
          new Promise((_, reject) => {
            requestOptions?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      },
    });
    const result = await harness.execute();
    expect(result.success).toBe(true);
    expect(result.output).toBe("write-ok");
  });

  it("applies a hook modify decision to the execution input", async () => {
    const harness = createApprovalExecutorHarness({
      hookRun: async () => ({
        additionalContexts: [],
        permissionRequestResult: {
          behavior: "allow",
          updatedInput: { file_path: "redirected.txt" },
        },
      }),
      broker: {
        requestPermission: () => new Promise(() => {}),
      },
    });
    const result = await harness.execute();
    expect(result.success).toBe(true);
    expect(harness.handled).toEqual([{ file_path: "redirected.txt" }]);
  });

  it("falls back to the broker when hooks resolve without a decision", async () => {
    const harness = createApprovalExecutorHarness({
      hookRun: async () => EMPTY_HOOK_RESULT,
      broker: {
        requestPermission: async () => ({ decision: "allow", reason: "broker decided" }),
      },
    });
    const result = await harness.execute();
    expect(result.success).toBe(true);
    expect(result.output).toBe("write-ok");
  });

  it("still resolves via the broker when the hook chain throws", async () => {
    const harness = createApprovalExecutorHarness({
      hookRun: async () => {
        throw new Error("event pipeline wedged");
      },
      broker: {
        requestPermission: async () => ({ decision: "allow", reason: "user decided anyway" }),
      },
    });
    const result = await harness.execute();
    expect(result.success).toBe(true);
    expect(result.output).toBe("write-ok");
  });

  it("fails closed immediately without a broker even while a hook hangs", async () => {
    let hookSignal: AbortSignal | undefined;
    const harness = createApprovalExecutorHarness({
      hookRun: (_input, runOptions) => {
        hookSignal = runOptions?.signal;
        return new Promise(() => {});
      },
    });
    const result = await harness.execute();
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe("permission_denied");
    expect(result.error?.message).toBe(
      "ZCode requested permissions to use WriteLike, but you haven't granted it yet.",
    );
    expect(hookSignal?.aborted).toBe(true);
  });
});

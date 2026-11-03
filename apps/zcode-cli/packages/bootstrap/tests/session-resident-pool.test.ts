// Session 常驻池验收网（spec: apps/zcode-cli/docs/design/v2/session-idle-deactivation.md）：
// 单个 app-server 以 idle TTL 主动回收长期空闲 runtime，并用 high/low water LRU
// 限制突发 resident 数量；运行、后台 work、订阅和协议操作必须优先保活。
//
// 三层覆盖：
// - pool 单元（fake host）：TTL、high/low water LRU、保护条件、operation lease、
//   fresh facts 二次校验、waitForDeactivation 闸门和失败隔离。
// - 执行面单元（stub context）：内存摘除在同一同步片完成（unsubscribe → gateway 去激活 →
//   sessions.delete），app.close 后置异步；重复调用幂等。
// - 集成（真 sqlite + ZCodeProtocolAgentServer + binder）：subscribe → unsubscribe →
//   容量 rebalance 去激活 → sessions-index 订阅者收不到 session.removed → 再订阅冷恢复出完整
//   snapshot；再激活闸门在 app.close 收尾完成前挂住并发 subscribe。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProtocolBrowserControlBroker } from "../src/zcode-protocol/browser-control-broker.js";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type {
  MessageId,
  MessagePart,
  ModelId,
  ModelProviderId,
  ProjectId,
  SessionId,
  WorkspaceId,
} from "@zcode/contracts";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import {
  V4_METHODS,
  conversationTopic,
  conversationTopicFrameSchema,
  sessionsIndexTopic,
  routedTopicWireFrameSchema,
  sessionsIndexTopicFrameSchema,
  v4ConversationSubscribeResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  V4_NOTIFICATIONS,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SessionResidentPool,
  type SessionDeactivationDecision,
  type SessionResidencyFacts,
  type SessionResidentPoolOptions,
  type SessionResidentPoolHost,
} from "../src/zcode-protocol/session-resident-pool.js";
import {
  acquireSessionResidencyFinalization,
  deactivateSessionRecord,
  getSessionLifecycle,
  runWithSessionResidencyFinalization,
} from "../src/zcode-protocol/session-residency.js";
import type {
  ZCodeProtocolAgentDependencies,
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { ZCodeApp } from "../src/app/types.js";

// ── 常驻池单元（fake host）──────────────────────────────────────────────────

function idleFacts(overrides: Partial<SessionResidencyFacts> = {}): SessionResidencyFacts {
  return {
    hasPendingInteractions: false,
    hasQueuedCommands: false,
    hasLegacySubscriber: false,
    hasResidencyBlockingWork: false,
    hasSubscribers: false,
    lastActivityAt: 0,
    persisted: true,
    ...overrides,
  };
}

interface FakeHost {
  host: SessionResidentPoolHost;
  sessions: Map<string, SessionResidencyFacts>;
  deactivated: Array<{ sessionId: string; decision: SessionDeactivationDecision }>;
  errors: Array<{
    sessionId: string;
    error: unknown;
    decision: SessionDeactivationDecision;
  }>;
  setDeactivateImpl(impl: (sessionId: string) => Promise<void>): void;
  setReadImpl(impl: (sessionId: string) => SessionResidencyFacts | null): void;
}

function makeFakeHost(): FakeHost {
  const sessions = new Map<string, SessionResidencyFacts>();
  const deactivated: Array<{
    sessionId: string;
    decision: SessionDeactivationDecision;
  }> = [];
  const errors: Array<{
    sessionId: string;
    error: unknown;
    decision: SessionDeactivationDecision;
  }> = [];
  let deactivateImpl = async (sessionId: string): Promise<void> => {
    sessions.delete(sessionId);
  };
  let readImpl = (sessionId: string) => sessions.get(sessionId) ?? null;
  return {
    host: {
      deactivate: (sessionId) => deactivateImpl(sessionId),
      listSessionIds: () => [...sessions.keys()],
      onDeactivated: (sessionId, decision) => deactivated.push({ sessionId, decision }),
      onError: (sessionId, error, decision) => errors.push({ sessionId, error, decision }),
      readResidencyFacts: (sessionId) => readImpl(sessionId),
    },
    sessions,
    deactivated,
    errors,
    setDeactivateImpl: (impl) => {
      deactivateImpl = impl;
    },
    setReadImpl: (impl) => {
      readImpl = impl;
    },
  };
}

interface TestClock {
  advance(ms: number): void;
  now(): number;
}

function createTestClock(initialNow = 0): TestClock {
  let current = initialNow;
  return {
    advance(ms) {
      current += ms;
    },
    now: () => current,
  };
}

function makePool(fake: FakeHost, options: SessionResidentPoolOptions = {}): SessionResidentPool {
  return new SessionResidentPool(fake.host, options);
}

function sessionIds(entries: Array<{ sessionId: string }>): string[] {
  return entries.map((entry) => entry.sessionId);
}

async function waitForAll(pool: SessionResidentPool, sessionIds: string[]): Promise<void> {
  await Promise.all(sessionIds.map((sessionId) => pool.waitForDeactivation(sessionId)));
}

describe("SessionResidentPool", () => {
  it.each([
    [{ targetCount: -1 }, "targetCount"],
    [{ targetCount: 3, highWaterCount: 2 }, "highWaterCount"],
    [{ idleTimeoutMs: -1 }, "idleTimeoutMs"],
  ] as const)("拒绝非法混合策略参数：%o", (options, expectedField) => {
    const fake = makeFakeHost();
    expect(() => makePool(fake, options)).toThrow(expectedField);
  });

  it("eligible 首次出现只开始 TTL，超时后即使低于 target 也回收", async () => {
    const fake = makeFakeHost();
    const clock = createTestClock(1_000);
    fake.sessions.set("sess-idle", idleFacts());
    const pool = makePool(fake, {
      highWaterCount: 16,
      idleTimeoutMs: 100,
      now: clock.now,
      targetCount: 8,
    });

    pool.rebalance();
    clock.advance(99);
    pool.rebalance();
    expect(fake.sessions.has("sess-idle")).toBe(true);

    clock.advance(1);
    pool.rebalance();
    await pool.waitForDeactivation("sess-idle");

    expect(sessionIds(fake.deactivated)).toEqual(["sess-idle"]);
    expect(fake.deactivated[0]?.decision).toMatchObject({
      idleMs: 100,
      reason: "idle_timeout",
    });
  });

  it("touch 会重置 idle TTL", async () => {
    const fake = makeFakeHost();
    const clock = createTestClock();
    fake.sessions.set("sess-idle", idleFacts());
    const pool = makePool(fake, {
      highWaterCount: 16,
      idleTimeoutMs: 100,
      now: clock.now,
      targetCount: 8,
    });

    pool.rebalance();
    clock.advance(90);
    pool.touch("sess-idle");
    pool.rebalance();
    clock.advance(99);
    pool.rebalance();
    expect(fake.sessions.has("sess-idle")).toBe(true);

    clock.advance(1);
    pool.rebalance();
    await pool.waitForDeactivation("sess-idle");
    expect(sessionIds(fake.deactivated)).toEqual(["sess-idle"]);
  });

  it("保护事实会清除旧 TTL，保护解除后从新的 eligible 时刻计时", async () => {
    const fake = makeFakeHost();
    const clock = createTestClock();
    fake.sessions.set("sess-background", idleFacts());
    const pool = makePool(fake, {
      highWaterCount: 16,
      idleTimeoutMs: 100,
      now: clock.now,
      targetCount: 8,
    });

    pool.rebalance();
    clock.advance(90);
    fake.sessions.set("sess-background", idleFacts({ hasResidencyBlockingWork: true }));
    pool.rebalance();
    clock.advance(100);
    fake.sessions.set("sess-background", idleFacts());
    pool.rebalance();
    expect(fake.sessions.has("sess-background")).toBe(true);

    clock.advance(99);
    pool.rebalance();
    expect(fake.sessions.has("sess-background")).toBe(true);
    clock.advance(1);
    pool.rebalance();
    await pool.waitForDeactivation("sess-background");
    expect(sessionIds(fake.deactivated)).toEqual(["sess-background"]);
  });

  it("超过 highWater 时按 LRU 回收到 target", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-1", idleFacts({ lastActivityAt: 100 }));
    fake.sessions.set("sess-2", idleFacts({ lastActivityAt: 200 }));
    fake.sessions.set("sess-3", idleFacts({ lastActivityAt: 300 }));
    fake.sessions.set("sess-4", idleFacts({ lastActivityAt: 400 }));
    fake.sessions.set("sess-5", idleFacts({ lastActivityAt: 500 }));
    const pool = makePool(fake, {
      highWaterCount: 4,
      idleTimeoutMs: 1_000,
      now: () => 0,
      targetCount: 2,
    });

    pool.rebalance();
    await waitForAll(pool, ["sess-1", "sess-2", "sess-3"]);

    expect(sessionIds(fake.deactivated)).toEqual(["sess-1", "sess-2", "sess-3"]);
    expect(fake.deactivated.every((entry) => entry.decision.reason === "high_water_lru")).toBe(
      true,
    );
    expect([...fake.sessions.keys()]).toEqual(["sess-4", "sess-5"]);
  });

  it("resident 等于 highWater 且 TTL 未到时不回收", () => {
    const fake = makeFakeHost();
    for (let index = 1; index <= 4; index += 1) {
      fake.sessions.set(`sess-${index}`, idleFacts());
    }
    const pool = makePool(fake, {
      highWaterCount: 4,
      idleTimeoutMs: 100,
      now: () => 0,
      targetCount: 2,
    });

    pool.rebalance();

    expect(fake.deactivated).toEqual([]);
    expect(fake.sessions.size).toBe(4);
  });

  it("TTL 与 highWater 同轮命中时不会重复关闭", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-1", idleFacts());
    fake.sessions.set("sess-2", idleFacts());
    const pool = makePool(fake, {
      highWaterCount: 1,
      idleTimeoutMs: 0,
      now: () => 0,
      targetCount: 0,
    });

    pool.rebalance();
    await waitForAll(pool, ["sess-1", "sess-2"]);

    expect(sessionIds(fake.deactivated)).toEqual(["sess-1", "sess-2"]);
    expect(fake.deactivated.every((entry) => entry.decision.reason === "idle_timeout")).toBe(true);
  });

  it.each([
    ["runtime owned work", { hasResidencyBlockingWork: true }],
    ["draft 未持久化", { persisted: false }],
    ["pending 交互", { hasPendingInteractions: true }],
    ["gateway queue 非空", { hasQueuedCommands: true }],
    ["conversation 有订阅者", { hasSubscribers: true }],
    ["legacy stream 有订阅者", { hasLegacySubscriber: true }],
  ] as const)("保护条件拦截：%s", async (_label, guard) => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-protected", idleFacts(guard));
    const pool = makePool(fake, {
      highWaterCount: 0,
      idleTimeoutMs: 0,
      targetCount: 0,
    });

    pool.rebalance();
    await pool.waitForDeactivation("sess-protected");

    expect(fake.deactivated).toEqual([]);
    expect(fake.sessions.has("sess-protected")).toBe(true);
  });

  it("受保护 session 数超过 highWater 时允许超额，不取消任何工作", () => {
    const fake = makeFakeHost();
    for (let index = 1; index <= 4; index += 1) {
      fake.sessions.set(`sess-${index}`, idleFacts({ hasResidencyBlockingWork: true }));
    }
    const pool = makePool(fake, {
      highWaterCount: 2,
      idleTimeoutMs: 0,
      targetCount: 1,
    });

    pool.rebalance();

    expect(fake.deactivated).toEqual([]);
    expect(fake.sessions.size).toBe(4);
  });

  it("protocol finalization lease 支持嵌套且 release 幂等", () => {
    const record: Pick<ZCodeProtocolSessionRecord, "residencyFinalizationCount"> = {};
    const releaseFirst = acquireSessionResidencyFinalization(record);
    const releaseSecond = acquireSessionResidencyFinalization(record);

    expect(record.residencyFinalizationCount).toBe(2);
    releaseFirst();
    releaseFirst();
    expect(record.residencyFinalizationCount).toBe(1);
    releaseSecond();
    expect(record.residencyFinalizationCount).toBe(0);
  });

  it("protocol finalization runner 在同步抛错与异步 reject 后都释放 lease", async () => {
    const record: Pick<ZCodeProtocolSessionRecord, "residencyFinalizationCount"> = {};

    await expect(
      runWithSessionResidencyFinalization(record, () => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    expect(record.residencyFinalizationCount).toBe(0);

    await expect(
      runWithSessionResidencyFinalization(record, async () => {
        throw new Error("async failure");
      }),
    ).rejects.toThrow("async failure");
    expect(record.residencyFinalizationCount).toBe(0);
  });

  it("operation lease 阻止 sampler 回收，释放后立即收敛", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-1", idleFacts());
    const pool = makePool(fake, {
      highWaterCount: 0,
      idleTimeoutMs: 1_000,
      targetCount: 0,
    });
    const release = await pool.acquireOperation("sess-1");

    pool.rebalance();
    expect(fake.sessions.has("sess-1")).toBe(true);

    release();
    await pool.waitForDeactivation("sess-1");
    expect(sessionIds(fake.deactivated)).toEqual(["sess-1"]);
  });

  it("无显式 sessionId 的进程级 operation lease 也阻止跨 session 回收", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-other", idleFacts());
    const pool = makePool(fake, {
      highWaterCount: 0,
      idleTimeoutMs: 1_000,
      targetCount: 0,
    });
    const release = await pool.acquireOperation();

    pool.rebalance();
    expect(fake.sessions.has("sess-other")).toBe(true);

    release();
    await pool.waitForDeactivation("sess-other");
    expect(sessionIds(fake.deactivated)).toEqual(["sess-other"]);
  });

  it("候选排序后执行前重读 fresh facts，受保护旧候选被跳过", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-old", idleFacts({ lastActivityAt: 100 }));
    fake.sessions.set("sess-new", idleFacts({ lastActivityAt: 200 }));
    const reads = new Map<string, number>();
    fake.setReadImpl((sessionId) => {
      const count = (reads.get(sessionId) ?? 0) + 1;
      reads.set(sessionId, count);
      const facts = fake.sessions.get(sessionId);
      if (!facts) return null;
      if (sessionId === "sess-old" && count >= 2) {
        return { ...facts, hasSubscribers: true };
      }
      return facts;
    });
    const pool = makePool(fake, {
      highWaterCount: 1,
      idleTimeoutMs: 1_000,
      now: () => 0,
      targetCount: 1,
    });

    pool.rebalance();
    await pool.waitForDeactivation("sess-new");

    expect(sessionIds(fake.deactivated)).toEqual(["sess-new"]);
    expect(fake.sessions.has("sess-old")).toBe(true);
  });

  it("去激活 close 完成前，同 session 的新 operation 等待", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-1", idleFacts());
    let releaseClose: (() => void) | undefined;
    fake.setDeactivateImpl(async (sessionId) => {
      fake.sessions.delete(sessionId);
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    });
    const pool = makePool(fake, {
      highWaterCount: 0,
      idleTimeoutMs: 1_000,
      targetCount: 0,
    });
    pool.rebalance();
    expect(releaseClose).toBeDefined();

    let acquired = false;
    const acquire = pool.acquireOperation("sess-1").then((release) => {
      acquired = true;
      return release;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);

    releaseClose?.();
    const release = await acquire;
    expect(acquired).toBe(true);
    release();
  });

  it("单个 close 失败会上报、释放闸门且不阻断其他候选", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-bad", idleFacts({ lastActivityAt: 1 }));
    fake.sessions.set("sess-good", idleFacts({ lastActivityAt: 2 }));
    fake.setDeactivateImpl(async (sessionId) => {
      fake.sessions.delete(sessionId);
      if (sessionId === "sess-bad") throw new Error("close exploded");
    });
    const pool = makePool(fake, {
      highWaterCount: 0,
      idleTimeoutMs: 1_000,
      targetCount: 0,
    });

    pool.rebalance();
    await waitForAll(pool, ["sess-bad", "sess-good"]);

    expect(fake.errors).toHaveLength(1);
    const closeError = fake.errors[0]!;
    expect(closeError.sessionId).toBe("sess-bad");
    expect((closeError.error as Error).message).toBe("close exploded");
    expect(sessionIds(fake.deactivated)).toEqual(["sess-good"]);
    const release = await pool.acquireOperation("sess-bad");
    release();
  });

  it("deactivate 同步抛错时上报且不留下 deactivation 闸门", async () => {
    const fake = makeFakeHost();
    fake.sessions.set("sess-1", idleFacts());
    fake.setDeactivateImpl(() => {
      throw new Error("sync boom");
    });
    const pool = makePool(fake, {
      highWaterCount: 0,
      idleTimeoutMs: 1_000,
      targetCount: 0,
    });

    expect(() => pool.rebalance()).not.toThrow();
    await pool.waitForDeactivation("sess-1");

    expect(fake.errors).toHaveLength(1);
    expect((fake.errors[0]!.error as Error).message).toBe("sync boom");
  });
});

// ── 执行面单元（stub context）───────────────────────────────────────────────

interface ExecutorHarness {
  context: ZCodeProtocolAgentServerContext;
  record: ZCodeProtocolSessionRecord;
  calls: string[];
  releaseClose(): void;
}

function makeExecutorHarness(sessionId: string): ExecutorHarness {
  const calls: string[] = [];
  let releaseClose: () => void = () => {};
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const record = {
    app: {
      sessionId,
      close: async () => {
        calls.push("app.close");
        await closeGate;
      },
    },
    // 去激活后内存 event store 必须与“从未加载”等价（session-event-store-retention.md）。
    eventStore: {
      deleteSession: async (id: string) => {
        calls.push(`eventStore.deleteSession:${id}`);
      },
    },
    persistence: "immediate",
    unsubscribe: () => {
      calls.push("unsubscribe");
    },
    updatedAt: 0,
  } as unknown as ZCodeProtocolSessionRecord;
  const context = {
    notify: () => {},
    sessions: new Map([[sessionId, record]]),
    v4Gateway: {
      assertSessionRuntimeDeactivatable: () => {},
      deactivateSession: (id: string) => {
        calls.push(`gateway.deactivateSession:${id}`);
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, record, calls, releaseClose: () => releaseClose() };
}

describe("deactivateSessionRecord（执行面）", () => {
  it.each([true, false])(
    "自动回收摘除 record 后执行浏览器释放，结果 ok=%s 决定最终生命周期",
    async (ok) => {
      const sessionId = "sess-browser-idle";
      const harness = makeExecutorHarness(sessionId);
      harness.record.workspace = { workspacePath: "/repo", workspaceKey: "/repo" };
      const requestClient = vi.fn(async () => ({ ok: true, elapsedMs: 0 }));
      harness.context.requestClient = requestClient as typeof harness.context.requestClient;
      harness.context.deps = {
        sessionStore: { getSession: async () => ({ time: {} }) },
      } as unknown as typeof harness.context.deps;
      const broker = createProtocolBrowserControlBroker(harness.context);
      await broker.execute({
        sessionId,
        browserId: "browser-idle",
        browserGeneration: 1,
        command: { method: "getState" },
      });
      requestClient.mockResolvedValue({ ok, elapsedMs: 0 });
      harness.record.app.close = async () => {
        expect(harness.context.sessions.has(sessionId)).toBe(false);
        expect((await getSessionLifecycle(harness.context).getState(sessionId)).state).toBe(
          "stopping",
        );
        await broker.closeSession!({ sessionId });
      };
      const deactivation = deactivateSessionRecord(harness.context, sessionId);
      if (ok) await deactivation;
      else await expect(deactivation).rejects.toThrow();
      expect(requestClient).toHaveBeenLastCalledWith(
        zcodeProtocolMethods.interactionBrowserExecute,
        expect.objectContaining({
          sessionId,
          workspaceKey: "/repo",
          command: { method: "closeSession" },
        }),
        expect.anything(),
      );
      expect((await getSessionLifecycle(harness.context).getState(sessionId)).state).toBe(
        ok ? "unloaded" : "faulted",
      );
    },
  );

  it("内存摘除在同一同步片完成，app.close 后置异步等待", async () => {
    const harness = makeExecutorHarness("sess-exec");
    const promise = deactivateSessionRecord(harness.context, "sess-exec");
    // 调用返回瞬间（未 await）：unsubscribe、gateway 去激活、注册表删除必须已完成——
    // JS 单线程下这保证 subscribe/命令不可能命中"校验通过但还没摘除"的窗口。
    expect(harness.calls).toEqual([
      "unsubscribe",
      "gateway.deactivateSession:sess-exec",
      "app.close",
    ]);
    expect(harness.context.sessions.has("sess-exec")).toBe(false);

    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // close 收尾未完成前不结算
    harness.releaseClose();
    await promise;
    expect(settled).toBe(true);
    // 内存 event store 在 app.close 之后释放，属于同一次去激活事务的收尾。
    expect(harness.calls.at(-1)).toBe("eventStore.deleteSession:sess-exec");
  });

  it("record 不存在时幂等静默", async () => {
    const harness = makeExecutorHarness("sess-exec");
    harness.releaseClose();
    await deactivateSessionRecord(harness.context, "sess-exec");
    await deactivateSessionRecord(harness.context, "sess-exec");
    expect(harness.calls.filter((entry) => entry === "unsubscribe")).toHaveLength(1);
  });

  /**
   * 真实 gateway 的 deactivate 与执行面 preflight 必须复用同一纯校验；这样当前实现会在
   * unsubscribe 后由 deactivate 拒绝，而修复后会在第一个副作用前由 preflight 拒绝。
   */
  function makeThrowingGatewayHarness(sessionId: string): ExecutorHarness {
    const harness = makeExecutorHarness(sessionId);
    const assertSessionRuntimeDeactivatable = (id: string) => {
      harness.calls.push(`gateway.assertSessionRuntimeDeactivatable:${id}`);
      throw new Error(`Session command inbox is still pinned: ${id}`);
    };
    (
      harness.context as unknown as {
        v4Gateway: {
          assertSessionRuntimeDeactivatable(id: string): void;
          deactivateSession(id: string): void;
        };
      }
    ).v4Gateway = {
      assertSessionRuntimeDeactivatable,
      deactivateSession: (id: string) => {
        harness.calls.push(`gateway.deactivateSession:${id}`);
        assertSessionRuntimeDeactivatable(id);
      },
    };
    return harness;
  }

  it("gateway 去激活校验抛错时不留下半清状态", async () => {
    const harness = makeThrowingGatewayHarness("sess-pinned");

    await expect(deactivateSessionRecord(harness.context, "sess-pinned")).rejects.toThrow(
      "Session command inbox is still pinned",
    );

    // Bug 根因：可抛出的 gateway 校验曾位于 unsubscribe 之后，导致 resident record
    // 仍在注册表里但 runtime event subscription 已拆除；预检失败必须完整保留可用状态。
    expect(harness.context.sessions.has("sess-pinned")).toBe(true);
    expect(harness.calls).not.toContain("unsubscribe");
  });
});

// ── 集成（真 sqlite + server + binder）─────────────────────────────────────

const WORKSPACE_PATH = "/workspace/idle-deactivation";
const SESSION_ID = "sess_idle_deactivate" as SessionId;
type TestSessionStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function saveTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  role: "user" | "assistant",
  text: string,
  created: number,
  parentMessageId?: MessageId,
) {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role,
    time: role === "assistant" ? { created, completed: created } : { created },
    agent: "zcode-agent",
    ...(role === "assistant"
      ? {
          parentID: parentMessageId,
          providerID: "glm" as ModelProviderId,
          modelID: "glm-4-air" as ModelId,
          mode: "build",
          path: { cwd: WORKSPACE_PATH, root: WORKSPACE_PATH },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }
      : {
          model: {
            providerID: "glm" as ModelProviderId,
            modelID: "glm-4-air" as ModelId,
          },
          tools: {},
        }),
  } as never);
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

async function seedPersistedSession(dbPath: string): Promise<void> {
  const store = await createSqliteSessionStore({ dbPath });
  try {
    await store.createSession({
      id: SESSION_ID,
      projectID: "project_idle_deactivation" as ProjectId,
      slug: "idle-deactivation-session",
      directory: WORKSPACE_PATH,
      path: WORKSPACE_PATH,
      title: "Idle deactivation session",
      version: "test-version",
      time: { created: 1, updated: 2 },
    });
    await saveTextMessage(store, SESSION_ID, "msg_idle_user_1" as MessageId, "user", "问题", 1);
    await saveTextMessage(
      store,
      SESSION_ID,
      "msg_idle_assistant_1" as MessageId,
      "assistant",
      "回答",
      2,
      "msg_idle_user_1" as MessageId,
    );
  } finally {
    store.close();
  }
}

interface IntegrationHarness {
  server: ZCodeProtocolAgentServer;
  store: TestSessionStore;
  createdApps: ZCodeApp[];
  sessions: Map<string, ZCodeProtocolSessionRecord>;
}

async function bootServer(
  dbPath: string,
  options: {
    appOverrides?: Partial<ZCodeApp>;
    onApp?: (app: ZCodeApp) => void;
    poolOptions?: SessionResidentPoolOptions;
  } = {},
): Promise<IntegrationHarness> {
  const store = await createSqliteSessionStore({ dbPath });
  const createdApps: ZCodeApp[] = [];
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp: (appOptions) => {
      const app = createFakeApp(appOptions, options.appOverrides ?? {});
      createdApps.push(app);
      options.onApp?.(app);
      return app;
    },
    cwd: WORKSPACE_PATH,
    sessionResidentPoolOptions: options.poolOptions ?? {
      highWaterCount: 0,
      idleTimeoutMs: 10 * 60 * 1_000,
      targetCount: 0,
    },
    sessionStore: store,
  });
  const sessions = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context
    .sessions;
  return { server, store, createdApps, sessions };
}

// subscribe response 严格 ACK-only；initial snapshot 走 request-scoped post-response
// outbox（response line 之后的 owned notification），此处解析出来一并返回。
async function subscribeConversation(
  server: ZCodeProtocolAgentServer,
  requestId: string,
  connectionId: string,
) {
  const result = await requestResult(server, {
    id: requestId,
    method: V4_METHODS.conversationSubscribe,
    params: {
      topic: conversationTopic(SESSION_ID),
      connectionId,
      clientMode: "desktop-continuous",
    },
  });
  const { ack } = v4ConversationSubscribeResultSchema.parse(result);
  const messages = server.takePostResponseMessages(requestId);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ method: V4_NOTIFICATIONS.conversationFrame });
  const wire = routedTopicWireFrameSchema.parse((messages[0] as { params: unknown }).params);
  if (wire.kind !== "complete") {
    throw new Error("initial-frame adapter expected one complete physical wire");
  }
  return { ack, initialFrame: conversationTopicFrameSchema.parse(wire.frame) };
}

describe("session resident pool（集成：真 sqlite + server + binder）", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-idle-deactivation-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  it("空闲 session 被去激活：注册表摘除、无 session.removed、再订阅冷恢复", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const clock = createTestClock(1_000);
    const { server, store, createdApps, sessions } = await bootServer(dbPath, {
      poolOptions: {
        highWaterCount: 16,
        idleTimeoutMs: 100,
        now: clock.now,
        targetCount: 8,
      },
    });
    const indexFrames: unknown[] = [];
    server.setNotificationSink((message) => {
      // 挂 sink 后冷恢复会真发 runtime preferences 反向请求并等待响应，自动应答避免超时。
      if (
        "id" in message &&
        "method" in message &&
        message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
      ) {
        void server.handleMessage({
          id: message.id,
          result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: false },
        });
        return;
      }
      if ("method" in message && message.method === V4_NOTIFICATIONS.conversationFrame) {
        const wire = routedTopicWireFrameSchema.parse((message as { params: unknown }).params);
        if (wire.kind === "complete" && wire.topic.startsWith("sessions-index/")) {
          indexFrames.push(wire.frame);
        }
      }
    });
    try {
      // 侧边栏列表订阅者：验证去激活不产生 session.removed 增量帧。
      const indexResult = await requestResult(server, {
        id: "idx-sub",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: sessionsIndexTopic(WORKSPACE_PATH),
          connectionId: "conn-index",
          clientMode: "desktop-continuous",
        },
      });
      v4SessionsIndexSubscribeResultSchema.parse(indexResult);
      server.takePostResponseMessages("idx-sub");

      const subscribed = await subscribeConversation(server, "conv-sub", "conn-desktop");
      expect(sessions.has(SESSION_ID)).toBe(true);
      expect(createdApps).toHaveLength(1);

      // conversation 订阅者在场时不得开始 idle TTL。
      server.rebalanceResidentSessions();
      expect(sessions.has(SESSION_ID)).toBe(true);

      await requestResult(server, {
        id: "conv-unsub",
        method: V4_METHODS.conversationUnsubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-desktop",
          subscriptionId: subscribed.ack.subscriptionId,
        },
      });

      // 订阅者离开只开始新的 idle TTL，未超 highWater 时保留热 runtime。
      expect(sessions.has(SESSION_ID)).toBe(true);
      clock.advance(99);
      server.rebalanceResidentSessions();
      expect(sessions.has(SESSION_ID)).toBe(true);
      clock.advance(1);
      server.rebalanceResidentSessions();
      expect(sessions.has(SESSION_ID)).toBe(false);
      await (
        server as unknown as {
          context: { sessionResidentPool?: { waitForDeactivation(id: string): Promise<void> } };
        }
      ).context.sessionResidentPool?.waitForDeactivation(SESSION_ID);

      // 列表订阅者没有收到 session.removed（侧边栏项必须原样保留）。
      const removedFrames = indexFrames
        .map((frame) => sessionsIndexTopicFrameSchema.parse(frame))
        .filter(
          (frame) =>
            frame.payload.kind === "deltas" &&
            frame.payload.deltas.some((delta) => delta.op === "session.removed"),
        );
      expect(removedFrames).toEqual([]);

      // 再订阅：走冷恢复重建 record（新建第二个 app），snapshot 含历史。
      const resubscribed = await subscribeConversation(server, "conv-resub", "conn-desktop-2");
      if (resubscribed.initialFrame.payload.kind !== "snapshot") {
        throw new Error("Expected cold-resume snapshot");
      }
      expect(
        resubscribed.initialFrame.payload.snapshot.rows.window.some(
          (row) => row.kind === "userInput" && row.text === "问题",
        ),
      ).toBe(true);
      expect(
        resubscribed.initialFrame.payload.snapshot.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === "回答",
        ),
      ).toBe(true);
      expect(sessions.has(SESSION_ID)).toBe(true);
      expect(createdApps).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("再激活闸门：app.close 收尾完成前，同 session 的冷订阅等待后成功", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCount = 0;
    const { server, store, createdApps, sessions } = await bootServer(dbPath, {
      appOverrides: {
        close: async () => {
          closeCount += 1;
          if (closeCount === 1) await closeGate; // 只挂第一次去激活的收尾
        },
      },
    });
    try {
      const subscribed = await subscribeConversation(server, "gate-sub", "conn-gate");
      await requestResult(server, {
        id: "gate-unsub",
        method: V4_METHODS.conversationUnsubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-gate",
          subscriptionId: subscribed.ack.subscriptionId,
        },
      });
      expect(sessions.has(SESSION_ID)).toBe(false); // 同步段已摘除，close 收尾挂起中

      let resubscribeSettled = false;
      const resubscribePromise = subscribeConversation(server, "gate-resub", "conn-gate-2").then(
        (result) => {
          resubscribeSettled = true;
          return result;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resubscribeSettled).toBe(false); // 闸门：收尾未完成不物化新 record
      expect(createdApps).toHaveLength(1);

      releaseClose?.();
      const resubscribed = await resubscribePromise;
      expect(resubscribed.initialFrame?.payload.kind).toBe("snapshot");
      expect(sessions.has(SESSION_ID)).toBe(true);
      expect(createdApps).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

// ── server 装配层配置回退 ──────────────────────────────────────────────────

describe("SessionResidentPool 配置回退", () => {
  function makeServer(deps: Partial<ZCodeProtocolAgentDependencies>) {
    return new ZCodeProtocolAgentServer({
      createZCodeApp: (appOptions) => createFakeApp(appOptions, {}),
      cwd: WORKSPACE_PATH,
      ...deps,
    });
  }

  function contextOf(server: ZCodeProtocolAgentServer) {
    return (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
  }

  function addIdleResident(context: ZCodeProtocolAgentServerContext, sessionId: string) {
    context.sessions.set(sessionId, {
      app: {
        close: async () => {},
        runtime: { hasResidencyBlockingWork: () => false },
      },
      legacyStreamSubscribed: false,
      persistence: "immediate",
      updatedAt: 0,
    } as unknown as ZCodeProtocolSessionRecord);
  }

  it("legacy sessionResidentTargetCount 只表达 low-water，不塌掉迟滞窗口", () => {
    const server = makeServer({ sessionResidentTargetCount: 2 });
    const context = contextOf(server);
    for (const sessionId of ["s1", "s2", "s3"]) addIdleResident(context, sessionId);

    context.sessionResidentPool!.rebalance();

    // Bug 根因：legacy low-water 曾同时覆盖 high-water，3 个 resident 会立即被砍到 2，
    // 让默认 16/low-water 2 的迟滞窗口退化为零宽窗口。
    expect(context.sessions.size).toBe(3);
  });

  it("只覆盖 targetCount 且高于默认 high-water 时不让 server 构造失败", () => {
    // 装配层应解析出有效 high-water；测试只约束 CLI 可启动，不锁死具体推导策略。
    expect(() => makeServer({ sessionResidentPoolOptions: { targetCount: 20 } })).not.toThrow();
  });
});

// 生命周期协议使用真实 store/server，验证查询和变更并非仅有一个独立状态机。
describe("session lifecycle protocol", () => {
  let root: string;
  let harness: IntegrationHarness;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "session-lifecycle-"));
    const dbPath = join(root, "sessions.sqlite");
    await seedPersistedSession(dbPath);
    harness = await bootServer(dbPath, { poolOptions: { highWaterCount: 16, targetCount: 8 } });
  });
  afterEach(async () => {
    await Promise.allSettled((harness?.createdApps ?? []).map((app) => app.close?.()));
    harness?.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (h: IntegrationHarness, method: string) =>
    requestResult(h.server, {
      id: Math.random().toString(),
      method: method as never,
      params: { sessionId: SESSION_ID },
    });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "carries the attachment through cold open and lifecycle activation (%s)",
    async (clientMode) => {
      const workspace = { workspacePath: WORKSPACE_PATH + "/", workspaceKey: WORKSPACE_PATH + "/" };
      const requests: unknown[] = [];
      await requestResult(harness.server, {
        id: "capabilities",
        method: zcodeProtocolMethods.runtimeCapabilities,
        params: {
          hostCapabilities: { sessionDirectorySource: true, sessionWorkspaceRouting: true },
        },
      });
      harness.server.setNotificationSink((message) => {
        if (!("id" in message) || !("method" in message)) return;
        requests.push(message.params);
        const correct = (message.params as { workspace?: unknown }).workspace;
        void harness.server.handleMessage(
          JSON.stringify(correct) === JSON.stringify(workspace)
            ? { id: message.id, result: { nativeSearchEnhancementsEnabled: false } }
            : {
                id: message.id,
                error: { code: -32602, message: "Request workspace is not owned by this CLI" },
              },
        );
      });
      const before = await harness.store.getSession(SESSION_ID);
      await requestResult(harness.server, {
        id: "open-with-workspace",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "viewer",
          clientMode,
          workspace,
        },
      });
      for (const method of [
        zcodeProtocolMethods.sessionLifecycleRestart,
        zcodeProtocolMethods.sessionLifecycleEnsureReady,
      ]) {
        if (method === zcodeProtocolMethods.sessionLifecycleEnsureReady)
          await call(harness, "session/lifecycle/stop");
        await requestResult(harness.server, {
          id: method,
          method,
          params: { sessionId: SESSION_ID, workspace },
        });
        expect(harness.sessions.get(SESSION_ID)?.workspace).toEqual(workspace);
      }
      expect(requests).toHaveLength(3);
      expect(await harness.store.getSession(SESSION_ID)).toEqual(before);
      const count = harness.createdApps.length;
      const rejected = await harness.server.handleMessage({
        id: "wrong-workspace",
        method: zcodeProtocolMethods.sessionLifecycleRestart,
        params: {
          sessionId: SESSION_ID,
          workspace: { workspacePath: "/other", workspaceKey: "/other" },
        },
      });
      expect(rejected).toHaveProperty("error");
      expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "ready" });
      expect(harness.createdApps).toHaveLength(count);
    },
  );

  it.each([
    zcodeProtocolMethods.sessionLifecycleEnsureReady,
    zcodeProtocolMethods.sessionLifecycleRestart,
  ])("rejects identity-only changes before touching a ready runtime (%s)", async (method) => {
    const sessionId = "sess_remote_identity_guard" as SessionId;
    const identity = `remote:ssh:host-a.example:22:dev:${WORKSPACE_PATH}`;
    const workspace = {
      workspacePath: WORKSPACE_PATH,
      workspaceKey: identity,
      workspaceIdentity: identity,
      remoteSessionId: "route-a",
    };
    await harness.store.createSession({
      id: sessionId,
      projectID: "remote_identity" as ProjectId,
      workspaceID: identity as WorkspaceId,
      slug: "remote-identity",
      directory: WORKSPACE_PATH,
      path: WORKSPACE_PATH,
      title: "Remote identity",
      version: "test",
      time: { created: 1, updated: 2 },
    });
    await requestResult(harness.server, {
      id: "start-remote",
      method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
      params: { sessionId, workspace },
    });
    const record = harness.sessions.get(sessionId)!;
    const close = vi.spyOn(record.app, "close");
    const state = await getSessionLifecycle(
      (harness.server as unknown as { context: ZCodeProtocolAgentServerContext }).context,
    ).getState(sessionId);
    const appsBefore = harness.createdApps.length;
    for (const workspaceIdentity of [
      `remote:ssh:host-b.example:22:other:${WORKSPACE_PATH}`,
      undefined,
    ]) {
      const response = await harness.server.handleMessage({
        id: `wrong-${workspaceIdentity ?? "missing"}`,
        method,
        params: { sessionId, workspace: { ...workspace, workspaceIdentity } },
      });
      expect(response).toMatchObject({ error: { message: "project.session-lineage-invalid" } });
      expect(close).not.toHaveBeenCalled();
      expect(harness.createdApps).toHaveLength(appsBefore);
      expect(harness.sessions.get(sessionId)).toBe(record);
      expect(
        await requestResult(harness.server, {
          id: "state",
          method: zcodeProtocolMethods.sessionLifecycleGetState,
          params: { sessionId },
        }),
      ).toMatchObject({ state: "ready", generation: state.generation });
    }
    await requestResult(harness.server, {
      id: "correct",
      method,
      params: { sessionId, workspace },
    });
    expect(close).toHaveBeenCalledTimes(
      method === zcodeProtocolMethods.sessionLifecycleRestart ? 1 : 0,
    );
  });

  it("settles the inbox after goal pause failure and preserves the failed stage", async () => {
    await call(harness, "session/lifecycle/ensureReady");
    const context = (harness.server as unknown as { context: ZCodeProtocolAgentServerContext })
      .context;
    const record = harness.sessions.get(SESSION_ID)!;
    record.app.readTarget = vi.fn().mockResolvedValue({ status: "active" });
    record.app.updateTargetStatus = vi.fn().mockRejectedValue(new Error("target write failed"));
    const finish = vi.spyOn(context.v4Gateway!, "finishSessionRelease");
    await expect(call(harness, "session/lifecycle/stop")).rejects.toThrow("goal_pause");
    expect(finish).toHaveBeenCalledWith(SESSION_ID);
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "faulted" });
  });

  it("queries unloaded without activation, then ensures/restarts/stops while preserving history", async () => {
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "unloaded" });
    expect(harness.createdApps).toHaveLength(0);
    await Promise.all([
      call(harness, "session/lifecycle/ensureReady"),
      call(harness, "session/lifecycle/ensureReady"),
    ]);
    expect(harness.createdApps).toHaveLength(1);
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "ready" });
    await call(harness, "session/lifecycle/restart");
    expect(harness.createdApps).toHaveLength(2);
    await call(harness, "session/lifecycle/stop");
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "unloaded" });
    expect(await harness.store.getSession(SESSION_ID)).toBeTruthy();
    expect(await harness.store.messages({ sessionID: SESSION_ID })).toHaveLength(2);
  });

  it("restarts an actively subscribed session and rebuilds its publisher", async () => {
    await subscribeConversation(harness.server, "subscribe", "desktop");
    const response = await harness.server.handleMessage({
      id: "restart",
      method: "session/lifecycle/restart" as never,
      params: { sessionId: SESSION_ID },
    });
    expect(response).toMatchObject({ result: { completed: true } });
    expect(harness.createdApps).toHaveLength(2);
    await subscribeConversation(harness.server, "resubscribe", "desktop");
    expect(harness.sessions.has(SESSION_ID)).toBe(true);
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "ready" });
  });
  it("reports partial initialization and joins legacy resume with lifecycle activation", async () => {
    harness.store.close();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    harness = await bootServer(join(root, "sessions.sqlite"), {
      poolOptions: { highWaterCount: 16, targetCount: 8 },
      onApp: (app) => {
        const resume = app.resume.bind(app);
        app.resume = async (...args) => {
          entered.resolve();
          await gate.promise;
          return resume(...args);
        };
      },
    });
    const first = call(harness, "session/lifecycle/ensureReady");
    await entered.promise;
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "starting" });
    const legacy = call(harness, "session/resume");
    const stop = await harness.server.handleMessage({
      id: "conflict",
      method: "session/lifecycle/stop",
      params: { sessionId: SESSION_ID },
    });
    expect(stop).toMatchObject({ error: { data: { code: "conflict" } } });
    gate.resolve();
    await Promise.all([first, legacy]);
    expect(harness.createdApps).toHaveLength(1);
  });

  it("does not recreate an instance after a close failure, including the legacy resume path", async () => {
    harness.store.close();
    harness = await bootServer(join(root, "sessions.sqlite"), {
      poolOptions: { highWaterCount: 16, targetCount: 8 },
      appOverrides: {
        close: async () => {
          throw new Error("resource still owned");
        },
      },
    });
    await call(harness, "session/lifecycle/ensureReady");
    await expect(call(harness, "session/lifecycle/stop")).rejects.toThrow();
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "faulted" });
    for (const method of [
      "session/resume",
      "session/lifecycle/ensureReady",
      "session/lifecycle/restart",
      "session/lifecycle/stop",
    ]) {
      const response = await harness.server.handleMessage({
        id: method,
        method: method as never,
        params: { sessionId: SESSION_ID },
      });
      expect(response).toMatchObject({ error: { data: { code: "recoveryRequired" } } });
    }
    expect(harness.createdApps).toHaveLength(1);
  });

  it("ignores callbacks queued by the previous instance after it is released", async () => {
    harness.store.close();
    let emit: ((event: never) => void) | undefined;
    harness = await bootServer(join(root, "sessions.sqlite"), {
      poolOptions: { highWaterCount: 16, targetCount: 8 },
      onApp: (app) => {
        app.runtime.subscribeEvents = (handlers) => {
          emit = (event) => {
            handlers.onSessionEvent?.(event);
          };
          return () => {};
        };
      },
    });
    await call(harness, "session/lifecycle/ensureReady");
    const emitOld = emit!;
    await call(harness, "session/lifecycle/restart");
    // 未消费的旧 callback 不能解析事件，更不能写入新 publisher。
    expect(() =>
      emitOld({
        get type() {
          throw new Error("stale event consumed");
        },
      } as never),
    ).not.toThrow();
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "ready" });
  });
  it("owns a materialized app even when event subscription fails before initialization finishes", async () => {
    harness.store.close();
    let closed = 0;
    harness = await bootServer(join(root, "sessions.sqlite"), {
      poolOptions: { highWaterCount: 16, targetCount: 8 },
      onApp: (app) => {
        app.runtime.subscribeEvents = () => {
          throw new Error("subscribe failed");
        };
      },
      appOverrides: {
        close: async () => {
          closed += 1;
          throw new Error("resource still owned");
        },
      },
    });
    await expect(call(harness, "session/lifecycle/ensureReady")).rejects.toThrow();
    expect(closed).toBe(1);
    expect(await call(harness, "session/lifecycle/getState")).toMatchObject({ state: "faulted" });
  });
});

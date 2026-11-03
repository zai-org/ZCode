import { mcpUiInstances } from "../src/zcode-protocol/mcp-ui/instances.js";
import { createMcpUiHandlers } from "../src/zcode-protocol/mcp-ui/index.js";
import { createExampleSessionAccess } from "../src/zcode-protocol/mcp-ui/contract.example.js";
import { DatabaseSync } from "node:sqlite";
// M5 冷恢复（打开历史会话）验收网：CLI 重启后内存注册表为空，v4 订阅历史会话
// 必须经 host.resumePersistedSession 把 record 拉起来，而不是抛
// "Session is not active"（真 bug：桌面重启后点侧栏历史会话永远"连接中"）。
//
// 两层覆盖：
// - gateway 单元（stub host）：单飞幂等 / 完整事件日志 hydration 路径 /
//   notFound vs resumeFailed 错误分型 / 宿主未实现钩子的退化行为。
// - 集成（真 sqlite sessionStore + ZCodeProtocolAgentServer + binder）：
//   写 transcript → 关库重开（模拟 CLI 重启，context.sessions 为空）→
//   v4 subscribe → snapshot 含历史行（transcript 合成路径）→ sendText 再发一轮成功；
//   restoreWarning 语义保真（workspace 无可用模型时 sendText 被拒）；
//   store 无此会话 → fault.subscribe.sessionNotFound。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import {
  V4_METHODS,
  applyConversationDeltas,
  type ConversationSnapshot,
  V4_NOTIFICATIONS,
  commandAckSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  routedTopicWireFrameSchema,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  EventId,
  MessageId,
  MessagePart,
  MessageWithParts,
  ModelId,
  ModelProviderId,
  ProjectId,
  SessionEvent,
  SessionId,
  TraceId,
  WorkspaceId,
} from "@zcode/contracts";
import {
  CompactTrigger,
  SESSION_ENTRY_MODEL_SELECTION,
  SessionEventType,
  type CompactBoundaryPayload,
} from "@zcode/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type Provider,
} from "@zcode/provider";
import {
  ConversationV4Gateway,
  V4SubscribeSessionUnavailableError,
  type ColdSessionResumeOutcome,
} from "../src/zcode-protocol-v4/index.js";
import { resolveSessionContextUsage } from "../src/zcode-protocol/session-mapper.js";
import { getRegistryBackedModel } from "../src/app/provider-registry-selection.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";
import type { SessionUsageSeed } from "../src/zcode-protocol-v4/product-projection.js";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import {
  HISTORY_MARKER,
  SURVIVOR_ID,
  seedFailedForkRace,
} from "../../adapters/tests/fixtures/session-transaction-race.js";

// ── gateway 单元层（stub host，模式对齐 v4-gateway.test.ts）──────────────────

interface ColdHostStub {
  sessions: Set<string>;
  frames: ConversationTopicFrame[];
  errors: Array<{ scope: string; error: unknown }>;
  resumeCalls: string[];
  resumeThoughtLevels: Array<string | undefined>;
  resumeImpl: (sessionId: string) => Promise<ColdSessionResumeOutcome>;
  persistedEvents: Map<string, SessionEvent[]>;
  usageSeeds: Map<string, SessionUsageSeed>;
  synthesizedSessions: Set<string>;
}

function makeColdHost(): ColdHostStub {
  const host: ColdHostStub = {
    sessions: new Set(),
    frames: [],
    errors: [],
    resumeCalls: [],
    resumeThoughtLevels: [],
    // 默认打桩：恢复成功 = 会话进入内存注册表（对应 binder 的 resumeSession 建 record）。
    resumeImpl: async (sessionId) => {
      host.sessions.add(sessionId);
      return { status: "resumed" };
    },
    persistedEvents: new Map(),
    usageSeeds: new Map(),
    synthesizedSessions: new Set(),
  };
  return host;
}

function coldResumeHook(host: ColdHostStub) {
  return async (sessionId: string, resumeThoughtLevel?: string) => {
    host.resumeCalls.push(sessionId);
    host.resumeThoughtLevels.push(resumeThoughtLevel);
    return await host.resumeImpl(sessionId);
  };
}

function makeColdGateway(
  host: ColdHostStub,
  options: { withResumeHook?: boolean; now?: () => number } = {},
): ConversationV4Gateway {
  const withResumeHook = options.withResumeHook ?? true;
  return new ConversationV4Gateway(
    {
      sessionExists: (sessionId) => host.sessions.has(sessionId),
      emitWireFrame: (wire) => {
        if (wire.kind !== "complete" || !wire.topic.startsWith("conversation/")) {
          throw new Error("cold-resume test adapter only accepts complete conversation wires");
        }
        host.frames.push(wire.frame as ConversationTopicFrame);
      },
      executeCommand: async () => undefined,
      ...(withResumeHook
        ? {
            resumePersistedSession: coldResumeHook(host),
          }
        : {}),
      loadPersistedEvents: async (sessionId) => ({
        events: host.persistedEvents.get(sessionId) ?? [],
        synthesized: host.synthesizedSessions.has(sessionId),
      }),
      getSessionUsageSeed: (sessionId) => host.usageSeeds.get(sessionId) ?? null,
      onError: (scope, error) => host.errors.push({ scope, error }),
    },
    {
      now: options.now ?? (() => 1_700_000_999_000),
      createLogEpoch: () => "epoch-cold",
    },
  );
}

function makeEvent(
  sessionId: string,
  seq: number,
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent {
  return {
    id: `event-${seq}` as EventId,
    sessionId: sessionId as SessionId,
    turnId: undefined,
    type,
    timestamp: new Date(1_700_000_000_000 + seq * 1000),
    traceId: "trace-cold" as TraceId,
    sequenceNumber: seq,
    payload,
  } as SessionEvent;
}

function subscribeParams(sessionId: string) {
  return {
    topic: conversationTopic(sessionId),
    connectionId: "conn-cold",
    clientMode: "desktop-continuous",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("v4 冷恢复（gateway 单元）", () => {
  it("rowsRange resident-only：冷会话报 proto.sessionNotResident，不冷恢复", async () => {
    const host = makeColdHost();
    host.persistedEvents.set("sess-cold", [
      makeEvent("sess-cold", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    ]);
    const gateway = makeColdGateway(host);

    await expect(
      gateway.rowsRange({ sessionId: "sess-cold", limit: 30, residency: "resident-only" }),
    ).rejects.toMatchObject({ reasonCode: "proto.sessionNotResident" });
    expect(host.resumeCalls).toEqual([]);
  });

  it("rowsRange resident-only：内存里的会话照常返回最新一页", async () => {
    const host = makeColdHost();
    host.sessions.add("sess-live");
    host.persistedEvents.set("sess-live", [
      makeEvent("sess-live", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    ]);
    const gateway = makeColdGateway(host);

    const result = await gateway.rowsRange({
      sessionId: "sess-live",
      limit: 30,
      residency: "resident-only",
    });
    expect(Array.isArray(result.rows)).toBe(true);
    expect(host.resumeCalls).toEqual([]);
  });

  it("冷订阅未加载会话：单一 READY 完成 activation 与 hydration", async () => {
    const host = makeColdHost();
    host.persistedEvents.set("sess-cold", [
      makeEvent("sess-cold", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    ]);
    const gateway = makeColdGateway(host);

    const result = await gateway.subscribe(subscribeParams("sess-cold"));
    expect(host.resumeCalls).toEqual(["sess-cold"]);
    expect(result.ack.mode).toBe("snapshot");
    expect(result.ack.openTiming).toMatchObject({
      version: 1,
      sessionRuntimeState: "cold",
      cliSessionRestoreMs: expect.any(Number),
      initialFrameEncodeMs: expect.any(Number),
      snapshotRowCount: expect.any(Number),
    });
    expect(result.initialFrame?.payload.kind).toBe("snapshot");
  });

  it("Todo123: 同批容量种子不二次查询，恢复期间新模型和用量覆盖旧种子", async () => {
    const entered = deferred();
    const release = deferred();
    const getSessionUsageSeed = vi.fn(() => null);
    const sessionId = "sess-usage-race";
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      getSessionUsageSeed,
      loadPersistedEvents: async () => {
        entered.resolve();
        await release.promise;
        return {
          synthesized: true,
          sourceEventSeq: 1,
          events: [
            makeEvent(sessionId, 1, SessionEventType.SessionCreated, { contextWindow: 1_000_000 }),
          ],
          usageSeed: {
            contextWindow: {
              usedTokens: 29908,
              maxTokens: 1_000_000,
              autoCompactThresholdTokens: null,
            },
          },
        };
      },
    });
    try {
      const pending = gateway.subscribe(subscribeParams(sessionId));
      await entered.promise;
      gateway.ingest(
        sessionId,
        makeEvent(sessionId, 2, SessionEventType.ModelSelected, {
          modelSelection: { providerId: "new", modelId: "new-model" },
          contextWindow: 500_000,
        }),
      );
      gateway.ingest(
        sessionId,
        makeEvent(sessionId, 3, SessionEventType.ModelComplete, {
          content: "",
          stopReason: "end_turn",
          querySource: "main_turn",
          usage: { inputTokens: 700, outputTokens: 30 },
        }),
      );
      release.resolve();
      const result = await pending;
      if (result.initialFrame?.payload.kind !== "snapshot") throw new Error("Expected snapshot");
      expect(result.initialFrame.payload.snapshot.config.model).toBe("new-model");
      expect(result.initialFrame.payload.snapshot.usage.contextWindow).toMatchObject({
        usedTokens: 730,
        maxTokens: 500_000,
      });
      expect(getSessionUsageSeed).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      gateway.dispose();
    }
  });

  it("首帧编码耗时包含 wire projection 构建", async () => {
    const sessionId = "sess-live-initial-frame-timing";
    const host = makeColdHost();
    host.sessions.add(sessionId);
    let monotonicTime = 0;
    let simulateWireProjectionBuild = false;
    const gateway = makeColdGateway(host, {
      now: () => {
        // publisher 构建 initial frame 时会写 sentAt；借该公开时钟缝隙推进 monotonic clock，
        // 可确定性验证构建耗时是否包含在 initialFrameEncodeMs，而不依赖真实 CPU 速度。
        if (simulateWireProjectionBuild) monotonicTime += 25;
        return 1_700_000_999_000;
      },
    });
    gateway.ingest(
      sessionId,
      makeEvent(sessionId, 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
    );

    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    simulateWireProjectionBuild = true;

    try {
      const result = await gateway.subscribe(subscribeParams(sessionId));
      expect(result.ack.openTiming?.initialFrameEncodeMs).toBe(25);
    } finally {
      nowSpy.mockRestore();
      gateway.dispose();
    }
  });

  it("冷订阅只把 task-local thought hint 交给首次 resume", async () => {
    const host = makeColdHost();
    const gateway = makeColdGateway(host);

    await gateway.subscribe({
      ...subscribeParams("sess-cold-thought"),
      resumeThoughtLevel: "deep",
    });

    expect(host.resumeThoughtLevels).toEqual(["deep"]);
  });

  it("桌面与手机并发冷订阅同一会话：activation 单飞且首个终态一致", async () => {
    const host = makeColdHost();
    const messages: MessageWithParts[] = [];
    const loadedPersistedMessages: unknown[] = [];
    const usagePersistedMessages: unknown[] = [];
    const resumeEntered = deferred();
    const resumeGate = deferred();
    host.resumeImpl = async (sessionId) => {
      // production 在 app.resume() 前先注册 record；第二个订阅此时会观察到 live，
      // 但仍必须加入 activation flight，不能用空 materialization 抢跑 hydration。
      host.sessions.add(sessionId);
      resumeEntered.resolve();
      await resumeGate.promise;
      return { status: "resumed", persistedMessages: messages };
    };
    const gateway = new ConversationV4Gateway(
      {
        sessionExists: (sessionId) => host.sessions.has(sessionId),
        resumePersistedSession: coldResumeHook(host),
        loadPersistedEvents: async (_sessionId, persistedMessages) => {
          loadedPersistedMessages.push(persistedMessages);
          return { events: [], synthesized: true };
        },
        getSessionUsageSeed: (_sessionId, persistedMessages) => {
          usagePersistedMessages.push(persistedMessages);
          return null;
        },
        emitWireFrame: () => {},
        executeCommand: async () => undefined,
      },
      { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-cold" },
    );

    const first = gateway.subscribe(subscribeParams("sess-cold"));
    const second = gateway.subscribe({
      ...subscribeParams("sess-cold"),
      clientMode: "web-remote-replayable",
      connectionId: "conn-cold-2",
    });
    // 等真实恢复进入 barrier 后再放行，避免依赖内部 Promise 链的 microtask 层数。
    await resumeEntered.promise;
    resumeGate.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(host.resumeCalls).toEqual(["sess-cold"]);
    expect(loadedPersistedMessages).toEqual([messages]);
    expect(usagePersistedMessages).toEqual([messages]);
    if (a.initialFrame?.payload.kind !== "snapshot") {
      throw new Error("Expected desktop snapshot frame");
    }
    if (b.initialFrame?.payload.kind !== "snapshot") {
      throw new Error("Expected mobile snapshot frame");
    }
    expect(a.ack.subscriptionId).not.toBe(b.ack.subscriptionId);
    expect(a.initialFrame.payload.snapshot).toEqual(b.initialFrame.payload.snapshot);
  });

  it("cold READY 同时阻塞 command/query，完成后各只进入一次既有流程", async () => {
    const host = makeColdHost();
    const resumeStarted = deferred();
    const resumeGate = deferred();
    const hydrationStarted = deferred();
    const hydrationGate = deferred();
    const queryCommandId = "cmd-query-cold-ready";
    let discardedReady = false;
    host.resumeImpl = async (sessionId) => {
      // 复现 production：record 先入册，遗留 admitted input 在 resume 收尾时才变成 discarded。
      host.sessions.add(sessionId);
      resumeStarted.resolve();
      await resumeGate.promise;
      discardedReady = true;
      return { status: "resumed", persistedMessages: [] };
    };
    const admitCommandInput = vi.fn(async () => null);
    const executeCommand = vi.fn(async () => undefined);
    const invalidatePersistentCommandFacts = vi.fn();
    const lookupDiscardedCommand = vi.fn(async (key: { commandId: string }) =>
      discardedReady && key.commandId === queryCommandId
        ? {
            commandId: queryCommandId,
            status: "failed" as const,
            reasonCode: "fault.command.inputDiscardedOnRestart",
            revisionAtDecision: 0,
          }
        : null,
    );
    const gateway = new ConversationV4Gateway(
      {
        sessionExists: (sessionId) => host.sessions.has(sessionId),
        resumePersistedSession: coldResumeHook(host),
        loadPersistedEvents: async () => {
          hydrationStarted.resolve();
          await hydrationGate.promise;
          return { events: [], synthesized: true };
        },
        admitCommandInput,
        lookupDiscardedCommand,
        invalidatePersistentCommandFacts,
        emitWireFrame: () => {},
        executeCommand,
      },
      { now: () => 1_700_000_999_000, createLogEpoch: () => "epoch-cold" },
    );

    const sessionId = "sess-command-ready";
    const subscribing = gateway.subscribe(subscribeParams(sessionId));
    await resumeStarted.promise;
    let commandSettled = false;
    let querySettled = false;
    const commanding = gateway
      .handleCommand({
        commandId: "cmd-command-ready",
        clientId: "client-command-ready",
        sessionId,
        type: "sendText",
        payload: { text: "继续" },
        issuedAt: 1_700_000_999_000,
      })
      .then((ack) => {
        commandSettled = true;
        return ack;
      });
    const querying = gateway
      .queryCommands({ commands: [{ sessionId, commandId: queryCommandId }] })
      .then((result) => {
        querySettled = true;
        return result;
      });

    try {
      await nextMacrotask();
      expect(commandSettled).toBe(false);
      expect(querySettled).toBe(false);
      expect(admitCommandInput).not.toHaveBeenCalled();
      expect(lookupDiscardedCommand).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();

      resumeGate.resolve();
      await hydrationStarted.promise;
      expect(invalidatePersistentCommandFacts).not.toHaveBeenCalled();
      await nextMacrotask();
      expect(commandSettled).toBe(false);
      expect(querySettled).toBe(false);
      expect(admitCommandInput).not.toHaveBeenCalled();
      expect(lookupDiscardedCommand).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();

      hydrationGate.resolve();
      const [subscription, ack, query] = await Promise.all([subscribing, commanding, querying]);
      expect(subscription.initialFrame?.payload.kind).toBe("snapshot");
      expect(ack.status).toBe("accepted");
      expect(query.results).toEqual([
        {
          key: { sessionId, commandId: queryCommandId },
          result: {
            commandId: queryCommandId,
            status: "failed",
            reasonCode: "fault.command.inputDiscardedOnRestart",
            revisionAtDecision: 0,
          },
        },
      ]);
      expect(admitCommandInput).toHaveBeenCalledTimes(1);
      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(
        lookupDiscardedCommand.mock.calls.filter(([key]) => key.commandId === queryCommandId),
      ).toHaveLength(1);
    } finally {
      resumeGate.resolve();
      hydrationGate.resolve();
      await Promise.allSettled([subscribing, commanding, querying]);
      gateway.dispose();
    }
  });

  it("既有 live session 的首次 hydration 不引入 cold READY command 等待", async () => {
    const host = makeColdHost();
    host.sessions.add("sess-live-hydration");
    const hydrationStarted = deferred();
    const hydrationGate = deferred();
    const executeCommand = vi.fn(async () => undefined);
    const gateway = new ConversationV4Gateway({
      sessionExists: (sessionId) => host.sessions.has(sessionId),
      loadPersistedEvents: async () => {
        hydrationStarted.resolve();
        await hydrationGate.promise;
        return { events: [], synthesized: false };
      },
      emitWireFrame: () => {},
      executeCommand,
    });

    const subscribing = gateway.subscribe(subscribeParams("sess-live-hydration"));
    await hydrationStarted.promise;
    const commanding = gateway.handleCommand({
      commandId: "cmd-live-hydration",
      clientId: "client-live-hydration",
      sessionId: "sess-live-hydration",
      type: "sendText",
      payload: { text: "继续" },
      issuedAt: 1_700_000_999_000,
    });

    try {
      await nextMacrotask();
      expect(executeCommand).toHaveBeenCalledTimes(1);
      await expect(commanding).resolves.toMatchObject({ status: "accepted" });
      hydrationGate.resolve();
      await subscribing;
    } finally {
      hydrationGate.resolve();
      await Promise.allSettled([subscribing, commanding]);
      gateway.dispose();
    }
  });

  it("没有 cold READY 时 command 只由 inbox 解析一次", async () => {
    const executeCommand = vi.fn(async () => undefined);
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      emitWireFrame: () => {},
      executeCommand,
    });
    let sessionIdReads = 0;
    const command = {
      commandId: "cmd-without-cold-ready",
      clientId: "client-without-cold-ready",
      get sessionId() {
        sessionIdReads += 1;
        return "sess-without-cold-ready";
      },
      type: "sendText",
      payload: { text: "继续" },
      issuedAt: 1_700_000_999_000,
    };

    try {
      await expect(gateway.handleCommand(command)).resolves.toMatchObject({ status: "accepted" });
      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(sessionIdReads).toBe(1);
    } finally {
      gateway.dispose();
    }
  });

  it("record 已入册但冷恢复失败时：command 保留 lifecycle error，且绝不 admission", async () => {
    const host = makeColdHost();
    const resumeStarted = deferred();
    const resumeGate = deferred();
    const resumeError = new Error("resume storage failed");
    host.resumeImpl = async (sessionId) => {
      host.sessions.add(sessionId);
      resumeStarted.resolve();
      await resumeGate.promise;
      throw resumeError;
    };
    const admitCommandInput = vi.fn(async () => null);
    const executeCommand = vi.fn(async () => undefined);
    const gateway = new ConversationV4Gateway({
      sessionExists: (sessionId) => host.sessions.has(sessionId),
      resumePersistedSession: coldResumeHook(host),
      loadPersistedEvents: async () => ({ events: [], synthesized: true }),
      admitCommandInput,
      emitWireFrame: () => {},
      executeCommand,
    });

    const subscribing = gateway.subscribe(subscribeParams("sess-command-resume-failed"));
    await resumeStarted.promise;
    const commanding = gateway.handleCommand({
      commandId: "cmd-command-resume-failed",
      clientId: "client-command-resume-failed",
      sessionId: "sess-command-resume-failed",
      type: "sendText",
      payload: { text: "继续" },
      issuedAt: 1_700_000_999_000,
    });

    try {
      resumeGate.resolve();
      const [subscribeFailure, commandFailure] = await Promise.all([
        subscribing.catch((error: unknown) => error),
        commanding.catch((error: unknown) => error),
      ]);
      expect(subscribeFailure).toBeInstanceOf(V4SubscribeSessionUnavailableError);
      expect(commandFailure).toBe(subscribeFailure);
      expect((commandFailure as V4SubscribeSessionUnavailableError).reasonCode).toBe(
        "fault.subscribe.resumeFailed",
      );
      expect(host.sessions.has("sess-command-resume-failed")).toBe(true);
      expect(admitCommandInput).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      resumeGate.resolve();
      await Promise.allSettled([subscribing, commanding]);
      gateway.dispose();
    }
  });

  it("store 里也没有：fault.subscribe.sessionNotFound（结构化 reasonCode）", async () => {
    const host = makeColdHost();
    host.resumeImpl = async () => ({ status: "notFound" });
    const gateway = makeColdGateway(host);

    const failure = await gateway
      .subscribe(subscribeParams("sess-ghost"))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(V4SubscribeSessionUnavailableError);
    const typed = failure as V4SubscribeSessionUnavailableError;
    expect(typed.reasonCode).toBe("fault.subscribe.sessionNotFound");
    // renderer 订阅错误块直显 message → reasonCode 必须随文透出。
    expect(typed.message).toContain("fault.subscribe.sessionNotFound");
  });

  it("record 入册前恢复失败：保留原始 cause，并释放 rejected READY entry", async () => {
    const host = makeColdHost();
    host.resumeImpl = async () => {
      // 只代表 production 中 record 入册前的失败；入册后的 lifecycle 恢复不属于 READY 的职责。
      throw new Error("sqlite is on fire");
    };
    const gateway = makeColdGateway(host);

    const failure = await gateway
      .subscribe(subscribeParams("sess-cold"))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(V4SubscribeSessionUnavailableError);
    const typed = failure as V4SubscribeSessionUnavailableError;
    expect(typed.reasonCode).toBe("fault.subscribe.resumeFailed");
    expect(typed.message).toContain("sqlite is on fire");
    expect((typed.cause as Error).message).toBe("sqlite is on fire");
    expect(host.errors.some((entry) => entry.scope === "v4.subscribe.resume")).toBe(true);
    expect(host.resumeCalls).toEqual(["sess-cold"]);

    // 这里只证明 rejected READY promise 没被缓存；不宣称 record 入册后的 activation 可自动重试。
    host.resumeImpl = async (sessionId) => {
      host.sessions.add(sessionId);
      return { status: "resumed" };
    };
    const retried = await gateway.subscribe(subscribeParams("sess-cold"));
    expect(retried.initialFrame?.payload.kind).toBe("snapshot");
    expect(host.resumeCalls).toEqual(["sess-cold", "sess-cold"]);
  });

  it("宿主未实现钩子（旧宿主/测试桩）：维持 not active 拒绝且带 sessionNotFound", async () => {
    const host = makeColdHost();
    const gateway = makeColdGateway(host, { withResumeHook: false });
    await expect(gateway.subscribe(subscribeParams("sess-cold"))).rejects.toThrow(
      /not active.*fault\.subscribe\.sessionNotFound/,
    );
  });

  it("transcript 合成冷恢复：用 runtime usage seed 覆盖 0/20万占位 context meter", async () => {
    const host = makeColdHost();
    host.synthesizedSessions.add("sess-cold");
    host.persistedEvents.set("sess-cold", [
      makeEvent("sess-cold", 1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      makeEvent("sess-cold", 2, SessionEventType.ModelComplete, {
        content: "",
        contextWindow: 200_000,
        querySource: "main_turn",
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    ]);
    host.usageSeeds.set("sess-cold", {
      contextWindow: {
        usedTokens: 16_727,
        maxTokens: 1_000_000,
        autoCompactThresholdTokens: null,
        cache: {
          inputTokens: 16_638,
          cacheReadTokens: 1408,
          cacheWriteTokens: 0,
          latestHitRate: 0.08462555595624474,
          hitRate: 0.08462555595624474,
          hitRateRequestCount: 1,
          totalInputTokens: 16_638,
          totalCacheReadTokens: 1408,
          totalCacheWriteTokens: 0,
        },
        breakdown: [
          { source: "system_prompt", chars: 3236 },
          { source: "system_tool_schemas", chars: 57_600 },
        ],
      },
      cumulative: {
        inputTokens: 16_638,
        outputTokens: 89,
        cacheReadTokens: 1408,
        cacheWriteTokens: 0,
      },
    });
    const gateway = makeColdGateway(host);

    const result = await gateway.subscribe(subscribeParams("sess-cold"));
    if (result.initialFrame?.payload.kind !== "snapshot") {
      throw new Error("Expected snapshot initial frame");
    }

    expect(result.initialFrame.payload.snapshot.usage.contextWindow).toMatchObject({
      usedTokens: 16_727,
      maxTokens: 1_000_000,
      cache: { hitRate: 0.08462555595624474 },
      breakdown: [
        { source: "system_prompt", chars: 3236 },
        { source: "system_tool_schemas", chars: 57_600 },
      ],
    });
  });
});

// ── 集成层（真 sqlite store + ZCodeProtocolAgentServer + binder）─────────────

const WORKSPACE_PATH = "/workspace/cold-resume";
const workspace = { workspacePath: WORKSPACE_PATH, workspaceKey: WORKSPACE_PATH };
const REMOTE_WORKSPACE_IDENTITY =
  "remote:ssh:example.test:22:coder:/workspace/cold-resume" as WorkspaceId;
const remoteWorkspace = {
  workspaceIdentity: REMOTE_WORKSPACE_IDENTITY,
  workspaceKey: REMOTE_WORKSPACE_IDENTITY,
  workspacePath: WORKSPACE_PATH,
};
type TestSessionStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function takeInitialFrameParams(
  server: ZCodeProtocolAgentServer,
  requestId: string | number,
): unknown {
  const messages = server.takePostResponseMessages(requestId);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ method: V4_NOTIFICATIONS.conversationFrame });
  const wire = routedTopicWireFrameSchema.parse((messages[0] as { params: unknown }).params);
  if (wire.kind !== "complete") {
    throw new Error("cold-resume initial-frame adapter expected one complete physical wire");
  }
  return wire.frame;
}

async function saveUserTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  text: string,
  created: number,
) {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "zcode-agent",
    model: {
      providerID: "glm" as ModelProviderId,
      modelID: "glm-4-air" as ModelId,
    },
    tools: {},
  });
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

async function saveAssistantTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  parentMessageId: MessageId,
  text: string,
  created: number,
) {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created, completed: created },
    parentID: parentMessageId,
    providerID: "glm" as ModelProviderId,
    modelID: "glm-4-air" as ModelId,
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: WORKSPACE_PATH, root: WORKSPACE_PATH },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

/** 冷恢复集成用最小 fake app（子集自 zcode-protocol.test.ts createFakeApp）。 */
interface ColdFakeAppProbe {
  resumeGate?: Promise<void>;
  failResume?: boolean;
  closeCalls?: number;
  persistedMessagesReloadRequired?: boolean;
  readTodosCalls: number;
  resumeCalls: number;
  resumeEventTypes?: SessionEvent["type"][];
  resumePersistedMessagesProvided?: boolean[];
}

function createColdFakeApp(
  options: ZCodeAppOptions | undefined,
  sentInputs: Array<{ text: string }>,
  probe?: ColdFakeAppProbe,
): ZCodeApp {
  const sessionId = options?.sessionId ?? ("sess_cold" as SessionId);
  const traceId = options?.traceContext?.traceId ?? ("trace_cold" as never);
  let runtimeSink: { onSessionEvent(event: SessionEvent): Promise<void> | void } | undefined;
  let mode = options?.runtimeConfig?.mode ?? "build";
  let model = options?.runtimeConfig?.modelSelection
    ? `${options.runtimeConfig.modelSelection.providerId}/${options.runtimeConfig.modelSelection.modelId}`
    : "glm/glm-4.6";
  let thoughtLevel = options?.runtimeConfig?.modelSelection?.options?.reasoningLevel ?? "medium";
  const providerRegistry = options?.providerRegistry;
  const initialProviderId = options?.runtimeConfig?.modelSelection?.providerId ?? "glm";
  const initialModelId = options?.runtimeConfig?.modelSelection?.modelId ?? "glm-4.6";
  let runtimeContextWindow =
    options?.runtimeConfig?.contextWindow ??
    providerRegistry?.getModel(initialProviderId, initialModelId)?.config.properties
      ?.contextWindow ??
    128_000;
  const modelProperties = {
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
  } as const;
  const baseModels = [
    {
      ref: { providerId: "glm", modelId: "glm-4.6" },
      label: "GLM 4.6",
      providerLabel: "glm",
      properties: modelProperties,
    },
    {
      ref: { providerId: "glm", modelId: "glm-4-air" },
      label: "GLM 4 Air",
      providerLabel: "glm",
      properties: modelProperties,
    },
  ];
  let models = [...baseModels];

  return {
    clearTarget: async () => false,
    close: async () => {
      if (probe?.closeCalls !== undefined) probe.closeCalls += 1;
    },
    connectMcpServer: async () => {
      throw new Error("MCP is not available in fake app");
    },
    continueActiveTarget: async () => null,
    disconnectMcpServer: async () => undefined,
    forkFromCheckpoint: async () => {
      throw new Error("Fork is not available in fake app");
    },
    getDefaultThoughtLevel: () => "medium",
    getLocale: () => "en-US",
    getMode: () => mode,
    getModel: () => model,
    getTheme: () => "auto",
    getThoughtLevel: () => thoughtLevel,
    generateWorkspaceText: async () => {
      throw new Error("Workspace text generation is not available in fake app");
    },
    listCheckpoints: async () => [],
    listMcpServers: async () => ({}),
    listModels: () => models,
    getModelOption: (selection) =>
      providerRegistry && getRegistryBackedModel(providerRegistry, selection),
    listPlugins: async () => ({ loaded: [], failed: [] }) as never,
    listThoughtLevels: () => ["medium", "deep"],
    loadSessionTranscript: async () => [],
    readToolResultArtifact: async (uri) => ({
      bytes: 0,
      content: "",
      contentType: "text/plain",
      uri,
    }),
    readTodos: async () => {
      if (probe) probe.readTodosCalls += 1;
      return [];
    },
    readTarget: async () => null,
    recallPreviousInputHistory: async () => null,
    recordInputHistory: async () => null,
    resume: async (resumeOptions) => {
      if (probe) probe.resumeCalls += 1;
      await probe?.resumeGate;
      if (probe?.failResume) throw new Error("controlled resume failure");
      probe?.resumePersistedMessagesProvided?.push(resumeOptions?.persistedMessages !== undefined);
      for (const [index, type] of (probe?.resumeEventTypes ?? []).entries()) {
        const payload =
          type === SessionEventType.WorkspaceHookAdmissionUpdated ||
          type === SessionEventType.WorkspaceMcpAdmissionUpdated
            ? {
                pendingCount: 0,
                bundleDigest: "cold-resume-admission",
                workspaceIdentity: WORKSPACE_PATH,
              }
            : {
                hookEventName: "SessionStart",
                hookIndex: 0,
                hookRunId: `cold-resume-hook-${index + 1}`,
              };
        await runtimeSink?.onSessionEvent(makeEvent(String(sessionId), index + 1, type, payload));
      }
      return {
        directory: options?.runtimeConfig?.workingDirectory ?? WORKSPACE_PATH,
        interruptedToolCount: 0,
        messageCount: 0,
        partCount: 0,
        persistedMessagesReloadRequired: probe?.persistedMessagesReloadRequired ?? false,
        restoredMessages: [],
        traceId,
      };
    },
    runtime: {
      beginShutdown: () => undefined,
      // TTL pool 在 resident 未超水位时也要读取权威 idle facts；冷恢复 fake 必须和
      // 生产 runtime 一样显式声明没有前台或后台工作，不能再依赖旧容量分支短路。
      hasActiveOrQueuedTurnWork: () => false,
      hasRunningBackgroundTasks: () => false,
      hasResidencyBlockingWork: () => false,
      // 合并后 sendText 的 afterLegacyStateMutation 会经 auto-drain 读前台执行位；
      // 与上面同一条论证：fake 必须显式声明没有前台工作，而不是让属性缺席变成 TypeError。
      getActiveForegroundExecutionId: () => undefined,
      getSessionModelSelection: () => {
        const separator = model.indexOf("/");
        return {
          providerId: model.slice(0, separator),
          modelId: model.slice(separator + 1),
          ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
        };
      },
      getProjection: async () =>
        ({
          activeToolCalls: [],
          backgroundTasks: [],
          contextUsed: 0,
          contextWindow: runtimeContextWindow,
          createdAt: new Date(1),
          id: sessionId,
          mode,
          pendingPermissions: [],
          pendingSteerInputs: [],
          status: "idle",
          streamingToolLedger: [],
          target: null,
          totalTokenCount: 0,
          turnCount: 0,
          updatedAt: new Date(1),
        }) as never,
      getActiveTurnInfo: () => undefined,
      initializeSessionShellEnvironmentIfNeeded: () => false,
      subscribeEvents: (sink) => {
        runtimeSink = sink;
        return () => {};
      },
      updateConfig: (patch) => {
        if ("contextWindow" in patch) {
          runtimeContextWindow = patch.contextWindow ?? 0;
        }
      },
    } as never,
    sendInput: async (input, sendOptions) => {
      const text = (input as { text: string }).text;
      sentInputs.push({ text });
      const turnStarted = {
        ...makeEvent(String(sessionId), 0, SessionEventType.TurnStarted, {
          input: text,
          inputId: sendOptions?.inputId,
          turnNumber: 3,
        }),
        turnId: "turn-cold-send",
      } as SessionEvent;
      await runtimeSink?.onSessionEvent(turnStarted);
      sendOptions?.onTurnStartedObserved?.(turnStarted);
      return { kind: "accepted" } as never;
    },
    sessionId,
    setLocale: async (locale) => ({
      configPath: "/tmp/zcode/config.json",
      locale: locale === "zh-CN" ? "zh-CN" : "en-US",
      previousLocale: "en-US",
      requestedLocale: locale,
      traceId,
    }),
    setMode: async (nextMode) => {
      const previousMode = mode;
      mode = nextMode;
      return { mode, previousMode, traceId };
    },
    setPluginEnabled: async () => {
      throw new Error("Plugins are not available in fake app");
    },
    setTarget: async () => {
      throw new Error("Targets are not available in fake app");
    },
    setModel: async (nextModel) => {
      if (
        !models.some((option) => `${option.ref.providerId}/${option.ref.modelId}` === nextModel)
      ) {
        throw new Error(`Unsupported model in fake app: ${nextModel}`);
      }
      const previousModel = model;
      model = nextModel;
      return { model, previousModel, traceId };
    },
    setThoughtLevel: async (level) => {
      const previousThoughtLevel = thoughtLevel;
      thoughtLevel = level;
      return { previousThoughtLevel, thoughtLevel, traceId };
    },
    steerTurn: async () => ({ kind: "rejected", reason: "no_active_turn" }),
    submitPrompt: async () => {
      throw new Error("Prompt execution is not available in fake app");
    },
    traceId,
    updateTargetStatus: async () => null,
  } as ZCodeApp;
}

const SESSION_ID = "sess_cold_resume" as SessionId;
const PARENT_SESSION_ID = "sess_cold_parent" as SessionId;

function createColdProviderRegistry(): ProviderRegistry {
  const modelConfig = new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["medium", "deep"],
        map: '{"reasoning_effort":reasoningLevel}',
      },
      maxOutputTokens: {
        max: 32_000,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    }),
  });
  const provider: Provider = {
    providerId: "glm",
    config: createApiKeyProviderConfig({
      apiFormat: "openai-chat-completions",
      apiKey: "sk-test",
      baseURL: "https://api.example.test/v1",
      models: ["glm-4-air", "glm-4.6"],
    }),
    models: [
      { modelId: "glm-4-air", config: modelConfig },
      { modelId: "glm-4.6", config: modelConfig },
    ],
  };
  return new ProviderRegistry([provider]);
}

describe("v4 冷恢复（集成：真 sqlite + server + binder）", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-v4-cold-resume-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  /** 第一段人生：往 store 写入一段 user/assistant transcript 后关库（模拟 CLI 退出）。 */
  async function seedPersistedSession(
    dbPath: string,
    workspaceIdentity?: WorkspaceId,
    taskType:
      | "interactive"
      | "fork"
      | "subagent_child"
      | "workflow_child"
      | "nested_workflow_child"
      | "selection_side_chat" = "interactive",
  ): Promise<void> {
    const store = await createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: SESSION_ID,
        parentID: PARENT_SESSION_ID,
        taskType,
        projectID: "project_cold_resume" as ProjectId,
        ...(workspaceIdentity ? { workspaceID: workspaceIdentity } : {}),
        slug: "cold-resume-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Cold resume session",
        version: "test-version",
        time: { created: 1, updated: 4 },
      });
      await saveUserTextMessage(store, SESSION_ID, "msg_cold_user_1" as MessageId, "历史问题一", 1);
      await saveAssistantTextMessage(
        store,
        SESSION_ID,
        "msg_cold_assistant_1" as MessageId,
        "msg_cold_user_1" as MessageId,
        "历史回答一",
        2,
      );
      await saveUserTextMessage(store, SESSION_ID, "msg_cold_user_2" as MessageId, "历史问题二", 3);
      await saveAssistantTextMessage(
        store,
        SESSION_ID,
        "msg_cold_assistant_2" as MessageId,
        "msg_cold_user_2" as MessageId,
        "历史回答二",
        4,
      );
      await store.savePart({
        id: "msg_cold_assistant_2_reasoning" as MessagePart["id"],
        sessionID: SESSION_ID,
        messageID: "msg_cold_assistant_2" as MessageId,
        type: "reasoning",
        text: "历史思考二",
        time: { start: 4, end: 4 },
      });
      await store.savePart({
        id: "msg_cold_assistant_2_tool" as MessagePart["id"],
        sessionID: SESSION_ID,
        messageID: "msg_cold_assistant_2" as MessageId,
        type: "tool",
        callID: "call_cold_read",
        tool: "Read",
        state: {
          status: "completed",
          input: { file_path: "README.md" },
          output: "历史工具输出",
          title: "Read README.md",
          metadata: {},
          time: { start: 4, end: 4 },
        },
      });
    } finally {
      store.close();
    }
  }

  async function seedPersistedCompactedSession(dbPath: string): Promise<void> {
    await seedPersistedSession(dbPath);
    const store = await createSqliteSessionStore({ dbPath });
    const summaryMessageId = "msg_cold_compact_summary" as MessageId;
    const compactBoundary: CompactBoundaryPayload = {
      boundaryId: "boundary_cold_compact",
      trigger: CompactTrigger.Manual,
      preCompactTokenCount: 2,
      postCompactTokenCount: 2,
      truePostCompactTokenCount: 1,
      summarizedMessageCount: 4,
      summaryMessageIds: [summaryMessageId],
      traceId: "trace_cold_compact" as TraceId,
    };
    try {
      await store.saveMessage({
        id: summaryMessageId,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: 5 },
        summary: { title: "Compact summary", body: "压缩后的摘要", diffs: [] },
        agent: "zcode-agent",
        model: {
          providerID: "glm" as ModelProviderId,
          modelID: "glm-4-air" as ModelId,
        },
        tools: {},
      });
      await store.savePart({
        id: "part_cold_compact_boundary" as MessagePart["id"],
        sessionID: SESSION_ID,
        messageID: summaryMessageId,
        type: "compaction",
        auto: false,
        compactBoundary,
      });
    } finally {
      store.close();
    }
  }

  /** 第二段人生：同一 db 文件重开 → 新 server（内存注册表为空 = CLI 重启）。 */
  async function bootRestartedServer(
    dbPath: string,
    sentInputs: Array<{ text: string }>,
    probe?: ColdFakeAppProbe,
    createdAppOptions: ZCodeAppOptions[] = [],
  ) {
    const store = await createSqliteSessionStore({ dbPath });
    const providerRegistry = createColdProviderRegistry();
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        const effectiveOptions = { ...options, providerRegistry };
        createdAppOptions.push(effectiveOptions);
        return createColdFakeApp(effectiveOptions, sentInputs, probe);
      },
      cwd: WORKSPACE_PATH,
      sessionStore: store,
    });
    return { server, store };
  }

  it.each(["restart", "ensureReady"] as const)(
    "冷打开的启动读取未返回时 %s 共享生命周期并最终完成",
    async (operation) => {
      const dbPath = join(tempRoot, `opening-${operation}.db`);
      await seedPersistedSession(dbPath);
      const created: ZCodeAppOptions[] = [];
      const probe = { closeCalls: 0 };
      const { server, store } = await bootRestartedServer(dbPath, [], probe, created);
      const entered = deferred();
      const release = deferred();
      let completed = false;
      let response: unknown;
      try {
        await requestResult(server, {
          id: "opening",
          method: V4_METHODS.conversationSubscribe,
          params: { ...subscribeParams(SESSION_ID), historyFirst: true },
        });
        // 历史已准备，下一次 getSession 是启动信息读取；barrier 不阻塞后续查询。
        const getSession = store.getSession.bind(store);
        vi.spyOn(store, "getSession").mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          return getSession(id);
        });
        const frame = conversationTopicFrameSchema.parse(takeInitialFrameParams(server, "opening"));
        if (frame.payload.kind !== "snapshot") throw new Error("Expected history snapshot");
        expect(frame.payload.snapshot.runtimeInitialization?.status).toBe("initializing");
        expect(JSON.stringify(frame.payload.snapshot)).toContain("历史问题一");
        await entered.promise;
        expect(created).toHaveLength(0);
        const pending = server
          .handleMessage({
            id: "lifecycle",
            method:
              operation === "restart"
                ? zcodeProtocolMethods.sessionLifecycleRestart
                : zcodeProtocolMethods.sessionLifecycleEnsureReady,
            params: { sessionId: SESSION_ID },
          })
          .then((value) => {
            response = value;
            completed = true;
          });
        // 确保生命周期请求已登记，不能靠调度速度碰巧避开读取窗口。
        await requestResult(server, {
          id: "observing",
          method: zcodeProtocolMethods.sessionLifecycleGetState,
          params: { sessionId: SESSION_ID },
        });
        release.resolve();
        await vi.waitFor(() => expect(completed).toBe(true), { timeout: 2000 });
        await pending;
        expect(response).toMatchObject({ result: { completed: true } });
        expect(created).toHaveLength(operation === "restart" ? 2 : 1);
        expect(probe.closeCalls).toBe(operation === "restart" ? 1 : 0);
        expect(
          await requestResult(server, {
            id: "ready",
            method: zcodeProtocolMethods.sessionLifecycleGetState,
            params: { sessionId: SESSION_ID },
          }),
        ).toMatchObject({ state: "ready" });
      } finally {
        release.resolve();
        // 失败探针也必须能退出；不能在被测等待环里再等待 shutdown。
        if (completed) await server.shutdown();
        server.disposeProjections();
        store.close();
      }
    },
  );

  it("已有历史首帧尚未提交时 ensureReady 复用历史并完成实例启动", async () => {
    const dbPath = join(tempRoot, "history-before-activation.db");
    await seedPersistedSession(dbPath);
    const created: ZCodeAppOptions[] = [];
    const { server, store } = await bootRestartedServer(dbPath, [], undefined, created);
    let completed = false;
    try {
      await requestResult(server, {
        id: "history-only",
        method: V4_METHODS.conversationSubscribe,
        params: { ...subscribeParams(SESSION_ID), historyFirst: true },
      });
      expect(created).toHaveLength(0);
      const pending = requestResult(server, {
        id: "ensure-existing-history",
        method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
        params: { sessionId: SESSION_ID },
      }).then((result) => {
        completed = true;
        return result;
      });
      void pending.catch(() => undefined);
      takeInitialFrameParams(server, "history-only");
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 2000 });
      expect(await pending).toEqual({ completed: true });
      expect(created).toHaveLength(1);
    } finally {
      if (completed) await server.shutdown();
      server.disposeProjections();
      store.close();
    }
  });

  // 模型恢复须走真实 App，不能让生命周期测试替身复制生产迁移逻辑。
  function prepareLegacySelectionUpgrade(dbPath: string) {
    // 旧格式 fixture 必须走首次升级；新版 Reader 不再通过读取消息隐式补迁会话选择。
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "DELETE FROM schema_migration WHERE id IN ('0020_provider_model_selection','0021_official_glm_selection','0022_backfilled_session_reasoning')",
      );
    } finally {
      db.close();
    }
  }

  async function bootRealRestartedServer(dbPath: string, registry = createColdProviderRegistry()) {
    const store = await createSqliteSessionStore({ dbPath });
    const apps: ZCodeApp[] = [];
    const server = new ZCodeProtocolAgentServer({
      cwd: process.cwd(),
      sessionStore: store,
      createZCodeApp: async (options) => {
        const app = await createRegistryBackedTestApp({
          ...options,
          env: {},
          skipUserConfig: true,
          providerRegistry: registry,
        });
        apps.push(app);
        return app;
      },
    });
    server.setNotificationSink((message) => {
      if (!("id" in message)) return;
      if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
        void server.handleMessage({
          id: message.id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
          },
        });
      }
    });
    return {
      server,
      apps,
      close: async () => {
        for (const app of apps) await app.close();
        store.close();
      },
    };
  }

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "%s fork 回滚后的独立会话可通过真实协议冷订阅",
    async (clientMode) => {
      const dbPath = join(tempRoot, `fork-isolation-${clientMode}.db`);
      const store = await createSqliteSessionStore({ dbPath, forkCommitFaultAt: "beforeCommit" });
      try {
        const results = await seedFailedForkRace(store, WORKSPACE_PATH);
        expect(results[0]?.status).toBe("rejected");
        expect(results.slice(1).map((result) => result.status)).toEqual(Array(4).fill("fulfilled"));
      } finally {
        store.close();
      }
      const { server, close } = await bootRealRestartedServer(dbPath);
      try {
        await requestResult(server, {
          id: "fork-isolation",
          method: V4_METHODS.conversationSubscribe,
          params: { topic: conversationTopic(SURVIVOR_ID), connectionId: clientMode, clientMode },
        });
        const frame = conversationTopicFrameSchema.parse(
          takeInitialFrameParams(server, "fork-isolation"),
        );
        if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot");
        expect(
          frame.payload.snapshot.rows.window.some(
            (row) => row.kind === "userInput" && row.text === HISTORY_MARKER,
          ),
        ).toBe(true);
      } finally {
        await server.shutdown();
        server.disposeProjections();
        await close();
      }
    },
  );

  it("cold rename/delete persist before acknowledgement and duplicate delete does not resume again", async () => {
    const dbPath = join(tempRoot, "metadata.db");
    await seedPersistedSession(dbPath);
    const { server, apps, close } = await bootRealRestartedServer(dbPath);
    const command = (
      commandId: string,
      type: "renameSession" | "deleteSession",
      payload: object,
    ) => ({
      commandId,
      clientId: "metadata-test",
      sessionId: SESSION_ID,
      type,
      payload,
      issuedAt: 100,
    });
    try {
      const rename = await requestResult(server, {
        id: "rename",
        method: V4_METHODS.command,
        params: command("rename-1", "renameSession", { title: "Renamed offline" }),
      });
      expect(rename).toMatchObject({ status: "accepted" });
      const check = await createSqliteSessionStore({ dbPath });
      try {
        expect(await check.getSession(SESSION_ID)).toMatchObject({
          title: "Renamed offline",
          titleSource: "custom",
        });
        const source = { identity: "shared-mcp", generation: 1 };
        const binding = {
          workspace: "/workspace",
          sessionId: SESSION_ID,
          pluginId: "p",
          serverName: "plugin:example-plugin:widget",
          scopeId: "panel",
          resourceUri: "ui://app",
          ownerWebContentsId: 1,
        };
        const instance = mcpUiInstances.open(binding, source);
        const other = mcpUiInstances.open({ ...binding, sessionId: "another-session" }, source);
        const access = createExampleSessionAccess();
        const executing = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<{ content: [] }>();
        let signal: AbortSignal | undefined;
        access.callTool = async (_server, _tool, _args, options) => {
          signal = options?.signal;
          executing.resolve();
          return finish.promise;
        };
        const pending = createMcpUiHandlers().callTool(access, {
          ...binding,
          instance,
          callId: "draft-call",
          toolName: "ping",
        });
        const rejected = expect(pending).rejects.toThrow();
        await executing.promise;
        const deletion = command("delete-1", "deleteSession", {});
        // 两个 server 分别停在退订中；删除不能提前释放 pool lease。
        const nextServer = Promise.withResolvers<void>();
        const lastServer = Promise.withResolvers<void>();
        const order: string[] = [];
        const unsubscribe = vi
          .spyOn(apps[0], "unsubscribeMcpResourcesForUi")
          .mockImplementation(async (prefix) => {
            expect(prefix).toBe(`${SESSION_ID}|`);
            order.push("server-a");
            await nextServer.promise;
            order.push("server-b");
            await lastServer.promise;
            order.push("unsubscribed");
            return 2;
          });
        const closeApp = vi.spyOn(apps[0], "close");
        const deleting = requestResult(server, {
          id: "delete",
          method: V4_METHODS.command,
          params: deletion,
        });
        try {
          await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
          expect(closeApp).not.toHaveBeenCalled();
          nextServer.resolve();
          await vi.waitFor(() => expect(order).toEqual(["server-a", "server-b"]));
          expect(closeApp).not.toHaveBeenCalled();
        } finally {
          nextServer.resolve();
          lastServer.resolve();
        }
        const deleteAck = await deleting;
        expect(order).toEqual(["server-a", "server-b", "unsubscribed"]);
        expect(closeApp).toHaveBeenCalledTimes(1);
        expect(deleteAck, JSON.stringify(deleteAck)).toMatchObject({ status: "accepted" });
        expect((await check.getSession(SESSION_ID))?.time.deleted).toBeTypeOf("number");
        // 共享连接仍存活时，删除只撤销本 session 的 token 与调用。
        finish.resolve({ content: [] });
        await rejected;
        expect(signal?.aborted).toBe(true);
        expect(mcpUiInstances.find(instance.token)).toBeUndefined();
        expect(mcpUiInstances.find(other.token)).toBeDefined();
        mcpUiInstances.close(other);
        expect(
          await requestResult(server, {
            id: "retry",
            method: V4_METHODS.command,
            params: deletion,
          }),
        ).toMatchObject({ status: "duplicate" });
      } finally {
        check.close();
      }
    } finally {
      await close();
    }
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "Todo123: %s 缺档位旧选择仍按 Registry 展示 1M，执行选择不被补齐",
    async (clientMode) => {
      const dbPath = join(tempRoot, "missing-reasoning.db");
      await seedPersistedSession(dbPath);
      const store = await createSqliteSessionStore({ dbPath });
      const selection = { providerId: "glm", modelId: "glm-4-air" };
      await store.saveSessionEntry({
        id: "entry_missing_reasoning",
        sessionID: SESSION_ID,
        type: SESSION_ENTRY_MODEL_SELECTION,
        data: selection,
        time: { created: 5, updated: 5 },
      });
      store.close();
      const { server, apps, close } = await bootRealRestartedServer(dbPath);
      try {
        await requestResult(server, {
          id: "missing-reasoning",
          method: V4_METHODS.conversationSubscribe,
          params: { topic: conversationTopic(SESSION_ID), connectionId: clientMode, clientMode },
        });
        const frame = conversationTopicFrameSchema.parse(
          takeInitialFrameParams(server, "missing-reasoning"),
        );
        if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot");
        expect(frame.payload.snapshot.config.modelSelection).toEqual(selection);
        expect(frame.payload.snapshot.usage.contextWindow).toMatchObject({
          usedTokens: 2,
          maxTokens: 1_000_000,
        });
        expect(apps[0].runtime.getSessionModelSelection()).toBeUndefined();
        expect(
          frame.payload.snapshot.rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "历史回答二",
          ),
        ).toBe(true);
      } finally {
        await close();
      }
    },
  );

  it("Todo123: 无对应 Registry 模型仍可冷读内容，容量未知而非 20 万", async () => {
    const dbPath = join(tempRoot, "unknown-model.db");
    await seedPersistedSession(dbPath);
    const { server, close } = await bootRealRestartedServer(dbPath, new ProviderRegistry([]));
    try {
      await requestResult(server, {
        id: "unknown-model",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "unknown",
          clientMode: "desktop-continuous",
        },
      });
      const frame = conversationTopicFrameSchema.parse(
        takeInitialFrameParams(server, "unknown-model"),
      );
      if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot");
      expect(frame.payload.snapshot.usage.contextWindow).toBeNull();
      expect(
        frame.payload.snapshot.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === "历史回答二",
        ),
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it("rowsRange-first 与 subscribe 并发时只按 Host 当前设置冷恢复一次", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const createdAppOptions: ZCodeAppOptions[] = [];
    const { server, store } = await bootRestartedServer(dbPath, [], undefined, createdAppOptions);
    let pendingPreferenceRequestId: string | number | undefined;
    let markPreferenceRequested: (() => void) | undefined;
    const preferenceRequested = new Promise<void>((resolve) => {
      markPreferenceRequested = resolve;
    });
    const preferenceRequests: ZCodeProtocolMessage[] = [];
    server.setNotificationSink((message) => {
      if (
        "id" in message &&
        message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
      ) {
        preferenceRequests.push(message);
        pendingPreferenceRequestId = message.id;
        markPreferenceRequested?.();
      }
    });

    try {
      const rowsPromise = requestResult(server, {
        id: 2,
        method: V4_METHODS.conversationRowsRange,
        params: { sessionId: SESSION_ID, limit: 20 },
      });
      await preferenceRequested;
      const subscribePromise = requestResult(server, {
        id: 3,
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-query-first",
          clientMode: "desktop-continuous",
          additionalDirectories: ["/late-must-not-replace"],
        },
      });
      await server.handleMessage({
        id: pendingPreferenceRequestId!,
        result: {
          additionalDirectories: ["/work/backend"],
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
        },
      });

      const [rows] = await Promise.all([rowsPromise, subscribePromise]);
      expect(v4ConversationRowsRangeResultSchema.parse(rows).rows).not.toHaveLength(0);
      expect(preferenceRequests).toHaveLength(1);
      expect(preferenceRequests[0]).toMatchObject({
        params: { sessionId: SESSION_ID, scope: "runtime-materialization" },
      });
      const resumedRuntimeOptions = createdAppOptions.filter(
        (options) => options.sessionId === SESSION_ID,
      );
      expect(resumedRuntimeOptions).toHaveLength(1);
      expect(resumedRuntimeOptions[0]?.additionalDirectories).toEqual(["/work/backend"]);
      expect(resumedRuntimeOptions[0]?.runtimeConfig?.nativeSearchEnhancementsEnabled).toBe(false);
      expect(resumedRuntimeOptions[0]?.runtimeConfig?.memory?.enabled).toBe(false);
    } finally {
      store.close();
    }
  });

  it.each(["direct", "resolved"] as const)(
    "带 workspace 的恢复入口兼容旧 WSL %s 记录并拒绝其他用户",
    async (shape) => {
      const path = "/home/dev/project";
      const identity = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
      const target = { workspacePath: path, workspaceKey: identity, workspaceIdentity: identity };
      const legacy = shape === "direct" ? identity : `${path}/${identity}`;
      const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "wsl.db") });
      const apps: string[] = [];
      const server = new ZCodeProtocolAgentServer({
        cwd: path,
        sessionStore: store,
        createZCodeApp: (options) => {
          apps.push(options?.runtimeConfig?.workingDirectory ?? "");
          return createColdFakeApp(options, []);
        },
      });
      try {
        for (const method of [
          zcodeProtocolMethods.sessionResume,
          zcodeProtocolMethods.sessionLifecycleEnsureReady,
          zcodeProtocolMethods.sessionLifecycleRestart,
          V4_METHODS.conversationSubscribe,
        ]) {
          const id = `sess_legacy_${method.replaceAll("/", "_")}` as SessionId;
          await store.createSession({
            id,
            projectID: "legacy" as ProjectId,
            slug: id,
            directory: legacy,
            path: legacy,
            title: "Legacy",
            version: "3.4.2",
            time: { created: 1, updated: 2 },
          });
          const params =
            method === V4_METHODS.conversationSubscribe
              ? {
                  topic: conversationTopic(id),
                  connectionId: id,
                  clientMode: "desktop-continuous",
                  workspace: target,
                }
              : { sessionId: id, workspace: target };
          const wrongIdentity = "remote:wsl:Debian:other:/home/dev/project";
          const response = await server.handleMessage({
            id: `${id}-wrong`,
            method,
            params: {
              ...params,
              workspace: {
                ...target,
                workspaceKey: wrongIdentity,
                workspaceIdentity: wrongIdentity,
              },
            },
          });
          expect(response).toHaveProperty("error");
          expect(await store.getSession(id)).toMatchObject({
            path: legacy,
            workspaceID: undefined,
          });
          await requestResult(server, { id, method, params });
          expect(await store.getSession(id)).toMatchObject({
            path,
            directory: path,
            workspaceID: identity,
          });
        }
        expect(apps).toEqual([path, path, path, path]);
      } finally {
        store.close();
      }
    },
  );

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "V4 %s 冷恢复登记 workspace 后才进入启动，拒绝冲突加入",
    async (clientMode) => {
      const dbPath = join(tempRoot, "flight.db");
      await seedPersistedSession(dbPath);
      const store = await createSqliteSessionStore({ dbPath });
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let activated = 0;
      const server = new ZCodeProtocolAgentServer({
        cwd: WORKSPACE_PATH,
        sessionStore: store,
        createZCodeApp: async (options) => {
          activated++;
          entered.resolve();
          await gate.promise;
          return createColdFakeApp(options, []);
        },
      });
      const subscribe = requestResult(server, {
        id: "cold",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "cold",
          clientMode,
          workspace,
        },
      });
      try {
        await entered.promise;
        for (const method of [
          zcodeProtocolMethods.sessionLifecycleEnsureReady,
          zcodeProtocolMethods.sessionLifecycleRestart,
          zcodeProtocolMethods.sessionResume,
        ]) {
          const response = await server.handleMessage({
            id: method,
            method,
            params: {
              sessionId: SESSION_ID,
              workspace: { workspacePath: "/wrong", workspaceKey: "/wrong" },
            },
          });
          expect(response).toHaveProperty("error");
        }
        const joined = requestResult(server, {
          id: "same",
          method: zcodeProtocolMethods.sessionLifecycleEnsureReady,
          params: { sessionId: SESSION_ID, workspace },
        });
        gate.resolve();
        await Promise.all([subscribe, joined]);
        expect(activated).toBe(1);
      } finally {
        gate.resolve();
        await subscribe.catch(() => {});
        store.close();
      }
    },
  );

  it("冷恢复 3.4.2 遗留的 WSL 显式用户任务时修复真实工作目录", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const legacySessionId = "sess_wsl_explicit_user_legacy" as SessionId;
    const unrelatedSessionId = "sess_wsl_explicit_user_unrelated" as SessionId;
    const workspacePath = "/home/dev/coding/DEMO-ERP-NEW";
    const workspaceIdentity =
      "remote:wsl:Ubuntu-24.04:dev:/home/dev/coding/DEMO-ERP-NEW" as WorkspaceId;
    const unrelatedWorkspaceIdentity =
      "remote:wsl:Ubuntu-24.04:other:/home/dev/coding/DEMO-ERP-NEW" as WorkspaceId;
    const seedStore = await createSqliteSessionStore({ dbPath });
    try {
      await seedStore.createSession({
        id: legacySessionId,
        projectID: "project_wsl_explicit_user_legacy" as ProjectId,
        slug: "wsl-explicit-user-legacy",
        directory: workspaceIdentity,
        path: workspaceIdentity,
        title: "WSL legacy task",
        version: "3.4.2",
        time: { created: 1, updated: 2 },
      });
      await seedStore.createSession({
        id: unrelatedSessionId,
        projectID: "project_wsl_explicit_user_unrelated" as ProjectId,
        slug: "wsl-explicit-user-unrelated",
        directory: unrelatedWorkspaceIdentity,
        path: unrelatedWorkspaceIdentity,
        title: "Unrelated WSL legacy task",
        version: "3.4.2",
        time: { created: 3, updated: 4 },
      });
    } finally {
      seedStore.close();
    }

    const store = await createSqliteSessionStore({ dbPath });
    const resumedWorkingDirectories: string[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        resumedWorkingDirectories.push(options?.runtimeConfig?.workingDirectory ?? "");
        return createColdFakeApp(options, []);
      },
      cwd: workspacePath,
      sessionStore: store,
    });
    try {
      await requestResult(server, {
        id: "wsl-legacy-resume",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(legacySessionId),
          connectionId: "conn-wsl-legacy-resume",
          clientMode: "desktop-continuous",
        },
      });

      expect(resumedWorkingDirectories).toEqual([workspacePath]);
      await expect(store.getSession(legacySessionId)).resolves.toMatchObject({
        directory: workspacePath,
        path: workspacePath,
        workspaceID: workspaceIdentity,
      });
      await expect(store.getSession(unrelatedSessionId)).resolves.toMatchObject({
        directory: unrelatedWorkspaceIdentity,
        path: unrelatedWorkspaceIdentity,
        workspaceID: undefined,
      });
    } finally {
      store.close();
    }
  });

  it("冷恢复被 path.resolve 拼接过 remote identity 的 3.4.2 WSL 任务", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const legacySessionId = "sess_wsl_resolved_identity_legacy" as SessionId;
    const workspacePath = "/home/dev/coding/DEMO-ERP-NEW";
    const workspaceIdentity =
      "remote:wsl:Ubuntu-24.04:dev:/home/dev/coding/DEMO-ERP-NEW" as WorkspaceId;
    const resolvedLegacyDirectory = `${workspacePath}/${workspaceIdentity}`;
    const seedStore = await createSqliteSessionStore({ dbPath });
    try {
      await seedStore.createSession({
        id: legacySessionId,
        projectID: "project_wsl_resolved_identity_legacy" as ProjectId,
        slug: "wsl-resolved-identity-legacy",
        directory: resolvedLegacyDirectory,
        path: resolvedLegacyDirectory,
        title: "WSL resolved identity legacy task",
        version: "3.4.2",
        time: { created: 1, updated: 2 },
      });
    } finally {
      seedStore.close();
    }

    const store = await createSqliteSessionStore({ dbPath });
    const resumedWorkingDirectories: string[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        resumedWorkingDirectories.push(options?.runtimeConfig?.workingDirectory ?? "");
        return createColdFakeApp(options, []);
      },
      cwd: workspacePath,
      sessionStore: store,
    });
    try {
      await requestResult(server, {
        id: "wsl-resolved-legacy-resume",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(legacySessionId),
          connectionId: "conn-wsl-resolved-legacy-resume",
          clientMode: "desktop-continuous",
        },
      });

      expect(resumedWorkingDirectories).toEqual([workspacePath]);
      await expect(store.getSession(legacySessionId)).resolves.toMatchObject({
        directory: workspacePath,
        path: workspacePath,
        workspaceID: workspaceIdentity,
      });
    } finally {
      store.close();
    }
  });

  it("NULL identity 原子修复未命中且重读仍污染时禁止物化 runtime", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const sessionId = "sess_wsl_failed_atomic_repair" as SessionId;
    const workspacePath = "/home/dev/project";
    const workspaceIdentity = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
    const store = await createSqliteSessionStore({ dbPath });
    await store.createSession({
      id: sessionId,
      projectID: "project_wsl_failed_atomic_repair" as ProjectId,
      slug: "wsl-failed-atomic-repair",
      directory: workspaceIdentity,
      path: workspaceIdentity,
      title: "WSL failed atomic repair",
      version: "3.4.2",
      time: { created: 1, updated: 2 },
    });
    store.repairLegacyRemoteSessionWorkspace = vi.fn(async () => false);
    const resumedWorkingDirectories: string[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        resumedWorkingDirectories.push(options?.runtimeConfig?.workingDirectory ?? "");
        return createColdFakeApp(options, []);
      },
      cwd: workspacePath,
      sessionStore: store,
    });
    try {
      const response = await server.handleMessage({
        id: "wsl-failed-atomic-repair",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(sessionId),
          connectionId: "conn-wsl-failed-atomic-repair",
          clientMode: "desktop-continuous",
        },
      });

      expect(response).toMatchObject({
        error: { message: expect.stringContaining("workspace repair") },
      });
      expect(resumedWorkingDirectories).toEqual([]);
      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        directory: workspaceIdentity,
        path: workspaceIdentity,
        workspaceID: undefined,
      });
    } finally {
      store.close();
    }
  });

  it("NULL identity 原子修复返回未命中但并发请求已完整修复时继续恢复", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const sessionId = "sess_wsl_concurrent_atomic_repair" as SessionId;
    const workspacePath = "/home/dev/project";
    const workspaceIdentity = "remote:wsl:Debian:dev:/home/dev/project" as WorkspaceId;
    const store = await createSqliteSessionStore({ dbPath });
    await store.createSession({
      id: sessionId,
      projectID: "project_wsl_concurrent_atomic_repair" as ProjectId,
      slug: "wsl-concurrent-atomic-repair",
      directory: workspaceIdentity,
      path: workspaceIdentity,
      title: "WSL concurrent atomic repair",
      version: "3.4.2",
      time: { created: 1, updated: 2 },
    });
    const persistRepair = store.repairLegacyRemoteSessionWorkspace.bind(store);
    store.repairLegacyRemoteSessionWorkspace = vi.fn(async (input) => {
      await persistRepair(input);
      return false;
    });
    const resumedWorkingDirectories: string[] = [];
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        resumedWorkingDirectories.push(options?.runtimeConfig?.workingDirectory ?? "");
        return createColdFakeApp(options, []);
      },
      cwd: workspacePath,
      sessionStore: store,
    });
    try {
      await requestResult(server, {
        id: "wsl-concurrent-atomic-repair",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(sessionId),
          connectionId: "conn-wsl-concurrent-atomic-repair",
          clientMode: "desktop-continuous",
        },
      });

      expect(resumedWorkingDirectories).toEqual([workspacePath]);
      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        directory: workspacePath,
        path: workspacePath,
        workspaceID: workspaceIdentity,
      });
    } finally {
      store.close();
    }
  });

  it("SSH 冷订阅 sessions-index：只迁移 task-index allowlist 证明归属的 3.3.6 历史会话", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const seedStore = await createSqliteSessionStore({ dbPath });
    const currentSessionId = "sess_current_remote_index" as SessionId;
    const foreignSessionId = "sess_foreign_remote_index" as SessionId;
    const unprovenLegacySessionId = "sess_unproven_legacy_remote_index" as SessionId;
    const remoteWorkspaceIdentity = "remote:ssh:example.test:22:coder:/workspace/cold-resume";
    const foreignWorkspaceIdentity =
      "remote:ssh:other.example.test:22:coder:/workspace/cold-resume";
    try {
      await seedStore.createSession({
        id: SESSION_ID,
        projectID: "project_remote_index" as ProjectId,
        slug: "remote-index-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Remote index session",
        version: "test-version",
        time: { created: 1, updated: 2 },
      });
      await seedStore.createSession({
        id: currentSessionId,
        projectID: "project_current_remote_index" as ProjectId,
        workspaceID: remoteWorkspaceIdentity as WorkspaceId,
        slug: "current-remote-index-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Current remote index session",
        version: "test-version",
        time: { created: 3, updated: 4 },
      });
      await seedStore.createSession({
        id: unprovenLegacySessionId,
        projectID: "project_unproven_legacy_remote_index" as ProjectId,
        slug: "unproven-legacy-remote-index-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Unproven legacy remote index session",
        version: "test-version",
        time: { created: 4, updated: 5 },
      });
      await seedStore.createSession({
        id: foreignSessionId,
        projectID: "project_foreign_remote_index" as ProjectId,
        workspaceID: foreignWorkspaceIdentity as WorkspaceId,
        slug: "foreign-remote-index-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Foreign remote index session",
        version: "test-version",
        time: { created: 5, updated: 6 },
      });
    } finally {
      seedStore.close();
    }

    const { server, store } = await bootRestartedServer(dbPath, []);
    try {
      await requestResult(server, {
        id: "remote-index",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: sessionsIndexTopic(remoteWorkspaceIdentity),
          connectionId: "conn-remote-index",
          clientMode: "desktop-continuous",
          legacyTaskIds: [SESSION_ID],
        },
      });
      const frame = sessionsIndexTopicFrameSchema.parse(
        takeInitialFrameParams(server, "remote-index"),
      );
      if (frame.payload.kind !== "snapshot") {
        throw new Error("Expected sessions-index snapshot frame");
      }
      expect(frame.payload.snapshot.workspaceId).toBe(remoteWorkspaceIdentity);
      expect(frame.payload.snapshot.sessions).toEqual([
        expect.objectContaining({
          sessionId: currentSessionId,
          workspaceId: remoteWorkspaceIdentity,
          title: "Current remote index session",
        }),
        expect.objectContaining({
          sessionId: SESSION_ID,
          workspaceId: remoteWorkspaceIdentity,
          title: "Remote index session",
        }),
      ]);
      await expect(store.getSession(SESSION_ID)).resolves.toMatchObject({
        workspaceID: remoteWorkspaceIdentity,
      });
      expect((await store.getSession(unprovenLegacySessionId))?.workspaceID).toBeUndefined();
      await expect(store.getSession(foreignSessionId)).resolves.toMatchObject({
        workspaceID: foreignWorkspaceIdentity,
      });

      // 未被当前 identity 的 task index 证明归属的空 identity 会话不得迁移；
      // 同一���据库里的本地路径订阅仍只能看到这条未归属记录。
      await requestResult(server, {
        id: "local-index-after-remote",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: sessionsIndexTopic(WORKSPACE_PATH),
          connectionId: "conn-local-index-after-remote",
          clientMode: "desktop-continuous",
        },
      });
      const localFrame = sessionsIndexTopicFrameSchema.parse(
        takeInitialFrameParams(server, "local-index-after-remote"),
      );
      if (localFrame.payload.kind !== "snapshot") {
        throw new Error("Expected local sessions-index snapshot frame");
      }
      expect(localFrame.payload.snapshot.sessions).toEqual([
        expect.objectContaining({ sessionId: unprovenLegacySessionId }),
      ]);
    } finally {
      store.close();
    }
  });

  it("本地路径冷订阅 sessions-index：保持原目录查询语义", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const seedStore = await createSqliteSessionStore({ dbPath });
    const remoteSessionId = "sess_remote_same_path" as SessionId;
    try {
      await seedStore.createSession({
        id: SESSION_ID,
        projectID: "project_local_index" as ProjectId,
        slug: "local-index-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Local index session",
        version: "test-version",
        time: { created: 1, updated: 2 },
      });
      await seedStore.createSession({
        id: remoteSessionId,
        projectID: "project_remote_same_path" as ProjectId,
        workspaceID: "remote:ssh:example.test:22:coder:/workspace/cold-resume" as WorkspaceId,
        slug: "remote-same-path-session",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Remote same path session",
        version: "test-version",
        time: { created: 3, updated: 4 },
      });
    } finally {
      seedStore.close();
    }

    const { server, store } = await bootRestartedServer(dbPath, []);
    try {
      await requestResult(server, {
        id: "local-index",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: sessionsIndexTopic(WORKSPACE_PATH),
          connectionId: "conn-local-index",
          clientMode: "desktop-continuous",
          // 防御旧/混合版本客户端误传：本地 topic 必须完全忽略远端迁移 allowlist。
          legacyTaskIds: [SESSION_ID],
        },
      });
      const frame = sessionsIndexTopicFrameSchema.parse(
        takeInitialFrameParams(server, "local-index"),
      );
      if (frame.payload.kind !== "snapshot") {
        throw new Error("Expected sessions-index snapshot frame");
      }
      expect(frame.payload.snapshot.workspaceId).toBe(WORKSPACE_PATH);
      expect(frame.payload.snapshot.sessions).toEqual([
        expect.objectContaining({
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_PATH,
          title: "Local index session",
        }),
      ]);
      expect((await store.getSession(SESSION_ID))?.workspaceID).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("重启后首次订阅 sessions-index：parented fork 可见且辅助 child 保持隐藏", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const seedStore = await createSqliteSessionStore({ dbPath });
    const rootSessionId = "sess_index_root" as SessionId;
    const forkSessionId = "sess_index_fork" as SessionId;
    const workflowParentSessionId = "sess_index_workflow_parent" as SessionId;
    try {
      const fixtures = [
        { id: rootSessionId, taskType: "interactive" as const },
        {
          id: forkSessionId,
          parentID: rootSessionId,
          taskType: "fork" as const,
        },
        {
          id: workflowParentSessionId,
          taskType: "workflow_parent" as const,
        },
        {
          id: "sess_index_selection_side_chat" as SessionId,
          parentID: rootSessionId,
          taskType: "selection_side_chat" as const,
        },
        {
          id: "sess_index_subagent_child" as SessionId,
          parentID: rootSessionId,
          taskType: "subagent_child" as const,
        },
        {
          id: "sess_index_workflow_child" as SessionId,
          parentID: workflowParentSessionId,
          taskType: "workflow_child" as const,
        },
        {
          id: "sess_index_nested_workflow_child" as SessionId,
          parentID: workflowParentSessionId,
          taskType: "nested_workflow_child" as const,
        },
      ];
      for (const [index, fixture] of fixtures.entries()) {
        await seedStore.createSession({
          ...fixture,
          projectID: `project_index_membership_${index}` as ProjectId,
          slug: `index-membership-${index}`,
          directory: WORKSPACE_PATH,
          path: WORKSPACE_PATH,
          title: `Index membership ${index}`,
          version: "test-version",
          time: { created: index + 1, updated: index + 1 },
        });
      }
    } finally {
      seedStore.close();
    }

    const { server, store } = await bootRestartedServer(dbPath, []);
    try {
      // 不先 resume 任一 child，直接模拟 App 重启后的首次列表订阅。
      await requestResult(server, {
        id: "cold-index-membership",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: sessionsIndexTopic(WORKSPACE_PATH),
          connectionId: "conn-cold-index-membership",
          clientMode: "desktop-continuous",
        },
      });
      const frame = sessionsIndexTopicFrameSchema.parse(
        takeInitialFrameParams(server, "cold-index-membership"),
      );
      if (frame.payload.kind !== "snapshot") {
        throw new Error("Expected sessions-index snapshot frame");
      }
      expect(frame.payload.snapshot.sessions.map((session) => session.sessionId).sort()).toEqual(
        [rootSessionId, forkSessionId, workflowParentSessionId].sort(),
      );
      expect(
        frame.payload.snapshot.sessions.find((session) => session.sessionId === forkSessionId),
      ).toMatchObject({
        parentSessionId: rootSessionId,
        sessionId: forkSessionId,
      });
    } finally {
      store.close();
    }
  });

  for (const childKind of ["subagent_child", "workflow_child", "nested_workflow_child"] as const) {
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      for (const lifecycle of ["warm", "grace", "parent-release", "cold"] as const) {
        it(`SAT27/SAT28: ${clientMode} ${childKind} ${lifecycle} 重开保持隐藏且拒绝用户输入`, async () => {
          const dbPath = join(tempRoot, "sessions.db");
          await seedPersistedSession(dbPath, undefined, childKind);
          const sentInputs: Array<{ text: string }> = [];
          const options: ZCodeAppOptions[] = [];
          const { server, store } = await bootRestartedServer(
            dbPath,
            sentInputs,
            undefined,
            options,
          );
          const { v4Gateway: gateway } = (
            server as unknown as {
              context: { v4Gateway: ConversationV4Gateway };
            }
          ).context;
          async function subscribe(id: string, topic: string) {
            await requestResult(server, {
              id,
              method: V4_METHODS.conversationSubscribe,
              params: { topic, connectionId: id, clientMode },
            });
            return takeInitialFrameParams(server, id);
          }
          try {
            await subscribe("index-before", sessionsIndexTopic(WORKSPACE_PATH));
            if (lifecycle !== "cold") {
              gateway.ingestDetachedLiveSession(
                SESSION_ID,
                makeEvent(SESSION_ID, 1, SessionEventType.SessionCreated, {
                  mode: "default",
                  contextWindow: 200_000,
                }),
                PARENT_SESSION_ID,
              );
              gateway.ingestDetachedLiveSession(
                SESSION_ID,
                {
                  ...makeEvent(SESSION_ID, 2, SessionEventType.TurnStarted, {
                    turnNumber: 1,
                    input: "child task",
                  }),
                  turnId: "child-turn",
                },
                PARENT_SESSION_ID,
              );
              gateway.ingestDetachedLiveSession(
                SESSION_ID,
                {
                  ...makeEvent(SESSION_ID, 3, SessionEventType.ModelStreaming, {
                    kind: "text_delta",
                    delta: "child done",
                    done: false,
                  }),
                  turnId: "child-turn",
                },
                PARENT_SESSION_ID,
              );
              gateway.ingestDetachedLiveSession(
                SESSION_ID,
                {
                  ...makeEvent(SESSION_ID, 4, SessionEventType.TurnComplete, {
                    duration: 1,
                    response: "done",
                    resultType: "success",
                    tokenCount: 1,
                    toolCallCount: 0,
                  }),
                  turnId: "child-turn",
                },
                PARENT_SESSION_ID,
              );
            }
            if (lifecycle === "grace")
              expect(gateway.pruneDetachedChildPublishers(Date.now() + 180_000)).toBe(1);
            if (lifecycle === "parent-release") gateway.deactivateSession(PARENT_SESSION_ID);
            const child = conversationTopicFrameSchema.parse(
              await subscribe("child", conversationTopic(SESSION_ID)),
            );
            if (child.payload.kind !== "snapshot") throw new Error("expected child snapshot");
            expect(child.payload.snapshot.rows.window.length).toBeGreaterThan(0);
            const index = sessionsIndexTopicFrameSchema.parse(
              await subscribe("index-after", sessionsIndexTopic(WORKSPACE_PATH)),
            );
            if (index.payload.kind !== "snapshot") throw new Error("expected index snapshot");
            expect(
              index.payload.snapshot.sessions.map((session) => session.sessionId),
            ).not.toContain(SESSION_ID);
            const legacy = (await requestResult(server, {
              id: "legacy-list",
              method: zcodeProtocolMethods.sessionList,
              params: { workspace },
            })) as { sessions: Array<{ sessionId: string }> };
            expect(legacy.sessions.map((session) => session.sessionId)).not.toContain(SESSION_ID);
            expect((await store.getSession(SESSION_ID))?.taskType).toBe(childKind);
            if (lifecycle !== "warm")
              expect(
                options.find((option) => option.sessionId === SESSION_ID)?.runtimeConfig?.taskType,
              ).toBe(childKind);
            for (const type of [
              "sendText",
              "sendGoalCommand",
              "compact",
              "retryTurn",
              "editUserQuery",
            ] as const) {
              const targetRow = child.payload.snapshot.rows.window.findLast(
                (row) => row.kind === (type === "editUserQuery" ? "userInput" : "assistantText"),
              );
              const ack = commandAckSchema.parse(
                await requestResult(server, {
                  id: type,
                  method: V4_METHODS.command,
                  params: {
                    commandId: `child-${type}`,
                    clientId: "child-test",
                    sessionId: SESSION_ID,
                    type,
                    baseRevision: child.payload.snapshot.revision,
                    baseLogEpoch: child.payload.snapshot.logEpoch,
                    payload:
                      type === "sendText" || type === "sendGoalCommand"
                        ? { text: "continue child" }
                        : type === "retryTurn" || type === "editUserQuery"
                          ? {
                              target: {
                                rowId: targetRow?.rowId ?? 1,
                                entityId: targetRow?.entityId ?? "missing",
                              },
                              ...(type === "editUserQuery" ? { newText: "edit child" } : {}),
                            }
                          : {},
                    issuedAt: Date.now(),
                  },
                }),
              );
              expect(ack).toMatchObject(
                lifecycle === "warm"
                  ? { status: "rejected", reasonCode: "proto.sessionNotFound" }
                  : { status: "failed", reasonCode: "guard.subagentReadOnly" },
              );
            }
            expect(await store.listSessionInputs({ sessionID: SESSION_ID })).toEqual([]);
            expect(sentInputs).toEqual([]);
          } finally {
            gateway.dispose();
            store.close();
          }
        });
      }
    }
  }

  it.each(["subagent_child", "workflow_child", "nested_workflow_child"] as const)(
    "SAT28: legacy session/send 同样拒绝 %s 续聊",
    async (childKind) => {
      const dbPath = join(tempRoot, "sessions.db");
      await seedPersistedSession(dbPath, undefined, childKind);
      const { server, store } = await bootRestartedServer(dbPath, []);
      try {
        await requestResult(server, {
          id: "open-child",
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: conversationTopic(SESSION_ID),
            connectionId: "legacy-child",
            clientMode: "desktop-continuous",
          },
        });
        const result = await server.handleMessage({
          id: "legacy-send",
          method: zcodeProtocolMethods.sessionSend,
          params: {
            sessionId: SESSION_ID,
            content: "continue child",
            queryId: "legacy-child-send",
          },
        });
        expect(result).toMatchObject({ error: { data: { reasonCode: "guard.subagentReadOnly" } } });
        expect(await store.listSessionInputs({ sessionID: SESSION_ID })).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "SAT30: selection side chat remains writable after cold resume on %s",
    async (clientMode) => {
      const dbPath = join(tempRoot, "sessions.db");
      await seedPersistedSession(dbPath, undefined, "selection_side_chat");
      const sentInputs: Array<{ text: string }> = [];
      const { server, store } = await bootRestartedServer(dbPath, sentInputs);
      try {
        await requestResult(server, {
          id: "open-side",
          method: V4_METHODS.conversationSubscribe,
          params: { topic: conversationTopic(SESSION_ID), connectionId: "side-test", clientMode },
        });
        const frame = conversationTopicFrameSchema.parse(
          takeInitialFrameParams(server, "open-side"),
        );
        if (frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
        const ack = await requestResult(server, {
          id: "send-side",
          method: V4_METHODS.command,
          params: {
            commandId: "side-send",
            clientId: "side-test",
            sessionId: SESSION_ID,
            type: "sendText",
            baseRevision: frame.payload.snapshot.revision,
            baseLogEpoch: frame.payload.snapshot.logEpoch,
            payload: { text: "continue side chat" },
            issuedAt: Date.now(),
          },
        });
        expect(ack).toMatchObject({ status: "accepted" });
        await vi.waitFor(() =>
          expect(sentInputs).toContainEqual(
            expect.objectContaining({ text: "continue side chat" }),
          ),
        );
        expect((await store.getSession(SESSION_ID))?.taskType).toBe("selection_side_chat");
      } finally {
        store.close();
      }
    },
  );

  it("SAT29: 显式 session/list 按 workspace 查询隐藏身份，不激活 child；普通列表保留 fork", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath, undefined, "subagent_child");
    const options: ZCodeAppOptions[] = [];
    const { server, store } = await bootRestartedServer(dbPath, [], undefined, options);
    try {
      await store.createSession({
        id: "visible-fork" as SessionId,
        parentID: PARENT_SESSION_ID,
        taskType: "fork",
        projectID: "project" as ProjectId,
        slug: "fork",
        title: "fork",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        version: "test",
      });
      const read = (id: string, params: unknown) =>
        requestResult(server, { id, method: zcodeProtocolMethods.sessionList, params }) as Promise<{
          sessions: Array<{ sessionId: string; sessionKind: string }>;
        }>;
      const normal = await read("normal", { workspace });
      expect(normal.sessions.map((item) => item.sessionId)).toEqual(["visible-fork"]);
      const explicit = await read("explicit", {
        workspace,
        sessionIds: [SESSION_ID, "visible-fork", "missing"],
      });
      expect(explicit.sessions.map((item) => [item.sessionId, item.sessionKind])).toEqual([
        [SESSION_ID, "subagent_child"],
        ["visible-fork", "fork"],
      ]);
      expect(
        (await read("foreign", { workspace: remoteWorkspace, sessionIds: [SESSION_ID] })).sessions,
      ).toEqual([]);
      expect(options).toEqual([]);
    } finally {
      store.close();
    }
  });

  describe.each([
    "subagent_child",
    "workflow_child",
    "selection_side_chat",
    "nested_workflow_child",
  ] as const)("SAT30 %s", (childKind) => {
    it.each(["desktop-continuous", "web-remote-replayable"] as const)(
      "SAT30: restarted %s child carries its directory source through cold materialization",
      async (clientMode) => {
        const dbPath = join(tempRoot, "directory-source.db");
        await seedPersistedSession(dbPath, undefined, childKind);
        const seed = await createSqliteSessionStore({ dbPath });
        await seed.createSession({
          id: PARENT_SESSION_ID,
          workspaceID: REMOTE_WORKSPACE_IDENTITY,
          taskType: "interactive",
          projectID: "project" as ProjectId,
          slug: "parent",
          title: "parent",
          directory: WORKSPACE_PATH,
          path: WORKSPACE_PATH,
          version: "test",
        });
        seed.close();
        // 旧 Agent 在 Bash cd 后把执行 cwd 当成绑定目录；父链仍完整。
        const legacy = new DatabaseSync(dbPath);
        legacy
          .prepare("UPDATE session SET path=?, directory=? WHERE id=?")
          .run(`${WORKSPACE_PATH}/src`, `${WORKSPACE_PATH}/src`, SESSION_ID);
        legacy.close();
        for (let lifetime = 0; lifetime < 2; lifetime += 1) {
          const apps: ZCodeAppOptions[] = [];
          const { server, store } = await bootRestartedServer(dbPath, [], undefined, apps);
          const preferences: unknown[] = [];
          const input = new PassThrough();
          const output = new PassThrough();
          const subscribed = Promise.withResolvers<void>();
          const connection = new ZCodeProtocolNdjsonConnection({
            input,
            output,
            handleMessage: (message) => server.handleMessage(message),
          });
          // 经过真实 NDJSON 串行队列：反向请求必须直接应答，不能再向 CLI 查询父链。
          output.on("data", (chunk: Buffer) => {
            const message = JSON.parse(chunk.toString()) as ZCodeProtocolMessage;
            if (!("id" in message)) return;
            if (
              "method" in message &&
              message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
            ) {
              const params = message.params as { sessionId: string; directorySessionId?: string };
              preferences.push(params);
              input.write(
                JSON.stringify(
                  params.directorySessionId === PARENT_SESSION_ID
                    ? {
                        id: message.id,
                        result: {
                          nativeSearchEnhancementsEnabled: false,
                          memoryEnabled: false,
                          additionalDirectories: [],
                        },
                      }
                    : {
                        id: message.id,
                        error: { code: -32603, message: "project.remote-project-required" },
                      },
                ) + "\n",
              );
            } else if (message.id === "directory-subscribe") {
              if ("error" in message) subscribed.reject(new Error(message.error.message));
              else subscribed.resolve();
            }
          });
          server.setNotificationSink((message) => connection.send(message));
          connection.start();
          try {
            await requestResult(server, {
              id: "directory-capability",
              method: zcodeProtocolMethods.runtimeCapabilities,
              params: {
                hostCapabilities: {
                  sessionDirectorySource: true,
                  ...(lifetime === 1 ? { sessionWorkspaceRouting: true } : {}),
                },
              },
            });
            const metadata = await requestResult(server, {
              id: "directory-metadata",
              method: zcodeProtocolMethods.sessionList,
              params: { workspace: remoteWorkspace, sessionIds: [SESSION_ID] },
            });
            expect(apps).toEqual([]);
            if (lifetime === 1) {
              await requestResult(server, {
                id: "explicit-resume",
                method: zcodeProtocolMethods.sessionResume,
                params: { workspace: remoteWorkspace, sessionId: SESSION_ID },
              });
            }
            input.write(
              JSON.stringify({
                id: "directory-subscribe",
                method: V4_METHODS.conversationSubscribe,
                params: { ...subscribeParams(SESSION_ID), clientMode, workspace: remoteWorkspace },
              }) + "\n",
            );
            await subscribed.promise;
            expect(metadata).toMatchObject({
              sessions: [{ sessionId: SESSION_ID, directorySessionId: PARENT_SESSION_ID }],
            });
            expect(preferences).toEqual([
              expect.objectContaining({
                sessionId: SESSION_ID,
                directorySessionId: PARENT_SESSION_ID,
              }),
            ]);
            if (lifetime === 1) expect(preferences[0]).toHaveProperty("workspace", remoteWorkspace);
            else expect(preferences[0]).not.toHaveProperty("workspace");

            const frame = conversationTopicFrameSchema.parse(
              takeInitialFrameParams(server, "directory-subscribe"),
            );
            if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot");
            expect(
              frame.payload.snapshot.rows.window.some(
                (row) => row.kind === "assistantText" && row.text === "历史回答二",
              ),
            ).toBe(true);
            expect(apps).toHaveLength(1);
            expect(apps[0]?.sessionId).toBe(SESSION_ID);
          } finally {
            input.end();
            await connection.waitForClose();
            await server.shutdown();
            store.close();
          }
        }
      },
    );
    it.each([
      "valid",
      "foreign-parent",
      "missing-parent",
      "deleted-parent",
      "foreign-cwd",
      "foreign-child",
      "cycle",
    ])(
      "SAT30: explicit remote child metadata resolves persisted lineage (%s) without activation",
      async (scenario) => {
        const dbPath = join(tempRoot, "sessions.db");
        await seedPersistedSession(
          dbPath,
          scenario === "foreign-child"
            ? ("remote:server:other:/workspace/cold-resume" as WorkspaceId)
            : undefined,
          childKind,
        );
        const options: ZCodeAppOptions[] = [];
        const { server, store } = await bootRestartedServer(dbPath, [], undefined, options);
        try {
          if (scenario !== "missing-parent") {
            await store.createSession({
              id: PARENT_SESSION_ID,
              ...(scenario === "cycle"
                ? { parentID: SESSION_ID }
                : {
                    workspaceID:
                      scenario === "foreign-parent"
                        ? ("remote:server:other:/workspace/cold-resume" as WorkspaceId)
                        : REMOTE_WORKSPACE_IDENTITY,
                  }),
              taskType: scenario === "cycle" ? childKind : "interactive",
              projectID: "project" as ProjectId,
              slug: "parent",
              title: "parent",
              directory: scenario === "foreign-cwd" ? `${WORKSPACE_PATH}-other` : WORKSPACE_PATH,
              path: scenario === "foreign-cwd" ? `${WORKSPACE_PATH}-other` : WORKSPACE_PATH,
              version: "test",
            });
          }
          await requestResult(server, {
            id: "directory-capability",
            method: zcodeProtocolMethods.runtimeCapabilities,
            params: { hostCapabilities: { sessionDirectorySource: true } },
          });
          if (scenario === "deleted-parent") await store.softDeleteSession?.(PARENT_SESSION_ID, 2);
          const explicit = (await requestResult(server, {
            id: "legacy-child",
            method: zcodeProtocolMethods.sessionList,
            params: { workspace: remoteWorkspace, sessionIds: [SESSION_ID] },
          })) as { sessions: Array<{ sessionId: string; workspace: unknown }> };
          expect(explicit.sessions.map((session) => session.sessionId)).toEqual(
            scenario === "valid" ? [SESSION_ID] : [],
          );
          if (scenario === "valid") {
            expect(explicit.sessions[0]).toMatchObject({
              workspace: remoteWorkspace,
              directorySessionId: PARENT_SESSION_ID,
            });
          } else {
            await expect(
              requestResult(server, {
                id: "invalid-resume",
                method: zcodeProtocolMethods.sessionResume,
                params: { workspace: remoteWorkspace, sessionId: SESSION_ID },
              }),
            ).rejects.toThrow();
          }
          const normal = (await requestResult(server, {
            id: "normal-list",
            method: zcodeProtocolMethods.sessionList,
            params: { workspace: remoteWorkspace },
          })) as { sessions: Array<{ sessionId: string }> };
          expect(normal.sessions.some((session) => session.sessionId === SESSION_ID)).toBe(false);
          expect(options).toEqual([]);
          if (scenario !== "foreign-child")
            expect((await store.getSession(SESSION_ID))?.workspaceID).toBeUndefined();
        } finally {
          store.close();
        }
      },
    );
  });

  it.each(["interactive", "fork", "workflow_parent"] as const)(
    "SAT30: nested children stop directory inheritance at %s",
    async (ownerKind) => {
      const dbPath = join(tempRoot, "directory-owner.db");
      await seedPersistedSession(dbPath, REMOTE_WORKSPACE_IDENTITY, "nested_workflow_child");
      const { server, store } = await bootRestartedServer(dbPath, []);
      try {
        for (const [id, parentID, taskType] of [
          [PARENT_SESSION_ID, "directory-owner", "workflow_child"],
          ["directory-owner", "missing-upstream", ownerKind],
        ] as const) {
          await store.createSession({
            id: id as SessionId,
            parentID: parentID as SessionId,
            taskType,
            workspaceID: REMOTE_WORKSPACE_IDENTITY,
            projectID: "project" as ProjectId,
            slug: id,
            title: id,
            path: WORKSPACE_PATH,
            directory: WORKSPACE_PATH,
            version: "test",
          });
        }
        const read = () =>
          requestResult(server, {
            id: "owner",
            method: zcodeProtocolMethods.sessionList,
            params: { workspace: remoteWorkspace, sessionIds: [SESSION_ID] },
          }) as Promise<{ sessions: Array<{ directorySessionId?: string }> }>;
        // 旧 Host 没有声明能力时，严格的旧元数据 schema 不会收到新字段。
        expect((await read()).sessions[0]).not.toHaveProperty("directorySessionId");
        await requestResult(server, {
          id: "enable",
          method: zcodeProtocolMethods.runtimeCapabilities,
          params: { hostCapabilities: { sessionDirectorySource: true } },
        });
        // 普通能力探测不能撤销同一进程已确认的合同。
        await requestResult(server, {
          id: "probe",
          method: zcodeProtocolMethods.runtimeCapabilities,
          params: {},
        });
        expect((await read()).sessions[0]?.directorySessionId).toBe("directory-owner");
      } finally {
        store.close();
      }
    },
  );

  it("重启后冷订阅：transcript 合成重建历史 + 可交互 + sendText 再发一轮成功", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const sentInputs: Array<{ text: string }> = [];
    const { server, store } = await bootRestartedServer(dbPath, sentInputs);
    try {
      const subscribed = v4ConversationSubscribeResultSchema.parse(
        await requestResult(server, {
          id: 2,
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: conversationTopic(SESSION_ID),
            connectionId: "conn-desktop",
            clientMode: "desktop-continuous",
          },
        }),
      );
      expect(subscribed.ack.mode).toBe("snapshot");
      const frame = conversationTopicFrameSchema.parse(takeInitialFrameParams(server, 2));
      if (frame?.payload.kind !== "snapshot") {
        throw new Error("Expected snapshot initial frame");
      }
      const snapshot = frame.payload.snapshot;
      // Bug 根因：旧 cold hydration 固定合成 20 万，导致首帧在后续 live 事件纠正前
      // 已触发满载/压缩。首个原始 snapshot 必须直接使用当前 registry 的 1M。
      expect(snapshot.usage.contextWindow).toMatchObject({
        maxTokens: 1_000_000,
        usedTokens: 2,
      });
      // 历史行齐全（transcript→event 合成路径：重启后 record 的内存事件日志为空）。
      const texts = snapshot.rows.window
        .filter((row) => row.kind === "userInput" || row.kind === "assistantText")
        .map((row) => ("text" in row ? row.text : ""));
      expect(texts).toEqual(["历史问题一", "历史回答一", "历史问题二", "历史回答二"]);
      expect(snapshot.rows.window.find((row) => row.kind === "reasoning")).toMatchObject({
        text: "历史思考二",
        state: "complete",
      });
      expect(snapshot.rows.window.find((row) => row.kind === "toolCall")).toMatchObject({
        output: { text: "历史工具输出" },
        status: "success",
        toolCallId: "call_cold_read",
        toolName: "Read",
      });
      // control 可交互：完成态 + 输入直发（composer 不该禁用）。
      expect(snapshot.control.phase).toBe("completedSuccess");
      expect(snapshot.control.canStop).toBe(false);
      expect(snapshot.inputRouting.mode).toBe("startNow");

      // 再发一轮：sendText 必须 accepted 并落到 runtime sendInput。
      const ack = commandAckSchema.parse(
        await requestResult(server, {
          id: 3,
          method: V4_METHODS.command,
          params: {
            commandId: "cmd-cold-send-1",
            clientId: "client-cold",
            sessionId: SESSION_ID,
            type: "sendText",
            payload: { text: "重启后的新问题" },
            issuedAt: 1_700_000_100_000,
          },
        }),
      );
      expect(ack.status).toBe("accepted");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sentInputs).toEqual([{ text: "重启后的新问题" }]);

      // sessions-index 联动：恢复后的会话进入 live 注册表，列表订阅可见。
      const indexResult = v4SessionsIndexSubscribeResultSchema.parse(
        await requestResult(server, {
          id: 4,
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: sessionsIndexTopic(WORKSPACE_PATH),
            connectionId: "conn-desktop-index",
            clientMode: "desktop-continuous",
          },
        }),
      );
      const indexFrame = sessionsIndexTopicFrameSchema.parse(takeInitialFrameParams(server, 4));
      if (indexFrame.payload.kind !== "snapshot") {
        throw new Error("Expected sessions-index snapshot frame");
      }
      const resumedSummary = indexFrame.payload.snapshot.sessions.find(
        (session) => session.sessionId === SESSION_ID,
      );
      expect(resumedSummary?.parentSessionId).toBe(PARENT_SESSION_ID);

      // 幂等：再次订阅同一会话不再重建 record（无重复恢复副作用），直接出帧。
      const resubscribed = v4ConversationSubscribeResultSchema.parse(
        await requestResult(server, {
          id: 5,
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: conversationTopic(SESSION_ID),
            connectionId: "conn-desktop-2",
            clientMode: "desktop-continuous",
          },
        }),
      );
      expect(resubscribed.ack.mode).toBe("snapshot");
      expect(
        conversationTopicFrameSchema.parse(takeInitialFrameParams(server, 5)).payload.kind,
      ).toBe("snapshot");
    } finally {
      store.close();
    }
  });

  it("当前本地 attachment 路径优先于旧 session 的规范化路径", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const sentInputs: Array<{ text: string }> = [];
    const createdAppOptions: ZCodeAppOptions[] = [];
    const { server, store } = await bootRestartedServer(
      dbPath,
      sentInputs,
      undefined,
      createdAppOptions,
    );
    const attachmentWorkspace = {
      workspacePath: `${WORKSPACE_PATH}/`,
      workspaceKey: `${WORKSPACE_PATH}/`,
    };
    try {
      await requestResult(server, {
        id: "subscribe-with-trailing-slash",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-trailing-slash",
          clientMode: "desktop-continuous",
          workspace: attachmentWorkspace,
        },
      });
      takeInitialFrameParams(server, "subscribe-with-trailing-slash");

      const ack = commandAckSchema.parse(
        await requestResult(server, {
          id: "send-after-trailing-slash-resume",
          method: V4_METHODS.command,
          params: {
            commandId: "cmd-trailing-slash-resume",
            clientId: "client-trailing-slash-resume",
            sessionId: SESSION_ID,
            type: "sendText",
            payload: { text: "继续" },
            issuedAt: 1_700_000_100_000,
          },
        }),
      );

      expect(ack.status).toBe("accepted");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sentInputs).toEqual([{ text: "继续" }]);
      expect(createdAppOptions[0]?.runtimeConfig?.workspacePath).toBe(
        attachmentWorkspace.workspacePath,
      );
    } finally {
      store.close();
    }
  });

  it("historyFirst 在真实持久库读出正文后才启动 runtime，失败清理且重试保留正文", async () => {
    const dbPath = join(tempRoot, "history-first.db");
    await seedPersistedSession(dbPath);
    const gate = deferred();
    const probe: ColdFakeAppProbe = {
      readTodosCalls: 0,
      resumeCalls: 0,
      closeCalls: 0,
      resumeGate: gate.promise,
      failResume: true,
    };
    const apps: ZCodeAppOptions[] = [];
    // 存储迁移已异步化；新增历史用例必须等待夹具就绪，不能解构尚未完成的 Promise。
    const { server, store } = await bootRestartedServer(dbPath, [], probe, apps);
    const originalTime = (await store.getSession(SESSION_ID))?.time;
    const messages = vi.spyOn(store, "messages");
    let observed: ConversationSnapshot | undefined;
    server.setNotificationSink((message) => {
      if (
        "id" in message &&
        message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
      ) {
        void server.handleMessage({
          id: message.id,
          result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
        });
        return;
      }
      if (message.method !== V4_NOTIFICATIONS.conversationFrame) return;
      const wire = routedTopicWireFrameSchema.parse(message.params);
      if (wire.kind === "complete" && wire.topic === conversationTopic(SESSION_ID)) {
        const frame = conversationTopicFrameSchema.parse(wire.frame);
        if (frame.payload.kind === "snapshot") observed = frame.payload.snapshot;
        else if (observed)
          observed = {
            ...applyConversationDeltas(observed, frame.payload.deltas),
            seq: frame.toSeq,
          };
      }
    });
    const latest = () => observed;
    const subscribe = async (id: string, retryInitialization?: string) => {
      await requestResult(server, {
        id,
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "history-first",
          clientMode: "desktop-continuous",
          historyFirst: true,
          ...(retryInitialization ? { retryInitialization } : {}),
        },
      });
      const frame = conversationTopicFrameSchema.parse(takeInitialFrameParams(server, id));
      if (frame.payload.kind !== "snapshot") throw new Error("missing snapshot");
      observed = frame.payload.snapshot;
      return frame.payload.snapshot;
    };
    try {
      const initial = await subscribe("first");
      expect(probe.resumeCalls).toBe(0);
      expect(initial.runtimeInitialization?.status).toBe("initializing");
      expect(JSON.stringify(initial.rows)).toContain("历史回答二");
      expect(JSON.stringify(initial.rows)).toContain("历史工具输出");
      await vi.waitFor(() => expect(probe.resumeCalls).toBe(1));
      gate.resolve();
      await vi.waitFor(() => expect(latest()?.runtimeInitialization?.status).toBe("failed"));
      expect(probe.closeCalls).toBe(1);
      expect(messages.mock.calls.filter(([input]) => input.sessionID === SESSION_ID)).toHaveLength(
        1,
      );
      const failed = latest()!;
      const reconnect = await subscribe("reconnect");
      expect(reconnect.runtimeInitialization?.status).toBe("failed");
      expect(apps).toHaveLength(1);
      probe.failResume = false;
      await subscribe("retry", failed.runtimeInitialization!.attemptId);
      await vi.waitFor(() => expect(latest()?.runtimeInitialization?.status).toBe("ready"));
      expect(apps).toHaveLength(2);
      expect(latest()!.seq).toBeGreaterThan(initial.seq);
      expect(latest()!.rows.totalCount).toBe(initial.rows.totalCount);
      expect(messages.mock.calls.filter(([input]) => input.sessionID === SESSION_ID)).toHaveLength(
        2,
      );
      expect((await store.getSession(SESSION_ID))?.time).toEqual(originalTime);
    } finally {
      gate.resolve();
      store.close();
    }
  });

  it("V4 冷订阅只激活 runtime 并复用一次持久物化，legacy resume 仍返回完整 snapshot", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const probe: ColdFakeAppProbe = { readTodosCalls: 0, resumeCalls: 0 };
    const { server, store } = await bootRestartedServer(dbPath, [], probe);
    const messagesSpy = vi.spyOn(store, "messages");
    try {
      await requestResult(server, {
        id: "subscribe-activation-only",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-activation-only",
          clientMode: "desktop-continuous",
        },
      });
      const frame = conversationTopicFrameSchema.parse(
        takeInitialFrameParams(server, "subscribe-activation-only"),
      );
      if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot frame");

      // Bug 根因：旧 V4 resume 钩子会先构建一份无人消费的 legacy snapshot，
      // usage seed 随后又构建第二份。readTodos 只属于 full snapshot，可作为稳定 seam
      // 证明 V4 现在只做 activation + 自己的 durable hydration。
      expect(probe).toEqual({ readTodosCalls: 0, resumeCalls: 1 });
      // 性能根因：同一份父会话 messages 过去又被 hydration、subagent seed、usage seed
      // 各读一次。正常冷订阅必须只在 activation 起点物化一次。
      expect(
        messagesSpy.mock.calls.filter(([input]) => input.sessionID === SESSION_ID),
      ).toHaveLength(1);
      expect(frame.payload.snapshot.usage.contextWindow).toMatchObject({
        // 当前分支的模型 registry 是 context-window 权威；窄读只替换 usage 取数，
        // 不能把冷 runtime projection 的旧 128k 分母重新覆盖到 V4 首帧。
        maxTokens: 1_000_000,
        usedTokens: 2,
      });

      const legacy = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: "legacy-resume-after-v4",
          method: zcodeProtocolMethods.sessionResume,
          params: { sessionId: SESSION_ID, workspace },
        }),
      );
      expect(probe).toEqual({ readTodosCalls: 1, resumeCalls: 1 });
      expect(legacy.runtime.contextUsage).toMatchObject({
        size: 1_000_000,
        used: 2,
      });
      expect(frame.payload.snapshot.usage.contextWindow?.cache).toEqual(
        legacy.runtime.contextUsage?.cache,
      );
    } finally {
      store.close();
    }
  });

  it("fresh server 的 legacy session/resume 不向 runtime 注入 V4 持久物化", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const probe: ColdFakeAppProbe = {
      readTodosCalls: 0,
      resumeCalls: 0,
      resumePersistedMessagesProvided: [],
    };
    const { server, store } = await bootRestartedServer(dbPath, [], probe);

    try {
      const legacy = zcodeSessionStateSnapshotSchema.parse(
        await requestResult(server, {
          id: "fresh-legacy-resume",
          method: zcodeProtocolMethods.sessionResume,
          params: { sessionId: SESSION_ID, workspace },
        }),
      );

      expect(probe).toMatchObject({
        readTodosCalls: 1,
        resumeCalls: 1,
        resumePersistedMessagesProvided: [false],
      });
      expect(legacy.session.sessionId).toBe(SESSION_ID);
      expect(legacy.runtime.contextUsage).toMatchObject({
        size: 1_000_000,
        used: 2,
      });
    } finally {
      store.close();
    }
  });

  it("runtime 修补中断 compact 后只刷新一次持久物化", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const probe: ColdFakeAppProbe = {
      persistedMessagesReloadRequired: true,
      readTodosCalls: 0,
      resumeCalls: 0,
    };
    const { server, store } = await bootRestartedServer(dbPath, [], probe);
    const messagesSpy = vi.spyOn(store, "messages");
    try {
      await requestResult(server, {
        id: "subscribe-compact-refresh",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-compact-refresh",
          clientMode: "desktop-continuous",
        },
      });

      expect(
        messagesSpy.mock.calls.filter(([input]) => input.sessionID === SESSION_ID),
      ).toHaveLength(2);
      expect(probe.resumeCalls).toBe(1);
    } finally {
      store.close();
    }
  });

  it("compact 是最后操作：重启后的首帧保持压缩后 usage", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedCompactedSession(dbPath);
    const { server, store } = await bootRestartedServer(dbPath, []);
    try {
      await requestResult(server, {
        id: "subscribe-compact-desktop",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-compact-desktop",
          clientMode: "desktop-continuous",
        },
      });
      const desktopFrame = conversationTopicFrameSchema.parse(
        takeInitialFrameParams(server, "subscribe-compact-desktop"),
      );
      if (desktopFrame.payload.kind !== "snapshot") {
        throw new Error("Expected desktop snapshot frame");
      }

      expect(desktopFrame.payload.snapshot.usage.contextWindow).toMatchObject({
        maxTokens: 1_000_000,
        usedTokens: 1,
      });
      expect(desktopFrame.payload.snapshot.usage.contextWindow?.cache).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("旧 assistant boundary 缺少压缩后 token 时保持 assistant usage fallback", async () => {
    const compactBoundary: CompactBoundaryPayload = {
      boundaryId: "boundary_cold_legacy",
      trigger: CompactTrigger.Manual,
      preCompactTokenCount: 9,
      summarizedMessageCount: 2,
      summaryMessageIds: [],
      traceId: "trace_cold_legacy_boundary" as TraceId,
    };
    const legacyMessage = {
      info: {
        role: "assistant",
        tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      } as MessageWithParts["info"],
      parts: [
        {
          type: "compaction",
          auto: false,
          compactBoundary,
        } as MessagePart,
      ],
    };
    const projection = await createColdFakeApp(undefined, []).runtime.getProjection();

    expect(resolveSessionContextUsage({ messages: [legacyMessage], projection })).toMatchObject({
      size: 128_000,
      used: 9,
    });
  });

  it("重启后冷订阅：优先从 Agent durable selection 恢复 task-local thought", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const seedStore = await createSqliteSessionStore({ dbPath });
    try {
      await seedStore.saveSessionEntry({
        id: `${SESSION_ID}:runtime-model-selection`,
        sessionID: SESSION_ID,
        type: SESSION_ENTRY_MODEL_SELECTION,
        time: { created: 5, updated: 5 },
        data: { modelId: "glm-4.6", providerId: "glm", options: { reasoningLevel: "deep" } },
      });
    } finally {
      seedStore.close();
    }

    const { server, close } = await bootRealRestartedServer(dbPath);
    try {
      await requestResult(server, {
        id: "subscribe-thought",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-thought",
          clientMode: "desktop-continuous",
          // 即便 host 的 legacy hint 迟到/过期，Agent 自己的 durable selection 仍优先。
          resumeThoughtLevel: "medium",
        },
      });
      const frame = conversationTopicFrameSchema.parse(
        takeInitialFrameParams(server, "subscribe-thought"),
      );
      if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot frame");
      expect(frame.payload.snapshot.config).toMatchObject({
        model: "glm-4.6",
        provider: "glm",
        thought: "deep",
        thoughtLevels: ["medium", "deep"],
      });
    } finally {
      await close();
    }
  });

  it("重启后冷订阅：旧 fork 消息缺档位时不借用相邻消息的档位", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    const legacyForkSessionId = "sess_legacy_fork_thought" as SessionId;
    const parentSessionId = "sess_legacy_fork_parent";
    const targetMessageId = "msg_legacy_fork_target";
    const hiddenMessageId = "msg_legacy_fork_hidden" as MessageId;
    const noticeMessageId = "msg_legacy_fork_notice" as MessageId;
    const forkOrigin = { parentSessionId, targetMessageId };
    const seedStore = await createSqliteSessionStore({ dbPath });
    try {
      await seedStore.createSession({
        id: legacyForkSessionId,
        parentID: parentSessionId as SessionId,
        projectID: "project_legacy_fork_thought" as ProjectId,
        slug: "legacy-fork-thought",
        directory: WORKSPACE_PATH,
        path: WORKSPACE_PATH,
        title: "Legacy fork thought",
        version: "test-version",
        time: { created: 1, updated: 4 },
      });
      await seedStore.saveMessage({
        id: hiddenMessageId,
        sessionID: legacyForkSessionId,
        role: "user",
        time: { created: 1 },
        agent: "zcode-agent",
        model: {
          providerID: "glm" as ModelProviderId,
          modelID: "glm-4-air" as ModelId,
          variant: "deep",
        },
        metadata: { forkOrigin },
        semantics: {
          origin: "system",
          kind: "fork_notice",
          uiVisibility: "hidden",
          providerVisibility: "hidden",
          transcriptVisibility: "hidden",
        },
        source: "fork",
        synthetic: true,
        visibility: "model-only",
        tools: {},
      });
      await seedStore.savePart({
        id: `${hiddenMessageId}_text` as MessagePart["id"],
        sessionID: legacyForkSessionId,
        messageID: hiddenMessageId,
        type: "text",
        text: "fork notice",
        synthetic: true,
        time: { start: 1, end: 1 },
      });
      await seedStore.saveMessage({
        id: noticeMessageId,
        sessionID: legacyForkSessionId,
        role: "assistant",
        time: { created: 2, completed: 2 },
        parentID: hiddenMessageId,
        providerID: "glm" as ModelProviderId,
        modelID: "glm-4-air" as ModelId,
        mode: "build",
        agent: "zcode-agent",
        path: { cwd: WORKSPACE_PATH, root: WORKSPACE_PATH },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        metadata: { forkOrigin },
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
      });
      await seedStore.savePart({
        id: `${noticeMessageId}_timeline` as MessagePart["id"],
        sessionID: legacyForkSessionId,
        messageID: noticeMessageId,
        type: "timeline",
        timelineType: "session_fork",
        display: "separator",
        status: "completed",
        parentSessionId: parentSessionId as SessionId,
        targetMessageId: targetMessageId as MessageId,
        time: { start: 2, end: 2 },
      });
    } finally {
      seedStore.close();
    }

    prepareLegacySelectionUpgrade(dbPath);
    const { server, close } = await bootRealRestartedServer(dbPath);
    try {
      await requestResult(server, {
        id: "subscribe-legacy-fork-thought",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(legacyForkSessionId),
          connectionId: "conn-legacy-fork-thought",
          clientMode: "desktop-continuous",
        },
      });
      const frame = conversationTopicFrameSchema.parse(
        takeInitialFrameParams(server, "subscribe-legacy-fork-thought"),
      );
      if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot frame");
      expect(frame.payload.snapshot.config).toMatchObject({
        model: "glm-4-air",
        provider: "glm",
        thought: "",
      });
    } finally {
      await close();
    }
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "%s 冷恢复期间内部 hook 和 MCP 准入事件不刷新活动时间",
    async (clientMode) => {
      const dbPath = join(tempRoot, "sessions.db");
      await seedPersistedSession(dbPath);
      const seedStore = await createSqliteSessionStore({ dbPath });
      const persistedActivityAt = (await seedStore.getSession(SESSION_ID))?.time.updated;
      seedStore.close();
      expect(persistedActivityAt).toBeTypeOf("number");
      const resumeNow = persistedActivityAt! + 60_000;
      const probe: ColdFakeAppProbe = {
        readTodosCalls: 0,
        resumeCalls: 0,
        resumeEventTypes: [
          SessionEventType.HookRunStarted,
          SessionEventType.HookRunProgress,
          SessionEventType.HookRunCompleted,
          SessionEventType.HookRunFailed,
          SessionEventType.HookRunBlocked,
          SessionEventType.WorkspaceHookAdmissionUpdated,
          SessionEventType.WorkspaceMcpAdmissionUpdated,
        ],
      };
      const { server, store } = await bootRestartedServer(dbPath, [], probe);
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(resumeNow);
      try {
        await requestResult(server, {
          id: "subscribe-resume-activity",
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: conversationTopic(SESSION_ID),
            connectionId: "conn-resume-activity",
            clientMode,
          },
        });
        takeInitialFrameParams(server, "subscribe-resume-activity");

        await requestResult(server, {
          id: "index-resume-activity",
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: sessionsIndexTopic(WORKSPACE_PATH),
            connectionId: "conn-index-resume-activity",
            clientMode,
          },
        });
        const frame = sessionsIndexTopicFrameSchema.parse(
          takeInitialFrameParams(server, "index-resume-activity"),
        );
        if (frame.payload.kind !== "snapshot") {
          throw new Error("Expected sessions-index snapshot frame");
        }
        expect(
          frame.payload.snapshot.sessions.find((session) => session.sessionId === SESSION_ID)
            ?.lastActivityAt,
        ).toBe(persistedActivityAt);
        expect((await store.getSession(SESSION_ID))?.time.updated).toBe(persistedActivityAt);
      } finally {
        nowSpy.mockRestore();
        store.close();
      }
    },
  );

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "%s 冷恢复后同步追加消息模式不刷新活动时间",
    async (clientMode) => {
      const dbPath = join(tempRoot, "followup-activity.db");
      await seedPersistedSession(dbPath);
      const seedStore = await createSqliteSessionStore({ dbPath });
      const persistedActivityAt = (await seedStore.getSession(SESSION_ID))!.time.updated;
      seedStore.close();
      const { server, close } = await bootRealRestartedServer(dbPath);
      try {
        await requestResult(server, {
          id: "followup-resume",
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: conversationTopic(SESSION_ID),
            connectionId: "followup-resume",
            clientMode,
          },
        });
        const resumed = conversationTopicFrameSchema.parse(
          takeInitialFrameParams(server, "followup-resume"),
        );
        if (resumed.payload.kind !== "snapshot") throw new Error("Expected snapshot");
        let revision = resumed.payload.snapshot.revision;

        // 打开历史会话会自动同步全局偏好；重复同步和反向切换都只改变配置。
        for (const [index, mode] of (["guide", "guide", "queue"] as const).entries()) {
          const commandId = `followup-config-${index}`;
          expect(
            await requestResult(server, {
              id: commandId,
              method: V4_METHODS.command,
              params: {
                commandId,
                clientId: "followup-activity-test",
                sessionId: SESSION_ID,
                baseRevision: revision,
                type: "setFollowupMode",
                payload: { mode },
                issuedAt: Date.now(),
              },
            }),
          ).toMatchObject({ status: "accepted" });

          const conversationId = `followup-conversation-${index}`;
          await requestResult(server, {
            id: conversationId,
            method: V4_METHODS.conversationSubscribe,
            params: {
              topic: conversationTopic(SESSION_ID),
              connectionId: conversationId,
              clientMode,
            },
          });
          const conversation = conversationTopicFrameSchema.parse(
            takeInitialFrameParams(server, conversationId),
          );
          if (conversation.payload.kind !== "snapshot") throw new Error("Expected snapshot");
          expect(conversation.payload.snapshot.config.followupMode).toBe(mode);
          revision = conversation.payload.snapshot.revision;

          const indexId = `followup-index-${index}`;
          await requestResult(server, {
            id: indexId,
            method: V4_METHODS.conversationSubscribe,
            params: {
              topic: sessionsIndexTopic(WORKSPACE_PATH),
              connectionId: indexId,
              clientMode,
            },
          });
          const frame = sessionsIndexTopicFrameSchema.parse(
            takeInitialFrameParams(server, indexId),
          );
          if (frame.payload.kind !== "snapshot") throw new Error("Expected index snapshot");
          expect(
            frame.payload.snapshot.sessions.find((session) => session.sessionId === SESSION_ID)
              ?.lastActivityAt,
          ).toBe(persistedActivityAt);
        }
      } finally {
        await close();
      }
    },
  );

  it("重启后冷订阅：旧 transcript 无档位时留空，不读取 task-index 提示", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    prepareLegacySelectionUpgrade(dbPath);

    const { server, close } = await bootRealRestartedServer(dbPath);
    try {
      await requestResult(server, {
        id: "subscribe-legacy-thought",
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-legacy-thought",
          clientMode: "desktop-continuous",
          // 旧消息没有档位，桌面提示不能替用户补选。
          resumeThoughtLevel: "deep",
        },
      });
      const frame = conversationTopicFrameSchema.parse(
        takeInitialFrameParams(server, "subscribe-legacy-thought"),
      );
      if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot frame");
      expect(frame.payload.snapshot.config).toMatchObject({
        model: "glm-4-air",
        provider: "glm",
        thought: "",
        thoughtLevels: ["medium", "deep"],
      });
    } finally {
      await close();
    }
  });

  it("远端 identity 历史会话冷恢复后沿用持久化 identity，sendText 成功", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath, REMOTE_WORKSPACE_IDENTITY);
    const sentInputs: Array<{ text: string }> = [];
    const { server, store } = await bootRestartedServer(dbPath, sentInputs);
    try {
      await requestResult(server, {
        id: 2,
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic(SESSION_ID),
          connectionId: "conn-remote-desktop",
          clientMode: "desktop-continuous",
        },
      });

      const ack = commandAckSchema.parse(
        await requestResult(server, {
          id: 3,
          method: V4_METHODS.command,
          params: {
            commandId: "cmd-remote-cold-send",
            clientId: "client-remote-cold",
            sessionId: SESSION_ID,
            type: "sendText",
            payload: { text: "远端重连后的新问题" },
            issuedAt: 1_700_000_100_000,
          },
        }),
      );
      expect(ack.status).toBe("accepted");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sentInputs).toEqual([{ text: "远端重连后的新问题" }]);
    } finally {
      store.close();
    }
  });

  it("store 无此会话：订阅报 fault.subscribe.sessionNotFound（binder notFound 分型）", async () => {
    const dbPath = join(tempRoot, "sessions.db");
    await seedPersistedSession(dbPath);
    const sentInputs: Array<{ text: string }> = [];
    const { server, store } = await bootRestartedServer(dbPath, sentInputs);
    try {
      const response = await server.handleMessage({
        id: 1,
        method: V4_METHODS.conversationSubscribe,
        params: {
          topic: conversationTopic("sess_never_existed"),
          connectionId: "conn-desktop",
          clientMode: "desktop-continuous",
        },
      } as ZCodeProtocolMessage);
      if (!response || !("error" in response)) {
        throw new Error(`Expected protocol error response: ${JSON.stringify(response)}`);
      }
      expect(response.error.message).toContain("fault.subscribe.sessionNotFound");
    } finally {
      store.close();
    }
  });
});

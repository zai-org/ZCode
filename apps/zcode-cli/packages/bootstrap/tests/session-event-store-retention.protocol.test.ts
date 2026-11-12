import { describe, expect, it, vi } from "vitest";
import {
  InMemorySessionEventStore,
  SessionEventType,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionEventsResultSchema,
  zcodeSessionStateSnapshotSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import type { ZCodeAppOptions } from "../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = {
  workspacePath: "/workspace/retention",
  workspaceKey: "/workspace/retention",
};

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

interface Harness {
  server: ZCodeProtocolAgentServer;
  stores: InMemorySessionEventStore[];
  factoryCalls: string[];
  eventStore: () => ZCodeAppOptions["eventStore"];
  liveSink: () => ((event: SessionEvent) => void | Promise<void>) | undefined;
}

function createHarness(): Harness {
  const stores: InMemorySessionEventStore[] = [];
  const factoryCalls: string[] = [];
  let eventStore: ZCodeAppOptions["eventStore"];
  let liveSink: ((event: SessionEvent) => void | Promise<void>) | undefined;
  const server = new ZCodeProtocolAgentServer({
    createSessionEventStore: (sessionId) => {
      factoryCalls.push(sessionId);
      const store = new InMemorySessionEventStore();
      stores.push(store);
      return store;
    },
    createZCodeApp: (options) => {
      eventStore = options?.eventStore;
      const app = createFakeApp(options);
      return {
        ...app,
        runtime: {
          ...app.runtime,
          subscribeEvents: (sink: {
            onSessionEvent(event: SessionEvent): void | Promise<void>;
          }) => {
            liveSink = sink.onSessionEvent;
            return () => {};
          },
        } as never,
      };
    },
    cwd: workspace.workspacePath,
    version: "test-version",
  });
  // 与 zcode-protocol.test.ts 的 setTestNotificationSink 一致：server 创建 session 时会向客户端
  // 反向请求 runtime 偏好，不应答就会一直等到超时。
  server.setNotificationSink((message) => {
    if (
      "id" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    ) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: true },
      });
    }
  });
  return {
    server,
    stores,
    factoryCalls,
    eventStore: () => eventStore,
    liveSink: () => liveSink,
  };
}

async function createSubscribedSession(harness: Harness): Promise<string> {
  const created = zcodeSessionStateSnapshotSchema.parse(
    await requestResult(harness.server, {
      id: 1,
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace },
    }),
  );
  await requestResult(harness.server, {
    id: 2,
    method: zcodeProtocolMethods.sessionSubscribe,
    params: {
      sessionId: created.session.sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    },
  });
  return created.session.sessionId;
}

describe("session event store retention (protocol)", () => {
  it("分配诊断的轻量计数不遍历历史事件，完整统计保留既有字段", async () => {
    const h = createHarness();
    await createSubscribedSession(h);
    const readStats = vi.spyOn(h.stores[0]!, "getStats").mockReturnValue({
      sessions: 1,
      events: 23,
      evictedEvents: 2,
      retainedTransient: 3,
    });
    const cheap = h.server.collectMemoryDiagnostics({ includeEventStats: false });
    expect(cheap.sessions).toBe(1);
    expect(cheap).not.toHaveProperty("eventRows");
    expect(readStats).not.toHaveBeenCalled();
    expect(h.server.collectMemoryDiagnostics()).toMatchObject({
      sessions: 1,
      eventRows: 23,
      eventEvicted: 2,
      eventTransientRetained: 3,
    });
    expect(readStats).toHaveBeenCalledTimes(1);
  });
  it("RET-006 record 使用注入的 event store 工厂，session/close 后调用 deleteSession", async () => {
    const harness = createHarness();
    const sessionId = await createSubscribedSession(harness);

    expect(harness.factoryCalls).toEqual([sessionId]);
    expect(harness.eventStore()).toBe(harness.stores[0]);
    const deleteSpy = vi.spyOn(harness.stores[0]!, "deleteSession");

    await requestResult(harness.server, {
      id: 3,
      method: zcodeProtocolMethods.sessionClose,
      params: { sessionId },
    });

    expect(deleteSpy).toHaveBeenCalledWith(sessionId);
  });

  it("RET-007 上一 turn 的 delta 在下一 turn 开始后不再回放，协议 seq 仍严格递增", async () => {
    const harness = createHarness();
    const sessionId = await createSubscribedSession(harness);
    const store = harness.stores[0]!;
    const emitStoredEvent = async (event: SessionEvent) => {
      const eventStore = harness.eventStore();
      const liveSink = harness.liveSink();
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      const storedEvent = await eventStore.append(event);
      await liveSink(storedEvent);
    };
    const base = (id: string, turnId: string) => ({
      id: id as SessionEvent["id"],
      sessionId: sessionId as SessionId,
      sequenceNumber: 0,
      timestamp: new Date(7),
      traceId: "trace_retention" as SessionEvent["traceId"],
      turnId: turnId as SessionEvent["turnId"],
    });
    const turnComplete = {
      duration: 1,
      response: "done",
      resultType: "success",
      tokenCount: 2,
      toolCallCount: 0,
    };

    await emitStoredEvent({
      ...base("evt_t1_started", "turn_1"),
      payload: { turnNumber: 1, input: "hi" },
      type: SessionEventType.TurnStarted,
    });
    for (let index = 1; index <= 3; index += 1) {
      await emitStoredEvent({
        ...base(`evt_t1_delta_${index}`, "turn_1"),
        payload: { delta: `d${index}`, done: false, kind: "text_delta" },
        type: SessionEventType.ModelStreaming,
      });
    }
    await emitStoredEvent({
      ...base("evt_t1_complete", "turn_1"),
      payload: turnComplete,
      type: SessionEventType.TurnComplete,
    });

    // 一 turn 滞后：turn 1 刚结束，delta 仍可回放。
    const beforeNextTurn = zcodeSessionEventsResultSchema.parse(
      await requestResult(harness.server, {
        id: 10,
        method: zcodeProtocolMethods.sessionEvents,
        params: { sessionId, afterSeq: 0 },
      }),
    );
    expect(beforeNextTurn.events.some((event) => event.type === "model.streaming")).toBe(true);
    expect(store.getStats().evictedEvents).toBe(0);

    await emitStoredEvent({
      ...base("evt_t2_started", "turn_2"),
      payload: { turnNumber: 2, input: "again" },
      type: SessionEventType.TurnStarted,
    });

    const afterNextTurn = zcodeSessionEventsResultSchema.parse(
      await requestResult(harness.server, {
        id: 11,
        method: zcodeProtocolMethods.sessionEvents,
        params: { sessionId, afterSeq: 0 },
      }),
    );
    expect(afterNextTurn.events.some((event) => event.type === "model.streaming")).toBe(false);
    expect(afterNextTurn.events.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt_t1_started", "evt_t1_complete", "evt_t2_started"]),
    );
    const seqs = afterNextTurn.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(store.getStats()).toMatchObject({ evictedEvents: 3, retainedTransient: 0 });
    // 序号计数器不回退：淘汰 3 条后新事件仍拿到更大的 seq。
    expect(await store.getLatestSequenceNumber(sessionId as SessionId)).toBeGreaterThanOrEqual(6);
  });

  it("RET-010 turn 结束后没有后继 turn：超过 grace 由 60s 节拍的 pruneSessionEventStores 淘汰", async () => {
    const harness = createHarness();
    const sessionId = await createSubscribedSession(harness);
    const store = harness.stores[0]!;
    const emitStoredEvent = async (event: SessionEvent) => {
      const eventStore = harness.eventStore();
      const liveSink = harness.liveSink();
      if (!eventStore || !liveSink) {
        throw new Error("Expected fake app event sink to be wired");
      }
      await liveSink(await eventStore.append(event));
    };
    const base = (id: string) => ({
      id: id as SessionEvent["id"],
      sessionId: sessionId as SessionId,
      sequenceNumber: 0,
      timestamp: new Date(7),
      traceId: "trace_retention_prune" as SessionEvent["traceId"],
      turnId: "turn_only" as SessionEvent["turnId"],
    });
    await emitStoredEvent({
      ...base("evt_only_started"),
      payload: { turnNumber: 1, input: "hi" },
      type: SessionEventType.TurnStarted,
    });
    await emitStoredEvent({
      ...base("evt_only_delta"),
      payload: { delta: "d", done: false, kind: "text_delta" },
      type: SessionEventType.ModelStreaming,
    });
    await emitStoredEvent({
      ...base("evt_only_complete"),
      payload: {
        duration: 1,
        response: "done",
        resultType: "success",
        tokenCount: 1,
        toolCallCount: 0,
      },
      type: SessionEventType.TurnComplete,
    });

    // grace 内不淘汰。
    expect(harness.server.pruneSessionEventStores(Date.now() + 60_000)).toBe(0);
    expect(store.getStats().retainedTransient).toBe(1);
    // 超过 grace 淘汰，回放不再含 model.streaming。
    expect(harness.server.pruneSessionEventStores(Date.now() + 3 * 60_000)).toBe(1);
    const replayed = zcodeSessionEventsResultSchema.parse(
      await requestResult(harness.server, {
        id: 20,
        method: zcodeProtocolMethods.sessionEvents,
        params: { sessionId, afterSeq: 0 },
      }),
    );
    expect(replayed.events.some((event) => event.type === "model.streaming")).toBe(false);
    expect(replayed.events.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt_only_started", "evt_only_complete"]),
    );
  });
});

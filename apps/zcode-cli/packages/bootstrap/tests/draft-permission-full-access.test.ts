import { describe, expect, it, vi } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionId, SessionEventType } from "@zcode/contracts";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

async function fixture() {
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const events = createInMemorySessionEventStore();
  const sessionId = createSessionId("draft-permission");
  const options = {
    env: {},
    sessionId,
    sessionStore: store,
    eventStore: events,
    skipUserConfig: true,
    // 此夹具只验证授权与 SQLite；隔离目录 MCP 自动连接，真实工具链由 Electron E2E 验证。
    runtimeConfig: {
      workingDirectory: process.cwd(),
      mode: "build" as const,
      mcp: { enabled: false },
    },
    modelExecutor: {
      async generateText() {
        return {
          finishReason: "stop" as const,
          text: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    },
  };
  const app = await createRegistryBackedTestApp(options);
  return {
    app,
    store,
    events,
    sessionId,
    options,
    async close() {
      await app.close();
      store.close();
    },
  };
}

describe("草稿完全访问与真实 SQLite 外键", () => {
  it("重复审批复用已发布事件且不登记任务", async () => {
    const f = await fixture();
    try {
      const first = await f.app.runtime.grantPermissionFullAccess("retry-grant");
      const retry = await f.app.runtime.grantPermissionFullAccess("retry-grant");
      expect(retry).toBe(first);
      expect(
        (await f.events.getEvents(f.sessionId)).filter(
          (event) => event.type === SessionEventType.SessionModeChanged,
        ),
      ).toHaveLength(1);
      expect(f.store.debugCounts(f.sessionId)).toMatchObject({
        sessions: 0,
        sessionEntries: 0,
        messages: 0,
      });
    } finally {
      await f.close();
    }
  });
  it("授权不登记任务，首发保存当前权限，冷恢复沿用权限", async () => {
    const f = await fixture();
    try {
      await f.app.runtime.grantPermissionFullAccess("draft-grant");
      expect(f.app.getMode()).toBe("yolo");
      expect(await f.store.getSession(f.sessionId)).toBeNull();
      expect(await f.store.sessionEntries({ sessionID: f.sessionId })).toEqual([]);
      expect(await f.store.messages({ sessionID: f.sessionId })).toEqual([]);
      expect(
        (await f.events.getEvents(f.sessionId)).filter(
          (e) => e.type === SessionEventType.SessionModeChanged,
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            mode: "yolo",
            permissionGrant: { interactionId: "draft-grant", queueItemIds: [] },
          }),
        }),
      ]);
      await f.app.submitPrompt("first message");
      expect((await f.store.getSession(f.sessionId))?.permission).toMatchObject({ mode: "yolo" });
      expect(
        await f.store.sessionEntries({ sessionID: f.sessionId, type: "runtime/execution_state" }),
      ).toEqual([expect.objectContaining({ data: expect.objectContaining({ mode: "yolo" }) })]);
      expect(
        await f.store.sessionEntries({
          sessionID: f.sessionId,
          type: "runtime/permission_full_access",
        }),
      ).toEqual([]);
      await f.app.close();
      const resumed = await createRegistryBackedTestApp({
        ...f.options,
        eventStore: createInMemorySessionEventStore(),
        resume: true,
        runtimeConfig: { workingDirectory: process.cwd(), mcp: { enabled: false } },
      });
      try {
        await resumed.resume();
        expect(resumed.getMode()).toBe("yolo");
      } finally {
        await resumed.close();
      }
    } finally {
      await f.close();
    }
  });

  it.each(["before", "during"] as const)(
    "持久化在授权准备 %s 开始时，先等它完成再提交授权",
    async (order) => {
      const f = await fixture();
      const gate = Promise.withResolvers<void>();
      const readGate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      try {
        const create = f.store.createSession.bind(f.store);
        vi.spyOn(f.store, "createSession").mockImplementationOnce(async (input) => {
          await gate.promise;
          return create(input);
        });
        const commit = vi.spyOn(f.store, "commitPermissionFullAccess");
        const read = f.store.sessionEntries.bind(f.store);
        vi.spyOn(f.store, "sessionEntries").mockImplementationOnce(async (input) => {
          entered.resolve();
          await readGate.promise;
          return read(input);
        });
        const persist =
          order === "before"
            ? f.app.runtime.ensureSessionPersistedForExternalActivity("external activity")
            : null;
        const grant = f.app.runtime.grantPermissionFullAccess("concurrent-grant");
        await entered.promise;
        const during =
          order === "during"
            ? f.app.runtime.ensureSessionPersistedForExternalActivity("external activity")
            : null;
        readGate.resolve();
        // 观察拒绝避免测试故障成为未处理 rejection；释放持久化后再断言原 Promise。
        void grant.catch(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(commit).not.toHaveBeenCalled();
        gate.resolve();
        await persist;
        await during;
        await grant;
        expect(commit).toHaveBeenCalledOnce();
        expect(f.app.getMode()).toBe("yolo");
        expect(
          await f.store.sessionEntries({ sessionID: f.sessionId, type: "runtime/execution_state" }),
        ).toEqual([expect.objectContaining({ data: expect.objectContaining({ mode: "yolo" }) })]);
      } finally {
        gate.resolve();
        readGate.resolve();
        await f.close();
      }
    },
  );
});

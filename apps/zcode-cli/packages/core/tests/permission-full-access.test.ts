import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { applyRuntimeExecutionState } from "../src/runtime/execution-state.js";
import { grantPermissionMode } from "../src/runtime/permission-full-access.js";

function fixture() {
  const inputs = [
    {
      pendingInputId: "a",
      intent: { mode: "build", planEnabled: true, modelSelection: { modelId: "one" } },
    },
    { pendingInputId: "b", intent: { mode: "edit", planEnabled: false } },
  ];
  let receipt: unknown;
  const runtime = {
    sessionId: "session",
    sessionPersisted: true,
    config: { mode: "edit", planEnabled: true },
    rootTraceContext: {},
    pendingInputReservations: new Map(),
    activeTurn: {
      pendingInputs: inputs.map((item) => ({ id: item.pendingInputId, intent: item.intent })),
    },
    rebuildProjection: vi.fn(async () => ({ pendingSteerInputs: inputs })),
    sessionStore: {
      sessionEntries: vi.fn(async () =>
        receipt ? [{ id: "session:permission-full-access:permission-1", data: receipt }] : [],
      ),
      commitPermissionFullAccess: vi.fn(async (input) => {
        receipt = input.receipt.data;
      }),
    },
    createEvent: vi.fn((type, payload) => ({
      id: "grant-event",
      type,
      payload,
      sessionId: "session",
      traceId: "trace",
      timestamp: new Date(),
      sequenceNumber: 0,
    })),
    appendEvent: vi.fn(async () => {}),
    eventStore: { getEvents: vi.fn(async () => []) },
    notifyEventSinks: vi.fn(async () => {}),
  };
  return {
    runtime,
    grant: (mode: "guarded" | "yolo" = "yolo") =>
      grantPermissionMode.call(runtime as unknown as AgentRuntimeInternal, "permission-1", mode),
  };
}

describe("审批框完全访问", () => {
  it("草稿只授权内存，发布失败重试复用原事件，不覆盖后来的模式", async () => {
    const { runtime, grant } = fixture();
    runtime.sessionPersisted = false;
    runtime.rebuildProjection.mockResolvedValue({ pendingSteerInputs: [] });
    runtime.activeTurn.pendingInputs = [];
    const published: unknown[] = [];
    runtime.createEvent.mockImplementation((type, payload) => ({
      id: `event-${runtime.createEvent.mock.calls.length}`,
      type,
      payload,
      sessionId: "session",
      traceId: "trace",
      timestamp: new Date(),
      sequenceNumber: 0,
    }));
    runtime.appendEvent.mockRejectedValueOnce(new Error("event failed"));
    await expect(grant()).rejects.toThrow("event failed");
    expect(runtime.config.mode).toBe("yolo");
    runtime.appendEvent.mockImplementation(async (event) => {
      published.push(event);
    });
    runtime.eventStore.getEvents.mockImplementation(async () => published);
    await applyRuntimeExecutionState(
      runtime as unknown as AgentRuntimeInternal,
      { mode: "build", planEnabled: false },
      { source: "command" },
    );
    await grant();
    expect(runtime.sessionStore.commitPermissionFullAccess).not.toHaveBeenCalled();
    expect(runtime.createEvent).toHaveBeenCalledTimes(2);
    expect(runtime.appendEvent.mock.calls[0]?.[0]).toBe(runtime.appendEvent.mock.calls[1]?.[0]);
    expect(published).toHaveLength(2);
    expect(runtime.config).toEqual({ mode: "build", planEnabled: false });
  });
  it.each(["guarded", "yolo"] as const)(
    "保留 Runtime 和每项 Plan，只更新本次目标为 %s",
    async (mode) => {
      const { runtime, grant } = fixture();
      await grant(mode);
      expect(runtime.config).toEqual({ mode, planEnabled: true });
      expect(runtime.activeTurn.pendingInputs.map((item) => item.intent)).toEqual([
        { mode, planEnabled: true, modelSelection: { modelId: "one" } },
        { mode, planEnabled: false },
      ]);
      expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
      expect(runtime.appendEvent).toHaveBeenCalledOnce();
    },
  );
  it("重试同一请求不能把已保存的自主授权升级为完全访问", async () => {
    const { runtime, grant } = fixture();
    runtime.appendEvent.mockRejectedValueOnce(new Error("event failed"));
    await expect(grant("guarded")).rejects.toThrow("event failed");
    await expect(grant("yolo")).rejects.toMatchObject({
      reasonCode: "fault.permissionGrant.committed.guarded",
    });
    await grant("guarded");
    expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
    expect(runtime.config.mode).toBe("guarded");
  });
  it("授权重试仍严格拒绝损坏 receipt，不重新抓取队列或提交权限", async () => {
    const { runtime, grant } = fixture();
    runtime.sessionStore.sessionEntries.mockResolvedValueOnce([
      {
        id: "session:permission-full-access:permission-1",
        data: { interactionId: "permission-1", event: null },
      },
    ]);
    await expect(grant()).rejects.toThrow();
    expect(runtime.sessionStore.commitPermissionFullAccess).not.toHaveBeenCalled();
    expect(runtime.rebuildProjection).not.toHaveBeenCalled();
    expect(runtime.appendEvent).not.toHaveBeenCalled();
    expect(runtime.config.mode).toBe("edit");
  });
  it("事务失败不改内存，不发布成功", async () => {
    const { runtime, grant } = fixture();
    runtime.sessionStore.commitPermissionFullAccess.mockRejectedValueOnce(new Error("disk full"));
    await expect(grant()).rejects.toThrow("disk full");
    expect(runtime.config.mode).toBe("edit");
    expect(runtime.activeTurn.pendingInputs[0]?.intent.mode).toBe("build");
    expect(runtime.appendEvent).not.toHaveBeenCalled();
  });
  it("提交后事件失败可重试，固定目标不覆盖后来入队消息", async () => {
    const { runtime, grant } = fixture();
    runtime.appendEvent.mockRejectedValueOnce(new Error("event failed"));
    await expect(grant()).rejects.toThrow("event failed");
    runtime.activeTurn.pendingInputs.push({
      id: "later",
      intent: { mode: "edit", planEnabled: false },
    });
    await grant();
    expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
    expect(runtime.activeTurn.pendingInputs.at(-1)?.intent.mode).toBe("edit");
  });
  it("Guide 正在消费或队列已 reserve 时拒绝提权，稍后可重试", async () => {
    const { runtime, grant } = fixture();
    Object.assign(runtime, { pendingInputDrains: 1 });
    await expect(grant()).rejects.toThrow("busy");
    Object.assign(runtime, { pendingInputDrains: 0 });
    runtime.pendingInputReservations.set("a", "reservation");
    await expect(grant()).rejects.toThrow("busy");
    runtime.pendingInputReservations.clear();
    await grant();
    expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
  });
  it("发布失败后改权限，先补旧事件；迟到审批重试不覆盖较新的选择", async () => {
    const { runtime, grant } = fixture();
    const published: unknown[] = [];
    runtime.appendEvent.mockRejectedValueOnce(new Error("event failed"));
    await expect(grant()).rejects.toThrow("event failed");
    runtime.appendEvent.mockImplementation(async (event) => {
      published.push(event);
    });
    runtime.eventStore.getEvents.mockImplementation(async () => published);
    await applyRuntimeExecutionState(
      runtime as unknown as AgentRuntimeInternal,
      { mode: "build", planEnabled: false },
      { source: "command" },
    );
    expect(published.map((event: any) => event.payload.mode)).toEqual(["yolo", "build"]);
    await grant();
    expect(runtime.config).toEqual({ mode: "build", planEnabled: false });
    expect(published).toHaveLength(2);
  });
});

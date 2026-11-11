import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createProtocolInteractionBroker } from "../src/zcode-protocol/interaction-broker.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(approvalMode?: "user-once") {
  const registry = new V4InteractionRegistry();
  const grant = vi.fn(async () => "event");
  const commit = deferred<void>();
  const legacy = deferred<unknown>();
  const waitForPermissionGrantCommit = vi.fn(() => commit.promise);
  const requestClient = vi.fn((_method, _params, _schema, options) => {
    options.signal.addEventListener("abort", () => legacy.reject(new Error("aborted")), {
      once: true,
    });
    return legacy.promise;
  });
  const context = {
    deps: { sessionStore: { commitPermissionFullAccess: vi.fn() } },
    sessions: new Map([["s", { app: { runtime: { grantPermissionMode: grant } } }]]),
    v4Interactions: registry,
    requestClient,
    v4Gateway: { waitForPermissionGrantCommit },
  } as unknown as ZCodeProtocolAgentServerContext;
  const broker = createProtocolInteractionBroker(context);
  const request = {
    requestId: "p",
    sessionId: "s",
    toolName: "Bash",
    toolCallId: "t",
    input: { command: "ping example.com" },
    reason: "approval",
    requestedAt: new Date(),
    ...(approvalMode ? { approvalMode, mode: "guarded" } : {}),
  } as never;
  const claimResponse = vi.fn(() => true);
  const signal = new AbortController();
  const pending = broker.requestPermission(request, { signal: signal.signal, claimResponse });
  return {
    registry,
    grant,
    commit,
    legacy,
    waitForPermissionGrantCommit,
    claimResponse,
    pending,
    signal,
  };
}

describe("审批完全访问 broker 编排", () => {
  it("Guarded 主任务单次审批可显式切到完全访问，不接受重复切到自主模式", async () => {
    const f = fixture("user-once");
    await f.pending.registered;
    await expect(f.registry.resolvePermissionMode("p", "s", "guarded")).rejects.toThrow();
    expect(f.grant).not.toHaveBeenCalled();
    f.commit.resolve();
    await f.registry.resolvePermissionMode("p", "s", "yolo");
    expect(await f.pending).toMatchObject({ decision: "allow" });
    expect(f.grant).toHaveBeenCalledExactlyOnceWith("p", "yolo", f.signal.signal);
  });
  it("事务和投影完成前不放行；提交期间 legacy 应答不能抢先结束", async () => {
    const f = fixture();
    const replied = vi.fn();
    void f.pending.then(replied);
    const response = f.registry.resolvePermissionMode("p", "s", "yolo");
    await vi.waitFor(() => expect(f.waitForPermissionGrantCommit).toHaveBeenCalled());
    f.legacy.resolve({ decision: "deny" });
    await Promise.resolve();
    expect(replied).not.toHaveBeenCalled();
    f.commit.resolve();
    await response;
    expect(await f.pending).toMatchObject({ decision: "allow" });
    expect(f.grant).toHaveBeenCalledExactlyOnceWith("p", "yolo", f.signal.signal);
  });
  it("提交失败保留请求，显式重试成功前没有 allow", async () => {
    const f = fixture();
    f.grant.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.registry.resolvePermissionMode("p", "s", "yolo")).rejects.toThrow("disk full");
    expect(f.registry.has("p")).toBe(true);
    expect(f.waitForPermissionGrantCommit).not.toHaveBeenCalled();
    f.commit.resolve();
    await f.registry.resolvePermissionMode("p", "s", "yolo");
    expect(await f.pending).toMatchObject({ decision: "allow" });
  });
  it("Hook 已赢或请求被取消时不能提交权限", async () => {
    const f = fixture();
    f.claimResponse.mockReturnValue(false);
    await expect(f.registry.resolvePermissionMode("p", "s", "yolo")).rejects.toThrow("settled");
    expect(f.grant).not.toHaveBeenCalled();
    f.signal.abort();
    await expect(f.pending).rejects.toThrow("aborted");
    expect(await f.registry.resolvePermissionMode("p", "s", "yolo")).toBe(false);
  });
});

describe("CR-01 完全访问失败后的应答收口", () => {
  for (const stage of ["grant", "projection"] as const) {
    for (const order of ["before", "after"] as const) {
      it.each(["resolve", "reject"] as const)(
        `${stage} 失败，legacy %s 在失败 ${order} 到达仍收口`,
        async (kind) => {
          const f = fixture();
          const failure = deferred<never>();
          if (stage === "grant") f.grant.mockImplementationOnce(() => failure.promise);
          else f.waitForPermissionGrantCommit.mockImplementationOnce(() => failure.promise);
          const observed = vi.fn();
          const done = f.pending.then(
            (value) => observed({ value }),
            (error) => observed({ error }),
          );
          const legacyError = new Error("permission timeout");
          const settleLegacy = () =>
            kind === "resolve"
              ? f.legacy.resolve({ decision: "deny" })
              : f.legacy.reject(legacyError);
          try {
            const response = f.registry.resolvePermissionMode("p", "s", "yolo");
            const rejected = expect(response).rejects.toThrow("approval failed");
            await vi.waitFor(() =>
              expect(
                stage === "grant" ? f.grant : f.waitForPermissionGrantCommit,
              ).toHaveBeenCalled(),
            );
            if (order === "before") {
              settleLegacy();
              await nextTurn();
              expect(observed).not.toHaveBeenCalled();
            }
            failure.reject(new Error("approval failed"));
            await rejected;
            if (order === "after") settleLegacy();
            await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
            if (kind === "resolve")
              expect(observed).toHaveBeenCalledWith({
                value: expect.objectContaining({ decision: "deny" }),
              });
            else expect(observed).toHaveBeenCalledWith({ error: legacyError });
            expect(f.registry.has("p")).toBe(false);
          } finally {
            f.signal.abort();
            await done;
          }
        },
      );
    }
  }
  it("失败后的重试重新阻挡 legacy，投影提交成功前不能提前放行", async () => {
    const f = fixture();
    const observed = vi.fn();
    const done = f.pending.then(observed, observed);
    try {
      f.grant.mockRejectedValueOnce(new Error("busy"));
      await expect(f.registry.resolvePermissionMode("p", "s", "yolo")).rejects.toThrow("busy");
      const retry = f.registry.resolvePermissionMode("p", "s", "yolo");
      await vi.waitFor(() => expect(f.waitForPermissionGrantCommit).toHaveBeenCalled());
      f.legacy.resolve({ decision: "deny" });
      await nextTurn();
      expect(observed).not.toHaveBeenCalled();
      f.commit.resolve();
      await retry;
      await done;
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ decision: "allow" }));
    } finally {
      f.signal.abort();
      await done;
    }
  });
  it("取消能解除已经进入授权等待的 legacy 超时", async () => {
    const f = fixture();
    const error = new Error("permission timeout");
    const done = f.pending.catch((value) => value);
    const response = f.registry.resolvePermissionMode("p", "s", "yolo");
    await vi.waitFor(() => expect(f.waitForPermissionGrantCommit).toHaveBeenCalled());
    f.legacy.reject(error);
    await nextTurn();
    f.signal.abort();
    expect(await done).toBe(error);
    expect(f.registry.has("p")).toBe(false);
    f.commit.resolve();
    expect(await response).toBe(false);
  });
});

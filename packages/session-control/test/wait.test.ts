import { describe, expect, it, vi } from "vitest";
import { createCliSessionControl } from "#session-control/application/cli/index";
import { createAppSessionControl } from "#session-control/application/app/index";
import {
  createTestPorts,
  deferred,
  createOperationFeed,
  flushMicrotasks,
} from "#session-control/testing/index";
import {
  type CliSessionRef,
  type OperationFeed,
  type OperationRef,
  type OperationSnapshot,
} from "#session-control/contract";

const root: CliSessionRef = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_root" };
const a: OperationRef<CliSessionRef> = {
  session: { ...root, sessionId: "sess_a" },
  sessionId: "sess_a",
  commandId: "a-command",
};
const b: OperationRef<CliSessionRef> = {
  session: { ...root, sessionId: "sess_b" },
  sessionId: "sess_b",
  commandId: "b-command",
};
const snapshot = (
  operation = a,
  status: OperationSnapshot["status"] = "accepted",
  revision = 0,
): OperationSnapshot<CliSessionRef> => ({ operation, epoch: "epoch-1", revision, status });
function fixture() {
  const ports = createTestPorts("cli", root);
  const feedA = createOperationFeed(snapshot(a));
  const feedB = createOperationFeed(snapshot(b));
  ports.cli.observations.open = async (_ctx, operation) =>
    operation.commandId === a.commandId ? feedA : feedB;
  return { ports, feedA, feedB, control: createCliSessionControl(ports.cli), ctx: ports.context };
}

describe("bounded wait", () => {
  it("timeout zero reads all baselines, closes feeds, and releases its acquisition deadline", async () => {
    const { control, ctx, ports, feedA, feedB } = fixture();
    const result = await control.waitSessions(ctx, {
      operations: [a, b],
      mode: "all",
      timeoutMs: 0,
    });
    expect(result.status).toBe("timed_out");
    expect(result.operations.map((value) => value.status)).toEqual(["accepted", "accepted"]);
    expect(feedA.closeCount).toBe(1);
    expect(feedB.closeCount).toBe(1);
    expect(ports.deadlines.pendingCount).toBe(0);
  });
  it("accepted, queued and old idle never satisfy wait; ordered matching terminal does", async () => {
    const { control, ctx, feedA } = fixture();
    let settled = false;
    const result = control.waitSessions(ctx, { operations: [a], mode: "all" }).then((value) => {
      settled = true;
      return value;
    });
    await flushMicrotasks();
    feedA.push({ type: "snapshot", snapshot: snapshot(a, "idle", 1) });
    feedA.push({ type: "snapshot", snapshot: snapshot(a, "queued", 2) });
    await flushMicrotasks();
    expect(settled).toBe(false);
    feedA.push({ type: "snapshot", snapshot: snapshot(a, "completed", 3) });
    await expect(result).resolves.toMatchObject({
      status: "completed",
      operations: [{ status: "completed", revision: 3 }],
    });
    expect(feedA.closeCount).toBe(1);
  });
  it("does not lose updates buffered before open returns", async () => {
    const { control, ctx, feedA } = fixture();
    feedA.push({ type: "snapshot", snapshot: snapshot(a, "completed", 1) });
    await expect(
      control.waitSessions(ctx, { operations: [a], mode: "all" }),
    ).resolves.toMatchObject({ status: "completed" });
  });
  it("any releases all feeds; all waits for every target including needs_attention", async () => {
    const any = fixture();
    const anyResult = any.control.waitSessions(any.ctx, { operations: [a, b], mode: "any" });
    await flushMicrotasks();
    any.feedB.push({ type: "snapshot", snapshot: snapshot(b, "failed", 1) });
    await expect(anyResult).resolves.toMatchObject({ status: "completed" });
    expect(any.feedA.closeCount).toBe(1);
    expect(any.feedB.closeCount).toBe(1);
    const all = fixture();
    let done = false;
    const allResult = all.control
      .waitSessions(all.ctx, { operations: [a, b], mode: "all" })
      .then((value) => {
        done = true;
        return value;
      });
    await flushMicrotasks();
    all.feedA.push({ type: "snapshot", snapshot: snapshot(a, "interrupted", 1) });
    await flushMicrotasks();
    expect(done).toBe(false);
    all.feedB.push({
      type: "snapshot",
      snapshot: {
        ...snapshot(b, "needs_attention", 1),
        attention: { kind: "approval", url: "https://example.com/approval" },
      },
    });
    await expect(allResult).resolves.toMatchObject({
      status: "completed",
      operations: [{ status: "interrupted" }, { status: "needs_attention" }],
    });
  });
  it("deadline returns latest known states and never interrupts targets", async () => {
    const { control, ctx, ports, feedA } = fixture();
    const result = control.waitSessions(ctx, { operations: [a], mode: "all", timeoutMs: 15 });
    await flushMicrotasks();
    feedA.push({ type: "snapshot", snapshot: snapshot(a, "running", 1) });
    await flushMicrotasks();
    ports.deadlines.expireAll();
    await expect(result).resolves.toMatchObject({
      status: "timed_out",
      operations: [{ status: "running" }],
    });
    expect(feedA.closeCount).toBe(1);
    expect(ports.deadlines.pendingCount).toBe(0);
    expect(ports.calls.some((call) => call.method === "interruptSession")).toBe(false);
  });
  it("abort cleans up feeds and deadline without stopping owners", async () => {
    const { control, ctx, ports, feedA, feedB } = fixture();
    const controller = new AbortController();
    const result = control.waitSessions(
      { ...ctx, signal: controller.signal },
      { operations: [a, b], mode: "all" },
    );
    await flushMicrotasks();
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(feedA.closeCount).toBe(1);
    expect(feedB.closeCount).toBe(1);
    expect(ports.deadlines.pendingCount).toBe(0);
  });
  it("closes late successful opens even after cancellation has returned", async () => {
    const { control, ctx, ports, feedA } = fixture();
    const late = deferred<OperationFeed<CliSessionRef>>();
    ports.cli.observations.open = () => late.promise;
    const controller = new AbortController();
    const result = control.waitSessions(
      { ...ctx, signal: controller.signal },
      { operations: [a], mode: "all" },
    );
    await flushMicrotasks();
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    late.resolve(feedA);
    await flushMicrotasks();
    expect(feedA.closeCount).toBe(1);
  });
  it("bounds slow access/open and releases an open that arrives after deadline", async () => {
    const { control, ctx, ports, feedA } = fixture();
    const late = deferred<OperationFeed<CliSessionRef>>();
    ports.cli.observations.open = () => late.promise;
    const result = control.waitSessions(ctx, { operations: [a], mode: "all", timeoutMs: 10 });
    await flushMicrotasks();
    ports.deadlines.expireAll();
    await expect(result).resolves.toMatchObject({ status: "timed_out" });
    late.resolve(feedA);
    await flushMicrotasks();
    expect(feedA.closeCount).toBe(1);
  });
  it("does not open feeds after permission resolution arrives too late", async () => {
    const { control, ctx, ports } = fixture();
    const grant = deferred<{ scope: { kind: "cli"; workspacePath: string }; fence: string }>();
    ports.cli.access.authorize = () => grant.promise;
    const open = vi.fn(ports.cli.observations.open);
    ports.cli.observations.open = open;
    const result = control.waitSessions(ctx, { operations: [a], mode: "all", timeoutMs: 10 });
    await flushMicrotasks();
    ports.deadlines.expireAll();
    await expect(result).resolves.toMatchObject({ status: "timed_out" });
    grant.resolve({ scope: { kind: "cli", workspacePath: "/workspace" }, fence: "epoch" });
    await flushMicrotasks();
    expect(open).not.toHaveBeenCalled();
  });
  it("rejects self-wait, duplicates and unbounded wait before observation", async () => {
    const { control, ctx, ports } = fixture();
    await expect(
      control.waitSessions(ctx, {
        operations: [{ session: root, commandId: "future" }],
        mode: "any",
      }),
    ).rejects.toMatchObject({ code: "self_wait" });
    await expect(
      control.waitSessions(ctx, { operations: [a, a], mode: "any" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      control.waitSessions(ctx, {
        operations: [a],
        mode: "all",
        timeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ports.calls).toEqual([]);
  });
  it("recognizes the same root through equivalent workspace keys", async () => {
    const { control, ctx } = fixture();
    const aliasRoot = { ...root, workspaceIdentity: root.workspacePath };
    await expect(
      control.waitSessions(ctx, {
        operations: [{ session: aliasRoot, commandId: "future" }],
        mode: "all",
      }),
    ).rejects.toMatchObject({ code: "self_wait" });
  });
  it("pre-aborted wait returns cancelled without port calls", async () => {
    const { control, ctx, ports } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      control.waitSessions({ ...ctx, signal: controller.signal }, { operations: [a], mode: "all" }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(ports.calls).toEqual([]);
  });
});

describe("observation validation and cleanup", () => {
  it("authorizes every any target before opening even an already completed feed", async () => {
    const { control, ctx, ports, feedA } = fixture();
    const denied = deferred<never>();
    ports.cli.access.authorize = async (_ctx, request) =>
      request.session?.sessionId === "sess_b"
        ? denied.promise
        : { scope: request.scope, fence: "epoch" };
    feedA.initial.status = "completed";
    const open = vi.fn(ports.cli.observations.open);
    ports.cli.observations.open = open;
    const result = control.waitSessions(ctx, { operations: [a, b], mode: "any" });
    const rejection = expect(result).rejects.toThrow("denied");
    await flushMicrotasks();
    expect(open).not.toHaveBeenCalled();
    denied.reject(new Error("denied"));
    await rejection;
  });
  it("bounds a timeout-zero snapshot acquisition whose open never resolves", async () => {
    const { control, ctx, ports } = fixture();
    ports.cli.observations.open = () => deferred<OperationFeed<CliSessionRef>>().promise;
    const result = control.waitSessions(ctx, { operations: [a], mode: "all", timeoutMs: 0 });
    await flushMicrotasks();
    expect(ports.deadlines.pendingCount).toBe(1);
    ports.deadlines.expireAll();
    await expect(result).resolves.toMatchObject({
      status: "timed_out",
      operations: [{ status: "unknown" }],
    });
    expect(ports.deadlines.pendingCount).toBe(0);
  });
  it("does not retain abort listeners when deadline construction throws", async () => {
    const { control, ctx, ports } = fixture();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    ports.cli.deadlines = {
      create() {
        throw new Error("deadline unavailable");
      },
    };
    await expect(
      control.waitSessions({ ...ctx, signal: controller.signal }, { operations: [a], mode: "all" }),
    ).rejects.toThrow("deadline unavailable");
    expect(add.mock.calls.length - remove.mock.calls.length).toBe(0);
    expect(ports.calls).toEqual([]);
  });
  it.each(["epoch", "revision", "identity", "schema"])(
    "returns unknown on %s corruption and closes the feed",
    async (kind) => {
      const { control, ctx, feedA } = fixture();
      const result = control.waitSessions(ctx, { operations: [a], mode: "all" });
      await flushMicrotasks();
      const update = snapshot(a, "completed", 1);
      if (kind === "epoch") update.epoch = "epoch-2";
      if (kind === "revision") update.revision = 0;
      if (kind === "identity") update.operation = b;
      if (kind === "schema") Object.assign(update, { extra: "untrusted" });
      feedA.push({ type: "snapshot", snapshot: update });
      await expect(result).resolves.toMatchObject({
        status: "unknown",
        operations: [{ status: "unknown" }],
      });
      expect(feedA.closeCount).toBe(1);
    },
  );
  it("invalidated, disconnect and iterator errors never masquerade as completion", async () => {
    for (const kind of ["invalidated", "disconnect", "error"] as const) {
      const { control, ctx, feedA } = fixture();
      const result = control.waitSessions(ctx, { operations: [a], mode: "all" });
      await flushMicrotasks();
      if (kind === "invalidated")
        feedA.push({ type: "invalidated", operation: a, reason: "connection generation changed" });
      if (kind === "disconnect") feedA.end();
      if (kind === "error") feedA.fail(new Error("stream failed"));
      await expect(result).resolves.toMatchObject({ status: "unknown" });
      expect(feedA.closeCount).toBe(1);
    }
  });
  it("preserves an open error, closes established feeds and cleans up late opens", async () => {
    const { control, ctx, ports, feedA } = fixture();
    const openingB = deferred<OperationFeed<CliSessionRef>>();
    ports.cli.observations.open = async (_ctx, operation) =>
      operation.commandId === a.commandId ? feedA : openingB.promise;
    const result = control.waitSessions(ctx, { operations: [a, b], mode: "all" });
    const rejection = expect(result).rejects.toThrow("open failed");
    await flushMicrotasks();
    openingB.reject(new Error("open failed"));
    await rejection;
    expect(feedA.closeCount).toBe(1);
    expect(ports.deadlines.pendingCount).toBe(0);
  });
  it("still releases feeds if deadline close fails", async () => {
    const { control, ctx, ports, feedA } = fixture();
    feedA.initial.status = "completed";
    ports.cli.deadlines = {
      create() {
        return {
          expired: deferred<void>().promise,
          close() {
            throw new Error("deadline release failed");
          },
        };
      },
    };
    await expect(control.waitSessions(ctx, { operations: [a], mode: "all" })).rejects.toThrow(
      "deadline release failed",
    );
    expect(feedA.closeCount).toBe(1);
  });
  it("does not swallow close errors as successful completion", async () => {
    const { control, ctx, feedA } = fixture();
    feedA.initial.status = "completed";
    feedA.close = async () => {
      throw new Error("release failed");
    };
    await expect(
      control.waitSessions(ctx, { operations: [a], mode: "all", timeoutMs: 0 }),
    ).rejects.toThrow("release failed");
  });
  it("App waits use exactly the same observation rules", async () => {
    const appRoot = {
      kind: "app" as const,
      workspacePath: "/workspace",
      sourceServerId: "source",
      sessionId: "sess_root",
    };
    const ports = createTestPorts("app", appRoot);
    const operation = {
      session: { ...appRoot, sessionId: "sess_target" },
      sessionId: "sess_target",
      commandId: "command",
    };
    const feed = createOperationFeed({
      operation,
      epoch: "app-epoch",
      revision: 9,
      status: "queued",
    });
    ports.app.observations.open = async () => feed;
    const control = createAppSessionControl(ports.app);
    const result = control.waitSessions(ports.context, { operations: [operation], mode: "any" });
    await flushMicrotasks();
    feed.push({
      type: "snapshot",
      snapshot: { operation, epoch: "app-epoch", revision: 10, status: "completed" },
    });
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(feed.closeCount).toBe(1);
  });
});

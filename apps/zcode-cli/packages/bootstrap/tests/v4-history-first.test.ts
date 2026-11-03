import { SessionLifecycleController } from "../src/session-lifecycle/index.js";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it, vi } from "vitest";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(
  lookupTranscriptCommand?: () => {
    commandId: string;
    status: "accepted";
    revisionAtDecision: number;
  },
  retainSessionRuntime?: () => Promise<() => void>,
) {
  const gate = deferred();
  const frames: ConversationTopicFrame[] = [];
  let observed: ConversationSnapshot | undefined;
  const execute = vi.fn();
  const resume = vi.fn(async () => {
    await gate.promise;
    return { status: "resumed" as const, persistedMessages: [] };
  });
  const read = vi.fn(async () => []);
  const loadPersistedEvents = vi.fn(async () => ({
    events: [],
    synthesized: true,
    sourceEventSeq: 0,
  }));
  const gateway = new ConversationV4Gateway({
    sessionExists: () => false,
    executeCommand: execute,
    lookupTranscriptCommand,
    retainSessionRuntime,
    loadPersistedMessages: read,
    resumePersistedSession: resume,
    loadPersistedEvents,
    emitWireFrame: (wire) => {
      if (wire.kind === "complete") {
        const frame = wire.frame as ConversationTopicFrame;
        frames.push(frame);
        if (frame.payload.kind === "snapshot") observed = frame.payload.snapshot;
        else if (observed)
          observed = {
            ...applyConversationDeltas(observed, frame.payload.deltas),
            seq: frame.toSeq,
          };
      }
    },
  });
  const params = {
    topic: "conversation/history",
    connectionId: "desktop",
    clientMode: "desktop-continuous",
    historyFirst: true,
  };
  const snapshot = () => observed;
  return {
    gateway,
    gate,
    frames,
    execute,
    resume,
    read,
    params,
    snapshot,
    loadPersistedEvents,
    seed: (frame: ConversationTopicFrame | null) => {
      if (frame?.payload.kind === "snapshot") observed = frame.payload.snapshot;
    },
  };
}

function setupOwned() {
  const fixture = setup();
  const activate = vi.fn(
    async (_messages: import("@zcode/contracts").MessageWithParts[]) => undefined,
  );
  let active = false;
  const lifecycle = new SessionLifecycleController({
    exists: async () => true,
    validateActivation: async () => {},
    hasRuntime: () => active,
    assertCanStop: () => {},
    activate: async () => {
      const messages = await fixture.gateway.prepareSessionHistory("history");
      await activate(messages);
      active = true;
    },
    release: async (_id, failed) => {
      active = false;
      if (!failed) await fixture.gateway.releaseSessionProjection("history");
    },
  });
  fixture.resume.mockImplementation(async () => {
    await lifecycle.ensureReady("history");
    return { status: "resumed", persistedMessages: [] };
  });
  return { ...fixture, lifecycle, activate };
}

describe("history-first cold subscription", () => {
  it("retries a failed owned activation without waiting on the old failed publisher", async () => {
    const { gateway, lifecycle, activate, params, seed, snapshot } = setupOwned();
    activate.mockRejectedValueOnce(new Error("startup failed"));
    await expect(lifecycle.ensureReady("history")).rejects.toThrow("startup failed");
    await lifecycle.ensureReady("history");
    expect(activate).toHaveBeenCalledTimes(2);
    seed((await gateway.subscribe(params)).initialFrame);
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    gateway.dispose();
  });

  it("rejects late subscription and command admission while the session is stopping", async () => {
    const executeCommand = vi.fn();
    const gateway = new ConversationV4Gateway({
      sessionExists: () => true,
      isSessionStopping: () => true,
      executeCommand,
      emitWireFrame: () => {},
    });
    await expect(
      gateway.subscribe({
        topic: "conversation/history",
        connectionId: "desktop",
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("fault.sessionLifecycle.stopping");
    await expect(
      gateway.handleCommand({
        sessionId: "history",
        commandId: "late-rename",
        clientId: "desktop",
        issuedAt: 1,
        type: "renameSession",
        payload: { title: "late" },
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(executeCommand).not.toHaveBeenCalled();
    gateway.dispose();
  });

  it("waits for old final hydration before releasing the publisher", async () => {
    const { gateway, lifecycle, loadPersistedEvents } = setupOwned();
    const hydrationEntered = deferred();
    const hydrationGate = deferred();
    loadPersistedEvents
      .mockImplementationOnce(async () => ({ events: [], synthesized: true, sourceEventSeq: 0 }))
      .mockImplementationOnce(async () => {
        hydrationEntered.resolve();
        await hydrationGate.promise;
        return { events: [], synthesized: true, sourceEventSeq: 0 };
      });
    await lifecycle.ensureReady("history");
    await hydrationEntered.promise;
    let released = false;
    const release = gateway.releaseSessionProjection("history").then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    hydrationGate.resolve();
    await release;
    expect(released).toBe(true);
    gateway.dispose();
  });

  it("opens fresh history during an externally owned restart without recursively resuming", async () => {
    const { gateway, lifecycle, activate, params, read, snapshot, seed } = setupOwned();
    const gate = deferred();
    activate.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const restarting = lifecycle.restart("history");
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    seed((await gateway.subscribe(params)).initialFrame);
    expect(snapshot()?.runtimeInitialization?.status).toBe("initializing");
    expect(read).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    gate.resolve();
    await restarting;
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    gateway.dispose();
  });

  it("completes an externally owned restart without any subscriber", async () => {
    const { gateway, lifecycle, activate } = setupOwned();
    await lifecycle.restart("history");
    expect(activate).toHaveBeenCalledTimes(1);
    gateway.dispose();
  });
  it.each(["desktop-continuous", "web-remote-replayable"])(
    "%s preserves project directories alongside the persisted history snapshot",
    async (clientMode) => {
      const { gateway, gate, resume, params, snapshot, seed } = setup();
      const workspace = { workspacePath: "/project", workspaceKey: "/project" };
      const additionalDirectories = ["/shared"];
      seed(
        (await gateway.subscribe({ ...params, clientMode, workspace, additionalDirectories }))
          .initialFrame,
      );
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      expect(resume).toHaveBeenCalledWith(
        "history",
        undefined,
        workspace,
        additionalDirectories,
        [],
      );
      gate.resolve();
      await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
      gateway.dispose();
    },
  );

  it("publishes history before activation and rejects execution while restoring", async () => {
    const { gateway, gate, resume, read, execute, params, snapshot, seed } = setup();
    const dispatch = await gateway.subscribeReserved(params);
    expect(resume).not.toHaveBeenCalled();
    expect(dispatch.initialFrame?.payload.kind).toBe("snapshot");
    if (dispatch.initialFrame?.payload.kind !== "snapshot") throw new Error("missing history");
    expect(dispatch.initialFrame.payload.snapshot.runtimeInitialization?.status).toBe(
      "initializing",
    );
    seed(dispatch.initialFrame);
    dispatch.commit();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    const rows = await gateway.rowsRange({ sessionId: "history", limit: 10 });
    expect(rows.rows).toEqual([]);
    const ack = await gateway.handleCommand({
      commandId: "early",
      sessionId: "history",
      type: "compact",
      payload: {},
      clientId: "client",
      issuedAt: Date.now(),
    });
    expect(ack.status).toBe("rejected");
    expect(ack.reasonCode).toBe("guard.runtimeInitializing");
    expect(execute).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);
    gateway.dispose();
  });

  it("retains failed history until explicit retry and coalesces repeated retry", async () => {
    const { gateway, gate, resume, params, snapshot, seed } = setup();
    seed((await gateway.subscribe(params)).initialFrame);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    gate.reject(new Error("hook unavailable"));
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("failed"));
    const attempt = snapshot()!.runtimeInitialization!.attemptId;
    await gateway.subscribe({ ...params, connectionId: "reconnect" });
    await expect(
      gateway.subscribe({ ...params, historyFirst: false, connectionId: "old-client" }),
    ).rejects.toMatchObject({ reasonCode: "fault.subscribe.resumeFailed" });
    expect(resume).toHaveBeenCalledTimes(1);
    resume.mockImplementationOnce(async () => ({ status: "resumed", persistedMessages: [] }));
    await Promise.all([
      gateway.subscribe({ ...params, retryInitialization: attempt }),
      gateway.subscribe({
        ...params,
        connectionId: "phone",
        clientMode: "web-remote-replayable",
        retryInitialization: attempt,
      }),
    ]);
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("ready"));
    expect(resume).toHaveBeenCalledTimes(2);
    gateway.dispose();
  });

  it("retains a ready runtime when only final history reconciliation fails", async () => {
    const { gateway, params, resume, snapshot, seed, loadPersistedEvents } = setup();
    const disposeOnFailure = vi.fn(async () => undefined);
    resume.mockImplementationOnce(async () => ({
      status: "resumed",
      persistedMessages: [],
      disposeOnFailure,
    }));
    seed((await gateway.subscribe(params)).initialFrame);
    loadPersistedEvents.mockRejectedValueOnce(new Error("storage unavailable"));
    await vi.waitFor(() => expect(snapshot()?.runtimeInitialization?.status).toBe("failed"));
    expect(disposeOnFailure).not.toHaveBeenCalled();
    gateway.dispose();
  });

  it("keeps durable command deduplication ahead of initialization guards", async () => {
    const { gateway, gate, params, execute } = setup(() => ({
      commandId: "settled",
      status: "accepted",
      revisionAtDecision: 1,
    }));
    await gateway.subscribe(params);
    const ack = await gateway.handleCommand({
      commandId: "settled",
      sessionId: "history",
      type: "compact",
      payload: {},
      clientId: "client",
      issuedAt: Date.now(),
    });
    expect(ack.status).toBe("duplicate");
    expect(execute).not.toHaveBeenCalled();
    gateway.dispose();
    gate.resolve();
  });

  it("does not activate a disposed opening when its reserved frame commits late", async () => {
    const { gateway, gate, params, resume } = setup();
    const dispatch = await gateway.subscribeReserved(params);
    gateway.dispose();
    dispatch.commit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resume).not.toHaveBeenCalled();
    gate.resolve();
  });

  it("keeps legacy subscribers behind runtime readiness", async () => {
    const { gateway, gate, params } = setup();
    await gateway.subscribe(params);
    let returned = false;
    const legacy = gateway
      .subscribe({ ...params, historyFirst: false, connectionId: "legacy" })
      .then(() => {
        returned = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    gate.resolve();
    await legacy;
    gateway.dispose();
  });

  it("releases a delayed residency lease after the opening was disposed", async () => {
    const lease = deferred();
    const release = vi.fn();
    const retain = vi.fn(async () => {
      await lease.promise;
      return release;
    });
    const { gateway, params, resume } = setup(undefined, retain);
    await gateway.subscribe(params);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledTimes(1));
    gateway.dispose();
    lease.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(resume).not.toHaveBeenCalled();
  });
});

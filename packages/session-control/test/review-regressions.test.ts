import { describe, expect, expectTypeOf, it } from "vitest";
import { createCliSessionControl } from "#session-control/application/cli/index";
import { createAppSessionControl } from "#session-control/application/app/index";
import {
  createTestPorts,
  createOperationFeed,
  deferred,
  flushMicrotasks,
} from "#session-control/testing/index";
import type {
  AppOperationRef,
  AppSessionRef,
  CliOperationRef,
  CliSessionRef,
  OperationFeed,
  OperationSnapshot,
} from "#session-control/contract";

const root: CliSessionRef = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_root" };
const a: CliOperationRef = {
  session: { ...root, sessionId: "sess_a" },
  sessionId: "sess_a",
  commandId: "a-command",
};
const b: CliOperationRef = {
  session: { ...root, sessionId: "sess_b" },
  sessionId: "sess_b",
  commandId: "b-command",
};
const snapshot = (
  operation: CliOperationRef,
  status: OperationSnapshot["status"],
  revision = 0,
): OperationSnapshot<CliSessionRef> => ({ operation, status, epoch: "epoch-1", revision });

function appFixture() {
  const project = { kind: "app" as const, projectId: "allowed", sourceServerId: "source" };
  const appRoot: AppSessionRef = {
    kind: "app",
    workspacePath: "/workspace",
    sourceServerId: "source",
    project,
    sessionId: "sess_root",
  };
  const ports = createTestPorts("app", appRoot);
  ports.context.allowedScopes = [{ ...project, scope: "project" }];
  const session: AppSessionRef = { ...appRoot, sessionId: "sess_target" };
  const operation: AppOperationRef = {
    session,
    sessionId: session.sessionId,
    commandId: "command",
  };
  return { ports, session, operation, control: createAppSessionControl(ports.app) };
}

describe("owner output authorization", () => {
  it.each(["different-project", "inconsistent-source", "missing-project"])(
    "rejects %s on read and fork",
    async (kind) => {
      const { ports, session, control } = appFixture();
      const forged: AppSessionRef = {
        ...session,
        project:
          kind === "missing-project"
            ? undefined
            : {
                kind: "app",
                projectId: "forbidden",
                sourceServerId: kind === "inconsistent-source" ? "other-source" : "source",
              },
      };
      ports.app.sessions.readSession = async () => ({
        view: "messages",
        session: forged,
        messages: [{ id: "message", role: "user", text: "private" }],
      });
      await expect(
        control.readSession(ports.context, { session, view: "messages" }),
      ).rejects.toMatchObject({ code: "invalid_output" });
      ports.app.execution.forkSession = async () => ({
        requestId: "fork",
        status: "created",
        session: { ...forged, sessionId: "sess_fork" },
      });
      await expect(
        control.forkSession(ports.context, { session, atMessage: "message", requestId: "fork" }),
      ).rejects.toMatchObject({ code: "invalid_output" });
    },
  );
  it.each(["initial", "update"])(
    "discards unauthorized observation %s without exposing its reference",
    async (stage) => {
      const { ports, session, operation, control } = appFixture();
      const forged: AppSessionRef = {
        ...session,
        project: { kind: "app", projectId: "forbidden", sourceServerId: "source" },
      };
      const foreign = {
        operation: { ...operation, session: forged },
        epoch: "epoch",
        revision: 1,
        status: "completed" as const,
      };
      const feed = createOperationFeed(
        stage === "initial"
          ? foreign
          : { operation, epoch: "epoch", revision: 0, status: "running" },
      );
      ports.app.observations.open = async () => feed;
      const result = control.waitSessions(ports.context, { operations: [operation], mode: "all" });
      if (stage === "update") {
        await flushMicrotasks();
        feed.push({ type: "snapshot", snapshot: foreign });
      }
      await expect(result).resolves.toMatchObject({
        status: "unknown",
        operations: [{ operation, status: "unknown" }],
      });
      expect(feed.closeCount).toBe(1);
    },
  );
  it("checks project/source consistency even when a workspace scope authorizes both projects", async () => {
    const { ports, session, control } = appFixture();
    ports.context.allowedScopes = [
      { kind: "app", scope: "workspace", workspacePath: "/workspace", sourceServerId: "source" },
    ];
    ports.app.execution.forkSession = async () => ({
      requestId: "fork",
      status: "created",
      session: {
        ...session,
        sessionId: "sess_fork",
        project: { kind: "app", projectId: "allowed", sourceServerId: "other-source" },
      },
    });
    await expect(
      control.forkSession(ports.context, { session, atMessage: "message", requestId: "fork" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("wait convergence", () => {
  it.each(["initial", "update"])(
    "retains a settled %s after its feed ends while another target runs",
    async (stage) => {
      const ports = createTestPorts("cli", root);
      const feedA = createOperationFeed(snapshot(a, stage === "initial" ? "completed" : "running"));
      const feedB = createOperationFeed(snapshot(b, "running"));
      ports.cli.observations.open = async (_ctx, operation) =>
        operation.commandId === a.commandId ? feedA : feedB;
      let settled = false;
      const result = createCliSessionControl(ports.cli)
        .waitSessions(ports.context, { operations: [a, b], mode: "all" })
        .then((value) => {
          settled = true;
          return value;
        });
      await flushMicrotasks();
      if (stage === "update")
        feedA.push({ type: "snapshot", snapshot: snapshot(a, "completed", 1) });
      await flushMicrotasks();
      feedA.end();
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(feedA.closeCount).toBe(1);
      expect(feedB.closeCount).toBe(0);
      feedB.push({ type: "snapshot", snapshot: snapshot(b, "completed", 1) });
      await expect(result).resolves.toMatchObject({
        status: "completed",
        operations: [{ status: "completed" }, { status: "completed" }],
      });
      expect(feedB.closeCount).toBe(1);
    },
  );
  it("timeout zero any collects every baseline before returning a completed target", async () => {
    const ports = createTestPorts("cli", root);
    const feedA = createOperationFeed(snapshot(a, "completed"));
    const feedB = createOperationFeed(snapshot(b, "running"));
    const openingB = deferred<OperationFeed<CliSessionRef>>();
    ports.cli.observations.open = async (_ctx, operation) =>
      operation.commandId === a.commandId ? feedA : openingB.promise;
    let settled = false;
    const result = createCliSessionControl(ports.cli)
      .waitSessions(ports.context, { operations: [a, b], mode: "any", timeoutMs: 0 })
      .then((value) => {
        settled = true;
        return value;
      });
    await flushMicrotasks();
    expect(settled).toBe(false);
    openingB.resolve(feedB);
    await expect(result).resolves.toMatchObject({
      status: "completed",
      operations: [
        { operation: a, epoch: "epoch-1", status: "completed" },
        { operation: b, epoch: "epoch-1", status: "running" },
      ],
    });
    expect(feedA.closeCount).toBe(1);
    expect(feedB.closeCount).toBe(1);
  });
});

describe("facade operation type isolation", () => {
  it("round-trips a CLI wait operation into the same facade", async () => {
    const ports = createTestPorts("cli", root);
    const control = createCliSessionControl(ports.cli);
    const result = await control.waitSessions(ports.context, {
      operations: [a],
      mode: "all",
      timeoutMs: 0,
    });
    const next = result.operations[0];
    if (!next) throw new Error("Missing operation");
    expectTypeOf(next.operation).toEqualTypeOf<CliOperationRef>();
    await control.waitSessions(ports.context, {
      operations: [next.operation],
      mode: "all",
      timeoutMs: 0,
    });
  });
  it("round-trips an App wait operation into the same facade", async () => {
    const { ports, operation, control } = appFixture();
    const result = await control.waitSessions(ports.context, {
      operations: [operation],
      mode: "all",
      timeoutMs: 0,
    });
    const next = result.operations[0];
    if (!next) throw new Error("Missing operation");
    expectTypeOf(next.operation).toEqualTypeOf<AppOperationRef>();
    await control.waitSessions(ports.context, {
      operations: [next.operation],
      mode: "all",
      timeoutMs: 0,
    });
  });
});

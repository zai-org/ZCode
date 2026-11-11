import { describe, expect, it, vi } from "vitest";
import { appControlCancelMethod, appControlProtocol } from "@zcode/shared";
import { createAppSessionControlBinding } from "../../src/session-control/index.js";
import type { AppTrustedContext } from "@zcode/session-control/contracts";

const rootSession = { kind: "app" as const, workspacePath: "/workspace", sessionId: "caller" };
const ctx: AppTrustedContext = {
  callerId: "caller",
  rootSession,
  allowedScopes: [{ ...rootSession, scope: "workspace" }],
  traceId: "trace",
  turnId: "turn",
  toolCallId: "call",
};

describe("App session control reverse RPC", () => {
  it("uses the actual connection and bound root identity, with strict typed response", async () => {
    const searchScope = {
      scopes: [{ kind: "app", scope: "project", projectId: "novel", sourceServerId: "source" }],
      unavailableSources: [{ sourceServerId: "remote", reason: "disconnected" }],
    };
    const result = { sessions: [], searchScope };
    const requestClient = vi.fn(async () => ({ ok: true, result }));
    const binding = createAppSessionControlBinding({
      requestClient: requestClient as never,
      sessionId: "caller",
      workspacePath: "/workspace",
    });
    await expect(binding.control.listSessions(ctx, {})).resolves.toEqual(result);
    expect(requestClient).toHaveBeenCalledWith(
      appControlProtocol.listSessions.method,
      { callerSessionId: "caller", callId: "call", turnId: "turn", input: { archived: "exclude" } },
      appControlProtocol.listSessions.result,
      expect.objectContaining({ trace: { traceId: "trace" } }),
    );
  });

  it("forwards explicit discovery filters without authority and rejects list replies missing coverage", async () => {
    const searchScope = {
      scopes: [],
      unavailableSources: [{ sourceServerId: "source", reason: "disconnected" }],
    };
    const requestClient = vi.fn(async () => ({ ok: true, result: { sessions: [], searchScope } }));
    const binding = createAppSessionControlBinding({
      requestClient: requestClient as never,
      sessionId: "caller",
      workspacePath: "/workspace",
    });
    const project = { kind: "app" as const, projectId: "novel", sourceServerId: "source" };
    await binding.control.listSessions(ctx, { project, query: "小说" });
    expect(requestClient.mock.calls[0]?.[1]).toEqual({
      callerSessionId: "caller",
      callId: "call",
      turnId: "turn",
      input: { project, query: "小说", archived: "exclude" },
    });
    requestClient.mockResolvedValue({ ok: true, result: { projects: [], searchScope } } as never);
    await expect(binding.control.listProjects(ctx, {})).resolves.toEqual({
      projects: [],
      searchScope,
    });
    requestClient.mockResolvedValue({ ok: true, result: { sessions: [] } } as never);
    await expect(binding.control.listSessions(ctx, {})).rejects.toThrow();
    requestClient.mockResolvedValue({ ok: true, result: { projects: [] } } as never);
    await expect(binding.control.listProjects(ctx, {})).rejects.toThrow();
  });
  it("never sends a forged source root and does not fall back to a CLI runtime", async () => {
    const requestClient = vi.fn();
    const binding = createAppSessionControlBinding({
      requestClient: requestClient as never,
      sessionId: "caller",
      workspacePath: "/workspace",
    });
    await expect(
      binding.control.listProjects(
        { ...ctx, rootSession: { ...rootSession, sessionId: "forged" } },
        {},
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("maps explicit Host rejection and invalid output to failures", async () => {
    const requestClient = vi.fn(async () => ({
      ok: false,
      error: { code: "forbidden", message: "wrong source" },
    }));
    const binding = createAppSessionControlBinding({
      requestClient: requestClient as never,
      sessionId: "caller",
      workspacePath: "/workspace",
    });
    await expect(binding.control.listProjects(ctx, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    requestClient.mockResolvedValue({ ok: true, result: { sessions: [] } } as never);
    await expect(binding.control.listProjects(ctx, {})).rejects.toThrow();
  });

  it("cancels only its own wait call and does not emit an interrupt", async () => {
    const controller = new AbortController();
    let pendingReject!: (reason: unknown) => void;
    const requestClient = vi.fn((method: string) =>
      method === appControlCancelMethod
        ? Promise.resolve({ cancelled: true })
        : new Promise((_resolve, reject) => {
            pendingReject = reject;
          }),
    );
    const binding = createAppSessionControlBinding({
      requestClient: requestClient as never,
      sessionId: "caller",
      workspacePath: "/workspace",
    });
    const waiting = binding.control.waitSessions(
      { ...ctx, signal: controller.signal },
      {
        operations: [{ session: { ...rootSession, sessionId: "target" }, commandId: "command" }],
        mode: "all",
      },
    );
    controller.abort();
    pendingReject(controller.signal.reason);
    await expect(waiting).rejects.toThrow();
    expect(requestClient.mock.calls.map(([method]) => method)).toEqual([
      appControlProtocol.waitSessions.method,
      appControlCancelMethod,
    ]);
    expect(requestClient.mock.calls[1]?.[1]).toEqual({ callerSessionId: "caller", callId: "call" });
  });
});

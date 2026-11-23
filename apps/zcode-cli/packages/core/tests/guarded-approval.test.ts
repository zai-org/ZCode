import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  createSessionId,
  createToolCallId,
  SessionEventType,
  type CollaborationMode,
  type ExecutionShellSelection,
  type PermissionBrokerResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRuleset,
  type SessionEvent,
} from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { PermissionService } from "../src/permission/service.js";
import { createManualPermissionBroker } from "../src/permission/broker.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

const POSIX: ExecutionShellSelection = {
  dialect: "posix",
  source: "auto-detected",
  display: { name: "bash" },
};
function harness(
  options: {
    mode?: CollaborationMode;
    answer?: (request: PermissionBrokerRequest) => Promise<PermissionBrokerResult>;
    noBroker?: boolean;
    deferredBroker?: PermissionBrokerPort;
    hookInput?: unknown;
    permissionHookInput?: unknown;
    timeoutMs?: number;
    validateInput?: ToolEntry["validateInput"];
    prepareApproval?: ToolEntry["prepareApproval"];
    resolvePermissionCapability?: ToolEntry["resolvePermissionCapability"];
    projectRules?: PermissionRuleset;
    onPublished?: (
      requestId: string,
      broker: ReturnType<typeof createManualPermissionBroker>,
    ) => void;
  } = {},
) {
  const registry = createToolRegistry();
  const handler = vi.fn(async (_input: unknown, _context: ToolExecutionContext) => ({
    stdout: "controlled handler result",
    stderr: "",
    exitCode: 0,
    interrupted: false,
  }));
  registry.register({
    ...bashToolEntry,
    handler,
    outputSchema: undefined,
    ...(options.validateInput ? { validateInput: options.validateInput } : {}),
    ...(options.prepareApproval ? { prepareApproval: options.prepareApproval } : {}),
    ...(options.resolvePermissionCapability
      ? { resolvePermissionCapability: options.resolvePermissionCapability }
      : {}),
  });
  const events: SessionEvent[] = [];
  const requests: PermissionBrokerRequest[] = [];
  const shell = structuredClone(POSIX);
  let mode = options.mode ?? "guarded";
  let cwd = "/workspace/original";
  const hooks = vi.fn(async (input: unknown) => ({
    additionalContexts: [],
    permissionBehavior:
      options.permissionHookInput === undefined ? ("allow" as const) : ("ask" as const),
    ...((input as { hookEventName?: string }).hookEventName === "PreToolUse" &&
    options.hookInput !== undefined
      ? { updatedInput: options.hookInput }
      : {}),
    ...((input as { hookEventName?: string }).hookEventName === "PermissionRequest" &&
    options.permissionHookInput !== undefined
      ? {
          permissionRequestResult: {
            behavior: "allow" as const,
            updatedInput: options.permissionHookInput,
          },
        }
      : {}),
  }));
  const saveProjectPermission = vi.fn();
  const broker = createManualPermissionBroker({
    onRequest: (request) => {
      requests.push(request);
    },
  });
  const executor = createToolExecutor({
    registry,
    getMode: () => mode,
    getWorkingDirectory: () => cwd,
    sessionId: createSessionId("guarded"),
    permissionService: new PermissionService(),
    permissionTimeoutMs: options.timeoutMs,
    sessionStore: {
      getSession: async () => ({ projectID: "guarded-project" }),
      getProjectPermission: async () => options.projectRules ?? { allow: [{ toolName: "Bash" }] },
      saveProjectPermission,
    } as never,
    hookRunner: { run: hooks },
    getBashShellSelection: () => shell,
    ...(!options.noBroker
      ? {
          permissionBroker:
            options.deferredBroker ??
            (options.answer
              ? {
                  requestPermission: async (request: PermissionBrokerRequest) => {
                    requests.push(request);
                    return options.answer!(request);
                  },
                }
              : broker),
        }
      : {}),
    emitEvent: async (event) => {
      events.push(event);
      if (event.type === SessionEventType.PermissionRequested) {
        options.onPublished?.(event.payload.requestId!, broker);
      }
    },
  });
  const execute = (command = "rm -rf build", signal?: AbortSignal) =>
    executor.execute(
      { id: createToolCallId("guarded"), name: "Bash", input: { command } },
      { signal },
    );
  return {
    setCwd: (next: string) => {
      cwd = next;
    },
    setMode: (next: CollaborationMode) => {
      mode = next;
    },
    executor,
    execute,
    handler,
    hooks,
    broker,
    requests,
    events,
    shell,
    saveProjectPermission,
  };
}

describe("Guarded executor authorization boundary", () => {
  describe.each([
    ["posix", "rm -r tree", "remove-critical-path"],
    ["git-bash", "rm first second", "remove-critical-path"],
    ["cmd", "rd /S tree", "cmd-remove-tree"],
    ["cmd", "erase /P file", "cmd-delete-files"],
    ["posix", "find . -type f -delete", "find-delete"],
    ["posix", "find -d . -type f -delete", "find-delete"],
    ["posix", "find -x . -type f -delete", "find-delete"],
    ["posix", "git clean -f", "git-clean-force"],
    ["git-bash", "robocopy src dst /MIR", "robocopy-delete"],
    ["posix", "rm first --help", "remove-critical-path"],
    ["cmd", "rd target/s/q", "cmd-remove-tree"],
    ["cmd", "rd/s/q target", "cmd-remove-tree"],
    ["cmd", "del/q target\\one.txt", "cmd-delete-files"],
    ["git-bash", "env MSYS2_ARG_CONV_EXCL=/MIR robocopy /c/src /c/dst /MIR", "robocopy-delete"],
  ] as const)("deletion lifecycle: %s / %s", (dialect, command, rule) => {
    it.each([
      ["guarded", "deny", false, 1],
      ["guarded", "allow", true, 1],
      ["yolo", "deny", true, 0],
    ] as const)("%s / %s", async (mode, decision, success, requests) => {
      const h = harness({ mode });
      h.shell.dialect = dialect;
      const pending = h.execute(command);
      if (requests) {
        await vi.waitFor(() => expect(h.broker.listPendingRequests()).toHaveLength(1));
        expect(h.handler).not.toHaveBeenCalled();
        expect(h.broker.resolvePermission(h.requests[0]!.requestId, {
          decision, reason: "Keep deletion fixture",
        })).toBe(true);
      }
      const result = await pending;
      expect(result.success).toBe(success);
      expect(h.requests).toHaveLength(requests);
      if (requests) {
        expect(h.requests[0]).toMatchObject({
          approvalMode: "user-once", ruleId: `safety.bash.${rule}`, input: { command },
        });
        expect(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" })).toBe(false);
      }
      expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
      if (success) {
        expect(h.handler.mock.calls[0]?.[0]).toEqual({ command });
        expect(result.output).toMatchObject({ stdout: "controlled handler result" });
      } else expect(result.error?.message).toContain("Keep deletion fixture");
      expect(h.hooks).toHaveBeenCalled(); // PreToolUse allow 不能替代用户批准。
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
      expect(h.broker.listPendingRequests()).toEqual([]);
    });

    it("cancellation keeps files unexecuted and clears the real broker", async () => {
      const h = harness();
      h.shell.dialect = dialect;
      const controller = new AbortController();
      const result = h.execute(command, controller.signal);
      await vi.waitFor(() => expect(h.broker.listPendingRequests()).toHaveLength(1));
      controller.abort();
      expect((await result).success).toBe(false);
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
      expect(h.broker.listPendingRequests()).toEqual([]);
    });
  });

  it.each([
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const)("glob force refspec: %s / %s", async (mode, decision, success, requests) => {
    const h = harness({ mode, answer: async () => ({ decision }) });
    const command = "git push origin +refs/heads/*:refs/heads/*";
    const result = await h.execute(command);
    expect(result.success).toBe(success);
    expect(h.requests).toHaveLength(requests);
    if (requests) {
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        ruleId: "safety.bash.git-push-force",
        input: { command },
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
    if (success) expect(h.handler.mock.calls[0]?.[0]).toEqual({ command });
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });

  it("单次确认不会被工具预览的 proceed 放行", async () => {
    const prepareApproval = vi.fn(() => ({ gate: "proceed" as const }));
    const h = harness({ prepareApproval, answer: async () => ({ decision: "deny" }) });
    expect((await h.execute()).success).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(prepareApproval).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
  });
  it.each([
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const)("CMD REM-named redirection: %s / %s", async (mode, decision, success, requests) => {
    const h = harness({ mode, answer: async () => ({ decision }) });
    h.shell.dialect = "cmd";
    const command = ">rem git reset --hard";
    const result = await h.execute(command);
    expect(result.success).toBe(success);
    expect(h.requests).toHaveLength(requests);
    if (requests) {
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        ruleId: "safety.bash.git-reset-hard",
        input: { command },
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });

  it.each([
    ["guarded", "deny", false, 1],
    ["guarded", "allow", true, 1],
    ["yolo", "deny", true, 0],
  ] as const)("rm trailing help/version: %s / %s", async (mode, decision, success, requests) => {
    const h = harness({ mode, answer: async () => ({ decision, reason: "Keep fixture files" }) });
    const command = "rm -rf target --help --version";
    const result = await h.execute(command);
    expect(result.success).toBe(success);
    expect(h.requests).toHaveLength(requests);
    if (requests) {
      expect(h.requests[0]).toMatchObject({
        approvalMode: "user-once",
        ruleId: "safety.bash.remove-critical-path",
        input: { command },
      });
    }
    expect(h.handler).toHaveBeenCalledTimes(success ? 1 : 0);
    if (!success) expect(result.error?.message).toContain("Keep fixture files");
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });

  it.each([false, true])(
    "cancels while registration is pending (deferred=%s) without late publication",
    async (deferredRegistration) => {
      const registered = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const deferredBroker = createManualPermissionBroker();
      const h = harness({
        deferredBroker: {
          requestPermission(request, options) {
            entered.resolve();
            const response = deferredRegistration
              ? registered.promise.then(() => deferredBroker.requestPermission(request, options))
              : deferredBroker.requestPermission(request, options);
            return Object.assign(response, {
              registered: registered.promise,
            });
          },
        },
      });
      const controller = new AbortController();
      let result: Awaited<ReturnType<typeof h.execute>> | undefined;
      const pending = h.execute(undefined, controller.signal).then((value) => {
        result = value;
      });
      await entered.promise;
      controller.abort();
      try {
        await vi.waitFor(() => expect(result?.error?.type).toBe(CoreErrorType.ToolCancelled));
      } finally {
        registered.resolve();
        await pending;
      }
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionRequested),
      ).toHaveLength(0);
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(1);
      expect(deferredBroker.listPendingRequests()).toEqual([]);
      expect(h.handler).not.toHaveBeenCalled();
    },
  );
  it("ordinary project reapproval also closes the previous request before creating a new id", async () => {
    const h = harness({
      mode: "build",
      permissionHookInput: { command: "git reset --hard" },
      projectRules: { ask: [{ toolName: "Bash" }] },
    });
    const controller = new AbortController();
    const pending = h.execute("echo original", controller.signal);
    try {
      await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      const [old, current] = h.requests;
      expect(current!.requestId).not.toBe(old!.requestId);
      expect(h.broker.resolvePermission(old!.requestId, { decision: "allow" })).toBe(false);
      h.broker.resolvePermission(current!.requestId, { decision: "allow" });
      expect((await pending).success).toBe(true);
      expect(h.handler).toHaveBeenCalledTimes(1);
      expect(
        h.events.filter((event) => event.type === SessionEventType.PermissionResolved),
      ).toHaveLength(2);
    } finally {
      controller.abort();
      await pending;
    }
  });
  // 2026-09-17 review：重判不能退回只含 runtimeScope/cwd 的缩减上下文，否则 guarded matcher 在该路径静默失效。
  it("hook rewrite recheck receives the same prepared context as the first decision", async () => {
    const contexts: unknown[] = [];
    const h = harness({
      mode: "build",
      permissionHookInput: { command: "git reset --hard" },
      projectRules: { ask: [{ toolName: "Bash" }] },
      resolvePermissionCapability: (input, context) => {
        contexts.push(context);
        return bashToolEntry.resolvePermissionCapability?.(input, context);
      },
    });
    const controller = new AbortController();
    const pending = h.execute("echo original", controller.signal);
    try {
      await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      for (const context of contexts) {
        expect(context).toMatchObject({
          mode: "build",
          bashShellSelection: h.shell,
          workingDirectory: "/workspace/original",
        });
      }
    } finally {
      controller.abort();
      await pending;
    }
  });
  it("replaces a hook-approved edited input with a fresh user-only request", async () => {
    const h = harness({ permissionHookInput: { command: "rm -rf replacement" } });
    const pending = h.execute("echo harmless");
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const [original, guarded] = h.requests;
    expect(original?.approvalMode).toBeUndefined();
    expect(guarded).toMatchObject({
      approvalMode: "user-once",
      input: { command: "rm -rf replacement" },
    });
    expect(guarded?.requestId).not.toBe(original?.requestId);
    expect(h.broker.resolvePermission(original!.requestId, { decision: "allow" })).toBe(false);
    expect(h.broker.listPendingRequests()).toHaveLength(1);
    expect(h.handler).not.toHaveBeenCalled();
    h.broker.resolvePermission(guarded!.requestId, { decision: "deny" });
    expect((await pending).success).toBe(false);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
  });
  it("reclassifies a PreToolUse edit before approval even with project allow", async () => {
    const h = harness({
      hookInput: { command: "rm -rf replacement" },
      answer: async () => ({ decision: "deny" }),
    });
    expect((await h.execute("echo harmless")).success).toBe(false);
    expect(h.requests[0]?.input).toEqual({ command: "rm -rf replacement" });
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it("does not let PreToolUse/PermissionRequest auto-allow a dangerous request", async () => {
    const h = harness();
    const pending = h.execute();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.requests[0]).toMatchObject({
      approvalMode: "user-once",
      ruleId: "safety.bash.remove-critical-path",
    });
    expect(
      h.hooks.mock.calls.some(
        ([input]) => (input as { hookEventName?: string }).hookEventName === "PermissionRequest",
      ),
    ).toBe(false);
    h.broker.resolvePermission(h.requests[0]!.requestId, {
      decision: "deny",
      reason: "Keep my files",
    });
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Keep my files");
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it("reuses the session shell selection and executes with the approved cwd exactly once", async () => {
    const h = harness();
    const pending = h.execute();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.setCwd("/workspace/changed");
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" });
    expect((await pending).success).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[1].bashShellSelection).toBe(h.shell);
    expect(h.handler.mock.calls[0]?.[1]).toMatchObject({
      bashShellSelection: { dialect: "posix" },
      workingDirectory: "/workspace/original",
    });
    expect(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" })).toBe(false);
  });
  it.each(["allow", "modify"] as const)(
    "executes a broker-approved dangerous edit once without reapproval: %s",
    async (decision) => {
      const modifiedInput = { command: "git reset --hard" };
      let responses = 0;
      const h = harness({
        answer: async () => {
          // 回归时有界失败，不让重复审批挂住测试或不断请求相同输入。
          if (++responses > 1) return { decision: "deny", reason: "Unexpected reapproval" };
          h.setMode("yolo");
          h.setCwd("/workspace/changed");
          return { decision, modifiedInput };
        },
      });
      expect((await h.execute()).success).toBe(true);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]?.mode).toBe("guarded");
      expect(h.handler).toHaveBeenCalledTimes(1);
      expect(h.handler.mock.calls[0]?.[0]).toEqual(modifiedInput);
      expect(h.handler.mock.calls[0]?.[0]).not.toBe(modifiedInput);
      expect(Object.isFrozen(h.handler.mock.calls[0]?.[0])).toBe(true);
      expect(h.handler.mock.calls[0]?.[1].bashShellSelection).toBe(h.shell);
      expect(h.handler.mock.calls[0]?.[1]).toMatchObject({
        bashShellSelection: { dialect: "posix" },
        workingDirectory: "/workspace/original",
      });
      expect(h.events.filter((e) => e.type === SessionEventType.PermissionResolved)).toHaveLength(
        1,
      );
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      decision: "allow",
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    },
    { decision: "invalid" },
    { decision: "allow", permissionUpdates: {} },
    {
      decision: "allow",
      sessionPermissionUpdates: [
        { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] },
      ],
    },
    { decision: "allow", reason: {} },
    { decision: "modify", modifiedInput: { command: 42 } },
    { decision: "allow", modifiedInput: { command: 42 } },
    {
      decision: "modify",
      modifiedInput: { command: "git reset --hard" },
      permissionUpdates: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash" }] }],
    },
  ])("rejects illegal/invalid/persistent responses without executing", async (answer) => {
    const h = harness({ answer: async () => answer as PermissionBrokerResult });
    expect((await h.execute()).success).toBe(false);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it("times out and removes the pending request without executing or storing rules", async () => {
    const h = harness({ timeoutMs: 10 });
    expect((await h.execute()).error?.type).toBe(CoreErrorType.PermissionTimeout);
    expect(h.requests).toHaveLength(1);
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
    expect(h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "allow" })).toBe(false);
  });
  it("cleans pending on cancellation", async () => {
    const h = harness();
    const abort = new AbortController();
    const pending = h.execute(undefined, abort.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    abort.abort();
    expect((await pending).error?.type).toBe(CoreErrorType.ToolCancelled);
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("mode switching does not settle an existing request", async () => {
    const h = harness();
    const pending = h.execute();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.setMode("yolo");
    expect(h.handler).not.toHaveBeenCalled();
    h.broker.resolvePermission(h.requests[0]!.requestId, { decision: "deny" });
    expect((await pending).success).toBe(false);
    expect((await h.execute()).success).toBe(true);
    expect(h.requests).toHaveLength(1);
  });
  it("fails without an interactive broker", async () => {
    const h = harness({ noBroker: true });
    expect((await h.execute()).error?.type).toBe(CoreErrorType.ConfigurationError);
    expect(h.handler).not.toHaveBeenCalled();
  });
  it("original YOLO executes the same command with no new approval", async () => {
    const h = harness({ mode: "yolo" });
    expect((await h.execute()).success).toBe(true);
    expect(h.requests).toEqual([]);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[1].bashShellSelection).toBe(h.shell);
  });
  it("registers the broker before publishing a request that can be answered immediately", async () => {
    let delivered = false;
    const h = harness({
      timeoutMs: 30,
      onPublished: (id, broker) => {
        delivered = broker.resolvePermission(id, { decision: "allow" });
      },
    });
    expect((await h.execute()).success).toBe(true);
    expect(delivered).toBe(true);
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e.type === SessionEventType.PermissionResolved)).toHaveLength(1);
  });
  it.each([
    ["guarded", "hook"],
    ["guarded", "broker"],
    ["guarded", "permission-hook"],
    ["build", "hook"],
    ["build", "permission-hook"],
    ["yolo", "hook"],
    ["yolo", "permission-hook"],
  ] as const)("keeps semantic preflight before hooks only: %s / %s", async (mode, source) => {
    const modified = { command: "echo rewritten-input" };
    const validateInput = vi.fn((input: unknown) =>
      (input as { command: string }).command === modified.command
        ? { result: false, errorCode: 123, message: "Rejected by tool semantics" }
        : undefined,
    );
    const h = harness({
      mode,
      ...(source === "hook" ? { hookInput: modified } : {}),
      ...(source === "permission-hook" ? { permissionHookInput: modified } : {}),
      ...(source === "broker"
        ? { answer: async () => ({ decision: "modify" as const, modifiedInput: modified }) }
        : {}),
      validateInput,
    });
    const command = source === "broker" ? "rm -rf build" : "echo original-input";
    const result = await h.execute(command);
    expect(result.success).toBe(true);
    expect(validateInput).toHaveBeenCalledTimes(1);
    expect(validateInput.mock.calls[0]?.[0]).toEqual({ command });
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.handler.mock.calls[0]?.[0]).toEqual(modified);
    expect(h.broker.listPendingRequests()).toEqual([]);
    expect(h.saveProjectPermission).not.toHaveBeenCalled();
  });
  it.each(["guarded", "build", "yolo"] as const)(
    "still rejects initial semantic failures before hooks in %s",
    async (mode) => {
      const validateInput = vi.fn(() => ({
        result: false,
        errorCode: 123,
        message: "Rejected by initial tool semantics",
      }));
      const h = harness({ mode, validateInput });
      const result = await h.execute();
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Rejected by initial tool semantics");
      expect(validateInput).toHaveBeenCalledTimes(1);
      expect(h.hooks).not.toHaveBeenCalled();
      expect(h.requests).toEqual([]);
      expect(h.handler).not.toHaveBeenCalled();
    },
  );
  it.each(["hook", "broker", "permission-hook"] as const)(
    "still rejects schema-invalid input rewritten by %s",
    async (source) => {
      const modified = { timeout: 1000 };
      const h = harness({
        ...(source === "hook" ? { hookInput: modified } : {}),
        ...(source === "permission-hook" ? { permissionHookInput: modified } : {}),
        ...(source === "broker"
          ? { answer: async () => ({ decision: "modify" as const, modifiedInput: modified }) }
          : {}),
      });
      const result = await h.execute(source === "broker" ? "rm -rf build" : "echo original-input");
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain(
        // PreToolUse hook 的改写说明是 hook 的错（docs/model-tool-call-validation.md）；其他来源文字不变。
        source === "hook"
          ? "PreToolUse hook for Bash returned updatedInput that failed schema validation"
          : "inputSchema validation",
      );
      expect(h.handler).not.toHaveBeenCalled();
      expect(h.broker.listPendingRequests()).toEqual([]);
      expect(h.saveProjectPermission).not.toHaveBeenCalled();
    },
  );
  it("preserves infrastructure errors without describing them as user denial", async () => {
    const h = harness({
      answer: async () => {
        throw new Error("transport unavailable");
      },
    });
    const result = await h.execute();
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(h.handler).not.toHaveBeenCalled();
  });
});

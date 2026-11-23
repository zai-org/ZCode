/**
 * PreToolUse hook 的 `onError`（docs/hooks-implementation-analysis.md「执行与输出」）。
 *
 * hook 自身出错（非 0 且非 2 退出、超时、JSON 不合 schema）时，默认仍放行（fail-open）；
 * `onError: "deny"` 让这次出错等同于 hook 以退出码 2 拦截。用户中断、未受信任的工作区 hook、
 * 非 PreToolUse 事件和 async hook 不受影响。放行时记一条 info 日志，让「放行」也留痕。
 */

import { describe, expect, it } from "vitest";
import {
  HookEventName,
  HookOutcome,
  SessionEventType,
  createSessionId,
  createTraceId,
  createTurnId,
  createWorkspaceHookBundleSnapshot,
  type ExecutionPort,
  type HookRunLifecyclePayload,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import {
  WorkspaceHookTrustCoordinator,
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createWorkspaceHookRuntimeAdmission,
  createWorkspaceHookTrustRecords,
} from "../src/hooks/index.js";
import type { HookRegistration } from "../src/hooks/types.js";

function preToolInput() {
  return {
    cwd: "/workspace",
    hookEventName: HookEventName.PreToolUse,
    mode: "build" as const,
    riskLevel: "low" as const,
    sessionId: createSessionId("hook-on-error"),
    timestamp: new Date().toISOString(),
    toolCallId: "call-1",
    toolInput: { script: "return 1;" },
    toolName: "CreateWorkflow",
    traceId: createTraceId(),
    turnId: createTurnId("turn-1"),
  };
}

function postToolInput() {
  return {
    ...preToolInput(),
    hookEventName: HookEventName.PostToolUse,
    toolResponse: { ok: true },
  };
}

const failing: HookRegistration["callback"] = async () => {
  throw new Error("guard crashed");
};

function recordingLogger(): { logger: Logger; infos: { message: string; context?: object }[] } {
  const infos: { message: string; context?: object }[] = [];
  const noop = () => {};
  const logger = {
    debug: noop,
    error: noop,
    info: (message: string, context?: object) => infos.push({ message, context }),
    warn: noop,
    child: () => logger,
  } as unknown as Logger;
  return { logger, infos };
}

describe("PreToolUse hook onError", () => {
  it("keeps the default fail-open: a failing hook does not deny the tool", async () => {
    const runner = createInMemoryHookRunner({
      hooks: [{ callback: failing, event: HookEventName.PreToolUse, sourceKind: "user" }],
    });

    const result = await runner.run(preToolInput());

    expect(result.permissionBehavior).toBeUndefined();
  });

  it("denies the tool when a hook with onError deny fails, as an exit code 2 would", async () => {
    const events: SessionEvent[] = [];
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: failing,
          event: HookEventName.PreToolUse,
          onError: "deny",
          sourceKind: "user",
        },
      ],
    });

    const result = await runner.run(preToolInput());

    expect(result.permissionBehavior).toBe("deny");
    expect(result.hookPermissionDecisionReason).toContain("guard crashed");
    const terminal = events.at(-1);
    expect(terminal?.type).toBe(SessionEventType.HookRunBlocked);
    const payload = terminal?.payload as HookRunLifecyclePayload;
    expect(payload.outcome).toBe(HookOutcome.Blocked);
    expect(payload.blockReason).toContain("onError");
    expect(payload.errorMessage).toBe("guard crashed");
  });

  it("denies on a timeout too", async () => {
    const runner = createInMemoryHookRunner({
      hooks: [
        {
          callback: () => new Promise<never>(() => {}),
          event: HookEventName.PreToolUse,
          onError: "deny",
          timeoutMs: 1,
        },
      ],
    });

    const result = await runner.run(preToolInput());

    expect(result.permissionBehavior).toBe("deny");
  });

  it("does not deny when the user cancelled the hook", async () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    const runner = createInMemoryHookRunner({
      hooks: [
        {
          callback: () => new Promise<never>(() => {}),
          event: HookEventName.PreToolUse,
          onError: "deny",
        },
      ],
    });

    const result = await runner.run(preToolInput(), { signal: controller.signal });

    expect(result.permissionBehavior).toBeUndefined();
  });

  it("ignores onError on events other than PreToolUse", async () => {
    const runner = createInMemoryHookRunner({
      hooks: [{ callback: failing, event: HookEventName.PostToolUse, onError: "deny" }],
    });

    const result = await runner.run(postToolInput());

    expect(result.permissionBehavior).toBeUndefined();
    expect(result.preventContinuation).toBeUndefined();
  });

  it("does not deny for an untrusted workspace hook: it never ran", async () => {
    const runner = createInMemoryHookRunner({
      hooks: [
        {
          admission: () => ({ allowed: false, reasonCode: "workspace_hook_untrusted" }),
          callback: failing,
          event: HookEventName.PreToolUse,
          onError: "deny",
          sourceKind: "project",
        },
      ],
    });

    const result = await runner.run(preToolInput());

    expect(result.permissionBehavior).toBeUndefined();
  });

  it("logs an allowed PreToolUse call at info for configured hooks, not for internal ones", async () => {
    const { logger, infos } = recordingLogger();
    const runner = createInMemoryHookRunner({
      hooks: [
        {
          callback: async () => undefined,
          event: HookEventName.PreToolUse,
          source: "config.PreToolUse.0.0",
          sourceKind: "user",
        },
        {
          callback: async () => undefined,
          event: HookEventName.PreToolUse,
          sourceKind: "internal",
        },
      ],
      logger,
    });

    await runner.run(preToolInput());

    const allowed = infos.filter(
      (entry) => (entry.context as { event?: string } | undefined)?.event === "hook.run.allowed",
    );
    expect(allowed).toHaveLength(1);
    expect(allowed[0]!.context).toMatchObject({
      source: "config.PreToolUse.0.0",
      sourceKind: "user",
      toolCallId: "call-1",
      toolName: "CreateWorkflow",
    });
  });
});

function exitingWith(
  exitCode: number,
  output: { stderr: string; stdout?: string } = { stderr: "guard: cannot read field" },
): ExecutionPort {
  return {
    async run() {
      const now = new Date();
      const stdout = output.stdout ?? "";
      return {
        status: "completed",
        exitCode,
        stdout: { text: stdout, bytes: stdout.length, truncated: false },
        stderr: { text: output.stderr, bytes: output.stderr.length, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  };
}

describe("configured PreToolUse hook onError", () => {
  function runnerFor(onError: "allow" | "deny" | undefined, exitCode: number) {
    return createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          PreToolUse: [
            {
              matcher: "CreateWorkflow",
              hooks: [
                {
                  type: "command",
                  command: "node guard.mjs",
                  ...(onError === undefined ? {} : { onError }),
                },
              ],
            },
          ],
        },
        maxOutputBytes: 1_024,
        timeoutMs: 5_000,
      },
      executionPort: exitingWith(exitCode),
      getWorkingDirectory: () => "/workspace",
    });
  }

  it("carries onError from the settings to the hook: exit 1 denies", async () => {
    const result = await runnerFor("deny", 1)?.run(preToolInput(), {
      matchValue: "CreateWorkflow",
    });
    expect(result?.permissionBehavior).toBe("deny");
    expect(result?.hookPermissionDecisionReason).toContain("guard: cannot read field");
  });

  it("lets exit 1 through without onError, and with onError allow", async () => {
    for (const onError of [undefined, "allow"] as const) {
      const result = await runnerFor(onError, 1)?.run(preToolInput(), {
        matchValue: "CreateWorkflow",
      });
      expect(result?.permissionBehavior).toBeUndefined();
    }
  });
});

describe("configured PreToolUse hook exit code 2", () => {
  function runnerWithOutput(
    output: { stderr: string; stdout?: string },
    plugin?: { id: string; name: string },
    command = "node guard.mjs --strict",
    args?: string[],
  ) {
    const events: SessionEvent[] = [];
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          PreToolUse: [
            {
              matcher: "CreateWorkflow",
              hooks: [
                {
                  ...(args
                    ? { type: "process" as const, command, args }
                    : { type: "command" as const, command }),
                  ...(plugin
                    ? { plugin: { ...plugin, dataPath: "/data", rootPath: "/plugins/acme" } }
                    : {}),
                },
              ],
            },
          ],
        },
        maxOutputBytes: 1_024,
        timeoutMs: 5_000,
      },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort: exitingWith(2, output),
      getWorkingDirectory: () => "/workspace",
    });
    return { events, runner };
  }

  it("tells the model a hook blocked the tool and why, without the hook command", async () => {
    const { events, runner } = runnerWithOutput({ stderr: "no workflows on main\n" });

    const result = await runner?.run(preToolInput(), { matchValue: "CreateWorkflow" });

    expect(result?.permissionBehavior).toBe("deny");
    expect(result?.hookPermissionDecisionReason).toBe(
      "PreToolUse:CreateWorkflow hook error: [command hidden]: no workflows on main",
    );
    // Hooks 明细不显示命令，仍是 stderr 预览。
    const payload = events.at(-1)?.payload as HookRunLifecyclePayload;
    expect(payload.blockReason).toBe("no workflows on main");
  });

  it("writes No stderr output instead of falling back to stdout, and names the plugin", async () => {
    const { events, runner } = runnerWithOutput(
      { stderr: "", stdout: "diagnostic only" },
      { id: "acme@market", name: "acme" },
    );

    const result = await runner?.run(preToolInput(), { matchValue: "CreateWorkflow" });

    expect(result?.hookPermissionDecisionReason).toBe(
      "PreToolUse:CreateWorkflow hook error: [command hidden]: No stderr output\nThis hook comes from the acme plugin.",
    );
    const payload = events.at(-1)?.payload as HookRunLifecyclePayload;
    expect(payload.blockReason).toBe("diagnostic only");
  });

  it("trims stderr and cuts it at 4000 characters", async () => {
    const stderr = "x".repeat(5000);
    const { runner } = runnerWithOutput({ stderr: `  ${stderr}\n` });

    const result = await runner?.run(preToolInput(), { matchValue: "CreateWorkflow" });

    expect(result?.hookPermissionDecisionReason).toBe(
      `PreToolUse:CreateWorkflow hook error: [command hidden]: ${stderr.slice(0, 4000)}...`,
    );
  });

  it.each([
    ["curl -u", "curl -u example-user:EXAMPLE_SECRET https://hooks.example.com/check", undefined],
    ["mysql -p", "mysql -pEXAMPLE_SECRET -e 'select 1'", undefined],
    ["sshpass -p", "sshpass -p EXAMPLE_SECRET ssh guard@hooks.example.com", undefined],
    [
      "Cookie header",
      "curl -H 'Cookie: session=EXAMPLE_SECRET' https://hooks.example.com",
      undefined,
    ],
    ["process args", "curl", ["-u", "example-user:EXAMPLE_SECRET", "https://hooks.example.com"]],
  ])(
    "keeps a credential in the hook command (%s) out of the model text",
    async (_case, command, args) => {
      const { runner } = runnerWithOutput({ stderr: "denied" }, undefined, command, args);

      const result = await runner?.run(preToolInput(), { matchValue: "CreateWorkflow" });

      // 拒绝理由会进入 tool_result、会话持久化和之后的 provider 请求；脱敏规则覆盖不了这些写法，所以不写命令。
      expect(result?.hookPermissionDecisionReason).toBe(
        "PreToolUse:CreateWorkflow hook error: [command hidden]: denied",
      );
    },
  );
});

describe("workspace PreToolUse hook onError", () => {
  // 工作区 hook 从规范条目重建配置（configured-runner.ts 的 workspaceEntryToHookConfig）：
  // onError 必须过规范条目的 strict schema、并被带回 registration，否则信任过的 deny 静默失效。
  it("carries onError from a trusted canonical entry to the hook", async () => {
    const hookSnapshot = createWorkspaceHookBundleSnapshot({
      schemaVersion: 1,
      workspaceIdentity: "local:/workspace",
      discoveredAt: "2026-10-19T00:00:00.000Z",
      sourceFiles: [
        {
          canonicalPath: "/workspace/.zcode/config.json",
          baseDir: "/workspace",
          discoveryOrder: 0,
          configFileKind: ".zcode/config.json",
          explicitProjectConfig: false,
          editable: true,
          hooksRoot: { enabled: true },
        },
      ],
      hooks: [
        {
          reviewItemId: "item-0",
          event: HookEventName.PreToolUse,
          matcherIndex: 0,
          hookIndex: 0,
          sourceFileIndex: 0,
          sourceRelativePath: ".zcode/config.json",
          matcher: "CreateWorkflow",
          type: "command",
          command: "node guard.mjs",
          onError: "deny",
          resolvedTimeoutMs: 60_000,
          resolvedMaxOutputBytes: 32_768,
          sourceRootEnabled: true,
          declarationEnabled: true,
          runtimeHooksEnabled: true,
          configuredEnabled: true,
          editable: true,
          declarationDigestAlgorithm: "sha256",
          hookDeclarationDigest: "a".repeat(64),
        },
      ],
      digestAlgorithm: "sha256",
      bundleDigest: "c".repeat(64),
    });
    const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-on-error" });
    coordinator.replacePersistentTrustRecords(
      createWorkspaceHookTrustRecords({
        snapshot: hookSnapshot,
        reviewItemIds: ["item-0"],
        grantedAt: "2026-10-19T00:00:00.000Z",
      }),
      { status: "ok" },
    );
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator,
      ready: Promise.resolve(),
      snapshot: hookSnapshot,
    });
    await admission.activate("startup");
    const events: SessionEvent[] = [];
    const runner = createConfiguredHookRunner({
      config: { enabled: true, events: {}, maxOutputBytes: 32_768, timeoutMs: 60_000 },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort: exitingWith(1),
      getWorkingDirectory: () => "/workspace",
      workspaceHookAdmission: admission,
      workspaceHookSnapshot: hookSnapshot,
    });

    const result = await runner?.run(preToolInput(), { matchValue: "CreateWorkflow" });

    expect(events.at(-1)?.type).toBe(SessionEventType.HookRunBlocked);
    expect(result?.permissionBehavior).toBe("deny");
  });
});

import { describe, expect, it } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createWorkspaceHookBundleSnapshot,
  type ExecutionPort,
  type HookExecutionDescriptor,
  type HookInput,
  type HookRunLifecyclePayload,
  type SessionEvent,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import type { WorkspaceHookScriptState } from "@zcode/shared/workspace-hook-discovery";
import {
  WorkspaceHookTrustCoordinator,
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createWorkspaceHookRuntimeAdmission,
  createWorkspaceHookTrustRecords,
} from "../src/hooks/index.js";

/**
 * D24（ZP-20261110-06）：有 scriptEntry 的项目 Hook 派发前复核入口脚本。
 * 修复前会话中替换或删除已信任的脚本，后续 dispatch 仍按旧 Trust 启动进程。
 */

const WORKSPACE = "/workspace";
const BUNDLE = "c".repeat(64);
const DIGEST = "a".repeat(64);
const TRUSTED_SHA = "1".repeat(64);

function snapshot(state: WorkspaceHookScriptState): WorkspaceHookBundleSnapshot {
  return createWorkspaceHookBundleSnapshot({
    schemaVersion: 1,
    workspaceIdentity: WORKSPACE,
    discoveredAt: "2026-11-13T00:00:00.000Z",
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
        event: HookEventName.SessionStart,
        matcherIndex: 0,
        hookIndex: 0,
        sourceFileIndex: 0,
        sourceRelativePath: ".zcode/config.json",
        matcher: null,
        type: "command",
        command: "bash .zcode/hook.sh",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        scriptEntry: { path: ".zcode/hook.sh", state },
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
        editable: true,
        declarationDigestAlgorithm: "sha256",
        hookDeclarationDigest: DIGEST,
      },
    ],
    digestAlgorithm: "sha256",
    bundleDigest: BUNDLE,
  });
}

function trustedCoordinator(hookSnapshot: WorkspaceHookBundleSnapshot) {
  const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-script" });
  coordinator.replacePersistentTrustRecords(
    createWorkspaceHookTrustRecords({
      snapshot: hookSnapshot,
      reviewItemIds: ["item-0"],
      grantedAt: "2026-11-13T00:00:00.000Z",
    }),
    { status: "ok" },
  );
  return coordinator;
}

function executionPort(commands: string[]): ExecutionPort {
  return {
    async run(request) {
      commands.push(request.command.mode === "shell" ? request.command.command : request.command.file);
      const now = new Date("2026-11-13T00:00:00.000Z");
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  };
}

function sessionStartInput(cwd = WORKSPACE): HookInput {
  return {
    cwd,
    hookEventName: HookEventName.SessionStart,
    mode: "build",
    sessionId: "session-1" as never,
    source: "startup",
    timestamp: "2026-11-13T00:00:00.000Z",
    traceId: "trace-1" as never,
  };
}

async function runOnce(input: {
  recorded: WorkspaceHookScriptState;
  current: WorkspaceHookScriptState | (() => Promise<WorkspaceHookScriptState>);
  inject?: boolean;
  trusted?: boolean;
  beforeResolve?: (coordinator: WorkspaceHookTrustCoordinator) => void;
}) {
  const hookSnapshot = snapshot(input.recorded);
  const coordinator =
    input.trusted === false
      ? new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-script" })
      : trustedCoordinator(hookSnapshot);
  if (input.trusted === false) coordinator.replacePersistentTrustRecords([], { status: "missing" });
  const reads: Array<{ cwd: string; path: string }> = [];
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator,
    ready: Promise.resolve(),
    snapshot: hookSnapshot,
    ...(input.inject === false
      ? {}
      : {
          readScriptState: async (cwd: string, path: string) => {
            reads.push({ cwd, path });
            input.beforeResolve?.(coordinator);
            return typeof input.current === "function" ? input.current() : input.current;
          },
        }),
  });
  const events: SessionEvent[] = [];
  const commands: string[] = [];
  const runner = createConfiguredHookRunner({
    config: { enabled: true, events: {}, maxOutputBytes: 32_768, timeoutMs: 60_000 },
    emitEvent: async (event) => {
      events.push(event);
    },
    executionPort: executionPort(commands),
    getWorkingDirectory: () => WORKSPACE,
    workspaceHookAdmission: admission,
    workspaceHookSnapshot: hookSnapshot,
  });
  if (!runner) throw new Error("expected configured runner");
  await admission.activate("startup");
  await runner.run(sessionStartInput("/workspace/sub"), { matchValue: "startup" });
  const payload = events[0]?.payload as HookRunLifecyclePayload | undefined;
  return { admission, commands, events, payload, reads };
}

describe("Workspace Hook 入口脚本派发前复核（D24）", () => {
  it("内容与记录相同：按实际 cwd 复核后执行，命令不变", async () => {
    const result = await runOnce({
      recorded: { kind: "file", sha256: TRUSTED_SHA },
      current: { kind: "file", sha256: TRUSTED_SHA },
    });
    expect(result.reads).toEqual([{ cwd: "/workspace/sub", path: ".zcode/hook.sh" }]);
    expect(result.commands).toEqual(["bash .zcode/hook.sh"]);
    expect(result.events[0]?.type).toBe(SessionEventType.HookRunStarted);
  });

  it("会话中脚本内容变化：HookRunBlocked(declaration_changed)，不创建进程", async () => {
    const result = await runOnce({
      recorded: { kind: "file", sha256: TRUSTED_SHA },
      current: { kind: "file", sha256: "2".repeat(64) },
    });
    expect(result.commands).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
    expect(result.payload?.errorCode).toBe("workspace_hook_declaration_changed");
  });

  it.each([{ kind: "missing" }, { kind: "unverifiable" }] as const)(
    "会话中脚本变为 %j：HookRunBlocked(script_unavailable)",
    async (current) => {
      const result = await runOnce({
        recorded: { kind: "file", sha256: TRUSTED_SHA },
        current,
      });
      expect(result.commands).toEqual([]);
      expect(result.payload?.errorCode).toBe("workspace_hook_script_unavailable");
    },
  );

  it("复核期间 revoke：复核返回后重验 admission 并阻断", async () => {
    const result = await runOnce({
      recorded: { kind: "file", sha256: TRUSTED_SHA },
      current: { kind: "file", sha256: TRUSTED_SHA },
      beforeResolve: (coordinator) =>
        coordinator.revoke({ workspaceIdentity: WORKSPACE, hookDeclarationDigests: [DIGEST] }),
    });
    expect(result.commands).toEqual([]);
    expect(result.payload?.errorCode).toBe("workspace_hooks_revoked");
  });

  it("没有注入读取端口时 fail closed", async () => {
    const result = await runOnce({
      recorded: { kind: "file", sha256: TRUSTED_SHA },
      current: { kind: "file", sha256: TRUSTED_SHA },
      inject: false,
    });
    expect(result.commands).toEqual([]);
    expect(result.payload?.errorCode).toBe("workspace_hook_script_unavailable");
  });

  it.each([{ kind: "missing" }, { kind: "unverifiable" }] as const)(
    "snapshot 记录为 %j：即使存在匹配 record 也 blocked，不计入 pending，不读文件",
    async (recorded) => {
      const states: number[] = [];
      const hookSnapshot = snapshot(recorded);
      const admission = createWorkspaceHookRuntimeAdmission({
        coordinator: trustedCoordinator(hookSnapshot),
        ready: Promise.resolve(),
        snapshot: hookSnapshot,
        onAdmissionStateChanged: (state) => states.push(state.pendingCount),
        readScriptState: async () => {
          throw new Error("must not read");
        },
      });
      await admission.activate("startup");
      expect(
        admission.evaluateDispatch({ hookDeclarationDigest: DIGEST, reviewItemId: "item-0" }),
      ).toEqual({ allowed: false, reasonCode: "workspace_hook_script_unavailable" });
      expect(states).toEqual([0]);
    },
  );
});

describe("Hook runner 派发前复核的取消与超时（D24）", () => {
  const descriptor: HookExecutionDescriptor = {
    clientVisible: true,
    commandDisplay: "hook",
    executionMode: "foreground",
    executionType: "command",
    sourceKind: "project",
    timeoutMs: 20,
  };

  it("复核超过 timeoutMs：HookRunBlocked(script_unavailable)，callback 不执行", async () => {
    const events: SessionEvent[] = [];
    let ran = false;
    let observedAbort = false;
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: () => {
            ran = true;
            return undefined;
          },
          descriptor,
          event: HookEventName.SessionStart,
          timeoutMs: 20,
          verifyBeforeDispatch: (_input, signal) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                observedAbort = true;
                // 迟到结果必须被忽略。
                setTimeout(() => resolve({ allowed: true }), 5);
              });
            }),
        },
      ],
    });
    await runner.run(sessionStartInput());
    expect(ran).toBe(false);
    expect(observedAbort).toBe(true);
    expect(events.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
    expect((events[0]?.payload as HookRunLifecyclePayload).errorCode).toBe(
      "workspace_hook_script_unavailable",
    );
  });

  it("父信号已取消：不复核成功也不执行", async () => {
    const events: SessionEvent[] = [];
    let ran = false;
    const controller = new AbortController();
    controller.abort();
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: () => {
            ran = true;
            return undefined;
          },
          descriptor,
          event: HookEventName.SessionStart,
          verifyBeforeDispatch: async () => ({ allowed: true }),
        },
      ],
    });
    await runner.run(sessionStartInput(), { signal: controller.signal });
    expect(ran).toBe(false);
    expect((events[0]?.payload as HookRunLifecyclePayload).errorCode).toBe(
      "workspace_hook_script_unavailable",
    );
  });
});

/**
 * 第二轮 CR 需确认项：已信任的 PreToolUse 守卫（onError: deny）在脚本被删后，修复前会以非零退出
 * 触发 deny；复核前移后曾变成 HookRunBlocked 并放行工具调用。复核失败现在按 Hook 出错处理。
 */
describe("派发前复核失败与 onError: deny（D24）", () => {
  const descriptor: HookExecutionDescriptor = {
    clientVisible: true,
    commandDisplay: "guard",
    executionMode: "foreground",
    executionType: "command",
    sourceKind: "project",
    timeoutMs: 1_000,
  };

  function preToolUseInput(): HookInput {
    return {
      cwd: WORKSPACE,
      hookEventName: HookEventName.PreToolUse,
      mode: "build",
      sessionId: "session-1" as never,
      timestamp: "2026-11-13T00:00:00.000Z",
      toolInput: {},
      toolName: "Write",
      traceId: "trace-1" as never,
    } as HookInput;
  }

  function guardRunner(input: {
    onError?: "deny";
    verify: () => Promise<{ allowed: boolean; reasonCode?: string }>;
    admission?: () => { allowed: boolean; reasonCode?: string };
  }) {
    const events: SessionEvent[] = [];
    let ran = false;
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          ...(input.admission ? { admission: input.admission } : {}),
          callback: () => {
            ran = true;
            return undefined;
          },
          descriptor,
          event: HookEventName.PreToolUse,
          ...(input.onError ? { onError: input.onError } : {}),
          timeoutMs: 1_000,
          verifyBeforeDispatch: input.verify,
        },
      ],
    });
    return { events, runner, ran: () => ran };
  }

  it("onError: deny 的守卫复核失败时拦截工具调用，callback 不执行", async () => {
    const value = guardRunner({
      onError: "deny",
      verify: async () => ({ allowed: false, reasonCode: "workspace_hook_script_unavailable" }),
    });
    const result = await value.runner.run(preToolUseInput());
    expect(value.ran()).toBe(false);
    expect(result.permissionBehavior).toBe("deny");
    const payload = value.events[0]?.payload as HookRunLifecyclePayload;
    expect(value.events[0]?.type).toBe(SessionEventType.HookRunBlocked);
    expect(payload.errorCode).toBe("workspace_hook_script_unavailable");
    expect(payload.blockReason).toContain('onError is "deny"');
  });

  it("未配置 onError: deny 时复核失败仍只跳过该 Hook", async () => {
    const value = guardRunner({
      verify: async () => ({ allowed: false, reasonCode: "workspace_hook_declaration_changed" }),
    });
    const result = await value.runner.run(preToolUseInput());
    expect(result.permissionBehavior).toBeUndefined();
  });

  it("未信任（admission 拒绝）不按出错处理，onError: deny 也不拦截", async () => {
    const value = guardRunner({
      onError: "deny",
      admission: () => ({ allowed: false, reasonCode: "workspace_hooks_pending_trust" }),
      verify: async () => ({ allowed: true }),
    });
    const result = await value.runner.run(preToolUseInput());
    expect(result.permissionBehavior).toBeUndefined();
  });
});

/**
 * 发现阶段入口已不可用：一律按未信任跳过，不按 Hook 出错处理（不触发 onError: deny）。
 * 第七轮 CR：曾按“同一位置曾被信任”判断为出错，但只比较展示命令；仓库只改 onError/timeout/shell 并删除
 * 脚本，就能把曾信任的普通 Hook 变成拒绝所有工具的守卫（DoS）。发现阶段没有可审核的内容，也就无法
 * 证明当前声明就是曾信任的那一条，因此不拦截。会话进行中脚本被删仍由派发前复核按出错处理。
 */
describe("发现阶段入口不可用（D24）", () => {
  const FILE_DIGEST = "e".repeat(64);
  const UNAVAILABLE_DIGEST = "f".repeat(64);

  function guardSnapshot(
    state: WorkspaceHookScriptState,
    digest: string,
    command = "bash .zcode/hook.sh",
    onError?: "deny",
  ): WorkspaceHookBundleSnapshot {
    const base = snapshot(state);
    return createWorkspaceHookBundleSnapshot({
      ...base,
      hooks: [
        {
          ...base.hooks[0]!,
          event: HookEventName.PreToolUse,
          matcher: null,
          ...(onError ? { onError } : {}),
          command,
          hookDeclarationDigest: digest,
        },
      ],
    });
  }

  function preToolUseInput(): HookInput {
    return {
      cwd: WORKSPACE,
      hookEventName: HookEventName.PreToolUse,
      mode: "build",
      sessionId: "session-1" as never,
      timestamp: "2026-11-16T00:00:00.000Z",
      toolInput: {},
      toolName: "Write",
      traceId: "trace-1" as never,
    } as HookInput;
  }

  async function run(input: {
    state: WorkspaceHookScriptState;
    previouslyTrusted: boolean;
    trustedCommand?: string;
    trustedOnError?: "deny" | "allow";
    corrupt?: boolean;
    abort?: boolean;
  }) {
    const current = guardSnapshot(input.state, UNAVAILABLE_DIGEST, undefined, "deny");
    const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-guard" });
    coordinator.replacePersistentTrustRecords(
      input.previouslyTrusted
        ? createWorkspaceHookTrustRecords({
            // 用户信任的是脚本存在时的同一声明位置。
            snapshot: guardSnapshot(
              { kind: "file", sha256: TRUSTED_SHA },
              FILE_DIGEST,
              input.trustedCommand,
              input.trustedOnError === "allow" ? undefined : "deny",
            ),
            reviewItemIds: ["item-0"],
            grantedAt: "2026-11-16T00:00:00.000Z",
          })
        : [],
      { status: input.corrupt ? "corrupt" : "ok" },
    );
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator,
      ready: Promise.resolve(),
      snapshot: current,
      readScriptState: async () => {
        throw new Error("must not read");
      },
    });
    const events: SessionEvent[] = [];
    const commands: string[] = [];
    const runner = createConfiguredHookRunner({
      config: { enabled: true, events: {}, maxOutputBytes: 32_768, timeoutMs: 60_000 },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort: executionPort(commands),
      getWorkingDirectory: () => WORKSPACE,
      workspaceHookAdmission: admission,
      workspaceHookSnapshot: current,
    });
    if (!runner) throw new Error("expected configured runner");
    await admission.activate("startup");
    const controller = new AbortController();
    if (input.abort) controller.abort();
    const result = await runner.run(preToolUseInput(), { signal: controller.signal });
    return { commands, events, result };
  }

  it.each([{ kind: "missing" }, { kind: "unverifiable" }] as const)(
    "曾信任的同一守卫发现时入口为 %j：HookRunBlocked，不启动进程，不拦截工具",
    async (state) => {
      const value = await run({ state, previouslyTrusted: true });
      expect(value.commands).toEqual([]);
      expect(value.result.permissionBehavior).toBeUndefined();
      expect(value.events[0]?.type).toBe(SessionEventType.HookRunBlocked);
      expect((value.events[0]?.payload as HookRunLifecyclePayload).errorCode).toBe(
        "workspace_hook_script_unavailable",
      );
    },
  );

  // 第七轮 CR 的 DoS 场景：曾信任 onError: allow 的普通 Hook，仓库改成 deny 并删除脚本。
  it("曾信任的普通 Hook 被改为 onError: deny 并删除脚本：不拦截工具", async () => {
    const value = await run({
      state: { kind: "missing" },
      previouslyTrusted: true,
      trustedOnError: "allow",
    });
    expect(value.commands).toEqual([]);
    expect(value.result.permissionBehavior).toBeUndefined();
  });

  it("从未信任过的守卫入口不可用：不拦截", async () => {
    const value = await run({ state: { kind: "missing" }, previouslyTrusted: false });
    expect(value.result.permissionBehavior).toBeUndefined();
  });

  it("Trust store 损坏时按 store 原因阻断，不按守卫出错处理", async () => {
    const value = await run({
      state: { kind: "missing" },
      previouslyTrusted: true,
      corrupt: true,
    });
    expect(value.result.permissionBehavior).toBeUndefined();
    expect((value.events[0]?.payload as HookRunLifecyclePayload).errorCode).toBe(
      "workspace_hooks_blocked_untrusted",
    );
  });

  it("用户已取消：不拦截", async () => {
    const value = await run({ state: { kind: "missing" }, previouslyTrusted: true, abort: true });
    expect(value.result.permissionBehavior).toBeUndefined();
  });
});

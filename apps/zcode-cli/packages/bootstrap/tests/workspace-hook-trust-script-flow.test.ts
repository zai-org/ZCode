// Workspace Hook Trust 端到端集成（docs/specs/workspace-hook-trust.md D23/D24）。
// 真实文件系统 + 真实配置发现 + 真实 Trust store + bootstrap 的 createWorkspaceHookRuntimeSecurity 装配，
// 只用记录型 ExecutionPort 代替进程启动：
// 1) 远程工作区：Settings 预信任 → 通知活跃会话重载 → Hook 执行 → revoke 后阻断；
// 2) 会话中替换或删除已信任脚本：HookRunBlocked、不创建进程；onError: deny 的守卫拦截工具调用。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  SessionEventType,
  type ExecutionPort,
  type HookInput,
  type HookRunLifecyclePayload,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import { createConfigWithPluginMigrations } from "@zcode/adapters/config";
import { InMemoryWorkspaceHookPolicyProvider, createConfiguredHookRunner } from "@zcode/core";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { createWorkspaceHookRuntimeSecurity } from "../src/app/workspace-hook-trust.js";
import { grantWorkspaceHookTrust } from "../src/workspace-hook-trust-cli.js";
import { grantWorkspaceHookTrustForProtocol } from "../src/zcode-protocol/workspace-hook-trust.js";
import { notifyWorkspaceHookTrustGrantSessions } from "../src/zcode-protocol/server.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};
const SSH = { kind: "ssh", host: "example.test", port: 22, username: "coder" } as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(event: "SessionStart" | "PreToolUse", hook: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-trust-flow-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  const userConfigPath = join(homeDir, ".zcode", "cli", "config.json");
  await mkdir(join(homeDir, ".zcode", "security"), { recursive: true });
  await mkdir(join(homeDir, ".zcode", "cli"), { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await mkdir(join(workspace, ".git"));
  // storage.dir 指向测试 HOME：CLI/协议授权与会话装配读写同一个 Trust store，不碰真实 HOME。
  await writeFile(
    userConfigPath,
    JSON.stringify({ storage: { dir: join(homeDir, ".zcode") }, hooks: { enabled: true, events: {} } }),
  );
  await writeFile(
    join(workspace, ".zcode", "config.json"),
    JSON.stringify({ hooks: { enabled: true, events: { [event]: [{ hooks: [hook] }] } } }),
  );
  await writeFile(join(workspace, "hook.sh"), "echo one\n", "utf8");
  return { homeDir, userConfigPath, workspace };
}

async function session(input: {
  homeDir: string;
  userConfigPath: string;
  workspace: string;
  workspaceKey?: string;
}) {
  const config = await createConfigWithPluginMigrations({
    env: {},
    userConfigPath: input.userConfigPath,
    workingDirectory: input.workspace,
    ...(input.workspaceKey ? { workspaceIdentity: input.workspaceKey } : {}),
  });
  const snapshot = config.sources.project.workspaceHookSnapshot;
  if (!snapshot) throw new Error("expected workspace hook snapshot");
  const security = createWorkspaceHookRuntimeSecurity({
    homeDir: input.homeDir,
    logger,
    policyProvider: new InMemoryWorkspaceHookPolicyProvider(),
    reviewHost: { taskId: "task-1", runId: "run-1", workspaceLabel: "workspace" },
    emitReviewEvent: async () => undefined,
    runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    sessionId: "sess-flow" as never,
    snapshot,
    userConfigPath: input.userConfigPath,
    workspaceHookTrustEnabled: true,
    ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
    workingDirectory: input.workspace,
  });
  if (!security) throw new Error("expected runtime security");
  const commands: string[] = [];
  const events: SessionEvent[] = [];
  const executionPort: ExecutionPort = {
    async run(request) {
      commands.push(
        request.command.mode === "shell"
          ? request.command.command
          : [request.command.file, ...(request.command.args ?? [])].join(" "),
      );
      const now = new Date();
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
  const runner = createConfiguredHookRunner({
    config: { enabled: true, events: {}, maxOutputBytes: 32_768, timeoutMs: 60_000 },
    emitEvent: async (event) => {
      events.push(event);
    },
    executionPort,
    getWorkingDirectory: () => input.workspace,
    workspaceHookAdmission: security.admission,
    workspaceHookSnapshot: security.snapshot,
  });
  if (!runner) throw new Error("expected configured runner");
  await security.admission.activate("startup");
  return { commands, events, runner, security, snapshot };
}

function hookInput(event: HookEventName, cwd: string): HookInput {
  return {
    cwd,
    hookEventName: event,
    mode: "build",
    sessionId: "sess-flow" as never,
    source: "startup",
    timestamp: new Date().toISOString(),
    toolInput: {},
    toolName: "Write",
    traceId: "trace-flow" as never,
  } as HookInput;
}

function lastErrorCode(events: SessionEvent[]): string | undefined {
  return (events.at(-1)?.payload as HookRunLifecyclePayload | undefined)?.errorCode;
}

describe("远程工作区：Settings 预信任 → 活跃会话重载 → Hook 执行 → revoke 后阻断", () => {
  it("全链路使用 host + 执行目录作为 Trust identity，其他 host 的会话不被通知", async () => {
    const value = await fixture("SessionStart", {
      type: "process",
      command: "sh",
      args: ["hook.sh"],
    });
    const workspaceKey = buildRemoteWorkspaceIdentity(value.workspace, SSH);
    const live = await session({ ...value, workspaceKey });
    const entry = live.snapshot.hooks[0]!;
    expect(live.snapshot.workspaceIdentity).toBe(workspaceKey);
    expect(entry.scriptEntry?.state.kind).toBe("file");

    // 未信任：阻断，不创建进程。
    await live.runner.run(hookInput(HookEventName.SessionStart, value.workspace), {
      matchValue: "startup",
    });
    expect(live.commands).toEqual([]);
    expect(lastErrorCode(live.events)).toBe("workspace_hooks_pending_trust");

    // Settings 预信任（无 task 的协议入口），store 写在测试 HOME。
    const ref = { workspacePath: value.workspace, workspaceIdentity: workspaceKey, workspaceKey };
    await expect(
      grantWorkspaceHookTrustForProtocol(
        {
          workspace: ref,
          bundleDigest: live.snapshot.bundleDigest,
          hookDeclarationDigest: entry.hookDeclarationDigest,
        },
        {
          grant: (input) => grantWorkspaceHookTrust({ ...input, userConfigPath: value.userConfigPath }),
          policyProvider: new InMemoryWorkspaceHookPolicyProvider(),
        },
      ),
    ).resolves.toEqual({ accepted: true });

    // 授权落盘后按 Trust identity 通知活跃会话重载；其他 host 的同路径会话不受影响。
    const otherReload = vi.fn(async () => undefined);
    const otherKey = buildRemoteWorkspaceIdentity(value.workspace, {
      ...SSH,
      host: "other.example.test",
    });
    await notifyWorkspaceHookTrustGrantSessions({
      grantedWorkspace: ref,
      sessions: new Map([
        ["live", { workspace: ref, app: { reloadWorkspaceHookTrust: () => live.security.reloadTrust() } }],
        [
          "other",
          {
            workspace: { workspacePath: value.workspace, workspaceIdentity: otherKey, workspaceKey: otherKey },
            app: { reloadWorkspaceHookTrust: otherReload },
          },
        ],
      ]) as never,
    });
    expect(otherReload).not.toHaveBeenCalled();

    await live.runner.run(hookInput(HookEventName.SessionStart, value.workspace), {
      matchValue: "startup",
    });
    expect(live.commands).toEqual(["sh hook.sh"]);
    expect(live.events.at(-1)?.type).toBe(SessionEventType.HookRunCompleted);

    // revoke 后下一次 dispatch 阻断，不再创建进程。
    await expect(
      live.security.revokeCurrent({
        sessionId: "sess-flow",
        workspaceIdentity: workspaceKey,
        bundleDigest: live.snapshot.bundleDigest,
        hookDeclarationDigests: [entry.hookDeclarationDigest],
      }),
    ).resolves.toMatchObject({ accepted: true });
    await live.runner.run(hookInput(HookEventName.SessionStart, value.workspace), {
      matchValue: "startup",
    });
    expect(live.commands).toEqual(["sh hook.sh"]);
    expect(live.events.at(-1)?.type).toBe(SessionEventType.HookRunBlocked);
  });
});

describe("会话中替换或删除已信任脚本（真实文件系统）", () => {
  async function trustedGuard() {
    const value = await fixture("PreToolUse", {
      type: "process",
      command: "sh",
      args: ["hook.sh"],
      onError: "deny",
    });
    const live = await session(value);
    const entry = live.snapshot.hooks[0]!;
    await grantWorkspaceHookTrust({
      workspacePath: value.workspace,
      userConfigPath: value.userConfigPath,
      hookDeclarationDigests: [entry.hookDeclarationDigest],
    });
    await live.security.reloadTrust();
    const first = await live.runner.run(hookInput(HookEventName.PreToolUse, value.workspace));
    expect(live.commands).toEqual(["sh hook.sh"]);
    expect(first.permissionBehavior).toBeUndefined();
    return { ...value, ...live };
  }

  it("脚本被替换：HookRunBlocked(declaration_changed)，不创建进程，onError: deny 拦截工具", async () => {
    const value = await trustedGuard();
    await writeFile(join(value.workspace, "hook.sh"), "echo replaced\n", "utf8");
    const result = await value.runner.run(hookInput(HookEventName.PreToolUse, value.workspace));
    expect(value.commands).toEqual(["sh hook.sh"]);
    expect(value.events.at(-1)?.type).toBe(SessionEventType.HookRunBlocked);
    expect(lastErrorCode(value.events)).toBe("workspace_hook_declaration_changed");
    expect(result.permissionBehavior).toBe("deny");
  });

  it("脚本被删除：HookRunBlocked(script_unavailable)，不创建进程，onError: deny 拦截工具", async () => {
    const value = await trustedGuard();
    await rm(join(value.workspace, "hook.sh"));
    const result = await value.runner.run(hookInput(HookEventName.PreToolUse, value.workspace));
    expect(value.commands).toEqual(["sh hook.sh"]);
    expect(lastErrorCode(value.events)).toBe("workspace_hook_script_unavailable");
    expect(result.permissionBehavior).toBe("deny");
  });

  // 发现阶段没有可审核的内容，无法证明当前声明就是曾信任的那一条（第七轮 CR 的 DoS），按未信任跳过。
  it("下一个会话发现阶段脚本已删除：守卫被跳过，不启动进程，不拦截工具", async () => {
    const value = await trustedGuard();
    await rm(join(value.workspace, "hook.sh"));
    const next = await session(value);
    expect(next.snapshot.hooks[0]?.scriptEntry?.state.kind).toBe("missing");
    const result = await next.runner.run(hookInput(HookEventName.PreToolUse, value.workspace));
    expect(next.commands).toEqual([]);
    expect(lastErrorCode(next.events)).toBe("workspace_hook_script_unavailable");
    expect(result.permissionBehavior).toBeUndefined();
  });
});

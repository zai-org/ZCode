import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookEventName, createWorkspaceHookBundleSnapshot } from "@zcode/contracts";
import type { Logger } from "@zcode/contracts";
import { createWorkspaceHookRuntimeSecurity } from "../src/app/workspace-hook-trust.js";

const WORKSPACE = "local:/workspace";
const BUNDLE = "c".repeat(64);
const DIGEST_A = "a".repeat(64);

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

// P2 回归：Settings pretrust（无 task）授权写盘后，运行中 session 必须通过
// reloadTrust 把 Trust store 重载进 coordinator 并重发 admission 状态——否则
// 已信任 Hook 继续被拒、banner pendingCount 停留旧值（bug 根因见
// workspace-hook-trust.ts reloadTrust 注释）。
describe("createWorkspaceHookRuntimeSecurity reloadTrust", () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  async function tempHome(): Promise<{ homeDir: string; storePath: string }> {
    const homeDir = await mkdtemp(join(tmpdir(), "hook-trust-reload-"));
    cleanup.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(homeDir, { recursive: true, force: true });
    });
    const { mkdir } = await import("node:fs/promises");
    const securityDir = join(homeDir, ".zcode", "security");
    await mkdir(securityDir, { recursive: true });
    const storePath = join(securityDir, "workspace-hook-trust-v1.json");
    await writeFile(storePath, JSON.stringify({ schemaVersion: 1, records: [] }), "utf8");
    return { homeDir, storePath };
  }

  function snapshot() {
    return createWorkspaceHookBundleSnapshot({
      schemaVersion: 1,
      workspaceIdentity: WORKSPACE,
      discoveredAt: "2026-08-06T00:00:00.000Z",
      digestAlgorithm: "sha256",
      bundleDigest: BUNDLE,
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
          matcher: "startup",
          type: "command",
          command: "echo project",
          resolvedTimeoutMs: 60_000,
          resolvedMaxOutputBytes: 32_768,
          declarationEnabled: true,
          sourceRootEnabled: true,
          runtimeHooksEnabled: true,
          configuredEnabled: true,
          editable: true,
          declarationDigestAlgorithm: "sha256",
          hookDeclarationDigest: DIGEST_A,
        },
      ],
    });
  }

  it("reloads externally granted trust into the live admission and re-emits state", async () => {
    const { homeDir, storePath } = await tempHome();
    // userConfigPath 指向临时 home 下的空配置：readUserConfig 找不到文件时按空配置处理，
    // store 路径 = <homeDir>/.zcode/security/workspace-hook-trust-v1.json。
    const userConfigPath = join(homeDir, ".zcode", "cli", "config.json");

    const emitted: Array<{ pendingCount: number }> = [];
    const security = createWorkspaceHookRuntimeSecurity({
      emitAdmissionEvent: async (event) => {
        emitted.push({ pendingCount: event.payload.pendingCount });
      },
      homeDir,
      logger,
      runtimeRoot: { enabled: true },
      sessionId: "sess_test",
      snapshot: snapshot(),
      userConfigPath,
      workspaceHookTrustEnabled: true,
      workingDirectory: "/workspace",
    });
    if (!security) throw new Error("security not created");

    await security.admission.activate("startup");
    expect(emitted.at(-1)?.pendingCount).toBe(1);

    // 模拟 Settings pretrust：另一个写入方直接往 store 文件追加一条 trusted 记录。
    const grantTime = new Date().toISOString();
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            workspaceIdentity: WORKSPACE,
            hookDeclarationDigest: DIGEST_A,
            digestAlgorithm: "sha256",
            decision: "trusted",
            grantedAt: grantTime,
            bundleDigestAtGrant: BUNDLE,
            eventAtGrant: "SessionStart",
            displayCommandAtGrant: "echo project",
            sourcePathAtGrant: ".zcode/config.json",
            sourceDiscoveryOrderAtGrant: 0,
            matcherAtGrant: "startup",
            matcherIndexAtGrant: 0,
            hookIndexAtGrant: 0,
          },
        ],
      }),
      "utf8",
    );

    await security.reloadTrust();

    // coordinator 已重载：该声明从 pending 变 trusted，admission 重发 pendingCount=0。
    expect(emitted.at(-1)?.pendingCount).toBe(0);
    expect(
      security.admission.evaluateDispatch({
        reviewItemId: "item-0",
        hookDeclarationDigest: DIGEST_A,
        bundleDigest: BUNDLE,
      }),
    ).toEqual({ allowed: true });

    // store 文件未被 reload 路径改写（只读重载）。
    const after = JSON.parse(await readFile(storePath, "utf8"));
    expect(after.records).toHaveLength(1);
  });

  it("D23：AdmissionUpdated 对外发会话 workspaceKey，而不是 snapshot 的 Trust identity", async () => {
    const { homeDir } = await tempHome();
    const workspaceKey = "/data/.zcode/worktrees/3f2a/workspace";
    const emitted: Array<{ workspaceIdentity?: string }> = [];
    const security = createWorkspaceHookRuntimeSecurity({
      emitAdmissionEvent: async (event) => {
        emitted.push({ workspaceIdentity: event.payload.workspaceIdentity });
      },
      homeDir,
      logger,
      runtimeRoot: { enabled: true },
      sessionId: "sess_test",
      snapshot: snapshot(),
      userConfigPath: join(homeDir, ".zcode", "cli", "config.json"),
      workspaceHookTrustEnabled: true,
      workspaceKey,
      workingDirectory: "/workspace",
    });
    if (!security) throw new Error("security not created");
    await security.admission.activate("startup");
    expect(security.snapshot.workspaceIdentity).toBe(WORKSPACE);
    expect(emitted.at(-1)).toEqual({ workspaceIdentity: workspaceKey });
  });

  it("is a safe no-op when the trust feature is disabled", async () => {
    const { homeDir } = await tempHome();
    const security = createWorkspaceHookRuntimeSecurity({
      homeDir,
      logger,
      runtimeRoot: { enabled: true },
      sessionId: "sess_test",
      snapshot: snapshot(),
      userConfigPath: join(homeDir, ".zcode", "cli", "config.json"),
      workspaceHookTrustEnabled: false,
      workingDirectory: "/workspace",
    });
    if (!security) throw new Error("security not created");
    await expect(security.reloadTrust()).resolves.toBeUndefined();
  });
});

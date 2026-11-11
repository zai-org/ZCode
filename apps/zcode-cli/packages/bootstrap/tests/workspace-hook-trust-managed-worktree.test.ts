// CLI 侧 Hook Trust identity 接入（docs/specs/workspace-hook-trust.md D23，docs/git/worktree.md §6.2）。
// 真实 git 临时仓库 + ZCODE_DATA_BASE_DIR 临时目录，按 <dataBaseDir>/.zcode/worktrees/<4hex>/<repo>
// 布局创建受管 worktree，验证 Trust CLI、协议授予与活跃 session 重载都按 Trust identity 工作。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
} from "../src/workspace-hook-trust-cli.js";
import { grantWorkspaceHookTrustForProtocol } from "../src/zcode-protocol/workspace-hook-trust.js";
import { notifyWorkspaceHookTrustGrantSessions } from "../src/zcode-protocol/server.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BUCKET = "3f2a";
const REPO = "repo";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.name=ZCode Test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );
}

async function fixture() {
  // resolver 按 realpath 判定；macOS 临时目录是软链，fixture 统一用 realpath。
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcode-hook-trust-worktree-")));
  roots.push(root);
  const source = join(root, "projects", REPO);
  const dataBaseDir = join(root, "data");
  const worktree = join(dataBaseDir, ".zcode", "worktrees", BUCKET, REPO);
  const userConfigPath = join(root, "config.json");
  await writeFile(
    userConfigPath,
    JSON.stringify({
      storage: { dir: join(root, "user-data") },
      hooks: { enabled: true, events: {} },
    }),
  );
  await mkdir(join(source, ".zcode"), { recursive: true });
  await writeFile(
    join(source, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: "./start.sh" }] },
          ],
        },
      },
    }),
  );
  await git(source, "init", "-q");
  await git(source, "add", ".");
  await git(source, "commit", "-q", "-m", "init");
  await mkdir(join(dataBaseDir, ".zcode", "worktrees", BUCKET), { recursive: true });
  await git(source, "worktree", "add", "-q", "--detach", worktree);
  const env = { ZCODE_DATA_BASE_DIR: dataBaseDir };
  return { dataBaseDir, env, root, source, userConfigPath, worktree };
}

async function trustSourceHook(value: Awaited<ReturnType<typeof fixture>>) {
  const pending = await inspectWorkspaceHookTrust({
    workspacePath: value.source,
    userConfigPath: value.userConfigPath,
    env: value.env,
  });
  const digest = pending.items[0]!.hookDeclarationDigest;
  await grantWorkspaceHookTrust({
    workspacePath: value.source,
    userConfigPath: value.userConfigPath,
    env: value.env,
    hookDeclarationDigests: [digest],
  });
  return digest;
}

describe("Workspace Hook Trust：受管 worktree 继承源仓库", () => {
  it("源仓库已有 Trust record 时，worktree 中同一声明直接 trusted，identity 为源仓库路径", async () => {
    const value = await fixture();
    const digest = await trustSourceHook(value);

    const status = await inspectWorkspaceHookTrust({
      workspacePath: value.worktree,
      userConfigPath: value.userConfigPath,
      env: value.env,
    });
    expect(status.workspacePath).toBe(value.worktree);
    expect(status.workspaceIdentity).toBe(value.source);
    expect(status.reasonCode).toBe("workspace_hooks_trusted_persistent");
    expect(status.items).toEqual([
      expect.objectContaining({ hookDeclarationDigest: digest, trustState: "trusted_persistent" }),
    ]);
  });

  it("伪造 gitdir 反向链接时不继承，worktree 中该声明回到 pending", async () => {
    const value = await fixture();
    await trustSourceHook(value);
    await writeFile(
      join(value.source, ".git", "worktrees", REPO, "gitdir"),
      `${join(value.root, "elsewhere", ".git")}\n`,
    );

    const status = await inspectWorkspaceHookTrust({
      workspacePath: value.worktree,
      userConfigPath: value.userConfigPath,
      env: value.env,
    });
    expect(status.workspaceIdentity).toBe(value.worktree);
    expect(status.reasonCode).toBe("workspace_hooks_pending_trust");
  });

  it("远程 identity 原样作为 Trust identity，不做本地解析", async () => {
    const value = await fixture();
    const identity = "remote:ssh:example.test:22:coder:/workspace/repo";
    const status = await inspectWorkspaceHookTrust({
      workspacePath: value.worktree,
      workspaceIdentity: identity,
      userConfigPath: value.userConfigPath,
      env: value.env,
    });
    expect(status.workspaceIdentity).toBe(identity);
  });

  it("协议授予在 worktree 中按 Trust identity 评估 policy 并写入源仓库 record", async () => {
    const value = await fixture();
    vi.stubEnv("ZCODE_DATA_BASE_DIR", value.dataBaseDir);
    const pending = await inspectWorkspaceHookTrust({
      workspacePath: value.worktree,
      userConfigPath: value.userConfigPath,
      env: value.env,
    });
    const policyProvider = new InMemoryWorkspaceHookPolicyProvider({
      mode: "user_decides",
      policyRevision: "test:user-decides:v1",
    });
    const getPolicy = vi.spyOn(policyProvider, "getPolicy");
    const grant = vi.fn((input: Parameters<typeof grantWorkspaceHookTrust>[0]) =>
      grantWorkspaceHookTrust({ ...input, userConfigPath: value.userConfigPath }),
    );

    await expect(
      grantWorkspaceHookTrustForProtocol(
        {
          workspace: { workspacePath: value.worktree, workspaceKey: value.worktree },
          bundleDigest: pending.bundleDigest!,
          hookDeclarationDigest: pending.items[0]!.hookDeclarationDigest,
        },
        { grant, policyProvider },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(getPolicy).toHaveBeenCalledWith(value.source);
    const sourceStatus = await inspectWorkspaceHookTrust({
      workspacePath: value.source,
      userConfigPath: value.userConfigPath,
      env: value.env,
    });
    expect(sourceStatus.reasonCode).toBe("workspace_hooks_trusted_persistent");
  });

  it("Trust 授予通知同一 Trust identity 下的源仓库与 worktree session，跳过无关 workspace", async () => {
    const value = await fixture();
    vi.stubEnv("ZCODE_DATA_BASE_DIR", value.dataBaseDir);
    const session = (workspacePath: string) => {
      const reload = vi.fn(async () => undefined);
      return {
        reload,
        record: {
          app: { reloadWorkspaceHookTrust: reload },
          workspace: { workspaceKey: workspacePath, workspacePath },
        } as never,
      };
    };
    const inSource = session(value.source);
    const inWorktree = session(value.worktree);
    const other = session(join(value.root, "other"));

    await notifyWorkspaceHookTrustGrantSessions({
      grantedWorkspace: { workspaceKey: value.source, workspacePath: value.source },
      sessions: new Map([
        ["s-source", inSource.record],
        ["s-worktree", inWorktree.record],
        ["s-other", other.record],
      ]),
    });
    expect(inSource.reload).toHaveBeenCalledTimes(1);
    expect(inWorktree.reload).toHaveBeenCalledTimes(1);
    expect(other.reload).not.toHaveBeenCalled();
  });
});

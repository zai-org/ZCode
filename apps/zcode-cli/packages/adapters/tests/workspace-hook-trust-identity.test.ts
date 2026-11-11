// Hook Trust identity 的 CLI adapter（docs/specs/workspace-hook-trust.md D23）。
// 用真实 git 临时仓库 + 受管 worktree 布局 <dataBaseDir>/.zcode/worktrees/<4hex>/<repo> 验证：
// - adapter 与共享 resolver 得到同一个 Trust identity；
// - Runtime snapshot（createConfig）在 worktree 中归一为源仓库路径，bundleDigest 与源仓库一致；
// - 伪造反向链接不继承；远程 identity 原样返回。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfig,
  resolveWorkspaceHookTrustIdentityForWorkspace,
} from "../src/config/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BUCKET = "3f2a";
const REPO = "repo";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.name=ZCode Test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );
}

/** 源仓库提交一条 workspace Hook，再按受管布局创建 detached worktree。 */
async function managedWorktreeFixture() {
  // macOS 临时目录 /var 是 /private/var 的软链；resolver 按 realpath 判定，fixture 也用 realpath。
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcode-hook-trust-identity-")));
  roots.push(root);
  const source = join(root, "projects", REPO);
  const dataBaseDir = join(root, "data");
  const worktree = join(dataBaseDir, ".zcode", "worktrees", BUCKET, REPO);
  await mkdir(join(source, ".zcode"), { recursive: true });
  await mkdir(join(source, "packages", "app"), { recursive: true });
  await writeFile(join(source, "packages", "app", "README.md"), "app\n");
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
  return { dataBaseDir, env: { ZCODE_DATA_BASE_DIR: dataBaseDir }, root, source, worktree };
}

describe("resolveWorkspaceHookTrustIdentityForWorkspace", () => {
  it("受管 worktree 及其子目录归一为源仓库中对应路径；源仓库与非受管目录保持自身路径", async () => {
    const value = await managedWorktreeFixture();
    await expect(
      resolveWorkspaceHookTrustIdentityForWorkspace({
        workspacePath: value.worktree,
        env: value.env,
      }),
    ).resolves.toBe(value.source);
    await expect(
      resolveWorkspaceHookTrustIdentityForWorkspace({
        workspacePath: join(value.worktree, "packages", "app"),
        env: value.env,
      }),
    ).resolves.toBe(join(value.source, "packages", "app"));
    await expect(
      resolveWorkspaceHookTrustIdentityForWorkspace({
        workspacePath: value.source,
        env: value.env,
      }),
    ).resolves.toBe(value.source);
    // ZCODE_DATA_BASE_DIR 指向别处时，同一路径不在受管根目录下，不继承。
    await expect(
      resolveWorkspaceHookTrustIdentityForWorkspace({
        workspacePath: value.worktree,
        env: { ZCODE_DATA_BASE_DIR: join(value.root, "other-data") },
      }),
    ).resolves.toBe(value.worktree);
  });

  it("伪造 gitdir 反向链接时不继承，退回 worktree 自身路径", async () => {
    const value = await managedWorktreeFixture();
    const adminDir = join(value.source, ".git", "worktrees", REPO);
    await writeFile(join(adminDir, "gitdir"), `${join(value.root, "elsewhere", ".git")}\n`);
    await expect(
      resolveWorkspaceHookTrustIdentityForWorkspace({
        workspacePath: value.worktree,
        env: value.env,
      }),
    ).resolves.toBe(value.worktree);
  });

  it("远程 identity 原样返回，不做本地解析", async () => {
    const value = await managedWorktreeFixture();
    const identity = "remote:ssh:example.test:22:coder:/workspace/repo";
    await expect(
      resolveWorkspaceHookTrustIdentityForWorkspace({
        workspacePath: value.worktree,
        workspaceIdentity: identity,
        env: value.env,
      }),
    ).resolves.toBe(identity);
  });
});

describe("Runtime snapshot 的 Trust identity", () => {
  it("worktree 中 snapshot identity 是源仓库路径，bundleDigest 与源仓库相同", async () => {
    const value = await managedWorktreeFixture();
    const build = async (workingDirectory: string) =>
      createConfig({
        env: value.env,
        skipUserConfig: true,
        workingDirectory,
        workspaceHookTrustIdentity: await resolveWorkspaceHookTrustIdentityForWorkspace({
          workspacePath: workingDirectory,
          env: value.env,
        }),
      }).sources.project.workspaceHookSnapshot;
    const inWorktree = await build(value.worktree);
    const inSource = await build(value.source);
    expect(inWorktree?.workspaceIdentity).toBe(value.source);
    expect(inSource?.workspaceIdentity).toBe(value.source);
    expect(inWorktree?.bundleDigest).toBe(inSource?.bundleDigest);
    expect(inWorktree?.hooks.map((hook) => hook.hookDeclarationDigest)).toEqual(
      inSource?.hooks.map((hook) => hook.hookDeclarationDigest),
    );
  });

  it("未提供 Trust identity 时保持原规则：远程 identity 优先，否则为工作目录", async () => {
    const value = await managedWorktreeFixture();
    expect(
      createConfig({ env: value.env, skipUserConfig: true, workingDirectory: value.worktree })
        .sources.project.workspaceHookSnapshot?.workspaceIdentity,
    ).toBe(value.worktree);
  });
});

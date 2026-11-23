import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_WORKSPACE } from "./desktop-app.js";

/**
 * 受管 worktree 的 Workspace Hook Trust 审核入口 fixture（HK20，ZP-20261110-06）。
 *
 * 源仓库提交 v1 入口脚本，再在工作区改成未提交的 v2：源仓库发现 v2，worktree 检出 v1，
 * 两边的 declaration digest 不同（D23、D24）。与 hook-trust-fixture 相同，必须在首个 agent
 * 进程冷启动前落盘（wdio.conf.ts resetE2EHome），否则源仓库任务的 SessionStart 软门禁不生效。
 */

export const HOOK_TRUST_WORKTREE_ENTRY_LABEL = "hook-trust-worktree-entry";

const execGit = promisify(execFile);
const ZCODE_DIR = join(DEFAULT_WORKSPACE, ".zcode");
const CONFIG_RELATIVE_PATH = join(".zcode", "config.json");
// 相对路径的 node 入口会被识别为直接入口脚本，内容参与 digest（D24）。
const SCRIPT_RELATIVE_PATH = ".zcode/hook-trust-worktree.mjs";

async function git(...args: string[]): Promise<void> {
  await execGit("git", args, { cwd: DEFAULT_WORKSPACE });
}

export async function installHookTrustWorktreeFixture(): Promise<void> {
  await mkdir(ZCODE_DIR, { recursive: true });
  await writeFile(
    join(DEFAULT_WORKSPACE, CONFIG_RELATIVE_PATH),
    `${JSON.stringify(
      {
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [
                  {
                    type: "process",
                    command: "node",
                    args: [SCRIPT_RELATIVE_PATH, HOOK_TRUST_WORKTREE_ENTRY_LABEL],
                    enabled: true,
                    timeoutMs: 10000,
                  },
                ],
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const scriptPath = join(DEFAULT_WORKSPACE, SCRIPT_RELATIVE_PATH);
  await writeFile(scriptPath, "// hook-trust-worktree v1\n", "utf8");
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "zcode-e2e@example.invalid");
  await git("config", "user.name", "ZCode E2E");
  await git("add", CONFIG_RELATIVE_PATH, SCRIPT_RELATIVE_PATH);
  await git("commit", "-qm", "test: workspace hook v1");
  // 未提交的 v2 只存在于源仓库；新建的 worktree 检出已提交的 v1。
  await writeFile(scriptPath, "// hook-trust-worktree v2\n", "utf8");
}

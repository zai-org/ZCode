import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { ensureProjectExpanded } from "#e2e/helpers/project-sidebar";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("FX13：fork 回滚后的会话隔离与桌面冷恢复", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("并发写入成功的会话在 fork 失败后仍可跨完整进程重启打开", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const firstPid = await browser.electron.execute(() => process.pid);
    let seeded: { pid: number; sessionId: string; marker: string } | undefined;
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        // 等旧 Electron/Host/Agent 全部退出，再通过真实 store 制造交错；不直接改 CLI 数据库行。
        // 旧代码会把其他会话的成功写入包含在 fork 事务中回滚，worker 断言会先失败。
        const worker = resolve(
          "../../apps/zcode-cli/packages/adapters/tests/fixtures/session-transaction-process.ts",
        );
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            worker,
            "seed",
            join(homedir(), ".zcode", "cli", "db", "db.sqlite"),
            DEFAULT_WORKSPACE,
          ],
          { env: { ...process.env, NODE_NO_WARNINGS: "1" } },
        );
        seeded = JSON.parse(stdout) as NonNullable<typeof seeded>;
        seedTaskMembership(seeded.sessionId);
      },
    });
    expect(await browser.electron.execute(() => process.pid)).not.toBe(firstPid);
    if (!seeded) throw new Error("FX13 缺少真实存储夹具结果");
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    await selectV4TaskById(seeded.sessionId, 60_000);
    await waitForV4TimelineContaining(seeded.marker, 30_000);
    await startNewV4Draft();
    const secondPid = await browser.electron.execute(() => process.pid);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    expect(await browser.electron.execute(() => process.pid)).not.toBe(secondPid);
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    await selectV4TaskById(seeded.sessionId, 60_000);
    await waitForV4TimelineContaining(seeded.marker, 30_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === seeded?.sessionId && !snapshot.canStop,
      "FX13 重启后未恢复同一会话",
      30_000,
    );
  });
});

function seedTaskMembership(sessionId: string): void {
  // 正式桌面任务同时拥有 Host membership 和 CLI 历史。只写 CLI 会构造不完整夹具，
  // 不能依赖 sessions-index 反向补齐侧栏。这里只补 Host 归属，不改刚验证的 CLI 库。
  // Node 内置 SQLite 仅提供 DatabaseSync；旧进程已退出，句柄在启动新进程前关闭。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  const now = Date.now();
  try {
    database
      .prepare(`
      INSERT INTO tasks (
        workspace_key, workspace_path, task_id, title, provider, mode,
        created_at, updated_at, meta_json
      ) VALUES (?, ?, ?, ?, 'glm', 'build', ?, ?, ?)
    `)
      .run(
        DEFAULT_WORKSPACE,
        DEFAULT_WORKSPACE,
        sessionId,
        sessionId,
        now,
        now,
        JSON.stringify({
          taskId: sessionId,
          title: sessionId,
          workspacePath: DEFAULT_WORKSPACE,
          createdAt: now,
          updatedAt: now,
          mode: "build",
          provider: "glm",
        }),
      );
  } finally {
    database.close();
  }
}

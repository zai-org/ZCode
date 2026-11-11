import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

const home = process.env.ZCODE_E2E_HOME_DIR!;
const prefix = "e2e-bulk-archive-";
const control = `${prefix}active`;

describe("TSL39：一键删除全部归档任务", () => {
  after(async () => {
    await clearAppData();
  });
  it("取消不写入，确认删除折叠组的全部 25 条并保留普通任务并物理删除归档 CLI 记录", async function () {
    this.timeout(240000);
    // 修复原因：直接运行 wdio 时默认 HOME 是 `.e2e-home`（无 runId 后缀），旧守卫只认
    // `.e2e-home-*`，在 CI/本地单跑时误报；两种隔离目录名都只存在于 E2E runner。
    if (!home || !/^\.e2e-home(?:-|$)/u.test(basename(home)))
      throw new Error("isolated E2E HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    // 旧夹具依赖已移除的 runner 开关，且只有 Host 摘要，无法验证当前 CLI 删除命令。
    // 在进程退出后准备两库完整历史，冷启读取；执行阶段只经真实 UI 发送删除。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
        try {
          const project = db
            .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
            .get(DEFAULT_WORKSPACE) as { project_id: string };
          const now = Date.now();
          for (let i = 0; i < 26; i++) {
            const id = i === 25 ? control : `${prefix}${i}`;
            const title = `E2E_BULK_ARCHIVE_${i}`,
              archived = i === 25 ? 0 : 1;
            cli
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
              )
              .run(id, "e2e-bulk-cli-scope", id, DEFAULT_WORKSPACE, title, now, now);
            db.prepare(
              "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,?,?, 'custom',?,?,'completed',0,?)",
            ).run(
              DEFAULT_WORKSPACE,
              DEFAULT_WORKSPACE,
              id,
              title,
              now,
              now,
              DEFAULT_WORKSPACE,
              project.project_id,
              archived,
              title,
              now,
              now,
              JSON.stringify({
                taskId: id,
                traceId: id,
                title,
                workspacePath: DEFAULT_WORKSPACE,
                createdAt: now,
                updatedAt: now,
                mode: "build",
                archived: Boolean(archived),
              }),
            );
          }
        } finally {
          db.close();
          cli.close();
        }
      },
    });
    expect(readCounts()).toEqual({
      archived: 25,
      deleted: 0,
      active: 1,
      cliRows: 26,
      cliDeleted: 0,
    });
    const removedVisitKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", `${prefix}0`])}`;
    const retainedVisitKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", control])}`;
    await browser.execute(
      (keys) => {
        const visit = JSON.stringify([
          {
            url: "https://example.test/browser-history",
            title: "Browser history",
            faviconUrl: null,
            lastVisitedAt: Date.now(),
          },
        ]);
        localStorage.setItem(keys.removed, visit);
        localStorage.setItem(keys.retained, visit);
      },
      { removed: removedVisitKey, retained: retainedVisitKey },
    );
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
    // 分组收起没有行 DOM；批量目标必须来自完整权威集合，不能只删除已渲染行。
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    const removeAll = $('[data-testid="archive-delete-all"]');
    await removeAll.click();
    const confirmation = $('[data-confirm-intent="archive-management-delete"]');
    await expect(confirmation).toHaveText(expect.stringContaining("25"));
    await browser.keys("Escape");
    await confirmation.waitForExist({ reverse: true });
    const historyAfterCancel = await browser.execute(
      (key) => localStorage.getItem(key),
      removedVisitKey,
    );
    expect(historyAfterCancel).not.toBeNull();
    expect(readCounts()).toEqual({
      archived: 25,
      deleted: 0,
      active: 1,
      cliRows: 26,
      cliDeleted: 0,
    });
    await removeAll.click();
    await expect(confirmation).toHaveText(expect.stringContaining("25"));
    await $('[data-testid="confirm-dialog-confirm"]').click();
    // 永久删除走存储控制面，无需冷恢复 25 个 Agent runtime。
    await browser.waitUntil(() => readCounts().cliRows === 1, { timeout: 120000 });
    expect(readCounts()).toEqual({
      archived: 0,
      deleted: 0,
      active: 1,
      cliRows: 1,
      cliDeleted: 0,
    });
    await expect(removeAll).toBeDisabled();
    const visitsAfterDelete = await browser.execute(
      (keys) => ({
        removed: localStorage.getItem(keys.removed),
        retained: localStorage.getItem(keys.retained),
      }),
      { removed: removedVisitKey, retained: retainedVisitKey },
    );
    expect(visitsAfterDelete.removed).toBeNull();
    expect(visitsAfterDelete.retained).not.toBeNull();
    expect(await $$('[data-testid="archive-group"]').length).toBe(0);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "delete-all-archived-tasks.png"),
    );
  });
});

function readCounts() {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
  try {
    return {
      ...(db
        .prepare(
          "SELECT sum(archived=1 AND cli_deleted=0) AS archived, sum(cli_deleted=1) AS deleted, sum(task_id=? AND archived=0 AND cli_deleted=0) AS active FROM tasks WHERE task_id LIKE ?",
        )
        .get(control, `${prefix}%`) as { archived: number; deleted: number; active: number }),
      ...(cli
        .prepare(
          "SELECT count(*) AS cliRows, sum(time_deleted IS NOT NULL) AS cliDeleted FROM session WHERE id LIKE ?",
        )
        .get(`${prefix}%`) as { cliRows: number; cliDeleted: number }),
    };
  } finally {
    db.close();
    cli.close();
  }
}

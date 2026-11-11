import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { loginWithApiKey } from "#e2e/helpers/conversation-session";
import {
  SAVED_PROJECT_NAMES,
  MIGRATED_REMOTE_NAME,
  LEGACY_PINNED_TASK_IDS,
  CURRENT_IMPORTED_TASK_ID,
} from "#e2e/helpers/project-upgrade-order-fixture";

describe("虚拟项目升级顺序", () => {
  it("VP28：仅迁移旧设置保留的项目，历史任务不建项目，刷新保留", async function () {
    this.timeout(90_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const expected = ["ZCodeProject", MIGRATED_REMOTE_NAME, ...SAVED_PROJECT_NAMES];
    const readNames = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="project-section"] [data-project-name]')].map(
          (node) => node.getAttribute("data-project-name"),
        ),
      );
    await $('[data-project-name="empty-saved"]').waitForExist({ timeout: 30_000 });
    expect(await readNames()).toEqual(expected);
    for (const id of LEGACY_PINNED_TASK_IDS)
      expect(await $(`[data-testid="task-item-${id}"]`).isExisting()).toBe(false);
    await expect($(`[data-testid="task-item-${CURRENT_IMPORTED_TASK_ID}"]`)).toHaveText(
      expect.stringContaining("E2E_CURRENT_IMPORTED"),
    );
    const home = process.env.ZCODE_E2E_HOME_DIR;
    if (!home) throw new Error("isolated E2E HOME required");
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM schema_migration").all()).toEqual([
        { id: "0005_projects" },
        { id: "0006_default_workspace_tasks" },
        { id: "0007_initial_workspace_order" },
        { id: "0008_remote_entry_deleted_cache" },
        // 失败原因：新增 tasks_index 迁移（0009、两个 0010）后，这份完整清单没有同步。
        { id: "0009_session_creation_commands" },
        { id: "0010_remote_task_ownership" },
        { id: "0010_task_worktree_root" },
      ]);
      expect(
        db
          .prepare(
            "SELECT project_id,workspace_path,archived FROM tasks WHERE task_id='e2e-system-default'",
          )
          .get(),
      ).toEqual({
        project_id: null,
        workspace_path: join(home, ".zcode/workspace/default"),
        archived: 0,
      });
      expect(
        await $(
          '[data-testid="conversation-section"] [data-testid="task-item-e2e-system-default"]',
        ).getText(),
      ).toContain("E2E_SYSTEM_DEFAULT");
      for (const [name, archived, deleted] of [
        ["a-history", 0, 0],
        ["archived-history", 1, 0],
        ["deleted-history", 1, 1],
      ] as const) {
        expect(
          db
            .prepare(
              "SELECT project_id,workspace_path,title,archived,deleted FROM tasks WHERE task_id=?",
            )
            .get(`e2e-order-${name}`),
        ).toEqual({
          project_id: null,
          workspace_path: join(home, "ZCodeProject", ".zcode-e2e", "project-upgrade-order", name),
          title: `E2E_ORDER_${name}`,
          archived,
          deleted,
        });
      }
      await expect(
        $('[data-testid="conversation-section"] [data-testid="task-item-e2e-order-a-history"]'),
      ).toHaveText(expect.stringContaining("E2E_ORDER_a-history"));
      expect(await $('[data-testid="task-item-e2e-order-archived-history"]').isExisting()).toBe(
        false,
      );
      expect(await $('[data-testid="task-item-e2e-order-deleted-history"]').isExisting()).toBe(
        false,
      );
      const upstream = db
        .prepare("SELECT id,time_applied FROM tasks_schema_migration ORDER BY id")
        .all();
      expect(upstream.map((row) => row.id)).toEqual([
        "0001_adopt_task_schema",
        "0002_provider_selection",
        "0003_official_glm_selection",
        "0004_project_execution_scopes",
        "0006_task_group_admissions",
        // 同上：tasks 库新增 0007 迁移后清单没有同步。
        "0007_task_permanent_deletion",
      ]);
      const projectAppliedAt = db
        .prepare("SELECT applied_at FROM schema_migration WHERE id='0005_projects'")
        .get()!.applied_at;
      expect(upstream.every((row) => Number(row.time_applied) <= Number(projectAppliedAt))).toBe(
        true,
      );
      expect(
        db
          .prepare("SELECT name FROM projects WHERE deleted=0 ORDER BY position")
          .all()
          .map((row) => row.name),
      ).toEqual(expected.filter((name) => name !== MIGRATED_REMOTE_NAME));
      expect(
        db.prepare("SELECT cached_name,initial_position FROM remote_project_entries").all(),
      ).toEqual([{ cached_name: MIGRATED_REMOTE_NAME, initial_position: 1 }]);
    } finally {
      db.close();
    }
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-upgrade-order.png"),
    );
    await browser.refresh();
    try {
      // 隔离夹具无账号登录态；刷新可能回欢迎页，复用真实登录步骤后再检查顺序。
      const login = $('[data-testid="login-use-api-key-button"]');
      await browser.waitUntil(
        async () =>
          (await login.isExisting()) || (await $('[data-project-name="empty-saved"]').isExisting()),
        { timeout: 45_000 },
      );
      if (await login.isExisting()) await loginWithApiKey();
      await $('[data-project-name="empty-saved"]').waitForExist({ timeout: 45_000 });
    } catch (error) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-upgrade-refresh-failed.png"),
      );
      process.stderr.write(
        `VP28 refresh state: ${JSON.stringify(await browser.execute(() => ({ text: document.body.innerText.slice(0, 2000), url: location.href })))}\n`,
      );
      throw error;
    }
    expect(await readNames()).toEqual(expected);
    // 项目节点先出现不代表任务行已可见，刷新后等待用户能读到的标题。
    await expect(
      $('[data-testid="conversation-section"] [data-testid="task-item-e2e-order-a-history"]'),
    ).toHaveText(expect.stringContaining("E2E_ORDER_a-history"));
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "project-upgrade-refreshed.png"),
    );
  });

  it("VP28：旧后端置顶行保持隐藏，当前后端导入会话仍可取消置顶和归档", async () => {
    for (const id of LEGACY_PINNED_TASK_IDS)
      expect(await $(`[data-testid="task-item-${id}"]`).isExisting()).toBe(false);
    const row = $(`[data-testid="task-item-${CURRENT_IMPORTED_TASK_ID}"]`);
    await row.$('button[aria-label="取消置顶任务"], button[aria-label="Unpin task"]').click();
    const unpinned = $(
      `[data-testid="conversation-section"] [data-testid="task-item-${CURRENT_IMPORTED_TASK_ID}"]`,
    );
    await unpinned.waitForExist();
    // 取消置顶会把行移到任务区，需跟随新行 hover 才展示桌面归档操作。
    await unpinned.moveTo();
    await unpinned.$('button[data-testid^="task-archive-"]').click();
    await $(`[data-archive-confirming-task-id="${CURRENT_IMPORTED_TASK_ID}"]`).waitForExist();
    await unpinned.$('button[data-testid^="task-archive-"]').click();
    await unpinned.waitForExist({ reverse: true });
    const db = new DatabaseSync(
      join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
      { readOnly: true },
    );
    try {
      for (const id of LEGACY_PINNED_TASK_IDS)
        expect(
          db
            .prepare(
              "SELECT provider,pinned,archived,created_at,cli_created_at FROM tasks WHERE task_id=?",
            )
            .get(id),
        ).toEqual({
          provider: "claude",
          pinned: 1,
          archived: 0,
          created_at: 10,
          cli_created_at: 10,
        });
      expect(
        db
          .prepare("SELECT provider,migration_source,pinned,archived FROM tasks WHERE task_id=?")
          .get(CURRENT_IMPORTED_TASK_ID),
      ).toEqual({ provider: "glm", migration_source: "claudeCode", pinned: 0, archived: 1 });
    } finally {
      db.close();
    }
  });
});

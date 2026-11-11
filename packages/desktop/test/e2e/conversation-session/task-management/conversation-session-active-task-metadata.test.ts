import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { TID_TASK_SETTINGS_BUTTON, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

const home = process.env.ZCODE_E2E_HOME_DIR!;
const DAY = 86_400_000;
// 2026-09-15 裁决：自动归档纯按最后活动时间，置顶与运行中除外；未读、error 不再保护旧任务。
const fixtures = [
  { id: "sess_e2e_amt_cold", title: "E2E_AMT_COLD_TITLE", age: 100_000, unread: false, pinned: 0 },
  { id: "sess_e2e_amt_old_read", title: "E2E_AMT_1111", age: 28 * DAY, unread: false, pinned: 0 },
  { id: "sess_e2e_amt_old_unread", title: "E2E_AMT_1111", age: 28 * DAY, unread: true, pinned: 0 },
  {
    id: "sess_e2e_amt_old_pinned",
    title: "E2E_AMT_PINNED",
    age: 28 * DAY,
    unread: true,
    pinned: 1,
  },
  { id: "sess_e2e_amt_recent", title: "E2E_AMT_RECENT", age: 6 * DAY, unread: true, pinned: 0 },
] as const;
const cold = fixtures[0].id;
const oldRead = fixtures[1].id;
const oldUnread = fixtures[2].id;
const oldPinned = fixtures[3].id;
const recent = fixtures[4].id;
const item = (id: string) => $(`[data-testid="task-item-${id}"]`);
const header = () => $('[data-testid="workspace-header"]');
function facts(id: string) {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT archived,pinned,unread_at,cli_title FROM tasks WHERE task_id=?")
      .get(id) as {
      archived: number;
      pinned: number;
      unread_at: number | null;
      cli_title: string;
    };
  } finally {
    db.close();
  }
}
const activeTask = () =>
  browser.execute((cwd) => {
    const store = (
      window as typeof window & {
        __zcodeSessionStoreE2E: {
          getState(): { getWorkspaceState(path: string): { activeTaskId: string | null } };
        };
      }
    ).__zcodeSessionStoreE2E;
    return store.getState().getWorkspaceState(cwd).activeTaskId;
  }, DEFAULT_WORKSPACE);
const revealProject = async (id: string) => {
  if (!(await item(id).isDisplayed()))
    await $('[data-project-name="ZCodeProject"] [data-testid="virtual-project-row"]').click();
  await item(id).waitForDisplayed();
};

describe("当前任务元数据与自动归档", () => {
  before(async () => {
    // 原因：批量 runner 使用 runId 隔离 HOME，不能只接受早期手工回放的目录名。
    if (!home || !/^(?:zcode-active-task-e2e-|\.e2e-home-)/u.test(basename(home)))
      throw new Error("isolated active-task HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
    const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
    try {
      const projectId = db
        .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
        .get(DEFAULT_WORKSPACE)?.project_id;
      if (!projectId) throw new Error("default virtual project missing");
      for (const [index, fixture] of fixtures.entries()) {
        const { id, title } = fixture;
        const now = Date.now() - fixture.age;
        cli
          .prepare(
            "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
          )
          .run(id, "e2e-amt", id, DEFAULT_WORKSPACE, title, now, now);
        const message = `${id}_message`;
        cli
          .prepare(
            "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,0)",
          )
          .run(
            message,
            id,
            now,
            now,
            JSON.stringify({ role: "user", time: { created: now }, agent: "build" }),
          );
        cli
          .prepare(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?,0)",
          )
          .run(
            `${id}_part`,
            message,
            id,
            now,
            now,
            JSON.stringify({ type: "text", text: `E2E_AMT_BODY_${index}` }),
          );
        db.prepare(
          "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,mode,created_at,updated_at,host_id,root_path,project_id,unread_at,pinned,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted) VALUES(?,?,?,?,'glm','default',?,?,'local',?,?,?,?,?,'custom',?,?,'completed',0)",
        ).run(
          DEFAULT_WORKSPACE,
          DEFAULT_WORKSPACE,
          id,
          title,
          now,
          now,
          DEFAULT_WORKSPACE,
          projectId,
          fixture.unread ? now : null,
          fixture.pinned,
          title,
          now,
          now,
        );
      }
    } finally {
      db.close();
      cli.close();
    }
    // 直写 SQLite 不发布 task delta；重启持有 source snapshot 的 Host，才能读取新夹具。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await browser.execute(() =>
      (
        window as typeof window & { __testActions: { setLocale(value: string): void } }
      ).__testActions.setLocale("zh-CN"),
    );
    await revealProject(cold);
  });
  it("AMT01：冷历史恢复正文和真实标题，不向 CLI 发标题 readSession", async () => {
    await item(cold).click();
    await browser.waitUntil(async () => (await header().getText()).includes("E2E_AMT_COLD_TITLE"), {
      timeout: 15_000,
    });
    await $('//*[normalize-space(.)="E2E_AMT_BODY_0" and not(*)]').waitForDisplayed({
      timeout: 30_000,
    });
    expect(await activeTask()).toBe(cold);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "AMT01-cold-title.png"));
  });
  it("AMT02/AMT05：升级关闭旧开关，用户重新开启后归档超期任务，重启保留选择", async () => {
    // 旧 Host 退出后再写升级输入，避免退出时的设置持久化覆盖 fixture。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const file = join(home, ".zcode/v2/setting.json");
        const settings = JSON.parse(await readFile(file, "utf8"));
        delete settings.taskAutoArchiveResetVersion;
        await writeFile(
          file,
          JSON.stringify({
            ...settings,
            taskAutoArchiveEnabled: true,
            taskAutoArchiveOlderThanDays: 7,
          }),
        );
      },
    });
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    const toggle = $('[data-testid="archive-auto-archive-switch"]');
    await toggle.waitForDisplayed();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"))).toMatchObject({
      taskAutoArchiveEnabled: false,
      taskAutoArchiveOlderThanDays: 7,
      taskAutoArchiveResetVersion: 1,
    });
    expect(facts(oldRead).archived).toBe(0);
    expect(facts(oldUnread).archived).toBe(0);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "AMT05-upgrade-disabled.png"),
    );
    await toggle.click();
    await browser.waitUntil(
      async () =>
        JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"))
          .taskAutoArchiveEnabled === true,
    );
    // 设置变更触发 Host 补扫：28 天前的已读与未读任务都归档，置顶与保留期内的不动。
    await browser.waitUntil(
      () => facts(oldRead).archived === 1 && facts(oldUnread).archived === 1,
      { timeout: 15_000 },
    );
    expect(facts(oldUnread).unread_at).not.toBeNull();
    expect(facts(oldPinned)).toMatchObject({ archived: 0, pinned: 1 });
    expect(facts(recent).archived).toBe(0);
    expect(facts(cold).archived).toBe(0);
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await item(oldRead).waitForExist({ reverse: true, timeout: 15_000 });
    await item(oldUnread).waitForExist({ reverse: true, timeout: 15_000 });
    await revealProject(recent);
    await item(recent).click();
    await browser.waitUntil(async () => (await header().getText()).includes("E2E_AMT_RECENT"), {
      timeout: 15_000,
    });
    await browser.waitUntil(() => facts(recent).unread_at === null, { timeout: 10_000 });
    // 负向断言窗口：旧链路会在清未读后 1 秒内归档并退出详情，这里确认点击不再触发归档。
    await browser.pause(3_000);
    expect(facts(recent).archived).toBe(0);
    expect(await activeTask()).toBe(recent);
    expect(await item(recent).isDisplayed()).toBe(true);
    expect(await header().getText()).toContain("E2E_AMT_RECENT");
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "AMT02-auto-archive.png"),
    );
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "AMT-facts.json"),
      JSON.stringify(
        {
          oldRead: facts(oldRead),
          oldUnread: facts(oldUnread),
          oldPinned: facts(oldPinned),
          recent: facts(recent),
          activeTask: await activeTask(),
        },
        null,
        2,
      ),
    );
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    expect(
      await $('[data-testid="archive-auto-archive-switch"]').getAttribute("aria-checked"),
    ).toBe("true");
    expect(JSON.parse(await readFile(join(home, ".zcode/v2/setting.json"), "utf8"))).toMatchObject({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveResetVersion: 1,
    });
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "AMT05-reenabled-restart.png"),
    );
  });
});

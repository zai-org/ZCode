import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";

const itemSelector = '[role="dialog"] [cmdk-item]';
const inputSelector = '[role="dialog"] [cmdk-input]';
const duplicateTitle = "E2E_COMMAND_CENTER_DUPLICATE";

describe("Command Center 重名任务选中", () => {
  afterEach(async () => {
    const state = await browser.execute(() => ({
      dialog: document.querySelector('[role="dialog"]')?.textContent,
      tasks: Array.from(document.querySelectorAll("[data-task-item-key]")).map(
        (row) => row.textContent,
      ),
      tabs: (
        window as typeof window & { __zcodeTabStoreE2E?: { getState(): unknown } }
      ).__zcodeTabStoreE2E?.getState(),
    }));
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "command-center-state.json"),
      JSON.stringify(state, null, 2),
    );
  });

  before(async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const home = process.env.ZCODE_E2E_HOME_DIR;
    // 同时接受统一 runner 与旧手工入口的隔离 HOME，禁止写入日常用户目录。
    if (
      !home ||
      ![".e2e-home-", "zcode-command-center-"].some((prefix) => basename(home).startsWith(prefix))
    ) {
      throw new Error("需要隔离 E2E HOME");
    }
    // 纯列表 fixture：在隔离索引准备重名任务，不恢复合成会话或发送模型请求。
    // node:sqlite 仅提供同步接口，短事务结束后立即关闭连接。
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
    try {
      const now = Date.now();
      const insert = db.prepare(`
        INSERT INTO tasks (
          workspace_key, workspace_path, task_id, title, created_at, updated_at, provider,
          host_id, root_path, cli_title, cli_title_source, cli_created_at,
          cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'glm', 'local', ?, ?, 'custom', ?, ?, 'completed', 0, 8, ?)
      `);
      db.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 4; index++) {
        const title = index === 2 ? "E2E_COMMAND_CENTER_OTHER" : duplicateTitle;
        const timestamp = now - index * 1000;
        const taskId = `e2e-command-center-${index}`;
        insert.run(
          DEFAULT_WORKSPACE,
          DEFAULT_WORKSPACE,
          taskId,
          title,
          timestamp,
          timestamp,
          DEFAULT_WORKSPACE,
          title,
          timestamp,
          timestamp,
          JSON.stringify({
            taskId,
            traceId: `trace-${taskId}`,
            title,
            workspacePath: DEFAULT_WORKSPACE,
            createdAt: timestamp,
            updatedAt: timestamp,
            mode: "build",
            provider: "glm",
            status: "completed",
          }),
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    // 直写 SQLite 不发布 task delta；重启持有 source snapshot 的 Host，才能读取新夹具。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
  });

  it("CC-SELECT-01：三个重名最近任务仅高亮鼠标/键盘指向的一行", async () => {
    // 最近任务按当前项目过滤；首次启动的全局草稿不属于索引 fixture 的项目。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const evidence = [];
    for (const theme of ["zai-light", "zai-dark"]) {
      await browser.execute((value) => {
        const actions = (
          window as typeof window & {
            __testActions?: { setTheme(theme: string): void };
          }
        ).__testActions;
        if (!actions) throw new Error("缺少主题测试入口");
        actions.setTheme(value);
      }, theme);
      await $('[data-testid="sidebar-search-open"]').click();
      await $(inputSelector).waitForDisplayed();
      await $('[role="dialog"]')
        .$('.//button[@role="tab" and (normalize-space(.)="任务" or normalize-space(.)="Tasks")]')
        .click();
      await browser.waitUntil(async () => (await $$(itemSelector).length) === 4, {
        timeout: 5000,
        timeoutMsg: "最近任务应显示四条隔离索引 fixture",
      });
      const rows = await $$(itemSelector);
      expect(await rows[0]!.getText()).toContain(duplicateTitle);
      expect(await rows[1]!.getText()).toContain(duplicateTitle);
      expect(await rows[3]!.getText()).toContain(duplicateTitle);
      for (const width of ["", "360px"]) {
        // 窄容器验证共享面板；不宣称覆盖手机 shared-host 连接。
        await browser.execute((value) => {
          (document.querySelector('[role="dialog"]') as HTMLElement).style.maxWidth = value;
        }, width);
        for (const index of [0, 1, 3, 2]) {
          await rows[index]!.moveTo();
          await expectOnlySelected(index);
        }
        await $(inputSelector).click();
        await browser.keys("Home");
        await expectOnlySelected(0);
        await browser.keys("ArrowDown");
        await expectOnlySelected(1);
        await browser.keys("ArrowUp");
        await expectOnlySelected(0);
        evidence.push({ theme, width: width || "default", selected: await readSelected() });
      }
      await browser.keys("Escape");
    }
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "command-center-selection.json"),
      JSON.stringify(evidence, null, 2),
    );
  });
});

async function readSelected() {
  return browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll(selector))
        .map((row, index) => ({ index, selected: row.getAttribute("aria-selected") }))
        .filter((row) => row.selected === "true")
        .map((row) => row.index),
    itemSelector,
  );
}

async function expectOnlySelected(index: number) {
  await browser.waitUntil(
    async () => JSON.stringify(await readSelected()) === JSON.stringify([index]),
    {
      timeout: 3000,
      timeoutMsg: `仅第 ${index} 行应处于选中态`,
    },
  );
}

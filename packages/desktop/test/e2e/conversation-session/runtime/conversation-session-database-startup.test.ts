import { mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "expect-webdriverio";
import {
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  clearAppData,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { reloadE2EElectronServiceBridge } from "#e2e/helpers/e2e-electron-service-lifecycle";

// GLOBALDB-02/08/11：真实 DB 写锁作为屏障，不用伪造 renderer migrationReady。
describe("global database migration startup gate", () => {
  after(async () => {
    await clearAppData();
  });

  it("旧库被另一连接占用时持续显示等待；窗口 reload 不放行；COMMIT 后迁移并进入", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await quitElectronAppGracefully();
    const dbPath = join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare(
        "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        "E2E_DBSTART",
        "project",
        "migration",
        getE2EAppDataPaths().workspace,
        "迁移保留正文",
        "old",
        1,
        2,
      );
      db.prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?)",
      ).run(
        "E2E_DBSTART_USER",
        "E2E_DBSTART",
        1,
        2,
        JSON.stringify({
          role: "user",
          model: { providerID: "custom", modelID: "fixture", variant: "high" },
        }),
        1,
      );
      // 只回退本用例要验证的三条迁移。0025_session_permanent_deletion 用裸
      // create table/create trigger（无 apply 守卫、无 IF NOT EXISTS），在已迁移的库上
      // 重放会报 "table session_purge already exists"，让启动门永久停在 sql_failed。
      // 产品契约（shared/src/sqlite-migrations/contract.ts）不要求迁移可重放，
      // 所以这里按确切的迁移 id 删除，而不是删掉全部 >= '0020'。
      db.exec(`DELETE FROM schema_migration WHERE id IN (
        '0020_provider_model_selection',
        '0021_official_glm_selection',
        '0022_backfilled_session_reasoning'
      ); BEGIN IMMEDIATE`);
      await browser.reloadSession();
      await reloadE2EElectronServiceBridge(browser);
      const loading = await $('[data-testid="database-startup-status"]');
      await loading.waitForDisplayed({ timeout: 60_000 });
      await expect(loading).toHaveAttribute("data-database-phase", "waiting_for_lock");
      await expect($('[contenteditable="true"]')).not.toBeDisplayed();
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "database-waiting.png"),
      );
      await browser.refresh();
      await $('[data-testid="database-startup-status"]').waitForDisplayed({ timeout: 30_000 });
      await expect($('[data-testid="database-startup-status"]')).toHaveAttribute(
        "data-database-phase",
        "waiting_for_lock",
      );
      if (
        db.prepare("SELECT 1 FROM schema_migration WHERE id='0020_provider_model_selection'").get()
      )
        throw new Error("迁移在持锁期间错误完成");
      db.exec("COMMIT");
      await $('[data-testid="database-startup-status"]').waitForDisplayed({
        reverse: true,
        timeout: 60_000,
      });
      await browser.waitUntil(
        async () =>
          Boolean(
            db
              .prepare(
                "SELECT 1 FROM schema_migration WHERE id='0022_backfilled_session_reasoning'",
              )
              .get(),
          ),
        { timeout: 30_000 },
      );
      const row = db.prepare("SELECT data FROM message WHERE id='E2E_DBSTART_USER'").get();
      const data = JSON.parse(String(row?.data));
      if (data.model?.providerID !== "custom" || data.modelSelection?.modelId !== "fixture")
        throw new Error("迁移未保留旧字段或生成新选择");
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it("SILENTDB-01/GLOBALDB-01/08：已迁移重启全程无正文，等锁仍不挂载业务 Root", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await quitElectronAppGracefully();
    const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"));
    const before = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    try {
      db.exec("BEGIN IMMEDIATE");
      await browser.reloadSession();
      await reloadE2EElectronServiceBridge(browser);
      const logo = await $('[data-testid="root-startup-loading"]');
      await logo.waitForDisplayed({ timeout: 60_000 });
      await expect($('[data-testid="database-startup-silent"]')).toHaveAttribute(
        "data-database-phase",
        "waiting_for_lock",
      );
      await expect($('[data-testid="database-startup-status"]')).not.toExist();
      await expect(logo).toHaveText("");
      await expect($('[contenteditable="true"]')).not.toBeDisplayed();
      await browser.refresh();
      await expect($('[data-testid="database-startup-silent"]')).toHaveAttribute(
        "data-database-phase",
        "waiting_for_lock",
      );
      await expect($('[data-testid="database-startup-status"]')).not.toExist();
      // 在释放锁前观察后续所有 DOM 变更，不能只在最终主界面断言文字消失。
      await browser.execute(() => {
        const runtime = window as Window & {
          __startupTextSeen?: boolean;
          __startupObserver?: MutationObserver;
        };
        runtime.__startupTextSeen = false;
        const check = (node: Node) => {
          if (!(node instanceof Element)) return;
          if (
            node.matches('[data-testid="database-startup-status"]') ||
            node.querySelector('[data-testid="database-startup-status"]')
          )
            runtime.__startupTextSeen = true;
        };
        runtime.__startupObserver = new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) check(node);
        });
        runtime.__startupObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      });
      db.exec("COMMIT");
      await $('[contenteditable="true"]').waitForDisplayed({ timeout: 60_000 });
      const textSeen = await browser.execute(() => {
        const runtime = window as Window & {
          __startupTextSeen?: boolean;
          __startupObserver?: MutationObserver;
        };
        runtime.__startupObserver?.disconnect();
        return runtime.__startupTextSeen;
      });
      if (textSeen) throw new Error("无待执行迁移时曾展示启动正文");
      if (
        JSON.stringify(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()) !==
        JSON.stringify(before)
      )
        throw new Error("重启改变了已完成迁移账本");
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it("GLOBALDB-11/12：真实打开失败显示诊断；修复后由用户点击重试", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await quitElectronAppGracefully();
    const path = join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite");
    const backup = `${path}.e2e-before`;
    await rename(path, backup);
    let moved = true;
    try {
      await mkdir(path);
      await browser.reloadSession();
      await reloadE2EElectronServiceBridge(browser);
      const loading = await $('[data-testid="database-startup-status"]');
      await loading.waitForDisplayed({ timeout: 60_000 });
      await expect(loading).toHaveAttribute("data-phase", "failed");
      await expect($('[contenteditable="true"]')).not.toBeDisplayed();
      await expect($('[data-testid="database-startup-retry"]')).toBeDisplayed();
      await expect($('[data-testid="database-startup-export-logs"]')).toBeDisplayed();
      await rm(path, { recursive: true });
      await rename(backup, path);
      moved = false;
      await expect(loading).toHaveAttribute("data-phase", "failed");
      await $('[data-testid="database-startup-retry"]').click();
      await loading.waitForDisplayed({ reverse: true, timeout: 60_000 });
    } finally {
      if (moved) {
        await rm(path, { recursive: true, force: true });
        await rename(backup, path);
      }
    }
  });
  it("GLOBALDB-27：已 ready 的 Host 退出后，刷新必须等待新 Host 完成准备", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"));
    try {
      db.exec("BEGIN IMMEDIATE");
      const pid = await browser.electron.execute((electron) => {
        const hosts = electron.app
          .getAppMetrics()
          .filter((metric) => metric.name?.startsWith("zcode-host"));
        if (hosts.length !== 1) throw new Error("此隔离用例必须只有一个窗口 Host");
        const pid = hosts[0]!.pid;
        process.kill(pid, "SIGKILL");
        return pid;
      });
      await browser.waitUntil(
        async () =>
          browser.electron.execute(
            (electron, previousPid) =>
              !electron.app.getAppMetrics().some((metric) => metric.pid === previousPid),
            pid,
          ),
        { timeout: 30_000 },
      );
      await browser.refresh();
      const loading = await $('[data-testid="root-startup-loading"]');
      await loading.waitForDisplayed({ timeout: 60_000 });
      await expect($('[data-testid="database-startup-silent"]')).toHaveAttribute(
        "data-database-phase",
        "waiting_for_lock",
      );
      await expect($('[data-testid="database-startup-status"]')).not.toExist();
      await expect($('[contenteditable="true"]')).not.toBeDisplayed();
      db.exec("COMMIT");
      await loading.waitForDisplayed({ reverse: true, timeout: 60_000 });
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it("GLOBALDB-28：历史项目父目录变成文件，不阻断默认数据库准备", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await quitElectronAppGracefully();
    const paths = getE2EAppDataPaths();
    const caseRoot = join(paths.workspace, ".zcode-e2e", "database-startup-invalid-project");
    const parent = join(caseRoot, "former-parent");
    const project = join(parent, "old-project");
    const settingsPath = join(paths.appDataDir, "setting.json");
    const original = await readFile(settingsPath, "utf8");
    await mkdir(project, { recursive: true });
    const settings = JSON.parse(original);
    settings.recentProjects = [project];
    await writeFile(settingsPath, JSON.stringify(settings));
    await rename(parent, parent + ".backup");
    await writeFile(parent, "the previous directory was replaced");
    try {
      await browser.reloadSession();
      await reloadE2EElectronServiceBridge(browser);
      await $('[data-testid="database-startup-status"]').waitForDisplayed({
        reverse: true,
        timeout: 60_000,
      });
      await $('[contenteditable="true"]').waitForDisplayed({ timeout: 60_000 });
    } finally {
      await quitElectronAppGracefully();
      await writeFile(settingsPath, original);
      await rm(caseRoot, { recursive: true, force: true });
    }
  });
});

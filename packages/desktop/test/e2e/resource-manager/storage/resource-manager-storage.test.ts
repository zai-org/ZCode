/**
 * 资源管理器「存储」tab E2E。
 * 用例目录：docs/settings-storage-management.md §7（SM-01 扫描、SM-02 下钻、SM-03 safe 清理、
 * SM-04 confirm 清理、SM-05 日志保留当天）。fixture 直接写进隔离 HOME 的 .zcode，
 * 类别选用 backup/ 与 cli/debug：启动迁移备份先隔离清理，再按夹具精确断言字节。
 */
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN,
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW,
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE,
  TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT,
  TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL,
  TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY,
  TID_RESOURCE_MANAGER_STORAGE_DISK_CARD,
  TID_RESOURCE_MANAGER_STORAGE_ROOT,
  TID_RESOURCE_MANAGER_STORAGE_SECTION,
  TID_RESOURCE_MANAGER_STORAGE_STATUS,
  TID_RESOURCE_MANAGER_STORAGE_TOTAL,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  activateResourceManagerTab,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";
import { sel } from "#e2e/helpers/selectors";

function todayLogFileName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
}

const { storageRoot } = getE2EAppDataPaths();
const TRAJECTORY_FILE = join(storageRoot, "cli", "debug", "model-io-sess_e2e.jsonl");
const TRAJECTORY_BYTES = 4096;
const BACKUP_DIR = join(storageRoot, "backup", "session-projects-e2e");
const BACKUP_FILE = join(BACKUP_DIR, "v2", "tasks-index.sqlite");
const BACKUP_BYTES = 6144;
const OLD_LOG_FILE = join(storageRoot, "v2", "logs", "2020-01-01.log");
// E2E 里主进程日志不一定落在 <storageRoot>/v2/logs，不能拿它当"当天日志"；fixture 自己写一份当天文件。
const TODAY_LOG_FILE = join(storageRoot, "v2", "logs", todayLogFileName());

async function seedStorageFixture(): Promise<void> {
  // 启动迁移会生成 tasks_index 备份；先清理隔离 HOME 的既有备份，再建立精确字节夹具。
  await rm(join(storageRoot, "backup"), { recursive: true, force: true });
  await mkdir(join(TRAJECTORY_FILE, ".."), { recursive: true });
  await writeFile(TRAJECTORY_FILE, "x".repeat(TRAJECTORY_BYTES));
  await mkdir(join(BACKUP_FILE, ".."), { recursive: true });
  await writeFile(BACKUP_FILE, "y".repeat(BACKUP_BYTES));
  await mkdir(join(OLD_LOG_FILE, ".."), { recursive: true });
  await writeFile(OLD_LOG_FILE, "old-log");
  const old = new Date(2020, 0, 1, 12, 0, 0);
  await utimes(OLD_LOG_FILE, old, old);
  await writeFile(TODAY_LOG_FILE, "today-log");
}

async function openStorageTab(): Promise<void> {
  await openResourceManager();
  await switchToElectronRendererTarget(isResourceManagerUrl);
  await waitForResourceManagerReady();
  await activateResourceManagerTab("storage");
  await waitForTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_SECTION, { timeout: 15000 });
}

async function waitForScanComplete(): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_RESOURCE_MANAGER_STORAGE_STATUS)).getAttribute("data-state")) === "complete",
    { timeout: 60000, timeoutMsg: "存储扫描没有在 60s 内完成" },
  );
}

async function categorySizeText(categoryId: string): Promise<string> {
  return $(sel(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE, categoryId))).getText();
}

async function closeResourceManagerWindow(): Promise<void> {
  await browser.electron.execute((electron) => {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().includes("resource-manager.html")) win.close();
    }
  });
  await switchToElectronRendererTarget(isMainRendererUrl);
}

describe("资源管理器 存储 tab E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async function () {
    this.timeout(90_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await seedStorageFixture();
  });

  afterEach(async () => {
    await closeResourceManagerWindow();
    await rm(join(storageRoot, "backup"), { recursive: true, force: true });
    await rm(TRAJECTORY_FILE, { force: true });
    await rm(OLD_LOG_FILE, { force: true });
    await rm(TODAY_LOG_FILE, { force: true });
  });

  it("SM-01: 切到存储 tab 后自动扫描，磁盘卡片、根目录与类别大小随扫描完成填充", async function () {
    this.timeout(120_000);
    await openStorageTab();
    await waitForScanComplete();

    expect(await $(sel(testId(TID_RESOURCE_MANAGER_STORAGE_DISK_CARD, "0"))).isDisplayed()).toBe(
      true,
    );
    expect(await $(sel(testId(TID_RESOURCE_MANAGER_STORAGE_ROOT, "home"))).getText()).toContain(
      storageRoot,
    );
    expect(await $(sel(TID_RESOURCE_MANAGER_STORAGE_TOTAL)).getText()).not.toBe("0 B");
    expect(await categorySizeText("modelTrajectory")).toBe("4.0 KB");
    expect(await categorySizeText("backups")).toBe("6.0 KB");
    expect(
      await $(
        sel(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "sessionStore")),
      ).isExisting(),
    ).toBe(false);
    expect(
      await $(
        sel(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "modelTrajectory")),
      ).isExisting(),
    ).toBe(true);
  });

  it("SM-02: 点击类别进入明细，列出根目录下的条目并可返回", async function () {
    this.timeout(120_000);
    await openStorageTab();
    await waitForScanComplete();
    await clickTestIdByDom(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW, "backups"));
    await waitForTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_DETAIL);
    const entries = await $$(sel(TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY));
    expect(entries.length).toBe(1);
    expect(await entries[0]!.getText()).toContain("backup/session-projects-e2e");
    await clickTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK);
    await waitForTestIdByDom(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW, "backups"));
    expect(await $(sel(TID_RESOURCE_MANAGER_STORAGE_DETAIL)).isExisting()).toBe(false);
  });

  it("SM-03: safe 类别直接清理，文件被删除并重新扫描归零", async function () {
    this.timeout(120_000);
    await openStorageTab();
    await waitForScanComplete();
    await clickTestIdByDom(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "modelTrajectory"));
    expect(await $(sel(TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG)).isExisting()).toBe(false);
    await browser.waitUntil(async () => !existsSync(TRAJECTORY_FILE), {
      timeout: 15000,
      timeoutMsg: "模型调用轨迹文件没有被删除",
    });
    await waitForScanComplete();
    expect(await categorySizeText("modelTrajectory")).toBe("0 B");
  });

  it("SM-04: confirm 类别先弹确认框，取消不删，确认后删除", async function () {
    this.timeout(120_000);
    await openStorageTab();
    await waitForScanComplete();
    await clickTestIdByDom(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "backups"));
    await waitForTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG);
    await clickTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL);
    await browser.waitUntil(
      async () => !(await $(sel(TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG)).isExisting()),
      { timeout: 5000 },
    );
    expect(existsSync(BACKUP_FILE)).toBe(true);

    await clickTestIdByDom(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "backups"));
    await waitForTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG);
    await clickTestIdByDom(TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT);
    await browser.waitUntil(async () => !existsSync(BACKUP_FILE), {
      timeout: 15000,
      timeoutMsg: "备份文件没有被删除",
    });
    expect(existsSync(BACKUP_DIR)).toBe(false);
    expect(existsSync(join(storageRoot, "backup"))).toBe(true);
    await waitForScanComplete();
    expect(await categorySizeText("backups")).toBe("0 B");
  });

  it("SM-05: 清理日志只删旧文件，当天日志保留", async function () {
    this.timeout(120_000);
    await openStorageTab();
    await waitForScanComplete();
    await clickTestIdByDom(testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "logs"));
    await browser.waitUntil(async () => !existsSync(OLD_LOG_FILE), {
      timeout: 15000,
      timeoutMsg: "旧日志没有被删除",
    });
    await waitForScanComplete();
    expect((await stat(TODAY_LOG_FILE)).isFile()).toBe(true);
  });
});

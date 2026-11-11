import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { join, basename } from "node:path";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { waitForWorkspaceApp, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";

/**
 * 设置 › 项目管理（docs/superpowers/specs/2026-10-24-project-management.md）。
 * 夹具在 Host 停止时直接写 tasks-index 与 CLI 库：一个活跃项目、四个疑似不再使用的候选
 * （文件夹不存在 / 没有会话 / 两个超过 90 天）、一个置顶的久未使用项目和一个已软删除且目录不存在的项目；
 * 另有一个独占目录、带会话文件的活跃项目，供 PJM07 彻底删除数据。
 */
const home = process.env.ZCODE_E2E_HOME_DIR!;
const DAY = 86_400_000;
const PROJECTS = [
  { id: "pjm-active", name: "PJM 活跃", lastActive: 1 },
  { id: "pjm-missing", name: "PJM 缺失目录", lastActive: 10, missing: true },
  { id: "pjm-empty", name: "PJM 空项目" },
  { id: "pjm-idle", name: "PJM 久未使用", lastActive: 120 },
  { id: "pjm-keep", name: "PJM 保留", lastActive: 150 },
  { id: "pjm-pinned", name: "PJM 置顶", lastActive: 400, pinned: true },
  { id: "pjm-removed", name: "PJM 已移除", lastActive: 200, missing: true, deleted: true },
  { id: "pjm-purge", name: "PJM 删除数据", lastActive: 2, own: true },
] as const;
const PURGE_SESSION = "pjm-purge-task";
const purgeArtifacts = () => join(home, ".zcode/cli/artifacts", PURGE_SESSION);
const CANDIDATES = ["pjm-missing", "pjm-idle", "pjm-keep", "pjm-empty"];
const editRoot = () => join(DEFAULT_WORKSPACE, ".zcode-e2e/project-management/extra");

const row = (id: string) => $(`[data-testid="project-management-row"][data-project-id="${id}"]`);
function readProjects() {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(
      (
        db
          .prepare("SELECT project_id,deleted FROM projects WHERE project_id LIKE 'pjm-%'")
          .all() as { project_id: string; deleted: number }[]
      ).map((p) => [p.project_id, p.deleted]),
    );
  } finally {
    db.close();
  }
}
function readTaskProject(id: string) {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    return (
      db.prepare("SELECT project_id FROM tasks WHERE task_id=?").get(id) as {
        project_id: string | null;
      }
    )?.project_id;
  } finally {
    db.close();
  }
}
async function setLocaleAndTheme(locale: string, theme: string) {
  await browser.execute(
    ({ locale, theme }) => {
      const actions = (
        window as typeof window & {
          __testActions: { setTheme(value: string): void; setLocale(value: string): void };
        }
      ).__testActions;
      actions.setTheme(theme);
      actions.setLocale(locale);
    },
    { locale, theme },
  );
  await browser.waitUntil(() =>
    browser.execute(
      (theme) => document.documentElement.classList.contains(`theme-${theme}`),
      theme,
    ),
  );
}

async function openProjectEditor(id: string) {
  const target = row(id);
  await target.scrollIntoView();
  await target.moveTo();
  await target.$('[data-testid="project-management-row-menu"]').click();
  await $('[data-testid="project-management-row-edit"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}

describe("项目管理", () => {
  let pairingUrl: string;
  before(async function () {
    this.timeout(60000);
    // 修复原因：转正后默认 formal 单跑使用 `.e2e-home`（无 runId 后缀），旧守卫只认
    // `.e2e-home-`，会让正式用例在隔离 HOME 下误报。两种目录名都只存在于 E2E runner。
    if (!home || !/^(?:zcode-project-management-e2e-|\.e2e-home(?:-|$))/u.test(basename(home)))
      throw new Error("isolated project management HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
        const now = Date.now();
        try {
          for (const [i, project] of PROJECTS.entries()) {
            const pinned = "pinned" in project;
            db.prepare(
              "INSERT INTO projects(project_id,host_id,name,name_overridden,position,pinned,pinned_at,deleted,deleted_at,created_at,updated_at) VALUES(?,'local',?,1,?,?,?,?,?,?,?)",
            ).run(
              project.id,
              project.name,
              i,
              pinned ? 1 : 0,
              pinned ? now : null,
              "deleted" in project ? 1 : 0,
              "deleted" in project ? now - DAY : null,
              now - 30 * DAY,
              now - ("deleted" in project ? DAY : 30 * DAY),
            );
            // 缺失目录用不存在的路径；独占目录的项目用自己的文件夹；其余共用默认工作区（同一目录可属多个项目）。
            const root =
              "missing" in project
                ? join(home, `${project.id}-gone`)
                : "own" in project
                  ? join(home, `${project.id}-root`)
                  : DEFAULT_WORKSPACE;
            if ("own" in project) await mkdir(root, { recursive: true });
            db.prepare(
              "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
            ).run(project.id, root);
            if (!("lastActive" in project)) continue;
            const id = `${project.id}-task`;
            const updated = now - project.lastActive * DAY;
            const title = `${project.name} 会话`;
            cli
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
              )
              .run(id, "pjm-cli-scope", id, root, title, updated, updated);
            db.prepare(
              "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,0,?,'custom',?,?,'completed',0,?)",
            ).run(
              root,
              root,
              id,
              title,
              updated,
              updated,
              root,
              project.id,
              title,
              updated,
              updated,
              JSON.stringify({
                taskId: id,
                traceId: id,
                title,
                workspacePath: root,
                createdAt: updated,
                updatedAt: updated,
                mode: "default",
              }),
            );
          }
          await mkdir(editRoot(), { recursive: true });
          db.prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES('pjm-active',?,1,0)",
          ).run(editRoot());
          // 会话文件：彻底删除后必须从磁盘消失。
          await mkdir(purgeArtifacts(), { recursive: true });
          await writeFile(join(purgeArtifacts(), "output.txt"), "x".repeat(4096));
        } finally {
          db.close();
          cli.close();
        }
      },
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    await setLocaleAndTheme("zh-CN", "zai-light");
    // 在进入设置前从首页配对；设置页和首页各有 footer，不能用全局定位器猜测当前入口。
    pairingUrl = await obtainUnreadPairingUrl(
      new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
    );
  });

  it("PJM01：侧栏更多菜单与设置导航都进入项目管理页，页头说明移除后果", async () => {
    const sidebarRow = $('[data-project-name="PJM 活跃"]');
    await sidebarRow.waitForDisplayed();
    await sidebarRow.moveTo();
    await sidebarRow.$('[data-testid="virtual-project-menu"]').click();
    // 「管理项目…」是更多菜单最后一项，前面有分隔线。
    await $('[role="menu"]').waitForDisplayed();
    const lastItem = await browser.execute(() =>
      [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .at(-1)
        ?.getAttribute("data-testid"),
    );
    expect(lastItem).toBe("virtual-project-manage-projects");
    expect(await $('[role="menu"] [role="separator"]').isExisting()).toBe(true);
    await $('[data-testid="virtual-project-manage-projects"]').click();
    await $('[data-testid="project-management"]').waitForDisplayed();
    await expect($("h2=项目管理")).toBeDisplayed();
    await expect($('[data-testid="settings-section-nav-projects"]')).toHaveText("项目管理");
    const main = $('main:has([data-testid="project-management"])');
    expect(await main.getText()).toContain("会话仍保留在最近和搜索中");
    // 设置导航入口位于归档管理之前。
    const nav = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid^="settings-section-nav-"]')].map(
        (el) => el.getAttribute("data-testid")!,
      ),
    );
    expect(nav.indexOf("settings-section-nav-projects")).toBe(
      nav.indexOf("settings-section-nav-archives") - 1,
    );
    // 已移除项目不在主列表；设置导航入口同样可达。
    expect(await row("pjm-removed").isExisting()).toBe(false);
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="settings-section-nav-projects"]').click();
    await $('[data-testid="project-management"]').waitForDisplayed();
  });

  it("PJM08：行菜单复用首页编辑器，取消不落盘，保存只修改选中项目", async () => {
    await openProjectEditor("pjm-active");
    await expect($('[data-testid="virtual-project-name"]')).toHaveValue("PJM 活跃");
    await $('[data-testid="virtual-project-name"]').setValue("PJM 取消草稿");
    await browser.keys("Escape");
    await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
    await expect(row("pjm-active")).toHaveText(expect.stringContaining("PJM 活跃"));
    await openProjectEditor("pjm-active");
    await expect($('[data-testid="virtual-project-name"]')).toHaveValue("PJM 活跃");
    await $('[data-testid="virtual-project-name"]').setValue("PJM 编辑完成");
    await $('[data-testid="virtual-project-set-primary"]').click();
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
    await expect(row("pjm-active")).toHaveText(expect.stringContaining("PJM 编辑完成"));
    await expect(row("pjm-active").$("span[title]")).toHaveAttribute("title", "PJM 编辑完成");
    await expect(row("pjm-active").$(`span[title="${editRoot()}"]`)).toBeDisplayed();
    await $('[data-project-name="PJM 编辑完成"]').waitForExist();
    await expect(row("pjm-keep")).toHaveText(expect.stringContaining("PJM 保留"));
    expect(readTaskProject("pjm-active-task")).toBe("pjm-active");
    const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT root_path FROM tasks WHERE task_id='pjm-active-task'").get(),
      ).toMatchObject({
        root_path: DEFAULT_WORKSPACE,
      });
      expect(
        db.prepare("SELECT name FROM projects WHERE project_id='pjm-keep'").get(),
      ).toMatchObject({
        name: "PJM 保留",
      });
    } finally {
      db.close();
    }
    await expect($('[data-testid="project-management"]')).toBeDisplayed();
  });

  it("PJM02：复核建议预选全部候选，取消一项后只剩三项待移除", async () => {
    const suggestion = $('[data-testid="project-management-suggestion"]');
    await expect(suggestion).toHaveText(expect.stringContaining("4 个项目疑似不再使用"));
    await $('[data-testid="project-management-review"]').click();
    await expect($('[data-testid="project-management-filter"]')).toHaveText(
      expect.stringContaining("疑似不再使用"),
    );
    const ids = await $$('[data-testid="project-management-row"]').map((el) =>
      el.getAttribute("data-project-id"),
    );
    // 置顶项目与活跃项目不是候选；按最近活动排序，从未使用排最后。
    expect(ids).toEqual(CANDIDATES);
    for (const id of CANDIDATES)
      await expect(row(id).$('[data-testid="project-management-row-checkbox"]')).toHaveAttribute(
        "data-state",
        "checked",
      );
    await expect(row("pjm-missing").$('[data-testid="project-management-reason"]')).toHaveAttribute(
      "data-reason",
      "missing",
    );
    await row("pjm-keep").$('[data-testid="project-management-row-checkbox"]').click();
    await expect($('[data-testid="project-management-selection-bar"]')).toHaveText(
      expect.stringContaining("已选 3 个"),
    );
    await expect($('[data-testid="project-management-select-all"]')).toHaveAttribute(
      "data-state",
      "indeterminate",
    );
  });

  it("PJM03：确认对话框按设备拆分，确认后软删除且会话归属不变", async () => {
    await $('[data-testid="project-management-remove"]').click();
    const dialog = $('[data-testid="project-management-confirm"]');
    await dialog.waitForDisplayed();
    await expect(dialog).toHaveText(expect.stringContaining("移除 3 个项目？"));
    const devices = await dialog.$$('[data-testid="project-management-confirm-device"]');
    expect(devices).toHaveLength(1);
    await expect(devices[0]!).toHaveText(expect.stringContaining("3 个项目"));
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PJM03-confirm.png"));
    await dialog.$('[data-testid="project-management-confirm-remove"]').click();
    await dialog.waitForExist({ reverse: true });
    await browser.waitUntil(() => readProjects()["pjm-idle"] === 1);
    expect(readProjects()).toMatchObject({
      "pjm-missing": 1,
      "pjm-idle": 1,
      "pjm-empty": 1,
      "pjm-keep": 0,
      "pjm-pinned": 0,
      "pjm-active": 0,
    });
    // 软删除只拿掉容器：会话仍归属原项目，侧栏不再显示被移除的项目。
    expect(readTaskProject("pjm-idle-task")).toBe("pjm-idle");
    await $('[data-project-name="PJM 久未使用"]').waitForExist({ reverse: true });
    await expect(row("pjm-keep")).toBeDisplayed();
    expect(await $('[data-testid="project-management-selection-bar"]').isExisting()).toBe(false);
  });

  it("PJM04：toast 撤销只恢复本批项目", async () => {
    const undo = $("button=撤销");
    await undo.waitForDisplayed();
    await undo.click();
    await browser.waitUntil(() => readProjects()["pjm-idle"] === 0);
    expect(readProjects()).toMatchObject({
      "pjm-missing": 0,
      "pjm-idle": 0,
      "pjm-empty": 0,
      "pjm-removed": 1,
    });
    await $('[data-project-name="PJM 久未使用"]').waitForExist();
  });

  it("PJM05：已移除区默认收起，恢复目录缺失的项目", async () => {
    await $('[data-testid="project-management-filter"]').click();
    await $('[data-testid="project-management-filter-all"]').click();
    expect(await $$('[data-testid="project-management-removed-row"]').length).toBe(0);
    const toggle = $('[data-testid="project-management-removed-toggle"]');
    await toggle.scrollIntoView();
    await toggle.click();
    const removed = $(
      '[data-testid="project-management-removed-row"][data-project-id="pjm-removed"]',
    );
    await removed.waitForDisplayed();
    await removed.$('[data-testid="project-management-restore"]').click();
    await browser.waitUntil(() => readProjects()["pjm-removed"] === 0);
    // 目录不存在也能恢复；恢复后按目录缺失进入疑似列表。
    await row("pjm-removed").waitForDisplayed();
    await expect(row("pjm-removed").$('[data-testid="project-management-reason"]')).toHaveAttribute(
      "data-reason",
      "missing",
    );
  });

  it("PJM06：中英文、明暗主题与窄屏不横向溢出", async () => {
    try {
      for (const width of [1200, 390]) {
        await browser.electron.execute(async (electron, width) => {
          const target = electron.BrowserWindow.getAllWindows().find(
            (w) => w.isVisible() && !w.isDestroyed(),
          )!;
          if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
          await target.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
            width,
            height: 844,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }, width);
        for (const [locale, theme] of [
          ["zh-CN", "zai-light"],
          ["zh-CN", "zai-dark"],
          ["en-US", "zai-light"],
          ["en-US", "zai-dark"],
        ] as const) {
          await setLocaleAndTheme(locale, theme);
          await expect($('[data-testid="project-management-sort"]')).toHaveText(
            locale === "zh-CN" ? "最近活动" : "Last active",
          );
          await row("pjm-keep").$('[data-testid="project-management-row-checkbox"]').click();
          await $('[data-testid="project-management-selection-bar"]').waitForDisplayed();
          const fits = await browser.execute(() => {
            const page = document.querySelector<HTMLElement>('[data-testid="project-management"]')!;
            const box = page.getBoundingClientRect();
            return (
              box.left >= 0 && box.right <= innerWidth && page.scrollWidth <= page.clientWidth + 1
            );
          });
          if (!fits) {
            const layout = await browser.execute(() => {
              const page = document.querySelector<HTMLElement>(
                '[data-testid="project-management"]',
              )!;
              return {
                width: innerWidth,
                page: page.getBoundingClientRect().toJSON(),
                scrollWidth: page.scrollWidth,
                overflow: [...page.querySelectorAll<HTMLElement>("*")]
                  .filter((el) => el.scrollWidth > el.clientWidth + 1)
                  .map((el) => ({
                    testId: el.dataset.testid,
                    className: el.className,
                    width: el.clientWidth,
                    scrollWidth: el.scrollWidth,
                  })),
              };
            });
            await writeFile(
              join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PJM06-layout.json"),
              JSON.stringify(layout, null, 2),
            );
            await browser.saveScreenshot(
              join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PJM06-layout.png"),
            );
          }
          expect(fits).toBe(true);
          await browser.saveScreenshot(
            join(
              process.env.ZCODE_E2E_ARTIFACT_DIR!,
              `project-management-${width}-${locale}-${theme}.png`,
            ),
          );
          await row("pjm-keep").$('[data-testid="project-management-row-checkbox"]').click();
          await openProjectEditor("pjm-active");
          await expect($('[role="dialog"] h2')).toHaveText(
            locale === "zh-CN" ? "编辑项目" : "Edit project",
          );
          const editorFits = await browser.execute(() => {
            const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
            const box = dialog.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.right <= innerWidth &&
              dialog.scrollWidth <= dialog.clientWidth + 1
            );
          });
          expect(editorFits).toBe(true);
          await browser.saveScreenshot(
            join(
              process.env.ZCODE_E2E_ARTIFACT_DIR!,
              `project-editor-${width}-${locale}-${theme}.png`,
            ),
          );
          await browser.keys("Escape");
          await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
        }
      }
    } finally {
      await browser.electron.execute(async (electron) => {
        const target = electron.BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && !w.isDestroyed(),
        )!;
        await target.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      });
      await setLocaleAndTheme("zh-CN", "zai-light");
    }
  });

  it("PJM07：勾选同时删除数据，输入确认词后删除会话、会话文件与项目行", async () => {
    await row("pjm-purge").$('[data-testid="project-management-row-checkbox"]').click();
    await $('[data-testid="project-management-remove"]').click();
    const dialog = $('[data-testid="project-management-confirm"]');
    await dialog.waitForDisplayed();
    const option = dialog.$('[data-testid="project-management-confirm-data"]');
    // 打开即测量；结果返回前显示「正在计算…」，之后显示大小且默认不勾选。
    await option.waitForDisplayed();
    await browser.waitUntil(async () => !(await option.getText()).includes("正在计算"));
    await expect(option).toHaveAttribute("data-checked", "false");
    await option.$('button[role="checkbox"]').click();
    await expect(dialog).toHaveText(expect.stringContaining("移除 1 个项目并删除其数据？"));
    const confirm = dialog.$('[data-testid="project-management-confirm-remove"]');
    await expect(confirm).toBeDisabled();
    await dialog.$('[data-testid="project-management-confirm-data-word"]').setValue("删除");
    await expect(confirm).toBeEnabled();
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "PJM07-confirm.png"));
    await confirm.click();
    await dialog.waitForExist({ reverse: true });
    // 结果 toast 不带撤销；项目行在无引用后删除，不进入「已移除的项目」。
    // 裸 *= 被 WebDriver 解析成链接文本；结果 toast 不是链接，按实际文本节点定位。
    await $('//*[contains(text(), "已移除 1 个项目 · 释放")]').waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(() => !("pjm-purge" in readProjects()), { timeout: 30000 });
    expect(readTaskProject(PURGE_SESSION)).toBeUndefined();
    expect(existsSync(purgeArtifacts())).toBe(false);
    const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
    try {
      expect(cli.prepare("SELECT id FROM session WHERE id=?").get(PURGE_SESSION)).toBeUndefined();
    } finally {
      cli.close();
    }
    expect(
      await $(
        '[data-testid="project-management-removed-row"][data-project-id="pjm-purge"]',
      ).isExisting(),
    ).toBe(false);
  });

  it("PJM09：手机远控从项目管理编辑，共享 Host 保存后桌面同步", async function () {
    this.timeout(120_000);
    const mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    try {
      const context = await mobile.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
        caseMarker: "PJM09",
        phase: "project-edit",
        readySelector: '[data-project-name="PJM 编辑完成"]',
      });
      await page.getByTestId(TID_TASK_SETTINGS_BUTTON).tap();
      await page.getByTestId("settings-section-nav-projects").tap();
      const mobileRow = page.locator(
        '[data-testid="project-management-row"][data-project-id="pjm-active"]',
      );
      for (const theme of ["zai-light", "zai-dark"]) {
        await page.evaluate((value) => {
          (
            window as Window & { __testActions?: { setTheme(value: string): void } }
          ).__testActions!.setTheme(value);
        }, theme);
        await mobileRow.getByTestId("project-management-row-menu").tap();
        await page.getByTestId("project-management-row-edit").tap();
        const name = page.getByTestId("virtual-project-name");
        await name.waitFor();
        // 等菜单退出和弹窗淡入完成再留截图，不把透明过渡帧当成最终视觉。
        await page.getByRole("menu").waitFor({ state: "hidden" });
        await page.waitForFunction(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return (
            dialog &&
            dialog
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState === "finished")
          );
        });
        expect(await name.inputValue()).toBe(
          theme === "zai-light" ? "PJM 编辑完成" : "PJM 手机编辑",
        );
        await page.screenshot({
          path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `PJM09-mobile-${theme}.png`),
        });
        if (theme === "zai-light") {
          await name.fill("PJM 手机编辑");
          await page.getByTestId("virtual-project-save").tap();
          await page.getByTestId("virtual-project-name").waitFor({ state: "hidden" });
          await expect(row("pjm-active")).toHaveText(expect.stringContaining("PJM 手机编辑"));
          await $('[data-project-name="PJM 手机编辑"]').waitForExist();
        } else {
          await page.getByRole("button", { name: /^(取消|Cancel)$/u }).tap();
        }
      }
    } finally {
      await mobile.close();
    }
  });
});

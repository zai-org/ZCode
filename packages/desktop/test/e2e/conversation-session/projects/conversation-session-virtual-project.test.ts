// 统一 runner 与旧手工入口均使用隔离 HOME；不能因 runId 前缀不同拒绝安全夹具。
import {
  installHandoffRpcProbe,
  callHandoffHost,
  removeRemoteProjectEntryForRow,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import type { VirtualProject } from "@zcode/services";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { openScopeProjectSubmenu } from "#e2e/helpers/settings-scope-menu";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ServiceChannels } from "@zcode/shared";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_TASK_ITEM,
  TID_TASK_ARCHIVE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  TID_AUTOMATIONS_OPEN,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATIONS_LIST,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  clickTestIdByDom,
  waitForWorkspaceApp,
  DEFAULT_WORKSPACE,
} from "#e2e/helpers/desktop-app";

import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { loginWithApiKey, prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("虚拟项目", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    // 本文件保留中文文案断言，显式设置语言，避免跟随测试机系统语言产生假失败。
    await browser.execute(() => {
      const actions = (window as Window & { __testActions?: { setLocale(locale: "zh-CN"): void } })
        .__testActions;
      if (!actions) throw new Error("missing E2E locale bridge");
      actions.setLocale("zh-CN");
    });
  });
  it("VP19/20：直接创建表单、源文件夹布局、旧分区折叠与 hover 入口", async function () {
    this.timeout(60_000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    const projects = $('[data-testid="project-section"]');
    const tasks = $('[data-testid="conversation-section"]');
    await projects.waitForDisplayed();
    expect(await $('button[aria-label="时间线"]').isExisting()).toBe(false);
    expect(await $('[data-testid="virtual-project-menu"]').isExisting()).toBe(true);
    expect(await $("aside").$("button=添加连接").isExisting()).toBe(false);
    for (const section of [projects, tasks]) {
      const toggle = section.$('button[data-slot="collapsible-trigger"]');
      for (const expanded of ["false", "true"]) {
        // 上方折叠动画会移动下方分区；等浏览器动画完成再做一次原生点击，不重复补点。
        await browser.execute(async () => {
          await Promise.all(
            (document.querySelector("aside")?.getAnimations({ subtree: true }) ?? [])
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        await toggle.click();
        await browser.waitUntil(
          async () => (await toggle.getAttribute("aria-expanded")) === expanded,
        );
      }
    }
    await projects.moveTo();
    expect(await $('[data-testid="virtual-project-add"] svg.lucide-plus').isExisting()).toBe(true);
    expect(
      await $(
        '[data-testid="virtual-project-new-task"] svg.lucide-message-circle-plus',
      ).isExisting(),
    ).toBe(true);
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await $('[data-testid="virtual-project-device"]').getText()).toContain("此电脑");
    expect(await $('[data-testid="virtual-project-type-next"]').isExisting()).toBe(false);
    await captureProjectDialogLayouts("form");
    expect(await $('[data-testid="virtual-project-root"]').isExisting()).toBe(false);
    expect(await $('[data-testid="virtual-project-browse"]').getText()).toMatch(
      /可读取和编辑|can read and edit/,
    );
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "virtual-project-editor.png"),
    );
    await captureProjectDialogLayouts("editor");
    await browser.keys("Escape");
    await $('[role="dialog"]').waitForExist({ reverse: true });
    // aside 保留内部宽度，即使容器已收起；必须读 Shell 面板实际宽度，不能无条件 toggle。
    const sidebarExpanded = () =>
      browser.execute(() => {
        const shell = document.querySelector('[data-workspace-shell="true"]');
        return shell
          ? Number.parseFloat(
              getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width"),
            ) > 200
          : false;
      });
    if (!(await sidebarExpanded())) {
      const sidebarToggle = $(
        'button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]',
      );
      await sidebarToggle.waitForClickable();
      await sidebarToggle.click();
    }
    await browser.waitUntil(sidebarExpanded);
    await tasks.$('button[data-slot="collapsible-trigger"]').click();
    await browser.refresh();
    await tasks.waitForDisplayed();
    expect(
      await tasks.$('button[data-slot="collapsible-trigger"]').getAttribute("aria-expanded"),
    ).toBe("false");
    await tasks.$('button[data-slot="collapsible-trigger"]').click();
  });
  it("VP20：项目图标、hover 三入口和右键操作保持一致", async function () {
    this.timeout(90_000);
    const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "project-row-actions");
    const paths = [join(root, "one"), join(root, "two")] as const;
    await Promise.all(
      paths.map(async (path, index) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, `E2E_PROJECT_ROW_${index}.txt`), `root ${index}`);
      }),
    );
    await openLocalProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_PROJECT_ROW");
    for (const path of paths) await chooseProjectRoot(path);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const project = $('[data-project-name="E2E_PROJECT_ROW"]');
    await project.waitForDisplayed();
    const row = project.$('[data-testid="virtual-project-row"]');
    const toggle = row.$('[data-testid="virtual-project-toggle"]');
    expect(await row.$("svg.lucide-chevron-right, svg.lucide-chevron-down").isExisting()).toBe(
      false,
    );
    // 多 root 已使用叠层图标，开合断言仍分别验证展开和折叠。
    expect(await toggle.$("svg.lucide-folders-open").isExisting()).toBe(true);
    await toggle.click();
    expect(await toggle.$("svg.lucide-folders").isExisting()).toBe(true);
    await browser.execute(() => (document.activeElement as HTMLElement)?.blur());
    await $('[data-testid="task-new-button"]').moveTo();
    const opacity = () =>
      browser.execute(
        () =>
          getComputedStyle(
            document.querySelector(
              '[data-project-name="E2E_PROJECT_ROW"] [data-testid="virtual-project-actions"]',
            )!,
          ).opacity,
      );
    await browser.waitUntil(async () => (await opacity()) === "0");
    await row.moveTo();
    await browser.waitUntil(async () => (await opacity()) === "1");
    for (const icon of ["ellipsis", "list-tree", "message-circle-plus"])
      expect(await row.$(`svg.lucide-${icon}`).isExisting()).toBe(true);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP20-project-row-hover.png"),
    );
    await row.$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-edit"]').click();
    await $('[data-testid="virtual-project-save"]').click();
    await $('[role="dialog"]').waitForExist({ reverse: true });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await row.moveTo();
    await row.$('[data-testid="virtual-project-files"]').click();
    await $('[data-testid="virtual-project-files-1"]').click();
    const panel = $('[data-testid="workspace-file-tree-panel"]');
    await panel.waitForDisplayed();
    await browser.waitUntil(async () => (await panel.getText()).includes("E2E_PROJECT_ROW_1.txt"));
    expect(await panel.getText()).not.toContain("E2E_PROJECT_ROW_0.txt");
    // 项目文件现已在右侧文件标签展示，关闭当前标签回到原草稿。
    await $('[data-side-pane-tab-id][data-state="active"] button[aria-label]').click();
    await panel.waitForExist({ reverse: true });
    await row.click({ button: "right" });
    expect(await $('[data-testid="virtual-project-edit"]').isExisting()).toBe(true);
    expect(await $('[data-testid="virtual-project-context-create-task"]').isExisting()).toBe(true);
    await $('[data-testid="virtual-project-context-files-0"]').click();
    await panel.waitForDisplayed();
    await browser.waitUntil(async () => (await panel.getText()).includes("E2E_PROJECT_ROW_0.txt"));
    // 项目文件现已在右侧文件标签展示，关闭当前标签回到原草稿。
    await $('[data-side-pane-tab-id][data-state="active"] button[aria-label]').click();
    await row.moveTo();
    await row.$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(paths[0], 30_000);
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    const original = $('[data-project-name="ZCodeProject"]');
    await original.moveTo();
    await original.$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
  });
  it("VP20：单 workspace 查看文件显示完整路径并适配窄屏", async function () {
    this.timeout(60_000);
    const original = $('[data-project-name="ZCodeProject"]');
    await original.waitForDisplayed();
    const appearance = await browser.execute(() => ({
      width: innerWidth,
      theme: (
        window as Window & { __testActions?: { getTheme(): string } }
      ).__testActions!.getTheme(),
    }));
    const ensureSidebarExpanded = async () => {
      const expanded = () =>
        browser.execute(() => {
          const shell = document.querySelector('[data-workspace-shell="true"]')!;
          return (
            Number.parseFloat(
              getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width"),
            ) > 200
          );
        });
      if (!(await expanded()))
        await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
      await browser.waitUntil(expanded);
      await original.waitForDisplayed();
    };
    const files = $('[data-testid="virtual-project-context-files-0"]');
    try {
      await original.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      await files.waitForDisplayed();
      // 与弹窗布局验收一致：先打开菜单，再缩放；桌面窄屏会自动收起侧栏，不代表手机导航入口。
      for (const width of [1200, 390]) {
        await setRendererViewport(width, 844);
        for (const theme of ["zai-light", "zai-dark"]) {
          await browser.execute((value) => {
            (
              window as Window & { __testActions?: { setTheme(theme: string): void } }
            ).__testActions!.setTheme(value);
          }, theme);
          await browser.waitUntil(() =>
            browser.execute(
              (value) => document.documentElement.classList.contains(`theme-${value}`),
              theme,
            ),
          );
          expect(await files.getText()).toBe(`查看文件 · ${DEFAULT_WORKSPACE}`);
          const fit = await browser.execute(async () => {
            const menu = document.querySelector('[data-slot="context-menu-content"]')!;
            await Promise.all(menu.getAnimations().map((animation) => animation.finished));
            const bounds = menu.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, viewport: innerWidth };
          });
          expect(fit.left).toBeGreaterThanOrEqual(0);
          expect(fit.right).toBeLessThanOrEqual(fit.viewport);
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP20-single-root-${width}-${theme}.png`),
          );
        }
      }
    } finally {
      // 新增项目详情后 Escape 先交给详情层；先离开 hover 区再关闭右键菜单。
      const outside = await browser.execute(() => ({ x: innerWidth - 8, y: 8 }));
      await browser.action("pointer").move(outside).perform();
      await $('[data-testid="project-identity-details"]').waitForExist({ reverse: true });
      await browser.keys("Escape");
      await files.waitForExist({ reverse: true });
      await clearRendererViewport();
      await browser.waitUntil(() =>
        browser.execute((width) => innerWidth === width, appearance.width),
      );
      await ensureSidebarExpanded();
      await browser.execute((value) => {
        (
          window as Window & { __testActions?: { setTheme(theme: string): void } }
        ).__testActions!.setTheme(value);
      }, appearance.theme);
    }
  });
  it("VP20：本地项目共用详情，单多目录完整展示且不重复名称", async function () {
    this.timeout(180_000);
    const paths = ["one", "two-with-a-long-directory-name-for-hover-layout"].map((name) =>
      join(DEFAULT_WORKSPACE, ".zcode-e2e", "project-hover-details", name),
    );
    await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
    const cases = [
      { name: "ZCodeProject", paths: [DEFAULT_WORKSPACE] },
      { name: "E2E_PROJECT_HOVER_MULTI", paths },
      { name: "E2E_PROJECT_HOVER_EMPTY", paths: [] },
    ];
    for (const project of cases.slice(1)) {
      if (!project.paths.length) {
        // UI 创建后进入草稿会分配默认 root；通过真实 Host 仅登记空项目，不触发任务创建。
        await installHandoffRpcProbe();
        try {
          await callHandoffHost(ServiceChannels.Project, "saveProject", [
            { name: project.name, roots: [] },
          ]);
        } finally {
          await restoreHandoffProbes();
        }
        continue;
      }
      await openLocalProjectEditor();
      await $('[data-testid="virtual-project-name"]').setValue(project.name);
      for (const path of project.paths) await chooseProjectRoot(path);
      await $('[data-testid="virtual-project-save"]').click();
      if (project.paths.length) {
        await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
        await $('[data-testid="project-folder-trust-confirm"]').click();
      }
      await $('[data-slot="dialog-overlay"]').waitForExist({ reverse: true });
    }
    const appearance = await browser.execute(() => ({
      width: innerWidth,
      theme: (
        window as Window & { __testActions?: { getTheme(): string } }
      ).__testActions!.getTheme(),
    }));
    const details = $('[data-testid="project-identity-details"]');
    const closeDetails = async () => {
      const outside = await browser.execute(() => ({ x: innerWidth - 8, y: 8 }));
      await browser.action("pointer").move(outside).perform();
      await browser.executeAsync((done) => requestAnimationFrame(() => done()));
      expect(await details.isExisting()).toBe(false);
    };
    try {
      for (const project of cases) {
        const layouts =
          project.paths.length === 2
            ? ([
                { width: 1200, theme: "zai-light", locale: "zh-CN" },
                { width: 1200, theme: "zai-dark", locale: "en-US" },
                { width: 390, theme: "zai-light", locale: "en-US" },
                { width: 390, theme: "zai-dark", locale: "zh-CN" },
              ] as const)
            : ([{ width: 1200, theme: "zai-light", locale: "zh-CN" }] as const);
        for (const { width, theme, locale } of layouts) {
          const previousWidth = await browser.execute(() => innerWidth);
          await setRendererViewport(width, 844);
          await browser.execute(
            (theme, locale) => {
              const actions = (
                window as Window & {
                  __testActions?: {
                    setTheme(value: string): void;
                    setLocale(value: "zh-CN" | "en-US"): void;
                  };
                }
              ).__testActions!;
              actions.setTheme(theme);
              actions.setLocale(locale);
            },
            theme,
            locale,
          );
          // viewport 更新后 Shell 在后续帧收起侧栏，先完成布局再读取开关状态。
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          const sidebarExpanded = () =>
            browser.execute(() => {
              const shell = document.querySelector('[data-workspace-shell="true"]')!;
              return (
                Number.parseFloat(
                  getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width"),
                ) > 200
              );
            });
          // 真实 resize 会等 idle 后自动收起；等待实际状态，不能在收起前抢先 hover。
          if (width === 390 && previousWidth !== width) {
            await browser.waitUntil(async () => !(await sidebarExpanded()));
          }
          if (!(await sidebarExpanded())) {
            await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
          }
          await browser.waitUntil(sidebarExpanded);
          for (const entry of ["sidebar", "composer"]) {
            if (entry === "composer") {
              await $('[data-testid="composer-workspace-trigger"]').click();
              await $('[data-testid="composer-project-menu"] input').setValue(project.name);
            }
            const scope = entry === "sidebar" ? "aside" : '[data-testid="composer-project-menu"]';
            const target = $(`${scope} [data-project-name="${project.name}"]`);
            await (
              entry === "sidebar" ? target.$('[data-testid="virtual-project-toggle"]') : target
            ).moveTo();
            await details.waitForDisplayed();
            expect(await details.$("strong").getText()).toBe(project.name);
            expect(await details.$$("dt").map((field) => field.getText())).toEqual([
              locale === "zh-CN" ? "目录" : "Directory",
            ]);
            expect(await details.$$("dd > div").map((path) => path.getText())).toEqual(
              project.paths,
            );
            if (!project.paths.length) expect(await details.$("dd").getText()).toBe("—");
            const geometry = await browser.execute(async () => {
              const card = document.querySelector('[data-testid="project-identity-details"]')!;
              await Promise.all(card.getAnimations().map((animation) => animation.finished));
              const bounds = card.getBoundingClientRect();
              return {
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                bottom: bounds.bottom,
                width: innerWidth,
                height: innerHeight,
                cardWidth: bounds.width,
                valueWidth: card.querySelector("dd")!.getBoundingClientRect().width,
              };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0);
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            expect(geometry.top).toBeGreaterThanOrEqual(0);
            expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
            expect(geometry.valueWidth).toBeGreaterThanOrEqual(
              Math.min(120, geometry.cardWidth - 32),
            );
            await browser.saveScreenshot(
              join(
                process.env.ZCODE_E2E_ARTIFACT_DIR!,
                `VP20-hover-${project.paths.length}-${entry}-${width}-${theme}-${locale}.png`,
              ),
            );
            await details.moveTo();
            expect(await details.isDisplayed()).toBe(true);
            await closeDetails();
            if (entry === "composer") {
              await browser.keys("Escape");
              await $('[data-testid="composer-project-menu"]').waitForExist({ reverse: true });
            }
          }
        }
      }
    } finally {
      await browser.keys("Escape");
      await clearRendererViewport();
      await browser.execute((theme) => {
        const actions = (
          window as Window & {
            __testActions?: {
              setTheme(value: string): void;
              setLocale(value: "zh-CN"): void;
            };
          }
        ).__testActions!;
        actions.setTheme(theme);
        actions.setLocale("zh-CN");
      }, appearance.theme);
    }
  });
  it("VP22：已有目录列表、设为主要与编辑器删除", async function () {
    this.timeout(90_000);
    const testHome = process.env.ZCODE_E2E_HOME_DIR!;
    if (
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("隔离 HOME required");
    const paths = ["test-aaa", "test-bbb"].map((name) =>
      join(DEFAULT_WORKSPACE, ".zcode-e2e", "project-editor", name),
    );
    await Promise.all(
      paths.map(async (path) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "keep.txt"), "preserve project files");
      }),
    );
    await openLocalProjectEditor();
    expect(await $('[data-testid="virtual-project-editor-delete"]').isExisting()).toBe(false);
    for (const path of paths) await chooseProjectRoot(path);
    await $('[data-testid="virtual-project-name"]').setValue("E2E_PROJECT_EDITOR");
    expect(
      await $(
        '[data-testid="virtual-project-roots"] [data-testid="virtual-project-browse"]',
      ).getText(),
    ).toMatch(/添加文件夹|Add folder/);
    expect(await $('[role="dialog"] input[type="radio"]').isExisting()).toBe(false);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const project = $('[data-project-name="E2E_PROJECT_EDITOR"]');
    await project.waitForDisplayed();
    const id = await project.getAttribute("data-project-id");
    const db = new DatabaseSync(join(testHome, ".zcode", "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    const primary = () =>
      db.prepare("SELECT root_path FROM project_roots WHERE project_id=? AND is_primary=1").get(id)
        ?.root_path;
    const edit = async () => {
      await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      await $('[data-testid="virtual-project-edit"]').click();
      await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    };
    try {
      await edit();
      const rows = await $$('[data-testid="virtual-project-root-row"]');
      expect(await rows[0]!.$('[data-testid="virtual-project-root-name"]').getText()).toBe(
        "test-aaa",
      );
      expect(await rows[1]!.$('[data-testid="virtual-project-root-name"]').getText()).toBe(
        "test-bbb",
      );
      await rows[1]!.$('[data-testid="virtual-project-set-primary"]').click();
      expect(primary()).toBe(paths[0]);
      await rows[1]!.$('[data-testid="virtual-project-primary"]').waitForDisplayed();
      await captureProjectDialogLayouts("populated-editor");
      await $('[data-testid="virtual-project-save"]').click();
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.waitUntil(() => primary() === paths[1]);
      // 窄屏采样会按既有策略收起侧栏，通过真实入口恢复后继续操作。
      if (
        await browser.execute(
          () => (document.querySelector("aside")?.getBoundingClientRect().width ?? 0) < 200,
        )
      ) {
        await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
        await browser.waitUntil(() =>
          browser.execute(
            () => (document.querySelector("aside")?.getBoundingClientRect().width ?? 0) > 200,
          ),
        );
      }
      await edit();
      const reopened = await $$('[data-testid="virtual-project-root-row"]');
      await reopened[1]!.$('[data-testid="virtual-project-primary"]').waitForDisplayed();
      await reopened[1]!.$('[data-testid="virtual-project-remove-folder"]').click();
      await reopened[0]!.$('[data-testid="virtual-project-primary"]').waitForDisplayed();
      await $('[role="dialog"]')
        .$('.//button[normalize-space(.)="取消" or normalize-space(.)="Cancel"]')
        .click();
      await $('[role="dialog"]').waitForExist({ reverse: true });
      expect(primary()).toBe(paths[1]);
      await project.moveTo();
      await project.$('[data-testid="virtual-project-create-task"]').click();
      await waitForWorkspaceApp(paths[1]!, 30_000);
      await edit();
      await $('[data-testid="virtual-project-editor-delete"]').click();
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await project.waitForExist({ reverse: true });
      expect(db.prepare("SELECT deleted FROM projects WHERE project_id=?").get(id)?.deleted).toBe(
        1,
      );
      expect(
        db.prepare("SELECT count(*) AS n FROM project_roots WHERE project_id=?").get(id)?.n,
      ).toBe(2);
      for (const path of paths)
        expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("preserve project files");
    } finally {
      db.close();
      await browser.keys("Escape");
      const original = $('[data-project-name="ZCodeProject"]');
      await original.moveTo();
      await original.$('[data-testid="virtual-project-create-task"]').click();
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    }
  });
  it("VP12：Bot 访问范围选择项目 ID，同 cwd 的项目分别保存", async function () {
    this.timeout(90_000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    const testHome = process.env.ZCODE_E2E_HOME_DIR!;
    if (
      !testHome ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("隔离 HOME required");
    const cwd = join(testHome, "E2E_VP12_SHARED_ROOT");
    await mkdir(cwd, { recursive: true });
    const names = ["E2E_VP12_A", "E2E_VP12_B"];
    const ids: string[] = [];
    for (const name of names) {
      await openLocalProjectEditor();
      await $('[data-testid="virtual-project-name"]').setValue(name);
      await chooseProjectRoot(cwd);
      await $('[data-testid="virtual-project-save"]').click();
      await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
      await $('[data-testid="project-folder-trust-confirm"]').click();
      const project = $(`[data-project-name="${name}"]`);
      await project.waitForDisplayed();
      const projectId = await project.getAttribute("data-project-id");
      if (!projectId) throw new Error("项目 ID 缺失");
      ids.push(projectId);
    }
    // 创建项目会打开草稿；访问范围编辑本身不能增加或切换 workspace。
    const readBotTabs = () =>
      browser.execute(() => {
        const store = (
          window as Window & {
            __zcodeTabStoreE2E?: { getState(): { tabs: Array<{ workspacePath?: string }> } };
          }
        ).__zcodeTabStoreE2E;
        return store?.getState().tabs.map((tab) => tab.workspacePath) ?? [];
      });
    const tabsBeforeBotAccess = await readBotTabs();
    const configPath = join(testHome, ".zcode/v2/bot-config.v3.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        bots: [
          {
            id: "E2E_VP12_BOT",
            name: "E2E_VP12_BOT",
            provider: "webhook",
            enabled: false,
            allowedWorkspaces: ["*"],
            allowedCommands: {
              status: true,
              new: true,
              workspace: true,
              model: true,
              thoughtLevel: true,
              reply: true,
            },
            currentOptions: {},
            replyMode: "assistant_changes",
          },
        ],
      }),
    );
    const remoteControl = $(
      'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
    );
    await remoteControl.waitForClickable();
    await remoteControl.click();
    await $('[data-testid="web-remote-control-open-bots"]').waitForClickable();
    await $('[data-testid="web-remote-control-open-bots"]').click();
    try {
      const access = $('[data-testid="bots-project-access-trigger"]');
      await access.waitForClickable();
      await access.click();
      // Radix 选项文本承载于内部 span，点击公开 option 元素。
      await browser.waitUntil(async () => (await $$('[role="option"]').length) > 0);
      await browser.execute(() => {
        const item = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
          (node) => /指定项目|Selected projects/.test(node.textContent ?? ""),
        );
        if (!item) throw new Error("指定项目选项缺失");
        item.click();
      });
      for (let index = 0; index < names.length; index++) {
        const button = $(`button[title="${names[index]}"]`);
        await button.waitForClickable();
        const readAllowed = async () =>
          JSON.parse(await readFile(configPath, "utf8")).bots[0].allowedWorkspaces as string[];
        const id = JSON.stringify(["local", ids[index]]);
        if (!(await readAllowed()).includes(id)) await button.click();
        await browser.waitUntil(async () => (await readAllowed()).includes(id));
      }
      const allowed = JSON.parse(await readFile(configPath, "utf8")).bots[0]
        .allowedWorkspaces as string[];
      expect(ids.every((id) => allowed.includes(JSON.stringify(["local", id])))).toBe(true);
      expect(allowed.includes(cwd)).toBe(false);
      expect(await readBotTabs()).toEqual(tabsBeforeBotAccess);
    } finally {
      await browser.keys("Escape");
      await browser.keys("Escape");
    }
  });
  it("VP01：首个窗口可用时 app 与 CLI 两库的版本化迁移已经完成", async function () {
    this.timeout(60_000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    const testHome = process.env.ZCODE_E2E_HOME_DIR;
    if (
      !testHome ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("isolated temporary E2E HOME required");
    for (const [path, migrationId] of [
      [join(testHome, ".zcode", "v2", "tasks-index.sqlite"), "0005_projects"],
      [join(testHome, ".zcode", "cli", "db", "db.sqlite"), "0023_session_soft_delete_outcome"],
    ] as const) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT id FROM schema_migration WHERE id=?").get(migrationId),
        ).toBeDefined();
      } finally {
        db.close();
      }
    }
  });
  it("VP08：离线远端项目只显示缓存，移除入口后重载不复活", async function () {
    this.timeout(90_000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    const testHome = process.env.ZCODE_E2E_HOME_DIR;
    if (
      !testHome ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("isolated temporary E2E HOME required");
    const db = new DatabaseSync(join(testHome, ".zcode", "v2", "tasks-index.sqlite"));
    try {
      // 只在隔离 HOME 注入离线缓存，不接触真实设备、网络或用户目录。
      db.prepare("INSERT INTO hosts(host_id,kind,target_json,membership_id) VALUES(?,?,?,?)").run(
        "remote:server:e2e-offline",
        "docker",
        JSON.stringify({ kind: "docker", container: "e2e-offline-fixture" }),
        "e2e-member",
      );
      db.prepare(
        "INSERT INTO remote_project_entries(entry_id,host_id,remote_project_id,cached_name,cached_roots_json) VALUES(?,?,?,?,?)",
      ).run(
        "e2e-offline-entry",
        "remote:server:e2e-offline",
        "offline-project",
        "E2E_VP08_Offline",
        JSON.stringify([{ rootPath: "/e2e/offline-root", position: 0, isPrimary: true }]),
      );
    } finally {
      db.close();
    }
    await browser.refresh();
    // 隔离测试刷新后可能重新进入欢迎页；复用既有登录准备，不放宽离线项目断言。
    const apiKeyEntry = $('[data-testid="login-use-api-key-button"]');
    await browser.waitUntil(
      async () =>
        (await apiKeyEntry.isDisplayed()) ||
        (await $('[data-workspace-shell="true"]').isDisplayed()),
      { timeout: 45_000 },
    );
    if (await apiKeyEntry.isDisplayed()) await loginWithApiKey();
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    const offline = $('[data-project-name="E2E_VP08_Offline"]');
    try {
      await offline.waitForDisplayed({ timeout: 30_000 });
    } catch (error) {
      const geometry = await browser.execute(() => {
        const target = document.querySelector('[data-project-name="E2E_VP08_Offline"]');
        const rows = [];
        for (let node = target; node; node = node.parentElement) {
          const style = getComputedStyle(node),
            rect = node.getBoundingClientRect();
          rows.push({
            tag: node.tagName,
            slot: node.getAttribute("data-slot"),
            state: node.getAttribute("data-state"),
            box: { height: rect.height, width: rect.width },
            visibility: style.visibility,
            display: style.display,
            opacity: style.opacity,
            overflow: style.overflow,
            animation: style.animation,
          });
        }
        return rows;
      });
      throw new Error(String(error) + JSON.stringify(geometry));
    }
    const readSettings = async () =>
      JSON.parse(await readFile(join(testHome, ".zcode/v2/setting.json"), "utf8"));
    await browser.waitUntil(async () =>
      (await readSettings()).lastWorkspaceSession.some(
        (entry: { workspacePath: string }) => entry.workspacePath === "/e2e/offline-root",
      ),
    );
    expect(await $('[data-testid="remote-project-host"]').isExisting()).toBe(false);
    expect(await offline.$('[data-testid="project-device"]').getText()).toContain(
      "e2e-offline-fixture",
    );
    expect(
      await offline.$('[data-testid="virtual-project-toggle"]').getAttribute("aria-expanded"),
    ).toBe("false");
    expect(await offline.$('[data-testid="virtual-project-create-task"]').isExisting()).toBe(false);
    await offline.$('[data-testid="virtual-project-row"]').click({ button: "right" });
    expect(await $('[data-testid="virtual-project-edit"]').isExisting()).toBe(false);
    await $('[data-testid="virtual-project-remove-entry"]').click();
    await offline.waitForDisplayed({ reverse: true });
    expect(
      (await readSettings()).lastWorkspaceSession.some(
        (entry: { workspacePath: string }) => entry.workspacePath === "/e2e/offline-root",
      ),
    ).toBe(false);
    await refreshVirtualProjectWorkspace();
    expect(await offline.isExisting()).toBe(false);
    const check = new DatabaseSync(join(testHome, ".zcode", "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        check
          .prepare("SELECT entry_id FROM remote_project_entries WHERE entry_id='e2e-offline-entry'")
          .get(),
      ).toBeUndefined();
      expect(
        check.prepare("SELECT host_id FROM hosts WHERE host_id='remote:server:e2e-offline'").get(),
      ).toBeDefined();
    } finally {
      check.close();
    }
  });
  it("VP08/VP17/VP18 URL：元数据无 tab，远端任务执行、重开与 CLI 冷恢复", async function () {
    this.timeout(120_000);
    const testHome = process.env.ZCODE_E2E_HOME_DIR;
    if (
      !testHome ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("isolated E2E HOME required");
    const serverHome = join(testHome, "url-server");
    await mkdir(join(serverHome, ".zcode", "v2"), { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/e2e/fixtures/virtual-project/server.ts"],
      {
        cwd: resolve(process.cwd()),
        env: {
          ...process.env,
          HOME: serverHome,
          USERPROFILE: serverHome,
          ZCODE_DATA_BASE_DIR: serverHome,
          ZCODE_DESKTOP_HOME_DIR: serverHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    try {
      const ready = await new Promise<{
        port: number;
        hostId: string;
        serverId: string;
        projectId: string;
      }>((resolveReady, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`URL fixture did not start: ${output.slice(-4000)}`)),
          30_000,
        );
        child.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(deadline);
          reject(new Error(`URL fixture exited ${code}: ${output.slice(-4000)}`));
        });
        child.stdout.on("data", (data) => {
          output += data.toString();
          const match = output.match(/E2E_VP_SERVER_READY ([^\n]+)\n/);
          if (match) {
            clearTimeout(deadline);
            resolveReady(JSON.parse(match[1]!));
          }
        });
      });
      const dbPath = join(testHome, ".zcode/v2/tasks-index.sqlite");
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("INSERT INTO hosts(host_id,kind,target_json,membership_id) VALUES(?,?,?,?)").run(
          ready.hostId,
          "server",
          JSON.stringify({
            kind: "server",
            url: `http://127.0.0.1:${ready.port}`,
            serverId: ready.serverId,
            name: "E2E_URL_HOST",
          }),
          "e2e-url-member",
        );
      } finally {
        db.close();
      }
      await refreshVirtualProjectWorkspace();
      await installHandoffRpcProbe();
      const addExistingProject = async () => {
        // Direct URL 不属于 Source 设备选择器；通过专用元数据服务准备入口，下面继续验真实项目 UI。
        const tree = await callHandoffHost<{ projects: VirtualProject[] }>(
          ServiceChannels.Project,
          "readTree",
          [{ hostId: ready.hostId }],
        );
        const remoteProject = tree.projects.find((project) => project.id === ready.projectId)!;
        await callHandoffHost(ServiceChannels.RemoteProjects, "addEntry", [
          {
            hostId: ready.hostId,
            expectedMembershipId: "e2e-url-member",
            project: {
              projectId: remoteProject.id,
              name: remoteProject.name,
              roots: remoteProject.roots,
            },
          },
        ]);
      };
      const readTabs = () =>
        browser.execute(() => {
          const state = (
            window as Window & {
              __zcodeTabStoreE2E?: {
                getState(): {
                  tabs: { workspacePath?: string; workspaceIdentity?: string; kind?: string }[];
                };
              };
            }
          ).__zcodeTabStoreE2E?.getState();
          return state?.tabs.map((tab) => tab.workspaceIdentity || tab.workspacePath || tab.kind);
        });
      const tabs = await readTabs();
      // 保留 Host 记录不会建立连接；先走真实连接服务，避免离线调用被误判为项目业务失败。
      const connected = await callHandoffHost<{ id: string; connectionStatus: string }>(
        ServiceChannels.RemoteProjects,
        "connectHost",
        [ready.hostId],
      );
      expect(connected.id).toBe(ready.hostId);
      expect(connected.connectionStatus).toBe("online");
      expect(await readTabs()).toEqual(tabs);
      const createdMetadata = await callHandoffHost<VirtualProject>(
        ServiceChannels.Project,
        "saveProject",
        [
          {
            hostId: ready.hostId,
            name: "E2E_VP19_REMOTE_CREATED",
            roots: [join(serverHome, "work", "repo")],
          },
        ],
      );
      await callHandoffHost(ServiceChannels.RemoteProjects, "addEntry", [
        {
          hostId: ready.hostId,
          expectedMembershipId: "e2e-url-member",
          project: {
            projectId: createdMetadata.id,
            name: createdMetadata.name,
            roots: createdMetadata.roots,
          },
        },
      ]);
      const createdRemote = $('[data-project-name="E2E_VP19_REMOTE_CREATED"]');
      await createdRemote.waitForDisplayed();
      expect(await readTabs()).toEqual(tabs);
      await removeRemoteProjectEntryForRow('[data-project-name="E2E_VP19_REMOTE_CREATED"]');
      await createdRemote.waitForExist({ reverse: true });
      await addExistingProject();
      let project = $('[data-project-name="E2E_VP08_URL"]');
      await project.waitForDisplayed();
      expect(await readTabs()).toEqual(tabs);
      child.stdin.write("rename-externally\n");
      project = $('[data-project-name="E2E_VP08_URL_EXTERNAL"]');
      await project.waitForDisplayed({ timeout: 15_000 });
      await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      await $('[data-testid="virtual-project-edit"]').click();
      await $('[data-testid="virtual-project-name"]').setValue("E2E_VP08_URL_RENAMED");
      expect(await $('[data-testid="virtual-project-browse"]').isExisting()).toBe(false);
      expect(await readTabs()).toEqual(tabs);
      await $('[data-testid="virtual-project-save"]').click();
      const renamed = $('[data-project-name="E2E_VP08_URL_RENAMED"]');
      await renamed.waitForDisplayed();
      const remoteDb = new DatabaseSync(join(serverHome, ".zcode/v2/tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          remoteDb.prepare("SELECT name FROM projects WHERE project_id=?").get(ready.projectId)
            ?.name,
        ).toBe("E2E_VP08_URL_RENAMED");
      } finally {
        remoteDb.close();
      }
      await removeRemoteProjectEntryForRow('[data-project-name="E2E_VP08_URL_RENAMED"]');
      await renamed.waitForDisplayed({ reverse: true });
      await refreshVirtualProjectWorkspace();
      // 刷新会销毁旧 renderer 的 RPC 探针；重新装配当前端口后才能继续准备元数据。
      await installHandoffRpcProbe();
      expect(await renamed.isExisting()).toBe(false);
      expect(await readTabs()).toEqual(tabs);
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          check.prepare("SELECT count(*) AS n FROM projects WHERE host_id=?").get(ready.hostId)?.n,
        ).toBe(0);
        expect(
          check
            .prepare("SELECT count(*) AS n FROM remote_project_entries WHERE host_id=?")
            .get(ready.hostId)?.n,
        ).toBe(0);
      } finally {
        check.close();
      }
      // 主动重新添加同一个远端项目，元数据路径已验证无 tab；下面单独验证真实执行。
      await addExistingProject();
      await renamed.waitForDisplayed();
      expect(await renamed.getAttribute("data-project-id")).toBe(ready.projectId);
      // 显式查看尚未打开的远端 root 才申请绑定；文件树必须读 Source 的文件。
      await writeFile(
        join(serverHome, "work", "repo", "E2E_PROJECT_REMOTE_FILE.txt"),
        "remote owner",
      );
      await renamed.moveTo();
      await renamed.$('[data-testid="virtual-project-files"]').click();
      const fileRoot = $('[data-testid="virtual-project-files-0"]');
      if (await fileRoot.isExisting()) await fileRoot.click();
      const remoteFiles = $('[data-testid="workspace-file-tree-panel"]');
      await remoteFiles.waitForDisplayed();
      await browser.waitUntil(async () =>
        (await remoteFiles.getText()).includes("E2E_PROJECT_REMOTE_FILE.txt"),
      );
      await $('[data-side-pane-tab-id][data-state="active"] button[aria-label]').click();
      await remoteFiles.waitForExist({ reverse: true });
      await renamed.moveTo();
      await renamed.$('[data-testid="virtual-project-create-task"]').click();
      await waitForWorkspaceApp(join(serverHome, "work", "repo"), 30_000);
      await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).waitForDisplayed();
      const draftOwner = await browser.execute(() => {
        const testWindow = window as Window & {
          __zcodeTabStoreE2E?: {
            getState(): {
              activeWorkspacePath: string | null;
              activeWorkspaceIdentity?: string | null;
            };
          };
          __zcodeSessionStoreE2E?: {
            getState(): {
              getWorkspaceState(
                path: string,
                identity?: string,
              ): { draftProjectId?: string | null; activeTaskId: string | null };
            };
          };
        };
        const tabs = testWindow.__zcodeTabStoreE2E?.getState();
        const draft = tabs?.activeWorkspacePath
          ? testWindow.__zcodeSessionStoreE2E
              ?.getState()
              .getWorkspaceState(
                tabs.activeWorkspacePath,
                tabs.activeWorkspaceIdentity ?? undefined,
              )
          : undefined;
        return {
          path: tabs?.activeWorkspacePath,
          identity: tabs?.activeWorkspaceIdentity,
          projectId: draft?.draftProjectId,
          activeTaskId: draft?.activeTaskId,
        };
      });
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-draft.json"),
        JSON.stringify(draftOwner, null, 2),
      );
      expect(draftOwner.projectId).toBe(ready.projectId);
      await setInputValueByTestIdDom(
        TID_V4_COMPOSER_INPUT,
        "E2E_VP17_REMOTE: Reply with E2E_VP17_READY.",
      );
      await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).waitForEnabled({ timeout: 30_000 });
      await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
      await $('//*[normalize-space(.)="E2E_VP17_READY" and not(*)]').waitForDisplayed({
        timeout: 60_000,
      });
      const captured = await waitForUpstreamNetworkCapture("E2E_VP17_REMOTE");
      expect(JSON.stringify(captured.requestJson).includes("E2E_VP17_REMOTE_EXTRA_SKILL")).toBe(
        true,
      );
      const remoteFacts = new DatabaseSync(join(serverHome, ".zcode/v2/tasks-index.sqlite"), {
        readOnly: true,
      });
      let remoteTaskId: string;
      try {
        await browser.waitUntil(
          () =>
            Boolean(
              remoteFacts
                .prepare(
                  "SELECT task_id FROM tasks WHERE project_id=? AND cli_last_outcome='completed'",
                )
                .get(ready.projectId),
            ),
          { timeout: 10_000 },
        );
        const task = remoteFacts
          .prepare(
            "SELECT task_id,host_id,workspace_path,workspace_identity FROM tasks WHERE project_id=? AND cli_last_outcome='completed'",
          )
          .get(ready.projectId)!;
        remoteTaskId = String(task.task_id);
        expect(task.host_id).toBe(ready.hostId);
        expect(task.workspace_path).toBe(join(serverHome, "work", "repo"));
        expect(String(task.workspace_identity)).toContain(ready.serverId);
      } finally {
        remoteFacts.close();
      }
      const controllerFacts = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          controllerFacts
            .prepare("SELECT count(*) AS n FROM tasks WHERE host_id=?")
            .get(ready.hostId)?.n,
        ).toBe(0);
      } finally {
        controllerFacts.close();
      }
      await $('[data-testid="task-new-button"]').click();
      await $('//*[normalize-space(.)="E2E_VP17_READY" and not(*)]').waitForDisplayed({
        reverse: true,
      });
      await renamed.$(`[data-testid="${testId(TID_TASK_ITEM, remoteTaskId)}"]`).click();
      await $('//*[normalize-space(.)="E2E_VP17_READY" and not(*)]').waitForDisplayed();
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-remote-task.png"),
      );
      const currentRuntime = () =>
        Array.from(output.matchAll(/E2E_VP18_RUNTIME ([^\n]+)\n/g))
          .map((match) => JSON.parse(match[1]!) as { state: string; identity: string })
          .filter((event) => event.state === "available")
          .at(-1)?.identity;
      const previousRuntime = currentRuntime();
      expect(previousRuntime).toBeTruthy();
      await $('[data-testid="task-new-button"]').click();
      await $('//*[normalize-space(.)="E2E_VP17_READY" and not(*)]').waitForDisplayed({
        reverse: true,
      });
      child.stdin.write("refresh-skills-and-dispose\n");
      await browser.waitUntil(() => output.includes("E2E_VP18_DISPOSED"), { timeout: 30_000 });
      await renamed.$(`[data-testid="${testId(TID_TASK_ITEM, remoteTaskId)}"]`).click();
      await $('//*[normalize-space(.)="E2E_VP17_READY" and not(*)]').waitForDisplayed();
      await setInputValueByTestIdDom(
        TID_V4_COMPOSER_INPUT,
        "E2E_VP18_COLD: Reply with E2E_VP18_READY.",
      );
      await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).waitForEnabled({ timeout: 30_000 });
      await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
      await $('//*[normalize-space(.)="E2E_VP18_READY" and not(*)]').waitForDisplayed({
        timeout: 60_000,
      });
      const coldCapture = await waitForUpstreamNetworkCapture("E2E_VP18_COLD");
      const coldRequest = JSON.stringify(coldCapture.requestJson);
      expect(coldRequest.includes("E2E_VP18_REMOTE_COLD_SKILL")).toBe(true);
      expect(coldRequest.includes("E2E_VP17_REMOTE_EXTRA_SKILL")).toBe(false);
      expect(currentRuntime()).toBeTruthy();
      expect(currentRuntime()).not.toBe(previousRuntime);
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP18-remote-cold.png"),
      );

      // VP25：远端留存 activeTaskId 不能让离开的行继续高亮；归档当前任务后必须退出正文。
      const taskRow = renamed.$(`[data-testid="${testId(TID_TASK_ITEM, remoteTaskId)}"]`);
      expect(await taskRow.getAttribute("class")).toContain("bg-selected");
      await $('[data-testid="task-new-button"]').click();
      await browser.waitUntil(
        async () => !(await taskRow.getAttribute("class"))?.includes("bg-selected"),
      );
      await taskRow.click();
      await $('//*[normalize-space(.)="E2E_VP18_READY" and not(*)]').waitForDisplayed();
      await taskRow.moveTo();
      const archive = taskRow.$(`[data-testid="${testId(TID_TASK_ARCHIVE, remoteTaskId)}"]`);
      await archive.click();
      if (
        (await taskRow.isExisting()) &&
        (await taskRow.getAttribute("data-archive-confirming-task-id")) === remoteTaskId
      )
        await archive.click();
      await taskRow.waitForExist({ reverse: true });
      await $('//*[normalize-space(.)="E2E_VP18_READY" and not(*)]').waitForDisplayed({
        reverse: true,
      });
      const archiveFacts = new DatabaseSync(join(serverHome, ".zcode/v2/tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          archiveFacts.prepare("SELECT archived FROM tasks WHERE task_id=?").get(remoteTaskId)
            ?.archived,
        ).toBe(1);
      } finally {
        archiveFacts.close();
      }

      await $('[data-project-name="ZCodeProject"]')
        .$('[data-testid="virtual-project-create-task"]')
        .click();
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
      await removeRemoteProjectEntryForRow('[data-project-name="E2E_VP08_URL_RENAMED"]');
      await renamed.waitForDisplayed({ reverse: true });
      const cliDb = new DatabaseSync(join(serverHome, ".zcode", "cli", "db", "db.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          cliDb.prepare("SELECT directory FROM session WHERE id=?").get(remoteTaskId)?.directory,
        ).toBe(join(serverHome, "work", "repo"));
        expect(
          Number(
            cliDb.prepare("SELECT count(*) AS n FROM message WHERE session_id=?").get(remoteTaskId)
              ?.n,
          ),
        ).toBeGreaterThanOrEqual(4);
      } finally {
        cliDb.close();
      }
    } finally {
      try {
        await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-final.png"));
        // 测试服务退出前回到本地，防止后续用例被已关闭 Source 的活动 tab 阻塞。
        await $('[data-project-name="ZCodeProject"]')
          .$('[data-testid="virtual-project-create-task"]')
          .click();
        await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
      } catch (error) {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-cleanup-error.log"),
          String(error),
        );
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await once(child, "exit");
        }
      }
      const factsDb = new DatabaseSync(join(serverHome, ".zcode/v2/tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-facts.json"),
          JSON.stringify(
            factsDb
              .prepare(
                "SELECT task_id,project_id,host_id,workspace_path,workspace_identity,cli_last_outcome FROM tasks",
              )
              .all(),
            null,
            2,
          ),
        );
      } finally {
        factsDb.close();
      }
      await writeFile(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-server.log"), output);
      if (process.env.DEEPSEEK_E2E_CAPTURE_PATH)
        await writeFile(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP17-network.json"),
          await readFile(process.env.DEEPSEEK_E2E_CAPTURE_PATH),
        );
    }
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("VP05：重复新建未归类草稿复用待发送目录，刷新后归属不变", async function () {
    this.timeout(60_000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    const readDraft = () =>
      browser.execute(() => {
        const bridge = window as Window & {
          __zcodeTabStoreE2E?: {
            getState(): {
              activeWorkspacePath: string | null;
              activeWorkspaceIdentity?: string | null;
            };
          };
          __zcodeSessionStoreE2E?: {
            getState(): {
              getWorkspaceState(
                path: string,
                identity?: string,
              ): { draftProjectId?: string | null; activeTaskId: string | null };
            };
          };
        };
        const tabs = bridge.__zcodeTabStoreE2E?.getState();
        const path = tabs?.activeWorkspacePath;
        const state = path
          ? bridge.__zcodeSessionStoreE2E
              ?.getState()
              .getWorkspaceState(path, tabs?.activeWorkspaceIdentity ?? undefined)
          : undefined;
        return { path, projectId: state?.draftProjectId, activeTaskId: state?.activeTaskId };
      });
    const before = await readDraft();
    // 左上角新建继承当前项目；任务分区加号才是显式未归类入口。
    const newTask = $('[data-testid="virtual-project-new-task"]');
    await newTask.click();
    await browser.waitUntil(async () => (await readDraft()).path !== before.path);
    const first = await readDraft();
    expect(first.projectId).toBeNull();
    expect(first.activeTaskId).toBeNull();
    await newTask.click();
    const second = await readDraft();
    expect(second.projectId).toBeNull();
    expect(second.activeTaskId).toBeNull();
    expect(second.path).toBe(first.path);
    const testHome = process.env.ZCODE_E2E_HOME_DIR!;
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await readFile(join(testHome, ".zcode/v2/setting.json"), "utf8"));
      return settings.lastActiveWorkspace?.workspacePath === second.path;
    });
    // 此场景使用内存登录夹具；刷新后沿已有真实 API key 入口恢复认证，再检查原目录。
    await refreshVirtualProjectWorkspace();
    await browser.waitUntil(async () => (await readDraft()).path === second.path, {
      timeout: 30_000,
    });
    expect((await readDraft()).projectId).toBeNull();
  });
  it("新建空项目、修改名称、软删除后从同 roots 新建恢复", async function () {
    this.timeout(120_000);
    await $('[data-testid="project-section"]').waitForDisplayed();
    await openLocalProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP04_Project");
    await $('[data-testid="virtual-project-save"]').click();
    const project = $('[data-project-name="E2E_VP04_Project"]');
    await project.waitForDisplayed();
    const projectId = await project.getAttribute("data-project-id");
    await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
    await $('[data-testid="virtual-project-edit"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP04_Renamed");
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-project-name="E2E_VP04_Renamed"]').waitForDisplayed();
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    const modalState = await browser.execute(() => ({
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      menus: document.querySelectorAll('[role="menu"]').length,
    }));
    console.info("[VP04] after project editor close", modalState);
    expect(modalState.bodyPointerEvents).not.toBe("none");
    await $('[data-project-name="E2E_VP04_Renamed"] [data-testid="virtual-project-row"]').click({
      button: "right",
    });
    // 从草稿新建项目会初始化主目录；恢复必须选回实际 roots，不能再次用空 roots 比较。
    const db = new DatabaseSync(
      join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
      { readOnly: true },
    );
    let restoreRoots: string[];
    try {
      restoreRoots = (
        db
          .prepare("SELECT root_path FROM project_roots WHERE project_id=? ORDER BY position")
          .all(projectId) as { root_path: string }[]
      ).map((row) => row.root_path);
    } finally {
      db.close();
    }
    expect(restoreRoots).toHaveLength(1);
    await $('[data-testid="virtual-project-delete"]').click();
    await $('[data-project-name="E2E_VP04_Renamed"]').waitForDisplayed({ reverse: true });
    await openLocalProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP04_Restored");
    for (const root of restoreRoots) await chooseProjectRoot(root);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="confirm-dialog-confirm"]').waitForClickable();
    await $('[data-testid="confirm-dialog-confirm"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForClickable();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const restored = $('[data-project-name="E2E_VP04_Restored"]');
    await restored.waitForDisplayed();
    expect(await restored.getAttribute("data-project-id")).toBe(projectId);
  });
  it("VP11：设置目录来自去重 roots，未打开的目录可以选择", async function () {
    this.timeout(90_000);
    const testHome = process.env.ZCODE_E2E_HOME_DIR!;
    if (
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(testHome).startsWith(prefix),
      )
    )
      throw new Error("隔离 HOME required");
    const roots = [join(testHome, "E2E_VP11_A"), join(testHome, "E2E_VP11_B")];
    await Promise.all(roots.map((path) => mkdir(path, { recursive: true })));
    for (const [name, paths] of [
      ["E2E_VP11_MULTI", roots],
      ["E2E_VP11_SHARED", roots.slice(0, 1)],
    ] as const) {
      await openLocalProjectEditor();
      await $('[data-testid="virtual-project-name"]').setValue(name);
      for (const path of paths) {
        await chooseProjectRoot(path);
      }
      await $('[data-testid="virtual-project-save"]').click();
      await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
      await $('[data-testid="project-folder-trust-confirm"]').click();
      await $(`[data-project-name="${name}"]`).waitForDisplayed();
    }
    const workspacePaths = () =>
      browser.execute(() => {
        const store = (
          window as Window & {
            __zcodeTabStoreE2E?: { getState(): { tabs: Array<{ workspacePath?: string }> } };
          }
        ).__zcodeTabStoreE2E;
        return (
          store
            ?.getState()
            .tabs.map((tab) => tab.workspacePath)
            .filter(Boolean) ?? []
        );
      });
    // 创建时可能打开主要 root A；目录选择用 root B 验证不隐式打开 tab。
    expect(await workspacePaths()).not.toContain(roots[1]);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    try {
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "commands"));
      const scope = $('[data-testid="plugin-settings-scope-trigger"]');
      await scope.waitForDisplayed();
      await scope.click();
      // 项目在「本机」的「项目」子菜单里（19 号票）。
      await openScopeProjectSubmenu("local");
      for (const root of roots) {
        const selector = `[data-testid="${testId("plugin-settings-scope-option", root)}"]`;
        await $(selector).waitForDisplayed();
        expect(await $$(selector).length).toBe(1);
      }
      await $(`[data-testid="${testId("plugin-settings-scope-option", roots[1]!)}"]`).click();
      expect(await scope.getAttribute("data-plugin-scope-key")).toBe(roots[1]);
      expect(await workspacePaths()).not.toContain(roots[1]);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "hooks"));
      const hooksScope = $('[data-plugin-scope-trigger="true"]');
      await hooksScope.waitForDisplayed();
      await hooksScope.click();
      await openScopeProjectSubmenu("local");
      let labels: string[] = [];
      await browser.waitUntil(
        async () => {
          const choices = await $$('[role="menuitemradio"]');
          labels = await choices.map((choice) => choice.getText());
          // Bug 原因：菜单动画期间 getText 可部分为空，不能只等最后一个 root。
          return ["E2E_VP11_A", "E2E_VP11_B"].every((root) =>
            labels.some((label) => label.includes(root)),
          );
        },
        { timeout: 10_000, timeoutMsg: "Hooks 目录菜单尚未显示 root 选项" },
      );
      expect(labels.filter((label) => label.includes("E2E_VP11_A"))).toHaveLength(1);
      expect(labels.filter((label) => label.includes("E2E_VP11_B"))).toHaveLength(1);
      await browser.keys("Escape");
    } finally {
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    }
  });
  it("VP10：定时表单选择空 roots 虚拟项目，选项不依赖打开目录", async function () {
    this.timeout(90_000);
    for (const name of ["E2E_VP10_A", "E2E_VP10_B"]) {
      await openLocalProjectEditor();
      await $('[data-testid="virtual-project-name"]').setValue(name);
      await $('[data-testid="virtual-project-save"]').click();
      await $(`[data-project-name="${name}"]`).waitForDisplayed();
    }
    await browser.execute(() => {
      const state = window as Window & { __vpErrors?: string[] };
      state.__vpErrors = [];
      window.addEventListener("error", (event) =>
        state.__vpErrors?.push(event.error?.stack ?? event.message),
      );
      window.addEventListener("unhandledrejection", (event) =>
        state.__vpErrors?.push(String(event.reason?.stack ?? event.reason)),
      );
    });
    await $(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`).click();
    try {
      await $(`[data-testid="${TID_AUTOMATION_CREATE_MENU}"]`).waitForDisplayed();
    } catch (error) {
      const diagnostics = await browser.execute(() => ({
        errors: (window as Window & { __vpErrors?: string[] }).__vpErrors,
        body: document.body.innerText.slice(0, 6000),
      }));
      throw new Error(`Automations open failed: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    await $(`[data-testid="${TID_AUTOMATION_CREATE_MENU}"]`).click();
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY);
    const select = $('[data-testid="automation-project-select"]');
    await select.waitForDisplayed();
    await select.click();
    const second = $('[role="option"][data-project-name="E2E_VP10_B"]');
    await second.waitForDisplayed();
    const secondId = await second.getAttribute("data-project-id");
    await second.click();
    expect(await select.getText()).toContain("E2E_VP10_B");
    await select.click();
    expect(
      await $(`[role="option"][data-project-id="${secondId}"]`).getAttribute("data-state"),
    ).toBe("checked");
    await browser.keys("Escape");
    await $(`[data-testid="${TID_AUTOMATION_FORM_TITLE}"]`).setValue("E2E_VP10_SCHEDULE");
    await $(`[data-testid="${TID_AUTOMATION_FORM_PROMPT}"]`).setValue("Inspect the project");
    await $(`[data-testid="${TID_AUTOMATION_SCHEDULE_ADD}"]`).click();
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"));
    await browser.waitUntil(
      async () => await $(`[data-testid="${TID_AUTOMATION_FORM_SUBMIT}"]`).isEnabled(),
      { timeout: 15_000 },
    );
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT);
    await $(`[data-testid="${TID_AUTOMATIONS_LIST}"]`).waitForDisplayed({ timeout: 15_000 });
    const testHome = process.env.ZCODE_E2E_HOME_DIR;
    if (!testHome) throw new Error("isolated E2E HOME required");
    const db = new DatabaseSync(join(testHome, ".zcode", "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT project_id,host_id,workspace_path,additional_directories FROM automations WHERE title=?",
        )
        .get("E2E_VP10_SCHEDULE");
      expect(row).toMatchObject({
        project_id: secondId,
        host_id: "local",
        additional_directories: "[]",
      });
      const root = db
        .prepare("SELECT root_path FROM project_roots WHERE project_id=? AND is_primary=1")
        .get(secondId);
      expect(row?.workspace_path).toBe(root?.root_path);
      expect(String(row?.workspace_path).startsWith(join(testHome, ".zcode", "workspace"))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });
});

async function openLocalProjectEditor() {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}
async function chooseProjectRoot(path: string) {
  await selectNativeProjectDirectories([path]);
}

async function captureProjectDialogLayouts(stage: string) {
  const original = await browser.execute(() => {
    const actions = (window as typeof window & { __testActions?: { getTheme(): string } })
      .__testActions;
    if (!actions) throw new Error("缺少主题测试入口");
    return { width: innerWidth, theme: actions.getTheme() };
  });
  const setTheme = async (theme: string) => {
    await browser.execute((value) => {
      const actions = (
        window as typeof window & { __testActions?: { setTheme(value: string): void } }
      ).__testActions;
      if (!actions) throw new Error("缺少主题测试入口");
      actions.setTheme(value);
    }, theme);
    await browser.waitUntil(() =>
      browser.execute(
        (value) => document.documentElement.classList.contains(`theme-${value}`),
        theme,
      ),
    );
  };
  const emulate = async (width?: number) =>
    browser.electron.execute(async (electron, width) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) throw new Error("No visible renderer");
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
        width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
      );
    }, width);
  try {
    for (const width of [1200, 390]) {
      // 只验证共享组件的响应式布局；真实手机 shared-host 流程仍由 VP13 单独验证。
      await emulate(width);
      await browser.waitUntil(() => browser.execute((expected) => innerWidth === expected, width));
      for (const dark of [false, true]) {
        await setTheme(dark ? "zai-dark" : "zai-light");
        const fit = await browser.execute(() => {
          const dialog = document.querySelector('[role="dialog"]')!;
          const bounds = dialog.getBoundingClientRect();
          const input = dialog.querySelector("input");
          return {
            left: bounds.left,
            right: bounds.right,
            width: innerWidth,
            inputSize: input ? Number.parseFloat(getComputedStyle(input).fontSize) : null,
          };
        });
        expect(fit.left).toBeGreaterThanOrEqual(0);
        expect(fit.right).toBeLessThanOrEqual(fit.width);
        if (width === 390 && fit.inputSize !== null)
          expect(fit.inputSize).toBeGreaterThanOrEqual(16);
        await browser.saveScreenshot(
          join(
            process.env.ZCODE_E2E_ARTIFACT_DIR!,
            `VP19-${stage}-${width}-${dark ? "dark" : "light"}.png`,
          ),
        );
      }
    }
  } finally {
    await emulate();
    await browser.waitUntil(() =>
      browser.execute((expected) => innerWidth === expected, original.width),
    );
    await setTheme(original.theme);
  }
}

async function refreshVirtualProjectWorkspace() {
  await browser.refresh();
  const login = $('[data-testid="login-use-api-key-button"]');
  await browser.waitUntil(
    async () =>
      (await login.isDisplayed()) || (await $('[data-testid="project-section"]').isDisplayed()),
    { timeout: 45_000 },
  );
  if (await login.isDisplayed()) await loginWithApiKey();
  await $('[data-testid="project-section"]').waitForDisplayed({ timeout: 30_000 });
}

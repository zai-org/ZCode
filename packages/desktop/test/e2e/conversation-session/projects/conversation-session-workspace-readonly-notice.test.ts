import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const PROJECT = '[data-project-name="E2E_READONLY_NOTICE"]';
const HISTORY_ID = "sess_e2e_readonly_notice_history";
const HISTORY_BODY = "E2E_READONLY_NOTICE_HISTORY_BODY";
const NOTICE = '[data-testid="v4-workspace-readonly-notice"]';
const COPY = {
  "zh-CN":
    "工作区目录不存在或无法访问，当前仅可查看历史记录。恢复该目录后重启 ZCode 即可继续使用。",
  "en-US":
    "The workspace directory does not exist or cannot be accessed. You can only view history for now. Restore the directory and restart ZCode to continue.",
};
type TestWindow = Window & {
  __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
};

describe("VP-ROOT-02：目录失效时的会话输入区提示", () => {
  it("冷启动只读历史在原输入区说明原因，目录恢复并重启后恢复输入", async function () {
    this.timeout(240_000);
    const artifact = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "readonly-notice");
    const primary = join(root, "primary");
    const moved = join(root, "moved");
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => (window as TestWindow).__testActions!.setLocale("zh-CN"));
    await mkdir(primary, { recursive: true });
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_READONLY_NOTICE");
    await selectNativeProjectDirectories([primary]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $(PROJECT).waitForDisplayed();
    await $(PROJECT).$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(primary, 30_000);
    // 两库夹具只在旧 Main/Host/Agent 完整退出后写入，再经 UI 打开真实持久历史。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: () => seedHistory(primary),
    });
    await openHistory();
    await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).waitForDisplayed({ timeout: 30_000 });
    expect(await $(NOTICE).isExisting()).toBe(false);
    await browser.saveScreenshot(join(artifact, "readonly-notice-before.png"));
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: () => rename(primary, moved),
    });
    await $(PROJECT).waitForDisplayed({ timeout: 45_000 });
    // 启动仍进入可输入的无项目草稿，目录提示只属于用户随后打开的旧会话。
    await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).waitForDisplayed({ timeout: 30_000 });
    expect(await $(NOTICE).isExisting()).toBe(false);
    await openHistory();
    await browser.saveScreenshot(join(artifact, "readonly-notice-history-opened.png"));
    await $(NOTICE).waitForDisplayed({ timeout: 10_000 });
    expect(await $(NOTICE).getAttribute("role")).toBe("status");
    await expect(stat(primary)).rejects.toMatchObject({ code: "ENOENT" });
    const measurements: unknown[] = [];
    let sidebarCollapsed = false;
    try {
      for (const width of [1200, 390]) {
        if (width === 390) {
          // 先收起再缩窄，避免 resize 自动收起与 UI toggle 交错；不改桌面壳的最小宽度。
          if ((await $("#sidebar > aside").getAttribute("aria-hidden")) !== "true") {
            await $('button[aria-label="Toggle sidebar"]').click();
          }
          sidebarCollapsed = true;
          await browser.waitUntil(() =>
            browser.execute(() => {
              const panel = document.querySelector("#sidebar")!;
              return (
                panel.querySelector("aside")!.getAttribute("aria-hidden") === "true" &&
                panel.getAnimations().every((item) => item.playState !== "running")
              );
            }),
          );
        }
        await emulateViewport(width);
        for (const theme of ["zai-light", "zai-dark"]) {
          for (const locale of ["zh-CN", "en-US"] as const) {
            await browser.execute(
              ({ theme, locale }) => {
                (window as TestWindow).__testActions!.setTheme(theme);
                (window as TestWindow).__testActions!.setLocale(locale);
              },
              { theme, locale },
            );
            await expect($(NOTICE)).toHaveText(COPY[locale]);
            await assertReadOnlyHistory();
            const bounds = await browser.execute((selector) => {
              const notice = document.querySelector<HTMLElement>(selector)!;
              const pane = notice.closest('[data-testid="v4-session-pane-workspace-main"]')!;
              const rect = notice.getBoundingClientRect();
              const paneRect = pane.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                paneTop: paneRect.top,
                paneBottom: paneRect.bottom,
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
                scrollWidth: notice.scrollWidth,
                clientWidth: notice.clientWidth,
              };
            }, NOTICE);
            measurements.push({ width, theme, locale, ...bounds });
            await writeFile(
              join(artifact, "readonly-notice-layout.json"),
              JSON.stringify(measurements, null, 2),
            );
            await browser.saveScreenshot(
              join(artifact, `readonly-notice-${width}-${theme}-${locale}.png`),
            );
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
            expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
            expect(bounds.top).toBeGreaterThan((bounds.paneTop + bounds.paneBottom) / 2);
            expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
          }
        }
      }
    } finally {
      await emulateViewport();
      if (sidebarCollapsed) {
        await browser.execute(() => (window as TestWindow).__testActions!.setLocale("en-US"));
        await $('button[aria-label="Toggle sidebar"]').click();
      }
      await browser.execute(() => {
        (window as TestWindow).__testActions!.setTheme("system");
        (window as TestWindow).__testActions!.setLocale("zh-CN");
      });
    }
    await rename(moved, primary);
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await browser.waitUntil(
      async () => (await $(PROJECT).getAttribute("data-primary-root-status")) === "available",
    );
    // 侧栏目录刷新不改变既有 tab 只读状态；本次仅补提示，不新增自动恢复。
    await assertReadOnlyHistory();
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await openHistory();
    await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).waitForDisplayed({ timeout: 30_000 });
    expect(await $(NOTICE).isExisting()).toBe(false);
    await browser.saveScreenshot(join(artifact, "readonly-notice-restored.png"));
    // 隔离 HOME 的清理归 runner，不能删除仍被当前 Main/Host 使用的目录。
  });
});

async function openHistory() {
  const toggle = $(PROJECT).$('[data-testid="virtual-project-toggle"]');
  await toggle.waitForDisplayed({ timeout: 45_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const history = $(PROJECT).$(`[data-testid="task-item-${HISTORY_ID}"]`);
  await history.waitForDisplayed({ timeout: 30_000 });
  await history.click();
  await $(`//*[normalize-space(.)="${HISTORY_BODY}" and not(*)]`).waitForDisplayed({
    timeout: 30_000,
  });
}

async function assertReadOnlyHistory() {
  expect(await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).isExisting()).toBe(false);
  expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isExisting()).toBe(false);
  expect(await $(NOTICE).isDisplayed()).toBe(true);
  expect(await $(`//*[normalize-space(.)="${HISTORY_BODY}" and not(*)]`).isDisplayed()).toBe(true);
}

async function emulateViewport(width?: number) {
  await browser.electron.execute(async (electron, width) => {
    const appWindow = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible())!;
    if (!appWindow.webContents.debugger.isAttached()) appWindow.webContents.debugger.attach("1.3");
    await appWindow.webContents.debugger.sendCommand(
      width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
      width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
    );
  }, width);
  if (width) {
    await browser.waitUntil(() =>
      browser.execute((expected) => {
        const sidebar = document.querySelector('[data-workspace-sidebar-panel="true"]');
        return (
          innerWidth === expected &&
          (sidebar?.getAnimations().every((item) => item.playState !== "running") ?? true)
        );
      }, width),
    );
  }
}

function seedHistory(workspacePath: string) {
  // 只写 runner 的隔离 HOME；复用真实 Host/CLI 两库数据合同，不 mock 消息或目录状态。
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home || !DEFAULT_WORKSPACE.startsWith(home)) throw new Error("isolated HOME required");
  const app = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
  const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
  try {
    const projectId = app
      .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
      .get(workspacePath)?.project_id;
    if (typeof projectId !== "string") throw new Error("fixture project missing");
    const now = Date.now();
    cli
      .prepare(
        "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
      )
      .run(
        HISTORY_ID,
        "e2e-primary-history",
        HISTORY_ID,
        workspacePath,
        "E2E_READONLY_HISTORY",
        now,
        now,
      );
    cli
      .prepare(
        "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,0)",
      )
      .run(
        `${HISTORY_ID}_message`,
        HISTORY_ID,
        now,
        now,
        JSON.stringify({ role: "user", time: { created: now }, agent: "build" }),
      );
    cli
      .prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?,0)",
      )
      .run(
        `${HISTORY_ID}_part`,
        `${HISTORY_ID}_message`,
        HISTORY_ID,
        now,
        now,
        JSON.stringify({ type: "text", text: HISTORY_BODY }),
      );
    app
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,mode,created_at,updated_at,host_id,root_path,project_id,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm','default',?,?,'local',?,?,?,'custom',?,?,'completed',0,?)",
      )
      .run(
        workspacePath,
        workspacePath,
        HISTORY_ID,
        "E2E_READONLY_HISTORY",
        now,
        now,
        workspacePath,
        projectId,
        "E2E_READONLY_HISTORY",
        now,
        now,
        JSON.stringify({
          taskId: HISTORY_ID,
          traceId: HISTORY_ID,
          title: "E2E_READONLY_HISTORY",
          workspacePath,
          createdAt: now,
          updatedAt: now,
          mode: "build",
        }),
      );
  } finally {
    cli.close();
    app.close();
  }
}

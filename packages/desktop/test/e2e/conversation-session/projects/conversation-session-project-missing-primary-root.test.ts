import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

const PROJECT = '[data-project-name="E2E_MISSING_PRIMARY"]';
const SINGLE_PROJECT = '[data-project-name="E2E_SINGLE_PRIMARY"]';
const HISTORY_ID = "sess_e2e_missing_primary_history";
const HISTORY_BODY = "E2E_MISSING_PRIMARY_HISTORY_BODY";
const REASON = "该项目主文件夹已被删除或移动";
type TestWindow = Window & {
  __testActions?: { setLocale(locale: "zh-CN" | "en-US"): void; setTheme(theme: string): void };
  __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(path: string): {
        activeTaskId: string | null;
        draftProjectId?: string | null;
        draftFocusVersion: number;
      };
    };
  };
};

describe("项目主目录失效", () => {
  it("VP-ROOT-01：移走主目录仍可展开历史但禁用新建与查看文件，恢复后重新可用", async function () {
    if (process.platform === "win32") {
      // 暂时跳过原因：Agent 进程以主目录为 cwd 常驻，Windows 不允许重命名任一进程的 cwd
      // 目录（rename 报 EBUSY），本例“运行中移走主目录”的前置条件在 Windows 上无法构造。
      // 是否调整 Agent cwd 策略待产品决策，见 docs/conversation-session-case-catalog.md VP-ROOT-01。
      this.skip();
    }
    this.timeout(150_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await browser.execute(() => (window as TestWindow).__testActions!.setLocale("zh-CN"));
    const root = join(DEFAULT_WORKSPACE, ".zcode-e2e", "missing-primary");
    const primary = join(root, "primary");
    const extra = join(root, "extra");
    const moved = join(root, "moved");
    const singlePrimary = join(root, "single-primary");
    const singleMoved = join(root, "single-moved");
    await Promise.all([mkdir(primary, { recursive: true }), mkdir(extra, { recursive: true })]);
    await mkdir(singlePrimary, { recursive: true });
    await openEditor("E2E_MISSING_PRIMARY");
    await chooseRoot(primary);
    await chooseRoot(extra);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    let project = $(PROJECT);
    await project.waitForDisplayed();
    let toggle = project.$('[data-testid="virtual-project-toggle"]');
    expect(await toggle.isEnabled()).toBe(true);
    expect(await project.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(true);
    await openEditor("E2E_SINGLE_PRIMARY");
    await chooseRoot(singlePrimary);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    let single = $(SINGLE_PROJECT);
    await single.waitForDisplayed();
    expect(await single.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(true);
    // 先回到本例要验证的主项目再冷启动准备历史；不让第二个对照项目的空草稿决定恢复目标。
    await project.$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(primary, 30_000);
    // PCD01 创建后会自动选择项目并准备目录；零 root 对照必须是从未进入的持久项目。
    // 同时在 Host 退出后写历史，两库准备完成再冷启，不能写运行中的索引假装快照已刷新。
    await restartIntoWorkspacePreservingProfile(primary, {
      afterElectronProcessExit: async () => {
        seedHistory(primary);
        const db = new DatabaseSync(
          join(process.env.ZCODE_E2E_HOME_DIR!, ".zcode/v2/tasks-index.sqlite"),
        );
        try {
          db.prepare(
            "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at) VALUES('e2e-empty-primary','local','E2E_EMPTY_PRIMARY',20,1,1)",
          ).run();
        } finally {
          db.close();
        }
      },
    });
    // WebDriver 元素绑定旧 session；完整重启后必须从新 renderer 重新取得引用。
    project = $(PROJECT);
    single = $(SINGLE_PROJECT);
    toggle = project.$('[data-testid="virtual-project-toggle"]');
    const empty = $('[data-project-name="E2E_EMPTY_PRIMARY"]');
    await empty.waitForDisplayed();
    const readActive = () =>
      browser.execute(
        () => (window as TestWindow).__zcodeTabStoreE2E!.getState().activeWorkspacePath,
      );
    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    const activeBefore = await readActive();
    try {
      // 真实文件系统变更后触发窗口 focus；不注入 availability 或替换项目服务结果。
      await rename(primary, moved);
      await rename(singlePrimary, singleMoved);
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => (await project.getAttribute("data-primary-root-status")) === "missing",
        {
          timeout: 15_000,
          timeoutMsg: "主目录移走后未更新目录状态",
        },
      );
      await project.moveTo();
      const create = project.$('[data-testid="virtual-project-create-task"]');
      expect(await create.isEnabled()).toBe(false);
      const files = project.$('[data-testid="virtual-project-files"]');
      const singleFiles = single.$('[data-testid="virtual-project-files"]');
      expect(await files.isEnabled()).toBe(false);
      expect(await singleFiles.isEnabled()).toBe(false);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await toggle.isEnabled()).toBe(true);
      expect(await toggle.getAttribute("aria-disabled")).toBe("false");
      expect(await empty.$('[data-testid="virtual-project-toggle"]').isEnabled()).toBe(true);
      expect(await empty.$('[data-testid="virtual-project-create-task"]').isEnabled()).toBe(true);
      expect(await empty.$('[data-testid="virtual-project-files"]').isEnabled()).toBe(false);
      for (const theme of ["zai-dark", "zai-light"]) {
        await browser.execute(
          (value) => (window as TestWindow).__testActions!.setTheme(value),
          theme,
        );
        await leaveTooltip();
        await toggle.parentElement().moveTo();
        await expectNoReason();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-${theme}.png`),
        );
        await leaveTooltip();
        await create.parentElement().moveTo({ xOffset: -2 });
        await create.parentElement().moveTo({ xOffset: 2 });
        await waitForReason();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-create-${theme}.png`),
        );
        for (const [name, button] of [
          ["multi", files],
          ["single", singleFiles],
        ] as const) {
          await leaveTooltip();
          await button.parentElement().moveTo({ xOffset: -2 });
          await button.parentElement().moveTo({ xOffset: 2 });
          await waitForReason();
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-files-${name}-${theme}.png`),
          );
          await browser.execute(
            (selector) => {
              document
                .querySelector<HTMLButtonElement>(
                  `${selector} [data-testid="virtual-project-files"]`,
                )!
                .click();
            },
            name === "multi" ? PROJECT : SINGLE_PROJECT,
          );
          expect(await $('[data-testid="virtual-project-files-0"]').isExisting()).toBe(false);
          expect(await project.isDisplayed()).toBe(true);
          expect(await readActive()).toBe(activeBefore);
        }
      }
      // 目录失效阻止新建和文件入口；标题仍通过原折叠状态打开真实历史。
      await browser.execute((selector) => {
        document
          .querySelector<HTMLButtonElement>(
            `${selector} [data-testid="virtual-project-create-task"]`,
          )!
          .click();
      }, PROJECT);
      expect(await readActive()).toBe(activeBefore);
      await toggle.click();
      const history = project.$(`[data-testid="task-item-${HISTORY_ID}"]`);
      await history.waitForDisplayed();
      await toggle.click();
      await history.waitForDisplayed({ reverse: true });
      await browser.execute((selector) => {
        document
          .querySelector<HTMLElement>(`${selector} [data-testid="virtual-project-toggle"]`)!
          .focus();
      }, PROJECT);
      await browser.keys("Enter");
      await history.waitForDisplayed();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await history.click();
      await $(`//*[normalize-space(.)="${HISTORY_BODY}" and not(*)]`).waitForDisplayed({
        timeout: 30_000,
      });
      expect(await create.isEnabled()).toBe(false);
      await expect(stat(primary)).rejects.toMatchObject({ code: "ENOENT" });
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "missing-primary-history.png"),
      );
      // 旧 E2E 只验证项目行禁用；顶部按钮和原生菜单仍会请求创建，必须独立断言可见失败反馈。
      const beforeNewTask = await readTaskState(primary);
      for (const locale of ["zh-CN", "en-US"] as const) {
        await browser.execute(
          (value) => (window as TestWindow).__testActions!.setLocale(value),
          locale,
        );
        const reason =
          locale === "zh-CN" ? REASON : "This project's main folder has been deleted or moved";
        for (const theme of ["zai-dark", "zai-light"]) {
          await browser.execute(
            (value) => (window as TestWindow).__testActions!.setTheme(value),
            theme,
          );
          for (const action of ["button", "shortcut"] as const) {
            await waitForNewTaskToastToClose();
            if (action === "button") await $('[data-testid="task-new-button"]').click();
            else await invokeNewTaskShortcut();
            await browser.waitUntil(
              async () => (await $("#zcode-toast-host").getText()).includes(reason),
              {
                timeout: 5_000,
                timeoutMsg: `VP-ROOT-03 ${locale}/${theme}/${action} 未显示目录失效提示`,
              },
            );
            expect(await readTaskState(primary)).toEqual(beforeNewTask);
            await expect(stat(primary)).rejects.toMatchObject({ code: "ENOENT" });
            await browser.saveScreenshot(
              join(
                process.env.ZCODE_E2E_ARTIFACT_DIR!,
                `missing-primary-new-task-${locale}-${theme}-${action}.png`,
              ),
            );
          }
        }
      }
      await waitForNewTaskToastToClose();
      await browser.execute(() => (window as TestWindow).__testActions!.setLocale("zh-CN"));
      await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      const contextCreate = $('[data-testid="virtual-project-context-create-task"]');
      await contextCreate.waitForDisplayed();
      expect(await contextCreate.getAttribute("aria-disabled")).toBe("true");
      for (const index of [0, 1]) {
        expect(
          await $(`[data-testid="virtual-project-context-files-${index}"]`).getAttribute(
            "aria-disabled",
          ),
        ).toBe("true");
      }
      await browser.keys("Escape");
      await single.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      await $('[data-testid="virtual-project-context-files-0"]').waitForDisplayed();
      expect(
        await $('[data-testid="virtual-project-context-files-0"]').getAttribute("aria-disabled"),
      ).toBe("true");
      await browser.keys("Escape");
      await project.moveTo();
      await project.$('[data-testid="virtual-project-menu"]').click();
      await $('[data-testid="virtual-project-edit"]').click();
      await $('[data-testid="virtual-project-name"]').waitForDisplayed();
      await browser.keys("Escape");
      await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
      await browser.refresh();
      await $(PROJECT).waitForDisplayed({ timeout: 45_000 });
      expect(await $(PROJECT).$('[data-testid="virtual-project-toggle"]').isEnabled()).toBe(true);
      expect(await $(PROJECT).getAttribute("data-primary-root-status")).toBe("missing");
      expect(await $(PROJECT).$('[data-testid="virtual-project-files"]').isEnabled()).toBe(false);
      await rename(moved, primary);
      await rename(singleMoved, singlePrimary);
      await rm(extra, { recursive: true });
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => $(PROJECT).$('[data-testid="virtual-project-create-task"]').isEnabled(),
        {
          timeout: 15_000,
          timeoutMsg: "主目录恢复后项目仍被禁用",
        },
      );
      await $(PROJECT).moveTo();
      const recoveredCreate = $(PROJECT).$('[data-testid="virtual-project-create-task"]');
      expect(await recoveredCreate.isEnabled()).toBe(true);
      expect(await $(PROJECT).$('[data-testid="virtual-project-files"]').isEnabled()).toBe(true);
      expect(await $(SINGLE_PROJECT).$('[data-testid="virtual-project-files"]').isEnabled()).toBe(
        true,
      );
      await recoveredCreate.click();
      await waitForWorkspaceApp(primary, 30_000);
      for (const action of ["button", "shortcut"] as const) {
        const before = await readTaskState(primary);
        if (action === "button") await $('[data-testid="task-new-button"]').click();
        else await invokeNewTaskShortcut();
        await browser.waitUntil(async () => (await readTaskState(primary)).focus > before.focus);
        expect((await readTaskState(primary)).task).toBeNull();
        expect((await readTaskState(primary)).project).toBe(beforeNewTask.project);
        expect(await readActive()).toBe(primary);
      }
      await rename(primary, moved);
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await browser.waitUntil(
        async () => (await $(PROJECT).getAttribute("data-primary-root-status")) === "missing",
      );
      expect(await toggle.isEnabled()).toBe(true);
      // 共享侧栏的窄布局检查，不把设备尺寸模拟计为实际手机 shared-host 链路覆盖。
      await emulateViewport(390);
      await browser.waitUntil(() => browser.execute(() => innerWidth === 390));
      // 窄布局会自动收起侧栏；通过原切换入口展开后，再验证标题和提示布局。
      await browser.waitUntil(() =>
        browser.execute(() =>
          document
            .querySelector('[data-workspace-sidebar-panel="true"]')!
            .classList.contains("pointer-events-none"),
        ),
      );
      await browser.execute(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="切换侧边栏"]')!.click(),
      );
      await browser.waitUntil(() =>
        browser.execute(() => {
          const panel = document.querySelector('[data-workspace-sidebar-panel="true"]')!;
          return (
            panel.getBoundingClientRect().width > 30 &&
            panel.getAnimations().every((animation) => animation.playState !== "running")
          );
        }),
      );
      for (const theme of ["zai-dark", "zai-light"]) {
        await browser.execute(
          (value) => (window as TestWindow).__testActions!.setTheme(value),
          theme,
        );
        for (const testId of [
          "virtual-project-toggle",
          "virtual-project-create-task",
          "virtual-project-files",
        ]) {
          await browser.keys("Escape");
          await browser.waitUntil(() =>
            browser.execute(() => !document.querySelector('[data-slot="tooltip-content"]')),
          );
          // CDP 尺寸模拟后 WebDriver 的指针坐标仍受原生窗口缩放影响；直接发送 CSS 视口坐标。
          const point = await browser.execute(
            ({ selector, testId }) => {
              const rect = document
                .querySelector(`${selector} [data-testid="${testId}"]`)!
                .parentElement!.getBoundingClientRect();
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            },
            { selector: PROJECT, testId },
          );
          await browser.electron.execute(async (electron, point) => {
            const window = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible())!;
            for (const offset of [-2, 0])
              await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: point.x + offset,
                y: point.y,
                buttons: 0,
                pointerType: "mouse",
              });
          }, point);
          if (testId === "virtual-project-toggle") {
            await expectNoReason();
            continue;
          }
          await waitForReason();
          const bounds = await browser.execute((selector) => {
            const row = document
              .querySelector(`${selector} [data-testid="virtual-project-row"]`)!
              .getBoundingClientRect();
            const hint = document
              .querySelector('[data-slot="tooltip-content"]:not([data-state="closed"])')!
              .getBoundingClientRect();
            return { rowRight: row.right, hintLeft: hint.left, hintRight: hint.right };
          }, PROJECT);
          expect(bounds.rowRight).toBeLessThanOrEqual(390);
          expect(bounds.hintLeft).toBeGreaterThanOrEqual(0);
          expect(bounds.hintRight).toBeLessThanOrEqual(390);
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `missing-primary-390-${testId}-${theme}.png`),
          );
        }
      }
    } finally {
      // 不删除已成为活动 cwd 的主目录；runner 回收整个隔离 HOME。
      await emulateViewport();
      await browser.execute(() => (window as TestWindow).__testActions!.setTheme("system"));
    }
  });
});

async function readTaskState(path: string) {
  return browser.execute((path) => {
    const state = (window as TestWindow).__zcodeSessionStoreE2E!.getState().getWorkspaceState(path);
    return {
      task: state.activeTaskId,
      project: state.draftProjectId,
      focus: state.draftFocusVersion,
    };
  }, path);
}

async function waitForNewTaskToastToClose() {
  await browser.waitUntil(
    () => browser.execute(() => !document.getElementById("zcode-toast-host")?.textContent?.trim()),
    { timeout: 5_000 },
  );
}

async function invokeNewTaskShortcut() {
  const url = await browser.getUrl();
  await browser.electron.execute((electron, url) => {
    const window = electron.BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.getURL() === url,
    );
    if (!window) throw new Error("Missing new-task shortcut window");
    window.focus();
    const item = electron.Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((entry) => entry.accelerator === "CmdOrCtrl+N");
    if (!item) throw new Error("Missing CmdOrCtrl+N binding");
    // WebDriver DOM 按键不经过系统菜单；验证真实 accelerator 绑定并执行相同命令。
    item.click(undefined as never, window, undefined as never);
  }, url);
}

async function emulateViewport(width?: number) {
  await browser.electron.execute(async (electron, width) => {
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
}

async function openEditor(name: string) {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').setValue(name);
}

async function chooseRoot(path: string) {
  await selectNativeProjectDirectories([path]);
}

async function expectNoReason() {
  // 负向 hover 断言需停留超过 Tooltip 延迟，防止在提示尚未打开时误判通过。
  await browser.pause(1_000);
  const hints = await browser.execute(() =>
    [...document.querySelectorAll('[data-slot="tooltip-content"]:not([data-state="closed"])')].map(
      (element) => element.textContent,
    ),
  );
  expect(hints.some((text) => text?.includes(REASON))).toBe(false);
}

async function waitForReason() {
  // 同文案提示切换时旧节点会保留到退出动画结束；只验收已展开、动画完成的可见提示。
  // Radix 的 role=tooltip 是裁剪的读屏副本，用户可见文字在 tooltip-content。
  await browser
    .waitUntil(() =>
      browser.execute((reason) => {
        const hint = document.querySelector<HTMLElement>(
          '[data-slot="tooltip-content"]:not([data-state="closed"])',
        );
        return Boolean(
          hint?.textContent?.includes(reason) &&
          Number(getComputedStyle(hint).opacity) === 1 &&
          hint.getAnimations().every((animation) => animation.playState !== "running"),
        );
      }, REASON),
    )
    .catch(async (error) => {
      const state = await browser.execute(
        (selector) => ({
          hints: [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((el) => ({
            html: el.outerHTML,
            opacity: getComputedStyle(el).opacity,
          })),
          hovered: [...document.querySelectorAll(":hover")]
            .slice(-6)
            .map((el) => el.outerHTML.slice(0, 500)),
          trigger: document.querySelector(`${selector} [data-testid="virtual-project-create-task"]`)
            ?.parentElement?.outerHTML,
        }),
        PROJECT,
      );
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "tooltip-failure.png"),
      );
      throw new Error(JSON.stringify(state), { cause: error });
    });
}

async function leaveTooltip() {
  // 关闭上一提示并移出，再独立验证下个入口的 hover，避免同文案旧提示造成假阳性。
  if (await $('[data-slot="tooltip-content"]').isExisting()) await browser.keys("Escape");
  await $(
    '[data-project-name="E2E_EMPTY_PRIMARY"] [data-testid="virtual-project-toggle"]',
  ).moveTo();
  await browser.waitUntil(async () => !(await $('[data-slot="tooltip-content"]').isExisting()));
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
        "E2E_PRIMARY_HISTORY",
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
        "E2E_PRIMARY_HISTORY",
        now,
        now,
        workspacePath,
        projectId,
        "E2E_PRIMARY_HISTORY",
        now,
        now,
        JSON.stringify({
          taskId: HISTORY_ID,
          traceId: HISTORY_ID,
          title: "E2E_PRIMARY_HISTORY",
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

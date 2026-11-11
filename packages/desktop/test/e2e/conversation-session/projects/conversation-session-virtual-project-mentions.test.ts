import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import {
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_TASK_ITEM,
  TID_CONFIRM_DIALOG_CONFIRM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
  DEFAULT_WORKSPACE,
} from "#e2e/helpers/desktop-app";

describe("虚拟项目 Composer 候选", () => {
  after(async () => {
    await clearAppData();
  });
  it("VP14：多 root 文件分别可选，# 在全局草稿显示已有项目任务", async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const home = process.env.ZCODE_E2E_HOME_DIR!;
    // 同时接受统一 runner 与旧手工入口的隔离 HOME，禁止写入日常用户目录。
    if (
      !home ||
      ![".e2e-home-", "zcode-virtual-project-e2e-"].some((prefix) =>
        basename(home).startsWith(prefix),
      )
    )
      throw new Error("隔离 HOME required");
    const roots = [join(home, "E2E_VP14_A"), join(home, "E2E_VP14_B")];
    for (const root of roots) {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "same.ts"), "export const same = 1;\n");
    }
    await promisify(execFile)("git", ["init", "--initial-branch=main", roots[0]!]);
    const initialProject = await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText();
    expect(await $('[data-testid="composer-edit-project"]').isExisting()).toBe(false);
    await openComposerProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_COMPOSER_CANCELLED");
    await $('//button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed({ reverse: true });
    expect(await $('[data-project-name="E2E_COMPOSER_CANCELLED"]').isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toBe(
      initialProject,
    );
    await openComposerProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP14_PROJECT");
    for (const root of roots) {
      await chooseProjectRoot(root);
    }
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const project = $('[data-project-name="E2E_VP14_PROJECT"]');
    await project.waitForDisplayed();
    // PCD01：在草稿创建项目成功后自动选中新项目，取消仍保持原选择。
    await browser.waitUntil(async () =>
      (await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).includes(
        "E2E_VP14_PROJECT",
      ),
    );
    await project.$('[data-testid="virtual-project-create-task"]').click();
    const input = $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    await input.waitForDisplayed();
    const workspaceTrigger = $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`);
    for (const theme of ["zai-light", "zai-dark"]) {
      await browser.execute(
        (theme) =>
          (
            window as Window & { __testActions?: { setTheme(theme: string): void } }
          ).__testActions!.setTheme(theme),
        theme,
      );
      const toggle = project.$('[data-testid="virtual-project-toggle"]');
      await toggle.$(".lucide-folders-open").waitForExist();
      await project.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP14-folders-open-${theme}.png`),
      );
      await toggle.click();
      await toggle.$(".lucide-folders").waitForExist();
      await project.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP14-folders-closed-${theme}.png`),
      );
      await toggle.click();
      await workspaceTrigger.$(".lucide-folders").waitForExist();
      await workspaceTrigger.click();
      const menu = $('[data-testid="composer-project-menu"]');
      await menu.$('[data-project-name="E2E_VP14_PROJECT"] .lucide-folders').waitForDisplayed();
      await menu.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP14-folders-composer-${theme}.png`),
      );
      await browser.keys("Escape");
      await menu.waitForDisplayed({ reverse: true });
      const edit = $('[data-testid="composer-edit-project"]');
      await edit.waitForDisplayed();
      await $('[data-branch-switcher-primary-icon="true"]').waitForDisplayed();
      const placement = await browser.execute(() => {
        const button = document.querySelector('[data-testid="composer-edit-project"]')!;
        const branch = button.parentElement!.querySelector(
          '[data-branch-switcher-primary-icon="true"]',
        )!.parentElement!;
        return {
          branchRight: branch.getBoundingClientRect().right,
          editLeft: button.getBoundingClientRect().left,
        };
      });
      expect(placement.editLeft).toBeGreaterThanOrEqual(placement.branchRight);
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_COMPOSER_EDIT_DRAFT");
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP14-composer-edit-${theme}.png`),
      );
      await edit.click();
      const name = $('[data-testid="virtual-project-name"]');
      await name.waitForDisplayed();
      expect(await name.getValue()).toBe("E2E_VP14_PROJECT");
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP14-project-editor-${theme}.png`),
      );
      await name.setValue("E2E_EDIT_CANCELLED");
      await $('//button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]').click();
      await name.waitForDisplayed({ reverse: true });
      expect(await workspaceTrigger.getText()).toContain("E2E_VP14_PROJECT");
      if (theme === "zai-light") {
        const originalId = await project.getAttribute("data-project-id");
        await edit.click();
        await name.setValue("E2E_VP14_EDITED");
        await $('[data-testid="virtual-project-save"]').click();
        await name.waitForDisplayed({ reverse: true });
        const renamed = $('[data-project-name="E2E_VP14_EDITED"]');
        await renamed.waitForDisplayed();
        expect(await renamed.getAttribute("data-project-id")).toBe(originalId);
        expect(await workspaceTrigger.getText()).toContain("E2E_VP14_EDITED");
        expect(await input.getText()).toBe("E2E_COMPOSER_EDIT_DRAFT");
        await edit.click();
        await name.setValue("E2E_VP14_PROJECT");
        await $('[data-testid="virtual-project-save"]').click();
        await name.waitForDisplayed({ reverse: true });
        await project.waitForDisplayed();
      }
      expect(await input.getText()).toBe("E2E_COMPOSER_EDIT_DRAFT");
    }
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@same.ts", {
      stabilizeLexicalCaretAtEnd: true,
    });
    const panel = $(`[data-testid="${TID_PROMPT_SUGGESTION_PANEL}"]`);
    await panel.waitForDisplayed();
    for (const root of roots) {
      const option = panel.$(`[data-option-id="file:${join(root, "src", "same.ts")}"]`);
      await option.waitForDisplayed();
      expect(await option.getText()).toContain(basename(root));
    }
    const readMarkdown = () =>
      browser.execute(
        (testId) =>
          (
            document.querySelector(`[data-testid="${testId}"]`) as HTMLElement & {
              __zcodeLexicalInputE2E?: { getText(): string };
            }
          )?.__zcodeLexicalInputE2E?.getText(),
        TID_V4_COMPOSER_INPUT,
      );
    await panel.$(`[data-option-id="file:${join(roots[0]!, "src", "same.ts")}"]`).click();
    await browser.waitUntil(
      async () => (await readMarkdown())?.includes("[same.ts](./src/same.ts)") ?? false,
    );
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@same.ts", {
      stabilizeLexicalCaretAtEnd: true,
    });
    await panel.waitForDisplayed();
    const second = panel.$(`[data-option-id="file:${join(roots[1]!, "src", "same.ts")}"]`);
    await second.click();
    expect(await input.$('[data-mention-category="files"]').getAttribute("data-mention-id")).toBe(
      `file:${join(roots[1]!, "src", "same.ts")}`,
    );
    expect(await readMarkdown()).toContain(`[same.ts](${join(roots[1]!, "src", "same.ts")})`);
    await setInputValueByTestIdDom(
      TID_V4_COMPOSER_INPUT,
      "E2E_VP14_HISTORY: Reply with E2E_VP14_READY.",
    );
    await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
    await $('//*[normalize-space(.)="E2E_VP14_READY" and not(*)]').waitForDisplayed({
      timeout: 60_000,
    });
    const taskId = await browser.execute(() => {
      const state = (
        window as Window & {
          __zcodeSessionStoreE2E?: {
            getState(): { workspaces: Record<string, { activeTaskId?: string | null }> };
          };
        }
      ).__zcodeSessionStoreE2E?.getState();
      return (
        Object.values(state?.workspaces ?? {}).find((workspace) => workspace.activeTaskId)
          ?.activeTaskId ?? null
      );
    });
    expect(taskId).toBeTruthy();
    // 顶部新建继承当前项目；这里显式进入未归类草稿，才能覆盖跨项目 # 候选。
    await $('[data-testid="virtual-project-new-task"]').click();
    await input.waitForDisplayed();
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#", {
      stabilizeLexicalCaretAtEnd: true,
    });
    await panel.waitForDisplayed();
    await panel.$(`[data-option-id="session:${taskId}"]`).waitForDisplayed();
    expect(await panel.getText()).toContain("E2E_VP14_PROJECT");
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP14-project-mentions.png"),
    );
    // # 候选验证结束后清空查询；只按 Escape 会在项目切换恢复草稿时再次弹出候选并遮住项目入口。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");
    await panel.waitForDisplayed({ reverse: true });
    await openLocalProjectEditor();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_VP15_TARGET");
    await chooseProjectRoot(roots[1]!);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const destination = $('[data-project-name="E2E_VP15_TARGET"]');
    await destination.waitForDisplayed();
    // 创建完成先发布目录再关闭信任/编辑器；等待遮罩退出，避免点击被旧弹窗截获。
    await $('[data-slot="dialog-overlay"]').waitForExist({ reverse: true });
    // PCD01 会跨 root 切换草稿；列表出现并不表示新 workspace 的 Composer 已接管。
    await waitForWorkspaceApp(roots[1]!, 30000);
    const destinationTrigger = $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`);
    await browser.waitUntil(async () =>
      (await destinationTrigger.getText()).includes("E2E_VP15_TARGET"),
    );
    await destinationTrigger.waitForClickable();
    await destinationTrigger.click();
    const projectMenu = $('[data-testid="composer-project-menu"]');
    await projectMenu.$('[data-project-name="E2E_VP15_TARGET"] .lucide-folder').waitForDisplayed();
    await projectMenu
      .$('[data-project-name="E2E_VP14_PROJECT"] .lucide-folders')
      .waitForDisplayed();
    await browser.keys("Escape");
    await projectMenu.waitForDisplayed({ reverse: true });
    const targetId = await destination.getAttribute("data-project-id");
    const sourceId = await project.getAttribute("data-project-id");
    const row = project.$(`[data-testid="${testId(TID_TASK_ITEM, taskId!)}"]`);
    await row.waitForDisplayed();
    // 只观察原生拖动事件，不在测试里直接发组织命令或写 dataTransfer。
    await browser.execute(() => {
      const trace: unknown[] = [];
      (window as Window & { __vp15DragTrace?: unknown[] }).__vp15DragTrace = trace;
      for (const name of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
        document.addEventListener(name, (event) => {
          const e = event as DragEvent;
          if (trace.length < 100)
            trace.push({
              type: e.type,
              allowed: e.dataTransfer?.effectAllowed,
              effect: e.dataTransfer?.dropEffect,
              project: (e.target as HTMLElement)
                .closest?.("[data-project-id]")
                ?.getAttribute("data-project-id"),
            });
        });
      }
    });
    const readOwnership = () => {
      const db = new DatabaseSync(join(home, ".zcode", "v2", "tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        return {
          task: db
            .prepare("SELECT project_id,workspace_path FROM tasks WHERE task_id=?")
            .get(taskId!),
          roots: db
            .prepare("SELECT root_path FROM project_roots WHERE project_id=? ORDER BY position")
            .all(targetId!),
        };
      } finally {
        db.close();
      }
    };
    const confirm = $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
    const rowSelector = `[data-testid="${testId(TID_TASK_ITEM, taskId!)}"]`;
    const targetSelector = '[data-project-name="E2E_VP15_TARGET"]';
    const sourceSelector = '[data-project-name="E2E_VP14_PROJECT"]';
    try {
      for (const theme of ["zai-light", "zai-dark"]) {
        await browser.execute(
          (theme) =>
            (
              window as Window & { __testActions?: { setTheme(theme: string): void } }
            ).__testActions!.setTheme(theme),
          theme,
        );
        const before = await destination.getSize();
        await hoverSessionOnProject(rowSelector, sourceSelector);
        const sourceIndicator = project.$('[data-testid="project-session-drop-target"]');
        await sourceIndicator.waitForDisplayed();
        expect((await sourceIndicator.getSize()).height).toBeGreaterThan(40);
        await moveSessionPointer(`${sourceSelector} [data-testid="virtual-project-toggle"]`);
        await sourceIndicator.waitForDisplayed();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP15-project-drop-${theme}.png`),
        );
        await project.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `VP15-project-drop-panel-${theme}.png`),
        );
        await moveSessionPointer(`${targetSelector} [data-testid="virtual-project-toggle"]`);
        await destination.$('[data-testid="project-session-drop-target"]').waitForDisplayed();
        expect(await sourceIndicator.isExisting()).toBe(false);
        expect(await destination.getSize()).toEqual(before);
        // WebDriver 的 Escape 不会取消原生拖拽；离开项目再松手，避免误触发落点确认。
        await moveSessionPointer('[data-testid="task-new-button"]');
        await $('[data-testid="project-session-drop-target"]').waitForExist({ reverse: true });
        await browser.releaseActions();
        await $('[data-testid="project-session-drop-target"]').waitForExist({ reverse: true });
        expect(readOwnership().task).toEqual({ project_id: sourceId, workspace_path: roots[0] });
      }
      await row.dragAndDrop(destination.$('[data-testid="virtual-project-toggle"]'), {
        duration: 700,
      });
      await confirm.waitForDisplayed({ timeout: 8_000 });
      expect(await $('[data-testid="project-session-drop-target"]').isExisting()).toBe(false);
      await browser.keys("Escape");
      await confirm.waitForDisplayed({ reverse: true });
      expect(readOwnership()).toEqual({
        task: { project_id: sourceId, workspace_path: roots[0] },
        roots: [{ root_path: roots[1] }],
      });
      await row.dragAndDrop(destination.$('[data-testid="virtual-project-toggle"]'), {
        duration: 700,
      });
      await confirm.waitForDisplayed();
      await confirm.click();
      await destination.$(`[data-testid="${testId(TID_TASK_ITEM, taskId!)}"]`).waitForDisplayed();
      expect(readOwnership()).toEqual({
        task: { project_id: targetId, workspace_path: roots[0] },
        roots: [{ root_path: roots[1] }, { root_path: roots[0] }],
      });
      // 确认框退出动画仍会接收指针；等它退出后再开始下一次真实拖拽。
      await confirm.waitForDisplayed({ reverse: true });
      await hoverSessionOnProject(`${targetSelector} ${rowSelector}`, sourceSelector);
      await project.$('[data-testid="project-session-drop-target"]').waitForDisplayed();
      await browser.performActions([
        {
          type: "pointer",
          id: "session-project-drag",
          parameters: { pointerType: "mouse" },
          actions: [{ type: "pointerUp", button: 0 }],
        },
      ]);
      await row.waitForDisplayed();
      expect(readOwnership().task).toEqual({ project_id: sourceId, workspace_path: roots[0] });
      expect(await $('[data-testid="project-session-drop-target"]').isExisting()).toBe(false);
      await row.click();
      await $('//*[normalize-space(.)="E2E_VP14_READY" and not(*)]').waitForDisplayed();
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "VP15-project-move.png"),
      );
    } finally {
      await browser.releaseActions();
      process.stderr.write(
        `VP15 native drag: ${JSON.stringify(await browser.execute(() => (window as Window & { __vp15DragTrace?: unknown[] }).__vp15DragTrace))}\n`,
      );
    }
  });
});

async function openLocalProjectEditor() {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}
async function openComposerProjectEditor() {
  await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
  const menu = $('[data-testid="composer-project-menu"]');
  const create = menu.$('[data-testid="composer-create-project"]');
  expect(await create.getText()).toMatch(/^(创建项目|Create project)$/);
  await create.click();
  await menu.waitForDisplayed({ reverse: true });
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}
async function chooseProjectRoot(path: string) {
  await selectNativeProjectDirectories([path]);
}

async function moveSessionPointer(selector: string) {
  const point = await browser.execute((selector) => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "session-project-drag",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", ...point, duration: 350 }],
    },
  ]);
  // 首次进入仅触发 dragenter；第二次真实位移触发 dragover，让浏览器采用目标的 move 效果。
  await browser.performActions([
    {
      type: "pointer",
      id: "session-project-drag",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", x: point.x + 1, y: point.y, duration: 0 }],
    },
  ]);
}
async function hoverSessionOnProject(source: string, target: string) {
  await browser.releaseActions();
  const point = await browser.execute((selector) => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };
  }, source);
  await browser.performActions([
    {
      type: "pointer",
      id: "session-project-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", ...point, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: point.x + 10, y: point.y, duration: 100 },
      ],
    },
  ]);
  await moveSessionPointer(`${target} [data-testid="virtual-project-toggle"]`);
}

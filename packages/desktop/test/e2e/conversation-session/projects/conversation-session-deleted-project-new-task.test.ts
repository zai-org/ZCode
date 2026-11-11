import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTree } from "@zcode/services";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  setV4ComposerText,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

async function navigation() {
  return browser.execute(() => {
    const target = window as Window & {
      __zcodeTabStoreE2E?: {
        getState(): { activeWorkspacePath: string | null; activeWorkspaceIdentity?: string | null };
      };
      __zcodeSessionStoreE2E?: {
        getState(): {
          getWorkspaceState(
            path: string,
            identity?: string,
          ): {
            activeTaskId: string | null;
            draftProjectId?: string | null;
          };
        };
      };
    };
    const tab = target.__zcodeTabStoreE2E!.getState();
    const path = tab.activeWorkspacePath!;
    const state = target
      .__zcodeSessionStoreE2E!.getState()
      .getWorkspaceState(path, tab.activeWorkspaceIdentity ?? undefined);
    return { path, taskId: state.activeTaskId, projectId: state.draftProjectId ?? null };
  });
}

describe("PDN01 deleted project new task", () => {
  after(async () => {
    await restoreHandoffProbes();
    await clearAppData();
  });
  for (const entry of ["menu", "editor"] as const) {
    it(`删除当前项目后可新建未归类任务（${entry}）`, async function () {
      this.timeout(180_000);
      await prepareV4ConversationE2E();
      await installHandoffRpcProbe();
      const name = `E2E_DELETED_PROJECT_${entry}`;
      await $('[data-testid="virtual-project-add"]').click();
      await $('[data-testid="virtual-project-name"]').setValue(name);
      await $('[data-testid="virtual-project-save"]').click();
      const project = $(`[data-project-name="${name}"]`);
      await project.waitForDisplayed();
      const projectId = await project.getAttribute("data-project-id");
      await browser.waitUntil(async () => (await navigation()).projectId === projectId);
      if (entry === "menu") {
        await sendV4Prompt("E2E_DELETED_PROJECT_SESSION");
        await waitForV4AssistantMessageContaining("E2E_DELETED_PROJECT_READY");
      } else {
        await setV4ComposerText("E2E_DELETED_PROJECT_SAVED_DRAFT");
      }
      const before = await navigation();
      await project.$('[data-testid="virtual-project-row"]').click({ button: "right" });
      if (entry === "editor") {
        await $('[data-testid="virtual-project-edit"]').click();
        await $('[data-testid="virtual-project-editor-delete"]').click();
      } else {
        await $('[data-testid="virtual-project-delete"]').click();
      }
      await project.waitForExist({ reverse: true });
      expect(await navigation()).toEqual(before);
      if (entry === "menu") {
        await waitForV4AssistantMessageContaining("E2E_DELETED_PROJECT_READY");
      } else {
        await waitForV4ComposerText("E2E_DELETED_PROJECT_SAVED_DRAFT", "删除项目后原草稿丢失");
      }
      const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
      expect(tree.projects.some((item) => item.id === projectId)).toBe(false);
      if (before.taskId) {
        expect(tree.tasks.find((item) => item.taskId === before.taskId)).toMatchObject({
          workspacePath: before.path,
          projectId,
        });
      }
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `deleted-project-${entry}-before.json`),
        JSON.stringify({ before, projectId, tasks: tree.tasks }, null, 2),
      );
      if (entry === "menu") {
        await $('[data-testid="task-new-button"]').click();
      } else {
        await browser.electron.execute((electron) => {
          const find = (menu: Electron.Menu): Electron.MenuItem | undefined => {
            for (const item of menu.items) {
              if (item.accelerator === "CmdOrCtrl+N") return item;
              if (item.submenu) {
                const nested = find(item.submenu);
                if (nested) return nested;
              }
            }
          };
          const item = find(electron.Menu.getApplicationMenu()!);
          if (!item) throw new Error("new task menu shortcut missing");
          item.click(
            undefined as never,
            electron.BrowserWindow.getFocusedWindow()!,
            undefined as never,
          );
        });
      }
      await browser.waitUntil(async () => (await navigation()).path !== before.path, {
        timeout: 15_000,
        timeoutMsg: "删除项目后新建任务仍停在旧目录",
      });
      await waitForV4Pane((pane) => pane.sessionId === "draft", "新建任务未显示草稿");
      expect((await navigation()).projectId).toBeNull();
      await setV4ComposerText("E2E_DELETED_PROJECT_NEW_DRAFT");
      await waitForV4ComposerText("E2E_DELETED_PROJECT_NEW_DRAFT", "新草稿不能输入");
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `deleted-project-${entry}-after.png`),
      );
    });
  }
});

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  selectNativeProjectDirectories,
  openProjectMenuAction,
  projectSectionSelector,
  waitForProjectRow,
  waitForProjectRowGone,
} from "#e2e/helpers/project-sidebar";

describe("project removal persists across restart E2E", () => {
  const { homeDir } = getE2EAppDataPaths();
  const closedWorkspacePath = join(homeDir, "ZCodeProjectClosed");

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(closedWorkspacePath, { recursive: true, force: true });
  });

  it("WCP01: 删除项目后，完整重启不会被旧 workspace 设置复活", async function () {
    this.timeout(240_000);
    await waitForDefaultWorkspaceReady(30_000);
    await mkdir(closedWorkspacePath, { recursive: true });
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("ZCodeProjectClosed");
    await selectNativeProjectDirectories([closedWorkspacePath]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await waitForProjectRow(closedWorkspacePath);
    const projectId = await $(projectSectionSelector(closedWorkspacePath)).getAttribute(
      "data-project-id",
    );
    await openProjectMenuAction(closedWorkspacePath, "delete");
    await waitForProjectRowGone(closedWorkspacePath);

    const readDeletedProject = () => {
      const db = new DatabaseSync(join(homeDir, ".zcode/v2/tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT project_id, deleted_at FROM projects WHERE project_id=?")
          .get(projectId);
      } finally {
        db.close();
      }
    };
    expect(Number(readDeletedProject()?.deleted_at)).toBeGreaterThan(0);
    // 原因：项目归属由 Host 一次迁移；旧 settings 的目录快照不能在重启时重新生成已删除入口。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedSettings({
          lastWorkspaceSession: [
            { kind: "local", workspacePath: DEFAULT_WORKSPACE },
            { kind: "local", workspacePath: closedWorkspacePath },
          ],
          lastActiveTabIndex: 0,
        });
      },
    });
    // 冷启动允许进入未选项目草稿；项目列表才是“不复活”的验收边界。
    await waitForProjectRow(DEFAULT_WORKSPACE);
    await waitForProjectRowGone(closedWorkspacePath);
    expect(Number(readDeletedProject()?.deleted_at)).toBeGreaterThan(0);
    // 刷新再触发 renderer 恢复，证明不是仅首帧没显示。
    await browser.refresh();
    await waitForProjectRow(DEFAULT_WORKSPACE);
    await waitForProjectRowGone(closedWorkspacePath);
  });
});

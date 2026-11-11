import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  getV4PaneSnapshot,
  waitForV4ComposerText,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

describe("TSL08: unavailable startup project opens an unclassified draft", () => {
  const { homeDir } = getE2EAppDataPaths();
  const workspacePath = join(homeDir, "E2E_UNAVAILABLE_PROJECT");
  const movedPath = `${workspacePath}-moved`;
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;

  after(async () => {
    await clearAppData();
    await rm(movedPath, { recursive: true, force: true });
  });

  it("冷启动默认项目被移动后，直接显示可输入的无项目草稿，刷新后保持", async function () {
    this.timeout(240_000);
    await waitForDefaultWorkspaceReady(30_000);
    await mkdir(workspacePath, { recursive: true });
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await rename(workspacePath, movedPath);
        await seedSettings({
          lastActiveWorkspace: { kind: "local", workspacePath, workspacePurpose: "project" },
          lastWorkspaceSession: [{ kind: "local", workspacePath, workspacePurpose: "project" }],
          lastActiveTabIndex: 0,
        });
      },
    });

    // 原因：启动 helper 不能点击“新建任务”修复前置，否则会掩盖默认选中失效项目的空白页。
    await waitForV4Pane((pane) => pane.sessionId === "draft", "失效项目未自动进入任务草稿");
    const target = await browser.execute(() => {
      const e2eWindow = window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeWorkspacePath: string | null;
            tabs: Array<{ kind: string; workspacePath?: string; workspacePurpose?: string }>;
          };
        };
        __zcodeSessionStoreE2E?: {
          getState(): {
            getWorkspaceState(path: string): {
              activeTaskId: string | null;
              draftProjectId?: string | null;
            };
          };
        };
      };
      const tabState = e2eWindow.__zcodeTabStoreE2E?.getState();
      const path = tabState?.activeWorkspacePath;
      if (!path) throw new Error("没有活动草稿工作区");
      const tab = tabState.tabs.find(
        (item) => item.kind === "workspace" && item.workspacePath === path,
      );
      const workspace = e2eWindow.__zcodeSessionStoreE2E?.getState().getWorkspaceState(path);
      return {
        path,
        purpose: tab?.workspacePurpose,
        activeTaskId: workspace?.activeTaskId,
        projectId: workspace?.draftProjectId ?? null,
      };
    });
    expect(target.path).not.toBe(workspacePath);
    expect(target.purpose).toBe("conversation");
    expect(target.activeTaskId).toBeNull();
    expect(target.projectId).toBeNull();
    await expect(access(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await access(target.path);

    const marker = "E2E_UNAVAILABLE_PROJECT_DRAFT";
    const editor = $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    await editor.waitForDisplayed();
    await editor.click();
    await browser.keys(marker);
    await waitForV4ComposerText(marker, "无项目草稿不能输入");
    await browser.saveScreenshot(join(artifactDir, "unavailable-project-draft.png"));
    await browser.refresh();
    await waitForV4Pane((pane) => pane.sessionId === "draft", "刷新后草稿未恢复");
    await waitForV4ComposerText(marker, "刷新后无项目草稿丢失");
    expect((await getV4PaneSnapshot()).rowCount).toBe(0);
    await writeFile(
      join(artifactDir, "unavailable-project-draft.json"),
      JSON.stringify(target, null, 2),
    );
  });
});

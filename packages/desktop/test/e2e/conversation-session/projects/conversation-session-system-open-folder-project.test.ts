import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import type { VirtualProject } from "@zcode/services";
import {
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

async function openFolder(path: string) {
  // 使用 Explorer 的 argv 入口，保留真实 Main → preload → Root → Host 项目保存链路。
  await browser.electron.execute((electron, folder) => {
    electron.app.emit("second-instance", {}, ["ZCode.exe", "--open-workspace", folder], "", {});
  }, path);
}
async function draft() {
  return browser.execute(() => {
    const target = window as Window & {
      __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null } };
      __zcodeSessionStoreE2E?: {
        getState(): {
          getWorkspaceState(path: string): {
            activeTaskId: string | null;
            draftProjectId?: string | null;
          };
        };
      };
    };
    const path = target.__zcodeTabStoreE2E?.getState().activeWorkspacePath;
    const state = path
      ? target.__zcodeSessionStoreE2E?.getState().getWorkspaceState(path)
      : undefined;
    return { path, projectId: state?.draftProjectId, taskId: state?.activeTaskId };
  });
}
const readProjects = () =>
  callHandoffHost<VirtualProject[]>(ServiceChannels.Project, "readProjects");
async function expectProjectDraft(path: string, id?: string) {
  await waitForWorkspaceApp(path, 30_000);
  await browser.waitUntil(
    async () => {
      const state = await draft();
      return (
        state.path === path &&
        Boolean(state.projectId) &&
        (!id || state.projectId === id) &&
        !state.taskId
      );
    },
    { timeout: 30_000, timeoutMsg: "系统目录未绑定项目草稿" },
  );
  const project = (await readProjects()).find(
    (item) => item.id === id || item.roots.some((root) => root.rootPath === path),
  );
  expect(project).toBeDefined();
  expect((await draft()).projectId).toBe(project!.id);
  await $('[data-testid="composer-workspace-trigger"]').waitForDisplayed();
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="composer-workspace-trigger"]').getText()).includes(project!.name),
    { timeout: 10_000, timeoutMsg: "项目名称未显示在草稿选择器" },
  );
  return project!;
}

describe("系统目录打开项目", () => {
  const root = join(getE2EAppDataPaths().homeDir, "system-open-folder");
  const warm = join(root, "Folder 中文 & space");
  const extra = join(root, "extra");
  const cold = join(root, "Cold project");
  before(async () => {
    await Promise.all([warm, extra, cold].map((path) => mkdir(path, { recursive: true })));
    await waitForDefaultWorkspaceReady(30_000);
    await installHandoffRpcProbe();
  });
  after(async () => {
    await restoreHandoffProbes();
    // 目录归隔离 HOME；由 runner 等 Main/Host 退出后清理，避免与运行中写入竞争。
  });
  it("OFP02/OFP03: 运行中创建、重复打开复用，保留已有项目名称和 roots", async () => {
    await openFolder(warm);
    const created = await expectProjectDraft(warm);
    await callHandoffHost(ServiceChannels.Project, "saveProject", [
      { id: created.id, name: "Existing project", roots: [warm, extra], primaryRoot: warm },
    ]);
    await openFolder(extra);
    await expectProjectDraft(extra, created.id);
    await openFolder(warm);
    await openFolder(warm);
    const reused = await expectProjectDraft(warm, created.id);
    expect(reused.name).toBe("Existing project");
    expect(reused.roots.map((entry) => entry.rootPath)).toEqual([warm, extra]);
    expect(
      (await readProjects()).filter((item) => item.roots.some((entry) => entry.rootPath === warm)),
    ).toHaveLength(1);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "OFP02-project-reused.png"),
    );
  });
  it("OFP01: argv 冷启动先创建项目再初始化草稿", async function () {
    this.timeout(180_000);
    const capabilities = browser.requestedCapabilities as WebdriverIO.Capabilities & {
      "goog:chromeOptions"?: { args?: string[] };
    };
    const options = capabilities["goog:chromeOptions"] ?? {};
    capabilities["goog:chromeOptions"] = {
      ...options,
      args: [...(options.args ?? []), `--open-workspace=${cold}`],
    };
    await restoreHandoffProbes();
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForWorkspaceApp(cold, 30_000);
    await installHandoffRpcProbe();
    expect(new URL(await browser.getUrl()).searchParams.get("initialWorkspacePath")).toBe(cold);
    await expectProjectDraft(cold);
    expect(
      (await readProjects()).filter((item) => item.roots.some((entry) => entry.rootPath === cold)),
    ).toHaveLength(1);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "OFP01-cold-project.png"),
    );
  });
});

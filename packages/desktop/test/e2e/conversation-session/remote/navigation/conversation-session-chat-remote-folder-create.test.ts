import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  ServiceChannels,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_SETTINGS_PAGE,
} from "@zcode/shared/test-ids";
import type { ProjectTree, RemoteProjectDirectory } from "@zcode/services";
import {
  prepareV4ConversationE2E,
  setV4ComposerText,
  sendV4PromptAndWaitAccepted,
  getV4ComposerText,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  readSSHRuntimeConfig,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";

import {
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";

const marker = "E2E_CHAT_REMOTE_FOLDER_CREATE";
async function captureAppearance() {
  for (const [locale, theme, width] of [
    ["en-US", "light", 1440],
    ["zh-CN", "dark", 480],
  ] as const) {
    await browser.execute(
      (locale, theme) => {
        const actions = (
          window as Window & {
            __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
          }
        ).__testActions;
        actions?.setLocale(locale);
        actions?.setTheme(theme);
      },
      locale,
      theme,
    );
    await browser.electron.execute((electron, width) => {
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.setSize(width, 900);
    }, width);
    await browser.waitUntil(() =>
      browser.execute(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      ),
    );
    const trust = $('[data-testid="project-folder-trust-dialog"]');
    await trust.waitForDisplayed();
    expect(await $('[data-testid="project-folder-trust-confirm"]').isClickable()).toBe(true);
    expect((await trust.getLocation()).x).toBeGreaterThanOrEqual(0);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `create-trust-${locale}-${theme}-${width}.png`),
    );
  }
  await browser.electron.execute((electron) => {
    electron.BrowserWindow.getAllWindows()
      .find((window) => window.isVisible())
      ?.setSize(1440, 900);
  });
}
describe(marker, () => {
  let provider: SSHLifecycleProvider | undefined;
  after(async () => {
    await provider?.tunnel.close();
    await restoreHandoffProbes();
    await clearAppData();
  });
  it("RDUX21-07/08/14 零匹配共享创建与嵌套取消，远端首发及重复连接复用", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    provider = await createSSHLifecycleProvider(config, marker);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await installHandoffRpcProbe();
    const before = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
    const picker = $('[data-testid="chat-remote-folder"]');
    if (!(await picker.isExisting())) {
      // 红灯证据必须是实际提交归属，不能把预热 runtime 误记为已发送。
      await sendV4PromptAndWaitAccepted(
        marker + " return a short acknowledgement",
        marker,
        "原无项目路径的消息应进入真实任务",
      );
      const after = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
      const added = after.tasks.filter(
        (task) => !before.tasks.some((old) => old.taskId === task.taskId),
      );
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "old-local-submission.json"),
        JSON.stringify(added, null, 2),
      );
      expect(added.some((task) => task.hostId === "local" && !task.projectId)).toBe(false);
    }
    await picker.waitForDisplayed();
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
      ServiceChannels.SourceServerManagement,
      "getSnapshot",
    );
    const source = snapshot.servers[0]!;
    const hostId = remoteHostIdFromWorkspaceIdentity(
      buildServerRemoteWorkspaceIdentity({ serverId: source.sourceServerId, workspacePath: "/" }),
    )!;
    const path = `${config.workspacePaths[0]!}/chat-folder-${Date.now()}-long-project-directory`;
    const createdDirectory = await runSSHCommand(
      config,
      "mkdir -p -- '" + path.replaceAll("'", "'\\''") + "'",
    );
    expect(createdDirectory.code).toBe(0);
    const beforeProjects = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const reconnect = async () => {
      await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
      await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(marker);
      expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
      await picker.waitForDisplayed();
    };
    const selectFolder = async () => {
      const pathInput = picker.$("input");
      await pathInput.setValue(path);
      await picker.$('button[type="submit"]').click();
      const select = picker.$('[data-testid="directory-browser-confirm"]');
      await select.waitForEnabled();
      await select.click();
      await browser.waitUntil(async () => !(await picker.isExisting()));
      if (await $('[data-testid="virtual-project-name"]').isExisting()) {
        expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
          path.split("/").at(-1),
        );
        expect(await $('[data-testid="virtual-project-browse"]').isExisting()).toBe(false);
        await $('[data-testid="virtual-project-save"]').click();
        await $('[data-testid="project-folder-trust-dialog"]').waitForDisplayed();
        await captureAppearance();
        await browser.keys("Escape");
        await $('[data-testid="project-folder-trust-dialog"]').waitForExist({ reverse: true });
        expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(true);
        expect(
          (await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{ hostId }]))
            .projects,
        ).toEqual(beforeProjects.projects);
        await $('[data-testid="virtual-project-save"]').click();
        await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
        await $('[data-testid="project-folder-trust-confirm"]').click();
      }
      const identity = buildServerRemoteWorkspaceIdentity({
        serverId: source.sourceServerId,
        workspacePath: path,
      });
      await waitForRemoteTab({
        caseMarker: marker,
        expectedPath: path,
        expectedIdentity: identity,
      });
      await picker.waitForExist({ reverse: true });
      expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toContain(
        path.split("/").at(-1)!,
      );
      return identity;
    };
    await reconnect();
    await picker.$("input").setValue(path + "/missing-directory");
    await picker.$('button[type="submit"]').click();
    await browser.waitUntil(async () => (await picker.getText()).includes("ENOENT"));
    expect(await picker.$('[data-testid="directory-browser-confirm"]').isEnabled()).toBe(false);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "invalid-folder.png"));
    expect((await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")).tasks).toEqual(
      before.tasks,
    );
    const identity = await selectFolder();
    const createdTree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const existing = createdTree.projects.find((project) => project.roots[0]?.rootPath === path)!;
    expect(existing).toMatchObject({ hostId, name: path.split("/").at(-1), deleted: false });
    expect(existing.roots).toEqual([{ rootPath: path, isPrimary: true, position: 0 }]);
    expect(createdTree.projects).toHaveLength(beforeProjects.projects.length + 1);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await sendV4PromptAndWaitAccepted(
      marker + " remote first message",
      marker,
      "首次消息必须在远端项目接受",
    );
    await waitForV4AssistantMessageContaining("SSH_P0_TASK_LIFECYCLE_REPLY");
    const remoteTree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const task = remoteTree.tasks.find((item) => item.projectId === existing.id)!;
    expect(task).toMatchObject({
      hostId,
      projectId: existing.id,
      workspacePath: path,
      workspaceIdentity: identity,
    });
    expect(remoteTree.projects.map((item) => item.id).sort()).toEqual(
      createdTree.projects.map((item) => item.id).sort(),
    );
    expect(
      (
        await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
          { hostId: "local" },
        ])
      ).tasks,
    ).toEqual(before.tasks);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "remote-first-submission.json"),
      JSON.stringify({ project: existing, task }, null, 2),
    );
    // 已有任务从项目菜单的新任务入口进入；重复连接仍强制选目录，不能恢复旧会话。
    // 根因：窄窗截图会折叠侧栏，恢复窗口宽度不会自动展开；旧 case 点击了裁切区域内的按钮。
    // 通过真实入口恢复侧栏，再精确悬停项目标题行，不用 DOM click 绕过交互条件。
    const sidebar = $("[data-workspace-sidebar-panel] > aside");
    if ((await sidebar.getAttribute("aria-hidden")) === "true") {
      await $('button[aria-label="切换侧边栏"], button[aria-label="Toggle sidebar"]').click();
    }
    await browser.waitUntil(async () => (await sidebar.getAttribute("aria-hidden")) === "false");
    const projectRow = $(`[data-project-id="${existing.id}"] [data-testid="virtual-project-row"]`);
    await projectRow.moveTo();
    const createTask = projectRow.$('[data-testid="virtual-project-create-task"]');
    await createTask.waitForDisplayed();
    await createTask.click();
    await reconnect();
    await selectFolder();
    const repeated = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    expect(repeated.tasks.find((item) => item.taskId === task.taskId)).toMatchObject({
      taskId: task.taskId,
      hostId,
      projectId: existing.id,
      workspaceIdentity: identity,
      workspacePath: path,
    });
    expect(repeated.projects.map((item) => item.id).sort()).toEqual(
      createdTree.projects.map((item) => item.id).sort(),
    );
    const entries = (
      await callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory")
    ).entries;
    expect(
      entries.filter((entry) => entry.hostId === hostId && entry.projectId === existing.id),
    ).toHaveLength(1);
    await setV4ComposerText(marker + " remote draft retained");
    await reconnect();
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    expect(await getV4ComposerText()).toBe(marker + " remote draft retained");
    expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toContain(
      existing.name,
    );
  });
});

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
import type { ProjectTree, VirtualProject, RemoteProjectDirectory } from "@zcode/services";
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

const marker = "E2E_CHAT_REMOTE_PROJECT_CHOICE";
describe(marker, () => {
  let provider: SSHLifecycleProvider | undefined;
  after(async () => {
    await provider?.tunnel.close();
    await restoreHandoffProbes();
    await clearAppData();
  });
  it("RDUX21-06 同目录项目明确选择、身份隔离、失效候选及取消", async function () {
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
    const localBefore = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    const originalTargetLabel = await $(
      `[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`,
    ).getText();
    const picker = $('[data-testid="chat-remote-folder"]');
    const reconnect = async () => {
      await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
      await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(marker);
      expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
      await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
      await picker.waitForDisplayed();
    };
    // 候选弹窗打开后 Composer 只读；禁发用例必须从用户能输入的连接前草稿开始。
    await setV4ComposerText(marker + " retained original draft");
    await reconnect();
    const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
      ServiceChannels.SourceServerManagement,
      "getSnapshot",
    );
    const source = snapshot.servers[0]!;
    const hostId = remoteHostIdFromWorkspaceIdentity(
      buildServerRemoteWorkspaceIdentity({ serverId: source.sourceServerId, workspacePath: "/" }),
    )!;
    const path = `${config.workspacePaths[0]!}/chat-choice-${Date.now()}`;
    expect((await runSSHCommand(config, `mkdir -p '${path}/child'`)).code).toBe(0);
    const save = (name: string, root = path) =>
      callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
        { hostId, roots: [root], name },
      ]);
    const beforeRemoteIds = (
      await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
        { hostId, includeDeleted: true },
      ])
    ).projects.map((item) => item.id);
    const first = await save(
      marker + " same name with a long descriptive project label 同目录不同身份",
    );
    const second = await save(first.name);
    const parent = await save("parent", config.workspacePaths[0]!);
    const child = await save("child", path + "/child");
    const deleted = await save("deleted");
    await callHandoffHost(ServiceChannels.Project, "deleteProject", [deleted.id, hostId]);
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: source.sourceServerId,
      workspacePath: path,
    });
    const confirm = async () => {
      await picker.$("input").setValue(path);
      await picker.$('button[type="submit"]').click();
      const button = picker.$('[data-testid="directory-browser-confirm"]');
      await button.waitForEnabled();
      await button.click();
      await $('[data-testid="chat-remote-project-pick"]').waitForDisplayed();
      const ids = await $$('[data-testid="chat-remote-project-pick"]').map((row) =>
        row.getAttribute("data-project-id"),
      );
      expect(ids.sort()).toEqual([first.id, second.id].sort());
      expect(ids).not.toContain(parent.id);
      expect(ids).not.toContain(child.id);
      expect(ids).not.toContain(deleted.id);
    };
    await confirm();
    expect(await getV4ComposerText()).toBe(marker + " retained original draft");
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    await browser.execute(() => {
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
        );
      document
        .querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]')
        ?.form?.requestSubmit();
    });
    expect((await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")).tasks).toEqual(
      localBefore.tasks,
    );
    for (const locale of ["zh-CN", "en-US"])
      for (const theme of ["light", "dark"]) {
        await browser.execute(
          (l, t) => {
            const actions = (
              window as Window & {
                __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
              }
            ).__testActions;
            actions?.setLocale(l);
            actions?.setTheme(t);
          },
          locale,
          theme,
        );
        await browser.electron.execute((electron) =>
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.setSize(480, 900),
        );
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        const layout = await browser.execute(() =>
          Array.from(document.querySelectorAll('[data-testid="chat-remote-project-pick"]')).map(
            (row) => ({
              id: row.getAttribute("data-project-id"),
              text: row.textContent,
              overflow: row.scrollWidth > row.clientWidth,
              height: row.getBoundingClientRect().height,
            }),
          ),
        );
        expect(layout.every((row) => !row.overflow && row.height > 0)).toBe(true);
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `choice-${locale}-${theme}.png`),
        );
      }
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.setSize(1440, 1000),
    );
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "choice-desktop.png"));
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    expect(await getV4ComposerText()).toBe(marker + " retained original draft");
    expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toBe(
      originalTargetLabel,
    );
    expect(
      (
        await callHandoffHost<SourceServerManagementSnapshot>(
          ServiceChannels.SourceServerManagement,
          "getSnapshot",
        )
      ).servers.some((item) => item.sourceServerId === source.sourceServerId),
    ).toBe(true);
    await setV4ComposerText("");
    const newDraft = async (project: VirtualProject) => {
      // 窄窗按产品规则收起侧栏；恢复桌面宽度后通过真实按钮展开，再进入项目新任务。
      if (
        await browser.execute(
          () =>
            document
              .querySelector("[data-workspace-sidebar-panel]")
              ?.classList.contains("pointer-events-none") ?? false,
        )
      )
        await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
      await browser.waitUntil(() =>
        browser.execute(() => {
          const panel = document.querySelector("[data-workspace-sidebar-panel]");
          return panel ? getComputedStyle(panel).opacity === "1" : false;
        }),
      );
      await $(`[data-project-id="${project.id}"]`).moveTo();
      await $(
        `[data-project-id="${project.id}"] [data-testid="virtual-project-create-task"]`,
      ).click();
    };
    const tasks: ProjectTree["tasks"] = [];
    for (const project of [first, second]) {
      await reconnect();
      await confirm();
      const row = $(`[data-testid="chat-remote-project-pick"][data-project-id="${project.id}"]`);
      expect(await row.getText()).toContain(project.id);
      // 键盘激活明确候选；同步在途窗口的重复点击由 UI 端口覆盖。
      await browser.execute(
        (id) =>
          document
            .querySelector<HTMLButtonElement>(
              `[data-testid="chat-remote-project-pick"][data-project-id="${id}"]`,
            )
            ?.focus(),
        project.id,
      );
      await browser.keys("Enter");
      await waitForRemoteTab({
        caseMarker: marker,
        expectedPath: path,
        expectedIdentity: identity,
      });
      await picker.waitForExist({ reverse: true });
      await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
        providerId: provider.id,
        providerName: provider.name,
      });
      await selectUpstreamThoughtLevelValue("disabled");
      await sendV4PromptAndWaitAccepted(
        marker + " " + project.id,
        marker,
        "首条消息必须进入显式所选项目",
      );
      await waitForV4AssistantMessageContaining("SSH_P0_TASK_LIFECYCLE_REPLY");
      const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
        { hostId },
      ]);
      const task = tree.tasks.find((item) => item.projectId === project.id)!;
      expect(task).toMatchObject({
        hostId,
        projectId: project.id,
        workspacePath: path,
        workspaceIdentity: identity,
      });
      tasks.push(task);
      for (const original of tasks)
        expect(tree.tasks.find((item) => item.taskId === original.taskId)).toMatchObject({
          taskId: original.taskId,
          projectId: original.projectId,
          workspaceIdentity: identity,
          workspacePath: path,
        });
      await newDraft(project);
    }
    await newDraft(first);
    await reconnect();
    await confirm();
    await callHandoffHost(ServiceChannels.Project, "deleteProject", [second.id, hostId]);
    await $(`[data-testid="chat-remote-project-pick"][data-project-id="${second.id}"]`).click();
    await picker.$('[role="alert"]').waitForDisplayed();
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    expect(await picker.isDisplayed()).toBe(true);
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId, includeDeleted: true },
    ]);
    expect(tree.projects.map((item) => item.id).sort()).toEqual(
      [...beforeRemoteIds, first.id, second.id, parent.id, child.id, deleted.id].sort(),
    );
    for (const original of tasks)
      expect(tree.tasks.find((item) => item.taskId === original.taskId)).toMatchObject({
        taskId: original.taskId,
        projectId: original.projectId,
      });
    const directory = await callHandoffHost<RemoteProjectDirectory>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    expect(
      directory.entries.filter((item) => item.hostId === hostId && item.projectId === first.id),
    ).toHaveLength(1);
    expect(
      (
        await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
          { hostId: "local" },
        ])
      ).tasks,
    ).toEqual(localBefore.tasks);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "choice-identities.json"),
      JSON.stringify({ projects: [first, second], tasks, directory }, null, 2),
    );
  });
});

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  readSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  openRemoteDevicesSettings,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import {
  bringRemoteDeviceOnline,
  execInRemoteContainer,
  readRemoteDockerContainer,
  takeRemoteDeviceOffline,
} from "#e2e/helpers/remote-docker-target";
import {
  prepareSSHConnectionPage,
  readHostProcesses,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  sendSSHFollowTurn,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  selectV4TaskById,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

const marker = "E2E_PROJECT_DEVICE_VISIBILITY_SSH";
const sharedName = "E2E shared project";
const switchSelector = '[data-testid="hide-project-device-names"]';
const row = (identity: string) =>
  $(`[data-project-workspace-identity=${JSON.stringify(identity)}]`);
async function screenshot(name: string) {
  await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `device-${name}.png`));
}
async function leaveDetails() {
  const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
  await browser.action("pointer").move(outside).perform();
  await $('[data-testid="remote-identity-details"]').waitForDisplayed({ reverse: true });
}
async function setHidden(hidden: boolean) {
  await openRemoteDevicesSettings();
  const control = $(switchSelector);
  await control.waitForDisplayed();
  if ((await control.getAttribute("aria-checked")) !== String(hidden)) await control.click();
  expect(await control.getAttribute("aria-checked")).toBe(String(hidden));
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}
async function assertRows(tasks: SSHLifecycleTask[], hidden: boolean) {
  for (const task of tasks) {
    const project = row(task.identity);
    await project.waitForDisplayed();
    await project.$('[data-testid="project-device"]').waitForExist({ reverse: hidden });
    expect(await project.getAttribute("data-project-name")).toBe(sharedName);
    expect(await project.getAttribute("data-project-workspace-identity")).toBe(task.identity);
    expect(await project.$("[data-remote-state-icon]").isExisting()).toBe(true);
  }
}
async function renameProject(task: SSHLifecycleTask) {
  await row(task.identity).moveTo();
  await row(task.identity).$('[data-testid="virtual-project-menu"]').click();
  await $('[data-testid="virtual-project-edit"]').click();
  await $('[data-testid="virtual-project-name"]').setValue(sharedName);
  await $('[data-testid="virtual-project-save"]').click();
  await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
  await browser.waitUntil(
    async () => (await row(task.identity).getAttribute("data-project-name")) === sharedName,
  );
}
async function selectProjectTask(task: SSHLifecycleTask) {
  // 项目已被用户改名且跨 Source 同名，任务归属必须按稳定身份验证，不能由目录名反推项目名。
  const project = row(task.identity);
  const toggle = project.$('[data-testid="virtual-project-toggle"]');
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await project
    .$(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, task.taskId))}]`)
    .waitForDisplayed();
  await selectV4TaskById(task.taskId, 30000);
}
async function verifyDetails(task: SSHLifecycleTask, deviceName: string) {
  await row(task.identity).$('[data-testid="virtual-project-toggle"]').moveTo();
  const details = $('[data-testid="remote-identity-details"]');
  await details.waitForDisplayed();
  const text = await details.getText();
  expect(text).toContain(deviceName);
  expect(text).toContain(task.workspacePath);
  expect(text).toContain("127.0.0.1");
  await screenshot(`details-${task.label}`);
  await leaveDetails();
}
async function verifyOtherWindowSynchronization() {
  const originalHandle = await browser.getWindowHandle();
  const previousHandles = await browser.getWindowHandles();
  // 复用产品 activate → createWindow 路径创建第二个真实窗口；不替换 store 或广播服务。
  const windowId = await browser.electron.execute(async (electron) => {
    const original = electron.BrowserWindow.getAllWindows;
    const created = new Promise<number>((resolve) => {
      electron.app.once("browser-window-created", (_event, window) => resolve(window.id));
    });
    electron.BrowserWindow.getAllWindows = () => [];
    try {
      electron.app.emit("activate");
      return await created;
    } finally {
      electron.BrowserWindow.getAllWindows = original;
    }
  });
  let secondHandle = "";
  try {
    await browser.waitUntil(
      async () => {
        secondHandle =
          (await browser.getWindowHandles()).find((handle) => !previousHandles.includes(handle)) ??
          "";
        return Boolean(secondHandle);
      },
      { timeout: 30000, timeoutMsg: "第二个应用窗口未创建" },
    );
    await browser.switchToWindow(secondHandle);
    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 60000 });
    await openRemoteDevicesSettings();
    expect(await $(switchSelector).getAttribute("aria-checked")).toBe("false");
    await browser.switchToWindow(originalHandle);
    await setHidden(true);
    await browser.switchToWindow(secondHandle);
    await browser.waitUntil(
      async () => (await $(switchSelector).getAttribute("aria-checked")) === "true",
      { timeout: 10000 },
    );
    await screenshot("second-window-synchronized");
  } finally {
    await browser.switchToWindow(originalHandle);
    await browser.electron.execute(
      (electron, id) => electron.BrowserWindow.fromId(id)?.close(),
      windowId,
    );
  }
}

describe(marker, () => {
  let provider: SSHLifecycleProvider | undefined;
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await screenshot("failure");
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "device-failure-page.txt"),
        await $("body").getText(),
      );
    }
  });
  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("真实 SSH 同名项目在隐藏设备名后仍能选任务、续发、重连与冷恢复", async function () {
    this.timeout(20 * 60_000);
    const container = readRemoteDockerContainer(marker);
    await prepareSSHConnectionPage(marker);
    const prepared = await prepareSSHLifecycle(marker);
    provider = prepared.provider;
    // 同一 Source 会给重名项目自动编号；独立账号拥有独立 Source，才能验证真正的同名项目。
    const secondConfig = { ...prepared.config, username: "visibility" };
    const secondPath = "/home/visibility/workspace";
    await execInRemoteContainer(
      container,
      ["useradd", "-m", "-s", "/bin/bash", secondConfig.username],
      { user: "0" },
    );
    await execInRemoteContainer(container, ["chpasswd"], {
      user: "0",
      input: `${secondConfig.username}:${prepared.config.password}\n`,
    });
    await execInRemoteContainer(container, ["mkdir", "-p", secondPath], {
      user: secondConfig.username,
    });
    const a = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: marker,
      config: prepared.config,
      provider,
      label: "A",
      workspacePath: prepared.config.workspacePaths[0],
    });
    const b = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: marker,
      config: secondConfig,
      provider,
      label: "B",
      workspacePath: secondPath,
    });
    const tasks = [a, b];
    const remoteCoreBefore = await readRemoteCoreIdentity(secondConfig, marker);
    await selectTaskOrganizeMode(["项目", "Project"]);
    const sourceIds = tasks.map(
      (task) => parseRemoteWorkspaceIdentity(task.identity)!.sourceServerId,
    );
    expect(sourceIds[0]).not.toBe(sourceIds[1]);
    const settings = await readSettings();
    const devices = sourceIds.map((id) => {
      const device = settings.sourceServers?.find((source) => source.sourceServerId === id);
      if (!device) throw new Error("真实 SSH Source 未登记");
      return device;
    });
    for (const task of tasks) await renameProject(task);
    await row(a.identity).moveTo();
    await row(a.identity).$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-pin"]').click();
    await row(a.identity).$(".lucide-pin").waitForExist();
    await assertRows(tasks, false);
    await screenshot("default-visible");
    await verifyOtherWindowSynchronization();
    await assertRows(tasks, true);
    for (let index = 0; index < tasks.length; index++)
      await verifyDetails(tasks[index]!, devices[index]!.displayName);
    expect(await $("[data-workspace-device-name]").getText()).toBe(devices[1]!.displayName);
    // 已保存任务的项目固定；项目切换菜单只在新草稿中可用，不能用历史任务页面验证该入口。
    await row(b.identity).moveTo();
    await row(b.identity).$('[data-testid="virtual-project-create-task"]').click();
    await waitForRemoteTab({
      caseMarker: marker,
      expectedIdentity: b.identity,
      expectedPath: b.workspacePath,
    });
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "项目新建没有进入草稿",
      30000,
    );
    // 行尾新建需要悬停项目行，身份浮层可能再次打开；先走真实移出/关闭，再操作输入框菜单。
    await leaveDetails();
    expect(await $('[data-testid="composer-workspace-trigger"]').getText()).toBe(sharedName);
    await $('[data-testid="composer-workspace-trigger"]').click();
    const menu = $('[data-testid="composer-project-menu"]');
    await menu.waitForDisplayed();
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index]!;
      const device = devices[index]!;
      await menu.$("input").setValue(device.displayName);
      const projectId = await row(task.identity).getAttribute("data-project-id");
      const option = menu.$(`[data-project-id=${JSON.stringify(projectId)}]`);
      await option.waitForDisplayed();
      expect(await option.getText()).toContain(device.displayName);
      expect(await option.getText()).toContain(sharedName);
    }
    await browser.keys("Escape");
    await leaveDetails();
    for (const task of tasks) {
      await selectProjectTask(task);
      await waitForV4AssistantMessageContaining(task.firstReply);
      await sendSSHFollowTurn(task, marker, task === a ? b.firstPrompt : a.firstPrompt);
    }
    await screenshot("hidden-tasks-working");
    await disconnectRemoteSource(sourceIds[0]!, marker, { workspaceIdentities: [a.identity] });
    expect(await row(b.identity).getAttribute("data-connection-state")).toBe("online");
    await disconnectRemoteSource(sourceIds[1]!, marker, { workspaceIdentities: [b.identity] });
    await assertRows(tasks, true);
    for (const task of tasks)
      expect(await row(task.identity).$('[data-testid="project-status-label"]').getText()).toBe(
        "离线",
      );
    await screenshot("hidden-offline");
    await requestRemoteProjectConnection(b.identity, marker);
    const reconnected = await waitForRemoteTab({
      caseMarker: marker,
      expectedIdentity: b.identity,
      expectedPath: b.workspacePath,
    });
    expect(reconnected.remoteSessionId).not.toBe(b.remoteSessionId);
    await assertRows(tasks, true);
    await selectProjectTask(b);
    await sendSSHFollowTurn(
      { ...b, remoteSessionId: reconnected.remoteSessionId! },
      marker,
      a.firstPrompt,
    );
    const oldHosts = await readHostProcesses();
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(marker);
    const cold = await waitForRemoteTab({
      caseMarker: marker,
      expectedIdentity: b.identity,
      expectedPath: b.workspacePath,
    });
    expect(cold.remoteSessionId).not.toBe(reconnected.remoteSessionId);
    expect(await readHostProcesses()).not.toEqual(oldHosts);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "冷启动未进入项目草稿",
      60000,
    );
    await assertRows(tasks, true);
    await openRemoteDevicesSettings();
    expect(await $(switchSelector).getAttribute("aria-checked")).toBe("true");
    for (const device of devices)
      expect(
        await $(`[data-source-server-card=${JSON.stringify(device.sourceServerId)}]`).getText(),
      ).toContain(device.displayName);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await row(a.identity).$(".lucide-pin").waitForExist();
    await selectProjectTask(b);
    await waitForV4AssistantMessageContaining(b.firstReply);
    await sendSSHFollowTurn(
      { ...b, remoteSessionId: cold.remoteSessionId! },
      marker,
      a.firstPrompt,
    );
    await screenshot("hidden-cold-restored");
    for (let index = 0; index < tasks.length; index++) {
      if ((await row(tasks[index]!.identity).getAttribute("data-connection-state")) === "online")
        await disconnectRemoteSource(sourceIds[index]!, marker, {
          workspaceIdentities: [tasks[index]!.identity],
        });
    }
    await takeRemoteDeviceOffline(container);
    try {
      await assertRows(tasks, true);
    } finally {
      await bringRemoteDeviceOnline(container, prepared.config);
    }
    await requestRemoteProjectConnection(b.identity, marker);
    await waitForRemoteTab({
      caseMarker: marker,
      expectedIdentity: b.identity,
      expectedPath: b.workspacePath,
    });
    await assertRows(tasks, true);
    await setHidden(false);
    await assertRows(tasks, false);
    const remoteCoreAfter = await readRemoteCoreIdentity(secondConfig, marker);
    await screenshot("restored-after-container-restart");
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "device-ssh-evidence.json"),
      JSON.stringify(
        {
          sourceIds,
          deviceNames: devices.map((device) => device.displayName),
          remoteCoreBefore,
          remoteCoreAfter,
          projects: tasks.map(({ identity, taskId, workspacePath }) => ({
            identity,
            taskId,
            workspacePath,
          })),
          verified: [
            "real-ssh",
            "same-name-projects",
            "pinned-project",
            "two-real-windows",
            "project-menu-search",
            "full-device-details",
            "task-history",
            "follow-turns",
            "disconnect-reconnect",
            "electron-cold-restart",
            "container-restart",
            "visibility-restored",
          ],
        },
        null,
        2,
      ),
    );
  });
});

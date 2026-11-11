import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_SSH_PORT_INPUT,
  TID_REMOTE_KIND_SSH,
  TID_CONFIRM_DIALOG_CONFIRM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readSettings,
} from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  connectRemoteSourceFromSettings,
  selectRemoteDeviceMenuItem,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { createStallableTcpProxy } from "#e2e/helpers/ssh-stallable-proxy";
import {
  connectSSHWorkspace,
  openRemoteProjectSelection,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
  readSSHRuntimeConfig,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_CONNECTION_MANAGEMENT";
const deviceName = "SSH guide device";
const primaryName = "SSH guide primary";
const scenario = process.env.R3_CONNECTION_MANAGEMENT_CASE ?? "edit";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-connection-management",
);

async function openSettings() {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()))
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
}

async function clickLabel(label: string, root = "[data-settings-content-frame]") {
  await browser.waitUntil(
    () =>
      browser.execute(
        (text, selector) => {
          const button = Array.from(
            document
              .querySelector(selector)
              ?.querySelectorAll<HTMLElement>('button, [role="menuitem"]') ?? [],
          ).find(
            (item) =>
              item.getClientRects().length &&
              item.textContent?.trim() === text &&
              !item.matches(":disabled"),
          );
          button?.click();
          return Boolean(button);
        },
        label,
        root,
      ),
    { timeout: 15_000, timeoutMsg: `${MARKER}: 缺少 ${label}` },
  );
}

async function clickLineAction(lineName: string, label: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, text) => {
          const button = Array.from(
            document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
          ).find((item) => {
            const line = item.closest("div.group\\/line") ?? item.parentElement;
            return (
              line?.textContent?.includes(name) &&
              (item.textContent?.trim() === text || item.getAttribute("aria-label") === text) &&
              !item.disabled
            );
          });
          button?.click();
          return Boolean(button);
        },
        lineName,
        label,
      ),
    { timeout: 15_000, timeoutMsg: `${MARKER}: ${lineName} 缺少 ${label}` },
  );
}

describe(`${MARKER}: 编辑、多连接默认值与移除`, () => {
  const facts: Record<string, unknown> = { scenario };
  let editedRoute: Awaited<ReturnType<typeof createStallableTcpProxy>> | undefined;
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "connection-management.json"),
      JSON.stringify(facts, null, 2),
    );
    await editedRoute?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`SSH-GUIDE-MANAGE ${scenario}: 编辑重连或默认/移除的独立场景`, async function () {
    this.timeout(15 * 60_000);
    if (!["edit", "lifecycle"].includes(scenario)) throw new Error("未知设备管理场景");
    const config = readSSHRuntimeConfig(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const first = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const second = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[1],
    });
    const sourceId = parseRemoteWorkspaceIdentity(first.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error("缺少设备身份");
    editedRoute = await createStallableTcpProxy(config);
    expect(
      (
        await runSSHCommand(
          config,
          `printf GUIDE_KEEP_REMOTE > '${config.workspacePaths[0]}/guide-remove-sentinel.txt'`,
        )
      ).code,
    ).toBe(0);
    await openSettings();
    // RDUX-13：编辑在设备行「更多」菜单里。
    await selectRemoteDeviceMenuItem(sourceId, ["编辑", "Edit"], MARKER);
    await $("#edit-connection-name").setValue(primaryName);
    await $("#edit-device-name").setValue(deviceName);
    if (scenario === "edit")
      await $(`[data-testid="${TID_SSH_PORT_INPUT}"]`).setValue(String(editedRoute.port));
    await clickLabel("保存更改", '[role="dialog"]');
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    const savedProfile = (await readSettings()).connectionProfiles?.find(
      (profile) => profile.displayName === primaryName,
    );
    expect(savedProfile?.target.kind === "ssh" ? savedProfile.target.port : null).toBe(
      scenario === "edit" ? editedRoute.port : config.port,
    );
    facts.savedRoutePort = scenario === "edit" ? editedRoute.port : config.port;
    // 留空凭据后必须真实重连成功，单看保存反馈不能证明旧密码仍可用。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    expect(
      (
        await waitForRemoteTab({
          caseMarker: MARKER,
          expectedIdentity: first.workspaceIdentity!,
          expectedPath: first.workspacePath!,
          requireActive: false,
        })
      ).remoteSessionId,
    ).toBe(first.remoteSessionId);
    expect(editedRoute.acceptedCount()).toBe(0);
    if (scenario === "edit") {
      await disconnectRemoteSource(sourceId, MARKER);
      // 断开按钮派发异步命令；必须等旧 attachment 释放，避免把旧在线 session 当重连成功。
      await browser.waitUntil(
        async () =>
          (await readRemoteTabSnapshot(first.workspaceIdentity!)).remoteSessionId === null,
        { timeout: 30_000 },
      );
      await requestRemoteProjectConnection(first.workspaceIdentity!, MARKER);
      await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: first.workspaceIdentity!,
        expectedPath: first.workspacePath!,
        requireActive: false,
      });
      const restoredSibling = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: second.workspaceIdentity!,
        expectedPath: second.workspacePath!,
        requireActive: false,
      });
      expect(restoredSibling.remoteSessionId).not.toBe(second.remoteSessionId);
      // Tab 的旧线路是兼容历史的提示，不能当作物理连接事实；实际收到新端口连接才证明修改生效。
      expect(editedRoute.acceptedCount()).toBeGreaterThan(0);
      const reconnectedProfiles = (await readSettings()).connectionProfiles?.filter(
        (profile) => profile.sourceServerId === sourceId && profile.lifecycleState !== "retired",
      );
      // 旧 target 曾被 Host 当成新线路注册；恢复原项目必须继续使用编辑过的原 Profile。
      expect(reconnectedProfiles).toHaveLength(1);
      expect(reconnectedProfiles?.[0]?.profileId).toBe(savedProfile?.profileId);
      expect(reconnectedProfiles?.[0]?.target).toMatchObject({ port: editedRoute.port });
      facts.editedRouteAcceptedCount = editedRoute.acceptedCount();
      facts.profileCountAfterReconnect = reconnectedProfiles?.length;
      facts.siblingRestored = true;
      facts.editedConnectionWorkedWithRetainedPassword = true;
      return;
    }

    // 在线时重复旧 target 只是复用现有连接；先释放再用独立 Host alias 实际认证，才能构造第二线路。
    await disconnectRemoteSource(sourceId, MARKER);
    await browser.waitUntil(
      async () => (await readRemoteTabSnapshot(first.workspaceIdentity!)).remoteSessionId === null,
      { timeout: 30_000 },
    );
    await openRemoteProjectSelection();
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    await fillSSHPasswordSettings({ ...config, host: "localhost" });
    await clickLastEnabledSSHDialogButton(MARKER);
    await waitForSSHDirectoryStep(MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[1], MARKER);
    await waitForRemoteTab({ caseMarker: MARKER, expectedPath: config.workspacePaths[1] });
    await browser.waitUntil(
      async () =>
        ((await readSettings()).connectionProfiles?.filter(
          (profile) => profile.sourceServerId === sourceId && profile.lifecycleState !== "retired",
        ).length ?? 0) === 2,
      { timeout: 30_000 },
    );
    const settings = await readSettings();
    const profiles =
      settings.connectionProfiles?.filter(
        (profile) => profile.sourceServerId === sourceId && profile.lifecycleState !== "retired",
      ) ?? [];
    expect(profiles).toHaveLength(2);
    const primary = profiles.find((profile) => profile.displayName === primaryName);
    const other = profiles.find((profile) => profile.profileId !== primary?.profileId);
    if (!primary || !other) throw new Error("两条连接未分别保留");
    const otherLabel =
      other.displayName ??
      (other.target.kind === "ssh" ? `${other.target.host}:${other.target.port}` : other.transport);
    expect(
      settings.sourceServers?.find((server) => server.sourceServerId === sourceId)
        ?.preferredProfileId,
    ).toBe(primary.profileId);
    await openSettings();
    // 保存线路默认折叠，展开后才有相应操作；不能把未展开的菜单当作按钮缺失。
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          // RDUX-13：其他已保存连接在设备行展开区；先展开设备行。
          const toggle = card?.querySelector<HTMLElement>("[data-source-server-toggle]");
          if (toggle?.getAttribute("aria-expanded") === "false") {
            toggle.click();
            return false;
          }
          const button = card?.querySelector<HTMLButtonElement>(
            'button[aria-label="其他已保存连接"]',
          );
          if (button?.getAttribute("aria-expanded") === "true") return true;
          button?.click();
          return Boolean(button);
        }, sourceId),
      { timeout: 15_000 },
    );
    await clickLineAction(otherLabel, "设为默认连接");
    await browser.waitUntil(
      async () =>
        (await readSettings()).sourceServers?.find((server) => server.sourceServerId === sourceId)
          ?.preferredProfileId === other.profileId,
    );
    expect(await $("[data-settings-content-frame]").getText()).toContain("默认");
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          // RDUX-13：其他已保存连接在设备行展开区；先展开设备行。
          const toggle = card?.querySelector<HTMLElement>("[data-source-server-toggle]");
          if (toggle?.getAttribute("aria-expanded") === "false") {
            toggle.click();
            return false;
          }
          const button = card?.querySelector<HTMLButtonElement>(
            'button[aria-label="其他已保存连接"]',
          );
          if (button?.getAttribute("aria-expanded") === "true") return true;
          button?.click();
          return Boolean(button);
        }, sourceId),
      { timeout: 15_000 },
    );
    await clickLabel("设为默认连接");
    await browser.waitUntil(
      async () =>
        (await readSettings()).sourceServers?.find((server) => server.sourceServerId === sourceId)
          ?.preferredProfileId === primary.profileId,
    );
    // 从设置按刚保存的默认线路重新连接，核验默认值实际生效，并让另一条线路成为可移除的保存线路。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await disconnectRemoteSource(sourceId, MARKER);
    await browser.waitUntil(
      async () => (await readRemoteTabSnapshot(first.workspaceIdentity!)).remoteSessionId === null,
      { timeout: 30_000 },
    );
    await connectRemoteSourceFromSettings(sourceId, MARKER);
    await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: first.workspaceIdentity!,
      expectedPath: first.workspacePath!,
      requireActive: false,
    });
    const directoryStep = await waitForSSHDirectoryStep(MARKER);
    if (directoryStep === "directory") {
      // 设置页连接进入目录选择；先按当前用户流程关闭该屏，避免 DOM 点击穿透到被遮挡的设置页。
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
            ).find((item) => /稍后选择|Choose later/iu.test(item.innerText) && !item.disabled);
            button?.click();
            return Boolean(button);
          }),
        { timeout: 15_000 },
      );
      await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true, timeout: 15_000 });
    }
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          // RDUX-13：其他已保存连接在设备行展开区；先展开设备行。
          const toggle = card?.querySelector<HTMLElement>("[data-source-server-toggle]");
          if (toggle?.getAttribute("aria-expanded") === "false") {
            toggle.click();
            return false;
          }
          const button = card?.querySelector<HTMLButtonElement>(
            'button[aria-label="其他已保存连接"]',
          );
          if (button?.getAttribute("aria-expanded") === "true") return true;
          button?.click();
          return Boolean(button);
        }, sourceId),
      { timeout: 15_000 },
    );
    await clickLineAction(otherLabel, "移除连接");
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    await browser.waitUntil(
      async () =>
        !(await readSettings()).connectionProfiles?.some(
          (profile) => profile.profileId === other.profileId,
        ),
    );
    expect(
      (await readSettings()).sourceServers?.some((server) => server.sourceServerId === sourceId),
    ).toBe(true);
    const primaryKey =
      primary.target.kind === "ssh" ? primary.target.passwordCredentialKey : undefined;
    const credentialsAfterLineRemoval = JSON.parse(
      await readFile(getE2EAppDataPaths().credentialsFile, "utf8"),
    );
    expect(Boolean(primaryKey && Object.hasOwn(credentialsAfterLineRemoval, primaryKey))).toBe(
      true,
    );
    facts.defaultAndRemoval = {
      retainedProfileId: primary.profileId,
      removedProfileId: other.profileId,
    };

    await $('[data-settings-content-frame] button[aria-label="更多"]').click();
    await clickLabel("移除设备", '[role="menu"]');
    const dialog = $('[role="dialog"]:has([data-testid="confirm-dialog-confirm"])');
    await dialog.waitForDisplayed();
    for (const path of config.workspacePaths) expect(await dialog.getText()).toContain(path);
    expect(await browser.execute(() => document.activeElement?.textContent)).toContain("取消");
    await browser.keys("Enter");
    await dialog.waitForDisplayed({ reverse: true });
    expect(
      (await readSettings()).sourceServers?.some((server) => server.sourceServerId === sourceId),
    ).toBe(true);
    await $('[data-settings-content-frame] button[aria-label="更多"]').click();
    await clickLabel("移除设备", '[role="menu"]');
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    await browser.waitUntil(
      async () =>
        !(await readSettings()).sourceServers?.some((server) => server.sourceServerId === sourceId),
    );
    expect(
      (await readSettings()).connectionProfiles?.some(
        (profile) => profile.sourceServerId === sourceId,
      ),
    ).toBe(false);
    const credentialsAfterDeviceRemoval = JSON.parse(
      await readFile(getE2EAppDataPaths().credentialsFile, "utf8"),
    );
    expect(Boolean(primaryKey && Object.hasOwn(credentialsAfterDeviceRemoval, primaryKey))).toBe(
      false,
    );
    const remote = await runSSHCommand(
      config,
      `cat '${config.workspacePaths[0]}/guide-remove-sentinel.txt'; test -f "$HOME/.zcode/server/current.json"`,
    );
    expect(remote.code).toBe(0);
    expect(remote.stdout).toBe("GUIDE_KEEP_REMOTE");
    facts.remoteDataAndInstallationPreserved = true;
  });
});

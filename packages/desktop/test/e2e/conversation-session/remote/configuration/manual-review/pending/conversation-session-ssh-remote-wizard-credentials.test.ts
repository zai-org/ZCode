import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { TID_CONFIRM_DIALOG_CONFIRM, TID_SSH_PASSWORD_INPUT } from "@zcode/shared/test-ids";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  clearAppData,
  removeSeededCredentials,
  readSettings,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  prepareSSHConnectionPage,
  openSSHSourceDirectory,
  readSSHRuntimeConfig,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
  openSSHRemoteDialog,
  fillSSHPasswordSettings,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_SSH_P0_WIZARD_CREDENTIALS";

async function waitForPasswordFocus(caseMarker: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (testId) => document.activeElement?.getAttribute("data-testid") === testId,
        TID_SSH_PASSWORD_INPUT,
      ),
    { timeout: 15_000, timeoutMsg: `${caseMarker}: 密码框未获得焦点` },
  );
}

// 用标题栏的关闭按钮（屏幕阅读器名称为“关闭”）关闭向导，与用户点击 × 的路径一致。
async function closeSSHDialog(caseMarker: string): Promise<void> {
  const clicked = await browser.execute(() => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
    ).find((item) => /^(关闭|Close)$/u.test(item.textContent?.trim() ?? "") && !item.disabled);
    button?.click();
    return Boolean(button);
  });
  if (!clicked) throw new Error(`${caseMarker}: 向导没有可用的关闭按钮`);
  const discard = $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
  if (await discard.waitForDisplayed({ timeout: 5_000 }).catch(() => false)) {
    await discard.click();
  }
  await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true, timeout: 30_000 });
}

async function readStageTitles(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="remote-connection-stages"] > li'),
    ).map((item) => item.innerText.trim()),
  );
}

describe(`${CASE_MARKER}: 向导凭据与已在线复用`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-06/07 缺密码可回填，手动连接在线目标明确提示复用", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[0],
    });
    const settings = await readSettings();
    const profile = settings.connectionProfiles?.find(
      (candidate) =>
        candidate.target.kind === "ssh" &&
        candidate.target.host === config.host &&
        candidate.target.username === config.username,
    );
    if (!profile?.sourceServerId || !tab.workspaceIdentity)
      throw new Error(`${CASE_MARKER}: 首次真实连接未保存设备身份`);
    await disconnectRemoteSource(profile.sourceServerId, CASE_MARKER);
    // 旧 Host 完全退出后再删除凭据值，保留引用，避免活跃 writer 覆盖用例前置。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const latest = await readSettings();
        const keys = (latest.connectionProfiles ?? []).flatMap((candidate) =>
          candidate.profileId === profile.profileId && candidate.target.kind === "ssh"
            ? [
                candidate.target.passwordCredentialKey,
                candidate.target.privateKeyPassphraseCredentialKey,
              ]
            : [],
        );
        for (const entry of latest.lastWorkspaceSession ?? []) {
          if (
            entry.kind === "remote" &&
            entry.target.kind === "ssh" &&
            entry.target.host === config.host
          )
            keys.push(
              entry.target.passwordCredentialKey,
              entry.target.privateKeyPassphraseCredentialKey,
            );
        }
        await removeSeededCredentials(keys.filter((key): key is string => Boolean(key)));
      },
    });
    // R8 跟进：缺凭据的项目重连在补密码时就显示“打开项目目录”这一步；关闭后设备级补密码仍是四步，
    // 不沿用上一次连接的目录。
    await requestRemoteProjectConnection(tab.workspaceIdentity, CASE_MARKER);
    await waitForPasswordFocus(CASE_MARKER);
    const projectStages = await readStageTitles();
    expect(projectStages).toHaveLength(5);
    expect(projectStages.at(-1)).toMatch(/打开项目目录|Open project folder/u);
    await closeSSHDialog(CASE_MARKER);
    // 已保存设备的连接入口在项目表单的设备选择里：选中离线设备并浏览目录时由向导补凭据。
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForPasswordFocus(CASE_MARKER);
    const deviceStages = await readStageTitles();
    expect(deviceStages).toHaveLength(4);
    expect(deviceStages.some((title) => /打开项目目录|Open project folder/u.test(title))).toBe(
      false,
    );
    await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    await waitForWorkspaceApp(config.workspacePaths[0], SSH_WORKSPACE_READY_TIMEOUT_MS);

    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings({ ...config, password: "unused-online-reuse-password" });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          /已直接使用现有连接|existing connection is now in use/u.test(
            document.body.textContent ?? "",
          ),
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 复用在线连接没有提示` },
    );
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    expect(await $('[data-testid="ssh-error"]').isExisting()).toBe(false);
  });
});

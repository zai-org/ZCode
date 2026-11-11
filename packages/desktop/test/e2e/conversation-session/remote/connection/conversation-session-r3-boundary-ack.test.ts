import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData, getE2EAppDataPaths, readSettings } from "#e2e/helpers/desktop-app";
import { expandRemoteDeviceRowsNeedingAttention } from "#e2e/helpers/remote-project-actions";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  holdBoundaryConnection,
  holdBoundarySetting,
  releaseBoundarySetting,
  restoreBoundaryProbes,
} from "#e2e/helpers/remote-boundary-probe";

const CASE_MARKER = "E2E_R3_BOUNDARY_ACK";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-boundary-ack");
const BOUNDARY = '[data-testid="source-server-boundary-dialog"]';
const STRICT_BOUNDARY = { allowBoundaryAcknowledgement: false };

async function readCredentialPresence() {
  const settings = await readSettings();
  const credentials = JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8"));
  const keys = (settings.connectionProfiles ?? [])
    .map((profile) =>
      profile.target.kind === "ssh" ? profile.target.passwordCredentialKey : undefined,
    )
    .filter((key): key is string => typeof key === "string");
  // 冷重启失败需区分“未保存”与“启动时丢失”；证据只记录存在性，不保存 key 或口令正文。
  return {
    passwordRefs: keys.length,
    presentRefs: keys.filter((key) => Object.hasOwn(credentials, key)).length,
  };
}

describe(`${CASE_MARKER}: 首次主动连接的持续运行介绍`, () => {
  const facts: Record<string, unknown> = {};
  after(async () => {
    await restoreBoundaryProbes();
    facts.credentialsAtEnd = await readCredentialPresence().catch(() => ({ readable: false }));
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "boundary-ack.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-UI-04/RDUX-11 首次连接必须点击知道了才记已读；第二项目及应用重启后不重复", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    expect((await readSettings()).remoteBoundaryIntroAcknowledgedVersion ?? 0).toBeLessThan(1);
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await holdBoundaryConnection();
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const intro = $(BOUNDARY);
    // 首装仍需显式确认安装；不能复用会顺便确认介绍页的 helper，否则测不到确认前的已读状态。
    await browser.waitUntil(
      async () => {
        if (await browser.electron.execute(() => Boolean(globalThis.__boundaryConnection?.held)))
          return true;
        return browser.execute(() => {
          const install = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
          ).find(
            (button) =>
              button.getClientRects().length > 0 &&
              !button.disabled &&
              /^(安装并继续|Install and continue)$/u.test(button.textContent?.trim() ?? ""),
          );
          install?.click();
          return false;
        });
      },
      { timeout: 180_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 真实连接没有到达完成屏障` },
    );
    // 连接完成时关闭确认仍占用全局对话框；取消关闭后必须继续同一介绍，不能丢失完成动作。
    await $('[data-testid="ssh-dialog"]').$('.//button[normalize-space(.)="关闭"]').click();
    const cancel = $('[data-testid="confirm-dialog-confirm"]')
      .$("..")
      .$('.//button[span[normalize-space(.)="取消"]]');
    await cancel.waitForDisplayed();
    await holdBoundarySetting("get");
    await browser.electron.execute(() => globalThis.__boundaryConnection?.release());
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__boundarySetting?.requests.length)),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 连接完成后没有读取介绍状态` },
    );
    await releaseBoundarySetting("get");
    expect(await intro.isExisting()).toBe(false);
    await cancel.click();
    await intro.waitForDisplayed({ timeout: 180_000 });
    expect((await readSettings()).remoteBoundaryIntroAcknowledgedVersion ?? 0).toBeLessThan(1);
    expect(await intro.getText()).toMatch(
      /本地离线，任务照常运行|Local offline, tasks keep running/u,
    );
    expect(await intro.$('[data-testid="confirm-dialog-cancel"]').isExisting()).toBe(false);
    await browser.keys("Escape");
    expect(await intro.isDisplayed()).toBe(true);
    expect((await readSettings()).remoteBoundaryIntroAcknowledgedVersion ?? 0).toBeLessThan(1);
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "first-connect-intro.png"));
    await holdBoundarySetting("update");
    await intro.$('[data-testid="confirm-dialog-confirm"]').click();
    await intro.waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__boundarySetting?.requests.length)),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 确认后没有保存介绍状态` },
    );
    // 确认发生在前台，但设置保存跨过收起；完成后必须等用户继续，不能恢复旧草稿。
    await $('[data-testid="ssh-dialog"] button[title^="收起"]').click();
    await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true });
    await releaseBoundarySetting("update");
    await browser.waitUntil(
      async () => (await readSettings()).remoteBoundaryIntroAcknowledgedVersion === 1,
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 明确确认后没有保存已读状态` },
    );
    const background = $('[data-testid="remote-connection-minimized"]');
    await browser.waitUntil(
      async () => {
        // RDUX-13：已识别设备的后台连接进度块在展开区；只展开提示“需要处理”的设备行。
        await expandRemoteDeviceRowsNeedingAttention();
        return background.isDisplayed();
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有显示后台连接完成入口` },
    );
    expect(await intro.isExisting()).toBe(false);
    expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
    await browser.saveScreenshot(resolve(artifactDir, "acknowledged-in-background.png"));
    await background.click();
    await waitForSSHDirectoryStep(CASE_MARKER, undefined, STRICT_BOUNDARY);
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await intro.isExisting()).toBe(false);
    await $('[data-testid="virtual-project-browse"]').click();
    await $('[data-testid="virtual-project-directory-browser"]').waitForDisplayed();
    expect(await intro.isExisting()).toBe(false);
    expect((await readSettings()).remoteBoundaryOnboardingVersion).not.toBe(3);
    facts.explicitAcknowledgement = true;
    facts.rollbackCompatibleAcknowledgement = true;
    facts.occupiedConfirmationRecovered = true;
    facts.persistenceMinimizeDeferredUntilContinue = true;
    await restoreBoundaryProbes();
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    const first = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[0],
    });
    facts.firstIdentity = first.workspaceIdentity;

    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER, undefined, STRICT_BOUNDARY);
    expect(await intro.isExisting()).toBe(false);
    await selectSSHRemoteDirectory(config.workspacePaths[1], CASE_MARKER);
    const second = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[1],
    });
    facts.secondProjectIntroductionAbsent = true;

    facts.credentialsBeforeRestart = await readCredentialPresence();
    expect(facts.credentialsBeforeRestart).toEqual({ passwordRefs: 1, presentRefs: 1 });
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(CASE_MARKER);
    expect((await readSettings()).remoteBoundaryIntroAcknowledgedVersion).toBe(1);
    // 运行时已确认两条项目行 online，后台空项目却没有 attachment；介绍页验收只依赖 Source 恢复。
    await browser.waitUntil(
      () =>
        browser.execute(
          (identities) =>
            identities.every(
              (identity) =>
                document.querySelector<HTMLElement>(
                  `[data-project-workspace-identity=${JSON.stringify(identity)}]`,
                )?.dataset.connectionState === "online",
            ),
          [first.workspaceIdentity, second.workspaceIdentity],
        ),
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 原项目设备未恢复在线`,
      },
    );
    facts.projectSourcesOnlineAfterRestart = true;
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER, undefined, STRICT_BOUNDARY);
    expect(await intro.isExisting()).toBe(false);
    facts.restartIntroductionAbsent = true;
    // 回归：历史重投影不能删除 Profile 密码；目录读取也必须真实成功。
    facts.credentialsAfterRestart = await readCredentialPresence();
    expect(facts.credentialsAfterRestart).toEqual({ passwordRefs: 1, presentRefs: 1 });
  });
});

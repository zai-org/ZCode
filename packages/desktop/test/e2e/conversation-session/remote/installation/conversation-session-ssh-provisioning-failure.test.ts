import { withCredentialFault } from "#e2e/helpers/credential-fault";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  waitForSSHError,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "SSH_PROVISIONING_FAILURE";

describe(CASE_MARKER, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-08 首次失败保留安全诊断，恢复凭据后失效默认不阻断连接", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    await prepareV4ConversationE2E({ skipProvider: true });
    const hosts = await readHostProcesses();
    const paths = getE2EAppDataPaths();
    const invalidCredential = "enc:v1:E2E_INVALID_PROVISIONING_CREDENTIAL";
    await withCredentialFault(
      paths.credentialsFile,
      "oauth:bigmodel:refresh_token",
      invalidCredential,
      async () => {
        await openSSHRemoteDialog(CASE_MARKER);
        await fillSSHPasswordSettings(config);
        await clickLastEnabledSSHDialogButton(CASE_MARKER);
        // 首装会停在安装确认；先驱动该步骤，才能观察真正的 provisioning 失败。
        await expect(waitForSSHDirectoryStep(CASE_MARKER)).rejects.toThrow("SSH 连接失败");
        expect(await waitForSSHError(CASE_MARKER)).toMatch(/连接失败|Connection failed/iu);
        // 现行错误页把技术代码收进折叠详情；按真实操作展开后验证，不要求主提示重复内部代码。
        await $('[data-testid="ssh-error"] summary').click();
        const details = $('[data-testid="ssh-error"] details pre');
        await details.waitForDisplayed();
        expect(await details.getText()).toContain("source-read-failed");
        const text = await browser.execute(
          () => document.querySelector('[data-testid="ssh-dialog"]')?.textContent ?? "",
        );
        expect(text).not.toContain(invalidCredential);
        expect(text).not.toContain(config.password);
        expect((await readRemoteTabSnapshot()).remoteSessionId).toBeNull();
      },
    );

    const defaultModelSelection = {
      providerId: "e2e-removed-provider",
      modelId: "e2e-removed-model",
    };
    const personal = new NodePersonalProviderConfigRepository({
      filePath: paths.configFile,
      pollingIntervalMs: false,
    });
    try {
      await personal.update((current) => ({ ...current, defaultModelSelection }));
      await $('[data-testid="ssh-error"]')
        .$('.//button[normalize-space(.)="重试" or normalize-space(.)="Retry"]')
        .click();
      await waitForSSHDirectoryStep(CASE_MARKER);
      await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
      await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);
      const tab = await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedPath: workspacePath,
      });
      expect(parseRemoteWorkspaceIdentity(tab.workspaceIdentity!)).toMatchObject({
        kind: "server",
        workspacePath,
      });
      expect(tab.remoteHost).toBe(config.host);
      expect(tab.secretPersistedInTab).toBe(false);
      expect((await personal.read()).defaultModelSelection).toEqual(defaultModelSelection);
      expect(await readHostProcesses()).toEqual(hosts);
    } finally {
      personal.dispose();
    }
  });
});

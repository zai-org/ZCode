import { ServiceChannels } from "@zcode/shared";
import { TID_SSH_PASSWORD_INPUT } from "@zcode/shared/test-ids";
import type { RemoteProjectDirectory } from "@zcode/services";
import {
  clearAppData,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  prepareSSHConnectionPage,
  readHostProcesses,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  waitForSSHError,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_SSH_COLON_USERNAME";

describe(`${CASE_MARKER}: SSH 用户名中的冒号`, () => {
  after(async () => {
    await browser.execute(() => window.__remoteProjectHandoffRpc?.restore());
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-09 含冒号用户名认证失败后可重试成功，目录与稳定身份正常", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const username = `${config.username}:tenant`;
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    const initialHosts = await readHostProcesses();
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings({ ...config, username, password: `${config.password}-invalid` });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);

    // 缺陷曾在本地身份解析时终止连接；错误密码应到达真实 SSH 认证，并保留可读的失败状态。
    const error = await waitForSSHError(CASE_MARKER);
    expect(error).toMatch(/authentication|认证/iu);
    expect(error).not.toContain("invalid-host-identity");
    expect(error).not.toContain(config.password);

    const directory = await callHandoffHost<RemoteProjectDirectory>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    const host = directory.hosts.find(
      (item) => item.target?.kind === "ssh" && item.target.username === username,
    );
    expect(host).toMatchObject({
      id: `remote:ssh:${config.host}:${config.port}:${username}`,
      connectionStatus: "offline",
      target: { kind: "ssh", username },
    });
    expect(host?.lastConnectionError).not.toContain("invalid-host-identity");
    expect(await readHostProcesses()).toEqual(initialHosts);

    await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    if ((await waitForSSHDirectoryStep(CASE_MARKER)) === "closed") {
      await openSSHSourceDirectory({ ...config, username }, CASE_MARKER);
    }
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    await waitForWorkspaceApp(config.workspacePaths[0], SSH_WORKSPACE_READY_TIMEOUT_MS);
    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[0],
    });
    const connected = await callHandoffHost<RemoteProjectDirectory>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    const onlineHost = connected.hosts.find(
      (item) => item.target?.kind === "ssh" && item.target.username === username,
    );
    expect(onlineHost?.id).toMatch(/^remote:server:/u);
    expect(onlineHost?.connectionStatus).toBe("online");
    expect(connected.hosts.some((item) => item.id === host?.id)).toBe(false);
    expect(tab.workspaceIdentity).toBe(`${onlineHost?.id}:${config.workspacePaths[0]}`);
    expect(tab.secretPersistedInTab).toBe(false);
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});

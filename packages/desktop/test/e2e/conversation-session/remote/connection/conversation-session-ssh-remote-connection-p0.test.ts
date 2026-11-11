import { TID_SSH_PASSWORD_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  waitForWorkspaceApp,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  waitForSSHError,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "SSH_P0_CONNECTION";

async function readRemoteWorkspaceTabCount(): Promise<number> {
  return browser.execute(() => {
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState: () => {
            tabs: Array<{
              remoteTarget?: unknown;
              remoteSessionId?: string;
              workspaceIdentity?: string;
            }>;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    if (!store) throw new Error("SSH P0 缺少真实 tab store 取证入口");
    return store
      .getState()
      .tabs.filter(
        (tab) =>
          tab.remoteTarget || tab.remoteSessionId || tab.workspaceIdentity?.startsWith("remote:"),
      ).length;
  });
}

describe(`${CASE_MARKER}: SSH password 连接 P0`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-02/01 错误密码失败后，以正确密码重试并选择远端目录", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => {
      const state = window as Window & {
        __connectionLogs?: Array<{ message: string; level: string }>;
        zcode?: {
          onRemoteConnectionLog: (
            callback: (entry: { message: string; level: string }) => void,
          ) => () => void;
        };
      };
      state.__connectionLogs = [];
      if (!state.zcode) throw new Error("Missing desktop platform");
      state.zcode.onRemoteConnectionLog((entry) =>
        state.__connectionLogs!.push({ message: entry.message, level: entry.level }),
      );
    });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);
    expect(await readRemoteWorkspaceTabCount()).toBe(0);

    await openSSHRemoteDialog(CASE_MARKER);
    const invalidPassword = `${config.password}-e2e-invalid`;
    await fillSSHPasswordSettings({
      ...config,
      password: invalidPassword,
    });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const errorText = await waitForSSHError(CASE_MARKER);
    expect(errorText).not.toContain(config.password);
    expect(errorText).not.toContain(invalidPassword);
    expect((await readRemoteTabSnapshot(undefined, workspacePath)).remoteSessionId).toBeNull();
    expect(await readRemoteWorkspaceTabCount()).toBe(0);
    expect(await readHostProcesses()).toEqual(initialHosts);

    const authenticationState = await browser.execute(() => ({
      inlineCredentials: Boolean(
        document.querySelector('[data-testid="ssh-error"] input[type="password"]')?.closest("li"),
      ),
      failureText: document.querySelector('[data-testid="ssh-error"]')?.textContent,
      visibleLog: document.querySelector('[data-testid="remote-connection-log"]')?.textContent,
    }));
    expect(authenticationState).toMatchObject({ inlineCredentials: true });
    expect(await $('[data-testid="remote-connection-settings-scroll"]').isExisting()).toBe(false);
    expect(await $('[data-testid="remote-connection-log"]').isExisting()).toBe(true);
    await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const retryFlow = await waitForSSHDirectoryStep(CASE_MARKER);
    if (retryFlow === "closed") {
      // 已保存线路可能直接恢复原项目；从该 Source 的目录入口选择本次目标。
      await openSSHSourceDirectory(config, CASE_MARKER);
    }
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspacePath,
    });
    expect(tab.remoteKind).toBe("ssh");
    expect(tab.remoteHost).toBe(config.host);
    expect(tab.secretPersistedInTab).toBe(false);
    const logs = await browser.execute(
      () =>
        (window as Window & { __connectionLogs?: Array<{ message: string; level: string }> })
          .__connectionLogs ?? [],
    );
    expect(logs.length).toBeGreaterThan(0);
    const text = logs.map((entry) => entry.message).join("\n");
    for (const secret of [
      config.password,
      invalidPassword,
      "setting.json",
      "workspacePath",
      "credentialRef",
      "profileId",
      "sourceServerId",
    ]) {
      // 测试密码可能是用户名等短词；按词边界判定，避免把 device 里的 dev 当成凭据泄漏。
      if (secret === config.password && secret.length < 8) {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        expect(text).not.toMatch(
          new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u"),
        );
      } else expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(
      /\/Users\/|[A-Za-z]:\\Users\\|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu,
    );
    const confirmation = logs.filter((entry) =>
      entry.message.includes("requires explicit user confirmation"),
    );
    for (const entry of confirmation) expect(entry.level).toBe("info");

    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});

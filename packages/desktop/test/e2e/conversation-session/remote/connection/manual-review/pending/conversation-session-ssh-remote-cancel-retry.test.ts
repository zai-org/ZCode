import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  createFirstConnectionStallingSSHProxy,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readHostProcesses,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type FirstConnectionStallingSSHProxy,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_SSH_P0_CANCEL_RETRY";
const CONNECTION_CLOSE_TIMEOUT_MS = 30_000;

describe(`${CASE_MARKER}: SSH pending cancel 后立即重试`, () => {
  let proxy: FirstConnectionStallingSSHProxy | null = null;

  after(async () => {
    try {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      await proxy?.close();
      proxy = null;
    }
  });

  it("SSH-P0-CONN-03 停止 pending 连接后，同 target 使用新凭据重试", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    proxy = await createFirstConnectionStallingSSHProxy(config, CASE_MARKER);
    const proxiedConfig = {
      ...config,
      host: "127.0.0.1",
      port: proxy.port,
    };
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings({
      ...proxiedConfig,
      password: "cancelled-attempt",
    });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await proxy.firstConnectionAccepted;

    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
          );
          const button = buttons.find((item) =>
            ["取消连接", "Cancel connection"].includes(item.textContent?.trim() ?? ""),
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        }),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 连接中主按钮不可取消` },
    );
    await waitForPromise(
      proxy.waitForFirstConnectionClosed(),
      CONNECTION_CLOSE_TIMEOUT_MS,
      `${CASE_MARKER}: 取消后首个 SSH socket 没有关闭`,
    );
    // 失败录像显示取消已返回项目草稿；旧断言仍等待关闭向导内的“已取消”，误报为错误。
    await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await $('[data-testid="ssh-error"]').isExisting()).toBe(false);
    expect(await readHostProcesses()).toEqual(initialHosts);
    await openSSHRemoteDialog(CASE_MARKER);

    await fillSSHPasswordSettings(proxiedConfig);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const retryFlow = await waitForSSHDirectoryStep(CASE_MARKER);
    if (retryFlow === "closed") {
      // 重试连接成功后向导按新合同自动收起（openConversation），从设备行进目录选择。
      await openSSHSourceDirectory(proxiedConfig, CASE_MARKER);
    }
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspacePath,
    });
    expect(tab.remoteSessionId).toBeTruthy();
    const parsedIdentity = tab.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity)
      : null;
    expect(parsedIdentity).toMatchObject({
      kind: "server",
      workspacePath,
    });
    expect(tab.secretPersistedInTab).toBe(false);
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

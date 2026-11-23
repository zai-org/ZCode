// LRCD-02：已有 SSH Profile 的保存密码在本机无法解密（~/.zcode 换机 / 换用户）。
// 冷启动后从侧栏项目菜单点“连接”：连接屏要求补充密码，补充后连上原项目，并覆盖原凭据。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_SSH_DIALOG, TID_SSH_PASSWORD_INPUT } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  readSettings,
  seedSettings,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { waitForProjectRow } from "#e2e/helpers/project-sidebar";
import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  clickLastEnabledSSHDialogButton,
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_PROFILE_SECRET_DECRYPT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/profile-secret-decrypt",
);
// IV/AuthTag 长度合法、内容为零：本机任何密钥都无法通过 GCM 校验（与 LRCD-01 相同的构造）。
const UNDECRYPTABLE_VALUE = [
  "enc:v1:",
  Buffer.alloc(12).toString("base64url"),
  ".",
  Buffer.alloc(16).toString("base64url"),
  ".",
  Buffer.from(MARKER).toString("base64url"),
].join("");

type SSHProfileLike = { target: { kind: string; port?: number; passwordCredentialKey?: string } };

async function readPasswordCredentialKey(port: number): Promise<string | undefined> {
  const profiles = ((await readSettings()).connectionProfiles ?? []) as SSHProfileLike[];
  return profiles.find((item) => item.target.kind === "ssh" && item.target.port === port)?.target
    .passwordCredentialKey;
}

function isPasswordPromptVisible(): Promise<boolean> {
  return browser.execute(
    (dialogTestId, inputTestId) =>
      Boolean(
        document
          .querySelector(`[data-testid="${dialogTestId}"] [data-testid="${inputTestId}"]`)
          ?.getClientRects().length,
      ),
    TID_SSH_DIALOG,
    TID_SSH_PASSWORD_INPUT,
  );
}

describe(`${MARKER}: Profile 密码在本机无法解密`, () => {
  const facts: Record<string, unknown> = {};
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "profile-secret.json"), JSON.stringify(facts, null, 2));
    await clearAppData();
  });

  it("LRCD-02 点项目连接要求补充密码，补充后连上原项目并覆盖原凭据", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    const workspacePath = config.workspacePaths[0]!;
    const { credentialsFile } = getE2EAppDataPaths();
    await prepareV4ConversationE2E({ skipProvider: true });
    const kept = await connectSSHWorkspace({ caseMarker: MARKER, config, workspacePath });
    const key = await readPasswordCredentialKey(config.port);
    expect(key).toBeTruthy();

    // 退出应用后把这条密码换成本机解不开的密文，等同把 ~/.zcode 带到另一台机器。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const credentials = JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<
          string,
          string
        >;
        credentials[key!] = UNDECRYPTABLE_VALUE;
        await writeFile(credentialsFile, JSON.stringify(credentials), "utf-8");
        await seedSettings({ remoteStartupAutoReconnectEnabled: true });
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    await waitForProjectRow(DEFAULT_WORKSPACE, {
      timeout: 60_000,
      timeoutMsg: `${MARKER}: 冷启动后本地项目没有出现在侧栏`,
    });

    await requestRemoteProjectConnection(kept.workspaceIdentity!, MARKER);
    // 修复前 Renderer 直接读取凭据，解密错误被当成普通失败：项目行显示“连接失败”，不出现密码框。
    await browser
      .waitUntil(isPasswordPromptVisible, { timeout: 90_000, interval: 500 })
      .catch(() => undefined);
    facts.passwordPrompted = await isPasswordPromptVisible();
    facts.dialogText = await browser.execute(
      (dialogTestId) =>
        document.querySelector<HTMLElement>(`[data-testid="${dialogTestId}"]`)?.innerText ?? null,
      TID_SSH_DIALOG,
    );
    facts.rowText = await browser.execute(
      (identity) =>
        document.querySelector<HTMLElement>(
          `[data-project-workspace-identity=${JSON.stringify(identity)}]`,
        )?.innerText ?? null,
      kept.workspaceIdentity!,
    );
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "needs-password.png"));
    expect(facts.passwordPrompted).toBe(true);

    await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
    await clickLastEnabledSSHDialogButton(MARKER);
    if ((await waitForSSHDirectoryStep(MARKER)) === "directory") {
      await selectSSHRemoteDirectory(workspacePath, MARKER);
    }
    const tab = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: kept.workspaceIdentity!,
      expectedPath: workspacePath,
    });
    facts.reconnectedSessionId = tab.remoteSessionId ?? null;
    expect(tab.remoteSessionId).toBeTruthy();

    // 补充的密码写回 Profile 引用的 key，不再是解不开的旧密文。
    const keyAfter = await readPasswordCredentialKey(config.port);
    const credentialsAfter = JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<
      string,
      string
    >;
    facts.credentialReplaced = Boolean(
      keyAfter && credentialsAfter[keyAfter] && credentialsAfter[keyAfter] !== UNDECRYPTABLE_VALUE,
    );
    expect(facts.credentialReplaced).toBe(true);
  });
});

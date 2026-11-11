import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  waitForSSHError,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_CONNECTION_LOG_CONTRACT";

describe(`${CASE_MARKER}: 连接失败与反馈日志`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-LOG 未占用端口在 5 秒内结束，反馈日志无本地配置", async () => {
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings({ ...config, host: "localhost", port: address.port });
    const started = Date.now();
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const error = await waitForSSHError(CASE_MARKER);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(error).toMatch(/无法连接到主机|Unable to connect to host/u);
    const logs = await $('[data-testid="remote-connection-log"]').getText();
    for (const secret of [
      config.password,
      "setting.json",
      "workspacePath",
      "credentialRef",
      "sourceServerId",
      "profileId",
    ])
      expect(logs).not.toContain(secret);
    expect(logs).not.toMatch(
      /\/Users\/|[A-Za-z]:\\Users\\|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu,
    );
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-log-contract",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await browser.execute((value) => {
        const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
          .__testActions;
        if (!actions) throw new Error("Missing theme test actions");
        actions.setTheme(value);
      }, theme);
      for (const width of [1400, 480]) {
        await browser.electron.execute((electron, nextWidth) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => !window.isDestroyed())
            ?.setSize(nextWidth, 900);
        }, width);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        await browser.saveScreenshot(resolve(artifactDir, `connection-log-${theme}-${width}.png`));
      }
    }
    const buttons = await $$('[data-testid="ssh-dialog"] button');
    for (const button of buttons) {
      if (/反馈|Feedback/u.test(await button.getText())) {
        await button.click();
        break;
      }
    }
    await browser.waitUntil(
      async () => await browser.execute(() => document.querySelectorAll("textarea").length > 0),
      { timeout: 5000 },
    );
    const description = await browser.execute(() =>
      [...document.querySelectorAll("textarea")].map((el) => el.value).join("\n"),
    );
    expect(description).toMatch(/连接日志|Connection log/iu);
    expect(description).not.toContain(config.password);
    expect(description).not.toMatch(
      /setting\.json|workspacePath|credentialRef|sourceServerId|\/Users\//u,
    );
  });
});

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { TID_TASK_SETTINGS_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  readSettings,
  clickTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectRemoteDeviceMenuItem } from "#e2e/helpers/remote-project-actions";
import {
  prepareSSHConnectionPage,
  openRemoteConnectionSelection as openSelection,
  readSSHRuntimeConfig,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";

const MARKER = "E2E_SSH_THREE_SCREEN";
const alias = "rdux10-first-connect";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/three-screen");

async function clickButton(text: string) {
  await browser.waitUntil(
    () =>
      browser.execute((label) => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).find(
          (item) =>
            item.getClientRects().length &&
            !item.disabled &&
            (item.textContent?.includes(label) || item.getAttribute("aria-label") === label),
        );
        if (!button) return false;
        button.click();
        return true;
      }, text),
    { timeout: 30_000, timeoutMsg: `${MARKER}: missing action ${text}` },
  );
}
async function capture(name: string) {
  await mkdir(artifactDir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await browser.execute((value) => {
      const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
        .__testActions;
      if (!actions) throw new Error("Missing theme test actions");
      actions.setTheme(value);
    }, theme);
    for (const width of [1440, 900]) {
      await browser.electron.execute((electron, size) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed())
          ?.setSize(size, 900);
      }, width);
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      await browser.saveScreenshot(join(artifactDir, `${name}-${theme}-${width}.png`));
      const overflow = await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]');
        return Boolean(
          dialog &&
          (dialog.scrollWidth > dialog.clientWidth + 1 ||
            dialog.getBoundingClientRect().bottom > innerHeight),
        );
      });
      expect(overflow).toBe(false);
    }
  }
}

describe(`${MARKER}: 设置分类添加与连接反馈`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-10-01/03/04 首次添加、离线重连、收起失败与关闭草稿", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    await prepareSSHConnectionPage(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const sshDir = join(dirname(DEFAULT_WORKSPACE), ".ssh");
    const configPath = join(sshDir, "config");
    await mkdir(sshDir, { recursive: true });
    await writeFile(
      configPath,
      `Host ${alias}\n  HostName ${config.host}\n  Port ${config.port}\n  User ${config.username}\n`,
      { mode: 0o600 },
    );
    const sockets = new Set<Socket>();
    let acceptedConnections = 0;
    const pendingServer = createServer((socket) => {
      acceptedConnections += 1;
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    });
    try {
      await openSelection();
      await capture("selection");
      await browser.execute(() => {
        const counts = { clicks: 0, inputs: [] as string[] };
        (window as Window & { __wizardCounts?: typeof counts }).__wizardCounts = counts;
        document.addEventListener("click", (event) => {
          if ((event.target as Element)?.closest('[data-testid="ssh-dialog"] button'))
            counts.clicks += 1;
        });
        document.addEventListener("input", (event) => {
          const element = event.target as HTMLInputElement;
          if (!element.closest('[data-testid="ssh-dialog"]')) return;
          const id = element.dataset.testid || element.name || element.type;
          if (!counts.inputs.includes(id)) counts.inputs.push(id);
        });
      });
      await $('[data-testid="remote-ssh-config-import"]').waitForEnabled({ timeout: 30_000 });
      await $('[data-testid="remote-ssh-config-import"]').click();
      await $(`//*[@cmdk-item and .//*[normalize-space(.)=${JSON.stringify(alias)}]]`).click();
      await $('[data-testid="ssh-dialog"] input[type="password"]').setValue(config.password);
      await clickLastEnabledSSHDialogButton(MARKER);
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
            ).some((button) => /安装并继续|Install and continue/u.test(button.textContent ?? "")),
          ),
        { timeout: 60_000, timeoutMsg: `${MARKER}: 首装 fixture 未出现安装确认` },
      );
      const releaseVersion = (
        JSON.parse(
          // 按当前 spec 位置读取仓库版本，不能沿用 pending 的目录深度。
          await readFile(new URL("../../../../../../../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version;
      expect(await $('[data-testid="remote-install-version"]').getText()).toBe(releaseVersion);
      expect(await $('[data-testid="remote-install-path"]').getText()).toBe(
        `/home/${config.username}/.zcode/server`,
      );
      expect(
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid="remote-install-path"]')?.closest("li")),
        ),
      ).toBe(true);
      expect(await $('[data-testid="remote-connection-log"]').isExisting()).toBe(false);
      await capture("install-confirmation");
      expect(await waitForSSHDirectoryStep(MARKER)).toBe("closed");
      expect(await $('[data-testid="settings-page"]').isDisplayed()).toBe(true);
      expect(await $$('[data-testid="virtual-project-name"]').length).toBe(0);
      await capture("device-added");
      const counts = await browser.execute(
        () =>
          (window as Window & { __wizardCounts?: { clicks: number; inputs: string[] } })
            .__wizardCounts,
      );
      await writeFile(
        join(artifactDir, "first-connect-actions.json"),
        JSON.stringify(counts, null, 2),
      );
      const settings = await readSettings();
      const profile = settings.connectionProfiles?.find(
        (item) => item.target.kind === "ssh" && item.target.sshConfigAlias === alias,
      );
      if (!profile?.sourceServerId) throw new Error(`${MARKER}: missing saved Source`);
      // 通用项目 helper 断开后会返回侧栏；本场景留在设置，按 Source 设备行完成断开与状态断言。
      const deviceCard = $(`[data-source-server-card="${profile.sourceServerId}"]`);
      await selectRemoteDeviceMenuItem(profile.sourceServerId, ["断开", "Disconnect"], MARKER);
      await deviceCard.$('[data-remote-connection-status="offline"]').waitForExist();
      await openSelection();
      await $('[data-testid="remote-ssh-config-import"]').waitForEnabled({ timeout: 30_000 });
      await $('[data-testid="remote-ssh-config-import"]').click();
      await $(`//*[@cmdk-item and .//*[normalize-space(.)=${JSON.stringify(alias)}]]`).click();
      await $('[data-testid="ssh-password-input"]').setValue(config.password);
      await clickLastEnabledSSHDialogButton(MARKER);
      expect(await waitForSSHDirectoryStep(MARKER)).toBe("closed");
      expect(await $$("[data-source-server-card]").length).toBe(1);
      await capture("device-reconnected");

      await new Promise<void>((yes, no) => {
        pendingServer.once("error", no);
        pendingServer.listen(0, "127.0.0.1", yes);
      });
      const address = pendingServer.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      await openSelection();
      await $('[data-testid="remote-kind-ssh"]').click();
      await capture("new-ssh");
      await fillSSHPasswordSettings({ ...config, host: "127.0.0.1", port: address.port });
      await clickLastEnabledSSHDialogButton(MARKER);
      await browser.waitUntil(() => sockets.size > 0, { timeout: 15_000 });
      await clickButton("收起");
      // 缺陷原因：进度卡已迁到设置，旧用例离开设置后仍等侧栏卡会永久超时。
      // 先验证后台不抢项目页，再由用户返回设置查看同一连接。
      await $('[data-testid="settings-back-button"]').click();
      await $('[data-testid="project-section"]').waitForDisplayed();
      await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
      expect(await $('[data-testid="remote-connection-minimized"]').isDisplayed()).toBe(false);
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
      await $('[data-testid="remote-connection-minimized"]').waitForDisplayed();
      expect(await $('[data-testid="remote-connection-minimized"]').getText()).toContain(
        `127.0.0.1:${address.port}`,
      );
      for (const socket of sockets) socket.destroy();
      await browser.waitUntil(
        async () =>
          /失败|failed/iu.test(await $('[data-testid="remote-connection-minimized"]').getText()),
        { timeout: 60_000 },
      );
      // 收起的退出动画会短暂保留 DOM；等待卸载后再验证后台失败没有重新打开。
      await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true, timeout: 5000 });
      await capture("minimized-failure");
      const connectionsBeforeReview = acceptedConnections;
      await $('[data-testid="remote-connection-minimized"]').click();
      await $('[data-testid="ssh-error"]').waitForDisplayed();
      expect(acceptedConnections).toBe(connectionsBeforeReview);
      const failureActions = await browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).map((button) => button.textContent?.trim() ?? ""),
      );
      expect(failureActions).toContain("新建连接");
      expect(failureActions).not.toContain("取消连接");
      // 查看保留 A 的失败；先显式取消 A，再发起 B，不能用新入口静默覆盖后台操作。
      await clickButton("收起");
      await $("[data-background-connection]")
        .$('.//button[normalize-space(.)="取消此连接"]')
        .click();
      await $('[data-testid="remote-connection-minimized"]').waitForExist({ reverse: true });
      await openSelection();
      await $('[data-testid="ssh-host-input"]').waitForDisplayed();
      expect(await $('[data-testid="ssh-error"]').isExisting()).toBe(false);
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(MARKER);
      expect(await waitForSSHDirectoryStep(MARKER)).toBe("closed");
      await capture("new-intent-device-complete");
      await openSelection();
      await $('[data-testid="remote-kind-ssh"]').click();
      expect(await $('[data-testid="ssh-host-input"]').getValue()).toBe("");
      expect(await $('[data-testid="ssh-port-input"]').getValue()).toBe("22");
      expect(await $('[data-testid="ssh-password-input"]').getValue()).toBe("");
      await clickButton("关闭");
    } finally {
      for (const socket of sockets) socket.destroy();
      if (pendingServer.listening)
        await new Promise<void>((yes) => pendingServer.close(() => yes()));
      await rm(configPath, { force: true });
    }
  });
});

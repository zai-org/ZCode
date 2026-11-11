import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectRemoteDeviceMenuItem } from "#e2e/helpers/remote-project-actions";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_PRESENTATION_STATES";

describe(`${CASE_MARKER}: 远程连接展示`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-STATE 主动断开后设置和侧栏均显示中性未连接", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const path = config.workspacePaths[0];
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(path, CASE_MARKER);
    await waitForWorkspaceApp(path, 120_000);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: path });
    await browser.waitUntil(
      async () =>
        await browser.execute((identity) => {
          const row = [
            ...document.querySelectorAll<HTMLElement>("[data-project-workspace-identity]"),
          ].find((item) => item.dataset.projectWorkspaceIdentity === identity);
          return row?.dataset.connectionState === "online";
        }, tab.workspaceIdentity),
      { timeout: 20_000 },
    );
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    await browser.execute(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
        /^(远程设备|Remote devices)$/u.test(item.textContent?.trim() ?? ""),
      );
      if (!button) throw new Error("Remote devices navigation missing");
      button.click();
    });
    await $('[data-remote-connection-status="online"]').waitForDisplayed();
    // RDUX-13：断开在设备行「更多」菜单里。
    const onlineSourceId = await browser.execute(
      () =>
        document
          .querySelector('[data-remote-connection-status="online"]')
          ?.closest("[data-source-server-card]")
          ?.getAttribute("data-source-server-card") ?? null,
    );
    if (!onlineSourceId) throw new Error("Online device row missing");
    await selectRemoteDeviceMenuItem(onlineSourceId, ["断开", "Disconnect"], CASE_MARKER);
    const status = $('[data-remote-connection-status="offline"]');
    await status.waitForDisplayed({ timeout: 20_000 });
    expect(await status.getText()).toMatch(/未连接|Not connected/u);
    // 现行远程中性文字使用专用 token；继续验证非告警色，不能把旧 CSS 类名当成功能合同。
    expect(await status.getAttribute("class")).toContain("text-remote-foreground-muted");
    expect(await status.getAttribute("class")).not.toMatch(/warning|destructive/u);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await browser.waitUntil(
      async () =>
        await browser.execute((identity) => {
          const row = [
            ...document.querySelectorAll<HTMLElement>("[data-project-workspace-identity]"),
          ].find((item) => item.dataset.projectWorkspaceIdentity === identity);
          return (
            row?.dataset.connectionState === "offline" &&
            /离线|Offline/u.test(row.textContent ?? "") &&
            !row.querySelector('[data-remote-state-icon="cloud-x"]')
          );
        }, tab.workspaceIdentity),
      { timeout: 20_000 },
    );
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-presentation-states",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const locale of ["zh-CN", "en-US"] as const) {
      await browser.execute((value) => {
        const actions = (
          window as Window & { __testActions?: { setLocale(value: "zh-CN" | "en-US"): void } }
        ).__testActions;
        if (!actions) throw new Error("Missing locale actions");
        actions.setLocale(value);
      }, locale);
      await browser.waitUntil(
        async () =>
          await browser.execute(
            (label) =>
              [
                ...document.querySelectorAll<HTMLElement>('[data-testid="virtual-project-toggle"]'),
              ].some((item) => item.textContent?.includes(label)),
            locale === "en-US" ? "Offline" : "离线",
          ),
        { timeout: 5000 },
      );
      for (const theme of ["light", "dark"]) {
        await browser.execute((value) => {
          const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
            .__testActions;
          if (!actions) throw new Error("Missing theme actions");
          actions.setTheme(value);
        }, theme);
        for (const width of [1400, 900]) {
          await browser.electron.execute((electron, nextWidth) => {
            electron.BrowserWindow.getAllWindows()
              .find((window) => !window.isDestroyed())
              ?.setSize(nextWidth, 900);
          }, width);
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          await browser.saveScreenshot(
            resolve(artifactDir, `disconnected-${locale}-${theme}-${width}.png`),
          );
        }
      }
    }
  });
});

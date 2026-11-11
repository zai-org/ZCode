import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import { TID_CONFIRM_DIALOG_CONFIRM, TID_SETTINGS_PAGE } from "@zcode/shared/test-ids";
import type { RemoteProjectDirectory } from "@zcode/services";
import { clearAppData, DEFAULT_WORKSPACE, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  readSSHRuntimeConfig,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForSSHError,
  createFirstConnectionStallingSSHProxy,
} from "#e2e/helpers/ssh-remote-p0";

const marker = "E2E_PROJECT_SETTINGS_RETURN";
async function addDevice() {
  await $('[data-testid="virtual-project-device"]').click();
  await $(
    '//*[@role="option" and (contains(.,"添加远程设备") or contains(.,"Add remote device"))]',
  ).click();
  await $('[data-testid="ssh-host-input"]').waitForDisplayed();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed({ reverse: true });
  expect(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()).toBe(true);
}
async function waitForProjectReturn() {
  // 本入口完成后会弹出项目的换设备确认；普通连接 helper 会把它误判为连接失败。
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        // 首连介绍在 SSH 向导外；旧 helper 只找安装按钮，永远无法完成握手。
        const boundary = document.querySelector<HTMLButtonElement>(
          '[data-confirm-intent="source-server-boundary"] [data-testid="confirm-dialog-confirm"]',
        );
        if (boundary?.getClientRects().length && !boundary.disabled) {
          boundary.click();
          return false;
        }
        // 换设备确认会阻塞向导完成回调；必须交还调用方确认/取消，不能等向导关闭后才处理。
        const confirmation = document
          .querySelector('[data-testid="confirm-dialog-confirm"]')
          ?.closest('[role="dialog"]');
        if (
          confirmation?.getClientRects().length &&
          confirmation.querySelector("h2")?.textContent?.trim() === "切换设备？"
        )
          return true;
        const dialog = document.querySelector('[data-testid="ssh-dialog"]');
        if (!dialog) return true;
        const error = dialog.querySelector<HTMLElement>('[data-testid="ssh-error"]');
        if (error?.getClientRects().length && error.innerText.trim())
          throw new Error(error.innerText);
        const install = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) =>
            !button.disabled &&
            button.getClientRects().length &&
            ["安装并继续", "Install and continue"].includes(button.textContent?.trim() ?? ""),
        );
        install?.click();
        return false;
      }),
    { timeout: 120_000, timeoutMsg: "设备添加未返回项目草稿" },
  );
}
async function name() {
  return $('[data-testid="virtual-project-name"]').getValue();
}
async function directory() {
  return callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");
}

describe(marker, () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "failed-project-settings-return.png"),
      );
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "failed-page.txt"),
        await $("body").getText(),
      );
    }
  });
  after(async () => {
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX15-04/11/12/13 项目真实入口往返设置，取消保留草稿，成功沿用设备切换确认", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(value: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue(marker);
    await addDevice();
    await browser.keys("Escape");
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await name()).toBe(marker);
    await browser.waitUntil(() =>
      browser.execute(
        () => document.activeElement?.getAttribute("data-testid") === "virtual-project-name",
      ),
    );
    expect(await $('[data-testid="virtual-project-device"]').getText()).toContain("此电脑");
    // 再次进入复用已有设置页签，不能重复打开或消费完成。
    const root = join(DEFAULT_WORKSPACE, "project-settings-return");
    await mkdir(root, { recursive: true });
    await selectNativeProjectDirectories([root]);
    const stalled = await createFirstConnectionStallingSSHProxy(config, marker);
    try {
      await addDevice();
      await fillSSHPasswordSettings({ ...config, host: "127.0.0.1", port: stalled.port });
      await clickLastEnabledSSHDialogButton(marker);
      await stalled.firstConnectionAccepted;
      await browser.keys("Escape");
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      await stalled.waitForFirstConnectionClosed();
      await $('[data-testid="virtual-project-name"]').waitForDisplayed();
      expect(await name()).toBe(marker);
      expect(await $('[data-testid="virtual-project-root-name"]').getAttribute("title")).toBe(root);
      expect((await directory()).entries).toHaveLength(0);
    } finally {
      await stalled.close();
    }
    await addDevice();
    await fillSSHPasswordSettings({ ...config, password: `${config.password}-wrong` });
    await clickLastEnabledSSHDialogButton(marker);
    await waitForSSHError(marker, 90_000);
    expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
    await $('[data-testid="ssh-dialog"]').$('.//button[normalize-space(.)="返回配置"]').click();
    await $('[data-testid="ssh-password-input"]').setValue(config.password);
    await clickLastEnabledSSHDialogButton(marker);
    await waitForProjectReturn();
    await $('[data-testid="confirm-dialog-confirm"]').waitForDisplayed();
    await browser.keys("Escape");
    await $('[data-testid="confirm-dialog-confirm"]').waitForExist({ reverse: true });
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await name()).toBe(marker);
    expect(await $('[data-testid="virtual-project-root-name"]').getAttribute("title")).toBe(root);
    expect(await $('[data-testid="virtual-project-device"]').getText()).toContain("此电脑");
    expect((await directory()).entries).toHaveLength(0);
    await addDevice();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    await waitForProjectReturn();
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    await $('[data-testid="confirm-dialog-confirm"]').waitForExist({ reverse: true });
    expect(await name()).toBe(marker);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(0);
    expect(await $('[data-testid="virtual-project-device"]').getText()).not.toContain("此电脑");
    expect((await directory()).entries).toHaveLength(0);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "returned-project.png"));
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "return-facts.json"),
      JSON.stringify(
        { name: await name(), directory: await directory(), unverified: ["WSL", "mobile"] },
        null,
        2,
      ),
    );
    await browser.keys("Escape");
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue(`${marker}_EMPTY`);
    await addDevice();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    await waitForProjectReturn();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await name()).toBe(`${marker}_EMPTY`);
    expect(await $('[data-testid="virtual-project-device"]').getText()).not.toContain("此电脑");
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(0);
    expect((await directory()).entries).toHaveLength(0);
    await browser.keys("Escape");
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue(`${marker}_PRESENTATION`);
    for (const locale of ["zh-CN", "en-US"])
      for (const theme of ["light", "dark"])
        for (const width of [1440, 480]) {
          await browser.execute(
            (language, color) => {
              const actions = (
                window as Window & {
                  __testActions?: { setLocale(value: string): void; setTheme(value: string): void };
                }
              ).__testActions;
              actions?.setLocale(language);
              actions?.setTheme(color);
            },
            locale,
            theme,
          );
          await browser.electron.execute((electron, size) => {
            electron.BrowserWindow.getAllWindows()
              .find((window) => window.isVisible())
              ?.setSize(size, 900);
          }, width);
          await addDevice();
          await browser.keys("Escape");
          await $('[data-testid="virtual-project-name"]').waitForDisplayed();
          expect(await name()).toBe(`${marker}_PRESENTATION`);
          await browser.waitUntil(() =>
            browser.execute(
              () => document.activeElement?.getAttribute("data-testid") === "virtual-project-name",
            ),
          );
          await browser.executeAsync((done) => {
            const dialog = document
              .querySelector('[data-testid="virtual-project-name"]')
              ?.closest('[role="dialog"]');
            void Promise.all(
              (dialog?.getAnimations({ subtree: true }) ?? [])
                .filter(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getComputedTiming().iterations !== Infinity,
                )
                .map((animation) => animation.finished.catch(() => undefined)),
            ).then(() => requestAnimationFrame(() => done()));
          });
          const layout = await browser.execute(() => {
            const bounds = document
              .querySelector('[data-testid="virtual-project-save"]')!
              .getBoundingClientRect();
            return {
              right: bounds.right,
              bottom: bounds.bottom,
              width: innerWidth,
              height: innerHeight,
            };
          });
          expect(layout.right).toBeLessThanOrEqual(layout.width);
          expect(layout.bottom).toBeLessThanOrEqual(layout.height);
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `return-${locale}-${theme}-${width}.png`),
          );
        }
    await browser.keys("Escape");
    // 原项目草稿关闭后设置仍可访问，取消没有删除成功保存的设备。
    expect((await directory()).hosts.length).toBeGreaterThan(0);
  });
});

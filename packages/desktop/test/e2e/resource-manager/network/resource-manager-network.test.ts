import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  activateResourceManagerTab,
  closeResourceManagerWindow,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManagerFromHelpMenu,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";

describe("资源管理器网络", () => {
  it("窗口期间记录 Main/Renderer 请求，切页仍采集，重开不保留旧数据", async function () {
    this.timeout(90_000);
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await openResourceManagerFromHelpMenu();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    await activateResourceManagerTab("network");
    const server = createServer((_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.end("network-test");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const mainResult = await browser.electron.execute(async (_electron, origin) => {
        return (await fetch(`${origin}/main-network-test?token=secret`)).text();
      }, url);
      expect(mainResult).toBe("network-test");
      await browser.execute(async (origin) => {
        await (await fetch(`${origin}/renderer-network-test`)).text();
      }, url);
      await browser.waitUntil(
        async () =>
          (await $("[data-testid='resource-network-list']").getText()).includes(
            "main-network-test",
          ),
        { timeout: 10_000 },
      );
      await browser.waitUntil(
        async () =>
          (await $("[data-testid='resource-network-list']").getText()).includes(
            "renderer-network-test",
          ),
        { timeout: 10_000 },
      );
      expect(await $("[data-testid='resource-network-list']").getText()).not.toContain("secret");
      const externalResult = await browser.electron.execute(async (electron, origin) => {
        return (
          await electron.session
            .fromPartition("persist:zcode-embedded-browser")
            .fetch(`${origin}/excluded-external-page`)
        ).text();
      }, url);
      expect(externalResult).toBe("network-test");
      await activateResourceManagerTab("cpu");
      await browser.electron.execute(async (_electron, origin) => {
        await (await fetch(`${origin}/other-tab-network-test`)).text();
      }, url);
      await activateResourceManagerTab("network");
      await browser.waitUntil(
        async () =>
          (await $("[data-testid='resource-network-list']").getText()).includes(
            "other-tab-network-test",
          ),
        { timeout: 10_000 },
      );
      expect(await $("[data-testid='resource-network-list']").getText()).not.toContain(
        "excluded-external-page",
      );
      await $("input").setValue("renderer-network-test");
      await browser.waitUntil(
        async () =>
          !(await $("[data-testid='resource-network-list']").getText()).includes(
            "main-network-test",
          ),
      );
      expect(await $("[data-testid='resource-network-list']").getText()).toContain(
        "renderer-network-test",
      );
      await $("input").setValue("");
      for (const [theme, locale] of [
        ["zai-dark", "en-US"],
        ["zai-light", "zh-CN"],
      ]) {
        await browser.execute(
          (themeValue, localeValue) => {
            localStorage.setItem("zcode-theme", themeValue!);
            localStorage.setItem("zcode-locale-preference", localeValue!);
          },
          theme,
          locale,
        );
        await browser.refresh();
        await waitForResourceManagerReady();
        await activateResourceManagerTab("network");
        await browser.waitUntil(async () =>
          (await $("[data-testid='resource-network-list']").getText()).includes(
            "renderer-network-test",
          ),
        );
        await browser.saveScreenshot(join(tmpdir(), `zcode-network-${theme}.png`));
      }
      await $('//button[normalize-space(.)="Clear" or normalize-space(.)="清空"]').click();
      await browser.waitUntil(
        async () =>
          !(await $("[data-testid='resource-network-list']").getText()).includes(
            "main-network-test",
          ),
      );
      await switchToElectronRendererTarget(isMainRendererUrl);
      await closeResourceManagerWindow();
      await browser.electron.execute(async (_electron, origin) => {
        await (await fetch(`${origin}/closed-network-test`)).text();
      }, url);
      await openResourceManagerFromHelpMenu();
      await switchToElectronRendererTarget(isResourceManagerUrl);
      await waitForResourceManagerReady();
      await activateResourceManagerTab("network");
      const text = await $("[data-testid='resource-network-list']").getText();
      expect(text).not.toContain("closed-network-test");
      expect(text).not.toContain("main-network-test");
      expect(text).not.toContain("renderer-network-test");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await switchToElectronRendererTarget(isMainRendererUrl);
      await closeResourceManagerWindow();
    }
  });
});

import { join } from "node:path";
import { chromium } from "playwright-core";
import { parseWebRemoteControlAppPayload, type WebRemoteControlStatus } from "@zcode/shared";
import { TID_LOGIN_TRIGGER } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";

async function remoteStatus(): Promise<WebRemoteControlStatus> {
  const raw = await browser.execute(async () =>
    JSON.stringify(await (window as any).zcode.getWebRemoteControlStatus()),
  );
  return JSON.parse(raw);
}

describe("中国区桌面与手机 Web 共享身份", () => {
  it("AUTH-CN-MOBILE: 已登录手机连接中国区桌面，补关联后保留连接，退出后撤销", async function () {
    this.timeout(180_000);
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    const relay = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    const web = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!artifactDir || !relay || !web) throw new Error("缺少隔离手机/relay配置");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    const pairingUrl = await obtainUnreadPairingUrl(new URL(web).origin);
    const mobileBrowser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const context = await mobileBrowser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      // 浏览器沿用自己的存量登录；不能复制桌面CN/关联材料来绕过独立登录边界。
      await context.addInitScript(
        (credentials) => {
          for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
        },
        {
          ...WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS,
          zcodejwttoken: "mobile-own-token",
          "oauth:zai:access_token": "mobile-own-upstream",
        },
      );
      const page = await context.newPage();
      const relaySockets: Array<{ closed: boolean; loadedWorkspace: boolean }> = [];
      page.on("websocket", (socket) => {
        if (!new URL(socket.url()).pathname.endsWith("/api/v1/remote/ws2")) return;
        const state = { closed: false, loadedWorkspace: false };
        relaySockets.push(state);
        socket.on("framereceived", ({ payload: raw }) => {
          const frame = JSON.parse(String(raw)) as { type?: string; payload?: unknown };
          const payload =
            frame.type === "data" ? parseWebRemoteControlAppPayload(frame.payload) : null;
          if (payload?.zcode_type === "bootstrap-response" && payload.success)
            state.loadedWorkspace = payload.result.workspaces.some(
              (workspace) => workspace.workspacePath === DEFAULT_WORKSPACE,
            );
        });
        socket.on("close", () => {
          state.closed = true;
        });
      });
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: "AUTH-CN-MOBILE",
        phase: "connected",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      await browser.waitUntil(async () => (await remoteStatus()).status === "active", {
        timeout: 20_000,
      });
      const before = await remoteStatus();
      await browser.execute((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.oauthService ? value : fiber.memoizedProps?.services;
          if (services?.oauthService) {
            (window as any).__cnMobileServices = services;
            return;
          }
          fiber = fiber.return;
        }
        throw new Error("Missing OAuth accessor");
      }, TID_LOGIN_TRIGGER);
      await fetch(`${relay}/__e2e/linked-profile`, { method: "POST" });
      const account = await browser.execute(async () =>
        (window as any).__cnMobileServices.oauthService.refreshAccountProfile(),
      );
      expect(account.loginProvider).toBe("zai_cn");
      expect(account.sessionRevision).not.toBe("cn-mobile-initial");
      expect((await remoteStatus()).status).toBe("active");
      expect(before.sessionId).toBeTruthy();
      expect((await remoteStatus()).sessionId).toBe(before.sessionId);
      // 重新加载会重新跑浏览器恢复和远控bootstrap，证明仍可从真实Host读取工作区。
      const socketCountBeforeReload = relaySockets.length;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .locator('[data-testid="sidebar"], [data-mobile-page="chat"]')
        .first()
        .waitFor({ timeout: 30_000 });
      await browser.waitUntil(async () => (await remoteStatus()).status === "active", {
        timeout: 20_000,
      });
      await browser.waitUntil(
        async () =>
          relaySockets.length > socketCountBeforeReload &&
          relaySockets.at(-1)?.loadedWorkspace === true,
        { timeout: 30_000 },
      );
      expect(await page.evaluate(() => localStorage.getItem("oauth:active_provider"))).toBe("zai");
      await page.screenshot({ path: join(artifactDir, "cn-mobile-connected.png") });
      expect(
        await page.evaluate(() => localStorage.getItem("oauth:zai_cn:access_token")),
      ).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem("oauth:linked_bigmodel"))).toBeNull();
      const pairedSocket = relaySockets.at(-1);
      expect(pairedSocket).toBeDefined();
      expect(pairedSocket?.closed).toBe(false);
      await browser.execute(async () =>
        (window as any).__cnMobileServices.oauthService.logoutAll(),
      );
      await browser.waitUntil(async () => (await remoteStatus()).status === "auth-required", {
        timeout: 10_000,
      });
      await browser.waitUntil(async () => pairedSocket?.closed === true, { timeout: 15_000 });
      await page.screenshot({ path: join(artifactDir, "cn-mobile-after-logout.png") });
    } finally {
      await mobileBrowser.close();
      await browser.execute(() => {
        delete (window as any).__cnMobileServices;
      });
    }
  });
});

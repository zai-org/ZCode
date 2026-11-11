import { createServer, type Server } from "node:http";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

/**
 * 站点权限设置标签页回归（spec：2026-10-08 governance「站点权限设置标签页」）：
 * - 地址栏滑杆入口 → 站点信息气泡 → 权限设置 → 独立设置标签页
 * - 逐项改为允许后 guest 内 permissions.query 立即变 granted；重置后回到 denied
 * 2026-10-19 用户已完成人工复核；正式入口保留同一权限交互与持久化断言。
 */

const PERMISSION_TEST_PAGE = `<!doctype html><html><head><title>permission-settings-test</title></head><body>
<h1>permission settings test page</h1>
<script>
  window.__permissionState = async (name) => {
    const status = await navigator.permissions.query({ name });
    return status.state;
  };
</script>
</body></html>`;

async function startPermissionTestServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PERMISSION_TEST_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("permission test server did not bind a port");
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe("站点权限设置标签页：地址栏入口与逐项修改", () => {
  let testServer: { server: Server; origin: string };

  before(async () => {
    testServer = await startPermissionTestServer();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await new Promise<void>((resolve) => {
      testServer.server.close(() => resolve());
    });
  });

  it("滑杆入口打开设置标签页；允许后立即生效，重置后回到询问", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();
    await navigateTo(testServer.origin);
    // URL 输入仍聚焦时滑杆按设计隐藏；真实点击网页结束地址编辑，再使用站点权限入口。
    await clickTestIdByWebDriver(TID_BROWSER_WEBVIEW);

    // 未授权默认 denied
    expect(await runInGuest("window.__permissionState('geolocation')")).toBe("denied");

    // 地址栏滑杆 → 站点信息气泡 → 权限设置
    await clickTestIdByWebDriver("browser-permission-trigger");
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-permission-popover"]'),
        ),
      { timeout: 10_000, timeoutMsg: "站点信息气泡没有出现" },
    );
    await clickTestIdByWebDriver("browser-permission-open-settings");

    // 独立设置标签页打开，展示站点 origin 与能力目录
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-site-permissions"]'),
        ),
      { timeout: 15_000, timeoutMsg: "站点权限设置标签页没有出现" },
    );
    const originText = await browser.execute(
      () => document.querySelector('[data-testid="browser-site-permissions"] h1')?.textContent,
    );
    expect(originText).toBe(testServer.origin);

    // geolocation 逐项改为「允许」→ guest 内 permissions.query 立即变 granted
    await clickTestIdByWebDriver("site-permission-setting-geolocation");
    await clickTestIdByWebDriver("site-permission-option-allow");
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-permission-saved"]'),
        ),
      { timeout: 10_000, timeoutMsg: "保存提示没有出现" },
    );
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('geolocation')")) === "granted",
      { timeout: 15_000, timeoutMsg: "设置页允许后 permissions.query 应为 granted" },
    );

    // 整站重置 → 回到每次询问（query 为 denied）
    await clickTestIdByWebDriver("browser-permission-reset");
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-permission-reset-done"]'),
        ),
      { timeout: 10_000, timeoutMsg: "重置完成提示没有出现" },
    );
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('geolocation')")) === "denied",
      { timeout: 15_000, timeoutMsg: "重置后 permissions.query 应回到 denied" },
    );
  });
});

async function navigateTo(origin: string): Promise<void> {
  const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
  await addressInput.setValue(origin);
  await browser.keys("Enter");
  await browser.waitUntil(
    () =>
      browser.execute((refreshTestId: string) => {
        const refresh = document.querySelector<HTMLButtonElement>(
          `[data-testid="${refreshTestId}"]`,
        );
        return !!refresh && !refresh.disabled;
      }, TID_BROWSER_REFRESH_BUTTON),
    { timeout: 30_000, timeoutMsg: `内置浏览器没有加载完 ${origin}` },
  );
  await browser.waitUntil(
    async () => (await runInGuest("document.title")) === "permission-settings-test",
    {
      timeout: 15_000,
      timeoutMsg: "测试页脚本未就绪",
    },
  );
}

async function readBrowserGuestWebContentsId(): Promise<number> {
  const webContentsId = await browser.execute((testIdValue: string) => {
    const webviews = Array.from(
      document.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>(
        `[data-testid="${testIdValue}"]`,
      ),
    );
    const visible = webviews.findLast(
      (element) =>
        element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
    );
    const webview = visible ?? webviews.at(-1);
    return webview?.getWebContentsId?.() ?? null;
  }, TID_BROWSER_WEBVIEW);
  if (typeof webContentsId !== "number") {
    throw new Error("browser guest webview is not mounted yet");
  }
  return webContentsId;
}

async function runInGuest<T>(script: string): Promise<T> {
  const webContentsId = await readBrowserGuestWebContentsId();
  return browser.electron.execute(
    async (electron, guestId: number, code: string) => {
      const guest = electron.webContents.fromId(guestId);
      if (!guest || guest.isDestroyed()) {
        throw new Error("browser guest webContents is not available");
      }
      return guest.executeJavaScript(code) as Promise<unknown>;
    },
    webContentsId,
    script,
  ) as Promise<T>;
}

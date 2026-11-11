import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_BROWSER_RESPONSIVE_ZOOM_OPTION,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  readSettings,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { countBrowserTabs, openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";

let fixtureServer: Server | null = null;
let fixtureUrl = "";

describe("BCP-231：human Browser 显示偏好跨重启恢复", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureUrl = `${await listen(fixtureServer)}/viewport-preference`;
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("只恢复 human 模式、尺寸和预览比例，不恢复旧 tab、URL 或 history", async function () {
    this.timeout(180_000);
    // 普通 Browser 用例无需账号；启动假 OAuth 会触发登录过期弹窗并遮挡真实点击。
    const credentials = JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8"));
    expect(
      Object.keys(credentials).filter(
        (key) => key.startsWith("oauth:") || key === "auth_token" || key === "zcodejwttoken",
      ),
    ).toEqual([]);
    await prepareConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();

    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_BUTTON);
    await setInputValueByTestIdDom(TID_BROWSER_RESPONSIVE_WIDTH_INPUT, "412");
    await setInputValueByTestIdDom(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT, "915");
    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    await clickTestIdByWebDriver(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-50`);
    await waitForResponsivePreferenceSurface();
    await waitForPersistedPreference();

    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await addressInput.setValue(fixtureUrl);
    await addressInput.click();
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await readMainGuestUrls()).includes(fixtureUrl), {
      timeout: 30_000,
      timeoutMsg: "重启前 human Browser 没有打开测试 URL",
    });

    const userDataDir = (await browser.electron.execute((electron) =>
      electron.app.getPath("userData"),
    )) as string;
    expect(await reloadElectronSessionPreservingBrowserProfile(browser)).toBe(userDataDir);
    await prepareConversationE2E({ skipProvider: true });

    await browser.waitUntil(async () => (await countBrowserTabs()) === 0, {
      timeout: 15_000,
      timeoutMsg: "完整重启后旧 human Browser tab 仍被恢复",
    });
    expect(await readMainGuestUrls()).not.toContain(fixtureUrl);
    expect((await readSettings()).embeddedBrowserViewportPreference).toEqual({
      mode: "responsive",
      viewport: { width: 412, height: 915 },
      zoom: "50",
    });

    await openFirstBrowserTab();
    await waitForResponsivePreferenceSurface();
  });
});

async function waitForResponsivePreferenceSurface(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (buttonTestId, viewportTestId, widthTestId, heightTestId, zoomTestId) => {
          const button = document.querySelector<HTMLElement>(`[data-testid="${buttonTestId}"]`);
          const viewport = document.querySelector<HTMLElement>(`[data-testid="${viewportTestId}"]`);
          const width = document.querySelector<HTMLInputElement>(`[data-testid="${widthTestId}"]`);
          const height = document.querySelector<HTMLInputElement>(
            `[data-testid="${heightTestId}"]`,
          );
          const zoom = document.querySelector<HTMLElement>(`[data-testid="${zoomTestId}"]`);
          return (
            button?.getAttribute("aria-pressed") === "true" &&
            viewport?.dataset.responsiveWidth === "412" &&
            viewport.dataset.responsiveHeight === "915" &&
            width?.value === "412" &&
            height?.value === "915" &&
            (zoom?.getAttribute("data-value") === "50" || zoom?.textContent?.includes("50%"))
          );
        },
        TID_BROWSER_RESPONSIVE_BUTTON,
        TID_BROWSER_RESPONSIVE_VIEWPORT,
        TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
        TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
        TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
      ),
    { timeout: 20_000, timeoutMsg: "human Browser 没有恢复 412×915 / 50% 自由尺寸偏好" },
  );
}

async function waitForPersistedPreference(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const preference = (await readSettings()).embeddedBrowserViewportPreference;
      return (
        preference?.mode === "responsive" &&
        preference.viewport.width === 412 &&
        preference.viewport.height === 915 &&
        preference.zoom === "50"
      );
    },
    { timeout: 15_000, timeoutMsg: "human Browser 显示偏好没有写入 setting.json" },
  );
}

function readMainGuestUrls(): Promise<string[]> {
  return browser.electron.execute((electron) =>
    electron.webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.getType() === "webview")
      .map((contents) => contents.getURL()),
  ) as unknown as Promise<string[]>;
}

function createFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><html><head><title>BCP-231</title></head><body><main>viewport preference</main></body></html>",
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("BCP-231 fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

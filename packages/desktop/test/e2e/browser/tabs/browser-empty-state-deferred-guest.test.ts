import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TID_BROWSER_ADDRESS_INPUT, TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";

let fixtureServer: Server | null = null;
let fixtureUrl = "";
let pendingResponse: ServerResponse | null = null;

describe("BCP-226：human Browser 空态延迟创建 guest（formal）", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureUrl = `${await listen(fixtureServer)}/ready`;
  });

  after(async () => {
    pendingResponse?.destroy();
    pendingResponse = null;
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("空 tab 与地址草稿不创建 guest，回车后创建单 guest 并完成导航", async function () {
    this.timeout(90_000);
    await prepareConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();

    await waitForEmptyHumanTab();
    expect(await readGuestSnapshot()).toEqual({ domGuests: 0, mainGuests: 0 });

    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await addressInput.waitForDisplayed({ timeout: 15_000 });
    const pendingUrl = new URL("/pending", fixtureUrl).href;
    await addressInput.setValue(pendingUrl);

    // Bug 回归：地址草稿不是已确认导航，不能提前裸露或创建 about:blank guest。
    await waitForEmptyHumanTab();
    expect(await readGuestSnapshot()).toEqual({ domGuests: 0, mainGuests: 0 });

    await addressInput.click();
    await browser.keys("Enter");

    await browser.waitUntil(
      async () => {
        const snapshot = await readGuestSnapshot();
        return snapshot.domGuests === 1 && snapshot.mainGuests === 1;
      },
      { timeout: 20_000, timeoutMsg: "确认导航后没有创建唯一 Browser guest" },
    );
    try {
      // 暂扣真实响应，让 bootstrap 已结束、目标页尚未提交的窗口可重复观测，不靠 sleep。
      await browser.waitUntil(() => pendingResponse !== null, {
        timeout: 15_000,
        timeoutMsg: "首次导航没有到达受控服务器",
      });
      expect(await readMainGuestUrls()).toEqual(["about:blank"]);
      expect(await addressInput.getValue()).toBe(pendingUrl);
    } finally {
      pendingResponse?.writeHead(302, { location: "/ready" });
      pendingResponse?.end();
      pendingResponse = null;
    }
    await browser.waitUntil(
      async () => (await readMainGuestUrls()).some((url) => url === fixtureUrl),
      { timeout: 30_000, timeoutMsg: "新 guest 没有消费地址栏待导航 URL" },
    );
    expect(await readGuestSnapshot()).toEqual({ domGuests: 1, mainGuests: 1 });
    await expect(addressInput).toHaveValue(fixtureUrl);

    // 初始化空白页不回填，不能变成所有 about:blank 导航都被忽略。
    await browser.electron.execute((electron) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find((contents) => !contents.isDestroyed() && contents.getType() === "webview");
      if (!guest) throw new Error("缺少 Browser guest");
      return guest.executeJavaScript("document.getElementById('blank-link').click()");
    });
    await browser.waitUntil(async () => (await readMainGuestUrls()).includes("about:blank"), {
      timeout: 15_000,
      timeoutMsg: "主动空白页导航没有提交",
    });
    await expect(addressInput).toHaveValue("");
  });
});

async function waitForEmptyHumanTab(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((webviewTestId) => {
        const bodyText = document.body?.innerText ?? "";
        const hasEmptyCopy =
          bodyText.includes("Paste or type a URL to open a page.") ||
          bodyText.includes("粘贴或输入 URL 以打开网页。");
        const hasSpinner = Boolean(document.querySelector("svg.lucide-loader-circle.animate-spin"));
        const hasWebview = Boolean(document.querySelector(`[data-testid="${webviewTestId}"]`));
        return hasEmptyCopy && !hasSpinner && !hasWebview;
      }, TID_BROWSER_WEBVIEW),
    { timeout: 15_000, timeoutMsg: "human 空 tab 没有保持 Globe 空态且无 webview" },
  );
}

async function readGuestSnapshot(): Promise<{ domGuests: number; mainGuests: number }> {
  const domGuests = await browser.execute(
    (webviewTestId) => document.querySelectorAll(`[data-testid="${webviewTestId}"]`).length,
    TID_BROWSER_WEBVIEW,
  );
  const mainGuests = await browser.electron.execute(
    (electron) =>
      electron.webContents
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed() && contents.getType() === "webview").length,
  );
  return { domGuests, mainGuests };
}

async function readMainGuestUrls(): Promise<string[]> {
  return browser.electron.execute((electron) =>
    electron.webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.getType() === "webview")
      .map((contents) => contents.getURL()),
  ) as unknown as Promise<string[]>;
}

function createFixtureServer(): Server {
  return createServer((request, response) => {
    if (request.url === "/pending") {
      pendingResponse = response;
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      '<!doctype html><html><head><title>BCP-226</title></head><body><main data-e2e-marker="BCP226_READY">ready</main><a id="blank-link" href="about:blank">Blank</a></body></html>',
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
  if (!address) throw new Error("BCP-226 fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

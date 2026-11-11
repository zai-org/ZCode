import { createServer } from "node:http";
import { TID_BROWSER_ADDRESS_INPUT, TID_SIDE_PANE_TOGGLE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { clickCloseButton, openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PAGE_MARKER = "__zcodeDraftPromotionMarker";

describe("Side pane 草稿首发迁移（manual review）", () => {
  let fixture: Awaited<ReturnType<typeof startPageFixture>>;
  before(async () => {
    fixture = await startPageFixture();
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await fixture?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SPT-E2E-009：草稿打开的 Browser 在首发后留在新任务、侧栏展开、页面不重载且可关闭", async function () {
    this.timeout(150000);
    await openFirstBrowserTab();
    const input = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await input.waitForDisplayed();
    await input.setValue(fixture.url);
    await browser.keys("Enter");
    await browser.waitUntil(async () => fixture.hits() >= 1, {
      timeoutMsg: "草稿 Browser 没有加载夹具页面",
    });
    const tabId = await activeBrowserTabId();
    const guestId = await markFixtureGuest(fixture.url);
    const hitsBeforeSend = fixture.hits();

    await sendV4Prompt(`E2E_SIDE_PANE_DRAFT_PROMOTION_${Date.now()}`);
    const promoted = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
      "草稿首发后 pane 没有切到新任务",
      60000,
    );
    expect(promoted.sessionId).toBeTruthy();

    await $(`[data-side-pane-tab-id="${tabId}"]`).waitForDisplayed({
      timeoutMsg: "首发后草稿 Browser tab 不再可见",
    });
    expect(await activeBrowserTabId()).toBe(tabId);
    expect(await readGuestMarker(guestId)).toBe(true);
    expect(fixture.hits()).toBe(hitsBeforeSend);

    // main 关闭入口按 owner 校验；owner 未升级时 UI 壳会一直留着。
    await clickCloseButton(tabId);
    await browser.waitUntil(
      async () => !(await $(`[data-side-pane-tab-id="${tabId}"]`).isExisting()),
      {
        timeoutMsg: "首发后的 Browser tab 无法关闭，main owner 未升级",
      },
    );
    expect(fixture.hits()).toBe(hitsBeforeSend);
  });

  it("SPT-E2E-010：草稿打开 Browser 后收起侧栏再首发，tab 迁到新任务且侧栏保持收起", async function () {
    this.timeout(150000);
    await startNewV4Draft();
    const collapsedLabel = await readSidePaneToggleLabel();
    await openFirstBrowserTab();
    const tabId = await activeBrowserTabId();
    await waitForSidePaneToggleLabel(
      (label) => label !== collapsedLabel,
      "草稿打开 Browser 后侧栏没有展开",
    );
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await waitForSidePaneToggleLabel((label) => label === collapsedLabel, "草稿里收起侧栏失败");

    await sendV4Prompt(`E2E_SIDE_PANE_DRAFT_PROMOTION_COLLAPSED_${Date.now()}`);
    await waitForPromotedSessionIdle();
    // 收起时 Browser 实例保留挂载；tab 壳出现说明迁移与折叠态已在同一次 scope 提交里完成。
    await $(`[data-side-pane-tab-id="${tabId}"]`).waitForExist({
      timeoutMsg: "首发后草稿 Browser tab 没有迁到新任务",
    });
    expect(await readSidePaneToggleLabel()).toBe(collapsedLabel);

    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await $(`[data-side-pane-tab-id="${tabId}"]`).waitForDisplayed({
      timeoutMsg: "展开后迁移的 Browser tab 不可见",
    });
    expect(await activeBrowserTabId()).toBe(tabId);
    await clickCloseButton(tabId);
    await browser.waitUntil(
      async () => !(await $(`[data-side-pane-tab-id="${tabId}"]`).isExisting()),
      { timeoutMsg: "收起首发后的 Browser tab 无法关闭，main owner 未升级" },
    );
  });

  it("SPT-E2E-011：草稿只有新标签页时首发，新任务不带任何 tab 且侧栏收起", async function () {
    this.timeout(150000);
    await startNewV4Draft();
    const collapsedLabel = await readSidePaneToggleLabel();
    expect(await readSidePaneTabIds()).toEqual([]);
    // 展开空面板会为草稿补一个新标签页。
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await browser.waitUntil(async () => (await readSidePaneTabIds()).length === 1, {
      timeoutMsg: "展开草稿空面板没有创建新标签页",
    });

    await sendV4Prompt(`E2E_SIDE_PANE_DRAFT_PROMOTION_NEW_TAB_${Date.now()}`);
    await waitForPromotedSessionIdle();
    expect(await readSidePaneTabIds()).toEqual([]);
    expect(await readSidePaneToggleLabel()).toBe(collapsedLabel);
  });
});

async function waitForPromotedSessionIdle(): Promise<void> {
  await waitForV4Pane(
    (snapshot) =>
      Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft" && !snapshot.canStop,
    "草稿首发后 pane 没有切到新任务并完成回复",
    60000,
  );
}

async function readSidePaneToggleLabel(): Promise<string> {
  const toggle = $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
  await toggle.waitForExist({ timeoutMsg: "右侧面板开关不存在" });
  const label = await toggle.getAttribute("aria-label");
  if (!label) throw new Error("右侧面板开关缺少 aria-label");
  return label;
}

async function waitForSidePaneToggleLabel(
  predicate: (label: string) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => predicate(await readSidePaneToggleLabel()), { timeoutMsg });
}

function readSidePaneTabIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")).map(
      (element) => element.dataset.sidePaneTabId ?? "",
    ),
  );
}

async function activeBrowserTabId(): Promise<string> {
  const id = await $('[data-side-pane-tab-id^="browser:"][data-state="active"]').getAttribute(
    "data-side-pane-tab-id",
  );
  if (!id) throw new Error("没有激活的 Browser tab");
  return id;
}

async function markFixtureGuest(url: string): Promise<number> {
  let guestId = 0;
  await browser.waitUntil(
    async () => {
      guestId = (await browser.electron.execute(
        async (electron, fixtureUrl, marker) => {
          const guest = electron.webContents
            .getAllWebContents()
            .find(
              (contents) =>
                !contents.isDestroyed() &&
                contents.getType() === "webview" &&
                contents.getURL().startsWith(fixtureUrl),
            );
          if (!guest) return 0;
          await guest.executeJavaScript(`window[${JSON.stringify(marker)}] = true`);
          return guest.id;
        },
        url,
        PAGE_MARKER,
      )) as number;
      return guestId > 0;
    },
    { timeoutMsg: "没有找到夹具页面的 webview guest" },
  );
  return guestId;
}

function readGuestMarker(guestId: number): Promise<boolean> {
  return browser.electron.execute(
    async (electron, id, marker) => {
      const guest = electron.webContents.fromId(id);
      if (!guest || guest.isDestroyed()) return false;
      return Boolean(await guest.executeJavaScript(`window[${JSON.stringify(marker)}] === true`));
    },
    guestId,
    PAGE_MARKER,
  ) as unknown as Promise<boolean>;
}

async function startPageFixture() {
  let hits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/" || request.url?.startsWith("/?")) hits += 1;
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end("<!doctype html><title>Draft promotion</title><h1>Draft promotion</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

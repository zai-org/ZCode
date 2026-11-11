import { createServer } from "node:http";
import { TID_BROWSER_ADDRESS_INPUT } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab, clickCloseButton } from "#e2e/helpers/browser-side-pane";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

type ScopeStoreWindow = Window & {
  __zcodeSessionStoreE2E?: {
    getState(): {
      workspaces: Record<string, { activeTaskId: string | null }>;
      setActiveTaskId(path: string, id: string): void;
    };
  };
};

// 本组只验证 UI scope：通过现有 store bridge 准备 A/B 对话，关闭/恢复使用真实菜单，
// Browser 关闭走 main authority；不伪造权限结果、不发模型请求。
describe("Side pane scope（manual review）", () => {
  let fixture: Awaited<ReturnType<typeof startSidePaneFixture>>;
  before(async () => {
    fixture = await startSidePaneFixture();
    await prepareV4ConversationE2E({ skipProvider: true });
  });
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      console.info(
        "[SPT-E2E-008 DOM]",
        await browser.execute(() => ({
          menus: [...document.querySelectorAll('[role="menuitem"]')].map(
            (node) => node.textContent,
          ),
          body: document.body.innerText,
        })),
      );
    }
  });
  after(async () => {
    await fixture?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SPT-E2E-008：B 批量关闭不影响 A，最近关闭及重新打开按对话隔离", async () => {
    await switchConversation("scope-a");
    const a = await openSettings(fixture.url);
    await switchConversation("scope-b");
    const b = await openSettings(fixture.crossOrigin);
    await closeMenu(b, "Close other tabs");
    await waitTabs([b]);
    await switchConversation("scope-a");
    await waitTab(a);
    expect((await tabIds()).length).toBe(2);
    await switchConversation("scope-b");
    await closeMenu(b, "Close all tabs");
    await waitTabs([]);
    await switchConversation("scope-a");
    await waitTab(a);
    await clickCloseButton(a);
    await browser.waitUntil(async () => !(await tabIds()).includes(a));
    await openOverview();
    expect(await recentCount(fixture.url)).toBe(1);
    expect(await recentCount(fixture.crossOrigin)).toBe(0);
    await closeOverview();
    await switchConversation("scope-b");
    // 最近关闭入口需要一个可见 tab；新网页本身不恢复任何 A 的记录。
    const bNew = await openSettings(fixture.crossOrigin);
    await openOverview();
    expect(await recentCount(fixture.url)).toBe(0);
    await closeOverview();
    await switchConversation("scope-a");
    await openOverview();
    expect(await recentCount(fixture.url)).toBe(1);
    // cmdk 分组 data-value 跟随本地化标题；不能用英文标签定位中文界面的最近关闭列表。
    let recentGroup: WebdriverIO.Element | undefined;
    for (const candidate of await $$("[cmdk-group]")) {
      const heading = await candidate.$("[cmdk-group-heading]").getText();
      if (["Recently closed tabs", "最近关闭的标签页"].includes(heading)) {
        recentGroup = candidate;
        break;
      }
    }
    if (!recentGroup) throw new Error("缺少最近关闭标签分组");
    const recent = recentGroup.$("[cmdk-item]");
    await recent.waitForDisplayed();
    await recent.click();
    await waitTab(a);
    await visible('[data-testid="browser-site-permissions"]');
    expect(await (await visible('[data-testid="browser-site-permissions"]')).getText()).toContain(
      fixture.url,
    );
    await switchConversation("scope-b");
    await waitTab(bNew);
  });
});

async function switchConversation(owner: string) {
  await browser.execute((id) => {
    const store = (window as ScopeStoreWindow).__zcodeSessionStoreE2E;
    if (!store) throw new Error("Missing E2E store bridge");
    const state = store.getState();
    const workspace = Object.keys(state.workspaces)[0];
    if (!workspace) throw new Error("Missing workspace fixture");
    state.setActiveTaskId(workspace, id);
  }, owner);
  // scope effect 在当前 store 更新后统一选择可见标签，无固定延时。
  await browser.waitUntil(async () =>
    browser.execute((id) => {
      const state = (window as ScopeStoreWindow).__zcodeSessionStoreE2E!.getState();
      return Object.values(state.workspaces)[0]?.activeTaskId === id;
    }, owner),
  );
}
async function openSettings(url: string) {
  await openFirstBrowserTab();
  const input = await visible(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
  await input.waitForDisplayed();
  await input.setValue(url);
  await browser.keys("Enter");
  await browser.keys("Tab");
  const trigger = await visible('[data-testid="browser-permission-trigger"]');
  await trigger.waitForClickable();
  await trigger.click();
  await $('[data-testid="browser-permission-open-settings"]').waitForDisplayed();
  await $('[data-testid="browser-permission-open-settings"]').click();
  await visible('[data-testid="browser-site-permissions"]');
  return (await $(
    '[data-side-pane-tab-id^="browser-permissions:"][data-state="active"]',
  ).getAttribute("data-side-pane-tab-id"))!;
}
async function tabIds() {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")].map(
      (tab) => tab.dataset.sidePaneTabId!,
    ),
  );
}
async function waitTab(id: string) {
  await $(`[data-side-pane-tab-id="${id}"]`).waitForDisplayed();
}
async function waitTabs(ids: string[]) {
  await browser.waitUntil(async () => JSON.stringify(await tabIds()) === JSON.stringify(ids), {
    timeoutMsg: `侧栏未收敛到 ${ids.join(",")}`,
  });
}
async function closeMenu(id: string, label: string) {
  await waitTab(id);
  await $(`[data-side-pane-tab-id="${id}"]`).click({ button: "right" });
  await browser.waitUntil(
    async () =>
      browser.execute((text) => {
        const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const label = text === "Close other tabs" ? "关闭其他标签" : "关闭所有标签";
        const item = items.find((node) => [text, label].includes(node.textContent?.trim() ?? ""));
        if (!item) return false;
        item.click();
        return true;
      }, label),
    { timeoutMsg: `菜单没有 ${label}` },
  );
  await browser.waitUntil(
    async () => !(await $('[data-slot="context-menu-content"]').isExisting()),
  );
}
async function openOverview() {
  await $("[data-workspace-side-frame] button:has(svg.lucide-chevrons-down)").click();
  await $("[cmdk-root]").waitForDisplayed();
}
async function recentCount(origin: string) {
  await $("[cmdk-input]").setValue(origin);
  return await browser.execute(() => {
    const groups = [...document.querySelectorAll("[cmdk-group]")];
    const recent = groups.find((group) =>
      ["Recently closed tabs", "最近关闭的标签页"].includes(
        group.querySelector("[cmdk-group-heading]")?.textContent ?? "",
      ),
    );
    return recent?.querySelectorAll("[cmdk-item]").length ?? 0;
  });
}
async function closeOverview() {
  await browser.keys("Escape");
  await browser.waitUntil(async () => !(await $("[cmdk-root]").isExisting()));
}

async function visible(selector: string): Promise<WebdriverIO.Element> {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const item of await $$(selector)) {
        if (await item.isDisplayed()) {
          found = item;
          return true;
        }
      }
      return false;
    },
    { timeout: 10000, timeoutMsg: `没有可见节点 ${selector}` },
  );
  return found!;
}

// 旧权限 fixture 已随权限实现替换；本用例只需要两个可访问的站点，不依赖网页权限 API。
async function startSidePaneFixture() {
  const servers = [createServer(), createServer()];
  for (const server of servers) {
    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Side pane scope</title><h1>Side pane scope</h1>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  const origins = servers.map((server) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    return `http://127.0.0.1:${address.port}`;
  });
  return {
    url: origins[0]!,
    crossOrigin: origins[1]!,
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
      ),
  };
}

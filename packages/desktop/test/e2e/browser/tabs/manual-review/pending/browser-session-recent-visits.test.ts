import { createServer, type Server, type ServerResponse } from "node:http";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_LOAD_ERROR,
  TID_BROWSER_WEBVIEW,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { readBrowserTabIds } from "#e2e/helpers/browser-side-pane";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { sel } from "#e2e/helpers/selectors";

const RECENT_LIST = '[data-testid="browser-recent-visits"]';
const RECENT_BUTTON = `${RECENT_LIST} button[data-browser-recent-url]`;
const ACTIVE_PANEL = '[role="tabpanel"][data-state="active"]';
const ADDRESS = `${ACTIVE_PANEL} [data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`;
type ScopeWindow = Window & {
  __zcodeSessionStoreE2E?: {
    getState(): {
      setActiveTaskId(workspacePath: string, taskId: string): void;
      removeTaskState(workspacePath: string, taskId: string, workspaceIdentity?: string): void;
      workspaces: Record<string, { activeTaskId: string | null }>;
    };
  };
};

type GuestSnapshot = {
  id: number;
  url: string;
  title: string;
  ready: boolean;
  iframeLoaded: boolean;
};

let server: Server | undefined;
let origin = "";
let titleReleased = false;
let redirectRecovery = false;
const titleResponses = new Set<ServerResponse>();

// Spec：docs/browser-use/2026-10-28-browser-session-recent-visits.md，BRV-03/04/05/06 的 human 候选。
// 与既有 side-pane-scope 候选一样，只用 bridge 准备 owner；不写最近访问 store 或伪造导航事件。
// 不覆盖真实 CLI 会话创建、跨会话/远端隔离、后台归属、Agent 空白 guest 和 20 条上限。
describe("Browser session recent visits (manual-review/pending)", () => {
  before(async () => {
    server = createFixtureServer();
    origin = await listen(server);
  });

  after(async () => {
    for (const response of titleResponses) response.destroy();
    titleResponses.clear();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
        server!.closeAllConnections();
      });
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BRV-03/04/05: keeps visits on blank tabs, updates metadata without reordering, and opens a saved URL", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const ownerA = `E2E_BROWSER_RECENT_A_${Date.now()}`;
    const ownerB = `${ownerA}_B`;
    await setActiveOwner(ownerA);

    await openFirstBrowserTab();
    const sourceA = await activeBrowserTabId();
    await waitForBrowserEmpty();
    expect(await recentUrls()).toEqual([]);
    expect(await activeGuestId()).toBeNull();

    const pageA = `${origin}/page-a`;
    const pageB = `${origin}/page-b`;
    await navigate(pageA);
    await waitForGuest(pageA, "Page A");
    const sourceB = await openBlankBrowserTab();
    await navigate(pageB);
    await waitForGuest(pageB, "Page B");
    const observer = await openBlankBrowserTab();
    await waitForRecentUrls([pageB, pageA]);
    await expectRecentVisitsCentered();
    expect(await recentText(pageA)).toContain("Page A");
    expect(await recentText(pageB)).toContain("Page B");
    expect(await recentText(pageA)).toContain(pageA);
    expect(await recentText(pageB)).toContain(pageB);
    expect(await activeGuestId()).toBeNull();

    // A 已是旧记录，再释放它的标题；若元数据被当成访问，列表会错误地变成 A/B。
    await browser.waitUntil(async () => titleResponses.size > 0, {
      timeout: 15_000,
      timeoutMsg: "页面没有请求受控的迟到标题",
    });
    titleReleased = true;
    for (const response of titleResponses) response.end("Updated title A");
    titleResponses.clear();
    await browser.waitUntil(async () => (await recentText(pageA)).includes("Updated title A"), {
      timeout: 15_000,
      timeoutMsg: "旧页面标题没有更新最近访问条目",
    });
    expect(await recentUrls()).toEqual([pageB, pageA]);

    // 切换由 bridge 提供的 owner，只验证 UI 隔离，不代表真实 CLI 会话生命周期。
    await setActiveOwner(ownerB);
    await browser.waitUntil(async () => (await readBrowserTabIds()).length === 0, {
      timeout: 15_000,
      timeoutMsg: "切换 owner 后仍显示旧 Browser tab",
    });
    await openFirstBrowserTab();
    await waitForBrowserEmpty();
    expect(await recentUrls()).toEqual([]);
    expect(await activeGuestId()).toBeNull();
    await setActiveOwner(ownerA);
    await activateTab(observer);
    await waitForRecentUrls([pageB, pageA]);

    await activateTab(sourceB);
    await navigate(pageA);
    await waitForGuest(pageA, "Updated title A");
    await activateTab(observer);
    await waitForRecentUrls([pageA, pageB]);
    await closeTab(sourceA);
    await closeTab(sourceB);
    await activateTab(observer);
    await waitForRecentUrls([pageA, pageB]);

    await $(ADDRESS).setValue("https://draft.example/path");
    await expect($(ADDRESS)).toHaveValue("https://draft.example/path");
    await $(`${ACTIVE_PANEL} ${RECENT_LIST}`).waitForDisplayed();
    expect(await recentUrls()).toEqual([pageA, pageB]);
    expect(await activeGuestId()).toBeNull();

    // 原页面均已关闭；只认当前空 tab 的新 guest，不能拿其他 tab 的旧 URL 当导航成功。
    await clickRecentUrl(pageB);
    const reopened = await waitForGuest(pageB, "Page B");
    expect(await activeBrowserTabId()).toBe(observer);
    expect(await readBrowserTabIds()).toEqual([observer]);
    expect(await activeGuestId()).toBe(reopened.id);
    const checkTab = await openBlankBrowserTab();
    await waitForRecentUrls([pageB, pageA]);

    await focusRecentUrlByKeyboard(pageA);
    await browser.keys("Enter");
    await waitForGuest(pageA, "Updated title A");
    expect(await activeBrowserTabId()).toBe(checkTab);
    const iframeTab = await openBlankBrowserTab();
    await waitForRecentUrls([pageA, pageB]);

    const parentUrl = `${origin}/iframe-parent`;
    await activateTab(observer);
    await navigate(parentUrl);
    await waitForGuest(parentUrl, "Iframe parent", true);
    await activateTab(iframeTab);
    await waitForRecentUrls([parentUrl, pageA, pageB]);

    await activateTab(observer);
    await navigate(`${origin}/failure`);
    await $(`${ACTIVE_PANEL} [data-testid="${TID_BROWSER_LOAD_ERROR}"]`).waitForDisplayed({
      timeout: 30_000,
    });
    await activateTab(iframeTab);
    await waitForRecentUrls([parentUrl, pageA, pageB]);
  });

  it("BRV-09: recent visits survive app restart without restoring Browser tabs", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const owner = `E2E_BROWSER_RECENT_RESTART_${Date.now()}`;
    await setActiveOwner(owner);
    await openFirstBrowserTab();
    const page = `${origin}/page-b`;
    await navigate(page);
    await waitForGuest(page, "Page B");
    await openBlankBrowserTab();
    await waitForRecentUrls([page]);

    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setActiveOwner(owner);
    await openFirstBrowserTab();
    await waitForRecentUrls([page]);
    expect(await readBrowserTabIds()).toHaveLength(1);
    expect(await activeGuestId()).toBeNull();
  });

  it("BRV-14: removes only the selected scope visit without navigation and persists deletion", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const ownerA = `E2E_BROWSER_RECENT_DELETE_${Date.now()}`;
    const ownerB = `${ownerA}_B`;
    const pageA = `${origin}/page-b?delete=a`;
    const pageB = `${origin}/page-b?delete=b`;
    await setActiveOwner(ownerB);
    await openFirstBrowserTab();
    await navigate(pageA);
    await waitForGuest(pageA, "Page B");
    const otherObserver = await openBlankBrowserTab();
    await waitForRecentUrls([pageA]);

    await setActiveOwner(ownerA);
    await openFirstBrowserTab();
    await navigate(pageA);
    await waitForGuest(pageA, "Page B");
    await navigate(pageB);
    await waitForGuest(pageB, "Page B");
    const observer = await openBlankBrowserTab();
    await waitForRecentUrls([pageB, pageA]);
    const tabsBefore = await readBrowserTabIds();
    const removeA = await $(`${ACTIVE_PANEL} button[data-browser-recent-remove-url="${pageA}"]`);
    await expect(removeA).toHaveAttribute(
      "aria-label",
      /Remove from recent visits|从最近访问中删除/u,
    );
    await removeA.click();
    await waitForRecentUrls([pageB]);
    expect(await activeGuestId()).toBeNull();
    expect(await activeBrowserTabId()).toBe(observer);
    expect(await readBrowserTabIds()).toEqual(tabsBefore);

    await setActiveOwner(ownerB);
    await activateTab(otherObserver);
    await waitForRecentUrls([pageA]);

    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setActiveOwner(ownerA);
    await openFirstBrowserTab();
    await waitForRecentUrls([pageB]);
    expect(await activeGuestId()).toBeNull();
    await browser.execute((selector) => {
      document.querySelector<HTMLButtonElement>(selector)?.focus();
    }, `${ACTIVE_PANEL} button[data-browser-recent-remove-url]`);
    await browser.keys("Enter");
    await waitForBrowserEmpty();
    expect(await recentUrls()).toEqual([]);
    expect(await activeGuestId()).toBeNull();
    const remainingKeys = await browser.execute((owner) => {
      return Object.keys(localStorage).filter((key) => {
        if (!key.startsWith("zcode-browser-recent-visits:")) return false;
        return (
          (JSON.parse(key.slice("zcode-browser-recent-visits:".length)) as string[])[2] === owner
        );
      });
    }, ownerA);
    expect(remainingKeys).toEqual([]);
  });

  it("BRV-10: browser cache clear preserves visits and clear-all removes them", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setActiveOwner(`E2E_BROWSER_RECENT_CLEAR_${Date.now()}`);
    await openFirstBrowserTab();
    const page = `${origin}/page-b`;
    await navigate(page);
    await waitForGuest(page, "Page B");
    const observer = await openBlankBrowserTab();
    await waitForRecentUrls([page]);

    await openBrowserSettings();
    await clickSettingsButton(/clear cache|清除缓存/iu);
    await $(sel(TID_SETTINGS_BACK_BUTTON)).click();
    await activateTab(observer);
    await waitForRecentUrls([page]);

    await openBrowserSettings();
    await clickSettingsButton(/clear all|清除全部/iu);
    await clickSettingsButton(/clear data|确认清除/iu, '[role="alertdialog"]');
    await $(sel(TID_SETTINGS_BACK_BUTTON)).click();
    await activateTab(observer);
    await waitForBrowserEmpty();
    expect(await recentUrls()).toEqual([]);
  });

  it("BRV-12: recent visits cap scopes and bound persisted favicons", async function () {
    await prepareV4ConversationE2E({ skipProvider: true });
    const capSeed = await browser.execute(() => {
      const now = Date.now();
      for (let index = 0; index <= 50; index += 1) {
        const sessionId = `E2E_SCOPE_CAP_${index}`;
        const scopeKey = JSON.stringify(["/workspace", "", sessionId]);
        localStorage.setItem(
          `zcode-browser-recent-visits:${scopeKey}`,
          JSON.stringify([
            {
              url: `https://example.test/${index}`,
              title: "Page",
              faviconUrl: "data:image/png;base64," + "A".repeat(1024),
              lastVisitedAt: now + index,
            },
          ]),
        );
      }
      const scopeKey = JSON.stringify(["/workspace", "", "E2E_SCOPE_TRIGGER"]);
      localStorage.setItem(
        `zcode-browser-recent-visits:${scopeKey}`,
        JSON.stringify([
          {
            url: "https://example.test/trigger",
            title: "Trigger",
            faviconUrl: null,
            lastVisitedAt: now + 100,
          },
        ]),
      );
      return { triggerKey: `zcode-browser-recent-visits:${scopeKey}` };
    });
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    const result = await browser.execute((triggerKey) => {
      const visits = JSON.parse(localStorage.getItem(triggerKey) ?? "[]");
      const keys = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      ).filter((key): key is string => key?.startsWith("zcode-browser-recent-visits:") === true);
      const values = keys.map((key) => JSON.parse(localStorage.getItem(key) ?? "[]"));
      return {
        scopeCount: keys.length,
        triggerLoaded: visits.length === 1,
        allFaviconsBounded: values
          .flat()
          .every((visit) => visit.faviconUrl === null || visit.faviconUrl.length <= 2 * 1024),
      };
    }, capSeed.triggerKey);
    expect(result.scopeCount).toBeLessThanOrEqual(50);
    expect(result.triggerLoaded).toBe(true);
    expect(result.allFaviconsBounded).toBe(true);
    expect(
      await browser.execute(() =>
        localStorage.getItem(
          `zcode-browser-recent-visits:${JSON.stringify(["/workspace", "", "E2E_SCOPE_CAP_0"])}`,
        ),
      ),
    ).toBeNull();
  });

  it("BRV-13: a data favicon stays visible but is not persisted", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const owner = `E2E_BROWSER_RECENT_FAVICON_${Date.now()}`;
    await setActiveOwner(owner);
    await openFirstBrowserTab();
    const page = `${origin}/favicon`;
    await navigate(page);
    await waitForGuest(page, "Favicon Page");
    const source = await activeBrowserTabId();
    const observer = await openBlankBrowserTab();
    await waitForRecentUrls([page]);
    await browser.waitUntil(async () => (await recentText(page)).includes("Favicon Page"), {
      timeout: 15_000,
      timeoutMsg: "页面标题没有进入最近访问记录",
    });
    expect(await recentFaviconUrl(page)).toContain("data:image/svg+xml,");

    const persistedKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", owner])}`;
    const storedDataFavicon =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    await browser.execute((key) => {
      const storage = window.localStorage;
      const originalSetItem = storage.setItem.bind(storage);
      (window as Window & { __recentVisitWrites?: number }).__recentVisitWrites = 0;
      storage.setItem = (name, value) => {
        if (name.startsWith("zcode-browser-recent-visits:")) {
          (window as Window & { __recentVisitWrites?: number }).__recentVisitWrites! += 1;
        }
        originalSetItem(name, value);
      };
      if (!storage.getItem(key)) throw new Error("最近访问记录缺少初始持久化数据");
    }, persistedKey);

    await activateTab(source);
    const guestId = await browser.electron.execute((electron, targetUrl) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === targetUrl);
      return guest?.id ?? null;
    }, page);
    if (guestId === null) throw new Error("Favicon fixture guest is missing");
    await browser.electron.execute(
      async (electron, id, favicon) => {
        const guest = electron.webContents.fromId(id);
        if (!guest) throw new Error("Favicon fixture guest is missing");
        await guest.executeJavaScript(`(() => {
        const link = document.createElement("link");
        link.rel = "icon";
        link.href = ${JSON.stringify(favicon)};
        document.head.append(link);
      })()`);
      },
      guestId,
      storedDataFavicon,
    );
    await activateTab(observer);
    await browser.waitUntil(async () => (await recentFaviconUrl(page)) === storedDataFavicon, {
      timeout: 15_000,
      timeoutMsg: "真实页面 favicon 事件没有更新内存中的最近访问图标",
    });
    const storageResult = await browser.execute(
      (key) => ({
        record: JSON.parse(window.localStorage.getItem(key) ?? "null"),
        writes: (window as Window & { __recentVisitWrites?: number }).__recentVisitWrites ?? -1,
      }),
      persistedKey,
    );
    expect(storageResult.record[0].faviconUrl).toBeNull();
    expect(storageResult.writes).toBe(0);

    await browser.electron.execute(
      async (electron, id, favicon) => {
        const guest = electron.webContents.fromId(id);
        if (!guest) throw new Error("Favicon fixture guest is missing");
        await guest.executeJavaScript(
          `document.querySelector('link[rel="icon"]').href = ${JSON.stringify(favicon)}`,
        );
      },
      guestId,
      storedDataFavicon,
    );
    await activateTab(observer);
    await browser.waitUntil(async () => (await recentFaviconUrl(page)) === storedDataFavicon, {
      timeout: 15_000,
      timeoutMsg: "相同 favicon 再次到达后不应改变内存展示值",
    });
    const repeatResult = await browser.execute(
      (key) => ({
        record: JSON.parse(window.localStorage.getItem(key) ?? "null"),
        writes: (window as Window & { __recentVisitWrites?: number }).__recentVisitWrites ?? -1,
      }),
      persistedKey,
    );
    expect(repeatResult.writes).toBe(0);
    expect(repeatResult.record[0].faviconUrl).toBeNull();

    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setActiveOwner(owner);
    await openFirstBrowserTab();
    const restartedObserver = await openBlankBrowserTab();
    await waitForRecentUrls([page]);
    await activateTab(restartedObserver);
    expect(await recentFaviconUrl(page)).toBe("");
  });

  it("BRV-06: automatic recovery does not reorder recent visits", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setActiveOwner(`E2E_BROWSER_RECOVERY_${Date.now()}`);
    await openFirstBrowserTab();
    const source = await activeBrowserTabId();
    const recoveryPage = `${origin}/recovery`;
    const otherPage = `${origin}/page-b`;
    await navigate(recoveryPage);
    await waitForGuest(recoveryPage, "Recovery Page");
    const other = await openBlankBrowserTab();
    await navigate(otherPage);
    await waitForGuest(otherPage, "Page B");
    const observer = await openBlankBrowserTab();
    await waitForRecentUrls([otherPage, recoveryPage]);

    await activateTab(source);
    await crashActiveGuest();
    await waitForGuest(recoveryPage, "Recovery Page");
    await activateTab(observer);
    await waitForRecentUrls([otherPage, recoveryPage]);
    await closeTab(source);
    await closeTab(other);
    await closeTab(observer);
  });

  it("BRV-06: redirected recovery cannot suppress a later in-page visit", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setActiveOwner(`E2E_BROWSER_REDIRECT_RECOVERY_${Date.now()}`);
    await openFirstBrowserTab();
    const source = await activeBrowserTabId();
    const recoveryPage = `${origin}/recovery`;
    const redirectPage = `${origin}/recovery-redirect`;
    const otherPage = `${origin}/page-b`;
    await navigate(recoveryPage);
    await waitForGuest(recoveryPage, "Recovery Page");
    const other = await openBlankBrowserTab();
    await navigate(otherPage);
    await waitForGuest(otherPage, "Page B");
    const observer = await openBlankBrowserTab();
    await waitForRecentUrls([otherPage, recoveryPage]);

    await activateTab(source);
    redirectRecovery = true;
    try {
      await crashActiveGuest();
      await waitForGuest(redirectPage, "Recovery Redirect");
    } finally {
      redirectRecovery = false;
    }
    await activateTab(observer);
    await waitForRecentUrls([redirectPage, otherPage, recoveryPage]);

    await activateTab(source);
    const guestId = await activeGuestId();
    if (guestId === null) throw new Error("恢复后的 guest 不存在");
    await browser.electron.execute(async (electron, id) => {
      await electron.webContents
        .fromId(id)!
        .executeJavaScript('document.querySelector("a[data-e2e-revisit]").click()');
    }, guestId);
    await waitForGuest(recoveryPage, "Recovery Page");
    await activateTab(observer);
    await waitForRecentUrls([recoveryPage, redirectPage, otherPage]);
    await closeTab(source);
    await closeTab(other);
    await closeTab(observer);
  });
});

async function crashActiveGuest(): Promise<void> {
  const oldId = await activeGuestId();
  if (oldId === null) throw new Error("缺少待崩溃的 guest");
  await browser.electron.execute((electron, id) => {
    electron.webContents.fromId(id)!.forcefullyCrashRenderer();
  }, oldId);
  await browser.waitUntil(
    async () => {
      try {
        const id = await activeGuestId();
        return id !== null && id !== oldId;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, timeoutMsg: "崩溃后未创建替代 guest" },
  );
}

async function openBrowserSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "browser"), { timeout: 15_000 });
  await $("[data-settings-content-frame]").waitForDisplayed({ timeout: 15_000 });
}

async function clickSettingsButton(
  label: RegExp,
  root = "[data-settings-content-frame]",
): Promise<void> {
  for (const candidate of await $$(`${root} button`)) {
    if (label.test(await candidate.getText())) {
      await candidate.click();
      return;
    }
  }
  throw new Error(`设置页中没有匹配的操作按钮：${label}`);
}

async function openFirstBrowserTab(): Promise<void> {
  // 通用 helper 的 Meta+Alt+B 只适用于 macOS；直接使用真实按钮保持跨平台一致。
  const entry = '[data-side-pane-open-tab-item="browser"]';
  if (!(await $(entry).isDisplayed())) {
    const toggle = await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    await toggle.waitForDisplayed({ timeout: 15_000 });
    await toggle.click();
  }
  await $(entry).waitForDisplayed({ timeout: 15_000 });
  await $(entry).click();
  await $(ADDRESS).waitForDisplayed({ timeout: 15_000 });
}

async function setActiveOwner(ownerId: string): Promise<void> {
  await browser.execute(
    (workspacePath, taskId) => {
      const store = (window as ScopeWindow).__zcodeSessionStoreE2E;
      if (!store) throw new Error("缺少 E2E session store bridge");
      store.getState().setActiveTaskId(workspacePath, taskId);
    },
    DEFAULT_WORKSPACE,
    ownerId,
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (workspacePath, taskId) =>
          (window as ScopeWindow).__zcodeSessionStoreE2E?.getState().workspaces[workspacePath]
            ?.activeTaskId === taskId,
        DEFAULT_WORKSPACE,
        ownerId,
      ),
    { timeout: 15_000, timeoutMsg: `Browser fixture owner ${ownerId} 没有就绪` },
  );
}

async function waitForBrowserEmpty(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((panelSelector) => {
        const text = document.querySelector<HTMLElement>(panelSelector)?.innerText ?? "";
        return (
          text.includes("Paste or type a URL to open a page.") ||
          text.includes("粘贴或输入 URL 以打开网页。")
        );
      }, ACTIVE_PANEL),
    { timeout: 15_000, timeoutMsg: "没有显示既有 browser.empty 文案" },
  );
}

async function activeBrowserTabId(): Promise<string> {
  const tab = await $('[data-side-pane-tab-id^="browser:"][data-state="active"]');
  await tab.waitForDisplayed({ timeout: 15_000 });
  const id = await tab.getAttribute("data-side-pane-tab-id");
  if (!id) throw new Error("没有 active Browser tab");
  return id;
}

async function activateTab(id: string): Promise<void> {
  const tab = await $(`[data-side-pane-tab-id="${id}"]`);
  await tab.click();
  await expect(tab).toHaveAttribute("data-state", "active");
  await $(ADDRESS).waitForDisplayed({ timeout: 15_000 });
}

async function openBlankBrowserTab(): Promise<string> {
  const before = await readBrowserTabIds();
  await $("[data-side-pane-add-trigger]").click();
  const launcher = await $(`${ACTIVE_PANEL} [data-side-pane-open-tab-item="browser"]`);
  await launcher.waitForDisplayed({ timeout: 15_000 });
  await launcher.click();
  await browser.waitUntil(async () => (await readBrowserTabIds()).length === before.length + 1, {
    timeout: 15_000,
    timeoutMsg: "新建 Browser tab 未完成",
  });
  const id = await activeBrowserTabId();
  expect(before).not.toContain(id);
  await $(ADDRESS).waitForDisplayed({ timeout: 15_000 });
  expect(await activeGuestId()).toBeNull();
  return id;
}

async function closeTab(id: string): Promise<void> {
  const tab = await $(`[data-side-pane-tab-id="${id}"]`);
  await tab.moveTo();
  await tab.$("button").click();
  await tab.waitForExist({ reverse: true, timeout: 15_000 });
}

async function navigate(url: string): Promise<void> {
  const address = await $(ADDRESS);
  await address.waitForDisplayed({ timeout: 15_000 });
  await address.setValue(url);
  await address.click();
  await browser.keys("Enter");
}

async function activeGuestId(): Promise<number | null> {
  return browser.execute((selector) => {
    const webview = document.querySelector<HTMLElement & { getWebContentsId(): number }>(selector);
    return webview ? webview.getWebContentsId() : null;
  }, `${ACTIVE_PANEL} [data-testid="${TID_BROWSER_WEBVIEW}"]`);
}

async function waitForGuest(
  url: string,
  title: string,
  iframeLoaded = false,
): Promise<GuestSnapshot> {
  let latest: GuestSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      const id = await activeGuestId();
      if (id === null) return false;
      latest = (await browser.electron.execute(async (electron, guestId) => {
        const guest = electron.webContents.fromId(guestId);
        if (!guest || guest.isDestroyed() || guest.isLoading()) return null;
        const content = await guest.executeJavaScript(`({
        ready: document.readyState === "complete",
        iframeLoaded: document.querySelector("iframe")?.contentDocument?.querySelector("[data-e2e-child]") !== null &&
          Boolean(document.querySelector("iframe")?.contentDocument?.querySelector("[data-e2e-child]"))
      })`);
        return { id: guest.id, url: guest.getURL(), title: guest.getTitle(), ...content };
      }, id)) as unknown as GuestSnapshot | null;
      return (
        latest?.url === url &&
        latest.title === title &&
        latest.ready &&
        (!iframeLoaded || latest.iframeLoaded)
      );
    },
    { timeout: 30_000, timeoutMsg: `当前 guest 未完成导航 ${url} / ${title}` },
  );
  if (!latest) throw new Error(`缺少 guest ${url}`);
  return latest;
}

async function expectRecentVisitsCentered(): Promise<void> {
  const geometry = await browser.execute(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="browser-recent-visits"]');
    const content = document.querySelector<HTMLElement>(
      '[data-testid="browser-recent-visits-content"]',
    );
    if (!viewport || !content) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      contentCenterY: contentRect.top + contentRect.height / 2,
      contentCenterX: contentRect.left + contentRect.width / 2,
      contentCenterRatioY:
        (contentRect.top + contentRect.height / 2 - viewportRect.top) / viewportRect.height,
      viewportCenterY: viewportRect.top + viewportRect.height / 2,
      viewportCenterX: viewportRect.left + viewportRect.width / 2,
      viewportWidth: viewportRect.width,
      contentWidth: contentRect.width,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.contentCenterRatioY).toBeCloseTo(0.4, 2);
  expect(Math.abs(geometry!.contentCenterX - geometry!.viewportCenterX)).toBeLessThanOrEqual(2);
  expect(geometry!.contentWidth).toBeLessThanOrEqual(672);
  expect(geometry!.contentWidth).toBeLessThanOrEqual(geometry!.viewportWidth);
}

async function recentUrls(): Promise<string[]> {
  return browser.execute(
    (selector) =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(selector),
        (button) => button.getAttribute("data-browser-recent-url") ?? "",
      ),
    `${ACTIVE_PANEL} ${RECENT_BUTTON}`,
  );
}

async function waitForRecentUrls(expected: string[]): Promise<void> {
  await $(`${ACTIVE_PANEL} ${RECENT_LIST}`).waitForDisplayed({ timeout: 15_000 });
  await browser.waitUntil(
    async () => JSON.stringify(await recentUrls()) === JSON.stringify(expected),
    {
      timeout: 15_000,
      timeoutMsg: `最近访问列表未收敛到 ${expected.join(", ")}`,
    },
  );
}

async function recentFaviconUrl(url: string): Promise<string> {
  return browser.execute(
    (selector, target) => {
      const item = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(
        (button) => button.getAttribute("data-browser-recent-url") === target,
      );
      return item?.querySelector("img")?.getAttribute("src") ?? "";
    },
    `${ACTIVE_PANEL} ${RECENT_BUTTON}`,
    url,
  );
}

async function recentText(url: string): Promise<string> {
  return browser.execute(
    (selector, target) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(
        (button) => button.getAttribute("data-browser-recent-url") === target,
      )?.innerText ?? "",
    `${ACTIVE_PANEL} ${RECENT_BUTTON}`,
    url,
  );
}

async function clickRecentUrl(url: string): Promise<void> {
  for (const button of await $$(`${ACTIVE_PANEL} ${RECENT_BUTTON}`)) {
    if ((await button.getAttribute("data-browser-recent-url")) === url) {
      await button.click();
      return;
    }
  }
  throw new Error(`最近访问列表中没有 URL ${url}`);
}

async function focusRecentUrlByKeyboard(url: string): Promise<void> {
  await $(ADDRESS).click();
  for (let step = 0; step < 20; step += 1) {
    await browser.keys("Tab");
    const focusedUrl = await browser.execute(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute("data-browser-recent-url"),
    );
    if (focusedUrl === url) return;
  }
  throw new Error(`Tab 焦点没有到达最近访问 URL ${url}`);
}

function createFixtureServer(): Server {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.url === "/failure") {
      request.socket.destroy();
      return;
    }
    if (request.url === "/late-title") {
      if (titleReleased) response.end("Updated title A");
      else {
        titleResponses.add(response);
        response.once("close", () => titleResponses.delete(response));
      }
      return;
    }
    if (request.url === "/recovery" && redirectRecovery) {
      response.writeHead(302, { location: "/recovery-redirect" });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/page-a") {
      response.end(
        '<!doctype html><title>Page A</title><main>Page A</main><script>fetch("/late-title").then(r => r.text()).then(title => { document.title = title; });</script>',
      );
    } else if (request.url === "/favicon") {
      response.end(
        '<!doctype html><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22%3E%3Ccircle cx=%228%22 cy=%228%22 r=%228%22 fill=%22red%22/%3E%3C/svg%3E"><title>Favicon Page</title><main>Favicon Page</main>',
      );
    } else if (request.url === "/recovery") {
      response.end("<!doctype html><title>Recovery Page</title><main>Recovery Page</main>");
    } else if (request.url === "/recovery-redirect") {
      response.end(
        '<!doctype html><title>Recovery Redirect</title><a data-e2e-revisit href="/recovery">Revisit recovery</a>',
      );
    } else if (request.url === "/page-b" || request.url?.startsWith("/page-b?delete=")) {
      response.end("<!doctype html><title>Page B</title><main>Page B</main>");
    } else if (request.url === "/iframe-parent") {
      response.end(
        '<!doctype html><title>Iframe parent</title><iframe src="/iframe-child"></iframe>',
      );
    } else if (request.url === "/iframe-child") {
      response.end(
        "<!doctype html><title>Iframe child</title><main data-e2e-child>child loaded</main>",
      );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
}

async function listen(fixtureServer: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => {
      fixtureServer.off("error", reject);
      resolve();
    });
  });
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("最近访问 fixture 未绑定端口");
  return `http://127.0.0.1:${address.port}`;
}

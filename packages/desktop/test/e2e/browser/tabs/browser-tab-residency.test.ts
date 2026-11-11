import { TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";

const INITIAL_TAB_COUNT = 32;
const OVER_LIMIT_TAB_NUMBER = 33;

interface BrowserTabDomSnapshot {
  liveGuestIds: number[];
  suspendedTabIds: string[];
  tabIds: string[];
}

interface BrowserBridgeStepResult {
  ok: boolean;
  reason: string;
}

interface BrowserTestBridge {
  browserViewAttachGuest?: (payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    sessionId?: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  browserViewDetachGuest?: (payload: { key: string; webContentsId: number }) => Promise<boolean>;
}

describe("Browser tab logical limit E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BTL04/BTL12: 第 33 个 tab 关闭最老 tab，完整重启后不恢复任何 tab", async function () {
    this.timeout(300000);
    await prepareConversationE2E({ skipProvider: true });

    let browserTabCount = await readBrowserTabCount();
    if (browserTabCount === 0) {
      await openFirstBrowserTab();
      browserTabCount = 1;
    }
    if (browserTabCount !== 1) {
      throw new Error(`Browser residency 用例启动时应只有一个 tab，实际为 ${browserTabCount}`);
    }

    for (let sequence = 2; sequence <= INITIAL_TAB_COUNT; sequence += 1) {
      await openAdditionalBrowserTab(sequence);
    }

    const initialTabIds = await readBrowserTabIds();
    const targetTabId = initialTabIds[0];
    const reusableGuestId = await createReusableBrowserGuest();
    const workspaceKey = await readActiveWorkspaceKey();
    if (!targetTabId || !reusableGuestId || !workspaceKey) {
      throw new Error("缺少 Browser residency 注册上下文");
    }

    // Bug 原因：旧 E2E 要求同时创建 32 个真实 webview，测试 Electron 在第 15 个附近会因
    // guest 资源压力销毁整组 WebContents。这里复用一个真实 guest 经 preload IPC 注册 logical
    // tab 后立即 detach；链路仍经过 main coordinator，并覆盖 BTL20 的 non-live logical tab。
    for (const tabId of initialTabIds) {
      await registerDetachedBrowserTab(tabId, reusableGuestId, workspaceKey);
    }

    const initial = await waitForBrowserSnapshot(
      (snapshot) =>
        snapshot.tabIds.length === INITIAL_TAB_COUNT && snapshot.liveGuestIds.length === 0,
      "前 32 个 Browser logical tab 没有收敛",
    );
    expect(initial.tabIds[0]).toBe(targetTabId);

    // Bug 回归：旧实现只销毁 guest 并把 tab 标成 suspended，标签栏仍保留。
    // 首个 non-live tab 最先注册，因而它稳定成为最老的安全候选。

    await openAdditionalBrowserTab(OVER_LIMIT_TAB_NUMBER);
    const overLimitTabId = (await readBrowserTabIds()).at(-1);
    if (!overLimitTabId) throw new Error("缺少第 33 个 Browser tab 的身份");
    await registerDetachedBrowserTab(overLimitTabId, reusableGuestId, workspaceKey);

    const afterEviction = await waitForBrowserSnapshot(
      (snapshot) =>
        snapshot.tabIds.length === INITIAL_TAB_COUNT &&
        !snapshot.tabIds.includes(targetTabId) &&
        snapshot.liveGuestIds.length === 0,
      "打开第 33 个 Browser tab 后，最老逻辑 tab 仍显示在标签栏",
    );
    expect(afterEviction.tabIds).toHaveLength(INITIAL_TAB_COUNT);
    expect(afterEviction.tabIds).not.toContain(targetTabId);
    expect(afterEviction.liveGuestIds).toEqual([]);
    expect(await readGuestExists(reusableGuestId)).toBe(true);
    const mainGuestCount = await browser.electron.execute(
      (electron) =>
        electron.webContents
          .getAllWebContents()
          .filter((contents) => !contents.isDestroyed() && contents.getType() === "webview").length,
    );
    expect(mainGuestCount).toBe(1);

    // 产品语义：Browser Tab 只属于当前 Electron 进程。旧实现把其余 32 个 shell/pageState
    // 落盘并在新进程惰性恢复，既偏离已发布生产行为，也会触发恢复期重复 attach 白屏竞态。
    const userDataDir = await readBrowserUserDataDir();
    const restartedUserDataDir = await reloadElectronSessionPreservingBrowserProfile(browser);
    expect(restartedUserDataDir).toBe(userDataDir);
    await prepareConversationE2E({ skipProvider: true });
    const restarted = await waitForBrowserSnapshot(
      (snapshot) =>
        snapshot.tabIds.length === 0 &&
        snapshot.liveGuestIds.length === 0 &&
        snapshot.suspendedTabIds.length === 0,
      "BTL12: 完整重启后 Browser tab 仍被恢复",
    );
    expect(restarted).toEqual({ liveGuestIds: [], suspendedTabIds: [], tabIds: [] });
    const restartedMainGuestCount = await browser.electron.execute(
      (electron) =>
        electron.webContents
          .getAllWebContents()
          .filter((contents) => !contents.isDestroyed() && contents.getType() === "webview").length,
    );
    expect(restartedMainGuestCount).toBe(0);
  });
});

async function openFirstBrowserTab(): Promise<void> {
  const openedFromLauncher = await clickOpenTabBrowserItem();
  if (openedFromLauncher) {
    await waitForTabCount(1);
    return;
  }

  await ensureSidePaneEntryVisible();
  if (await clickOpenTabBrowserItem()) {
    await waitForTabCount(1);
    return;
  }
  await openAdditionalBrowserTab(1);
}

async function ensureSidePaneEntryVisible(): Promise<void> {
  // Bug 原因：workspace ready 只证明 conversation shell 可用，side-pane launcher 仍可能在
  // 后续 React commit 才出现；固定重试 3 × 300ms 会在慢启动机器上提前失败。
  await browser.waitUntil(
    async () => {
      const visible = await browser.execute(() =>
        Boolean(
          document.querySelector(
            '[data-side-pane-open-tab-item="browser"], [data-side-pane-add-trigger]',
          ),
        ),
      );
      if (visible) return true;
      // 与产品 ⌥⌘B 共用真实 workspace shortcut；初始 side-pane 收起态和已展开态都可兼容。
      await browser.execute(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "b",
            code: "KeyB",
            altKey: true,
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      return false;
    },
    {
      interval: 500,
      timeout: 15000,
      timeoutMsg: "切换右侧面板后没有出现 Open Tab 或 add trigger",
    },
  );
}

function clickOpenTabBrowserItem(): Promise<boolean> {
  return browser.execute(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-side-pane-open-tab-item="browser"]',
    );
    if (!button) return false;
    button.click();
    return true;
  });
}

function readBrowserTabCount(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]').length,
  );
}

function readBrowserTabIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]'))
      .map((tab) => tab.dataset.sidePaneTabId ?? "")
      .filter(Boolean),
  );
}

async function openAdditionalBrowserTab(expectedCount: number): Promise<void> {
  await requestAdditionalBrowserTab(expectedCount);
  await waitForTabCount(expectedCount);
  await activateLatestBrowserTab();
}

async function activateLatestBrowserTab(): Promise<void> {
  // 新 tab 写入状态与 Tabs content 切换分属不同的 React commit；显式点击最新 trigger，
  // 避免在旧 active content 上等待新 tab 的地址栏。
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const tabs = Array.from(
          document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]'),
        );
        const latest = tabs.at(-1);
        if (!latest) return false;
        if (latest.hasAttribute("data-active")) return true;
        latest.click();
        return false;
      }),
    {
      timeout: 10000,
      timeoutMsg: "最新 Browser tab 没有切换为 active",
    },
  );
}

function createReusableBrowserGuest(): Promise<number> {
  return browser.executeAsync((done) => {
    const guest = document.createElement("webview") as HTMLElement & {
      getWebContentsId?: () => number;
      src: string;
    };
    guest.src = "about:blank";
    guest.style.cssText =
      "position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none";
    const timeout = window.setTimeout(() => done(0), 10000);
    guest.addEventListener(
      "dom-ready",
      () => {
        window.clearTimeout(timeout);
        done(guest.getWebContentsId?.() ?? 0);
      },
      { once: true },
    );
    document.body.append(guest);
  }) as Promise<number>;
}

async function registerDetachedBrowserTab(
  tabId: string,
  webContentsId: number,
  workspaceKey: string,
): Promise<void> {
  const result = (await browser.executeAsync(
    async (targetTabId, guestId, targetWorkspaceKey, done) => {
      try {
        const bridge = (window as Window & { zcode?: BrowserTestBridge }).zcode;
        const attached = await bridge?.browserViewAttachGuest?.({
          key: targetTabId,
          webContentsId: guestId,
          active: false,
          workspaceKey: targetWorkspaceKey,
          sessionId: "unscoped",
        });
        if (!attached?.ok) {
          done({ ok: false, reason: attached?.reason ?? "attach-unavailable" });
          return;
        }
        const detached = await bridge?.browserViewDetachGuest?.({
          key: targetTabId,
          webContentsId: guestId,
        });
        done({ ok: detached === true, reason: detached ? "ok" : "detach-rejected" });
      } catch (error) {
        done({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    },
    tabId,
    webContentsId,
    workspaceKey,
  )) as BrowserBridgeStepResult;
  if (!result.ok) {
    throw new Error(`注册 non-live Browser tab 失败: ${tabId}, ${result.reason}`);
  }
}

function readActiveWorkspaceKey(): Promise<string | null> {
  return browser.execute(() => {
    const bridge = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState?: () => {
            activeWorkspaceIdentity?: string | null;
            activeWorkspacePath?: string | null;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    const state = bridge?.getState?.();
    return state?.activeWorkspaceIdentity?.trim() || state?.activeWorkspacePath || null;
  });
}

async function requestAdditionalBrowserTab(sequence: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const trigger = document.querySelector<HTMLElement>("[data-side-pane-add-trigger]");
        if (!trigger) return false;
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        trigger.click();
        return true;
      }),
    {
      timeout: 10000,
      timeoutMsg: `创建第 ${sequence} 个 Browser tab 时没有找到 add trigger`,
    },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const item = document.querySelector<HTMLElement>(
          '[data-state="active"] [data-side-pane-open-tab-item="browser"]',
        );
        if (!item) return false;
        item.click();
        return true;
      }),
    {
      timeout: 10000,
      timeoutMsg: `创建第 ${sequence} 个 Browser tab 时菜单项没有出现`,
    },
  );
}

async function waitForTabCount(expectedCount: number, timeout = 10000): Promise<void> {
  let latestCount = 0;
  await browser.waitUntil(
    async () => {
      latestCount = await browser.execute(
        () => document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]').length,
      );
      return latestCount === expectedCount;
    },
    {
      timeout,
      timeoutMsg: `Browser 逻辑 tab 数量没有达到 ${expectedCount}，最后观察到 ${latestCount}`,
    },
  );
}

async function waitForBrowserSnapshot(
  predicate: (snapshot: BrowserTabDomSnapshot) => boolean,
  timeoutMsg: string,
): Promise<BrowserTabDomSnapshot> {
  let latest: BrowserTabDomSnapshot = {
    liveGuestIds: [],
    suspendedTabIds: [],
    tabIds: [],
  };
  await browser.waitUntil(
    async () => {
      latest = await readBrowserSnapshot();
      return predicate(latest);
    },
    {
      timeout: 30000,
      timeoutMsg: `${timeoutMsg}: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

function readBrowserSnapshot(): Promise<BrowserTabDomSnapshot> {
  return browser.execute((webviewTestId) => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]'),
    );
    return {
      tabIds: tabs.map((tab) => tab.dataset.sidePaneTabId ?? "").filter(Boolean),
      suspendedTabIds: tabs
        .filter((tab) => tab.dataset.browserTabResidency === "suspended")
        .map((tab) => tab.dataset.sidePaneTabId ?? "")
        .filter(Boolean),
      liveGuestIds: Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${webviewTestId}"]`),
      )
        .map((element) => {
          try {
            return (
              (element as HTMLElement & { getWebContentsId?: () => number }).getWebContentsId?.() ??
              0
            );
          } catch {
            // Bug 原因：上限关闭先销毁 guest、React 随后移除 webview；事务窗口内
            // getWebContentsId 会抛错。快照应把它视为已无 live guest，而不是整次轮询失败。
            return 0;
          }
        })
        .filter((id) => id > 0),
    };
  }, TID_BROWSER_WEBVIEW);
}

async function readBrowserUserDataDir(): Promise<string> {
  return (await browser.electron.execute((electron) => electron.app.getPath("userData"))) as string;
}

function readGuestExists(webContentsId: number): Promise<boolean> {
  return browser.electron.execute((electron, id) => {
    const guest = electron.webContents.fromId(id);
    return Boolean(guest && !guest.isDestroyed());
  }, webContentsId) as unknown as Promise<boolean>;
}

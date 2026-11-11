/**
 * 右侧面板 Browser tab 的通用 E2E 操作。
 *
 * 抽取原因：跨 workspace 关闭通知的用例需要和 `browser-tab-close-idempotent.test.ts`
 * 完全一致的开 tab / 读 tab / 等待收敛动作，两份复制的实现一旦漂移就会出现
 * “一个 spec 绿另一个红”的假信号。
 */

export async function openFirstBrowserTab(): Promise<void> {
  if (await clickOpenTabBrowserItem()) {
    await waitForTabCount(1);
    return;
  }

  await ensureSidePaneEntryVisible();
  if (await clickOpenTabBrowserItem()) {
    await waitForTabCount(1);
    return;
  }
  await requestAdditionalBrowserTab();
  await waitForTabCount(1);
}

export async function clickCloseButton(tabId: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const trigger = document.querySelector<HTMLElement>(`[data-side-pane-tab-id="${targetTabId}"]`);
    // tab 内只有关闭按钮是原生 button，外层容器为 div，不会误点到激活区域。
    const closeButton = trigger?.querySelector<HTMLButtonElement>("button");
    if (!closeButton) return false;
    closeButton.click();
    return true;
  }, tabId);
  if (!clicked) throw new Error(`没有找到 Browser tab ${tabId} 的关闭按钮`);
}

export async function ensureSidePaneEntryVisible(): Promise<void> {
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
      // 与产品快捷键共用真实 workspace shortcut（macOS ⌥⌘B，Windows/Linux Ctrl+Alt+B），初始收起态与已展开态都兼容。
      await browser.execute(() => {
        const mac = navigator.platform.startsWith("Mac");
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "b",
            code: "KeyB",
            altKey: true,
            metaKey: mac,
            ctrlKey: !mac,
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

export function clickOpenTabBrowserItem(): Promise<boolean> {
  return browser.execute(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-side-pane-open-tab-item="browser"]',
    );
    if (!button) return false;
    button.click();
    return true;
  });
}

export async function requestAdditionalBrowserTab(): Promise<void> {
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
    { timeout: 10000, timeoutMsg: "创建 Browser tab 时没有找到 add trigger" },
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
    { timeout: 10000, timeoutMsg: "创建 Browser tab 时菜单项没有出现" },
  );
}

export function readBrowserTabIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]')).map(
      (element) => element.dataset.sidePaneTabId ?? "",
    ),
  );
}

export function countBrowserTabs(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="browser:"]').length,
  );
}

export async function waitForTabCount(expectedCount: number, timeout = 10000): Promise<void> {
  try {
    await browser.waitUntil(async () => (await countBrowserTabs()) === expectedCount, {
      timeout,
      timeoutMsg: `Browser 逻辑 tab 数量没有达到 ${expectedCount}`,
    });
  } catch (error) {
    // timeoutMsg 是调用 waitUntil 时就求值的模板串，读不到轮询期间的观测值（旧写法恒为初始值）。
    // 超时后补读一次真实数量，失败信息才有诊断价值。
    throw new Error(
      `Browser 逻辑 tab 数量没有达到 ${expectedCount}，最后观察到 ${await countBrowserTabs()}`,
      { cause: error },
    );
  }
}

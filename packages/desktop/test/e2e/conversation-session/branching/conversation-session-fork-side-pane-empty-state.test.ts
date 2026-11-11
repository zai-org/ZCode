import { TID_V4_COMPOSER_INPUT, TID_V4_SESSION_PANE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickFirstV4Fork,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PARENT_MARKER = "E2E_SSC_FORK_SIDE_PANE_PARENT";
const PARENT_REPLY = "SSC_FORK_SIDE_PANE_REPLY";
const SIDE_DRAFT = "SSC_FORK_SIDE_PANE_DRAFT_KEEP";

describe("fork 后 Side Pane 空态 manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSC22/FX12: child 无可见 tab 时显示启动页，切回 parent 恢复辅助对话", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(PARENT_MARKER);
    await waitForV4TimelineContaining(PARENT_REPLY, 60000);
    await waitForV4Fork();

    const parent = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "SSC22 parent session 没有建立",
    );
    const parentSessionId = parent.sessionId;
    if (!parentSessionId || parentSessionId === "draft") {
      throw new Error("SSC22 parent sessionId missing");
    }

    await expandSidePane();
    await waitForOpenTabLauncher("parent Side Pane 启动页没有出现");
    await clickOpenTabItem("selection-side-conversation");
    const parentSideChat = await waitForSelectionSidePane();
    await setComposerText(parentSideChat.paneTestId, SIDE_DRAFT);

    const clickedFork = await clickFirstV4Fork();
    expect(clickedFork).toBe(true);
    const child = await waitForV4Pane(
      (snapshot) =>
        Boolean(
          snapshot.sessionId &&
          snapshot.sessionId !== "draft" &&
          snapshot.sessionId !== parentSessionId,
        ),
      "fork 后没有切换到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    await expandSidePane();
    await waitForOpenTabLauncher("fork child 没有可见 tab 时未显示启动页，Side Pane 仍为空白");
    const childSidePane = await readOpenSidePaneState();
    expect(childSidePane.launcherVisible).toBe(true);
    // 默认空 scope 现在有一个 new-tab 启动页；父辅助 tab 仍必须被 scope 隔离。
    expect(childSidePane.visibleTabIds).toHaveLength(1);
    expect(childSidePane.visibleTabIds).not.toContain(parentSideChat.tabId);
    expect(childSidePane.openItemIds).toContain("selection-side-conversation");

    await selectV4TaskById(parentSessionId);
    await expandSidePane();
    const restoredSideChat = await waitForSelectionSidePane();
    expect(restoredSideChat.tabId).toBe(parentSideChat.tabId);
    expect(restoredSideChat.childSessionId).toBe(parentSideChat.childSessionId);
    expect(await readComposerText(restoredSideChat.paneTestId)).toBe(SIDE_DRAFT);
  });
});

async function expandSidePane(): Promise<void> {
  const alreadyOpen = await browser.execute(() =>
    Boolean(document.querySelector("button svg.lucide-panel-right-close")),
  );
  if (!alreadyOpen) {
    const clicked = await browser.execute(() => {
      const icon = document.querySelector("button svg.lucide-panel-right-open");
      const button = icon?.closest<HTMLButtonElement>("button");
      if (!button) return false;
      button.click();
      return true;
    });
    expect(clicked).toBe(true);
  }
  await browser.waitUntil(
    async () =>
      browser.execute(() => Boolean(document.querySelector("button svg.lucide-panel-right-close"))),
    { timeout: 15000, timeoutMsg: "Side Pane 没有展开" },
  );
}

async function waitForOpenTabLauncher(timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await readOpenSidePaneState()).launcherVisible, {
    timeout: 15000,
    timeoutMsg,
  });
}

async function clickOpenTabItem(itemId: string): Promise<void> {
  const clicked = await browser.execute((nextItemId) => {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-side-pane-open-tab-item="${nextItemId}"]`,
    );
    if (!button) return false;
    button.click();
    return true;
  }, itemId);
  expect(clicked).toBe(true);
}

async function readOpenSidePaneState(): Promise<{
  launcherVisible: boolean;
  openItemIds: string[];
  visibleTabIds: string[];
}> {
  return browser.execute(() => {
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const launcher = document.querySelector(".side-pane-open-tab-shell");
    return {
      launcherVisible: Boolean(launcher && isVisible(launcher)),
      openItemIds: Array.from(
        document.querySelectorAll<HTMLElement>("[data-side-pane-open-tab-item]"),
      )
        .filter(isVisible)
        .map((element) => element.dataset.sidePaneOpenTabItem ?? "")
        .filter(Boolean),
      visibleTabIds: Array.from(document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"))
        .filter(isVisible)
        .map((element) => element.dataset.sidePaneTabId ?? "")
        .filter(Boolean),
    };
  });
}

async function waitForSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: {
    childSessionId: string;
    paneTestId: string;
    tabId: string;
  } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const childSessionId = pane?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "辅助对话 Side Pane 没有打开" },
  );
  if (!result) throw new Error("selection side pane result missing");
  return result;
}

async function setComposerText(paneTestId: string, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, nextText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          const bridge = (
            input as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: {
                    getText: () => string;
                    setText: (value: string) => void;
                  };
                })
              | undefined
          )?.__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.setText(nextText);
          return bridge.getText() === nextText;
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    { timeout: 15000, timeoutMsg: `辅助对话 composer 不可输入: ${paneTestId}` },
  );
}

async function readComposerText(paneTestId: string): Promise<string | null> {
  return browser.execute(
    (nextPaneTestId, inputTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
      const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      return (
        (
          input as
            | (HTMLElement & {
                __zcodeLexicalInputE2E?: { getText: () => string };
              })
            | undefined
        )?.__zcodeLexicalInputE2E?.getText() ?? null
      );
    },
    paneTestId,
    TID_V4_COMPOSER_INPUT,
  );
}

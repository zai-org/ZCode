import {
  TID_SIDE_PANE_TOGGLE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const MAIN_PANE = "workspace-main";
const SEED = "E2E_SSC_ESCAPE_SEED";
const RUNNING = "E2E_SSC_ESCAPE_RUNNING";
const paneSelector = (paneId: string) => `[data-testid="${testId(TID_V4_SESSION_PANE, paneId)}"]`;
const inputSelector = (paneId: string) =>
  `${paneSelector(paneId)} [data-testid="${TID_V4_COMPOSER_INPUT}"]`;

async function send(paneId: string, marker: string): Promise<void> {
  const input = $(inputSelector(paneId));
  await input.waitForDisplayed();
  await browser.waitUntil(async () => (await input.getAttribute("contenteditable")) === "true");
  await input.click();
  await browser.keys(marker);
  await browser.waitUntil(async () => (await input.getText()).includes(marker));
  await $(`${paneSelector(paneId)} [data-testid="${TID_V4_COMPOSER_SEND}"]`).click();
  await waitForV4Pane(
    (pane) => pane.canStop && currentTurnText(pane.timelineText, marker).includes("ssc-live-1"),
    `${marker} 未开始流式输出`,
    30000,
    paneId,
  );
}

function currentTurnText(timeline: string, marker: string): string {
  const index = timeline.lastIndexOf(marker);
  return index < 0 ? "" : timeline.slice(index + marker.length);
}

async function focusInput(paneId: string): Promise<void> {
  const input = $(inputSelector(paneId));
  await input.click();
  await expect(input).toBeFocused();
}

async function focusOutsidePanes(): Promise<void> {
  // 面板开关的 Tooltip 会消费 Esc；移开指针并失焦，验证无浮层的页面空白焦点。
  await browser.action("pointer").move({ x: 5, y: 5 }).perform();
  await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
  await browser.waitUntil(() =>
    browser.execute(
      () =>
        document.activeElement === document.body &&
        !document.querySelector('[data-slot="tooltip-content"]'),
    ),
  );
}

describe("Side chat Esc focus ownership", () => {
  let childPaneId = "";

  beforeEach(async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await sendV4Prompt(SEED);
    await waitForV4Pane(
      (pane) => !pane.canStop && pane.timelineText.includes("ssc-seed-ready"),
      "父会话未完成初始化",
    );
    const previousTabIds = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="selection-side-chat:"]'),
        (tab) => tab.dataset.sidePaneTabId,
      ),
    );
    await focusInput(MAIN_PANE);
    await browser.keys("/btw");
    const option = $('[data-option-id="app-slash:btw"]');
    await option.waitForDisplayed();
    await option.click();
    await browser.waitUntil(async () => {
      childPaneId = await browser.execute(
        (previous) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-side-pane-tab-id^="selection-side-chat:"]',
            ),
          ).find((tab) => !previous.includes(tab.dataset.sidePaneTabId))?.dataset.sidePaneTabId ??
          "",
        previousTabIds,
      );
      return Boolean(childPaneId);
    });
    await waitForV4Pane((pane) => Boolean(pane.sessionId), "辅助对话未就绪", 30000, childPaneId);
  });

  afterEach(async () => {
    if (childPaneId && !(await $(inputSelector(childPaneId)).isDisplayed())) {
      await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
      await $(inputSelector(childPaneId)).waitForDisplayed();
    }
    for (const paneId of [MAIN_PANE, childPaneId].filter(Boolean)) {
      if ((await getV4PaneSnapshot(paneId)).canStop) {
        await $(`${paneSelector(paneId)} [data-testid="${TID_V4_STOP}"]`).click();
        await waitForV4Pane((pane) => !pane.canStop, "清理运行中的对话失败", 30000, paneId);
      }
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSC36: 收起右侧面板后 Esc 默认停止主对话，隐藏辅助对话继续运行", async function () {
    this.timeout(90000);
    const childMarker = `${RUNNING}_SSC36_CHILD`;
    const mainMarker = `${RUNNING}_SSC36_MAIN`;
    await send(childPaneId, childMarker);
    await send(MAIN_PANE, mainMarker);
    const toggle = $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    await focusOutsidePanes();
    await browser.keys("Escape");
    const beforeOpen = currentTurnText(
      (await getV4PaneSnapshot(MAIN_PANE)).timelineText,
      mainMarker,
    );
    await waitForV4Pane(
      (pane) =>
        pane.canStop &&
        currentTurnText(pane.timelineText, mainMarker).length > beforeOpen.length + 20,
      "面板打开时对话外 Esc 误停主对话",
    );
    expect((await getV4PaneSnapshot(childPaneId)).canStop).toBe(true);

    await toggle.click();
    await $(inputSelector(childPaneId)).waitForDisplayed({ reverse: true });
    await focusOutsidePanes();
    await browser.keys("Escape");
    await waitForV4Pane((pane) => !pane.canStop, "右侧面板关闭后 Esc 未停止主对话", 15000);

    await toggle.click();
    await $(inputSelector(childPaneId)).waitForDisplayed();
    const beforeClosed = currentTurnText(
      (await getV4PaneSnapshot(childPaneId)).timelineText,
      childMarker,
    );
    await waitForV4Pane(
      (pane) =>
        pane.canStop &&
        currentTurnText(pane.timelineText, childMarker).length > beforeClosed.length + 20,
      "隐藏的辅助对话被误停",
      15000,
      childPaneId,
    );
  });

  for (const scenario of [
    { id: "SSC34", stopChild: true },
    { id: "SSC35", stopChild: false },
  ]) {
    it(`${scenario.id}: Esc 只停止键盘焦点所属对话，重复按键不穿透`, async function () {
      this.timeout(90000);
      const target = scenario.stopChild ? childPaneId : MAIN_PANE;
      const other = scenario.stopChild ? MAIN_PANE : childPaneId;
      const otherMarker = `${RUNNING}_${scenario.id}_OTHER`;
      // 先启动非目标对话，确保旧 window 监听器会先抢到 Esc。
      await send(other, otherMarker);
      await send(target, `${RUNNING}_${scenario.id}_TARGET`);
      await focusInput(target);
      await browser.keys("Escape");
      await browser.waitUntil(
        async () =>
          !(await getV4PaneSnapshot(target)).canStop || !(await getV4PaneSnapshot(other)).canStop,
        { timeout: 15000, timeoutMsg: "Esc 未停止任何对话" },
      );
      expect((await getV4PaneSnapshot(target)).canStop).toBe(false);
      expect((await getV4PaneSnapshot(other)).canStop).toBe(true);

      // 焦点仍在已停止的对话；第二次 Esc 不能落到另一运行中的监听器。
      await expect($(inputSelector(target))).toBeFocused();
      await browser.keys("Escape");
      const before = currentTurnText((await getV4PaneSnapshot(other)).timelineText, otherMarker);
      await waitForV4Pane(
        (pane) =>
          pane.canStop &&
          currentTurnText(pane.timelineText, otherMarker).length > before.length + 20,
        "另一对话被误停或不再收到流式正文",
        15000,
        other,
      );

      await focusInput(other);
      await browser.keys("Escape");
      await waitForV4Pane((pane) => !pane.canStop, "切换焦点后 Esc 未停止目标对话", 15000, other);
      expect((await getV4PaneSnapshot(target)).canStop).toBe(false);
    });
  }
});

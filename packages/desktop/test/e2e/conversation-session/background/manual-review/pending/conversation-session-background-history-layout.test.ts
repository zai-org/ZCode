import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
  setV4ElectronWindowSize,
  getV4PaneSnapshot,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

const artifacts = () => process.env.ZCODE_E2E_ARTIFACT_DIR!;
const EMPTY = "E2E_BG_HISTORY_EMPTY";
const HISTORY = "E2E_BG_HISTORY_HISTORY";
const TITLE = '[data-testid^="chat-background-result-title-"]';
const TRIGGER = '[data-testid^="chat-assistant-history-trigger-"]';
const CONTENT = '[data-testid^="chat-assistant-history-content-"]';

async function assertMobileEmptyHistory() {
  const sessionId = (await getV4PaneSnapshot()).sessionId!;
  const pairingUrl = await obtainUnreadPairingUrl(
    new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
  );
  const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
  const mobileBrowser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless: true,
  });
  try {
    const context = await mobileBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: artifacts(),
      caseMarker: "BGH01",
      phase: "empty-history",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    await showMobileTaskHome(page);
    for (const toggle of await page.getByTestId("virtual-project-toggle").all()) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    await page.getByTestId(testId(TID_TASK_ITEM, sessionId)).first().click();
    const title = page.locator(TITLE).filter({ hasText: EMPTY });
    await title.waitFor();
    const turn = title.locator("xpath=ancestor::*[@data-turn-key]");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => {
        const actions = (window as Window & { __testActions?: { setTheme(theme: string): void } })
          .__testActions;
        if (!actions) throw new Error("mobile theme actions missing");
        actions.setTheme(value);
      }, theme);
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      );
      expect(await turn.locator(TRIGGER).count()).toBe(0);
      expect(await turn.locator(CONTENT).count()).toBe(0);
      const before = await turn.boundingBox();
      await turn.getByText(/已工作|Worked/).click();
      expect((await turn.boundingBox())!.height).toBe(before!.height);
      await page.screenshot({ path: join(artifacts(), `background-empty-mobile-${theme}.png`) });
    }
  } finally {
    await mobileBrowser.close();
  }
}

async function launchBackgroundResult(marker: string, gate: string) {
  await startNewV4Draft();
  await ensureToolCrossProductFullAccessMode();
  await sendV4Prompt(marker);
  await waitForV4TimelineContaining(marker + "_ACK");
  await waitForV4Pane((state) => !state.canStop, "父轮未结束");
  await releaseControlledReplay(gate);
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: ["<task-notification>", marker + "_CHILD_RESULT"] },
    "非空子代理结果未进入父模型请求",
    60_000,
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, title) =>
          [...document.querySelectorAll(selector)].some((node) => node.textContent === title),
        TITLE,
        marker,
      ),
    { timeout: 60_000, timeoutMsg: "后台结果标题未出现" },
  );
  await waitForV4Pane((state) => !state.canStop, "后台唤醒轮未结束");
  const requests = await getUpstreamRequestEvidence({
    lastUserMessageIncludes: ["<task-notification>", marker + "_CHILD_RESULT"],
  });
  expect(requests.map((request) => request.fixtureId)).toEqual([
    marker === EMPTY ? "bg-history-empty-empty" : "bg-history-history-tool",
  ]);
}

async function assertEmptyHistory(marker: string) {
  const result = (await browser.executeAsync(
    (selectors, title, done) => {
      const node = [...document.querySelectorAll<HTMLElement>(selectors.title)].find(
        (item) => item.textContent === title,
      )!;
      const turn = node.closest<HTMLElement>("[data-turn-key]")!;
      const shell = node.closest<HTMLElement>('[data-slot="collapsible"]')!;
      const status = shell.firstElementChild as HTMLElement;
      const viewport = turn.closest<HTMLElement>('[data-testid="v4-timeline"]')!;
      const before = { height: turn.getBoundingClientRect().height, top: viewport.scrollTop };
      status.click();
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          done({
            triggerCount: turn.querySelectorAll(selectors.trigger).length,
            contentCount: turn.querySelectorAll(selectors.content).length,
            statusButtons: status.querySelectorAll("button, [role=button], svg").length,
            status: status.textContent,
            rawResultVisible: turn.innerText.includes(title + "_CHILD_RESULT"),
            heightDelta: turn.getBoundingClientRect().height - before.height,
            scrollDelta: viewport.scrollTop - before.top,
          }),
        ),
      );
    },
    { title: TITLE, trigger: TRIGGER, content: CONTENT },
    marker,
  )) as {
    status: string;
    triggerCount: number;
    contentCount: number;
    statusButtons: number;
    rawResultVisible: boolean;
    heightDelta: number;
    scrollDelta: number;
  };
  expect(result).toMatchObject({
    triggerCount: 0,
    contentCount: 0,
    statusButtons: 0,
    rawResultVisible: false,
    heightDelta: 0,
    scrollDelta: 0,
  });
  expect(result.status).toMatch(/已工作|Worked/);
}

interface Sample {
  height: number;
  contentHeight: number;
  hidden: boolean;
  elapsed: number;
}

async function toggleHistory(open: boolean) {
  const result = (await browser.executeAsync(
    (selectors, shouldOpen, done) => {
      const node = [...document.querySelectorAll<HTMLElement>(selectors.title)].find(
        (item) => item.textContent === "E2E_BG_HISTORY_HISTORY",
      )!;
      const shell = node.closest<HTMLElement>('[data-slot="collapsible"]')!;
      const trigger = shell.querySelector<HTMLElement>(selectors.trigger)!;
      const content = shell.querySelector<HTMLElement>(selectors.content)!;
      const started = performance.now();
      const samples: Sample[] = [];
      const sample = () => ({
        height: shell.getBoundingClientRect().height,
        contentHeight: content.getBoundingClientRect().height,
        hidden: getComputedStyle(content).display === "none",
        elapsed: performance.now() - started,
      });
      samples.push(sample());
      trigger.click();
      let stable = 0;
      const tick = () => {
        const current = sample();
        samples.push(current);
        const animating = shell
          .getAnimations({ subtree: true })
          .some(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getComputedTiming().iterations !== Infinity,
          );
        const settled =
          trigger.getAttribute("aria-expanded") === String(shouldOpen) &&
          current.hidden !== shouldOpen &&
          !animating;
        stable = settled ? stable + 1 : 0;
        if (stable >= 3 || current.elapsed > 2000) {
          done({
            samples,
            settled,
            finalVisible: shell.innerText.includes("E2E_BG_HISTORY_HISTORY_FINAL"),
          });
        } else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { title: TITLE, trigger: TRIGGER, content: CONTENT },
    open,
  )) as { samples: Sample[]; settled: boolean; finalVisible: boolean };
  expect(result.settled).toBe(true);
  expect(result.finalVisible).toBe(true);
  // 外层不应在内容 display:none 时额外丢失一个 gap；动画全过程的非内容高度保持一致。
  const baseHeights = result.samples.map((sample) => sample.height - sample.contentHeight);
  expect(Math.max(...baseHeights) - Math.min(...baseHeights)).toBeLessThanOrEqual(2);
  await writeFile(
    join(artifacts(), open ? "background-open.json" : "background-close.json"),
    JSON.stringify(result, null, 2),
  );
}

describe("BGH01 后台结果空历史与折叠高度", () => {
  before(async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("子代理有结果、父回复为空：状态没有箭头和空折叠区，窄屏与主题切换保持稳定", async function () {
    this.timeout(180_000);
    await launchBackgroundResult(EMPTY, "bg-history-empty-child");
    for (const [width, theme] of [
      [1280, "dark"],
      [480, "light"],
    ] as const) {
      await setV4ElectronWindowSize(width, 800);
      await browser.execute((value) => {
        (
          window as Window & { __testActions?: { setTheme(theme: string): void } }
        ).__testActions?.setTheme(value);
      }, theme);
      await browser.waitUntil(() =>
        browser.execute(
          (dark) => document.documentElement.classList.contains("dark") === dark,
          theme === "dark",
        ),
      );
      await assertEmptyHistory(EMPTY);
      await browser.saveScreenshot(join(artifacts(), `background-empty-${width}-${theme}.png`));
    }
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    await browser.refresh();
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining(EMPTY);
    await assertEmptyHistory(EMPTY);
    await setV4ElectronWindowSize(1280, 800);
    await assertMobileEmptyHistory();
  });

  it("有历史：展开收起保留正文，最后一帧无额外间距跳变", async function () {
    this.timeout(180_000);
    await launchBackgroundResult(HISTORY, "bg-history-history-child");
    await waitForV4TimelineContaining(HISTORY + "_FINAL");
    await toggleHistory(true);
    await toggleHistory(false);
    await browser.saveScreenshot(join(artifacts(), "background-content-closed.png"));
  });
});

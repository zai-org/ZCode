import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_TASK_ITEM,
  TID_TASK_NEW_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  getV4ConversationState,
  selectV4TaskById,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/composer-width");
let completedTaskId: string;

const WIDE_VIEWPORT = { width: 1800, height: 1000 };
const NARROW_VIEWPORT = { width: 1200, height: 900 };
const DRAFT_WIDTH_CLASS = "max-w-2xl";
const NORMAL_WIDTH_CLASS =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
const INLINE_WIDTH_CLASS = NORMAL_WIDTH_CLASS;
const INLINE_OFFSET_CLASS = "@min-[1280px]/conversation:-translate-x-42";

describe("会话区 status panel inline layout E2E", () => {
  after(async () => {
    await clearRendererViewport();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("status panel 只有出现 inline 偏移时才收敛消息列和输入区宽度", async function () {
    this.timeout(180000);

    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await prepareV4ConversationE2E();
    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);

    const draftLayout = await waitForChatLayoutSnapshot(
      (snapshot) =>
        snapshot.panelState === null &&
        snapshot.dockClassName.includes(DRAFT_WIDTH_CLASS) &&
        !snapshot.dockClassName.includes(INLINE_OFFSET_CLASS),
      "新建草稿没有保持无 status panel 的窄 composer 布局",
    );
    expect(draftLayout.panelState).toBeNull();

    const runId = Date.now();
    const plainPrompt = `E2E_STATUS_PANEL_EMPTY_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(plainPrompt);
    await waitForV4ComposerText("", "普通首发后输入框没有清空");
    await waitForV4UserMessageContaining(plainPrompt);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "普通首发完成后没有回到 idle",
      90000,
    );
    const noPanelLayout = await waitForChatLayoutSnapshot(
      (snapshot) =>
        snapshot.panelState === null &&
        snapshot.contentClassName?.includes(NORMAL_WIDTH_CLASS) === true &&
        snapshot.dockClassName.includes(NORMAL_WIDTH_CLASS) &&
        !snapshot.hasContentInlineOffset &&
        !snapshot.hasDockInlineOffset,
      "无 status 内容的历史 task 没有保持普通消息列宽度",
    );
    expect(noPanelLayout.panelState).toBeNull();

    const taskId = (await getV4ConversationState()).taskId;
    if (!taskId) throw new Error("completed task missing");
    completedTaskId = taskId;
    await mkdir(artifactDir, { recursive: true });
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await browser.execute((value) => {
        const actions = (window as Window & { __testActions?: { setTheme(theme: string): void } })
          .__testActions;
        if (!actions) throw new Error("theme actions missing");
        actions.setTheme(value);
      }, theme);
      for (const viewport of [NARROW_VIEWPORT, WIDE_VIEWPORT]) {
        await setRendererViewport(viewport.width, viewport.height);
        await startNewV4Draft();
        await startLayoutTrace();
        await selectV4TaskById(completedTaskId);
        const trace = await finishLayoutTrace();
        const name = `composer-${theme}-${viewport.width}`;
        await writeFile(join(artifactDir, `${name}.json`), JSON.stringify(trace, null, 2));
        await browser.saveScreenshot(join(artifactDir, `${name}.png`));
        expect(trace.transitions).toEqual([]);
        const conversationFrames = trace.widths.filter((frame) => frame.content !== null);
        expect(conversationFrames.length).toBeGreaterThan(0);
        expect(
          conversationFrames.every((frame) => Math.abs(frame.dock - frame.content!) <= 1),
        ).toBe(true);
        const layout = await getChatLayoutSnapshot();
        expect(layout.dockTransitionDuration).toBe("0s");
        expect(layout.contentTransitionDuration).toBe("0s");
        expect(Math.abs(layout.bottomGap - 16)).toBeLessThanOrEqual(1);
        expect(layout.dockBottomPadding).toBe("0px");
        expect(layout.messageMask).toBe("none");
      }
    }

    // 首帧断言必须在新建点击前注册，不能复用等到草稿就绪后才返回的 helper。
    await setRendererViewport(1400, 900);
    const draftFrames = await browser.executeAsync(
      (
        newTaskTestId,
        done: (frames: Array<{ x: number; error: number; animations: number }>) => void,
      ) => {
        const frames: Array<{ x: number; error: number; animations: number }> = [];
        const capture = () => {
          const pane = document.querySelector('[data-session-id="draft"]');
          const dock = pane?.querySelector<HTMLElement>("[data-v4-composer-dock-content]");
          const composer = dock?.querySelector<HTMLElement>('[data-testid="v4-composer"]');
          if (!dock || !composer) return;
          const outer = dock.parentElement!.getBoundingClientRect();
          const input = composer.getBoundingClientRect();
          frames.push({
            x: input.x,
            error: input.x + input.width / 2 - outer.x - outer.width / 2,
            animations: dock.getAnimations().length,
          });
          if (frames.length < 18) requestAnimationFrame(capture);
          else done(frames);
        };
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-session-id="draft"] [data-testid="v4-composer"]'))
            return;
          observer.disconnect();
          capture();
        });
        observer.observe(document.body, { subtree: true, attributes: true, childList: true });
        document.querySelector<HTMLElement>(`[data-testid="${newTaskTestId}"]`)!.click();
      },
      TID_TASK_NEW_BUTTON,
    );
    expect(draftFrames).toHaveLength(18);
    for (const frame of draftFrames) {
      expect(Math.abs(frame.error)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.x - draftFrames[0]!.x)).toBeLessThanOrEqual(1);
      expect(frame.animations).toBe(0);
    }
    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    const goalMarker = `E2E_STATUS_PANEL_GOAL_${runId}`;
    const goalPrompt = `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(goalPrompt);
    await waitForV4ComposerText("", "goal 首发后输入框没有清空");
    await waitForV4UserMessageContaining(goalMarker);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.targetObjective?.includes(goalMarker) === true && Boolean(snapshot.taskId),
      "goal 首发没有形成 status panel 可展示的 target",
      60000,
    );

    await expectInlinePanelLayout("宽屏自动展开 status panel 后没有同步收敛聊天宽度");

    await setRendererViewport(NARROW_VIEWPORT.width, NARROW_VIEWPORT.height);
    await expectMiniPanelLayout("窄屏自动收起 status panel 后没有恢复普通聊天宽度");

    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await expectInlinePanelLayout("重新放大后自动展开 status panel 没有恢复 inline 布局");

    await clickSummaryPanelButton(["Collapse to capsule", "收起为胶囊"]);
    await expectMiniPanelLayout("手动收起 status panel 后没有移除 inline 偏移");

    await clickSummaryPanelButton(["Expand status", "展开状态"]);
    await expectInlinePanelLayout("手动展开 status panel 后没有恢复 inline 偏移");
  });

  it("手机 Web 打开历史对话和刷新时输入区无布局过渡，深浅主题均不溢出", async function () {
    this.timeout(180000);
    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint || !completedTaskId) throw new Error("mobile fixture or completed task missing");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: "SP07",
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      for (const theme of ["zai-light", "zai-dark"] as const) {
        await page.evaluate((value) => {
          const actions = (window as Window & { __testActions?: { setTheme(theme: string): void } })
            .__testActions;
          if (!actions) throw new Error("mobile theme actions missing");
          actions.setTheme(value);
        }, theme);
        await showMobileTaskHome(page);
        const toggles = page.getByTestId("virtual-project-toggle");
        for (let index = 0; index < (await toggles.count()); index++) {
          const toggle = toggles.nth(index);
          if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        }
        await page.getByTestId(testId(TID_TASK_ITEM, completedTaskId)).first().click();
        for (const phase of ["open", "reload"]) {
          if (phase === "reload") await page.reload();
          await page
            .locator(`[data-session-id="${completedTaskId}"]`)
            .getByText(E2E_REPLY_TOKEN, { exact: false })
            .first()
            .waitFor();
          const geometry = await page
            .locator("[data-v4-composer-dock-content]")
            .evaluate((dock) => {
              const rect = dock.getBoundingClientRect();
              const scroll = dock.closest<HTMLElement>('[data-v4-timeline-scroll="true"]')!;
              const message = scroll.querySelector<HTMLElement>(
                "[data-v4-timeline-message-layer]",
              )!;
              return {
                left: rect.left,
                right: rect.right,
                viewport: innerWidth,
                duration: getComputedStyle(dock).transitionDuration,
                translate: getComputedStyle(dock).translate,
                bottomGap:
                  scroll.parentElement!.getBoundingClientRect().bottom -
                  scroll.getBoundingClientRect().bottom,
                dockBottomPadding: getComputedStyle(dock).paddingBottom,
                messageMask: getComputedStyle(message).maskImage,
              };
            });
          expect(geometry.duration).toBe("0s");
          expect(geometry.left).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
          expect(["none", "0px"]).toContain(geometry.translate);
          expect(Math.abs(geometry.bottomGap - 16)).toBeLessThanOrEqual(1);
          expect(geometry.dockBottomPadding).toBe("0px");
          expect(geometry.messageMask).toBe("none");
          await page.screenshot({
            path: join(artifactDir, `composer-mobile-${theme}-${phase}.png`),
          });
        }
      }
    } finally {
      await chrome.close();
    }
  });
});

async function expectInlinePanelLayout(timeoutMsg: string) {
  const snapshot = await waitForChatLayoutSnapshot(
    (current) =>
      current.panelState === "expanded" &&
      current.contentClassName?.includes(INLINE_WIDTH_CLASS) === true &&
      current.dockClassName.includes(INLINE_WIDTH_CLASS) &&
      current.hasContentInlineOffset &&
      current.hasDockInlineOffset &&
      current.contentTransitionDuration === "0s" &&
      current.dockTransitionDuration === "0s",
    timeoutMsg,
  );
  expect(snapshot.panelState).toBe("expanded");
}

async function expectMiniPanelLayout(timeoutMsg: string) {
  const snapshot = await waitForChatLayoutSnapshot(
    (current) =>
      current.panelState === "collapsed" &&
      current.contentClassName?.includes(NORMAL_WIDTH_CLASS) === true &&
      current.dockClassName.includes(NORMAL_WIDTH_CLASS) &&
      !current.hasContentInlineOffset &&
      !current.hasDockInlineOffset &&
      current.contentTransitionDuration === "0s" &&
      current.dockTransitionDuration === "0s",
    timeoutMsg,
  );
  expect(snapshot.panelState).toBe("collapsed");
}

async function waitForChatLayoutSnapshot(
  predicate: (snapshot: ChatLayoutSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: ChatLayoutSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getChatLayoutSnapshot();
        return predicate(latest);
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    latest = await getChatLayoutSnapshot().catch(() => latest);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }

  return getChatLayoutSnapshot();
}

interface ChatLayoutSnapshot {
  containerWidth: number;
  contentClassName: string | null;
  contentTransitionProperty: string;
  contentTransitionDuration: string;
  dockClassName: string;
  dockTransitionProperty: string;
  dockTransitionDuration: string;
  hasContentInlineOffset: boolean;
  hasDockInlineOffset: boolean;
  panelState: string | null;
  bottomGap: number;
  dockBottomPadding: string;
  messageMask: string;
}

function getChatLayoutSnapshot(): Promise<ChatLayoutSnapshot> {
  return browser.execute((summaryPanelTestId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${summaryPanelTestId}"]`);
    // V4 的内容列和 dock 都有专用锚点；旧 chat-message 容器已不存在。
    const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
    const dock = pane?.querySelector<HTMLElement>("[data-v4-composer-dock-content]") ?? null;
    const content = pane?.querySelector<HTMLElement>("[data-v4-timeline-virtual-history]") ?? null;
    const container = pane?.querySelector<HTMLElement>('[class*="@container/conversation"]');
    const fullPanelButton = panel?.querySelector<HTMLElement>(
      'button[aria-label="Collapse to capsule"], button[aria-label="收起为胶囊"]',
    );
    const contentStyle = content ? window.getComputedStyle(content) : null;
    const dockStyle = dock ? window.getComputedStyle(dock) : null;
    const scroll = dock?.closest<HTMLElement>('[data-v4-timeline-scroll="true"]');
    const message = scroll?.querySelector<HTMLElement>("[data-v4-timeline-message-layer]");

    return {
      containerWidth: container?.getBoundingClientRect().width ?? 0,
      contentClassName: content?.className ?? null,
      contentTransitionProperty: contentStyle?.transitionProperty ?? "",
      contentTransitionDuration: contentStyle?.transitionDuration ?? "",
      dockClassName: dock?.className ?? "",
      dockTransitionProperty: dockStyle?.transitionProperty ?? "",
      dockTransitionDuration: dockStyle?.transitionDuration ?? "",
      bottomGap: scroll
        ? scroll.parentElement!.getBoundingClientRect().bottom -
          scroll.getBoundingClientRect().bottom
        : 0,
      dockBottomPadding: dockStyle?.paddingBottom ?? "",
      messageMask: message ? getComputedStyle(message).maskImage : "none",
      hasContentInlineOffset: Math.abs(Number.parseFloat(contentStyle?.translate ?? "0") + 168) < 1,
      hasDockInlineOffset: Math.abs(Number.parseFloat(dockStyle?.translate ?? "0") + 168) < 1,
      panelState: panel
        ? fullPanelButton && fullPanelButton.getBoundingClientRect().width > 0
          ? "expanded"
          : "collapsed"
        : null,
    };
  }, TID_CHAT_SUMMARY_PANEL);
}

async function clickSummaryPanelButton(labels: readonly string[]) {
  const clicked = await browser.execute(
    (summaryPanelTestId, candidateLabels) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${summaryPanelTestId}"]`);
      const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const button = buttons.find((item) =>
        candidateLabels.includes(item.getAttribute("aria-label") ?? ""),
      );
      button?.click();
      return Boolean(button);
    },
    TID_CHAT_SUMMARY_PANEL,
    labels,
  );

  if (!clicked) {
    throw new Error(`没有找到 status panel 按钮: ${labels.join(" / ")}`);
  }
}

interface LayoutTrace {
  transitions: { property: string; target: string }[];
  widths: { time: number; dock: number; content: number | null }[];
}

type LayoutTraceWindow = Window & { __finishComposerLayoutTrace?: () => LayoutTrace };

async function startLayoutTrace() {
  await browser.execute(() => {
    const trace: LayoutTrace = { transitions: [], widths: [] };
    const selector = "[data-v4-composer-dock-content], [data-v4-timeline-content-column]";
    const started = performance.now();
    let frame = 0;
    const sample = () => {
      const dock = document.querySelector<HTMLElement>("[data-v4-composer-dock-content]");
      const content = document.querySelector<HTMLElement>("[data-v4-timeline-virtual-history]");
      if (dock) {
        const width = dock.getBoundingClientRect().width;
        const contentWidth = content?.getBoundingClientRect().width ?? null;
        const previous = trace.widths.at(-1);
        if (previous?.dock !== width || previous?.content !== contentWidth)
          trace.widths.push({
            time: performance.now() - started,
            dock: width,
            content: contentWidth,
          });
      }
      frame = requestAnimationFrame(sample);
    };
    const onTransition = (event: TransitionEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches(selector))
        trace.transitions.push({ property: event.propertyName, target: event.target.className });
    };
    document.addEventListener("transitionrun", onTransition, true);
    sample();
    (window as LayoutTraceWindow).__finishComposerLayoutTrace = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("transitionrun", onTransition, true);
      delete (window as LayoutTraceWindow).__finishComposerLayoutTrace;
      return trace;
    };
  });
}

async function finishLayoutTrace(): Promise<LayoutTrace> {
  return browser.execute(async () => {
    // 采样窗口覆盖原有 150ms 过渡，不用固定暂停掩盖产品布局变化。
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const sample = () =>
        performance.now() - start >= 300 ? resolve() : requestAnimationFrame(sample);
      requestAnimationFrame(sample);
    });
    const finish = (window as LayoutTraceWindow).__finishComposerLayoutTrace;
    if (!finish) throw new Error("layout trace missing");
    return finish();
  });
}

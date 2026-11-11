import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

interface ChatLoadingLayoutSample {
  backToBottomVisible: boolean;
  bottomGap: number;
  clientHeight: number;
  dockTop: number | null;
  following: boolean;
  hasLiveTail: boolean;
  historyOpen: boolean | null;
  liveHeight: number | null;
  loadingTop: number | null;
  loadingVisible: boolean;
  loadingAligned: boolean;
  workingHistoryVisible: boolean;
  scrollHeight: number;
  scrollTop: number;
  slotTop: number | null;
  time: number;
}

interface ChatLoadingLayoutProbe {
  animationFrameId: number | null;
  liveTailObserver: ResizeObserver | null;
  mutationObserver: MutationObserver | null;
  resizeAnimationFrameIds: number[];
  resizeSamples: ChatLoadingLayoutSample[];
  running: boolean;
  samples: ChatLoadingLayoutSample[];
}

interface ChatLoadingLayoutProbeResult {
  resizeSamples: ChatLoadingLayoutSample[];
  samples: ChatLoadingLayoutSample[];
}

interface AssistantHistoryToggleSample {
  backToBottomVisible: boolean;
  bottomGap: number;
  contentDisplay: string;
  contentHeight: number;
  contentHidden: boolean;
  following: boolean;
  historyOpen: boolean;
  nextTop: number | null;
  scrollTop: number;
  time: number;
  triggerTop: number;
}

interface AssistantHistoryToggleProbe {
  error?: string;
  samples: AssistantHistoryToggleSample[];
  targetOpen: boolean;
}

declare global {
  interface Window {
    __zcodeChatLoadingLayoutProbe?: ChatLoadingLayoutProbe;
  }
}

const LAYOUT_EPSILON_PX = 1.5;
const TOGGLE_POSITION_EPSILON_PX = 2;
const REAL_LINE_GROWTH_PX = 8;

describe("CHL05/CHL07/CHL08/P08 ChatLoading、终态与手动折叠滚动权", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("长正文增长、终态折叠吸底和用户主动离底互不冲突", async function () {
    this.timeout(220000);

    await prepareV4ConversationE2E();
    await installChatLoadingLayoutProbe();
    await sendV4Prompt(
      "E2E_CHAT_LOADING_REAL_LINES FOLLOWING 请输出足够长的完整说明文字，不要只依赖换行数量",
    );

    await waitForV4TimelineContaining("CHAT_LOADING_LINE_36", 45000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "逐段流式回复结束后会话没有回到 idle",
      30000,
    );
    const followingTerminal = await waitForTerminalScrollState("following");

    const followingProbeResult = await stopChatLoadingLayoutProbe();
    const followingReport = analyzeChatLoadingLayout(followingProbeResult);
    // 运行时已有 ChatLoading，旧的过程标题不能同时显示第二份 Working。
    expect(followingProbeResult.samples.some((sample) => sample.workingHistoryVisible)).toBe(false);
    expect(
      followingProbeResult.samples
        .filter((sample) => sample.loadingVisible)
        .every((sample) => sample.loadingAligned),
    ).toBe(true);

    if (
      followingReport.loadingVisibleSamples <= 0 ||
      followingReport.overflowGrowthCount < 8 ||
      followingReport.flickers.length > 0 ||
      followingTerminal.bottomGap > 48 ||
      followingTerminal.following !== true ||
      followingTerminal.historyOpen !== false
    ) {
      throw new Error(
        `CHL05/CHL07 跟随态采样未通过: ${JSON.stringify({ followingReport, followingTerminal })}`,
      );
    }
    await assertAssistantHistoryToggleStability("following");

    await installChatLoadingLayoutProbe();
    await sendV4Prompt(
      "E2E_CHAT_LOADING_REAL_LINES DETACHED 请继续输出足够长的完整说明文字，确保自然换行后仍然超过一屏",
    );
    await waitForLiveTailContaining("CHAT_LOADING_LINE_31");
    const detachedBeforeTerminal = await detachTimelineWithUpwardWheel();
    if (detachedBeforeTerminal.following !== false || detachedBeforeTerminal.bottomGap <= 48) {
      throw new Error(`CHL08 用户上滚没有先进入离底态: ${JSON.stringify(detachedBeforeTerminal)}`);
    }

    await waitForV4TimelineContaining("CHAT_LOADING_LINE_36", 45000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "用户离底后的流式回复结束后会话没有回到 idle",
      30000,
    );
    const detachedTerminal = await waitForTerminalScrollState("detached");
    const detachedProbeResult = await stopChatLoadingLayoutProbe();
    const detachedReport = analyzeTerminalScrollOwnership(detachedProbeResult);

    if (
      detachedTerminal.following !== false ||
      detachedTerminal.bottomGap <= 48 ||
      detachedTerminal.historyOpen !== false ||
      detachedReport.terminalDetachedSamples <= 0 ||
      detachedReport.forcedFollowingSamples.length > 0
    ) {
      throw new Error(
        `CHL08 离底终态采样未通过: ${JSON.stringify({ detachedReport, detachedTerminal })}`,
      );
    }
    await positionLatestHistoryTriggerForDetachedToggle();
    await assertAssistantHistoryToggleStability("detached");
  });
});

interface TimelineScrollState {
  backToBottomVisible: boolean;
  bottomGap: number;
  following: boolean;
  hasLiveTail: boolean;
  historyOpen: boolean | null;
  historyCollapsed: boolean;
  scrollHeight: number;
  scrollTop: number;
}

async function readTimelineScrollState(): Promise<TimelineScrollState | null> {
  return browser.execute(() => {
    const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
    if (!timeline) return null;
    const historyStateElements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-history-open]"),
    );
    const historyState = historyStateElements.at(-1)?.dataset.historyOpen;
    const historyContent = historyStateElements
      .at(-1)
      ?.closest('[data-slot="collapsible"]')
      ?.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
    return {
      backToBottomVisible: Boolean(document.querySelector('[data-testid="v4-timeline-bottom"]')),
      bottomGap: Math.max(0, timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop),
      following: timeline.dataset.following === "true",
      hasLiveTail: Boolean(document.querySelector('[data-v4-running-live-tail="true"]')),
      historyCollapsed: Boolean(
        historyContent &&
        (historyContent.hidden || window.getComputedStyle(historyContent).display === "none"),
      ),
      historyOpen: historyState === "true" ? true : historyState === "false" ? false : null,
      scrollHeight: timeline.scrollHeight,
      scrollTop: timeline.scrollTop,
    };
  });
}

async function waitForLiveTailContaining(marker: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((expectedMarker) => {
        const liveTail = document.querySelector<HTMLElement>('[data-v4-running-live-tail="true"]');
        return liveTail?.textContent?.includes(expectedMarker) === true;
      }, marker),
    {
      timeout: 45000,
      interval: 100,
      timeoutMsg: `running live tail 未出现 marker: ${marker}`,
    },
  );
}

async function waitForTerminalScrollState(
  expected: "following" | "detached",
): Promise<TimelineScrollState> {
  await browser.waitUntil(
    async () => {
      const state = await readTimelineScrollState();
      // 终态保留原组件后，open=false 时收起动画仍可能未结束；先等实际隐藏，
      // 再验收手动展开，避免把收起尾帧与展开首帧误判为单次动画反向。
      if (!state || state.hasLiveTail || state.historyOpen !== false || !state.historyCollapsed)
        return false;
      return expected === "following"
        ? state.following && state.bottomGap <= 48 && !state.backToBottomVisible
        : !state.following && state.bottomGap > 48 && state.backToBottomVisible;
    },
    {
      timeout: 15000,
      interval: 100,
      timeoutMsg: `terminal ${expected} 滚动状态未稳定`,
    },
  );
  const state = await readTimelineScrollState();
  if (!state) throw new Error("terminal 稳定后无法读取 timeline");
  return state;
}

async function detachTimelineWithUpwardWheel(): Promise<TimelineScrollState> {
  await browser.execute(() => {
    const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
    if (!timeline) throw new Error("找不到 v4 timeline");
    // 先触发真实 wheel capture 语义，再改变浏览器滚动位置；这能覆盖 scroll 事件
    // 尚未派发、terminal commit 已经到达的用户意图竞态。
    timeline.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -600,
      }),
    );
    timeline.scrollTop = Math.max(0, timeline.scrollTop - 600);
    timeline.dispatchEvent(new Event("scroll"));
  });
  await browser.waitUntil(
    async () => {
      const state = await readTimelineScrollState();
      return Boolean(state && !state.following && state.bottomGap > 48);
    },
    {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "向上 wheel 后 timeline 没有进入 detached",
    },
  );
  const state = await readTimelineScrollState();
  if (!state) throw new Error("向上 wheel 后无法读取 timeline");
  return state;
}

async function positionLatestHistoryTriggerForDetachedToggle(): Promise<void> {
  const positioned = await browser.execute(() => {
    const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
    const trigger = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="chat-assistant-history-trigger-"]'),
    ).at(-1);
    if (!timeline || !trigger) return false;

    const timelineRect = timeline.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const targetTop = timelineRect.top + Math.min(120, timeline.clientHeight / 4);
    const nextScrollTop = Math.max(0, timeline.scrollTop + triggerRect.top - targetTop);
    timeline.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: nextScrollTop - timeline.scrollTop,
      }),
    );
    timeline.scrollTop = nextScrollTop;
    timeline.dispatchEvent(new Event("scroll"));
    return true;
  });
  if (!positioned) {
    throw new Error("P08 无法把最新“已工作”触发器定位到 detached 视口");
  }

  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
        const trigger = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid^="chat-assistant-history-trigger-"]',
          ),
        ).at(-1);
        if (!timeline || !trigger || timeline.dataset.following !== "false") {
          return false;
        }
        const timelineRect = timeline.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        return triggerRect.top >= timelineRect.top && triggerRect.bottom <= timelineRect.bottom;
      }),
    {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "P08 detached 触发器没有稳定进入可见视口",
    },
  );
}

async function assertAssistantHistoryToggleStability(
  ownership: "following" | "detached",
): Promise<void> {
  const opening = await probeLatestAssistantHistoryToggle(true);
  assertAssistantHistoryToggleProbe(opening, ownership);
  const closing = await probeLatestAssistantHistoryToggle(false);
  assertAssistantHistoryToggleProbe(closing, ownership);
}

function probeLatestAssistantHistoryToggle(
  targetOpen: boolean,
): Promise<AssistantHistoryToggleProbe> {
  return browser.executeAsync((shouldOpen, done) => {
    const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
    const trigger = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="chat-assistant-history-trigger-"]'),
    ).at(-1);
    const collapsible = trigger?.closest<HTMLElement>('[data-slot="collapsible"]');
    const content = collapsible?.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
    const next = content?.nextElementSibling as HTMLElement | null;
    if (!timeline || !trigger || !content || !next) {
      done({
        error: "toggle-elements-missing",
        samples: [],
        targetOpen: shouldOpen,
      });
      return;
    }

    const samples: AssistantHistoryToggleSample[] = [];
    const readSample = (): AssistantHistoryToggleSample => {
      const contentStyle = window.getComputedStyle(content);
      return {
        backToBottomVisible: Boolean(document.querySelector('[data-testid="v4-timeline-bottom"]')),
        bottomGap: Math.max(0, timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop),
        contentDisplay: contentStyle.display,
        contentHeight: content.getBoundingClientRect().height,
        contentHidden: content.hasAttribute("hidden"),
        following: timeline.dataset.following === "true",
        historyOpen: trigger.dataset.historyOpen === "true",
        nextTop: next.getBoundingClientRect().top,
        scrollTop: timeline.scrollTop,
        time: performance.now(),
        triggerTop: trigger.getBoundingClientRect().top,
      };
    };

    samples.push(readSample());
    if ((trigger.dataset.historyOpen === "true") === shouldOpen) {
      done({
        error: "toggle-already-at-target",
        samples,
        targetOpen: shouldOpen,
      });
      return;
    }

    trigger.click();
    const startedAt = performance.now();
    const sampleAnimation = () => {
      const current = readSample();
      samples.push(current);
      const elapsed = performance.now() - startedAt;
      const settled = shouldOpen
        ? current.historyOpen &&
          !current.contentHidden &&
          current.contentDisplay !== "none" &&
          current.contentHeight > 0
        : !current.historyOpen && (current.contentHidden || current.contentDisplay === "none");
      if (elapsed >= 450 && settled) {
        done({ samples, targetOpen: shouldOpen });
        return;
      }
      if (elapsed >= 1200) {
        done({
          error: "toggle-animation-not-settled",
          samples,
          targetOpen: shouldOpen,
        });
        return;
      }
      requestAnimationFrame(sampleAnimation);
    };
    requestAnimationFrame(sampleAnimation);
  }, targetOpen) as Promise<AssistantHistoryToggleProbe>;
}

function assertAssistantHistoryToggleProbe(
  probe: AssistantHistoryToggleProbe,
  ownership: "following" | "detached",
): void {
  if (probe.error || probe.samples.length < 10) {
    throw new Error(`P08 折叠采样不完整: ${JSON.stringify({ ownership, probe })}`);
  }
  const samples = probe.samples;
  const finalSample = samples.at(-1)!;
  if (finalSample.historyOpen !== probe.targetOpen) {
    throw new Error(`P08 折叠终态不正确: ${JSON.stringify({ ownership, probe })}`);
  }

  assertMonotonicToggleValues(
    samples.map((sample) => sample.contentHeight),
    probe.targetOpen ? "increasing" : "decreasing",
    "contentHeight",
    ownership,
  );

  const nextContentTops = samples.flatMap((sample) =>
    sample.nextTop === null ? [] : [sample.nextTop + sample.scrollTop],
  );
  assertMonotonicToggleValues(
    nextContentTops,
    probe.targetOpen ? "increasing" : "decreasing",
    "nextContentTop",
    ownership,
  );
  if (ownership === "following") {
    const invalidOwnership = samples.filter(
      (sample) => !sample.following || sample.bottomGap > 48 || sample.backToBottomVisible,
    );
    if (invalidOwnership.length > 0) {
      throw new Error(
        `P08 跟随态手动折叠发生滚动竞争: ${JSON.stringify({ invalidOwnership, probe })}`,
      );
    }
  } else {
    const invalidOwnership = samples.filter(
      (sample) => sample.following || sample.bottomGap <= 48 || !sample.backToBottomVisible,
    );
    const scrollTopRange =
      Math.max(...samples.map((sample) => sample.scrollTop)) -
      Math.min(...samples.map((sample) => sample.scrollTop));
    const triggerTopRange =
      Math.max(...samples.map((sample) => sample.triggerTop)) -
      Math.min(...samples.map((sample) => sample.triggerTop));
    if (
      invalidOwnership.length > 0 ||
      scrollTopRange > TOGGLE_POSITION_EPSILON_PX ||
      triggerTopRange > TOGGLE_POSITION_EPSILON_PX
    ) {
      throw new Error(
        `P08 离底态手动折叠改变了阅读位置: ${JSON.stringify({ invalidOwnership, scrollTopRange, triggerTopRange, probe })}`,
      );
    }
  }

  if (!probe.targetOpen) {
    const firstHiddenIndex = samples.findIndex(
      (sample) => sample.contentHidden || sample.contentDisplay === "none",
    );
    const lastVisible = firstHiddenIndex <= 0 ? undefined : samples[firstHiddenIndex - 1];
    const firstHidden = firstHiddenIndex < 0 ? undefined : samples[firstHiddenIndex];
    const finalGapJump =
      lastVisible?.nextTop === null ||
      lastVisible?.nextTop === undefined ||
      firstHidden?.nextTop === null ||
      firstHidden?.nextTop === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(firstHidden.nextTop - lastVisible.nextTop);
    if (finalGapJump > TOGGLE_POSITION_EPSILON_PX) {
      throw new Error(
        `P08 收起隐藏前后仍有尾部间距跳变: ${JSON.stringify({ finalGapJump, ownership, probe })}`,
      );
    }
  }
}

function assertMonotonicToggleValues(
  values: readonly number[],
  direction: "increasing" | "decreasing",
  label: string,
  ownership: "following" | "detached",
): void {
  const reversals = values.flatMap((value, index) => {
    const previous = values[index - 1];
    if (previous === undefined) return [];
    const reversed =
      direction === "increasing"
        ? value + LAYOUT_EPSILON_PX < previous
        : value - LAYOUT_EPSILON_PX > previous;
    return reversed ? [{ index, previous, value }] : [];
  });
  if (reversals.length > 0) {
    throw new Error(`P08 ${ownership} ${label} 动画方向反转: ${JSON.stringify(reversals)}`);
  }
}

async function installChatLoadingLayoutProbe() {
  await browser.execute(() => {
    const existing = window.__zcodeChatLoadingLayoutProbe;
    if (existing?.animationFrameId !== null && existing?.animationFrameId !== undefined) {
      window.cancelAnimationFrame(existing.animationFrameId);
    }

    const probe: ChatLoadingLayoutProbe = {
      animationFrameId: null,
      liveTailObserver: null,
      mutationObserver: null,
      resizeAnimationFrameIds: [],
      resizeSamples: [],
      running: true,
      samples: [],
    };
    window.__zcodeChatLoadingLayoutProbe = probe;

    const readSample = (): ChatLoadingLayoutSample | null => {
      const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
      if (!timeline) return null;
      const liveTail = document.querySelector<HTMLElement>('[data-v4-running-live-tail="true"]');
      const slot = document.querySelector<HTMLElement>('[data-zcode-chat-loading-slot="true"]');
      const loading = document.querySelector<HTMLElement>('[data-testid="chat-loading"]');
      const dock = document.querySelector<HTMLElement>('[data-v4-composer-dock="true"]');
      const historyStateElements = Array.from(
        document.querySelectorAll<HTMLElement>("[data-history-open]"),
      );
      const historyState = historyStateElements.at(-1)?.dataset.historyOpen;
      const liveRect = liveTail?.getBoundingClientRect();
      const slotRect = slot?.getBoundingClientRect();
      const loadingRect = loading?.getBoundingClientRect();
      const iconRect = loading?.querySelector("[data-chat-loading-icon]")?.getBoundingClientRect();
      // Loading 已改为 SVG 球体，旧点阵类名已删除；继续验证图标居中和文字间距。
      const glyphRect = loading
        ?.querySelector("[data-chat-loading-icon] svg")
        ?.getBoundingClientRect();
      const labelRect = loading
        ?.querySelector("[data-chat-loading-icon] + span")
        ?.getBoundingClientRect();
      const dockRect = dock?.getBoundingClientRect();
      const bottomGap = Math.max(
        0,
        timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
      );
      return {
        backToBottomVisible: Boolean(document.querySelector('[data-testid="v4-timeline-bottom"]')),
        bottomGap,
        clientHeight: timeline.clientHeight,
        dockTop: dockRect?.top ?? null,
        following: timeline.dataset.following === "true",
        hasLiveTail: liveTail !== null,
        historyOpen: historyState === "true" ? true : historyState === "false" ? false : null,
        liveHeight: liveRect?.height ?? null,
        loadingTop: loadingRect?.top ?? null,
        loadingVisible: Boolean(
          loading &&
          loadingRect &&
          loadingRect.width > 0 &&
          loadingRect.height > 0 &&
          window.getComputedStyle(loading).display !== "none" &&
          window.getComputedStyle(loading).visibility !== "hidden",
        ),
        workingHistoryVisible: Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid^="chat-assistant-history-trigger-"]',
          ),
        ).some((trigger) => {
          const rect = trigger.getBoundingClientRect();
          return (
            /^(Working|工作中)/u.test(trigger.innerText.trim()) && rect.width > 0 && rect.height > 0
          );
        }),
        loadingAligned: Boolean(
          iconRect &&
          glyphRect &&
          labelRect &&
          loadingRect &&
          iconRect.width === 16 &&
          iconRect.height === 16 &&
          Math.abs(labelRect.left - iconRect.right - 8) < 0.1 &&
          Math.abs(labelRect.left - loadingRect.left - 24) < 0.1 &&
          Math.abs(glyphRect.left + glyphRect.width / 2 - iconRect.left - 8) < 0.1 &&
          Math.abs(glyphRect.top + glyphRect.height / 2 - iconRect.top - 8) < 0.1,
        ),
        scrollHeight: timeline.scrollHeight,
        scrollTop: timeline.scrollTop,
        slotTop: slotRect?.top ?? null,
        time: performance.now(),
      };
    };

    const sampleAfterPaint = () => {
      if (!probe.running) return;
      probe.animationFrameId = window.requestAnimationFrame(() => {
        const sample = readSample();
        if (sample) probe.samples.push(sample);
        sampleAfterPaint();
      });
    };

    let observedLiveTail: HTMLElement | null = null;
    const attachLiveTailObserver = () => {
      const liveTail = document.querySelector<HTMLElement>('[data-v4-running-live-tail="true"]');
      if (liveTail === observedLiveTail) return;
      probe.liveTailObserver?.disconnect();
      probe.liveTailObserver = null;
      observedLiveTail = liveTail;
      if (!liveTail) return;
      probe.liveTailObserver = new ResizeObserver(() => {
        const animationFrameId = window.requestAnimationFrame(() => {
          probe.resizeAnimationFrameIds = probe.resizeAnimationFrameIds.filter(
            (id) => id !== animationFrameId,
          );
          const sample = readSample();
          if (sample) probe.resizeSamples.push(sample);
        });
        probe.resizeAnimationFrameIds.push(animationFrameId);
      });
      probe.liveTailObserver.observe(liveTail);
    };

    probe.mutationObserver = new MutationObserver(attachLiveTailObserver);
    probe.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    attachLiveTailObserver();
    sampleAfterPaint();
  });
}

async function stopChatLoadingLayoutProbe(): Promise<ChatLoadingLayoutProbeResult> {
  return browser.execute(() => {
    const probe = window.__zcodeChatLoadingLayoutProbe;
    if (!probe) return { resizeSamples: [], samples: [] };
    probe.running = false;
    if (probe.animationFrameId !== null) {
      window.cancelAnimationFrame(probe.animationFrameId);
    }
    probe.liveTailObserver?.disconnect();
    probe.mutationObserver?.disconnect();
    for (const animationFrameId of probe.resizeAnimationFrameIds) {
      window.cancelAnimationFrame(animationFrameId);
    }
    const compactSamples = probe.samples.filter((sample, index, samples) => {
      const previous = samples[index - 1];
      if (!previous) return true;
      return (
        sample.following !== previous.following ||
        sample.hasLiveTail !== previous.hasLiveTail ||
        sample.historyOpen !== previous.historyOpen ||
        sample.backToBottomVisible !== previous.backToBottomVisible ||
        sample.bottomGap !== previous.bottomGap ||
        sample.liveHeight !== previous.liveHeight ||
        sample.loadingVisible !== previous.loadingVisible ||
        sample.scrollHeight !== previous.scrollHeight ||
        sample.scrollTop !== previous.scrollTop ||
        sample.slotTop !== previous.slotTop
      );
    });
    return { resizeSamples: probe.resizeSamples, samples: compactSamples };
  });
}

function analyzeChatLoadingLayout({ resizeSamples, samples }: ChatLoadingLayoutProbeResult) {
  const flickers: Array<{
    at: number;
    growthPx: number;
    slotJumpPx: number;
  }> = [];
  const growths: Array<{
    at: number;
    bottomGapBeforePx: number;
    following: boolean;
    growthPx: number;
    overflowing: boolean;
    scrollDeltaPx: number;
    slotDeltaPx: number | null;
  }> = [];
  let overflowGrowthCount = 0;
  let pinnedSlotTop: number | null = null;

  for (let index = 1; index < resizeSamples.length; index += 1) {
    const previous = resizeSamples[index - 1];
    const current = resizeSamples[index];
    if (!previous || !current || previous.liveHeight === null || current.liveHeight === null) {
      continue;
    }
    const growthPx = current.liveHeight - previous.liveHeight;
    if (growthPx >= REAL_LINE_GROWTH_PX) {
      growths.push({
        at: current.time,
        bottomGapBeforePx: Math.max(
          0,
          previous.scrollHeight - previous.clientHeight - previous.scrollTop,
        ),
        following: previous.following,
        growthPx,
        overflowing: previous.scrollHeight > previous.clientHeight + REAL_LINE_GROWTH_PX,
        scrollDeltaPx: current.scrollTop - previous.scrollTop,
        slotDeltaPx:
          previous.slotTop === null || current.slotTop === null
            ? null
            : current.slotTop - previous.slotTop,
      });
    }
    const wasPinnedAndOverflowing =
      previous.following &&
      previous.scrollHeight > previous.clientHeight + REAL_LINE_GROWTH_PX &&
      previous.scrollHeight - previous.clientHeight - previous.scrollTop <= 48;
    if (!wasPinnedAndOverflowing) {
      pinnedSlotTop = null;
      continue;
    }
    if (growthPx < REAL_LINE_GROWTH_PX) continue;
    overflowGrowthCount += 1;
    if (previous.slotTop === null || current.slotTop === null) continue;

    if (pinnedSlotTop === null) {
      // 修复原因：从未溢出切到溢出的首个 ResizeObserver 样本仍可能带着
      // scrollTop 补偿前的 8px 过渡偏移。用补偿后的 current 建立贴底基线，
      // 后续样本才用于检测真正的“下移再回位”，避免把正常边界切换判成闪烁。
      pinnedSlotTop = current.slotTop;
      continue;
    }
    const slotJumpPx = current.slotTop - pinnedSlotTop;
    if (slotJumpPx <= LAYOUT_EPSILON_PX) continue;
    flickers.push({
      at: current.time,
      growthPx,
      slotJumpPx,
    });
  }

  return {
    flickers,
    growths,
    loadingVisibleSamples: samples.filter((sample) => sample.loadingVisible).length,
    overflowGrowthCount,
  };
}

function analyzeTerminalScrollOwnership({ samples }: ChatLoadingLayoutProbeResult) {
  const detachedStart = samples.findIndex((sample) => !sample.following && sample.bottomGap > 48);
  // 修复原因：第二轮探针安装后、第二条消息开始前会先采到上一轮正确的
  // FOLLOWING 终态；CHL08 的所有权窗口只能从本轮首次用户离底开始计算。
  const ownershipSamples = detachedStart < 0 ? [] : samples.slice(detachedStart);
  const terminalSamples = ownershipSamples.filter(
    (sample) => !sample.hasLiveTail && sample.historyOpen === false,
  );
  return {
    terminalDetachedSamples: terminalSamples.filter(
      (sample) => !sample.following && sample.bottomGap > 48,
    ).length,
    forcedFollowingSamples: terminalSamples.filter(
      (sample) => sample.following || sample.bottomGap <= 48,
    ),
  };
}

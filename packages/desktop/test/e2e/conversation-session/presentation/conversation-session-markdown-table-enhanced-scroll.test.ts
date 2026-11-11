import { TID_V4_TIMELINE } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { restartWithSeededOpenAIProviders } from "#e2e/helpers/custom-openai-provider";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  clickV4TimelineBackToBottom,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-markdown-table-enhanced-scroll";
const MODEL_ID = "e2e-markdown-table-enhanced-scroll-model";
const PROVIDER_ID = "e2e-markdown-table-enhanced-scroll-provider";
const PROVIDER_NAME = "Markdown Table Enhanced Scroll E2E";
const CASE_MARKER = "E2E_MARKDOWN_TABLE_ENHANCED";
const SHORT_TABLE_MARKER = `${CASE_MARKER}_SHORT`;
const WIDE_TABLE_MARKER = `${CASE_MARKER}_WIDE`;
const TALL_TABLE_MARKER = `${CASE_MARKER}_TALL`;
const EXPAND_SCROLL_LABELS = ["展开表格滚动区域", "Expand table scroll area"];
const COLLAPSE_SCROLL_LABELS = ["收回表格滚动区域", "Collapse table scroll area"];

let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

interface MarkdownTableEnhancedSnapshot {
  exists: boolean;
  actionLabels: string[];
  bodyRowCount: number;
  canToggleExpandedScroll: boolean;
  contentMaxWidth: number;
  contentTransitionDuration: string;
  contentTransitionProperty: string;
  contentWidth: number;
  edgeShadowLeftVisible: boolean;
  edgeShadowRightVisible: boolean;
  frameHovered: boolean;
  hoverMediaMatches: boolean;
  frameWidth: number;
  tableWidth: number;
  thumbBackgroundColor: string;
  thumbHeight: number;
  thumbLeft: number;
  thumbWidth: number;
  trackBackdropFilter: string;
  trackBorderTopWidth: string;
  trackHeight: number;
  trackOuterOpacity: string;
  trackOuterPointerEvents: string;
  trackOuterSticky: boolean;
  trackOuterWidth: number;
  trackWidth: number;
  viewportClientWidth: number;
  viewportLeftOffset: number;
  viewportScrollLeft: number;
  viewportScrollWidth: number;
  virtualScrollMax: number;
  virtualScrollLeft: number;
}

interface StickyOverlapSnapshot {
  composerOverlap: boolean;
  scrollBottomOverlap: boolean;
  tableMiddleVisible: boolean;
  trackBottom: number;
  trackTop: number;
}

interface FractionalScrollbarStabilityProbe {
  followingStates: Array<string | null>;
  frameHeights: number[];
  timelineScrollHeights: number[];
  timelineScrollTops: number[];
  trackMountedSamples: boolean[];
  trackMounts: number;
  trackUnmounts: number;
}

describe("会话区 Markdown Table Enhanced Scroll E2E", () => {
  before(async function () {
    this.timeout(240000);
    modelProviderReplayServer = await startConversationModelProviderReplayServer(CASE_NAME);
    await prepareMarkdownTableEnhancedReplayConversation();
    await renderEnhancedMarkdownTables();
  });

  after(async () => {
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("只在超宽且增强滚动有收益的表格显示开关", async function () {
    this.timeout(60000);

    const shortTable = await waitForEnhancedSnapshot(
      SHORT_TABLE_MARKER,
      (snapshot) => snapshot.exists,
      "短表格没有渲染",
    );
    const wideTable = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (snapshot) => snapshot.canToggleExpandedScroll,
      "超宽表格没有显示增强滚动开关",
    );

    expect(shortTable.canToggleExpandedScroll).toBe(false);
    expect(wideTable.tableWidth).toBeGreaterThan(wideTable.frameWidth + 1);
    expect(wideTable.canToggleExpandedScroll).toBe(true);
  });

  it("默认关闭增强滚动时虚拟滚动槽保持在 frame 宽度内", async function () {
    this.timeout(60000);

    await ensureExpandedScroll(WIDE_TABLE_MARKER, false);
    const snapshot = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) => candidate.trackWidth > 0 && candidate.virtualScrollMax > 1,
      "默认模式没有渲染虚拟滚动条",
    );

    expect(snapshot.viewportLeftOffset).toBe(0);
    expect(snapshot.viewportScrollLeft).toBe(0);
    expect(snapshot.contentWidth).toBeLessThanOrEqual(snapshot.frameWidth + 1);
    expect(snapshot.trackOuterWidth).toBeCloseTo(snapshot.frameWidth, 1);
    expect(snapshot.viewportScrollWidth).toBeGreaterThan(snapshot.viewportClientWidth);
  });

  it("子像素 overflow 不反复挂载滚动条，也不扰动 timeline 跟随状态", async function () {
    this.timeout(90000);

    const initialTimeline = await getV4TimelineScrollState();
    if (initialTimeline.following !== "true" && initialTimeline.hasBackToBottom) {
      await clickV4TimelineBackToBottom();
    }
    await browser.waitUntil(async () => (await getV4TimelineScrollState()).following === "true", {
      timeout: 15000,
      timeoutMsg: "构造子像素 overflow 前 timeline 没有恢复底部跟随",
    });

    try {
      await setFractionalScrollbarBoundary(SHORT_TABLE_MARKER, true);
      await waitForEnhancedSnapshot(
        SHORT_TABLE_MARKER,
        (candidate) =>
          candidate.trackWidth > 0 &&
          candidate.virtualScrollMax > 1 &&
          candidate.virtualScrollMax < 2 &&
          Math.abs(candidate.trackOuterWidth - candidate.frameWidth) < 1,
        "子像素 overflow 没有稳定渲染虚拟滚动条",
      );
      await waitForStableFractionalScrollbarLayout(SHORT_TABLE_MARKER, "true");

      const followingProbe = await probeFractionalScrollbarStability(SHORT_TABLE_MARKER);
      expectStableFractionalScrollbarProbe(followingProbe, "true");

      await setFractionalScrollbarBoundary(SHORT_TABLE_MARKER, false);
      await scrollV4TimelineToTop();
      await browser.waitUntil(
        async () => {
          const state = await getV4TimelineScrollState();
          return state.following === "false" && state.hasBackToBottom;
        },
        {
          timeout: 15000,
          timeoutMsg: "滚离底部后 timeline 没有进入非跟随阅读状态",
        },
      );

      await setFractionalScrollbarBoundary(SHORT_TABLE_MARKER, true);
      await waitForEnhancedSnapshot(
        SHORT_TABLE_MARKER,
        (candidate) => candidate.trackWidth > 0 && candidate.virtualScrollMax > 1,
        "非跟随状态下子像素 overflow 没有渲染虚拟滚动条",
      );
      await waitForStableFractionalScrollbarLayout(SHORT_TABLE_MARKER, "false");
      const detachedProbe = await probeFractionalScrollbarStability(SHORT_TABLE_MARKER);
      expectStableFractionalScrollbarProbe(detachedProbe, "false");
      expect((await getV4TimelineScrollState()).hasBackToBottom).toBe(true);
    } finally {
      await setFractionalScrollbarBoundary(SHORT_TABLE_MARKER, false);
      const timeline = await getV4TimelineScrollState();
      if (timeline.following !== "true" && timeline.hasBackToBottom) {
        await clickV4TimelineBackToBottom();
      }
    }
  });

  it("展开和收回增强滚动只影响当前表格实例", async function () {
    this.timeout(60000);

    await ensureExpandedScroll(WIDE_TABLE_MARKER, false);
    const before = await getEnhancedSnapshot(WIDE_TABLE_MARKER);
    await ensureExpandedScroll(WIDE_TABLE_MARKER, true);
    const expanded = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) =>
        hasAnyLabel(candidate.actionLabels, COLLAPSE_SCROLL_LABELS) &&
        candidate.trackOuterWidth > before.trackOuterWidth + 1,
      "超宽表格没有展开到增强滚动宽度",
    );
    const tallTable = await getEnhancedSnapshot(TALL_TABLE_MARKER);

    expect(expanded.contentMaxWidth).toBeGreaterThan(before.contentMaxWidth);
    expect(expanded.trackOuterWidth).toBeGreaterThan(before.trackOuterWidth);
    expect(hasAnyLabel(tallTable.actionLabels, EXPAND_SCROLL_LABELS)).toBe(true);

    await dispatchMarkdownTableWheel(WIDE_TABLE_MARKER, expanded.virtualScrollMax);
    const scrolled = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) => candidate.virtualScrollLeft > 0,
      "增强滚动展开后没有产生虚拟滚动位置",
    );
    await ensureExpandedScroll(WIDE_TABLE_MARKER, false);
    const collapsed = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) =>
        hasAnyLabel(candidate.actionLabels, EXPAND_SCROLL_LABELS) &&
        candidate.viewportLeftOffset === 0,
      "增强滚动收回后没有恢复普通模式",
    );

    expect(collapsed.viewportScrollLeft).toBeGreaterThan(0);
    expect(scrolled.virtualScrollLeft).toBeGreaterThan(0);
  });

  it("向左借位先消耗 translateX，达到上限后再滚动内部 viewport", async function () {
    this.timeout(60000);

    await ensureExpandedScroll(WIDE_TABLE_MARKER, true);
    await setMarkdownTableVirtualScrollLeft(WIDE_TABLE_MARKER, 0);
    // 修复原因：当前布局的左借位上限可能小于 80px，单次大 wheel 会在同一帧
    // 同时消耗借位并滚动内部 viewport；这里用小 delta 只验证第一阶段借位。
    await dispatchMarkdownTableWheel(WIDE_TABLE_MARKER, 8);
    const borrowed = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) => candidate.viewportLeftOffset > 0,
      "增强滚动没有先向左借位",
    );

    expect(borrowed.viewportScrollLeft).toBe(0);
    expect(borrowed.edgeShadowLeftVisible).toBe(false);
    expect(borrowed.edgeShadowRightVisible).toBe(true);
    expect(borrowed.thumbLeft).toBeGreaterThan(0);

    await dispatchMarkdownTableWheel(WIDE_TABLE_MARKER, borrowed.virtualScrollMax);
    const innerScrolled = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) => candidate.viewportScrollLeft > 0,
      "左借位到上限后没有继续滚动内部 viewport",
    );

    expect(innerScrolled.viewportLeftOffset).toBeGreaterThanOrEqual(borrowed.viewportLeftOffset);
    expect(innerScrolled.edgeShadowLeftVisible).toBe(true);
  });

  it("虚拟滚动条 hover 显示，thumb 点击不触发 track 跳转", async function () {
    this.timeout(60000);

    await ensureExpandedScroll(WIDE_TABLE_MARKER, true);
    // 修复原因：上一条用例可能把系统指针停在表格上，连续运行时初始快照会继承 hover 态。
    await movePointerAwayFromMarkdownTableFrame();
    const hidden = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) =>
        Number.parseFloat(candidate.trackOuterOpacity) < 0.1 &&
        candidate.trackOuterPointerEvents === "none",
      "移开指针后虚拟滚动条没有回到隐藏态",
    );
    expect(Number.parseFloat(hidden.trackOuterOpacity)).toBeLessThan(0.1);
    expect(hidden.trackOuterPointerEvents).toBe("none");

    await hoverMarkdownTableFrame(WIDE_TABLE_MARKER);
    if (!hidden.hoverMediaMatches) {
      const unsupportedHover = await getEnhancedSnapshot(WIDE_TABLE_MARKER);
      // 修复原因：Windows ChromeDriver 可能能把 DOM 置为 :hover，却把主指针能力
      // 报告为 hover:none；Tailwind hover variant 此时按媒体查询保持隐藏。该 worker
      // 验证无 hover 设备的隐藏合同，hover 显示与拖动继续由支持 hover 的 worker 覆盖。
      expect(unsupportedHover.frameHovered).toBe(true);
      expect(Number.parseFloat(unsupportedHover.trackOuterOpacity)).toBeLessThan(0.1);
      expect(unsupportedHover.trackOuterPointerEvents).toBe("none");
      return;
    }
    let stableVisibleSamples = 0;
    const visible = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) => {
        const visibleAndInteractive =
          candidate.frameHovered &&
          Number.parseFloat(candidate.trackOuterOpacity) > 0.9 &&
          candidate.trackOuterPointerEvents !== "none";
        stableVisibleSamples = visibleAndInteractive ? stableVisibleSamples + 1 : 0;
        return stableVisibleSamples >= 2;
      },
      "hover 表格 frame 后虚拟滚动条没有显示",
    );

    await setMarkdownTableVirtualScrollLeft(WIDE_TABLE_MARKER, 120);
    const beforeThumbClick = await getEnhancedSnapshot(WIDE_TABLE_MARKER);
    await clickMarkdownTableThumb(WIDE_TABLE_MARKER);
    const afterThumbClick = await getEnhancedSnapshot(WIDE_TABLE_MARKER);
    await dragMarkdownTableThumb(WIDE_TABLE_MARKER, 80);
    const afterThumbDrag = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) =>
        candidate.virtualScrollLeft > afterThumbClick.virtualScrollLeft + 20 &&
        candidate.thumbLeft > afterThumbClick.thumbLeft + 4,
      "拖动 thumb 后虚拟滚动位置没有按拖动方向变化",
    );

    expect(visible.trackWidth).toBeGreaterThan(0);
    expect(
      Math.abs(afterThumbClick.virtualScrollLeft - beforeThumbClick.virtualScrollLeft),
    ).toBeLessThan(2);
    expect(afterThumbDrag.virtualScrollLeft).toBeLessThan(
      afterThumbClick.virtualScrollLeft + afterThumbDrag.virtualScrollMax / 2,
    );
  });

  it("长表格才 sticky，虚拟滚动条样式和 resize 重算保持合同", async function () {
    this.timeout(90000);

    // 修复原因：默认 E2E 小窗口会让 6 行宽表也超过 80% 可视高度，无法构成短/长对照；
    // 先固定足够高的视口，保证该 case 验证的是表格高度阈值而不是测试窗口偶然尺寸。
    await setElectronWindowSize(1800, 1000);
    await ensureExpandedScroll(WIDE_TABLE_MARKER, true);
    await ensureExpandedScroll(TALL_TABLE_MARKER, true);
    const short = await getEnhancedSnapshot(SHORT_TABLE_MARKER);
    const tall = await getEnhancedSnapshot(TALL_TABLE_MARKER);

    // 修复原因：V4 virtual row 使用 transform，产品通过 relative + translateY 实现吸底；
    // computed position 不是 sticky 语义来源，先断言显式模式，再用下方滚动几何证明实际吸底。
    expect(short.trackOuterSticky).toBe(false);
    expect(tall.trackOuterSticky).toBe(true);
    expect(tall.trackBackdropFilter === "" || tall.trackBackdropFilter === "none").toBe(true);
    expect(tall.trackBorderTopWidth).toBe("0px");
    expect(tall.trackHeight).toBeCloseTo(14, 1);
    expect(tall.thumbHeight).toBeCloseTo(12, 1);
    expect(tall.thumbBackgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    expect(await scrollTallTableToMiddle(TALL_TABLE_MARKER)).toBe(true);
    const overlap = await waitForStickyOverlapSnapshot(
      TALL_TABLE_MARKER,
      (candidate) => candidate.tableMiddleVisible && !candidate.composerOverlap,
      "滚动到长表格中部后 sticky 滚动条没有避让底部 dock",
    );
    expect(overlap.scrollBottomOverlap).toBe(false);
    expect(overlap.trackBottom).toBeGreaterThan(overlap.trackTop);

    await setMarkdownTableVirtualScrollLeft(WIDE_TABLE_MARKER, 80);
    const borrowed = await waitForEnhancedSnapshot(
      WIDE_TABLE_MARKER,
      (candidate) => candidate.viewportLeftOffset > 0,
      "resize 前没有进入左借位状态",
    );
    expect(
      borrowed.contentTransitionDuration.split(",").every((duration) => duration.trim() === "0s"),
    ).toBe(true);
    expect(borrowed.contentTransitionProperty).not.toContain("transform");
    expect(borrowed.contentTransitionProperty).not.toContain("max-width");

    try {
      await forceMarkdownTableLayoutRootWidth(1180);
      const resized = await waitForEnhancedSnapshot(
        WIDE_TABLE_MARKER,
        (candidate) => Math.abs(candidate.trackOuterWidth - borrowed.trackOuterWidth) > 1,
        "root resize 后增强滚动宽度没有重算",
      );
      expect(resized.virtualScrollLeft).toBeLessThanOrEqual(resized.virtualScrollMax + 1);
    } finally {
      await forceMarkdownTableLayoutRootWidth(null);
    }

    await setElectronWindowSize(1800, 1000);
  });
});

async function prepareMarkdownTableEnhancedReplayConversation() {
  // 修复原因：增强滚动 case 依赖稳定的短表格、超宽短表格和超宽长表格组合。
  // 使用 case-local OpenAI-compatible replay provider，避免真实模型输出列宽/行高漂移。
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  // 修复原因：设置页保存完成不代表 active workspace registry 已刷新；若立即发送，
  // runtime 仍可能使用旧模型。进程退出后 seed App+CLI 配置并重启，消除该竞态。
  const [provider] = await restartWithSeededOpenAIProviders([
    {
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
    },
  ]);
  if (!provider) throw new Error("Markdown table enhanced replay provider seed 失败");
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  await selectUpstreamProviderModelById(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName: provider.name,
  });
  await waitForUpstreamModelSelected(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
}

function forceMarkdownTableLayoutRootWidth(width: number | null) {
  return browser.execute((nextWidth) => {
    // 修复原因：V4 已移除旧 chat-view test id，继续使用它会让 resize 合同只在旧 UI 生效。
    // 这里与产品的布局根选择器对齐，同时保留旧 UI fallback。
    const root = document.querySelector<HTMLElement>(
      '[data-markdown-table-layout-root="true"], [data-testid="chat-view"]',
    );
    if (!root) {
      throw new Error("找不到 Markdown table layout root，无法触发增强滚动 resize 验证");
    }
    if (nextWidth === null) {
      root.style.width = "";
      root.style.maxWidth = "";
      return;
    }
    root.style.width = `${nextWidth}px`;
    root.style.maxWidth = `${nextWidth}px`;
  }, width);
}

function setFractionalScrollbarBoundary(marker: string, enabled: boolean) {
  return browser.execute(
    (markerText, shouldEnable) => {
      const table =
        Array.from(
          document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
        ).find((candidate) =>
          (candidate.innerText || candidate.textContent || "").includes(markerText),
        ) ?? null;
      const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
      if (!table || !frame) {
        throw new Error(`找不到 marker=${markerText} 的 Markdown table`);
      }

      if (!shouldEnable) {
        for (const property of ["width", "min-width", "max-width", "flex"]) {
          frame.style.removeProperty(property);
        }
        for (const property of ["width", "min-width", "max-width"]) {
          table.style.removeProperty(property);
        }
        return;
      }

      // 修复原因：真实抖动发生在 table 比浮点 frame 宽约 1.26px 的阈值附近；
      // 固定为 CDP 捕获到的几何值，才能稳定复现整数 CSS 宽度与浮点测量互相翻转的问题。
      frame.style.setProperty("width", "490.3125px", "important");
      frame.style.setProperty("min-width", "490.3125px", "important");
      frame.style.setProperty("max-width", "490.3125px", "important");
      frame.style.setProperty("flex", "0 0 490.3125px", "important");
      table.style.setProperty("width", "491.5703125px", "important");
      table.style.setProperty("min-width", "491.5703125px", "important");
      table.style.setProperty("max-width", "491.5703125px", "important");
    },
    marker,
    enabled,
  );
}

function probeFractionalScrollbarStability(
  marker: string,
  durationMs = 1000,
): Promise<FractionalScrollbarStabilityProbe> {
  return browser.executeAsync(
    (markerText, probeDurationMs, timelineTestId, done) => {
      const table =
        Array.from(
          document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
        ).find((candidate) =>
          (candidate.innerText || candidate.textContent || "").includes(markerText),
        ) ?? null;
      const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const trackSelector = "[data-markdown-table-virtual-scroll-track]";
      if (!frame || !timeline) {
        done({
          followingStates: [],
          frameHeights: [],
          timelineScrollHeights: [],
          timelineScrollTops: [],
          trackMountedSamples: [],
          trackMounts: -1,
          trackUnmounts: -1,
        });
        return;
      }

      const result: FractionalScrollbarStabilityProbe = {
        followingStates: [],
        frameHeights: [],
        timelineScrollHeights: [],
        timelineScrollTops: [],
        trackMountedSamples: [],
        trackMounts: 0,
        trackUnmounts: 0,
      };
      const containsTrack = (node: Node) =>
        node instanceof Element &&
        (node.matches(trackSelector) || Boolean(node.querySelector(trackSelector)));
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          result.trackMounts += Array.from(mutation.addedNodes).filter(containsTrack).length;
          result.trackUnmounts += Array.from(mutation.removedNodes).filter(containsTrack).length;
        }
      });
      observer.observe(frame, { childList: true, subtree: true });

      const startedAt = performance.now();
      const sample = () => {
        result.frameHeights.push(frame.getBoundingClientRect().height);
        result.timelineScrollHeights.push(timeline.scrollHeight);
        result.timelineScrollTops.push(timeline.scrollTop);
        result.followingStates.push(timeline.getAttribute("data-following"));
        result.trackMountedSamples.push(Boolean(frame.querySelector(trackSelector)));

        if (performance.now() - startedAt >= probeDurationMs) {
          observer.disconnect();
          done(result);
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    marker,
    durationMs,
    TID_V4_TIMELINE,
  );
}

function expectStableFractionalScrollbarProbe(
  probe: FractionalScrollbarStabilityProbe,
  expectedFollowing: "true" | "false",
) {
  const range = (values: number[]) => Math.max(...values) - Math.min(...values);

  expect(probe.trackMountedSamples.length).toBeGreaterThan(10);
  expect(probe.trackMountedSamples.every(Boolean)).toBe(true);
  expect(probe.trackMounts).toBe(0);
  expect(probe.trackUnmounts).toBe(0);
  expect(range(probe.frameHeights)).toBeLessThan(1);
  expect(range(probe.timelineScrollHeights)).toBeLessThan(1);
  expect(range(probe.timelineScrollTops)).toBeLessThan(1);
  expect([...new Set(probe.followingStates)]).toEqual([expectedFollowing]);
}

async function setElectronWindowSize(width: number, height: number) {
  const targetSize = await browser.electron.execute(
    (electron, nextWidth, nextHeight) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) {
        return false;
      }
      // 修复原因：macOS/CI 会把超过显示器工作区的 BrowserWindow 自动裁剪；继续等待请求值
      // 会稳定超时。用当前窗口所在显示器的 workArea 计算操作系统实际可接受的目标尺寸。
      const workArea = electron.screen.getDisplayMatching(window.getBounds()).workAreaSize;
      const targetWidth = Math.min(nextWidth, workArea.width);
      const targetHeight = Math.min(nextHeight, workArea.height);
      const bounds = window.getBounds();
      window.setBounds({
        ...bounds,
        height: targetHeight,
        width: targetWidth,
      });
      window.focus();
      return { height: targetHeight, width: targetWidth };
    },
    width,
    height,
  );
  if (!targetSize) {
    throw new Error("没有找到可调整尺寸的 Electron 窗口");
  }

  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedWidth, expectedHeight) =>
          Math.abs(window.innerWidth - expectedWidth) < 80 &&
          Math.abs(window.innerHeight - expectedHeight) < 120,
        targetSize.width,
        targetSize.height,
      ),
    {
      timeout: 10000,
      timeoutMsg: `Electron 窗口尺寸没有收敛到 ${targetSize.width}x${targetSize.height}`,
    },
  );
}

async function waitForStableFractionalScrollbarLayout(
  marker: string,
  expectedFollowing: "true" | "false",
) {
  let previousSignature: string | null = null;
  let stableSampleCount = 0;

  await browser.waitUntil(
    async () => {
      const snapshot = await browser.execute(
        (markerText, timelineTestId) => {
          const table = Array.from(
            document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
          ).find((candidate) =>
            (candidate.innerText || candidate.textContent || "").includes(markerText),
          );
          const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
          const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
          const trackMounted = Boolean(
            frame?.querySelector("[data-markdown-table-virtual-scroll-track]"),
          );
          if (!frame || !timeline || !trackMounted) return null;

          return {
            following: timeline.getAttribute("data-following"),
            frameHeight: Math.round(frame.getBoundingClientRect().height * 100) / 100,
            scrollHeight: timeline.scrollHeight,
            scrollTop: Math.round(timeline.scrollTop * 100) / 100,
          };
        },
        marker,
        TID_V4_TIMELINE,
      );
      if (!snapshot || snapshot.following !== expectedFollowing) {
        previousSignature = null;
        stableSampleCount = 0;
        return false;
      }

      const signature = JSON.stringify(snapshot);
      stableSampleCount = signature === previousSignature ? stableSampleCount + 1 : 0;
      previousSignature = signature;
      return stableSampleCount >= 3;
    },
    {
      interval: 100,
      timeout: 15000,
      timeoutMsg: `子像素 overflow 初始布局没有稳定，following=${expectedFollowing}`,
    },
  );
}

async function renderEnhancedMarkdownTables() {
  await sendV4Prompt(
    `${CASE_MARKER}: 请只回复三个 Markdown 表格，不要解释，不要放进代码块。第一个短表格包含 ${SHORT_TABLE_MARKER}；第二个超宽短表格包含 ${WIDE_TABLE_MARKER}；第三个超宽长表格包含 ${TALL_TABLE_MARKER} 和 ${TALL_TABLE_MARKER}_ROW_120。`,
  );
  // 修复原因：冷启动首次提交要等待 Agent 建 session；UI 只在 command resolve 后清空
  // Lexical。固定 10 秒会在消息已被 Agent 接收、但 RPC 尚未回执时提前 teardown。
  await waitForV4ComposerText("", "增强滚动 prompt 发送后输入框没有清空", 30000);
  await waitForV4UserMessageContaining(CASE_MARKER);
  await waitForV4AssistantMessageContaining(SHORT_TABLE_MARKER);
  await waitForV4AssistantMessageContaining(WIDE_TABLE_MARKER);
  await waitForV4AssistantMessageContaining(`${TALL_TABLE_MARKER}_ROW_120`);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "增强滚动表格完成后会话没有回到 idle",
    90000,
  );
}

async function waitForEnhancedSnapshot(
  marker: string,
  predicate: (snapshot: MarkdownTableEnhancedSnapshot) => boolean | Promise<boolean>,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: MarkdownTableEnhancedSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getEnhancedSnapshot(marker);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getEnhancedSnapshot(marker);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }

  // 修复原因：predicate 命中后重新读取可能跨过 hover/transition 的瞬时边界，
  // 调用方应拿到实际通过判定的同一帧快照，而不是下一帧状态。
  return latest ?? getEnhancedSnapshot(marker);
}

function getEnhancedSnapshot(marker: string): Promise<MarkdownTableEnhancedSnapshot> {
  return browser.execute((markerText) => {
    const emptySnapshot: MarkdownTableEnhancedSnapshot = {
      exists: false,
      actionLabels: [],
      bodyRowCount: 0,
      canToggleExpandedScroll: false,
      contentMaxWidth: 0,
      contentTransitionDuration: "",
      contentTransitionProperty: "",
      contentWidth: 0,
      edgeShadowLeftVisible: false,
      edgeShadowRightVisible: false,
      frameHovered: false,
      hoverMediaMatches: window.matchMedia("(hover: hover)").matches,
      frameWidth: 0,
      tableWidth: 0,
      thumbBackgroundColor: "",
      thumbHeight: 0,
      thumbLeft: 0,
      thumbWidth: 0,
      trackBackdropFilter: "",
      trackBorderTopWidth: "",
      trackHeight: 0,
      trackOuterOpacity: "0",
      trackOuterPointerEvents: "none",
      trackOuterSticky: false,
      trackOuterWidth: 0,
      trackWidth: 0,
      viewportClientWidth: 0,
      viewportLeftOffset: 0,
      viewportScrollLeft: 0,
      viewportScrollWidth: 0,
      virtualScrollMax: 0,
      virtualScrollLeft: 0,
    };
    const table = findMarkdownTableByMarker(markerText);
    const viewport = table?.parentElement as HTMLDivElement | null;
    const contentFrame = viewport?.parentElement as HTMLDivElement | null;
    const contentLayer = contentFrame?.parentElement as HTMLDivElement | null;
    const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
    const track =
      frame?.querySelector<HTMLElement>("[data-markdown-table-virtual-scroll-track]") ?? null;
    const trackOuter = track?.parentElement as HTMLElement | null;
    const thumb = track?.firstElementChild as HTMLElement | null;
    const toolbar =
      frame?.parentElement?.querySelector<HTMLElement>("[data-markdown-table-toolbar]") ?? null;

    if (!table || !viewport || !contentLayer || !frame) {
      return emptySnapshot;
    }

    const frameRect = frame.getBoundingClientRect();
    const contentRect = contentLayer.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const trackRect = track?.getBoundingClientRect();
    const trackOuterRect = trackOuter?.getBoundingClientRect();
    const thumbRect = thumb?.getBoundingClientRect();
    const contentStyle = window.getComputedStyle(contentLayer);
    const trackStyle = track ? window.getComputedStyle(track) : null;
    const trackOuterStyle = trackOuter ? window.getComputedStyle(trackOuter) : null;
    const thumbStyle = thumb ? window.getComputedStyle(thumb) : null;
    const actionLabels = Array.from(toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter(Boolean);
    const thumbLeft = thumbRect && trackRect ? thumbRect.left - trackRect.left : 0;
    const viewportLeftOffset = Math.max(0, Math.round(frameRect.left - contentRect.left));
    const trackWidth = trackRect?.width ?? 0;

    return {
      exists: true,
      actionLabels,
      bodyRowCount: table.querySelectorAll("tbody tr").length,
      canToggleExpandedScroll: actionLabels.some((label) =>
        /展开表格滚动区域|Expand table scroll area|收回表格滚动区域|Collapse table scroll area/u.test(
          label,
        ),
      ),
      contentMaxWidth: Number.parseFloat(contentStyle.maxWidth) || contentRect.width,
      contentTransitionDuration: contentStyle.transitionDuration,
      contentTransitionProperty: contentStyle.transitionProperty,
      contentWidth: contentRect.width,
      edgeShadowLeftVisible: Boolean(
        frame.querySelector('[data-markdown-table-edge-shadow="left"]'),
      ),
      edgeShadowRightVisible: Boolean(
        frame.querySelector('[data-markdown-table-edge-shadow="right"]'),
      ),
      frameHovered: frame.matches(":hover"),
      hoverMediaMatches: window.matchMedia("(hover: hover)").matches,
      frameWidth: frameRect.width,
      tableWidth: tableRect.width,
      thumbBackgroundColor: thumbStyle?.backgroundColor ?? "",
      thumbHeight: thumbRect?.height ?? 0,
      thumbLeft,
      thumbWidth: thumbRect?.width ?? 0,
      trackBackdropFilter: trackStyle?.backdropFilter ?? "",
      trackBorderTopWidth: trackStyle?.borderTopWidth ?? "",
      trackHeight: trackRect?.height ?? 0,
      trackOuterOpacity: trackOuterStyle?.opacity ?? "0",
      trackOuterPointerEvents: trackOuterStyle?.pointerEvents ?? "none",
      trackOuterSticky: frame.dataset.markdownTableVirtualScrollSticky === "true",
      trackOuterWidth: trackOuterRect?.width ?? 0,
      trackWidth,
      viewportClientWidth: viewport.clientWidth,
      viewportLeftOffset,
      viewportScrollLeft: viewport.scrollLeft,
      viewportScrollWidth: viewport.scrollWidth,
      virtualScrollMax: Math.max(0, tableRect.width - trackWidth),
      virtualScrollLeft: viewportLeftOffset + viewport.scrollLeft,
    };

    function findMarkdownTableByMarker(markerValue: string) {
      return (
        Array.from(
          document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
        ).find((candidate) =>
          (candidate.innerText || candidate.textContent || "").includes(markerValue),
        ) ?? null
      );
    }
  }, marker);
}

async function waitForStickyOverlapSnapshot(
  marker: string,
  predicate: (snapshot: StickyOverlapSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: StickyOverlapSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getStickyOverlapSnapshot(marker);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getStickyOverlapSnapshot(marker).catch(() => latest);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }

  return getStickyOverlapSnapshot(marker);
}

function getStickyOverlapSnapshot(marker: string): Promise<StickyOverlapSnapshot> {
  return browser.execute((markerText) => {
    const table =
      Array.from(
        document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
      ).find((candidate) =>
        (candidate.innerText || candidate.textContent || "").includes(markerText),
      ) ?? null;
    const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
    const trackOuter =
      frame?.querySelector<HTMLElement>("[data-markdown-table-virtual-scroll-track]")
        ?.parentElement ?? null;
    const composerDock = document.querySelector<HTMLElement>('[data-chat-composer-region="true"]');
    const scrollBottomButton =
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        ["Scroll to bottom", "滚动到底部"].includes(button.getAttribute("aria-label") ?? ""),
      ) ?? null;
    const middleRow =
      Array.from(table?.querySelectorAll<HTMLTableRowElement>("tr") ?? []).find((row) =>
        (row.innerText || row.textContent || "").includes(`${markerText}_ROW_060`),
      ) ?? null;
    const trackRect = trackOuter?.getBoundingClientRect();
    const dockRect = composerDock?.getBoundingClientRect();
    const scrollButtonRect = scrollBottomButton?.getBoundingClientRect();
    const middleRowRect = middleRow?.getBoundingClientRect();

    return {
      composerOverlap: Boolean(trackRect && dockRect && intersects(trackRect, dockRect)),
      scrollBottomOverlap: Boolean(
        trackRect && scrollButtonRect && intersects(trackRect, scrollButtonRect),
      ),
      tableMiddleVisible: Boolean(
        middleRowRect && middleRowRect.top >= 0 && middleRowRect.bottom <= window.innerHeight,
      ),
      trackBottom: trackRect?.bottom ?? 0,
      trackTop: trackRect?.top ?? 0,
    };

    function intersects(first: DOMRect, second: DOMRect) {
      return (
        first.left < second.right &&
        first.right > second.left &&
        first.top < second.bottom &&
        first.bottom > second.top
      );
    }
  }, marker);
}

function scrollTallTableToMiddle(marker: string) {
  return browser.execute((markerText) => {
    const table =
      Array.from(
        document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
      ).find((candidate) =>
        (candidate.innerText || candidate.textContent || "").includes(markerText),
      ) ?? null;
    const middleRow =
      Array.from(table?.querySelectorAll<HTMLTableRowElement>("tr") ?? []).find((row) =>
        (row.innerText || row.textContent || "").includes(`${markerText}_ROW_060`),
      ) ?? null;
    middleRow?.scrollIntoView({ block: "center", inline: "nearest" });
    return Boolean(middleRow);
  }, marker);
}

async function ensureExpandedScroll(marker: string, enabled: boolean) {
  const snapshot = await getEnhancedSnapshot(marker);
  if (!snapshot.exists) {
    throw new Error(`找不到 marker=${marker} 的 Markdown table`);
  }
  if (enabled && hasAnyLabel(snapshot.actionLabels, COLLAPSE_SCROLL_LABELS)) return;
  if (!enabled && hasAnyLabel(snapshot.actionLabels, EXPAND_SCROLL_LABELS)) return;

  const labels = enabled ? EXPAND_SCROLL_LABELS : COLLAPSE_SCROLL_LABELS;
  const clicked = await clickMarkdownTableButton(marker, labels);
  expect(clicked).toBe(true);
  await waitForEnhancedSnapshot(
    marker,
    (candidate) =>
      enabled
        ? hasAnyLabel(candidate.actionLabels, COLLAPSE_SCROLL_LABELS)
        : hasAnyLabel(candidate.actionLabels, EXPAND_SCROLL_LABELS),
    enabled ? "增强滚动开关没有切到展开态" : "增强滚动开关没有切到收回态",
  );
}

async function clickMarkdownTableButton(marker: string, labels: string[]) {
  return browser.execute(
    (markerText, expectedLabels) => {
      const table =
        Array.from(
          document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
        ).find((candidate) =>
          (candidate.innerText || candidate.textContent || "").includes(markerText),
        ) ?? null;
      const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
      const toolbar =
        frame?.parentElement?.querySelector<HTMLElement>("[data-markdown-table-toolbar]") ?? null;
      const button =
        Array.from(toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((candidate) =>
          expectedLabels.includes(candidate.getAttribute("aria-label") ?? ""),
        ) ?? null;
      button?.scrollIntoView({ block: "center", inline: "nearest" });
      if (!button) {
        return false;
      }
      // 修复原因：Windows 全量回归中 toolbar 会在滚动/hover 后短暂重排，
      // 指针坐标点击可能落到旧位置；这里直接触发按钮语义，后续滚动交互仍走真实事件。
      button.click();
      return true;
    },
    marker,
    labels,
  );
}

async function movePointerAwayFromMarkdownTableFrame() {
  await browser.performActions([
    {
      id: "markdown-table-away-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", duration: 0, x: 8, y: 8 }],
    },
  ]);
  await browser.releaseActions();
}

function dispatchMarkdownTableWheel(marker: string, deltaX: number) {
  return browser.execute(
    (markerText, nextDeltaX) => {
      const table =
        Array.from(
          document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
        ).find((candidate) =>
          (candidate.innerText || candidate.textContent || "").includes(markerText),
        ) ?? null;
      const viewport = table?.parentElement;
      if (!viewport) return false;
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: nextDeltaX,
        }),
      );
      return true;
    },
    marker,
    deltaX,
  );
}

function setMarkdownTableVirtualScrollLeft(marker: string, left: number) {
  return browser.execute(
    (markerText, scrollLeft) => {
      const table =
        Array.from(
          document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
        ).find((candidate) =>
          (candidate.innerText || candidate.textContent || "").includes(markerText),
        ) ?? null;
      const viewport = table?.parentElement;
      if (!viewport) return false;
      viewport.scrollLeft = 0;
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: -1_000_000,
        }),
      );
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: scrollLeft,
        }),
      );
      return true;
    },
    marker,
    left,
  );
}

async function hoverMarkdownTableFrame(marker: string) {
  let latest: MarkdownTableEnhancedSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        const frame = await findMarkdownTableFrameElement(marker);
        await frame.scrollIntoView({ block: "center", inline: "nearest" });
        // 修复原因：Windows ChromeDriver 对 scrollIntoView 后立即使用 viewport 坐标的
        // pointerMove 可能命中旧布局；元素锚点 moveTo 会基于当前 frame 几何重新定位。
        await frame.moveTo();
        latest = await getEnhancedSnapshot(marker);
        return latest.frameHovered;
      },
      {
        timeout: 10000,
        timeoutMsg: `marker=${marker} 的 markdown table frame 没有进入 hover 状态`,
      },
    );
  } catch (error) {
    latest = await getEnhancedSnapshot(marker).catch(() => latest);
    throw new Error(
      `marker=${marker} 的 markdown table frame 没有进入 hover 状态; latest=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function findMarkdownTableFrameElement(marker: string) {
  const frames = await $$("[data-markdown-table-frame]");
  for (const frame of frames) {
    if ((await frame.getText()).includes(marker)) {
      return frame;
    }
  }
  throw new Error(`找不到 marker=${marker} 的 markdown table frame`);
}

async function clickMarkdownTableThumb(marker: string) {
  const point = await readMarkdownTableThumbPoint(marker);
  await browser.performActions([
    {
      id: "markdown-table-thumb-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: point.x, y: point.y },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 20 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

async function dragMarkdownTableThumb(marker: string, deltaX: number) {
  const point = await readMarkdownTableThumbPoint(marker);
  await browser.performActions([
    {
      id: "markdown-table-thumb-drag-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: point.x, y: point.y },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 120, x: point.x + deltaX, y: point.y },
        { type: "pause", duration: 20 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

function readMarkdownTableThumbPoint(marker: string) {
  return browser.execute((markerText) => {
    const table =
      Array.from(
        document.querySelectorAll<HTMLTableElement>('table[data-streamdown="table"]'),
      ).find((candidate) =>
        (candidate.innerText || candidate.textContent || "").includes(markerText),
      ) ?? null;
    const frame = table?.closest<HTMLElement>("[data-markdown-table-frame]") ?? null;
    frame?.scrollIntoView({ block: "center", inline: "nearest" });
    const thumb = frame?.querySelector<HTMLElement>(
      "[data-markdown-table-virtual-scroll-track] > div",
    );
    const rect = thumb?.getBoundingClientRect();
    if (!rect) {
      throw new Error(`找不到 marker=${markerText} 的 markdown table thumb`);
    }
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }, marker);
}

function hasAnyLabel(labels: string[], expectedLabels: string[]) {
  return labels.some((label) => expectedLabels.includes(label));
}

// HLP02/M5④ 门禁：长历史无感分页（顶部历史可达 + prepend 不跳）。
// 证据层 L3：21 个 completed turn 产出 >60 raw rows，越过快照尾窗；
// 切走再切回（keep-warm 过期 → 全新 subscribe）拿到截断快照，验证：
// ① 截断可见：data-window-row-count=60 < data-total-row-count，但不显示「加载更早」；
// ② 用户向更早历史滚动时自动触发 loadOlder → 全部历史可达（首个 turn 可见）；
// ③ prepend 锚定不跳：补页前视口首行在补页后仍停留在视口附近（不弹回顶部/底部）。
// 合并/游标语义的完整覆盖在 L1（v4SessionDataLayer.test.ts loadOlder 组 +
// bootstrap conversation-topic-publisher rows/range 黄金组）。
import { TID_V4_TIMELINE, TID_V4_TIMELINE_LOAD_OLDER } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

/** E2E build 的 SessionDataLayer keep-warm 窗口（1s）+ 余量。 */
const KEEP_WARM_EXPIRY_MS = 2_000;

const HISTORY_TURNS = 21;
const SNAPSHOT_TAIL_RAW_ROWS = 60;
const PREPEND_ANCHOR_MAX_DELTA_PX = 48;

interface V4TimelineWindowObservation {
  firstVisibleOffsetTop: number | null;
  firstVisibleTurnId: string | null;
  renderUnitCount: number;
  totalRowCount: number;
  visibleTurnOffsets: Record<string, number>;
  windowRowCount: number;
}

function hasV4LoadOlderButton(): Promise<boolean> {
  return browser.execute(
    (loadOlderTestId) => Boolean(document.querySelector(`[data-testid="${loadOlderTestId}"]`)),
    TID_V4_TIMELINE_LOAD_OLDER,
  );
}

/**
 * 在切回 session 前从 renderer 内观察 timeline 属性变化。
 *
 * 修复原因：冷快照 60 行到自动预取完成可能只持续几十毫秒，WDIO 全量并发时下一次
 * execute 往返会直接读到 63 行。MutationObserver 留住真实中间态，避免把机器负载
 * 当成 rows.window 是否截断的产品结论。
 */
function startV4TimelineWindowObservation(): Promise<void> {
  return browser.execute((timelineTestId) => {
    interface BrowserObservationState {
      capture: () => void;
      frame: number | null;
      observer: MutationObserver;
      samples: V4TimelineWindowObservation[];
    }
    const target = window as typeof window & {
      __zcodeV4TimelineWindowObservation?: BrowserObservationState;
    };
    target.__zcodeV4TimelineWindowObservation?.observer.disconnect();

    const samples: V4TimelineWindowObservation[] = [];
    const capture = () => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      if (!timeline) return;
      const timelineTop = timeline.getBoundingClientRect().top;
      const visibleTurnOffsets: Record<string, number> = {};
      for (const unit of timeline.querySelectorAll<HTMLElement>('[data-v4-turn-unit="true"]')) {
        const turnId = unit.dataset.turnId;
        if (!turnId) continue;
        const rect = unit.getBoundingClientRect();
        const offsetTop = rect.top - timelineTop;
        if (rect.bottom - timelineTop <= 0 || offsetTop >= timeline.clientHeight) continue;
        visibleTurnOffsets[turnId] = offsetTop;
      }
      const firstVisibleEntry =
        Object.entries(visibleTurnOffsets).sort((left, right) => left[1] - right[1])[0] ?? null;
      const sample: V4TimelineWindowObservation = {
        firstVisibleOffsetTop: firstVisibleEntry?.[1] ?? null,
        firstVisibleTurnId: firstVisibleEntry?.[0] ?? null,
        renderUnitCount: Number(timeline.dataset.renderUnitCount ?? 0),
        totalRowCount: Number(timeline.dataset.totalRowCount ?? 0),
        visibleTurnOffsets,
        windowRowCount: Number(timeline.dataset.windowRowCount ?? 0),
      };
      const previous = samples.at(-1);
      if (
        previous &&
        previous.windowRowCount === sample.windowRowCount &&
        previous.totalRowCount === sample.totalRowCount &&
        previous.firstVisibleTurnId === sample.firstVisibleTurnId &&
        Math.abs((previous.firstVisibleOffsetTop ?? 0) - (sample.firstVisibleOffsetTop ?? 0)) < 0.5
      ) {
        return;
      }
      samples.push(sample);
    };
    const observer = new MutationObserver(() => {
      capture();
      const state = target.__zcodeV4TimelineWindowObservation;
      if (!state) return;
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(capture);
    });
    observer.observe(document.documentElement, {
      attributeFilter: ["data-render-unit-count", "data-total-row-count", "data-window-row-count"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    target.__zcodeV4TimelineWindowObservation = {
      capture,
      frame: null,
      observer,
      samples,
    };
    capture();
  }, TID_V4_TIMELINE);
}

async function stopV4TimelineWindowObservation(): Promise<V4TimelineWindowObservation[]> {
  return await browser.execute(async () => {
    const target = window as typeof window & {
      __zcodeV4TimelineWindowObservation?: {
        capture: () => void;
        frame: number | null;
        observer: MutationObserver;
        samples: V4TimelineWindowObservation[];
      };
    };
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const state = target.__zcodeV4TimelineWindowObservation;
    if (!state) return [];
    state.capture();
    state.observer.disconnect();
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    delete target.__zcodeV4TimelineWindowObservation;
    return state.samples;
  });
}

function getObservedPrependAnchorState(fullRawRows: number): Promise<{
  samples: V4TimelineWindowObservation[];
  stable: boolean;
}> {
  return browser.execute(
    (expectedFullRawRows, snapshotTailRawRows, historyTurns, maxDeltaPx) => {
      const target = window as typeof window & {
        __zcodeV4TimelineWindowObservation?: {
          capture: () => void;
          samples: V4TimelineWindowObservation[];
        };
      };
      const state = target.__zcodeV4TimelineWindowObservation;
      if (!state) return { samples: [], stable: false };
      state.capture();
      const truncatedIndex = state.samples.findIndex(
        (sample) =>
          sample.windowRowCount === snapshotTailRawRows &&
          sample.totalRowCount === expectedFullRawRows &&
          sample.renderUnitCount > 0 &&
          sample.renderUnitCount < historyTurns,
      );
      const prefetchedIndex = state.samples.findIndex(
        (sample, index) => index > truncatedIndex && sample.windowRowCount > snapshotTailRawRows,
      );
      if (truncatedIndex < 0 || prefetchedIndex <= truncatedIndex) {
        return { samples: state.samples.slice(-12), stable: false };
      }
      // React 同一 commit 中可能先替换虚拟行 DOM、再刷新 data-window-row-count；
      // 因此最后一个“60 行”样本不一定仍属于旧窗口。按稳定 turnId 在截断阶段
      // 与补页阶段的所有样本间配对，避免把属性/DOM 的过渡帧当成锚定基准。
      const stable = state.samples
        .slice(truncatedIndex, prefetchedIndex)
        .some((anchorBefore) =>
          state.samples
            .slice(prefetchedIndex)
            .some((prefetched) =>
              Object.entries(anchorBefore.visibleTurnOffsets).some(
                ([turnId, beforeOffset]) =>
                  prefetched.visibleTurnOffsets[turnId] !== undefined &&
                  Math.abs(prefetched.visibleTurnOffsets[turnId] - beforeOffset) < maxDeltaPx,
              ),
            ),
        );
      return { samples: state.samples.slice(-12), stable };
    },
    fullRawRows,
    SNAPSHOT_TAIL_RAW_ROWS,
    HISTORY_TURNS,
    PREPEND_ANCHOR_MAX_DELTA_PX,
  );
}

describe("v4 HLP02 门禁：长历史无感分页（R-06）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("尾窗截断 → 自动预取补页 → 顶部可达且 prepend 不跳", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();

    // 多 completed turn 是 live/cold 都稳定的持久语义；不再靠单 turn text-block segmentation。
    for (let index = 1; index <= HISTORY_TURNS; index += 1) {
      const marker = String(index).padStart(3, "0");
      await sendV4Prompt(`E2E_V4_OLDER_HISTORY_${marker} 历史轮次`);
      await browser.waitUntil(
        async () => (await getV4TimelineScrollState()).renderUnitCount >= index,
        { timeout: 30000, timeoutMsg: `第 ${index} 个历史 turn 没有完成投影` },
      );
      // 修复原因：row 数达到阈值只证明 projection 已追加，不能证明上一轮的
      // command/composer 收口已完成；紧接着写下一轮会被迟到的清空提交覆盖。
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
        `第 ${index} 个历史 turn 没有回到 idle`,
        30_000,
      );
      await waitForV4ComposerText("", `第 ${index} 个历史 turn 后 composer 没有清空`, 30_000);
    }

    const sessionId = (await getV4PaneSnapshot()).sessionId as string;
    expect(sessionId).not.toBe("draft");

    // live 订阅期间行是流式追加的，客户端窗口=全量；不截断、无「加载更早」。
    const live = await getV4TimelineScrollState();
    // 修复原因：分页合同以 logical turn 和 60-row 窗口为边界；provider 可以把
    // 同一 logical turn 投影成不同数量的 raw rows，不能再硬编码 3 rows/turn。
    const fullRawRows = live.totalRowCount;
    expect(fullRawRows).toBeGreaterThan(SNAPSHOT_TAIL_RAW_ROWS);
    expect(live.windowRowCount).toBe(live.totalRowCount);
    expect(live.renderUnitCount).toBe(HISTORY_TURNS);
    expect(await hasV4LoadOlderButton()).toBe(false);

    // ── 切走 + keep-warm 过期 → 切回拿全新 subscribe（快照尾窗截断） ──
    await startNewV4Draft();
    await browser.pause(KEEP_WARM_EXPIRY_MS);
    await startV4TimelineWindowObservation();
    await selectV4TaskById(sessionId);
    await waitForV4Pane(
      (s) => s.sessionId === sessionId && s.rowCount > 0,
      "切回原会话后 pane 没有绑定/收到快照",
      30000,
    );

    // ① 冷快照必须经过 60/全量截断态。若恢复布局已经进入顶部预取区，补页可能在
    // WDIO 下一次采样前完成；renderer observer 仍会保留该中间态。
    const stateAfterSubscribe = await getV4TimelineScrollState();
    expect(await hasV4LoadOlderButton()).toBe(false);

    if (stateAfterSubscribe.windowRowCount === SNAPSHOT_TAIL_RAW_ROWS) {
      // ── ② 用户向更早历史滚动时自动触发 loadOlder ──
      // scrollV4TimelineToTop 内部已等虚拟化窗口对齐（scroll 事件下一帧才派发，
      // 对齐前 DOM 仍是旧的底部窗口，采样会拿到过期行）。
      await scrollV4TimelineToTop();

      await browser.waitUntil(
        async () => (await getV4TimelineScrollState()).windowRowCount > SNAPSHOT_TAIL_RAW_ROWS,
        {
          timeout: 30000,
          timeoutMsg: "滚动到顶后 loadOlder 没有把更早的行并入窗口",
        },
      );
    } else {
      await browser.waitUntil(
        async () => (await getV4TimelineScrollState()).windowRowCount === fullRawRows,
        {
          timeout: 30000,
          timeoutMsg: "恢复期自动预取没有把更早的行并入窗口",
        },
      );
    }

    // ③ prepend 锚定不跳：不能在 scroll helper 返回后才读取 anchorBefore；补页可能
    // 已在 WDIO 往返期间提交，此时读到的是新 prepend 的 turn，它本来就应留在视口
    // 上方。以 renderer observer 留下的截断阶段稳定 turnId 为基准，条件等待 DOM
    // 锚点收敛；属性与虚拟 DOM 同 commit 的过渡帧由下方配对逻辑排除。
    let observedAnchorState = await getObservedPrependAnchorState(fullRawRows);
    try {
      await browser.waitUntil(
        async () => {
          observedAnchorState = await getObservedPrependAnchorState(fullRawRows);
          return observedAnchorState.stable;
        },
        {
          timeout: 15_000,
          interval: 50,
          timeoutMsg: "prepend 后虚拟列表没有恢复补页前的视口锚点",
        },
      );
    } catch (error) {
      throw new Error(`prepend 锚点采样：${JSON.stringify(observedAnchorState.samples)}`, {
        cause: error,
      });
    }

    const observations = await stopV4TimelineWindowObservation();
    const truncatedIndex = observations.findIndex(
      (sample) =>
        sample.windowRowCount === SNAPSHOT_TAIL_RAW_ROWS &&
        sample.totalRowCount === fullRawRows &&
        sample.renderUnitCount > 0 &&
        sample.renderUnitCount < HISTORY_TURNS,
    );
    expect(truncatedIndex).toBeGreaterThanOrEqual(0);

    const prefetchedIndex = observations.findIndex(
      (sample, index) => index > truncatedIndex && sample.windowRowCount > SNAPSHOT_TAIL_RAW_ROWS,
    );
    expect(prefetchedIndex).toBeGreaterThan(truncatedIndex);

    // 全部历史已并入：窗口 = 全序，且始终没有手动补页按钮。
    const complete = await getV4TimelineScrollState();
    expect(complete.windowRowCount).toBe(complete.totalRowCount);
    expect(complete.renderUnitCount).toBe(HISTORY_TURNS);
    expect(await hasV4LoadOlderButton()).toBe(false);

    // 顶部可达：滚到顶后最早的 turn 进入 DOM（逐字节同全量重放前缀，
    // 服务端等价性由 bootstrap rows/range 黄金测试背书，这里验证用户可达性）。
    await scrollV4TimelineToTop();
    await waitForV4TimelineContaining("E2E_V4_OLDER_HISTORY_001", 15000);
  });
});

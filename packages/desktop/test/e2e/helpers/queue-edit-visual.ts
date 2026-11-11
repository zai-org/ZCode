export interface QueueEditVisualSample {
  at: number;
  visible: boolean;
  sameNode: boolean;
  pending: boolean;
  locked: boolean;
  opacity: number | null;
  top: number | null;
  composerText: string;
}

declare global {
  interface Window {
    __queueEditVisualProbe?: {
      finish(): Promise<QueueEditVisualSample[]>;
    };
  }
}

/**
 * 在真实页面中采样（docs/ui/chat-message-queue.md B09g）；同时用于 Desktop execute 与手机 Web evaluate，
 * 不修改产品状态。按 queueItemId 跟踪目标行，记录加锁中（pending）与本端占位（locked）两个阶段。
 */
export function startQueueEditVisualProbe(queueItemId: string): void {
  const queue = document.querySelector('[data-testid="v4-queue"]');
  if (!queue) throw new Error("单条队列视觉采样缺少队列");
  const pane = queue.closest("[data-session-id]");
  const samples: QueueEditVisualSample[] = [];
  let started = false;
  let stopped = false;
  let frame = 0;
  const sample = () => {
    if (!started || stopped) return;
    const current = pane?.querySelector('[data-testid="v4-queue"]');
    const row = current?.querySelector<HTMLElement>(`[data-queue-item-id="${queueItemId}"]`);
    const value: QueueEditVisualSample = {
      at: performance.now(),
      visible: Boolean(current),
      sameNode: current === queue,
      pending: row?.dataset.editPending === "true",
      locked: row?.dataset.editLocked === "true",
      opacity: row ? Number(getComputedStyle(row).opacity) : null,
      top: current?.getBoundingClientRect().top ?? null,
      composerText: pane?.querySelector('[data-testid="v4-composer-input"]')?.textContent ?? "",
    };
    // 只存状态变化，保留短于一帧的 React commit，避免纯轮询漏掉 ACK 与投影之间的回退。
    const previous = samples.at(-1);
    if (
      !previous ||
      Object.keys(value).some(
        (key) =>
          key !== "at" &&
          value[key as keyof QueueEditVisualSample] !==
            previous[key as keyof QueueEditVisualSample],
      )
    )
      samples.push(value);
  };
  const tick = () => {
    sample();
    if (!stopped) frame = requestAnimationFrame(tick);
  };
  const click = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (started || target?.dataset.testid !== `v4-queue-item-edit-${queueItemId}`) return;
    started = true;
    sample();
    frame = requestAnimationFrame(tick);
  };
  const observer = new MutationObserver(sample);
  observer.observe(pane ?? document.body, { subtree: true, childList: true, attributes: true });
  document.addEventListener("click", click, true);
  window.__queueEditVisualProbe = {
    async finish() {
      // 等待已落定状态真实绘制；不靠固定 sleep 掩盖中间帧。
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      sample();
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("click", click, true);
      delete window.__queueEditVisualProbe;
      return samples;
    },
  };
}

export function finishQueueEditVisualProbe(): Promise<QueueEditVisualSample[]> {
  if (!window.__queueEditVisualProbe) throw new Error("缺少队列视觉采样");
  return window.__queueEditVisualProbe.finish();
}

/**
 * 冻结编辑的无闪动断言（docs/ui/chat-message-queue.md）：
 * 1. 队列面板全程可见且不重挂，目标行不被移除；
 * 2. 加锁中 → 本端占位之间不回到普通行（既非 pending 也非 locked 会重新变亮并露出操作按钮）；
 * 3. 占位出现后不回退；
 * 4. composer 正文只切换一次（原草稿 → 载入内容），不回到原草稿；
 * 5. 队列位置最多因 composer 载入变化一次，之后不再跳动。
 */
export function expectQueueFreezeEditWithoutFlash(
  samples: QueueEditVisualSample[],
  expected: { initialComposerText: string; loadedText: string },
): void {
  expect(samples.length).toBeGreaterThan(1);
  for (const sample of samples) {
    expect(sample.visible).toBe(true);
    expect(sample.sameNode).toBe(true);
    expect(sample.opacity).not.toBeNull();
  }
  const engagedAt = samples.findIndex((sample) => sample.pending || sample.locked);
  const lockedAt = samples.findIndex((sample) => sample.locked);
  expect(engagedAt).toBeGreaterThan(0);
  expect(lockedAt).toBeGreaterThanOrEqual(engagedAt);
  // 修复原因：lock ACK 可能早于 editLock 投影；中间若回到普通行，用户会看到一次亮度与按钮闪动。
  for (const sample of samples.slice(engagedAt)) {
    expect(sample.pending || sample.locked).toBe(true);
  }
  expect(samples.slice(lockedAt).every((sample) => sample.locked)).toBe(true);
  const normalize = (text: string) => text.replace(/\s+/gu, "");
  const loaded = normalize(expected.loadedText);
  const initial = normalize(expected.initialComposerText);
  const loadedAt = samples.findIndex((sample) => normalize(sample.composerText) === loaded);
  expect(loadedAt).toBeGreaterThanOrEqual(0);
  for (const sample of samples.slice(0, loadedAt)) {
    expect(normalize(sample.composerText)).toBe(initial);
  }
  for (const sample of samples.slice(loadedAt)) {
    expect(normalize(sample.composerText)).toBe(loaded);
  }
  const tops = samples.map((sample) => Math.round(sample.top!));
  const topChanges = tops.filter(
    (top, index) => index > 0 && Math.abs(top - tops[index - 1]!) >= 1,
  );
  expect(topChanges.length).toBeLessThanOrEqual(1);
}

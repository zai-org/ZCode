import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  prepareV4ConversationE2E,
  clickV4TimelineBackToBottom,
} from "#e2e/helpers/v4-conversation";
import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import { SIDEBAR_RICH_SESSION_ID } from "#e2e/helpers/sidebar-rich-content-fixture";

const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/sidebar-rich");
const recordOnly = process.env.ZCODE_SIDEBAR_PERF_RECORD_ONLY === "1";
const leftToggle = 'button[aria-label="切换侧边栏"],button[aria-label="Toggle sidebar"]';
const rightToggle = '[data-testid="side-pane-toggle"]';

describe("STF05–07 富内容会话侧栏性能", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await setRendererViewport(1400, 900);
    await $(`[data-testid="task-item-${SIDEBAR_RICH_SESSION_ID}"]`).click();
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const pane = document.querySelector(`[data-session-id="${id}"]`);
          return (
            pane?.getAttribute("data-session-lifecycle") === "ready" &&
            pane.querySelectorAll("table").length >= 7
          );
        }, SIDEBAR_RICH_SESSION_ID),
      { timeout: 60000, timeoutMsg: "持久化会话没有加载至少 7 张真实 Markdown 表格" },
    );
    await mkdir(artifactDir, { recursive: true });
    const metadata = await readFile(
      join(process.env.ZCODE_E2E_HOME_DIR!, "sidebar-rich-fixture.json"),
      "utf8",
    );
    await writeFile(join(artifactDir, "sidebar-rich-fixture.json"), metadata);
    expect(await browser.getUrl()).toContain("/renderer/index.html");
    if (process.env.ZCODE_SIDEBAR_TRACE === "1") {
      await metrics();
      const url = await browser.getUrl();
      await browser.electron.execute(async (electron, url) => {
        const api = electron.BrowserWindow.getAllWindows().find(
          (win) => win.webContents.getURL() === url,
        )!.webContents.debugger;
        await api.sendCommand("Tracing.start", {
          transferMode: "ReturnAsStream",
          categories:
            "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.invalidationTracking",
        });
      }, url);
    }
  });
  after(async () => {
    if (process.env.ZCODE_SIDEBAR_TRACE === "1") {
      const url = await browser.getUrl();
      const trace = await browser.electron.execute(async (electron, url) => {
        const api = electron.BrowserWindow.getAllWindows().find(
          (win) => win.webContents.getURL() === url,
        )!.webContents.debugger;
        const stream = await new Promise<string>((resolve) => {
          const listener = (_event: unknown, method: string, params: { stream?: string }) => {
            if (method !== "Tracing.tracingComplete") return;
            api.removeListener("message", listener);
            resolve(params.stream!);
          };
          api.on("message", listener);
          void api.sendCommand("Tracing.end");
        });
        let text = "";
        for (;;) {
          const chunk = (await api.sendCommand("IO.read", { handle: stream })) as {
            data: string;
            eof: boolean;
          };
          text += chunk.data;
          if (chunk.eof) break;
        }
        await api.sendCommand("IO.close", { handle: stream });
        return text;
      }, url);
      await writeFile(join(artifactDir, "sidebar-rich-trace.json"), trace);
    }
    await clearRendererViewport();
  });

  it("STF05/07：生产 renderer 真实历史路径、原尺寸动画与性能采样", async () => {
    const samples = [];
    // 一次预热后采样；交替 A/B 由相同构建产物分别运行本例，不能关闭动画换取数字。
    await invoke(rightToggle);
    await invoke(rightToggle);
    for (const [name, selector] of [
      ["left-close", leftToggle],
      ["left-open", leftToggle],
      ["right-open", rightToggle],
      ["left-close-with-right", leftToggle],
      ["left-open-with-right", leftToggle],
      ["right-close", rightToggle],
    ]) {
      const result = await measure(name!, selector!);
      samples.push(result);
      await writeFile(
        join(artifactDir, "sidebar-rich-performance.json"),
        JSON.stringify(samples, null, 2),
      );
      expect(result.tables).toBeGreaterThanOrEqual(7);
      expect(result.widthChanges).toBeGreaterThan(2);
      expect(result.sizeAnimations).toContain(200);
      expect(result.nodesRetained).toBe(true);
      expect(result.finalFollowing).toBe("true");
      expect(result.finalBottomGap).toBeLessThanOrEqual(2);
      if (!recordOnly) expect(result.tableSizeTransitions).toBe(0);
    }
    await browser.saveScreenshot(join(artifactDir, "sidebar-rich-final.png"));
  });

  it("STF06：离底阅读及快速反向保持交互", async () => {
    await browser.execute(() => {
      const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')!;
      timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
      timeline.scrollTop = Math.max(0, timeline.scrollTop - 600);
    });
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document
            .querySelector('[data-v4-timeline-scroll="true"]')
            ?.getAttribute("data-following") === "false",
      ),
    );
    for (const selector of [rightToggle, rightToggle, leftToggle, leftToggle]) {
      const result = await measure("reading", selector, true);
      expect(result.finalFollowing).toBe("false");
      expect(result.nodesRetained).toBe(true);
      expect(result.widths.at(-1)).toEqual(result.initialWidths);
      expect(Math.abs(result.finalScrollTop - result.initialScrollTop)).toBeLessThanOrEqual(2);
    }
    await clickV4TimelineBackToBottom();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document
            .querySelector('[data-v4-timeline-scroll="true"]')
            ?.getAttribute("data-following") === "true",
      ),
    );
  });
});

async function invoke(selector: string) {
  await browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)!.click(),
    selector,
  );
  await browser.executeAsync((done) => {
    const start = performance.now();
    const tick = () => (performance.now() - start >= 1000 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

async function metrics() {
  const url = await browser.getUrl();
  return browser.electron.execute(async (electron, url) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (win) => win.webContents.getURL() === url,
    )!;
    const api = target.webContents.debugger;
    if (!api.isAttached()) api.attach("1.3");
    await api.sendCommand("Performance.enable");
    const result = (await api.sendCommand("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
  }, url);
}

async function measure(name: string, selector: string, reverse = false) {
  const before = await metrics();
  const sample = (await browser.executeAsync(
    (selector, reverse, done) => {
      const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]')!;
      const tables = [...timeline.querySelectorAll("table")];
      const widths: number[][] = [];
      const readWidths = () =>
        ["#sidebar", "#browser", "#conversation-column"].map((selector) =>
          Math.round(document.querySelector(selector)!.getBoundingClientRect().width),
        );
      const initialWidths = readWidths();
      const initialScrollTop = timeline.scrollTop;
      const sizeAnimations = new Set<number>();
      const tableTransitions = new Set<Animation>();
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      const frames: number[] = [];
      const start = performance.now();
      document.querySelector<HTMLElement>(selector)!.click();
      const tick = (now: number) => {
        frames.push(now);
        widths.push(readWidths());
        for (const animation of document.getAnimations()) {
          if (!(animation instanceof CSSTransition)) continue;
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element)) continue;
          if (
            ["sidebar", "browser"].includes(effect.target.id) &&
            /^(width|flex-grow)$/.test(animation.transitionProperty)
          )
            sizeAnimations.add(Number(effect.getTiming().duration));
          if (
            effect.target.closest("[data-markdown-table-frame]") &&
            /^(width|max-width)$/.test(animation.transitionProperty)
          )
            tableTransitions.add(animation);
        }
        if (reverse && frames.length === 3) document.querySelector<HTMLElement>(selector)!.click();
        if (now - start < 1000) {
          requestAnimationFrame(tick);
          return;
        }
        longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
        observer.disconnect();
        const intervals = [
          frames[0]! - start,
          ...frames.slice(1).map((frame, index) => frame - frames[index]!),
        ];
        const sorted = [...intervals].sort((a, b) => a - b);
        done({
          firstFrameMs: frames[0]! - start,
          frameIntervals: intervals,
          frames: frames.length,
          maxFrameMs: Math.max(...intervals),
          p95FrameMs: sorted[Math.floor(sorted.length * 0.95)]!,
          longTaskCount: longTasks.length,
          longTaskMs: longTasks.reduce((a, b) => a + b, 0),
          widthChanges: widths.filter(
            (width, index) =>
              index > 0 && width.some((value, i) => value !== widths[index - 1]![i]),
          ).length,
          widths,
          initialWidths,
          initialScrollTop,
          finalScrollTop: timeline.scrollTop,
          sizeAnimations: [...sizeAnimations],
          tableSizeTransitions: tableTransitions.size,
          tables: tables.length,
          nodesRetained: tables.every((table) => table.isConnected),
          finalFollowing: timeline.dataset.following ?? "missing",
          finalBottomGap: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
        });
      };
      requestAnimationFrame(tick);
    },
    selector,
    reverse,
  )) as {
    firstFrameMs: number;
    frameIntervals: number[];
    frames: number;
    maxFrameMs: number;
    p95FrameMs: number;
    longTaskCount: number;
    longTaskMs: number;
    widthChanges: number;
    widths: number[][];
    initialWidths: number[];
    initialScrollTop: number;
    finalScrollTop: number;
    sizeAnimations: number[];
    tableSizeTransitions: number;
    tables: number;
    nodesRetained: boolean;
    finalFollowing: string;
    finalBottomGap: number;
  };
  const after = await metrics();
  return {
    name,
    ...sample,
    layoutCount: after.LayoutCount! - before.LayoutCount!,
    layoutMs: (after.LayoutDuration! - before.LayoutDuration!) * 1000,
    styleMs: (after.RecalcStyleDuration! - before.RecalcStyleDuration!) * 1000,
    taskMs: (after.TaskDuration! - before.TaskDuration!) * 1000,
  };
}

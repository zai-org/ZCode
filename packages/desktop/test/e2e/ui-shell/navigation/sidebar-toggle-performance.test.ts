import { startElectronWindowRecording } from "#e2e/helpers/electron-window-recorder";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { clearRendererViewport, setRendererViewport } from "#e2e/helpers/renderer-viewport";

// macOS 开关没有 test id；使用两个受测语言的可访问名称，避免依赖其他功能分支的标记。
const leftToggle = 'button[aria-label="切换侧边栏"], button[aria-label="Toggle sidebar"]';
const rightToggle = '[data-testid="side-pane-toggle"]';
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/sidebar-performance",
);
const recordOnly = process.env.ZCODE_SIDEBAR_PERF_RECORD_ONLY === "1";

describe("STF 左右侧栏开关布局性能", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.waitUntil(() =>
      browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-session-lifecycle="ready"]')).some(
          (pane) => Boolean(pane.dataset.projectionSeq),
        ),
      ),
    );
    await mkdir(artifactDir, { recursive: true });
  });
  after(async () => {
    await clearRendererViewport();
    await clearAppData();
  });

  it("STF01–04：左右展开收起动画、保留工具、重内容与双主题", async () => {
    const results: Awaited<ReturnType<typeof measure>>[] = [];
    for (const [width, theme, locale] of [
      [1400, "zai-light", "zh-CN"],
      [1000, "zai-dark", "en-US"],
    ] as const) {
      await setRendererViewport(width, 900);
      await browser.execute(
        (theme, locale) => {
          const actions = (
            window as Window & {
              __testActions?: { setTheme(value: string): void; setLocale(value: string): void };
            }
          ).__testActions!;
          actions.setTheme(theme);
          actions.setLocale(locale);
        },
        theme,
        locale,
      );
      await settle();
      await browser.execute(() => {
        Object.assign(window, {
          __sidebarPerfNode: document.querySelector('[data-testid="sidebar"]'),
        });
      });
      // 底部终端共用尺寸控制 hook，必须验证收起、恢复及保留实例。
      await click('[data-testid="terminal-toggle"]');
      const terminalHeight = await $("#terminal").getSize("height");
      expect(terminalHeight).toBeGreaterThan(100);
      await browser.execute(() => {
        Object.assign(window, { __bottomTerminalPerfNode: document.querySelector("#terminal") });
      });
      await click('[data-testid="terminal-toggle"]');
      expect(await $("#terminal").getSize("height")).toBeLessThanOrEqual(1);
      await click('[data-testid="terminal-toggle"]');
      expect(
        Math.abs((await $("#terminal").getSize("height")) - terminalHeight),
      ).toBeLessThanOrEqual(2);
      expect(
        await browser.execute(
          () =>
            (window as Window & { __bottomTerminalPerfNode?: Element }).__bottomTerminalPerfNode ===
            document.querySelector("#terminal"),
        ),
      ).toBe(true);
      await click('[data-testid="terminal-toggle"]');
      for (const heavy of [false, true]) {
        if (heavy) {
          // 仅注入测试负载，真实 shell/开关/尺寸 owner 不替换；这不是会话或 provider 夹具。
          await browser.execute(() => {
            const frame = document.querySelector('[data-workspace-conversation-frame="true"]')!;
            const load = document.createElement("div");
            load.id = "sidebar-performance-load";
            load.style.cssText =
              "position:absolute;inset:60px 0 100px;overflow:auto;pointer-events:none";
            for (let i = 0; i < 800; i++) {
              const row = document.createElement("p");
              row.textContent = `${i}: ${"Layout performance fixture 中文内容 ".repeat(8)}`;
              load.append(row);
            }
            frame.append(load);
          });
        }
        const prefix = `${width}-${theme}-${heavy ? "synthetic-800" : "draft"}`;
        for (const [name, selector] of [
          ["left-close", leftToggle],
          ["left-open", leftToggle],
          ["right-open", rightToggle],
          ["left-close-with-right", leftToggle],
          ["left-open-with-right", leftToggle],
          ["right-close", rightToggle],
        ])
          results.push(await measure(`${prefix}-${name}`, selector!));
        // 两次跨帧反向操作必须取消旧帧命令，最终保持收起；随后重新展开验证恢复。
        results.push(await measure(`${prefix}-rapid-right`, rightToggle, true));
        expect((await geometry()).right).toBeLessThanOrEqual(1);
        await click(rightToggle);
        results.push(await measure(`${prefix}-rapid-right-reopen`, rightToggle, true));
        expect((await geometry()).right).toBeGreaterThan(100);
        await click(rightToggle);
        results.push(await measure(`${prefix}-rapid-left`, leftToggle, true));
        expect((await geometry()).left).toBeGreaterThan(100);
        await click(leftToggle);
        results.push(await measure(`${prefix}-rapid-left-close`, leftToggle, true));
        expect((await geometry()).left).toBeLessThanOrEqual(6);
        await click(leftToggle);
        if (heavy)
          await browser.execute(() =>
            document.getElementById("sidebar-performance-load")?.remove(),
          );
        await browser.saveScreenshot(join(artifactDir, `${prefix}.png`));
      }
      await click(rightToggle);
      await $('[data-state="active"] [data-side-pane-open-tab-item="terminal"]').click();
      await browser.waitUntil(
        async () =>
          !/New tab|新标签页/.test(
            await $('[data-side-pane-tab-id][data-state="active"]').getText(),
          ),
      );
      const tab = await $('[data-side-pane-tab-id][data-state="active"]').getAttribute(
        "data-side-pane-tab-id",
      );
      const before = await geometry();
      results.push(await measure(`${width}-terminal-close`, rightToggle));
      results.push(await measure(`${width}-terminal-restore`, rightToggle));
      expect(
        await $('[data-side-pane-tab-id][data-state="active"]').getAttribute(
          "data-side-pane-tab-id",
        ),
      ).toBe(tab);
      expect(Math.abs((await geometry()).right - before.right)).toBeLessThanOrEqual(2);
      await browser.saveScreenshot(join(artifactDir, `${width}-terminal-restored.png`));
      await click('[data-testid="side-pane-full-view-toggle"]');
      expect(
        await $("[data-side-pane-full-view-host]").getAttribute("data-side-pane-full-view-host"),
      ).toBe("floating");
      results.push(await measure(`${width}-full-view-left-close`, leftToggle));
      expect(
        await $("[data-side-pane-full-view-host]").getAttribute("data-side-pane-full-view-host"),
      ).toBe("floating");
      results.push(await measure(`${width}-full-view-left-open`, leftToggle));
      expect(
        await $("[data-side-pane-full-view-host]").getAttribute("data-side-pane-full-view-host"),
      ).toBe("floating");
      await click('[data-testid="side-pane-full-view-toggle"]');
      await click(rightToggle);
      // 下一组从新标签页开始，关闭工具沿用产品按钮。
      await click(rightToggle);
      await $('[data-side-pane-tab-id][data-state="active"] button').click();
      await settle();
      await click(rightToggle);
      await $('[data-state="active"] [data-side-pane-open-tab-item="browser"]').click();
      await browser.waitUntil(
        async () =>
          !/New tab|新标签页/.test(
            await $('[data-side-pane-tab-id][data-state="active"]').getText(),
          ),
      );
      const browserTab = await $('[data-side-pane-tab-id][data-state="active"]').getAttribute(
        "data-side-pane-tab-id",
      );
      results.push(await measure(`${width}-browser-close`, rightToggle));
      results.push(await measure(`${width}-browser-restore`, rightToggle));
      expect(
        await $('[data-side-pane-tab-id][data-state="active"]').getAttribute(
          "data-side-pane-tab-id",
        ),
      ).toBe(browserTab);
      await $('[data-side-pane-tab-id][data-state="active"] button').click();
      await browser.waitUntil(async () => (await geometry()).right <= 1);
      expect(
        await browser.execute(
          () =>
            (window as Window & { __sidebarPerfNode?: Element }).__sidebarPerfNode ===
            document.querySelector('[data-testid="sidebar"]'),
        ),
      ).toBe(true);
    }
    await setReducedMotion(true);
    try {
      for (const [name, selector] of [
        ["left-close", leftToggle],
        ["left-open", leftToggle],
        ["right-open", rightToggle],
        ["right-close", rightToggle],
      ])
        results.push(await measure(`reduced-${name}`, selector!));
    } finally {
      await setReducedMotion(false);
    }
    await writeFile(
      join(artifactDir, "sidebar-performance.json"),
      JSON.stringify({ recordOnly, results }, null, 2),
    );
    if (!recordOnly) {
      for (const result of results.filter((row) => !row.name.includes("rapid"))) {
        const left = result.name.includes("left-");
        const property = left ? "width" : "flex-grow";
        const target = left ? "sidebar" : "browser";
        const expectedTransition = `${property}: ${target}`;
        const values = result.widths.map((value) => Number(value.split(":")[left ? 0 : 1]));
        const first = result.initialWidths[left ? 0 : 1]!;
        const last = values.at(-1)!;
        if (result.name.startsWith("reduced-")) {
          expect(result.transitions).not.toContain(expectedTransition);
        } else {
          // 回归必须证明真实尺寸连续变化；瞬切或仅透明度/裁剪不能算恢复原动画。
          expect(result.transitions).toContain(expectedTransition);
          expect(result.sizeTransitionDurations).toContain(200);
          expect(
            new Set(
              values.filter((v) => v > Math.min(first, last) + 1 && v < Math.max(first, last) - 1),
            ).size,
          ).toBeGreaterThan(1);
          const direction = Math.sign(last - first);
          for (let i = 1; i < values.length; i++)
            expect((values[i]! - values[i - 1]!) * direction).toBeGreaterThanOrEqual(-2);
        }
        if (!left && !result.name.startsWith("reduced-")) {
          const expandedWidth = Math.max(first, last);
          for (let i = 0; i < values.length; i++) {
            if (values[i]! > 1 && values[i]! < expandedWidth - 2)
              expect(Math.abs(result.contentWidths[i]! - expandedWidth)).toBeLessThanOrEqual(4);
          }
        }
      }
    }
    for (const result of results) {
      expect(result.panelTransitionDuration).toBe("0s");
      expect(result.unfinishedSizeAnimations).toBe(0);
      expect(result.lockedWidth).toBe("");
      const [left, right] = result.widths.at(-1)!.split(":").map(Number);
      if (result.name.includes("left-close")) expect(left).toBeLessThanOrEqual(6);
      if (result.name.includes("left-open")) expect(left).toBeGreaterThan(100);
      if (/right-open|restore/.test(result.name)) expect(right).toBeGreaterThan(100);
      if (/right-close|terminal-close|browser-close|rapid-right$/.test(result.name))
        expect(right).toBeLessThanOrEqual(1);
    }
  });

  it("STF04：窗口缩放不触发开关动画，双主题视觉验收", async () => {
    for (const theme of ["zai-light", "zai-dark"]) {
      await setRendererViewport(1400, 900);
      await browser.execute(
        (theme) =>
          (
            window as Window & { __testActions?: { setTheme(value: string): void } }
          ).__testActions!.setTheme(theme),
        theme,
      );
      await click(rightToggle);
      const before = await geometry();
      await browser.execute(() => {
        const transitions: string[] = [];
        const listener = (event: TransitionEvent) => {
          if (
            ["sidebar", "browser"].includes((event.target as HTMLElement).id) &&
            /^(width|flex-grow)$/.test(event.propertyName)
          )
            transitions.push(event.propertyName);
        };
        document.addEventListener("transitionrun", listener);
        Object.assign(window, {
          __finishWindowResizeTrace: () => {
            document.removeEventListener("transitionrun", listener);
            return transitions;
          },
        });
      });
      // 保持会话宽于既有 480px 自动收起阈值，单独验证纯窗口 resize。
      await setRendererViewport(1320, 900);
      await settle();
      expect(Math.abs((await geometry()).right - before.right)).toBeGreaterThan(10);
      const transitions = await browser.execute(() => {
        const target = window as Window & { __finishWindowResizeTrace?: () => string[] };
        const result = target.__finishWindowResizeTrace!();
        delete target.__finishWindowResizeTrace;
        return result;
      });
      expect(transitions).toEqual([]);
      await setRendererViewport(1400, 900);
      await click(rightToggle);
      // 录屏与采样分开，避免 capturePage 的开销进入性能数字。
      const recording =
        process.env.ZCODE_E2E_RECORD_SIDEBARS === "1"
          ? await startElectronWindowRecording({
              outputPath: join(artifactDir, `sidebar-motion-${theme}.webm`),
              frameIntervalMs: 16,
              preRollDurationMs: 100,
            })
          : undefined;
      try {
        await click(leftToggle);
        await click(leftToggle);
        await click(rightToggle);
        await browser.saveScreenshot(join(artifactDir, `sidebar-expanded-${theme}.png`));
        await click(rightToggle);
      } finally {
        if (recording)
          await writeFile(
            join(artifactDir, `sidebar-motion-${theme}.json`),
            JSON.stringify(await recording.stop({ tailDurationMs: 150 }), null, 2),
          );
      }
    }
  });
});

async function click(selector: string) {
  await browser.execute((selector) => {
    const button = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (node) => node.getBoundingClientRect().width > 0,
    );
    if (!button) throw new Error(`Missing button: ${selector}`);
    button.click();
  }, selector);
  await settle();
}

function settle() {
  return browser.executeAsync((done) => {
    const start = performance.now();
    const tick = () => (performance.now() - start > 350 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

function geometry() {
  return browser.execute(() => ({
    left: document.querySelector('[data-workspace-sidebar-panel="true"]')!.getBoundingClientRect()
      .width,
    right: document.querySelector("#browser")!.getBoundingClientRect().width,
  }));
}

async function metrics() {
  const url = await browser.getUrl();
  return browser.electron.execute(async (electron, url) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (win) => win.webContents.getURL() === url,
    )!;
    const debuggerApi = target.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Performance.enable");
    const result = (await debuggerApi.sendCommand("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
  }, url);
}

async function measure(name: string, selector: string, reverse = false) {
  const before = await metrics();
  const sample = (await browser.executeAsync(
    (selector, reverse, done) => {
      const frames: number[] = [];
      const widths: string[] = [];
      const contentWidths: number[] = [];
      const transitions = new Set<string>();
      const sizeTransitionDurations = new Set<number>();
      const initialWidths = ["#sidebar", "#browser"].map((selector) =>
        Math.round(document.querySelector(selector)!.getBoundingClientRect().width),
      );
      const start = performance.now();
      const invoke = () => {
        const button = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
          (node) => node.getBoundingClientRect().width > 0,
        );
        if (!button) throw new Error(`Missing button: ${selector}`);
        button.click();
      };
      invoke();
      let reversed = false;
      const tick = (time: number) => {
        for (const animation of document.getAnimations()) {
          if (animation instanceof CSSTransition) {
            const target = (animation.effect as KeyframeEffect).target as HTMLElement;
            transitions.add(`${animation.transitionProperty}: ${target.id || target.className}`);
            if (
              /^(width|flex-grow)$/.test(animation.transitionProperty) &&
              ["sidebar", "browser"].includes(target.id)
            )
              sizeTransitionDurations.add(Number(animation.effect!.getTiming().duration));
          }
        }
        frames.push(time);
        contentWidths.push(
          document.querySelector('[data-workspace-side-frame="true"]')?.getBoundingClientRect()
            .width ?? 0,
        );
        widths.push(
          ['[data-workspace-sidebar-panel="true"]', "#browser", "#conversation-column"]
            .map((selector) =>
              Math.round(document.querySelector(selector)!.getBoundingClientRect().width),
            )
            .join(":"),
        );
        if (reverse && !reversed && frames.length === 2) {
          reversed = true;
          invoke();
        }
        if (time - start < 500) {
          requestAnimationFrame(tick);
          return;
        }
        const intervals = frames
          .slice(1)
          .map((time, i) => time - frames[i]!)
          .sort((a, b) => a - b);
        done({
          widthChanges: widths.filter((value, i) => i > 0 && value !== widths[i - 1]).length,
          widths,
          initialWidths,
          contentWidths,
          panelTransitionDuration: getComputedStyle(document.querySelector("#browser")!)
            .transitionDuration,
          sizeTransitionDurations: [...sizeTransitionDurations],
          unfinishedSizeAnimations: document
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSTransition &&
                /^(width|flex-grow)$/.test(animation.transitionProperty),
            ).length,
          lockedWidth: (document.querySelector("#browser") as HTMLElement).style.getPropertyValue(
            "--side-pane-content-width",
          ),
          frames: frames.length,
          firstFrameMs: frames[0]! - start,
          transitions: [...transitions],
          maxFrameMs: Math.max(frames[0]! - start, ...intervals),
          p95FrameMs: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
        });
      };
      requestAnimationFrame(tick);
    },
    selector,
    reverse,
  )) as {
    widthChanges: number;
    widths: string[];
    initialWidths: number[];
    contentWidths: number[];
    panelTransitionDuration: string;
    sizeTransitionDurations: number[];
    unfinishedSizeAnimations: number;
    lockedWidth: string;
    frames: number;
    firstFrameMs: number;
    transitions: string[];
    maxFrameMs: number;
    p95FrameMs: number;
  };
  const after = await metrics();
  const result = {
    name,
    ...sample,
    layoutCount: after.LayoutCount! - before.LayoutCount!,
    layoutMs: (after.LayoutDuration! - before.LayoutDuration!) * 1000,
    styleCount: after.RecalcStyleCount! - before.RecalcStyleCount!,
  };
  await writeFile(join(artifactDir, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

async function setReducedMotion(reduce: boolean) {
  const url = await browser.getUrl();
  await browser.electron.execute(
    async (electron, url, reduce) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (win) => win.webContents.getURL() === url,
      )!;
      await target.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }],
      });
    },
    url,
    reduce,
  );
}

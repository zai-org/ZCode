import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { clearRendererViewport, setRendererViewport } from "#e2e/helpers/renderer-viewport";

const artifacts = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/draft-greeting");
type Sample = { width: number; height: number; font: number; lineHeight: number; inputTop: number };
type TraceWindow = Window & { __finishGreetingTrace?: () => Sample[] };

describe("DGJ01 草稿标题适配不推动输入框回弹", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await setRendererViewport(1500, 900);
    // 上午/中午的短问候语可能无法触发缩字；只调整 renderer 时区，保持真实时钟继续运行。
    const offset = 14 - new Date().getUTCHours();
    await setRendererTimezone(`Etc/GMT${offset >= 0 ? "-" : "+"}${Math.abs(offset)}`);
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions!.setLocale("en-US");
    });
    await frames();
    await mkdir(artifacts, { recursive: true });
  });
  after(async () => {
    await browser.execute(() => (window as TraceWindow).__finishGreetingTrace?.());
    await setRendererTimezone("");
    await clearRendererViewport();
    await clearAppData();
  });

  it("左右侧栏开关和拖动期间，中英文双主题均无临时换行", async function () {
    this.timeout(120000);
    for (const theme of ["zai-light", "zai-dark"]) {
      for (const locale of ["zh-CN", "en-US"]) {
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
        await browser.waitUntil(() =>
          browser.execute(() => {
            const title = document.querySelector<HTMLElement>("[data-v4-draft-greeting]");
            const pane = title?.closest<HTMLElement>("[data-session-lifecycle]");
            return (
              title &&
              title.getBoundingClientRect().width > 0 &&
              document.fonts.status === "loaded" &&
              pane?.dataset.sessionLifecycle === "ready" &&
              pane.dataset.projectionSeq !== ""
            );
          }),
        );
        await frames();
        // 每种语言单独准备宽度；不能让英文继承中文的窄布局并把合法换行算成抖动。
        await setSidePaneOpen(true);
        await resizeGreeting(1.1);
        await setSidePaneOpen(false);
        await browser.execute(() => {
          const title = document.querySelector<HTMLElement>("[data-v4-draft-greeting]")!;
          const input = document.querySelector<HTMLElement>('[data-testid="v4-composer"]')!;
          const samples: Sample[] = [];
          // 注册顺序晚于真实组件：读取 ResizeObserver 完成字号适配后的本次绘制布局。
          const capture = () => {
            const rect = title.getBoundingClientRect(),
              style = getComputedStyle(title);
            samples.push({
              width: rect.width,
              height: rect.height,
              font: parseFloat(style.fontSize),
              lineHeight: parseFloat(style.lineHeight),
              inputTop: input.getBoundingClientRect().top,
            });
          };
          const observer = new ResizeObserver(capture);
          observer.observe(title);
          observer.observe(input);
          capture();
          (window as TraceWindow).__finishGreetingTrace = () => {
            observer.disconnect();
            capture();
            delete (window as TraceWindow).__finishGreetingTrace;
            return samples;
          };
        });
        await setSidePaneOpen(true);
        await resizeGreeting(0.85);
        for (let i = 0; i < 2; i++) {
          await browser.execute(() =>
            document
              .querySelector<HTMLElement>(
                'button[aria-label="切换侧边栏"], button[aria-label="Toggle sidebar"]',
              )!
              .click(),
          );
          await waitForPanelMotion();
        }
        await frames();
        await browser.saveScreenshot(join(artifacts, `greeting-narrow-${theme}-${locale}.png`));
        await setSidePaneOpen(false);
        await setSidePaneOpen(true);
        await setSidePaneOpen(false);
        const samples = await browser.execute(() =>
          (window as TraceWindow).__finishGreetingTrace!(),
        );
        await writeFile(
          join(artifacts, `greeting-${theme}-${locale}.json`),
          JSON.stringify(samples, null, 2),
        );
        await browser.saveScreenshot(join(artifacts, `greeting-wide-${theme}-${locale}.png`));
        expect(samples.length).toBeGreaterThan(2);
        expect(samples.some((sample) => sample.font < 30)).toBe(true);
        expect(samples.every((sample) => sample.height <= sample.lineHeight + 1)).toBe(true);
        const movement =
          Math.max(...samples.map((sample) => sample.inputTop)) -
          Math.min(...samples.map((sample) => sample.inputTop));
        expect(movement).toBeLessThanOrEqual(13);
        expect(samples.at(-1)!.font).toBe(30);
      }
    }
  });
});

async function setRendererTimezone(timezoneId: string) {
  const url = await browser.getUrl();
  await browser.electron.execute(
    async (electron, url, timezoneId) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.webContents.getURL() === url,
      );
      if (!target) throw new Error("没有找到测试所属窗口");
      const debuggerApi = target.webContents.debugger;
      if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
      await debuggerApi.sendCommand("Emulation.setTimezoneOverride", { timezoneId });
    },
    url,
    timezoneId,
  );
}

async function setSidePaneOpen(open: boolean) {
  await browser.execute((open) => {
    const visible = document.querySelector("#browser")!.getBoundingClientRect().width > 1;
    if (visible === open) return;
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="side-pane-toggle"]'))
      .find((button) => button.getBoundingClientRect().width > 0)!
      .click();
  }, open);
  await browser.waitUntil(() =>
    browser.execute(
      (open) => document.querySelector("#browser")!.getBoundingClientRect().width > 1 === open,
      open,
    ),
  );
  await waitForPanelMotion();
}

function frames() {
  return browser.executeAsync((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}

async function resizeGreeting(ratio: number) {
  const drag = await browser.execute((ratio) => {
    const title = document.querySelector<HTMLElement>("[data-v4-draft-greeting]")!;
    const range = document.createRange();
    range.selectNodeContents(title.querySelector('[aria-hidden="true"]')!);
    const natural = range.getBoundingClientRect().width;
    const content = title.closest("[data-v4-timeline-scroll]")!.firstElementChild!;
    const contentStyle = getComputedStyle(content);
    // 标题有 672px 上限；拖动距离必须基于整列可用宽度，否则宽屏下无法真正收窄标题。
    const availableWidth =
      content.getBoundingClientRect().width -
      parseFloat(contentStyle.paddingLeft) -
      parseFloat(contentStyle.paddingRight);
    const rect = document
      .querySelector("[data-workspace-side-pane-resize-handle]")!
      .getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      delta: Math.round(natural * ratio + 32 - availableWidth),
    };
  }, ratio);
  await browser.performActions([
    {
      type: "pointer",
      id: "greeting-resize",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: drag.x, y: drag.y },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", duration: 300, x: drag.x + drag.delta, y: drag.y },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  await frames();
}

async function waitForPanelMotion() {
  await frames();
  await browser.waitUntil(() =>
    browser.execute(
      () =>
        !document
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition &&
              /^(width|flex-grow)$/.test(animation.transitionProperty),
          ),
    ),
  );
}

import type { Server } from "node:http";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import {
  closeFixtureServer,
  navigateBrowser,
  startFixtureServer,
} from "#e2e/helpers/browser-design-mode";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// BU-E2E-027（docs/browser-use/2026-11-03-browser-element-screenshot-and-live-reload-spec.md）：main 取帧超时后，
// 底层 capturePage 还没结束前同一 guest 继续拒绝新请求，不叠加取帧。隐藏 / 被遮挡窗口可能迟迟不出帧，
// 这里在 main 里把该 guest 的 capturePage 换成「17 秒后才回原帧」（测试侧打桩，产品没有测试入口），
// 走真实 IPC：第一次 15 秒超时返回 capture_timeout；紧接着再请求必须是 capture_in_progress，
// 且底层只被调用一次；迟到的那次结束后才能再取帧。底层永不结束时（窗口一直隐藏/被遮挡），
// 从发起算起 2× deadline（30 秒）强制释放，之后能再取帧。

const FIXTURE_HTML = `<!doctype html><html><head><title>E2E capture timeout</title></head>
<body style="background:#fff"><h1>E2E_CAPTURE_TIMEOUT</h1></body></html>`;
const SLOW_CAPTURE_MS = 17_000;
/** 与 main 的 LATE_CAPTURE_RELEASE_MS（2 × 15 秒）一致 */
const LATE_CAPTURE_RELEASE_MS = 30_000;

let fixtureServer: Server | null = null;
let fixtureOrigin = "";

// 回执里的 error 字段改名 code 再传回：结果对象带 error 键会被 WebDriver 当成脚本错误。
type CaptureResult = { success: boolean; code?: string };

async function requestCapture(webContentsId: number): Promise<CaptureResult> {
  return (await browser.execute(async (id) => {
    const bridge = (
      window as unknown as {
        zcode: {
          captureBrowserGuestPage(payload: {
            webContentsId: number;
          }): Promise<{ success: boolean; error?: string }>;
        };
      }
    ).zcode;
    try {
      const result = await bridge.captureBrowserGuestPage({ webContentsId: id });
      return { success: result.success, code: result.error ?? "ok" };
    } catch (error) {
      return { success: false, code: `threw:${String(error)}` };
    }
  }, webContentsId)) as CaptureResult;
}

describe("BU-E2E-027：main 取帧超时后迟到的取帧结束前不叠加新的取帧", () => {
  before(async () => {
    ({ server: fixtureServer, origin: fixtureOrigin } = await startFixtureServer(
      (_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(FIXTURE_HTML);
      },
    ));
  });

  after(async () => {
    await closeFixtureServer(fixtureServer);
    fixtureServer = null;
    await clearAppData();
  });

  it("超时返回 capture_timeout；底层未结算前再请求为 capture_in_progress；结算后可再取帧", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await openFirstBrowserTab();
    await navigateBrowser(`${fixtureOrigin}/capture`, "E2E capture timeout", fixtureOrigin);
    const webContentsId = await fixtureGuestId();

    await stubCapture(webContentsId, SLOW_CAPTURE_MS);
    const first = await requestCapture(webContentsId);
    expect(first).toEqual({ success: false, code: "capture_timeout" });

    // 超时只结束了这次等待，底层取帧还在跑：同一 guest 必须继续拒绝，不能叠加第二次 capturePage。
    const second = await requestCapture(webContentsId);
    expect(second).toEqual({ success: false, code: "capture_in_progress" });
    expect(await readStubState()).toEqual({ calls: 1, settled: 0 });

    // 迟到的那次结束后释放。撤掉替身，第三次走原生 capturePage，正常取到帧。
    await browser.waitUntil(async () => (await readStubState()).settled === 1, {
      timeout: 10_000,
      timeoutMsg: "迟到的 capturePage 没有结束",
    });
    await restoreCapture(webContentsId);
    const third = await requestCapture(webContentsId);
    expect(third).toEqual({ success: true, code: "ok" });
  });

  it("底层 capturePage 永不结束：上限前一直 capture_in_progress，超过 2× deadline 强制释放后能再取帧", async function () {
    this.timeout(120_000);
    const webContentsId = await fixtureGuestId();
    await stubCapture(webContentsId, "never");
    const startedAt = Date.now();
    const first = await requestCapture(webContentsId);
    expect(first).toEqual({ success: false, code: "capture_timeout" });
    const second = await requestCapture(webContentsId);
    expect(second).toEqual({ success: false, code: "capture_in_progress" });

    // 撤掉替身后，若没有强制释放，这个 guest 会因那次永不结算的取帧一直被占住。
    await restoreCapture(webContentsId);
    await browser.pause(Math.max(0, startedAt + LATE_CAPTURE_RELEASE_MS + 1_000 - Date.now()));
    const third = await requestCapture(webContentsId);
    expect(third).toEqual({ success: true, code: "ok" });
    expect(await readStubState()).toEqual({ calls: 1, settled: 0 });
  });
});

async function fixtureGuestId(): Promise<number> {
  const id = (await browser.execute((origin) => {
    const view = Array.from(document.querySelectorAll("webview")).find((element) =>
      (element as unknown as { getURL(): string }).getURL().startsWith(origin),
    ) as unknown as { getWebContentsId(): number } | undefined;
    return view?.getWebContentsId() ?? null;
  }, fixtureOrigin)) as number | null;
  if (typeof id !== "number") throw new Error("没有找到测试页面的 guest webContents");
  return id;
}

/** main 里替换这个 guest 的 capturePage：记调用次数；delayMs 后才回真实帧，"never" 永不结算。 */
async function stubCapture(webContentsId: number, delay: number | "never"): Promise<void> {
  await browser.electron.execute(
    (electron, id, delayMs) => {
      const guest = electron.webContents.fromId(id);
      if (!guest) throw new Error("guest missing");
      const original = guest.capturePage.bind(guest);
      const state = { calls: 0, settled: 0 };
      (globalThis as { __e2eSlowCapture?: typeof state }).__e2eSlowCapture = state;
      (guest as { capturePage: () => Promise<Electron.NativeImage> }).capturePage = () => {
        state.calls += 1;
        return new Promise((resolve, reject) => {
          if (delayMs === "never") return;
          setTimeout(() => {
            original()
              .then(resolve, reject)
              .finally(() => {
                state.settled += 1;
              });
          }, delayMs);
        });
      };
    },
    webContentsId,
    delay,
  );
}

/** 去掉实例上的替身，恢复原型上的 capturePage。 */
async function restoreCapture(webContentsId: number): Promise<void> {
  await browser.electron.execute((electron, id) => {
    const guest = electron.webContents.fromId(id);
    if (guest) delete (guest as { capturePage?: unknown }).capturePage;
  }, webContentsId);
}

function readStubState(): Promise<{ calls: number; settled: number }> {
  return browser.electron.execute(
    () =>
      (globalThis as { __e2eSlowCapture?: { calls: number; settled: number } })
        .__e2eSlowCapture ?? { calls: -1, settled: -1 },
  ) as Promise<{ calls: number; settled: number }>;
}

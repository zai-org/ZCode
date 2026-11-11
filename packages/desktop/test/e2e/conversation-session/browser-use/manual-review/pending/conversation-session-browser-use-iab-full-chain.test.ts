import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PlatformChannels } from "@zcode/shared";
import {
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_SCALED_FRAME,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_BROWSER_RESPONSIVE_ZOOM_OPTION,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
  TID_BROWSER_WEBVIEW,
  TID_V4_COMPOSER_INPUT,
  TID_V4_TIMELINE,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  assertToolCallNotFailedByToolCallId,
  waitForSuccessfulToolCallByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_BROWSER_USE_IAB_FULL_CHAIN";
const FINAL_MARKER = "E2E_BROWSER_USE_IAB_DONE";
const TOOL_NAME = "mcp__node_repl__js";
const BOOTSTRAP_TOOL_CALL_ID = "toolu_e2e_browser_iab_bootstrap";
const ACTION_TOOL_CALL_ID = "toolu_e2e_browser_iab_action";
const BOOTSTRAP_RESULT_MARKER = "E2E_BROWSER_USE_IAB_BOOTSTRAP_OK";
const ACTIONABILITY_RESULT_MARKER = "E2E_BROWSER_USE_IAB_ACTIONABILITY_OK";
const BOOTSTRAP_PERMISSION_TITLE = "打开 Browser Use 测试页面";
const ACTION_PERMISSION_TITLE = "填写并截图 Browser Use 测试页面";
const FIXTURE_TITLE = "E2E Browser Use Fixture";
const SUBMITTED_TEXT = "Submitted ZCode / ZCode";
const DESKTOP_ZOOM_LEVEL_CHANGED = PlatformChannels.DesktopZoomLevelChanged;
const SHOT_MARKER = "E2E_BROWSER_USE_IAB_TURN_SHOT";
const SHOT_FINAL_MARKER = "E2E_BROWSER_USE_IAB_SHOT_DONE";
const SHOT_TOOL_CALL_ID = "toolu_e2e_browser_iab_shot_open";
const SHOT_RESULT_MARKER = "E2E_BROWSER_USE_IAB_SHOT_OPEN_OK";
const SHOT_PERMISSION_TITLE = "打开轮尾截图测试页面";
const SHOT_FOLLOW_LIVE = "E2E_BROWSER_USE_IAB_SHOT_FOLLOW_LIVE";
const SHOT_FOLLOW_COLD = "E2E_BROWSER_USE_IAB_SHOT_FOLLOW_COLD";

interface BrowserSurfaceSnapshot {
  browserPaneVisible: boolean;
  responsiveHeight: number | null;
  responsiveScale: number | null;
  responsiveWidth: number | null;
  scaledFrame: { height: number; width: number } | null;
  warningCount: number;
  webviews: Array<{
    compositorScale: number | null;
    displayed: boolean;
    height: number;
    id: number;
    layoutScale: number | null;
    src: string;
    width: number;
  }>;
  zoomValue: string | null;
}

interface GuestSnapshot {
  animatedInputValue: string;
  coveredClicks: number;
  devicePixelRatio: number;
  exists: boolean;
  height: number;
  hiddenInputValue: string;
  id: number;
  inputValue: string;
  status: string;
  title: string;
  url: string;
  width: number;
  zoomFactor: number;
}

let fixtureServer: Server | null = null;
let fixtureUrl = "";

describe("Browser Use Desktop IAB 全链 E2E", () => {
  before(async () => {
    fixtureServer = createBrowserFixtureServer();
    fixtureUrl = await listen(fixtureServer);
  });

  after(async () => {
    await setDesktopZoomLevel(0).catch(() => undefined);
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BU-E2E-001/002/005..010: 真实 IAB、输入隔离、viewport、保活和轮尾截图", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E();
    const prompt = [
      `${PROMPT_MARKER}: control the ZCode in-app browser against the supplied local fixture.`,
      `E2E_BROWSER_FIXTURE_URL:${fixtureUrl}`,
      "Inspect the form, fill Name with ZCode, submit it, take one explicit screenshot, and report the result.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, "E2E_BROWSER_FIXTURE_URL:", TOOL_NAME],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "首轮请求没有暴露 Browser Use Node REPL 工具或 fixture marker",
      60000,
    );

    await waitForToolCallBlockByToolName(TOOL_NAME, 90000);
    await waitForPermissionAndApproveOnce(BOOTSTRAP_PERMISSION_TITLE);
    await waitForSuccessfulToolCallByToolCallId(
      BOOTSTRAP_TOOL_CALL_ID,
      [BOOTSTRAP_RESULT_MARKER, "e2eBrowserTabId"],
      90000,
    );
    await waitForUpstreamRequest(
      {
        includes: [
          PROMPT_MARKER,
          BOOTSTRAP_TOOL_CALL_ID,
          BOOTSTRAP_RESULT_MARKER,
          FIXTURE_TITLE,
          "Submit",
        ],
        excludes: [SUBMITTED_TEXT, "Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "Browser bootstrap/goto/domSnapshot 没有真实进入 provider continuation",
      90000,
    );

    await waitForPermissionAndApproveOnce(ACTION_PERMISSION_TITLE);
    const actionSurface = await waitForActiveBrowserSurface();
    const actionWebContentsId = actionSurface.webviews[0]?.id;
    expect(actionWebContentsId).toBeGreaterThan(0);
    await waitForGuestFocusedInput(
      actionWebContentsId as number,
      "cua-name-input",
      ACTION_TOOL_CALL_ID,
    );

    // 修复回归：旧 CUA type 依赖 Electron 当前焦点，网页 click 与 type 间若 Composer
    // autofocus 抢焦，文本会串进宿主。这里主动制造该时序，Browser type 仍必须只写 guest。
    const composerAtFocusSteal = await focusEmptyV4Composer();
    expect(composerAtFocusSteal.focused).toBe(true);
    expect(composerAtFocusSteal.text).toBe("");
    await waitForSuccessfulToolCallByToolCallId(
      ACTION_TOOL_CALL_ID,
      [ACTIONABILITY_RESULT_MARKER, SUBMITTED_TEXT],
      90000,
    );
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ACTION_TOOL_CALL_ID, ACTIONABILITY_RESULT_MARKER, SUBMITTED_TEXT],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "Browser locator fill/click/screenshot 结果没有进入 provider continuation",
      90000,
    );
    await waitForV4AssistantMessageContaining(FINAL_MARKER);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft",
      "Browser Use turn 完成后没有回到 idle",
      90000,
    );
    await waitForV4QueueCount(0, 90000);

    const chat = await getV4PaneSnapshot();
    expect(chat.sessionId).toBeTruthy();
    const taskId = chat.sessionId as string;
    const activeSurface = await waitForActiveBrowserSurface();
    expect(activeSurface.responsiveWidth).toBe(375);
    expect(activeSurface.responsiveHeight).toBe(667);
    expect(activeSurface.warningCount).toBe(0);
    expect(activeSurface.webviews).toHaveLength(1);
    const originalWebContentsId = activeSurface.webviews[0]?.id;
    expect(originalWebContentsId).toBeGreaterThan(0);

    const guest = await waitForGuestSnapshot(originalWebContentsId as number);
    expect(guest.url).toBe(fixtureUrl);
    expect(guest.title).toBe(FIXTURE_TITLE);
    expect(guest.inputValue).toBe("ZCode");
    expect(guest.animatedInputValue).toBe("ZCode");
    expect(guest.hiddenInputValue).toBe("");
    expect(guest.coveredClicks).toBe(0);
    expect(guest.status).toBe(SUBMITTED_TEXT);
    expect(guest.width).toBe(375);
    expect(guest.height).toBe(667);
    // 轮尾会释放 CDP，Retina 自然 DPR 随之恢复；DPR=1 由真实工具结果的
    // ACTIONABILITY_OK 条件验证，空闲阶段继续验证 CSS 尺寸与页面状态。
    expect((await readV4ComposerSnapshot()).text).toBe("");

    // 模型主动 setViewportSize 的布局收敛期不应误报；最后一个 Browser command
    // 刚结束时 operationUntil 仍有效，立即执行用户 resize，避免慢机跨过 active deadline。
    expect(activeSurface.warningCount).toBe(0);
    await setInputValueByTestIdDom(TID_BROWSER_RESPONSIVE_WIDTH_INPUT, "380");
    const warningSurface = await waitForResizeWarning();
    expect(warningSurface.warningCount).toBe(1);
    expect(warningSurface.responsiveWidth).toBe(380);

    const imagesBeforeSwitch = await waitForConversationImageFacts(3);
    expect(imagesBeforeSwitch.map((image) => image.kind)).toEqual([
      "explicit",
      "explicit",
      "turn-end",
    ]);
    await assertBrowserUseImageGalleryPreview();

    // 修复回归：切到无 tab 的 B 时 A 的 webview 必须后台保活；切回 A 时必须主动展开，
    // 不能沿用 B 的 collapsed 状态或创建新的 guest。
    await startNewV4Draft();
    const backgroundSurface = await readBrowserSurfaceSnapshot();
    expect(backgroundSurface.browserPaneVisible).toBe(false);
    expect(backgroundSurface.webviews.some((item) => item.id === originalWebContentsId)).toBe(true);
    const backgroundGuest = await waitForGuestSnapshot(originalWebContentsId as number);
    expect(backgroundGuest.status).toBe(SUBMITTED_TEXT);

    await selectV4TaskById(taskId, 30000);
    const restoredSurface = await waitForActiveBrowserSurface();
    expect(restoredSurface.webviews.some((item) => item.id === originalWebContentsId)).toBe(true);
    const restoredGuest = await waitForGuestSnapshot(originalWebContentsId as number);
    expect(restoredGuest.url).toBe(fixtureUrl);
    expect(restoredGuest.status).toBe(SUBMITTED_TEXT);

    // 越界草稿保留但不得部分应用到真实 guest。
    await setInputValueByTestIdDom(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT, "2161");
    const invalidDraft = await readResponsiveDraftSnapshot();
    expect(invalidDraft.heightInput).toBe("2161");
    expect(invalidDraft.heightAriaInvalid).toBe("true");
    expect(invalidDraft.appliedHeight).toBe(667);
    const invalidGuest = await waitForGuestSnapshot(originalWebContentsId as number);
    expect(invalidGuest.height).toBe(667);

    await setInputValueByTestIdDom(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT, "1200");
    await waitForResponsiveSize(380, 1200);
    const resizedGuest = await waitForGuestSnapshot(originalWebContentsId as number, {
      height: 1200,
      width: 380,
    });
    expect(resizedGuest.devicePixelRatio).toBe(1);

    await clickTestIdByWebDriver(TID_BROWSER_RESPONSIVE_ZOOM_SELECT);
    await clickTestIdByWebDriver(`${TID_BROWSER_RESPONSIVE_ZOOM_OPTION}-50`);
    const fiftyPercentSurface = await waitForZoomValue("50");
    expect(fiftyPercentSurface.responsiveScale).toBeCloseTo(0.5, 4);
    expect(fiftyPercentSurface.scaledFrame?.width).toBeCloseTo(190, 1);
    expect(fiftyPercentSurface.scaledFrame?.height).toBeCloseTo(600, 1);
    expect(fiftyPercentSurface.webviews[0]?.width).toBeCloseTo(190, 1);
    expect(fiftyPercentSurface.webviews[0]?.height).toBeCloseTo(600, 1);

    for (const zoomLevel of [2, -2]) {
      await setDesktopZoomLevel(zoomLevel);
      const zoomSurface = await waitForDesktopZoomSurface(zoomLevel);
      const zoomGuest = await waitForGuestSnapshot(originalWebContentsId as number, {
        height: 1200,
        width: 380,
      });
      expect(zoomGuest.devicePixelRatio).toBe(1);
      expect(zoomGuest.zoomFactor).toBeCloseTo(1, 4);
      expect(zoomSurface.responsiveWidth).toBe(380);
      expect(zoomSurface.responsiveHeight).toBe(1200);
      expect(zoomSurface.zoomValue?.replace("%", "")).toBe("50");
      expect(zoomSurface.webviews[0]?.compositorScale).toBeCloseTo(Math.pow(1.1, zoomLevel), 4);
      expect(zoomSurface.webviews[0]?.layoutScale).toBeCloseTo(
        zoomLevel < 0 ? 1 / Math.pow(1.1, zoomLevel) : 1,
        4,
      );
    }
    await setDesktopZoomLevel(0);

    // cold restart 只恢复 conversation 图片事实；IAB tab 本身不承诺跨进程恢复。
    await browser.reloadSession();
    await waitForRendererAfterReloadSession();
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(taskId, 60000);
    const imagesAfterColdRestore = await waitForConversationImageFacts(3, 60000);
    expect(imagesAfterColdRestore).toEqual(imagesBeforeSwitch);
  });

  // 修复回归：以前冷恢复把轮尾截图 part 变成一次工具调用加结果，冷恢复后的请求和 live 不同。
  // 规格见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md「测试」。
  it("BTA01/BTA05: 轮尾截图不进入模型历史，冷恢复前后截图这一轮的请求不变", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    await sendV4Prompt(
      [
        `${SHOT_MARKER}: open the supplied local fixture once in the in-app browser.`,
        `E2E_BROWSER_FIXTURE_URL:${fixtureUrl}`,
      ].join(" "),
    );
    await waitForToolCallBlockByToolName(TOOL_NAME, 90000);
    await waitForPermissionAndApproveOnce(SHOT_PERMISSION_TITLE);
    await waitForSuccessfulToolCallByToolCallId(SHOT_TOOL_CALL_ID, [SHOT_RESULT_MARKER], 90000);
    await waitForV4AssistantMessageContaining(SHOT_FINAL_MARKER);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft",
      "轮尾截图轮次完成后没有回到 idle",
      90000,
    );
    const taskId = (await getV4PaneSnapshot()).sessionId as string;
    // 轮尾截图只用于展示，界面上有这一张图。
    const imagesBeforeRestart = await waitForConversationImageFacts(1);

    await sendV4Prompt(`${SHOT_FOLLOW_LIVE} 冷恢复前续发。`);
    await waitForV4AssistantMessageContaining(`${SHOT_FOLLOW_LIVE}_DONE`);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "冷恢复前续发未结束", 90000);

    await browser.reloadSession();
    await waitForRendererAfterReloadSession();
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(taskId, 60000);
    expect(await waitForConversationImageFacts(1, 60000)).toEqual(imagesBeforeRestart);
    await sendV4Prompt(`${SHOT_FOLLOW_COLD} 冷恢复后续发。`);
    await waitForV4AssistantMessageContaining(`${SHOT_FOLLOW_COLD}_DONE`);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "冷恢复后续发未结束", 90000);

    const live = await shotFollowRequest(
      "upstream-browser-use-iab-shot-follow-live",
      SHOT_FOLLOW_LIVE,
    );
    const cold = await shotFollowRequest(
      "upstream-browser-use-iab-shot-follow-cold",
      SHOT_FOLLOW_COLD,
    );
    // 模型只调用过一次工具；轮尾截图不变成工具调用。
    expect(toolUseIds(live)).toEqual([SHOT_TOOL_CALL_ID]);
    expect(toolUseIds(cold)).toEqual([SHOT_TOOL_CALL_ID]);
    // 冷恢复后截图这一轮的消息不变。只比较 live 最后一条之前的消息：最后一条是冷恢复前续发的
    // user 消息，live 在内存历史里带内置浏览器上下文，存库只存用户原文，冷恢复后两者不同（旧问题，
    // 与轮尾截图无关）。以前截图被回放成工具调用加结果，会插在这一轮之后，前缀比较仍能发现。
    expect(JSON.stringify(live.messages.at(-1))).toContain(SHOT_FOLLOW_LIVE);
    const shotTurn = live.messages.slice(0, -1);
    expect(stripCacheControl(cold.messages.slice(0, shotTurn.length))).toEqual(
      stripCacheControl(shotTurn),
    );
  });
});

type ShotRequest = { messages: Array<{ role: string; content: unknown }> };

async function shotFollowRequest(fixtureId: string, marker: string): Promise<ShotRequest> {
  const record = (await getUpstreamRequestEvidence({ includes: [marker] })).find(
    (entry) => entry.fixtureId === fixtureId,
  );
  expect(record?.status).toBe("complete");
  return record!.requestJson as ShotRequest;
}

function toolUseIds(request: ShotRequest): string[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; id?: string }>)
          .filter((block) => block.type === "tool_use")
          .map((block) => String(block.id))
      : [],
  );
}

// 缓存断点随请求尾部移动，不属于内容。
function stripCacheControl(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, item: unknown) =>
      key === "cache_control" ? undefined : item,
    ),
  );
}

function createBrowserFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${FIXTURE_TITLE}</title>
    <style>
      html, body { margin: 0; min-height: 100%; background: rgb(24, 79, 132); color: white; }
      main { box-sizing: border-box; min-height: 100vh; padding: 32px; }
      label, button, [role=status] { display: block; margin-top: 16px; }
      .moving-input { animation: browser-e2e-jitter 120ms linear infinite alternate; }
      .covered-target { position: relative; width: 180px; }
      .covered-target button { width: 100%; }
      .covered-target .overlay { position: absolute; inset: 0; z-index: 2; background: rgba(255, 255, 255, 0.2); }
      @keyframes browser-e2e-jitter { from { transform: translateX(0); } to { transform: translateX(12px); } }
    </style>
  </head>
  <body>
    <main>
      <h1>${FIXTURE_TITLE}</h1>
      <div hidden><label>Animated Name <input id="hidden-animated-name" /></label></div>
      <label>Animated Name <input id="animated-name" class="moving-input" /></label>
      <label>CUA Name <input id="cua-name-input" /></label>
      <button aria-label="Duplicate" data-testid="candidate-a" type="button">Candidate A</button>
      <button aria-label="Duplicate" data-testid="candidate-b" type="button">Candidate B</button>
      <div class="covered-target">
        <button id="covered-button" type="button">Covered</button>
        <span class="overlay" aria-hidden="true"></span>
      </div>
      <button id="submit-button" type="button">Submit</button>
      <p role="status">Waiting</p>
    </main>
    <script>
      window.__e2eBrowserState = { coveredClicks: 0, submissions: 0 };
      document.querySelector("#covered-button").addEventListener("click", () => {
        window.__e2eBrowserState.coveredClicks += 1;
      });
      document.querySelector("#submit-button").addEventListener("click", () => {
        window.__e2eBrowserState.submissions += 1;
        document.querySelector("[role=status]").textContent =
          "Submitted " + document.querySelector("#animated-name").value +
          " / " + document.querySelector("#cua-name-input").value;
      });
    </script>
  </body>
</html>`);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Browser Use fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}/basic`;
}

async function closeServer(server: Server | null) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForActiveBrowserSurface(timeout = 60000) {
  let latest = await readBrowserSurfaceSnapshot();
  await browser.waitUntil(
    async () => {
      latest = await readBrowserSurfaceSnapshot();
      return (
        latest.browserPaneVisible &&
        latest.webviews.length === 1 &&
        latest.webviews[0]?.displayed === true &&
        latest.webviews[0]?.id > 0
      );
    },
    {
      timeout,
      timeoutMsg: `Browser pane/webview 没有进入 active: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function readBrowserSurfaceSnapshot(): Promise<BrowserSurfaceSnapshot> {
  return browser.execute(
    (viewportTestId, scaledFrameTestId, webviewTestId, zoomTestId) => {
      const isVisible = (element: HTMLElement | null) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const viewport = document.querySelector<HTMLElement>(`[data-testid="${viewportTestId}"]`);
      const scaledFrame = document.querySelector<HTMLElement>(
        `[data-testid="${scaledFrameTestId}"]`,
      );
      const zoom = document.querySelector<HTMLElement>(`[data-testid="${zoomTestId}"]`);
      const scaledFrameRect = scaledFrame?.getBoundingClientRect() ?? null;
      const webviews = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${webviewTestId}"]`),
      ).map((element) => {
        const webview = element as HTMLElement & {
          getWebContentsId?: () => number;
          src?: string;
        };
        const rect = element.getBoundingClientRect();
        const readNumber = (name: string) => {
          const value = element.getAttribute(name);
          return value === null ? null : Number(value);
        };
        return {
          compositorScale: readNumber("data-browser-compositor-scale"),
          displayed: isVisible(element),
          height: rect.height,
          id: webview.getWebContentsId?.() ?? 0,
          layoutScale: readNumber("data-browser-layout-scale"),
          src: webview.src ?? element.getAttribute("src") ?? "",
          width: rect.width,
        };
      });
      return {
        // 修复原因：旧 TID_BROWSER_PANE 已无生产挂载点，继续拿它判断会出现
        // “webview 可见但 pane 不可见”的假失败。responsive viewport 是当前
        // Browser surface 的真实可见容器，也能区分任务切换后的 collapsed 状态。
        browserPaneVisible: isVisible(viewport),
        responsiveHeight: Number(viewport?.dataset.responsiveHeight ?? "") || null,
        responsiveScale: Number(viewport?.dataset.responsiveScale ?? "") || null,
        responsiveWidth: Number(viewport?.dataset.responsiveWidth ?? "") || null,
        scaledFrame: scaledFrameRect
          ? { height: scaledFrameRect.height, width: scaledFrameRect.width }
          : null,
        warningCount: document.querySelectorAll('[data-browser-resize-warning="visible"]').length,
        webviews,
        zoomValue: zoom?.getAttribute("data-value") ?? zoom?.textContent?.trim() ?? null,
      };
    },
    TID_BROWSER_RESPONSIVE_VIEWPORT,
    TID_BROWSER_RESPONSIVE_SCALED_FRAME,
    TID_BROWSER_WEBVIEW,
    TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
  ) as Promise<BrowserSurfaceSnapshot>;
}

async function waitForGuestSnapshot(
  webContentsId: number,
  expected?: { height: number; width: number },
  timeout = 60000,
) {
  let latest: GuestSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readGuestSnapshot(webContentsId);
      return (
        latest.exists &&
        (!expected ||
          (Math.abs(latest.width - expected.width) <= 1 &&
            Math.abs(latest.height - expected.height) <= 1))
      );
    },
    {
      timeout,
      timeoutMsg: `guest ${webContentsId} 没有收敛: ${JSON.stringify(latest)}`,
    },
  );
  return latest as unknown as GuestSnapshot;
}

function readGuestSnapshot(webContentsId: number): Promise<GuestSnapshot> {
  return browser.electron.execute(async (electron, targetId) => {
    const guest = electron.webContents.fromId(targetId);
    if (!guest || guest.isDestroyed()) {
      return {
        animatedInputValue: "",
        coveredClicks: 0,
        devicePixelRatio: 0,
        exists: false,
        height: 0,
        hiddenInputValue: "",
        id: targetId,
        inputValue: "",
        status: "",
        title: "",
        url: "",
        width: 0,
        zoomFactor: 0,
      };
    }
    const page = (await guest.executeJavaScript(`({
      animatedInputValue: document.querySelector('#animated-name')?.value ?? '',
      coveredClicks: window.__e2eBrowserState?.coveredClicks ?? 0,
      devicePixelRatio: window.devicePixelRatio,
      height: window.innerHeight,
      hiddenInputValue: document.querySelector('#hidden-animated-name')?.value ?? '',
      inputValue: document.querySelector('#cua-name-input')?.value ?? '',
      status: document.querySelector('[role=status]')?.textContent ?? '',
      title: document.title,
      width: window.innerWidth
    })`)) as {
      animatedInputValue: string;
      coveredClicks: number;
      devicePixelRatio: number;
      height: number;
      hiddenInputValue: string;
      inputValue: string;
      status: string;
      title: string;
      width: number;
    };
    return {
      ...page,
      exists: true,
      id: targetId,
      url: guest.getURL(),
      zoomFactor: guest.getZoomFactor(),
    };
  }, webContentsId) as unknown as Promise<GuestSnapshot>;
}

async function waitForGuestFocusedInput(
  webContentsId: number,
  expectedId: string,
  toolCallId: string,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  let latest = "";
  while (Date.now() <= deadline) {
    // Bug 根因：WebdriverIO waitUntil 会把 predicate 抛出的工具错误当成重试信号，
    // 最后只留下焦点超时。显式轮询可让真实的 node_repl 失败立即终止用例。
    await assertToolCallNotFailedByToolCallId(toolCallId);
    latest = await browser.electron.execute((electron, targetId) => {
      const guest = electron.webContents.fromId(targetId);
      if (!guest || guest.isDestroyed()) return "";
      return guest.executeJavaScript("document.activeElement?.id ?? ''") as Promise<string>;
    }, webContentsId);
    if (latest === expectedId) return latest;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`guest 输入焦点没有收敛到 ${expectedId}: ${latest}`);
}

function readV4ComposerSnapshot() {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const bridge = (
      element as
        | (HTMLElement & {
            __zcodeLexicalInputE2E?: {
              focus: () => void;
              getText: () => string;
            };
          })
        | null
    )?.__zcodeLexicalInputE2E;
    return {
      focused: Boolean(
        element && document.activeElement && element.contains(document.activeElement),
      ),
      text: bridge?.getText() ?? null,
    };
  }, TID_V4_COMPOSER_INPUT);
}

async function focusEmptyV4Composer(timeout = 10000) {
  let latest = await readV4ComposerSnapshot();
  await browser.waitUntil(
    async () => {
      latest = await browser.execute((inputTestId) => {
        const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
        const bridge = (
          element as
            | (HTMLElement & {
                __zcodeLexicalInputE2E?: {
                  focus: () => void;
                  getText: () => string;
                };
              })
            | null
        )?.__zcodeLexicalInputE2E;
        bridge?.focus();
        return {
          focused: Boolean(
            element && document.activeElement && element.contains(document.activeElement),
          ),
          text: bridge?.getText() ?? null,
        };
      }, TID_V4_COMPOSER_INPUT);
      return latest.focused && latest.text === "";
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `宿主 Composer 没有在空草稿下抢到焦点: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

interface ConversationImageFact {
  bytes: number;
  hash: string;
  height: number;
  kind: "explicit" | "turn-end";
  mimeType: string;
  width: number;
}

async function waitForConversationImageFacts(expectedCount: number, timeout = 30000) {
  let latest: ConversationImageFact[] = [];
  let diagnostic = "not-read";
  try {
    await browser.waitUntil(
      async () => {
        const result = await browser
          .execute(
            (timelineTestId, actionTitle) => {
              const timeline = document.querySelector<HTMLElement>(
                `[data-testid="${timelineTestId}"]`,
              );
              const hash = (value: string) => {
                let result = 2_166_136_261;
                for (let index = 0; index < value.length; index += 1) {
                  result ^= value.charCodeAt(index);
                  result = Math.imul(result, 16_777_619);
                }
                return (result >>> 0).toString(16).padStart(8, "0");
              };
              const workGroupTrigger = Array.from(
                timeline?.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]') ??
                  [],
              ).find((button) => {
                const text = button.innerText.replace(/\u00a0/g, " ").trim();
                return text.startsWith("Worked for") || text.startsWith("已工作");
              });
              workGroupTrigger?.click();
              const actionRow = Array.from(
                timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
              ).find((row) =>
                (row.innerText.replace(/\u00a0/g, " ").trim() ?? "").includes(actionTitle),
              );
              const collapsedTrigger = Array.from(
                actionRow?.querySelectorAll<HTMLElement>(
                  '[role="button"][aria-expanded="false"]',
                ) ?? [],
              ).at(-1);
              collapsedTrigger?.click();
              const images = Array.from(
                timeline?.querySelectorAll<HTMLImageElement>(
                  '[data-row-id] button img[src^="data:image/"]',
                ) ?? [],
              ).map((image) => {
                const row = image.closest<HTMLElement>("[data-row-id]");
                const rowText = row?.innerText.replace(/\u00a0/g, " ").trim() ?? "";
                const mimeType = /^data:([^;,]+);base64,/iu.exec(image.src)?.[1] ?? "";
                return {
                  bytes: image.src.length,
                  hash: hash(image.src),
                  height: image.naturalHeight,
                  kind: rowText.includes(actionTitle)
                    ? ("explicit" as const)
                    : ("turn-end" as const),
                  mimeType,
                  width: image.naturalWidth,
                };
              });
              return {
                diagnostic: {
                  actionRowFound: Boolean(actionRow),
                  bodyImageCount: document.images.length,
                  collapsedTriggerFound: Boolean(collapsedTrigger),
                  imageSources: Array.from(document.images)
                    .map((image) => image.src.slice(0, 80))
                    .slice(-8),
                  rowCount: timeline?.querySelectorAll("[data-row-id]").length ?? 0,
                  timelineFound: Boolean(timeline),
                  timelineTail: timeline?.innerText.slice(-800) ?? "",
                  workGroupTriggerFound: Boolean(workGroupTrigger),
                },
                images,
              };
            },
            TID_V4_TIMELINE,
            ACTION_PERMISSION_TITLE,
          )
          .catch((error: unknown) => {
            diagnostic = `execute-error:${error instanceof Error ? error.message : String(error)}`;
            return null;
          });
        if (!result) return false;
        latest = result.images;
        diagnostic = JSON.stringify(result.diagnostic);
        return (
          latest.length === expectedCount &&
          latest.every(
            (image) =>
              image.bytes > 100 &&
              image.mimeType === "image/png" &&
              image.width > 0 &&
              image.height > 0,
          ) &&
          latest.filter((image) => image.kind === "explicit").length === expectedCount - 1 &&
          latest.filter((image) => image.kind === "turn-end").length === 1
        );
      },
      {
        timeout,
        timeoutMsg: `Node REPL/轮尾图片数量没有收敛到 ${expectedCount}`,
      },
    );
  } catch (error) {
    throw new Error(
      `Node REPL/轮尾图片数量没有收敛到 ${expectedCount}: ${JSON.stringify(latest)}; ${diagnostic}`,
      { cause: error },
    );
  }
  return latest;
}

async function assertBrowserUseImageGalleryPreview() {
  const opened = await browser.execute(
    (timelineTestId, actionTitle) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const actionRow = Array.from(
        timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).find((row) => row.innerText.includes(actionTitle));
      const gallery = actionRow?.querySelector<HTMLElement>("[data-node-repl-image-gallery]");
      const buttons = Array.from(
        gallery?.querySelectorAll<HTMLButtonElement>("[data-image-thumbnail-trigger]") ?? [],
      );
      const button = buttons[1];
      button?.click();
      return {
        count: buttons.length,
        horizontalOverflow: Boolean(gallery && gallery.scrollWidth > gallery.clientWidth + 1),
        opened: Boolean(button),
      };
    },
    TID_V4_TIMELINE,
    ACTION_PERMISSION_TITLE,
  );
  expect(opened).toEqual({
    count: 2,
    horizontalOverflow: false,
    opened: true,
  });
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(document.querySelector('[data-testid="node-repl-image-lightbox"]')),
      ),
    { timeout: 10000, timeoutMsg: "Node REPL 图片大图预览没有打开" },
  );
  const initialAlt = await browser.execute(
    () =>
      document
        .querySelector<HTMLImageElement>('[data-testid="node-repl-image-lightbox-image"]')
        ?.getAttribute("alt") ?? "",
  );
  expect(initialAlt).toMatch(/2$/u);
  await browser.keys("ArrowRight");
  const nextAlt = await browser.execute(
    () =>
      document
        .querySelector<HTMLImageElement>('[data-testid="node-repl-image-lightbox-image"]')
        ?.getAttribute("alt") ?? "",
  );
  expect(nextAlt).toMatch(/1$/u);
  await browser.keys("Escape");
  await browser.waitUntil(
    async () =>
      browser.execute(() => !document.querySelector('[data-testid="node-repl-image-lightbox"]')),
    { timeout: 10000, timeoutMsg: "Node REPL 图片大图预览没有被 Escape 关闭" },
  );
}

async function waitForResizeWarning() {
  let latest = await readBrowserSurfaceSnapshot();
  await browser.waitUntil(
    async () => {
      latest = await readBrowserSurfaceSnapshot();
      return latest.warningCount === 1;
    },
    {
      timeout: 10000,
      timeoutMsg: `用户 resize 后没有出现一次弱提示: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

function readResponsiveDraftSnapshot() {
  return browser.execute(
    (heightTestId, viewportTestId) => {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${heightTestId}"]`);
      const viewport = document.querySelector<HTMLElement>(`[data-testid="${viewportTestId}"]`);
      return {
        appliedHeight: Number(viewport?.dataset.responsiveHeight ?? "") || null,
        heightAriaInvalid: input?.getAttribute("aria-invalid") ?? null,
        heightInput: input?.value ?? null,
      };
    },
    TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
    TID_BROWSER_RESPONSIVE_VIEWPORT,
  );
}

async function waitForResponsiveSize(width: number, height: number) {
  let latest = await readBrowserSurfaceSnapshot();
  await browser.waitUntil(
    async () => {
      latest = await readBrowserSurfaceSnapshot();
      return latest.responsiveWidth === width && latest.responsiveHeight === height;
    },
    {
      timeout: 30000,
      timeoutMsg: `responsive viewport 没有收敛到 ${width}x${height}: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function waitForZoomValue(expected: string) {
  let latest = await readBrowserSurfaceSnapshot();
  await browser.waitUntil(
    async () => {
      latest = await readBrowserSurfaceSnapshot();
      return latest.zoomValue === expected || latest.zoomValue === `${expected}%`;
    },
    {
      timeout: 10000,
      timeoutMsg: `responsive zoom 没有切到 ${expected}: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function setDesktopZoomLevel(zoomLevel: number) {
  const result = await browser.electron.execute(
    (electron, channel, nextZoomLevel) => {
      const candidates = electron.BrowserWindow.getAllWindows().filter(
        (candidate) =>
          !candidate.isDestroyed() &&
          candidate.webContents.getURL().includes("/renderer/index.html"),
      );
      // 修复原因：restoreSession 启动 URL 不再携带 initialWorkspacePath，按 URL
      // 查 workspace 会漏掉健康主窗口。E2E 只接受唯一 renderer BrowserWindow，
      // 多窗口时直接失败，避免退化成 focused-window 猜测并改错窗口。
      if (candidates.length !== 1) {
        return {
          applied: false,
          candidateUrls: candidates.map((candidate) => candidate.webContents.getURL()),
        };
      }
      const target = candidates[0];
      if (!target || target.isDestroyed()) return { applied: false, candidateUrls: [] };
      target.webContents.setZoomFactor(Math.pow(1.1, nextZoomLevel));
      target.webContents.send(channel, { zoomLevel: nextZoomLevel });
      target.focus();
      return { applied: true, candidateUrls: [target.webContents.getURL()] };
    },
    DESKTOP_ZOOM_LEVEL_CHANGED,
    zoomLevel,
  );
  if (!result.applied) {
    throw new Error(
      `没有找到唯一可设置 Desktop zoom=${zoomLevel} 的窗口: ${JSON.stringify(result.candidateUrls)}`,
    );
  }
}

async function waitForDesktopZoomSurface(zoomLevel: number) {
  const expected = Math.pow(1.1, zoomLevel);
  let latest = await readBrowserSurfaceSnapshot();
  await browser.waitUntil(
    async () => {
      latest = await readBrowserSurfaceSnapshot();
      return latest.webviews.some(
        (webview) =>
          webview.compositorScale !== null && Math.abs(webview.compositorScale - expected) < 0.0001,
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `Desktop zoom=${zoomLevel} 没有同步到 Browser surface: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => {
            try {
              return new URL(target.url()).pathname.endsWith("/renderer/index.html");
            } catch {
              return false;
            }
          })
          .at(-1);
        const targetId = rendererTarget
          ? ((rendererTarget as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: "Browser Use cold restore 后没有找到 renderer target",
    },
  );
}

async function waitForPermissionAndApproveOnce(expectedTitle: string) {
  let latest = "";
  const clickMatchingAllowOnce = () =>
    browser.execute(() => {
      const listboxes = Array.from(
        document.querySelectorAll<HTMLElement>('[role="listbox"]'),
      ).filter((element) => {
        const label = element.getAttribute("aria-label")?.trim();
        return label === "Permission required" || label === "需要权限";
      });
      const options = listboxes.flatMap((listbox) =>
        Array.from(
          listbox.querySelectorAll<HTMLButtonElement>(
            'button[role="option"][data-permission-option-kind="allowOnce"]',
          ),
        ),
      );
      if (listboxes.length !== 1 || options.length !== 1) return false;
      options[0]?.click();
      return true;
    });

  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => {
        const listboxes = Array.from(
          document.querySelectorAll<HTMLElement>('[role="listbox"]'),
        ).filter((element) => {
          const label = element.getAttribute("aria-label")?.trim();
          return label === "Permission required" || label === "需要权限";
        });
        const allowOnceCount = listboxes.reduce(
          (count, element) =>
            count +
            element.querySelectorAll(
              'button[role="option"][data-permission-option-kind="allowOnce"]',
            ).length,
          0,
        );
        return {
          allowOnceCount,
          count: listboxes.length,
          text: listboxes
            .map((element) => element.parentElement?.innerText.replace(/\u00a0/g, " ").trim() ?? "")
            .join("\n"),
        };
      });
      latest = JSON.stringify(state);
      // 修复原因：V4 permission payload 只保留 toolName/summary/detail，不会把
      // node_repl 输入里的模型 title 投影到 PermissionDialog。调用方已先用固定
      // tool call/continuation 锁定阶段；这里要求唯一弹窗和唯一 allowOnce，避免
      // 退化成“随便批准第一个”而误响应并发请求。
      return state.count === 1 && state.allowOnceCount === 1;
    },
    {
      timeout: 30000,
      timeoutMsg: `Browser Use 权限请求没有出现（${expectedTitle}）: ${latest}`,
    },
  );

  expect(await clickMatchingAllowOnce()).toBe(true);
  // 修复原因：首个 tool result 后下一个权限可能在 100ms polling 间隔内立即出现。
  // 旧 helper 看到“仍有 listbox”会再次点击，实际把下一次 Browser 调用也批准了。
  // 单次 helper 只能点击一次；调用方用下一条 provider continuation 证明本次审批已生效。
}

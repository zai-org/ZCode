import { chromium, type Browser, type Page } from "playwright-core";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "#e2e/helpers/upstream-replay-server";
import { seedCustomAnthropicMessagesProvider } from "#e2e/helpers/custom-openai-provider-store";
import {
  seedTurboAgentStartupModel,
  restartIntoWorkspacePreservingProfile,
} from "#e2e/helpers/model-provider-restart";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  getV4QueueItems,
  waitForV4TimelineContaining,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

const NAME = "conversation-session-gen-ui-context";
const PAGE = join(resolveE2EStorageRoot(), "v2", "visualizations", "gen-ui-context.html");
let server: UpstreamReplayServer;
let mobileBrowser: Browser | undefined;
let mobile: Page;

describe("GUC Gen UI input context", () => {
  before(async () => {
    server = await startUpstreamReplayServer({
      artifactPath: resolve(
        process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts",
        "gen-ui-provider.json",
      ),
      fixturePaths: [resolve(`test/e2e/fixtures/upstream/conversation-session/${NAME}.json`)],
      fixtureVariables: { genUiContextPath: PAGE.replaceAll("\\", "/") },
    });
    process.env.E2E_PROVIDER_CAPTURE_PATH = server.artifactPath;
    process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
    process.env.E2E_PROVIDER_RUNTIME_BASE_URL = server.baseUrl;
    process.env.E2E_PROVIDER_EXPECTED_HOST = new URL(server.baseUrl).host;
    process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
  });

  after(async () => {
    await mobileBrowser?.close();
    await clearAppData();
    await server?.stop();
    await rm(PAGE, { force: true });
  });

  it("真实页面状态不进入队列正文，出队与冷恢复使用输入快照", async function () {
    this.timeout(360_000);
    await seedCustomAnthropicMessagesProvider({
      baseURL: server.baseUrl,
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      providerName: "Gen UI Context Fixture",
    });
    await seedTurboAgentStartupModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(dirname(PAGE), { recursive: true });
    await copyFile(resolve(`test/e2e/fixtures/fs/conversation-session/${NAME}/context.html`), PAGE);
    await sendV4Prompt("E2E_GEN_UI_CREATE");
    await waitForV4Pane(
      (s) => !s.canStop && Boolean(s.sessionId && s.sessionId !== "draft"),
      "Gen UI fixture 未完成",
    );
    await browser.waitUntil(async () => await $('[data-gen-ui-phase="ready"]').isExisting(), {
      timeout: 30_000,
      timeoutMsg: "真实 Gen UI sandbox 未就绪",
    });
    const session = await waitForV4Pane((s) => Boolean(s.sessionId), "task identity unavailable");
    const pairingUrl = await obtainUnreadPairingUrl();
    mobileBrowser = await chromium.launch({ channel: "chrome", headless: true });
    const mobileContext = await mobileBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await mobileContext.addInitScript((credentials) => {
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    mobile = await mobileContext.newPage();
    await openMobilePairingPage(mobile, pairingUrl, {
      artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
      caseMarker: NAME,
      phase: "queue",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    await showMobileTaskHome(mobile);
    for (const toggle of await mobile.getByTestId("virtual-project-toggle").all()) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    await mobile.getByTestId(testId(TID_TASK_ITEM, session.sessionId!)).first().click();
    await mobile.locator(`[data-session-id="${session.sessionId}"]`).waitFor();
    await clickPageState("entry", "GEN_UI_ENTRY");
    await sendV4Prompt("E2E_GEN_UI_HOLD");
    await waitForUpstreamNetworkRequestStarted("E2E_GEN_UI_HOLD");
    await clickPageState("queued", "GEN_UI_QUEUED");
    await sendV4Prompt("E2E_GEN_UI_QUEUE");
    await browser.waitUntil(async () => (await getV4QueueItems()).length === 1, {
      timeout: 15_000,
      timeoutMsg: "Gen UI 输入未进入真实 CLI 队列",
    });
    expect((await getV4QueueItems())[0]?.text).toContain("E2E_GEN_UI_QUEUE");
    const queueText = await browser.execute(() =>
      Array.from(document.querySelectorAll("li[data-queue-item-id]"))
        .map((el) => `${el.textContent} ${el.outerHTML}`)
        .join("\n"),
    );
    expect(queueText).not.toContain("untrusted_gen_ui_state");
    expect(queueText).not.toContain("GEN_UI_QUEUED");
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts", "gen-ui-queue.png"),
    );
    await mobile
      .locator("li[data-queue-item-id]")
      .filter({ hasText: "E2E_GEN_UI_QUEUE" })
      .waitFor();
    await assertMobileClean();
    await mobile.reload({ waitUntil: "domcontentloaded" });
    await mobile
      .locator("li[data-queue-item-id]")
      .filter({ hasText: "E2E_GEN_UI_QUEUE" })
      .waitFor();
    await assertMobileClean();
    await mobile.screenshot({
      path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "gen-ui-mobile-queue.png"),
    });
    await clickPageState("later", "GEN_UI_LATER");
    await releaseControlledReplay("gen-ui-hold");
    await waitForV4TimelineContaining("GEN_UI_QUEUE_OK");
    const pane = await waitForV4Pane((s) => !s.canStop, "Gen UI 队列未完成");
    expect(await getV4QueueItems()).toHaveLength(0);
    const queued = (await waitForUpstreamNetworkCapture("E2E_GEN_UI_QUEUE")).requestJson;
    assertRequest(queued, "E2E_GEN_UI_QUEUE");
    expect(JSON.stringify(queued)).toContain("GEN_UI_ENTRY");
    expect(JSON.stringify(queued).split("GEN_UI_QUEUED")).toHaveLength(2);
    expect(JSON.stringify(queued)).not.toContain("GEN_UI_LATER");

    await mobile.getByText("GEN_UI_QUEUE_OK", { exact: false }).first().waitFor();
    await assertMobileClean();
    await reloadElectronSessionSafely(browser);
    await selectV4TaskById(pane.sessionId!);
    await waitForV4TimelineContaining("E2E_GEN_UI_QUEUE");
    await sendV4Prompt("E2E_GEN_UI_COLD");
    await waitForV4TimelineContaining("GEN_UI_COLD_OK");
    const cold = (await waitForUpstreamNetworkCapture("E2E_GEN_UI_COLD")).requestJson;
    assertRequest(cold, "E2E_GEN_UI_COLD");
    expect(JSON.stringify(cold).split("GEN_UI_QUEUED")).toHaveLength(2);
    expect(await browser.execute(() => document.body.innerText)).not.toContain(
      "untrusted_gen_ui_state",
    );
  });
});

async function clickPageState(button: string, expected: string) {
  // 点击真实页面按钮，状态经生产 sandbox bridge 和 Host 落盘，不直接改会话投影。
  await readPage(`document.getElementById(${JSON.stringify(button)}).click()`);
  await browser.waitUntil(
    async () => (await readPage("document.body.dataset.saved")) === expected,
    { timeout: 15_000, timeoutMsg: "Gen UI widget state 未完成真实保存" },
  );
}

async function readPage(script: string) {
  const id = await browser.execute(() =>
    (
      document.querySelector("webview") as unknown as { getWebContentsId(): number }
    ).getWebContentsId(),
  );
  return browser.electron.execute(
    (electron, args) => {
      const guest = electron.webContents.fromId(args.id);
      const frame = guest?.mainFrame.frames.find((frame) => frame.url.includes("/instance/"));
      if (!frame) throw new Error("Gen UI sandbox frame unavailable");
      return frame.executeJavaScript(args.script);
    },
    { id, script },
  );
}

function assertRequest(request: unknown, prompt: string) {
  const messages = (request as { messages: Array<{ content: unknown }> }).messages;
  const blocks = messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }],
  );
  expect(blocks).toContainEqual(expect.objectContaining({ type: "text", text: prompt }));
  expect(JSON.stringify(request)).not.toContain("GEN_UI_PRIVATE_ONLY");
}

async function assertMobileClean() {
  const markup = await mobile.locator("body").innerHTML();
  expect(markup).not.toContain("untrusted_gen_ui_state");
  expect(markup).not.toContain("GEN_UI_QUEUED");
}

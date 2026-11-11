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
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// GUT：Gen UI 卡片的「调整设计」面板（TweakPanel 经 genUiTweakPanelSource 接 Gen UI 页面）。
// 页面用 window.Tweak 注册一个滑杆（标题字号 16px，10–40）。真实指针拖滑杆 → 页面 CSS 变量与标题字号跟着变；
// 「预览原始值」→ 页面回到 16px，再点一次回到改后的值；「提交设计变更」→ 上游请求带上这次改动（原值 16 → 新值）。

const NAME = "conversation-session-gen-ui-tweaks";
const PAGE = join(resolveE2EStorageRoot(), "v2", "visualizations", "gen-ui-tweaks.html");
const ORIGINAL_SIZE = 16;
let server: UpstreamReplayServer;

describe("GUT Gen UI 调整设计面板", () => {
  before(async () => {
    server = await startUpstreamReplayServer({
      artifactPath: resolve(
        process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts",
        "gen-ui-tweaks-provider.json",
      ),
      fixturePaths: [resolve(`test/e2e/fixtures/upstream/conversation-session/${NAME}.json`)],
      fixtureVariables: { genUiTweaksPath: PAGE.replaceAll("\\", "/") },
    });
    process.env.E2E_PROVIDER_CAPTURE_PATH = server.artifactPath;
    process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
    process.env.E2E_PROVIDER_RUNTIME_BASE_URL = server.baseUrl;
    process.env.E2E_PROVIDER_EXPECTED_HOST = new URL(server.baseUrl).host;
    process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
  });

  after(async () => {
    await clearAppData();
    await server?.stop();
    await rm(PAGE, { force: true });
  });

  it("拖滑杆改页面、预览原始值恢复、提交后上游请求带上改动", async function () {
    this.timeout(240_000);
    await seedCustomAnthropicMessagesProvider({
      baseURL: server.baseUrl,
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      providerName: "Gen UI Tweaks Fixture",
    });
    await seedTurboAgentStartupModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(dirname(PAGE), { recursive: true });
    await copyFile(resolve(`test/e2e/fixtures/fs/conversation-session/${NAME}/tweaks.html`), PAGE);
    await sendV4Prompt("E2E_GEN_UI_TWEAKS_CREATE");
    await waitForV4Pane(
      (s) => !s.canStop && Boolean(s.sessionId && s.sessionId !== "draft"),
      "Gen UI fixture 未完成",
    );
    await browser.waitUntil(async () => await $('[data-gen-ui-phase="ready"]').isExisting(), {
      timeout: 30_000,
      timeoutMsg: "真实 Gen UI sandbox 未就绪",
    });
    await browser.waitUntil(async () => (await readPage("document.body.dataset.size")) === "16", {
      timeout: 15_000,
      timeoutMsg: "Gen UI 页面没有跑起来",
    });

    // 页面注册滑杆后卡片出现「调整设计」，打开面板。
    const tweakToggle = $('[data-testid="gen-ui-actions"] button[aria-label="调整设计"]');
    await tweakToggle.waitForExist({
      timeout: 15_000,
      timeoutMsg: "页面注册滑杆后没有出现「调整设计」",
    });
    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="gen-ui-actions"] button[aria-label="调整设计"]',
        )
        ?.click();
    });
    const slider = $('[data-testid="gen-ui-tweaks"] input[type="range"]');
    await slider.waitForDisplayed({ timeout: 10_000, timeoutMsg: "调整设计面板里没有滑杆" });

    // 真实指针：按住滑块拖到右侧。
    const { width } = await slider.getSize();
    const startX = Math.round(((ORIGINAL_SIZE - 10) / 30) * width - width / 2);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: slider, x: startX, y: 0 })
      .down({ button: 0 })
      .move({ origin: slider, x: Math.round(width / 2) - 4, y: 0, duration: 200 })
      .up({ button: 0 })
      .perform();
    const changed = Number(await slider.getValue());
    if (!(changed > ORIGINAL_SIZE)) throw new Error(`拖动后滑杆值没有变大：${changed}`);
    await waitForPageSize(changed, "拖滑杆后页面里的字号没有跟着变");
    const fontSize = await readPage("getComputedStyle(document.getElementById('title')).fontSize");
    if (fontSize !== `${changed}px`) throw new Error(`标题实际字号 ${fontSize}，应为 ${changed}px`);

    // 预览原始值：页面回到 16px；再点一次回到改后的值。
    await clickPanelButton("预览原始值");
    await waitForPageSize(ORIGINAL_SIZE, "「预览原始值」后页面没有回到原值");
    await clickPanelButton("预览原始值");
    await waitForPageSize(changed, "关闭「预览原始值」后页面没有回到改后的值");

    // 提交：上游请求里带上这次改动（原值 → 新值）。
    await clickPanelButton("提交设计变更");
    await waitForV4TimelineContaining("GEN_UI_TWEAK_SUBMIT_OK");
    const request = JSON.stringify(
      (await waitForUpstreamNetworkCapture("with these design settings")).requestJson,
    );
    for (const part of [
      "Title size (px)",
      `\\"original\\":${ORIGINAL_SIZE}`,
      `\\"value\\":${changed}`,
    ]) {
      if (!request.includes(part)) throw new Error(`提交的上游请求里没有 ${part}`);
    }
  });
});

async function waitForPageSize(size: number, timeoutMsg: string) {
  await browser.waitUntil(
    async () => (await readPage("document.body.dataset.size")) === String(size),
    { timeout: 10_000, timeoutMsg },
  );
}

async function clickPanelButton(text: string) {
  const clicked = await browser.execute((label) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="gen-ui-tweaks"] button'),
    ).find((candidate) => candidate.textContent?.trim() === label);
    button?.click();
    return Boolean(button);
  }, text);
  if (!clicked) throw new Error(`调整设计面板里没有「${text}」`);
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

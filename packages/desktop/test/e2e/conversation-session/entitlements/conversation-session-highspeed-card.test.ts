import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { getV4ModelConfig } from "#e2e/helpers/v4-conversation";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { assertUpstreamThoughtLevelCapture } from "#e2e/helpers/upstream-capture";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareHighspeedDrawWorkspace,
  startHighspeedEntranceProbe,
  takeHighspeedEntranceProbe,
  waitForHighspeedComposer,
  waitForHighspeedComposerCleared,
  waitForHighspeedStatusTag,
} from "#e2e/helpers/highspeed-card";
import {
  getV4PaneSnapshot,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// Host Mock 场景：hit-fast（按 spec 文件注入，见 helpers/highspeed-mock-env.ts）。
const HIT_REPLY_TOKEN = "hs-card-hit-done";

async function expectThought(sessionId: string, thought: string) {
  // Node SQLite 只有同步只读入口；只读取目标会话的一行配置。
  const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    await browser.waitUntil(
      () => {
        const row = db
          .prepare(
            "SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection' ORDER BY id DESC LIMIT 1",
          )
          .get(sessionId) as { data: string } | undefined;
        return Boolean(
          row && JSON.parse(row.data).modelSelection?.options?.reasoningLevel === thought,
        );
      },
      { timeout: 10000, timeoutMsg: `Highspeed 调档未写入 Session: ${thought}` },
    );
  } finally {
    db.close();
  }
}

describe("Highspeed card E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-01/07: 抽卡恢复不重播，锁定模型仍可调档并等待 ACK", async function () {
    this.timeout(180000);

    await prepareHighspeedDrawWorkspace();

    // 发送前开始记录：draw 命中必须真的挂载扩散 Canvas，作为切回不重播断言的正向对照。
    await startHighspeedEntranceProbe();
    // Bug 根因：旧 prompt 内含回复标记，而 timelineText 包含用户消息，发送瞬间就会误判完成。
    // 回复标记只由数据面 fixture 返回（按 E2E_HIGHSPEED_CARD_HIT 命中）。
    await sendV4Prompt("E2E_HIGHSPEED_CARD_HIT: reply with the fixed hit token.");

    await waitForHighspeedComposer("抽卡命中后输入框没有进入 Highspeed 状态");
    await waitForV4TimelineContaining(HIT_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(HIT_REPLY_TOKEN),
      "Highspeed mock turn 完成后 pane 仍处于运行态",
      90000,
    );
    await waitForHighspeedStatusTag("完成态消息没有展示 Highspeed 标识");

    // draw 命中按 activation 入场播放扩散；入场方式跨 draft→session 保持，不被恢复链路改写。
    // 不断言 phase：窗口后台化时 rAF 可能节流，扩散收尾时机不属于本 case 的契约。
    const drawEntrance = await takeHighspeedEntranceProbe();
    expect(drawEntrance.entrance).toBe("activation");
    expect(drawEntrance.diffusionMounted).toBe(true);

    // 切到新草稿再切回：恢复入场从 stable 挂载，模型标识立即呈现，不重播扩散（spec §9.2）。
    const { sessionId } = await getV4PaneSnapshot();
    if (!sessionId || sessionId === "draft") {
      throw new Error("Highspeed 首轮完成后 pane 没有绑定 session");
    }
    await startNewV4Draft();
    await waitForHighspeedComposerCleared("新建草稿后输入框仍处于 Highspeed 状态");
    await startHighspeedEntranceProbe();
    await selectV4TaskById(sessionId);
    await waitForHighspeedComposer("切回 Task 后输入框没有恢复 Highspeed 状态");
    const restoreEntrance = await takeHighspeedEntranceProbe();
    expect(restoreEntrance).toEqual({
      diffusionMounted: false,
      entrance: "restore",
      modelIndicatorVisible: true,
      phase: "stable",
    });

    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("HS-E2E-07 缺少手机 fixture");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);

    // Highspeed 只锁模型身份。通过真实 RPC 门禁验证独立档位控件，不能注入草稿假装成功。
    const before = await getV4ModelConfig();
    await browser.execute(() => {
      const original = MessagePort.prototype.postMessage;
      const held: Array<() => void> = [];
      const probe = {
        count: 0,
        holding: true,
        release() {
          this.holding = false;
          held.splice(0).forEach((send) => send());
        },
        restore() {
          MessagePort.prototype.postMessage = original;
          this.release();
        },
      };
      (window as Window & { __hsConfigProbe?: typeof probe }).__hsConfigProbe = probe;
      MessagePort.prototype.postMessage = function (
        ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
      ) {
        const data = args[0];
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : null;
        const wire = bytes ? new TextDecoder().decode(bytes) : "";
        if (
          wire.includes("sendConversationCommandV4") &&
          wire.includes('"type":"switchModelConfig"')
        ) {
          probe.count++;
          if (probe.holding) {
            held.push(() => Reflect.apply(original, this, args));
            return;
          }
        }
        Reflect.apply(original, this, args);
      };
    });
    try {
      for (const width of [1280, 430]) {
        await browser.electron.execute((electron, nextWidth) => {
          const window = electron.BrowserWindow.getAllWindows().find((item) => item.isVisible());
          // 隔离 E2E 解除原生最小宽度，确保真正覆盖窄视口。
          window?.setMinimumSize(0, 0);
          window?.setSize(nextWidth, 900);
        }, width);
        await browser.waitUntil(
          () => browser.execute((expected) => window.innerWidth === expected, width),
          { timeout: 10000 },
        );
        const trigger = $('[data-testid="chat-thought-level-select-trigger"]');
        await trigger.waitForClickable();
        await trigger.click();
        await $('[data-testid="chat-thought-level-select-item-max"]').click();
        if (width === 1280) {
          await browser.waitUntil(
            () =>
              browser.execute(
                () =>
                  (window as Window & { __hsConfigProbe?: { count: number } }).__hsConfigProbe!
                    .count === 1,
              ),
            { timeout: 10000, timeoutMsg: "Highspeed 调档未发出配置命令" },
          );
          expect(await trigger.isEnabled()).toBe(false);
          expect(await trigger.getAttribute("aria-expanded")).not.toBe("true");
          await browser.keys(["Control", "t"]);
          expect(
            await browser.execute(
              () =>
                (window as Window & { __hsConfigProbe?: { count: number } }).__hsConfigProbe!.count,
            ),
          ).toBe(1);
          await browser.execute(() =>
            (
              window as Window & { __hsConfigProbe?: { release(): void } }
            ).__hsConfigProbe!.release(),
          );
        }
        await expectThought(sessionId, "max");
        await trigger.waitForClickable();
        await browser.keys(["Control", "t"]);
        await expectThought(sessionId, "low");
        const current = await getV4ModelConfig();
        expect(current.provider).toBe(before.provider);
        expect(current.model).toBe(before.model);
        expect(await $('[data-highspeed-model-indicator="true"]').isExisting()).toBe(true);
        expect(await $('[data-testid="chat-model-select-trigger"]').isExisting()).toBe(false);
      }
    } finally {
      await browser.execute(() =>
        (window as Window & { __hsConfigProbe?: { restore(): void } }).__hsConfigProbe?.restore(),
      );
      await browser.electron.execute((electron) => {
        electron.BrowserWindow.getAllWindows()
          .find((window) => window.isVisible())
          ?.setSize(1280, 900);
      });
    }

    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    const held: Array<() => void> = [];
    let holding = false;
    let configs = 0;
    const release = () => {
      holding = false;
      held.splice(0).forEach((send) => send());
    };
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
        const server = route.connectToServer();
        route.onMessage((message) => {
          const payload = JSON.parse(String(message)).payload;
          const wire =
            typeof payload?.dataBase64 === "string"
              ? Buffer.from(payload.dataBase64, "base64").toString("utf8")
              : "";
          const config =
            wire.includes("sendConversationCommandV4") &&
            wire.includes('"type":"switchModelConfig"');
          if (config) configs++;
          if (holding && config) held.push(() => server.send(message));
          else server.send(message);
        });
        server.onMessage((message) => route.send(message));
      });
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/highspeed-thought",
        caseMarker: "HS-E2E-07",
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      await showMobileTaskHome(page);
      const toggles = page.getByTestId("virtual-project-toggle");
      for (let i = 0; i < (await toggles.count()); i++) {
        const toggle = toggles.nth(i);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      }
      await page.getByTestId(`task-item-${sessionId}`).first().click();
      await page.locator('[data-highspeed-model-indicator="true"]').waitFor();
      const input = page.getByTestId("v4-composer-input");
      const marker = "E2E_HIGHSPEED_CARD_HIT_NEXT";
      await input.fill(marker);
      const trigger = page.getByTestId("chat-thought-level-select-trigger");
      holding = true;
      await trigger.click();
      await page.getByTestId("chat-thought-level-select-item-max").click();
      await browser.waitUntil(() => held.length === 1, { timeout: 10000 });
      expect(await trigger.isDisabled()).toBe(true);
      expect(await page.getByTestId("v4-composer-send").isDisabled()).toBe(true);
      await page.keyboard.press("Control+t");
      expect(configs).toBe(1);
      release();
      await expectThought(sessionId, "max");
      await browser.waitUntil(() => trigger.isEnabled(), { timeout: 10000 });
      await page.keyboard.press("Control+t");
      await expectThought(sessionId, "low");
      await browser.waitUntil(() => trigger.isEnabled(), { timeout: 10000 });
      await trigger.click();
      await page.getByTestId("chat-thought-level-select-item-max").click();
      await expectThought(sessionId, "max");
      await page.getByTestId("v4-composer-send").click();
      // 本场景保留 Coding Plan HTTPS Endpoint，实际请求在数据面代理而非普通 Provider 代理。
      const captureRoot = process.env.E2E_PROVIDER_CAPTURE_PATH;
      if (!captureRoot) throw new Error("缺少抓包目录");
      let capture: E2ENetworkCaptureRecord | undefined;
      await browser.waitUntil(
        async () => {
          const artifact = JSON.parse(
            await readFile(join(dirname(captureRoot), "coding-plan-data-plane.json"), "utf8"),
          ) as E2ENetworkCaptureArtifact;
          capture = artifact.records.find(
            (record) =>
              record.status === "complete" &&
              record.statusCode === 200 &&
              JSON.stringify(
                (record.requestJson as { messages?: unknown } | undefined)?.messages ?? [],
              ).includes(marker),
          );
          return Boolean(capture);
        },
        { timeout: 30000, timeoutMsg: "手机调档后未捕获到 Coding Plan 实际请求" },
      );
      const request = capture!.requestJson as Record<string, unknown>;
      const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
      if (artifactDir) {
        await writeFile(
          join(artifactDir, "highspeed-thought-request.json"),
          JSON.stringify(
            {
              sessionId,
              marker,
              url: capture!.url,
              statusCode: capture!.statusCode,
              model: request.model,
              thinking: request.thinking,
              output_config: request.output_config,
            },
            null,
            2,
          ),
        );
      }
      assertUpstreamThoughtLevelCapture(capture!, "max");
      await browser.waitUntil(() => page.getByTestId("v4-composer-send").isVisible(), {
        timeout: 30000,
      });
    } finally {
      release();
      await chrome.close();
    }
  });
});

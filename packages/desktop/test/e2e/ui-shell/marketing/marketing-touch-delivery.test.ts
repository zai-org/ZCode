import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS, marketingPopupSchema } from "@zcode/shared";
import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import {
  waitForTestIdByDom,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  seedSettings,
} from "#e2e/helpers/desktop-app";

const byId = (id: string) => $(`[data-testid="${id}"]`);
// 原截图写入系统临时目录，违反运行目录隔离；统一归档到本轮报告目录。
const screenshotPath = (name: string) => {
  const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!directory) throw new Error("Missing E2E artifact directory");
  return join(directory, name);
};
const bannerAction = () =>
  byId("marketing-banner").$('button[aria-label="Open"], button[aria-label="打开"]');
const bannerClose = () =>
  byId("marketing-banner").$('button[aria-label="Close"], button[aria-label="关闭"]');
const origin = () => {
  const value = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
  if (!value) throw new Error("Missing isolated marketing fixture");
  return value;
};
async function ledger() {
  return (await (await fetch(`${origin()}/__e2e/marketing/state`)).json()) as {
    pendingQueries: number;
    events: Array<{ campaign_id: string; action_type: string }>;
    requests: string[];
    requestDetails: Array<{
      method: string;
      path: string;
      seq: string | null;
      timestamp: number;
      headers: {
        deviceMid?: string;
        language?: string;
        appVersion?: string;
        authenticated: boolean;
      };
    }>;
  };
}
let currentActionCampaignId = "";
async function deliverAction(action: unknown) {
  const response = await fetch(`${origin()}/__e2e/marketing/action-delivery`, {
    method: "POST",
    body: JSON.stringify(action),
  });
  currentActionCampaignId = ((await response.json()) as { campaignId: string }).campaignId;
  await browser.execute(() => window.dispatchEvent(new Event("online")));
  await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
  expect(await byId("cloud-content-dialog").getText()).toContain(
    `E2E actions ${currentActionCampaignId}`,
  );
}
async function connectionSettings() {
  const settings = JSON.parse(
    await readFile(join(getE2EAppDataPaths().appDataDir, "setting.json"), "utf8"),
  );
  const selections = settings.providerFamilyConnectionSelections;
  // 旧字段已删除；先验证真实快照非空，避免 undefined 与 undefined 的假通过。
  expect(selections).toBeDefined();
  expect(Object.keys(selections).length).toBeGreaterThan(0);
  return selections;
}

async function fixtureAssets() {
  return (await (await fetch(`${origin()}/__e2e/marketing/assets`)).json()) as Record<
    | "image"
    | "darkImage"
    | "invalidImage"
    | "invalidZip"
    | "bundle"
    | "faultBundle"
    | "brokenPng"
    | "brokenMp4",
    { src: string; sha256: string }
  >;
}
async function imageDataUri(asset: { src: string }) {
  const bytes = Buffer.from(await (await fetch(asset.src)).arrayBuffer());
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
async function deliverHero(hero: unknown) {
  const response = await fetch(`${origin()}/__e2e/marketing/rich-delivery`, {
    method: "POST",
    body: JSON.stringify(
      marketingPopupSchema.parse({
        layout: "v1",
        title: { format: "plaintext", content: "E2E media boundary" },
        description: { format: "plaintext", content: "Media boundary fixture" },
        hero,
        buttons: [
          { text: { format: "plaintext", content: "Close media" }, action: { type: "close" } },
        ],
      }),
    ),
  });
  const result = (await response.json()) as { campaignId: string };
  await browser.execute(() => window.dispatchEvent(new Event("online")));
  await byId("cloud-content-dialog").waitForDisplayed({ timeout: 20_000 });
  return result.campaignId;
}

describe("Marketing Touch delivery", () => {
  before(async () => {
    // 冷启动可以恢复到未选项目草稿；全局营销界面只依赖应用壳，不能把固定 cwd 当就绪条件。
    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    expect(await byId("cloud-content-preview-entry").isExisting()).toBe(false);
  });
  after(async () => {
    await fetch(`${origin()}/__e2e/marketing/release`, { method: "POST" });
  });
  beforeEach(async function () {
    const title = this.currentTest!.title;
    await fetch(`${origin()}/__e2e/marketing/reset`, {
      method: "POST",
      body: JSON.stringify({
        popup:
          title.startsWith("MTC-01/") ||
          title.startsWith("MTC-07/08:") ||
          title.startsWith("MTE-04 independent") ||
          title.startsWith("MTE-06 stale popup") ||
          title.startsWith("MTE-08:") ||
          title.startsWith("MTE-09:"),
        banner: title.startsWith("MTC-11:") || title.startsWith("MTE-06 stale banner"),
      }),
    });
    // 英文文案和请求头必须由夹具明确声明；先退出，避免旧进程的关闭写回覆盖语言。
    await quitElectronAppGracefully();
    await seedSettings({ locale: "en-US", localePreference: "en-US" });
    // 每例从真实新窗口启动；旧失败 modal、导航请求和缓存不能污染下一个 case。
    await browser.reloadSession();
    // 冷启动可以恢复到未选项目草稿；全局营销界面只依赖应用壳，不能把固定 cwd 当就绪条件。
    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    const back = $('button[aria-label="Back to workspace"]');
    if (await back.isDisplayed()) await back.click();
  });
  for (const source of ["X", "Escape", "overlay"] as const) {
    const dismiss = async () => {
      if (source === "X") {
        await byId("cloud-content-dialog").$('[data-slot="dialog-close"]').click();
      } else if (source === "Escape") {
        const focus = await browser.execute(() => ({
          tag: document.activeElement?.tagName,
          testId: document.activeElement?.getAttribute("data-testid"),
        }));
        expect(focus).not.toMatchObject({ tag: "IFRAME" });
        await browser.keys("Escape");
      } else {
        // 从遮罩边角实际点击，不调用组件回调，避免误点居中的内容。
        await browser
          .action("pointer")
          .move({ x: 8, y: 80, origin: "viewport" })
          .down()
          .up()
          .perform();
      }
      await byId("cloud-content-dialog").waitForExist({ reverse: true });
    };
    it(`MTE-04 independent ${source}: reports one cancel through the actual dismissal surface`, async () => {
      await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
      await dismiss();
      await browser.waitUntil(async () => (await ledger()).events.length === 1);
      // 再次按 Esc 不能对已关闭的投放重复上报。
      await browser.keys("Escape");
      expect((await ledger()).events).toEqual([
        { campaign_id: "independent", action_type: "cancel" },
      ]);
      expect(
        (await ledger()).requests.filter((path) => path.endsWith("/billing/claim")),
      ).toHaveLength(0);
    });
  }
  it("MTE-17 image: switches the prepared resource with the App theme", async () => {
    const assets = await fixtureAssets();
    const [light, dark] = await Promise.all([
      imageDataUri(assets.image),
      imageDataUri(assets.darkImage),
    ]);
    expect(light).not.toBe(dark);
    const campaignId = await deliverHero({
      type: "image",
      image: { default: assets.image, dark: assets.darkImage },
    });
    const initialDark = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    );
    try {
      await browser.execute(() => document.documentElement.classList.remove("dark"));
      await browser.waitUntil(
        async () => (await byId("cloud-dialog-image-hero").$("img").getAttribute("src")) === light,
      );
      await browser.execute(() => document.documentElement.classList.add("dark"));
      await browser.waitUntil(
        async () => (await byId("cloud-dialog-image-hero").$("img").getAttribute("src")) === dark,
      );
      expect(await byId("cloud-dialog-image-hero").getAttribute("data-status")).toBe("ready");
    } finally {
      await browser.execute(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        initialDark,
      );
    }
    await byId("cloud-dialog-action").click();
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    expect((await ledger()).events).toEqual([{ campaign_id: campaignId, action_type: "cancel" }]);
  });
  it("MTE-17 invalid dark image: retains the valid default resource", async () => {
    const assets = await fixtureAssets();
    const light = await imageDataUri(assets.image);
    await deliverHero({
      type: "image",
      image: { default: assets.image, dark: assets.invalidImage },
    });
    const initialDark = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    );
    try {
      await browser.execute(() => document.documentElement.classList.add("dark"));
      await browser.waitUntil(
        async () => (await byId("cloud-dialog-image-hero").$("img").getAttribute("src")) === light,
      );
      expect(await byId("cloud-dialog-image-hero").getAttribute("data-status")).toBe("ready");
    } finally {
      await browser.execute(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        initialDark,
      );
    }
    expect((await ledger()).requests).toContain("/marketing-assets/invalid.png");
  });
  async function deliverText(format: "html" | "markdown", content: string) {
    const response = await fetch(`${origin()}/__e2e/marketing/rich-delivery`, {
      method: "POST",
      body: JSON.stringify(
        marketingPopupSchema.parse({
          layout: "v1",
          hero: null,
          title: {
            format: "html",
            content: '<p><a href="https://example.com/title">Safe title</a></p>',
          },
          description: { format, content },
          buttons: [
            {
              text: {
                format: "html",
                content: '<p><a href="https://example.com/button">Close text</a></p>',
              },
              action: { type: "close" },
            },
          ],
        }),
      ),
    });
    const campaign = ((await response.json()) as { campaignId: string }).campaignId;
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
    return campaign;
  }
  it("MTE-16 security: sanitizes HTML and routes a safe link through App", async () => {
    const open = await browser.electron.mock("shell", "openExternal");
    await open.mockResolvedValue(undefined);
    try {
      const campaign = await deliverText(
        "html",
        `<script>window.e2eUnsafeExecuted=true</script><svg onload="window.e2eUnsafeExecuted=true"></svg><!-- ignored -->
        <p onclick="window.e2eUnsafeExecuted=true">Safe body</p>
        <a href="javascript:window.e2eUnsafeExecuted=true">Bad protocol</a>
        <a href="https://user:pass@example.com">Credentials</a><a href="https://[">Bad URL</a>
        <a href="https://example.com/marketing?source=e2e" title="Safe destination">Open safe link</a>`,
      );
      const description = byId("cloud-dialog-description");
      expect(await description.$$("a")).toHaveLength(1);
      expect(await description.$$("script, svg, [onclick], [onload]")).toHaveLength(0);
      expect(await description.getText()).toContain("Bad protocol");
      expect(
        await byId("cloud-content-dialog").$$('[data-slot="dialog-title"] a, button a, button p'),
      ).toHaveLength(0);
      expect(
        await browser.execute(() =>
          Boolean((window as typeof window & { e2eUnsafeExecuted?: boolean }).e2eUnsafeExecuted),
        ),
      ).toBe(false);
      expect((await ledger()).events).toEqual([]);
      const queriesBefore = (await ledger()).requests.filter(
        (path) => path === "/api/v1/marketing/touch",
      ).length;
      await description.$("a").click();
      await browser.waitUntil(async () => {
        await open.update();
        return open.mock.calls.length === 1;
      });
      expect(open.mock.calls[0]?.[0]).toBe("https://example.com/marketing?source=e2e");
      await byId("cloud-content-dialog").waitForExist({ reverse: true });
      await browser.waitUntil(async () => (await ledger()).events.length === 1);
      expect((await ledger()).events).toEqual([{ campaign_id: campaign, action_type: "confirm" }]);
      // 外链不改变领取资格，不应与 confirm 并发查询、重新打开旧投放。
      expect(
        (await ledger()).requests.filter((path) => path === "/api/v1/marketing/touch").length,
      ).toBe(queriesBefore);
    } finally {
      await browser.electron.restoreAllMocks();
    }
  });
  it("MTE-16 markdown: renders structure but keeps embedded HTML literal", async () => {
    await deliverText(
      "markdown",
      "# Heading\n\n- First\n- Second\n\n<strong>Literal HTML</strong>",
    );
    const description = byId("cloud-dialog-description");
    expect(await description.$("h1").getText()).toBe("Heading");
    expect(await description.$$("li")).toHaveLength(2);
    expect(await description.$$("strong")).toHaveLength(0);
    expect(await description.getText()).toContain("<strong>Literal HTML</strong>");
    expect((await ledger()).events).toEqual([]);
  });
  it("MTE-16 deep HTML: falls back to literal text beyond depth limit", async () => {
    const html = "<span>".repeat(34) + "Deep content" + "</span>".repeat(34);
    await deliverText("html", html);
    const description = byId("cloud-dialog-description");
    expect(await description.getText()).toBe(html);
    expect(await description.$$("span")).toHaveLength(0);
    expect((await ledger()).events).toEqual([]);
  });
  for (const surface of ["banner", "popup"] as const) {
    it(`MTE-06 stale ${surface}: ignores pre-close response and accepts fresh redelivery`, async () => {
      const content = byId(surface === "banner" ? "marketing-banner" : "cloud-content-dialog");
      await content.waitForDisplayed({ timeout: 15_000 });
      const control = async (action: string) => {
        expect(
          (await fetch(`${origin()}/__e2e/marketing/query-${action}`, { method: "POST" })).ok,
        ).toBe(true);
      };
      const queries = async () =>
        (await ledger()).requests.filter((p) => p === "/api/v1/marketing/touch").length;
      await control("hold");
      try {
        await browser.execute(() => window.dispatchEvent(new Event("online")));
        await browser.waitUntil(async () => (await ledger()).pendingQueries === 1);
        const count = await queries();
        if (surface === "banner") await bannerClose().click();
        else await content.$('[data-slot="dialog-close"]').click();
        await content.waitForExist({ reverse: true });
        await browser.waitUntil(async () => (await ledger()).events.length === 1);
        await browser.execute(() => {
          for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("online"));
        });
        expect(await queries()).toBe(count);
        await control("release-one");
        await browser.waitUntil(
          async () => (await queries()) === count + 1 && (await ledger()).pendingQueries === 1,
        );
        expect(await content.isExisting()).toBe(false);
        expect((await ledger()).events).toEqual([
          { campaign_id: surface === "banner" ? "banner-1" : "independent", action_type: "cancel" },
        ]);
      } finally {
        await control("release-all");
      }
      await fetch(`${origin()}/__e2e/marketing/redeliver-${surface}`, { method: "POST" });
      await browser.execute(() => window.dispatchEvent(new Event("online")));
      await content.waitForDisplayed({ timeout: 15_000 });
      expect((await ledger()).events).toHaveLength(1);
    });
  }
  it("MTE-06 stale prepared bundle is discarded after popup close", async () => {
    await deliverAction({ type: "close" });
    const closedCampaign = currentActionCampaignId;
    const control = (name: string) =>
      fetch(`${origin()}/__e2e/marketing/${name}`, { method: "POST" });
    await control("asset-hold");
    try {
      await control("bundle-banner");
      await browser.execute(() => window.dispatchEvent(new Event("online")));
      await browser.waitUntil(async () => {
        const state = (await (await fetch(`${origin()}/__e2e/marketing/asset-state`)).json()) as {
          pending: number;
        };
        return state.pending === 1;
      });
      expect(await byId("marketing-banner").isExisting()).toBe(false);
      await byId("cloud-content-dialog").$('[data-slot="dialog-close"]').click();
      await byId("cloud-content-dialog").waitForExist({ reverse: true });
      await browser.waitUntil(async () => (await ledger()).events.length === 1);
      await control("query-hold");
      await browser.execute(() => window.dispatchEvent(new Event("online")));
      await control("asset-release");
      // 下一 GET 已进入服务端，证明旧资源准备已收口，不用睡眠猜测迟到结果。
      await browser.waitUntil(async () => (await ledger()).pendingQueries === 1);
      expect(await byId("marketing-banner").isExisting()).toBe(false);
      expect((await ledger()).events).toEqual([
        { campaign_id: closedCampaign, action_type: "cancel" },
      ]);
      await control("query-release-all");
      await byId("marketing-banner").waitForDisplayed({ timeout: 15_000 });
      expect(await byId("marketing-banner").$("iframe").getAttribute("data-status")).toBe("ready");
      expect((await ledger()).events).toHaveLength(1);
    } finally {
      await control("asset-release");
      await control("query-release-all");
    }
  });
  for (const kind of ["image", "video", "video-fallback"] as const) {
    it(`MTE-17 decoder ${kind}: preserves text when the browser rejects valid-signature media`, async () => {
      const assets = await fixtureAssets();
      await deliverHero(
        kind === "image"
          ? { type: "image", image: { default: assets.brokenPng } }
          : {
              type: "video",
              video: {
                src: assets.brokenMp4,
                fallback: kind === "video-fallback" ? assets.image : assets.brokenPng,
              },
            },
      );
      expect(await byId("cloud-content-dialog").getText()).toContain("Media boundary fixture");
      expect(await byId("cloud-dialog-hero-slot").isExisting()).toBe(kind === "video-fallback");
      if (kind === "video-fallback")
        expect(await byId("cloud-dialog-hero-slot").$("img").getAttribute("src")).toBe(
          await imageDataUri(assets.image),
        );
      const path = new URL(kind === "image" ? assets.brokenPng.src : assets.brokenMp4.src).pathname;
      expect((await ledger()).requests).toContain(path);
      expect((await ledger()).events).toEqual([]);
    });
  }
  for (const mode of ["error", "silent"] as const) {
    for (const fallback of [false, true]) {
      it(`MTE-11 handshake ${mode} fallback=${fallback}`, async () => {
        const assets = await fixtureAssets();
        const campaign = await deliverHero({
          type: "bundle",
          args: { mode },
          bundle: {
            bundle: assets.faultBundle,
            entry: "index.html",
            ...(fallback ? { fallback: assets.image } : {}),
          },
        });
        const slot = byId("cloud-dialog-hero-slot");
        if (fallback) {
          await slot.$("img").waitForDisplayed({ timeout: 10_000 });
          expect(await slot.$("img").getAttribute("src")).toBe(await imageDataUri(assets.image));
        } else await byId("cloud-dialog-hero-error").waitForDisplayed({ timeout: 10_000 });
        expect(await byId("cloud-dialog-interactive-hero").isExisting()).toBe(false);
        expect((await ledger()).events).toEqual([]);
        await byId("cloud-content-dialog").$('[data-slot="dialog-close"]').click();
        await browser.waitUntil(async () => (await ledger()).events.length === 1);
        expect((await ledger()).events).toEqual([{ campaign_id: campaign, action_type: "cancel" }]);
      });
    }
  }
  it("MTE-11 wrong instance ready cannot bypass handshake timeout", async () => {
    const assets = await fixtureAssets();
    await deliverHero({
      type: "bundle",
      args: { mode: "wrong-instance" },
      bundle: { bundle: assets.faultBundle, entry: "index.html", fallback: assets.image },
    });
    const frame = byId("cloud-dialog-interactive-hero");
    await frame.waitForExist();
    await browser.switchFrame(await frame);
    try {
      await browser.waitUntil(
        async () => (await $("html").getAttribute("data-sent")) === "wrong-instance",
      );
    } finally {
      await browser.switchFrame(null);
    }
    const fallback = byId("cloud-dialog-hero-slot").$("img");
    await fallback.waitForDisplayed({ timeout: 10_000 });
    expect(await fallback.getAttribute("src")).toBe(await imageDataUri(assets.image));
    expect(await frame.isExisting()).toBe(false);
    expect((await ledger()).events).toEqual([]);
  });
  it("MTE-11 invalid messages from the actual iframe preserve ready state", async () => {
    const assets = await fixtureAssets();
    const campaign = await deliverHero({
      type: "bundle",
      bundle: { bundle: assets.bundle, entry: "index.html" },
    });
    const frame = byId("cloud-dialog-interactive-hero");
    await browser.waitUntil(async () => (await frame.getAttribute("data-status")) === "ready");
    const instanceId = await frame.getAttribute("data-instance-id");
    await browser.switchFrame(await frame);
    try {
      await browser.execute((instanceId) => {
        const base = { channel: "zcode-cloud-hero-v1", instanceId };
        for (const message of [
          null,
          { ...base, type: "error", code: "wrong-instance", instanceId: `${instanceId}-other` },
          { ...base, type: "error", code: "wrong-channel", channel: "other" },
          { ...base, type: "error", code: 42 },
          { ...base, type: "action", id: 42 },
          { ...base, type: "resize", height: Number.NaN },
          { ...base, type: "unsupported" },
        ])
          parent.postMessage(message, "*");
      }, instanceId);
    } finally {
      await browser.switchFrame(null);
    }
    // 消息来自真正的 sandbox iframe，父窗口绘制后再验证忽略结果。
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    expect(await frame.getAttribute("data-status")).toBe("ready");
    expect(await byId("cloud-dialog-hero-error").isExisting()).toBe(false);
    expect((await ledger()).events).toEqual([]);
    await byId("cloud-content-dialog").$('[data-slot="dialog-close"]').click();
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    expect((await ledger()).events).toEqual([{ campaign_id: campaign, action_type: "cancel" }]);
  });
  it("MTE-11 forged parent message cannot invalidate a ready iframe", async () => {
    const assets = await fixtureAssets();
    await deliverHero({ type: "bundle", bundle: { bundle: assets.bundle, entry: "index.html" } });
    const frame = byId("cloud-dialog-interactive-hero");
    await browser.waitUntil(async () => (await frame.getAttribute("data-status")) === "ready");
    const instanceId = await frame.getAttribute("data-instance-id");
    await browser.executeAsync((instanceId, done) => {
      window.postMessage(
        { channel: "zcode-cloud-hero-v1", instanceId, type: "error", code: "forged" },
        "*",
      );
      // 等待浏览器消息派发后的绘制，不用固定延迟代替状态同步。
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    }, instanceId);
    expect(await frame.getAttribute("data-status")).toBe("ready");
    expect(await byId("cloud-dialog-hero-error").isExisting()).toBe(false);
    expect((await ledger()).events).toEqual([]);
  });
  for (const fallback of [false, true]) {
    it(`MTE-10 invalid zip: ${fallback ? "uses the prepared fallback" : "omits the unavailable hero"}`, async () => {
      const assets = await fixtureAssets();
      const campaignId = await deliverHero({
        type: "bundle",
        bundle: {
          bundle: assets.invalidZip,
          entry: "index.html",
          ...(fallback ? { fallback: assets.image } : {}),
        },
      });
      expect(await byId("cloud-dialog-interactive-hero").isExisting()).toBe(false);
      expect(await byId("cloud-dialog-hero-slot").isExisting()).toBe(fallback);
      if (fallback)
        await browser.waitUntil(
          async () =>
            (await byId("cloud-dialog-image-hero").getAttribute("data-status")) === "ready",
        );
      expect((await ledger()).requests).toContain("/marketing-assets/invalid.zip");
      await byId("cloud-dialog-action").click();
      await browser.waitUntil(async () => (await ledger()).events.length === 1);
      expect((await ledger()).events).toEqual([{ campaign_id: campaignId, action_type: "cancel" }]);
    });
  }
  it("MTE-17 invalid default image: shows dialog text without broken media", async () => {
    const assets = await fixtureAssets();
    await deliverHero({ type: "image", image: { default: assets.invalidImage } });
    expect(await byId("cloud-dialog-hero-slot").isExisting()).toBe(false);
    expect(await byId("cloud-content-dialog").getText()).toContain("E2E media boundary");
    expect((await ledger()).requests).toContain("/marketing-assets/invalid.png");
  });
  it("MTE-08: starts seq at zero, carries required headers and does not count action reports", async () => {
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
    const queries = (state: Awaited<ReturnType<typeof ledger>>) =>
      state.requestDetails.filter((request) => request.path === "/api/v1/marketing/touch");
    const initial = queries(await ledger());
    expect(initial.length).toBeGreaterThan(0);
    expect(initial[0]?.seq).toBe("0");
    for (const request of initial) {
      expect(request.method).toBe("GET");
      expect(request.headers.deviceMid?.length).toBeGreaterThan(0);
      expect(request.headers.language).toBe("en-US");
      expect(request.headers.appVersion?.length).toBeGreaterThan(0);
      expect(request.headers.authenticated).toBe(true);
    }
    await byId("cloud-dialog-action").click();
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await browser.waitUntil(async () => queries(await ledger()).length > initial.length);
    const state = await ledger();
    expect(queries(state).map((request) => Number(request.seq))).toEqual(
      queries(state).map((_, index) => index),
    );
    const reports = state.requestDetails.filter((request) =>
      request.path.endsWith("/touch/action"),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ method: "POST", seq: null });
    expect(await byId("cloud-content-dialog").isExisting()).toBe(false);
  });
  it("MTE-09: a failed report does not block dismissal or automatically retry", async () => {
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
    await fetch(`${origin()}/__e2e/marketing/faults`, {
      method: "POST",
      body: JSON.stringify({ reportStatus: 500 }),
    });
    await byId("cloud-dialog-action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    // 用新一轮真实查询作为完成屏障：服务端仍投放同 ID，客户端可以再次显示，但不能自动重报。
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
    expect((await ledger()).events).toEqual([
      { campaign_id: "independent", action_type: "cancel" },
    ]);
    await fetch(`${origin()}/__e2e/marketing/faults`, { method: "POST", body: "{}" });
    await byId("cloud-dialog-action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await ledger()).events.length === 2);
    expect((await ledger()).events).toEqual(
      Array.from({ length: 2 }, () => ({ campaign_id: "independent", action_type: "cancel" })),
    );
  });
  it("MTE-07: recovers from query failure on online and keeps monotonic sequence", async () => {
    await fetch(`${origin()}/__e2e/marketing/faults`, {
      method: "POST",
      body: JSON.stringify({ queryStatus: 503 }),
    });
    const count = () =>
      ledger().then(
        (state) =>
          state.requestDetails.filter((request) => request.path === "/api/v1/marketing/touch")
            .length,
      );
    const before = await count();
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await browser.waitUntil(async () => (await count()) > before);
    expect(await byId("marketing-banner").isExisting()).toBe(false);
    expect(await byId("cloud-content-dialog").isExisting()).toBe(false);
    await fetch(`${origin()}/__e2e/marketing/faults`, { method: "POST", body: "{}" });
    await deliverAction({ type: "close" });
    await byId("cloud-dialog-action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    const queries = (await ledger()).requestDetails.filter(
      (request) => request.path === "/api/v1/marketing/touch",
    );
    expect(queries.map((request) => Number(request.seq))).toEqual(queries.map((_, index) => index));
  });
  it("MTC-01/07/08: opens the independent popup and reports cancel exactly once", async () => {
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 40_000 });
    expect(await byId("cloud-content-dialog").getText()).toContain("E2E independent popup");
    const closeButton = byId("cloud-content-dialog").$('[data-slot="dialog-close"]');
    const palette = await browser.execute(() => {
      const root = document.documentElement;
      const original = root.className;
      try {
        return [false, true].map((dark) => {
          root.classList.toggle("dark", dark);
          const button = document.querySelector(
            '[data-testid="cloud-content-dialog"] [data-slot="dialog-close"]',
          )!;
          const style = getComputedStyle(button);
          return { color: style.color, border: style.borderTopWidth };
        });
      } finally {
        root.className = original;
      }
    });
    expect(palette).toEqual([0, 1].map(() => ({ color: "rgb(255, 255, 255)", border: "0px" })));
    expect((await closeButton.getCSSProperty("background-color")).value).toBe("rgba(0,0,0,0.5)");
    expect((await closeButton.getCSSProperty("color")).parsed.hex).toBe("#ffffff");
    expect((await closeButton.getCSSProperty("border-top-width")).value).toBe("0px");
    await closeButton.moveTo();
    await browser.waitUntil(
      async () =>
        (await closeButton.getCSSProperty("background-color")).value === "rgba(0,0,0,0.65)",
    );
    await byId("cloud-content-dialog").$("h2").moveTo();
    await browser.waitUntil(
      async () =>
        (await closeButton.getCSSProperty("background-color")).value === "rgba(0,0,0,0.5)",
    );
    await byId("cloud-dialog-action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    expect((await ledger()).events).toEqual([
      { campaign_id: "independent", action_type: "cancel" },
    ]);
  });
  it("MTC-11: polls a closed campaign again and reports the next close", async () => {
    await byId("marketing-banner").waitForDisplayed();
    await bannerClose().click();
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    await fetch(`${origin()}/__e2e/marketing/redeliver-banner`, { method: "POST" });
    await byId("marketing-banner").waitForDisplayed({ timeout: 45_000 });
    await bannerClose().click();
    await byId("marketing-banner").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await ledger()).events.length === 2);
    expect((await ledger()).events[1]).toEqual({ campaign_id: "banner-1", action_type: "cancel" });
  });
  it("MTC-07/08: reopens and reports the same independent popup only after server redelivery", async () => {
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15000 });
    await byId("cloud-dialog-action").click();
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    await fetch(`${origin()}/__e2e/marketing/redeliver-popup`, { method: "POST" });
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15_000 });
    expect(await byId("cloud-content-dialog").getText()).toContain("E2E independent popup");
    await byId("cloud-dialog-action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await ledger()).events.length === 2);
    expect((await ledger()).events[1]).toEqual({
      campaign_id: "independent",
      action_type: "cancel",
    });
  });
  it("MTA-01: copies exact plaintext repeatedly, retains popup and reports close separately", async () => {
    const baseline = (await ledger()).events.length;
    const text = "  <b>E2E copy</b>\nsecond line  ";
    await deliverAction({ type: "copy_text", args: { text } });
    const button = byId("cloud-content-dialog").$('button[data-testid="cloud-dialog-action"]');
    expect(await button.$("svg").isExisting()).toBe(false);
    await button.click();
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 1);
    expect(await byId("cloud-content-dialog").isDisplayed()).toBe(true);
    expect(await browser.execute(() => navigator.clipboard.readText())).toBe(text);
    expect(await button.$("svg").isExisting()).toBe(false);
    await button.click();
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 2);
    await byId("cloud-content-dialog").$("button=Close campaign").click();
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 3);
    expect((await ledger()).events.slice(baseline).map((event) => event.action_type)).toEqual([
      "confirm",
      "confirm",
      "cancel",
    ]);
  });
  it("MTA-02: navigates to appearance before closing and confirming", async () => {
    const baseline = (await ledger()).events.length;
    await deliverAction({ type: "navigate", args: { page: "settings", section: "appearance" } });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 15_000 });
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 1);
    expect(await browser.execute(() => localStorage.getItem("zcode-settings-last-section"))).toBe(
      "appearance",
    );
    expect((await ledger()).events[baseline]).toEqual({
      campaign_id: currentActionCampaignId,
      action_type: "confirm",
    });
  });
  it("MTA-03: reuses settings for every supported section", async () => {
    const sections = {
      general: "general",
      appearance: "appearance",
      models: "modelProvider",
      browser: "browser",
      computer_use: "computerUse",
      memory: "memory",
      subagents: "subagents",
      plugins: "plugin",
      mcp: "mcp",
      skills: "skill",
      commands: "commands",
      hooks: "hooks",
      usage: "usage",
    };
    for (const [section, internal] of Object.entries(sections)) {
      const baseline = (await ledger()).events.length;
      await deliverAction({ type: "navigate", args: { page: "settings", section } });
      await byId("cloud-content-dialog").$("button=Run action").click();
      await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 15_000 });
      expect(await $(`[data-active-section="${internal}"]`).isDisplayed()).toBe(true);
      await browser.waitUntil(async () => (await ledger()).events.length === baseline + 1);
    }
  });
  it("MTA-04: opens marketplace and keeps failed detail navigation retryable without confirming", async () => {
    await deliverAction({ type: "navigate", args: { page: "plugin_marketplace" } });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 35_000 });
    expect(await byId("plugin-store-root").isDisplayed()).toBe(true);
    const pluginId = await byId("plugin-store-card").getAttribute("data-plugin-id");
    expect(pluginId).toContain("@");
    await deliverAction({
      type: "navigate",
      args: { page: "plugin_marketplace", plugin_id: pluginId },
    });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 35_000 });
    expect(await byId("plugin-store-root").getAttribute("data-view")).toBe("detail");
    const baseline = (await ledger()).events.length;
    await deliverAction({
      type: "navigate",
      args: { page: "plugin_marketplace", plugin_id: "not-present@not-present" },
    });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("cloud-content-dialog").$('[role="alert"]').waitForDisplayed({ timeout: 35_000 });
    expect((await ledger()).events.length).toBe(baseline);
    await byId("cloud-content-dialog").$("button=Close campaign").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
  });
  it("MTA-05: locates a model provider without switching connection and rejects missing providers", async () => {
    const before = await connectionSettings();
    await deliverAction({
      type: "navigate",
      args: {
        page: "settings",
        section: "models",
        provider_id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      },
    });
    // Start Plan 导航会把主按钮文案改为 View plan；按稳定 action 身份点击，不依赖 fixture 原文。
    await byId("cloud-content-dialog").$('[data-testid="cloud-dialog-action"]').click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 35_000 });
    expect(await $('[data-active-section="modelProvider"]').isDisplayed()).toBe(true);
    expect(await connectionSettings()).toEqual(before);
    expect(
      await $(
        `[data-testid="model-provider-nav-item-coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}"][aria-selected="true"]`,
      ).isDisplayed(),
    ).toBe(true);
    const baseline = (await ledger()).events.length;
    await deliverAction({
      type: "navigate",
      args: { page: "settings", section: "models", provider_id: "missing-provider" },
    });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("cloud-content-dialog").$('[role="alert"]').waitForDisplayed({ timeout: 35_000 });
    expect((await ledger()).events.length).toBe(baseline);
    await byId("cloud-content-dialog").$("button=Close campaign").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
  });
  it("MTE-02 custom provider navigation preserves the active connection and model", async () => {
    const connections = await connectionSettings();
    const model = await byId("chat-model-select-trigger").getAttribute("data-model-current-value");
    expect(model).not.toBeNull();
    await deliverAction({ type: "navigate", args: { page: "settings", section: "models" } });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
    await byId("model-provider-add-provider-button").click();
    await byId("model-provider-template-item-custom").click();
    const selected = $('[data-testid^="model-provider-nav-item-custom:"][aria-selected="true"]');
    await selected.waitForDisplayed({ timeout: 15_000 });
    const nodeId = await selected.getAttribute("data-testid");
    if (!nodeId) throw new Error("Custom provider navigation node is missing its id");
    const providerId = nodeId.replace("model-provider-nav-item-custom:", "");
    expect(providerId.length).toBeGreaterThan(0);
    try {
      await deliverAction({ type: "navigate", args: { page: "settings", section: "appearance" } });
      await byId("cloud-content-dialog").$("button=Run action").click();
      await byId("cloud-content-dialog").waitForExist({ reverse: true });
      const previousEvents = (await ledger()).events.length;
      await deliverAction({
        type: "navigate",
        args: { page: "settings", section: "models", provider_id: providerId },
      });
      await byId("cloud-content-dialog").$("button=Run action").click();
      await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 35_000 });
      expect(await byId(nodeId).getAttribute("aria-selected")).toBe("true");
      await byId("model-provider-base-url-input").waitForDisplayed();
      await browser.waitUntil(async () => (await ledger()).events.length === previousEvents + 1);
      expect((await ledger()).events.at(-1)).toEqual({
        campaign_id: currentActionCampaignId,
        action_type: "confirm",
      });
      expect(await connectionSettings()).toEqual(connections);
      await $('button[aria-label="Back to workspace"]').click();
      expect(await byId("chat-model-select-trigger").getAttribute("data-model-current-value")).toBe(
        model,
      );
    } finally {
      if (await byId("cloud-content-dialog").isExisting())
        await byId("cloud-content-dialog").$('[data-slot="dialog-close"]').click();
      await deliverAction({
        type: "navigate",
        args: { page: "settings", section: "models", provider_id: providerId },
      });
      await byId("cloud-content-dialog").$("button=Run action").click();
      await byId("cloud-content-dialog").waitForExist({ reverse: true, timeout: 35_000 });
      // 删除入口已收进详情「更多」菜单；旧 toolbar trash 选择器会让已通过的主断言在清理时报错。
      await byId("model-provider-actions-button").click();
      await $('[role="menuitem"]:has(svg.lucide-trash-2)').click();
      await byId("confirm-dialog-confirm").click();
      await byId(nodeId).waitForExist({ reverse: true });
    }
  });
  it("MTA-06: clipboard denial retains content and never shows copied or confirms", async () => {
    const baseline = (await ledger()).events.length;
    await deliverAction({ type: "copy_text", args: { text: "denied fixture" } });
    await browser.execute(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      });
    });
    try {
      await byId("cloud-content-dialog").$("button=Run action").click();
      await byId("cloud-content-dialog").$('[role="alert"]').waitForDisplayed();
      expect(await byId("cloud-content-dialog").$("button=Run action").isEnabled()).toBe(true);
      expect((await ledger()).events.length).toBe(baseline);
    } finally {
      await browser.execute(() => {
        Reflect.deleteProperty(navigator.clipboard, "writeText");
      });
      await byId("cloud-content-dialog").$("button=Close campaign").click();
    }
    await byId("cloud-content-dialog").waitForExist({ reverse: true });
  });
  for (const closeBeforeLate of [false, true]) {
    it(`MTE-13 clipboard timeout closed=${closeBeforeLate}: ignores late success`, async () => {
      await deliverAction({ type: "copy_text", args: { text: "E2E deferred clipboard" } });
      const campaignId = currentActionCampaignId;
      await browser.execute(() => {
        const target = window as typeof window & {
          e2eResolveCopy?: () => void;
          e2eCopyCalls?: number;
        };
        target.e2eCopyCalls = 0;
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () =>
            new Promise<void>((resolve) => {
              target.e2eCopyCalls! += 1;
              target.e2eResolveCopy = resolve;
            }),
        });
      });
      const popup = byId("cloud-content-dialog");
      try {
        await popup.$("button=Run action").click();
        await browser.waitUntil(
          async () =>
            await browser.execute(
              () => (window as typeof window & { e2eCopyCalls?: number }).e2eCopyCalls === 1,
            ),
        );
        expect(await popup.$("button=Run action").isEnabled()).toBe(false);
        await popup.$('[data-slot="dialog-close"]').click();
        expect(await popup.isDisplayed()).toBe(true);
        expect((await ledger()).events).toEqual([]);
        await popup.$('[role="alert"]').waitForDisplayed({ timeout: 15_000 });
        expect(await popup.$("button=Run action").isEnabled()).toBe(true);
        if (closeBeforeLate) {
          await popup.$('[data-slot="dialog-close"]').click();
          await popup.waitForExist({ reverse: true });
          await browser.waitUntil(async () => (await ledger()).events.length === 1);
        }
        await browser.executeAsync((done) => {
          (window as typeof window & { e2eResolveCopy?: () => void }).e2eResolveCopy?.();
          // 兑现平台 Promise 后等待微任务与真实绘制，不提前伪造 App 成功。
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        });
        expect(await popup.isExisting()).toBe(!closeBeforeLate);
        if (!closeBeforeLate) {
          expect(await popup.$("button=Run action").isEnabled()).toBe(true);
          expect(await popup.$('[role="alert"]').isDisplayed()).toBe(true);
          expect((await ledger()).events).toEqual([]);
          await popup.$('[data-slot="dialog-close"]').click();
          await browser.waitUntil(async () => (await ledger()).events.length === 1);
        }
        expect((await ledger()).events).toEqual([
          { campaign_id: campaignId, action_type: "cancel" },
        ]);
        expect(
          await browser.execute(
            () => (window as typeof window & { e2eCopyCalls?: number }).e2eCopyCalls,
          ),
        ).toBe(1);
      } finally {
        await browser.execute(() => {
          const target = window as typeof window & {
            e2eResolveCopy?: () => void;
            e2eCopyCalls?: number;
          };
          target.e2eResolveCopy?.();
          delete target.e2eResolveCopy;
          delete target.e2eCopyCalls;
          Reflect.deleteProperty(navigator.clipboard, "writeText");
        });
      }
    });
  }
  it("MTA-07: opens the existing upgrade webview and reports navigation, not purchase", async () => {
    const baseline = (await ledger()).events.length;
    await deliverAction({ type: "navigate", args: { page: "upgrade" } });
    await byId("cloud-content-dialog").$("button=Run action").click();
    await byId("coding-plan-upgrade-surface").waitForDisplayed({ timeout: 35_000 });
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 1, {
      timeout: 35_000,
    });
    expect(await byId("cloud-content-dialog").isExisting()).toBe(false);
    expect(await byId("coding-plan-embedded-webview").isDisplayed()).toBe(true);
    expect((await ledger()).events[baseline]).toEqual({
      campaign_id: currentActionCampaignId,
      action_type: "confirm",
    });
    await byId("coding-plan-upgrade-surface").$('button[aria-label="Close"]').click();
    await byId("coding-plan-upgrade-surface").waitForExist({ reverse: true });
    expect((await ledger()).events.length).toBe(baseline + 1);
  });
  for (const failure of ["network", "close", "timeout"] as const) {
    it(`MTE-15 upgrade ${failure}: restores popup and requires explicit retry`, async () => {
      const mode = (mode: string) =>
        fetch(`${origin()}/__e2e/coding-plan/webview-mode`, {
          method: "POST",
          body: JSON.stringify({ mode }),
        });
      await mode(failure === "network" ? "fail" : "hold");
      await deliverAction({ type: "navigate", args: { page: "upgrade" } });
      const campaignId = currentActionCampaignId;
      const popup = byId("cloud-content-dialog");
      const upgrade = byId("coding-plan-upgrade-surface");
      try {
        await popup.$("button=Run action").click();
        if (failure !== "network") {
          await upgrade.waitForDisplayed({ timeout: 15_000 });
          await browser.waitUntil(async () => {
            const state = (await (
              await fetch(`${origin()}/__e2e/coding-plan/webview-state`)
            ).json()) as { pending: number };
            return state.pending === 1;
          });
          expect((await ledger()).events).toEqual([]);
          if (failure === "close") await upgrade.$('button[aria-label="Close"]').click();
        }
        // 升级期间原实例被卸载；恢复应重新定位 Popup，导航失败由外层 toast 提示。
        await byId("cloud-content-dialog").waitForDisplayed({ timeout: 35_000 });
        expect(await byId("cloud-content-dialog").getText()).toContain("E2E actions");
        expect(await upgrade.isExisting()).toBe(false);
        expect(await popup.$("button=Run action").isEnabled()).toBe(true);
        expect((await ledger()).events).toEqual([]);
        await mode("ready");
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        expect((await ledger()).events).toEqual([]);
        await popup.$("button=Run action").click();
        await upgrade.waitForDisplayed({ timeout: 15_000 });
        await browser.waitUntil(async () => (await ledger()).events.length === 1, {
          timeout: 35_000,
        });
        expect((await ledger()).events).toEqual([
          { campaign_id: campaignId, action_type: "confirm" },
        ]);
        expect(await popup.isExisting()).toBe(false);
      } finally {
        await mode("ready");
        if (await upgrade.isDisplayed()) await upgrade.$('button[aria-label="Close"]').click();
      }
    });
  }
  it("MTC-BUNDLE: loads a cached ZIP banner, syncs theme/data and reports host actions", async () => {
    const baseline = (await ledger()).events.length;
    const downloads = (await ledger()).requests.filter((p) => p.endsWith("hero.zip")).length;
    const response = await fetch(`${origin()}/__e2e/marketing/bundle-banner`, { method: "POST" });
    const { campaignId } = (await response.json()) as { campaignId: string };
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("marketing-banner").waitForDisplayed({ timeout: 15000 });
    const frame = byId("marketing-banner").$("iframe");
    const leaseUrl = await frame.getAttribute("src");
    if (!leaseUrl) throw new Error("Missing bundle lease URL");
    const assets = await fixtureAssets();
    const cacheRoot = join(getE2EAppDataPaths().appDataDir, "cache", "content-bundles");
    const cacheSnapshot = async () => {
      const files = (await readdir(cacheRoot, { recursive: true })).filter((file) =>
        file.endsWith(join(assets.bundle.sha256, "index.html")),
      );
      expect(files).toHaveLength(1);
      const file = join(cacheRoot, files[0]!);
      const info = await stat(file);
      return {
        path: file,
        mtime: info.mtimeMs,
        size: info.size,
        content: await readFile(file, "utf8"),
      };
    };
    const coldCache = await cacheSnapshot();
    expect(await frame.getAttribute("data-status")).toBe("ready");
    expect(await frame.getAttribute("tabindex")).toBe("-1");
    const geometry = await browser.execute(() => {
      const f = document.querySelector('[data-testid="marketing-banner"] iframe')!;
      const bounds = f.getBoundingClientRect();
      return {
        height: bounds.height,
        background: getComputedStyle(f).backgroundColor,
        pointer: getComputedStyle(f).pointerEvents,
      };
    });
    expect(geometry.height).toBe(94);
    expect(geometry.background).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.pointer).toBe("none");
    const clipping = await browser.execute(() => {
      const button = document.querySelector('[data-testid="marketing-banner"] > button')!;
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        overflow: style.overflow,
        cornerHitsButton: document.elementFromPoint(rect.left + 1, rect.top + 1) === button,
      };
    });
    expect(clipping).toEqual({
      border: "1px",
      radius: "12px",
      overflow: "hidden",
      cornerHitsButton: false,
    });
    const original = await browser.execute(() => document.documentElement.className);
    try {
      for (const dark of [true, false]) {
        await browser.execute(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          dark,
        );
        await browser.switchFrame(await frame);
        try {
          await browser.waitUntil(() =>
            browser.execute(
              (dark) => document.documentElement.dataset.theme === (dark ? "dark" : "light"),
              dark,
            ),
          );
          // ready 表示握手完成，票券仍可能在入场翻转；数据校验不依赖可见文本提取。
          const content = await browser.execute(() => document.body.textContent ?? "");
          expect(content).toContain("321");
          expect(
            await browser.execute(() => document.getElementById("plan-name")?.textContent),
          ).toBe("E2E Bundle Banner");
          await browser.waitUntil(
            () =>
              browser.execute(
                () => !document.getElementById("ticket-flip")!.classList.contains("is-entering"),
              ),
            { timeout: 5000 },
          );
        } finally {
          await browser.switchFrame(null);
        }
      }
    } finally {
      await browser.execute((original) => {
        document.documentElement.className = original;
      }, original);
    }
    await browser.saveScreenshot(screenshotPath("marketing-bundle-banner.png"));
    // 宿主隔离了 iframe 指针，必须经真实 postMessage 转交 hover，不能放开点击隔离。
    await browser.switchFrame(await frame);
    await browser.execute(() => {
      window.addEventListener("message", (event) => {
        if (event.source === parent && event.data?.type === "hover") {
          document.body.dataset.hostHovered = String(event.data.hovered);
        }
      });
    });
    await browser.switchFrame(null);
    const expectHover = async (hovered: boolean) => {
      await browser.switchFrame(await frame);
      try {
        await browser.waitUntil(() =>
          browser.execute((value) => document.body.dataset.hostHovered === String(value), hovered),
        );
      } finally {
        await browser.switchFrame(null);
      }
    };
    await browser.action("pointer").move({ x: 8, y: 80, origin: "viewport" }).perform();
    await bannerAction().moveTo();
    await expectHover(true);
    await browser.action("pointer").move({ x: 8, y: 80, origin: "viewport" }).perform();
    await expectHover(false);
    expect((await ledger()).events.length).toBe(baseline);
    await bannerAction().click();
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 1);
    expect((await ledger()).events[baseline]).toEqual({
      campaign_id: campaignId,
      action_type: "confirm",
    });
    await bannerClose().click();
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 2);
    expect((await ledger()).events[baseline + 1]).toEqual({
      campaign_id: campaignId,
      action_type: "cancel",
    });
    // release 完成后旧 iframe URL 失效；只观测已分配 lease，不访问任意本机资源。
    await browser.waitUntil(async () => (await fetch(leaseUrl)).status === 404);
    expect((await ledger()).requests.filter((p) => p.endsWith("hero.zip"))).toHaveLength(
      downloads + 1,
    );
    // 冷加载之后重新下发同 SHA；独立 case 自己建立热缓存，不依赖前例领取结果。
    await fetch(`${origin()}/__e2e/marketing/bundle-banner`, { method: "POST" });
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("marketing-banner").waitForDisplayed({ timeout: 15000 });
    expect(await byId("marketing-banner").$("iframe").getAttribute("data-status")).toBe("ready");
    expect(await cacheSnapshot()).toEqual(coldCache);
    expect((await ledger()).requests.filter((p) => p.endsWith("hero.zip"))).toHaveLength(
      downloads + 1,
    );
  });
  it("MTC-RICH: formats title, description and buttons, then plays a video Banner", async () => {
    const response = await fetch(`${origin()}/__e2e/marketing/rich-delivery`, {
      method: "POST",
      body: JSON.stringify({
        title: { format: "html", content: '<b class="underline">Rich title</b>' },
        description: {
          format: "markdown",
          content: "## Markdown\n\n**Formatted** text\n\n- One\n- Two",
        },
        buttons: [
          { text: { format: "markdown", content: "**Close rich**" }, action: { type: "close" } },
        ],
      }),
    });
    const { campaignId } = (await response.json()) as { campaignId: string };
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15000 });
    expect(await byId("cloud-content-dialog").$("h2 b.underline").getText()).toBe("Rich title");
    expect(await byId("cloud-dialog-description").$("strong").getText()).toBe("Formatted");
    expect(await byId("cloud-dialog-description").$$("li").length).toBe(2);
    expect(await byId("cloud-dialog-action").$("strong").getText()).toBe("Close rich");
    const layouts = await browser.execute(() => {
      const root = document.documentElement;
      const original = root.className;
      const dialog = document.querySelector<HTMLElement>('[data-testid="cloud-content-dialog"]')!;
      const width = dialog.style.width;
      try {
        return ["theme-zai-light", "theme-zai-dark"].flatMap((theme) => {
          root.classList.remove("theme-zai-light", "theme-zai-dark");
          root.classList.add(theme);
          root.classList.toggle("dark", theme === "theme-zai-dark");
          return [358, 480].map((size) => {
            dialog.style.width = `${size}px`;
            const button = dialog.querySelector('[data-testid="cloud-dialog-action"]')!;
            return {
              overflow: dialog.scrollWidth > dialog.clientWidth,
              inherited:
                getComputedStyle(button).color ===
                getComputedStyle(button.querySelector("strong")!).color,
            };
          });
        });
      } finally {
        root.className = original;
        dialog.style.width = width;
      }
    });
    expect(layouts).toEqual(
      Array.from({ length: 4 }, () => ({ overflow: false, inherited: true })),
    );
    await byId("cloud-dialog-action").$("strong").click();
    await browser.waitUntil(async () =>
      (await ledger()).events.some(
        (e) => e.campaign_id === campaignId && e.action_type === "cancel",
      ),
    );

    // 素材契约只接受 MP4；在 Electron 内生成，不能用 WebM 绕过宿主格式校验。
    const video = await browser.executeAsync((done: (value: string) => void) => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d")!;
      context.fillRect(0, 0, 32, 32);
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: "video/mp4" });
      const chunks: Blob[] = [];
      // 静态画布只产一帧，MP4 时长可能为零；持续绘制以验证真正的循环播放。
      let frame = 0;
      const draw = setInterval(() => {
        context.fillStyle = `rgb(${++frame % 255}, 0, 0)`;
        context.fillRect(0, 0, 32, 32);
      }, 50);
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        clearInterval(draw);
        stream.getTracks().forEach((track) => track.stop());
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result).split(",")[1]!);
        reader.readAsDataURL(new Blob(chunks, { type: "video/mp4" }));
      };
      recorder.start();
      setTimeout(() => recorder.stop(), 500);
    });
    const delivered = await fetch(`${origin()}/__e2e/marketing/video-banner`, {
      method: "POST",
      body: JSON.stringify({ video }),
    });
    const bannerId = ((await delivered.json()) as { campaignId: string }).campaignId;
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("marketing-banner").$("video").waitForExist({ timeout: 15000 });
    try {
      await browser.waitUntil(async () =>
        browser.execute(() => {
          const video = document.querySelector<HTMLVideoElement>(
            '[data-testid="marketing-banner"] video',
          );
          return Boolean(video && video.readyState >= 2 && !video.paused);
        }),
      );
    } catch (error) {
      const state = await browser.execute(() => {
        const video = document.querySelector<HTMLVideoElement>(
          '[data-testid="marketing-banner"] video',
        );
        return {
          ready: video?.readyState,
          paused: video?.paused,
          duration: video?.duration,
          time: video?.currentTime,
          error: video?.error?.message,
          visibility: document.visibilityState,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        };
      });
      throw new Error(`Video runtime ${JSON.stringify(state)}`, { cause: error });
    }
    const media = await browser.execute(() => {
      const video = document.querySelector<HTMLVideoElement>(
        '[data-testid="marketing-banner"] video',
      )!;
      return {
        controls: video.controls,
        muted: video.muted,
        loop: video.loop,
        height: video.closest("button")!.getBoundingClientRect().height,
      };
    });
    expect(media).toEqual({ controls: false, muted: true, loop: true, height: 96 });
    const rendererUrl = await browser.getUrl();
    const puppeteer = await browser.getPuppeteer();
    const page = (await puppeteer.pages()).find((candidate) => candidate.url() === rendererUrl);
    if (!page) throw new Error("Marketing renderer page is missing for media emulation");
    const videoNode = await byId("marketing-banner").$("video");
    const eventsBeforeMotion = (await ledger()).events;
    try {
      for (const reduced of [true, false]) {
        await page.emulateMediaFeatures([
          { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" },
        ]);
        await browser.waitUntil(async () =>
          browser.execute((reduced) => {
            const video = document.querySelector<HTMLVideoElement>(
              '[data-testid="marketing-banner"] video',
            );
            return (
              matchMedia("(prefers-reduced-motion: reduce)").matches === reduced &&
              video?.paused === reduced &&
              video.autoplay === !reduced
            );
          }, reduced),
        );
        expect((await byId("marketing-banner").$("video")).elementId).toBe(videoNode.elementId);
        expect((await ledger()).events).toEqual(eventsBeforeMotion);
      }
    } finally {
      await page.emulateMediaFeatures([]);
    }
    await byId("marketing-banner").$('button[aria-label="Copy video"]').click();
    await browser.waitUntil(async () =>
      (await ledger()).events.some(
        (e) => e.campaign_id === bannerId && e.action_type === "confirm",
      ),
    );
  });

  it("MTC-HTML: server classes and inline styles render across themes and narrow layout", async () => {
    const baseline = (await ledger()).events.length;
    const response = await fetch(`${origin()}/__e2e/marketing/html-delivery`, {
      method: "POST",
      body: JSON.stringify(
        '<p class="text-center text-ui-base/relaxed text-foreground-subtle remote-unknown" style="margin-top:8px;position:fixed"><b class="font-semibold text-foreground">GLM-5.3-Flash</b> 将于 <span class="whitespace-nowrap font-semibold text-foreground underline decoration-foreground-subtle decoration-dashed underline-offset-4">2026年9月12日 00:00</span> 生效。</p><p class="font-semibold" style="font-weight:400;color:var(--color-foreground);line-height:1.5">Inline style</p>',
      ),
    });
    const { campaignId } = (await response.json()) as { campaignId: string };
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("cloud-content-dialog").waitForDisplayed({ timeout: 15000 });
    const originalClass = await browser.execute(() => document.documentElement.className);
    try {
      for (const theme of ["theme-zai-light", "theme-zai-dark"]) {
        const result = await browser.execute((theme) => {
          document.documentElement.classList.remove("theme-zai-light", "theme-zai-dark");
          document.documentElement.classList.add(theme);
          const description = document.querySelector('[data-testid="cloud-dialog-description"]')!;
          const p = description.querySelector("p")!;
          const date = p.querySelector("span")!;
          const inline = description.querySelectorAll("p")[1]!;
          const button = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-testid="cloud-content-dialog"] button',
            ),
          ).find((button) => button.textContent === "Close campaign")!;
          const s = getComputedStyle(date);
          return {
            unknown: p.classList.contains("remote-unknown"),
            margin: getComputedStyle(p).marginTop,
            position: p.style.position,
            weight: s.fontWeight,
            whitespace: s.whiteSpace,
            decoration: s.textDecorationStyle,
            line: s.textDecorationLine,
            offset: s.textUnderlineOffset,
            color: s.color,
            modelColor: getComputedStyle(p.querySelector("b")!).color,
            inlineWeight: getComputedStyle(inline).fontWeight,
            buttonVariant: button.dataset.variant,
            buttonRounded: button.classList.contains("rounded-lg"),
            buttonWeight: getComputedStyle(button).fontWeight,
            buttonPosition: button.style.position,
          };
        }, theme);
        expect(result).toMatchObject({
          unknown: true,
          margin: "8px",
          position: "",
          weight: "600",
          whitespace: "nowrap",
          decoration: "dashed",
          line: "underline",
          offset: "4px",
          inlineWeight: "400",
          buttonVariant: "outline",
          buttonRounded: true,
          buttonWeight: "400",
          buttonPosition: "",
        });
        expect(result.color).toBe(result.modelColor);
      }
      // 约束为手机宽度的内容区，检查不换行日期仍可容纳；不冒充手机实机。
      await browser.execute(() => {
        const dialog = document.querySelector(
          '[data-testid="cloud-content-dialog"]',
        ) as HTMLElement;
        dialog.style.width = "358px";
      });
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const dialog = document.querySelector(
              '[data-testid="cloud-content-dialog"]',
            ) as HTMLElement;
            return (
              Math.abs(dialog.getBoundingClientRect().width - 358) < 1 &&
              dialog.scrollWidth <= dialog.clientWidth
            );
          }),
        { timeout: 3000, timeoutMsg: "窄屏布局未收敛或存在横向溢出" },
      );
      await browser.saveScreenshot(screenshotPath("marketing-html-styles.png"));
    } finally {
      await browser.execute((value) => {
        document.documentElement.className = value;
      }, originalClass);
    }
    expect((await ledger()).events.length).toBe(baseline);
    await byId("cloud-content-dialog").$("button=Close campaign").click();
    await browser.waitUntil(async () => (await ledger()).events.length === baseline + 1);
    expect((await ledger()).events[baseline]).toEqual({
      campaign_id: campaignId,
      action_type: "cancel",
    });
  });
});

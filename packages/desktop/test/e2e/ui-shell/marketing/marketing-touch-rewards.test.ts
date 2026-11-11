import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { marketingDeliverySchema } from "@zcode/shared";
import {
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
} from "@zcode/shared/test-ids";
import {
  waitForDefaultWorkspaceReady,
  seedCredentials,
  clearAppData,
  getE2EAppDataPaths,
} from "#e2e/helpers/desktop-app";
import { assertOverlayWindowControls } from "#e2e/helpers/overlay-window-controls";

// 正式 App 合同测试：网页与 App API 复用隔离 HTTP fixture，不提交邀请或发奖。
async function guestValue(script: string) {
  // execute 的 main-process 返回值会把 guest Promise 序列化为 {}；用明确的异步回调取真实结果。
  const raw = await browser.executeAsync((source, done: (result: string) => void) => {
    const view = document.querySelector('[data-testid="rewards-webview"]') as unknown as {
      executeJavaScript: (source: string) => Promise<unknown>;
    } | null;
    if (!view) {
      done(
        JSON.stringify({
          error: `Rewards guest missing: ${location.href}; ${document.title}; ${document.querySelectorAll("webview").length}`,
        }),
      );
      return;
    }
    view.executeJavaScript(source).then(
      (value) => done(JSON.stringify({ value })),
      (error) => done(JSON.stringify({ error: String(error) })),
    );
  }, script);
  const result = JSON.parse(raw);
  if (result.error) throw new Error(result.error);
  return result.value;
}

async function assertAppReportHeaders(authenticated: boolean) {
  const marker = authenticated ? "E2E_REPORT_HEADERS_LOGIN" : "E2E_REPORT_HEADERS_ANONYMOUS";
  await browser.execute(async (elementName) => {
    const api = (
      window as typeof window & {
        zcode: {
          reportTelemetryEvent: (payload: {
            context: { clientLanguage: string; clientTimezone: string; screenResolution: string };
            elementName: string;
            eventType: string;
            eventRegion: string;
            eventExtraDetail: Record<string, string>;
          }) => Promise<void>;
        };
      }
    ).zcode;
    await api.reportTelemetryEvent({
      context: {
        clientLanguage: "zh-CN",
        clientTimezone: "Asia/Shanghai",
        screenResolution: "1280x800",
      },
      elementName,
      eventType: "view",
      eventRegion: "app",
      eventExtraDetail: {},
    });
  }, marker);
  const origin = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
  const reports = (await (await fetch(`${origin}/__e2e/marketing/telemetry`)).json()) as Array<
    Record<string, unknown>
  >;
  expect(reports.find((report) => report.element === marker)).toMatchObject({
    authenticated,
    bearer: authenticated,
    languageMatches: true,
    timezoneMatches: true,
    deviceMatches: true,
    versionMatches: true,
    osMatches: true,
    userAgentMatches: true,
    title: "Z Code@electron",
    platform: true,
    channel: true,
    refererMatches: true,
  });
}

describe("Rewards website embedded integration", () => {
  it("REF-11: Banner 和独立弹窗 navigate rewards 打开邀请页并各上报一次", async () => {
    const origin = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
    if (!origin) throw new Error("Missing isolated App fixture");
    const assets = (await (await fetch(`${origin}/__e2e/marketing/assets`)).json()) as Record<
      string,
      { src: string; sha256: string }
    >;
    for (const position of ["banner", "popup"] as const) {
      const text = (content: string) => ({ format: "plaintext", content });
      const buttons = [
        { text: text("Open rewards"), action: { type: "navigate", args: { page: "rewards" } } },
      ];
      const delivery =
        position === "banner"
          ? { banner: { background: { type: "image", image: { default: assets.image } }, buttons } }
          : {
              popup: {
                layout: "v1",
                title: text("Rewards navigation"),
                description: text("Open rewards"),
                hero: null,
                buttons,
              },
            };
      await fetch(`${origin}/__e2e/marketing/reset`, {
        method: "POST",
        body: JSON.stringify({
          deliveries: [
            marketingDeliverySchema.parse({
              campaign_id: `rewards-${position}`,
              resource_position: position,
              priority: 90,
              ...delivery,
            }),
          ],
        }),
      });
      await browser.reloadSession();
      await waitForDefaultWorkspaceReady();
      await $(
        position === "banner"
          ? '[data-testid="marketing-banner"]'
          : '[data-testid="cloud-content-dialog"]',
      ).waitForDisplayed({ timeout: 30000 });
      const entry =
        position === "banner"
          ? $('[data-testid="marketing-banner"]').$('button[aria-label="Open rewards"]')
          : $('[data-testid="cloud-content-dialog"]').$("button=Open rewards");
      await entry.waitForDisplayed({ timeout: 30000 });
      await entry.click();
      await $('[data-testid="rewards-webview"]').waitForDisplayed();
      await browser.waitUntil(async () => {
        const state = (await (await fetch(`${origin}/__e2e/marketing/state`)).json()) as {
          events: unknown[];
        };
        return state.events.length === 1;
      });
      const state = (await (await fetch(`${origin}/__e2e/marketing/state`)).json()) as {
        events: unknown[];
      };
      expect(state.events).toEqual([
        { campaign_id: `rewards-${position}`, action_type: "confirm" },
      ]);
      await $('[data-testid="rewards-surface"]')
        .$('button[aria-label="Close"],button[aria-label="关闭"]')
        .click();
    }
  });
  it("REF-02/03/04: 菜单打开隔离网页，主题不重载、语言路由切换、关闭", async () => {
    const origin = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
    if (!origin) throw new Error("Missing isolated App fixture");
    await fetch(`${origin}/__e2e/marketing/reset`, {
      method: "POST",
      body: JSON.stringify({ popup: false, banner: false }),
    });
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady();
    // 只记录头是否正确，不把令牌写入 WebDriver 结果或日志；观测真实网络发送阶段。
    await assertAppReportHeaders(true);
    // WDIO 序列化会删除首个形参，必须引用全局 electron，不能解构 session。
    await browser.electron.execute((electron) => {
      const target = globalThis as typeof globalThis & { rewardsHeaderProbe?: unknown[] };
      target.rewardsHeaderProbe = [];
      electron.session
        .fromPartition("persist:zcode-rewards")
        .webRequest.onSendHeaders((details) => {
          if (details.resourceType !== "mainFrame") return;
          const headers = Object.fromEntries(
            Object.entries(details.requestHeaders).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          );
          target.rewardsHeaderProbe!.push({
            path: new URL(details.url).pathname,
            authenticated: Boolean(headers.authorization),
            device: Boolean(headers["x-device-mid"]),
            version: Boolean(headers["x-zcode-app-version"]),
            platform: Boolean(headers["x-platform"]),
            timezone: Boolean(headers["x-client-timezone"]),
            language: Boolean(headers["x-client-language"]),
          });
        });
    });
    await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
    const entry = $('[data-testid="rewards-menu-item"]');
    await entry.waitForDisplayed();
    expect(await entry.$("svg.lucide-gift").isExisting()).toBe(true);
    expect(await entry.getText()).toMatch(/^(邀请好友\s*奖励|Refer a friend\s*Rewards)$/);
    expect(await entry.$('[data-testid="rewards-reward-badge"]').isExisting()).toBe(true);
    // 截图只写入运行器提供的产物目录，避免系统临时目录破坏跨平台隔离。
    if (process.env.ZCODE_E2E_ARTIFACT_DIR)
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "rewards-reward-menu.png"),
      );
    const order = await browser.execute(() => {
      const entry = document.querySelector('[data-testid="rewards-menu-item"]');
      return entry?.previousElementSibling?.getAttribute("data-testid");
    });
    expect(order).toBe("sidebar-coding-plan-upgrade-button");
    await entry.click();
    await $('[data-testid="rewards-webview"]').waitForDisplayed();
    await assertOverlayWindowControls('[data-testid="rewards-surface"]');
    await browser.waitUntil(
      async () =>
        guestValue(
          `Boolean(window.zcodeBridge?.getTheme() && document.querySelector('[data-app-auth]'))`,
        ) as Promise<boolean>,
      { timeout: 60000 },
    );
    expect(await guestValue(`typeof window.zcodeBridge.notifyPurchaseComplete`)).toBe("undefined");
    expect(await guestValue(`window.zcodeBridge.getAuthState().status`)).toBe("ready");
    const firstHeaders = await browser.electron.execute(
      () =>
        (globalThis as typeof globalThis & { rewardsHeaderProbe: unknown[] }).rewardsHeaderProbe[0],
    );
    expect(firstHeaders).toMatchObject({
      authenticated: false,
      device: false,
      version: false,
      platform: false,
      timezone: false,
      language: false,
    });
    expect(await $('[data-testid="rewards-webview"]').getAttribute("partition")).toBe(
      "persist:zcode-rewards",
    );
    expect(await guestValue(`location.pathname`)).toMatch(/^\/(cn|en)\/rewards$/);
    expect(
      await guestValue(
        `(() => { const before = JSON.stringify(window.zcodeBridge.getAuthState()); window.dispatchEvent(new CustomEvent('zcode-referrals-context', { detail: { theme: 'zai-dark', locale: 'en-US', auth: {status:'anonymous',provider:null,revision:99999} } })); return JSON.stringify(window.zcodeBridge.getAuthState()) === before; })()`,
      ),
    ).toBe(true);
    expect(
      await guestValue(
        `(() => { const provider = window.zcodeBridge.getAuthState().provider; return { oauth: Boolean(localStorage.getItem('oauth:' + provider + ':access_token')), jwt: Boolean(localStorage.getItem('zcodejwttoken')), other: localStorage.getItem('oauth:' + (provider === 'zai' ? 'bigmodel' : 'zai') + ':access_token') === null }; })()`,
      ),
    ).toEqual({ oauth: true, jwt: true, other: true });
    await guestValue(`window.__rewardsNoReload = "same-document"`);
    for (const theme of ["zai-light", "zai-dark"]) {
      await browser.execute(
        (value) =>
          (
            window as typeof window & { __testActions: { setTheme: (value: string) => void } }
          ).__testActions.setTheme(value),
        theme,
      );
      await browser.waitUntil(
        async () =>
          (await guestValue(`document.querySelector('[data-embedded]').dataset.theme`)) ===
          (theme === "zai-light" ? "light" : "dark"),
      );
      expect(await guestValue(`window.__rewardsNoReload`)).toBe("same-document");
      // REF-10：不能把网页视口与内容一起限宽，否则滚动条会落在窗口中间。
      const before = await browser.execute(() => {
        const view = document
          .querySelector('[data-testid="rewards-webview"]')!
          .getBoundingClientRect();
        const header = document
          .querySelector('[data-testid="rewards-surface"] header')!
          .getBoundingClientRect();
        return { left: view.left, right: view.right, width: innerWidth, headerTop: header.top };
      });
      expect(Math.abs(before.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(before.right - before.width)).toBeLessThanOrEqual(1);
      await guestValue(`window.scrollTo(0, 400)`);
      await browser.waitUntil(async () => (await guestValue(`window.scrollY`)) > 0);
      expect(
        await browser.execute(
          () =>
            document
              .querySelector('[data-testid="rewards-surface"] header')!
              .getBoundingClientRect().top,
        ),
      ).toBe(before.headerTop);
      if (process.env.ZCODE_E2E_ARTIFACT_DIR)
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, `rewards-scroll-${theme}.png`),
        );
      await guestValue(`window.scrollTo(0, 0)`);
      if (theme === "zai-light" && process.env.ZCODE_E2E_ARTIFACT_DIR)
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "rewards-embedded-light.png"),
        );
    }
    for (const locale of ["zh-CN", "en-US"]) {
      await browser.execute(
        (value) =>
          (
            window as typeof window & { __testActions: { setLocale: (value: string) => void } }
          ).__testActions.setLocale(value),
        locale,
      );
      await browser.waitUntil(
        async () =>
          (await guestValue(`location.pathname`)) ===
          `/${locale === "zh-CN" ? "cn" : "en"}/rewards`,
        { timeout: 30000 },
      );
    }
    const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!directory) throw new Error("Missing artifact directory");
    await browser.saveScreenshot(join(directory, "rewards-embedded-dark.png"));
    await $('[data-testid="rewards-surface"]')
      .$('button[aria-label="Refresh"],button[aria-label="刷新"]')
      .click();
    await browser.waitUntil(
      async () => (await guestValue(`window.zcodeBridge?.getAuthState()?.status`)) === "ready",
    );
    expect(await guestValue(`document.querySelector('[data-embedded]').dataset.theme`)).toBe(
      "dark",
    );
    const sentHeaders = await browser.electron.execute(
      () =>
        (globalThis as typeof globalThis & { rewardsHeaderProbe: unknown[] }).rewardsHeaderProbe,
    );
    expect(sentHeaders.length).toBeGreaterThanOrEqual(2);
    for (const header of sentHeaders)
      expect(header).toMatchObject({
        authenticated: false,
        device: false,
        version: false,
        platform: false,
        timezone: false,
        language: false,
      });
    await browser.electron.execute((electron) => {
      electron.session.fromPartition("persist:zcode-rewards").webRequest.onSendHeaders(null);
      delete (globalThis as typeof globalThis & { rewardsHeaderProbe?: unknown[] })
        .rewardsHeaderProbe;
    });
    await $('[data-testid="rewards-surface"]')
      .$('button[aria-label="Close"],button[aria-label="关闭"]')
      .click();
    await $('[data-testid="rewards-surface"]').waitForExist({ reverse: true });
    await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
    await $('[data-testid="rewards-menu-item"]').click();
    await browser.waitUntil(
      async () => (await guestValue(`window.zcodeBridge?.getAuthState()?.status`)) === "ready",
    );
    await $('[data-testid="rewards-surface"]')
      .$('button[aria-label="Close"],button[aria-label="关闭"]')
      .click();
    await $('[data-testid="rewards-surface"]').waitForExist({ reverse: true });
  });
  it("REF-12: 匿名营销导航打开登录，取消后不打开邀请页并保留 confirm 上报", async () => {
    const origin = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
    if (!origin) throw new Error("Missing isolated App fixture");
    const byId = (id: string) => $(`[data-testid="${id}"]`);
    // 复用匿名营销用例的真实退出流程，只阻止测试进程退出，不伪造登录状态。
    const relaunch = await browser.electron.mock("app", "relaunch");
    const quit = await browser.electron.mock("app", "quit");
    await relaunch.mockResolvedValue(undefined);
    await quit.mockResolvedValue(undefined);
    try {
      await byId(TID_LOGIN_TRIGGER).click();
      await byId(TID_LOGOUT_BUTTON).click();
      await byId(TID_CONFIRM_DIALOG_CONFIRM).waitForDisplayed();
      await byId(TID_CONFIRM_DIALOG_CONFIRM).click();
      await browser.waitUntil(
        async () => {
          await relaunch.update();
          await quit.update();
          return relaunch.mock.calls.length === 1 && quit.mock.calls.length === 1;
        },
        { timeout: 30000 },
      );
    } finally {
      await browser.electron.restoreAllMocks();
    }
    await browser.reloadSession();
    await browser.waitUntil(
      async () =>
        (await byId(TID_LOGIN_TRIGGER).isExisting()) ||
        (await byId(TID_LOGIN_USE_API_KEY_BUTTON).isExisting()),
      { timeout: 30000 },
    );
    if (await byId(TID_LOGIN_USE_API_KEY_BUTTON).isExisting()) {
      await byId(TID_LOGIN_USE_API_KEY_BUTTON).click();
      await byId(TID_LOGIN_API_KEY_SKIP_BUTTON).click();
    }
    await waitForDefaultWorkspaceReady();
    await assertAppReportHeaders(false);
    const assets = (await (await fetch(`${origin}/__e2e/marketing/assets`)).json()) as Record<
      string,
      { src: string; sha256: string }
    >;
    await fetch(`${origin}/__e2e/marketing/reset`, {
      method: "POST",
      body: JSON.stringify({
        deliveries: [
          marketingDeliverySchema.parse({
            campaign_id: "rewards-anonymous",
            resource_position: "banner",
            priority: 90,
            banner: {
              background: { type: "image", image: { default: assets.image } },
              buttons: [
                {
                  text: { format: "plaintext", content: "Open rewards" },
                  action: { type: "navigate", args: { page: "rewards" } },
                },
              ],
            },
          }),
        ],
      }),
    });
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await byId("marketing-banner").waitForDisplayed({ timeout: 30000 });
    await byId("marketing-banner").$('button[aria-label="Open rewards"]').click();
    await byId(TID_LOGIN_USE_API_KEY_BUTTON).waitForDisplayed();
    await assertOverlayWindowControls("main");
    expect(await byId("rewards-webview").isExisting()).toBe(false);
    await browser.waitUntil(async () => {
      const state = (await (await fetch(`${origin}/__e2e/marketing/state`)).json()) as {
        events: unknown[];
      };
      return state.events.length === 1;
    });
    const state = (await (await fetch(`${origin}/__e2e/marketing/state`)).json()) as {
      events: unknown[];
      requestDetails: Array<{ path: string; headers: { authenticated: boolean } }>;
    };
    expect(state.events).toEqual([{ campaign_id: "rewards-anonymous", action_type: "confirm" }]);
    expect(
      state.requestDetails
        .filter((request) => request.path.endsWith("/touch/action"))
        .every((request) => !request.headers.authenticated),
    ).toBe(true);
    await byId(TID_LOGIN_USE_API_KEY_BUTTON).click();
    await byId(TID_LOGIN_API_KEY_SKIP_BUTTON).click();
    await waitForDefaultWorkspaceReady();
    expect(await byId("rewards-webview").isExisting()).toBe(false);
  });
  it("REF-CN: 国内主登录奖励页只接收主 JWT", async function () {
    this.timeout(120000);
    await clearAppData();
    await seedCredentials("zai-webview-oauth-token");
    const { credentialsFile } = getE2EAppDataPaths();
    const saved = JSON.parse(await readFile(credentialsFile, "utf8"));
    for (const key of Object.keys(saved)) if (key.startsWith("oauth:")) delete saved[key];
    Object.assign(saved, {
      "oauth:active_provider": "zai_cn",
      "oauth:session_revision": "e2e-rewards-cn",
      "oauth:zai_cn:access_token": "e2e-cn-upstream-oauth",
      "oauth:zai_cn:user_info": JSON.stringify({ user_id: "e2e-cn-user", name: "CN" }),
      "oauth:linked_bigmodel": JSON.stringify({
        userId: "e2e-cn-user",
        customerId: "e2e-user",
        accessToken: "e2e-linked-bigmodel-jwt",
      }),
      zcodejwttoken: "e2e-cn-zcode-jwt",
    });
    await writeFile(credentialsFile, JSON.stringify(saved), "utf8");
    const origin = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
    await fetch(`${origin}/__e2e/marketing/reset`, {
      method: "POST",
      body: JSON.stringify({ popup: false, banner: false }),
    });
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady();
    await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
    await $('[data-testid="rewards-menu-item"]').click();
    await $('[data-testid="rewards-webview"]').waitForDisplayed();
    await browser.waitUntil(
      async () => (await guestValue(`window.zcodeBridge?.getAuthState()?.provider`)) === "zai_cn",
      { timeout: 15000 },
    );
    expect(
      await guestValue(
        `({ status: window.zcodeBridge.getAuthState().status, jwt: localStorage.getItem("zcodejwttoken") === "e2e-cn-zcode-jwt", noUpstream: !localStorage.getItem("oauth:zai_cn:access_token"), noLinked: !localStorage.getItem("oauth:bigmodel:access_token") })`,
      ),
    ).toEqual({ status: "ready", jwt: true, noUpstream: true, noLinked: true });
    await $('[data-testid="rewards-surface"]')
      .$('button[aria-label="Close"],button[aria-label="关闭"]')
      .click();
  });
});

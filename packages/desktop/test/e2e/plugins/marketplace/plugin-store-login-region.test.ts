import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { sel } from "#e2e/helpers/selectors";
import {
  CN_UNLINKED_E2E_USER_ID,
  CN_UNLINKED_E2E_ZCODE_JWT,
  buildCnUnlinkedSessionCredentials,
} from "#e2e/helpers/start-plan-cn-unlinked-fixture";
import {
  addMarketplaceSourceThroughAgent,
  capturePluginManualReview,
  clickPluginControl,
  getPluginOverview,
  hasPluginControl,
  installMarketplacePluginThroughAgent,
  openPluginSettings,
  requirePluginManualReview,
  setPluginPresentation,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

// PLM-REGION-001（docs/plugin-marketplace-ui-ux.md「按登录区域定向展示」）：
// 本地目录市场三个插件——仅国内（regions: ["cn"]）、仅海外（regions: ["global", 未知值]）、未标注。
// 商店按当前登录渠道派生区域：zai → global，zai_cn / bigmodel → cn，未登录不过滤。
// 已安装插件不受区域影响。每次换登录渠道都在 Electron 退出后改写隔离凭据，再冷启动读取。
// 登录信息读取中或读取失败时区域未知：只隐藏带 regions 的条目，未标注照常显示。
const CASE_ID = "PLM-REGION-001";
const MARKET = "e2e-region-market";
const CN_ONLY_NAME = "e2e-region-cn-only";
const CN_ONLY = `${CN_ONLY_NAME}@${MARKET}`;
const GLOBAL_ONLY_NAME = "e2e-region-global-only";
const GLOBAL_ONLY = `${GLOBAL_ONLY_NAME}@${MARKET}`;
const ALL_REGIONS = `e2e-region-all-regions@${MARKET}`;
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-store-login-region/store-market",
);
const SCREENSHOT_WIDTH = 1440;
const SCREENSHOT_HEIGHT = 900;

type LoginProvider = "zai" | "zai_cn" | null;

/**
 * 目标渠道的合成登录会话。启动恢复要求有 ZCode JWT（缺失时 zai 会被送回登录页），
 * 这里复用国内新账号夹具的 JWT 与用户：本地账号控制面只认这枚 JWT 的 profile 请求，
 * 其余账号接口也留在本地 mock，不会触发线上 401。zai_cn 直接用该夹具，zai 只换渠道键。
 */
function buildLoginCredentials(provider: Exclude<LoginProvider, null>): Record<string, string> {
  if (provider === "zai_cn") return buildCnUnlinkedSessionCredentials();
  return {
    "oauth:active_provider": provider,
    "oauth:session_revision": `e2e-region-${provider}-revision`,
    [`oauth:${provider}:access_token`]: `e2e-region-${provider}-token`,
    [`oauth:${provider}:user_info`]: JSON.stringify({
      user_id: CN_UNLINKED_E2E_USER_ID,
      name: "Region User",
    }),
    zcodejwttoken: CN_UNLINKED_E2E_ZCODE_JWT,
  };
}

/** Electron 退出后改写凭据并冷启动，避免与旧 Host 的账号刷新竞争。 */
async function relaunchWithLogin(provider: LoginProvider): Promise<void> {
  await reloadElectronSessionPreservingBrowserProfile(browser, {
    afterElectronProcessExit: async () => {
      const { credentialsFile, appDataDir } = getE2EAppDataPaths();
      const credentials = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<
        string,
        string
      >;
      for (const key of Object.keys(credentials)) {
        if (key.startsWith("oauth:") || key === "zcodejwttoken" || key === "auth_token") {
          delete credentials[key];
        }
      }
      if (provider) Object.assign(credentials, buildLoginCredentials(provider));
      await writeFile(credentialsFile, JSON.stringify(credentials), "utf8");
      // 换入口后不让旧的套餐家族选择把启动送回登录门禁；本例只验证商店展示。
      const settingsFile = join(appDataDir, "setting.json");
      const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
      delete settings.providerFamilyDomain;
      delete settings.providerFamilyConnectionSelections;
      settings.providerFamilyDomainMigrated = true;
      await writeFile(settingsFile, JSON.stringify(settings), "utf8");
    },
  });
  if (!provider) {
    // 未登录冷启动会先出现 WelcomeScreen；走公开的「暂不设置」路径进入匿名工作区。
    await browser.waitUntil(
      async () =>
        (await $(sel(TID_TASK_SETTINGS_BUTTON)).isExisting()) ||
        (await $('[data-testid="onboarding-page"]').isExisting()) ||
        (await $(sel(TID_LOGIN_USE_API_KEY_BUTTON)).isExisting()),
      { timeout: 60_000, timeoutMsg: "未登录冷启动后既没有工作区也没有欢迎页" },
    );
    if (await $(sel(TID_LOGIN_USE_API_KEY_BUTTON)).isExisting()) {
      await $(sel(TID_LOGIN_USE_API_KEY_BUTTON)).click();
      await $(sel(TID_LOGIN_API_KEY_SKIP_BUTTON)).click();
    }
  }
  await skipOccupationOnboardingIfPresent();
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
}

/**
 * 打开商店个人分段，等未标注插件出现（说明目录已渲染），再读三张卡片是否存在。
 * `sidebar`：商店已打开时点侧栏「插件」入口让商店页重新挂载（从商店进设置再点「浏览」不会离开设置页）。
 */
async function readVisibleRegionCards(
  entry: "settings" | "sidebar" = "settings",
): Promise<Record<string, boolean>> {
  await setPluginPresentation({
    locale: "zh-CN",
    theme: "zai-light",
    width: SCREENSHOT_WIDTH,
    height: SCREENSHOT_HEIGHT,
  });
  if (entry === "settings") {
    await openPluginSettings();
  } else {
    await clickPluginControl("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-list", {}, 30_000);
  }
  await clickPluginControl("plugin-store-segment-personal");
  await waitForPluginCard(ALL_REGIONS, 60_000);
  return {
    [CN_ONLY]: await hasPluginControl("plugin-store-card", { pluginId: CN_ONLY }),
    [GLOBAL_ONLY]: await hasPluginControl("plugin-store-card", { pluginId: GLOBAL_ONLY }),
    [ALL_REGIONS]: await hasPluginControl("plugin-store-card", { pluginId: ALL_REGIONS }),
  };
}

type ActiveProviderGateMode = "hold" | "fail";

/**
 * 子项 g、h：让商店读 activeProvider 的调用挂起或抛错，不改产品代码。
 *
 * 从已挂载的商店根节点沿 React fiber 向上找 ServiceProvider 的服务对象，把它的 oauthService
 * 临时换成代理：只拦截 getActiveProvider，其余方法原样转发给原 RPC 代理。之后重新打开商店，
 * 新挂载的 useOAuth 会读到这个代理。返回被替换的服务对象数量。
 */
async function gateActiveProviderRead(mode: ActiveProviderGateMode): Promise<number> {
  return browser.execute((gateMode: ActiveProviderGateMode) => {
    const state = window as any;
    if (state.__e2eRegionGate) throw new Error("activeProvider 读取闸门已安装");
    const element = document.querySelector('[data-testid="plugin-store-root"]');
    if (!element) throw new Error("商店未挂载，找不到服务对象");
    let fiber = (element as any)[
      Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
    ];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = {
      mode: gateMode as ActiveProviderGateMode | null,
      calls: 0,
      release,
      patched: [] as Array<{ services: any; original: any }>,
    };
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      if (
        value &&
        typeof value === "object" &&
        value.oauthService &&
        !gate.patched.some((entry) => entry.services === value)
      ) {
        const original = value.oauthService;
        const wrapper = new Proxy(original, {
          get(_target, key) {
            if (key !== "getActiveProvider") return original[key];
            return async () => {
              if (gate.mode === "fail") {
                gate.calls += 1;
                throw new Error("E2E: activeProvider read failed");
              }
              if (gate.mode === "hold") {
                gate.calls += 1;
                await released;
              }
              return original.getActiveProvider();
            };
          },
        });
        value.oauthService = wrapper;
        if (value.oauthService !== wrapper) throw new Error("服务对象的 oauthService 不可替换");
        gate.patched.push({ services: value, original });
      }
      fiber = fiber.return;
    }
    if (gate.patched.length === 0) throw new Error("没有找到带 oauthService 的服务对象");
    state.__e2eRegionGate = gate;
    return gate.patched.length;
  }, mode);
}

/** 读闸门拦下的 getActiveProvider 调用次数，证明商店确实处在读取中或读取失败。 */
async function readGatedActiveProviderCalls(): Promise<number> {
  return browser.execute(() => (window as any).__e2eRegionGate?.calls ?? 0);
}

/** 放行挂起的读取，并把服务对象恢复成原 oauthService。 */
async function releaseActiveProviderGate(): Promise<void> {
  await browser.execute(() => {
    const state = window as any;
    const gate = state.__e2eRegionGate;
    if (!gate) return;
    gate.mode = null;
    gate.release();
    for (const entry of gate.patched) entry.services.oauthService = entry.original;
    delete state.__e2eRegionGate;
  });
}

/**
 * 对比图用的 2 倍清晰度截图：经主进程 CDP 临时把视口设成 1440x900@2x，截完恢复。
 * 截图只是评审证据，失败时退回普通截图，不影响行为断言。
 */
async function captureHiDpi(label: string): Promise<string> {
  const fallback = await capturePluginManualReview(CASE_ID, label);
  const base64 = await browser.electron
    .execute(
      async (electron, size) => {
        const window = electron.BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.isVisible() && candidate.webContents.getURL().startsWith("file://"),
        );
        if (!window) return null;
        const debuggerApi = window.webContents.debugger;
        const attachedBefore = debuggerApi.isAttached();
        if (!attachedBefore) debuggerApi.attach("1.3");
        try {
          await debuggerApi.sendCommand("Emulation.setDeviceMetricsOverride", {
            width: size.width,
            height: size.height,
            deviceScaleFactor: 2,
            mobile: false,
          });
          await new Promise((done) => setTimeout(done, 800));
          const result = (await debuggerApi.sendCommand("Page.captureScreenshot", {
            format: "png",
          })) as { data: string };
          return result.data;
        } finally {
          await debuggerApi.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
          if (!attachedBefore) debuggerApi.detach();
        }
      },
      { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT },
    )
    .catch(() => null);
  if (!base64) return fallback;
  const path = fallback.replace(/\.png$/u, "@2x.png");
  await writeFile(path, Buffer.from(base64, "base64"));
  return path;
}

describe("PLM-REGION-001 插件商店按登录区域定向展示", () => {
  after(async () => {
    await releaseActiveProviderGate().catch(() => {});
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("zai 隐藏仅国内、zai_cn/bigmodel 隐藏仅海外、读取中或失败隐藏定向、未登录全显示、已安装不受影响", async function () {
    this.timeout(600_000);
    requirePluginManualReview();
    const { homeDir } = getE2EAppDataPaths();
    const market = join(homeDir, "fixtures", "plugin-store-login-region", "store-market");
    await mkdir(market, { recursive: true });
    await cp(FIXTURE_ROOT, market, { recursive: true, force: true });
    await addMarketplaceSourceThroughAgent(market);
    await waitUntilPluginOverview(
      (overview) =>
        [CN_ONLY, GLOBAL_ONLY, ALL_REGIONS].every((id) =>
          overview.availablePlugins.some((plugin) => plugin.id === id),
        ),
      "the local market should list all three region plugins",
      60_000,
    );
    // CLI 只透传认识的区域值，未知值丢掉；未标注的条目没有 regions。
    const overview = await getPluginOverview();
    const listingOf = (id: string) =>
      overview.availablePlugins.find((plugin) => plugin.id === id)?.listing;
    expect(listingOf(CN_ONLY)?.regions).toEqual(["cn"]);
    expect(listingOf(GLOBAL_ONLY)?.regions).toEqual(["global"]);
    expect(listingOf(ALL_REGIONS)?.regions).toBeUndefined();

    // (a) 启动夹具是 bigmodel 登录（旧渠道，算国内）：看不到仅海外插件。
    expect(await readVisibleRegionCards()).toEqual({
      [CN_ONLY]: true,
      [GLOBAL_ONLY]: false,
      [ALL_REGIONS]: true,
    });

    // (g) 登录信息读取中：区域未知，仅国内与仅海外都不显示，未标注照常显示；
    // 放行后按 bigmodel（国内）显示仅国内插件。
    expect(await gateActiveProviderRead("hold")).toBeGreaterThan(0);
    expect(await readVisibleRegionCards("sidebar")).toEqual({
      [CN_ONLY]: false,
      [GLOBAL_ONLY]: false,
      [ALL_REGIONS]: true,
    });
    expect(await readGatedActiveProviderCalls()).toBeGreaterThan(0);
    await capturePluginManualReview(CASE_ID, "region-loading");
    await releaseActiveProviderGate();
    await waitForPluginCard(CN_ONLY, 30_000);
    expect(await hasPluginControl("plugin-store-card", { pluginId: GLOBAL_ONLY })).toBe(false);

    // (h) 登录信息读取失败：同样按未知处理，不当成未登录全部放出。
    expect(await gateActiveProviderRead("fail")).toBeGreaterThan(0);
    try {
      expect(await readVisibleRegionCards("sidebar")).toEqual({
        [CN_ONLY]: false,
        [GLOBAL_ONLY]: false,
        [ALL_REGIONS]: true,
      });
      expect(await readGatedActiveProviderCalls()).toBeGreaterThan(0);
      await capturePluginManualReview(CASE_ID, "region-read-failed");
    } finally {
      await releaseActiveProviderGate();
    }

    // (b) zai（海外）登录：看不到仅国内插件。
    await relaunchWithLogin("zai");
    expect(await readVisibleRegionCards()).toEqual({
      [CN_ONLY]: false,
      [GLOBAL_ONLY]: true,
      [ALL_REGIONS]: true,
    });
    await captureHiDpi("after-global");

    // (c) zai_cn（国内）登录：看不到仅海外插件。
    await relaunchWithLogin("zai_cn");
    expect(await readVisibleRegionCards()).toEqual({
      [CN_ONLY]: true,
      [GLOBAL_ONLY]: false,
      [ALL_REGIONS]: true,
    });
    await captureHiDpi("after-cn");

    // (d) 未登录：不过滤，三个都在。
    await relaunchWithLogin(null);
    expect(await readVisibleRegionCards()).toEqual({
      [CN_ONLY]: true,
      [GLOBAL_ONLY]: true,
      [ALL_REGIONS]: true,
    });
    await capturePluginManualReview(CASE_ID, "signed-out");

    // (e) 已安装的仅海外插件，换到国内登录后仍留在商店里。
    await installMarketplacePluginThroughAgent(GLOBAL_ONLY_NAME, MARKET);
    await relaunchWithLogin("zai_cn");
    expect(await readVisibleRegionCards()).toEqual({
      [CN_ONLY]: true,
      [GLOBAL_ONLY]: true,
      [ALL_REGIONS]: true,
    });
    await capturePluginManualReview(CASE_ID, "cn-installed-global-only");
  });
});

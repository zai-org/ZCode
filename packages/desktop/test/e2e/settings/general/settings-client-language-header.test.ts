import { fileURLToPath } from "node:url";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  quitElectronAppGracefully,
  readSettings,
  seedSettings,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { startHelpConfigFixture } from "#e2e/helpers/help-client-config-fixture";
import { openFaultInjectedHostWindow } from "#e2e/helpers/subagent-host-window";

type Locale = "zh-CN" | "en-US" | "ja-JP" | "ru-RU" | "ko-KR";
type HelpServer = Awaited<ReturnType<typeof startHelpConfigFixture>>;
type Request = HelpServer["requests"][number];

const HELP_MENU_TRIGGER = 'button[data-testid="workspace-help-menu-trigger"]';
// 与 Main 启动默认语言（DEFAULT_LOCALE = zh-CN）不同，预热请求带它就说明拿到的是持久化语言。
const PERSISTED: Locale = "en-US";
const SWITCHED: Locale = "zh-CN";
const HOST_PRELOAD = fileURLToPath(
  new URL("../../helpers/subagent-host-faults.cjs", import.meta.url),
);

// spec：docs/zcode-endpoint-client-language-header.md。
// Host 请求经 NodeApiClient，带 x-request-id；Main 请求经 Electron net，不带。以此区分两条链路。
const isHost = (request: Request) => Boolean(request.headers["x-request-id"]);
function expectLanguage(requests: Request[], locale: Locale) {
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.map((request) => request.headers["x-client-language"])).toEqual(
    requests.map(() => locale),
  );
}

/**
 * setting.json 落盘格式：旧字段 locale/localePreference 只写 v3.17.x 等旧版本认识的中英值
 * （否则降级后旧版本 schema 校验失败会重置全部设置），真实语言写 uiLocale/uiLocalePreference。
 */
async function expectPersistedLocale(locale: Locale) {
  const legacy = locale === "zh-CN" ? "zh-CN" : "en-US";
  const expected = {
    locale: legacy,
    localePreference: legacy,
    uiLocale: locale,
    uiLocalePreference: locale,
  };
  let last: Record<string, unknown> = {};
  await browser
    .waitUntil(
      async () => {
        const raw: Record<string, unknown> = await readSettings();
        last = {
          locale: raw.locale,
          localePreference: raw.localePreference,
          uiLocale: raw.uiLocale,
          uiLocalePreference: raw.uiLocalePreference,
        };
        return JSON.stringify(last) === JSON.stringify(expected);
      },
      { timeout: 15000, interval: 300 },
    )
    .catch(() => undefined);
  expect(last).toEqual(expected);
}

describe("ZCode endpoint X-Client-Language 跟随界面语言", () => {
  let external: Awaited<ReturnType<typeof browser.electron.mock>>;
  const servers: HelpServer[] = [];

  async function mockExternal() {
    external = await browser.electron.mock("shell", "openExternal");
    await external.mockResolvedValue(undefined);
  }
  afterEach(async () => {
    await browser.keys("Escape");
    await browser.electron.restoreAllMocks();
  });
  after(async () => {
    for (const server of servers) await server.close();
    await clearAppData();
  });

  async function startServer() {
    const server = await startHelpConfigFixture({
      community_urls: {
        "zh-CN": "https://example.com/E2E_CLIENT_LANGUAGE_ZH",
        "en-US": "https://example.com/E2E_CLIENT_LANGUAGE_EN",
      },
    });
    servers.push(server);
    return server;
  }

  /** 在当前窗口打开帮助菜单，返回该窗口 Host 新发出的 client/configs 请求。 */
  async function openHelpMenuForHostRequests(server: HelpServer) {
    const before = server.requests.filter(isHost).length;
    await $(HELP_MENU_TRIGGER).click();
    await browser.waitUntil(async () => server.requests.filter(isHost).length > before, {
      timeout: 15000,
      timeoutMsg: "打开帮助菜单后 Host 没有请求 client/configs",
    });
    await browser.keys("Escape");
    return server.requests.filter(isHost).slice(before);
  }

  async function openCommunityForMainRequests(server: HelpServer) {
    const before = server.requests.filter((request) => !isHost(request)).length;
    await browser.execute(async () => {
      await (
        window as unknown as { zcode: { executeDesktopCommand(command: string): Promise<void> } }
      ).zcode.executeDesktopCommand("openCommunity");
    });
    await browser.waitUntil(
      async () => server.requests.filter((request) => !isHost(request)).length > before,
      { timeout: 15000, timeoutMsg: "openCommunity 后 Main 没有请求帮助配置" },
    );
    return server.requests.filter((request) => !isHost(request)).slice(before);
  }

  async function selectLocaleInSettings(locale: Locale) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15000,
      timeoutMsg: "没有找到设置入口按钮",
    });
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
      timeout: 15000,
      timeoutMsg: "设置页没有出现通用分区入口",
    });
    await clickTestIdByWebDriver(TID_SETTINGS_LOCALE_SELECT_TRIGGER, {
      timeout: 15000,
      timeoutMsg: "界面语言下拉触发器没有出现",
    });
    await clickTestIdByDom(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, locale), {
      timeout: 15000,
      timeoutMsg: `界面语言下拉项没有出现: ${locale}`,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
      timeoutMsg: "设置页没有返回按钮",
    });
  }

  it("CLH-01: 重启后启动预热、Host 与 Main 的请求都使用持久化界面语言", async function () {
    this.timeout(120000);
    await waitForDefaultWorkspaceReady(30000);
    const server = await startServer();
    await quitElectronAppGracefully();
    await seedSettings({
      locale: PERSISTED,
      localePreference: PERSISTED,
      zcodeEndpointOrigin: server.origin,
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    });
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(30000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await mockExternal();

    // 用户操作前到达的 Main 请求只有 client/configs 灰度预热（可能有多个灰度项）；
    // 结果进入 1 小时缓存，之后 Main 的帮助配置也复用它，所以本例的 Main 链路只看预热。
    // 注意：把预热挪回读取持久化语言之前，本例仍通过（已实测）——预热读语言前还有两次 await，
    // 正常时序下启动读取先完成。该顺序只能靠代码保证，E2E 无法稳定复现这个竞态。
    await browser.waitUntil(async () => server.requests.some((request) => !isHost(request)), {
      timeout: 15000,
      timeoutMsg: "启动后 Main 没有发出 client/configs 灰度预热",
    });
    expectLanguage(
      server.requests.filter((request) => !isHost(request)),
      PERSISTED,
    );

    // 渲染进程挂载时会同步语言给 Main，Main 再推给 Host，所以这里无法单独证明 InitLocal；
    // InitLocal 下发由 desktopWindowLifecycle 单测覆盖（去掉 InitLocal 本例仍通过，已实测）。
    expectLanguage(await openHelpMenuForHostRequests(server), PERSISTED);
  });

  it("CLH-02: 语言写入失败时，切换仍实时到达 Main 与每个窗口的 Host", async function () {
    this.timeout(150000);
    await mockExternal();
    const firstHandle = await browser.getWindowHandle();
    // 只让第二个窗口的 Host 写 setting.json 失败；语言由该窗口的设置页切换，持久化必然失败。
    const second = await openFaultInjectedHostWindow(HOST_PRELOAD, {
      ZCODE_E2E_FS_FAULTS: JSON.stringify([
        {
          id: "client-language-settings-write",
          code: "EACCES",
          operations: ["writeFile"],
          pathEndsWith: "setting.json",
          // 默认只故障一次，会被启动写入消耗；本例要求该 Host 全程无法持久化。
          maxMatches: 0,
        },
      ]),
    });
    try {
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
      await selectLocaleInSettings(SWITCHED);
      // 写入失败不回滚界面语言；以帮助按钮文案确认 UI 已切到中文。
      await expect($(HELP_MENU_TRIGGER)).toHaveAttribute("aria-label", "帮助");

      // 公共配置按 endpoint 缓存 1 小时；换新 endpoint 才会发出新请求。
      const server = await startServer();
      await seedSettings({ zcodeEndpointOrigin: server.origin });

      expectLanguage(await openHelpMenuForHostRequests(server), SWITCHED);
      await browser.switchToWindow(firstHandle);
      expectLanguage(await openHelpMenuForHostRequests(server), SWITCHED);
      expectLanguage(await openCommunityForMainRequests(server), SWITCHED);
      // 磁盘仍是旧语言：上面的请求只可能来自内存中的实时语言。
      expect((await readSettings()).locale).toBe(PERSISTED);
    } finally {
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
        second.windowId,
      );
      await browser.switchToWindow(firstHandle);
    }
  });

  it("CLH-03: 切到日/俄/韩语后，Host 与 Main 的新请求立即带对应 BCP-47 语言", async function () {
    this.timeout(180000);
    await mockExternal();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    for (const locale of ["ja-JP", "ru-RU", "ko-KR"] as const) {
      await selectLocaleInSettings(locale);
      // 降级兼容（docs/i18n/ui-locales.md）：旧字段只存中英，真实选择在 uiLocale 新字段。
      await expectPersistedLocale(locale);
      // 公共配置按 endpoint 缓存 1 小时；每种语言换一个新 endpoint，确保请求真实发出。
      const server = await startServer();
      await seedSettings({ zcodeEndpointOrigin: server.origin });
      expectLanguage(await openHelpMenuForHostRequests(server), locale);
      expectLanguage(await openCommunityForMainRequests(server), locale);
      // 社群渠道只配中英；非中文界面语言打开英文渠道。
      await browser.waitUntil(
        async () => {
          await external.update();
          return external.mock.calls.length > 0;
        },
        { timeout: 15000, timeoutMsg: `${locale} 下 openCommunity 没有打开外部链接` },
      );
      expect(external.mock.calls.at(-1)?.[0]).toBe("https://example.com/E2E_CLIENT_LANGUAGE_EN");
    }
  });
  async function restartWithSeed(seed: Record<string, unknown>) {
    await waitForDefaultWorkspaceReady(30000);
    const server = await startServer();
    // 渲染进程的 localStorage 偏好优先于 setting.json，且跨重启保留；清掉上一个用例（CLH-03 最后切到
    // ko-KR）的残留，本例只验证 setting.json 的读取。
    await browser.execute(() => localStorage.removeItem("zcode-locale-preference"));
    await quitElectronAppGracefully();
    await seedSettings({
      ...seed,
      zcodeEndpointOrigin: server.origin,
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
    } as Parameters<typeof seedSettings>[0]);
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(30000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await mockExternal();
    await browser.waitUntil(async () => server.requests.some((request) => !isHost(request)), {
      timeout: 15000,
      timeoutMsg: "启动后 Main 没有发出 client/configs 灰度预热",
    });
    return server;
  }

  it("CLH-04: 新格式（旧字段降级为 en-US、uiLocale=ja-JP）冷启动后请求仍带 ja-JP", async function () {
    this.timeout(120000);
    // Main 冷启动同步读 setting.json 必须新字段优先；读到旧字段会把首个请求退化成 en-US。
    const server = await restartWithSeed({
      locale: "en-US",
      localePreference: "en-US",
      uiLocale: "ja-JP",
      uiLocalePreference: "ja-JP",
    });
    expectLanguage(
      server.requests.filter((request) => !isHost(request)),
      "ja-JP",
    );
    expectLanguage(await openHelpMenuForHostRequests(server), "ja-JP");
    await expectPersistedLocale("ja-JP");
  });

  it("CLH-05: 旧字段直接存 ja-JP（开发期内部版本写入）仍识别，并迁移成降级格式", async function () {
    this.timeout(120000);
    const server = await restartWithSeed({ locale: "ja-JP", localePreference: "ja-JP" });
    expectLanguage(
      server.requests.filter((request) => !isHost(request)),
      "ja-JP",
    );
    expectLanguage(await openHelpMenuForHostRequests(server), "ja-JP");
    // 读到旧版本不认识的旧字段值会立即迁移落盘，避免之后降级时旧版本重置整份设置。
    await expectPersistedLocale("ja-JP");
  });
});

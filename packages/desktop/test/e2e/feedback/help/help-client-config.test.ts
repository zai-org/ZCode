import type { Locale } from "@zcode/shared";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  pinE2ELocale,
  readSettings,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { writeE2EJsonFileAtomically } from "#e2e/helpers/e2e-atomic-json-file";
import {
  buildHelpBrowserFixture,
  readHelpFixture,
  startHelpConfigFixture,
} from "#e2e/helpers/help-client-config-fixture";

type DesktopBridge = {
  executeDesktopCommand(command: string): Promise<void>;
  canOpenCommunity(locale: "zh-CN" | "en-US"): Promise<boolean>;
  setApplicationLocale(locale: Locale): Promise<void>;
  getDeviceId(): Promise<string>;
};

async function command(command: string) {
  await browser.execute(async (value) => {
    await (window as unknown as { zcode: DesktopBridge }).zcode.executeDesktopCommand(value);
  }, command);
}
async function available(locale: "zh-CN" | "en-US") {
  return browser.execute(
    async (value) => (window as unknown as { zcode: DesktopBridge }).zcode.canOpenCommunity(value),
    locale,
  );
}
async function english() {
  await browser.execute(async () => {
    await (window as unknown as { zcode: DesktopBridge }).zcode.setApplicationLocale("en-US");
  });
}

describe("帮助配置 client/configs", () => {
  let originalSettings: Awaited<ReturnType<typeof readSettings>>;
  let localPath: string;
  let originalLocal: string | undefined;
  let fixture: Awaited<ReturnType<typeof readHelpFixture>>;
  let server: Awaited<ReturnType<typeof startHelpConfigFixture>>;
  let external: Awaited<ReturnType<typeof browser.electron.mock>>;

  before(async () => {
    await waitForDefaultWorkspaceReady(30000);
    originalSettings = await readSettings();
    fixture = await readHelpFixture();
    const appPath = await browser.electron.execute((electron) => electron.app.getAppPath());
    // E2E 必须只改 worker 的隔离默认配置，绝不写开发者的真实安装目录。
    if (!appPath.includes(".e2e-cache")) throw new Error(`Unexpected E2E app path: ${appPath}`);
    localPath = join(appPath, "../../config/default.json");
    originalLocal = await readFile(localPath, "utf8").catch(() => undefined);
    // Main 的 setApplicationLocale 只更新原生菜单，不修改 Renderer 的持久语言。
    // 先为隔离副本设置界面语言再加载，避免中文系统下用英文选择器误报帮助入口缺失。
    await seedSettings({ locale: "en-US", localePreference: "en-US" });
    await browser.refresh();
    await waitForDefaultWorkspaceReady(30000);
    // 实测：refresh 不会重读 setting.json 的 locale，renderer 仍按系统语言渲染。
    // 这里补一次真实 setLocale，否则 Help 按钮的 aria-label 是「帮助」，英文选择器必然失败。
    await pinE2ELocale("en-US");
  });
  beforeEach(async () => {
    await english();
    await writeE2EJsonFileAtomically(localPath, fixture.local);
    external = await browser.electron.mock("shell", "openExternal");
    await external.mockResolvedValue(undefined);
    server = await startHelpConfigFixture(fixture.remote);
    await seedSettings({ zcodeEndpointOrigin: server.origin });
  });
  afterEach(async () => {
    await browser.keys("Escape");
    await browser.electron.restoreAllMocks();
    await seedSettings({ zcodeEndpointOrigin: originalSettings.zcodeEndpointOrigin });
    await server?.close();
  });
  after(async () => {
    if (originalLocal === undefined) await rm(localPath, { force: true });
    else await writeFile(localPath, originalLocal, "utf8");
    await seedSettings(originalSettings);
    await browser.execute(async (locale) => {
      await (window as unknown as { zcode: DesktopBridge }).zcode.setApplicationLocale(locale);
    }, originalSettings.locale ?? "en-US");
  });

  async function expectExternal(url: string) {
    await browser.waitUntil(
      async () => {
        try {
          await expect(external).toHaveBeenCalledWith(url);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10000, timeoutMsg: `未打开外链 ${url}` },
    );
  }

  it("HC-01: 真实帮助菜单、语言与成功缓存", async () => {
    expect(await available("en-US")).toBe(true);
    await $('button[aria-label="Help"]').click();
    await $('//*[@role="menuitem" and contains(.,"User community")]').click();
    await expectExternal(fixture.remote.community_urls!["en-US"]!);
    expect(await available("zh-CN")).toBe(true);
    await browser.execute(async () => {
      await (window as unknown as { zcode: DesktopBridge }).zcode.setApplicationLocale("zh-CN");
    });
    await command("openCommunity");
    await expectExternal(fixture.remote.community_urls!["zh-CN"]!);
    // 同一端点也被 Host Provider Config 拉取（带 x-request-id）；缓存断言只统计 Main 的帮助请求。
    const helpRequests = server.requests.filter((request) => !request.headers["x-request-id"]);
    expect(helpRequests).toHaveLength(1);
    const query = new URL(helpRequests[0]!.url, server.origin).searchParams;
    expect(query.get("app_version")).toBeTruthy();
    expect(query.get("platform")).toBe(`${process.platform}-${process.arch}`);
    expect(helpRequests[0]!.headers.authorization).toBeUndefined();
  });

  it("HC-01-copy-device-mid: 真实帮助菜单复制当前设备 MID", async () => {
    const expected = await browser.execute(async () => {
      return (window as unknown as { zcode: DesktopBridge }).zcode.getDeviceId();
    });
    await $('button[aria-label="Help"]').click();
    await $('[role="menuitem"]*=Copy device MID').click();
    await browser.waitUntil(
      async () =>
        (await browser.electron.execute((electron) => electron.clipboard.readText())) === expected,
      { timeout: 10_000, timeoutMsg: "系统剪贴板没有收到当前设备 MID" },
    );
  });

  it("HC-02: 英文缺失只回退英文内置值", async () => {
    server.setConfig({ community_urls: { "zh-CN": fixture.remote.community_urls!["zh-CN"] } });
    expect(await available("en-US")).toBe(true);
    await command("openCommunity");
    await expectExternal(fixture.local.community_urls!["en-US"]!);
  });

  it("HC-03: false 覆盖本地 true 并显示弹窗；新 endpoint 的 true 打开表单", async () => {
    await command("openFeedback");
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10000 });
    await expect($('[role="dialog"]')).toHaveText(expect.stringContaining("Submit feedback"));
    if (process.platform === "linux") {
      const overlayTop = await browser.execute(() => {
        const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
        if (!overlay) throw new Error("反馈弹窗遮罩不存在");
        return overlay.getBoundingClientRect().top;
      });
      expect(overlayTop).toBe(0);
    }
    await expect(external).not.toHaveBeenCalled();
    await browser.keys("Escape");
    const other = await startHelpConfigFixture({
      ...fixture.remote,
      feedback_use_external_form: true,
    });
    try {
      await seedSettings({ zcodeEndpointOrigin: other.origin });
      await command("openFeedback");
      await expectExternal(fixture.remote.feedback_url!);
      expect(other.requests).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  for (const failure of ["http", "business", "json"] as const) {
    it(`HC-04-${failure}: 失败回退、不缓存失败、同 endpoint 恢复`, async () => {
      server.setFailure(failure);
      expect(await available("en-US")).toBe(true);
      await command("openCommunity");
      await expectExternal(fixture.local.community_urls!["en-US"]!);
      expect(server.requests.length).toBeGreaterThanOrEqual(2);
      server.setConfig(fixture.remote);
      await command("openCommunity");
      await expectExternal(fixture.remote.community_urls!["en-US"]!);
    });
  }

  it("HC-04-empty: 远端和内置均无当前语言时平台不可用", async () => {
    await writeE2EJsonFileAtomically(localPath, {});
    server.setConfig({});
    expect(await available("en-US")).toBe(false);
    expect(await available("zh-CN")).toBe(false);
  });

  it("HC-05: 窄屏 Chromium Web 解析、并发缓存与页面重载重新请求", async () => {
    const webServer = await startHelpConfigFixture(fixture.remote, await buildHelpBrowserFixture());
    const mainHandle = await browser.getWindowHandle();
    const existing = await browser.getWindowHandles();
    const id = await browser.electron.execute(async (electron, url) => {
      const win = new electron.BrowserWindow({
        width: 390,
        height: 844,
        show: false,
        webPreferences: { sandbox: true, nodeIntegration: false },
      });
      await win.loadURL(url);
      return win.id;
    }, webServer.origin);
    try {
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > existing.length,
        { timeout: 10000 },
      );
      const handle = (await browser.getWindowHandles()).find((item) => !existing.includes(item))!;
      await browser.switchToWindow(handle);
      const read = async (token: string | null = null) =>
        browser.execute(async (currentToken) => {
          const help = (
            window as unknown as {
              helpFixture: {
                resolveWebCommunityUrl(
                  locale: string,
                  options: { endpointOrigin: string; resolveZcodeJwtToken: () => string | null },
                ): Promise<string>;
              };
            }
          ).helpFixture;
          return Promise.all(
            ["zh-CN", "en-US"].map((locale) =>
              help.resolveWebCommunityUrl(locale, {
                endpointOrigin: location.origin,
                resolveZcodeJwtToken: () => currentToken,
              }),
            ),
          );
        }, token);
      expect(await read()).toEqual([
        fixture.remote.community_urls!["zh-CN"],
        fixture.remote.community_urls!["en-US"],
      ]);
      expect(webServer.requests).toHaveLength(1);
      expect(
        new URL(webServer.requests[0]!.url, webServer.origin).searchParams.has("platform"),
      ).toBe(false);
      webServer.setConfig({ community_urls: { "en-US": "https://example.com/E2E_WEB_CHANGED" } });
      expect((await read())[1]).toBe(fixture.remote.community_urls!["en-US"]);
      await browser.refresh();
      expect((await read())[1]).toBe("https://example.com/E2E_WEB_CHANGED");
      expect(webServer.requests).toHaveLength(2);
      // 登录身份改变后不能继续命中匿名或其他账号的配置缓存。
      for (const token of ["fixture-help-a", "fixture-help-b", null]) {
        const count = webServer.requests.length;
        await read(token);
        expect(webServer.requests).toHaveLength(count + (token === null ? 0 : 1));
        if (token) expect(webServer.requests.at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
      }
      expect(webServer.requests[0]!.headers.authorization).toBeUndefined();
    } finally {
      await browser.electron.execute(
        (electron, windowId) => electron.BrowserWindow.fromId(windowId)?.destroy(),
        id,
      );
      await browser.switchToWindow(mainHandle);
      await webServer.close();
    }
  });
});

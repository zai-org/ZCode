import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_LOGIN_TRIGGER,
  TID_OAUTH_CANCEL,
  TID_OAUTH_LOGIN_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared/test-ids";
import { seedCredentials, seedSettings, waitForTestIdByDom } from "#e2e/helpers/desktop-app";

async function enterWorkspace() {
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
      return $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting();
    },
    { timeout: 60_000, timeoutMsg: "启动后未进入工作区" },
  );
}

async function openRemoteControlDialog(label: string) {
  // 设置按钮先于 workspace 恢复出现；必须等待目标入口可见，不能把启动中间态当作缺少门禁。
  await browser.waitUntil(
    async () => {
      for (const trigger of await $$(`button[aria-label="${label}"]`)) {
        if (await trigger.isDisplayed()) {
          await trigger.click();
          return true;
        }
      }
      return false;
    },
    { timeout: 20_000, timeoutMsg: `未出现远控入口：${label}` },
  );
}

describe("桌面远控登录门禁", () => {
  it("AUTH-08: 未登录时只展示登录入口，四种主题语言组合无HTTP或WS连接", async function () {
    this.timeout(180_000);
    const baseUrl = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!baseUrl || !artifactDir) throw new Error("缺少远控门禁 fixture 或产物目录");
    const endpoint = await browser.electron.execute(() => ({
      origin: process.env.ZCODE_ENDPOINT_ORIGIN,
      relay: process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL,
    }));
    expect(endpoint.origin).toBe(baseUrl);
    expect(endpoint.relay).toBe(`${baseUrl.replace("http:", "ws:")}/api/v1/remote/ws2`);
    await enterWorkspace();
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["zai-light", "zai-dark"] as const) {
        await seedSettings({ locale, localePreference: locale });
        await browser.execute((value) => localStorage.setItem("zcode-theme", value), theme);
        await browser.refresh();
        await enterWorkspace();
        expect(
          await browser.execute(
            (value) => document.documentElement.classList.contains(`theme-${value}`),
            theme,
          ),
        ).toBe(true);
        const label = locale === "zh-CN" ? "移动端远程控制" : "Mobile remote control";
        await openRemoteControlDialog(label);
        await waitForTestIdByDom("web-remote-control-auth-required");
        const card = $('[data-testid="web-remote-control-auth-required"]');
        expect(await card.getText()).toContain(
          locale === "zh-CN" ? "需要先登录" : "Sign in required",
        );
        expect(await $('[data-testid="web-remote-control-login"]').getText()).toBe(
          locale === "zh-CN" ? "登录" : "Sign in",
        );
        expect(await $('[data-testid="web-remote-control-copy-link-row"]').isExisting()).toBe(
          false,
        );
        expect(await $('[data-testid="web-remote-control-scan-card"] img').isExisting()).toBe(
          false,
        );
        expect(
          await browser.execute(() => {
            const bridge = (
              window as Window & {
                zcode?: { getWebRemoteControlStatus(): Promise<{ status: string }> };
              }
            ).zcode;
            if (!bridge) throw new Error("缺少 preload 远控平台接口");
            return bridge.getWebRemoteControlStatus();
          }),
        ).toEqual({
          status: "auth-required",
        });
        await $('[role="dialog"]').saveScreenshot(
          join(artifactDir, `auth-required-${locale}-${theme}.png`),
        );
        await browser.keys("Escape");
      }
    }
    // 最后一轮仍通过真实远控登录按钮进入现有 OAuth 渠道面板。
    await openRemoteControlDialog("Mobile remote control");
    await $('[data-testid="web-remote-control-login"]').click();
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    const evidence: unknown = await (await fetch(`${baseUrl}/__e2e/status`)).json();
    expect(evidence).toEqual({ remoteHttp: 0, wsUpgrades: 0, oauthProviders: [] });
    await writeFile(
      join(artifactDir, "auth-required-network.json"),
      JSON.stringify(evidence, null, 2),
    );
  });

  it("AUTH-08: 远控401保留全局用户时，登录按钮仍启动当前渠道OAuth并停留在等待页", async function () {
    this.timeout(90_000);
    const baseUrl = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!baseUrl || !artifactDir) throw new Error("缺少远控门禁 fixture 或产物目录");
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockResolvedValue(undefined);
    try {
      await seedCredentials();
      await seedSettings({ locale: "en-US", localePreference: "en-US" });
      await browser.refresh();
      await enterWorkspace();
      await browser.waitUntil(
        async () =>
          (await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).getText()).includes("ZCode E2E"),
        { timeout: 20_000, timeoutMsg: "缓存OAuth用户未恢复" },
      );
      await openRemoteControlDialog("Mobile remote control");
      await waitForTestIdByDom("web-remote-control-auth-required");
      expect(await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).getText()).toContain("ZCode E2E");
      const login = $('[data-testid="web-remote-control-login"]');
      await login.waitForEnabled({ timeout: 10_000 });
      await login.click();
      await waitForTestIdByDom(TID_OAUTH_CANCEL);
      await browser.waitUntil(
        async () => {
          await openExternal.update();
          return openExternal.mock.calls.length === 1;
        },
        { timeout: 20_000, timeoutMsg: "远控重新登录没有启动浏览器OAuth授权" },
      );
      expect(await $('[data-testid="web-remote-control-auth-required"]').isExisting()).toBe(false);
      const evidence = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
        remoteHttp: number;
        wsUpgrades: number;
        oauthProviders: string[];
      };
      expect(evidence.remoteHttp).toBeGreaterThan(0);
      expect(evidence.wsUpgrades).toBe(0);
      expect(evidence.oauthProviders).toEqual(["zai"]);
      expect(await $(`[data-testid="${TID_OAUTH_CANCEL}"]`).isDisplayed()).toBe(true);
      await browser.saveScreenshot(join(artifactDir, "remote-401-relogin.png"));
      await writeFile(
        join(artifactDir, "remote-401-relogin.json"),
        JSON.stringify(evidence, null, 2),
      );
    } finally {
      await browser.electron.restoreAllMocks();
    }
  });
});

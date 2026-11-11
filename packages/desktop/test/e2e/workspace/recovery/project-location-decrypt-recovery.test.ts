import { readFile, writeFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { TID_LOGIN_TRIGGER, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";

interface Status {
  locationRequests: number;
  tokenRequests: number;
  loginCompletions: number;
  tokenAttempts: number;
  keyCreateRequests: number;
  tokenPaths: string[];
}
const readCredentials = async () =>
  JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8")) as Record<
    string,
    string
  >;

async function assertLoggedIn(before: Record<string, string>) {
  await skipOccupationOnboardingIfPresent();
  await browser.waitUntil(
    async () => {
      const label = await browser
        .$(`[data-testid="${TID_LOGIN_TRIGGER}"]`)
        .getAttribute("aria-label");
      return label?.includes("Fixture User") === true;
    },
    { timeout: 30000, timeoutMsg: "有效登录头像没有保留" },
  );
  const after = await readCredentials();
  for (const [key, value] of Object.entries(before)) {
    if (key.startsWith("oauth:") || key === "zcodejwttoken" || key === "bot:e2e:credential")
      expect(after[key]).toBe(value);
  }
  const expired = await browser.execute(() =>
    /登录已过期|Your session has expired/u.test(
      document.querySelector('[data-slot="alert-dialog-title"]')?.textContent ?? "",
    ),
  );
  expect(expired).toBe(false);
}

describe("项目位置缓存局部恢复", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("自动重建坏位置；503 保留登录；服务恢复后通过设置刷新成功", async function () {
    this.timeout(180_000);
    const baseUrl = process.env.ZCODE_E2E_ACCESS_TOKEN_401_URL;
    if (!baseUrl) throw new Error("缺少项目位置恢复 fixture");
    const status = async () => (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as Status;
    const before = await readCredentials();
    await browser.waitUntil(async () => (await status()).tokenRequests > 0, {
      timeout: 30000,
      timeoutMsg: "坏缓存没有自动重建并签发 Token",
    });
    await assertLoggedIn(before);
    const healthy = await readCredentials();
    const locationKey = Object.keys(healthy).find((key) =>
      key.startsWith("project-key-location:v1:"),
    );
    expect(locationKey).toBeDefined();
    expect(healthy[locationKey!]).toMatch(/^enc:v2:/);
    expect(healthy[locationKey!]).not.toBe("enc:v1:broken-project-location");
    expect((await status()).loginCompletions).toBe(0);

    // 故障夹具只在旧进程完全退出后改写，避免与产品持久化发生测试自身的竞态。
    const previousRequests = (await status()).locationRequests;
    await fetch(`${baseUrl}/__e2e/location-unavailable`);
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const raw = await readCredentials();
        raw[locationKey!] = "enc:v1:broken-project-location";
        await writeFile(getE2EAppDataPaths().credentialsFile, JSON.stringify(raw));
      },
    });
    await browser.waitUntil(async () => (await status()).locationRequests > previousRequests, {
      timeout: 30000,
      timeoutMsg: "未覆盖到位置重建 503 路径",
    });
    await assertLoggedIn(healthy);
    const relaunch = await browser.electron.mock("app", "relaunch");
    await relaunch.mockResolvedValue(undefined);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom("settings-section-nav-modelProvider");
    const previousTokens = (await status()).tokenRequests;
    await fetch(`${baseUrl}/__e2e/location-available`);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
            (el) => !el.disabled && /刷新|refresh/iu.test(el.getAttribute("aria-label") ?? ""),
          );
          if (!button) return false;
          button.click();
          return true;
        }),
      { timeout: 30000, timeoutMsg: "模型供应商设置没有可操作的刷新按钮" },
    );
    await browser.waitUntil(async () => (await status()).tokenRequests > previousTokens, {
      timeout: 30000,
      timeoutMsg: "服务恢复后正常刷新没有完成换证",
    });
    await assertLoggedIn(healthy);
    expect((await status()).loginCompletions).toBe(0);
    await relaunch.update();
    expect(relaunch.mock.calls).toHaveLength(0);
    await clickTestIdByDom(
      `model-provider-nav-item-preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
    );

    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document.body.innerText.includes("CODING PRO") &&
            Array.from(document.querySelectorAll("button")).some((el) =>
              /Unlink|断开|解除|解绑/u.test(el.textContent?.trim() ?? ""),
            ),
        ),
      { timeout: 30000, timeoutMsg: "恢复后没有显示已连接套餐及解绑入口" },
    );
    console.info("PROJECT_LOCATION_RECOVERY", {
      ...(await status()),
      oauthPreserved: true,
      networkFailurePreservedLogin: true,
    });
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/project-location-recovered.png`,
    );
  });

  it("已保存 Key ID 的冷缓存签发 503 后自动恢复且不重新登录", async function () {
    this.timeout(90000);
    const baseUrl = process.env.ZCODE_E2E_ACCESS_TOKEN_401_URL!;
    const status = async () => (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as Status;
    const before = await readCredentials();
    const initial = await status();
    await fetch(`${baseUrl}/__e2e/token-retry-once`);
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await browser.waitUntil(async () => (await status()).tokenAttempts >= 2, {
      timeout: 30000,
      timeoutMsg: "冷缓存首次 503 后没有自动再次签发",
    });
    await assertLoggedIn(before);
    const result = await status();
    expect(result.tokenAttempts).toBe(2);
    expect(new Set(result.tokenPaths).size).toBe(1);
    expect(result.keyCreateRequests).toBe(initial.keyCreateRequests);
    expect(result.loginCompletions).toBe(0);
    const settingsVisible = await browser.execute(() =>
      Boolean(document.querySelector('[data-testid="settings-section-nav-modelProvider"]')),
    );
    if (!settingsVisible) await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom("settings-section-nav-modelProvider");
    await clickTestIdByDom(
      `model-provider-nav-item-preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`,
    );
    await browser.waitUntil(
      async () => browser.execute(() => /CODING PRO/.test(document.body.innerText)),
      {
        timeout: 30000,
        timeoutMsg: "自动恢复后没有显示已连接套餐",
      },
    );
    await writeFile(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/pat-cold-retry.json`,
      JSON.stringify(result, null, 2),
    );
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/pat-cold-retry.png`);
  });
});

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";

// BU-E2E-025（docs/browser-use/2026-11-03-browser-element-screenshot-and-live-reload-spec.md）：设置回滚兼容。
// 新版本写入 setting.json 的 fileTreeHtmlClickOpensBrowser，回滚到没有这个键的旧版本时必须被忽略，
// 不能让整份设置校验失败、被重置成默认值（settingService 校验失败即返回默认值）。
// 旧版本读到「不认识的键」与当前版本读到「更新版本才有的键」走同一个 schema 行为（zod 默认 strip），
// 所以这里写入一个只有「未来版本」才有的键来代表旧版本视角，同时确认已知键（含本键）原样生效。

const FUTURE_ONLY_KEY = "zcodeE2EFutureOnlySettingFromNewerBuild";
const certificateSelector =
  '[role="switch"][aria-label="忽略证书校验"], [role="switch"][aria-label="Ignore certificate errors"]';
const htmlClickSelector =
  '[role="switch"][aria-label="单击 HTML 文件时在内置浏览器中打开"], [role="switch"][aria-label="Open HTML files in the built-in browser on click"]';

describe("BU-E2E-025：设置里有本版本不认识的键时照常读取、忽略该键", () => {
  after(async () => {
    await clearAppData();
  });

  it("setting.json 带未知新键：已知设置不被重置，fileTreeHtmlClickOpensBrowser 照常生效", async function () {
    this.timeout(180_000);
    await prepareConversationE2E({ skipProvider: true });

    const settingsFile = join(getE2EAppDataPaths().appDataDir, "setting.json");
    const current = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>;
    // 两个非默认值做探针：设置一旦因未知键整份校验失败，就会回到默认 false。
    await writeFile(
      settingsFile,
      JSON.stringify({
        ...current,
        embeddedBrowserAllowInsecureCertificates: true,
        fileTreeHtmlClickOpensBrowser: true,
        [FUTURE_ONLY_KEY]: { enabled: true, level: 3 },
      }),
    );
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareConversationE2E({ skipProvider: true });

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "browser"), { timeout: 15_000 });
    for (const [selector, name] of [
      [certificateSelector, "忽略证书校验"],
      [htmlClickSelector, "单击 HTML 文件时在内置浏览器中打开"],
    ] as const) {
      const control = $(selector);
      await control.waitForExist({ timeout: 15_000, timeoutMsg: `设置页没有「${name}」开关` });
      await browser.waitUntil(async () => (await control.getAttribute("aria-checked")) === "true", {
        timeout: 15_000,
        timeoutMsg: `「${name}」被重置成默认关闭：setting.json 里的未知键让整份设置校验失败`,
      });
    }
  });
});

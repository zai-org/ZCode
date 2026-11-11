import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
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
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { sel } from "#e2e/helpers/selectors";

const SETTINGS_FILE = join(homedir(), ".zcode", "v2", "setting.json");

describe("设置语言 System default E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SL-01: 系统首选中文且 app locale 为英文时 System default 应解析为中文", async function () {
    this.timeout(90000);

    await prepareEnglishPreference();
    const getPreferredSystemLanguagesMock = await browser.electron.mock(
      "app",
      "getPreferredSystemLanguages",
    );
    const getLocaleMock = await browser.electron.mock("app", "getLocale");
    await getPreferredSystemLanguagesMock.mockReturnValue(["zh-Hans-CN", "en-CN"]);
    await getLocaleMock.mockReturnValue("en-US");

    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady(30000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await openGeneralSettings();
    await assertBodyTextIncludes(["Language"]);

    await selectLocalePreference("system");

    await assertBodyTextIncludes(["界面语言", "系统默认"]);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.localePreference === "system" && settings.locale === "zh-CN";
      },
      {
        timeout: 15000,
        timeoutMsg: "System default 没有按 Electron 首选系统语言写回 zh-CN",
      },
    );
  });
});

async function prepareEnglishPreference() {
  await quitElectronAppGracefully();
  await writeSettings({
    locale: "en-US",
    localePreference: "en-US",
    lastWorkspaceSession: [
      { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
    ],
    lastActiveTabIndex: 0,
  });
  await browser.reloadSession();
}

async function openGeneralSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现通用分区入口",
  });
}

async function selectLocalePreference(preference: "system" | "zh-CN" | "en-US") {
  await clickTestIdByWebDriver(TID_SETTINGS_LOCALE_SELECT_TRIGGER, {
    timeout: 15000,
    timeoutMsg: "界面语言下拉触发器没有出现",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, preference), {
    timeout: 15000,
    timeoutMsg: `界面语言下拉项没有出现: ${preference}`,
  });
}

async function assertBodyTextIncludes(expectedTexts: string[]) {
  await browser.waitUntil(
    async () => {
      const bodyText = await browser.execute(() => document.body.innerText);
      return expectedTexts.every((text) => bodyText.includes(text));
    },
    {
      timeout: 15000,
      timeoutMsg: `页面没有显示预期文本: ${expectedTexts.join(" / ")}`,
    },
  );
}

async function writeSettings(patch: Record<string, unknown>) {
  await mkdir(join(homedir(), ".zcode", "v2"), { recursive: true });
  const current = await readSettings();
  await writeFile(SETTINGS_FILE, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

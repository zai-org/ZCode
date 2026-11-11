import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const input = () => $('[data-testid="settings-search-input"]');
const page = () => $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
const result = (id: string) => $(`[data-settings-search-result="${id}"]`);
const anchor = (id: string) => $(`[data-settings-search-id="${id}"]`);

async function openSearch() {
  await clickTestIdByDom("settings-search-open");
  await input().waitForDisplayed();
}
async function setPresentation(theme: string, locale: string) {
  await browser.execute(
    (theme, locale) => {
      const actions = (
        window as typeof window & {
          __testActions?: { setTheme(value: string): void; setLocale(value: string): void };
        }
      ).__testActions;
      if (!actions) throw new Error("Missing UI test actions");
      actions.setTheme(theme);
      actions.setLocale(locale);
    },
    theme,
    locale,
  );
  await browser.waitUntil(() =>
    browser.execute(
      (theme, locale) =>
        document.documentElement.classList.contains(`theme-${theme}`) &&
        document.documentElement.lang === locale,
      theme,
      locale,
    ),
  );
}
async function expectLocated(id: string) {
  await $('[data-testid="settings-search-dialog"]').waitForDisplayed({ reverse: true });
  await anchor(id).waitForDisplayed({ timeout: 15000 });
  expect(await anchor(id).getAttribute("data-settings-search-highlighted")).toBe("true");
  await browser.waitUntil(() =>
    browser.execute((id) => {
      const target = document.querySelector(`[data-settings-search-id="${id}"]`);
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      return (
        document.activeElement === target &&
        rect.top >= 0 &&
        rect.top < innerHeight &&
        rect.bottom > 0
      );
    }, id),
  );
}

describe("设置项模糊搜索", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await setPresentation("zai-light", "zh-CN");
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await page().waitForDisplayed();
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SS01：搜索具体设置名称、拼音、英文与说明，显示所属分类", async () => {
    await openSearch();
    for (const query of [
      "通知声",
      "通声",
      "tongzhishengyin",
      "tzsy",
      "  ＮＯＴＩＦＩＣＡＴＩＯＮ ＳＯＵＮＤ  ",
    ]) {
      await input().setValue(query);
      await result("settings.notificationSound").waitForDisplayed();
      expect(await result("settings.notificationSound").getText()).toContain("常规");
      expect(await result("settings.uiFontSize").isExisting()).toBe(false);
      expect(await page().getAttribute("data-active-section")).toBe("general");
    }
    await input().setValue("出口流量");
    await result("settings.httpProxy").waitForDisplayed();
    await input().setValue("zzzz-no-such-setting");
    await $('[data-testid="settings-search-empty"]').waitForDisplayed();
    expect(await result("automations").isExisting()).toBe(false);
    await clickTestIdByDom("settings-search-clear");
    expect(await input().getValue()).toBe("");
    expect(await result("settings.themeMode").isExisting()).toBe(true);
    await input().click();
    await browser.keys("Escape");
  });

  it("SS02：点击和 Enter 定位具体行；重新定位、清空和普通导航保持原行为", async function () {
    this.timeout(180000);
    const settings = await readSettings();
    // 每个固定设置项都走真实搜索和导航，验证索引没有悬空的定位 id。
    await openSearch();
    const ids = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>("[data-settings-search-result]")]
        .map((node) => node.dataset.settingsSearchResult)
        .filter((id): id is string => Boolean(id?.includes("."))),
    );
    await browser.keys("Escape");
    for (const id of ids) {
      await openSearch();
      await result(id).scrollIntoView();
      await result(id).click();
      await expectLocated(id);
    }
    await openSearch();
    await input().setValue("界面字号");
    await browser.keys("Enter");
    await expectLocated("settings.uiFontSize");
    expect(await page().getAttribute("data-active-section")).toBe("appearance");
    await openSearch();
    await input().setValue("界面字号");
    await browser.keys("Enter");
    await expectLocated("settings.uiFontSize");
    expect((await readSettings()).httpProxy).toBe(settings.httpProxy);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    expect(await $('[data-settings-search-highlighted="true"]').isExisting()).toBe(false);
    await openSearch();
    expect(await input().getValue()).toBe("");
    await input().setValue("no-match-value");
    await browser.keys("Escape");
    expect(await input().getValue()).toBe("");
    await browser.keys("Escape");
    await $('[data-testid="settings-search-dialog"]').waitForDisplayed({ reverse: true });
  });

  it("SS04：高亮自动消失，重复命中重新计时且保留焦点和位置", async () => {
    const id = "settings.uiFontSize";
    const locate = async () => {
      await openSearch();
      await input().setValue("界面字号");
      await result(id).click();
      await expectLocated(id);
    };
    await locate();
    // 跨过旧一轮的截止时间，但仍处于新一轮高亮期，验证不会被旧回调提前清除。
    await browser.pause(1100);
    await locate();
    const top = await anchor(id).getLocation("y");
    await browser.pause(1100);
    expect(await anchor(id).getAttribute("data-settings-search-highlighted")).toBe("true");
    await browser.waitUntil(
      async () => (await anchor(id).getAttribute("data-settings-search-highlighted")) !== "true",
      { timeout: 2000, timeoutMsg: "设置项定位高亮未自动消失" },
    );
    expect(await anchor(id).getLocation("y")).toBe(top);
    expect(
      await browser.execute(
        (id) => document.activeElement?.getAttribute("data-settings-search-id") === id,
        id,
      ),
    ).toBe(true);
    await locate();
    await browser.waitUntil(
      async () => (await anchor(id).getAttribute("data-settings-search-highlighted")) !== "true",
      { timeout: 3000, timeoutMsg: "再次命中后的高亮未自动消失" },
    );
  });

  it("SS03：宽窄桌面、窄屏 Web、中英文与深浅主题均可搜索定位", async () => {
    const platformClasses = await browser.execute(() =>
      [...document.documentElement.classList].filter((value) => value.startsWith("platform-")),
    );
    try {
      for (const width of [1200, 600, 390]) {
        await browser.electron.execute(async (electron, width) => {
          const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
            candidate.isVisible(),
          );
          if (!window) throw new Error("Missing renderer");
          if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
          await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
            width,
            height: 844,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }, width);
        await browser.execute(
          (width, classes) => {
            for (const value of classes)
              document.documentElement.classList.toggle(value, width !== 390);
          },
          width,
          platformClasses,
        );
        for (const theme of ["zai-light", "zai-dark"]) {
          for (const locale of ["zh-CN", "en-US"]) {
            await setPresentation(theme, locale);
            await openSearch();
            await input().setValue(locale === "zh-CN" ? "界面字号" : "UI font");
            await result("settings.uiFontSize").waitForDisplayed();
            const bounds = await browser.execute(() => {
              const element = document.querySelector('[data-testid="settings-search-input"]');
              if (!element) throw new Error("Missing search input");
              const { x, width } = element.getBoundingClientRect();
              return { x, width };
            });
            expect(bounds.width).toBeGreaterThan(100);
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
            if (artifactDir)
              await browser.saveScreenshot(
                join(artifactDir, `settings-search-${width}-${theme}-${locale}.png`),
              );
            await result("settings.uiFontSize").click();
            await expectLocated("settings.uiFontSize");
          }
        }
      }
    } finally {
      await browser.execute(
        (classes) => document.documentElement.classList.add(...classes),
        platformClasses,
      );
      await browser.electron.execute(async (electron) => {
        const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
          candidate.isVisible(),
        );
        if (window?.webContents.debugger.isAttached())
          await window.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      });
    }
  });
});

import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  TID_SETTINGS_NATIVE_SEARCH_SWITCH,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const agentNav = testId(TID_SETTINGS_SECTION_NAV, "agentBehavior");
const page = () => $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
const labels = [
  "工具搜索",
  "增强 Find 和 Grep",
  "交互行为",
  "提问自动继续",
  "插件自动推荐",
  "动态工作流",
  "完整保留模型 I/O",
  "显示思考过程",
  "显示待办",
];

describe("Agent 行为与工具设置", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => {
      const actions = (
        window as typeof window & {
          __testActions?: { setLocale(value: string): void };
        }
      ).__testActions;
      if (!actions) throw new Error("Missing UI test actions");
      actions.setLocale("zh-CN");
    });
    await browser.waitUntil(() => browser.execute(() => document.documentElement.lang === "zh-CN"));
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await page().waitForDisplayed();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAB01：常规移除重复标签和 Agent 配置，新分类归属 Agent 能力", async () => {
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    await $(`[data-testid="${TID_SETTINGS_LOCALE_SELECT_TRIGGER}"]`).waitForDisplayed();
    const heading = await page().$("h2");
    expect(await heading.$("../..").getText()).toBe("常规");
    for (const label of labels) expect(await page().getText()).not.toContain(label);
    const navigation = await $(`[data-testid="${agentNav}"]`);
    expect(
      await navigation.$('./ancestor::*[@role="group"][1]').getAttribute("aria-labelledby"),
    ).toBe("settings-sidebar-group-agentCapabilities");
    await navigation.click();
    await $(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`).waitForExist();
    await browser.waitUntil(async () => (await page().getText()).includes("动态工作流"));
    for (const label of labels) expect(await page().getText()).toContain(label);
    expect(await $(`[data-testid="${TID_SETTINGS_LOCALE_SELECT_TRIGGER}"]`).isExisting()).toBe(
      false,
    );
  });

  it("SAB02：新分类保存设置，重开和刷新恢复分类及值", async () => {
    await clickTestIdByDom(agentNav);
    const previous = (await readSettings()).nativeSearchEnhancementsEnabled ?? true;
    const control = $(`[data-testid="${TID_SETTINGS_NATIVE_SEARCH_SWITCH}"]`);
    await control.scrollIntoView();
    await control.click();
    await browser.waitUntil(
      async () => (await readSettings()).nativeSearchEnhancementsEnabled === !previous,
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    expect(await $(`[data-testid="${agentNav}"]`).getAttribute("aria-current")).toBe("page");
    expect(await control.getAttribute("aria-checked")).toBe(String(!previous));
    await browser.refresh();
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).waitForExist({ timeout: 30_000 });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${agentNav}"][aria-current="page"]`).waitForExist();
    expect(
      await $(`[data-testid="${TID_SETTINGS_NATIVE_SEARCH_SWITCH}"]`).getAttribute("aria-checked"),
    ).toBe(String(!previous));
  });

  it("SAB03：中英文、深浅主题、桌面与窄屏 Web 布局可读", async () => {
    const classes = await browser.execute(() =>
      [...document.documentElement.classList].filter((value) => value.startsWith("platform-")),
    );
    try {
      for (const width of [1200, 390]) {
        await browser.electron.execute(async (electron, width) => {
          const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
            candidate.isVisible(),
          );
          if (!window) throw new Error("No visible renderer");
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
          classes,
        );
        for (const theme of ["zai-light", "zai-dark"]) {
          for (const locale of ["zh-CN", "en-US"]) {
            await browser.execute(
              (theme, locale) => {
                const actions = (
                  window as typeof window & {
                    __testActions?: {
                      setTheme(value: string): void;
                      setLocale(value: string): void;
                    };
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
            await clickTestIdByDom(agentNav);
            for (const target of [
              TID_SETTINGS_TOOL_SEARCH_SELECT,
              "settings-plugin-auto-recommendation",
            ]) {
              await $(`[data-testid="${target}"]`).scrollIntoView();
              const bounds = await browser.execute((target) => {
                const rect = document
                  .querySelector(`[data-testid="${target}"]`)!
                  .getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: innerWidth };
              }, target);
              expect(bounds.left).toBeGreaterThanOrEqual(0);
              expect(bounds.right).toBeLessThanOrEqual(bounds.width);
              await browser.saveScreenshot(
                join(
                  process.env.ZCODE_E2E_ARTIFACT_DIR!,
                  `agent-settings-${width}-${theme}-${locale}-${target}.png`,
                ),
              );
            }
          }
        }
      }
    } finally {
      await browser.execute(
        (classes) => document.documentElement.classList.add(...classes),
        classes,
      );
      await browser.electron.execute(async (electron) => {
        const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
          candidate.isVisible(),
        );
        await window?.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      });
    }
  });
});

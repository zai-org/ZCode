import { join } from "node:path";
import { TID_AUTOMATIONS_OPEN, TID_TASK_NEW_BUTTON } from "@zcode/shared/test-ids";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("桌面侧栏主导航", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  it("SNAV01：桌面保留自动化和插件市场入口及导航", async () => {
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
            if (!actions) throw new Error("缺少界面测试入口");
            actions.setTheme(theme);
            actions.setLocale(locale);
          },
          theme,
          locale,
        );
        const navigation = $('[data-testid="sidebar-primary-navigation"]');
        await navigation.waitForDisplayed();
        const automation = navigation.$(`[data-testid="${TID_AUTOMATIONS_OPEN}"]`);
        const plugins = navigation.$('[data-testid="plugin-store-sidebar-open"]');
        await automation.waitForDisplayed();
        await plugins.waitForDisplayed();
        expect(await navigation.$(`[data-testid="${TID_TASK_NEW_BUTTON}"]`).isDisplayed()).toBe(
          true,
        );
        await automation.click();
        await browser.waitUntil(
          async () => (await automation.getAttribute("aria-pressed")) === "true",
        );
        await plugins.click();
        await browser.waitUntil(
          async () => (await plugins.getAttribute("aria-pressed")) === "true",
        );
        expect(await automation.getAttribute("aria-pressed")).toBe("false");
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `sidebar-navigation-${theme}-${locale}.png`),
        );
      }
    }
  });
});

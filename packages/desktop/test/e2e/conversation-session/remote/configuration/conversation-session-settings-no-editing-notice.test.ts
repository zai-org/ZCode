import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 截图不需要 SSH，独立运行以避免被远端队列的环境门禁整份排除。
describe("E2E_REMOTE_SETTINGS_SAFEGUARDS: 设置防护、连接编辑与机器标注", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("设置分区不显示正在编辑提示", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/settings-notice",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await browser.execute((value) => {
        const actions = (
          window as Window & {
            __testActions?: { setTheme(theme: "zai-light" | "zai-dark"): void };
          }
        ).__testActions;
        if (!actions) throw new Error("Missing theme actions");
        actions.setTheme(value);
      }, theme);
      for (const width of [1400, 480]) {
        await browser.electron.execute((electron, size) => {
          const window = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
          window?.setMinimumSize(360, 600);
          window?.setSize(size, 900);
        }, width);
        for (const name of [
          "general",
          "plugin",
          "mcp",
          "skill",
          "commands",
          "hooks",
          "subagents",
        ]) {
          if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()))
            await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
          await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, name));
          const frame = $("[data-settings-content-frame]");
          await frame.waitForDisplayed();
          expect(await frame.getText()).not.toMatch(/正在编辑：|Editing:/u);
          expect(await $("[data-settings-machine]").isExisting()).toBe(false);
          await browser.saveScreenshot(resolve(artifactDir, `${name}-${theme}-${width}.png`));
        }
      }
    }
  });
});

import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  capturePluginManualReview,
  clickPluginControl,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

const DOCUMENTS_ID = "documents@zcode-plugins-official";

describe("PLM-BUILTIN-UI-UNINSTALL 内置 UI 插件卸载后的分组", () => {
  after(async () => {
    await clearAppData();
  });

  it("卸载内置 Word 插件后仍归在 UI 插件分组", async function () {
    this.timeout(240000);
    requirePluginManualReview();
    await openPluginSettings();
    await waitForPluginControl("plugin-store-ui-section", {}, 60000);
    await waitForPluginCard(DOCUMENTS_ID, 60000);
    await assertInUiSection("installed");
    await clickPluginControl("plugin-store-item-menu", { pluginId: DOCUMENTS_ID });
    await clickPluginControl("plugin-store-menu-uninstall", { pluginId: DOCUMENTS_ID });
    await waitForPluginControl("plugin-store-uninstall-dialog");
    await clickPluginControl("plugin-store-uninstall-confirm");
    await waitUntilPluginOverview(
      (overview) => overview.restorableBuiltins.some((plugin) => plugin.id === DOCUMENTS_ID),
      `Built-in plugin did not become restorable: ${DOCUMENTS_ID}`,
      120000,
    );
    // 旧实现中可恢复条目丢了 componentTypes 的 "ui"，卡片会掉进「生产力」分类分组。
    await assertInUiSection("restorable");
    await capturePluginManualReview("PLM-BUILTIN-UI-UNINSTALL", "restorable-in-ui-section");
  });
});

async function assertInUiSection(stage: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((id) => {
        const card = document.querySelector(
          `[data-testid="plugin-store-card"][data-plugin-id=${JSON.stringify(id)}]`,
        );
        return Boolean(card?.closest('[data-testid="plugin-store-ui-section"]'));
      }, DOCUMENTS_ID),
    {
      timeout: 30000,
      timeoutMsg: `${stage}: ${DOCUMENTS_ID} is not in the UI plugin section`,
    },
  );
}

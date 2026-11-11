import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_EXTRA_ID,
  PLUGIN_LIFECYCLE_EXTRA_NAME,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  addLifecycleMarketplaceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginOverview,
  hasPluginControl,
  installMarketplacePluginThroughAgent,
  openManageView,
  openPluginSettings,
  requirePluginManualReview,
  selectPluginSettingsScope,
  updateLifecycleExtraPluginFixture,
  updatePluginLifecycleFixture,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

describe("PLM-LC-003 全部更新失败继续候选 E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("首项源损坏后继续第二项，修复源后重试剩余项", async function () {
    this.timeout(180000);
    requirePluginManualReview();
    let fixture = await createPluginLifecycleFixture("1.0.0");
    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    for (const name of [PLUGIN_LIFECYCLE_NAME, PLUGIN_LIFECYCLE_EXTRA_NAME])
      await installMarketplacePluginThroughAgent(name, PLUGIN_LIFECYCLE_MARKETPLACE_ID);
    fixture = await updatePluginLifecycleFixture(fixture, "2.0.0");
    await updateLifecycleExtraPluginFixture(fixture, "2.0.0");
    await clickPluginControl("plugin-store-refresh");
    const ids = [PLUGIN_LIFECYCLE_ID, PLUGIN_LIFECYCLE_EXTRA_ID];
    await waitUntilPluginOverview(
      (overview) =>
        ids.every((id) =>
          overview.installedPlugins.some(
            (plugin) => plugin.id === id && plugin.updateStatus === "update-available",
          ),
        ),
      "Both plugins must be pending before the batch",
      60000,
    );
    await openManageView();
    await selectPluginSettingsScope("user");
    await waitForPluginControl("plugin-settings-update-all");
    const order = await browser.execute(
      (wanted: string[]) =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
        )
          .map((row) => row.dataset.pluginId!)
          .filter((id) => wanted.includes(id)),
      ids,
    );
    expect(order.length).toBe(2);
    const [failedId, succeededId] = order as [string, string];
    const failedName = failedId.split("@")[0]!;
    const { homeDir } = getE2EAppDataPaths();
    const original = join(fixture.marketplaceRoot, "plugins", failedName);
    const managed = join(
      homeDir,
      ".zcode",
      "cli",
      "plugins",
      "marketplaces",
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      "plugins",
      failedName,
    );
    const backup = join(homeDir, "fixtures", "update-all-backup");
    await cp(original, backup, { recursive: true });
    // 原因：directory market 同时有来源和 managed 副本；两处移除才会触发真实升级失败。
    await rm(original, { recursive: true, force: true });
    await rm(managed, { recursive: true, force: true });
    await clickPluginControl("plugin-settings-update-all");
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const toast = document.querySelector("#zcode-toast-host");
          return /Updated 1, failed 1:|已更新 1 个，1 个失败：/.test(toast?.textContent ?? "");
        }),
      { timeout: 60000, timeoutMsg: "Missing partial-success toast" },
    );
    const overview = await getPluginOverview();
    expect(overview.installedPlugins.find((plugin) => plugin.id === failedId)?.version).toBe(
      "1.0.0",
    );
    expect(overview.installedPlugins.find((plugin) => plugin.id === succeededId)?.version).toBe(
      "2.0.0",
    );
    const toastEvidence = await browser.execute(() => ({
      text: document.querySelector("#zcode-toast-host")?.textContent,
      warning: Boolean(document.querySelector("#zcode-toast-host .text-warning")),
    }));
    expect(toastEvidence.text).toMatch(
      failedId === PLUGIN_LIFECYCLE_EXTRA_ID
        ? /e2e-lifecycle-extra-1/
        : /Lifecycle Fixture|生命周期测试插件/,
    );
    expect(toastEvidence.warning).toBe(true);
    expect(await hasPluginControl("plugin-settings-update-all")).toBe(true);
    await capturePluginManualReview("PLM-LC-003", "batch-first-failed-second-updated");
    await mkdir(dirname(managed), { recursive: true });
    await cp(backup, original, { recursive: true });
    await cp(backup, managed, { recursive: true });
    await clickPluginControl("plugin-settings-update-all");
    await waitUntilPluginOverview(
      (next) =>
        ids.every((id) =>
          next.installedPlugins.some((plugin) => plugin.id === id && plugin.version === "2.0.0"),
        ),
      "Retry must upgrade the failed plugin",
      60000,
    );
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-settings-update-all")), {
      timeout: 15000,
      timeoutMsg: "Update-all should disappear only after all retries succeeded",
    });
    await capturePluginManualReview("PLM-LC-003", "batch-retry-complete");
  });
});

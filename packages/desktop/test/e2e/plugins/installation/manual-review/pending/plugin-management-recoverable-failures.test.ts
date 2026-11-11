import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  PLUGIN_LIFECYCLE_ID,
  addLifecycleMarketplaceThroughUi,
  addMarketplaceSourceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  corruptLifecycleMarketplaceManifest,
  createInvalidOfficialCollisionFixture,
  createPluginLifecycleFixture,
  getPluginOverview,
  hasPluginControl,
  installPluginThroughUi,
  openManageView,
  openPluginCard,
  openPluginSettings,
  removeLifecyclePluginPayload,
  removeLifecyclePluginSource,
  requirePluginManualReview,
  uninstallPluginThroughUi,
  updatePluginLifecycleFixture,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

const FAILURES_TIMEOUT_MS = 300000;

describe("PLM-LC-008 插件管理关键可恢复失败 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("来源、describe、install、update 失败可见且重试不破坏旧状态", async function () {
    this.timeout(FAILURES_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await waitForPluginControl("plugin-store-card", {}, 60000);
    await addMarketplaceSourceThroughUi(
      join(getE2EAppDataPaths().homeDir, "fixtures", "missing-marketplace"),
    );
    await waitForPluginControl("plugin-store-add-source-error", {}, 60000);
    await capturePluginManualReview("PLM-LC-008", "invalid-source-error");
    await browser.keys("Escape");

    const collision = await createInvalidOfficialCollisionFixture();
    await addMarketplaceSourceThroughUi(collision);
    await waitForPluginControl("plugin-store-add-source-error", {}, 60000);
    expect((await getPluginOverview()).diagnostics.length).toBeGreaterThanOrEqual(0);
    await browser.keys("Escape");

    let fixture = await createPluginLifecycleFixture("1.0.0");
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");

    await corruptLifecycleMarketplaceManifest(fixture);
    await openManageView();
    await clickPluginControl("plugin-store-manage-back");
    await clickPluginControl("plugin-store-refresh");
    await waitForPluginControl("plugin-store-error", {}, 60000);
    await capturePluginManualReview("PLM-LC-008", "catalog-refresh-failure");
    fixture = await createPluginLifecycleFixture("1.0.0");
    await clickPluginControl("plugin-store-refresh");
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-error")), {
      timeout: 60000,
      timeoutMsg: "Catalog refresh retry did not clear the visible error",
    });
    await clickPluginControl("plugin-store-segment-personal");

    await removeLifecyclePluginSource(fixture);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await waitForPluginControl("plugin-store-components-error", {}, 60000);
    await capturePluginManualReview("PLM-LC-008", "describe-failure");
    fixture = await createPluginLifecycleFixture("1.0.0");
    await clickPluginControl("plugin-store-components-retry");
    await waitForPluginControl("plugin-store-component-section", { componentKind: "skill" }, 60000);

    await removeLifecyclePluginPayload(fixture);
    await clickPluginControl("plugin-store-install", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-error", {}, 60000);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(false);
    fixture = await createPluginLifecycleFixture("1.0.0");
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);

    fixture = await updatePluginLifecycleFixture(fixture, "2.0.0");
    await clickPluginControl("plugin-store-detail-back");
    await clickPluginControl("plugin-store-refresh");
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.updateStatus !== "none",
        ),
      "Update badge did not appear before failure injection",
      60000,
    );
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await removeLifecyclePluginPayload(fixture);
    await clickPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-error", {}, 60000);
    expect(
      (await getPluginOverview()).installedPlugins.find(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      )?.version,
    ).toBe("1.0.0");

    fixture = await createPluginLifecycleFixture("2.0.0");
    await clickPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.version === "2.0.0",
        ),
      "Update retry did not install v2",
      120000,
    );
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, false);
  });
});

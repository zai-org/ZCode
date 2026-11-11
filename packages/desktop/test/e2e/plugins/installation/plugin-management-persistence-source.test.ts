import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { findUpstreamRequestContaining } from "#e2e/helpers/plugin-mcp-skill";
import { prepareV4ConversationE2E, sendV4Prompt } from "#e2e/helpers/v4-conversation";
import {
  PLUGIN_LIFECYCLE_CONFIG_VALUE,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  addLifecycleMarketplaceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  configureLifecyclePluginThroughUi,
  createPluginLifecycleFixture,
  getPluginList,
  getPluginOverview,
  hasPluginControl,
  installPluginThroughUi,
  openManageView,
  openPluginCard,
  openPluginSettings,
  readPluginConfigOptions,
  removeMarketplaceSourceThroughUi,
  requirePluginManualReview,
  restartPluginLifecycleApp,
  selectPluginSettingsScope,
  setPluginEnabledThroughUi,
  uninstallPluginThroughUi,
  waitForPluginCard,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";

const PERSISTENCE_TIMEOUT_MS = 240000;

describe("PLM-LC-004/005 插件持久化、跨本地 workspace 与来源孤立 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("重启保留 user-scope 状态，删除来源后保留安装并可重新关联", async function () {
    this.timeout(PERSISTENCE_TIMEOUT_MS);
    requirePluginManualReview();

    const fixture = await createPluginLifecycleFixture();
    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    await configureLifecyclePluginThroughUi(PLUGIN_LIFECYCLE_CONFIG_VALUE);
    // 项目市场菜单写 workspace 覆盖；重启与跨项目断言需要真实 user-scope 操作。
    await clickPluginControl("plugin-store-detail-back");
    await openManageView();
    await selectPluginSettingsScope("user");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, false, "manage");

    await restartPluginLifecycleApp();
    await openPluginSettings();
    expect(
      (await getPluginOverview()).installedPlugins.find(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      )?.enabled,
    ).toBe(false);
    expect((await readPluginConfigOptions()).display_label).toBe(PLUGIN_LIFECYCLE_CONFIG_VALUE);

    const workspaceB = join(getE2EAppDataPaths().homeDir, "ZCodeProjectB");
    await mkdir(workspaceB, { recursive: true });
    expect(
      (await getPluginOverview(workspaceB)).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(true);

    await removeMarketplaceSourceThroughUi(PLUGIN_LIFECYCLE_MARKETPLACE_ID);
    expect(
      (await getPluginOverview()).marketplaces.some(
        (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      ),
    ).toBe(false);
    expect(
      (await getPluginList()).plugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
    ).toBe(true);

    await openManageView();
    await selectPluginSettingsScope("user");
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    await clickPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-source-degraded", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    await configureLifecyclePluginThroughUi(`${PLUGIN_LIFECYCLE_CONFIG_VALUE}-orphaned`);
    await clickPluginControl("plugin-settings-detail-back");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, true, "manage");
    await clickPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    expect(
      await hasPluginControl("plugin-store-menu-update", { pluginId: PLUGIN_LIFECYCLE_ID }),
    ).toBe(false);
    expect(await hasPluginControl("plugin-store-detail-update")).toBe(false);
    // 孤立插件的 updateStatus 可能残留删除来源前的值：角标、行内更新按钮、已安装条更新入口
    // 与菜单/详情入口一样，都必须以 canUpdatePluginItem（含 orphaned 排除）为准而不出现。
    for (const control of [
      "plugin-store-update-badge",
      "plugin-store-card-update",
      "plugin-store-installed-item-update",
    ]) {
      expect(await hasPluginControl(control, { pluginId: PLUGIN_LIFECYCLE_ID })).toBe(false);
    }
    await capturePluginManualReview("PLM-LC-005", "orphaned-installed-detail");

    await prepareV4ConversationE2E();
    const orphanedRuntimeRequest = `E2E_PLUGIN_LIFECYCLE_ORPHANED_REQUEST_${Date.now()}`;
    await sendV4Prompt(`${orphanedRuntimeRequest}: reply with exactly upstream-e2e-ok.`);
    await waitForUpstreamRequestContaining(orphanedRuntimeRequest, 60000);
    const orphanedRequest = await findUpstreamRequestContaining(orphanedRuntimeRequest, 60000);
    expect(JSON.stringify(orphanedRequest?.requestJson)).toContain(
      `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`,
    );

    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    expect(
      (await getPluginOverview()).marketplaces.some(
        (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      ),
    ).toBe(true);
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, true);
  });
});

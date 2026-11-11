import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginList,
  getPluginOverview,
  hasPluginControl,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  pluginStoragePath,
  waitForPluginCard,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

describe("WPL-009 Global Plugin Marketplace install E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps marketplace and installation in User inventory while Workspace stays config-only", async function () {
    this.timeout(300000);

    const fixture = await createPluginLifecycleFixture("1.0.0");
    const { storageRoot, workspace } = getE2EAppDataPaths();
    const workspaceConfigPath = join(workspace, ".zcode", "config.json");
    const userConfigPath = join(storageRoot, "cli", "config.json");
    const knownMarketplacesPath = pluginStoragePath("known_marketplaces.json");
    const marketplaceCachePath = pluginStoragePath("marketplaces", PLUGIN_LIFECYCLE_MARKETPLACE_ID);

    await waitForDefaultWorkspaceReady();
    // 插件 bridge 由 workspace App 注册，不能在全局未归类草稿等待它出现。
    await waitForWorkspaceApp(workspace, 45000);
    await startDraftFromProject(workspace);
    await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    await waitUntilPluginOverview(
      (overview) => overview.availablePlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      "Global marketplace fixture did not become available",
      60000,
    );

    expect(await readFile(knownMarketplacesPath, "utf8")).toContain(
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );
    expect(existsSync(marketplaceCachePath)).toBe(true);
    expect((await getPluginOverview(workspace, "user")).marketplaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PLUGIN_LIFECYCLE_MARKETPLACE_ID })]),
    );

    // Marketplace 只从全局入口打开；页面本身没有 scope 或 options 配置控件；未安装项不显示启停开关。
    await openPluginSettings();
    expect(await hasPluginControl("plugin-store-scope-trigger")).toBe(false);
    expect(await hasPluginControl("plugin-store-config")).toBe(false);
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID);
    expect(
      await hasPluginControl("plugin-store-enabled-switch", { pluginId: PLUGIN_LIFECYCLE_ID }),
    ).toBe(false);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);

    const userConfig = JSON.parse(await readFile(userConfigPath, "utf8")) as {
      plugins?: {
        enabledPlugins?: Record<string, boolean>;
        options?: Record<string, Record<string, unknown>>;
      };
    };
    expect(userConfig.plugins?.enabledPlugins?.[PLUGIN_LIFECYCLE_ID]).toBe(true);
    expect(userConfig.plugins?.options?.[PLUGIN_LIFECYCLE_ID]).toBeUndefined();

    const workspaceConfig = existsSync(workspaceConfigPath)
      ? (JSON.parse(await readFile(workspaceConfigPath, "utf8")) as {
          plugins?: {
            extraKnownMarketplaces?: Record<string, unknown>;
            enabledPlugins?: Record<string, boolean>;
            options?: Record<string, Record<string, unknown>>;
          };
        })
      : {};
    expect(workspaceConfig.plugins?.extraKnownMarketplaces).toBeUndefined();
    expect(workspaceConfig.plugins?.enabledPlugins?.[PLUGIN_LIFECYCLE_ID]).toBeUndefined();
    expect(workspaceConfig.plugins?.options?.[PLUGIN_LIFECYCLE_ID]).toBeUndefined();

    const workspaceProjection = (
      await getPluginList(workspace, undefined, "workspace")
    ).plugins.find((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID);
    const userProjection = (await getPluginList(workspace, undefined, "user")).plugins.find(
      (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
    );
    expect(workspaceProjection).toMatchObject({ enabled: true, enabledSource: "user" });
    expect(userProjection).toMatchObject({ enabled: true, enabledSource: "user" });
  });
});

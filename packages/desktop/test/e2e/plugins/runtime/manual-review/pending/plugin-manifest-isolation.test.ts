import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_EXTRA_ID,
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  addLifecycleMarketplaceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginList,
  getPluginOverview,
  hasPluginControl,
  installPluginThroughUi,
  openPluginSettings,
  requirePluginManualReview,
  setPluginPresentation,
  setPluginEnabledThroughUi,
  waitForPluginCard,
} from "#e2e/helpers/plugin-management-lifecycle";

describe("PLM-MANIFEST-ISOLATION 插件清单兼容候选 E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("未知配置字段不阻断列表及其他插件安装，坏字段只隔离自身", async function () {
    this.timeout(180000);
    requirePluginManualReview();
    const fixture = await createPluginLifecycleFixture("1.0.0");
    const path = join(fixture.pluginRoot, ".zcode-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.userConfig.track = { type: "string", default: "auto", options: ["auto", "transform"] };
    manifest.userConfig.panel = { type: "string", default: "auto", options: ["auto", "off"] };
    await writeFile(path, JSON.stringify(manifest));
    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, false, "market");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, true, "market");
    const list = await getPluginList();
    const plugin = list.plugins.find((item) => item.id === PLUGIN_LIFECYCLE_ID)!;
    expect(plugin.userConfig?.track).toEqual({ type: "string", default: "auto" });
    expect(plugin.userConfig?.panel).toEqual({ type: "string", default: "auto" });
    expect(plugin.skillRootCount).toBeGreaterThan(0);
    expect(
      JSON.parse(await readFile(join(plugin.rootPath, ".zcode-plugin", "plugin.json"), "utf8"))
        .userConfig.track.options,
    ).toEqual(["auto", "transform"]);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_EXTRA_ID);
    await clickPluginControl("plugin-store-refresh");
    await waitForPluginCard(PLUGIN_LIFECYCLE_EXTRA_ID);
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (item) => item.id === PLUGIN_LIFECYCLE_EXTRA_ID,
      ),
    ).toBe(true);
    for (const theme of ["zai-dark", "zai-light"] as const) {
      await setPluginPresentation({
        locale: theme === "zai-dark" ? "zh-CN" : "en-US",
        theme,
        width: 1200,
        height: 900,
      });
      await capturePluginManualReview("PLM-MANIFEST-ISOLATION", `compatible-${theme}`);
    }
    const installedPath = join(plugin.rootPath, ".zcode-plugin", "plugin.json");
    manifest.userConfig.track.type = "invalid";
    await writeFile(installedPath, JSON.stringify(manifest));
    const invalid = await getPluginList();
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "plugin_manifest_invalid",
        pluginId: `${PLUGIN_LIFECYCLE_NAME}@${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`,
      }),
    );
    expect(invalid.plugins.some((item) => item.id === PLUGIN_LIFECYCLE_EXTRA_ID)).toBe(true);
  });
});

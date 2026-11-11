import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZCodePluginInfo } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  getPluginOverview,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginCard,
} from "#e2e/helpers/plugin-management-lifecycle";

const OFFICIAL_CDN_MARKETPLACE_ID = "zcode-plugins-official";
const OFFICIAL_CDN_PLUGIN_NAME = "example-plugin";
const OFFICIAL_CDN_PLUGIN_ID = `${OFFICIAL_CDN_PLUGIN_NAME}@${OFFICIAL_CDN_MARKETPLACE_ID}`;
const OFFICIAL_CDN_SMOKE_TIMEOUT_MS = 240000;

describe("PLM-LC-007b Desktop real official CDN ZIP smoke", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("通过真实 Public 刷新和详情安装 official CDN plugin", async function () {
    this.timeout(OFFICIAL_CDN_SMOKE_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await clickPluginControl("plugin-store-refresh");
    await waitForPluginCard(OFFICIAL_CDN_PLUGIN_ID, 180000);
    const before = await getPluginOverview();
    const available = before.availablePlugins.find(
      (plugin) => plugin.id === OFFICIAL_CDN_PLUGIN_ID,
    );
    expect(before.marketplaces.some((item) => item.id === OFFICIAL_CDN_MARKETPLACE_ID)).toBe(true);
    expect(available).toMatchObject({
      installed: false,
      marketplace: OFFICIAL_CDN_MARKETPLACE_ID,
      name: OFFICIAL_CDN_PLUGIN_NAME,
    });
    if (!available?.version) throw new Error("Official CDN example-plugin has no version");

    await openPluginCard(OFFICIAL_CDN_PLUGIN_ID);
    await capturePluginManualReview("PLM-LC-007b", "real-official-cdn-detail");
    await installPluginThroughUi(OFFICIAL_CDN_PLUGIN_ID);

    const cacheRoot = join(
      getE2EAppDataPaths().homeDir,
      ".zcode",
      "cli",
      "plugins",
      "cache",
      OFFICIAL_CDN_MARKETPLACE_ID,
      OFFICIAL_CDN_PLUGIN_NAME,
      available.version,
    );
    expect(existsSync(join(cacheRoot, ".claude-plugin", "plugin.json"))).toBe(true);
    const installedState = JSON.parse(
      readFileSync(
        join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "plugins", "installed_plugins.json"),
        "utf-8",
      ),
    ) as {
      plugins?: Array<{
        id?: string;
        source?: { sha256?: string; type?: string };
        version?: string;
      }>;
    };
    expect(
      installedState.plugins?.find((plugin) => plugin.id === OFFICIAL_CDN_PLUGIN_ID),
    ).toMatchObject({
      source: { type: "zip" },
      version: available.version,
    });

    const plugin = (await getPluginList()).plugins.find(
      (item) => item.id === OFFICIAL_CDN_PLUGIN_ID,
    );
    expect(plugin).toMatchObject({
      enabled: true,
      rootPath: cacheRoot,
      version: available.version,
    });
    expect(componentNames(plugin, "skill")).toContain("example-skill");
    expect(componentNames(plugin, "command")).toContain("hello");
  });
});

function componentNames(plugin: ZCodePluginInfo | undefined, kind: "command" | "skill"): string[] {
  return (
    plugin?.components?.find((group) => group.kind === kind)?.items.map((item) => item.name) ?? []
  );
}

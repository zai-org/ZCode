import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZCodePluginInfo } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  PLUGIN_CDN_ZIP_ARCHIVE_PATH,
  PLUGIN_CDN_ZIP_ID,
  PLUGIN_CDN_ZIP_MARKETPLACE_ID,
  PLUGIN_CDN_ZIP_NAME,
  PLUGIN_CDN_ZIP_VERSION,
} from "#e2e/helpers/plugin-cdn-zip-marketplace";
import {
  capturePluginManualReview,
  getPluginList,
  getPluginOverview,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginCard,
} from "#e2e/helpers/plugin-management-lifecycle";

const ZIP_PLUGIN_INSTALL_TIMEOUT_MS = 180000;

describe("PLM-LC-007 Desktop official CDN ZIP plugin UI lifecycle", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("从 Public 卡片和详情入口安装本地确定性 official CDN ZIP", async function () {
    this.timeout(ZIP_PLUGIN_INSTALL_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await waitForPluginCard(PLUGIN_CDN_ZIP_ID, 60000);
    const before = await getPluginOverview();
    expect(
      before.marketplaces.filter((item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID),
    ).toHaveLength(1);
    expect(before.availablePlugins.find((plugin) => plugin.id === PLUGIN_CDN_ZIP_ID)).toMatchObject(
      {
        installed: false,
        marketplace: PLUGIN_CDN_ZIP_MARKETPLACE_ID,
        name: PLUGIN_CDN_ZIP_NAME,
        version: PLUGIN_CDN_ZIP_VERSION,
      },
    );

    await openPluginCard(PLUGIN_CDN_ZIP_ID);
    await capturePluginManualReview("PLM-LC-007", "official-cdn-local-detail");
    await installPluginThroughUi(PLUGIN_CDN_ZIP_ID);

    const paths = getE2EAppDataPaths();
    const pluginStorageRoot = join(paths.homeDir, ".zcode", "cli", "plugins");
    const cacheRoot = join(
      pluginStorageRoot,
      "cache",
      PLUGIN_CDN_ZIP_MARKETPLACE_ID,
      PLUGIN_CDN_ZIP_NAME,
      PLUGIN_CDN_ZIP_VERSION,
    );
    assertCacheMaterialized(cacheRoot);
    assertInstalledRecord(pluginStorageRoot, cacheRoot);

    const plugin = (await getPluginList()).plugins.find((item) => item.id === PLUGIN_CDN_ZIP_ID);
    expect(plugin).toMatchObject({
      commandRootCount: 1,
      enabled: true,
      rootPath: cacheRoot,
      skillRootCount: 1,
      version: PLUGIN_CDN_ZIP_VERSION,
    });
    expect(componentNames(plugin, "skill")).toContain("zip-skill");
    expect(componentNames(plugin, "command")).toContain("zip-command");
  });
});

function assertCacheMaterialized(cacheRoot: string): void {
  expect(existsSync(join(cacheRoot, ".claude-plugin", "plugin.json"))).toBe(true);
  expect(existsSync(join(cacheRoot, "skills", "zip-skill", "SKILL.md"))).toBe(true);
  expect(existsSync(join(cacheRoot, "commands", "zip-command.md"))).toBe(true);
}

function assertInstalledRecord(pluginStorageRoot: string, cacheRoot: string): void {
  const state = JSON.parse(
    readFileSync(join(pluginStorageRoot, "installed_plugins.json"), "utf-8"),
  ) as {
    plugins?: Array<{
      id?: string;
      installPath?: string;
      source?: { sha256?: string; source?: string; type?: string; url?: string };
      version?: string;
    }>;
  };
  const record = state.plugins?.find((plugin) => plugin.id === PLUGIN_CDN_ZIP_ID);
  expect(record).toMatchObject({
    id: PLUGIN_CDN_ZIP_ID,
    installPath: cacheRoot,
    version: PLUGIN_CDN_ZIP_VERSION,
  });
  expect(record?.source).toMatchObject({ source: "url", type: "zip" });
  expect(record?.source?.url ?? "").toContain(PLUGIN_CDN_ZIP_ARCHIVE_PATH);
  expect(record?.source?.sha256 ?? "").toMatch(/^[a-f0-9]{64}$/u);
}

function componentNames(plugin: ZCodePluginInfo | undefined, kind: "command" | "skill"): string[] {
  return (
    plugin?.components?.find((group) => group.kind === kind)?.items.map((item) => item.name) ?? []
  );
}

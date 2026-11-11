import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  getPluginList,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  waitUntilPluginList,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";
import { PLUGIN_MCP_PLUGIN_ID } from "#e2e/helpers/plugin-mcp-skill";
import {
  assertWorkspacePluginUnavailable,
  pluginConfigEnabled,
  readUserPluginConfig,
  readWorkspacePluginConfig,
} from "#e2e/helpers/workspace-plugin-runtime";

describe("WPL-002 Workspace Plugin explicit false precedence E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("lets Workspace false override User true and keeps the package installed", async function () {
    this.timeout(180000);

    expect(pluginConfigEnabled(await readUserPluginConfig())).toBe(true);
    expect(pluginConfigEnabled(await readWorkspacePluginConfig())).toBe(false);
    const plugin = (await getPluginList()).plugins.find((item) => item.id === PLUGIN_MCP_PLUGIN_ID);
    expect(plugin).toMatchObject({ enabled: false, enabledSource: "workspace" });
    expect(plugin?.rootPath).toBeTruthy();

    const { storageRoot } = getE2EAppDataPaths();
    const installedPluginsPath = join(storageRoot, "cli", "plugins", "installed_plugins.json");
    const installedBefore = await readFile(installedPluginsPath, "utf8");

    // resident App 的 Plugin catalog 在创建时冻结；先用 seed 的显式 false 验证新 Session
    // 不广告工具，再切换配置验证 package/config 解耦，避免把 WPL-008 的热更新语义混入本 case。
    await assertWorkspacePluginUnavailable("E2E_PLUGIN_MCP_PING_DISABLED");

    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-enabled-switch", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    await clickTestIdByDom("plugin-settings-enabled-switch");
    await waitUntilPluginList(
      (list) => list.plugins.some((item) => item.id === PLUGIN_MCP_PLUGIN_ID && item.enabled),
      "Workspace enable did not update the effective Plugin state",
    );
    await clickTestIdByDom("plugin-settings-enabled-switch");
    await waitUntilPluginList(
      (list) => list.plugins.some((item) => item.id === PLUGIN_MCP_PLUGIN_ID && !item.enabled),
      "Workspace disable did not update the effective Plugin state",
    );
    expect(await readFile(installedPluginsPath, "utf8")).toBe(installedBefore);
    expect(pluginConfigEnabled(await readWorkspacePluginConfig())).toBe(false);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  });
});

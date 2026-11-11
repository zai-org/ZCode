import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  getPluginList,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";
import { PLUGIN_MCP_PLUGIN_ID } from "#e2e/helpers/plugin-mcp-skill";
import {
  assertWorkspacePluginRuntime,
  pluginConfigEnabled,
  readWorkspacePluginConfig,
} from "#e2e/helpers/workspace-plugin-runtime";

describe("WPL-002 Workspace Plugin User inheritance and cold-start reload E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("inherits User enablement when Workspace omits the key", async function () {
    this.timeout(240000);

    expect(pluginConfigEnabled(await readWorkspacePluginConfig())).toBeUndefined();
    const plugin = (await getPluginList()).plugins.find((item) => item.id === PLUGIN_MCP_PLUGIN_ID);
    expect(plugin).toMatchObject({ enabled: true, enabledSource: "user" });

    // User/Workspace 是同一 Host inventory 的两个配置视图。切到 Workspace 后仍应看到
    // 继承的插件；列表不再显示来源标签，继承来源由上面的 Agent 投影断言验证。
    await openPluginManagementSettings();
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    expect(
      await browser.execute((pluginId) => {
        const row = document.querySelector<HTMLElement>(
          `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${pluginId}"]`,
        );
        return {
          checked:
            row?.querySelector<HTMLElement>('[data-testid="plugin-settings-enabled-switch"]')
              ?.dataset.state === "checked",
          source:
            row?.querySelector<HTMLElement>("[data-settings-scope]")?.dataset.settingsScope ?? null,
        };
      }, PLUGIN_MCP_PLUGIN_ID),
    ).toEqual({ checked: true, source: null });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    await assertWorkspacePluginRuntime("E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED");
  });
});

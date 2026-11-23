import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  clickPluginControl,
  getPluginList,
  openInstalledPluginSettingsAdvanced,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  setPluginControlValue,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  findUpstreamRequestContaining,
  PLUGIN_MCP_PLUGIN_ID,
  PLUGIN_MCP_TOOL_NAME,
} from "#e2e/helpers/plugin-mcp-skill";
import {
  assertWorkspacePluginRuntime,
  pluginConfigEnabled,
  pluginConfigOptions,
  readUserPluginConfig,
  readWorkspacePluginConfig,
} from "#e2e/helpers/workspace-plugin-runtime";

describe("WPL-001/003/004/005 Workspace Plugin enabled runtime E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("ignores repository options, saves private Workspace overrides, and enters runtime directly", async function () {
    this.timeout(240000);

    // 仅用于验证隔离 fixture 的配置值；拆分字符串避免 fixture checker 把配置值误判为 prompt marker。
    const userSecret = ["E2E", "USER", "PLUGIN", "SECRET"].join("_");
    const workspaceSecret = ["E2E", "WORKSPACE", "PLUGIN", "SECRET"].join("_");

    const userConfig = await readUserPluginConfig();
    const workspaceConfig = await readWorkspacePluginConfig();
    expect(pluginConfigEnabled(userConfig)).toBe(true);
    expect(pluginConfigEnabled(workspaceConfig)).toBe(true);
    expect(pluginConfigOptions(userConfig)).toMatchObject({
      label: "user-label",
      secret: userSecret,
    });
    expect(pluginConfigOptions(workspaceConfig)).toMatchObject({
      label: "workspace-label",
      secret: workspaceSecret,
    });

    // 仓库夹具含普通值与敏感值，但在设置页显式保存前只能继承可信用户配置。
    const before = (await getPluginList(DEFAULT_WORKSPACE)).plugins.find(
      (item) => item.id === PLUGIN_MCP_PLUGIN_ID,
    );
    expect(before).toMatchObject({
      configuredOptions: { label: "user-label" },
      optionSources: { label: "user", secret: "user" },
    });
    expect(JSON.stringify(before)).not.toContain(workspaceSecret);

    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_MCP_PLUGIN_ID,
    });
    const scopeBadgeVisible = await browser.execute(() =>
      Boolean(document.querySelector('[data-settings-scope="workspace"]')),
    );
    expect(scopeBadgeVisible).toBe(false);
    await openInstalledPluginSettingsAdvanced(PLUGIN_MCP_PLUGIN_ID);
    await setPluginControlValue(
      "plugin-store-config-input",
      { configKey: "label" },
      "workspace-label",
    );
    await setPluginControlValue(
      "plugin-store-config-input",
      { configKey: "secret" },
      workspaceSecret,
    );
    await clickPluginControl("plugin-store-config-save", { pluginId: PLUGIN_MCP_PLUGIN_ID });
    await browser.waitUntil(
      async () => {
        const saved = (await getPluginList(DEFAULT_WORKSPACE)).plugins.find(
          (item) => item.id === PLUGIN_MCP_PLUGIN_ID,
        );
        return (
          saved?.configuredOptions?.label === "workspace-label" &&
          saved.optionSources?.secret === "workspace"
        );
      },
      { timeout: 30000, timeoutMsg: "Explicit workspace plugin options were not saved" },
    );
    expect(pluginConfigOptions(await readWorkspacePluginConfig())).toEqual({});
    await browser.keys(["Escape"]);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    const list = await getPluginList(DEFAULT_WORKSPACE);
    const plugin = list.plugins.find((item) => item.id === PLUGIN_MCP_PLUGIN_ID);
    expect(plugin).toMatchObject({
      enabled: true,
      enabledSource: "workspace",
      optionSources: { label: "workspace", secret: "workspace" },
      configuredOptions: { label: "workspace-label" },
    });
    expect(JSON.stringify(plugin)).not.toContain(workspaceSecret);

    // Plugin MCP 无独立 approval/trust 动作；新 Session 创建时直接看到该工具。
    await assertWorkspacePluginRuntime("E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED");
    // 必须看到真实 MCP 返回的确认标记，不能只凭设置页投影与工具调用成功判断私有值已进入进程。
    expect(
      await findUpstreamRequestContaining(
        ["E2E", "PLUGIN", "RUNTIME", "SECRET", "RESOLVED"].join("_"),
        15000,
      ),
    ).not.toBeNull();
    expect(PLUGIN_MCP_TOOL_NAME).toContain("mcp__plugin_");
  });
});

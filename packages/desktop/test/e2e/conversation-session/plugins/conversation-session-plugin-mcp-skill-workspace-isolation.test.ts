import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { getPluginList } from "#e2e/helpers/plugin-management-lifecycle";
import { PLUGIN_MCP_PLUGIN_ID } from "#e2e/helpers/plugin-mcp-skill";
import {
  pluginConfigEnabled,
  readWorkspacePluginConfig,
} from "#e2e/helpers/workspace-plugin-runtime";

describe("WPL-001 Workspace Plugin workspace isolation E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps User projection clean while Workspace A overrides and B inherits", async function () {
    this.timeout(120000);

    const { homeDir, workspace } = getE2EAppDataPaths();
    const workspaceB = `${homeDir}/WorkspaceB`;
    expect(pluginConfigEnabled(await readWorkspacePluginConfig())).toBe(true);
    const userPluginA = (await getPluginList(workspace, undefined, "user")).plugins.find(
      (item) => item.id === PLUGIN_MCP_PLUGIN_ID,
    );
    const workspacePluginA = (await getPluginList(workspace, undefined, "workspace")).plugins.find(
      (item) => item.id === PLUGIN_MCP_PLUGIN_ID,
    );
    const userPluginB = (await getPluginList(workspaceB, undefined, "user")).plugins.find(
      (item) => item.id === PLUGIN_MCP_PLUGIN_ID,
    );
    const workspacePluginB = (await getPluginList(workspaceB, undefined, "workspace")).plugins.find(
      (item) => item.id === PLUGIN_MCP_PLUGIN_ID,
    );
    expect(userPluginA).toMatchObject({ enabled: false, enabledSource: "user" });
    expect(userPluginB).toMatchObject({ enabled: false, enabledSource: "user" });
    expect(workspacePluginA).toMatchObject({
      enabled: true,
      enabledSource: "workspace",
    });
    expect(workspacePluginB).toMatchObject({
      enabled: false,
      enabledSource: "user",
    });
    expect(userPluginA?.id).toBe(workspacePluginA?.id);
    expect(workspacePluginB?.rootPath).toBeTruthy();
  });
});

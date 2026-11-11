import { existsSync } from "node:fs";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { PLUGIN_MCP_PLUGIN_ID, PLUGIN_MCP_PLUGIN_ROOT } from "#e2e/helpers/plugin-mcp-skill";
import {
  assertWorkspacePluginUnavailable,
  readWorkspacePluginConfig,
} from "#e2e/helpers/workspace-plugin-runtime";

describe("WPL-014 Workspace Plugin root E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("ignores a project Plugin root without a User package record", async function () {
    this.timeout(240000);

    const { storageRoot } = getE2EAppDataPaths();
    const workspaceConfig = await readWorkspacePluginConfig();
    expect(workspaceConfig.plugins).toMatchObject({
      dirs: [PLUGIN_MCP_PLUGIN_ROOT],
      enabledPlugins: { [PLUGIN_MCP_PLUGIN_ID]: true },
    });

    const installedRecordsPath = join(storageRoot, "cli", "plugins", "installed_plugins.json");
    expect(existsSync(installedRecordsPath)).toBe(false);

    // 仓库中的目录声明不是用户安装授权，真实模型请求不能携带该插件的 MCP 工具。
    await assertWorkspacePluginUnavailable("E2E_PLUGIN_MCP_PING_WORKSPACE_ROOT");
  });
});

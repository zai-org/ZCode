import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
} from "#e2e/helpers/desktop-app";
import { PLUGIN_MCP_PLUGIN_ID, PLUGIN_MCP_PLUGIN_ROOT } from "#e2e/helpers/plugin-mcp-skill";
import {
  clickPluginControl,
  getPluginList,
  hasPluginControl,
  openPluginManagementSettings,
  selectPluginSettingsScope,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  assertWorkspacePluginRuntime,
  assertWorkspacePluginUnavailable,
  readWorkspacePluginConfig,
} from "#e2e/helpers/workspace-plugin-runtime";

// 项目 plugins.dirs 声明的目录插件按 manifest 名挂在 inline 市场下。
const WORKSPACE_PLUGIN_ID = "e2e-plugin-mcp-ping@inline";

async function workspacePluginTrustState(): Promise<string | undefined> {
  const list = await getPluginList(DEFAULT_WORKSPACE, undefined, "workspace");
  return list.plugins.find((plugin) => plugin.id === WORKSPACE_PLUGIN_ID)?.workspaceTrust?.state;
}

describe("WPL-014 Workspace Plugin root E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps a project Plugin root pending until the user trusts it in Settings", async function () {
    this.timeout(300000);

    const { storageRoot } = getE2EAppDataPaths();
    const workspaceConfig = await readWorkspacePluginConfig();
    expect(workspaceConfig.plugins).toMatchObject({
      dirs: [PLUGIN_MCP_PLUGIN_ROOT],
      enabledPlugins: { [PLUGIN_MCP_PLUGIN_ID]: true },
    });
    const installedRecordsPath = join(storageRoot, "cli", "plugins", "installed_plugins.json");
    expect(existsSync(installedRecordsPath)).toBe(false);

    // docs/plugins/workspace-plugin-dir-trust.md：仓库声明不是用户授权，未信任时插件强制停用，
    // 真实模型请求不能携带它的 MCP 工具。
    expect(await workspacePluginTrustState()).toBe("pending");
    await assertWorkspacePluginUnavailable("E2E_PLUGIN_MCP_PING_WORKSPACE_ROOT");

    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-trust-pending", { pluginId: WORKSPACE_PLUGIN_ID });
    const switchDisabled = await browser.execute((pluginId) => {
      const control = document.querySelector<HTMLButtonElement>(
        `[data-testid="plugin-settings-enabled-switch"][data-plugin-id="${pluginId}"]`,
      );
      return control?.disabled === true && control.getAttribute("data-state") === "unchecked";
    }, WORKSPACE_PLUGIN_ID);
    expect(switchDisabled).toBe(true);

    await clickPluginControl("plugin-settings-trust", { pluginId: WORKSPACE_PLUGIN_ID });
    await browser.waitUntil(async () => (await workspacePluginTrustState()) === "trusted", {
      timeout: 30000,
      timeoutMsg: "Workspace plugin trust was not recorded",
    });
    await browser.waitUntil(
      async () =>
        !(await hasPluginControl("plugin-settings-trust-pending", {
          pluginId: WORKSPACE_PLUGIN_ID,
        })),
      { timeout: 30000, timeoutMsg: "Pending trust badge did not disappear after trust" },
    );
    // 信任只写进用户域存储；项目文件保持原样。
    const trustStore = JSON.parse(
      await readFile(join(storageRoot, "security", "workspace-plugin-trust-v1.json"), "utf8"),
    ) as { records: Array<{ pluginRoot: string }> };
    expect(trustStore.records).toHaveLength(1);
    expect(await readWorkspacePluginConfig()).toEqual(workspaceConfig);

    await browser.keys(["Escape"]);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    // 新会话按信任重新发现插件：模型请求带上插件工具，并真实调用一次。
    await assertWorkspacePluginRuntime("E2E_PLUGIN_MCP_PING_WORKSPACE_TRUSTED");
  });
});

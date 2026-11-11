import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  getPluginList,
  getPluginReferenceCatalog,
  pluginDataPath,
  pluginPathExists,
  pluginStoragePath,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_MARKER = "E2E_WPL_013_BUILTIN_WORKSPACE_DISABLE";
const BUILTIN_ID = "skill-creator@zcode-plugins-official";

describe("WPL-013 builtin Workspace disable E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("disables the builtin only in Workspace A while preserving Host user state", async function () {
    this.timeout(120_000);

    const { homeDir, storageRoot, workspace: workspaceA } = getE2EAppDataPaths();
    const workspaceB = join(homeDir, "WorkspaceB");
    const workspaceAConfigPath = join(workspaceA, ".zcode", "config.json");
    const workspaceBConfigPath = join(workspaceB, ".zcode", "config.json");
    const userConfigPath = join(storageRoot, "cli", "config.json");
    const installedPluginsPath = pluginStoragePath("installed_plugins.json");
    const dataPath = join(pluginDataPath(BUILTIN_ID), "state.json");

    const workspaceAConfigBefore = await readFile(workspaceAConfigPath, "utf8");
    const userConfigBefore = await readFile(userConfigPath, "utf8");
    const installedPluginsBefore = await readOptionalFile(installedPluginsPath);
    const pluginDataBefore = await readFile(dataPath, "utf8");
    expect(await pathExists(workspaceBConfigPath)).toBe(false);

    const pluginA = (await getPluginList(workspaceA)).plugins.find(
      (plugin) => plugin.id === BUILTIN_ID,
    );
    const pluginB = (await getPluginList(workspaceB)).plugins.find(
      (plugin) => plugin.id === BUILTIN_ID,
    );
    if (!pluginA || !pluginB) {
      throw new Error(`${CASE_MARKER}: builtin Plugin 没有在 A/B resolver 中出现`);
    }
    expect(pluginA).toMatchObject({
      enabled: false,
      enabledSource: "workspace",
    });
    expect(pluginB).toMatchObject({
      enabled: true,
      enabledSource: "user",
    });
    expect(pluginA.rootPath).toBe(pluginB.rootPath);
    expect(pluginPathExists(pluginA.rootPath)).toBe(true);

    const catalogA = await getPluginReferenceCatalog({
      workspacePath: workspaceA,
    });
    const catalogB = await getPluginReferenceCatalog({
      workspacePath: workspaceB,
    });
    expect(catalogA.authority).toBe("workspace");
    expect(catalogB.authority).toBe("workspace");
    expect(catalogA.plugins.find((plugin) => plugin.pluginId === BUILTIN_ID)).toMatchObject({
      enabled: false,
    });
    expect(catalogB.plugins.find((plugin) => plugin.pluginId === BUILTIN_ID)).toMatchObject({
      enabled: true,
    });

    expect(await readFile(workspaceAConfigPath, "utf8")).toBe(workspaceAConfigBefore);
    expect(await pathExists(workspaceBConfigPath)).toBe(false);
    expect(await readFile(userConfigPath, "utf8")).toBe(userConfigBefore);
    expect(await readOptionalFile(installedPluginsPath)).toBe(installedPluginsBefore);
    expect(await readFile(dataPath, "utf8")).toBe(pluginDataBefore);
    expect(pluginPathExists(pluginA.rootPath)).toBe(true);
  });
});

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

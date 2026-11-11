import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginList,
  hasPluginControl,
  installPluginThroughUi,
  setPluginEnabledThroughUi,
  openInstalledPluginSettingsDetail,
  openPluginCard,
  openPluginSettings,
  openPluginManagementSettings,
  PLUGIN_LIFECYCLE_CONFIG_KEY,
  PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY,
  PLUGIN_LIFECYCLE_CONFIG_VALUE,
  PLUGIN_LIFECYCLE_ID,
  waitForPluginCard,
  waitForPluginControl,
  waitForPluginSettingsScope,
  waitUntilPluginOverview,
  selectPluginSettingsScope,
} from "#e2e/helpers/plugin-management-lifecycle";

describe("WPL-015 Marketplace installed roundtrip E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("returns to chat after global install, then manages User and Workspace configuration", async function () {
    this.timeout(240000);

    const fixture = await createPluginLifecycleFixture("1.0.0");
    const { storageRoot, workspace } = getE2EAppDataPaths();
    const userConfigPath = join(storageRoot, "cli", "config.json");
    const workspaceConfigPath = join(workspace, ".zcode", "config.json");

    await waitForDefaultWorkspaceReady();
    await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    await waitUntilPluginOverview(
      (overview) => overview.availablePlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      "WPL-015 marketplace fixture did not become available",
      60000,
    );

    await openPluginSettings();
    expect(await hasPluginControl("plugin-store-scope-trigger")).toBe(false);
    expect(await hasPluginControl("plugin-store-config")).toBe(false);

    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID);
    expect(
      await hasPluginControl("plugin-store-enabled-switch", { pluginId: PLUGIN_LIFECYCLE_ID }),
    ).toBe(false);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    await clickPluginControl("plugin-store-detail-back");
    await waitForPluginControl("plugin-store-enabled-switch", { pluginId: PLUGIN_LIFECYCLE_ID });
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, false, "market");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, true, "market");
    await clickTestIdByDom("desktop-top-nav-back");
    await openPluginManagementSettings();
    await waitForPluginSettingsScope("user");
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    expect(await readInstalledPluginRowState(PLUGIN_LIFECYCLE_ID)).toEqual({
      checked: true,
      source: null,
    });
    const userConfigAfterInstall = await readJsonFile(userConfigPath);
    expect(readEnabledPlugins(userConfigAfterInstall)[PLUGIN_LIFECYCLE_ID]).toBe(true);

    // 先在 User 视图保存一个值，Workspace 视图应显示它，但不能把其它 default
    // effective 值一起当作 Workspace 配置写回。
    await openInstalledPluginSettingsDetail(PLUGIN_LIFECYCLE_ID);
    await clickPluginControl("plugin-store-advanced");
    await setPluginControlValueForRoundtrip(
      PLUGIN_LIFECYCLE_CONFIG_KEY,
      PLUGIN_LIFECYCLE_CONFIG_VALUE,
    );
    await clickPluginControl("plugin-store-config-save", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    await browser.waitUntil(
      async () =>
        readPluginOptions(await readJsonFile(userConfigPath))[PLUGIN_LIFECYCLE_CONFIG_KEY] ===
        PLUGIN_LIFECYCLE_CONFIG_VALUE,
      {
        timeout: 30000,
        timeoutMsg: "User Plugin option did not persist before Workspace roundtrip",
      },
    );

    await clickPluginControl("plugin-settings-detail-back");
    await selectPluginSettingsScope("workspace");
    expect(await hasPluginControl("plugin-store-browse")).toBe(false);
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    expect(await readInstalledPluginRowState(PLUGIN_LIFECYCLE_ID)).toEqual({
      checked: true,
      source: null,
    });
    await openInstalledPluginSettingsDetail(PLUGIN_LIFECYCLE_ID);
    await clickPluginControl("plugin-store-advanced");
    expect(await readPluginOptionSource(PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY)).toBe("default");
    await setPluginControlValueForRoundtrip(
      PLUGIN_LIFECYCLE_CONFIG_KEY,
      `${PLUGIN_LIFECYCLE_CONFIG_VALUE}-workspace`,
    );
    await clickPluginControl("plugin-store-config-save", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    await browser.waitUntil(
      async () =>
        readPluginOptions(await readJsonFile(workspaceConfigPath))[PLUGIN_LIFECYCLE_CONFIG_KEY] ===
        `${PLUGIN_LIFECYCLE_CONFIG_VALUE}-workspace`,
      {
        timeout: 30000,
        timeoutMsg: "Workspace Plugin option did not persist",
      },
    );
    expect(readPluginOptions(await readJsonFile(workspaceConfigPath))).toEqual({
      [PLUGIN_LIFECYCLE_CONFIG_KEY]: `${PLUGIN_LIFECYCLE_CONFIG_VALUE}-workspace`,
    });
    await waitForPluginOptionSource(PLUGIN_LIFECYCLE_CONFIG_KEY, "workspace");
    expect(await readPluginOptionSource(PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY)).toBe("default");

    await clickPluginControl("plugin-store-config-clear", {
      pluginId: PLUGIN_LIFECYCLE_ID,
      configKey: PLUGIN_LIFECYCLE_CONFIG_KEY,
    });
    await clickPluginControl("plugin-store-config-save", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    await browser.waitUntil(
      async () =>
        !Object.hasOwn(
          readPluginOptions(await readJsonFile(workspaceConfigPath)),
          PLUGIN_LIFECYCLE_CONFIG_KEY,
        ),
      {
        timeout: 30000,
        timeoutMsg: "Workspace Plugin option did not restore inheritance",
      },
    );
    await waitForPluginOptionSource(PLUGIN_LIFECYCLE_CONFIG_KEY, "user");

    // 已安装详情通过页内返回按钮回到配置列表。
    await clickPluginControl("plugin-settings-detail-back");
    await waitForPluginControl("plugin-settings-plugin-row", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    await clickPluginControl("plugin-settings-enabled-switch", {
      pluginId: PLUGIN_LIFECYCLE_ID,
    });
    await browser.waitUntil(
      async () => {
        const plugin = (await getPluginList(workspace, undefined, "workspace")).plugins.find(
          (item) => item.id === PLUGIN_LIFECYCLE_ID,
        );
        return plugin?.enabled === false && plugin.enabledSource === "workspace";
      },
      {
        timeout: 30000,
        timeoutMsg: "Workspace explicit disable did not reach the Agent projection",
      },
    );
    expect(readEnabledPlugins(await readJsonFile(workspaceConfigPath))[PLUGIN_LIFECYCLE_ID]).toBe(
      false,
    );

    await openInstalledPluginSettingsDetail(PLUGIN_LIFECYCLE_ID);
    await clickPluginControl("plugin-store-reset-config");
    await browser.waitUntil(
      async () => {
        const plugin = (await getPluginList(workspace, undefined, "workspace")).plugins.find(
          (item) => item.id === PLUGIN_LIFECYCLE_ID,
        );
        return plugin?.enabled === true && plugin.enabledSource === "user";
      },
      {
        timeout: 30000,
        timeoutMsg: "Workspace restore-inheritance did not return to User",
      },
    );
    expect(
      readEnabledPlugins(await readJsonFile(workspaceConfigPath))[PLUGIN_LIFECYCLE_ID],
    ).toBeUndefined();

    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByDom("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-root", {}, 30000);
    await clickTestIdByDom("desktop-top-nav-back");
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-root")));
    expect(await hasPluginControl("plugin-settings-scope-trigger")).toBe(false);
  });
});

async function readInstalledPluginRowState(pluginId: string): Promise<{
  checked: boolean;
  source: string | null;
}> {
  return browser.execute((id) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
    ).find((candidate) => candidate.dataset.pluginId === id);
    return {
      checked:
        row?.querySelector<HTMLElement>('[data-testid="plugin-settings-enabled-switch"]')?.dataset
          .state === "checked",
      source:
        row
          ?.querySelector<HTMLElement>("[data-settings-scope]")
          ?.getAttribute("data-settings-scope") ?? null,
    };
  }, pluginId);
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function readEnabledPlugins(config: Record<string, unknown>): Record<string, boolean> {
  const plugins =
    typeof config.plugins === "object" && config.plugins !== null
      ? (config.plugins as Record<string, unknown>)
      : {};
  return typeof plugins.enabledPlugins === "object" && plugins.enabledPlugins !== null
    ? (plugins.enabledPlugins as Record<string, boolean>)
    : {};
}

function readPluginOptions(config: Record<string, unknown>): Record<string, unknown> {
  const plugins =
    typeof config.plugins === "object" && config.plugins !== null
      ? (config.plugins as Record<string, unknown>)
      : {};
  return typeof plugins.options === "object" && plugins.options !== null
    ? (((plugins.options as Record<string, unknown>)[PLUGIN_LIFECYCLE_ID] as Record<
        string,
        unknown
      >) ?? {})
    : {};
}

async function setPluginControlValueForRoundtrip(key: string, value: string): Promise<void> {
  await waitForPluginControl("plugin-store-config-input", { configKey: key });
  const state = await browser.execute(
    (configKey, nextValue) => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-testid="plugin-store-config-input"][data-config-key="${configKey}"]`,
      );
      if (!input) return { updated: false, reason: "missing" };
      if (input.disabled || input.readOnly) {
        return {
          updated: false,
          reason: "not-editable",
          disabled: input.disabled,
          readOnly: input.readOnly,
          outerHTML: input.outerHTML,
        };
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { updated: true };
    },
    key,
    value,
  );
  if (!state.updated)
    throw new Error(`Could not set Plugin option input: ${JSON.stringify(state)}`);
}

async function readPluginOptionSource(key: string): Promise<string | null> {
  return browser.execute((configKey) => {
    const input = document.querySelector<HTMLElement>(
      `[data-testid="plugin-store-config-input"][data-config-key="${configKey}"]`,
    );
    return (
      input?.closest("label")?.querySelector<HTMLElement>("[data-settings-scope]")?.dataset
        .settingsScope ?? null
    );
  }, key);
}

async function waitForPluginOptionSource(
  key: string,
  expected: "default" | "user" | "workspace",
): Promise<void> {
  await browser.waitUntil(async () => (await readPluginOptionSource(key)) === expected, {
    timeout: 30000,
    timeoutMsg: `Plugin option source did not become ${expected}: ${key}`,
  });
}

/* eslint-disable max-lines -- 插件 lifecycle E2E 的确定性文件夹 fixture、UI 驱动和第二层证据集中维护，避免各 pending spec 重复脆弱 DOM/存储逻辑。 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ZCodePluginsInstallResult,
  type ZCodePluginsListResult,
  type ZCodePluginsMarketplaceMutationResult,
  type ZCodePluginsOverviewResult,
  type ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import {
  TID_PLUGIN_STORE_BROWSE,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "./desktop-app.js";
import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";

export const PLUGIN_LIFECYCLE_MARKETPLACE_ID = "e2e-plugin-lifecycle-market";
export const PLUGIN_LIFECYCLE_MARKETPLACE_NAME = "E2E Plugin Lifecycle Market";
export const PLUGIN_LIFECYCLE_NAME = "e2e-plugin-lifecycle";
export const PLUGIN_LIFECYCLE_ID = `${PLUGIN_LIFECYCLE_NAME}@${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`;
export const PLUGIN_LIFECYCLE_EXAMPLE_PROMPT =
  "E2E_PLUGIN_LIFECYCLE_EXAMPLE_PROMPT: summarize the fixture lifecycle";
export const PLUGIN_LIFECYCLE_CONFIG_KEY = "display_label";
export const PLUGIN_LIFECYCLE_CONFIG_VALUE = "configured-by-plugin-lifecycle-e2e";
export const PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY = "timeout_seconds";
export const PLUGIN_LIFECYCLE_MCP_TOOL_NAME =
  "mcp__plugin_e2e-plugin-lifecycle_lifecycle__version_marker";
export const PLUGIN_LIFECYCLE_RUNTIME_MARKER = "E2E_PLUGIN_LIFECYCLE_RUNTIME";
export const PLUGIN_LIFECYCLE_EXTRA_NAME = "e2e-lifecycle-extra-1";
export const PLUGIN_LIFECYCLE_EXTRA_ID = `${PLUGIN_LIFECYCLE_EXTRA_NAME}@${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`;
export const PLUGIN_INLINE_NAME = "e2e-inline-lifecycle";
export const PLUGIN_INLINE_ID = `${PLUGIN_INLINE_NAME}@inline`;
export const PLUGIN_INLINE_SUBAGENT_NAME = `${PLUGIN_INLINE_NAME}:inline-reviewer`;

export interface PluginLifecycleFixture {
  marketplaceRoot: string;
  pluginRoot: string;
  version: string;
}

type PluginTestActionName =
  | "addPluginMarketplace"
  | "getPluginsOverview"
  | "installPlugin"
  | "listPlugins"
  | "getPluginReferenceCatalog"
  | "updatePluginMarketplace";

interface SerializedActionResult<T> {
  ok: boolean;
  error?: string;
  value?: T;
}

interface PluginControlAttributes {
  componentKind?: string;
  configKey?: string;
  groupKey?: string;
  marketplaceId?: string;
  pluginId?: string;
}

export function requirePluginManualReview(): void {
  const runningPendingSpec = process.argv.some((arg) =>
    arg.replaceAll("\\", "/").includes("/plugins/manual-review/"),
  );
  if (runningPendingSpec && process.env.ZCODE_E2E_MANUAL_REVIEW !== "1") {
    throw new Error("Plugin lifecycle pending specs require ZCODE_E2E_MANUAL_REVIEW=1");
  }
}

export async function createPluginLifecycleFixture(
  version = "1.0.0",
  withUi = false,
): Promise<PluginLifecycleFixture> {
  const { homeDir } = getE2EAppDataPaths();
  const marketplaceRoot = join(homeDir, "fixtures", "plugin-management-lifecycle-market");
  const pluginRoot = join(marketplaceRoot, "plugins", PLUGIN_LIFECYCLE_NAME);
  await rm(marketplaceRoot, { force: true, recursive: true });
  await writeLifecyclePlugin(pluginRoot, version, withUi);
  for (let index = 1; index <= 7; index += 1) {
    await writeSimplePlugin(
      join(marketplaceRoot, "plugins", `e2e-lifecycle-extra-${index}`),
      index,
    );
  }
  await writeMarketplaceManifest(marketplaceRoot, version);
  if (withUi) {
    const path = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
    const catalog = await readJsonRecord(path);
    const entries = catalog.plugins as Array<Record<string, unknown>>;
    entries.find((entry) => entry.name === PLUGIN_LIFECYCLE_NAME)!.componentTypes = ["mcp", "ui"];
    await writeJson(path, catalog);
  }
  const managedPluginRoot = lifecycleManagedPluginRoot(homeDir);
  if (existsSync(dirname(dirname(managedPluginRoot)))) {
    // 已登记的 directory marketplace 会复制进 managed storage；失败恢复必须同步修复该副本。
    await rm(managedPluginRoot, { force: true, recursive: true });
    await mkdir(dirname(managedPluginRoot), { recursive: true });
    await cp(pluginRoot, managedPluginRoot, { force: true, recursive: true });
  }
  return { marketplaceRoot, pluginRoot, version };
}

export async function updatePluginLifecycleFixture(
  fixture: PluginLifecycleFixture,
  version: string,
): Promise<PluginLifecycleFixture> {
  await writeLifecyclePlugin(fixture.pluginRoot, version);
  await writeMarketplaceManifest(fixture.marketplaceRoot, version);
  return { ...fixture, version };
}

/**
 * 「全部更新」需要第二个可更新插件：只改 extra-1 的 payload 与目录版本。
 * 须在 updatePluginLifecycleFixture 之后调用，后者会按默认版本重写整份 marketplace.json。
 */
export async function updateLifecycleExtraPluginFixture(
  fixture: PluginLifecycleFixture,
  version: string,
): Promise<void> {
  await writeSimplePlugin(
    join(fixture.marketplaceRoot, "plugins", PLUGIN_LIFECYCLE_EXTRA_NAME),
    1,
    version,
  );
  const path = join(fixture.marketplaceRoot, ".claude-plugin", "marketplace.json");
  const catalog = await readJsonRecord(path);
  const entries = catalog.plugins as Array<Record<string, unknown>>;
  entries.find((entry) => entry.name === PLUGIN_LIFECYCLE_EXTRA_NAME)!.version = version;
  await writeJson(path, catalog);
}

export async function removeLifecyclePluginSource(fixture: PluginLifecycleFixture): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  await rm(fixture.marketplaceRoot, { force: true, recursive: true });
  // directory marketplace 在添加时会复制到 managed storage；仅删除原目录不会触发
  // describe/install/update 失败，因此故障注入必须同时移除权威 managed plugin 副本。
  await rm(lifecycleManagedPluginRoot(homeDir), {
    force: true,
    recursive: true,
  });
}

export async function removeLifecyclePluginPayload(fixture: PluginLifecycleFixture): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  // 保留 marketplace manifest 与登记关系，只移除其声明的插件 payload。这样 Manage 仍展示
  // update 入口，而安装器会在真正复制版本时确定性失败，正好覆盖“关联存在但升级源损坏”。
  await rm(fixture.pluginRoot, { force: true, recursive: true });
  await rm(lifecycleManagedPluginRoot(homeDir), {
    force: true,
    recursive: true,
  });
}

export async function corruptLifecycleMarketplaceManifest(
  fixture: PluginLifecycleFixture,
): Promise<void> {
  await writeText(
    join(fixture.marketplaceRoot, ".claude-plugin", "marketplace.json"),
    "{ invalid plugin lifecycle marketplace fixture",
  );
}

function lifecycleManagedPluginRoot(homeDir: string): string {
  return join(
    homeDir,
    ".zcode",
    "cli",
    "plugins",
    "marketplaces",
    PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    "plugins",
    PLUGIN_LIFECYCLE_NAME,
  );
}

export async function createInvalidOfficialCollisionFixture(): Promise<string> {
  const { homeDir } = getE2EAppDataPaths();
  const root = join(homeDir, "fixtures", "plugin-official-name-collision");
  await writeJson(join(root, ".claude-plugin", "marketplace.json"), {
    name: "zcode-plugins-official",
    plugins: [],
  });
  return root;
}

export async function seedInlineLifecyclePlugin(): Promise<string> {
  const { homeDir } = getE2EAppDataPaths();
  const root = join(homeDir, "fixtures", PLUGIN_INLINE_NAME);
  await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_INLINE_NAME,
    version: "1.0.0",
    description: "E2E inline plugin lifecycle smoke fixture",
    agents: "agents",
    skills: "skills",
  });
  await writeText(
    join(root, "agents", "inline-reviewer.md"),
    [
      "---",
      "name: inline-reviewer",
      "description: E2E inline Plugin reviewer profile",
      "tools:",
      "  - Read",
      "---",
      "",
      "Review the requested files for the inline Plugin fixture.",
    ].join("\n"),
  );
  await writeText(
    join(root, "skills", "inline-lifecycle", "SKILL.md"),
    [
      "---",
      "name: inline-lifecycle",
      "description: E2E inline lifecycle runtime marker",
      "---",
      "",
      "# Inline lifecycle",
      "",
      "E2E_PLUGIN_INLINE_LIFECYCLE_RUNTIME",
    ].join("\n"),
  );

  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  const config = await readJsonRecord(configPath);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  await writeJson(configPath, {
    ...config,
    plugins: {
      ...plugins,
      dirs: [root],
      enabled: true,
      enabledPlugins: { ...enabledPlugins, [PLUGIN_INLINE_ID]: true },
    },
  });
  return root;
}

async function waitForPluginSettingsEntry(): Promise<void> {
  // 隔离 profile 会先显示职业引导；仅等设置按钮会一直卡住，固定项目等待又不适用创建后的未归类草稿。
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="onboarding-page"]').isExisting()) {
        await dismissOccupationOnboarding();
        return false;
      }
      return $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting();
    },
    { timeout: 30000, timeoutMsg: "退出职业引导后没有出现全局设置入口" },
  );
}

export async function openPluginSettings(scope: "user" | "workspace" = "user"): Promise<void> {
  if (scope === "workspace") {
    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    return;
  }
  await waitForPluginSettingsEntry();
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Plugin lifecycle E2E could not open Settings",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  // Settings 路由已统一使用单数 section id；"plugins" 是旧导航契约。
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "plugin"), {
    timeout: 15000,
    timeoutMsg: "Settings did not expose the Plugins section",
  });
  // Plugin 设置页现在只管理已安装插件；商店作为 WorkspaceShell 主视图，由
  // “浏览插件/创建”入口进入。旧用例直接等待商店根节点会绕过真实导航路径。
  // 该入口有稳定 testid，不按可见文案匹配——否则 i18n 改文案就会断。
  await clickTestIdByDom(TID_PLUGIN_STORE_BROWSE, {
    timeout: 15000,
    timeoutMsg: "Plugins 设置页没有进入商店的真实入口",
  });
  await waitForPluginControl("plugin-store-root", {}, 30000);
  await waitForPluginControl("plugin-store-list", {}, 30000);
}

export async function openPluginManagementSettings(): Promise<void> {
  // 插件创建会进入未归类草稿；设置入口属于全局外壳，不能强制等回固定项目。
  await waitForPluginSettingsEntry();
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Workspace Plugin E2E could not open Settings",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "plugin"), {
    timeout: 15000,
    timeoutMsg: "Settings did not expose the Plugin management section",
  });
  await waitForPluginControl("plugin-settings-scope-trigger", {}, 30000);
}

export async function selectPluginSettingsScope(scope: "user" | "workspace"): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (element) => element.dataset.testid === "plugin-settings-scope-trigger",
        );
        if (!trigger) return false;
        if (trigger.getAttribute("aria-expanded") === "true") return true;
        // Radix DropdownMenu 在 pointerdown 上切换 open；仅调用 click 不会打开菜单，
        // 这会让 Workspace scope E2E 误判为没有 Workspace 选项。
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
            pointerType: "mouse",
          }),
        );
        return true;
      }),
    { timeout: 10000, timeoutMsg: "Plugin scope trigger did not render" },
  );
  if (scope === "user") {
    await clickTestIdByDom("plugin-settings-scope-user-option");
  } else {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          if (document.querySelector('[data-testid^="plugin-settings-scope-option"]')) return true;
          // 项目在各设备的「项目」子菜单里（19 号票）：打开第一个设备的子菜单，等同旧的第一项。
          const projects = document.querySelector<HTMLElement>(
            '[data-scope-projects-trigger="true"]',
          );
          if (projects && projects.dataset.state !== "open") projects.click();
          return false;
        }),
      {
        timeout: 15000,
        timeoutMsg: `Workspace Plugin scope option did not render: ${JSON.stringify(
          await browser.execute(() => {
            const tabStore = (
              window as typeof window & {
                __zcodeTabStoreE2E?: {
                  getState?: () => {
                    activeWorkspacePath?: string | null;
                    activeWorkspaceIdentity?: string | null;
                    tabs?: Array<Record<string, unknown>>;
                  };
                };
              }
            ).__zcodeTabStoreE2E;
            const state = tabStore?.getState?.();
            return {
              activeWorkspacePath: state?.activeWorkspacePath ?? null,
              activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
              tabs: state?.tabs ?? [],
            };
          }),
        )}`,
      },
    );
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-testid^="plugin-settings-scope-option"]')?.click();
    });
  }
  await waitForPluginScopeSelection("plugin-settings-scope-trigger", scope);
}

export async function waitForPluginSettingsScope(scope: "user" | "workspace"): Promise<void> {
  await waitForPluginScopeSelection("plugin-settings-scope-trigger", scope);
}

export async function clickPluginSettingsListBreadcrumb(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        // Marketplace 来源详情的 breadcrumb 是
        // Plugin Marketplace > Plugins > 当前插件；这里必须回到中间的 Plugins
        // 配置视图，不能点击最左侧 Marketplace 再绕一圈。
        const listButton = document.querySelector<HTMLButtonElement>(
          '[data-testid="settings-breadcrumb-item"]',
        );
        if (!listButton) return false;
        listButton.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: "Plugin settings breadcrumb did not expose the installed-list back action",
    },
  );
  await waitForPluginControl("plugin-settings-scope-trigger", {}, 30000);
}

export async function openInstalledPluginSettingsDetail(pluginId: string): Promise<void> {
  await waitForPluginControl("plugin-settings-plugin-row", { pluginId });
  const rowSelector = pluginControlSelector("plugin-settings-plugin-row", {
    pluginId,
  });
  const opened = await browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    const card = row?.querySelector<HTMLElement>('[data-testid="plugin-store-card"]');
    card?.click();
    return Boolean(card);
  }, rowSelector);
  if (!opened) {
    throw new Error(`Could not open installed Plugin detail: ${pluginId}`);
  }
  await waitForPluginControl("plugin-store-detail", { pluginId });
}

export async function openInstalledPluginSettingsAdvanced(pluginId: string): Promise<void> {
  await openInstalledPluginSettingsDetail(pluginId);
  const detailSelector = pluginControlSelector("plugin-store-detail", {
    pluginId,
  });
  const expanded = await browser.execute((selector) => {
    const details = document.querySelector<HTMLDetailsElement>(`${selector} details`);
    if (!details) return false;
    details.open = true;
    return true;
  }, detailSelector);
  if (!expanded) {
    throw new Error(`Installed Plugin detail has no advanced section: ${pluginId}`);
  }
}

export async function waitForDisplayedPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
  timeout = 15000,
): Promise<void> {
  const selector = pluginControlSelector(testIdValue, attributes);
  await browser.waitUntil(
    async () => {
      const element = await browser.$(selector);
      return (await element.isExisting()) && (await element.isDisplayed());
    },
    {
      timeout,
      timeoutMsg: `Plugin UI did not display ${testIdValue} ${JSON.stringify(attributes)}`,
    },
  );
}

export async function addMarketplaceSourceThroughUi(source: string): Promise<void> {
  await waitForPluginControl("plugin-store-create");
  await browser.execute(() => {
    document
      .querySelector<HTMLElement>('[data-testid="plugin-store-create"]')
      ?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
  });
  await waitForPluginControl("plugin-store-add-source-menu-item");
  await clickPluginControl("plugin-store-add-source-menu-item");
  await waitForPluginControl("plugin-store-add-source-dialog");
  await setInputValueByTestIdDom("plugin-store-add-source-input", source, {
    timeout: 15000,
  });
  await clickPluginControl("plugin-store-add-source-risk-acknowledgement");
  await clickPluginControl("plugin-store-add-source-submit");
}

export async function addLifecycleMarketplaceThroughUi(
  fixture: PluginLifecycleFixture,
): Promise<void> {
  await addMarketplaceSourceThroughUi(fixture.marketplaceRoot);
  await waitUntilPluginOverview(
    (overview) =>
      overview.marketplaces.some(
        (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      ),
    "Lifecycle marketplace was not persisted after the UI submission",
    60000,
  );
  await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-add-source-dialog")), {
    timeout: 60000,
    timeoutMsg: "Lifecycle marketplace completed but the source dialog remained open",
  });
}

export async function waitForPluginCard(pluginId: string, timeout = 30000): Promise<void> {
  if (!(await hasPluginControl("plugin-store-card", { pluginId }))) {
    const marketplaceSeparator = pluginId.lastIndexOf("@");
    const marketplaceId =
      marketplaceSeparator >= 0 ? pluginId.slice(marketplaceSeparator + 1) : undefined;
    const groupKey = marketplaceId ? `marketplace:${marketplaceId}` : undefined;
    if (groupKey) {
      await browser.waitUntil(
        async () =>
          (await hasPluginControl("plugin-store-card", { pluginId })) ||
          (await hasPluginControl("plugin-store-group-toggle", { groupKey })),
        {
          timeout,
          timeoutMsg: `Plugin marketplace group did not render: ${groupKey}`,
        },
      );
      if (
        !(await hasPluginControl("plugin-store-card", { pluginId })) &&
        (await hasPluginControl("plugin-store-group-toggle", { groupKey }))
      ) {
        // 折叠分组只渲染前六张卡片；测试仍通过真实展开入口寻找目标插件。
        await clickPluginControl("plugin-store-group-toggle", { groupKey });
      }
    }
  }
  await waitForPluginControl("plugin-store-card", { pluginId }, timeout);
}

export async function openPluginCard(pluginId: string): Promise<void> {
  await waitForPluginCard(pluginId);
  await clickPluginControl("plugin-store-card", { pluginId });
  await waitForPluginControl("plugin-store-detail", { pluginId }, 30000);
}

export async function installPluginThroughUi(pluginId: string): Promise<void> {
  await clickPluginControl("plugin-store-install", { pluginId });
  await waitUntilPluginOverview(
    (overview) => overview.installedPlugins.some((plugin) => plugin.id === pluginId),
    `Plugin did not install through UI: ${pluginId}`,
    120000,
  );
}

export async function setPluginEnabledThroughUi(
  pluginId: string,
  enabled: boolean,
  entry: "detail" | "manage" | "market" = "detail",
): Promise<void> {
  if (entry === "manage" || entry === "market") {
    const testId =
      entry === "manage" ? "plugin-settings-enabled-switch" : "plugin-store-enabled-switch";
    const current = await readPluginControlChecked(testId, { pluginId });
    if (current !== enabled) await clickPluginControl(testId, { pluginId });
  } else {
    const list = await getPluginList();
    if (list.plugins.find((plugin) => plugin.id === pluginId)?.enabled !== enabled) {
      await clickPluginControl("plugin-store-item-menu", { pluginId });
      await clickPluginControl("plugin-store-menu-enabled", { pluginId });
    }
  }
  await waitUntilPluginList(
    (list) => list.plugins.some((plugin) => plugin.id === pluginId && plugin.enabled === enabled),
    `Plugin enabled state did not become ${enabled}: ${pluginId}`,
  );
}

export async function configureLifecyclePluginThroughUi(value: string): Promise<void> {
  // 当前市场详情只展示信息；配置写入归管理页详情，必须走真实管理入口。
  const fromStore = !(await hasPluginControl("plugin-settings-detail-back"));
  if (fromStore) {
    await clickPluginControl("plugin-store-detail-back");
    await openManageView();
    // 整行卡片负责打开详情，行内第一个 button 是菜单，会误打开卸载操作。
    await clickPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
  }
  await clickPluginControl("plugin-store-advanced");
  await setPluginControlValue(
    "plugin-store-config-input",
    { configKey: PLUGIN_LIFECYCLE_CONFIG_KEY },
    value,
  );
  await clickPluginControl("plugin-store-config-save", {
    pluginId: PLUGIN_LIFECYCLE_ID,
  });
  await browser.waitUntil(
    async () => (await readPluginConfigOptions())[PLUGIN_LIFECYCLE_CONFIG_KEY] === value,
    { timeout: 30000, timeoutMsg: "Plugin configuration did not persist" },
  );
  if (fromStore) {
    await clickPluginControl("plugin-settings-detail-back");
    // 管理页「浏览全部」按钮已改为返回图标。
    await clickPluginControl("plugin-store-manage-back");
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
  }
}

export async function uninstallPluginThroughUi(pluginId: string, confirm: boolean): Promise<void> {
  await clickPluginControl("plugin-store-item-menu", { pluginId });
  await clickPluginControl("plugin-store-menu-uninstall", { pluginId });
  await waitForPluginControl("plugin-store-uninstall-dialog");
  await clickPluginControl(
    confirm ? "plugin-store-uninstall-confirm" : "plugin-store-uninstall-cancel",
  );
  if (confirm) {
    await waitUntilPluginOverview(
      (overview) => !overview.installedPlugins.some((plugin) => plugin.id === pluginId),
      `Plugin remained installed after confirmation: ${pluginId}`,
      120000,
    );
  } else {
    await waitUntilPluginOverview(
      (overview) => overview.installedPlugins.some((plugin) => plugin.id === pluginId),
      `Cancelling uninstall changed installation: ${pluginId}`,
    );
  }
}

export async function openManageView(): Promise<void> {
  await clickPluginControl("plugin-store-manage-open");
  await waitForPluginControl("plugin-store-manage");
}

export async function openSourcesDialog(): Promise<void> {
  await clickPluginControl("plugin-store-sources-open");
  await waitForPluginControl("plugin-store-sources-dialog");
}

export async function removeMarketplaceSourceThroughUi(marketplaceId: string): Promise<void> {
  await openSourcesDialog();
  await clickPluginControl("plugin-store-source-remove", { marketplaceId });
  await browser.waitUntil(
    async () => !(await hasPluginControl("plugin-store-source-row", { marketplaceId })),
    {
      timeout: 30000,
      timeoutMsg: `Marketplace source was not removed: ${marketplaceId}`,
    },
  );
  // 来源删除完成后通过弹窗标准 Escape 入口返回商店；否则 overlay 会拦截后续管理入口。
  await browser.keys(["Escape"]);
  await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-sources-dialog")), {
    timeout: 10000,
    timeoutMsg: "Marketplace sources dialog did not close",
  });
}

export async function clickPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
): Promise<void> {
  let latest = "not-started";
  const selector = pluginControlSelector(testIdValue, attributes);
  try {
    await browser.waitUntil(
      async () => {
        const elements = await browser.$$(selector);
        if ((await elements.length) === 0) {
          latest = "missing";
          return false;
        }
        let sawHidden = false;
        let sawDisabled = false;
        for (const element of elements) {
          if (!(await element.isDisplayed())) {
            sawHidden = true;
            continue;
          }
          if (!(await element.isEnabled())) {
            sawDisabled = true;
            continue;
          }
          try {
            await element.scrollIntoView();
            await element.click();
            latest = "clicked";
            return true;
          } catch (error) {
            latest = error instanceof Error ? error.message : String(error);
          }
        }
        latest = sawDisabled ? "disabled" : sawHidden ? "hidden" : latest;
        return false;
      },
      { timeout: 30000 },
    );
  } catch (error) {
    const dialogs = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"], [role="dialog"]'))
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => element.innerText.slice(0, 1000)),
    );
    await capturePluginManualReview("PLM-UI-FAIL", testIdValue).catch(() => {});
    throw new Error(
      `Could not click ${testIdValue}: ${latest}; dialogs=${JSON.stringify(dialogs)}`,
      { cause: error },
    );
  }
}

function pluginControlSelector(testIdValue: string, attributes: PluginControlAttributes): string {
  const selectors = [`[data-testid=${JSON.stringify(testIdValue)}]`];
  const attributeEntries: Array<[string, string | undefined]> = [
    ["data-plugin-id", attributes.pluginId],
    ["data-marketplace-id", attributes.marketplaceId],
    ["data-group-key", attributes.groupKey],
    ["data-component-kind", attributes.componentKind],
    ["data-config-key", attributes.configKey],
  ];
  for (const [name, value] of attributeEntries) {
    if (value) selectors.push(`[${name}=${JSON.stringify(value)}]`);
  }
  return selectors.join("");
}

export async function waitForPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
  timeout = 15000,
): Promise<void> {
  await browser.waitUntil(() => hasPluginControl(testIdValue, attributes), {
    timeout,
    timeoutMsg: `Plugin UI did not render ${testIdValue} ${JSON.stringify(attributes)}`,
  });
}

export async function hasPluginControl(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
): Promise<boolean> {
  return browser.execute(
    (id, expected) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.pluginId || candidate.dataset.pluginId === expected.pluginId) &&
          (!expected.marketplaceId || candidate.dataset.marketplaceId === expected.marketplaceId) &&
          (!expected.groupKey || candidate.dataset.groupKey === expected.groupKey) &&
          (!expected.componentKind || candidate.dataset.componentKind === expected.componentKind) &&
          (!expected.configKey || candidate.dataset.configKey === expected.configKey),
      ),
    testIdValue,
    attributes,
  );
}

async function waitForPluginScopeSelection(
  triggerTestId: string,
  scope: "user" | "workspace",
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id, expectedScope) => {
          const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (candidate) => candidate.dataset.testid === id,
          );
          const selectedKey = trigger?.dataset.pluginScopeKey;
          return expectedScope === "user"
            ? selectedKey === "user"
            : Boolean(selectedKey && selectedKey !== "user");
        },
        triggerTestId,
        scope,
      ),
    {
      timeout: 15000,
      timeoutMsg: `Plugin scope trigger did not select ${scope}: ${triggerTestId}`,
    },
  );
}

export async function getPluginControlText(
  testIdValue: string,
  attributes: PluginControlAttributes = {},
): Promise<string> {
  return browser.execute(
    (id, expected) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.pluginId || candidate.dataset.pluginId === expected.pluginId) &&
          (!expected.marketplaceId || candidate.dataset.marketplaceId === expected.marketplaceId),
      )?.textContent ?? "",
    testIdValue,
    attributes,
  );
}

export async function setPluginPresentation(input: {
  locale: "zh-CN" | "en-US";
  theme: "zai-light" | "zai-dark";
  width: number;
  height: number;
}): Promise<void> {
  await setCurrentElectronRendererContentSize(input.width, input.height);
  await browser.executeAsync((next, done: (result?: string) => void) => {
    const actions = (
      window as typeof window & {
        __testActions?: Record<string, unknown>;
      }
    ).__testActions;
    const setLocale = actions?.setLocale;
    const setTheme = actions?.setTheme;
    if (typeof setLocale !== "function" || typeof setTheme !== "function") {
      done("missing locale/theme test action");
      return;
    }
    (setLocale as (value: string) => void)(next.locale);
    (setTheme as (value: string) => void)(next.theme);
    requestAnimationFrame(() => done());
  }, input);
}

export async function assertPluginStoreFitsViewport(): Promise<void> {
  const layout = await browser.execute(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="plugin-store-root"]');
    return {
      clientWidth: root?.clientWidth ?? 0,
      scrollWidth: root?.scrollWidth ?? 0,
      viewportWidth: window.innerWidth,
      overflow: root
        ? Array.from(root.querySelectorAll<HTMLElement>("*"))
            .filter(
              (element) =>
                element.getBoundingClientRect().right > root.getBoundingClientRect().right + 1,
            )
            .map((element) => ({
              tag: element.tagName,
              testId: element.dataset.testid,
              className: element.className,
              text: element.textContent?.slice(0, 80),
            }))
            .slice(0, 10)
        : [],
    };
  });
  expect(layout.clientWidth).toBeGreaterThan(0);
  if (layout.scrollWidth > layout.clientWidth + 1) {
    throw new Error(`Plugin store overflows: ${JSON.stringify(layout)}`);
  }
  expect(layout.clientWidth).toBeLessThanOrEqual(layout.viewportWidth);
}

export async function capturePluginManualReview(caseId: string, label: string): Promise<string> {
  const artifactDir = join(
    process.cwd(),
    ".e2e-artifacts",
    "plugin-management",
    caseId.toLowerCase(),
  );
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `${label.replaceAll(/[^a-z0-9-]/giu, "-")}.png`);
  // 人工评审截图要反映稳定态：等有限时长的过渡/动画（分段切换、面板展开）结束，
  // 否则会截到旧选中态与新内容并存的中间帧。无限循环的加载动画不参与判断。
  await browser
    .waitUntil(
      async () =>
        browser.execute(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length === 0,
        ),
      { timeout: 3000, interval: 100 },
    )
    .catch(() => undefined);
  await browser.saveScreenshot(path);
  return path;
}

export async function restartPluginLifecycleApp(): Promise<void> {
  await browser.reloadSession();
  await browser.waitUntil(
    async () => {
      try {
        return (await browser.getUrl()).startsWith("file://");
      } catch {
        return false;
      }
    },
    {
      timeout: 60000,
      timeoutMsg: "Electron renderer did not recover after reloadSession",
    },
  );
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
}

export async function getPluginOverview(
  workspacePath = DEFAULT_WORKSPACE,
  configScope?: "user" | "workspace",
): Promise<ZCodePluginsOverviewResult> {
  return callPluginTestAction("getPluginsOverview", {
    workspacePath,
    ...(configScope ? { configScope } : {}),
  });
}

export async function addMarketplaceSourceThroughAgent(
  source: string,
  workspacePath = DEFAULT_WORKSPACE,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  return callPluginTestAction("addPluginMarketplace", {
    source,
    workspacePath,
  });
}

export async function updateMarketplaceThroughAgent(
  marketplace: string,
  workspacePath = DEFAULT_WORKSPACE,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  return callPluginTestAction("updatePluginMarketplace", {
    marketplace,
    workspacePath,
  });
}

export async function installMarketplacePluginThroughAgent(
  pluginName: string,
  marketplace: string,
  workspacePath = DEFAULT_WORKSPACE,
): Promise<ZCodePluginsInstallResult> {
  return callPluginTestAction("installPlugin", {
    marketplace,
    pluginName,
    scope: "user",
    workspacePath,
  });
}

export async function getPluginList(
  workspacePath = DEFAULT_WORKSPACE,
  workspaceIdentity?: string,
  configScope?: "user" | "workspace",
): Promise<ZCodePluginsListResult> {
  return callPluginTestAction("listPlugins", {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(configScope ? { configScope } : {}),
  });
}

export async function getPluginReferenceCatalog(
  options: {
    sessionId?: string;
    workspaceIdentity?: string;
    workspacePath?: string;
  } = {},
): Promise<ZCodePluginsReferenceCatalogResult> {
  return callPluginTestAction("getPluginReferenceCatalog", {
    workspacePath: options.workspacePath ?? DEFAULT_WORKSPACE,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });
}

export async function waitUntilPluginOverview(
  predicate: (overview: ZCodePluginsOverviewResult) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<void> {
  await browser.waitUntil(async () => predicate(await getPluginOverview()), {
    timeout,
    timeoutMsg,
  });
}

export async function waitUntilPluginList(
  predicate: (list: ZCodePluginsListResult) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<void> {
  let latest: ZCodePluginsListResult | undefined;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getPluginList();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    // 只保留启停与来源事实，便于区分配置范围错误和保存失败，不输出插件 secret/options。
    const plugins = latest?.plugins.map(({ id, enabled, enabledSource }) => ({
      id,
      enabled,
      enabledSource,
    }));
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(plugins)}`, { cause: error });
  }
}

export async function readPluginConfigOptions(): Promise<Record<string, unknown>> {
  const config = await readJsonRecord(
    join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json"),
  );
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  return isRecord(options[PLUGIN_LIFECYCLE_ID]) ? options[PLUGIN_LIFECYCLE_ID] : {};
}

export function pluginStoragePath(...segments: string[]): string {
  return join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "plugins", ...segments);
}

export function pluginDataPath(pluginId: string): string {
  return pluginStoragePath("data", pluginId);
}

export function pluginPathExists(path: string): boolean {
  return existsSync(path);
}

async function readPluginControlChecked(
  testIdValue: string,
  attributes: PluginControlAttributes,
): Promise<boolean> {
  await waitForPluginControl(testIdValue, attributes);
  return browser.execute(
    (id, expected) => {
      const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.pluginId || candidate.dataset.pluginId === expected.pluginId),
      );
      return element?.getAttribute("data-state") === "checked";
    },
    testIdValue,
    attributes,
  );
}

async function setPluginControlValue(
  testIdValue: string,
  attributes: PluginControlAttributes,
  value: string,
): Promise<void> {
  await waitForPluginControl(testIdValue, attributes);
  const result = await browser.execute(
    (id, expected, nextValue) => {
      const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (candidate) =>
          candidate.dataset.testid === id &&
          (!expected.configKey || candidate.dataset.configKey === expected.configKey),
      );
      if (!(element instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, nextValue);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    testIdValue,
    attributes,
    value,
  );
  if (!result) throw new Error(`Could not set ${testIdValue} to ${value}`);
}

async function callPluginTestAction<T>(
  actionName: PluginTestActionName,
  params: unknown,
): Promise<T> {
  // 这些 action 随应用页面挂载，首次职业引导尚未退出时不存在。
  await waitForPluginSettingsEntry();
  await browser.waitUntil(
    () =>
      browser.execute(
        (name) =>
          typeof (
            window as typeof window & {
              __testActions?: Record<string, unknown>;
            }
          ).__testActions?.[name] === "function",
        actionName,
      ),
    {
      timeout: 30_000,
      timeoutMsg: `plugin test action did not become ready: ${actionName}`,
    },
  );
  const result = (await browser.executeAsync(
    (
      name: PluginTestActionName,
      input: unknown,
      done: (result: SerializedActionResult<unknown>) => void,
    ) => {
      const actions = (
        window as typeof window & {
          __testActions?: Record<string, unknown>;
        }
      ).__testActions;
      const action = actions?.[name];
      if (typeof action !== "function") {
        done({ ok: false, error: `missing test action: ${name}` });
        return;
      }
      Promise.resolve((action as (value: unknown) => Promise<unknown>)(input))
        .then((value) => done({ ok: true, value }))
        .catch((error: unknown) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    actionName,
    params,
  )) as SerializedActionResult<unknown>;
  if (!result.ok) throw new Error(result.error ?? `test action failed: ${actionName}`);
  return result.value as T;
}

async function writeLifecyclePlugin(
  pluginRoot: string,
  version: string,
  withUi = false,
): Promise<void> {
  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_LIFECYCLE_NAME,
    version,
    description: `E2E plugin management lifecycle fixture ${version}`,
    author: { name: "ZCode E2E" },
    homepage: "https://example.com/e2e-plugin-lifecycle",
    commands: "commands",
    agents: "agents",
    skills: "skills",
    hooks: "hooks/hooks.json",
    mcpServers: {
      lifecycle: {
        type: "stdio",
        command: "node",
        args: ["${ZCODE_PLUGIN_ROOT}/server.mjs", version],
      },
    },
    ...(withUi
      ? {
          ui: {
            surfaces: [
              {
                id: "panel",
                title: "Lifecycle Panel",
                server: "lifecycle",
                resourceUri: "ui://lifecycle/panel.html",
                availability: "session",
              },
            ],
          },
        }
      : {}),
    userConfig: {
      [PLUGIN_LIFECYCLE_CONFIG_KEY]: {
        type: "string",
        title: "Lifecycle label",
        default: `fixture-${version}`,
        description: "Non-sensitive E2E lifecycle option",
      },
      [PLUGIN_LIFECYCLE_INHERITED_CONFIG_KEY]: {
        type: "number",
        title: "Timeout seconds",
        default: 30,
        description: "Inherited non-sensitive E2E lifecycle option",
      },
    },
  });
  await writeText(
    join(pluginRoot, "skills", "lifecycle-version", "SKILL.md"),
    [
      "---",
      "name: lifecycle-version",
      `description: ${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}`,
      "---",
      "",
      "# Lifecycle version",
      "",
      `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}`,
    ].join("\n"),
  );
  await writeText(
    join(pluginRoot, "commands", "lifecycle-command.md"),
    `---\ndescription: Lifecycle command ${version}\n---\n\nReport ${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}.\n`,
  );
  await writeText(
    join(pluginRoot, "agents", "lifecycle-reviewer.md"),
    `---\nname: lifecycle-reviewer\ndescription: Lifecycle subagent ${version}\ntools:\n  - Read\n---\nReport ${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_${version}.\n`,
  );
  await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "echo E2E_PLUGIN_LIFECYCLE_HOOK" }],
        },
      ],
    },
  });
  await writeText(join(pluginRoot, "server.mjs"), buildDependencyFreeMcpServer(version, withUi));
}

async function writeSimplePlugin(
  pluginRoot: string,
  index: number,
  version = "1.0.0",
): Promise<void> {
  await writeJson(join(pluginRoot, ".zcode-plugin", "plugin.json"), {
    name: `e2e-lifecycle-extra-${index}`,
    version,
    description: `E2E lifecycle category expansion plugin ${index}`,
    skills: "skills",
  });
  await writeText(
    join(pluginRoot, "skills", `extra-${index}`, "SKILL.md"),
    `---\ndescription: E2E extra lifecycle skill ${index}\n---\n\n# Extra ${index}\n`,
  );
}

async function writeMarketplaceManifest(marketplaceRoot: string, version: string): Promise<void> {
  const extras = Array.from({ length: 7 }, (_, offset) => {
    const index = offset + 1;
    return {
      name: `e2e-lifecycle-extra-${index}`,
      version: "1.0.0",
      description: `E2E lifecycle category expansion plugin ${index}`,
      category: "productivity",
      source: `./plugins/e2e-lifecycle-extra-${index}`,
    };
  });
  await writeJson(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    description: PLUGIN_LIFECYCLE_MARKETPLACE_NAME,
    plugins: [
      {
        name: PLUGIN_LIFECYCLE_NAME,
        version,
        displayName: "Lifecycle Fixture",
        displayName_i18n: { "zh-CN": "生命周期测试插件" },
        description: `Deterministic plugin lifecycle fixture ${version}`,
        description_i18n: { "zh-CN": `确定性插件生命周期测试 ${version}` },
        category: "productivity",
        author: { name: "ZCode E2E", url: "https://example.com" },
        homepage: "https://example.com/e2e-plugin-lifecycle",
        privacyPolicy: "https://example.com/privacy",
        termsOfService: "https://example.com/terms",
        examplePrompts: [PLUGIN_LIFECYCLE_EXAMPLE_PROMPT],
        source: `./plugins/${PLUGIN_LIFECYCLE_NAME}`,
      },
      ...extras,
    ],
  });
}

function buildDependencyFreeMcpServer(version: string, withUi = false): string {
  const html =
    '<!doctype html><html><body><h1 id="market-ui-ready">Connecting</h1><script>window.zcode.ready().then(() => { document.getElementById("market-ui-ready").textContent = "PLUGIN_MARKET_UI_READY"; });</script></body></html>';
  return `#!/usr/bin/env node
import readline from "node:readline";
const version = process.argv[2] || ${JSON.stringify(version)};
const input = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {}, ${withUi ? "resources: {}," : ""} }, serverInfo: { name: "e2e-plugin-lifecycle", version } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "version_marker", description: "Return the deterministic lifecycle version marker", inputSchema: { type: "object", properties: {} } }] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: ${JSON.stringify(PLUGIN_LIFECYCLE_RUNTIME_MARKER)} + "_" + version }] } });
    return;
  }
  ${
    withUi
      ? `if (request.method === "resources/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { resources: [{ uri: "ui://lifecycle/panel.html", name: "Lifecycle Panel", mimeType: "text/html;profile=mcp-app" }] } }); return;
  }
  if (request.method === "resources/read") {
    send({ jsonrpc: "2.0", id: request.id, result: { contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app", text: ${JSON.stringify(html)} }] } }); return;
  }`
      : ""
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

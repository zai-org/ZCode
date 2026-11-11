import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { findUpstreamRequestContaining } from "#e2e/helpers/plugin-mcp-skill";
import { prepareV4ConversationE2E, sendV4Prompt } from "#e2e/helpers/v4-conversation";
import {
  PLUGIN_INLINE_ID,
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  openManageView,
  openPluginCard,
  openPluginSettings,
  pluginDataPath,
  pluginPathExists,
  requirePluginManualReview,
  restartPluginLifecycleApp,
  seedInlineLifecyclePlugin,
  uninstallPluginThroughUi,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

const BUILTIN_ID = "skill-creator@zcode-plugins-official";
const BUILTIN_TIMEOUT_MS = 240000;

describe("PLM-LC-006/009 Builtin 抑制恢复与 inline smoke E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Builtin 卸载跨重启抑制并干净恢复，inline 在 Personal/Detail/Manage 可见", async function () {
    this.timeout(BUILTIN_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await waitForPluginCard(BUILTIN_ID, 60000);
    await openPluginCard(BUILTIN_ID);
    const builtinCachePath = (await getPluginList()).plugins.find(
      (plugin) => plugin.id === BUILTIN_ID,
    )?.rootPath;
    expect(builtinCachePath).toBeTruthy();
    expect(pluginPathExists(builtinCachePath!)).toBe(true);
    await seedBuiltinUserState();
    await uninstallPluginThroughUi(BUILTIN_ID, true);
    // 内置插件原本就不在 installedPlugins；等待真正的抑制状态，避免卸载 RPC 尚未完成就检查清理。
    await waitUntilPluginOverview(
      (overview) => overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin uninstall did not become restorable",
      120000,
    );
    expect(pluginPathExists(pluginDataPath(BUILTIN_ID))).toBe(false);
    // 内置 cache 是详情与恢复所需的不可变 Catalog 资产，卸载只抑制 Runtime 并清理 data/config。
    expect(pluginPathExists(builtinCachePath!)).toBe(true);
    expect(await builtinOptionsExist()).toBe(false);

    await restartPluginLifecycleApp();
    await openPluginSettings();
    await waitUntilPluginOverview(
      (overview) => overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin suppression did not survive restart",
      60000,
    );
    await waitForPluginCard(BUILTIN_ID, 60000);
    await capturePluginManualReview("PLM-LC-006", "restorable-builtin");
    await openPluginCard(BUILTIN_ID);
    await clickPluginControl("plugin-store-install", { pluginId: BUILTIN_ID });
    await waitUntilPluginOverview(
      (overview) => !overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin did not restore cleanly",
      120000,
    );
    expect(await builtinOptionsExist()).toBe(false);
    expect(pluginPathExists(join(pluginDataPath(BUILTIN_ID), "state.json"))).toBe(false);

    await seedInlineLifecyclePlugin();
    await restartPluginLifecycleApp();
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_INLINE_ID, 60000);
    await openPluginCard(PLUGIN_INLINE_ID);
    await waitForPluginControl("plugin-store-component-section", { componentKind: "skill" });
    expect(
      (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_INLINE_ID)?.enabled,
    ).toBe(true);

    // 市场详情是主视图，没有设置页返回按钮；准备会话会从项目入口进入真实草稿。
    await prepareV4ConversationE2E();
    const inlineRuntimeRequest = `E2E_PLUGIN_INLINE_REQUEST_${Date.now()}`;
    await sendV4Prompt(
      `${inlineRuntimeRequest}: invoke the Skill named inline-lifecycle, then reply with exactly upstream-e2e-ok.`,
    );
    await waitForUpstreamRequestContaining(inlineRuntimeRequest, 60000);
    const inlineRequest = await findUpstreamRequestContaining(
      "E2E_PLUGIN_INLINE_LIFECYCLE_RUNTIME",
      60000,
    );
    expect(JSON.stringify(inlineRequest?.requestJson)).toContain(inlineRuntimeRequest);

    await openPluginSettings();
    await openManageView();
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_INLINE_ID });
    await capturePluginManualReview("PLM-LC-009", "inline-manage-smoke");
  });
});

async function seedBuiltinUserState(): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  const config = await readOptionalConfig(configPath);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  await writeJson(configPath, {
    ...config,
    plugins: { ...plugins, options: { ...options, [BUILTIN_ID]: { e2e: "purge-me" } } },
  });
  await writeJson(join(pluginDataPath(BUILTIN_ID), "state.json"), { purge: true });
}

async function builtinOptionsExist(): Promise<boolean> {
  const configPath = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json");
  const config = await readOptionalConfig(configPath);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  return BUILTIN_ID in options;
}

// CLI 用户配置可以尚不存在；测试播种与卸载后的读取均保留这一合法空态。
async function readOptionalConfig(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

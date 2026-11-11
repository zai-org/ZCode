import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  addLifecycleMarketplaceThroughUi,
  createPluginLifecycleFixture,
  getPluginOverview,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  pluginStoragePath,
  waitForPluginCard,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  E2E_REPLY_TOKEN,
  getV4ConfigProjection,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "#e2e/helpers/plugin-mcp-skill";

describe("WPL-006 Workspace Plugin missing package E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps the project declaration without auto-install, then runs after explicit install", async function () {
    this.timeout(300000);

    const { workspace } = getE2EAppDataPaths();
    const workspaceConfigPath = join(workspace, ".zcode", "config.json");
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await writeFile(
      workspaceConfigPath,
      `${JSON.stringify({ plugins: { enabledPlugins: { [PLUGIN_LIFECYCLE_ID]: true } } }, null, 2)}\n`,
      "utf8",
    );

    const fixture = await createPluginLifecycleFixture("1.0.0");
    const installedPluginsPath = pluginStoragePath("installed_plugins.json");
    expect(await readOptionalText(installedPluginsPath)).toBeNull();

    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickTestIdByDom("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID);

    const beforeInstall = await getPluginOverview();
    expect(beforeInstall.availablePlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: PLUGIN_LIFECYCLE_ID,
          installed: false,
          marketplace: PLUGIN_LIFECYCLE_MARKETPLACE_ID,
        }),
      ]),
    );
    expect(beforeInstall.installedPlugins).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PLUGIN_LIFECYCLE_ID })]),
    );
    expect(await readOptionalText(installedPluginsPath)).toBeNull();

    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    const afterInstall = await getPluginOverview();
    expect(afterInstall.installedPlugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PLUGIN_LIFECYCLE_ID, scope: "user" })]),
    );
    expect(await readFile(workspaceConfigPath, "utf8")).toContain(PLUGIN_LIFECYCLE_ID);
    expect(await readFile(installedPluginsPath, "utf8")).toContain(PLUGIN_LIFECYCLE_ID);

    await startNewV4Draft();
    await assertLifecycleRuntimeAfterExplicitInstall();
  });
});

async function assertLifecycleRuntimeAfterExplicitInstall(): Promise<void> {
  await prepareV4ConversationE2E();
  await startNewV4Draft();
  // 新草稿会恢复初始权限模式；必须在实际发送的草稿上开启完全访问，避免停在工具审批。
  await ensureToolCrossProductFullAccessMode();
  expect((await getV4ConfigProjection()).mode).toBe("yolo");
  const marker = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`;
  await sendV4Prompt(
    `${marker}: Call ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} exactly once, then reply with exactly ${E2E_REPLY_TOKEN}.`,
  );
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000, {
    advertisedToolName: PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  });
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(
    captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_LIFECYCLE_MCP_TOOL_NAME),
  ).toBe(true);
  // 工具可能已完成并折叠，使用会展开工作记录的等待器。
  await waitForToolCallBlockByToolName(PLUGIN_LIFECYCLE_MCP_TOOL_NAME, 60000);
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  getPluginReferenceCatalog,
  restartPluginLifecycleApp,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
  PLUGIN_MCP_PLUGIN_ID,
  PLUGIN_MCP_TOOL_NAME,
} from "#e2e/helpers/plugin-mcp-skill";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4PaneSnapshot,
} from "#e2e/helpers/v4-conversation";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const RESIDENT_MARKER = "E2E_WPL_008_RESIDENT_ENABLED";
const NEW_SESSION_MARKER = "E2E_WPL_008_NEW_SESSION_DISABLED";
const COLD_RESUME_MARKER = "E2E_WPL_008_COLD_RESUME_DISABLED";
const RESIDENT_REPLY = "wpl-008-resident-ok";
const NEW_SESSION_REPLY = "wpl-008-new-session-ok";
const COLD_RESUME_REPLY = "wpl-008-cold-resume-ok";

describe("WPL-008 Workspace Plugin resident freeze and cold resume E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("freezes resident S1, reloads new S2, and cold-resumes S1 with the new config", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    // 准备阶段已进入项目空草稿；设置权限后再新建会丢失该草稿的 full-access 选择。
    await sendV4Prompt(
      `${RESIDENT_MARKER}: Call ${PLUGIN_MCP_TOOL_NAME} exactly once, then reply with exactly ${RESIDENT_REPLY}.`,
    );
    await assertPluginToolAdvertisementAndCompletion(RESIDENT_MARKER, RESIDENT_REPLY);

    const residentSessionId = (await getV4PaneSnapshot()).sessionId;
    expect(residentSessionId).not.toBeNull();
    if (!residentSessionId) return;

    const residentCatalog = await getPluginReferenceCatalog({ sessionId: residentSessionId });
    expect(residentCatalog.authority).toBe("session");
    expectPluginCatalogState(residentCatalog.plugins, true);

    await disableWorkspacePlugin();

    const workspaceCatalog = await getPluginReferenceCatalog();
    expect(workspaceCatalog.authority).toBe("workspace");
    expectPluginCatalogState(workspaceCatalog.plugins, false);

    // 同一个 resident App 的 Session-owned catalog 不热加载新配置。
    const stillResidentCatalog = await getPluginReferenceCatalog({ sessionId: residentSessionId });
    expectPluginCatalogState(stillResidentCatalog.plugins, true);

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(
      `${NEW_SESSION_MARKER}: Do not call tools; reply with exactly ${NEW_SESSION_REPLY}.`,
    );
    await assertPluginToolNotAdvertised(NEW_SESSION_MARKER);
    await waitForV4AssistantMessageContaining(NEW_SESSION_REPLY);

    // 完整重启 Desktop/Host/CLI 后再打开 S1，证明 cold resume 重建 App 时读取当前 Workspace 配置。
    await restartPluginLifecycleApp();
    await selectV4TaskById(residentSessionId);
    await browser.waitUntil(
      async () => (await getV4PaneSnapshot()).sessionId === residentSessionId,
      { timeout: 60000, timeoutMsg: `S1 没有在 cold resume 后恢复: ${residentSessionId}` },
    );
    const coldCatalog = await waitForSessionPluginReferenceCatalog(residentSessionId);
    expect(coldCatalog.authority).toBe("session");
    expectPluginCatalogState(coldCatalog.plugins, false);

    await sendV4Prompt(
      `${COLD_RESUME_MARKER}: Do not call tools; reply with exactly ${COLD_RESUME_REPLY}.`,
    );
    await assertPluginToolNotAdvertised(COLD_RESUME_MARKER);
    await waitForV4AssistantMessageContaining(COLD_RESUME_REPLY);
  });
});

async function disableWorkspacePlugin(): Promise<void> {
  const { workspace } = getE2EAppDataPaths();
  const configPath = join(workspace, ".zcode", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    plugins?: { enabledPlugins?: Record<string, boolean> };
  };
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        plugins: {
          ...config.plugins,
          enabledPlugins: {
            ...config.plugins?.enabledPlugins,
            [PLUGIN_MCP_PLUGIN_ID]: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function assertPluginToolAdvertisementAndCompletion(
  marker: string,
  expectedReply: string,
): Promise<void> {
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000, {
    advertisedToolName: PLUGIN_MCP_TOOL_NAME,
  });
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
    true,
  );
  // 驻留和冷恢复用例都必须能观察已折叠的工具记录。
  await waitForToolCallBlockByToolName(PLUGIN_MCP_TOOL_NAME, 60000);
  await waitForV4AssistantMessageContaining(expectedReply);
}

function expectPluginCatalogState(
  plugins: Awaited<ReturnType<typeof getPluginReferenceCatalog>>["plugins"],
  enabled: boolean,
): void {
  const plugin = plugins.find((entry) => entry.pluginId === PLUGIN_MCP_PLUGIN_ID);
  expect(plugin).toBeDefined();
  expect(plugin?.enabled).toBe(enabled);
  if (!enabled) {
    expect(plugin?.mcpServerNames).toEqual([]);
  }
}

async function waitForSessionPluginReferenceCatalog(
  sessionId: string,
): Promise<Awaited<ReturnType<typeof getPluginReferenceCatalog>>> {
  let catalog: Awaited<ReturnType<typeof getPluginReferenceCatalog>> | undefined;
  await browser.waitUntil(
    async () => {
      try {
        catalog = await getPluginReferenceCatalog({ sessionId });
        return true;
      } catch (error) {
        // cold resume 时 Renderer 会先恢复选中态，CLI App 随后才完成 session/resume；
        // 只把这个明确的暂态当作未就绪，其他协议错误立即暴露。
        if (
          error instanceof Error &&
          error.message.includes(`Session is not active: ${sessionId}`)
        ) {
          return false;
        }
        throw error;
      }
    },
    {
      interval: 250,
      timeout: 60000,
      timeoutMsg: `S1 cold resume 后 Plugin catalog 没有就绪: ${sessionId}`,
    },
  );
  if (!catalog) throw new Error(`S1 cold resume 后缺少 Plugin catalog: ${sessionId}`);
  return catalog;
}

async function assertPluginToolNotAdvertised(marker: string): Promise<void> {
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000);
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
    false,
  );
}

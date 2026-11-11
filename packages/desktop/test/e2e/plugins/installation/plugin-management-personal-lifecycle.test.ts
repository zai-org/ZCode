import { type ZCodePluginComponentKind } from "@zcode/shared";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import {
  getV4ComposerText,
  prepareV4ConversationE2E,
  sendV4Prompt,
} from "#e2e/helpers/v4-conversation";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "#e2e/helpers/plugin-mcp-skill";
import {
  PLUGIN_LIFECYCLE_CONFIG_VALUE,
  PLUGIN_LIFECYCLE_EXAMPLE_PROMPT,
  PLUGIN_LIFECYCLE_EXTRA_ID,
  PLUGIN_LIFECYCLE_EXTRA_NAME,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  addLifecycleMarketplaceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  configureLifecyclePluginThroughUi,
  createPluginLifecycleFixture,
  getPluginList,
  getPluginOverview,
  hasPluginControl,
  installMarketplacePluginThroughAgent,
  openManageView,
  openPluginCard,
  openPluginSettings,
  requirePluginManualReview,
  selectPluginSettingsScope,
  setPluginEnabledThroughUi,
  uninstallPluginThroughUi,
  updateLifecycleExtraPluginFixture,
  updatePluginLifecycleFixture,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "#e2e/helpers/plugin-management-lifecycle";

const LIFECYCLE_TIMEOUT_MS = 300000;

describe("PLM-LC-003 Personal Source 插件主生命周期 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("从来源添加到运行时升级，再取消并确认卸载", async function () {
    this.timeout(LIFECYCLE_TIMEOUT_MS);
    requirePluginManualReview();

    let fixture = await createPluginLifecycleFixture("1.0.0");
    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);

    for (const kind of [
      "mcp",
      "skill",
      "command",
      "agent",
      "hook",
    ] satisfies ZCodePluginComponentKind[]) {
      await waitForPluginControl("plugin-store-component-section", { componentKind: kind }, 30000);
    }
    await capturePluginManualReview("PLM-LC-003", "uninstalled-five-components");

    await clickPluginControl("plugin-store-example-prompt", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitUntilPluginOverview(
      (overview) => overview.installedPlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      "Example Prompt did not install the plugin",
      120000,
    );
    await waitForPluginControl("plugin-store-item-menu", { pluginId: PLUGIN_LIFECYCLE_ID }, 30000);
    expect(await isPluginSettingsVisible()).toBe(true);

    await clickPluginControl("plugin-store-example-prompt", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForTestIdByDom(TID_V4_COMPOSER_INPUT, { timeout: 30000 });
    try {
      await browser.waitUntil(
        async () => {
          const composerText = (await getV4ComposerText()) ?? "";
          return (
            composerText.includes(`plugin://${PLUGIN_LIFECYCLE_ID}`) &&
            composerText.endsWith(` ${PLUGIN_LIFECYCLE_EXAMPLE_PROMPT}`)
          );
        },
        {
          timeout: 10000,
          timeoutMsg: "Example Prompt did not prefill the canonical Plugin reference and prompt",
        },
      );
    } catch (error) {
      const evidence = await browser.execute(() => {
        interface ComposerEvidenceWorkspace {
          activeTaskId: string | null;
          composerTextInsertRequest: { requestId: number; text: string } | null;
          composerTextInsertVersion: number;
        }
        const store = (
          window as typeof window & {
            __zcodeSessionStoreE2E?: {
              getState: () => { workspaces: Record<string, ComposerEvidenceWorkspace> };
            };
          }
        ).__zcodeSessionStoreE2E;
        const state = store?.getState();
        return {
          composers: Array.from(
            document.querySelectorAll<
              HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }
            >('[data-testid="v4-composer-input"]'),
          ).map(
            (element) =>
              element.__zcodeLexicalInputE2E?.getText() ??
              element.innerText ??
              element.textContent ??
              "",
          ),
          workspaces: Object.fromEntries(
            Object.entries(state?.workspaces ?? {}).map(([key, workspace]) => [
              key,
              {
                activeTaskId: workspace.activeTaskId,
                composerTextInsertRequest: workspace.composerTextInsertRequest,
                composerTextInsertVersion: workspace.composerTextInsertVersion,
              },
            ]),
          ),
        };
      });
      throw new Error(`Example Prompt evidence: ${JSON.stringify(evidence)}`, { cause: error });
    }
    expect(await countCapturedRequestsContaining(PLUGIN_LIFECYCLE_EXAMPLE_PROMPT)).toBe(0);

    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await configureLifecyclePluginThroughUi(PLUGIN_LIFECYCLE_CONFIG_VALUE);
    // 市场菜单会修改当前项目；用户级生命周期必须显式选全局管理范围。
    await clickPluginControl("plugin-store-detail-back");
    await openManageView();
    await selectPluginSettingsScope("user");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, false, "manage");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, true, "manage");

    // 第二个可更新插件：一个走行内「更新」，另一个走分组头部「全部更新」，两条真实链路都覆盖。
    await installMarketplacePluginThroughAgent(
      PLUGIN_LIFECYCLE_EXTRA_NAME,
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );
    fixture = await updatePluginLifecycleFixture(fixture, "2.0.0");
    await updateLifecycleExtraPluginFixture(fixture, "2.0.0");
    // 市场刷新承担目录更新；管理菜单已只保留启停与卸载，更新使用行内独立按钮。
    await clickPluginControl("plugin-store-manage-back");
    await clickPluginControl("plugin-store-refresh");
    await waitUntilPluginOverview(
      (overview) =>
        [PLUGIN_LIFECYCLE_ID, PLUGIN_LIFECYCLE_EXTRA_ID].every((pluginId) =>
          overview.installedPlugins.some(
            (plugin) => plugin.id === pluginId && plugin.updateStatus !== "none",
          ),
        ),
      "Checking updates did not expose lifecycle and extra v2",
      60000,
    );
    await openManageView();
    await selectPluginSettingsScope("user");
    // 2026-09-02：检查更新后，已安装行必须直接亮出「可更新」角标与行内「更新」按钮；
    // 此前更新入口只藏在「…」菜单和详情页高级区，用户刷新后看不出哪个插件可更新。
    await waitForPluginControl("plugin-store-update-badge", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-settings-update-all");
    await clickPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_EXTRA_ID });
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_EXTRA_ID && plugin.version === "2.0.0",
        ),
      "Extra plugin did not upgrade to v2 through the inline update button",
      120000,
    );
    await clickPluginControl("plugin-settings-update-all");
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.version === "2.0.0",
        ),
      "Lifecycle plugin did not upgrade to v2 through update-all",
      120000,
    );
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-settings-update-all")), {
      timeout: 15000,
      timeoutMsg: "Update-all entry stayed visible after every plugin was updated",
    });
    expect(
      (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID)?.version,
    ).toBe("2.0.0");
    // V4 已无旧 draftSessionId 缓存；用下方新 session 的真实 v2 工具请求验证 runtime 刷新。
    await clickPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    await capturePluginManualReview("PLM-LC-003", "updated-v2-detail");

    await prepareV4ConversationE2E();
    const runMarker = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_2.0.0_${Date.now()}`;
    await sendV4Prompt(
      `${runMarker}: Call ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} once, then reply with exactly upstream-e2e-ok.`,
    );
    await waitForUpstreamRequestContaining(runMarker, 60000);
    const runtimeRequest = await findUpstreamRequestContaining(runMarker, 60000, {
      advertisedToolName: PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
    });
    expect(runtimeRequest).not.toBeNull();
    expect(
      captureArtifactAdvertisesToolName(
        runtimeRequest?.requestJson,
        PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
      ),
    ).toBe(true);
    expect(JSON.stringify(runtimeRequest?.requestJson)).toContain(
      `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_2.0.0`,
    );

    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, false);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(true);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, true);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(false);
  });
});

async function isPluginSettingsVisible(): Promise<boolean> {
  return browser.execute(() =>
    Boolean(document.querySelector('[data-testid="plugin-store-root"]')),
  );
}

async function countCapturedRequestsContaining(marker: string): Promise<number> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) return 0;
  try {
    const artifact = JSON.parse(
      await (await import("node:fs/promises")).readFile(capturePath, "utf-8"),
    ) as {
      records?: Array<{ requestJson?: unknown }>;
    };
    return (artifact.records ?? []).filter((record) =>
      JSON.stringify(record.requestJson).includes(marker),
    ).length;
  } catch {
    return 0;
  }
}

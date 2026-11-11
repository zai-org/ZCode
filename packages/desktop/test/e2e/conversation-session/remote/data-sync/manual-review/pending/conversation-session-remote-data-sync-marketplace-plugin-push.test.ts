import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  createPluginLifecycleFixture,
  installMarketplacePluginThroughAgent,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_NAME,
  waitUntilPluginList,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  readRemoteContainerFile,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-08：设置 → 数据同步 → 设备 → 推送 marketplace 插件（docs/remote/data-sync.md「插件 · marketplace 插件」）。
// 本机从 Personal Source 的本地目录 marketplace 安装插件；推送时先把 marketplace 清单与插件源码镜像到远端，
// 再在远端 add + install。远端断言用 docker exec 读容器内 ~/.zcode。覆盖旧插件同步弹窗 WPL-011 的场景。
const CASE_MARKER = "E2E_DSYNC_08_MARKETPLACE_PLUGIN_PUSH";
const ROW_KEY = PLUGIN_LIFECYCLE_ID.toLowerCase();
const REMOTE_PLUGIN_STORAGE = "/home/dev/.zcode/cli/plugins";
const REMOTE_CONFIG = "/home/dev/.zcode/cli/config.json";

/** 本机把该插件设为停用（直接写 User config，CLI 每次请求重新读取），用于断言启用状态随推送一致。 */
async function disableLocalPlugin(): Promise<void> {
  const configPath = join(getE2EAppDataPaths().storageRoot, "cli", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const enabledPlugins = (plugins.enabledPlugins ?? {}) as Record<string, boolean>;
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        plugins: {
          ...plugins,
          enabledPlugins: { ...enabledPlugins, [PLUGIN_LIFECYCLE_ID]: false },
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function readRowState(key: string) {
  return await browser.execute((rowTestId) => {
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid]")).find(
      (element) => element.dataset.testid === rowTestId,
    );
    return row
      ? {
          status: row.dataset.syncStatus ?? null,
          checked: row.getAttribute("aria-checked"),
          text: row.textContent ?? "",
        }
      : null;
  }, `remote-sync-row-${key}`);
}

async function waitForRowStatus(key: string, status: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readRowState(key))?.status === status, {
    timeout: 120_000,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
  return (await readRowState(key))!;
}

async function readButtonText(buttonTestId: string): Promise<string> {
  return await browser.execute(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? "",
    buttonTestId,
  );
}

async function readRemoteJson(container: string, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readRemoteContainerFile(container, path)) as Record<string, unknown>;
}

describe(`${CASE_MARKER}: 数据同步页推送 marketplace 插件`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-08-01 本地目录来源的 marketplace 插件镜像到远端后安装，启用状态与本机一致", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });

    // 本机：添加本地目录 marketplace，安装其中一个插件，再停用它。
    const fixture = await createPluginLifecycleFixture("1.0.0");
    await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    await installMarketplacePluginThroughAgent(
      PLUGIN_LIFECYCLE_NAME,
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );
    await disableLocalPlugin();
    await waitUntilPluginList(
      (list) => list.plugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && !plugin.enabled),
      `${CASE_MARKER}: 本机插件没有变为停用`,
    );

    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
    });
    await waitForTestIdByDom("remote-sync-device-list", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 数据同步页没有在线设备`,
    });
    await clickTestIdByDom("remote-sync-device-action", { timeout: 30_000 });
    await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
    await clickTestIdByDom("remote-sync-tab-plugins", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 同步弹窗没有插件分类`,
    });

    // 只在本机存在的 marketplace 插件显示「推送」并默认勾选。
    const row = await waitForRowStatus(ROW_KEY, "push", "marketplace 插件没有显示为「推送」");
    expect(row.checked).toBe("true");
    expect(row.text).toContain(PLUGIN_LIFECYCLE_MARKETPLACE_ID);

    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送插件按钮不可用`,
    });
    await browser.waitUntil(async () => (await readButtonText("remote-sync-push")) === "再次同步", {
      timeout: 300_000,
      timeoutMsg: `${CASE_MARKER}: 推送插件没有完成`,
    });
    await waitForRowStatus(ROW_KEY, "synced", "推送后 marketplace 插件没有变为「已同步」");
    expect(
      await browser.execute(() =>
        document.querySelector('[data-testid^="remote-sync-row-error-"]'),
      ),
    ).toBeNull();

    // 远端：marketplace 来源是镜像到 ~/.zcode/plugins/marketplace-sources 的副本，插件以 User scope 安装且停用。
    const knownMarketplaces = await readRemoteContainerFile(
      container,
      `${REMOTE_PLUGIN_STORAGE}/known_marketplaces.json`,
    );
    expect(knownMarketplaces).toContain(PLUGIN_LIFECYCLE_MARKETPLACE_ID);
    expect(knownMarketplaces).toContain("/home/dev/.zcode/plugins/marketplace-sources/");
    const installed = await readRemoteContainerFile(
      container,
      `${REMOTE_PLUGIN_STORAGE}/installed_plugins.json`,
    );
    expect(installed).toContain(PLUGIN_LIFECYCLE_ID);
    const remoteConfig = await readRemoteJson(container, REMOTE_CONFIG);
    const enabledPlugins = ((remoteConfig.plugins ?? {}) as Record<string, unknown>)
      .enabledPlugins as Record<string, boolean> | undefined;
    expect(enabledPlugins?.[PLUGIN_LIFECYCLE_ID]).toBe(false);
  });
});

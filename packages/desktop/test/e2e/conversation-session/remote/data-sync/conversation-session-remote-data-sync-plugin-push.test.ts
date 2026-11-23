import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  execInRemoteContainer,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  remoteContainerPathExists,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-07：设置 → 数据同步 → 设备 → 推送 inline 插件（docs/remote/data-sync.md「插件」）。
// 远端为本机 Docker runner（或服务器队列）提供的真实 Linux 容器；远端断言用 docker exec 读容器内 ~/.zcode。
const CASE_MARKER = "E2E_DSYNC_07_PLUGIN_PUSH";
const PLUGIN_NAME = "e2e-dsync-plugin";
const PLUGIN_KEY = `${PLUGIN_NAME}@inline`;
const REMOTE_PLUGIN_DIR = `/home/dev/.zcode/plugins/${PLUGIN_NAME}`;
const REMOTE_CONFIG = "/home/dev/.zcode/cli/config.json";
const REMOTE_DATA_MARKER = `${CASE_MARKER}_REMOTE_DATA`;
const BIG_PLUGIN_NAME = "e2e-dsync-big-plugin";
const BIG_PLUGIN_KEY = `${BIG_PLUGIN_NAME}@inline`;
const REMOTE_BIG_PLUGIN_DIR = `/home/dev/.zcode/plugins/${BIG_PLUGIN_NAME}`;
// 32MiB 随机内容：RPC 若把归档展开成 JSON 数字数组（约 3.6 倍）会超过远端 WebSocket 单条消息上限 100MiB；
// 按 base64（约 4/3 倍）传输约 43MiB。
const BIG_PLUGIN_PAYLOAD_BYTES = 32 * 1024 * 1024;

function localPluginDir(): string {
  return join(getE2EAppDataPaths().homeDir, ".zcode", "plugins", PLUGIN_NAME);
}

async function writeLocalPlugin(version: string): Promise<void> {
  const dir = localPluginDir();
  await mkdir(join(dir, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(dir, ".zcode-plugin", "plugin.json"),
    `${JSON.stringify({ name: PLUGIN_NAME, version, description: "data sync e2e plugin" }, null, 2)}\n`,
  );
  await mkdir(join(dir, "skills", "dsync-hello"), { recursive: true });
  await writeFile(
    join(dir, "skills", "dsync-hello", "SKILL.md"),
    `---\nname: dsync-hello\ndescription: ${CASE_MARKER} ${version}\n---\nHello ${version}\n`,
  );
  // 本机的 data/ 是运行数据，不应推送到远端。
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(join(dir, "data", "local.json"), `{"marker":"${CASE_MARKER}_LOCAL_DATA"}\n`);
}

/** 把插件目录登记到本机 config.json 的 plugins.dirs（保留已有字段）。 */
async function registerLocalPlugin(pluginDir = localPluginDir()): Promise<void> {
  const configPath = join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    config = {};
  }
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const dirs = Array.isArray(plugins.dirs) ? (plugins.dirs as string[]) : [];
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, plugins: { ...plugins, dirs: [...dirs, pluginDir] } }, null, 2)}\n`,
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
    timeout: 60_000,
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

async function pushPluginsAndWait(): Promise<void> {
  await clickTestIdByDom("remote-sync-push", {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 推送插件按钮不可用`,
  });
  await browser.waitUntil(async () => (await readButtonText("remote-sync-push")) === "再次同步", {
    timeout: 120_000,
    timeoutMsg: `${CASE_MARKER}: 推送插件没有完成`,
  });
}

async function openPluginsTab(): Promise<void> {
  await clickTestIdByDom("remote-sync-device-action", { timeout: 30_000 });
  await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
  await clickTestIdByDom("remote-sync-tab-plugins", {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 同步弹窗没有插件分类`,
  });
}

async function readRemoteConfig(container: string): Promise<{ plugins?: { dirs?: string[] } }> {
  return JSON.parse(await readRemoteContainerFile(container, REMOTE_CONFIG)) as {
    plugins?: { dirs?: string[] };
  };
}

describe(`${CASE_MARKER}: 数据同步页推送 inline 插件`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-07-01/02 新插件写入远端并登记 plugins.dirs；本机版本更新后远端原位更新且 data/ 不变", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];

    await writeLocalPlugin("1.0.0");
    await registerLocalPlugin();

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
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

    // DSYNC-07-01：只在本机存在的 inline 插件显示「推送」并默认勾选；推送后远端目录和 plugins.dirs 都写入。
    await openPluginsTab();
    const newRow = await waitForRowStatus(PLUGIN_KEY, "push", "新插件没有显示为「推送」");
    expect(newRow.checked).toBe("true");
    await pushPluginsAndWait();
    await waitForRowStatus(PLUGIN_KEY, "synced", "推送后插件没有变为「已同步」");
    expect(
      await readRemoteContainerFile(container, `${REMOTE_PLUGIN_DIR}/.zcode-plugin/plugin.json`),
    ).toContain('"version": "1.0.0"');
    expect(
      await readRemoteContainerFile(container, `${REMOTE_PLUGIN_DIR}/skills/dsync-hello/SKILL.md`),
    ).toContain("Hello 1.0.0");
    expect(await remoteContainerPathExists(container, `${REMOTE_PLUGIN_DIR}/data`)).toBe(false);
    expect((await readRemoteConfig(container)).plugins?.dirs).toContain(REMOTE_PLUGIN_DIR);

    // DSYNC-07-02：远端插件有自己的 data/；本机升级版本后显示「1.0.0 → 1.1.0 · 更新」，推送后原位更新，data/ 不变。
    await writeRemoteContainerFile(
      container,
      `${REMOTE_PLUGIN_DIR}/data/state.json`,
      `{"marker":"${REMOTE_DATA_MARKER}"}\n`,
    );
    await writeLocalPlugin("1.1.0");
    await clickTestIdByDom("remote-sync-tab-overview");
    await clickTestIdByDom("remote-sync-close");
    await openPluginsTab();
    const updateRow = await waitForRowStatus(PLUGIN_KEY, "update", "本机新版本没有显示为「更新」");
    expect(updateRow.checked).toBe("true");
    expect(updateRow.text).toContain("1.0.0");
    expect(updateRow.text).toContain("1.1.0");
    await pushPluginsAndWait();
    await waitForRowStatus(PLUGIN_KEY, "synced", "更新后插件没有变为「已同步」");
    expect(
      await readRemoteContainerFile(container, `${REMOTE_PLUGIN_DIR}/.zcode-plugin/plugin.json`),
    ).toContain('"version": "1.1.0"');
    expect(
      await readRemoteContainerFile(container, `${REMOTE_PLUGIN_DIR}/skills/dsync-hello/SKILL.md`),
    ).toContain("Hello 1.1.0");
    expect(
      await readRemoteContainerFile(container, `${REMOTE_PLUGIN_DIR}/data/state.json`),
    ).toContain(REMOTE_DATA_MARKER);
    // 更新不重复登记目录。
    expect(
      (await readRemoteConfig(container)).plugins?.dirs?.filter((dir) => dir === REMOTE_PLUGIN_DIR),
    ).toHaveLength(1);
  });

  it("DSYNC-07-03 约 32MB 的 inline 插件推送成功，远端收到完整内容", async function () {
    this.timeout(15 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    // 接续 DSYNC-07-01/02：弹窗停在插件分类。
    await clickTestIdByDom("remote-sync-tab-overview");
    await clickTestIdByDom("remote-sync-close");

    const dir = join(getE2EAppDataPaths().homeDir, ".zcode", "plugins", BIG_PLUGIN_NAME);
    await mkdir(join(dir, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".zcode-plugin", "plugin.json"),
      `${JSON.stringify({ name: BIG_PLUGIN_NAME, version: "1.0.0", description: "large data sync e2e plugin" }, null, 2)}\n`,
    );
    await writeFile(join(dir, "payload.bin"), randomBytes(BIG_PLUGIN_PAYLOAD_BYTES));
    await registerLocalPlugin(dir);

    await openPluginsTab();
    const bigRow = await waitForRowStatus(BIG_PLUGIN_KEY, "push", "大插件没有显示为「推送」");
    expect(bigRow.checked).toBe("true");
    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送插件按钮不可用`,
    });
    await browser
      .waitUntil(async () => (await readRowState(BIG_PLUGIN_KEY))?.status === "synced", {
        timeout: 5 * 60_000,
        interval: 1_000,
      })
      .catch(async (error: unknown) => {
        const state = await readRowState(BIG_PLUGIN_KEY);
        const pushError = await browser.execute(
          () => document.querySelector('[data-testid="remote-sync-push-error"]')?.textContent ?? "",
        );
        throw new Error(
          `${CASE_MARKER}: 大插件推送后没有变为「已同步」；行=${JSON.stringify(state)}；分类错误=${pushError}`,
          { cause: error },
        );
      });
    const remoteSize = (
      await execInRemoteContainer(container, [
        "stat",
        "-c",
        "%s",
        `${REMOTE_BIG_PLUGIN_DIR}/payload.bin`,
      ])
    ).stdout.trim();
    expect(Number(remoteSize)).toBe(BIG_PLUGIN_PAYLOAD_BYTES);
    expect((await readRemoteConfig(container)).plugins?.dirs).toContain(REMOTE_BIG_PLUGIN_DIR);
    await clickTestIdByDom("remote-sync-tab-overview");
    await clickTestIdByDom("remote-sync-close");
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  readRemoteContainerFile,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-10：设置 → 数据同步 → 设备 → 推送命令（docs/remote/data-sync.md「命令」）。
// 本机来源合并 ~/.zcode/commands 与 ~/.agents/commands，统一写入远端 ~/.zcode/commands；
// 远端断言用 docker exec 读容器内文件与 ~/.zcode/cli/config.json 的启用覆盖。
const CASE_MARKER = "E2E_DSYNC_10_COMMAND_PUSH";
const NESTED_KEY = "/e2e-dsync/commit";
const AGENTS_KEY = "/e2e-dsync-review";
const REMOTE_COMMANDS = "/home/dev/.zcode/commands";
const REMOTE_CLI_CONFIG = "/home/dev/.zcode/cli/config.json";

const NESTED_CONTENT = [
  "---",
  "description: Write a commit message",
  `x-e2e-marker: ${CASE_MARKER} # keep comment`,
  "---",
  "Write a commit message for the staged diff.",
  "",
].join("\n");
const AGENTS_CONTENT = [
  "---",
  "description: Review the diff from the compat directory",
  "---",
  "Review the diff.",
  "",
].join("\n");

async function readRowState(key: string) {
  return await browser.execute((rowTestId) => {
    const row = document.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
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

/** 本机 config.json 读改写：只加一条命令禁用覆盖，保留 E2E 预置的其他配置。 */
async function disableLocalCommand(homeDir: string, filePath: string) {
  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    config = {};
  }
  const command = (config.command ?? {}) as Record<string, unknown>;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ ...config, command: { ...command, [filePath]: { enable: false } } }, null, 2),
  );
}

describe(`${CASE_MARKER}: 数据同步页推送命令`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-10-01 推送子目录下的禁用命令与 ~/.agents 来源的命令，远端写入 ~/.zcode/commands 且保持禁用", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const { homeDir } = getE2EAppDataPaths();

    const nestedPath = join(homeDir, ".zcode", "commands", "e2e-dsync", "commit.md");
    const agentsPath = join(homeDir, ".agents", "commands", "e2e-dsync-review.md");
    await mkdir(dirname(nestedPath), { recursive: true });
    await writeFile(nestedPath, NESTED_CONTENT);
    await mkdir(dirname(agentsPath), { recursive: true });
    await writeFile(agentsPath, AGENTS_CONTENT);

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    await disableLocalCommand(homeDir, nestedPath);

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
    await clickTestIdByDom("remote-sync-device-action");
    await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });

    // 概览有命令一行；进入分类页后两条命令都为「推送」且默认勾选。
    await waitForTestIdByDom("remote-sync-overview-commands", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 概览没有命令一行`,
    });
    await clickTestIdByDom("remote-sync-tab-commands");
    const nestedRow = await waitForRowStatus(NESTED_KEY, "push", "子目录命令没有显示为「推送」");
    expect(nestedRow.checked).toBe("true");
    expect(nestedRow.text).toContain(NESTED_KEY);
    const agentsRow = await waitForRowStatus(AGENTS_KEY, "push", ".agents 命令没有显示为「推送」");
    expect(agentsRow.checked).toBe("true");

    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送命令按钮不可用`,
    });
    await waitForRowStatus(NESTED_KEY, "synced", "推送后子目录命令没有变为「已同步」");
    await waitForRowStatus(AGENTS_KEY, "synced", "推送后 .agents 命令没有变为「已同步」");

    const remoteNested = `${REMOTE_COMMANDS}/e2e-dsync/commit.md`;
    expect(await readRemoteContainerFile(container, remoteNested)).toBe(NESTED_CONTENT);
    expect(await readRemoteContainerFile(container, `${REMOTE_COMMANDS}/e2e-dsync-review.md`)).toBe(
      AGENTS_CONTENT,
    );
    // 禁用覆盖换算为远端绝对路径。
    const remoteConfig = JSON.parse(
      await readRemoteContainerFile(container, REMOTE_CLI_CONFIG),
    ) as { command?: Record<string, { enable?: boolean }> };
    expect(remoteConfig.command?.[remoteNested]).toEqual({ enable: false });
    expect(remoteConfig.command?.[`${REMOTE_COMMANDS}/e2e-dsync-review.md`]).toBeUndefined();
  });
});

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
  remoteContainerPathExists,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-11：设置 → 数据同步 → 设备 → 推送钩子（docs/remote/data-sync.md「钩子」）。
// 只同步本机 ~/.zcode/cli/config.json 的 hooks；写入时合并到远端 events[事件] 中 matcher 相同的分组，
// 远端已有钩子和其他配置原样保留，根级 enabled 只开不关。远端断言用 docker exec 读容器内 config.json。
const CASE_MARKER = "E2E_DSYNC_11_HOOK_PUSH";
const REMOTE_CLI_CONFIG = "/home/dev/.zcode/cli/config.json";
const PUSHED_HOOK = {
  type: "command",
  command: `echo ${CASE_MARKER} post-bash`,
  timeout: 30,
  statusMessage: "E2E hook",
};
const REMOTE_EXISTING_BASH = { type: "command", command: `echo ${CASE_MARKER} remote-bash` };
const REMOTE_EXISTING_EDIT = { type: "command", command: `echo ${CASE_MARKER} remote-edit` };
const REMOTE_PRE_TOOL = { type: "command", command: `echo ${CASE_MARKER} remote-pre` };

type HookConfigFile = Record<string, unknown> & {
  hooks?: Record<string, unknown> & { enabled?: boolean; events?: Record<string, unknown> };
};

/** 钩子行的 key 是规范化哈希：按行内显示的完整命令找到该行。 */
async function readHookRow(command: string) {
  return await browser.execute((text) => {
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid^="remote-sync-row-"]'),
    ].find((candidate) => candidate.textContent?.includes(text));
    return row
      ? {
          key: row.dataset.syncKey ?? null,
          status: row.dataset.syncStatus ?? null,
          checked: row.getAttribute("aria-checked"),
          text: row.textContent ?? "",
        }
      : null;
  }, command);
}

async function waitForHookRowStatus(command: string, status: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readHookRow(command))?.status === status, {
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
  return (await readHookRow(command))!;
}

/** 本机 config.json 读改写：只写 hooks，保留 E2E 预置的其他配置。 */
async function writeLocalHooks(homeDir: string) {
  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    config = {};
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...config,
        hooks: {
          enabled: true,
          events: { PostToolUse: [{ matcher: "Bash", hooks: [PUSHED_HOOK] }] },
        },
      },
      null,
      2,
    ),
  );
}

/** 远端 config.json 读改写：保留连接过程已写入的字段，预置远端自己的钩子（根级关闭）。 */
async function seedRemoteHooks(container: string): Promise<HookConfigFile> {
  const existing = (await remoteContainerPathExists(container, REMOTE_CLI_CONFIG))
    ? (JSON.parse(await readRemoteContainerFile(container, REMOTE_CLI_CONFIG)) as HookConfigFile)
    : {};
  const seeded: HookConfigFile = {
    ...existing,
    hooks: {
      enabled: false,
      timeoutMs: 45_000,
      events: {
        PostToolUse: [
          { matcher: "Edit", hooks: [REMOTE_EXISTING_EDIT] },
          { matcher: "Bash", hooks: [REMOTE_EXISTING_BASH] },
        ],
        PreToolUse: [{ hooks: [REMOTE_PRE_TOOL] }],
      },
    },
  };
  await writeRemoteContainerFile(container, REMOTE_CLI_CONFIG, JSON.stringify(seeded, null, 2));
  return seeded;
}

describe(`${CASE_MARKER}: 数据同步页推送钩子`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-11-01 推送一条 PostToolUse 钩子，合并进远端同 matcher 分组，远端原有钩子与配置保留，根级开关被打开", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const { homeDir } = getE2EAppDataPaths();

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    await writeLocalHooks(homeDir);
    const seeded = await seedRemoteHooks(container);

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

    // 概览有钩子一行；分类页该钩子为「推送」且默认勾选，行内显示事件、matcher 与完整命令。
    await waitForTestIdByDom("remote-sync-overview-hooks", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 概览没有钩子一行`,
    });
    await clickTestIdByDom("remote-sync-tab-hooks");
    const row = await waitForHookRowStatus(PUSHED_HOOK.command, "push", "钩子没有显示为「推送」");
    expect(row.checked).toBe("true");
    expect(row.text).toContain("PostToolUse · Bash");
    expect(row.text).toContain(PUSHED_HOOK.command);

    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送钩子按钮不可用`,
    });
    await waitForHookRowStatus(PUSHED_HOOK.command, "synced", "推送后钩子没有变为「已同步」");

    const remoteConfig = JSON.parse(
      await readRemoteContainerFile(container, REMOTE_CLI_CONFIG),
    ) as HookConfigFile;
    // 其他配置字段原样保留。
    const { hooks: _seededHooks, ...seededRest } = seeded;
    const { hooks: remoteHooks, ...remoteRest } = remoteConfig;
    expect(remoteRest).toEqual(seededRest);
    expect(remoteHooks).toEqual({
      enabled: true,
      timeoutMs: 45_000,
      events: {
        PostToolUse: [
          { matcher: "Edit", hooks: [REMOTE_EXISTING_EDIT] },
          { matcher: "Bash", hooks: [REMOTE_EXISTING_BASH, PUSHED_HOOK] },
        ],
        PreToolUse: [{ hooks: [REMOTE_PRE_TOOL] }],
      },
    });
  });
});

import { mkdir, writeFile } from "node:fs/promises";
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
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-06：设置 → 数据同步 → 设备 → 推送 MCP 服务器（docs/remote/data-sync.md「MCP 服务器」）。
// 远端为本机 Docker runner（或服务器队列）提供的真实 Linux 容器；远端断言用 docker exec 读容器内 config.json。
const CASE_MARKER = "E2E_DSYNC_06_MCP_PUSH";
const STDIO_SERVER = "E2E-Dsync-Stdio";
const STDIO_KEY = STDIO_SERVER.toLowerCase();
const FILESYSTEM_SERVER = "filesystem";
const REMOTE_HOME = "/home/dev";
const REMOTE_CONFIG = `${REMOTE_HOME}/.zcode/cli/config.json`;

async function writeLocalMcpServers(home: string): Promise<void> {
  const dir = join(home, ".zcode", "cli");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.json"),
    `${JSON.stringify(
      {
        mcp: {
          servers: {
            // 非 filesystem 类：args / env / cwd 原样写入远端。
            [STDIO_SERVER]: {
              command: "node",
              args: ["-e", "process.exit(0)", join(home, "tool.js")],
              env: { E2E_TOKEN: CASE_MARKER },
            },
            // filesystem 类：args 中的本机 home 改写为远端 home；本机停用状态随新建带过去。
            [FILESYSTEM_SERVER]: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", join(home, "projects")],
              enabled: false,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

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

async function readButtonText(buttonTestId: string): Promise<string> {
  return await browser.execute(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? "",
    buttonTestId,
  );
}

describe(`${CASE_MARKER}: 数据同步页推送 MCP 服务器`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-06-01 推送 stdio MCP 与 filesystem MCP：远端配置按原样写入，filesystem 路径改写为远端 home", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const localHome = getE2EAppDataPaths().homeDir;

    await writeLocalMcpServers(localHome);
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
    await clickTestIdByDom("remote-sync-device-action");
    await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });

    // 概览有 MCP 行；进入分类页，两项都是「推送」并默认勾选，名称保留原大小写。
    await waitForTestIdByDom("remote-sync-overview-mcp", { timeout: 30_000 });
    await clickTestIdByDom("remote-sync-tab-mcp");
    const stdioRow = await waitForRowStatus(STDIO_KEY, "push", "stdio MCP 没有显示为「推送」");
    expect(stdioRow.checked).toBe("true");
    expect(stdioRow.text).toContain(STDIO_SERVER);
    const fsRow = await waitForRowStatus(
      FILESYSTEM_SERVER,
      "push",
      "filesystem MCP 没有显示为「推送」",
    );
    expect(fsRow.checked).toBe("true");

    await clickTestIdByDom("remote-sync-push", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 推送 MCP 按钮不可用`,
    });
    await browser.waitUntil(async () => (await readButtonText("remote-sync-push")) === "再次同步", {
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 推送 MCP 没有完成`,
    });
    // 推送后重新比较：路径改写后两端一致，filesystem MCP 不会因 home 不同被判为差异。
    await waitForRowStatus(STDIO_KEY, "synced", "推送后 stdio MCP 没有变为「已同步」");
    await waitForRowStatus(FILESYSTEM_SERVER, "synced", "推送后 filesystem MCP 没有变为「已同步」");

    const remote = JSON.parse(await readRemoteContainerFile(container, REMOTE_CONFIG)) as {
      mcp?: { servers?: Record<string, Record<string, unknown>> };
    };
    expect(remote.mcp?.servers?.[STDIO_SERVER]).toEqual({
      command: "node",
      args: ["-e", "process.exit(0)", join(localHome, "tool.js")],
      env: { E2E_TOKEN: CASE_MARKER },
    });
    expect(remote.mcp?.servers?.[FILESYSTEM_SERVER]).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", `${REMOTE_HOME}/projects`],
      enabled: false,
    });
    const mode = await execInRemoteContainer(container, ["stat", "-c", "%a", REMOTE_CONFIG]);
    expect(mode.stdout.trim()).toBe("600");
  });
});

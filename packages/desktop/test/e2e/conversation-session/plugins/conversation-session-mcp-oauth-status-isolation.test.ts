import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_MCP_SERVER_ROW,
  TID_PLUGIN_MCP_SERVER_ROW,
  TID_SETTINGS_BACK_BUTTON,
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
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  startMcpOAuthStatusIsolationServer,
  type McpOAuthStatusIsolationServer,
} from "#e2e/helpers/mcp-oauth-status-isolation";

const CASE_TIMEOUT_MS = 180_000;
const DIRECT_MCP_NAME = "everything";
const DIRECT_MCP_TOOL_NAME = "mcp__everything__ping";
const PLAIN_HTTP_MCP_NAME = "plain_http";
const PLAIN_HTTP_MCP_TOOL_NAME = "mcp__plain_http__ping";
const PLUGIN_ID = "e2e-plugin-mcp-oauth@e2e-fixture";
const PLUGIN_NAME = "e2e-plugin-mcp-oauth";
const PLUGIN_RUNTIME_MCP_NAME = `plugin:${PLUGIN_NAME}:canva`;
const PROMPT_MARKER = "E2E_MCP_OAUTH_STATUS_ISOLATION";
const DIRECT_RESULT = `E2E_MCP_DIRECT_PONG:${PROMPT_MARKER}`;
const PLAIN_HTTP_RESULT = `E2E_MCP_HTTP_PONG:${PROMPT_MARKER}`;
const E2E_PATHS = getE2EAppDataPaths();
const CLI_CONFIG_FILE = join(E2E_PATHS.homeDir, ".zcode", "cli", "config.json");
const INSTALLED_PLUGINS_FILE = join(
  E2E_PATHS.homeDir,
  ".zcode",
  "cli",
  "plugins",
  "installed_plugins.json",
);
const PLUGIN_ROOT = join(E2E_PATHS.homeDir, ".zcode", "cli", "e2e-fixtures", PLUGIN_NAME);
const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json");
const CASE_ROOT = join(E2E_PATHS.workspace, "mcp-oauth-status-isolation-e2e");
const DIRECT_MCP_CALL_LOG = join(CASE_ROOT, "direct-mcp-calls.ndjson");
const DIRECT_MCP_SERVER_SCRIPT = resolve(
  process.cwd(),
  "test/e2e/fixtures/mcp/oauth-status-isolation-direct-server.mjs",
);

describe("会话区 MCP OAuth 状态刷新隔离 E2E", () => {
  let oauthServer: McpOAuthStatusIsolationServer | null = null;

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await oauthServer?.close();
  });

  it("MO01/MO03: 插件 OAuth 状态刷新不会断开 stdio 与普通 HTTP MCP", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    oauthServer = await startMcpOAuthStatusIsolationServer();
    await writeMcpFixtures(oauthServer.mcpUrl, oauthServer.plainHttpMcpUrl);
    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);

    await openMcpSettings();
    await waitForMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, DIRECT_MCP_NAME),
      toolCount: 1,
    });
    await waitForMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, PLAIN_HTTP_MCP_NAME),
      toolCount: 1,
    });
    await waitForMcpRow({
      status: "connecting",
      testIdValue: testId(TID_PLUGIN_MCP_SERVER_ROW, PLUGIN_RUNTIME_MCP_NAME),
      toolCount: 0,
    });
    const directMcpPid = await waitForDirectMcpProcessStarted(30_000);
    await waitForTestIdByDom(testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, PLUGIN_RUNTIME_MCP_NAME), {
      timeout: 30_000,
      timeoutMsg: "插件 MCP 没有展示 OAuth 授权入口",
    });

    const pendingSnapshot = oauthServer.snapshot();
    expect(pendingSnapshot.unauthorizedMcpRequestCount).toBeGreaterThan(0);

    // 修复原因：旧实现的 1s OAuth poll 会把空的用户 MCP 子集送进 replace 路径。
    // 等至少两个周期，同时检查用户 stdio 进程和普通 HTTP 连接没有被断开重建。
    await browser.pause(2_500);
    expect(oauthServer.snapshot()).toMatchObject({
      plainHttpInitializeCount: pendingSnapshot.plainHttpInitializeCount,
      unauthorizedMcpRequestCount: pendingSnapshot.unauthorizedMcpRequestCount,
    });
    await expectMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, DIRECT_MCP_NAME),
      toolCount: 1,
    });
    expectProcessAlive(directMcpPid, "status-only poll 期间用户级 MCP 被断开");
    await expectMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, PLAIN_HTTP_MCP_NAME),
      toolCount: 1,
    });

    await clickTestIdByDom(testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, PLUGIN_RUNTIME_MCP_NAME), {
      timeout: 15_000,
      timeoutMsg: "插件 MCP OAuth 授权按钮不可点击",
    });
    const authorizationUrl = await waitForOpenedAuthorizationUrl(openExternalMock);
    await oauthServer.completeAuthorization(authorizationUrl);

    await waitForMcpRow({
      status: "connected",
      testIdValue: testId(TID_PLUGIN_MCP_SERVER_ROW, PLUGIN_RUNTIME_MCP_NAME),
      toolCount: 1,
    });
    await expectMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, DIRECT_MCP_NAME),
      toolCount: 1,
    });
    await expectMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, PLAIN_HTTP_MCP_NAME),
      toolCount: 1,
    });
    expect(oauthServer.snapshot()).toMatchObject({
      authorizationRequestCount: 1,
      // 运行日志确认 workspace 管理连接和预热 Session 各持有一个 MCP client；
      // OAuth 流程仍只有一次，凭据发布后两个既有 client 各完成一次 initialize。
      authorizedInitializeCount: pendingSnapshot.plainHttpInitializeCount,
      plainHttpInitializeCount: pendingSnapshot.plainHttpInitializeCount,
      registrationRequestCount: 1,
      tokenRequestCount: 1,
    });

    await verifyConfigLoadFailureKeepsMcpRuntime(directMcpPid, oauthServer);

    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "MCP 设置页返回按钮没有出现",
    });
    await waitForV4Pane(() => true, "完成 MCP OAuth 后没有回到工作区", 15_000);
    await startNewV4Draft();
    // 权限模式属于当前草稿；先设模式再新建会恢复默认模式，真实 MCP 调用会停在审批。
    await ensureToolCrossProductFullAccessMode();

    const prompt = `${PROMPT_MARKER}: Call ${DIRECT_MCP_TOOL_NAME} exactly once with marker "${PROMPT_MARKER}", then call ${PLAIN_HTTP_MCP_TOOL_NAME} exactly once with the same marker, then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "MCP OAuth 隔离 case 首发后输入框没有清空");
    await waitForV4UserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [PROMPT_MARKER, DIRECT_MCP_TOOL_NAME, PLAIN_HTTP_MCP_TOOL_NAME],
      },
      "首轮 provider 请求没有同时暴露 stdio 与普通 HTTP MCP 工具",
      60_000,
    );
    await waitForToolCallBlockByToolName(DIRECT_MCP_TOOL_NAME, 60_000);
    await waitForDirectMcpCall(PROMPT_MARKER, 60_000);
    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [PROMPT_MARKER, DIRECT_MCP_TOOL_NAME, DIRECT_RESULT],
      },
      "用户级 MCP tool_result 没有进入 provider continuation",
      60_000,
    );
    await waitForToolCallBlockByToolName(PLAIN_HTTP_MCP_TOOL_NAME, 60_000);
    await waitForPlainHttpMcpCall(oauthServer, PROMPT_MARKER, 60_000);
    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [PROMPT_MARKER, DIRECT_RESULT, PLAIN_HTTP_MCP_TOOL_NAME, PLAIN_HTTP_RESULT],
      },
      "普通 HTTP MCP tool_result 没有进入 provider continuation",
      60_000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MCP OAuth 隔离 case 完成后会话没有回到 idle",
      60_000,
    );
  });
});

async function openMcpSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, {
    timeout: 15_000,
    timeoutMsg: "设置页没有渲染",
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现 MCP 分区入口",
  });
}

interface McpRowExpectation {
  status: string;
  testIdValue: string;
  toolCount: number;
}

interface McpRowSnapshot {
  exists: boolean;
  status: string | null;
  text: string;
  toolCount: number | null;
}

async function waitForMcpRow(expectation: McpRowExpectation): Promise<void> {
  let latest: McpRowSnapshot = {
    exists: false,
    status: null,
    text: "",
    toolCount: null,
  };
  await browser.waitUntil(
    async () => {
      latest = await readMcpRow(expectation.testIdValue);
      return matchesMcpRow(latest, expectation);
    },
    {
      timeout: 45_000,
      timeoutMsg: `MCP 行状态未收敛: expected=${JSON.stringify(expectation)} latest=${JSON.stringify(latest)}`,
    },
  );
}

async function expectMcpRow(expectation: McpRowExpectation): Promise<void> {
  expect(await readMcpRow(expectation.testIdValue)).toMatchObject({
    exists: true,
    status: expectation.status,
    toolCount: expectation.toolCount,
  });
}

function matchesMcpRow(snapshot: McpRowSnapshot, expectation: McpRowExpectation): boolean {
  return (
    snapshot.exists &&
    snapshot.status === expectation.status &&
    snapshot.toolCount === expectation.toolCount
  );
}

async function readMcpRow(testIdValue: string): Promise<McpRowSnapshot> {
  return (await browser.execute((targetTestId) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === targetTestId,
    );
    if (!element) {
      return { exists: false, status: null, text: "", toolCount: null };
    }
    const rawToolCount = element.dataset.mcpToolCount;
    return {
      exists: true,
      status: element.dataset.mcpStatus ?? null,
      text: element.innerText,
      toolCount: rawToolCount === undefined || rawToolCount === "" ? null : Number(rawToolCount),
    };
  }, testIdValue)) as McpRowSnapshot;
}

async function waitForOpenedAuthorizationUrl(
  openExternalMock: Awaited<ReturnType<typeof browser.electron.mock>>,
): Promise<string> {
  let authorizationUrl = "";
  await browser.waitUntil(
    async () => {
      await openExternalMock.update();
      authorizationUrl =
        openExternalMock.mock.calls
          .map((call) => call[0])
          .find(
            (value): value is string => typeof value === "string" && value.includes("/authorize?"),
          ) ?? "";
      return Boolean(authorizationUrl);
    },
    {
      timeout: 15_000,
      timeoutMsg: "没有捕获到平台 openExternal 的 MCP OAuth URL",
    },
  );
  return authorizationUrl;
}

async function writeMcpFixtures(mcpUrl: string, plainHttpMcpUrl: string): Promise<void> {
  await mkdir(CASE_ROOT, { recursive: true });
  await rm(DIRECT_MCP_CALL_LOG, { force: true });
  await mkdir(join(PLUGIN_ROOT, ".zcode-plugin"), { recursive: true });
  await mkdir(join(E2E_PATHS.homeDir, ".zcode", "cli", "plugins"), {
    recursive: true,
  });

  await writeFile(
    PLUGIN_MANIFEST_FILE,
    `${JSON.stringify(
      {
        author: { name: "ZCode E2E" },
        description: "E2E fixture plugin with an OAuth-protected MCP server.",
        license: "MIT",
        mcpServers: {
          canva: {
            // 此夹具只实现 legacy；显式声明以排除 dual-era 探测握手对 OAuth 连接计数的干扰。
            protocolVersion: "legacy",
            oauth: {
              clientName: "ZCode MCP OAuth E2E",
              scope: "mcp:tools",
              type: "authorization_code",
            },
            timeoutMs: 30_000,
            type: "http",
            url: mcpUrl,
          },
        },
        name: PLUGIN_NAME,
        version: "0.0.0",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    INSTALLED_PLUGINS_FILE,
    `${JSON.stringify(
      {
        plugins: [
          {
            id: PLUGIN_ID,
            installPath: PLUGIN_ROOT,
            installedAt: "2026-07-10T00:00:00.000Z",
            marketplace: "e2e-fixture",
            name: PLUGIN_NAME,
            scope: "user",
            updatedAt: "2026-07-10T00:00:00.000Z",
            version: "0.0.0",
          },
        ],
        version: 1,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const config = await readJsonRecord(CLI_CONFIG_FILE);
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp.servers);
  const plugins = asRecord(config.plugins);
  const enabledPlugins = asRecord(plugins.enabledPlugins);
  enabledPlugins[PLUGIN_ID] = true;
  plugins.enabledPlugins = enabledPlugins;
  servers[DIRECT_MCP_NAME] = {
    args: [DIRECT_MCP_SERVER_SCRIPT],
    command: process.execPath,
    env: {
      E2E_MCP_DIRECT_CALL_LOG: DIRECT_MCP_CALL_LOG,
    },
    timeoutMs: 30_000,
    type: "stdio",
  };
  servers[PLAIN_HTTP_MCP_NAME] = {
    timeoutMs: 30_000,
    type: "http",
    url: plainHttpMcpUrl,
  };
  mcp.servers = servers;
  config.mcp = mcp;
  config.plugins = plugins;
  await writeFile(CLI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function waitForDirectMcpCall(marker: string, timeoutMs: number): Promise<void> {
  let latest: DirectMcpLogEntry[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readDirectMcpCalls();
      return latest.some((call) => call.tool === "ping" && call.marker === marker);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `用户级 MCP ping 没有真实执行: ${JSON.stringify(latest)}`,
    },
  );
}

async function waitForPlainHttpMcpCall(
  server: McpOAuthStatusIsolationServer,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = server.snapshot().plainHttpToolCallMarkers;
      return latest.includes(marker);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `普通 HTTP MCP ping 没有真实执行: ${JSON.stringify(latest)}`,
    },
  );
}

interface DirectMcpLogEntry {
  event?: "started";
  marker?: string;
  pid?: number;
  tool?: string;
}

async function waitForDirectMcpProcessStarted(timeoutMs: number): Promise<number> {
  let latest: DirectMcpLogEntry[] = [];
  let pid = 0;
  await browser.waitUntil(
    async () => {
      latest = await readDirectMcpCalls();
      pid = [...latest].reverse().find((entry) => entry.event === "started")?.pid ?? 0;
      return pid > 0;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `用户级 MCP 没有记录启动 PID: ${JSON.stringify(latest)}`,
    },
  );
  return pid;
}

function expectProcessAlive(pid: number, message: string): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    throw new Error(`${message}: pid=${pid}`, { cause: error });
  }
}

async function verifyConfigLoadFailureKeepsMcpRuntime(
  directMcpPid: number,
  server: McpOAuthStatusIsolationServer,
): Promise<void> {
  const validConfig = await readFile(CLI_CONFIG_FILE, "utf8");
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "制造 MCP 配置读取失败前无法返回工作区",
  });
  await waitForV4Pane(() => true, "制造 MCP 配置读取失败前工作区没有恢复", 15_000);
  await writeFile(CLI_CONFIG_FILE, "{ invalid e2e mcp config", "utf8");
  const plainHttpInitializeCount = server.snapshot().plainHttpInitializeCount;

  try {
    await openMcpSettings();
    // 修复原因：错误实现会把解析失败当空列表并异步执行 replace；等待其越过加载与 connect 窗口，
    // 再检查同一 PID，避免只在旧 UI snapshot 尚未更新时产生假阳性。
    await browser.pause(2_500);
    await expectMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, DIRECT_MCP_NAME),
      toolCount: 1,
    });
    expectProcessAlive(directMcpPid, "配置读取失败后用户级 MCP 被空列表 replace 断开");
    await expectMcpRow({
      status: "connected",
      testIdValue: testId(TID_MCP_SERVER_ROW, PLAIN_HTTP_MCP_NAME),
      toolCount: 1,
    });
    expect(server.snapshot().plainHttpInitializeCount).toBe(plainHttpInitializeCount);
  } finally {
    await writeFile(CLI_CONFIG_FILE, validConfig, "utf8");
  }

  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "恢复 MCP 配置前无法返回工作区",
  });
  await waitForV4Pane(() => true, "恢复 MCP 配置前工作区没有出现", 15_000);
  await openMcpSettings();
  await waitForMcpRow({
    status: "connected",
    testIdValue: testId(TID_MCP_SERVER_ROW, DIRECT_MCP_NAME),
    toolCount: 1,
  });
  await waitForMcpRow({
    status: "connected",
    testIdValue: testId(TID_PLUGIN_MCP_SERVER_ROW, PLUGIN_RUNTIME_MCP_NAME),
    toolCount: 1,
  });
  await waitForMcpRow({
    status: "connected",
    testIdValue: testId(TID_MCP_SERVER_ROW, PLAIN_HTTP_MCP_NAME),
    toolCount: 1,
  });
  // 恢复有效配置后会回到既有 connect replace 收敛路径；本 case 只证明读取失败窗口
  // 不会误发空配置并断开原进程，不额外约束恢复阶段必须复用 PID。
}

async function readDirectMcpCalls(): Promise<DirectMcpLogEntry[]> {
  try {
    const raw = await readFile(DIRECT_MCP_CALL_LOG, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DirectMcpLogEntry);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

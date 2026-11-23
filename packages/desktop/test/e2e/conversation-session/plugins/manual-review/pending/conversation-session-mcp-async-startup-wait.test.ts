import { createRemoteMcpFixture } from "#e2e/fixtures/mcp/remote-mcp-server";
import { selectTaskById } from "#e2e/helpers/conversation-session";
import { toolSearchBlocks } from "#e2e/helpers/toolsearch-provider";
import {
  createPluginLifecycleFixture,
  waitForPluginControl,
  addLifecycleMarketplaceThroughUi,
  openPluginCard,
  installPluginThroughUi,
  setPluginEnabledThroughUi,
  uninstallPluginThroughUi,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
} from "#e2e/helpers/plugin-management-lifecycle";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
  TID_SETTINGS_BACK_BUTTON,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_TASK_ITEM,
  TID_MCP_SERVER_ROW,
  TID_TASK_ARCHIVE,
  TID_VIRTUAL_PROJECT_NEW_TASK,
  TID_V4_SESSION_PANE,
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_SETTINGS_PAGE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  clickTestIdByDom,
  readSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  E2E_REPLY_TOKEN,
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  startNewV4Draft,
  V4_MAIN_PANE_ID,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  getUpstreamRequestToolContract,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  waitForToolCallBlockByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import {
  startMcpOAuthStatusIsolationServer,
  type McpOAuthStatusIsolationServer,
} from "#e2e/helpers/mcp-oauth-status-isolation";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import {
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
} from "#e2e/helpers/model-provider-restart";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { TOOLSEARCH_PLAN_PROVIDER } from "#e2e/helpers/toolsearch-desktop";
import { seedPersonalProviderConfig } from "#e2e/helpers/model-provider-restart-config";
import type { ToolSearchRequest } from "#e2e/helpers/toolsearch-provider";
import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const CASE = "MCPW01";
const CASE_TIMEOUT_MS = 300_000;
const SLOW_MCP_NAME = "slow";
const SEARCH_TOOL_NAME = "ToolSearch";
// Local 模式下模型看到的搜索工具名是 LocalToolSearch，执行与工具卡仍用规范名 ToolSearch。
const LOCAL_SEARCH_TOOL_NAME = "LocalToolSearch";
const SLOW_MCP_TOOL_NAME = "mcp__slow__ping";
const PROMPT_MARKER = "E2E_MCP_ASYNC_WAIT";
const HOT_MARKER = "E2E_MCP_HOT_CONFIG";
const HOT_TOOL = "mcp__hot__ping";
const REMOTE_READY_MARKER = "E2E_MCP_REMOTE_READY";
const REMOTE_RECOVERY_MARKER = "E2E_MCP_REMOTE_RECOVERY";
const REMOTE_TOOLS = ["mcp__remotehttp__ping", "mcp__remotesse__ping"];
// 提醒会列出全部准备中的 server（含官方插件），不能假设 slow 排第一；只断言标题和带引号的服务名。
const MCP_STATUS_HEADER = "The following MCP servers are still connecting —";
const PING_RESULT = `E2E_MCP_ASYNC_WAIT_PONG:${PROMPT_MARKER}`;
const PROVIDER_SIDECAR_EXCLUDES = ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"];
// 抓包文件由 launcher 进程排队写入；正常在数百毫秒内落盘，这里只防止无限等待。
const NATIVE_CAPTURE_FLUSH_TIMEOUT_MS = 10_000;
// 启动门控由测试释放；server 超时远大于等待上限（5s），避免 server 自身超时干扰结论。
const SLOW_MCP_SERVER_TIMEOUT_MS = 120_000;
// 慢 server 进程启动（先加载 MCP SDK 与 zod 才写 started）的等待上限；只防止无限等待。
const SLOW_MCP_START_WAIT_MS = 15_000;
const E2E_PATHS = getE2EAppDataPaths();
const CLI_CONFIG_FILE = join(E2E_PATHS.homeDir, ".zcode", "cli", "config.json");
const CASE_ROOT = resolveE2ERuntimePath(CASE);
const EVENT_LOG = join(CASE_ROOT, "slow-mcp-events.ndjson");
const RELEASE_FILE = join(CASE_ROOT, "slow-mcp.release");
const SLOW_MCP_SERVER_SCRIPT = resolve(
  process.cwd(),
  "test/e2e/fixtures/mcp/async-startup-wait-server.mjs",
);
// MCPW09：同一进程内两个会话共用配置监听。
const MCPW09_ROOT = join(CASE_ROOT, "mcpw09");
const MCPW09_SHARED_SERVER = "shared09";
const MCPW09_LATE_SERVER = "late09";
const MCPW09_SEED_A = "E2E_MCPW09_SEED_A";
const MCPW09_SEED_B = "E2E_MCPW09_SEED_B";
const MCPW09_SHARED_A = "E2E_MCPW09_SHARED_A";
const MCPW09_SHARED_B = "E2E_MCPW09_SHARED_B";
const MCPW09_LATE_B = "E2E_MCPW09_LATE_B";
const ARCHIVE_CONFIRMING_SELECTOR = "[data-archive-confirming-task-id]";
const CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";
const MOBILE_READY_SELECTOR = '[data-testid="sidebar"], [data-mobile-page="chat"]';
const MOBILE_VIEWPORT = { width: 390, height: 844 };
// 同一项目新建草稿后，预热会话要重建一次才能接收发送；运行中观测到约 1.2 s 才绑定。
// 期间发送会失败（docs/issues/draft-session-prewarm-legacy/01），用例固定等待后再发送。
const MCPW09_DRAFT_PREWARM_SETTLE_MS = 2_000;
// 两个会话的 MCP 启动连接结束的等待上限：每个 server 最多等 15 s，再留余量。
const MCPW09_STARTUP_WAIT_MS = 60_000;
// 配置变化最多晚一个去抖窗口进入会话（CLI `MCP_CONFIG_EVENT_DEBOUNCE_MS`，
// 见 docs/mcp-async-tool-catalog-cache.md 的配置一节）；余量覆盖文件事件与重新加载。
const MCP_CONFIG_EVENT_DEBOUNCE_MS = 300;
const MCP_CONFIG_SETTLE_MARGIN_MS = 700;
const MCP_CONFIG_SETTLE_MS = MCP_CONFIG_EVENT_DEBOUNCE_MS + MCP_CONFIG_SETTLE_MARGIN_MS;

// MCPW10：调用期 OAuth 授权。
const MCPW10_CASE = "MCPW10";
const MCPW10_SERVER = "oauthmcp";
const MCPW10_TOOL = `mcp__${MCPW10_SERVER}__oauth_ping`;
const MCPW10_OAUTH_CLIENT_NAME = "ZCode MCPW10 OAuth E2E";
const MCPW10_OAUTH_SCOPE = "mcp:tools";
const MCPW10_SERVER_TIMEOUT_MS = 30_000;
const MCPW10_FIRST = "E2E_MCPW10_FIRST";
const MCPW10_REVOKED = "E2E_MCPW10_REVOKED";
const MCPW10_REAUTHORIZED = "E2E_MCPW10_REAUTHORIZED";
const MCPW10_FIRST_CALL_ID = "toolu_mcpw10_first_call";
const MCPW10_REVOKED_CALL_ID = "toolu_mcpw10_revoked_call";
const MCPW10_REAUTHORIZED_CALL_ID = "toolu_mcpw10_reauthorized_call";
const MCPW10_REVOKED_CALL_FIXTURE = "mcpw10-revoked-call";
const MCPW10_REVOKED_FINAL_FIXTURE = "mcpw10-revoked-final";
// core 把调用期授权的结果改写成这段固定文本；case 断言原文，不只断言片段。
const MCPW10_NEEDS_AUTH_TEXT = `MCP tool is unavailable in the current session: ${MCPW10_TOOL}. Its MCP server '${MCPW10_SERVER}' needs the user to re-authorize it before its tools work again. Ask the user to authorize it in the ZCode MCP settings. Continue without this tool and tell the user if the task depends on it.`;
// 修复前要等满 server 的 30s 超时；授权链接一发布就应结束，留一半余量。
const MCPW10_MAX_AUTH_CALL_MS = 15_000;
// 撤销公告的两段正文；工具保留在目录里时请求中不能出现。
const TOOL_RETRACTION_MARKERS = [
  "no longer available in this session",
  "Disregard those definitions",
];
const DEFERRED_TOOL_CALL_NAME = "DeferredToolCall";
// MCPW11：ToolSearch 关闭（桌面默认）时，连接中的 server 由 WaitForMcpServers 提示。
// 用独立 server 名，不受前面用例已连上的 slow 影响。
const MCPW11_CASE = "MCPW11";
const MCPW11_MARKER = "E2E_MCPW11_WAIT";
const MCPW11_SERVER = "slow11";
const MCPW11_TOOL = `mcp__${MCPW11_SERVER}__ping`;
const MCPW11_WAIT_CALL_ID = "toolu_mcpw11_wait";
const MCPW11_PING_CALL_ID = "toolu_mcpw11_ping";
const MCPW11_REPLY = "mcpw11-ok";
const MCPW11_ROOT = join(CASE_ROOT, "mcpw11");
const MCPW11_LOG = join(MCPW11_ROOT, "events.ndjson");
const MCPW11_RELEASE = join(MCPW11_ROOT, "release");
const WAIT_TOOL_NAME = "WaitForMcpServers";
// 定义是固定字节（docs/mcp-async-tool-catalog-cache.md「ToolSearch 关闭时」），逐字比较。
const WAIT_TOOL_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    servers: {
      description: "Server names to wait for (default: all pending)",
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
};
const WAIT_TOOL_DESCRIPTION_HEAD =
  "Wait for MCP servers that are still connecting and whose tools are not\nyet in your tool list.";
const MCPW11_READY_RESULT = `ready: true\nConnected (their tools are now available — call them directly): ${MCPW11_SERVER}`;

interface SlowMcpEvent {
  event: "started" | "released" | "ping";
  marker?: string;
  pid: number;
  cwd?: string;
  ts: string;
}

/*
 * 本地运行：
 *   ZCODE_E2E_HOME_DIR=<仓库外新建的空目录>/.e2e-home-mcpw ZCODE_E2E_MANUAL_REVIEW=1 \
 *     pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/plugins/manual-review/pending/conversation-session-mcp-async-startup-wait.test.ts'
 * E2E home 要放在仓库外，并且每次用新的空目录（beforeSession 会清空它）。默认 home 在仓库内，E2E 工作区会被当成
 * 本仓库的一部分：Host 的 Git 自动刷新同步监听主仓库的 .git，曾一次卡住 73 s，MCPW08 一步超时；模型请求还会带上
 * 开发者的 Git 状态和仓库根目录的 AGENTS.md。见 docs/issues/desktop-e2e-isolation/01-e2e-home-inside-repository.md
 * 与 docs/issues/host-file-watcher-legacy/01-sync-fs-watch-blocks-host-rpc.md。
 * MCPW06 与 Native 依赖 MCPW01 留下的会话，单独运行它们时用 ZCODE_E2E_MOCHA_GREP='MCPW0[16]'。
 */
describe("会话区 MCP 异步启动与实时搜索 E2E", () => {
  let webBrowser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const evidence: Record<string, unknown> = {};
  const remotes: Awaited<ReturnType<typeof createRemoteMcpFixture>>[] = [];
  let oauthServer: McpOAuthStatusIsolationServer | undefined;

  /**
   * 手机端配对并打开指定任务。首次调用时配对；之后复用同一手机页，避免重复配对。
   * 只换外部账号/relay；Main、Host、手机 renderer 和应用 RPC 仍走真实链路。
   */
  const openMobileTaskPage = async (
    taskId: string,
    caseMarker: string,
    phase: string,
  ): Promise<Page> => {
    if (!page) {
      const pairingUrl = await obtainUnreadPairingUrl();
      webBrowser = await chromium.launch({
        ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME
          ? {
              executablePath:
                process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME,
            }
          : { channel: "chrome" }),
        headless: true,
      });
      context = await webBrowser.newContext({
        viewport: MOBILE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await context.addInitScript((credentials) => {
        if (sessionStorage.getItem("mcpw01-seeded")) return;
        sessionStorage.setItem("mcpw01-seeded", "1");
        for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
      }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
      page = await context.newPage();
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR ?? CASE_ROOT,
        caseMarker,
        phase,
        readySelector: MOBILE_READY_SELECTOR,
      });
    }
    await openMobileTask(page, taskId);
    return page;
  };

  after(async () => {
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page
        ?.screenshot({ path: join(artifacts, `${CASE}-mobile.png`) })
        .catch(() => undefined);
      evidence.slowMcpEvents = await readSlowMcpEvents().catch(() => []);
      await writeFile(join(artifacts, `${CASE}-evidence.json`), JSON.stringify(evidence, null, 2));
    }
    await context?.close();
    await webBrowser?.close();
    // 释放门控，避免残留 server 进程一直卡在启动。
    await writeFile(RELEASE_FILE, "", "utf8").catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
    for (const remote of remotes) await remote.close();
    await oauthServer?.close();
  });

  it("MCPW01: 慢 server 未就绪时首个请求已发出，模型等待后调用就绪工具，桌面与手机都可见", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"));
    const searchSelect = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    await searchSelect.scrollIntoView();
    await searchSelect.click();
    await clickTestIdByDom(testId(TID_SETTINGS_TOOL_SEARCH_OPTION, "local"));
    await browser.waitUntil(async () => (await readSettings()).toolSearchMode === "local", {
      timeout: 15_000,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await writeSlowMcpFixture();
    await startNewV4Draft();
    // 权限模式属于当前草稿；新建草稿后再设，真实 MCP 调用才不会停在审批。
    await ensureToolCrossProductFullAccessMode();

    const prompt = `${PROMPT_MARKER}: [@Example](plugin://example@test) Use ToolSearch to find the ping tool on ${SLOW_MCP_NAME}, then call the loaded ping tool exactly once with marker "${PROMPT_MARKER}", then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "MCP 异步启动 case 首发后输入框没有清空");
    await waitForV4UserMessageContaining(PROMPT_MARKER);

    // 首个请求只等内存快照：slow 仍卡在启动门控时，请求已带状态提醒和ToolSearch发出。
    const firstRequest = {
      excludes: PROVIDER_SIDECAR_EXCLUDES,
      includes: [PROMPT_MARKER, "plugin://example@test", MCP_STATUS_HEADER, SLOW_MCP_NAME],
    };
    await waitForUpstreamRequest(
      firstRequest,
      "slow 未就绪时首个 provider 请求没有发出，或缺少状态提醒",
      60_000,
    );
    // 提醒正文也含搜索工具名；必须核对 tools 定义本身，而不是搜请求全文。
    const waitContract = await getUpstreamRequestToolContract(firstRequest, LOCAL_SEARCH_TOOL_NAME);
    expect(JSON.stringify(waitContract)).toMatch(/"required":\[[^\]]*"query"/);
    expect(await getUpstreamRequestToolContract(firstRequest, SLOW_MCP_TOOL_NAME)).toBeNull();
    expect(await getUpstreamRequestToolContract(firstRequest, "WaitForMcpServers")).toBeNull();
    const firstRequestObservedAt = new Date().toISOString();
    // 修复原因：首个请求不等 MCP（产品行为），slow 进程要先加载 MCP SDK 与 zod 才写 started。高负载下进程
    // 启动晚于首个请求（2026-11-05 实测晚 163 ms、683 ms，8 次失败 3 次），看到请求就读事件会漏掉 started。
    // 这里有界等待 started，再断言放行文件写入前 slow 仍停在门控。
    await browser.waitUntil(
      async () => (await readSlowMcpEvents()).some((entry) => entry.event === "started"),
      { timeout: SLOW_MCP_START_WAIT_MS, timeoutMsg: "slow server 进程没有启动" },
    );
    const beforeRelease = await readSlowMcpEvents();
    expect(beforeRelease.some((entry) => entry.event === "released")).toBe(false);

    await waitForToolCallBlockByToolName(SEARCH_TOOL_NAME, 60_000);
    // 等待上限是 5s；看到搜索工具卡后立即放行，必须落在上限内。
    await writeFile(RELEASE_FILE, "", "utf8");
    const releaseWrittenAt = new Date().toISOString();

    const readyRequest = {
      excludes: PROVIDER_SIDECAR_EXCLUDES,
      includes: [PROMPT_MARKER, "<function>", SLOW_MCP_TOOL_NAME],
    };
    await waitForUpstreamRequest(
      readyRequest,
      "搜索返回工具定义后，续写请求没有带上等待结果",
      60_000,
    );
    // Local 的新定义通过搜索结果展开；调用仍使用 DeferredToolCall 协议。
    expect(await getUpstreamRequestToolContract(readyRequest, "DeferredToolCall")).not.toBeNull();
    await waitForToolCallBlockByToolName(SLOW_MCP_TOOL_NAME, 60_000);
    const events = await waitForSlowMcpPing(60_000);
    await waitForUpstreamRequest(
      { excludes: PROVIDER_SIDECAR_EXCLUDES, includes: [PROMPT_MARKER, PING_RESULT] },
      "slow ping 的 tool_result 没有进入 provider continuation",
      60_000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MCP 异步启动 case 完成后会话没有回到 idle",
      60_000,
    );
    const released = events.find((entry) => entry.event === "released");
    const ping = events.find((entry) => entry.event === "ping");
    // 三个时间点：首请求被观察到 ≤ server 放行 ≤ 工具调用。
    expect(Date.parse(firstRequestObservedAt)).toBeLessThanOrEqual(Date.parse(released!.ts));
    expect(Date.parse(released!.ts)).toBeLessThanOrEqual(Date.parse(ping!.ts));
    evidence.timeline = {
      firstRequestObservedAt,
      releaseWrittenAt,
      serverReleasedAt: released!.ts,
      pingAt: ping!.ts,
    };

    const { taskId } = await getV4ConversationState();
    if (!taskId) throw new Error("MCP 异步启动 case 没有生成 taskId");
    evidence.taskId = taskId;

    // 已存活的 session 必须消费磁盘热更新；不通过新建会话来获得新目录。
    const hotLog = join(CASE_ROOT, "hot-mcp-events.ndjson");
    await rm(hotLog, { force: true });
    const pluginRoot = join(CASE_ROOT, "data-plugin");
    const pluginLog = join(CASE_ROOT, "plugin-events.ndjson");
    await rm(pluginLog, { force: true });
    await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "mcp-data-fixture",
        mcpServers: {
          data: {
            command: process.execPath,
            args: [SLOW_MCP_SERVER_SCRIPT],
            cwd: "${ZCODE_PLUGIN_DATA}",
            env: { E2E_MCP_ASYNC_WAIT_LOG: pluginLog, E2E_MCP_RELEASE_FILE: RELEASE_FILE },
          },
        },
      }),
    );
    const hotConfig = await readJsonRecord(CLI_CONFIG_FILE);
    hotConfig.plugins = {
      ...asRecord(hotConfig.plugins),
      enabled: true,
      dirs: [pluginRoot],
    };
    const hotMcp = asRecord(hotConfig.mcp);
    hotMcp.servers = {
      ...asRecord(hotMcp.servers),
      hot: {
        type: "stdio",
        command: process.execPath,
        args: [SLOW_MCP_SERVER_SCRIPT],
        env: { E2E_MCP_ASYNC_WAIT_LOG: hotLog, E2E_MCP_RELEASE_FILE: RELEASE_FILE },
      },
    };
    await writeFile(CLI_CONFIG_FILE, JSON.stringify({ ...hotConfig, mcp: hotMcp }));
    await browser.waitUntil(
      async () => (await readSlowMcpEvents(hotLog)).some((entry) => entry.event === "released"),
      {
        timeout: 60_000,
        timeoutMsg: "当前 session 没有发现并启动新增的 MCP",
      },
    );
    await browser.waitUntil(
      async () => (await readSlowMcpEvents(pluginLog)).some((event) => event.event === "released"),
      {
        timeout: 60_000,
        timeoutMsg: "热启用插件没有从已准备的 data cwd 启动",
      },
    );
    const pluginEvents = await readSlowMcpEvents(pluginLog);
    expect(pluginEvents.find((event) => event.event === "started")?.cwd).toContain(
      "mcp-data-fixture",
    );
    expect(pluginEvents.find((event) => event.event === "started")?.cwd).toContain("data");
    evidence.pluginPreparation = pluginEvents;
    await sendV4Prompt(
      `${HOT_MARKER}: Use ToolSearch to find ping on hot, call it with marker "${HOT_MARKER}", then reply "hot-config-ok".`,
    );
    await waitForToolCallBlockByToolName(HOT_TOOL, 60_000);
    await waitForV4AssistantMessageContaining("hot-config-ok");
    expect((await getV4ConversationState()).taskId).toBe(taskId);
    const hotEvents = await readSlowMcpEvents(hotLog);
    expect(hotEvents.some((entry) => entry.event === "ping" && entry.marker === HOT_MARKER)).toBe(
      true,
    );
    evidence.hotConfig = { taskId, events: hotEvents };

    // HTTP 只重开 GET 流；SSE 断连才门控下一次 initialize。
    remotes.push(await createRemoteMcpFixture("http"), await createRemoteMcpFixture("sse"));
    const remoteConfig = await readJsonRecord(CLI_CONFIG_FILE);
    const remoteMcp = asRecord(remoteConfig.mcp);
    remoteMcp.servers = {
      ...asRecord(remoteMcp.servers),
      ...Object.fromEntries(remotes.map((remote) => [remote.name, remote.config])),
    };
    await writeFile(CLI_CONFIG_FILE, JSON.stringify({ ...remoteConfig, mcp: remoteMcp }));
    await browser.waitUntil(() => remotes.every((remote) => remote.ready()), {
      timeout: 60_000,
      timeoutMsg: "热新增远程 MCP 没有完成首次 discovery",
    });
    await sendV4Prompt(
      `${REMOTE_READY_MARKER}: Search for both remotehttp and remotesse ping tools, then reply remote-ready.`,
    );
    await waitForV4AssistantMessageContaining("remote-ready");
    for (const remote of remotes) remote.disconnect();
    await browser.waitUntil(
      () => remotes.every((remote) => remote.recoveredStreamOrReconnecting()),
      {
        timeout: 30_000,
        timeoutMsg: "远程断流没有触发后台恢复",
      },
    );
    await sendV4Prompt(
      `${REMOTE_RECOVERY_MARKER}: Search for both remotehttp and remotesse ping tools and call both, then reply remote-recovery-ok.`,
    );
    await waitForUpstreamRequest(
      {
        includes: [REMOTE_RECOVERY_MARKER, MCP_STATUS_HEADER],
        excludes: PROVIDER_SIDECAR_EXCLUDES,
      },
      "恢复状态没有进入 provider 请求",
      60_000,
    );
    // SSE initialize 尚未放行就出现执行卡；HTTP 仍可用，不应被重建连接打断。
    for (const name of REMOTE_TOOLS) await waitForToolCallBlockByToolName(name, 60_000);
    expect(remotes.find((remote) => remote.name === "remotesse")!.calls()).toBe(0);
    const executionWaitingAt = new Date().toISOString();
    for (const remote of remotes) remote.release();
    await waitForV4AssistantMessageContaining("remote-recovery-ok");
    for (const remote of remotes) expect(remote.calls()).toBe(1);
    const recoveredSse = remotes.find((remote) => remote.name === "remotesse")!;
    const refreshComplete = recoveredSse.refreshWithTransientFailure();
    await browser.waitUntil(refreshComplete, {
      timeout: 30_000,
      timeoutMsg: "恢复后的 SSE 没有重试失败的目录刷新",
    });
    expect(remotes.find((remote) => remote.name === "remotehttp")!.initializations()).toBe(1);
    expect((await getV4ConversationState()).taskId).toBe(taskId);
    evidence.remoteRecovery = {
      executionWaitingAt,
      servers: remotes.map((remote) => ({ name: remote.name, events: remote.events })),
    };

    // 手机端：配对后打开同一任务，搜索工具和就绪工具的事件都能看到。
    const mobilePage = await openMobileTaskPage(taskId, CASE, "mobile-tool-events");
    await expandMobileHistory(mobilePage);
    for (const toolName of [SEARCH_TOOL_NAME, SLOW_MCP_TOOL_NAME, HOT_TOOL, ...REMOTE_TOOLS]) {
      await mobilePage
        .locator(`[data-tool-name=${JSON.stringify(toolName)}]`)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
    }
    // 截图在断言后立即拍，作为两个工具块已可见的证据。
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? CASE_ROOT;
    await mkdir(artifacts, { recursive: true });
    await mobilePage.screenshot({ path: join(artifacts, `${CASE}-mobile-tools-visible.png`) });
    evidence.mobile = {
      taskId,
      toolBlocks: [SEARCH_TOOL_NAME, SLOW_MCP_TOOL_NAME, HOT_TOOL, ...REMOTE_TOOLS],
    };
  });

  it("MCPW06: 已有对话消费 UI 插件安装、禁用、启用与卸载", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    const taskId = (await getV4ConversationState()).taskId!;
    const workspacePath = await browser.execute(readActiveWorkspaceInBrowser);
    const initialStarts = (await readSlowMcpEvents()).filter(
      (event) => event.event === "started",
    ).length;
    const fixture = await createPluginLifecycleFixture();
    for (const stage of ["INSTALLED", "DISABLED", "ENABLED", "UNINSTALLED"] as const) {
      await clickTestIdByDom("plugin-store-sidebar-open");
      await waitForPluginControl("plugin-store-root");
      if (stage === "INSTALLED") await addLifecycleMarketplaceThroughUi(fixture);
      await clickTestIdByDom("plugin-store-segment-personal");
      await openPluginCard(PLUGIN_LIFECYCLE_ID);
      if (stage === "INSTALLED") await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
      else if (stage === "UNINSTALLED") await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, true);
      else
        await setPluginEnabledThroughUi(
          PLUGIN_LIFECYCLE_ID,
          stage === "ENABLED",
          "detail",
          workspacePath,
        );
      // 修复原因：插件列表已反映变化只说明配置已写入；会话经 300 ms 尾部去抖后才采纳，
      // 立即发送会与去抖竞速，禁用或卸载后 ToolSearch 仍可能看到旧工具。
      await browser.pause(MCP_CONFIG_SETTLE_MS);
      await selectTaskById(taskId);
      const marker = `E2E_MCP_PLUGIN_${stage}`;
      await sendV4Prompt(
        `${marker}: Search for ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME}. Call it only if found, then reply plugin-${stage.toLowerCase()}-ok.`,
      );
      await waitForV4AssistantMessageContaining(`plugin-${stage.toLowerCase()}-ok`);
      const requests = await getUpstreamRequestEvidence({
        includes: [marker],
        excludes: PROVIDER_SIDECAR_EXCLUDES,
      });
      const blocks = toolSearchBlocks(requests.at(-1)!.requestJson as ToolSearchRequest);
      const search = blocks.find(
        (block) => block.tool_use_id === `toolu_plugin_${stage.toLowerCase()}_search`,
      );
      expect(search).toBeDefined();
      if (stage === "INSTALLED" || stage === "ENABLED") {
        const call = blocks.find(
          (block) => block.tool_use_id === `toolu_plugin_${stage.toLowerCase()}_call`,
        );
        expect(call).toBeDefined();
        expect(call?.is_error).not.toBe(true);
        expect(JSON.stringify(call?.content)).toContain(`${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`);
      } else {
        expect(JSON.stringify(search?.content)).toContain("No matching deferred tools found");
        expect(
          blocks.some((block) => block.tool_use_id === `toolu_plugin_${stage.toLowerCase()}_call`),
        ).toBe(false);
      }
      expect((await getV4ConversationState()).taskId).toBe(taskId);
    }
    expect((await readSlowMcpEvents()).filter((event) => event.event === "started")).toHaveLength(
      initialStarts,
    );
    evidence.pluginLifecycle = {
      taskId,
      requests: await getUpstreamRequestEvidence({
        includes: ["E2E_MCP_PLUGIN_INSTALLED"],
        excludes: PROVIDER_SIDECAR_EXCLUDES,
      }),
    };
  });

  it("MCPW09: 同一 workspace 的两个会话共用配置监听，删除其中一个后另一个仍能热更新", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await chooseToolSearchMode("local");
    await rm(MCPW09_ROOT, { recursive: true, force: true });
    await mkdir(MCPW09_ROOT, { recursive: true });
    const release = join(MCPW09_ROOT, "release");
    await writeFile(release, "", "utf8");
    const sharedLog = join(MCPW09_ROOT, "shared-events.ndjson");
    const lateLog = join(MCPW09_ROOT, "late-events.ndjson");
    const fixtureServer = (log: string) => ({
      type: "stdio",
      command: process.execPath,
      args: [SLOW_MCP_SERVER_SCRIPT],
      env: { E2E_MCP_ASYNC_WAIT_LOG: log, E2E_MCP_RELEASE_FILE: release },
    });
    const writeServers = async (servers: Record<string, unknown>) => {
      const config = await readJsonRecord(CLI_CONFIG_FILE);
      config.mcp = { ...asRecord(config.mcp), servers };
      await writeFile(CLI_CONFIG_FILE, JSON.stringify(config));
    };
    // 前面 case 留下的 server 与本 case 无关；先清空，两个会话从同一份配置起步。
    await writeServers({});

    // 两个会话都先建立并保持存活，热更新只能经由各自已订阅的配置源到达。
    const waitForIdle = (message: string) =>
      waitForV4ConversationState(
        (state) => state.state === "idle" && state.queueCount === 0,
        message,
        60_000,
      );
    const sendAndConfirm = async (marker: string, prompt: string) => {
      await sendV4Prompt(prompt);
      await waitForV4ComposerText("", `MCPW09 ${marker} 发送后输入框没有清空`);
      await waitForV4UserMessageContaining(marker);
    };
    // 两个会话必须属于同一 workspace。全局新建按当前上下文决定目录：单独跑本 case 时，
    // 它给 A、B 各建一个独立聊天目录，两个会话不共用配置源，case 前提不成立。
    // 所以 A、B 都从项目行新建，并在发送前断言目录。
    // 修复原因：会话的 ToolSearch 模式在创建时读取一次。A 曾复用准备阶段留下的空草稿，它在切到 local
    // 之前就已建好，A 全程没有搜索工具（2026-11-04 连续 3 次失败）；两个会话都在切换模式之后新建。
    const startTask = async (marker: string, reply: string) => {
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await browser.pause(MCPW09_DRAFT_PREWARM_SETTLE_MS);
      expect(await browser.execute(readActiveWorkspaceInBrowser)).toBe(DEFAULT_WORKSPACE);
      await ensureToolCrossProductFullAccessMode();
      await sendAndConfirm(marker, `${marker}: reply "${reply}".`);
      await waitForV4AssistantMessageContaining(reply);
      await waitForIdle(`MCPW09 ${marker} 完成后会话没有回到 idle`);
      const { taskId } = await getV4ConversationState();
      if (!taskId) throw new Error(`MCPW09 ${marker} 没有生成 taskId`);
      return taskId;
    };
    const taskA = await startTask(MCPW09_SEED_A, "mcpw09-seed-a");
    const taskB = await startTask(MCPW09_SEED_B, "mcpw09-seed-b");
    expect(taskB).not.toBe(taskA);
    // 修复原因：会话的 MCP 启动连接未结束时，配置变更要排队等它结束，期间新 server 对模型不可见
    // （docs/issues/mcp-hot-reload/01-config-change-waits-for-startup-batch.md）。高负载下官方插件连接慢，
    // 会话的下一轮搜不到新 server（2026-11-05 整组 3 次失败）。本 case 测共享配置监听，不测启动途中改配置，
    // 所以等两个会话的启动连接都结束后再改配置。
    await browser.waitUntil(
      async () => {
        const completed = await readMcpStartupCompletedSessions();
        return completed.has(taskA) && completed.has(taskB);
      },
      { timeout: MCPW09_STARTUP_WAIT_MS, timeoutMsg: "MCPW09 两个会话的 MCP 启动连接没有结束" },
    );

    const callPing = async (marker: string, server: string, reply: string) => {
      await sendAndConfirm(
        marker,
        `${marker}: Use ToolSearch to find ping on ${server}, call it with marker "${marker}", then reply "${reply}".`,
      );
      await waitForToolCallBlockByToolName(`mcp__${server}__ping`, 60_000);
      await waitForV4AssistantMessageContaining(reply);
      await waitForIdle(`MCPW09 ${marker} 完成后会话没有回到 idle`);
    };
    const waitForPing = async (log: string, marker: string) =>
      browser.waitUntil(
        async () =>
          (await readSlowMcpEvents(log)).some(
            (entry) => entry.event === "ping" && entry.marker === marker,
          ),
        { timeout: 30_000, timeoutMsg: `MCPW09 ${marker} 没有真实调用到 MCP server` },
      );

    // 一次写入，两个会话的下一轮都能搜到并真实调用新工具。
    await writeServers({ [MCPW09_SHARED_SERVER]: fixtureServer(sharedLog) });
    await browser.waitUntil(
      async () => (await readSlowMcpEvents(sharedLog)).some((entry) => entry.event === "released"),
      { timeout: 60_000, timeoutMsg: "MCPW09 两个会话都没有启动新增的 MCP" },
    );
    await callPing(MCPW09_SHARED_B, MCPW09_SHARED_SERVER, "mcpw09-shared-b-ok");
    await waitForPing(sharedLog, MCPW09_SHARED_B);
    await selectTaskById(taskA);
    await waitForV4ConversationState(
      (state) => state.taskId === taskA && state.state === "idle",
      "MCPW09 没有切回会话 A",
      30_000,
    );
    await callPing(MCPW09_SHARED_A, MCPW09_SHARED_SERVER, "mcpw09-shared-a-ok");
    await waitForPing(sharedLog, MCPW09_SHARED_A);

    // 删除会话 A 会关闭它的运行实例并释放配置 view；共享监听必须仍在为 B 工作。
    await archiveAndDeleteTask(taskA);
    await writeServers({
      [MCPW09_SHARED_SERVER]: fixtureServer(sharedLog),
      [MCPW09_LATE_SERVER]: fixtureServer(lateLog),
    });
    await browser.waitUntil(
      async () => (await readSlowMcpEvents(lateLog)).some((entry) => entry.event === "released"),
      { timeout: 60_000, timeoutMsg: "MCPW09 删除会话 A 后，会话 B 没有发现新增的 MCP" },
    );
    await selectTaskById(taskB);
    await waitForV4ConversationState(
      (state) => state.taskId === taskB && state.state === "idle",
      "MCPW09 没有切回会话 B",
      30_000,
    );
    await callPing(MCPW09_LATE_B, MCPW09_LATE_SERVER, "mcpw09-late-b-ok");
    await waitForPing(lateLog, MCPW09_LATE_B);
    evidence.mcpw09 = {
      taskA,
      taskB,
      shared: await readSlowMcpEvents(sharedLog),
      late: await readSlowMcpEvents(lateLog),
    };
  });

  it("MCPW10: 调用期 OAuth 失效后立即提示重新授权，设置页授权后同一任务恢复，桌面与手机都可见", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await chooseToolSearchMode("local");
    oauthServer = await startMcpOAuthStatusIsolationServer();
    const server = oauthServer;
    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);
    try {
      // 前面 case 留下的 server 与本 case 无关；只保留需要授权码 OAuth 的 HTTP server。
      const config = await readJsonRecord(CLI_CONFIG_FILE);
      config.mcp = {
        ...asRecord(config.mcp),
        servers: {
          [MCPW10_SERVER]: {
            oauth: {
              clientName: MCPW10_OAUTH_CLIENT_NAME,
              scope: MCPW10_OAUTH_SCOPE,
              type: "authorization_code",
            },
            timeoutMs: MCPW10_SERVER_TIMEOUT_MS,
            type: "http",
            url: server.mcpUrl,
          },
        },
      };
      await writeFile(CLI_CONFIG_FILE, JSON.stringify(config));

      // 第一次授权在设置页完成；会话随后用已存凭据连上。
      const firstAuthorizationUrl = await authorizeMcpFromSettings(
        server,
        openExternalMock,
        MCPW10_SERVER,
      );
      expect(server.snapshot().tokenGeneration).toBe(0);

      const waitForIdle = (message: string) =>
        waitForV4ConversationState(
          (state) => state.state === "idle" && state.queueCount === 0,
          message,
          60_000,
        );
      const runRound = async (marker: string, prompt: string, callId: string, reply: string) => {
        await sendV4Prompt(prompt);
        await waitForV4ComposerText("", `MCPW10 ${marker} 发送后输入框没有清空`);
        await waitForV4UserMessageContaining(marker);
        await waitForToolCallBlockByToolCallId(callId, 60_000);
        await waitForV4AssistantMessageContaining(reply);
        await waitForIdle(`MCPW10 ${marker} 完成后会话没有回到 idle`);
        // 回合结束后再读一次，拿到工具块的最终状态。
        return waitForToolCallBlockByToolCallId(callId, 30_000);
      };

      // 第一轮：已有凭据，真实执行一次。
      await ensureToolCrossProductFullAccessMode();
      const firstBlock = await runRound(
        MCPW10_FIRST,
        `${MCPW10_FIRST}: Use ToolSearch to load ${MCPW10_TOOL}, call it once with marker "${MCPW10_FIRST}", then reply "mcpw10-first-ok".`,
        MCPW10_FIRST_CALL_ID,
        "mcpw10-first-ok",
      );
      expect(firstBlock.status).toBe("completed");
      const { taskId } = await getV4ConversationState();
      if (!taskId) throw new Error("MCPW10 首轮没有生成 taskId");
      expect(
        server.snapshot().oauthToolCalls.filter((call) => call.marker === MCPW10_FIRST),
      ).toHaveLength(1);

      // 第二轮：吊销 token，静默 refresh 也失败；调用必须在授权链接发布后立即结束。
      server.revokeTokens();
      const revokedBlock = await runRound(
        MCPW10_REVOKED,
        `${MCPW10_REVOKED}: Call ${MCPW10_TOOL} again with marker "${MCPW10_REVOKED}", then reply "mcpw10-revoked-ok".`,
        MCPW10_REVOKED_CALL_ID,
        "mcpw10-revoked-ok",
      );
      const revokedRequests = await getUpstreamRequestEvidence({
        includes: [MCPW10_REVOKED],
        excludes: PROVIDER_SIDECAR_EXCLUDES,
      });
      const callRequest = revokedRequests.find(
        (request) => request.fixtureId === MCPW10_REVOKED_CALL_FIXTURE,
      );
      const resultRequest = revokedRequests.find(
        (request) => request.fixtureId === MCPW10_REVOKED_FINAL_FIXTURE,
      );
      if (!callRequest || !resultRequest) {
        throw new Error(
          `MCPW10 第二轮缺少 provider 请求: ${JSON.stringify(revokedRequests.map((request) => request.fixtureId))}`,
        );
      }
      const resultJson = resultRequest.requestJson as ToolSearchRequest;
      const needsAuthResult = toolSearchBlocks(resultJson).find(
        (block) => block.tool_use_id === MCPW10_REVOKED_CALL_ID,
      );
      expect(JSON.stringify(needsAuthResult?.content)).toContain(MCPW10_NEEDS_AUTH_TEXT);
      // 从拿到调用指令的请求开始，到带工具结果的续写请求为止，覆盖整次工具调用。
      const authCallMs = Date.parse(resultRequest.startedAt) - Date.parse(callRequest.startedAt);
      expect(authCallMs).toBeLessThan(MCPW10_MAX_AUTH_CALL_MS);
      // 工具没有被撤销：续写请求没有撤销公告，调用入口仍在。
      const resultBody = JSON.stringify(resultJson);
      for (const marker of TOOL_RETRACTION_MARKERS) expect(resultBody).not.toContain(marker);
      expect(resultJson.tools?.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME)).toBe(true);
      const revokedSnapshot = server.snapshot();
      expect(revokedSnapshot.unauthorizedToolCallAt.length).toBeGreaterThan(0);
      expect(revokedSnapshot.rejectedRefreshCount).toBeGreaterThan(0);
      expect(revokedSnapshot.oauthToolCalls.some((call) => call.marker === MCPW10_REVOKED)).toBe(
        false,
      );

      // 设置页显示同一授权链接；完成后会话用新一代 token 重连。
      const reauthorizationUrl = await authorizeMcpFromSettings(
        server,
        openExternalMock,
        MCPW10_SERVER,
      );
      await browser.waitUntil(
        () =>
          server.snapshot().authorizedInitializes.some((record) => record.tokenGeneration === 1),
        { timeout: 60_000, timeoutMsg: "MCPW10 重新授权后没有用新 token 重连" },
      );
      expect((await getV4ConversationState()).taskId).toBe(taskId);

      // 第三轮：同一任务再次调用成功，用的是新 token。
      const reauthorizedBlock = await runRound(
        MCPW10_REAUTHORIZED,
        `${MCPW10_REAUTHORIZED}: Call ${MCPW10_TOOL} again with marker "${MCPW10_REAUTHORIZED}", then reply "mcpw10-reauthorized-ok".`,
        MCPW10_REAUTHORIZED_CALL_ID,
        "mcpw10-reauthorized-ok",
      );
      expect(reauthorizedBlock.status).toBe("completed");
      const finalSnapshot = server.snapshot();
      expect(
        finalSnapshot.oauthToolCalls.filter((call) => call.marker === MCPW10_REAUTHORIZED),
      ).toEqual([expect.objectContaining({ tokenGeneration: 1 })]);
      expect((await getV4ConversationState()).taskId).toBe(taskId);

      // 手机端打开同一任务，三次调用的工具块都可见，包括需要授权的那次。
      const callIds = [MCPW10_FIRST_CALL_ID, MCPW10_REVOKED_CALL_ID, MCPW10_REAUTHORIZED_CALL_ID];
      const mobilePage = await openMobileTaskPage(taskId, MCPW10_CASE, "mcpw10-tool-events");
      await expandMobileHistory(mobilePage);
      const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? CASE_ROOT;
      await mkdir(artifacts, { recursive: true });
      const mobileScreenshots: string[] = [];
      for (const callId of callIds) {
        const block = mobilePage.locator(`[data-tool-call-id=${JSON.stringify(callId)}]`).first();
        await block.waitFor({ state: "visible", timeout: 60_000 });
        // 每次调用滚到视口中间再截整屏：一屏放不下三轮，底部输入栏也会盖住贴底的工具块。
        await block.evaluate((element) => element.scrollIntoView({ block: "center" }));
        const path = join(artifacts, `${MCPW10_CASE}-mobile-${callId}.png`);
        await mobilePage.screenshot({ path });
        mobileScreenshots.push(path);
      }
      evidence.mcpw10 = {
        authCallMs,
        authorizationUrls: [firstAuthorizationUrl, reauthorizationUrl].map(
          (url) => new URL(url).pathname,
        ),
        desktopBlocks: [firstBlock, revokedBlock, reauthorizedBlock],
        mobileScreenshots,
        needsAuthResult: needsAuthResult?.content,
        server: finalSnapshot,
        taskId,
        timeline: {
          callRequestStartedAt: callRequest.startedAt,
          resultRequestStartedAt: resultRequest.startedAt,
          unauthorizedToolCallAt: revokedSnapshot.unauthorizedToolCallAt.map((at) =>
            new Date(at).toISOString(),
          ),
        },
      };
    } finally {
      await openExternalMock.mockRestore();
    }
  });

  it("MCPW11: ToolSearch 关闭时慢 server 由 WaitForMcpServers 提示，等待就绪后直接调用工具，桌面与手机都可见", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await chooseToolSearchMode("off");
    await rm(MCPW11_ROOT, { recursive: true, force: true });
    await mkdir(MCPW11_ROOT, { recursive: true });
    const config = await readJsonRecord(CLI_CONFIG_FILE);
    const mcp = asRecord(config.mcp);
    mcp.servers = {
      ...asRecord(mcp.servers),
      [MCPW11_SERVER]: {
        type: "stdio",
        command: process.execPath,
        args: [SLOW_MCP_SERVER_SCRIPT],
        env: { E2E_MCP_ASYNC_WAIT_LOG: MCPW11_LOG, E2E_MCP_RELEASE_FILE: MCPW11_RELEASE },
        timeoutMs: SLOW_MCP_SERVER_TIMEOUT_MS,
      },
    };
    await mkdir(join(E2E_PATHS.homeDir, ".zcode", "cli"), { recursive: true });
    await writeFile(CLI_CONFIG_FILE, `${JSON.stringify({ ...config, mcp }, null, 2)}\n`, "utf8");
    await browser.waitUntil(
      async () => (await readSlowMcpEvents(MCPW11_LOG)).some((entry) => entry.event === "started"),
      { timeout: 60_000, timeoutMsg: "MCPW11 的慢 server 没有启动" },
    );
    await startNewV4Draft();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      `${MCPW11_MARKER}: Wait for the ${MCPW11_SERVER} MCP server, call its ping tool once with marker "${MCPW11_MARKER}", then reply "${MCPW11_REPLY}".`,
    );
    await waitForV4ComposerText("", "MCPW11 发送后输入框没有清空");

    // 首个请求：没有 ToolSearch 和连接中公告；WaitForMcpServers 以固定定义出现，慢 server 的工具还不在。
    const firstRequest = {
      excludes: [...PROVIDER_SIDECAR_EXCLUDES, MCPW11_WAIT_CALL_ID],
      includes: [MCPW11_MARKER, WAIT_TOOL_NAME],
    };
    await waitForUpstreamRequest(firstRequest, "MCPW11 首个请求没有带 WaitForMcpServers", 60_000);
    const waitTool = (await getUpstreamRequestToolContract(firstRequest, WAIT_TOOL_NAME)) as {
      description?: string;
      input_schema?: unknown;
    } | null;
    expect(waitTool?.input_schema).toEqual(WAIT_TOOL_INPUT_SCHEMA);
    expect(waitTool?.description?.startsWith(WAIT_TOOL_DESCRIPTION_HEAD)).toBe(true);
    expect(await getUpstreamRequestToolContract(firstRequest, SEARCH_TOOL_NAME)).toBeNull();
    expect(await getUpstreamRequestToolContract(firstRequest, MCPW11_TOOL)).toBeNull();
    const [first] = await getUpstreamRequestEvidence(firstRequest);
    expect(JSON.stringify(first?.requestJson)).not.toContain(MCP_STATUS_HEADER);
    expect((await readSlowMcpEvents(MCPW11_LOG)).some((entry) => entry.event === "released")).toBe(
      false,
    );

    await waitForToolCallBlockByToolCallId(MCPW11_WAIT_CALL_ID, 60_000);
    // 等待上限是 5 s；看到等待工具卡后立即放行，必须落在上限内。
    await writeFile(MCPW11_RELEASE, "", "utf8");

    const readyRequest = {
      excludes: [...PROVIDER_SIDECAR_EXCLUDES, MCPW11_PING_CALL_ID],
      includes: [MCPW11_MARKER, MCPW11_WAIT_CALL_ID],
    };
    await waitForUpstreamRequest(readyRequest, "MCPW11 等待结果没有进入续写请求", 60_000);
    const waitResult = await getLatestUpstreamToolResultByToolCallId(MCPW11_WAIT_CALL_ID);
    expect(waitResult).toMatchObject({ content: MCPW11_READY_RESULT, isError: false });
    // 发送过一次后保持（锁存），定义字节不变；连上的 server 的工具直接出现在 tools 段。
    expect(await getUpstreamRequestToolContract(readyRequest, WAIT_TOOL_NAME)).toEqual(waitTool);
    expect(await getUpstreamRequestToolContract(readyRequest, MCPW11_TOOL)).not.toBeNull();

    await waitForToolCallBlockByToolCallId(MCPW11_PING_CALL_ID, 60_000);
    await waitForUpstreamRequest(
      {
        excludes: PROVIDER_SIDECAR_EXCLUDES,
        includes: [MCPW11_PING_CALL_ID, `E2E_MCP_ASYNC_WAIT_PONG:${MCPW11_MARKER}`],
      },
      "MCPW11 ping 的 tool_result 没有进入续写请求",
      60_000,
    );
    await waitForV4AssistantMessageContaining(MCPW11_REPLY);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MCPW11 完成后会话没有回到 idle",
      60_000,
    );
    const events = await readSlowMcpEvents(MCPW11_LOG);
    expect(
      events.filter((entry) => entry.event === "ping" && entry.marker === MCPW11_MARKER),
    ).toHaveLength(1);

    const { taskId } = await getV4ConversationState();
    if (!taskId) throw new Error("MCPW11 没有生成 taskId");
    const mobilePage = await openMobileTaskPage(taskId, MCPW11_CASE, "mobile-wait-tool");
    await expandMobileHistory(mobilePage);
    for (const toolName of [WAIT_TOOL_NAME, MCPW11_TOOL]) {
      await mobilePage
        .locator(`[data-tool-name=${JSON.stringify(toolName)}]`)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
    }
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? CASE_ROOT;
    await mkdir(artifacts, { recursive: true });
    await mobilePage.screenshot({
      path: join(artifacts, `${MCPW11_CASE}-mobile-tools-visible.png`),
    });
    evidence.mcpw11 = { taskId, waitResult, events };
  });

  it("MCPW01–05、07–08 Native: 定义、撤销、冷恢复、调用不重放与探测隔离", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareV4ConversationE2E({ skipProvider: true });
    const native = await createRemoteMcpFixture("http", "native");
    // 设置页探测和对话连接可能分别初始化；首次加载放行，失效场景再关闭恢复门控。
    native.release();
    remotes.push(native);
    const providerId = TOOLSEARCH_PLAN_PROVIDER;
    // 用正式模型配置固定协议与能力；不能用启用中途 system 的模型证明 reminder 角色。
    const modelId = "claude-opus-5-5";
    // 草稿目录不属于冷恢复合同；上一条任务可能恢复到不同 cwd，Native 会另建独立任务。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
        await seedPersonalProviderConfig(E2E_PATHS.configFile, {
          id: providerId,
          label: "Native MCP fixture",
          apiFormat: "anthropic-messages",
          apiKey: "e2e-native.test-secret",
          baseURL: "https://open.bigmodel.cn/api/anthropic",
          models: [{ id: modelId, supportsMidConversationSystem: false }],
        });
      },
    });
    // 侧栏的新建按钮只在 hover 时显现；这里等待挂载，后续复用已有 DOM 交互助手。
    await browser.$(`[data-testid="${TID_VIRTUAL_PROJECT_NEW_TASK}"]`).waitForExist({
      timeout: 60_000,
    });
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"));
    const select = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    await select.scrollIntoView();
    await select.click();
    await clickTestIdByDom(testId(TID_SETTINGS_TOOL_SEARCH_OPTION, "auto"));
    await browser.waitUntil(async () => (await readSettings()).toolSearchMode === "auto", {
      timeout: 15_000,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    const config = await readJsonRecord(CLI_CONFIG_FILE);
    config.plugins = { ...asRecord(config.plugins), enabled: false };
    config.mcp = { ...asRecord(config.mcp), servers: { native: native.config } };
    await writeFile(CLI_CONFIG_FILE, JSON.stringify(config));
    // 顶部新建会继承当前项目，单跑和整组会产生不同 Git 上下文；明确使用未归类任务入口。
    await clickTestIdByDom(TID_VIRTUAL_PROJECT_NEW_TASK);
    await browser.waitUntil(
      async () =>
        (await browser.execute(readActiveWorkspaceInBrowser)).startsWith(
          join(E2E_PATHS.homeDir, ".zcode", "workspace"),
        ),
      { timeout: 15_000, timeoutMsg: "Native 任务尚未进入独立执行目录" },
    );
    await switchV4Model(providerId, modelId, "");
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt("E2E_MCP_NATIVE_LOAD Find and call the native ping tool.");
    await waitForV4AssistantMessageContaining("native-loaded");
    await waitForV4ConversationState((state) => state.state === "idle", "Native 轮未结束", 60_000);
    expect(native.calls()).toBe(1);
    const records = await readNativeRequests("E2E_MCP_NATIVE_LOAD", "native-loaded");
    const loaded = records
      .map((record) => record.requestJson as ToolSearchRequest)
      .find((body) => body.tools?.some((tool) => tool.name === "mcp__native__ping"))!;
    const definition = loaded.tools?.find((tool) => tool.name === "mcp__native__ping");
    expect(definition).toEqual({
      name: "mcp__native__ping",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    });
    expect(
      loaded.tools?.some(
        (tool) => tool.name === "WaitForMcpServers" || tool.name === "DeferredToolCall",
      ),
    ).toBe(false);
    const result = loaded.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === "tool_result" && block.tool_use_id === "toolu_native_search");
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_native_search",
      content: [{ type: "tool_reference", tool_name: "mcp__native__ping" }],
    });
    // 服务端已执行后返回与 SDK 本地错误同文的 JSON-RPC 错误，不能自动重放。
    const beforeProtocolError = {
      calls: native.calls(),
      initializations: native.initializations(),
    };
    native.failCallAfterExecution();
    await sendV4Prompt(
      "E2E_MCP_NATIVE_PROTOCOL_ERROR Call native ping once and report the result.",
    );
    await waitForV4AssistantMessageContaining("native-protocol-error-observed");
    const protocolErrorRequests = (
      await readNativeRequests("E2E_MCP_NATIVE_PROTOCOL_ERROR", "native-protocol-error-observed")
    ).map((record) => record.requestJson as ToolSearchRequest);
    expect(
      toolSearchBlocks(protocolErrorRequests.at(-1)!).find(
        (block) => block.tool_use_id === "toolu_native_protocol_error_call",
      ),
    ).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_native_protocol_error_call",
      is_error: true,
      content: "Not connected",
      cache_control: { type: "ephemeral" },
    });
    expect(native.calls()).toBe(beforeProtocolError.calls + 1);
    expect(native.initializations()).toBe(beforeProtocolError.initializations);

    // Desktop 设置探测有独立 CLI；只使被探测的 session ID 失效，对话连接继续可用。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"));
    const nativeRow = await browser.$(`[data-testid="${testId(TID_MCP_SERVER_ROW, "native")}"]`);
    const refreshButton = await browser.$(
      '[data-mcp-plugin-installed-actions] button[aria-label="刷新"], [data-mcp-plugin-installed-actions] button[aria-label="Refresh"]',
    );
    const beforeProbe = native.probes();
    await refreshButton.click();
    await browser.waitUntil(() => native.probes() > beforeProbe, { timeout: 15_000 });
    await browser.waitUntil(() => refreshButton.isEnabled(), { timeout: 15_000 });
    await browser
      .waitUntil(async () => (await nativeRow.getAttribute("data-mcp-status")) === "connected", {
        timeout: 15_000,
      })
      .catch(async (error) => {
        throw new Error(`MCP 显式刷新未显示 connected: ${await nativeRow.getHTML()}`, {
          cause: error,
        });
      });
    const beforeProbeRecovery = native.initializations();
    native.expireProbedSession();
    await refreshButton.click();
    await browser.waitUntil(() => native.initializations() === beforeProbeRecovery + 1, {
      timeout: 15_000,
    });
    await browser.waitUntil(() => refreshButton.isEnabled(), { timeout: 15_000 });
    expect(await nativeRow.getAttribute("data-mcp-status")).toBe("connecting");
    await refreshButton.click();
    await browser.waitUntil(() => refreshButton.isEnabled(), { timeout: 15_000 });
    expect(native.initializations()).toBe(beforeProbeRecovery + 1);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    const beforeSettingsCall = native.calls();
    await sendV4Prompt(
      "E2E_MCP_NATIVE_SETTINGS Search and call native ping while settings recovery is pending.",
    );
    await waitForV4AssistantMessageContaining("native-settings-isolated");
    const settingsRequests = (
      await readNativeRequests("E2E_MCP_NATIVE_SETTINGS", "native-settings-isolated")
    ).map((record) => record.requestJson as ToolSearchRequest);
    expect(
      toolSearchBlocks(settingsRequests.at(-1)!).find(
        (block) => block.tool_use_id === "toolu_native_settings_search",
      )?.content,
    ).toEqual([{ type: "tool_reference", tool_name: "mcp__native__ping" }]);
    expect(
      toolSearchBlocks(settingsRequests.at(-1)!).find(
        (block) => block.tool_use_id === "toolu_native_settings_call",
      )?.is_error,
    ).not.toBe(true);
    expect(native.calls()).toBe(beforeSettingsCall + 1);
    expect(native.initializations()).toBe(beforeProbeRecovery + 1);
    expect(
      settingsRequests.at(-1)!.tools?.find((tool) => tool.name === "mcp__native__ping"),
    ).toEqual(definition);
    for (const [requests, marker] of [
      [protocolErrorRequests, "E2E_MCP_NATIVE_PROTOCOL_ERROR"],
      [settingsRequests, "E2E_MCP_NATIVE_SETTINGS"],
    ] as const) {
      for (const request of requests) {
        const start = request.messages.findIndex((message) =>
          JSON.stringify(message.content).includes(marker),
        );
        expect(start).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(request.messages.slice(start))).not.toMatch(
          // 撤销正文是 "Disregard those definitions"；修复前这里匹配的是不存在的旧文案，断言恒成立。
          /still connecting|no longer available|Disregard those definitions/,
        );
      }
    }
    native.release();
    // 热加载常驻工具：实际 schema 交付也必须记录，不能只记录 ToolSearch 引用。
    const resident = await createRemoteMcpFixture("http", "resident");
    resident.release();
    remotes.push(resident);
    config.mcp = {
      ...asRecord(config.mcp),
      servers: { native: native.config, resident: { ...resident.config, alwaysLoad: true } },
    };
    await writeFile(CLI_CONFIG_FILE, JSON.stringify(config));
    await browser.waitUntil(() => resident.ready(), {
      timeout: 30_000,
      timeoutMsg: "常驻 MCP 未完成 discovery",
    });
    await sendV4Prompt("E2E_MCP_NATIVE_RESIDENT Continue with the resident tool available.");
    await waitForV4AssistantMessageContaining("native-resident");
    const residentRecords = await readNativeRequests("E2E_MCP_NATIVE_RESIDENT", "native-resident");
    const residentRequest = residentRecords[0]!.requestJson as ToolSearchRequest;
    expect(residentRequest.tools?.find((tool) => tool.name === "mcp__resident__ping")).toEqual({
      name: "mcp__resident__ping",
      input_schema: { type: "object", properties: {} },
    });
    expect(JSON.stringify(residentRequest.messages.at(-1))).not.toContain("still connecting");
    // 设置页探测可能已关闭过连接；只等待本次移除产生的新事件。
    const closedBeforeRemoval = native.events.filter(
      (event) => event.event === "stream-closed",
    ).length;
    config.mcp = { ...asRecord(config.mcp), servers: {} };
    await writeFile(CLI_CONFIG_FILE, JSON.stringify(config));
    await browser.waitUntil(
      () =>
        native.events.filter((event) => event.event === "stream-closed").length >
        closedBeforeRemoval,
      {
        timeout: 30_000,
        timeoutMsg: "配置移除尚未关闭 Native MCP 连接",
      },
    );
    await sendV4Prompt("E2E_MCP_NATIVE_REMOVED Continue after removal.");
    await waitForV4AssistantMessageContaining("native-removed");
    const removedRecords = await readNativeRequests("E2E_MCP_NATIVE_REMOVED", "native-removed");
    const removed = removedRecords[0]!.requestJson as ToolSearchRequest;
    expect(removed.tools?.find((tool) => tool.name === "mcp__native__ping")).toEqual(definition);
    const withdrawal = removed.messages
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map((block) => ({ role: message.role, ...block }))
          : [],
      )
      .find((block) => block.text?.includes("Disregard those definitions"));
    expect(withdrawal?.role).toBe("user");
    // 此用例无额外 Git 上下文，逐字检查最终 wire。撤销正文紧挨用户输入，合并相邻 user 内容时以换行结尾。
    const expected = await readFile(
      resolve("test/e2e/fixtures/fs/conversation-session/mcp-native-retraction.txt"),
      "utf8",
    );
    expect(withdrawal?.text).toBe(`${expected}\n`);
    // 离开的常驻工具原位重新声明，定义与离开前发送的字节相同；撤销正文另行告知不要调用。
    expect(removed.tools?.find((tool) => tool.name === "mcp__resident__ping")).toEqual(
      residentRequest.tools?.find((tool) => tool.name === "mcp__resident__ping"),
    );

    const taskId = (await getV4ConversationState()).taskId!;
    const oldPid = await browser.electron.execute(() => process.pid);
    const callsBeforeRestart = native.calls();
    await reloadElectronSessionPreservingBrowserProfile(browser);
    expect(await browser.electron.execute(() => process.pid)).not.toBe(oldPid);
    await selectTaskById(taskId, { timeout: 60_000 });
    await waitForV4ConversationState(
      (state) => state.taskId === taskId && state.state === "idle",
      "冷恢复未返回原任务",
      60_000,
    );
    await sendV4Prompt("E2E_MCP_NATIVE_COLD Run the built-in Bash check and continue.");
    await waitForV4AssistantMessageContaining("native-cold-ok");
    const cold = (await readNativeRequests("E2E_MCP_NATIVE_COLD", "native-cold-ok")).map(
      (record) => record.requestJson as ToolSearchRequest,
    );
    expect(cold[0]!.tools?.find((tool) => tool.name === "mcp__native__ping")).toEqual(definition);
    expect(JSON.stringify(cold[0]!.messages)).toContain("Disregard those definitions");
    const coldCheck = toolSearchBlocks(cold.at(-1)!).find(
      (block) => block.tool_use_id === "toolu_native_cold_check",
    );
    expect(coldCheck).toBeDefined();
    expect(coldCheck?.is_error).not.toBe(true);
    expect(JSON.stringify(coldCheck?.content)).toContain("E2E_MCP_ALIVE");
    expect(native.calls()).toBe(callsBeforeRestart);

    const beforeRestore = native.events.filter((event) => event.event === "tools/list").length;
    config.mcp = { ...asRecord(config.mcp), servers: { native: native.config } };
    await writeFile(CLI_CONFIG_FILE, JSON.stringify(config));
    await browser.waitUntil(
      () => native.events.filter((event) => event.event === "tools/list").length > beforeRestore,
      { timeout: 60_000 },
    );
    await sendV4Prompt("E2E_MCP_NATIVE_RESTORED Search and call the restored native ping tool.");
    await waitForV4AssistantMessageContaining("native-restored-ok");
    const restored = (
      await readNativeRequests("E2E_MCP_NATIVE_RESTORED", "native-restored-ok")
    ).map((record) => record.requestJson as ToolSearchRequest);
    // 恢复公告紧挨用户输入，合并相邻 user 内容时以换行结尾。
    const restoration =
      "<system-reminder>\n1 deferred tool is available again (MCP server reconnected — names announced earlier in this conversation): mcp__native__*. Load via ToolSearch as before.\n</system-reminder>\n";
    expect(
      restored.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.text === restoration),
        ),
      ),
    ).toBe(true);
    expect(native.calls()).toBe(callsBeforeRestart + 1);
    // 恢复后历史引用仍对应先前交付的定义，不被同名的新定义改写。
    for (const request of restored)
      expect(request.tools?.find((tool) => tool.name === "mcp__native__ping")).toEqual(definition);

    const beforeExpiry = native.initializations();
    const callsBeforeExpiry = native.calls();
    // 修复原因：恢复 discovery 中的 list_changed 触发后台刷新，刷新的 tools/list 和重试的 tools/call
    // 同时在路上，谁先返回决定新增公告随续写请求交付还是随下一轮交付；用例曾只认前一种，
    // 刷新晚到几毫秒就失败。这里让 fixture 把刷新挂起到续写请求发出之后，按因果固定顺序，
    // 再逐字检查这个顺序下唯一正确的结果。
    native.changeDuringDiscovery({ holdRefresh: true });
    native.expire();
    await sendV4Prompt(
      "E2E_MCP_NATIVE_EXPIRED Call native ping; it retries once after reconnecting.",
    );
    // 会话过期的调用等待重连：重连的 initialize 被门控，此时服务端尚未执行任何调用。
    await browser.waitUntil(() => native.initializations() > beforeExpiry, {
      timeout: 60_000,
      timeoutMsg: "会话过期后未发起重连",
    });
    expect(native.calls()).toBe(callsBeforeExpiry);
    native.release();
    await waitForV4AssistantMessageContaining("native-recovered-ok");
    const expiredRequests = (
      await readNativeRequests("E2E_MCP_NATIVE_EXPIRED", "native-recovered-ok")
    ).map((record) => record.requestJson as ToolSearchRequest);
    const retriedCall = expiredRequests
      .flatMap(toolSearchBlocks)
      .find((block) => block.tool_use_id === "toolu_native_expired_call");
    // 原调用在重连后重试一次并成功；服务端只执行一次，只重新 initialize 一次。
    expect(retriedCall?.is_error).not.toBe(true);
    expect(native.initializations()).toBe(beforeExpiry + 1);
    expect(native.calls()).toBe(callsBeforeExpiry + 1);
    // list_changed 在 discovery 期间只标脏，ready 提交后由同一刷新入口再拉一次列表。
    await browser.waitUntil(
      () => native.events.some((event) => event.event === "refresh-list-held"),
      { timeout: 15_000, timeoutMsg: "恢复 discovery 中的 list_changed 没有触发刷新" },
    );
    // 续写请求发出时刷新仍挂在服务端：tool_result 是工具原文，请求里还没有新工具和新增公告。
    expect(native.events.map((event) => event.event)).not.toContain("refresh-list-served");
    expect(retriedCall?.content).toBe("E2E_MCP_REMOTE_RECOVERY:native:pong");
    expect(JSON.stringify(expiredRequests)).not.toContain("mcp__native__fresh");

    // 服务端写完刷新响应后才发下一轮输入；客户端只需处理这一个已收到的响应就能提交新目录。
    native.releaseRefresh();
    await browser.waitUntil(
      () => native.events.some((event) => event.event === "refresh-list-served"),
      { timeout: 15_000, timeoutMsg: "释放后刷新的 tools/list 未返回" },
    );
    const discoveryPrompt = "E2E_MCP_NATIVE_DISCOVERY Search and call native fresh after recovery.";
    await sendV4Prompt(discoveryPrompt);
    await waitForV4AssistantMessageContaining("native-discovery-ok");
    const discoveryRecords = await readNativeRequests(
      "E2E_MCP_NATIVE_DISCOVERY",
      "native-discovery-ok",
    );
    const discovery = discoveryRecords.map((record) => record.requestJson as ToolSearchRequest);
    const addedNotice =
      '<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nmcp__native__fresh\n</system-reminder>';
    // 目录变更进入下一轮：公告和该轮用户输入是相邻的 user 消息，合并后公告块在前。
    // 公告块紧挨用户输入，合并相邻 user 内容时以换行结尾。
    const firstDiscoveryRequest = discoveryRecords.find((record) =>
      record.responseTextPreview?.includes("native-discovery-search"),
    )?.requestJson as ToolSearchRequest | undefined;
    const turnInput = firstDiscoveryRequest?.messages.at(-1);
    expect(turnInput?.role).toBe("user");
    expect(
      Array.isArray(turnInput?.content) &&
        turnInput.content.map(({ type, text }) => ({ type, text })),
    ).toEqual([
      { type: "text", text: `${addedNotice}\n` },
      { type: "text", text: discoveryPrompt },
    ]);
    // 整段对话里新增公告只交付一次。
    expect(
      toolSearchBlocks(discovery.at(-1)!).filter((block) => {
        const text = block.type === "tool_result" ? block.content : block.text;
        return typeof text === "string" && text.includes(addedNotice);
      }),
    ).toHaveLength(1);
    const delivered = discovery.find((body) =>
      body.tools?.some((tool) => tool.name === "mcp__native__fresh"),
    )!;
    expect(delivered.tools?.find((tool) => tool.name === "mcp__native__fresh")).toEqual({
      name: "mcp__native__fresh",
      input_schema: { type: "object", properties: {} },
      defer_loading: true,
    });
    expect(
      toolSearchBlocks(delivered).find(
        (block) => block.tool_use_id === "toolu_native_discovery_search",
      ),
    ).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_native_discovery_search",
      content: [{ type: "tool_reference", tool_name: "mcp__native__fresh" }],
    });
    expect(native.events.filter((event) => event.event === "discovery-list-changed")).toHaveLength(
      1,
    );
    expect(native.events.filter((event) => event.event === "fresh")).toHaveLength(1);
    expect(native.calls()).toBe(callsBeforeExpiry + 2);

    const beforeExhaustion = native.initializations();
    native.expire({ failRecovery: true });
    await sendV4Prompt("E2E_MCP_NATIVE_EXHAUST Call native ping once and report the error.");
    await waitForV4AssistantMessageContaining("native-exhaust-started");
    await browser.waitUntil(
      () => native.events.filter((event) => event.event === "initialize-rejected").length === 5,
      { timeout: 45_000, timeoutMsg: "HTTP 恢复未按五次预算终结" },
    );
    expect(native.initializations()).toBe(beforeExhaustion + 5);
    const exhaustCall = (
      await readNativeRequests("E2E_MCP_NATIVE_EXHAUST", "native-exhaust-started")
    )
      .map((record) => record.requestJson as ToolSearchRequest)
      .flatMap(toolSearchBlocks)
      .find((block) => block.tool_use_id === "toolu_native_exhaust_call");
    // 恢复耗尽：已交付的定义保留，但调用返回错误，服务端没有执行。
    expect(exhaustCall?.is_error).toBe(true);
    const failedReminder = await readFile(
      resolve("test/e2e/fixtures/fs/conversation-session/mcp-native-failed-reminder.txt"),
      "utf8",
    );
    // 原调用等待重连到 5 次恢复都失败才返回；状态在本批工具执行期间变为 failed，
    // 撤销与失败提醒随本批 tool_result 交付，逐字检查。
    expect(exhaustCall?.content).toBe(`Connection closed\n\n${failedReminder.trimEnd()}`);
    await sendV4Prompt(
      "E2E_MCP_NATIVE_FAILED Search native ping, run the built-in Bash check, then finish.",
    );
    await waitForV4AssistantMessageContaining("native-failed-alive");
    const exhausted = (
      await readNativeRequests("E2E_MCP_NATIVE_FAILED", "native-failed-alive")
    ).map((record) => record.requestJson as ToolSearchRequest);
    // 下一轮不重复公告：失败提醒在整个历史中只出现一次。
    expect(
      JSON.stringify(exhausted[0]!.messages).split("configured but failed to connect").length - 1,
    ).toBe(1);
    const noMatch = toolSearchBlocks(exhausted.at(-1)!).find(
      (block) => block.tool_use_id === "toolu_native_failed_search",
    );
    const diagnostic = await readFile(
      resolve("test/e2e/fixtures/fs/conversation-session/mcp-native-failed-search.txt"),
      "utf8",
    );
    expect(noMatch?.content).toBe(diagnostic.trimEnd());
    const alive = toolSearchBlocks(exhausted.at(-1)!).find(
      (block) => block.tool_use_id === "toolu_native_failed_check",
    );
    expect(alive).toBeDefined();
    expect(alive?.is_error).not.toBe(true);
    expect(JSON.stringify(alive?.content)).toContain("E2E_MCP_ALIVE");
    expect(exhausted.at(-1)!.tools?.find((tool) => tool.name === "mcp__native__ping")).toEqual(
      definition,
    );
    expect(native.calls()).toBe(callsBeforeExpiry + 2);
    expect((await getV4ConversationState()).taskId).toBe(taskId);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "MCP 失败后任务未返回 idle",
      60_000,
    );
    evidence.native = {
      requests: await readNativeRequests("E2E_MCP_NATIVE_LOAD"),
      coldRestart: { oldPid, newPid: await browser.electron.execute(() => process.pid), taskId },
      events: [...native.events, ...resident.events],
    };
  });
});

async function chooseToolSearchMode(mode: "auto" | "local" | "off"): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"));
  const select = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
  await select.scrollIntoView();
  await select.click();
  await clickTestIdByDom(testId(TID_SETTINGS_TOOL_SEARCH_OPTION, mode));
  await browser.waitUntil(async () => (await readSettings()).toolSearchMode === mode, {
    timeout: 15_000,
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}

type OpenExternalMock = Awaited<ReturnType<typeof browser.electron.mock>>;

/**
 * 在设置页 MCP 分区完成一次授权：等授权按钮出现，点按钮，用平台打开的链接完成授权，
 * 等该 server 回到已连接，再返回会话。返回本次打开的授权链接。
 */
async function authorizeMcpFromSettings(
  server: McpOAuthStatusIsolationServer,
  openExternalMock: OpenExternalMock,
  serverName: string,
): Promise<string> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15_000, timeoutMsg: "设置页没有渲染" });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"));
  const button = testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, serverName);
  try {
    await waitForTestIdByDom(button, { timeout: 45_000 });
  } catch (error) {
    // 失败时再读一次行状态，区分"没有发起授权"和"行没有渲染"。
    throw new Error(
      `设置页没有显示 ${serverName} 的授权按钮: ${JSON.stringify(await readMcpServerRow(serverName))}`,
      { cause: error },
    );
  }
  await openExternalMock.update();
  const openedBefore = openExternalMock.mock.calls.length;
  await clickTestIdByDom(button);
  let authorizationUrl = "";
  await browser.waitUntil(
    async () => {
      await openExternalMock.update();
      authorizationUrl =
        openExternalMock.mock.calls
          .slice(openedBefore)
          .map((call) => call[0])
          .find(
            (value): value is string => typeof value === "string" && value.includes("/authorize?"),
          ) ?? "";
      return Boolean(authorizationUrl);
    },
    { timeout: 15_000, timeoutMsg: `点击授权按钮后没有打开 ${serverName} 的授权链接` },
  );
  await server.completeAuthorization(authorizationUrl);
  let latest = await readMcpServerRow(serverName);
  await browser.waitUntil(
    async () => {
      latest = await readMcpServerRow(serverName);
      return latest.status === "connected" && latest.toolCount === 1;
    },
    {
      timeout: 45_000,
      timeoutMsg: `授权后设置页没有显示 ${serverName} 已连接: ${JSON.stringify(latest)}`,
    },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  return authorizationUrl;
}

async function readMcpServerRow(serverName: string) {
  return browser.execute(
    (rowTestId) => {
      const row = document.querySelector<HTMLElement>(`[data-testid="${rowTestId}"]`);
      if (!row) return { exists: false, status: null, toolCount: null, text: "" };
      const rawToolCount = row.dataset.mcpToolCount;
      return {
        exists: true,
        status: row.dataset.mcpStatus ?? null,
        toolCount: rawToolCount ? Number(rawToolCount) : null,
        text: row.innerText.slice(0, 300),
      };
    },
    testId(TID_MCP_SERVER_ROW, serverName),
  );
}

/** 归档只改任务索引、不关闭 Agent 会话；在归档管理里删除才关闭会话的运行实例。 */
async function archiveAndDeleteTask(taskId: string): Promise<void> {
  const archive = testId(TID_TASK_ARCHIVE, taskId);
  // 归档按钮只在任务行 hover/focus 时挂载。指针可能已停在这一行的位置（前面步骤留下），
  // 原地 moveTo 不产生 mouseenter，按钮不会挂载；先移到会话区，再移回任务行。
  await browser
    .$(`[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`)
    .moveTo({ xOffset: 20, yOffset: 20 });
  await browser.$(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`).moveTo();
  await clickTestIdByDom(archive, {
    timeout: 15_000,
    timeoutMsg: `任务行 hover 后没有出现归档按钮: ${taskId}`,
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (id, confirming) =>
          Boolean(document.querySelector(`[data-testid="${id}"]`)?.closest(confirming)),
        archive,
        ARCHIVE_CONFIRMING_SELECTOR,
      ),
    { timeout: 10_000, timeoutMsg: `归档按钮没有进入确认状态: ${taskId}` },
  );
  await clickTestIdByDom(archive);
  await browser.$(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`).waitForExist({
    reverse: true,
    timeout: 15_000,
    timeoutMsg: `归档后任务仍在列表中: ${taskId}`,
  });
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "archives"));
  // 归档分组默认收起，收起时不挂载任务行；逐组展开，等展开状态生效后再找目标行。
  // 上一组的高度动画会移动下一组的位置，所以用 DOM 点击，不用坐标点击。
  await browser
    .$('[data-testid="archive-group-toggle"]')
    .waitForExist({ timeout: 15_000, timeoutMsg: "归档管理没有出现任何分组" });
  for (const toggle of await browser.$$('[data-testid="archive-group-toggle"]')) {
    if ((await toggle.getAttribute("aria-expanded")) === "true") continue;
    await browser.execute((element) => (element as unknown as HTMLElement).click(), toggle);
    await browser.waitUntil(async () => (await toggle.getAttribute("aria-expanded")) === "true", {
      timeout: 10_000,
      timeoutMsg: "归档分组没有展开",
    });
  }
  const row = `[data-testid="archive-task"][data-task-id="${taskId}"]`;
  await browser
    .$(row)
    .waitForExist({ timeout: 15_000, timeoutMsg: `归档管理里没有任务: ${taskId}` });
  // 用 DOM 点击，不依赖分组展开的高度动画是否结束。
  await browser.execute(
    (selector) =>
      document.querySelector<HTMLElement>(`${selector} [data-testid="archive-delete"]`)!.click(),
    row,
  );
  await clickTestIdByDom(CONFIRM_DIALOG_CONFIRM);
  await browser.$(row).waitForExist({
    reverse: true,
    timeout: 15_000,
    timeoutMsg: `确认删除后任务仍在归档管理里: ${taskId}`,
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}

function readActiveWorkspaceInBrowser() {
  return (
    window as unknown as Window & {
      __zcodeTabStoreE2E: { getState(): { activeWorkspacePath: string } };
    }
  ).__zcodeTabStoreE2E.getState().activeWorkspacePath;
}

/**
 * 读取带 marker 的 Native 请求。传入 reply 时，先等到返回该回复的请求已完整落盘再读。
 * 修复原因：抓包在 launcher 进程里异步排队写文件，界面显示回复时，文件可能还没写入
 * 这条请求；立刻读取会漏掉本轮最后一个请求（曾在重试断言处读到 undefined）。
 */
async function readNativeRequests(marker: string, reply?: string) {
  if (reply === undefined) return readNativeCapture(marker);
  let records: Awaited<ReturnType<typeof readNativeCapture>> = [];
  await browser.waitUntil(
    async () => {
      records = await readNativeCapture(marker);
      return records.some(
        (record) => record.status === "complete" && record.responseTextPreview?.includes(reply),
      );
    },
    {
      timeout: NATIVE_CAPTURE_FLUSH_TIMEOUT_MS,
      timeoutMsg: `抓包文件未写入回复 ${reply} 的请求`,
    },
  );
  return records;
}

async function readNativeCapture(marker: string) {
  const artifact = JSON.parse(
    await readFile(
      resolve(
        process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR || ".e2e-network-capture",
        "coding-plan-data-plane.json",
      ),
      "utf8",
    ),
  ) as E2ENetworkCaptureArtifact;
  return artifact.records.filter((record) => {
    const text = JSON.stringify(record.requestJson);
    return (
      record.path.endsWith("/messages") &&
      text?.includes(marker) &&
      !PROVIDER_SIDECAR_EXCLUDES.some((exclude) => text.includes(exclude))
    );
  });
}

async function writeSlowMcpFixture(): Promise<void> {
  await mkdir(CASE_ROOT, { recursive: true });
  await rm(EVENT_LOG, { force: true });
  await rm(RELEASE_FILE, { force: true });
  const config = await readJsonRecord(CLI_CONFIG_FILE);
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp.servers);
  servers[SLOW_MCP_NAME] = {
    args: [SLOW_MCP_SERVER_SCRIPT],
    command: process.execPath,
    env: { E2E_MCP_ASYNC_WAIT_LOG: EVENT_LOG, E2E_MCP_RELEASE_FILE: RELEASE_FILE },
    timeoutMs: SLOW_MCP_SERVER_TIMEOUT_MS,
    type: "stdio",
  };
  mcp.servers = servers;
  config.mcp = mcp;
  await mkdir(join(E2E_PATHS.homeDir, ".zcode", "cli"), { recursive: true });
  await writeFile(CLI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function openMobileTask(page: Page, taskId: string): Promise<void> {
  await showMobileTaskHome(page);
  const toggles = page.getByTestId("virtual-project-toggle");
  for (const toggle of await toggles.all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  await page.getByTestId(testId(TID_TASK_ITEM, taskId)).first().click();
  await page.locator(`[data-session-id=${JSON.stringify(taskId)}]`).waitFor();
}

async function expandMobileHistory(page: Page): Promise<void> {
  // 完成的轮次会把工具调用折叠进「已工作」历史区；要先等触发器渲染再展开，否则遍历时还是空列表。
  // 只展开一次并等每个触发器确认已打开，避免展开未完成时再点一次又折叠回去。
  const triggers = page.locator(`[data-testid^="${TID_CHAT_ASSISTANT_HISTORY_TRIGGER}-"]`);
  await triggers.first().waitFor({ state: "visible", timeout: 60_000 });
  for (const trigger of await triggers.all()) {
    if ((await trigger.getAttribute("data-history-open")) === "false") await trigger.click();
    await browser.waitUntil(
      async () => (await trigger.getAttribute("data-history-open")) === "true",
      {
        timeout: 10_000,
        timeoutMsg: "手机端「已工作」历史区没有展开",
      },
    );
  }
  // 展开有 300ms 高度动画且内容区 overflow-hidden；visible 只看尺寸不看祖先裁剪，
  // 动画未结束时截图里工具块仍被裁掉。等动画结束，断言和截图才对应真实可见。
  await page.waitForFunction(
    (prefix) =>
      Array.from(document.querySelectorAll(`[data-testid^="${prefix}-"]`)).every((content) =>
        content
          .getAnimations({ subtree: true })
          .every((animation) => animation.playState !== "running"),
      ),
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
    { timeout: 10_000 },
  );
}

async function waitForSlowMcpPing(timeoutMs: number): Promise<SlowMcpEvent[]> {
  let latest: SlowMcpEvent[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readSlowMcpEvents();
      return latest.some((entry) => entry.event === "ping" && entry.marker === PROMPT_MARKER);
    },
    { timeout: timeoutMs, timeoutMsg: `slow MCP ping 没有真实执行: ${JSON.stringify(latest)}` },
  );
  return latest;
}

/** agent 日志里已结束 MCP 启动批次的会话（`mcp.startup.completed`）；只读日志，不往产品代码加测试入口。 */
async function readMcpStartupCompletedSessions(): Promise<Set<string>> {
  const logDir = process.env.ZCODE_LOG_DIR;
  if (!logDir) throw new Error("缺少 worker 日志目录 ZCODE_LOG_DIR");
  const sessions = new Set<string>();
  for (const file of (await readdir(logDir)).filter((name) => name.endsWith(".jsonl"))) {
    const content = await readFile(join(logDir, file), "utf8");
    // 日志按行追加；只解析已完整写入的行。
    for (const line of content.split("\n").slice(0, -1)) {
      if (!line.includes('"mcp.startup.completed"')) continue;
      const record = JSON.parse(line) as { event?: string; sessionId?: string };
      if (record.event === "mcp.startup.completed" && record.sessionId)
        sessions.add(record.sessionId);
    }
  }
  return sessions;
}

async function readSlowMcpEvents(path = EVENT_LOG): Promise<SlowMcpEvent[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SlowMcpEvent);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

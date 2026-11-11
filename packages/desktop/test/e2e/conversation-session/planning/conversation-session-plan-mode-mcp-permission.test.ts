import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4PermissionDialog,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_PLAN_MODE_MCP_PERMISSION";
const LOOKUP_QUERY = "E2E_PLAN_MCP_LOOKUP_QUERY";
const LOOKUP_RESULT = `E2E_PLAN_MCP_LOOKUP_RESULT:${LOOKUP_QUERY}`;
const DESTRUCTIVE_MARKER = "E2E_PLAN_MCP_DESTRUCTIVE_ATTEMPT";
const RESET_RESULT = "E2E_PLAN_MCP_RESET_SHOULD_NOT_RUN";
const DENIAL_TEXT = "Plan mode only allows read-only, non-destructive tools";
const ENTER_TOOL_CALL_ID = "toolu_e2e_plan_mcp_enter_plan";
const LOOKUP_TOOL_CALL_ID = "toolu_e2e_plan_mcp_lookup";
const RESET_TOOL_CALL_ID = "toolu_e2e_plan_mcp_reset";
const LOOKUP_TOOL_NAME = "mcp__plan_mode_e2e__lookup";
const RESET_TOOL_NAME = "mcp__plan_mode_e2e__reset";
const CASE_ROOT = join(DEFAULT_WORKSPACE, "plan-mode-mcp-permission-e2e");
const USER_CONFIG_FILE = join(getE2EAppDataPaths().storageRoot, "cli", "config.json");
const MCP_CALL_LOG = join(CASE_ROOT, "mcp-calls.ndjson");
const MCP_SERVER_SCRIPT = resolve(
  process.cwd(),
  "test/e2e/fixtures/mcp/plan-mode-mcp-permission-server.mjs",
);

describe("会话区 Plan mode MCP 权限边界 E2E", () => {
  afterEach(async () => {
    await cleanupPlanModeMcpFixture();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await cleanupPlanModeMcpFixture();
    await clearAppData();
  });

  it("Y01/Y02: Plan mode 对非 destructive MCP 单次询问，并拒绝 destructive MCP", async function () {
    this.timeout(180000);

    // 用户级 MCP 只在会话启动时加载，必须在 prepare 创建会话前写入。
    await writePlanModeMcpConfig();
    await prepareV4ConversationE2E();

    const prompt = [
      `${PROMPT_MARKER}: Enter plan mode first.`,
      `Then call ${LOOKUP_TOOL_NAME} with query ${LOOKUP_QUERY}.`,
      `After lookup, call ${RESET_TOOL_NAME} with marker ${DESTRUCTIVE_MARKER}.`,
      `Do not call ExitPlanMode. Finish only after the MCP boundary is handled.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "Plan mode MCP 首发后输入框没有清空");
    await waitForV4UserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, LOOKUP_TOOL_NAME, RESET_TOOL_NAME],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "首轮请求没有暴露 Plan mode MCP E2E 工具 schema",
      60000,
    );

    // 原因：V4 不展示内部 EnterPlanMode 行；检查真实工具结果，保留模式切换断言。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId(ENTER_TOOL_CALL_ID))?.isError === false,
      { timeout: 60_000, timeoutMsg: "EnterPlanMode 没有产生成功的真实工具结果" },
    );
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "EnterPlanMode 结果没有进入 lookup 前的 provider continuation",
      60000,
    );

    await waitForToolCallBlockByToolName(LOOKUP_TOOL_NAME, 90000);
    // 原因：Plan 只在原模式（build）之上收紧，非只读 MCP 必须先经用户确认；
    // 在 Plan 下记住的规则不会生效，所以弹窗不提供"始终允许"。
    await waitForV4PermissionDialog(60000);
    expect((await readMcpCalls()).some((call) => call.tool === "lookup")).toBe(false);
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-permission-option-kind="allowAlways"]').length,
      ),
    ).toBe(0);
    expect(await approveV4Permission()).toBe(true);
    await waitForMcpCall("lookup", 60000);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, LOOKUP_TOOL_CALL_ID, LOOKUP_RESULT],
        excludes: [DENIAL_TEXT, "Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "非 destructive MCP lookup 允许一次后没有真实执行并进入 provider continuation",
      60000,
    );

    await waitForToolCallBlockByToolName(RESET_TOOL_NAME, 60000);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, RESET_TOOL_CALL_ID, DENIAL_TEXT],
        excludes: [RESET_RESULT, "Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "destructive MCP reset 没有在调用 server 前被 Plan mode 拒绝",
      60000,
    );
    const resetBlock = await waitForToolCallBlockStatus(
      RESET_TOOL_NAME,
      // V4 权限拒绝投影为 cancelled/stopped；保留上游拒绝原因和 server 零调用断言。
      "stopped",
      60000,
    );
    expect(resetBlock.text).not.toContain("Running");

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Plan mode MCP 权限边界 case 完成后没有回到 idle",
      60000,
    );

    const calls = await readMcpCalls();
    expect(calls.some((call) => call.tool === "lookup")).toBe(true);
    expect(calls.some((call) => call.tool === "reset")).toBe(false);
  });
});

// 修复原因：工作区级 MCP 现在需要用户信任（docs/settings-mcp-list.md），未信任时工具不注册，
// lookup 永远不会执行。本用例验证 Plan mode 权限边界而非信任流程，因此改用用户级配置声明
// server，并在结束时恢复原用户配置。
let originalUserConfigText: string | null | undefined;

async function writePlanModeMcpConfig() {
  await mkdir(CASE_ROOT, { recursive: true });
  await mkdir(dirname(USER_CONFIG_FILE), { recursive: true });
  originalUserConfigText = await readFile(USER_CONFIG_FILE, "utf-8").catch(() => null);
  const userConfig = (originalUserConfigText ? JSON.parse(originalUserConfigText) : {}) as {
    mcp?: { servers?: Record<string, unknown> };
  };
  userConfig.mcp = {
    ...userConfig.mcp,
    servers: {
      ...userConfig.mcp?.servers,
      plan_mode_e2e: {
        type: "stdio",
        command: process.execPath,
        args: [MCP_SERVER_SCRIPT],
        env: {
          E2E_PLAN_MCP_CALL_LOG: MCP_CALL_LOG,
        },
        timeoutMs: 30000,
      },
    },
  };
  await writeFile(USER_CONFIG_FILE, `${JSON.stringify(userConfig, null, 2)}\n`, "utf-8");
}

async function cleanupPlanModeMcpFixture() {
  await rm(CASE_ROOT, { recursive: true, force: true });
  if (originalUserConfigText === undefined) return;
  if (originalUserConfigText === null) {
    await rm(USER_CONFIG_FILE, { force: true });
  } else {
    await writeFile(USER_CONFIG_FILE, originalUserConfigText, "utf-8");
  }
  originalUserConfigText = undefined;
}

interface McpCallLogEntry {
  tool?: string;
}

async function waitForMcpCall(tool: string, timeoutMs: number) {
  let latest: McpCallLogEntry[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readMcpCalls();
      return latest.some((call) => call.tool === tool);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `没有等到 MCP server 调用 ${tool}; latest=${JSON.stringify(latest)}`,
    },
  );
}

async function waitForToolCallBlockStatus(toolName: string, status: string, timeoutMs: number) {
  let latest = await waitForToolCallBlockByToolName(toolName, timeoutMs);
  await browser.waitUntil(
    async () => {
      latest = await waitForToolCallBlockByToolName(toolName, timeoutMs);
      return latest.status === status;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `tool block ${toolName} 没有进入 ${status}; latest=${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function readMcpCalls(): Promise<McpCallLogEntry[]> {
  try {
    const raw = await readFile(MCP_CALL_LOG, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as McpCallLogEntry);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

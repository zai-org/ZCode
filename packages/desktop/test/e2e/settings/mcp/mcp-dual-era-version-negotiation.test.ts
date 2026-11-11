import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  TID_MCP_SERVER_ROW,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
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
// 正式用例已迁移到 V4，旧初始化在设置页返回后仍等待已移除的聊天入口。
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 180_000;
const MODERN_SERVER_NAME = "e2e_modern_728";
const LEGACY_SERVER_NAME = "e2e_legacy_2025";
const PINNED_LEGACY_SERVER_NAME = "e2e_pinned_legacy";
const BUILT_IN_NODE_REPL_SERVER_NAME = "node_repl";
const E2E_PATHS = getE2EAppDataPaths();
// 修复原因：WDIO 为每轮运行注入隔离 HOME，但 CLI 数据根实际是 HOME/.zcode。
// 这里沿用 desktop-app 的 storageRoot 合同；直接从 homeDir 再拼 .zcode 会在
// 当前 fixture layout 下绕过 runner 已创建的 .zcode/cli，导致写入前 ENOENT。
const CLI_CONFIG_FILE = join(E2E_PATHS.storageRoot, "cli", "config.json");
const CASE_ROOT = join(E2E_PATHS.workspace, "mcp-dual-era-version-negotiation-e2e");
const MODERN_WIRE_LOG = join(CASE_ROOT, "modern-wire.ndjson");
const LEGACY_WIRE_LOG = join(CASE_ROOT, "legacy-wire.ndjson");
const PINNED_LEGACY_WIRE_LOG = join(CASE_ROOT, "pinned-legacy-wire.ndjson");
const VERSION_SERVER_SCRIPT = resolve(
  process.cwd(),
  "test/e2e/fixtures/mcp/dual-era-version-server.mjs",
);

interface McpConnectedLog {
  mcpClientName?: string;
  mcpClientVersion?: string;
  mcpProtocolEra?: string;
  mcpProtocolVersion?: string;
  mcpServerName?: string;
  mcpVersionNegotiationMode?: string;
}

interface WireLogEntry {
  event?: string;
  method?: string;
  mode?: string;
  pid?: number;
}

describe("MCP dual-era 真实 Desktop 版本协商 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MVN04: 配置文件指定 legacy 后真实 Agent 跳过 probe 并连接", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    // 隔离 HOME 会触发首次使用引导，先走产品支持的 Escape 关闭，再等待工作区就绪。
    await browser.waitUntil(
      async () => {
        const onboarding = await browser.$('[data-testid="onboarding-page"]');
        if (await onboarding.isExisting()) await browser.keys("Escape");
        return browser.execute(
          (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
          TID_TASK_SETTINGS_BUTTON,
        );
      },
      { timeout: 30_000, timeoutMsg: "首次使用引导关闭后未进入工作区" },
    );
    await prepareV4ConversationE2E({ skipProvider: true });
    await mkdir(CASE_ROOT, { recursive: true });
    await mkdir(dirname(CLI_CONFIG_FILE), { recursive: true });
    await rm(PINNED_LEGACY_WIRE_LOG, { force: true });
    const config = await readJsonRecord(CLI_CONFIG_FILE);
    const mcp = asRecord(config.mcp);
    mcp.servers = {
      ...asRecord(mcp.servers),
      [PINNED_LEGACY_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [VERSION_SERVER_SCRIPT],
        env: {
          E2E_MCP_VERSION_MODE: "legacy",
          E2E_MCP_VERSION_WIRE_LOG: PINNED_LEGACY_WIRE_LOG,
        },
        protocolVersion: "legacy",
        timeoutMs: 30_000,
      },
    };
    await writeFile(CLI_CONFIG_FILE, `${JSON.stringify({ ...config, mcp }, null, 2)}\n`, "utf8");
    await openMcpSettings();
    await waitForMcpRowConnected(PINNED_LEGACY_SERVER_NAME);
    const connected = await waitForConnectedLogs([PINNED_LEGACY_SERVER_NAME]);
    expectConnectedLog(connected.get(PINNED_LEGACY_SERVER_NAME), {
      era: "legacy",
      mode: "legacy",
      version: "2025-11-25",
    });
    // 配置 schema 曾漏掉 protocolVersion，导致整个 server 被跳过；不能只验证设置页读回成功。
    const wire = await waitForWireEvidence(PINNED_LEGACY_WIRE_LOG, (entries) =>
      requestMethods(entries).has("tools/list"),
    );
    expect([...requestMethods(wire)]).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
    expect([...requestMethods(wire)]).not.toContain("server/discover");
  });

  it("MVN01/MVN02/MVN05/MVN06/MVN08: 真实 Agent 按 server 协商并记录精确版本", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    // 上一用例停在设置页；先通过返回入口恢复 Composer，再初始化下一条正式用例。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await prepareV4ConversationE2E();
    await writeVersionNegotiationFixtures();
    await openMcpSettings();
    await waitForMcpRowConnected(MODERN_SERVER_NAME);
    await waitForMcpRowConnected(LEGACY_SERVER_NAME);

    const connected = await waitForConnectedLogs([
      MODERN_SERVER_NAME,
      LEGACY_SERVER_NAME,
      BUILT_IN_NODE_REPL_SERVER_NAME,
    ]);
    expectConnectedLog(connected.get(MODERN_SERVER_NAME), {
      era: "modern",
      mode: "auto",
      version: "2026-07-28",
    });
    expectConnectedLog(connected.get(LEGACY_SERVER_NAME), {
      era: "legacy",
      mode: "auto",
      version: "2025-11-25",
    });
    expectConnectedLog(connected.get(BUILT_IN_NODE_REPL_SERVER_NAME), {
      era: "modern",
      mode: "2026-07-28",
      version: "2026-07-28",
    });

    const modernWire = await waitForWireEvidence(MODERN_WIRE_LOG, (entries) => {
      const methods = requestMethods(entries);
      return startedPids(entries).length >= 2 && methods.has("server/discover");
    });
    expect([...requestMethods(modernWire)]).toContain("server/discover");
    expect([...requestMethods(modernWire)]).not.toContain("initialize");

    const legacyWire = await waitForWireEvidence(LEGACY_WIRE_LOG, (entries) => {
      const methods = requestMethods(entries);
      return (
        startedPids(entries).length >= 2 &&
        methods.has("server/discover") &&
        methods.has("initialize")
      );
    });
    expect([...requestMethods(legacyWire)]).toEqual(
      expect.arrayContaining(["server/discover", "initialize", "tools/list"]),
    );

    // probe 是 disposable sibling；settings 与 draft/session 可各保留真实 child，但不能残留 probe-only PID。
    await waitForProbeProcessesExit(MODERN_WIRE_LOG);
    await waitForProbeProcessesExit(LEGACY_WIRE_LOG);
  });
});

async function writeVersionNegotiationFixtures(): Promise<void> {
  await mkdir(CASE_ROOT, { recursive: true });
  // 修复原因：serial/targeted WDIO 入口不会经过会创建 CLI 目录的可选 seed hook；
  // fixture 自己必须建立隔离的 CLI 配置目录，否则首次写配置会在 setup 阶段 ENOENT。
  await mkdir(dirname(CLI_CONFIG_FILE), { recursive: true });
  await Promise.all([rm(MODERN_WIRE_LOG, { force: true }), rm(LEGACY_WIRE_LOG, { force: true })]);
  const config = await readJsonRecord(CLI_CONFIG_FILE);
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp.servers);
  servers[MODERN_SERVER_NAME] = {
    args: [VERSION_SERVER_SCRIPT],
    command: process.execPath,
    env: {
      E2E_MCP_VERSION_MODE: "modern",
      E2E_MCP_VERSION_WIRE_LOG: MODERN_WIRE_LOG,
    },
    timeoutMs: 30_000,
    type: "stdio",
  };
  servers[LEGACY_SERVER_NAME] = {
    args: [VERSION_SERVER_SCRIPT],
    command: process.execPath,
    env: {
      E2E_MCP_VERSION_MODE: "legacy",
      E2E_MCP_VERSION_WIRE_LOG: LEGACY_WIRE_LOG,
    },
    timeoutMs: 30_000,
    type: "stdio",
  };
  mcp.servers = servers;
  config.mcp = mcp;
  await writeFile(CLI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

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

async function waitForMcpRowConnected(serverName: string): Promise<void> {
  const rowTestId = testId(TID_MCP_SERVER_ROW, serverName);
  let latest = "";
  await browser.waitUntil(
    async () => {
      const row = await browser.execute((targetTestId) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === targetTestId,
        );
        return element
          ? {
              status: element.dataset.mcpStatus ?? "",
              text: element.innerText,
              toolCount: Number(element.dataset.mcpToolCount ?? "0"),
            }
          : null;
      }, rowTestId);
      latest = JSON.stringify(row);
      return row?.status === "connected" && row.toolCount === 1;
    },
    {
      timeout: 60_000,
      timeoutMsg: `${serverName} MCP 行没有连接: ${latest}`,
    },
  );
}

async function waitForConnectedLogs(
  serverNames: readonly string[],
): Promise<Map<string, McpConnectedLog>> {
  let latest = new Map<string, McpConnectedLog>();
  await browser.waitUntil(
    async () => {
      latest = await readConnectedLogs();
      return serverNames.every((serverName) => latest.has(serverName));
    },
    {
      timeout: 60_000,
      timeoutMsg: `MCP 连接日志不完整: ${JSON.stringify([...latest])}`,
    },
  );
  return latest;
}

async function readConnectedLogs(): Promise<Map<string, McpConnectedLog>> {
  const logDir =
    process.env.ZCODE_LOG_DIR?.trim() || join(E2E_PATHS.homeDir, ".zcode", "cli", "log");
  const result = new Map<string, McpConnectedLog>();
  const files = await readdir(logDir).catch(() => []);
  for (const file of files) {
    const content = await readFile(join(logDir, file), "utf8").catch(() => "");
    for (const line of content.split("\n")) {
      const entry = parseJsonRecord(line);
      if (entry?.event !== "mcp.server.connected") continue;
      const context = asRecord(entry.context);
      const serverName = context.mcpServerName;
      if (typeof serverName !== "string") continue;
      result.set(serverName, context as McpConnectedLog);
    }
  }
  return result;
}

function expectConnectedLog(
  actual: McpConnectedLog | undefined,
  expected: { era: string; mode: string; version: string },
): void {
  expect(actual).toMatchObject({
    mcpProtocolEra: expected.era,
    mcpProtocolVersion: expected.version,
    mcpVersionNegotiationMode: expected.mode,
  });
  expect(actual?.mcpClientName).toEqual(expect.any(String));
  expect(actual?.mcpClientVersion).toEqual(expect.any(String));
}

async function waitForWireEvidence(
  path: string,
  predicate: (entries: WireLogEntry[]) => boolean,
): Promise<WireLogEntry[]> {
  let latest: WireLogEntry[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readWireLog(path);
      return predicate(latest);
    },
    {
      timeout: 60_000,
      timeoutMsg: `MCP fixture wire 证据不完整: ${path} ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function waitForProbeProcessesExit(path: string): Promise<void> {
  let latest: {
    live: number[];
    liveProbeOnly: number[];
    started: number[];
  } = { live: [], liveProbeOnly: [], started: [] };
  const deadline = Date.now() + 30_000;
  // 这里只轮询 Node 侧文件和 PID；走 browser.waitUntil 会触发 Electron bridge ContextId 探测，
  // renderer context 暂时不可用时回调根本不会执行，最终会把已有 wire 证据误报成空数组。
  while (Date.now() < deadline) {
    const entries = await readWireLog(path);
    const started = startedPids(entries);
    const live = started.filter(isProcessAlive);
    const liveProbeOnly = live.filter(
      (pid) => !requestMethodsForPid(entries, pid).has("tools/list"),
    );
    latest = { live, liveProbeOnly, started };
    if (started.length >= 2 && live.length >= 1 && liveProbeOnly.length === 0) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`MCP probe process 没有退出: ${path} ${JSON.stringify(latest)}`);
}

async function readWireLog(path: string): Promise<WireLogEntry[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").flatMap((line) => {
    const entry = parseJsonRecord(line);
    return entry ? [entry as WireLogEntry] : [];
  });
}

function requestMethods(entries: readonly WireLogEntry[]): Set<string> {
  return new Set(
    entries.flatMap((entry) =>
      entry.event === "request" && typeof entry.method === "string" ? [entry.method] : [],
    ),
  );
}

function requestMethodsForPid(entries: readonly WireLogEntry[], pid: number): Set<string> {
  return requestMethods(entries.filter((entry) => entry.pid === pid));
}

function startedPids(entries: readonly WireLogEntry[]): number[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.event === "started" && typeof entry.pid === "number" ? [entry.pid] : [],
      ),
    ),
  ];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EINVAL")
    );
  }
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  return parseJsonRecord(await readFile(path, "utf8").catch(() => "{}")) ?? {};
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

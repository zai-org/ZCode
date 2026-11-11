import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { listToolCallBlocks } from "#e2e/helpers/conversation-session-tool";
import {
  collectProcessTreeByRootPids,
  listSystemProcesses,
} from "#e2e/helpers/e2e-process-cleanup";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { isV4TurnCompleted } from "#e2e/helpers/v4-turn-completion";

const NODE_REPL_TOOL = "mcp__node_repl__js";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_PROCESS_TITLE = "zcode-node-repl-mcp";

// 修复原因：Windows 不会把 process.title 写回 WMI 命令行，Node REPL 子进程在那里只表现为
// `__zcode-plugin-host` 加载 node-repl-host 的 dist/mcp/server.js；只按标题匹配会得到空列表。
function isNodeReplProcessCommand(command: string): boolean {
  const normalized = command.trim().replaceAll("\\", "/");
  return (
    normalized === NODE_REPL_PROCESS_TITLE ||
    (normalized.includes(" __zcode-plugin-host ") &&
      normalized.includes("/node-repl-host/") &&
      normalized.includes("/dist/mcp/server.js"))
  );
}
const SESSION_A_MARKER = "E2E_NODE_REPL_BROWSER_STATELESS_A";
const SESSION_B_MARKER = "E2E_NODE_REPL_BROWSER_STATELESS_B";
const SESSION_A_DONE = "E2E_NODE_REPL_BROWSER_STATELESS_A_DONE";
const SESSION_B_DONE = "E2E_NODE_REPL_BROWSER_STATELESS_B_DONE";
const E2E_PATHS = getE2EAppDataPaths();

interface McpLogContext extends Record<string, unknown> {
  event?: string;
  mcpConnectionId?: string;
  mcpIsolation?: string;
  mcpProtocolEra?: string;
  mcpProtocolVersion?: string;
  mcpServerName?: string;
  mcpTransportPid?: number;
  mcpVersionNegotiationMode?: string;
  sessionId?: string;
  workspaceKey?: string;
}

describe("Node REPL Browser Use 无状态多 Session E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BSM01/BSM02: fresh kernel、BrowserControl 连续且两个 session 共享 modern child", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();

    const runId = Date.now();
    await sendV4Prompt(
      `${SESSION_A_MARKER}_${runId}: use ${NODE_REPL_TOOL} for Browser Use twice and report only the fixture result.`,
    );
    const sessionAFirstCallId = await approveNodeReplCall();
    await approveNodeReplCall(sessionAFirstCallId);
    const sessionA = await waitForCompletedSession(
      SESSION_A_DONE,
      "Session A 的 Browser Use 两次调用没有完成",
    );

    // MCP frontend 按 workspace 共享；全局新草稿会创建另一 workspace，不能作为同域对照。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await sendV4Prompt(
      `${SESSION_B_MARKER}_${runId}: use ${NODE_REPL_TOOL} for Browser Use once and report only the fixture result.`,
    );
    await approveNodeReplCall();
    const sessionB = await waitForCompletedSession(
      SESSION_B_DONE,
      "Session B 的 Browser Use 调用没有完成",
    );
    expect(sessionB).not.toBe(sessionA);

    const runtime = await waitForSharedNodeReplRuntime(sessionA, sessionB);
    await expectSingleNodeReplProcess(runtime.pid);

    await selectV4TaskById(sessionA);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === sessionA &&
        snapshot.timelineText.includes(SESSION_A_DONE) &&
        !snapshot.timelineText.includes(SESSION_B_DONE),
      "切回 Session A 后出现了 Session B 的结果",
    );
    await selectV4TaskById(sessionB);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === sessionB &&
        snapshot.timelineText.includes(SESSION_B_DONE) &&
        !snapshot.timelineText.includes(SESSION_A_DONE),
      "切回 Session B 后出现了 Session A 的结果",
    );
  });
});

async function approveNodeReplCall(previousCallId?: string): Promise<string> {
  // Bug 根因：replay provider 会把 fixture 的 toolu_* 规范化为运行时 call_00_*，
  // 因此权限卡应按稳定的工具名匹配，不能依赖 provider 原始 tool call id。
  let callId = "";
  let callStatus: string | null = null;
  let blocks = await listToolCallBlocks();
  await browser.waitUntil(
    async () => {
      blocks = await listToolCallBlocks();
      const candidate = [...blocks]
        .reverse()
        .find((block) => block.toolName === NODE_REPL_TOOL && block.toolCallId !== previousCallId);
      callId = candidate?.toolCallId ?? "";
      callStatus = candidate?.status ?? null;
      return callId.length > 0 && (callStatus === "pending" || callStatus === "completed");
    },
    {
      timeout: 60_000,
      timeoutMsg: `Node REPL tool call 没有进入待批准状态: previousCallId=${previousCallId ?? "none"} blocks=${JSON.stringify(blocks)}`,
    },
  );
  if (callStatus === "completed") return callId;

  let latest = "";
  let completedWithoutPermission = false;
  await browser.waitUntil(
    async () => {
      const [state, latestBlocks] = await Promise.all([
        browser.execute(() => {
          const listboxes = Array.from(
            document.querySelectorAll<HTMLElement>('[role="listbox"]'),
          ).filter((element) => {
            const label = element.getAttribute("aria-label")?.trim();
            return label === "Permission required" || label === "需要权限";
          });
          return {
            allowOnceCount: listboxes.reduce(
              (count, listbox) =>
                count +
                listbox.querySelectorAll(
                  'button[role="option"][data-permission-option-kind="allowOnce"]',
                ).length,
              0,
            ),
            listboxCount: listboxes.length,
          };
        }),
        listToolCallBlocks(),
      ]);
      completedWithoutPermission = latestBlocks.some(
        (block) => block.toolCallId === callId && block.status === "completed",
      );
      latest = JSON.stringify({ state, blocks: latestBlocks });
      return completedWithoutPermission || (state.listboxCount === 1 && state.allowOnceCount === 1);
    },
    {
      timeout: 60_000,
      timeoutMsg: `Node REPL 权限请求没有出现: toolName=${NODE_REPL_TOOL} latest=${latest}`,
    },
  );
  // 同一权限指纹可能被本 turn 的既有决策自动放行；此时不应伪造一次 UI 点击。
  if (completedWithoutPermission) return callId;

  const clicked = await browser.execute(() => {
    const listboxes = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).filter(
      (element) => {
        const label = element.getAttribute("aria-label")?.trim();
        return label === "Permission required" || label === "需要权限";
      },
    );
    const options = listboxes.flatMap((listbox) =>
      Array.from(
        listbox.querySelectorAll<HTMLButtonElement>(
          'button[role="option"][data-permission-option-kind="allowOnce"]',
        ),
      ),
    );
    if (listboxes.length !== 1 || options.length !== 1) return false;
    options[0]?.click();
    return true;
  });
  // Bug 根因：连续 tool call 会立刻复用同一个 listbox；单次批准不能顺手消费下一张权限卡。
  expect(clicked).toBe(true);
  return callId;
}

async function waitForCompletedSession(expectedText: string, timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (candidate) => isV4TurnCompleted(candidate, expectedText),
    timeoutMsg,
    90_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}

async function waitForSharedNodeReplRuntime(
  sessionA: string,
  sessionB: string,
): Promise<{ pid: number }> {
  let latest: McpLogContext[] = [];
  let pid: number | undefined;
  await browser.waitUntil(
    async () => {
      latest = await readMcpLogContexts();
      const leases = latest.filter(
        (context) =>
          context.event === "mcp.pool.lease.acquired" &&
          context.mcpServerName === NODE_REPL_SERVER &&
          (context.sessionId === sessionA || context.sessionId === sessionB),
      );
      const leaseA = [...leases].reverse().find((context) => context.sessionId === sessionA);
      const leaseB = [...leases].reverse().find((context) => context.sessionId === sessionB);
      if (
        !leaseA?.mcpConnectionId ||
        leaseA.mcpConnectionId !== leaseB?.mcpConnectionId ||
        leaseA.mcpIsolation !== "workspace" ||
        leaseB.mcpIsolation !== "workspace" ||
        typeof leaseA.workspaceKey !== "string" ||
        leaseA.workspaceKey !== leaseB.workspaceKey
      ) {
        return false;
      }
      const connected = [...latest]
        .reverse()
        .find(
          (context) =>
            context.event === "mcp.server.connected" &&
            context.mcpServerName === NODE_REPL_SERVER &&
            context.mcpConnectionId === leaseA.mcpConnectionId,
        );
      if (
        connected?.mcpProtocolEra !== "modern" ||
        connected.mcpProtocolVersion !== "2026-07-28" ||
        connected.mcpVersionNegotiationMode !== "2026-07-28" ||
        typeof connected.mcpTransportPid !== "number"
      ) {
        return false;
      }
      pid = connected.mcpTransportPid;
      return true;
    },
    {
      timeout: 60_000,
      timeoutMsg: `Node REPL 多 session 连接证据不完整: ${JSON.stringify(latest)}`,
    },
  );
  if (pid === undefined) throw new Error("Node REPL 多 session PID 缺失");
  return { pid };
}

async function expectSingleNodeReplProcess(expectedPid: number): Promise<void> {
  const electron = await browser.electron.execute(() => ({ pid: process.pid }));
  let latest: Array<{ command: string; pid: number; ppid: number }> = [];
  await browser.waitUntil(
    async () => {
      const tree = collectProcessTreeByRootPids(await listSystemProcesses(), [electron.pid]);
      latest = tree.filter((entry) => isNodeReplProcessCommand(entry.command));
      return latest.length === 1 && latest[0]?.pid === expectedPid;
    },
    {
      interval: 250,
      timeout: 30_000,
      timeoutMsg: `Node REPL child 不是日志对应的唯一进程: expectedPid=${expectedPid} latest=${JSON.stringify(latest)}`,
    },
  );
}

async function readMcpLogContexts(): Promise<McpLogContext[]> {
  const logDirs = await resolveMcpLogDirs();
  const contexts: McpLogContext[] = [];
  for (const logDir of logDirs) {
    const files = await readdir(logDir).catch(() => []);
    for (const file of files) {
      const content = await readFile(join(logDir, file), "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        const entry = parseRecord(line);
        const context = asRecord(entry?.context) as McpLogContext;
        const event =
          typeof entry?.event === "string"
            ? entry.event
            : typeof context.event === "string"
              ? context.event
              : undefined;
        const sessionId =
          typeof entry?.sessionId === "string" ? entry.sessionId : context.sessionId;
        if (event?.startsWith("mcp.")) contexts.push({ ...context, event, sessionId });
      }
    }
  }
  return contexts;
}

async function resolveMcpLogDirs(): Promise<string[]> {
  const explicit = process.env.ZCODE_LOG_DIR?.trim();
  if (explicit) return [explicit];
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (artifactDir) {
    const runtimeLogDir = join(artifactDir, "runtime-logs");
    const workers = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
    const workerLogDirs = workers
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runtimeLogDir, entry.name, "agent"));
    if (workerLogDirs.length > 0) return workerLogDirs;
  }
  return [join(E2E_PATHS.storageRoot, "cli", "log")];
}

function parseRecord(value: string): Record<string, unknown> | null {
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

import { readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  waitForSuccessfulToolCallByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import {
  collectProcessTreeByRootPids,
  listSystemProcesses,
} from "#e2e/helpers/e2e-process-cleanup";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const TOOL_NAME = "mcp__node_repl__js";
const NODE_REPL_SERVER = "node_repl";
const WARMUP_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_WARMUP";
const WARMUP_FINAL_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_WARMUP_DONE";
const TURN_ONE_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_TURN_1";
const TURN_TWO_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_TURN_2";
const SETUP_TOOL_CALL_ID = "toolu_e2e_node_repl_frontend_restart_setup";
const VERIFY_TOOL_CALL_ID = "toolu_e2e_node_repl_frontend_restart_verify";
const SETUP_RESULT_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_SETUP_OK";
const VERIFY_RESULT_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_VERIFY_OK";
const SETUP_FINAL_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_SETUP_DONE";
const FINAL_MARKER = "E2E_NODE_REPL_FRONTEND_RESTART_DONE";
const PROVIDER_NOISE = ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"];
// 第一次自动重启没有退避；留出进程启动与 initialize 的时间。
const RESTART_TIMEOUT_MS = 60_000;
const E2E_PATHS = getE2EAppDataPaths();

interface FixtureTabSnapshot {
  exists: boolean;
  id: number;
  state: string;
  url: string;
}

interface McpLogContext extends Record<string, unknown> {
  event?: string;
  mcpServerName?: string;
  mcpTransportPid?: number;
}

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";

describe("Node REPL frontend 意外退出后自动重启 E2E", () => {
  before(async () => {
    fixtureServer = createRestartFixtureServer();
    fixtureRootUrl = await listen(fixtureServer);
  });

  after(async () => {
    await closeFixtureGuests();
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BSM03: frontend 被终止后不等调用就重启，下一轮 js 仍可用且 tab/page 连续", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();

    // MCP 异步启动时首个请求可能早于 node_repl 连上（ToolSearch 关闭时没有 pending 提示）。
    // 预热轮先启动会话并等 node_repl 连上，本 case 只验证之后的重启。
    await sendV4Prompt(`${WARMUP_MARKER}: reply with the warm-up marker only.`);
    await waitForV4AssistantMessageContaining(WARMUP_FINAL_MARKER);
    await waitForIdle("预热轮完成后没有回到 idle");
    const electronPid = await readElectronPid();
    const oldPid = await waitForNodeReplTransportPid(electronPid);

    await sendV4Prompt(
      [
        `${TURN_ONE_MARKER}: open the fixture page in an in-app Browser tab and write its state.`,
        `E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
      ].join(" "),
    );
    await waitForV4UserMessageContaining(TURN_ONE_MARKER);
    await waitForToolCallBlockByToolName(TOOL_NAME, 90_000);
    await waitForPermissionAndApproveOnce("创建重启前的 Browser tab");
    await waitForSuccessfulToolCallByToolCallId(SETUP_TOOL_CALL_ID, [SETUP_RESULT_MARKER], 90_000);
    await waitForV4AssistantMessageContaining(SETUP_FINAL_MARKER);
    await waitForIdle("首轮完成后没有回到 idle");
    const [tabBefore] = await waitForFixtureTabs(1);
    expect(tabBefore?.state).toBe("before-restart");

    // 首轮调用用的仍是预热时连上的同一个 frontend。
    expect(await waitForNodeReplTransportPid(electronPid)).toBe(oldPid);
    const requestCount = await getUpstreamRequestRecordCount();
    // 只终止日志里属于本 E2E Electron 进程树的 frontend，不影响机器上的其他 node_repl。
    process.kill(oldPid, "SIGTERM");

    // 不发任何 prompt：重启必须由 adapter 自己完成，不能依赖下一次模型调用。
    const newPid = await waitForNodeReplTransportPid(electronPid, oldPid);
    expect(newPid).not.toBe(oldPid);
    expect(await isInProcessTree(electronPid, oldPid)).toBe(false);
    expect(await getUpstreamRequestRecordCount()).toBe(requestCount);

    await sendV4Prompt(`${TURN_TWO_MARKER}: get the same Browser tab again and read its state.`);
    await waitForV4UserMessageContaining(TURN_TWO_MARKER);
    const secondTurnQuery = {
      lastUserMessageIncludes: [TURN_TWO_MARKER],
      excludes: [VERIFY_TOOL_CALL_ID, ...PROVIDER_NOISE],
    };
    await waitForUpstreamRequest(secondTurnQuery, "第二轮 provider 请求没有发出", 60_000);
    // 修复前 frontend 退出后 server 进入 failed，js 在下一步离开 provider 请求。
    expect(await getUpstreamRequestToolNames(secondTurnQuery)).toContain(TOOL_NAME);
    await waitForToolCallBlockByToolName(TOOL_NAME, 90_000);
    await waitForPermissionAndApproveOnce("重启后取回原 Browser tab");
    await waitForSuccessfulToolCallByToolCallId(
      VERIFY_TOOL_CALL_ID,
      [VERIFY_RESULT_MARKER],
      90_000,
    );
    await waitForUpstreamRequest(
      {
        includes: [TURN_TWO_MARKER, VERIFY_TOOL_CALL_ID],
        lastUserMessageIncludes: [VERIFY_RESULT_MARKER],
        excludes: PROVIDER_NOISE,
      },
      "重启后 js 结果没有进入 provider continuation",
      90_000,
    );
    await waitForV4AssistantMessageContaining(FINAL_MARKER);
    await waitForIdle("第二轮完成后没有回到 idle");

    const [tabAfter] = await waitForFixtureTabs(1);
    expect(tabAfter?.id).toBe(tabBefore?.id);
    expect(tabAfter?.state).toBe("after-restart");
  });
});

function createRestartFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>E2E Node REPL Restart</title></head>
  <body>
    <main>
      <h1>Restart</h1>
      <label>State <input id="state" /></label>
      <p role="status">empty</p>
    </main>
    <script>
      document.querySelector("#state").addEventListener("input", (event) => {
        document.querySelector("[role=status]").textContent = event.currentTarget.value;
      });
    </script>
  </body>
</html>`);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Node REPL restart fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}/root`;
}

async function closeServer(server: Server | null) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForIdle(timeoutMessage: string) {
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    timeoutMessage,
    90_000,
  );
}

async function readElectronPid(): Promise<number> {
  const electron = await browser.electron.execute(() => ({ pid: process.pid }));
  return electron.pid;
}

async function isInProcessTree(rootPid: number, pid: number): Promise<boolean> {
  const tree = collectProcessTreeByRootPids(await listSystemProcesses(), [rootPid]);
  return tree.some((entry) => entry.pid === pid);
}

/** 读取最新一次 node_repl 连接的 transport PID，并确认它是本 Electron 进程树里仍存活的进程。 */
async function waitForNodeReplTransportPid(electronPid: number, previousPid?: number) {
  let pid: number | undefined;
  let latest: McpLogContext[] = [];
  const waiting = browser.waitUntil(
    async () => {
      latest = (await readMcpLogContexts()).filter(
        (context) =>
          context.event === "mcp.server.connected" && context.mcpServerName === NODE_REPL_SERVER,
      );
      const candidate = latest.at(-1)?.mcpTransportPid;
      if (typeof candidate !== "number" || candidate === previousPid) return false;
      if (!(await isInProcessTree(electronPid, candidate))) return false;
      // 新连接出现前旧进程必须已经退出，否则说明看到的不是重启后的连接。
      if (previousPid !== undefined && (await isInProcessTree(electronPid, previousPid)))
        return false;
      pid = candidate;
      return true;
    },
    { interval: 250, timeout: RESTART_TIMEOUT_MS },
  );
  // timeoutMsg 在等待开始时就会求值；超时后再读最终证据。
  await waiting.catch((error: unknown) => {
    throw new Error(
      `node_repl frontend 没有${previousPid ? "在退出后自动重启" : "连接"}: previousPid=${previousPid ?? "none"} connectedPids=${JSON.stringify(latest.map((context) => context.mcpTransportPid))}`,
      { cause: error },
    );
  });
  if (pid === undefined) throw new Error("node_repl transport PID 缺失");
  return pid;
}

async function waitForFixtureTabs(expectedCount: number, timeout = 60_000) {
  let latest: FixtureTabSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readFixtureTabs();
      return latest.length === expectedCount && latest.every((tab) => tab.exists);
    },
    {
      timeout,
      timeoutMsg: `fixture tab 数量没有收敛到 ${expectedCount}: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function readFixtureTabs(): Promise<FixtureTabSnapshot[]> {
  const ids = await browser.execute(
    (webviewTestId) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${webviewTestId}"]`))
        .map(
          (element) =>
            (element as HTMLElement & { getWebContentsId?: () => number }).getWebContentsId?.() ??
            0,
        )
        .filter((id) => id > 0),
    TID_BROWSER_WEBVIEW,
  );
  return browser.electron.execute(
    async (electron, targetIds, fixtureRoot) => {
      const fixtureOrigin = new URL(fixtureRoot).origin;
      const snapshots = await Promise.all(
        targetIds.map(async (id) => {
          const guest = electron.webContents.fromId(id);
          if (!guest || guest.isDestroyed()) return { exists: false, id, state: "", url: "" };
          const url = guest.getURL();
          if (!url.startsWith(fixtureOrigin)) return null;
          const state = (await guest.executeJavaScript(
            "document.querySelector('#state')?.value ?? ''",
          )) as string;
          return { exists: true, id, state, url };
        }),
      );
      return snapshots.filter((item): item is FixtureTabSnapshot => item !== null);
    },
    ids,
    fixtureRootUrl,
  ) as unknown as Promise<FixtureTabSnapshot[]>;
}

async function closeFixtureGuests() {
  if (!fixtureRootUrl) return;
  await browser.electron.execute((electron, fixtureRoot) => {
    const fixtureOrigin = new URL(fixtureRoot).origin;
    for (const contents of electron.webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.getURL().startsWith(fixtureOrigin)) {
        contents.close({ waitForBeforeUnload: false });
      }
    }
  }, fixtureRootUrl);
}

async function waitForPermissionAndApproveOnce(expectedTitle: string) {
  let latest = "";
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => {
        const listboxes = Array.from(
          document.querySelectorAll<HTMLElement>('[role="listbox"]'),
        ).filter((element) => {
          const label = element.getAttribute("aria-label")?.trim();
          return label === "Permission required" || label === "需要权限";
        });
        return {
          allowOnceCount: listboxes.reduce(
            (count, element) =>
              count +
              element.querySelectorAll(
                'button[role="option"][data-permission-option-kind="allowOnce"]',
              ).length,
            0,
          ),
          count: listboxes.length,
        };
      });
      latest = JSON.stringify(state);
      return state.count === 1 && state.allowOnceCount === 1;
    },
    {
      timeout: 30_000,
      timeoutMsg: `node_repl 权限请求没有出现（${expectedTitle}）: ${latest}`,
    },
  );
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
  // 一次只批准一个请求，避免顺手批准下一张权限卡。
  expect(clicked).toBe(true);
}

async function readMcpLogContexts(): Promise<McpLogContext[]> {
  const contexts: McpLogContext[] = [];
  for (const logDir of await resolveMcpLogDirs()) {
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
        if (event?.startsWith("mcp.")) contexts.push({ ...context, event });
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

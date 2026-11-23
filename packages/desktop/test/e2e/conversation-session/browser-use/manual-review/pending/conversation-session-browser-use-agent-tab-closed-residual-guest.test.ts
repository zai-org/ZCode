import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { getPassiveAgentStartupWorkspacePaths } from "#e2e/helpers/passive-agent-startup-fixture";
import { waitForSuccessfulToolCallByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  openWorkspaceDraftFromSidebar,
  waitForActiveWorkspacePath,
  waitForRestoredProjects,
} from "#e2e/helpers/workspace-agent-warmup";

/**
 * 守 spec docs/browser-use/2026-08-23-browser-guest-scope-recovery-spec.md §3.4（BGR-013 / BGR-014）。
 *
 * side pane 按 workspace 存放，切走 workspace 会卸载 Agent tab 的 <webview>。guest 销毁后 main 发
 * BrowserViewReady，renderer 把 tab 挂进当前 workspace（W2）的隐藏 browser-use 壳并恢复页面；这个
 * guest 受 main 管理，不是当前对话所以静音。之后归档/删除/关闭 tab 时 BrowserViewCloseTab 只移除所属
 * workspace（W1）的壳，W2 的壳残留。再回到 W2，残留壳重新挂载并自行加载页面，旧实现在 main 以
 * `closed` 拒绝 attach 却不关闭 guest，自动播放页面脱离管理一直出声。
 *
 * 判据：fixture 服务端的请求计数、存活 fixture guest 的列表和静音状态，以及归档后 main 新建的
 * webview guest 是否全部被关闭。
 * fixture 页面用 WebAudio 持续出声，guest 的 isCurrentlyAudible 可观测。
 */
const MARKER = "E2E_AGENT_TAB_WS_SWITCH";
const TOOL_NAME = "mcp__node_repl__js";
const OPEN_TOOL_CALL_ID = "toolu_e2e_agent_tab_ws_switch_open";
const CASE_TIMEOUT_MS = 300_000;
const MAX_WARMUP_TURNS = 5;

let fixtureServer: Server | null = null;
let fixtureUrl = "";
let fixtureHits = 0;

interface FixtureGuest {
  muted: boolean;
  audible: boolean;
}

describe("Agent tab 关闭后别的 workspace 的残留壳不留下出声 guest", () => {
  before(async () => {
    fixtureServer = createServer((_request, response) => {
      fixtureHits += 1;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><html><head><title>Agent tab audio</title></head><body>playing" +
          "<script>const ctx = new AudioContext(); const osc = ctx.createOscillator();" +
          "osc.connect(ctx.destination); osc.start();</script></body></html>",
      );
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.once("error", reject);
      fixtureServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fixtureServer.address() as AddressInfo;
    fixtureUrl = `http://127.0.0.1:${address.port}/agent-tab-audio`;
  });

  after(async () => {
    await new Promise<void>((resolve) =>
      fixtureServer ? fixtureServer.close(() => resolve()) : resolve(),
    );
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("切走时后台副本静音；归档后回到残留壳所在 workspace 没有存活 guest", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(dirname(DEFAULT_WORKSPACE), 2);
    await waitForRestoredProjects(workspacePaths, 60_000);
    const workspaceA = DEFAULT_WORKSPACE;
    const workspaceB = workspacePaths[0];
    if (!workspaceB) throw new Error("workspace fixture 不完整");
    await openWorkspaceDraftFromSidebar(workspaceA);
    await waitForActiveWorkspacePath(workspaceA);

    const taskId = await warmUpUntilBrowserUseToolExposed();

    await sendV4Prompt(`${MARKER}_TURN: open one tab. E2E_BROWSER_FIXTURE_URL:${fixtureUrl}`);
    await waitForV4UserMessageContaining(`${MARKER}_TURN`);
    await approveV4Permission();
    await waitForSuccessfulToolCallByToolCallId(OPEN_TOOL_CALL_ID, [`${MARKER}_OPEN_OK`], 90_000);
    await waitForV4AssistantMessageContaining(`${MARKER}_DONE`);
    await waitForFixtureGuests(
      (guests) => guests.length === 1 && !guests[0]!.muted,
      "Agent tab 没有在当前对话打开 fixture 页面",
    );
    const hitsAfterOpen = fixtureHits;

    // BGR-013：切到 B，Agent tab 的 guest 随 A 的壳卸载；Ready 在 B 的隐藏壳恢复页面，这份副本
    // 受 main 管理，不是当前对话，必须静音。它也是后面 BGR-014 需要的残留壳。
    await openWorkspaceDraftFromSidebar(workspaceB);
    await waitForActiveWorkspacePath(workspaceB);
    await browser.waitUntil(() => fixtureHits > hitsAfterOpen, {
      timeout: 30_000,
      timeoutMsg: "切到 B 后 Agent tab 没有在隐藏壳里恢复页面，残留壳前提不成立",
    });
    await waitForFixtureGuests(
      (guests) => guests.length === 1 && guests[0]!.muted,
      "切到 B 后后台恢复的 Agent tab 没有静音",
    );

    // 回到所属 workspace 与任务：所属壳重新挂载并恢复页面，当前对话解除静音。
    await openWorkspaceDraftFromSidebar(workspaceA);
    await waitForActiveWorkspacePath(workspaceA);
    await selectV4TaskById(taskId, 30_000);
    await waitForFixtureGuests(
      (guests) => guests.length === 1 && !guests[0]!.muted,
      "回到所属 workspace 后 Agent tab 没有恢复页面或仍被静音",
    );

    // BGR-014：归档后 main 关闭 tab，只移除 A 的壳。切到 B，残留壳重新挂载并创建新 guest；
    // main 以 closed 拒绝 attach，必须关闭这个 guest。归档与删除走同一条 main closeSession 路径。
    await archiveProjectTask(taskId);
    await waitForFixtureGuests((guests) => guests.length === 0, "归档后 Agent tab 的 guest 仍存活");
    await startRecordingNewWebviewGuests();
    await openWorkspaceDraftFromSidebar(workspaceB);
    await waitForActiveWorkspacePath(workspaceB);
    // 先等到残留壳真的创建过 guest，否定断言才有意义（不靠固定等待时长）。
    // 被拒的 guest 可能在加载 fixture 页面之前就被关闭，所以不按 URL 或服务端请求计数判断。
    await browser.waitUntil(async () => (await readRecordedWebviewGuests()).created > 0, {
      timeout: 30_000,
      timeoutMsg: "切回 B 后残留壳没有创建 guest，本用例没有走到 closed 拒绝路径",
    });
    await browser.waitUntil(async () => (await readRecordedWebviewGuests()).alive === 0, {
      timeout: 15_000,
      timeoutMsg: "tab 已关闭，残留壳创建的 guest 仍存活（不受 main 管理，会一直出声）",
    });
  });
});

/**
 * 首轮请求发出时 session 的 MCP 可能尚未连上，工具快照里没有 Browser Use。
 * 以可观测事实为准：直到某一轮预热请求已暴露 Node REPL 工具，下一轮才发真正的命令。
 */
async function warmUpUntilBrowserUseToolExposed(): Promise<string> {
  for (let turn = 1; turn <= MAX_WARMUP_TURNS; turn += 1) {
    const marker = `${MARKER}_WARMUP_${turn}`;
    await sendV4Prompt(`${marker}: reply with the warmup marker.`);
    const query = {
      lastUserMessageIncludes: [marker],
      excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
    };
    await waitForUpstreamRequest(query, `预热轮 ${turn} 没有发出请求`, 60_000);
    const state = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.taskId) && snapshot.state === "idle",
      `预热轮 ${turn} 没有结束`,
      90_000,
    );
    if ((await getUpstreamRequestToolNames(query)).includes(TOOL_NAME)) {
      return state.taskId as string;
    }
  }
  throw new Error(`${MAX_WARMUP_TURNS} 轮预热后请求仍没有暴露 ${TOOL_NAME}`);
}

/** 从此刻起记录 main 进程新建的 <webview> guest，用来观察残留壳是否创建过 guest。 */
async function startRecordingNewWebviewGuests(): Promise<void> {
  await browser.electron.execute((electron) => {
    const store = globalThis as typeof globalThis & {
      __e2eResidualWebviewGuests?: Electron.WebContents[];
    };
    if (store.__e2eResidualWebviewGuests) return;
    const created: Electron.WebContents[] = [];
    store.__e2eResidualWebviewGuests = created;
    electron.app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") created.push(contents);
    });
  });
}

async function readRecordedWebviewGuests(): Promise<{ created: number; alive: number }> {
  return (await browser.electron.execute(() => {
    const created =
      (
        globalThis as typeof globalThis & {
          __e2eResidualWebviewGuests?: Electron.WebContents[];
        }
      ).__e2eResidualWebviewGuests ?? [];
    return {
      created: created.length,
      alive: created.filter((contents) => !contents.isDestroyed()).length,
    };
  })) as unknown as { created: number; alive: number };
}

async function readFixtureGuests(): Promise<FixtureGuest[]> {
  return (await browser.electron.execute(
    (electron, url) =>
      electron.webContents
        .getAllWebContents()
        .filter(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getType() === "webview" &&
            contents.getURL() === url,
        )
        .map((contents) => ({
          muted: contents.isAudioMuted(),
          audible: contents.isCurrentlyAudible(),
        })),
    fixtureUrl,
  )) as unknown as FixtureGuest[];
}

async function waitForFixtureGuests(
  predicate: (guests: FixtureGuest[]) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => predicate(await readFixtureGuests()), {
    timeout: 30_000,
    timeoutMsg,
  });
}

async function archiveProjectTask(taskId: string): Promise<void> {
  const row = await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  await row.waitForDisplayed({ timeout: 15_000 });
  await row.moveTo();
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 15_000,
    timeoutMsg: "归档按钮没有出现",
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) =>
          Boolean(
            document
              .querySelector(`[data-testid="${id}"]`)
              ?.closest("[data-archive-confirming-task-id]"),
          ),
        testId(TID_TASK_ARCHIVE, taskId),
      ),
    { timeout: 10_000, timeoutMsg: "归档没有进入确认态" },
  );
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 10_000,
    timeoutMsg: "归档确认按钮没有出现",
  });
  await row.waitForExist({ reverse: true, timeout: 15_000 });
}

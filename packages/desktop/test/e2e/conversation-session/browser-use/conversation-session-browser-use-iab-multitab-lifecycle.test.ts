import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  waitForSuccessfulToolCallByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";

const TOOL_NAME = "mcp__node_repl__js";
const TURN_ONE_MARKER = "E2E_BROWSER_USE_MULTITAB_TURN_1";
const TURN_TWO_MARKER = "E2E_BROWSER_USE_MULTITAB_TURN_2";
const TURN_ONE_TOOL_CALL_ID = "toolu_e2e_browser_multitab_create";
const TURN_TWO_LIST_TOOL_CALL_ID = "toolu_e2e_browser_multitab_list";
const TURN_TWO_ACTION_TOOL_CALL_ID = "toolu_e2e_browser_multitab_action";
const TURN_ONE_RESULT_MARKER = "E2E_BROWSER_USE_MULTITAB_TURN1_OK";
const TURN_TWO_LIST_RESULT_MARKER = "E2E_BROWSER_USE_MULTITAB_LIST_OK";
const TURN_TWO_RESULT_MARKER = "E2E_BROWSER_USE_MULTITAB_TURN2_OK";
const TURN_ONE_FINAL_MARKER = "E2E_BROWSER_USE_MULTITAB_TURN1_DONE";
const TURN_TWO_FINAL_MARKER = "E2E_BROWSER_USE_MULTITAB_DONE";

interface FixtureTabSnapshot {
  exists: boolean;
  id: number;
  state: string;
  title: string;
  url: string;
}

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";

describe("Browser Use Desktop IAB 多 tab 生命周期 E2E", () => {
  before(async () => {
    fixtureServer = createMultiTabFixtureServer();
    fixtureRootUrl = await listen(fixtureServer);
  });

  after(async () => {
    await closeFixtureGuests();
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BU-E2E-003: finalize omission、跨 turn get 和显式 close", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();

    const firstPrompt = [
      `${TURN_ONE_MARKER}: create and retain two in-app Browser tabs across turns.`,
      `E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
      "Open pages A and B, write their state, and mark only A as handoff.",
    ].join(" ");
    await sendV4Prompt(firstPrompt);
    await waitForV4UserMessageContaining(TURN_ONE_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [TURN_ONE_MARKER, "E2E_BROWSER_FIXTURE_URL:", TOOL_NAME],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "首轮请求没有暴露 Browser Use Node REPL 工具或 fixture marker",
      60000,
    );
    await waitForToolCallBlockByToolName(TOOL_NAME, 90000);
    await waitForPermissionAndApproveOnce("创建两个 Browser tab");
    await waitForSuccessfulToolCallByToolCallId(
      TURN_ONE_TOOL_CALL_ID,
      [TURN_ONE_RESULT_MARKER],
      90000,
    );
    await waitForUpstreamRequest(
      {
        includes: [TURN_ONE_MARKER, TURN_ONE_TOOL_CALL_ID],
        lastUserMessageIncludes: [TURN_ONE_RESULT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "首轮多 tab 创建/finalize 结果没有进入 provider continuation",
      90000,
    );
    await waitForV4AssistantMessageContaining(TURN_ONE_FINAL_MARKER);
    await waitForIdle("首轮多 tab turn 完成后没有回到 idle");

    const firstTurnTabs = await waitForFixtureTabs(2);
    const firstA = findFixtureTab(firstTurnTabs, "/a");
    const firstB = findFixtureTab(firstTurnTabs, "/b");
    expect(firstA.state).toBe("alpha-turn-1");
    expect(firstB.state).toBe("beta-turn-1");
    expect(firstA.id).not.toBe(firstB.id);

    // 修复回归：finalize({ keep: [A] }) 是 lifecycle 标记，不是关闭白名单。
    // turnEnded 后 B 必须继续存在，不能因为模型漏列就被静默销毁。
    expect(await readGuestExists(firstA.id)).toBe(true);
    expect(await readGuestExists(firstB.id)).toBe(true);

    const secondPrompt = [
      `${TURN_TWO_MARKER}: recover the two controlled tabs by URL, update A, then explicitly close B.`,
      `E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
      "List first; in the next Browser call activate A by stable id, update it, and close only B.",
    ].join(" ");
    await sendV4Prompt(secondPrompt);
    await waitForV4UserMessageContaining(TURN_TWO_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [TURN_TWO_MARKER, "E2E_BROWSER_FIXTURE_URL:", TOOL_NAME],
        excludes: [
          TURN_TWO_LIST_TOOL_CALL_ID,
          "Generate a concise title",
          "CRITICAL: Respond with TEXT ONLY",
        ],
      },
      "第二轮初始 provider 请求没有恢复 Browser Use 工具",
      60000,
    );
    await waitForToolCallBlockByToolName(TOOL_NAME, 90000);
    await waitForPermissionAndApproveOnce("列出已有 Browser tab");
    await waitForSuccessfulToolCallByToolCallId(
      TURN_TWO_LIST_TOOL_CALL_ID,
      [TURN_TWO_LIST_RESULT_MARKER, "e2eBrowserTabAId", "e2eBrowserTabBId", "/a", "/b"],
      90000,
    );
    await waitForUpstreamRequest(
      {
        includes: [TURN_TWO_MARKER, TURN_TWO_LIST_TOOL_CALL_ID],
        lastUserMessageIncludes: [
          TURN_TWO_LIST_RESULT_MARKER,
          "e2eBrowserTabAId",
          "e2eBrowserTabBId",
          "/a",
          "/b",
        ],
        excludes: [
          TURN_TWO_ACTION_TOOL_CALL_ID,
          "Generate a concise title",
          "CRITICAL: Respond with TEXT ONLY",
        ],
      },
      "第二轮独立 tabs.list 结果没有进入下一次模型选择",
      90000,
    );
    await waitForPermissionAndApproveOnce("恢复 A 并关闭 B");
    await waitForSuccessfulToolCallByToolCallId(
      TURN_TWO_ACTION_TOOL_CALL_ID,
      [TURN_TWO_RESULT_MARKER],
      90000,
    );
    await waitForUpstreamRequest(
      {
        includes: [TURN_TWO_MARKER, TURN_TWO_ACTION_TOOL_CALL_ID],
        lastUserMessageIncludes: [TURN_TWO_RESULT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "第二轮 tabs.get(A)/close(B) 结果没有进入 provider continuation",
      90000,
    );
    await waitForV4AssistantMessageContaining(TURN_TWO_FINAL_MARKER);
    await waitForIdle("第二轮多 tab turn 完成后没有回到 idle");

    const secondTurnTabs = await waitForFixtureTabs(1);
    const secondA = findFixtureTab(secondTurnTabs, "/a");
    expect(secondA.id).toBe(firstA.id);
    expect(secondA.state).toBe("alpha-turn-2");
    expect(secondTurnTabs.some((tab) => new URL(tab.url).pathname === "/b")).toBe(false);
    expect(await readGuestExists(firstB.id)).toBe(false);
  });
});

function createMultiTabFixtureServer(): Server {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const pageName = pathname === "/b" ? "B" : pathname === "/a" ? "A" : "Root";
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>E2E Multi Tab ${pageName}</title></head>
  <body>
    <main>
      <h1>Page ${pageName}</h1>
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
  if (!address) throw new Error("Browser multi-tab fixture server 没有绑定端口");
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
    90000,
  );
}

async function waitForFixtureTabs(expectedCount: number, timeout = 60000) {
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
          if (!guest || guest.isDestroyed()) {
            return { exists: false, id, state: "", title: "", url: "" };
          }
          const url = guest.getURL();
          if (!url.startsWith(fixtureOrigin)) return null;
          const state = (await guest.executeJavaScript(
            "document.querySelector('#state')?.value ?? ''",
          )) as string;
          return { exists: true, id, state, title: guest.getTitle(), url };
        }),
      );
      return snapshots.filter((item): item is FixtureTabSnapshot => item !== null);
    },
    ids,
    fixtureRootUrl,
  ) as unknown as Promise<FixtureTabSnapshot[]>;
}

function findFixtureTab(tabs: FixtureTabSnapshot[], pathname: "/a" | "/b") {
  const matches = tabs.filter((tab) => new URL(tab.url).pathname === pathname);
  expect(matches).toHaveLength(1);
  return matches[0] as FixtureTabSnapshot;
}

function readGuestExists(webContentsId: number): Promise<boolean> {
  return browser.electron.execute((electron, targetId) => {
    const guest = electron.webContents.fromId(targetId);
    return Boolean(guest && !guest.isDestroyed());
  }, webContentsId) as unknown as Promise<boolean>;
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
  const clickUniqueAllowOnce = () =>
    browser.execute(() => {
      const listboxes = Array.from(
        document.querySelectorAll<HTMLElement>('[role="listbox"]'),
      ).filter((element) => {
        const label = element.getAttribute("aria-label")?.trim();
        return label === "Permission required" || label === "需要权限";
      });
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
      // V4 权限投影没有模型 title；每个阶段先由唯一 tool call matcher 锁定，
      // 再只批准唯一弹窗的唯一 allowOnce，避免误响应并发权限。
      return state.count === 1 && state.allowOnceCount === 1;
    },
    {
      timeout: 30000,
      timeoutMsg: `Browser Use 权限请求没有出现（${expectedTitle}）: ${latest}`,
    },
  );
  expect(await clickUniqueAllowOnce()).toBe(true);
  // 一个 helper 调用只能批准一个 request。下个 Node REPL 权限可能立即替换当前
  // listbox；继续按“仍打开”重试会误批准下一阶段，掩盖权限时序回归。
}

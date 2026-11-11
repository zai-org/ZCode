import type { Server } from "node:http";
import { TID_BROWSER_DESIGN_TOOLBAR, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import {
  enableDesignPlugin,
  closeFixtureServer,
  countAttachments,
  navigateBrowser,
  countElementTokens,
  deleteLastElementToken,
  selectGuestElement,
  waitForElementTokens,
  startFixtureServer,
  waitForReadyAttachment,
} from "#e2e/helpers/browser-design-mode";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

// BU-E2E-022（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第四节）：
// 点选元素的引用截图跟着引用走：同一个输入框在会话间切换时不重复、移除引用后不残留。
// 会话 A 点选 → 新建会话 B（B 里没有）→ 切回 A：仍是 1 个元素引用 + 1 张 element-1.png；
// 再来回切一次结果相同；在 A 移除引用后截图也没有。A 再发一轮时 ambient 块声明设计模式可用（桌面输入）。
// 分屏时两个输入框各自挂着图片附件 hook，不走这里的切换路径（见覆盖矩阵 BU-E2E-022 说明）。

const PIN_SHOT = "element-1.png";

const FIXTURE_HTML = `<!doctype html>
<html data-zcode-design><head><title>E2E design cross session</title></head>
<body><button id="cta">E2E_CROSS_SESSION_CTA</button></body></html>`;

let fixtureServer: Server | null = null;
let fixtureOrigin = "";

describe("BU-E2E-022：设计工具点选引用的截图跨会话切换不重复、不残留", () => {
  before(async () => {
    ({ server: fixtureServer, origin: fixtureOrigin } = await startFixtureServer(
      (_request, response) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(FIXTURE_HTML);
      },
    ));
  });

  after(async () => {
    await closeFixtureServer(fixtureServer);
    fixtureServer = null;
    await clearAppData();
  });

  it("A 点选，切到 B 再切回 A 截图只有一张；移除引用后截图全部撤掉", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    await enableDesignPlugin();

    // 会话 A：先发一轮，得到侧栏里能切回的正式会话。
    const sessionA = await startSessionWithOneTurn("E2E_DESIGN_CROSS_SESSION_A");

    await openFirstBrowserTab();
    await navigateBrowser(`${fixtureOrigin}/design`, "E2E design cross session", fixtureOrigin);
    await waitForDesignToolbar();

    // A 点选：1 个元素引用 + element-1.png。
    await selectGuestElement(fixtureOrigin, "#cta");
    await waitForElementTokens(1, "会话 A 点选后输入框里没有元素 token");
    await waitForReadyAttachment(PIN_SHOT);

    // 新建会话 B：B 里没有这个引用。
    await startNewV4Draft();
    const sessionB = await startSessionWithOneTurn("E2E_DESIGN_CROSS_SESSION_B");
    await expectComposer({ contexts: null, shots: 0 }, "新建会话 B 后");

    // 切回 A：仍是 1 条上下文 + 1 张截图，不重复；来回再切一次也一样。
    await openSession(sessionA);
    await expectComposer({ contexts: "1", shots: 1 }, "切回会话 A 后（不应重复）");
    await openSession(sessionB);
    await expectComposer({ contexts: null, shots: 0 }, "再切到会话 B");
    await openSession(sessionA);
    await expectComposer({ contexts: "1", shots: 1 }, "第二次切回会话 A（不应重复）");

    // 在 A 的输入框里移除引用：引用和截图一起撤掉，不留任何一张（含切换中多出来的）。
    await deleteLastElementToken();
    await expectComposer({ contexts: null, shots: 0 }, "在 A 移除引用后（不应留孤儿截图）");

    // 桌面输入时 ambient 块声明设计模式可用（Host 按 clientMode 注入 inputOrigin desktop，
    // 手机远控同一会话不带这一行）。A 的浏览器 tab 归属 A，A 的下一轮 sendText 会带 ambient 块。
    await sendV4Prompt('E2E_DESIGN_AMBIENT_DESKTOP: Reply with exactly "upstream-e2e-ok".');
    await waitForUpstreamRequest(
      {
        includes: [
          "E2E_DESIGN_AMBIENT_DESKTOP",
          "- The user has the in-app browser open with",
          "- Design mode: available.",
        ],
      },
      "桌面输入的上游请求里没有内置浏览器 ambient 块或「Design mode: available」",
      45_000,
    );
  });
});

async function startSessionWithOneTurn(marker: string): Promise<string> {
  await sendV4Prompt(`${marker}: Reply with exactly "upstream-e2e-ok".`);
  await waitForV4Pane(
    (snapshot) =>
      snapshot.sessionId !== "draft" &&
      !snapshot.canStop &&
      snapshot.timelineText.includes(marker) &&
      snapshot.timelineText.includes("upstream-e2e-ok"),
    `${marker} 的第一轮没有完成`,
    60_000,
  );
  const sessionId = (await getV4PaneSnapshot()).sessionId;
  if (!sessionId || sessionId === "draft") throw new Error(`${marker} 没有拿到 sessionId`);
  return sessionId;
}

async function waitForDesignToolbar(): Promise<void> {
  await $(`[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`).waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: "设计稿页面没有出现设计工具行",
  });
}

async function openSession(sessionId: string): Promise<void> {
  await clickTestIdByDom(testId(TID_TASK_ITEM, sessionId), {
    timeout: 15_000,
    timeoutMsg: `侧栏没有会话 ${sessionId}`,
  });
  await waitForV4Pane((snapshot) => snapshot.sessionId === sessionId, `没有切回会话 ${sessionId}`);
}

/**
 * 稳定 3 秒后读输入框：上下文条数（data-count，没有时 null）与 design-pin-1.png 附件张数。
 * 先等到期望值出现，再停 3 秒复读，确认不是切换过程中的瞬时值（重复附件是异步加上的）。
 */
async function expectComposer(
  expected: { contexts: string | null; shots: number },
  label: string,
): Promise<void> {
  const read = async () => ({
    contexts: (await countElementTokens()) === 0 ? null : String(await countElementTokens()),
    shots: await countAttachments(PIN_SHOT),
  });
  let last = await read();
  try {
    await browser.waitUntil(
      async () => {
        last = await read();
        return last.contexts === expected.contexts && last.shots === expected.shots;
      },
      { timeout: 15_000 },
    );
    await browser.pause(3_000);
    last = await read();
  } catch {
    // 落到下面统一报错
  }
  if (last.contexts !== expected.contexts || last.shots !== expected.shots) {
    throw new Error(
      `${label}：期望上下文 ${expected.contexts ?? "无"} 条、${PIN_SHOT} ${expected.shots} 张；实际上下文 ${last.contexts ?? "无"}、截图 ${last.shots} 张`,
    );
  }
}

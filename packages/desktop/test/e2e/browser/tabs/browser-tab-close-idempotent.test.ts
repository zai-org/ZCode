import { clearAppData } from "#e2e/helpers/desktop-app";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";
import {
  clickCloseButton,
  openFirstBrowserTab,
  readBrowserTabIds,
  waitForTabCount,
} from "#e2e/helpers/browser-side-pane";

interface CloseTabProbeResult {
  ok: boolean;
  message: string;
}

describe("Browser tab close idempotency E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BTC01: main 已经关闭逻辑 tab 后，renderer 再次请求关闭仍然成功", async function () {
    this.timeout(300000);
    await prepareConversationE2E({ skipProvider: true });

    await openFirstBrowserTab();
    const tabIds = await readBrowserTabIds();
    const tabId = tabIds[0];
    if (!tabId) throw new Error("没有成功打开 Browser tab，无法验证关闭幂等性");

    // 第一次关闭走真实 UI 路径：renderer 先向 main 申请授权，拿到授权后才移除标签。
    await clickCloseButton(tabId);
    await waitForTabCount(0);

    // Bug 回归：Agent 的 close 命令会把逻辑 tab 从 main 侧移除，而 main→renderer 的关闭通知
    // 可能因为用户已切换 workspace 而被丢弃，UI 侧仍留着一个壳。用户点 × 时 renderer 会再次
    // 向 main 申请授权，旧实现直接抛 "unavailable for renderer scope"，renderer 拿不到授权
    // 就永远不移除标签 —— tab 变成关不掉的幽灵。main 侧已无此 tab 时必须幂等放行。
    // 通知本身为什么会丢、修好之后跨 workspace 又该如何收敛，由 browser-tab-close-cross-workspace 守。
    const probe = await requestCloseTabViaIpc(tabId);
    expect(probe).toEqual({ ok: true, message: "" });
  });
});

async function requestCloseTabViaIpc(tabId: string): Promise<CloseTabProbeResult> {
  return browser.execute(async (targetTabId) => {
    const bridge = (
      window as unknown as {
        zcode?: { browserViewCloseTab?: (payload: Record<string, unknown>) => Promise<void> };
      }
    ).zcode;
    if (!bridge?.browserViewCloseTab) {
      return { ok: false, message: "preload 没有暴露 browserViewCloseTab" };
    }
    try {
      // scope 字段随便填：main 侧已经没有这个逻辑 tab，幂等放行不应再校验 owner scope。
      // 越权关闭仍然存活的 tab 由 main 单测（BTL11）守住。
      await bridge.browserViewCloseTab({
        tabId: targetTabId,
        workspaceKey: "e2e-unknown-workspace",
        sessionId: "e2e-unknown-session",
      });
      return { ok: true, message: "" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, tabId);
}

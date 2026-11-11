// 通过侧栏现有入口操作，验证真实标题投影或归档后的永久删除。
import { TID_TASK_ITEM } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4DeleteSession,
  getV4PaneSnapshot,
  getV4SessionTitle,
  prepareV4ConversationE2E,
  renameV4Session,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

async function sidebarTaskItemText(sessionId: string): Promise<string | null> {
  return browser.execute(
    (itemTestId, id) => {
      const el = document.querySelector(`[data-testid="${itemTestId}-${id}"]`);
      return el ? (el.textContent ?? "") : null;
    },
    TID_TASK_ITEM,
    sessionId,
  );
}

describe("v4 M5 ② 门禁：侧栏列表数据源 sessions-index（建→现→改名→更新→删→消失）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建会话 → 侧栏出现 → 改名 → 侧栏更新 → 删除 → 侧栏消失", async () => {
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_V4_SIDEBAR_SEED 建立会话");
    await waitForV4TimelineContaining("V4_SIDEBAR_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );
    const sessionId = (await getV4PaneSnapshot()).sessionId as string;

    // 1) 建会话 → 侧栏 task 列表出现该会话（sessions-index snapshot/upsert）。
    await browser.waitUntil(async () => (await sidebarTaskItemText(sessionId)) !== null, {
      timeout: 30000,
      timeoutMsg: "侧栏 task 列表没有出现新建会话",
    });

    // 2) 重命名 → sessions-index.title 权威 → 侧栏标题跟随更新。
    const customTitle = "E2E_V4_SIDEBAR_RENAMED";
    await renameV4Session(customTitle);
    await browser.waitUntil(async () => (await getV4SessionTitle()) === customTitle, {
      timeout: 30000,
      timeoutMsg: "会话标题没有更新为自定义值",
    });
    await browser.waitUntil(
      async () => {
        const text = await sidebarTaskItemText(sessionId);
        return text !== null && text.includes(customTitle);
      },
      { timeout: 30000, timeoutMsg: "侧栏 task 项没有跟随重命名更新标题" },
    );

    // 3) 删除 → session.removed delta → 侧栏消失。
    await clickV4DeleteSession();
    await browser.waitUntil(async () => (await sidebarTaskItemText(sessionId)) === null, {
      timeout: 30000,
      timeoutMsg: "删除后侧栏 task 项没有消失",
    });
  });
});

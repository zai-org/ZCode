// 通过侧栏现有入口操作，验证真实标题投影或归档后的永久删除。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4DeleteSession,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：deleteSession", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → 删除 → pane 回到 draft", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_DELETE_SEED 建立会话");
    await waitForV4TimelineContaining("V4_DELETE_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // 删除会话 → pane 回到 draft
    await clickV4DeleteSession();
    await waitForV4Pane((s) => s.sessionId === "draft", "删除后 pane 没有回到 draft", 30000);
  });
});

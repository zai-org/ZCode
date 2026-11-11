// 通过侧栏现有入口操作，验证真实标题投影或归档后的永久删除。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4SessionTitle,
  prepareV4ConversationE2E,
  renameV4Session,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：renameSession", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → 重命名 → 标题投影更新为自定义值", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_RENAME_SEED 建立会话");
    await waitForV4TimelineContaining("V4_RENAME_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // 侧栏右键重命名为自定义标题
    const customTitle = "E2E_V4_我的自定义会话";
    await renameV4Session(customTitle);

    // meta.title 投影更新为自定义值（custom 粘性，自动标题不再覆盖）
    await browser.waitUntil(async () => (await getV4SessionTitle()) === customTitle, {
      timeout: 30000,
      timeoutMsg: "会话标题没有更新为自定义值",
    });
    expect(await getV4SessionTitle()).toBe(customTitle);
  });
});

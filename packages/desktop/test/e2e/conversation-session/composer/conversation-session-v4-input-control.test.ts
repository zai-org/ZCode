// v4 输入控制条收口：autoDrain / followupMode 不再作为 composer 局部按钮暴露。
// followupMode 由 app 设置页 zcodeInteractionBehavior 同步到 CLI；autoDrain 保留为
// stop 后 autoDrain=false 仍是内部投影事实，用户从暂停提示条“继续”恢复消费。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4InputControlState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 输入控制条：隐藏 queue 行为局部按钮", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session 后不渲染 autoDrain/followupMode 局部按钮", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_INPUT_CONTROL_SEED 建立会话");
    await waitForV4TimelineContaining("V4_INPUT_CONTROL_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => !s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有回到空闲态",
      45000,
    );

    const state = await getV4InputControlState();
    expect(state.autoDrain).toBeNull();
    expect(state.followupMode).toBeNull();
  });
});

import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countHighspeedStatusTags,
  prepareHighspeedDrawWorkspace,
  sendHighspeedTurnAndWaitCompleted,
  waitForHighspeedComposer,
  waitForHighspeedStatusTag,
} from "#e2e/helpers/highspeed-card";

// Host Mock 场景：hit-after-timeout（draw 1.2s 后才命中，超出 1s 发送预算），见 helpers/highspeed-mock-env.ts。
describe("Highspeed card draw timeout E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-02: draw 超出 1s 预算时首轮普通发送，迟到的卡在同 Task 下一轮加速", async function () {
    this.timeout(240000);

    await prepareHighspeedDrawWorkspace();

    // 首轮按 1s fallback 普通发送，不带 Highspeed 标识；draw 在后台继续并缓存迟到的卡。
    // 不断言首轮期间输入框状态：pane 可能在卡落地后才绑定 session，经快照呈现该卡属合法展示（spec §7）。
    await sendHighspeedTurnAndWaitCompleted(
      "E2E_HIGHSPEED_DRAW_TIMEOUT_TURN_1: reply with the fixed first-turn token.",
      "hs-draw-timeout-turn-1-done",
    );
    expect(await countHighspeedStatusTags()).toBe(0);

    // 同 Task 下一轮直接消费缓存的卡：输入框进入 Highspeed，且只有这一轮带标识。
    await sendHighspeedTurnAndWaitCompleted(
      "E2E_HIGHSPEED_DRAW_TIMEOUT_TURN_2: reply with the fixed second-turn token.",
      "hs-draw-timeout-turn-2-done",
    );
    await waitForHighspeedComposer("迟到的卡没有在同 Task 下一轮让输入框进入 Highspeed");
    await waitForHighspeedStatusTag("迟到的卡加速的下一轮没有展示 Highspeed 标识");
    expect(await countHighspeedStatusTags()).toBe(1);
  });
});

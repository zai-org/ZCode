import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countHighspeedStatusTags,
  prepareHighspeedDrawWorkspace,
  sendHighspeedTurnAndWaitCompleted,
  startHighspeedComposerProbe,
  takeHighspeedComposerProbe,
} from "#e2e/helpers/highspeed-card";

// Host Mock 场景：miss（未抽中，next_draw_at = 2 分钟后），见 helpers/highspeed-mock-env.ts。
// 与 HS-E2E-01 共用准备流程，后者是资格链路的正向对照，本 case 的否定断言不会因资格缺失空转通过。
describe("Highspeed card draw miss E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-03: 未抽中与冷却期内的下一轮都普通发送，输入框不进入 Highspeed", async function () {
    this.timeout(240000);

    await prepareHighspeedDrawWorkspace();

    // 探针覆盖两轮全程：中途闪现一次 Highspeed 也会记到。
    await startHighspeedComposerProbe();
    await sendHighspeedTurnAndWaitCompleted(
      "E2E_HIGHSPEED_DRAW_MISS_TURN_1: reply with the fixed first-turn token.",
      "hs-draw-miss-turn-1-done",
    );
    // 冷却期内（now < next_draw_at）不再 draw，直接普通发送（spec §3 规则 4）。
    await sendHighspeedTurnAndWaitCompleted(
      "E2E_HIGHSPEED_DRAW_MISS_TURN_2: reply with the fixed second-turn token.",
      "hs-draw-miss-turn-2-done",
    );

    expect(await takeHighspeedComposerProbe()).toBe(false);
    expect(await countHighspeedStatusTags()).toBe(0);
  });
});

// M3 竖切出口门禁（docs/v4-refactor/08-phasing.md M3）：
// 单 pane「订阅 → 渲染 → 发送 → agent 输出中刷新恢复 → stop」全链路。
// 证据层：L3（13-golden-test-mapping —— A 组 composer 冒烟 + B 组 stop 按钮态 + 刷新恢复跨进程链路）。
// 状态语义的完整覆盖在 L1 reducer 黄金测试，这里只断言真实 UI 交互与跨进程恢复。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 竖切 M3 门禁：订阅→渲染→发送→刷新恢复→stop", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("单 pane 全链路（含 agent 输出中刷新恢复）", async () => {
    await prepareV4ConversationE2E();

    // ── 发送（draft 首发 createSession + sendText）──
    await sendV4Prompt("E2E_V4_SLICE_TURN1 请慢慢回答");

    const bound = await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
      "首发后 pane 没有绑定到新 session",
      45000,
    );
    const sessionId = bound.sessionId;

    // ── 渲染：用户行 + assistant 流式行 ──
    await waitForV4TimelineContaining("E2E_V4_SLICE_TURN1");
    await waitForV4TimelineContaining("V4_TURN1_STREAMING", 45000);
    await waitForV4Pane((snapshot) => snapshot.canStop, "streaming 中没有出现 stop 按钮");

    // ── agent 输出中刷新（M3 门禁核心：renderer 重载，CLI/host 继续跑）──
    await browser.refresh();

    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId,
      "刷新后 pane 没有恢复到原 session",
      60000,
    );
    // 恢复裁决 snapshot + 续流：历史行 + 完流文本都必须出现
    await waitForV4TimelineContaining("E2E_V4_SLICE_TURN1", 30000);
    await waitForV4TimelineContaining("V4_TURN1_DONE", 60000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "turn1 完流后 stop 按钮没有回收");

    // ── stop：turn2 长尾慢流窗口内点 stop ──
    await sendV4Prompt("E2E_V4_SLICE_TURN2 保持输出");
    await waitForV4TimelineContaining("V4_TURN2_STREAMING", 45000);
    await waitForV4Pane((snapshot) => snapshot.canStop, "turn2 streaming 中没有出现 stop 按钮");
    await clickV4Stop();
    await waitForV4Pane((snapshot) => !snapshot.canStop, "stop 后 canStop 没有回收", 30000);

    // 已流出的部分文本保留（中断不清空 timeline）
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.timelineText).toContain("V4_TURN2_STREAMING");
    expect(finalSnapshot.sessionId).toBe(sessionId);
  });
});

// M4 门禁：sendQueuedNow（catalog B 组）。
// 证据层 L3：running turn 期间入队一项 → 点「立即发送」→ sendQueuedNow 命令 →
// v4-bridge：读原文 → 从 queue 移除 → stop 当前 turn → 以原文重发（stop barrier）→
// 该项以新 turn 消费，回复出现。证明 stop-barrier + 立即消费全链路。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4QueueItemSendNow,
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：sendQueuedNow", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中入队 → 立即发送 → stop 当前 + 该项以新 turn 消费", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_SENDNOW_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_SENDNOW_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await sendV4Prompt("E2E_V4_SENDNOW_ITEM 立即发我");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    const queueItemId = before[0]!.queueItemId;

    // 立即发送该队列项 → stop 当前 + 消费该项
    const clicked = await clickV4QueueItemSendNow(queueItemId);
    expect(clicked).toBe(true);

    // 队列清空（该项被消费）+ 该项回复出现
    await waitForV4QueueCount(0, 30000);
    await waitForV4TimelineContaining("V4_SENDNOW_ITEM_REPLY", 60000);
    expect(await getV4QueueItems()).toHaveLength(0);
  });
});

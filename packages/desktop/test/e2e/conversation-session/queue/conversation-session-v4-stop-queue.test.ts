// catalog B02/B04（stopKeepsQueueAndDisablesAutoDrain）+ B06（暂停队列发送确认）
// + B08（sendQueuedPromptNow）+ B14/B15（暂停队列继续）验收。
// 证据层 L3：running 中入队 → stop → queue 原样保留并显示暂停提示；正常发送按钮
// 打开 modal 后执行 keep/clear；idle 继续按 FIFO 到空；running 继续只武装、不抢占。
// 语料来源：manual-review/pending 的 stop-held-queue（B02-B04）/ interrupted-actions 语义移植。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4PausedQueueResume,
  clickV4QueueItemSendNow,
  clickV4Stop,
  getV4QueueItems,
  hasV4PausedQueueBanner,
  hasV4PausedQueueSendDialog,
  prepareV4ConversationE2E,
  sendV4PausedQueueClear,
  sendV4PausedQueueKeep,
  sendV4Prompt,
  waitForV4PausedQueueBanner,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

/** 建立「running 慢流 + 入队 N 条 → stop」的 held 前置状态。 */
async function setupHeldQueue(queueTexts: string[]) {
  await prepareV4ConversationE2E();
  await sendV4Prompt("E2E_V4_HELD_SLOW 慢慢回答这个问题");
  await waitForV4TimelineContaining("V4_HELD_STREAMING", 45000);
  await waitForV4Pane(
    (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
    "首轮没有进入 running（canStop）",
    45000,
  );
  for (let i = 0; i < queueTexts.length; i++) {
    await sendV4Prompt(queueTexts[i]!);
    await waitForV4QueueCount(i + 1, 30000);
  }
  await clickV4Stop();
  await waitForV4Pane((s) => !s.canStop, "stop 后没有退出 running（canStop 仍在）", 30000);
}

describe("v4 catalog B 组：stop 后暂停队列、发送确认与继续消费", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("B02/B04：stop 后 queue 原样保留、autoDrain=false，并显示暂停提示", async () => {
    await setupHeldQueue(["E2E_V4_HELD_Q1 排队的第一条", "E2E_V4_HELD_Q2 排队的第二条"]);

    // queue=2 原样保留（不被 stop 丢弃）
    const items = await getV4QueueItems();
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toContain("E2E_V4_HELD_Q1");
    expect(items[1]!.text).toContain("E2E_V4_HELD_Q2");

    // 不自动消费：等 3s 后 queue 仍为 2，且 Q1 回复未出现
    await browser.pause(3000);
    const after = await getV4QueueItems();
    expect(after).toHaveLength(2);
    const snapshot = await waitForV4Pane(() => true, "读取快照失败", 5000);
    expect(snapshot.timelineText).not.toContain("V4_HELD_Q1_REPLY");

    await waitForV4PausedQueueBanner(15000);
    expect(await hasV4PausedQueueSendDialog()).toBe(false);
  });

  it("B06：正常发送按钮打开 modal；keep 保留队列发送，clear 清空队列发送", async () => {
    await setupHeldQueue(["E2E_V4_HELD_Q1 排队的第一条"]);
    await waitForV4PausedQueueBanner(15000);

    // keep：正常发送按钮先打开 modal；确认后新文本立即发送，queue 原样保留。
    await sendV4PausedQueueKeep("E2E_V4_HELD_KEEP 保留队列直接问");
    await waitForV4TimelineContaining("V4_HELD_KEEP_REPLY", 45000);
    await waitForV4Pane((s) => !s.canStop, "keep 发送后没有回到 idle", 30000);
    expect(await getV4QueueItems()).toHaveLength(1);

    // 回到 idle 后仍为暂停队列，提示条继续存在。
    await waitForV4PausedQueueBanner(15000);

    // clear：再次从正常发送按钮进入 modal，清空旧 queue 后发送新文本。
    await sendV4PausedQueueClear("E2E_V4_HELD_CLEAR 清空队列再问");
    await waitForV4TimelineContaining("V4_HELD_CLEAR_REPLY", 45000);
    await waitForV4QueueCount(0, 15000);
    await waitForV4Pane((s) => !s.canStop, "clear 发送后没有回到 idle", 30000);

    // queue 清空后暂停提示与确认 modal 都退出。
    await browser.waitUntil(
      async () => !(await hasV4PausedQueueBanner()) && !(await hasV4PausedQueueSendDialog()),
      { timeout: 15000, timeoutMsg: "queue 清空后暂停提示或确认 modal 仍然存在" },
    );
    // 被清空的 Q1 不应被消费
    const snapshot = await waitForV4Pane(() => true, "读取快照失败", 5000);
    expect(snapshot.timelineText).not.toContain("V4_HELD_Q1_REPLY");
  });

  it("B14：idle 暂停队列点继续后按 Q1/Q2 FIFO 自动消费到空", async () => {
    await setupHeldQueue(["E2E_V4_HELD_Q1 排队的第一条", "E2E_V4_HELD_Q2 排队的第二条"]);
    await waitForV4PausedQueueBanner(15000);

    await clickV4PausedQueueResume();
    await waitForV4TimelineContaining("V4_HELD_Q1_REPLY", 45000);
    await waitForV4TimelineContaining("V4_HELD_Q2_REPLY", 45000);
    await waitForV4QueueCount(0, 15000);
    await waitForV4Pane((s) => !s.canStop, "继续消费后没有回到 idle", 30000);

    const snapshot = await waitForV4Pane(() => true, "读取 FIFO 终态失败", 5000);
    expect(snapshot.timelineText.indexOf("V4_HELD_Q1_REPLY")).toBeGreaterThanOrEqual(0);
    expect(snapshot.timelineText.indexOf("V4_HELD_Q2_REPLY")).toBeGreaterThan(
      snapshot.timelineText.indexOf("V4_HELD_Q1_REPLY"),
    );
    expect(await hasV4PausedQueueBanner()).toBe(false);
  });

  it("B15：running 中点继续只武装，当前流收口后才消费暂停队首", async () => {
    await setupHeldQueue(["E2E_V4_HELD_Q1 排队的第一条"]);

    await sendV4PausedQueueKeep("E2E_V4_HELD_KEEP 保留队列并保持慢流");
    await waitForV4TimelineContaining("V4_HELD_KEEP_STREAMING", 30000);
    await waitForV4Pane((s) => s.canStop, "keep-and-send 没有进入 running", 15000);

    await clickV4PausedQueueResume();
    await browser.waitUntil(async () => !(await hasV4PausedQueueBanner()), {
      timeout: 15000,
      timeoutMsg: "点继续后暂停提示没有退出",
    });
    await browser.pause(500);
    expect(await getV4QueueItems()).toHaveLength(1);
    const armedSnapshot = await waitForV4Pane(
      (s) => s.canStop,
      "点继续后当前 running 被意外抢占",
      5000,
    );
    expect(armedSnapshot.timelineText).not.toContain("V4_HELD_Q1_REPLY");

    await waitForV4TimelineContaining("V4_HELD_KEEP_REPLY", 45000);
    await waitForV4TimelineContaining("V4_HELD_Q1_REPLY", 45000);
    await waitForV4QueueCount(0, 15000);
    await waitForV4Pane((s) => !s.canStop, "armed drain 后没有回到 idle", 30000);

    const finalSnapshot = await waitForV4Pane(() => true, "读取 armed drain 终态失败", 5000);
    expect(finalSnapshot.timelineText.indexOf("V4_HELD_Q1_REPLY")).toBeGreaterThan(
      finalSnapshot.timelineText.indexOf("V4_HELD_KEEP_REPLY"),
    );
  });

  it("B08：held 队列项「立即发送」→ 该项出队并以新 turn 消费", async () => {
    await setupHeldQueue(["E2E_V4_HELD_Q1 排队的第一条"]);

    const items = await getV4QueueItems();
    expect(items).toHaveLength(1);
    const clicked = await clickV4QueueItemSendNow(items[0]!.queueItemId);
    expect(clicked).toBe(true);

    // 该项被消费：queue 清空 + 回复出现（不残留、不重复）
    await waitForV4TimelineContaining("V4_HELD_Q1_REPLY", 45000);
    await waitForV4QueueCount(0, 15000);
    await waitForV4Pane((s) => !s.canStop, "send-now 后没有回到 idle", 30000);
    expect(await getV4QueueItems()).toHaveLength(0);
  });
});

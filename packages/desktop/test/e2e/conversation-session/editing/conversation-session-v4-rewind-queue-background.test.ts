// PV4-20/PV4-23：compact 期间 held queue 在 edit 后保持；被裁 turn 的后台 Bash 先取消再 bump generation。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequests,
  countUpstreamRequestsContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  clickV4Stop,
  clickV4QueueItemSendNow,
  describeV4BackgroundFailureState,
  editFirstV4UserQuery,
  getV4BackgroundWorks,
  getV4PaneSnapshot,
  getV4QueueItems,
  openV4RunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4CompactMarker,
  waitForV4Edit,
  waitForV4Pane,
  waitForV4PausedQueueBanner,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("PV4-20/PV4-23 rewind queue and background fencing", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PV4-20 edit 保留 held queue，再按原 ID/顺序各消费一次", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_PV4_20_ORIGINAL compact 前的 latest query");
    await waitForV4TimelineContaining("PV4_20_ORIGINAL_REPLY", 60000);

    // Bug 根因：autoDrain 局部按钮已从产品 UI 删除，旧 case 在 draft 上点击一个已不存在
    // 的 testid，并没有建立 held queue。当前可达路径是先中断一次 compact，把两个 future
    // intent 与第二个 compact 一起 held，再 send-now 第二个 compact 覆盖 latest query。
    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "running" }, 60000);
    await sendV4Prompt("E2E_PV4_20_QUEUE_ONE 队列第一项");
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt("E2E_PV4_20_QUEUE_TWO 队列第二项");
    await waitForV4QueueCount(2, 30000);

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "PV4-20 stop 第二次 compact 后没有回到 idle",
      30000,
    );
    await waitForV4PausedQueueBanner(15000);
    // compactActive 时第二个 compact 按 operation lock 会被拒绝；stop 后在 held 状态
    // 提交才会按当前产品规则追加队尾，再由 send-now 只取出这一项。
    await sendV4Prompt("/compact");
    await waitForV4QueueCount(3, 30000);
    const queued = await getV4QueueItems();
    expect(queued.slice(0, 2).map((item) => item.text)).toEqual([
      expect.stringContaining("E2E_PV4_20_QUEUE_ONE"),
      expect.stringContaining("E2E_PV4_20_QUEUE_TWO"),
    ]);
    expect(await clickV4QueueItemSendNow(queued[2]!.queueItemId)).toBe(true);
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
    await waitForV4QueueCount(2, 30000);
    const before = await getV4QueueItems();
    expect(before).toEqual(queued.slice(0, 2));
    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_PV4_20_EDITED 保留 held queue 重发");
    await waitForV4TimelineContaining("PV4_20_EDITED_REPLY", 60000);

    const after = await getV4QueueItems();
    expect(after).toEqual(before);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain("PV4_20_ORIGINAL_REPLY");
    expect(await countUpstreamRequestsContaining("E2E_PV4_20_EDITED")).toBe(1);

    expect(await clickV4QueueItemSendNow(before[0]!.queueItemId)).toBe(true);
    await waitForV4TimelineContaining("PV4_20_QUEUE_ONE_REPLY", 60000);
    await waitForV4QueueCount(1, 30000);
    expect((await getV4QueueItems())[0]?.queueItemId).toBe(before[1]!.queueItemId);
    expect(await clickV4QueueItemSendNow(before[1]!.queueItemId)).toBe(true);
    await waitForV4TimelineContaining("PV4_20_QUEUE_TWO_REPLY", 60000);
    await waitForV4QueueCount(0, 30000);
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: ["E2E_PV4_20_QUEUE_ONE"],
      }),
    ).toBe(1);
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: ["E2E_PV4_20_QUEUE_TWO"],
      }),
    ).toBe(1);
  });

  it("PV4-23 edit 前取消被裁 turn 的后台 Bash，新分支只启动一次", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");

    await sendV4Prompt("E2E_PV4_23_BACKGROUND_ORIGINAL 启动后台 Bash");
    try {
      await waitForV4TimelineContaining("PV4_23_BACKGROUND_ORIGINAL_REPLY", 90000);
    } catch (error) {
      throw new Error(
        `PV4-23 原 turn 没有出现后台 Bash 跟进回复: ${await describeV4BackgroundFailureState()}`,
        { cause: error },
      );
    }
    await openV4RunningBackgroundWorks(60000);
    const running = (await getV4BackgroundWorks()).find((work) => work.status === "running");
    expect(running?.workId).toBeTruthy();

    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_PV4_23_BACKGROUND_EDITED 取消旧后台后重发");
    await waitForV4TimelineContaining("PV4_23_BACKGROUND_EDITED_REPLY", 90000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "PV4-23 edit 后没有回到 idle", 60000);

    await browser.waitUntil(
      async () => !(await getV4BackgroundWorks()).some((work) => work.workId === running?.workId),
      {
        timeout: 60000,
        timeoutMsg: "PV4-23 被裁 turn 的后台 Bash 仍在 running 列表",
      },
    );
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.timelineText).not.toContain("PV4_23_BACKGROUND_ORIGINAL_REPLY");
    expect(await countUpstreamRequestsContaining("E2E_PV4_23_BACKGROUND_EDITED")).toBe(1);
  });
});

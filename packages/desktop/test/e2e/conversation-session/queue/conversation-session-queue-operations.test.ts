import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ComposerText,
  setV4ComposerText,
  dragV4QueueItemOnto,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  clickQueueRemove,
  getQueueItems,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import {
  getV4QueueItemEditLock,
  openV4QueueItemEditInComposer,
  waitForV4ComposerEditClosed,
  waitForV4QueueItemEditLock,
} from "#e2e/helpers/v4-composer-edit";

describe("会话区 Held Queue 操作 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("held queue 编辑原位冻结，重排和删除其他项保留编辑内容，提交原地替换且不触发模型请求", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const runningPrompt = `E2E_SLOW_STREAM E2E_QUEUE_OPS_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "held queue 操作首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "held queue 操作首轮没有进入 streaming",
      30000,
    );

    const firstQueuedPrompt = `E2E_QUEUE_OPS_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const secondQueuedPrompt = `E2E_QUEUE_OPS_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const thirdQueuedPrompt = `E2E_QUEUE_OPS_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(firstQueuedPrompt);
    await waitForQueueCount(1);
    await sendV4Prompt(secondQueuedPrompt);
    await waitForQueueCount(2);
    await sendV4Prompt(thirdQueuedPrompt);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.content)).toEqual([
      firstQueuedPrompt,
      secondQueuedPrompt,
      thirdQueuedPrompt,
    ]);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      "held queue 操作 stop 后没有保留 3 条队列",
      30000,
    );

    queue = await getQueueItems();
    const firstId = queue[0]?.id;
    const secondId = queue[1]?.id;
    const thirdId = queue[2]?.id;
    if (!firstId || !secondId || !thirdId) {
      throw new Error(`队列项 id 缺失: ${JSON.stringify(queue)}`);
    }

    const editedSecondPrompt = `E2E_QUEUE_OPS_SECOND_EDITED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const editedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`,
    );
    // 编辑时队列项原位冻结（docs/ui/composer-edit-mode.md），composer 载入原文。
    await openV4QueueItemEditInComposer(secondId);
    await waitForV4ComposerText(secondQueuedPrompt, "编辑态没有载入原文");
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.id)).toEqual([firstId, secondId, thirdId]);
    // 编辑态在 lock ACK 后进入；editLock 随后经投影到达，需等待而不是读一次。
    await waitForV4QueueItemEditLock(secondId, (state) => state.locked, "编辑项没有显示编辑锁");
    await setV4ComposerText(editedSecondPrompt);
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_SECOND_EDITED_${runId}`)).toBe(
      editedRequestsBefore,
    );

    // 冻结项之外的项仍可重排；编辑内容不受影响。
    await dragV4QueueItemOnto(thirdId, firstId);
    queue = await waitForQueueOrderContaining(
      [`E2E_QUEUE_OPS_THIRD_${runId}`, `E2E_QUEUE_OPS_FIRST_${runId}`],
      "重排队列项后没有只改变 queue 顺序",
    );
    expect(queue.map((item) => item.id)).toEqual([thirdId, firstId, secondId]);
    expect(await getV4ComposerText()).toBe(editedSecondPrompt);

    const removedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    await clickQueueRemove(firstId);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect(queue.map((item) => item.content).join("\n")).not.toContain(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    expect(await getV4ComposerText()).toBe(editedSecondPrompt);
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_FIRST_${runId}`)).toBe(
      removedRequestsBefore,
    );

    // 提交编辑：原地替换 second，ID 与位置不变；held queue 下不触发消费。
    await sendV4Prompt(editedSecondPrompt);
    await waitForV4ComposerEditClosed("held queue 编辑提交后没有退出编辑态", 30000);
    queue = await waitForQueueOrderContaining(
      [`E2E_QUEUE_OPS_THIRD_${runId}`, `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`],
      "编辑提交后队列项没有原地替换",
    );
    expect(queue.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect((await getV4QueueItemEditLock(secondId)).locked).toBe(false);
    await waitForV4ComposerText("", "编辑提交后没有恢复原草稿（空）");
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_SECOND_EDITED_${runId}`)).toBe(
      editedRequestsBefore,
    );
  });
});

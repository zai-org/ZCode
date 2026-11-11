import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4QueueAutoDrain,
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4PausedQueueSendDialog,
  waitForV4ConversationState,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  clickFirstQueueSendNow,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
} from "#e2e/helpers/conversation-session-network";

describe("会话区 Stop 与 Held Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("stop 后应保留 queue 且默认不自动消费，立即发送才触发下一轮", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const firstPrompt = `E2E_SLOW_STREAM E2E_STOP_HELD_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(firstPrompt);
    await waitForV4ComposerText("", "首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "首轮发送后 chat-view 没有进入 streaming",
      30000,
    );

    // running 投影早于首个模型 delta；先等真实回答，避免把首发取消当作流中断。
    await waitForV4AssistantMessageContaining("deep");

    const queuedPrompt = `E2E_STOP_HELD_QUEUE_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(queuedPrompt);
    await waitForQueueContaining(`E2E_STOP_HELD_QUEUE_FIRST_${runId}`);
    await waitForQueueCount(1);

    const secondQueuedPrompt = `E2E_STOP_HELD_QUEUE_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(secondQueuedPrompt);
    await waitForQueueContaining(`E2E_STOP_HELD_QUEUE_SECOND_${runId}`);
    await waitForQueueCount(2);

    const thirdQueuedPrompt = `E2E_STOP_HELD_QUEUE_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(thirdQueuedPrompt);
    await waitForQueueContaining(`E2E_STOP_HELD_QUEUE_THIRD_${runId}`);
    await waitForQueueCount(3);

    // V4 的 Stop 控件和队列/目标投影是当前状态来源；旧 runtimeStatus 已不再写入。
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      // 修复原因：stop ACK 早于 task terminal 投影时，后续队列断言会撞上
      // 仍在收尾的 runtime，误判成 held queue 被自动消费或丢失。
      "stop 后没有退出 streaming 并保留 3 条 queue",
      30000,
    );
    await expectNoUpstreamRequestForTextWithin(`E2E_STOP_HELD_QUEUE_FIRST_${runId}`, 900);

    const appendedPrompt = `E2E_STOP_HELD_QUEUE_APPEND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const appendedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_STOP_HELD_QUEUE_APPEND_${runId}`,
    );
    await sendV4Prompt(appendedPrompt);
    // B06：暂停队列下普通发送先确认；取消必须保留草稿和原队列。
    await waitForV4PausedQueueSendDialog();
    await browser.keys("Escape");
    await waitForV4ComposerText(appendedPrompt, "取消确认后草稿丢失");
    await waitForQueueCount(3);
    await expectNoUpstreamRequestForTextWithin(`E2E_STOP_HELD_QUEUE_APPEND_${runId}`, 900);
    expect(await countUpstreamRequestsContaining(`E2E_STOP_HELD_QUEUE_APPEND_${runId}`)).toBe(
      appendedRequestsBefore,
    );

    await setV4ComposerText("");
    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.content).toContain(`E2E_STOP_HELD_QUEUE_FIRST_${runId}`);
    // 修复原因：仅观察请求出现和出队会把 fixture 缺失的 500 当成成功；
    // B08 必须证明显式发送成功收口，并且没有恢复其余暂停项的自动消费。
    const sentRequest = await waitForUpstreamNetworkCapture(`E2E_STOP_HELD_QUEUE_FIRST_${runId}`);
    expect(sentRequest.statusCode).toBe(200);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 2,
      "立即发送没有完成，或意外消费了其余暂停项",
    );
    expect(await getV4QueueAutoDrain()).toBe(false);
    const remainingItems = await getV4QueueItems();
    expect(remainingItems.map((item) => item.text)).toEqual([
      expect.stringContaining(`E2E_STOP_HELD_QUEUE_SECOND_${runId}`),
      expect.stringContaining(`E2E_STOP_HELD_QUEUE_THIRD_${runId}`),
    ]);
    expect(await countUpstreamRequestsContaining(`E2E_STOP_HELD_QUEUE_SECOND_${runId}`)).toBe(0);
    expect(await countUpstreamRequestsContaining(`E2E_STOP_HELD_QUEUE_THIRD_${runId}`)).toBe(0);
  });
});

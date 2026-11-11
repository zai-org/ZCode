import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  E2E_REPLY_TOKEN,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";

describe("会话区 Auto Drain E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 正常完成后应自动消费队首 queued prompt", async function () {
    this.timeout(90000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const runningPrompt = `E2E_AUTO_DRAIN_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "首轮 auto-drain prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining(runningPrompt);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "首轮 auto-drain prompt 没有进入 streaming",
      30000,
    );
    // 先确认主请求已输出正文，避免标题生成的短暂 running 被误当成可入队的首轮。
    await waitForV4AssistantMessageContaining("upstream-");

    const queuedPrompt = `E2E_AUTO_DRAIN_QUEUED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(queuedPrompt);
    await waitForV4ComposerText("", "running 中 queued prompt 发送后输入框没有清空");
    await waitForQueueContaining(`E2E_AUTO_DRAIN_QUEUED_${runId}`);
    const queuedItems = await waitForQueueCount(1);
    expect(queuedItems[0]?.kind).toBe("text");
    expect(queuedItems[0]?.content).toContain(`E2E_AUTO_DRAIN_QUEUED_${runId}`);

    await releaseControlledReplay("upstream-auto-drain-running-controlled-stream");
    await waitForUpstreamNetworkCapture(`E2E_AUTO_DRAIN_QUEUED_${runId}`);
    await waitForV4UserMessageContaining(queuedPrompt);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "首轮完成后没有自动消费 queued prompt 并清空 queue",
      90000,
    );

    expect(await getQueueItems()).toHaveLength(0);
    const assistantMessages = await getV4Messages("assistant");
    expect(
      assistantMessages.filter((message) => message.text.includes(E2E_REPLY_TOKEN)),
    ).toHaveLength(2);
  });
});

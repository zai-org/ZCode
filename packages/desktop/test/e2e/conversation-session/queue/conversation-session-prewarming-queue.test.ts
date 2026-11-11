import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { waitForQueueContaining, waitForQueueCount } from "#e2e/helpers/conversation-session-queue";

describe("会话区 Prewarming Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("A02: prewarming 中继续发普通文本应进入 queue 且不打断首轮", async function () {
    this.timeout(90000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const firstMarker = `E2E_PREWARMING_FIRST_${runId}`;
    const queuedMarker = `E2E_PREWARMING_QUEUED_${runId}`;
    const firstPrompt = `E2E_PREWARMING_DELAY ${firstMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const queuedPrompt = `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(firstPrompt);
    await waitForV4ComposerText("", "prewarming 首轮发送后输入框没有清空");
    await waitForV4UserMessageContaining(firstPrompt);
    await waitForUpstreamRequestContaining(firstMarker);
    const prewarmingSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        snapshot.queueCount === 0 &&
        (snapshot.state === "submitting" || snapshot.state === "streaming"),
      "首轮发送后没有进入 prewarming/running 窗口",
      10000,
    );
    expect(prewarmingSnapshot.queueCount).toBe(0);

    await sendV4Prompt(queuedPrompt);
    await waitForV4ComposerText("", "prewarming 中第二条发送后输入框没有清空");
    await waitForQueueContaining(queuedMarker);
    const queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");
    expect(queue[0]?.content).toContain(queuedMarker);
    await assertVisibleV4UserMessagesNotContaining(queuedPrompt);
    await expectNoUpstreamRequestForTextWithin(queuedMarker, 750);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "submitting" &&
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 1,
      "停止 prewarming 首轮后没有保留 queued prompt",
      30000,
    );
  });
});

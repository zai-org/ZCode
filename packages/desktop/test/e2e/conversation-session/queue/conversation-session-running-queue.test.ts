import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  clickV4Send,
  clickV4Stop,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
} from "#e2e/helpers/conversation-session-network";
import {
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";

describe("会话区 Running Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中 text、compact、goal 按提交顺序入队，不启动并行请求", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const firstPrompt = `E2E_SLOW_STREAM E2E_RUNNING_QUEUE_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(firstPrompt);
    await waitForV4ComposerText("", "首轮发送后输入框没有清空");
    await waitForV4UserMessageContaining(firstPrompt);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "首轮发送后 chat-view 没有进入 streaming",
      30000,
    );

    const secondPrompt = `E2E_RUNNING_QUEUE_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(secondPrompt);
    await waitForV4ComposerText("", "running 中第二条发送后输入框没有清空");
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_SECOND_${runId}`);
    let queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");

    const thirdPrompt = `E2E_RUNNING_QUEUE_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(thirdPrompt);
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_THIRD_${runId}`);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_SECOND_${runId}`,
    );
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_THIRD_${runId}`,
    );

    const fourthPrompt = `E2E_RUNNING_QUEUE_FOURTH_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(fourthPrompt);
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_FOURTH_${runId}`);
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_FOURTH_${runId}`,
    );
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "text"]);

    const fifthPrompt = `E2E_RUNNING_QUEUE_FIFTH_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(fifthPrompt);
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_FIFTH_${runId}`);
    queue = await waitForQueueCount(4);
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_FIFTH_${runId}`,
    );
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "text", "text"]);

    const compactRequestsBefore = await countUpstreamRequestsContaining(
      "CRITICAL: Respond with TEXT ONLY",
    );
    await setV4ComposerText("/compact");
    await clickV4Send();
    await expectNoUpstreamRequestForTextWithin("CRITICAL: Respond with TEXT ONLY", 500);
    expect(await countUpstreamRequestsContaining("CRITICAL: Respond with TEXT ONLY")).toBe(
      compactRequestsBefore,
    );
    // 原因：M04/M05 当前合同是 compact 维护项入 FIFO，旧用例仍要求拒绝。
    queue = await waitForQueueCount(5);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "text", "text", "compact"]);
    await assertVisibleV4UserMessagesNotContaining("/compact");

    const goalPrompt = `/goal E2E_RUNNING_QUEUE_GOAL_${runId}`;
    await sendV4Prompt(goalPrompt);
    await browser.waitUntil(
      async () => {
        queue = await getQueueItems();
        const queueContent = queue.map((item) => item.content).join("\n");
        return (
          queueContent.includes(`E2E_RUNNING_QUEUE_SECOND_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_THIRD_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_FOURTH_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_FIFTH_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_GOAL_${runId}`)
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "队列没有同时保留 running 中发送的普通消息和 /goal",
      },
    );
    const goalItem = queue.find((item) => item.content.includes(`E2E_RUNNING_QUEUE_GOAL_${runId}`));
    expect(goalItem?.kind).toBe("goal");
    expect(queue.map((item) => item.kind)).toEqual([
      "text",
      "text",
      "text",
      "text",
      "compact",
      "goal",
    ]);

    await browser.waitUntil(
      async () => (await countUpstreamRequestsContaining(`E2E_RUNNING_QUEUE_FIRST_${runId}`)) >= 1,
      {
        timeout: 10000,
        timeoutMsg: "没有捕获到首轮 running 请求",
      },
    );
    await clickV4Stop();
    await waitForQueueCount(6);
  });
});

import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  waitForV4CompactMarker,
  waitForV4AssistantMessageContaining,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Send,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequestsContainingAll,
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { getQueueItems, type QueueItemSnapshot } from "#e2e/helpers/conversation-session-queue";

const ACTION_MARKER = "E2E_AUTO_ACTIONS";
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

describe("会话区 Auto Compact Actions E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("auto compacting 中普通文本和 /goal 入队，重复 /compact 被拒绝；compact 完成后继续消费 queue", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    // 当前 planner 保留最近一轮；仅一轮历史没有可压缩分区，必须先完成两轮。
    for (const phase of ["WARMUP", "READY"]) {
      const seedPrompt = `${ACTION_MARKER}_CONTEXT_SEED_${phase}_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
      await sendV4Prompt(seedPrompt);
      await waitForV4ComposerText("", "auto compact seed 发送后输入框未清空");
      await waitForUpstreamRequestContaining(`${ACTION_MARKER}_CONTEXT_SEED_${phase}_${runId}`);
      await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
      await waitForV4ConversationState(
        (state) => state.state === "idle" && state.queueCount === 0,
        "auto compact seed 未完成",
        90000,
      );
    }

    const compactRequestsBefore = await countUpstreamRequestsContainingAll([
      COMPACT_REQUEST_SENTINEL,
      ACTION_MARKER,
    ]);
    const pendingPrompt = `${ACTION_MARKER}_PENDING_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(pendingPrompt);
    await waitForV4ComposerText("", "auto compact actions pending 文本发送后输入框没有清空");
    await waitForV4UserMessageContaining(pendingPrompt);
    // 以真实摘要请求建立 compacting 窗口，流保持挂起；不能因 skipped 提前返回并漏测动作。

    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContainingAll([COMPACT_REQUEST_SENTINEL, ACTION_MARKER])) ===
        compactRequestsBefore + 1,
      {
        timeout: 30000,
        timeoutMsg: "auto compact actions 没有捕获到自动 compact 请求",
      },
    );

    await setV4ComposerText("/compact");
    await clickV4Send();
    await waitForV4ComposerText("", "auto compacting 中重复 /compact 后输入框没有清空");
    await expectNoUpstreamRequestForTextWithin(COMPACT_REQUEST_SENTINEL, 800);
    expect(
      await countUpstreamRequestsContainingAll([COMPACT_REQUEST_SENTINEL, ACTION_MARKER]),
    ).toBe(compactRequestsBefore + 1);
    await assertVisibleV4UserMessagesNotContaining("/compact");

    const queuedTextPrompt = `${ACTION_MARKER}_QUEUED_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(queuedTextPrompt);
    await waitForV4ComposerText("", "auto compacting 中普通文本发送后输入框没有清空");
    const queuedText = await waitForQueueItemContaining(`${ACTION_MARKER}_QUEUED_TEXT_${runId}`);
    expect(queuedText.kind).toBe("text");

    const queuedGoalMarker = `${ACTION_MARKER}_QUEUED_GOAL_${runId}`;
    const queuedGoalPrompt = `/goal ${queuedGoalMarker}`;
    await sendV4Prompt(queuedGoalPrompt);
    await waitForV4ComposerText("", "auto compacting 中 /goal 发送后输入框没有清空");
    const queuedGoal = await waitForQueueItemContaining(`${ACTION_MARKER}_QUEUED_GOAL_${runId}`);
    expect(queuedGoal.kind).toBe("goal");
    expect(
      await countUpstreamRequestsContainingAll([COMPACT_REQUEST_SENTINEL, ACTION_MARKER]),
    ).toBe(compactRequestsBefore + 1);

    // auto compact 成功后应先继续原 pendingAction，再继续消费 compacting 期间追加的 future queue；
    // 录制轨迹不能停在 queue 仍挂起的中间态，否则人工 review 看不到正常收尾。
    await releaseControlledReplay("upstream-auto-actions-compact-slow");
    await waitForV4CompactMarker({ origin: "auto", status: "success" });
    await waitForMainModelRequest(`${ACTION_MARKER}_PENDING_TEXT_${runId}`);
    await waitForMainModelRequest(`${ACTION_MARKER}_QUEUED_TEXT_${runId}`);
    await waitForV4UserMessageContaining(queuedTextPrompt);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state === "idle" &&
        snapshot.queueCount === 0 &&
        (snapshot.targetObjective ?? "").includes(queuedGoalMarker),
      "auto compact 完成后没有继续消费 pendingAction 和 compacting 期间追加的 text/goal queue",
      120000,
    );
  });
});

async function waitForMainModelRequest(marker: string) {
  await waitForUpstreamRequest(
    {
      excludes: [COMPACT_REQUEST_SENTINEL],
      includes: [marker],
    },
    `auto compact 后没有继续发起主模型请求: ${marker}`,
    90000,
  );
}

async function waitForQueueItemContaining(text: string): Promise<QueueItemSnapshot> {
  let latest: QueueItemSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await getQueueItems();
      return latest.some((item) => item.content.includes(text));
    },
    {
      timeout: 30000,
      timeoutMsg: `队列中没有出现 ${text}; latest=${JSON.stringify(latest)}`,
    },
  );
  const item = latest.find((candidate) => candidate.content.includes(text));
  if (!item) {
    throw new Error(`队列项 ${text} 在等待后仍不存在`);
  }
  return item;
}

import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
} from "#e2e/helpers/conversation-session-network";
import { waitForQueueContaining, waitForQueueCount } from "#e2e/helpers/conversation-session-queue";

describe("会话区 Goal E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed 下 /goal 设置和更新；running 入队，held 显式选择后保留队列发送", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const firstGoalObjective = `E2E_GOAL_SET_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const firstGoal = `/goal ${firstGoalObjective}`;
    await sendV4Prompt(firstGoal);
    await waitForV4ComposerText("", "首个 /goal 发送后输入框没有清空");
    await waitForV4UserMessageContaining(firstGoalObjective);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.queueCount === 0 &&
        snapshot.targetStatus === "active" &&
        snapshot.targetObjective?.includes(`E2E_GOAL_SET_${runId}`) === true,
      "首个 /goal 没有设置 active target",
      90000,
    );
    const firstGoalStreaming = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "首个 /goal 设置后没有进入目标验证/继续运行",
      30000,
    );
    expect(firstGoalStreaming.targetStatus).toBe("active");
    expect(firstGoalStreaming.targetStatus).not.toBe("validating");
    await expectNoGoalValidatingLockForWindow(firstGoalStreaming);
    await assertVisibleV4UserMessagesNotContaining("goal-continuation");
    await assertVisibleV4UserMessagesNotContaining("Current session goal state");
    const firstGoalCompletedSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.activeInputId === null &&
        !snapshot.stopRequested &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(`E2E_GOAL_SET_${runId}`) === true &&
        isCompletedTargetStatus(snapshot.targetStatus),
      // 修复原因：GL/H02 验证 completed 下已有 goal 再更新；旧 case 通过 stop
      // 制造空闲态，但 stop 后 runtime activeInputId 会短暂保留，下一条 /goal 容易被当成 queue。
      "首个 /goal 没有通过 verifier 自然进入完成态",
      60000,
    );
    if (!firstGoalCompletedSnapshot.taskId) {
      throw new Error("首个 /goal 完成后没有可用 taskId");
    }
    // V4 的目标与执行状态来自 conversation 投影；legacy task meta 不再同步这些字段。
    // 上面的 activeInputId/queue/verified 联合条件才是下一次提交的完成屏障。

    const updatedGoalObjective = `E2E_GOAL_UPDATE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const updatedGoal = `/goal ${updatedGoalObjective}`;
    await sendV4Prompt(updatedGoal);
    await waitForV4ComposerText("", "更新 /goal 发送后输入框没有清空");
    await waitForV4UserMessageContaining(updatedGoalObjective);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.queueCount === 0 &&
        snapshot.targetStatus === "active" &&
        snapshot.targetObjective?.includes(`E2E_GOAL_UPDATE_${runId}`) === true,
      "更新 /goal 没有替换 active target",
      90000,
    );
    const updatedGoalStreaming = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "更新 /goal 后没有进入目标验证/继续运行",
      30000,
    );
    expect(updatedGoalStreaming.targetStatus).toBe("active");
    expect(updatedGoalStreaming.targetStatus).not.toBe("validating");
    await expectNoGoalValidatingLockForWindow(updatedGoalStreaming);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        !snapshot.stopRequested &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(`E2E_GOAL_UPDATE_${runId}`) === true &&
        isCompletedTargetStatus(snapshot.targetStatus),
      "更新 /goal 没有通过 verifier 自然进入完成态",
      60000,
    );

    await startNewV4Draft();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === null && snapshot.queueCount === 0,
      "新建任务后没有进入空会话草稿态",
      15000,
    );

    const slowPrompt = `E2E_SLOW_STREAM E2E_GOAL_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(slowPrompt);
    await waitForV4ComposerText("", "goal 已设置后普通消息发送没有清空输入框");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "goal 已设置后普通消息没有进入 streaming",
      30000,
    );

    const runningGoal = `/goal E2E_GOAL_RUNNING_QUEUE_${runId}`;
    await sendV4Prompt(runningGoal);
    await waitForQueueContaining(`E2E_GOAL_RUNNING_QUEUE_${runId}`);
    let queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("goal");
    await expectNoUpstreamRequestForTextWithin(`E2E_GOAL_RUNNING_QUEUE_${runId}`, 900);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "stop 后没有保留 running 中追加的 /goal queue",
      30000,
    );

    const heldGoal = `/goal E2E_GOAL_HELD_QUEUE_${runId}`;
    const heldRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_GOAL_HELD_QUEUE_${runId}`,
    );
    await sendV4Prompt(heldGoal);
    // held 输入已按协议改为显式选择；旧用例忽略确认框，误把正确门禁当作未入队。
    const keepQueueSend = await $('[data-testid="v4-composer-keep-queue-send"]');
    await keepQueueSend.waitForClickable();
    queue = await waitForQueueCount(1);
    expect(queue[0]?.content).toContain(`E2E_GOAL_RUNNING_QUEUE_${runId}`);
    await expectNoUpstreamRequestForTextWithin(`E2E_GOAL_HELD_QUEUE_${runId}`, 900);
    expect(await countUpstreamRequestsContaining(`E2E_GOAL_HELD_QUEUE_${runId}`)).toBe(
      heldRequestsBefore,
    );
    await keepQueueSend.click();
    await waitForV4ComposerText("", "保留队列发送 goal 后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.targetObjective?.includes(`E2E_GOAL_HELD_QUEUE_${runId}`) === true &&
        snapshot.targetStatus === "verified" &&
        snapshot.activeInputId === null &&
        snapshot.queueCount === 1,
      "保留队列发送的新 goal 没有完成或原队列被改变",
      60000,
    );
    expect((await waitForQueueCount(1))[0]?.content).toContain(`E2E_GOAL_RUNNING_QUEUE_${runId}`);
  });
});

function isCompletedTargetStatus(status: string | null) {
  return status === "verified";
}

async function expectNoGoalValidatingLockForWindow(
  initialSnapshot: Awaited<ReturnType<typeof getV4ConversationState>>,
  durationMs = 800,
) {
  const deadline = Date.now() + durationMs;
  let sawStreaming = initialSnapshot.state === "streaming";
  let sawActiveTarget = initialSnapshot.targetStatus === "active";
  const statuses: Array<{ state: string | null; targetStatus: string | null }> = [
    {
      state: initialSnapshot.state,
      targetStatus: initialSnapshot.targetStatus,
    },
  ];

  while (Date.now() < deadline) {
    const snapshot = await getV4ConversationState();
    statuses.push({
      state: snapshot.state,
      targetStatus: snapshot.targetStatus,
    });
    sawStreaming ||= snapshot.state === "streaming";
    sawActiveTarget ||= snapshot.targetStatus === "active";
    expect(snapshot.targetStatus).not.toBe("validating");
    await browser.pause(100);
  }

  expect({ sawActiveTarget, sawStreaming, statuses }).toEqual(
    expect.objectContaining({
      sawActiveTarget: true,
      sawStreaming: true,
    }),
  );
}

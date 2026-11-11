import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  getUpstreamThoughtLevelLabels,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ConversationState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { waitForV4MessageAction } from "#e2e/helpers/v4-message-actions";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";
import { waitForQueueContaining, waitForQueueCount } from "#e2e/helpers/conversation-session-queue";

describe("会话区 Goal Session/Model E2E", () => {
  afterEach(async () => {
    await stopIfStreaming();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("queued goal 消费时保留入队时的模型和思考深度", async function () {
    this.timeout(190000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await startNewV4Draft();

    const runId = Date.now();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);

    const runningMarker = `E2E_MODEL_CONFIG_AUTO_DRAIN_RUNNING_GOAL_${runId}`;
    // 修复原因：queued goal 必须在首轮仍处于 running 时入队；短回复会让自动消费触发卡在 terminal 边界。
    const runningPrompt = [
      `${runningMarker}: Respond directly in chat.`,
      "Do not use tools or run commands.",
      `Write 40 short numbered lines to keep this E2E turn running, then finish with "${E2E_REPLY_TOKEN}".`,
    ].join(" ");
    await sendV4Prompt(runningPrompt);
    await waitForV4UserMessageContaining(runningMarker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "queued goal model 基础消息没有进入 streaming",
      30000,
    );

    const queuedGoalMarker = `E2E_GOAL_MODEL_QUEUE_LATEST_${runId}`;
    await sendV4Prompt(goalPrompt(queuedGoalMarker));
    await waitForQueueContaining(queuedGoalMarker);
    await waitForQueueCount(1);

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    // 队列和模型选择均就绪后才让首轮完成，避免模型快慢改变用例动作顺序。
    await releaseControlledReplay("goal-session-running");
    await waitForV4ConversationState(
      (snapshot) => snapshot.targetObjective?.includes(queuedGoalMarker) === true,
      "queued goal 没有进入运行态",
      30000,
    );
    await waitForV4AssistantMessageContaining("E2E_GOAL_MODEL_QUEUED_RUNNING");
    const goalRecord = await waitForUpstreamNetworkRequestStarted(queuedGoalMarker);
    // 受控流已显示正文但尚未结束，capture 的最终 statusCode 此时仍为空。
    // Queue 的完整 Submission 在入队时固定，之后 Composer 选择不改写它。
    expect(goalRecord.method).toBe("POST");
    expect(goalRecord.replay?.fixtureId).toBe("goal-session-queued");
    expect(goalRecord.requestJson).toMatchObject({ model: UPSTREAM_MODEL });
    assertUpstreamThoughtLevelCapture(goalRecord, UPSTREAM_THOUGHT_LEVEL);
    await waitForV4ConversationState(
      (snapshot) => snapshot.targetObjective?.includes(queuedGoalMarker) === true,
      "queued goal 消费后没有设置目标",
      30000,
    );
  });

  it("goal running 和 queued goal 在 session 切换时不串状态", async function () {
    this.timeout(190000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);

    const seedPrompt = buildReadonlyToolPrompt(`E2E_GOAL_SESSION_SEED_${runId}`);
    await sendV4Prompt(seedPrompt);
    await waitForUpstreamRequestContaining(`E2E_GOAL_SESSION_SEED_${runId}`);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    const sessionAIdle = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && Boolean(snapshot.taskId),
      "goal session seed 没有完成",
      90000,
    );
    const sessionA = sessionAIdle.taskId;
    if (!sessionA) {
      throw new Error("goal session seed 缺少 taskId");
    }

    const activeGoalMarker = `E2E_GOAL_SESSION_ACTIVE_${runId}`;
    await sendV4Prompt(goalPrompt(activeGoalMarker));
    await waitForUpstreamRequestContaining(activeGoalMarker);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === sessionA &&
        snapshot.state === "streaming" &&
        snapshot.targetObjective?.includes(activeGoalMarker) === true,
      "session A goal 没有进入 running",
      30000,
    );
    // E06 允许从更早的稳定 assistant fork，当前 Goal 运行不禁用历史操作。
    const forkButton = await waitForV4MessageAction("assistant", "fork", E2E_REPLY_TOKEN);
    expect(forkButton.exists).toBe(true);
    expect(forkButton.ariaDisabled || forkButton.disabled).toBe(false);

    const queuedGoalMarker = `E2E_GOAL_SESSION_QUEUED_${runId}`;
    await sendV4Prompt(goalPrompt(queuedGoalMarker));
    let queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(queuedGoalMarker);

    await startNewV4Draft();
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId !== sessionA &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective === null &&
        snapshot.targetStatus === null,
      "新建 session 不应继承 A 的 goal 或 queue",
      30000,
    );
    // 修复原因：本 case 只验证 goal/queue 不跨 session 泄漏。
    // 新草稿继承哪组模型/思考深度由 model-config 的 I03 覆盖，不能绑定上一条 running session A 的配置。
    const draftSnapshot = await getV4ConversationState();
    expect(draftSnapshot.targetObjective).toBeNull();
    expect(draftSnapshot.queueCount).toBe(0);

    await selectV4TaskById(sessionA);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === sessionA &&
        snapshot.targetObjective?.includes(activeGoalMarker) === true &&
        snapshot.queueCount === 1,
      "切回 session A 后没有恢复 goal 与 queued goal",
      30000,
    );
    queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(queuedGoalMarker);
  });
});

function goalPrompt(marker: string) {
  return `/goal ${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function expectToolbarConfig(model: string, thoughtLevel: string) {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = [`e2e-upstream/${model}`, `custom:e2e-upstream:${model}`, model];
  if (modelLabel.currentValue) {
    expect(acceptedModelValues).toContain(modelLabel.currentValue);
  } else {
    expect(Object.values(modelLabel).join("\n")).toContain(model);
  }

  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const labelCandidates = Object.values(thoughtLabel)
    .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  const expectedLabels = [thoughtLevel, ...getUpstreamThoughtLevelLabels(thoughtLevel)].map(
    (label) => label.replace(/\s+/g, " ").trim().toLowerCase(),
  );
  const matchedThoughtLevel = labelCandidates.some((label) => expectedLabels.includes(label));
  if (!matchedThoughtLevel) {
    throw new Error(
      `思考深度未精确匹配 ${thoughtLevel}: ${JSON.stringify({
        expectedLabels,
        thoughtLabel,
      })}`,
    );
  }
}

async function stopIfStreaming() {
  const snapshot = await waitForV4ConversationState(() => true, "读取 chat 状态失败", 5000);
  if (snapshot.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "afterEach stop 后没有退出 streaming",
    30000,
  ).catch(() => undefined);
}

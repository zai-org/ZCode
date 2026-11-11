/* eslint-disable max-lines -- 22 个历史 MR-GOAL 编号集中保留，便于 catalog 与正式门禁逐条对账。 */
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  clickFirstQueueSendNow,
  clickQueueEdit,
  clickQueueRemove,
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool";
import { getV4ComposerEditState, waitForV4ComposerEditClosed } from "#e2e/helpers/v4-composer-edit";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  editFirstV4UserQuery,
  dragV4QueueItemOnto,
  getV4Messages,
  getV4ConversationState,
  getV4ComposerText,
  getV4CompactMarkers,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  sendV4PausedQueueKeep,
  startNewV4Draft,
  type V4CompactMarkerSnapshot,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Edit,
  waitForV4Fork,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const CASE_TIMEOUT_MS = 180000;

describe("会话区 Goal Run 正式 E2E", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    await stopCurrentWork();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MR-GOAL-01 completed 无 goal 时设置 goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const marker = goalFastMarker(1);

    await sendGoal(marker);
    const snapshot = await waitForGoalObjective(marker);

    expect(snapshot.queueCount).toBe(0);
    expect(snapshot.targetStatus).toBe("active");
    await waitForV4UserMessageContaining(marker);
  });

  it("MR-GOAL-02 completed 已有 goal 时更新 goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const first = goalFastMarker(2, "OLD");
    const updated = goalSlowMarker(2, "NEW");

    await sendGoal(first);
    await waitForGoalComplete(first);
    await sendGoal(updated);
    const snapshot = await waitForGoalObjective(updated);

    expect(snapshot.targetObjective).not.toContain(first);
    expect(snapshot.queueCount).toBe(0);
  });

  it("MR-GOAL-03 running 无 goal 时发送 /goal 入队", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(3);
    const goal = goalSlowMarker(3);

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(goal);
    await expectNoUpstreamRequestForTextWithin(goal, 600);
  });

  it("MR-GOAL-04 running 已有 goal 时发送新 /goal 入队", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const existing = goalFastMarker(4, "OLD");
    const running = slowMarker(4);
    const queued = goalSlowMarker(4, "NEW");

    await sendGoal(existing);
    await waitForGoalComplete(existing);
    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(queued));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(queued);
    expect((await getV4ConversationState()).targetObjective).toContain(existing);
  });

  it("MR-GOAL-05 goal running 中 stop 后 target paused", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(5);

    await sendGoal(goal);
    await waitForGoalObjective(goal);
    await clickV4Stop();
    const snapshot = await waitForV4ConversationState(
      (candidate) =>
        candidate.state !== "streaming" && candidate.targetObjective?.includes(goal) === true,
      "MR-GOAL-05 Stop 后 goal work 没有结束",
      30000,
    );

    expect(snapshot.targetStatus).toBe("paused");
  });

  it("MR-GOAL-06 interrupted held queue 后显式保留并启动新 /goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(6);
    const first = goalSlowMarker(6, "FIRST");
    const second = goalSlowMarker(6, "SECOND");

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(first));
    await waitForQueueCount(1);
    await clickV4Stop();
    await waitForHeldQueue(1);
    await sendV4PausedQueueKeep(goalPrompt(second));
    const snapshot = await waitForGoalObjective(second);
    const queue = await waitForQueueCount(1);

    expect(snapshot.targetObjective).toContain(second);
    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(first);
  });

  it("MR-GOAL-07 held goal queue 可编辑、重排、删除", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(7);
    const first = goalSlowMarker(7, "FIRST");
    const second = goalSlowMarker(7, "SECOND");
    const third = goalSlowMarker(7, "THIRD");
    const edited = goalSlowMarker(7, "SECOND_EDITED");

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(first));
    await sendV4Prompt(goalPrompt(second));
    await sendV4Prompt(goalPrompt(third));
    await waitForQueueCount(3);
    const initial = await getQueueItems();
    const firstId = requireQueueId(initial[0]?.id, "first");
    const secondId = requireQueueId(initial[1]?.id, "second");
    const thirdId = requireQueueId(initial[2]?.id, "third");
    await dragV4QueueItemOnto(thirdId, firstId);
    await waitForQueueOrderContaining([third, first, second]);
    await clickV4Stop();
    await waitForHeldQueue(3);

    // 最后一条 enqueue 的 command ACK 可以先于 composer pending finally 投影到 queue；
    // 这时首个 edit click 会按产品 guard 被忽略。等 busy 收口后重试真实按钮动作，
    // 并以 composer 进入该项的编辑态作为成功边界（队列项原位冻结，不再删除）。
    await browser.waitUntil(
      async () => {
        const state = await getV4ComposerEditState();
        if (state?.kind === "queueItem" && state.targetId === secondId) {
          return true;
        }
        await clickQueueEdit(secondId);
        return false;
      },
      {
        timeout: 30000,
        timeoutMsg: "MR-GOAL-07 goal queue item 没有进入 composer 编辑态",
      },
    );
    await browser.waitUntil(async () => (await getV4ComposerText())?.includes(second) === true, {
      timeout: 30000,
      timeoutMsg: "MR-GOAL-07 编辑态没有载入 goal 原文",
    });
    // MR-GOAL-07 只覆盖 held queue CRUD，不与 active goal streaming 的 revision
    // CAS 做交叉。冻结项之外的项仍可删除。
    await waitForHeldQueue(3);
    await waitForQueueOrderContaining([third, first, second]);
    await clickQueueRemove(firstId);
    const queueAfterDelete = await waitForQueueCount(2);

    expect(queueAfterDelete.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect(queueAfterDelete.map((item) => item.kind)).toEqual(["goal", "goal"]);

    // 编辑态下发送走 editQueueItem 原地替换，不启动新 goal，也不弹暂停队列确认。
    await sendV4Prompt(goalPrompt(edited));
    await waitForV4ComposerEditClosed("MR-GOAL-07 goal 编辑提交后没有退出编辑态", 30000);
    const queueAfterEditedGoal = await waitForQueueOrderContaining([third, edited]);

    expect(queueAfterEditedGoal.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect(queueAfterEditedGoal.map((item) => item.kind)).toEqual(["goal", "goal"]);
    await expectNoUpstreamRequestForTextWithin(edited, 800);
  });

  it("MR-GOAL-08 manual compacting 中发送 /goal 只入队", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    await buildManualCompactHistory(8);
    const goal = goalSlowMarker(8);

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "running" }, 30000);
    await sendV4Prompt(goalPrompt(goal));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(goal);
  });

  it("MR-GOAL-09 auto compact 前置于 queued goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = highUsageSlowMarker(9);
    const goal = goalFastMarker(9);
    const existingRows = await getAutoCompactRowIds();

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await waitForNewAutoCompactSuccess(existingRows);
    await waitForUpstreamRequestContaining(goal, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MR-GOAL-09 auto compact 后 queued goal 没有消费",
      90000,
    );
  });

  it("MR-GOAL-10 切换 session 时 goal 跟随当前 session", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(10, "A");
    await sendGoal(goal);
    const sessionA = await waitForGoalObjective(goal);
    await clickV4Stop();
    await waitForHeldQueue(0);

    await freshTask();
    const sessionB = await sendFastPrompt(fastMarker(10, "B"));
    requireTaskId(sessionA.taskId, "session A");
    requireTaskId(sessionB.taskId, "session B");

    await selectV4TaskById(sessionA.taskId as string);
    const restoredA = await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === sessionA.taskId && snapshot.targetObjective?.includes(goal) === true,
      "MR-GOAL-10 没有恢复 session A 的 paused goal",
      30000,
    );
    expect(restoredA.targetStatus).toBe("paused");
    await selectV4TaskById(sessionB.taskId as string);
    const restoredB = await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sessionB.taskId,
      "MR-GOAL-10 没有切回 session B",
      30000,
    );
    expect(restoredB.targetObjective).toBeNull();
  });

  it("MR-GOAL-11 queued goal send-now 后更新目标", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const oldGoal = goalFastMarker(11, "OLD");
    const running = slowMarker(11);
    const newGoal = goalSlowMarker(11, "NEW");

    await sendGoal(oldGoal);
    await waitForGoalComplete(oldGoal);
    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(newGoal));
    await waitForQueueContaining(newGoal);
    await clickFirstQueueSendNow();
    // 修复原因：Send Now 会先投影新 goal，再异步删除 queue item。只等待
    // objective 会读到 target 已更新但 queueCount 仍为 1 的短暂混合状态。
    const snapshot = await waitForActiveGoalWithEmptyQueue(newGoal);

    expect(snapshot.queueCount).toBe(0);
    expect(snapshot.targetObjective).not.toContain(oldGoal);
  });

  it("MR-GOAL-12 goal continuation stop 后 queue 保留且不自动消费", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(12);
    const queued = fastMarker(12);

    await sendGoal(goal);
    await waitForGoalObjective(goal);
    await sendV4Prompt(simplePrompt(queued));
    await waitForQueueContaining(queued);
    const requestsBefore = await countUpstreamRequestsContaining(queued);
    await clickV4Stop();
    const snapshot = await waitForHeldQueue(1);

    expect(snapshot.targetStatus).toBe("paused");
    expect(await countUpstreamRequestsContaining(queued)).toBe(requestsBefore);
  });

  it("MR-GOAL-13 verifier 是 completion-blocking work", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalVerifierSlowMarker(13);
    const queued = fastMarker(13);

    await sendGoal(goal);
    await waitForVerifierRequest(goal);
    await sendV4Prompt(simplePrompt(queued));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("text");
    await expectNoUpstreamRequestForTextWithin(queued, 600);
    expect((await getV4ConversationState()).state).toBe("streaming");
  });

  it("MR-GOAL-14 verifier 中 text/goal 保持 FIFO，compact 不抢占", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalVerifierSlowMarker(14, "ACTIVE");
    const textOne = fastMarker(14, "TEXT_ONE");
    const queuedGoal = goalFastMarker(14, "QUEUED");
    const textTwo = fastMarker(14, "TEXT_TWO");

    await sendGoal(goal);
    await waitForVerifierRequest(goal);
    await sendQueuedPromptAndWait(simplePrompt(textOne), textOne);
    await sendQueuedPromptAndWait(goalPrompt(queuedGoal), queuedGoal);
    const compactBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendQueuedPromptAndWait("/compact", "/compact");
    await sendQueuedPromptAndWait(simplePrompt(textTwo), textTwo);
    const queue = await waitForQueueOrderContaining([textOne, queuedGoal, "/compact", textTwo]);

    expect(queue.map((item) => item.kind)).toEqual(["text", "goal", "compact", "text"]);
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(compactBefore);
    await assertVisibleV4UserMessagesNotContaining("/compact");
  });

  it("MR-GOAL-15 立即消费 typed goal 保留 goal intent", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(15);
    const goal = goalSlowMarker(15);

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await clickFirstQueueSendNow();
    const snapshot = await waitForActiveGoalWithEmptyQueue(goal);

    expect(snapshot.queueCount).toBe(0);
    expect(snapshot.targetStatus).toBe("active");
  });

  it("MR-GOAL-16 manual compact success 后消费 queued goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    await buildManualCompactHistory(16);
    const goal = goalFastMarker(16);

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "running" }, 30000);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
    await waitForUpstreamRequestContaining(goal, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MR-GOAL-16 compact success 后 queued goal 没有消费",
      90000,
    );
  });

  it("MR-GOAL-17 auto compact success 后消费 queued goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = highUsageSlowMarker(17);
    const goal = goalFastMarker(17);
    const existingRows = await getAutoCompactRowIds();

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await waitForNewAutoCompactSuccess(existingRows);
    await waitForUpstreamRequestContaining(goal, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MR-GOAL-17 auto compact success 后 queued goal 没有消费",
      90000,
    );
  });

  it("MR-GOAL-18 goal complete 后 edit/fork/compact 控件恢复", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const seed = compactHistoryMarker(18, "SEED");
    const goal = goalFastMarker(18);

    await sendFastPrompt(seed);
    await sendGoal(goal);
    await waitForGoalComplete(goal);
    await expandAssistantHistoriesWithContent();
    // controlOnly 的 /goal 行不支持直接 edit；完成后恢复的是既有普通 query 的
    // edit 与 assistant fork 控件。V4 行以 rowId 而非 legacy messageId 标识，
    // 必须读取 V4 action 合同，避免旧 message helper 把已存在按钮误报为 null。
    await waitForV4Edit();
    await waitForV4Fork();

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
  });

  it("MR-GOAL-19 edit latest 普通 query 保持既有 goal scope", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalFastMarker(19);
    const beforeEdit = fastMarker(19, "BEFORE_EDIT");
    const afterEdit = fastMarker(19, "AFTER_EDIT");

    await sendGoal(goal);
    await waitForGoalComplete(goal);
    await sendFastPrompt(beforeEdit);
    await editFirstV4UserQuery(simplePrompt(afterEdit));
    await waitForUpstreamRequestContaining(afterEdit, 45000);
    const existingGoal = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.targetObjective?.includes(goal) === true,
      "MR-GOAL-19 edit 普通 query 后 existing goal scope 丢失",
      90000,
    );
    expect(existingGoal.targetObjective).toContain(goal);

    await freshTask();
    const noGoalBefore = fastMarker(19, "NO_GOAL_BEFORE");
    const noGoalAfter = fastMarker(19, "NO_GOAL_AFTER");
    await sendFastPrompt(noGoalBefore);
    await editFirstV4UserQuery(simplePrompt(noGoalAfter));
    await waitForUpstreamRequestContaining(noGoalAfter, 45000);
    expect(
      (
        await waitForV4ConversationState(
          (snapshot) => snapshot.state === "idle",
          "MR-GOAL-19 无 goal edit 后没有回到 idle",
          90000,
        )
      ).targetObjective,
    ).toBeNull();
  });

  it("MR-GOAL-20 历史 session goal/queue 状态不串", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goalA = goalSlowMarker(20, "A");
    const queueA = goalFastMarker(20, "A_QUEUE");
    await sendGoal(goalA);
    const sessionA = await waitForGoalObjective(goalA);
    await sendV4Prompt(goalPrompt(queueA));
    await waitForQueueContaining(queueA);
    requireTaskId(sessionA.taskId, "session A");

    await freshTask();
    const sessionB = await sendFastPrompt(fastMarker(20, "B"));
    requireTaskId(sessionB.taskId, "session B");
    expect(sessionB.targetObjective).toBeNull();
    expect(sessionB.queueCount).toBe(0);

    await selectV4TaskById(sessionA.taskId as string);
    const restoredA = await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === sessionA.taskId &&
        snapshot.targetObjective?.includes(goalA) === true &&
        snapshot.queueCount === 1,
      "MR-GOAL-20 session A goal/queue 没有恢复",
      30000,
    );
    expect(restoredA.targetObjective).toContain(goalA);
  });

  it("MR-GOAL-21 普通 queue send-now 停止 active goal 输出", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(21);
    const queued = fastMarker(21);
    const assistantRowIdsBeforeGoal = new Set(
      (await getV4Messages("assistant")).flatMap((message) =>
        message.id === null ? [] : [message.id],
      ),
    );

    await sendGoal(goal);
    await waitForGoalObjective(goal);
    await waitForNewGoalContinuationOutput(goal, assistantRowIdsBeforeGoal);
    await sendV4Prompt(simplePrompt(queued));
    await waitForQueueContaining(queued);
    await clickFirstQueueSendNow();
    await waitForUpstreamRequestContaining(queued, 90000);
    const snapshot = await waitForV4ConversationState(
      (candidate) => candidate.queueCount === 0,
      "MR-GOAL-21 send-now 后被点文本没有离开 queue",
      30000,
    );

    expect(snapshot.targetStatus).toBe("paused");
    await waitForV4UserMessageContaining(queued);
  });

  it("MR-GOAL-22 普通 queue send-now 停止 goal verifier", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalVerifierSlowMarker(22);
    const queued = fastMarker(22);

    await sendGoal(goal);
    await waitForVerifierRequest(goal);
    await sendV4Prompt(simplePrompt(queued));
    await waitForQueueContaining(queued);
    const verifierBefore = await countUpstreamRequestsContaining(
      "Verify whether the active session goal",
    );
    await clickFirstQueueSendNow();
    await waitForUpstreamRequestContaining(queued, 90000);
    const snapshot = await waitForV4ConversationState(
      (candidate) => candidate.queueCount === 0,
      "MR-GOAL-22 send-now 后被点文本没有离开 queue",
      30000,
    );
    await browser.pause(500);

    expect(snapshot.targetStatus).toBe("paused");
    expect(await countUpstreamRequestsContaining("Verify whether the active session goal")).toBe(
      verifierBefore,
    );
  });
});

async function freshTask() {
  await startNewV4Draft();
  await waitForV4ConversationState(
    (snapshot) => snapshot.taskId === null && snapshot.queueCount === 0,
    "新建任务后没有进入空草稿",
    15000,
  );
  // 旧 MR-GOAL 用例的入口是 completed session，而不是空 draft。空 draft 直接发送
  // /goal 只会预建 session，无法覆盖 completed task 上的 target/queue 语义。
  return sendFastPrompt(fastMarker(0, "SETUP"));
}

async function sendFastPrompt(marker: string) {
  await sendV4Prompt(simplePrompt(marker));
  await waitForV4ComposerText("", `${marker} 发送后输入框没有清空`);
  await waitForUpstreamRequestContaining(marker, 30000);
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
  return waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${marker} 没有完成`,
    60000,
  );
}

async function startSlowPrompt(marker: string) {
  await sendV4Prompt(simplePrompt(marker));
  await waitForV4ComposerText("", `${marker} 发送后输入框没有清空`);
  // Bug 根因：只按 bodyIncludes 等待会先命中携带同一 user marker 的 title 请求，
  // 随后把尚未进入主 turn 的 completed 快照误报为运行态失败。这里锁定最后一条
  // user message，并排除 title/compact，确保 admission 对应 controlled-stream fixture。
  await waitForV4UserMessageContaining(marker);
  await waitForUpstreamRequest(
    {
      excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      lastUserMessageIncludes: [marker],
    },
    `${marker} 主 turn 请求没有开始`,
    30000,
  );
  // 运行时证据取 provider 主请求的 pending controlled-stream；completed session
  // 恢复下一轮时，renderer 的 task bridge 会在 V4 delta 前短暂保留上一轮 completed，
  // 不能让这条 legacy 诊断投影反过来否定已经开始的真实主请求。各 case 随后的
  // queue/Stop 断言会继续验证 busy admission，而不是在这里放宽产品结果。
}

async function sendGoal(marker: string) {
  await sendV4Prompt(goalPrompt(marker));
  await waitForV4ComposerText("", `${marker} goal 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(marker);
}

async function sendQueuedPromptAndWait(prompt: string, marker: string) {
  await sendV4Prompt(prompt);
  // 修复原因：Windows 下连续点击发送后，上一条 prompt 的异步 composer 清空可能覆盖
  // 下一条刚写入的内容；每一步必须同时确认输入已清空且本条 marker 已被队列接受。
  await waitForV4ComposerText("", `${marker} 入队后输入框没有清空`);
  return waitForQueueContaining(marker);
}

function waitForGoalObjective(marker: string) {
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "streaming" && snapshot.targetObjective?.includes(marker) === true,
    `${marker} 没有进入 active goal work`,
    45000,
  );
}

async function waitForNewGoalContinuationOutput(
  marker: string,
  previousAssistantRowIds: ReadonlySet<string>,
) {
  await waitForUpstreamRequest(
    {
      excludes: [COMPACT_REQUEST_SENTINEL, "Verify whether the active session goal"],
      includes: [marker, "Continue working toward the active session goal"],
    },
    `${marker} goal continuation 请求没有开始`,
    45000,
  );
  await browser.waitUntil(
    async () => {
      const messages = await getV4Messages("assistant");
      return messages.some(
        (message) =>
          message.id !== null &&
          !previousAssistantRowIds.has(message.id) &&
          message.text.includes("deep"),
      );
    },
    {
      timeout: 30000,
      // Bug 根因：只等 target=active 会早于 continuation 首个 delta；此时马上点击
      // send-now 可能与该 delta 的 revision 递增交叉，CAS 按规范返回 stale，case 却
      // 误报为 stop 失效。先锁定新 assistant row，才真正进入“active goal 输出中”。
      timeoutMsg: `${marker} goal continuation 首段输出没有进入新 assistant row`,
    },
  );
}

function waitForActiveGoalWithEmptyQueue(marker: string) {
  let stableSamples = 0;
  return waitForV4ConversationState(
    (snapshot) => {
      // 修复原因：Send Now 会先更新 store/goal projection，再异步卸载队列 DOM；
      // 只等 objective 会在 Windows 上读到 goal 已 active、旧队列节点仍存在的混合快照。
      const settled =
        snapshot.state === "streaming" &&
        snapshot.targetObjective?.includes(marker) === true &&
        snapshot.targetStatus === "active" &&
        snapshot.queueCount === 0;
      stableSamples = settled ? stableSamples + 1 : 0;
      return stableSamples >= 2;
    },
    `${marker} Send Now 后 active goal 与空队列没有稳定收敛`,
    45000,
  );
}

function waitForGoalComplete(marker: string) {
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "idle" &&
      snapshot.targetObjective?.includes(marker) === true &&
      (snapshot.targetStatus === "complete" ||
        snapshot.targetStatus === "completed" ||
        snapshot.targetStatus === "verified"),
    `${marker} 没有通过 verifier 自然完成`,
    60000,
  );
}

async function waitForVerifierRequest(marker: string) {
  await waitForUpstreamRequest(
    {
      excludes: [COMPACT_REQUEST_SENTINEL],
      includes: [marker, "Verify whether the active session goal"],
    },
    `${marker} verifier 请求没有开始`,
    60000,
  );
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "streaming" && snapshot.targetObjective?.includes(marker) === true,
    `${marker} verifier 没有保持 completion-blocking 状态`,
    30000,
  );
}

function waitForHeldQueue(expectedCount: number) {
  return waitForV4ConversationState(
    (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === expectedCount,
    `Stop 后没有保留 ${expectedCount} 条 held queue`,
    30000,
  );
}

async function buildManualCompactHistory(caseId: number) {
  await sendFastPrompt(compactHistoryMarker(caseId, "A"));
  await sendFastPrompt(compactHistoryMarker(caseId, "B"));
}

async function getAutoCompactRowIds() {
  await expandAssistantHistoriesWithContent();
  return new Set(
    (await getV4CompactMarkers())
      .filter((marker) => marker.origin === "auto" && marker.rowId !== null)
      .map((marker) => marker.rowId as number),
  );
}

async function waitForNewAutoCompactSuccess(
  existingRowIds: ReadonlySet<number>,
): Promise<V4CompactMarkerSnapshot> {
  let latestMarkers: V4CompactMarkerSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      await expandAssistantHistoriesWithContent();
      latestMarkers = await getV4CompactMarkers();
      return latestMarkers.some(
        (marker) =>
          marker.origin === "auto" &&
          marker.status === "success" &&
          marker.rowId !== null &&
          !existingRowIds.has(marker.rowId),
      );
    },
    {
      timeout: 90000,
      timeoutMsg: `没有等到新的 auto/success marker: ${JSON.stringify(latestMarkers)}`,
    },
  );
  const marker = latestMarkers.find(
    (candidate) =>
      candidate.origin === "auto" &&
      candidate.status === "success" &&
      candidate.rowId !== null &&
      !existingRowIds.has(candidate.rowId),
  );
  if (!marker) {
    throw new Error("新的 auto/success marker 在等待后仍不存在");
  }
  return marker;
}

async function stopCurrentWork() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "afterEach Stop 后没有结束当前 work",
    30000,
  ).catch(() => undefined);
}

function requireQueueId(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`${label} queue item 缺少 id`);
  }
  return value;
}

function requireTaskId(value: string | null, label: string) {
  if (!value) {
    throw new Error(`${label} 缺少 taskId`);
  }
  return value;
}

function simplePrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

function goalPrompt(marker: string) {
  return `/goal ${goalObjective(marker)}`;
}

function goalObjective(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

function fastMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_FAST_${caseId}_${suffix}_${Date.now()}`;
}

function slowMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_SLOW_${caseId}_${suffix}_${Date.now()}`;
}

function highUsageSlowMarker(caseId: number) {
  return `E2E_GR_HIGH_USAGE_SLOW_${caseId}_${Date.now()}`;
}

function goalFastMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_GOAL_FAST_${caseId}_${suffix}_${Date.now()}`;
}

function goalSlowMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_GOAL_SLOW_${caseId}_${suffix}_${Date.now()}`;
}

function goalVerifierSlowMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_GOAL_VERIFY_SLOW_${caseId}_${suffix}_${Date.now()}`;
}

function compactHistoryMarker(caseId: number, suffix: string) {
  return `E2E_GR_COMPACT_HISTORY_${caseId}_${suffix}_${Date.now()}`;
}

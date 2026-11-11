import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  clickV4QueueItemSendNow,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  setV4ComposerText,
  clickV4Send,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
  waitForLatestV4CommandAck,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { editV4UserMessageContaining as editUserMessageContaining } from "#e2e/helpers/v4-message-actions";
import { getV4MessageAction, waitForV4MessageAction } from "#e2e/helpers/v4-message-actions";
import {
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";
import { waitForToastContaining } from "#e2e/helpers/conversation-session-toast";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const COMPACT_DUPLICATE_BLOCKED_TOAST_TEXTS = [
  "A compaction is already running or queued.",
  "已有压缩任务正在运行或排队。",
];
const EDIT_INTERRUPTED_SOURCE_REPLY_PREFIX = "deep";
const EDIT_INTERRUPTED_RERUN_REPLY_TOKEN = "upstream-e2e-edit-rerun-ok";

describe("会话区 Edit User Query E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("user query edit 应立即重跑；held queue 存在时仍保留 queue，running latest edit 可抢占", async function () {
    this.timeout(220000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const originalPrompt = `E2E_EDIT_ORIGINAL_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(originalPrompt);
    await waitForUpstreamNetworkCapture(`E2E_EDIT_ORIGINAL_${runId}`);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "edit 前首轮没有完成",
      90000,
    );

    expect((await getV4MessageAction("assistant", "edit", E2E_REPLY_TOKEN))?.exists).not.toBe(true);

    const editedPrompt = buildReadonlyToolPrompt(`E2E_EDIT_RERUN_${runId}`);
    await editUserMessageContaining(`E2E_EDIT_ORIGINAL_${runId}`, editedPrompt);
    // 已复现单次点击后 resync、没有模型请求；记录 ACK，不能把命令拒绝归为模型缺响应。
    const editAck = await waitForLatestV4CommandAck("editUserQuery");
    if (editAck.status !== "accepted") {
      throw new Error(`首次编辑提交未接纳: ${JSON.stringify(editAck)}`);
    }
    await waitForV4ComposerText("", "edit 提交后输入框没有清空");
    await waitForUpstreamNetworkCapture(`E2E_EDIT_RERUN_${runId}`);
    await waitForV4UserMessageContaining(`E2E_EDIT_RERUN_${runId}`);
    await assertVisibleV4UserMessagesNotContaining(`E2E_EDIT_ORIGINAL_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "edit 重跑完成后会话没有回到 idle",
      90000,
    );

    await startNewV4Draft();

    const slowPrompt = `E2E_SLOW_STREAM E2E_EDIT_HELD_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(slowPrompt);
    await waitForV4ComposerText("", "held queue 场景首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "held queue 场景首轮没有进入 streaming",
      30000,
    );

    const heldPrompt = `E2E_EDIT_HELD_QUEUE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(heldPrompt);
    await waitForQueueContaining(`E2E_EDIT_HELD_QUEUE_${runId}`);
    const heldQueue = await waitForQueueCount(1);
    const heldQueueItemId = heldQueue[0]?.id;
    expect(heldQueueItemId).toBeTruthy();

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "stop 后没有保留 held queue",
      30000,
    );
    await expectNoUpstreamRequestForTextWithin(`E2E_EDIT_HELD_QUEUE_${runId}`, 900);

    // 修复原因：edit 重跑必须精确命中 case-local controlled stream；
    // 否则会回退到 legacy 90.2s slow stream，并在 90s 等待边界误报成产品 bug。
    const heldEditPrompt = `E2E_SLOW_STREAM E2E_EDIT_HELD_RERUN_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await editUserMessageContaining(`E2E_EDIT_HELD_RUNNING_${runId}`, heldEditPrompt);
    await waitForUpstreamRequestContaining(`E2E_EDIT_HELD_RERUN_${runId}`);
    await waitForV4UserMessageContaining(`E2E_EDIT_HELD_RERUN_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 1,
      "held queue 存在时 edit 没有立即重跑并保留 queue",
      30000,
    );
    expect((await getQueueItems())[0]?.id).toBe(heldQueueItemId);

    await waitForV4MessageAction("user", "edit", `E2E_EDIT_HELD_RERUN_${runId}`);

    const followupPrompt = `E2E_EDIT_RUNNING_FOLLOWUP_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(followupPrompt);
    await waitForQueueContaining(`E2E_EDIT_RUNNING_FOLLOWUP_${runId}`);
    await waitForQueueCount(2);

    const goalPrompt = `/goal E2E_EDIT_RUNNING_GOAL_${runId}`;
    await sendV4Prompt(goalPrompt);
    await waitForQueueContaining(`E2E_EDIT_RUNNING_GOAL_${runId}`);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "goal"]);
    await expectNoUpstreamRequestForTextWithin(`E2E_EDIT_RUNNING_GOAL_${runId}`, 800);

    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      "edit 重跑完成后没有稳定保留 3 条 queue",
      90000,
    );

    const compactRequestsBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "held queue 下手动 compact 发送后输入框没有清空");
    // 暂停队列不会自动执行维护命令；从 compact 队列项明确立即发送，保留原有三项。
    const compactQueue = await waitForQueueCount(4);
    expect(compactQueue[3]?.kind).toBe("compact");
    await clickV4QueueItemSendNow(compactQueue[3]!.id);
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)) ===
        compactRequestsBefore + 1,
      {
        timeout: 10000,
        timeoutMsg: "held queue 下没有捕获到手动 compact 请求",
      },
    );
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "goal"]);

    const duplicateCompactRequestsBefore =
      await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await setV4ComposerText("/compact");
    await clickV4Send();
    await waitForToastContaining(
      COMPACT_DUPLICATE_BLOCKED_TOAST_TEXTS,
      "compacting 中重复 /compact 没有弹出 duplicate blocked toast",
    );
    await expectNoUpstreamRequestForTextWithin(COMPACT_REQUEST_SENTINEL, 800);
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(
      duplicateCompactRequestsBefore,
    );
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "goal"]);
    await assertVisibleV4UserMessagesNotContaining("/compact");

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    expect(completedMarker.inputId).toBe(startedMarker.inputId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      "held queue 下手动 compact 完成后没有继续保留 queue",
      90000,
    );
  });

  it("中断模型回答后编辑已发送 user query 并重新提交，不应触发 turnIndex 解析错误", async function () {
    this.timeout(160000);

    await prepareV4ConversationE2E();
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const sourceMarker = `E2E_EDIT_INTERRUPTED_RESUBMIT_SOURCE_${runId}`;
    const rerunMarker = `E2E_EDIT_INTERRUPTED_RESUBMIT_RERUN_${runId}`;
    const rerunReplyToken = EDIT_INTERRUPTED_RERUN_REPLY_TOKEN;
    const sourcePrompt = `E2E_SLOW_STREAM ${sourceMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(sourcePrompt);
    await waitForV4ComposerText("", "interrupted resubmit 源 prompt 发送后输入框没有清空");
    const runningSnapshot = await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state === "streaming" && Boolean(snapshot.sessionId || snapshot.taskId),
      "interrupted resubmit 源 prompt 没有进入 streaming",
      30000,
    );
    const taskId = runningSnapshot.sessionId || runningSnapshot.taskId;
    if (!taskId) {
      throw new Error("interrupted resubmit 源 prompt 缺少 taskId/sessionId");
    }

    // 修复原因：默认 replay 在首个 assistant delta 之前 stop 时会触发 stream
    // recovery；真实 capture 下等完整回复又可能错过 stop 按钮，所以等首个 delta 后立刻中断。
    await waitForV4AssistantMessageContaining(EDIT_INTERRUPTED_SOURCE_REPLY_PREFIX);
    await clickV4Stop();
    await waitForV4UserMessageContaining(sourceMarker);
    await waitForV4ConversationState(
      (snapshot) =>
        (snapshot.sessionId || snapshot.taskId) === taskId &&
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0,
      "interrupted resubmit stop 后没有进入可编辑的 completed(interrupted) 状态",
      30000,
    );

    // 修复原因：interrupted edit 场景需要用不同回复区分旧 assistant 与 edit 后 rerun 结果，
    // 否则 UI 上看到同样 token 时无法判断是否真的执行了新 query。
    const editedPrompt = `${rerunMarker}: Reply with exactly "${rerunReplyToken}" and no other text.`;
    await editUserMessageContaining(sourceMarker, editedPrompt);
    await waitForV4ComposerText("", "interrupted resubmit edit 提交后输入框没有清空");
    await waitForUpstreamRequestContaining(rerunMarker);
    await waitForV4UserMessageContaining(rerunMarker);
    await assertVisibleV4UserMessagesNotContaining(sourceMarker);
    await waitForV4AssistantMessageContaining(rerunReplyToken);
    await waitForV4ConversationState(
      (snapshot) =>
        (snapshot.sessionId || snapshot.taskId) === taskId &&
        snapshot.state === "idle" &&
        snapshot.queueCount === 0,
      "interrupted resubmit edit 重跑后没有回到 idle",
      90000,
    );
  });
});

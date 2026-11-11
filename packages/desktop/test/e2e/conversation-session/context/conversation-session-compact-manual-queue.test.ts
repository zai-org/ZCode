import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  selectUpstreamModelById,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  clickV4QueueItemSendNow,
  waitForV4AssistantMessageContaining,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4PausedQueueSendDialog,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
} from "#e2e/helpers/conversation-session-network";
import {
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

describe("会话区手动 Compact 与 Held Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("held queue 存在时手动 compact 应保留 queue 且不自动消费", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const prepPromptOne = `E2E_COMPACT_PREP_ONE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prepPromptOne);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_PREP_ONE_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "第一轮 compact 预置消息没有完成",
      30000,
    );

    const prepPromptTwo = buildReadonlyToolPrompt(`E2E_COMPACT_PREP_TWO_${runId}`);
    await sendV4Prompt(prepPromptTwo);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_PREP_TWO_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "第二轮 compact 预置消息没有完成",
      30000,
    );
    // 通过真实流、入队和 Stop 构造 held queue；旧 renderer 注入已不再是队列权威。
    await sendV4Prompt(`E2E_COMPACT_QUEUE_RUNNING_${runId}: keep streaming until stopped.`);
    await waitForV4AssistantMessageContaining("E2E_COMPACT_QUEUE_PARTIAL");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "没有建立受控运行窗口",
    );
    const queuedPrompt = `E2E_COMPACT_QUEUE_HELD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(queuedPrompt);
    await waitForQueueContaining(`E2E_COMPACT_QUEUE_HELD_${runId}`);
    const heldQueue = await waitForQueueCount(1);
    const heldQueueItemId = heldQueue[0]?.id;
    expect(heldQueueItemId).toBeTruthy();
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 1,
      "Stop 后没有保留 held queue",
    );

    const queuedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_COMPACT_QUEUE_HELD_${runId}`,
    );
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "/compact 发送后输入框没有清空");
    // 暂停队列中的维护命令也先入队；显式提升 compact 后验证旧 text 仍 held。
    const withCompact = await waitForQueueCount(2);
    expect(withCompact[0]?.id).toBe(heldQueueItemId);
    const compactItem = withCompact[1];
    expect(compactItem?.kind).toBe("compact");
    if (!compactItem?.id) throw new Error("compact 队列项缺少身份");
    // 后续菜单改选只影响未来提交；提升维护项必须仍用入队时的 secondary。
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await clickV4QueueItemSendNow(compactItem.id);
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    expect(await getQueueItems()).toHaveLength(1);
    expect((await getQueueItems())[0]?.id).toBe(heldQueueItemId);

    await releaseControlledReplay("upstream-compact-manual-queue-summary-success");
    const compactRecord = await waitForUpstreamNetworkCapture(COMPACT_REQUEST_SENTINEL);
    assertUpstreamRequestCapture(compactRecord, {
      expectedText: COMPACT_REQUEST_SENTINEL,
      model: UPSTREAM_SECONDARY_MODEL,
    });

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    expect(completedMarker.inputId).toBe(startedMarker.inputId);
    const finalQueue = await waitForQueueCount(1);
    expect(finalQueue[0]?.id).toBe(heldQueueItemId);
    expect(await countUpstreamRequestsContaining(`E2E_COMPACT_QUEUE_HELD_${runId}`)).toBe(
      queuedRequestsBefore,
    );

    const appendPrompt = `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const appendRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
    );
    await sendV4Prompt(appendPrompt);
    // 当前暂停队列合同先确认，不再无提示地追加普通文本。
    await waitForV4PausedQueueSendDialog();
    await browser.keys("Escape");
    await waitForV4ComposerText(appendPrompt, "取消后未保留追加草稿");
    const appendedQueue = await waitForQueueCount(1);
    expect(appendedQueue[0]?.id).toBe(heldQueueItemId);
    await setV4ComposerText("");
    await expectNoUpstreamRequestForTextWithin(
      `E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`,
      800,
    );
    expect(
      await countUpstreamRequestsContaining(`E2E_COMPACT_QUEUE_APPEND_AFTER_SUCCESS_${runId}`),
    ).toBe(appendRequestsBefore);
  });
});

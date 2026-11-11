import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import { UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { getQueueItems } from "#e2e/helpers/conversation-session-queue";
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

describe("会话区 Interrupted 后手动 Compact E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed interrupted 且 queue=0 时应允许手动 compact", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const prepPromptOne = `E2E_COMPACT_INTERRUPTED_PREP_ONE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prepPromptOne);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_INTERRUPTED_PREP_ONE_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "第一轮 interrupted compact 预置消息没有完成",
      30000,
    );

    const prepPromptTwo = buildReadonlyToolPrompt(`E2E_COMPACT_INTERRUPTED_PREP_TWO_${runId}`);
    await sendV4Prompt(prepPromptTwo);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_INTERRUPTED_PREP_TWO_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "第二轮 interrupted compact 预置消息没有完成",
      30000,
    );

    const interruptedPrompt = `E2E_SLOW_STREAM E2E_COMPACT_INTERRUPTED_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(interruptedPrompt);
    await waitForV4ComposerText("", "interrupted compact 运行轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "interrupted compact 运行轮没有进入 streaming",
      30000,
    );

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "stop 后没有进入 completed interrupted 且 queue=0",
      30000,
    );

    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "interrupted 后 /compact 发送后输入框没有清空");
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    expect(await getQueueItems()).toHaveLength(0);

    const compactRecord = await waitForUpstreamNetworkCapture(COMPACT_REQUEST_SENTINEL);
    assertUpstreamRequestCapture(compactRecord, {
      expectedText: COMPACT_REQUEST_SENTINEL,
      model: UPSTREAM_MODEL,
    });

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    // 原因：V4 compact 以 sourceCommandId 关联起止标记，不再暴露旧 operationId。
    expect(completedMarker.inputId).toBe(startedMarker.inputId);
    expect(await getQueueItems()).toHaveLength(0);
  });
});

import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const GOAL_INTERRUPTIONS_TIMEOUT_MS = 180000;

describe("会话区 Goal Interruptions E2E", () => {
  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("goal verifier 运行中 stop 后，普通文本应立即开始下一轮", async function () {
    this.timeout(GOAL_INTERRUPTIONS_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await startNewV4Draft();

    const runId = Date.now();
    const goalMarker = `E2E_GOAL_VERIFIER_STOP_${runId}`;
    const nextMarker = `E2E_GOAL_VERIFIER_STOP_NEXT_${runId}`;
    const requestCountBefore = await getUpstreamRequestRecordCount();

    await sendV4Prompt(
      `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    );
    await waitForV4ComposerText("", "goal verifier stop /goal 发送后输入框没有清空");
    await waitForV4UserMessageContaining(goalMarker);
    await waitForUpstreamRequest(
      {
        includes: [goalMarker, "Verify whether the active session goal"],
        excludes: [nextMarker],
      },
      "goal verifier stop 没有进入 verifier request",
      90000,
      { afterIndex: requestCountBefore },
    );

    // V4 的 Stop 控件和队列/目标投影是当前状态来源；旧 runtimeStatus 已不再写入。
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0 &&
        snapshot.targetStatus === "paused",
      "goal verifier stop 后没有收口到 completed/paused",
      30000,
    );

    await sendV4Prompt(`${nextMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    await waitForV4ComposerText("", "goal verifier stop 后下一轮发送没有清空输入框");
    await waitForUpstreamRequestContaining(nextMarker, 30000);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "goal verifier stop 后下一轮没有完成并保持 queue=0",
      90000,
    );
  });

  it("goal verifier 运行中 stop 后，可以 compact 并继续发送普通文本", async function () {
    this.timeout(GOAL_INTERRUPTIONS_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await startNewV4Draft();

    const runId = Date.now();
    const goalMarker = `E2E_GOAL_VERIFIER_COMPACT_${runId}`;
    const nextMarker = `E2E_GOAL_VERIFIER_COMPACT_NEXT_${runId}`;
    const compactSummaryMarker = "E2E_GOAL_VERIFIER_COMPACT_SUMMARY_MARKER";
    const requestCountBefore = await getUpstreamRequestRecordCount();

    await sendV4Prompt(
      `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    );
    await waitForV4ComposerText("", "goal verifier compact /goal 发送后输入框没有清空");
    await waitForUpstreamRequest(
      {
        includes: [goalMarker, "Verify whether the active session goal"],
        excludes: [nextMarker],
      },
      "goal verifier compact 没有进入 verifier request",
      90000,
      { afterIndex: requestCountBefore },
    );

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0 &&
        snapshot.targetStatus === "paused",
      "goal verifier compact stop 后没有收口到 completed/paused",
      30000,
    );

    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "goal verifier compact 后 /compact 没有清空输入框");
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    await waitForUpstreamRequest(
      {
        includes: [COMPACT_REQUEST_SENTINEL, goalMarker],
      },
      "goal verifier compact 没有发起 manual compact 请求",
      30000,
      { afterIndex: requestCountBefore },
    );
    // 快速摘要曾在 38ms 内完成，轮询来不及观察 started；确认开始后再放行受控响应。
    await releaseControlledReplay("upstream-goal-verifier-compact-summary");
    await waitForCompactMarkerStatus("completed", "manual", startedMarker.inputId);

    await sendV4Prompt(`${nextMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    await waitForV4ComposerText("", "goal verifier compact 后下一轮发送没有清空输入框");
    await waitForUpstreamRequest(
      {
        includes: [nextMarker, compactSummaryMarker],
        lastUserMessageIncludes: [nextMarker],
      },
      "goal verifier compact 后下一轮请求没有基于 compact 后摘要继续",
      30000,
      { afterIndex: requestCountBefore },
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "goal verifier compact 后下一轮没有完成并保持 queue=0",
      90000,
    );
  });
});

async function stopIfBusy() {
  const snapshot = await waitForV4ConversationState(
    () => true,
    "goal interruptions afterEach 读取 chat state 失败",
    1000,
  ).catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "goal interruptions 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
}

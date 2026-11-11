import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Send,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
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
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";
import { waitForToastContaining } from "#e2e/helpers/conversation-session-toast";
import { waitForQueueContaining, waitForQueueCount } from "#e2e/helpers/conversation-session-queue";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const COMPACT_DUPLICATE_BLOCKED_TOAST_TEXTS = [
  "A compaction is already running or queued.",
  "已有压缩任务正在运行或排队。",
];

describe("会话区 Compacting Actions E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("手动 compacting 中普通输入和 /goal 只入队、重复 /compact 不抢占；compact 完成后继续消费 queue", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    // 先准备两轮带 readonly tool_result 的已完成会话，让后续手动 /compact
    // 稳定进入真实压缩窗口；短纯文本历史会被 agent 判定为无需压缩，导致该 case 只测到 no-op。
    const runId = Date.now();
    const prepPromptOne = buildReadonlyToolPrompt(`E2E_COMPACTING_ACTIONS_PREP_ONE_${runId}`);
    await sendV4Prompt(prepPromptOne);
    await waitForV4ComposerText("", "compacting actions 第一轮发送后输入框没有清空");
    await waitForUpstreamRequestContaining(`E2E_COMPACTING_ACTIONS_PREP_ONE_${runId}`);
    await browser.waitUntil(
      async () =>
        (await getV4Messages("assistant")).filter((message) =>
          message.text.includes(E2E_REPLY_TOKEN),
        ).length >= 1,
      { timeout: 60_000, timeoutMsg: "第一轮真实 Read 的完成回复未出现" },
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "compacting actions 第一轮预置消息没有完成",
      90000,
    );

    const prepPromptTwo = buildReadonlyToolPrompt(`E2E_COMPACTING_ACTIONS_PREP_TWO_${runId}`);
    await sendV4Prompt(prepPromptTwo);
    await waitForV4ComposerText("", "compacting actions 第二轮发送后输入框没有清空");
    await waitForUpstreamRequestContaining(`E2E_COMPACTING_ACTIONS_PREP_TWO_${runId}`);
    await browser.waitUntil(
      async () =>
        (await getV4Messages("assistant")).filter((message) =>
          message.text.includes(E2E_REPLY_TOKEN),
        ).length >= 2,
      { timeout: 60_000, timeoutMsg: "第二轮真实 Read 的完成回复未出现" },
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "compacting actions 第二轮预置消息没有完成",
      90000,
    );

    const compactRequestsBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "/compact 发送后输入框没有清空");

    // 原因：固定延迟无法保证动作都落在 compacting；回放在摘要流内等待显式释放。
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)) ===
        compactRequestsBefore + 1,
      {
        timeout: 10000,
        timeoutMsg: "没有捕获到 compacting actions 的手动 compact 请求",
      },
    );

    // compacting 期间历史还没有稳定，assistant fork 必须禁用，避免从半完成历史分叉。
    expect(
      await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid^="v4-fork-"]')).some(
          (button) => !button.disabled && button.getAttribute("aria-disabled") !== "true",
        ),
      ),
    ).toBe(false);

    // compacting 期间继续发送普通文本不能打断 compact；它应该作为未来输入进入 queue。
    const queuedTextPrompt = `E2E_COMPACTING_ACTIONS_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(queuedTextPrompt);
    await waitForV4ComposerText("", "compacting 中普通文本发送后输入框没有清空");
    await waitForQueueContaining(`E2E_COMPACTING_ACTIONS_TEXT_${runId}`);
    let queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");

    // /goal 和普通文本一样只排到当前 compact 后面，不抢占正在进行的压缩。
    const queuedGoalMarker = `E2E_COMPACTING_ACTIONS_GOAL_${runId}`;
    const queuedGoalPrompt = `/goal ${queuedGoalMarker}`;
    await sendV4Prompt(queuedGoalPrompt);
    await waitForV4ComposerText("", "compacting 中 /goal 发送后输入框没有清空");
    await waitForQueueContaining(`E2E_COMPACTING_ACTIONS_GOAL_${runId}`);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.kind)).toEqual(["text", "goal"]);

    // 已经 compacting 时再次发送 /compact 是无效动作：不新增 compact 请求，也不作为用户消息展示。
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
    await waitForQueueCount(2);
    await assertVisibleV4UserMessagesNotContaining("/compact");

    await releaseControlledReplay("upstream-compact-actions-slow");
    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    expect(completedMarker.inputId).toBe(startedMarker.inputId);
    await waitForUpstreamRequestContaining(`E2E_COMPACTING_ACTIONS_TEXT_${runId}`);
    await waitForV4UserMessageContaining(queuedTextPrompt);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state === "idle" &&
        snapshot.queueCount === 0 &&
        (snapshot.targetObjective ?? "").includes(queuedGoalMarker),
      "manual compact 完成后没有继续消费 compacting 期间追加的 text/goal queue",
      120000,
    );
  });
});

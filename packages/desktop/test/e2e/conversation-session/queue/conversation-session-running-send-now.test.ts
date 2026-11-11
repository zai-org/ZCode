import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_QUEUE_SEND_NOW_BUTTON,
  TID_V4_QUEUE_ITEM_SEND_NOW,
  TID_V4_TIMELINE,
} from "@zcode/shared/test-ids";
import { clearAppData, readSettings, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import {
  TOTAL_TOKENS_BUDGET,
  totalTokensAfterLastAssistant,
  totalTokensReminders,
  withoutTotalTokensReminders,
} from "#e2e/helpers/total-tokens-evidence";
import {
  E2E_READONLY_TOOL_FILE_CONTENT,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  INCOMING_MESSAGE_MODES,
  prepareIncomingMessageCapability,
} from "#e2e/helpers/incoming-message-capability";
import {
  assertAppendOnly,
  assertPlainUserInput,
  wireText,
} from "#e2e/helpers/incoming-message-evidence";
import {
  UPSTREAM_MODEL,
  UPSTREAM_THOUGHT_LEVEL,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  countUpstreamRequestsContaining,
  getUpstreamRequestEvidence,
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  clickFirstQueueSendNow,
  clickQueueSendNow,
  getQueueItems,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ConversationState,
  getV4GoalProjection,
  getV4Messages,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const RUNNING_SEND_NOW_TIMEOUT_MS = 180000;

describe("会话区 Running Queue 立即引导 E2E", () => {
  before(async function () {
    this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

    await prepareV4ConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

    await startNewV4Draft();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const { label, mcs } of INCOMING_MESSAGE_MODES) {
    it(`M07a ${label}：running 中点击队首立即引导，原文作为普通用户消息开新一轮`, async function () {
      this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

      await prepareIncomingMessageCapability(mcs, "queue");
      const runId = Date.now();
      await startSlowRunningTurn(`E2E_RUNNING_SEND_NOW_HEAD_BASE_${runId}`);
      // 必须等当前轮产生 text-only assistant；更早轮次的文字不能作为这次抢占的锚点。
      await waitForV4AssistantMessageContaining("send-now-head-partial");

      const queuedMarker = `E2E_RUNNING_SEND_NOW_HEAD_${runId}`;
      await enqueueTextPrompt(queuedMarker);
      const queuedBeforeSendNow = await waitForQueueOrderContaining(
        [queuedMarker],
        "running send-now 队首点击前没有形成 text queue",
      );
      expect(queuedBeforeSendNow[0]?.kind).toBe("text");

      const requestsBefore = await countUpstreamRequestsContaining(queuedMarker);
      const sentNowItem = await clickFirstQueueSendNow();
      expect(sentNowItem.id).toBe(queuedBeforeSendNow[0]?.id);
      expect(sentNowItem.content).toContain(queuedMarker);

      await waitForUpstreamRequestContaining(queuedMarker, 60000);
      await waitForV4UserMessageContaining(queuedMarker);
      await waitForV4ConversationState(
        (snapshot) => snapshot.queueCount === 0,
        "running send-now 队首消息没有从 queue 消费",
        45000,
      );
      expect(await countUpstreamRequestsContaining(queuedMarker)).toBeGreaterThan(requestsBefore);
      const evidence = await getUpstreamRequestEvidence({
        includes: [queuedMarker],
        excludes: ["Generate a concise title"],
      });
      // 立即发送是用户的新指令：MCS 开关下都是普通用户文本，不带中途提示。
      const wire = await assertPlainUserInput(evidence.at(-1)!.requestJson, {
        body: buildQueuedPrompt(queuedMarker),
        evidenceLabel: `send-now-head-${label}`,
      });
      expect(wire.messages[wire.index - 1]?.role).toBe("assistant");
      expect(wireText(wire.messages[wire.index - 1]?.content)).toContain("send-now-head-partial");
      // 立即发送开新一轮，是真实用户消息：预算提醒重新起算。
      expect(totalTokensAfterLastAssistant(evidence.at(-1)!.requestJson)).toEqual([
        TOTAL_TOKENS_BUDGET,
      ]);
      const userRows = (await getV4Messages("user")).filter((message) =>
        message.text.includes(queuedMarker),
      );
      expect(userRows).toHaveLength(1);
      expect(
        await $(`[data-row-id="${userRows[0]!.id}"] [data-v4-user-input-bubble]`).getText(),
      ).toBe(buildQueuedPrompt(queuedMarker));
    });
  }

  it("running 中点击非队首 queued text 立即引导，应提升并只消费被点消息", async function () {
    this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

    const runId = Date.now();
    await startSlowRunningTurn(`E2E_RUNNING_SEND_NOW_PROMOTE_BASE_${runId}`);

    const firstMarker = `E2E_RUNNING_SEND_NOW_PROMOTE_FIRST_${runId}`;
    const secondMarker = `E2E_RUNNING_SEND_NOW_PROMOTE_SECOND_${runId}`;
    await enqueueTextPrompt(firstMarker);
    await enqueueTextPrompt(secondMarker, { slow: true });

    const queuedBeforeSendNow = await waitForQueueOrderContaining(
      [firstMarker, secondMarker],
      "running send-now 非队首点击前没有按 FIFO 呈现两条 text",
    );
    expect(queuedBeforeSendNow.map((item) => item.kind)).toEqual(["text", "text"]);
    const remainingQueueItem = queuedBeforeSendNow[0]!;
    const selectedQueueItem = queuedBeforeSendNow[1]!;

    const firstRequestsBefore = await countUpstreamRequestsContaining(firstMarker);
    const secondRequestsBefore = await countUpstreamRequestsContaining(secondMarker);
    const sentNowItem = await clickQueueSendNow(selectedQueueItem.id);
    expect(sentNowItem.id).toBe(selectedQueueItem.id);
    expect(sentNowItem.content).toContain(secondMarker);

    await waitForUpstreamRequestContaining(secondMarker, 60000);
    await waitForV4UserMessageContaining(secondMarker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.queueCount === 1,
      "running send-now 非队首被点项消费后剩余 queue 数量不对",
      45000,
    );
    const queuedAfterSendNow = await waitForQueueCount(
      1,
      "running send-now 非队首被点项消费后 queue 没有只剩未选项",
    );
    expect(queuedAfterSendNow[0]?.id).toBe(remainingQueueItem.id);
    expect(queuedAfterSendNow[0]?.content).toContain(firstMarker);
    expect(queuedAfterSendNow[0]?.content).not.toContain(secondMarker);

    const selectedUserMessage = (await getV4Messages("user")).find((message) =>
      message.text.includes(secondMarker),
    );
    expect(selectedUserMessage).toBeDefined();
    // V4 timeline message id 与 runtime command queue id 属于不同身份域；
    // 被点项是否保留以唯一 marker、用户行与剩余 queue item 共同证明。
    await expectNoUpstreamRequestForTextWithin(firstMarker, 900);
    expect(await countUpstreamRequestsContaining(firstMarker)).toBe(firstRequestsBefore);
    expect(await countUpstreamRequestsContaining(secondMarker)).toBeGreaterThan(
      secondRequestsBefore,
    );
  });

  it("running 中点击 queued /goal 立即引导，应按 goal 语义消费并更新目标", async function () {
    this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

    const runId = Date.now();
    await startSlowRunningTurn(`E2E_RUNNING_SEND_NOW_GOAL_BASE_${runId}`);

    const goalMarker = `E2E_RUNNING_SEND_NOW_GOAL_${runId}`;
    await sendV4Prompt(goalPrompt(goalMarker));
    await waitForV4ComposerText("", "running send-now goal 发送后输入框没有清空");
    const queue = await waitForQueueOrderContaining(
      [goalMarker],
      "running send-now goal 点击前没有形成 goal queue",
    );
    expect(queue[0]?.kind).toBe("goal");

    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.kind).toBe("goal");
    expect(sentNowItem.content).toContain(goalMarker);

    await browser.waitUntil(
      async () => {
        const [snapshot, goal] = await Promise.all([
          getV4ConversationState(),
          getV4GoalProjection(),
        ]);
        return (
          snapshot.queueCount === 0 &&
          goal?.objective?.includes(goalMarker) === true &&
          ["active", "verifying"].includes(goal.status ?? "")
        );
      },
      {
        timeout: 45000,
        timeoutMsg: "running send-now goal 没有按 goal intent 消费并设置目标",
      },
    );
  });

  it("running 中连续快速点两次立即引导只消费一次被点项，并保留未点 queue item", async function () {
    this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

    const runId = Date.now();
    await startSlowRunningTurn(`E2E_RUNNING_SEND_NOW_DOUBLE_BASE_${runId}`);

    const firstMarker = `E2E_RUNNING_SEND_NOW_DOUBLE_FIRST_${runId}`;
    const secondMarker = `E2E_RUNNING_SEND_NOW_DOUBLE_SECOND_${runId}`;
    await enqueueTextPrompt(firstMarker);
    await enqueueTextPrompt(secondMarker, { slow: true });

    const queuedBeforeSendNow = await waitForQueueOrderContaining(
      [firstMarker, secondMarker],
      "running send-now double click 前没有形成两条 text queue",
    );
    const remainingQueueItem = queuedBeforeSendNow[0]!;
    const selectedQueueItem = queuedBeforeSendNow[1]!;
    const firstRequestsBefore = await countUpstreamRequestsContaining(firstMarker);
    const secondRequestsBefore = await countUpstreamRequestsContaining(secondMarker);

    await doubleClickQueueSendNow(selectedQueueItem.id);
    await waitForUpstreamRequestContaining(secondMarker, 60000);
    await waitForV4UserMessageContaining(secondMarker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.queueCount === 1,
      "running send-now double click 后没有保持只消费被点项",
      45000,
    );

    // 修复原因：连续 click 会生成两个 commandId，但 CLI 对 queue item 的 reservation 是
    // 执行权边界；第二条命令必须被拒绝，不能重复 stop/drain 或顺带消费未点项。
    await expectNoUpstreamRequestForTextWithin(firstMarker, 900);
    const queuedAfterDoubleClick = await waitForQueueCount(
      1,
      "running send-now double click 后未点 queue item 没有保持在队列",
    );
    expect(queuedAfterDoubleClick[0]?.id).toBe(remainingQueueItem.id);
    expect(queuedAfterDoubleClick[0]?.content).toContain(firstMarker);
    expect(await countUpstreamRequestsContaining(firstMarker)).toBe(firstRequestsBefore);
    expect(await countUpstreamRequestsContaining(secondMarker)).toBe(secondRequestsBefore + 1);
    const selectedUserMessages = (await getV4Messages("user")).filter((message) =>
      message.text.includes(secondMarker),
    );
    expect(selectedUserMessages).toHaveLength(1);
    const remainingUserMessages = (await getV4Messages("user")).filter((message) =>
      message.text.includes(firstMarker),
    );
    expect(remainingUserMessages).toHaveLength(0);
  });

  // 放在最后：冷恢复会重启窗口，不影响前面的 case。
  it("M07m：Read 后点 queue 项立即发送，被点消息开新一轮，工作段不并入原轮", async function () {
    this.timeout(RUNNING_SEND_NOW_TIMEOUT_MS);

    // 工作段布局与来源提示能力无关，沿用默认 queue 交互，不切能力（切能力会重启窗口）。
    // 全局新建的 draft 在独立 cwd；冷恢复按默认项目找会话，所以先回到默认项目的 draft。
    await prepareV4ConversationE2E();
    expect((await readSettings()).zcodeInteractionBehavior).toBe("queue");
    await ensureReadonlyToolFixtureFile();
    const runId = Date.now();
    const markers: SendNowTimelineMarkers = {
      baseMarker: `E2E_RUNNING_SEND_NOW_SEGMENT_BASE_${runId}`,
      queuedMarker: `E2E_RUNNING_SEND_NOW_SEGMENT_ITEM_${runId}`,
      replyMarker: "send-now-segment-reply-ok",
    };
    await sendV4Prompt(`${markers.baseMarker}: Read the readonly fixture and keep working.`);
    await waitForUpstreamRequest(
      { includes: [markers.baseMarker, E2E_READONLY_TOOL_FILE_CONTENT] },
      "M07m 立即发送前没有完整 Read 结果",
      30000,
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "M07m Read 后没有保持 running",
      15000,
    );

    await enqueueTextPrompt(markers.queuedMarker);
    const queuedBeforeSendNow = await waitForQueueOrderContaining(
      [markers.queuedMarker],
      "M07m 点立即前没有形成 text queue",
    );
    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.id).toBe(queuedBeforeSendNow[0]?.id);

    // 等待必须短于 hold 响应的 60 s 延迟：实现若等原请求自然结束再开新轮，这里会超时。
    await waitForV4AssistantMessageContaining(markers.replyMarker, 30_000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "M07m 被点项回复后会话没有完成",
      45000,
    );
    // 原请求被停止：它的回复既不进入新一轮请求，也不出现在时间线（布局里的 interrupted-reply）。
    const selectedRequests = await getUpstreamRequestEvidence({
      includes: [markers.queuedMarker],
      excludes: ["Generate a concise title"],
    });
    expect(selectedRequests).toHaveLength(1);
    expect(JSON.stringify(selectedRequests[0]!.requestJson)).not.toContain(
      SEND_NOW_SEGMENT_INTERRUPTED_REPLY,
    );
    const [heldRequest] = await getUpstreamRequestEvidence({
      includes: [markers.baseMarker, E2E_READONLY_TOOL_FILE_CONTENT],
      excludes: [markers.queuedMarker, "Generate a concise title"],
    });
    expect(heldRequest).toBeDefined();
    // 被点消息是 tool_result 之后的独立用户文本。新一轮的预算提醒按投影规则并进被停止请求的
    // 最后一个 tool_result（meta-user-context.md「Total-tokens reminder」），只有这一处会变；
    // 去掉预算提醒后，被停止请求已发出的内容原样保留，新请求只在末尾追加。
    expect(totalTokensAfterLastAssistant(selectedRequests[0]!.requestJson)).toEqual([
      TOTAL_TOKENS_BUDGET - 144,
      TOTAL_TOKENS_BUDGET,
    ]);
    // 已发出的提醒数值也不变：新请求的提醒序列是被停止请求的序列加上新一轮这一条。
    expect(
      totalTokensReminders(selectedRequests[0]!.requestJson).map((item) => item.value),
    ).toEqual([
      ...totalTokensReminders(heldRequest!.requestJson).map((item) => item.value),
      TOTAL_TOKENS_BUDGET,
    ]);
    assertAppendOnly(
      withoutTotalTokensReminders(heldRequest!.requestJson),
      withoutTotalTokensReminders(selectedRequests[0]!.requestJson),
    );
    await assertPlainUserInput(selectedRequests[0]!.requestJson, {
      body: buildQueuedPrompt(markers.queuedMarker),
      evidenceLabel: "send-now-segment",
    });
    // 立即发送等于先停止原轮再开新一轮：被点消息有自己的轮次和工作段，
    // 不像 guide 那样在原轮里开新段。
    const expectedTurns = [
      ["base-user", "work-segment"],
      ["queued-user", "work-segment", "reply"],
    ];
    expect(await waitForSendNowTurnLayout(markers, expectedTurns)).toEqual(expectedTurns);

    const sessionId = (await getV4ConversationState()).taskId!;
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(60_000);
    await selectV4TaskById(sessionId);
    await waitForV4ConversationState(
      (state) => state.taskId === sessionId,
      "M07m 冷恢复未回到原会话",
      30_000,
    );
    expect(await waitForSendNowTurnLayout(markers, expectedTurns)).toEqual(expectedTurns);
  });
});

/** M07m 被停请求的 hold 回复（fixture `upstream-running-send-now-segment-hold`）。 */
const SEND_NOW_SEGMENT_INTERRUPTED_REPLY = "send-now-segment-should-be-interrupted";

interface SendNowTimelineMarkers {
  baseMarker: string;
  queuedMarker: string;
  replyMarker: string;
}

async function waitForSendNowTurnLayout(
  markers: SendNowTimelineMarkers,
  expectedTurns: string[][],
): Promise<string[][]> {
  let latest: string[][] = [];
  try {
    await browser.waitUntil(
      async () => {
        latest = await getSendNowTurnLayout(markers);
        return JSON.stringify(latest) === JSON.stringify(expectedTurns);
      },
      { timeout: 30000, timeoutMsg: "M07m 轮次与工作段没有按预期渲染" },
    );
  } catch (error) {
    throw new Error(
      `M07m 轮次布局错误; expected=${JSON.stringify(expectedTurns)}; latest=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
  return latest;
}

// 按顶层轮次分组，返回每一轮里 user 行、工作段和回复的顺序。
function getSendNowTurnLayout(markers: SendNowTimelineMarkers): Promise<string[][]> {
  return browser.execute(
    (timelineTestId, historyTriggerPrefix, expectedMarkers) => {
      const normalizeText = (value: string) => value.replace(/\u00a0/g, " ").trim();
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const turns = Array.from(
        timeline?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [],
      ).filter((turn) => !turn.parentElement?.closest("[data-turn-id]"));
      return turns
        .map((turn) =>
          Array.from(
            turn.querySelectorAll<HTMLElement>(
              `[data-row-id],[data-testid^="${historyTriggerPrefix}-"]`,
            ),
          )
            .map((element) => {
              const testIdValue = element.getAttribute("data-testid") ?? "";
              if (testIdValue.startsWith(`${historyTriggerPrefix}-`)) return "work-segment";
              const text = normalizeText(element.innerText);
              if (text.includes(expectedMarkers.baseMarker)) return "base-user";
              if (text.includes(expectedMarkers.queuedMarker)) return "queued-user";
              if (text.includes(expectedMarkers.replyMarker)) return "reply";
              // 被停请求的回复单独识别：它一旦渲染，布局必须不相等。其他不认识的行不计入布局。
              if (text.includes(expectedMarkers.interruptedReply)) return "interrupted-reply";
              return null;
            })
            .filter((item) => item !== null),
        )
        .filter((sequence) => sequence.length > 0);
    },
    TID_V4_TIMELINE,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    { ...markers, interruptedReply: SEND_NOW_SEGMENT_INTERRUPTED_REPLY },
  );
}

function buildRunningPrompt(marker: string) {
  return `E2E_HOLD_STREAM ${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

function buildQueuedPrompt(marker: string, options: { slow?: boolean } = {}) {
  const prefix = options.slow ? "E2E_SLOW_STREAM " : "";
  return `${prefix}${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

function goalPrompt(marker: string) {
  return `/goal ${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function startSlowRunningTurn(marker: string) {
  await sendV4Prompt(buildRunningPrompt(marker));
  await waitForV4ComposerText("", "running send-now 基础消息发送后输入框没有清空");
  await waitForV4UserMessageContaining(marker);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "streaming",
    "running send-now 基础消息没有进入 streaming",
    30000,
  );
}

async function enqueueTextPrompt(marker: string, options: { slow?: boolean } = {}) {
  await sendV4Prompt(buildQueuedPrompt(marker, options));
  await waitForV4ComposerText("", `running send-now queued text 没有清空: ${marker}`);
}

async function doubleClickQueueSendNow(promptId: string) {
  const clicked = await browser.execute(
    (buttonTestIds) => {
      const button = buttonTestIds
        .map((buttonTestId) =>
          document.querySelector<HTMLButtonElement>(`[data-testid="${buttonTestId}"]`),
        )
        .find((candidate) => candidate !== null);
      if (!button || button.disabled) {
        return false;
      }
      // 复现原因：该 case 要覆盖用户连续快速点两次“立即”，两个 click 必须在同一轮
      // React 状态刷新前发出，才能覆盖重复 stop/drain 的幂等边界。
      button.click();
      button.click();
      return true;
    },
    [`${TID_V4_QUEUE_ITEM_SEND_NOW}-${promptId}`, `${TID_CHAT_QUEUE_SEND_NOW_BUTTON}-${promptId}`],
  );
  expect(clicked).toBe(true);
}

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "running send-now 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
  await getQueueItems().catch(() => []);
}

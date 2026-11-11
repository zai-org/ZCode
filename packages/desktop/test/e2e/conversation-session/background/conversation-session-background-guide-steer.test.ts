import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkRequestStarted } from "#e2e/helpers/upstream-capture";
import {
  clickV4Stop,
  clickV4Send,
  getV4ConversationState,
  getV4ComposerText,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  findFirstUpstreamRequestIndex,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { getQueueItems } from "#e2e/helpers/conversation-session-queue";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { respondToToolCrossProductBlockers } from "#e2e/helpers/conversation-session-tool-cross-product";

const BACKGROUND_GUIDE_STEER_TIMEOUT_MS = 180000;

describe("会话区 Background Guide Steer E2E", () => {
  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("background Agent 创建过程中发送 guide 消息，应随 launch tool result 合流进下一次模型请求", async function () {
    this.timeout(BACKGROUND_GUIDE_STEER_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");
    await startNewV4Draft();

    const runId = Date.now();
    const launchMarker = `E2E_BACKGROUND_GUIDE_STEER_LAUNCH_${runId}`;
    const guideMarker = `E2E_BACKGROUND_GUIDE_STEER_MESSAGE_${runId}`;
    const requestCountBefore = await getUpstreamRequestRecordCount();

    await sendV4Prompt(
      `${launchMarker}: Start a background agent and keep this main turn active while I guide it.`,
    );
    await waitForV4ComposerText("", "background guide steer launch prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining(launchMarker);
    await waitForUpstreamNetworkRequestStarted(launchMarker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "background guide steer 首轮请求开始后没有保持 streaming",
      30000,
    );

    await sendPromptWithoutInputClick(
      `${guideMarker}: This guidance should be coalesced with the background launch tool result.`,
    );
    await waitForV4ComposerText("", "background guide steer 引导消息发送后输入框没有清空");
    await waitForGuideProjection(guideMarker);
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_guide_steer_agent", 60000);
    await respondToToolCrossProductBlockers();

    const coalescedIndex = await waitForFirstRequestIndex(
      {
        includes: [launchMarker, guideMarker, "Async agent launched successfully"],
        lastUserMessageExcludes: ["<task-notification>"],
      },
      requestCountBefore,
      "background guide steer 没有随 Agent launch tool result 合流进下一次模型请求",
    );
    await waitForV4AssistantMessageContaining("background-guide-steer-launch-consumed-ok");
    await waitForV4ConversationState(
      (snapshot) => snapshot.queueCount === 0,
      "background guide steer launch 合流后仍残留普通 queue",
      30000,
    );

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_GUIDE_STEER_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      coalescedIndex,
      "background guide steer Agent completion notification 没有进入父模型请求",
    );
    expect(notificationIndex).toBeGreaterThan(coalescedIndex);
    await waitForV4AssistantMessageContaining("background-guide-steer-notification-consumed-ok");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "background guide steer notification 后会话没有回到 idle",
      90000,
    );
  });
});

async function waitForFirstRequestIndex(
  query: Parameters<typeof waitForUpstreamRequest>[0],
  afterIndex: number,
  timeoutMsg: string,
) {
  await waitForUpstreamRequest(query, timeoutMsg, 45000, { afterIndex });
  const index = await findFirstUpstreamRequestIndex(query, { afterIndex });
  if (index === null) {
    throw new Error(`${timeoutMsg}; request disappeared after wait`);
  }
  return index;
}

async function waitForGuideProjection(marker: string) {
  await browser.waitUntil(
    async () => {
      const queue = await getQueueItems();
      if (queue.some((item) => item.content.includes(marker) && item.kind === "turn-steer")) {
        return true;
      }
      const snapshot = await getV4ConversationState();
      return snapshot.queueCount === 0;
    },
    {
      timeout: 30000,
      timeoutMsg: `background guide steer 没有观察到 guide 投影或合流: ${marker}`,
    },
  );
}

async function sendPromptWithoutInputClick(prompt: string) {
  const focused = await browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    input?.focus();
    return document.activeElement === input;
    // V4 已移除旧 chat-input；仍使用键盘输入，保持不点击输入框的引导场景。
  }, TID_V4_COMPOSER_INPUT);
  expect(focused).toBe(true);
  await browser.keys(prompt);
  await browser.waitUntil(async () => (await getV4ComposerText()) === prompt, {
    timeout: 10000,
    timeoutMsg: `background guide steer 没有通过键盘写入 prompt: ${prompt}`,
  });
  await clickV4Send();
}

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "background guide steer 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
}

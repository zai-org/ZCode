import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  E2E_REPLY_TOKEN,
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";

describe("会话区首发和完成态 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("首发应创建 session，完成后继续发送应进入下一轮", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const firstPrompt = buildReadonlyToolPrompt(`E2E_FIRST_SEND_${runId}`);
    await sendV4Prompt(firstPrompt);
    await waitForV4ComposerText("", "首发后输入框没有清空");
    await waitForV4UserMessageContaining(firstPrompt);
    const firstSnapshot = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "首发后 chat-view 没有回填 session/task id",
      30000,
    );
    expect(firstSnapshot.sessionId).toBeTruthy();
    expect(firstSnapshot.queueCount).toBe(0);
    await waitForUpstreamNetworkCapture(`E2E_FIRST_SEND_${runId}`);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "首轮完成后 chat-view 没有回到 idle",
      90000,
    );

    const secondPrompt = `E2E_SECOND_TURN_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(secondPrompt);
    await waitForV4ComposerText("", "第二轮发送后输入框没有清空");
    await waitForV4UserMessageContaining(secondPrompt);
    await waitForUpstreamNetworkCapture(`E2E_SECOND_TURN_${runId}`);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);

    const finalSnapshot = await getV4ConversationState();
    expect(finalSnapshot.sessionId || finalSnapshot.taskId).toBe(
      firstSnapshot.sessionId || firstSnapshot.taskId,
    );
    expect(finalSnapshot.queueCount).toBe(0);
  });
});

import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { assertPlainUserInput } from "#e2e/helpers/incoming-message-evidence";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  clickFirstQueueSendNow,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  clickV4Stop,
  getV4ComposerBackgroundWorkCounts,
  getV4ConversationState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

// M07n：前台 Agent 运行中点队列项“立即发送”，子代理转入后台继续运行，不随旧轮取消。
// fixture 见 fixtures/upstream/conversation-session/conversation-session-running-send-now-subagent.json。

const M07N_TIMEOUT_MS = 240000;
const PARENT_MARKER = "E2E_SEND_NOW_SUBAGENT_PARENT";
const PARENT_DONE = "E2E_SEND_NOW_SUBAGENT_PARENT_DONE";
const CHILD_PROMPT_PREFIX = "E2E_SEND_NOW_SUBAGENT_CHILD: work slowly";
const CHILD_RESULT = "E2E_SEND_NOW_SUBAGENT_CHILD_RESULT";
const QUEUED_PROMPT = "E2E_SEND_NOW_SUBAGENT_QUEUED: reply after the send-now.";
const QUEUED_REPLY = "E2E_SEND_NOW_SUBAGENT_QUEUED_REPLY";
const TOOL_CALL_ID = "toolu_e2e_send_now_subagent_agent";
/** 子代理回复的受控流 fixture：测试断言运行中计数后才放行。 */
const CHILD_FIXTURE_ID = "running-send-now-subagent-child-held";
const ASYNC_LAUNCHED_TEXT = "Async agent launched successfully";
const USER_STOPPED_TOOL_RESULT_PREFIX = "The user doesn't want to proceed with this tool use.";
const INTERRUPT_MARKER_PREFIX = "[Request interrupted by user";

describe("会话区立即发送时前台子代理转后台 E2E", () => {
  before(async function () {
    this.timeout(M07N_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    const snapshot = await getV4ConversationState().catch(() => null);
    if (snapshot?.state === "streaming") await clickV4Stop().catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("M07n：前台 Agent 运行中点立即发送，Agent 转后台，完成后通知回到父模型", async function () {
    this.timeout(M07N_TIMEOUT_MS);

    await sendV4Prompt(`${PARENT_MARKER}: launch one foreground Agent and wait for it.`);
    await waitForV4ComposerText("", "M07n 父消息发送后输入框没有清空");
    await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 60000);
    // 子代理请求已到 replay server，回复由受控流挂起：此时父轮停在等待前台 Agent。
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [CHILD_PROMPT_PREFIX] },
      "M07n 子代理请求没有到达 replay server",
      60000,
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "M07n 前台 Agent 运行中父会话没有保持 running",
      15000,
    );

    await sendV4Prompt(QUEUED_PROMPT);
    await waitForV4ComposerText("", "M07n 排队消息发送后输入框没有清空");
    const queued = await waitForQueueOrderContaining(
      ["E2E_SEND_NOW_SUBAGENT_QUEUED"],
      "M07n 点立即发送前没有形成 text queue",
    );
    const sentNow = await clickFirstQueueSendNow();
    expect(sentNow.id).toBe(queued[0]?.id);

    await waitForUpstreamRequestContaining("E2E_SEND_NOW_SUBAGENT_QUEUED:", 30000);
    await waitForV4UserMessageContaining("E2E_SEND_NOW_SUBAGENT_QUEUED");
    await waitForV4AssistantMessageContaining(QUEUED_REPLY, 30000);

    // 新一轮请求：Agent 的结果是成功的 async_launched，不是停止文字，也没有中断标记；
    // 被点消息是这批 tool_result 之后的普通 user 文本。工具描述里本来就有 <task-notification>，
    // 所以按请求顺序取第一条含被点消息的请求，不按正文排除通知。
    const [queuedRequest] = await getUpstreamRequestEvidence({
      includes: ["E2E_SEND_NOW_SUBAGENT_QUEUED:"],
      excludes: ["Generate a concise title"],
    });
    expect(queuedRequest).toBeDefined();
    const queuedRequestText = JSON.stringify(queuedRequest!.requestJson);
    expect(queuedRequestText).toContain(TOOL_CALL_ID);
    expect(queuedRequestText).toContain(ASYNC_LAUNCHED_TEXT);
    expect(queuedRequestText).not.toContain(USER_STOPPED_TOOL_RESULT_PREFIX);
    expect(queuedRequestText).not.toContain(INTERRUPT_MARKER_PREFIX);
    await assertPlainUserInput(queuedRequest!.requestJson, {
      body: QUEUED_PROMPT,
      evidenceLabel: "send-now-subagent",
    });

    // 父会话已空闲，子代理仍在后台运行（Activity 胶囊的运行中子代理计数）；Agent 卡片是启动成功，不是已停止。
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "M07n 被点消息回复后父会话没有回到 idle",
      30000,
    );
    expect(await readRunningSubagentCount()).toBe(1);
    expect((await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 10000)).status).toBe("completed");

    // 修复原因：原来子代理回复固定延迟 20 秒，慢机器上可能在上面的计数断言前就完成，计数变成 0。
    // 改为受控流：计数断言做完才放行子代理，断言不再依赖时钟。
    await releaseControlledReplay(CHILD_FIXTURE_ID);

    // 子代理被放行后返回结果：completed notification 回到父模型。
    await waitForUpstreamRequest(
      {
        includes: [
          PARENT_MARKER,
          CHILD_RESULT,
          `<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`,
          "<status>completed</status>",
        ],
        lastUserMessageIncludes: ["<task-notification>", "<status>completed</status>"],
      },
      "M07n 后台子代理完成通知没有进入父模型请求",
      60000,
    );
    await waitForV4AssistantMessageContaining(PARENT_DONE, 60000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming",
      "M07n 完成通知轮次没有回到 idle",
      30000,
    );
    await browser.waitUntil(async () => (await readRunningSubagentCount()) === 0, {
      timeout: 30000,
      timeoutMsg: "M07n 子代理完成后 Activity 胶囊仍显示运行中的子代理",
    });
    expect((await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 10000)).status).toBe("completed");

    // 冷恢复：重启应用后从持久化记录重建“前台 Agent → async_launched → 后台完成”这组事件。
    // 子代理已完成才重启；运行中重启会结束 agent 进程，测的就变成崩溃恢复。
    const sessionId = (await getV4ConversationState()).taskId!;
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(60_000);
    await selectV4TaskById(sessionId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sessionId,
      "M07n 冷恢复没有回到原会话",
      30_000,
    );
    await waitForV4UserMessageContaining("E2E_SEND_NOW_SUBAGENT_QUEUED");
    await waitForV4AssistantMessageContaining(QUEUED_REPLY, 30000);
    await waitForV4AssistantMessageContaining(PARENT_DONE, 30000);
    expect((await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 30000)).status).toBe("completed");
    expect(await readRunningSubagentCount()).toBe(0);
  });
});

// 修复原因：原来读右上角状态面板的 data-running-agent-count；staging 0876b488d3 退役了该面板，
// 计数恒为 0。改读 Composer Activity 胶囊的运行中子代理计数，没有运行项时胶囊不计数，记为 0。
async function readRunningSubagentCount(): Promise<number> {
  return (await getV4ComposerBackgroundWorkCounts())?.subagentCount ?? 0;
}

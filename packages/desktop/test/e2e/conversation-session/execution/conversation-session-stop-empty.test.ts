import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";

describe("会话区 Stop Empty Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("stop 后 queue=0 应退出 running，之后普通文本应立即开始下一轮", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const firstPrompt = `E2E_SLOW_STREAM E2E_STOP_EMPTY_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(firstPrompt);
    await waitForV4ComposerText("", "空队列 stop 首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "空队列 stop 首轮没有进入 streaming",
      30000,
    );
    await waitForUpstreamNetworkRequestStarted(`E2E_STOP_EMPTY_RUNNING_${runId}`);

    // V4 的 Stop 控件和队列/目标投影是当前状态来源；旧 runtimeStatus 已不再写入。
    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "空队列 stop 后没有退出 running completed 态",
      30000,
    );

    const nextPrompt = `E2E_STOP_EMPTY_NEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(nextPrompt);
    await waitForV4ComposerText("", "空队列 stop 后下一轮发送没有清空输入框");
    await waitForUpstreamNetworkCapture(`E2E_STOP_EMPTY_NEXT_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "空队列 stop 后下一轮没有完成并保持 queue=0",
      90000,
    );
  });

  it("tool call 运行中 stop 后 queue=0，之后普通文本应立即开始下一轮", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const toolPrompt = `E2E_STOP_EMPTY_TOOLCALL_RUNNING_${runId}: Start a long Bash tool call, then wait.`;
    await sendV4Prompt(toolPrompt);
    await waitForV4ComposerText("", "toolcall stop 首轮发送后输入框没有清空");
    await waitForUpstreamNetworkRequestStarted(`E2E_STOP_EMPTY_TOOLCALL_RUNNING_${runId}`);
    await waitForToolCallBlockByToolCallId("toolu_e2e_stop_empty_toolcall_bash", 30000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "toolcall stop 首轮没有保持 streaming 且 queue=0",
      30000,
    );

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "toolcall stop 后没有退出 running completed 态",
      30000,
    );

    const nextPrompt = `E2E_STOP_EMPTY_TOOLCALL_NEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(nextPrompt);
    await waitForV4ComposerText("", "toolcall stop 后下一轮发送没有清空输入框");
    await waitForUpstreamNetworkCapture(`E2E_STOP_EMPTY_TOOLCALL_NEXT_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "toolcall stop 后下一轮没有完成并保持 queue=0",
      90000,
    );
  });
});

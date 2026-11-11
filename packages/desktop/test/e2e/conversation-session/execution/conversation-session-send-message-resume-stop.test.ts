import { readFile } from "node:fs/promises";
import { TID_CHAT_SUMMARY_PANEL, TID_V4_SUBAGENT_OPEN_SIDE_PANE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  getV4ComposerBackgroundWorkCounts,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import {
  clickRunningSubagentStop,
  countVisibleSubagentTabs,
  openRunningSubagentCapsule,
  readRunningSubagentControls,
  type RunningSubagentControl,
} from "#e2e/helpers/subagent-capsule-stop";

const PARENT_MARKER = "E2E_SEND_MESSAGE_RESUME_STOP_PARENT";
const FOREGROUND_DONE = "E2E_SEND_MESSAGE_RESUME_STOP_FOREGROUND_DONE";
const FOREGROUND_PARENT_IDLE = "E2E_SEND_MESSAGE_RESUME_STOP_FOREGROUND_PARENT_IDLE";
const RESUME_MARKER = "E2E_SEND_MESSAGE_RESUME_STOP_RESUME";
const CHILD_DONE = "E2E_SEND_MESSAGE_RESUME_STOP_CHILD_DONE";
const STOP_NOTIFICATION_DONE = "E2E_SEND_MESSAGE_RESUME_STOP_NOTIFICATION_DONE";

describe("SendMessage resume Stop", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT12: foreground subagent 完成后由 SendMessage resume 显示 Stop 且可停止", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const parentRunMarker = `${PARENT_MARKER}_${runId}`;
    await sendV4PromptAndWaitAccepted(
      [
        `${parentRunMarker}: call Agent exactly once with run_in_background false and subagent_type "general-purpose".`,
        `Tell the child to reply with exactly ${FOREGROUND_DONE}_${runId} and do nothing else.`,
        "After that foreground Agent completes, call no more tools and finish this turn.",
      ].join(" "),
      parentRunMarker,
      "foreground Agent 首发后用户消息没有进入 timeline",
      90000,
    );
    await waitForToolCallBlockByToolName("Agent", 90000);
    await waitForV4AssistantMessageContaining(FOREGROUND_PARENT_IDLE, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && !snapshot.stopRequested,
      "foreground Agent 完成后父 turn 没有回到 idle",
      90000,
    );
    expect((await waitForToolCallBlockByToolName("Agent", 30000)).status).toBe("completed");
    await waitForUpstreamRequest(
      {
        includes: [parentRunMarker, FOREGROUND_DONE, "agentId: agent_"],
        excludes: ["resumed it in the background"],
      },
      "foreground Agent 完成结果没有进入父模型请求",
      90000,
    );

    // 测试修复原因：resume 会原地更新同一 subagent projection；若等 resume 后再读
    // identity，新建 child 也可能让 row/work 自洽通过。必须在第二个 turn 前固化原身份。
    const foregroundAgentId = await readForegroundAgentId(parentRunMarker);
    const foregroundChildSessionId = await waitForSingleSubagentSummaryChildSessionId(30000);

    const resumeRunMarker = `${RESUME_MARKER}_${runId}`;
    await sendV4PromptAndWaitAccepted(
      [
        `${resumeRunMarker}: read the agentId from the completed Agent result and call SendMessage exactly once for that same agent.`,
        "Omit the optional summary.",
        `Use this exact message verbatim: You MUST invoke the Bash tool with command "sleep 120". Do not send any text before the Bash tool finishes. After it finishes, reply with exactly ${CHILD_DONE}_${runId}.`,
        "After SendMessage returns, call no more tools and finish this turn without waiting for the resumed agent.",
      ].join(" "),
      resumeRunMarker,
      "SendMessage resume 首发后用户消息没有进入 timeline",
      90000,
    );
    await waitForToolCallBlockByToolName("SendMessage", 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && !snapshot.stopRequested,
      "SendMessage resume 后父 turn 没有回到 idle",
      90000,
    );
    const sendMessageBlock = await waitForToolCallBlockByToolName("SendMessage", 30000);
    expect(sendMessageBlock.status).toBe("completed");
    // SendMessage 的 summary 可选：省略时卡片标题显示 message 的第一行。
    expect(sendMessageBlock.text).toContain(
      'You MUST invoke the Bash tool with command "sleep 120".',
    );
    expect(await waitForSingleSubagentSummaryChildSessionId(30000)).toBe(foregroundChildSessionId);

    await openRunningSubagentCapsule(90000);
    const control = await waitForSingleRunningSubagent(30000);
    expect(control.taskId).toBe(foregroundAgentId);
    expect(control.childSessionId).toBe(foregroundChildSessionId);
    expect(control.executionId).not.toBe("");
    expect(control.stopDisabled).toBe(false);
    expect((await getV4ComposerBackgroundWorkCounts())?.subagentCount).toBe(1);
    expect(await countVisibleSubagentTabs()).toBe(0);

    const requestCountBeforeStop = await getUpstreamRequestRecordCount();
    // Stop 必须携带本次执行 token；不能再从 backgroundWorks 猜测控制身份。
    const ack = await clickRunningSubagentStop(control);
    expect(ack.status).toBe("accepted");

    // 测试修复原因：running row 会早于后台 completion notification turn 收口；只等
    // UI 消失会让晚到的 provider 失败漏检。先观察 notification request 与唯一完成文本。
    await waitForUpstreamRequest(
      {
        includes: [
          PARENT_MARKER,
          "<task-notification>",
          "<tool-use-id>toolu_e2e_send_message_resume_stop_send_message</tool-use-id>",
          // 停止状态词是 killed，summary 写明是用户停止的。
          "<status>killed</status>",
          "was stopped by user</summary>",
        ],
        lastUserMessageIncludes: ["<task-notification>", "<status>killed</status>"],
      },
      "Stop 后 resumed subagent completion notification 没有进入父模型请求",
      60000,
      { afterIndex: requestCountBeforeStop - 1 },
    );
    await waitForV4AssistantMessageContaining(STOP_NOTIFICATION_DONE, 60000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && !snapshot.stopRequested,
      "Stop completion notification turn 没有回到 idle",
      60000,
    );
    await waitForResumedSubagentStopped(control.childSessionId, 60000);
    expect(await countVisibleSubagentTabs()).toBe(0);
  });
});

async function readForegroundAgentId(runMarker: string): Promise<string> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("E2E_PROVIDER_CAPTURE_PATH 未配置，无法读取 foreground agentId");
  }
  const artifact = JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
  for (const record of artifact.records) {
    const requestText = JSON.stringify(record.requestJson ?? null);
    if (!requestText.includes(runMarker) || !requestText.includes(FOREGROUND_DONE)) continue;
    const agentId = /agentId:\s*(agent_[A-Za-z0-9_-]+)/u.exec(requestText)?.[1];
    if (agentId) return agentId;
  }
  throw new Error(`没有从 foreground Agent tool result 读取到 agentId: ${runMarker}`);
}

async function waitForSingleRunningSubagent(timeout: number): Promise<RunningSubagentControl> {
  let running: RunningSubagentControl[] = [];
  await browser.waitUntil(
    async () => {
      running = await readRunningSubagentControls();
      return running.length === 1 && Boolean(running[0]?.executionId);
    },
    {
      timeout,
      timeoutMsg: "没有等到唯一且带 execution token 的 resumed subagent",
    },
  );
  return running[0]!;
}

async function waitForSingleSubagentSummaryChildSessionId(timeout: number): Promise<string> {
  let childSessionIds: string[] = [];
  await browser.waitUntil(
    async () => {
      childSessionIds = await browser.execute(
        (prefix) =>
          Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map(
            (element) => (element.getAttribute("data-testid") ?? "").slice(prefix.length + 1),
          ),
        TID_V4_SUBAGENT_OPEN_SIDE_PANE,
      );
      return childSessionIds.length === 1 && Boolean(childSessionIds[0]);
    },
    {
      timeout,
      timeoutMsg: "没有等到唯一的 foreground subagent child identity",
    },
  );
  return childSessionIds[0]!;
}

async function waitForResumedSubagentStopped(
  childSessionId: string,
  timeout: number,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const [running, composerCounts, runningAgentCount] = await Promise.all([
        readRunningSubagentControls(),
        getV4ComposerBackgroundWorkCounts(),
        readStatusPanelRunningAgentCount(),
      ]);
      return (
        !running.some((item) => item.childSessionId === childSessionId) &&
        composerCounts === null &&
        runningAgentCount === 0
      );
    },
    {
      timeout,
      timeoutMsg: "点击 Stop 后 resumed subagent 的胶囊、右上角入口或 running row 没有收口",
    },
  );
}

async function readStatusPanelRunningAgentCount(): Promise<number> {
  return browser.execute((panelTestId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
    return Number(panel?.dataset.runningAgentCount ?? "0");
  }, TID_CHAT_SUMMARY_PANEL);
}

import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  waitForUpstreamRequest,
  getUpstreamRequestRecordCount,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  clickRunningSubagentStop,
  countVisibleSubagentTabs,
  openRunningSubagentCapsule,
  readRunningSubagentControls,
  type RunningSubagentControl,
} from "#e2e/helpers/subagent-capsule-stop";
import {
  getV4ComposerBackgroundWorkCounts,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_CAPSULE_FOREGROUND_STOP";
const STOP_TOOL = "toolu_e2e_capsule_foreground_stop";
const KEEP_TOOL = "toolu_e2e_capsule_foreground_keep";
const KEEP_GATE = "capsule-foreground-keep-controlled";

// SAT12 候选：需先完成 manual/capture 与 replay review，不能将类型检查视为覆盖证据。
describe("SAT12 foreground capsule Stop candidate", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("仅停止指定 foreground child，父 Agent 收到原工具结果，另一 child 继续完成", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    const runMarker = `${MARKER}_${Date.now()}`;
    await sendV4PromptAndWaitAccepted(
      `${runMarker}: launch two foreground Agent calls in parallel. One replies STOP_CHILD, the other replies KEEP_CHILD. Wait for both results, then finish.`,
      runMarker,
      "foreground 两个 Agent 首发后用户消息没有进入 timeline",
      90000,
    );
    await openRunningSubagentCapsule(90000);

    let stop: RunningSubagentControl | undefined;
    let keep: RunningSubagentControl | undefined;
    await browser.waitUntil(
      async () => {
        const controls = await readRunningSubagentControls();
        stop = controls.find((row) => row.title.includes("Stop target foreground child"));
        keep = controls.find((row) => row.title.includes("Keep running foreground child"));
        return Boolean(
          stop?.stopVisible && keep?.stopVisible && stop.executionId && keep.executionId,
        );
      },
      { timeout: 90000, timeoutMsg: "没有同时出现两个带精确 Stop token 的 foreground child" },
    );
    expect(stop!.taskId).not.toBe(keep!.taskId);
    expect(stop!.executionId).not.toBe(keep!.executionId);
    expect(stop!.childSessionId).not.toBe(keep!.childSessionId);
    expect((await getV4ComposerBackgroundWorkCounts())?.subagentCount).toBe(2);
    expect(await countVisibleSubagentTabs()).toBe(0);

    const beforeStop = await getUpstreamRequestRecordCount();
    const ack = await clickRunningSubagentStop(stop!);
    expect(ack.status).toBe("accepted");
    await browser.waitUntil(
      async () => {
        const controls = await readRunningSubagentControls();
        return (
          !controls.some((row) => row.childSessionId === stop!.childSessionId) &&
          controls.some(
            (row) =>
              row.childSessionId === keep!.childSessionId &&
              row.taskId === keep!.taskId &&
              row.executionId === keep!.executionId,
          )
        );
      },
      { timeout: 60000, timeoutMsg: "目标 child 没收口或 sibling 执行身份被误停" },
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming" && !snapshot.stopRequested,
      "停止单个 child 误停了父 turn",
      30000,
    );
    expect(await countVisibleSubagentTabs()).toBe(0);
    await releaseControlledReplay(KEEP_GATE);
    await browser.waitUntil(
      async () => (await waitForToolCallBlockByToolCallId(KEEP_TOOL, 10000)).status === "completed",
      { timeout: 90000, timeoutMsg: "放行后的 sibling Agent 没有完成" },
    );

    const stoppedResult = await waitForToolCallBlockByToolCallId(STOP_TOOL, 90000);
    const keptResult = await waitForToolCallBlockByToolCallId(KEEP_TOOL, 90000);
    expect(stoppedResult.status).not.toBe("running");
    expect(stoppedResult.text.toLowerCase()).toMatch(/stop|cancel|abort/u);
    expect(keptResult.status).toBe("completed");
    await waitForUpstreamRequest(
      {
        includes: [runMarker, STOP_TOOL, KEEP_TOOL, "E2E_CAPSULE_KEEP_DONE"],
        excludes: ["<task-notification>"],
      },
      "父模型未收到被停止 foreground Agent 的原工具结果和 sibling 完成结果",
      90000,
      { afterIndex: beforeStop - 1 },
    );
    await waitForV4AssistantMessageContaining("E2E_CAPSULE_PARENT_DONE", 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && !snapshot.stopRequested,
      "两个 foreground tool result 后父 turn 没有结束",
      90000,
    );
    expect(await readRunningSubagentControls()).toHaveLength(0);
  });
});

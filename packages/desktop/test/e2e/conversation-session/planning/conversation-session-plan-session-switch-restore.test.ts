import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  waitForToolCallBlockByToolCallId,
  waitForToolCallBlockContaining,
} from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_PLAN_SESSION_SWITCH_RESTORE";
const ENTER_MARKER = "E2E_PLAN_SESSION_SWITCH_ENTER";
const EXIT_MARKER = "E2E_PLAN_SESSION_SWITCH_EXIT";
const PLAN_MARKER = "E2E_PLAN_SESSION_SWITCH_RESTORED_BODY";
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_session_switch_exit";

describe("conversation session ExitPlanMode session switch restore", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("切走期间完成 ExitPlanMode 参数后，切回无需 stop 即展示完整 plan", async function () {
    this.timeout(90_000);
    await prepareV4ConversationE2E();

    const prompt = [
      `${PROMPT_MARKER}: enter plan mode and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode first.`,
      `${EXIT_MARKER}: then call ExitPlanMode with the proposed plan and include ${PLAN_MARKER}.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan session switch initial request",
      60_000,
    );
    // EnterPlanMode 是隐藏的控制工具；用真实结果证明进入计划模式。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_e2e_plan_session_switch_enter"))
          ?.isError === false,
      { timeout: 60000, timeoutMsg: "EnterPlanMode 没有成功执行" },
    );
    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_session_switch_enter"],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan session switch ExitPlanMode request",
      60_000,
    );

    const sourceSnapshot = await getV4ConversationState();
    const sourceTaskId = sourceSnapshot.taskId;
    if (!sourceTaskId) {
      throw new Error(`ExitPlanMode 流式预览缺少 taskId: ${JSON.stringify(sourceSnapshot)}`);
    }
    // 真实 SSE 在部分 tool input 后等待测试释放；不向已移除的 renderer 消息 store 注入预览。
    const streamingPreview = await waitForToolCallBlockByToolCallId(EXIT_TOOL_CALL_ID, 30_000);
    expect(streamingPreview.text).not.toContain(PLAN_MARKER);

    await startNewV4Draft();
    expect((await getV4ConversationState()).taskId).not.toBe(sourceTaskId);
    await releaseControlledReplay(
      "upstream-conversation-plan-session-switch-exit-controlled-stream",
    );
    // 以后台工具输入落盘为屏障，证明完整参数在切回前已到达，不按响应耗时猜测。
    await browser.waitUntil(() => hasCompletedExitPlanInput(sourceTaskId), {
      timeout: 30000,
      timeoutMsg: "后台 ExitPlanMode 的完整参数未持久化",
    });

    await selectV4TaskById(sourceTaskId);
    const restoredSnapshot = await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sourceTaskId && snapshot.state === "streaming",
      "切回后原 task 没有恢复到等待计划审批的运行态",
      30_000,
    );
    const restoredPlan = await waitForToolCallBlockContaining(PLAN_MARKER, 30_000);

    expect(restoredSnapshot.stopRequested).toBe(false);
    expect(restoredPlan.toolCallId).toBe(EXIT_TOOL_CALL_ID);
    expect(restoredPlan.toolName).toBe("ExitPlanMode");
    expect(restoredPlan.text).toContain(PLAN_MARKER);
    expect(restoredPlan.text).not.toContain("Unknown");
    await waitForPlanApprovalDialog(30_000);

    // 清理仍在等待审批的 turn；核心断言已在 stop 前完成。
    await browser.keys("Escape");
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sourceTaskId && snapshot.state !== "streaming",
      "拒绝计划审批后 task 没有退出运行态",
      30_000,
    );
  });
});

async function waitForPlanApprovalDialog(timeoutMs: number) {
  await browser.waitUntil(
    async () => {
      const body = await $("[data-elicitation-dialog-body='true']");
      if (!(await body.isExisting())) {
        return false;
      }
      const bodyText = await body.getText();
      return ["Approve", "批准", "Implementation plan", "实施计划"].some((text) =>
        bodyText.includes(text),
      );
    },
    {
      timeout: timeoutMs,
      timeoutMsg: "没有出现 ExitPlanMode 计划审批弹窗",
    },
  );
}

function hasCompletedExitPlanInput(taskId: string): boolean {
  const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli/db/db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.callID') = ?",
      )
      .get(taskId, EXIT_TOOL_CALL_ID) as { data: string } | undefined;
    if (!row) return false;
    const part = JSON.parse(row.data) as { tool?: string; state?: { input?: { plan?: string } } };
    return part.tool === "ExitPlanMode" && Boolean(part.state?.input?.plan?.includes(PLAN_MARKER));
  } finally {
    db.close();
  }
}

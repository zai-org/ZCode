// PV4-21/PV4-22：editUserQuery(workspaceMode=rewind) 的文件事务与冲突降级。
// 证据层 L3：真实 Read/Write checkpoint + 行内三按钮 + Agent preview/apply +
// same-session branch cut。冲突路径还断言 blocked 期间文件/对话/provider request 均不变。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_FEEDBACK_LIKE } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import {
  approveV4Permission,
  beginFirstV4UserQueryEdit,
  clickV4EditConflictConversationOnly,
  clickV4EditWorkspaceReset,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Edit,
  waitForV4EditWorkspaceConflict,
  waitForLatestV4CommandAck,
  waitForV4Pane,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  beginConversationTelemetryCapture,
  readAllEventReportRequests,
  type ConversationTelemetryCaptureHandle,
  type ConversationTelemetryReport,
} from "#e2e/helpers/conversation-telemetry-parity-capture";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "v4-rewind-files-e2e");
const SAFE_RELATIVE_PATH = "v4-rewind-files-e2e/safe.txt";
const CONFLICT_RELATIVE_PATH = "v4-rewind-files-e2e/conflict.txt";
const SAFE_PATH = join(DEFAULT_WORKSPACE, SAFE_RELATIVE_PATH);
const CONFLICT_PATH = join(DEFAULT_WORKSPACE, CONFLICT_RELATIVE_PATH);
// fixtures/upstream/conversation-session/conversation-session-v4-rewind-files.json 里 PV4-21 原轮的两个工具调用。
const SAFE_READ_TOOL_ID = "toolu_v4_rewind_files_safe_read";
const SAFE_WRITE_TOOL_ID = "toolu_v4_rewind_files_safe_write";

describe("PV4-21/PV4-22 conversation + file rewind", () => {
  afterEach(async () => {
    await rm(CASE_ROOT, { force: true, recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PV4-21 safe checkpoint 倒序恢复文件后才提交 same-session branch", async function () {
    this.timeout(150000);
    await prepareFileCase(SAFE_PATH);
    const capture = await beginConversationTelemetryCapture();

    await sendV4Prompt("E2E_V4_REWIND_FILE_SAFE 请更新 safe.txt");
    await approvePendingFileWriteIfRequired();
    await waitForV4TimelineContaining("V4_REWIND_FILE_SAFE_ORIGINAL_REPLY", 90000);
    await waitForFileContent(SAFE_PATH, "safe-after\n");
    const originalSessionId = (await getV4PaneSnapshot()).sessionId;
    // 点赞埋点要关联到所在轮：先赞原回复，编辑重发后再赞新回复（MR E source_message_id）。
    await clickOnlyFeedbackLike();

    await waitForV4Edit();
    const rowId = await beginFirstV4UserQueryEdit("E2E_V4_REWIND_FILE_SAFE_EDITED 文件恢复后重发");
    await clickV4EditWorkspaceReset(rowId);

    const rewindAck = await waitForLatestV4CommandAck("editUserQuery", 30000).catch(
      async (error) => {
        const fileState = await readFile(SAFE_PATH, "utf8").catch(() => "<missing>");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; safe.txt=${JSON.stringify(fileState)}`,
        );
      },
    );
    expect(rewindAck.status).toBe("accepted");

    await waitForV4TimelineContaining("V4_REWIND_FILE_SAFE_EDITED_REPLY", 90000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "safe 组合 rewind 没有回到 idle", 60000);
    expect(await readFile(SAFE_PATH, "utf8")).toBe("safe-before\n");
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.sessionId).toBe(originalSessionId);
    expect(finalSnapshot.timelineText).not.toContain("V4_REWIND_FILE_SAFE_ORIGINAL_REPLY");
    expect(finalSnapshot.timelineText).not.toContain("Conversation rewind applied");
    await clickOnlyFeedbackLike();
    // 再点一次取消：上报 reaction=none，同样带所在轮。
    await clickOnlyFeedbackLike(false);

    // 编辑重发轮与普通发送一样有 send_btn / completion（send_type=edit），并记一条回退结果。
    const { reports, rewinds } = await waitForEditTelemetry(capture, 1);
    const original = reports.find(
      (r) => r.element_name === "send_btn" && detail(r).send_type === "normal",
    );
    expect(rewinds[0]!.talk_id).toBe(original?.talk_id);
    expect(detail(rewinds[0]!)).toMatchObject({
      action: "edit_resend",
      workspace_mode: "rewind",
      result: "accepted",
      blocked_reason: "",
      target_message_id: original?.message_id,
      target_turn_state: "completedSuccess",
      discarded_turns: "1",
    });
    expectEditTurnReported(reports, String(rewinds[0]!.message_id));

    // 反馈的 message_id 是 assistant 行 entityId；source_message_id 才是所在轮的
    // send_btn / message_completion message_id：原回复对应普通发送，新回复对应编辑重发轮。
    const { all, feedbacks } = await waitForFeedbackReports(capture, 3);
    expect(feedbacks).toHaveLength(3);
    expect(detail(feedbacks[0]!)).toMatchObject({
      reaction: "like",
      source_message_id: original?.message_id,
    });
    for (const [index, reaction] of [
      [1, "like"],
      [2, "none"],
    ] as const) {
      expect(detail(feedbacks[index]!)).toMatchObject({
        reaction,
        source_message_id: rewinds[0]!.message_id,
      });
      expect(feedbacks[index]!.message_id).toBe(feedbacks[1]!.message_id);
    }
    for (const feedback of feedbacks) {
      expect(feedback.talk_id).toBe(original?.talk_id);
      expect(feedback.message_id).toBeTruthy();
      expect(feedback.message_id).not.toBe(detail(feedback).source_message_id);
    }
    expect(feedbacks[0]!.message_id).not.toBe(feedbacks[1]!.message_id);
    // 数据侧真正要的是按这个 ID 找到该轮的分析事件：原轮的 completion 与 Read、Write 两个工具 step
    // 都要以同一个 message_id 上报（按 fixture 的 tool_call_id 逐个核对，只数条数分不出重复的 Read）；
    // 编辑重发轮的 fixture 只回文本，它只核对 send_btn / completion（expectEditTurnReported）。
    const sourceId = detail(feedbacks[0]!).source_message_id;
    const turnEvents = (name: string) =>
      all.filter(
        (r) =>
          r.element_name === name && r.message_id === sourceId && r.talk_id === original?.talk_id,
      );
    expect(turnEvents("message_completion")).toHaveLength(1);
    const toolCallIds = turnEvents("agent_step")
      .filter((r) => detail(r).step_type === "tool_call")
      .map((r) => detail(r).tool_call_id);
    expect(toolCallIds).toEqual(expect.arrayContaining([SAFE_READ_TOOL_ID, SAFE_WRITE_TOOL_ID]));
  });

  it("PV4-22 external modified 先 blocked，新 commandId 降级后只裁对话", async function () {
    this.timeout(150000);
    await prepareFileCase(CONFLICT_PATH);
    const capture = await beginConversationTelemetryCapture();

    await sendV4Prompt("E2E_V4_REWIND_FILE_CONFLICT 请更新 conflict.txt");
    await approvePendingFileWriteIfRequired();
    await waitForV4TimelineContaining("V4_REWIND_FILE_CONFLICT_ORIGINAL_REPLY", 90000);
    await waitForFileContent(CONFLICT_PATH, "conflict-after\n");
    await writeFile(CONFLICT_PATH, "external-wins\n", "utf8");

    const editedMarker = "E2E_V4_REWIND_FILE_CONFLICT_EDITED";
    const requestsBefore = await countUpstreamRequestsContaining(editedMarker);
    await waitForV4Edit();
    const rowId = await beginFirstV4UserQueryEdit(`${editedMarker} 只重置对话`);
    await clickV4EditWorkspaceReset(rowId);
    await waitForV4EditWorkspaceConflict(60000);

    expect(await readFile(CONFLICT_PATH, "utf8")).toBe("external-wins\n");
    expect((await getV4PaneSnapshot()).timelineText).toContain(
      "V4_REWIND_FILE_CONFLICT_ORIGINAL_REPLY",
    );
    expect(await countUpstreamRequestsContaining(editedMarker)).toBe(requestsBefore);

    await clickV4EditConflictConversationOnly();
    await waitForV4TimelineContaining("V4_REWIND_FILE_CONFLICT_EDITED_REPLY", 90000);
    expect(await readFile(CONFLICT_PATH, "utf8")).toBe("external-wins\n");
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.timelineText).not.toContain("V4_REWIND_FILE_CONFLICT_ORIGINAL_REPLY");
    expect(await countUpstreamRequestsContaining(editedMarker)).toBe(requestsBefore + 1);

    // 冲突那次只记 blocked、不产生 send_btn；降级后的「只重置对话」才是真正的编辑重发轮。
    const { reports, rewinds } = await waitForEditTelemetry(capture, 2);
    expect(detail(rewinds[0]!)).toMatchObject({
      action: "edit_resend",
      workspace_mode: "rewind",
      result: "blocked",
    });
    expect(["unsafe_files", "apply_conflict"]).toContain(detail(rewinds[0]!).blocked_reason);
    expect(detail(rewinds[1]!)).toMatchObject({
      action: "edit_resend",
      workspace_mode: "preserve",
      result: "accepted",
      target_turn_state: "completedSuccess",
      target_message_id: detail(rewinds[0]!).target_message_id,
    });
    expect(
      reports.filter(
        (r) => r.element_name === "send_btn" && r.message_id === rewinds[0]!.message_id,
      ),
    ).toHaveLength(0);
    expectEditTurnReported(reports, String(rewinds[1]!.message_id));
  });
});

async function prepareFileCase(filePath: string) {
  await rm(CASE_ROOT, { force: true, recursive: true });
  await mkdir(CASE_ROOT, { recursive: true });
  await writeFile(filePath, filePath === SAFE_PATH ? "safe-before\n" : "conflict-before\n", "utf8");
  await prepareV4ConversationE2E();
  await switchV4Mode("yolo");
}

async function waitForFileContent(filePath: string, expected: string) {
  await browser.waitUntil(
    async () => (await readFile(filePath, "utf8").catch(() => "")) === expected,
    { timeout: 60000, timeoutMsg: `${filePath} 没有收敛到期望内容` },
  );
}

async function approvePendingFileWriteIfRequired() {
  try {
    await waitForV4PermissionDialog(15000);
    expect(await approveV4Permission()).toBe(true);
  } catch {
    // yolo 模式会直接执行；不同 permission registry 状态下也可能显式请求一次授权。
  }
}

function detail(report: ConversationTelemetryReport): Record<string, string> {
  return (report.event_extra_detail ?? {}) as Record<string, string>;
}

async function waitForEditTelemetry(
  capture: ConversationTelemetryCaptureHandle,
  rewindCount: number,
) {
  let reports: ConversationTelemetryReport[] = [];
  const editCompletions = () =>
    reports.filter(
      (r) => r.element_name === "message_completion" && detail(r).send_type === "edit",
    );
  await browser.waitUntil(
    async () => {
      reports = await readAllEventReportRequests(capture);
      return (
        reports.filter((r) => r.element_name === "conversation_rewind").length >= rewindCount &&
        editCompletions().length >= 1
      );
    },
    { timeout: 30000, timeoutMsg: "编辑重发的 conversation_rewind / message_completion 没有上报" },
  );
  return { reports, rewinds: reports.filter((r) => r.element_name === "conversation_rewind") };
}

function expectEditTurnReported(reports: ConversationTelemetryReport[], messageId: string) {
  const sends = reports.filter((r) => r.element_name === "send_btn" && r.message_id === messageId);
  expect(sends).toHaveLength(1);
  expect(detail(sends[0]!).send_type).toBe("edit");
  const completion = reports.find(
    (r) => r.element_name === "message_completion" && r.message_id === messageId,
  );
  expect(completion && detail(completion)).toMatchObject({ send_type: "edit", status: "success" });
}

/** 时间线里此刻只有一条可反馈的回复：悬停轮尾露出操作栏后点赞（或取消），等按钮状态变化。 */
async function clickOnlyFeedbackLike(expectPressed = true) {
  const selector = `[data-testid^="${TID_V4_FEEDBACK_LIKE}-"]`;
  await browser.waitUntil(async () => (await $$(selector).length) === 1, {
    timeout: 30000,
    timeoutMsg: "时间线里应恰好有一个点赞按钮",
  });
  const button = await $(selector);
  // 操作栏平时透明，悬停所在轮才显现；先滚到视口中间再悬停，避免点到输入框上。
  await browser.execute((element) => element.scrollIntoView({ block: "center" }), button);
  await button.moveTo();
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await browser.waitUntil(
    async () => (await button.getAttribute("aria-pressed")) === String(expectPressed),
    { timeout: 10000, timeoutMsg: `点击后点赞按钮 aria-pressed 没有变成 ${String(expectPressed)}` },
  );
}

async function waitForFeedbackReports(capture: ConversationTelemetryCaptureHandle, count: number) {
  let all: ConversationTelemetryReport[] = [];
  const feedbacks = () => all.filter((r) => r.element_name === "assistant_message_feedback");
  await browser.waitUntil(
    async () => {
      all = await readAllEventReportRequests(capture);
      return feedbacks().length >= count;
    },
    { timeout: 30000, timeoutMsg: "assistant_message_feedback 没有上报" },
  );
  return { all, feedbacks: feedbacks() };
}

import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import {
  beginConversationTelemetryCapture,
  readAllEventReportRequests,
  type ConversationTelemetryCaptureHandle,
  type ConversationTelemetryReport,
} from "#e2e/helpers/conversation-telemetry-parity-capture";

const PROMPT_MARKER = "E2E_TOOL_INPUT_VALIDATION_PROVIDER_CONTENT";
const COLD_PROMPT_MARKER = "E2E_TOOL_INPUT_VALIDATION_COLD_REPLAY";
const RAW_INPUT_MARKER = "E2E_TOOL_INPUT_VALIDATION_RAW_INPUT";
const RAW_INPUT = `not-json-${RAW_INPUT_MARKER}`;
const LIVE_DONE = "E2E_TOOL_INPUT_VALIDATION_LIVE_OK";
const COLD_DONE = "E2E_TOOL_INPUT_VALIDATION_COLD_OK";
const TOOL_CALL_ID = "toolu_e2e_tool_input_validation";
const TOOL_NAME = "AskUserQuestion";
const LEGACY_VALIDATION_CONTENT = "Tool input failed inputSchema validation";
// 入参 JSON 无法解析时不再按 {} 报缺参；错误正文带原始串的预览（不超过 200 个码元）。
const MISSING_PARAMETER_CONTENT = "The required parameter `questions` is missing";
const VALIDATION_CONTENT = [
  "<tool_use_error>InputValidationError: AskUserQuestion was called with input that could not be parsed as JSON.",
  `You sent (first ${RAW_INPUT.length} of ${RAW_INPUT.length} bytes): ${RAW_INPUT}`,
  "Common causes: unescaped backslashes in file paths (use / or \\\\), unescaped control characters, or truncated output. Retry with valid JSON.</tool_use_error>",
].join("\n");

describe("Z02 工具输入校验 provider content E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("malformed arguments 的精确 error tool result 在 live 与 cold replay 中保持一致", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    const telemetry = await beginConversationTelemetryCapture();
    const baseline = toolStepsOf(await readAllEventReportRequests(telemetry)).length;

    const runId = Date.now();
    const prompt = `${PROMPT_MARKER}_${runId}: trigger the malformed tool input fixture.`;
    await sendV4Prompt(prompt);

    const liveContinuation = await waitForUpstreamNetworkCapture(VALIDATION_CONTENT);
    expect(liveContinuation.statusCode).toBe(200);
    assertValidationHistory(liveContinuation.requestJson);
    await waitForV4TimelineContaining(LIVE_DONE, 60000);

    const completed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(LIVE_DONE),
      "malformed tool input continuation 没有完成",
      60000,
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`malformed tool input case 缺少真实 sessionId: ${sessionId ?? "null"}`);
    }
    await assertToolFailureTelemetry(telemetry, baseline);

    // Bug 回归边界：renderer refresh 仍可能复用 CLI 内存；必须等待旧 Electron、
    // Host 和 Agent 进程树完整退出，才能证明 provider content 来自持久化历史。
    await reloadElectronSessionSafely(browser);
    await waitForDefaultWorkspaceReady(60000);
    // 完整进程重启后 task index 可能晚于 workspace ready；这里只延长该恢复边界，
    // 不给 live/provider 断言增加重试或降级路径。
    await selectV4TaskById(sessionId, 60000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      `CLI cold restart 后没有恢复 session ${sessionId}`,
      60000,
    );

    const coldPrompt = `${COLD_PROMPT_MARKER}_${runId}: reply with exactly ${COLD_DONE}.`;
    await sendV4Prompt(coldPrompt);
    const coldRequest = await waitForUpstreamNetworkCapture(coldPrompt);
    expect(coldRequest.statusCode).toBe(200);
    assertValidationHistory(coldRequest.requestJson);
    await waitForV4AssistantMessageContaining(COLD_DONE, 60000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === sessionId &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(COLD_DONE),
      "cold follow-up 没有完成",
      60000,
    );
  });
});

function assertValidationHistory(requestJson: unknown) {
  const serialized = JSON.stringify(requestJson);
  // 原始串只出现在 tool_result 的预览里一次；tool_use.input 仍是 {}（下方精确断言）。
  expect(serialized.split(RAW_INPUT_MARKER)).toHaveLength(2);
  expect(serialized).not.toContain(LEGACY_VALIDATION_CONTENT);
  expect(serialized).not.toContain(MISSING_PARAMETER_CONTENT);

  const messages = readRecordArray(readRecord(requestJson).messages);
  const contentBlocks = messages.flatMap((message, messageIndex) =>
    readContentBlocks(message).map((block) => ({
      block,
      message,
      messageIndex,
    })),
  );
  const toolUses = contentBlocks.filter(
    ({ block }) => block.type === "tool_use" && block.id === TOOL_CALL_ID,
  );
  const toolResults = contentBlocks.filter(
    ({ block }) => block.type === "tool_result" && block.tool_use_id === TOOL_CALL_ID,
  );

  expect(toolUses).toHaveLength(1);
  expect(toolResults).toHaveLength(1);

  const toolUse = toolUses[0]!;
  const toolResult = toolResults[0]!;
  expect(toolUse.messageIndex).toBeGreaterThanOrEqual(0);
  expect(toolResult.messageIndex).toBe(toolUse.messageIndex + 1);
  expect(toolUse.message.role).toBe("assistant");
  expect(toolResult.message.role).toBe("user");

  const expectedToolUse = {
    type: "tool_use",
    id: TOOL_CALL_ID,
    name: TOOL_NAME,
    input: {},
  };
  const expectedToolResult = {
    type: "tool_result",
    tool_use_id: TOOL_CALL_ID,
    is_error: true,
    content: VALIDATION_CONTENT,
  };

  // thinking 是独立的推理投影；本 case 只允许它与唯一目标 tool_use 共存，
  // 其他 text 或 tool block 仍应让精确 provider message 合同失败。
  expect(
    readContentBlocks(toolUse.message)
      .filter((block) => block.type !== "thinking")
      .map(withoutCacheControl),
  ).toEqual([expectedToolUse]);
  expect(readContentBlocks(toolResult.message).map(withoutCacheControl)).toEqual([
    expectedToolResult,
  ]);
}

function toolStepsOf(reports: ConversationTelemetryReport[]) {
  return reports.filter(
    (r) =>
      r.element_name === "agent_step" &&
      (r.event_extra_detail as Record<string, string> | undefined)?.tool_call_id === TOOL_CALL_ID,
  );
}

/**
 * 工具失败原因码：CLI 的 schema 校验失败是 ToolExecutionFailed（不是 InvalidInput），工具 step
 * 带 error_code=tool_execution_failed，error_type 保持旧口径；错误原文与模型给的原始参数都不出现在
 * 上报里。只看本用例开始后的增量。
 */
async function assertToolFailureTelemetry(
  telemetry: ConversationTelemetryCaptureHandle,
  baseline: number,
) {
  let reports: ConversationTelemetryReport[] = [];
  await browser.waitUntil(
    async () => {
      reports = await readAllEventReportRequests(telemetry);
      return toolStepsOf(reports).length > baseline;
    },
    { timeout: 30000, timeoutMsg: `${TOOL_CALL_ID} 的 agent_step 没有上报` },
  );
  const steps = toolStepsOf(reports);
  expect(steps).toHaveLength(baseline + 1);
  expect(steps[baseline]!.event_extra_detail).toMatchObject({
    tool_name: TOOL_NAME,
    status: "fail",
    error_type: "TOOL_EXEC_ERROR",
    error_code: "tool_execution_failed",
    error_msg: "[redacted]",
  });
  const serialized = JSON.stringify(reports);
  expect(serialized).not.toContain("InputValidationError");
  expect(serialized).not.toContain(RAW_INPUT_MARKER);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`期望 object，实际为 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`期望 array，实际为 ${JSON.stringify(value)}`);
  }
  return value.map(readRecord);
}

function readContentBlocks(message: Record<string, unknown>) {
  return readRecordArray(message.content);
}

function withoutCacheControl(block: Record<string, unknown>) {
  const result = { ...block };
  delete result.cache_control;
  return result;
}

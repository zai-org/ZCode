import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_READONLY_TOOL_FILE_PATH,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  beginConversationTelemetryCapture,
  finishConversationTelemetryCapture,
  telemetryInventory,
  waitForConversationReportInventory,
  type ArmsCustomEventPayload,
  type ConversationTelemetryCaptureHandle,
} from "#e2e/helpers/conversation-telemetry-parity-capture";

const CASE_ID = "TDP-CORE";
const TOOL_MARKER = "E2E_TELEMETRY_PARITY_TOOL";
const TOOL_REPLY = "telemetry-parity-tool-ok";
const COMPACT_MARKER = "E2E_TELEMETRY_PARITY_COMPACT";
const COMPACT_REPLY = "telemetry-parity-compact-seed-ok";
const REASONING_MARKER = "E2E_TELEMETRY_PARITY_REASONING";
const REASONING_REPLY = "telemetry-parity-reasoning-ok";
const STALL_MARKER = "E2E_TELEMETRY_PARITY_STALL";
const STALL_REPLY = "telemetry-parity-stall-ok";
const INTERRUPT_MARKER = "E2E_TELEMETRY_PARITY_INTERRUPT";
const INTERRUPT_PREFIX = "telemetry-parity-interrupt-start";

type JsonRecord = Record<string, unknown>;

describe("会话埋点旧版/V4 核心运行时差分 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("真实覆盖工具、思考、stall、interrupted 与 compact 后捕获最终上报", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();
    const captureHandle = await beginConversationTelemetryCapture();

    await runToolSuccessCase();
    await runCompactionSuccessCase(captureHandle);
    await runReasoningCase();
    await runStreamStallCase();
    await runInterruptedCase();

    const capture = await finishConversationTelemetryCapture(captureHandle, {
      caseId: CASE_ID,
      minimumReportInventory: {
        agent_step: 6,
        context_compaction: 1,
        message_completion: 5,
        send_btn: 5,
      },
      minimumArmsInventory: {
        perf_ui_first_token: 5,
        perf_ui_message_complete: 5,
        perf_ui_stream_stall: 1,
        perf_ui_tool_call_detail: 1,
        perf_ui_turn_breakdown: 5,
        plan_request: 10,
        plan_ttft: 5,
      },
    });

    assertRuntimeCoverage(capture.eventReport, capture.armsFinal);
    if (capture.armsRenderer) {
      expect(telemetryInventory(capture.armsFinal, "name")).toEqual(
        telemetryInventory(capture.armsRenderer, "name"),
      );
    }
  });
});

async function runToolSuccessCase(): Promise<void> {
  const prompt = `${TOOL_MARKER}: Read ${E2E_READONLY_TOOL_FILE_PATH}, then reply with exactly "${TOOL_REPLY}".`;
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", "工具埋点 case 发送后输入框没有清空");
  await waitForV4UserMessageContaining(TOOL_MARKER);
  // 旧版把 Read 原样展示，V4 会把只读探索调用聚合为 Explore；
  // 这里等待模型终态，底部再按最终 agent_step 的 tool_name/status 验证协议事实。
  await waitForV4AssistantMessageContaining(TOOL_REPLY);
  await waitForIdle("工具埋点 case 没有完成");
}

async function runCompactionSuccessCase(
  captureHandle: ConversationTelemetryCaptureHandle,
): Promise<void> {
  await startNewTaskForParity();
  const prompt = `${COMPACT_MARKER}: Reply with exactly "${COMPACT_REPLY}" and no other text.`;
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(COMPACT_REPLY);
  await waitForIdle("compact seed 没有完成");

  await sendV4Prompt("/compact");
  await waitForV4ComposerText("", "/compact 后输入框没有清空");
  // V4 timeline 不保留旧 ChatView 的瞬时 compact marker；真正的兼容合同是 terminal
  // 到达最终 /event/report。直接等待最终边界，避免 UI 投影速度造成假失败。
  await waitForConversationReportInventory(captureHandle, {
    context_compaction: 1,
  });
}

async function runReasoningCase(): Promise<void> {
  await startNewTaskForParity();
  const prompt = `${REASONING_MARKER}: Reply with exactly "${REASONING_REPLY}".`;
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(REASONING_REPLY);
  await waitForIdle("thought -> text 埋点 case 没有完成");
}

async function runStreamStallCase(): Promise<void> {
  await startNewTaskForParity();
  const prompt = `${STALL_MARKER}: Reply with exactly "${STALL_REPLY}".`;
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(STALL_REPLY);
  await waitForIdle("3001ms stall 埋点 case 没有完成");
}

async function runInterruptedCase(): Promise<void> {
  await startNewTaskForParity();
  const prompt = `${INTERRUPT_MARKER}: Start the response, then keep streaming until stopped.`;
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(INTERRUPT_PREFIX);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "streaming",
    "interrupted 埋点 case 没有进入 streaming",
    30000,
  );
  await clickV4Stop();
  await waitForIdle("interrupted 埋点 case stop 后没有结束");
}

async function startNewTaskForParity(): Promise<void> {
  await startNewV4Draft();
  // 旧版新草稿的模型目录在 draft DOM ready 后异步回显；给它一个稳定窗口，避免把
  // 旧版自身的瞬时空模型 race 当成 V4 payload 基准。V4 仍由冻结 config 保证立即发送正确。
  await browser.pause(500);
}

async function waitForIdle(message: string): Promise<void> {
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    message,
    90000,
  );
}

function assertRuntimeCoverage(eventReport: JsonRecord[], armsFinal: JsonRecord[]): void {
  const reportInventory = telemetryInventory(eventReport, "element_name");
  expect(reportInventory.send_btn).toBe(5);
  expect(reportInventory.message_completion).toBe(5);
  expect(reportInventory.context_compaction).toBe(1);
  expect(reportInventory.agent_step).toBeGreaterThanOrEqual(6);

  const details = eventReport
    .map((event) => event.event_extra_detail)
    .filter((detail): detail is JsonRecord => isRecord(detail));
  expect(
    details.some(
      (detail) =>
        detail.step_type === "tool_call" &&
        String(detail.tool_name).toLowerCase() === "read" &&
        detail.status === "success",
    ),
  ).toBe(true);
  expect(details.some((detail) => detail.step_type === "reasoning")).toBe(true);
  expect(
    details.some(
      (detail) => detail.status === "user_interrupt" && detail.error_type === "USER_INTERRUPT",
    ),
  ).toBe(true);
  expect(
    details.some((detail) => detail.status === "completed" && detail.trigger === "manual"),
  ).toBe(true);

  const armsInventory = telemetryInventory(
    armsFinal as unknown as ArmsCustomEventPayload[],
    "name",
  );
  expect(armsInventory.perf_ui_stream_stall).toBeGreaterThanOrEqual(1);
  expect(armsInventory.perf_ui_tool_call_detail).toBe(1);
  expect(armsInventory.perf_ui_first_token).toBe(5);
  expect(armsInventory.perf_ui_message_complete).toBe(5);
  expect(armsInventory.perf_ui_turn_breakdown).toBe(5);
  expect(armsInventory.plan_request).toBeGreaterThanOrEqual(10);
  expect(armsInventory.plan_ttft).toBeGreaterThanOrEqual(5);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

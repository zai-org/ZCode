// M4 门禁：v4 前向命令 resolveInteraction 收口反向权限请求（catalog Q 组 / permission）。
// 证据层 L3：Write 工具在默认模式触发权限弹窗 → V4InteractionDialogs 渲染 →
// 批准 → resolveInteraction 命令经 v4-bridge → interaction-broker race deferred 收口 →
// 工具执行 → tool_result 回灌 → 终态文本。证明反向 RPC 与前向命令的汇合点打通。
import { access, mkdir, rm } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import { selectTaskById } from "#e2e/helpers/conversation-session";
import {
  approveV4Permission,
  denyV4PermissionWithFeedback,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  startNewV4Draft,
  sendV4Prompt,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import {
  beginConversationTelemetryCapture,
  readAllEventReportRequests,
  type ConversationTelemetryCaptureHandle,
  type ConversationTelemetryReport,
} from "#e2e/helpers/conversation-telemetry-parity-capture";

const V4_PERMISSION_CASE = "conversation-session-v4-permission";
const V4_PERMISSION_DIR = resolveE2ERuntimePath(V4_PERMISSION_CASE);
const V4_PERMISSION_OUTPUT_PATH = resolveE2EToolPath(V4_PERMISSION_CASE, "write-output.txt");
const V4_PERMISSION_ALLOW_FEEDBACK_OUTPUT_PATH = resolveE2EToolPath(
  V4_PERMISSION_CASE,
  "allow-feedback-output.txt",
);
const V4_PERMISSION_DENY_OUTPUT_PATH = resolveE2EToolPath(V4_PERMISSION_CASE, "deny-output.txt");
const V4_PERMISSION_DENY_BLANK_OUTPUT_PATH = resolveE2EToolPath(
  V4_PERMISSION_CASE,
  "deny-blank-output.txt",
);
const V4_PERMISSION_ALLOW_FEEDBACK = "This note must be ignored when allowing the tool.";
const V4_PERMISSION_DENY_FEEDBACK =
  "Do not write the file; explain that the requested change needs clarification first. " +
  "Additional context: " +
  "x".repeat(600);
const V4_PERMISSION_DENY_BASE_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

describe("v4 M4 门禁：resolveInteraction 收口权限请求", () => {
  before(async () => {
    await rm(V4_PERMISSION_DIR, { recursive: true, force: true });
    await mkdir(V4_PERMISSION_DIR, { recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(V4_PERMISSION_DIR, { recursive: true, force: true });
  });

  it("默认模式 Write 工具触发权限弹窗，批准后工具执行并出终态文本", async () => {
    await prepareV4ConversationE2E();
    await ensurePermissionTelemetryCapture();
    const baseline = await countPermissionResults("toolu_v4_permission_write");

    await sendV4Prompt(`E2E_V4_PERMISSION_WRITE 请写入文件 ${V4_PERMISSION_OUTPUT_PATH}`);

    // 反向权限请求 → V4InteractionDialogs 渲染 PermissionDialog。
    // Bugfix: v4 权限等待态是 bottom dock 阻塞交互，不应退回 SessionPane 外层全宽底部卡片。
    const dockState = await waitForV4PermissionDialogInComposerDock();
    // 待处理权限只在底部卡片展示，顶部不再重复提示。
    await expect($('[data-testid="v4-pending-interaction-top-notice"]')).not.toExist();
    expect(dockState.inDock).toBe(true);
    expect(dockState.composerHidden).toBe(true);
    expect(dockState.interactionBeforeComposer).toBe(true);
    expect(await readPermissionFeedbackTextareaSemantics()).toEqual({
      tagName: "TEXTAREA",
      rows: "1",
      autoSizing: true,
      maxRows: true,
      index: "5.",
      indexCenteredOnFirstLine: true,
      rowGaps: [4, 4, 4, 4],
    });

    // 前向 resolveInteraction 命令收口
    const dismissed = await approveV4Permission();
    expect(dismissed).toBe(true);

    // 批准后工具执行 → tool_result 回灌 → 终态文本
    await waitForV4TimelineContaining("V4_PERMISSION_DONE", 60000);

    // 用户在弹窗上的选择上报一次，message_id 指向本轮发送。
    const { result, reports } = await waitForPermissionResult(
      "toolu_v4_permission_write",
      baseline,
    );
    expect(detailOf(result)).toMatchObject({
      option: "allow_once",
      has_feedback: "0",
      tool_name: "Write",
      tool_call_id: "toolu_v4_permission_write",
      from_subagent: "0",
      ack: "accepted",
    });
    expect(Number(detailOf(result).wait_ms)).toBeGreaterThanOrEqual(0);
    expect(result.message_id).toBeTruthy();
    expect(
      reports.some((r) => r.element_name === "send_btn" && r.message_id === result.message_id),
    ).toBe(true);
  });

  it("批准时填写的反馈被忽略，工具仍按 Allow once 执行", async () => {
    await prepareV4ConversationE2E();
    await ensurePermissionTelemetryCapture();
    const baseline = await countPermissionResults("toolu_v4_permission_allow_feedback");

    await sendV4Prompt(
      `E2E_V4_PERMISSION_ALLOW_FEEDBACK 请写入文件 ${V4_PERMISSION_ALLOW_FEEDBACK_OUTPUT_PATH}`,
    );
    await waitForV4PermissionDialogInComposerDock();

    expect(await approveV4Permission(V4_PERMISSION_ALLOW_FEEDBACK)).toBe(true);
    await waitForV4TimelineContaining("V4_PERMISSION_ALLOW_FEEDBACK_DONE", 60000);
    // 批准时填写的反馈会被忽略，不算写了理由。
    const { result } = await waitForPermissionResult(
      "toolu_v4_permission_allow_feedback",
      baseline,
    );
    expect(detailOf(result)).toMatchObject({ option: "allow_once", has_feedback: "0" });

    const allowedResult = await getLatestUpstreamToolResultByToolCallId(
      "toolu_v4_permission_allow_feedback",
    );
    expect(allowedResult?.isError).toBe(false);
    expect(allowedResult?.content).not.toContain(V4_PERMISSION_ALLOW_FEEDBACK);
    await expectFileExists(V4_PERMISSION_ALLOW_FEEDBACK_OUTPUT_PATH);
  });

  for (const submitWithEnter of [true, false]) {
    it(`第 5 行填写反馈并${submitWithEnter ? "回车" : "确认"}，反馈进入同一个 provider-visible tool_result 且工具不执行`, async () => {
      await prepareV4ConversationE2E();
      await ensurePermissionTelemetryCapture();
      const baseline = await countPermissionResults("toolu_v4_permission_deny_feedback");

      await sendV4Prompt(
        `E2E_V4_PERMISSION_DENY_FEEDBACK 请写入文件 ${V4_PERMISSION_DENY_OUTPUT_PATH}`,
      );
      await waitForV4PermissionDialogInComposerDock();

      const input = await $(
        'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
      );
      const allow = await $('[data-permission-option-kind="allowOnce"]');
      const deny = await $('[data-permission-option-kind^="reject"]');
      await expect(allow).toBeFocused();
      await browser.keys("ArrowUp");
      await expect(input).toBeFocused();
      expect((await readPermissionFeedbackTextareaSemantics()).index).toBe("5.");
      expect(await deny.getAttribute("aria-selected")).toBe("false");
      await browser.keys("ArrowUp");
      await expect(deny).toBeFocused();
      expect(
        await browser.execute(() =>
          document
            .querySelector(
              'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
            )
            ?.parentElement?.classList.contains("bg-selected"),
        ),
      ).toBe(false);
      await browser.keys("Tab");
      await expect(input).toBeFocused();
      await browser.keys(["Shift", "Tab"]);
      await expect(deny).toBeFocused();
      await browser.keys("ArrowDown");
      await expect(input).toBeFocused();

      expect(await denyV4PermissionWithFeedback(V4_PERMISSION_DENY_FEEDBACK, submitWithEnter)).toBe(
        true,
      );
      await waitForV4TimelineContaining("V4_PERMISSION_DENY_DONE", 60000);
      // 两个参数化用例共用同一 tool_call_id，按本用例开始前的条数取增量。
      const { result } = await waitForPermissionResult(
        "toolu_v4_permission_deny_feedback",
        baseline,
      );
      expect(detailOf(result)).toMatchObject({
        option: "deny",
        has_feedback: "1",
        ack: "accepted",
      });
      expect(JSON.stringify(result)).not.toContain("Additional context");

      const deniedResult = await getLatestUpstreamToolResultByToolCallId(
        "toolu_v4_permission_deny_feedback",
      );
      expect(deniedResult?.isError).toBe(true);
      expect(deniedResult?.content).toBe(
        V4_PERMISSION_DENY_BASE_CONTENT +
          " To tell you how to proceed, the user said:\n" +
          V4_PERMISSION_DENY_FEEDBACK,
      );
      await expectFileMissing(V4_PERMISSION_DENY_OUTPUT_PATH);
    });
  }

  it("拒绝时只有空白反馈，provider-visible tool_result 保持基础 Deny 文案", async () => {
    await prepareV4ConversationE2E();
    await ensurePermissionTelemetryCapture();
    const baseline = await countPermissionResults("toolu_v4_permission_deny_blank");

    await sendV4Prompt(
      `E2E_V4_PERMISSION_DENY_BLANK 请写入文件 ${V4_PERMISSION_DENY_BLANK_OUTPUT_PATH}`,
    );
    await waitForV4PermissionDialogInComposerDock();

    // 弹窗挂起时切到别的任务再回来：wait_ms 从首次出现算，不因会话切换、面板重挂载重置。
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    await startNewV4Draft();
    await browser.pause(PERMISSION_AWAY_MS);
    await selectTaskById(sessionId);
    await waitForV4PermissionDialogInComposerDock();

    expect(await denyV4PermissionWithFeedback("   ")).toBe(true);
    await waitForV4TimelineContaining("V4_PERMISSION_DENY_BLANK_DONE", 60000);
    const { result } = await waitForPermissionResult("toolu_v4_permission_deny_blank", baseline);
    expect(detailOf(result)).toMatchObject({ option: "deny", has_feedback: "0", ack: "accepted" });
    expect(Number(detailOf(result).wait_ms)).toBeGreaterThanOrEqual(PERMISSION_AWAY_MS);

    const deniedResult = await getLatestUpstreamToolResultByToolCallId(
      "toolu_v4_permission_deny_blank",
    );
    expect(deniedResult?.isError).toBe(true);
    expect(deniedResult?.content).toBe(V4_PERMISSION_DENY_BASE_CONTENT);
    expect(deniedResult?.content).not.toContain("To tell you how to proceed");
    await expectFileMissing(V4_PERMISSION_DENY_BLANK_OUTPUT_PATH);
  });
});

async function expectFileExists(path: string) {
  const exists = await access(path)
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(true);
}

async function expectFileMissing(path: string) {
  const exists = await access(path)
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
}

async function readPermissionFeedbackTextareaSemantics() {
  return browser.execute(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
    );
    const style = textarea ? getComputedStyle(textarea) : null;
    const indexRect = textarea?.previousElementSibling?.getBoundingClientRect();
    // 原因：反馈行曾落在外层 12px 分组间距中；校验实际位置，避免只匹配样式名。
    const feedbackRow = textarea?.parentElement;
    // 原因：切换模式行由按钮和其下方的模式提示组成；按按钮量会把提示文字算进行间距（得到 26）。
    // 量 listbox 的直接子元素，即用户看到的整行，仍校验行与行之间的 4px 分组。
    const rowRects = [
      ...Array.from(feedbackRow?.previousElementSibling?.children ?? []),
      ...(feedbackRow ? [feedbackRow] : []),
    ].map((row) => row.getBoundingClientRect());
    return {
      tagName: textarea?.tagName ?? null,
      rows: textarea?.getAttribute("rows") ?? null,
      autoSizing: textarea?.classList.contains("field-sizing-content") ?? false,
      maxRows: textarea?.classList.contains("max-h-[5lh]") ?? false,
      index: textarea?.previousElementSibling?.textContent ?? null,
      rowGaps: rowRects.slice(1).map((rect, index) => rect.top - rowRects[index]!.bottom),
      indexCenteredOnFirstLine: Boolean(
        textarea &&
        style &&
        indexRect &&
        Math.abs(
          indexRect.top +
            indexRect.height / 2 -
            (textarea.getBoundingClientRect().top +
              parseFloat(style.borderTopWidth) +
              parseFloat(style.paddingTop) +
              parseFloat(style.lineHeight) / 2),
        ) <= 0.5,
      ),
    };
  });
}

let permissionTelemetryCapture: ConversationTelemetryCaptureHandle | undefined;

/** 整个 spec 共用一次 /event/report 抓取；各用例按 tool_call_id 取自己的上报。 */
async function ensurePermissionTelemetryCapture() {
  permissionTelemetryCapture ??= await beginConversationTelemetryCapture();
}

function detailOf(report: ConversationTelemetryReport): Record<string, string> {
  return (report.event_extra_detail ?? {}) as Record<string, string>;
}

const PERMISSION_AWAY_MS = 3000;

function permissionResultsOf(reports: ConversationTelemetryReport[], toolCallId: string) {
  return reports.filter(
    (r) => r.element_name === "permission_prompt_result" && detailOf(r).tool_call_id === toolCallId,
  );
}

/** 用例开始前的已有条数；断言只看本用例的增量，不依赖其它用例是否先跑。 */
async function countPermissionResults(toolCallId: string) {
  if (!permissionTelemetryCapture) throw new Error("权限埋点抓取未启动");
  const reports = await readAllEventReportRequests(permissionTelemetryCapture);
  return permissionResultsOf(reports, toolCallId).length;
}

/** 等本用例恰好新增一条上报，返回这一条。 */
async function waitForPermissionResult(toolCallId: string, baseline: number) {
  if (!permissionTelemetryCapture) throw new Error("权限埋点抓取未启动");
  const capture = permissionTelemetryCapture;
  let reports: ConversationTelemetryReport[] = [];
  await browser.waitUntil(
    async () => {
      reports = await readAllEventReportRequests(capture);
      return permissionResultsOf(reports, toolCallId).length > baseline;
    },
    { timeout: 30000, timeoutMsg: `${toolCallId} 的 permission_prompt_result 没有新增上报` },
  );
  const matches = permissionResultsOf(reports, toolCallId);
  expect(matches).toHaveLength(baseline + 1);
  return { result: matches[baseline]!, reports };
}

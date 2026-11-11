// M4 门禁：v4 前向命令 resolveInteraction 收口反向权限请求（catalog Q 组 / permission）。
// 证据层 L3：Write 工具在默认模式触发权限弹窗 → V4InteractionDialogs 渲染 →
// 批准 → resolveInteraction 命令经 v4-bridge → interaction-broker race deferred 收口 →
// 工具执行 → tool_result 回灌 → 终态文本。证明反向 RPC 与前向命令的汇合点打通。
import { access, mkdir, rm } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4Permission,
  denyV4PermissionWithFeedback,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4PermissionDialogInComposerDock,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { withoutTotalTokensReminderText } from "#e2e/helpers/total-tokens-evidence";

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

/**
 * 读取模型面的拒绝结果。
 * 修复原因：工具批次后的 token 预算提醒以 `\n\n` 段并进 tool_result 文本，按原样比较
 * 拒绝文案会多出提醒段；这里只断言拒绝文案本身，按完整形态去掉提醒段。
 */
async function getDeniedToolResult(toolCallId: string) {
  const result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
  return result && { ...result, content: withoutTotalTokensReminderText(result.content) };
}

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
  });

  it("批准时填写的反馈被忽略，工具仍按 Allow once 执行", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt(
      `E2E_V4_PERMISSION_ALLOW_FEEDBACK 请写入文件 ${V4_PERMISSION_ALLOW_FEEDBACK_OUTPUT_PATH}`,
    );
    await waitForV4PermissionDialogInComposerDock();

    expect(await approveV4Permission(V4_PERMISSION_ALLOW_FEEDBACK)).toBe(true);
    await waitForV4TimelineContaining("V4_PERMISSION_ALLOW_FEEDBACK_DONE", 60000);

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

      const deniedResult = await getDeniedToolResult("toolu_v4_permission_deny_feedback");
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

    await sendV4Prompt(
      `E2E_V4_PERMISSION_DENY_BLANK 请写入文件 ${V4_PERMISSION_DENY_BLANK_OUTPUT_PATH}`,
    );
    await waitForV4PermissionDialogInComposerDock();

    expect(await denyV4PermissionWithFeedback("   ")).toBe(true);
    await waitForV4TimelineContaining("V4_PERMISSION_DENY_BLANK_DONE", 60000);

    const deniedResult = await getDeniedToolResult("toolu_v4_permission_deny_blank");
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

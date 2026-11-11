import { TID_CHAT_SUMMARY_PANEL, TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared/test-ids";

import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockContaining,
} from "#e2e/helpers/conversation-session-tool";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";

const PROMPT_MARKER = "E2E_PLAN_DIRECTORY_ORDER";
const ENTER_MARKER = "E2E_PLAN_DIRECTORY_ENTER";
const EXIT_MARKER = "E2E_PLAN_DIRECTORY_EXIT";
const PLAN_TITLE = "E2E_PLAN_DIRECTORY_TITLE";
const CONTINUATION_MARKER = "E2E_PLAN_DIRECTORY_CONTINUATION";

describe("conversation session plan directory and original tool order", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps a completed plan at its tool row and opens it from the summary directory", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();

    const prompt = [
      `${PROMPT_MARKER}: create a plan and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode first.`,
      `${EXIT_MARKER}: call ExitPlanMode with a Markdown H1 exactly named ${PLAN_TITLE}.`,
      `After approval, continue this same turn with the exact text ${CONTINUATION_MARKER}.`,
    ].join(" ");
    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan directory initial request",
      60_000,
    );
    // V4 隐藏内部 EnterPlanMode 行；真实工具结果已回到下一次模型请求才证明模式已进入。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_e2e_plan_directory_enter_plan_mode"))
          ?.isError === false,
      { timeout: 60_000, timeoutMsg: "EnterPlanMode 没有产生成功的真实工具结果" },
    );
    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan directory ExitPlanMode request",
      60_000,
    );
    const planBlock = await waitForToolCallBlockContaining(PLAN_TITLE, 60_000);
    const toolCallId = planBlock.toolCallId;
    if (!toolCallId) {
      throw new Error(`ExitPlanMode block 缺少 toolCallId: ${JSON.stringify(planBlock)}`);
    }

    expect(await hasPlanDirectoryEntry(toolCallId)).toBe(false);
    await waitForPlanApprovalDialog(60_000);
    await approvePlanWithoutFeedback();
    await waitForV4AssistantMessageContaining(CONTINUATION_MARKER);
    await expandAssistantHistoriesWithContent();
    await waitForPlanBeforeContinuation(toolCallId, CONTINUATION_MARKER, 30_000);

    await openPlanDirectoryEntry(toolCallId, 30_000);
    const detail = await $(`[data-plan-detail-tool-call-id="${toolCallId}"]`);
    await detail.waitForDisplayed({ timeout: 30_000 });
    expect(await detail.getText()).toContain(PLAN_TITLE);
  });
});

async function hasPlanDirectoryEntry(toolCallId: string): Promise<boolean> {
  return browser.execute(
    (id) => document.querySelector(`[data-plan-directory-tool-call-id="${id}"]`) !== null,
    toolCallId,
  );
}

async function waitForPlanApprovalDialog(timeoutMs: number) {
  await browser.waitUntil(
    async () => {
      const body = await $("[data-elicitation-dialog-body='true']");
      const footer = await $("[data-elicitation-dialog-footer='true']");
      if (!(await body.isExisting()) || !(await footer.isExisting())) return false;
      const text = `${await body.getText()}\n${await footer.getText()}`;
      return ["Approve", "批准"].some((candidate) => text.includes(candidate));
    },
    {
      timeout: timeoutMs,
      timeoutMsg: "没有出现 ExitPlanMode 计划审批弹窗",
    },
  );
}

async function approvePlanWithoutFeedback() {
  const approveButton = await $("//button[contains(., 'Approve') or contains(., '批准')]");
  await approveButton.waitForEnabled({ timeout: 30_000 });
  await approveButton.click();
}

async function waitForPlanBeforeContinuation(
  toolCallId: string,
  continuation: string,
  timeoutMs: number,
) {
  const planTestId = testId(TID_CHAT_TOOL_CALL_BLOCK, toolCallId);
  await browser.waitUntil(
    () =>
      browser.execute(
        (toolTestId, text) => {
          const plan = document.querySelector(`[data-testid="${toolTestId}"]`);
          const continuationMessage = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="v4-session-pane-workspace-main"] [data-row-id][class~="group/assistant-row"]',
            ),
          ).find((element) => element.innerText.includes(text));
          if (!plan || !continuationMessage) return false;
          return Boolean(
            plan.compareDocumentPosition(continuationMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        },
        planTestId,
        continuation,
      ),
    {
      timeout: timeoutMs,
      timeoutMsg: "ExitPlanMode 计划卡片没有保持在后续 assistant 正文之前",
    },
  );
}

async function openPlanDirectoryEntry(toolCallId: string, timeoutMs: number) {
  const panel = await $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`);
  await panel.waitForDisplayed({ timeout: timeoutMs });
  // auto 布局在窄列中仍显示胶囊，data-state=expanded 不代表目录项可见。
  // 点击真实的展开入口，不能通过 DOM click 绕过隐藏目录的交互条件。
  const expand = await panel.$('button[aria-label="展开状态"], button[aria-label="Expand status"]');
  if (await expand.isDisplayed()) await expand.click();
  const entry = await $(`[data-plan-directory-tool-call-id="${toolCallId}"]`);
  await entry.waitForClickable({ timeout: timeoutMs });
  await entry.click();
}

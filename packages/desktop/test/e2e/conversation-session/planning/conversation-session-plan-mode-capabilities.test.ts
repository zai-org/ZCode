import { readFile, rm } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import {
  E2E_READONLY_TOOL_FILE_CONTENT,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  E2E_REPLY_TOKEN,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  countUpstreamRequests,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  waitForToolCallBlockByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";

const DENY_PROMPT_MARKER = "E2E_PLAN_MODE_DENY_STOPS_TURN";
const DENY_ENTER_MARKER = "E2E_PLAN_MODE_DENY_ENTER_PLAN";
const DENY_EXIT_MARKER = "E2E_PLAN_MODE_DENY_EXIT_PLAN";
const DENY_NEXT_MARKER = "E2E_PLAN_MODE_DENY_NEXT_INPUT";
const DENY_EXIT_TOOL_CALL_ID = "toolu_e2e_plan_mode_deny_exit_plan_mode";

const TOOL_PROMPT_MARKER = "E2E_PLAN_MODE_TOOL_BOUNDARY";
const TOOL_ENTER_MARKER = "E2E_PLAN_MODE_TOOL_BOUNDARY_ENTER";
const TOOL_MIXED_MARKER = "E2E_PLAN_MODE_TOOL_BOUNDARY_MIXED";
const TOOL_WRITE_CALL_ID = "toolu_e2e_plan_mode_boundary_write";
const TOOL_READ_CALL_ID = "toolu_e2e_plan_mode_boundary_read";
const DENIED_WRITE_FILE_NAME = "zcode-e2e-plan-mode-denied-write.txt";
const DENIED_WRITE_FILE_PATH = resolveE2EToolPath(
  "conversation-session-plan-mode-capabilities",
  DENIED_WRITE_FILE_NAME,
);

const TITLE_REQUEST_SENTINEL = "Generate a concise title";
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const PLAN_MODE_REMINDER = "Plan mode is active";
const PLAN_MODE_NO_EDIT_REMINDER = "MUST NOT make any edits";
const PLAN_MODE_DENIAL_REASON = "Plan mode only allows read-only, non-destructive tools";

describe("conversation session plan mode capabilities", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  afterEach(async () => {
    await rm(DENIED_WRITE_FILE_PATH, { force: true });
  });

  it("stops the current turn after ExitPlanMode is declined without feedback", async () => {
    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const prompt = [
      `${DENY_PROMPT_MARKER}_${runId}: enter plan mode and request approval.`,
      `${DENY_ENTER_MARKER}: call EnterPlanMode before drafting.`,
      `${DENY_EXIT_MARKER}: call ExitPlanMode with the proposed plan.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "plan mode deny prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining(DENY_PROMPT_MARKER);

    await waitForUpstreamRequest(
      {
        includes: [DENY_PROMPT_MARKER, DENY_ENTER_MARKER, DENY_EXIT_MARKER],
        excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
      },
      "plan mode deny initial request",
      60000,
    );
    // 原因：V4 隐藏内部 EnterPlanMode；以真实工具成功结果确认进入 Plan。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_e2e_plan_mode_deny_enter_plan_mode"))
          ?.isError === false,
      { timeout: 60_000, timeoutMsg: "EnterPlanMode 没有真实执行成功" },
    );

    await waitForUpstreamRequest(
      {
        includes: [DENY_EXIT_MARKER, "toolu_e2e_plan_mode_deny_enter_plan_mode"],
        excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
      },
      "plan mode deny exit request",
      60000,
    );
    await waitForToolCallBlockByToolName("ExitPlanMode", 60000);

    await waitForElicitationDialogContaining("Approve", 60000);
    const requestCountBeforeDecline = await getUpstreamRequestRecordCount();
    await dismissPlanApprovalWithoutFeedback();
    await waitForIdle("plan mode deny without feedback 没有回到 idle");

    await expectNoNewUpstreamRequestContaining(
      [DENY_EXIT_TOOL_CALL_ID],
      requestCountBeforeDecline,
      2500,
    );

    const nextPrompt = `${DENY_NEXT_MARKER}_${runId}: reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const nextRequestStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(nextPrompt);
    await waitForV4ComposerText("", "plan mode deny 后续输入发送后输入框没有清空");
    await waitForUpstreamRequest(
      {
        includes: [DENY_NEXT_MARKER, PLAN_MODE_REMINDER, PLAN_MODE_NO_EDIT_REMINDER],
        excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
      },
      "plan mode deny follow-up request should remain in plan mode",
      60000,
      afterRecordCount(nextRequestStart),
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdle("plan mode deny 后续请求没有结束");
  });

  it("blocks mutating tools but still runs later read-only tools in plan mode", async () => {
    await rm(DENIED_WRITE_FILE_PATH, { force: true });
    await prepareV4ConversationE2E();
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const prompt = [
      `${TOOL_PROMPT_MARKER}_${runId}: enter plan mode and inspect without edits.`,
      `${TOOL_ENTER_MARKER}: call EnterPlanMode first.`,
      `${TOOL_MIXED_MARKER}: then call Write and Read in the same assistant message.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "plan mode tool boundary prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining(TOOL_PROMPT_MARKER);

    await waitForUpstreamRequest(
      {
        includes: [TOOL_PROMPT_MARKER, TOOL_ENTER_MARKER, TOOL_MIXED_MARKER],
        excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
      },
      "plan mode tool boundary initial request",
      60000,
    );
    // 原因：V4 隐藏内部 EnterPlanMode；以真实工具成功结果确认进入 Plan。
    await browser.waitUntil(
      async () =>
        (
          await getLatestUpstreamToolResultByToolCallId(
            "toolu_e2e_plan_mode_boundary_enter_plan_mode",
          )
        )?.isError === false,
      { timeout: 60_000, timeoutMsg: "EnterPlanMode 没有真实执行成功" },
    );

    await waitForUpstreamRequest(
      {
        includes: [
          TOOL_MIXED_MARKER,
          "toolu_e2e_plan_mode_boundary_enter_plan_mode",
          PLAN_MODE_REMINDER,
          PLAN_MODE_NO_EDIT_REMINDER,
        ],
        excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
      },
      "plan mode tool boundary mixed tool request",
      60000,
    );

    await waitForToolCallBlockByToolCallId(TOOL_WRITE_CALL_ID, 60000);
    await waitForToolCallBlockByToolCallId(TOOL_READ_CALL_ID, 60000);

    await waitForUpstreamRequest(
      {
        includes: [
          TOOL_MIXED_MARKER,
          TOOL_WRITE_CALL_ID,
          TOOL_READ_CALL_ID,
          PLAN_MODE_DENIAL_REASON,
          E2E_READONLY_TOOL_FILE_CONTENT,
        ],
        excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
      },
      "plan mode tool boundary continuation request",
      60000,
    );
    expect(await readFileIfExists(DENIED_WRITE_FILE_PATH)).toBe(null);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await expectAssistantReplyWithoutDeniedChangeSummary();
    await waitForIdle("plan mode tool boundary 没有结束");
  });
});

async function waitForElicitationDialogContaining(text: string, timeoutMs: number) {
  const expectedTexts = expandElicitationDialogTextAlternatives(text);
  let latestDialogText = "";
  await browser.waitUntil(
    async () => {
      // 修复原因：ExitPlanMode 的批准/忽略选项渲染在 footer，body 只包含计划正文。
      // 旧等待只查 body，会在真实弹窗已出现时继续等到超时。
      latestDialogText = await browser.execute(() => {
        const body = document.querySelector<HTMLElement>("[data-elicitation-dialog-body='true']");
        const footer = document.querySelector<HTMLElement>(
          "[data-elicitation-dialog-footer='true']",
        );
        return [body?.innerText, footer?.innerText].filter(Boolean).join("\n");
      });
      return expectedTexts.some((expectedText) => latestDialogText.includes(expectedText));
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Timed out waiting for elicitation dialog containing ${expectedTexts.join(
        " / ",
      )}; latest=${latestDialogText}`,
    },
  );
}

function expandElicitationDialogTextAlternatives(text: string) {
  if (text === "Approve") {
    return ["Approve", "批准"];
  }
  if (text === "Dismiss") {
    return ["Dismiss", "忽略"];
  }
  return [text];
}

async function dismissPlanApprovalWithoutFeedback() {
  const dismissButton = await $(
    "//*[@data-elicitation-dialog-footer='true']//button[normalize-space(.)='Dismiss' or normalize-space(.)='忽略']",
  );
  // 仅操作审批 footer 的拒绝按钮；等待实际可点击，避免命中其他页面的同名按钮。
  await dismissButton.waitForClickable({ timeout: 30000 });
  await dismissButton.click();
}

async function expectNoNewUpstreamRequestContaining(
  includes: string[],
  afterRecordCountValue: number,
  durationMs: number,
) {
  await browser.pause(durationMs);
  const count = await countUpstreamRequests(
    {
      includes,
      excludes: [TITLE_REQUEST_SENTINEL, COMPACT_REQUEST_SENTINEL],
    },
    afterRecordCount(afterRecordCountValue),
  );
  expect(count).toBe(0);
}

async function waitForIdle(timeoutMsg: string) {
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    timeoutMsg,
    60000,
  );
}

async function expectAssistantReplyWithoutDeniedChangeSummary() {
  const replies = (await getV4Messages("assistant")).filter((message) =>
    message.text.includes(E2E_REPLY_TOKEN),
  );
  expect(replies.length).toBeGreaterThan(0);
  for (const reply of replies) {
    expect(reply.text).not.toContain("file changed");
    expect(reply.text).not.toContain("文件已更改");
  }
}

async function readFileIfExists(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function afterRecordCount(recordCount: number) {
  return recordCount > 0 ? { afterIndex: recordCount - 1 } : {};
}

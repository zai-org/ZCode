import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_PLAN_FILE_COMPACT_CONTINUITY";
const ENTER_MARKER = "E2E_PLAN_FILE_COMPACT_ENTER_PLAN";
const EXIT_MARKER = "E2E_PLAN_FILE_COMPACT_EXIT_PLAN";
const PLAN_MARKER = "E2E_PLAN_FILE_COMPACT_PLAN_BODY";
const APPROVED_PLAN_TEXT = `${PLAN_MARKER}: 1. Persist the approved plan under .zcode/plans. 2. Preserve the plan through manual compact via plan_file_reference.`;
const CHECKPOINT_MARKER = "E2E_PLAN_FILE_COMPACT_CHECKPOINT";
const AFTER_COMPACT_MARKER = "E2E_PLAN_FILE_COMPACT_AFTER";
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_file_compact_exit_plan_mode";
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const PLAN_FILE_REFERENCE_SENTINEL = "A plan file exists from plan mode at:";
const PLAN_CONTENTS_SENTINEL = "Plan contents:";
const PLAN_RELEVANCE_SENTINEL =
  "If this plan is relevant to the current work and not already complete, continue working on it.";

describe("conversation session plan file compact continuity", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("keeps the approved ExitPlanMode plan visible after manual compact", async function () {
    this.timeout(180000);

    await rm(join(DEFAULT_WORKSPACE, ".zcode", "plans"), {
      force: true,
      recursive: true,
    });
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: enter plan mode and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode before drafting.`,
      `${EXIT_MARKER}: call ExitPlanMode with the proposed plan.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "plan file compact prompt 发送后输入框没有清空");
    await waitForV4UserMessageContaining(PROMPT_MARKER);
    const activeTask = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.sessionId),
      "plan file compact case 没有创建 session",
      30000,
    );
    const sessionId = activeTask.sessionId;
    if (!sessionId) {
      throw new Error("plan file compact case sessionId 为空");
    }
    const planFilePath = join(DEFAULT_WORKSPACE, ".zcode", "plans", `plan-${sessionId}.md`);

    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      },
      "plan file compact initial plan-mode request",
      60000,
    );
    // EnterPlanMode 是隐藏的控制工具；用真实结果证明进入计划模式。
    await browser.waitUntil(
      async () =>
        (
          await getLatestUpstreamToolResultByToolCallId(
            "toolu_e2e_plan_file_compact_enter_plan_mode",
          )
        )?.isError === false,
      { timeout: 60000, timeoutMsg: "EnterPlanMode 没有成功执行" },
    );

    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_file_compact_enter_plan_mode"],
        excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      },
      "plan file compact exit plan-mode request",
      60000,
    );
    await waitForToolCallBlockByToolName("ExitPlanMode", 60000);

    await waitForElicitationDialogContaining("Approve", 60000);
    await approvePlanWithoutFeedback();
    const planFileContent = await waitForPlanFileContent(planFilePath);
    expect(planFileContent).toBe(APPROVED_PLAN_TEXT);

    await waitForUpstreamRequest(
      {
        includes: [EXIT_TOOL_CALL_ID, APPROVED_PLAN_TEXT, "User has approved your plan"],
        excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      },
      "plan file compact approval continuation request",
      60000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdle("plan approval continuation 没有结束");

    const checkpointPrompt = `${CHECKPOINT_MARKER}_${runId}: reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(checkpointPrompt);
    await waitForV4ComposerText("", "plan file compact checkpoint 发送后输入框没有清空");
    await waitForUpstreamRequest(
      {
        includes: [CHECKPOINT_MARKER, APPROVED_PLAN_TEXT],
        excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      },
      "plan file compact checkpoint request",
      60000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdle("plan file compact checkpoint 没有结束");

    const compactRequestStartIndex = await getUpstreamRequestRecordCount();
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "plan file compact /compact 发送后输入框没有清空");
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");

    await waitForUpstreamRequest(
      {
        includes: [COMPACT_REQUEST_SENTINEL, APPROVED_PLAN_TEXT, CHECKPOINT_MARKER],
        excludes: ["Generate a concise title"],
      },
      "plan file compact manual compact request",
      60000,
      afterRecordCount(compactRequestStartIndex),
    );

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    // V4 compact 身份为 sourceCommandId，helper 投影为 inputId。
    expect(completedMarker.inputId).toBe(startedMarker.inputId);

    const afterCompactRequestStartIndex = await getUpstreamRequestRecordCount();
    const afterCompactPrompt = `${AFTER_COMPACT_MARKER}_${runId}: reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(afterCompactPrompt);
    await waitForV4ComposerText("", "plan file compact 后续输入发送后输入框没有清空");
    await waitForUpstreamRequest(
      {
        // 修复原因：plan file 路径在 Windows 捕获里使用反斜杠，等待条件只校验语义；
        // 下面会用平台原生 planFilePath 精确断言完整路径。
        includes: [
          AFTER_COMPACT_MARKER,
          PLAN_FILE_REFERENCE_SENTINEL,
          PLAN_CONTENTS_SENTINEL,
          APPROVED_PLAN_TEXT,
          PLAN_RELEVANCE_SENTINEL,
        ],
        excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      },
      "plan file compact post-compact provider request",
      60000,
      afterRecordCount(afterCompactRequestStartIndex),
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdle("plan file compact 后续请求没有结束");
    await expectNoVisibleChatErrorBanner();

    const postCompactRequest = await readLatestUpstreamRequestContaining([
      AFTER_COMPACT_MARKER,
      PLAN_FILE_REFERENCE_SENTINEL,
      PLAN_CONTENTS_SENTINEL,
      APPROVED_PLAN_TEXT,
      PLAN_RELEVANCE_SENTINEL,
    ]);
    expect(captureContainsText(postCompactRequest?.requestJson, planFilePath)).toBe(true);
    expect(captureContainsText(postCompactRequest?.requestJson, APPROVED_PLAN_TEXT)).toBe(true);
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

async function approvePlanWithoutFeedback() {
  const approveButton = await $("//button[contains(., 'Approve') or contains(., '批准')]");
  await approveButton.waitForEnabled({ timeout: 30000 });
  await approveButton.click();
}

async function waitForPlanFileContent(planFilePath: string) {
  let latestError = "";
  await browser.waitUntil(
    async () => {
      try {
        const content = await readFile(planFilePath, "utf8");
        return content === APPROVED_PLAN_TEXT;
      } catch (error) {
        latestError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    {
      timeout: 30000,
      timeoutMsg: `批准后的 plan file 没有写入 ${planFilePath}: ${latestError}`,
    },
  );
  return readFile(planFilePath, "utf8");
}

async function waitForIdle(timeoutMsg: string) {
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    timeoutMsg,
    60000,
  );
}

function afterRecordCount(recordCount: number) {
  return recordCount > 0 ? { afterIndex: recordCount - 1 } : {};
}

async function expectNoVisibleChatErrorBanner() {
  const bannerText = await browser.execute(() => {
    const composerRegion = document.querySelector<HTMLElement>(
      "[data-chat-composer-region='true']",
    );
    if (!composerRegion) {
      return "";
    }
    const errorActionLabels = ["复制完整错误", "Copy full error", "提交反馈", "Feedback"];
    const hasErrorActions = Array.from(
      composerRegion.querySelectorAll<HTMLButtonElement>("button"),
    ).some((button) => errorActionLabels.some((label) => button.innerText.includes(label)));
    return hasErrorActions ? composerRegion.innerText : "";
  });
  expect(bannerText).toBe("");
}

async function readLatestUpstreamRequestContaining(includes: string[]) {
  const artifact = await readCaptureArtifact();
  return [...artifact.records]
    .reverse()
    .find(
      (record) =>
        record.method === "POST" &&
        (record.path.includes("/messages") || record.path.includes("/chat/completions")) &&
        includes.every((text) => captureContainsText(record.requestJson, text)),
    );
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH;
  if (!capturePath) {
    throw new Error("E2E_PROVIDER_CAPTURE_PATH is not set");
  }
  return JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
}

function captureContainsText(value: unknown, needle: string): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, needle));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => captureContainsText(item, needle));
  }
  return false;
}

import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { readFile } from "node:fs/promises";

import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_PLAN_APPROVAL_FEEDBACK_USER_MESSAGE";
const ENTER_MARKER = "E2E_PLAN_APPROVAL_ENTER_PLAN";
const EXIT_MARKER = "E2E_PLAN_APPROVAL_EXIT_PLAN";
const FEEDBACK_MARKER = "E2E_PLAN_APPROVAL_FEEDBACK";
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_approval_exit_plan_mode";
const EXIT_PLAN_DENIED_MESSAGE = "The plan was not approved by the user.";

describe("conversation session plan approval feedback user message", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("persists custom ExitPlanMode feedback as a visible user message", async () => {
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: enter plan mode and request approval.`,
      `${ENTER_MARKER}: call EnterPlanMode before drafting.`,
      `${EXIT_MARKER}: call ExitPlanMode with the proposed plan.`,
    ].join(" ");
    const feedback = `${FEEDBACK_MARKER}_${runId}: add explicit test coverage before implementation.`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "composer should clear after sending prompt");
    await waitForV4UserMessageContaining(PROMPT_MARKER);

    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "initial plan-mode request",
      60_000,
    );
    // EnterPlanMode 是隐藏的控制工具；用真实结果证明进入计划模式。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_e2e_plan_approval_enter_plan_mode"))
          ?.isError === false,
      { timeout: 60000, timeoutMsg: "EnterPlanMode 没有成功执行" },
    );

    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, "toolu_e2e_plan_approval_enter_plan_mode"],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "exit plan-mode request",
      60_000,
    );
    await waitForToolCallBlockByToolName("ExitPlanMode", 60_000);

    await waitForPlanApprovalDialog(60_000);
    await submitCustomElicitationAnswer(feedback);

    await waitForUpstreamRequest(
      {
        includes: [feedback, EXIT_MARKER, EXIT_TOOL_CALL_ID, EXIT_PLAN_DENIED_MESSAGE],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "plan feedback continuation request",
      60_000,
    );
    await waitForV4UserMessageContaining(feedback);
    await waitForUserMessageNotContaining(feedback, "Conversation steered");
    await waitForUserMessageNotContaining(feedback, "已引导对话");

    const ordering = await waitForPlanFeedbackProviderOrdering(feedback, EXIT_TOOL_CALL_ID, 10_000);
    expect(ordering.feedbackIndex).toBeGreaterThan(ordering.toolResultIndex);
    expect(ordering.toolResultText).toContain(EXIT_PLAN_DENIED_MESSAGE);
    expect(ordering.toolResultText).not.toContain(feedback);

    await waitForV4AssistantMessageContaining("upstream-e2e-ok");
  });
});

async function waitForPlanApprovalDialog(timeoutMs: number) {
  const expectedText = ["Approve", "批准", "Implementation plan", "实施计划"];
  await browser.waitUntil(
    async () => {
      const body = await $("[data-elicitation-dialog-body='true']");
      if (!(await body.isExisting())) {
        return false;
      }
      const input = await $("[data-elicitation-dialog-body='true'] textarea");
      if (!(await input.isExisting())) {
        return false;
      }
      const footer = await $("[data-elicitation-dialog-footer='true']");
      if (!(await footer.isExisting())) {
        return false;
      }
      const bodyText = await body.getText();
      // 修复原因：plan approval 选项会走 i18n，本地/CI 语言不同时不能只等英文 Approve。
      return expectedText.some((text) => bodyText.includes(text));
    },
    {
      timeout: timeoutMs,
      timeoutMsg: "Timed out waiting for plan approval elicitation dialog",
    },
  );
}

async function waitForUserMessageNotContaining(requiredText: string, forbiddenText: string) {
  await browser.waitUntil(
    async () => {
      const message = await findUserMessageTextContaining(requiredText);
      return message !== null && !message.includes(forbiddenText);
    },
    {
      timeout: 30_000,
      timeoutMsg: `Timed out waiting for user message containing ${requiredText} without ${forbiddenText}`,
    },
  );
}

async function findUserMessageTextContaining(text: string): Promise<string | null> {
  // 反馈已进入 V4 用户消息；旧 chat-user-message 节点不再渲染。
  return (await getV4Messages("user")).find((message) => message.text.includes(text))?.text ?? null;
}

async function submitCustomElicitationAnswer(answer: string) {
  const input = await $("[data-elicitation-dialog-body='true'] textarea");
  await input.waitForDisplayed({ timeout: 30_000 });
  await input.setValue(answer);

  const submitButton = await $("//button[contains(., 'Submit') or contains(., '提交')]");
  await submitButton.waitForEnabled({ timeout: 30_000 });
  await submitButton.click();
}

type ProviderOrdering = {
  feedbackIndex: number;
  toolResultIndex: number;
  toolResultText: string;
};

async function waitForPlanFeedbackProviderOrdering(
  feedback: string,
  toolCallId: string,
  timeoutMs: number,
): Promise<ProviderOrdering> {
  let latestError = "";
  await browser.waitUntil(
    async () => {
      try {
        const ordering = await readPlanFeedbackProviderOrdering(feedback, toolCallId);
        if (ordering.toolResultIndex >= 0 && ordering.feedbackIndex > ordering.toolResultIndex) {
          return true;
        }
        latestError = JSON.stringify(ordering);
        return false;
      } catch (error) {
        latestError = error instanceof Error ? error.message : String(error);
        return false;
      }
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Timed out waiting for provider ordering: ${latestError}`,
    },
  );

  return readPlanFeedbackProviderOrdering(feedback, toolCallId);
}

async function readPlanFeedbackProviderOrdering(
  feedback: string,
  toolCallId: string,
): Promise<ProviderOrdering> {
  const artifact = await readCaptureArtifact();
  const matchingRecord = [...artifact.records].reverse().find((record) => {
    const requestJson = record.requestJson;
    return (
      requestJson !== undefined &&
      captureContainsText(requestJson, feedback) &&
      captureContainsText(requestJson, toolCallId)
    );
  });

  if (!matchingRecord?.requestJson) {
    throw new Error("No provider request contains both feedback and tool call id");
  }

  const blocks = flattenProviderMessageBlocks(matchingRecord.requestJson);
  const toolResultIndex = blocks.findIndex((block) => block.toolUseId === toolCallId);
  const feedbackIndex = blocks.findIndex(
    (block) => block.role === "user" && block.text.includes(feedback),
  );
  const toolResultText = toolResultIndex >= 0 ? (blocks[toolResultIndex]?.text ?? "") : "";

  return {
    feedbackIndex,
    toolResultIndex,
    toolResultText,
  };
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

type ProviderBlock = {
  role: string;
  text: string;
  toolUseId?: string;
};

function flattenProviderMessageBlocks(requestJson: unknown): ProviderBlock[] {
  const messages = readMessages(requestJson);
  const blocks: ProviderBlock[] = [];

  for (const message of messages) {
    const role = readStringProperty(message, "role") ?? "";
    const content = readProperty(message, "content");
    if (Array.isArray(content)) {
      for (const block of content) {
        blocks.push({
          role,
          text: readProviderText(block),
          toolUseId: readStringProperty(block, "tool_use_id"),
        });
      }
      continue;
    }
    blocks.push({
      role,
      text: readProviderText(content),
    });
  }

  return blocks;
}

function readMessages(requestJson: unknown): unknown[] {
  const messages = readProperty(requestJson, "messages");
  return Array.isArray(messages) ? messages : [];
}

function readProviderText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(readProviderText).join("\n");
  }
  if (value && typeof value === "object") {
    const text = readStringProperty(value, "text");
    if (text !== undefined) {
      return text;
    }
    return JSON.stringify(value);
  }
  return "";
}

function readProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

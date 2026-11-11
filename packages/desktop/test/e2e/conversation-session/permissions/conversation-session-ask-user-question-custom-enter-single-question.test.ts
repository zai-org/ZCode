import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool";
import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_TOOL_SUMMARY_TRIGGER,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_CUSTOM_ENTER_SINGLE";
const TOOL_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SINGLE_TOOL";
const QUESTION_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SINGLE_QUESTION";
const ANSWER_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SINGLE_ANSWER";

describe("会话区 AskUserQuestion 单题 custom input Enter E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("只有一题时 custom input 按 Enter 应直接提交答案", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${TOOL_MARKER}: ask one question before continuing.`,
      `${QUESTION_MARKER}: include this marker in the question text.`,
      "The custom answer will be submitted by pressing Enter in the custom input.",
      "After the user answers, continue with a brief acknowledgement.",
    ].join(" ");
    const answer = `${ANSWER_MARKER}_${runId}`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "AskUserQuestion 单题首发后输入框没有清空");
    await waitForV4UserMessageContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationDialogContaining(QUESTION_MARKER);
    // 对照多题 case：单题 custom input 的 Enter 应等价于最终提交。
    await pressEnterInCustomElicitationInput(answer);

    await waitForUpstreamRequest(
      {
        includes: [answer, TOOL_MARKER],
      },
      "AskUserQuestion 单题自定义回答按 Enter 后没有进入下一次模型请求",
      60000,
    );

    await waitForExpandedAskUserQuestionBlockContaining(answer, 8000);
  });
});

async function pressEnterInCustomElicitationInput(answer: string) {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  await input.click();
  await input.setValue(answer);
  await browser.waitUntil(async () => (await input.getValue()) === answer, {
    timeout: 10000,
    timeoutMsg: "AskUserQuestion 自定义回答没有写入输入框",
  });
  await browser.keys("Enter");
}

async function waitForElicitationDialogContaining(text: string, timeout = 60000) {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationDialogText();
        return latest.includes(text);
      },
      {
        timeout,
        timeoutMsg: `AskUserQuestion 问答卡片没有显示预期内容: ${text}`,
      },
    );
  } catch (error) {
    latest = await getElicitationDialogText();
    throw new Error(`AskUserQuestion 问答卡片没有显示预期内容: ${text}; latest=${latest}`, {
      cause: error,
    });
  }
}

function getElicitationDialogText() {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    return normalizeText(
      document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]')?.innerText,
    );
  });
}

async function waitForExpandedAskUserQuestionBlockContaining(text: string, timeout: number) {
  let latest: AskUserQuestionBlockDiagnostics | null = null;
  try {
    await browser.waitUntil(
      async () => {
        // V4 历史不再提供 data-history-has-content；按实际 content 节点展开。
        await expandAssistantHistoriesWithContent();
        latest = await getExpandedAskUserQuestionBlockDiagnostics(text);
        return latest.matched;
      },
      {
        timeout,
        timeoutMsg: "AskUserQuestion 自定义回答没有显示在已询问消息详情里",
      },
    );
  } catch (error) {
    latest = await getExpandedAskUserQuestionBlockDiagnostics(text);
    throw new Error(
      `AskUserQuestion 自定义回答没有显示在已询问消息详情里; diagnostics=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

interface AskUserQuestionBlockDiagnostics {
  blocks: Array<{
    expanded: boolean;
    text: string;
    toolCallId: string | null;
  }>;
  matched: boolean;
}

function getExpandedAskUserQuestionBlockDiagnostics(
  text: string,
): Promise<AskUserQuestionBlockDiagnostics> {
  return browser.execute(
    (historyTriggerPrefix, toolBlockPrefix, summaryTriggerPrefix, expectedText) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
      const historyTriggers = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${historyTriggerPrefix}-"]`),
      );
      for (const trigger of historyTriggers) {
        if (
          trigger.getAttribute("data-history-has-content") === "true" &&
          trigger.getAttribute("aria-expanded") !== "true"
        ) {
          trigger.click();
        }
      }

      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${toolBlockPrefix}-"][data-tool-name="AskUserQuestion"]`,
        ),
      );

      for (const block of blocks) {
        const trigger = block.querySelector<HTMLElement>(
          `[data-testid^="${summaryTriggerPrefix}-"]`,
        );
        if (trigger && trigger.getAttribute("aria-expanded") !== "true") {
          trigger.click();
        }
      }

      const snapshots = blocks.map((block) => {
        const trigger = block.querySelector<HTMLElement>(
          `[data-testid^="${summaryTriggerPrefix}-"]`,
        );
        return {
          expanded: trigger?.getAttribute("aria-expanded") === "true",
          text: normalizeText(block.innerText),
          toolCallId: block.getAttribute("data-tool-call-id"),
        };
      });

      return {
        blocks: snapshots,
        matched: snapshots.some((block) => block.text.includes(expectedText)),
      };
    },
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_TOOL_CALL_BLOCK,
    TID_TOOL_SUMMARY_TRIGGER,
    text,
  );
}

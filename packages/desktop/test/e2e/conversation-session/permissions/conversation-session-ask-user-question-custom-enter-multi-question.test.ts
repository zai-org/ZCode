import { TID_CHAT_TOOL_CALL_BLOCK, TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_CUSTOM_ENTER_MULTI";
const TOOL_MARKER = "E2E_ASK_USER_QUESTION_ENTER_MULTI_TOOL";
const FIRST_QUESTION_MARKER = "E2E_ASK_USER_QUESTION_ENTER_FIRST";
const SECOND_QUESTION_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SECOND";
const FIRST_ANSWER_MARKER = "E2E_ASK_USER_QUESTION_ENTER_FIRST_ANSWER";
const SECOND_ANSWER_MARKER = "E2E_ASK_USER_QUESTION_ENTER_SECOND_ANSWER";

describe("会话区 AskUserQuestion 多题 custom input Enter E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("非最后一题 custom input 按 Enter 应进入下一题而不是提前提交", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${TOOL_MARKER}: ask two questions before continuing.`,
      "The first answer will be submitted by pressing Enter in the custom input.",
      "After the user answers both questions, continue with a brief acknowledgement.",
    ].join(" ");
    const firstAnswer = `${FIRST_ANSWER_MARKER}_${runId}`;
    const secondAnswer = `${SECOND_ANSWER_MARKER}_${runId}`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "AskUserQuestion 多题首发后输入框没有清空");
    await waitForV4UserMessageContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationDialogContaining(FIRST_QUESTION_MARKER);
    // 回归点：custom input 的 Enter 不能绕过多题分页，否则第 1 题会把整个问答提前提交。
    await pressEnterInCustomElicitationInput(firstAnswer);

    await waitForElicitationDialogContaining(SECOND_QUESTION_MARKER, 10000);
    await expectNoUpstreamRequestForTextWithin(firstAnswer, 900);

    await submitCustomElicitationAnswer(secondAnswer);

    await waitForUpstreamRequest(
      {
        includes: [firstAnswer, secondAnswer, TOOL_MARKER],
      },
      "AskUserQuestion 多题自定义回答没有一起进入下一次模型请求",
      60000,
    );

    await waitForExpandedAskUserQuestionBlockContaining(firstAnswer, 8000);
    await waitForExpandedAskUserQuestionBlockContaining(secondAnswer, 8000);
  });
});

async function pressEnterInCustomElicitationInput(answer: string) {
  const input = await fillCustomElicitationAnswer(answer);
  await input.click();
  await browser.keys("Enter");
}

async function submitCustomElicitationAnswer(answer: string) {
  await fillCustomElicitationAnswer(answer);

  const clicked = (await browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const footer = document.querySelector<HTMLElement>('[data-elicitation-dialog-footer="true"]');
    const button = Array.from(footer?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => {
        const text = normalizeText(candidate.textContent);
        return text === "Submit" || text === "提交";
      },
    );
    button?.click();
    return Boolean(button);
  })) as boolean;
  expect(clicked).toBe(true);
}

async function fillCustomElicitationAnswer(answer: string) {
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
  return input;
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
        // V4 已移除旧历史属性；失败录像中的已工作详情仍折叠，须先经真实 UI 展开。
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
    (toolBlockPrefix, summaryTriggerPrefix, expectedText) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? "").replace(/\u00a0/g, " ").trim();
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
    TID_CHAT_TOOL_CALL_BLOCK,
    TID_TOOL_SUMMARY_TRIGGER,
    text,
  );
}

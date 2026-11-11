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

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_CUSTOM_CLICK_MULTI";
const TOOL_MARKER = "E2E_ASK_USER_QUESTION_CLICK_MULTI_TOOL";
const QUESTION_ONE_MARKER = "E2E_AQ_CLICK_MULTI_Q1_CUSTOM";
const QUESTION_TWO_MARKER = "E2E_AQ_CLICK_MULTI_Q2_CUSTOM";
const QUESTION_THREE_MARKER = "E2E_AQ_CLICK_MULTI_Q3_CUSTOM";
const ANSWER_ONE_MARKER = "E2E_AQ_CLICK_MULTI_A1";
const ANSWER_TWO_MARKER = "E2E_AQ_CLICK_MULTI_A2";
const ANSWER_THREE_MARKER = "E2E_AQ_CLICK_MULTI_A3";

describe("会话区 AskUserQuestion 多题 custom input 鼠标点击 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("三题都手打自定义答案后鼠标点击继续/提交不应丢失中间题", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${TOOL_MARKER}: ask exactly three questions in one AskUserQuestion call.`,
      `Question 1 text must include ${QUESTION_ONE_MARKER}.`,
      `Question 2 text must include ${QUESTION_TWO_MARKER}.`,
      `Question 3 text must include ${QUESTION_THREE_MARKER}.`,
      "Each question should provide exactly two non-Other options; the client will provide the custom answer input.",
      "The user will type custom answers and use mouse clicks to continue or submit.",
      "After the user answers all questions, continue with a brief acknowledgement.",
    ].join(" ");
    const firstAnswer = `${ANSWER_ONE_MARKER}_${runId}`;
    const secondAnswer = `${ANSWER_TWO_MARKER}_${runId}`;
    const thirdAnswer = `${ANSWER_THREE_MARKER}_${runId}`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "AskUserQuestion 鼠标点击多题首发后输入框没有清空");
    await waitForV4UserMessageContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationPage("1 / 3", QUESTION_ONE_MARKER);
    await typeCustomElicitationAnswer(firstAnswer);
    await clickPrimaryElicitationAction(["Continue", "继续"]);

    await waitForElicitationPage("2 / 3", QUESTION_TWO_MARKER, 10000);
    await expectNoUpstreamRequestForTextWithin(firstAnswer, 900);
    await typeCustomElicitationAnswer(secondAnswer);
    await clickPrimaryElicitationAction(["Continue", "继续"]);

    await waitForElicitationPage("3 / 3", QUESTION_THREE_MARKER, 10000);
    await expectNoUpstreamRequestForTextWithin(secondAnswer, 900);
    await typeCustomElicitationAnswer(thirdAnswer);
    await clickPrimaryElicitationAction(["Submit", "提交"]);

    await waitForUpstreamRequest(
      {
        includes: [firstAnswer, secondAnswer, thirdAnswer, TOOL_MARKER],
      },
      "AskUserQuestion 三题自定义鼠标提交后没有把全部答案带入下一次模型请求",
      60000,
    );

    await waitForExpandedAskUserQuestionBlockContaining(firstAnswer, 8000);
    await waitForExpandedAskUserQuestionBlockContaining(secondAnswer, 8000);
    await waitForExpandedAskUserQuestionBlockContaining(thirdAnswer, 8000);
    await expectNoFailedAskUserQuestionBlockForMarkers([
      QUESTION_ONE_MARKER,
      QUESTION_TWO_MARKER,
      QUESTION_THREE_MARKER,
    ]);
  });
});

async function typeCustomElicitationAnswer(answer: string) {
  const input = await getCustomElicitationInput();
  await input.click();
  await browser.keys(answer);
  await browser.waitUntil(async () => (await input.getValue()) === answer, {
    timeout: 10000,
    timeoutMsg: "AskUserQuestion 自定义回答没有通过键盘逐字写入输入框",
  });
}

async function getCustomElicitationInput() {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  return input;
}

async function clickPrimaryElicitationAction(actionLabels: string[]) {
  const footer = await $('[data-elicitation-dialog-footer="true"]');
  await footer.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: "AskUserQuestion 操作按钮区域没有出现",
  });

  const buttons = await footer.$$("button");
  const actualLabels: string[] = [];
  for (const button of buttons) {
    const label = normalizeText(await button.getText());
    actualLabels.push(label);
    if (actionLabels.includes(label)) {
      await button.click();
      return;
    }
  }

  throw new Error(
    `AskUserQuestion 鼠标操作按钮没有出现: expected=${actionLabels.join("|")}; actual=${actualLabels.join("|")}`,
  );
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\u00a0/g, " ").trim();
}

async function waitForElicitationPage(pageText: string, questionText: string, timeout = 60000) {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationDialogText();
        return latest.includes(pageText) && latest.includes(questionText);
      },
      {
        timeout,
        timeoutMsg: `AskUserQuestion 问答卡片没有进入目标题目: ${pageText} ${questionText}`,
      },
    );
  } catch (error) {
    latest = await getElicitationDialogText();
    throw new Error(
      `AskUserQuestion 问答卡片没有进入目标题目: ${pageText} ${questionText}; latest=${latest}`,
      { cause: error },
    );
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

async function expectNoFailedAskUserQuestionBlockForMarkers(markers: string[]) {
  const diagnostics = await getExpandedAskUserQuestionBlockDiagnostics("");
  const failureTexts = ["Failed", "失败", "No answer provided", "未提供回答", "未回答"];
  const failedBlocks = diagnostics.blocks.filter(
    (block) =>
      markers.every((marker) => block.text.includes(marker)) &&
      failureTexts.some((failureText) => block.text.includes(failureText)),
  );

  if (failedBlocks.length > 0) {
    throw new Error(
      `AskUserQuestion 鼠标提交后额外出现未回答或失败的同组问题块; diagnostics=${JSON.stringify(
        diagnostics,
      )}`,
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

import { TID_CHAT_TOOL_CALL_BLOCK, TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_ANSWER_VISIBLE";
const LEGACY_TOOL_MARKER = "E2E_TOOL_CROSS_PRODUCT_ASK_USER_QUESTION";
const ANSWER_MARKER = "E2E_ASK_USER_QUESTION_CUSTOM_ANSWER";

describe("会话区 AskUserQuestion 问答响应可见性 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("自定义问答响应被 agent 消费后仍应保留在 AskUserQuestion 消息里", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${LEGACY_TOOL_MARKER}: ask a single question before continuing.`,
      "After the user answers, continue with a brief acknowledgement.",
    ].join(" ");
    const answer = `${ANSWER_MARKER}_${runId}`;

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "AskUserQuestion 首发后输入框没有清空");
    await waitForV4UserMessageContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationDialog();
    await submitCustomElicitationAnswer(answer);

    await waitForUpstreamRequest(
      {
        includes: [answer, LEGACY_TOOL_MARKER],
      },
      "AskUserQuestion 自定义回答没有进入下一次模型请求",
      60000,
    );

    await waitForExpandedAskUserQuestionBlockContaining(answer, 8000);
  });
});

async function waitForElicitationDialog() {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationDialogText();
        return latest.length > 0;
      },
      {
        timeout: 60000,
        timeoutMsg: "AskUserQuestion 问答卡片没有出现",
      },
    );
  } catch (error) {
    latest = await getElicitationDialogText();
    throw new Error(`AskUserQuestion 问答卡片没有出现; latest=${latest}`, {
      cause: error,
    });
  }
}

async function submitCustomElicitationAnswer(answer: string) {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  await input.setValue(answer);
  await browser.waitUntil(async () => (await input.getValue()) === answer, {
    timeout: 10000,
    timeoutMsg: "AskUserQuestion 自定义回答没有写入输入框",
  });

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

      // 修复原因：AskUserQuestion 折叠态只展示统计，回答内容保留在展开详情里。
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

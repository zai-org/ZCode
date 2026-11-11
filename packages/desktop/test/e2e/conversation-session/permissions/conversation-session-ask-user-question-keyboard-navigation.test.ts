import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const PROMPT_MARKER = "E2E_ASK_USER_QUESTION_KEYBOARD_NAV";
const TOOL_MARKER = "E2E_ASK_USER_QUESTION_KEYBOARD_NAV_TOOL";
const CUSTOM_ANSWER_MARKER = "E2E_ASK_USER_QUESTION_KEYBOARD_CUSTOM";
const QUESTION_ONE = "E2E_AQK_Q1_CUSTOM_ENTER";
const QUESTION_TWO = "E2E_AQK_Q2_OPTION_SPACE";
const QUESTION_THREE = "E2E_AQK_Q3_OPTION_ENTER";
const Q1_OPTION_A = "E2E_AQK_Q1_OPTION_A";
const Q1_OPTION_B = "E2E_AQK_Q1_OPTION_B";
const Q2_OPTION_A = "E2E_AQK_Q2_OPTION_A";
const Q2_OPTION_B = "E2E_AQK_Q2_OPTION_B";
const Q3_OPTION_A = "E2E_AQK_Q3_OPTION_A";
const Q3_OPTION_B = "E2E_AQK_Q3_OPTION_B";

describe("会话区 AskUserQuestion 键盘导航 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("自定义 Enter、Esc 返回、上下预选和空格/Enter 选中应符合多题问答键盘语义", async function () {
    this.timeout(180000);

    // Bug 根因：已转正用例仍经由 legacy helper 定位消息，
    // 与 formal 目录的 V4 pane 证据合同不一致。
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const customAnswer = `${CUSTOM_ANSWER_MARKER}_${runId}`;
    const prompt = [
      `${PROMPT_MARKER}_${runId}: Trigger the AskUserQuestion tool exactly once.`,
      `${TOOL_MARKER}: ask exactly three questions in one AskUserQuestion call.`,
      `Question 1 text must be ${QUESTION_ONE} and should allow a custom answer.`,
      `Question 2 text must be ${QUESTION_TWO} with options ${Q2_OPTION_A} and ${Q2_OPTION_B}.`,
      `Question 3 text must be ${QUESTION_THREE} with options ${Q3_OPTION_A} and ${Q3_OPTION_B}.`,
      "Do not answer the questions yourself. After the user responds, continue briefly.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${PROMPT_MARKER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);
    await waitForElicitationPage("1 / 3", QUESTION_ONE);
    expect(await readCustomInputSemantics()).toEqual({
      tagName: "TEXTAREA",
      rows: "1",
      autoSizing: true,
    });

    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.activeElement?.getAttribute("data-elicitation-dialog-card") === "true",
        ),
      { timeout: 10000, timeoutMsg: "普通问答初始焦点应在卡片，不能自动进入自定义输入框" },
    );
    await browser.keys("ArrowUp");
    await expectCustomInputFocused();
    const input = await $('[data-elicitation-dialog-body="true"] textarea');
    // 长答案必须真的换行并在五行内滚动；仅断言 CSS class 无法发现布局失效。
    // 修复原因：原先重复 240 次（约 6700 字符），Windows chromedriver 逐键输入超过
    // WebDriver 单请求 30 秒上限而中断；24 次已远超五行高度，足以覆盖换行与滚动断言。
    await input.setValue("自动换行的自定义回答 wrapped answer ".repeat(24));
    const layout = await browser.execute(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '[data-elicitation-dialog-body="true"] textarea',
      )!;
      const style = getComputedStyle(textarea);
      const markerRect = textarea.previousElementSibling!.getBoundingClientRect();
      return {
        height: textarea.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight),
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
        marker: textarea.previousElementSibling?.textContent,
        markerFirstLineCenterGap: Math.abs(
          markerRect.top +
            markerRect.height / 2 -
            (textarea.getBoundingClientRect().top +
              parseFloat(style.borderTopWidth) +
              parseFloat(style.paddingTop) +
              parseFloat(style.lineHeight) / 2),
        ),
      };
    });
    expect(layout.height).toBeGreaterThan(layout.lineHeight * 4);
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight * 5 + 1);
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    expect(layout.marker).toBe("3.");
    expect(layout.markerFirstLineCenterGap).toBeLessThanOrEqual(0.5);

    await focusCustomInputAndSetValue(customAnswer);
    await browser.keys("ArrowUp");
    await expectActiveOption(Q1_OPTION_B);
    await browser.keys("ArrowDown");
    await expectCustomInputFocused();
    await browser.keys("ArrowDown");
    await expectActiveOption(Q1_OPTION_A);
    await browser.keys("ArrowUp");
    await expectCustomInputFocused();
    await expectCustomInputValue(customAnswer);
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 3", QUESTION_TWO);

    await browser.keys("Escape");
    await waitForElicitationPage("1 / 3", QUESTION_ONE);
    await expectCustomInputValue(customAnswer);

    await browser.keys("Enter");
    await waitForElicitationPage("2 / 3", QUESTION_TWO);
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPTION_A);
    await browser.keys("ArrowDown");
    await expectActiveOption(Q2_OPTION_B);
    await browser.keys(" ");
    await waitForElicitationPage("3 / 3", QUESTION_THREE);

    await browser.keys("Tab");
    await expectActiveOption(Q3_OPTION_A);
    await browser.keys("ArrowDown");
    await expectActiveOption(Q3_OPTION_B);
    await browser.keys("ArrowUp");
    await expectActiveOption(Q3_OPTION_A);
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      {
        includes: [customAnswer, Q2_OPTION_B, Q3_OPTION_A, TOOL_MARKER],
      },
      "AskUserQuestion 键盘选择结果没有进入下一次模型请求",
      60000,
    );
  });
});

interface ElicitationKeyboardSnapshot {
  activeText: string;
  bodyText: string;
  customInputValue: string;
  focusedTag: string;
  pageText: string | null;
  selectedTexts: string[];
  visible: boolean;
}

async function waitForElicitationPage(pageText: string, questionText: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return (
          latest.visible && latest.pageText === pageText && latest.bodyText.includes(questionText)
        );
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 没有进入目标题目 ${pageText} ${questionText}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 没有进入目标题目; expected=${pageText}/${questionText}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function focusCustomInputAndSetValue(value: string) {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "AskUserQuestion 自定义回答输入框没有出现",
  });
  await input.click();
  await input.setValue(value);
  await expectCustomInputValue(value);
}

async function expectCustomInputValue(value: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.customInputValue === value;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 自定义回答输入框内容不符合预期",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 自定义回答输入框内容不符合预期; expected=${value}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectCustomInputFocused() {
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.activeElement ===
          document.querySelector('[data-elicitation-dialog-body="true"] textarea'),
      ),
    { timeout: 10000, timeoutMsg: "上下键没有把真实焦点移到自定义输入框" },
  );
}

function readCustomInputSemantics() {
  return browser.execute(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-elicitation-dialog-body="true"] textarea',
    );
    return {
      tagName: textarea?.tagName ?? null,
      rows: textarea?.getAttribute("rows") ?? null,
      autoSizing: textarea?.classList.contains("field-sizing-content") ?? false,
    };
  });
}

async function expectActiveOption(optionText: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.activeText.includes(optionText);
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 当前预选项不是 ${optionText}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 当前预选项不是 ${optionText}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

function getElicitationKeyboardSnapshot(): Promise<ElicitationKeyboardSnapshot> {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
    const focused = document.activeElement as HTMLElement | null;
    // 修复原因：普通问答切题后卡片本身获得焦点，第一项仅作为 roving
    // tabindex 入口保留 tabindex=0，不能把它误判为真实焦点。
    const activeOption = focused?.closest<HTMLElement>('button[role="option"],[role="checkbox"]');
    const pageText =
      normalizeText(body?.innerText)
        .match(/\b\d+\s*\/\s*\d+\b/)?.[0]
        ?.replace(/\s+/g, " ") ?? null;
    const selectedTexts = Array.from(
      body?.querySelectorAll<HTMLElement>(
        'button[role="option"][aria-selected="true"],[role="checkbox"][aria-checked="true"]',
      ) ?? [],
    ).map((element) => normalizeText(element.innerText));
    const input = body?.querySelector<HTMLTextAreaElement>("textarea") ?? null;

    return {
      activeText: normalizeText(activeOption?.innerText),
      bodyText: normalizeText(body?.innerText),
      customInputValue: input?.value ?? "",
      focusedTag: focused?.tagName ?? "",
      pageText,
      selectedTexts,
      visible: Boolean(body),
    };
  });
}

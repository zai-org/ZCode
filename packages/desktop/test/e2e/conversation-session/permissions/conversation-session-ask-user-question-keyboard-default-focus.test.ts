import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const MARKER_EMPTY_SUBMIT = "E2E_ADF_EMPTY_SUBMIT";
const MARKER_TAB_ENTER = "E2E_ADF_TAB_ENTER";
const MARKER_ENTER_SKIP = "E2E_ADF_ENTER_SKIP";
const MARKER_MULTISELECT = "E2E_ADF_MULTISELECT";
const MARKER_ESCAPE_DISMISS = "E2E_ADF_ESCAPE_DISMISS";

const Q1_SINGLE = "E2E_ADF_Q1_SINGLE_SELECT";
const Q2_MULTI = "E2E_ADF_Q2_MULTI_SELECT";

const Q1_OPT_A = "E2E_ADF_Q1_A";
const Q1_OPT_B = "E2E_ADF_Q1_B";
const Q2_OPT_A = "E2E_ADF_Q2_A";
const Q2_OPT_B = "E2E_ADF_Q2_B";
const Q2_OPT_C = "E2E_ADF_Q2_C";

describe("AskUserQuestion 默认无焦点键盘导航 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  // Q15: 弹窗打开无预选 → 鼠标点 Submit → 提交空答案
  it("弹窗打开无预聚焦，鼠标点 Submit 提交空答案", async function () {
    this.timeout(180000);

    // Bug 根因：该 case 转正后仍使用 legacy conversation harness，
    // formal 证据无法确保操作的是当前 V4 pane。
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_EMPTY_SUBMIT}_${runId}: Trigger AskUserQuestion with one single-select question.`,
      `Question "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_EMPTY_SUBMIT}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    // 确认弹窗出现且无选项高亮
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // 直接点 Submit
    await clickPrimaryAction();

    // 确认提交了空答案
    await waitForUpstreamRequest(
      {
        includes: [`${MARKER_EMPTY_SUBMIT}_${runId}`, "toolu_e2e_adf_empty_submit"],
      },
      "空答案提交后 Agent 没有收到回复",
      60000,
    );
  });

  // Q18: 弹窗打开无预选 → Tab → 第一项聚焦 → Enter → 选中并推进
  it("无预聚焦时按 Tab 聚焦第一项，Enter 选中推进", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_TAB_ENTER}_${runId}: Trigger AskUserQuestion with two questions.`,
      `Q1 single-select "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      `Q2 single-select "${Q2_MULTI}" with options "${Q2_OPT_A}" and "${Q2_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_TAB_ENTER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    // 确认无预选
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // Tab → 第一项聚焦
    await browser.keys("Tab");
    await expectActiveOption(Q1_OPT_A);

    // Enter → 选中并推进到 Q2
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Q2 也是无预选（切题后普通问答不预聚焦）。
    await expectNoOptionPreSelected();

    // 初始 ArrowDown 与 Tab 同样从卡片焦点启动，聚焦第一项但不选中。
    await browser.keys("ArrowDown");
    await expectActiveOption(Q2_OPT_A);
    await expectOptionSelected(Q2_OPT_A, false);
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      { includes: [`${MARKER_TAB_ENTER}_${runId}`, Q1_OPT_A, Q2_OPT_A] },
      "Tab+Enter 选择结果没有进入下一次模型请求",
      60000,
    );
  });

  // Q19: 弹窗打开无预选 → 直接 Enter → 跳过当前题推进
  it("无预聚焦时直接按 Enter 跳过当前题推进", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_ENTER_SKIP}_${runId}: Trigger AskUserQuestion with two single-select questions.`,
      `Q1 "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      `Q2 "${Q2_MULTI}" with options "${Q2_OPT_A}" and "${Q2_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_ENTER_SKIP}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // 直接 Enter → 跳过 Q1
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Q22：后续题仍处于卡片初始焦点时，Escape 返回上一题。
    await expectNoOptionPreSelected();
    await browser.keys("Escape");
    await waitForElicitationPage("1 / 2", Q1_SINGLE);
    await expectNoOptionPreSelected();

    // 再次直接 Enter 跳过 Q1，证明返回没有隐式写入第一项。
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Tab → 选中 Q2 第一项 → Enter 提交
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPT_A);
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      {
        includes: [`${MARKER_ENTER_SKIP}_${runId}`, "toolu_e2e_adf_enter_skip", Q2_OPT_A],
      },
      "Q1 跳过 + Q2 Enter 选中后没有进入模型请求",
      60000,
    );
  });

  // Q20: 多选题 Space 勾选/取消，Enter 确认
  it("多选题 Space 勾选取消，Enter 确认提交", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_MULTISELECT}_${runId}: Trigger AskUserQuestion with one multi-select question.`,
      `Multi-select question "${Q2_MULTI}"`,
      `with options "${Q2_OPT_A}", "${Q2_OPT_B}", "${Q2_OPT_C}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_MULTISELECT}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationVisible(Q2_MULTI);
    await expectNoOptionSelected();

    // Tab 聚焦第一项
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPT_A);

    // Space 勾选 Q2_OPT_A
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_A, true);

    // ArrowDown 移到 Q2_OPT_B
    await browser.keys("ArrowDown");
    // Space 勾选 Q2_OPT_B
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, true);

    // ArrowDown 移到 Q2_OPT_C，Space 勾选
    await browser.keys("ArrowDown");
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_C, true);

    // ArrowUp 回到 Q2_OPT_B，Space 取消勾选
    await browser.keys("ArrowUp");
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, false);

    // Enter 确认提交
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      { includes: [`${MARKER_MULTISELECT}_${runId}`, Q2_OPT_A, Q2_OPT_C] },
      "多选 Space + Enter 结果没有进入模型请求",
      60000,
    );
  });

  // Q22: 首题卡片初始焦点 → Escape → dismiss，并把 declined 结果回传 Agent
  it("首题无选项聚焦时按 Escape 关闭整组问答", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_ESCAPE_DISMISS}_${runId}: Trigger AskUserQuestion with one single-select question.`,
      `Question "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      "Do not answer. Stop if the user dismisses the question.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_ESCAPE_DISMISS}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    await browser.keys("Escape");
    await waitForElicitationClosed();
    // 修复原因：负向 1200ms 抓包计数依赖 artifact 写盘时机，单跑可能在请求已经
    // 发出时仍读取旧文件而假绿。当前产品合同是 dismiss 关闭 UI，并把 declined
    // tool_result 交给模型收口；用 case-local final fixture 对该请求做正向取证。
    await waitForUpstreamRequest(
      {
        includes: [
          `${MARKER_ESCAPE_DISMISS}_${runId}`,
          "toolu_e2e_adf_escape_dismiss",
          "AskUserQuestion was declined",
        ],
      },
      "Escape dismiss 后 declined tool_result 没有进入模型收口请求",
      60000,
    );
    await waitForV4TimelineContaining("E2E_ADF_ESCAPE_DISMISS_ACK", 60000);
  });
});

// --- helpers ---

interface ElicitationKeyboardSnapshot {
  activeText: string;
  bodyText: string;
  cardFocused: boolean;
  pageText: string | null;
  selectedTexts: string[];
  visible: boolean;
}

async function waitForElicitationVisible(questionContains: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.visible && latest.bodyText.includes(questionContains);
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 弹窗没有出现或内容不包含 "${questionContains}"`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗没有出现; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function waitForElicitationPage(pageText: string, questionContains: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return (
          latest.visible &&
          latest.pageText === pageText &&
          latest.bodyText.includes(questionContains)
        );
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 没有进入目标题目 ${pageText} ${questionContains}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 没有进入目标题目; expected=${pageText}/${questionContains}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectNoOptionPreSelected() {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.cardFocused && latest.activeText === "" && latest.selectedTexts.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 弹窗不应有预选选项",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗不应有预选选项; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function expectNoOptionSelected() {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.selectedTexts.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 弹窗不应有已选选项",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗不应有已选选项; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
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
        timeoutMsg: `AskUserQuestion 当前焦点选项不是 "${optionText}"`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 当前焦点选项不是 "${optionText}"; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectOptionChecked(optionText: string, checked: boolean) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        const isSelected = latest.selectedTexts.some((t) => t.includes(optionText));
        return isSelected === checked;
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 勾选状态不符合预期; option=${optionText} expectedChecked=${checked}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 勾选状态不符合预期; option=${optionText} expectedChecked=${checked}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectOptionSelected(optionText: string, selected: boolean) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        const isSelected = latest.selectedTexts.some((text) => text.includes(optionText));
        return isSelected === selected;
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 单选状态不符合预期; option=${optionText} expectedSelected=${selected}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 单选状态不符合预期; option=${optionText} expectedSelected=${selected}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function clickPrimaryAction() {
  const button = await $('[data-elicitation-dialog-footer="true"] button:last-child');
  await button.waitForDisplayed({ timeout: 10000 });
  await button.click();
}

async function waitForElicitationClosed() {
  await browser.waitUntil(
    async () =>
      !(await browser.execute(() =>
        Boolean(document.querySelector('[data-elicitation-dialog-card="true"]')),
      )),
    {
      timeout: 10000,
      timeoutMsg: "AskUserQuestion 弹窗没有在 Escape 后关闭",
    },
  );
}

function getElicitationKeyboardSnapshot(): Promise<ElicitationKeyboardSnapshot> {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
    const focused = document.activeElement as HTMLElement | null;
    const card = document.querySelector<HTMLElement>('[data-elicitation-dialog-card="true"]');
    // 修复原因：roving tabindex 会在卡片聚焦时仍给第一项 tabindex=0；只有
    // document.activeElement 才能证明选项获得了真实键盘焦点。
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

    return {
      activeText: normalizeText(activeOption?.innerText),
      bodyText: normalizeText(body?.innerText),
      cardFocused: focused === card,
      pageText,
      selectedTexts,
      visible: Boolean(body),
    };
  });
}

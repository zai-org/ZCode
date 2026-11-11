import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";
import {
  TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";

const FIRST_PROMPT = "E2E_ASK_AUTO_RESOLUTION_SETTING_FIRST";
const FIRST_ANSWER = "E2E_ASK_AUTO_RESOLUTION_SETTING_FIRST_ANSWER";
const FIRST_FINAL = "E2E_ASK_AUTO_RESOLUTION_SETTING_FIRST_DONE";
const SECOND_PROMPT = "E2E_ASK_AUTO_RESOLUTION_SETTING_SECOND";
const SECOND_FINAL = "E2E_ASK_AUTO_RESOLUTION_SETTING_SECOND_AUTO_DONE";

describe("AskUserQuestion 自动继续设置 GUI 候选", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("计时中关闭后跨 deadline 仍等待，重开不追溯，新问题恢复自动继续", async function () {
    this.timeout(180_000);
    const clockScale = requireInjectedClockScale();
    const acceleratedDeadlineMs = Math.ceil(300_000 / clockScale);

    await prepareV4ConversationE2E();
    await setAutoResolutionEnabled(true);

    await sendV4Prompt(
      `${FIRST_PROMPT}: call AskUserQuestion exactly once, then wait for my answer. ` +
        `After the answer, reply with ${FIRST_FINAL}.`,
    );
    await waitForV4ComposerText("", "首个 AskUserQuestion 提交后输入框没有清空");
    await waitForV4UserMessageContaining(FIRST_PROMPT);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60_000);
    await waitForElicitationDialog(FIRST_PROMPT);

    await setAutoResolutionEnabled(false);
    await waitForElicitationDialog(FIRST_PROMPT);
    await browser.pause(acceleratedDeadlineMs + 1_000);
    await waitForElicitationDialog(FIRST_PROMPT);

    await setAutoResolutionEnabled(true);
    await browser.pause(acceleratedDeadlineMs + 1_000);
    await waitForElicitationDialog(FIRST_PROMPT);

    await submitCustomAnswer(FIRST_ANSWER);
    await waitForV4AssistantMessageContaining(FIRST_FINAL);

    await sendV4Prompt(
      `${SECOND_PROMPT}: call AskUserQuestion exactly once, then wait for my answer. ` +
        `After automatic continuation, reply with ${SECOND_FINAL}.`,
    );
    await waitForV4ComposerText("", "第二个 AskUserQuestion 提交后输入框没有清空");
    await waitForToolCallBlockByToolName("AskUserQuestion", 60_000);
    await waitForElicitationDialog(SECOND_PROMPT);
    await waitForV4AssistantMessageContaining(SECOND_FINAL);
  });
});

function requireInjectedClockScale(): number {
  const rawScale = process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim();
  const scale = Number(rawScale);
  if (!Number.isFinite(scale) || scale < 20 || scale > 30) {
    throw new Error(
      `本候选需要 ${ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV}=20（允许 20-30），` +
        "以 test 环境的可注入 runtime clock 跨越原五分钟 deadline。",
    );
  }
  return scale;
}

async function setAutoResolutionEnabled(enabled: boolean): Promise<void> {
  await openAgentBehaviorSettings();
  if ((await readAutoResolutionSwitch()) !== enabled) {
    await clickTestIdByDom(TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH, {
      timeout: 15_000,
      timeoutMsg: "提问自动继续开关不可点击",
    });
  }
  await browser.waitUntil(
    async () => {
      const checked = await readAutoResolutionSwitch();
      const persisted = (await readSettings()).askUserQuestionAutoResolutionEnabled;
      return checked === enabled && persisted === enabled;
    },
    {
      timeout: 15_000,
      timeoutMsg: `提问自动继续设置没有持久化为 ${String(enabled)}`,
    },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
}

async function openAgentBehaviorSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (settingsPageTestId) =>
          Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有行为与工具分区入口",
  });
  await browser.waitUntil(async () => (await readAutoResolutionSwitch()) !== null, {
    timeout: 15_000,
    timeoutMsg: "行为与工具设置没有提问自动继续开关",
  });
}

function readAutoResolutionSwitch(): Promise<boolean | null> {
  return browser.execute((switchTestId) => {
    const control = document.querySelector<HTMLElement>(`[data-testid="${switchTestId}"]`);
    if (!control) return null;
    return (
      control.getAttribute("aria-checked") === "true" ||
      control.getAttribute("data-state") === "checked"
    );
  }, TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH);
}

async function waitForElicitationDialog(marker: string): Promise<void> {
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(() => {
        const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
        return body?.innerText ?? "";
      });
      return latest.includes(marker);
    },
    {
      timeout: 15_000,
      timeoutMsg: `AskUserQuestion 仍未处于等待态: marker=${marker}; latest=${latest}`,
    },
  );
}

async function submitCustomAnswer(answer: string): Promise<void> {
  const input = await $('[data-elicitation-dialog-body="true"] textarea');
  await input.waitForDisplayed({ timeout: 15_000 });
  await input.setValue(answer);
  const submitted = (await browser.execute(() => {
    const footer = document.querySelector<HTMLElement>('[data-elicitation-dialog-footer="true"]');
    const button = Array.from(footer?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => {
        const text = (candidate.textContent ?? "").trim();
        return text === "Submit" || text === "提交";
      },
    );
    button?.click();
    return Boolean(button);
  })) as boolean;
  expect(submitted).toBe(true);
}

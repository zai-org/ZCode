import { join } from "node:path";
import {
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE,
  TID_SIDE_PANE_FULL_VIEW_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_EXPAND,
  TID_SIDE_PANE_FULL_VIEW_HEADER,
  TID_SIDE_PANE_FULL_VIEW_HOST,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_RUNNING,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
  TID_SIDE_PANE_TOGGLE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_WORKSPACE_HEADER,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

// spec：docs/ui/side-pane-full-view.md；用例：docs/testing/side-pane-tabs-e2e-case-catalog.md（SPFV-007/008）
const SIDE_FRAME = '[data-workspace-side-frame="true"]';
const HOST = `[data-testid="${TID_SIDE_PANE_FULL_VIEW_HOST}"]`;
const FLOATING_INPUT = `${HOST}[data-side-pane-full-view-host="floating"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
const TAB = "[data-side-pane-tab-id]";
const ELICITATION_BODY = '[data-elicitation-dialog-body="true"]';
const RUNNING = `[data-testid="${TID_SIDE_PANE_FULL_VIEW_RUNNING}"]`;
const ANSWER_BUBBLE = `${HOST} [data-testid="${TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE}"]`;
const ANSWER_BUBBLE_OPEN = `${ANSWER_BUBBLE} > button:first-child`;
const STREAM_WORKING_LABEL = `${HOST} [data-testid^="chat-assistant-history-trigger"]`;

describe("Side Pane 完整视图浮窗（SPFV provider）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SPFV-E2E-007 浮窗发送消息，并按 session 记忆完整视图", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const runId = Date.now();

    await sendV4Prompt(`E2E_SPFV_FIRST_${runId}: reply briefly.`);
    await waitForV4AssistantMessageContaining("spfv-first-ok");
    const sessionA = (
      await waitForV4Pane(
        (snapshot) => snapshot.sessionId !== null && snapshot.sessionId !== "draft",
        "首条消息后没有绑定真实会话",
      )
    ).sessionId!;
    await ensureSidePaneExpanded();
    await ensureTerminalTab();
    await $(`${SIDE_FRAME} [data-testid="${TID_SIDE_PANE_FULL_VIEW_TOGGLE}"]`).click();
    await waitForHostMode("floating");

    const floatingPrompt = `E2E_SPFV_FLOATING_SEND_${runId}: reply briefly.`;
    await typeIntoFloatingComposer(floatingPrompt);
    await browser.keys("Enter");
    await waitForV4UserMessageContaining(`E2E_SPFV_FLOATING_SEND_${runId}`);
    await waitForV4AssistantMessageContaining("spfv-floating-ok");
    // 回答结束：浮窗上方弹出气泡，只有回答正文，没有图标与标题。
    await waitForAnswerBubble("spfv-floating-ok");
    expect(await $(`${ANSWER_BUBBLE_OPEN} svg`).isExisting()).toBe(false);
    expect((await $(ANSWER_BUBBLE_OPEN).getText()).trim()).toBe("spfv-floating-ok");
    // 默认吸附右下：气泡在浮窗上方。
    const bubbleBottom = await browser.execute(
      (selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? -1,
      ANSWER_BUBBLE,
    );
    const hostTop = await browser.execute(
      (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? -1,
      HOST,
    );
    expect(bubbleBottom).toBeLessThanOrEqual(hostTop);
    await saveThemeScreenshots("spfv-answer-bubble");

    // 完整视图隐藏左侧任务列表；切走会话走命令面板（⌘K → 新建任务），不依赖原生菜单 accelerator。
    await realKeys(["Control", "k"]);
    await $('[role="dialog"] [cmdk-input]').waitForDisplayed({ timeout: 10_000 });
    await browser.keys("New task");
    await browser.keys("Enter");
    await waitForV4Pane((snapshot) => snapshot.sessionId === "draft", "命令面板新建任务失败");
    await waitForHostMode("normal");
    expect(await $(`[data-testid="${TID_WORKSPACE_HEADER}"]`).isExisting()).toBe(true);

    await selectV4TaskById(sessionA);
    await waitForHostMode("floating");
    // 气泡只有 × 或点击才消失：切走再切回仍在；点气泡展开消息流并清除气泡。
    await waitForAnswerBubble("spfv-floating-ok");
    await $(ANSWER_BUBBLE_OPEN).click();
    await browser.waitUntil(
      async () =>
        (await $(HOST).getAttribute("data-floating")) === "expanded" &&
        !(await $(ANSWER_BUBBLE).isExisting()),
      { timeout: 5_000, timeoutMsg: "点击气泡后没有展开消息流并清除气泡" },
    );
    // 展开有高度过渡，按钮仍在移动时点击会落到消息正文上；等宿主过渡结束再点。
    await waitForHostTransitionsSettled();
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_EXPAND}"]`).click();
    await browser.waitUntil(
      async () => (await $(HOST).getAttribute("data-floating")) === "collapsed",
      {
        timeout: 5_000,
        timeoutMsg: "收起消息流失败",
      },
    );
    expect(await $(ANSWER_BUBBLE).isExisting()).toBe(false);
  });

  it("SPFV-E2E-008 最小化时出现 AskUserQuestion 会自动恢复浮窗并显示卡片", async function () {
    this.timeout(180_000);
    await waitForHostMode("floating");
    const runId = Date.now();

    await typeIntoFloatingComposer(`E2E_SPFV_ASK_${runId}: ask one question before continuing.`);
    await browser.waitUntil(
      () =>
        browser.execute(
          (hostSelector, sendTestId) =>
            document.querySelector<HTMLButtonElement>(
              `${hostSelector} [data-testid="${sendTestId}"]`,
            )?.disabled === false,
          HOST,
          TID_V4_COMPOSER_SEND,
        ),
      { timeout: 30_000, timeoutMsg: "切回会话后浮窗发送按钮没有可用" },
    );
    await browser.keys("Enter");
    await waitForV4UserMessageContaining(`E2E_SPFV_ASK_${runId}`);
    // 运行中（问答请求还没到）：焦点仍在浮窗，操作栏「⌃ / ⌄」右侧显示 loading。
    await $(RUNNING).waitForDisplayed({ timeout: 10_000 });
    // 浮窗占位保留整数时长；运行时顶部不再渲染折叠入口。
    await browser.waitUntil(
      () =>
        browser.execute(
          (inputSelector, labelSelector) => {
            const placeholder =
              document.querySelector(inputSelector)?.getAttribute("aria-placeholder") ?? "";
            return (
              /^(?:Working for [0-9]+[smhd]|工作中 [0-9]+ [秒分时天])/.test(placeholder) &&
              !Array.from(document.querySelectorAll(labelSelector)).some((element) =>
                /^(?:Working for|工作中)/.test(element.textContent?.trim() ?? ""),
              )
            );
          },
          FLOATING_INPUT,
          STREAM_WORKING_LABEL,
        ),
      { timeout: 3_000, timeoutMsg: "运行中浮窗未显示整数时长，或顶部仍存在折叠入口" },
    );
    // 回放把问答响应延迟 4s：用户消息出现后立刻最小化，请求在最小化期间到达。
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_MINIMIZE}"]`).click();
    await browser.waitUntil(
      async () =>
        (await $(HOST).getAttribute("data-floating")) === "collapsed" &&
        (await $(`${HOST} ${ELICITATION_BODY}`).isDisplayed()),
      { timeout: 60_000, timeoutMsg: "问答请求没有让最小化浮窗恢复并显示卡片" },
    );
    expect(await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_BUBBLE}"]`).isExisting()).toBe(false);

    const option = await $(`${HOST} ${ELICITATION_BODY}`).$("button=Use default");
    if (await option.isExisting()) {
      await option.click();
    }
    await submitElicitation();
    await waitForV4AssistantMessageContaining("spfv-ask-done");
    await browser.waitUntil(async () => !(await $(`${HOST} ${ELICITATION_BODY}`).isExisting()), {
      timeout: 30_000,
      timeoutMsg: "提交回答后问答卡片没有消失",
    });
    await $(FLOATING_INPUT).waitForDisplayed({ timeout: 10_000 });
    // 回答结束弹出新气泡；点 × 只清除气泡，浮窗保持收起。
    await waitForAnswerBubble("spfv-ask-done");
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE}"]`).click();
    await $(ANSWER_BUBBLE).waitForExist({ reverse: true, timeout: 5_000 });
    expect(await $(HOST).getAttribute("data-floating")).toBe("collapsed");
    // 回答完成后对话空闲：操作栏可见，但不再显示 loading。
    await $(FLOATING_INPUT).click();
    await $(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HEADER}"]`).waitForExist({ timeout: 5_000 });
    await $(RUNNING).waitForExist({ reverse: true, timeout: 30_000 });
  });
});

async function waitForHostTransitionsSettled() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) =>
          (document.querySelector(selector)?.getAnimations() ?? []).every(
            (animation) => animation.playState !== "running",
          ),
        HOST,
      ),
    { timeout: 5_000, timeoutMsg: "完整视图宿主的几何过渡没有结束" },
  );
}

async function waitForAnswerBubble(text: string) {
  await browser.waitUntil(
    async () =>
      (await $(ANSWER_BUBBLE).isDisplayed()) && (await $(ANSWER_BUBBLE).getText()).includes(text),
    { timeout: 15_000, timeoutMsg: `回答气泡没有显示「${text}」` },
  );
}

async function saveThemeScreenshots(name: string) {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  for (const theme of ["zai-light", "zai-dark"]) {
    await browser.execute((value) => {
      const actions = (
        window as typeof window & { __testActions?: { setTheme(theme: string): void } }
      ).__testActions;
      actions?.setTheme(value);
    }, theme);
    await browser.pause(300);
    await browser.saveScreenshot(join(artifactDir, `${name}-${theme}.png`));
  }
}

async function realKeys(keys: string[]) {
  const isMac = await browser.execute(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  const mapped = keys.map((key) => (key === "Control" && isMac ? "Command" : key));
  await browser.keys(mapped as never);
}

async function waitForHostMode(mode: "normal" | "conversation" | "floating") {
  await browser.waitUntil(
    async () => (await $(HOST).getAttribute("data-side-pane-full-view-host")) === mode,
    { timeout: 10_000, timeoutMsg: `完整视图宿主没有进入 ${mode}` },
  );
}

async function typeIntoFloatingComposer(text: string) {
  const input = await $(FLOATING_INPUT);
  await input.waitForDisplayed({ timeout: 10_000 });
  try {
    await input.click();
  } catch (error) {
    const geometry = await browser.execute(
      (hostSelector, inputSelector) => {
        const rect = (selector: string) => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r
            ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
            : null;
        };
        const host = document.querySelector<HTMLElement>(hostSelector);
        const inputRect = document.querySelector(inputSelector)?.getBoundingClientRect();
        const hit = inputRect
          ? document.elementFromPoint(
              inputRect.left + inputRect.width / 2,
              inputRect.top + inputRect.height / 2,
            )
          : null;
        return {
          host: rect(hostSelector),
          style: host?.getAttribute("style"),
          attrs: [host?.dataset.floating, host?.dataset.headerVisible],
          input: rect(inputSelector),
          hit: `${hit?.tagName}.${(hit?.className?.toString() ?? "").slice(0, 80)}`,
          dialogs: document.querySelectorAll('[role="dialog"]').length,
        };
      },
      HOST,
      FLOATING_INPUT,
    );
    throw new Error(`浮窗输入框不可点击: ${JSON.stringify(geometry)}`, { cause: error });
  }
  await browser.keys(text);
  await browser.waitUntil(async () => (await input.getText()).includes(text.slice(0, 20)), {
    timeout: 5_000,
    timeoutMsg: "浮窗输入框没有写入文字",
  });
}

async function submitElicitation() {
  const clicked = await browser.execute((hostSelector) => {
    const footer = document.querySelector<HTMLElement>(
      `${hostSelector} [data-elicitation-dialog-footer="true"]`,
    );
    const button = Array.from(footer?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => ["Submit", "提交"].includes((candidate.textContent ?? "").trim()),
    );
    button?.click();
    return Boolean(button);
  }, HOST);
  expect(clicked).toBe(true);
}

async function ensureSidePaneExpanded() {
  const isExpanded = () =>
    browser.execute((frameSelector) => {
      const panel = document.querySelector(frameSelector)?.parentElement;
      return Boolean(
        panel &&
        panel.getBoundingClientRect().width > 100 &&
        getComputedStyle(panel).opacity === "1",
      );
    }, SIDE_FRAME);
  if (await isExpanded()) return;
  const toggle = await $(
    `[data-testid="${TID_WORKSPACE_HEADER}"] [data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
  );
  await toggle.waitForClickable({ timeout: 10_000 });
  await toggle.click();
  await browser.waitUntil(isExpanded, { timeout: 10_000, timeoutMsg: "Side Pane 未实际展开" });
}

async function ensureTerminalTab() {
  if ((await $$(TAB).length) > 0) return;
  const launcher = await $('[data-side-pane-open-tab-item="terminal"]');
  await launcher.waitForClickable({ timeout: 10_000 });
  await launcher.click();
  await browser.waitUntil(async () => (await $$(TAB).length) === 1, {
    timeout: 10_000,
    timeoutMsg: "Terminal tab 没有打开",
  });
}

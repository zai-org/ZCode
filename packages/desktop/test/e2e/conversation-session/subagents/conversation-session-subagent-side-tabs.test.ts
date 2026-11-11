import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_PANE_SHELL,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
} from "@zcode/shared/test-ids";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { ensureReadonlyToolFixtureFile } from "#e2e/helpers/conversation-session-readonly-tool";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const PARENT_MARKER = "E2E_SUBAGENT_SIDE_TABS_PARENT";
const PARENT_DONE = "E2E_SUBAGENT_SIDE_TABS_PARENT_DONE";
const CHILD_COUNT = 6;
const BACKGROUND_PARENT_MARKER = "E2E_RUNNING_SUBAGENT_SIDE_TAB_PARENT";
const BACKGROUND_LAUNCHED = "E2E_RUNNING_SUBAGENT_SIDE_TAB_LAUNCHED";
const BACKGROUND_PARENT_DONE = "E2E_RUNNING_SUBAGENT_SIDE_TAB_PARENT_DONE";

describe("子智能体右侧 tabs manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT12: Running subagent 摘要行复用 child 右侧 tab", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    await ensureReadonlyToolFixtureFile();
    const prompt = [
      `${BACKGROUND_PARENT_MARKER}: launch exactly one Agent with run_in_background true.`,
      `The child must read the readonly fixture and reply with exactly E2E_SIDE_TAB_BACKGROUND_CHILD_DONE.`,
      `After the background launch tool returns, reply with exactly ${BACKGROUND_LAUNCHED} without waiting.`,
      `After its task notification arrives, reply with exactly ${BACKGROUND_PARENT_DONE}.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "Running subagent side-tab 首发后输入框没有清空");
    await waitForV4AssistantMessageContaining(`${BACKGROUND_LAUNCHED}`);
    await waitForRunningSubagentTrigger(90000);

    await clickRunningSubagentTrigger();
    await waitForVisibleSubagentTabCount(1, 30000);
    await clickRunningSubagentTrigger();
    expect(await countVisibleSubagentTabs()).toBe(1);

    // 先观察运行中 tab 的去重，再释放上游流，避免依赖固定 sleep 的抢时序。
    await releaseControlledReplay("side-tab-child-background");
    await waitForV4AssistantMessageContaining(BACKGROUND_PARENT_DONE);
  });

  it("SAT01-SAT03: 6 个 running child 使用右侧 tabs 且打开后持续更新", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    await ensureReadonlyToolFixtureFile();
    const prompt = [
      `${PARENT_MARKER}: In one assistant turn launch exactly ${CHILD_COUNT} foreground Agent tool calls in parallel.`,
      `Use subagent_type "general-purpose" for every child.`,
      `Give child N this exact instruction: E2E_SIDE_TAB_CHILD_N: read the readonly fixture, then reply with E2E_SIDE_TAB_CHILD_N_DONE.`,
      `Do not finish the parent response until every child completes; then reply with exactly ${PARENT_DONE}.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "subagent side tabs 首发后输入框没有清空");
    await waitForSubagentSummaryActions(CHILD_COUNT, 90000);
    await expectSubagentSummariesToOpenSidePaneDirectly();

    await openAllSubagentTabs();
    // 流式增量更新同一 row；隐藏 tab 的虚拟列表也可能卸载正文，不能要求所有 DOM 同时可见。
    // 先验证保活 pane 的投影，再逐个激活读取正文，覆盖 SAT03 的“切回直接显示最新内容”。
    await browser.waitUntil(
      async () => {
        const children = await readChildTimelineStates();
        return children.length === CHILD_COUNT && children.every((child) => child.seq > 0);
      },
      { timeout: 30000, timeoutMsg: "六个 child tabs 没有保留初始投影" },
    );
    const initialChildren: Awaited<ReturnType<typeof readChildTimelineStates>> = [];
    for (const child of await readChildTimelineStates()) {
      initialChildren.push(
        await readVisibleChildTimelineState(child, /^E2E_SIDE_TAB_CHILD_\d+_$/u),
      );
    }
    expect(new Set(initialChildren.map((child) => child.sessionId)).size).toBe(CHILD_COUNT);
    expect(
      initialChildren
        .map((child) => child.assistantText.match(/E2E_SIDE_TAB_CHILD_\d+_/u)?.[0])
        .sort(),
    ).toEqual(
      Array.from({ length: CHILD_COUNT }, (_, index) => `E2E_SIDE_TAB_CHILD_${index + 1}_`).sort(),
    );
    await waitForVisibleSubagentTabCount(CHILD_COUNT, 30000);
    expect(await countWorkbenchPanes()).toBe(1);

    await clickFirstSubagentSummaryAction();
    expect(await countVisibleSubagentTabs()).toBe(CHILD_COUNT);

    for (let index = 1; index <= CHILD_COUNT; index++) {
      await releaseControlledReplay(`side-tab-child-${index}`);
    }
    await browser.waitUntil(
      async () => {
        const current = await readChildTimelineStates();
        return (
          current.length === CHILD_COUNT &&
          current.every((child) => {
            const initial = initialChildren.find((item) => item.sessionId === child.sessionId);
            return Boolean(initial && child.seq > initial.seq);
          })
        );
      },
      {
        timeout: 120000,
        timeoutMsg: "已打开的 child tabs 没有持续更新 projection sequence",
      },
    );
    for (const initial of initialChildren) {
      const current = await readVisibleChildTimelineState(
        initial,
        new RegExp(`^${initial.assistantText}DONE$`, "u"),
      );
      expect(current.seq).toBeGreaterThan(initial.seq);
    }
    expect((await readChildTimelineStates()).map((child) => child.sessionId).sort()).toEqual(
      initialChildren.map((child) => child.sessionId).sort(),
    );

    await waitForV4AssistantMessageContaining(`${PARENT_DONE}`);
  });
});

async function waitForSubagentSummaryActions(expected: number, timeout: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (prefix, count) => document.querySelectorAll(`[data-testid^="${prefix}-"]`).length >= count,
        TID_V4_SUBAGENT_OPEN_SIDE_PANE,
        expected,
      ),
    {
      timeout,
      timeoutMsg: `没有等到 ${expected} 个 subagent 摘要直开入口`,
    },
  );
}

async function waitForRunningSubagentTrigger(timeout: number): Promise<void> {
  // 修复原因：面板 test id 来自 shared 常量；旧代码误传了只存在于浏览器回调
  // 形参里的同名变量，导致 E2E TypeScript 编译阶段直接失败。
  await browser.waitUntil(
    async () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        if (panel?.dataset.state === "collapsed") {
          panel.querySelector<HTMLButtonElement>("button")?.click();
        }
        const runningSection = panel?.querySelector<HTMLButtonElement>(
          '[data-status-section-trigger="agent"]',
        );
        if (runningSection?.getAttribute("aria-expanded") === "false") {
          runningSection.click();
        }
        return Boolean(panel?.querySelector('[data-running-subagent-session-trigger="true"]'));
      }, TID_CHAT_SUMMARY_PANEL),
    {
      timeout,
      timeoutMsg: "右上角智能体区块没有出现可打开的 subagent session 行",
    },
  );
}

async function clickRunningSubagentTrigger(): Promise<void> {
  await browser.execute(() => {
    document
      .querySelector<HTMLButtonElement>('[data-running-subagent-session-trigger="true"]')
      ?.click();
  });
}

async function expectSubagentSummariesToOpenSidePaneDirectly(): Promise<void> {
  const summaries = await browser.execute(
    (prefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map(
        (summary) => ({
          ariaExpanded: summary.getAttribute("aria-expanded"),
          hasChevron: Boolean(summary.querySelector(".lucide-chevron-right")),
          hasInlineDetails: Boolean(
            summary.parentElement?.querySelector('[data-slot="collapsible-content"]'),
          ),
        }),
      ),
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  );

  expect(summaries).toHaveLength(CHILD_COUNT);
  expect(summaries.every((summary) => summary.ariaExpanded === null)).toBe(true);
  expect(summaries.every((summary) => !summary.hasChevron)).toBe(true);
  expect(summaries.every((summary) => !summary.hasInlineDetails)).toBe(true);
}

async function openAllSubagentTabs(): Promise<void> {
  await browser.execute(
    (prefix, expected) => {
      const summaries = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`),
      ).slice(0, expected);
      for (const summary of summaries) summary.click();
    },
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    CHILD_COUNT,
  );
  await waitForVisibleSubagentTabCount(CHILD_COUNT, 30000);
}

async function clickFirstSubagentSummaryAction(): Promise<void> {
  await browser.execute((prefix) => {
    document.querySelector<HTMLElement>(`[data-testid^="${prefix}-"]`)?.click();
  }, TID_V4_SUBAGENT_OPEN_SIDE_PANE);
}

async function waitForVisibleSubagentTabCount(expected: number, timeout: number): Promise<void> {
  await browser.waitUntil(async () => (await countVisibleSubagentTabs()) === expected, {
    timeout,
    timeoutMsg: `右侧没有出现 ${expected} 个 subagent tabs`,
  });
}

async function countVisibleSubagentTabs(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-side-pane-tab-id^="subagent-session:"]').length,
  );
}

async function countWorkbenchPanes(): Promise<number> {
  return browser.execute(
    (testId) => document.querySelectorAll(`[data-testid^="${testId}"]`).length,
    TID_V4_PANE_SHELL,
  );
}

async function readChildTimelineStates() {
  return browser.execute(() => {
    // 切换任务后旧 pane 仍可能保活；只统计当前 tabs 对应的 child，不能混入前一个 case。
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="subagent-session:"]'),
    );
    return tabs.map((tab) => {
      const pane = document.querySelector<HTMLElement>(
        `[data-testid=${JSON.stringify(`v4-session-pane-${tab.dataset.sidePaneTabId}`)}]`,
      );
      const timeline = pane?.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
      return {
        tabId: tab.dataset.sidePaneTabId ?? null,
        sessionId: pane?.dataset.sessionId ?? null,
        seq: Number(pane?.dataset.projectionSeq ?? 0),
        // 不读 user prompt，避免指令中已有 DONE marker 导致完成态假阳性。
        assistantText: Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
          .filter((row) => row.classList.contains("group/assistant-row"))
          .map((row) => row.textContent ?? "")
          .join("\n"),
      };
    });
  });
}

async function readVisibleChildTimelineState(
  child: Awaited<ReturnType<typeof readChildTimelineStates>>[number],
  expectedText: RegExp,
) {
  const { sessionId, tabId } = child;
  if (!sessionId || !tabId) throw new Error("child tab 没有 session identity");
  await browser.execute((id) => {
    // tab ID 还包含 root/Host 作用域，必须读取真实 DOM 身份，不能只用 child ID 拼接。
    const tab = document.querySelector<HTMLElement>(
      `[data-side-pane-tab-id=${JSON.stringify(id)}]`,
    );
    if (!tab) throw new Error(`child tab 已丢失: ${id}`);
    tab.click();
  }, tabId);
  let state: Awaited<ReturnType<typeof readChildTimelineStates>>[number] | undefined;
  await browser.waitUntil(
    async () => {
      state = (await readChildTimelineStates()).find((child) => child.sessionId === sessionId);
      return Boolean(state && expectedText.test(state.assistantText));
    },
    { timeout: 30000, timeoutMsg: `切回 ${sessionId} 后没有显示预期的 assistant 正文` },
  );
  if (!state) throw new Error(`child pane 已丢失: ${sessionId}`);
  return state;
}

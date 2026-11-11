import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
} from "@zcode/shared/test-ids";

export interface RunningSubagentControl {
  childSessionId: string;
  taskId: string;
  executionId: string;
  title: string;
  stopVisible: boolean;
  stopDisabled: boolean;
}

export function readRunningSubagentControls(): Promise<RunningSubagentControl[]> {
  return browser.execute(
    (panelTestId, paneTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      return Array.from(
        panel?.querySelectorAll<HTMLElement>('li[data-background-task-kind="agent"]') ?? [],
      ).map((row) => {
        const stop = row.querySelector<HTMLButtonElement>(
          '[data-testid="v4-running-subagent-stop"]',
        );
        return {
          childSessionId: row.dataset.childSessionId ?? "",
          taskId: row.dataset.subagentTaskId ?? "",
          executionId: row.dataset.subagentExecutionId ?? "",
          title: row.innerText,
          stopVisible: Boolean(stop?.checkVisibility()),
          stopDisabled: Boolean(stop?.disabled),
        };
      });
    },
    TID_CHAT_SUMMARY_PANEL,
    "v4-session-pane-workspace-main",
  );
}

export async function openRunningSubagentCapsule(timeout = 30000): Promise<void> {
  let latest: unknown;
  try {
    await browser.waitUntil(
      async () => {
        latest = await browser.execute(
          (panelTestId, paneTestId, composerTriggerTestId) => {
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
            const composerTrigger = pane?.querySelector<HTMLButtonElement>(
              `[data-testid="${composerTriggerTestId}"]`,
            );
            const runningAgentCount = Number(panel?.dataset.runningAgentCount ?? "0");
            if (!panel || runningAgentCount < 1) {
              return {
                expanded: false,
                panelState: panel?.dataset.state ?? null,
                runningAgentCount,
                runningSubagentIds: pane?.dataset.runningSubagentIds ?? null,
                runningSubagentWorkIds: pane?.dataset.runningSubagentWorkIds ?? null,
                visibleRows:
                  panel?.querySelectorAll('li[data-background-task-kind="agent"]').length ?? 0,
              };
            }
            if (panel.dataset.state === "collapsed" || panel.dataset.displayMode === "auto") {
              composerTrigger?.click();
              return { expanded: false, panelState: panel.dataset.state, runningAgentCount };
            }
            const trigger = panel.querySelector<HTMLButtonElement>(
              '[data-status-section-trigger="agent"]',
            );
            const content = trigger
              ?.closest("[data-status-section=agent]")
              ?.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
            const sectionContentState = content?.dataset.state ?? null;
            const sectionContentHeight = content?.getBoundingClientRect().height ?? 0;
            if (trigger?.getAttribute("aria-expanded") !== "true") {
              trigger?.click();
              return {
                expanded: false,
                panelState: panel.dataset.state,
                runningAgentCount,
                triggerExpanded: trigger?.getAttribute("aria-expanded") ?? null,
                sectionContentState,
                sectionContentHeight,
              };
            }
            const stopButtons = Array.from(
              panel.querySelectorAll<HTMLButtonElement>('[data-testid="v4-running-subagent-stop"]'),
            );
            const stopRect = stopButtons[0]?.getBoundingClientRect();
            return {
              expanded: Boolean(
                panel.querySelector<HTMLElement>('li[data-background-task-kind="agent"]') &&
                sectionContentState === "open" &&
                sectionContentHeight > 0 &&
                (stopRect?.height ?? 0) > 0,
              ),
              panelState: panel.dataset.state,
              runningAgentCount,
              runningSubagentIds: pane?.dataset.runningSubagentIds ?? null,
              runningSubagentWorkIds: pane?.dataset.runningSubagentWorkIds ?? null,
              sectionContentState,
              sectionContentHeight,
              triggerExpanded: trigger?.getAttribute("aria-expanded") ?? null,
              visibleRows: panel.querySelectorAll('li[data-background-task-kind="agent"]').length,
              stopStates: stopButtons.map((button) => {
                const rect = button.getBoundingClientRect();
                return {
                  disabled: button.disabled,
                  executionId: button.dataset.subagentExecutionId,
                  height: rect.height,
                  taskId: button.dataset.subagentTaskId,
                };
              }),
            };
          },
          TID_CHAT_SUMMARY_PANEL,
          "v4-session-pane-workspace-main",
          TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
        );
        return Boolean(
          latest && typeof latest === "object" && "expanded" in latest && latest.expanded === true,
        );
      },
      { timeout, timeoutMsg: "没有展开含 running subagent 的状态胶囊" },
    );
  } catch (error) {
    latest = await browser
      .execute(
        (panelTestId, paneTestId, _composerTriggerTestId) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
          const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          return {
            panelState: panel?.dataset.state ?? null,
            runningAgentCount: panel?.dataset.runningAgentCount ?? null,
            runningSubagentIds: pane?.dataset.runningSubagentIds ?? null,
            runningSubagentWorkIds: pane?.dataset.runningSubagentWorkIds ?? null,
            agentSectionTriggerExpanded:
              panel
                ?.querySelector<HTMLButtonElement>('[data-status-section-trigger="agent"]')
                ?.getAttribute("aria-expanded") ?? null,
            agentSectionContentState:
              panel?.querySelector<HTMLElement>(
                '[data-status-section="agent"] [data-slot="collapsible-content"]',
              )?.dataset.state ?? null,
            agentSectionContentHeight:
              panel
                ?.querySelector<HTMLElement>(
                  '[data-status-section="agent"] [data-slot="collapsible-content"]',
                )
                ?.getBoundingClientRect().height ?? 0,
            visibleRows:
              panel?.querySelectorAll('li[data-background-task-kind="agent"]').length ?? 0,
          };
        },
        TID_CHAT_SUMMARY_PANEL,
        "v4-session-pane-workspace-main",
      )
      .catch(() => null);
    throw new Error(`没有展开含 running subagent 的状态胶囊; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

export async function clickRunningSubagentStop(control: RunningSubagentControl): Promise<{
  type: string;
  status: string;
  reasonCode?: string;
}> {
  if (!control.childSessionId || !control.taskId || !control.executionId) {
    throw new Error(`Stop 缺少当前执行身份: ${JSON.stringify(control)}`);
  }
  const selector =
    `li[data-child-session-id="${control.childSessionId}"]` +
    `[data-subagent-task-id="${control.taskId}"]` +
    `[data-subagent-execution-id="${control.executionId}"]` +
    ' [data-testid="v4-running-subagent-stop"]';
  const button = $(selector);
  const scrollState = await browser.execute((targetSelector) => {
    const button = document.querySelector<HTMLButtonElement>(targetSelector);
    if (!button) return { found: false };
    const row = button.closest<HTMLElement>("li[data-background-task-kind=agent]");
    const sectionScroller = button.closest<HTMLElement>("[data-status-section-scroll=agent]");
    button.scrollIntoView({ block: "center", inline: "nearest" });
    sectionScroller?.scrollIntoView({ block: "nearest", inline: "nearest" });
    row?.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      found: true,
      buttonRect: { bottom: rect.bottom, height: rect.height, top: rect.top },
      centerHitTestId: hit?.closest<HTMLElement>("[data-testid]")?.dataset.testid ?? null,
      disabled: button.disabled,
      sectionScrollTop: sectionScroller?.scrollTop ?? null,
      viewportHeight: window.innerHeight,
    };
  }, selector);
  try {
    await button.waitForClickable({ timeout: 30000 });
  } catch (error) {
    throw new Error(`Stop 按钮无法点击: ${JSON.stringify(scrollState)}`, { cause: error });
  }
  expect(await button.getAttribute("data-subagent-task-id")).toBe(control.taskId);
  expect(await button.getAttribute("data-subagent-execution-id")).toBe(control.executionId);
  // 旧等待器只按类型找历史 ACK，会把上一项停止成功误算成本次成功。
  const start = await browser.execute(() => {
    const host = window as Window & { __zcodeV4CommandAcksE2E?: unknown[] };
    return host.__zcodeV4CommandAcksE2E?.length ?? 0;
  });
  await button.click();
  let ack: { type: string; status: string; reasonCode?: string } | null = null;
  await browser.waitUntil(
    async () => {
      ack = await browser.execute((after) => {
        const entries =
          (
            window as Window & {
              __zcodeV4CommandAcksE2E?: Array<{
                type: string;
                status: string;
                reasonCode?: string;
              }>;
            }
          ).__zcodeV4CommandAcksE2E ?? [];
        return entries.slice(after).find((entry) => entry.type === "stopSubagent") ?? null;
      }, start);
      return ack !== null;
    },
    { timeout: 30000, timeoutMsg: "本次 capsule Stop 没有返回 stopSubagent ACK" },
  );
  return ack!;
}

export function countVisibleSubagentTabs(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-side-pane-tab-id^="subagent-session:"]').length,
  );
}

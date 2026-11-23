import { openStatusCapsule } from "#e2e/helpers/status-capsule";

export interface RunningSubagentControl {
  childSessionId: string;
  taskId: string;
  executionId: string;
  title: string;
  stopVisible: boolean;
  stopDisabled: boolean;
}

export function readRunningSubagentControls(): Promise<RunningSubagentControl[]> {
  return browser.execute(() => {
    const panel = document.querySelector<HTMLElement>('[data-status-capsule-content="activity"]');
    return Array.from(
      panel?.querySelectorAll<HTMLElement>('li[data-background-task-kind="agent"]') ?? [],
    ).map((row) => {
      const stop = row.querySelector<HTMLButtonElement>('[data-testid="v4-running-subagent-stop"]');
      return {
        childSessionId: row.dataset.childSessionId ?? "",
        taskId: row.dataset.subagentTaskId ?? "",
        executionId: row.dataset.subagentExecutionId ?? "",
        title: row.innerText,
        stopVisible: Boolean(stop?.checkVisibility()),
        stopDisabled: Boolean(stop?.disabled),
      };
    });
  });
}

export async function openRunningSubagentCapsule(timeout = 30000): Promise<void> {
  await openStatusCapsule("activity", timeout);
  await browser.waitUntil(
    async () => (await readRunningSubagentControls()).some((row) => row.stopVisible),
    {
      timeout,
      timeoutMsg: "Activity 浮层没有可见的 running subagent Stop 控件",
    },
  );
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
    button.scrollIntoView({ block: "center", inline: "nearest" });
    row?.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      found: true,
      buttonRect: { bottom: rect.bottom, height: rect.height, top: rect.top },
      centerHitTestId: hit?.closest<HTMLElement>("[data-testid]")?.dataset.testid ?? null,
      disabled: button.disabled,
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

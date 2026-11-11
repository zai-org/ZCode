import {
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_WORKSPACE_MORE_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 180_000;
const PROMPT_MARKER = "E2E_RUNNING_TASK_ARCHIVE_BLOCKED";
const BLOCKED_HINTS = ["任务运行中，请先停止后再归档", "Stop the task before archiving it"];
const ARCHIVE_LABELS = ["归档任务", "Archive task"];

describe("运行中的任务禁止归档", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("运行中侧栏归档入口禁用并提示，Header 菜单不提供归档，停止后恢复", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`E2E_HOLD_STREAM ${PROMPT_MARKER}: keep running until stopped.`);
    const running = await waitForV4Pane(
      (snapshot) =>
        snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "任务没有进入运行中",
      60_000,
    );
    const taskId = running.sessionId!;

    await waitForArchiveButtonDisabled(taskId, true, "运行中任务的归档按钮没有禁用");
    expect(BLOCKED_HINTS).toContain(await readArchiveTooltip(taskId));

    const row = $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
    await row.click({ button: "right" });
    const contextArchive = await waitForMenuItem(ARCHIVE_LABELS, "右键菜单没有归档项");
    expect(await contextArchive.getAttribute("data-disabled")).not.toBeNull();
    expect(BLOCKED_HINTS).toContain(await contextArchive.getAttribute("title"));
    await browser.keys("Escape");

    await $(`[data-testid="${TID_WORKSPACE_MORE_BUTTON}"]`).click();
    await waitForMenuItem(["重命名任务", "Rename task"], "Header 更多菜单没有打开");
    expect(await readMenuItemLabels()).not.toEqual(expect.arrayContaining([ARCHIVE_LABELS[0]]));
    expect(await readMenuItemLabels()).not.toEqual(expect.arrayContaining([ARCHIVE_LABELS[1]]));
    await browser.keys("Escape");

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskId && !snapshot.canStop,
      "停止后任务仍在运行",
      30_000,
    );
    await waitForArchiveButtonDisabled(taskId, false, "停止后归档按钮仍然禁用");
  });
});

async function readArchiveButtonDisabled(taskId: string): Promise<boolean | null> {
  const row = $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  await row.moveTo();
  return browser.execute(
    (id) => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      return button ? button.disabled : null;
    },
    testId(TID_TASK_ARCHIVE, taskId),
  );
}

async function waitForArchiveButtonDisabled(
  taskId: string,
  expected: boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(async () => (await readArchiveButtonDisabled(taskId)) === expected, {
    timeout: 30_000,
    timeoutMsg,
  });
}

async function readArchiveTooltip(taskId: string): Promise<string> {
  const trigger = $(`[data-testid="${testId(TID_TASK_ARCHIVE, taskId)}"]`).parentElement();
  await trigger.moveTo();
  const tooltip = $('[data-slot="tooltip-content"]');
  await tooltip.waitForDisplayed({ timeout: 10_000, timeoutMsg: "归档按钮没有显示提示" });
  return (await tooltip.getText()).trim();
}

async function readMenuItemLabels(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) =>
      (item.textContent ?? "").trim(),
    ),
  );
}

async function waitForMenuItem(labels: string[], timeoutMsg: string) {
  const selector = `//*[@role="menuitem" and (${labels
    .map((label) => `normalize-space(.)="${label}"`)
    .join(" or ")})]`;
  const item = $(selector);
  await item.waitForDisplayed({ timeout: 15_000, timeoutMsg });
  return item;
}

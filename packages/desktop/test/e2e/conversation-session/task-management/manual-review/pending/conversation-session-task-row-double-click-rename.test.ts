// TSL42：双击任务行打开同一个重命名弹窗；覆盖按项目与按分组两套行组件。
import { TID_TASK_ITEM } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  getV4SessionTitle,
  prepareV4ConversationE2E,
  renameV4SessionByDoubleClick,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const SEED_MARKER = "E2E_TSL42_DBLCLICK_SEED";

async function sidebarTaskItemText(sessionId: string): Promise<string | null> {
  return browser.execute(
    (itemTestId, id) => {
      const el = document.querySelector(`[data-testid="${itemTestId}-${id}"]`);
      return el ? (el.textContent ?? "") : null;
    },
    TID_TASK_ITEM,
    sessionId,
  );
}

async function switchSidebarView(view: "projects" | "grouped") {
  await $('[data-testid="sidebar-view-menu"]').click();
  const item = $(`[data-testid="sidebar-view-${view}"]`);
  await item.waitForDisplayed({ timeout: 15_000 });
  await item.click();
  await item.waitForExist({ reverse: true, timeout: 15_000 });
}

async function waitForSidebarTitle(sessionId: string, title: string) {
  await browser.waitUntil(
    async () => {
      const text = await sidebarTaskItemText(sessionId);
      return text !== null && text.includes(title);
    },
    { timeout: 30_000, timeoutMsg: `侧栏任务行没有更新为 ${title}` },
  );
}

describe("TSL42：双击任务行重命名", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("单击只打开会话；按项目行与按分组行双击都能打开弹窗并改名", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${SEED_MARKER} 建立会话`);
    await waitForV4TimelineContaining("TSL42_DBLCLICK_SEED_OK", 45_000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45_000,
    );
    const sessionId = (await getV4PaneSnapshot()).sessionId as string;
    const rowSelector = `[data-testid="${TID_TASK_ITEM}-${sessionId}"]`;

    // 单击仍只打开会话，不出现重命名弹窗。
    const row = $(rowSelector);
    await row.waitForDisplayed({ timeout: 15_000 });
    await row.click();
    await browser.pause(300);
    expect(await $('[role="dialog"]').isExisting()).toBe(false);

    // 按项目行：双击打开同一个弹窗，改名后 header 与侧栏行同步。
    const projectTitle = "TSL42_PROJECT_RENAMED";
    await renameV4SessionByDoubleClick(projectTitle, { view: "projects" });
    await browser.waitUntil(async () => (await getV4SessionTitle()) === projectTitle, {
      timeout: 30_000,
      timeoutMsg: "header 标题没有更新为按项目视图的自定义值",
    });
    await waitForSidebarTitle(sessionId, projectTitle);

    // 按分组行：切换到分组视图，双击分组行继续改名。
    await switchSidebarView("grouped");
    await $('[data-testid="task-grouped-view"]').waitForDisplayed({ timeout: 15_000 });
    const groupedTitle = "TSL42_GROUPED_RENAMED";
    await renameV4SessionByDoubleClick(groupedTitle, { view: "grouped" });
    await browser.waitUntil(async () => (await getV4SessionTitle()) === groupedTitle, {
      timeout: 30_000,
      timeoutMsg: "header 标题没有更新为按分组视图的自定义值",
    });
    await waitForSidebarTitle(sessionId, groupedTitle);
  });
});

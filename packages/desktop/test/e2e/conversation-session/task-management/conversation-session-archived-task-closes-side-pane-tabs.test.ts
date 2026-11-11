import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { ensureProjectExpanded } from "#e2e/helpers/project-sidebar";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 180_000;
const PROMPT_MARKER = "E2E_ARCHIVED_TASK_BROWSER_TABS";
const REPLY_MARKER = "ARCHIVED_TASK_BROWSER_TABS_OK";

let fixtureServer: Server | null = null;
let fixtureUrl = "";

describe("归档任务关闭其全部 tab", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureUrl = `${await listen(fixtureServer)}/archived-task-tab`;
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("归档关闭该任务的全部 tab，取消归档后不恢复", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PROMPT_MARKER}: Reply with exactly "${REPLY_MARKER}" and no other text.`);
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 60_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "前置任务没有完成",
      60_000,
    );
    const taskId = requireTaskId(completed.sessionId);

    await openFirstBrowserTab();
    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await addressInput.waitForDisplayed({ timeout: 15_000 });
    await addressInput.setValue(fixtureUrl);
    await addressInput.click();
    await browser.keys("Enter");
    await waitForFixtureGuest(true, "任务内 Browser tab 没有创建 guest");
    await openLauncherItem("terminal");
    const taskTabIds = await readSidePaneTabIds();
    expect(taskTabIds.some((id) => id.startsWith("browser:"))).toBe(true);
    expect(taskTabIds.length).toBeGreaterThanOrEqual(2);

    await archiveProjectTask(taskId);
    await waitForProjectRow(taskId, false, "归档后任务仍停留在 Project");
    await waitForFixtureGuest(false, "归档任务后它的 Browser guest 仍然存活");

    await openArchivedView();
    await $(
      `[data-testid="archive-task"][data-task-id="${taskId}"] [data-testid="archive-unarchive"]`,
    ).click();
    await waitForArchivedRow(taskId, false, "取消归档后 Archived 仍显示任务");
    await $('[data-testid="settings-back-button"]').click();
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    await waitForProjectRow(taskId, true, "取消归档后任务没有回到 Project");
    await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`).click();
    await waitForV4Pane((snapshot) => snapshot.sessionId === taskId, "没有重新打开取消归档的任务");
    await browser.pause(1_000);
    const restoredTabIds = await readSidePaneTabIds();
    expect(restoredTabIds.filter((id) => taskTabIds.includes(id))).toEqual([]);
    expect(await readFixtureGuestCount()).toBe(0);
  });
});

function requireTaskId(value: string | null): string {
  if (!value || value === "draft") throw new Error(`缺少 taskId: ${String(value)}`);
  return value;
}

async function readFixtureGuestCount(): Promise<number> {
  const urls = (await browser.electron.execute((electron) =>
    electron.webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.getType() === "webview")
      .map((contents) => contents.getURL()),
  )) as unknown as string[];
  return urls.filter((url) => url === fixtureUrl).length;
}

async function waitForFixtureGuest(expected: boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await readFixtureGuestCount()) > 0 === expected, {
    timeout: 30_000,
    timeoutMsg,
  });
}

async function archiveProjectTask(taskId: string): Promise<void> {
  const row = await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  await row.moveTo();
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 15_000,
    timeoutMsg: "归档按钮没有出现",
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => {
          const button = document.querySelector(`[data-testid="${id}"]`);
          return Boolean(button?.closest("[data-archive-confirming-task-id]"));
        },
        testId(TID_TASK_ARCHIVE, taskId),
      ),
    { timeout: 10_000, timeoutMsg: "归档没有进入确认态" },
  );
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 10_000,
    timeoutMsg: "归档确认按钮没有出现",
  });
}

async function openArchivedView(): Promise<void> {
  await $('[data-testid="task-settings-button"]').click();
  await $('[data-testid="settings-section-nav-archives"]').click();
  await $('[data-testid="archive-management"]').waitForDisplayed();
  for (const toggle of await $$('[data-testid="archive-group-toggle"]')) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
}

async function readSidePaneTabIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")).map(
      (element) => element.dataset.sidePaneTabId ?? "",
    ),
  );
}

async function openLauncherItem(itemId: string): Promise<void> {
  const before = (await readSidePaneTabIds()).length;
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const trigger = document.querySelector<HTMLElement>("[data-side-pane-add-trigger]");
        if (!trigger) return false;
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        trigger.click();
        return true;
      }),
    { timeout: 10_000, timeoutMsg: "没有找到新建 tab 入口" },
  );
  await browser.waitUntil(
    () =>
      browser.execute((id) => {
        const item = document.querySelector<HTMLElement>(
          `[data-state="active"] [data-side-pane-open-tab-item="${id}"]`,
        );
        if (!item) return false;
        item.click();
        return true;
      }, itemId),
    { timeout: 10_000, timeoutMsg: `新建 tab 菜单里没有 ${itemId}` },
  );
  await browser.waitUntil(async () => (await readSidePaneTabIds()).length > before, {
    timeout: 15_000,
    timeoutMsg: `${itemId} tab 没有打开`,
  });
}

async function waitForProjectRow(taskId: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskItemTestId, shouldExist) =>
          Boolean(document.querySelector(`[data-testid="${taskItemTestId}"]`)) === shouldExist,
        testId(TID_TASK_ITEM, taskId),
        expected,
      ),
    { timeout: 30_000, timeoutMsg },
  );
}

async function waitForArchivedRow(taskId: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="archive-task"][data-task-id="${taskId}"]`).isExisting()) === expected,
    { timeout: 30_000, timeoutMsg },
  );
}

function createFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><html><head><title>Archived task tab</title></head><body>ready</body></html>",
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

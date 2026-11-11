import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import {
  TID_LOGIN_TRIGGER,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_SIDE_PANE_TOGGLE,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4ConversationState,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";
import {
  clickCloseButton,
  openFirstBrowserTab,
  readBrowserTabIds,
} from "#e2e/helpers/browser-side-pane";
import { buildTerminalProbeCommand } from "#e2e/helpers/web-remote-terminal-probe";

type CloseHandler = (...args: unknown[]) => Promise<unknown>;
declare global {
  var __sidePaneLateClose:
    | { held: boolean; completed: boolean; release(): void; restore(): void }
    | undefined;
}

async function remountThroughLogin(taskId: string): Promise<void> {
  await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
  await $(`[data-testid="${TID_LOGIN_MENU_ITEM}"]`).waitForClickable();
  await $(`[data-testid="${TID_LOGIN_MENU_ITEM}"]`).click();
  await $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`).waitForDisplayed();
  await $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`).click();
  await $(`[data-testid="${TID_LOGIN_API_KEY_SKIP_BUTTON}"]`).click();
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
  // 登录返回可能恢复另一草稿；显式回到原任务，避免将 scope 隐藏误判为标签丢失。
  await selectV4TaskById(taskId);
}

async function terminalText(): Promise<string> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-side-pane-content-slot] .xterm-rows")]
      .filter((row) => row.checkVisibility())
      .map((row) => row.textContent ?? "")
      .join("\n"),
  );
}

async function runTerminalProbe(label: string): Promise<string> {
  await browser.execute(() => {
    const input = [
      ...document.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea"),
    ].find(
      (area) =>
        area.closest("[data-side-pane-content-slot]") && area.closest(".xterm")?.checkVisibility(),
    );
    if (!input) throw new Error("Side pane terminal input missing");
    input.focus();
  });
  await browser.keys(buildTerminalProbeCommand(label, "local").split(""));
  await browser.waitUntil(async () => (await terminalText()).includes(`MRO04_${label}`));
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await terminalText()).includes(`E2E_MRO04_${label}`), {
    timeout: 15_000,
  });
  return terminalText();
}

describe("侧栏迟到关闭与 App 重挂", () => {
  after(async () => {
    await browser.electron.execute(() => globalThis.__sidePaneLateClose?.restore());
    await clearAppData();
  });

  it("旧浏览器关闭完成后，重挂新增终端的标签、历史和 PID 仍保留", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_SIDE_PANE_LATE_CLOSE_SESSION: 只回复固定回放内容。");
    await waitForV4AssistantMessageContaining("E2E_SIDE_PANE_LATE_CLOSE_READY", 60_000);
    const taskId = (await getV4ConversationState()).taskId;
    if (!taskId) throw new Error("Persisted task missing");
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await openFirstBrowserTab();
    const [browserTab] = await readBrowserTabIds();
    if (!browserTab) throw new Error("Browser tab missing");
    // 只延迟真实关闭 IPC 的执行；主进程持久删除、UI 关闭和重挂均走原路径。
    await browser.electron.execute((electron, channel) => {
      const handlers = (
        electron.ipcMain as unknown as { _invokeHandlers: Map<string, CloseHandler> }
      )._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error("Browser close handler missing");
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const probe = {
        held: false,
        completed: false,
        release,
        restore() {
          release();
          handlers.set(channel, original);
          delete globalThis.__sidePaneLateClose;
        },
      };
      handlers.set(channel, async (...args) => {
        probe.held = true;
        await barrier;
        const result = await original(...args);
        probe.completed = true;
        return result;
      });
      globalThis.__sidePaneLateClose = probe;
    }, PlatformChannels.BrowserViewCloseTabFromRenderer);
    await clickCloseButton(browserTab);
    await browser.waitUntil(() =>
      browser.electron.execute(() => Boolean(globalThis.__sidePaneLateClose?.held)),
    );
    await remountThroughLogin(taskId);
    await $("[data-side-pane-add-tab-trigger]").waitForClickable();
    await $("[data-side-pane-add-tab-trigger]").click();
    await $('[data-side-pane-open-tab-item="terminal"]').waitForClickable();
    await $('[data-side-pane-open-tab-item="terminal"]').click();
    await browser.waitUntil(async () => /[$#>%]\s*$/u.test(await terminalText()), {
      timeout: 30_000,
    });
    const terminalId = await $('[data-side-pane-tab-id^="terminal:"]').getAttribute(
      "data-side-pane-tab-id",
    );
    const before = await runTerminalProbe("LATE_CLOSE_BEFORE");
    const pid = before.match(/PTY_OWNER=(\d+)/u)?.[1];
    expect(pid).toBeTruthy();
    await browser.electron.execute(() => globalThis.__sidePaneLateClose?.release());
    await browser.waitUntil(() =>
      browser.electron.execute(() => Boolean(globalThis.__sidePaneLateClose?.completed)),
    );
    await remountThroughLogin(taskId);
    // 不对父版本已有的浏览器壳同步问题作断言；只验证新标签及其真实 PTY。
    await $(`[data-side-pane-tab-id="${terminalId}"]`).waitForDisplayed();
    await $(`[data-side-pane-tab-id="${terminalId}"]`).click();
    await browser.waitUntil(async () =>
      (await terminalText()).includes("E2E_MRO04_LATE_CLOSE_BEFORE"),
    );
    const after = await runTerminalProbe("LATE_CLOSE_AFTER");
    expect([...after.matchAll(/PTY_OWNER=(\d+)/gu)].at(-1)?.[1]).toBe(pid);
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "side-pane-late-close.png"),
      );
    }
  });
});

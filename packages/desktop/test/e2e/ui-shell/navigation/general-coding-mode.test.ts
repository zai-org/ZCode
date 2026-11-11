import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_LOGIN_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_SETTINGS_BUTTON,
  TID_TERMINAL_TOGGLE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// MODE-01/02/03：只操作应用 UI 和本地 PTY，不发送模型请求。
describe("办公与编程模式 M1", () => {
  let telemetryFetch: Awaited<ReturnType<typeof browser.electron.mock>>;
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchMode("coding");
    telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MODE-01 设置页与头像菜单共用偏好，刷新后保留", async () => {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
    // 界面模式已迁到常规设置并更名 office，旧 appearance/general 断言无法进入待测交互。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    const select = '[role="combobox"][aria-label="界面模式"]';
    await $(select).waitForDisplayed();
    await $(select).click();
    await clickText('[role="option"]', "办公模式");
    await waitForMode("office");
    await assertSwitches([
      { event_region: "app.setting", previous_ui_mode: "code", ui_mode: "work" },
    ]);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await switchMode("coding");
    await switchMode("coding"); // 重选同值不产生切换事件。
    await browser.refresh();
    await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).waitForDisplayed({ timeout: 30000 });
    await waitForMode("coding");
    expect(await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).isExisting()).toBe(true);
    const switches = [
      { event_region: "app.setting", previous_ui_mode: "code", ui_mode: "work" },
      { event_region: "app.profile", previous_ui_mode: "work", ui_mode: "code" },
    ];
    await assertSwitches(switches); // 刷新恢复偏好不补报。

    const openModePage = async () => {
      await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "Shift", "o"]);
      await $('[data-testid="onboarding-page"]').waitForDisplayed();
      await clickText('[data-testid="onboarding-page"] button', "下一步");
      await clickText('[data-testid="onboarding-page"] button[aria-pressed] span', "办公模式");
    };
    await openModePage();
    await browser.keys("Escape");
    await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true });
    await waitForMode("coding");
    await assertSwitches(switches); // 卡片草稿及关闭不改变实际界面模式。

    await openModePage();
    await clickText('[data-testid="onboarding-page"] button', "下一步");
    await assertSwitches(switches);
    // 偏好页的跳过沿用既有语义：仍应用上一页已选择的界面模式。
    await clickText('[data-testid="onboarding-page"] button', "跳过");
    await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true });
    await waitForMode("office");
    const appliedSwitches = [
      ...switches,
      { event_region: "app.onboarding", previous_ui_mode: "code", ui_mode: "work" },
    ];
    await assertSwitches(appliedSwitches);

    const toggleByShortcut = () =>
      browser.keys([process.platform === "darwin" ? "Meta" : "Control", "Shift", "u"]);
    // 快捷键虽由常驻引导组件处理，但不是这三个 UI 入口，不能误归到 app.onboarding。
    await toggleByShortcut();
    await waitForMode("coding");
    await assertSwitches(appliedSwitches);
    await openModePage();
    await toggleByShortcut();
    await waitForMode("office");
    await clickText('[data-testid="onboarding-page"] button', "下一步");
    await clickText('[data-testid="onboarding-page"] button', "跳过");
    await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true });
    await assertSwitches(appliedSwitches); // 快捷键已应用模式，提交同值不补报。
    await switchMode("coding");
    await assertSwitches([
      ...appliedSwitches,
      { event_region: "app.profile", previous_ui_mode: "work", ui_mode: "code" },
    ]);
  });

  it("MODE-02/03 隐藏新建入口，保留已打开审查、终端和 PTY", async () => {
    await switchMode("office");
    await clickTestIdByDom(TID_SIDE_PANE_TOGGLE);
    await $('[data-side-pane-open-tab-item="browser"]').waitForDisplayed();
    expect(await $('[data-side-pane-open-tab-item="review"]').isExisting()).toBe(false);
    expect(await $('[data-side-pane-open-tab-item="terminal"]').isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).isExisting()).toBe(false);

    await switchMode("coding");
    await $('[data-side-pane-open-tab-item="review"]').click();
    await $('[data-side-pane-tab-id="git"]').waitForDisplayed();
    await $("[data-side-pane-add-tab-trigger]").click();
    await $('[data-state="active"] [data-side-pane-open-tab-item="terminal"]').click();
    await $('[data-side-pane-tab-id^="terminal:"]').waitForDisplayed();
    await clickTestIdByDom(TID_TERMINAL_TOGGLE);
    await browser.waitUntil(async () => (await terminalHeight()) > 50);
    const before = await readTabs();
    const terminalId = before.find((tab) => tab.id.startsWith("terminal:"))!.id;

    await switchMode("office");
    expect(await readTabs()).toEqual(before);
    expect(await terminalHeight()).toBeGreaterThan(50);
    expect(await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).isExisting()).toBe(false);
    expect(await $('button[aria-label="新建终端"]').isExisting()).toBe(false);
    await $("[data-side-pane-add-tab-trigger]").click();
    expect(
      await $('[data-state="active"] [data-side-pane-open-tab-item="terminal"]').isExisting(),
    ).toBe(false);
    expect(await visibleTexts('[role="menuitem"]')).not.toContain("审查");
    await $(`[data-side-pane-tab-id="${terminalId}"]`).click();

    const terminalInput = $("[data-workspace-side-frame] .xterm-helper-textarea");
    await terminalInput.waitForExist();
    // 冷启动时 textarea 先于 terminal.create 完成出现；等 shell 提示符后再输入，避免命令被丢弃。
    await browser.waitUntil(async () =>
      browser.execute(() =>
        [...document.querySelectorAll("[data-workspace-side-frame] .xterm-rows > div")].some(
          (row) => /[%$#>]\s*$/.test(row.textContent ?? ""),
        ),
      ),
    );
    // xterm 的输入 textarea 位于负 z-index，不能作为真实点击目标；点击可见终端后校验焦点。
    await $("[data-workspace-side-frame] .xterm-screen").click();
    await browser.waitUntil(async () => terminalInput.isFocused());
    await browser.keys("printf 'MODE_%s\\n' PTY_ALIVE");
    await browser.keys("Enter");
    try {
      await browser.waitUntil(async () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-workspace-side-frame] .xterm-rows > div")].some(
            (row) => row.textContent?.trim() === "MODE_PTY_ALIVE",
          ),
        ),
      );
    } finally {
      const artifactDir = join(process.cwd(), ".e2e-artifacts", "general-coding-mode");
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(join(artifactDir, "general-mode-pty.png"));
    }

    await browser.execute(() =>
      document.querySelector<HTMLElement>('[data-side-pane-tab-id="git"]')!.click(),
    );
    await browser.waitUntil(
      async () => (await readTabs()).find((tab) => tab.id === "git")?.active === true,
    );
    await switchMode("coding");
    await switchMode("office");
    expect((await readTabs()).find((tab) => tab.id === "git")?.active).toBe(true);
    expect((await readTabs()).map((tab) => tab.id)).toContain(terminalId);

    await browser.execute((id) => {
      const tab = [...document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")].find(
        (item) => item.dataset.sidePaneTabId === id,
      );
      tab?.querySelector<HTMLButtonElement>("button")?.click();
    }, terminalId);
    await browser.waitUntil(async () => !(await readTabs()).some((tab) => tab.id === terminalId));
    expect((await readTabs()).find((tab) => tab.id === "git")?.active).toBe(true);
  });

  async function readSwitches(): Promise<Array<Record<string, string>>> {
    await telemetryFetch.update();
    return telemetryFetch.mock.calls.flatMap((call) => {
      const [url, init] = call as [unknown, { body?: string } | undefined];
      if (!String(url).includes("/event/report") || !init?.body) return [];
      const event = JSON.parse(init.body);
      if (event.element_name !== "ui_mode_switch") return [];
      return [
        {
          ...event.event_extra_detail,
          event_region: event.event_region,
          event_type: event.event_type,
        },
      ];
    });
  }

  async function assertSwitches(expected: Array<Record<string, string>>) {
    await browser.waitUntil(async () => (await readSwitches()).length >= expected.length, {
      timeout: 15000,
      timeoutMsg: "ui_mode_switch 未到达最终上报边界",
    });
    expect(await readSwitches()).toEqual(expected.map((event) => ({ ...event, event_type: "ck" })));
  }
});

async function switchMode(mode: "office" | "coding") {
  // Radix 的退出动画期间仍有旧菜单层；等待它卸载，避免下一次点击被当作关闭旧层。
  await browser.waitUntil(
    async () => !(await $('[data-slot="dropdown-menu-content"]').isExisting()),
  );
  await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).waitForDisplayed();
  await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
  await clickText('[role="menuitem"]', "界面模式");
  await clickText('[role="menuitemradio"]', mode === "office" ? "办公模式" : "编程模式");
  await browser.keys("Escape");
  await waitForMode(mode);
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).getAttribute("aria-expanded")) === "false",
  );
}

async function clickText(selector: string, text: string) {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (query, label) => {
            const element = [...document.querySelectorAll<HTMLElement>(query)].find(
              (item) =>
                item.getBoundingClientRect().width > 0 && item.textContent?.trim() === label,
            );
            if (!element) return false;
            element.click();
            return true;
          },
          selector,
          text,
        ),
      { timeout: 10000, timeoutMsg: `未找到 ${text}` },
    );
  } catch (error) {
    const diagnostic = await browser.execute(() => ({
      trigger: document.querySelector('[data-testid="login-trigger"]')?.outerHTML,
      menus: [...document.querySelectorAll('[role*="menu"]')].map((item) => ({
        role: item.getAttribute("role"),
        text: item.textContent,
        state: item.getAttribute("data-state"),
        rect: item.getBoundingClientRect().toJSON(),
      })),
      bodyPointerEvents: document.body.style.pointerEvents,
    }));
    throw new Error(`${String(error)}; UI=${JSON.stringify(diagnostic)}`);
  }
}

async function waitForMode(mode: string) {
  await browser.waitUntil(async () =>
    browser.execute((expected) => localStorage.getItem("zcode-interface-mode") === expected, mode),
  );
}

async function readTabs() {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")].map((tab) => ({
      id: tab.dataset.sidePaneTabId!,
      active: tab.dataset.state === "active",
    })),
  );
}

async function terminalHeight() {
  return browser.execute(
    () =>
      document.querySelector("[data-workspace-terminal-frame]")?.getBoundingClientRect().height ??
      0,
  );
}

async function visibleTexts(selector: string) {
  return browser.execute(
    (query) =>
      [...document.querySelectorAll<HTMLElement>(query)]
        .filter((item) => item.getBoundingClientRect().width > 0)
        .map((item) => item.textContent?.trim()),
    selector,
  );
}

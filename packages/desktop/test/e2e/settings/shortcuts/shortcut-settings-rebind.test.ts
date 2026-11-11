import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDEBAR,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { sel } from "#e2e/helpers/selectors";

interface ShortcutSettingsShape {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * 快捷键设置 E2E（spec docs/desktop/shortcut-settings-spec.md §10）：
 * 录制新键位 → 落盘 → 主界面按新键位生效；冲突组合拒绝保存并标红；IME 组合中的按键不触发命令。
 */
describe("快捷键设置 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SC-01: 录制新键位后落盘，主界面按新键位切换侧栏", async function () {
    this.timeout(120_000);

    await waitForDefaultWorkspaceReady(30_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await openShortcutSettings();

    // 进入 toggleSidebar 录制态，按平台主修饰键 + L
    await clickTestIdByDom("settings-shortcut-bind-toggleSidebar-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 toggleSidebar 行",
    });
    await dispatchShortcut("e", "KeyE");
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.toggleSidebar?.[0] === "CmdOrCtrl+e";
      },
      { timeout: 15_000, timeoutMsg: "录制的新键位没有写入 setting.json" },
    );

    // 返回主界面，按新键位应隐藏/再显示侧栏
    await backToWorkspace();
    await dispatchShortcut("e", "KeyE");
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ reverse: true, timeout: 10_000 });
    await dispatchShortcut("e", "KeyE");
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ timeout: 10_000 });
  });

  it("SC-02: app 内占用提示后二次确认抢绑；系统保留键直接拒绝且无确认入口", async function () {
    this.timeout(90_000);

    await openShortcutSettings();

    // 用户场景同款：任务内查找改绑 Ctrl+J —— 被 toggleTerminal 默认占用。
    // （不动 toggleSidebar：SC-03 依赖 SC-01 里它已绑到 Ctrl/Cmd+E）
    await clickTestIdByDom("settings-shortcut-bind-findInTask-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 findInTask 行",
    });
    await dispatchShortcut("j", "KeyJ");
    // 占用提示标红 + 「仍要绑定」确认按钮出现
    await $(sel("settings-shortcut-error-findInTask")).waitForDisplayed({ timeout: 10_000 });
    await $(sel("settings-shortcut-steal-findInTask")).waitForDisplayed({ timeout: 10_000 });

    // 系统保留键（Ctrl+C）：直接拒绝、无二次确认入口，不落盘
    await dispatchShortcut("c", "KeyC");
    await browser.pause(300);
    const settingsAfterReserved = await readSettings();
    expect(settingsAfterReserved.shortcutBindings?.findInTask).toBeUndefined();

    // 回到占用组合并二次确认抢绑
    await dispatchShortcut("j", "KeyJ");
    await $(sel("settings-shortcut-steal-findInTask")).waitForDisplayed({ timeout: 10_000 });
    await clickTestIdByDom("settings-shortcut-steal-findInTask", {
      timeout: 10_000,
      timeoutMsg: "「仍要绑定」确认按钮没有出现",
    });

    // 抢绑落盘：findInTask 绑新键，被抢的 toggleTerminal 清空为「未设置」（显式空数组）
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return (
          settings.shortcutBindings?.findInTask?.[0] === "CmdOrCtrl+j" &&
          settings.shortcutBindings?.toggleTerminal?.length === 0
        );
      },
      { timeout: 15_000, timeoutMsg: "二次确认抢绑后没有按预期写入 setting.json" },
    );

    // Escape 清理可能残留的录制态
    await dispatchKey("Escape", "Escape", {});
  });

  it("SC-03: IME 组合中的按键不触发快捷键命令", async function () {
    this.timeout(60_000);

    await backToWorkspace();
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ timeout: 10_000 });

    // isComposing 的 Ctrl/Cmd+E 不应隐藏侧栏
    await dispatchShortcut("e", "KeyE", { isComposing: true });
    await browser.pause(800);
    expect(await $(sel(TID_SIDEBAR)).isDisplayed()).toBe(true);

    // 对照：同一形态的普通事件必须能隐藏侧栏（排除 dispatch 方式本身无效）
    await dispatchShortcut("e", "KeyE");
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ reverse: true, timeout: 10_000 });
    await dispatchShortcut("e", "KeyE");
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ timeout: 10_000 });
  });

  it("SC-10: 清除 = 未分配，原键彻底失效且持久化不回退默认", async function () {
    this.timeout(120_000);

    await openShortcutSettings();

    // SC-01 后 toggleSidebar 绑在 Cmd/Ctrl+E（有覆盖条目）；点垃圾桶 = 清除为未分配
    await clickTestIdByDom("settings-shortcut-clear-toggleSidebar", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 toggleSidebar 清除按钮",
    });

    // 落盘为显式空数组（未分配语义，不回退默认绑定）
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.toggleSidebar?.length === 0;
      },
      { timeout: 15_000, timeoutMsg: "清除后没有写入显式空数组" },
    );

    // kbd 显示「未分配」，清除按钮因无键可清转为禁用
    const kbdText = await $(sel("settings-shortcut-bind-toggleSidebar-unassigned")).getText();
    expect(["未分配", "Unassigned"]).toContain(kbdText.trim());
    expect(await $(sel("settings-shortcut-clear-toggleSidebar")).isEnabled()).toBe(false);

    // 主界面按原键不再切换侧栏（生效表为空，命令彻底失效）
    await backToWorkspace();
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ timeout: 10_000 });
    await dispatchShortcut("e", "KeyE");
    await browser.pause(800);
    expect(await $(sel(TID_SIDEBAR)).isDisplayed()).toBe(true);

    // 重进设置页仍为未分配：覆盖空数组持久化生效，不回退默认键位
    await openShortcutSettings();
    const kbdTextAgain = await $(sel("settings-shortcut-bind-toggleSidebar-unassigned")).getText();
    expect(["未分配", "Unassigned"]).toContain(kbdTextAgain.trim());
  });
});

async function openShortcutSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "shortcuts"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现快捷键分区入口",
  });
}

async function backToWorkspace() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现返回按钮",
  });
}

/** 按平台主修饰键（mac=Meta，其他=Ctrl）派发合成 keydown 到 window（capture 监听可收到）。 */
async function dispatchShortcut(key: string, code: string, opts: { isComposing?: boolean } = {}) {
  const isMac = await browser.execute(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await dispatchKey(key, code, {
    metaKey: isMac,
    ctrlKey: !isMac,
    isComposing: opts.isComposing ?? false,
  });
}

async function dispatchKey(
  key: string,
  code: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean },
) {
  await browser.execute(
    (eventKey, eventCode, metaKey, ctrlKey, shiftKey, isComposing) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: eventKey,
          code: eventCode,
          metaKey,
          ctrlKey,
          shiftKey,
          isComposing,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    code,
    modifiers.metaKey ?? false,
    modifiers.ctrlKey ?? false,
    modifiers.shiftKey ?? false,
    modifiers.isComposing ?? false,
  );
}

async function readSettings(): Promise<ShortcutSettingsShape> {
  try {
    return JSON.parse(
      await readFile(join(getE2EAppDataPaths().appDataDir, "setting.json"), "utf-8"),
    ) as ShortcutSettingsShape;
  } catch {
    return {};
  }
}

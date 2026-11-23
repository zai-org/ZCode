import { Key } from "webdriverio";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_REPLY_LANGUAGE_INPUT,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 用例定义见 docs/ui/settings-sidebar-layout.md「行为与工具分类验收」SAB04。
// 这一行的分类清单与布局截图在已转正的 settings/agent/settings-agent-behavior.test.ts（SAB01/SAB03）。
const agentNav = testId(TID_SETTINGS_SECTION_NAV, "agentBehavior");
const page = () => $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
const replyLanguageInput = () => $(`[data-testid="${TID_SETTINGS_REPLY_LANGUAGE_INPUT}"]`);

describe("Agent 回复语言设置", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await page().waitForDisplayed();
  });

  after(async () => {
    await clearAppData();
  });

  it("SAB04：回复语言回车与失焦保存、Esc 恢复、去空格、清空删除字段，重开与刷新后保持", async () => {
    await clickTestIdByDom(agentNav);
    const input = replyLanguageInput();
    await input.scrollIntoView();
    expect(await input.getValue()).toBe("");
    const savedAs = (value: string | undefined) =>
      browser.waitUntil(async () => (await readSettings()).replyLanguage === value, {
        timeoutMsg: `setting.json 的 replyLanguage 不是 ${JSON.stringify(value)}`,
      });

    // 回车保存，并去掉首尾空格。
    await input.setValue("  Deutsch  ");
    await browser.keys("Enter");
    await savedAs("Deutsch");
    await browser.waitUntil(async () => (await input.getValue()) === "Deutsch");

    // Esc 恢复已保存的值，不写盘，也不关闭设置页。
    // 已保存的值来自设置快照（Main 写盘后广播刷新）；renderer 慢时快照可能晚到，按最终值等待。
    await input.setValue("Français");
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await input.getValue()) === "Deutsch", {
      timeoutMsg: "Esc 后输入框没有恢复为已保存的值",
    });
    expect(await page().isDisplayed()).toBe(true);
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    expect((await readSettings()).replyLanguage).toBe("Deutsch");

    // 失焦保存原文。
    await input.setValue("Português (Brasil)");
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await savedAs("Português (Brasil)");

    // 离开、重开与刷新后仍显示已保存的值。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${agentNav}"][aria-current="page"]`).waitForExist();
    expect(await replyLanguageInput().getValue()).toBe("Português (Brasil)");
    await browser.refresh();
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).waitForExist({ timeout: 30_000 });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${agentNav}"][aria-current="page"]`).waitForExist();
    await browser.waitUntil(
      async () => (await replyLanguageInput().getValue()) === "Português (Brasil)",
    );

    // 清空后保存：setting.json 里删除该字段。
    // WebDriver clear 直接改 value 属性，React 收不到 input 事件，草稿不变；用真实全选和退格清空。
    await replyLanguageInput().click();
    await browser.keys([process.platform === "darwin" ? Key.Command : Key.Control, "a"]);
    await browser.keys("Backspace");
    await browser.waitUntil(async () => (await replyLanguageInput().getValue()) === "");
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await savedAs(undefined);
    expect(Object.hasOwn(await readSettings(), "replyLanguage")).toBe(false);
  });
});

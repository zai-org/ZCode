import { TID_SIDE_PANE_TOGGLE, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, switchToNewestWindow } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

describe("DBG01 开发者工具请求诊断", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("完成请求后打开面板，恢复 token、网络及首 token 后的 TPS", async function () {
    this.timeout(120_000);
    // 隔离用户目录首次启动会进入引导页，先退出再进入真实任务。
    await browser.waitUntil(
      async () => {
        await switchToNewestWindow();
        return (
          (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
          (await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).isDisplayed())
        );
      },
      { timeout: 30_000, timeoutMsg: "首次引导或 Composer 没有出现" },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_DEVELOPER_TOOLS: Reply with exactly upstream-e2e-ok.");
    await waitForV4AssistantMessageContaining("upstream-e2e-ok");
    await waitForV4ConversationState((state) => state.state === "idle", "主请求尚未结束");
    await browser.execute(() => {
      localStorage.setItem("zcode:developer-tools:enabled", "1");
      window.dispatchEvent(new Event("focus"));
    });
    const launcher = await $('[data-side-pane-open-tab-item="developer-tools"]');
    const add = await $("[data-side-pane-add-tab-trigger]");
    if (!(await launcher.isDisplayed()) && !(await add.isDisplayed())) {
      await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    }
    await browser.waitUntil(
      async () => (await launcher.isDisplayed()) || (await add.isDisplayed()),
      { timeout: 15_000, timeoutMsg: "右侧面板入口未出现" },
    );
    if (await launcher.isDisplayed()) {
      await launcher.click();
    } else {
      await add.waitForClickable({ timeout: 15_000 });
      await add.click();
      const item = await $(
        '[data-state="active"] [data-side-pane-open-tab-item="developer-tools"]',
      );
      await item.waitForClickable({ timeout: 10_000 });
      await item.click();
    }
    await browser.waitUntil(
      async () => {
        const cell = await $('[data-testid="token-debug-tps"]');
        return (await cell.isExisting()) && Number(await cell.getText()) > 0;
      },
      { timeout: 30_000, timeoutMsg: "请求诊断未到达面板" },
    );
    const tps = Number(await $('[data-testid="token-debug-tps"]').getText());
    // replay 首输出在 2s，结束在 5s，output=120；留给 SDK/调度少量时间误差。
    expect(tps).toBeGreaterThan(35);
    expect(tps).toBeLessThan(45);
    const panel = await $('[data-testid="developer-tools-pane"]');
    expect(await panel.getText()).toContain("120");
    expect(await panel.$$("summary")).not.toHaveLength(0);
    expect(await panel.$('[role="alert"]').isExisting()).toBe(false);
  });
});

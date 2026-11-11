import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  switchV4Mode,
  getV4ModelConfig,
} from "#e2e/helpers/v4-conversation";
import { getUpstreamRequestRecordCount } from "#e2e/helpers/conversation-session-network";

describe("Todo151 独立 Plan 草稿", () => {
  after(async () => {
    await clearAppData();
  });
  it("PLAN151-01: Plan 与权限独立，整按钮仅清标记，不触发请求", async () => {
    try {
      await prepareV4ConversationE2E();
    } catch (error) {
      // 新用户可能先进入职业引导；只处理已确认可见的引导，不吞掉其他初始化失败。
      const onboarding = $('[data-testid="onboarding-page"]');
      if (!(await onboarding.isDisplayed())) throw error;
      for (let step = 0; step < 3 && (await onboarding.isDisplayed()); step++) {
        const previous = await onboarding.getText();
        const buttons = await onboarding.$$("button");
        for (const button of buttons) {
          if (/^(Skip|跳过)$/.test(await button.getText())) {
            await button.click();
            break;
          }
        }
        await browser.waitUntil(async () =>
          browser.execute((previousText) => {
            const page = document.querySelector('[data-testid="onboarding-page"]');
            return !page || (page as HTMLElement).innerText !== previousText;
          }, previous),
        );
      }
      await prepareV4ConversationE2E();
    }
    await switchV4Mode("yolo");
    const before = await getUpstreamRequestRecordCount();
    await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).click();
    const plan = $(`[data-testid="${testId(TID_CHAT_MODE_SELECT_ITEM, "plan")}"]`);
    await plan.waitForDisplayed();
    expect(await plan.getText()).toMatch(/编辑前先出计划。|Plan before editing\./);
    expect(await plan.getAttribute("role")).toBe("menuitemcheckbox");
    await plan.click();
    const marker = $('[data-testid="v4-composer-plan-marker"]');
    await marker.waitForDisplayed();
    expect((await getV4ModelConfig()).mode).toBe("yolo");
    // 草稿更新先于菜单关闭动画结束；等旧菜单卸载后，再次打开权限菜单。
    await plan.waitForExist({ reverse: true });
    await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).click();
    await plan.waitForDisplayed();
    expect(await plan.getAttribute("aria-checked")).toBe("true");
    await plan.click();
    await marker.waitForExist({ reverse: true });
    expect((await getV4ModelConfig()).mode).toBe("yolo");
    expect(await getUpstreamRequestRecordCount()).toBe(before);
    await plan.waitForExist({ reverse: true });
    await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).click();
    await plan.waitForDisplayed();
    expect(await plan.getAttribute("aria-checked")).toBe("false");
    await plan.click();
    await marker.waitForDisplayed();
    await plan.waitForExist({ reverse: true });
    // Edit 已从新建权限菜单移除；用可选的变更前确认验证 Plan 与权限独立。
    await switchV4Mode("build");
    expect((await getV4ModelConfig()).mode).toBe("build");
    expect(await marker.isDisplayed()).toBe(true);
    const button = marker.$("button");
    const divider = marker.$('[role="separator"]');
    expect(await divider.getSize("height")).toBe(12);
    expect(await button.getSize("height")).toBe(
      await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).getSize("height"),
    );
    // 先离开相邻菜单的 Tooltip 安全区，避免 WebDriver 单次跳点停留在旧提示的过渡区。
    await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).moveTo();
    await browser.waitUntil(async () =>
      browser.execute(() => !document.querySelector('[data-slot="tooltip-content"]')),
    );
    expect(await button.$("svg.lucide-lightbulb").isDisplayed()).toBe(true);
    expect(await button.$("svg.lucide-x").isDisplayed()).toBe(false);
    await button.moveTo();
    // Radix 的 role=tooltip 是无障碍副本；断言用户实际看到的内容层。
    await browser.waitUntil(
      async () => {
        for (const tooltip of await $$('[data-slot="tooltip-content"]')) {
          if (
            (await tooltip.isDisplayed()) &&
            /取消下一次提交的计划模式|Remove Plan from the next submission/.test(
              await tooltip.getText(),
            )
          )
            return true;
        }
        return false;
      },
      { timeoutMsg: "Plan 关闭提示未显示" },
    );
    expect(await button.$("svg.lucide-lightbulb").isDisplayed()).toBe(false);
    expect(await button.$("svg.lucide-x").isDisplayed()).toBe(true);
    for (const width of [1280, 980, 740, 520, 390]) {
      await browser.electron.execute(async (electron, viewportWidth) => {
        const target = electron.BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && window.isVisible(),
        )!;
        if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
        await target.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: viewportWidth,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }, width);
      for (const theme of ["zai-light", "zai-dark"]) {
        await browser.execute((value) => {
          (
            window as unknown as { __testActions: { setTheme(theme: string): void } }
          ).__testActions.setTheme(value);
        }, theme);
        await browser.waitUntil(async () =>
          browser.execute((expected) => window.innerWidth === expected, width),
        );
        await marker.waitForDisplayed();
        expect(await divider.getSize("height")).toBe(12);
        const modeButton = $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`);
        if (width === 390) {
          expect(await button.$("span").isDisplayed()).toBe(false);
          expect(await button.getSize()).toEqual({ width: 28, height: 28 });
          expect(await modeButton.getSize()).toEqual({ width: 28, height: 28 });
        } else if (width === 1280) {
          expect(await button.$("span").isDisplayed()).toBe(true);
          expect(await button.getSize("width")).toBeGreaterThan(28);
        }
        const groupsSeparated = await browser.execute(() => {
          const left = document
            .querySelector("[data-composer-leading-content]")!
            .getBoundingClientRect();
          const right = document
            .querySelector("[data-composer-trailing-actions]")!
            .getBoundingClientRect();
          return right.left >= left.right + 11 && Math.abs(right.bottom - left.bottom) <= 1;
        });
        expect(groupsSeparated).toBe(true);
        await browser.saveScreenshot(`.e2e-artifacts/plan-marker-${width}-${theme}.png`);
      }
    }
    await browser.electron.execute(async (electron) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.isVisible(),
      )!;
      await target.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    });
    // 点击文字区域也必须关闭，避免退回只有尾部叉号可点击的样式。
    await button.$("span").click();
    await marker.waitForExist({ reverse: true });
    expect((await getV4ModelConfig()).mode).toBe("build");
    expect(await getUpstreamRequestRecordCount()).toBe(before);
  });
});

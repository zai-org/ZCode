import { ensureUpstreamProviderForE2E, selectUpstreamModel } from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

// SHARE34：真实 Desktop 入口与 Composer/选择器联动；不通过测试替身发布公开链接。
describe("E2E_SHARE_POPOVER: 分享浮窗范围确认", () => {
  it("取消回滚、确认生效，分享设置不替换输入区", async function () {
    this.timeout(180_000);
    // 新隔离 HOME 会显示首次引导；按用户操作关闭，避免把引导页误判为 workspace 加载失败。
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=onboarding-page]").isDisplayed()) ||
        (await $("[data-testid^=v4-session-pane]").isExisting()),
      { timeout: 30_000 },
    );
    if (await $("[data-testid=onboarding-page]").isDisplayed()) await browser.keys("Escape");
    // 分享只要求完成两轮回放；当前默认模型没有旧 helper 强制选择的 high 档位。
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectUpstreamModel();
    for (const suffix of ["one", "two"]) {
      await sendV4Prompt(`E2E_SHARE_POPOVER_${suffix}: reply exactly share-popover-${suffix}`);
      await waitForV4AssistantMessageContaining(`share-popover-${suffix}`);
      await waitForV4ConversationState((state) => state.state === "idle", "等待已完成轮次");
    }
    const trigger = await $("[data-testid=conversation-share-trigger]");
    await trigger.waitForClickable();
    await trigger.click();
    const popover = await $("[data-testid=conversation-share-popover]");
    await popover.waitForDisplayed();
    await $("[data-testid=conversation-share-adjust]").click();
    const panel = await $("[data-testid=conversation-share-selection-panel]");
    await panel.waitForDisplayed();
    const checkbox = await panel.$('[data-conversation-share-selection-item] [role="checkbox"]');
    const all = await panel.$('[data-testid="conversation-share-selection-all"]');
    expect(await all.getAttribute("aria-checked")).toBe("true");
    await all.click();
    expect(await all.getAttribute("aria-checked")).toBe("false");
    expect(await $("[data-testid=conversation-share-selection-apply]").isEnabled()).toBe(false);
    await checkbox.click();
    expect(await all.getAttribute("aria-checked")).toBe("mixed");
    await all.click();
    expect(await all.getAttribute("aria-checked")).toBe("true");

    await panel.$('[data-testid="conversation-share-selection-toggle"]').click();
    expect(await checkbox.getAttribute("data-state")).toBe("unchecked");
    const beforeLocate = await browser.execute(() => {
      const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;
      return timeline.scrollTop;
    });
    expect(beforeLocate).toBeGreaterThan(100);
    await panel.$('[data-testid="conversation-share-selection-locate"]').click();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!;
          const target = [...timeline.querySelectorAll<HTMLElement>("[data-row-id]")].find((row) =>
            row.textContent?.includes("E2E_SHARE_POPOVER_one"),
          );
          if (!target) return false;
          const top = target.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
          return top >= -1 && top < 50;
        }),
      { timeoutMsg: "独立定位后首条用户消息应对齐到正文可视区顶部" },
    );
    expect(
      await browser.execute(
        () => document.querySelector<HTMLElement>('[data-testid="v4-timeline"]')!.scrollTop,
      ),
    ).toBeLessThan(beforeLocate);

    expect(await checkbox.getAttribute("data-state")).toBe("unchecked");
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=conversation-share-adjust]").getAttribute("aria-busy")) === "false",
      { timeoutMsg: "等待分享范围预检完成" },
    );
    expect(await $("[data-testid=conversation-share-range-summary]").getText()).toContain("2");
    // 预检完成后显示服务端声明的有效期范围，默认选中服务端默认值（契约 fake 为 1 天）。
    const expiryPicker = await $('[data-testid="conversation-share-expiry-picker"]');
    await expiryPicker.waitForDisplayed();
    expect(await expiryPicker.getText()).toMatch(/1 天|1 day/iu);
    await $("[data-testid=conversation-share-selection-cancel]").click();
    await panel.waitForDisplayed({ reverse: true });
    await $("[data-testid=conversation-share-adjust]").click();
    await panel.waitForDisplayed();
    expect(
      await panel
        .$('[data-conversation-share-selection-item] [role="checkbox"]')
        .getAttribute("data-state"),
    ).toBe("checked");
    await panel.$('[data-conversation-share-selection-item] [role="checkbox"]').click();
    await $("[data-testid=conversation-share-selection-apply]").waitForClickable();
    await $("[data-testid=conversation-share-selection-apply]").click();
    await panel.waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=conversation-share-adjust]").getAttribute("aria-busy")) === "false",
      { timeoutMsg: "等待分享范围预检完成" },
    );
    expect(await $("[data-testid=conversation-share-range-summary]").getText()).toContain("1");
    await browser.keys("Escape");
    await popover.waitForDisplayed({ reverse: true });
    await trigger.click();
    await popover.waitForDisplayed();
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=conversation-share-adjust]").getAttribute("aria-busy")) === "false",
      { timeoutMsg: "等待分享范围预检完成" },
    );
    expect(await $("[data-testid=conversation-share-range-summary]").getText()).toContain("1");
  });
});

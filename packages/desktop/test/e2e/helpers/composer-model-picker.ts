import { TID_CHAT_MODEL_SELECT_TRIGGER, TID_V4_MODEL_CONFIG } from "@zcode/shared/test-ids";

/** 合并入口与开关由真实点击驱动，滑杆由键盘驱动，不用 DOM 值覆盖伪造 React 状态。 */
export async function selectCombinedComposerThoughtLevel(value: string): Promise<boolean> {
  const trigger = $(
    `[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"][data-composer-combined-model]`,
  );
  if (!(await trigger.isExisting())) return false;
  await trigger.waitForClickable({ timeout: 30000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const slider = $('[data-testid="composer-thought-slider"]');
  const toggle = $('[data-testid="composer-thought-switch"]');
  if (await toggle.isExisting()) {
    const on = await toggle.getAttribute("data-on-value");
    const off = await toggle.getAttribute("data-off-value");
    if (value !== on && value !== off) throw new Error(`思考开关不支持档位 ${value}`);
    const checked = String(value === on);
    if ((await toggle.getAttribute("aria-checked")) !== checked) await toggle.click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_V4_MODEL_CONFIG}"]`).getAttribute("data-thought")) === value,
      {
        timeout: 15000,
      },
    );
    await browser.keys("Escape");
    return true;
  }
  if (!(await slider.isExisting())) {
    // 仅 Off 的模型没有可调控件；只能接受当前真实投影，不能伪造一次选择。
    const current = await $(`[data-testid="${TID_V4_MODEL_CONFIG}"]`).getAttribute("data-thought");
    if (current !== value)
      throw new Error(`当前模型没有可调思考档位: ${value} (current=${current})`);
    await browser.keys("Escape");
    return true;
  }
  await slider.waitForExist({ timeout: 15000 });
  const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
  const index = levels.indexOf(value);
  if (index < 0) throw new Error(`合并菜单不支持思考档位 ${value}: ${levels.join(",")}`);
  if (Number(await slider.getValue()) !== index) {
    if ((await slider.getAttribute("aria-disabled")) === "true")
      throw new Error(`思考滑杆不可调整: ${value}`);
    await browser.execute(() =>
      document.querySelector<HTMLInputElement>('[data-testid="composer-thought-slider"]')?.focus(),
    );
    const waitForLevel = async (expected: number) => {
      // 已有会话提交档位会关闭菜单；断言配置投影，下一步再打开。
      await browser.waitUntil(
        async () =>
          (await $(`[data-testid="${TID_V4_MODEL_CONFIG}"]`).getAttribute("data-thought")) ===
          levels[expected],
        { timeout: 15000 },
      );
      await trigger.waitForClickable({ timeout: 30000 });
    };
    await browser.keys(index === levels.length - 1 ? "End" : "Home");
    await waitForLevel(index === levels.length - 1 ? index : 0);
    if (index !== levels.length - 1) {
      for (let step = 0; step < index; step++) {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
        await browser.execute(() =>
          document
            .querySelector<HTMLInputElement>('[data-testid="composer-thought-slider"]')
            ?.focus(),
        );
        await browser.keys("ArrowRight");
        await waitForLevel(step + 1);
      }
    }
  }
  await browser.keys("Escape");
  return true;
}

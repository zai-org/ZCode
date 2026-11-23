import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { sel } from "./selectors.js";

// 新隔离 profile 的职业引导会覆盖工作区；通过真实 UI 完成，不伪造业务记录。
// keepCloudDialog：营销专项用例要断言投放弹窗本身，传 true 保留弹窗。
export async function skipOccupationOnboardingIfPresent(
  options: { keepCloudDialog?: boolean } = {},
) {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="onboarding-page"]').isExisting()) ||
      (await $(sel(TID_TASK_SETTINGS_BUTTON)).isExisting()),
    { timeout: 30000 },
  );
  // 新隔离 profile 可能进入职业引导，按真实 UI 跳过三步，不改全局测试夹具。
  for (
    let step = 0;
    step < 3 && (await $('[data-testid="onboarding-page"]').isExisting());
    step++
  ) {
    if (!options.keepCloudDialog) {
      await closeCloudContentDialogIfPresent();
    }
    const skip = $('//button[normalize-space(.)="Skip" or normalize-space(.)="跳过"]');
    await skip.waitForClickable({ timeout: 15000 });
    await skip.click();
  }
  await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true, timeout: 15000 });
}

// 测试后端的真实营销投放（如 2026-11 的版本介绍弹窗）会盖住引导页，「跳过」一直不可点，
// 整条用例开局就失败。弹窗是真实流程的一部分：出现就按用户操作点关闭，不出现不等待。
async function closeCloudContentDialogIfPresent() {
  const dialog = $('[data-testid="cloud-content-dialog"]');
  if (!(await dialog.isDisplayed())) return;
  await dialog.$('[data-slot="dialog-close"]').click();
  await dialog.waitForExist({ reverse: true, timeout: 15000 });
}

// 用产品支持的 Escape 退出引导（与“退出引导”按钮同一 closeOnboarding 路径，且不依赖界面语言）：
// 只持久化 dismissed 决策，不像“跳过”那样把 memoryEnabled 等偏好落成保守默认值，
// 供通用工作区就绪等待使用。
export async function dismissOccupationOnboarding() {
  await browser.keys("Escape");
}

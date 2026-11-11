import { TID_CHAT_ERROR_BANNER, TID_CHAT_MODEL_SELECT_TRIGGER } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareHighspeedDrawWorkspace,
  waitForHighspeedComposerCleared,
} from "#e2e/helpers/highspeed-card";
import { seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { getV4Messages, sendV4Prompt, waitForV4ComposerText } from "#e2e/helpers/v4-conversation";

const PROMPT = "E2E_HIGHSPEED_ADMISSION_RETAINS_DRAFT";
const RECOVERY_PROVIDER_ID = "highspeed-admission-recovery";
const RECOVERY_MODEL_ID = "recovery-model";

/**
 * 在 draw 已命中、sendText 尚未进入 Agent admission 的唯一窗口撤销 Coding Plan。
 * 该探针只制造真实 Registry 变化，不伪造 Command ACK 或 Renderer 状态。
 */
async function installHighspeedAdmissionRegistryRace() {
  await browser.execute(() => {
    const element = document.querySelector('[data-testid="v4-model-config"]');
    if (!element) throw new Error("Highspeed admission probe 找不到模型配置入口");
    const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber"));
    let fiber = fiberKey
      ? (element as unknown as Record<string, { return?: unknown }>)[fiberKey]
      : undefined;
    let services: any;
    while (fiber) {
      const value = (fiber as any).memoizedProps?.value;
      const candidate = value?.highspeedCardService
        ? value
        : (fiber as any).memoizedProps?.services;
      if (candidate?.highspeedCardService && candidate?.providerSettingsService) {
        services = candidate;
        break;
      }
      fiber = (fiber as any).return;
    }
    if (!services) throw new Error("Highspeed admission probe 找不到 Workspace services");

    const highspeed = services.highspeedCardService;
    const originalPrepareTurn = highspeed.prepareTurn;
    (window as any).__restoreHighspeedAdmissionRegistryRace = () => {
      highspeed.prepareTurn = originalPrepareTurn;
      delete (window as any).__restoreHighspeedAdmissionRegistryRace;
    };
    highspeed.prepareTurn = async (...args: unknown[]) => {
      const result = await originalPrepareTurn.apply(highspeed, args);
      if (result?.kind !== "accelerated") return result;

      // Bug 复现：抽卡时普通模型存在；命令 admission 前账号 Provider 与派生 Provider 同时下架。
      await services.oauthService.logoutAll();
      await services.providerSettingsService.refresh("e2e-highspeed-admission-registry-race");
      return result;
    };
  });
}

async function restoreHighspeedAdmissionRegistryRace() {
  await browser.execute(() => {
    (window as any).__restoreHighspeedAdmissionRegistryRace?.();
  });
}

describe("Highspeed card admission rejection E2E", () => {
  after(async () => {
    await restoreHighspeedAdmissionRegistryRace().catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-04: Highspeed 与退回目标都不可用时恢复输入并退出加速态", async function () {
    this.timeout(180000);

    // 保留一个非账号 Provider。账号退出后 Registry 仍有可选模型，断言按钮解除的确是
    // Highspeed 锁，而不是把“Registry 为空”的合法禁用误判为产品回归。
    await seedReplayProvider({
      id: RECOVERY_PROVIDER_ID,
      models: [RECOVERY_MODEL_ID],
      name: "Highspeed Admission Recovery",
    });
    await prepareHighspeedDrawWorkspace();
    await installHighspeedAdmissionRegistryRace();
    await sendV4Prompt(PROMPT);

    await waitForV4ComposerText(PROMPT, "Highspeed 准入拒绝后 Composer 没有恢复原输入", 30000);
    await waitForHighspeedComposerCleared("Highspeed 准入拒绝后输入框仍处于加速态");
    // 修复原因：草稿居中布局下 composer 位于 timeline 容器内，timelineText 会包含已恢复的
    // 原输入，导致断言永远不成立；拒绝语义只看 timeline 中是否出现了该用户消息行。
    const userMessages = await getV4Messages("user");
    expect(userMessages.some((message) => message.text.includes(PROMPT))).toBe(false);
    expect(await $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`).isExisting()).toBe(false);

    const modelTrigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
    await modelTrigger.waitForExist({ timeout: 15000 });
    await browser.waitUntil(
      async () =>
        (await modelTrigger.isEnabled()) &&
        (await modelTrigger.getAttribute("aria-disabled")) !== "true",
      { timeout: 15000, timeoutMsg: "Highspeed 准入拒绝后模型选择器没有解除锁定" },
    );
    await modelTrigger.click();
    await browser.waitUntil(
      async () => (await modelTrigger.getAttribute("aria-expanded")) === "true",
      { timeout: 15000, timeoutMsg: "Highspeed 准入拒绝后模型选择器仍无法打开" },
    );
    await browser.keys("Escape");
  });
});

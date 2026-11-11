import { TID_CHAT_ERROR_BANNER, TID_CHAT_MODEL_SELECT_TRIGGER } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForToastContaining } from "#e2e/helpers/conversation-session-toast";
import {
  prepareHighspeedDrawWorkspace,
  startHighspeedComposerProbe,
  takeHighspeedComposerProbe,
  waitForHighspeedComposerCleared,
} from "#e2e/helpers/highspeed-card";
import {
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// Host Mock 场景：hit-invalid-model（按 spec 文件注入，见 helpers/highspeed-mock-env.ts）。
const FALLBACK_REPLY_TOKEN = "hs-invalid-model-fallback-done";
const FALLBACK_TOAST = "加速服务暂不可用，本轮后续内容将使用原模型继续生成";

describe("Highspeed card fallback unlock E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-05: 加速模型不在目录时自动退回原模型并解锁模型选择", async function () {
    this.timeout(180000);

    await prepareHighspeedDrawWorkspace();
    // 创建期退回可能很快完成。发送前安装属性探针，避免只在最终状态采样而漏掉中途加速态。
    await startHighspeedComposerProbe();
    await sendV4Prompt(
      "E2E_HIGHSPEED_INVALID_MODEL_FALLBACK: reply with the fixed fallback token.",
    );

    await waitForToastContaining(FALLBACK_TOAST, "Highspeed 创建失败后没有显示一次降级提示");
    await waitForV4TimelineContaining(FALLBACK_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(FALLBACK_REPLY_TOKEN),
      "退回原模型后本轮没有正常完成",
      90000,
    );

    expect(await takeHighspeedComposerProbe()).toBe(true);
    await waitForHighspeedComposerCleared("退回原模型后输入框仍处于 Highspeed 状态");
    expect(await $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`).isExisting()).toBe(false);

    const modelTrigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
    await modelTrigger.waitForExist({ timeout: 15000 });
    expect(await modelTrigger.isEnabled()).toBe(true);
    expect(await modelTrigger.getAttribute("aria-disabled")).not.toBe("true");
    await modelTrigger.click();
    await browser.waitUntil(
      async () => (await modelTrigger.getAttribute("aria-expanded")) === "true",
      { timeout: 15000, timeoutMsg: "Highspeed 退回后模型选择器仍无法打开" },
    );
    await browser.keys("Escape");
  });
});

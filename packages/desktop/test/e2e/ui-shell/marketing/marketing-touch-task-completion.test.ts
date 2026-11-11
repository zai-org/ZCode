import { waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

function origin() {
  const value = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
  if (!value) throw new Error("Missing marketing fixture");
  return value;
}
async function queryCount() {
  const state = (await (await fetch(`${origin()}/__e2e/marketing/state`)).json()) as {
    requestDetails: Array<{ method: string; path: string }>;
  };
  return state.requestDetails.filter(
    (r) => r.method === "GET" && r.path === "/api/v1/marketing/touch",
  ).length;
}

describe("任务成功完成刷新营销投放", () => {
  it("MTC-TASK-COMPLETE：真实任务成功完成后立即拉取活动", async function () {
    this.timeout(120_000);
    await fetch(`${origin()}/__e2e/marketing/reset`, {
      method: "POST",
      body: JSON.stringify({ popup: false, banner: false }),
    });
    await browser.reloadSession();
    // 隔离账号可能首次进入引导；通过公开 Esc 行为关闭，不改写账号记录。
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
        (await $('[data-testid^="v4-session-pane-"]').isDisplayed()),
      { timeout: 30000 },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
    try {
      await waitForDefaultWorkspaceReady(30000);
    } catch (error) {
      throw new Error(
        `Workspace initialization failed: ${await browser.execute(() => document.body.innerText)}`,
        { cause: error },
      );
    }
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_MARKETING_TASK_COMPLETE: Reply exactly E2E_MARKETING_TASK_DONE.");
    await waitForV4ConversationState((s) => s.runtimeStatus === "streaming", "任务未进入 running");
    // 重新计时以排除 30 秒定时刷新：基线之后的完成断言必须在 15 秒内结束。
    const before = await queryCount();
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await browser.waitUntil(async () => (await queryCount()) > before, { timeout: 5000 });
    const baseline = await queryCount();
    const started = Date.now();
    await waitForV4AssistantMessageContaining("E2E_MARKETING_TASK_DONE");
    await browser.waitUntil(async () => (await queryCount()) > baseline, {
      timeout: 8000,
      timeoutMsg: "任务成功完成后未重新请求活动接口",
    });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

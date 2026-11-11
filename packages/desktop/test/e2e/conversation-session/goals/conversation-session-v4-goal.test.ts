// M4 门禁：sendGoalCommand（v4 composer slash `/goal <目标>`）。
// 证据层 L3：建立 session → composer `/goal E2E_V4_GOAL_OBJECTIVE …` → handleSlashCommand →
// dispatchCommand("sendGoalCommand") → v4-bridge goalSession(set) → TargetChanged 事件 →
// reducer 更新 goal 状态 → unified status-panel shell 投影 objective + active。
// 证明 goal slash 入口 + goal 状态投影 + 摘要 timer/pause/resume UI 全链路。
import { TID_CHAT_SUMMARY_PANEL, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { selectUpstreamThoughtLevelValue } from "#e2e/helpers/upstream-provider";
import {
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import {
  clickV4Send,
  getV4GoalProjection,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：sendGoalCommand（/goal slash）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → /goal → status panel 投影 → 独立 pause/resume", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_GOAL_SEED 建立会话");
    await waitForV4TimelineContaining("V4_GOAL_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // composer 设目标（objective 含 fixture 匹配 sentinel）
    // 合并恢复：/goal 和普通发送应消费同一份提交档位，而不是重新读取或使用旧会话档位。
    await selectUpstreamThoughtLevelValue("low");
    await setInputValueByTestIdDom(
      TID_V4_COMPOSER_INPUT,
      "/goal E2E_V4_GOAL_OBJECTIVE 完成竖切目标",
      { timeout: 15000, timeoutMsg: "composer 输入框没有出现" },
    );
    await clickV4Send();

    // goal 横幅出现，objective 含 sentinel，状态为 active（continuation 慢流保持窗口）
    await browser.waitUntil(
      async () => {
        const banner = await getV4GoalProjection();
        return banner !== null && (banner.objective ?? "").includes("E2E_V4_GOAL_OBJECTIVE");
      },
      {
        timeout: 45000,
        timeoutMsg: "goal 状态面板投影没有出现或 objective 不含 sentinel",
      },
    );
    const banner = await getV4GoalProjection();
    expect(banner?.objective).toContain("E2E_V4_GOAL_OBJECTIVE");
    expect(["active", "verifying"]).toContain(banner?.status);
    const goalRequest = await waitForUpstreamNetworkRequestStarted("E2E_V4_GOAL_OBJECTIVE");
    assertUpstreamThoughtLevelCapture(goalRequest, "low");

    // Bug 原因：状态面板在窄窗口会自动收成 mini 胶囊，折叠态只提供展开入口，
    // 不渲染 pause/resume。旧用例直接找 pause，把合法的响应式布局误报成投影失败。
    await browser.waitUntil(
      async () =>
        browser.execute((panelTestId) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          if (!panel) return false;
          if (panel.dataset.state === "collapsed") {
            panel.querySelector<HTMLButtonElement>("button")?.click();
            return false;
          }
          return panel.dataset.state === "expanded";
        }, TID_CHAT_SUMMARY_PANEL),
      { timeout: 15000, timeoutMsg: "goal 状态面板没有展开" },
    );

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = document.querySelector<HTMLButtonElement>('[data-goal-action="pause"]');
          return Boolean(button && !button.disabled);
        }),
      { timeout: 15000, timeoutMsg: "active goal 没有可用的 pauseGoal 按钮" },
    );
    const activeElapsed = await browser.execute(() => {
      const metric = document.querySelector<HTMLElement>("[data-goal-elapsed-seconds]");
      return Number(metric?.getAttribute("data-goal-elapsed-seconds") ?? -1);
    });
    expect(activeElapsed).toBeGreaterThanOrEqual(0);
    const paused = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-goal-action="pause"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    expect(paused).toBe(true);
    await browser.waitUntil(async () => (await getV4GoalProjection())?.status === "paused", {
      timeout: 15000,
      timeoutMsg: "pauseGoal 后目标没有进入 paused",
    });

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = document.querySelector<HTMLButtonElement>('[data-goal-action="resume"]');
          return Boolean(button && !button.disabled);
        }),
      {
        timeout: 15000,
        timeoutMsg: "paused goal 没有可用的三角 resumeGoal 按钮",
      },
    );
    const resumed = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-goal-action="resume"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    expect(resumed).toBe(true);
    await browser.waitUntil(
      async () => {
        const status = (await getV4GoalProjection())?.status;
        return status === "active" || status === "verifying" || status === "verified";
      },
      { timeout: 45000, timeoutMsg: "resumeGoal 后目标没有恢复或完成" },
    );
  });
});

import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { join } from "node:path";
import { selectTaskById } from "#e2e/helpers/conversation-session";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  prepareV4ConversationE2E,
  editFirstV4UserQuery,
  waitForV4Edit,
  waitForV4ConversationState,
  getV4PaneSnapshot,
  getV4Messages,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const trigger = '[data-status-capsule="activity"]';
const panel = '[data-status-capsule-content="activity"]';

// ACT02/05/06：真实并行 child，经 UI 精确停止一项，另一项受控完成。
describe("Activity Subagent retention candidate", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("保留停止和完成结果，下一轮切换历史入口", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    const marker = "E2E_CAPSULE_FOREGROUND_STOP";
    await sendV4PromptAndWaitAccepted(marker, marker, "首发未接纳");
    await $(trigger).waitForDisplayed({ timeout: 90000 });
    await $(trigger).click();
    await browser.waitUntil(
      async () => (await $$(`${panel} [data-testid="v4-running-subagent-stop"]`).length) === 2,
      { timeout: 90000, timeoutMsg: "两个真实 child 未进入可停止状态" },
    );
    await browser.waitUntil(
      async () => (await $(panel).getText()).includes("Stop target foreground child"),
      { timeout: 15000, timeoutMsg: "活动面板动画后标题不可见" },
    );
    const agents = await $$(`${panel} [data-background-task-kind="agent"]`);
    let stopped = false;
    for (const agent of agents) {
      if ((await agent.getText()).includes("Stop target foreground child")) {
        await agent.$('[data-testid="v4-running-subagent-stop"]').click();
        stopped = true;
        break;
      }
    }
    expect(stopped).toBe(true);
    await $(`${panel} [data-activity-result="stopped"]`).waitForDisplayed({ timeout: 60000 });
    expect((await $$(`${panel} [data-testid="v4-running-subagent-stop"]`)).length).toBe(1);
    await releaseControlledReplay("capsule-foreground-keep-controlled");
    await waitForV4AssistantMessageContaining("E2E_CAPSULE_PARENT_DONE", 90000);
    await $(`${panel} [data-activity-result="completed"]`).waitForDisplayed({ timeout: 30000 });
    expect((await $$(`${panel} [data-activity-result]`)).length).toBe(2);
    expect((await $$(`${panel} [data-testid="v4-running-subagent-stop"]`)).length).toBe(0);
    expect(await $(trigger).getText()).toMatch(/Completed|已完成/);
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("1");
    expect(await $('[data-testid="activity-subagent-directory"]').isExisting()).toBe(false);
    const completedId = await $(`${panel} [data-activity-result="completed"]`)
      .parentElement()
      .getAttribute("data-activity-id");
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "activity-subagents-ended.png"),
    );
    await browser.keys("Escape");
    await $(trigger).click();
    await $(`${panel} [data-activity-id="${completedId}"] button`).click();
    await $(`[data-session-id="${completedId!.slice("agent:".length)}"]`).waitForDisplayed({
      timeout: 30000,
    });
    await browser.keys("Escape");
    await selectTaskById(sessionId);
    const next = "E2E_ACTIVITY_SUBAGENT_CLEAR";
    await sendV4PromptAndWaitAccepted(next, next, "后续输入未接纳");
    await $(trigger).waitForDisplayed({ timeout: 30000 });
    await $(trigger).click();
    await $('[data-testid="activity-subagent-directory"]').waitForDisplayed({ timeout: 30000 });
    expect((await $$(`${panel} [data-activity-result]`)).length).toBe(0);
    expect(await $(trigger).getText()).toMatch(/Completed|已完成/);
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("1");
    await browser.keys("Escape");
    await waitForV4AssistantMessageContaining("E2E_ACTIVITY_SUBAGENT_CLEARED", 60000);
    const clearedCount = (await getV4Messages()).filter(
      (row) => row.role === "assistant" && row.text.includes("E2E_ACTIVITY_SUBAGENT_CLEARED"),
    ).length;
    await sendV4PromptAndWaitAccepted(
      "E2E_ACTIVITY_SUBAGENT_CLEAR_AGAIN",
      "E2E_ACTIVITY_SUBAGENT_CLEAR_AGAIN",
      "第二次普通输入未接纳",
    );
    await browser.waitUntil(
      async () =>
        (await getV4Messages()).filter(
          (row) => row.role === "assistant" && row.text.includes("E2E_ACTIVITY_SUBAGENT_CLEARED"),
        ).length > clearedCount,
      { timeout: 60000, timeoutMsg: "第二次普通输入尚未完成" },
    );
    await $(trigger).waitForDisplayed({ timeout: 10000 });
    await sendV4PromptAndWaitAccepted(
      "E2E_ACTIVITY_RESUME_START",
      "E2E_ACTIVITY_RESUME_START",
      "恢复消息未接纳",
    );
    await $(trigger).waitForDisplayed({ timeout: 60000 });
    await $(trigger).click();
    const resumed = $(
      `${panel} [data-activity-id="${completedId}"] [data-activity-result="completed"]`,
    );
    await $(
      `${panel} [data-activity-id="${completedId}"] [data-testid="v4-running-subagent-stop"]`,
    ).waitForDisplayed({ timeout: 60000 });
    await releaseControlledReplay("activity-resume-child");
    await resumed.waitForDisplayed({ timeout: 60000 });
    await waitForUpstreamRequest(
      { includes: ["E2E_ACTIVITY_RESUME_NEW_RESULT", "<task-notification>"] },
      "同一 child 新执行没有交付真实结果",
      60000,
    );
    await browser.keys("Escape");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectTaskById(sessionId);
    await $(trigger).waitForDisplayed({ timeout: 60000 });
    await $(trigger).click();
    await $(
      `${panel} [data-activity-id="${completedId}"] [data-activity-result="completed"]`,
    ).waitForDisplayed({ timeout: 30000 });
    await browser.keys("Escape");
    await sendV4PromptAndWaitAccepted(
      "E2E_ACTIVITY_SUBAGENT_CLEAR2",
      "E2E_ACTIVITY_SUBAGENT_CLEAR2",
      "重启后清除消息未接纳",
    );
    await $(trigger).waitForDisplayed({ timeout: 30000 });
    await waitForV4AssistantMessageContaining("E2E_ACTIVITY_SUBAGENT_CLEARED", 60000);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectTaskById(sessionId);
    await browser.waitUntil(
      async () =>
        (await getV4Messages("user")).some((row) =>
          row.text.includes("E2E_ACTIVITY_SUBAGENT_CLEAR2"),
        ),
      { timeout: 30000, timeoutMsg: "重启后历史未恢复" },
    );
    expect(await $(trigger).isExisting()).toBe(true);
    // 回退不能因为旧 child 没有本轮行就清除其完整成功贡献。
    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_ACTIVITY_REWIND_EDITED");
    // 旧 marker 可在更早轮次中存在，必须等待本轮独立响应及实际结算。
    await waitForV4AssistantMessageContaining("E2E_ACTIVITY_REWIND_RUNNING", 60000);
    const heldMessages = await getV4Messages("assistant");
    expect(heldMessages.some((row) => row.text.includes("E2E_ACTIVITY_SUBAGENT_CLEARED"))).toBe(
      true,
    );
    expect(heldMessages.some((row) => row.text.includes("E2E_ACTIVITY_REWIND_DONE"))).toBe(false);
    await releaseControlledReplay("activity-rewind-edit-controlled");
    await waitForV4AssistantMessageContaining("E2E_ACTIVITY_REWIND_DONE", 60000);
    await waitForV4ConversationState(
      (state) => state.state !== "streaming",
      "编辑响应未结算",
      60000,
    );
    await browser.waitUntil(
      async () =>
        (await getV4Messages("user")).some((row) =>
          row.text.includes("E2E_ACTIVITY_REWIND_EDITED"),
        ),
      { timeout: 30000, timeoutMsg: "编辑未生效" },
    );
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("1");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectTaskById(sessionId);
    await $(trigger).waitForDisplayed({ timeout: 60000 });
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("1");
  });
});

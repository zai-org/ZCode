import { openStatusCapsule } from "#e2e/helpers/status-capsule";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
const trigger = '[data-status-capsule="activity"]';
const panel = '[data-status-capsule-content="activity"]';

// ACT03/06：沿用服务端 always-on 夹具，实际编译、批准并运行两阶段三 Agent 工作流。
describe("Activity Workflow retention candidate", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("Workflow 内部 Agent 不重复计数，完成保留，下一轮切换历史入口", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await sendV4PromptAndWaitAccepted("E2E_DWR_START", "E2E_DWR_START", "工作流输入未接纳");
    await waitForV4PermissionDialog();
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwr_create"))?.isError === false,
      { timeout: 90000, timeoutMsg: "真实工作流启动失败" },
    );
    const result = await getLatestUpstreamToolResultByToolCallId("toolu_dwr_create");
    const runId = /started in the background with ID: (\S+?)\./.exec(result?.content ?? "")?.[1];
    expect(runId).toBeTruthy();
    await $(trigger).waitForDisplayed({ timeout: 60000 });
    await $(trigger).click();
    const item = `${panel} [data-activity-id="workflow:${runId}"]`;
    await $(item).waitForDisplayed({ timeout: 60000 });
    expect((await $$(`${panel} [data-activity-id]`)).length).toBe(1);
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("1");
    await browser.keys("Escape");
    await waitForV4AssistantMessageContaining("E2E_DWR_STARTED", 60000);
    await sendV4PromptAndWaitAccepted(
      "E2E_ACTIVITY_MIXED_START",
      "E2E_ACTIVITY_MIXED_START",
      "混合活动输入未接纳",
    );
    await $(trigger).click();
    await browser.waitUntil(async () => (await $$(`${panel} [data-activity-id]`).length) === 3, {
      timeout: 60000,
      timeoutMsg: "三类顶层活动未同时展示",
    });
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("3");
    await $(
      `${panel} [data-background-task-kind="bash"] [data-testid^="v4-background-work-cancel-"]`,
    ).click();
    await $(`${panel} [data-activity-result="stopped"]`).waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await $(`${trigger} [data-status-capsule-secondary]`).getText()) === "2",
      { timeout: 30000, timeoutMsg: "终端停止后计数未减一" },
    );
    await releaseControlledReplay("activity-mixed-child");
    await $(
      `${panel} [data-activity-id^="agent:"] [data-activity-result="completed"]`,
    ).waitForDisplayed({ timeout: 60000 });
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("1");
    const order = await browser.execute(
      (selector) =>
        Array.from(document.querySelectorAll(`${selector} [data-activity-id]`)).map((el) =>
          el.getAttribute("data-activity-id"),
        ),
      panel,
    );
    expect(order[0]).toBe(`workflow:${runId}`);
    // 下一轮收起已结束的 child/终端；仍运行的 Workflow 完成后不能遮掉子智能体目录。
    await browser.keys("Escape");
    await sendV4PromptAndWaitAccepted(
      "E2E_ACTIVITY_WORKFLOW_CLEAR",
      "E2E_ACTIVITY_WORKFLOW_CLEAR",
      "历史与本轮混合输入未接纳",
    );
    await openStatusCapsule("activity");
    await $('[data-testid="activity-subagent-directory"]').waitForDisplayed({ timeout: 30000 });
    expect(await $('[data-testid="activity-workflow-directory"]').isExisting()).toBe(false);
    await releaseControlledReplay("dwr-agent-c");

    await $(`${item} [data-activity-result="completed"]`).waitForDisplayed({ timeout: 30000 });
    expect(await $$(`${panel} [data-activity-id]`).length).toBe(1);
    // 一个 Workflow 加一个独立 child 成功；内部 actor 不重复计数。
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("2");
    expect(await $(trigger).getText()).toMatch(/Completed|已完成/);
    expect(await $(trigger).isDisplayed()).toBe(true);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "activity-mixed-ended.png"),
    );
    await $('[data-testid="activity-subagent-directory"]').waitForDisplayed({ timeout: 30000 });
    expect(await $('[data-testid="activity-workflow-directory"]').isExisting()).toBe(false);
    await openStatusCapsule("activity");
    await $(`${item} [data-activity-result] button`).click();
    await $(`div.flex.h-full[data-workflow-run-id="${runId}"]`).waitForDisplayed({
      timeout: 30000,
    });
    await browser.keys("Escape");
    await sendV4PromptAndWaitAccepted(
      "E2E_ACTIVITY_WORKFLOW_CLEAR",
      "E2E_ACTIVITY_WORKFLOW_CLEAR",
      "清除输入未接纳",
    );
    await $(trigger).waitForDisplayed({ timeout: 30000 });
    await $(trigger).click();
    await $('[data-testid="activity-workflow-directory"]').waitForDisplayed({ timeout: 30000 });
    expect(
      (await $$('[data-status-capsule-content="activity"] [data-activity-result]')).length,
    ).toBe(0);
    expect(await $(trigger).getText()).toMatch(/Completed|已完成/);
    expect(await $(`${trigger} [data-status-capsule-secondary]`).getText()).toBe("2");
    // 目录是现有真实侧栏路由；两种历史入口须可达并复用同会话标签。
    for (const kind of ["subagent", "workflow"] as const) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await openStatusCapsule("activity");
        await $(`[data-testid="activity-${kind}-directory"]`).waitForDisplayed({ timeout: 30000 });
        await $(`[data-testid="activity-${kind}-directory"]`).click();
        await $(`[data-side-pane-tab-id^="${kind}-directory:"]`).waitForDisplayed({
          timeout: 30000,
        });
        expect(await $$(`[data-side-pane-tab-id^="${kind}-directory:"]`).length).toBe(1);
      }
    }
  });
});

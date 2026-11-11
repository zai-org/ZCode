import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  waitForV4Pane,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";

// 留白（docs/dynamic-workflow/presentation.md「Holes on the timeline」、docs/dynamic-workflow/launch.md
// 「The `FillWorkflowHole` tool」、docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）
// 的三条桌面链路：run 卡上的留白站与等待态、通知行的三态、补全之后卡与侧板长出新的站。
//
// case-local 回放只决定模型调用；真实 Skill、工作流编译、审批、留白通知与补全仍走产品链路。
// 第一处留白的等待态检查完成后，再发送真实补全指令，避免自动回复抢先消除待验证的 UI 状态。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
// 留白 id 是名字的键（apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md「Sites」）：「决定分组」→ 这个 id。
const DECIDE_HOLE_ID = "hole#21b40fca";

describe("动态工作流 · 留白", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWH-01 卡上画出留白站，run 到达时变成等待态并长出「1 处留白待补全」", async function () {
    this.timeout(240000);
    await sendV4Prompt("E2E_DWH_START 使用工作流演示留白：先等待决定分组，再等待评判。");
    await approveV4Permission();
    // 原因：工作流使用专属摘要，不再渲染通用 ToolCallBlock；真实工具结果确认创建成功。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwh_create"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const digest = await $(RUN_DIGEST);
    await digest.waitForDisplayed({ timeout: 120000 });

    // 留白站：虚线灯 + 名字（类型不上界面）；触到它的轨道段是虚线；尾巴留白之后有 40px 残段。
    const holeStation = await digest.$(
      '[data-testid="workflow-timeline-station"][data-station-hole]',
    );
    await holeStation.waitForDisplayed({ timeout: 60000 });
    expect(await holeStation.getText()).toContain("决定分组");
    expect(await holeStation.getText()).not.toContain("Plan");
    await expect(
      digest.$('[data-testid="workflow-timeline-rail"][data-rail-dashed="true"]'),
    ).toBeExisting();
    await expect(digest.$('[data-testid="workflow-timeline-tail-stub"]')).toBeExisting();

    // 到达：灯换警示色描边、元数据写「等待补全」、表头长出笔芯片；灯不搏动。
    await browser.waitUntil(
      async () => (await holeStation.getAttribute("data-station-hole")) === "waiting",
      { timeout: 120000, timeoutMsg: "run 没有停在留白上" },
    );
    await expect(holeStation.$('[data-testid="workflow-hole-waiting"]')).toBeDisplayed();
    await expect(holeStation.$(".wf-lamp-hole-waiting")).toBeExisting();
    await expect(holeStation.$(".wf-lamp-running")).not.toBeExisting();
    const chip = await digest.$('[data-testid="workflow-digest-holes"]');
    await chip.waitForDisplayed({ timeout: 30000 });
    expect(await chip.getText()).toContain("1 处留白待补全");
    // 开着的留白是主代理车道上的一步，不是子代理：含 `hole()` 调用的那一站不多出「未命名子代理」。
    for (const pill of await digest.$$('[data-testid="workflow-agent-pill"]')) {
      expect(await pill.getText()).not.toContain("未命名子代理");
    }
  });

  it("DWH-02 通知行：笔图标、「工作流留白 · 等待补全」，展开体有提示、位置、草稿路径与等待时长", async function () {
    this.timeout(120000);
    const row = await $(
      '[data-testid^="chat-workflow-notification-row-"][data-hole-state="waiting"]',
    );
    await row.waitForDisplayed({ timeout: 120000 });
    expect(await row.getText()).toContain("工作流留白 · 等待补全");
    expect(await row.$('[data-testid="workflow-hole-notification-name"]').getText()).toBe(
      "决定分组",
    );
    await row.$('[role="button"]').click();
    const body = await row.$('[data-testid="workflow-hole-notification-body"]');
    await body.waitForDisplayed({ timeout: 10000 });
    await expect(body).toHaveText(expect.stringContaining("补全须返回 Plan"));
    await expect(body.$('[data-testid="workflow-hole-notification-draft"]')).toBeExisting();
    await expect(body.$('[data-testid="workflow-hole-notification-waited"]')).toBeExisting();
  });

  it("DWH-03 补全接进 run：补全行说「留白已补全」，卡长出头与新站，通知行翻成「留白已补全」", async function () {
    this.timeout(240000);
    await waitForV4Pane((pane) => !pane.canStop, "留白通知回复未结束", 30000);
    // 两秒新鲜态是视觉瞬态；在真实操作前观察 DOM，不靠加延时或抢时序截图。
    await browser.execute(() => {
      const probe = window as Window & { __dwhFreshSeen?: boolean };
      probe.__dwhFreshSeen = false;
      const observer = new MutationObserver(() => {
        if (
          document.querySelector(
            '[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]',
          )
        ) {
          probe.__dwhFreshSeen = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-fill-fresh"],
      });
    });
    await sendV4Prompt("E2E_DWH_FILL_NOW 补全决定分组，加入收集和分组两个阶段，继续等评判。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwh_fill"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "FillWorkflowHole 未执行成功" },
    );
    await waitForV4AssistantMessageContaining("补全", 180000);
    const fillRowSelector =
      '[data-testid="workflow-tool-summary"][data-tool-call-id]:has([data-testid="workflow-summary-hole-name"])';
    const fillRow = await $(fillRowSelector);
    // 回复文字出现时这一轮可能已结束，补全行随之收进「已处理」折叠、不在 DOM 中：先展开再等它。
    // 折叠原地收起的动画里行还在 DOM（见 helpers/v4-history-folds.ts），收起中的行不算出现。
    await browser.waitUntil(
      async () => {
        await openClosedHistoryFolds();
        if (!(await isOutsideClosedHistory(fillRowSelector))) return false;
        // 折叠展开的动画里行已算显示、文字还读不到，所以等到文字才算出现。
        return (await fillRow.isDisplayed()) && (await fillRow.getText()).includes("留白已补全");
      },
      { timeout: 60000, timeoutMsg: "补全行没有写出「留白已补全」" },
    );
    expect(await fillRow.$('[data-testid="workflow-summary-hole-phases"]').getText()).toContain(
      "个阶段",
    );

    const digest = await $(RUN_DIGEST);
    const head = await digest.$('[data-testid="workflow-timeline-fill-head"]');
    await head.waitForDisplayed({ timeout: 60000 });
    expect(await head.getText()).toContain("决定分组");
    // 刚接进 run 的两秒里框自己画一遍（警示色的一笔）；之后只在指针落在头上时画出。
    expect(
      await browser.execute(() => (window as Window & { __dwhFreshSeen?: boolean }).__dwhFreshSeen),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        !(await digest
          .$('[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]')
          .isExisting()),
      { timeout: 10000, timeoutMsg: "框的新鲜态没有在两秒后退去" },
    );
    // 站不点亮任何东西：指针落在补全写下的站上，框不画。
    await (
      await digest.$(`[data-testid="workflow-timeline-station"][data-fill="${DECIDE_HOLE_ID}"]`)
    ).moveTo();
    await expect(
      digest.$('[data-testid="workflow-timeline-fill-frame"][data-fill-on="true"]'),
    ).not.toBeExisting();
    // 头点亮它自己的框，而且只有这一个。
    await head.moveTo();
    await expect(
      digest.$(
        `[data-testid="workflow-timeline-fill-frame"][data-fill-frame="${DECIDE_HOLE_ID}"][data-fill-on="true"]`,
      ),
    ).toBeExisting();
    expect(
      await digest.$$('[data-testid="workflow-timeline-fill-frame"][data-fill-on="true"]'),
    ).toHaveLength(1);
    // 第一处已补全，run 立即到达第二处；仍有一处待补全，不能要求全局芯片消失。
    await expect(digest.$('[data-testid="workflow-digest-holes"]')).toHaveText(
      expect.stringContaining("1 处留白待补全"),
    );
    await expect(
      digest.$('[data-testid="workflow-timeline-station"][data-station-hole="waiting"]'),
    ).toHaveText(expect.stringContaining("评判"));

    const row = await $(
      '[data-testid^="chat-workflow-notification-row-"][data-hole-state="filled"]',
    );
    await row.waitForDisplayed({ timeout: 60000 });
    expect(await row.getText()).toContain("留白已补全");
  });

  it("DWH-04 侧板：留白节头、等待体，补全后的标题行（它是框的头）与不缩进的补全节；侧栏运行行写「评判 · 等待补全」", async function () {
    this.timeout(120000);
    const digest = await $(RUN_DIGEST);
    await (await digest.$('[data-testid="workflow-timeline-fill-head"]')).click();
    const heading = await $('[data-testid="workflow-run-fill-heading"]');
    await heading.waitForDisplayed({ timeout: 60000 });
    expect(await heading.getText()).toContain("决定分组");
    await expect(
      $(`[data-testid="workflow-run-phase"][data-phase-fill="${DECIDE_HOLE_ID}"]`),
    ).toBeExisting();
    // 标题行是这次补全的头：指针落上去，侧板画出同一个框（竖着）。
    await heading.moveTo();
    await expect(
      $(
        `[data-testid="workflow-run-fill-frame"][data-fill-frame="${DECIDE_HOLE_ID}"][data-fill-on="true"]`,
      ),
    ).toBeExisting();
    // 还开着的尾巴留白在侧板里是虚线灯 + 名字；类型不上界面。
    const tail = await $('[data-testid="workflow-run-phase"][data-phase-hole="waiting"]');
    await expect(tail).toBeExisting();
    expect(await tail.getText()).toContain("评判");
    expect(await tail.getText()).not.toContain("Verdict");
    // 侧栏运行行：run 停在第二处留白时写「评判 · 等待补全」，迷你轨道的那盏灯是虚线警示色。
    const line = await $('[data-workflow-run-line="true"]');
    await browser.waitUntil(async () => (await line.getText()).includes("等待补全"), {
      timeout: 120000,
      timeoutMsg: "侧栏运行行没有写「等待补全」",
    });
    await expect(line.$('[data-rail-hole="waiting"]')).toBeExisting();
    await expect($('[data-testid="workflow-run-hole-waiting"]')).toBeExisting();
    // 等待体里画主代理收到的提示语（run 状态 holes[].prompt，来自 hole-reached）。
    await expect($('[data-testid="workflow-run-hole-prompt"]')).toBeExisting();
    await expect($('[data-testid="workflow-run-holes"]')).toBeExisting();
  });
});

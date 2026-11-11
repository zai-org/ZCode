import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  hasV4PermissionDialog,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";

// run 与别的会话（docs/dynamic-workflow/launch.md「Amending this session's runs」、`FillWorkflowHole` 的
// 「Approval」、docs/dynamic-workflow/presentation.md「The sidebar run line」、
// docs/dynamic-workflow/transcript-and-notifications.md）：
// run 属于发起它的会话；切到别的会话时它照常前进，通知只叫醒它自己的会话，
// 而别的会话动它（补全、修订）要经过确认窗。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定模型调用；会话切换、run 引擎、所属会话判定、确认窗与通知投递走产品链路。
// 两个子代理的回答用受控流挂起，由用例在切到别的会话之后释放，不靠延时抢时序。
const RUN_NAME = "E2E 跨会话调研";
const HOLE_RUN_NAME = "E2E 跨会话留白";
const COMPLETION_CARD = '[data-workflow-completion-card="true"]';
const NOTIFICATION_ROW = '[data-testid^="chat-workflow-notification-row-"]';
const digestOf = (runId: string) =>
  $(`[data-workflow-run-digest="true"][data-workflow-run-id="${runId}"]`);
const runLineOf = (sessionId: string) =>
  $(`[data-testid="task-item-${sessionId}"] [data-workflow-run-line="true"]`);

let sessionA = "";
let sessionB = "";
let sessionHoleOwner = "";
let runId = "";
let holeRunId = "";

// 回放的 `{{latestWorkflowRunId}}` 只读当前请求里的留白通知形状。模型从 `ListWorkflowRuns` 或用户那里
// 拿到别的会话的 run id 都一样：这里由用户消息带上真实 id，所属会话的判定仍由产品读 run 的记录。
const carryRunId = (id: string) => `<workflow-hole><run-id>${id}</run-id></workflow-hole>`;

async function readSessionId(): Promise<string> {
  const { sessionId } = await getV4PaneSnapshot();
  if (!sessionId) throw new Error("主 pane 没有打开会话");
  return sessionId;
}

async function startSessionAndWaitForReply(prompt: string, reply: string): Promise<string> {
  await startNewV4Draft();
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(reply, 60000);
  await waitForV4Pane((pane) => pane.sessionId !== "draft" && !pane.canStop, "新会话没有结束回复");
  return readSessionId();
}

async function readStationStatuses(id: string): Promise<string[]> {
  const stations = await digestOf(id).$$('[data-testid="workflow-timeline-station"]');
  const statuses: string[] = [];
  for (const station of stations) {
    statuses.push((await station.getAttribute("data-station-status")) ?? "");
  }
  return statuses;
}

async function readPillStatuses(id: string): Promise<Record<string, string>> {
  const statuses: Record<string, string> = {};
  for (const pill of await digestOf(id).$$('[data-testid="workflow-agent-pill"]')) {
    // 失败原因：a6fb6916a8 给完成的子代理 pill 加了 sr-only 的「已完成」文字，整颗 pill 的
    // 文本变成「名字+状态」。名字只读 `.wf-pill-name`，状态仍读 data-agent-status。
    const name = (await pill.$(".wf-pill-name").getText()).trim();
    statuses[name] = (await pill.getAttribute("data-agent-status")) ?? "";
  }
  return statuses;
}

async function waitForRunLineText(sessionId: string, text: string, timeoutMsg: string) {
  await browser.waitUntil(
    async () => {
      const line = runLineOf(sessionId);
      return (await line.isExisting()) && (await line.getText()).includes(text);
    },
    { timeout: 120000, timeoutMsg },
  );
}

const readPermissionWindowText = () =>
  browser.execute(() => {
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (element) =>
        ["Permission required", "需要权限"].includes(element.getAttribute("aria-label") ?? ""),
    );
    return listbox?.closest<HTMLElement>(".bg-popover")?.innerText ?? "";
  });

async function waitForToolResult(toolCallId: string) {
  await browser.waitUntil(
    async () => Boolean(await getLatestUpstreamToolResultByToolCallId(toolCallId)),
    { timeout: 60000, timeoutMsg: `${toolCallId} 没有结果回到模型` },
  );
  return (await getLatestUpstreamToolResultByToolCallId(toolCallId))!;
}

describe("动态工作流 · run 与别的会话", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWW-01 切到别的会话时 run 照常前进：A 的侧栏运行行跟上阶段，B 没有运行行；切回 A，run 卡已跟上进度", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWW_A_START 用工作流调研材料并汇总。");
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dww_create"))?.isError === false,
      { timeout: 60000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const toolResult = await getLatestUpstreamToolResultByToolCallId("toolu_dww_create");
    const launched = /started in the background with ID: (\S+?)\./.exec(toolResult?.content ?? "");
    expect(launched).not.toBeNull();
    runId = launched![1]!;
    await waitForV4AssistantMessageContaining("E2E_DWW_A_STARTED", 60000);
    await waitForV4Pane((pane) => !pane.canStop, "A 会话的启动回复没有结束");
    sessionA = await readSessionId();

    // 第一阶段的子代理被挂起：run 停在「调研」。
    await digestOf(runId).waitForDisplayed({ timeout: 120000 });
    await browser.waitUntil(async () => (await readPillStatuses(runId))["调研员"] === "running", {
      timeout: 120000,
      timeoutMsg: "调研员没有进入运行态",
    });
    await waitForRunLineText(sessionA, "调研", "A 的侧栏运行行没有写出当前阶段「调研」");

    // 切到 B：这边没有 run，A 的运行行还在（live run 总是画出，不管会话是否打开）。
    sessionB = await startSessionAndWaitForReply(
      "E2E_DWW_B_HELLO 这个会话和工作流无关。",
      "E2E_DWW_B_REPLY",
    );
    expect(sessionB).not.toBe(sessionA);
    await expect(digestOf(runId)).not.toBeDisplayed();
    await expect(runLineOf(sessionB)).not.toBeExisting();
    await waitForRunLineText(sessionA, "调研", "切到 B 之后 A 的运行行丢了");

    // B 在前台时放行第一阶段：侧栏的数据来自索引，A 没打开也要跟上「汇总」。
    await releaseControlledReplay("dww-agent-a");
    await waitForRunLineText(sessionA, "汇总", "A 不在前台时侧栏运行行没有跟上「汇总」");
    expect(await runLineOf(sessionA).getAttribute("data-run-status")).toBe("running");
    await expect(runLineOf(sessionB)).not.toBeExisting();

    // 切回 A：卡直接是离开期间的最新进度，不是离开前的样子。
    await selectV4TaskById(sessionA);
    await digestOf(runId).waitForDisplayed({ timeout: 60000 });
    await browser.waitUntil(
      async () => {
        const pills = await readPillStatuses(runId);
        return pills["调研员"] === "done" && pills["汇总员"] === "running";
      },
      { timeout: 60000, timeoutMsg: "切回 A 后 run 卡没有跟上离开期间的进度" },
    );
    expect(await readStationStatuses(runId)).toEqual(["done", "running"]);
    expect(await digestOf(runId).getAttribute("data-workflow-run-status")).toBe("running");
    await waitForRunLineText(sessionA, "汇总", "切回 A 后侧栏运行行不再写「汇总」");
  });

  it("DWW-02 run 在 B 在前台时结束：只有 A 的模型被叫醒，B 的请求里没有它；A 的运行行写「已完成」留到打开 A，打开后折叠并看到通知行与完成卡", async function () {
    this.timeout(300000);
    await selectV4TaskById(sessionB);
    await releaseControlledReplay("dww-agent-c");

    // 已结束且未确认：运行行换成中性词，一直留到会话被打开（presentation.md「Acknowledgement」）。
    await waitForRunLineText(sessionA, "已完成", "A 的运行行没有写「已完成」");
    expect(await runLineOf(sessionA).getAttribute("data-run-status")).toBe("completed");

    // 只叫醒 A：完成通知是 A 会话的一个请求，带 A 的历史。
    await browser.waitUntil(
      async () => {
        const [wake] = await getUpstreamRequestEvidence({
          includes: [`<description>${RUN_NAME}</description>`],
          lastUserMessageIncludes: ["<task-notification>"],
        });
        return wake?.statusCode === 200;
      },
      { timeout: 120000, timeoutMsg: "A 的模型没有收到完成通知" },
    );
    const wakes = await getUpstreamRequestEvidence({
      includes: [`<description>${RUN_NAME}</description>`],
      lastUserMessageIncludes: ["<task-notification>"],
    });
    expect(wakes.map((wake) => wake.fixtureId)).toEqual(["dww-notified"]);
    const wakeBody = JSON.stringify(wakes[0]?.requestJson);
    expect(wakeBody).toContain("E2E_DWW_A_START");
    expect(wakeBody).not.toContain("E2E_DWW_B_HELLO");

    // B 这边什么都没发生：前台没有通知行、没有完成卡，也没有被叫醒的轮次。
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionB);
    await expect($(NOTIFICATION_ROW)).not.toBeDisplayed();
    await expect($(COMPLETION_CARD)).not.toBeDisplayed();
    await expect(runLineOf(sessionB)).not.toBeExisting();

    // B 的下一轮请求是证据：通知若误投给 B，会出现在这一轮的历史里。
    await sendV4Prompt("E2E_DWW_B_AFTER 再说一句。");
    await waitForV4AssistantMessageContaining("E2E_DWW_B_AFTER_REPLY", 60000);
    await waitForV4Pane((pane) => !pane.canStop, "B 会话的回复没有结束");
    const bRequests = await getUpstreamRequestEvidence({ includes: ["E2E_DWW_B_HELLO"] });
    expect(bRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of bRequests) {
      const body = JSON.stringify(request.requestJson);
      expect(body).not.toContain(runId);
      expect(body).not.toContain(RUN_NAME);
    }

    // 打开 A：确认这个 run，运行行收起；通知行与完成卡都在 A 这边。
    await waitForRunLineText(sessionA, "已完成", "B 的轮次之后 A 的运行行不该收起");
    await selectV4TaskById(sessionA);
    await browser.waitUntil(async () => !(await runLineOf(sessionA).isExisting()), {
      timeout: 30000,
      timeoutMsg: "打开 A 之后已结束 run 的运行行没有收起",
    });
    await waitForV4AssistantMessageContaining("E2E_DWW_A_DONE", 60000);
    const row = await $(NOTIFICATION_ROW);
    await row.waitForDisplayed({ timeout: 60000 });
    expect(await row.getText()).toContain("工作流已完成");
    expect(await row.getText()).toContain(RUN_NAME);
    const card = await $(COMPLETION_CARD);
    await card.waitForDisplayed({ timeout: 60000 });
    expect(await (await card.$('[data-testid="workflow-card-name"]').getText()).trim()).toBe(
      RUN_NAME,
    );
    await browser.waitUntil(
      async () =>
        (await card
          .$('[data-testid="workflow-completion-figure-subagents"]')
          .getAttribute("data-value")) === "2" &&
        (await card
          .$('[data-testid="workflow-completion-figure-phases"]')
          .getAttribute("data-value")) === "2",
      { timeout: 10000, timeoutMsg: "完成卡的子代理 / 阶段数字不是 2 / 2" },
    );
  });

  it("DWW-03 B 的模型补全别的会话的留白：引擎在 A 的进程里够不着，不弹窗直接拒绝并说明下一步；窗里也就不会出现裸的站点 id；run 原样停在留白上", async function () {
    this.timeout(300000);
    await startNewV4Draft();
    await sendV4Prompt("E2E_DWW_H_START 使用工作流演示留白。");
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dww_h_create"))?.isError === false,
      { timeout: 60000, timeoutMsg: "留白 run 的 CreateWorkflow 未执行成功" },
    );
    const toolResult = await getLatestUpstreamToolResultByToolCallId("toolu_dww_h_create");
    const launched = /started in the background with ID: (\S+?)\./.exec(toolResult?.content ?? "");
    expect(launched).not.toBeNull();
    holeRunId = launched![1]!;
    await waitForV4AssistantMessageContaining("E2E_DWW_H_WAITING", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "留白通知的回复没有结束");
    sessionHoleOwner = await readSessionId();

    await selectV4TaskById(sessionB);
    await sendV4Prompt(`E2E_DWW_CROSS_FILL 补全这个 run 的留白。${carryRunId(holeRunId)}`);

    // 这里曾先弹窗，用户批准后才被拒（launch.md「Approval」）。
    const refused = await waitForToolResult("toolu_dww_cross_fill");
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("hole_not_waiting");
    expect(refused.content).toContain("the session that started it");
    expect(await hasV4PermissionDialog()).toBe(false);
    await waitForV4Pane((pane) => !pane.canStop, "B 被拒之后 turn 没有收口");
    // 运行行留在 run 自己的会话下，留白还开着。
    await waitForRunLineText(sessionHoleOwner, "决定分组 · 等待补全", "被拒之后 run 不该变化");
    await expect(runLineOf(sessionB)).not.toBeExisting();
  });

  it("DWW-04 B 的模型修订别的会话还在跑的 run：本进程停不了它，不弹窗直接拒绝，不起新 run，run 原样停在留白上", async function () {
    this.timeout(180000);
    await sendV4Prompt(`E2E_DWW_CROSS_AMEND 调整这个 run。${carryRunId(holeRunId)}`);
    const refused = await waitForToolResult("toolu_dww_cross_amend");
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("workflow_run_held_elsewhere");
    expect(await hasV4PermissionDialog()).toBe(false);
    await waitForV4Pane((pane) => !pane.canStop, "B 被拒之后 turn 没有收口");
    await waitForRunLineText(sessionHoleOwner, "决定分组 · 等待补全", "被拒之后 run 不该变化");
    expect(await runLineOf(sessionHoleOwner).getAttribute("data-run-id")).toBe(holeRunId);
    await expect(runLineOf(sessionB)).not.toBeExisting();
  });

  it("DWW-05 回到 run 自己的会话：同一处留白、同样的补全不弹窗直接接进 run；通知行翻成「留白已补全」，完成通知只回到这个会话", async function () {
    this.timeout(240000);
    await selectV4TaskById(sessionHoleOwner);
    await sendV4Prompt("E2E_DWW_H_OWN_FILL 补全决定分组。");
    // 没人点过窗：工具成功返回本身就证明这一步没有确认窗（launch.md「Approval」）。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dww_h_own_fill"))?.isError === false,
      { timeout: 60000, timeoutMsg: "本会话的 FillWorkflowHole 未执行成功（可能在等确认窗）" },
    );
    expect(await hasV4PermissionDialog()).toBe(false);

    await waitForV4AssistantMessageContaining("E2E_DWW_H_DONE", 120000);
    const notices = await getUpstreamRequestEvidence({
      includes: [`<description>${HOLE_RUN_NAME}</description>`],
      lastUserMessageIncludes: ["<task-notification>"],
    });
    expect(notices.map((notice) => notice.fixtureId)).toEqual(["dww-h-notified"]);
    const noticeBody = JSON.stringify(notices[0]?.requestJson);
    expect(noticeBody).toContain("E2E_DWW_H_START");
    expect(noticeBody).not.toContain("E2E_DWW_CROSS_FILL");

    const filledRow = await $(`${NOTIFICATION_ROW}[data-hole-state="filled"]`);
    await filledRow.waitForExist({ timeout: 60000 });
    await browser.waitUntil(
      async () => String(await filledRow.getProperty("textContent")).includes("留白已补全"),
      { timeout: 15000, timeoutMsg: "通知行没有翻成「留白已补全」" },
    );
    await digestOf(holeRunId).waitForExist({ timeout: 60000 });
    expect(await digestOf(holeRunId).getAttribute("data-workflow-run-status")).toBe("completed");
    // run 在会话打开时结束：运行行随即收起。
    await browser.waitUntil(async () => !(await runLineOf(sessionHoleOwner).isExisting()), {
      timeout: 30000,
      timeoutMsg: "会话在前台时完成的 run 仍在侧栏留着运行行",
    });
  });

  it("DWW-06 B 的模型修订别的会话已结束的 run：弹「调整此工作流？」，批准后新 run 在 B 名下跑完，沿用 run 名，通知回到 B", async function () {
    this.timeout(240000);
    await selectV4TaskById(sessionB);
    await sendV4Prompt(`E2E_DWW_B_AMEND 调整这个 run。${carryRunId(holeRunId)}`);
    await waitForV4PermissionDialog();
    await browser.waitUntil(
      async () => (await readPermissionWindowText()).includes("调整此工作流？"),
      { timeout: 30000, timeoutMsg: "B 的确认窗不是调整工作流的窗" },
    );
    await approveV4Permission();
    const amended = await waitForToolResult("toolu_dww_b_amend");
    expect(amended.isError).toBe(false);
    expect(amended.content).toContain(holeRunId);

    await waitForV4AssistantMessageContaining("E2E_DWW_B_AMEND_DONE", 120000);
    const notices = await getUpstreamRequestEvidence({
      includes: [`<description>${HOLE_RUN_NAME}</description>`, "E2E_DWW_B_AMEND"],
      lastUserMessageIncludes: ["<task-notification>"],
    });
    expect(notices.map((notice) => notice.fixtureId)).toEqual(["dww-b-amend-notified"]);
  });
});

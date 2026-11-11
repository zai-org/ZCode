import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
  type UpstreamRequestQuery,
} from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import { DEFAULT_WORKSPACE, clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4Permission,
  getV4ComposerBackgroundWorkCounts,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";

// 恢复一次停下的 run（docs/dynamic-workflow/presentation.md「The run card」「The run pane」、
// docs/dynamic-workflow/transcript-and-notifications.md「Reminding an idle main agent」「The time figure」、
// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」、
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Resume by replay」「Cancel and resume」）
// 的三条桌面链路：
// - 用户停止后从 run 卡恢复：做完的 ask 与 world.run 由 journal 回答，未完成的 ask 重新执行；
// - 完整重启切断的 run 从侧板恢复：同一个 run id，唯一一条终态通知；
// - 主代理用 ResumeWorkflowRun 恢复：停着时补全被拒并指向恢复，恢复后留白重新询问，补全后跑完。
//
// case-local 回放只决定主模型与子代理的回答；停止、关闭收口、重放、留白与通知都走产品链路。
// 运行时序靠受控回放（子代理）与放行文件（world.run）推进，不靠定时等待。
const COUNT_FILE = join(DEFAULT_WORKSPACE, ".e2e-dwu-a-count");
const RELEASE_FILE = join(DEFAULT_WORKSPACE, ".e2e-dwu-b-release");
const HELD_RETRY_FIXTURE = "dwu-a-agent-held-retry";
const SUBAGENT_LINE = "You are a subagent inside a dynamic workflow run";
const DIGEST = '[data-workflow-run-digest="true"]';
const NOTIFICATION_ROW = '[data-testid^="chat-workflow-notification-row-"]';
const COMPLETION_CARD = '[data-workflow-completion-card="true"]';
// 留白 id 是名字的键（apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md「Sites」）：「决定分组」→ 这个 id。
const HOLE_ID = "hole#21b40fca";
const RESUMED_BY_AGENT_NAME = "E2E 恢复工作流丙";

let resumedByAgentRunId = "";

interface DigestSnapshot {
  runId: string | null;
  status: string | null;
  kind: string;
  stations: { status: string | null; text: string }[];
  pills: { status: string | null; text: string }[];
}

function digestFor(runId: string) {
  return `${DIGEST}[data-workflow-run-id="${runId}"]`;
}

const subagentAsk = (marker: string): UpstreamRequestQuery => ({
  includes: [SUBAGENT_LINE],
  lastUserMessageIncludes: [marker],
});

/** 模型读到的某个 run 的通知。`status` 缺省时计这个 run 的全部终态通知。 */
const terminalNotice = (runId: string, status?: string): UpstreamRequestQuery => ({
  lastUserMessageIncludes: [
    "<task-notification>",
    `<task-id>${runId}</task-id>`,
    ...(status === undefined ? [] : [`<status>${status}</status>`]),
  ],
});

/** 同一个 run 可以有多张卡（发起轮一张、ResumeWorkflowRun 那一轮一张）：全部读出。 */
function readDigests(runId: string): Promise<DigestSnapshot[]> {
  return browser.execute((selector) => {
    const text = (element: Element | null) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).map((root) => ({
      runId: root.dataset.workflowRunId ?? null,
      status: root.dataset.workflowRunStatus ?? null,
      kind: text(root.querySelector('[data-testid="workflow-card-kind"]')),
      stations: Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="workflow-timeline-station"]'),
      ).map((station) => ({ status: station.dataset.stationStatus ?? null, text: text(station) })),
      pills: Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="workflow-agent-pill"]'),
      ).map((pill) => ({ status: pill.dataset.agentStatus ?? null, text: text(pill) })),
    }));
  }, digestFor(runId));
}

/** 等这个 run 的卡都满足条件；只等状态时用 `status` 字段判断，返回第一张。 */
async function waitForDigest(
  runId: string,
  accept: (snapshot: DigestSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 120_000,
): Promise<DigestSnapshot> {
  let latest: DigestSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latest = await readDigests(runId);
        return latest.length > 0 && latest.every(accept);
      },
      { timeout },
    );
  } catch {
    throw new Error(`${timeoutMsg}；最后一次读到 ${JSON.stringify(latest)}`);
  }
  return latest[0]!;
}

async function waitForOnlyRunId(): Promise<string> {
  let runId: string | null = null;
  await browser.waitUntil(
    async () => {
      runId = await browser.execute((selector) => {
        const cards = document.querySelectorAll<HTMLElement>(selector);
        return cards.length === 1 ? (cards[0]!.dataset.workflowRunId ?? null) : null;
      }, DIGEST);
      return Boolean(runId);
    },
    { timeout: 120_000, timeoutMsg: "会话里没有长出唯一一张带 run id 的 run 卡" },
  );
  return runId!;
}

async function launchWorkflow(tag: "A" | "B" | "C", prompt: string, readyMarker: string) {
  await sendV4Prompt(`E2E_DWU_${tag}_START ${prompt}`);
  await approveV4Permission();
  const toolCallId = `toolu_dwu_${tag.toLowerCase()}_create`;
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId))?.isError === false,
    { timeout: 60_000, timeoutMsg: `${tag}: CreateWorkflow 未执行成功` },
  );
  await waitForV4AssistantMessageContaining(readyMarker, 60_000);
  await waitForV4Pane((pane) => !pane.canStop, `${tag}: 启动轮没有结束`, 60_000);
  const sessionId = (await getV4PaneSnapshot()).sessionId;
  if (!sessionId || sessionId === "draft") throw new Error(`${tag}: 没有真实 sessionId`);
  return { sessionId, runId: await waitForOnlyRunId() };
}

/** 完整重启：Electron、Host 与 CLI 都换新进程，会话只能从持久数据冷物化。 */
async function relaunchApp(sessionId: string) {
  await reloadElectronSessionSafely(browser);
  await pinE2ELocale("zh-CN");
  if ((await getV4PaneSnapshot()).sessionId !== sessionId) {
    await selectV4TaskById(sessionId, 60_000);
  }
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `没有重新打开会话 ${sessionId}`,
    60_000,
  );
}

/** 从卡上停止，等它落到已停止，再等停止通知那一轮收尾：恢复不和这一轮抢。 */
async function stopFromCard(runId: string, notedMarker: string) {
  await $(digestFor(runId)).$('[data-testid="workflow-digest-cancel"]').click();
  await waitForDigest(runId, (card) => card.status === "stopped", "run 卡没有落到已停止");
  await waitForV4AssistantMessageContaining(notedMarker, 60_000);
  await waitForV4Pane((pane) => !pane.canStop, "停止通知那一轮没有结束", 60_000);
}

/** 读出某个 kind 词的通知行数量（通知行短，不被虚拟列表回收）。 */
function countNotificationRows(kindLabel: string): Promise<number> {
  return browser.execute(
    (selector, label) =>
      Array.from(document.querySelectorAll(selector)).filter((row) =>
        (row.textContent ?? "").includes(label),
      ).length,
    NOTIFICATION_ROW,
    kindLabel,
  );
}

/** 完成卡四格的终值：数字刚挂载时会翻动，相邻两次读数一致才算停下。 */
async function readSettledFigures(): Promise<Record<string, string>> {
  await $(COMPLETION_CARD).waitForDisplayed({ timeout: 60_000 });
  let figures: Record<string, string> = {};
  let previous = "";
  await browser.waitUntil(
    async () => {
      figures = await browser.execute((selector) => {
        const root = document.querySelector(selector);
        const values: Record<string, string> = {};
        for (const key of ["subagents", "phases"]) {
          values[key] =
            root
              ?.querySelector<HTMLElement>(`[data-testid="workflow-completion-figure-${key}"]`)
              ?.getAttribute("data-value") ?? "—";
        }
        return values;
      }, COMPLETION_CARD);
      const current = JSON.stringify(figures);
      const settled = current === previous;
      previous = current;
      return settled;
    },
    { timeout: 30_000, interval: 1_000, timeoutMsg: "完成卡的四格数字没有停下来" },
  );
  return figures;
}

/** 工具行在已结束一轮的「已处理」折叠里：展开所有收起的折叠，直到它出现。 */
async function revealToolRow(selector: string) {
  const row = $(selector);
  await browser.waitUntil(
    async () => {
      if (await isOutsideClosedHistory(selector)) return true;
      await openClosedHistoryFolds();
      return false;
    },
    { timeout: 30_000, timeoutMsg: `工具行没有出现：${selector}` },
  );
  return row;
}

describe("动态工作流 · 恢复停下的 run", () => {
  before(async () => {
    await Promise.all([rm(COUNT_FILE, { force: true }), rm(RELEASE_FILE, { force: true })]);
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await Promise.all([rm(COUNT_FILE, { force: true }), rm(RELEASE_FILE, { force: true })]);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWU-01 用户停止后从 run 卡恢复：做完的步骤来自缓存，未完成的 ask 重新执行，同一个 run 跑完，只有一条完成通知", async function () {
    this.timeout(360_000);
    const { runId } = await launchWorkflow(
      "A",
      "使用工作流：记录员写记录，再由核对员核对。",
      "E2E_DWU_A_STARTED",
    );
    // 核对员的请求发出后挂在门闩上：这时停止，做完的只有记录员与那条 world.run。
    await waitForUpstreamRequest(
      subagentAsk("E2E_DWU_A_HELD_TASK"),
      "核对员的请求没有发出",
      120_000,
    );
    await waitForDigest(
      runId,
      (card) => card.status === "running" && card.stations[1]?.status === "running",
      "run 没有停在「核对」站上",
    );

    await stopFromCard(runId, "E2E_DWU_A_STOP_NOTED");
    const digest = $(digestFor(runId));
    await expect(digest.$('[data-testid="workflow-digest-resume"]')).toBeDisplayed();
    expect(await countUpstreamRequests(terminalNotice(runId, "stopped"))).toBe(1);
    expect(await countUpstreamRequests(terminalNotice(runId, "completed"))).toBe(0);

    // 恢复是同一个 run：卡原地回到运行中，Resume 退场、Stop 回来，composer 徽标重新计入，
    // 没有长出第二张卡（GUI 的 Resume 不产生 ResumeWorkflowRun 工具行，见 launch.md 的入口表）。
    await digest.$('[data-testid="workflow-digest-resume"]').click();
    const resumed = await waitForDigest(
      runId,
      (card) => card.status === "running" && card.stations[1]?.status === "running",
      "恢复后 run 卡没有回到运行中",
    );
    expect(resumed.kind).toContain("工作流运行中");
    await expect($$(DIGEST)).toBeElementsArrayOfSize(1);
    await expect(digest.$('[data-testid="workflow-digest-resume"]')).not.toBeExisting();
    await expect(digest.$('[data-testid="workflow-digest-cancel"]')).toBeDisplayed();
    await browser.waitUntil(
      async () => (await getV4ComposerBackgroundWorkCounts())?.workflowCount === 1,
      { timeout: 30_000, timeoutMsg: "composer 徽标没有重新计入恢复的工作流" },
    );

    // 未完成的 ask 第二次发出请求（挂在第二个门闩上）；做完的 ask 没有再发。
    await browser.waitUntil(
      async () => (await countUpstreamRequests(subagentAsk("E2E_DWU_A_HELD_TASK"))) === 2,
      { timeout: 60_000, timeoutMsg: "恢复后未完成的 ask 没有重新执行" },
    );
    expect(await countUpstreamRequests(subagentAsk("E2E_DWU_A_DONE_TASK"))).toBe(1);

    // 脚本步骤面板：那条 world.run 的卡带 replayed 芯片（命令没有再跑一次）。
    await digest
      .$('button[data-testid="workflow-agent-pill"][aria-label="打开 记录 处的脚本步骤"]')
      .click();
    await $(
      `[data-testid="workflow-workspace-pane"][data-workflow-run-id="${runId}"] [data-testid="workflow-workspace-replayed"]`,
    ).waitForExist({ timeout: 30_000, timeoutMsg: "world.run 的卡没有 replayed 芯片" });

    await releaseControlledReplay(HELD_RETRY_FIXTURE);
    await waitForDigest(runId, (card) => card.status === "completed", "恢复后 run 没有跑完");
    await waitForV4AssistantMessageContaining("E2E_DWU_A_DONE", 120_000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60_000);

    // 命令只跑过一次：副作用文件只有一行。
    expect((await readFile(COUNT_FILE, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await countUpstreamRequests(subagentAsk("E2E_DWU_A_DONE_TASK"))).toBe(1);
    expect(await countUpstreamRequests(subagentAsk("E2E_DWU_A_HELD_TASK"))).toBe(2);

    // 结果拼的是第一条命中的缓存答案与重跑的答案；被停掉的那份回答没有进入结果。
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [
          `<task-id>${runId}</task-id>`,
          "<status>completed</status>",
          "E2E_DWU_A_DONE_ANSWER",
          "E2E_DWU_A_HELD_ANSWER",
        ],
        lastUserMessageExcludes: ["E2E_DWU_A_LOST_ANSWER"],
      },
      "完成通知没有带上两份答案",
      30_000,
    );
    expect(await countUpstreamRequests(terminalNotice(runId, "completed"))).toBe(1);
    expect(await countUpstreamRequests(terminalNotice(runId))).toBe(2);
    expect(await countNotificationRows("工作流已完成")).toBe(1);
    expect(await countNotificationRows("工作流已停止")).toBe(1);
    expect(await readSettledFigures()).toEqual({ subagents: "2", phases: "2" });
  });

  it("DWU-02 完整重启切断的 run 从侧板恢复：同一个 run id，做完的 ask 不重发，跑完后模型只读到一条终态通知", async function () {
    this.timeout(420_000);
    await prepareV4ConversationE2E();
    const { sessionId, runId } = await launchWorkflow(
      "B",
      "使用工作流：先写记录，等待放行后收尾。",
      "E2E_DWU_B_STARTED",
    );
    await waitForDigest(
      runId,
      (card) => card.status === "running" && card.stations[1]?.status === "running",
      "run 没有停在「等待放行」站上",
    );

    await relaunchApp(sessionId);
    await waitForDigest(runId, (card) => card.status === "stopped", "重启后 run 没有显示为已停止");
    await $(digestFor(runId)).$('[data-testid="workflow-card-open-details"]').click();
    const paneResume = $('[data-testid="workflow-run-resume"]');
    await paneResume.waitForDisplayed({ timeout: 60_000 });
    await expect($('[data-testid="workflow-run-status-reason"]')).toHaveText(
      expect.stringContaining("进程已退出"),
    );
    await expect($('[data-testid="workflow-run-status-resumable"]')).toBeDisplayed();

    // 侧板：状态词回到「运行中」，「可恢复」与 Resume 退场，Stop 可按。放行文件这时才写，运行态可断言。
    await paneResume.click();
    await browser.waitUntil(
      async () => (await $('[data-testid="workflow-run-status"]').getText()) === "运行中",
      { timeout: 60_000, timeoutMsg: "恢复后侧板状态没有回到运行中" },
    );
    await expect($('[data-testid="workflow-run-resume"]')).not.toBeExisting();
    await expect($('[data-testid="workflow-run-status-resumable"]')).not.toBeExisting();
    await expect($('[data-testid="workflow-run-cancel"]')).toBeEnabled();
    // 恢复不是新 lineage：同一个 run id，侧板没有「改自」行。
    await expect($('[data-testid="workflow-run-amends"]')).not.toBeExisting();
    const running = await waitForDigest(
      runId,
      (card) =>
        card.status === "running" &&
        card.stations[1]?.status === "running" &&
        card.pills.some((pill) => pill.text.includes("记录员")),
      "恢复后卡没有回到「等待放行」站，或者记录员丢了",
    );
    expect(running.stations[0]?.status).toBe("done");
    await expect($$(DIGEST)).toBeElementsArrayOfSize(1);

    await writeFile(RELEASE_FILE, "go\n");
    await waitForDigest(runId, (card) => card.status === "completed", "放行后 run 没有跑完");
    await waitForV4AssistantMessageContaining("E2E_DWU_B_DONE", 120_000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60_000);

    expect(await countUpstreamRequests(subagentAsk("E2E_DWU_B_DONE_TASK"))).toBe(1);
    expect(await countUpstreamRequests(subagentAsk("E2E_DWU_B_LAST_TASK"))).toBe(1);
    // 关闭时的 stopped(interrupted) 通知随运行时关闭被丢弃：模型只读到恢复后的这一条。
    expect(await countUpstreamRequests(terminalNotice(runId, "completed"))).toBe(1);
    expect(await countUpstreamRequests(terminalNotice(runId))).toBe(1);
    expect(await countNotificationRows("工作流已完成")).toBe(1);
    expect(await countNotificationRows("工作流已停止")).toBe(0);
    expect(await readSettledFigures()).toEqual({ subagents: "2", phases: "3" });
  });

  it("DWU-03 主代理恢复：停着时补全被拒并指向 ResumeWorkflowRun；恢复后是同一个 run，留白再问一次，补全后跑完", async function () {
    this.timeout(360_000);
    await prepareV4ConversationE2E();
    const { runId } = await launchWorkflow(
      "C",
      "使用工作流：分组留给你补全。",
      "E2E_DWU_C_WAITING",
    );
    resumedByAgentRunId = runId;
    const holeNotice: UpstreamRequestQuery = {
      lastUserMessageIncludes: ["<workflow-hole>", `<run-id>${runId}</run-id>`, HOLE_ID],
    };
    expect(await countUpstreamRequests(holeNotice)).toBe(1);

    await stopFromCard(runId, "E2E_DWU_C_STOP_NOTED");

    // 停下的 run 不在飞：补全被拒（hole_not_waiting），消息指向 ResumeWorkflowRun（launch.md 拒绝表）。
    await sendV4Prompt("E2E_DWU_C_EARLY_FILL 现在补全分组。");
    await browser.waitUntil(
      async () => (await getLatestUpstreamToolResultByToolCallId("toolu_dwu_c_early")) != null,
      { timeout: 60_000, timeoutMsg: "停着时的 FillWorkflowHole 没有结果" },
    );
    const refused = await getLatestUpstreamToolResultByToolCallId("toolu_dwu_c_early");
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain("ResumeWorkflowRun");
    await waitForV4AssistantMessageContaining("E2E_DWU_C_EARLY_REFUSED", 60_000);
    await waitForV4Pane((pane) => !pane.canStop, "拒绝那一轮没有结束", 60_000);
    await waitForDigest(runId, (card) => card.status === "stopped", "被拒之后 run 不该变状态");

    // 主代理恢复：工具走同一个端口，无确认窗，返回同一个 run id。
    await sendV4Prompt("E2E_DWU_C_RESUME 继续这个工作流。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwu_c_resume"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "ResumeWorkflowRun 未执行成功" },
    );
    const resumedResult = await getLatestUpstreamToolResultByToolCallId("toolu_dwu_c_resume");
    expect(resumedResult?.content).toContain(runId);

    // 留白重新询问：同一个 run、同一个留白，第二条通知。
    await browser.waitUntil(async () => (await countUpstreamRequests(holeNotice)) === 2, {
      timeout: 60_000,
      timeoutMsg: "恢复后留白没有重新询问",
    });
    await waitForV4Pane((pane) => !pane.canStop, "恢复那一轮没有结束", 60_000);

    // 恢复行是一行紧凑卡（「工作流实例已恢复」+ run id + 灯与词）。这一轮也为这个 run 长一张卡，
    // 它和发起轮的卡说同一件事（presentation.md「The run card」的来源表）。
    const compact = await revealToolRow(
      `[data-testid="workflow-run-card"][data-workflow-run-id="${runId}"]`,
    );
    await browser.waitUntil(
      async () => String(await compact.getProperty("textContent")).includes("工作流实例已恢复"),
      { timeout: 15_000, timeoutMsg: "恢复行没有写「工作流实例已恢复」" },
    );
    expect(String(await compact.getProperty("textContent"))).toContain(runId);
    await waitForDigest(runId, (card) => card.status === "running", "恢复后卡没有回到运行中");
    // 恢复行所在的这一轮有自己的卡：DOM 上排在恢复行之后。
    expect(
      await browser.execute(
        (rowSelector, cardSelector) => {
          const row = document.querySelector(rowSelector);
          return Array.from(document.querySelectorAll(cardSelector)).some(
            (card) =>
              row !== null &&
              (row.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          );
        },
        `[data-testid="workflow-run-card"][data-workflow-run-id="${runId}"]`,
        digestFor(runId),
      ),
    ).toBe(true);
    // 发起轮的卡还在原处（时间线是虚拟列表，滚上去才挂载），同样回到运行中。
    await scrollV4TimelineToTop();
    await browser.waitUntil(
      async () =>
        (await readDigests(runId)).some(
          (card) => card.status === "running" && card.stations.length > 0,
        ),
      { timeout: 30_000, timeoutMsg: "发起轮的 run 卡没有回到运行中" },
    );

    await sendV4Prompt("E2E_DWU_C_FILL_NOW 现在补全分组。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwu_c_fill"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "恢复后的 FillWorkflowHole 未执行成功" },
    );
    await waitForDigest(runId, (card) => card.status === "completed", "补全后 run 没有跑完");
    await waitForV4AssistantMessageContaining("E2E_DWU_C_DONE", 120_000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60_000);
    expect(await countUpstreamRequests(terminalNotice(runId, "completed"))).toBe(1);
    expect(await countNotificationRows("工作流已完成")).toBe(1);
  });

  // 文档（transcript-and-notifications.md「What the model reads」「The notification row」）：
  // `<description>` 与通知行的主文本都是 run 名，不区分谁恢复的。
  it("DWU-04 主代理恢复的 run，完成通知的 description 与通知行写的是 run 名，不是 run id", async function () {
    this.timeout(60_000);
    if (!resumedByAgentRunId) throw new Error("DWU-03 没有留下 run");
    const named = await countUpstreamRequests({
      lastUserMessageIncludes: [
        `<task-id>${resumedByAgentRunId}</task-id>`,
        "<status>completed</status>",
        `<description>${RESUMED_BY_AGENT_NAME}</description>`,
      ],
    });
    const rowText = await browser.execute((selector) => {
      const rows = Array.from(document.querySelectorAll(selector));
      const row = rows.find((item) => (item.textContent ?? "").includes("工作流已完成"));
      return row?.textContent ?? "";
    }, NOTIFICATION_ROW);
    expect({ named, rowHasName: rowText.includes(RESUMED_BY_AGENT_NAME) }).toEqual({
      named: 1,
      rowHasName: true,
    });
  });
});

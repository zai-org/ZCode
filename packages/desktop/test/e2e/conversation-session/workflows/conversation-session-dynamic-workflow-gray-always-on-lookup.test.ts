import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared/test-ids";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

// 查询工作流实例的两张工具卡（docs/dynamic-workflow/launch.md「Run introspection tools」
// 「`ListWorkflowRuns`」「`GetWorkflowRun`」「Their cards」）：
// - 活着的 run：状态卡的摘要句、阶段轨、花名册、健康行与待答问题；列表卡的一行；
// - 别的会话读同一个 run：不标「本会话」、警示「可能已中断」、明说看不到待答问题；
// - 修订之后：列表卡读出替代关系与截断，已完成的 run 卡先给结果；
// - 完整重启：旧卡一字不差，新查询从 journal 读出同样的内容。
//
// case-local 回放只决定模型调用；Skill、编译、审批、run 引擎、升级停驻、修订替代、journal 读面与
// 工具卡都走产品链路。run 由子代理的 `escalate` 停驻保持 running，不需要计时器。
const RUN_DIGEST = '[data-workflow-run-digest="true"]';
const RUN_NAME = "E2E 查询工作流";
const QUESTION = "E2E_DWL_QUESTION 条目二该不该保留？";

/**
 * 回放的 `{{latestWorkflowRunId}}` 只读请求里 `<workflow-hole>` 块的 `<run-id>`，而本用例的 run 没有留白。
 * 模型的 run id 本来就可能来自用户的话：把用例从卡上读到的 id 写进提示，形状对上回放的读取规则，
 * 不用为了拿 id 往脚本里多塞一个留白，也不改共用的回放助手。
 */
function runIdHint(runId: string) {
  return `<workflow-hole><run-id>${runId}</run-id></workflow-hole>`;
}

function gatePath() {
  return resolveE2ERuntimePath("dwl-gate");
}

/** 写闸文件：脚本里的 `world.run("node", …)` 看到它就退出，第二个子代理随之开工。 */
async function openGate() {
  const path = gatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "open\n");
}

function blockSelector(toolId: string) {
  return `[data-testid="${testId(TID_CHAT_TOOL_CALL_BLOCK, toolId)}"]`;
}

async function blockText(toolId: string) {
  return String(await $(blockSelector(toolId)).getProperty("textContent"));
}

/**
 * 工具卡可能收在「已处理」折叠里，也可能被虚拟化卸载：展开所有折叠，再一屏屏往上滚（到顶后回到底），
 * 直到卡挂载。滚动先发 wheel：ConversationTimeline 只把带用户意图的滚动当真（见 scrollV4TimelineToTop）。
 */
async function revealCard(toolId: string) {
  const selector = blockSelector(toolId);
  await browser.waitUntil(
    async () => {
      if (await isOutsideClosedHistory(selector)) return true;
      await openClosedHistoryFolds();
      await browser.execute(() => {
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
        if (!timeline) return;
        timeline.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600 }),
        );
        timeline.scrollTop =
          timeline.scrollTop <= 0 ? timeline.scrollHeight : timeline.scrollTop - 500;
        timeline.dispatchEvent(new Event("scroll"));
      });
      return false;
    },
    { timeout: 60_000, interval: 300, timeoutMsg: `工具卡没有出现：${toolId}` },
  );
  await $(selector).scrollIntoView({ block: "center" });
}

/** 展开工具卡（已展开就不动），等 `bodySelector` 在卡里有了文字。 */
async function openCard(toolId: string, bodySelector: string) {
  await revealCard(toolId);
  const selector = blockSelector(toolId);
  const body = $(`${selector} ${bodySelector}`);
  // 折叠刚展开时布局还在动，按坐标的点击可能落空；虚拟化重新挂载也可能收起：走 DOM 点击，每轮复查。
  // 轮次结束时折叠原地收起（见 helpers/v4-history-folds.ts）：每轮补开收起的折叠，再展开卡片。
  await browser.waitUntil(
    async () => {
      await openClosedHistoryFolds();
      if (
        (await body.isExisting()) &&
        String(await body.getProperty("textContent")).trim() !== ""
      ) {
        return true;
      }
      await browser.execute((toggleSelector) => {
        document.querySelector<HTMLElement>(toggleSelector)?.click();
      }, `${selector} [aria-expanded="false"]`);
      return false;
    },
    { timeout: 15_000, interval: 300, timeoutMsg: `工具卡展开后没有内容：${toolId}` },
  );
}

interface StatusCard {
  header: string;
  summaryLine: string;
  summary: string;
  phases: string[];
  subagents: string[];
  health: string;
  questionsUnknown: boolean;
  body: string;
}

/** 读状态卡。折叠动画里 innerText 可能为空，一律读 textContent；一行里的格用空格隔开。 */
async function readStatusCard(toolId: string): Promise<StatusCard> {
  await openCard(toolId, '[data-testid="workflow-status-body"]');
  return browser.execute((selector) => {
    const root = document.querySelector<HTMLElement>(selector)!;
    const text = (element: Element | null | undefined) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    // 花名册一行有嵌套（行 + 任务行），阶段轨一行是平的：都按叶子元素取格。
    const cells = (row: Element) =>
      Array.from(row.querySelectorAll("span, p"))
        .filter((element) => element.children.length === 0)
        .map((element) => text(element))
        .join(" ");
    const rows = (testid: string) =>
      Array.from(root.querySelector(`[data-testid="${testid}"]`)?.children ?? []).map(cells);
    return {
      header: text(root.querySelector('[data-testid="workflow-run-summary-line"]')?.parentElement),
      summaryLine: text(root.querySelector('[data-testid="workflow-run-summary-line"]')),
      summary: text(root.querySelector('[data-testid="workflow-run-summary"]')),
      phases: rows("workflow-run-phases"),
      subagents: rows("workflow-run-subagents"),
      health: text(root.querySelector('[data-testid="workflow-run-health"]')),
      questionsUnknown:
        root.querySelector('[data-testid="workflow-run-questions-unknown"]') !== null,
      body: text(root.querySelector('[data-testid="workflow-status-body"]')),
    };
  }, blockSelector(toolId));
}

interface ListCard {
  count: string;
  rows: { id: string | null; status: string | null; cells: string[]; title: string | null }[];
  text: string;
}

async function readListCard(toolId: string): Promise<ListCard> {
  await openCard(toolId, "[data-workflow-run-list]");
  return browser.execute((selector) => {
    const root = document.querySelector<HTMLElement>(selector)!;
    const text = (element: Element | null | undefined) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      count: text(root),
      rows: Array.from(root.querySelectorAll<HTMLElement>("[data-workflow-run-row]")).map(
        (row) => ({
          id: row.getAttribute("data-workflow-run-row"),
          status: row.getAttribute("data-workflow-run-row-status"),
          cells: Array.from(row.children).map((cell) => text(cell)),
          title: row.querySelector("[title]")?.getAttribute("title") ?? null,
        }),
      ),
      text: text(root),
    };
  }, blockSelector(toolId));
}

/**
 * JSON 结果由 CodeViewer 画在 shadow DOM 里，textContent 读不到，且高亮是异步的：
 * 穿过 shadow root 读全文，等结果出现，并确认它排在阶段轨之前。
 */
async function expectResultBeforePhases(toolId: string) {
  let deep = "";
  await browser.waitUntil(
    async () => {
      deep = await browser.execute(
        (selector) => {
          const read = (node: Node): string => {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
            const root = (node as Element).shadowRoot;
            const own = Array.from(node.childNodes).map(read).join("");
            return root ? Array.from(root.childNodes).map(read).join("") + own : own;
          };
          const body = document.querySelector(selector);
          return body ? read(body) : "";
        },
        `${blockSelector(toolId)} [data-testid="workflow-status-body"]`,
      );
      return deep.includes('"amended": true');
    },
    { timeout: 30_000, timeoutMsg: `状态卡没有画出 JSON 结果：${toolId}` },
  );
  expect(deep.indexOf('"amended": true')).toBeLessThan(deep.indexOf("1.准备"));
  expect(deep.indexOf("1.准备")).toBeGreaterThan(-1);
}

async function modelText(toolCallId: string): Promise<string> {
  let content = "";
  await browser.waitUntil(
    async () => {
      const result = await getLatestUpstreamToolResultByToolCallId(toolCallId);
      if (result?.isError !== false) return false;
      content = String(result.content);
      return true;
    },
    { timeout: 60_000, timeoutMsg: `工具没有执行成功：${toolCallId}` },
  );
  return content;
}

async function finishTurn(marker: string) {
  await waitForV4AssistantMessageContaining(marker, 120_000);
  await waitForV4Pane((pane) => !pane.canStop, `${marker} 那一轮没有结束`, 60_000);
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

describe("动态工作流 · 查询实例的工具卡", () => {
  let sessionA = "";
  let runA = "";
  let runB = "";
  let qid = "";
  let getALive: StatusCard | undefined;
  let getAStopped: StatusCard | undefined;
  let getB: StatusCard | undefined;
  let listLive: ListCard | undefined;
  let listFinal: ListCard | undefined;
  let listLimited: ListCard | undefined;

  before(async () => {
    await rm(gatePath(), { force: true });
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await rm(gatePath(), { force: true });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWL-01 活着的 run：状态卡读出摘要句、阶段轨、花名册、健康行与待答问题，列表卡一行且标「本会话」", async function () {
    this.timeout(360_000);
    await sendV4Prompt("E2E_DWL_START 用工作流整理并核对条目。");
    await approveV4Permission();
    await modelText("toolu_dwl_create");
    await finishTurn("E2E_DWL_STARTED");
    const digest = $(`${RUN_DIGEST}[data-workflow-run-status="running"]`);
    await digest.waitForExist({ timeout: 60_000 });
    runA = (await digest.getAttribute("data-workflow-run-id")) ?? "";
    expect(runA).not.toBe("");
    const paneSession = (await getV4PaneSnapshot()).sessionId;
    if (!paneSession || paneSession === "draft") throw new Error("没有真实 sessionId");
    sessionA = paneSession;

    // 开闸：第二个子代理开工并停驻；升级通知唤起的那一轮收尾后，主代理闲着，run 还在跑。
    await openGate();
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["<workflow-escalation>"] },
      "升级通知没有唤起主代理",
      120_000,
    );
    await finishTurn("E2E_DWL_SEEN");

    await sendV4Prompt(`E2E_DWL_LOOK ${runIdHint(runA)} 看看这个工作流走到哪了。`);
    const model = await modelText("toolu_dwl_look_get");
    const listModel = await modelText("toolu_dwl_look_list");
    await finishTurn("E2E_DWL_LOOK_DONE");

    getALive = await readStatusCard("toolu_dwl_look_get");
    // 摘要句由工具从结构化字段拼出，不经模型；折叠行与展开体的导语是同一句。
    expect(getALive.summary).toMatch(
      /^Running for .+, in phase 2 of 3 \(核对\)\. \d+ of \d+ dispatched steps settled, 1 running \(1 parked\)\. 1 question awaiting your answer\. Last progress .+ ago\.$/u,
    );
    expect(getALive.summaryLine).toBe(getALive.summary);
    expect(
      String(await $(blockSelector("toolu_dwl_look_get")).getProperty("textContent")),
    ).toContain("工作流状态");
    expect(getALive.header).toContain(RUN_NAME);

    // 阶段轨：声明序，走过 / 当前 / 还没到；`ahead` 没有轮次也没有步数。
    expect(getALive.phases).toHaveLength(3);
    expect(getALive.phases[0]).toContain("1. 准备 已完成 1 轮");
    expect(getALive.phases[1]).toContain("2. 核对 进行中 1 轮");
    expect(getALive.phases[1]).toContain("1 步运行中");
    expect(getALive.phases[1]).toContain("已进行");
    expect(getALive.phases[2]).toBe("3. 收尾 待开始");

    // 花名册：谁、地址、相位、阶段，再加这个相位该说的事；run 活着时答完的是「空闲」，停驻的说等哪个问题。
    expect(getALive.subagents).toHaveLength(2);
    expect(getALive.subagents[0]).toMatch(/^整理员 \S+@\d+ 空闲 阶段 准备 1 步/u);
    expect(getALive.subagents[1]).toMatch(
      /^核对员 \S+@\d+ 停驻 阶段 核对 等待问题 dwfq-\S+ 的答复/u,
    );
    expect(getALive.subagents[1]).toContain("任务：E2E_DWL_CHECK");
    qid = /dwfq-[^\s]+/u.exec(getALive.subagents[1] ?? "")?.[0] ?? "";
    expect(qid).not.toBe("");

    // 健康行与页脚：活着的 run 说最近进展、未停滞、节点数；本会话持有这个 run，看得到待答问题。
    expect(getALive.health).toContain("最近进展");
    expect(getALive.health).toContain("未停滞");
    expect(getALive.questionsUnknown).toBe(false);
    expect(getALive.body).toMatch(/运行中·?\s*·?\s*\d+\/\d+ 步/u);
    expect(getALive.body).toContain("1 个节点运行中");
    // 非 completed 的 run 把日志尾画在卡上。
    expect(getALive.body).toContain("E2E_DWL_LOG 条目已列出");

    // 模型读到的同一份事实：待答问题排在健康、花名册与日志之前，并点名作答工具。
    expect(model).toContain(`<run_id>${runA}</run_id>`);
    expect(model).toContain("<owned_by_this_session>true</owned_by_this_session>");
    expect(model).toContain(qid);
    expect(model).toContain(QUESTION);
    expect(model).toContain("ResolveWorkflowQuestion");
    expect(model.indexOf("<pending_questions>")).toBeGreaterThan(-1);
    expect(model.indexOf("<pending_questions>")).toBeLessThan(model.indexOf("<health>"));
    expect(model.indexOf("<health>")).toBeLessThan(model.indexOf("<subagents>"));
    expect(model).toContain("<amendable>");

    // 列表卡：一行，运行中，标签是 run 名，标「本会话」，不警示。
    listLive = await readListCard("toolu_dwl_look_list");
    expect(listLive.rows.map((row) => [row.id, row.status])).toEqual([[runA, "running"]]);
    expect(listLive.text).toContain("运行中");
    expect(listLive.text).toContain(RUN_NAME);
    expect(listLive.text).toContain("本会话");
    expect(listLive.text).not.toContain("可能已中断");
    expect(
      String(await $(blockSelector("toolu_dwl_look_list")).getProperty("textContent")),
    ).toContain("1 个实例");
    expect(listModel).toMatch(new RegExp(`id="${runA}"[^\\n]*status="running"`, "u"));
    expect(listModel).toContain('owned_by_this_session="true"');
    expect(listModel).toContain('label_source="name"');
  });

  it("DWL-02 别的会话读同一个活着的 run：不标「本会话」、警示「可能已中断」，明说看不到待答问题，没有人被标停驻", async function () {
    this.timeout(240_000);
    // 准备助手回到夹具项目的新草稿：同一个 cwd，列表才查得到这个 run。
    await prepareV4ConversationE2E();
    await sendV4Prompt(`E2E_DWL_PEEK ${runIdHint(runA)} 看看这个项目里别的工作流。`);
    const listModel = await modelText("toolu_dwl_peek_list");
    const model = await modelText("toolu_dwl_peek_get");
    await finishTurn("E2E_DWL_PEEK_DONE");

    const list = await readListCard("toolu_dwl_peek_list");
    expect(list.rows.map((row) => [row.id, row.status])).toEqual([[runA, "running"]]);
    expect(list.text).toContain("可能已中断");
    expect(list.text).not.toContain("本会话");
    expect(listModel).toContain('owned_by_this_session="false"');
    expect(listModel).toContain('possibly_interrupted="true"');

    const card = await readStatusCard("toolu_dwl_peek_get");
    expect(card.questionsUnknown).toBe(true);
    expect(card.body).toContain("本会话看不到这个实例的待答问题");
    expect(card.body).toContain("本会话无法证实这个实例仍在运行");
    expect(card.summary).toContain("Pending questions are unknown from this session.");
    expect(card.summary).toContain("Owned by another session.");
    expect(card.summary).not.toContain("awaiting your answer");
    // 拿不到待答问题表，就不把任何子代理报成停驻。
    expect(card.subagents.join("\n")).not.toContain("停驻");
    expect(model).toContain("<owned_by_this_session>false</owned_by_this_session>");
    expect(model).toContain("<pending_questions>");
    expect(model).not.toContain(qid);

    await selectV4TaskById(sessionA, 60_000);
    await waitForV4Pane((pane) => pane.sessionId === sessionA, "没有回到原会话", 60_000);
  });

  it("DWL-03 修订之后：模型面读出谱系与截断；被替代的 run 与已完成的新 run 的状态卡", async function () {
    this.timeout(300_000);
    await sendV4Prompt("E2E_DWL_AMEND 不用核对了，改成整理完直接收尾。");
    await modelText("toolu_dwl_amend");
    const summary = $('[data-testid="workflow-tool-summary"][data-tool-call-id="toolu_dwl_amend"]');
    await browser.waitUntil(
      async () => {
        // 回放的这一轮很短：查到时这一轮可能已结束，修订行随之收进折叠、不在 DOM 中。
        await openClosedHistoryFolds();
        runB = (await summary.isExisting())
          ? ((await summary.getAttribute("data-workflow-run-id")) ?? "")
          : "";
        return runB !== "";
      },
      { timeout: 60_000, timeoutMsg: "修订行没有联接到新 run" },
    );
    expect(runB).not.toBe(runA);
    await finishTurn("E2E_DWL_DONE");

    await sendV4Prompt("E2E_DWL_LIST 列一下这个项目的工作流实例。");
    const listModel = await modelText("toolu_dwl_list_final");
    const limitedModel = await modelText("toolu_dwl_list_limited");
    const stoppedModel = await modelText("toolu_dwl_get_a_stopped");
    await finishTurn("E2E_DWL_LIST_DONE");

    // 谱系只在模型面：最新更新的在前，两端互相点名。
    expect(listModel.indexOf(`id="${runB}"`)).toBeLessThan(listModel.indexOf(`id="${runA}"`));
    expect(listModel).toMatch(
      new RegExp(
        `id="${runA}" status="stopped" stop_reason="superseded"[^\\n]*superseded[-_]by="${runB}"`,
        "u",
      ),
    );
    expect(listModel).toMatch(
      new RegExp(`id="${runB}" status="completed"[^\\n]*resumed[-_]from="${runA}"`, "u"),
    );
    // limit 只放一行、多取一行判定截断。
    expect(limitedModel).toContain('count="1" truncated="true"');
    expect(limitedModel).toContain(`id="${runB}"`);
    expect(limitedModel).not.toContain(`id="${runA}"`);

    // 被替代的 run：进程没退出、恢复也会被拒，三处都要说同一件事；走到一半的阶段不写 done。
    expect(stoppedModel).toContain("1 was still running when the run was superseded");
    expect(stoppedModel).not.toContain("owning process exited");
    expect(stoppedModel).not.toContain("the exited process");
    expect(stoppedModel).toMatch(/2\. \S+\s+unfinished/u);
    expect(stoppedModel).toMatch(/in phase 2 of 3/u);
    // 被替代的 run：卡上原因词，模型面指向后继，不再提恢复。
    getAStopped = await readStatusCard("toolu_dwl_get_a_stopped");
    expect(getAStopped.summary).toMatch(/^Stopped \(superseded\)/u);
    expect(getAStopped.body).toContain("已被替代");
    expect(getAStopped.questionsUnknown).toBe(false);
    expect(stoppedModel).toContain("<superseded>");
    expect(stoppedModel).toContain(`<superseded_by>${runB}</superseded_by>`);
    expect(stoppedModel).not.toContain("<resumable>");

    await sendV4Prompt(`E2E_DWL_GET_B ${runIdHint(runB)} 新实例怎么样了？`);
    await modelText("toolu_dwl_get_b");
    await finishTurn("E2E_DWL_GET_B_DONE");
    getB = await readStatusCard("toolu_dwl_get_b");
    expect(getB.summary).toMatch(
      /^Completed in .+, across 2 phases\. 1 step settled, .+ tokens\.$/u,
    );
    // 已完成的卡结果在阶段轨前面（JSON 结果走代码块）。
    await expectResultBeforePhases("toolu_dwl_get_b");
    expect(getB.phases).toHaveLength(2);
    expect(getB.phases[0]).toContain("1. 准备 已完成");
    expect(getB.phases[1]).toContain("2. 收尾 已完成");
    expect(getB.subagents).toHaveLength(1);
    expect(getB.subagents[0]).toMatch(/^整理员 \S+@\d+ 已完成 阶段 准备 1 步/u);
    // 那一步是从旧 run 导入的缓存：健康行说得出来，终态不再说「未停滞」。
    expect(getB.health).toContain("1 步命中缓存");
    expect(getB.health).not.toContain("未停滞");
    expect(getB.questionsUnknown).toBe(false);
  });

  // launch.md「Their cards」：列表卡一个计数、一 run 一行，没有「有谱系的 run 除外」。
  it("DWL-04 修订之后的列表卡：计数、新 run 已完成在前、旧 run 已停止 · 已被替代，都标「本会话」，截断有说明", async function () {
    this.timeout(120_000);
    await revealCard("toolu_dwl_list_final");
    expect(await blockText("toolu_dwl_list_final")).toContain("2 个实例");
    listFinal = await readListCard("toolu_dwl_list_final");
    expectFinalRows(listFinal);
    expect(listFinal.text).not.toContain("只显示最近的实例");

    await revealCard("toolu_dwl_list_limited");
    expect(await blockText("toolu_dwl_list_limited")).toContain("1 个实例");
    listLimited = await readListCard("toolu_dwl_list_limited");
    expect(listLimited.rows.map((row) => row.id)).toEqual([runB]);
    expect(await blockText("toolu_dwl_list_limited")).toContain("只显示最近的实例");
  });

  it("DWL-05 完整重启：旧状态卡一字不差，新查询从 journal 读出同样的内容", async function () {
    this.timeout(360_000);
    await relaunchApp(sessionA);

    // 旧卡画的是当时的快照：年龄对快照时刻算，重启不会让读数漂移。
    expect(await readStatusCard("toolu_dwl_get_b")).toEqual(getB);
    expect(await readStatusCard("toolu_dwl_get_a_stopped")).toEqual(getAStopped);
    expect(await readListCard("toolu_dwl_look_list")).toEqual(listLive);
    expect(await readStatusCard("toolu_dwl_look_get")).toEqual(getALive);

    await sendV4Prompt(`E2E_DWL_AFTER ${runIdHint(runB)} 重启后再看一次。`);
    await modelText("toolu_dwl_after_get");
    const listModel = await modelText("toolu_dwl_after_list");
    await finishTurn("E2E_DWL_AFTER_DONE");

    // 新进程没有这些 run 的内存状态，读到的全是 journal：摘要、阶段、花名册与重启前相同。
    const fresh = await readStatusCard("toolu_dwl_after_get");
    expect(fresh.summary).toBe(getB?.summary);
    expect(fresh.phases).toEqual(getB?.phases);
    expect(fresh.subagents).toEqual(getB?.subagents);
    expect(fresh.health).toContain("1 步命中缓存");
    await expectResultBeforePhases("toolu_dwl_after_get");

    // parent session 还是这个会话，重启后仍属本会话；两个都是终态，没有「可能已中断」。
    expect(listModel.match(/owned_by_this_session="true"/gu)).toHaveLength(2);
    expect(listModel).not.toContain("possibly_interrupted");
  });

  it("DWL-06 完整重启后的列表卡：旧卡不变，新查询读出同样的行", async function () {
    this.timeout(120_000);
    await revealCard("toolu_dwl_after_list");
    expect(await blockText("toolu_dwl_after_list")).toContain("2 个实例");
    const freshList = await readListCard("toolu_dwl_after_list");
    expectFinalRows(freshList);
    expect(freshList.text).not.toContain("可能已中断");
    // 时间与 token 都来自 journal，逐格相同；DWL-04 红时没有基准，只比上面那几条。
    if (listFinal) {
      expect(freshList.rows).toEqual(listFinal.rows);
      expect(await readListCard("toolu_dwl_list_final")).toEqual(listFinal);
      expect(await readListCard("toolu_dwl_list_limited")).toEqual(listLimited);
    }
  });

  /** 修订后的列表：最新更新的在前；新 run 已完成，旧 run 已停止且原因词是「已被替代」；都属于本会话。 */
  function expectFinalRows(card: ListCard) {
    expect(card.rows.map((row) => [row.id, row.status])).toEqual([
      [runB, "completed"],
      [runA, "stopped"],
    ]);
    expect(card.rows[0]?.cells.join(" ")).toContain("已完成");
    expect(card.rows[1]?.cells.join(" ")).toContain("已停止");
    expect(card.rows[1]?.cells.join(" ")).toContain("已被替代");
    for (const row of card.rows) {
      expect(row.cells.join(" ")).toContain(RUN_NAME);
      expect(row.cells.join(" ")).toContain("本会话");
      // 一行还带时间与 token：状态、标签、本会话之外还有两格。
      expect(row.cells.length).toBeGreaterThanOrEqual(5);
      expect(row.title).toBe(row.id);
    }
  }
});

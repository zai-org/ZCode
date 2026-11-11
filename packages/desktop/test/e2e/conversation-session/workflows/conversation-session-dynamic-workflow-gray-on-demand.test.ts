import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestToolContract,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  openAutomationsPage,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  setComposerDraft,
} from "#e2e/helpers/dynamic-workflow-gray";
import { clearAppData, pinE2ELocale, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4SlashOption,
} from "#e2e/helpers/v4-conversation";

// 灰度档 onDemand（docs/dynamic-workflow/launch.md「What each mode means」「On demand: activation」）：
// 入口与 alwaysOn 相同，只把模型看到的工具面推迟到会话第一次 `/workflow`。这里读真实发出的模型请求，
// 走完整条链路：服务端 mode → Host → CLI session → 注册门 → 请求里的 tools。
//
// case-local 回放只决定模型回答；注册、激活、压缩、冷恢复与工作流运行都走产品链路。
//
// 受灰度门管的十个工具。修复原因：`ListModels` 自 fc7ade7f4e（2026-11-04）起移出灰度门，
// 会话控制在场时未激活的会话也会带着它（launch.md「The ten tools」）；仍按它算工作流工具，
// DWO-01/02 会在激活前的那一轮失败，DWO-04 随之拿到一个从未激活的「已激活」会话。
const WORKFLOW_TOOL_NAMES = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
  "FillWorkflowHole",
];
/** 两个文档点名的子代理工具；描述里那行 CreateWorkflow 随激活回来。 */
const DELEGATION_TOOL_NAMES = ["Agent", "Task"];
const CREATE_WORKFLOW_TOKEN = "CreateWorkflow";
const DIGEST = '[data-workflow-run-digest="true"]';

let neverActivatedSession = "";
let commandActivatedSession = "";
let firstTurnActivatedSession = "";

function askMarker(tag: string): string {
  return `E2E_DWO_${tag}_ASK`;
}

/** 发一轮纯文本：等回放回答落到时间线、轮次结束，返回会话 id。 */
async function runTextTurn(prompt: string, tag: string): Promise<string> {
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(`E2E_DWO_${tag}_OK`, 60_000);
  await waitForV4Pane((pane) => !pane.canStop, `${tag}: 轮次没有结束`, 60_000);
  const { sessionId } = await getV4PaneSnapshot();
  if (!sessionId || sessionId === "draft") throw new Error(`${tag}: 没有真实 sessionId`);
  return sessionId;
}

/** 本轮标记命中的第一条主模型请求实际带的工具面。 */
async function readTurnToolSurface(tag: string) {
  const query = { lastUserMessageIncludes: [askMarker(tag)] };
  await waitForUpstreamRequest(query, `${tag}: 没有捕获到模型请求`);
  const names = await getUpstreamRequestToolNames(query);
  const descriptions = new Map<string, string>();
  for (const name of DELEGATION_TOOL_NAMES) {
    const contract = await getUpstreamRequestToolContract(query, name);
    if (contract) descriptions.set(name, JSON.stringify(contract));
  }
  return { names, descriptions };
}

async function expectDeferredSurface(tag: string) {
  const { names, descriptions } = await readTurnToolSurface(tag);
  // 正向对照：请求确实带着工具面，只是没有工作流这一组。
  expect(names).toContain("Agent");
  expect(names.filter((name) => WORKFLOW_TOOL_NAMES.includes(name))).toEqual([]);
  for (const [name, description] of descriptions) {
    expect(`${tag}/${name}:${description.includes(CREATE_WORKFLOW_TOKEN)}`).toBe(
      `${tag}/${name}:false`,
    );
  }
}

async function expectActivatedSurface(tag: string) {
  const { names, descriptions } = await readTurnToolSurface(tag);
  expect(WORKFLOW_TOOL_NAMES.filter((name) => !names.includes(name))).toEqual([]);
  expect(descriptions.has("Agent")).toBe(true);
  for (const [name, description] of descriptions) {
    expect(`${tag}/${name}:${description.includes(CREATE_WORKFLOW_TOKEN)}`).toBe(
      `${tag}/${name}:true`,
    );
  }
}

/** 完整重启后重开会话：Electron、Host 与 CLI 都是新进程，工具面只能从持久记录恢复。 */
async function reopenSession(sessionId: string) {
  if ((await getV4PaneSnapshot()).sessionId !== sessionId) {
    await selectV4TaskById(sessionId, 60_000);
  }
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `没有重新打开会话 ${sessionId}`,
    60_000,
  );
}

describe("动态工作流灰度 · onDemand", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWO-01 新会话入口都在，但模型请求里没有工作流工具，散文要求工作流也不激活", async function () {
    this.timeout(240_000);

    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("onDemand");
    expect(status.mode).toBe("onDemand");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60_000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 三个入口与 alwaysOn 相同（DWG-08）。
    await openSlashPanelWithCatalogReady();
    await waitForV4SlashOption(SLASH_WORKFLOW_OPTION_ID, 60_000);
    await closeSlashPanel();
    await setComposerDraft("");
    await openPlusMenu();
    await $(`[data-trigger="+"] [data-option-id="${PLUS_WORKFLOW_OPTION_ID}"]`).waitForDisplayed();
    await closePlusMenu();
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30_000,
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await prepareV4ConversationE2E();

    // 散文点名工作流不是触发器：激活前模型手里没有 CreateWorkflow。
    neverActivatedSession = await runTextTurn(`${askMarker("N1")} 请使用工作流处理这件事。`, "N1");
    await expectDeferredSurface("N1");
    // 技能仍可发现：命令的 `skills:` 前言要在命令运行的那一刻能加载。
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: [askMarker("N1")],
        includes: ["dynamic-workflows"],
      }),
    ).toBeGreaterThan(0);
  });

  it("DWO-02 /workflow 激活：当轮请求就带上工具与描述行，之后的轮次和压缩都不再收回", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();

    commandActivatedSession = await runTextTurn(`${askMarker("A1")} 普通的第一轮。`, "A1");
    await expectDeferredSurface("A1");

    // 激活先于 executeTurn：命令这一轮的首个模型请求就已经带着工具。
    expect(await runTextTurn(`/workflow ${askMarker("A2")} 处理这件事`, "A2")).toBe(
      commandActivatedSession,
    );
    await expectActivatedSurface("A2");

    await runTextTurn(`${askMarker("A3")} 后面的普通一轮。`, "A3");
    await expectActivatedSurface("A3");

    // 压缩关的是技能门，不关激活。
    await sendV4Prompt("/compact");
    await waitForUpstreamRequest(
      { includes: ["CRITICAL: Respond with TEXT ONLY"] },
      "/compact 没有发起摘要请求",
      60_000,
    );
    await waitForV4CompactMarker({ origin: "manual", status: "success" });
    await waitForV4Pane((pane) => !pane.canStop, "压缩轮没有结束", 60_000);
    await runTextTurn(`${askMarker("A4")} 压缩之后的一轮。`, "A4");
    await expectActivatedSurface("A4");
  });

  it("DWO-03 /workflow 作为会话首轮：工具当轮可用，真实工作流跑到完成，通知轮仍带工具", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();

    await sendV4Prompt(`/workflow ${askMarker("W1")} 跑一个记录工作流`);
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwo_w_create"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    await expectActivatedSurface("W1");

    await browser.waitUntil(
      async () =>
        browser.execute(
          (selector) =>
            document.querySelector<HTMLElement>(selector)?.dataset.workflowRunStatus ===
            "completed",
          DIGEST,
        ),
      { timeout: 120_000, timeoutMsg: "run 卡没有走到已完成" },
    );
    await waitForV4AssistantMessageContaining("E2E_DWO_W_DONE", 120_000);
    await waitForV4Pane((pane) => !pane.canStop, "终态通知轮没有结束", 60_000);
    const notified = await getUpstreamRequestToolNames({
      includes: ["toolu_dwo_w_create"],
      lastUserMessageIncludes: ["<task-notification>"],
    });
    expect(WORKFLOW_TOOL_NAMES.filter((name) => !notified.includes(name))).toEqual([]);

    const { sessionId } = await getV4PaneSnapshot();
    if (!sessionId || sessionId === "draft") throw new Error("首轮 /workflow 没有真实 sessionId");
    firstTurnActivatedSession = sessionId;
  });

  it("DWO-04 完整重启后：激活过的会话首个请求就带工具，从未激活的会话仍然没有", async function () {
    this.timeout(300_000);
    if (!neverActivatedSession || !commandActivatedSession || !firstTurnActivatedSession) {
      throw new Error("前面的用例没有留下三个会话");
    }

    await reloadElectronSessionSafely(browser);
    await pinE2ELocale("zh-CN");

    await reopenSession(commandActivatedSession);
    await runTextTurn(`${askMarker("A5")} 重启之后的一轮。`, "A5");
    await expectActivatedSurface("A5");

    await reopenSession(firstTurnActivatedSession);
    await runTextTurn(`${askMarker("W2")} 重启之后的一轮。`, "W2");
    await expectActivatedSurface("W2");

    await reopenSession(neverActivatedSession);
    await runTextTurn(`${askMarker("N2")} 重启之后的一轮。`, "N2");
    await expectDeferredSurface("N2");
  });
});

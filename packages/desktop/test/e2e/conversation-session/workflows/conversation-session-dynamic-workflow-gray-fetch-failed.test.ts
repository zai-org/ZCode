import {
  clearAppData,
  pinE2ELocale,
  readSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  getV4SlashOptionIds,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4SlashOption,
} from "#e2e/helpers/v4-conversation";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_GOAL_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  expectActivatedWorkflowToolSurface,
  expectDeferredWorkflowToolSurface,
  openAutomationsPage,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  readPlusMenuAddOptionIds,
  setComposerDraft,
} from "#e2e/helpers/dynamic-workflow-gray";

// DWG-24（请求失败档）：服务端 /client/configs 返回 HTTP 500，Host 读不到灰度配置。
// 请求失败说明不了服务端意图，「提供」按需加载（DYNAMIC_WORKFLOW_MODE_ON_FETCH_FAILURE = onDemand）：
// 三个入口都在场，但模型工具面推迟到 `/workflow`，新会话首轮不带十个工作流工具（不占上下文）。
// 与 DWG-08 disabled 档（成功响应但不下发 key → 关闭）区分。
// 服务端形状由 dynamic-workflow-config-mock-server.ts 按本文件名选档；
// 契约见 docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」
// 与「On demand: activation」。case-local 回放只固定模型回答，工具面读真实发出的模型请求。

const PLAIN_ASK = "E2E_DWG24_F1_ASK";
const WORKFLOW_ASK = "E2E_DWG24_F2_ASK";

/** 发一轮：等回放回答落到时间线、轮次结束，返回会话 id。 */
async function runTurn(prompt: string, okMarker: string): Promise<string> {
  await sendV4Prompt(prompt);
  await waitForV4AssistantMessageContaining(okMarker, 60000);
  await waitForV4Pane((pane) => !pane.canStop, `${okMarker}: 轮次没有结束`, 60000);
  const { sessionId } = await getV4PaneSnapshot();
  if (!sessionId || sessionId === "draft") throw new Error(`${okMarker}: 没有真实 sessionId`);
  return sessionId;
}

describe("动态工作流灰度请求失败（按需加载）", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWG-24 配置请求失败时入口都在，新会话首轮不带工作流工具，/workflow 当轮带上", async function () {
    this.timeout(240000);

    // 0) 证明 Host 确实请求过 case-local 网关，且这一档回的是 500（不下发任何 mode）；
    //    用户没有选过模式，入口只能来自 Host 对请求失败的裁决。
    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("fetchFailed");
    expect(status.mode).toBe(null);
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );
    expect((await readSettings()).dynamicWorkflowMode).toBeUndefined();

    // 1) `/` 面板：workflow 在场，并紧随 goal。
    await openSlashPanelWithCatalogReady();
    await waitForV4SlashOption(SLASH_WORKFLOW_OPTION_ID, 60000);
    const slashIds = await getV4SlashOptionIds();
    expect(slashIds.indexOf(SLASH_WORKFLOW_OPTION_ID)).toBe(
      slashIds.indexOf(SLASH_GOAL_OPTION_ID) + 1,
    );
    await closeSlashPanel();

    // 2) `+` 菜单：工作流在场且排在目标之后。
    await setComposerDraft("");
    await openPlusMenu();
    await $(`[data-trigger="+"] [data-option-id="${PLUS_WORKFLOW_OPTION_ID}"]`).waitForDisplayed();
    const addIds = await readPlusMenuAddOptionIds();
    expect(addIds.indexOf(PLUS_WORKFLOW_OPTION_ID)).toBe(addIds.indexOf(PLUS_GOAL_OPTION_ID) + 1);
    await closePlusMenu();

    // 3) 自动化页：「自动化 / 工作流」两个标签都在场。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "自动化页标题没有「工作流」切换",
    });
    await waitForTestIdByDom(automationsPageTabTestId("automation"), {
      timeout: 30000,
      timeoutMsg: "自动化页标题没有「自动化」切换",
    });

    // 4) 新会话普通一轮：请求带着工具面，但没有工作流工具，Agent/Task 描述没有 CreateWorkflow 行。
    await prepareV4ConversationE2E();
    const sessionId = await runTurn(`${PLAIN_ASK} 普通的第一轮。`, "E2E_DWG24_F1_OK");
    await expectDeferredWorkflowToolSurface(PLAIN_ASK);

    // 5) 同一会话发 `/workflow`：激活先于本轮执行，当轮首个模型请求就带上全部工作流工具。
    expect(await runTurn(`/workflow ${WORKFLOW_ASK} 处理这件事`, "E2E_DWG24_F2_OK")).toBe(
      sessionId,
    );
    await expectActivatedWorkflowToolSurface(WORKFLOW_ASK);

    // 6) 用户仍未选过模式：入口与工具面都不是靠写入设置得来的。
    expect((await readSettings()).dynamicWorkflowMode).toBeUndefined();
  });
});

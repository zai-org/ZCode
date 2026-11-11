import { readFile } from "node:fs/promises";
import { clearAppData, pinE2ELocale, waitForTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  getV4SlashOptionIds,
  prepareV4ConversationE2E,
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
  openAutomationsPage,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  readPlusMenuAddOptionIds,
  setComposerDraft,
} from "#e2e/helpers/dynamic-workflow-gray";

// DWG-08（alwaysOn 档）：服务端 /client/configs 下发 dynamicWorkflow.mode = "alwaysOn"，
// 三个入口同时在场——`+` 菜单的「工作流」、`/` 面板的 workflow、自动化页的「工作流」标签。
// 与 disabled 档共用同一组动作，只是断言相反；服务端形状按本文件名选档。
// 契约见 docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」。
// E2E_DWF_GRAY：只读入口，不发送 prompt；空 provider fixture 是有意的合同。
describe("动态工作流灰度命中（alwaysOn）", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  afterEach(async () => {
    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!capturePath) throw new Error("Missing provider capture evidence");
    expect(JSON.parse(await readFile(capturePath, "utf8")).records).toEqual([]);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWG-08 命中时 + 菜单、/ 面板与自动化页都提供工作流入口", async function () {
    this.timeout(180000);

    // 0) 确认本轮用的是同一台 case-local 网关，且它下发的是 alwaysOn。
    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("alwaysOn");
    expect(status.mode).toBe("alwaysOn");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 1) `/` 面板：workflow 在场，并按产品要求紧随 goal（APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 的顺序）。
    //    先用 goal 当 catalog 屏障，再在同一个面板里等 workflow 到齐，不重复改写草稿。
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

    // 3) 自动化页：标题即切换，「自动化 / 工作流」两个标签都在场。
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
  });
});

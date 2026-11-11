import { readFile } from "node:fs/promises";
import { TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import {
  clearAppData,
  pinE2ELocale,
  readSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E, startNewV4Draft } from "#e2e/helpers/v4-conversation";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_GOAL_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  expectTestIdAbsentThroughout,
  hasTestIdInDom,
  openAutomationsPage,
  openDynamicWorkflowModeSelect,
  openAgentBehaviorSettings,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  readDynamicWorkflowModeTriggerText,
  readPlusMenuAddOptionIds,
  selectDynamicWorkflowMode,
  setComposerDraft,
} from "#e2e/helpers/dynamic-workflow-gray";
import { sel } from "#e2e/helpers/selectors";

// DWG-08（disabled 档）：服务端 /client/configs 不下发 dynamicWorkflow key，
// 三个入口必须同时消失——`+` 菜单的「工作流」、`/` 面板的 workflow、自动化页的「工作流」标签。
// DWG-23（disabled 档）：服务端只给默认值，设置 › Agent 能力 › 行为与工具的模式行照样出现，用户选「始终开启」后入口回来。
// 服务端形状由 dynamic-workflow-config-mock-server.ts 按本文件名选档；
// 契约见 docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」。
// E2E_DWF_GRAY：只读入口，不发送 prompt；空 provider fixture 是有意的合同。
describe("动态工作流灰度未命中（disabled）", () => {
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

  it("DWG-08 关闭时 + 菜单、/ 面板与自动化页都没有工作流入口", async function () {
    this.timeout(180000);

    // 0) 先证明 Host 确实从 case-local 网关取过灰度快照，且这一档没有下发 key。
    //    否则后面的三个「缺席」断言可能只是证明 app 根本没连上这台 mock。
    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("disabled");
    expect(status.mode).toBe(null);
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 1) `/` 面板：catalog 已送达（goal 在场）但 workflow 被整条剔除。
    const slashIds = await openSlashPanelWithCatalogReady();
    expect(slashIds).toContain(SLASH_GOAL_OPTION_ID);
    expect(slashIds).not.toContain(SLASH_WORKFLOW_OPTION_ID);
    await closeSlashPanel();

    // 2) `+` 菜单：目标仍在（正向对照），工作流不在。菜单打开瞬间快照 catalog，
    //    上一步的屏障保证这里读到的是已送达的目录。
    await setComposerDraft("");
    await openPlusMenu();
    const addIds = await readPlusMenuAddOptionIds();
    expect(addIds).toContain(PLUS_GOAL_OPTION_ID);
    expect(addIds).not.toContain(PLUS_WORKFLOW_OPTION_ID);
    await closePlusMenu();

    // 3) 自动化页：页面渲染了，但标题退回平铺 h1——两个标签按钮都不在场，
    //    并且在观察窗内不会迟到出现。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    expect(await hasTestIdInDom(automationsPageTabTestId("workflow"))).toBe(false);
    expect(await hasTestIdInDom(automationsPageTabTestId("automation"))).toBe(false);
    await expectTestIdAbsentThroughout(automationsPageTabTestId("workflow"));
  });

  it("DWG-23 默认关闭时设置行照样出现，选「始终开启」后工作流入口回来", async function () {
    this.timeout(240000);

    // 1) 设置 › Agent 能力 › 行为与工具：服务端没下发 key，行仍在，显示「关闭」，「默认」标签只在「关闭」上。
    await openAgentBehaviorSettings();
    await browser.waitUntil(
      async () => (await readDynamicWorkflowModeTriggerText()).includes("关闭"),
      { timeout: 30000, timeoutMsg: "服务端默认关闭时动态工作流模式行没有出现或没有显示「关闭」" },
    );
    await openDynamicWorkflowModeSelect();
    const itemText = (mode: string) =>
      $(sel(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode))).getText();
    expect(await itemText("disabled")).toContain("默认");
    expect(await itemText("onDemand")).not.toContain("默认");
    expect(await itemText("alwaysOn")).not.toContain("默认");
    await browser.keys("Escape");

    // 2) 选「始终开启」：不等于默认值，所以原样写进设置文件。
    await selectDynamicWorkflowMode("alwaysOn");
    await browser.waitUntil(async () => (await readSettings()).dynamicWorkflowMode === "alwaysOn", {
      timeout: 15000,
      timeoutMsg: "选择「始终开启」没有写进设置文件",
    });

    // 3) 自动化页恢复「工作流」切换：renderer 快照已按用户选择重读。
    await openAutomationsPage();
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "选「始终开启」后自动化页没有出现「工作流」切换",
    });

    // 4) 新草稿的 + 菜单出现「工作流」：Host 已按用户选择给 CLI 重发 enabled:true 的策略。
    // Bug 根因：旧写法在 waitUntil 里反复开关 + 菜单；每次打开都会新发一次 Plugin catalog
    // 请求（约 1s），请求积压饿死新 draft 的 workspace/readPresentation，catalog 30s 内到不了。
    // 修复：与 DWG-08 相同，先用 `/` 面板等 catalog 送达，再只打开一次 + 菜单读快照。
    await startNewV4Draft();
    const slashIds = await openSlashPanelWithCatalogReady();
    expect(slashIds).toContain(SLASH_WORKFLOW_OPTION_ID);
    await closeSlashPanel();
    await openPlusMenu();
    const addIds = await readPlusMenuAddOptionIds();
    await closePlusMenu();
    expect(addIds).toContain(PLUS_GOAL_OPTION_ID);
    expect(addIds).toContain(PLUS_WORKFLOW_OPTION_ID);
  });
});

import { readFile } from "node:fs/promises";
import {
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM,
  TID_WORKFLOWS_OPEN_SETTINGS,
} from "@zcode/shared";
import { TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
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
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  expectTestIdAbsentThroughout,
  openAutomationsPage,
  openDynamicWorkflowModeSelect,
  openAgentBehaviorSettings,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  readDynamicWorkflowModeTriggerText,
  readPlusMenuAddOptionIds,
  selectDynamicWorkflowMode,
} from "#e2e/helpers/dynamic-workflow-gray";
import { sel } from "#e2e/helpers/selectors";

// DWG-23（docs/dynamic-workflow/launch.md「The user's choice」）：服务端下发 alwaysOn（文件名命中
// always-on 档），用户在设置 › Agent 能力 › 行为与工具里选「关闭」后，自动化页退回「自动化」、新草稿的 + 菜单没有工作流；
// 再选回带「默认」标签的「始终开启」，设置文件里的选择被删除（跟随服务端），工作流入口回来。
// E2E_DWF_GRAY：只读入口，不发送 prompt；空 provider fixture 是有意的合同。
describe("动态工作流用户选择（服务端 alwaysOn）", () => {
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

  it("DWG-23 设置行显示默认值；选关闭后入口消失，选回默认删除选择", async function () {
    this.timeout(240000);

    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("alwaysOn");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 1) 设置 › Agent 能力 › 行为与工具：未选择时显示服务端下发的「始终开启」，「默认」标签只在它上面。
    await openAutomationsPage();
    await $(sel(automationsPageTabTestId("workflow"))).click();
    const workflowSettings = $(sel(TID_WORKFLOWS_OPEN_SETTINGS));
    await workflowSettings.waitForDisplayed({ timeout: 30000 });
    await workflowSettings.click();
    await $(sel(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"))).waitForDisplayed();
    expect(
      await $(sel(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"))).getAttribute("aria-current"),
    ).toBe("page");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowModeTriggerText()).includes("始终开启"),
      { timeout: 30000, timeoutMsg: "动态工作流模式行没有显示服务端默认的「始终开启」" },
    );
    await openDynamicWorkflowModeSelect();
    const itemText = (mode: string) =>
      $(sel(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode))).getText();
    expect(await itemText("alwaysOn")).toContain("默认");
    expect(await itemText("onDemand")).not.toContain("默认");
    expect(await itemText("disabled")).not.toContain("默认");
    await browser.keys("Escape");

    // 2) 选「关闭」：写进设置文件，触发器立即显示「关闭」。
    await selectDynamicWorkflowMode("disabled");
    await browser.waitUntil(async () => (await readSettings()).dynamicWorkflowMode === "disabled", {
      timeout: 15000,
      timeoutMsg: "选择「关闭」没有写进设置文件",
    });
    expect(await readDynamicWorkflowModeTriggerText()).toContain("关闭");

    // 3) 自动化页退回平铺的「自动化」标题，「工作流」标签在观察窗内不出现。
    // Bug 根因：renderer 快照要等 Host 重同步完成后才重读（launch.md「How a change travels」），
    // 实测同步耗时可达 1s+；旧写法打开页面后立即做缺席观察，会撞上旧快照。
    // 修复：先等标签消失作为「快照已重读」的屏障，再在观察窗内确认不会回来。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    await $(sel(automationsPageTabTestId("workflow"))).waitForExist({
      reverse: true,
      timeout: 15000,
      timeoutMsg: "选择「关闭」后自动化页的「工作流」切换没有消失",
    });
    await expectTestIdAbsentThroughout(automationsPageTabTestId("workflow"));

    // 4) 新草稿的 + 菜单：目标仍在（正向对照），工作流不在——CLI 策略已按用户选择重发。
    // Bug 根因：旧写法在 waitUntil 里反复开关 + 菜单，每次打开都新发一次 Plugin catalog 请求，
    // 积压会饿死新 draft 的 catalog 读取；且 catalog 未送达时「没有工作流」会误判通过。
    // 修复：先用 `/` 面板等 catalog 送达，再只打开一次 + 菜单读快照。
    await startNewV4Draft();
    const slashIds = await openSlashPanelWithCatalogReady();
    expect(slashIds).not.toContain(SLASH_WORKFLOW_OPTION_ID);
    await closeSlashPanel();
    await openPlusMenu();
    const addIds = await readPlusMenuAddOptionIds();
    await closePlusMenu();
    expect(addIds).toContain(PLUS_GOAL_OPTION_ID);
    expect(addIds).not.toContain(PLUS_WORKFLOW_OPTION_ID);

    // 5) 选回带「默认」的「始终开启」：设置文件里的选择被删除（跟随服务端），工作流标签回来。
    await openAgentBehaviorSettings();
    await selectDynamicWorkflowMode("alwaysOn");
    await browser.waitUntil(async () => !("dynamicWorkflowMode" in (await readSettings())), {
      timeout: 15000,
      timeoutMsg: "选回默认模式后设置文件里仍留着 dynamicWorkflowMode",
    });
    await openAutomationsPage();
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "选回默认模式后自动化页没有恢复「工作流」切换",
    });
  });
});

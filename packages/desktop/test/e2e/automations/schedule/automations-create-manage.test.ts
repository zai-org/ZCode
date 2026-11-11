import {
  TID_AUTOMATION_ACTION_DELETE,
  TID_AUTOMATION_ACTION_TOGGLE,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CARD_MENU,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  hoverTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";
import { UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL } from "#e2e/helpers/upstream-provider";

/**
 * 定时任务「表单创建 → 编辑 → 暂停/恢复 → 删除」端到端。
 *
 * 全程只碰 UI + 本地 sqlite：不发送 prompt、不依赖模型回放，也不依赖 20s 轮询调度器，
 * 因此是确定性的。会话内 CronCreate 卡片回显路径见 conversation-session/ 下的独立用例。
 */
describe("定时任务表单创建与管理 E2E", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      console.info("[SR87 form diagnosis]", await browser.execute(() => document.body.innerText));
    }
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("表单创建后可编辑、暂停、恢复并删除", async function () {
    this.timeout(150000);

    // 公共 fixture 只建立供应商和会话选择，不承诺全局默认模型。表单自行明确选择。
    await prepareConversationE2E();

    // 1) 打开定时任务主视图。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现定时任务入口",
    });

    // 2) 默认创建按钮直接进入 UI 编辑表单；会话创建仅保留在下拉菜单。
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
      timeoutMsg: "创建定时任务主按钮没有出现",
    });

    // 表单已改用虚拟项目 Select；旧会话菜单定位会在进入业务断言前超时。
    await clickTestIdByWebDriver("automation-project-select", {
      timeoutMsg: "定时任务创建页没有项目选择器",
    });
    const workspaceMenuItems = await readWorkspaceMenuItems();
    expect(workspaceMenuItems).toEqual(["ZCodeProject"]);
    await selectWorkspaceMenuItem("ZCodeProject");
    await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER);
    await clickTestIdByWebDriver(
      testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${UPSTREAM_PROVIDER_ID}`),
    );
    await clickTestIdByWebDriver(
      testId(TID_CHAT_MODEL_SELECT_ITEM, `custom:${UPSTREAM_PROVIDER_ID}:${UPSTREAM_MODEL}`),
    );
    await clickTestIdByWebDriver(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER);
    await clickTestIdByWebDriver(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, "high"));

    // 3) 当前产品不为新建任务预置调度；显式选择项目、添加调度后才是可提交的
    // 人工创建任务。这里验证真实必填路径，避免把旧默认值当成功标准。
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "新建定时任务没有添加调度入口",
    });
    await clickTestIdByWebDriver(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
      timeoutMsg: "添加调度菜单没有出现每日频率",
    });
    const title = `E2E_AUTOMATION_${Date.now()}`;
    const editedTitle = `${title}_EDITED`;
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title, {
      timeoutMsg: "定时任务标题输入没有出现",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, "总结今天的进展并生成一份简报", {
      timeoutMsg: "定时任务 prompt 输入没有出现",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "定时任务提交按钮不可点击",
    });

    // 4) 回到列表，断言出现一张含该标题的卡片。
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeoutMsg: "创建后没有回到定时任务列表",
    });
    await browser.waitUntil(
      async () => (await automationCardTitles()).some((t) => t.includes(title)),
      {
        timeout: 15000,
        timeoutMsg: `定时任务列表没有回显新建卡片：${title}`,
      },
    );

    // 5) 点击卡片进入编辑，保存标题和 prompt 后回到列表，证明 update 与持久化回显闭环。
    await clickTestIdByDom(TID_AUTOMATION_CARD, {
      timeoutMsg: "无法点击新建任务卡片进入编辑",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, editedTitle, {
      timeoutMsg: "编辑页标题输入没有出现",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, "总结今天的进展、风险和下一步计划", {
      timeoutMsg: "编辑页 prompt 输入没有出现",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "编辑保存按钮不可点击",
    });
    await browser.waitUntil(
      async () => (await automationCardTitles()).some((text) => text.includes(editedTitle)),
      {
        timeout: 15000,
        timeoutMsg: `编辑后列表没有回显新标题：${editedTitle}`,
      },
    );

    // 6) 暂停：菜单里「暂停/恢复」文案翻转即证明 enabled 状态已切换（与语言无关）。
    // Bug 根因：桌面断点下菜单按钮只在 card group-hover 时可见，直接等待按钮
    // clickable 会把正常的 hover 交互误判为不可点击。
    await hoverTestIdByWebDriver(TID_AUTOMATION_CARD, {
      timeoutMsg: "新建的定时任务卡片不可悬停",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_CARD_MENU, {
      timeoutMsg: "卡片操作菜单没有出现",
    });
    const toggleLabelBefore = await readTestIdText(TID_AUTOMATION_ACTION_TOGGLE);
    await clickTestIdByDom(TID_AUTOMATION_ACTION_TOGGLE, {
      timeoutMsg: "卡片操作菜单没有「暂停/恢复」项",
    });
    await hoverTestIdByWebDriver(TID_AUTOMATION_CARD, {
      timeoutMsg: "停用后的定时任务卡片不可悬停",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_CARD_MENU, {
      timeoutMsg: "停用后重新打开卡片菜单失败",
    });
    await browser.waitUntil(
      async () => {
        const now = await readTestIdText(TID_AUTOMATION_ACTION_TOGGLE);
        return now.length > 0 && now !== toggleLabelBefore;
      },
      {
        timeout: 10000,
        timeoutMsg: "停用后「暂停/恢复」文案没有翻转，enabled 状态未切换",
      },
    );

    // 7) 恢复：再次执行 toggle，并确认菜单文案回到暂停前，避免旧 case 只覆盖单向停用。
    await clickTestIdByDom(TID_AUTOMATION_ACTION_TOGGLE, {
      timeoutMsg: "停用后菜单没有恢复入口",
    });
    await hoverTestIdByWebDriver(TID_AUTOMATION_CARD, {
      timeoutMsg: "恢复后的定时任务卡片不可悬停",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_CARD_MENU, {
      timeoutMsg: "恢复后重新打开卡片菜单失败",
    });
    await browser.waitUntil(
      async () => (await readTestIdText(TID_AUTOMATION_ACTION_TOGGLE)) === toggleLabelBefore,
      {
        timeout: 10000,
        timeoutMsg: "恢复后暂停/恢复文案没有回到初始状态",
      },
    );

    // 8) 删除：菜单仍打开，点删除 → 二次确认 → 卡片消失。
    await clickTestIdByDom(TID_AUTOMATION_ACTION_DELETE, {
      timeoutMsg: "卡片操作菜单没有「删除」项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await browser.waitUntil(
      async () => !(await automationCardTitles()).some((t) => t.includes(editedTitle)),
      {
        timeout: 15000,
        timeoutMsg: `删除后卡片仍然存在：${editedTitle}`,
      },
    );
  });
});

/** 读取某个 test id 元素的可见文本（用于语言无关的状态翻转断言）。 */
async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return el?.textContent?.trim() ?? "";
  }, currentTestId);
}

/** 当前列表里所有定时任务卡片的文本（含标题）。 */
async function automationCardTitles(): Promise<string[]> {
  return browser.execute((cardTid) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .filter((item) => item.dataset.testid === cardTid)
      .map((item) => item.textContent?.trim() ?? "");
  }, TID_AUTOMATION_CARD);
}

/** 读取项目选择菜单的可选行；菜单动作和搜索框不属于候选。 */
async function readWorkspaceMenuItems(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .map((item) => item.innerText.trim())
      .filter(Boolean),
  );
}

/** 从项目菜单选择当前工作区，建立人工创建任务的明确归属。 */
async function selectWorkspaceMenuItem(label: string): Promise<void> {
  // 与菜单枚举使用相同的可见文本口径，避免 WebDriver getText 对嵌套标签返回空串。
  const selected = await browser.execute((text) => {
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.innerText.trim() === text,
    );
    item?.click();
    return Boolean(item);
  }, label);
  if (!selected) throw new Error(`项目菜单没有可选择的当前工作区：${label}`);
}

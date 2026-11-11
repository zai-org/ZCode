import {
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATION_YEAR_DAY_OPTION,
  TID_AUTOMATION_YEAR_MONTH_OPTION,
  TID_AUTOMATION_YEAR_MONTHDAY,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";
import { sel } from "#e2e/helpers/selectors";

/**
 * 定时任务「自定义 → 年」内联月/日选择器端到端。
 *
 * 覆盖新增能力：Custom + 年度频率下，调度行出现月/日 pill；改月/日后调度摘要随之更新；
 * 保存后回到列表并重新进入编辑，pill 从落库的 scheduleRule.months/monthDays 复原。
 * 全程只碰 UI + 本地 sqlite（不发 prompt、不依赖调度器轮询），因此是确定性的。
 *
 * 目标值刻意选 3 月 20 日：与「今天」无关，避免默认值恰好等于目标值导致断言失真。
 */
describe("定时任务自定义年度月/日选择器 E2E", () => {
  const TARGET_MONTH = "3";
  const TARGET_DAY = "20";

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Custom+年度出现月/日选择器，改值更新摘要并可保存复原", async function () {
    this.timeout(150000);

    await prepareConversationE2E({ skipProvider: true });

    // 1) 进入定时任务主视图 → 默认 UI 创建，进入编辑表单。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现定时任务入口",
    });
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
      timeoutMsg: "创建定时任务主按钮没有出现",
    });

    // 2) 填标题 + prompt。
    const title = `E2E_AUTOMATION_YEARLY_${Date.now()}`;
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title, {
      timeoutMsg: "定时任务标题输入没有出现",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, "每年生成一次年度总结", {
      timeoutMsg: "定时任务 prompt 输入没有出现",
    });

    // 3) 先显式添加调度行。新建任务默认没有 schedule，频率选择器只属于已添加的行。
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "新建定时任务没有添加调度入口",
    });
    // 4) 「添加调度」菜单本身就是频率选择器。当前 UI 选择 Custom 后直接打开
    // 自定义重复弹窗，不会先渲染普通频率 Select；旧 case 误把已删除的中间态当作契约。
    await clickTestIdByWebDriver(testId(TID_AUTOMATION_FREQUENCY_OPTION, "custom"), {
      timeoutMsg: "添加调度菜单没有出现 Custom 选项",
    });

    // 5) 弹窗内单位切到「年」，确认。
    await selectRadixOption(
      TID_AUTOMATION_CUSTOM_UNIT_SELECT,
      testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "yearly"),
      "自定义重复弹窗没有出现「年」单位选项",
    );
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_CONFIRM, {
      timeoutMsg: "自定义重复弹窗没有出现确认按钮",
    });

    // 6) 年度独有：内联行出现月/日 pill（本次改动的核心）。
    await waitForTestIdByDom(TID_AUTOMATION_YEAR_MONTHDAY, {
      timeoutMsg: "Custom+年度没有出现月/日选择器",
    });

    // 7) 打开 pill（Radix Popover 点击即开），选月=3、日=20。
    await clickTestIdByDom(TID_AUTOMATION_YEAR_MONTHDAY, {
      timeoutMsg: "月/日选择器无法点开",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_YEAR_MONTH_OPTION, TARGET_MONTH), {
      timeoutMsg: "月份列没有出现目标月份",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_YEAR_DAY_OPTION, TARGET_DAY), {
      timeoutMsg: "日期列没有出现目标日期",
    });

    // 8) 调度摘要随所选月/日更新（describeCronBuilder → customYearly 文案，语言无关地含 20）。
    await browser.waitUntil(
      async () => {
        const preview = await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW);
        return preview.includes(TARGET_DAY) && preview.includes(TARGET_MONTH);
      },
      {
        timeout: 10000,
        timeoutMsg: "改月/日后调度摘要没有反映所选的 3 月 20 日",
      },
    );
    // pill 自身文案也应回显所选值。
    const pillText = await readTestIdText(TID_AUTOMATION_YEAR_MONTHDAY);
    expect(pillText).toContain(TARGET_DAY);
    expect(pillText).toContain(TARGET_MONTH);

    // 8) 保存 → 回到列表，出现该任务卡片。
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "定时任务提交按钮不可点击",
    });
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

    // 9) 重新进入编辑：pill 从落库的 scheduleRule（months=[3]、monthDays=[20]）复原。
    await clickTestIdByDom(TID_AUTOMATION_CARD, {
      timeoutMsg: "无法点击卡片重新进入编辑",
    });
    await waitForTestIdByDom(TID_AUTOMATION_YEAR_MONTHDAY, {
      timeoutMsg: "重新进入编辑没有复原年度月/日选择器",
    });
    const restoredPill = await readTestIdText(TID_AUTOMATION_YEAR_MONTHDAY);
    expect(restoredPill).toContain(TARGET_DAY);
    expect(restoredPill).toContain(TARGET_MONTH);
  });
});

/**
 * Radix Select 通用驱动：自定义重复弹窗的单位选择使用真实 WebDriver 点击，
 * 确保触发器即使位于滚动容器中也能先进入可交互视区。
 */
async function selectRadixOption(
  triggerTestId: string,
  itemTestId: string,
  timeoutMsg: string,
): Promise<void> {
  const trigger = $(sel(triggerTestId));
  await trigger.scrollIntoView();
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(sel(itemTestId));
  try {
    await item.scrollIntoView();
    await item.waitForClickable({ timeout: 15000 });
  } catch (error) {
    throw new Error(timeoutMsg, { cause: error });
  }
  await item.click();
}

/** 读取某个 test id 元素的可见文本。 */
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

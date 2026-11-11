import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  testId,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareConversationE2E } from "#e2e/helpers/conversation-session";

const TARGET_INTERVAL = "29";

describe("定时任务自定义长月度间隔 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("每 29 个月使用合法兼容 cron，并按 scheduleRule 保存和复原", async function () {
    this.timeout(150000);

    await prepareConversationE2E({ skipProvider: true });
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现定时任务入口",
    });
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
      timeoutMsg: "创建定时任务主按钮没有出现",
    });

    const title = `E2E_AUTOMATION_MONTHLY_${Date.now()}`;
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, title);
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, "每 29 个月生成一次长期项目复盘");
    // 新建态默认不带日程；必须从“添加日程”进入 Custom，不能依赖编辑态才存在的频率 Select。
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "定时任务创建页没有添加日程入口",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "custom"), {
      timeoutMsg: "添加日程菜单没有出现 Custom 选项",
    });

    // 回归保护：上下箭头必须驱动受控输入值，并在 0–200 边界禁用，不能只渲染图标。
    await setInputValueByTestIdDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, "199", {
      timeoutMsg: "自定义重复弹窗没有可输入的频率控件",
    });
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT, {
      timeoutMsg: "自定义重复频率的增加按钮不可点击",
    });
    await browser.waitUntil(
      async () =>
        (await readInputValueByTestId(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT)) === "200" &&
        (await isTestIdDisabled(TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT)),
      {
        timeout: 10000,
        timeoutMsg: "频率增加到 200 后没有更新数值或禁用增加按钮",
      },
    );
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT, {
      timeoutMsg: "自定义重复频率的减少按钮不可点击",
    });
    await browser.waitUntil(
      async () => (await readInputValueByTestId(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT)) === "199",
      {
        timeout: 10000,
        timeoutMsg: "频率减少后没有更新为 199",
      },
    );
    await setInputValueByTestIdDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, "0");
    await browser.waitUntil(() => isTestIdDisabled(TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT), {
      timeout: 10000,
      timeoutMsg: "频率为 0 时没有禁用减少按钮",
    });

    await setInputValueByTestIdDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, TARGET_INTERVAL, {
      timeoutMsg: "自定义重复弹窗没有可输入的频率控件",
    });
    await selectRadixOption(
      TID_AUTOMATION_CUSTOM_UNIT_SELECT,
      testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "monthly"),
      "自定义重复弹窗没有出现月单位",
    );
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_CONFIRM, {
      timeoutMsg: "自定义重复弹窗没有确认按钮",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "每 29 个月的定时任务无法提交",
    });
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeoutMsg: "创建后没有回到定时任务列表",
    });

    const record = await waitForAutomationRecordByTitle(title);
    expect(record.cronExpr).toBe("0 9 1 * *");
    expect(record.scheduleRule).toMatchObject({
      unit: "monthly",
      interval: 29,
      monthDays: [1],
      monthlyMode: "date",
    });

    // 这里只用标题定位同一记录，不断言 Card 的调度展示；展示文案由 focused test 覆盖。
    await clickAutomationCardByTitle(title);
    // 自定义间隔只存在于 Custom 弹窗；用编辑入口打开后验证 scheduleRule 的复原值。
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_REPEAT_EDIT, {
      timeoutMsg: "重新进入编辑后没有自定义重复编辑入口",
    });
    await waitForTestIdByDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, {
      timeoutMsg: "重新进入编辑后没有复原自定义重复控件",
    });
    expect(await readInputValueByTestId(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT)).toBe(
      TARGET_INTERVAL,
    );
  });
});

async function selectRadixOption(
  triggerTestId: string,
  itemTestId: string,
  timeoutMsg: string,
): Promise<void> {
  const trigger = $(`[data-testid="${triggerTestId}"]`);
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(`[data-testid="${itemTestId}"]`);
  try {
    await item.waitForClickable({ timeout: 15000 });
  } catch (error) {
    throw new Error(timeoutMsg, { cause: error });
  }
  await browser.execute((currentTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
    if (!element) return;
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  }, itemTestId);
}

async function clickAutomationCardByTitle(title: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (cardTestId, expectedTitle) => {
          const target = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`),
          ).find((card) => card.innerText.includes(expectedTitle));
          target?.click();
          return Boolean(target);
        },
        TID_AUTOMATION_CARD,
        title,
      ),
    {
      timeout: 15000,
      timeoutMsg: `没有找到刚创建的定时任务：${title}`,
    },
  );
}

interface AutomationRecord {
  cronExpr: string;
  scheduleRule: Record<string, unknown>;
}

async function waitForAutomationRecordByTitle(title: string): Promise<AutomationRecord> {
  let record: AutomationRecord | null = null;
  await browser.waitUntil(
    async () => {
      record = readAutomationRecordByTitle(title);
      return record !== null;
    },
    {
      timeout: 10000,
      timeoutMsg: `没有在 automation 数据库中找到 ${title}`,
    },
  );
  if (!record) throw new Error(`automation 数据库记录为空：${title}`);
  return record;
}

function readAutomationRecordByTitle(title: string): AutomationRecord | null {
  // Node 内置 SQLite 当前仅提供同步 DatabaseSync；E2E 每次只读一行并立即关闭。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT cron_expr, schedule_rule
         FROM automations
         WHERE title = ?`,
      )
      .get(title) as { cron_expr: string; schedule_rule: string | null } | undefined;
    if (!row?.schedule_rule) return null;
    return {
      cronExpr: row.cron_expr,
      scheduleRule: JSON.parse(row.schedule_rule) as Record<string, unknown>,
    };
  } finally {
    database.close();
  }
}

async function readInputValueByTestId(currentTestId: string): Promise<string> {
  return browser.execute((testIdValue) => {
    const element = document.querySelector(`[data-testid="${testIdValue}"]`);
    return element instanceof HTMLInputElement ? element.value : "";
  }, currentTestId);
}

async function isTestIdDisabled(currentTestId: string): Promise<boolean> {
  return browser.execute((testIdValue) => {
    const element = document.querySelector(`[data-testid="${testIdValue}"]`);
    return element instanceof HTMLButtonElement && element.disabled;
  }, currentTestId);
}

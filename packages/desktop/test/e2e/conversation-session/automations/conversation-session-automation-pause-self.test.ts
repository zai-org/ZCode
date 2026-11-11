import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_RUN_NOW,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATIONS_OPEN,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  seedSettings,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { UPSTREAM_MODEL, selectUpstreamModelById } from "#e2e/helpers/upstream-provider";

// 与同名 upstream fixture 对齐：执行轮首个响应固定调用无参数 CronPauseSelf，
// 暂停目标只能来自 Host 准入注入的本轮 automationId，不允许 fixture 传任何 id。
const MARKER = "E2E_AUTOMATION_PAUSE_SELF";
const RUN_PROMPT = `${MARKER} 检查停止条件；条件已满足时调用 CronPauseSelf 暂停本任务`;
const AUTOMATION_TITLE = "E2E_PAUSE_SELF_TASK";
const FINAL_TOKEN = "E2E_AUTOMATION_PAUSE_SELF_DONE";

describe("automation 执行轮通过 CronPauseSelf 暂停自身 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("UI 创建 → 立即运行 → CronPauseSelf → 任务转 paused → 列表卡片显示已暂停", async function () {
    this.timeout(150000);
    await waitForDefaultWorkspaceReady(90_000);

    // 卡片“已暂停 / 下次运行 / 已运行 N 次”是本 case 的可见证据；固定中文 locale。
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现定时任务入口",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU, {
      timeoutMsg: "定时任务创建下拉没有出现",
    });
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
      timeoutMsg: "创建下拉没有出现手动创建入口",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, AUTOMATION_TITLE);
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, RUN_PROMPT);
    // 账号 mock 会提供默认模型；表单明确选择 case 的回放模型，不依赖工作区默认值。
    await selectUpstreamModelById(UPSTREAM_MODEL, { afterModelItemClick: () => true });
    // 新建态默认无日程；显式添加每天，保证暂停前任务是带调度的 active 状态。
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "定时任务创建页没有添加日程入口",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
      timeoutMsg: "添加日程菜单没有每天选项",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "定时任务创建按钮不可点击",
    });

    const initialCardText = await waitForAutomationCardText(AUTOMATION_TITLE, "已运行 0 次");
    expect(initialCardText).toContain("下次运行");
    expect(initialCardText).not.toContain("已暂停");
    const createdRecord = readAutomationRecordByTitle(AUTOMATION_TITLE);
    expect(createdRecord).toMatchObject({ enabled: 1, lifecycleStatus: "active" });

    await clickAutomationCardByTitle(AUTOMATION_TITLE);
    await clickTestIdByDom(TID_AUTOMATION_RUN_NOW, {
      timeout: 15000,
      timeoutMsg: "定时任务编辑页没有立即运行按钮",
    });

    // 任务行会截断长标题；用不会被截断的稳定 marker 定位，不能拿完整 prompt 匹配可见文本。
    const taskId = await waitForTaskItemContaining(MARKER);
    await selectV4TaskById(taskId);
    await waitForV4TimelineContaining(RUN_PROMPT);
    // CronPauseSelf 按普通工具行展示，不生成任何卡片。
    await waitForToolCallBlockByToolName("CronPauseSelf", 60000);
    await waitForV4TimelineContaining(FINAL_TOKEN, 90000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskId && !snapshot.canStop,
      "定时任务执行会话没有完成",
      90000,
    );

    // 执行轮工具面：只读 CronList + 只作用于本轮的 CronPauseSelf；三个写工具必须被隐藏。
    const runRequest = { lastUserMessageIncludes: [RUN_PROMPT] };
    await waitForUpstreamRequest(runRequest, "没有捕获到定时任务立即运行的 provider 请求");
    const runToolNames = await getUpstreamRequestToolNames(runRequest);
    expect(runToolNames).toContain("CronList");
    expect(runToolNames).toContain("CronPauseSelf");
    expect(runToolNames).not.toContain("CronCreate");
    expect(runToolNames).not.toContain("CronUpdate");
    expect(runToolNames).not.toContain("CronDelete");

    // Host 条件暂停只改 enabled / lifecycle_status；manual run 的累计次数与原调度保留。
    const pausedRecord = readAutomationRecordByTitle(AUTOMATION_TITLE);
    expect(pausedRecord).toMatchObject({
      automationId: createdRecord!.automationId,
      enabled: 0,
      lifecycleStatus: "paused",
      runCount: 1,
    });
    expect(pausedRecord!.nextRunAt).toBe(createdRecord!.nextRunAt);

    // 没有推送：列表在重新挂载时读取状态，原 Card 显示“已暂停”且不再显示“下次运行”。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "执行完成后无法返回定时任务列表",
    });
    const pausedCardText = await waitForAutomationCardText(AUTOMATION_TITLE, "已暂停");
    expect(pausedCardText).toContain("已运行 1 次");
    expect(pausedCardText).not.toContain("下次运行");
  });
});

interface AutomationRecord {
  automationId: string;
  enabled: number;
  lifecycleStatus: string;
  nextRunAt: number | null;
  runCount: number;
}

function automationDatabasePath(): string {
  return join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

function readAutomationRecordByTitle(title: string): AutomationRecord | null {
  // Node 内置 SQLite 目前只提供同步 DatabaseSync；E2E 每次仅做一次只读查询并立即关闭。
  const database = new DatabaseSync(automationDatabasePath(), { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT automation_id, enabled, lifecycle_status, next_run_at, run_count
         FROM automations
         WHERE title = ?`,
      )
      .get(title) as
      | {
          automation_id: string;
          enabled: number;
          lifecycle_status: string;
          next_run_at: number | null;
          run_count: number;
        }
      | undefined;
    return row
      ? {
          automationId: row.automation_id,
          enabled: row.enabled,
          lifecycleStatus: row.lifecycle_status,
          nextRunAt: row.next_run_at,
          runCount: row.run_count,
        }
      : null;
  } finally {
    database.close();
  }
}

async function clickAutomationCardByTitle(title: string): Promise<void> {
  let latestTitles: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute(
        (cardTestId, expectedTitle) => {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`),
          );
          const target = cards.find((card) => card.innerText.includes(expectedTitle));
          target?.click();
          return { clicked: Boolean(target), titles: cards.map((card) => card.innerText) };
        },
        TID_AUTOMATION_CARD,
        title,
      );
      latestTitles = result.titles;
      return result.clicked;
    },
    {
      timeout: 15000,
      timeoutMsg: `没有找到刚创建的定时任务卡片：${title}; latest=${latestTitles.join(" | ")}`,
    },
  );
}

async function waitForAutomationCardText(title: string, expectedText: string): Promise<string> {
  let latestText = "";
  await browser.waitUntil(
    async () => {
      latestText = await browser.execute(
        (cardTestId, expectedTitle) => {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`),
          );
          return cards.find((card) => card.innerText.includes(expectedTitle))?.innerText ?? "";
        },
        TID_AUTOMATION_CARD,
        title,
      );
      return latestText.includes(expectedText);
    },
    {
      timeout: 15000,
      timeoutMsg: `定时任务 Card 未显示“${expectedText}”：${title}; latest=${latestText}`,
    },
  );
  return latestText;
}

async function waitForTaskItemContaining(title: string): Promise<string> {
  let taskId: string | null = null;
  let latestTitles: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute(
        (baseTestId, expectedTitle) => {
          const prefix = `${baseTestId}-`;
          const items = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
          );
          const target = items.find((item) => item.innerText.includes(expectedTitle));
          return {
            taskId: target?.dataset.testid?.slice(prefix.length) ?? null,
            titles: items.map((item) => item.innerText),
          };
        },
        TID_TASK_ITEM,
        title,
      );
      taskId = result.taskId;
      latestTitles = result.titles;
      return Boolean(taskId);
    },
    {
      // run_now 由当前 host 直接派发，不等待 scheduler tick。
      timeout: 12000,
      timeoutMsg: `立即运行未直接派发，12 秒内侧栏没有出现执行会话：${title}; latest=${latestTitles.join(" | ")}`,
    },
  );
  if (!taskId) throw new Error("立即运行后缺少执行会话 taskId");
  return taskId;
}

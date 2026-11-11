import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  testId,
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_OPEN,
  TID_CRON_CREATE_CARD,
  TID_CRON_CREATE_OPEN,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  expandAssistantHistoriesWithContent,
  getToolCallDiagnostics,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 与同名 upstream fixture 对齐：CronList 返回 UI 创建任务的真实 automationId，
// replay server 再把该 ID 注入 CronUpdate，禁止用固定或猜测的 ID 绕过查询链路。
const MARKER = "E2E_AUTOMATION_CRON_UPDATE";
const ORIGINAL_TITLE = "E2E_CRON_UPDATE_ORIGINAL";
const UPDATED_TITLE = "E2E_CRON_UPDATE_UPDATED";
const ORIGINAL_PROMPT = "E2E_CRON_UPDATE_ORIGINAL_PROMPT";
const UPDATED_PROMPT = "E2E_CRON_UPDATE_UPDATED_PROMPT";
const FINAL_TOKEN = "E2E_CRON_UPDATE_DONE";
const UPDATED_INTERVAL = 200;
const UPDATED_COMPATIBLE_CRON = "30 10 * * *";

describe("会话内 CronUpdate 更新既有定时任务 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("UI 创建 → CronList → CronUpdate → 更新卡片 → 同一任务详情", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    // 先通过真实 UI 创建 workspace 内的既有任务，确保 CronList 查询的不是 fixture 伪造记录。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现定时任务入口",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU, {
      timeoutMsg: "定时任务创建下拉没有出现",
    });
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
      timeoutMsg: "创建下拉没有出现手动创建入口",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, ORIGINAL_TITLE);
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, ORIGINAL_PROMPT);
    // MR 1622 后新建态默认不带日程；显式选择每天，避免依赖已移除的隐式默认 cron。
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "定时任务创建页没有添加调度入口",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
      timeoutMsg: "添加调度菜单没有每天选项",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "定时任务创建按钮不可点击",
    });
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeout: 15000,
      timeoutMsg: "创建后没有回到定时任务列表",
    });
    const originalAutomation = await waitForAutomationRecordByTitle(ORIGINAL_TITLE);

    // 普通 desktop-continuous 会话先查询真实 ID，再对同一条记录执行 patch 更新。
    // CronList 按 workspace 查询；全局草稿不属于刚才创建 Automation 的项目。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await sendV4Prompt(`${MARKER} 请先查询并更新已有的定时任务`);
    await waitForV4TimelineContaining(MARKER);
    // 自动 compact 会回收早期 tool output；在批准前按 DOM 轨迹确认只走
    // CronList → CronUpdate。真实 ID 则由 replay server 从 CronList tool_result
    // 动态注入，最终再与创建前落库的 automationId 对账。
    await waitForToolCallBlockByToolName("CronUpdate", 60000);
    await expandAssistantHistoriesWithContent();
    const pendingDiagnostics = await getToolCallDiagnostics(null);
    const pendingToolNames = pendingDiagnostics.blocks.map((block) => block.toolName);
    expect(pendingToolNames).toContain("CronList");
    expect(pendingToolNames).toContain("CronUpdate");
    expect(pendingToolNames).not.toContain("CronCreate");
    expect(pendingToolNames).not.toContain("CronDelete");
    await approveV4Permission();
    await waitForV4TimelineContaining(FINAL_TOKEN, 90000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "CronUpdate 会话没有完成",
      90000,
    );

    // 更新成功卡片复用定时任务卡片样式，但必须展示更新后的定义。
    await waitForTestIdByDom(TID_CRON_CREATE_CARD, {
      timeout: 15000,
      timeoutMsg: "CronUpdate 完成后没有渲染更新成功卡片",
    });
    const cardText = await readTestIdText(TID_CRON_CREATE_CARD);
    expect(cardText).toContain(UPDATED_TITLE);
    expect(cardText).toContain(String(UPDATED_INTERVAL));
    expect(cardText).toContain("10:30");

    const updatedAutomation = readAutomationRecordById(originalAutomation.automationId);
    expect(updatedAutomation).toMatchObject({
      automationId: originalAutomation.automationId,
      cronExpr: UPDATED_COMPATIBLE_CRON,
      prompt: UPDATED_PROMPT,
      title: UPDATED_TITLE,
      scheduleRule: {
        unit: "daily",
        interval: UPDATED_INTERVAL,
        hour: 10,
        minute: 30,
      },
    });
    expect(countAutomationRecords()).toBe(1);

    // Bug 回归：最终确认只渲染普通文本，不应把回复误投影成 text 伪文件代码块。
    expect(await countTextCodeBlocksInCardTurn()).toBe(0);

    await clickTestIdByDom(TID_CRON_CREATE_OPEN, {
      timeoutMsg: "CronUpdate 卡片没有可点击的定时任务详情按钮",
    });
    await waitForTestIdByDom(TID_AUTOMATION_FORM_TITLE, {
      timeout: 15000,
      timeoutMsg: "没有跳转到更新后的定时任务详情",
    });
    expect(await readTestIdValue(TID_AUTOMATION_FORM_TITLE)).toBe(UPDATED_TITLE);
    expect(await readTestIdValue(TID_AUTOMATION_FORM_PROMPT)).toBe(UPDATED_PROMPT);
    const schedulePreview = await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW);
    expect(schedulePreview).toContain(String(UPDATED_INTERVAL));
    expect(schedulePreview).toContain("10:30");
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_REPEAT_EDIT, {
      timeoutMsg: "CronUpdate 后没有自定义重复编辑入口",
    });
    await waitForTestIdByDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, {
      timeout: 10000,
      timeoutMsg: "CronUpdate 后没有复原 200 天的自定义间隔",
    });
    expect(await readTestIdValue(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT)).toBe(
      String(UPDATED_INTERVAL),
    );
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_CONFIRM, {
      timeoutMsg: "CronUpdate 的自定义重复编辑无法关闭",
    });
  });
});

interface AutomationRecord {
  automationId: string;
  cronExpr: string;
  prompt: string;
  scheduleRule?: Record<string, unknown>;
  title: string;
}

function automationDatabasePath(): string {
  return join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

function readAutomationRecordById(automationId: string): AutomationRecord | null {
  // Node 内置 SQLite 目前只提供同步 DatabaseSync；E2E 每次仅做一次只读查询并立即关闭。
  const database = new DatabaseSync(automationDatabasePath(), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT automation_id, title, cron_expr, prompt, schedule_rule
         FROM automations
         WHERE automation_id = ?`,
      )
      .get(automationId) as
      | {
          automation_id: string;
          cron_expr: string;
          prompt: string;
          schedule_rule: string | null;
          title: string;
        }
      | undefined;
    return row
      ? {
          automationId: row.automation_id,
          cronExpr: row.cron_expr,
          prompt: row.prompt,
          ...(row.schedule_rule
            ? {
                scheduleRule: JSON.parse(row.schedule_rule) as Record<string, unknown>,
              }
            : {}),
          title: row.title,
        }
      : null;
  } finally {
    database.close();
  }
}

async function waitForAutomationRecordByTitle(title: string): Promise<AutomationRecord> {
  let record: AutomationRecord | null = null;
  await browser.waitUntil(
    async () => {
      const database = new DatabaseSync(automationDatabasePath(), {
        readOnly: true,
      });
      try {
        const row = database
          .prepare(
            `SELECT automation_id, title, cron_expr, prompt
             FROM automations
             WHERE title = ?`,
          )
          .get(title) as
          | {
              automation_id: string;
              cron_expr: string;
              prompt: string;
              title: string;
            }
          | undefined;
        record = row
          ? {
              automationId: row.automation_id,
              cronExpr: row.cron_expr,
              prompt: row.prompt,
              title: row.title,
            }
          : null;
        return record !== null;
      } finally {
        database.close();
      }
    },
    {
      timeout: 10000,
      timeoutMsg: `没有在 automation 数据库中找到 ${title}`,
    },
  );
  if (!record) throw new Error(`automation 数据库记录为空：${title}`);
  return record;
}

function countAutomationRecords(): number {
  const database = new DatabaseSync(automationDatabasePath(), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM automations").get() as {
      count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
}

async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((testId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    return element?.innerText.trim() ?? "";
  }, currentTestId);
}

async function readTestIdValue(currentTestId: string): Promise<string> {
  return browser.execute((testId) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${testId}"]`,
    );
    return element?.value ?? "";
  }, currentTestId);
}

async function countTextCodeBlocksInCardTurn(): Promise<number> {
  return browser.execute((cardTestId) => {
    const card = document.querySelector<HTMLElement>(`[data-testid="${cardTestId}"]`);
    const turn = card?.closest<HTMLElement>("[data-turn-id]");
    return turn?.querySelectorAll('[data-language="text"]').length ?? -1;
  }, TID_CRON_CREATE_CARD);
}

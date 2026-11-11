import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  testId,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATIONS_LIST,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_CRON_CREATE_CARD,
  TID_CRON_CREATE_OPEN,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FORK,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  clickTestIdByWebDriver,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  expandAssistantHistoriesWithContent,
  getToolCallDiagnostics,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import {
  getUpstreamRequestToolContract,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  approveV4Permission,
  clickFirstV4Fork,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 与 fixtures/upstream/conversation-session/conversation-session-automation-cron-create.json 对齐：
// prompt 里的 marker 触发回放的 CronCreate 工具调用；title 是工具入参里固定的定时任务标题。
const MARKER = "E2E_AUTOMATION_CRON_CREATE";
const AUTOMATION_TITLE = "E2E_CRON_STANDUP";
const INTERVAL = 31;
const INTERVAL_MINUTE = 49;
const COMPATIBLE_CRON = "49 * * * *";

/**
 * 会话内 CronCreate → 聊天卡片 → 派生轮尾顺序 → 管理页详情 端到端。
 *
 * 模型响应走 upstream 回放（同名 fixture 自动加载），CronCreate 工具真实执行并落库；
 * 不依赖 20s 轮询调度器，因此是确定性的。
 */
describe("会话内 CronCreate 定时任务卡片与派生轮尾 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("创建定时任务 → 派生后卡片与操作栏先于分割线 → 直达任务详情", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    // 触发回放的 CronCreate 工具调用（prompt 内容不重要，靠 marker 命中 fixture）。
    await sendV4Prompt(`${MARKER} remind me every 31 hours at minute 49`);
    await waitForV4TimelineContaining(MARKER);
    // 回归边界：contract 必须真实进入 provider request；仅断言本地 ToolEntry 会漏掉
    // adapter 序列化时 description/input schema 丢失的链路问题。
    const cronCreateRequest = {
      lastUserMessageIncludes: [MARKER],
    };
    await waitForUpstreamRequest(cronCreateRequest, "没有捕获到会话内 CronCreate 的 provider 请求");
    const cronCreateContract = await getUpstreamRequestToolContract(
      cronCreateRequest,
      "CronCreate",
    );
    expect(cronCreateContract).not.toBeNull();
    const serializedCronCreateContract = JSON.stringify(cronCreateContract);
    expect(serializedCronCreateContract).toContain("must never ask the run to create");
    expect(serializedCronCreateContract).toContain(
      "do not ask it to create or schedule another automation",
    );
    // 修复原因：V4 会把 CronCreate 的副作用权限请求停在 composer dock；
    // 旧 case 直接等待 idle 会永远阻塞，必须显式批准后工具才会真实执行并落库。
    await approveV4Permission();
    const parent = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "会话内 CronCreate 没有完成",
      90000,
    );
    const parentSessionId = parent.sessionId;

    // 1) 聊天里出现 CronCreate 卡片，且显示定时任务标题（而不是回退成普通工具块）。
    // Bug 根因：完成态 V4 会把工具调用收进折叠的 assistant history；旧 case
    // 直接查询未挂载的 portal 内容，误报 CronCreate 卡片丢失。
    await expandAssistantHistoriesWithContent();
    try {
      await waitForTestIdByDom(TID_CRON_CREATE_CARD, {
        timeout: 15000,
        timeoutMsg: "会话内没有渲染 CronCreate 定时任务卡片",
      });
    } catch (error) {
      // 修复原因：专用卡片缺失时若只保留 selector 超时，无法区分 fixture 没有触发、
      // tool 投影丢失和 renderer 回退。把同一时刻的工具块/store 证据带进错误。
      const diagnostics = await getToolCallDiagnostics({
        type: "toolName",
        value: "CronCreate",
      });
      throw new Error(
        `会话内没有渲染 CronCreate 定时任务卡片；diagnostics=${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    await browser.waitUntil(
      async () => {
        const cardText = await readTestIdText(TID_CRON_CREATE_CARD);
        return (
          cardText.includes(AUTOMATION_TITLE) &&
          cardText.includes(String(INTERVAL)) &&
          cardText.includes(String(INTERVAL_MINUTE))
        );
      },
      {
        timeout: 10000,
        timeoutMsg: "CronCreate 卡片没有展示真实的每 31 小时第 49 分频率",
      },
    );
    const createdAutomation = await waitForAutomationRecordByTitle(AUTOMATION_TITLE);
    expect(createdAutomation.cronExpr).toBe(COMPATIBLE_CRON);
    expect(createdAutomation.scheduleRule).toMatchObject({
      unit: "hourly",
      interval: INTERVAL,
      minute: INTERVAL_MINUTE,
    });

    // 2) 从完成态 assistant 派生并切到 child。fork 不产生新的 provider request，
    // 所以沿用同一份确定性 fixture 即可覆盖真实会话恢复后的渲染顺序。
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== parentSessionId,
      "CronCreate 会话派生后没有切到 child session",
      60000,
    );
    await waitForV4TimelineContaining(MARKER, 30000);
    await expandAssistantHistoriesWithContent();
    await waitForTestIdByDom(TID_CRON_CREATE_CARD, {
      timeout: 15000,
      timeoutMsg: "派生会话没有恢复 CronCreate 定时任务卡片",
    });

    // Bug 根因：turnTailBoundary 虽然从工作历史中拆出，却曾在 turn-local 卡片、
    // summary 与操作栏之前渲染。这里锁定 live DOM 全序，确保“从对话中派生”始终
    // 位于 CronCreate 卡片和点赞/点踩/派生操作栏之后。
    await waitForForkTailOrder();

    // 3) 在派生会话点“去到定时任务” → 携带 automationId 进入管理页详情。
    await clickTestIdByDom(TID_CRON_CREATE_OPEN, {
      timeoutMsg: "CronCreate 卡片没有可点击的「去到定时任务」按钮",
    });

    // 修复原因：产品已改为列表 RPC 完成后直接打开目标详情；旧 case 仍等待只在 list
    // view 存在的 DOM，会把正确跳转稳定误报为失败。这里改为锁定详情标题输入的持久化值。
    await waitForTestIdByDom(TID_AUTOMATION_FORM_TITLE, {
      timeout: 15000,
      timeoutMsg: "没有跳转到会话创建的定时任务详情",
    });
    await browser.waitUntil(
      async () => (await readTestIdValue(TID_AUTOMATION_FORM_TITLE)) === AUTOMATION_TITLE,
      {
        timeout: 15000,
        timeoutMsg: `任务详情没有回显会话创建的标题：${AUTOMATION_TITLE}`,
      },
    );

    // 3.5) 回归：会话创建任务的详情页未做任何修改时，返回必须直接回列表，不得把
    // Radix Select 注册竞争发出的系统回调误判成用户修改而弹“未保存”确认框。
    // 先等权限模式选择器挂载完成，确保断言覆盖工具栏控件初始化之后的竞争窗口。
    await waitForTestIdByDom(TID_CHAT_MODE_SELECT_TRIGGER, {
      timeout: 10000,
      timeoutMsg: "任务详情没有渲染权限模式选择器",
    });
    // 详情页回退已迁到 Settings header breadcrumb；它挂载在编辑页之外，侧栏 test id
    // 在当前承载面并不存在，必须点击真实 breadcrumb 返回列表。
    await clickAutomationsBreadcrumbBack();
    expect(await hasVisibleTestId(TID_CONFIRM_DIALOG_CONFIRM)).toBe(false);
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeout: 15000,
      timeoutMsg: "无修改返回没有直接回到任务列表（疑似误弹未保存确认框）",
    });

    // 重新进入详情，继续验证只读调度摘要与调度重设闭环。
    await clickTestIdByDom(TID_AUTOMATION_CARD, {
      timeoutMsg: "返回列表后无法重新进入任务详情",
    });
    await browser.waitUntil(
      async () => (await readTestIdValue(TID_AUTOMATION_FORM_TITLE)) === AUTOMATION_TITLE,
      {
        timeout: 15000,
        timeoutMsg: `重新进入详情没有回显标题：${AUTOMATION_TITLE}`,
      },
    );

    // 4) interval carrier 的兼容 cron 虽然只是每小时候选，但详情必须优先回显权威
    // scheduleRule，不能退化为“每小时的第 49 分”。
    await waitForTestIdByDom(TID_AUTOMATION_SCHEDULE_PREVIEW, {
      timeout: 10000,
      timeoutMsg: "会话创建任务没有显示调度摘要",
    });
    const initialSchedule = await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW);
    expect(initialSchedule).toContain(String(INTERVAL));
    expect(initialSchedule).toContain(String(INTERVAL_MINUTE));
    expect(initialSchedule).not.toContain("下次运行");
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_REPEAT_EDIT, {
      timeoutMsg: "会话创建的 interval 调度没有自定义重复编辑入口",
    });
    await waitForTestIdByDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, {
      timeout: 10000,
      timeoutMsg: "会话创建的 interval 调度没有复原自定义重复间隔",
    });
    expect(await readTestIdValue(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT)).toBe(String(INTERVAL));
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_CONFIRM, {
      timeoutMsg: "会话创建的 interval 调度无法关闭自定义重复编辑",
    });

    // 5) 删除旧会话调度后进入标准 UI 添加流程，选择每天并保存。
    await clickTestIdByDom(TID_AUTOMATION_SCHEDULE_DELETE, {
      timeoutMsg: "会话创建任务的自定义调度没有删除按钮",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "删除会话调度后没有进入添加调度流程",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
      timeoutMsg: "添加调度菜单没有每天选项",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "重新设置 UI 调度后无法保存",
    });

    // 6) 再次进入详情后应恢复标准 UI 调度控件，证明新 cron 替换了旧会话 cron。
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeout: 15000,
      timeoutMsg: "保存 UI 调度后没有回到任务列表",
    });
    await clickTestIdByDom(TID_AUTOMATION_CARD, {
      timeoutMsg: "无法再次进入会话创建任务详情",
    });
    await waitForTestIdByDom(TID_AUTOMATION_FREQUENCY_SELECT, {
      timeout: 15000,
      timeoutMsg: "重设后没有恢复标准 UI 调度控件",
    });
    const updatedSchedule = await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW);
    expect(updatedSchedule).not.toBe("自定义");
  });
});

/** Settings header 的 Automations breadcrumb 是任务详情返回列表的真实入口。 */
async function clickAutomationsBreadcrumbBack(): Promise<void> {
  const buttons = await browser.$$("nav[aria-label] button");
  for (const button of buttons) {
    if (/Automations|自动化/u.test(await button.getText())) {
      await button.click();
      return;
    }
  }
  throw new Error("任务详情没有返回 Automations 列表的 breadcrumb 入口");
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
  // Node 内置 SQLite 当前只提供同步 DatabaseSync；E2E 每次仅做一行只读查询并立即关闭。
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "v2", "tasks-index.sqlite"),
    { readOnly: true },
  );
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

/** 读取某个 test id 元素的可见文本。 */
async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return el?.textContent?.trim() ?? "";
  }, currentTestId);
}

/** 某个 test id 元素当前是否挂载（用于断言确认弹窗没有出现）。 */
async function hasVisibleTestId(currentTestId: string): Promise<boolean> {
  return browser.execute(
    (tid) => Boolean(document.querySelector(`[data-testid="${tid}"]`)),
    currentTestId,
  );
}

interface ForkTailOrderSnapshot {
  cardTestId: string | null;
  dislikeTestId: string | null;
  forkActionTestId: string | null;
  boundaryRowId: string | null;
  ordered: boolean;
}

/** 等待同一 turn 内卡片、操作栏与 fork 分割线按完成态视觉顺序挂载。 */
async function waitForForkTailOrder(): Promise<void> {
  let latest: ForkTailOrderSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readForkTailOrder();
        return latest.ordered;
      },
      {
        timeout: 15000,
        timeoutMsg: "派生分割线没有落在 CronCreate 卡片和 assistant 操作栏之后",
      },
    );
  } catch (error) {
    latest = await readForkTailOrder();
    throw new Error(`派生轮尾 DOM 顺序错误；latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

/** 读取派生 child 中 CronCreate 所在 turn 的关键节点顺序。 */
async function readForkTailOrder(): Promise<ForkTailOrderSnapshot> {
  return browser.execute(
    (cardTid, dislikePrefix, forkPrefix) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (item) => item.dataset.testid === cardTid,
      );
      const turn = card?.closest<HTMLElement>("[data-turn-id]");
      const dislike = turn?.querySelector<HTMLElement>(`[data-testid^="${dislikePrefix}-"]`);
      const forkAction = turn?.querySelector<HTMLElement>(`[data-testid^="${forkPrefix}-"]`);
      const boundary = turn?.querySelector<HTMLElement>(
        '[data-row-kind="timelineMarker"][data-marker-type="forkNotice"]',
      );
      const isBefore = (first?: HTMLElement | null, second?: HTMLElement | null) =>
        Boolean(
          first &&
          second &&
          first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      return {
        cardTestId: card?.dataset.testid ?? null,
        dislikeTestId: dislike?.dataset.testid ?? null,
        forkActionTestId: forkAction?.dataset.testid ?? null,
        boundaryRowId: boundary?.dataset.rowId ?? null,
        ordered:
          isBefore(card, dislike) &&
          isBefore(dislike, forkAction) &&
          isBefore(forkAction, boundary),
      };
    },
    TID_CRON_CREATE_CARD,
    TID_V4_FEEDBACK_DISLIKE,
    TID_V4_FORK,
  );
}

/** 读取 input/textarea 的当前值，避免用 textContent 误判受控表单。 */
async function readTestIdValue(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${tid}"]`,
    );
    return element?.value ?? "";
  }, currentTestId);
}

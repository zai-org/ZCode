import {
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATIONS_LIST,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_CRON_CREATE_CARD,
  TID_CRON_CREATE_OPEN,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  seedSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// 与 fixtures/upstream/conversation-session/conversation-session-automation-cron-relative.json 对齐：
// prompt 里的 marker 触发回放的相对时间 CronCreate（delayMinutes=5、无 cron、一次性）。
const MARKER = "E2E_AUTOMATION_CRON_RELATIVE";
const AUTOMATION_TITLE = "E2E_CRON_RELATIVE_ONESHOT";

/**
 * 会话内相对时间 CronCreate（delayMinutes）→ host 换算调度落库 → 详情/列表一次性语义 端到端。
 *
 * 模型响应走 upstream 回放；CronCreate 真实执行，host 用真实时钟把 delayMinutes 换算成
 * 未来一次性调度。不等待任务真实触发（delayMinutes=5 远大于 case 时长），因此是确定性的。
 */
describe("会话内相对时间一次性定时任务 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("delayMinutes 创建一次性任务 → 详情与列表显示自定义而非重复频率", async function () {
    this.timeout(150000);

    // 该 case 的证据包含本地化后的调度摘要；显式固定中文 locale，避免 WDIO
    // 继承运行机系统语言后把同一语义渲染成 Custom，导致证明在不同开发机上漂移。
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    // 1) 触发回放的相对时间 CronCreate 并批准副作用权限，等待工具真实执行落库。
    await sendV4Prompt(`${MARKER} remind me to drink water in 5 minutes`);
    await waitForV4TimelineContaining(MARKER);
    await approveV4Permission();
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "会话内相对时间 CronCreate 没有完成",
      90000,
    );

    // 2) 聊天里出现 CronCreate 卡片并显示任务标题。
    await expandAssistantHistoriesWithContent();
    await waitForTestIdByDom(TID_CRON_CREATE_CARD, {
      timeout: 15000,
      timeoutMsg: "会话内没有渲染相对时间 CronCreate 定时任务卡片",
    });
    await browser.waitUntil(
      async () => (await readTestIdText(TID_CRON_CREATE_CARD)).includes(AUTOMATION_TITLE),
      {
        timeout: 10000,
        timeoutMsg: `CronCreate 卡片没有显示定时任务标题：${AUTOMATION_TITLE}`,
      },
    );

    // 3) 直达详情：相对时间任务由 host 生成兼容 cron + minute scheduleRule，
    // 只读摘要必须显示“自定义”，不得回显成可视化重复频率。
    await clickTestIdByDom(TID_CRON_CREATE_OPEN, {
      timeoutMsg: "CronCreate 卡片没有可点击的「去到定时任务」按钮",
    });
    await browser.waitUntil(
      async () => (await readTestIdValue(TID_AUTOMATION_FORM_TITLE)) === AUTOMATION_TITLE,
      {
        timeout: 15000,
        timeoutMsg: `任务详情没有回显会话创建的标题：${AUTOMATION_TITLE}`,
      },
    );
    await waitForTestIdByDom(TID_AUTOMATION_SCHEDULE_PREVIEW, {
      timeout: 10000,
      timeoutMsg: "相对时间任务详情没有显示只读调度摘要",
    });
    expect(await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW)).toBe("自定义");

    // 4) 回归：一次性任务详情未做任何修改，返回必须直接回列表，不弹“未保存”确认框。
    // 详情页回退已迁到 Settings header breadcrumb；它挂载在编辑页之外，侧栏 test id
    // 在当前承载面并不存在，必须点击真实 breadcrumb 返回列表。
    await clickAutomationsBreadcrumbBack();
    expect(await hasVisibleTestId(TID_CONFIRM_DIALOG_CONFIRM)).toBe(false);
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeout: 15000,
      timeoutMsg: "无修改返回没有直接回到任务列表（疑似误弹未保存确认框）",
    });

    // 5) 回归：一次性任务列表卡片显示“自定义 · 下次运行 …”，不得误显“每 5 分钟”重复。
    const badgeText = await readScheduleBadgeText();
    expect(badgeText).toContain("自定义");
    expect(badgeText).toContain("下次运行");
    expect(badgeText).not.toContain("每 ");
    const cardText = await readTestIdText(TID_AUTOMATION_CARD);
    // Card 是定时与立即运行的累计次数；一次性任务的 maxRuns 不能作为分母，避免误导用户。
    expect(cardText).toContain("已运行 0 次");
    expect(cardText).not.toContain("0/1");
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

/** 读取某个 test id 元素的可见文本。 */
async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return el?.textContent?.trim() ?? "";
  }, currentTestId);
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

/** 某个 test id 元素当前是否挂载（用于断言确认弹窗没有出现）。 */
async function hasVisibleTestId(currentTestId: string): Promise<boolean> {
  return browser.execute(
    (tid) => Boolean(document.querySelector(`[data-testid="${tid}"]`)),
    currentTestId,
  );
}

/** 读取列表卡片的调度 badge 文本（AutomationScheduleBadge 内的 schedule-text）。 */
async function readScheduleBadgeText(): Promise<string> {
  return browser.execute(
    () =>
      document
        .querySelector<HTMLElement>('[data-testid="automation-schedule-text"]')
        ?.textContent?.trim() ?? "",
  );
}

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
  TID_WORKSPACE_TITLE,
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
  countUpstreamTitleRequestsContaining,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

import { UPSTREAM_MODEL, selectUpstreamModelById } from "#e2e/helpers/upstream-provider";

const INITIAL_PROMPT = "E2E_AUTOMATION_TITLE_STABLE 这条初始指令不应被执行";
const RUN_PROMPT = "E2E_AUTOMATION_TITLE_STABLE 随机介绍一位红楼梦人物";
const AUTOMATION_TITLE = "AUTOMATION_TITLE_STABLE_TASK";
const FINAL_TOKEN = "automation-title-stable-done";
const TELEMETRY_REPORT_PATH = "/api/v1/event/report";

type JsonRecord = Record<string, unknown>;

describe("automation run keeps the first-input session title", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("UI 手动任务立即运行完成后不发起 session_title，标题保持原 prompt", async function () {
    this.timeout(150000);
    await waitForDefaultWorkspaceReady(90_000);

    // 卡片运行次数/下次运行是本 case 的可见证据；显式固定中文 locale，避免 WDIO
    // 继承英文系统语言后把“已运行 0 次”渲染为 “Ran 0 times”。
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    const telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });
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
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, INITIAL_PROMPT);
    // 账号 mock 会提供默认 GLM；表单明确选择 case 的回放模型，不能依赖工作区默认值。
    await selectUpstreamModelById(UPSTREAM_MODEL, { afterModelItemClick: () => true });
    // 新建态默认无日程；显式添加每天，确保 case 验证的是 Run now 工具边界。
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
    expect(initialCardText).not.toMatch(/已运行\s*0\s*\/\s*\d+\s*次/);
    await clickAutomationCardByTitle(AUTOMATION_TITLE);
    // 回归边界：编辑页 Run now 必须先保存当前未提交表单，再派发同一 payload，不能执行旧快照。
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, RUN_PROMPT);
    await clickTestIdByDom(TID_AUTOMATION_RUN_NOW, {
      timeout: 15000,
      timeoutMsg: "定时任务编辑页没有立即运行按钮",
    });

    const taskId = await waitForTaskItemContaining(RUN_PROMPT);
    await selectV4TaskById(taskId);
    await waitForV4TimelineContaining(RUN_PROMPT);
    await waitForV4TimelineContaining(FINAL_TOKEN);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskId && !snapshot.canStop,
      "定时任务执行会话没有完成",
      90000,
    );

    const telemetry = await waitForAutomationSessionTelemetry(telemetryFetch, taskId);
    assertAutomationSessionTelemetry(telemetry, taskId);

    // automation 执行轮只能读取任务定义；写工具必须在发给 provider 前被 turn-scoped
    // denylist 移除，避免任务在运行时自改、自删或递归创建新任务。
    const runRequest = { lastUserMessageIncludes: [RUN_PROMPT] };
    await waitForUpstreamRequest(runRequest, "没有捕获到定时任务立即运行的 provider 请求");
    const runToolNames = await getUpstreamRequestToolNames(runRequest);
    expect(runToolNames).toContain("CronList");
    expect(runToolNames).not.toContain("CronCreate");
    expect(runToolNames).not.toContain("CronUpdate");
    expect(runToolNames).not.toContain("CronDelete");

    // Bugfix 回归：旧实现会在主回复后追加 session_title 请求，并把标题改成回复里的实体。
    // 留出快速 sidecar 的完成窗口，再同时核对请求边界和两处用户可见标题投影。
    // Bug 根因：V4 task list 元数据已迁移到 taskQueryCacheStore，旧 case 仍从
    // zcodeSessionStore.taskListCache 读第三份副本，因此稳定得到 null 并误判产品失败。
    await browser.pause(1500);
    expect(await countUpstreamTitleRequestsContaining(RUN_PROMPT)).toBe(0);
    await expectHeaderTitle(RUN_PROMPT);
    await expectTaskItemTitle(taskId, RUN_PROMPT);

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "执行完成后无法返回定时任务列表",
    });
    const dispatchedCardText = await waitForAutomationCardText(AUTOMATION_TITLE, "已运行 1 次");
    expect(dispatchedCardText).toContain("下次运行");
    expect(dispatchedCardText).not.toMatch(/已运行\s*1\s*\/\s*\d+\s*次/);
  });
});

async function waitForAutomationSessionTelemetry(
  telemetryFetch: Awaited<ReturnType<typeof browser.electron.mock>>,
  taskId: string,
): Promise<JsonRecord[]> {
  let latest: JsonRecord[] = [];
  await browser.waitUntil(
    async () => {
      await telemetryFetch.update();
      latest = telemetryFetch.mock.calls
        .map((call) => parseTelemetryRequest(call))
        .filter((request): request is JsonRecord => request !== null)
        .filter((request) => request.talk_id === taskId);
      return (
        latest.some((request) => request.element_name === "agent_step") &&
        latest.some((request) => request.element_name === "session_create") &&
        latest.some((request) => request.element_name === "message_completion")
      );
    },
    {
      timeout: 30000,
      timeoutMsg: "新建定时任务立即运行后没有捕获到 agent_step / message_completion",
    },
  );
  return latest;
}

function assertAutomationSessionTelemetry(telemetry: JsonRecord[], taskId: string): void {
  const steps = telemetry.filter((request) => request.element_name === "agent_step");
  const completions = telemetry.filter((request) => request.element_name === "message_completion");
  const sends = telemetry.filter((request) => request.element_name === "send_btn");

  expect(steps.length).toBeGreaterThanOrEqual(1);
  expect(completions).toHaveLength(1);
  expect(sends).toHaveLength(0);
  const creations = telemetry.filter((request) => request.element_name === "session_create");
  expect(creations).toHaveLength(1);
  expect(creations[0]).toMatchObject({
    talk_id: taskId,
    event_extra_detail: {
      create_source: "automation_scheduled",
      client_kind: "desktop",
      workspace_kind: "local",
      remote_kind: "",
    },
  });
  expect(creations[0]!.event_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const completion = completions[0]!;
  const completionDetail = completion.event_extra_detail as JsonRecord;
  expect(completion.talk_id).toBe(taskId);
  expect(completionDetail).toMatchObject({
    message_source: "scheduled_task",
    task_trigger: "manual",
  });
  const automationId = String(completionDetail.automation_id ?? "");
  const messageId = String(completion.message_id ?? "");
  expect(creations[0]!.message_id).toBe(messageId);
  expect(automationId).not.toBe("");
  expect(messageId.startsWith(`${automationId}:manual:`)).toBe(true);

  for (const step of steps) {
    expect(step).toMatchObject({ talk_id: taskId, message_id: messageId });
    expect(step.event_extra_detail as JsonRecord).toMatchObject({
      message_source: "scheduled_task",
      task_trigger: "manual",
      automation_id: automationId,
    });
  }
  expect(completionDetail.agent_step_cnt).toBe(String(steps.length));
}

function parseTelemetryRequest(call: unknown[]): JsonRecord | null {
  const [input, init] = call;
  if (!String(input ?? "").includes(TELEMETRY_REPORT_PATH) || !isRecord(init)) return null;
  if (typeof init.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
          return {
            clicked: Boolean(target),
            titles: cards.map((card) => card.innerText),
          };
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
      // 回归边界：run_now 必须由当前 host 直接派发，不能重新等待 20 秒 scheduler tick。
      timeout: 12000,
      timeoutMsg: `立即运行未直接派发，12 秒内侧栏没有出现执行会话：${title}; latest=${latestTitles.join(" | ")}`,
    },
  );
  if (!taskId) throw new Error("立即运行后缺少执行会话 taskId");
  return taskId;
}

async function expectHeaderTitle(expectedTitle: string): Promise<void> {
  const actual = await browser.execute((titleTestId) => {
    const header = document.querySelector<HTMLElement>(`[data-testid="${titleTestId}"]`);
    return header?.getAttribute("title") ?? header?.innerText.trim() ?? null;
  }, TID_WORKSPACE_TITLE);
  expect(actual).toBe(expectedTitle);
}

async function expectTaskItemTitle(taskId: string, expectedTitle: string): Promise<void> {
  const actual = await browser.execute(
    (taskItemTestId) => {
      const item = document.querySelector<HTMLElement>(`[data-testid="${taskItemTestId}"]`);
      return item?.innerText ?? null;
    },
    testId(TID_TASK_ITEM, taskId),
  );
  expect(actual).toContain(expectedTitle);
}

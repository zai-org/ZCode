import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeCustomModelValue, resolveWorkspaceKey } from "@zcode/shared";
import {
  TID_AUTOMATION_CREATE_MANUALLY,
  TID_AUTOMATION_CREATE_MENU,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATIONS_OPEN,
  TID_CONVERSATION_SECTION,
  TID_PROJECT_SECTION,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_CONVERSATION_WORKSPACE,
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";

const CASE_TIMEOUT_MS = 150_000;
const AUTOMATION_TITLE = "AUTOMATION_UNREAD_CLEAR_TASK";
const RUN_PROMPT = "E2E_AUTOMATION_UNREAD_CLEAR 请汇报定时任务完成";
const FINAL_TOKEN = "automation-unread-clear-done";

interface TaskIndexState {
  automationId: string | null;
  taskId: string;
  unreadAt: number | null;
  workspacePath: string;
}

interface AutomationIndexState {
  automationId: string;
  workspacePath: string;
}

describe("TSL38：定时任务后台执行完成后点击清除未读", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
    try {
      console.info("[Todo88 legacy automation]", {
        definitions: database
          .prepare(
            "select automation_id, model_selection, enabled, lifecycle_status, next_run_at, dispatch_status, last_error, retry_at from automations where title = ?",
          )
          .all(AUTOMATION_TITLE),
        tasks: database
          .prepare(
            "select task_id, cron_automation_id, unread_at, workspace_path, deleted, meta_json from tasks",
          )
          .all(),
        runs: database
          .prepare(
            "select run_id, session_id, model_selection, dispatch_status, error from automation_runs",
          )
          .all(),
      });
      console.info("[Todo88 automation UI]", await browser.execute(() => document.body.innerText));
    } finally {
      database.close();
    }
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("任务空间的 scheduler 执行完成后，点击蓝点清除 UI 与 tasks-index 未读状态", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    const automationId = await createScheduledAutomationAndMakeDue();
    const taskId = await waitForScheduledBackgroundUnread(automationId);
    assertMigratedAutomationSelection(automationId);
    const requests = await getUpstreamRequestEvidence({ lastUserMessageIncludes: [RUN_PROMPT] });
    expect(
      requests.some(
        (request) => request.fixtureId === "upstream-conversation-automation-run-unread-clear-main",
      ),
    ).toBe(true);
    expect(requests.at(-1)?.requestJson).toMatchObject({
      model: UPSTREAM_MODEL,
      output_config: { effort: "high" },
    });

    // 复现目标：停留在 Automations route，等待 scheduler 真正派发后直接点击蓝点会话。
    await openUnreadTaskAndWaitUntilRead(taskId, "scheduler");
    // 运行记录能定位真实 session，但不能替代任务本身应保留的自动化归属。
    expect(readTaskIndexState(taskId)?.automationId).toBe(automationId);
  });
});

async function waitForScheduledBackgroundUnread(automationId: string): Promise<string> {
  await browser.waitUntil(() => Boolean(readLatestUnreadTaskIndexState(automationId)), {
    timeout: 35_000,
    timeoutMsg: "scheduler 定时任务执行完成后没有创建带 unread_at 的执行会话",
  });
  const state = readLatestUnreadTaskIndexState(automationId);
  if (!state) {
    throw new Error("scheduler 定时任务执行完成后缺少执行会话");
  }
  if (state.workspacePath !== DEFAULT_CONVERSATION_WORKSPACE) {
    throw new Error(
      `定时任务执行会话错误落入项目空间：expected=${DEFAULT_CONVERSATION_WORKSPACE}; actual=${state.workspacePath}`,
    );
  }
  await waitForTaskUnreadIndicator(
    state.taskId,
    true,
    "scheduler 定时任务执行完成后「任务」分区没有显示蓝点",
  );
  await assertTaskOnlyInConversationSection(state.taskId);
  return state.taskId;
}

async function openUnreadTaskAndWaitUntilRead(taskId: string, runLabel: string): Promise<void> {
  const unreadIndicator = await browser.$(
    `[data-testid="${TID_CONVERSATION_SECTION}"] [data-testid="${testId(TID_TASK_ITEM, taskId)}"] [data-unread-indicator="true"]`,
  );
  await unreadIndicator.waitForClickable({
    timeout: 15_000,
    timeoutMsg: runLabel + "定时任务执行会话的蓝点不可点击",
  });
  await unreadIndicator.click();
  await waitForV4TimelineContaining(FINAL_TOKEN, 30_000);
  await waitForTaskUnreadIndicator(taskId, false, runLabel + "点击定时任务执行会话后蓝点没有消失");
  await waitForTaskIndexState(
    taskId,
    (state) => state?.unreadAt === null,
    runLabel + "点击定时任务执行会话后 tasks-index unread_at 仍未清除",
  );
}

async function createScheduledAutomationAndMakeDue(): Promise<string> {
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
    timeoutMsg: "侧栏没有出现 Automations 入口",
  });
  await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU);
  await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
    timeoutMsg: "定时任务没有手动创建入口",
  });
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, AUTOMATION_TITLE);
  await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, RUN_PROMPT);
  await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
    timeoutMsg: "定时任务创建页没有添加日程入口",
  });
  await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
    timeoutMsg: "添加日程菜单没有每天选项",
  });
  await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
    timeoutMsg: "定时任务创建按钮不可点击",
  });
  const automation = await waitForAutomationByTitle(AUTOMATION_TITLE);
  if (automation.workspacePath !== DEFAULT_WORKSPACE) {
    throw new Error(
      `定时任务模板未绑定默认项目：expected=${DEFAULT_WORKSPACE}; actual=${automation.workspacePath}`,
    );
  }
  // 当前创建表单只接受项目；非项目遗留任务在完全退出后播种，保留未读与迁移原场景。
  // 重启后不编辑任务、不调用迁移函数，由后台首次派发导入。
  await reloadElectronSessionSafely(browser, {
    afterElectronProcessExit: async () => seedLegacyAutomationSelection(automation.automationId),
  });
  await waitForDefaultWorkspaceReady(30_000);
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN);
  // 启动时 scheduler 早于窗口 Host 就绪；到期会进入正常的 no-local-host 退避。
  // 本 case 不测该退避，只在 Host 已就绪后推进调度时间，不再改模型选择或编辑保存。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    database
      .prepare("update automations set next_run_at = ? where automation_id = ?")
      .run(Date.now(), automation.automationId);
  } finally {
    database.close();
  }
  return automation.automationId;
}

async function waitForTaskUnreadIndicator(
  taskId: string,
  expected: boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser
        .execute(
          (conversationSectionTestId, taskItemTestId) =>
            Boolean(
              document
                .querySelector<HTMLElement>('[data-testid="' + conversationSectionTestId + '"]')
                ?.querySelector('[data-testid="' + taskItemTestId + '"]')
                ?.querySelector('[data-unread-indicator="true"]'),
            ),
          TID_CONVERSATION_SECTION,
          testId(TID_TASK_ITEM, taskId),
        )
        .then((visible) => visible === expected),
    { timeout: 15_000, timeoutMsg },
  );
}

async function assertTaskOnlyInConversationSection(taskId: string): Promise<void> {
  const taskItemTestId = testId(TID_TASK_ITEM, taskId);
  const placement = await browser.execute(
    (conversationSectionTestId, projectSectionTestId, itemTestId) => ({
      inConversation: Boolean(
        document
          .querySelector(`[data-testid="${conversationSectionTestId}"]`)
          ?.querySelector(`[data-testid="${itemTestId}"]`),
      ),
      inProject: Boolean(
        document
          .querySelector(`[data-testid="${projectSectionTestId}"]`)
          ?.querySelector(`[data-testid="${itemTestId}"]`),
      ),
    }),
    TID_CONVERSATION_SECTION,
    TID_PROJECT_SECTION,
    taskItemTestId,
  );
  if (!placement.inConversation || placement.inProject) {
    throw new Error(`定时任务执行会话没有只出现在「任务」分区：${JSON.stringify(placement)}`);
  }
}

async function waitForTaskIndexState(
  taskId: string,
  predicate: (state: TaskIndexState | null) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(() => predicate(readTaskIndexState(taskId)), {
    timeout: 15_000,
    timeoutMsg,
  });
}

function readTaskIndexState(taskId: string): TaskIndexState | null {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    const row = database
      .prepare(
        `select task_id as taskId, cron_automation_id as automationId,
                unread_at as unreadAt, workspace_path as workspacePath
         from tasks where task_id = ?`,
      )
      .get(taskId) as TaskIndexState | undefined;
    return row ?? null;
  } finally {
    database.close();
  }
}

function readLatestUnreadTaskIndexState(automationId: string): TaskIndexState | null {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    const row = database
      .prepare(
        `select t.task_id as taskId, t.cron_automation_id as automationId,
                t.unread_at as unreadAt, t.workspace_path as workspacePath
         from automation_runs r join tasks t on t.task_id = r.session_id
         where r.automation_id = ? and t.unread_at is not null and t.deleted = 0
         order by r.created_at desc, t.task_id desc
         limit 1`,
      )
      .get(automationId) as TaskIndexState | undefined;
    return row ?? null;
  } finally {
    database.close();
  }
}

async function waitForAutomationByTitle(title: string): Promise<AutomationIndexState> {
  await browser.waitUntil(() => Boolean(readAutomationByTitle(title)), {
    timeout: 15_000,
    timeoutMsg: "定时任务保存后没有写入 automations 表：" + title,
  });
  const automation = readAutomationByTitle(title);
  if (!automation) {
    throw new Error("定时任务保存后缺少 automationId");
  }
  return automation;
}

function readAutomationByTitle(title: string): AutomationIndexState | null {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    const row = database
      .prepare(
        `select automation_id as automationId, workspace_path as workspacePath
         from automations where title = ?`,
      )
      .get(title) as AutomationIndexState | undefined;
    return row ?? null;
  } finally {
    database.close();
  }
}

function seedLegacyAutomationSelection(automationId: string): void {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const result = database
      .prepare(
        `update automations set next_run_at = NULL, retry_at = null, running = 0,
           provider = 'zcode', model = ?, thought_level = 'high', model_selection = NULL,
           workspace_key = ?, workspace_path = ?, workspace_identity = NULL,
           project_id = NULL, additional_directories = NULL
         where automation_id = ?`,
      )
      .run(
        encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
        resolveWorkspaceKey({ workspacePath: DEFAULT_CONVERSATION_WORKSPACE }),
        DEFAULT_CONVERSATION_WORKSPACE,
        automationId,
      );
    if (result.changes !== 1) {
      throw new Error("无法把定时任务推进到 scheduler 到期窗口：" + automationId);
    }
    // 原因：当前库已登记选择迁移完成，只写旧字段不会再次导入。
    // 夹具在完整退出后将这一项迁移恢复为待应用；仍由真实启动流程执行迁移。
    database
      .prepare("delete from tasks_schema_migration where id = ?")
      .run("0002_provider_selection");
  } finally {
    database.close();
  }
}

function assertMigratedAutomationSelection(automationId: string): void {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"));
  try {
    const row = database
      .prepare(
        "select model, provider, thought_level, model_selection from automations where automation_id = ?",
      )
      .get(automationId)!;
    const expected = {
      providerId: UPSTREAM_PROVIDER_ID,
      modelId: UPSTREAM_MODEL,
      options: { reasoningLevel: "high" },
    };
    expect(JSON.parse(String(row.model_selection))).toEqual(expected);
    expect(row).toMatchObject({
      provider: "zcode",
      model: encodeCustomModelValue(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL),
      thought_level: "high",
    });
    const run = database
      .prepare(
        "select model_selection from automation_runs where automation_id = ? order by created_at desc limit 1",
      )
      .get(automationId)!;
    expect(JSON.parse(String(run.model_selection))).toEqual(expected);
  } finally {
    database.close();
  }
}

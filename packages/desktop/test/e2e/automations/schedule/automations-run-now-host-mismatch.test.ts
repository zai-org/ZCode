import { readdir, readFile } from "node:fs/promises";
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
  DEFAULT_WORKSPACE,
  pinE2ELocale,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { UPSTREAM_MODEL, selectUpstreamModelById } from "#e2e/helpers/upstream-provider";

// 与同名 upstream fixture 对齐：首次立即运行只需一条确定性文本回复，证明正常路径可派发。
const MARKER = "E2E_AUTOMATION_RUN_NOW_HOST_MISMATCH";
const RUN_PROMPT = `${MARKER} 回复一句确认`;
const AUTOMATION_TITLE = "E2E_RUN_NOW_HOST_MISMATCH_TASK";
const FINAL_TOKEN = "automation-run-now-host-mismatch-done";
// 非本机 Host 的会话行归属；只写 tasks 行，不建 hosts / 项目行，模拟工单里会话行 host_id 不对的状态。
const FOREIGN_HOST_ID = "remote:server:e2e";
const HOST_MISMATCH_TOAST = "任务所属设备不符，无法运行";
const GENERIC_FAILED_TOAST = "触发运行失败";

describe("定时任务立即运行：会话归属不符提示 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("正常立即运行提示不变；绑定会话 host_id 非本机时提示设备不符并记录 owner 诊断", async function () {
    this.timeout(240000);
    await waitForDefaultWorkspaceReady(90_000);
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    // 首帧跟随宿主语言；seedSettings 对已启动的 renderer 无效，须用 pinE2ELocale。
    await pinE2ELocale("zh-CN");

    // 1) UI 创建一条带每日调度的手动任务。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有出现定时任务入口" });
    await clickTestIdByWebDriver(TID_AUTOMATION_CREATE_MENU, {
      timeoutMsg: "定时任务创建下拉没有出现",
    });
    await clickTestIdByDom(TID_AUTOMATION_CREATE_MANUALLY, {
      timeoutMsg: "创建下拉没有出现手动创建入口",
    });
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_TITLE, AUTOMATION_TITLE);
    await setInputValueByTestIdDom(TID_AUTOMATION_FORM_PROMPT, RUN_PROMPT);
    await selectUpstreamModelById(UPSTREAM_MODEL, { afterModelItemClick: () => true });
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "定时任务创建页没有添加日程入口",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
      timeoutMsg: "添加日程菜单没有每天选项",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "定时任务创建按钮不可点击",
    });
    await waitForAutomationCardText(AUTOMATION_TITLE, "已运行 0 次");

    // 2) 正常路径：立即运行成功派发，提示仍是「正在运行」，不出现失败提示。
    await clickAutomationCardByTitle(AUTOMATION_TITLE);
    await clickTestIdByDom(TID_AUTOMATION_RUN_NOW, {
      timeout: 15000,
      timeoutMsg: "定时任务编辑页没有立即运行按钮",
    });
    await waitForToast(`正在运行“${AUTOMATION_TITLE}”`, "正常立即运行没有出现运行中提示");
    expect((await getToastMessages()).some((text) => text.includes(GENERIC_FAILED_TOAST))).toBe(
      false,
    );
    const taskId = await waitForTaskItemContaining(MARKER);
    // 等执行轮真实结束，manual claim 释放后再重启；否则第二次触发会被判成 duplicate。
    await selectV4TaskById(taskId);
    await waitForV4TimelineContaining(FINAL_TOKEN, 90000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === taskId && !snapshot.canStop,
      "首次立即运行的执行会话没有完成",
      90000,
    );

    // 3) 重启：CLI runtime 随进程退出，下次立即运行必须冷恢复会话，才会走到
    // runtime-materialization 的目录解析。进程退出后再改库，避免旧 Host 迟到写覆盖。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => bindAutomationToForeignHostTask(AUTOMATION_TITLE, taskId),
    });
    await pinE2ELocale("zh-CN");
    expect(readTaskHostId(taskId)).toBe(FOREIGN_HOST_ID);

    // 4) 绑定会话归属不符：立即运行失败，提示具体原因而不是笼统的「触发运行失败」。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "重启后侧栏没有定时任务入口" });
    await clickAutomationCardByTitle(AUTOMATION_TITLE);
    await clickTestIdByDom(TID_AUTOMATION_RUN_NOW, {
      timeout: 15000,
      timeoutMsg: "重启后定时任务编辑页没有立即运行按钮",
    });
    await waitForToast(HOST_MISMATCH_TOAST, "会话归属不符时没有出现设备不符提示", 60000);
    expect((await getToastMessages()).some((text) => text.includes(GENERIC_FAILED_TOAST))).toBe(
      false,
    );

    // 5) 诊断：项目存储在抛错前打 warn，branch=owner 且带本次 taskId。
    await waitForHostMismatchDiagnostic(taskId);
  });
});

function tasksDatabasePath(): string {
  return join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

function bindAutomationToForeignHostTask(title: string, taskId: string): void {
  // Node 内置 SQLite 只提供同步 DatabaseSync；此处在 Electron 进程退出后的屏障内一次写入并关闭。
  const database = new DatabaseSync(tasksDatabasePath());
  try {
    const bound = database
      .prepare("UPDATE automations SET target_task_id = ? WHERE title = ?")
      .run(taskId, title);
    if (bound.changes !== 1) throw new Error(`没有找到要绑定会话的定时任务：${title}`);
    const moved = database
      .prepare("UPDATE tasks SET host_id = ? WHERE task_id = ?")
      .run(FOREIGN_HOST_ID, taskId);
    if (moved.changes < 1) throw new Error(`tasks-index 中没有执行会话行：${taskId}`);
  } finally {
    database.close();
  }
}

function readTaskHostId(taskId: string): string | null {
  const database = new DatabaseSync(tasksDatabasePath(), { readOnly: true });
  try {
    const row = database.prepare("SELECT host_id FROM tasks WHERE task_id = ?").get(taskId) as
      | { host_id: string | null }
      | undefined;
    return row?.host_id ?? null;
  } finally {
    database.close();
  }
}

async function waitForHostMismatchDiagnostic(taskId: string): Promise<void> {
  const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  expect(logDir).toBeTruthy();
  let matched: string[] = [];
  await browser.waitUntil(
    async () => {
      const files = (await readdir(logDir!)).filter((name) => name.endsWith(".log"));
      const lines = (await Promise.all(files.map((name) => readFile(join(logDir!, name), "utf8"))))
        .join("\n")
        .split("\n");
      matched = lines.filter(
        (line) => line.includes("project_storage.host_mismatch") && line.includes(taskId),
      );
      return matched.length > 0;
    },
    { timeout: 15000, timeoutMsg: `运行日志没有 host-mismatch 诊断：${taskId}` },
  );
  const diagnostic = matched.join("\n");
  // 精确断言分支：每条诊断都带 ownerHostId 字段名，只查 "owner" 区分不了 project / fork-parent 分支
  expect(diagnostic).toContain('"branch":"owner"');
  expect(diagnostic).toContain('"code":"project.host-mismatch.owner"');
  expect(diagnostic).toContain(`"rowHostId":"${FOREIGN_HOST_ID}"`);
}

async function waitForToast(expected: string, timeoutMsg: string, timeout = 20000) {
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = await getToastMessages();
      return latest.some((message) => message.includes(expected));
    },
    { timeout, timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(latest)}` },
  );
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
      timeoutMsg: `没有找到定时任务卡片：${title}; latest=${latestTitles.join(" | ")}`,
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
      timeout: 15000,
      timeoutMsg: `立即运行后侧栏没有出现执行会话：${title}; latest=${latestTitles.join(" | ")}`,
    },
  );
  if (!taskId) throw new Error("立即运行后缺少执行会话 taskId");
  return taskId;
}

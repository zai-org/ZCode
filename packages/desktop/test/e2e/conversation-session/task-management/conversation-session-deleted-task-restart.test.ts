import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4MentionOptionPrefix,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { ensureProjectExpanded, startDraftFromProject } from "#e2e/helpers/project-sidebar";

const CASE_TIMEOUT_MS = 180_000;
const PROMPT_MARKER = "E2E_DELETED_TASK_RESTART";
const REPLY_MARKER = "DELETED_TASK_RESTART_OK";

describe("TSL20：永久删除后冷启动不复活", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("真实归档/永久删除清除持久数据且重启不进入任何任务列表", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PROMPT_MARKER}: Reply with exactly "${REPLY_MARKER}" and no other text.`);
    // 提示中也有回答 marker；旧屏障在真实回答前归档并关闭 runtime，导致标题旁路报错。
    // 本例要求完成态删除，必须先观察 assistant 正文，不能把用户输入当成完成证据。
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 60_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "TSL20 前置任务没有完成",
      60_000,
    );
    const taskId = requireTaskId(completed.sessionId);
    await waitForProjectRow(taskId, true, "Project 没有显示待删除任务");

    await archiveProjectTask(taskId);
    await waitForProjectRow(taskId, false, "归档后任务仍停留在 Project");
    const archivedState = readTaskIndexState(taskId);
    expect(archivedState).toMatchObject({ archived: 1, cli_deleted: 0 });

    await toggleArchivedView();
    await waitForArchivedRow(taskId, true, "Archived 没有显示刚归档的任务");
    await deleteArchivedTask(taskId);
    await waitForArchivedRow(taskId, false, "永久删除后 Archived 仍显示任务");

    // 归档永久删除已改为物理删除；同时核对索引和正文，避免只删列表行也通过。
    expect(readTaskIndexState(taskId)).toBeNull();
    expect(readCliSessionState(taskId)).toEqual({ session: 0, message: 0, part: 0 });

    await $('[data-testid="settings-back-button"]').click();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(`${PROMPT_MARKER}: active control; reply with ${REPLY_MARKER}.`);
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 60000);
    const control = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "TSL20 普通对照任务未完成",
    );
    const controlId = requireTaskId(control.sessionId);
    expect(controlId).not.toBe(taskId);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await restartIntoWorkspacePreservingProfile();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "TSL20 冷启动没有进入 draft",
      60_000,
    );

    // 先核对持久事实，再展开列表做负向检查；删除的 CLI session 不再作为 # 候选展示。
    expect(readCliSessionState(taskId)).toEqual({ session: 0, message: 0, part: 0 });

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#", {
      stabilizeLexicalCaretAtEnd: true,
    });
    await waitForV4MentionOptionPrefix(`session:${controlId}`, 30000);
    expect(await $(`[data-option-id="session:${taskId}"]`).isExisting()).toBe(false);
    await browser.keys("Escape");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");

    // 冷启动可能恢复 workspace 折叠态；负向断言前必须展开，
    // 否则所有 task row 都未渲染会制造删除不复活的假阳性。
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    await waitForProjectRow(controlId, true, "TSL20 冷启动未恢复普通对照任务");
    await waitForProjectRow(taskId, false, "CLI summary 已恢复后 deleted task 在 Project 复活");
    await toggleArchivedView();
    await waitForArchivedRow(taskId, false, "CLI summary 已恢复后 deleted task 在 Archived 复活");
    expect(readTaskIndexState(taskId)).toBeNull();
    expect(readCliSessionState(taskId)).toEqual({ session: 0, message: 0, part: 0 });
  });
});

function requireTaskId(value: string | null): string {
  if (!value || value === "draft") {
    throw new Error(`TSL20 缺少 taskId: ${String(value)}`);
  }
  return value;
}

async function archiveProjectTask(taskId: string) {
  const row = await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  await row.moveTo();
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 15_000,
    timeoutMsg: "TSL20 归档按钮没有出现",
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => {
          const button = document.querySelector(`[data-testid="${id}"]`);
          return Boolean(button?.closest("[data-archive-confirming-task-id]"));
        },
        testId(TID_TASK_ARCHIVE, taskId),
      ),
    { timeout: 10_000, timeoutMsg: "TSL20 归档没有进入确认态" },
  );
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 10_000,
    timeoutMsg: "TSL20 归档确认按钮没有出现",
  });
}

async function toggleArchivedView() {
  await $('[data-testid="task-settings-button"]').click();
  await $('[data-testid="settings-section-nav-archives"]').click();
  await $('[data-testid="archive-management"]').waitForDisplayed();
  for (const toggle of await $$('[data-testid="archive-group-toggle"]')) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
}

async function deleteArchivedTask(taskId: string) {
  // 标题在 CLI 与 Host 可独立刷新，定位删除目标必须使用稳定 taskId，不能匹配截断标题。
  await $(
    `[data-testid="archive-task"][data-task-id="${taskId}"] [data-testid="archive-delete"]`,
  ).click();
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
    timeout: 10000,
    timeoutMsg: "TSL20 删除确认未出现",
  });
}

async function waitForProjectRow(taskId: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskItemTestId, shouldExist) =>
          Boolean(document.querySelector(`[data-testid="${taskItemTestId}"]`)) === shouldExist,
        testId(TID_TASK_ITEM, taskId),
        expected,
      ),
    { timeout: 30_000, timeoutMsg },
  );
}

async function waitForArchivedRow(taskId: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="archive-task"][data-task-id="${taskId}"]`).isExisting()) === expected,
    { timeout: 30000, timeoutMsg },
  );
}

function readTaskIndexState(taskId: string): {
  archived: number;
  cli_deleted: number;
  title: string;
} | null {
  // Node 当前内置 SQLite 只提供 DatabaseSync；E2E 每次只读一行并立即关闭句柄。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    return (database
      .prepare("select archived, cli_deleted, title from tasks where task_id = ?")
      .get(taskId) ?? null) as {
      archived: number;
      cli_deleted: number;
      title: string;
    } | null;
  } finally {
    database.close();
  }
}

function readCliSessionState(taskId: string) {
  const database = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      session: database.prepare("SELECT count(*) AS count FROM session WHERE id = ?").get(taskId)
        ?.count,
      message: database
        .prepare("SELECT count(*) AS count FROM message WHERE session_id = ?")
        .get(taskId)?.count,
      part: database.prepare("SELECT count(*) AS count FROM part WHERE session_id = ?").get(taskId)
        ?.count,
    };
  } finally {
    database.close();
  }
}

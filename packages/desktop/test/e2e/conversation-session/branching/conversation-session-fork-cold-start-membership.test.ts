import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { writeFile } from "node:fs/promises";
import { ServiceChannels } from "@zcode/shared";
import type { VirtualProject } from "@zcode/services";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import { TID_TASK_ITEM, TID_V4_COMPOSER_INPUT, testId } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import {
  clickFirstV4Fork,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Fork,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 300_000;
const PARENT_MARKER = "E2E_FORK_COLD_START_PROJECT_ROW";
const PARENT_REPLY = "FORK_COLD_START_PROJECT_ROW_OK";

describe("TSL19/TSL28/TSL41：fork child Project row 与冷启动 membership", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("fork 后无需重启即显示可点击 Project row，重启后仍能从会话目录找到 child", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PARENT_MARKER}: Reply with exactly "${PARENT_REPLY}" and no other text.`);
    await waitForV4TimelineContaining(PARENT_REPLY, 60_000);
    const parent = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "TSL19 parent 没有完成并绑定 session",
      60_000,
    );
    const parentId = requireSessionId(parent.sessionId, "parent");
    await waitForPersistedProjectTask(parentId);
    await installHandoffRpcProbe();
    const parentProject = await callHandoffHost<VirtualProject>(
      ServiceChannels.Project,
      "saveProject",
      [{ name: "Fork parent A", roots: [DEFAULT_WORKSPACE], primaryRoot: DEFAULT_WORKSPACE }],
    );
    const parentProjectId = parentProject.id;
    await callHandoffHost(ServiceChannels.Project, "moveTask", [
      { task: { workspacePath: DEFAULT_WORKSPACE, taskId: parentId }, projectId: parentProjectId },
    ]);
    expect(readTaskOwnership(parentId)?.project_id).toBe(parentProjectId);
    const otherProject = await callHandoffHost<VirtualProject>(
      ServiceChannels.Project,
      "saveProject",
      [
        {
          name: "Fork shared root B",
          roots: [DEFAULT_WORKSPACE],
          primaryRoot: DEFAULT_WORKSPACE,
        },
      ],
    );
    expect(otherProject.id).not.toBe(parentProjectId);

    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    const child = await waitForV4Pane(
      (snapshot) =>
        Boolean(
          snapshot.sessionId && snapshot.sessionId !== "draft" && snapshot.sessionId !== parentId,
        ),
      "TSL19 fork 后没有切换到 child",
      60_000,
    );
    const childId = requireSessionId(child.sessionId, "child");
    expect(readCliSession(childId)).toEqual({
      parentId,
      taskType: "fork",
    });

    // Bug 根因：fork child 的 conversation hydration 会把 pane 恢复出来，但旧 gateway
    // 没有把 hydration 后的非 draft summary 发布给 sessions-index。于是当前 pane 正常，
    // task-index syncer 却永远收不到 child，Project 只能在重启回源后补出 task row。
    // 这里必须在不重启、不续发的窗口先证明持久行和唯一 DOM row 都已出现。
    await waitForPersistedProjectTask(childId);
    // 原断言仅检查 workspace 中有行，且在全页面找 DOM，会把未归类误当成父项目。
    await assertProjectOwnership(childId, parentProjectId, otherProject.id, "after-fork");
    await waitForSingleProjectRow(
      childId,
      "TSL28 fork child hydration 后 tasks-index 已落库，但 Project 没有唯一 child row",
    );

    // 先离开 active child，再从 Project row 点回来，排除 active pane/optimistic overlay
    // 临时保留同一行造成的假绿。
    await selectV4TaskById(parentId);
    await assertProjectOwnership(childId, parentProjectId, otherProject.id, "after-leave");
    await waitForSingleProjectRow(
      childId,
      "TSL28 离开 active child 后 Project child row 消失或重复",
    );
    await selectV4TaskById(childId);
    await waitForV4TimelineContaining(PARENT_REPLY, 30_000);

    // Bug 根因：旧冷启动查询用 parent_id is null 代替 task type membership。
    // 先切回未发送 draft，避免 App 重启自动 resume 当前 child 后把缺失的冷种子掩盖掉。
    await startNewV4Draft();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "TSL19 重启前没有切回 draft",
      30_000,
    );
    await restartIntoWorkspacePreservingProfile();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "TSL19 冷启动错误恢复了 fork child",
      60_000,
    );

    // mention 目录直接读取 sessions-index；在点击 child 前先看到精确 session id，
    // 证明 parented fork 来自冷启动 membership，而不是 select 后按需 resume 才补进内存。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#", {
      timeout: 15_000,
      timeoutMsg: "TSL19 冷启动后 composer 不可输入",
    });
    expect(await waitForV4MentionOptionPrefix(`session:${childId}`, 30_000)).toBe(
      `session:${childId}`,
    );
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");
    await assertProjectOwnership(childId, parentProjectId, otherProject.id, "after-restart");

    // 首次继承之后用户移动拥有最终决定权，重复恢复不能拉回父项目。
    await installHandoffRpcProbe();
    await callHandoffHost(ServiceChannels.Project, "moveTask", [
      {
        task: { workspacePath: DEFAULT_WORKSPACE, taskId: childId },
        projectId: otherProject.id,
      },
    ]);
    await selectV4TaskById(childId);
    await waitForV4TimelineContaining(PARENT_REPLY, 30_000);
    await assertProjectOwnership(childId, otherProject.id, parentProjectId, "after-move-resume");
    await verifyMobileFork(parentId, parentProjectId, otherProject.id);
  });
});

function readTaskOwnership(taskId: string) {
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        "SELECT project_id,host_id,workspace_key,forked_from_task_id FROM tasks WHERE workspace_key=? AND task_id=?",
      )
      .get(DEFAULT_WORKSPACE, taskId) as
      | {
          project_id: string | null;
          host_id: string;
          workspace_key: string;
          forked_from_task_id: string | null;
        }
      | undefined;
  } finally {
    database.close();
  }
}

async function assertProjectOwnership(
  taskId: string,
  expectedProjectId: string,
  otherProjectId: string,
  stage: string,
) {
  const ownership = readTaskOwnership(taskId);
  await writeFile(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `fork-ownership-${stage}.json`),
    JSON.stringify({ taskId, expectedProjectId, otherProjectId, ownership }, null, 2),
  );
  expect(ownership?.project_id).toBe(expectedProjectId);
  for (const projectId of [expectedProjectId, otherProjectId]) {
    const toggle = $(`[data-project-id="${projectId}"] [data-testid="virtual-project-toggle"]`);
    await toggle.waitForExist({ timeout: 30_000 });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskTestId, expected, other) => {
          const selector = `[data-testid="${taskTestId}"]`;
          return (
            document.querySelectorAll(`[data-project-id="${expected}"] ${selector}`).length === 1 &&
            document.querySelectorAll(`[data-project-id="${other}"] ${selector}`).length === 0 &&
            document.querySelectorAll(`[data-testid="conversation-section"] ${selector}`).length ===
              0
          );
        },
        testId(TID_TASK_ITEM, taskId),
        expectedProjectId,
        otherProjectId,
      ),
    { timeout: 30_000, timeoutMsg: `TSL41 ${stage}: fork 行不在指定项目内或重复出现在其他区域` },
  );
  await browser.saveScreenshot(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `fork-ownership-${stage}.png`),
  );
}

async function waitForPersistedProjectTask(taskId: string): Promise<void> {
  await browser.waitUntil(
    () => readWorkspaceTaskIds().filter((candidate) => candidate === taskId).length === 1,
    {
      timeout: 30_000,
      timeoutMsg: `TSL28 fork child 没有写入唯一 tasks-index row: ${taskId}`,
    },
  );
}

async function waitForSingleProjectRow(taskId: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskItemTestId) =>
          document.querySelectorAll(`[data-testid="${taskItemTestId}"]`).length === 1,
        testId(TID_TASK_ITEM, taskId),
      ),
    {
      timeout: 30_000,
      timeoutMsg,
    },
  );
}

function readWorkspaceTaskIds(): string[] {
  // Node 当前内置 SQLite 只提供 DatabaseSync；E2E 轮询每次都立即关闭只读句柄。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare("select task_id from tasks where workspace_key = ? and deleted = 0 order by task_id")
      .all(DEFAULT_WORKSPACE) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  } finally {
    database.close();
  }
}

function requireSessionId(value: string | null, label: string): string {
  if (!value || value === "draft") {
    throw new Error(`TSL19 缺少 ${label} sessionId: ${String(value)}`);
  }
  return value;
}

function readCliSession(sessionId: string): {
  parentId: string | null;
  taskType: string | null;
} | null {
  // Node 当前内置 SQLite 只提供 DatabaseSync；E2E 只读一次并立即关闭句柄。
  const database = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("select parent_id, task_type from session where id = ?")
      .get(sessionId) as { parent_id: string | null; task_type: string | null } | undefined;
    return row ? { parentId: row.parent_id, taskType: row.task_type } : null;
  } finally {
    database.close();
  }
}

async function verifyMobileFork(parentId: string, projectId: string, otherProjectId: string) {
  const pairingUrl = await obtainUnreadPairingUrl(
    new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
  );
  const webBrowser = await chromium.launch({
    executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await webBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    const projectSelector = `[data-project-id="${projectId}"]`;
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
      caseMarker: "TSL41",
      phase: "fork",
      readySelector: projectSelector,
    });
    const toggle = page.locator(projectSelector).getByTestId("virtual-project-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
    await page.locator(projectSelector).getByTestId(testId(TID_TASK_ITEM, parentId)).tap();
    await page.locator(`[data-session-id="${parentId}"]`).waitFor();
    await page.locator('[data-testid^="v4-fork-"]').first().tap();
    await page.waitForFunction((parentId) => {
      const id = document.querySelector("[data-session-id]")?.getAttribute("data-session-id");
      return id && id !== "draft" && id !== parentId;
    }, parentId);
    const childId = (await page.locator("[data-session-id]").getAttribute("data-session-id"))!;
    expect(readCliSession(childId)?.parentId).toBe(parentId);
    await waitForPersistedProjectTask(childId);
    expect(readTaskOwnership(childId)?.project_id).toBe(projectId);
    await showMobileTaskHome(page);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
    await page.locator(projectSelector).getByTestId(testId(TID_TASK_ITEM, childId)).waitFor();
    expect(
      await page
        .locator(`[data-project-id="${otherProjectId}"]`)
        .getByTestId(testId(TID_TASK_ITEM, childId))
        .count(),
    ).toBe(0);
    expect(
      await page
        .locator('[data-testid="conversation-section"]')
        .getByTestId(testId(TID_TASK_ITEM, childId))
        .count(),
    ).toBe(0);
    await page.screenshot({
      path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "fork-ownership-mobile.png"),
      fullPage: true,
    });
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "fork-ownership-mobile.json"),
      JSON.stringify(
        { parentId, childId, projectId, ownership: readTaskOwnership(childId) },
        null,
        2,
      ),
    );
  } finally {
    await webBrowser.close();
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTask, ProjectTree } from "@zcode/services";
import {
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  appControlToolBlock as toolBlock,
  readAppControlToolResult,
  type AppControlToolEvidence,
} from "#e2e/helpers/app-control-evidence";
import {
  obtainUnreadPairingUrl,
  readMobileTaskView,
  waitMobileTaskView,
} from "#e2e/helpers/web-remote-unread";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  renameV4Session,
  selectV4TaskById,
  approveV4Permission,
  waitForV4PermissionDialog,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE = "E2E_SCT07";
const TITLE = "2000字小说创作";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
const evidence: Record<string, unknown> = { tools };
type SessionRef = {
  kind: "app";
  sourceServerId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  project?: { kind: "app"; sourceServerId: string; projectId: string };
};
type SessionEntry = { session: SessionRef; title: string; availableActions: string[] };
type SearchScope = {
  scopes: Array<{
    kind: "app";
    scope: "host" | "project" | "workspace";
    sourceServerId: string;
    workspacePath?: string;
  }>;
  unavailableSources: unknown[];
};

function toolResult<T>(request: unknown, id: string): T {
  return readAppControlToolResult<T>(request, id, tools);
}

async function readTree() {
  // 只读持久事实用于观测；被测发现必须经 Agent tool runner，不能用此 RPC 代替。
  return callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
}

function taskIn(tree: ProjectTree, id: string): ProjectTask {
  const task = tree.tasks.find((item) => item.taskId === id);
  if (!task) throw new Error(`SCT07 real product task missing: ${id}`);
  return task;
}

async function completedTask(marker: string) {
  await sendV4Prompt(buildReadonlyToolPrompt(marker));
  await waitForV4AssistantMessageContaining("upstream-e2e-ok", 90_000);
  const pane = await waitForV4Pane((value) => !value.canStop, "SCT07 setup task still running");
  expect(pane.sessionId).toBeTruthy();
  expect(pane.sessionId).not.toBe("draft");
  return pane.sessionId!;
}

// SCT07 accepted，候选保持 pending。同 Host 跨项目搜索结果可读取正文，并可显式打开。
// 读取保持双端焦点及未读；只有显式 open 导航桌面，手机仍持有自己的查看事实。
describe(`${CASE}: cross-project App search, read and explicit open`, () => {
  let mobile: Browser | undefined;
  let page: Page | undefined;
  after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "SCT07-search.json"), JSON.stringify(evidence, null, 2));
      await browser.saveScreenshot(join(artifacts, "SCT07-desktop.png"));
      await page?.screenshot({ path: join(artifacts, "SCT07-mobile.png") });
    }
    await mobile?.close();
    await restoreHandoffProbes();
    await clearAppData();
  });

  it("global caller searches unarchived history, reads across projects and explicitly opens only desktop", async function () {
    this.timeout(300_000);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const targetId = await completedTask(`${CASE}_TARGET`);
    await renameV4Session(TITLE);

    await startDraftFromProject(DEFAULT_WORKSPACE);
    const archivedId = await completedTask(`${CASE}_ARCHIVED`);
    await renameV4Session(`${TITLE}（已归档草稿）`);
    const archivedRow = $(`[data-testid="${testId(TID_TASK_ITEM, archivedId)}"]`);
    await archivedRow.moveTo();
    const archive = archivedRow.$(`[data-testid="${testId(TID_TASK_ARCHIVE, archivedId)}"]`);
    await archive.click();
    if (
      (await archivedRow.isExisting()) &&
      (await archivedRow.getAttribute("data-archive-confirming-task-id")) === archivedId
    )
      await archive.click();
    await archivedRow.waitForExist({ reverse: true, timeout: 30_000 });

    await startDraftFromProject(DEFAULT_WORKSPACE);
    const mobileId = await completedTask(`${CASE}_MOBILE`);
    // 通用新任务会继承当前项目；此入口才建立真正无项目归属的全局 caller。
    await $('[data-testid="virtual-project-new-task"]').click();
    await waitForV4Pane((value) => value.sessionId === "draft", "SCT07 global draft not ready");
    const callerId = await completedTask(`${CASE}_CALLER`);
    await installHandoffRpcProbe();
    await browser.waitUntil(async () => taskIn(await readTree(), targetId).title === TITLE, {
      timeout: 30_000,
      timeoutMsg: "SCT07 target title was not persisted",
    });
    const setup = await readTree();
    const target = taskIn(setup, targetId);
    const caller = taskIn(setup, callerId);
    const mobileTask = taskIn(setup, mobileId);
    expect(target.projectId).toBeTruthy();
    expect(caller.projectId).toBeNull();
    expect(caller.workspacePath).not.toBe(target.workspacePath);
    const archived = taskIn(setup, archivedId);
    expect(archived.archived).toBe(true);
    expect(archived.projectId).toBe(target.projectId);
    evidence.setup = { target, caller, mobileTask, archived };

    const pairUrl = await obtainUnreadPairingUrl();
    mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    const context = await mobile.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((credentials) => {
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    page = await context.newPage();
    await openMobilePairingPage(page, pairUrl, {
      artifactDir: artifacts,
      caseMarker: CASE,
      phase: "search",
      readySelector: '[data-testid="sidebar"]',
    });
    await page.getByTestId(testId(TID_TASK_ITEM, mobileId)).click();
    const mobileAddress = { workspacePath: mobileTask.workspacePath, taskId: mobileId };
    await waitMobileTaskView(mobileAddress);
    const mobilePane = page.locator(
      `[data-testid^="${TID_V4_SESSION_PANE}-"][data-session-id="${mobileId}"]`,
    );
    await mobilePane.waitFor();

    const targetRow = $(`[data-testid="${testId(TID_TASK_ITEM, targetId)}"]`);
    await targetRow.click({ button: "right" });
    const markUnread = $(
      '//*[@role="menuitem" and (normalize-space(.)="标记为未读" or normalize-space(.)="Mark as unread")]',
    );
    await markUnread.waitForDisplayed({ timeout: 15_000 });
    await markUnread.click();
    await browser.waitUntil(
      async () => typeof taskIn(await readTree(), targetId).unreadAt === "number",
      {
        timeout: 30_000,
        timeoutMsg: "SCT07 target unread setup missing",
      },
    );
    const before = await readTree();
    const targetBefore = taskIn(before, targetId);
    expect((await getV4PaneSnapshot()).sessionId).toBe(callerId);
    expect(await mobilePane.isVisible()).toBe(true);
    evidence.before = {
      target: targetBefore,
      desktop: callerId,
      mobile: await readMobileTaskView(),
    };

    const assertUnchanged = async (phase: string) => {
      const tree = await readTree();
      const desktop = await getV4PaneSnapshot();
      const mobileView = await readMobileTaskView();
      evidence[phase] = {
        target: taskIn(tree, targetId),
        desktop: desktop.sessionId,
        mobile: mobileView,
      };
      expect(desktop.sessionId).toBe(callerId);
      expect(mobileView.view?.taskId).toBe(mobileId);
      expect(await mobilePane.isVisible()).toBe(true);
      expect(taskIn(tree, targetId)).toEqual(targetBefore);
      expect(tree.tasks.map((task) => task.taskId).sort()).toEqual(
        before.tasks.map((task) => task.taskId).sort(),
      );
      expect(await targetRow.$('[data-unread-indicator="true"]').isExisting()).toBe(true);
    };

    await sendV4Prompt(
      `${CASE}_DISCOVER: E2E_SCT07_TARGET_SESSION_ID:${targetId}. Call ListSessions with query=小说 and no project/workspace/archived so the first search excludes archived sessions, and ListProjects with no filters. Use the actual results only. Do not read messages, send, create, or open a session. Reply exactly SCT07_DISCOVERY_RETURNED after both results.`,
    );
    await waitForV4AssistantMessageContaining("SCT07_DISCOVERY_RETURNED", 90_000);
    await waitForV4Pane((value) => !value.canStop, "SCT07 discovery still running");
    const capture = await waitForUpstreamNetworkCapture("toolu_sct07_projects");
    const listed = toolResult<{ sessions: SessionEntry[]; searchScope: SearchScope }>(
      capture.requestJson,
      "toolu_sct07_search",
    );
    const projects = toolResult<{
      projects: Array<{ project: NonNullable<SessionRef["project"]> }>;
      searchScope: SearchScope;
    }>(capture.requestJson, "toolu_sct07_projects");
    evidence.discovery = { listed, projects };
    await assertUnchanged("afterDiscovery");
    // 根因回归点：无项目 caller 的临时 workspace 曾在标题匹配前排除其他项目。
    expect(listed.sessions.map((entry) => entry.session.sessionId)).toContain(targetId);
    expect(listed.sessions.map((entry) => entry.session.sessionId)).not.toContain(archivedId);
    expect(toolBlock(capture.requestJson, "tool_use", "toolu_sct07_search").input).toEqual({
      query: "小说",
    });
    const found = listed.sessions.find((entry) => entry.session.sessionId === targetId)!;
    expect(found.title).toBe(TITLE);
    expect(found.session).toMatchObject({
      kind: "app",
      sourceServerId: "local",
      workspacePath: target.workspacePath,
      project: { projectId: target.projectId },
    });
    expect(projects.projects.map((entry) => entry.project)).toContainEqual(found.session.project);
    // 发现回执必须报告实际 Host 范围，不能把 caller 临时 workspace 当作全 App 查询。
    const expectedSearchScope = {
      scopes: [{ kind: "app", scope: "host", sourceServerId: "local" }],
      unavailableSources: [],
    };
    expect(listed.searchScope).toEqual(expectedSearchScope);
    expect(projects.searchScope).toEqual(expectedSearchScope);

    await sendV4Prompt(
      `${CASE}_FILTER: Call ListSessions with query=小说 and the exact complete project ref from the target session returned in the previous tool result. Do not infer or reconstruct any identity. Do not read, write, create or open. Reply exactly SCT07_FILTER_RETURNED after the result.`,
    );
    await waitForV4AssistantMessageContaining("SCT07_FILTER_RETURNED", 90_000);
    await waitForV4Pane((value) => !value.canStop, "SCT07 filtered search still running");
    const filteredCapture = await waitForUpstreamNetworkCapture("toolu_sct07_filter");
    const filtered = toolResult<{ sessions: SessionEntry[]; searchScope: SearchScope }>(
      filteredCapture.requestJson,
      "toolu_sct07_filter",
    );
    expect(toolBlock(filteredCapture.requestJson, "tool_use", "toolu_sct07_filter").input).toEqual({
      query: "小说",
      project: found.session.project,
    });
    expect(filtered.sessions.map((entry) => entry.session)).toContainEqual(found.session);
    expect(filtered.sessions.map((entry) => entry.session.sessionId)).not.toContain(archivedId);
    expect(
      filtered.sessions.every((entry) => entry.session.project?.projectId === target.projectId),
    ).toBe(true);
    expect(filtered.searchScope.scopes).toContainEqual(
      expect.objectContaining({ kind: "app", sourceServerId: found.session.sourceServerId }),
    );
    expect(
      filtered.searchScope.scopes.some(
        (scope) => scope.scope === "workspace" && scope.workspacePath === caller.workspacePath,
      ),
    ).toBe(false);
    expect(filtered.searchScope.unavailableSources).toEqual([]);
    evidence.filtered = filtered;
    await assertUnchanged("afterFilteredSearch");

    await sendV4Prompt(
      `${CASE}_READ: Call ReadSession with view=messages on the exact complete target ref from ListSessions. Read its history without opening, sending or creating anything. After the tool result, reply exactly SCT07_READ_RETURNED.`,
    );
    await waitForV4AssistantMessageContaining("SCT07_READ_RETURNED", 90_000);
    await waitForV4Pane((value) => !value.canStop, "SCT07 read still running");
    const readCapture = await waitForUpstreamNetworkCapture("toolu_sct07_read");
    evidence.read = toolBlock(readCapture.requestJson, "tool_result", "toolu_sct07_read");
    await assertUnchanged("afterRead");
    // 工具面只收 sessionId（规格 0.11）；ID 仍只能来自真实 list 结果，不是按标题或路径拼装。
    expect(toolBlock(readCapture.requestJson, "tool_use", "toolu_sct07_read").input).toEqual({
      sessionId: found.session.sessionId,
      view: "messages",
    });
    // 根因回归点：同 Host 已发现目标后，caller 项目墙曾让真实正文读取仍返回 forbidden。
    const history = toolResult<{
      view: "messages";
      session: SessionRef;
      messages: Array<{ role: string; text: string }>;
    }>(readCapture.requestJson, "toolu_sct07_read");
    expect(history.view).toBe("messages");
    expect(history.session).toEqual(found.session);
    expect(
      history.messages.some(
        (message) => message.role === "user" && message.text.includes(`${CASE}_TARGET`),
      ),
    ).toBe(true);
    expect(
      history.messages.some(
        (message) => message.role === "assistant" && message.text.includes("upstream-e2e-ok"),
      ),
    ).toBe(true);
    expect(found.availableActions).toEqual(expect.arrayContaining(["readSession", "openSession"]));

    await sendV4Prompt(
      `${CASE}_OPEN: Call OpenSession once on the same complete target ref. Omit uiTarget to use the trusted desktop binding. Do not send or create a session. After the result, reply exactly SCT07_OPEN_RETURNED and include the returned status.`,
    );
    await waitForV4PermissionDialog();
    expect(await approveV4Permission()).toBe(true);
    // 先取真实回执再等目标，拒绝时直接暴露工具错误，不用导航超时掩盖授权失败。
    const openCapture = await waitForUpstreamNetworkCapture("toolu_sct07_open");
    evidence.open = toolBlock(openCapture.requestJson, "tool_result", "toolu_sct07_open");
    const opened = toolResult<{ status: string }>(openCapture.requestJson, "toolu_sct07_open");
    expect(opened.status).toBe("opened");
    expect(toolBlock(openCapture.requestJson, "tool_use", "toolu_sct07_open").input).toEqual({
      sessionId: found.session.sessionId,
    });
    await waitForV4Pane(
      (value) => value.sessionId === targetId,
      "SCT07 explicit open did not navigate desktop",
    );
    await waitMobileTaskView(mobileAddress);
    expect(await mobilePane.isVisible()).toBe(true);
    expect((await getV4PaneSnapshot()).timelineText).toContain(`${CASE}_TARGET`);
    const afterOpen = await readTree();
    expect(afterOpen.tasks.map((task) => task.taskId).sort()).toEqual(
      before.tasks.map((task) => task.taskId).sort(),
    );
    evidence.afterOpen = {
      desktop: (await getV4PaneSnapshot()).sessionId,
      mobile: await readMobileTaskView(),
    };
    await browser.saveScreenshot(join(artifacts, "SCT07-open-desktop.png"));
    await page.screenshot({ path: join(artifacts, "SCT07-open-mobile.png") });
    await selectV4TaskById(callerId);
    await waitForV4AssistantMessageContaining("SCT07_OPEN_RETURNED opened", 90_000);
    evidence.assertions = {
      crossProjectDiscovery: true,
      archivedExcluded: true,
      explicitProjectFilter: true,
      readMessages: true,
      backgroundFocusAndUnreadUnchanged: true,
      openNavigatesDesktopOnly: true,
    };
  });
});

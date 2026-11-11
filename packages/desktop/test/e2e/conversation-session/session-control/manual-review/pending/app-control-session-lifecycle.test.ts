import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTask, ProjectTree } from "@zcode/services";
import { TID_TASK_ITEM, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { releaseControlledReplay, waitForControlledReplay } from "#e2e/helpers/controlled-replay";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  readAppControlToolResult,
  type AppControlToolEvidence,
} from "#e2e/helpers/app-control-evidence";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  obtainUnreadPairingUrl,
  showMobileTaskHome,
  waitMobileTaskView,
} from "#e2e/helpers/web-remote-unread";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  renameV4Session,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE = "E2E_SCT04";
const CALLER_TITLE = "SCT04 调用会话";
const TITLE = "SCT04 生命周期分叉";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
const assertions: Record<string, unknown> = {};
const evidence = { tools, assertions };
interface SessionRef {
  kind: "app";
  sourceServerId: string;
  workspacePath: string;
  sessionId: string;
  workspaceIdentity?: string;
  project?: { kind: "app"; sourceServerId: string; projectId: string };
}
interface Operation {
  session: SessionRef;
  commandId: string;
}
interface Admission {
  session: SessionRef;
  operation: Operation;
  admission: string;
  delivery: string;
}
interface Creation extends Omit<Admission, "admission"> {
  creation: string;
  firstInput: string;
}
interface History {
  view: "messages";
  session: SessionRef;
  messages: Array<{ id: string; role: string; text: string }>;
  nextCursor?: string;
}
interface Summary {
  view: "summary";
  summary: {
    session: SessionRef;
    status: string;
    executionId?: string;
    title: string;
    archived: boolean;
    pinned: boolean;
  };
}
interface Wait {
  status: string;
  operations: Array<{ operation: Operation; status: string; executionId?: string }>;
}
interface Mutation {
  status: string;
  reason?: string;
}

async function action<T>(key: string, intent: string, approval = false): Promise<T> {
  await sendV4Prompt(
    `${CASE}_ACTION_${key.toUpperCase()}: ${intent} Use complete identities from the earlier actual tool results. Do not navigate or invent a result. After the tool returns reply exactly SCT04_${key.toUpperCase()}_RETURNED.`,
  );
  if (approval) expect(await approveV4Permission()).toBe(true);
  await waitForV4AssistantMessageContaining(`SCT04_${key.toUpperCase()}_RETURNED`, 90_000);
  await waitForV4Pane((value) => !value.canStop, `SCT04 ${key} caller has not completed`);
  const request = (await waitForUpstreamNetworkCapture(`toolu_sct04_${key}`)).requestJson;
  return readAppControlToolResult<T>(request, `toolu_sct04_${key}`, tools);
}
async function mutate(key: string, intent: string) {
  const result = await action<Mutation>(key, intent, true);
  expect(result.status).toBe("applied");
  return result;
}
async function readTask(id: string): Promise<ProjectTask> {
  // 只读 owner 的持久组织事实；被测动作全部来自真实 Agent 工具。
  const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
  const task = tree.tasks.find((value) => value.taskId === id);
  if (!task) throw new Error(`SCT04 product task absent: ${id}`);
  return task;
}
function expectOperation(result: Wait, operation: Operation, status: string) {
  expect(
    result.operations.find((value) => value.operation.commandId === operation.commandId),
  ).toMatchObject({ operation, status });
}
async function selectMobile(page: Page, id: string) {
  await showMobileTaskHome(page);
  for (const toggle of await page.getByTestId("virtual-project-toggle").all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  await page.getByTestId(testId(TID_TASK_ITEM, id)).click();
  await page.locator(`[data-testid^="${TID_V4_SESSION_PANE}-"][data-session-id="${id}"]`).waitFor();
}

// SCT02/04/05/06 accepted；真实工具链候选保持 pending，不以 fixture 文本当工具证据。
describe(`${CASE}: App session lifecycle through actual tools`, () => {
  let mobile: Browser | undefined;
  let page: Page | undefined;
  after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "SCT04-lifecycle.json"), JSON.stringify(evidence, null, 2));
      await browser.saveScreenshot(join(artifacts, "SCT04-desktop.png"));
      await page?.screenshot({ path: join(artifacts, "SCT04-mobile.png") });
    }
    await mobile?.close();
    await restoreHandoffProbes();
    await clearAppData();
  });

  it("creates, queues, waits, forks stable history, organizes and guards interruption on desktop and 390px mobile", async function () {
    this.timeout(900_000);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(buildReadonlyToolPrompt(`${CASE}_CALLER`));
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 90_000);
    const caller = await waitForV4Pane(
      (value) => !value.canStop && value.sessionId !== "draft",
      "SCT04 caller missing",
    );
    const callerId = caller.sessionId!;
    await renameV4Session(CALLER_TITLE);
    await installHandoffRpcProbe();
    await browser.waitUntil(async () => (await readTask(callerId)).title === CALLER_TITLE, {
      timeout: 30_000,
      timeoutMsg: "SCT04 caller title not durable",
    });

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
      phase: "lifecycle",
      readySelector: '[data-testid="sidebar"]',
    });
    await selectMobile(page, callerId);
    const assertBackground = async () => {
      expect((await getV4PaneSnapshot()).sessionId).toBe(callerId);
      await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId });
    };

    const projects = await action<{
      projects: Array<{ project: NonNullable<SessionRef["project"]> }>;
    }>("projects", "Call ListProjects with query=ZCodeProject.");
    expect(projects.projects).toHaveLength(1);
    const created = await action<Creation>(
      "create",
      "Call CreateSession in that project with prompt E2E_SCT04_CREATE_TARGET (step marker E2E_SCT04_CREATE; do not pass requestId).",
      true,
    );
    expect(created).toMatchObject({
      creation: "created",
      firstInput: "accepted",
      delivery: "start_now",
    });
    expect(created.session.project).toEqual(projects.projects[0]!.project);
    expect(created.session.sessionId).not.toBe(callerId);
    expect(created.operation.session).toEqual(created.session);
    expect(created.operation.commandId).toBeTruthy();
    await browser.waitUntil(
      async () =>
        (await readTask(created.session.sessionId)).projectId ===
        created.session.project!.projectId,
      { timeout: 30_000 },
    );
    await assertBackground();
    // 接纳后仍可能在初始化 MCP；等待目标真实进入受控流，才能断言 running 而非 accepted。
    await waitForControlledReplay("sct04-create-target");

    const sent = await action<Admission>(
      "send",
      "Call SendToSession on the created session with prompt E2E_SCT04_SEND_TARGET (step marker E2E_SCT04_SEND; do not pass requestId).",
      true,
    );
    expect(sent).toMatchObject({
      admission: "accepted",
      delivery: "queued",
      session: created.session,
    });
    expect(sent.operation.session).toEqual(created.session);
    expect(sent.operation.commandId).not.toBe(created.operation.commandId);
    const pending = await action<Wait>(
      "pending",
      "Call WaitSessions for both create and send operations with mode=all and timeoutMs=0.",
    );
    expect(pending.status).toBe("timed_out");
    expectOperation(pending, created.operation, "running");
    expectOperation(pending, sent.operation, "queued");
    await assertBackground();
    assertions.createAndQueue = { created, sent, pending, desktop: callerId, mobile: callerId };
    await releaseControlledReplay("sct04-create-target");
    const completed = await action<Wait>(
      "completed",
      "Call WaitSessions for those two exact operations, mode=all, timeoutMs=30000.",
    );
    expect(completed.status).toBe("completed");
    expectOperation(completed, created.operation, "completed");
    expectOperation(completed, sent.operation, "completed");
    assertions.exactCompletion = completed;

    const first = await action<History>(
      "page",
      "Call ReadSession on the created session, view=messages, limit=1.",
    );
    expect(first.session).toEqual(created.session);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ role: "user", text: "E2E_SCT04_CREATE_TARGET" });
    expect(first.nextCursor).toBe(first.messages[0]!.id);
    const second = await action<History>(
      "page2",
      "Call ReadSession on the same session, view=messages, limit=200, cursor equal to the previous nextCursor.",
    );
    expect(second.session).toEqual(created.session);
    expect(tools.toolu_sct04_page2!.call.input!.cursor).toBe(first.nextCursor);
    expect(second.nextCursor).toBeUndefined();
    const allMessages = [...first.messages, ...second.messages];
    expect(new Set(allMessages.map((message) => message.id)).size).toBe(allMessages.length);
    for (const marker of ["E2E_SCT04_CREATE_TARGET", "E2E_SCT04_SEND_TARGET"]) {
      expect(
        allMessages.filter((message) => message.role === "user" && message.text === marker),
      ).toHaveLength(1);
    }
    // 真实历史包含 model-only 消息，不能假定首轮 assistant 紧随用户消息。
    const boundary = second.messages.find(
      (message) => message.role === "assistant" && message.text.includes("SCT04_CREATE_DONE"),
    );
    expect(boundary).toBeDefined();
    expect(second.messages.find((message) => message.role === "assistant")?.id).toBe(boundary!.id);
    expect(
      second.messages.some(
        (message) => message.role === "assistant" && message.text.includes("SCT04_SEND_DONE"),
      ),
    ).toBe(true);
    assertions.paginationAndUniqueDelivery = { first, second, boundary };

    const fork = await action<{ status: string; session: SessionRef }>(
      "fork",
      "Call ForkSession on the created session at the assistant message containing SCT04_CREATE_DONE from the SECOND page (step marker E2E_SCT04_FORK; do not pass requestId).",
      true,
    );
    expect(tools.toolu_sct04_fork!.call.input!.atMessage).toBe(boundary!.id);
    expect(fork.status).toBe("created");
    expect(fork.session.sessionId).not.toBe(created.session.sessionId);
    expect(fork.session.project).toEqual(created.session.project);
    const history = await action<History>(
      "fork_history",
      "Call ReadSession on the returned fork, view=messages, limit=20.",
    );
    expect(history.session).toEqual(fork.session);
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: first.messages[0]!.text }),
        expect.objectContaining({ role: "assistant", text: boundary!.text }),
      ]),
    );
    expect(JSON.stringify(history.messages)).not.toContain("E2E_SCT04_SEND_TARGET");
    await assertBackground();
    assertions.stableFork = { fork, history };

    const run = await action<Admission>(
      "run",
      "Call SendToSession on the fork, prompt=E2E_SCT04_INTERRUPT_TARGET (step marker E2E_SCT04_RUN; do not pass requestId).",
      true,
    );
    expect(run).toMatchObject({
      session: fork.session,
      admission: "accepted",
      delivery: "start_now",
    });
    const running = await action<Summary>("running", "Call ReadSession on the fork, view=summary.");
    expect(running.summary.status).toBe("running");
    expect(running.summary.executionId).toBeTruthy();
    await mutate(
      "rename",
      "Call RenameSession on the fork, title=SCT04 生命周期分叉 (step marker E2E_SCT04_RENAME; do not pass requestId).",
    );
    await mutate(
      "pin",
      "Call SetSessionPinned on the fork, pinned=true (step marker E2E_SCT04_PIN; do not pass requestId).",
    );
    const rowId = testId(TID_TASK_ITEM, fork.session.sessionId);
    await browser.waitUntil(
      async () => {
        const task = await readTask(fork.session.sessionId);
        return task.title === TITLE && task.pinned && !task.archived;
      },
      { timeout: 30_000, timeoutMsg: "SCT04 rename/pin not persisted" },
    );
    await $('[data-testid="project-pinned-tasks"]')
      .$(`[data-testid="${rowId}"]`)
      .waitForDisplayed();
    await showMobileTaskHome(page);
    await page.getByTestId("project-pinned-tasks").getByTestId(rowId).waitFor();
    expect(await page.getByTestId(rowId).innerText()).toContain(TITLE);
    const pinned = await readTask(fork.session.sessionId);
    await mutate(
      "archive",
      "Call SetSessionArchived on the fork, archived=true (step marker E2E_SCT04_ARCHIVE; do not pass requestId).",
    );
    await browser.waitUntil(async () => (await readTask(fork.session.sessionId)).archived, {
      timeout: 30_000,
    });
    await $(`[data-testid="${rowId}"]`).waitForExist({ reverse: true, timeout: 30_000 });
    await page.getByTestId(rowId).waitFor({ state: "detached" });
    const archived = await action<Summary>(
      "archived",
      "Call ReadSession on the archived fork, view=summary.",
    );
    expect(archived.summary).toMatchObject({
      title: TITLE,
      archived: true,
      pinned: true,
      status: "running",
      executionId: running.summary.executionId,
    });
    await mutate(
      "unarchive",
      "Call SetSessionArchived on the fork, archived=false (step marker E2E_SCT04_UNARCHIVE; do not pass requestId).",
    );
    await page.getByTestId("project-pinned-tasks").getByTestId(rowId).waitFor();
    await mutate(
      "unpin",
      "Call SetSessionPinned on the fork, pinned=false (step marker E2E_SCT04_UNPIN; do not pass requestId).",
    );
    await browser.waitUntil(
      async () => {
        const task = await readTask(fork.session.sessionId);
        return !task.archived && !task.pinned && task.title === TITLE;
      },
      { timeout: 30_000 },
    );
    // 取消最后一个置顶后分组本身会消失，直接检查组合选择器而非先查询已卸载的父元素。
    await $(`[data-testid="project-pinned-tasks"] [data-testid="${rowId}"]`).waitForExist({
      reverse: true,
    });
    await $(`[data-testid="${rowId}"]`).waitForDisplayed();
    await page
      .getByTestId("project-pinned-tasks")
      .getByTestId(rowId)
      .waitFor({ state: "detached" });
    await page.getByTestId(rowId).waitFor();
    assertions.organizationBothDirections = {
      pinned,
      archived: archived.summary,
      restored: await readTask(fork.session.sessionId),
    };
    await selectMobile(page, callerId);
    await assertBackground();

    await mutate(
      "interrupt",
      "Call InterruptSession on the fork using the exact executionId from running (step marker E2E_SCT04_INTERRUPT; do not pass requestId).",
    );
    const interrupted = await action<Wait>(
      "interrupted",
      "Call WaitSessions for the run operation, mode=all, timeoutMs=30000.",
    );
    expect(interrupted.status).toBe("completed");
    expectOperation(interrupted, run.operation, "interrupted");
    const next = await action<Admission>(
      "next",
      "Call SendToSession on the fork, prompt=E2E_SCT04_NEXT_TARGET (step marker E2E_SCT04_NEXT; do not pass requestId).",
      true,
    );
    expect(next).toMatchObject({
      session: fork.session,
      admission: "accepted",
      delivery: "start_now",
    });
    const nextRunning = await action<Summary>(
      "next_running",
      "Call ReadSession on the fork, view=summary.",
    );
    expect(nextRunning.summary.status).toBe("running");
    expect(nextRunning.summary.executionId).toBeTruthy();
    expect(nextRunning.summary.executionId).not.toBe(running.summary.executionId);
    const stale = await action<Mutation>(
      "stale",
      "Call InterruptSession using the OLD executionId from running (step marker E2E_SCT04_STALE; do not pass requestId).",
      true,
    );
    expect(stale.status).toBe("rejected");
    const stillRunning = await action<Wait>(
      "still_running",
      "Call WaitSessions for the NEXT operation, mode=all, timeoutMs=0.",
    );
    expect(stillRunning.status).toBe("timed_out");
    expectOperation(stillRunning, next.operation, "running");
    expect(stillRunning.operations[0]!.executionId).toBe(nextRunning.summary.executionId);
    await releaseControlledReplay("sct04-next-target");
    const nextCompleted = await action<Wait>(
      "next_completed",
      "Call WaitSessions for the NEXT operation, mode=all, timeoutMs=30000.",
    );
    expect(nextCompleted.status).toBe("completed");
    expectOperation(nextCompleted, next.operation, "completed");
    const finalHistory = await action<History>(
      "final_history",
      "Call ReadSession on the fork, view=messages, limit=20.",
    );
    for (const marker of ["E2E_SCT04_INTERRUPT_TARGET", "E2E_SCT04_NEXT_TARGET"]) {
      expect(
        finalHistory.messages.filter(
          (message) => message.role === "user" && message.text === marker,
        ),
      ).toHaveLength(1);
    }
    expect(
      finalHistory.messages.some(
        (message) => message.role === "assistant" && message.text.includes("SCT04_NEXT_DONE"),
      ),
    ).toBe(true);
    assertions.executionGuard = { interrupted, nextRunning, stale, stillRunning, nextCompleted };
    await assertBackground();

    // 来源必须来自持久 input，不从正文猜测；显式 UI 选择只用于接收方显示验证。
    const sourceSelector = `[data-v4-user-input-source="session"][data-source-session-id="${callerId}"]`;
    const captureSource = async (
      theme: "zai-light" | "zai-dark",
      locale: "zh-CN" | "en-US",
      phase: string,
    ) => {
      await setPluginPresentation({ theme, locale, width: 1200, height: 900 });
      await showMobileTaskHome(page!);
      await page!.evaluate(
        (next) => {
          const actions = (
            window as Window & {
              __testActions?: { setLocale(value: string): void; setTheme(value: string): void };
            }
          ).__testActions;
          if (!actions) throw new Error("SCT04 mobile presentation actions unavailable");
          actions.setLocale(next.locale);
          actions.setTheme(next.theme);
        },
        { theme, locale },
      );
      await selectMobile(page!, fork.session.sessionId);
      const label =
        locale === "zh-CN" ? `来自会话 ${CALLER_TITLE}` : `From session ${CALLER_TITLE}`;
      await browser.waitUntil(async () => (await $$(sourceSelector).length) === 2, {
        timeout: 30_000,
        timeoutMsg: "SCT04 recipient source badges missing",
      });
      for (const badge of await $$(sourceSelector)) expect(await badge.getText()).toBe(label);
      await page!.locator(sourceSelector).first().waitFor();
      expect(await page!.locator(sourceSelector).allTextContents()).toEqual([label, label]);
      const desktopOverflow = await browser.execute(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      const mobileLayout = await page!.evaluate(() => ({
        width: window.innerWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      expect(desktopOverflow).toBe(false);
      expect(mobileLayout).toEqual({ width: 390, overflow: false });
      await browser.saveScreenshot(
        join(artifacts, `SCT04-source-${phase}-${theme}-${locale}-desktop.png`),
      );
      await page!.screenshot({
        path: join(artifacts, `SCT04-source-${phase}-${theme}-${locale}-mobile.png`),
      });
      assertions[`source-${phase}-${theme}-${locale}`] = {
        label,
        callerId,
        recipient: fork.session,
        count: 2,
        mobileLayout,
      };
    };
    await selectV4TaskById(fork.session.sessionId);
    await waitForV4AssistantMessageContaining("SCT04_NEXT_DONE");
    for (const theme of ["zai-light", "zai-dark"] as const) {
      for (const locale of ["zh-CN", "en-US"] as const) await captureSource(theme, locale, "live");
    }
    // 规格 0.13：持久化载荷只带 sessionId，标题由运行侧按 id 解析，所以这里断言的是**当前**标题——
    // 改动前它是发送那一刻的快照。点击走既有导航 owner，落到发起方会话。
    await setPluginPresentation({ theme: "zai-dark", locale: "zh-CN", width: 1200, height: 900 });
    await selectV4TaskById(fork.session.sessionId);
    const sourceLink = await $(`${sourceSelector} [data-source-session-navigable="true"]`);
    await sourceLink.waitForDisplayed({ timeout: 30_000 });
    expect(await sourceLink.getText()).toBe(`来自会话 ${CALLER_TITLE}`);
    await sourceLink.click();
    const navigated = await waitForV4Pane(
      (snapshot) => snapshot.sessionId === callerId,
      "SCT04 点击来源提示后没有跳到发起方会话",
      30_000,
    );
    expect(navigated.sessionId).toBe(callerId);
    assertions.sourceNavigation = { from: fork.session.sessionId, to: callerId };
    await selectV4TaskById(fork.session.sessionId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(sourceSelector).first().waitFor();
    expect(await page.locator(sourceSelector).count()).toBe(2);
    assertions.mobileReplaySource = true;
    await reloadElectronSessionSafely(browser);
    await selectV4TaskById(fork.session.sessionId);
    await waitForV4AssistantMessageContaining("SCT04_NEXT_DONE");
    // 桌面重启会结束旧配对；沿真实入口重新连接后再验证持久来源，不能把离线页当作历史丢失。
    await openMobilePairingPage(page, await obtainUnreadPairingUrl(), {
      artifactDir: artifacts,
      caseMarker: CASE,
      phase: "cold-reconnect",
      // 已有手机页面保留 task-chat 路由；配对就绪时不保证首页侧栏可见。
      readySelector: '[data-testid="sidebar"], [data-testid^="v4-session-pane-"]',
    });
    await captureSource("zai-dark", "en-US", "cold");
    await installHandoffRpcProbe();
    const restored = await readTask(fork.session.sessionId);
    expect(restored).toMatchObject({
      title: TITLE,
      archived: false,
      pinned: false,
      projectId: fork.session.project!.projectId,
    });
    assertions.coldRestoredOrganization = restored;
  });
});

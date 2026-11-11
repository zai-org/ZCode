import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import { TID_LOGIN_USE_API_KEY_BUTTON, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  loginWithApiKey,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

// 重启与重载（docs/dynamic-workflow/presentation.md「Cold replay」「Joining cards to runs」、
// docs/dynamic-workflow/transcript-and-notifications.md「The pipeline and cold restore」「What a run
// leaves behind」、apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」）
// 的三条桌面链路：
// - renderer 重载不碰 Host 与 CLI：run 继续跑，重载后卡仍是 running，并且自己走到终态；
// - 完整重启 Electron / Host / CLI：已完成的 run 由 CLI 冷回放进投影，卡、完成卡与侧板与重启前一致；
// - 完整重启时 run 还在跑：App 关闭前引擎自己写下 stopped(interrupted)，终态通知随运行时关闭被丢弃，
//   重开后经冷回放显示为已停止、可恢复，且没有终态通知行。
//
// case-local 回放只决定主模型与子代理的回答；Skill、编译、审批、引擎、关闭收口与冷回放都走产品链路。
// 运行 A 停在一个只看放行文件的 `world.run("node", …)` 上，由测试写文件放行，不靠定时等待。
const RELEASE_FILE = join(DEFAULT_WORKSPACE, ".e2e-dwp-release");
const DIGEST = '[data-workflow-run-digest="true"]';
const NOTIFICATION_ROW = '[data-testid^="chat-workflow-notification-row-"]';
const COMPLETION_CARD = '[data-workflow-completion-card="true"]';

interface DigestSnapshot {
  runId: string | null;
  status: string | null;
  kind: string;
  stations: { status: string | null; text: string }[];
  pills: { status: string | null; text: string }[];
}

interface CompletedSurfaces {
  digest: DigestSnapshot;
  notification: string;
  figures: Record<string, string>;
  phases: { id: string | null; status: string | null; text: string }[];
}

let sessionA = "";
let runA = "";
let completedBefore: CompletedSurfaces | undefined;

function digestFor(runId: string) {
  return `${DIGEST}[data-workflow-run-id="${runId}"]`;
}

function readDigest(runId: string): Promise<DigestSnapshot | null> {
  return browser.execute((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return null;
    const text = (element: Element | null) =>
      ((element as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    return {
      runId: root.dataset.workflowRunId ?? null,
      status: root.dataset.workflowRunStatus ?? null,
      kind: text(root.querySelector('[data-testid="workflow-card-kind"]')),
      stations: Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="workflow-timeline-station"]'),
      ).map((station) => ({ status: station.dataset.stationStatus ?? null, text: text(station) })),
      pills: Array.from(
        root.querySelectorAll<HTMLElement>('[data-testid="workflow-agent-pill"]'),
      ).map((pill) => ({ status: pill.dataset.agentStatus ?? null, text: text(pill) })),
    };
  }, digestFor(runId));
}

async function waitForDigest(
  runId: string,
  accept: (snapshot: DigestSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 120_000,
): Promise<DigestSnapshot> {
  let latest: DigestSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readDigest(runId);
      return latest !== null && accept(latest);
    },
    { timeout, timeoutMsg: `${timeoutMsg}；最后一次读到 ${JSON.stringify(latest)}` },
  );
  return latest!;
}

/** 卡上最新一张 run 卡的 run id（本会话只有一张）。 */
async function waitForOnlyRunId(): Promise<string> {
  let runId: string | null = null;
  await browser.waitUntil(
    async () => {
      runId = await browser.execute((selector) => {
        const cards = document.querySelectorAll<HTMLElement>(selector);
        return cards.length === 1 ? (cards[0]!.dataset.workflowRunId ?? null) : null;
      }, DIGEST);
      return Boolean(runId);
    },
    { timeout: 120_000, timeoutMsg: "会话里没有长出唯一一张带 run id 的 run 卡" },
  );
  return runId!;
}

/** 重开 run 侧板（⤢），读出阶段列表与状态行。 */
async function readRunPane(runId: string) {
  await $(digestFor(runId)).$('[data-testid="workflow-card-open-details"]').click();
  await $('[data-testid="workflow-run-status-row"]').waitForDisplayed({ timeout: 60_000 });
  await $('[data-testid="workflow-run-phase"]').waitForExist({ timeout: 60_000 });
  return browser.execute(() => {
    const text = (element: Element | null) =>
      ((element as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    const toggle = (phase: HTMLElement) =>
      phase.querySelector('[data-testid="workflow-run-phase-toggle"]');
    return {
      status: text(document.querySelector('[data-testid="workflow-run-status-row"]')),
      reason: text(document.querySelector('[data-testid="workflow-run-status-reason"]')),
      resumable: Boolean(document.querySelector('[data-testid="workflow-run-status-resumable"]')),
      phases: Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="workflow-run-phase"]'),
      ).map((phase) => ({
        id: phase.dataset.phaseId ?? null,
        status: phase.dataset.phaseStatus ?? null,
        text: text(toggle(phase)),
      })),
    };
  });
}

async function readCompletedSurfaces(runId: string): Promise<CompletedSurfaces> {
  const digest = await waitForDigest(
    runId,
    (snapshot) => snapshot.status === "completed" && snapshot.stations.length > 0,
    "run 卡没有显示为已完成",
  );
  const row = $(NOTIFICATION_ROW);
  await row.waitForDisplayed({ timeout: 60_000 });
  const card = $(COMPLETION_CARD);
  await card.waitForDisplayed({ timeout: 60_000 });
  // 四格数字刚挂载时会从 0 翻上来（640 ms，prefers-reduced-motion: no-preference 下）；
  // 首轮在翻动中途取值，读到的是半程数。等相邻两次读数一致，读的才是终值。
  let figures: Record<string, string> = {};
  let previous = "";
  await browser.waitUntil(
    async () => {
      figures = await browser.execute((selector) => {
        const root = document.querySelector(selector);
        const values: Record<string, string> = {};
        for (const key of ["time", "tokens", "subagents", "phases"]) {
          values[key] =
            root
              ?.querySelector<HTMLElement>(`[data-testid="workflow-completion-figure-${key}"]`)
              ?.getAttribute("data-value") ?? "—";
        }
        return values;
      }, COMPLETION_CARD);
      const current = JSON.stringify(figures);
      const settled = current === previous;
      previous = current;
      return settled;
    },
    { timeout: 30_000, interval: 1_000, timeoutMsg: "完成卡的四格数字没有停下来" },
  );
  const pane = await readRunPane(runId);
  return { digest, notification: await row.getText(), figures, phases: pane.phases };
}

/** renderer 重载：Host 与 CLI 不动，只换一份新的 renderer。 */
async function reloadRenderer(sessionId: string) {
  await browser.refresh();
  const login = $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`);
  const task = $(`[data-testid="${testId(TID_TASK_ITEM, sessionId)}"]`);
  await browser.waitUntil(async () => (await login.isDisplayed()) || (await task.isExisting()), {
    timeout: 60_000,
    timeoutMsg: "renderer 重载后既没有登录页也没有任务项",
  });
  if (await login.isDisplayed()) await loginWithApiKey();
  // 语言固定只在内存里；新 renderer 要重新固定。
  await pinE2ELocale("zh-CN");
  await reopenSession(sessionId);
}

/** 完整重启：Electron、Host 与 CLI 都换新进程，会话只能从持久数据冷物化。 */
async function relaunchApp(sessionId: string) {
  await reloadElectronSessionSafely(browser);
  await pinE2ELocale("zh-CN");
  await reopenSession(sessionId);
}

async function reopenSession(sessionId: string) {
  if ((await getV4PaneSnapshot()).sessionId !== sessionId) {
    await selectV4TaskById(sessionId, 60_000);
  }
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `没有重新打开会话 ${sessionId}`,
    60_000,
  );
}

async function launchWorkflow(tag: "A" | "B", prompt: string) {
  await sendV4Prompt(`E2E_DWP_${tag}_START ${prompt}`);
  await approveV4Permission();
  const toolCallId = `toolu_dwp_${tag.toLowerCase()}_create`;
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId))?.isError === false,
    { timeout: 60_000, timeoutMsg: `${tag}: CreateWorkflow 未执行成功` },
  );
  await waitForV4AssistantMessageContaining(`E2E_DWP_${tag}_STARTED`, 60_000);
  const sessionId = (await getV4PaneSnapshot()).sessionId;
  if (!sessionId || sessionId === "draft") throw new Error(`${tag}: 没有真实 sessionId`);
  return { sessionId, runId: await waitForOnlyRunId() };
}

describe("动态工作流 · 重启与重载", () => {
  before(async () => {
    await rm(RELEASE_FILE, { force: true });
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await rm(RELEASE_FILE, { force: true });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWP-01 renderer 重载时 run 在跑：重载后卡仍是 running，放行后自己走到已完成并长出通知与完成卡", async function () {
    this.timeout(360_000);
    ({ sessionId: sessionA, runId: runA } = await launchWorkflow(
      "A",
      "使用工作流：记录员先写一句记录，再等待放行。",
    ));
    // 子代理答完、run 停在第二站的 world.run 上：此时重载才是「run 在跑」。
    const running = await waitForDigest(
      runA,
      (snapshot) => snapshot.status === "running" && snapshot.stations[1]?.status === "running",
      "run 没有停在「等待放行」站上",
    );
    expect(running.stations[0]?.text).toContain("准备");
    expect(running.pills.some((pill) => pill.text.includes("记录员"))).toBe(true);

    await reloadRenderer(sessionA);
    const afterReload = await waitForDigest(
      runA,
      (snapshot) => snapshot.status === "running" && snapshot.stations.length > 0,
      "renderer 重载后 run 卡没有显示为 running",
      60_000,
    );
    expect(afterReload.stations.map((station) => station.status)).toEqual(
      running.stations.map((station) => station.status),
    );
    await expect($$(NOTIFICATION_ROW)).toBeElementsArrayOfSize(0);

    // 放行：run 不需要任何用户动作就走到终态；终态通知唤醒主代理，回复尾部长出完成卡。
    await writeFile(RELEASE_FILE, "go\n");
    await waitForDigest(
      runA,
      (snapshot) => snapshot.status === "completed",
      "放行后 run 卡没有走到已完成",
    );
    await waitForV4AssistantMessageContaining("E2E_DWP_A_DONE", 120_000);
    await waitForV4Pane((pane) => !pane.canStop, "终态通知轮没有结束", 60_000);
    const row = $(NOTIFICATION_ROW);
    await row.waitForDisplayed({ timeout: 60_000 });
    expect(await row.getText()).toContain("工作流已完成");
    await $(COMPLETION_CARD).waitForDisplayed({ timeout: 60_000 });
  });

  it("DWP-02 完整重启后冷回放：run 卡、通知行、完成卡与侧板阶段和重启前一致", async function () {
    this.timeout(300_000);
    if (!sessionA || !runA) throw new Error("DWP-01 没有留下会话与 run");
    completedBefore = await readCompletedSurfaces(runA);
    expect(completedBefore.digest.stations.map((station) => station.text).join(" ")).toContain(
      "等待放行",
    );
    expect(completedBefore.digest.pills.map((pill) => pill.text).join(" ")).toContain("记录员");
    expect(completedBefore.phases.length).toBeGreaterThanOrEqual(2);
    // 阶段格是进入过的阶段数，子代理格是 actors 数（docs「Where the numbers come from」）。
    expect(completedBefore.figures.phases).toBe("2");
    expect(completedBefore.figures.subagents).toBe("1");

    await relaunchApp(sessionA);
    const after = await readCompletedSurfaces(runA);
    expect(after.digest).toEqual(completedBefore.digest);
    expect(after.notification).toBe(completedBefore.notification);
    expect(after.figures).toEqual(completedBefore.figures);
    expect(after.phases).toEqual(completedBefore.phases);
    // 冷回放不给已完成的 run 补出恢复按钮或 Stop。
    await expect($(digestFor(runA)).$('[data-testid="workflow-digest-resume"]')).not.toBeExisting();
  });

  it("DWP-03 完整重启时 run 在跑：重开后 run 已停止（进程已退出）、可恢复，且没有终态通知行", async function () {
    this.timeout(360_000);
    await prepareV4ConversationE2E();
    const { sessionId, runId } = await launchWorkflow("B", "使用工作流：长时间等待。");
    await waitForDigest(
      runId,
      (snapshot) => snapshot.status === "running" && snapshot.stations[0]?.status === "running",
      "run B 没有进入 running",
    );

    // App 关闭前引擎自己写下 stopped(interrupted)；运行时已在关闭，终态通知被丢弃，不唤醒模型。
    await relaunchApp(sessionId);
    const stopped = await waitForDigest(
      runId,
      (snapshot) => snapshot.status === "stopped",
      "重启后 run B 没有显示为已停止",
    );
    expect(stopped.kind).toContain("已停止");
    await expect($(digestFor(runId)).$('[data-testid="workflow-digest-resume"]')).toBeDisplayed();
    const pane = await readRunPane(runId);
    expect(pane.status).toContain("已停止");
    expect(pane.reason).toContain("进程已退出");
    expect(pane.resumable).toBe(true);
    await expect($$(NOTIFICATION_ROW)).toBeElementsArrayOfSize(0);
    expect((await getV4PaneSnapshot()).canStop).toBe(false);
  });
});

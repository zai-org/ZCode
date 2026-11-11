import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_CHAT_SUMMARY_PANEL, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readRemoteTabSnapshot, runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import {
  clickV4Send,
  getV4ConversationState,
  getV4GoalProjection,
  getV4Messages,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4ConversationState,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_COMPACT_GOAL";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-compact-goal");

async function clickGoalAction(action: "pause" | "resume"): Promise<boolean> {
  await browser.waitUntil(
    () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        if (!panel) return false;
        if (panel.dataset.state === "collapsed") {
          panel.querySelector<HTMLButtonElement>("button")?.click();
          return false;
        }
        return panel.dataset.state === "expanded";
      }, TID_CHAT_SUMMARY_PANEL),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: goal 状态面板没有展开` },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (name) =>
          Boolean(
            document.querySelector<HTMLButtonElement>(`[data-goal-action="${name}"]`)?.disabled ===
            false,
          ),
        action,
      ),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: goal ${action} 按钮不可用` },
  );
  return browser.execute((name) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-goal-action="${name}"]`);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, action);
}

describe(`${CASE_MARKER}: 远端 session 的手动 compact 与 goal 暂停/继续/结束`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "compact-goal.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TASK-05 /compact 在远端执行且历史被摘要替代、后续回合不丢队列；/goal 建立 → pause → resume → 结束回合，active-work 状态正确、无重复 continuation", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });

    // 手动 compact：/compact → 远端发起 compaction 模型请求（CRITICAL: Respond with TEXT ONLY）→ manual/success marker。
    const compactStart = await getUpstreamRequestRecordCount();
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: composer 输入框没有出现`,
    });
    await clickV4Send();
    await waitForUpstreamRequest(
      { includes: ["CRITICAL: Respond with TEXT ONLY", taskA.firstPrompt] },
      `${CASE_MARKER}: compaction 请求没有到达回放`,
      90_000,
      { afterIndex: compactStart - 1 },
    );
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 120_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: compact 后没有回到 idle`,
      60_000,
    );
    const compactRequests = (await getUpstreamRequestRecordCount()) - compactStart;
    facts.compact = { requestsDuringCompact: compactRequests };
    // compaction 期间允许 1~3 次模型请求（摘要 + 可能的记忆抽取/标题），但不得重复触发多次 compaction。
    expect(compactRequests).toBeGreaterThanOrEqual(1);
    expect(compactRequests).toBeLessThanOrEqual(3);
    // compact 后下一回合：请求体携带摘要（R3_COMPACT_SUMMARY）而不是原首发回复文本。
    const afterCompactStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_AFTER 请回复`,
      `${CASE_MARKER}_AFTER`,
      `${CASE_MARKER}: compact 后回合未被接受`,
    );
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [`${CASE_MARKER}_AFTER`],
        includes: ["R3_COMPACT_SUMMARY"],
        excludes: [taskA.firstReply],
      },
      `${CASE_MARKER}: compact 后请求没有携带摘要或仍含原始回复`,
      90_000,
      { afterIndex: afterCompactStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_COMPACT_GOAL_REPLY", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: compact 后回合没有收口`,
      90_000,
    );
    facts.afterCompactTurnUsesSummary = true;
    const remoteCompact = await runSSHCommand(
      prepared.config,
      'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); grep -c "compact" "$F" || true',
    );
    facts.remoteLogCompactMentions = Number.parseInt(remoteCompact.stdout.trim() || "0", 10);

    // goal：/goal → continuation 慢流（running）→ pause → resume → 慢流结束/verify。
    const goalStart = await getUpstreamRequestRecordCount();
    await setInputValueByTestIdDom(
      TID_V4_COMPOSER_INPUT,
      `/goal ${CASE_MARKER}_OBJECTIVE 完成远端目标`,
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: composer 输入框没有出现` },
    );
    await clickV4Send();
    await browser.waitUntil(
      async () =>
        ((await getV4GoalProjection())?.objective ?? "").includes(`${CASE_MARKER}_OBJECTIVE`),
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: goal 状态面板没有出现 objective`,
      },
    );
    const active = await getV4GoalProjection();
    facts.goalActive = active;
    expect(["active", "verifying"]).toContain(active?.status);
    await waitForUpstreamRequest(
      { includes: [`${CASE_MARKER}_OBJECTIVE`, "Continue working toward the active session goal"] },
      `${CASE_MARKER}: goal continuation 请求没有到达回放`,
      90_000,
      { afterIndex: goalStart - 1 },
    );
    await waitForV4Pane(
      (s) => s.canStop,
      `${CASE_MARKER}: goal continuation 没有进入 running`,
      60_000,
    );

    expect(await clickGoalAction("pause")).toBe(true);
    await browser.waitUntil(async () => (await getV4GoalProjection())?.status === "paused", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: pause 后目标没有进入 paused`,
    });
    const requestsAtPause = await getUpstreamRequestRecordCount();
    await browser.pause(8_000);
    const pausedState = await getV4ConversationState();
    facts.paused = {
      state: pausedState.state,
      requestsDuringPause: (await getUpstreamRequestRecordCount()) - requestsAtPause,
    };
    expect(facts.paused).toMatchObject({ requestsDuringPause: 0 });

    expect(await clickGoalAction("resume")).toBe(true);
    await browser.waitUntil(
      async () =>
        ["active", "verifying", "verified", "completed"].includes(
          (await getV4GoalProjection())?.status ?? "",
        ),
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: resume 后目标没有恢复` },
    );
    facts.resumed = await getV4GoalProjection();
    // 慢流结束 → verify 请求 → 目标收口；期间 continuation 请求不得重复（≤2：resume 可能重新发起一次 continuation）。
    await waitForUpstreamRequest(
      { includes: [`${CASE_MARKER}_OBJECTIVE`, "Verify whether the active session goal"] },
      `${CASE_MARKER}: goal 恢复后没有产生验证请求`,
      180_000,
      { afterIndex: goalStart - 1 },
    );
    // idle 也可能对应暂停或错误，必须同时证明目标确实完成。
    await browser.waitUntil(
      async () => ["verified", "completed"].includes((await getV4GoalProjection())?.status ?? ""),
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: verifier 通过后目标没有完成` },
    );
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: goal 回合没有收口`,
      180_000,
    );
    const goalRequestsTotal = (await getUpstreamRequestRecordCount()) - goalStart;
    const finalGoal = await getV4GoalProjection();
    facts.goalEnd = { status: finalGoal?.status ?? null, requestsTotal: goalRequestsTotal };
    expect(goalRequestsTotal).toBeLessThanOrEqual(4);
    const messages = await getV4Messages("user");
    facts.userMessages = messages.map((m) => (m.text ?? "").slice(0, 50));
    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBe(
      taskA.remoteSessionId,
    );
  });
});

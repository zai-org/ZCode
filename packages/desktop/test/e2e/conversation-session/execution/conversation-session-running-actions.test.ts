import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  clickFirstV4Fork,
  clickV4Stop,
  getV4PaneSnapshot,
  getV4QueueItems,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("PV4-08 running stable assistant fork E2E", () => {
  afterEach(async () => {
    await stopRunningTurnIfNeeded();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中 fork 更早稳定 assistant：父继续且 child 不复制 active work/queue", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();

    const runId = Date.now();
    const completedMarker = `E2E_RUNNING_ACTIONS_COMPLETED_${runId}`;
    await sendV4Prompt(buildReadonlyToolPrompt(completedMarker));
    await waitForV4TimelineContaining(completedMarker, 60000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "running stable fork 前置轮次没有完成",
      90000,
    );
    await waitForV4Fork();

    const parent = await getV4PaneSnapshot();
    const parentSessionId = parent.sessionId;
    expect(parentSessionId).toBeTruthy();
    expect(parentSessionId).not.toBe("draft");

    const activeMarker = `E2E_RUNNING_ACTIONS_ACTIVE_${runId}`;
    await sendV4Prompt(
      `E2E_SLOW_STREAM ${activeMarker}: Reply with exactly "upstream-e2e-ok" and no other text.`,
    );
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "第二轮没有进入 controlled streaming",
      30000,
    );

    const queuedMarker = `E2E_RUNNING_ACTIONS_QUEUED_${runId}`;
    await sendV4Prompt(`${queuedMarker}: keep this input queued.`);
    await waitForV4QueueCount(1, 30000);

    // 产品语义已改为：running 不全局禁 fork；更早 completedSuccess 最终
    // assistant 的 row.actions.canFork 仍为 true，当前 streaming partial 没有入口。
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    const child = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== parentSessionId &&
        snapshot.timelineText.includes(completedMarker),
      "running stable fork child 没有完成稳定历史 hydration",
      30000,
    );
    expect(child.timelineText).toContain(completedMarker);
    expect(child.timelineText).not.toContain(activeMarker);
    expect(child.timelineText).not.toContain(queuedMarker);
    expect(await getV4QueueItems()).toHaveLength(0);

    // 切回父会话时 active turn 与 queue 都还在，证明 fork 没有 stop、搬运或消费父状态。
    await selectV4TaskById(parentSessionId!);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "fork child 后父 session 没有继续运行",
      15000,
    );
    await waitForV4QueueCount(1, 15000);
    expect((await getV4QueueItems())[0]?.text).toContain(queuedMarker);

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "running stable fork 收尾 stop 没有完成",
      30000,
    );
  });
});

async function stopRunningTurnIfNeeded() {
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) return;
  await clickV4Stop();
  await waitForV4Pane(
    (nextSnapshot) => !nextSnapshot.canStop,
    "running stable fork 收尾 stop 后没有退出 streaming",
    30000,
  );
}

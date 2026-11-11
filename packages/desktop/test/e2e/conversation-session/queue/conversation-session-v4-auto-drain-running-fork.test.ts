// PV4-03/PV4-08 pending：Q0 running 时先把 Q1/Q2 入 CLI FIFO；Q1 auto-drain
// 形成稳定 A1，Q2 随后仍 running 时精确 fork A1。
import { TID_V4_FORK, TID_V4_ROW } from "@zcode/shared/test-ids";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamNetworkRequestStarted } from "#e2e/helpers/upstream-capture";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  getV4QueueItems,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4QueueCount,
} from "#e2e/helpers/v4-conversation";

const Q0_MARKER = "E2E_V4_AUTODRAIN_FORK_Q0";
const A0_MARKER = "E2E_V4_AUTODRAIN_FORK_A0";
const Q1_MARKER = "E2E_V4_AUTODRAIN_FORK_Q1";
const A1_MARKER = "E2E_V4_AUTODRAIN_FORK_A1";
const Q2_MARKER = "E2E_V4_AUTODRAIN_FORK_Q2";
const A2_PARTIAL_MARKER = "E2E_V4_AUTODRAIN_FORK_A2_PARTIAL";

describe("PV4-08 auto-drain stable assistant running fork", () => {
  let runningParentSessionId: string | null = null;

  afterEach(async () => {
    if (runningParentSessionId) {
      await selectV4TaskById(runningParentSessionId).catch(() => undefined);
    }
    await stopCurrentTurnIfNeeded();
    runningParentSessionId = null;
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Q1 auto-drain 成 A1 后，Q2 running 时 fork A1，父继续且 child 前缀固定", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const q0 = `${Q0_MARKER}_${runId}: hold the first turn while Q1 and Q2 queue.`;
    const q1 = `${Q1_MARKER}_${runId}: auto-drain this input and reply with ${A1_MARKER}.`;
    const q2 = `${Q2_MARKER}_${runId}: keep streaming while A1 is forked.`;

    await sendV4Prompt(q0);
    const parent = await waitForV4Pane(
      (snapshot) =>
        snapshot.canStop &&
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        snapshot.timelineText.includes(A0_MARKER),
      "Q0 没有进入 controlled running 窗口",
      30000,
    );
    runningParentSessionId = parent.sessionId;

    await sendV4Prompt(q1);
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt(q2);
    await waitForV4QueueCount(2, 30000);
    expect((await getV4QueueItems()).map((item) => item.text).join("\n")).toContain(Q1_MARKER);
    expect((await getV4QueueItems()).map((item) => item.text).join("\n")).toContain(Q2_MARKER);
    // 队列已接收两条输入才释放 Q0；不依赖固定的 30 秒窗口。
    await releaseControlledReplay("v4-auto-drain-fork-q0-controlled");

    // Q0 完成后 Q1、Q2 必须按 CLI admission FIFO 自动 drain。断言 A1 已稳定、
    // Q2 已从 queue 晋升为 active turn，才能证明 fork target 不是普通 direct-send 历史。
    await waitForUpstreamNetworkRequestStarted(Q2_MARKER);
    const q2Running = await waitForV4Pane(
      (snapshot) =>
        snapshot.canStop &&
        snapshot.timelineText.includes(Q1_MARKER) &&
        snapshot.timelineText.includes(A1_MARKER) &&
        snapshot.timelineText.includes(Q2_MARKER) &&
        // 请求开始早于 Renderer 收到首个 delta；必须等实际部分回复出现再 fork。
        snapshot.timelineText.includes(A2_PARTIAL_MARKER),
      "Q1/A1 没有完成 auto-drain，或 Q2 没有继续进入 running",
      60000,
    );
    expect(await getV4QueueItems()).toHaveLength(0);
    expect(q2Running.timelineText).toContain(A2_PARTIAL_MARKER);

    await waitForForkActionOnRow(A1_MARKER);
    expect(await clickForkActionOnRow(A1_MARKER)).toBe(true);
    const child = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== runningParentSessionId &&
        snapshot.timelineText.includes(A1_MARKER),
      "Q2 running 时 fork A1 没有创建 child",
      30000,
    );

    // child 固定在 A1 的 stable logical boundary：Q0/A0、Q1/A1 全部存在；
    // Q2 user/partial、父 active work 与未来状态一律不能越过边界。
    expect(child.timelineText).toContain(Q0_MARKER);
    expect(child.timelineText).toContain(A0_MARKER);
    expect(child.timelineText).toContain(Q1_MARKER);
    expect(child.timelineText).toContain(A1_MARKER);
    expect(child.timelineText).not.toContain(Q2_MARKER);
    expect(child.timelineText).not.toContain(A2_PARTIAL_MARKER);
    expect(await getV4QueueItems()).toHaveLength(0);

    if (!runningParentSessionId) throw new Error("fork 前没有记录 parent sessionId");
    await selectV4TaskById(runningParentSessionId);
    const parentStillRunning = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === runningParentSessionId &&
        snapshot.canStop &&
        snapshot.timelineText.includes(Q2_MARKER),
      "fork A1 后父 Q2 没有继续运行",
      15000,
    );
    expect(parentStillRunning.timelineText).toContain(A2_PARTIAL_MARKER);

    // UI 每次点击都会生成新 commandId，无法构造“同一 commandId 重试”。该幂等边界
    // 必须由 protocol/native probe 注入固定 commandId；本 pending case 不用双击冒充覆盖。
    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "auto-drain running fork 收尾 stop 没有完成",
      30000,
    );
  });
});

async function waitForForkActionOnRow(marker: string) {
  await browser.waitUntil(async () => hasForkActionOnRow(marker), {
    timeout: 30000,
    timeoutMsg: `稳定 assistant row 没有权威 canFork action: ${marker}`,
  });
}

async function hasForkActionOnRow(marker: string) {
  return browser.execute(
    (expectedMarker, rowPrefix, forkPrefix) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
      );
      return rows.some((candidate) => {
        if (!candidate.innerText.includes(expectedMarker)) return false;
        const rowId = candidate.dataset.rowId;
        return Boolean(rowId && document.querySelector(`[data-testid="${forkPrefix}-${rowId}"]`));
      });
    },
    marker,
    TID_V4_ROW,
    TID_V4_FORK,
  );
}

async function clickForkActionOnRow(marker: string) {
  return browser.execute(
    (expectedMarker, rowPrefix, forkPrefix) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
      );
      const row = rows.find((candidate) => {
        if (!candidate.innerText.includes(expectedMarker)) return false;
        const rowId = candidate.dataset.rowId;
        return Boolean(rowId && document.querySelector(`[data-testid="${forkPrefix}-${rowId}"]`));
      });
      const rowId = row?.dataset.rowId;
      const button = rowId
        ? document.querySelector<HTMLButtonElement>(`[data-testid="${forkPrefix}-${rowId}"]`)
        : null;
      button?.click();
      return Boolean(button);
    },
    marker,
    TID_V4_ROW,
    TID_V4_FORK,
  );
}

async function stopCurrentTurnIfNeeded() {
  const snapshot = await getV4PaneSnapshot().catch(() => null);
  if (!snapshot?.canStop) return;
  await clickV4Stop();
  await waitForV4Pane(
    (next) => !next.canStop,
    "auto-drain running fork cleanup 没有退出 streaming",
    30000,
  );
}

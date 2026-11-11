import { TID_CHAT_SUMMARY_PANEL, TID_V4_SUBAGENT_OPEN_SIDE_PANE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  getV4ComposerBackgroundWorkCounts,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const TIMEOUT_MS = 180000;
const CHILD_COUNT = 7;
const PARENT_MARKER = "E2E_SUBAGENT_PARALLEL_PROJECTION_PARENT";
const PARENT_DONE = "E2E_SUBAGENT_PARALLEL_PROJECTION_PARENT_DONE";

describe("并行 subagent V4 权威投影 manual review", () => {
  before(async function () {
    this.timeout(TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT24: 7 个并行 child 在切换任务前后都保持完整计数", async function () {
    this.timeout(TIMEOUT_MS);

    await sendV4Prompt(
      `${PARENT_MARKER}: launch exactly seven foreground Agent calls in one parallel tool-use response, then reply ${PARENT_DONE} after all children finish.`,
    );
    const runningParent = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && snapshot.canStop,
      "SAT24 没有进入 running parent session",
      60000,
    );
    if (!runningParent.sessionId || runningParent.sessionId === "draft") {
      throw new Error(`SAT24 缺少 parent session id: ${JSON.stringify(runningParent)}`);
    }

    // Bug 原因：旧链路在 SubagentSpawned 后另查 session/subagents；第 7 个 child
    // 尚未持久化时查询可能只返回 6，in-flight refresh 又会吞掉后续更新。切换任务会
    // 重新查询而“自愈”。这里同时约束投影的两个用户可见消费者，切换前就必须是 7。
    await waitForParallelSubagentCounts(CHILD_COUNT, "live-before-switch");

    const parentSessionId = runningParent.sessionId;
    await startNewV4Draft();
    await selectV4TaskById(parentSessionId);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === parentSessionId,
      "SAT24 切回后没有恢复 parent session",
      30000,
    );
    await waitForParallelSubagentCounts(CHILD_COUNT, "restored-after-switch");

    await waitForUpstreamRequest(
      {
        includes: [
          "toolu_e2e_parallel_subagent_01",
          "toolu_e2e_parallel_subagent_02",
          "toolu_e2e_parallel_subagent_03",
          "toolu_e2e_parallel_subagent_04",
          "toolu_e2e_parallel_subagent_05",
          "toolu_e2e_parallel_subagent_06",
          "toolu_e2e_parallel_subagent_07",
          "E2E_SUBAGENT_PARALLEL_PROJECTION_CHILD_DONE",
        ],
      },
      "SAT24 parent continuation 没有同时收到 7 个 child tool result",
      90000,
    );
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === parentSessionId && !snapshot.canStop,
      "SAT24 的 parent session 没有在 7 个 child 完成后回到 idle",
      90000,
    );
  });
});

interface ParallelSubagentCounts {
  composer: number;
  statusPanel: number;
  summaryActions: number;
}

async function readParallelSubagentCounts(): Promise<ParallelSubagentCounts> {
  const composerCounts = await getV4ComposerBackgroundWorkCounts();
  const surfaceCounts = await browser.execute(
    (panelTestId, sidePaneActionPrefix) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      return {
        statusPanel: Number(panel?.dataset.runningAgentCount ?? "0"),
        summaryActions: document.querySelectorAll(`[data-testid^="${sidePaneActionPrefix}-"]`)
          .length,
      };
    },
    TID_CHAT_SUMMARY_PANEL,
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  );
  return {
    composer: composerCounts?.subagentCount ?? 0,
    ...surfaceCounts,
  };
}

async function waitForParallelSubagentCounts(
  expected: number,
  stage: "live-before-switch" | "restored-after-switch",
): Promise<void> {
  let latest: ParallelSubagentCounts | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readParallelSubagentCounts();
        return (
          latest.composer === expected &&
          latest.statusPanel === expected &&
          latest.summaryActions === expected
        );
      },
      {
        interval: 100,
        timeout: 30000,
        timeoutMsg: `${stage} 没有完整显示 ${expected} 个并行 subagent`,
      },
    );
  } catch (error) {
    latest = await readParallelSubagentCounts();
    const pane = await getV4PaneSnapshot();
    throw new Error(
      `${stage} 并行 subagent 计数错误; expected=${expected}; latest=${JSON.stringify(latest)}; pane=${JSON.stringify(pane)}`,
      { cause: error },
    );
  }
}

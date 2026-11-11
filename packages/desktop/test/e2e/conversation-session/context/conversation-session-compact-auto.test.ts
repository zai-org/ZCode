import { mkdir, rm, writeFile } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  countUpstreamRequestsContainingAll,
  findFirstUpstreamRequestIndex,
  findLastUpstreamRequestIndex,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { waitForQueueContaining, waitForQueueCount } from "#e2e/helpers/conversation-session-queue";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool";
import {
  E2E_REPLY_TOKEN,
  editFirstV4UserQuery,
  getV4CompactMarkers,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  type V4CompactMarkerSnapshot,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const ADJACENT_AUTO_COMPACT_MARKER = "E2E_ADJACENT_AUTOCOMPACT";
const AUTO_COMPACT_RUNTIME_ROOT = resolveE2ERuntimePath("conversation-session-compact-auto");
const ADJACENT_AUTO_COMPACT_FILE_PATH = resolveE2ERuntimePath(
  "conversation-session-compact-auto",
  "adjacent-autocompact.txt",
);

describe("会话区 Auto Compact E2E", () => {
  let runId = 0;

  before(async () => {
    await mkdir(AUTO_COMPACT_RUNTIME_ROOT, { recursive: true });
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await waitForV4ConversationState(
      (snapshot) => !snapshot.modelSwitchPending,
      "auto compact case 切换完全访问模式后没有结束 pending",
      30000,
    );
    runId = Date.now();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(AUTO_COMPACT_RUNTIME_ROOT, { force: true, recursive: true });
    await clearAppData();
  });

  it("G01: completed queue=0 且 needsCompact 时先 auto compact，成功后继续原普通文本", async () => {
    await seedAutoCompactHistory(runId, "G01");
    const seedPrompt = `E2E_AUTO_COMPACT_CONTEXT_SEED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(seedPrompt);
    await waitForV4ComposerText("", "auto compact 第一轮发送后输入框没有清空");
    await waitForV4UserMessageContaining(seedPrompt);
    await waitForUpstreamRequestContaining(`E2E_AUTO_COMPACT_CONTEXT_SEED_${runId}`);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "auto compact 第一轮没有完成",
      90000,
    );

    const compactRequestsBefore = await countUpstreamRequestsContainingAll([
      COMPACT_REQUEST_SENTINEL,
      "E2E_AUTO_COMPACT",
    ]);
    const modelRequestsBefore = await countUpstreamRequestsContainingAll([]);
    const assistantMessagesBefore = (await getV4Messages("assistant")).length;
    const compactRowIdsBefore = await getV4AutoCompactRowIds();
    const pendingPrompt = `E2E_AUTO_COMPACT_PENDING_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(pendingPrompt);
    await waitForV4ComposerText("", "auto compact pending 文本发送后输入框没有清空");

    await waitForNewV4AutoCompactSuccess(compactRowIdsBefore, 30000);
    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContainingAll([
          COMPACT_REQUEST_SENTINEL,
          "E2E_AUTO_COMPACT",
        ])) ===
        compactRequestsBefore + 1,
      {
        timeout: 30000,
        timeoutMsg: "auto compact 基础路径没有按单次请求完成",
      },
    );
    await browser.waitUntil(
      async () => (await countUpstreamRequestsContainingAll([])) === modelRequestsBefore + 2,
      {
        timeout: 90000,
        timeoutMsg: "auto compact 成功后没有继续发起原 pending 文本的主模型请求",
      },
    );
    await waitForAssistantMessageCount(
      assistantMessagesBefore + 1,
      "auto compact 成功后没有继续执行原 pending 普通文本",
    );
    await waitForV4UserMessageContaining(pendingPrompt);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "auto compact pending 文本完成后没有回到 idle",
      90000,
    );
  });

  it("G02: autoDrain 消费普通文本前先 auto compact，成功后继续队首文本", async () => {
    await startNewV4Draft();
    await assertAutoCompactBeforeAutoDrainText(runId);
  });

  it("G04: edit 重跑前先 auto compact，成功后继续 edit 后的用户 query", async () => {
    await startNewV4Draft();
    await assertAutoCompactBeforeEditRerun(runId);
  });

  it("G03: autoDrain 消费 /goal 前先 auto compact，成功后按 goal 命令消费队首", async () => {
    await startNewV4Draft();
    await assertAutoCompactBeforeAutoDrainGoal(runId);
  });

  it("AC05: mid_turn 后下一轮 pre_request 连续自动压缩时保留两个 V4 成功 marker", async () => {
    await startNewV4Draft();
    await assertAdjacentAutoCompactMarkersRemainStructured(runId);
  });
});

async function assertAdjacentAutoCompactMarkersRemainStructured(runId: number) {
  // mid_turn compact 需要当前工具轮之前存在可压缩边界；空 task 直接进入工具轮时，
  // runtime 会正确判定 shouldCompact，但 compact planner 只能返回 skipped。
  await seedAutoCompactHistory(runId, "AC05");
  const fileMarker = `${ADJACENT_AUTO_COMPACT_MARKER}_FILE_${runId}`;
  await writeFile(ADJACENT_AUTO_COMPACT_FILE_PATH, `${fileMarker}\n`, "utf-8");

  const existingRowIds = await getV4AutoCompactRowIds();
  const compactRequestsBefore = await countUpstreamRequestsContainingAll([
    COMPACT_REQUEST_SENTINEL,
    ADJACENT_AUTO_COMPACT_MARKER,
  ]);
  const toolPrompt = `${ADJACENT_AUTO_COMPACT_MARKER}_TOOL_${runId}: Read ${ADJACENT_AUTO_COMPACT_FILE_PATH}, then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(toolPrompt);
  await waitForV4ComposerText("", "adjacent auto compact 工具轮发送后输入框没有清空");
  await waitForV4UserMessageContaining(`${ADJACENT_AUTO_COMPACT_MARKER}_TOOL_${runId}`);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "adjacent auto compact 工具轮没有完成",
    90000,
  );
  await waitForCompactRequestCount(
    compactRequestsBefore + 1,
    "adjacent auto compact 没有触发第一轮 mid_turn compact",
    30000,
  );
  const midTurnMarker = await waitForNewV4AutoCompactSuccess(existingRowIds, 30000);

  const rowIdsBeforeFollowup = new Set(existingRowIds);
  expect(midTurnMarker.rowId).not.toBeNull();
  rowIdsBeforeFollowup.add(midTurnMarker.rowId as number);
  const followupPrompt = `${ADJACENT_AUTO_COMPACT_MARKER}_FOLLOWUP_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(followupPrompt);
  await waitForV4ComposerText("", "adjacent auto compact 追问发送后输入框没有清空");
  await waitForV4UserMessageContaining(`${ADJACENT_AUTO_COMPACT_MARKER}_FOLLOWUP_${runId}`);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "adjacent auto compact 追问轮没有完成",
    90000,
  );
  await waitForCompactRequestCount(
    compactRequestsBefore + 2,
    "adjacent auto compact 没有触发第二轮 pre_request compact",
    30000,
  );
  const preRequestMarker = await waitForNewV4AutoCompactSuccess(rowIdsBeforeFollowup, 30000);
  expect(preRequestMarker.rowId).not.toBe(midTurnMarker.rowId);
}

async function assertAutoCompactBeforeAutoDrainText(runId: number) {
  await seedAutoCompactHistory(runId, "G02");
  const requestStartIndex = await getUpstreamRequestStartIndex();
  const runningMarker = `E2E_AUTO_COMPACT_DRAIN_RUNNING_TEXT_${runId}`;
  const queuedMarker = `E2E_AUTO_COMPACT_DRAIN_TEXT_${runId}`;
  const runningPrompt = `${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  const queuedPrompt = `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

  await sendV4Prompt(runningPrompt);
  await waitForV4ComposerText("", "auto compact drain 文本场景首轮发送后输入框没有清空");
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "streaming",
    "auto compact drain 文本场景首轮没有进入 streaming",
    30000,
  );

  const compactRowIdsBefore = await getV4AutoCompactRowIds();
  await sendV4Prompt(queuedPrompt);
  await waitForV4ComposerText("", "auto compact drain 文本队列发送后输入框没有清空");
  await waitForQueueContaining(queuedMarker);
  const queue = await waitForQueueCount(1);
  expect(queue[0]?.kind).toBe("text");

  await waitForAutoCompactPrefixBeforeAction(queuedMarker, requestStartIndex, compactRowIdsBefore);
  await waitForV4UserMessageContaining(queuedPrompt);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "auto compact drain 文本完成后没有清空 queue 并回到 idle",
    90000,
  );
}

async function assertAutoCompactBeforeAutoDrainGoal(runId: number) {
  await seedAutoCompactHistory(runId, "G03");
  const requestStartIndex = await getUpstreamRequestStartIndex();
  const runningMarker = `E2E_AUTO_COMPACT_DRAIN_RUNNING_GOAL_${runId}`;
  const goalMarker = `E2E_AUTO_COMPACT_DRAIN_GOAL_${runId}`;
  const runningPrompt = `${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  const goalPrompt = `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

  await sendV4Prompt(runningPrompt);
  await waitForV4ComposerText("", "auto compact drain goal 场景首轮发送后输入框没有清空");
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "streaming",
    "auto compact drain goal 场景首轮没有进入 streaming",
    30000,
  );

  const compactRowIdsBefore = await getV4AutoCompactRowIds();
  await sendV4Prompt(goalPrompt);
  await waitForV4ComposerText("", "auto compact drain goal 队列发送后输入框没有清空");
  await waitForQueueContaining(goalMarker);
  const queue = await waitForQueueCount(1);
  expect(queue[0]?.kind).toBe("goal");

  await waitForAutoCompactPrefixBeforeAction(goalMarker, requestStartIndex, compactRowIdsBefore);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "auto compact 后 goal 队首没有被消费并回到 idle",
    90000,
  );
  await waitForV4UserMessageContaining(goalMarker);
}

async function assertAutoCompactBeforeEditRerun(runId: number) {
  const contextMarker = `E2E_AUTO_COMPACT_CONTEXT_BEFORE_EDIT_A_${runId}`;
  const secondContextMarker = `E2E_AUTO_COMPACT_CONTEXT_BEFORE_EDIT_B_${runId}`;
  const seedMarker = `E2E_AUTO_COMPACT_CONTEXT_SEED_EDIT_${runId}`;
  const editMarker = `E2E_AUTO_COMPACT_EDIT_RERUN_${runId}`;
  const contextPrompt = `${contextMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  const secondContextPrompt = `${secondContextMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  const seedPrompt = `${seedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  const editedPrompt = `${editMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

  await sendV4Prompt(contextPrompt);
  await waitForV4ComposerText("", "auto compact edit context 发送后输入框没有清空");
  await waitForUpstreamRequestContaining(contextMarker, 30000);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "auto compact edit context 没有完成",
    90000,
  );

  await sendV4Prompt(secondContextPrompt);
  await waitForV4ComposerText("", "auto compact edit second context 发送后输入框没有清空");
  await waitForUpstreamRequestContaining(secondContextMarker, 30000);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "auto compact edit second context 没有完成",
    90000,
  );

  await sendV4Prompt(seedPrompt);
  await waitForV4ComposerText("", "auto compact edit seed 发送后输入框没有清空");
  await waitForUpstreamRequestContaining(seedMarker, 30000);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "auto compact edit seed 没有完成",
    90000,
  );

  const requestStartIndex = await getUpstreamRequestStartIndex();
  const compactRowIdsBefore = await getV4AutoCompactRowIds();
  await editFirstV4UserQuery(editedPrompt);
  await waitForAutoCompactPrefixBeforeAction(editMarker, requestStartIndex, compactRowIdsBefore);
  await waitForV4UserMessageContaining(editMarker);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "auto compact edit 重跑完成后没有回到 idle",
    90000,
  );
}

async function seedAutoCompactHistory(runId: number, scope: string) {
  const marker = `E2E_AUTO_COMPACT_CONTEXT_SEED_WARMUP_${scope}_${runId}`;
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${scope} auto compact warmup 后输入框没有清空`);
  await waitForUpstreamRequestContaining(marker, 30000);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${scope} auto compact warmup 没有完成`,
    90000,
  );
}

async function getUpstreamRequestStartIndex() {
  // 修复原因：getUpstreamRequestRecordCount 返回的是长度，不能直接当 afterIndex。
  // 否则 action 后第一条请求会被 index <= afterIndex 过滤掉，G04 这种第一条就是 compact 的路径会误判失败。
  return (await getUpstreamRequestRecordCount()) - 1;
}

async function waitForAutoCompactPrefixBeforeAction(
  actionMarker: string,
  requestStartIndex: number,
  compactRowIdsBefore: ReadonlySet<number>,
) {
  const compactQuery = {
    excludes: [actionMarker],
    includes: [COMPACT_REQUEST_SENTINEL],
  };
  const actionQuery = {
    excludes: [COMPACT_REQUEST_SENTINEL],
    includes: [actionMarker],
  };
  await waitForNewV4AutoCompactSuccess(compactRowIdsBefore, 30000);
  await waitForUpstreamRequest(
    actionQuery,
    `auto compact 后没有继续 action=${actionMarker} 的主请求`,
    45000,
    { afterIndex: requestStartIndex },
  );

  const actionIndex = await findFirstUpstreamRequestIndex(actionQuery, {
    afterIndex: requestStartIndex,
  });
  expect(actionIndex).not.toBeNull();
  const compactIndex = await findLastUpstreamRequestIndex(compactQuery, {
    afterIndex: requestStartIndex,
    beforeIndex: actionIndex as number,
  });
  expect(compactIndex).not.toBeNull();
  expect(compactIndex as number).toBeLessThan(actionIndex as number);
}

async function getV4AutoCompactRowIds() {
  await expandAssistantHistoriesWithContent();
  return new Set(
    (await getV4CompactMarkers())
      .filter((marker) => marker.origin === "auto" && marker.rowId !== null)
      .map((marker) => marker.rowId as number),
  );
}

async function waitForNewV4AutoCompactSuccess(
  existingRowIds: ReadonlySet<number>,
  timeout = 90000,
): Promise<V4CompactMarkerSnapshot> {
  let latestMarkers: V4CompactMarkerSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      await expandAssistantHistoriesWithContent();
      latestMarkers = await getV4CompactMarkers();
      return latestMarkers.some(
        (marker) =>
          marker.status === "success" &&
          marker.origin === "auto" &&
          marker.rowId !== null &&
          !existingRowIds.has(marker.rowId),
      );
    },
    {
      timeout,
      timeoutMsg: `没有等到新的 V4 auto/success compact marker, latest=${JSON.stringify(
        latestMarkers,
        null,
        2,
      )}`,
    },
  );

  const marker = latestMarkers.find(
    (candidate) =>
      candidate.status === "success" &&
      candidate.origin === "auto" &&
      candidate.rowId !== null &&
      !existingRowIds.has(candidate.rowId),
  );
  if (!marker) {
    throw new Error("新的 V4 auto/success compact marker 在等待后仍不存在");
  }
  return marker;
}

async function waitForCompactRequestCount(
  expectedCount: number,
  timeoutMsg: string,
  timeout: number,
) {
  await browser.waitUntil(
    async () =>
      (await countUpstreamRequestsContainingAll([
        COMPACT_REQUEST_SENTINEL,
        ADJACENT_AUTO_COMPACT_MARKER,
      ])) === expectedCount,
    {
      timeout,
      timeoutMsg,
    },
  );
}

async function waitForAssistantMessageCount(expectedCount: number, timeoutMsg: string) {
  let latestCount = 0;
  await browser.waitUntil(
    async () => {
      latestCount = (await getV4Messages("assistant")).length;
      return latestCount >= expectedCount;
    },
    {
      timeout: 90000,
      timeoutMsg: `${timeoutMsg}; latestCount=${latestCount}, expected=${expectedCount}`,
    },
  );
}

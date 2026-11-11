import { clearAppData } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4PaneSnapshot,
  getV4CompactMarkers,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4CompactMarker,
  waitForV4ComposerText,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const ACTION = "E2E_AUTO_ACTIONS";
const COMPACT = "CRITICAL: Respond with TEXT ONLY";
const GATE = "upstream-auto-actions-compact-slow";

describe("会话区下次发送模型与 Auto Compact E2E", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
  });
  beforeEach(async () => {
    await startNewV4Draft();
    await selectConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
  });
  afterEach(async () => {
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("N05: 选择小窗口模型不触发压缩，下一条普通输入采用新模型", async function () {
    this.timeout(150000);
    const id = Date.now();
    await sendAndComplete(`${ACTION}_MODEL_SWITCH_GUARD_CONTEXT_${id}`);
    await selectConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await expectNoMenuCompact();
    const marker = `${ACTION}_PENDING_TEXT_NEXT_${id}`;
    await sendAndComplete(marker);
    await assertModel(marker, UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
  });

  it("N05: 发消息前改回原模型，撤销待发送选择且不触发压缩", async function () {
    this.timeout(150000);
    const id = Date.now();
    await sendAndComplete(`${ACTION}_MODEL_SWITCH_CANCEL_CONTEXT_${id}`);
    await selectConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await expectNoMenuCompact();
    await selectConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
    await expectNoMenuCompact();
    const marker = `${ACTION}_PENDING_TEXT_CANCEL_${id}`;
    await sendAndComplete(marker);
    await assertModel(marker, UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
  });

  it("N06: 自动压缩中改选模型，已提交输入保留原模型，下一输入采用新模型", async function () {
    this.timeout(240000);
    const id = Date.now();
    // 当前 planner 保留最近一轮；两轮历史才有可压缩分区，不能将 noop 算作覆盖。
    for (const phase of ["WARMUP", "READY"]) {
      await sendAndComplete(`${ACTION}_CONTEXT_SEED_${phase}_${id}`);
    }
    const pending = `${ACTION}_PENDING_TEXT_ADMITTED_${id}`;
    await sendV4Prompt(prompt(pending));
    await waitForV4ComposerText("", "自动压缩前的输入没有被接受");
    await waitForUpstreamRequest({ includes: [COMPACT, ACTION] }, "没有产生自动压缩请求");
    await waitForV4CompactMarker({ origin: "auto", status: "running" });
    // 由响应门闩保持真实在途窗口，菜单操作完成后才释放，不靠延时竞争。
    await selectConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    expect(await countUpstreamRequests({ includes: [COMPACT, ACTION] })).toBe(1);
    await releaseControlledReplay(GATE);
    const compact = await waitForUpstreamNetworkCapture(COMPACT);
    assertUpstreamRequestCapture(compact, { expectedText: COMPACT, model: UPSTREAM_MODEL });
    expect(compact.requestJson).toMatchObject({ stream: true });
    expect(compact.responseHeaders["content-type"]).toContain("text/event-stream");
    await waitForV4CompactMarker({ origin: "auto", status: "success" });
    await assertModel(pending, UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
    await waitForIdle();
    expect(await countUpstreamRequests({ includes: [COMPACT, ACTION] })).toBe(1);
    const next = `${ACTION}_PENDING_TEXT_AFTER_${id}`;
    await sendV4Prompt(prompt(next));
    await waitForV4ComposerText("", "切换后的新输入未被接受");
    // 新输入切到另一个小窗口模型后可再次触发正常自动压缩；它必须使用新输入的模型。
    // 旧 fixture 每次都挂起，若只释放第一条摘要，会把合法的第二次压缩误报为卡死。
    await browser.waitUntil(
      async () => (await countUpstreamRequests({ includes: [COMPACT, ACTION] })) === 2,
      {
        timeout: 30000,
        timeoutMsg: "新输入未触发目标小窗口模型的自动压缩",
      },
    );
    const summaries = await getUpstreamRequestEvidence({ includes: [COMPACT, ACTION] });
    expect(summaries[1]?.requestJson).toMatchObject({ model: UPSTREAM_SECONDARY_MODEL });
    await releaseControlledReplay(GATE);
    await assertModel(next, UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await waitForIdle();
    expect(await countUpstreamRequests({ includes: [COMPACT, ACTION] })).toBe(2);
  });
});

function prompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}
async function selectConfig(model: string, thought: string) {
  await selectUpstreamModelById(model);
  await selectUpstreamThoughtLevelValue(thought);
}
async function waitForIdle() {
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    "输入完成后没有回到 idle",
    90000,
  );
}
async function sendAndComplete(marker: string) {
  await sendV4Prompt(prompt(marker));
  await waitForV4ComposerText("", "普通输入没有被接受");
  await waitForUpstreamNetworkCapture(marker);
  await waitForIdle();
}
async function assertModel(marker: string, model: string, thought: string) {
  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [marker], excludes: [COMPACT] },
    "没有实际主模型请求",
  );
  const record = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(record, { expectedText: marker, model });
  assertUpstreamThoughtLevelCapture(record, thought);
}
async function expectNoMenuCompact() {
  // 当前契约只设置下一输入意图，不存在选择模型即确认压缩的入口。
  expect(await getV4CompactMarkers()).toHaveLength(0);
  expect(await countUpstreamRequests({ includes: [COMPACT, ACTION] })).toBe(0);
  expect(
    await browser.execute(
      () =>
        document.body.innerText.includes("需要压缩上下文后再切换模型") ||
        document.body.innerText.includes("Compress context before switching models"),
    ),
  ).toBe(false);
}

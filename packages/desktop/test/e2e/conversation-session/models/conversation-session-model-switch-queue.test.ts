import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
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
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  clickFirstQueueSendNow,
  waitForQueueContaining,
  waitForQueueCount,
} from "#e2e/helpers/conversation-session-queue";
import {
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";

const MODEL_SWITCH_QUEUE_TIMEOUT_MS = 180000;

describe("会话区模型切换 Queue E2E", () => {
  before(async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
  });

  beforeEach(async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    await startNewV4Draft();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("stop 后 held queue 切模型再立即发送，保留提交时 primary 配置", async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    const runId = Date.now();
    const runningMarker = `E2E_MODEL_SWITCH_HELD_RUNNING_${runId}`;
    const heldMarker = `E2E_MODEL_SWITCH_HELD_SEND_NOW_${runId}`;
    const runningPrompt = `E2E_SLOW_STREAM ${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "模型切换 held 首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "模型切换 held 首轮没有进入 streaming",
      30000,
    );
    // 修复原因：标题生成也会短暂进入 streaming；必须等真正的 main request
    // 已经进入 provider 后再发送 queued prompt，否则 queued marker 会被并入首轮请求。
    await waitForUpstreamRequest(
      { excludes: [heldMarker], includes: [runningMarker] },
      "模型切换 held 首轮 main request 没有进入 上游 capture",
      30000,
    );

    const heldPrompt = `${heldMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(heldPrompt);
    await waitForV4ComposerText("", "模型切换 held queued text 发送后输入框没有清空");
    await waitForQueueContaining(heldMarker);
    const queuedItems = await waitForQueueCount(1);
    expect(queuedItems[0]?.kind).toBe("text");
    expect(queuedItems[0]?.content).toContain(heldMarker);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "stop 后没有退出 streaming 并保留 held queue",
      30000,
    );
    await expectNoUpstreamRequestForTextWithin(heldMarker, 900);

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.content).toContain(heldMarker);

    const sendNowRecord = await waitForUpstreamNetworkCapture(heldMarker);
    // 用户确认：立即发送只提升原 Submission，不能重新读取 Composer 的模型选择。
    assertUpstreamRequestCapture(sendNowRecord, {
      expectedText: heldMarker,
      model: UPSTREAM_MODEL,
    });
    assertUpstreamThoughtLevelCapture(sendNowRecord, UPSTREAM_THOUGHT_LEVEL);
  });

  it("running 中 queued text 消费前切模型，auto drain 保留提交时 primary 配置", async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    const runId = Date.now();
    const runningMarker = `E2E_MODEL_SWITCH_QUEUE_RUNNING_${runId}`;
    const queuedMarker = `E2E_MODEL_SWITCH_QUEUE_AUTO_DRAIN_${runId}`;
    const runningPrompt = `E2E_SLOW_STREAM ${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "模型切换 queue 首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "模型切换 queue 首轮没有进入 streaming",
      30000,
    );
    await waitForUpstreamRequest(
      { excludes: [queuedMarker], includes: [runningMarker] },
      "模型切换 queue 首轮 main request 没有进入 上游 capture",
      30000,
    );

    const queuedPrompt = `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(queuedPrompt);
    await waitForV4ComposerText("", "模型切换 queued text 发送后输入框没有清空");
    await waitForQueueContaining(queuedMarker);
    const queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");
    expect(queue[0]?.content).toContain(queuedMarker);

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    // N02 无上下文 guard；模型选择完成后再放行主流，固定真实 auto-drain 边界。
    await releaseControlledReplay("upstream-model-switch-queue-running-slow");
    await waitForV4ConversationState(
      (snapshot) => snapshot.queueCount === 0,
      "切换 secondary 后 queued text 没有开始 auto drain",
      120000,
    );
    const queuedRecord = await waitForUpstreamNetworkCapture(queuedMarker);
    // N02：消费不能回读最新 Composer 选择，必须保持提交时冻结的配置。
    assertUpstreamRequestCapture(queuedRecord, {
      expectedText: queuedMarker,
      model: UPSTREAM_MODEL,
    });
    assertUpstreamThoughtLevelCapture(queuedRecord, UPSTREAM_THOUGHT_LEVEL);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "切换 secondary 后 queued text 没有被 auto drain 消费完成",
      90000,
    );
  });
});

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "afterEach stop 后没有退出 streaming",
    30000,
  ).catch(() => undefined);
}

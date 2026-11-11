import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
} from "#e2e/helpers/conversation-session-network";
import {
  UPSTREAM_MODEL,
  ensureUpstreamProviderForE2E,
  selectUpstreamModel,
} from "#e2e/helpers/upstream-provider";
import {
  getV4Messages,
  getV4ConversationState,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const EMPTY_COMPLETION_MARKER = "E2E_EMPTY_COMPLETION_RETRY_STREAM";
const EMPTY_COMPLETION_REPLY = "EMPTY_COMPLETION_RETRY_OK";
const CONTEXT_FINISH_MARKER = "E2E_EMPTY_COMPLETION_CONTEXT_FINISH";
const CONTEXT_FINISH_REPLY = "EMPTY_CONTEXT_FINISH_OK";
const CONTEXT_SEED_MARKER = "E2E_EMPTY_COMPLETION_CONTEXT_SEED";
const CONTEXT_SEED_REPLY = "EMPTY_CONTEXT_SEED_OK";
const CONTEXT_SUMMARY_MARKER = "EMPTY_CONTEXT_COMPACT_SUMMARY";
const CONTINUE_PROMPT_PREFIX = "Output token limit hit. Resume directly";

describe("generic empty completion retry E2E", () => {
  before(async () => {
    await skipOccupationOnboardingIfPresent();
    // 无账号回放只需 Personal Provider；通用准备流程会要求模型不支持的 high 档位。
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  });

  beforeEach(async () => {
    // 新任务进入独立会话工作区，后续场景不应再等待首次启动的项目工作区。
    await startNewV4Draft();
    await selectUpstreamModel();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I73: 首个 finish=other 空流不泄漏，并且只重试一次后显示成功回复", async function () {
    this.timeout(180000);

    const prompt = `${EMPTY_COMPLETION_MARKER}: Reply with exactly "${EMPTY_COMPLETION_REPLY}" and no other text.`;
    await sendV4Prompt(prompt);

    await waitForV4AssistantMessageContaining(EMPTY_COMPLETION_REPLY);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "空 completion 重试成功后没有回到 idle",
      90000,
    );

    await browser.waitUntil(
      async () => (await countUpstreamRequests({ includes: [EMPTY_COMPLETION_MARKER] })) === 2,
      {
        timeout: 30000,
        timeoutMsg: "空 completion 没有严格产生 first-empty → second-success 两次请求",
      },
    );

    const request = await waitForUpstreamNetworkCapture(EMPTY_COMPLETION_MARKER);
    assertUpstreamRequestCapture(request, {
      expectedText: prompt,
      model: UPSTREAM_MODEL,
    });

    const evidence = await getUpstreamRequestEvidence({
      includes: [EMPTY_COMPLETION_MARKER],
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.fixtureId)).toEqual([
      "empty-completion-retry-stream-first-empty",
      "empty-completion-retry-stream-second-success",
    ]);
    expect(evidence.every((item) => item.status === "complete")).toBe(true);
    expect(evidence.every((item) => item.responseBodyBytes > 0)).toBe(true);
    expect(evidence[0]?.responseTextPreview).toContain('"stop_reason":"other"');
    expect(evidence[0]?.responseTextPreview).toContain('"output_tokens":0');
    expect(evidence[1]?.responseTextPreview).toContain(EMPTY_COMPLETION_REPLY);

    const assistantMessages = await getV4Messages("assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toContain(EMPTY_COMPLETION_REPLY);
  });

  it("明确上下文限制的空流先 Reactive Compact，再重试当前请求且不追加 Continue", async function () {
    this.timeout(180000);

    // 先通过真实会话产生可压缩历史，避免历史不足使 Reactive Compact 按设计跳过。
    for (const round of [1, 2]) {
      await sendV4Prompt(`${CONTEXT_SEED_MARKER}_${round}: Reply with "${CONTEXT_SEED_REPLY}".`);
      // 两轮回复相同，旧回复可能提前满足 UI 等待；先确认本轮请求完整落盘，避免 seed 混入恢复取样。
      await waitForUpstreamNetworkCapture(`${CONTEXT_SEED_MARKER}_${round}`);
      await waitForV4AssistantMessageContaining(CONTEXT_SEED_REPLY);
      await waitForV4ConversationState((snapshot) => snapshot.state === "idle", "历史准备未完成");
    }
    const afterIndex = (await getUpstreamRequestRecordCount()) - 1;
    await sendV4Prompt(`${CONTEXT_FINISH_MARKER}: Reply with exactly "${CONTEXT_FINISH_REPLY}".`);
    await waitForV4AssistantMessageContaining(CONTEXT_FINISH_REPLY);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "明确终止原因经 Reactive Compact 恢复后没有回到 idle",
      90000,
    );
    // Reactive Compact 位于已完成轮次的折叠工作记录中；先展开再检查可见标记。
    await expandAssistantHistoriesWithContent();
    // 产品投影将自动与 Reactive Compact 都展示为 auto；请求顺序区分真实触发路径。
    await waitForV4CompactMarker({ origin: "auto", status: "success" });

    const evidence = await getUpstreamRequestEvidence({}, { afterIndex });
    expect(evidence).toHaveLength(3);
    expect(evidence.map((item) => item.fixtureId)).toEqual([
      "empty-context-finish-first-empty",
      "empty-context-finish-compact",
      "empty-context-finish-retry-success",
    ]);
    expect(evidence.every((item) => item.status === "complete")).toBe(true);
    expect(evidence[0]?.responseTextPreview).toContain('"model_context_window_exceeded"');
    expect(JSON.stringify(evidence)).not.toContain(CONTINUE_PROMPT_PREFIX);
    expect(JSON.stringify(evidence[1]?.requestJson)).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(JSON.stringify(evidence[2]?.requestJson)).toContain(CONTEXT_SUMMARY_MARKER);
    expect(JSON.stringify(evidence[2]?.requestJson)).toContain(CONTEXT_FINISH_MARKER);
    const assistantMessages = await getV4Messages("assistant");
    expect(
      assistantMessages.filter((message) => message.text.includes(CONTEXT_FINISH_REPLY)),
    ).toHaveLength(1);

    const sessionId = (await getV4ConversationState()).sessionId;
    expect(sessionId).toBeTruthy();
    // idle 事件先于 usage 落盘；等待权威存储完成，不通过固定延时猜测。
    await browser.waitUntil(() => readRecoveryUsage(sessionId!).models.length === 3, {
      timeout: 10000,
      timeoutMsg: "上下文恢复的三个请求没有独立记录 usage",
    });
    const usage = readRecoveryUsage(sessionId!);
    expect(
      usage.models.map(({ querySource, totalTokens }) => ({ querySource, totalTokens })),
    ).toEqual([
      { querySource: "main_turn", totalTokens: 85 },
      { querySource: "compact", totalTokens: 112 },
      { querySource: "main_turn", totalTokens: 104 },
    ]);
    expect(new Set(usage.models.map((model) => model.logicalRequestId)).size).toBe(3);
    expect(usage.models).toMatchObject([
      { status: "error", contextExceeded: 1, errorType: "context_exceeded" },
      { status: "completed", contextExceeded: 0, errorType: null },
      { status: "completed", contextExceeded: 0, errorType: null },
    ]);
    expect(usage.turn).toMatchObject({ status: "completed", totalTokens: 301 });
  });
});

function readRecoveryUsage(sessionId: string) {
  // Node 内置 SQLite 仅提供同步接口；测试只读当前 turn 的少量记录并立即关闭。
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
    { readOnly: true },
  );
  try {
    const turn = database
      .prepare(`select turn_id as turnId, status, computed_total_tokens as totalTokens
      from turn_usage where session_id = ? order by started_at desc limit 1`)
      .get(sessionId) as { turnId: string; status: string; totalTokens: number } | undefined;
    const models = turn
      ? (database
          .prepare(`select logical_request_id as logicalRequestId,
      query_source as querySource, status, computed_total_tokens as totalTokens,
      context_exceeded as contextExceeded, error_type as errorType
      from model_usage where session_id = ? and turn_id = ? order by started_at, rowid`)
          .all(sessionId, turn.turnId) as Array<{
          logicalRequestId: string;
          querySource: string;
          status: string;
          contextExceeded: number;
          errorType: string | null;
          totalTokens: number;
        }>)
      : [];
    return { turn, models };
  } finally {
    database.close();
  }
}

import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  getLatestUpstreamToolResultByToolCallId,
} from "#e2e/helpers/conversation-session-network";
import {
  E2E_READONLY_TOOL_FILE_CONTENT,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { listToolCallBlocks } from "#e2e/helpers/conversation-session-tool";
import {
  clickV4Stop,
  getV4ConversationState,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const TEST_TIMEOUT_MS = 180_000;
const OUTCOME_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_LOWER_BOUND_MS = 700;
const LATE_SENTINEL_OFFSET_MS = 5_000;

interface StallScenario {
  cutoffMarker?: string;
  finishMarker: string;
  firstFixtureId: string;
  id: string;
  marker: string;
  partialHistoryMustBeDiscarded?: string;
  recovery: "required" | "diagnostic";
  secondFixtureIds: string[];
  stallRequestIndex?: number;
  toolCallId?: string;
  toolExecution: "forbidden" | "none" | "required";
}

const SCENARIOS: StallScenario[] = [
  {
    finishMarker: "E2E_SSE_STALL_PRELUDE_DONE",
    firstFixtureId: "sse-stall-prelude-stalled",
    id: "SSE-ST-01 message_start",
    marker: "E2E_SSE_STALL_PRELUDE",
    recovery: "required",
    secondFixtureIds: ["sse-stall-prelude-recovered"],
    toolExecution: "none",
  },
  {
    cutoffMarker: "E2E_SSE_STALL_THINKING_PARTIAL",
    finishMarker: "E2E_SSE_STALL_THINKING_DONE",
    firstFixtureId: "sse-stall-thinking-stalled",
    id: "SSE-ST-02 thinking_delta",
    marker: "E2E_SSE_STALL_THINKING",
    partialHistoryMustBeDiscarded: "E2E_SSE_STALL_THINKING_PARTIAL",
    recovery: "required",
    secondFixtureIds: ["sse-stall-thinking-recovered"],
    toolExecution: "none",
  },
  {
    cutoffMarker: "E2E_SSE_STALL_TEXT_PARTIAL",
    finishMarker: "E2E_SSE_STALL_TEXT_DONE",
    firstFixtureId: "sse-stall-text-stalled",
    id: "SSE-ST-03 text_delta",
    marker: "E2E_SSE_STALL_TEXT",
    recovery: "diagnostic",
    secondFixtureIds: ["sse-stall-text-recovered"],
    toolExecution: "none",
  },
  {
    finishMarker: "E2E_SSE_STALL_TOOL_INPUT_DONE",
    firstFixtureId: "sse-stall-tool-input-stalled",
    id: "SSE-ST-04 incomplete tool input",
    marker: "E2E_SSE_STALL_TOOL_INPUT",
    partialHistoryMustBeDiscarded: "E2E_SSE_STALL_TOOL_INPUT_PARTIAL",
    recovery: "diagnostic",
    secondFixtureIds: ["sse-stall-tool-input-recovered"],
    toolCallId: "toolu_e2e_sse_stall_partial_read",
    toolExecution: "forbidden",
  },
  {
    finishMarker: "E2E_SSE_STALL_TOOL_COMMITTED_DONE",
    firstFixtureId: "sse-stall-tool-committed-stalled",
    id: "SSE-ST-05 committed tool block",
    marker: "E2E_SSE_STALL_TOOL_COMMITTED",
    recovery: "required",
    secondFixtureIds: ["sse-stall-tool-committed-continuation"],
    toolCallId: "toolu_e2e_sse_stall_committed_read",
    toolExecution: "required",
  },
  {
    finishMarker: "E2E_SSE_STALL_POST_TOOL_DONE",
    firstFixtureId: "sse-stall-post-tool-continuation-stalled",
    id: "SSE-ST-06 after successful tool execution",
    marker: "E2E_SSE_STALL_POST_TOOL",
    recovery: "required",
    secondFixtureIds: ["sse-stall-post-tool-continuation-recovered"],
    stallRequestIndex: 1,
    toolCallId: "toolu_e2e_sse_stall_post_tool_read",
    toolExecution: "required",
  },
];

describe("SSE event 中途停发的真实 Desktop E2E diagnostic", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await startNewV4Draft();
  });

  afterEach(async () => {
    const pane = await getV4PaneSnapshot().catch(() => null);
    if (!pane?.canStop) return;
    await clickV4Stop().catch(() => undefined);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "SSE stall diagnostic afterEach stop 没有退出 streaming",
      30_000,
    ).catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: stall 后采集恢复、UI 与工具副作用`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await runStallScenario(scenario);
    });
  }
});

async function runStallScenario(scenario: StallScenario): Promise<void> {
  await sendV4Prompt(`${scenario.marker}: observe the provider stream without adding assumptions.`);
  const stallRequestIndex = scenario.stallRequestIndex ?? 0;
  await browser.waitUntil(
    async () => {
      const evidence = await getUpstreamRequestEvidence({ includes: [scenario.marker] });
      return evidence[stallRequestIndex]?.fixtureId === scenario.firstFixtureId;
    },
    {
      timeout: 30_000,
      timeoutMsg: `${scenario.id} 目标 stall 请求没有进入 replay server`,
    },
  );

  if (scenario.cutoffMarker === "E2E_SSE_STALL_TEXT_PARTIAL") {
    // 正文 cutoff 必须先真实投影到 live UI，不能只凭 fixture 声称越过 visible boundary。
    await waitForV4TimelineContaining(scenario.cutoffMarker, 2_000);
  } else {
    // 其余 cutoff 不强制要求当前 UI 显示 reasoning/tool partial，但给事件进入 runtime 留出窗口。
    await browser.pause(180);
  }

  const stallPane = await getV4PaneSnapshot();
  const stallRuntime = await getV4ConversationState();
  expect(stallPane.canStop).toBe(true);
  expect(stallRuntime.state).toBe("streaming");

  const outcomeElapsedMs = await waitForOutcome(scenario);
  expect(outcomeElapsedMs).toBeGreaterThanOrEqual(IDLE_TIMEOUT_LOWER_BOUND_MS);
  // fixture 的下一个 ping 在 5s；必须在它到达前由 idle timeout 触发恢复或 terminal，
  // 否则测到的是 delayed EOF，而不是“无 event”保护。
  expect(outcomeElapsedMs).toBeLessThan(LATE_SENTINEL_OFFSET_MS);

  let evidence = await getUpstreamRequestEvidence({ includes: [scenario.marker] });
  expect(evidence[stallRequestIndex]?.fixtureId).toBe(scenario.firstFixtureId);
  expect(evidence.length).toBeLessThanOrEqual(stallRequestIndex + 2);

  const second = evidence[stallRequestIndex + 1];
  if (scenario.recovery === "required") {
    expect(second).toBeDefined();
  }
  if (second) {
    expect(scenario.secondFixtureIds).toContain(second.fixtureId);
    expect(second.statusCode).toBe(200);
    await waitForV4AssistantMessageContaining(scenario.finishMarker, 30_000);
  }

  await waitForV4Pane(
    (snapshot) => !snapshot.canStop,
    `${scenario.id} 没有在 idle timeout/recovery 后退出 streaming`,
    30_000,
  );
  evidence = await getUpstreamRequestEvidence({ includes: [scenario.marker] });
  expect(evidence.length).toBe(second ? stallRequestIndex + 2 : stallRequestIndex + 1);

  const recoveryRequestText = second ? JSON.stringify(second.requestJson) : "";
  if (second && scenario.partialHistoryMustBeDiscarded) {
    expect(recoveryRequestText).not.toContain(scenario.partialHistoryMustBeDiscarded);
  }

  const toolBlocks = scenario.toolCallId
    ? (await listToolCallBlocks()).filter((block) => block.toolCallId === scenario.toolCallId)
    : [];
  expect(toolBlocks.length).toBeLessThanOrEqual(1);
  const toolResult = scenario.toolCallId
    ? await getLatestUpstreamToolResultByToolCallId(scenario.toolCallId)
    : null;
  if (scenario.toolExecution === "forbidden") {
    expect(toolResult).toBeNull();
  }
  if (scenario.toolExecution === "required") {
    expect(toolResult?.isError).toBe(false);
    expect(toolResult?.content).toContain(E2E_READONLY_TOOL_FILE_CONTENT);
  }
  if (second?.fixtureId === "sse-stall-tool-committed-continuation") {
    expect(recoveryRequestText).toContain("toolu_e2e_sse_stall_committed_read");
  }

  const settledPane = await getV4PaneSnapshot();
  const settledRuntime = await getV4ConversationState();
  const result = {
    case: scenario.id,
    cutoffVisibleAfterRecovery:
      scenario.cutoffMarker === undefined
        ? null
        : settledPane.timelineText.includes(scenario.cutoffMarker),
    finishVisible: settledPane.timelineText.includes(scenario.finishMarker),
    outcomeElapsedMs,
    requests: evidence.map((record) => ({
      fixtureId: record.fixtureId,
      responseEventCount: record.responseEventCount,
      status: record.status,
    })),
    settled: summarizeRuntime(settledPane, settledRuntime),
    stall: summarizeRuntime(stallPane, stallRuntime),
    toolBlockCount: toolBlocks.length,
    toolResult: toolResult
      ? {
          contentIncludesReadonlyFixture: toolResult.content.includes(
            E2E_READONLY_TOOL_FILE_CONTENT,
          ),
          isError: toolResult.isError,
        }
      : null,
  };
  console.info(`[sse-stall-diagnostic] ${JSON.stringify(result)}`);
}

async function waitForOutcome(scenario: StallScenario): Promise<number> {
  const startedAtMs = Date.now();
  const recoveryRequestCount = (scenario.stallRequestIndex ?? 0) + 2;
  await browser.waitUntil(
    async () => {
      const evidence = await getUpstreamRequestEvidence({ includes: [scenario.marker] });
      const recoveryRequest = evidence[recoveryRequestCount - 1];
      // 修复原因：请求先建档，fixture 与响应稍后回填；只等数量会读到 null。
      // 等本次恢复响应完成抓包，不要求被 watchdog 中止的旧请求变成 complete。
      if (recoveryRequest) return recoveryRequest.status !== "pending";
      const pane = await getV4PaneSnapshot();
      return !pane.canStop;
    },
    {
      interval: 100,
      timeout: OUTCOME_TIMEOUT_MS,
      timeoutMsg: `${scenario.id} 在 ${OUTCOME_TIMEOUT_MS}ms 内既未恢复也未进入 terminal`,
    },
  );
  return Date.now() - startedAtMs;
}

function summarizeRuntime(
  pane: Awaited<ReturnType<typeof getV4PaneSnapshot>>,
  runtime: Awaited<ReturnType<typeof getV4ConversationState>>,
) {
  return {
    activeInput: Boolean(runtime.activeInputId),
    canStop: pane.canStop,
    rowCount: pane.rowCount,
    runtimeStatus: runtime.runtimeStatus,
    state: runtime.state,
    timelineTail: pane.timelineText.slice(-240),
  };
}

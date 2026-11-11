import { TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  getV4ConversationState,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";

const GOAL_MARKER_PREFIX = "E2E_GOAL_TIMELINE_REPRO";
const GOAL_A_MARKER = `${GOAL_MARKER_PREFIX}_A`;
const GOAL_B_MARKER = `${GOAL_MARKER_PREFIX}_B`;
const FIRST_REPLY = "人类灭绝后，机器哭了。";
const FINAL_REPLY = "人类灭绝之后，机器哭了。";
const SECOND_TARGET_REPLY = "这需要长篇连载，无法一次交付十万字。";
const SECOND_TARGET_CONTINUATION = "E2E_GOAL_TIMELINE_REPRO_B_CONTINUING";
interface GoalTimelineExpectation {
  label: string;
  texts: readonly string[];
}

const FIRST_TARGET_TIMELINE_STEPS = [
  {
    label: "iteration-1-incomplete",
    texts: ["第 1 次迭代 · 目标未完成，任务继续", "Iteration 1 · Goal incomplete, continuing"],
  },
  {
    label: "iteration-2-complete",
    texts: ["第 2 次迭代 · 目标已完成，任务结束", "Iteration 2 · Goal complete, ending task"],
  },
] as const satisfies readonly GoalTimelineExpectation[];

const NEW_TARGET_TIMELINE_STEP = {
  label: "new-target-iteration-1",
  texts: [
    "第 1 次迭代 · 目标校验中",
    "Iteration 1 · Verifying goal",
    "第 1 次迭代 · 目标未完成，任务继续",
    "Iteration 1 · Goal incomplete, continuing",
  ],
} as const satisfies GoalTimelineExpectation;

const EXPECTED_TIMELINE_STEPS = [
  ...FIRST_TARGET_TIMELINE_STEPS,
  {
    ...NEW_TARGET_TIMELINE_STEP,
  },
] as const satisfies readonly GoalTimelineExpectation[];

interface ConversationEntrySnapshot {
  id: string | null;
  kind: "assistant" | "goalTimeline" | "user";
  text: string;
  title: string | null;
}

describe("会话区 Goal Timeline E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("同 target 自动续跑与新 target 的 verifier timeline 不应串成同一轮序列", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const objective = `${GOAL_A_MARKER}: 写一篇恰好 10 个汉字的科幻小说。不要调用工具。`;
    await sendV4Prompt(`/goal ${objective}`);
    await waitForV4ComposerText("", "goal timeline: /goal 发送后输入框没有清空");
    await waitForV4UserMessageContaining(objective);

    await waitForUpstreamRequest(
      {
        excludes: [FINAL_REPLY],
        includes: [GOAL_A_MARKER, "Verify whether the active session goal"],
      },
      "goal timeline: 没有捕获到第 1 次 verifier 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining(FIRST_REPLY);

    await waitForUpstreamRequest(
      {
        includes: [GOAL_A_MARKER, FINAL_REPLY, "Verify whether the active session goal"],
      },
      "goal timeline: 没有捕获到第 2 次 verifier 请求",
      120000,
    );
    await waitForV4AssistantMessageContaining(FINAL_REPLY);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(GOAL_A_MARKER) === true &&
        // 当前 V4 投影以 verified 表示 verifier 已确认完成，旧 complete 属于 legacy meta。
        snapshot.targetStatus === "verified",
      "goal timeline: 第一个目标最终没有回到完成态",
      120000,
    );
    // 修复原因：targetStatus 已完成可能早于 synthetic timeline divider 完成渲染；
    // 先等第一个 target 的两条 divider 落 DOM，再切新 target，避免测试制造排序 race。
    await waitForGoalTimelineTexts(FIRST_TARGET_TIMELINE_STEPS);

    const secondTargetObjective = `${GOAL_B_MARKER}: 写一篇 10w 字科幻小说。不要调用工具。`;
    await sendV4Prompt(`/goal ${secondTargetObjective}`);
    await waitForV4ComposerText("", "goal timeline: 第二个 /goal 发送后输入框没有清空");
    await waitForV4UserMessageContaining(secondTargetObjective);
    await waitForV4AssistantMessageContaining(SECOND_TARGET_REPLY);
    await waitForUpstreamRequest(
      {
        includes: [GOAL_B_MARKER, SECOND_TARGET_REPLY, "Verify whether the active session goal"],
      },
      "goal timeline: 没有捕获到新 target 的第 3 次 verifier 请求",
      120000,
    );
    // 新目标未完成会合法续跑；旧夹具缺这一轮，500 也能通过时间线断言。
    // 等受控流正文实际到达，再核对 timeline 并 stop，避免错误请求冒充正常续跑。
    await waitForV4AssistantMessageContaining(SECOND_TARGET_CONTINUATION);
    const continuationRequests = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: [GOAL_B_MARKER, "Reason: 没有交付 10w 字小说。"],
      excludes: ["Verify whether the active session goal", "Generate a concise title"],
    });
    expect(continuationRequests).toHaveLength(1);
    expect(continuationRequests[0]?.fixtureId).toBe(
      "upstream-goal-timeline-new-target-continuation",
    );
    const entries = await waitForGoalTimelineTexts(EXPECTED_TIMELINE_STEPS);
    await stopIfStreaming();

    // 第四轮正文保持打开，stop 前不会完成，也不会产生额外 verifier。
    expect(
      await countUpstreamRequests({
        includes: [GOAL_MARKER_PREFIX, "Verify whether the active session goal"],
      }),
    ).toBe(3);

    const timelineTexts = entries
      .filter((entry) => entry.kind === "goalTimeline")
      .map((entry) => normalizeEntryText(entry.text));

    expect(resolveGoalTimelineSteps(timelineTexts, EXPECTED_TIMELINE_STEPS)).toEqual(
      EXPECTED_TIMELINE_STEPS.map((step) => step.label),
    );

    const firstAssistantIndex = findEntryIndex(entries, "assistant", FIRST_REPLY);
    const firstTimelineIndex = findEntryIndex(entries, "goalTimeline", EXPECTED_TIMELINE_STEPS[0]);
    const finalTimelineIndex = findEntryIndex(entries, "goalTimeline", EXPECTED_TIMELINE_STEPS[1]);
    const secondTargetUserIndex = findEntryIndex(entries, "user", secondTargetObjective);
    const secondTargetTimelineIndex = findEntryIndexFrom(
      entries,
      "goalTimeline",
      NEW_TARGET_TIMELINE_STEP,
      finalTimelineIndex + 1,
    );

    const orderSnapshot = {
      entries,
      firstAssistantIndex,
      firstTimelineIndex,
      finalTimelineIndex,
      secondTargetUserIndex,
      secondTargetTimelineIndex,
    };
    if (
      firstAssistantIndex < 0 ||
      firstTimelineIndex < 0 ||
      finalTimelineIndex < 0 ||
      secondTargetUserIndex < 0 ||
      secondTargetTimelineIndex < 0
    ) {
      throw new Error(
        `goal timeline: 缺少预期消息或 timeline: ${JSON.stringify(orderSnapshot, null, 2)}`,
      );
    }
    expect(firstAssistantIndex).toBeLessThan(firstTimelineIndex);
    expect(firstTimelineIndex).toBeLessThan(finalTimelineIndex);
    // Bugfix: first target complete 后 synthetic divider 可能晚于第二个 /goal user
    // 进入 DOM；本 case 只要求同 target 内部顺序正确，且新 target timeline 不串到旧 target 前。
    expect(secondTargetUserIndex).toBeLessThan(secondTargetTimelineIndex);
    expect(finalTimelineIndex).toBeLessThan(secondTargetTimelineIndex);
  });
});

async function stopIfStreaming() {
  const snapshot = await getV4ConversationState();
  if (snapshot.state !== "streaming" && snapshot.runtimeStatus !== "streaming") {
    return;
  }

  // 续跑响应由 fixture 保持打开；真实点击 stop 取消该流，完成测试收尾。
  await clickV4Stop();
  await waitForV4ConversationState(
    (latest) => latest.state !== "streaming" && latest.runtimeStatus !== "streaming",
    "goal timeline: 收尾 stop 后没有退出 streaming",
    30000,
  );
}

async function waitForGoalTimelineTexts(expectedSteps: readonly GoalTimelineExpectation[]) {
  let entries: ConversationEntrySnapshot[] = [];
  let timelineTexts: string[] = [];
  let timelineSteps: Array<string | null> = [];
  await browser.waitUntil(
    async () => {
      entries = await getConversationEntrySnapshot();
      timelineTexts = entries
        .filter((entry) => entry.kind === "goalTimeline")
        .map((entry) => normalizeEntryText(entry.text));
      timelineSteps = resolveGoalTimelineSteps(timelineTexts, expectedSteps);
      // 修复原因：CI 和本地可能使用不同 locale，timeline 文案会在中英文间切换。
      // 这里锁定 verifier 轮次/完成语义，而不是固定某一种语言的展示文案。
      return expectedSteps.every((step, index) => timelineSteps[index] === step.label);
    },
    {
      timeout: 30000,
      timeoutMsg: `goal timeline: 没有看到完成后的目标校验序列, expected=${JSON.stringify(
        expectedSteps.map((step) => step.label),
      )}, actual=${JSON.stringify(timelineSteps)}, texts=${JSON.stringify(
        timelineTexts,
      )}, entries=${JSON.stringify(entries)}`,
    },
  );
  return entries;
}

function getConversationEntrySnapshot(): Promise<ConversationEntrySnapshot[]> {
  return browser.execute(
    (paneId) => {
      // V4 的消息和目标校验都是 canonical row；旧 chat-messages / synthetic message DOM 已退场。
      const root = document.querySelector(`[data-testid="${paneId}"]`);
      const entries: ConversationEntrySnapshot[] = [];
      for (const element of root?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []) {
        const kind = element.classList.contains("group/user-row")
          ? "user"
          : element.classList.contains("group/assistant-row")
            ? "assistant"
            : element.dataset.markerType === "goalVerify"
              ? "goalTimeline"
              : null;
        if (!kind) continue;
        const text = (element.innerText || element.textContent || "")
          .replace(/\u00a0/g, " ")
          .trim();
        if (!text) continue;
        entries.push({
          id: element.dataset.rowId ?? null,
          kind,
          text,
          title: element.getAttribute("title"),
        });
      }
      return entries;
    },
    testId(TID_V4_SESSION_PANE, "workspace-main"),
  );
}

function normalizeEntryText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeGoalTimelineText(text: string) {
  const normalized = normalizeEntryText(text);
  const match = EXPECTED_TIMELINE_STEPS.find((step) => matchesGoalTimelineText(normalized, step));
  return match?.label ?? null;
}

function resolveGoalTimelineSteps(
  timelineTexts: readonly string[],
  expectedSteps: readonly GoalTimelineExpectation[],
) {
  return expectedSteps.map((step, index) =>
    matchesGoalTimelineText(timelineTexts[index] ?? "", step)
      ? step.label
      : normalizeGoalTimelineText(timelineTexts[index] ?? ""),
  );
}

function matchesGoalTimelineText(text: string, expected: GoalTimelineExpectation) {
  const normalized = normalizeEntryText(text);
  return expected.texts.includes(normalized);
}

function findEntryIndex(
  entries: readonly ConversationEntrySnapshot[],
  kind: ConversationEntrySnapshot["kind"],
  text: string | GoalTimelineExpectation,
) {
  return findEntryIndexFrom(entries, kind, text, 0);
}

function findEntryIndexFrom(
  entries: readonly ConversationEntrySnapshot[],
  kind: ConversationEntrySnapshot["kind"],
  text: string | GoalTimelineExpectation,
  fromIndex: number,
) {
  return entries.findIndex(
    (entry, index) => index >= fromIndex && entry.kind === kind && entryMatchesText(entry, text),
  );
}

function entryMatchesText(
  entry: ConversationEntrySnapshot,
  text: string | GoalTimelineExpectation,
) {
  if (typeof text === "string") {
    return entry.text.includes(text);
  }

  return matchesGoalTimelineText(entry.text, text);
}

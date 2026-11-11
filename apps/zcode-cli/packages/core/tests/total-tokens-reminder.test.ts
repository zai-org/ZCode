import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createProjectId,
  createRootTraceContext,
  createSessionId,
  ModelErrorCode,
  type ModelInputMessage,
  type ModelRequest,
  type RuntimeInputPresentation,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import {
  TOTAL_TOKENS_SYSTEM_LINE,
  formatTotalTokensReminder,
} from "../src/context/total-tokens.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  consumeTotalTokensBudget,
  createTotalTokensBudgetState,
  decideTotalTokensReminder,
  reanchorTotalTokensBudget,
  rollOverTotalTokensBudget,
} from "../src/runtime/helpers/total-tokens-budget.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const SUMMARY_MARKER = "create a detailed summary";
const REMINDER_PATTERN = /<total_tokens>(\d+) tokens left<\/total_tokens>/g;

/** 一次主循环响应：工具调用或文本结束，usage 决定下一次提醒的数值。 */
interface ScriptStep {
  input: number;
  output: number;
  tool?: boolean;
  /** 本次请求先报上下文超限，触发 reactive compaction 后重试同一步。 */
  exceed?: boolean;
  /** 缓存读写量。input 已经包含这两项（与 adapter 的 inputTokens 口径相同）。 */
  cacheRead?: number;
  cacheWrite?: number;
  /** 本次响应返回前送进的 guide；不带 presentation 的和信箱一样直接调 steerTurn。 */
  guides?: { input: string; inputPresentation?: RuntimeInputPresentation }[];
}

function contentText(content: ModelInputMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 请求里非前导 system 部分出现的全部提醒数值，按出现顺序。 */
function reminderValues(request: ModelRequest): number[] {
  const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
  const body = request.messages
    .slice(firstNonSystem)
    .map((message) => contentText(message.content))
    .join("\n");
  return [...body.matchAll(REMINDER_PATTERN)].map((match) => Number(match[1]));
}

function leadingSystemText(request: ModelRequest): string {
  const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
  return request.messages
    .slice(0, firstNonSystem)
    .map((message) => contentText(message.content))
    .join("");
}

/**
 * 后台通知开启的新一轮：首个请求不收集，工具批次后收集但不重新起算。
 * 真实用户消息会把 rolled 和旧 anchor 一起抵消；只有这类轮次能观察到计数器本身的状态。
 */
function runNotificationTurn(runtime: ReturnType<typeof createTestAgentRuntime>) {
  return runtime.executeTurn("<task-notification>background done</task-notification>", undefined, {
    inputSource: "background_task",
    inputVisibility: "model-only",
    inputPresentation: "task_notification",
  });
}

async function fixture(
  options: {
    mcs?: boolean;
    taskType?: "subagent_child" | "workflow_child";
    /** 小上下文窗口：上下文接近 50000 时触发 auto compaction。 */
    smallWindow?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "total-tokens-reminder-"));
  const dbPath = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId("total-tokens-reminder");
  const mainRequests: ModelRequest[] = [];
  const summaryRequests: ModelRequest[] = [];
  const script: ScriptStep[] = [];
  const runtimes: ReturnType<typeof createTestAgentRuntime>[] = [];
  onTestFinished(async () => {
    for (const runtime of runtimes) await runtime.closeBrowserSession();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.createSession({
    id: sessionId,
    projectID: createProjectId("test"),
    slug: "test",
    title: "test",
    directory: root,
    version: "test",
  });
  let toolCallIndex = 0;
  const modelFactory = createTestModelFactory({
    properties: { supportsMidConversationSystem: options.mcs === true },
    async generateText(request) {
      if (JSON.stringify(request.messages).includes(SUMMARY_MARKER)) {
        summaryRequests.push(request);
        return { text: "<summary>Continue the task.</summary>", finishReason: "stop", usage: {} };
      }
      mainRequests.push(request);
      const step = script[0];
      if (!step) throw new Error("script exhausted");
      if (step.exceed) {
        step.exceed = false;
        throw Object.assign(new Error("provider context window exceeded"), {
          code: ModelErrorCode.ModelContextExceeded,
        });
      }
      script.shift();
      const runtime = runtimes.at(-1)!;
      for (const guide of step.guides ?? []) {
        const queued = await runtime.steerTurn({
          delivery: "guide",
          expectedTurnId: runtime.getActiveTurnInfo()?.turnId,
          ...guide,
        });
        expect(queued.kind).toBe("queued");
      }
      const usage = {
        inputTokens: step.input,
        outputTokens: step.output,
        totalTokens: step.input + step.output,
        ...(step.cacheRead !== undefined ? { cacheReadTokens: step.cacheRead } : {}),
        ...(step.cacheWrite !== undefined ? { cacheWriteTokens: step.cacheWrite } : {}),
      };
      if (!step.tool) return { text: "done", finishReason: "stop", usage };
      toolCallIndex += 1;
      return {
        text: "",
        finishReason: "tool-calls",
        toolCalls: [{ id: `inspect-${toolCallIndex}`, name: "Inspect", input: {} }],
        usage,
      };
    },
  });
  const makeRuntime = () => {
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        name: "Inspect",
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "ok",
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 30,
        modelStreaming: "off",
        taskType: options.taskType,
        titleGeneration: { enabled: false },
        workspacePath: root,
        ...(options.smallWindow
          ? {
              compact: { bufferTokens: 10, contextWindow: 50_000, summaryReserveTokens: 0 },
              maxOutputTokens: 1,
            }
          : {}),
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory,
        sessionStore: store,
        toolRegistry: registry,
      },
    );
    runtimes.push(runtime);
    return { runtime, internal: runtime as unknown as AgentRuntimeInternal };
  };
  return {
    ...makeRuntime(),
    mainRequests,
    summaryRequests,
    script(...steps: ScriptStep[]) {
      script.push(...steps);
    },
    async reopen() {
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const next = makeRuntime();
      await next.runtime.resumeFromStore();
      return next;
    },
  };
}

describe("total-tokens budget math", () => {
  it("formats the fixed budget line", () => {
    expect(TOTAL_TOKENS_SYSTEM_LINE).toBe("<total_tokens>15000000 tokens left</total_tokens>");
    expect(formatTotalTokensReminder(14998995)).toBe(
      "<total_tokens>14998995 tokens left</total_tokens>",
    );
  });

  it("counts growth since the anchor, adds rollovers, never goes up and stops at zero", () => {
    let state = reanchorTotalTokensBudget(createTotalTokensBudgetState(), 40_000);
    let step = consumeTotalTokensBudget(state, 40_000);
    expect(step.remaining).toBe(15_000_000);
    step = consumeTotalTokensBudget(step.state, 52_000);
    expect(step.remaining).toBe(14_988_000);
    // 上下文变小（例如 microcompact）时数值不回升。
    step = consumeTotalTokensBudget(step.state, 30_000);
    expect(step.remaining).toBe(14_988_000);
    state = rollOverTotalTokensBudget(step.state, 180_000);
    step = consumeTotalTokensBudget(state, 30_000);
    expect(step.remaining).toBe(15_000_000 - (180_000 + 30_000 - 40_000));
    step = consumeTotalTokensBudget(reanchorTotalTokensBudget(step.state, 30_000), 30_000);
    expect(step.remaining).toBe(15_000_000);
    expect(consumeTotalTokensBudget(createTotalTokensBudgetState(), 16_000_000).remaining).toBe(0);
  });

  it.each([
    ["turn_input", true, true, { emit: true, reanchor: true }],
    ["turn_input", true, false, { emit: false, reanchor: false }],
    ["turn_input", false, true, { emit: false, reanchor: false }],
    ["tool_batch", true, false, { emit: true, reanchor: false }],
    ["tool_batch", false, false, { emit: true, reanchor: false }],
    ["text_guide", true, true, { emit: true, reanchor: true }],
    ["text_guide", true, false, { emit: true, reanchor: false }],
    ["text_guide", false, true, { emit: true, reanchor: false }],
  ] as const)(
    "decides reason=%s main=%s fromUser=%s",
    (reason, mainSession, fromUser, expected) => {
      expect(decideTotalTokensReminder({ reason, mainSession, fromUser })).toEqual(expected);
    },
  );
});

describe("total-tokens reminder in the turn loop", () => {
  it.each([{ mcs: false }, { mcs: true }])(
    "counts down within a turn, re-anchors on the next prompt and replays after resume %j",
    async ({ mcs }) => {
      const f = await fixture({ mcs });
      f.script(
        { input: 1000, output: 5, tool: true },
        { input: 2400, output: 7, tool: true },
        { input: 2600, output: 9 },
      );
      await f.runtime.executeTurn("first prompt");
      expect(f.mainRequests.map(reminderValues)).toEqual([
        [15_000_000],
        [15_000_000, 14_998_995],
        [15_000_000, 14_998_995, 14_997_593],
      ]);
      expect(
        leadingSystemText(f.mainRequests[0]!).endsWith(`\n\n${TOTAL_TOKENS_SYSTEM_LINE}`),
      ).toBe(true);
      if (mcs) {
        // MCS 下首个请求的提醒并入对话中的同一条 system，排在日期之前。
        const request = f.mainRequests[0]!;
        const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
        const merged = request.messages
          .slice(firstNonSystem)
          .find(
            (message) =>
              message.role === "system" &&
              contentText(message.content).includes(TOTAL_TOKENS_SYSTEM_LINE),
          );
        expect(contentText(merged!.content)).toContain(
          `${TOTAL_TOKENS_SYSTEM_LINE}\n\nToday's date is`,
        );
      }

      // 下一条真实用户消息以上一轮最后一次响应（2609）为起点。
      f.script({ input: 3000, output: 10, tool: true }, { input: 3100, output: 3 });
      await f.runtime.executeTurn("second prompt");
      expect(f.mainRequests.slice(3).map(reminderValues)).toEqual([
        [15_000_000, 14_998_995, 14_997_593, 15_000_000],
        [15_000_000, 14_998_995, 14_997_593, 15_000_000, 14_999_599],
      ]);

      // 冷恢复：已发提醒原样回放；计数器从零开始，下一条真实消息用持久化的 usage（3103）起算。
      const cold = await f.reopen();
      f.script({ input: 3200, output: 4, tool: true }, { input: 3300, output: 1 });
      await cold.runtime.executeTurn("after resume");
      const resumed = f.mainRequests.slice(5).map(reminderValues);
      expect(resumed).toEqual([
        [15_000_000, 14_998_995, 14_997_593, 15_000_000, 14_999_599, 15_000_000],
        [15_000_000, 14_998_995, 14_997_593, 15_000_000, 14_999_599, 15_000_000, 14_999_899],
      ]);
    },
  );

  it("adds the pre-compaction context on reactive compaction and adds no reminder to the retry", async () => {
    const f = await fixture();
    // 第一轮留下可摘要的历史；第二轮工具批次之后的请求超限。
    f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 5 });
    await f.runtime.executeTurn("build history");
    f.script(
      { input: 1300, output: 5, tool: true },
      { input: 500, output: 5, tool: true, exceed: true },
      { input: 600, output: 2 },
    );
    await f.runtime.executeTurn("compact during the turn");
    expect(f.summaryRequests).toHaveLength(1);
    const values = f.mainRequests.slice(2).map(reminderValues);
    // 轮首以 1105 起算；工具批次后 1305 - 1105 = 200。
    expect(values[0]!.at(-1)).toBe(15_000_000);
    expect(values[1]!.at(-1)).toBe(14_999_800);
    // 摘要请求不产生新提醒：它只含被摘要的历史，超限前刚收集的那条在保留的尾部里。
    expect(reminderValues(f.summaryRequests[0]!)).toEqual(values[1]!.slice(0, -1));
    // compaction 后的重试不收集：最后一条仍是 compaction 前收集的那条，且只有一条。
    expect(values[2]!.at(-1)).toBe(14_999_800);
    expect(values[2]!.filter((value) => value === 14_999_800)).toHaveLength(1);
    // 下一个工具批次：rolled 1305 + 当前 505 - anchor 1105 = 705。
    expect(values[3]!.at(-1)).toBe(15_000_000 - 705);
  });

  it("adds the pre-compaction context on auto compaction after a tool batch", async () => {
    const f = await fixture({ smallWindow: true });
    f.script({ input: 1000, output: 5 });
    await f.runtime.executeTurn("build history");
    f.script(
      { input: 1200, output: 5, tool: true },
      // 这次响应后上下文到 49995，下一次请求前触发 auto compaction。
      { input: 49_990, output: 5, tool: true },
      { input: 600, output: 5, tool: true },
      { input: 700, output: 1 },
    );
    await f.runtime.executeTurn("compact during the turn");
    expect(f.summaryRequests).toHaveLength(1);
    const values = f.mainRequests.slice(1).map(reminderValues);
    // 轮首以 1005 起算；第一个工具批次后 1205 - 1005 = 200。
    expect(values[0]!.at(-1)).toBe(15_000_000);
    expect(values[1]!.at(-1)).toBe(15_000_000 - 200);
    // compaction 前收集的这条落在保留的尾部：摘要请求只含被摘要的历史，不含它，也不新增；
    // compaction 后的首个请求也不新增。
    expect(reminderValues(f.summaryRequests[0]!)).toEqual(values[1]);
    expect(values[2]!.at(-1)).toBe(15_000_000 - 48_990);
    expect(values[2]!.filter((value) => value === 15_000_000 - 48_990)).toHaveLength(1);
    // 下一个工具批次：rolled 49995 + 当前 605 - anchor 1005 = 49595；不累加时仍停在 48990。
    expect(values[3]!.at(-1)).toBe(15_000_000 - 49_595);
  });

  it("does not add the context of a manual compaction", async () => {
    const f = await fixture();
    f.script({ input: 1000, output: 5, tool: true }, { input: 1200, output: 5 });
    await f.runtime.executeTurn("before manual compaction");
    const result = await f.internal.compactActiveConversation(
      undefined,
      createRootTraceContext(),
      [],
      {},
    );
    expect(result.outcome).toBe("compacted");
    // 通知轮不重新起算，计数器沿用第一轮的 anchor 0 与已用 1005。
    f.script({ input: 3000, output: 5, tool: true }, { input: 3100, output: 1 });
    await runNotificationTurn(f.runtime);
    const notification = f.mainRequests.slice(2, 4).map(reminderValues);
    expect(notification[0]).toEqual([]);
    // 未累加：used = max(1005, 0 + 3005 - 0) = 3005；若手动 compaction 累加了 1205，会是 4210。
    expect(notification[1]).toEqual([15_000_000 - 3005]);

    // 下一条真实消息重新起算，以通知轮最后一次响应（3101）为起点。
    f.script({ input: 3300, output: 4, tool: true }, { input: 3400, output: 1 });
    await f.runtime.executeTurn("after manual compaction");
    const values = f.mainRequests.slice(4).map(reminderValues);
    expect(values[0]!.at(-1)).toBe(15_000_000);
    expect(values[1]!.at(-1)).toBe(15_000_000 - 203);
  });

  it("resets the counter when the same runtime resumes again", async () => {
    const f = await fixture();
    f.script({ input: 1000, output: 5 });
    await f.runtime.executeTurn("first prompt");
    // 第二条真实消息把 anchor 移到 1005。
    f.script({ input: 2000, output: 5 });
    await f.runtime.executeTurn("second prompt");
    // bootstrap 复用同一个 runtime 再次恢复；恢复等同新会话启动。
    await f.runtime.resumeFromStore();
    f.script({ input: 3000, output: 5, tool: true }, { input: 3100, output: 1 });
    await runNotificationTurn(f.runtime);
    const notification = f.mainRequests.slice(2).map(reminderValues);
    expect(notification[0]!.at(-1)).toBe(15_000_000);
    // 清零后从 0 计数：used = 3005；若沿用恢复前的 anchor 1005，会是 2000。
    expect(notification[1]!.at(-1)).toBe(15_000_000 - 3005);
  });

  it("gives a goal continuation no reminder on its first request and keeps the anchor", async () => {
    const f = await fixture();
    f.script({ input: 1000, output: 5 });
    await f.runtime.executeTurn("set the goal");
    f.script({ input: 2000, output: 5, tool: true }, { input: 2100, output: 1 });
    await f.runtime.executeTurn("continue the goal", undefined, {
      inputSource: "goal-continuation",
      inputVisibility: "model-only",
    });
    const values = f.mainRequests.slice(1).map(reminderValues);
    // 首个请求只带上一轮的那条提醒。
    expect(values[0]).toEqual([15_000_000]);
    // 不重新起算：anchor 仍是 0，used = 2005；重新起算会是 2005 - 1005 = 1000。
    expect(values[1]).toEqual([15_000_000, 15_000_000 - 2005]);
  });

  it.each([
    { name: "a session mailbox guide", guides: [{ input: "mailbox note" }], reanchor: false },
    {
      name: "a user guide",
      guides: [{ input: "user note", inputPresentation: "user_steer" as const }],
      reanchor: true,
    },
    {
      name: "a mailbox guide drained with a user guide",
      guides: [
        { input: "mailbox note" },
        { input: "user note", inputPresentation: "user_steer" as const },
      ],
      reanchor: true,
    },
  ])("re-anchors after a text-only reply only for a user guide: $name", async (testCase) => {
    const f = await fixture();
    f.script({ input: 1000, output: 5, guides: testCase.guides }, { input: 1100, output: 2 });
    await f.runtime.executeTurn("first prompt");
    // 轮首以 0 起算；纯文本回复后上下文 1005，不重新起算时 used = 1005。
    expect(f.mainRequests.map(reminderValues)).toEqual([
      [15_000_000],
      [15_000_000, testCase.reanchor ? 15_000_000 : 15_000_000 - 1005],
    ]);
  });

  it("counts cache tokens once because the input already includes them", async () => {
    const f = await fixture();
    f.script(
      { input: 1000, output: 5, tool: true, cacheRead: 800, cacheWrite: 100 },
      { input: 1100, output: 2 },
    );
    await f.runtime.executeTurn("cached prompt");
    // 上下文是 input + output = 1005；再加一次缓存读写会是 1905。
    expect(f.mainRequests.map(reminderValues)).toEqual([
      [15_000_000],
      [15_000_000, 15_000_000 - 1005],
    ]);
  });

  it("gives a subagent no reminder on its first request and counts its whole context", async () => {
    const f = await fixture({ taskType: "subagent_child" });
    f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
    await f.runtime.executeTurn("child task");
    expect(f.mainRequests.map(reminderValues)).toEqual([[], [14_998_995]]);
  });

  it("keeps the budget line for a workflow child and never re-anchors it", async () => {
    const f = await fixture({ taskType: "workflow_child" });
    f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
    await f.runtime.executeTurn("workflow step");
    expect(leadingSystemText(f.mainRequests[0]!).endsWith(`\n\n${TOTAL_TOKENS_SYSTEM_LINE}`)).toBe(
      true,
    );
    expect(f.mainRequests.map(reminderValues)).toEqual([[], [14_998_995]]);
  });
});

describe("total-tokens system line", () => {
  it("ends the subagent system prompt after the notes", () => {
    const built = createSubagentContextBuilder({
      agentPrompt: "You are a file search specialist.",
      envInfo: {
        cwd: "/Users/dev/project",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 24.3.0",
        nodeVersion: "24.14.0",
        isGitRepository: false,
      },
    }).build();
    const tail = String(built.systemMessages.at(-1)?.content);
    expect(tail.endsWith(`this note is about report files.)\n\n${TOTAL_TOKENS_SYSTEM_LINE}`)).toBe(
      true,
    );
  });
});

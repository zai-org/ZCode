// TT01–TT10 token 预算提醒（docs/conversation-session-case-catalog.md「token 预算提醒」）。
// 规格见 apps/zcode-cli/docs/design/v2/loop/meta-user-context.md「Total-tokens reminder」。
// 所有断言读取上游请求体。fixture 的 usage 写死，期望数值按规格的计数规则逐个算出。
// tail 指最后一条 assistant 之后的提醒：本请求新追加的一条，或 compaction 保留下来的那一条。
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { ensureReadonlyToolFixtureFile } from "#e2e/helpers/conversation-session-readonly-tool";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import { seedCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider-store";
import { prepareIncomingMessageCapability } from "#e2e/helpers/incoming-message-capability";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  TOTAL_TOKENS_BUDGET as BUDGET,
  TOTAL_TOKENS_LINE as LINE,
  blocksOf,
  totalTokensAfterLastAssistant,
  totalTokensReminders,
} from "#e2e/helpers/total-tokens-evidence";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

type Block = Record<string, unknown> & { type?: string };
type Message = { role: string; content: unknown };
type Request = { messages: Message[]; system?: unknown };

describe("TT token 预算提醒", () => {
  before(async () => {
    await ensureReadonlyToolFixtureFile();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const mcs of [true, false]) {
    const M = mcs ? "MCS" : "PLAIN";
    const id = (step: number) => `tt-a${step}-${M.toLowerCase()}`;

    it(`TT01–TT04 ${M}：轮内倒数、跨轮重新起算、输出续写不收集、冷恢复后计数器清零`, async function () {
      this.timeout(480_000);
      await prepareIncomingMessageCapability(mcs);

      await runTurn(`E2E_TT_A1_${M} Read the readonly fixture twice.`, `TT_A1_DONE_${M}`);
      const sessionId = await idleSessionId("A 第一轮没有完成");
      await runTurn(`E2E_TT_A2_${M} Read it once more.`, `TT_A2_DONE_${M}`);
      await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
      await selectV4TaskById(sessionId, 30_000);
      await waitForV4TimelineContaining(`TT_A2_DONE_${M}`);
      await runTurn(`E2E_TT_A3_${M} Read it after resume.`, `TT_A3_DONE_${M}`);

      const requests = await requestsByFixture([1, 2, 3, 4, 5, 6, 7, 8].map(id));
      // 工具批次之后按上下文增量倒数；真实用户消息重新起算；
      // 输出续写的请求不收集新提醒；冷恢复后计数器清零，首条消息按持久化的 usage 重新起算。
      expect(requests.map(tailValues)).toEqual([
        [BUDGET],
        [14_998_995],
        [14_997_593],
        [BUDGET],
        [14_999_599],
        [],
        [BUDGET],
        [14_999_799],
      ]);
      // 只追加：后一个请求按原样带着前面所有的提醒，冷恢复也一样。
      expect(requests.map((request) => found(request).map((item) => item.value))).toEqual([
        [BUDGET],
        [BUDGET, 14_998_995],
        [BUDGET, 14_998_995, 14_997_593],
        [BUDGET, 14_998_995, 14_997_593, BUDGET],
        [BUDGET, 14_998_995, 14_997_593, BUDGET, 14_999_599],
        [BUDGET, 14_998_995, 14_997_593, BUDGET, 14_999_599],
        [BUDGET, 14_998_995, 14_997_593, BUDGET, 14_999_599, BUDGET],
        [BUDGET, 14_998_995, 14_997_593, BUDGET, 14_999_599, BUDGET, 14_999_799],
      ]);
      for (const request of requests)
        expect(systemText(request).endsWith(`\n\n${LINE}`)).toBe(true);
      // 重启前写入的提醒逐字节回放：所在消息、承载形态和所在文本都不变（tt-a6 是重启前最后一个请求）。
      const placed = (request: Request) =>
        found(request).map(({ message, role, container, text }) => [
          message,
          role,
          container,
          text,
        ]);
      const beforeRestart = placed(requests[5]!);
      expect(placed(requests[6]!).slice(0, beforeRestart.length)).toEqual(beforeRestart);
      expectProjection(requests, mcs);
    });
  }

  it("TT05–TT07：auto 与 reactive compaction 累加压缩前的上下文，手动 /compact 不累加", async function () {
    this.timeout(480_000);
    await prepareIncomingMessageCapability(true);

    // 第二个请求的 usage 是 975000/7，超过 MCS 模型 1000000 窗口的自动压缩阈值。
    await runTurn("E2E_TT_C1 Read the readonly fixture three times.", "TT_C1_DONE");
    await waitForV4CompactMarker({ origin: "auto", status: "success" }, 90_000);
    await idleSessionId("C 第一轮没有完成");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await idleSessionId("手动 compact 后没有回到空闲态");
    await runTurn("E2E_TT_C2 Read it after the manual compact.", "TT_C2_DONE");
    // 工具批次之后的请求返回 prompt is too long，reactive compaction 后重试。
    await runTurn("E2E_TT_C3 Read it before the reactive compact.", "TT_C3_DONE");

    const ids = ["tt-c1", "tt-c2", "tt-c3", "tt-c4", "tt-c5", "tt-c6", "tt-c7", "tt-c8-too-long"];
    const requests = await requestsByFixture([...ids, "tt-c9", "tt-c10"]);
    // 压缩后的首个请求和重试不收集新提醒，尾部是压缩前写入、保留下来的那一条。
    // auto 累加 975007，手动不累加，reactive 累加压缩前最近一次 usage（3505）。
    expect(requests.map(tailValues)).toEqual([
      [BUDGET],
      [14_998_995],
      [14_024_993],
      [14_021_983],
      [BUDGET],
      [14_996_696],
      [BUDGET],
      [14_999_901],
      [14_999_901],
      [14_996_195],
    ]);
    expectProjection(requests, true);
  });

  it("TT08：Explore 子 agent 首个请求没有提醒、从 0 计数；父会话的通知轮不收集", async function () {
    this.timeout(300_000);
    await prepareIncomingMessageCapability(true);

    await sendV4Prompt("E2E_TT_S_PARENT Explore the readonly fixture in a subagent.");
    await waitForV4TimelineContaining("TT_S_PARENT_DONE", 120_000);
    await idleSessionId("S 通知轮没有完成");

    const [parentAgent, child1, child2, parentLaunched, parentNotified] = await requestsByFixture([
      "tt-s-parent-agent",
      "tt-s-child-1",
      "tt-s-child-2",
      "tt-s-parent-launched",
      "tt-s-parent-notified",
    ]);
    // 子 agent 的 system 同样以预算行结尾；它的首个请求不带提醒，工具批次之后按整个上下文倒数。
    for (const child of [child1!, child2!])
      expect(systemText(child).endsWith(`\n\n${LINE}`)).toBe(true);
    expect(found(child1!)).toEqual([]);
    expect(found(child2!).map((item) => item.value)).toEqual([14_998_995]);
    // 父会话：Agent 结果是一个工具批次；子 agent 完成的通知开启新轮，不重新起算也不追加。
    expect([parentAgent!, parentLaunched!, parentNotified!].map(tailValues)).toEqual([
      [BUDGET],
      [14_998_995],
      [],
    ]);
    expectProjection([parentAgent!, parentLaunched!, child2!], true);
  });

  it("TT09：旧快照会话保持旧 system，消息里照常追加；compaction 后 system 才带预算行", async function () {
    this.timeout(360_000);
    await prepareIncomingMessageCapability(true);

    await runTurn("E2E_TT_N1 hello.", "TT_N1_DONE");
    const sessionId = await idleSessionId("N 首轮没有完成");
    // 应用退出后改写快照：去掉预算行，模拟加入这一行之前的版本写下的快照。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => rewriteSnapshotWithoutLine(sessionId),
    });
    await selectV4TaskById(sessionId, 30_000);
    await waitForV4TimelineContaining("TT_N1_DONE");
    await runTurn("E2E_TT_N2 hello again.", "TT_N2_DONE");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await idleSessionId("N 手动 compact 后没有回到空闲态");
    await runTurn("E2E_TT_N3 after compact.", "TT_N3_DONE");

    const [n1, n2, n3] = await requestsByFixture(["tt-n1", "tt-n2", "tt-n3"]);
    expect(systemText(n1!).endsWith(`\n\n${LINE}`)).toBe(true);
    // 旧快照原样使用：system 就是首轮 system 去掉预算行，缓存前缀不变。
    expect(systemText(n2!)).toBe(systemText(n1!).slice(0, -`\n\n${LINE}`.length));
    expect(systemText(n2!)).not.toContain("<total_tokens>");
    expect(systemText(n3!).endsWith(`\n\n${LINE}`)).toBe(true);
    expect([n1!, n2!, n3!].map(tailValues)).toEqual([[BUDGET], [BUDGET], [BUDGET]]);
    expect(found(n2!).map((item) => item.value)).toEqual([BUDGET, BUDGET]);
  });

  it("TT10：openai chat completions 沿用现有提醒投影", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedCustomOpenAIChatCompletionsProvider({
      modelId: OA_MODEL_ID,
      providerId: OA_PROVIDER_ID,
      providerName: OA_PROVIDER_NAME,
    });
    await refreshSeededOpenAIProvidersThroughSettings([OA_PROVIDER_NAME], {
      workspacePath: DEFAULT_WORKSPACE,
    });
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await selectUpstreamProviderModelById(OA_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: OA_PROVIDER_ID,
      providerName: OA_PROVIDER_NAME,
    });

    await runTurn("E2E_TT_O1 Read the readonly fixture.", "TT_O1_DONE");
    await runTurn("E2E_TT_O2 hello again.", "TT_O2_DONE");

    const requests = await requestsByFixture(["tt-o1", "tt-o2", "tt-o3"]);
    for (const request of requests) expect(systemText(request).endsWith(`\n\n${LINE}`)).toBe(true);
    expect(requests.map(tailValues)).toEqual([[BUDGET], [14_998_995], [BUDGET]]);
    // 每条提醒是单独的 user 消息，不并进 tool 消息。
    for (const item of requests.flatMap(found)) {
      expect([item.role, item.text]).toEqual([
        "user",
        `<system-reminder>\n${LINE.replace(String(BUDGET), String(item.value))}\n</system-reminder>`,
      ]);
    }
  });
});

const OA_MODEL_ID = "e2e-tt-openai-model";
const OA_PROVIDER_ID = "e2e-tt-openai-provider";
const OA_PROVIDER_NAME = "Total Tokens Chat Completions";

async function runTurn(prompt: string, done: string) {
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(done, 120_000);
  await idleSessionId(`${prompt.split(" ")[0]} 没有完成`);
}

async function idleSessionId(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft") && !current.canStop,
    timeoutMsg,
    120_000,
  );
  return snapshot.sessionId!;
}

/** 按 fixture id 取上游请求；每个 fixture 只匹配一次。 */
async function requestsByFixture(ids: string[]): Promise<Request[]> {
  const records = await getUpstreamRequestEvidence({});
  return ids.map((fixtureId) => {
    const record = records.find((item) => item.fixtureId === fixtureId);
    const request = record?.requestJson as Request | undefined;
    if (!request || !Array.isArray(request.messages)) throw new Error(`${fixtureId} 没有上游请求`);
    return request;
  });
}

const found = totalTokensReminders;
const tailValues = totalTokensAfterLastAssistant;

function systemText(request: Request): string {
  if (Array.isArray(request.system)) {
    return (request.system as Block[]).map((block) => String(block.text ?? "")).join("\u0000");
  }
  if (typeof request.system === "string") return request.system;
  const first = request.messages[0];
  return first?.role === "system"
    ? blocksOf(first.content)
        .map((b) => String(b.text ?? ""))
        .join("")
    : "";
}

/**
 * MCS 开：提醒在 role:system 消息里，单独一条，或与同一位置的其他附件用 \n\n 连接。
 * MCS 关：提醒是 <system-reminder> 包裹的文本。紧跟工具调用时并进 tool_result，接在结果文本的
 * \n\n 之后；否则（轮首）独立成一个文本块。是否紧跟工具调用按请求结构判断，不读 helper 的推断。
 */
function expectProjection(requests: Request[], mcs: boolean) {
  for (const request of requests) {
    for (const item of found(request)) {
      const tag = `<total_tokens>${item.value} tokens left</total_tokens>`;
      if (mcs) {
        expect([item.role, item.container]).toEqual(["system", "system"]);
        expect(
          item.text === tag ||
            item.text.startsWith(`${tag}\n\n`) ||
            item.text.includes(`\n\n${tag}`),
        ).toBe(true);
        continue;
      }
      const wrapped = `<system-reminder>\n${tag}\n</system-reminder>`;
      const previous = request.messages[item.message - 1];
      const afterToolUse =
        previous?.role === "assistant" &&
        blocksOf(previous.content).some((block) => block.type === "tool_use");
      expect([item.role, item.container]).toEqual(["user", afterToolUse ? "tool_result" : "user"]);
      if (afterToolUse) expect(item.text.endsWith(`\n\n${wrapped}`)).toBe(true);
      // 独立块就是包裹本身；后面还有块时末尾多一个 \n。
      else expect(item.text.trimEnd()).toBe(wrapped);
    }
  }
}

// 去掉快照 system 里的预算行。node:sqlite 只提供同步接口；调用时应用已退出，没有并发写入。
function rewriteSnapshotWithoutLine(sessionId: string) {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home) throw new Error("缺少 ZCODE_E2E_HOME_DIR");
  const database = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"));
  try {
    const id = `${sessionId}:runtime-prompt-snapshot`;
    const row = database.prepare("select data from session_entry where id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) throw new Error(`没有 ${id}`);
    const needle = JSON.stringify(`\n\n${LINE}`).slice(1, -1);
    if (!row.data.includes(needle)) throw new Error("快照里没有预算行");
    database
      .prepare("update session_entry set data = ? where id = ?")
      .run(row.data.replaceAll(needle, ""), id);
  } finally {
    database.close();
  }
}

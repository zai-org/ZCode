// TT01–TT10 token 预算提醒默认关闭（docs/conversation-session-case-catalog.md「token 预算提醒」）。
// 规格见 apps/zcode-cli/docs/design/v2/loop/meta-user-context.md「Total-tokens reminder」。
// 用例沿用覆盖各收集点的流程：轮首、工具批次、输出续写、冷恢复、三种压缩、子 agent、旧快照、
// chat completions。所有断言读取上游请求体：system 与 messages 里都没有 `<total_tokens>`。
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

const TAG = "<total_tokens>";
// 开关打开时写在 system 末尾的预算行；TT09 用它模拟开关打开时写下的旧快照。
const LINE = "<total_tokens>15000000 tokens left</total_tokens>";
// 开关关闭时，默认 system 的动态段以 `# Memory, notes and feedback` 段结尾。
const SYSTEM_END = "work from the context, not intermediate files.";

describe("TT token 预算提醒默认关闭", () => {
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

    it(`TT01–TT04 ${M}：轮首、工具批次、输出续写和冷恢复后都没有提醒`, async function () {
      this.timeout(480_000);
      await prepareIncomingMessageCapability(mcs);

      await runTurn(`E2E_TT_A1_${M} Read the readonly fixture twice.`, `TT_A1_DONE_${M}`);
      const sessionId = await idleSessionId("A 第一轮没有完成");
      await runTurn(`E2E_TT_A2_${M} Read it once more.`, `TT_A2_DONE_${M}`);
      await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
      await selectV4TaskById(sessionId, 30_000);
      await waitForV4TimelineContaining(`TT_A2_DONE_${M}`);
      await runTurn(`E2E_TT_A3_${M} Read it after resume.`, `TT_A3_DONE_${M}`);

      // tt-a6 是输出续写，tt-a7 起是冷恢复后的请求。
      const requests = await requestsByFixture([1, 2, 3, 4, 5, 6, 7, 8].map(id));
      expectNoReminder(requests);
    });
  }

  it("TT05–TT07：auto、手动与 reactive compaction 前后都没有提醒", async function () {
    this.timeout(480_000);
    await prepareIncomingMessageCapability(true);

    // 第二个请求的 usage 超过 MCS 模型 1000000 窗口的自动压缩阈值。
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

    const requests = await requestsByFixture([
      "tt-c1",
      "tt-c2",
      "tt-c-auto-summary",
      "tt-c3",
      "tt-c4",
      "tt-c-manual-summary",
      "tt-c5",
      "tt-c6",
      "tt-c7",
      "tt-c8-too-long",
      "tt-c-reactive-summary",
      "tt-c9",
      "tt-c10",
    ]);
    expectNoReminder(requests, { summaries: [2, 5, 10] });
  });

  it("TT08：Explore 子 agent 与父会话的通知轮都没有提醒", async function () {
    this.timeout(300_000);
    await prepareIncomingMessageCapability(true);

    await sendV4Prompt("E2E_TT_S_PARENT Explore the readonly fixture in a subagent.");
    await waitForV4TimelineContaining("TT_S_PARENT_DONE", 120_000);
    await idleSessionId("S 通知轮没有完成");

    const requests = await requestsByFixture([
      "tt-s-parent-agent",
      "tt-s-child-1",
      "tt-s-child-2",
      "tt-s-parent-launched",
      "tt-s-parent-notified",
    ]);
    // 子 agent 的 system 以 Notes 结尾，同样没有预算行。
    for (const child of [requests[1]!, requests[2]!])
      expect(systemText(child).endsWith("this note is about report files.)")).toBe(true);
    expectNoReminder(requests, { children: [1, 2] });
  });

  it("TT09：带预算行的旧快照原样使用到下一次 compaction", async function () {
    this.timeout(360_000);
    await prepareIncomingMessageCapability(true);

    await runTurn("E2E_TT_N1 hello.", "TT_N1_DONE");
    const sessionId = await idleSessionId("N 首轮没有完成");
    // 应用退出后改写快照：在动态段末尾补上预算行，模拟开关打开时写下的快照。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => rewriteSnapshotWithLine(sessionId),
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
    expect(systemText(n1!).endsWith(SYSTEM_END)).toBe(true);
    // 旧快照原样使用：system 就是首轮 system 加上预算行，缓存前缀不变；消息里不新增提醒。
    expect(systemText(n2!)).toBe(`${systemText(n1!)}\n\n${LINE}`);
    expect(messagesText(n2!)).not.toContain(TAG);
    // compaction 后按当前代码重建 system，不再带预算行。
    expectNoReminder([n1!, n3!]);
  });

  it("TT10：openai chat completions 的 system 与消息都没有提醒", async function () {
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

    expectNoReminder(await requestsByFixture(["tt-o1", "tt-o2", "tt-o3"]));
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

/**
 * 每个请求的 system 与 messages 都没有预算提醒。主会话的 system 以 `# Memory, notes and feedback` 段结尾；
 * 摘要请求的 system 是压缩专用提示，子 agent 的 system 以 Notes 结尾，只检查没有提醒。
 */
function expectNoReminder(
  requests: Request[],
  options: { summaries?: number[]; children?: number[] } = {},
) {
  requests.forEach((request, index) => {
    expect(systemText(request)).not.toContain(TAG);
    expect(messagesText(request)).not.toContain(TAG);
    if (options.summaries?.includes(index) || options.children?.includes(index)) return;
    expect(systemText(request).endsWith(SYSTEM_END)).toBe(true);
  });
}

function systemText(request: Request): string {
  if (Array.isArray(request.system)) {
    return (request.system as Block[]).map((block) => String(block.text ?? "")).join("\u0000");
  }
  if (typeof request.system === "string") return request.system;
  const first = request.messages[0];
  return first?.role === "system" ? blocksText(first.content) : "";
}

/** messages 的全部文本，tool_result 内的块也算；chat completions 的 system 在 messages[0]，不算。 */
function messagesText(request: Request): string {
  const skipFirst = request.system === undefined && request.messages[0]?.role === "system";
  return request.messages
    .filter((_, index) => !(skipFirst && index === 0))
    .map((message) => blocksText(message.content))
    .join("\n");
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((block) =>
      block.type === "tool_result" ? blocksText(block.content) : String(block.text ?? ""),
    )
    .join("");
}

// 在快照 system 的动态段末尾补上预算行。node:sqlite 只提供同步接口；调用时应用已退出，没有并发写入。
function rewriteSnapshotWithLine(sessionId: string) {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home) throw new Error("缺少 ZCODE_E2E_HOME_DIR");
  const database = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"));
  try {
    const id = `${sessionId}:runtime-prompt-snapshot`;
    const row = database.prepare("select data from session_entry where id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) throw new Error(`没有 ${id}`);
    // 动态段的 JSON 字符串以 SYSTEM_END 结尾，紧跟收尾引号。
    const needle = `${SYSTEM_END}"`;
    if (row.data.split(needle).length !== 2) throw new Error("快照里没有唯一的动态段结尾");
    if (row.data.includes(TAG)) throw new Error("快照里已有预算行");
    const line = JSON.stringify(`\n\n${LINE}`).slice(1, -1);
    database
      .prepare("update session_entry set data = ? where id = ?")
      .run(row.data.replace(needle, `${SYSTEM_END}${line}"`), id);
  } finally {
    database.close();
  }
}

// I76：一次响应里交错的思考、文字和工具按流顺序保存，并按请求规则回放。
// 规格见 apps/zcode-cli/docs/design/v2/model/assistant-block-order.md。
// 运行时指定 ZCODE_E2E_UPSTREAM_CONTEXT_WINDOW=128000，避免待审默认小窗口插入自动压缩。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_TASK_ITEM,
  TID_V4_FEEDBACK_LIKE,
  TID_V4_TIMELINE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  expandAssistantHistoriesWithContent,
  expandVisibleSummaryGroups,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import { seedCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider-store";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import { E2E_NETWORK_CAPTURE_REDACTION_VALUE } from "#e2e/helpers/e2e-network-capture-redaction";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";

const FOLLOW_LIVE = "E2E_BO_FOLLOW_LIVE";
const FOLLOW_COLD = "E2E_BO_FOLLOW_COLD";
const COLD_RESTORE_TIMEOUT_MS = 60_000;
const fixtureRoot = resolveE2ERuntimePath("conversation-session-assistant-block-order");

// 每个形态是一次模型响应里的块顺序：A/B 思考，P/Q/R 文字，W 纯空白文字，E 空文字，1/2 Read，
// 3 Write（非只读，流结束后才执行），9 服务端工具（未知名称的 server_tool_use 加 tool_result）。
// expected 是下一次请求里这条 assistant 消息的块顺序。
const SHAPES = [
  { id: "s1", blocks: "A P B Q 1", expected: "A P B Q 1" },
  { id: "s2", blocks: "A P 1 Q", expected: "A P Q 1" },
  { id: "s3", blocks: "A 1 B 2", expected: "A 1 B 2" },
  { id: "s4", blocks: "A P 1 B 2", expected: "A P B 1 2" },
  { id: "s5", blocks: "P 1 A 2 B", expected: "P A 1 2 B" },
  { id: "s6", blocks: "A W B P 1", expected: "A W B P 1" },
  { id: "s7", blocks: "P A W B 1", expected: "P A B 1" },
  { id: "s8", blocks: "A P W 1", expected: "A P 1" },
  // 空文字块不写库，也不进入请求；规格「已知差异」。
  { id: "s9", blocks: "A E B P 1", expected: "A B P 1" },
  { id: "s10", blocks: "A E P 1", expected: "A P 1" },
  { id: "s11", blocks: "W A P 1", expected: "A P 1" },
  { id: "s12", blocks: "A P B Q", expected: "A P B Q" },
  { id: "s13", blocks: "P A", expected: "P A" },
  { id: "s14", blocks: "1 A", expected: "A 1" },
  { id: "s15", blocks: "1 P 2", expected: "P 1 2" },
  { id: "s17", blocks: "P 1 Q 2 R", expected: "P Q R 1 2" },
  { id: "s18", blocks: "A P 3 Q", expected: "A P Q 3" },
  // 响应因输出上限停止，自动续写返回文字 R；之后的请求里续写前后两段回复按流顺序排列。
  { id: "s19", blocks: "A P B Q", expected: "A P B Q R" },
  // 服务端工具把响应分成两轮：[A P 9] 加工具结果，然后是 [B Q]；序号跨轮不重置。
  { id: "s20", blocks: "A P 9 B Q", expected: "A P 9 B Q" },
] as const;
// 自动续写的形态以续写请求结束；其余没有本地工具的形态以首个请求结束。
const FINAL_FIXTURE: Partial<Record<(typeof SHAPES)[number]["id"], string>> = {
  s19: "block-order-s19-continue",
};

type RequestBlock = Record<string, unknown> & { type: string };
type RequestMessage = { role: string; content: unknown };
type RequestJson = { messages: RequestMessage[]; system?: unknown; tools?: unknown };

describe("I76 assistant block order", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps stream order in rows and replays blocks by the request rules, live and after cold resume", async function () {
    this.timeout(600_000);
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "a.txt"), "BO_FILE_A\n");
    await writeFile(join(fixtureRoot, "b.txt"), "BO_FILE_B\n");
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    let sessionId: string | undefined;
    for (const shape of SHAPES) {
      await runShapeTurn(shape);
      sessionId ??= (
        await waitForV4Pane(
          (state) => Boolean(state.sessionId) && state.sessionId !== "draft",
          "首轮没有生成 session",
        )
      ).sessionId!;
      // live：每个文字块一行，工具卡片按流顺序夹在文字之间。
      if (shape.id === "s1") expectRowOrder(await readRows(["S1_TEXT_P", "a.txt", "S1_TEXT_Q"]));
      // Write 在流结束后才执行和写库，Write 卡片仍在两段文字之间。
      if (shape.id === "s18") expectBetween(await readRows(S18_ROW_MARKERS), S18_ROW_MARKERS);
      // 服务端工具卡片在两轮的文字之间。
      if (shape.id === "s20") expectBetween(await readRows(S20_ROW_MARKERS), S20_ROW_MARKERS);
    }
    const liveRows = await readRows(S17_ROW_MARKERS);
    expectS17RowOrder(liveRows);
    // 自动续写的请求按流顺序带回已经输出的块，最后一条是续写提示。
    const continued = await requestFor("block-order-s19-continue", "E2E_BO_S19 go");
    expect(assistantCodesByMarker(continued, "E2E_BO_S19_")).toEqual(["A", "P", "B", "Q"]);
    expect(JSON.stringify(continued.messages.at(-1))).toContain("Output token limit hit");

    await sendV4Prompt(`${FOLLOW_LIVE} 冷恢复前续发。`);
    await waitForV4TimelineContaining(`${FOLLOW_LIVE}_DONE`, 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复前续发未结束");

    await restartAppAndRestoreSession(sessionId!);
    await waitForV4TimelineContaining(`${FOLLOW_LIVE}_DONE`, COLD_RESTORE_TIMEOUT_MS);
    // 冷恢复后行序和行距不变：两段文字被合并或工具卡片换位都会被发现。
    const coldRows = await readRows(S17_ROW_MARKERS);
    expectS17RowOrder(coldRows);
    expect(rowGaps(coldRows)).toEqual(rowGaps(liveRows));
    expectBetween(await readRows(S18_ROW_MARKERS), S18_ROW_MARKERS);
    expectBetween(await readRows(S20_ROW_MARKERS), S20_ROW_MARKERS);

    await sendV4Prompt(`${FOLLOW_COLD} 冷恢复后续发。`);
    await waitForV4TimelineContaining(`${FOLLOW_COLD}_DONE`, 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复后续发未结束");

    // follow fixture 在原始请求上匹配全部思考签名；命中即证明签名字节随思考块原样带回。
    const live = await requestFor("block-order-follow-live", FOLLOW_LIVE);
    const cold = await requestFor("block-order-follow-cold", FOLLOW_COLD);

    const expected = Object.fromEntries(
      SHAPES.map((shape) => [shape.id, shape.expected.split(" ")]),
    );
    expect(assistantBlocksByShape(live)).toEqual(expected);
    expect(assistantBlocksByShape(cold)).toEqual(expected);
    for (const block of assistantBlocks(cold).filter((item) => item.type === "thinking")) {
      expect(block.signature).toBe(E2E_NETWORK_CAPTURE_REDACTION_VALUE);
    }
    // 冷恢复后只在末尾追加：system、tools 和已发送的消息逐字节不变。
    expect(stripCacheControl(cold.system)).toEqual(stripCacheControl(live.system));
    expect(stripCacheControl(cold.tools)).toEqual(stripCacheControl(live.tools));
    expect(stripCacheControl(cold.messages.slice(0, live.messages.length))).toEqual(
      stripCacheControl(live.messages),
    );
    // 会话里每次主请求都是上一次的追加。仓库轨迹工具用 model-io 摘要重建响应，表示不了服务端工具
    // 把一次响应拆成三条消息，所以这里直接比较抓到的请求。
    await expectEachRequestAppends("E2E_BO_S1 go");
  });

  it("keeps finished blocks on stop, feedback on the last row, the first text in search, and the order on the phone", async function () {
    this.timeout(600_000);
    await prepareV4ConversationE2E();

    // 停止：四个块都已完成，流停在 message_delta 前；停止后两段文字各占一行。
    await sendV4Prompt("E2E_BO_STOP go");
    await waitForV4TimelineContaining("E2E_BO_STOP_TEXT_Q", 60_000);
    await clickV4Stop();
    await waitForV4Pane((state) => !state.canStop, "停止后会话仍在运行");
    const sessionId = (
      await waitForV4Pane(
        (state) => Boolean(state.sessionId) && state.sessionId !== "draft",
        "停止后没有 session",
      )
    ).sessionId!;

    await sendV4Prompt("E2E_BO_FB go");
    await waitForV4TimelineContaining("E2E_BO_FB_TEXT_Q", 60_000);
    await waitForV4Pane((state) => !state.canStop, "反馈轮次未结束");
    const liveRows = await readRows(SF_ROW_MARKERS);
    expectSfRowOrder(liveRows);
    // 反馈按钮只在轮尾行；这条消息有两行文字，轮尾是文字 Q 所在行。
    await clickFeedbackLike(liveRows, "E2E_BO_FB_TEXT_Q");

    await sendV4Prompt("E2E_BO_SF_FOLLOW_LIVE 冷恢复前续发。");
    await waitForV4TimelineContaining("E2E_BO_SF_FOLLOW_LIVE_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复前续发未结束");

    await restartAppAndRestoreSession(sessionId);
    await waitForV4TimelineContaining("E2E_BO_SF_FOLLOW_LIVE_DONE", COLD_RESTORE_TIMEOUT_MS);
    const coldRows = await readRows(SF_ROW_MARKERS);
    expectSfRowOrder(coldRows);
    // 反馈写在消息最后一个文字行；冷恢复读取同一行，按钮仍是按下状态。
    expect(await feedbackLikePressed(coldRows, "E2E_BO_FB_TEXT_Q")).toBe(true);

    await sendV4Prompt("E2E_BO_SF_FOLLOW_COLD 冷恢复后续发。");
    await waitForV4TimelineContaining("E2E_BO_SF_FOLLOW_COLD_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复后续发未结束");

    const live = await requestFor("block-order-sf-follow-live", "E2E_BO_SF_FOLLOW_LIVE");
    const cold = await requestFor("block-order-sf-follow-cold", "E2E_BO_SF_FOLLOW_COLD");
    // 停止的消息保留已完成的四个块，顺序不变；两段文字不合并。
    expect(assistantCodesByMarker(cold, "E2E_BO_STOP_")).toEqual(["A", "P", "B", "Q"]);
    expect(assistantCodesByMarker(cold, "E2E_BO_FB_")).toEqual(["A", "P", "B", "Q"]);
    expect(stripCacheControl(cold.messages.slice(0, live.messages.length))).toEqual(
      stripCacheControl(live.messages),
    );

    // 搜索索引包含消息的每一段文字，不只最后一段。
    await expectTaskSearchFinds("E2E_BO_FB_TEXT_P", sessionId);
    await expectPhoneRowOrder(sessionId);
  });

  it("drops a reply that has only reasoning and whitespace from later requests", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_BO_S16 go");
    await browser.waitUntil(
      async () =>
        (await getUpstreamRequestEvidence({ includes: ["E2E_BO_S16 go"] })).some(
          (record) => record.fixtureId === "block-order-s16" && record.status === "complete",
        ),
      { timeout: 60_000, interval: 500, timeoutMsg: "E2E_BO_S16 请求没有完成" },
    );
    await waitForV4Pane((state) => !state.canStop, "E2E_BO_S16 轮次未结束");
    const sessionId = (
      await waitForV4Pane(
        (state) => Boolean(state.sessionId) && state.sessionId !== "draft",
        "E2E_BO_S16 没有 session",
      )
    ).sessionId!;

    await sendV4Prompt("E2E_BO_S16_FOLLOW_LIVE 冷恢复前续发。");
    await waitForV4TimelineContaining("E2E_BO_S16_FOLLOW_LIVE_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复前续发未结束");
    await restartAppAndRestoreSession(sessionId);
    await waitForV4TimelineContaining("E2E_BO_S16_FOLLOW_LIVE_DONE", COLD_RESTORE_TIMEOUT_MS);

    await sendV4Prompt("E2E_BO_S16_FOLLOW_COLD 冷恢复后续发。");
    await waitForV4TimelineContaining("E2E_BO_S16_FOLLOW_COLD_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复后续发未结束");

    const live = await requestFor("block-order-s16-follow-live", "E2E_BO_S16_FOLLOW_LIVE");
    const cold = await requestFor("block-order-s16-follow-cold", "E2E_BO_S16_FOLLOW_COLD");
    // 只有思考和空白的回复没有可见内容，和只有思考的回复一样在 core 投影第一步删除
    // （见规格「没有可见内容的回复」）：思考和空白都不发出，前后两条 user 之间没有 assistant。
    const indexOf = (marker: string) =>
      live.messages.findIndex((message) => JSON.stringify(message.content).includes(marker));
    const promptIndex = indexOf("E2E_BO_S16 go");
    const followIndex = indexOf("E2E_BO_S16_FOLLOW_LIVE");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(followIndex).toBeGreaterThanOrEqual(promptIndex);
    expect(
      live.messages
        .slice(promptIndex, followIndex + 1)
        .some((message) => message.role === "assistant"),
    ).toBe(false);
    expect(JSON.stringify(live.messages)).not.toContain("E2E_BO_S16_THINK_A");
    expect(stripCacheControl(cold.messages.slice(0, live.messages.length))).toEqual(
      stripCacheControl(live.messages),
    );
  });

  it("splits text that continues after a tool call on an openai-compatible stream", async function () {
    this.timeout(300_000);
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "a.txt"), "BO_FILE_A\n");
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
    await ensureToolCrossProductFullAccessMode();

    await sendV4Prompt("E2E_BO_OA go");
    await waitForV4TimelineContaining("E2E_BO_OA_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "openai-compatible 轮次未结束");
    const sessionId = (
      await waitForV4Pane(
        (state) => Boolean(state.sessionId) && state.sessionId !== "draft",
        "没有 session",
      )
    ).sessionId!;
    // 文字 Q 和文字 P 的 provider 块 id 相同；Read 之后开新块，live 也分成两行。
    const liveRows = await readRows(OA_ROW_MARKERS);
    expectOaRowOrder(liveRows);

    await sendV4Prompt("E2E_BO_OA_FOLLOW_LIVE 冷恢复前续发。");
    await waitForV4TimelineContaining("E2E_BO_OA_FOLLOW_LIVE_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复前续发未结束");
    await restartAppAndRestoreSession(sessionId);
    await waitForV4TimelineContaining("E2E_BO_OA_FOLLOW_LIVE_DONE", COLD_RESTORE_TIMEOUT_MS);
    const coldRows = await readRows(OA_ROW_MARKERS);
    expectOaRowOrder(coldRows);
    expect(coldRows["E2E_BO_OA_TEXT_Q"]! - coldRows["E2E_BO_OA_TEXT_P"]!).toBe(
      liveRows["E2E_BO_OA_TEXT_Q"]! - liveRows["E2E_BO_OA_TEXT_P"]!,
    );

    await sendV4Prompt("E2E_BO_OA_FOLLOW_COLD 冷恢复后续发。");
    await waitForV4TimelineContaining("E2E_BO_OA_FOLLOW_COLD_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复后续发未结束");
    const live = await requestFor("block-order-oa-follow-live", "E2E_BO_OA_FOLLOW_LIVE");
    const cold = await requestFor("block-order-oa-follow-cold", "E2E_BO_OA_FOLLOW_COLD");
    expect(stripCacheControl(cold.messages.slice(0, live.messages.length))).toEqual(
      stripCacheControl(live.messages),
    );
    // chat-completions 的 assistant 文字由 AI SDK 直接拼接，工具调用单独一个字段。
    const assistant = cold.messages.find(
      (message) => message.role === "assistant" && JSON.stringify(message).includes("call_bo_oa_1"),
    ) as { content: unknown; tool_calls?: Array<{ id: string }> } | undefined;
    expect(assistant?.content).toEqual("E2E_BO_OA_TEXT_PE2E_BO_OA_TEXT_Q");
    expect(assistant?.tool_calls?.map((call) => call.id)).toEqual(["call_bo_oa_1"]);
  });

  it("sends an old-format message in the old layout and only appends new messages after it", async function () {
    this.timeout(300_000);
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, "a.txt"), "BO_FILE_A\n");
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    await sendV4Prompt("E2E_BO_LEG go");
    await waitForV4TimelineContaining("E2E_BO_LEG_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "旧消息会话首轮未结束");
    const sessionId = (
      await waitForV4Pane(
        (state) => Boolean(state.sessionId) && state.sessionId !== "draft",
        "旧消息会话没有 session",
      )
    ).sessionId!;

    // 应用退出后、重启前改写存储，重启后这条消息按旧数据读取。
    await restartAppAndRestoreSession(sessionId, () => rewriteAsLegacyMessages(sessionId));
    await sendV4Prompt("E2E_BO_LEG_FOLLOW_OLD 旧格式续发。");
    await waitForV4TimelineContaining("E2E_BO_LEG_FOLLOW_OLD_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "旧格式续发未结束");

    await sendV4Prompt("E2E_BO_LEGNEW go");
    await browser.waitUntil(
      async () =>
        (await getUpstreamRequestEvidence({ includes: ["E2E_BO_LEGNEW go"] })).some(
          (record) => record.fixtureId === "block-order-legnew" && record.status === "complete",
        ),
      { timeout: 60_000, interval: 500, timeoutMsg: "E2E_BO_LEGNEW 请求没有完成" },
    );
    await waitForV4Pane((state) => !state.canStop, "新消息轮次未结束");
    await sendV4Prompt("E2E_BO_LEG_FOLLOW_LIVE 冷恢复前续发。");
    await waitForV4TimelineContaining("E2E_BO_LEG_FOLLOW_LIVE_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复前续发未结束");
    await restartAppAndRestoreSession(sessionId);
    await waitForV4TimelineContaining("E2E_BO_LEG_FOLLOW_LIVE_DONE", COLD_RESTORE_TIMEOUT_MS);
    await sendV4Prompt("E2E_BO_LEG_FOLLOW_COLD 冷恢复后续发。");
    await waitForV4TimelineContaining("E2E_BO_LEG_FOLLOW_COLD_DONE", 60_000);
    await waitForV4Pane((state) => !state.canStop, "冷恢复后续发未结束");

    const old = await requestFor("block-order-leg-follow-old", "E2E_BO_LEG_FOLLOW_OLD");
    const live = await requestFor("block-order-leg-follow-live", "E2E_BO_LEG_FOLLOW_LIVE");
    const cold = await requestFor("block-order-leg-follow-cold", "E2E_BO_LEG_FOLLOW_COLD");
    // 旧布局：[全部思考, 一段文字, 全部 tool_use]；旧数据里两段文字已经直接拼接成一段。
    const legacyLayout = ["A", "B", "PE2E_BO_LEG_TEXT_Q", "toolu_bo_leg_1"];
    expect(assistantCodesByMarker(old, "E2E_BO_LEG_")).toEqual(legacyLayout);
    expect(assistantCodesByMarker(cold, "E2E_BO_LEG_")).toEqual(legacyLayout);
    // 新消息按流顺序发送。
    expect(assistantCodesByMarker(cold, "E2E_BO_LEGNEW_")).toEqual(["A", "P", "B", "Q"]);
    // 追加新消息和冷恢复都不改变已发送的消息，旧消息的字节不变。
    expect(stripCacheControl(live.messages.slice(0, old.messages.length))).toEqual(
      stripCacheControl(old.messages),
    );
    expect(stripCacheControl(cold.messages.slice(0, live.messages.length))).toEqual(
      stripCacheControl(live.messages),
    );
  });
});

// 把会话里的 assistant 消息改写成改动前的存储格式：part 没有 blockIndex，多个文字块直接拼接成
// 一个 text part，工具 part 带 declarationIndex。node:sqlite 只提供同步接口；调用时应用已退出，没有并发写入。
function rewriteAsLegacyMessages(sessionId: string) {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home) throw new Error("缺少 ZCODE_E2E_HOME_DIR");
  const database = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"));
  try {
    database.exec("begin immediate");
    const messages = database
      .prepare("select id, data from message where session_id = ?")
      .all(sessionId) as Array<{ id: string; data: string }>;
    for (const message of messages) {
      if ((JSON.parse(message.data) as { role?: string }).role !== "assistant") continue;
      const parts = (
        database
          .prepare("select id, data from part where message_id = ?")
          .all(message.id) as Array<{
          id: string;
          data: string;
        }>
      )
        .map((row) => ({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown> }))
        .filter((part) => Number.isInteger(part.data.blockIndex))
        .sort((left, right) => Number(left.data.blockIndex) - Number(right.data.blockIndex));
      const texts = parts.filter((part) => part.data.type === "text");
      for (const extra of texts.slice(1)) {
        database.prepare("delete from part where id = ?").run(extra.id);
      }
      if (texts[0]) texts[0].data.text = texts.map((part) => String(part.data.text)).join("");
      parts
        .filter((part) => part.data.type === "tool")
        .forEach((part, declarationIndex) => {
          part.data.declarationIndex = declarationIndex;
        });
      for (const part of parts.filter((item) => item.data.type !== "text" || item === texts[0])) {
        delete part.data.blockIndex;
        database
          .prepare("update part set data = ? where id = ?")
          .run(JSON.stringify(part.data), part.id);
      }
    }
    database.exec("commit");
  } catch (error) {
    database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }
}

const OA_MODEL_ID = "e2e-bo-openai-model";
const OA_PROVIDER_ID = "e2e-bo-openai-provider";
const OA_PROVIDER_NAME = "Block Order Chat Completions";
const SF_ROW_MARKERS = [
  "E2E_BO_STOP_TEXT_P",
  "E2E_BO_STOP_TEXT_Q",
  "E2E_BO_FB_TEXT_P",
  "E2E_BO_FB_TEXT_Q",
];
const OA_ROW_MARKERS = ["E2E_BO_OA_TEXT_P", "E2E_BO_OA_TEXT_Q"];

function expectSfRowOrder(rows: Rows) {
  const order = SF_ROW_MARKERS.map((marker) => rows[marker]!);
  expect(order[0]).toBeGreaterThanOrEqual(0);
  expect(order).toEqual([...order].sort((left, right) => left - right));
  expect(new Set(order).size).toBe(order.length);
}

function expectOaRowOrder(rows: Rows) {
  const p = rows["E2E_BO_OA_TEXT_P"]!;
  const q = rows["E2E_BO_OA_TEXT_Q"]!;
  expect(p).toBeGreaterThanOrEqual(0);
  expect(q).toBeGreaterThan(p);
  expect(rows.texts[p]).not.toContain("E2E_BO_OA_TEXT_Q");
  expect(rows.texts.slice(p + 1, q).some((text) => text.includes("a.txt"))).toBe(true);
}

// 按标记取这条消息在请求里的块；停止和反馈两条消息各自独立。
function assistantCodesByMarker(request: RequestJson, marker: string): string[] {
  const message = request.messages.find(
    (item) => item.role === "assistant" && JSON.stringify(item.content).includes(marker),
  );
  return message ? blocksOf(message.content).map(describeBlock) : [];
}

async function rowIdOf(rows: Rows, marker: string): Promise<string> {
  const rowId = await browser.execute(
    (rowIndex) =>
      document
        .querySelectorAll<HTMLElement>("[data-row-id]")
        [rowIndex]?.getAttribute("data-row-id") ?? "",
    rows[marker]!,
  );
  expect(rowId).not.toBe("");
  return rowId;
}

async function clickFeedbackLike(rows: Rows, marker: string) {
  const button = await $(
    `[data-testid="${testId(TID_V4_FEEDBACK_LIKE, await rowIdOf(rows, marker))}"]`,
  );
  // 修复原因：展开过程区后轮尾行可能停在输入框下方；moveTo 自带的滚动在 Electron 下不可用
  // （Browser.getWindowForTarget 不支持），点击会落到输入框的模式按钮上。先用页面滚动把按钮
  // 放到视口中间，等它不被遮挡再点。
  await browser.execute((element) => element.scrollIntoView({ block: "center" }), button);
  await button.moveTo();
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await browser.waitUntil(async () => (await button.getAttribute("aria-pressed")) === "true", {
    timeout: 10_000,
    timeoutMsg: "点击后反馈按钮没有按下",
  });
}

async function feedbackLikePressed(rows: Rows, marker: string): Promise<boolean> {
  const button = await $(
    `[data-testid="${testId(TID_V4_FEEDBACK_LIKE, await rowIdOf(rows, marker))}"]`,
  );
  await button.waitForExist({ timeout: 10_000 });
  return (await button.getAttribute("aria-pressed")) === "true";
}

async function expectTaskSearchFinds(query: string, sessionId: string) {
  await $('[data-testid="sidebar-search-open"]').click();
  const input = $('[role="dialog"] [cmdk-input]');
  await input.waitForDisplayed();
  await $('[role="dialog"]')
    .$('.//button[@role="tab" and (normalize-space(.)="任务" or normalize-space(.)="Tasks")]')
    .click();
  await input.setValue(query);
  await browser.waitUntil(
    async () =>
      (
        await $$('[role="dialog"] [cmdk-item][data-value^="task-result:"]').map((row) =>
          row.getAttribute("data-value"),
        )
      ).some((value) => value?.includes(sessionId)),
    { timeout: 15_000, timeoutMsg: `搜索 ${query} 没有找到 ${sessionId}` },
  );
  await browser.keys("Escape");
}

// 手机远控读取同一会话：展开过程区后，停止消息与反馈消息的文字行顺序和桌面相同。
async function expectPhoneRowOrder(sessionId: string) {
  const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!endpoint || !artifactDir) throw new Error("缺少手机 fixture 或 artifact 目录");
  const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
  const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
  const chrome = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless: true,
  });
  try {
    const context = await chrome.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await context.addInitScript({
      content:
        'globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });',
    });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir,
      caseMarker: "I76",
      phase: "pairing",
      readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
    });
    await showMobileTaskHome(page);
    const toggles = page.getByTestId("virtual-project-toggle");
    for (let index = 0; index < (await toggles.count()); index += 1) {
      const toggle = toggles.nth(index);
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    await page.getByTestId(testId(TID_TASK_ITEM, sessionId)).first().click();
    const handle = await page.waitForFunction(
      ({ markers, historyPrefix }) => {
        for (const trigger of document.querySelectorAll<HTMLElement>(
          `[data-testid^="${historyPrefix}-"]`,
        )) {
          const open =
            trigger.getAttribute("aria-expanded") === "true" ||
            trigger.getAttribute("data-history-open") === "true";
          if (trigger.getAttribute("data-history-has-content") !== "false" && !open) {
            trigger.click();
          }
        }
        const texts = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).map(
          (row) => row.textContent ?? "",
        );
        const order = markers.map((marker) => texts.findLastIndex((text) => text.includes(marker)));
        return order.every((index) => index >= 0) ? order : null;
      },
      { markers: SF_ROW_MARKERS, historyPrefix: TID_CHAT_ASSISTANT_HISTORY_TRIGGER },
      { timeout: 30_000, polling: 500 },
    );
    const order = (await handle.jsonValue()) as number[];
    await page.screenshot({
      path: join(artifactDir, "assistant-block-order-mobile.png"),
      fullPage: true,
    });
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(new Set(order).size).toBe(order.length);
  } finally {
    await chrome.close();
  }
}

const S17_ROW_MARKERS = ["S17_TEXT_P", "S17_TEXT_Q", "S17_TEXT_R"];
const S18_ROW_MARKERS = ["S18_TEXT_P", "w.txt", "S18_TEXT_Q"];
// 服务端工具卡片显示格式化后的工具名。
const S20_ROW_MARKERS = ["S20_TEXT_P", "Analyze image", "S20_TEXT_Q"];

// 三个标记各占一行，并且按给定顺序排列。
function expectBetween(rows: Rows, [before, middle, after]: string[]) {
  expect(rows[before!]).toBeGreaterThanOrEqual(0);
  expect(rows[middle!]).toBeGreaterThan(rows[before!]!);
  expect(rows[after!]).toBeGreaterThan(rows[middle!]!);
}

async function runShapeTurn(shape: (typeof SHAPES)[number]) {
  const marker = `E2E_BO_${shape.id.toUpperCase()}`;
  await sendV4Prompt(`${marker} go`);
  if (/[123]/.test(shape.blocks)) {
    await waitForV4TimelineContaining(`${marker}_DONE`, 60_000);
  } else {
    // 没有本地工具的形态没有收尾回复；等最后一个请求完成后再等待轮次结束。
    const finalFixture = FINAL_FIXTURE[shape.id] ?? `block-order-${shape.id}`;
    await browser.waitUntil(
      async () =>
        (await getUpstreamRequestEvidence({ includes: [`${marker} go`] })).some(
          (record) => record.fixtureId === finalFixture && record.status === "complete",
        ),
      { timeout: 60_000, interval: 500, timeoutMsg: `${marker} 请求没有完成` },
    );
  }
  await waitForV4Pane((state) => !state.canStop, `${marker} 轮次未结束`);
}

// 按发送顺序比较同一会话的相邻主请求：上一次的 messages 必须原样出现在下一次的开头。
// 唯一例外是续写：续写提示不写入历史（TS09-CONTINUE），下一次请求去掉它，
// 并把续写文字接在原 assistant 消息的末尾，原有的块不变。
async function expectEachRequestAppends(firstPrompt: string) {
  const requests = (await getUpstreamRequestEvidence({ includes: [firstPrompt] })).map(
    (record) => stripCacheControl((record.requestJson as RequestJson).messages) as RequestMessage[],
  );
  expect(requests.length).toBeGreaterThan(SHAPES.length);
  for (const [index, next] of requests.slice(1).entries()) {
    let previous = requests[index]!;
    if (JSON.stringify(previous.at(-1)).includes("Output token limit hit")) {
      previous = previous.slice(0, -1);
      const kept = blocksOf(previous.at(-1)!.content);
      expect(blocksOf(next[previous.length - 1]!.content).slice(0, kept.length)).toEqual(kept);
      previous = previous.slice(0, -1);
    }
    expect(next.slice(0, previous.length)).toEqual(previous);
  }
}

async function requestFor(fixtureId: string, marker: string): Promise<RequestJson> {
  const record = (await getUpstreamRequestEvidence({ includes: [marker] })).find(
    (entry) => entry.fixtureId === fixtureId,
  );
  expect(record?.status).toBe("complete");
  return record!.requestJson as RequestJson;
}

function blocksOf(content: unknown): RequestBlock[] {
  return Array.isArray(content)
    ? (content as RequestBlock[])
    : [{ type: "text", text: String(content) }];
}

function assistantBlocks(request: RequestJson): RequestBlock[] {
  return request.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => blocksOf(message.content));
}

// 按块里的形态标记分组；收尾回复（_DONE）不属于被测消息。
function assistantBlocksByShape(request: RequestJson): Record<string, string[]> {
  const result: Record<string, string[]> = Object.fromEntries(
    SHAPES.map((shape) => [shape.id, []]),
  );
  for (const message of request.messages) {
    if (message.role !== "assistant") continue;
    const blocks = blocksOf(message.content);
    const shape = blocks.map(shapeOfBlock).find(Boolean);
    const codes = blocks.map(describeBlock);
    if (!shape || codes.every((code) => code === "DONE")) continue;
    result[shape] = [...result[shape]!, ...codes];
  }
  return result;
}

function shapeOfBlock(block: RequestBlock): string | undefined {
  const source = String(block.thinking ?? block.text ?? block.id ?? "");
  return /E2E_BO_(S\d+)_/.exec(source)?.[1]?.toLowerCase() ?? /toolu_bo_(s\d+)_/.exec(source)?.[1];
}

function describeBlock(block: RequestBlock): string {
  if (block.type === "thinking")
    return String(block.thinking).replace(/^E2E_BO_[A-Z0-9]+_THINK_/, "");
  if (block.type === "tool_use") return String(block.id).replace(/^toolu_bo_s\d+_/, "");
  if (block.type !== "text") return block.type;
  const text = String(block.text);
  if (/^E2E_BO_S\d+_DONE$/.test(text)) return "DONE";
  if (text.trim() === "") return "W";
  return text.replace(/^E2E_BO_[A-Z0-9]+_TEXT_/, "");
}

// 缓存断点随请求尾部移动，不属于内容；其余字段逐一比较。
function stripCacheControl(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (key, item: unknown) =>
      key === "cache_control" ? undefined : item,
    ),
  );
}

type Rows = Record<string, number> & { texts: string[] };

function expectRowOrder(rows: Rows) {
  expect(rows["S1_TEXT_P"]).toBeGreaterThanOrEqual(0);
  // S1：思考 A、文字 P、思考 B、文字 Q、Read，Read 卡片在文字 Q 之后。
  expect(rows["S1_TEXT_Q"]).toBeGreaterThan(rows["S1_TEXT_P"]!);
  expect(rows["a.txt"]).toBeGreaterThan(rows["S1_TEXT_Q"]!);
}

// S17：文字 P、Read a.txt、文字 Q、Read b.txt、文字 R，界面保持流顺序。
function expectS17RowOrder(rows: Rows) {
  const p = rows["S17_TEXT_P"]!;
  const q = rows["S17_TEXT_Q"]!;
  const r = rows["S17_TEXT_R"]!;
  expect(p).toBeGreaterThanOrEqual(0);
  expect(q).toBeGreaterThan(p);
  expect(r).toBeGreaterThan(q);
  expect(rows.texts.slice(p + 1, q).some((text) => text.includes("a.txt"))).toBe(true);
  expect(rows.texts.slice(q + 1, r).some((text) => text.includes("b.txt"))).toBe(true);
}

function rowGaps(rows: Rows) {
  return {
    pToQ: rows["S17_TEXT_Q"]! - rows["S17_TEXT_P"]!,
    qToR: rows["S17_TEXT_R"]! - rows["S17_TEXT_Q"]!,
  };
}

// 已完成轮次的过程区默认收起，子项不挂载；展开后才能读到工具前的文字行和工具卡片。
// 标记取最后一次出现的行，前面轮次里同名文件的卡片不影响判断。
// 修复原因：时间线是虚拟列表，只挂载视口附近的行；冷恢复后视口停在底部，前面轮次的行不在 DOM 里。
// 读不全时滚半屏再读：先向上，到顶后改为向下。
async function readRows(markers: string[]): Promise<Rows> {
  let rows = { texts: [] as string[] } as Rows;
  let direction = -1;
  try {
    await browser.waitUntil(
      async () => {
        await expandAssistantHistoriesWithContent();
        await expandVisibleSummaryGroups();
        const texts = await browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).map(
            (element) => element.textContent ?? "",
          ),
        );
        rows = { texts } as Rows;
        for (const marker of markers) {
          rows[marker] = texts.findLastIndex((text) => text.includes(marker));
        }
        if (markers.every((marker) => rows[marker]! >= 0)) return true;
        direction = await scrollTimelineHalfPage(direction);
        return false;
      },
      { timeout: 30_000, interval: 500, timeoutMsg: "过程区展开后没有读到全部块对应的行" },
    );
  } catch (error) {
    throw new Error(`${String(error)}; rows=${JSON.stringify(rows)}`, { cause: error });
  }
  return rows;
}

// 按方向滚半屏并返回实际方向：向上到顶后改为向下，向下到底后改为向上。
// 先发 wheel 事件，让时间线把这次滚动当作用户滚动，不再跟随底部。
async function scrollTimelineHalfPage(direction: number): Promise<number> {
  return browser.execute(
    (timelineTestId, current) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      if (!timeline) return current;
      const atTop = timeline.scrollTop <= 0;
      const atBottom = timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 1;
      const next = current < 0 && atTop ? 1 : current > 0 && atBottom ? -1 : current;
      timeline.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: next * 600 }),
      );
      timeline.scrollTop += (next * timeline.clientHeight) / 2;
      timeline.dispatchEvent(new Event("scroll"));
      return next;
    },
    TID_V4_TIMELINE,
    direction,
  );
}

async function restartAppAndRestoreSession(sessionId: string, afterExit?: () => void) {
  // 需要在应用退出期间改写存储时，用带退出屏障的重启。
  if (afterExit) {
    await reloadElectronSessionSafely(browser, { afterElectronProcessExit: afterExit });
  } else {
    await browser.reloadSession();
  }
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => isRendererUrl(target.url()))
          .at(-1);
        const targetId = rendererTarget
          ? ((rendererTarget as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "冷恢复后没有找到 renderer target",
    },
  );
  await waitForDefaultWorkspaceReady(COLD_RESTORE_TIMEOUT_MS);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
    `冷恢复没有恢复 session ${sessionId}`,
    COLD_RESTORE_TIMEOUT_MS,
  );
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool";
import { waitForCompactMarkerStatus } from "#e2e/helpers/conversation-session-compact";
import {
  countUpstreamRequestsContainingAll,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import {
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForLatestV4CommandAck,
} from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_COMPACT_TIMELINE_PROJECTION";
const COMPACT = "CRITICAL: Respond with TEXT ONLY";
const SEED_REPLY = "upstream-e2e-seed-ok";
const PENDING_REPLY = "upstream-e2e-pending-ok";
const COMPACT_FIXTURE = "compact-timeline-projection-controlled-compact";

describe("会话区 Compact Timeline Projection E2E", () => {
  afterEach(async () => {
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("auto compact 横线不会切开、吞掉或重复 pending assistant", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    // planner 保留最近一轮；只造一轮高 usage 无法形成可压缩前缀。
    for (let i = 0; i < 2; i++) {
      await sendV4Prompt(`${MARKER}_SEED_${i}: Reply with exactly "${SEED_REPLY}".`);
      await waitForUpstreamRequestContaining(`${MARKER}_SEED_${i}`);
      await waitForV4ConversationState((s) => s.state === "idle", "seed 未完成", 60000);
    }
    const before = await countUpstreamRequestsContainingAll([COMPACT, MARKER]);
    const pending = `${MARKER}_PENDING`;
    // 回复标记只出现在 assistant；写进 user prompt 会把正常的一问一答误计成重复输出。
    await sendV4Prompt(`${pending}: Continue this turn.`);
    await waitForCompactMarkerStatus("started", "auto");
    await waitForUpstreamRequestContaining(COMPACT);
    expect(await countUpstreamRequestsContainingAll([COMPACT, MARKER])).toBe(before + 1);
    await sendV4Prompt("/compact");
    // 旧用例只在摘要挂起时观察短暂无请求，漏掉 accepted 后排队的重复 compact。
    // 以本次命令的拒绝 ACK 确认准入结果，不补额外响应或延时掩盖业务缺陷。
    const duplicateAck = await waitForLatestV4CommandAck("compact");
    if (!["rejected", "failed"].includes(duplicateAck.status)) {
      throw new Error(`自动压缩中的重复 compact 没有被拒绝: ${JSON.stringify(duplicateAck)}`);
    }
    expect(duplicateAck.reasonCode).toMatch(/(?:^|\.)compactOperationLock$/);
    expect(await countUpstreamRequestsContainingAll([COMPACT, MARKER])).toBe(before + 1);
    await assertVisibleV4UserMessagesNotContaining("/compact");
    await releaseControlledReplay(COMPACT_FIXTURE);
    await waitForV4AssistantMessageContaining(PENDING_REPLY);
    await waitForV4ConversationState((s) => s.state === "idle", "pending assistant 未完成", 60000);
    await expandAssistantHistoriesWithContent();
    const turns = await readTurns();
    const matches = turns.filter((turn) => turn.text.includes(pending));
    expect(matches).toHaveLength(1);
    const turn = matches[0]!;
    expect(turn.histories).toBe(1);
    expect(turn.text.split(PENDING_REPLY)).toHaveLength(2);
    expect(turn.markers).toEqual([{ status: "success", origin: "auto", inHistory: true }]);
    expect(turn.rowIds.length).toBe(new Set(turn.rowIds).size);
    expect(await countUpstreamRequestsContainingAll([COMPACT, MARKER])).toBe(before + 1);
  });

  it("manual compact failed 横线不会把同一轮已工作切成多段", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    const prompt = `${MARKER}_MANUAL_SPLIT_SEED`;
    const tail = "MANUAL_COMPACT_FAILED_TAIL_VISIBLE";
    await sendV4Prompt(`${prompt}: Reply with exactly "${SEED_REPLY}".`);
    await waitForV4AssistantMessageContaining(SEED_REPLY);
    await waitForV4ConversationState((s) => s.state === "idle", "manual seed 未完成", 60000);
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    // 原用例直接改旧 renderer store，V4 订阅不会读取它。离线改原生历史后走正式冷恢复。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => seedManualFailedHistory(sessionId, tail),
    });
    await selectV4TaskById(sessionId);
    await waitForV4AssistantMessageContaining(tail);
    await expandAssistantHistoriesWithContent();
    const turns = (await readTurns()).filter((turn) => turn.text.includes(prompt));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.histories).toBe(1);
    expect(turns[0]!.text.split(tail)).toHaveLength(2);
    expect(turns[0]!.markers).toEqual([{ status: "failed", origin: "manual", inHistory: true }]);
    expect(turns[0]!.rowIds.length).toBe(new Set(turns[0]!.rowIds).size);
  });
});

function readTurns() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("section[data-turn-key]")).map((turn) => ({
      text: turn.innerText,
      histories: turn.querySelectorAll('[data-testid^="chat-assistant-history-trigger-"]').length,
      rowIds: Array.from(turn.querySelectorAll<HTMLElement>("[data-row-id]")).map(
        (row) => row.dataset.rowId,
      ),
      markers: Array.from(
        turn.querySelectorAll<HTMLElement>(
          '[data-row-kind="timelineMarker"][data-marker-type="compact"]',
        ),
      ).map((marker) => ({
        status: marker.dataset.status,
        origin: marker.dataset.origin,
        inHistory: Boolean(marker.closest('[data-testid^="chat-assistant-history-content-"]')),
      })),
    })),
  );
}

function seedManualFailedHistory(sessionId: string, tail: string) {
  const db = new DatabaseSync(join(homedir(), ".zcode/cli/db/db.sqlite"));
  try {
    const message = db
      .prepare(
        "SELECT id FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY time_created DESC LIMIT 1",
      )
      .get(sessionId) as { id: string } | undefined;
    if (!message) throw new Error("缺少真实 seed assistant");
    const at = Date.now();
    const parts = [
      {
        type: "reasoning",
        text: "MANUAL_COMPACT_BEFORE_THOUGHT",
        time: { start: at, end: at + 1 },
      },
      {
        type: "tool",
        callID: "manual-split-read",
        tool: "Read",
        state: {
          status: "completed",
          input: { file_path: "README.md" },
          output: "MANUAL_COMPACT_READ_RESULT",
          title: "Read README.md",
          metadata: {},
          time: { start: at + 2, end: at + 3 },
        },
      },
      {
        type: "timeline",
        timelineType: "context_compaction",
        display: "separator",
        status: "failed",
        operationId: "op-manual-split-failed",
        sourceCommandId: "command-manual-split-failed",
        trigger: "manual",
        phase: "mid_turn",
        reason: "E2E persisted compact failure",
        time: { start: at + 4, end: at + 5 },
      },
      {
        type: "reasoning",
        text: "MANUAL_COMPACT_AFTER_THOUGHT",
        time: { start: at + 6, end: at + 7 },
      },
      { type: "text", text: tail, time: { start: at + 8, end: at + 9 } },
    ];
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM part WHERE message_id=?").run(message.id);
    const insert = db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
    );
    for (const [index, part] of parts.entries())
      insert.run(
        `part_manual_split_${index}`,
        message.id,
        sessionId,
        at + index * 2,
        at + index * 2 + 1,
        JSON.stringify(part),
      );
    db.prepare(
      "UPDATE message SET data=json_set(data,'$.content',?,'$.time.completed',?),time_updated=? WHERE id=?",
    ).run(tail, at + 10, at + 10, message.id);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

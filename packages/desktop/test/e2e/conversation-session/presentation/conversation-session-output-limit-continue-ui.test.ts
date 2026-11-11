import { TID_V4_TIMELINE } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4CompactMarkers,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_OUTPUT_LIMIT_CONTINUE_UI";
const PARTIAL_ONE_ANCHOR = "即使底层已经";
const PARTIAL_TWO_ANCHOR = "例如这里再让句子停在";
const FINAL_ANCHOR = "一个尚未完成的位置";
const MAIN_REQUEST_QUERY = {
  excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
  includes: [CASE_MARKER],
};
const COMPACT_REQUEST_QUERY = {
  includes: ["CRITICAL: Respond with TEXT ONLY"],
};

describe("Output-limit Continue 句中截断 UI manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OTC08: 同一自然段两次句中截断后只渲染一个累计 assistant", async function () {
    const holdMs = readManualReviewHoldMs();
    this.timeout(120000 + holdMs);

    await prepareV4ConversationE2E();
    await sendV4Prompt(
      `${CASE_MARKER}: 请按 provider fixture 返回一段连续正文，并在句中连续两次命中 output-limit。`,
    );

    await waitForV4AssistantMessageContaining(FINAL_ANCHOR);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "OTC08 Continue 恢复链完成后没有回到 idle",
      90000,
    );

    await browser.waitUntil(async () => (await countUpstreamRequests(MAIN_REQUEST_QUERY)) === 3, {
      timeout: 30000,
      timeoutMsg: "OTC08 没有严格完成 p1(length) → p2(length) → p3(stop) 三次主请求",
    });

    const evidence = await getUpstreamRequestEvidence(MAIN_REQUEST_QUERY);
    expect(evidence.map((item) => item.fixtureId)).toEqual([
      "output-limit-continue-ui-partial-p1",
      "output-limit-continue-ui-partial-p2",
      "output-limit-continue-ui-final-p3",
    ]);
    expect(evidence.every((item) => item.status === "complete")).toBe(true);
    expect(evidence[0]?.responseTextPreview).toContain('"stop_reason":"max_tokens"');
    expect(evidence[1]?.responseTextPreview).toContain('"stop_reason":"max_tokens"');
    expect(evidence[2]?.responseTextPreview).toContain('"stop_reason":"end_turn"');
    expect(await countUpstreamRequests(COMPACT_REQUEST_QUERY)).toBe(0);
    expect(await getV4CompactMarkers()).toEqual([]);

    const rendered = await readContinueTurnSnapshot();
    expect(rendered.turnId).toBeTruthy();
    expect(rendered.assistantRows).toHaveLength(1);
    expect(rendered.assistantRows[0]?.inHistory).toBe(false);
    expect(rendered.assistantRows[0]?.rowId).toBeTruthy();
    const renderedText = rendered.assistantRows[0]?.text ?? "";
    const partialOneIndex = renderedText.indexOf(PARTIAL_ONE_ANCHOR);
    const partialTwoIndex = renderedText.indexOf(PARTIAL_TWO_ANCHOR);
    const finalIndex = renderedText.indexOf(FINAL_ANCHOR);
    expect(partialOneIndex).toBeGreaterThanOrEqual(0);
    expect(partialTwoIndex).toBeGreaterThan(partialOneIndex);
    expect(finalIndex).toBeGreaterThan(partialTwoIndex);
    expect(renderedText).toContain(`${PARTIAL_ONE_ANCHOR}发起了新的 provider 请求`);
    expect(renderedText).toContain(`${PARTIAL_TWO_ANCHOR}${FINAL_ANCHOR}`);

    if (holdMs > 0) {
      await browser.pause(holdMs);
    }
  });
});

interface ContinueAssistantRowSnapshot {
  inHistory: boolean;
  rowId: string | null;
  text: string;
}

interface ContinueTurnSnapshot {
  assistantRows: ContinueAssistantRowSnapshot[];
  turnId: string | null;
}

function readContinueTurnSnapshot(): Promise<ContinueTurnSnapshot> {
  return browser.execute(
    (timelineTestId, userMarker) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const userRow = Array.from(
        timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).find(
        (row) =>
          row.classList.contains("group/user-row") &&
          (row.innerText || row.textContent || "").includes(userMarker),
      );
      const turn = userRow?.closest<HTMLElement>("[data-turn-id]") ?? null;
      const assistantRows = Array.from(turn?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
        .filter((row) => row.classList.contains("group/assistant-row"))
        .map((row) => ({
          inHistory: Boolean(row.closest("[data-slot='collapsible-content']")),
          rowId: row.getAttribute("data-row-id"),
          text: (row.innerText || row.textContent || "").replace(/\u00a0/g, " "),
        }));
      return {
        assistantRows,
        turnId: turn?.getAttribute("data-turn-id") ?? null,
      };
    },
    TID_V4_TIMELINE,
    CASE_MARKER,
  );
}

function readManualReviewHoldMs(): number {
  const parsed = Number(process.env.ZCODE_E2E_MANUAL_REVIEW_HOLD_MS ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

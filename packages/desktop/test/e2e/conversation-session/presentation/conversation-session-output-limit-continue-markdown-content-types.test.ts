import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";
import {
  getV4CompactMarkers,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import {
  buildFixtureId,
  buildSubcaseMarker,
  COMPACT_REQUEST_QUERY,
  MARKDOWN_CONTINUE_CASES,
  removeMarkdownFixtures,
  writeMarkdownFixtures,
} from "#e2e/conversation-session/conversation-session-output-limit-continue-markdown-content-types.cases";
import {
  assertMarkdownCase,
  isMarkdownCaseReady,
  readMarkdownCaseSnapshot,
} from "#e2e/conversation-session/conversation-session-output-limit-continue-markdown-content-types.dom";

const CASE_MARKER = "E2E_OUTPUT_LIMIT_CONTINUE_MARKDOWN_CONTENT_TYPES";

describe("Output-limit Continue Markdown 独立内容类型 manual review", () => {
  before(async function () {
    this.timeout(180000);
    await writeMarkdownFixtures();
    await prepareV4ConversationE2E();
  });

  beforeEach(async () => {
    // 原因：全局新建使用独立 cwd，无法读取项目中的相对图片和文件 fixture。
    await startDraftFromProject(DEFAULT_WORKSPACE);
  });

  after(async function () {
    const holdMs = readManualReviewHoldMs();
    this.timeout(30000 + holdMs);

    if (holdMs > 0) {
      await browser.pause(holdMs);
    }

    await browser.electron.restoreAllMocks();
    await clearAppData();
    await removeMarkdownFixtures();
  });

  for (const definition of MARKDOWN_CONTINUE_CASES) {
    it(`OTC10/${definition.id}: 本类型独立跨 Continue 后只渲染一个完整 assistant`, async function () {
      this.timeout(120000);

      const marker = buildSubcaseMarker(definition.id);
      const mainRequestQuery = {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [CASE_MARKER, marker],
      };

      await sendV4Prompt(
        `${CASE_MARKER} ${marker}: 请严格按 provider fixture 返回本 Markdown 类型的两段累计正文。`,
      );
      await waitForV4AssistantMessageContaining(definition.finalAnchor);
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
        `OTC10/${definition.id} Continue 恢复链完成后没有回到 idle`,
        90000,
      );

      await browser.waitUntil(async () => (await countUpstreamRequests(mainRequestQuery)) === 2, {
        timeout: 30000,
        timeoutMsg: `OTC10/${definition.id} 没有严格完成 length 与 stop 两次主请求`,
      });
      const evidence = await getUpstreamRequestEvidence(mainRequestQuery);
      expect(evidence.map((item) => item.fixtureId)).toEqual([
        buildFixtureId(definition.id, "partial"),
        buildFixtureId(definition.id, "final"),
      ]);
      expect(evidence.every((item) => item.status === "complete")).toBe(true);
      expect(evidence[0]?.responseTextPreview).toContain('"stop_reason":"max_tokens"');
      expect(evidence[1]?.responseTextPreview).toContain('"stop_reason":"end_turn"');
      expect(await countUpstreamRequests(COMPACT_REQUEST_QUERY)).toBe(0);
      expect(await getV4CompactMarkers()).toEqual([]);

      await browser.waitUntil(
        async () => isMarkdownCaseReady(definition.id, await readMarkdownCaseSnapshot(marker)),
        {
          timeout: 30000,
          timeoutMsg: `OTC10/${definition.id} 的最终 Markdown DOM 没有收敛`,
        },
      );

      const snapshot = await readMarkdownCaseSnapshot(marker);
      expect(snapshot.turnId).toBeTruthy();
      expect(snapshot.assistantRows).toHaveLength(1);
      expect(snapshot.assistantRows[0]?.inHistory).toBe(false);
      expect(snapshot.assistantRows[0]?.rowId).toBeTruthy();
      expect(snapshot.assistantRows[0]?.text).toContain(definition.finalAnchor);
      assertMarkdownCase(definition.id, snapshot);
    });
  }
});

function readManualReviewHoldMs(): number {
  const parsed = Number(process.env.ZCODE_E2E_MANUAL_REVIEW_HOLD_MS ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

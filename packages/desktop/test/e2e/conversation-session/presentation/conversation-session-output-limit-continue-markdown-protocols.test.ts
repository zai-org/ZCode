import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_TIMELINE } from "@zcode/shared/test-ids";
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
  switchV4Model,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS";
const FINAL_ANCHOR = "自动链接";
const IMAGE_DIR = join(DEFAULT_WORKSPACE, ".zcode-e2e", "continue-markdown-protocols");
const IMAGE_PATH = join(IMAGE_DIR, "cross-seam.svg");
const EXTERNAL_LINK = "https://example.com/continue-edge";
const AUTOLINK = "https://example.com/autolink";
const COMPACT_REQUEST_QUERY = {
  includes: ["CRITICAL: Respond with TEXT ONLY"],
};

interface ProtocolCase {
  finalResponseMarker: string;
  fixtureIds: string[];
  id: string;
  marker: string;
  model: string;
  partialResponseMarkers: string[];
  path: string;
  provider: string;
  title: string;
}

const PROTOCOL_CASES: ProtocolCase[] = [
  {
    finalResponseMarker: '"finish_reason":"stop"',
    fixtureIds: [
      "otc11-chat-partial-p1",
      "otc11-chat-partial-p2",
      "otc11-chat-partial-p3",
      "otc11-chat-final-p4",
    ],
    id: "chat-completions",
    marker: "OTC11_CHAT_COMPLETIONS",
    model: "otc-protocol-chat",
    partialResponseMarkers: ['"finish_reason":"length"'],
    path: "/chat/completions",
    provider: "otc-protocol-chat",
    title: "Chat Completions",
  },
  {
    finalResponseMarker: '"type":"response.completed"',
    fixtureIds: [
      "otc11-responses-partial-p1",
      "otc11-responses-partial-p2",
      "otc11-responses-partial-p3",
      "otc11-responses-final-p4",
    ],
    id: "responses-api",
    marker: "OTC11_RESPONSES_API",
    model: "otc-protocol-responses",
    partialResponseMarkers: ['"type":"response.incomplete"', '"reason":"max_output_tokens"'],
    path: "/responses",
    provider: "otc-protocol-responses",
    title: "Responses API",
  },
];

describe("Output-limit Continue Markdown 协议归一化 manual review", () => {
  before(async () => {
    await mkdir(IMAGE_DIR, { recursive: true });
    await writeFile(
      IMAGE_PATH,
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2563eb"/><text x="24" y="100" fill="white" font-size="24">continue protocol</text></svg>',
      "utf8",
    );
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(IMAGE_DIR, { force: true, recursive: true });
  });

  for (const [caseIndex, protocolCase] of PROTOCOL_CASES.entries()) {
    it(`OTC11 ${protocolCase.title}: 标准 output-limit 终态归一化后复用 OTC09 的累计 Markdown row`, async function () {
      const shouldHold = caseIndex === PROTOCOL_CASES.length - 1;
      const holdMs = shouldHold ? readManualReviewHoldMs() : 0;
      this.timeout(150000 + holdMs);

      // 原因：本地 Markdown 图片播种在项目目录，全局草稿的独立 cwd 不能读取这些相对路径。
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await switchV4Model(protocolCase.provider, protocolCase.model, "");
      await sendV4Prompt(
        `${CASE_MARKER} ${protocolCase.marker}: 请按 provider fixture 返回覆盖全部受支持 Markdown 结构的四段累计正文。`,
      );

      await waitForV4AssistantMessageContaining(FINAL_ANCHOR);
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
        `OTC11 ${protocolCase.title} Continue 恢复链完成后没有回到 idle`,
        90000,
      );

      const mainRequestQuery = {
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
        includes: [CASE_MARKER, protocolCase.marker],
      };
      await browser.waitUntil(async () => (await countUpstreamRequests(mainRequestQuery)) === 4, {
        timeout: 30000,
        timeoutMsg: `OTC11 ${protocolCase.title} 没有严格完成三次 Continue 与最终正常结束的四次主请求`,
      });

      const evidence = await getUpstreamRequestEvidence(mainRequestQuery);
      expect(evidence.map((item) => item.fixtureId)).toEqual(protocolCase.fixtureIds);
      expect(evidence.every((item) => item.status === "complete")).toBe(true);
      expect(evidence.every((item) => item.path.includes(protocolCase.path))).toBe(true);
      expect(
        evidence
          .slice(0, 3)
          .every((item) =>
            protocolCase.partialResponseMarkers.every(
              (marker) => item.responseTextPreview?.includes(marker) === true,
            ),
          ),
      ).toBe(true);
      expect(evidence[3]?.responseTextPreview).toContain(protocolCase.finalResponseMarker);
      expect(await countUpstreamRequests(COMPACT_REQUEST_QUERY)).toBe(0);
      expect(await getV4CompactMarkers()).toEqual([]);

      await waitForMarkdownContinueTurnRendered(protocolCase.marker);
      assertMarkdownContinueTurnSnapshot(
        await readMarkdownContinueTurnSnapshot(protocolCase.marker),
      );

      if (holdMs > 0) {
        await browser.pause(holdMs);
      }
    });
  }
});

interface MarkdownAssistantRowSnapshot {
  inHistory: boolean;
  rowId: string | null;
  text: string;
}

interface MarkdownContinueTurnSnapshot {
  assistantRows: MarkdownAssistantRowSnapshot[];
  blockquoteTexts: string[];
  codeBlockCount: number;
  codeBlockLanguage: string | null;
  codeBlockText: string;
  deletedTexts: string[];
  displayMathCount: number;
  emphasisTexts: string[];
  externalLinkTitles: string[];
  hardBreakCount: number;
  headings: Array<{ level: string; text: string }>;
  images: Array<{ alt: string; src: string }>;
  inlineCodeTexts: string[];
  inlineMathCount: number;
  mermaidBlockCount: number;
  mermaidDiagramCount: number;
  orderedListCount: number;
  orderedListItems: string[];
  strongTexts: string[];
  tableRows: string[][];
  taskCheckboxes: Array<{ checked: boolean; disabled: boolean }>;
  thematicBreakCount: number;
  turnId: string | null;
  unorderedListCount: number;
  unorderedListItems: string[];
}

async function waitForMarkdownContinueTurnRendered(userMarker: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const rendered = await readMarkdownContinueTurnSnapshot(userMarker);
      return (
        rendered.images.length === 1 &&
        rendered.images[0]?.src.startsWith("data:image/svg+xml;base64,") === true &&
        rendered.inlineMathCount >= 1 &&
        rendered.displayMathCount === 1 &&
        rendered.mermaidDiagramCount === 1
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `OTC11 ${userMarker} 的本地图片、KaTeX 或 Mermaid 没有完成最终结构渲染`,
    },
  );
}

function assertMarkdownContinueTurnSnapshot(snapshot: MarkdownContinueTurnSnapshot): void {
  expect(snapshot.turnId).toBeTruthy();
  expect(snapshot.assistantRows).toHaveLength(1);
  expect(snapshot.assistantRows[0]?.inHistory).toBe(false);
  expect(snapshot.assistantRows[0]?.rowId).toBeTruthy();

  expect(snapshot.headings).toEqual([{ level: "H2", text: "Continue Markdown 全量边界" }]);
  expect(snapshot.strongTexts).toEqual(["粗体边界", "带跨缝链接"]);
  expect(snapshot.emphasisTexts).toEqual(["斜体边界", "有序项中的图片"]);
  expect(snapshot.deletedTexts).toEqual(["删除线边界", "有序项中的图片"]);
  expect(snapshot.inlineCodeTexts).toContain("inline-boundary");

  expect(snapshot.unorderedListCount).toBe(1);
  expect(snapshot.unorderedListItems).toEqual([
    "已完成任务",
    "带跨缝链接 保持完整",
    "普通 bullet 在 Continue 中保留",
  ]);
  expect(snapshot.taskCheckboxes).toEqual([
    { checked: true, disabled: true },
    { checked: false, disabled: true },
  ]);
  expect(snapshot.orderedListCount).toBe(1);
  expect(snapshot.orderedListItems).toEqual(["有序项中的图片 保持完整", "第二个有序项"]);

  expect(snapshot.externalLinkTitles).toEqual([EXTERNAL_LINK, AUTOLINK]);
  expect(snapshot.images[0]?.alt).toBe("跨缝图片");
  expect(snapshot.images[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/u);
  expect(snapshot.tableRows).toEqual([
    ["来源", "结果"],
    ["p3", "p4"],
  ]);
  expect(snapshot.thematicBreakCount).toBe(1);

  expect(snapshot.codeBlockCount).toBe(1);
  expect(snapshot.codeBlockLanguage).toBe("ts");
  expect(snapshot.codeBlockText).toContain('const beforeBoundary = "P3";');
  expect(snapshot.codeBlockText).toContain('const afterBoundary = "P4";');
  expect(snapshot.codeBlockText).toContain("console.log(beforeBoundary + afterBoundary);");
  expect(snapshot.blockquoteTexts).toEqual(["围栏闭合后的引用仍然正常。"]);
  expect(snapshot.hardBreakCount).toBe(1);
  expect(snapshot.inlineMathCount).toBeGreaterThanOrEqual(1);
  expect(snapshot.displayMathCount).toBe(1);
  expect(snapshot.mermaidBlockCount).toBe(1);
  expect(snapshot.mermaidDiagramCount).toBe(1);
  expect(snapshot.assistantRows[0]?.text).not.toContain("```");
}

function readMarkdownContinueTurnSnapshot(
  userMarker: string,
): Promise<MarkdownContinueTurnSnapshot> {
  return browser.execute(
    (timelineTestId, currentUserMarker) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const userRow = Array.from(
        timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).find(
        (row) =>
          row.classList.contains("group/user-row") &&
          (row.innerText || row.textContent || "").includes(currentUserMarker),
      );
      const turn = userRow?.closest<HTMLElement>("[data-turn-id]") ?? null;
      const assistantRowElements = Array.from(
        turn?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).filter((row) => row.classList.contains("group/assistant-row"));
      const assistantRows = assistantRowElements.map((row) => ({
        inHistory: Boolean(row.closest("[data-slot='collapsible-content']")),
        rowId: row.getAttribute("data-row-id"),
        text: (row.innerText || row.textContent || "").replace(/\u00a0/g, " "),
      }));
      const assistantRow = assistantRowElements[0] ?? null;
      const unorderedLists = Array.from(
        assistantRow?.querySelectorAll<HTMLElement>('ul[data-markdown-list="unordered"]') ?? [],
      );
      const orderedLists = Array.from(
        assistantRow?.querySelectorAll<HTMLElement>('ol[data-markdown-list="ordered"]') ?? [],
      );
      const codeBlocks = Array.from(
        assistantRow?.querySelectorAll<HTMLElement>('div[data-language="ts"]') ?? [],
      ).filter((element) => !element.parentElement?.closest('div[data-language="ts"]'));
      const codeBlock = codeBlocks[0] ?? null;
      const allMath = assistantRow?.querySelectorAll(".katex").length ?? 0;
      const displayMath = assistantRow?.querySelectorAll(".katex-display .katex").length ?? 0;

      return {
        assistantRows,
        blockquoteTexts: readElementTexts(
          assistantRow?.querySelectorAll<HTMLElement>("blockquote[data-markdown-blockquote]") ?? [],
        ),
        codeBlockCount: codeBlocks.length,
        codeBlockLanguage: codeBlock?.getAttribute("data-language") ?? null,
        codeBlockText: codeBlock ? readCodeLinesIncludingShadowRoots(codeBlock) : "",
        deletedTexts: readElementTexts(assistantRow?.querySelectorAll<HTMLElement>("del") ?? []),
        displayMathCount: assistantRow?.querySelectorAll(".katex-display").length ?? 0,
        emphasisTexts: readElementTexts(assistantRow?.querySelectorAll<HTMLElement>("em") ?? []),
        externalLinkTitles: Array.from(
          assistantRow?.querySelectorAll<HTMLButtonElement>('button[title^="https://"]') ?? [],
        ).map((element) => element.title),
        hardBreakCount: assistantRow?.querySelectorAll("br").length ?? 0,
        headings: Array.from(
          assistantRow?.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6") ?? [],
        ).map((element) => ({ level: element.tagName, text: element.textContent?.trim() ?? "" })),
        images: Array.from(
          assistantRow?.querySelectorAll<HTMLImageElement>("img[data-markdown-image]") ?? [],
        ).map((element) => ({ alt: element.alt, src: element.src })),
        inlineCodeTexts: readElementTexts(
          assistantRow?.querySelectorAll<HTMLElement>("code:not([data-block])") ?? [],
        ),
        inlineMathCount: Math.max(0, allMath - displayMath),
        mermaidBlockCount: assistantRow?.querySelectorAll("[data-mermaid-block]").length ?? 0,
        mermaidDiagramCount:
          assistantRow?.querySelectorAll('[data-mermaid-block] [role="img"]').length ?? 0,
        orderedListCount: orderedLists.length,
        orderedListItems: readDirectListItems(orderedLists[0]),
        strongTexts: readElementTexts(assistantRow?.querySelectorAll<HTMLElement>("strong") ?? []),
        tableRows: Array.from(
          assistantRow?.querySelectorAll<HTMLTableRowElement>("table tr") ?? [],
        ).map((row) =>
          Array.from(row.querySelectorAll<HTMLElement>("th,td")).map(
            (cell) => cell.textContent?.trim() ?? "",
          ),
        ),
        taskCheckboxes: Array.from(
          assistantRow?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [],
        ).map((element) => ({ checked: element.checked, disabled: element.disabled })),
        thematicBreakCount: assistantRow?.querySelectorAll("hr").length ?? 0,
        turnId: turn?.getAttribute("data-turn-id") ?? null,
        unorderedListCount: unorderedLists.length,
        unorderedListItems: readDirectListItems(unorderedLists[0]),
      };

      function readDirectListItems(list: HTMLElement | undefined): string[] {
        return Array.from(list?.children ?? []).map((element) =>
          (element.textContent || "").replace(/\s+/gu, " ").trim(),
        );
      }

      function readElementTexts(elements: Iterable<HTMLElement>): string[] {
        return Array.from(elements).map((element) =>
          (element.innerText || element.textContent || "").trim(),
        );
      }

      function readCodeLinesIncludingShadowRoots(root: Element | ShadowRoot): string {
        const lines: string[] = [];
        visit(root);
        return lines.join("\n");

        function visit(current: Element | ShadowRoot): void {
          for (const element of current.querySelectorAll<HTMLElement>("*")) {
            if (element.matches("[data-line]")) {
              lines.push(element.textContent ?? "");
            }
            if (element.shadowRoot) {
              visit(element.shadowRoot);
            }
          }
        }
      }
    },
    TID_V4_TIMELINE,
    userMarker,
  );
}

function readManualReviewHoldMs(): number {
  const parsed = Number(process.env.ZCODE_E2E_MANUAL_REVIEW_HOLD_MS ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

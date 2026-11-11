import { MarkdownTable } from "@/components/ai-elements/markdown-table.js";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const userRows: UserInputRow[] = Array.from({ length: 35 }, (_, index) => ({
  rowId: query.get("heavy") === "true" ? index * 200 + 1 : index + 1,
  turnId: `turn-${index + 1}`,
  createdAt: 1_700_000_000_000 + index,
  createdAtSeq: index + 1,
  kind: "userInput",
  origin: "realUser",
  text: `E2E_SRM10_${index + 1} ${"宽度变化时文字会重新换行，阅读历史不应被测高夺回滚动权。 Resize must preserve user scroll ownership. ".repeat(2)}`,
  attachments: [],
}));
// 侧栏 resize 的慢 trace 包含后台结果轮；该轮直接展示工具摘要，不能只用文本行回归。
const initialRows: ConversationRow[] = userRows.flatMap((row, index): ConversationRow[] => {
  if (query.get("heavy") !== "true" || index !== 20) return [row];
  return [
    {
      rowId: row.rowId,
      turnId: row.turnId,
      createdAt: row.createdAt,
      createdAtSeq: row.createdAtSeq,
      kind: "turnHeader",
      origin: "backgroundResult",
      state: "completedSuccess",
      startedAt: row.createdAt,
      endedAt: row.createdAt + 1000,
    },
    ...Array.from(
      { length: 134 },
      (_, toolIndex): ConversationRow => ({
        rowId: row.rowId + toolIndex + 1,
        turnId: row.turnId,
        createdAt: row.createdAt,
        createdAtSeq: row.createdAtSeq,
        kind: "toolCall",
        toolCallId: `resize-tool-${toolIndex}`,
        toolName: "FixtureTool",
        status: "success",
        inputText: '{"query":"fixture"}',
        input: { query: "fixture" },
      }),
    ),
  ];
});

const hydrationRows: ConversationRow[] = [
  {
    rowId: 1,
    turnId: "hydrate-leading",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "backgroundResult",
    state: "completedSuccess",
    startedAt: 1,
    endedAt: 1000,
  },
  ...Array.from(
    { length: 134 },
    (_, index): ConversationRow => ({
      rowId: index + 2,
      turnId: "hydrate-leading",
      createdAt: index + 2,
      createdAtSeq: index + 2,
      kind: "toolCall",
      toolCallId: `hydrate-tool-${index}`,
      toolName: "FixtureTool",
      status: "success",
      inputText: '{"query":"fixture"}',
      input: { query: "fixture" },
    }),
  ),
  ...userRows.slice(0, 5).map((row, index) => ({ ...row, rowId: 200 + index })),
];

const identityMode = query.get("identity");
const boundaryMode = query.get("boundary");
const terminalMode = query.get("terminal");
const terminalStartedAt = Date.now() - 5000;
function terminalRows(stopped: boolean, nextTurn: boolean): ConversationRow[] {
  const row = (rowId: number, turnId: string) => ({
    rowId,
    turnId,
    createdAt: terminalStartedAt + rowId,
    createdAtSeq: rowId,
  });
  return [
    {
      ...row(1, "prior-turn"),
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: terminalStartedAt - 1000,
      endedAt: terminalStartedAt,
    },
    {
      ...row(2, "prior-turn"),
      kind: "userInput",
      origin: "realUser",
      text: "E2E_SSV06_PRIOR_INPUT",
    },
    {
      ...row(3, "prior-turn"),
      kind: "assistantText",
      state: "complete",
      text: "E2E_SSV06_PRIOR_REPLY",
    },
    {
      ...row(4, "terminal-turn"),
      kind: "turnHeader",
      origin: "userInput",
      state: !stopped
        ? "running"
        : terminalMode === "complete"
          ? "completedSuccess"
          : terminalMode === "fail"
            ? "failed"
            : "completedInterrupted",
      startedAt: terminalStartedAt,
      ...(stopped ? { endedAt: terminalStartedAt + 5000, activeMs: 5000 } : {}),
    },
    {
      ...row(5, "terminal-turn"),
      kind: "userInput",
      origin: "realUser",
      text: "E2E_SSV06_CURRENT_INPUT",
    },
    {
      ...row(6, "terminal-turn"),
      kind: "assistantText",
      state: "complete",
      assistantResponseId: "history-response",
      text: `E2E_SSV06_HISTORY ${"停止前已显示的过程内容应保留，不应重新淡入。 Existing content keeps its identity. ".repeat(40)}`,
    },
    {
      ...row(7, "terminal-turn"),
      kind: "toolCall",
      toolCallId: "terminal-tool",
      toolName: "FixtureTool",
      status: "success",
      input: { query: "E2E_SSV06_TOOL" },
      inputText: '{"query":"E2E_SSV06_TOOL"}',
    },
    {
      ...row(8, "terminal-turn"),
      kind: "assistantText",
      state: !stopped ? "streaming" : terminalMode === "complete" ? "complete" : "interrupted",
      assistantResponseId: "tail-response",
      // 正常完成会折叠过程区；最终正文仍需超过视口，才能验证离底阅读的滚动归属。
      text: `E2E_SSV06_PARTIAL ${"最终正文保持可见，已有内容不应被重新挂载。 Terminal text remains visible. ".repeat(50)}`,
    },
    ...(nextTurn
      ? [
          {
            ...row(9, "next-turn"),
            kind: "turnHeader" as const,
            origin: "userInput" as const,
            state: "running" as const,
            startedAt: terminalStartedAt + 6000,
          },
          {
            ...row(10, "next-turn"),
            kind: "userInput" as const,
            origin: "realUser" as const,
            text: "E2E_SSV06_NEXT_INPUT",
          },
          {
            ...row(11, "next-turn"),
            kind: "assistantText" as const,
            state: "streaming" as const,
            text: "E2E_SSV06_NEXT_REPLY",
          },
        ]
      : []),
  ];
}
const boundaryPages =
  boundaryMode === "mixed"
    ? [
        [40, 41, 50, 51, 60, 61],
        [10, 11, 20, 39, 40, 41, 50, 51, 60, 61],
        [10, 11, 20, 39, 40, 41, 50, 51, 52, 60, 61, 62, 70, 80, 81],
      ]
    : [
        [50, 51],
        [50, 51, 60, 61],
        [10, 11, 20, 49, 50, 51, 60, 61, 62, 70, 80, 81],
      ];
const boundaryRows = (page: number): ConversationRow[] => [
  {
    rowId: 1,
    turnId: "boundary-turn",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "failed",
    startedAt: 1,
  },
  ...boundaryPages[page]!.map(
    (rowId): ConversationRow => ({
      rowId,
      turnId: "boundary-turn",
      createdAt: rowId,
      createdAtSeq: rowId,
      kind: "toolCall",
      toolCallId: `boundary-tool-${rowId}`,
      toolName: [10, 11, 39, 40, 41, 60, 61, 62, 80, 81].includes(rowId)
        ? "mcp__computer-use__screenshot"
        : "FixtureTool",
      assistantResponseId: "boundary-shared-response",
      status: "success",
      input: { query: `E2E_SSV05_BOUNDARY_${rowId}` },
      inputText: JSON.stringify({ query: `E2E_SSV05_BOUNDARY_${rowId}` }),
    }),
  ),
];
const identityRows: ConversationRow[] = [
  {
    rowId: 1,
    turnId: "identity-turn",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: identityMode === "stream" ? "running" : "failed",
    startedAt: 1,
  },
  ...Array.from(
    { length: 240 },
    (_, index): ConversationRow => ({
      rowId: index + 2,
      turnId: "identity-turn",
      createdAt: index + 2,
      createdAtSeq: index + 2,
      kind: "toolCall",
      toolCallId: `identity-tool-${index}`,
      toolName:
        identityMode === "cua" && index === 160 ? "mcp__computer-use__screenshot" : "FixtureTool",
      assistantResponseId: `identity-response-${index}`,
      status: "success",
      input: { query: `E2E_SSV05_${index}` },
      inputText: JSON.stringify({ query: `E2E_SSV05_${index}` }),
    }),
  ),
  ...(identityMode === "final" || identityMode === "cua"
    ? [
        {
          rowId: 242,
          turnId: "identity-turn",
          createdAt: 242,
          createdAtSeq: 242,
          kind: "assistantText" as const,
          text: "E2E_SSV05_FINAL",
          state: "complete" as const,
        },
      ]
    : []),
];

function Fixture() {
  const [stopped, setStopped] = useState(false);
  const [nextTurn, setNextTurn] = useState(false);
  const [boundaryPage, setBoundaryPage] = useState(0);
  const [session, setSession] = useState("a");
  const [draft, setDraft] = useState(false);
  const [rows, setRows] = useState(
    identityMode
      ? identityMode === "stream"
        ? identityRows.slice(0, 60)
        : identityRows.slice(-60)
      : query.get("hydrate") === "true"
        ? hydrationRows.slice(-60)
        : initialRows,
  );
  const back = useRef<(() => void) | null>(null);
  const locate = useRef<((target: { unitIndex: number; rowId: number }) => void) | null>(null);
  const displayedRows = draft
    ? []
    : terminalMode
      ? terminalRows(stopped, nextTurn)
      : boundaryMode
        ? boundaryRows(boundaryPage)
        : rows;
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale={query.get("mobile") === "true" ? "en-US" : "zh-CN"}>
        <div className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
          <nav className="flex shrink-0 gap-2 text-ui-caption">
            {terminalMode && (
              <>
                <button onClick={() => setStopped(true)}>Stop</button>
                <button onClick={() => setNextTurn(true)}>Next turn</button>
              </>
            )}
            {boundaryMode && (
              <button onClick={() => setBoundaryPage((page) => page + 1)}>Next boundary</button>
            )}
            <output data-testid="boundary-page">{boundaryPage}</output>
            <button onClick={() => setDraft((value) => !value)}>Draft</button>
            <button onClick={() => setSession((value) => (value === "a" ? "b" : "a"))}>
              Switch
            </button>
            <button onClick={() => back.current?.()}>Bottom</button>
            <button onClick={() => locate.current?.({ unitIndex: 0, rowId: 1 })}>Locate</button>
            {query.get("heavy") === "true" && (
              <button onClick={() => locate.current?.({ unitIndex: 19, rowId: 3801 })}>
                Tools
              </button>
            )}
            <button
              onClick={() =>
                setRows((value) =>
                  value.map((row, index) =>
                    index === value.length - 1 && row.kind === "userInput"
                      ? {
                          ...row,
                          text: row.text + " 新增内容 asynchronous content growth. ".repeat(20),
                        }
                      : row,
                  ),
                )
              }
            >
              Grow
            </button>
            <button onClick={() => setRows(hydrationRows)}>Hydrate</button>
            <button
              onClick={() =>
                setRows((current) =>
                  identityMode === "stream"
                    ? identityRows.slice(0, current.length + 60)
                    : identityRows.slice(-current.length - 60),
                )
              }
            >
              Next page
            </button>
            <output data-testid="scope">{session}</output>
          </nav>
          <div
            className={`flex min-h-0 min-w-0 flex-1 ${query.has("draft") ? "@container/conversation" : ""}`}
          >
            <ConversationTimeline
              rows={displayedRows}
              sessionPhase={
                terminalMode
                  ? !stopped || nextTurn
                    ? "running"
                    : terminalMode === "complete"
                      ? "completedSuccess"
                      : terminalMode === "fail"
                        ? "error"
                        : "completedInterrupted"
                  : boundaryMode
                    ? "error"
                    : identityMode
                      ? identityMode === "stream"
                        ? "running"
                        : "error"
                      : undefined
              }
              totalCount={displayedRows.length}
              centerEmptyStateWithDock={draft}
              compactEmptyStateWithDock={query.get("mobile") === "true"}
              sessionKey={session}
              scrollMemoryKey={`fixture::main::${session}`}
              compactForRemoteControl={query.get("mobile") === "true"}
              scrollToBottomActionRef={back}
              scrollToQueryActionRef={locate}
              rowContext={{
                codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
                sessionId: session,
                theme,
                workspacePath: "/fixture",
              }}
              bottomDock={
                <div
                  className={`h-16 w-full bg-background ${draft ? "max-w-2xl" : ""}`}
                  data-testid="fixture-composer"
                >
                  Composer
                </div>
              }
            />
          </div>
        </div>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}

function TableMotionFixture() {
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="en-US">
        <main
          className="min-h-dvh bg-background text-foreground text-ui-base"
          data-markdown-table-layout-root="true"
          data-testid="table-layout-root"
          style={{ width: "100%", transition: "width 200ms ease-out" }}
        >
          <section style={{ width: "65%", marginInline: "auto" }}>
            {[0, 1].map((index) => (
              <MarkdownTable key={index}>
                <thead>
                  <tr>
                    {[0, 1, 2, 3].map((column) => (
                      <th key={column}>Column {column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 6 }, (_, row) => (
                    <tr key={row}>
                      {[0, 1, 2, 3].map((column) => (
                        <td key={column}>
                          Table {index} row {row} column {column}: a wide value for horizontal
                          scrolling
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </MarkdownTable>
            ))}
          </section>
        </main>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  query.has("table-motion") ? (
    <TableMotionFixture />
  ) : boundaryMode ? (
    <StrictMode>
      <Fixture />
    </StrictMode>
  ) : (
    <Fixture />
  ),
);

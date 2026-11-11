import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const paragraph = "Deterministic long conversation. 保留完整的问题目录和正文阅读位置。 ".repeat(6);
const initial: ConversationRow[] = Array.from({ length: 80 }, (_, index) => {
  const base = { turnId: `perf-${index}`, createdAt: 1, createdAtSeq: index * 10 + 1 };
  const rows: ConversationRow[] = [
    {
      ...base,
      rowId: index * 10 + 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1,
      endedAt: 2,
    },
    {
      ...base,
      rowId: index * 10 + 2,
      kind: "userInput",
      origin: "realUser",
      text: `E2E_TN10 query ${index}`,
      attachments: [],
    },
    {
      ...base,
      rowId: index * 10 + 3,
      kind: "assistantText",
      state: "complete",
      text: `Answer ${index}\n\n${Array(8).fill(paragraph).join("\n\n")}`,
    },
  ];
  if (index === 20) {
    rows.push(
      { ...base, rowId: 204, kind: "userInput", origin: "realUser", text: "E2E_TN10 guide one" },
      { ...base, rowId: 205, kind: "assistantText", state: "complete", text: paragraph },
      { ...base, rowId: 206, kind: "userInput", origin: "realUser", text: "E2E_TN10 guide two" },
      { ...base, rowId: 207, kind: "assistantText", state: "complete", text: paragraph },
    );
  }
  return rows;
}).flat();

function Fixture() {
  const [rows, setRows] = useState(params.has("entrance") ? initial.slice(-6) : initial);
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const find = useRef({ calls: 0, matchCount: 0 });
  const onFind = useCallback((state: { matchCount: number }) => {
    find.current = { calls: find.current.calls + 1, matchCount: state.matchCount };
  }, []);
  const locate = useRef<((target: { unitIndex: number; rowId: number }) => void) | null>(null);
  const bottom = useRef<(() => void) | null>(null);
  const context = useRef({
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    sessionId: "tn10",
    theme,
    workspacePath: "/fixture",
  }).current;
  Object.assign(window, {
    __navigatorPerf: {
      hydrate: () => setRows(initial),
      stream: () =>
        setRows((value) =>
          value.map((row) =>
            row.rowId === 793 && row.kind === "assistantText"
              ? { ...row, text: `${row.text} Streaming update.` }
              : row,
          ),
        ),
      hide: setHidden,
      search: setQuery,
      find: () => find.current,
      jump: (rowId: number) => locate.current?.({ unitIndex: Math.floor(rowId / 10), rowId }),
      bottom: () => bottom.current?.(),
      revise: () =>
        setRows((value) =>
          value.map((row) =>
            row.rowId === 203 && row.kind === "assistantText"
              ? { ...row, text: `Revised answer\n\n${row.text}` }
              : row,
          ),
        ),
      grow: () =>
        setRows((value) =>
          value.map((row) =>
            row.rowId === 203 && row.kind === "assistantText"
              ? { ...row, text: `${row.text}\n\n${paragraph}` }
              : row,
          ),
        ),
    },
  });
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale={params.get("mobile") === "true" ? "en-US" : "zh-CN"}>
        <div className="@container/conversation flex h-dvh min-w-0 flex-col bg-background text-foreground">
          <ConversationTimeline
            rows={rows}
            totalCount={rows.length}
            sessionKey="tn10"
            rowContext={context}
            hideTurnNavigator={hidden}
            conversationFindQuery={query}
            onConversationFindMatchStateChange={onFind}
            scrollToQueryActionRef={locate}
            scrollToBottomActionRef={bottom}
            bottomDock={
              <div className="h-16 bg-background" data-testid="perf-composer">
                Composer
              </div>
            }
          />
        </div>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

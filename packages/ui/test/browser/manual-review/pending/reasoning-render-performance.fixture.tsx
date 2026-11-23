import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "dark" ? "dark" : "light";
const mobile = query.get("mobile") === "true";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const count = Number(query.get("groups") ?? 40);
let nextRowId = 1;
const base = () => {
  const rowId = nextRowId++;
  return { rowId, turnId: "perf-turn", createdAt: rowId, createdAtSeq: rowId };
};
const initial: ConversationRow[] = [
  { ...base(), kind: "turnHeader", origin: "backgroundResult", state: "running", startedAt: 1 },
  ...Array.from({ length: count }, (_, index): ConversationRow[] => [
    ...Array.from({ length: index === 0 ? 120 : 3 }, (_, child): ConversationRow => {
      const input = {
        file_path: `/workspace/group-${index}/file-${child}.ts`,
        content: "export const value = 1;",
      };
      return {
        ...base(),
        kind: "toolCall",
        toolCallId: `perf-${index}-${child}`,
        toolName: "Write",
        status: "success",
        input,
        inputText: JSON.stringify(input),
      };
    }),
    {
      ...base(),
      kind: "reasoning",
      state: "complete",
      text: `E2E_XSG04_THOUGHT_${index}\n${"思考详情保持完整。 Thinking detail stays intact. ".repeat(80)}`,
    },
    {
      ...base(),
      kind: "toolCall",
      toolCallId: `boundary-${index}`,
      toolName: "FixtureTool",
      status: "success",
      input: { query: "boundary" },
      inputText: '{"query":"boundary"}',
    },
  ]).flat(),
  { ...base(), kind: "reasoning", state: "streaming", text: "E2E_XSG04_LIVE" },
];
function Fixture() {
  const [rows, setRows] = useState(initial);
  const [tick, setTick] = useState(0);
  const context = useMemo(
    () => ({
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId: "perf-session",
      theme,
      workspacePath: "/workspace",
      messageStreamShowReasoning: true,
    }),
    [],
  );
  // 只推进确定性输入；渲染、分组、测量和折叠均执行真实产品组件。
  Object.assign(window, {
    __reasoningPerf: {
      revise: () =>
        setRows((current) =>
          current.map((row) =>
            row.kind === "toolCall" && row.toolCallId === "perf-0-1"
              ? {
                  ...row,
                  toolName: "Bash",
                  input: { command: "echo E2E_XSG04_UPDATED" },
                  inputText: '{"command":"echo E2E_XSG04_UPDATED"}',
                }
              : row,
          ),
        ),
      step: () => {
        setRows((current) =>
          current.map((row, index) =>
            index === current.length - 1 && row.kind === "reasoning"
              ? { ...row, text: row.text + " next" }
              : row,
          ),
        );
        setTick((value) => value + 1);
      },
    },
  });
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale={mobile ? "en-US" : "zh-CN"}>
        <div className="flex h-dvh flex-col bg-background text-foreground">
          <output data-testid="tick">{tick}</output>
          <ConversationTimeline
            rows={rows}
            totalCount={rows.length}
            sessionPhase="running"
            sessionKey="perf-session"
            scrollMemoryKey="perf-session"
            compactForRemoteControl={mobile}
            rowContext={context}
          />
        </div>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

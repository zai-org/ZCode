import { useState } from "react";
import { createRoot } from "react-dom/client";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";
const query = new URLSearchParams(location.search);
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const session = {
  kind: "app",
  sessionId: "sess_example-123456789",
  workspacePath: "/private/internal-path",
  sourceServerId: "internal-source",
};
const summary = { session, title: "Project analysis", status: "running", availableActions: [] };
const budgetCases =
  (
    window as unknown as {
      __sessionBudgetCases?: { id: string; name: string; output: string }[];
    }
  ).__sessionBudgetCases ?? [];
function Fixture() {
  const [done, setDone] = useState(query.get("restored") === "1");
  const cases = [
    {
      id: "list",
      name: "ListSessions",
      output: {
        sessions: [summary],
        nextCursor: "private-cursor",
        searchScope: {
          scopes: [],
          unavailableSources: [{ sourceServerId: "secret", reason: "offline" }],
        },
      },
    },
    {
      id: "read",
      name: "ReadSession",
      input: { sessionId: session.sessionId },
      output: JSON.stringify({
        view: "messages",
        session,
        messages: [{ id: "msg", role: "assistant", text: "Message body\n".repeat(30) }],
        nextCursor: "more",
      }),
    },
    { id: "summary", name: "ReadSession", output: { view: "summary", summary } },
    {
      id: "send",
      name: "SendToSession",
      input: { sessionId: session.sessionId, prompt: "Please inspect reuse" },
      output: { session, admission: "accepted", delivery: "queued" },
    },
    {
      id: "rejected",
      name: "SendToSession",
      output: { session, admission: "rejected", delivery: "none", reason: "Permission denied" },
    },
    {
      id: "wait",
      name: "WaitSessions",
      input: { operations: [{ sessionId: session.sessionId, commandId: "private-command" }] },
      output: {
        status: "timed_out",
        operations: [
          {
            operation: { session, commandId: "private-command" },
            status: "needs_attention",
            attention: { kind: "question", message: "Choose a target" },
          },
        ],
      },
    },
    {
      id: "running",
      name: "ReadSession",
      input: { sessionId: session.sessionId },
      status: done ? "completed" : "running",
      output: done ? { view: "summary", summary } : undefined,
    },
    {
      id: "failed",
      name: "SendToSession",
      status: "failed",
      error: "Execution failed",
      output: { session, admission: "accepted", delivery: "queued" },
    },
    {
      id: "stopped",
      name: "WaitSessions",
      status: "stopped",
      output: { status: "completed", operations: [] },
    },
    {
      id: "denied",
      name: "SendToSession",
      status: "denied",
      output: { session, admission: "accepted", delivery: "start_now" },
    },
    {
      id: "unknown",
      name: "SendToSession",
      output: { session, admission: "unknown", delivery: "unknown" },
    },
    {
      id: "legacy",
      name: "ReadSession",
      input: { sessionId: session.sessionId },
      output: "{broken JSON",
    },
    ...budgetCases.map((row) => ({
      ...row,
      input: { operations: [{ sessionId: session.sessionId }] },
    })),
    {
      id: "budget-live",
      name: "ReadSession",
      status: done ? "completed" : "running",
      output: done ? budgetCases[0]?.output : undefined,
    },
    { id: "budget-legacy", name: "ReadSession", raw: { rawOutput: budgetCases[0]?.output } },
    { id: "other", name: "OtherSession", output: { test: "ordinary fallback" } },
  ];
  return (
    <main className="min-h-screen space-y-4 bg-background p-4 text-foreground">
      <button data-testid="complete" onClick={() => setDone(true)}>
        Complete
      </button>
      {cases.map(({ id, name, ...fields }) => {
        const legacyNode = {
          toolCall: { toolId: id, kind: name, toolName: name, status: "completed", ...fields },
          childToolCalls: [],
        } as TaskChatToolCallTreeNode;
        const node =
          id === "budget-live" || budgetCases.some((row) => row.id === id)
            ? toolCallRowToLegacyNode({
                toolCallId: id,
                toolName: name,
                inputText: "",
                input: fields.input,
                status: legacyNode.toolCall.status === "running" ? "running" : "success",
                output:
                  typeof fields.output === "string"
                    ? { text: fields.output, truncated: true }
                    : undefined,
              } as ToolCallRow)
            : legacyNode;
        return (
          <section key={id} data-case={id}>
            <ToolPresentation toolCallNode={node} theme={theme} />
          </section>
        );
      })}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);

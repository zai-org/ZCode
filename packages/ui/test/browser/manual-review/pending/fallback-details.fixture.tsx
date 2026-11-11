import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
function Fixture() {
  const [completed, setCompleted] = useState(false);
  const cases = [
    {
      id: "simple",
      input: { session_id: "example-session", limit: 0, active: false },
      output: "Found 2 sessions",
    },
    { id: "empty", input: {}, output: "No sessions found" },
    { id: "complex", input: { filters: { states: ["running"] } }, output: [{ id: "example" }] },
    { id: "failed", input: {}, output: "STALE_SUCCESS", error: "Access denied", status: "failed" },
    {
      id: "running",
      input: {},
      output: completed ? "Result arrived" : undefined,
      status: completed ? "completed" : "running",
    },
    { id: "zero", output: 0 },
    { id: "false", output: false },
    { id: "null", output: null },
    { id: "blank", output: "" },
    { id: "absent" },
    {
      id: "long",
      input: { ["long_field_".repeat(12)]: "value".repeat(80) },
      output: "Long result line\n".repeat(80),
    },
  ];
  return (
    <main className="min-h-screen space-y-4 bg-background p-4 text-foreground">
      <button data-testid="complete" onClick={() => setCompleted(true)}>
        Complete
      </button>
      {cases.map(({ id, ...fields }) => {
        const toolCall = {
          toolId: id,
          name: "ListSessions",
          kind: "other",
          title: "ListSessions",
          status: "completed",
          raw: { secret: "internal-metadata" },
          ...fields,
        } as ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
        const context = {
          toolCallNode: { toolCall, childToolCalls: [] },
          workspacePath: "/example",
          isRunning: toolCall.status === "running",
          statusLabel: toolCall.status,
          errorText: toolCall.error,
          childToolList: null,
          displayModel: buildToolDisplayModel(toolCall, "/example"),
          theme,
        } as ToolCallBlockRenderContext;
        return (
          <section key={id} data-case={id}>
            <FallbackToolCallBlock {...context} />
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

import { createRoot } from "react-dom/client";
import { AgentToolCallBlock } from "@/ToolCallBlocks/renderers/agent.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const cases = [
  { id: "placeholder", input: {} },
  {
    id: "named",
    input: { subagent_type: "researcher", description: "Inspect directory structure" },
  },
  { id: "configured", input: { color: "red" } },
];
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <TooltipProvider>
      <main className="min-h-screen bg-background p-4 text-foreground">
        {cases.map(({ id, input }) => {
          const context = {
            toolCallNode: {
              toolCall: { toolId: id, name: "Agent", title: "Agent", status: "pending", input },
              childToolCalls: [],
            },
            workspacePath: "/example",
            isRunning: false,
            statusLabel: locale === "en-US" ? "Pending" : "等待中",
            nestedToolRenderer: () => null,
          } as unknown as ToolCallBlockRenderContext;
          return (
            <section key={id} data-case={id}>
              <AgentToolCallBlock {...context} />
            </section>
          );
        })}
      </main>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);

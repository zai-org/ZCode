import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";
import { ConsecutiveSummaryGroup } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { Reasoning, ReasoningTrigger } from "@/components/ai-elements/reasoning.js";
import { SummaryGroupBoundaryContext } from "@/v4/conversationRowContext.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
let snapshot = {
  key: "A",
  text: "A initial",
  secondary: "secondary 0",
  trailing: "+0",
  enabled: true,
  disabled: false,
  streaming: true,
  mounted: true,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => snapshot;
const update = (patch: Partial<typeof snapshot>) => {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
};
// 同步订阅通知与真实投影 store 同形；microtask 连续交付固定触发旧实现的嵌套更新问题。
Object.assign(window, {
  summaryFixture: {
    update,
    async burst() {
      for (let i = 1; i <= 200; i++) {
        update({
          text: `${"stream ".repeat(i)}A token ${i}`,
          secondary: `secondary ${i}`,
          trailing: `+${i}`,
        });
        await Promise.resolve();
      }
    },
  },
});
function Fixture() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const thought = (
    <Reasoning isStreaming={state.streaming}>
      <ReasoningTrigger streamingText={state.text} />
    </Reasoning>
  );
  return (
    <main className="min-h-screen bg-background p-4 text-ui-base text-foreground">
      {state.mounted && (
        <section data-summary-fixture>
          {params.has("group") ? (
            <SummaryGroupBoundaryContext.Provider value={{ taskRunning: true, tailRowId: 2 }}>
              <ConsecutiveSummaryGroup
                summary={thought}
                contentKey={state.key}
                refreshVersion={state.text}
                statistics="Reasoning"
                lastRowId={2}
                hasActiveItem={state.streaming}
              >
                {thought}
              </ConsecutiveSummaryGroup>
            </SummaryGroupBoundaryContext.Provider>
          ) : params.has("reasoning") ? (
            thought
          ) : (
            <QueuedSummaryContent
              contentKey={state.key}
              contentRefreshVersion={state.text}
              primaryText={<span data-primary>{state.text}</span>}
              secondaryText={<span data-secondary>{state.secondary}</span>}
              trailingText={<span data-trailing>{state.trailing}</span>}
              enabled={state.enabled}
              disableAnimation={state.disabled}
            />
          )}
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <Fixture />
  </ZCodeIntlProvider>,
);

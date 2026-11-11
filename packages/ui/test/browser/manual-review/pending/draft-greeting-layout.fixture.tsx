import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const compact = params.has("compact");

function Fixture() {
  const { locale, setLocale } = useZCodeIntl();
  const [revision, setRevision] = useState(0);
  return (
    <main className="min-h-dvh bg-background p-4 text-ui-base text-foreground">
      <button onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}>
        Switch language
      </button>
      <button onClick={() => setRevision(revision + 1)}>Render parent {revision}</button>
      <section
        data-testid="greeting-column"
        className="mt-24"
        style={{ width: compact ? "100%" : 672 }}
      >
        <ConversationDraftEmptyState compactForRemoteControl={compact} />
        {/* 只测量标题对下一兄弟节点的位置影响；真实 composer 由桌面 E2E 覆盖。 */}
        <input
          data-testid="following-input"
          aria-label="Message"
          className="h-24 w-full rounded-2xl border border-input-border bg-input"
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <Fixture />
  </ZCodeIntlProvider>,
);

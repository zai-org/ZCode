import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = `${theme} theme-zai-${theme} platform-windows-desktop`;

function Fixture() {
  const { intl } = useZCodeIntl();
  const [choice, setChoice] = useState("pending");
  const requestChoice = useConfirmDialogStore((state) => state.requestChoice);
  const open = (update: boolean) => {
    setChoice("pending");
    void requestChoice({
      ...(update ? { presentation: "update-confirmation" as const, showKeyboardHints: false } : {}),
      testId: "confirmation-fixture",
      title: intl.formatMessage({ id: "updateReady.confirm.title" }, { version: "3.19.0" }),
      description: intl.formatMessage({ id: "updateReady.confirm.description" }),
      confirmLabel: intl.formatMessage({ id: "updateReady.confirm.ok" }),
      cancelLabel: intl.formatMessage({ id: "updateReady.confirm.cancel" }),
    }).then(setChoice);
  };
  return (
    <main className="min-h-dvh bg-background p-5 text-foreground">
      <button data-testid="open-update" onClick={() => open(true)}>
        Update
      </button>
      <button data-testid="open-default" onClick={() => open(false)}>
        Default
      </button>
      <output data-testid="choice">{choice}</output>
      <ConfirmDialogHost />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <Fixture />
  </ZCodeIntlProvider>,
);

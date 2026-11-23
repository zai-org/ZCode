import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "@/ErrorBoundary.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("zcode-locale-preference", params.get("locale") ?? "en-US");
document.documentElement.className =
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark dark";
function Broken(): never {
  throw new Error("E2E_CRASH_RESTART_COMPONENT");
}
const restart =
  params.get("desktop") === "1"
    ? async () => {
        document.body.dataset.restartCount = String(
          Number(document.body.dataset.restartCount ?? 0) + 1,
        );
      }
    : undefined;
createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary onRestart={restart}>
    <Broken />
  </AppErrorBoundary>,
);

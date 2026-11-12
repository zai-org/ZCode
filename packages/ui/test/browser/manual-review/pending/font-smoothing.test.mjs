import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = join(root, "font-smoothing-preview.tsx");
const artifacts = join(root, "packages/desktop/.e2e-artifacts/font-smoothing");
const fixture = `
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { AppearanceSectionContent } from "@/settingsCodePreview.js";
import { createZCodeStore } from "@/store/index.js";
import "@/styles.css";
const query = new URLSearchParams(location.search);
const platform = query.get("platform");
document.documentElement.classList.toggle("platform-mac-desktop", platform === "mac");
const channel = new BroadcastChannel("font-smoothing-test");
window.sent = 0;
const store = createZCodeStore({send(message) { window.sent++; channel.postMessage(message); }, onMessage(callback) {channel.onmessage = event => callback(event.data); return () => {channel.onmessage = null;};}});
store.getState().setTheme("zai-" + query.get("theme"));
window.store = store;
function Fixture() {
 const state = useStore(store);
 return <ZCodeIntlProvider initialLocale={query.get("locale")}>
 <main className="bg-background text-foreground p-4" style={{height:"100vh",overflow:"auto"}}>
 <AppearanceSectionContent isMacDesktop={platform === "mac"}
 fontSmoothingEnabled={state.fontSmoothingEnabled} setFontSmoothingEnabled={state.setFontSmoothingEnabled}
 theme={state.theme} setTheme={state.setTheme} uiFontSizePx={state.uiFontSizePx} setUiFontSizePx={state.setUiFontSizePx}
 codePreviewSettings={state.codePreviewSettings} setCodePreviewSettings={state.setCodePreviewSettings} />
 </main></ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

test("macOS 字体平滑：切换、重载、多窗口与平台隔离", async () => {
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "font-smoothing-preview",
        resolveId(id) {
          if (id === "/font-smoothing-preview.tsx") return entry;
        },
        load(id) {
          if (id === entry) return fixture;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/font-smoothing-preview.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { dedupe: ["react", "react-dom"], alias: { "@": join(root, "packages/ui/src") } },
    optimizeDeps: {
      entries: [],
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "class-variance-authority",
        "clsx",
        "radix-ui",
        "tailwind-merge",
        "zod",
        "zustand",
        "lucide-react",
        "@pierre/diffs/react",
        "@streamdown/mermaid",
      ],
    },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const url = (platform, theme = "light", locale = "zh-CN") =>
      `${server.resolvedUrls.local[0]}fixture?platform=${platform}&theme=${theme}&locale=${locale}`;
    const page = await context.newPage();
    page.on("pageerror", (error) => process.stderr.write(String(error) + "\n"));
    await page.goto(url("mac"));
    const toggle = page.getByTestId("font-smoothing-switch");
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    const read = (p) =>
      p.evaluate(() => getComputedStyle(document.body).getPropertyValue("-webkit-font-smoothing"));
    assert.equal(await read(page), "antialiased");
    await toggle.click();
    assert.equal(await read(page), "auto");
    const other = await context.newPage();
    await other.goto(url("mac"));
    await other.getByTestId("font-smoothing-switch").waitFor();
    const sentBefore = await other.evaluate(() => window.sent);
    await toggle.click();
    await other.waitForFunction(() => window.store.getState().fontSmoothingEnabled === true);
    assert.equal(await read(other), "antialiased");
    assert.equal(await other.evaluate(() => window.sent), sentBefore);
    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await read(page), "antialiased");
    for (const width of [1200, 390])
      for (const theme of ["light", "dark"])
        for (const locale of ["zh-CN", "en-US"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(url("mac", theme, locale));
          await toggle.waitFor();
          assert.equal(await read(page), "antialiased");
          const row = page.locator('[data-settings-search-id="settings.fontSmoothing"]');
          await row.scrollIntoViewIfNeeded();
          assert.ok(await row.evaluate((e) => e.scrollWidth <= e.clientWidth));
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        }
    for (const platform of ["windows", "linux", "web"]) {
      await page.goto(url(platform));
      await page.locator('[data-settings-search-id="settings.uiFontSize"]').waitFor();
      assert.equal(await toggle.count(), 0);
      assert.equal(await read(page), "auto");
    }
    await page.goto(url("mac"));
    await toggle.waitFor();
    await toggle.click();
    await other.waitForFunction(() => window.store.getState().fontSmoothingEnabled === false);
    assert.equal(await read(other), "auto");
    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});

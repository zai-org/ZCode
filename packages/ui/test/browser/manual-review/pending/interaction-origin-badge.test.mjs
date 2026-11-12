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
const entry = join(root, "interaction-origin-preview.tsx");
const artifacts = join(root, "packages/desktop/.e2e-artifacts/interaction-origin-badge");
const fixture = `
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import "@/styles.css";
const query = new URLSearchParams(location.search);
const theme = query.get("theme");
document.documentElement.className = theme + " theme-zai-" + theme;
const locale = query.get("locale");
const descriptions = locale === "zh-CN"
 ? ["颜色规范检查员 (actor-color@1)", "负责检查全部页面与深浅主题颜色规范的检查员 (actor-color@12)", "检查员"]
 : ["Color reviewer (actor-color@1)", "Reviewer for all page colors and light and dark themes (actor-color@12)", "Reviewer"];
createRoot(document.getElementById("root")).render(<ZCodeIntlProvider initialLocale={locale}>
 <main style={{padding:16}} className="bg-background text-foreground">
 {descriptions.map(description => <section key={description} style={{marginBottom:12}} className="rounded-2xl border border-border bg-popover p-3">
 <div className="flex flex-wrap items-center gap-2">
 <p className="text-ui-base font-medium leading-tight text-foreground-subtle">{locale === "zh-CN" ? "需要权限" : "Permission required"}</p>
 <InteractionRequestOriginBadge origin={{kind:"subagent",agentType:"general-purpose",description}} />
 </div></section>)}
 </main>
</ZCodeIntlProvider>);
`;

test("来源标签：长名称完整换行、完整 title、深浅主题与窄屏", async () => {
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "interaction-origin-preview",
        resolveId(id) {
          if (id === "/interaction-origin-preview.tsx") return entry;
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
                '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/interaction-origin-preview.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": join(root, "packages/ui/src") } },
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
      ],
    },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const width of [640, 390])
      for (const theme of ["light", "dark"])
        for (const locale of ["zh-CN", "en-US"]) {
          const page = await browser.newPage({
            viewport: { width, height: 500 },
            deviceScaleFactor: 2,
          });
          page.on("pageerror", (error) => process.stderr.write(String(error) + "\n"));
          await page.goto(`${server.resolvedUrls.local[0]}fixture?theme=${theme}&locale=${locale}`);
          await page.locator("[data-interaction-origin-badge]").first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page
            .locator("main")
            .screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          const metrics = await page
            .locator("[data-interaction-origin-badge]")
            .evaluateAll((nodes) =>
              nodes.map((badge) => {
                const box = badge.getBoundingClientRect();
                const style = getComputedStyle(badge);
                const heading = badge.previousElementSibling.getBoundingClientRect();
                return {
                  title: badge.title,
                  label: badge.textContent,
                  right: box.right,
                  below: box.top >= heading.bottom,
                  clipped: badge.scrollWidth > badge.clientWidth,
                  lines: box.height / parseFloat(style.lineHeight),
                  border: style.borderTopWidth,
                };
              }),
            );
          for (const metric of metrics) {
            assert.equal(metric.below, true);
            assert.equal(metric.clipped, false);
            assert.equal(metric.border, "0px");
            assert.ok(metric.right <= width);
            assert.ok(metric.title.includes("general-purpose"));
          }
          if (width === 390) assert.ok(metrics[1].lines > 1);
          assert.ok(metrics[1].label.includes("actor-color@12"));
          await page.close();
        }
  } finally {
    await browser?.close();
    await server.close();
  }
});

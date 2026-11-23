import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/crash-restart.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/crash-restart-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "crash-restart-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const theme of ["light", "dark"]) {
  for (const locale of ["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"]) {
    test(`CR03 desktop ${theme} ${locale}`, async () => {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      try {
        await page.goto(`${origin}fixture?desktop=1&theme=${theme}&locale=${locale}`);
        const restart = page.getByTestId("app-error-restart");
        await restart.waitFor();
        assert.match(
          await page.locator('[role="alert"]').innerText(),
          /E2E_CRASH_RESTART_COMPONENT/,
        );
        await page.screenshot({ path: join(artifacts, `desktop-${theme}-${locale}.png`) });
        await restart.click();
        assert.equal(await page.locator("body").getAttribute("data-restart-count"), "1");
      } finally {
        await page.close();
      }
    });
  }
  test(`CR04 mobile web ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${origin}fixture?theme=${theme}&locale=en-US`);
      await page.getByRole("button", { name: "Reload app", exact: true }).waitFor();
      assert.equal(await page.getByTestId("app-error-restart").count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: join(artifacts, `mobile-${theme}.png`) });
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Reload app", exact: true }).click(),
      ]);
      assert.equal(await page.getByTestId("app-error-restart").count(), 0);
    } finally {
      await page.close();
    }
  });
}

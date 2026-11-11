import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

// 真实兜底 renderer：验证单卡片、分区复制、状态更新和窄屏布局。
test("fallback details layout and interaction", { timeout: 240000 }, async () => {
  const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
  const entry = "/packages/ui/test/browser/manual-review/pending/fallback-details.fixture.tsx";
  const artifacts = join(root, "packages/desktop/.e2e-artifacts/fallback-details");
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "fallback-details",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": join(root, "packages/ui/src") } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch(
      process.env.CHROME_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
        : { channel: "chrome" },
    );
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text) => {
            if (window.__copyFail) throw new Error("Clipboard denied");
            window.__copied.push(text);
          },
        },
      });
    });
    for (const width of [390, 1200])
      for (const theme of ["light", "dark"])
        for (const locale of ["zh-CN", "en-US"]) {
          await page.setViewportSize({ width, height: 950 });
          await page.goto(`${server.resolvedUrls.local[0]}fixture?theme=${theme}&locale=${locale}`);
          const simple = page.locator('[data-case="simple"]');
          await simple.locator("[aria-expanded]").click();
          await simple.locator("[data-fallback-details]").waitFor();
          assert.equal(await simple.locator("dl dt").first().innerText(), "session_id");
          assert.equal(await simple.locator("[data-fallback-section]").count(), 2);
          await simple.locator("[data-fallback-section] button").first().click();
          assert.deepEqual(JSON.parse(await page.evaluate(() => window.__copied.at(-1))), {
            session_id: "example-session",
            limit: 0,
            active: false,
          });
          assert.ok(!(await simple.innerText()).includes("internal-metadata"));
          await page.evaluate(() => {
            window.__copyFail = true;
          });
          await simple.locator("[data-fallback-section] button").last().click();
          await simple.locator('[role="status"]').waitFor();
          await page.evaluate(() => {
            window.__copyFail = false;
          });
          await simple.locator("[data-fallback-section] button").last().click();
          assert.equal(await page.evaluate(() => window.__copied.at(-1)), "Found 2 sessions");
          assert.equal(await simple.locator('[role="status"]').count(), 0);
          await simple.locator("[aria-expanded]").click();
          await simple.locator("[data-fallback-details]").waitFor({ state: "hidden" });
          await simple.locator("[aria-expanded]").click();
          await simple.locator("[data-fallback-details]").waitFor();
          for (const id of [
            "empty",
            "complex",
            "failed",
            "running",
            "zero",
            "false",
            "null",
            "blank",
            "absent",
            "long",
          ]) {
            const row = page.locator(`[data-case="${id}"]`);
            await row.locator("[aria-expanded]").click();
            await row.locator("[data-fallback-details]").waitFor();
          }
          assert.match(
            await page.locator('[data-case="empty"]').innerText(),
            locale === "en-US" ? /No parameters/ : /无参数/,
          );
          assert.equal(await page.locator('[data-case="complex"] pre').count(), 2);
          assert.match(await page.locator('[data-case="failed"]').innerText(), /Access denied/);
          assert.ok(
            !(await page.locator('[data-case="failed"]').innerText()).includes("STALE_SUCCESS"),
          );
          assert.match(
            await page.locator('[data-case="running"]').innerText(),
            locale === "en-US" ? /Waiting for result/ : /等待结果/,
          );
          await page.getByTestId("complete").click();
          await page
            .locator('[data-case="running"]')
            .getByText("Result arrived", { exact: true })
            .waitFor();
          for (const id of ["zero", "false", "null", "blank"]) {
            assert.equal(
              await page.locator(`[data-case="${id}"] [data-fallback-section] button`).count(),
              1,
            );
          }
          assert.equal(
            await page.locator('[data-case="absent"] [data-fallback-section] button').count(),
            0,
          );
          const long = page.locator('[data-case="long"] [data-fallback-scroll]').last();
          assert.ok(
            await long.evaluate(
              (el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 240,
            ),
          );
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await simple.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

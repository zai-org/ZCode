import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

// 真实 AgentToolCallBlock：占位身份不按翻译取色，等待状态替换重复摘要，且仅显示一次。
test("agent placeholder color and pending summary", { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
  const entry = "/packages/ui/test/browser/manual-review/pending/agent-placeholder.fixture.tsx";
  const artifacts = join(root, "packages/desktop/.e2e-artifacts/agent-placeholder");
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "agent-placeholder",
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
    for (const width of [390, 1200])
      for (const theme of ["light", "dark"])
        for (const locale of ["zh-CN", "en-US"]) {
          await page.setViewportSize({ width, height: 300 });
          await page.goto(`${server.resolvedUrls.local[0]}fixture?theme=${theme}&locale=${locale}`);
          const row = page.locator('[data-case="placeholder"]');
          await row.locator("svg").first().waitFor();
          const name = locale === "en-US" ? "SubAgent" : "子智能体";
          const pending = locale === "en-US" ? "Pending" : "等待中";
          assert.equal((await row.innerText()).replace(/\s+/g, " ").trim(), `${name} ${pending}`);
          // 状态占用原摘要的次级文字位置，不留在末尾状态槽。
          assert.equal(
            await row.locator(".text-foreground-subtlest").filter({ hasText: pending }).count(),
            1,
          );
          const colors = await row.evaluate((element) => {
            const rootStyle = getComputedStyle(document.documentElement);
            const probe = document.createElement("span");
            probe.style.color = rootStyle.getPropertyValue("--color-foreground-subtle");
            element.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return { actual: getComputedStyle(element.querySelector("rect")).fill, expected };
          });
          assert.equal(colors.actual, colors.expected);
          assert.match(
            await page.locator('[data-case="named"]').innerText(),
            /Inspect directory structure/,
          );
          assert.equal(
            await page
              .locator('[data-case="configured"] rect')
              .first()
              .evaluate((el) => getComputedStyle(el).fill),
            "rgb(234, 64, 69)",
          );
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});

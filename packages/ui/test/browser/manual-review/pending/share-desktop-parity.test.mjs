// SHARE-PARITY：同一份公开投影 Rows 在 App 时间线与分享只读时间线的逐组件展示对照。
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
const entry = "/packages/ui/test/browser/manual-review/pending/share-desktop-parity.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/share-desktop-parity");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-share-desktop-parity"),
    plugins: [
      {
        name: "share-desktop-parity-fixture",
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
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
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

/** 只读页没有操作栏和 data-testid，对照只比可见文案与几何，不比 DOM 结构。 */
async function snapshot(column) {
  return column.evaluate((element) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.height > 0;
    };
    const texts = (selector) =>
      [...element.querySelectorAll(selector)]
        .filter(visible)
        .map((node) => node.textContent.replace(/\s+/g, " ").trim());
    return {
      historyStatus: texts(".group\\/history-message"),
      groups: texts("[data-summary-group-statistics]"),
      tools: texts(".tool-summary-content"),
      emptyHistory: [...element.querySelectorAll('[data-history-open="true"]:not(button)')].filter(
        (node) => node.textContent.trim() === "",
      ).length,
      markers: [...element.querySelectorAll("[data-marker-type]")].map((node) => ({
        type: node.getAttribute("data-marker-type"),
        text: node.textContent.replace(/\s+/g, " ").trim(),
        icon: node.querySelector("svg") !== null,
      })),
    };
  });
}

for (const theme of ["light", "dark"])
  for (const locale of ["zh-CN", "en-US"])
    test(`SHARE-PARITY ${theme}/${locale}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => message.type() === "error" && console.error(message.text()));
      try {
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
        const desktop = page.locator('[data-parity-column="desktop"]');
        const share = page.locator('[data-parity-column="share"]');
        await desktop.locator("[data-turn-id]").first().waitFor();
        await share.locator("[data-conversation-share-turn]").first().waitFor();
        await page.screenshot({ path: join(artifacts, `${theme}-${locale}.png`), fullPage: true });
        const collapsed = [await snapshot(desktop), await snapshot(share)];
        // 展开外层过程与内部工具分组，继续对照组内统计与工具行。
        for (const column of [desktop, share]) {
          const closed = column.locator('button[data-history-open="false"]');
          while ((await closed.count()) > 0) await closed.first().click();
          for (const trigger of await column
            .locator('[data-summary-group-trigger][aria-expanded="false"]')
            .all())
            await trigger.click();
        }
        await page.waitForTimeout(400);
        await page.screenshot({
          path: join(artifacts, `${theme}-${locale}-expanded.png`),
          fullPage: true,
        });
        const expanded = [await snapshot(desktop), await snapshot(share)];
        console.log(JSON.stringify({ collapsed, expanded }));
        assert.deepEqual(collapsed[1], collapsed[0]);
        assert.deepEqual(expanded[1], expanded[0]);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });

// 手机宽度：两列各约 380px，用户气泡宽度必须随容器收缩且两端一致。
test("SHARE-PARITY narrow bubble width", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 2400 } });
  try {
    await page.goto(`${origin}fixture?theme=light&locale=zh-CN`);
    await page.locator("[data-conversation-share-turn]").first().waitFor();
    const widths = await page.evaluate(() =>
      ["desktop", "share"].map((column) =>
        [
          ...document.querySelectorAll(
            `[data-parity-column="${column}"] [data-v4-user-input-bubble]`,
          ),
        ].map((node) => Math.round(node.getBoundingClientRect().width)),
      ),
    );
    await page.screenshot({ path: join(artifacts, "narrow.png"), fullPage: true });
    assert.deepEqual(widths[1], widths[0]);
  } finally {
    await page.close();
  }
});

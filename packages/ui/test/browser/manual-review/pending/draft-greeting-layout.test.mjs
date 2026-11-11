import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/draft-greeting-layout.fixture.tsx";
const artifacts =
  process.env.ZCODE_E2E_ARTIFACT_DIR ??
  join(root, "packages/desktop/.e2e-artifacts/draft-greeting-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "draft-greeting-fixture",
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
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
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

for (const theme of ["light", "dark"])
  for (const locale of ["zh-CN", "en-US"]) {
    test(`DGJ02 desktop ${theme}/${locale}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
      const errors = [],
        logs = [],
        evidence = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.text().includes("v4-draft-greeting")) logs.push(message.text());
      });
      try {
        await page.clock.setFixedTime(new Date("2026-11-03T14:50:00"));
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
        await page.locator("[data-v4-draft-greeting]").waitFor();
        await page.evaluate(() => {
          window.__greetingErrors = [];
          window.addEventListener("error", (event) => window.__greetingErrors.push(event.message));
          return document.fonts.ready;
        });
        for (const mode of ["instant", "continuous", "reverse"]) {
          const samples = await page.evaluate(async (mode) => {
            const column = document.querySelector('[data-testid="greeting-column"]');
            const title = document.querySelector("[data-v4-draft-greeting]");
            const input = document.querySelector('[data-testid="following-input"]');
            const range = document.createRange();
            range.selectNodeContents(title.querySelector('[aria-hidden="true"]'));
            const natural = range.getBoundingClientRect().width;
            const target = natural * 0.85 + 32;
            const samples = [];
            // Observer 在组件的 observer 之后注册：记录本次绘制前已完成字号适配的几何。
            // RAF 在 ResizeObserver 之前执行，不能将 RAF 内强制布局误当成已显示的帧。
            const observer = new ResizeObserver(() => {
              const style = getComputedStyle(title),
                rect = title.getBoundingClientRect();
              samples.push({
                width: rect.width,
                height: rect.height,
                lineHeight: parseFloat(style.lineHeight),
                font: parseFloat(style.fontSize),
                top: input.getBoundingClientRect().top,
              });
            });
            observer.observe(title);
            observer.observe(input);
            const frame = () => new Promise(requestAnimationFrame);
            for (let i = 0; i < 28; i++) {
              await frame();
              const progress = mode === "instant" ? 1 : Math.min(1, i / 12);
              column.style.width = `${672 + (target - 672) * (mode === "reverse" && i > 12 ? 0 : progress)}px`;
            }
            column.style.width = "672px";
            await frame();
            await frame();
            await frame();
            observer.disconnect();
            return samples;
          }, mode);
          evidence.push({ mode, samples });
        }
        // 纯布局字号不能被无关的父组件 render 恢复成初始值。
        await page.locator('[data-testid="greeting-column"]').evaluate((column) => {
          const range = document.createRange();
          range.selectNodeContents(
            column.querySelector('[data-v4-draft-greeting] [aria-hidden="true"]'),
          );
          const natural = range.getBoundingClientRect().width;
          column.style.width = `${natural * 0.85 + 32}px`;
        });
        await page.waitForFunction(
          () =>
            parseFloat(
              getComputedStyle(document.querySelector("[data-v4-draft-greeting]")).fontSize,
            ) < 30,
        );
        const fittedFont = await page
          .locator("[data-v4-draft-greeting]")
          .evaluate((title) => getComputedStyle(title).fontSize);
        await page.getByRole("button", { name: "Render parent" }).click();
        assert.equal(
          await page
            .locator("[data-v4-draft-greeting]")
            .evaluate((title) => getComputedStyle(title).fontSize),
          fittedFont,
        );
        await page.locator('[data-testid="greeting-column"]').evaluate((column) => {
          column.style.width = "672px";
        });
        await page.getByRole("button", { name: "Switch language" }).click();
        await page.waitForFunction(
          () =>
            parseFloat(
              getComputedStyle(document.querySelector("[data-v4-draft-greeting]")).fontSize,
            ) === 30,
        );
        await page.screenshot({ path: join(artifacts, `desktop-${theme}-${locale}.png`) });
        await writeFile(
          join(artifacts, `desktop-${theme}-${locale}.json`),
          JSON.stringify({ evidence, errors, logs }, null, 2),
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.__greetingErrors), []);
        for (const { mode, samples } of evidence) {
          assert.ok(samples.length > 1, `${mode}: missing resize evidence`);
          assert.ok(
            samples.some((sample) => sample.font < 30),
            `${mode}: did not exercise font fitting`,
          );
          assert.ok(
            samples.every((sample) => sample.height <= sample.lineHeight + 1),
            `${mode}: transient wrapping: ${JSON.stringify(samples)}`,
          );
          assert.ok(
            Math.max(...samples.map((sample) => sample.top)) -
              Math.min(...samples.map((sample) => sample.top)) <=
              7,
            `${mode}: sibling pushed down by an extra line`,
          );
          assert.equal(samples.at(-1).font, 30);
        }
      } finally {
        await page.close();
      }
    });

    test(`DGJ03 mobile ${theme}/${locale}`, async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        await page.clock.setFixedTime(new Date("2026-11-03T14:50:00"));
        await page.goto(`${origin}fixture?compact&theme=${theme}&locale=${locale}`);
        await page.locator("[data-v4-draft-greeting]").waitFor();
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          const layout = await page.locator("[data-v4-draft-greeting]").evaluate((title) => {
            const range = document.createRange();
            range.selectNodeContents(title.lastElementChild);
            const bounds = title.getBoundingClientRect();
            return {
              font: getComputedStyle(title).fontSize,
              fits: Array.from(range.getClientRects()).every(
                (rect) => rect.left >= bounds.left && rect.right <= bounds.right,
              ),
              text: title.lastElementChild.textContent,
            };
          });
          assert.equal(layout.font, "20px");
          assert.ok(layout.fits);
          assert.ok(layout.text.length > 10);
          await page.screenshot({
            path: join(artifacts, `mobile-${width}-${theme}-${locale}.png`),
          });
        }
      } finally {
        await page.close();
      }
    });
  }

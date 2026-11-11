// TN11：真实 timeline / virtualizer 的入场、分页后挂载与 hit area；不替换产品动画。
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
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-navigator-performance.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/conversation-navigator-entrance");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "navigator-entrance-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)], include: ["streamdown"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
const settle = (page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });

for (const theme of ["light", "dark"]) {
  test(
    `TN11 ${theme}: entrance moves right, keeps hit areas and does not replay on updates`,
    { timeout: 90000 },
    async () => {
      const page = await browser.newPage({
        viewport: { width: 1250, height: 850 },
        reducedMotion: "no-preference",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.addInitScript(() => {
        window.__entrances = [];
        document.addEventListener("animationstart", (event) => {
          if (event.animationName !== "zcode-turn-navigator-enter") return;
          const node = event.target;
          const animation = node
            .getAnimations()
            .find((item) => item.animationName === event.animationName);
          if (!animation) return;
          animation.pause();
          animation.currentTime = 0;
          window.__entrances.push({
            node,
            animation,
            rowId: node.closest("button").dataset.queryRowId,
          });
        });
      });
      try {
        await page.goto(`${origin}fixture?theme=${theme}&entrance=true`);
        await page.waitForFunction(() => window.__entrances.length === 2, null, { timeout: 10000 });
        const evidence = await page.evaluate(() => {
          const { node, animation } = window.__entrances[0];
          const button = node.closest("button");
          const sample = (time) => {
            animation.currentTime = time;
            return {
              x: node.getBoundingClientRect().x,
              opacity: Number(getComputedStyle(node).opacity),
              hit: button.getBoundingClientRect().toJSON(),
            };
          };
          const duration = Number(animation.effect.getTiming().duration);
          return {
            start: sample(0),
            middle: sample(duration / 2),
            end: sample(duration),
            duration,
            delays: window.__entrances.map(({ animation }) => animation.effect.getTiming().delay),
          };
        });
        assert.equal(evidence.duration, 180);
        assert.deepEqual(evidence.delays, [0, 0]);
        assert.ok(evidence.start.x < evidence.middle.x && evidence.middle.x < evidence.end.x);
        assert.equal(evidence.start.opacity, 0);
        assert.ok(evidence.middle.opacity > 0 && evidence.middle.opacity < 1);
        assert.equal(evidence.end.opacity, 1);
        assert.deepEqual(evidence.start.hit, evidence.end.hit);
        await page.evaluate(() =>
          window.__entrances.forEach(({ animation }) => (animation.currentTime = 90)),
        );
        await page.screenshot({ path: join(artifacts, `${theme}-mid-entry.png`) });
        // 动画尚未结束时仍可通过原按钮命中；不以动画完成作为交互前置条件。
        const bar = page.locator('[data-query-row-id="782"]');
        await bar.hover();
        await page.waitForFunction(
          () => document.querySelector('[data-query-row-id="782"]')?.dataset.visualTone === "peak",
        );
        await page.locator('[data-testid^="v4-turn-navigator-tooltip-"]').first().waitFor();
        await bar.click();
        await page.waitForFunction(
          () => document.querySelector('[data-query-row-id="782"]')?.dataset.active === "true",
        );
        await page.mouse.move(1000, 10);
        await page.evaluate(() => {
          window.__entrances.forEach(({ animation }) => animation.finish());
          window.__entrances = [];
          window.__retainedBars = new Set(document.querySelectorAll(".zcode-turn-navigator-enter"));
          window.__navigatorPerf.hydrate();
        });
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="v4-turn-navigator"]')?.dataset.itemCount === "82",
        );
        await settle(page);
        const added = await page.evaluate(() => window.__entrances.map(({ rowId }) => rowId));
        assert.ok(added.length > 0, "History hydration must animate newly mounted bars");
        assert.equal(
          await page.evaluate(() =>
            window.__entrances.some(({ node }) => window.__retainedBars.has(node)),
          ),
          false,
          "Retained DOM bars must not replay; virtualizer remounts are new entries",
        );
        await page.evaluate(() => {
          window.__entrances.forEach(({ animation }) => animation.finish());
          window.__entrances = [];
          window.__navigatorPerf.stream();
        });
        await settle(page);
        assert.equal(
          await page.evaluate(() => window.__entrances.length),
          0,
          "Text updates must not replay entry",
        );
        await page.screenshot({ path: join(artifacts, `${theme}-complete.png`) });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.reload();
        await page.getByTestId("v4-turn-navigator").waitFor();
        await settle(page);
        assert.equal(await page.evaluate(() => window.__entrances.length), 0);
        assert.equal(
          await page
            .locator('[data-query-row-id="782"] > span')
            .evaluate((node) => getComputedStyle(node).animationName),
          "none",
        );
        await page.evaluate(() => window.__navigatorPerf.hydrate());
        await settle(page);
        assert.equal(await page.evaluate(() => window.__entrances.length), 0);
        await writeFile(
          join(artifacts, `${theme}.json`),
          JSON.stringify({ ...evidence, hydratedEntrances: added.length, errors }, null, 2),
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    },
  );
  test(`TN11 ${theme}: mobile retains hidden navigator`, { timeout: 60000 }, async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.goto(`${origin}fixture?theme=${theme}&entrance=true&mobile=true`);
      await page.getByTestId("v4-timeline").waitFor();
      await settle(page);
      await page.evaluate(() => window.__navigatorPerf.hydrate());
      await settle(page);
      assert.equal(await page.getByTestId("v4-turn-navigator").isVisible(), false);
      assert.equal(
        await page.getByTestId("v4-timeline").getAttribute("data-window-row-count"),
        "244",
      );
      await page.screenshot({ path: join(artifacts, `${theme}-mobile.png`) });
    } finally {
      await page.close();
    }
  });
}

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/conversation-drop-owner.fixture.tsx";
const artifacts = `${root}packages/desktop/.e2e-artifacts/renderer-retention-20261104/drop-owner`;
let server, browser;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      {
        name: "drop-owner-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url !== "/fixture") return next();
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
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
for (const mobile of [false, true])
  test(`SPR06 current drop owner / ${mobile ? "mobile" : "desktop"}`, async () => {
    const page = await browser.newPage({
      viewport: { width: mobile ? 390 : 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${server.resolvedUrls.local[0]}fixture`);
      const header = page.getByTestId("header"),
        pane = page.getByTestId("pane");
      const check = async (kind) => {
        await page.waitForFunction(
          (kind) => document.querySelector('[data-testid="header"]').textContent === kind,
          kind,
        );
        assert.equal(await pane.textContent(), kind);
      };
      await check("attachment");
      await header.dispatchEvent("drop");
      assert.equal(await page.locator("output").textContent(), "A:drop");
      await page.getByRole("button", { name: "Mount B", exact: true }).click();
      await check("workspace");
      // B 已注册后再执行旧 A 的 cleanup，验证两级转发都不能丢失新 owner。
      await page.getByRole("button", { name: "Unmount A", exact: true }).click();
      await check("workspace");
      await header.dispatchEvent("drop");
      assert.equal(await page.locator("output").textContent(), "B:drop");
      await pane.dispatchEvent("drop");
      assert.equal(await page.locator("output").textContent(), "B:drop");
      await page.getByRole("button", { name: "Unmount B", exact: true }).click();
      await check("none");
      await page.getByRole("button", { name: "Toggle pane" }).click();
      await page.getByRole("button", { name: "Toggle pane" }).click();
      await check("attachment");
      await header.dispatchEvent("drop");
      assert.equal(await page.locator("output").textContent(), "A:drop");
      assert.deepEqual(errors, []);
      await writeFile(
        `${artifacts}/${mobile ? "mobile" : "desktop"}.json`,
        JSON.stringify(
          {
            passed: true,
            errors,
            scenarios: [
              "StrictMode",
              "owner replacement",
              "stale cleanup",
              "current header/pane forwarding",
              "unmount/remount",
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      await page.close();
    }
  });

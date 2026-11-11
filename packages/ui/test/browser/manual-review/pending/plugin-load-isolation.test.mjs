import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-load-isolation.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/plugin-load-isolation-context");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "plugin-load-isolation-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
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

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [1200, "zh-CN", "dark"],
  [390, "zh-CN", "light"],
  [390, "en-US", "dark"],
]) {
  for (const failure of ["list", "overview", "both"]) {
    test(`plugin load ${failure} ${width}/${locale}/${theme}`, { timeout: 60000 }, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const logs = [],
        errors = [];
      page.on("console", (message) => logs.push(message.text()));
      page.on("pageerror", (error) => errors.push(error.message));
      const label = `${failure}-${width}-${locale}-${theme}`;
      const readState = async () => JSON.parse(await page.getByTestId("state").textContent());
      try {
        await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}&failure=${failure}`);
        await page.getByTestId("recover").waitFor();
        const state = await readState();
        assert.deepEqual(state.calls, { list: 1, overview: 1 });
        assert.equal(state.plugins, failure === "overview" ? 1 : 0);
        assert.equal(state.marketplaces, failure === "list" ? 1 : 0);
        assert.equal(state.available, failure === "list" ? 1 : 0);
        assert.equal(state.known, failure === "list");
        assert.equal(state.orphaned, false);
        await page.getByRole("alert").waitFor();
        await page.screenshot({ path: join(artifacts, `${label}-partial.png`) });
        await page.getByTestId("recover").click();
        await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
        const recovered = await readState();
        assert.equal(recovered.plugins, 1);
        assert.equal(recovered.marketplaces, 1);
        assert.equal(recovered.available, 1);
        assert.deepEqual(recovered.calls, { list: 2, overview: 2 });
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(artifacts, `${label}-recovered.png`) });
      } finally {
        await writeFile(join(artifacts, `${label}.log`), [...logs, ...errors].join("\n"));
        await page.close();
      }
    });
  }
}

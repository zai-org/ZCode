import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/data-sync-minimize.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/data-sync-minimize-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "data-sync-minimize-fixture",
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
      watch: null,
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

async function start(theme, locale, width, all = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(60_000);
  const errors = [],
    logs = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => logs.push(message.text()));
  await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
  await page.getByTestId("fixture-open").click();
  await page.getByTestId("remote-sync-row-minimize-skill").waitFor();
  if (all) await page.getByTestId("remote-sync-tab-overview").click();
  await page.getByTestId(all ? "remote-sync-push-all" : "remote-sync-push").click();
  await page.waitForFunction(() => window.syncFixture.events.includes("import-start"));
  return { page, errors, logs };
}

for (const theme of ["light", "dark"]) {
  for (const locale of ["zh-CN", "en-US"]) {
    for (const width of [1440, 480]) {
      test(`DSYNC-MIN-01 ${theme}/${locale}/${width}: push survives minimize and entry unmount`, async () => {
        const { page, errors, logs } = await start(theme, locale, width);
        try {
          const dialog = page.getByTestId("remote-sync-dialog");
          await page.keyboard.press("Escape");
          assert.equal(await dialog.isVisible(), true);
          await page.screenshot({
            path: join(artifacts, `expanded-${theme}-${locale}-${width}.png`),
          });
          await page.getByTestId("remote-sync-minimize").click();
          await dialog.waitFor({ state: "hidden" });
          await page.getByTestId("fixture-navigate").click();
          await page.getByTestId("fixture-other-page").waitFor();
          await page.screenshot({
            path: join(artifacts, `minimized-${theme}-${locale}-${width}.png`),
          });
          await page.getByTestId("remote-sync-minimized").click();
          await dialog.waitFor();
          assert.equal(
            await page.getByTestId("remote-sync-tab-skills").getAttribute("aria-current"),
            "page",
          );
          assert.equal(await page.getByTestId("remote-sync-push").isDisabled(), true);
          await page.getByTestId("remote-sync-minimize").click();
          await dialog.waitFor({ state: "hidden" });
          await page.evaluate(() => window.syncFixture.finish());
          await page.waitForFunction(() => window.syncFixture.events.includes("result:success"));
          assert.equal(await dialog.isVisible(), false);
          await page.getByTestId("remote-sync-minimized").click();
          assert.equal(
            await page
              .getByTestId("remote-sync-row-minimize-skill")
              .getAttribute("data-sync-status"),
            "synced",
          );
          assert.deepEqual(await page.evaluate(() => window.syncFixture.events), [
            "import-start",
            "import-finish",
            "result:success",
          ]);
          await dialog.locator('[data-slot="dialog-close"]').click();
          await dialog.waitFor({ state: "hidden" });
          assert.equal(await page.getByTestId("remote-sync-minimized").count(), 0);
          assert.deepEqual(errors, []);
        } finally {
          await writeFile(
            join(artifacts, `console-${theme}-${locale}-${width}.json`),
            JSON.stringify({ errors, logs }, null, 2),
          );
          await page.close();
        }
      });
    }
  }
}
test("DSYNC-MIN-02: disconnect while minimized records failure once and ignores late import", async () => {
  const { page, errors, logs } = await start("light", "zh-CN", 1440);
  try {
    await page.getByTestId("remote-sync-minimize").click();
    await page.getByTestId("fixture-navigate").click();
    await page.evaluate(() => window.syncFixture.disconnect());
    await page.waitForFunction(() => window.syncFixture.events.includes("result:failed"));
    await page.evaluate(() => window.syncFixture.finish());
    await page.getByTestId("remote-sync-minimized").click();
    await page.getByTestId("remote-sync-offline").waitFor();
    assert.equal(await page.getByTestId("remote-sync-push").isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.syncFixture.events), [
      "import-start",
      "result:failed",
      "import-finish",
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(
      join(artifacts, "console-disconnect.json"),
      JSON.stringify({ errors, logs }, null, 2),
    );
    await page.close();
  }
});

test("DSYNC-MIN-03: push all resumes through an entry without starting a second import", async () => {
  const { page, errors, logs } = await start("dark", "en-US", 1440, true);
  try {
    await page.getByTestId("remote-sync-minimize").click();
    await page.getByTestId("remote-sync-dialog").waitFor({ state: "hidden" });
    await page.getByTestId("fixture-open").click();
    assert.equal(
      await page.getByTestId("remote-sync-tab-overview").getAttribute("aria-current"),
      "page",
    );
    assert.equal(await page.getByTestId("remote-sync-push-all").isDisabled(), true);
    await page.getByTestId("remote-sync-minimize").click();
    await page.getByTestId("remote-sync-dialog").waitFor({ state: "hidden" });
    await page.evaluate(() => window.syncFixture.finish());
    await page.waitForFunction(() => window.syncFixture.events.includes("entry-refresh"));
    assert.deepEqual(await page.evaluate(() => window.syncFixture.events), [
      "import-start",
      "import-finish",
      "result:success",
      "entry-refresh",
    ]);
    await page.getByTestId("remote-sync-minimized").click();
    assert.equal(await page.getByTestId("remote-sync-push-all").innerText(), "All synced");
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(
      join(artifacts, "console-push-all.json"),
      JSON.stringify({ errors, logs }, null, 2),
    );
    await page.close();
  }
});

// 发起入口卸载后重新挂载（例如切走设置分类再回来）：推送结束时新挂载的页面要刷新一次。
test("DSYNC-MIN-06: a remounted entry page refreshes once when the push finishes", async () => {
  const { page, errors, logs } = await start("light", "zh-CN", 1440);
  try {
    await page.getByTestId("remote-sync-minimize").click();
    await page.getByTestId("remote-sync-dialog").waitFor({ state: "hidden" });
    await page.getByTestId("fixture-navigate").click();
    await page.getByTestId("fixture-other-page").waitFor();
    await page.getByTestId("fixture-navigate").click();
    await page.getByTestId("fixture-open").waitFor();
    await page.evaluate(() => window.syncFixture.finish());
    await page.waitForFunction(() => window.syncFixture.events.includes("result:success"));
    await page.waitForFunction(() => window.syncFixture.events.includes("entry-refresh"), null, {
      timeout: 5_000,
    });
    assert.deepEqual(await page.evaluate(() => window.syncFixture.events), [
      "import-start",
      "import-finish",
      "result:success",
      "entry-refresh",
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(
      join(artifacts, "console-remount.json"),
      JSON.stringify({ errors, logs }, null, 2),
    );
    await page.close();
  }
});

test("DSYNC-MIN-04: Web without a sync host still renders settings and exposes no sync action", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?platform=web&locale=en-US&theme=light`);
    await page.getByTestId("fixture-open").waitFor();
    assert.equal(await page.getByTestId("fixture-open").isDisabled(), true);
    assert.equal(await page.getByTestId("remote-sync-dialog").count(), 0);
    assert.equal(await page.getByTestId("remote-sync-minimized").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

for (const locale of ["zh-CN", "en-US"]) {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 480]) {
      test(`DSYNC-MIN-05 ${locale}/${theme}/${width}: sibling progress remains visible until the batch ends`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(`${origin}fixture?scenario=sibling&locale=${locale}&theme=${theme}`);
          await page.getByTestId("fixture-open").click();
          await page.getByTestId("remote-sync-tab-overview").click();
          await page.getByTestId("remote-sync-push-all").click();
          await page.waitForFunction(() => window.syncFixture.events.includes("import-start"));
          const progress = page.getByTestId("remote-sync-progress");
          const label = locale === "zh-CN" ? "正在同步插件…" : "Syncing Plugins…";
          for (const tab of ["subagents", "skills", "plugins", "providers", "overview"]) {
            await page.getByTestId(`remote-sync-tab-${tab}`).click();
            await progress.waitFor();
            assert.equal(await progress.innerText(), label);
            if (tab === "providers") continue;
            const button = page.getByTestId(
              tab === "overview" ? "remote-sync-push-all" : "remote-sync-push",
            );
            assert.equal(await button.isDisabled(), true);
            assert.match(await button.innerText(), locale === "zh-CN" ? /同步中/ : /Syncing/);
          }
          await page.getByTestId("remote-sync-tab-subagents").click();
          assert.match(
            await page.getByTestId("remote-sync-dialog").innerText(),
            /subagent is missing from the sync payload/,
          );
          await page.getByTestId("remote-sync-minimize").click();
          await page.getByTestId("remote-sync-dialog").waitFor({ state: "hidden" });
          await page.getByTestId("remote-sync-minimized").click();
          assert.equal(await progress.innerText(), label);
          await page.screenshot({
            path: join(artifacts, `sibling-${locale}-${theme}-${width}.png`),
            animations: "disabled",
          });
          await page.evaluate(() => window.syncFixture.finish());
          await page.waitForFunction(() => window.syncFixture.events.includes("result:partial"));
          assert.equal(await progress.count(), 0);
          const retry = page.getByTestId("remote-sync-push");
          assert.equal(await retry.isDisabled(), false);
          assert.equal(await retry.innerText(), locale === "zh-CN" ? "再次同步" : "Sync again");
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  }
}

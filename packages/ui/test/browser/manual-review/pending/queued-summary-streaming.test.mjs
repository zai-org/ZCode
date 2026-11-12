import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const artifacts =
  process.env.ZCODE_SUMMARY_ARTIFACT_DIR ??
  join(root, "packages/desktop/.e2e-artifacts/queued-summary-streaming");
let server, browser;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(artifacts, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/summary-fixture.tsx"></script>',
  );
  const source = root + "packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx";
  const baseline = process.env.ZCODE_SUMMARY_BASELINE_REF
    ? (
        await promisify(execFile)(
          "git",
          [
            "show",
            process.env.ZCODE_SUMMARY_BASELINE_REF +
              ":packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx",
          ],
          { cwd: root },
        )
      ).stdout
    : null;
  await build({
    configFile: false,
    root: artifacts,
    base: "./",
    logLevel: "warn",
    plugins: [
      { name: "summary-baseline", enforce: "pre", load: (id) => (id === source ? baseline : null) },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": root + "packages/ui/src",
        "/summary-fixture.tsx":
          root +
          "packages/ui/test/browser/manual-review/pending/queued-summary-streaming.fixture.tsx",
      },
    },
    build: {
      outDir: join(artifacts, "out"),
      emptyOutDir: true,
      minify: false,
      chunkSizeWarningLimit: 5000,
    },
  });
  server = await preview({
    configFile: false,
    root: artifacts,
    build: { outDir: join(artifacts, "out") },
    preview: { host: "127.0.0.1", port: 0 },
  });
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
async function openPage(options, query = "") {
  const page = await browser.newPage({
    viewport: { width: options.width, height: 850 },
    reducedMotion: "no-preference",
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(
    `${server.resolvedUrls.local[0]}?theme=${options.theme}&locale=${options.locale}&${query}`,
  );
  await page.locator("[data-summary-fixture]").waitFor();
  return { page, errors };
}
async function update(page, patch) {
  await page.evaluate((value) => window.summaryFixture.update(value), patch);
}
async function textIs(page, text) {
  await page.waitForFunction(
    (value) => document.querySelector("[data-summary-fixture]")?.textContent.includes(value),
    text,
  );
}
for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    const options = { width, theme, locale: theme === "light" ? "en-US" : "zh-CN" };
    for (const mode of ["reasoning", "group"]) {
      test(`XSG03 stream ${mode} ${width}/${theme}`, async () => {
        const { page, errors } = await openPage(options, `${mode}=1`);
        try {
          await page.locator("[data-reasoning-streaming-text]").waitFor();
          await page.evaluate(() => {
            window.originalTextNode = document.querySelector("[data-reasoning-streaming-text]");
          });
          await page.evaluate(() => window.summaryFixture.burst());
          await textIs(page, "A token 200");
          assert.equal(
            await page.evaluate(
              () =>
                window.originalTextNode ===
                document.querySelector("[data-reasoning-streaming-text]"),
            ),
            true,
          );
          await page.screenshot({ path: join(artifacts, `stream-${mode}-${width}-${theme}.png`) });
          const viewport = page.locator("[data-reasoning-streaming-line]");
          assert.equal(await viewport.getAttribute("data-reasoning-streaming-mask"), "both");
          const scroll = await viewport.evaluate((node) => ({
            left: node.scrollLeft,
            remaining: node.scrollWidth - node.clientWidth - node.scrollLeft,
          }));
          assert.ok(scroll.left > 0 && scroll.remaining <= 2);
          await update(page, { text: "Short" });
          await page.waitForFunction(
            () =>
              document
                .querySelector("[data-reasoning-streaming-line]")
                ?.getAttribute("data-reasoning-streaming-mask") === "none",
          );
          await update(page, { text: "Short\nNext reasoning line" });
          await textIs(page, "Next reasoning line");
          await update(page, { streaming: false });
          await page.waitForFunction(
            () => !document.querySelector("[data-reasoning-streaming-text]"),
          );
          assert.match(await page.locator("[data-reasoning-label]").textContent(), /Thought|思考/);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
    test(`XSG03 queue and animation ${width}/${theme}`, async () => {
      const { page, errors } = await openPage(options);
      try {
        await page.locator("[data-primary]").waitFor();
        await page.evaluate(() => {
          window.originalTextNode = document.querySelector("[data-primary]");
        });
        await page.evaluate(() => window.summaryFixture.burst());
        await textIs(page, "A token 200");
        assert.equal(
          await page.evaluate(
            () => window.originalTextNode === document.querySelector("[data-primary]"),
          ),
          true,
        );
        assert.equal(await page.locator("[data-secondary]").textContent(), "secondary 200");
        assert.equal(await page.locator("[data-trailing]").textContent(), "+200");
        await update(page, { key: "B", text: "B initial" });
        await textIs(page, "B initial");
        // 采集真实运动样式，而非仅检查 motion 类名或 key。
        const frames = await page.evaluate(async () => {
          const samples = [];
          for (let i = 0; i < 8; i++) {
            await new Promise(requestAnimationFrame);
            const nodes = [...document.querySelectorAll("[data-primary]")];
            samples.push(
              nodes.map((node) => ({
                text: node.textContent,
                transform: getComputedStyle(node.parentElement).transform,
                opacity: getComputedStyle(node.parentElement).opacity,
              })),
            );
          }
          return samples;
        });
        await writeFile(
          join(artifacts, `animation-${width}-${theme}.json`),
          JSON.stringify(frames, null, 2),
        );
        assert.ok(
          frames.flat().some((frame) => frame.text === "B initial" && Number(frame.opacity) < 1),
        );
        assert.ok(frames.flat().some((frame) => frame.text.endsWith("A token 200")));
        const incomingTransforms = frames
          .flat()
          .filter((frame) => frame.text === "B initial")
          .map((frame) => frame.transform);
        assert.ok(new Set(incomingTransforms).size > 1, "new summary must move vertically");
        assert.ok(
          frames
            .flat()
            .some(
              (frame) => frame.text.endsWith("A token 200") && /, -[\d.]+\)$/.test(frame.transform),
            ),
          "previous summary must exit upward",
        );
        await update(page, { text: "B latest", trailing: "+201" });
        await textIs(page, "B latest");
        await page.evaluate(() => {
          window.summarySeen = [];
          window.summaryObserver = new MutationObserver(() =>
            window.summarySeen.push(document.querySelector("[data-summary-fixture]")?.textContent),
          );
          window.summaryObserver.observe(document.querySelector("[data-summary-fixture]"), {
            childList: true,
            subtree: true,
            characterData: true,
          });
        });
        await update(page, { key: "C", text: "C initial", trailing: "+202" });
        await update(page, { text: "C latest", trailing: "+203" });
        await update(page, { key: "D", text: "D skipped" });
        await update(page, { key: "E", text: "E latest", trailing: "+205" });
        assert.match(await page.locator("[data-summary-fixture]").textContent(), /B latest/);
        assert.equal(await page.locator("[data-trailing]").textContent(), "+201");
        await textIs(page, "C latest");
        assert.equal(await page.locator("[data-trailing]").textContent(), "+203");
        await textIs(page, "E latest");
        await page.waitForFunction(() => document.querySelectorAll("[data-primary]").length === 1);
        assert.equal(await page.locator("[data-primary]").textContent(), "E latest");
        assert.equal(await page.locator("[data-trailing]").textContent(), "+205");
        assert.equal(
          await page.evaluate(() => window.summarySeen.some((text) => text.includes("D skipped"))),
          false,
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
    test(`XSG03 animation gates ${width}/${theme}`, async () => {
      const { page, errors } = await openPage(options);
      try {
        for (const gate of ["enabled", "disabled", "reducedMotion"]) {
          await update(page, { key: `${gate}-B`, text: "B queued" });
          await textIs(page, "B queued");
          await update(page, { key: `${gate}-C`, text: "C latest" });
          if (gate === "reducedMotion") await page.emulateMedia({ reducedMotion: "reduce" });
          else await update(page, { [gate]: gate === "disabled" });
          await textIs(page, "C latest");
          assert.equal(await page.locator("[data-primary]").count(), 1);
          await page.evaluate(() => window.summaryFixture.burst());
          await textIs(page, "A token 200");
          if (gate === "reducedMotion") await page.emulateMedia({ reducedMotion: "no-preference" });
          else await update(page, { [gate]: gate === "enabled" });
          await textIs(page, "A token 200");
          assert.equal(await page.locator("[data-primary]").count(), 1);
        }
        await update(page, { key: "unmount-next", text: "Unmount next" });
        await textIs(page, "Unmount next");
        await update(page, { key: "unmount-pending", text: "Must not play" });
        await update(page, { mounted: false });
        await page.waitForFunction(() => !document.querySelector("[data-summary-fixture]"));
        await page.waitForTimeout(900); // 超过既有播放周期，确认卸载后没有迟到更新。
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
}

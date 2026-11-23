import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, preview } from "vite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/reasoning-render-performance.fixture.tsx";
const artifacts =
  process.env.ZCODE_E2E_ARTIFACT_DIR ||
  join(root, "packages/desktop/.e2e-artifacts/reasoning-render-performance");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(artifacts, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/reasoning-fixture.tsx"></script>',
  );
  // 用同一夹具加载指定基线的三个实现，比较生产 React，排除开发检查与热更新开销。
  const baseline = new Map();
  for (const path of process.env.ZCODE_REASONING_BASELINE_REF
    ? [
        "packages/ui/src/v4/conversationAssistantWorkItems.ts",
        "packages/ui/src/v4/ConversationTurnGroup.tsx",
        "packages/ui/src/components/ui/collapsible.tsx",
      ]
    : []) {
    const { stdout } = await promisify(execFile)(
      "git",
      ["show", `${process.env.ZCODE_REASONING_BASELINE_REF}:${path}`],
      { cwd: root },
    );
    baseline.set(root + path, stdout);
  }
  await build({
    root: artifacts,
    configFile: false,
    base: "./",
    logLevel: "warn",
    plugins: [
      { name: "reasoning-baseline", enforce: "pre", load: (id) => baseline.get(id) ?? null },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: { "@": `${root}packages/ui/src`, "/reasoning-fixture.tsx": root + entry.slice(1) },
    },
    build: {
      outDir: join(artifacts, "out"),
      emptyOutDir: true,
      minify: false,
      chunkSizeWarningLimit: 10000,
    },
  });
  server = await preview({
    root: artifacts,
    configFile: false,
    build: { outDir: join(artifacts, "out") },
    preview: { host: "127.0.0.1", port: 0 },
  });
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
const metricNames = [
  "TaskDuration",
  "ScriptDuration",
  "LayoutDuration",
  "RecalcStyleDuration",
  "LayoutCount",
  "RecalcStyleCount",
];
const delta = (before, after) =>
  Object.fromEntries(metricNames.map((name) => [name, after[name] - before[name]]));
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const percentile = (values, ratio) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * ratio))
  ] ?? 0;
for (const mobile of [false, true])
  for (const theme of ["light", "dark"]) {
    test(`XSG04 streaming and folding ${mobile ? "mobile" : "desktop"}/${theme}`, async () => {
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const client = await page.context().newCDPSession(page);
      await client.send("Performance.enable");
      const metrics = async () =>
        Object.fromEntries(
          (await client.send("Performance.getMetrics")).metrics.map(({ name, value }) => [
            name,
            value,
          ]),
        );
      const evidence = {
        build: "production",
        baseline: process.env.ZCODE_REASONING_BASELINE_REF ?? null,
        streaming: [],
        folds: [],
        errors,
      };
      const settle = () =>
        page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll('[data-slot="collapsible-content"]')).some(
              (node) => node.getAnimations().some((animation) => animation.playState === "running"),
            ),
        );
      try {
        await page.goto(`${origin}?mobile=${mobile}&theme=${theme}`);
        const group = page.locator("[data-consecutive-summary-group]").first();
        const trigger = group.locator("[data-summary-group-trigger]");
        await trigger.waitFor();
        await page.evaluate(() => {
          window.__groupIdentity = document.querySelector("[data-consecutive-summary-group]");
        });
        // 热身后对同一批不可变历史行进行尾部更新，不以开发构建冷加载时间冒充交互开销。
        await page.evaluate(() => window.__reasoningPerf.step());
        await frames(page);
        if (process.env.ZCODE_REASONING_CPU_PROFILE) {
          await client.send("Profiler.enable");
          await client.send("Profiler.start");
        }
        for (let pass = 0; pass < 3; pass++) {
          const previous = await metrics();
          const times = await page.evaluate(async () => {
            const times = [];
            for (let index = 0; index < 40; index++) {
              window.__reasoningPerf.step();
              await new Promise((resolve) =>
                requestAnimationFrame((time) => {
                  times.push(time);
                  resolve();
                }),
              );
            }
            await new Promise((resolve) => requestAnimationFrame(resolve));
            return times.slice(1).map((time, index) => time - times[index]);
          });
          evidence.streaming.push({
            ...delta(previous, await metrics()),
            frameP95: percentile(times, 0.95),
            frameMax: Math.max(...times),
          });
        }
        if (process.env.ZCODE_REASONING_CPU_PROFILE) {
          const { profile } = await client.send("Profiler.stop");
          await writeFile(
            join(artifacts, `${mobile ? "mobile" : "desktop"}-${theme}.cpuprofile`),
            JSON.stringify(profile),
          );
        }
        assert.equal(await page.getByTestId("tick").innerText(), "121");
        assert.equal(
          await page.evaluate(
            () =>
              document.querySelector("[data-consecutive-summary-group]") === window.__groupIdentity,
          ),
          true,
        );
        await trigger.scrollIntoViewIfNeeded();
        for (let pass = 0; pass < 6; pass++) {
          const previous = await metrics();
          const start = performance.now();
          await trigger.click();
          await settle();
          await frames(page);
          evidence.folds.push({
            open: pass % 2 === 0,
            ...delta(previous, await metrics()),
            elapsedMs: performance.now() - start,
          });
          assert.equal(await trigger.getAttribute("aria-expanded"), String(pass % 2 === 0));
        }
        await trigger.click();
        await settle();
        const thought = group.locator('[data-testid="chat-reasoning-trigger"]').first();
        await thought.click();
        await settle();
        await group.getByText(/E2E_XSG04_THOUGHT_0/).waitFor();
        // 高度动画结束后，吸底滚动仍可能推进；截图等几何稳定，避免把中间帧误判为视觉变化。
        await page.waitForFunction(
          () => {
            const nodes = document.querySelectorAll(
              "[data-consecutive-summary-group], [data-summary-group-scroll], [data-reasoning-scroll-mask]",
            );
            const signature = JSON.stringify(
              Array.from(nodes, (node) => [
                node.getBoundingClientRect().top,
                node.getBoundingClientRect().height,
                node.scrollTop,
              ]),
            );
            const previous = window.__reasoningVisual;
            const stable = previous?.signature === signature ? previous.stable + 1 : 0;
            window.__reasoningVisual = { signature, stable };
            return stable >= 3;
          },
          undefined,
          { polling: "raf" },
        );
        await page.screenshot({
          path: join(artifacts, `${mobile ? "mobile" : "desktop"}-${theme}.png`),
          animations: "disabled",
        });
        // 动画中反向操作仍由原 Presence 管理，流式更新不能覆盖手动展开。
        await trigger.click();
        await frames(page);
        await trigger.click();
        await settle();
        await page.evaluate(() => window.__reasoningPerf.step());
        await frames(page);
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        assert.equal(
          await page.evaluate(
            () =>
              document.querySelector("[data-consecutive-summary-group]") === window.__groupIdentity,
          ),
          true,
        );
        // 同 rowId 的新事实必须失效；不能把缓存误做成按标识永久复用。
        await page.evaluate(() => window.__reasoningPerf.revise());
        await page.waitForFunction(() =>
          document.querySelector("[data-summary-group-statistics]")?.textContent?.includes("119"),
        );
        assert.deepEqual(errors, []);
        evidence.domNodes = await page.locator("*").count();
      } finally {
        await writeFile(
          join(artifacts, `${mobile ? "mobile" : "desktop"}-${theme}.json`),
          JSON.stringify(evidence, null, 2),
        );
        await page.close();
      }
    });
  }

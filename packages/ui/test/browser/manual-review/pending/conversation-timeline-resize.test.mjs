import { registerMarkdownTableMotionCases } from "./markdown-table-motion.cases.mjs";
// SRM10：真实 React timeline、消息组件和 TanStack virtualizer；会话数据由确定性 fixture 提供。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-timeline-resize.fixture.tsx";
const artifacts =
  process.env.ZCODE_E2E_ARTIFACT_DIR ||
  join(root, "packages/desktop/.e2e-artifacts/conversation-timeline-resize");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      {
        name: "timeline-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><link rel="icon" href="data:," /><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
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

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const terminal of ["stop", "complete", "fail"])
      for (const reading of [false, true])
        test(`SSV06 terminal identity ${mobile ? "mobile" : "desktop"}/${theme}/${terminal}/${reading ? "reading" : "following"}`, async () => {
          const page = await browser.newPage({
            viewport: { width: mobile ? 430 : 1250, height: 800 },
            isMobile: mobile,
            hasTouch: mobile,
          });
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          const prefix = `terminal-${mobile}-${theme}-${terminal}-${reading}`;
          let evidence;
          try {
            await page.goto(
              `${origin}fixture?mobile=${mobile}&theme=${theme}&terminal=${terminal}`,
            );
            await page.locator('[data-row-id="8"]').waitFor();
            await page.evaluate(async (detached) => {
              await Promise.all(
                document
                  .getAnimations()
                  .filter((a) => Number.isFinite(a.effect?.getComputedTiming().iterations))
                  .map((a) => a.finished.catch(() => {})),
              );
              const timeline = document.querySelector('[data-testid="v4-timeline"]');
              if (detached) {
                timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -200 }));
                // 阅读顶部历史；完成时过程区折叠后，该位置仍可表示，排除浏览器正常 clamp。
                timeline.scrollTop = 0;
                timeline.dispatchEvent(new Event("scroll"));
              }
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              const ids = [3, 5, 6, 7];
              const nodes = ids.map((id) => document.querySelector(`[data-row-id="${id}"]`));
              if (nodes.some((node) => !node)) throw new Error("SSV06 初始消息缺失");
              const turn = nodes[1].closest("[data-v4-turn-unit]");
              const probe = { ids, nodes, turn, timeline, animations: [], samples: [] };
              probe.listener = (event) => {
                if (
                  event.target instanceof Element &&
                  probe.ids.some((id) =>
                    event.target.contains(document.querySelector(`[data-row-id="${id}"]`)),
                  )
                )
                  probe.animations.push(event.animationName);
              };
              document.addEventListener("animationstart", probe.listener);
              window.__stopIdentityProbe = probe;
            }, reading);
            await page.getByRole("button", { name: "Stop", exact: true }).click();
            evidence = await page.evaluate(async () => {
              const probe = window.__stopIdentityProbe;
              for (let frame = 0; frame < 24; frame++) {
                await new Promise(requestAnimationFrame);
                const nodes = probe.ids.map((id) =>
                  document.querySelector(`[data-row-id="${id}"]`),
                );
                probe.samples.push({
                  sameTimeline:
                    document.querySelector('[data-testid="v4-timeline"]') === probe.timeline,
                  sameTurn:
                    document.querySelector('[data-v4-turn-unit][data-turn-id="terminal-turn"]') ===
                    probe.turn,
                  sameRows: nodes.map((node, index) => node === probe.nodes[index]),
                  opacity: nodes.map((node) => {
                    let opacity = 1;
                    for (let element = node; element; element = element.parentElement)
                      opacity *= Number(getComputedStyle(element).opacity);
                    return node ? opacity : 0;
                  }),
                  following: probe.timeline.dataset.following,
                  bottomGap:
                    probe.timeline.scrollHeight -
                    probe.timeline.clientHeight -
                    probe.timeline.scrollTop,
                });
              }
              document.removeEventListener("animationstart", probe.listener);
              return { animations: probe.animations, samples: probe.samples };
            });
            for (const sample of evidence.samples) {
              assert.equal(sample.sameTimeline, true);
              assert.equal(sample.sameTurn, true, `终态重挂整轮：${JSON.stringify(sample)}`);
              assert.equal(sample.sameRows[0], true, "旧轮消息被重挂");
              assert.equal(sample.following, String(!reading), "终态改变滚动归属");
              if (terminal !== "complete") {
                assert.ok(sample.sameRows.every(Boolean), "停止/失败重挂已有过程内容");
                assert.ok(
                  sample.opacity.every((value) => value === 1),
                  "已有过程内容出现透明帧",
                );
              }
              if (!reading) assert.ok(Math.abs(sample.bottomGap) <= 1, JSON.stringify(sample));
            }
            assert.equal(evidence.animations.includes("enter"), false, "终态重播已有内容的淡入");
            await page.screenshot({ path: join(artifacts, `${prefix}.png`) });
            await page.getByRole("button", { name: "Next turn", exact: true }).click();
            await page.locator('[data-row-id="11"]').waitFor();
            assert.equal(await page.locator('[data-v4-live-tail="true"]').count(), 1);
            assert.equal(
              await page.locator('[data-v4-live-tail="true"]').getAttribute("data-turn-id"),
              "next-turn",
            );
            assert.equal(
              await page
                .locator(
                  '[data-v4-timeline-virtual-history] [data-v4-turn-unit][data-turn-id="terminal-turn"]',
                )
                .count(),
              1,
            );
            assert.equal(
              await page.locator('[data-row-id="5"]').count(),
              1,
              "下一轮交接丢失或重复旧输入",
            );
            await page.getByRole("button", { name: "Draft", exact: true }).click();
            assert.equal(await page.locator("[data-v4-turn-unit]").count(), 0, "空列表残留尾轮");
            assert.deepEqual(errors, []);
          } finally {
            await writeFile(
              join(artifacts, `${prefix}.json`),
              JSON.stringify({ evidence, errors }, null, 2),
            );
            await page.close();
          }
        });

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const mode of ["tail", "final", "cua", "stream"])
      test(`SSV05 group identity ${mobile ? "mobile" : "desktop"}/${theme}/${mode}`, async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1250, height: 800 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const samples = [];
        try {
          await page.goto(`${origin}fixture?mobile=${mobile}&theme=${theme}&identity=${mode}`);
          const rowId = mode === "stream" ? 60 : 241;
          await page.locator(`[data-row-id="${rowId}"]`).waitFor();
          await page.evaluate(async (id) => {
            const row = document.querySelector(`[data-row-id="${id}"]`);
            const content = row.closest('[data-slot="collapsible-content"]');
            await Promise.all(
              document
                .getAnimations()
                .filter((animation) =>
                  Number.isFinite(animation.effect?.getComputedTiming().iterations),
                )
                .map((animation) => animation.finished.catch(() => {})),
            );
            window.__identityProbe = { row, content, replacements: 0, animationRestarts: 0 };
            const probe = window.__identityProbe;
            let last = row;
            probe.observer = new MutationObserver(() => {
              const current = document.querySelector(`[data-row-id="${id}"]`);
              if (current !== last) probe.replacements += 1;
              last = current;
            });
            probe.observer.observe(document.querySelector('[data-testid="v4-timeline"]'), {
              childList: true,
              subtree: true,
            });
            document.addEventListener("animationstart", (event) => {
              const current = document.querySelector(`[data-row-id="${id}"]`);
              if (event.target instanceof Element && event.target.contains(current))
                probe.animationRestarts += 1;
            });
          }, rowId);
          for (const expected of [120, 180, 240, mode === "final" || mode === "cua" ? 242 : 241]) {
            await page.getByRole("button", { name: "Next page", exact: true }).click();
            await page.waitForFunction(
              (count) =>
                document.querySelector('[data-testid="v4-timeline"]').dataset.windowRowCount ===
                String(count),
              expected,
            );
            samples.push(
              await page.evaluate(async (id) => {
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                );
                const timeline = document.querySelector('[data-testid="v4-timeline"]');
                const row = document.querySelector(`[data-row-id="${id}"]`);
                const probe = window.__identityProbe;
                const content = row?.closest('[data-slot="collapsible-content"]');
                return {
                  rows: timeline.dataset.windowRowCount,
                  sameRow: row === probe.row,
                  sameContent: content === probe.content,
                  replacements: probe.replacements,
                  animationRestarts: probe.animationRestarts,
                  rowHeight: row?.getBoundingClientRect().height,
                  scrollTop: timeline.scrollTop,
                  opacity: content ? getComputedStyle(content.firstElementChild).opacity : null,
                };
              }, rowId),
            );
          }
          for (const sample of samples) {
            assert.equal(sample.sameRow, true, `已有消息被重挂：${JSON.stringify(sample)}`);
            assert.equal(sample.sameContent, true, `折叠内容被重挂：${JSON.stringify(sample)}`);
            assert.equal(sample.replacements, 0);
            assert.equal(sample.animationRestarts, 0, "补页或追加重播了已有内容的入场动画");
            if (sample.opacity !== null) assert.equal(sample.opacity, "1");
          }
          assert.deepEqual(errors, []);
        } finally {
          await writeFile(
            join(artifacts, `identity-${mobile}-${theme}-${mode}.json`),
            JSON.stringify(samples, null, 2),
          );
          await page.screenshot({
            path: join(artifacts, `identity-${mobile}-${theme}-${mode}.png`),
          });
          await page.close();
        }
      });

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const mode of ["mixed", "append"])
      test(`SSV05 CR-01 ${mobile ? "mobile" : "desktop"}/${theme}/${mode}`, async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1250, height: 800 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const samples = [];
        try {
          await page.goto(`${origin}fixture?mobile=${mobile}&theme=${theme}&boundary=${mode}`);
          await page.locator('[data-row-id="50"]').waitFor();
          if (mode === "mixed") {
            await page.locator("[data-summary-group-trigger]").first().click();
            await page.locator('[data-tool-call-id="boundary-tool-40"]').waitFor();
          }
          await page.evaluate(async (mixed) => {
            await Promise.all(
              document
                .getAnimations()
                .filter((a) => Number.isFinite(a.effect?.getComputedTiming().iterations))
                .map((a) => a.finished.catch(() => {})),
            );
            // 组头的代表图标也会渲染行外壳；只跟踪展开内容中的真实行，排除图标副本。
            const rows = (mixed ? [40, 50] : [50]).map((id) =>
              document.querySelector(`[data-row-id="${id}"]:not([data-summary-group-icon] *)`),
            );
            const contents = rows.map((row) => row.closest('[data-slot="collapsible-content"]'));
            window.__boundaryProbe = {
              rows,
              contents,
              groups: [...document.querySelectorAll("[data-consecutive-summary-group]")],
              animationRestarts: 0,
            };
            document.addEventListener("animationstart", (event) => {
              if (
                event.target instanceof Element &&
                (mixed ? [40, 50] : [50]).some((id) =>
                  event.target.contains(
                    document.querySelector(
                      `[data-row-id="${id}"]:not([data-summary-group-icon] *)`,
                    ),
                  ),
                )
              )
                window.__boundaryProbe.animationRestarts += 1;
            });
          }, mode === "mixed");
          for (const step of [1, 2]) {
            await page.getByRole("button", { name: "Next boundary", exact: true }).click();
            await page.waitForFunction(
              (value) =>
                document.querySelector('[data-testid="boundary-page"]').textContent ===
                String(value),
              step,
            );
            samples.push(
              await page.evaluate(
                async ({ mode, step }) => {
                  await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                  );
                  const probe = window.__boundaryProbe;
                  const ids = mode === "mixed" ? [40, 50] : [50];
                  const rows = ids.map((id) =>
                    document.querySelector(
                      `[data-row-id="${id}"]:not([data-summary-group-icon] *)`,
                    ),
                  );
                  const groups = [...document.querySelectorAll("[data-consecutive-summary-group]")];
                  const timeline = document.querySelector('[data-testid="v4-timeline"]');
                  return {
                    step,
                    sameRows: rows.map((row, index) => row === probe.rows[index]),
                    sameContents: rows.map(
                      (row, index) =>
                        row?.closest('[data-slot="collapsible-content"]') === probe.contents[index],
                    ),
                    animationRestarts: probe.animationRestarts,
                    heights: rows.map((row) => row?.getBoundingClientRect().height),
                    scrollTop: timeline.scrollTop,
                    sameGroups:
                      mode === "mixed"
                        ? probe.groups.map((group, index) => group === groups[index + 1])
                        : [],
                    groupIds: groups.map((group) =>
                      group
                        .querySelector("[data-summary-group-trigger]")
                        ?.getAttribute("aria-controls"),
                    ),
                    expanded: groups.map((group) =>
                      group
                        .querySelector('[role="button"][aria-expanded]')
                        ?.getAttribute("aria-expanded"),
                    ),
                    toolCounts: ids.map(
                      (id) =>
                        document.querySelectorAll(
                          `[data-row-id="${id}"]:not([data-summary-group-icon] *)`,
                        ).length,
                    ),
                  };
                },
                { mode, step },
              ),
            );
          }
          for (const sample of samples) {
            assert.ok(sample.sameRows.every(Boolean), `消息/分组重挂：${JSON.stringify(sample)}`);
            assert.ok(
              sample.sameContents.every(Boolean),
              `历史容器重挂：${JSON.stringify(sample)}`,
            );
            assert.equal(sample.animationRestarts, 0, JSON.stringify(sample));
            assert.ok(sample.sameGroups.every(Boolean), JSON.stringify(sample));
            assert.deepEqual(
              sample.toolCounts,
              mode === "mixed" ? [1, 1] : [1],
              "已有消息丢失或重复",
            );
            assert.equal(new Set(sample.groupIds).size, sample.groupIds.length, "CUA 展开身份重复");
            const count =
              mode === "mixed" ? (sample.step === 1 ? 3 : 4) : sample.step === 1 ? 1 : 3;
            assert.equal(sample.groupIds.length, count, "CUA 组丢失或重复");
            assert.deepEqual(
              sample.expanded,
              mode === "mixed"
                ? Array.from({ length: count }, (_, index) => (index === 1 ? "true" : "false"))
                : Array(count).fill("false"),
              "展开状态丢失或串组",
            );
          }
          assert.deepEqual(errors, [], "React 不得报告重复兄弟 key");
        } finally {
          await writeFile(
            join(artifacts, `boundary-${mobile}-${theme}-${mode}.json`),
            JSON.stringify({ samples, errors }, null, 2),
          );
          await page.screenshot({
            path: join(artifacts, `boundary-${mobile}-${theme}-${mode}.png`),
          });
          await page.close();
        }
      });

for (const width of [390, 1100, 1440])
  for (const theme of ["light", "dark"])
    test(`SP01 draft first frame ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      try {
        await page.goto(`${origin}fixture?draft=true&mobile=${width === 390}&theme=${theme}`);
        await page.getByTestId("fixture-composer").waitFor();
        const samples = await page.evaluate(async () => {
          const dock = document.querySelector("[data-v4-composer-dock-content]");
          const composer = document.querySelector('[data-testid="fixture-composer"]');
          const host = dock.parentElement;
          await Promise.all(dock.getAnimations().map((animation) => animation.finished));
          const frames = [];
          // 在 React 提交的 mutation 回调和后续绘制帧取坐标，不能等动画结束才断言。
          await new Promise((resolve) => {
            const capture = () => {
              const outer = host.getBoundingClientRect();
              const input = composer.getBoundingClientRect();
              frames.push({
                x: input.x,
                width: input.width,
                centerError: input.x + input.width / 2 - outer.x - outer.width / 2,
                animations: dock.getAnimations().map((animation) => animation.transitionProperty),
              });
              if (frames.length < 18) requestAnimationFrame(capture);
              else resolve();
            };
            const observer = new MutationObserver(() => {
              if (!composer.classList.contains("max-w-2xl")) return;
              observer.disconnect();
              capture();
            });
            observer.observe(composer, { attributes: true });
            [...document.querySelectorAll("button")]
              .find((button) => button.textContent === "Draft")
              .click();
          });
          return frames;
        });
        await writeFile(
          join(artifacts, `draft-${width}-${theme}.json`),
          JSON.stringify(samples, null, 2),
        );
        for (const sample of samples) {
          assert.ok(Math.abs(sample.centerError) <= 1, JSON.stringify(sample));
          assert.deepEqual(sample.animations, []);
          assert.ok(Math.abs(sample.x - samples[0].x) <= 1, JSON.stringify(samples));
        }
        await page.screenshot({ path: join(artifacts, `draft-${width}-${theme}.png`) });
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });

for (const mobile of [false, true])
  for (const theme of ["light", "dark"]) {
    test(`SRM10 ${mobile ? "mobile" : "desktop"}/${theme}`, async () => {
      const page = await browser.newPage({
        viewport: { width: mobile ? 430 : 1250, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const prefix = `${mobile ? "mobile" : "desktop"}-${theme}`;
      try {
        await page.addInitScript(() => {
          window.__timelineErrors = [];
          window.addEventListener(
            "error",
            (event) => window.__timelineErrors.push(event.message),
            true,
          );
        });
        await page.goto(
          `${origin}fixture?mobile=${mobile}&theme=${theme}&heavy=${process.env.ZCODE_RESIZE_HEAVY_TOOLS === "1"}`,
        );
        const timeline = page.getByTestId("v4-timeline");
        await timeline.waitFor();
        if (process.env.ZCODE_RESIZE_HEAVY_TOOLS === "1") {
          await page.getByRole("button", { name: "Tools", exact: true }).click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll('[data-testid^="tool-summary-trigger-resize-tool-"]')
                .length === 134,
          );
        }
        const state = () =>
          timeline.evaluate((e) => ({
            following: e.dataset.following,
            top: e.scrollTop,
            gap: e.scrollHeight - e.clientHeight - e.scrollTop,
          }));
        const settle = () =>
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        await settle();
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        const evidence = [];
        // 每个宽度点都检查布局提交后的实际几何，不只检查整个拖动结束后的落点。
        for (const width of mobile
          ? [420, 390, 360, 390, 430]
          : [1400, 1300, 1250, 1050, 900, 750, 900, 1100, 1250]) {
          await page.setViewportSize({ width, height: 800 });
          await settle();
          const metrics = await timeline.evaluate((e) => {
            const history = e.querySelector("[data-v4-timeline-virtual-history]");
            const last = history?.lastElementChild;
            return {
              following: e.dataset.following,
              gap: e.scrollHeight - e.clientHeight - e.scrollTop,
              stale: last
                ? last.getBoundingClientRect().bottom - history.getBoundingClientRect().bottom
                : 0,
            };
          });
          evidence.push({ width, ...metrics });
          assert.equal(metrics.following, "true");
          assert.ok(Math.abs(metrics.gap) <= 1, JSON.stringify(metrics));
          assert.ok(Math.abs(metrics.stale) <= 1, JSON.stringify(metrics));
        }
        // 外层视口不变，仅内容列继续 CSS 宽度过渡：不能停留在旧 stableWidth。
        await timeline.evaluate((e) => {
          const history = e.querySelector("[data-v4-timeline-virtual-history]");
          history.style.transition = "width 160ms linear";
          history.style.width = "75%";
        });
        for (let frame = 0; frame < 8; frame++) {
          await settle();
          const metrics = await state();
          assert.equal(metrics.following, "true");
          assert.ok(Math.abs(metrics.gap) <= 1, JSON.stringify(metrics));
        }
        await timeline.evaluate((e) => {
          const history = e.querySelector("[data-v4-timeline-virtual-history]");
          history.style.removeProperty("transition");
          history.style.removeProperty("width");
        });
        await settle();
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await settle();
        assert.ok(Math.abs((await state()).gap) <= 1);
        await timeline.evaluate((e) => {
          e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
          e.scrollTop -= 500;
          e.dispatchEvent(new Event("scroll"));
        });
        await settle();
        assert.equal((await state()).following, "false");
        for (const width of mobile ? [390, 430] : [1000, 1250]) {
          await page.setViewportSize({ width, height: 800 });
          await settle();
          assert.equal((await state()).following, "false");
        }
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "false");
        await timeline.evaluate((e) => {
          e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
          e.scrollTop = 0;
          e.dispatchEvent(new Event("scroll"));
        });
        await settle();
        const saved = await state();
        await page.getByRole("button", { name: "Switch", exact: true }).click();
        await settle();
        await page.getByRole("button", { name: "Switch", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "false");
        await page.waitForFunction(
          (top) =>
            Math.abs(document.querySelector('[data-testid="v4-timeline"]').scrollTop - top) <= 1,
          saved.top,
        );
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "true");
        assert.ok(Math.abs((await state()).gap) <= 1);
        await page.getByRole("button", { name: "Locate", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "false");
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "true");
        assert.ok(Math.abs((await state()).gap) <= 1);
        await page.screenshot({ path: join(artifacts, `${prefix}.png`) });
        await writeFile(join(artifacts, `${prefix}.json`), JSON.stringify(evidence, null, 2));
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.__timelineErrors), []);
      } catch (error) {
        console.error(error);
        throw error;
      } finally {
        await page.close();
      }
    });
  }

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const reading of [false, true])
      test(`SSV03 hydrate ${mobile ? "mobile" : "desktop"}/${theme}/${reading ? "reading" : "following"}`, async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1250, height: 800 },
        });
        const samples = [];
        try {
          await page.goto(`${origin}fixture?mobile=${mobile}&theme=${theme}&hydrate=true`);
          await page.getByTestId("v4-timeline").waitFor();
          await page.waitForFunction(
            () => document.querySelectorAll("[data-v4-turn-unit]").length >= 2,
          );
          if (reading) {
            await page.getByTestId("v4-timeline").evaluate((e) => {
              e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
              e.scrollTop -= 100;
              e.dispatchEvent(new Event("scroll"));
            });
            await page.waitForFunction(
              () =>
                document.querySelector('[data-testid="v4-timeline"]').dataset.following === "false",
            );
          }
          const anchor = page.locator('[data-v4-turn-unit][data-turn-id="turn-1"]');
          const beforeTop = reading
            ? await anchor.evaluate((e) => e.getBoundingClientRect().top)
            : null;
          await page.evaluate(() => {
            window.__hydrationFrames = [];
            window.__hydrationStop = false;
            const sample = () => {
              if (window.__hydrationStop) return;
              const units = [...document.querySelectorAll("[data-v4-turn-unit]")];
              const pairs = units.slice(1).map((node, index) => ({
                from: units[index].dataset.turnId,
                to: node.dataset.turnId,
                overlap:
                  units[index].getBoundingClientRect().bottom - node.getBoundingClientRect().top,
              }));
              window.__hydrationFrames.push({
                count: document.querySelector('[data-testid="v4-timeline"]').dataset.windowRowCount,
                top: document.querySelector('[data-testid="v4-timeline"]').scrollTop,
                gap: (() => {
                  const e = document.querySelector('[data-testid="v4-timeline"]');
                  return e.scrollHeight - e.clientHeight - e.scrollTop;
                })(),
                following: document.querySelector('[data-testid="v4-timeline"]').dataset.following,
                anchorTop: document
                  .querySelector('[data-v4-turn-unit][data-turn-id="turn-1"]')
                  ?.getBoundingClientRect().top,
                pairs,
              });
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          await page.getByRole("button", { name: "Hydrate", exact: true }).click();
          await page.waitForFunction(
            () => window.__hydrationFrames.filter((f) => f.count === "140").length >= 8,
          );
          samples.push(
            ...(await page.evaluate(() => {
              window.__hydrationStop = true;
              return window.__hydrationFrames;
            })),
          );
          assert.ok(
            samples.some((frame) => frame.count === "60"),
            "缺少局部历史前置帧",
          );
          assert.ok(
            samples.some((frame) => frame.count === "140"),
            "没有补齐历史",
          );
          const overlapping = samples.filter((frame) =>
            frame.pairs.some((pair) => pair.overlap > 1),
          );
          assert.deepEqual(overlapping, [], "补齐历史出现重叠帧");
          assert.equal(
            await page.getByTestId("v4-timeline").getAttribute("data-following"),
            reading ? "false" : "true",
          );
          if (reading)
            assert.ok(
              Math.abs((await anchor.evaluate((e) => e.getBoundingClientRect().top)) - beforeTop) <=
                1,
              "历史补齐改变阅读锚点",
            );
        } finally {
          await writeFile(
            join(artifacts, `hydrate-${mobile}-${theme}-${reading}.json`),
            JSON.stringify(samples, null, 2),
          );
          await page.screenshot({
            path: join(artifacts, `hydrate-${mobile}-${theme}-${reading}.png`),
          });
          await page.close();
        }
      });

registerMarkdownTableMotionCases(() => ({ browser, origin, artifacts }));

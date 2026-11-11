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
const entry =
  "/packages/ui/test/browser/manual-review/pending/project-device-visibility.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/project-hover-lifecycle");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "project-device-visibility-fixture",
        enforce: "pre",
        load(id) {
          if (id.endsWith("/project-sidebar/ProjectDirectoryProvider.tsx"))
            return "export const useProjectDirectory=()=>window.__projectDeviceDirectory; export const useOptionalProjectDirectory=useProjectDirectory; export const useProjectSelectionDirectory=()=>({...window.__projectDeviceDirectory, allProjects:window.__projectDeviceDirectory.projects}); export const useOptionalProjectSelectionDirectory=useProjectSelectionDirectory;";
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture")) return next();
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

const cards = '[data-testid="project-identity-details"], [data-testid="remote-identity-details"]';
async function nextFrameCards(page) {
  return page.evaluate(
    (selector) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          resolve(
            [...document.querySelectorAll(selector)].map((e) => ({
              text: e.textContent,
              state: e.dataset.state,
            })),
          );
        }),
      ),
    cards,
  );
}

for (const local of [true, false])
  for (const width of [390, 1200])
    for (const theme of ["light", "dark"])
      test(
        `VP20 hover lifecycle ${local ? "local" : "remote"}/${width}/${theme}`,
        { timeout: 60000 },
        async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          page.setDefaultTimeout(10000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const report = [];
          try {
            await page.goto(
              `${origin}fixture?${new URLSearchParams({ local: local ? "1" : "0", theme, locale: theme === "light" ? "zh-CN" : "en-US", mobile: width === 390 ? "1" : "0" })}`,
            );
            await page.getByTestId("composer-workspace-trigger").waitFor();
            await page.evaluate((selector) => {
              window.hoverTrace = [];
              for (const name of ["pointerover", "pointerout", "focusin", "focusout"]) {
                document.addEventListener(
                  name,
                  (event) => {
                    const item = event.target.closest?.("[data-project-id]");
                    if (item)
                      window.hoverTrace.push({
                        event: name,
                        id: item.dataset.projectId,
                        time: performance.now(),
                      });
                  },
                  true,
                );
              }
              new MutationObserver(() =>
                window.hoverTrace.push({
                  event: "cards",
                  count: document.querySelectorAll(selector).length,
                  time: performance.now(),
                }),
              ).observe(document.body, { subtree: true, childList: true });
            }, cards);
            for (const entry of ["sidebar", "composer"]) {
              if (entry === "composer")
                await page.getByTestId("composer-workspace-trigger").click();
              const rows =
                entry === "sidebar"
                  ? page.getByTestId("virtual-project-row")
                  : page.locator('[role="menuitemcheckbox"]').locator("..");
              await rows.first().waitFor();
              // 直接使用指针坐标扫行，避免 hover 的稳定性等待掩盖短停留竞态。
              for (let i = 0; i < (await rows.count()); i++) {
                const box = await rows.nth(i).boundingBox();
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.waitForTimeout(60);
              }
              await page.mouse.move(width - 2, 898);
              assert.deepEqual(await nextFrameCards(page), [], `${entry}: immediate sweep close`);
              await page.waitForTimeout(450);
              assert.equal(
                await page.locator(cards).count(),
                0,
                `${entry}: stale open after leave`,
              );
              await rows.first().hover();
              const details = page.locator(cards);
              await details.waitFor();
              await details.evaluate(async (element) => {
                await Promise.all(element.getAnimations().map((a) => a.finished));
              });
              const rowBox = await rows.first().boundingBox();
              const box = await details.boundingBox();
              const right = box.x >= rowBox.x + rowBox.width;
              const gapX = right ? box.x - 2 : box.x + box.width + 2;
              const y = Math.max(box.y, rowBox.y) + Math.min(12, rowBox.height / 2);
              await page.mouse.move(gapX, y);
              // 停在 4px 间隙超过旧关闭延时，证明连续命中而非定时兜底。
              await page.waitForTimeout(150);
              assert.equal(await details.count(), 1, `${entry}: gap stays reachable`);
              await page.mouse.move(right ? box.x + 12 : box.x + box.width - 12, y);
              await details.locator("dd").last().dblclick();
              assert.ok(
                await page.evaluate(() => Boolean(getSelection()?.toString())),
                `${entry}: selectable text`,
              );
              await page.screenshot({
                path: join(artifacts, `${local}-${width}-${theme}-${entry}.png`),
              });
              await page.mouse.move(width - 2, 898);
              assert.deepEqual(
                await nextFrameCards(page),
                [],
                `${entry}: selection does not retain details`,
              );
              await page.waitForTimeout(350);
              assert.equal(await details.count(), 0);
              report.push({ entry, sweep: true, gap: true, selection: true, immediateClose: true });
              if (entry === "composer") await page.keyboard.press("Escape");
            }
            await page.getByTestId("composer-project-menu").waitFor({ state: "hidden" });
            // 菜单退出的焦点恢复完成后，再开始键盘路径，避免自动恢复抢回焦点。
            await page.getByTestId("composer-workspace-trigger").evaluate(
              (element) =>
                new Promise((resolve) => {
                  if (document.activeElement === element) return resolve();
                  element.addEventListener("focus", () => resolve(), { once: true });
                }),
            );
            const firstRow = page.getByTestId("virtual-project-row").first();
            await firstRow.focus();
            await page.locator(cards).waitFor();
            await page.keyboard.press("Escape");
            assert.deepEqual(await nextFrameCards(page), []);
            await page.getByTestId("composer-workspace-trigger").focus();
            await firstRow.focus();
            await page.locator(cards).waitFor();
            await page.getByTestId("composer-workspace-trigger").focus();
            assert.deepEqual(await nextFrameCards(page), []);
            assert.deepEqual(errors, []);
            await writeFile(
              join(artifacts, `${local}-${width}-${theme}.json`),
              JSON.stringify(
                { report, trace: await page.evaluate(() => window.hoverTrace) },
                null,
                2,
              ),
            );
          } catch (error) {
            console.error(error);
            await writeFile(
              join(artifacts, `failure-${local}-${width}-${theme}.json`),
              JSON.stringify(
                { report, trace: await page.evaluate(() => window.hoverTrace) },
                null,
                2,
              ),
            );
            throw error;
          } finally {
            await page.close();
          }
        },
      );

test("VP20 touch keeps project actions without hover details", { timeout: 30000 }, async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}fixture?local=1&mobile=1`);
    const toggle = page.getByTestId("virtual-project-toggle").first();
    await toggle.tap();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await page.waitForTimeout(400);
    assert.equal(await page.locator(cards).count(), 0);
    await page.getByTestId("composer-workspace-trigger").tap();
    await page.locator('[role="menuitemcheckbox"]').first().tap();
    await page.getByTestId("composer-project-menu").waitFor({ state: "hidden" });
    await page.waitForTimeout(400);
    assert.equal(await page.locator(cards).count(), 0);
  } finally {
    await context.close();
  }
});
